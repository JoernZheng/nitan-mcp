import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools, type RegistryOptions } from "./tools/registry.js";
import type { SiteState } from "./site/state.js";
import type { Logger } from "./util/logger.js";

/** HTTP requests own their MCP server; site clients/auth remain shared. */
export async function createNitanServer(siteState: SiteState, logger: Logger, version: string, options: RegistryOptions & { maxReadLength?: number }) {
  const server = new McpServer({ name: "@nitansde/mcp", version }, { capabilities: { tools: { listChanged: false } } });
  await registerAllTools(server, siteState, logger, options);
  return server;
}
