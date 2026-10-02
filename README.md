# Nitan MCP

A small, read-only MCP server for [uscardforum.com](https://www.uscardforum.com/).
This personal fork keeps Nitan's forum adapters and selectively adopts general
fixes from [Discourse MCP](https://github.com/discourse/discourse-mcp).

Source: [JoernZheng/nitan-mcp](https://github.com/JoernZheng/nitan-mcp).
The package keeps the upstream name `@nitansde/mcp` for compatibility; the npm
release belongs to upstream. Build this repository to use our maintained code.

## Install from source

Requirements: Node.js 22+, pnpm 10, and Python with the dependencies in
`requirements.txt`. The verified local runtime uses Node 22 and Python 3.9.

```bash
git clone https://github.com/JoernZheng/nitan-mcp.git
cd nitan-mcp
pnpm install --frozen-lockfile --ignore-scripts
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
pnpm build
node dist/index.js doctor
```

Configure your MCP client with absolute paths:

```json
{
  "mcpServers": {
    "nitan": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/nitan-mcp/dist/index.js",
        "--site", "https://www.uscardforum.com",
        "--python_path", "/absolute/path/to/nitan-mcp/.venv/bin/python",
        "--bypass_method", "curl_cffi",
        "--browser-fallback-enabled=false",
        "--interactive-login-enabled=false"
      ],
      "env": { "TIMEZONE": "America/Los_Angeles" }
    }
  }
}
```

This is the verified direct-request setup. Browser recovery is optional; see
[CLOUDFLARE_BYPASS.md](CLOUDFLARE_BYPASS.md). Stdio is the default transport.
Optional HTTP mode (`--transport http --port 3000`) binds to loopback only.

## Authentication

Public topics can be read anonymously. To use your account, set
`NITAN_USERNAME` and `NITAN_PASSWORD` in the MCP client's environment. Keep
credentials outside this repository. A configured credential is not proof of
successful login; confirm the actual session identity when comparing accounts.

A saved User API key takes precedence over login credentials. To provision one:

```bash
node dist/index.js generate-user-api-key --site https://www.uscardforum.com \
  --auth-mode url --state-file /absolute/private/path/pending-auth.json
node dist/index.js complete-user-api-key \
  --state-file /absolute/private/path/pending-auth.json --payload "ENCRYPTED_PAYLOAD"
```

Open the printed URL, authorize, then complete with the encrypted payload.
The pending file contains private key material; keep it private. The server
loads its platform profile automatically: macOS `~/Library/Application Support/NitanMCP/profile.json`,
Linux `${XDG_CONFIG_HOME:-~/.config}/nitan-mcp/profile.json`, Windows
`%APPDATA%\NitanMCP\profile.json`. Successful completion attempts to remove the pending file; check and safely
remove it if cleanup fails.

## Tools

The CLI defaults to uscardforum.com and exposes nine read-only tools.
No posting, deletion or admin tools.

| Tool | Purpose |
| --- | --- |
| `discourse_list_hot_topics` | Hot topics, with bounded page/offset continuation |
| `discourse_list_top_topics` | Ranked topics for daily/weekly/monthly or other periods |
| `discourse_search` | Keyword, category, author and date filters |
| `discourse_read_topic` | Topic metadata, posts and consumed continuation cursor |
| `discourse_get_user_activity` | Recent posts/replies by a user |
| `discourse_list_notifications` | Notifications using configured authentication |
| `discourse_get_trust_level_progress` | A user's level and progress |
| `discourse_list_excellent_topics` | Topics awarded the excellent-topic badge |
| `discourse_list_funny_topics` | Topics awarded the funny-topic badge |

See [TOOLS.md](TOOLS.md) for input examples and result/coverage rules.

## Efficient reading

Use one persistent MCP connection. Discover topics, preview a small batch from
each, read a local directory/chunks, then resume the important material in larger
batches. The collector makes multiple MCP calls in one local execution; full
post bodies stay in a snapshot instead of repeatedly filling model context.

```bash
node dist/index.js collect --public --output ./daily.json --hot-limit 10 \
  --preview --post-limit 5 --max-topics 10 --max-calls 11 --max-seconds 120
node dist/index.js read-collection --input ./daily.json --list --limit 10
node dist/index.js read-collection --input ./daily.json --topic 12345 \
  --start 1 --limit 30 --max-bytes 65536
node dist/index.js collect --public --output ./daily.json --hot-limit 10 \
  --post-limit 300 --max-topics 10 --max-calls 20 --max-seconds 120
```

Remove `--public` to use the collector's own env/profile credentials. It does
not inherit another application's MCP env automatically. Adapter flags go after
`--`, for example `-- --python_path /absolute/path/python --bypass_method curl_cffi`.
Rerun the same output to resume; keep its site and author filter unchanged.

Preview reads one batch per selected topic and preserves the real cursor.
It is partial unless those topic ranges are exhausted. `--list` and chunk
reading are local only. Directory offsets are zero-based; post numbers start at 1.

Exit 0 means a completed run; exit 2 means partial/cooldown/budget stop; invalid
input or startup failure exits 1. Inspect `reason`, `selected_topics_complete`
and `discovery_complete`: discovery is a bounded sample, not whole-forum/day
coverage. Same-output runs use a lock; remove a stale lock only after confirming
its recorded PID exited. Content and cursors commit together via atomic rename.

## Limits and reliability

- HTTP work is serialized per origin. Concurrent tool calls do not increase the
  forum budget. Server pacing defaults to 500 ms; public collection to 3,000 ms.
  Override with `--request-interval-ms` (500–60,000 ms) for bounded workloads.
- 429/confirmed 1015 stops fallback/retry cascades. Cooldown uses server hints,
  or 60 seconds when none are parseable; collection persists it across runs.
- Topic reads default to 90 posts (max 500), 32 logical requests and a 256 KiB
  result budget. Compact output avoids duplicate text. Never advance past a
  post that was not returned; follow `next_post_number`.
- Raw timestamps describe edits. Creation time may be unknown. Truncated bodies,
  incomplete ranges and unreviewed attachments are marked explicitly.
- Each collector run writes a separate safe event file. Logs omit credentials,
  Cookies, queries and post bodies; explicit counts exclude library retries.
- Search and normal reads have different observed limits. See
  [the measured workflow](docs/maintenance/efficient-reading.md); the sample
  does not establish daily or long-term quotas.

## Development

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm skill:pack
```

Read [AGENTS.md](AGENTS.md) before editing. [Maintenance status](docs/maintenance/delivery-plan.md)
and [acceptance evidence](docs/maintenance/local-acceptance.md) explain the
current scope. The optional [skill](skills/nitan/SKILL.md) remains a thin bridge;
its single-call shell wrappers start a fresh process, so prefer a persistent
MCP client or `collect` for bulk work.
