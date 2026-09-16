import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {manifest,validate} from "../lib/runtime.js";
const source=readFileSync(new URL("../extension/background.js",import.meta.url),"utf8");
const pageCode=source.slice(source.indexOf("async function pageAction"),source.indexOf("chrome.alarms.create"));
function environment() {
  class Element {
    constructor(tag="BUTTON",props={}) {Object.assign(this,{tagName:tag,textContent:"Test",innerText:"Test",children:[],disabled:false,id:"",clicks:0,events:[],value:""},props);}
    getClientRects(){return this.hidden?[]:[{}];}
    getAttribute(name){return this[name] ?? null;}
    scrollIntoView(){this.scrolled=true;}
    focus(){doc.activeElement=this;}
    dispatchEvent(event){this.events.push(event.type);return true;}
    click(){this.clicks++;if(["checkbox","radio"].includes(this.type))this.checked=!this.checked;this.dispatchEvent({type:"click"});}
  }
  class Input extends Element {}
  Object.defineProperty(Input.prototype,"value",{get(){return this._value || "";},set(v){this._value=v;},configurable:true});
  const nodes=new Map();
  const doc={title:"Fixture",readyState:"complete",activeElement:null,querySelectorAll:s=>nodes.get(s)||[],body:new Element("BODY")};
  const context={document:doc,location:{href:"https://fixture.test/"},window:{scrollBy(){}},getComputedStyle:()=>({visibility:"visible",display:"block"}),
    HTMLInputElement:Input,HTMLTextAreaElement:Input,Event:class{constructor(type){this.type=type;}},MouseEvent:class{constructor(type){this.type=type;}},
    KeyboardEvent:class{constructor(type){this.type=type;}},Node:Element,setTimeout,clearTimeout};
  vm.createContext(context);vm.runInContext(pageCode,context);
  return {Element,Input,nodes,doc,context,run:cmd=>context.pageAction(cmd)};
}
test("one click fires once; ambiguous/out-of-range/disabled targets never click",async()=>{
  const e=environment(),a=new e.Element(),b=new e.Element();
  e.nodes.set("#button",[a]);await e.run({action:"click",selector:"#button"});
  assert.equal(a.clicks,1);assert.equal(a.events.filter(x=>x==="click").length,1);
  e.nodes.set(".many",[a,b]);
  await assert.rejects(e.run({action:"click",selector:".many"}),/AMBIGUOUS_ELEMENT/);
  await assert.rejects(e.run({action:"click",selector:"#button",index:2}),/INVALID_INDEX/);
  b.disabled=true;await assert.rejects(e.run({action:"click",selector:".many",index:1}),/ELEMENT_DISABLED/);
  assert.equal(a.clicks,1);assert.equal(b.clicks,0);
});
test("checkbox is idempotent; legacy type reaches checkbox branch; unsupported input fails",async()=>{
  const e=environment(),box=new e.Input("INPUT",{type:"checkbox",checked:false});
  e.nodes.set("#box",[box]);
  await e.run({action:"check",selector:"#box",checked:true});await e.run({action:"check",selector:"#box",checked:true});
  assert.equal(box.checked,true);assert.equal(box.clicks,1);
  await e.run({action:"type",selector:"#box",text:"false"});assert.equal(box.checked,false);
  e.nodes.set("#div",[new e.Element("DIV")]);
  await assert.rejects(e.run({action:"type",selector:"#div",text:"x"}),/UNSUPPORTED_ELEMENT/);
});
test("typing preserves value without echo; select option index is not element index",async()=>{
  const e=environment(),input=new e.Input("INPUT");e.nodes.set("#input",[input]);
  const result=await e.run({action:"type",selector:"#input",text:"private-value"});
  assert.equal(input.value,"private-value");assert.equal(result.verified,true);assert.equal(result.value,undefined);
  const select=new e.Element("SELECT",{options:[{value:"a",textContent:"A"},{value:"b",textContent:"B"}]});
  e.nodes.set("#select",[select]);
  await e.run({action:"select",selector:"#select",index:1});assert.equal(select.value,"b");
});
test("wait fails on timeout and supports hidden/visible/enabled without scrolling",async()=>{
  const e=environment(),hidden=new e.Element("DIV",{hidden:true});e.nodes.set("#hidden",[hidden]);
  await assert.rejects(e.run({action:"wait",selector:"#missing",timeout:1}),/WAIT_TIMEOUT/);
  await assert.rejects(e.run({action:"wait",selector:"#hidden",state:"visible",timeout:1}),/WAIT_TIMEOUT/);
  const out=await e.run({action:"wait",selector:"#hidden",state:"hidden",timeout:1});
  assert.equal(out.found,true);assert.equal(hidden.scrolled,undefined);
});
test("read/extract have budgets and pagination; no HTML by default",async()=>{
  const e=environment();e.doc.body.innerText="x".repeat(20000);
  const first=await e.run({action:"readPage",maxText:8000});
  assert.equal(first.text.length,8000);assert.equal(first.nextOffset,8000);assert.equal(first.html,undefined);
  const second=await e.run({action:"readPage",maxText:8000,offset:first.nextOffset});assert.equal(second.offset,8000);
  e.nodes.set(".huge",Array.from({length:100},(_,i)=>new e.Element("DIV",{innerText:'"\n'.repeat(50000),id:String(i)})));
  const out=await e.run({action:"extract",selector:".huge",max:4000,limit:50});
  assert.equal(out.totalCount,100);assert.ok(JSON.stringify(out.items).length<=4100);assert.equal(out.truncated,true);assert.ok(out.nextOffset>0);
});
test("open shadow traversal and exact semantic locators resolve",async()=>{
  const e=environment(),button=new e.Element(),shadow={querySelectorAll:s=>s==="#button"?[button]:[]};
  e.nodes.set("#host",[new e.Element("DIV",{shadowRoot:shadow})]);
  await e.run({action:"click",selector:"#host >>> #button"});assert.equal(button.clicks,1);
  e.nodes.set("label",[{textContent:"Name",control:button}]);
  await e.run({action:"click",selector:"label=Name"});assert.equal(button.clicks,2);
});
test("eval awaits promises and rejects stale URL before DOM writes",async()=>{
  const e=environment();
  const value=await e.context.evaluateExpr({expression:"Promise.resolve(42)"});
  assert.equal(value.json,"42");
  await assert.rejects(e.run({action:"click",expectedUrl:"https://old.test/"}),/STALE_PAGE/);
});
test("force reconnect changes socket; stale close and replies cannot poison replacement",async()=>{
  const sockets=[];let url="ws://old/ws";
  class Socket {
    static OPEN=1;static CONNECTING=0;
    constructor(address){this.url=address;this.readyState=0;this.sent=[];sockets.push(this);}
    close(){this.readyState=3;this.onclose?.();}
    send(raw){this.sent.push(JSON.parse(raw));}
    open(){this.readyState=1;this.onopen?.();}
  }
  const context={WebSocket:Socket,chrome:{storage:{local:{get:async()=>({wsUrl:url})},session:{get:async defaults=>defaults,set:async()=>{}}},runtime:{getManifest:()=>({name:"test",version:"1.2.0"})}},
    console,setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){}};
  vm.createContext(context);
  context.importScripts=()=>vm.runInContext(readFileSync(new URL("../extension/control.js",import.meta.url),"utf8"),context);
  vm.runInContext(source.slice(0,source.indexOf("chrome.alarms.create")),context);
  await context.connect();sockets[0].open();url="ws://new/ws";
  await context.connect(true);sockets[1].open();sockets[0].onclose();
  assert.equal(sockets[1].url,url);assert.equal(vm.runInContext("ws",context),sockets[1]);
  let finish,calls=0;
  context.runCommand=()=>{calls++;return new Promise(r=>{finish=r;});};
  const request=JSON.stringify({type:"command",id:"same",command:{action:"click"}});
  const a=context.handleMessage(sockets[1],request);
  const b=context.handleMessage(sockets[1],request);
  await new Promise(r=>setImmediate(r));
  finish({clicked:true});await Promise.all([a,b]);assert.equal(calls,1);
  const replies=sockets[1].sent.filter(x=>x.type==="response");assert.equal(replies.length,2);
});
test("shared manifest validates nested batch data and numeric budgets",()=>{
  const batch=manifest.tools.find(t=>t.name==="browser_batch").inputSchema;
  assert.throws(()=>validate(batch,{tabId:1,steps:[{action:"deleteDatabase"}]}),/INVALID_ARGUMENT/);
  assert.throws(()=>validate(batch,{tabId:1,steps:[],timeout:-1}),/INVALID_ARGUMENT/);
  validate(batch,{tabId:1,steps:[{action:"check",selector:"#c",checked:true}]});
});
