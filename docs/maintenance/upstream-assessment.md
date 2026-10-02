# Discourse upstream assessment

Assessment date: 2026-10-01 (America/Los_Angeles).

## Decision

Use the Nitan baseline and selectively port reviewed upstream improvements.
Do not merge unrelated histories wholesale or record a synthetic `ours` merge.
Keep the current GitHub fork relationship and Git remotes unchanged.
An upstream item is integrated only after its adapted implementation and tests
pass; this document does not claim all upstream commits have been merged.

Pinned inputs:

- Nitan v2.1.1: `d5580cc3a02094d7bb3d69619103f603e0b089f3`.
- Discourse main: `bacb67c70aa24e347bd901e8e8972c1b3b6d7c48`.
- Full histories have no common ancestor. A read-only unrelated-history merge
  preview identified 25 conflicting files, including entrypoint, auth, HTTP,
  tools, documentation, both lockfiles and tests.

Three independent read-only agent reviews covered upstream capabilities,
reproductions of known reading issues, and integration risks. All used source
and offline mocks; no real forum requests or credential inspection were needed.

## Adoption matrix

| Capability / source | Decision | Reason and constraints |
| --- | --- | --- |
| HTTP loopback / Host / Origin protection, [0064a76](https://github.com/discourse/discourse-mcp/commit/0064a760a00ba4ca63045bb2cc660290989f5935) | Adapt in T3 | Protect every Nitan route, including health and auth callbacks. Preserve manual payload and auth hot reload. Explicitly document remote proxy behavior change. |
| Body bounds / invalid JSON handling / shutdown, [aa14829](https://github.com/discourse/discourse-mcp/commit/aa14829) | Adapt in T3 | Apply limits to both MCP and auth POST bodies. Prove active requests cannot indefinitely block shutdown. Do not silently adopt single stateful session semantics. |
| HTTP log minimization, [aa14829](https://github.com/discourse/discourse-mcp/commit/aa14829) | Adapt in T2 | Retain HttpError.body for callers but remove raw auth headers, cookies, payload and response bodies from logs. Preserve Nitan field-level redaction. |
| Subfolder URL resolution, [98fe202](https://github.com/discourse/discourse-mcp/commit/98fe202bff88c69148e2d004358ca459fb93a454) | Adapted in T4 | Shared exact-base URL helpers preserve native/Python/browser paths and auth lifecycle. Exact base auth matching must prevent sibling subfolder credentials from being selected. No direct benefit to the current root-hosted forum. |
| Per-site request serialization, upstream withRateLimit | Design a Nitan adaptation in T2 | Generic 200 ms pacing is not a proven forum limit. Handle shared cooldown, cancellation and a total request budget across native/Python/browser paths. |
| SDK exact pin / dual lockfile discipline | Adopt exact 1.30.0 in T5 (user added scope) | Generic main pins 1.30.0 and declares Node >=24; Nitan baseline uses locked 1.17.3 and declares >=18; the delivered branch now pins 1.30.0 and targets Node 22+. Early fixes do not require a combined runtime migration. |
| Typed tool catalog / JSON outputSchema / resources | Lightweight Nitan cleanup in T5; generic framework deferred | Potential maintenance benefit; changes tool author interfaces and output contracts without fixing today's reading issues. |
| Generic read_topic / search entire files | Reject as replacements | Lose author filter, default 90/max 500 raw pagination, Chinese search filters and current text output. Upstream tags and sparse-number has_more still require care. |
| Writes / admin / remote tools / Data Explorer / workflow / AI administration | Exclude | Conflicts with Nitan's active read-only built-in surface; hidden defaults do not make these additions necessary. |
| Device auth / Basic Auth / upstream release workflows | Defer or exclude | No current need or forum compatibility evidence. Keep existing package identity and manual/resumable auth. |

## Existing defects and what upstream can fix

- Object-valued topic tags render as `[object Object]`: Nitan must normalize
  strings and objects; generic read_topic is not a direct fix.
- `username_filter` trusts the server and includes another author's first post:
  validate returned usernames locally while advancing with the server stream.
- Reading beyond highest_post_number still probes raw pages: early exit only
  when trustworthy highest metadata exists, then enforce bounded traversal.
- Repeated raw tail pages can duplicate posts; walk cache can refer to a page
  different from currentPage after its step limit. Track page identity,
  de-duplicate and prove forward progress with sparse/deleted posts.
- Offline native 429 with Retry-After=30 was retried after about 266 ms;
  Python 429 failed immediately without conveying retry timing. Generic client
  also uses 250/500 ms retries and ignores Retry-After, so T2 is a Nitan fix.
- Cloudflare 403 / Error1015 remains an external integration concern. Better
  cooldown and fewer requests reduce pressure; offline tests do not prove the
  forum will accept real requests. Do not repeatedly probe it to claim success.

## Preserved contracts

- Tethered MCP exposes exactly nine existing read-only tools; untethered adds
  discourse_select_site. No startup forum requests, writes or remote discovery.
- Keep tool names, existing input fields/limits and plaintext output structure.
- API credentials remain primary, login credentials remain available for
  Python/browser rescue, with auth headers preserved and disposal/hot reload.
- Keep default profile paths, manual encrypted payload and resumable CLI flow.
- Keep Python helpers, requirements and skills in the built package.
- Do not weaken Nitan secret redaction by replacing it with generic stringify.

## Validation boundaries

Environment baseline: macOS, Node 26.8.2, pnpm 10.14.0, Python 3.9.6;
frozen dependency install and 51 existing tests passed. One initial HTTP logout
startup timeout passed on isolated and full reruns, with no source fix.
Node 22/Linux CI or Node 18 support has not been demonstrated by that baseline.
Maintain explicit runtime evidence rather than copying generic Node engine claims.

See [delivery plan](delivery-plan.md) for executable stages, acceptance gates,
authorized actions and rollback.

## SDK adaptation outcome

SDK 1.30.0 is now exact-pinned in both lockfiles. Its production dependency
resolution includes a Node 20 HTTP adapter; this self-use branch therefore
requires Node 22+, verified with official 22.23.3, and does not add legacy
transitive overrides. SDK stateless transports cannot be reused, so HTTP now
uses one small factory/server/transport per request and retains shared site
auth/cache/cooldown. Stdio remains a single instance. A tiny ordered read-only
catalog replaces repeated registration statements; no upstream admin/resources/
toolsets/tasks or remote tools were imported. Real protocol and packaged
candidate tests cover the adaptation; this is not a full upstream history merge.
