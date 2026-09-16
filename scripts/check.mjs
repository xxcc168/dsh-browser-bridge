import {readdirSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const root=fileURLToPath(new URL("..",import.meta.url));
function sources(dir) {
  return readdirSync(join(root,dir),{withFileTypes:true}).flatMap(entry=>{
    const path=join(dir,entry.name);
    return entry.isDirectory()?sources(path):/\.(?:c?js|mjs)$/.test(entry.name)?[path]:[];
  });
}
const files=["selfcheck.mjs",...['bridge','extension','lib','examples','scripts','tests'].flatMap(sources)];
for(const file of files) {
  const result=spawnSync(process.execPath,["--check",file],{cwd:root,stdio:"inherit",windowsHide:true});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status || 1);
}
console.log(`Syntax checked ${files.length} JavaScript files.`);
