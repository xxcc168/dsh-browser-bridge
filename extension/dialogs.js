// Observe native dialogs through declared debugger permission and a manual opt-in, never alert overrides.
const nativeDialogStates=new Map(),nativeDialogObservers=new Map();
let nativeDialogStoreTail=Promise.resolve(),nativeDialogListeners=false;
const nativeDialogReady=chrome.storage.session.get({dshNativeDialogs:[]}).then(saved=>{
  for(const entry of saved.dshNativeDialogs)
    nativeDialogStates.set(entry.tabId,{observation:"unavailable",reason:"worker_restarted",known:false,blocked:!!(entry.blocked || entry.active),active:entry.active || null});
});
function nativeDialogSnapshot(tabId) {
  const state=nativeDialogStates.get(tabId) || {observation:"disabled",reason:"enable_in_extension_popup",known:false,blocked:false,active:null};
  return {...state,active:state.active?{...state.active}:null};
}
function nativeDialogList() {
  return [...nativeDialogStates].map(([tabId])=>({tabId,...nativeDialogSnapshot(tabId)}));
}
function persistNativeDialogs() {
  const snapshot=nativeDialogList();
  nativeDialogStoreTail=nativeDialogStoreTail.then(()=>chrome.storage.session.set({dshNativeDialogs:snapshot})).catch(()=>{});
  return nativeDialogStoreTail;
}
function publishNativeDialog(tabId) {
  void persistNativeDialogs();
  send(ws,{type:"nativeDialog",tabId,dialog:nativeDialogSnapshot(tabId)});
}
function setNativeDialogUnavailable(tabId,reason) {
  const previous=nativeDialogSnapshot(tabId);
  nativeDialogStates.set(tabId,{observation:"unavailable",reason,known:false,blocked:previous.blocked || !!previous.active,active:previous.active});
  publishNativeDialog(tabId);
}
function installNativeDialogListeners() {
  if(nativeDialogListeners)return;
  nativeDialogListeners=true;
  chrome.debugger.onEvent.addListener((source,method,params)=>{
    const tabId=source.tabId;
    // Only extension-attached targets are authoritative; page messages cannot spoof them.
    if(!Number.isInteger(tabId) || !nativeDialogObservers.has(tabId) || source.sessionId)return;
    if(method==="Page.javascriptDialogOpening") {
      const message=String(params.message ?? "");
      nativeDialogStates.set(tabId,{observation:"monitoring",reason:null,known:true,blocked:true,active:{
        id:crypto.randomUUID(),type:params.type,message:message.slice(0,2000),messageTruncated:message.length>2000,
        blank:message.trim().length===0,url:String(params.url || "").slice(0,2048),
        defaultPrompt:String(params.defaultPrompt || "").slice(0,2000),openedAt:Date.now(),hasBrowserHandler:!!params.hasBrowserHandler,
      }});
      publishNativeDialog(tabId);
      // Badge/title updates do not depend on the paused page's DOM.
      void updateControlUI(tabId);
    } else if(method==="Page.javascriptDialogClosed") {
      nativeDialogStates.set(tabId,{observation:"monitoring",reason:null,known:true,blocked:false,active:null});
      publishNativeDialog(tabId);
      // Closing a dialog is not proof that the suspended injected command has ended.
      void updateControlUI(tabId);
      if(!tabControls.has(tabId) && ![...runningControls.values()].some(operation=>operation.tabId===tabId))
        void releaseNativeDialogObserver(tabId);
    }
  });
  chrome.debugger.onDetach.addListener(source=>{
    if(!nativeDialogObservers.has(source.tabId))return;
    nativeDialogObservers.delete(source.tabId);
    setNativeDialogUnavailable(source.tabId,"debugger_detached");
  });
}
async function ensureNativeDialogObserver(tabId) {
  await nativeDialogReady;
  const config=await chrome.storage.local.get({dialogObservationEnabled:false});
  if(!config.dialogObservationEnabled) {
    if(!nativeDialogObservers.has(tabId))nativeDialogStates.set(tabId,{observation:"disabled",reason:"enable_in_extension_popup",known:false,blocked:false,active:null});
    return;
  }
  if(!await chrome.permissions.contains({permissions:["debugger"]}) || !chrome.debugger) {
    setNativeDialogUnavailable(tabId,"debugger_permission_required");return;
  }
  if(nativeDialogObservers.has(tabId))return nativeDialogObservers.get(tabId).ready;
  installNativeDialogListeners();
  const observer={attached:false,ready:null};nativeDialogObservers.set(tabId,observer);
  observer.ready=(async()=>{
    try {
      await chrome.debugger.attach({tabId},"1.3");observer.attached=true;
      // Page.enable subscribes to future events; it does not prove no modal predates attachment.
      const previous=nativeDialogSnapshot(tabId);
      nativeDialogStates.set(tabId,{observation:"monitoring",reason:"checking_page",known:false,blocked:previous.blocked,active:previous.active});
      await chrome.debugger.sendCommand({tabId},"Page.enable");
      if(!nativeDialogSnapshot(tabId).active)await probeNativeDialogReadiness(tabId,observer);
      if(nativeDialogObservers.get(tabId)===observer)publishNativeDialog(tabId);
    } catch(error) {
      if(nativeDialogObservers.get(tabId)!==observer)return;
      nativeDialogObservers.delete(tabId);
      setNativeDialogUnavailable(tabId,"debugger_attach_failed");
      if(observer.attached)await chrome.debugger.detach({tabId}).catch(()=>{});
    }
  })();
  return observer.ready;
}
async function releaseNativeDialogObserver(tabId) {
  // Keep observing an open modal until the user explicitly closes it; never auto-dismiss.
  if(nativeDialogSnapshot(tabId).active || nativeDialogSnapshot(tabId).blocked)return;
  const observer=nativeDialogObservers.get(tabId);if(!observer)return;
  await observer.ready;
  if(nativeDialogObservers.get(tabId)!==observer || nativeDialogSnapshot(tabId).active || nativeDialogSnapshot(tabId).blocked || tabControls.has(tabId))return;
  nativeDialogObservers.delete(tabId);
  setNativeDialogUnavailable(tabId,"control_released");
  if(observer.attached)await chrome.debugger.detach({tabId}).catch(()=>{});
}
async function restoreNativeDialogObservers() {
  await Promise.all([controlReady,nativeDialogReady]);
  for(const tabId of new Set([...tabControls.keys(),...nativeDialogStates.keys()])) {
    if(tabControls.has(tabId) || nativeDialogSnapshot(tabId).active || nativeDialogSnapshot(tabId).blocked)await ensureNativeDialogObserver(tabId);
  }
}
async function probeNativeDialogReadiness(tabId,observer) {
  // A harmless isolated-world probe detects a modal opened before our event subscription.
  // Timeout is only a suspected blocker, not a fabricated native alert/type/message.
  let timer;
  const probe=chrome.scripting.executeScript({target:{tabId,frameIds:[0]},func:()=>true})
    .then(results=>results[0]?.result===true?"ready":"unavailable",()=>"unavailable");
  const outcome=await Promise.race([probe,new Promise(resolve=>{timer=setTimeout(()=>resolve("blocked"),1000);})]);
  clearTimeout(timer);
  const apply=result=>{
    if(nativeDialogObservers.get(tabId)!==observer || nativeDialogSnapshot(tabId).active)return;
    const current=nativeDialogSnapshot(tabId);
    if(current.known && current.reason!=="checking_page")return;
    nativeDialogStates.set(tabId,{observation:"monitoring",reason:result==="ready"?null:result==="blocked"?"page_script_unresponsive":"page_probe_unavailable",
      known:result==="ready",blocked:result==="blocked",active:null});publishNativeDialog(tabId);
    if(result==="ready" && !tabControls.has(tabId))void releaseNativeDialogObserver(tabId);
  };
  apply(outcome);
  // Late probe completion may clear suspicion, but cannot drain or replay a business operation.
  if(outcome==="blocked")void probe.then(apply);
}
function assertNativeDialogClear(tabId) {
  const state=nativeDialogSnapshot(tabId),dialog=state.active;
  if(dialog && !state.known)throw new Error("DIALOG_UNOBSERVED: 原生弹窗观测已中断，请用户核验；勿把旧页面结果视为本次成功");
  if(!dialog && state.blocked)throw new Error("PAGE_SCRIPT_BLOCKED: 页面脚本探测未响应，可能有观测前已打开的原生弹窗；请用户核验，勿重放请求");
  if(dialog)throw new Error("NATIVE_DIALOG_OPEN: "+dialog.type+(dialog.blank?"（空正文）":"")+"; dialogId="+dialog.id+"; 请显式处理弹窗，勿把旧页面结果视为本次成功");
}
async function handleNativeDialog(command,manual=false) {
  await nativeDialogReady;
  // Agent recovery still needs its active lease; only trusted extension UI may recover after stop.
  if(!manual)ownsCommand({command,owner:command.owner,leaseId:command.leaseId});
  const state=nativeDialogSnapshot(command.tabId),dialog=state.active;
  if(!dialog || dialog.id!==command.dialogId)throw new Error("STALE_DIALOG: 弹窗已关闭或已被新的弹窗替换");
  if(!state.known || !nativeDialogObservers.get(command.tabId)?.attached)throw new Error("DIALOG_UNOBSERVED: 调试连接不可用，请由用户处理原生弹窗");
  if(typeof command.accept!=="boolean" || (command.promptText!==undefined && (dialog.type!=="prompt" || typeof command.promptText!=="string" || command.promptText.length>2000)))
    throw new Error("INVALID_ARGUMENT: accept 必须是布尔值；promptText 仅用于 prompt 且不超过 2000 字符");
  const params={accept:command.accept,...(command.promptText!==undefined?{promptText:command.promptText}:{})};
  await chrome.debugger.sendCommand({tabId:command.tabId},"Page.handleJavaScriptDialog",params);
  // Never erase a replacement dialog that opened during a confirm/prompt callback.
  if(nativeDialogSnapshot(command.tabId).active?.id===dialog.id) {
    nativeDialogStates.set(command.tabId,{observation:"monitoring",reason:null,known:true,blocked:false,active:null});publishNativeDialog(command.tabId);
  }
  return {handled:true,dialogId:dialog.id,type:dialog.type,accept:command.accept};
}
function forgetNativeDialogs(tabId) {
  nativeDialogObservers.delete(tabId);nativeDialogStates.delete(tabId);void persistNativeDialogs();
}
