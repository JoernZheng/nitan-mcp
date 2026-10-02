# Acceptance record

Final development verification on 2026-10-01, before publication closeout:

- Node 22 typecheck/build and isolated full source suite:224/224 passed.
- Independent offline npm installation:95 packages, lifecycle scripts disabled;
  relevant packaged regressions:75/75 passed.
- Skill packaging and nine-tool stdio registration passed.
- Independent read-only review found no remaining blockers in topic continuation,
  snapshot/error/cooldown handling, preview or local directory pagination/bounds.
- Bounded anonymous/login read/search and preview/resume checks completed;
  [observations and limits](efficient-reading.md).

Coverage includes sparse/deleted floor continuation, consumed-only cursors,
partial errors, actual SDK stdio/HTTP behavior, site/auth boundaries, cancellation,
byte/call/time budgets, safe logs, explicit/unknown backend costs and shared
cooldown. Real CLI preview→directory→full resume preserved all stored floors.

Live testing is ended at the user's request. Documentation and local runtime
switching use build/package and zero-forum-request startup/registration checks;
no additional forum workload is needed. Raw snapshots, credentials, profiles,
UUID event files and machine-specific logs remain local and are not published.

Limits: no whole-forum/day completeness, daily quota or long-term throughput
claim. Attachments are not automatically reviewed; arbitrary historical reply
edits may not be detected by first-post/tail refresh. Server/CDN cache behavior
may differ between authentication modes.
