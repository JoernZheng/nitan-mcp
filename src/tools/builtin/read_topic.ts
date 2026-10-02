import { toolErrorMetadata } from "../result.js";
import { createToolRequest } from "../request.js";
import { throwIfAborted } from "../../http/request_budget.js";
import { z } from "zod";
import type { RegisterFn } from "../types.js";
import { formatTimestamp } from "../../util/timestamp.js";
import { postEvidence, type Attachment, type Quote } from '../post_evidence.js';

type Post = { number: number; username: string; created_at: string; updated_at?: string; created_at_source: "json" | "unknown"; content: string; content_truncated: boolean; url?: string; attachments?: Attachment[]; quoted_posts?: Quote[]; reply_to_post_number?: number };
const validNumber = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value.map(tag => typeof tag === "string" ? tag : tag?.name ?? tag?.text)
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .map(name => name.trim());
  return [...new Set(names)];
}

function parseRaw(text: string, limit: number): Post[] {
  const lines = text.split("\n");
  const posts: Post[] = [];
  for (let i = 0; i < lines.length;) {
    const header = lines[i++].match(/^(.+?)\s*\|\s*(.+?)\s*\|\s*#(\d+)\s*$/);
    if (!header) continue;
    const number = Number(header[3]);
    const body: string[] = [];
    while (i < lines.length && !/^-{20,}$/.test(lines[i])) body.push(lines[i++]);
    if (i < lines.length) i++;
    const content = body.join("\n").trim();
    // Discourse's raw topic header is updated_at, not created_at.
    if (validNumber(number)) posts.push({ number, username: header[1].trim(), created_at: "", updated_at: header[2].trim(), created_at_source: "unknown", content: content.slice(0, limit), content_truncated: content.length > limit });
  }
  return posts.sort((a, b) => a.number - b.number);
}

export const registerReadTopic: RegisterFn = (server, ctx) => {
  const schema = z.object({
    topic_id: z.number().int().positive(),
    post_limit: z.number().int().min(1).max(500).optional().describe("Number of posts to fetch (default 90, max 500)"),
    start_post_number: z.number().int().min(1).optional().describe("Start from this post number (default 1, 1-based)"),
    username_filter: z.string().optional().describe("Filter posts by username (only show posts from this user)"),
    output_format: z.enum(['full', 'compact']).optional().describe('Full text plus structured posts (default), or compact text with structured posts only'),
    max_response_bytes: z.number().int().min(4096).max(4194304).optional().describe('Total response byte budget (default 262144); an unreturned post never advances the cursor'),
  });
  server.registerTool("discourse_read_topic", {
    title: "Read Topic",
    description: "Read a topic metadata and posts. Can optionally filter to show only posts from a specific user.",
    inputSchema: schema.shape,
  }, async ({ topic_id, post_limit = 90, start_post_number = 1, username_filter, output_format = 'full', max_response_bytes = 262144 }, _extra: any) => {
    const started = Date.now();
    const capturedAt = () => new Date().toISOString();
    const posts: Post[] = [];
    let requests = 0;
    let next = start_post_number;
    let base = "", title = `Topic ${topic_id}`, slug = String(topic_id), category = '';
    let outputStopped = false;
    let tags: string[] = [];
    let highest: number | undefined;
    const renderedPosts = new Map<Post, string[]>();
    const machineResult = (complete: boolean, hasMore: boolean | null, reason: string) => ({
      site: base, topic: { id: topic_id, title, url: `${base}/t/${slug}/${topic_id}`, tags }, posts,
      captured_at: capturedAt(),
      coverage: { post_range_complete: complete, returned_content_complete: posts.every(p => !p.content_truncated),
        returned_creation_times_complete: posts.every(p => p.created_at_source === 'json'),
        attachments_present: posts.some(p => p.attachments?.length), attachments_reviewed: false },
      pagination: { start_post_number, next_post_number: next, highest_post_number: highest ?? null,
        request_count: requests, has_more: hasMore, complete, stop_reason: reason },
    });
    const textForPosts = () => {
      if (output_format === 'compact') return `${title}: ${posts.length} posts in structuredContent. Next post ${next}. Attachments are not reviewed.\n${base}/t/${slug}/${topic_id}`;
      return [`# ${title}`, ...(category ? [category] : []), ...(tags.length ? [`Tags: ${tags.join(', ')}`] : []),
        ...(username_filter ? [`Filtered by user: @${username_filter}`] : []), '',
        ...posts.flatMap(p => {
          if (!renderedPosts.has(p)) renderedPosts.set(p, [`- Post #${p.number} by @${p.username} (${p.created_at ? formatTimestamp(p.created_at) : `creation time unknown; updated ${formatTimestamp(p.updated_at || '')}`})`, `  ${p.content}`]);
          return renderedPosts.get(p)!;
        }),
        '', `Link: ${base}/t/${slug}/${topic_id}`].join('\n');
    };
    const append = (post: Post) => {
      const enriched = { ...post, ...postEvidence(post.content, base, topic_id, post.number) };
      posts.push(enriched);
      const size = Buffer.byteLength(JSON.stringify({ content: [{ type: 'text' as const, text: textForPosts() }], structuredContent: machineResult(false, true, 'output_budget') }));
      if (size > max_response_bytes - 1024) { posts.pop(); outputStopped = true; return false; }
      return true;
    };
    try {
      throwIfAborted(_extra?.signal);
      const selected = ctx.siteState.ensureSelectedSite();
      base = selected.base;
      const client = selected.client;
      const request = createToolRequest(client, _extra?.signal);
      const limit = Number.isFinite(ctx.maxReadLength) ? ctx.maxReadLength : 50000;
      const seen = new Set<number>();
      const maxRequests = 32;
      let observedMax = 0;
      let stopped = false;
      let positioningFailed = false;
      const get = async (url: string) => { requests++; return request(url); };
      const author = username_filter?.trim();
      const filteredUrl = (n: number) => `/t/${topic_id}/${n}.json?include_raw=true&username_filters=${encodeURIComponent(author!)}`;
      const metadata: any = await get(author ? filteredUrl(next) : `/t/${topic_id}.json`);
      title = metadata?.title || `Topic ${topic_id}`;
      category = metadata?.category_id ? `Category ID ${metadata.category_id}` : "";
      tags = normalizeTags(metadata?.tags);
      slug = metadata?.slug || String(topic_id);
      highest = validNumber(metadata?.highest_post_number) ? metadata.highest_post_number as number : undefined;
      const knownPosts = new Map<number, any>((metadata?.post_stream?.posts ?? [])
        .filter((p: any) => validNumber(p?.post_number)).map((p: any) => [p.post_number, p]));

      if (highest !== undefined && start_post_number > highest) {
        stopped = true;
      } else if (author) {
        let data: any = metadata;
        while (posts.length < post_limit && !outputStopped) {
          const stream: any[] = Array.isArray(data?.post_stream?.posts) ? data.post_stream.posts : [];
          const advancing = stream.filter(p => validNumber(p?.post_number) && p.post_number >= next).sort((a, b) => a.post_number - b.post_number);
          observedMax = Math.max(observedMax, advancing[advancing.length - 1]?.post_number ?? 0);
          if (!advancing.length) { stopped = true; break; }
          for (const p of advancing) {
            if (posts.length >= post_limit) break;
            if (typeof p.username !== "string" || p.username.toLowerCase() !== author.toLowerCase() || seen.has(p.post_number)) { next = p.post_number + 1; continue; }
            const content = String(p.raw || p.cooked || p.excerpt || "");
            if (!append({ number: p.post_number, username: p.username, created_at: String(p.created_at || ""),
              updated_at: String(p.updated_at || ""), created_at_source: p.created_at ? "json" : "unknown",
              ...(validNumber(p.reply_to_post_number) ? { reply_to_post_number: p.reply_to_post_number } : {}),
              content: content.slice(0, limit), content_truncated: content.length > limit })) break;
            next = p.post_number + 1; seen.add(p.post_number);
          }
          if (highest !== undefined && next > highest && next > observedMax) { stopped = true; break; }
          if (outputStopped || posts.length >= post_limit || requests >= maxRequests) break;
          data = await get(filteredUrl(next));
        }
      } else {
        const cache = new Map<number, Post[]>();
        const count = validNumber(metadata?.posts_count) ? metadata.posts_count as number : undefined;
        const estimatedPosition = count !== undefined && highest !== undefined
          ? Math.max(1, Math.floor(start_post_number * Math.min(1, count / highest))) : 1;
        let page = Math.floor((estimatedPosition - 1) / 100) + 1;
        const load = async (n: number): Promise<Post[]> => {
          if (cache.has(n)) return cache.get(n)!;
          const text = await get(`/raw/${topic_id}?page=${n}`);
          const parsed = parseRaw(typeof text === "string" ? text : "", limit);
          for (const p of parsed) {
            const known = knownPosts.get(p.number);
            if (typeof known?.created_at === "string" && known.created_at) {
              p.created_at = known.created_at;
              p.created_at_source = "json";
            }
            if (validNumber(known?.reply_to_post_number)) p.reply_to_post_number = known.reply_to_post_number;
          }
          observedMax = Math.max(observedMax, parsed[parsed.length - 1]?.number ?? 0);
          cache.set(n, parsed);
          return parsed;
        };
        let low = 1;
        let high: number | undefined;
        let located = false;
        // Establish a safe lower boundary before returning posts. Estimates are
        // hints only: deletions can cluster and make their error arbitrarily large.
        while (cache.has(page) || requests < maxRequests) {
          const batch = await load(page);
          const min = batch[0]?.number;
          const max = batch[batch.length - 1]?.number;
          if (min !== undefined && min <= start_post_number && max >= start_post_number) { located = true; break; }
          if (!batch.length || min > start_post_number) {
            high = page;
            const previous = cache.get(page - 1);
            if (page === 1 || (previous?.length && previous[previous.length - 1].number < start_post_number)) { located = true; break; }
          } else {
            const previous = cache.get(page - 1);
            if (previous?.length && previous[previous.length - 1].number === max) { stopped = true; break; }
            low = page + 1;
          }
          if (high !== undefined && low >= high) { page = high; located = true; break; }
          page = high !== undefined ? Math.floor((low + high) / 2) : Math.max(low, page * 2);
        }

        positioningFailed = !located && !stopped;
        let lastScanned = 0;
        while (located && posts.length < post_limit && !outputStopped && (cache.has(page) || requests < maxRequests)) {
          const batch = await load(page);
          const max = batch[batch.length - 1]?.number || 0;
          if (!batch.length || max <= lastScanned) { stopped = true; break; }
          lastScanned = max;
          for (const p of batch) {
            if (posts.length >= post_limit) break;
            if (p.number < start_post_number) continue;
            if (seen.has(p.number)) continue;
            if (!append(p)) break;
            next = Math.max(next, p.number + 1); seen.add(p.number);
          }
          if (highest !== undefined && next > highest && next > observedMax) { stopped = true; break; }
          page++;
        }

      }

      const lines = [textForPosts()];
      if (outputStopped) lines.push(`Reading stopped at the response byte budget. Continue with start_post_number=${next}; increase max_response_bytes if no post fits.`);
      else if (positioningFailed) lines.push("Reading stopped before locating the requested start within the request budget. No posts returned; the requested range is incomplete.");
      else if (!stopped && posts.length < post_limit) lines.push(`Reading stopped at the request budget. Continue with start_post_number=${next}.`);
      const complete = highest !== undefined && next > highest && next > observedMax;
      const reason = complete ? "highest" : outputStopped ? "output_budget" : positioningFailed ? "positioning_budget" : posts.length >= post_limit ? "limit" : stopped ? "no_progress" : "request_budget";
      // An observed later post proves more work exists; no-progress without an
      // exhausted reliable highest remains unknown, never a completion claim.
      const hasMore = complete ? false : positioningFailed ? null : observedMax >= next ? true : reason === "no_progress" ? null : highest !== undefined ? true : null;
      ctx.logger?.event("topic.read.completed", {
        duration_ms: Date.now() - started, request_count: requests, result_count: posts.length,
        complete, outcome: complete || reason === "limit" ? "ok" : "partial", reason,
      });
      const result = {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: machineResult(complete, hasMore, reason),
      };
      if (Buffer.byteLength(JSON.stringify(result)) > max_response_bytes) return {
        isError: true, content: [{ type: 'text' as const, text: 'Topic metadata exceeds response byte budget. No cursor committed; increase max_response_bytes.' }], structuredContent: { error: { kind: 'output_budget' } },
      };
      return result;
    } catch (e: any) {
      const error = toolErrorMetadata(e);
      ctx.logger?.event("topic.read.failed", { duration_ms: Date.now() - started, status: e?.status,
        request_count: requests, result_count: posts.length, complete: false, outcome: "error" }, "error");
      const result = { content: [{ type: "text" as const, text: next > start_post_number && base
        ? `Partial read failed (${error.error.kind}); ${posts.length} posts returned. Continue with start_post_number=${next}.`
        : `Failed to read topic ${topic_id}: ${String(e?.message || e).slice(0,512)}` }],
        isError: true, structuredContent: next > start_post_number && base ? { ...machineResult(false, highest !== undefined ? true : null, error.error.kind), ...error } : error };
      return Buffer.byteLength(JSON.stringify(result)) <= max_response_bytes ? result : {
        isError: true, content: [{ type: 'text' as const, text: 'Read failed; partial metadata exceeds byte budget. No cursor returned.' }], structuredContent: error,
      };
    }
  });
};
