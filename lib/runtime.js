import {readFileSync,existsSync,mkdirSync,writeFileSync} from "node:fs";
import {spawn} from "node:child_process";
import {randomUUID,createHash} from "node:crypto";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";

export const manifest=JSON.parse(readFileSync(new URL("../tools.manifest.json",import.meta.url),"utf8"));
export const TOOL_CONCURRENCY=Object.freeze(Object.fromEntries(manifest.tools.map(t=>[t.name,t.concurrencySafe])));
export function resolveBridgeDir(configured="") {
  const root=fileURLToPath(new URL("..",import.meta.url));
  const candidates=[configured,process.env.DSH_BROWSER_BRIDGE_DIR,join(root,"bridge"),dirname(root),root,join(root,"browser-bridge"),join(dirname(root),"browser-bridge")];
  return candidates.filter(Boolean).map(p=>resolve(p)).find(p=>existsSync(join(p,"bridge.js"))) || "";
}
function failure(code,message,extra={}) {return Object.assign(new Error(code+": "+message),{code,...extra});}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function validate(schema,value,path="args") {
  const bad=message=>{throw failure("INVALID_ARGUMENT",path+": "+message);};
  if(schema.type==="object") {
    if(!value || typeof value!=="object" || Array.isArray(value))bad("需要对象");
    for(const key of schema.required || []) if(value[key]===undefined)bad("缺少 "+key);
    for(const [key,v] of Object.entries(value)) {
      if(v===undefined)continue;
      if(!schema.properties[key]) {if(schema.additionalProperties===false)bad("未知字段 "+key);}
      else validate(schema.properties[key],v,path+"."+key);
    }
  } else if(schema.type==="array") {
    if(!Array.isArray(value))bad("需要数组");
    if(schema.minItems!==undefined && value.length<schema.minItems)bad("项目过少");
    if(schema.maxItems!==undefined && value.length>schema.maxItems)bad("项目过多");
    value.forEach((v,i)=>validate(schema.items,v,path+"["+i+"]"));
  } else {
    const type=schema.type==="integer"?"number":schema.type;
    if(typeof value!==type)bad("需要 "+schema.type);
    if(type==="number") {
      if(!Number.isFinite(value) || (schema.type==="integer"&&!Number.isInteger(value)))bad("无效数值");
      if(schema.minimum!==undefined && value<schema.minimum)bad("数值过小");
      if(schema.maximum!==undefined && value>schema.maximum)bad("数值过大");
    }
    if(schema.enum && !schema.enum.includes(value))bad("不支持的枚举值");
  }
}

export class BridgeClient {
  constructor(options={}) {
    this.base=(options.url || process.env.DSH_BRIDGE_URL || "http://127.0.0.1:"+ (options.port ?? process.env.DSH_BRIDGE_PORT ?? 8765)).replace(/\/+$/,"");
    this.token=options.token ?? process.env.DSH_BRIDGE_TOKEN ?? "";
    this.dir=resolveBridgeDir(options.bridgeDir);
    this.autoStart=options.autoStart ?? process.env.DSH_BRIDGE_AUTOSTART!=="false";
    this.timeout=options.timeout ?? 60000;
    this.log=options.log || (()=>{});
    this.child=null;this.starting=null;this.restartTimer=null;this.healthTimer=null;
    this.closed=false;this.attempts=0;
    this.namespace=options.namespace || randomUUID();
    this.identities=new Map();this.claims=new Map();this.claiming=new Map();
    this.renewTimer=setInterval(()=>void this.renewControls(),20000);this.renewTimer.unref();
  }
  headers() {return this.token?{Authorization:"Bearer "+this.token}:{};}
  async probe() {
    const res=await fetch(this.base+"/api/status",{headers:this.headers(),signal:AbortSignal.timeout(1500)});
    if(!res.ok) throw failure("STATUS_HTTP_"+res.status,"桥接状态请求失败",{status:res.status});
    const s=await res.json();
    if(s.ok!==true || typeof s.version!=="string") throw failure("UNEXPECTED_SERVICE","端口不是有效桥接服务");
    return s;
  }
  ensureBridge() {
    if(this.closed || !this.autoStart) return Promise.resolve();
    if(this.starting) return this.starting;
    this.starting=(async()=>{
      try {await this.probe();this.attempts=0;return;}
      catch(err) {
        if(err.status || err.code==="UNEXPECTED_SERVICE") {this.log(err.message);return;}
      }
      if(this.child || this.restartTimer || !this.dir || this.closed) return;
      const target=new URL(this.base);
      if(target.protocol!=="http:" || !["127.0.0.1","localhost","[::1]"].includes(target.hostname)) return;
      const child=spawn(process.execPath,["bridge.js"],{
        cwd:this.dir,windowsHide:true,stdio:["ignore","pipe","pipe"],
        env:{...process.env,DSH_BRIDGE_PORT:target.port || "80",DSH_BRIDGE_TOKEN:this.token},
      });
      this.child=child;
      const log=chunk=>this.log(String(chunk).trim().slice(0,1000));
      child.stdout.on("data",log);child.stderr.on("data",log);
      child.on("error",err=>this.log("bridge spawn: "+err.message));
      child.on("close",()=>{
        if(this.child===child) this.child=null;
        if(this.closed || this.restartTimer) return;
        const delay=Math.min(1000*2**Math.min(this.attempts++,4),15000);
        this.restartTimer=setTimeout(()=>{
          this.restartTimer=null;
          const start=()=>void this.ensureBridge();
          if(this.starting) void this.starting.then(start,start);else start();
        },delay);
      });
      const end=Date.now()+8000;
      while(!this.closed && this.child===child && Date.now()<end) {
        try {await this.probe();this.attempts=0;return;}catch{}
        await sleep(200);
      }
    })().catch(err=>this.log(err.message)).finally(()=>{this.starting=null;});
    return this.starting;
  }
  async start() {
    await this.ensureBridge();
    if(this.autoStart && !this.healthTimer) {this.healthTimer=setInterval(()=>void this.ensureBridge(),5000);this.healthTimer.unref();}
  }
  close() {
    this.closed=true;clearInterval(this.healthTimer);clearTimeout(this.restartTimer);clearInterval(this.renewTimer);
    // Only own child processes are managed; external service lifecycle is untouched.
    if(this.child) {this.child.kill();this.child=null;}
  }
  identity(agentId,agentName) {
    if(typeof agentId!=="string" || !agentId.trim() || agentId.length>160)
      throw failure("AGENT_ID_REQUIRED","请提供本任务稳定且唯一的 agentId，或由宿主传入调用者身份");
    const key=agentId.trim();
    if(!this.identities.has(key))this.identities.set(key,{
      owner:createHash("sha256").update(this.namespace+":"+key).digest("hex"),
      ownerName:String(agentName || "Agent "+key.slice(0,12)).slice(0,60),
    });
    return this.identities.get(key);
  }
  async claim(tabId,identity,options) {
    const key=identity.owner+":"+tabId;
    const cached=this.claims.get(key);
    if(cached && Date.now()<cached.expiresAt && Date.now()-cached.activity<120000){cached.activity=Date.now();return cached;}
    if(this.claiming.has(key))return this.claiming.get(key);
    const promise=this.request("POST","/api/sessions",{action:"acquire",tabId},{...options,...identity,requestId:undefined,sessionId:undefined})
      .then(data=>{const entry={...data,...identity,activity:Date.now()};this.claims.set(key,entry);return entry;})
      .finally(()=>this.claiming.delete(key));
    this.claiming.set(key,promise);return promise;
  }
  async renewControls() {
    if(this.closed)return;
    const groups=new Map();
    for(const [key,l] of this.claims) {
      if(Date.now()-l.activity>=120000 && !l.running){this.claims.delete(key);continue;}
      const group=groups.get(l.owner) || [];group.push(l);groups.set(l.owner,group);
    }
    for(const entries of groups.values()) {
      try {
        const data=await this.request("POST","/api/sessions",{action:"renew",sessionIds:entries.map(l=>l.sessionId)},
          {...entries[0],deadline:Date.now()+5000,requestId:undefined,sessionId:undefined});
        for(const l of entries) {
          if(data.renewed.includes(l.sessionId))l.expiresAt=Date.now()+55000;
          else this.claims.delete(l.owner+":"+l.tabId);
        }
      }catch{/* Lease TTL remains the fallback when the transport disappears. */}
    }
  }
  async releaseControls() {
    const entries=[...this.claims.values()];this.claims.clear();
    await Promise.allSettled(entries.map(l=>this.request("POST","/api/sessions",{action:"release",sessionId:l.sessionId},
      {...l,deadline:Date.now()+1500,sessionId:undefined,requestId:undefined})));
  }
  async request(method,path,body,options={}) {
    const deadline=options.deadline ?? Date.now()+this.timeout;
    const endpoint=path.split("?")[0];
    const safe=(method==="GET" && !endpoint.endsWith("/screenshot")) || endpoint.endsWith("/wait");
    let id=options.requestId || randomUUID();
    for(let attempt=0;attempt<(safe?3:1);attempt++) {
      if(options.signal?.aborted) throw failure("CANCELLED","调用已取消",{requestId:id});
      const left=deadline-Date.now();
      if(left<=0) throw failure("DEADLINE_EXCEEDED","工具总时限已到",{requestId:id});
      try {
        const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(left)]):AbortSignal.timeout(left);
        const res=await fetch(this.base+path,{
          method,headers:{...this.headers(),...(body===undefined?{}:{"Content-Type":"application/json"}),
            "X-DSH-Request-Id":id,"X-DSH-Deadline":String(deadline),
            ...(options.owner?{"X-DSH-Owner":options.owner,"X-DSH-Agent-Name":encodeURIComponent(options.ownerName || "Agent")}:{ }),
            ...(options.sessionId?{"X-DSH-Session":options.sessionId}:{})},
          body:body===undefined?undefined:JSON.stringify(body),signal,
        });
        const data=await res.json();
        if(!res.ok) throw failure(data.code || "HTTP_"+res.status,data.error || "桥接请求失败",
          {status:res.status,requestId:data.requestId || id,state:data.state,details:data});
        if(data?.ok===false) throw failure(data.code || "ACTION_FAILED",data.error || "操作失败",{requestId:id,details:data});
        if(path.endsWith("/wait") && data?.found!==true) throw failure("WAIT_TIMEOUT","等待条件未满足",{requestId:id});
        if(path.endsWith("/type") && data?.typed!==true) throw failure("INPUT_FAILED","输入未生效",{requestId:id});
        return data;
      } catch(err) {
        const transient=err.status===503 || /ECONNREFUSED|ECONNRESET|fetch failed|Frame with ID/.test(err.message+" "+err.cause?.code);
        if(safe && attempt<2 && transient && !options.signal?.aborted && Date.now()<deadline) {
          await this.ensureBridge();await sleep(Math.min(200*2**attempt,Math.max(0,deadline-Date.now())));
          // A retry is a new read attempt, not replay of a cached failed request.
          id=randomUUID();
          continue;
        }
        if(!err.code) err.code=options.signal?.aborted?"CANCELLED":"TRANSPORT_ERROR";
        err.requestId ||= id;
        if(!safe && !err.status) err.state="unknown";
        throw err;
      }
    }
  }
  async run(name,args={},options={}) {
    const tool=manifest.tools.find(t=>t.name===name);
    if(!tool) throw failure("UNKNOWN_TOOL",name);
    validate(tool.inputSchema,args);
    const timeout=name==="browser_batch"?(args.timeout ?? this.timeout):this.timeout;
    const deadline=Date.now()+timeout;
    // The transport may be shared by multiple DSH tasks; ownership is explicit.
    const publicTool=["browser_status","browser_tabs"].includes(name);
    const identity=publicTool?{}:this.identity(options.agentId || args.agentId || process.env.DSH_AGENT_ID,
      options.agentName || args.agentName || process.env.DSH_AGENT_NAME);
    const context={...options,...identity,deadline,sessionId:args.sessionId,requestId:args.requestId};
    const call=(method,path,body,overrides={})=>this.request(method,path,body,{...context,...overrides});
    const text=data=>({content:JSON.stringify(data),data});
    if(name==="browser_status") return text(await call("GET","/api/status"));
    if(name==="browser_tabs") {
      const tabs=await call("GET","/api/tabs");
      return {content:tabs.filter(t=>!args.activeOnly || t.active).map(t=>t.id+"\t"+(t.active?"*":" ")+"\t"+(t.title || "").slice(0,60)+"\t"+t.url+
        (t.control?"\t占用："+t.control.agentName+"（"+t.control.state+"）":"\t空闲")).join("\n")};
    }
    if(name==="browser_request_status") return text(await call("GET","/api/requests/"+encodeURIComponent(args.requestId),undefined,{requestId:undefined}));
    const ready=await call("GET","/api/status",undefined,{requestId:undefined});
    if(ready.protocolVersion!==3 || ready.extension?.protocolVersion!==3) throw failure("UPGRADE_REQUIRED","需要新版 bridge 和已重载的 Chrome 扩展（协议 3，独占控制）");
    if(name==="browser_session") {
      const body={...args};delete body.agentId;delete body.agentName;
      const data=await call("POST","/api/sessions",body,{requestId:undefined});
      if(args.action==="release")for(const [key,l] of this.claims)if(l.sessionId===args.sessionId)this.claims.delete(key);
      if(args.action==="acquire")this.claims.set(identity.owner+":"+args.tabId,{...data,...identity,activity:Date.now()});
      return text(data);
    }
    if(name==="browser_search") return this.search(args,context);
    let lease;
    if(args.tabId!==undefined) {
      lease=await this.claim(args.tabId,identity,context);
      if(args.sessionId && args.sessionId!==lease.sessionId)throw failure("SESSION_EXPIRED","旧控制会话不能用于新的占用");
      context.sessionId=lease.sessionId;
    }
    const body={...args};delete body.requestId;delete body.sessionId;delete body.tabId;delete body.agentId;delete body.agentName;
    const action=tool.action;
    let method="POST",path="/api/tabs/"+args.tabId+"/"+(action==="readPage"?"content":action==="evaluate"?"evaluate":action);
    if(action==="open") path="/api/tabs";
    if(action==="close") {method="DELETE";path="/api/tabs/"+args.tabId;}
    if(["readPage","extract","screenshot","frames"].includes(action)) {
      method="GET";
      const query=new URLSearchParams(Object.entries(body).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]));
      if(query.size) path+="?"+query;
    }
    if(lease)lease.running=(lease.running || 0)+1;
    let data;
    try {data=await call(method,path,method==="GET"?undefined:body);}
    catch(error) {
      if(lease && ["SESSION_EXPIRED","CONTROL_REVOKED","CONTROL_STOPPED"].includes(error.code))this.claims.delete(identity.owner+":"+args.tabId);
      throw error;
    } finally {if(lease){lease.running--;lease.activity=Date.now();}}
    if(action==="open" && data.control)this.claims.set(identity.owner+":"+data.id,{...data.control,...identity,activity:Date.now()});
    if(action==="close")this.claims.delete(identity.owner+":"+args.tabId);
    if(action==="screenshot") {
      if(!/^data:image\/png;base64,/.test(data.dataUrl || "")) throw failure("INVALID_IMAGE","无效截图");
      return {content:"截图已生成",image:{mimeType:"image/png",data:data.dataUrl.split(",")[1]}};
    }
    if(action==="readPage") return {content:JSON.stringify({title:data.title,url:data.url,documentId:data.documentId,
      offset:data.offset,totalChars:data.totalChars,truncated:data.truncated,nextOffset:data.nextOffset})+"\n"+data.text,data};
    if(action==="evaluate" && typeof data.json==="string") return {content:data.json,data};
    return text(data);
  }
  async search(args,context) {
    const engines={
      bing:{url:"https://www.bing.com/search?q=",wait:"li.b_algo",title:"li.b_algo h2 a",snippet:"li.b_algo p"},
      baidu:{url:"https://www.baidu.com/s?wd=",wait:"#content_left",title:"#content_left h3 a"},
      google:{url:"https://www.google.com/search?q=",wait:"div#search",title:"div#search a h3",pool:"div#search a"},
    };
    const spec=engines[args.engine || "bing"];if(!spec)throw failure("INVALID_ENGINE","未知搜索引擎");
    let sessionId;
    const call=(method,path,body)=>this.request(method,path,body,{...context,requestId:undefined,sessionId});
    const tab=await call("POST","/api/tabs",{url:spec.url+encodeURIComponent(args.query),active:false});
    sessionId=tab.control.sessionId;
    const searchLease={...tab.control,owner:context.owner,ownerName:context.ownerName,activity:Date.now(),running:1};
    this.claims.set(context.owner+":"+tab.id,searchLease);
    let succeeded=false;
    try {
      try {await call("POST","/api/tabs/"+tab.id+"/wait",{selector:spec.wait,timeout:15000});}
      catch(err) {if(err.code!=="WAIT_TIMEOUT") throw err;}
      const extract=async selector=>selector?(await call("GET","/api/tabs/"+tab.id+"/extract?"+new URLSearchParams({selector,max:"16000",limit:"20"}))).items:[];
      const titles=await extract(spec.title),snippets=await extract(spec.snippet),pool=await extract(spec.pool);
      if(!titles.length) throw failure("SEARCH_EMPTY","未解析到结果；已保留搜索标签页 "+tab.id);
      const results=titles.slice(0,args.maxResults ?? 8).map((t,i)=>{
        let url=t.href || pool.find(p=>p.text===t.text)?.href || "";
        try {
          const u=new URL(url),raw=u.searchParams.get("u");
          if(/(^|\.)bing\.com$/.test(u.hostname)&&u.pathname.startsWith("/ck/a")&&raw?.startsWith("a1")){
            const decoded=Buffer.from(raw.slice(2),"base64url").toString("utf8");
            if(/^https?:\/\//.test(decoded))url=decoded;
          }
        } catch{}
        return {title:t.text.slice(0,200),url,snippet:(snippets[i]?.text || "").slice(0,300)};
      });
      succeeded=true;return {content:JSON.stringify({results}),data:{results}};
    } catch(err) {err.details={...(err.details || {}),tabId:tab.id,preserved:true};throw err;}
    finally {
      searchLease.running=0;searchLease.activity=Date.now();
      if(succeeded) {
        await this.request("DELETE","/api/tabs/"+tab.id,undefined,{...context,sessionId,requestId:undefined,deadline:Date.now()+3000}).catch(()=>{});
        this.claims.delete(context.owner+":"+tab.id);
      }
    }
  }
}
export function errorText(error) {
  return JSON.stringify({error:error.message,code:error.code || "ERROR",requestId:error.requestId,
    state:error.state,...(error.details?{details:error.details}:{})});
}
export function saveImage(image,file) {
  const target=resolve(file || join(process.env.DSH_BRIDGE_ARTIFACT_DIR || join(tmpdir(),"dsh-browser-bridge"),"shot-"+randomUUID()+".png"));
  mkdirSync(dirname(target),{recursive:true});writeFileSync(target,Buffer.from(image.data,"base64"));
  return target;
}
