#!/usr/bin/env node
// CODEX_PATH of codex-acp (profiles.ts): starts the real codex (CODEX_REAL) as its app-server and rewrites the approval and sandbox that codex-acp sends with
// every turn/start. Its session modes cannot say "untrusted" (known-safe read-only commands run, everything else asks) and every mode with a sandbox needs
// bubblewrap, which the hardened container cannot start. The container is the sandbox; the user is the reviewer. Everything else passes through unchanged.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const child = spawn(process.env.CODEX_REAL, process.argv.slice(2), { stdio: ['pipe', 'inherit', 'inherit'] });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.stdin.on('error', () => {});
process.on('SIGTERM', () => child.kill('SIGTERM'));
// stdout is passed through by the real codex directly: only the requests need a look
createInterface({ input: process.stdin }).on('line', (line) => {
  let out = line;
  try {
    const m = JSON.parse(line);
    if (m.method === 'turn/start' && m.params) {
      m.params.approvalPolicy = 'untrusted'; m.params.approvalsReviewer = 'user'; m.params.sandboxPolicy = { type: 'dangerFullAccess' };
      out = JSON.stringify(m);
    }
  } catch { /* not JSON: pass on */ }
  child.stdin.write(out + '\n');
}).on('close', () => child.stdin.end());
