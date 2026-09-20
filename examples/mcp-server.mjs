#!/usr/bin/env node
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {z} from "zod";
import {BridgeClient,manifest,errorText} from "../lib/runtime.js";

function schema(s) {
  let result;
  if(s.enum) result=z.enum(s.enum);
  else if(s.type==="object") result=z.object(Object.fromEntries(Object.entries(s.properties || {}).map(([k,v])=>[k,(s.required || []).includes(k)?schema(v):schema(v).optional()]))).strict();
  else if(s.type==="array") {
    result=z.array(schema(s.items));if(s.minItems!==undefined)result=result.min(s.minItems);if(s.maxItems!==undefined)result=result.max(s.maxItems);
  } else if(s.type==="boolean") result=z.boolean();
  else if(s.type==="number" || s.type==="integer") {
    result=z.number();if(s.type==="integer")result=result.int();
    if(s.minimum!==undefined)result=result.min(s.minimum);if(s.maximum!==undefined)result=result.max(s.maximum);
  } else result=z.string();
  return s.description?result.describe(s.description):result;
}
const client=new BridgeClient({log:message=>console.error("[browser-bridge]",message)});
const server=new McpServer({name:manifest.package,version:manifest.version});
for(const tool of manifest.tools) {
  const shape=Object.fromEntries(Object.entries(tool.inputSchema.properties).map(([key,value])=>[key,
    tool.inputSchema.required.includes(key)?schema(value):schema(value).optional()]));
  server.registerTool(tool.name,{
    title:tool.title,description:tool.description,inputSchema:shape,
    annotations:{readOnlyHint:["browser_status","browser_tabs","browser_request_status","browser_session_status"].includes(tool.name),
      destructiveHint:!tool.concurrencySafe,openWorldHint:true},
  },async(args,extra)=>{
    try {
      // A transport session/request id is not a task identity. Shared clients must
      // provide a stable host metadata id, explicit agentId, or DSH_AGENT_ID.
      const result=await client.run(tool.name,args,{signal:extra.signal,
        agentId:extra._meta?.["dsh/agentId"],agentName:extra._meta?.["dsh/agentName"]});
      if(result.image) return {content:[{type:"image",...result.image}]};
      return {content:[{type:"text",text:result.content}]};
    } catch(err) {return {isError:true,content:[{type:"text",text:errorText(err)}]};}
  });
}
const dispose=async()=>{await client.releaseControls();client.close();};
process.once("exit",()=>client.close());
process.once("SIGINT",()=>void dispose().finally(()=>server.close()));
process.once("SIGTERM",()=>void dispose().finally(()=>server.close()));
process.stdin.once("end",()=>void dispose().finally(()=>server.close()));
await client.start();
await server.connect(new StdioServerTransport());
