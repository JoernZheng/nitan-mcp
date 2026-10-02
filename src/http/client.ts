import { normalizeSiteBase, resolveSiteUrl } from "../util/site_url.js";
import { createHash, randomUUID } from "node:crypto";
import { HttpError, RateLimitError } from "./errors.js";
export { HttpError, RateLimitError } from "./errors.js";
import { createRequestBudget, throwIfAborted, cancellationError, type RequestBudget } from "./request_budget.js";
import { withSiteRequest, recordRateLimit, assertNotCoolingDown, delay as retrySleep } from "./rate_limit.js";
import { Logger } from "../util/logger.js";
import { CloudscraperClient } from "./cloudscraper.js";
import { CurlCffiClient } from "./curl_cffi.js";
import {
  BrowserFallbackClient,
  BrowserFallbackRelayUnavailableError,
  BrowserSiteBoundaryError,
  type BrowserFallbackOptions,
} from "./browser_fallback.js";

export type AuthMode =
  | { type: "none" }
  | { type: "api_key"; key: string; username?: string }
  | { type: "user_api_key"; key: string; client_id?: string };

export type BypassMethod = "cloudscraper" | "curl_cffi" | "both";

export interface HttpClientOptions {
  baseUrl: string;
  timeoutMs: number;
  requestIntervalMs?: number;
  logger: Logger;
  auth: AuthMode;
  useCloudscraper?: boolean; // Use Python cloudscraper to bypass Cloudflare (deprecated, use bypassMethod)
  bypassMethod?: BypassMethod; // Which bypass method to use: "cloudscraper", "curl_cffi", or "both" (fallback)
  pythonPath?: string; // Path to Python executable (default: "python3")
  loginCredentials?: {
    username: string;
    password: string;
    second_factor_token?: string;
  };
  browserFallback?: BrowserFallbackOptions;
}

export class HttpClient {
  private base: URL;
  private disposed = false;
  private readonly activeControllers = new Set<AbortController>();
  private readonly pendingRequests = new Set<Promise<unknown>>();
  private activeRequestId?: string;
  private backendAttempts = 0;
  private explicitCalls = 0;
  private warmupCalls = 0;
  private countsKnown = true;
  // Mimics Microsoft Edge browser on Windows to avoid bot detection
  private userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
  private cache = new Map<string, { value: any; expiresAt: number }>();
  private cookies = new Map<string, string>(); // Store cookies across requests
  private lastUrl: string | null = null; // Track last URL for Referer header
  private cloudscraperClient?: CloudscraperClient;
  private curlCffiClient?: CurlCffiClient;
  private bypassMethod: BypassMethod;
  private cloudscraperFailed = false; // Track if cloudscraper has failed
  private browserFallbackClient?: BrowserFallbackClient;

  constructor(private opts: HttpClientOptions) {
    this.base = new URL(normalizeSiteBase(opts.baseUrl) + "/");

    // Determine bypass method (support legacy useCloudscraper option)
    if (opts.bypassMethod) {
      this.bypassMethod = opts.bypassMethod;
    } else if (opts.useCloudscraper) {
      // Legacy: if useCloudscraper is true, default to "both" for better reliability
      this.bypassMethod = "both";
    } else {
      this.bypassMethod = "both"; // Default to both with fallback
    }

    // Initialize bypass clients based on method
    if (this.bypassMethod === "cloudscraper" || this.bypassMethod === "both") {
      this.cloudscraperClient = new CloudscraperClient(opts.logger, opts.pythonPath);

    }
    if (this.bypassMethod === "curl_cffi" || this.bypassMethod === "both") {
      this.curlCffiClient = new CurlCffiClient(opts.logger, opts.pythonPath);

    }

    // Log the active bypass strategy

    if (opts.browserFallback?.enabled) {
      this.browserFallbackClient = new BrowserFallbackClient(this.opts.logger, opts.browserFallback);

    }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      "Dnt": "1",
      "Pragma": "no-cache",
      "Priority": "u=1, i",
      "Sec-Ch-Ua": '"Microsoft Edge";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": this.userAgent,
      "X-Requested-With": "XMLHttpRequest",
    };

    // Add Referer header for subsequent requests
    if (this.lastUrl) {
      h["Referer"] = this.base.toString();
    }

    // Add cookies if we have any
    if (this.cookies.size > 0) {
      h["Cookie"] = Array.from(this.cookies.entries())
        .map(([key, value]) => `${key}=${value}`)
        .join("; ");

    }

    if (this.opts.auth.type === "api_key") {
      h["Api-Key"] = this.opts.auth.key;
      if (this.opts.auth.username) h["Api-Username"] = this.opts.auth.username;
    } else if (this.opts.auth.type === "user_api_key") {
      h["User-Api-Key"] = this.opts.auth.key;
      if (this.opts.auth.client_id) h["User-Api-Client-Id"] = this.opts.auth.client_id;
    }
    return h;
  }

  private parseCookies(setCookieHeader: string) {
    // Parse Set-Cookie header and store cookies
    // Handle multiple Set-Cookie headers (split by comma, but be careful with expires dates)
    const cookies = setCookieHeader.split(/,(?=[^ ])/);
    for (const cookie of cookies) {
      const parts = cookie.split(";")[0].trim(); // Get only the name=value part
      const [name, ...valueParts] = parts.split("=");
      if (name && valueParts.length > 0) {
        const value = valueParts.join("=");
        this.cookies.set(name.trim(), value.trim());

      }
    }
  }

  async get(path: string, { signal }: { signal?: AbortSignal } = {}) {
    return this.request("GET", path, undefined, { signal });
  }

  async getCached(path: string, ttlMs: number, { signal }: { signal?: AbortSignal } = {}) {
    if (this.disposed) throw new Error("HTTP client has been disposed");
    throwIfAborted(signal);
    const url = resolveSiteUrl(this.base.toString(), path);
    const entry = this.cache.get(url);
    const now = Date.now();
    if (entry && entry.expiresAt > now) return entry.value;
    const value = await this.request("GET", path, undefined, { signal });
    this.cache.set(url, { value, expiresAt: now + ttlMs });
    return value;
  }

  async post(path: string, body: unknown, { signal }: { signal?: AbortSignal } = {}) {
    return this.request("POST", path, body, { signal });
  }

  private async request(method: string, path: string, body?: unknown, { signal }: { signal?: AbortSignal } = {}) {
    if (this.disposed) throw new Error("HTTP client has been disposed");
    const started = Date.now();
    const controller = new AbortController();
    const budget = createRequestBudget(this.opts.timeoutMs, signal, controller);
    this.activeControllers.add(controller);
    const fields = { request_id: randomUUID(), site_id: createHash("sha256").update(this.base.origin).digest("hex").slice(0, 12), method, auth_strategy: this.opts.auth.type === "none" ? this.opts.loginCredentials ? "login_credentials" : "anonymous" : this.opts.auth.type };
    this.opts.logger.event("http.request.started", fields, "debug");
    const operation = withSiteRequest(this.base.origin, async () => {
      budget.remainingMs();
      const queueMs = Date.now() - started;
      this.activeRequestId = fields.request_id;
      this.backendAttempts = 0; this.explicitCalls = 0; this.warmupCalls = 0; this.countsKnown = true;
      const value = await this.requestUnscheduled(method, path, body, budget);
      budget.remainingMs();
      this.opts.logger.event("http.request.completed", { ...fields, queue_ms: queueMs, duration_ms: Date.now() - started, backend_attempts: this.backendAttempts, explicit_request_count_known: this.countsKnown, ...(this.countsKnown ? { explicit_request_count: this.explicitCalls, warmup_request_count: this.warmupCalls } : {}), request_interval_ms: this.opts.requestIntervalMs ?? 500, outcome: "ok" });
      return value;
    }, budget.signal, this.opts.requestIntervalMs ?? 500);
    this.pendingRequests.add(operation);
    try { return await operation; }
    catch (error) {
      const e = error as any;
      this.opts.logger.event(e instanceof RateLimitError ? "http.rate_limited" : "http.request.failed", { ...fields, duration_ms: Date.now() - started, status: e instanceof HttpError ? e.status : undefined, retry_after_ms: e instanceof RateLimitError ? e.retryAfterMs : undefined, explicit_request_count_known: this.activeRequestId === fields.request_id && this.countsKnown, ...(this.activeRequestId === fields.request_id && this.countsKnown ? { explicit_request_count: this.explicitCalls, warmup_request_count: this.warmupCalls } : {}), outcome: e instanceof RateLimitError ? "rate_limited" : budget.signal.aborted ? "cancelled" : "error" }, e instanceof RateLimitError ? "info" : "error");
      throw budget.signal.aborted ? cancellationError(budget.signal) : error;
    } finally {
      budget.close();
      this.activeControllers.delete(controller);
      this.pendingRequests.delete(operation);
      if (this.activeRequestId === fields.request_id) this.activeRequestId = undefined;
    }
  }

  private recordPythonMetrics(result: { explicit_request_count?: number; warmup_request_count?: number }) {
    if (Number.isSafeInteger(result.explicit_request_count) && Number.isSafeInteger(result.warmup_request_count) && result.explicit_request_count! >= 0 && result.warmup_request_count! >= 0 && result.warmup_request_count! <= result.explicit_request_count!) {
      this.explicitCalls += result.explicit_request_count!; this.warmupCalls += result.warmup_request_count!;
    } else this.countsKnown = false;
  }

  private rateLimit(status: number | undefined, headers: Record<string, string> | undefined, body: unknown) {
    recordRateLimit(this.base.origin, status, headers, body);
  }

  private async requestUnscheduled(method: string, path: string, body: unknown, budget: RequestBudget) {
    const url = resolveSiteUrl(this.base.toString(), path);
    const headers = this.headers();
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    // Use bypass method if configured; if bypass runtime is unavailable, gracefully fall back to native fetch
    if (this.cloudscraperClient || this.curlCffiClient) {
      try {
        return await this.requestViaBypass(method, url, headers, body, budget);
      } catch (e: any) {
        throwIfAborted(budget?.signal);
        if (e?.name === "AbortError" || e?.name === "TimeoutError") throw e;
        if (e instanceof BrowserFallbackRelayUnavailableError || e instanceof BrowserSiteBoundaryError) {
          throw e;
        }
        if (e instanceof HttpError) {
          throw e;
        }

      }
    }

    budget.remainingMs();

    const attempt = async () => {
      try {
        budget.remainingMs();
        const backendStarted = Date.now();
        this.backendAttempts++;
        this.opts.logger.event("http.backend.started", { request_id: this.activeRequestId, backend: "native", method }, "debug");
        this.explicitCalls++;
        const res = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: budget.signal,
        });

        throwIfAborted(budget?.signal);
        this.opts.logger.event("http.backend.completed", { request_id: this.activeRequestId, backend: "native", method, status: res.status, duration_ms: Date.now() - backendStarted }, "debug");

        // Headers are retained for classification, never logged.
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        // Store cookies from response
        const setCookie = res.headers.get("set-cookie");
        if (setCookie) {
          this.parseCookies(setCookie);

        }

        // Update last URL for Referer header
        this.lastUrl = url;

        if (!res.ok) {
          const text = await safeText(res);
          const errorBody = safeJson(text);
          this.rateLimit(res.status, responseHeaders, text);
          const isChallenge = this.isCloudflareChallenge(res.status, text, responseHeaders);
          if (isChallenge && this.browserFallbackClient?.isEnabled()) {

            return await this.tryBrowserFallback(method, url, headers, body, budget);
          }

          throw new HttpError(res.status, `HTTP ${res.status} ${res.statusText}`, errorBody);
        }
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          const text = await res.text();
          budget.remainingMs();
          this.rateLimit(res.status, responseHeaders, text);
          try { return JSON.parse(text); } catch { throw new Error("Invalid HTTP response JSON"); }
        } else {
          const text = await res.text();
          budget.remainingMs();
          this.rateLimit(res.status, responseHeaders, text);
          return text;
        }
      } catch (e: any) {
        throwIfAborted(budget?.signal);
        if (e?.name === "AbortError" || e?.name === "TimeoutError") throw e;
        if (e instanceof BrowserFallbackRelayUnavailableError || e instanceof BrowserSiteBoundaryError) throw e;
        // Enhanced error logging for fetch failures
        if (e instanceof HttpError) {
          throw e; // Already logged above
        }

        // Check for common fetch failure reasons
        if (e.name === "TypeError" && e.message === "fetch failed") {
          const detailedMsg = `Network error for ${method} ${url}: ${e.message}. Possible causes: DNS resolution failure, network connectivity issue, SSL/TLS error, or server unreachable.`;
          throw new Error(detailedMsg);
        }

        // Generic network error
        const genericMsg = `Fetch error for ${method} ${url}: ${e.name}: ${e.message}`;
        throw new Error(`${e.name}: ${e.message}`);
      }
    };

    return await withRetries(attempt, budget.signal);
  }

  private isCloudflareChallenge(status: number | undefined, bodyText: string | undefined, headers: Record<string, string> | undefined): boolean {
    const normalizedHeaders: Record<string, string> = {};
    if (headers) {
      for (const [k, v] of Object.entries(headers)) normalizedHeaders[k.toLowerCase()] = String(v);
    }

    const cfHeaderHit = normalizedHeaders["cf-mitigated"]?.toLowerCase() === "challenge";

    const body = (bodyText || "").toLowerCase();
    const bodyHit =
      body.includes("just a moment") ||
      body.includes("attention required") ||
      body.includes("/cdn-cgi/challenge-platform/") ||
      body.includes("cf-challenge");

    const statusHit = status === 403 || status === 429 || status === 503;
    return Boolean((statusHit && (cfHeaderHit || bodyHit)) || bodyHit);
  }

  private isLoginRequired(finalUrl: string | undefined, bodyText: string | undefined): boolean {
    const u = (finalUrl || "").toLowerCase();
    const b = (bodyText || "").toLowerCase();
    return (
      u.includes("/login") ||
      b.includes("name=\"login\"") ||
      b.includes("name=\"password\"") ||
      b.includes("log in")
    );
  }

  private async tryBrowserFallback(method: string, url: string, headers: Record<string, string>, body?: unknown, budget?: RequestBudget): Promise<any> {
    if (!this.browserFallbackClient?.isEnabled()) {
      return undefined;
    }

    const browserRequest = {
      url,
      siteBase: normalizeSiteBase(this.base.toString()),
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    };

    const requestBrowser = async () => {
      throwIfAborted(budget?.signal);
      assertNotCoolingDown(this.base.origin);
      const started = Date.now();
      this.backendAttempts++; this.countsKnown = false;
      this.opts.logger.event("http.backend.started", { request_id: this.activeRequestId, backend: "browser", method }, "debug");
      const response = await this.browserFallbackClient!.request(browserRequest, { signal: budget?.signal, timeoutMs: budget?.remainingMs() });
      throwIfAborted(budget?.signal);
      this.opts.logger.event("http.backend.completed", { request_id: this.activeRequestId, backend: "browser", method, status: response.status, duration_ms: Date.now() - started }, "debug");
      this.rateLimit(response.status, response.headers, response.body);
      return response;
    };
    let response = await requestBrowser();
    if (this.isLoginRequired(response.finalUrl, response.body)) {
      if (!this.opts.loginCredentials) {
        throw new Error("Authentication required. Configure an API key or provide NITAN_USERNAME/NITAN_PASSWORD.");
      }
      throwIfAborted(budget?.signal);
      assertNotCoolingDown(this.base.origin);
      const autoLoginAttempted = await this.browserFallbackClient.maybeAutoLogin(this.base.toString(), { signal: budget?.signal, timeoutMs: budget?.remainingMs() }, this.opts.loginCredentials);
      throwIfAborted(budget?.signal);
      if (autoLoginAttempted) response = await requestBrowser();
      if (this.isLoginRequired(response.finalUrl, response.body)) {
        throwIfAborted(budget?.signal);
        assertNotCoolingDown(this.base.origin);
        await this.browserFallbackClient.maybePromptInteractiveLogin(this.base.toString(), { signal: budget?.signal, timeoutMs: budget?.remainingMs() });
      }
    }

    const contentType = response.headers?.["content-type"] || response.headers?.["Content-Type"] || "";
    if (response.status >= 400) {
      throw new HttpError(response.status, `Browser fallback HTTP ${response.status}`, safeJson(response.body || ""));
    }

    if (contentType.includes("application/json")) {
      return JSON.parse(response.body || "{}");
    }

    const maybeJson = safeJson(response.body || "");
    return typeof maybeJson === "string" ? response.body : maybeJson;
  }

  private async requestViaBypass(method: string, url: string, headers: Record<string, string>, body?: unknown, budget?: RequestBudget): Promise<any> {
    // Convert cookies Map to object
    const cookiesObj: Record<string, string> = {};
    this.cookies.forEach((value, key) => {
      cookiesObj[key] = value;
    });

    // Log cookies being sent

    const requestData: any = {
      url,
      site_base: normalizeSiteBase(this.base.toString()),
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cookies: cookiesObj,
      timeout: Math.max(0.001, (budget?.remainingMs() ?? this.opts.timeoutMs) / 1000), // Convert to seconds
    };

    // Add login credentials if provided
    if (this.opts.loginCredentials) {
      requestData.login = this.opts.loginCredentials;

    }

    // Strategy: Try cloudscraper first (if available), fallback to curl_cffi
    let lastError: Error | null = null;

    // Try cloudscraper if available and not previously failed (or if it's the only option)
    if (this.cloudscraperClient && (this.bypassMethod === "cloudscraper" || !this.cloudscraperFailed)) {
      try {

        const backendStarted = Date.now();
        this.backendAttempts++;
        this.opts.logger.event("http.backend.started", { request_id: this.activeRequestId, backend: "cloudscraper", method }, "debug");
        const previouslyKnown = this.countsKnown; this.countsKnown = false;
        const result = await this.cloudscraperClient.request({ ...requestData, timeout: Math.max(0.001, (budget?.remainingMs() ?? this.opts.timeoutMs) / 1000) }, { signal: budget?.signal });
        this.countsKnown = previouslyKnown;
        this.recordPythonMetrics(result);
        throwIfAborted(budget?.signal);
        this.opts.logger.event("http.backend.completed", { request_id: this.activeRequestId, backend: "cloudscraper", method, status: result.status, duration_ms: Date.now() - backendStarted }, "debug");

        this.rateLimit(result.status, result.headers, result.body);
        if (!result.success) {
          throw new Error(`Cloudscraper error: ${result.error} (${result.error_type})`);
        }

        // Store cookies from response
        if (result.cookies) {
          Object.entries(result.cookies).forEach(([key, value]) => {
            this.cookies.set(key, value);

          });
        }

        // Update last URL for Referer header
        this.lastUrl = url;

        // Check for HTTP errors / Cloudflare challenge
        if (result.status && result.status >= 400) {
          const isChallenge = this.isCloudflareChallenge(result.status, result.body, result.headers);
          if (isChallenge && this.browserFallbackClient?.isEnabled()) {

            return await this.tryBrowserFallback(method, url, headers, body, budget);
          }

          const errorBody = safeJson(result.body || "");

          throw new HttpError(result.status, `HTTP ${result.status}`, errorBody);
        }

        if (this.isCloudflareChallenge(result.status, result.body, result.headers) && this.browserFallbackClient?.isEnabled()) {

          return await this.tryBrowserFallback(method, url, headers, body, budget);
        }

        // Parse response body
        const contentType = result.headers?.["content-type"] || result.headers?.["Content-Type"] || "";
        if (contentType.includes("application/json")) {
          return JSON.parse(result.body || "{}");
        } else {
          return result.body;
        }
      } catch (e: any) {
        throwIfAborted(budget?.signal);
        if (e?.name === "AbortError" || e?.name === "TimeoutError") throw e;
        if (e instanceof BrowserFallbackRelayUnavailableError || e instanceof BrowserSiteBoundaryError) {
          throw e;
        }
        if (e instanceof HttpError) {
          throw e; // Don't fallback on HTTP errors (4xx, 5xx)
        }

        lastError = e;

        // Mark cloudscraper as failed if we're in dual mode
        if (this.bypassMethod === "both") {
          this.cloudscraperFailed = true;

        }

        // If we're in cloudscraper-only mode, throw the error
        if (this.bypassMethod === "cloudscraper") {
          const errorMsg = `Cloudscraper request failed: ${e.message}`;

          throw new Error(errorMsg);
        }

        // Otherwise fall through to try curl_cffi

      }
    }

    // Try curl_cffi if available
    if (this.curlCffiClient) {
      try {

        const backendStarted = Date.now();
        this.backendAttempts++;
        this.opts.logger.event("http.backend.started", { request_id: this.activeRequestId, backend: "curl_cffi", method }, "debug");
        const previouslyKnown = this.countsKnown; this.countsKnown = false;
        const result = await this.curlCffiClient.request({ ...requestData, timeout: Math.max(0.001, (budget?.remainingMs() ?? this.opts.timeoutMs) / 1000) }, { signal: budget?.signal });
        this.countsKnown = previouslyKnown;
        this.recordPythonMetrics(result);
        throwIfAborted(budget?.signal);
        this.opts.logger.event("http.backend.completed", { request_id: this.activeRequestId, backend: "curl_cffi", method, status: result.status, duration_ms: Date.now() - backendStarted }, "debug");

        this.rateLimit(result.status, result.headers, result.body);
        if (!result.success) {
          throw new Error(`curl_cffi error: ${result.error} (${result.error_type})`);
        }

        // Store cookies from response
        if (result.cookies) {
          Object.entries(result.cookies).forEach(([key, value]) => {
            this.cookies.set(key, value);

          });
        }

        // Update last URL for Referer header
        this.lastUrl = url;

        // Check for HTTP errors / Cloudflare challenge
        if (result.status && result.status >= 400) {
          const isChallenge = this.isCloudflareChallenge(result.status, result.body, result.headers);
          if (isChallenge && this.browserFallbackClient?.isEnabled()) {

            return await this.tryBrowserFallback(method, url, headers, body, budget);
          }

          const errorBody = safeJson(result.body || "");

          throw new HttpError(result.status, `HTTP ${result.status}`, errorBody);
        }

        if (this.isCloudflareChallenge(result.status, result.body, result.headers) && this.browserFallbackClient?.isEnabled()) {

          return await this.tryBrowserFallback(method, url, headers, body, budget);
        }

        // Parse response body
        const contentType = result.headers?.["content-type"] || result.headers?.["Content-Type"] || "";
        if (contentType.includes("application/json")) {
          return JSON.parse(result.body || "{}");
        } else {
          return result.body;
        }
      } catch (e: any) {
        throwIfAborted(budget?.signal);
        if (e?.name === "AbortError" || e?.name === "TimeoutError") throw e;
        if (e instanceof BrowserFallbackRelayUnavailableError || e instanceof BrowserSiteBoundaryError) {
          throw e;
        }
        if (e instanceof HttpError) {
          throw e; // Don't retry on HTTP errors
        }

        const errorMsg = `curl_cffi request failed: ${e.message}`;

        // If we had a previous cloudscraper error, mention both
        if (lastError) {

          throw new Error(`Both bypass methods failed. Last error: ${e.message}`);
        }

        throw new Error(errorMsg);
      }
    }

    // This should never happen if configuration is correct
    throw new Error("No bypass method available");
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.activeControllers) controller.abort(new DOMException("Request cancelled", "AbortError"));
    const browserCleanup = Promise.resolve().then(() => this.browserFallbackClient?.dispose())
      .catch(() => this.opts.logger.event("http.backend.failed", { backend: "browser", outcome: "error", reason: "transport_unavailable" }, "error"));
    await Promise.allSettled([...this.pendingRequests, browserCleanup]);
  }
}

async function withRetries<T>(fn: () => Promise<T>, signal: AbortSignal, retries = 3): Promise<T> {
  let attempt = 0;
  let retryDelay = 250;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      throwIfAborted(signal);
      return await fn();
    } catch (e: any) {
      if (e instanceof RateLimitError) throw e;
      const status = e?.status as number | undefined;
      if (attempt < retries - 1 && (status && status >= 500)) {
        attempt++;

        await retrySleep(retryDelay, signal);
        retryDelay *= 2;
        continue;
      }
      // Propagate final failure; the request wrapper emits its operational event.
      throw e;
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
