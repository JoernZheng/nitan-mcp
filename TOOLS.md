# Tool reference

The CLI defaults to uscardforum.com and exposes nine read-only tools.
Untethered programmatic registration can add `discourse_select_site`; simply
omitting the CLI site flag does not untether it. The running schema is canonical;
disabled source files are not available tools.

## Discovery

```json
{"name":"discourse_list_hot_topics","arguments":{"limit":10,"page":0,"offset":0}}
{"name":"discourse_list_top_topics","arguments":{"period":"daily","limit":10}}
{"name":"discourse_search","arguments":{"query":"Hyatt","after":"2026-10-01","before":"2026-10-02","max_results":10,"order":"latest"}}
```

Hot/Top limits are 1–50; page is 0–20 and offset is within the endpoint page.
Follow returned `next_page`/`next_offset`, including local remainder. Top supports
`daily`, `weekly`, `monthly`, `quarterly`, `yearly`, `all`; daily ranking does
not guarantee a local calendar-day window. Search supports `category`, `author`,
`after`, `before`, `order` and `max_results` (1–50, default 50).
It covers one endpoint page. No `with_private` input is implemented.

## Topic reading

```json
{"name":"discourse_read_topic","arguments":{"topic_id":12345,"post_limit":300,"start_post_number":1,"output_format":"compact","max_response_bytes":262144}}
```

`post_limit`: 1–500, default 90. `username_filter` optionally restricts authors.
`output_format` is `full` (default) or `compact`; both retain structured posts.
`max_response_bytes` is 4,096–4,194,304, default 262,144. Each call is limited to
32 logical requests; deleted floors and byte limits can reduce returned posts.

Use `structuredContent.posts` for post bodies, floor URLs, attachments and quote
references. `pagination.next_post_number` advances only past consumed posts.
`complete`, `has_more` and `stop_reason` describe the requested range.
Raw headers supply edit times, not creation times; unknown creation dates remain
unknown. Inspect body truncation and coverage. Attachments are not reviewed.
An `isError` result can contain safely consumed posts/cursor plus retry metadata;
save that progress and stop before another request.

## Other read tools

| Tool | Common inputs |
| --- | --- |
| `discourse_get_user_activity` | `username`, `page` (zero-based, 30 posts/page) |
| `discourse_list_notifications` | `limit`, `unread_only`; configured authentication |
| `discourse_get_trust_level_progress` | `username` |
| `discourse_list_excellent_topics` | `limit` |
| `discourse_list_funny_topics` | `limit` |

For bulk acquisition use the persistent collector and local chunks described
in [README.md](README.md). No write, admin, remote-discovery, `read_post`,
`get_user` or `filter_topics` tools are registered.
