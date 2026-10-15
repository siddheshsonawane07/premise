import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onRead, postEdit } from '../src/core/activity.ts';
import { runPropagation } from '../src/core/change.ts';
import { globToFolder, importRules, parseRuleFile } from '../src/core/import.ts';
import { type Db, run } from '../src/db/client.ts';
import { dropTeam, testDb } from './helpers/db.ts';
import { makeWorld, readEv, type World, writeEv } from './helpers/world.ts';

// "Your CLAUDE.md is a wish list": a team's rules files become versioned graph rules, shown to
// agents and linked to code like any regulation; when a rules file changes, code written under
// the old convention is found.

let db: Db;
let w: World;
let repo: string;

const MONEY_V1 = `---
paths:
  - "src/**"
---
# Money is integer minor units
Store money as integer paise or cents, never floats. Write ₹1,234.50 as 1_234_50.
`;

beforeAll(async () => {
  db = await testDb();
  w = await makeWorld(db);
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'premise-import-'));
  fs.mkdirSync(path.join(repo, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'rules', 'money.md'), MONEY_V1);
  fs.writeFileSync(path.join(repo, '.claude', 'rules', 'naming.md'), '---\npaths: ["src/wallet/**", "test/**/*.ts"]\n---\n# Naming\nUse camelCase.\n');
});
afterAll(async () => { await dropTeam(db, w.teamId); await db.close(); fs.rmSync(repo, { recursive: true, force: true }); });

describe('parsing rules files', () => {
  it('reads paths in list, inline and single form, and turns globs into folders', () => {
    expect(parseRuleFile('.claude/rules/money.md', MONEY_V1)).toMatchObject({ id: 'team-money', title: 'Money is integer minor units', scope: ['src'] });
    expect(parseRuleFile('x.md', '---\npaths: ["src/wallet/**", "test/**/*.ts"]\n---\nbody').scope).toEqual(['src/wallet', 'test']);
    expect(parseRuleFile('x.md', '---\npaths: "lib/**"\n---\nbody').scope).toEqual(['lib']);
    expect(globToFolder('**/*.ts')).toBe('.');
    expect(globToFolder('src/wallet/limits.ts')).toBe('src/wallet');
  });
});

describe('importing', () => {
  it('creates a rule per file, scoped by its paths, shown to an agent reading a file in scope', async () => {
    const res = await importRules(db, w.chitra, repo);
    expect(res.map((r) => [r.ruleId, r.action])).toEqual([['team-money', 'created'], ['team-naming', 'created']]);
    const ctx = await onRead(db, w.asha, readEv('imp-1', 'src/markets/us/x.ts'));
    expect(ctx).toContain('Money is integer minor units');
    expect(ctx).toContain('[TEAM]');
  });

  it('running it again with nothing changed records nothing', async () => {
    expect((await importRules(db, w.chitra, repo)).map((r) => r.action)).toEqual(['unchanged', 'unchanged']);
  });

  it('a changed rules file becomes a new version, and code written under the old one is found', async () => {
    await postEdit(db, w.asha, writeEv('imp-1', 'src/markets/us/x.ts', 'const amount = 1_234_50;'));
    fs.writeFileSync(path.join(repo, '.claude', 'rules', 'money.md'), MONEY_V1.replace('never floats.', 'never floats; use the Money type.'));
    const res = await importRules(db, w.chitra, repo);
    const changed = res.find((r) => r.ruleId === 'team-money')!;
    expect(changed.action).toBe('new version');
    const p = await runPropagation(db, w.teamId, changed.propagationId!);
    expect(p.filesTotal).toBe(1);
    const [v] = await run<{ id: string }>(db.team(w.teamId), "MATCH (:Rule {id: 'team-money'})-[:CURRENT]->(v) RETURN v.id AS id");
    expect(v?.id).toBe('team-money@2');
  });
});
