const $ = (id) => document.getElementById(id);

async function refresh() {
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
