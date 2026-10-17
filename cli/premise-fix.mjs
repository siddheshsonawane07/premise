#!/usr/bin/env node
// premise-fix: put one rule change's proposed fixes on a new branch, for a person to review and
// merge. It works in a separate git worktree, so the developer's checkout and `main` are never
// touched, and it never pushes or merges. A fix whose file has changed since the Reviewer read it
// does not apply, and is listed instead. Needs PREMISE_URL and PREMISE_KEY in the environment.
//
//   premise-fix <rule change id>

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Apply `files` (each a unified diff against the repo root) on a new branch `branch` cut from
 * HEAD, commit what applied, and remove the worktree. The branch is kept only if a fix applied.
 */
export function makeFixBranch({ repo, branch, message, files }) {
  const root = git(repo, ['rev-parse', '--show-toplevel']).trim();
  const base = git(root, ['rev-parse', '--short', 'HEAD']).trim();
  const exists = (() => { try { git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); return true; } catch { return false; } })();
  if (exists) throw new Error(`Branch ${branch} already exists. Delete it or review it first.`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'premise-fix-'));
  const dir = path.join(tmp, 'tree');
  git(root, ['worktree', 'add', '--quiet', '-b', branch, dir, 'HEAD']);
  const applied = [];
  const skipped = [];
  try {
    for (const f of files) {
      const file = path.join(tmp, `${applied.length + skipped.length}.diff`);
      fs.writeFileSync(file, f.patch);
      try {
        git(dir, ['apply', '--check', file]);
        git(dir, ['apply', file]);
        applied.push(f.path);
      } catch (err) {
        skipped.push({ path: f.path, why: String(err.stderr || err.message).trim().split('\n')[0] });
      }
    }
    if (applied.length) {
      git(dir, ['add', '--', ...applied]);
      git(dir, ['commit', '--quiet', '-m', message]);
    }
  } finally {
    git(root, ['worktree', 'remove', '--force', dir]);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!applied.length) git(root, ['branch', '-D', branch]);
  }
  return { branch, base, applied, skipped };
}

async function main() {
  const id = process.argv[2];
  const url = process.env.PREMISE_URL;
  const key = process.env.PREMISE_KEY;
  if (!id) throw new Error('Usage: premise-fix <rule change id>');
  if (!url || !key) throw new Error('PREMISE_URL and PREMISE_KEY must be set');
  const res = await fetch(`${url.replace(/\/$/, '')}/fix/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Premise answered ${res.status}: ${(await res.json().catch(() => ({}))).error ?? ''}`);
  const set = await res.json();
  if (!set.files.length) {
    console.log('The Reviewer proposed no fixes for this rule change. Nothing to do.');
    return;
  }
  const r = makeFixBranch({ repo: process.cwd(), branch: set.branch, message: set.message, files: set.files });
  if (r.applied.length) {
    console.log(`Branch ${r.branch}, cut from ${r.base}: ${r.applied.length} fix${r.applied.length === 1 ? '' : 'es'} committed.`);
    for (const p of r.applied) console.log(`  fixed   ${p}`);
  } else {
    console.log('No fix applied, so no branch was kept.');
  }
  for (const s of r.skipped) console.log(`  skipped ${s.path}: ${s.why} (changed since the Reviewer read it? Fix it by hand.)`);
  if (r.applied.length) console.log(`\nReview it: git diff HEAD...${r.branch}\nPremise never merges; merging is yours.`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`premise-fix: ${err.message}`); process.exit(1); });
}
