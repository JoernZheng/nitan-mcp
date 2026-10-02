---
name: nitan
description: Read uscardforum.com through the installed local Nitan MCP fork. Prefer a persistent MCP session or bounded collection, then local directories/chunks. Never expose credentials or bypass cooldown.
---

# Nitan forum reading

Use the maintained local fork, not the upstream npm release. Setup and the
running tool schemas are canonical. Do not implement a separate forum scraper.

## Workflow

- Discover with Hot/Top or one scoped search, then read relevant reply context.
- For multiple topics, use one persistent client or `nitan-mcp collect`.
  `--preview --post-limit 5` covers one batch per selected topic; remove preview
  to resume larger batches from actual saved cursors.
- Use `read-collection --list` for a bounded local directory and `--topic` for
  body chunks. These make no forum requests.
- Keep the same snapshot site/author filter; never run two writers on one output.
- Respect call/time/byte budgets and rate cooldown. Do not rotate accounts,
  processes or adapters to evade limits. Stop on 429/confirmed 1015.
- Interpret complete/reason/discovery coverage explicitly; preview and partial
  errors are not full-thread completion. Save consumed progress before stopping.
- Record source links, time window and missing coverage. Distinguish official
  evidence from community reports. Attachments are references, not reviewed media.

## Authentication

The server uses its configured env/profile. Existing User API keys take
precedence; credentials use `NITAN_USERNAME`/`NITAN_PASSWORD`. Reuse an already
chosen working mode. Do not ask for passwords in chat or print auth material.
A collector inherits its own environment, not another app's MCP env automatically.
Missing authentication should lead to setup guidance, not repeated retries.

## Tools and wrappers

Use only registered read-only tools: Hot, Top, search, topic reading, user activity,
notifications, trust progress, excellent topics and funny topics. If untethered,
select a site before reading. There are no write/admin tools.

Shell wrappers use `scripts/mcp_call.sh <tool_name> [json_args]` and start one
short-lived stdio process per call. They require an installed local binary via
`npx --no-install ${NITAN_MCP_PACKAGE:-nitan-mcp}`. Runtime package installation
is disabled by default (`NITAN_MCP_ALLOW_INSTALL=0`); never opt in silently.
Use wrappers for isolated calls, persistent collection for bulk work. Confirm
any opted-in package comes from the intended fork; `@nitansde/mcp` on npm belongs
to upstream. Do not rely on private development paths.

For current parameters and coverage see [TOOLS.md](../../TOOLS.md); installation,
CLI examples and exit meanings are in [README.md](../../README.md).
