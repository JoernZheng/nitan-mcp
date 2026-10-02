/** Stable machine error hints; never include backend bodies or credentials. */
export function toolErrorMetadata(error: any) {
  const retry = error?.retryAfterMs;
  return { error: {
    kind: error?.name === "RateLimitError" ? "rate_limit" : error?.name === "AbortError" ? "cancelled" : error?.name === "TimeoutError" ? "timeout" : "request_failed",
    ...(Number.isFinite(error?.status) ? { status: error.status } : {}),
    ...(typeof retry === "number" && Number.isFinite(retry) && retry >= 0 ? { retry_after_ms: retry } : {}),
  } };
}
