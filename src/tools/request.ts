import type { HttpClient } from "../http/client.js";
import { throwIfAborted } from "../http/request_budget.js";

/** Propagate MCP cancellation and reject late results before another page. */
export function createToolRequest(client: Pick<HttpClient, "get">, signal?: AbortSignal) {
  throwIfAborted(signal);
  return async (path: string) => {
    throwIfAborted(signal);
    const value = await client.get(path, { signal });
    throwIfAborted(signal);
    return value;
  };
}
