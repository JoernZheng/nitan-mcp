import { getCategoryName } from './categories.js';
import { formatTimestamp } from '../util/timestamp.js';
import { resolveSiteUrl } from '../util/site_url.js';

/** One bounded endpoint page/window, shared by the two existing list tools. */
export function topicListResult(base: string, data: any, kind: 'hot' | 'top', page: number, offset: number, limit: number, period?: string) {
  const list = data?.topic_list ?? data;
  const all: any[] = Array.isArray(list?.topics) ? list.topics : [];
  const selected = all.slice(offset, offset + limit);
  const topics = selected.map(topic => ({
    id: topic.id, title: topic.title || topic.fancy_title || `Topic ${topic.id}`,
    url: `${base}/t/${topic.slug || topic.id}/${topic.id}`,
    views: topic.views ?? 0, posts_count: topic.posts_count ?? 0, like_count: topic.like_count ?? 0,
    category: topic.category_id ? topic.category_name || getCategoryName(topic.category_id) : undefined,
    tags: (Array.isArray(topic.tags) ? topic.tags : []).map((tag: any) => typeof tag === 'string' ? tag : tag?.name ?? tag?.text).filter((tag: any) => typeof tag === 'string'),
    created_at: String(topic.created_at || ''), last_posted_at: String(topic.last_posted_at || ''), pinned: Boolean(topic.pinned),
  }));
  const localMore = offset + selected.length < all.length;
  let nextPage: number | null = localMore ? page : null;
  let nextOffset: number | null = localMore ? offset + selected.length : null;
  const serverMore = typeof list?.more_topics_url === 'string' && list.more_topics_url.length > 0;
  if (!localMore && serverMore) {
    try {
      const url = new URL(resolveSiteUrl(base, list.more_topics_url));
      const value = url.searchParams.get('page');
      const n = value === null ? NaN : Number(value);
      if (Number.isSafeInteger(n) && n > page && n <= 20) { nextPage = n; nextOffset = 0; }
    } catch { /* An untrusted/off-base continuation is not followed. */ }
  }
  const hasMore = localMore || serverMore ? true : list?.more_topics_url === null ? false : null;
  return {
    content: [{ type: 'text' as const, text: topics.length ? JSON.stringify(topics.map(({ last_posted_at, pinned, ...topic }) => ({ ...topic, created_at: formatTimestamp(topic.created_at) })), null, 2) : `No ${kind} topics found${period ? ` for period: ${period}` : ''}.` }],
    structuredContent: { site: base, topics, captured_at: new Date().toISOString(),
      pagination: { request_count: 1, returned_count: topics.length, available_count: all.length,
        truncated: localMore, has_more: hasMore, next_page: nextPage, next_offset: nextOffset,
        page, offset, coverage: `${kind}_endpoint_page`, ...(period ? { period } : {}) } },
  };
}
