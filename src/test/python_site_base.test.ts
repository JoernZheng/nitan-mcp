import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const directory=fileURLToPath(new URL("../http",import.meta.url));
const fixture=String.raw`
import importlib.util, json, sys, types
sys.path.insert(0, sys.argv[1])
records=[]
class Cookies(dict):
    def get_dict(self): return dict(self)
class Response:
    status_code=200
    headers={'content-type':'application/json'}
    encoding='utf-8'
    apparent_encoding='utf-8'
    def __init__(self, data=None):
        self.data=data or {};self.text=json.dumps(self.data);self.content=self.text.encode()
    def json(self): return self.data
class Session:
    def __init__(self, *args, **kwargs): self.cookies=Cookies();self.headers={}
    def get(self,url,**kwargs):
        records.append(['GET',url,kwargs.get('headers',{}).get('Referer')]);return Response({'csrf':'fixture-token'} if url.endswith('/session/csrf.json') else {})
    def post(self,url,**kwargs):
        records.append(['POST',url,kwargs.get('headers',{}).get('Referer')]);return Response({'username':'fixture'})
    def request(self,method,url,**kwargs): records.append([method,url,kwargs.get('headers',{}).get('Referer')]);return Response()
cloud=types.ModuleType('cloudscraper');cloud.CloudScraper=Session;cloud.create_scraper=lambda **kwargs:Session();sys.modules['cloudscraper']=cloud
curl=types.ModuleType('curl_cffi');curl.requests=types.SimpleNamespace(Session=Session);sys.modules['curl_cffi']=curl
spec=importlib.util.spec_from_file_location('wrapper',sys.argv[1]+'/'+sys.argv[2]+'_wrapper.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
result=module.make_request(json.loads(sys.argv[3]));print(json.dumps({'success':result.get('success'),'records':records,'error':result.get('error')}))
`;
for(const backend of ["cloudscraper","curl_cffi"])test(`${backend} warmup/CSRF/login/target preserve explicit subfolder and legacy root`,()=>{
  for(const base of [undefined,"https://offline.invalid/","https://offline.invalid/forum/?ignored=1#hash"]){
    const prefix=base?.includes("/forum")?"https://offline.invalid/forum":"https://offline.invalid";
    const data={url:prefix+"/private.json",method:"GET",headers:{},login:{username:"fixture",password:"fixture"},...(base?{site_base:base}:{})};
    const result=spawnSync("python3",["-c",fixture,directory,backend,JSON.stringify(data)],{encoding:"utf8",timeout:3000});assert.equal(result.status,0,result.stderr);
    const out=JSON.parse(result.stdout);assert.equal(out.success,true,out.error);
    assert.deepEqual(out.records.map((row:any)=>row[1]),[prefix,prefix+"/session/csrf.json",prefix+"/session.json",prefix+"/private.json"]);
    assert.equal(out.records[2][2],prefix+"/login");
  }
});
for(const backend of ["cloudscraper","curl_cffi"])test(`${backend} rejects a mismatched base before any warmup/login request`,()=>{
  for(const target of ["https://evil.invalid/forum/private.json","https://offline.invalid/forum-other/private.json","https://offline.invalid/forum/../forum-b/private.json","https://offline.invalid/forum/%2e%2e/forum-b/private.json"]){
    const data={url:target,site_base:"https://offline.invalid/forum",method:"GET",headers:{},login:{username:"fixture",password:"fixture"}};
    const result=spawnSync("python3",["-c",fixture,directory,backend,JSON.stringify(data)],{encoding:"utf8",timeout:3000});assert.equal(result.status,0,result.stderr);
    const out=JSON.parse(result.stdout);assert.equal(out.success,false);assert.deepEqual(out.records,[]);
  }
});
