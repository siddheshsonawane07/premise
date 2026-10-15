#!/usr/bin/env node
// premise-hook: the command-hook side of Premise. Claude Code allows only command hooks on
// SessionStart, and Stop needs `git` on the developer's machine, so these two go through here.
// Reads the hook input on stdin, POSTs it to the Premise server, prints the reply. Never
// blocks: it always exits 0. Needs PREMISE_URL and PREMISE_KEY in the environment.
//
//   premise-hook session-start
//   premise-hook stop

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const UNREACHABLE = 'Premise is unreachable: edits to files will be blocked until it is back. Tell the user.';

async function readStdin() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  try { return JSON.parse(s || '{}'); } catch { return {}; }
}

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; }
}

async function post(route, body) {
  const url = process.env.PREMISE_URL;
  const key = process.env.PREMISE_KEY;
  if (!url || !key) throw new Error('PREMISE_URL and PREMISE_KEY must be set');
  const res = await fetch(`${url.replace(/\/$/, '')}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-premise-repo': process.env.PREMISE_REPO ?? '' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const cmd = process.argv[2];
  const input = await readStdin();
  const cwd = input.cwd || process.cwd();

  if (cmd === 'session-start') {
    const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || 'unknown';
    try {
      const out = await post('/hooks/session-start', { session_id: input.session_id, tool: 'claude-code', branch, model: input.model });
      process.stdout.write(JSON.stringify(out));
    } catch {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: UNREACHABLE } }));
    }
    return;
  }

  if (cmd === 'stop') {
    // Modified and new files, relative to cwd, with their modification times, and the content of
    // small text files so a later rule change can check them for the old figure.
    const listed = git(cwd, ['ls-files', '--modified', '--others', '--exclude-standard']).split('\n').filter(Boolean);
    let budget = 4_000_000; // the server accepts 5 MB a request
    const files = [...new Set(listed)].slice(0, 200).flatMap((rel) => {
      try {
        const full = path.join(cwd, rel);
        const st = fs.statSync(full);
        const file = { path: full, mtimeMs: st.mtimeMs };
        if (st.size > 100_000 || st.size > budget) return [file];
        budget -= st.size;
        const content = fs.readFileSync(full, 'utf8');
        return [content.includes('\u0000') ? file : { ...file, content }];
      } catch { return []; }
    });
    try { await post('/hooks/stop', { session_id: input.session_id, cwd, files }); } catch { /* never block Stop */ }
    return;
  }

  process.stderr.write(`premise-hook: unknown command ${cmd}\n`);
}

main().catch(() => {}).finally(() => process.exit(0));
