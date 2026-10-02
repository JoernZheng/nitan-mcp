import { fileURLToPath } from 'node:url';
import { mkdirSync, openSync, appendFileSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eventLine } from './util/logger.js';
import type { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { collect, readCollectionChunk, readCollectionIndex, type CollectionOptions } from './collector.js';
import { normalizeSiteBase } from './util/site_url.js';

export async function runCollectionRead(argv: string[]) {
  if (argv.includes('--help')) { console.log('nitan-mcp read-collection --input <collection.json> (--topic ID [--start 1] | --list [--offset 0]) [--limit 50] [--max-bytes 65536]'); return; }
  const values: Record<string,string> = {}; let list = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--list') { list = true; continue; }
    const key = argv[i].slice(2), value = argv[++i];
    if (!['input','topic','start','offset','limit','max-bytes'].includes(key) || !argv[i-1].startsWith('--') || !value || value.startsWith('--')) throw new Error('Invalid read-collection option; see --help');
    values[key] = value;
  }
  if (list) {
    if (!values.input || values.topic !== undefined || values.start !== undefined) throw new Error('--list requires --input and cannot be combined with --topic/--start');
    console.log(JSON.stringify(await readCollectionIndex(values.input, Number(values.offset ?? 0), Number(values.limit ?? 50), Number(values['max-bytes'] ?? 65536)))); return;
  }
  if (values.offset !== undefined) throw new Error('--offset requires --list');
  if (!values.input || !values.topic) throw new Error('read-collection requires --input and --topic');
  console.log(JSON.stringify(await readCollectionChunk(values.input, Number(values.topic), Number(values.start ?? 1), Number(values.limit ?? 50), Number(values['max-bytes'] ?? 65536))));
}

export async function runCollector(argv: string[]) {
  if (argv.includes('--help')) {
    console.log('nitan-mcp collect --output <collection.json> [--site URL] [--topics 1,2] [--query TEXT] [--hot-limit 10] [--username-filter USER] [--post-limit 90] [--preview] [--max-discovery-pages 1] [--events-dir DIR] [--max-topics 10] [--max-calls 20] [--max-seconds 120] [--max-bytes 10485760] [--public] [-- <server flags>]'); return;
  }
  const separator = argv.indexOf('--'), flags = separator < 0 ? argv : argv.slice(0, separator), serverFlags = separator < 0 ? [] : argv.slice(separator + 1);
  const values: Record<string, string> = {}; let publicOnly = false, preview = false;
  const allowed = new Set(['output','site','topics','query','hot-limit','username-filter','post-limit','max-discovery-pages','events-dir','max-topics','max-calls','max-seconds','max-bytes']);
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--public') { publicOnly = true; continue; }
    if (flags[i] === '--preview') { preview = true; continue; }
    const key = flags[i].slice(2), value = flags[++i];
    if (!allowed.has(key) || !value || value.startsWith('--')) throw new Error('Invalid collect option; see collect --help');
    values[key] = value;
  }
  if (!values.output) throw new Error('collect requires --output <collection.json>');
  const integer = (key: string, fallback: number, max: number) => {
    const number = values[key] === undefined ? fallback : Number(values[key]);
    if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new Error(`Invalid --${key}`);
    return number;
  };
  const topicIds = values.topics ? values.topics.split(',').map(Number) : [];
  if (!topicIds.every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('Invalid --topics');
  // Collector owns site and transport; extra flags tune the existing adapters.
  if (serverFlags.some(flag => /^--(?:site|transport|profile)(?:=|$)/.test(flag))) throw new Error('Set the collector site directly; transport/profile override is unsupported');
  if (publicOnly && serverFlags.some(flag => /^--(?:username|password|second[-_]factor[-_]token|user[-_]api[-_]key|api[-_]key)(?:=|$)/.test(flag))) throw new Error('--public cannot be combined with credential flags');
  const options: CollectionOptions = { output: values.output, site: normalizeSiteBase(values.site ?? 'https://www.uscardforum.com'), topicIds, preview, usernameFilter: values['username-filter'], query: values.query,
    ...(values['hot-limit'] ? { hotLimit: integer('hot-limit', 10, 50) } : {}), maxDiscoveryPages: integer('max-discovery-pages', 1, 20), maxTopics: integer('max-topics', 10, 50), maxCalls: integer('max-calls', 20, 1000), maxSeconds: integer('max-seconds', 120, 86400), maxBytes: integer('max-bytes', 10485760, 1073741824), postLimit: integer('post-limit', 90, 500) };
  const runId = randomUUID();
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.NITAN_RUN_ID = runId;
  if (publicOnly) { env.NITAN_USERNAME = ''; env.NITAN_PASSWORD = ''; env.DISCOURSE_2FA_TOKEN = ''; }
  const pacingFlags = publicOnly && !serverFlags.some(flag => /^--request[-_]interval[-_]ms(?:=|$)/.test(flag)) ? ['--request-interval-ms=3000'] : [];
  const args = [fileURLToPath(new URL('./index.js', import.meta.url)), ...pacingFlags, ...serverFlags, '--site', options.site, '--transport', 'stdio', ...(publicOnly ? ['--auth_pairs=[]', '--browser-fallback-enabled=false', '--interactive-login-enabled=false'] : [])];
  const transport = new StdioClientTransport({ command: process.execPath, args, env, stderr: 'pipe' });
  const client = new Client({ name: 'nitan-local-collector', version: '1' });
  const eventsDirectory = resolve(values['events-dir'] ?? values.output + '.events');
  mkdirSync(eventsDirectory, { recursive: true, mode: 0o700 });
  const eventsFile = join(eventsDirectory, runId + '.jsonl');
  const eventsFd = openSync(eventsFile, 'wx', 0o600);
  let eventsComplete = true, buffer = '';
  const saveEvent = (line: string) => {
    const safe = eventLine(line, runId);
    if (safe) { try { appendFileSync(eventsFd, safe); } catch { eventsComplete = false; } }
  };
  (transport.stderr as Readable | null)?.setEncoding('utf8');
  transport.stderr?.on('data', chunk => {
    process.stderr.write(chunk);
    buffer += String(chunk);
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) { saveEvent(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
    if (buffer.length > 65536) { buffer = ''; eventsComplete = false; }
  });

  let summary: Awaited<ReturnType<typeof collect>> | undefined;
  let processStarted = false; let processClosed = false;
  let finishClosed!: () => void; const closed = new Promise<void>(resolve => { finishClosed = resolve; });
  transport.onclose = () => { processClosed = true; finishClosed(); };
  const deadline = Date.now() + options.maxSeconds * 1000;
  const control = new AbortController();
  const deadlineTimer = setTimeout(() => control.abort(new DOMException('Collection deadline', 'TimeoutError')), options.maxSeconds * 1000);
  const cancel = () => control.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    processStarted = true;
    await client.connect(transport, { signal: control.signal, timeout: Math.max(1, deadline - Date.now()) });
    const result = await collect({ ...options, runId, eventSink: saveEvent, maxSeconds: Math.max(0.001, (deadline - Date.now()) / 1000) }, (name, arguments_, signal) => client.callTool({ name, arguments: arguments_ }, undefined, { signal, timeout: options.maxSeconds * 1000 }), control.signal);
    summary = result; process.exitCode = result.complete ? 0 : 2;
  } finally { clearTimeout(deadlineTimer); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    try { await client.close();
    if (processStarted && !processClosed) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Collector server cleanup did not finish')), 5000); })]); }
      finally { clearTimeout(timer); }
    }
    } finally { if (buffer.trim()) saveEvent(buffer); closeSync(eventsFd); }
  }
  if (summary) console.log(JSON.stringify({ ...summary, run_id: runId, events_file: eventsFile, events_complete: eventsComplete }, null, 2));
}
