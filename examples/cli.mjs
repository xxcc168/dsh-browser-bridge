#!/usr/bin/env node
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {BridgeClient,manifest,errorText,saveImage} from "../lib/runtime.js";
export const CLI_TOOLS=manifest.tools.map(t=>t.name.replace("browser_",""));
export async function main(argv=process.argv.slice(2)) {
  const [cmd,...rest]=argv;
  if(!cmd || cmd==="help") {
    console.log("browser-bridge CLI\n"+CLI_TOOLS.join(" | ")+"\ncall <browser_tool> <JSON>\ncall <browser_tool> --file <JSON文件>\nraw <METHOD> <path> [JSON]\n兼容: read <id> [--html], click <id> <selector> [--index=N], type <id> <selector> <text>, shot <id> [file.png]");
    return;
  }
  const client=new BridgeClient({autoStart:false,namespace:"cli"});
  try {
    let name,args;
    if(cmd==="call") {
      name=rest[0].startsWith("browser_")?rest[0]:"browser_"+rest[0];
      args=JSON.parse(rest[1]==="--file"?readFileSync(rest[2],"utf8"):(rest[1] || "{}"));
    } else if(cmd==="raw") {
      const identity=client.identity(process.env.DSH_AGENT_ID,process.env.DSH_AGENT_NAME);
      console.log(JSON.stringify(await client.request(rest[0],rest[1],rest[2]?JSON.parse(rest[2]):undefined,identity),null,2));return;
    } else {
      name="browser_"+(cmd==="shot"?"screenshot":cmd);
      const pos=rest.filter(s=>!s.startsWith("--"));
      const flag=k=>rest.find(s=>s.startsWith("--"+k+"="))?.slice(k.length+3);
      args={};
      if(!["status","tabs","open","search","request_status","session"].includes(cmd))args.tabId=Number(pos[0]);
      if(cmd==="tabs")args.activeOnly=rest.includes("--active");
      if(cmd==="open") {args.url=pos[0];args.active=rest.includes("--active");}
      if(cmd==="navigate")args.url=pos[1];
      if(["extract","click","type","wait","scroll","check","select","hover"].includes(cmd))args.selector=pos[1];
      if(cmd==="read" && rest.includes("--html")) {
        const identity=client.identity(flag("agentId") || process.env.DSH_AGENT_ID,process.env.DSH_AGENT_NAME);
        const data=await client.request("GET","/api/tabs/"+args.tabId+"/content?maxHtml=300000",undefined,identity);
        console.log(data.html || "");return;
      }
      if(cmd==="extract" && pos[2])args.max=Number(pos[2]);
      if(cmd==="click") {if(flag("text")!==undefined){args.text=flag("text");delete args.selector;}if(flag("index")!==undefined)args.index=Number(flag("index"));}
      if(cmd==="type") {args.text=pos.slice(2).join(" ");args.clear=flag("clear")!=="false";}
      if(cmd==="key")args.key=pos[1];
      if(cmd==="wait" && pos[2])args.timeout=Number(pos[2]);
      if(cmd==="eval")args.expression=pos.slice(1).join(" ");
      if(cmd==="search")args={query:pos[0],engine:pos[1] || "bing",maxResults:Number(pos[2] || 8)};
      if(cmd==="check") {if(!["true","false"].includes(pos[2]))throw Error("check 需要 true 或 false");args.checked=pos[2]==="true";}
      if(cmd==="select")args.value=pos[2];
      if(cmd==="request_status")args={requestId:pos[0]};
      if(cmd==="session")args=JSON.parse(pos.join(" ") || "{}");
      if(cmd==="batch")args.steps=JSON.parse(pos.slice(1).join(" "));
      if(flag("frameId")!==undefined)args.frameId=Number(flag("frameId"));
      if(flag("sessionId"))args.sessionId=flag("sessionId");
      if(flag("agentId"))args.agentId=flag("agentId");
      if(flag("agentName"))args.agentName=flag("agentName");
    }
    const result=await client.run(name,args);
    console.log(result.image?"已保存: "+saveImage(result.image,cmd==="shot"?rest[1]:undefined):result.content);
  } finally {client.close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(error=>{console.error(errorText(error));process.exitCode=1;});
