export function cancellationError(signal?: AbortSignal): DOMException {
  return signal?.reason?.name === "TimeoutError"
    ? new DOMException("Request deadline exceeded", "TimeoutError")
    : new DOMException("Request cancelled", "AbortError");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError(signal);
}

export type RequestBudget = ReturnType<typeof createRequestBudget>;

/** One logical HTTP request, including queueing and backend fallback. */
export function createRequestBudget(timeoutMs: number, external?: AbortSignal, controller = new AbortController()) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error("Invalid request timeout");
  const deadline = Date.now() + timeoutMs;
  const abort = () => controller.abort(cancellationError(external));
  if (external?.aborted) abort();
  else external?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Request deadline exceeded", "TimeoutError")), timeoutMs);
  return {
    signal: controller.signal,
    remainingMs() {
      if (Date.now() >= deadline && !controller.signal.aborted) controller.abort(new DOMException("Request deadline exceeded", "TimeoutError"));
      throwIfAborted(controller.signal);
      return Math.max(1, deadline - Date.now());
    },
    close() { clearTimeout(timer); external?.removeEventListener("abort", abort); },
  };
}
