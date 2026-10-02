import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequestBudget, cancellationError, throwIfAborted } from "./request_budget.js";

export interface PythonRequest {
  url: string;
  site_base?: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  cookies?: Record<string, string>;
  timeout?: number;
  login?: { username: string; password: string; second_factor_token?: string };
}
export interface PythonResponse {
  success: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  cookies?: Record<string, string>;
  csrf_token?: string;
  message?: string;
  error?: string;
  error_type?: string;
  explicit_request_count?: number;
  warmup_request_count?: number;
}

export function resolvePythonScript(name: string): string {
  const directory = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(directory, name), join(directory, "../../src/http", name)]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${name} is missing from the package`);
}

/** Resolve/reject only after the child is closed, including cancellation. */
export async function runPythonRequest(pythonPath: string, scriptPath: string, request: PythonRequest, options: { signal?: AbortSignal } = {}): Promise<PythonResponse> {
  const budget = createRequestBudget((request.timeout ?? 30) * 1000, options.signal);
  const signal = budget.signal;
  try {
    throwIfAborted(signal);
    return await new Promise<PythonResponse>((resolve, reject) => {
      const child = spawn(pythonPath, [scriptPath]);
      let stdout = "", stderr = "";
      let stdoutBytes = 0;
      let failure: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        failure = cancellationError(signal);
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 250);
      };
      const fail = (message: string) => {
        failure ??= new Error(message);
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 250);
      };
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        if (failure) return;
        const text = String(chunk);
        stdoutBytes += Buffer.byteLength(text);
        if (stdoutBytes > 64 * 1024 * 1024) { fail("Python response exceeds 64 MiB"); return; }
        stdout += text;
      });
      child.stderr.on("data", chunk => { if (stderr.length < 65536) stderr += String(chunk).slice(0, 65536 - stderr.length); });
      child.on("error", () => { failure ??= new Error("Python runtime could not be started"); });
      child.stdin.on("error", () => fail("Python request input failed"));
      child.on("close", code => {
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", stop);
        try { budget.remainingMs(); } catch { reject(cancellationError(signal)); return; }
        if (signal?.aborted) { reject(cancellationError(signal)); return; }
        if (failure) { reject(failure); return; }
        if (!stdout) {
          reject(new Error(/ModuleNotFoundError|ImportError/.test(stderr) ? "Python dependencies missing; install requirements.txt" : `Python backend produced no JSON (exit ${code})`));
          return;
        }
        try {
          const result = JSON.parse(stdout) as PythonResponse;
          if (!result || typeof result !== "object" || typeof result.success !== "boolean") throw new Error("shape");
          resolve(result);
        } catch { reject(new Error("Invalid Python response JSON")); }
      });
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      else {
        try { child.stdin.end(JSON.stringify(request)); }
        catch { fail("Python request input failed"); }
      }
    });
  } finally { budget.close(); }
}
