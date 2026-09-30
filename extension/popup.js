const $ = (id) => document.getElementById(id);

async function dialogActivationState() {
  // Chrome forbids optional debugger permission; loading the manifest and enabling observation are separate.
  if(!chrome.runtime.getManifest().permissions?.includes("debugger"))
    return {available:false,error:"当前运行清单缺少 debugger 必需权限，请在 chrome://extensions/ 重新加载 DSH Browser Bridge。"};
  if(!await chrome.permissions.contains({permissions:["debugger"]}))
    return {available:false,error:"Chrome 尚未授予 debugger 权限，请在扩展管理页确认权限并重新加载。"};
  return {available:true,error:null};
}

async function refresh() {
  // A permission grant alone never enables observation, including after an extension reload.
  const config=await chrome.storage.local.get({dialogObservationEnabled:false});
  const activation=await dialogActivationState(),enabled=activation.available && config.dialogObservationEnabled;
  $("dialog-status").textContent=activation.error || (enabled?"原生弹窗识别已启用（仅观测受控页面，不自动确认）":"原生弹窗识别未启用，无法据此排除原生弹窗");
  $("btn-dialogs").disabled=!activation.available || enabled;
  $("btn-dialogs").textContent=!activation.available?"请先重新加载扩展":enabled?"原生弹窗识别已启用":"启用原生弹窗识别";
  try {
    const status = await chrome.runtime.sendMessage({ type: "dsb-get-status" });
    $("dot").className = "dot " + (status.connected ? "on" : "off");
    $("status-text").textContent = status.connected
      ? "已连接 " + status.wsUrl
      : "未连接（" + (status.info || "请确认桥接服务正在运行") + "）";
    $("ws-url").value = status.wsUrl || "";
  } catch (e) {
    $("status-text").textContent = "状态获取失败: " + e.message;
  }

  const tabs = await chrome.tabs.query({});
  const controlState = await chrome.runtime.sendMessage({type:"dsb-control-list"});
  const ul = $("tab-list");
  ul.innerHTML = "";
  for (const t of tabs) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = `${t.active ? "▶ " : ""}${(t.title || "(无标题)").slice(0, 48)}`;
    a.title = t.url || "";
    a.onclick = async (e) => {
      e.preventDefault();
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      window.close();
    };
    const details=document.createElement("div");details.className="tab-details";details.appendChild(a);
    const control=controlState.controls.find(c=>c.tabId===t.id);
    const paused=controlState.paused.includes(t.id);
    if(control || paused) {
      const status=document.createElement("div");status.className="control-status";
      status.textContent=control?control.agentName+" · "+(control.state==="active"?"正在控制":"正在停止，等待旧操作结束"):"旧任务已停止";
      details.appendChild(status);
      const stop=document.createElement("button");stop.className="control-button";
      stop.textContent=control?"停止控制":"允许旧任务";
      stop.disabled=control?.state==="stopping";
      stop.onclick=async event=>{
        if(!event.isTrusted)return;
        stop.disabled=true;
        await chrome.runtime.sendMessage({type:control?"dsb-stop-control":"dsb-allow-control",tabId:t.id});
        await refresh();
      };
      li.appendChild(stop);
    }
    // Native dialogs are not DOM elements; manual recovery remains available after task stop.
    const native=controlState.nativeDialogs?.find(state=>state.tabId===t.id);
    if(native?.blocked && !native.active) {
      const warning=document.createElement("div");warning.className="control-status";
      warning.textContent="页面脚本未响应，可能有观测前已打开的原生弹窗；请切到页面人工核验。";details.appendChild(warning);
    }
    if(native?.active) {
      const dialog=native.active;
      const warning=document.createElement("div");warning.className="control-status";
      warning.textContent=(native.known?"原生 ":"观测已中断，待用户核验：")+dialog.type+" · "+(dialog.blank?"空正文":dialog.message.slice(0,120));
      details.appendChild(warning);
      if(dialog.type==="prompt") {
        const hint=document.createElement("div");hint.className="control-status";
        hint.textContent="请在原生弹窗输入回复；插件不代填、不自动确认。";details.appendChild(hint);
      } else {
        for(const accept of dialog.type==="alert"?[true]:[false,true]) {
          const recover=document.createElement("button");recover.className="control-button";
          recover.textContent=accept?(dialog.type==="beforeunload"?"确认离开页面":"确认弹窗"):"取消弹窗";
          recover.disabled=!native.known;
          recover.onclick=async event=>{
            if(!event.isTrusted)return;
            recover.disabled=true;
            const result=await chrome.runtime.sendMessage({type:"dsb-handle-dialog",tabId:t.id,dialogId:dialog.id,accept});
            if(!result.ok)$("dialog-status").textContent=result.error;
            else await refresh();
          };
          details.appendChild(recover);
        }
      }
    }
    li.prepend(details);
    const tag = document.createElement("span");
    tag.className = "tabid";
    tag.textContent = "#" + t.id;
    li.appendChild(tag);
    ul.appendChild(li);
  }
  $("msg").textContent = `标签页 ${tabs.length} 个 · ${new Date().toLocaleTimeString()}`;
}

document.addEventListener("DOMContentLoaded", () => {
  // Only the user's trusted click enables the feature; debugger is never requested as optional.
  $("btn-dialogs").onclick=async event=>{
    if(!event.isTrusted)return;
    try {
      const activation=await dialogActivationState();
      if(!activation.available)throw new Error(activation.error);
      $("btn-dialogs").disabled=true;
      const result=await chrome.runtime.sendMessage({type:"dsb-enable-dialogs"});
      if(!result.ok)throw new Error(result.error);
      await refresh();
    } catch(error) {await refresh();$("dialog-status").textContent="启用失败："+error.message;}
  };
  $("btn-refresh").onclick = refresh;
  $("btn-save").onclick = async () => {
    const url = $("ws-url").value.trim() || "ws://127.0.0.1:8765/ws";
    await chrome.storage.local.set({ wsUrl: url });
    await chrome.runtime.sendMessage({ type: "dsb-reconnect" });
    await refresh();
  };
  refresh();
  setInterval(refresh,3000);
});
