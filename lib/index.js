import z from "@deepseek-ai/schemastery";
import {defineTool} from "@deepseek-ai/dsh-tools";
import {randomUUID} from "node:crypto";
import {BridgeClient,manifest,TOOL_CONCURRENCY,resolveBridgeDir,saveImage,errorText} from "./runtime.js";
const name="browser-bridge";
const inject=["tools"];
const Config=z.object({
  bridgeDir:z.string().default(""),port:z.number().default(8765),autoStart:z.boolean().default(true),
  requestTimeoutMs:z.number().default(60000),searchEngine:z.string().default("bing"),searchMaxResults:z.number().default(8),
});
// DSH's parameter schema uses required flags on properties, unlike JSON Schema arrays.
function parameter(s,required=false) {
  const value=Object.fromEntries(Object.entries(s).filter(([k])=>!["minimum","maximum","minItems","maxItems","required"].includes(k)));
  if(required)value.required=true;
  if(s.type==="object") {
    value.properties=Object.fromEntries(Object.entries(s.properties || {}).map(([k,v])=>[k,parameter(v,(s.required || []).includes(k))]));
    if(!required)delete value.required;
  }
  if(s.type==="array")value.items=parameter(s.items);
  return value;
}
function apply(ctx,config) {
  const logs=[];
  const agents=new WeakMap();
  const client=new BridgeClient({bridgeDir:config.bridgeDir,port:config.port,autoStart:config.autoStart,timeout:config.requestTimeoutMs,
    log:line=>{logs.push(line);if(logs.length>10)logs.shift();}});
  void client.start();
  ctx.on("dispose",async()=>{await client.releaseControls();client.close();});
  for(const entry of manifest.tools) {
    ctx.tools.register(defineTool({
      name:entry.name,description:entry.description,
      parameters:Object.fromEntries(Object.entries(entry.inputSchema.properties).map(([k,v])=>[k,parameter(v,entry.inputSchema.required.includes(k))])),
      timeoutMs:entry.name==="browser_batch"?120000:config.requestTimeoutMs,
      isConcurrencySafe:()=>TOOL_CONCURRENCY[entry.name],
      output:{schema:{type:"object",additionalProperties:false,properties:{content:{type:"string",required:true}}},
        render:(_args,value)=>[{type:"text",text:value.content}]},
      presentCall:()=>({card:"generic",title:entry.title,kind:entry.concurrencySafe?"read":"execute"}),
      async execute(args,exec) {
        try {
          if(entry.name==="browser_search")args={engine:config.searchEngine,maxResults:config.searchMaxResults,...args};
          let agentId;
          if(exec?.agent && typeof exec.agent==="object") {
            if(!agents.has(exec.agent))agents.set(exec.agent,randomUUID());
            agentId=agents.get(exec.agent);
          }
          const result=await client.run(entry.name,args,{signal:exec?.signal,agentId,
            ...(agentId?{agentName:"DSH "+agentId.slice(0,8)}:{})});
          return {content:result.image?JSON.stringify({imagePath:saveImage(result.image),mimeType:"image/png"}):result.content};
        } catch(error) {throw new Error(errorText(error));}
      },
    }));
  }
}
export {Config,apply,inject,name,resolveBridgeDir,TOOL_CONCURRENCY,parameter};
