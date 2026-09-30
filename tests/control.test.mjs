import {test} from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {resolveBridgeDir} from "../lib/runtime.js";
const dir=resolveBridgeDir(process.env.DSH_BROWSER_BRIDGE_DIR);
const {ControlManager}=createRequire(dir+"/bridge.js")("./control-manager.cjs");
const A="task-owner-A-000000",B="task-owner-B-000000";
function setup() {
  let now=100000;const events=[];let drained=true;
  const controls=new ControlManager({now:()=>now,sync:async(l,action)=>{events.push({id:l.id,action});return {drained};},
    onRevoke:l=>events.push({id:l.id,action:"cancel"})});
  return {controls,events,advance:ms=>now+=ms,drained:value=>drained=value};
}
test("atomic first use: exactly one owner, competitors never wait for release",async()=>{
  const {controls}=setup();
  const l=controls.admit(1,A,"A");
  assert.throws(()=>controls.admit(1,B,"B"),/TAB_OCCUPIED/);
  await l.ready;
  assert.equal(controls.admit(1,A,"A").id,l.id);
  assert.throws(()=>controls.admit(1,B,"B",l.id),/TAB_OCCUPIED/);
  await controls.revoke(l,"released");
  const next=controls.admit(1,B,"B");await next.ready;assert.notEqual(next.id,l.id);
  assert.throws(()=>controls.admit(1,A,"A",l.id),/TAB_OCCUPIED/);
});
test("idle time is not extended by transport renewals",async()=>{
  const e=setup(),l=e.controls.admit(1,A,"A");await l.ready;
  for(let i=0;i<5;i++){e.advance(20000);assert.equal((await e.controls.renew(A,[l.id])).length,1);}
  e.advance(200001);e.controls.sweep();await l.stopping;
  assert.equal(e.controls.leases.has(1),false);
});
test("crashed caller loses its five-minute lease without permitting unresolved work handoff",async()=>{
  const e=setup(),l=e.controls.admit(1,A,"A");await l.ready;
  e.advance(300001);e.controls.sweep();await l.stopping;
  assert.equal(e.controls.leases.has(1),false);
  await e.controls.admit(1,B,"B").ready;
});
test("in-flight operations cannot be handed over before extension confirms drain",async()=>{
  const e=setup(),l=e.controls.admit(1,A,"A");await l.ready;l.pending=1;
  e.drained(false);await e.controls.revoke(l,"user_stopped",true);
  assert.equal(l.state,"stopping");
  assert.throws(()=>e.controls.admit(1,B,"B"),/TAB_OCCUPIED/);
  assert.throws(()=>e.controls.check(l,A),/CONTROL_REVOKED/);
  e.controls.drained(1,"wrong-id");assert.equal(e.controls.leases.has(1),true);
  e.controls.drained(1,l.id);
  assert.throws(()=>e.controls.admit(1,A,"A"),/CONTROL_STOPPED/);
  await e.controls.admit(1,B,"B").ready;
});
test("renew rejects other owners and cannot resurrect an expired or revoked lease",async()=>{
  const e=setup(),l=e.controls.admit(1,A,"A");await l.ready;
  assert.deepEqual(await e.controls.renew(B,[l.id]),[]);
  await e.controls.revoke(l,"user_stopped",true);
  assert.deepEqual(await e.controls.renew(A,[l.id]),[]);
  assert.throws(()=>e.controls.admit(1,A,"A"),/CONTROL_STOPPED/);
});
test("uncertain grant acknowledgement remains fenced until reconciliation",async()=>{
  const controls=new ControlManager({sync:async()=>{throw Error("offline");}});
  const l=controls.admit(1,A,"A");await assert.rejects(l.ready,/offline/);
  assert.equal(l.state,"stopping");assert.throws(()=>controls.admit(1,B,"B"),/TAB_OCCUPIED/);
});

test("a rejected extension renewal must not leave the bridge reporting active control",async()=>{
  const controls=new ControlManager({sync:async(_lease,action)=>{
    if(action==="renew")throw Error("CONTROL_REVOKED: extension lease expired");
    return {drained:false};
  }});
  const l=controls.admit(1,A,"A");await l.ready;
  await controls.renew(A,[l.id]);
  assert.notEqual(controls.public(l).state,"active");
  assert.throws(()=>controls.check(l,A),/CONTROL_REVOKED/);
});

test("extension expiry notification invalidates bridge control before the next action",async()=>{
  const {controls}=setup(),l=controls.admit(1,A,"A");await l.ready;
  controls.drained(1,l.id);
  assert.equal(controls.leases.has(1),false);
  assert.throws(()=>controls.check(l,A),/CONTROL_REVOKED/);
});

test("ensure resumes after a long idle only after drain and preserves manual-stop blocking",async()=>{
  const e=setup(),first=await e.controls.ensure(1,A,"A");
  e.advance(300000);
  const next=await e.controls.ensure(1,A,"A");
  assert.notEqual(next.id,first.id);assert.equal(next.state,"active");
  assert.ok(e.events.find(x=>x.id===first.id && x.action==="revoke"));
  await e.controls.revoke(next,"user_stopped",true);
  await assert.rejects(e.controls.ensure(1,A,"A"),/CONTROL_STOPPED/);
});

test("concurrent confirmations share one extension acknowledgement",async()=>{
  let confirm,renewals=0;
  const controls=new ControlManager({sync:async(_lease,action)=>{
    if(action==="renew"){renewals++;return new Promise(resolve=>{confirm=resolve;});}
    return {drained:true};
  }});
  const l=controls.admit(1,A,"A");await l.ready;
  const first=controls.confirm(l,A),second=controls.confirm(l,A);
  await Promise.resolve();assert.equal(renewals,1);
  confirm({drained:false});await Promise.all([first,second]);
  assert.equal(l.state,"active");
});

// Five minutes is an idle ceiling, not an indefinitely renewable ownership grant.
test("default ownership survives four minutes and expires at five without heartbeat extension",async()=>{
  const fixture=setup(),lease=fixture.controls.admit(101,A,"A");await lease.ready;
  assert.equal(fixture.controls.public(lease).expiresAt-100000,300000);
  fixture.advance(240000);fixture.controls.sweep();
  assert.equal(fixture.controls.leases.get(101),lease);
  await fixture.controls.renew(A,[lease.id]);
  fixture.advance(59999);fixture.controls.sweep();
  assert.equal(fixture.controls.leases.get(101),lease);
  fixture.advance(1);fixture.controls.sweep();await lease.stopping;
  assert.equal(fixture.controls.leases.has(101),false);
});

// Admission must not wait for a different owner's lost revoke acknowledgement.
test("ensure rejects competitors and user-stopped owners before waiting for revoke",async()=>{
  let finishRevoke;
  const controls=new ControlManager({sync:async(_lease,action)=>action==="revoke"?
    new Promise(resolve=>{finishRevoke=resolve;}):{drained:false}});
  const lease=controls.admit(102,A,"A");await lease.ready;
  void controls.revoke(lease,"user_stopped",true);
  try {
    for(const [owner,expected] of [[B,"TAB_OCCUPIED"],[A,"CONTROL_STOPPED"]]) {
      const result=await Promise.race([
        controls.ensure(102,owner,owner).then(()=>"unexpected_grant",error=>error.code),
        new Promise(resolve=>setTimeout(()=>resolve("blocked_by_revoke"),60)),
      ]);
      assert.equal(result,expected);
    }
  }finally{finishRevoke({drained:false});await lease.stopping;}
});
