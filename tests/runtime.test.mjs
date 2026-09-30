import {test} from "node:test";
import assert from "node:assert/strict";
import {BridgeClient} from "../lib/runtime.js";

// Node's DOMException exposes numeric legacy codes; agent errors need stable string codes and honest uncertainty.
for(const scenario of [
  {method:"GET",name:"TimeoutError",expected:"DEADLINE_EXCEEDED"},
  {method:"POST",name:"TimeoutError",expected:"DEADLINE_EXCEEDED"},
  {method:"POST",name:"AbortError",expected:"CANCELLED"},
])test("DOMException normalization preserves write uncertainty: "+scenario.method+" "+scenario.name,async testContext=>{
  const client=new BridgeClient({autoStart:false});
  const controller=new AbortController(),cause=new DOMException("fixture aborted",scenario.name);
  testContext.mock.method(globalThis,"fetch",async()=>{
    if(scenario.name==="AbortError")controller.abort();
    throw cause;
  });
  try {
    await assert.rejects(client.request(scenario.method,"/fixture",undefined,
      {signal:controller.signal,requestId:"dom-exception-fixture"}),error=>{
      assert.equal(error.code,scenario.expected);
      assert.equal(error.requestId,"dom-exception-fixture");
      assert.equal(error.state,scenario.method==="POST"?"unknown":undefined);
      assert.equal(error.cause,cause);return true;
    });
  }finally{client.close();}
});

function fixture(owner="owner-fixture-000000",sessionId="lease-old",activity=Date.now()) {
  const client=new BridgeClient({autoStart:false});
  const key=owner+":1",lease={owner,sessionId,tabId:1,activity,idleExpiresAt:activity+300000};
  client.claims.set(key,lease);
  return {client,key,lease};
}

// These tests exercise the actual adapter renewal loop without a browser or wall-clock wait.
test("adapter renews a four-minute-idle owner instead of pruning it at three minutes",async()=>{
  const {client,key,lease}=fixture(undefined,undefined,Date.now()-240000);let requests=0;
  client.request=async()=>{requests++;return {renewed:[lease.sessionId]};};
  try {await client.renewControls();assert.equal(requests,1);assert.equal(client.claims.get(key),lease);}
  finally{client.close();}
});

test("adapter renewal passes are single-flight",async()=>{
  const {client,lease}=fixture();const finishes=[];let requests=0;
  client.request=()=>{requests++;return new Promise(resolve=>finishes.push(resolve));};
  const first=client.renewControls();await new Promise(resolve=>setImmediate(resolve));
  const second=client.renewControls();await new Promise(resolve=>setImmediate(resolve));
  const beforeFinish=requests;finishes.forEach(finish=>finish({renewed:[lease.sessionId]}));
  try {await Promise.all([first,second]);assert.equal(beforeFinish,1);}finally{client.close();}
});

for(const replaceObject of [false,true])test("old renewal cannot delete a newer claim (replace="+replaceObject+")",async()=>{
  const {client,key,lease}=fixture();let finish;
  client.request=()=>new Promise(resolve=>{finish=resolve;});
  const renewal=client.renewControls();await new Promise(resolve=>setImmediate(resolve));
  const newer={...lease,sessionId:"lease-new"};
  client.claims.set(key,replaceObject?newer:Object.assign(lease,newer));
  finish({renewed:replaceObject?[]:["lease-old"]});
  try {await renewal;assert.equal(client.claims.get(key)?.sessionId,"lease-new");}
  finally{client.close();}
});

test("a slow owner does not serialize other owners' renewal traffic",async()=>{
  const {client}=fixture("owner-slow-000000");let finishSlow;const owners=[];
  client.claims.set("owner-fast-000000:2",{owner:"owner-fast-000000",sessionId:"lease-fast",tabId:2,activity:Date.now()});
  client.request=async(_method,_path,body,options)=>{
    owners.push(options.owner);
    if(options.owner==="owner-slow-000000")await new Promise(resolve=>{finishSlow=resolve;});
    return {renewed:body.sessionIds};
  };
  const renewal=client.renewControls();await new Promise(resolve=>setImmediate(resolve));
  const fastStarted=owners.includes("owner-fast-000000");finishSlow();
  try {await renewal;assert.equal(fastStarted,true);}finally{client.close();}
});

test("renewal concurrency stays bounded and idle claims expire after five minutes",async()=>{
  const {client}=fixture();let active=0,peak=0;
  for(let index=2;index<10;index++) {
    const owner="owner-bounded-"+index;
    client.claims.set(owner+":"+index,{owner,tabId:index,sessionId:"lease-"+index,activity:Date.now()});
  }
  client.claims.set("expired:10",{owner:"expired",tabId:10,sessionId:"expired",activity:Date.now()-300001});
  client.request=async(_method,_path,body)=>{
    active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,5));active--;return {renewed:body.sessionIds};
  };
  try {await client.renewControls();assert.ok(peak>1 && peak<=4);assert.equal(client.claims.has("expired:10"),false);}
  finally{client.close();}
});
