import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudscraperClient } from "../http/cloudscraper.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HttpClient } from "../http/client.js";
import { Logger } from "../util/logger.js";
import { withSiteRequest } from "../http/rate_limit.js";
const pause = (ms:number) => new Promise(resolve => setTimeout(resolve, ms));
function client(timeoutMs = 1000) {
  const c = new HttpClient({ baseUrl:`https://${randomUUID()}.invalid`, timeoutMs, logger:new Logger("silent"), auth:{type:"none"} });
  (c as any).cloudscraperClient=undefined;(c as any).curlCffiClient=undefined;
  return c;
}

test("queued deadline expires before any backend starts", async () => {
  const c=client(30); const origin=(c as any).base.origin;
  let release!:()=>void; const blocker=withSiteRequest(origin,()=>new Promise<void>(r=>{release=r}),undefined,0);
  while(!release) await pause(1);
  let calls=0;(c as any).requestUnscheduled=async()=>{calls++;return{};};
  await assert.rejects(c.get("/hot.json"),{name:"TimeoutError"});
  assert.equal(calls,0);release();await blocker;
});

test("Python cancellation does not fall through to another backend", async () => {
  const c=client();let first=0,others=0;const controller=new AbortController();
  (c as any).cloudscraperClient={request:async(_req:any,{signal}:any)=>{first++;controller.abort();throw signal.reason;}};
  (c as any).curlCffiClient={request:async()=>{others++;return{success:true};}};
  await assert.rejects(c.get("/hot.json",{signal:controller.signal}),{name:"AbortError"});
  assert.equal(first,1);assert.equal(others,0);
});

test("native5xx retry sleep stops on cancellation", async () => {
  const c=client(); const controller=new AbortController();const original=globalThis.fetch;let calls=0;
  globalThis.fetch=(async()=>{calls++;setTimeout(()=>controller.abort(),10);return new Response("temporary",{status:503});}) as any;
  try { await assert.rejects(c.get("/hot.json",{signal:controller.signal}),{name:"AbortError"});assert.equal(calls,1); }
  finally{globalThis.fetch=original;}
});

test("dispose cancels running and queued work and rejects future/cache requests", async () => {
  const c=client();const original=globalThis.fetch;let calls=0;let started=false;
  globalThis.fetch=(async(_url:any,{signal}:any)=>{calls++;started=true;return new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));}) as any;
  try {
    const a=c.get("/a").catch(e=>e);while(!started)await pause(1);
    const b=c.get("/b").catch(e=>e);await c.dispose();
    assert.equal((await a).name,"AbortError");assert.equal((await b).name,"AbortError");assert.equal(calls,1);
    await assert.rejects(c.get("/c"),/disposed/);await assert.rejects(c.getCached("/c",1000),/disposed/);
  }finally{globalThis.fetch=original;}
});

test("one budget covers Python startup and subsequent native request",async()=>{
  const c=client(60);const original=globalThis.fetch;
  (c as any).cloudscraperClient={request:async()=>{await pause(40);throw new Error("unavailable");}};
  let nativeSignal:AbortSignal|undefined;
  globalThis.fetch=(async(_url:any,{signal}:any)=>{nativeSignal=signal;return new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));}) as any;
  try{await assert.rejects(c.get("/a"),{name:"TimeoutError"});assert.equal(nativeSignal?.aborted,true);}
  finally{globalThis.fetch=original;}
});


test("actual Python timeout exits before the client rejects and never falls back",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"nitan-client-child-"));
  const script=join(directory,"child.cjs");
  await writeFile(script,'const fs=require("node:fs"),path=require("node:path");fs.writeFileSync(path.join(path.dirname(__filename),"pid"),String(process.pid));process.on("SIGTERM",()=>{});process.stdin.resume();setInterval(()=>{},20);');
  const c=client(600);const py=new CloudscraperClient(new Logger("silent"),process.execPath);
  (py as any).scriptPath=script;(c as any).cloudscraperClient=py;let fallbacks=0;
  (c as any).curlCffiClient={request:async()=>{fallbacks++;return {success:true};}};
  try{
    const result=c.get("/hot.json").catch(e=>e);
    let pid=0;for(let i=0;i<100;i++){try{pid=Number(await readFile(join(directory,"pid"),"utf8"));break;}catch{await pause(5);}}
    assert.ok(pid,"dummy backend must really run");
    assert.equal((await result).name,"TimeoutError");
    assert.throws(()=>process.kill(pid,0),(e:any)=>e.code==="ESRCH");
    assert.equal(fallbacks,0);
  }finally{await c.dispose();await rm(directory,{recursive:true,force:true});}
});


for (const backend of ["cloudscraper", "native"] as const) test(`browser timeout stops ${backend} fallback even before the outer deadline`, async () => {
  const c=client(1000);const original=globalThis.fetch;let others=0,browserCalls=0;
  (c as any).browserFallbackClient={isEnabled:()=>true,request:async(_request:any,options:any)=>{browserCalls++;assert.ok(options.signal);assert.ok(options.timeoutMs>0&&options.timeoutMs<=1000);throw new DOMException("Request deadline exceeded","TimeoutError");},dispose:async()=>{}};
  if(backend==="cloudscraper"){
    (c as any).cloudscraperClient={request:async()=>({success:true,status:403,body:"just a moment",headers:{}})};
    (c as any).curlCffiClient={request:async()=>{others++;return{success:true,status:200,body:"ok"};}};
    globalThis.fetch=(async()=>{others++;return new Response("ok");}) as any;
  }else globalThis.fetch=(async()=>new Response("just a moment",{status:403})) as any;
  try {await assert.rejects(c.get("/hot.json"),{name:"TimeoutError"});assert.equal(browserCalls,1);assert.equal(others,0);}
  finally {globalThis.fetch=original;await c.dispose();}
});
