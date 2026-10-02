import test from "node:test";
import assert from "node:assert/strict";
import { BrowserFallbackClient } from "../http/browser_fallback.js";
import { Logger } from "../util/logger.js";
import { randomUUID } from "node:crypto";

function deferred<T>() { let resolve!: (value:T)=>void; let reject!: (e:Error)=>void; const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject}; }
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(condition:()=>boolean){for(let i=0;i<200;i++){if(condition())return;await pause(2);}throw new Error("fixture did not start");}
const input=()=>({url:`https://${randomUUID()}.invalid/topic.json`,method:"GET"});
function fixture() {
  const stats={launch:0,close:0,goto:0,evaluate:0,cookies:0,fill:0,click:0,pageClose:0};
  let current="about:blank";
  const page:any={isClosed:()=>false,url:()=>current,goto:async(url:string)=>{stats.goto++;current=url;return{status:()=>200,headers:()=>({}),text:async()=>"ok"};},content:async()=>"ok",evaluate:async()=>{stats.evaluate++;return{status:200,body:"ok",headers:{}};},close:async()=>{stats.pageClose++;},waitForSelector:async()=>{},fill:async()=>{stats.fill++;},$:async()=>({}),click:async()=>{stats.click++;},waitForLoadState:async()=>{},waitForTimeout:async()=>{}};
  const context:any={pages:()=>[page],newPage:async()=>page,close:async()=>{stats.close++;},clearCookies:async()=>{stats.cookies++;}};
  const module:any={chromium:{launchPersistentContext:async()=>{stats.launch++;return context;}}};
  const client=new BrowserFallbackClient(new Logger("silent"),{enabled:true,provider:"playwright",timeoutMs:1000,playwrightModuleLoader:async()=>module});
  (client as any).resolvePlaywrightProfileSelection=()=>({userDataDir:"/unused",profileDirectory:"fixture",source:"nitan"});
  return{stats,page,context,module,client};
}

test("pre-aborted browser requests create no context",async()=>{
  const f=fixture(),c=new AbortController();c.abort();await assert.rejects(f.client.request(input(),{signal:c.signal}),{name:"AbortError"});assert.equal(f.stats.launch,0);
});

for(const mode of ["abort","timeout","dispose"] as const)test(`pending browser launch cannot revive a session after ${mode}`,async()=>{
  const f=fixture(),c=new AbortController(),launch=deferred<any>();
  let launchTimeout=0;f.module.chromium.launchPersistentContext=async(_dir:any,options:any)=>{f.stats.launch++;launchTimeout=options.timeout;return launch.promise;};
  const result=f.client.request(input(),{signal:c.signal,timeoutMs:mode==="timeout"?25:1000}).catch(e=>e);
  await until(()=>f.stats.launch===1);
  if(mode==="abort")c.abort();if(mode==="dispose")await f.client.dispose();
  assert.equal((await result).name,mode==="timeout"?"TimeoutError":"AbortError");
  assert.ok(launchTimeout>0&&launchTimeout<=1000);
  launch.resolve(f.context);await until(()=>f.stats.close===1);
  assert.equal(f.stats.goto,0);assert.equal((f.client as any).playwrightSession,undefined);
  if(mode==="dispose")await assert.rejects(f.client.request(input()),/disposed/);
  else {f.module.chromium.launchPersistentContext=async()=>{f.stats.launch++;return f.context;};await f.client.request(input());assert.equal(f.stats.launch,2);}
  await f.client.dispose();
});

for(const stage of ["goto","evaluate","login"] as const)test(`abort during ${stage} closes owned context without retry`,{skip:stage==="login" && process.platform!=="darwin"},async()=>{
  const f=fixture(),c=new AbortController(),work=deferred<any>();let started=false;
  f.context.close=async()=>{f.stats.close++;work.reject(new Error("Target closed"));};
  if(stage==="goto")f.page.goto=async()=>{f.stats.goto++;started=true;return work.promise;};
  if(stage==="evaluate")f.page.evaluate=async()=>{f.stats.evaluate++;started=true;return work.promise;};
  if(stage==="login"){
    (f.client as any).resolveEnvAutoLoginCredentials=()=>({username:"fixture",password:"fixture"});
    f.page.fill=async()=>{f.stats.fill++;started=true;return work.promise;};
  }
  const result=(stage==="login"?f.client.maybeAutoLogin(input().url,{signal:c.signal}):f.client.request({...input(),...(stage==="evaluate"?{headers:{"X-Test":"1"}}:{})},{signal:c.signal})).catch(e=>e);
  await until(()=>started);c.abort();assert.equal((await result).name,"AbortError");
  assert.equal(f.stats.close,1);assert.equal(f.stats.launch,1);assert.equal(f.stats.cookies,0);assert.equal(f.stats.click,0);
  if(stage==="login")assert.equal(f.stats.fill,1);
  await f.client.dispose();
});

test("late newPage is closed and never navigated",async()=>{
  const f=fixture(),c=new AbortController(),created=deferred<any>();let started=false;
  f.context.pages=()=>[];f.context.newPage=async()=>{started=true;return created.promise;};
  const result=f.client.request(input(),{signal:c.signal}).catch(e=>e);await until(()=>started);c.abort();
  assert.equal((await result).name,"AbortError");created.resolve(f.page);await until(()=>f.stats.pageClose===1);assert.equal(f.stats.goto,0);await f.client.dispose();
});

function relayFixture(){
  const f=fixture();let detach=0,borrowedClose=0;const borrowed={url:()=>"https://untouched.invalid",close:async()=>{borrowedClose++;}};
  const relay=new BrowserFallbackClient(new Logger("silent"),{enabled:true,provider:"openclaw_proxy",timeoutMs:1000,playwrightModuleLoader:async()=>f.module});
  (relay as any).probeOpenClawRelay=async()=>({reachable:true,hasAttachedTab:true});
  f.context.pages=()=>[borrowed];const browser={contexts:()=>[f.context],close:async()=>{detach++;}};
  f.module.chromium.connectOverCDP=async()=>browser;
  return{...f,relay,browser,borrowed,get detach(){return detach;},get borrowedClose(){return borrowedClose;}};
}

test("relay uses a dedicated tab with auth headers and detaches only its connection",async()=>{
  const f=relayFixture();await f.relay.request({...input(),headers:{"X-Test":"1"}});
  assert.equal(f.stats.evaluate,1);assert.equal(f.stats.pageClose,1);assert.equal(f.detach,1);assert.equal(f.borrowedClose,0);assert.equal(f.borrowed.url(),"https://untouched.invalid");assert.equal(f.stats.close,0);await f.relay.dispose();
});

test("relay without dedicated-tab support fails before forum navigation",async()=>{
  const f=relayFixture();f.context.newPage=async()=>{throw new Error("unsupported");};
  await assert.rejects(f.relay.request(input()),/dedicated request tab/);assert.equal(f.stats.goto,0);assert.equal(f.borrowedClose,0);assert.equal(f.detach,1);await f.relay.dispose();
});

for(const stage of ["connect","newPage","goto"] as const)test(`relay ${stage} cancellation cleans only owned resources`,async()=>{
  const f=relayFixture(),c=new AbortController(),work=deferred<any>();let started=false;
  if(stage==="connect")f.module.chromium.connectOverCDP=async()=>{started=true;return work.promise;};
  if(stage==="newPage")f.context.newPage=async()=>{started=true;return work.promise;};
  if(stage==="goto"){f.page.goto=async()=>{started=true;return work.promise;};f.page.close=async()=>{f.stats.pageClose++;work.reject(new Error("Target closed"));};}
  const result=f.relay.request(input(),{signal:c.signal}).catch(e=>e);await until(()=>started);c.abort();assert.equal((await result).name,"AbortError");
  if(stage==="connect")work.resolve(f.browser);if(stage==="newPage")work.resolve(f.page);
  await until(()=>f.detach===1&&(stage==="connect"||f.stats.pageClose===1));assert.equal(f.borrowedClose,0);assert.equal(f.stats.close,0);await f.relay.dispose();
});


test("standalone concurrent browser operations fail explicitly without cancelling the first",async()=>{
  const f=fixture(),launch=deferred<any>();f.module.chromium.launchPersistentContext=async()=>{f.stats.launch++;return launch.promise;};
  const first=f.client.request(input());await until(()=>f.stats.launch===1);
  await assert.rejects(f.client.request(input(),{timeoutMs:15}),/already has an active operation/);
  launch.resolve(f.context);assert.equal((await first).status,200);assert.equal(f.stats.close,0);await f.client.dispose();
});

test("body cancellation never falls through to rendered content",async()=>{
  const f=fixture(),c=new AbortController();let bodies=0,contents=0;const target=input();f.page.url=()=>target.url;
  f.page.goto=async()=>({status:()=>200,headers:()=>({}),text:async()=>{if(++bodies===2){c.abort();throw new Error("Target closed");}return "ok";}});
  f.page.content=async()=>{contents++;return "late";};
  await assert.rejects(f.client.request(target,{signal:c.signal}),{name:"AbortError"});assert.equal(contents,0);await f.client.dispose();
});

test("pre-aborted interactive login starts no helper processes",{skip:process.platform!=="darwin"},async()=>{
  const f=fixture(),c=new AbortController();(f.client as any).options.interactiveLoginEnabled=true;let helpers=0;
  (f.client as any).openChromeOnMac=async()=>{helpers++;};c.abort();
  await assert.rejects(f.client.maybePromptInteractiveLogin(input().url,{signal:c.signal}),{name:"AbortError"});assert.equal(helpers,0);await f.client.dispose();
});
