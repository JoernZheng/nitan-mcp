import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
test('actual collect CLI uses one stdio server, exits partial, resumes and closes children',async()=>{
 const home=await mkdtemp(join(tmpdir(),'nitan-collector-stdio-')),output=join(home,'collection.json'),pids=join(home,'pids'),preload=join(home,'mock.mjs');
 const clientURL=new URL('../http/client.js',import.meta.url).href;
 await writeFile(preload,`import {HttpClient} from ${JSON.stringify(clientURL)};import {appendFileSync} from 'node:fs';if(process.argv[2]!=='collect')appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');HttpClient.prototype.get=async function(path){if(path.startsWith('/t/'))return{title:'fixture',highest_post_number:120,posts_count:120};const page=Number(path.split('page=')[1]);return Array.from({length:page===1?100:page===2?20:0},(_,i)=>{const n=(page-1)*100+i+1;return 'a | 2026-10-01T00:00:00Z | #'+n+'\\nbody\\n-------------------------\\n';}).join('');};`);
 const run=async(calls:number)=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('../index.js',import.meta.url)),'collect','--output',output,'--site','https://offline.invalid','--topics','1','--max-calls',String(calls),'--public'],{cwd:home,env:{...process.env,HOME:home,XDG_CONFIG_HOME:join(home,'config'),APPDATA:join(home,'appdata'),NODE_OPTIONS:`--import=${preload}`,NITAN_USERNAME:'',NITAN_PASSWORD:''},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});return{code,summary:JSON.parse(stdout),stderr};
 };
 try{
  const first=await run(1);assert.equal(first.code,2);assert.equal(first.summary.reason,'call_budget');assert.equal(JSON.parse(await readFile(output,'utf8')).topics['1'].next_post_number,91);
  const firstEvents=await readFile(first.summary.events_file,'utf8');assert.equal(first.summary.events_complete,true);
  assert.ok(firstEvents.split('\n').filter(Boolean).map(line=>JSON.parse(line)).some(event=>event.event==='server.started'&&event.request_interval_ms===3000&&event.run_id===first.summary.run_id));
  const second=await run(3);assert.equal(second.code,0);assert.equal(second.summary.complete,true);const saved=JSON.parse(await readFile(output,'utf8'));assert.deepEqual(saved.topics['1'].posts.map((p:any)=>p.number),Array.from({length:120},(_,i)=>i+1));
  assert.notEqual(first.summary.run_id,second.summary.run_id);assert.equal(await readFile(first.summary.events_file,'utf8'),firstEvents);
  const events=(await readFile(second.summary.events_file,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));assert.ok(events.every(event=>event.run_id===second.summary.run_id));assert.equal(events.at(-1).event,'collection.completed');
  const children=(await readFile(pids,'utf8')).trim().split('\n').map(Number);assert.equal(children.length,2);for(const pid of children)assert.throws(()=>process.kill(pid,0));
 }finally{await rm(home,{recursive:true,force:true});}
});
test('CLI total deadline bounds stalled initialization and waits for server exit',async()=>{
 const home=await mkdtemp(join(tmpdir(),'nitan-collector-startup-')),preload=join(home,'stall.mjs'),pids=join(home,'pid');
 await writeFile(preload,`import {appendFileSync} from 'node:fs';if(process.argv[2]!=='collect'){appendFileSync(${JSON.stringify(pids)},process.pid+'');await new Promise(()=>{setInterval(()=>{},1000);});}`);
 const started=Date.now(),child=spawn(process.execPath,[fileURLToPath(new URL('../index.js',import.meta.url)),'collect','--output',join(home,'out.json'),'--max-seconds','1','--public'],{cwd:home,env:{...process.env,HOME:home,NODE_OPTIONS:`--import=${preload}`},stdio:['ignore','pipe','pipe']});child.stdout.resume();child.stderr.resume();
 try{const code=await new Promise(resolve=>child.once('close',resolve));assert.equal(code,1);assert.ok(Date.now()-started<7500);const pid=Number(await readFile(pids,'utf8'));assert.throws(()=>process.kill(pid,0));}finally{await rm(home,{recursive:true,force:true});}
});
test('public collector refuses explicit login flags before spawning a server',async()=>{
 const home=await mkdtemp(join(tmpdir(),'nitan-public-flags-'));const child=spawn(process.execPath,[fileURLToPath(new URL('../index.js',import.meta.url)),'collect','--output',join(home,'out.json'),'--public','--','--username=fixture-user','--password=fixture-password'],{cwd:home,env:{...process.env,HOME:home},stdio:['ignore','pipe','pipe']});child.stdout.resume();let stderr='';child.stderr.on('data',c=>stderr+=c);
 try{assert.equal(await new Promise(resolve=>child.once('close',resolve)),1);assert.match(stderr,/cannot be combined with credential flags/);assert.doesNotMatch(stderr,/fixture-password/);}finally{await rm(home,{recursive:true,force:true});}
});
test('actual CLI previews two topics, lists locally and resumes without losing floors',async()=>{
 const home=await mkdtemp(join(tmpdir(),'nitan-preview-cli-')),output=join(home,'out.json'),pids=join(home,'pids'),preload=join(home,'mock.mjs');
 const clientURL=new URL('../http/client.js',import.meta.url).href;
 await writeFile(preload,`import {HttpClient} from ${JSON.stringify(clientURL)};import {appendFileSync} from 'node:fs';if(process.argv[2]!=='collect'&&process.argv[2]!=='read-collection')appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');HttpClient.prototype.get=async function(path){if(path.startsWith('/t/'))return{title:'fixture',highest_post_number:120,posts_count:120};return Array.from({length:120},(_,i)=>'a | now | #'+(i+1)+'\\n\\nbody'+(i+1)+'\\n\\n-------------------------\\n').join('');};`);
 const run=async(args:string[])=>{const child=spawn(process.execPath,[fileURLToPath(new URL('../index.js',import.meta.url)),...args],{cwd:home,env:{...process.env,HOME:home,NODE_OPTIONS:`--import=${preload}`},stdio:['ignore','pipe','pipe']});let stdout='';child.stdout.on('data',c=>stdout+=c);child.stderr.resume();return{code:await new Promise(resolve=>child.once('close',resolve)),stdout};};
 try{
  const first=await run(['collect','--output',output,'--topics','1,2','--preview','--post-limit','5','--max-calls','2','--public']);
  assert.equal(first.code,2);const summary=JSON.parse(first.stdout);assert.equal(summary.mode,'preview');assert.equal(summary.previewed_topics,2);assert.equal(summary.reason,'preview');
  const before=await readFile(output,'utf8'),beforePids=await readFile(pids,'utf8');
  const list=await run(['read-collection','--input',output,'--list','--limit','1']);assert.equal(list.code,0);const directory=JSON.parse(list.stdout);assert.equal(directory.topics.length,1);assert.equal(directory.topics[0].saved_posts,5);assert.equal(directory.pagination.next_offset,1);
  assert.equal(await readFile(pids,'utf8'),beforePids);assert.equal(await readFile(output,'utf8'),before);
  assert.equal((await run(['read-collection','--input',output,'--list','--topic','1'])).code,1);
  const full=await run(['collect','--output',output,'--topics','1,2','--post-limit','300','--max-calls','4','--public']);assert.equal(full.code,0);
  const saved=JSON.parse(await readFile(output,'utf8'));for(const t of Object.values(saved.topics) as any[])assert.deepEqual(t.posts.map((p:any)=>p.number),Array.from({length:120},(_,i)=>i+1));
  for(const pid of (await readFile(pids,'utf8')).trim().split('\n').map(Number))assert.throws(()=>process.kill(pid,0));
 }finally{await rm(home,{recursive:true,force:true});}
});
