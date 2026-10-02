import test from 'node:test';
import assert from 'node:assert/strict';
import { registerReadTopic } from '../tools/builtin/read_topic.js';
import { RateLimitError } from '../http/errors.js';

const raw = (n: number) => `alice | 2026-10-01 18:56:19 UTC | #${n}\n\nbody ${n}\n\n-------------------------\n`;
async function read(respond: (path: string) => unknown, args: any = {}) {
  let handler: any;
  registerReadTopic({ registerTool(_name: string, _config: any, fn: any) { handler = fn; } } as any,
    { siteState: { ensureSelectedSite() { return { base: 'https://offline.invalid', client: { get: async (path: string) => respond(path) } }; } }, maxReadLength: 50000 } as any, {});
  return handler({ topic_id: 1, post_limit: 500, ...args }, {});
}
test('raw edits are not creation timestamps; known JSON creation time is retained', async () => {
  const r = await read(path => path.startsWith('/t/') ? { highest_post_number: 2,
    post_stream: { posts: [{ post_number: 1, created_at: '2026-10-01T18:33:15Z' }] } } : raw(1) + raw(2));
  assert.equal(r.structuredContent.posts[0].created_at, '2026-10-01T18:33:15Z');
  assert.equal(r.structuredContent.posts[0].updated_at, '2026-10-01 18:56:19 UTC');
  assert.equal(r.structuredContent.posts[1].created_at, '');
  assert.equal(r.structuredContent.posts[1].created_at_source, 'unknown');
  assert.match(r.content[0].text, /creation time unknown; updated/);
  assert.ok(Date.parse(r.structuredContent.captured_at));
});
test('second-page 429 returns first 100 posts and consumed cursor while remaining an error', async () => {
  let calls = 0;
  const r = await read(path => {
    calls++;
    if (path.startsWith('/t/')) return { highest_post_number: 150, posts_count: 150 };
    if (path.endsWith('page=1')) return Array.from({ length: 100 }, (_, i) => raw(i + 1)).join('');
    throw new RateLimitError(429, 600000);
  });
  assert.equal(calls, 3); assert.equal(r.isError, true);
  assert.equal(r.structuredContent.posts.length, 100);
  assert.equal(r.structuredContent.pagination.next_post_number, 101);
  assert.equal(r.structuredContent.pagination.complete, false);
  assert.equal(r.structuredContent.error.retry_after_ms, 600000);
});
test('filtered nonmatching posts still return consumed cursor on later 429', async () => {
  const r = await read(path => {
    if (path.includes('/1.json?')) return { highest_post_number: 100, post_stream: { posts: [{ post_number: 50, username: 'other', raw: 'skip' }] } };
    throw new RateLimitError(429, 600000);
  }, { username_filter: 'alice' });
  assert.equal(r.isError, true); assert.deepEqual(r.structuredContent.posts, []);
  assert.equal(r.structuredContent.pagination.next_post_number, 51);
});
test('compact output keeps one full machine body and source/attachment/quote evidence', async () => {
  const body='UNIQUE_BODY\n![image](upload://abc123.png)\n[quote="alice, post:9, topic:2"]reply[/quote]';
  const r=await read(path=>path.startsWith('/t/')?{highest_post_number:1}:raw(1).replace('body 1',body),{output_format:'compact'});
  assert.doesNotMatch(r.content[0].text,/UNIQUE_BODY/);const p=r.structuredContent.posts[0];assert.match(p.content,/UNIQUE_BODY/);
  assert.equal(p.url,'https://offline.invalid/t/topic/1/1');assert.equal(p.attachments[0].url,'https://offline.invalid/uploads/short-url/abc123.png');
  assert.equal(p.quoted_posts[0].url,'https://offline.invalid/t/topic/2/9');assert.equal(r.structuredContent.coverage.attachments_reviewed,false);
});
test('byte limit stops before consuming an unreturned post and resumes without omissions', async () => {
  const body=Array.from({length:5},(_,i)=>raw(i+1).replace(`body ${i+1}`,'汉'.repeat(500))).join('');
  const respond=(path:string)=>path.startsWith('/t/')?{highest_post_number:5,posts_count:5}:body;
  const first=await read(respond,{max_response_bytes:8192});assert.ok(first.structuredContent.posts.length>0);assert.ok(first.structuredContent.posts.length<5);
  assert.ok(Buffer.byteLength(JSON.stringify(first))<=8192);assert.equal(first.structuredContent.pagination.stop_reason,'output_budget');
  const next=first.structuredContent.pagination.next_post_number;assert.equal(next,first.structuredContent.posts.at(-1).number+1);
  const rest=await read(respond,{start_post_number:next,output_format:'compact'});
  assert.deepEqual([...first.structuredContent.posts,...rest.structuredContent.posts].map((p:any)=>p.number),[1,2,3,4,5]);
});
test('oversized first post and metadata leave the cursor unchanged',async()=>{
 const r=await read(path=>path.startsWith('/t/')?{highest_post_number:1}:raw(1).replace('body 1','x'.repeat(10000)),{max_response_bytes:4096});
 assert.equal(r.structuredContent.posts.length,0);assert.equal(r.structuredContent.pagination.next_post_number,1);assert.ok(Buffer.byteLength(JSON.stringify(r))<=4096);
 const huge=await read(path=>path.startsWith('/t/')?{title:'x'.repeat(10000),highest_post_number:1}:raw(1),{max_response_bytes:4096});
 assert.equal(huge.isError,true);assert.equal(huge.structuredContent.error.kind,'output_budget');assert.ok(Buffer.byteLength(JSON.stringify(huge))<=4096);
});
test('multibyte backend errors cannot crowd out safely consumed partial posts',async()=>{
 const r=await read(path=>{
  if(path.startsWith('/t/'))return {highest_post_number:2,posts_count:2};
  if(path.endsWith('page=1'))return raw(1).replace('body 1','汉'.repeat(600));
  throw new Error('错'.repeat(512));
 },{output_format:'compact',max_response_bytes:4096});
 assert.equal(r.isError,true);assert.equal(r.structuredContent.posts.length,1);assert.equal(r.structuredContent.pagination.next_post_number,2);assert.ok(Buffer.byteLength(JSON.stringify(r))<=4096);
});
