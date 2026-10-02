import test from "node:test";
import assert from "node:assert/strict";
import { SiteState } from "../site/state.js";
import { HttpClient } from "../http/client.js";
import { Logger } from "../util/logger.js";
const logger=new Logger("silent");
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function state(overrides:any[]=[]){return new SiteState({logger,timeoutMs:1000,defaultAuth:{type:"none"},authOverrides:overrides});}

test("site cache retains normalized subfolders and never shares sibling credentials",async()=>{
  const s=state([{site:"https://offline.invalid/",user_api_key:"root"},{site:"https://offline.invalid/forum-a/?q=old",user_api_key:"a",username:"alice",password:"fixture"},{site:"https://offline.invalid/forum-b",user_api_key:"b",username:"bob",password:"fixture"}]);
  try{
    const a=s.buildClientForSite("https://OFFLINE.invalid:443/forum-a///?ignored=1#post");
    assert.equal(a.base,"https://offline.invalid/forum-a");assert.equal(s.buildClientForSite("https://offline.invalid/forum-a").client,a.client);
    assert.equal((a.client as any).opts.auth.key,"a");assert.equal((a.client as any).opts.loginCredentials.username,"alice");
    const b=s.buildClientForSite("https://offline.invalid/forum-b");assert.notEqual(a.client,b.client);assert.equal((b.client as any).opts.auth.key,"b");
    assert.equal((s.buildClientForSite("https://offline.invalid/forum-c").client as any).opts.auth.type,"none");assert.equal(s.hasLoginForSite("https://offline.invalid/forum-c"),false);
  }finally{await s.dispose();}
});

test("updating/removing one base retains sibling cache and API+login coexistence",async()=>{
  const s=state([{site:"https://offline.invalid/forum-a",user_api_key:"a",username:"alice",password:"fixture",second_factor_token:"fixture2"},{site:"https://offline.invalid/forum-b",user_api_key:"b"}]);
  try{
    const a=s.selectSite("https://offline.invalid/forum-a").client,b=s.buildClientForSite("https://offline.invalid/forum-b").client;
    let retired=0;a.dispose=async()=>{retired++;};
    s.updateAuthOverride({site:"https://offline.invalid/forum-a/",user_api_key:"new-a"});
    assert.equal(retired,1);assert.equal(s.buildClientForSite("https://offline.invalid/forum-b").client,b);
    const replacement=s.selectSite("https://offline.invalid/forum-a").client;
    assert.equal((replacement as any).opts.auth.key,"new-a");assert.equal((replacement as any).opts.loginCredentials.username,"alice");
    s.removeAuthOverride("https://offline.invalid/forum-a/?x=1");assert.equal(s.hasAuthenticationConfiguredForSite("https://offline.invalid/forum-a"),false);assert.equal(s.hasAuthForSite("https://offline.invalid/forum-b"),true);assert.equal(s.buildClientForSite("https://offline.invalid/forum-b").client,b);
  }finally{await s.dispose();}
});

test("site disposal waits for retired clients and prevents late client creation",async()=>{
  const s=state([{site:"https://offline.invalid/forum",user_api_key:"old"}]);const client=s.selectSite("https://offline.invalid/forum").client;
  let release!:()=>void;client.dispose=()=>new Promise<void>(resolve=>{release=resolve;});
  s.updateAuthOverride({site:"https://offline.invalid/forum",user_api_key:"new"});
  let finished=false;const closing=s.dispose().then(()=>{finished=true;});
  try{await pause(20);assert.equal(finished,false);assert.throws(()=>s.buildClientForSite("https://offline.invalid/forum"),/disposed/);assert.throws(()=>s.updateAuthOverride({site:"https://offline.invalid/forum",user_api_key:"late"}),/disposed/);}
  finally{release();await closing;}
});

test("native/cache endpoints and Referer retain the site directory",async()=>{
  const client=new HttpClient({baseUrl:"https://offline.invalid/forum/?noise=1",timeoutMs:2000,logger,auth:{type:"none"}});
  (client as any).cloudscraperClient=undefined;(client as any).curlCffiClient=undefined;
  const original=globalThis.fetch;const calls:Array<{url:string;headers:any}>=[];
  globalThis.fetch=(async(url:any,options:any)=>{calls.push({url:String(url),headers:options.headers});return new Response('{"ok":true}',{headers:{"Content-Type":"application/json"}});}) as any;
  try{
    await client.getCached("/search.json?q=hello",10000);await client.getCached("search.json?q=hello",10000);
    assert.equal(calls.length,1);assert.equal(calls[0].url,"https://offline.invalid/forum/search.json?q=hello");
    await client.get("/hot.json");assert.equal(calls[1].headers.Referer,"https://offline.invalid/forum/");
  }finally{globalThis.fetch=original;await client.dispose();}
});

test("endpoint resolution rejects another origin or sibling before any backend",async()=>{
  const client=new HttpClient({baseUrl:"https://offline.invalid/forum",timeoutMs:1000,logger,auth:{type:"user_api_key",key:"fixture"}});let calls=0;
  (client as any).cloudscraperClient={request:async()=>{calls++;return{success:true};}};
  try{for(const path of ["https://evil.invalid/forum/hot.json","https://offline.invalid/forum-b/hot.json","../forum-b/hot.json"])await assert.rejects(client.get(path),/outside the configured site/);assert.equal(calls,0);}
  finally{await client.dispose();}
});

for(const backend of ["cloudscraper","curl_cffi"] as const)test(`${backend} receives explicit site base and API+login fields`,async()=>{
  const client=new HttpClient({baseUrl:"https://offline.invalid/forum/?q=ignored",timeoutMs:2000,logger,auth:{type:"user_api_key",key:"fixture-api"},loginCredentials:{username:"fixture-user",password:"fixture-password"},bypassMethod:backend});let data:any;
  (client as any)[backend==="cloudscraper"?"cloudscraperClient":"curlCffiClient"]={request:async(request:any)=>{data=request;return{success:true,status:200,headers:{"content-type":"application/json"},body:"{}"};}};
  try{await client.get("/private.json");assert.equal(data.site_base,"https://offline.invalid/forum");assert.equal(data.url,"https://offline.invalid/forum/private.json");assert.equal(data.headers["User-Api-Key"],"fixture-api");assert.equal(data.login.username,"fixture-user");}
  finally{await client.dispose();}
});

test("duplicate URL auth variants merge credentials with the latest fields",async()=>{
  const s=state([{site:"https://offline.invalid/forum/",user_api_key:"old",username:"original",password:"fixture"},{site:"https://offline.invalid/forum?q=old",user_api_key:"latest"}]);
  try{const client=s.selectSite("https://offline.invalid/forum").client;assert.equal((client as any).opts.auth.key,"latest");assert.equal((client as any).opts.loginCredentials.username,"original");assert.equal((s as any).opts.authOverrides.length,1);}
  finally{await s.dispose();}
});

test("URL helpers keep root/subfolder canonically and reject embedded credentials",async()=>{
  const {normalizeSiteBase,resolveSiteUrl}=await import("../util/site_url.js");
  assert.equal(normalizeSiteBase("https://OFFLINE.invalid:443/?q=1#x"),"https://offline.invalid");
  assert.equal(normalizeSiteBase("https://offline.invalid/a/../forum///?q=1#x"),"https://offline.invalid/forum");
  assert.equal(resolveSiteUrl("https://offline.invalid/forum/","/search.json?q=hello#unused"),"https://offline.invalid/forum/search.json?q=hello");
  assert.equal(resolveSiteUrl("https://offline.invalid/","/hot.json"),"https://offline.invalid/hot.json");
  assert.throws(()=>normalizeSiteBase("https://user:fixture@offline.invalid/forum"),/without embedded credentials/);
});

test("API-key URL and profile save normalize one exact base while retaining login and siblings",async()=>{
  const {buildAuthorizationUrl,prepareUserApiKeyGeneration,saveToProfile}=await import("../user-api-key-generator.js");
  const {mkdtemp,writeFile,readFile,rm}=await import("node:fs/promises");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
  const url=new URL(buildAuthorizationUrl({site:"https://offline.invalid/forum///?old=1#post",clientId:"fixture-client",nonce:"fixture"},"fixture-public"));
  assert.equal(url.pathname,"/forum/user-api-key/new");assert.equal(url.searchParams.get("old"),null);assert.equal(url.hash,"");
  assert.equal(prepareUserApiKeyGeneration({site:"https://offline.invalid/forum/?q=1"}).state.site,"https://offline.invalid/forum");
  const directory=await mkdtemp(join(tmpdir(),"nitan-normalized-profile-")),file=join(directory,"profile.json");
  try{
    await writeFile(file,JSON.stringify({auth_pairs:[{site:"https://offline.invalid/forum/",user_api_key:"old",username:"fixture",password:"fixture",second_factor_token:"fixture2"},{site:"https://offline.invalid/forum?old=1",user_api_key:"also-old"},{site:"https://offline.invalid/forum-b",user_api_key:"sibling"},{site:"https://offline.invalid/",user_api_key:"root"},{site:"ftp://unrelated.invalid",user_api_key:"unrelated"}]}));
    await saveToProfile(file,"https://offline.invalid/forum///?ignored=1","new","new-client");
    const pairs=JSON.parse(await readFile(file,"utf8")).auth_pairs;assert.equal(pairs.length,4);
    const target=pairs.find((p:any)=>p.site==="https://offline.invalid/forum");assert.equal(target.user_api_key,"new");assert.equal(target.username,"fixture");assert.equal(target.second_factor_token,"fixture2");assert.ok(pairs.some((p:any)=>p.user_api_key==="sibling"));assert.ok(pairs.some((p:any)=>p.user_api_key==="root"));assert.ok(pairs.some((p:any)=>p.user_api_key==="unrelated"));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test("retired actual Python worker is gone before total site disposal resolves",async()=>{
  const {mkdtemp,writeFile,readFile,rm}=await import("node:fs/promises");const {tmpdir}=await import("node:os");const {join}=await import("node:path");const {randomUUID}=await import("node:crypto");
  const directory=await mkdtemp(join(tmpdir(),"nitan-retired-worker-")),script=join(directory,"worker.cjs");
  await writeFile(script,'const fs=require("node:fs"),path=require("node:path");process.on("SIGTERM",()=>{});fs.writeFileSync(path.join(path.dirname(__filename),"pid"),String(process.pid));process.stdin.resume();setInterval(()=>{},10);');
  const s=new SiteState({logger,timeoutMs:2000,defaultAuth:{type:"none"},bypassMethod:"cloudscraper",pythonPath:process.execPath});const site=`https://${randomUUID()}.invalid/forum`;const client=s.selectSite(site).client;(client as any).cloudscraperClient.scriptPath=script;
  try{
    const request=client.get("/hot.json").catch(e=>e);let pid=0;
    for(let i=0;i<200;i++){try{pid=Number(await readFile(join(directory,"pid"),"utf8"));break;}catch{await pause(5);}}assert.ok(pid);
    s.updateAuthOverride({site,user_api_key:"replacement"});await s.dispose();assert.equal((await request).name,"AbortError");assert.throws(()=>process.kill(pid,0),(e:any)=>e.code==="ESRCH");
  }finally{await s.dispose();await rm(directory,{recursive:true,force:true});}
});
