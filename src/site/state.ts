import { normalizeSiteBase, sameSite } from "../util/site_url.js";
import type { Logger } from "../util/logger.js";
import { HttpClient, type AuthMode, type BypassMethod } from "../http/client.js";
import type { BrowserFallbackOptions } from "../http/browser_fallback.js";

export type AuthOverride = {
  site: string; // exact normalized forum base, including its subdirectory
  api_key?: string;
  api_username?: string;
  user_api_key?: string;
  user_api_client_id?: string;
  username?: string; // Username for login (used with cloudscraper)
  password?: string; // Password for login (used with cloudscraper)
  second_factor_token?: string; // 2FA token (used with cloudscraper)
};

/** Merge URL variants once, preserving API and login fields; later fields win. */
export function normalizeAuthOverrides(overrides: AuthOverride[]): AuthOverride[] {
  const merged: AuthOverride[] = [];
  for (const override of overrides) {
    const index = merged.findIndex(existing => sameSite(existing.site, override.site));
    const item = { ...override, site: sameSite(override.site, override.site) ? normalizeSiteBase(override.site) : override.site };
    if (index < 0) merged.push(item);
    else merged[index] = { ...merged[index], ...item };
  }
  return merged;
}

export class SiteState {
  private currentSiteBase?: string;
  private currentClient?: HttpClient;
  private readonly clientCache = new Map<string, HttpClient>();
  private readonly retiringClients = new Set<Promise<void>>();
  private disposed = false;
  private closing?: Promise<void>;

  constructor(
    private opts: {
      logger: Logger;
      timeoutMs: number;
      requestIntervalMs?: number;
      defaultAuth: AuthMode;
      authOverrides?: AuthOverride[];
      bypassMethod?: BypassMethod;
      useCloudscraper?: boolean; // Deprecated, use bypassMethod instead
      pythonPath?: string;
      browserFallback?: BrowserFallbackOptions;
    }
  ) {
    this.opts.authOverrides = normalizeAuthOverrides(opts.authOverrides ?? []);
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error("Site state has been disposed");
  }

  private invalidateClient(base: string): void {
    const client = this.clientCache.get(base);
    this.clientCache.delete(base);
    if (this.currentSiteBase === base) { this.currentSiteBase = undefined; this.currentClient = undefined; }
    if (client) {
      const retiring = client.dispose().catch(() => this.opts.logger.error("Retired site client cleanup failed"))
        .finally(() => this.retiringClients.delete(retiring));
      this.retiringClients.add(retiring);
    }
  }

  getSiteBase(): string | undefined {
    return this.currentSiteBase;
  }

  ensureSelectedSite(): { base: string; client: HttpClient } {
    this.ensureActive();
    if (!this.currentSiteBase || !this.currentClient) {
      throw new Error("No site selected. Call discourse_select_site first.");
    }
    return { base: this.currentSiteBase, client: this.currentClient };
  }

  buildClientForSite(siteUrl: string): { base: string; client: HttpClient } {
    this.ensureActive();
    const base = normalizeSiteBase(siteUrl);
    const cached = this.clientCache.get(base);
    if (cached) return { base, client: cached };

    const auth = this.resolveAuthForSite(base);
    const loginCreds = this.resolveLoginForSite(base);
    
    // Determine bypass method (support legacy useCloudscraper option)
    let bypassMethod: BypassMethod | undefined = this.opts.bypassMethod;
    if (bypassMethod === undefined && this.opts.useCloudscraper !== undefined) {
      // Legacy support: useCloudscraper=true => "both" for better reliability
      bypassMethod = this.opts.useCloudscraper ? "both" : undefined;
    }
    
    const client = new HttpClient({
      baseUrl: base,
      timeoutMs: this.opts.timeoutMs,
      requestIntervalMs: this.opts.requestIntervalMs,
      logger: this.opts.logger,
      auth,
      bypassMethod,
      pythonPath: this.opts.pythonPath,
      loginCredentials: loginCreds,
      browserFallback: this.opts.browserFallback,
    } as any);
    this.clientCache.set(base, client);
    return { base, client };
  }

  selectSite(siteUrl: string): { base: string; client: HttpClient } {
    const { base, client } = this.buildClientForSite(siteUrl);
    this.currentSiteBase = base;
    this.currentClient = client;
    return { base, client };
  }

  hasAuthForSite(siteUrl: string): boolean {
    const base = normalizeSiteBase(siteUrl);
    return this.resolveAuthForSite(base).type !== "none";
  }

  hasLoginForSite(siteUrl: string): boolean {
    const base = normalizeSiteBase(siteUrl);
    return Boolean(this.resolveLoginForSite(base));
  }

  hasAuthenticationConfiguredForSite(siteUrl: string): boolean {
    return this.hasAuthForSite(siteUrl) || this.hasLoginForSite(siteUrl);
  }

  // Update only this exact forum; preserve its configured login rescue fields.
  updateAuthOverride(override: AuthOverride): void {
    this.ensureActive();
    const base = normalizeSiteBase(override.site);
    const overrides = this.opts.authOverrides!;
    const index = overrides.findIndex(existing => sameSite(existing.site, base));
    if (index < 0) overrides.push({ ...override, site: base });
    else overrides[index] = { ...overrides[index], ...override, site: base };
    this.invalidateClient(base);
  }

  removeAuthOverride(siteUrl: string): void {
    this.ensureActive();
    const base = normalizeSiteBase(siteUrl);
    this.opts.authOverrides = this.opts.authOverrides!.filter(override => !sameSite(override.site, base));
    this.invalidateClient(base);
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    const clients = [...new Set(this.clientCache.values())];
    this.clientCache.clear(); this.currentSiteBase = undefined; this.currentClient = undefined;
    this.closing = Promise.allSettled([...clients.map(client => client.dispose()), ...this.retiringClients]).then(() => undefined);
    return this.closing;
  }

  private resolveAuthForSite(base: string): AuthMode {
    const overrides = this.opts.authOverrides || [];
    const match = overrides.find((o) => sameSite(o.site, base));
    if (match) {
      // Prefer user_api_key if provided
      if (match.user_api_key) return { type: "user_api_key", key: match.user_api_key, client_id: match.user_api_client_id };
      if (match.api_key) return { type: "api_key", key: match.api_key, username: match.api_username };
    }
    return this.opts.defaultAuth;
  }

  private resolveLoginForSite(base: string): { username: string; password: string; second_factor_token?: string } | undefined {
    const overrides = this.opts.authOverrides || [];
    const match = overrides.find((o) => sameSite(o.site, base));
    if (match?.username && match?.password) {
      return {
        username: match.username,
        password: match.password,
        second_factor_token: match.second_factor_token,
      };
    }
    return undefined;
  }


}

export type SiteStateInit = ConstructorParameters<typeof SiteState>[0];
