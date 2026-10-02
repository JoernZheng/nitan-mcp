export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: unknown, public retryAfterMs?: number) {
    super(message);
    this.name = "HttpError";
  }
}

export class RateLimitError extends HttpError {
  declare retryAfterMs: number;
  constructor(status: number, retryAfterMs: number, body?: unknown) {
    super(status, `Rate limited. Retry after ${Math.ceil(retryAfterMs / 1000)} seconds.`, body, retryAfterMs);
    this.name = "RateLimitError";
  }
}
