# Request adapters

The maintained fork supports Python `curl_cffi`, `cloudscraper`, and optional
browser recovery. They use the same HTTP client, site boundaries, serialized
queue, deadlines and cooldown rules. No separate scraper or worker service.

The verified personal-use configuration is:

```bash
node dist/index.js --site https://www.uscardforum.com \
  --python_path /absolute/path/python --bypass_method curl_cffi \
  --browser-fallback-enabled=false --interactive-login-enabled=false
```

Install Python dependencies from `requirements.txt`. `--bypass_method` accepts
`curl_cffi`, `cloudscraper` or `both` (default: cloudscraper then curl_cffi).
Ordinary HTTP errors and rate limits do not cause another backend/login attempt.
Public/session GETs skip unconditional homepage warmup. A confirmed challenge
may cause one warmup/retry; first credential login retains CSRF/bootstrap.

Browser recovery is a rescue path. On macOS it is enabled by default unless
explicitly disabled; using it requires Playwright and its Chromium runtime.
It accepts one operation at a time. Close only owned resources; never kill an
existing browser to recover a locked profile or borrow another tab for requests.
Cancellation waits for actual backend/child close; a hung browser has no hard
close guarantee through the current Playwright API.

429/confirmed 1015 stops immediately and shares cooldown per origin. Use explicit
Retry-After/Discourse timing; without parseable hints fall back to 60 seconds.
The collector persists cooldown across runs. Changing adapters, accounts or
processes to bypass an active cooldown is not a supported workflow.

Local HTTP transport is loopback-only, with exact Host/Origin checks, bounded
POST bodies and shutdown cleanup. Prefer stdio for a persistent personal client.
See [README.md](README.md) for setup and authentication.
