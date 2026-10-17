import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFixBranch } from '../cli/premise-fix.mjs';
import { postEdit, sessionStart } from '../src/core/activity.ts';
import { runPropagation, supersede } from '../src/core/change.ts';
import { fixSet } from '../src/core/fix.ts';
import { lookupRule } from '../src/core/rules.ts';
import { type Db, one, run } from '../src/db/client.ts';
import { TEAM } from '../src/db/queries.ts';
import { diffFromEdits } from '../src/review/fixdiff.ts';
import { dropTeam, testDb } from './helpers/db.ts';
import { makeWorld, type World, writeEv } from './helpers/world.ts';

// One-click fix: the Reviewer's line edits become a real diff; premise-fix applies them on a new
// branch in a separate worktree. The developer's checkout and main are never touched.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const LIMITS = '// Monthly cap.\nexport const LIMIT = 50_000_00;\nexport const NOTE = "₹50,000 a month";\n';

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premise-fix-test-'));
  git(dir, 'init', '--quiet', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/limits.ts'), LIMITS);
  fs.writeFileSync(path.join(dir, 'src/end.ts'), 'export const A = 1;\nexport const B = 50_000_00;');
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'base');
  return dir;
}

describe('diffFromEdits', () => {
  it('turns line replacements into a diff, and returns nothing when nothing changes', () => {
    const d = diffFromEdits('src/limits.ts', LIMITS, [{ line: 2, text: 'export const LIMIT = 10_000_00;' }])!;
    expect(d).toContain('--- a/src/limits.ts\n+++ b/src/limits.ts\n@@ -1,3 +1,3 @@');
    expect(d).toContain('-export const LIMIT = 50_000_00;\n+export const LIMIT = 10_000_00;');
    expect(diffFromEdits('src/limits.ts', LIMITS, [{ line: 2, text: 'export const LIMIT = 50_000_00;' }])).toBeUndefined();
    expect(diffFromEdits('src/limits.ts', LIMITS, [{ line: 99, text: 'x' }])).toBeUndefined();
  });
});

describe('makeFixBranch', () => {
  let dir: string;
  beforeAll(() => { dir = repo(); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('commits the fixes on a new branch, leaving main and the checkout as they were', () => {
    const files = [
      { path: 'src/limits.ts', patch: diffFromEdits('src/limits.ts', LIMITS, [
        { line: 2, text: 'export const LIMIT = 10_000_00;' }, { line: 3, text: 'export const NOTE = "₹10,000 a month";' }])! },
      { path: 'src/end.ts', patch: diffFromEdits('src/end.ts', 'export const A = 1;\nexport const B = 50_000_00;', [
        { line: 2, text: 'export const B = 10_000_00;' }])! },
    ];
    const mainBefore = git(dir, 'rev-parse', 'main');
    const r = makeFixBranch({ repo: dir, branch: 'premise/in-cash-load-v2', message: 'Premise: fix', files });
    expect(r.applied).toEqual(['src/limits.ts', 'src/end.ts']);
    expect(r.skipped).toEqual([]);
    expect(git(dir, 'rev-parse', 'main')).toBe(mainBefore);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(fs.readFileSync(path.join(dir, 'src/limits.ts'), 'utf8')).toBe(LIMITS);
    expect(git(dir, 'show', 'premise/in-cash-load-v2:src/limits.ts')).toContain('LIMIT = 10_000_00;');
    // The file without a final newline keeps having none.
    expect(git(dir, 'show', 'premise/in-cash-load-v2:src/end.ts')).toBe('export const A = 1;\nexport const B = 10_000_00;');
    expect(git(dir, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('refuses to reuse a branch name', () => {
    expect(() => makeFixBranch({ repo: dir, branch: 'premise/in-cash-load-v2', message: 'x', files: [] })).toThrow(/already exists/);
  });

  it('skips a fix whose file changed since it was reviewed, and keeps no branch if nothing applied', () => {
    const stale = diffFromEdits('src/limits.ts', LIMITS.replace('Monthly cap', 'Other text'), [{ line: 2, text: 'x' }])!;
    const r = makeFixBranch({ repo: dir, branch: 'premise/stale', message: 'x', files: [{ path: 'src/limits.ts', patch: stale }] });
    expect(r.applied).toEqual([]);
    expect(r.skipped.map((s: { path: string }) => s.path)).toEqual(['src/limits.ts']);
    expect(git(dir, 'branch', '--list', 'premise/stale').trim()).toBe('');
  });
});

describe('fixSet', () => {
  let db: Db;
  let w: World;
  beforeAll(async () => {
    db = await testDb();
    w = await makeWorld(db);
    await sessionStart(db, w.asha, { session_id: 'fx-asha' });
    await lookupRule(db, w.asha, { rule: 'in-cash-load', path: 'src/wallet/limits.ts' });
    await postEdit(db, w.asha, writeEv('fx-asha', 'src/wallet/limits.ts', LIMITS));
    await lookupRule(db, w.asha, { rule: 'in-cash-load', path: 'src/wallet/fine.ts' });
    await postEdit(db, w.asha, writeEv('fx-asha', 'src/wallet/fine.ts', 'export const x = 1;'));
  });
  afterAll(async () => { await dropTeam(db, w.teamId); await db.close(); });

  it('collects the needs_change patches of a finished rule change, with a branch name and message', async () => {
    const s = await supersede(db, w.chitra, {
      ruleId: 'in-cash-load', text: 'Capped at ₹10,000 a month.', figure: 10_000_00, unit: 'paise',
      citation: 'RBI draft', effectiveFrom: '2026-11-14', reason: 'test', draft: true,
    });
    // A stand-in for the Reviewer, which stores its verdict on the snapshot it read (TEAM.writeVerdict).
    await runPropagation(db, w.teamId, s.propagationId, async (_d, _t, job) => {
      const fixes = job.path === 'src/wallet/limits.ts';
      const v = fixes
        ? { verdict: 'needs_change' as const, reason: 'Line 2 holds ₹50,000.', patch: diffFromEdits(job.path, LIMITS, [{ line: 2, text: 'export const LIMIT = 10_000_00;' }])! }
        : { verdict: 'still_fine' as const, reason: 'No figure.' };
      const snap = await one<{ hash: string }>(db.team(w.teamId), TEAM.latestSnapshot, { path: job.path });
      await run(db.team(w.teamId), TEAM.writeVerdict, {
        id: `${snap!.hash.slice(0, 24)}:${job.toId}:test`, hash: snap!.hash, versionId: job.toId, verdict: v.verdict,
        reason: v.reason, model: 'test', promptVersion: 'test', at: Date.now(), patch: 'patch' in v ? { patch: v.patch } : {},
      });
      return v;
    });
    const set = (await fixSet(db, w.teamId, s.propagationId))!;
    expect(set.branch).toBe('premise/in-cash-load-v2');
    expect(set.files.map((f) => f.path)).toEqual(['src/wallet/limits.ts']);
    expect(set.message).toContain('₹50,000 → ₹10,000');
    expect(set.message).toContain('it never merges');
    expect(await fixSet(db, w.teamId, 'no-such-id')).toBeUndefined();
  });
});
