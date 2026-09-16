import assert from "node:assert/strict";
import {readFileSync,existsSync} from "node:fs";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {resolve} from "node:path";
import {apply} from "./lib/index.js";
import {manifest,TOOL_CONCURRENCY,validate,resolveBridgeDir} from "./lib/runtime.js";
import {CLI_TOOLS} from "./examples/cli.mjs";
const registrations=[],disposals=[];
apply({tools:{register:t=>registrations.push(t)},on:(_event,fn)=>disposals.push(fn)},
  {autoStart:false,port:8765,requestTimeoutMs:60000,searchEngine:"bing",searchMaxResults:8});
try {
  const names=manifest.tools.map(t=>t.name).sort();
  assert.equal(new Set(names).size,names.length);
  assert.deepEqual(registrations.map(t=>t.name).sort(),names);
  assert.deepEqual(CLI_TOOLS.map(t=>"browser_"+t).sort(),names);
  for(const spec of manifest.tools) {
    const registered=registrations.find(t=>t.name===spec.name);
    assert.deepEqual(Object.keys(registered.parameters.properties).sort(),Object.keys(spec.inputSchema.properties).sort());
    assert.deepEqual((registered.parameters.required || []).sort(),[...spec.inputSchema.required].sort());
    assert.equal(TOOL_CONCURRENCY[spec.name],spec.concurrencySafe);
    assert.equal(typeof registered.isConcurrencySafe,"function");
  }
  assert.equal(TOOL_CONCURRENCY.browser_eval,false);
  const pkg=JSON.parse(readFileSync(new URL("./package.json",import.meta.url),"utf8"));
  const lock=JSON.parse(readFileSync(new URL("./package-lock.json",import.meta.url),"utf8"));
  assert.equal(pkg.version,manifest.version);
  assert.equal(lock.version,pkg.version);assert.equal(lock.packages[""].version,pkg.version);
  assert.ok(pkg.files.includes("lib"));assert.ok(pkg.files.includes("tools.manifest.json"));
  for(const path of ["bridge","extension","examples"])assert.ok(pkg.files.includes(path));
  assert.deepEqual(lock.packages[""].dependencies,pkg.dependencies);
  assert.deepEqual(lock.packages[""].engines,pkg.engines);
  const originalDir=process.env.DSH_BROWSER_BRIDGE_DIR;
  try {
    delete process.env.DSH_BROWSER_BRIDGE_DIR;
    assert.equal(resolveBridgeDir(),resolve(fileURLToPath(new URL("./bridge",import.meta.url))));
  } finally {
    if(originalDir!==undefined)process.env.DSH_BROWSER_BRIDGE_DIR=originalDir;
  }
  const require=createRequire(new URL("./bridge/bridge.js",import.meta.url));
  assert.equal(require("ws/package.json").version,lock.packages["node_modules/ws"].version);
  assert.equal(require("./package.json").type,"commonjs");
  const extension=JSON.parse(readFileSync(new URL("./extension/manifest.json",import.meta.url),"utf8"));
  for(const path of [extension.background.service_worker,extension.action.default_popup,...Object.values(extension.icons)]) {
    assert.ok(existsSync(new URL("./extension/"+path,import.meta.url)),"Missing extension resource: "+path);
  }
  const batch=manifest.tools.find(t=>t.name==="browser_batch").inputSchema;
  assert.throws(()=>validate(batch,{tabId:1,steps:[]}),/INVALID_ARGUMENT/);
  console.log(JSON.stringify({manifestTools:names.length,dshRegistrations:registrations.length,cliTools:CLI_TOOLS.length,
    parameterNamesAndRequiredMatch:true,concurrencyMatch:true,packageMetadataMatch:true,bundledComponentsMatch:true,
    note:"MCP schema and transport behavior are verified by tests/transport.test.mjs."},null,2));
} finally {disposals.forEach(fn=>fn());}
