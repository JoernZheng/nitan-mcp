# Maintenance status

Updated 2026-10-01 (America/Los_Angeles).

## Scope

Small personal, read-only forum server: topic reading, discovery, and resumable
local collection. Retain Nitan's site/auth/browser/Python adaptation while
selectively porting useful general Discourse fixes. Do not import enterprise
admin/workflow/remote-tool frameworks. [Pinned upstream assessment](upstream-assessment.md).

## Completed

| Area | Delivered |
| --- | --- |
| Topic correctness | Sparse/deleted floor continuation, bounded positioning, honest incomplete ranges |
| Requests | Shared pacing/cooldown, cancellation, backend cleanup, safe cost events |
| HTTP/auth boundaries | Loopback restrictions, bounded bodies, exact forum-base credential scoping |
| SDK | Node 22+, SDK 1.30.0, small shared server factory and ordered nine-tool catalog |
| Collection | Persistent stdio client, atomic content/cursor snapshots, locks, budgets, resume |
| Evidence | Correct edit/creation timestamps, compact byte-bounded output, attachment/quote references |
| Efficiency | One-batch topic preview, local directory/chunks, conservative unhinted cooldown |

Final implementation checks:224/224 source regressions and 75/75 independently
installed package cases. See [acceptance](local-acceptance.md) and
[reading workflow](efficient-reading.md). Live testing is concluded; do not
continue forum load tests during publication/install closeout.

## Publication closeout

The user authorized documentation cleanup, merging to their fork's main,
pushing code, installing the maintained local MCP, and removing the old runtime.
Current files and the unpublished development history were checked for actual
configured credentials, private keys and token patterns. No matches were found.
Personal machine paths existed in development notes; the published documentation
uses generic paths. Main receives a sanitized squash; detailed development
history and pre-cleanup notes remain local. Only the main branch is published.

Preserve unrelated changes, use exact staging paths and authored identity from
applicable working agreements. This authorization does not include npm release,
PR publication, upstream contributions or unrelated configuration changes.
For future changes: use one writer, read-only auxiliary review, scoped checks,
update this status and commit coherent changes. Public messages need their own
authorization. Never commit credentials, profiles, forum dumps or machine logs.
