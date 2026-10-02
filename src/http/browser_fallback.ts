import { normalizeSiteBase, isUrlWithinSite } from "../util/site_url.js";
import { RateLimitError } from "./errors.js";
import { isRateLimited, recordRateLimit, assertNotCoolingDown } from "./rate_limit.js";
import { execFile } from "node:child_process";
import { createRequestBudget, cancellationError, type RequestBudget } from "./request_budget.js";
import { delay } from "./rate_limit.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Logger } from "../util/logger.js";
import {
  getDefaultBrowserFallbackProvider,
  type BrowserFallbackProvider,
} from "./browser_fallback_defaults.js";

export interface BrowserFallbackOptions {
  enabled?: boolean;
  provider?: BrowserFallbackProvider;
  timeoutMs?: number;
  openClawRelayCdpUrl?: string;
  interactiveLoginEnabled?: boolean;
  loginProfileName?: string;
  loginWaitTimeoutMs?: number;
  loginCheckUrl?: string;
  playwrightModuleLoader?: () => Promise<any>;
}

export class BrowserSiteBoundaryError extends Error {
  constructor(message = "Browser navigated outside the configured site; check the login URL before retrying") { super(message); this.name = "BrowserSiteBoundaryError"; }
}

export class BrowserFallbackRelayUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserFallbackRelayUnavailableError";
  }
}

export interface BrowserLoginCredentials { username: string; password: string; }

export interface BrowserOperationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface BrowserRequest {
  url: string;
  siteBase?: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface BrowserResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
  finalUrl?: string;
}

export interface BrowserProfileSelection {
  userDataDir: string;
  profileDirectory: string;
  source: "openclaw" | "nitan";
}

interface PlaywrightSession {
  key: string;
  context: any;
  page?: any;
}

const OPENCLAW_USER_DATA_DIR_CANDIDATE_SUFFIXES = [
  ["Library", "Application Support", "OpenClaw", "ChromeProfile"],
  ["Library", "Application Support", "OpenClaw", "Browser", "ChromeProfile"],
  ["Library", "Application Support", "OpenClaw", "Browser", "chrome"],
] as const;

const NITAN_CHROME_USER_DATA_DIR_SUFFIX = ["Library", "Application Support", "NitanMCP", "ChromeProfile"] as const;
const execFileAsync = promisify(execFile);

function readJsonObject(filePath: string): Record<string, any> {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
    }
  } catch {
  }
  return {};
}

function writeJsonObject(filePath: string, value: Record<string, any>): void {
  writeFileSync(filePath, JSON.stringify(value));
}

function ensureManagedProfileMetadata(userDataDir: string, profileDirectory: string): void {
  const profileName = profileDirectory;

  try {
    const localStatePath = join(userDataDir, "Local State");
    const localState = readJsonObject(localStatePath);
    const localStateProfile = localState.profile && typeof localState.profile === "object"
      ? localState.profile
      : {};
    const infoCache = localStateProfile.info_cache && typeof localStateProfile.info_cache === "object"
      ? localStateProfile.info_cache
      : {};
    const profileInfo = infoCache[profileDirectory] && typeof infoCache[profileDirectory] === "object"
      ? infoCache[profileDirectory]
      : {};

    const profilesOrder = Array.isArray(localStateProfile.profiles_order)
      ? [...localStateProfile.profiles_order]
      : [];
    if (!profilesOrder.includes(profileDirectory)) {
      profilesOrder.push(profileDirectory);
    }

    const lastActiveProfiles = Array.isArray(localStateProfile.last_active_profiles)
      ? [...localStateProfile.last_active_profiles]
      : [];
    if (!lastActiveProfiles.includes(profileDirectory)) {
      lastActiveProfiles.push(profileDirectory);
    }

    infoCache[profileDirectory] = {
      ...profileInfo,
      name: profileName,
      is_using_default_name: false,
    };

    localState.profile = {
      ...localStateProfile,
      info_cache: infoCache,
      last_used: profileDirectory,
      profiles_order: profilesOrder,
      last_active_profiles: lastActiveProfiles,
    };
    writeJsonObject(localStatePath, localState);
  } catch {
  }

  try {
    const preferencesPath = join(userDataDir, profileDirectory, "Preferences");
    const preferences = readJsonObject(preferencesPath);
    const profilePreferences = preferences.profile && typeof preferences.profile === "object"
      ? preferences.profile
      : {};
    preferences.profile = {
      ...profilePreferences,
      name: profileName,
      using_default_name: false,
    };
    writeJsonObject(preferencesPath, preferences);
  } catch {
  }
}

function getOpenClawUserDataDirCandidates(homeDir: string, openClawChromeProfileDirOverride?: string): string[] {
  const envOverride = openClawChromeProfileDirOverride?.trim();
  return [
    envOverride,
    ...OPENCLAW_USER_DATA_DIR_CANDIDATE_SUFFIXES.map((suffix) => join(homeDir, ...suffix)),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

export function resolveMacPlaywrightProfileSelection(params: {
  homeDir: string;
  loginProfileName?: string;
  openClawChromeProfileDirOverride?: string;
}): BrowserProfileSelection {
  const profileDirectory = params.loginProfileName || "nitan";
  const openClawCandidates = getOpenClawUserDataDirCandidates(params.homeDir, params.openClawChromeProfileDirOverride);

  for (const candidate of openClawCandidates) {
    if (!existsSync(candidate)) continue;
    const selectedProfilePath = join(candidate, profileDirectory);
    if (!existsSync(selectedProfilePath)) continue;
    return {
      userDataDir: candidate,
      profileDirectory,
      source: "openclaw",
    };
  }

  const nitanUserDataDir = join(params.homeDir, ...NITAN_CHROME_USER_DATA_DIR_SUFFIX);
  mkdirSync(join(nitanUserDataDir, profileDirectory), { recursive: true });
  ensureManagedProfileMetadata(nitanUserDataDir, profileDirectory);
  return {
    userDataDir: nitanUserDataDir,
    profileDirectory,
    source: "nitan",
  };
}

export class BrowserFallbackClient {
  private readonly timeoutMs: number;
  private readonly playwrightModuleLoader: () => Promise<any>;
  private playwrightSession?: PlaywrightSession;
  private creatingPlaywrightSession?: Promise<PlaywrightSession>;
  private sessionGeneration = 0;
  private disposed = false;
  private readonly controllers = new Set<AbortController>();
  private readonly operations = new Set<Promise<unknown>>();

  constructor(private readonly logger: Logger, private readonly options: BrowserFallbackOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.playwrightModuleLoader = options.playwrightModuleLoader ?? BrowserFallbackClient.defaultPlaywrightModuleLoader;
  }

  private static defaultPlaywrightModuleLoader = async (): Promise<any> => {
    const dynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<any>;
    return dynamicImport("playwright");
  };

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.operations, this.closePlaywrightSession()]);
  }

  private async runWithBudget<T>(options: BrowserOperationOptions, operation: (budget: RequestBudget) => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error("Browser fallback client has been disposed");
    if (this.controllers.size) throw new Error("Browser fallback already has an active operation; retry after it finishes");
    const controller = new AbortController();
    const budget = createRequestBudget(Math.min(options.timeoutMs ?? this.timeoutMs, this.timeoutMs), options.signal, controller);
    this.controllers.add(controller);
    let cleanup: Promise<void> | undefined;
    const abort = () => { cleanup ??= this.closePlaywrightSession(); };
    budget.signal.addEventListener("abort", abort, { once: true });
    const pending = (async () => {
      budget.remainingMs();
      const result = await operation(budget);
      budget.remainingMs();
      return result;
    })();
    this.operations.add(pending);
    try { return await pending; }
    catch (error) { if (budget.signal.aborted) throw cancellationError(budget.signal); throw error; }
    finally {
      budget.signal.removeEventListener("abort", abort);
      await cleanup;
      budget.close();
      this.controllers.delete(controller);
      this.operations.delete(pending);
    }
  }

  /** Resource creation may finish after abort. Own and close that late result. */
  private waitForResource<T>(promise: Promise<T>, budget: RequestBudget, close: (resource: T) => Promise<unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => budget.signal.removeEventListener("abort", abort);
      const abort = () => { if (!settled) { settled = true; cleanup(); reject(cancellationError(budget.signal)); } };
      budget.signal.addEventListener("abort", abort, { once: true });
      if (budget.signal.aborted) abort();
      promise.then(resource => {
        if (settled) {
          void close(resource).catch(() => this.logger.event("http.backend.failed", { backend: "browser", reason: "transport_unavailable", outcome: "error" }, "error"));
        } else { settled = true; cleanup(); resolve(resource); }
      }, error => { if (!settled) { settled = true; cleanup(); reject(error); } });
    });
  }

  private async openChromeOnMac(openArgs: string[], _errorPrefix: string, budget: RequestBudget): Promise<void> {
    await execFileAsync("open", openArgs, { signal: budget.signal, timeout: budget.remainingMs() });
    budget.remainingMs();
  }

  private escapeAppleScriptString(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  }

  private async runAppleScript(lines: string[], budget: RequestBudget): Promise<string> {
    const args = lines.flatMap((line) => ["-e", line]);
    const { stdout } = await execFileAsync("osascript", args, { signal: budget.signal, timeout: budget.remainingMs() });
    budget.remainingMs();
    return stdout.trim();
  }

  private async openUrlInFrontChromeTabOnMac(url: string, budget: RequestBudget): Promise<void> {
    const escapedUrl = this.escapeAppleScriptString(url);
    let lastFrontUrl = "";

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const frontUrl = await this.runAppleScript([
        "tell application \"Google Chrome\" to activate",
        "tell application \"Google Chrome\" to if (count of windows) = 0 then make new window",
        `tell application \"Google Chrome\" to set URL of active tab of front window to \"${escapedUrl}\"`,
        "delay 0.25",
        "tell application \"Google Chrome\" to return URL of active tab of front window",
      ], budget);
      budget.remainingMs();

      lastFrontUrl = frontUrl;
      if (frontUrl === url || frontUrl.startsWith(url)) {
        return;
      }

      await delay(250, budget.signal);
    }

    throw new Error(
      `Failed to open target login URL '${url}' in Chrome front tab. Last observed front tab URL: '${lastFrontUrl || "unknown"}'`
    );
  }

  private getMacHomeDir(): string {
    const home = process.env.HOME || homedir();
    if (!home) throw new Error("browser_fallback_home_directory_not_found");
    return home;
  }

  private resolvePlaywrightProfileSelection(): BrowserProfileSelection {
    if (process.platform !== "darwin") {
      throw new Error("browser_fallback_not_supported_on_platform");
    }
    const homeDir = this.getMacHomeDir();
    return resolveMacPlaywrightProfileSelection({
      homeDir,
      loginProfileName: this.options.loginProfileName,
      openClawChromeProfileDirOverride: process.env.OPENCLAW_CHROME_PROFILE_DIR,
    });
  }

  private resolveEnvAutoLoginCredentials(): { username: string; password: string } | undefined {
    const username = process.env.NITAN_USERNAME?.trim();
    const password = process.env.NITAN_PASSWORD;
    if (!username || !password) return undefined;
    return { username, password };
  }

  private async safeResponseBody(response: any): Promise<string> {
    try { return typeof response?.text === "function" ? await response.text() : ""; }
    catch { return ""; }
  }

  private async submitLoginForm(page: any, loginUrl: string, username: string, password: string, budget: RequestBudget, siteBase: string): Promise<void> {
    const loginInputSelector = [
      'input[name="login"]',
      "#login-account-name",
      'input[autocomplete="username"]',
      'input[type="email"]',
    ].join(",");
    const passwordInputSelector = [
      'input[name="password"]',
      "#login-account-password",
      'input[autocomplete="current-password"]',
      'input[type="password"]',
    ].join(",");
    const submitSelectors = [
      "#login-button",
      'button[type="submit"]',
      '.login-button button',
      '.btn-primary[type="submit"]',
    ];

    assertNotCoolingDown(new URL(loginUrl).origin);
    const navigation = await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: budget.remainingMs() });
    if (navigation) recordRateLimit(new URL(loginUrl).origin, navigation.status(), navigation.headers?.(), await this.safeResponseBody(navigation));
    budget.remainingMs();
    this.assertPageWithinSite(page, siteBase);
    await page.waitForSelector(loginInputSelector, { timeout: Math.min(budget.remainingMs(), 10_000) });
    budget.remainingMs();
    await page.waitForSelector(passwordInputSelector, { timeout: Math.min(budget.remainingMs(), 10_000) });

    budget.remainingMs();
    this.assertPageWithinSite(page, siteBase);
    await page.fill(loginInputSelector, username);
    budget.remainingMs();
    this.assertPageWithinSite(page, siteBase);
    await page.fill(passwordInputSelector, password);

    budget.remainingMs();
    // Observe the login POST before clicking so a 429 cannot be swallowed as
    // a generic unsuccessful login followed by another target request.
    const loginResponse = typeof page.waitForResponse === "function"
      ? page.waitForResponse((response: any) => response.request?.().method?.() === "POST" && /\/session(?:\.json)?$/.test(new URL(response.url()).pathname), { timeout: Math.min(budget.remainingMs(), 10000) }).catch(() => null)
      : undefined;
    let submitted = false;
    for (const selector of submitSelectors) {
      budget.remainingMs();
      const button = await page.$(selector);
      budget.remainingMs();
      if (!button) continue;

      budget.remainingMs();
      this.assertPageWithinSite(page, siteBase);
      await Promise.allSettled([
        page.waitForLoadState("domcontentloaded", { timeout: Math.min(budget.remainingMs(), 10_000) }),
        page.click(selector),
      ]);
      submitted = true;
      break;
    }

    if (!submitted) {
      budget.remainingMs();
      this.assertPageWithinSite(page, siteBase);
      await page.keyboard.press("Enter");
      budget.remainingMs();
      await page.waitForLoadState("domcontentloaded", { timeout: Math.min(budget.remainingMs(), 10_000) }).catch(() => undefined);
    }

    budget.remainingMs();
    const submittedResponse = await loginResponse;
    budget.remainingMs();
    if (submittedResponse) {
      recordRateLimit(new URL(loginUrl).origin, submittedResponse.status(), submittedResponse.headers?.(), await this.safeResponseBody(submittedResponse));
    }
    budget.remainingMs();
    if (typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(500);
    }
  }

  async maybeAutoLogin(siteUrl: string, options: BrowserOperationOptions = {}, suppliedCredentials?: BrowserLoginCredentials): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    const provider = this.options.provider ?? getDefaultBrowserFallbackProvider();
    if (provider !== "playwright") return false;

    const credentials = suppliedCredentials ?? this.resolveEnvAutoLoginCredentials();
    if (!credentials) return false;

    return this.runWithBudget(options, async budget => {
      const siteBase = normalizeSiteBase(siteUrl);
      const loginUrl = this.options.loginCheckUrl || siteBase;
      if (!isUrlWithinSite(loginUrl, siteBase)) throw new BrowserSiteBoundaryError("Login URL is outside the configured site");
      try {
        const profileSelection = this.resolvePlaywrightProfileSelection();
        const session = await this.getOrCreatePlaywrightSession(profileSelection, budget);
        const page = await this.getOrCreatePlaywrightPage(session, budget);

        await this.submitLoginForm(page, loginUrl, credentials.username, credentials.password, budget, siteBase);
        return true;
      } catch (e: any) {
        budget.remainingMs();
        if (e instanceof RateLimitError || e instanceof BrowserSiteBoundaryError) throw e;

        return true;
      }
    });
  }

  private buildPlaywrightSessionKey(profileSelection: BrowserProfileSelection): string {
    return `${profileSelection.userDataDir}::${profileSelection.profileDirectory}`;
  }

  private isContextUsable(context: any): boolean {
    if (!context) return false;
    try {
      context.pages?.();
      return true;
    } catch {
      return false;
    }
  }

  private isPageUsable(page: any): boolean {
    if (!page) return false;
    if (typeof page.isClosed !== "function") return true;
    try {
      return !page.isClosed();
    } catch {
      return false;
    }
  }

  private isRetryablePlaywrightSessionError(error: unknown): boolean {
    const message = String((error as any)?.message || error || "").toLowerCase();
    return (
      message.includes("target closed") ||
      message.includes("has been closed") ||
      message.includes("context closed") ||
      message.includes("browser has disconnected") ||
      message.includes("browser has been closed")
    );
  }

  private logCleanupFailure(): void {
    this.logger.event("http.backend.failed", { backend: "browser", reason: "transport_unavailable", outcome: "error" }, "error");
  }

  private async closePlaywrightSession(): Promise<void> {
    this.sessionGeneration++;
    const session = this.playwrightSession;
    const pendingSession = this.creatingPlaywrightSession;
    this.playwrightSession = undefined;
    this.creatingPlaywrightSession = undefined;

    if (session) {
      try {
        await session.context.close();
      } catch { this.logCleanupFailure(); }
    }

    if (pendingSession) {
      try {
        const created = await pendingSession;
        if (created && created !== session) {
          try {
            await created.context.close();
          } catch { this.logCleanupFailure(); }
        }
      } catch (pendingError: any) {

      }
    }
  }

  private isProfileSingletonLockError(error: unknown): boolean {
    const message = String((error as any)?.message || error || "").toLowerCase();
    return (
      message.includes("processsingleton") ||
      message.includes("singletonlock") ||
      message.includes("profile is already in use by another instance of chromium")
    );
  }

  private async launchPlaywrightPersistentContext(chromium: any, profileSelection: BrowserProfileSelection, budget: RequestBudget): Promise<any> {
    return await chromium.launchPersistentContext(profileSelection.userDataDir, {
      channel: "chrome",
      timeout: budget.remainingMs(),
      headless: false,
      viewport: { width: 1366, height: 900 },
      args: [`--profile-directory=${profileSelection.profileDirectory}`],
    });
  }

  private async createPlaywrightSession(
    key: string,
    profileSelection: BrowserProfileSelection,
    budget: RequestBudget
  ): Promise<PlaywrightSession> {
    let playwright: any;
    try {
      playwright = await this.waitForResource(this.playwrightModuleLoader(), budget, async () => undefined);
    } catch (e: any) {
      throw new Error(
        `Playwright is not installed. Install with: npm i playwright (macOS only for browser fallback). Details: ${e?.message || e}`
      );
    }

    budget.remainingMs();
    const chromium = playwright?.chromium;
    if (!chromium?.launchPersistentContext) {
      throw new Error("Playwright chromium launcher is unavailable for browser fallback");
    }

    let context: any;
    try {
      context = await this.waitForResource(this.launchPlaywrightPersistentContext(chromium, profileSelection, budget), budget, context => context.close());
    } catch (error) {
      budget.remainingMs();
      if (this.isProfileSingletonLockError(error)) {
        throw new Error("Browser profile is in use. Close its Chrome window before retrying; Nitan will not terminate an existing browser.");
      }
      throw error;
    }

    return {
      key,
      context,
    };
  }

  private async getOrCreatePlaywrightSession(profileSelection: BrowserProfileSelection, budget: RequestBudget): Promise<PlaywrightSession> {
    budget.remainingMs();
    if (this.disposed) throw new Error("Browser fallback client has been disposed");
    const key = this.buildPlaywrightSessionKey(profileSelection);

    if (this.playwrightSession?.key === key && this.isContextUsable(this.playwrightSession.context)) {
      return this.playwrightSession;
    }

    if (this.playwrightSession && this.playwrightSession.key !== key) {
      await this.closePlaywrightSession();
    }

    budget.remainingMs();
    const generation = this.sessionGeneration;
    const creation = this.createPlaywrightSession(key, profileSelection, budget);
    this.creatingPlaywrightSession = creation;
    try {
      const created = await creation;
      if (generation !== this.sessionGeneration || this.disposed || budget.signal.aborted) {
        await created.context.close().catch(() => this.logCleanupFailure());
        budget.remainingMs();
        throw new DOMException("Browser session was closed", "AbortError");
      }
      this.playwrightSession = created;
      return created;
    } finally {
      if (this.creatingPlaywrightSession === creation) {
        this.creatingPlaywrightSession = undefined;
      }
    }
  }

  private async getOrCreatePlaywrightPage(session: PlaywrightSession, budget: RequestBudget): Promise<any> {
    budget.remainingMs();
    if (this.isPageUsable(session.page)) {
      return session.page;
    }

    const existingPages = session.context.pages?.() ?? [];
    const reusablePage = existingPages.find((candidate: any) => this.isPageUsable(candidate));
    if (reusablePage) {
      session.page = reusablePage;
      return reusablePage;
    }

    const newPage = await this.waitForResource(session.context.newPage(), budget, (page: any) => page.close());
    budget.remainingMs();
    session.page = newPage;
    return newPage;
  }

  private async readPlaywrightGetBody(response: any, page: any, budget: RequestBudget): Promise<string> {
    if (response && typeof response.text === "function") {
      try {
        const body = await response.text();
        budget.remainingMs();
        return body;
      } catch { budget.remainingMs(); }
    }

    budget.remainingMs();
    const body = await page.content();
    budget.remainingMs();
    return body;
  }

  private isChallengeLikeResponse(response: BrowserResponse): boolean {
    const body = (response.body || "").toLowerCase();
    const bodyHit =
      body.includes("just a moment") ||
      body.includes("attention required") ||
      body.includes("/cdn-cgi/challenge-platform/") ||
      body.includes("cf-challenge");
    const statusHit = response.status === 403 || response.status === 429 || response.status === 503;
    return Boolean((statusHit && bodyHit) || bodyHit);
  }

  private shouldRetryWithClearedManagedCookies(
    profileSelection: BrowserProfileSelection,
    input: BrowserRequest,
    response: BrowserResponse
  ): boolean {
    return (
      !isRateLimited(response.status, response.body) &&
      input.method.toUpperCase() === "GET" &&
      profileSelection.source === "nitan" &&
      !this.options.loginProfileName &&
      this.isChallengeLikeResponse(response)
    );
  }

  private assertPageWithinSite(page: any, siteBase: string): void {
    if (typeof page.url !== "function" || !isUrlWithinSite(page.url(), siteBase)) throw new BrowserSiteBoundaryError();
  }

  private async requestViaPlaywrightPage(page: any, input: BrowserRequest, budget: RequestBudget): Promise<BrowserResponse> {
    budget.remainingMs();
    const hasCustomHeaders = Boolean(input.headers && Object.keys(input.headers).length > 0);
    if (input.method.toUpperCase() !== "GET" || hasCustomHeaders) {
      const targetOrigin = new URL(input.url).origin;
      const currentUrl = typeof page.url === "function" ? page.url() : "about:blank";
      if (!currentUrl || !isUrlWithinSite(currentUrl, input.siteBase ?? targetOrigin)) {
        const navigation = await page.goto(input.siteBase ?? targetOrigin, { waitUntil: "domcontentloaded", timeout: budget.remainingMs() });
        if (navigation) {
          const navigationBody = await this.safeResponseBody(navigation);
          recordRateLimit(targetOrigin, navigation.status(), navigation.headers?.(), navigationBody);
        }
      }

      budget.remainingMs();
      this.assertPageWithinSite(page, input.siteBase ?? targetOrigin);
      const payload = await page.evaluate(async (req: any) => {
        const fetchResp = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          credentials: "include",
        });
        const text = await fetchResp.text().catch(() => "");
        const hdrs: Record<string, string> = {};
        fetchResp.headers.forEach((value, key) => {
          hdrs[key] = value;
        });
        return {
          status: fetchResp.status,
          body: text,
          headers: hdrs,
          finalUrl: fetchResp.url,
        };
      }, {
        url: input.url,
        method: input.method,
        headers: input.headers || {},
        body: input.body,
      });
      budget.remainingMs();
      return payload;
    }

    const response = await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: budget.remainingMs() });
    if (response) recordRateLimit(new URL(input.url).origin, response.status(), response.headers?.(), await this.safeResponseBody(response));
    budget.remainingMs();
    this.assertPageWithinSite(page, input.siteBase ?? new URL(input.url).origin);
    const content = await this.readPlaywrightGetBody(response, page, budget);
    budget.remainingMs();
    const status = response?.status() ?? 0;
    const headers = response?.headers?.() ?? {};
    const finalUrl = page.url();

    return {
      status,
      body: content,
      headers,
      finalUrl,
    };
  }

  isEnabled(): boolean {
    return Boolean(this.options.enabled);
  }

  async request(input: BrowserRequest, options: BrowserOperationOptions = {}): Promise<BrowserResponse> {
    return this.runWithBudget(options, async budget => {
      const siteBase = normalizeSiteBase(input.siteBase ?? new URL(input.url).origin);
      if (!isUrlWithinSite(input.url, siteBase)) throw new Error("Request URL is outside the configured site");
      input = { ...input, siteBase };
      assertNotCoolingDown(new URL(input.url).origin);
      const provider = this.options.provider ?? getDefaultBrowserFallbackProvider();
      if (provider === "openclaw_proxy") return this.requestViaOpenClawRelay(input, budget);
      if (provider === "playwright") return this.requestViaPlaywright(input, budget);
      throw new Error(`Browser fallback provider not implemented: ${provider}`);
    });
  }

  private getOpenClawRelayCdpUrl(): string {
    return this.options.openClawRelayCdpUrl || process.env.OPENCLAW_CHROME_RELAY_CDP_URL || "http://127.0.0.1:18792";
  }

  private buildOpenClawRelayUnavailableMessage(cdpUrl: string, reason?: string): string {
    const detail = reason ? ` Details: ${reason}` : "";
    return [
      `OpenClaw Chrome relay is unavailable at ${cdpUrl}.${detail}`,
      "Please attach an OpenClaw Browser Relay tab in Chrome first (extension badge should show ON), then retry.",
      "You can verify relay status with: openclaw browser --browser-profile chrome tabs",
    ].join(" ");
  }

  private async probeOpenClawRelay(cdpUrl: string, budget: RequestBudget): Promise<{ reachable: boolean; hasAttachedTab: boolean; reason?: string }> {
    const normalized = cdpUrl.replace(/\/+$/, "");
    const controller = new AbortController();
    const abort = () => controller.abort();
    budget.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, Math.min(budget.remainingMs(), 5000));

    try {
      const response = await fetch(`${normalized}/json/list`, { signal: controller.signal });
      if (!response.ok) {
        return { reachable: false, hasAttachedTab: false, reason: `relay_http_${response.status}` };
      }

      const payload = (await response.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }> | unknown;
      if (!Array.isArray(payload)) {
        return { reachable: false, hasAttachedTab: false, reason: "invalid_relay_payload" };
      }

      const pageTargets = payload.filter((entry) => entry?.type === "page" || Boolean(entry?.webSocketDebuggerUrl));
      return { reachable: true, hasAttachedTab: pageTargets.length > 0 };
    } catch (e: any) {
      budget.remainingMs();
      const reason = e?.name === "AbortError" ? "relay_probe_timeout" : e?.message || String(e);
      return { reachable: false, hasAttachedTab: false, reason };
    } finally {
      clearTimeout(timeout);
      budget.signal.removeEventListener("abort", abort);
    }
  }

  private async requestViaOpenClawRelay(input: BrowserRequest, budget: RequestBudget): Promise<BrowserResponse> {
    const cdpUrl = this.getOpenClawRelayCdpUrl();
    const probe = await this.probeOpenClawRelay(cdpUrl, budget);
    budget.remainingMs();
    if (!probe.reachable || !probe.hasAttachedTab) {
      throw new BrowserFallbackRelayUnavailableError(this.buildOpenClawRelayUnavailableMessage(cdpUrl, probe.reason || "no_attached_tab_detected"));
    }
    const playwright = await this.waitForResource(this.playwrightModuleLoader(), budget, async () => undefined);
    budget.remainingMs();
    let browser: any;
    try { browser = await this.waitForResource(playwright.chromium.connectOverCDP(cdpUrl, { timeout: budget.remainingMs() }), budget, (browser: any) => browser.close()); }
    catch { budget.remainingMs(); throw new BrowserFallbackRelayUnavailableError(this.buildOpenClawRelayUnavailableMessage(cdpUrl, "connection_failed")); }
    let page: any;
    let closing: Promise<void> | undefined;
    const closePage = () => { if (page) closing ??= Promise.resolve().then(() => page.close()).catch(() => this.logCleanupFailure()); };
    budget.signal.addEventListener("abort", closePage, { once: true });
    try {
      budget.remainingMs();
      const context = browser.contexts?.()[0];
      if (!context?.newPage) throw new BrowserFallbackRelayUnavailableError("Relay must support a dedicated request tab; use playwright fallback instead.");
      try { page = await this.waitForResource(context.newPage(), budget, (page: any) => page.close()); }
      catch { throw new BrowserFallbackRelayUnavailableError("Relay cannot create a dedicated request tab; use playwright fallback instead."); }
      budget.remainingMs();
      const response = await this.requestViaPlaywrightPage(page, input, budget);
      budget.remainingMs();
      recordRateLimit(new URL(input.url).origin, response.status, response.headers, response.body);
      return response;
    } finally {
      budget.signal.removeEventListener("abort", closePage);
      closePage();
      await closing;
      // connectOverCDP's Browser.close disconnects this client, not the user's
      // externally launched Chrome. Never close a borrowed context or tab.
      await browser.close().catch(() => this.logCleanupFailure());
    }
  }

  private async requestViaPlaywright(input: BrowserRequest, budget: RequestBudget): Promise<BrowserResponse> {
    const profileSelection = this.resolvePlaywrightProfileSelection();
    try {
      const session = await this.getOrCreatePlaywrightSession(profileSelection, budget);
      const page = await this.getOrCreatePlaywrightPage(session, budget);
      let response = await this.requestViaPlaywrightPage(page, input, budget);
      recordRateLimit(new URL(input.url).origin, response.status, response.headers, response.body);
      if (
        this.shouldRetryWithClearedManagedCookies(profileSelection, input, response) &&
        typeof session.context.clearCookies === "function"
      ) {
        budget.remainingMs();
        await session.context.clearCookies();
        budget.remainingMs();
        response = await this.requestViaPlaywrightPage(page, input, budget);
      }
      return response;
    } catch (e: any) {
      budget.remainingMs();
      if (!this.isRetryablePlaywrightSessionError(e)) {
        throw e;
      }

      await this.closePlaywrightSession();
      const freshSession = await this.getOrCreatePlaywrightSession(profileSelection, budget);
      const freshPage = await this.getOrCreatePlaywrightPage(freshSession, budget);
      let response = await this.requestViaPlaywrightPage(freshPage, input, budget);
      recordRateLimit(new URL(input.url).origin, response.status, response.headers, response.body);
      if (
        this.shouldRetryWithClearedManagedCookies(profileSelection, input, response) &&
        typeof freshSession.context.clearCookies === "function"
      ) {
        budget.remainingMs();
        await freshSession.context.clearCookies();
        budget.remainingMs();
        response = await this.requestViaPlaywrightPage(freshPage, input, budget);
      }
      return response;
    }
  }

  async maybePromptInteractiveLogin(siteUrl: string, options: BrowserOperationOptions = {}): Promise<void> {
    if (!this.options.interactiveLoginEnabled) return;
    if (process.platform !== "darwin") {
      throw new Error("interactive_login_not_supported_on_platform");
    }

    return this.runWithBudget(options, async budget => {
      const siteBase = normalizeSiteBase(siteUrl);
      const url = this.options.loginCheckUrl || siteBase;
      if (!isUrlWithinSite(url, siteBase)) throw new BrowserSiteBoundaryError("Login URL is outside the configured site");
      const profileSelection = this.resolvePlaywrightProfileSelection();

      await this.openChromeOnMac(
        [
          "-na",
          "Google Chrome",
          "--args",
          `--user-data-dir=${profileSelection.userDataDir}`,
          `--profile-directory=${profileSelection.profileDirectory}`,
        ],
        `Failed to open Chrome profile '${profileSelection.profileDirectory}'`, budget
      );

      await this.openUrlInFrontChromeTabOnMac(url, budget);

      throw new Error(
        `Interactive login required: Chrome profile '${profileSelection.profileDirectory}' has been opened with ${profileSelection.source} user-data-dir. Please login to uscardforum in that window, then retry.`
      );
    });
  }
}
