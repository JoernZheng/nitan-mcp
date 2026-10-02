import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultProfilePath } from "../util/paths.js";
import { constants, publicEncrypt } from "node:crypto";
import { readJsonBody, rejectHttpRequest, HttpInputError } from "../http/local_server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const MAX_BODY=4*1024*1024;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const server=createServer();await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const address=server.address();assert.ok(address&&typeof address!=="string");await new Promise<void>(r=>server.close(()=>r()));return address.port;}
async function fixture(operation:(value:{port:number;base:string;home:string;profile:string;child:ReturnType<typeof spawn>})=>Promise<void>, extraArgs:string[]=[],preload?:string){
  const port=await freePort(),home=await mkdtemp(join(tmpdir(),"nitan-http-boundary-"));
  const profile=getDefaultProfilePath(process.platform,{...process.env,HOME:home,XDG_CONFIG_HOME:join(home,"config"),APPDATA:join(home,"appdata")},home);
  await mkdir(dirname(profile),{recursive:true});await writeFile(profile,JSON.stringify({auth_pairs:[{site:"https://offline.invalid",user_api_key:"offline-fixture-key"}]}));
  const preloadPath=join(home,"preload.mjs");if(preload)await writeFile(preloadPath,preload);
  const child=spawn(process.execPath,[...(preload?["--import",preloadPath]:[]),fileURLToPath(new URL("../index.js",import.meta.url)),"--transport=http",`--port=${port}`,"--site=https://offline.invalid","--browser-fallback-enabled=false","--interactive-login-enabled=false","--log_level=silent",...extraArgs],{cwd:home,env:{...process.env,HOME:home,XDG_CONFIG_HOME:join(home,"config"),APPDATA:join(home,"appdata"),NITAN_USERNAME:"",NITAN_PASSWORD:"",DISCOURSE_2FA_TOKEN:""},stdio:["ignore","pipe","pipe"]});
  let stderr="";child.stderr!.on("data",chunk=>{stderr+=String(chunk);});const base=`http://127.0.0.1:${port}`;
  try{
    let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+"/health",{signal:AbortSignal.timeout(100)})).ok){ready=true;break;}}catch{}if(child.exitCode!==null)break;await pause(25);}
    assert.ok(ready,`isolated server did not start: ${stderr}`);await operation({port,base,home,profile,child});
  }finally{
    if(child.exitCode===null&&child.signalCode===null){child.kill("SIGTERM");for(let i=0;i<100&&child.exitCode===null&&child.signalCode===null;i++)await pause(25);if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");}
    if(child.exitCode===null&&child.signalCode===null)await new Promise<void>(r=>child.once("exit",()=>r()));
    await rm(home,{recursive:true,force:true});
  }
}
function raw(port:number,path:string,options:{method?:string;headers?:Record<string,string>;chunks?:Array<string|Buffer>;length?:number}={}){
  return new Promise<{status:number;body:string}>((resolve,reject)=>{
    const req=request({host:"127.0.0.1",port,path,method:options.method??"GET",headers:{...options.headers,...(options.length!==undefined?{"Content-Length":String(options.length)}:{})}},res=>{let body="";res.on("data",chunk=>{body+=String(chunk);});res.on("end",()=>resolve({status:res.statusCode!,body}));});
    req.setTimeout(3000,()=>req.destroy(new Error("fixture response timeout")));req.on("error",reject);
    for(const chunk of options.chunks??[])req.write(chunk);req.end();
  });
}

test("every HTTP route rejects hostile Host/Origin before any auth change",async()=>fixture(async({port,profile})=>{
  const before=await readFile(profile,"utf8");
  for(const path of ["/health","/auth","/auth/callback","/mcp","/","/missing"]){
    const method=path==="/auth/callback"?"DELETE":"GET";
    const invalid: Array<Record<string,string>>=[{Host:"evil.invalid"},{Host:`localhost:${port+1}`},{Origin:"https://evil.invalid"},{Origin:"null"},{Origin:""},{Origin:`http://127.0.0.1:${port}/extra`}];
    for(const headers of invalid){
      assert.equal((await raw(port,path,{method,headers})).status,403,`${path} must reject ${JSON.stringify(headers)}`);
    }
  }
  assert.equal(await readFile(profile,"utf8"),before);
  assert.equal((await raw(port,"/health")).status,200);
  for(const host of [`localhost:${port}`,`127.0.0.1:${port}`,`[::1]:${port}`])assert.equal((await raw(port,"/health",{headers:{Host:host,Origin:`http://${host}`}})).status,200);
}));

test("MCP/auth requests reject malformed JSON and byte-counted oversized bodies",async()=>fixture(async({port,profile})=>{
  const before=await readFile(profile,"utf8");
  for(const path of ["/mcp","/","/auth/callback"]){
    const bad=await raw(port,path,{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json, text/event-stream"},chunks:["{"]});
    assert.equal(bad.status,400);if(path!=="/auth/callback")assert.equal(JSON.parse(bad.body).error.code,-32700);
    const huge=await raw(port,path,{method:"POST",headers:{"Content-Type":"application/json"},chunks:[Buffer.alloc(MAX_BODY+1,120)]});
    assert.equal(huge.status,413);
  }
  for(const json of ["null","[]","42",JSON.stringify({payload:42})])assert.equal((await raw(port,"/auth/callback",{method:"POST",chunks:[json]})).status,400);
  assert.equal(await readFile(profile,"utf8"),before);
}));

test("HTTP listener is loopback-only and forwarded headers cannot alter local auth URLs",async()=>fixture(async({port,base})=>{
  const response=await fetch(base+"/health",{headers:{"X-Forwarded-Host":"evil.invalid","X-Forwarded-Proto":"https"}});
  assert.equal((await response.json()).auth_page,base+"/auth");
  const external=Object.values(networkInterfaces()).flat().find(address=>address&&address.family==="IPv4"&&!address.internal);
  if(external)await assert.rejects(fetch(`http://${external.address}:${port}/health`,{signal:AbortSignal.timeout(300)}));
}));


test("4 MiB inclusive limit, early declared overflow and UTF8 bytes use the same boundary",async()=>fixture(async({port})=>{
  const headers={"Content-Type":"application/json",Accept:"application/json, text/event-stream"};
  assert.equal((await raw(port,"/mcp",{method:"POST",headers,chunks:["{}"+" ".repeat(MAX_BODY-2)]})).status,400);
  for(const path of ["/mcp","/auth/callback"]){
    assert.equal((await raw(port,path,{method:"POST",length:MAX_BODY+1})).status,413);
    assert.equal((await raw(port,path,{method:"POST",chunks:["你".repeat(Math.floor(MAX_BODY/3)+1)]})).status,413);
  }
}));

async function wire(port:number,message:string):Promise<string>{
  return new Promise((resolve,reject)=>{let output="";const socket=connect(port,"127.0.0.1",()=>socket.write(message));socket.setTimeout(3000,()=>socket.destroy(new Error("wire timeout")));socket.on("data",chunk=>output+=String(chunk));socket.on("error",reject);socket.on("close",()=>resolve(output));});
}
test("missing/duplicate/combined headers never reach auth mutations",async()=>fixture(async({port,profile})=>{
  const before=await readFile(profile,"utf8");
  for(const headers of ["",`Host: localhost:${port}\r\nHost: evil.invalid\r\n`,`Host: localhost:${port}\r\nOrigin: http://localhost:${port}\r\nOrigin: http://localhost:${port}\r\n`,`Host: localhost:${port}@evil.invalid\r\n`]){
    const response=await wire(port,`DELETE /auth/callback HTTP/1.1\r\n${headers}Connection: close\r\n\r\n`);assert.match(response,/HTTP\/1\.1 (?:400|403)/);
  }
  assert.equal(await readFile(profile,"utf8"),before);
}));

test("slow upload timeout responds and client reset cannot crash the service",async()=>{
  const server=createServer((req,res)=>{void readJsonBody(req,{timeoutMs:25}).then(()=>res.end("ok"),error=>rejectHttpRequest(res,error instanceof HttpInputError?error:new HttpInputError(500,"fixture failed")));});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const address=server.address();assert.ok(address&&typeof address!=="string");
  try{assert.match(await wire(address.port,`POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\nConnection: close\r\n\r\nx`),/HTTP\/1\.1 408/);}
  finally{await new Promise<void>(r=>server.close(()=>r()));}
  await fixture(async({port,base})=>{const socket=connect(port,"127.0.0.1",()=>socket.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 100\r\n\r\nx`));socket.on("error",()=>{});await pause(50);socket.destroy();await pause(50);assert.equal((await fetch(base+"/health")).status,200);});
});

async function exited(child:ReturnType<typeof spawn>,limit=3000){
  const start=Date.now();while(child.exitCode===null&&child.signalCode===null&&Date.now()-start<limit)await pause(10);
  assert.notEqual(child.exitCode,null,"server must exit within the cleanup grace");return Date.now()-start;
}
for(const mode of ["body","headers","sse"] as const)test(`SIGTERM closes ${mode} connection within finite cleanup grace`,async()=>fixture(async({port,child})=>{
  let closed=false;const socket=connect(port,"127.0.0.1");socket.on("error",()=>{});socket.on("close",()=>{closed=true;});await new Promise<void>(r=>socket.once("connect",r));
  const message=mode==="body"?`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 100\r\n\r\nx`:mode==="headers"?"GET /health HTTP/1.1\r\nHost: ":`GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\n\r\n`;
  let response="";socket.on("data",chunk=>response+=String(chunk));socket.write(message);
  if(mode==="sse"){for(let i=0;i<100&&!response.includes("200");i++)await pause(10);assert.match(response,/HTTP\/1\.1 200/);}else await pause(50);
  child.kill("SIGTERM");assert.ok(await exited(child)<3000);for(let i=0;i<100&&!closed;i++)await pause(5);assert.equal(closed,true);
  assert.equal(child.exitCode,0);socket.destroy();
}));

test("SIGTERM cancels an actual HTTP tool's native request without successor calls",async()=>{
  let calls=0,upstreamClosed=false;const target=createServer((_req,res)=>{calls++;res.on("close",()=>{upstreamClosed=true;});});
  await new Promise<void>(r=>target.listen(0,"127.0.0.1",r));const address=target.address();assert.ok(address&&typeof address!=="string");
  try{await fixture(async({base,child})=>{
    const client=new Client({name:"shutdown-proof",version:"1"});await client.connect(new StreamableHTTPClientTransport(new URL(base+"/mcp")));
    try{
      const result=client.callTool({name:"discourse_list_hot_topics",arguments:{}}).catch(e=>e);
      for(let i=0;i<300&&calls===0;i++)await pause(10);assert.equal(calls,1);
      child.kill("SIGTERM");await exited(child);await result;
      for(let i=0;i<100&&!upstreamClosed;i++)await pause(5);assert.equal(upstreamClosed,true);await pause(100);assert.equal(calls,1);assert.equal(child.exitCode,0);
    }finally{await client.close();}
  },[`--site=http://127.0.0.1:${address.port}`,"--auth_pairs=[]","--bypass_method=cloudscraper","--python_path=/offline-missing-python"]);}
  finally{target.closeAllConnections();await new Promise<void>(r=>target.close(()=>r()));}
});

const delayedProfileWrite=`
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const original=fs.writeFile;let delayed=false;
fs.writeFile=async(...args)=>{await original(...args);if(!delayed&&String(args[0]).endsWith("profile.json")){delayed=true;await original(join(process.env.HOME,"written"),"ready");while(!existsSync(join(process.env.HOME,"release")))await new Promise(r=>setTimeout(r,5));}};
syncBuiltinESMExports();
`;
for(const action of ["authorize","logout"] as const)test(`committed ${action} stays consistent after the HTTP client disconnects`,async()=>fixture(async({base,port,home,profile})=>{
  let body="";
  if(action==="authorize"){
    const html=await (await fetch(base+"/auth")).text();const auth=new URL(html.match(/<a href="([^"]+)" target="_blank" class="btn">/)![1]);
    const key=auth.searchParams.get("public_key")!;const payload=publicEncrypt({key,padding:constants.RSA_PKCS1_PADDING},Buffer.from(JSON.stringify({key:"new-offline-key"}))).toString("base64");body=JSON.stringify({payload});
  }
  const req=request({host:"127.0.0.1",port,path:"/auth/callback",method:action==="authorize"?"POST":"DELETE",headers:{"Content-Type":"application/json"}},res=>res.resume());req.on("error",()=>{});req.end(body||undefined);
  let written=false;for(let i=0;i<300;i++){try{await readFile(join(home,"written"));written=true;break;}catch{await pause(5);}}assert.equal(written,true);
  const busy=await raw(port,"/auth/callback",{method:"DELETE"});assert.equal(busy.status,409);
  req.destroy();await pause(20);await writeFile(join(home,"release"),"go");
  let authenticated:boolean|undefined;for(let i=0;i<100;i++){authenticated=(await (await fetch(base+"/health")).json()).authenticated;if(authenticated===(action==="authorize"))break;await pause(10);}
  assert.equal(authenticated,action==="authorize");const saved=JSON.parse(await readFile(profile,"utf8"));assert.equal(saved.auth_pairs.length,action==="authorize"?1:0);
  if(action==="authorize")assert.equal(saved.auth_pairs[0].user_api_key,"new-offline-key");
},action==="authorize"?["--auth_pairs=[]"]:[],delayedProfileWrite));


for(const action of ["authorize","logout"] as const)test(`SIGTERM waits for normalized-path ${action} persistence`,async()=>fixture(async({base,port,home,profile,child})=>{
  let body="";
  if(action==="authorize"){
    const html=await (await fetch(base+"/auth")).text();const auth=new URL(html.match(/<a href="([^"]+)" target="_blank" class="btn">/)![1]);
    const payload=publicEncrypt({key:auth.searchParams.get("public_key")!,padding:constants.RSA_PKCS1_PADDING},Buffer.from(JSON.stringify({key:"committed-before-shutdown"}))).toString("base64");body=JSON.stringify({payload});
  }
  const path=action==="authorize"?"/prefix/../auth/callback":"/%2e/auth/callback";
  const req=request({host:"127.0.0.1",port,path,method:action==="authorize"?"POST":"DELETE",headers:{"Content-Type":"application/json"}},res=>res.resume());req.on("error",()=>{});req.end(body||undefined);
  let written=false;for(let i=0;i<300;i++){try{await readFile(join(home,"written"));written=true;break;}catch{await pause(5);}}assert.equal(written,true);
  child.kill("SIGTERM");await pause(100);assert.equal(child.exitCode,null,"committed profile write must finish before exit");
  await writeFile(join(home,"release"),"go");await exited(child);assert.equal(child.exitCode,0);
  const saved=JSON.parse(await readFile(profile,"utf8"));assert.equal(saved.auth_pairs.length,action==="authorize"?1:0);req.destroy();
},action==="authorize"?["--auth_pairs=[]"]:[],delayedProfileWrite));

test("unfinished auth persistence exceeds shutdown grace with a failure exit",async()=>fixture(async({port,home,child})=>{
  const req=request({host:"127.0.0.1",port,path:"/auth/callback",method:"DELETE"},res=>res.resume());req.on("error",()=>{});req.end();
  let written=false;for(let i=0;i<300;i++){try{await readFile(join(home,"written"));written=true;break;}catch{await pause(5);}}assert.equal(written,true);
  child.kill("SIGTERM");const elapsed=await exited(child);assert.ok(elapsed>=1800&&elapsed<3000);assert.equal(child.exitCode,1);req.destroy();
},[],delayedProfileWrite));
