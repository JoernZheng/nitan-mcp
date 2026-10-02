import { toolErrorMetadata } from '../result.js';
import { createToolRequest } from '../request.js';
import { throwIfAborted } from '../../http/request_budget.js';
import { z } from 'zod';
import type { RegisterFn } from '../types.js';
import { topicListResult } from '../topic_list.js';

export const registerListTopTopics: RegisterFn = (server, ctx) => {
  const schema = z.object({
    period: z.enum(['daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'all']).optional().describe('Ranking period; daily is an endpoint ranking window, not a guaranteed local calendar day. Default daily'),
    limit: z.number().int().min(1).max(50).optional().describe('Maximum number of top topics to return (default: 10, max: 50)'),
    page: z.number().int().min(0).max(20).optional().describe('Endpoint page (default 0); use returned next_page'),
    offset: z.number().int().min(0).max(10000).optional().describe('Offset within page (default 0); use returned next_offset'),
  }).strict();
  server.registerTool('discourse_list_top_topics', {
    title: 'List Top Topics', description: 'Get ranked top topics for a period, using the Top endpoint. Each call covers one bounded page/window.', inputSchema: schema.shape,
  }, async ({ period = 'daily', limit = 10, page = 0, offset = 0 }, extra: any) => {
    try {
      throwIfAborted(extra?.signal);
      const { base, client } = ctx.siteState.ensureSelectedSite();
      const data = await createToolRequest(client, extra?.signal)(`/top.json?period=${period}${page ? `&page=${page}` : ''}`);
      return topicListResult(base, data, 'top', page, offset, limit, period);
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Failed to fetch top topics: ${e?.message || String(e)}` }], isError: true, structuredContent: toolErrorMetadata(e) };
    }
  });
};
