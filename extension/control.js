// Extension-owned control state. Never accept a stop/allow request from page JS.
const tabControls=new Map(),runningControls=new Map(),blockedOwners=new Map();
const tabGenerations=new Map();
function tabGeneration(tabId) {
  if(!tabGenerations.has(tabId))tabGenerations.set(tabId,crypto.randomUUID());
  return tabGenerations.get(tabId);
}
function sessionSnapshot(tab,owner) {
  const l=tabControls.get(tab.id);
  return {tab:{id:tab.id,url:tab.url || "",title:tab.title || "",status:tab.status || "",generation:tabGeneration(tab.id)},
    control:l?{id:l.id,owner:l.owner,agentName:l.agentName,state:l.state,expiresAt:l.expiresAt}:null,
    blocked:!!blockedOwners.get(tab.id)?.has(owner),
    running:[...runningControls.values()].filter(r=>r.tabId===tab.id).length};
}
let controlInstance=null,controlStoreTail=Promise.resolve();
const controlReady=chrome.storage.session.get({dshControls:[],dshBlocked:[],dshRunning:[]}).then(saved=>{
  for(const l of saved.dshControls){l.state="stopping";l.reason="worker_restarted";tabControls.set(l.tabId,l);}
  for(const item of saved.dshBlocked)blockedOwners.set(item.tabId,new Set(item.owners));
  // A lost worker cannot prove injected async JS stopped. Retain unresolved work.
  for(const r of saved.dshRunning)runningControls.set(r.id,{...r,orphaned:true});
});
function persistControls() {
  const snapshot={dshControls:[...tabControls.values()],dshBlocked:[...blockedOwners].map(([tabId,owners])=>({tabId,owners:[...owners]})),
    dshRunning:[...runningControls.values()].map(r=>({id:r.id,tabId:r.tabId,leaseId:r.leaseId,documentId:r.documentId,frameId:r.frameId}))};
  controlStoreTail=controlStoreTail.then(()=>chrome.storage.session.set(snapshot)).catch(()=>{});
  return controlStoreTail;
}
function controlSnapshot() {
  return {controls:[...tabControls.values()].map(l=>({...l,sessionId:l.id,agentName:l.agentName})),
    blocked:[...blockedOwners].map(([tabId,owners])=>({tabId,owners:[...owners]}))};
}
function ownsCommand(msg) {
  const tabId=msg.command?.tabId;
  if(tabId===undefined || ["listTabs","getActive","ping"].includes(msg.command?.action))return;
  const l=tabControls.get(tabId);
  if(!l || l.id!==msg.leaseId || l.owner!==msg.owner || l.state!=="active" || l.expiresAt<=Date.now())
    throw new Error("CONTROL_REVOKED: 当前任务没有有效页面控制权");
}
async function updateControlUI(tabId) {
  const l=tabControls.get(tabId);
  const paused=blockedOwners.has(tabId);
  const state=l?.state || (paused?"paused":"free");
  const badge=state==="active"?"AI":state==="stopping"?"…":paused?"停":"";
  await chrome.action.setBadgeText({tabId,text:badge}).catch(()=>{});
  await chrome.action.setBadgeBackgroundColor({tabId,color:state==="active"?"#166534":"#b45309"}).catch(()=>{});
  await chrome.action.setTitle({tabId,title:l?l.agentName+" · "+(state==="active"?"正在控制":"正在停止"):"DSH Browser Bridge"}).catch(()=>{});
  const info={leaseId:l?.id || "",state,agentName:l?.agentName || "",expiresAt:l?.expiresAt || 0,connected:ws?.readyState===WebSocket.OPEN};
  // The isolated-world guard reaches all injectable frames. The banner is top-frame only.
  await chrome.scripting.executeScript({target:{tabId,allFrames:true},func:renderControl,args:[info]}).catch(()=>{});
}
function renderControl(info) {
  globalThis.__dshControlV3=info;
  if(window!==window.top)return;
  const key="__dshControlBannerV3";
  let ui=globalThis[key];
  if(info.state==="free"){ui?.host.remove();return;}
  if(!ui) {
    const host=document.createElement("div");
    host.setAttribute("data-dsh-control-ui","");
    host.style.cssText="all:initial!important;position:fixed!important;top:12px!important;right:12px!important;z-index:2147483647!important;pointer-events:auto!important";
    const shadow=host.attachShadow({mode:"closed"});
    const style=document.createElement("style");
    style.textContent=":host{color-scheme:light} .bar{font:13px/1.5 system-ui,'Microsoft YaHei',sans-serif;background:#16342b;color:white;padding:10px 12px;border-radius:10px;box-shadow:0 3px 14px #0003;display:flex;gap:12px;align-items:center;max-width:min(430px,85vw)}button{font:inherit;border:1px solid #fff8;background:#ffffff15;color:white;border-radius:6px;padding:4px 8px;cursor:pointer}button:focus-visible{outline:2px solid white}.label{overflow-wrap:anywhere}";
    const bar=document.createElement("div");bar.className="bar";bar.setAttribute("role","status");
    const label=document.createElement("span");label.className="label";
    const button=document.createElement("button");button.type="button";
    button.onclick=event=>{
      if(!event.isTrusted)return;
      button.disabled=true;
      const current=globalThis.__dshControlV3;
      chrome.runtime.sendMessage({type:current.state==="paused"?"dsb-allow-control":"dsb-stop-control",leaseId:current.leaseId})
        .catch(()=>{button.disabled=false;});
    };
    bar.append(label,button);shadow.append(style,bar);ui={host,label,button};globalThis[key]=ui;
  }
  if(!ui.host.isConnected)document.documentElement.append(ui.host);
  ui.label.textContent=info.state==="paused"?"已停止旧任务控制":info.state==="stopping"?"正在停止，等待旧操作结束":
    !info.connected?"连接中断，控制已暂停":info.agentName+" 正在控制此页面";
  ui.button.textContent=info.state==="paused"?"允许旧任务重新申请":"停止控制";
  ui.button.disabled=info.state==="stopping";
}
async function finishControl(tabId,leaseId) {
  const l=tabControls.get(tabId);
  if(!l || l.id!==leaseId || l.state!=="stopping")return false;
  if([...runningControls.values()].some(r=>r.tabId===tabId && r.leaseId===leaseId))return false;
  tabControls.delete(tabId);
  await persistControls();await updateControlUI(tabId);
  send(ws,{type:"controlDrained",tabId,leaseId});
  return true;
}
async function revokeLocal(tabId,reason="user_stopped",manual=false) {
  const l=tabControls.get(tabId);if(!l)return;
  if(manual) {
    const blocked=blockedOwners.get(tabId) || new Set();blocked.add(l.owner);blockedOwners.set(tabId,blocked);
    send(ws,{type:"userStop",tabId,leaseId:l.id});
  }
  l.state="stopping";l.reason=reason;
  await persistControls();await updateControlUI(tabId);
  await finishControl(tabId,l.id);
}
async function handleControl(sock,msg) {
  await controlReady;
  const incoming=msg.lease,tabId=incoming?.tabId;
  if(!Number.isInteger(tabId))return send(sock,{type:"controlAck",id:msg.id,ok:false,error:"INVALID_TAB"});
  try {
    let tab;
    try {tab=await chrome.tabs.get(tabId);}catch(error) {
      if(msg.action==="inspect")return send(sock,{type:"controlAck",id:msg.id,ok:true,snapshot:{tab:null,control:null,blocked:false,running:0}});
      if(msg.action!=="revoke")throw error;
      tabControls.delete(tabId);
      for(const [id,r] of runningControls)if(r.tabId===tabId)runningControls.delete(id);
      await persistControls();
      return send(sock,{type:"controlAck",id:msg.id,ok:true,drained:true});
    }
    if(msg.action==="inspect")return send(sock,{type:"controlAck",id:msg.id,ok:true,snapshot:sessionSnapshot(tab,incoming.owner)});
    const existing=tabControls.get(tabId);
    if(msg.action==="revoke") {
      if(existing?.id===incoming.id)await revokeLocal(tabId,incoming.reason || "revoked");
      const drained=![...runningControls.values()].some(r=>r.tabId===tabId && r.leaseId===incoming.id);
      return send(sock,{type:"controlAck",id:msg.id,ok:true,drained});
    }
    if(!["grant","renew"].includes(msg.action))throw new Error("INVALID_CONTROL_ACTION");
    if(blockedOwners.get(tabId)?.has(incoming.owner))throw new Error("CONTROL_STOPPED: 用户已终止该任务");
    if(msg.action==="renew" && (!existing || existing.id!==incoming.id || existing.owner!==incoming.owner || existing.expiresAt<=Date.now()))
      throw new Error("CONTROL_REVOKED: 扩展租约已失效，需要重新申请");
    if(existing && (existing.id!==incoming.id || existing.state==="stopping"))throw new Error("TAB_OCCUPIED: 旧任务尚未结束");
    if([...runningControls.values()].some(r=>r.tabId===tabId && r.leaseId!==incoming.id))throw new Error("CONTROL_STOPPING");
    controlInstance=msg.instanceId;
    const installed={...incoming,state:"active"};
    tabControls.set(tabId,installed);
    await persistControls();await updateControlUI(tabId);
    if(tabControls.get(tabId)!==installed || installed.state!=="active" || blockedOwners.get(tabId)?.has(incoming.owner))
      throw new Error("CONTROL_REVOKED: 同步期间控制权已变化");
    send(sock,{type:"controlAck",id:msg.id,ok:true,drained:false,snapshot:sessionSnapshot(tab,incoming.owner)});
  } catch(error) {send(sock,{type:"controlAck",id:msg.id,ok:false,error:error.message});}
}
async function controlTick() {
  await controlReady;
  for(const l of tabControls.values()) {
    if(l.state==="active" && Date.now()>=l.expiresAt)await revokeLocal(l.tabId,"lease_expired");
  }
}
async function documentChanged(tabId) {
  try {
    const current=await chrome.scripting.executeScript({target:{tabId,allFrames:true},func:()=>true});
    const ids=new Set(current.map(r=>r.documentId));
    for(const [id,r] of runningControls)
      if(r.tabId===tabId && r.documentId && !ids.has(r.documentId))runningControls.delete(id);
    const l=tabControls.get(tabId);
    if(l?.state==="stopping")await finishControl(tabId,l.id);
    await persistControls();await updateControlUI(tabId);
  } catch { /* A protected/transitional page cannot prove old work has stopped. */ }
}
