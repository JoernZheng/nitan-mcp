import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createNitanServer } from "../server.js";
import { SiteState } from "../site/state.js";
import { Logger } from "../util/logger.js";

test("real stdio SDK preserves tools and recognizes handler/input errors", async () => {
  const home = await mkdtemp(join(tmpdir(), "nitan-sdk-stdio-"));
  const client = new Client({ name: "stdio-proof", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../index.js", import.meta.url)), "--auth_pairs=[]", "--browser-fallback-enabled=false", "--interactive-login-enabled=false", "--log_level=silent"],
    env: { PATH: process.env.PATH ?? "", HOME: home },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 9);
    assert.ok(tools.tools.every(t => !/create|delete|reply|admin/.test(t.name)));
    const error = await client.callTool({ name: "discourse_list_notifications", arguments: {} });
    assert.equal(error.isError, true);
    const invalid = await client.callTool({ name: "discourse_read_topic", arguments: { topic_id: -1 } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); await rm(home, { recursive: true, force: true }); }
});

test("fresh HTTP servers keep overlapping SDK request IDs isolated", async () => {
  const logger = new Logger("silent");
  const state = new SiteState({ logger, timeoutMs: 1000, defaultAuth: { type: "none" } });
  const selected = state.selectSite("https://offline.invalid");
  const paths: string[] = [];
  selected.client.get = async (path: string) => {
    paths.push(path);
    const id = Number(path.match(/\/(?:t|raw)\/(\d+)/)?.[1]);
    await new Promise(resolve => setTimeout(resolve, id === 1 ? 10 : 1));
    if (path.startsWith("/t/")) return { title: `Topic${id}`, highest_post_number: 1 };
    if (path.startsWith("/raw/")) return `alice | 2026-01-01T00:00:00Z | #1\n\nBody${id}\n\n-------------------------\n`;
    throw new Error("unexpected mock path");
  };
  const http = createServer(async (req, res) => {
    const server = await createNitanServer(state, logger, "test", { hideSelectSite: true });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once("close", () => { void server.close().catch(() => {}); });
    try {
      let body = ""; for await (const chunk of req) body += String(chunk);
      await server.connect(transport);
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch { if (!res.headersSent) { res.writeHead(500); res.end(); } }
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address(); assert.ok(address && typeof address !== "string");
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const a = new Client({ name: "a", version: "1" }), b = new Client({ name: "b", version: "1" });
  try {
    await Promise.all([a.connect(new StreamableHTTPClientTransport(endpoint)), b.connect(new StreamableHTTPClientTransport(endpoint))]);
    const [one, two] = await Promise.all([
      a.callTool({ name: "discourse_read_topic", arguments: { topic_id: 1 } }),
      b.callTool({ name: "discourse_read_topic", arguments: { topic_id: 2 } }),
    ]);
    assert.match(JSON.stringify(one.content), /Topic1.*Body1/);
    assert.doesNotMatch(JSON.stringify(one.content), /Topic2|Body2/);
    assert.match(JSON.stringify(two.content), /Topic2.*Body2/);
    assert.doesNotMatch(JSON.stringify(two.content), /Topic1|Body1/);
    assert.equal(paths.length, 4);
    assert.equal((await a.listTools()).tools.length, 9);
  } finally {
    await Promise.all([a.close(), b.close()]);
    await new Promise<void>(resolve => http.close(() => resolve()));
    await state.dispose();
  }
});
