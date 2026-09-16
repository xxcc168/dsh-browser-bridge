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
  for(let i=0;i<5;i++){e.advance(20000);assert.equal(e.controls.renew(A,[l.id]).length,1);}
  e.advance(20001);e.controls.sweep();await l.stopping;
  assert.equal(e.controls.leases.has(1),false);
});
test("crashed caller loses its 60s lease without waiting for idle deadline",async()=>{
  const e=setup(),l=e.controls.admit(1,A,"A");await l.ready;
  e.advance(60001);e.controls.sweep();await l.stopping;
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
  assert.deepEqual(e.controls.renew(B,[l.id]),[]);
  await e.controls.revoke(l,"user_stopped",true);
  assert.deepEqual(e.controls.renew(A,[l.id]),[]);
  assert.throws(()=>e.controls.admit(1,A,"A"),/CONTROL_STOPPED/);
});
test("uncertain grant acknowledgement remains fenced until reconciliation",async()=>{
  const controls=new ControlManager({sync:async()=>{throw Error("offline");}});
  const l=controls.admit(1,A,"A");await assert.rejects(l.ready,/offline/);
  assert.equal(l.state,"stopping");assert.throws(()=>controls.admit(1,B,"B"),/TAB_OCCUPIED/);
});
