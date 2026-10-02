import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
// macOS system Git also works when a different-architecture Homebrew Git is on PATH.
const git = process.platform === 'darwin' ? '/usr/bin/git' : 'git';
let revision = '', dirty = null;
try {
  revision = execFileSync(git, ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim();
  dirty = Boolean(execFileSync(git, ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim());
} catch { revision = ''; dirty = null; /* Source distributions without Git still build. */ }
const build_id = /^[a-f0-9]{40}$/.test(revision) ? revision.slice(0, 12) + (dirty ? '-dirty' : '') : 'unknown';
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/build-info.json', import.meta.url), JSON.stringify({ build_id, revision, dirty }) + '\n');
