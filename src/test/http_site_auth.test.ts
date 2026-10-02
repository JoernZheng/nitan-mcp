import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDefaultProfilePath } from "../util/paths.js";
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,"127.0.0.1",r));const address=s.address();assert.ok(address&&typeof address!=="string");await new Promise<void>(r=>s.close(()=>r()));return address.port;}

for(const mode of ["env","flags"] as const)test(`HTTP ${mode}/API merge, normalized logout, public reading and restart preserve exact-site isolation`,async()=>{
  const home=await mkdtemp(join(tmpdir(),"nitan-http-site-auth-")),capture=join(home,"captured.json"),port=await freePort(),base=`http://127.0.0.1:${port}`;
  const profile=getDefaultProfilePath(process.platform,{...process.env,HOME:home,XDG_CONFIG_HOME:join(home,"config"),APPDATA:join(home,"appdata")},home);
  await mkdir(dirname(profile),{recursive:true});await writeFile(profile,JSON.stringify({auth_pairs:[{site:"https://offline.invalid/forum/",user_api_key:"old-key",username:"profile-user",password:"profile-password"},{site:"https://offline.invalid/forum?old=1",user_api_key:"latest-key"},{site:"https://offline.invalid/forum-b",user_api_key:"sibling-key"}]}));
  const preload=join(home,"preload.mjs");const cloudscraper=fileURLToPath(new URL("../http/cloudscraper.js",import.meta.url));
  await writeFile(preload,`import {CloudscraperClient} from ${JSON.stringify(new URL("file://"+cloudscraper).href)};import {writeFile} from 'node:fs/promises';CloudscraperClient.prototype.request=async function(data){await writeFile(${JSON.stringify(capture)},JSON.stringify(data));return{success:true,status:200,headers:{'content-type':'application/json'},body:JSON.stringify({topic_list:{topics:[{id:7,slug:'fixture',title:'fixture',posts_count:1,views:1,like_count:0}]}})};};`);
  let child:ReturnType<typeof spawn>|undefined;
  const start=async(login:boolean,flags=false)=>{
    child=spawn(process.execPath,["--import",preload,fileURLToPath(new URL("../index.js",import.meta.url)),"--transport=http",`--port=${port}`,"--site=https://OFFLINE.invalid:443/forum///?ignored=1#post","--bypass_method=cloudscraper","--browser-fallback-enabled=false","--interactive-login-enabled=false","--log_level=silent",...(flags?["--username=flags-user","--password=flags-password","--second-factor-token=flags-second-factor"]:[])],{cwd:home,env:{...process.env,HOME:home,XDG_CONFIG_HOME:join(home,"config"),APPDATA:join(home,"appdata"),NITAN_USERNAME:login?"env-user":"",NITAN_PASSWORD:login?"env-password":"",DISCOURSE_2FA_TOKEN:login?"env-second-factor":""},stdio:["ignore","pipe","pipe"]});
    for(let i=0;i<100;i++){try{if((await fetch(base+"/health",{signal:AbortSignal.timeout(100)})).ok)return;}catch{}await pause(25);}throw new Error("isolated HTTP server did not start");
  };
  const stop=async()=>{if(!child)return;child.kill("SIGTERM");for(let i=0;i<120&&child.exitCode===null&&child.signalCode===null;i++)await pause(25);if(child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await new Promise<void>(r=>child!.once("exit",()=>r()));}child=undefined;};
  const client=new Client({name:"site-auth-proof",version:"1"});
  try{
    await start(true,mode==="flags");await client.connect(new StreamableHTTPClientTransport(new URL(base+"/mcp")));
    assert.notEqual((await client.callTool({name:"discourse_list_hot_topics",arguments:{}})).isError,true);
    let data=JSON.parse(await readFile(capture,"utf8"));assert.equal(data.site_base,"https://offline.invalid/forum");assert.equal(data.url,"https://offline.invalid/forum/hot.json");assert.equal(data.headers["User-Api-Key"],"latest-key");assert.equal(data.login.username,mode+"-user");assert.equal(data.login.password,mode+"-password");assert.equal(data.login.second_factor_token,mode+"-second-factor");
    assert.equal((await fetch(base+"/auth/callback",{method:"DELETE"})).status,200);
    const pairs=JSON.parse(await readFile(profile,"utf8")).auth_pairs;assert.deepEqual(pairs,[{site:"https://offline.invalid/forum-b",user_api_key:"sibling-key"}]);
    const publicResult=await client.callTool({name:"discourse_list_hot_topics",arguments:{}});assert.notEqual(publicResult.isError,true);assert.match(JSON.stringify(publicResult.content),/https:\/\/offline.invalid\/forum\/t\/fixture\/7/);
    data=JSON.parse(await readFile(capture,"utf8"));assert.equal(data.headers["User-Api-Key"],undefined);assert.equal(data.login,undefined);
    await client.close();await stop();await start(false);assert.equal((await (await fetch(base+"/health")).json()).authenticated,false);
  }finally{await client.close();await stop();await rm(home,{recursive:true,force:true});}
});
