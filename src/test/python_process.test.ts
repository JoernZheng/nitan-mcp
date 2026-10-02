import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPythonRequest } from "../http/python_process.js";

const input = { url: "https://offline.invalid", method: "GET", headers: {} };
async function fixture(script: string, operation: (file: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "nitan-child-"));
  const file = join(directory, "backend.cjs");
  await writeFile(file, script);
  try { await operation(file, directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function waitForFile(file: string) {
  for (let i = 0; i < 200; i++) { try { return await readFile(file, "utf8"); } catch { await new Promise(r => setTimeout(r, 5)); } }
  throw new Error("fixture not ready");
}

test("pre-aborted Python request does not spawn", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runPythonRequest("/must-not-run", "/missing", input, { signal: controller.signal }), { name: "AbortError" });
});

test("Python runner returns valid JSON and handles bad output/spawn errors", async () => {
  await fixture('process.stdin.resume(); process.stdin.on("end",()=>console.log(JSON.stringify({success:true,body:"ok"})));', async file => {
    assert.equal((await runPythonRequest(process.execPath, file, input)).body, "ok");
  });
  await fixture('process.stdin.resume(); process.stdin.on("end",()=>console.log("PRIVATE_NON_JSON"));', async file => {
    await assert.rejects(runPythonRequest(process.execPath, file, input), /Invalid Python response JSON/);
  });
  await assert.rejects(runPythonRequest("/missing-python-runtime", "/missing", input), /runtime could not be started/);
});

for (const ignoreTerm of [false, true]) test(`Python abort waits for actual exit (ignoreSIGTERM=${ignoreTerm})`, async () => {
  await fixture('const fs=require("node:fs"); const path=require("node:path"); const dir=path.dirname(__filename);'+
    (ignoreTerm ? 'process.on("SIGTERM",()=>{});' : '')+
    'fs.writeFileSync(path.join(dir,"pid"),String(process.pid)); setInterval(()=>fs.appendFileSync(path.join(dir,"marker"),"x"),10); process.stdin.resume();', async (file, directory) => {
    const controller = new AbortController();
    const result = runPythonRequest(process.execPath, file, input, { signal: controller.signal }).catch(e => e);
    const pid = Number(await waitForFile(join(directory, "pid")));
    controller.abort();
    assert.equal((await result).name, "AbortError");
    assert.throws(() => process.kill(pid, 0), (e: any) => e.code === "ESRCH");
    const before = await readFile(join(directory, "marker"), "utf8").catch(() => "");
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(await readFile(join(directory, "marker"), "utf8").catch(() => ""), before);
  });
});

test("late valid JSON cannot win over cancellation", async () => {
  await fixture('const fs=require("node:fs"),path=require("node:path"); fs.writeFileSync(path.join(path.dirname(__filename),"pid"),String(process.pid)); process.on("SIGTERM",()=>{console.log(JSON.stringify({success:true,body:"late"}));process.exit(0)});process.stdin.resume();setInterval(()=>{},100);', async (file, directory) => {
    const c = new AbortController();
    const result = runPythonRequest(process.execPath, file, input, { signal:c.signal }).catch(e => e);
    await waitForFile(join(directory,"pid")); c.abort();
    assert.equal((await result).name, "AbortError");
  });
});

test("standalone Python timeout kills the child", async () => {
  await fixture('process.stdin.resume();setInterval(()=>{},100);', async file => {
    await assert.rejects(runPythonRequest(process.execPath, file, { ...input, timeout:0.05 }), { name:"TimeoutError" });
  });
});


test("standalone Python timeout remains enforced with an external signal", async () => {
  await fixture('process.stdin.resume();setInterval(()=>{},100);', async file => {
    const controller = new AbortController();
    await assert.rejects(runPythonRequest(process.execPath, file, { ...input, timeout:0.05 }, { signal:controller.signal }), { name:"TimeoutError" });
    assert.equal(controller.signal.aborted, false);
  });
});

test("oversized Python output terminates the child and rejects safely", async () => {
  await fixture('const fs=require("node:fs"),path=require("node:path");fs.writeFileSync(path.join(path.dirname(__filename),"pid"),String(process.pid));process.on("SIGTERM",()=>{});process.stdin.resume();const chunk=Buffer.alloc(1024*1024,120);setInterval(()=>{for(let i=0;i<8;i++)process.stdout.write(chunk)},1);', async (file, directory) => {
    const result = runPythonRequest(process.execPath, file, { ...input, timeout:5 }).catch(e => e);
    const pid = Number(await waitForFile(join(directory,"pid")));
    assert.match((await result).message, /exceeds 64 MiB/);
    assert.throws(() => process.kill(pid, 0), (e: any) => e.code === "ESRCH");
  });
});
