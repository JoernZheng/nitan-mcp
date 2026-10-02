# Live-use optimization

Updated: 2026-10-01 (America/Los_Angeles).
Baseline: `5552b98`, worktree `discourse-integration`.

The user authorized this three-batch local implementation, documentation and
checkpoint commits in the existing chat. Preserve the personal-use scope and
the release/configuration boundaries in delivery-plan.md. One source writer;
independent read-only review before delivery. No new service or database.

## Evidence

The Oct. 1 research read 27 selected threads / 2,098 visible posts. An initial
anonymous 429 requested 600 seconds of cooldown. After waiting, 63 logical
requests at approximately three-second intervals succeeded. The first session's
events were overwritten by the temporary research helper; do not infer an exact
wire-request count or a universally safe forum quota from these logs.

- `/raw` post headers contain `updated_at`, incorrectly labeled `created_at`.
  Sixteen sampled threads showed the first post timestamp after a later reply.
- An offline second-page 429 discarded the first 100 posts and resume cursor.
- An offline collector rerun missed a first-post edit marking an offer DEAD.
- Hot and Daily Top returned identical 30-topic pages. Hot reported more pages,
  but had no continuation input. Top lacked structured metadata.
- The Python adapter started a fresh process and unconditional homepage warmup
  per logical request. Existing pacing counts logical calls only.
- Saved responses repeated 363 KB text and 537 KB structured data. There were
  144 upload references in 110 posts; text-range completion is not image review.

## Tasks

| Batch | Scope | State | Verification |
| --- | --- | --- | --- |
| O1 | Accurate timestamps, first-post refresh, recoverable partial reads | Complete | Node 22 build; 44/44 isolated targeted tests; independent read-only review and two boundary fixes |
| O2 | Configurable pacing, conditional warmup, actual discovery continuation/top semantics | Complete | Node 22 65/65 targeted suite plus final collector budget regression; 16 Python efficiency cases plus auth/429 fixtures; independent review boundary fixes |
| O3 | Compact/chunked consumption, attachment/reply evidence, run logs and candidate acceptance | Complete | Node22 full 217/217; actual tarball and independently installed package 65/65; seven public MCP calls / eleven explicit requests, zero warmups or limits |

Timestamp correction intentionally changes a misleading machine field: unknown
creation time remains an empty string, never an edit time. Existing v1 collector
snapshots must be migrated conservatively. New tool inputs are optional and
existing names/default text remain supported. Partial failures remain failures,
but safely consumed posts may be returned and atomically committed before stop.

Each batch receives a local Conventional Commit after its targeted checks.
Final gates: isolated Node 22 typecheck/build/full suite, skill package, actual
tarball/stdio smoke and independent review. Public acceptance uses empty auth,
disabled browser/login, explicit request/time/topic budgets and rate cooldown;
no stress test or logged-in quota claim. Update local-acceptance.md with observed
results and practical limits, not forecasts.

O1: isolated targeted suite includes author nonmatching-prefix partial errors and
single-call refresh starvation. Both independent findings were fixed. Full
regression/package/live gates remain for final acceptance.

O1 commit: `7e3c53f`. O2 also protects legacy partial isError without machine
error metadata from becoming success. Independent O2 review found normal JSON
challenge-path text falsely triggering warmup and foreign-site partial errors
bypassing site binding; both now have targeted fixtures and fixes.

Discovery now reserves one read call for unread candidates, preventing repeated
small-budget discovery from starving saved progress.

O2 commit: `62e5277`. O3 implementation passed isolated Node 22 full suite
217/217, typecheck/build, zero-request nine-tool stdio and skill packaging.
Independent reviewers rechecked 48 and 33 relevant tests after fixing oversized
local chunks, multibyte error text crowding out partial posts, and unknown
Python/browser counts. Final tarball and public acceptance completed; details in local-acceptance.md.
The selected_topics_complete flag records actual successful selected tail reads,
independently of a topic-budget stop or discovery coverage.

O3 implementation commit: `f07d6bb`. The independently installed candidate
identifies clean build `f07d6bbb7561`, SDK 1.30.0. Tarball SHA256:
`bf83cb648a43f45c8af2d9236e1d5b4d1eb9d4cddbc1f4d03384170abee83c95`.
Final source checks passed 217/217; actual artifact and independent install
passed 65/65 each. All independent findings resolved and rechecked.

Oct. 1 17:50–17:53 PDT public acceptance: Hot page 0 and page 1 each returned
30 topics with no overlap; actual Daily Top differed from Hot; sampled topic
536262 creation/edit timestamps were distinct. The stdio reader and actual
collector resume both returned 1,2 then 3,4 with cursor 5. Two collector runs
remained intentionally partial/call_budget, with different nonoverwritten event
files. Local read-collection returned a saved chunk without forum access or
snapshot changes. Seven tool calls / eleven logical and explicit requests,
zero homepage warmups, zero rate limits. No full-forum/day or quota claim.

Delivery boundaries preserved: local commits and independent candidate only;
main, remotes, original candidate and host configuration were not switched.
