import test from 'node:test';
import assert from 'node:assert/strict';
import { Logger, eventLine } from '../util/logger.js';
import { randomUUID } from 'node:crypto';
test('run event persistence rejects plain/foreign lines and strips nonallowlisted fields',()=>{
 const id=randomUUID();const line=JSON.stringify({time:'2026-10-01T19:00:00.000Z',level:'info',run_id:id,event:'http.request.completed',status:200,explicit_request_count:1,warmup_request_count:0,request_interval_ms:3000,headers:'PRIVATE_HEADERS',body:'PRIVATE_BODY'});
 const saved=eventLine(line,id)!;assert.doesNotMatch(saved,/PRIVATE_/);assert.equal(JSON.parse(saved).explicit_request_count,1);
 assert.equal(eventLine('[date] INFO starting',id),undefined);assert.equal(eventLine(line,randomUUID()),undefined);
 const logger=new Logger('silent','PRIVATE_ID');assert.notEqual(logger.runId,'PRIVATE_ID');assert.match(logger.runId,/^[a-f0-9-]{36}$/);
});
