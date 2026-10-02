import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
test('legacy skill wrapper reports MCP tool error and waits for owned child cleanup',async()=>{
 const home=await mkdtemp(join(tmpdir(),'nitan-wrapper-')),capture=join(home,'pid'),npx=join(home,'npx');
 await writeFile(npx,`#!/usr/bin/env python3\nimport sys,json,os,signal,time\nopen(${JSON.stringify(capture)},'w').write(str(os.getpid()))\nfor line in sys.stdin:\n msg=json.loads(line)\n if 'id' not in msg: continue\n result={'protocolVersion':'2024-11-05','capabilities':{},'serverInfo':{'name':'fake','version':'1'}} if msg['id']==1 else {'isError':True,'content':[{'type':'text','text':'fixture error'}]}\n print(json.dumps({'jsonrpc':'2.0','id':msg['id'],'result':result}),flush=True)\ntime.sleep(.2)\n`,{mode:0o755});
 const child=spawn('bash',[fileURLToPath(new URL('../../skills/nitan/scripts/mcp_call.sh',import.meta.url)),'discourse_read_topic','{"topic_id":1}'],{env:{...process.env,PATH:home+':'+process.env.PATH,HOME:home},stdio:['ignore','pipe','pipe']});let stdout='';child.stdout.on('data',c=>stdout+=c);child.stderr.resume();
 try{const code=await new Promise(resolve=>child.once('close',resolve));assert.equal(code,5);assert.equal(JSON.parse(stdout).isError,true);const pid=Number(await readFile(capture,'utf8'));assert.throws(()=>process.kill(pid,0));}finally{await rm(home,{recursive:true,force:true});}
});
