import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = String.raw`
import contextlib, io, json, runpy, sys, types
from pathlib import Path
sys.path.insert(0,sys.argv[1])
for wrapper in ('cloudscraper_wrapper.py','curl_cffi_wrapper.py'):
  for case in ('cold','cookies','forbidden','challenge','warmup429','target429','discussion','rawdiscussion'):
    calls=[]
    class Response:
      def __init__(self,kind):
        self.status_code=429 if (case=='target429' and kind=='target') or (case=='warmup429' and kind=='warmup') else 403 if case=='forbidden' or (case in ('challenge','warmup429') and len(calls)==1) else 200
        self.headers={'content-type':'text/html' if self.status_code==403 and case!='forbidden' else 'application/json','Retry-After':'600'}
        self.text='<html><title>Just a moment...</title></html>' if self.status_code==403 and case!='forbidden' else '{}'
        if case=='discussion': self.text='{"raw":"Discuss /cdn-cgi/challenge-platform and <title>Just a moment</title>"}'
        if case=='rawdiscussion': self.text='alice | now | #1\nDiscussion /cdn-cgi/challenge-platform'
        self.content=self.text.encode(); self.encoding='utf-8'; self.apparent_encoding='utf-8'
      def json(self): return {}
    class Session:
      def __init__(self,*a,**kw): self.cookies={}; self.headers={}
      def get(self,url,**kw): calls.append('warmup'); return Response('warmup')
      def request(self,**kw):
        if case=='cookies': assert self.cookies.get('_t')=='PRIVATE_COOKIE'
        calls.append('target'); return Response('target')
    cloud=types.ModuleType('cloudscraper');cloud.CloudScraper=Session;cloud.create_scraper=Session
    curl=types.ModuleType('curl_cffi');curl.requests=types.SimpleNamespace(Session=Session)
    sys.modules['cloudscraper']=cloud;sys.modules['curl_cffi']=curl
    with contextlib.redirect_stderr(io.StringIO()):
      module=runpy.run_path(str(Path(sys.argv[1])/wrapper),run_name='fixture')
      result=module['make_request']({'url':'https://offline.invalid/hot.json','method':'GET',**({'cookies':{'_t':'PRIVATE_COOKIE'}} if case=='cookies' else {})})
    expected=['target','warmup','target'] if case=='challenge' else ['target','warmup'] if case=='warmup429' else ['target']
    assert calls==expected,(wrapper,case,calls,result)
    assert result['explicit_request_count']==len(calls)
    assert result['warmup_request_count']==calls.count('warmup')
    if case in ('warmup429','target429'): assert result['status']==429 and not result['success']
print(json.dumps({'cases':16,'offline':True}))
`;
test('Python skips unconditional warmup, carries cookies, and only rescues confirmed challenges', () => {
  const r = spawnSync('python3', ['-c', script, fileURLToPath(new URL('../http/', import.meta.url))], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout); assert.equal(JSON.parse(r.stdout).cases, 16);
});
