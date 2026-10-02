import test from 'node:test';
import assert from 'node:assert/strict';
import { registerListHotTopics } from '../tools/builtin/list_hot_topics.js';
import { registerListTopTopics } from '../tools/builtin/list_top_topics.js';
import { RateLimitError } from '../http/errors.js';
const setup = (register: any, reply: any) => {
  let handler: any; const urls: string[] = [];
  register({ registerTool(_n: string, _m: any, fn: any) { handler = fn; } }, { siteState: { ensureSelectedSite() { return { base: 'https://offline.invalid/forum', client: { get: async (path: string) => { urls.push(path); return reply(path); } } }; } } }, {});
  return { call: (args: any) => handler(args, {}), urls };
};
const topics = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, title: `topic${i + 1}`, tags: [{ name: 'tag' }] }));
test('hot local limit continuation consumes remainder before next server page', async () => {
  const s = setup(registerListHotTopics, () => ({ topic_list: { topics, more_topics_url: '/forum/hot.json?page=1' } }));
  const first = (await s.call({ limit: 10 })).structuredContent;
  assert.equal(first.pagination.next_page, 0); assert.equal(first.pagination.next_offset, 10);
  const rest = (await s.call({ limit: 50, page: 0, offset: 10 })).structuredContent;
  assert.deepEqual([...first.topics, ...rest.topics].map((x: any) => x.id), topics.map(x => x.id));
  assert.equal(rest.pagination.next_page, 1); assert.equal(rest.pagination.next_offset, 0);
  assert.deepEqual(rest.topics[0].tags, ['tag']);
});
test('top daily uses actual top endpoint and returns structured empty/error results', async () => {
  const s = setup(registerListTopTopics, () => ({ topic_list: { topics: [], more_topics_url: null } }));
  const r = await s.call({ period: 'daily', page: 1 });
  assert.equal(s.urls[0], '/top.json?period=daily&page=1');
  assert.equal(r.structuredContent.pagination.has_more, false);
  const e = await setup(registerListTopTopics, () => { throw new RateLimitError(429, 600000); }).call({});
  assert.equal(e.isError, true); assert.equal(e.structuredContent.error.kind, 'rate_limit');
});
test('untrusted or nonadvancing server continuation never becomes a fetch cursor', async () => {
  for (const more of ['https://evil.invalid/hot.json?page=2', '/hot.json?page=0', '/hot.json?page=99']) {
    const r = await setup(registerListHotTopics, () => ({ topic_list: { topics: [topics[0]], more_topics_url: more } })).call({});
    assert.equal(r.structuredContent.pagination.has_more, true); assert.equal(r.structuredContent.pagination.next_page, null);
  }
});
