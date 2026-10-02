import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import test from "node:test";
import assert from "node:assert/strict";
import { registerAllTools } from "../tools/registry.js";
import { Logger } from "../util/logger.js";
import { RateLimitError } from "../http/errors.js";
import { createNitanServer } from "../server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

async function tools(get: (path:string, options:any)=>Promise<any>) {
  const state:any={ensureSelectedSite:()=>({base:"https://offline.invalid",client:{get}}),hasAuthenticationConfiguredForSite:()=>true};
  const handlers:Record<string,Function>={};
  const fake:any={registerTool:(name:string,_config:any,handler:Function)=>{handlers[name]=handler;}};
  await registerAllTools(fake,state,new Logger("silent"),{hideSelectSite:true});
  return {state,handlers};
}

test("all nine active read tools honor a pre-aborted MCP signal",async()=>{
  let calls=0;const {handlers}=await tools(async()=>{calls++;return{};});
  const controller=new AbortController();controller.abort();
  for(const [name,handler] of Object.entries(handlers)) {
    const result=await handler({topic_id:1,query:"test",username:"tester"},{signal:controller.signal});
    assert.equal(result.isError,true,name);assert.match(JSON.stringify(result.content),/cancelled/i,name);
  }
  assert.equal(calls,0);
});

test("late metadata and summary cannot drive more pages after cancellation",async()=>{
  for(const name of ["discourse_read_topic","discourse_get_trust_level_progress"]) {
    const controller=new AbortController();let calls=0;
    const {handlers}=await tools(async(_path,{signal})=>{calls++;assert.equal(signal,controller.signal);controller.abort();return {highest_post_number:200,posts_count:200,users:[{trust_level:2}]};});
    const result=await handlers[name]({topic_id:1,username:"tester"},{signal:controller.signal});
    assert.equal(result.isError,true);assert.equal(calls,1);
  }
});

const list={notifications:[{notification_type:2,topic_id:1,post_number:1,read:false},{notification_type:2,topic_id:1,post_number:2,read:false}]};
for(const kind of ["cancel","rate","timeout","404"]) test(`notification content handling preserves${kind} semantics`,async()=>{
  const controller=new AbortController();let raw=0;
  const {handlers}=await tools(async(path)=>{
    if(path.startsWith("/notifications")){assert.match(path,/bump_last_seen_reviewable=false/);return list;}
    raw++;
    if(raw===1){
      if(kind==="cancel"){controller.abort();throw new DOMException("cancelled","AbortError");}
      if(kind==="rate")throw new RateLimitError(429,30000);
      if(kind==="timeout")throw new DOMException("deadline","TimeoutError");
      throw new Error("HTTP404");
    }
    return "content";
  });
  const result=await handlers.discourse_list_notifications({limit:2,unread_only:true},{signal:controller.signal});
  assert.equal(result.isError,kind==="404"?undefined:true);
  assert.equal(raw,kind==="404"?2:1);
});

test("actual SDK cancellation reaches a read handler and stops subsequent HTTP work",async()=>{
  let signalSeen:AbortSignal|undefined;let finish!:()=>void;let ended=false;let calls=0;
  const {state}=await tools(async(_path,{signal})=>{
    calls++;signalSeen=signal;
    return new Promise((resolve)=>{finish=()=>{ended=true;resolve({highest_post_number:200,posts_count:200});};signal.addEventListener("abort",finish,{once:true});});
  });
  const server=await createNitanServer(state,new Logger("silent"),"test",{hideSelectSite:true});
  const client=new Client({name:"cancel-proof",version:"1"});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);
  const controller=new AbortController();
  try{
    const call=client.callTool({name:"discourse_read_topic",arguments:{topic_id:1}},undefined,{signal:controller.signal}).catch(e=>e);
    for(let i=0;!signalSeen&&i<100;i++)await new Promise(r=>setTimeout(r,2));
    assert.ok(signalSeen);controller.abort();await call;
    for(let i=0;!ended&&i<100;i++)await new Promise(r=>setTimeout(r,2));
    assert.equal(signalSeen.aborted,true);assert.equal(ended,true);assert.equal(calls,1);
  }finally{finish?.();await client.close();await server.close();}
});


test("real stdio cancellation stops server-side work before transport closes",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"nitan-stdio-cancel-"));
  const program=join(directory,"server.mjs");
  const source=[
    'import fs from "node:fs";',
    `import {createNitanServer} from ${JSON.stringify(new URL("../server.js",import.meta.url).href)};`,
    `import {Logger} from ${JSON.stringify(new URL("../util/logger.js",import.meta.url).href)};`,
    `import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};`,
    `const directory=${JSON.stringify(directory)};`,
    'const state={ensureSelectedSite:()=>({base:"https://offline.invalid",client:{get:async(path,{signal})=>{',
    'fs.writeFileSync(directory+"/started",String(process.pid));',
    'return new Promise(resolve=>{const timer=setInterval(()=>fs.appendFileSync(directory+"/activity","x"),10);',
    'signal.addEventListener("abort",()=>{clearInterval(timer);fs.writeFileSync(directory+"/stopped","yes");resolve({highest_post_number:100,posts_count:100});},{once:true});});',
    '}}})};',
    'const server=await createNitanServer(state,new Logger("silent"),"test",{hideSelectSite:true});',
    'await server.connect(new StdioServerTransport());',
    'process.stdin.on("close",()=>{void server.close().finally(()=>process.exit(0));});',
  ].join("\n");
  await writeFile(program,source);
  const client=new Client({name:"stdio-cancel",version:"1"});
  const transport=new StdioClientTransport({command:process.execPath,args:[program],stderr:"pipe"});
  const waitFor=async(name:string)=>{for(let i=0;i<200;i++){try{return await readFile(join(directory,name),"utf8");}catch{await new Promise(r=>setTimeout(r,5));}}throw new Error("missing cancellation marker");};
  try{
    await client.connect(transport);const controller=new AbortController();
    const result=client.callTool({name:"discourse_read_topic",arguments:{topic_id:1}},undefined,{signal:controller.signal}).catch(e=>e);
    await waitFor("started");controller.abort();await result;await waitFor("stopped");
    const before=await readFile(join(directory,"activity"),"utf8").catch(()=>"");
    await new Promise(r=>setTimeout(r,50));
    assert.equal(await readFile(join(directory,"activity"),"utf8").catch(()=>""),before);
  }finally{await client.close();await rm(directory,{recursive:true,force:true});}
});
