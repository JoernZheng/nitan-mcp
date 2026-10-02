/** Canonical forum base, including an optional installation subdirectory. */
export function normalizeSiteBase(site: string): string {
  let url: URL;
  try { url = new URL(site); } catch { throw new Error("Invalid site URL"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Site URL must use HTTP(S) without embedded credentials");
  url.search = ""; url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

export function sameSite(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  try { return normalizeSiteBase(a) === normalizeSiteBase(b); } catch { return false; }
}

export function isUrlWithinSite(target: string, site: string): boolean {
  try {
    const url = new URL(target), base = new URL(normalizeSiteBase(site));
    const prefix = base.pathname === "/" ? "" : base.pathname;
    return !url.username && !url.password && url.origin === base.origin &&
      (url.pathname === prefix || url.pathname.startsWith(prefix + "/"));
  } catch { return false; }
}

/** Leading API slashes are relative to the forum, not the domain root. */
export function resolveSiteUrl(site: string, path: string): string {
  const base = normalizeSiteBase(site);
  const url = /^[a-z][a-z\d+.-]*:/i.test(path) ? new URL(path) : new URL(path.replace(/^\/+/, ""), base + "/");
  if (!isUrlWithinSite(url.toString(), base)) throw new Error("Request URL is outside the configured site");
  url.hash = "";
  return url.toString();
}
