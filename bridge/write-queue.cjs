"use strict";

const queueError=(code,message,statusCode)=>Object.assign(new Error(code+": "+message),{code,statusCode,definitive:true});

// Pending entries are removable; cancelling one never interrupts or reorders the running write.
class WriteQueue {
  constructor(limit=100) {this.limit=limit;this.entries=[];this.active=false;}
  get size() {return this.entries.length+(this.active?1:0);}
  enqueue(task,signal) {
    if(signal?.aborted)return Promise.reject(queueError("CANCELLED","排队请求已取消",499));
    if(this.size>=this.limit)return Promise.reject(queueError("QUEUE_FULL","写队列已满",429));
    return new Promise((resolve,reject)=>{
      const entry={task,signal,resolve,reject};
      entry.abort=()=>{
        const index=this.entries.indexOf(entry);
        if(index<0)return;
        this.entries.splice(index,1);signal.removeEventListener("abort",entry.abort);
        reject(queueError("CANCELLED","排队请求已取消，未发送到扩展",499));
      };
      signal?.addEventListener("abort",entry.abort,{once:true});
      this.entries.push(entry);this.drain();
    });
  }
  drain() {
    if(this.active)return;
    const entry=this.entries.shift();if(!entry)return;
    this.active=true;entry.signal?.removeEventListener("abort",entry.abort);
    // The task rechecks its context just before dispatch; running cancellation stays transport-owned.
    void Promise.resolve().then(entry.task).then(entry.resolve,entry.reject)
      .finally(()=>{this.active=false;this.drain();});
  }
}
module.exports={WriteQueue};
