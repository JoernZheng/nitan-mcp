# Efficient forum reading

## Measured result

A bounded comparison on 2026-10-01 used a confirmed Cookie-login session and
an isolated anonymous session, Node 22/SDK 1.30.0. It checked actual identity in
memory and saved only safe metrics. This was not a User API key comparison.

| Workload | Login | Anonymous |
| --- | --- | --- |
| Serial reads,500 ms pacing |240 public requests/121.5 s, no limits|240/120.8 s, no limits|
| Three parallel tool calls |80 public requests/40.2 s|80/40.1 s|
| Distinct searches,1,250 ms pacing |20 succeeded|15 succeeded;16 th returned 429 and stopped|

Serial workloads repeated Hot, Daily Top and three compact topic reads for two
minutes. Parallel calls reused the same session and HTTP queue. Startup probes
and login bootstrap are excluded from public request counts but included in
serial elapsed time. Repeated post returns are workload volume, not unique posts;
server/CDN caching may differ. Library-internal redirects/retries are not counted.
Daily quota, hard ceiling and long-duration sustainable capacity remain unknown.
The 16 th-search failure describes this observed window, not an immutable site limit.

## Recommended use

1. Reuse one login/MCP session for a run. Prefer Hot/Top plus topic cursors over
   overlapping searches. A conservative login search budget is 20/minute,
   spread over time; this is local policy, not a verified server setting.
2. `collect --preview --post-limit 5` reads one batch per selected topic, saves
   real cursors and avoids a long first thread starving other previews.
3. `read-collection --list` returns a local directory without bodies or HTTP;
   read selected chunks with `--topic`/`--start`.
4. Remove `--preview` and resume the same snapshot with larger batches, e.g.
   `--post-limit 300`. Result byte/request budgets can still return fewer posts.

Concurrent `Promise.allSettled` calls can reduce host/model round trips, but
HTTP stays serialized per origin. Measured throughput did not improve. Retain
serialization for Cookie/bootstrap updates, shared cooldown, metrics and browser
recovery. Single-tool shell wrappers launch a fresh process; prefer a persistent
MCP client or collector for bulk work.

A live preview saved 15 posts across 3 topics; three full-resume calls added 174,
for 189 saved posts, with complete selected ranges and no missing/duplicate floors.
The local directory was about 1 KB and local chunk reading used zero HTTP requests.
Preview used 6 public HTTP requests, resume 7. Separate CLI launches each needed
fresh login/bootstrap; session reuse is per run, not across process launches.

## Bounds

Preview is partial unless the selected ranges are known exhausted; ordinary
budgets, errors and unknown tails remain explicit. Discovery and thread coverage
are separate. Raw headers are edit times; creation time may be unknown, bodies
may be truncated, and attachments remain unreviewed. Reruns preserve site/filter
binding, actual cursors and persisted cooldown.

An unhinted 429/1015 now uses 60 seconds of conservative cooldown; explicit server
hints keep their existing precedence. The old benchmark reported 30 seconds, but
original headers/body were not retained, so that cannot be identified as a server
hint versus the earlier local fallback. The updated fallback is verified offline,
without deliberately causing another live limit.

Usage examples are in [README.md](../../README.md). Source/installed package
validation is recorded in [local-acceptance.md](local-acceptance.md). Runtime
configuration remains machine-local and credentials do not belong in this repo.
