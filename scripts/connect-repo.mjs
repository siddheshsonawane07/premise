#!/usr/bin/env node
// Wires a repository to a Premise server: writes .claude/settings.json (the hooks), .mcp.json
// (the tools) and copies the command hook into .claude/hooks/. Claude Code does not expand
// environment variables in an HTTP hook's `url` (Hook Checks 2026-10-15), so the URL is
// written out here; the member's key is never written: it comes from PREMISE_KEY at run time.
//
//   node scripts/connect-repo.mjs <repo-dir> <premise-url> [repo-id]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [dir, url, repoId = 'tilldesk'] = process.argv.slice(2);
if (!dir || !url) {
  console.error('usage: connect-repo.mjs <repo-dir> <premise-url> [repo-id]');
  process.exit(1);
}
const base = url.replace(/\/$/, '');
const here = path.dirname(fileURLToPath(import.meta.url));

const http = (route, extra = {}) => ({
  type: 'http',
  url: `${base}${route}`,
  timeout: 5,
  headers: { Authorization: 'Bearer ${PREMISE_KEY}', 'X-Premise-Repo': repoId },
  allowedEnvVars: ['PREMISE_KEY'],
  ...extra,
});
const cmd = (sub, timeout) => ({
  type: 'command',
  command: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/premise-hook.mjs" ${sub}`,
  timeout,
});

const settings = {
  env: { PREMISE_URL: base, PREMISE_REPO: repoId },
  enabledMcpjsonServers: ['premise'],
  hooks: {
    SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [cmd('session-start', 10)] }],
    PostToolUse: [
      { matcher: 'Read', hooks: [http('/hooks/read')] },
      { matcher: 'Edit|Write|MultiEdit', hooks: [http('/hooks/post-edit')] },
    ],
    PreToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [http('/hooks/pre-edit', { onFailure: 'block' })] }],
    Stop: [{ hooks: [cmd('stop', 15)] }],
  },
};

const mcp = {
  mcpServers: {
    premise: { type: 'http', url: `${base}/mcp`, headers: { Authorization: 'Bearer ${PREMISE_KEY}' } },
  },
};

fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
fs.writeFileSync(path.join(dir, '.mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`);
fs.copyFileSync(path.join(here, '..', 'cli', 'premise-hook.mjs'), path.join(dir, '.claude', 'hooks', 'premise-hook.mjs'));
console.log(`Connected ${dir} to ${base}`);
