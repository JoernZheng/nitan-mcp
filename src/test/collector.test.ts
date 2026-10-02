import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, readCollectionChunk, readCollectionIndex, type CollectionOptions } from '../collector.js';
const site='https://offline.invalid/forum';
const options=(output:string):CollectionOptions=>({output,site,topicIds:[1],maxTopics:10,maxCalls:20,maxSeconds:5,maxBytes:1e6,postLimit:90});
function responder(highest=230) {return async(_name:string,args:any)=>{
 const start=args.start_post_number??1,numbers=Array.from({length:Math.max(0,Math.min(args.post_limit,highest-start+1))},(_,i)=>start+i);const next=numbers.at(-1)!+1||start;
 return {structuredContent:{site,topic:{id:args.topic_id,title:'fixture',url:site+'/t/fixture/'+args.topic_id},posts:numbers.map(number=>({number,username:'a',created_at:'2026-10-01T00:00:00Z',content:'body',content_truncated:false})),pagination:{next_post_number:next,complete:next>highest,stop_reason:next>highest?'highest':'limit'}}};
};}
async function fixture(run:(output:string,home:string)=>Promise<void>){const home=await mkdtemp(join(tmpdir(),'nitan-collector-'));try{await run(join(home,'collection.json'),home);}finally{await rm(home,{recursive:true,force:true});}}
test('bounded first run and resume commit 230 posts and cursor without omissions',()=>fixture(async(output,home)=>{
 const first=await collect({...options(output),maxCalls:1},responder());assert.equal(first.reason,'call_budget');let saved=JSON.parse(await readFile(output,'utf8'));assert.equal(saved.topics['1'].next_post_number,91);assert.equal(saved.topics['1'].posts.length,90);
 const second=await collect(options(output),responder());assert.equal(second.complete,true);saved=JSON.parse(await readFile(output,'utf8'));assert.deepEqual(saved.topics['1'].posts.map((p:any)=>p.number),Array.from({length:230},(_,i)=>i+1));assert.equal(saved.topics['1'].next_post_number,231);assert.equal((await readdir(home)).filter(n=>n.endsWith('.tmp')).length,0);
}));
test('failed next call preserves committed content and resumes from saved cursor',()=>fixture(async output=>{
 let count=0;const base=responder();const first=await collect(options(output),async(name,args)=>{if(++count===2)throw new Error('simulated worker loss');return base(name,args);});assert.equal(first.reason,'collection_error');assert.equal(JSON.parse(await readFile(output,'utf8')).topics['1'].next_post_number,91);
 const seen:number[]=[];await collect(options(output),async(name,args)=>{seen.push(args.start_post_number as number);return base(name,args);});assert.equal(seen[0],91);
}));
test('rate limit persists cooldown across runs with zero follow-up tool calls',()=>fixture(async output=>{
 const first=await collect(options(output),async()=>({isError:true,structuredContent:{error:{kind:'rate_limit',status:429,retry_after_ms:60000}}}));assert.equal(first.reason,'rate_limit');let calls=0;const second=await collect(options(output),async()=>{calls++;return{};});assert.equal(second.reason,'cooldown');assert.equal(calls,0);assert.ok(second.retry_after_ms>50000);
}));
test('output limit never commits a cursor without contents',()=>fixture(async output=>{
 const first=await collect({...options(output),maxBytes:1800},responder());assert.equal(first.reason,'output_budget');const saved=JSON.parse(await readFile(output,'utf8'));assert.equal(saved.topics['1'],undefined);assert.ok(Buffer.byteLength(await readFile(output))<=1800);
 assert.equal((await collect(options(output),responder())).complete,true);
}));
test('snapshot site/filter mismatch stops before requests',()=>fixture(async output=>{
 await collect({...options(output),maxCalls:1},responder());let calls=0;
 for(const change of [{site:'https://offline.invalid/other'},{usernameFilter:'b'}])await assert.rejects(collect({...options(output),...change},async()=>{calls++;return{};}),/site\/filter differs/);
 assert.equal(calls,0);
}));
test('unknown nonadvancing tail stops without retry loop or completion claim',()=>fixture(async output=>{
 const result=await collect(options(output),async()=>({structuredContent:{site,topic:{id:1,title:'one',url:site+'/t/1'},posts:[],pagination:{next_post_number:1,complete:false,stop_reason:'no_progress'}}}));assert.equal(result.calls,1);assert.equal(result.reason,'unconfirmed_tail');assert.equal(JSON.parse(await readFile(output,'utf8')).topics['1'].next_post_number,1);
}));
test('collection deadline reaches pending tool signal and retains no unseen cursor',()=>fixture(async output=>{
 const result=await collect({...options(output),maxSeconds:0.02},async(_n,_a,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));assert.equal(result.reason,'time_budget');assert.deepEqual(JSON.parse(await readFile(output,'utf8')).topics,{});
}));
test('hot discovery is bounded and preserves explicit coverage',()=>fixture(async output=>{
 const base=responder(1);const result=await collect({...options(output),topicIds:[],maxTopics:1},async(name,args)=>name==='discourse_list_hot_topics'?{structuredContent:{site,topics:[{id:1},{id:2}]}}:base(name,args));assert.equal(result.reason,'topic_budget');assert.equal(result.selected_topics_complete,true);assert.equal(result.discovery_complete,false);const saved=JSON.parse(await readFile(output,'utf8'));assert.equal(saved.discovery.coverage,'hot_endpoint_page');assert.deepEqual(saved.discovery.ids,[1,2]);assert.deepEqual(Object.keys(saved.topics),['1']);
}));
test('small topic budget resumes never-started candidates before refreshing completed ones',()=>fixture(async output=>{
 const opts={...options(output),topicIds:[1,2],maxTopics:1};await collect(opts,responder(1));assert.deepEqual(Object.keys(JSON.parse(await readFile(output,'utf8')).topics),['1']);
 await collect(opts,responder(1));assert.deepEqual(Object.keys(JSON.parse(await readFile(output,'utf8')).topics),['1','2']);
}));
test('concurrent collectors reject the same output and release owned lock on cancellation',()=>fixture(async output=>{
 const control=new AbortController();let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
 const first=collect(options(output),async(_n,_a,signal)=>{entered();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},control.signal);
 await ready;await assert.rejects(collect(options(output),responder()),/output is locked/);control.abort();assert.equal((await first).reason,'cancelled');assert.equal((await collect(options(output),responder(1))).complete,true);
}));
test('unsavable output budget prevents discovery and lost-cooldown retry',()=>fixture(async output=>{
 let calls=0;const call=async()=>{calls++;return{isError:true,structuredContent:{error:{kind:'rate_limit',retry_after_ms:60000}}};};
 assert.equal((await collect({...options(output),topicIds:[],maxBytes:1},call)).reason,'output_budget');assert.equal(calls,0);
 await collect(options(output),responder(1));assert.equal((await collect({...options(output),topicIds:[],maxBytes:300},call)).reason,'output_budget');assert.equal(calls,0);
}));
test('partial topic error commits consumed posts and cooldown before stopping',()=>fixture(async output=>{
 const base=await responder(230)('discourse_read_topic',{topic_id:1,start_post_number:1,post_limit:100});
 let calls=0;const result=await collect(options(output),async()=>{calls++;return {...base,isError:true,structuredContent:{...base.structuredContent,pagination:{...base.structuredContent.pagination,complete:false},error:{kind:'rate_limit',retry_after_ms:600000}}};});
 const saved=JSON.parse(await readFile(output,'utf8'));assert.equal(calls,1);assert.equal(result.reason,'rate_limit');assert.equal(saved.topics['1'].posts.length,100);assert.equal(saved.topics['1'].next_post_number,101);assert.ok(saved.cooldown_until>Date.now()+590000);
}));
test('completed topic refresh overwrites edited first post without rewinding resume cursor',()=>fixture(async output=>{
 let body='old offer';const base=responder(2);const starts:number[]=[];
 const call=async(name:string,args:any)=>{starts.push(args.start_post_number);const r=await base(name,args);for(const p of r.structuredContent.posts)if(p.number===1)p.content=body;return r;};
 await collect(options(output),call);body='offer DEAD';starts.length=0;await collect(options(output),call);
 const saved=JSON.parse(await readFile(output,'utf8'));assert.deepEqual(starts,[1,3]);assert.equal(saved.topics['1'].posts[0].content,'offer DEAD');assert.equal(saved.topics['1'].next_post_number,3);
}));
test('legacy raw snapshot timestamps migrate conservatively before resumed reading',()=>fixture(async output=>{
 await collect({...options(output),maxCalls:1},responder());const old=JSON.parse(await readFile(output,'utf8'));old.version=1;await writeFile(output,JSON.stringify(old));
 await collect(options(output),responder());const saved=JSON.parse(await readFile(output,'utf8'));assert.equal(saved.version,2);assert.equal(saved.topics['1'].posts[0].created_at,'');assert.equal(saved.topics['1'].posts[0].updated_at,'2026-10-01T00:00:00Z');assert.equal(saved.topics['1'].next_post_number,231);
}));
test('single-call completed refresh budget is reserved for new replies',()=>fixture(async output=>{
 await collect(options(output),responder(1));const starts:number[]=[];
 await collect({...options(output),maxCalls:1},async(name,args)=>{starts.push(args.start_post_number as number);return responder(2)(name,args);});
 assert.deepEqual(starts,[2]);const saved=JSON.parse(await readFile(output,'utf8'));assert.equal(saved.topics['1'].next_post_number,3);assert.equal(saved.topics['1'].posts.length,2);
}));
test('legacy partial isError without error metadata never becomes successful completion',()=>fixture(async output=>{
 const r=await responder(1)('discourse_read_topic',{topic_id:1,start_post_number:1,post_limit:1});
 const result=await collect(options(output),async()=>({...r,isError:true}));
 assert.equal(result.complete,false);assert.equal(result.reason,'tool_error');
 const saved=JSON.parse(await readFile(output,'utf8'));assert.equal(saved.topics['1'].complete,false);assert.equal(saved.topics['1'].next_post_number,2);
}));
test('hot discovery follows bounded windows, deduplicates IDs and distinguishes coverage',()=>fixture(async output=>{
 const seen:any[]=[];const base=responder(1);
 const result=await collect({...options(output),topicIds:[],hotLimit:50,maxDiscoveryPages:2},async(name,args)=>{
  if(name!=='discourse_list_hot_topics')return base(name,args);
  seen.push(args);return {structuredContent:{site,topics:(seen.length===1?[1,2]:[2,3]).map(id=>({id})),pagination:{has_more:seen.length===1,next_page:seen.length===1?1:null,next_offset:seen.length===1?0:null}}};
 });
 assert.equal(result.complete,true);assert.equal(result.discovery_complete,true);assert.deepEqual(seen,[{limit:50},{limit:50,page:1,offset:0}]);
 assert.deepEqual(JSON.parse(await readFile(output,'utf8')).discovery.ids,[1,2,3]);
}));
test('discovery saves found candidates before a later page hits the call budget',()=>fixture(async output=>{
 const result=await collect({...options(output),topicIds:[],maxCalls:1,maxDiscoveryPages:2},async()=>({structuredContent:{site,topics:[{id:1}],pagination:{has_more:true,next_page:1,next_offset:0}}}));
 assert.equal(result.reason,'call_budget');assert.equal(result.discovery_complete,false);assert.deepEqual(JSON.parse(await readFile(output,'utf8')).discovery.ids,[1]);
}));
test('partial failure from a different site is rejected before storing posts or cooldown',()=>fixture(async output=>{
 const r=await responder(1)('discourse_read_topic',{topic_id:1,start_post_number:1,post_limit:1});
 const result=await collect(options(output),async()=>({...r,isError:true,structuredContent:{...r.structuredContent,site:'https://other.invalid',error:{kind:'rate_limit',retry_after_ms:600000}}}));
 assert.equal(result.reason,'invalid_response');const saved=JSON.parse(await readFile(output,'utf8'));assert.deepEqual(saved.topics,{});assert.equal(saved.cooldown_until,0);
}));
test('repeated small-budget hot runs reserve a read call and advance backlog',()=>fixture(async output=>{
 const opts={...options(output),topicIds:[],hotLimit:1,maxDiscoveryPages:2,maxCalls:2};const base=responder(230);let reads=0;
 const call=async(name:string,args:any)=>name==='discourse_list_hot_topics'?{structuredContent:{site,topics:[{id:1}],pagination:{has_more:true,next_page:1,next_offset:0}}}:(reads++,base(name,args));
 await collect(opts,call);const first=JSON.parse(await readFile(output,'utf8')).topics['1'].next_post_number;
 await collect(opts,call);assert.equal(reads,2);assert.ok(JSON.parse(await readFile(output,'utf8')).topics['1'].next_post_number>first);
}));
test('local chunk reading is bounded and never calls MCP or changes saved content',()=>fixture(async output=>{
 await collect(options(output),responder(120));const before=await readFile(output,'utf8');
 const first=await readCollectionChunk(output,1,1,30,4096);assert.ok(Buffer.byteLength(JSON.stringify(first))<=4096);
 const second=await readCollectionChunk(output,1,first.pagination.next_post_number,30,4096);
 assert.ok(first.posts.length>0);assert.equal(second.posts[0].number,first.pagination.next_post_number);assert.equal(await readFile(output,'utf8'),before);
}));
test('oversized local first post asks for more budget instead of successful zero progress',()=>fixture(async output=>{
 const base=responder(1);await collect(options(output),async(name,args)=>{const r=await base(name,args);r.structuredContent.posts[0].content='汉'.repeat(5000);return r;});
 await assert.rejects(readCollectionChunk(output,1,1,50,4096),/increase --max-bytes/);
}));
test('preview reads each selected topic once and full resume preserves every post',()=>fixture(async output=>{
 const seen:number[]=[];const base=responder(230);
 const first=await collect({...options(output),topicIds:[1,2,3],preview:true,postLimit:5,maxCalls:3},async(name,args)=>{seen.push(args.topic_id as number);return base(name,args);});
 assert.deepEqual(seen,[1,2,3]);assert.equal(first.reason,'preview');assert.equal(first.complete,false);assert.equal(first.selected_topics_complete,false);
 const before=await readFile(output,'utf8');const index=await readCollectionIndex(output,0,2,4096);
 assert.deepEqual(index.topics.map(t=>t.id),[1,2]);assert.ok(index.topics.every(t=>t.saved_posts===5&&t.next_post_number===6&&!t.complete));assert.equal(index.pagination.has_more_stored,true);
 assert.doesNotMatch(JSON.stringify(index),/"content"|"body"/);assert.equal(await readFile(output,'utf8'),before);
 assert.equal(index.username_filter,null);
 assert.deepEqual((await readCollectionIndex(output,index.pagination.next_offset)).topics.map(t=>t.id),[3]);
 const starts:number[]=[];const second=await collect(options(output),async(name,args)=>{starts.push(args.start_post_number as number);return base(name,args);});
 assert.equal(second.complete,true);assert.equal(starts[0],6);
 const saved=JSON.parse(await readFile(output,'utf8'));for(const t of Object.values(saved.topics) as any[])assert.deepEqual(t.posts.map((p:any)=>p.number),Array.from({length:230},(_,i)=>i+1));
}));
test('preview stops at first partial error and commits cooldown without touching another topic',()=>fixture(async output=>{
 const seen:number[]=[];const base=responder(230);const result=await collect({...options(output),topicIds:[1,2],preview:true,postLimit:5},async(name,args)=>{seen.push(args.topic_id as number);const r=await base(name,args);return {...r,isError:true,structuredContent:{...r.structuredContent,error:{kind:'rate_limit',retry_after_ms:60000}}};});
 assert.deepEqual(seen,[1]);assert.equal(result.reason,'rate_limit');const saved=JSON.parse(await readFile(output,'utf8'));assert.equal(saved.topics['1'].next_post_number,6);assert.ok(saved.cooldown_until>Date.now());assert.equal(saved.topics['2'],undefined);
}));
test('preview preserves completed and unknown-tail semantics',()=>fixture(async output=>{
 assert.equal((await collect({...options(output),preview:true},responder(1))).complete,true);
 const next=await collect({...options(output),preview:true},async()=>({structuredContent:{site,topic:{id:1,title:'fixture',url:site+'/t/1'},posts:[],pagination:{next_post_number:2,complete:false,stop_reason:'no_progress'}}}));
 assert.equal(next.reason,'unconfirmed_tail');assert.equal(next.complete,false);
}));
test('local directory byte overflow reports no progress and invalid bounds fail',()=>fixture(async output=>{
 const base=responder(1);await collect(options(output),async(name,args)=>{const r=await base(name,args);r.structuredContent.topic.title='汉'.repeat(2000);return r;});
 await assert.rejects(readCollectionIndex(output,0,50,4096),/increase --max-bytes/);
 for(const args of [[-1,50,4096],[0,0,4096],[0,501,4096],[0,50,100]])await assert.rejects(readCollectionIndex(output,...args as [number,number,number]),/Invalid collection directory/);
 assert.equal((await readCollectionIndex(output,1)).topics.length,0);
}));
test('local directory labels author-filtered collections explicitly',()=>fixture(async output=>{
 await collect({...options(output),usernameFilter:'a'},responder(1));
 assert.equal((await readCollectionIndex(output)).username_filter,'a');
}));
