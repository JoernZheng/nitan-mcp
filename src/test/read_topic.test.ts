import test from "node:test";
import assert from "node:assert/strict";
import { registerReadTopic } from "../tools/builtin/read_topic.js";

function raw(posts: Array<[number, string, string?]>) {
  return posts.map(([n, user, body = `body${n}`]) => `${user} | 2026-01-01T00:00:00Z | #${n}\n\n${body}\n\n-------------------------\n`).join("\n");
}

async function read(args: Record<string, unknown>, responder: (url: string) => unknown, maxReadLength = 50000) {
  const urls: string[] = [];
  let handler: any;
  let meta: any;
  const server: any = { registerTool(_name: string, config: any, callback: any) { handler = callback; meta = config; } };
  const state: any = { ensureSelectedSite() { return { base: "https://example.com", client: { async get(url: string) { urls.push(url); if (urls.length > 40) throw new Error("unbounded requests"); return responder(url); } } }; } };
  registerReadTopic(server, { siteState: state, maxReadLength } as any, {});
  const result = await handler({ topic_id: 1, ...args }, {});
  return { text: result.content[0].text as string, result, urls, meta };
}

test("topic tags normalize mixed string/object values without object coercion", async () => {
  const r = await read({}, url => url.startsWith("/t/") ? { tags: ["ai", { name: "coding" }, { text: "news" }, null, {}, 42], highest_post_number: 1 } : raw([[1, "alice"]]));
  assert.match(r.text, /Tags: ai, coding, news/);
  assert.doesNotMatch(r.text, /\[object Object\]|null|42/);
});

test("author filter excludes server-included first post and advances all-filtered windows", async () => {
  const r = await read({ username_filter: "TARGET", post_limit: 2 }, url => {
    if (url.includes("/1.json?")) return { title: "Author", tags: [{ name: "ai" }], highest_post_number: 9, post_stream: { posts: [{ post_number: 1, username: "other", raw: "leak" }, { post_number: 2, username: "other", raw: "not target" }] } };
    if (url.includes("/3.json?")) return { post_stream: { posts: [{ post_number: 1, username: "other", raw: "leak" }, { post_number: 8, username: "target", raw: "yes" }, { post_number: 9, username: "Target", raw: "yes too" }] } };
    throw new Error(`unexpected ${url}`);
  });
  assert.equal(r.result.isError, undefined);
  assert.doesNotMatch(r.text, /by @other|leak/);
  assert.match(r.text, /Post #8 by @target/);
  assert.match(r.text, /Post #9 by @Target/);
  assert.equal(r.urls.length, 2);
});

test("start beyond trustworthy highest returns metadata with zero raw requests", async () => {
  const r = await read({ start_post_number: 5 }, url => {
    assert.equal(url, "/t/1.json");
    return { title: "Finished", highest_post_number: 4, posts_count: 2 };
  });
  assert.equal(r.result.isError, undefined);
  assert.match(r.text, /Finished/);
  assert.doesNotMatch(r.text, /Post #/);
  assert.deepEqual(r.urls, ["/t/1.json"]);
});

test("missing highest does not use count to incorrectly stop after deleted posts", async () => {
  const r = await read({ start_post_number: 80, post_limit: 1 }, url => url.startsWith("/t/") ? { posts_count: 2 } : raw([[1, "alice"], [80, "bob"]]));
  assert.match(r.text, /Post #80 by @bob/);
});

test("overlapping and repeated raw tail pages do not duplicate posts or loop", async () => {
  const r = await read({ post_limit: 5 }, url => url.startsWith("/t/") ? { posts_count: 2 } : url.endsWith("page=1") ? raw([[1, "alice"]]) : raw([[1, "alice"], [5, "bob"]]));
  assert.equal(r.result.isError, undefined);
  assert.equal((r.text.match(/Post #1 /g) || []).length, 1);
  assert.equal((r.text.match(/Post #5 /g) || []).length, 1);
  assert.ok(r.urls.length <= 4);
});

test("walk-limit cache remains bound to its original page and does not skip next page", async () => {
  const r = await read({ start_post_number: 1000, post_limit: 1 }, url => {
    if (url.startsWith("/t/")) return { posts_count: 1, highest_post_number: 2000 };
    const page = Number(new URL(url, "https://example.com").searchParams.get("page"));
    return raw([[page >= 11 ? 1000 + page - 11 : page, "alice"]]);
  });
  assert.equal(r.result.isError, undefined);
  assert.ok(r.urls.includes("/raw/1?page=11"));
  assert.match(r.text, /Post #1000 /);
});

test("target within deleted-number gap starts at next page without oscillating", async () => {
  const r = await read({ start_post_number: 40, post_limit: 1 }, url => url.startsWith("/t/") ? { posts_count: 2, highest_post_number: 100 } : url.endsWith("page=1") ? raw([[1, "a"]]) : raw([[100, "b"]]));
  assert.match(r.text, /Post #100 /);
  assert.ok(r.urls.length <= 3);
});

test("exact limit and content cap remain enforced", async () => {
  const r = await read({ post_limit: 1 }, url => url.startsWith("/t/") ? { highest_post_number: 5 } : raw([[1, "a"], [5, "b"]]));
  assert.match(r.text, /Post #1 /);
  assert.doesNotMatch(r.text, /Post #5 /);
  assert.equal(r.meta.inputSchema.post_limit.safeParse(500).success, true);
  assert.equal(r.meta.inputSchema.post_limit.safeParse(501).success, false);
});

test("unending author windows are bounded and report partial reading", async () => {
  const r = await read({ username_filter: "target" }, url => {
    const n = Number(url.match(/\/t\/1\/(\d+)/)?.[1]);
    return { post_stream: { posts: [{ post_number: n, username: "other", raw: "skip" }] } };
  });
  assert.equal(r.result.isError, undefined);
  assert.ok(r.urls.length <= 32);
  assert.match(r.text, /request budget/i);
});

test("HTTP errors remain MCP errors", async () => {
  const r = await read({}, () => { throw new Error("mock error"); });
  assert.equal(r.result.isError, true);
  assert.match(r.text, /mock error/);
});


test("clustered deletions cannot let an exhausted estimate skip the requested start", async () => {
  const visible = [1, ...Array.from({ length: 4999 }, (_, i) => i + 5000), 10000];
  const r = await read({ start_post_number: 5000, post_limit: 1 }, url => {
    if (url.startsWith("/t/")) return { posts_count: visible.length, highest_post_number: 10000 };
    const page = Number(new URL(url, "https://example.com").searchParams.get("page"));
    return raw(visible.slice((page - 1) * 100, page * 100).map(n => [n, "alice"]));
  });
  assert.match(r.text, /Post #5000 /);
  assert.ok(r.urls.length <= 32);
});

test("dense topics continue after page101 without an unusable cursor", async () => {
  const r = await read({ start_post_number: 10001, post_limit: 500 }, url => {
    if (url.startsWith("/t/")) return { posts_count: 15000, highest_post_number: 15000 };
    const page = Number(new URL(url, "https://example.com").searchParams.get("page"));
    return raw(Array.from({ length: 100 }, (_, i) => [(page - 1) * 100 + i + 1, "alice"]));
  });
  assert.equal((r.text.match(/Post #/g) || []).length, 500);
  assert.match(r.text, /Post #10500 /);
  assert.ok(r.urls.includes("/raw/1?page=102"));
});

test("invalid highest values never cause premature end", async () => {
  for (const highest of [0, -1, "1", Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const r = await read({ start_post_number: 20, post_limit: 1 }, url => url.startsWith("/t/") ? { highest_post_number: highest, posts_count: 1 } : raw([[20, "alice"]]));
    assert.match(r.text, /Post #20 /);
  }
});


test("per-post content cap preserves only the allowed prefix", async () => {
  const r = await read({ post_limit: 1 }, url => url.startsWith("/t/") ? { highest_post_number: 1 } : raw([[1, "a", "abcdef"]]), 3);
  assert.match(r.text, /  abc\n/);
  assert.doesNotMatch(r.text, /abcdef/);
});

test("default post limit remains90", async () => {
  const r = await read({}, url => url.startsWith("/t/") ? { highest_post_number: 100 } : raw(Array.from({ length: 100 }, (_, i) => [i + 1, "a"])));
  assert.equal((r.text.match(/Post #/g) || []).length, 90);
});

test("overshot estimate can locate a gap from the upper side", async () => {
  const r = await read({ start_post_number: 250, post_limit: 2 }, url => {
    if (url.startsWith("/t/")) return { highest_post_number: 260, posts_count: 260 };
    const page = Number(new URL(url, "https://example.com").searchParams.get("page"));
    return page === 3 ? raw([[251, "a"], [260, "b"]]) : page === 2 ? raw([[249, "a"]]) : raw([[1, "a"]]);
  });
  assert.match(r.text, /Post #251 /);
  assert.match(r.text, /Post #260 /);
  assert.ok(r.urls.length <= 4);
});
