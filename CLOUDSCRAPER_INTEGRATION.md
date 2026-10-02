# Python adapter notes

Current setup and behavior are documented in
[CLOUDFLARE_BYPASS.md](CLOUDFLARE_BYPASS.md).

Both Python adapters share `src/http/request_support.py` for request metrics,
challenge confirmation, site-relative bootstrap and rate-limit propagation.
Keep this helper in build/package output. Runtime defaults and supported tools
are described in [README.md](README.md).
