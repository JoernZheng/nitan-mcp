const sensitiveFields = new Set([
  "password", "username", "api_username", "api_key", "user_api_key",
  "user_api_client_id", "second_factor_token", "authorization", "cookie",
  "set_cookie", "csrf_token", "x_csrf_token", "payload", "default_search",
]);

export function redactSecrets(input: string): string {
  return input.replace(/(Api-Key|User-Api-Key|Authorization):\s*([^\s]+)/gi, "$1: <redacted>");
}

export function redactObject(obj: unknown): unknown {
  try {
    const json = JSON.stringify(obj, (key, value) => {
      const normalized = key.toLowerCase().replace(/-/g, "_");
      if (sensitiveFields.has(normalized)) return "<redacted>";
      if (["site", "url", "site_base"].includes(normalized) && typeof value === "string") {
        try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); } catch { return "<redacted>"; }
      }
      return value;
    });
    return json === undefined ? "<unserializable>" : JSON.parse(redactSecrets(json));
  } catch { return "<unserializable>"; }
}
