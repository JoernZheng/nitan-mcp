import { RateLimitError } from "./errors.js";

export function isRateLimited(status: number | undefined, body: unknown): boolean {
  if (status === 429) return true;
  if (typeof body !== "string") return false;
  const error1015 = /\berror\s*(?:code\s*[:=]?\s*)?1015\b/i;
  // A normal topic can discuss Error1015. Only an error status or an actual
  // challenge document is evidence of a rate-limit response.
  return (status !== undefined && status >= 400 && error1015.test(body)) ||
    (/^\s*(?:<!doctype\s+html\b[^>]*>\s*)?<html\b/i.test(body) && /<(?:title|h1)[^>]*>\s*error\s*(?:code\s*[:=]?\s*)?1015\b/i.test(body));
}

export function retryAfterMs(headers: Record<string, string> | undefined, body: unknown, now = Date.now()): number {
  const value = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === "retry-after")?.[1]?.trim();
  let headerDelay: number | undefined;
  if (value && /^\d+$/.test(value)) {
    const seconds = Number(value);
    if (Number.isSafeInteger(seconds) && seconds <= Number.MAX_SAFE_INTEGER / 1000) headerDelay = seconds * 1000;
  } else if (value && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), .+ GMT$/.test(value)) {
    const date = Date.parse(value);
    if (Number.isFinite(date)) headerDelay = Math.max(0, date - now);
  }
  let data: any = body;
  if (typeof body === "string") { try { data = JSON.parse(body); } catch { data = undefined; } }
  const waits = [data?.extras?.wait_seconds, data?.extras?.time_left]
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER / 1000)
    .map(n => n * 1000);
  const hints = [headerDelay, ...waits].filter((n): n is number => n !== undefined);
  // A response without timing hints may have hit a full one-minute search
  // window; a shorter guessed delay can immediately repeat that failure.
  return Math.max(1000, hints.length ? Math.max(...hints) : 60000);
}

type Bucket = { tail: Promise<void>; lastStart: number; cooldown: number };
const buckets = new Map<string, Bucket>();
function bucketFor(origin: string): Bucket {
  let bucket = buckets.get(origin);
  if (!bucket) { bucket = { tail: Promise.resolve(), lastStart: 0, cooldown: 0 }; buckets.set(origin, bucket); }
  return bucket;
}

export function recordRateLimit(origin: string, status: number | undefined, headers: Record<string, string> | undefined, body: unknown): void {
  if (!isRateLimited(status, body)) return;
  const wait = retryAfterMs(headers, body);
  const bucket = bucketFor(origin);
  bucket.cooldown = Math.max(bucket.cooldown, Date.now() + wait);
  throw new RateLimitError(status ?? 429, wait, body);
}

export function assertNotCoolingDown(origin: string): void {
  const remaining = bucketFor(origin).cooldown - Date.now();
  if (remaining > 0) throw new RateLimitError(429, remaining);
}

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Request cancelled"));
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error("Request cancelled")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Request cancelled"));
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal?.reason ?? new Error("Request cancelled")); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, ms));
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** One logical request at a time per origin, including all fallback paths. */
export async function withSiteRequest<T>(origin: string, operation: () => Promise<T>, signal?: AbortSignal, intervalMs = 500): Promise<T> {
  const bucket = bucketFor(origin);
  const previous = bucket.tail;
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  bucket.tail = previous.catch(() => undefined).then(() => current);
  try {
    await waitFor(previous, signal);
    assertNotCoolingDown(origin);
    await delay(intervalMs - (Date.now() - bucket.lastStart), signal);
    assertNotCoolingDown(origin);
    bucket.lastStart = Date.now();
    return await operation();
  } finally { release(); }
}
