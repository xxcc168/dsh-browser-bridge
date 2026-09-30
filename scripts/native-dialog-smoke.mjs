import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {cpSync,existsSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {tmpdir} from "node:os";
import {join,resolve,basename} from "node:path";
import {fileURLToPath} from "node:url";
import net from "node:net";
import {once} from "node:events";

const root=fileURLToPath(new URL("..",import.meta.url));
const browserPath=process.argv[2] || process.env.DSH_BROWSER_BINARY || [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
].find(existsSync);
assert.ok(browserPath && existsSync(browserPath),"Pass an already installed Chromium browser executable; this script never downloads one.");
const temporary=mkdtempSync(join(tmpdir(),"dsh-native-smoke-"));
const extensionPath=join(temporary,"extension"),profilePath=join(temporary,"profile");
const owner="native-smoke-"+randomUUID();
let bridge,browser,connection,debugSocket;
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
async function until(probe,label,timeout=10000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) {const result=await probe();if(result)return result;await delay(40);}
  throw new Error("Timed out: "+label);
}
async function availablePort() {
  const server=net.createServer();server.listen(0,"127.0.0.1");await once(server,"listening");
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
// This CDP client is attached only to the disposable browser and extension worker, never user tabs.
async function connectDebugger(url) {
  const socket=new WebSocket(url);await once(socket,"open");
  const requests=new Map();let sequence=0;
  socket.addEventListener("message",event=>{
    const message=JSON.parse(String(event.data)),request=requests.get(message.id);
    if(!request)return;requests.delete(message.id);clearTimeout(request.timer);
    message.error?request.reject(new Error(message.error.message)):request.resolve(message.result);
  });
  return {socket,send:(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{requests.delete(id);reject(new Error("CDP timeout: "+method));},10000);
    requests.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
  })};
}
try {
  const port=await availablePort(),base="http://127.0.0.1:"+port;
  bridge=spawn(process.execPath,[join(root,"bridge","bridge.js")],{cwd:root,windowsHide:true,
    env:{...process.env,DSH_BRIDGE_PORT:String(port),DSH_BRIDGE_TOKEN:"",DSH_BRIDGE_TIMEOUT:"12000"},stdio:"ignore"});
  await until(async()=>{try{return (await fetch(base+"/api/status")).ok;}catch{return false;}},"isolated bridge");
  cpSync(join(root,"extension"),extensionPath,{recursive:true});
  // Load the production manifest unchanged so unsupported permissions cannot be hidden by the test.
  const manifest=JSON.parse(readFileSync(join(extensionPath,"manifest.json"),"utf8"));
  const workerPath=join(extensionPath,"background.js");
  // Set the isolated URL before worker startup; never connect this copy to the user's port 8765.
  writeFileSync(workerPath,readFileSync(workerPath,"utf8").replace('"ws://127.0.0.1:8765/ws"',JSON.stringify("ws://127.0.0.1:"+port+"/ws")));
  browser=spawn(browserPath,["--headless=new","--no-first-run","--no-default-browser-check","--disable-gpu",
    "--remote-debugging-port=0","--user-data-dir="+profilePath,"--disable-extensions-except="+extensionPath,
    "--load-extension="+extensionPath,"about:blank"],{windowsHide:true,stdio:"ignore"});
  const endpoint=await until(()=>{
    const path=join(profilePath,"DevToolsActivePort");if(!existsSync(path))return false;
    const [port,pathSuffix]=readFileSync(path,"utf8").trim().split(/\r?\n/);
    return /^\d+$/.test(port) && pathSuffix?.startsWith("/devtools/browser/")?"ws://127.0.0.1:"+port+pathSuffix:false;
  },"disposable browser debugging endpoint");
  connection=await connectDebugger(endpoint);debugSocket=connection.socket;
  const worker=await until(async()=>{
    const {targetInfos}=await connection.send("Target.getTargets");
    // Chromium can expose built-in workers too; select only this extension's background script.
    return targetInfos.find(target=>target.type==="service_worker" && target.url.startsWith("chrome-extension://") && target.url.endsWith("/background.js"));
  },"unpacked extension worker (some branded Chromium builds disable --load-extension)");
  const {sessionId}=await connection.send("Target.attachToTarget",{targetId:worker.targetId,flatten:true});
  await connection.send("Runtime.enable",{},sessionId);
  const workerEval=async expression=>{
    const result=await connection.send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true},sessionId);
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.text+": "+JSON.stringify(result.exceptionDetails.exception));
    return result.result.value;
  };
  await until(()=>workerEval("typeof chrome !== 'undefined' && chrome.runtime?.getManifest().name === 'DSH Browser Bridge'"),"extension runtime initialized");
  // Exercise the real popup's trusted click before any native-dialog fixture or direct storage change.
  const {targetId:popupTarget}=await connection.send("Target.createTarget",{url:worker.url.replace(/background\.js$/,"popup.html")});
  const {sessionId:popupSession}=await connection.send("Target.attachToTarget",{targetId:popupTarget,flatten:true});
  await connection.send("Runtime.enable",{},popupSession);
  const popupEval=async expression=>{
    const result=await connection.send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true},popupSession);
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await until(()=>popupEval("document.readyState === 'complete' && typeof document.getElementById('btn-dialogs')?.onclick === 'function'"),"real extension popup");
  const button=await popupEval("(() => { const button=document.getElementById('btn-dialogs'),bounds=button.getBoundingClientRect(); return {disabled:button.disabled,x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2,status:document.getElementById('dialog-status').textContent}; })()");
  assert.equal(button.disabled,false,button.status);
  await connection.send("Input.dispatchMouseEvent",{type:"mousePressed",x:button.x,y:button.y,button:"left",clickCount:1},popupSession);
  await connection.send("Input.dispatchMouseEvent",{type:"mouseReleased",x:button.x,y:button.y,button:"left",clickCount:1},popupSession);
  const activation=await until(()=>popupEval("(async () => { const config=await chrome.storage.local.get({dialogObservationEnabled:false}),status=document.getElementById('dialog-status').textContent; return config.dialogObservationEnabled || status.startsWith('启用失败') ? {enabled:config.dialogObservationEnabled,status} : false; })()"),"popup activation result");
  assert.equal(activation.enabled,true,activation.status);
  assert.deepEqual(await workerEval("chrome.runtime.getManifest().permissions"),manifest.permissions);
  assert.equal(await workerEval("chrome.permissions.contains({permissions:['debugger']})"),true);
  console.log("PASS real popup activation: unmodified manifest, trusted click, debugger permission present");
  await connection.send("Target.closeTarget",{targetId:popupTarget});
  await until(async()=>{const state=await (await fetch(base+"/api/status")).json();return state.connected;},"isolated extension connection");
  const api=async(path,body)=>{
    const response=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json","X-DSH-Owner":owner},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    return {status:response.status,data:await response.json()};
  };
  const opened=await api("/api/tabs",{url:base+"/test",active:true});assert.equal(opened.status,200,JSON.stringify(opened.data));
  const tabId=opened.data.id;
  const ready=await api("/api/tabs/"+tabId+"/wait",{selector:"#blank-alert",timeout:5000});assert.equal(ready.status,200,JSON.stringify(ready.data));
  const observed=await api("/api/tabs/"+tabId+"/dialog");assert.equal(observed.data.observation,"monitoring",JSON.stringify(observed.data));
  for(const fixture of [
    {selector:"#blank-alert",type:"alert",accept:true,expected:"alert closed"},
    {selector:"#native-confirm",type:"confirm",accept:false,expected:"cancelled"},
    {selector:"#native-prompt",type:"prompt",accept:true,promptText:"isolated reply",expected:"reply: isolated reply"},
  ]) {
    const paused=api("/api/tabs/"+tabId+"/click",{selector:fixture.selector});
    const active=await until(async()=>{
      const state=await api("/api/sessions",{action:"status",tabId});return state.data.dialog?.active;
    },"real native "+fixture.type);
    assert.equal(active.type,fixture.type);if(fixture.type==="alert")assert.equal(active.blank,true);
    const read=await api("/api/tabs/"+tabId+"/content");assert.equal(read.data.code,"NATIVE_DIALOG_OPEN");
    const stale=await api("/api/tabs/"+tabId+"/dialoghandle",{dialogId:"old-dialog",accept:true});assert.equal(stale.data.code,"STALE_DIALOG");
    const recovery=await api("/api/tabs/"+tabId+"/dialoghandle",{dialogId:active.id,accept:fixture.accept,
      ...(fixture.promptText!==undefined?{promptText:fixture.promptText}:{})});
    assert.equal(recovery.status,200,JSON.stringify(recovery.data));assert.equal((await paused).status,200);
    const content=await api("/api/tabs/"+tabId+"/content");assert.ok(content.data.text.includes(fixture.expected));
    console.log("PASS real native "+fixture.type+": detected, stale ID refused, blocked DOM read refused, FIFO recovered explicitly");
  }
  // Beforeunload requires sticky user activation; generate it only inside our disposable fixture.
  const gesture=await workerEval("(async()=>{const results=await chrome.scripting.executeScript({target:{tabId:"+tabId+",frameIds:[0]},world:'MAIN',func:()=>{window.addEventListener('beforeunload',event=>{event.preventDefault();event.returnValue='';});const bounds=document.getElementById('btn').getBoundingClientRect();return {x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2};}});return results[0].result;})()");
  for(const type of ["mousePressed","mouseReleased"])await workerEval("chrome.debugger.sendCommand({tabId:"+tabId+"},'Input.dispatchMouseEvent',"+
    JSON.stringify({type,x:gesture.x,y:gesture.y,button:"left",clickCount:1})+").then(()=>true)");
  const destination=base+"/test?beforeunload=accepted";
  for(const accept of [false,true]) {
    const navigation=api("/api/tabs/"+tabId+"/navigate",{url:destination});
    const dialog=await until(async()=>{const state=await api("/api/sessions",{action:"status",tabId});return state.data.dialog?.active;},"real beforeunload");
    assert.equal(dialog.type,"beforeunload");
    assert.equal((await api("/api/tabs/"+tabId+"/dialoghandle",{dialogId:dialog.id,accept})).status,200);
    assert.equal((await navigation).status,200);
    await until(async()=>{
      const inventory=await api("/api/tabs"),tab=inventory.data.find(item=>item.id===tabId);
      return tab?.status==="complete" && tab.url===(accept?destination:base+"/test");
    },accept?"accepted navigation completion":"cancelled navigation remains on fixture");
  }
  assert.equal((await api("/api/tabs/"+tabId+"/wait",{selector:"#blank-alert",timeout:5000})).status,200);
  console.log("PASS real beforeunload: trusted fixture gesture, cancel preserves page, accept completes navigation");
  // Real modal stop must acknowledge while executeScript is suspended, and agents stay blocked.
  const stoppedClick=api("/api/tabs/"+tabId+"/click",{selector:"#blank-alert"});
  const stoppedDialog=await until(async()=>{const state=await api("/api/sessions",{action:"status",tabId});return state.data.dialog?.active;},"stop fixture dialog");
  await workerEval("revokeLocal("+tabId+",'user_stopped',true).then(()=>true)");
  const stopped=await api("/api/sessions",{action:"status",tabId});assert.equal(stopped.data.canWrite,false);assert.equal(stopped.data.pageBlocked,true);
  const forbidden=await api("/api/tabs/"+tabId+"/dialoghandle",{dialogId:stoppedDialog.id,accept:true});assert.equal(forbidden.data.code,"CONTROL_STOPPED");
  await workerEval("handleNativeDialog("+JSON.stringify({tabId,dialogId:stoppedDialog.id,accept:true})+",true)");
  const unknown=await stoppedClick;assert.equal(unknown.data.state,"unknown");
  await until(()=>workerEval("!tabControls.has("+tabId+") && ![...runningControls.values()].some(operation=>operation.tabId==="+tabId+")"),"actual suspended work drain");
  console.log("PASS real native stop: immediate acknowledgement, original task fenced, manual recovery does not replay SQL or commands");
  console.log(JSON.stringify({browser:basename(browserPath),bridgeVersion:JSON.parse(readFileSync(join(root,"package.json"),"utf8")).version,
    isolated:true,blankAlert:true,confirmCancel:true,promptReply:true,beforeUnload:true,stopWhileNativeModal:true},null,2));
} finally {
  // Only the debugger endpoint from our fresh profile is allowed to close this test browser.
  if(connection)await connection.send("Browser.close").catch(()=>{});
  debugSocket?.close();
  if(browser && browser.exitCode===null) {await Promise.race([once(browser,"exit"),delay(3000)]);if(browser.exitCode===null)browser.kill();}
  if(bridge && bridge.exitCode===null) {bridge.kill();await Promise.race([once(bridge,"exit"),delay(3000)]);}
  // Validate the resolved disposal target before any recursive filesystem cleanup on Windows.
  const resolved=resolve(temporary),parent=resolve(tmpdir());
  assert.equal(resolve(resolved,".."),parent);assert.ok(basename(resolved).startsWith("dsh-native-smoke-"));
  try {rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:200});}catch {console.log("Test profile remains for inspection: "+resolved);}
}
