#!/usr/bin/env node
"use strict";
const http = require("node:http");
const {randomUUID,createHash} = require("node:crypto");
const {WebSocketServer} = require("ws");
const {ControlManager}=require("./control-manager.cjs");
const PORT = Number(process.env.DSH_BRIDGE_PORT || 8765);
const HOST = "127.0.0.1";
const VERSION = require("../package.json").version;
const EXTENSION_VERSION = require("../extension/manifest.json").version;
const WAIT_CONNECT_MS = Number(process.env.DSH_BRIDGE_WAIT || 12000);
const COMMAND_TIMEOUT_MS = Number(process.env.DSH_BRIDGE_TIMEOUT || 30000);
const TOKEN = process.env.DSH_BRIDGE_TOKEN || "";
const startedAt=Date.now(), instanceId=randomUUID();
const pending=new Map(), records=new Map(), controlRequests=new Map();
const controls=new ControlManager({sync:syncControl,onRevoke:(l,{closed=false}={})=>{
  for(const r of records.values())if(r.leaseId===l.id && ["queued","dispatched"].includes(r.state) && !(closed && r.action==="close"))r.controller?.abort();
}});
const WRITE_ACTIONS=new Set(["open","close","navigate","activate","click","type","key","scroll","check","select","hover","screenshot","evaluate","batch"]);
const ACTIONS=new Set([...WRITE_ACTIONS,"readPage","extract","wait","frames","listTabs","getActive","ping"]);
let extSocket=null,extInfo=null,lastPongAt=0,reconnects=0,queuedWrites=0,nextScreenshotAt=0,connectionGeneration=0;
let writeTail=Promise.resolve();
const log=(...args)=>console.log(new Date().toISOString(),"[bridge]",...args);
const error=(code,message,statusCode=400,definitive=true)=>Object.assign(new Error(code+": "+message),{code,statusCode,definitive});
const disconnected=()=>error("EXTENSION_DISCONNECTED","扩展断开；已发送动作结果未知",503,false);
function healthy() {return !!(extSocket?.readyState===1 && Date.now()-lastPongAt<45000);}
function cleanup() {
  const now=Date.now();
  for(const [id,r] of records) if(!["queued","dispatched"].includes(r.state) && now-r.updatedAt>300000) records.delete(id);
  controls.sweep();
}
function checkContext(ctx) {
  if(ctx.signal.aborted) throw error("CANCELLED","请求已取消",499,!ctx.dispatched);
  if(Date.now()>=ctx.deadline) throw error("DEADLINE_EXCEEDED","请求总时限已到",408,!ctx.dispatched);
  if(ctx.tabId!==undefined)controls.check(ctx.lease,ctx.owner);
}
function syncControl(lease,action) {
  if(!healthy() || extInfo?.protocolVersion!==3)return Promise.reject(error("EXTENSION_UNAVAILABLE","需要在线的协议 3 扩展",503));
  const id=randomUUID(),socket=extSocket;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{controlRequests.delete(id);reject(error("CONTROL_SYNC_TIMEOUT","控制状态同步未确认",504,false));},5000);
    controlRequests.set(id,{socket,resolve,reject,timer,generation:connectionGeneration});
    socket.send(JSON.stringify({type:"control",id,action,instanceId,lease:{...controls.public(lease),id:lease.id,owner:lease.owner}}));
  });
}
function enqueueWrite(task,ctx) {
  if(queuedWrites>=100) return Promise.reject(error("QUEUE_FULL","写队列已满",429));
  queuedWrites++;
  const run=writeTail.then(async()=>{checkContext(ctx);return task();});
  writeTail=run.catch(()=>{});
  return run.finally(()=>queuedWrites--);
}
function rejectPendingForSocket(sock) {
  for(const request of pending.values()) if(request.socket===sock) request.finish(disconnected());
}
const wss=new WebSocketServer({noServer:true,maxPayload:4*1024*1024});
wss.on("connection",sock=>{
  if(extSocket) {rejectPendingForSocket(extSocket);extSocket.close(1000,"Replaced by new connection");reconnects++;}
  extSocket=sock;extInfo=null;lastPongAt=Date.now();connectionGeneration++;
  sock.on("message",raw=>{
    let msg;try{msg=JSON.parse(raw);}catch{return;}
    if(msg.type==="controlAck") {
      const p=controlRequests.get(msg.id);if(!p || p.socket!==sock)return;
      controlRequests.delete(msg.id);clearTimeout(p.timer);
      if(sock!==extSocket)return p.reject(disconnected());
      const code=/^([A-Z_]+):?/.exec(msg.error || "")?.[1] || "CONTROL_SYNC_FAILED";
      msg.ok===false?p.reject(error(code,msg.error || "扩展拒绝控制同步",409)):p.resolve({...msg,connectionGeneration:p.generation});
    } else if(sock===extSocket && msg.type==="controlDrained") {
      controls.drained(msg.tabId,msg.leaseId);
    } else if(sock===extSocket && msg.type==="userStop") {
      const l=controls.leases.get(msg.tabId);
      if(l?.id===msg.leaseId)void controls.revoke(l,"user_stopped",true);
    } else if(sock===extSocket && msg.type==="userAllow") {
      controls.blocked.delete(msg.tabId);
    } else if(sock===extSocket && msg.type==="tabClosed") {
      controls.closeTab(msg.tabId);
    } else if(msg.type==="response") {
      const request=pending.get(msg.id);
      if(!request || request.socket!==sock) return;
      if(msg.ok) request.finish(null,msg.data);
      else {
        const code=/^([A-Z_]+):?/.exec(msg.error || "")?.[1] || "EXTENSION_ERROR";
        const uncertain=request.write && /Frame with ID|frame.*removed|context.*invalidated|tab.*closed/i.test(msg.error || "");
        request.finish(error(code,msg.error || "扩展执行失败",502,!uncertain));
      }
    } else if(sock===extSocket && msg.type==="hello") {
      extInfo=msg.info || {};lastPongAt=Date.now();log("扩展已连接",extInfo.version || "?");
      if(extInfo.protocolVersion===3) {
        for(const item of msg.blocked || [])controls.blocked.set(item.tabId,new Set(item.owners));
        for(const old of msg.controls || [])if(!controls.leases.has(old.tabId)) {
          const l={...old,id:old.sessionId || old.id,owner:old.owner || "orphaned-control",name:old.agentName || "旧任务",state:"active",lastActivity:0,pending:0};
          controls.leases.set(l.tabId,l);void controls.revoke(l,"service_restarted");
        }
        for(const l of controls.leases.values()) {
          if(controls.blocked.get(l.tabId)?.has(l.owner)){void controls.revoke(l,"user_stopped",true);continue;}
          if(l.state==="stopping") {void syncControl(l,"revoke").then(r=>{if(r.drained)controls.drained(l.tabId,l.id);}).catch(()=>{});}
          else void syncControl(l,"grant").catch(()=>controls.revoke(l,"reconnect_failed"));
        }
      }
    } else if(sock===extSocket && msg.type==="ping") {
      lastPongAt=Date.now();sock.send(JSON.stringify({type:"pong",t:msg.t}));
    } else if(sock===extSocket && msg.type==="pong") lastPongAt=Date.now();
  });
  sock.on("close",()=>{
    rejectPendingForSocket(sock);
    for(const [id,p] of controlRequests)if(p.socket===sock){clearTimeout(p.timer);controlRequests.delete(id);p.reject(disconnected());}
    if(extSocket===sock){extSocket=null;extInfo=null;}
  });
  sock.on("error",()=>rejectPendingForSocket(sock));
});
const heartbeat=setInterval(()=>{
  cleanup();
  if(extSocket && Date.now()-lastPongAt>=45000) {const sock=extSocket;extSocket=null;extInfo=null;rejectPendingForSocket(sock);sock.terminate();}
  // Old extensions initiate their own ping; protocol 2 also responds to server ping.
  else if(extSocket?.readyState===1 && extInfo?.protocolVersion>=2) extSocket.send(JSON.stringify({type:"ping",t:Date.now()}));
},15000);
heartbeat.unref();
const leaseSweep=setInterval(()=>controls.sweep(),1000);leaseSweep.unref();
async function waitForExtension(ctx) {
  const until=Math.min(ctx.deadline,Date.now()+WAIT_CONNECT_MS);
  while(!healthy()) {
    checkContext(ctx);
    if(Date.now()>=until) throw error("EXTENSION_UNAVAILABLE","Chrome 扩展未连接",503);
    await new Promise(r=>setTimeout(r,100));
  }
  checkContext(ctx);
  return extSocket;
}
async function sendCommand(action,params,ctx) {
  if(!ACTIONS.has(action)) throw error("INVALID_ACTION",action);
  const sock=await waitForExtension(ctx);
  if(sock.readyState!==1) throw disconnected();
  if(ctx.tabId!==undefined && extInfo?.protocolVersion!==3)
    throw error("EXTENSION_UPGRADE_REQUIRED","请重载 Chrome 扩展以启用独占控制",409);
  if(action==="screenshot") {
    const delay=nextScreenshotAt-Date.now();
    if(delay>0) await new Promise(r=>setTimeout(r,delay));
    checkContext(ctx);nextScreenshotAt=Date.now()+600;
  }
  // Queue waits and a previously returned status are not permission to write.
  // Confirm the current lease with the extension immediately before dispatch.
  if(ctx.lease)await controls.confirm(ctx.lease,ctx.owner);
  checkContext(ctx);
  if(sock!==extSocket)throw disconnected();
  const id=ctx.record.id+":"+(ctx.commandIndex=(ctx.commandIndex || 0)+1);
  return new Promise((resolve,reject)=>{
    const timeout=Math.min(ctx.deadline-Date.now(),Math.max(COMMAND_TIMEOUT_MS,action==="wait"?(params.timeout || 10000)+500:0));
    let timer;
    const abort=()=>finish(error("CANCELLED","已发送命令的结果未知",499,false));
    const finish=(err,data)=>{
      if(!pending.has(id)) return;
      pending.delete(id);clearTimeout(timer);ctx.signal.removeEventListener("abort",abort);
      err?reject(err):resolve(data);
    };
    pending.set(id,{socket:sock,finish,write:WRITE_ACTIONS.has(action)});
    timer=setTimeout(()=>finish(error("COMMAND_TIMEOUT","已发送命令的结果未知",504,false)),Math.max(1,timeout));
    ctx.signal.addEventListener("abort",abort,{once:true});
    if(ctx.signal.aborted) return abort();
    try {
      ctx.dispatched=true;if(ctx.record){ctx.record.state="dispatched";ctx.record.updatedAt=Date.now();}
      sock.send(JSON.stringify({type:"command",id,deadline:ctx.deadline,instanceId,
        leaseId:ctx.lease?.id,owner:ctx.owner,
        command:{action,...params,...(action==="open"?{provisionalId:ctx.openLeaseId ||= randomUUID(),agentName:ctx.ownerName}:{})}}),err=>{if(err)finish(disconnected());});
    } catch {finish(disconnected());}
  });
}
function validateActionResult(action,data) {
  if(action==="wait" && data?.found!==true) throw error("WAIT_TIMEOUT","元素条件未满足",408);
  if(action==="type" && data?.typed!==true) throw error("INPUT_FAILED","输入未生效",422);
  if(action==="evaluate" && data?.ok===false) throw error("EVALUATE_FAILED",data.error || "JS 执行失败",422);
  return data;
}
async function perform(action,body,ctx) {
  checkContext(ctx);
  const result=validateActionResult(action,await sendCommand(action,body,ctx));
  if(action==="listTabs")return result.map(t=>({...t,control:controls.public(controls.leases.get(t.id))}));
  if(action==="close")controls.closeTab(ctx.tabId);
  if(action==="open") {
    const l=controls.admit(result.id,ctx.owner,ctx.ownerName,undefined,{provisionalId:ctx.openLeaseId});
    await l.ready;
    return {...result,control:controls.public(l)};
  }
  return result;
}
const BATCH_ACTIONS=new Set(["click","type","key","scroll","check","select","hover","wait","readPage","extract","navigate"]);
async function batch(body,ctx) {
  if(!Array.isArray(body.steps) || !body.steps.length || body.steps.length>20) throw error("INVALID_ARGUMENT","steps 必须有 1–20 步");
  for(const step of body.steps) if(!step || !BATCH_ACTIONS.has(step.action)) throw error("INVALID_ACTION","不支持的批量步骤");
  const steps=[];
  const outputBudget=bounded(body.maxOutput,16000,4096,50000);
  let outputChars=1024,outputTruncated=false;
  for(let i=0;i<body.steps.length;i++) {
    const step=body.steps[i];
    try {
      const result=await perform(step.action,{...step,tabId:ctx.tabId,maxText:step.maxText ?? 4000,max:step.max ?? 4000},ctx);
      const size=JSON.stringify(result).length;
      const retained=outputChars+size<outputBudget-128?result:{omitted:true,reason:"OUTPUT_BUDGET"};
      if(retained!==result)outputTruncated=true;
      outputChars+=JSON.stringify(retained).length+100;
      steps.push({index:i,action:step.action,ok:true,result:retained});
    } catch(err) {
      return {ok:false,tabId:ctx.tabId,failedStep:i,state:err.definitive?"failed":"unknown",
        error:err.message,code:err.code,completedSteps:steps,requestId:ctx.record.id,outputTruncated};
    }
  }
  return {ok:true,tabId:ctx.tabId,steps,outputTruncated};
}
function statusJson() {
  return {ok:true,version:VERSION,protocolVersion:3,instanceId,connected:healthy(),extension:extInfo,
    capabilities:["atomic-session-v1"],connectionGeneration,expectedExtensionVersion:EXTENSION_VERSION,
    lastHeartbeatAt:lastPongAt || null,heartbeatAgeMs:lastPongAt?Date.now()-lastPongAt:null,reconnects,
    uptimeSec:Math.round((Date.now()-startedAt)/1000),port:PORT,pending:pending.size,queuedWrites,controlledTabs:controls.leases.size};
}
function supportsSessions() {return healthy() && extInfo?.protocolVersion===3 && extInfo?.capabilities?.includes("atomic-session-v1");}
function sessionView(tabId,owner,sessionId,confirmation) {
  const now=Date.now(),l=controls.leases.get(tabId),snapshot=confirmation?.snapshot;
  const verified=!!(supportsSessions() && snapshot && confirmation.connectionGeneration===connectionGeneration);
  const remote=verified?snapshot.control:null;
  const blocked=!!(controls.blocked.get(tabId)?.has(owner) || (verified && snapshot.blocked));
  const matches=!!(l && remote && l.id===remote.id && l.owner===remote.owner);
  const valid=!!(verified && snapshot.tab && matches && !blocked && l.owner===owner && l.state==="active" &&
    remote.state==="active" && now<Math.min(l.expiresAt,remote.expiresAt) && (!sessionId || sessionId===l.id));
  const current=remote || l;
  const currentOwner=current?.owner;
  const occupied=!!(currentOwner && currentOwner!==owner);
  const draining=l?.state==="stopping" || remote?.state==="stopping" || (!remote && verified && snapshot.running>0);
  const reacquireAllowed=!!(verified && snapshot.tab && !blocked && !occupied && !draining);
  let reason=valid?null:!healthy()?"EXTENSION_DISCONNECTED":!supportsSessions()?"UPGRADE_REQUIRED":blocked?"CONTROL_STOPPED":
    verified && !snapshot.tab?"TAB_NOT_FOUND":occupied?"TAB_OCCUPIED":draining?"CONTROL_STOPPING":
    sessionId && sessionId!==l?.id?"SESSION_EXPIRED":"CONTROL_REVOKED";
  const action=valid?"use_session":!healthy()?"reconnect_extension":!supportsSessions()?"reload_extension":blocked?"user_allow_control":
    reason==="TAB_NOT_FOUND"?"list_tabs":occupied?"wait_for_owner":draining?"wait_for_drain":"ensure_session";
  const expiresAt=valid?Math.min(l.expiresAt,remote.expiresAt):current?.expiresAt || null;
  return {tabId,connected:healthy(),verified,observedAt:now,instanceId,connectionGeneration,
    versions:{bridge:VERSION,extension:extInfo?.version || null,expectedExtension:EXTENSION_VERSION,
      extensionMatches:extInfo?.version===EXTENSION_VERSION},
    tab:verified?snapshot.tab:null,tabGeneration:verified?snapshot.tab?.generation || null:null,
    controlGeneration:current?.id || null,
    currentOwner:currentOwner?{id:createHash("sha256").update(currentOwner).digest("hex").slice(0,16),
      agentName:current.agentName || current.name,isCurrentTask:currentOwner===owner}:null,
    sessionId:l?.owner===owner?l.id:null,state:valid?"active":reason,reason,
    expiresAt,remainingLeaseMs:expiresAt?Math.max(0,expiresAt-now):0,idleExpiresAt:l?l.lastActivity+controls.idleMs:null,
    canRead:valid,canWrite:valid,capabilityScope:"tab_control",reacquireAllowed,
    recovery:{action,tool:action==="ensure_session"?"browser_ensure_session":action==="list_tabs"?"browser_tabs":null,
      automaticRetryAllowed:false}};
}
function recoveryDetails(code,tabId,owner,state,requestId,confirmation) {
  const control=Number.isInteger(tabId) && owner?sessionView(tabId,owner,undefined,confirmation):null;
  return {...(control?{session:control}:{}),recovery:state==="unknown"?
    {action:"inspect_request_and_page",tool:"browser_request_status",requestId,automaticRetryAllowed:false,
      message:"先查询此请求并核验页面结果；未找到记录也不能认定未执行，勿换 requestId 重放写操作。"}:
    control?.recovery || {action:"check_status",tool:"browser_status",automaticRetryAllowed:false}};
}
async function describeFailure(code,tabId,owner,state,requestId) {
  let confirmation;
  if(Number.isInteger(tabId) && owner && supportsSessions() &&
    /^(CONTROL_|SESSION_|TAB_OCCUPIED|TAB_NOT_FOUND)/.test(code || "")) {
    try {confirmation=await syncControl({tabId,owner},"inspect");}catch{/* Unverified state stays explicitly non-writable. */}
  }
  return recoveryDetails(code,tabId,owner,state,requestId,confirmation);
}
function publicRecord(r) {
  const result=r.result?.dataUrl?{tabId:r.result.tabId,imageAvailable:true}:r.result;
  const serialized=result===undefined?"":JSON.stringify(result);
  return {requestId:r.id,state:r.state,createdAt:r.createdAt,updatedAt:r.updatedAt,deadline:r.deadline,
    ...(r.state==="unknown"?recoveryDetails(r.code,r.tabId,r.owner,r.state,r.id):{}),
    ...(r.error?{error:r.error,code:r.code}:{}),
    ...(serialized.length>16000?{resultPreview:serialized.slice(0,16000),truncated:true}:{result})};
}
async function session(body,owner,name) {
  controls.assertOwner(owner);
  if(["status","ensure"].includes(body.action)) {
    if(!Number.isInteger(body.tabId) || body.tabId<0)throw error("INVALID_ARGUMENT","tabId 必填");
    if(!supportsSessions())return sessionView(body.tabId,owner,body.sessionId);
    if(body.action==="status") {
      controls.sweep();
      const reply=await syncControl({tabId:body.tabId,owner,name},"inspect");
      return sessionView(body.tabId,owner,body.sessionId,reply);
    }
    const l=await controls.ensure(body.tabId,owner,name);
    return sessionView(body.tabId,owner,undefined,l.confirmation);
  }
  if(body.action==="acquire") {
    if(!Number.isInteger(body.tabId) || body.tabId<0)throw error("INVALID_ARGUMENT","tabId 必填");
    const l=controls.admit(body.tabId,owner,name,body.sessionId);
    await controls.confirm(l,owner);return controls.public(l);
  }
  if(body.action==="renew")return {renewed:await controls.renew(owner,body.sessionIds || [body.sessionId])};
  if(body.action==="release")return controls.release(owner,body.sessionId);
  throw error("INVALID_ARGUMENT","未知控制会话操作");
}
function bounded(value,fallback,min,max) {
  if(value===undefined || value===null || value==="") return fallback;
  const n=Number(value);
  if(!Number.isInteger(n) || n<min || n>max) throw error("INVALID_ARGUMENT","数值范围 "+min+".."+max);
  return n;
}
function readBody(req) {
  return new Promise((resolve,reject)=>{
    const chunks=[];let size=0;
    req.on("data",chunk=>{size+=chunk.length;if(size>2*1024*1024){reject(error("BODY_TOO_LARGE","请求体过大",413));req.destroy();}else chunks.push(chunk);});
    req.on("end",()=>{try{resolve(chunks.length?JSON.parse(Buffer.concat(chunks).toString("utf8")):{});}catch{reject(error("INVALID_JSON","请求体不是 JSON"));}});
    req.on("error",reject);req.on("aborted",()=>reject(error("CANCELLED","请求中断",499)));
  });
}
function sendJson(res,status,obj) {
  if(res.destroyed || res.writableEnded) return;
  const text=JSON.stringify(obj);res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Content-Length":Buffer.byteLength(text)});res.end(text);
}
const TEST_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>DSH Bridge 测试页</title>
<style>
body{font-family:system-ui,"Microsoft YaHei",sans-serif;max-width:560px;margin:60px auto;padding:0 16px;color:#1f2937}
h1{font-size:20px}
input,button{font-size:15px;padding:8px 10px;border-radius:8px;border:1px solid #d1d5db}
button{margin-left:8px;background:#0d6efd;color:#fff;border:none;cursor:pointer}
#result{margin-top:16px;font-size:15px;color:#059669;font-weight:600}
.spacer{height:900px}
</style>
</head>
<body>
<h1>DSH Bridge 测试页</h1>
<p>此页面由桥接服务内置，用于验证“读取 / 点击 / 输入 / 按键 / 等待 / 截图 / 滚动”能力。</p>
<input id="box" placeholder="在这里输入文字">
<button id="btn">GO</button>
<div id="result">（尚未点击）</div>
<script>
document.getElementById("btn").onclick = function () {
  var v = document.getElementById("box").value;
  document.getElementById("result").textContent = v ? ("clicked: " + v) : "clicked: (空输入)";
};
document.getElementById("box").onkeydown = function (e) {
  if (e.key === "Enter") document.getElementById("result").textContent = "enter: " + this.value;
};
</script>
<div class="spacer"></div>
</body>
</html>`;
const server=http.createServer(async(req,res)=>{
  let requestOwner,requestTab;
  try {
    if(TOKEN && req.headers.authorization!=="Bearer "+TOKEN) throw error("UNAUTHORIZED","访问令牌无效",401);
    const url=new URL(req.url,"http://127.0.0.1");
    if(req.method==="GET" && url.pathname==="/test") {res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});res.end(TEST_HTML);return;}
    if(req.method==="GET" && (url.pathname==="/" || url.pathname==="/api/status")) return sendJson(res,200,statusJson());
    const owner=req.headers["x-dsh-owner"];
    requestOwner=owner;
    let ownerName;try{ownerName=decodeURIComponent(req.headers["x-dsh-agent-name"] || "Agent");}catch{throw error("INVALID_ARGUMENT","agent name 编码错误");}
    if(req.method==="GET" && url.pathname.startsWith("/api/requests/")) {
      cleanup();const r=records.get(decodeURIComponent(url.pathname.slice(14)));
      if(!r) throw error("REQUEST_NOT_FOUND","请求记录不存在或已过期；服务重启会清空记录，不能据此认定未执行",404);
      if(r.owner && r.owner!==owner)throw error("OWNER_MISMATCH","请求记录不属于当前任务",403);
      return sendJson(res,200,publicRecord(r));
    }
    const body=await readBody(req);
    requestTab=body?.tabId;
    if(req.method==="POST" && url.pathname==="/api/sessions") return sendJson(res,200,await session(body,owner,ownerName));
    let action,tabId;
    if(url.pathname==="/api/tabs") action=req.method==="GET"?"listTabs":req.method==="POST"?"open":null;
    else if(url.pathname==="/api/tabs/active" && req.method==="GET") action="getActive";
    else {
      const m=/^\/api\/tabs\/(\d+)(?:\/([a-z]+))?$/.exec(url.pathname);
      if(m) {
        tabId=Number(m[1]);
        action=!m[2]&&req.method==="DELETE"?"close":({content:"readPage"})[m[2]] || m[2];
        const getActions=["readPage","extract","screenshot","frames"];
        if(action!=="close" && req.method!==(getActions.includes(action)?"GET":"POST")) action=null;
      }
    }
    if(!ACTIONS.has(action)) throw error("NOT_FOUND","未知接口",404);
    requestTab=tabId;
    if(!body || typeof body!=="object" || Array.isArray(body)) throw error("INVALID_ARGUMENT","body 必须是对象");
    const params={...body,...Object.fromEntries(url.searchParams),...(tabId!==undefined?{tabId}:{})};
    delete params.action;
    for(const key of ["frameId","offset","limit","max","maxText","maxHtml","timeout","index","windowId"])
      if(params[key]!==undefined) params[key]=bounded(params[key],undefined,0,key==="windowId"||key==="frameId"?2147483647:10000000);
    const deadline=bounded(req.headers["x-dsh-deadline"],Date.now()+60000,1,Number.MAX_SAFE_INTEGER);
    const effectiveDeadline=Math.min(deadline,Date.now()+120000);
    const requestId=req.headers["x-dsh-request-id"] || randomUUID();
    if(typeof requestId!=="string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) throw error("INVALID_REQUEST_ID","非法 request id");
    const sessionId=req.headers["x-dsh-session"] || "";
    const signature=createHash("sha256").update(JSON.stringify([req.method,url.pathname,params,sessionId,owner])).digest("hex");
    cleanup();
    if(!["listTabs","getActive","ping"].includes(action))controls.assertOwner(owner);
    if((action==="open" || tabId!==undefined) && extInfo?.protocolVersion!==3)throw error("EXTENSION_UPGRADE_REQUIRED","需要协议 3 扩展，请在 Chrome 中重载",409);
    let record=records.get(requestId);
    if(record) {
      if(record.signature!==signature) throw error("REQUEST_ID_CONFLICT","同一请求 id 对应不同操作",409);
      await record.promise;
    } else {
      if(records.size>=1000) {
        const terminal=[...records].find(([,v])=>!["queued","dispatched"].includes(v.state));
        if(terminal) records.delete(terminal[0]);else throw error("QUEUE_FULL","请求记录已满",429);
      }
      // Acquire/check before enqueue. A competing request is rejected here and
      // cannot wait for release and unexpectedly execute later.
      const lease=tabId===undefined?null:controls.admit(tabId,owner,ownerName,sessionId);
      if(lease)lease.pending++;
      const controller=new AbortController();
      const ctx={deadline:effectiveDeadline,signal:controller.signal,dispatched:false,tabId,sessionId,owner,ownerName,lease};
      record={id:requestId,signature,action,tabId,owner,leaseId:lease?.id,controller,createdAt:Date.now(),updatedAt:Date.now(),deadline:effectiveDeadline,state:"queued"};
      records.set(requestId,record);ctx.record=record;
      // Response close means the caller no longer wants a queued operation.
      res.on("close",()=>{if(!res.writableEnded) controller.abort();});
      const timeout=setTimeout(()=>controller.abort(),Math.max(1,effectiveDeadline-Date.now()));
      const task=()=>action==="batch"?batch(params,ctx):perform(action,params,ctx);
      record.promise=Promise.resolve(lease?.ready).then(()=>WRITE_ACTIONS.has(action)?enqueueWrite(task,ctx):task())
        .then(result=>{
          record.result=result;
          record.state=result?.ok===false?(result.state || "failed"):"succeeded";
          record.httpStatus=result?.ok===false?422:200;
        },err=>{
          record.error=err.message;record.code=err.code || "BRIDGE_ERROR";
          record.state=!err.definitive&&ctx.dispatched?"unknown":err.code==="CANCELLED"?"cancelled":"failed";
          record.httpStatus=err.statusCode || 502;
        }).finally(()=>{
          clearTimeout(timeout);record.updatedAt=Date.now();
          if(lease){lease.pending--;lease.lastActivity=Date.now();}
          if(record.state==="unknown" && lease)void controls.revoke(lease,"unknown_result");
        });
      await record.promise;
    }
    const data=record.error?{error:record.error,code:record.code,state:record.state,requestId,
      ...await describeFailure(record.code,tabId,owner,record.state,requestId)}:
      Array.isArray(record.result)?record.result:{...record.result,requestId};
    if(data?.ok===false)Object.assign(data,await describeFailure(data.code,tabId,owner,data.state,requestId));
    res.setHeader("X-DSH-Request-Id",requestId);
    sendJson(res,record.httpStatus || 200,data);
  } catch(err) {sendJson(res,err.statusCode || 500,{error:err.message,code:err.code || "BRIDGE_ERROR",
    ...await describeFailure(err.code,requestTab,requestOwner)});}
});
server.on("upgrade",(req,socket,head)=>{
  const url=new URL(req.url,"http://127.0.0.1");
  if(url.pathname!=="/ws" || (TOKEN && url.searchParams.get("token")!==TOKEN)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");socket.destroy();return;
  }
  wss.handleUpgrade(req,socket,head,sock=>wss.emit("connection",sock,req));
});
server.on("error",err=>{log("启动失败",err.message);process.exitCode=1;});
server.listen(PORT,HOST,()=>log("ready","http://"+HOST+":"+PORT,"version",VERSION));
