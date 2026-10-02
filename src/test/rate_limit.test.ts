import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HttpClient, RateLimitError } from "../http/client.js";
import { redactObject } from "../util/redact.js";
import { Logger } from "../util/logger.js";
import { isRateLimited, retryAfterMs, withSiteRequest, recordRateLimit } from "../http/rate_limit.js";
import { BrowserFallbackClient } from "../http/browser_fallback.js";

function site() { return `https://${randomUUID()}.invalid`; }
function native(base = site(), logger = new Logger("silent")) {
  const c = new HttpClient({ baseUrl: base, timeoutMs: 1000, logger, auth: { type: "user_api_key", key: "PRIVATE_KEY", client_id: "PRIVATE_CLIENT" } });
  (c as any).cloudscraperClient = undefined;
  (c as any).curlCffiClient = undefined;
  return c;
}
test('configured logical interval is honored and cancellation during pacing starts no backend', async () => {
  const c = native(); (c as any).opts.requestIntervalMs = 80;
  const previous = globalThis.fetch; const starts: number[] = [];
  globalThis.fetch = (async () => { starts.push(Date.now()); return new Response('{}'); }) as any;
  try {
    await c.get('/one'); await c.get('/two'); assert.ok(starts[1] - starts[0] >= 70);
    const abort = new AbortController(); const pending = c.get('/three', { signal: abort.signal }); abort.abort();
    await assert.rejects(pending); assert.equal(starts.length, 2);
  } finally { globalThis.fetch = previous; await c.dispose(); }
});

test("rate-limit timing handles seconds, dates, Discourse hints and invalid values", () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(retryAfterMs({ "Retry-After": "30" }, {}, now), 30000);
  assert.equal(retryAfterMs({ "retry-after": new Date(now + 45000).toUTCString() }, {}, now), 45000);
  assert.equal(retryAfterMs({}, { extras: { wait_seconds: 20 } }, now), 20000);
  assert.equal(retryAfterMs({ "retry-after": "10" }, '{"extras":{"time_left":30}}', now), 30000);
  assert.equal(retryAfterMs({}, {}, now), 60000);
  for (const value of ["-1", "Infinity", "nonsense", "99999999999999999999999"]) assert.equal(retryAfterMs({ "retry-after": value }, {}, now), 60000);
  assert.equal(retryAfterMs({ "retry-after": new Date(now - 10000).toUTCString() }, {}, now), 1000);
  assert.equal(retryAfterMs({ "retry-after": "0" }, {}, now), 1000);
  assert.equal(isRateLimited(403, "Error code: 1015"), true);
  assert.equal(isRateLimited(403, "Just a moment..."), false);
  assert.equal(isRateLimited(200, "A forum post about Error1015 and rate limits"), false);
  assert.equal(isRateLimited(200, '{"post":"Error 1015"}'), false);
  assert.equal(isRateLimited(200, '{"raw":"<h1>Error 1015</h1>"}'), false);
  assert.equal(isRateLimited(200, "alice | now | #1\n\n<h1>Error1015</h1>"), false);
  assert.equal(isRateLimited(200, "<html><title>Error1015</title></html>"), true);
});

test("native429 stops retries and queued clients share cooldown", async () => {
  const base = site();
  const a = native(base), b = native(base);
  const original = globalThis.fetch;
  let calls = 0;
  let finish!: (r: Response) => void;
  globalThis.fetch = (async () => { calls++; return new Promise<Response>(resolve => { finish = resolve; }); }) as any;
  try {
    const first = a.get("/t/1.json").catch(e => e);
    while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
    const second = b.get("/hot.json").catch(e => e);
    assert.equal(calls, 1);
    finish(new Response('{"extras":{"wait_seconds":30}}', { status: 429, headers: { "Retry-After": "30" } }));
    const errors = await Promise.all([first, second]);
    assert.ok(errors.every(e => e instanceof RateLimitError && e.retryAfterMs >= 29000));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test("Python rate limits stop all successor backends even with success:false", async () => {
  for (const backend of ["cloudscraperClient", "curlCffiClient"]) {
    const client = native();
    let primary = 0, successor = 0;
    (client as any)[backend] = { request: async () => { primary++; return { success: false, status: 403, headers: { "Retry-After": "30" }, body: "Error 1015" }; } };
    if (backend === "cloudscraperClient") (client as any).curlCffiClient = { request: async () => { successor++; throw new Error("unexpected"); } };
    (client as any).browserFallbackClient = { isEnabled: () => true, request: async () => { successor++; throw new Error("unexpected"); } };
    await assert.rejects(client.get("/hot.json"), e => e instanceof RateLimitError && e.status === 403);
    assert.equal(primary, 1);
    assert.equal(successor, 0);
  }
});

test('unhinted429 shares a minute cooldown and queued requests start no backend', async () => {
  const base=site(),a=native(base),b=native(base),previous=globalThis.fetch;
  let calls=0,finish!: (r:Response)=>void;
  globalThis.fetch=(async()=>{calls++;return new Promise<Response>(resolve=>{finish=resolve;});}) as any;
  try {
    const first=a.get('/search.json').catch(e=>e);
    while(!finish)await new Promise(resolve=>setTimeout(resolve,1));
    const second=b.get('/hot.json').catch(e=>e);
    finish(new Response('{}',{status:429}));
    const errors=await Promise.all([first,second]);
    assert.ok(errors.every(e=>e instanceof RateLimitError&&e.retryAfterMs>=59000));
    assert.equal(calls,1);
  }finally{globalThis.fetch=previous;await a.dispose();await b.dispose();}
});

test("browser429 never enters login rescue", async () => {
  const client = native();
  let login = 0, browserCalls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("Just a moment...", { status: 403 })) as any;
  (client as any).browserFallbackClient = {
    isEnabled: () => true,
    request: async () => { browserCalls++; return { status: 429, body: 'name="login" Error 1015', headers: { "retry-after": "30" } }; },
    maybeAutoLogin: async () => { login++; return true; },
  };
  try {
    await assert.rejects(client.get("/t/1.json"), RateLimitError);
    assert.equal(browserCalls, 1);
    assert.equal(login, 0);
  } finally { globalThis.fetch = original; }
});

test("queued cancellation never starts a backend and cannot wedge the queue", async () => {
  const origin = site();
  let release!: () => void;
  const first = withSiteRequest(origin, () => new Promise<void>(resolve => { release = resolve; }), undefined, 0);
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  const controller = new AbortController();
  let calls = 0;
  const second = withSiteRequest(origin, async () => { calls++; }, controller.signal, 0);
  controller.abort();
  await assert.rejects(second);
  release(); await first;
  await withSiteRequest(origin, async () => { calls++; }, undefined, 0);
  assert.equal(calls, 1);
});

test("cooldown on one origin does not block another", async () => {
  const blocked = site();
  assert.throws(() => recordRateLimit(blocked, 429, {}, ""), RateLimitError);
  let calls = 0;
  await withSiteRequest(site(), async () => { calls++; }, undefined, 0);
  assert.equal(calls, 1);
});

test("managed browser response cannot clear cookies after rate limit", async () => {
  const browser = new BrowserFallbackClient(new Logger("silent"), { enabled: true });
  const retry = (browser as any).shouldRetryWithClearedManagedCookies({ source: "nitan" }, { method: "GET" }, { status: 429, body: "Just a moment... Error 1015" });
  assert.equal(retry, false);
});

test("structured operational events retain useful data without secret values", async () => {
  const originalFetch = globalThis.fetch, originalWrite = process.stderr.write;
  let logs = "";
  (process.stderr as any).write = (chunk: any) => { logs += String(chunk); return true; };
  globalThis.fetch = (async () => new Response('{"private":"PRIVATE_BODY"}', { headers: { "content-type": "application/json", "set-cookie": "session=PRIVATE_COOKIE" } })) as any;
  try {
    const logger = new Logger("debug");
    const client = native(site(), logger);
    await client.get("/search.json?q=PRIVATE_QUERY");
    logger.event("http.request.completed", { reason: "PRIVATE_REASON", backend: "PRIVATE_BACKEND", request_id: "PRIVATE_ID", authorization: "PRIVATE_AUTH", duration_ms: 123, outcome: "ok" });
    assert.doesNotMatch(logs, /PRIVATE_|search.json|q=/);
    const events = logs.trim().split("\n").map(line => JSON.parse(line));
    assert.ok(events.some(e => e.event === "http.backend.completed" && e.status === 200));
    assert.ok(events.some(e => e.event === "http.request.completed" && e.duration_ms >= 0 && e.outcome === "ok"));
    assert.equal(events.at(-1)?.duration_ms, 123);
  } finally { globalThis.fetch = originalFetch; process.stderr.write = originalWrite; }
});
test('unknown Python/browser costs are not logged as exact explicit request counts',async()=>{
 const oldWrite=process.stderr.write,oldFetch=globalThis.fetch;let logs='';
 (process.stderr as any).write=(chunk:any)=>{logs+=String(chunk);return true;};
 globalThis.fetch=(async()=>new Response('{}')) as any;
 try{
  const python=native(site(),new Logger('info'));
  (python as any).cloudscraperClient={request:async()=>{throw new Error('Python runtime could not be started');}};
  await python.get('/one');await python.dispose();
  const browser=native(site(),new Logger('info'));
  (browser as any).cloudscraperClient={request:async()=>({success:true,status:403,headers:{'cf-mitigated':'challenge'},body:'<html><title>Just a moment...</title></html>',explicit_request_count:1,warmup_request_count:0})};
  (browser as any).browserFallbackClient={isEnabled:()=>true,request:async()=>({status:200,body:'{}'}),dispose:async()=>{}};
  await browser.get('/two');await browser.dispose();
  const completed=logs.trim().split('\n').map(line=>JSON.parse(line)).filter(event=>event.event==='http.request.completed');
  assert.equal(completed.length,2);for(const event of completed){assert.equal(event.explicit_request_count_known,false);assert.equal(event.explicit_request_count,undefined);}
 }finally{process.stderr.write=oldWrite;globalThis.fetch=oldFetch;}
});


test("503 Error1015 bypasses5xx retry and retains real status", async () => {
  const client = native();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("Error 1015", { status: 503 }); }) as any;
  try {
    await assert.rejects(client.get("/hot.json"), e => e instanceof RateLimitError && e.status === 503);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});


test("ordinary403 on Cloudflare does not trigger browser rescue", async () => {
  const client = native();
  const original = globalThis.fetch;
  let browser = 0;
  globalThis.fetch = (async () => new Response('{"error":"permission denied"}', { status: 403, headers: { "cf-ray": "demo", "server": "cloudflare" } })) as any;
  (client as any).browserFallbackClient = { isEnabled: () => true, request: async () => { browser++; throw new Error("unexpected"); } };
  try { await assert.rejects(client.get("/t/1.json")); assert.equal(browser, 0); }
  finally { globalThis.fetch = original; }
});

test("browser auto-login429 response propagates before target retry", async () => {
  const base = site();
  const browser = new BrowserFallbackClient(new Logger("silent"), { enabled: true });
  const page: any = {
    goto: async () => ({ status: () => 200, headers: () => ({}), text: async () => "login" }),
    waitForSelector: async () => {}, fill: async () => {}, $: async () => ({}),
    url: () => base+"/login",
    waitForLoadState: async () => {}, click: async () => {},
    waitForResponse: async () => ({ status: () => 429, headers: () => ({ "retry-after": "30" }), text: async () => "Error 1015" }),
  };
  await assert.rejects((browser as any).runWithBudget({}, (budget: any) => (browser as any).submitLoginForm(page, base+"/login", "PRIVATE_USER", "PRIVATE_PASS", budget, base)), RateLimitError);
});


test("configuration diagnostics cannot reveal credentials, query values or circular data", () => {
  const data = { auth_pairs: [{ site: "https://PRIVATE_USER:PRIVATE_PASS@example.com/forum?q=PRIVATE_QUERY", User_Api_Key: "PRIVATE_KEY", username: "PRIVATE_USER", password: "PRIVATE_PASS" }], default_search: "PRIVATE_SEARCH", Cookie: "PRIVATE_COOKIE", payload: "PRIVATE_PAYLOAD" };
  const rendered = JSON.stringify(redactObject(data));
  assert.doesNotMatch(rendered, /PRIVATE_/);
  assert.match(rendered, /example.com\/forum/);
  const circular: any = { password: "PRIVATE_PASS" }; circular.self = circular;
  assert.equal(redactObject(circular), "<unserializable>");
});


test("browser429 remains rate-limited when navigation body cannot be read", async () => {
  const browser = new BrowserFallbackClient(new Logger("silent"), { enabled: true });
  const base = site();
  const page: any = { goto: async () => ({ status: () => 429, headers: () => ({ "Retry-After": "30" }), text: async () => { throw new Error("body unavailable"); } }) };
  await assert.rejects((browser as any).runWithBudget({}, (budget: any) => (browser as any).submitLoginForm(page, base+"/login", "u", "p", budget, base)), e => e instanceof RateLimitError && e.retryAfterMs === 30000);
});
