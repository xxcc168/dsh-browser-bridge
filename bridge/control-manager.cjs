"use strict";
const {randomUUID}=require("node:crypto");
const problem=(code,message)=>Object.assign(new Error(code+": "+message),{code,statusCode:409,definitive:true});

// A synchronous admission decision precedes queue insertion. Extension acknowledgement
// fences each lease; expiry never hands a tab to another owner before revocation drains.
class ControlManager {
  constructor({now=Date.now,sync,onRevoke=()=>{},leaseMs=120000,idleMs=180000}={}) {
    this.now=now;this.sync=sync;this.onRevoke=onRevoke;this.leaseMs=leaseMs;this.idleMs=idleMs;
    this.leases=new Map();this.blocked=new Map();
  }
  public(l) {
    return l?{tabId:l.tabId,sessionId:l.id,agentName:l.name,state:l.state,expiresAt:l.expiresAt,
      idleExpiresAt:l.lastActivity+this.idleMs,reason:l.reason || null}:null;
  }
  assertOwner(owner) {
    if(typeof owner!=="string" || !/^[A-Za-z0-9_.:-]{16,160}$/.test(owner))
      throw problem("AGENT_ID_REQUIRED","缺少稳定的任务身份；MCP/CLI 请提供 agentId 或 DSH_AGENT_ID");
  }
  admit(tabId,owner,name,sessionId,{activity=true,provisionalId}={}) {
    this.assertOwner(owner);
    let l=this.leases.get(tabId);
    if(l?.state==="active" && (this.now()>=l.expiresAt || (l.pending===0 && this.now()-l.lastActivity>=this.idleMs))) {
      this.revoke(l,this.now()>=l.expiresAt?"lease_expired":"idle_timeout");l=this.leases.get(tabId);
    }
    if(this.blocked.get(tabId)?.has(owner))throw problem("CONTROL_STOPPED","用户已终止此任务的页面占用；需要用户允许后才能再次申请");
    if(l) {
      if(l.owner!==owner)throw problem("TAB_OCCUPIED","页面正在由 "+l.name+" 占用");
      if(!["active","acquiring"].includes(l.state))throw problem("CONTROL_STOPPING","旧操作仍在停止或等待确认");
      if(sessionId && sessionId!==l.id)throw problem("SESSION_EXPIRED","控制会话已失效");
      if(activity)l.lastActivity=this.now();
      l.expiresAt=Math.min(this.now()+this.leaseMs,l.lastActivity+this.idleMs);
      return l;
    }
    if(sessionId)throw problem("SESSION_EXPIRED","控制会话已释放，旧凭据不得自动重建");
    l={id:provisionalId || randomUUID(),tabId,owner,name:String(name || "Agent").replace(/[\u0000-\u001f]/g," ").slice(0,60),
      state:"acquiring",lastActivity:this.now(),expiresAt:this.now()+this.leaseMs,pending:0};
    this.leases.set(tabId,l);
    l.ready=this.sync(l,"grant").then(reply=>{
      if(this.leases.get(tabId)!==l || l.state!=="acquiring")throw problem("CONTROL_STOPPED","获取期间控制已被撤销");
      l.state="active";l.confirmation=reply;return l;
    }).catch(err=>{
      // A lost grant acknowledgement is not proof the extension did not install it.
      if(this.leases.get(tabId)===l)this.revoke(l,"grant_failed");
      throw err;
    });
    l.ready.catch(()=>{});
    return l;
  }
  check(l,owner) {
    if(!l || this.leases.get(l.tabId)!==l || l.owner!==owner || l.state!=="active" || this.blocked.get(l.tabId)?.has(owner))
      throw problem("CONTROL_REVOKED","页面控制权已撤销");
    if(this.now()>=l.expiresAt || (l.pending===0 && this.now()-l.lastActivity>=this.idleMs)) {
      this.revoke(l,"lease_expired");throw problem("SESSION_EXPIRED","页面占用已过期");
    }
  }
  async confirm(l,owner) {
    await l.ready;
    this.check(l,owner);
    if(!l.confirming)l.confirming=(async()=>{
      try {
        l.confirmation=await this.sync(l,"renew");
        this.check(l,owner);
        return l;
      } catch(err) {
        void this.revoke(l,"renew_failed");
        throw err;
      }
    })().finally(()=>{l.confirming=null;});
    return l.confirming;
  }
  async ensure(tabId,owner,name) {
    this.assertOwner(owner);
    this.sweep();
    const previous=this.leases.get(tabId);
    // Only a confirmed drain permits reuse. Manual stops remain owner-blocked.
    if(previous?.state==="stopping")await previous.stopping;
    let l=this.admit(tabId,owner,name);
    try {await this.confirm(l,owner);}
    catch(err) {
      if(!["CONTROL_REVOKED","SESSION_EXPIRED"].includes(err.code))throw err;
      await l.stopping;
      if(this.leases.has(tabId))throw err;
      l=this.admit(tabId,owner,name);await this.confirm(l,owner);
    }
    return l;
  }
  async renew(owner,ids) {
    const renewed=[];
    for(const id of ids) {
      const l=[...this.leases.values()].find(x=>x.id===id && x.owner===owner);
      if(!l || l.state!=="active")continue;
      if(this.now()>=l.expiresAt || (l.pending===0 && this.now()-l.lastActivity>=this.idleMs)) {this.revoke(l,"idle_timeout");continue;}
      // Transport liveness may keep an active command alive, but cannot reset idle time.
      l.expiresAt=Math.min(this.now()+this.leaseMs,l.pending?Infinity:l.lastActivity+this.idleMs);
      try {await this.confirm(l,owner);renewed.push(l.id);}catch{/* Failed acknowledgement fences this lease. */}
    }
    return renewed;
  }
  revoke(l,reason,manual=false) {
    if(this.leases.get(l.tabId)!==l)return;
    if(manual) {
      const blocked=this.blocked.get(l.tabId) || new Set();blocked.add(l.owner);this.blocked.set(l.tabId,blocked);
    }
    if(l.state==="stopping")return l.stopping;
    l.state="stopping";l.reason=reason;
    this.onRevoke(l);
    l.stopping=this.sync(l,"revoke").then(reply=>{
      if(reply.drained)this.drained(l.tabId,l.id);
    }).catch(()=>{ /* Keep the tab quarantined until the extension reconciles. */ });
    return l.stopping;
  }
  drained(tabId,id) {
    const l=this.leases.get(tabId);
    if(l?.id===id) {
      if(l.state!=="stopping") {l.state="stopping";l.reason="extension_released";this.onRevoke(l);}
      this.leases.delete(tabId);
    }
  }
  sweep() {
    for(const l of this.leases.values())
      if(l.state==="active" && (this.now()>=l.expiresAt || (l.pending===0 && this.now()-l.lastActivity>=this.idleMs)))this.revoke(l,"idle_timeout");
  }
  closeTab(tabId) {
    const l=this.leases.get(tabId);if(l)this.onRevoke(l,{closed:true});
    this.leases.delete(tabId);this.blocked.delete(tabId);
  }
  release(owner,sessionId) {
    const l=[...this.leases.values()].find(x=>x.id===sessionId);
    if(!l || l.owner!==owner)throw problem("SESSION_EXPIRED","该控制会话不属于当前任务");
    void this.revoke(l,"released");
    return {released:l.state!=="stopping",state:l.state,sessionId:l.id};
  }
}
module.exports={ControlManager,problem};
