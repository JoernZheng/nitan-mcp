import { toolErrorMetadata } from '../result.js';
import { createToolRequest } from '../request.js';
import { throwIfAborted } from '../../http/request_budget.js';
import { z } from 'zod';
import type { RegisterFn } from '../types.js';
import { topicListResult } from '../topic_list.js';

export const registerListHotTopics: RegisterFn = (server, ctx) => {
  const schema = z.object({
    limit: z.number().int().min(1).max(50).optional().describe('Maximum number of hot topics to return (default: 10, max: 50)'),
    page: z.number().int().min(0).max(20).optional().describe('Endpoint page (default 0); use returned next_page'),
    offset: z.number().int().min(0).max(10000).optional().describe('Offset within this page (default 0); use returned next_offset'),
  }).strict();
  server.registerTool('discourse_list_hot_topics', {
    title: 'List Hot Topics', description: 'Get current hot/trending topics. Each call covers one bounded endpoint page/window; continuation is explicit.', inputSchema: schema.shape,
  }, async ({ limit = 10, page = 0, offset = 0 }, extra: any) => {
    try {
      throwIfAborted(extra?.signal);
      const { base, client } = ctx.siteState.ensureSelectedSite();
      const data = await createToolRequest(client, extra?.signal)(`/hot.json${page ? `?page=${page}` : ''}`);
      return topicListResult(base, data, 'hot', page, offset, limit);
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Failed to fetch hot topics: ${e?.message || String(e)}` }], isError: true, structuredContent: toolErrorMetadata(e) };
    }
  });
};
