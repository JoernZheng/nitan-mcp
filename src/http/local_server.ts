import type { IncomingMessage, ServerResponse } from "node:http";

export const LOOPBACK_HOST = "127.0.0.1";
export const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;
export const HTTP_BODY_TIMEOUT_MS = 15000;
export const HTTP_SHUTDOWN_GRACE_MS = 2000;
export const allowedHttpHosts = (port: number) => [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
export const allowedHttpOrigins = (port: number) => allowedHttpHosts(port).map(host => `http://${host}`);

export class HttpInputError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = -32000) { super(message); }
}

export function validateLocalHeaders(req: IncomingMessage, port: number): void {
  const count = (name: string) => req.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === name).length;
  if (count("host") !== 1 || !req.headers.host || !allowedHttpHosts(port).includes(req.headers.host)) {
    throw new HttpInputError(403, "Invalid local Host header");
  }
  if (req.headers.origin !== undefined && (count("origin") !== 1 || !allowedHttpOrigins(port).includes(req.headers.origin))) {
    throw new HttpInputError(403, "Invalid local Origin header");
  }
}

export function rejectHttpRequest(res: ServerResponse, error: HttpInputError, mcp = false): void {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(error.status, { "Content-Type": "application/json", "Connection": "close" });
  res.end(JSON.stringify(mcp ? { jsonrpc: "2.0", id: null, error: { code: error.code, message: error.message } } : { status: "error", message: error.message }));
}

/** Bounded bytes and upload time, shared by MCP and manual auth POSTs. */
export async function readJsonBody(req: IncomingMessage, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
  const body = await new Promise<string>((resolve, reject) => {
    let bytes = 0, settled = false;
    const chunks: Buffer[] = [];
    const ignoreError = () => {};
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", shutdown);
      req.removeListener("data", data); req.removeListener("end", end);
      req.removeListener("aborted", aborted); req.removeListener("error", failed); req.removeListener("close", closed);
    };
    const finish = (error?: HttpInputError) => {
      if (settled) return; settled = true; cleanup();
      if (error) {
        req.pause();
        // A reset upload emits aborted then error. The reader is already
        // rejected, but the subsequent stream error must remain observed.
        if (!req.closed) { req.once("error", ignoreError); req.once("close", () => req.removeListener("error", ignoreError)); }
        reject(error);
      } else resolve(Buffer.concat(chunks, bytes).toString("utf8"));
    };
    const data = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_HTTP_BODY_BYTES) { finish(new HttpInputError(413, "Request body exceeds 4 MiB")); return; }
      chunks.push(buffer);
    };
    const end = () => finish();
    const aborted = () => finish(new HttpInputError(400, "Request body was aborted"));
    const failed = () => finish(new HttpInputError(400, "Request body could not be read"));
    const closed = () => { if (!req.complete) aborted(); };
    const shutdown = () => finish(new HttpInputError(503, "HTTP server is stopping"));
    const timer = setTimeout(() => finish(new HttpInputError(408, "Request body upload timed out")), options.timeoutMs ?? HTTP_BODY_TIMEOUT_MS);
    req.on("data", data); req.once("end", end); req.once("aborted", aborted); req.once("error", failed); req.once("close", closed);
    options.signal?.addEventListener("abort", shutdown, { once: true });
    const length = req.headers["content-length"];
    if (options.signal?.aborted) shutdown();
    else if (length && Number(length) > MAX_HTTP_BODY_BYTES) finish(new HttpInputError(413, "Request body exceeds 4 MiB"));
  });
  if (!body) return undefined;
  try { return JSON.parse(body); }
  catch { throw new HttpInputError(400, "Parse error: invalid JSON", -32700); }
}
