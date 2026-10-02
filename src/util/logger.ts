import { randomUUID } from 'node:crypto';

export type LogLevel = "silent" | "error" | "info" | "debug";

type EventName = "server.started" | "http.request.started" | "http.request.completed" | "http.request.failed" | "http.rate_limited" | "http.backend.started" | "http.backend.completed" | "http.backend.failed" | "topic.read.completed" | "topic.read.failed" | "collection.completed";
type EventFields = Record<string, unknown>;
const eventNames = new Set<EventName>(["server.started", "http.request.started", "http.request.completed", "http.request.failed", "http.rate_limited", "http.backend.started", "http.backend.completed", "http.backend.failed", "topic.read.completed", "topic.read.failed", "collection.completed"]);
const numericFields = new Set(["status", "duration_ms", "queue_ms", "retry_after_ms", "request_count", "result_count", "attempt", "pages", "bytes", "backend_attempts", "explicit_request_count", "warmup_request_count", "request_interval_ms", "mcp_calls"]);
const enumFields: Record<string, Set<string>> = {
  backend: new Set(["native", "cloudscraper", "curl_cffi", "browser"]),
  auth_strategy: new Set(['anonymous', 'login_credentials', 'api_key', 'user_api_key']),
  method: new Set(["GET", "POST", "PUT", "DELETE", "HEAD"]),
  outcome: new Set(["ok", "error", "cancelled", "rate_limited", "partial"]),
  reason: new Set(["request_budget", "positioning_budget", "no_progress", "highest", "limit", "empty", "transport_unavailable", "invalid_response", "cancelled", "complete", "preview", "call_budget", "topic_budget", "time_budget", "output_budget", "cooldown", "rate_limit", "tool_error", "collection_error", "unconfirmed_tail"]),
};

function safeFields(fields: EventFields) {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (numericFields.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) safe[key] = Math.round(value);
      else if (typeof value === "string" && enumFields[key]?.has(value)) safe[key] = value;
      else if ((key === "complete" || key === "explicit_request_count_known") && typeof value === "boolean") safe[key] = value;
      else if (key === 'build_id' && typeof value === 'string' && /^(?:[0-9a-f]{12}(?:-dirty)?|unknown)$/.test(value)) safe[key] = value;
      else if (key === "request_id" && typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value)) safe[key] = value;
      else if (key === "site_id" && typeof value === "string" && /^[0-9a-f]{12}$/.test(value)) safe[key] = value;
    }
    return safe;
}

/** Keep only our bounded, allowlisted event format in a collector event file. */
export function eventLine(line: string, runId: string): string | undefined {
  if (line.length > 8192) return;
  try {
    const data = JSON.parse(line);
    if (!eventNames.has(data.event) || data.run_id !== runId || !['info','error','debug'].includes(data.level) || typeof data.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(data.time)) return;
    return JSON.stringify({ time: data.time, level: data.level, run_id: runId, event: data.event, ...safeFields(data) }) + '\n';
  } catch { return; }
}

export class Logger {
  private levelOrder: Record<LogLevel, number> = {
    silent: 0,
    error: 1,
    info: 2,
    debug: 3,
  };
  readonly runId: string;
  constructor(private level: LogLevel = "info", runId?: string, private eventSink?: (line: string) => void) {
    const supplied = runId ?? process.env.NITAN_RUN_ID;
    this.runId = typeof supplied === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(supplied) ? supplied : randomUUID();
  }

  setLevel(level: LogLevel) {
    this.level = level;
  }

  error(msg: string, meta?: unknown) {
    if (this.levelOrder[this.level] >= 1) {
      this.write("ERROR", msg, meta);
    }
  }

  info(msg: string, meta?: unknown) {
    if (this.levelOrder[this.level] >= 2) {
      this.write("INFO", msg, meta);
    }
  }

  debug(msg: string, meta?: unknown) {
    if (this.levelOrder[this.level] >= 3) {
      this.write("DEBUG", msg, meta);
    }
  }

  /** Structured, allowlisted operational events. Never pass input/response text. */
  event(name: EventName, fields: EventFields = {}, level: "error" | "info" | "debug" = "info") {
    if (!eventNames.has(name) || this.levelOrder[this.level] < this.levelOrder[level]) return;
    const safe = safeFields(fields);
    const line = JSON.stringify({ time: new Date().toISOString(), level, run_id: this.runId, event: name, ...safe }) + "\n";
    this.eventSink?.(line);
    process.stderr.write(line);
  }

  private write(level: string, msg: string, meta?: unknown) {
    const line = meta ? `${msg} ${safeJson(meta)}` : msg;
    // Log to stderr per spec
    process.stderr.write(`[${new Date().toISOString()}] ${level} ${line}\n`);
  }
}

function safeJson(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return "<unserializable>";
  }
}

