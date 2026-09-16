// DSH Browser Bridge, protocol 3. No page code or third-party runtime dependency.
importScripts("control.js");
const DEFAULT_WS_URL = "ws://127.0.0.1:8765/ws";
let ws = null;
let generation = 0;
let connecting = false;
let reconnectTimer = null;
let connectionTimer = null;
let heartbeatTimer = null;
let lastPongAt = 0;
let reconnectAttempts = 0;
const results = new Map();

async function getWsUrl() {
  const cfg = await chrome.storage.local.get({ wsUrl: DEFAULT_WS_URL });
  return (cfg.wsUrl || DEFAULT_WS_URL).trim();
}
function setStatus(connected, info = "") {
  chrome.storage.session.set({ bridgeConnected: connected, bridgeInfo: info }).catch(() => {});
}
function send(sock, obj) {
  if (sock?.readyState === WebSocket.OPEN) {
    try { sock.send(JSON.stringify(obj)); } catch {}
  }
}
function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * 2 ** Math.min(reconnectAttempts++, 4), 15000) + Math.random() * 300;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, delay);
}
async function connect(force = false) {
  if (!force && (connecting || ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING)) return;
  const epoch = ++generation;
  connecting = true;
  clearTimeout(reconnectTimer); reconnectTimer = null;
  clearTimeout(connectionTimer);
  clearInterval(heartbeatTimer);
  const previous = ws; ws = null;
  try { previous?.close(); } catch {}
  setStatus(false, "连接中");
  try {
    const url = await getWsUrl();
    if (generation !== epoch) return;
    const sock = new WebSocket(url);
    ws = sock;
    connectionTimer = setTimeout(() => {
      if (generation === epoch && sock.readyState !== WebSocket.OPEN) sock.close();
    }, 10000);
    sock.onopen = () => {
      if (generation !== epoch) return sock.close();
      connecting = false;
      clearTimeout(connectionTimer);
      lastPongAt = Date.now();
      reconnectAttempts = 0;
      setStatus(true, "已连接");
      void controlReady.then(()=>send(sock,{type:"hello",...controlSnapshot(),info:{
        name:chrome.runtime.getManifest().name,version:chrome.runtime.getManifest().version,
        protocolVersion:3,capabilities:["exclusive-control","user-stop","idle-release","deadline","frames","batch-actions"],
      }}));
      send(sock, {type:"ping",t:Date.now()});
      heartbeatTimer = setInterval(heartbeat, 15000);
    };
    sock.onmessage = ev => {
      if (generation === epoch) void handleMessage(sock, ev.data);
    };
    sock.onclose = () => {
      if (generation !== epoch || ws !== sock) return;
      ws = null; connecting = false;
      clearTimeout(connectionTimer); clearInterval(heartbeatTimer);
      setStatus(false, "连接断开");
      for(const tabId of tabControls.keys())void updateControlUI(tabId);
      scheduleReconnect();
    };
    sock.onerror = () => { try { sock.close(); } catch {} };
  } catch (error) {
    if (generation !== epoch) return;
    connecting = false;
    setStatus(false, "连接失败");
    scheduleReconnect();
  }
}
function heartbeat() {
  if (!ws || ws.readyState !== WebSocket.OPEN) { void connect(); return; }
  if (Date.now() - lastPongAt > 45000) { void connect(true); return; }
  send(ws, {type:"ping",t:Date.now()});
}
async function handleMessage(sock, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type === "pong") { if (sock === ws) lastPongAt = Date.now(); return; }
  if (msg.type === "ping") { send(sock, {type:"pong",t:msg.t}); return; }
  if (msg.type === "control") {await handleControl(sock,msg);return;}
  if (msg.type !== "command") return;
  await controlReady;
  const now = Date.now();
  for (const [id, entry] of results) if (entry.done && now - entry.at > 300000) results.delete(id);
  const signature = JSON.stringify(msg.command);
  let entry = results.get(msg.id);
  if (entry && entry.signature !== signature) {
    send(sock, {type:"response",id:msg.id,ok:false,error:"REQUEST_ID_CONFLICT"});
    return;
  }
  if (!entry) {
    if (results.size >= 1000) {
      const first = [...results].find(([,v])=>v.done);
      if (first) results.delete(first[0]);
      else { send(sock,{type:"response",id:msg.id,ok:false,error:"QUEUE_FULL"}); return; }
    }
    entry = {at:now,signature,done:false};
    results.set(msg.id,entry);
    entry.promise = (async()=>{
      if (msg.deadline && Date.now() >= msg.deadline) throw new Error("DEADLINE_EXCEEDED: 命令已过期，未执行");
      ownsCommand(msg);
      if(msg.command.tabId!==undefined) {
        runningControls.set(msg.id,{id:msg.id,tabId:msg.command.tabId,leaseId:msg.leaseId,frameId:msg.command.frameId ?? 0});
        await persistControls();
        ownsCommand(msg);
      }
      return runCommand({...msg.command,deadline:msg.deadline,leaseId:msg.leaseId,commandId:msg.id,owner:msg.owner});
    })().then(data=>({ok:true,data}),error=>({ok:false,error:String(error?.message || error)}))
      .finally(async()=>{
        entry.done=true;entry.at=Date.now();
        runningControls.delete(msg.id);await persistControls();
        if(msg.command.tabId!==undefined)await finishControl(msg.command.tabId,msg.leaseId);
      });
  }
  const response = await entry.promise;
  // A response belongs to the socket that received its request, never a replacement socket.
  send(sock, {type:"response",id:msg.id,...response});
}

function tabInfo(t) {
  return {id:t.id,windowId:t.windowId,index:t.index,title:t.title || "",url:t.url || "",
    active:!!t.active,pinned:!!t.pinned,status:t.status || ""};
}
async function runCommand(cmd) {
  if (cmd.action === "ping") return {pong:Date.now()};
  if (cmd.action === "listTabs") return (await chrome.tabs.query({})).map(tabInfo);
  if (cmd.action === "getActive") {
    const tabs = await chrome.tabs.query({active:true,lastFocusedWindow:true});
    return tabs.length ? tabInfo(tabs[0]) : null;
  }
  if (cmd.action === "open") {
    const options = {url:String(cmd.url || "about:blank"),active:cmd.active === true};
    if (cmd.windowId !== undefined) options.windowId = cmd.windowId;
    const tab=await chrome.tabs.create(options);
    tabControls.set(tab.id,{id:cmd.provisionalId,tabId:tab.id,owner:cmd.owner,agentName:cmd.agentName || "Agent",
      state:"active",expiresAt:Date.now()+60000});
    await persistControls();await updateControlUI(tab.id);
    return tabInfo(tab);
  }
  const tabId = Number(cmd.tabId);
  if (cmd.expectedUrl && ["navigate","close","activate","screenshot"].includes(cmd.action)) {
    if ((await chrome.tabs.get(tabId)).url !== cmd.expectedUrl) throw new Error("STALE_PAGE: URL 已变化");
  }
  if (cmd.action === "close") { await chrome.tabs.remove(tabId); return {closed:tabId}; }
  if (cmd.action === "navigate") return {...tabInfo(await chrome.tabs.update(tabId,{url:String(cmd.url)})),navigationRequested:true};
  if (cmd.action === "activate") {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId,{active:true}); await chrome.windows.update(tab.windowId,{focused:true});
    return tabInfo(tab);
  }
  if (cmd.action === "frames") {
    const found = await chrome.scripting.executeScript({target:{tabId,allFrames:true},func:()=>({url:location.href,title:document.title})});
    return {frames:found.map(r=>({frameId:r.frameId,documentId:r.documentId,...r.result}))};
  }
  if (cmd.action === "screenshot") {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId,{active:true}); await chrome.windows.update(tab.windowId,{focused:true});
    await new Promise(r=>setTimeout(r,400));
    ownsCommand({command:cmd,leaseId:cmd.leaseId,owner:cmd.owner});
    const active = await chrome.tabs.query({windowId:tab.windowId,active:true});
    if (active[0]?.id !== tabId) throw new Error("FOCUS_CHANGED: 截图前活动标签已变化");
    return {tabId,url:tab.url,dataUrl:await chrome.tabs.captureVisibleTab(tab.windowId,{format:"png"})};
  }
  let target = cmd.documentId ? {tabId,documentIds:[cmd.documentId]} : {tabId,frameIds:[cmd.frameId ?? 0]};
  const probe=await chrome.scripting.executeScript({target,func:()=>true});
  const documentId=probe[0]?.documentId;
  if(!documentId)throw new Error("FRAME_UNAVAILABLE");
  const running=runningControls.get(cmd.commandId);
  if(running){running.documentId=documentId;await persistControls();}
  ownsCommand({command:cmd,leaseId:cmd.leaseId,owner:cmd.owner});
  target={tabId,documentIds:[documentId]};
  await chrome.scripting.executeScript({target,func:info=>{
    const current=globalThis.__dshControlV3;
    if(!current || current.leaseId!==info.leaseId)globalThis.__dshControlV3=info;
  },args:[{
    leaseId:cmd.leaseId,state:"active",expiresAt:tabControls.get(tabId)?.expiresAt || 0,
  }]});
  ownsCommand({command:cmd,leaseId:cmd.leaseId,owner:cmd.owner});
  const evalMode = cmd.action === "evaluate";
  const injected = await chrome.scripting.executeScript({
    target,...(evalMode?{world:"MAIN"}:{}),
    func:evalMode ? evaluateExpr : pageAction,args:[cmd],
  });
  if (!injected?.length) throw new Error("FRAME_UNAVAILABLE");
  return {...injected[0].result,frameId:injected[0].frameId,documentId:injected[0].documentId};
}

// Self-contained injected function, shared by all structured DOM actions.
async function pageAction(cmd) {
  const fail = (code,message)=>{throw new Error(code+": "+message);};
  const integer = (v,fallback,min,max)=>{
    if (v === undefined) return fallback;
    if (!Number.isInteger(v) || v < min || v > max) fail("INVALID_ARGUMENT","数值范围错误");
    return v;
  };
  const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none");
  const enabled = el => !el.disabled && el.getAttribute("aria-disabled") !== "true";
  const withoutControlUI=read=>{
    const host=globalThis.__dshControlBannerV3?.host;
    if(!host)return read();
    const value=host.style.getPropertyValue("display"),priority=host.style.getPropertyPriority("display");
    host.style.setProperty("display","none","important");
    try{return read();}finally{
      if(value)host.style.setProperty("display",value,priority);else host.style.removeProperty("display");
    }
  };
  const textOf = el => withoutControlUI(()=>(el.innerText || el.textContent || "").trim());
  const assertControl=()=>{
    if(!cmd.leaseId)return;
    const control=globalThis.__dshControlV3;
    if(!control || control.leaseId!==cmd.leaseId || control.state!=="active" || Date.now()>=control.expiresAt)
      fail("CONTROL_REVOKED","页面控制权已终止");
  };
  assertControl();
  function find(selector) {
    if (!selector) return [];
    let roots = [document];
    const parts = selector.split(/\s*>>>\s*/);
    for (let i=0;i<parts.length;i++) {
      const part=parts[i]; let items=[];
      for (const root of roots) {
        if (part.startsWith("label=")) {
          const name=part.slice(6);
          items.push(...[...root.querySelectorAll("label")].filter(e=>textOf(e)===name).map(e=>e.control).filter(Boolean));
        } else if (part.startsWith("placeholder=")) {
          items.push(...[...root.querySelectorAll("[placeholder]")].filter(e=>e.getAttribute("placeholder")===part.slice(12)));
        } else if (part.startsWith("text=")) {
          const name=part.slice(5);
          const candidates=[...root.querySelectorAll("button,a,label,[role],input[type=button],input[type=submit],span,div")];
          items.push(...candidates.filter(e=>textOf(e)===name && ![...e.children].some(c=>textOf(c)===name)));
        } else if (part.startsWith("role=")) {
          const match=/^role=([a-z]+)(?:\[name="(.*)"\])?$/.exec(part);
          if (!match) fail("INVALID_SELECTOR",part);
          const implicit={button:"button,input[type=button],input[type=submit]",textbox:"input:not([type]),input[type=text],textarea",checkbox:"input[type=checkbox]",radio:"input[type=radio]",link:"a[href]",combobox:"select"};
          const candidates=[...root.querySelectorAll('[role="'+match[1]+'"]'+(implicit[match[1]]?","+implicit[match[1]]:""))];
          items.push(...candidates.filter(e=>match[2]===undefined || (e.getAttribute("aria-label") || textOf(e) || e.value)===match[2]));
        } else {
          try { items.push(...root.querySelectorAll(part)); } catch { fail("INVALID_SELECTOR",part); }
        }
      }
      items=[...new Set(items)].filter(el=>!el.closest?.("[data-dsh-control-ui]"));
      if (i===parts.length-1) return items;
      roots=items.map(e=>e.shadowRoot).filter(Boolean);
    }
    return [];
  }
  function one(selector, index, actionable=true) {
    let items=selector?find(selector):[document.activeElement].filter(Boolean);
    if (actionable) items=items.filter(visible);
    if (!items.length) fail("ELEMENT_NOT_FOUND",selector || "当前焦点");
    if (index===undefined && items.length!==1) fail("AMBIGUOUS_ELEMENT",items.length+" 个匹配；请指定唯一定位或 index");
    const at=integer(index,0,0,10000);
    if (at>=items.length) fail("INVALID_INDEX","索引超出匹配数量 "+items.length);
    const el=items[at];
    if (actionable && !enabled(el)) fail("ELEMENT_DISABLED",selector);
    return el;
  }
  if (cmd.expectedUrl && location.href !== cmd.expectedUrl) fail("STALE_PAGE","URL 已变化");
  if (cmd.deadline && Date.now()>=cmd.deadline) fail("DEADLINE_EXCEEDED","未执行");
  if (cmd.action==="readPage") {
    const root=cmd.selector?one(cmd.selector,undefined,false):document.body;
    const full=root?withoutControlUI(()=>(root.innerText || root.textContent || "")):"";
    const offset=integer(cmd.offset,0,0,10000000), max=integer(cmd.maxText,8000,256,120000);
    const text=full.slice(offset,offset+max), truncated=offset+text.length<full.length;
    const maxHtml=integer(cmd.maxHtml,0,0,300000);
    let html;
    if(maxHtml && root){
      const copy=root.cloneNode(true);copy.querySelectorAll("[data-dsh-control-ui]").forEach(el=>el.remove());
      html=(copy.outerHTML || "").slice(0,maxHtml);
    }
    return {url:location.href,title:document.title,readyState:document.readyState,text,
      ...(maxHtml?{html:html || ""}:{}),
      totalChars:full.length,offset,truncated,nextOffset:truncated?offset+text.length:null};
  }
  if (cmd.action==="extract") {
    const all=find(cmd.selector), offset=integer(cmd.offset,0,0,10000000);
    const limit=integer(cmd.limit,20,1,100), budget=integer(cmd.max,8000,256,50000);
    const items=[]; let used=0;
    for (const el of all.slice(offset,offset+limit)) {
      const raw=textOf(el), available=budget-used;
      if (available<256) break;
      const item={tag:el.tagName,id:(el.id || "").slice(0,128),className:String(el.className || "").slice(0,128),
        href:(el.href || "").slice(0,1024),text:"",
        ...(el.value!==undefined?{value:String(el.value).slice(0,500)}:{}),
        ...(typeof el.checked==="boolean"?{checked:el.checked}:{}),
        visible:visible(el),enabled:enabled(el)};
      let overhead=JSON.stringify(item).length;
      if (overhead>available) { item.href="";item.className="";if ("value" in item) item.value="";overhead=JSON.stringify(item).length; }
      item.text=raw.slice(0,Math.max(0,Math.min(2000,available-overhead-50)));
      item.textTruncated=item.text.length<raw.length;
      // JSON escaping can expand text; enforce the serialized item budget.
      while (JSON.stringify(item).length>available && item.text.length) item.text=item.text.slice(0,Math.floor(item.text.length/2));
      item.textTruncated=item.text.length<raw.length;
      const size=JSON.stringify(item).length;
      if (size>available) break;
      items.push(item);used+=size;
    }
    const next=offset+items.length;
    return {found:all.length>0,selector:cmd.selector,count:all.length,totalCount:all.length,returnedCount:items.length,
      items,truncated:next<all.length || items.some(i=>i.textTruncated),nextOffset:next<all.length?next:null};
  }
  if (cmd.action==="wait") {
    const timeout=integer(cmd.timeout,10000,1,30000), start=Date.now(), state=cmd.state || "attached";
    if (!["attached","visible","enabled","hidden","detached"].includes(state)) fail("INVALID_ARGUMENT","未知等待状态");
    while (true) {
      assertControl();
      const items=find(cmd.selector);
      const match=items.some(e=>(state==="attached" || (visible(e) && (state!=="enabled" || enabled(e)))) &&
        (cmd.contains===undefined || textOf(e).includes(cmd.contains)));
      const done=state==="detached" ? items.length===0 : state==="hidden" ? !items.some(visible) : match;
      if (done) return {found:true,state,selector:cmd.selector,elapsedMs:Date.now()-start};
      if (Date.now()-start>=timeout || (cmd.deadline && Date.now()>=cmd.deadline)) fail("WAIT_TIMEOUT",cmd.selector);
      await new Promise(r=>setTimeout(r,100));
    }
  }
  if (cmd.action==="scroll") {
    if (cmd.selector) {
      const el=one(cmd.selector,cmd.index,false);
      if (cmd.dx || cmd.dy) el.scrollBy({left:cmd.dx || 0,top:cmd.dy || 0,behavior:"instant"});
      else el.scrollIntoView({block:"center",behavior:"instant"});
      return {scrolled:true,x:el.scrollLeft,y:el.scrollTop};
    }
    window.scrollBy({left:cmd.dx || 0,top:cmd.dy || 0,behavior:"instant"});
    return {scrolled:true,x:window.scrollX,y:window.scrollY};
  }
  if (cmd.action==="key") {
    const target=document.activeElement || document.body, mods=cmd.modifiers || [];
    const init={bubbles:true,cancelable:true,key:cmd.key,code:cmd.code || cmd.key,
      ctrlKey:mods.some(m=>/ctrl|control/i.test(m)),shiftKey:mods.includes("Shift"),
      altKey:mods.includes("Alt"),metaKey:mods.some(m=>/meta|cmd|win/i.test(m))};
    for (const type of ["keydown","keypress","keyup"]) target.dispatchEvent(new KeyboardEvent(type,init));
    return {dispatched:true,key:cmd.key,targetTag:target.tagName,synthetic:true};
  }
  const el=one(cmd.selector || (cmd.text && cmd.action==="click" ? "text="+cmd.text : ""),cmd.action==="select"?undefined:cmd.index);
  if (cmd.action==="click") {
    el.scrollIntoView({block:"center",behavior:"instant"});
    if (typeof el.click==="function") el.click();
    else el.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,view:window}));
    return {clicked:true,tag:el.tagName,id:el.id || ""};
  }
  if (cmd.action==="hover") {
    el.scrollIntoView({block:"center",behavior:"instant"});
    for (const type of ["mouseover","mouseenter","mousemove"]) el.dispatchEvent(new MouseEvent(type,{bubbles:type!=="mouseenter",view:window}));
    return {hovered:true,synthetic:true};
  }
  const check = checked=>{
    if (el.tagName!=="INPUT" || !["checkbox","radio"].includes(el.type)) fail("UNSUPPORTED_ELEMENT","需要 checkbox/radio");
    if (el.type==="radio" && !checked) fail("UNSUPPORTED_ACTION","请选中同组其他单选项");
    if (el.checked!==checked) el.click();
    if (el.checked!==checked) fail("STATE_MISMATCH","勾选未生效");
    return {checked:el.checked,verified:true};
  };
  const select = ()=>{
    if (el.tagName!=="SELECT") fail("UNSUPPORTED_ELEMENT","需要原生 SELECT");
    const choices=[cmd.value!==undefined,cmd.label!==undefined,cmd.index!==undefined].filter(Boolean).length;
    if (choices!==1) fail("INVALID_ARGUMENT","value/label/index 三选一");
    const options=[...el.options];
    const matches=cmd.index!==undefined ? [options[cmd.index]].filter(Boolean) : options.filter(o=>cmd.value!==undefined?o.value===cmd.value:textOf(o)===cmd.label);
    if (matches.length!==1) fail("AMBIGUOUS_OPTION","选项不存在或不唯一");
    if (matches[0].disabled) fail("ELEMENT_DISABLED","选项已禁用");
    el.value=matches[0].value;
    el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));
    if (el.value!==matches[0].value) fail("STATE_MISMATCH","选择未生效");
    return {selected:true,value:el.value,label:textOf(matches[0]),verified:true};
  };
  if (cmd.action==="check") {
    if (typeof cmd.checked!=="boolean") fail("INVALID_ARGUMENT","checked 必须是 boolean");
    return check(cmd.checked);
  }
  if (cmd.action==="select") return select();
  if (cmd.action!=="type") fail("UNSUPPORTED_ACTION",cmd.action);
  const text=String(cmd.text ?? "");
  if (el.tagName==="INPUT" && ["checkbox","radio"].includes(el.type)) {
    if (!/^(true|false|1|0|yes|no|on|off|checked|unchecked|勾选|选中|取消)$/i.test(text.trim())) fail("INVALID_ARGUMENT","无效勾选值");
    return {typed:true,...check(/^(true|1|yes|on|checked|勾选|选中)$/i.test(text.trim()))};
  }
  if (el.tagName==="SELECT") {cmd.label=text;return {typed:true,...select()};}
  if (el.readOnly || el.disabled || el.type==="file") fail("UNSUPPORTED_ELEMENT","不可写输入元素");
  el.focus();
  if (["INPUT","TEXTAREA"].includes(el.tagName)) {
    const expected=cmd.clear===false?el.value+text:text;
    const proto=el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,"value").set.call(el,expected);
    el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));
    await Promise.resolve();
    if (el.value!==expected) fail("STATE_MISMATCH","输入值未保留");
    return {typed:true,verified:true,length:el.value.length,tag:el.tagName};
  }
  if (el.isContentEditable) {
    if (cmd.clear!==false) {const range=document.createRange();range.selectNodeContents(el);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);}
    if (!document.execCommand("insertText",false,text)) fail("INPUT_FAILED","编辑器拒绝插入");
    return {typed:true,verified:false,tag:el.tagName,length:text.length};
  }
  fail("UNSUPPORTED_ELEMENT","元素不接受文本输入");
}
async function evaluateExpr(cmd) {
  try {
    const value=await new Function("return ("+cmd.expression+")")();
    const seen=new WeakSet();
    const json=JSON.stringify(value,(_k,v)=>{
      if (typeof v==="bigint") return String(v);
      if (typeof v==="function") return "[Function: 显式调用后才会执行]";
      if (v && typeof v==="object") {
        if (seen.has(v)) return "[Circular]";seen.add(v);
        if (v instanceof Node) return {tag:v.nodeName,id:v.id,text:(v.textContent || "").slice(0,500)};
      }
      return v;
    }) ?? "null";
    const max=Math.min(Math.max(cmd.max ?? 8000,256),50000);
    if (json.length>max) return {ok:true,type:typeof value,preview:json.slice(0,max),truncated:true,totalChars:json.length};
    return {ok:true,type:typeof value,json,truncated:false};
  } catch (error) {return {ok:false,error:String(error?.message || error)};}
}

chrome.alarms.create("dsb-keepalive",{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==="dsb-keepalive") {heartbeat();void controlTick();}});
setInterval(()=>void controlTick(),1000);
chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.status==="complete")void documentChanged(tabId);});
chrome.tabs.onRemoved.addListener(tabId=>{
  tabControls.delete(tabId);blockedOwners.delete(tabId);
  for(const [id,r] of runningControls)if(r.tabId===tabId)runningControls.delete(id);
  void persistControls();send(ws,{type:"tabClosed",tabId});
});
chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
  const fromPopup=sender.id===chrome.runtime.id && sender.url===chrome.runtime.getURL("popup.html");
  const fromPage=sender.id===chrome.runtime.id && sender.tab && sender.frameId===0;
  if(msg?.type==="dsb-control-list" && fromPopup) {
    void controlReady.then(()=>respond({controls:[...tabControls.values()].map(l=>({tabId:l.tabId,agentName:l.agentName,state:l.state,expiresAt:l.expiresAt})),
      paused:[...blockedOwners.keys()]}));return true;
  }
  if(["dsb-stop-control","dsb-allow-control"].includes(msg?.type) && (fromPopup || fromPage)) {
    const tabId=fromPage?sender.tab.id:msg.tabId;
    const l=tabControls.get(tabId);
    if(fromPage && l && msg.leaseId!==l.id){respond({ok:false});return false;}
    void (async()=>{
      await controlReady;
      if(msg.type==="dsb-stop-control")await revokeLocal(tabId,"user_stopped",true);
      else if(!tabControls.has(tabId)){blockedOwners.delete(tabId);await persistControls();await updateControlUI(tabId);send(ws,{type:"userAllow",tabId});}
      respond({ok:true});
    })().catch(()=>respond({ok:false}));
    return true;
  }
  if (msg?.type==="dsb-reconnect") {void connect(true);respond({ok:true});return false;}
  if (msg?.type==="dsb-get-status") {
    getWsUrl().then(wsUrl=>respond({connected:ws?.readyState===WebSocket.OPEN && Date.now()-lastPongAt<45000,
      wsUrl,info:"",wsState:ws?.readyState ?? -1,lastPongAt})).catch(()=>respond({connected:false}));
    return true;
  }
});
void connect();
