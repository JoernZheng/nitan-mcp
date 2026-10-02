import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = String.raw`
import contextlib, io, json, runpy, sys, types
from pathlib import Path
sys.path.insert(0, sys.argv[1])
for wrapper in ("cloudscraper_wrapper.py", "curl_cffi_wrapper.py"):
  for stage in ("warmup", "csrf", "login", "target"):
    calls = []
    class Response:
      def __init__(self, name):
        self.status_code = 429 if name == stage else 200
        self.headers = {"Retry-After": "30", "content-type": "application/json"}
        self.text = "Error 1015 PRIVATE_BODY" if name == stage else '{"csrf":"PRIVATE_CSRF"}'
        self.content = self.text.encode()
        self.encoding = "utf-8"
      def json(self): return json.loads(self.text)
    class Session:
      def __init__(self, *a, **kw): self.headers = {}; self.cookies = {}
      def get(self, url, **kw):
        name = "csrf" if "csrf.json" in url else "warmup"
        calls.append(name); return Response(name)
      def post(self, url, **kw): calls.append("login"); return Response("login")
      def request(self, **kw): calls.append("target"); return Response("target")
    cloud = types.ModuleType("cloudscraper"); cloud.CloudScraper = Session; cloud.create_scraper = Session
    curl = types.ModuleType("curl_cffi"); curl.requests = types.SimpleNamespace(Session=Session)
    sys.modules["cloudscraper"] = cloud; sys.modules["curl_cffi"] = curl
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
      namespace = runpy.run_path(str(Path(sys.argv[1])/wrapper), run_name="offline_fixture")
      result = namespace["make_request"]({"url":"https://example.invalid/t/1.json", "method":"GET", "login":{"username":"PRIVATE_USER", "password":"PRIVATE_PASSWORD"}})
    assert result["status"] == 429, (wrapper, stage, result)
    assert result["headers"]["Retry-After"] == "30"
    assert calls[-1] == stage, (wrapper, stage, calls)
    assert "PRIVATE_" not in stderr.getvalue(), stderr.getvalue()
    for line in stderr.getvalue().splitlines(): assert set(json.loads(line)) == {"event", "status"}
from request_support import check_response, RateLimitedResponse
class BrokenBody:
  status_code = 429
  headers = {"Retry-After":"30"}
  @property
  def text(self): raise RuntimeError("PRIVATE_ERROR")
with contextlib.redirect_stderr(io.StringIO()):
  try: check_response(BrokenBody())
  except RateLimitedResponse as e:
    assert e.result["status"] == 429 and e.result["headers"]["Retry-After"] == "30"
  else: raise AssertionError("must preserve rate limit")
print(json.dumps({"cases":9, "offline":True}))
`;

test("Python warmup, CSRF, login and target limits stop internal cascades", () => {
  const directory = fileURLToPath(new URL("../http/", import.meta.url));
  const result = spawnSync("python3", ["-c", script, directory], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).cases, 9);
});
