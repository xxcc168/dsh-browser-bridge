import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {webcrypto} from "node:crypto";

// Execute the actual worker and imported scripts with a native, non-DOM dialog seam.
function setup({enabled=true,permitted=true}={}) {
  const eventListeners=[],detachListeners=[],commands=[],injections=[],messages=[],stored=[];
  const context={console,crypto:webcrypto,setTimeout,clearTimeout,setInterval:()=>1,clearInterval:()=>{},
    WebSocket:{OPEN:1,CONNECTING:0},chrome:{
      storage:{session:{get:async defaults=>defaults,set:async value=>stored.push(value)},
        local:{get:async defaults=>({...defaults,dialogObservationEnabled:enabled})}},
      permissions:{contains:async()=>permitted},
      debugger:{attach:async()=>{},detach:async()=>{},
        sendCommand:async(target,method,params)=>{
          commands.push({target,method,params});
          if(method==="Page.handleJavaScriptDialog")
            for(const listener of eventListeners)listener(target,"Page.javascriptDialogClosed",{});
        },
        onEvent:{addListener:listener=>eventListeners.push(listener)},
        onDetach:{addListener:listener=>detachListeners.push(listener)}},
      tabs:{get:async id=>({id,url:"https://fixture.test/",title:"Fixture"}),query:async()=>[]},
      action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{},setTitle:async()=>{}},
      scripting:{executeScript:async options=>{
        injections.push(options);return [{documentId:"fixture-document",frameId:0,result:true}];
      }},
    }};
  vm.createContext(context);
  context.importScripts=(...paths)=>paths.forEach(path=>
    vm.runInContext(readFileSync(new URL("../extension/"+path,import.meta.url),"utf8"),context));
  const source=readFileSync(new URL("../extension/background.js",import.meta.url),"utf8");
  vm.runInContext(source.slice(0,source.indexOf("chrome.alarms.create")),context);
  const get=expression=>vm.runInContext(expression,context);
  const sock={readyState:1,send:raw=>messages.push(JSON.parse(raw))};
  get("ws");
  const lease={id:"lease-A",tabId:1,owner:"owner-A",agentName:"Dialog test",state:"active",expiresAt:Date.now()+120000};
  return {context,get,commands,injections,messages,stored,lease,
    grant:async()=>{await get("controlReady");await context.handleControl(sock,{id:"grant",action:"grant",lease,instanceId:"bridge"});},
    open:(params={})=>eventListeners.forEach(listener=>listener({tabId:1},"Page.javascriptDialogOpening",
      {type:"alert",message:"",url:"https://fixture.test/",hasBrowserHandler:true,...params})),
    inspect:async()=>{await context.handleControl(sock,{id:"inspect",action:"inspect",lease});return messages.at(-1).snapshot;},
    detach:()=>detachListeners.forEach(listener=>listener({tabId:1},"canceled_by_user")),
    close:()=>eventListeners.forEach(listener=>listener({tabId:1},"Page.javascriptDialogClosed",{})),
  };
}

// Activation must report the updated tab, not the inactive snapshot read before the action.
test("activate returns the post-update active tab snapshot",async()=>{
  const fixture=setup({enabled:false});
  const previous={id:1,windowId:7,url:"https://fixture.test/",title:"Fixture",active:false};
  const updated={...previous,active:true};
  fixture.context.chrome.tabs.get=async()=>previous;
  fixture.context.chrome.tabs.update=async(tabId,options)=>{
    assert.equal(tabId,1);assert.equal(options.active,true);return updated;
  };
  fixture.context.chrome.windows={update:async(windowId,options)=>{
    assert.equal(windowId,7);assert.equal(options.focused,true);
  }};
  const result=await fixture.context.runCommand({action:"activate",tabId:1});
  assert.equal(result.active,true);
  assert.equal(result.windowId,7);
});

// Empty message is still a real active alert; it is never equivalent to no dialog.
test("blank native alert is reported by session inspection without auto-confirming",async()=>{
  const e=setup();await e.grant();e.open();
  const snapshot=await e.inspect();
  assert.equal(snapshot.dialog?.active?.type,"alert");
  assert.equal(snapshot.dialog.active.message,"");
  assert.equal(snapshot.dialog.active.blank,true);
  assert.ok(snapshot.dialog.active.id);
  assert.equal(e.commands.some(command=>command.method==="Page.handleJavaScriptDialog"),false);
});

// Stale result DOM must not be read while Chrome is paused on its native modal.
test("known native alert rejects DOM reads before attempting blocked injection",async()=>{
  const e=setup();await e.grant();e.open();const before=e.injections.length;
  await assert.rejects(e.context.runCommand({action:"readPage",tabId:1,leaseId:e.lease.id,owner:e.lease.owner}),/NATIVE_DIALOG_OPEN/);
  assert.equal(e.injections.length,before);
});

// Without the explicit permission, absence of observations is not evidence of absence.
test("disabled native observation reports unknown rather than a false clean page",async()=>{
  const e=setup({enabled:false});await e.grant();
  const snapshot=await e.inspect();
  assert.equal(snapshot.dialog?.observation,"disabled");
  assert.equal(snapshot.dialog.known,false);
  assert.equal(e.commands.length,0);
});

// Explicit decisions are ID-bound, so an old command cannot accept a replacement dialog.
test("explicit confirm cancellation uses CDP once and rejects the stale ID",async()=>{
  const e=setup();await e.grant();e.open({type:"confirm",message:"continue?"});
  const dialog=(await e.inspect()).dialog.active;
  const command={action:"dialoghandle",tabId:1,leaseId:e.lease.id,owner:e.lease.owner,dialogId:dialog.id,accept:false};
  assert.equal((await e.context.runCommand(command)).handled,true);
  assert.equal(e.commands.filter(entry=>entry.method==="Page.handleJavaScriptDialog").length,1);
  assert.equal(e.commands.at(-1).params.accept,false);
  await assert.rejects(e.context.runCommand(command),/STALE_DIALOG/);
  assert.equal(e.commands.filter(entry=>entry.method==="Page.handleJavaScriptDialog").length,1);
});

// Recovery never bypasses user stop or drains the still-paused injected operation.
test("stopped task cannot confirm its native modal; trusted user recovery preserves running work",async()=>{
  const e=setup();await e.grant();e.open();
  const dialog=(await e.inspect()).dialog.active;
  e.get("runningControls.set('paused',{id:'paused',tabId:1,leaseId:'lease-A'})");
  await e.context.revokeLocal(1,"user_stopped",true);
  const command={action:"dialoghandle",tabId:1,leaseId:e.lease.id,owner:e.lease.owner,dialogId:dialog.id,accept:true};
  await assert.rejects(e.context.runCommand(command),/CONTROL_REVOKED/);
  await e.context.handleNativeDialog(command,true);
  assert.equal(e.get("runningControls.has('paused')"),true);
  assert.equal(e.get("tabControls.get(1).state"),"stopping");
});

// Detachment means unknown, not a fabricated close event or false successful page read.
test("debugger detach preserves blocker evidence and rejects blind recovery",async()=>{
  const e=setup();await e.grant();e.open();const dialog=(await e.inspect()).dialog.active;
  e.detach();const snapshot=await e.inspect();
  assert.equal(snapshot.dialog.known,false);
  assert.equal(snapshot.dialog.reason,"debugger_detached");
  assert.equal(snapshot.dialog.active.id,dialog.id);
  await assert.rejects(e.context.runCommand({action:"dialoghandle",tabId:1,leaseId:e.lease.id,owner:e.lease.owner,dialogId:dialog.id,accept:true}),/DIALOG_UNOBSERVED/);
});

// Permission denial or an existing debugger never degrades into silent pretend-observation.
// A stale asynchronous banner must not make a renewed legitimate lease look expired.
test("command guard refreshes the same active lease but never revives a stopped page guard",async()=>{
  const fixture=setup({enabled:false});await fixture.grant();
  fixture.context.chrome.scripting.executeScript=async options=>{
    if(options.target.documentIds && options.args?.[0]?.leaseId && !options.args[0].action)
      options.func(...options.args);
    return [{documentId:"fixture-document",frameId:0,result:true}];
  };
  for(const state of ["active","stopping"]) {
    fixture.context.__dshControlV3={leaseId:fixture.lease.id,state,expiresAt:0};
    await fixture.context.runCommand({action:"readPage",tabId:1,leaseId:fixture.lease.id,owner:fixture.lease.owner});
    assert.equal(fixture.context.__dshControlV3.state,state);
    assert.equal(fixture.context.__dshControlV3.expiresAt,state==="active"?fixture.lease.expiresAt:0);
  }
});

test("missing debugger permission is explicit and sends no CDP commands",async()=>{
  const e=setup({permitted:false});await e.grant();
  const snapshot=await e.inspect();
  assert.equal(snapshot.dialog.reason,"debugger_permission_required");
  assert.equal(snapshot.dialog.known,false);assert.equal(e.commands.length,0);
});
test("busy debugger attachment is reported without stealing its connection",async()=>{
  const e=setup();e.context.chrome.debugger.attach=async()=>{throw new Error("another debugger is attached");};
  await e.grant();const snapshot=await e.inspect();
  assert.equal(snapshot.dialog.reason,"debugger_attach_failed");
  assert.equal(snapshot.dialog.known,false);assert.equal(e.commands.length,0);
});

// A callback may open another modal immediately; the old response must not clear it.
test("native recovery cannot erase a replacement modal opened by a callback",async()=>{
  const e=setup();await e.grant();e.open({type:"confirm"});const previous=(await e.inspect()).dialog.active;
  e.context.chrome.debugger.sendCommand=async()=>{e.close();e.open({type:"alert",message:"next"});};
  await e.context.runCommand({action:"dialoghandle",tabId:1,leaseId:e.lease.id,owner:e.lease.owner,dialogId:previous.id,accept:true});
  const current=(await e.inspect()).dialog.active;
  assert.notEqual(current.id,previous.id);assert.equal(current.message,"next");
});

// CDP does not promise replaying an opening event for a modal that predates observation.
test("pre-existing unobserved modal is reported as a suspected blocker, never a clean page",async()=>{
  const e=setup();e.context.setTimeout=callback=>setTimeout(callback,15);
  e.context.chrome.scripting.executeScript=()=>new Promise(()=>{});
  await e.grant();const snapshot=await e.inspect();
  assert.equal(snapshot.dialog.known,false);assert.equal(snapshot.dialog.blocked,true);
  assert.equal(snapshot.dialog.active,null);assert.equal(snapshot.dialog.reason,"page_script_unresponsive");
  await assert.rejects(e.context.runCommand({action:"readPage",tabId:1,leaseId:e.lease.id,owner:e.lease.owner}),/PAGE_SCRIPT_BLOCKED/);
});

// A readiness probe is not a business operation and cannot erase an active modal event.
test("late probe completion clears suspicion only after page execution resumes",async()=>{
  const e=setup();e.context.setTimeout=callback=>setTimeout(callback,15);let finish;
  e.context.chrome.scripting.executeScript=()=>new Promise(resolve=>{finish=resolve;});
  await e.grant();assert.equal((await e.inspect()).dialog.blocked,true);
  finish([{result:true,documentId:"fixture-document"}]);await new Promise(resolve=>setImmediate(resolve));
  const snapshot=await e.inspect();assert.equal(snapshot.dialog.known,true);assert.equal(snapshot.dialog.blocked,false);
});
