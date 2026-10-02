# Nitan MCP maintenance

## Scope and workflow

This is a small personal, read-only server for uscardforum.com. Retain the
site/auth/Python/browser adaptation and avoid admin/workflow/remote frameworks,
new databases, schedulers or services. Read current
`docs/maintenance/delivery-plan.md` and `docs/maintenance/upstream-assessment.md` before changes.
Use one implementation writer; auxiliary agents review read-only snapshots.
Preserve unrelated work and stage exact files only. Update accepted decisions
and current validation, then make coherent local commits. Publication/config
permissions are scoped to the caller's current authorization.

The user ended live testing. Publication/install closeout must not continue
forum workloads. Never commit credentials, profiles, cookies, forum dumps,
machine-specific paths or logs. Keep detailed historical records local.

## Architecture

- Node 22+, SDK pinned to 1.30.0 in both lockfiles, Zod. Build with pnpm.
- `src/index.ts`: CLI/config; `src/server.ts`: small shared factory.
- `src/site/state.ts`: exact-site clients/auth; `src/http/client.ts`: shared
  request path; `src/tools/registry.ts`: ordered `READ_TOOL_CATALOG`.
- Stdio owns one persistent server. HTTP creates a fresh stateless SDK
  server/transport per request while sharing SiteState. Never reuse a stateless
  SDK transport or dispose shared clients when one response closes.
- Nine registered read tools when tethered; `discourse_select_site` is added
  when untethered. No remote `/ai/tools`, write or admin execution.
- Keep tool names, defaults and existing text outputs stable; structured
  results and optional controls are additive. Update README/TOOLS when schemas
  or registration change. Unregistered legacy source files are not tools.

## Requests, authentication and cleanup

- API/User API headers take precedence; preserve login credentials as recovery
  fields. Browser fallback is optional rescue, not primary authentication.
- Normalize exact HTTP(S) forum bases with `util/site_url.ts`, preserving
  subdirectories. Reject embedded URL credentials and initial requests outside
  the selected base. No root/sibling credential inheritance. Keep API/login
  fields when merging equivalent overrides; explicit config wins.
- Python/bootstrap/form steps use the selected base. Recheck browser boundaries
  after awaits before sending auth/filling/submitting. This is not a general
  redirect interception framework.
- Logical requests share one serialized per-origin queue, including fallback.
  Server default 500 ms; public collector 3,000 ms. Keep serialization even when
  independent SDK tool calls are submitted concurrently.
- HTTP 429/confirmed 1015 propagates timing and stops backend/login/cookie retry
  cascades. Preserve metadata when response body reading fails. Explicit
  Retry-After/Discourse hints win; unparseable hints fall back to 60 s.
- Only confirmed HTML/header challenges allow one anonymous/session warmup
  retry; normal JSON/raw text mentioning challenges is not evidence. Preserve
  first-login bootstrap and the packaged shared `request_support.py` helper.
- Queueing/fallback share a total deadline. MCP signals reach active reads.
  Cancellation waits for actual Python child close and never starts a successor
  backend. Browser/login steps use remaining budget, invalidate late sessions
  and close only owned resources. Hung browsers have no claimed hard deadline.
- Browser adapter runs one operation at a time. Never kill existing Chrome on
  profile lock. Relay creates its own request tab, never borrows/navigates/closes
  another tab/context; unsupported newPage fails before forum requests.
- Site invalidation retires clients; terminal SiteState disposal waits for both
  current and retiring clients. Logout reselects tethered public site.

## Local HTTP

Bind 127.0.0.1 only. Every route uses exact loopback Host/Origin checks, ignoring
forwarded headers. Shared POST reader:4 MiB/15 s, JSON 400, overflow 413, timeout 408.
Use normalized paths for auth tracking. Committed profile writes must sync
memory even after response disconnect. Shutdown waits for auth/backend cleanup;
two-second grace failure exits 1. Separate stateless POSTs cannot route MCP
cancellation to another POST's active handler. Validate real multi-request HTTP
protocol behavior when changing lifecycle, not just health endpoints.

## Reading and collection contracts

- Raw topic headers are edit times, never creation times. Unknown creation is
  empty/unknown; JSON can enrich dates without another request. Preserve
  truncation, attachment/quote source references and unreviewed-media status.
- Advance cursors only past consumed posts, not loaded pages. Unconsumed observed
  posts override stale highest. Sparse/deleted floors and unknown/nonadvancing
  tails must not create skips or false completion. Author filters do not change
  the meaning of remaining topic range. Bound positioning and request count.
- Read Topic defaults:90 posts/max 500,32 logical requests,262,144 result bytes.
  Compact avoids duplicate bodies. A post that cannot fit is unconsumed; errors
  retain bounded consumed content/cursor when possible.
- `collect` uses one persistent stdio client; all forum access goes through MCP.
  Content/cursor commit together by atomic rename; deduplicate floors, preserve
  site/filter binding and cooldown. Same-output wx lock requires checking the
  recorded PID exited before stale-lock removal; never kill an unrelated PID.
- Call/topic/time/output budgets include initialization. Save discovered IDs
  before continuation; prioritize unfinished/never-started work. Discovery
  coverage and selected-thread completion are separate. Reserve status/cooldown
  space. First-post refresh reserves a tail call and never rewinds the cursor.
- `--preview`:one read batch per selected topic, skip extra first-post refresh,
  save real cursor and mark partial accurately. Removing it resumes full mode;
  snapshots are not bound to a preview mode. Error/budget/unknown-tail wins.
- `read-collection --list`:bounded local directory, no bodies/server; zero-based
  offsets separate from one-based post starts. Label author-filter scope. Local
  chunks fail explicitly if the first stored post cannot fit.
- Public collection clears auth and rejects credential flags. All CLI wrappers
  wait for owned child close; isError exits nonzero. No scheduler is implicit.
- Conservatively migrate v1 raw timestamps to edit time in v2 snapshots.

## Logs and verification

Use only fixed allowlisted Logger.event fields. Never log raw errors, headers,
Cookies, bodies, queries, usernames or credentials. Each collector run has its
own UUID JSON event file and reports status after cleanup. Missing Python or
browser costs are unknown; explicit counts exclude library-internal requests.
Package build identity and Python helpers, never machine data.

Run relevant checks and required typecheck/build/full suite for code changes;
validate actual SDK/CLI/packaged contracts and obtain independent review. Avoid
repeating completed tests without a new change or unresolved concern. Docs-only
closeout needs link/schema/diff checks plus zero-forum startup/registration.
