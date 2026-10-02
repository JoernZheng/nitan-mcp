import type { RegisterFn } from "./types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../util/logger.js";
import type { SiteState } from "../site/state.js";
import { registerSearch } from "./builtin/search.js";
import { registerReadTopic } from "./builtin/read_topic.js";
import { registerSelectSite } from "./builtin/select_site.js";
import { registerListUserPosts } from "./builtin/list_user_posts.js";
import { registerListHotTopics } from "./builtin/list_hot_topics.js";
import { registerListNotifications } from "./builtin/list_notifications.js";
import { registerListTopTopics } from "./builtin/list_top_topics.js";
import { registerListExcellentTopics } from "./builtin/list_excellent_topics.js";
import { registerListFunnyTopics } from "./builtin/list_funny_topics.js";
import { registerGetTrustLevelProgress } from "./builtin/get_trust_level_progress.js";

export const READ_TOOL_CATALOG = [
  { name: "discourse_search", register: registerSearch },
  { name: "discourse_read_topic", register: registerReadTopic },
  { name: "discourse_get_user_activity", register: registerListUserPosts },
  { name: "discourse_list_hot_topics", register: registerListHotTopics },
  { name: "discourse_list_notifications", register: registerListNotifications },
  { name: "discourse_list_top_topics", register: registerListTopTopics },
  { name: "discourse_list_excellent_topics", register: registerListExcellentTopics },
  { name: "discourse_list_funny_topics", register: registerListFunnyTopics },
  { name: "discourse_get_trust_level_progress", register: registerGetTrustLevelProgress },
] as const satisfies readonly { name: string; register: RegisterFn }[];

export interface RegistryOptions {
  allowWrites?: boolean;
  // When true, do not register the discourse_select_site tool
  hideSelectSite?: boolean;
  // Optional default search prefix to add to all searches
  defaultSearchPrefix?: string;
}

export async function registerAllTools(
  server: McpServer,
  siteState: SiteState,
  logger: Logger,
  opts: RegistryOptions & { maxReadLength?: number }
) {
  const ctx = { siteState, logger, defaultSearchPrefix: opts.defaultSearchPrefix, maxReadLength: opts.maxReadLength ?? 50000 } as const;

  // Built-in tools
  if (!opts.hideSelectSite) {
    await registerSelectSite(server, ctx, {});
  }
  for (const tool of READ_TOOL_CATALOG) {
    await tool.register(server, ctx, { allowWrites: false });
  }
}
