import { resolveSiteUrl } from '../util/site_url.js';

export type Attachment = { reference: string; kind: 'image' | 'file'; url?: string };
export type Quote = { topic_id: number; post_number: number; url: string };
export function postEvidence(content: string, base: string, topicId: number, number: number) {
  const attachments: Attachment[] = [];
  for (const match of content.matchAll(/(!?)\[[^\]\n]*\]\((upload:\/\/[^\s)]+)\)/g)) {
    const reference = match[2];
    if (attachments.some(a => a.reference === reference)) continue;
    const token = reference.slice('upload://'.length);
    attachments.push({ reference, kind: match[1] ? 'image' : 'file',
      ...(/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(token) ? { url: resolveSiteUrl(base, `/uploads/short-url/${token}`) } : {}) });
  }
  const quotedPosts: Quote[] = [];
  for (const match of content.matchAll(/\[quote=([^\]]+)\]/g)) {
    const n = Number(match[1].match(/\bpost:(\d+)/)?.[1]);
    const id = Number(match[1].match(/\btopic:(\d+)/)?.[1] ?? topicId);
    if (!Number.isSafeInteger(n) || n < 1 || !Number.isSafeInteger(id) || id < 1 || quotedPosts.some(q => q.topic_id === id && q.post_number === n)) continue;
    quotedPosts.push({ topic_id: id, post_number: n, url: `${base}/t/topic/${id}/${n}` });
  }
  return { url: `${base}/t/topic/${topicId}/${number}`, attachments, quoted_posts: quotedPosts };
}
