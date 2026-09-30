import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";

// Use the existing MCP/Chrome connection, never install software or attach a second debugger.
const root=fileURLToPath(new URL("..",import.meta.url));
const manifest=JSON.parse(readFileSync(join(root,"tools.manifest.json"),"utf8"));
const base=(process.env.DSH_BRIDGE_URL || "http://127.0.0.1:"+(process.env.DSH_BRIDGE_PORT || 8765)).replace(/\/+$/,"");
const endpoint=new URL(base);
assert.equal(endpoint.protocol,"http:");assert.ok(["127.0.0.1","localhost","[::1]"].includes(endpoint.hostname));
const agentId="live-release-"+randomUUID(),competitor=agentId+"-competitor";
const owned=new Set(),usedTools=new Set(),cases=[];
const artifacts=join(root,".verify");mkdirSync(artifacts,{recursive:true});
const client=new Client({name:"dsh-live-release-smoke",version:"1"});
const transport=new StdioClientTransport({command:process.execPath,args:[join(root,"examples","mcp-server.mjs")],
  env:{...process.env,DSH_BRIDGE_URL:base,DSH_BRIDGE_AUTOSTART:"false"},stderr:"pipe"});
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const startedAt=Date.now();let success=false,nativeTab,retention;
async function invoke(name,args={},expectedError) {
  usedTools.add(name);
  const reply=await client.callTool({name,arguments:{agentId,agentName:"Live release validation",...args}},undefined,{timeout:130000});
  const text=reply.content.filter(block=>block.type==="text").map(block=>block.text).join("\n");
  let data;try{data=JSON.parse(text);}catch{data=text;}
  if(name==="browser_search" && reply.isError && Number.isInteger(data.details?.tabId))owned.add(data.details.tabId);
  if(expectedError) {assert.equal(reply.isError,true,text);assert.match(text,expectedError);return data;}
  assert.notEqual(reply.isError,true,text);
  if(name==="browser_screenshot") {
    const picture=reply.content.find(block=>block.type==="image");
    assert.equal(picture?.mimeType,"image/png");
    const bytes=Buffer.from(picture.data,"base64");assert.ok(bytes.length>100);
    assert.equal(bytes.subarray(0,8).toString("hex"),"89504e470d0a1a0a");
    writeFileSync(join(artifacts,"live-release-screenshot.png"),bytes);
    return {pngBytes:bytes.length};
  }
  return data;
}
async function until(probe,label,timeout=6000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) {const value=await probe();if(value)return value;await delay(80);}
  throw new Error("Timed out: "+label);
}
async function scenario(name,work) {
  const start=Date.now();await work();
  cases.push({name,elapsedMs:Date.now()-start});console.log("PASS "+name);
}
async function openFixture(label) {
  const opened=await invoke("browser_open",{url:base+"/test?live-release="+encodeURIComponent(label),active:false});
  assert.ok(Number.isInteger(opened.id));owned.add(opened.id);
  await invoke("browser_wait",{tabId:opened.id,selector:"#box",timeout:5000});return opened.id;
}
try {
  await client.connect(transport);
  const state=await invoke("browser_status");
  assert.equal(state.connected,true);assert.equal(state.versionsMatch,true);
  assert.equal(state.version,manifest.version);assert.equal(client.getServerVersion().version,manifest.version);
  assert.deepEqual(state.controlPolicy,manifest.controlPolicy);
  assert.equal(state.pending,0);assert.equal(state.queuedWrites,0);assert.equal(state.controlledTabs,0,"Wait for other browser tasks before live verification");
  const listed=await client.listTools();
  assert.deepEqual(listed.tools.map(tool=>tool.name).sort(),manifest.tools.map(tool=>tool.name).sort());
  console.log("PASS three live versions, policy and "+listed.tools.length+" MCP registrations");
  const tabId=await openFixture("workflow");nativeTab=tabId;
  await scenario("activation returns the actual active snapshot",async()=>{
    const activated=await invoke("browser_activate",{tabId});assert.equal(activated.active,true);
    const tabs=await invoke("browser_tabs",{activeOnly:true});assert.ok(tabs.split("\n").some(row=>row.startsWith(tabId+"\t*\t")));
  });

  // This tab receives no page actions after the snapshot; renewals and status reads do not reset idle.
  const idleTab=await openFixture("five-minute-idle");
  const idle=await invoke("browser_ensure_session",{tabId:idleTab});assert.equal(idle.canWrite,true);
  retention={tabId:idleTab,sessionId:idle.sessionId,idleExpiresAt:idle.idleExpiresAt};
  assert.ok(retention.idleExpiresAt-Date.now()>295000);
  console.log("START real five-minute idle retention; no accelerated clock");

  await scenario("type, key, click, read and extraction",async()=>{
    const typed=await invoke("browser_type",{tabId,selector:"placeholder=在这里输入文字",text:"桥接 real test <>&"});
    assert.equal(typed.typed,true);assert.equal(typed.verified,true);
    await invoke("browser_key",{tabId,key:"Enter"});
    await invoke("browser_wait",{tabId,selector:"#result",contains:"enter: 桥接 real test",timeout:1000});
    await invoke("browser_click",{tabId,selector:'role=button[name="GO"]'});
    const read=await invoke("browser_read",{tabId,selector:"#result"});assert.match(read,/clicked: 桥接 real test/);
    const fields=await invoke("browser_extract",{tabId,selector:"#box"});assert.equal(fields.items[0].value,"桥接 real test <>&");
  });
  await scenario("real DOM fixtures, idempotent clicks/checks, select and hover",async()=>{
    // Fixtures are created only on the local page opened above, never a business tab.
    await invoke("browser_eval",{tabId,expression:`(() => {
      const section=document.createElement('section');section.id='release-fixture';
      section.innerHTML='<button id="release-count">Count</button><input id="release-check" type="checkbox"><select id="release-select"><option value="first">First</option><option value="second">Second</option></select><button id="release-hover">Hover</button><div id="release-shadow"></div><iframe id="release-frame" src="${base}/test?live-release=frame"></iframe><div id="release-long"></div>';
      document.body.prepend(section);window.releaseCount=0;window.releaseChecks=0;window.releaseHover=0;
      document.getElementById('release-count').onclick=()=>window.releaseCount++;
      document.getElementById('release-check').onchange=()=>window.releaseChecks++;
      document.getElementById('release-hover').onmouseover=()=>window.releaseHover++;
      document.getElementById('release-shadow').attachShadow({mode:'open'}).innerHTML='<input id="shadow-input" placeholder="Shadow input">';
      document.getElementById('release-long').textContent='Pagination fixture '.repeat(500);
      return true;
    })()`});
    const requestId="live-once-"+randomUUID();
    await invoke("browser_click",{tabId,selector:"#release-count",requestId});
    await invoke("browser_click",{tabId,selector:"#release-count",requestId});
    assert.equal(await invoke("browser_eval",{tabId,expression:"window.releaseCount"}),1);
    const request=await invoke("browser_request_status",{requestId});assert.equal(request.state,"succeeded");
    await invoke("browser_check",{tabId,selector:"#release-check",checked:true});
    await invoke("browser_check",{tabId,selector:"#release-check",checked:true});
    assert.equal(await invoke("browser_eval",{tabId,expression:"window.releaseChecks"}),1);
    const selected=await invoke("browser_select",{tabId,selector:"#release-select",value:"second"});assert.equal(selected.value,"second");
    await invoke("browser_hover",{tabId,selector:"#release-hover"});
    assert.equal(await invoke("browser_eval",{tabId,expression:"window.releaseHover"}),1);
  });
  await scenario("shadow roots, real frames, pagination, scroll and screenshot",async()=>{
    await invoke("browser_type",{tabId,selector:"#release-shadow >>> #shadow-input",text:"shadow verified"});
    const shadow=await invoke("browser_extract",{tabId,selector:"#release-shadow >>> #shadow-input"});assert.equal(shadow.items[0].value,"shadow verified");
    const frame=await until(async()=>{
      const found=await invoke("browser_frames",{tabId});return found.frames.find(item=>item.frameId!==0 && item.url===base+"/test?live-release=frame");
    },"real child frame");
    await invoke("browser_wait",{tabId,frameId:frame.frameId,selector:"#box",timeout:5000});
    await invoke("browser_type",{tabId,frameId:frame.frameId,selector:"#box",text:"frame verified"});
    const fields=await invoke("browser_extract",{tabId,frameId:frame.frameId,selector:"#box"});assert.equal(fields.items[0].value,"frame verified");
    const first=await invoke("browser_read",{tabId,selector:"#release-long",maxText:256});
    const metadata=JSON.parse(first.split("\n")[0]);assert.equal(metadata.truncated,true);assert.equal(metadata.nextOffset,256);
    const next=await invoke("browser_read",{tabId,selector:"#release-long",maxText:256,offset:metadata.nextOffset});assert.equal(JSON.parse(next.split("\n")[0]).offset,256);
    const full=await invoke("browser_read",{tabId,maxText:20000});assert.ok(!full.includes("Live release validation"));
    assert.equal((await invoke("browser_scroll",{tabId,dy:350})).scrolled,true);
    await invoke("browser_scroll",{tabId,dy:-10000});
    await invoke("browser_screenshot",{tabId});
  });
  await scenario("wait errors and batch failure stop without extra click",async()=>{
    await invoke("browser_wait",{tabId,selector:"#never-created",timeout:150},/WAIT_TIMEOUT/);
    const good=await invoke("browser_batch",{tabId,steps:[
      {action:"type",selector:"#box",text:"batch verified"},{action:"click",selector:"#btn"},
      {action:"wait",selector:"#result",contains:"batch verified",timeout:1000},{action:"readPage",selector:"#result"},
    ]});assert.equal(good.ok,true);assert.equal(good.steps.length,4);
    const failed=await invoke("browser_batch",{tabId,steps:[
      {action:"type",selector:"#box",text:"before failure"},{action:"wait",selector:"#never-created",timeout:150},
      {action:"click",selector:"#release-count"},
    ]},/WAIT_TIMEOUT/);
    assert.equal(failed.details.failedStep,1);assert.equal(failed.details.completedSteps.length,1);
    assert.equal(await invoke("browser_eval",{tabId,expression:"window.releaseCount"}),1);
  });

  // Explicit test decisions apply only to these three fixtures; observation is never enabled here.
  const native=await invoke("browser_dialog",{tabId});assert.equal(native.observation,"monitoring","Enable native observation manually before this opt-in test");
  for(const fixture of [
    {selector:"#blank-alert",type:"alert",accept:true,expected:"alert closed"},
    {selector:"#native-confirm",type:"confirm",accept:false,expected:"cancelled"},
    {selector:"#native-prompt",type:"prompt",accept:true,promptText:"live test reply",expected:"reply: live test reply"},
  ])await scenario("real Chrome native "+fixture.type+" and FIFO recovery",async()=>{
    const paused=invoke("browser_click",{tabId,selector:fixture.selector}).then(data=>({data}),error=>({error}));
    const dialog=await until(async()=>{const snapshot=await invoke("browser_dialog",{tabId});return snapshot.active;},"native "+fixture.type);
    assert.equal(dialog.type,fixture.type);if(fixture.type==="alert"){assert.equal(dialog.blank,true);assert.equal(dialog.message,"");}
    await invoke("browser_read",{tabId,selector:"#result"},/NATIVE_DIALOG_OPEN/);
    await invoke("browser_handle_dialog",{tabId,dialogId:"stale-live-dialog",accept:true},/STALE_DIALOG/);
    if(fixture.type==="alert") {
      const requestId="live-queued-timeout-"+randomUUID();
      await invoke("browser_batch",{tabId,requestId,timeout:300,steps:[{action:"click",selector:"#release-count"}]},/CANCELLED|DEADLINE_EXCEEDED/);
      // A client timeout remains unknown until the bridge confirms the queued command was never dispatched.
      await until(async()=>{const record=await invoke("browser_request_status",{requestId});return record.state==="cancelled";},"queued cancellation acknowledgement");
    }
    await invoke("browser_handle_dialog",{tabId,dialogId:dialog.id,accept:fixture.accept,
      ...(fixture.promptText!==undefined?{promptText:fixture.promptText}:{})});
    const resumed=await paused;if(resumed.error)throw resumed.error;assert.equal(resumed.data.clicked,true);
    await invoke("browser_wait",{tabId,selector:"#native-result",contains:fixture.expected,timeout:1000});
    assert.equal(await invoke("browser_eval",{tabId,expression:"window.releaseCount"}),1);
  });
  await scenario("competing owner rejection, release and safe reacquisition",async()=>{
    const current=await invoke("browser_session_status",{tabId});assert.equal(current.canWrite,true);
    await invoke("browser_ensure_session",{tabId,agentId:competitor},/TAB_OCCUPIED/);
    await invoke("browser_session",{action:"renew",sessionId:current.sessionId});
    await invoke("browser_session",{action:"release",sessionId:current.sessionId,tabId});
    await until(async()=>{const snapshot=await invoke("browser_session_status",{tabId});return snapshot.reacquireAllowed && !snapshot.currentOwner;},"release drain");
    const replacement=await invoke("browser_session",{action:"acquire",tabId,agentId:competitor});assert.ok(replacement.sessionId);
    await invoke("browser_session",{action:"release",tabId,sessionId:replacement.sessionId,agentId:competitor});
    await until(async()=>{const snapshot=await invoke("browser_session_status",{tabId});return snapshot.reacquireAllowed && !snapshot.currentOwner;},"competitor release drain");
    const recovered=await invoke("browser_ensure_session",{tabId});assert.equal(recovered.canWrite,true);assert.notEqual(recovered.sessionId,current.sessionId);
  });
  await scenario("navigation waits for a replaced document",async()=>{
    const before=await invoke("browser_wait",{tabId,selector:"#box",timeout:1000});
    const target=base+"/test?live-release=navigated";
    await invoke("browser_navigate",{tabId,url:target});
    await until(async()=>{const snapshot=await invoke("browser_session_status",{tabId});return snapshot.tab.url===target && snapshot.tab.status==="complete";},"navigation completion");
    const after=await invoke("browser_wait",{tabId,selector:"#box",timeout:5000});assert.notEqual(after.documentId,before.documentId);
    assert.equal((await invoke("browser_type",{tabId,selector:"#box",text:"after navigation"})).typed,true);
  });
  await scenario("public search with fixed non-sensitive query",async()=>{
    const result=await invoke("browser_search",{query:"dsh-browser-bridge GitHub",engine:"bing",maxResults:2});
    assert.ok(result.results.length>0);assert.ok(result.results.every(item=>/^https?:\/\//.test(item.url)));
  });
  await scenario("actual four-minute keep and five-minute idle release",async()=>{
    await delay(Math.max(0,retention.idleExpiresAt-60000-Date.now()));
    const four=await invoke("browser_session_status",{tabId:idleTab,sessionId:retention.sessionId});
    assert.equal(four.canWrite,true);assert.equal(four.sessionId,retention.sessionId);assert.equal(four.idleExpiresAt,retention.idleExpiresAt);
    console.log("PASS actual four-minute idle ownership; waiting for five-minute boundary");
    await delay(Math.max(0,retention.idleExpiresAt+200-Date.now()));
    const expired=await until(async()=>{
      const snapshot=await invoke("browser_session_status",{tabId:idleTab});
      return !snapshot.canWrite && !snapshot.currentOwner?snapshot:false;
    },"five-minute drain");
    retention.elapsedMs=expired.observedAt-(retention.idleExpiresAt-manifest.controlPolicy.idleMs);
    assert.ok(retention.elapsedMs>=300000);assert.ok(retention.elapsedMs<310000);
  });
  success=true;
} finally {
  // Recover only our known fixture modal if a check fails; never dismiss another page's dialog.
  if(nativeTab && !success) {
    try {
      const snapshot=await invoke("browser_dialog",{tabId:nativeTab});
      if(snapshot.known && snapshot.active)await invoke("browser_handle_dialog",{tabId:nativeTab,dialogId:snapshot.active.id,accept:false});
    }catch(error){console.error("Fixture recovery unavailable: "+error.message);}
  }
  const cleanupErrors=[];
  for(const tabId of owned) {
    try {await invoke("browser_ensure_session",{tabId});assert.equal((await invoke("browser_close",{tabId})).closed,tabId);}
    catch(error){cleanupErrors.push({tabId,error:error.message});}
  }
  const finalState=await invoke("browser_status").catch(error=>({error:error.message}));
  await client.close();
  if(success){assert.equal(cleanupErrors.length,0,JSON.stringify(cleanupErrors));assert.equal(finalState.pending,0);assert.equal(finalState.queuedWrites,0);assert.equal(finalState.controlledTabs,0);}
  const report={success:success && cleanupErrors.length===0,version:manifest.version,startedAt:new Date(startedAt).toISOString(),
    elapsedMs:Date.now()-startedAt,cases,usedTools:[...usedTools].sort(),retention,cleanupErrors,
    final:{connected:finalState.connected,versionsMatch:finalState.versionsMatch,pending:finalState.pending,queuedWrites:finalState.queuedWrites,controlledTabs:finalState.controlledTabs}};
  writeFileSync(join(artifacts,"live-release-result.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report,null,2));
}
