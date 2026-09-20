import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {webcrypto} from "node:crypto";
const source=readFileSync(new URL("../extension/control.js",import.meta.url),"utf8");
function setup(saved={}) {
  const messages=[],storage=[],ui=[];
  const context={
    chrome:{storage:{session:{get:async defaults=>({...defaults,...saved}),set:async value=>storage.push(value)}},
      tabs:{get:async id=>({id})},action:{setBadgeText:async info=>ui.push(info),setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},
      scripting:{executeScript:async()=>[{documentId:"current",frameId:0}]}},
    ws:{readyState:1},WebSocket:{OPEN:1},send:(_sock,msg)=>messages.push(msg),console,crypto:webcrypto,
  };
  vm.createContext(context);vm.runInContext(source,context);
  const get=expr=>vm.runInContext(expr,context);
  return {...context,context,messages,storage,ui,get,
    ready:()=>get("controlReady"),control:(action,lease)=>context.handleControl(context.ws,{id:"rpc",action,lease,instanceId:"bridge"})};
}
const lease={id:"lease-A",tabId:1,owner:"owner-A",agentName:"Task A",expiresAt:Date.now()+120000,state:"active"};
test("grant installs badge; competing/stale lease cannot replace active ownership",async()=>{
  const e=setup();await e.ready();await e.control("grant",lease);
  assert.equal(e.get("tabControls.get(1).id"),lease.id);assert.equal(e.ui.at(-1).text,"AI");
  await e.control("grant",{...lease,id:"lease-B",owner:"owner-B"});
  assert.equal(e.messages.at(-1).ok,false);assert.equal(e.get("tabControls.get(1).id"),lease.id);
  assert.throws(()=>e.context.ownsCommand({command:{tabId:1,action:"click"},owner:"owner-B",leaseId:lease.id}),/CONTROL_REVOKED/);
});
test("offline user stop persists blocked owner and rejects later re-grant",async()=>{
  const e=setup();await e.ready();await e.control("grant",lease);
  e.context.ws=null;await e.context.revokeLocal(1,"user_stopped",true);
  assert.equal(e.get("tabControls.has(1)"),false);
  assert.equal(e.get("blockedOwners.get(1).has('owner-A')"),true);
  const saved=e.storage.at(-1);assert.ok(saved.dshBlocked.some(b=>b.owners.includes("owner-A")));
  await e.control("grant",lease);assert.equal(e.messages.at(-1).ok,false);
  assert.match(e.messages.at(-1).error,/CONTROL_STOPPED/);
});
test("stop waits for in-flight work, even after lease expiry; terminal notification frees it",async()=>{
  const e=setup();await e.ready();await e.control("grant",lease);
  e.get("runningControls.set('operation',{id:'operation',tabId:1,leaseId:'lease-A',documentId:'old'})");
  await e.context.revokeLocal(1,"user_stopped",true);
  assert.equal(e.get("tabControls.get(1).state"),"stopping");
  assert.equal(await e.context.finishControl(1,lease.id),false);
  assert.throws(()=>e.context.ownsCommand({command:{tabId:1,action:"click"},owner:lease.owner,leaseId:lease.id}),/CONTROL_REVOKED/);
  e.get("runningControls.delete('operation')");
  assert.equal(await e.context.finishControl(1,lease.id),true);
  assert.equal(e.messages.at(-1).type,"controlDrained");
});
test("worker restart retains unresolved scripts; document replacement permits recovery",async()=>{
  const e=setup({dshControls:[lease],dshRunning:[{id:"lost",tabId:1,leaseId:lease.id,documentId:"old",frameId:0}]});
  await e.ready();assert.equal(e.get("tabControls.get(1).state"),"stopping");
  await e.context.documentChanged(1);
  assert.equal(e.get("runningControls.size"),0);assert.equal(e.get("tabControls.has(1)"),false);
});
test("banner uses closed shadow, trusted clicks, top frame only, and no page-visible control token",()=>{
  assert.match(source,/attachShadow\(\{mode:"closed"\}\)/);
  assert.match(source,/if\(!event\.isTrusted\)return/);
  assert.match(source,/if\(window!==window\.top\)return/);
  assert.doesNotMatch(source,/setAttribute\([^)]*(?:sessionId|owner)/);
});
test("user-stop runtime handler accepts extension UI senders and rejects foreign senders",async()=>{
  let listener;const e=setup();await e.ready();
  const event={addListener(){}};
  Object.assign(e.context.chrome,{
    alarms:{create(){},onAlarm:event},
    tabs:{...e.context.chrome.tabs,onUpdated:event,onRemoved:event},
    runtime:{id:"bridge-extension",getManifest:()=>({name:"DSH",version:"1.2.0"}),
      getURL:path=>"chrome-extension://bridge-extension/"+path,
      onMessage:{addListener:fn=>{listener=fn;}}},
  });
  e.context.chrome.storage.local={get:async()=>({wsUrl:"ws://127.0.0.1:8765/ws"})};
  e.context.importScripts=()=>{};
  e.context.setInterval=()=>1;e.context.clearInterval=()=>{};e.context.setTimeout=()=>1;e.context.clearTimeout=()=>{};
  e.context.WebSocket=class {static OPEN=1;static CONNECTING=0;readyState=0;close(){}send(){}};
  // Background's lexical ws shadows the test global; this is deliberately offline.
  delete e.context.ws;delete e.context.send;
  vm.runInContext(readFileSync(new URL("../extension/background.js",import.meta.url),"utf8"),e.context);
  await e.control("grant",lease);
  listener({type:"dsb-stop-control",tabId:1},{id:"another-extension",url:"https://untrusted.test/"},()=>{});
  assert.equal(e.get("tabControls.get(1).state"),"active");
  const response=await new Promise(resolve=>listener({type:"dsb-stop-control",tabId:1},
    {id:"bridge-extension",url:"chrome-extension://bridge-extension/popup.html"},resolve));
  assert.equal(response.ok,true);
  assert.equal(e.get("blockedOwners.get(1).has('owner-A')"),true);
  assert.equal(e.get("tabControls.has(1)"),false);
});

test("session inspection does not grant or renew; expired controls cannot be renewed back to life",async()=>{
  const e=setup();await e.ready();
  await e.control("inspect",lease);
  assert.equal(e.messages.at(-1).snapshot.control,null);
  assert.equal(e.get("tabControls.size"),0);
  await e.control("grant",lease);
  const expiry=e.get("tabControls.get(1).expiresAt");
  await e.control("inspect",lease);
  assert.equal(e.get("tabControls.get(1).expiresAt"),expiry);
  assert.equal(e.messages.at(-1).snapshot.control.id,lease.id);
  assert.ok(e.messages.at(-1).snapshot.tab.generation);
  e.get("tabControls.get(1).expiresAt=0");
  await e.control("renew",{...lease,expiresAt:Date.now()+60000});
  assert.equal(e.messages.at(-1).ok,false);assert.match(e.messages.at(-1).error,/CONTROL_REVOKED/);
  assert.equal(e.get("tabControls.get(1).expiresAt"),0);
});

test("a user stop during control synchronization cannot produce an active acknowledgement",async()=>{
  const e=setup();await e.ready();
  e.context.chrome.scripting.executeScript=async()=>{
    e.get("tabControls.get(1).state='stopping'; blockedOwners.set(1,new Set(['owner-A']))");
    return [];
  };
  await e.control("grant",lease);
  assert.equal(e.messages.at(-1).ok,false);assert.match(e.messages.at(-1).error,/CONTROL_REVOKED/);
  await e.control("inspect",lease);
  assert.equal(e.messages.at(-1).snapshot.blocked,true);
});
