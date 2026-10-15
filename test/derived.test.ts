import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postEdit, sessionStart } from '../src/core/activity.ts';
import { getPropagation, receipt, type ReviewJob, runPropagation, supersede } from '../src/core/change.ts';
import { lookupRule, recordRule } from '../src/core/rules.ts';
import { type Db, run } from '../src/db/client.ts';
import { dropTeam, testDb } from './helpers/db.ts';
import { makeWorld, type World, writeEv } from './helpers/world.ts';

// A rule built on another: Tilldesk's early-warning alert fires at 80% of the RBI cash limit.
// Code written under the alert rule never relied on the RBI rule, yet the RBI change makes it
// wrong. Premise follows DERIVES_FROM to find it.

let db: Db;
let w: World;
const jobs: ReviewJob[] = [];

beforeAll(async () => {
  db = await testDb();
  w = await makeWorld(db);
  await recordRule(db, w.chitra, {
    id: 'in-early-warning', title: 'Early-warning alert for wallet cash loading', type: 'decision', owner: w.chitra.memberId,
    risk: 'medium', jurisdiction: 'IN', text: 'Ops are alerted when a customer passes 80% of the monthly cash-loading limit.',
    figure: 80, unit: 'percent', citation: 'Tilldesk compliance policy CP-7', effectiveFrom: '2025-01-01', status: 'final',
    scope: ['src/admin'], derivesFrom: 'in-cash-load', how: '80% of the limit',
  });
  await sessionStart(db, w.asha, { session_id: 'd-asha' });
  await lookupRule(db, w.asha, { rule: 'in-cash-load', path: 'src/wallet/limits.ts' });
  await postEdit(db, w.asha, writeEv('d-asha', 'src/wallet/limits.ts', 'export const LIMIT = 50_000_00;'));
  // Ben writes a digest under the alert rule only.
  await sessionStart(db, w.ben, { session_id: 'd-ben' });
  await lookupRule(db, w.ben, { rule: 'early warning', path: 'src/admin/weekly-digest.ts' });
  await postEdit(db, w.ben, writeEv('d-ben', 'src/admin/weekly-digest.ts', 'const THRESHOLD = 40_000_00;'));
});
afterAll(async () => { await dropTeam(db, w.teamId); await db.close(); });

describe('derived rules', () => {
  it('the alert rule is linked to the RBI rule it is built on', async () => {
    const [row] = await run<{ how: string }>(db.team(w.teamId),
      "MATCH (:Rule {id: 'in-early-warning'})-[e:DERIVES_FROM]->(:Rule {id: 'in-cash-load'}) RETURN e.how AS how");
    expect(row?.how).toBe('80% of the limit');
  });

  it('the digest relied only on the alert rule, never on the RBI rule', async () => {
    const rows = await run<{ v: string }>(db.team(w.teamId),
      "MATCH (:File {path: 'src/admin/weekly-digest.ts'})<-[:TO]-(:Change)-[:RELIED_ON]->(v) RETURN v.id AS v");
    expect(rows.map((r) => r.v)).toEqual(['in-early-warning@1']);
  });

  it('a change to the RBI rule still finds it, through the derived rule, and says so', async () => {
    const s = await supersede(db, w.chitra, {
      ruleId: 'in-cash-load', text: 'Capped at ₹10,000 a month.', figure: 10_000_00, unit: 'paise',
      citation: 'RBI draft', effectiveFrom: '2026-11-14', reason: 'draft', draft: true,
    });
    await runPropagation(db, w.teamId, s.propagationId, async (_d, _t, job) => {
      jobs.push(job);
      return { verdict: 'needs_change', reason: 'fake' };
    });
    const found = await run<{ path: string; via: string }>(db.team(w.teamId),
      'MATCH (:Propagation {id: $id})-[e:FOUND]->(f:File) RETURN f.path AS path, e.via AS via ORDER BY path', { id: s.propagationId });
    expect(found).toEqual([
      { path: 'src/admin/weekly-digest.ts', via: 'in-early-warning' },
      { path: 'src/wallet/limits.ts', via: '' },
    ]);
    const text = receipt((await getPropagation(db, w.teamId, s.propagationId))!);
    expect(text).toContain('1 only through a rule derived from this one');
  });

  it('the Reviewer is told which derived rule linked the file, and how', () => {
    const job = jobs.find((j) => j.path === 'src/admin/weekly-digest.ts');
    expect(job?.via?.[0]).toMatchObject({ ruleId: 'in-early-warning', how: ['80% of the limit'] });
  });
});
