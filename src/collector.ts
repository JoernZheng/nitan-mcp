import { readFile, writeFile, mkdir, rename, rm, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { normalizeSiteBase } from './util/site_url.js';
import { Logger } from './util/logger.js';

const postSchema = z.object({ number: z.number().int().positive(), username: z.string(), created_at: z.string(), updated_at: z.string().optional(), created_at_source: z.enum(['json', 'unknown']).optional(), content: z.string(), content_truncated: z.boolean(), url: z.string().optional(), reply_to_post_number: z.number().int().positive().optional(), attachments: z.array(z.object({ reference: z.string(), kind: z.enum(['image','file']), url: z.string().optional() })).optional(), quoted_posts: z.array(z.object({ topic_id: z.number().int().positive(), post_number: z.number().int().positive(), url: z.string() })).optional() });
const topicSchema = z.object({ id: z.number().int().positive(), title: z.string(), url: z.string(), posts: z.array(postSchema), next_post_number: z.number().int().positive(), complete: z.boolean(), updated_at: z.string().optional() });
const snapshotSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]), site: z.string(), username_filter: z.string(), updated_at: z.string(), cooldown_until: z.number().nonnegative(), topics: z.record(topicSchema), discovery: z.object({ kind: z.enum(['explicit', 'hot', 'search']), ids: z.array(z.number().int().positive()), coverage: z.string(), query: z.string().optional(), captured_at: z.string().optional(), page_windows: z.number().int().nonnegative().optional(), has_more: z.boolean().nullable().optional(), next_page: z.number().int().nonnegative().nullable().optional(), next_offset: z.number().int().nonnegative().nullable().optional() }), status: z.string() });
type Snapshot = z.infer<typeof snapshotSchema>;
function migrate(snapshot: Snapshot) {
  if (snapshot.version === 1) {
    for (const topic of Object.values(snapshot.topics)) for (const post of topic.posts) {
      if (snapshot.username_filter) post.created_at_source = post.created_at ? 'json' : 'unknown';
      else { post.updated_at = post.created_at; post.created_at = ''; post.created_at_source = 'unknown'; }
    }
    snapshot.version = 2;
  }
  return snapshot;
}
export type CollectionOptions = { output: string; site: string; topicIds: number[]; preview?: boolean; usernameFilter?: string; query?: string; hotLimit?: number; maxDiscoveryPages?: number; runId?: string; eventSink?: (line: string) => void; maxTopics: number; maxCalls: number; maxSeconds: number; maxBytes: number; postLimit: number };
type Call = (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<any>;
class Stop extends Error { constructor(public reason: string) { super(reason); } }

/** Contents and consumed cursor commit together in one atomic local snapshot. */
async function save(output: string, snapshot: Snapshot, maxBytes: number) {
  const text = JSON.stringify(snapshot, null, 2) + '\n';
  if (Buffer.byteLength(text) > maxBytes) throw new Stop('output_budget');
  const temporary = output + '.' + randomUUID() + '.tmp';
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  try { await writeFile(temporary, text, { mode: 0o600, flag: 'wx' }); await rename(temporary, output); }
  finally { await rm(temporary, { force: true }); }
}

export async function collect(options: CollectionOptions, call: Call, outerSignal?: AbortSignal) {
  const output = resolve(options.output), lockPath = output + '.lock';
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error: any) { if (error?.code === 'EEXIST') throw new Error(`Collection output is locked: ${lockPath}. If a prior run crashed, verify its recorded PID has exited before removing this lock.`); throw error; }
  try { await lock.writeFile(JSON.stringify({ pid: process.pid })); return await collectUnlocked(options, call, outerSignal); }
  finally { await lock.close(); await rm(lockPath, { force: true }); }
}

async function collectUnlocked(options: CollectionOptions, call: Call, outerSignal?: AbortSignal) {
  const output = resolve(options.output), site = normalizeSiteBase(options.site);
  const filter = (options.usernameFilter ?? '').trim().toLowerCase();
  const started = Date.now(); let calls = 0, pages = 0, added = 0, reason = 'complete';
  let selectedIds: number[] | undefined;
  const completedSelected = new Set<number>();
  let snapshot: Snapshot = { version: 2, site, username_filter: filter, updated_at: new Date().toISOString(), cooldown_until: 0, topics: {}, discovery: { kind: 'explicit', ids: [], coverage: 'explicit_topics' }, status: 'partial' };
  try { snapshot = snapshotSchema.parse(JSON.parse(await readFile(output, 'utf8'))); }
  catch (error: any) { if (error?.code !== 'ENOENT') throw new Error('Invalid collection snapshot; preserve it and choose a new output file'); }
  if (snapshot.site !== site || snapshot.username_filter !== filter) throw new Error('Snapshot site/filter differs; choose a separate output file');
  snapshot = migrate(snapshot);
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(new DOMException('Collection deadline', 'TimeoutError')), options.maxSeconds * 1000);
  const signal = outerSignal ? AbortSignal.any([control.signal, outerSignal]) : control.signal;
  const abortReason = () => outerSignal?.aborted && outerSignal.reason?.name !== 'TimeoutError' ? 'cancelled' : 'time_budget';
  const errorStop = (error: any) => new Stop(error?.kind === 'rate_limit' ? 'rate_limit' : error?.kind === 'cancelled' ? 'cancelled' : error?.kind === 'timeout' ? 'time_budget' : error?.kind === 'output_budget' ? 'output_budget' : 'tool_error');
  const budgetCall: Call = async (name, args) => {
    if (signal.aborted) throw new Stop(abortReason());
    if (calls >= options.maxCalls) throw new Stop('call_budget');
    calls++;
    const result = await call(name, args, signal);
    if (result?.isError) {
      const error = result.structuredContent?.error;
      if (Array.isArray(result.structuredContent?.posts) && result.structuredContent?.pagination && result.structuredContent.site !== site) throw new Stop('invalid_response');
      if (error?.kind === 'rate_limit' && typeof error.retry_after_ms === 'number' && Number.isFinite(error.retry_after_ms) && error.retry_after_ms >= 0) {
        snapshot.cooldown_until = Date.now() + error.retry_after_ms;
      }
      // Topic errors may include safely consumed posts. Validate and commit them
      // with their cursor before stopping; never continue after a rate limit.
      if (name !== 'discourse_read_topic' || !Array.isArray(result.structuredContent?.posts) || !result.structuredContent?.pagination) throw errorStop(error);
      return { ...result.structuredContent, error: error ?? { kind: 'request_failed' },
        pagination: { ...result.structuredContent.pagination, complete: false } };
    }
    if (!result?.structuredContent || result.structuredContent.site !== site) throw new Stop('invalid_response');
    return result.structuredContent;
  };
  try {
    if (Buffer.byteLength(JSON.stringify(snapshot, null, 2) + '\n') > options.maxBytes - 256) throw new Stop('output_budget');
    if (snapshot.cooldown_until > Date.now()) throw new Stop('cooldown');
    snapshot.cooldown_until = 0;
    const backlog = snapshot.discovery.ids.filter(id => !snapshot.topics[String(id)]?.complete);
    let ids = [...new Set([...backlog, ...options.topicIds])];
    if (options.query || options.hotLimit !== undefined || ids.length === 0) {
      let page = 0, offset = 0;
      const windows = options.query ? 1 : Math.min(20, options.maxDiscoveryPages ?? 1);
      const seenPages = new Set<string>();
      for (let step = 0; step < windows; step++) {
        const unread = ids.some(id => !snapshot.topics[String(id)]?.complete) || Object.values(snapshot.topics).some(topic => !topic.complete);
        if (unread && calls >= options.maxCalls - 1) break; // reserve progress on the backlog
        const key = `${page}:${offset}`;
        if (seenPages.has(key)) break;
        seenPages.add(key);
        const data = options.query
          ? await budgetCall('discourse_search', { query: options.query, max_results: options.maxTopics }, signal)
          : await budgetCall('discourse_list_hot_topics', { limit: options.hotLimit ?? Math.min(10, options.maxTopics), ...(step ? { page, offset } : {}) }, signal);
        if (!Array.isArray(data.topics)) throw new Stop('invalid_response');
        const found = data.topics.map((topic: any) => topic.id ?? topic.topic_id);
        if (!found.every((id: any) => Number.isSafeInteger(id) && id > 0)) throw new Stop('invalid_response');
        ids = [...new Set([...ids, ...found])];
        const p = data.pagination;
        const more = typeof p?.has_more === 'boolean' ? p.has_more : null;
        const nextPage = Number.isSafeInteger(p?.next_page) && p.next_page >= 0 && p.next_page <= 20 ? p.next_page : null;
        const nextOffset = Number.isSafeInteger(p?.next_offset) && p.next_offset >= 0 && p.next_offset <= 10000 ? p.next_offset : null;
        snapshot.discovery = { kind: options.query ? 'search' : 'hot', ids, coverage: options.query ? 'search_endpoint_page' : step === 0 ? 'hot_endpoint_page' : 'hot_endpoint_pages', ...(options.query ? { query: options.query } : {}), captured_at: new Date().toISOString(), page_windows: step + 1, has_more: more, next_page: nextPage, next_offset: nextOffset };
        await save(output, snapshot, options.maxBytes - 256);
        if (options.query || more !== true || nextPage === null || nextOffset === null || !found.length) break;
        page = nextPage; offset = nextOffset;
      }
    } else snapshot.discovery = { kind: 'explicit', ids, coverage: 'explicit_topics' };
    const pending = Object.values(snapshot.topics).filter(topic => !topic.complete).map(topic => topic.id);
    const candidates = [...new Set([...pending, ...ids])].sort((a,b) => {
      const x=snapshot.topics[String(a)], y=snapshot.topics[String(b)];
      return Number(Boolean(x?.complete))-Number(Boolean(y?.complete)) || (x?.updated_at ?? '').localeCompare(y?.updated_at ?? '');
    });
    const selected = candidates.slice(0, options.maxTopics);
    selectedIds = selected;
    if (selected.length < candidates.length) reason = 'topic_budget';
    await save(output, snapshot, options.maxBytes - 256);
    for (const id of selected) {
      let topic = snapshot.topics[String(id)];
      let cursor = topic?.next_post_number ?? 1;
      // Never let refresh consume the only call needed to advance the tail.
      if (!options.preview && topic?.complete && topic.posts.length && options.maxCalls - calls >= 2) {
        const first = topic.posts[0].number;
        const data = await budgetCall('discourse_read_topic', { topic_id: id, start_post_number: first, post_limit: 1, output_format: 'compact', ...(filter ? { username_filter: filter } : {}) }, signal);
        const refreshed = z.array(postSchema).safeParse(data.posts);
        if (!refreshed.success || data.topic?.id !== id || typeof data.topic.title !== 'string' || typeof data.topic.url !== 'string' || !refreshed.data.every(post => post.number >= first && (!filter || post.username.toLowerCase() === filter))) throw new Stop('invalid_response');
        const existing = new Map(topic.posts.map(post => [post.number, post]));
        for (const post of refreshed.data) if (existing.has(post.number)) existing.set(post.number, post);
        const proposed = { ...topic, title: data.topic.title, url: data.topic.url, posts: [...existing.values()], updated_at: new Date().toISOString() };
        const nextSnapshot = { ...snapshot, topics: { ...snapshot.topics, [String(id)]: proposed } };
        await save(output, nextSnapshot, options.maxBytes - 256);
        snapshot = nextSnapshot; topic = proposed; pages++;
        if (data.error) throw errorStop(data.error);
      }
      while (true) {
        const data = await budgetCall('discourse_read_topic', { topic_id: id, start_post_number: cursor, post_limit: options.postLimit, output_format: 'compact', ...(filter ? { username_filter: filter } : {}) }, signal);
        const posts = z.array(postSchema).safeParse(data.posts);
        const pagination = data.pagination;
        const next = pagination?.next_post_number;
        if (!posts.success || data.topic?.id !== id || typeof data.topic.title !== 'string' || typeof data.topic.url !== 'string' || !Number.isSafeInteger(next) || next < cursor || typeof pagination.complete !== 'boolean' || !posts.data.every(post => post.number >= cursor && post.number < next && (!filter || post.username.toLowerCase() === filter))) throw new Stop('invalid_response');
        const previous = topic?.posts ?? [];
        const merged = new Map(previous.map(post => [post.number, post]));
        for (const post of posts.data) merged.set(post.number, post);
        const proposed = { id, title: data.topic.title, url: data.topic.url, posts: [...merged.values()].sort((a, b) => a.number - b.number), next_post_number: next, complete: pagination.complete, updated_at: new Date().toISOString() };
        const nextSnapshot = { ...snapshot, topics: { ...snapshot.topics, [String(id)]: proposed }, updated_at: new Date().toISOString() };
        await save(output, nextSnapshot, options.maxBytes - 256); // never advance before content commits
        snapshot = nextSnapshot; topic = proposed; pages++; added += merged.size - previous.length;
        if (data.error) throw errorStop(data.error);
        if (pagination.complete) { completedSelected.add(id); break; }
        if (pagination.stop_reason === 'output_budget' && next === cursor) throw new Stop('output_budget');
        if (next === cursor || pagination.stop_reason === 'positioning_budget' || pagination.stop_reason === 'no_progress') { reason = 'unconfirmed_tail'; break; }
        if (options.preview) { if (reason === 'complete') reason = 'preview'; break; }
        cursor = next;
      }
    }
  } catch (error: any) {
    reason = error instanceof Stop ? error.reason : signal.aborted ? (abortReason()) : 'collection_error';
  } finally { clearTimeout(timer); }
  snapshot.status = reason; snapshot.updated_at = new Date().toISOString();
  try { await save(output, snapshot, options.maxBytes); } catch (error) { if (!(error instanceof Stop)) throw error; reason = 'output_budget'; }
  const complete = reason === 'complete';
  new Logger('info', options.runId, options.eventSink).event('collection.completed', { duration_ms: Date.now() - started, request_count: calls, mcp_calls: calls, pages, result_count: added, complete, outcome: complete ? 'ok' : 'partial', reason });
  return { output, mode: options.preview ? 'preview' : 'full', ...(options.preview ? { previewed_topics: pages } : {}), complete, selected_topics_complete: selectedIds !== undefined && selectedIds.every(id => completedSelected.has(id)),
    discovery_complete: snapshot.discovery.kind === 'explicit' || snapshot.discovery.has_more === false,
    reason, calls, pages, added_posts: added, saved_topics: Object.keys(snapshot.topics).length, retry_after_ms: Math.max(0, snapshot.cooldown_until - Date.now()) };
}

/** Bounded directory for choosing local chunks without returning post bodies. */
export async function readCollectionIndex(input: string, offset = 0, limit = 50, maxBytes = 65536) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > 4194304) throw new Error('Invalid collection directory limits');
  const snapshot = snapshotSchema.parse(JSON.parse(await readFile(input, 'utf8')));
  const stored = Object.values(snapshot.topics).sort((a,b) => a.id - b.id);
  const topics: Array<{id:number;title:string;url:string;saved_posts:number;next_post_number:number;complete:boolean;updated_at?:string}> = [];
  const result = () => ({ site: snapshot.site, username_filter: snapshot.username_filter || null, captured_at: snapshot.updated_at, status: snapshot.status,
    stored_topics: stored.length, discovered_topics: snapshot.discovery.ids.length,
    discovery: { kind: snapshot.discovery.kind, coverage: snapshot.discovery.coverage, has_more: snapshot.discovery.has_more ?? null },
    topics, pagination: { next_offset: offset + topics.length, has_more_stored: offset + topics.length < stored.length } });
  for (const topic of stored.slice(offset, offset + limit)) {
    topics.push({ id: topic.id, title: topic.title, url: topic.url, saved_posts: topic.posts.length, next_post_number: topic.next_post_number, complete: topic.complete, updated_at: topic.updated_at });
    if (Buffer.byteLength(JSON.stringify(result())) > maxBytes - 128) { topics.pop(); break; }
  }
  if (offset < stored.length && !topics.length) throw new Error('First stored topic exceeds directory byte budget; increase --max-bytes');
  const directory = result();
  if (Buffer.byteLength(JSON.stringify(directory)) > maxBytes) throw new Error('Collection metadata exceeds directory byte budget');
  return directory;
}

/** Read a bounded chunk of an existing snapshot; no server or forum access. */
export async function readCollectionChunk(input: string, topicId: number, start = 1, limit = 50, maxBytes = 65536) {
  if (![topicId, start, limit, maxBytes].every(n => Number.isSafeInteger(n) && n > 0) || limit > 500 || maxBytes < 4096 || maxBytes > 4194304) throw new Error('Invalid collection chunk limits');
  const snapshot = migrate(snapshotSchema.parse(JSON.parse(await readFile(input, 'utf8'))));
  const topic = snapshot.topics[String(topicId)];
  if (!topic) throw new Error('Topic is not stored in this collection');
  const available = topic.posts.filter(post => post.number >= start);
  const posts: typeof topic.posts = [];
  let next = start;
  const result = () => ({ site: snapshot.site, topic: { id: topic.id, title: topic.title, url: topic.url },
    captured_at: topic.updated_at ?? snapshot.updated_at, posts,
    pagination: { next_post_number: next, has_more_stored: available.length > posts.length, complete_at_capture: topic.complete },
    coverage: { returned_content_complete: posts.every(p => !p.content_truncated), attachments_reviewed: false } });
  for (const post of available.slice(0, limit)) {
    posts.push(post);
    if (Buffer.byteLength(JSON.stringify(result())) > maxBytes - 128) { posts.pop(); break; }
    next = post.number + 1;
  }
  const chunk = result();
  if (available.length && !posts.length) throw new Error('First stored post exceeds chunk byte budget; increase --max-bytes');
  if (Buffer.byteLength(JSON.stringify(chunk)) > maxBytes) throw new Error('Collection metadata exceeds chunk byte budget');
  return chunk;
}
