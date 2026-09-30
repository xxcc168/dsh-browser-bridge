import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const productionManifest=JSON.parse(readFileSync(new URL("../extension/manifest.json",import.meta.url),"utf8"));
const permittedManifest={version:"fixture",permissions:["tabs","storage","debugger"]};

// Run the real popup handler; an invalid optional request must never be mistaken for activation.
async function popup({manifest=permittedManifest,permitted=true,enabled=false,activationError=null}={}) {
  const elements=new Map(),listeners=new Map(),messages=[],config={dialogObservationEnabled:enabled};
  let permissionRequests=0;
  const element=id=>{
    if(!elements.has(id))elements.set(id,{textContent:"",disabled:false,value:"",innerHTML:""});
    return elements.get(id);
  };
  const context={console,Date,setInterval:()=>0,document:{getElementById:element,
    addEventListener:(type,listener)=>listeners.set(type,listener)},chrome:{
    storage:{local:{get:async defaults=>({...defaults,...config})}},tabs:{query:async()=>[]},
    permissions:{contains:async()=>permitted,request:async()=>{
      permissionRequests++;throw new Error("Only permissions specified in the manifest may be requested.");
    }},
    runtime:{getManifest:()=>manifest,sendMessage:async message=>{
      messages.push(message);
      if(message.type==="dsb-get-status")return {connected:true,wsUrl:"ws://fixture"};
      if(message.type==="dsb-control-list")return {controls:[],paused:[],nativeDialogs:[]};
      if(message.type==="dsb-enable-dialogs") {
        if(activationError)return {ok:false,error:activationError};
        config.dialogObservationEnabled=true;return {ok:true};
      }
      throw new Error("Unexpected message: "+message.type);
    }},
  }};
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL("../extension/popup.js",import.meta.url),"utf8"),context);
  listeners.get("DOMContentLoaded")();await context.refresh();
  return {element,config,messages,requests:()=>permissionRequests,
    click:async(isTrusted=true)=>element("btn-dialogs").onclick({isTrusted})};
}

// Chrome explicitly forbids debugger in optional_permissions; validate the shipping declaration.
test("production debugger permission is mandatory, never optional",()=>{
  assert.ok(productionManifest.permissions.includes("debugger"));
  assert.ok(!productionManifest.optional_permissions?.includes("debugger"));
});

test("popup stays opt-in and enables through a trusted click without requesting debugger",async()=>{
  const view=await popup();
  assert.equal(view.config.dialogObservationEnabled,false);
  assert.equal(view.element("btn-dialogs").disabled,false);
  assert.equal(view.messages.some(message=>message.type==="dsb-enable-dialogs"),false);
  await view.click();
  assert.equal(view.config.dialogObservationEnabled,true,view.element("dialog-status").textContent);
  assert.equal(view.requests(),0);
  assert.equal(view.element("btn-dialogs").disabled,true);
  assert.match(view.element("dialog-status").textContent,/已启用/);
});

test("synthetic popup clicks cannot enable observation",async()=>{
  const view=await popup();await view.click(false);
  assert.equal(view.config.dialogObservationEnabled,false);
  assert.equal(view.requests(),0);
  assert.equal(view.messages.some(message=>message.type==="dsb-enable-dialogs"),false);
});

test("stale optional manifest directs the user to reload instead of issuing an invalid request",async()=>{
  const view=await popup({manifest:{version:"1.6.0",permissions:["tabs"],optional_permissions:["debugger"]},permitted:false});
  assert.equal(view.element("btn-dialogs").disabled,true);
  assert.match(view.element("dialog-status").textContent,/重新加载/);
  await view.click();
  assert.equal(view.config.dialogObservationEnabled,false);
  assert.equal(view.requests(),0);
  assert.equal(view.messages.some(message=>message.type==="dsb-enable-dialogs"),false);
});

test("ungranted mandatory permission is reported without requesting or silently activating",async()=>{
  const view=await popup({permitted:false});
  assert.equal(view.element("btn-dialogs").disabled,true);
  assert.match(view.element("dialog-status").textContent,/权限/);
  await view.click();
  assert.equal(view.config.dialogObservationEnabled,false);
  assert.equal(view.requests(),0);
  assert.equal(view.messages.some(message=>message.type==="dsb-enable-dialogs"),false);
});

test("saved feature switch does not imply granted debugger permission",async()=>{
  const view=await popup({enabled:true,permitted:false});
  assert.doesNotMatch(view.element("dialog-status").textContent,/识别已启用/);
  assert.equal(view.element("btn-dialogs").disabled,true);
});

test("activation failure remains visible and does not mark the feature enabled",async()=>{
  const view=await popup({activationError:"fixture activation failed"});await view.click();
  assert.equal(view.config.dialogObservationEnabled,false);
  assert.match(view.element("dialog-status").textContent,/fixture activation failed/);
  assert.equal(view.requests(),0);
});
