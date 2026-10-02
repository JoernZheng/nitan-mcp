import test from "node:test";
import assert from "node:assert/strict";
import { BrowserFallbackClient } from "../http/browser_fallback.js";
import { Logger } from "../util/logger.js";

for(const current of ["about:blank","https://offline.invalid/","https://offline.invalid/forum-b/page","https://offline.invalid.evil/forum/page","https://offline.invalid/forum/page"])test(`browser prefix bootstrap from ${current}`,async()=>{
  const navigations:string[]=[];let url=current,evaluations=0;
  const page={isClosed:()=>false,url:()=>url,goto:async(target:string)=>{navigations.push(target);url=target;return{status:()=>200,headers:()=>({}),text:async()=>"ok"};},evaluate:async()=>{evaluations++;return{status:200,body:"{}",headers:{"content-type":"application/json"}};}};
  const context={pages:()=>[page],close:async()=>{}};
  const client=new BrowserFallbackClient(new Logger("silent"),{enabled:true,provider:"playwright",playwrightModuleLoader:async()=>({chromium:{launchPersistentContext:async()=>context}})});
  (client as any).resolvePlaywrightProfileSelection=()=>({userDataDir:"/unused",profileDirectory:"fixture",source:"nitan"});
  try{await client.request({url:"https://offline.invalid/forum/search.json",siteBase:"https://offline.invalid/forum/?q=ignored",method:"GET",headers:{"User-Api-Key":"fixture"}});assert.equal(evaluations,1);assert.deepEqual(navigations,current==="https://offline.invalid/forum/page"?[]:["https://offline.invalid/forum"]);}
  finally{await client.dispose();}
});

test("browser never creates a context for a target outside its configured prefix",async()=>{
  let launches=0;const client=new BrowserFallbackClient(new Logger("silent"),{enabled:true,playwrightModuleLoader:async()=>{launches++;return{};}});
  try{await assert.rejects(client.request({url:"https://offline.invalid/forum-b/search.json",siteBase:"https://offline.invalid/forum",method:"GET",headers:{"User-Api-Key":"fixture"}}),/outside the configured site/);assert.equal(launches,0);}
  finally{await client.dispose();}
});

function loginFixture(loginCheckUrl?:string,redirect?:string){
  let current="about:blank",navigations=0,launches=0,evaluations=0;
  const filled:Array<[string,string]>=[];
  const page:any={url:()=>current,isClosed:()=>false,goto:async(url:string)=>{navigations++;current=redirect??url;return{status:()=>200,headers:()=>({}),text:async()=>"ok"};},waitForSelector:async()=>{},fill:async(selector:string,value:string)=>{filled.push([selector,value]);},$:async()=>({}),waitForLoadState:async()=>{},click:async()=>{},waitForTimeout:async()=>{},evaluate:async()=>{evaluations++;return{status:200,body:"{}",headers:{}};}};
  const context={pages:()=>[page],close:async()=>{}};
  const client=new BrowserFallbackClient(new Logger("silent"),{enabled:true,provider:"playwright",interactiveLoginEnabled:true,loginCheckUrl,playwrightModuleLoader:async()=>{launches++;return{chromium:{launchPersistentContext:async()=>context}};}});
  (client as any).resolvePlaywrightProfileSelection=()=>({userDataDir:"/unused",profileDirectory:"fixture",source:"nitan"});
  return{client,page,filled,navigate:(url:string)=>{current=url;},get navigations(){return navigations;},get launches(){return launches;},get evaluations(){return evaluations;}};
}

test("browser login uses explicitly selected site credentials over another site's env",{skip:process.platform!=="darwin"},async()=>{
  const f=loginFixture(),oldUser=process.env.NITAN_USERNAME,oldPassword=process.env.NITAN_PASSWORD;
  process.env.NITAN_USERNAME="site-a-user";process.env.NITAN_PASSWORD="site-a-password";
  try{assert.equal(await f.client.maybeAutoLogin("https://offline.invalid/forum-b",{}, {username:"site-b-user",password:"site-b-password"}),true);assert.deepEqual(f.filled.map(pair=>pair[1]),["site-b-user","site-b-password"]);}
  finally{if(oldUser===undefined)delete process.env.NITAN_USERNAME;else process.env.NITAN_USERNAME=oldUser;if(oldPassword===undefined)delete process.env.NITAN_PASSWORD;else process.env.NITAN_PASSWORD=oldPassword;await f.client.dispose();}
});

test("invalid sibling/foreign loginCheckUrl starts no navigation or helper",{skip:process.platform!=="darwin"},async()=>{
  for(const url of ["https://evil.invalid/login","https://offline.invalid/forum-a/login"]){
    const f=loginFixture(url);let helpers=0;(f.client as any).openChromeOnMac=async()=>{helpers++;};
    try{await assert.rejects(f.client.maybeAutoLogin("https://offline.invalid/forum-b",{}, {username:"site-b",password:"fixture"}),/Login URL is outside/);await assert.rejects(f.client.maybePromptInteractiveLogin("https://offline.invalid/forum-b"),/Login URL is outside/);assert.equal(f.launches,0);assert.equal(f.navigations,0);assert.equal(helpers,0);}
    finally{await f.client.dispose();}
  }
});

test("bootstrap redirect cannot inject API headers into a foreign page",async()=>{
  for(const headers of [undefined,{"User-Api-Key":"fixture"}]){
    const f=loginFixture(undefined,"https://evil.invalid/page");
    try{await assert.rejects(f.client.request({url:"https://offline.invalid/forum/hot.json",siteBase:"https://offline.invalid/forum",method:"GET",headers}),/navigated outside/);assert.equal(f.evaluations,0);}
    finally{await f.client.dispose();}
  }
});

test("login redirect to a sibling is rejected before any credential fill",{skip:process.platform!=="darwin"},async()=>{
  const f=loginFixture(undefined,"https://offline.invalid/forum-a/login");
  try{await assert.rejects(f.client.maybeAutoLogin("https://offline.invalid/forum-b",{}, {username:"site-b",password:"fixture"}),/navigated outside/);assert.equal(f.filled.length,0);}
  finally{await f.client.dispose();}
});


for(const stage of ["selector","username","button"] as const)test(`login scope is rechecked after awaited ${stage} work`,{skip:process.platform!=="darwin"},async()=>{
  const f=loginFixture();let waits=0,clicks=0;
  if(stage==="selector")f.page.waitForSelector=async()=>{if(++waits===2)f.navigate("https://offline.invalid/forum-a/login");};
  if(stage==="username")f.page.fill=async(selector:string,value:string)=>{f.filled.push([selector,value]);f.navigate("https://offline.invalid/forum-a/login");};
  if(stage==="button")f.page.$=async()=>{f.navigate("https://offline.invalid/forum-a/login");return{};};
  f.page.click=async()=>{clicks++;};
  try{await assert.rejects(f.client.maybeAutoLogin("https://offline.invalid/forum-b",{}, {username:"site-b-user",password:"site-b-password"}),/navigated outside/);assert.equal(f.filled.length,stage==="selector"?0:stage==="username"?1:2);assert.equal(clicks,0);}
  finally{await f.client.dispose();}
});
