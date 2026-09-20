import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createRequire} from "node:module";
import net from "node:net";
import http from "node:http";
import {once} from "node:events";
import {fileURLToPath} from "node:url";
import {BridgeClient,manifest,resolveBridgeDir} from "../lib/runtime.js";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {apply} from "../lib/index.js";
const dir=resolveBridgeDir(process.env.DSH_BROWSER_BRIDGE_DIR);
assert.ok(dir,"Set DSH_BROWSER_BRIDGE_DIR");
const {WebSocket}=createRequire(dir+"/bridge.js")("ws");
let child,socket,base,port;
const calls=[],localControls=new Map(),running=new Map(),blocked=new Map();
const A="owner-A-000000000000",B="owner-B-000000000000";
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function attach() {
  const sock=new WebSocket(base.replace("http:","ws:")+"/ws");
  await once(sock,"open");
  sock.send(JSON.stringify({type:"hello",info:{version:"1.5.0",protocolVersion:3,capabilities:["atomic-session-v1"]},controls:[...localControls.values()],
    blocked:[...blocked].map(([tabId,owners])=>({tabId,owners:[...owners]}))}));
  sock.on("message",raw=>{
    const message=JSON.parse(raw);
    if(message.type==="ping"){sock.send(JSON.stringify({type:"pong",t:message.t}));return;}
    if(message.type==="control") {
      const l=message.lease;
      const snapshot=()=>({tab:l.tabId===404?null:{id:l.tabId,url:"https://fixture.test/",title:"Fixture",generation:"fixture-generation-"+l.tabId},
        control:localControls.get(l.tabId) || null,blocked:!!blocked.get(l.tabId)?.has(l.owner),running:running.has(l.tabId)?1:0});
      if(message.action==="inspect") {
        sock.send(JSON.stringify({type:"controlAck",id:message.id,ok:true,snapshot:snapshot()}));return;
      }
      if(message.action==="revoke") {
        const existing=localControls.get(l.tabId);if(existing)existing.state="stopping";
        const drained=!running.has(l.tabId);
        if(drained)localControls.delete(l.tabId);
        sock.send(JSON.stringify({type:"controlAck",id:message.id,ok:true,drained}));return;
      }
      if(blocked.get(l.tabId)?.has(l.owner)) {sock.send(JSON.stringify({type:"controlAck",id:message.id,ok:false,error:"CONTROL_STOPPED"}));return;}
      const existing=localControls.get(l.tabId);
      if(message.action==="renew" && (!existing || existing.expiresAt<=Date.now())) {
        sock.send(JSON.stringify({type:"controlAck",id:message.id,ok:false,error:"CONTROL_REVOKED"}));return;
      }
      if(existing && existing.id!==l.id){sock.send(JSON.stringify({type:"controlAck",id:message.id,ok:false,error:"TAB_OCCUPIED"}));return;}
      localControls.set(l.tabId,{...l,state:"active"});
      sock.send(JSON.stringify({type:"controlAck",id:message.id,ok:true,drained:false,snapshot:snapshot()}));return;
    }
    if(message.type!=="command")return;
    const c=message.command;calls.push(c);
    if(c.tabId!==undefined){
      const l=localControls.get(c.tabId);assert.equal(l?.id,message.leaseId);assert.equal(l?.owner,message.owner);
      running.set(c.tabId,message.leaseId);
    }
    let data={ok:true};
    if(c.action==="listTabs")data=[{id:1,title:"Fixture",url:"https://fixture.test/",active:false}];
    if(c.action==="open")data={id:99,url:c.url,active:c.active};
    if(c.action==="click")data={clicked:true};
    if(c.action==="wait")data={found:c.selector!=="#missing"};
    if(c.action==="type")data={typed:true,verified:true,length:c.text?.length};
    if(c.action==="extract")data={items:[{tag:"A",text:"Result",href:"https://example.com/"}],totalCount:1,returnedCount:1};
    if(c.action==="evaluate")data={ok:true,json:"42"};
    if(c.action==="close"){sock.send(JSON.stringify({type:"tabClosed",tabId:c.tabId}));data={closed:c.tabId};}
    if(c.action==="screenshot")data={dataUrl:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII="};
    setTimeout(()=>{
      running.delete(c.tabId);
      if(sock.readyState===1)sock.send(JSON.stringify({type:"response",id:message.id,ok:true,data}));
      const l=localControls.get(c.tabId);
      if(l?.state==="stopping") {
        localControls.delete(c.tabId);
        if(socket.readyState===1)socket.send(JSON.stringify({type:"controlDrained",tabId:c.tabId,leaseId:l.id}));
      }
    },c.selector==="#hold"?250:0);
  });
  await pause(10);return sock;
}
before(async()=>{
  const temp=net.createServer();temp.listen(0,"127.0.0.1");await once(temp,"listening");port=temp.address().port;await new Promise(r=>temp.close(r));
  base="http://127.0.0.1:"+port;
  child=spawn(process.execPath,["bridge.js"],{cwd:dir,windowsHide:true,env:{...process.env,DSH_BRIDGE_PORT:String(port),DSH_BRIDGE_TOKEN:"",DSH_BRIDGE_WAIT:"300",DSH_BRIDGE_TIMEOUT:"500"},stdio:"pipe"});
  child.stdout.resume();child.stderr.resume();
  for(let i=0;i<50;i++){try{if((await fetch(base+"/api/status")).ok)break;}catch{}await pause(30);}
  socket=await attach();
});
after(async()=>{socket?.close();if(child){child.kill();await once(child,"exit");}});
async function api(path,body,headers={},method=body===undefined?"GET":"POST",signal) {
  const res=await fetch(base+path,{method,headers:{"Content-Type":"application/json","X-DSH-Owner":A,...headers},body:body===undefined?undefined:JSON.stringify(body),signal});
  return {status:res.status,data:await res.json()};
}
test("raw requests cannot bypass mandatory ownership",async()=>{
  const r=await api("/api/tabs/10/click",{selector:"#no"},{"X-DSH-Owner":""});
  assert.equal(r.status,409);assert.equal(r.data.code,"AGENT_ID_REQUIRED");assert.equal(calls.some(c=>c.tabId===10),false);
});
test("competing owner fails immediately during a busy queue and cannot execute after release",async()=>{
  const first=api("/api/tabs/11/click",{selector:"#hold"});
  await pause(30);const start=Date.now();
  const other=await api("/api/tabs/11/click",{selector:"#other"},{"X-DSH-Owner":B});
  assert.equal(other.status,409);assert.equal(other.data.code,"TAB_OCCUPIED");assert.ok(Date.now()-start<180);
  await first;assert.equal(calls.some(c=>c.selector==="#other"),false);
});
test("duplicate request is not replayed; request id and status are owner bound",async()=>{
  const head={"X-DSH-Request-Id":"dedupe"};
  const first=await api("/api/tabs/12/click",{selector:"#once"},head);
  const second=await api("/api/tabs/12/click",{selector:"#once"},head);
  assert.equal(first.status,200);assert.deepEqual(first.data,second.data);
  assert.equal(calls.filter(c=>c.selector==="#once").length,1);
  assert.equal((await api("/api/tabs/12/click",{selector:"#different"},head)).status,409);
  assert.equal((await api("/api/requests/dedupe",undefined,{"X-DSH-Owner":B})).status,403);
});
test("cancelled and expired queued clicks never reach extension",async()=>{
  const blocker=api("/api/tabs/13/click",{selector:"#hold"});await pause(25);
  const abort=new AbortController();
  const cancelled=api("/api/tabs/13/click",{selector:"#cancelled"},{"X-DSH-Request-Id":"cancelled"},"POST",abort.signal).catch(()=>{});
  const expired=api("/api/tabs/13/click",{selector:"#expired"},{"X-DSH-Deadline":String(Date.now()+30)});
  await pause(30);abort.abort();await cancelled;await blocker;
  assert.notEqual((await expired).status,200);assert.equal(calls.some(c=>["#expired","#cancelled"].includes(c.selector)),false);
});
test("manual stop cancels queued work, blocks old owner, and waits for in-flight drain",async()=>{
  const first=api("/api/tabs/14/click",{selector:"#hold"});await pause(25);
  const queued=api("/api/tabs/14/click",{selector:"#after-stop"});await pause(20);
  const l=localControls.get(14);blocked.set(14,new Set([A]));l.state="stopping";
  socket.send(JSON.stringify({type:"userStop",tabId:14,leaseId:l.id}));
  await pause(20);
  assert.equal((await api("/api/tabs/14/click",{selector:"#B"},{"X-DSH-Owner":B})).status,409);
  assert.notEqual((await first).status,200);assert.notEqual((await queued).status,200);
  await pause(280);
  assert.equal(calls.some(c=>c.selector==="#after-stop"),false);
  assert.equal((await api("/api/tabs/14/click",{selector:"#A-again"})).data.code,"CONTROL_STOPPED");
  assert.equal((await api("/api/tabs/14/click",{selector:"#B"},{"X-DSH-Owner":B})).status,200);
});
test("eval uses write queue; batch stops at failed condition",async()=>{
  const first=api("/api/tabs/15/click",{selector:"#hold"});await pause(20);
  const second=api("/api/tabs/15/evaluate",{expression:"42"});
  await pause(30);assert.equal(calls.some(c=>c.tabId===15&&c.action==="evaluate"),false);
  await Promise.all([first,second]);
  const r=await api("/api/tabs/15/batch",{steps:[{action:"type",selector:"#box",text:"x"},{action:"wait",selector:"#missing"},{action:"click",selector:"#never"}]});
  assert.equal(r.status,422);assert.equal(r.data.failedStep,1);assert.equal(calls.some(c=>c.selector==="#never"),false);
});
test("connection replacement quarantines dispatched write until the old operation settles",async()=>{
  const request=api("/api/tabs/16/click",{selector:"#hold"},{"X-DSH-Request-Id":"lost"});
  await pause(30);const old=socket;socket=await attach();old.close();
  const response=await request;assert.equal(response.status,503);assert.equal(response.data.state,"unknown");
  assert.equal((await api("/api/tabs/16/click",{selector:"#early"},{"X-DSH-Owner":B})).status,409);
  await pause(300);assert.equal((await api("/api/tabs/16/click",{selector:"#recovered"},{"X-DSH-Owner":B})).status,200);
});
test("MCP enforces task identity even when two agents share one connection",async()=>{
  const client=new Client({name:"bridge-test",version:"1"});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL("../examples/mcp-server.mjs",import.meta.url))],
    env:{...process.env,DSH_BRIDGE_URL:base,DSH_BRIDGE_AUTOSTART:"false",DSH_AGENT_ID:""},stderr:"pipe"});
  try {
    await client.connect(transport);const list=await client.listTools();assert.equal(list.tools.length,manifest.tools.length);
    for(const spec of manifest.tools)assert.deepEqual(Object.keys(list.tools.find(t=>t.name===spec.name).inputSchema.properties).sort(),Object.keys(spec.inputSchema.properties).sort());
    const missing=await client.callTool({name:"browser_click",arguments:{tabId:17,selector:"#button"}});
    assert.equal(missing.isError,true);assert.match(missing.content[0].text,/AGENT_ID_REQUIRED/);
    const a=await client.callTool({name:"browser_click",arguments:{tabId:17,selector:"#button",agentId:"task-A"}});
    assert.notEqual(a.isError,true);
    const status=await client.callTool({name:"browser_session_status",arguments:{tabId:17,agentId:"task-A"}});
    const observed=JSON.parse(status.content[0].text);
    assert.equal(observed.canWrite,true);assert.equal(observed.versions.adapter,"1.5.0");
    const ensured=await client.callTool({name:"browser_ensure_session",arguments:{tabId:17,agentId:"task-A"}});
    assert.equal(JSON.parse(ensured.content[0].text).sessionId,observed.sessionId);
    const b=await client.callTool({name:"browser_click",arguments:{tabId:17,selector:"#button",agentId:"task-B"}});
    assert.equal(b.isError,true);assert.match(b.content[0].text,/TAB_OCCUPIED/);
    const shot=await client.callTool({name:"browser_screenshot",arguments:{tabId:17,agentId:"task-A"}});
    assert.equal(shot.content[0].type,"image");
    const waited=await client.callTool({name:"browser_wait",arguments:{tabId:17,agentId:"task-A",selector:"#missing",timeout:1}});
    assert.equal(waited.isError,true);assert.match(waited.content[0].text,/WAIT_TIMEOUT/);
  }finally{await client.close();}
});
test("DSH agent context isolates tasks despite conflicting caller-provided labels",async()=>{
  const registered=[],dispose=[];
  apply({tools:{register:t=>registered.push(t)},on:(_name,fn)=>dispose.push(fn)},{port,autoStart:false,requestTimeoutMs:60000});
  const a={},b={};
  try {
    const click=registered.find(t=>t.name==="browser_click");
    await click.execute({tabId:18,selector:"#button",agentId:"same-label"},{agent:a});
    await assert.rejects(click.execute({tabId:18,selector:"#button",agentId:"same-label"},{agent:b}),/TAB_OCCUPIED/);
    await click.execute({tabId:18,selector:"#button"},{agent:a});
  }finally{for(const fn of dispose)await fn();}
});
test("automatic claim holds between calls and explicit release lets another task acquire",async()=>{
  const client=new BridgeClient({url:base,autoStart:false});
  try{
    await client.run("browser_click",{tabId:19,selector:"#button",agentId:"A"});
    await assert.rejects(client.run("browser_extract",{tabId:19,selector:"title",agentId:"B"}),/TAB_OCCUPIED/);
    const identity=client.identity("A");const l=client.claims.get(identity.owner+":19");
    await client.run("browser_session",{action:"release",sessionId:l.sessionId,agentId:"A"});
    await pause(30);
    await client.run("browser_extract",{tabId:19,selector:"title",agentId:"B"});
  }finally{await client.releaseControls();client.close();}
});
test("tabClosed notification does not cancel the close request that caused it",async()=>{
  const result=await api("/api/tabs/20",{},{},"DELETE");
  assert.equal(result.status,200);assert.equal(result.data.closed,20);
});

test("session status is a verified read; ensure atomically acquires, renews and rejects competitors",async()=>{
  const unused=await api("/api/sessions",{action:"status",tabId:30});
  assert.equal(unused.data.verified,true);assert.equal(unused.data.canWrite,false);
  assert.equal(unused.data.reacquireAllowed,true);assert.equal(localControls.has(30),false);
  const first=await api("/api/sessions",{action:"ensure",tabId:30});
  assert.equal(first.data.canWrite,true);assert.equal(first.data.currentOwner.isCurrentTask,true);
  assert.equal(first.data.tabGeneration,"fixture-generation-30");assert.ok(first.data.remainingLeaseMs>59000);
  assert.equal(JSON.stringify(first.data).includes(A),false);
  const expiry=localControls.get(30).expiresAt;
  const status=await api("/api/sessions",{action:"status",tabId:30,sessionId:first.data.sessionId});
  assert.equal(status.data.canRead,true);assert.equal(localControls.get(30).expiresAt,expiry);
  const stale=await api("/api/sessions",{action:"status",tabId:30,sessionId:"stale"});
  assert.equal(stale.data.canWrite,false);assert.equal(stale.data.reason,"SESSION_EXPIRED");
  const competitor=await api("/api/sessions",{action:"ensure",tabId:30},{"X-DSH-Owner":B});
  assert.equal(competitor.status,409);assert.equal(competitor.data.code,"TAB_OCCUPIED");
  assert.equal(competitor.data.session.currentOwner.isCurrentTask,false);
  assert.equal(competitor.data.recovery.action,"wait_for_owner");
  assert.equal(competitor.data.session.verified,true);
  assert.equal(competitor.data.session.tabGeneration,"fixture-generation-30");
  const renewed=await api("/api/sessions",{action:"ensure",tabId:30});
  assert.equal(renewed.data.sessionId,first.data.sessionId);
  const missing=await api("/api/sessions",{action:"status",tabId:404});
  assert.equal(missing.data.reason,"TAB_NOT_FOUND");assert.equal(missing.data.canWrite,false);
});

test("stale client cache recovers a drained lease before clicking exactly once",async()=>{
  const client=new BridgeClient({url:base,autoStart:false});
  try {
    const first=await client.run("browser_ensure_session",{tabId:31,agentId:"resume"});
    localControls.delete(31); // Browser expired first; bridge still believes its lease is active.
    const stale=await client.run("browser_session_status",{tabId:31,agentId:"resume"});
    assert.equal(stale.data.connected,true);assert.equal(stale.data.canWrite,false);
    await client.run("browser_click",{tabId:31,agentId:"resume",selector:"#resume-once"});
    assert.notEqual(localControls.get(31).id,first.data.sessionId);
    assert.equal(calls.filter(c=>c.selector==="#resume-once").length,1);
    await assert.rejects(client.run("browser_click",{tabId:31,agentId:"resume",sessionId:first.data.sessionId,selector:"#stale-never"}),/SESSION_EXPIRED/);
    assert.equal(calls.some(c=>c.selector==="#stale-never"),false);
  }finally{await client.releaseControls();client.close();}
});

test("ensure never bypasses user stop or an unresolved operation",async()=>{
  const first=api("/api/tabs/32/click",{selector:"#hold"});await pause(30);
  const l=localControls.get(32);l.state="stopping";blocked.set(32,new Set([A]));
  socket.send(JSON.stringify({type:"userStop",tabId:32,leaseId:l.id}));await pause(20);
  const other=await api("/api/sessions",{action:"ensure",tabId:32},{"X-DSH-Owner":B});
  assert.equal(other.status,409);assert.equal(other.data.session.canWrite,false);
  const result=await first;
  assert.equal(result.data.state,"unknown");assert.equal(result.data.recovery.action,"inspect_request_and_page");
  assert.equal(result.data.recovery.automaticRetryAllowed,false);
  await pause(280);
  const stopped=await api("/api/sessions",{action:"ensure",tabId:32});
  assert.equal(stopped.data.code,"CONTROL_STOPPED");assert.equal(stopped.data.recovery.action,"user_allow_control");
});

test("an old live bridge is diagnosed and receives no page commands",async()=>{
  const received=[];
  const legacy=http.createServer((req,res)=>{
    received.push(req.url);req.resume();res.setHeader("Content-Type","application/json");
    if(req.url==="/api/status")return res.end(JSON.stringify({ok:true,connected:true,version:"1.3.0",protocolVersion:3,extension:{version:"1.2.0",protocolVersion:3}}));
    res.statusCode=400;res.end(JSON.stringify({code:"INVALID_ARGUMENT",error:"未知控制会话操作"}));
  });
  legacy.listen(0,"127.0.0.1");await once(legacy,"listening");
  const client=new BridgeClient({url:"http://127.0.0.1:"+legacy.address().port,autoStart:false});
  try {
    const status=await client.run("browser_session_status",{tabId:1,agentId:"upgrade"});
    assert.equal(status.data.canWrite,false);assert.equal(status.data.reason,"UPGRADE_REQUIRED");
    assert.equal(status.data.versions.bridge,"1.3.0");assert.equal(status.data.versions.adapter,"1.5.0");
    await assert.rejects(client.run("browser_click",{tabId:1,agentId:"upgrade",selector:"#never"}),/UPGRADE_REQUIRED/);
    assert.equal(received.some(path=>path.includes("/api/tabs/")),false);
  }finally{client.close();await new Promise(resolve=>legacy.close(resolve));}
});

test("old extension and disconnected transport report non-writable diagnostic state",async()=>{
  socket.send(JSON.stringify({type:"hello",info:{version:"1.2.0",protocolVersion:3},controls:[]}));await pause(20);
  const old=await api("/api/sessions",{action:"status",tabId:30});
  assert.equal(old.data.canWrite,false);assert.equal(old.data.reason,"UPGRADE_REQUIRED");
  assert.equal(old.data.recovery.action,"reload_extension");
  socket.close();await once(socket,"close");await pause(20);
  const offline=await api("/api/sessions",{action:"status",tabId:30});
  assert.equal(offline.data.connected,false);assert.equal(offline.data.canWrite,false);
  assert.equal(offline.data.recovery.action,"reconnect_extension");
});
