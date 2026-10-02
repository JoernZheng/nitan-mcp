import test from 'node:test';
import assert from 'node:assert/strict';
import { registerReadTopic } from '../tools/builtin/read_topic.js';
import { registerSearch } from '../tools/builtin/search.js';
import { registerListHotTopics } from '../tools/builtin/list_hot_topics.js';
import { RateLimitError } from '../http/errors.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Logger } from '../util/logger.js';
const raw=(numbers:number[])=>numbers.map(n=>`a | 2026-10-01T12:03:04.123Z | #${n}\nbody-${n}\n-------------------------\n`).join('');
function setup(register:any,responder:(path:string)=>any) {
 let handler:any;const urls:string[]=[];
 const ctx:any={logger:new Logger('silent'),maxReadLength:50000,siteState:{ensureSelectedSite:()=>({base:'https://example.com/forum',client:{get:async(path:string)=>{urls.push(path);return responder(path);}}})}};
 register({registerTool:(_n:any,_c:any,h:any)=>{handler=h;}},ctx,{});
 return {call:(args:any)=>handler(args,{}),urls,ctx};
}
test('default90 resumes page remainder without omissions and keeps raw time',async()=>{
 const visible=Array.from({length:220},(_,i)=>i+1);
 const s=setup(registerReadTopic,path=>path.startsWith('/t/')?{highest_post_number:220,posts_count:220}:raw(visible.slice((Number(path.split('page=')[1])-1)*100,Number(path.split('page=')[1])*100)));
 let cursor=1;const all:number[]=[];for(let i=0;i<4;i++){
  const r=await s.call({topic_id:1,start_post_number:cursor});const m=r.structuredContent;
  all.push(...m.posts.map((p:any)=>p.number));cursor=m.pagination.next_post_number;
  if(i===0){assert.equal(cursor,91);assert.equal(m.pagination.has_more,true);assert.equal(m.posts[0].created_at,'');assert.equal(m.posts[0].updated_at,'2026-10-01T12:03:04.123Z');assert.equal(m.posts[0].content_truncated,false);}
  if(m.pagination.complete)break;
 }
 assert.deepEqual(all,visible);assert.equal(cursor,221);
});
test('loaded unconsumed posts override missing or stale highest',async()=>{
 for(const highest of [undefined,90]){
  const s=setup(registerReadTopic,path=>path.startsWith('/t/')?{highest_post_number:highest}:raw(Array.from({length:100},(_,i)=>i+1)));
  const r=(await s.call({topic_id:1})).structuredContent;
  assert.equal(r.pagination.next_post_number,91);assert.equal(r.pagination.has_more,true);assert.equal(r.pagination.complete,false);assert.equal(r.pagination.stop_reason,'limit');
 }
});
test('author cursor consumes only through returned limit, including filtered prefixes',async()=>{
 const s=setup(registerReadTopic,()=>({highest_post_number:20,post_stream:{posts:[{post_number:1,username:'other',raw:'no'},...[3,8,15,20].map(n=>({post_number:n,username:'target',raw:'abcdef',created_at:'2026-10-01T00:00:00Z'}))]}}));
 s.ctx.maxReadLength=3;const r=(await s.call({topic_id:1,username_filter:'target',post_limit:2})).structuredContent;
 assert.deepEqual(r.posts.map((p:any)=>p.number),[3,8]);assert.equal(r.pagination.next_post_number,9);assert.equal(r.pagination.complete,false);assert.equal(r.posts[0].content,'abc');assert.equal(r.posts[0].content_truncated,true);
});
test('unknown highest empty/repeated tail reports unknown completion',async()=>{
 for(const body of ['',raw([1])]){
  const s=setup(registerReadTopic,path=>path.startsWith('/t/')?{posts_count:1}:body);const m=(await s.call({topic_id:1})).structuredContent;
  assert.equal(m.pagination.complete,false);assert.equal(m.pagination.has_more,null);assert.equal(m.pagination.stop_reason,'no_progress');assert.ok(m.pagination.request_count<=4);
 }
});
test('positioning budget leaves cursor unchanged and never claims complete',async()=>{
 const s=setup(registerReadTopic,path=>path.startsWith('/t/')?{}:raw([Number(path.split('page=')[1])]));
 const m=(await s.call({topic_id:1,start_post_number:1e12})).structuredContent;
 assert.equal(m.posts.length,0);assert.equal(m.pagination.next_post_number,1e12);assert.equal(m.pagination.stop_reason,'positioning_budget');assert.equal(m.pagination.complete,false);assert.equal(m.pagination.request_count,32);
});
test('machine discovery bounds and rate hints do not require prose parsing',async()=>{
 const h=setup(registerListHotTopics,()=>({topic_list:{topics:[{id:1,title:'one',created_at:'2026-10-01T00:00:01Z'},{id:2,title:'two'}]}}));
 const hot=await h.call({limit:1});assert.equal(JSON.parse(hot.content[0].text).length,1);assert.equal(hot.structuredContent.topics[0].created_at,'2026-10-01T00:00:01Z');assert.equal(hot.structuredContent.pagination.truncated,true);assert.equal(hot.structuredContent.pagination.coverage,'hot_endpoint_page');
 const s=setup(registerSearch,()=>({topics:[{id:1,slug:'x',title:'one'}],grouped_search_result:{more_full_page_results:false}}));
 const search=await s.call({query:'one'});assert.equal(search.structuredContent.pagination.has_more,false);assert.equal(search.structuredContent.topics[0].topic_id,1);
 for(const register of [registerReadTopic,registerSearch,registerListHotTopics]){
  const e=setup(register,()=>{throw new RateLimitError(429,45000,'not returned');});const r=await e.call({topic_id:1,query:'one'});assert.equal(r.isError,true);assert.deepEqual(r.structuredContent.error,{kind:'rate_limit',status:429,retry_after_ms:45000});assert.doesNotMatch(JSON.stringify(r.structuredContent),/not returned/);
 }
});
test('actual SDK protocol preserves additive structuredContent',async()=>{
 const server=new McpServer({name:'metadata-fixture',version:'1'});const s=setup(registerReadTopic,path=>path.startsWith('/t/')?{highest_post_number:1}:raw([1]));
 registerReadTopic(server,s.ctx,{});const client=new Client({name:'metadata-client',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 try{await server.connect(a);await client.connect(b);const result=await client.callTool({name:'discourse_read_topic',arguments:{topic_id:1}});assert.equal((result.structuredContent as any).pagination.complete,true);assert.equal((result.structuredContent as any).posts[0].number,1);}finally{await client.close();await server.close();}
});
