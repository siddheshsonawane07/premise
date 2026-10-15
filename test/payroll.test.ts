import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findAffected } from '../src/core/change.ts';
import { type Db, run } from '../src/db/client.ts';
import { personalLeaks } from '../src/replay/scrub.ts';
import { deleteTeam, seedDemo } from '../src/replay/seed.ts';
import { PAYROLL } from '../demo/payroll.ts';
import { testDb, uniqueTeamId } from './helpers/db.ts';

// The second test (demo/payroll/PROTOCOL.md): five sessions built Tallyroll under a protocol
// fixed in advance. Replaying the capture must give the result reported there, against the answer
// key written before measuring.

const EVENTS = 'demo/events/tallyroll.jsonl';
const KEY = JSON.parse(fs.readFileSync('demo/payroll/answer-key.json', 'utf8')) as { changes: { rule: string; needsChange: string[] }[] };
let db: Db;
const teamId = uniqueTeamId('payroll');

beforeAll(async () => {
  db = await testDb();
  await seedDemo(db, teamId, EVENTS, PAYROLL);
});
afterAll(async () => { await deleteTeam(db, teamId); await db.close(); });

async function premiseFinds(ruleId: string): Promise<string[]> {
  const [v1] = await run<{ figure: number; unit: string; jurisdiction: string }>(db.team(teamId),
    'MATCH (r:Rule {id: $id})-[:APPLIES_IN]->(j) MATCH (v:RuleVersion {id: $v}) RETURN v.figure AS figure, v.unit AS unit, j.code AS jurisdiction',
    { id: ruleId, v: `${ruleId}@1` }, { readOnly: true });
  const { found } = await findAffected(db, teamId, {
    ruleId, jurisdiction: v1!.jurisdiction, fromId: `${ruleId}@1`, toId: 'none', oldFigure: v1!.figure, unit: v1!.unit, authorId: 'x',
  });
  return found.map((f) => f.path);
}

describe('Tallyroll, replayed', () => {
  it('holds nothing personal', () => {
    expect(personalLeaks(fs.readFileSync(EVENTS, 'utf8'))).toEqual([]);
  });

  it('EPF ceiling: every file in the answer key, plus the five that import the constant', async () => {
    const found = await premiseFinds('in-epf-ceiling');
    expect(found).toEqual(expect.arrayContaining(KEY.changes[0]!.needsChange));
    expect(found.filter((f) => !KEY.changes[0]!.needsChange.includes(f)).sort()).toEqual([
      'src/hr/onboarding.ts', 'src/in/esi.ts', 'src/in/payslip.ts', 'src/reports/compliance.ts', 'test/esi.test.ts',
    ]);
  });

  it('FLSA level: all four, including the tests that write it as $35,568 a year', async () => {
    const found = await premiseFinds('us-flsa-salary');
    expect(found).toEqual(expect.arrayContaining(KEY.changes[1]!.needsChange));
    expect(found.filter((f) => !KEY.changes[1]!.needsChange.includes(f)).sort()).toEqual([
      'src/hr/onboarding.ts', 'src/reports/compliance.ts',
    ]);
  });

  it('the figures the agents recorded themselves are drafts, never final', async () => {
    const rows = await run<{ id: string; status: string }>(db.team(teamId),
      "MATCH (r:Rule)-[:CURRENT]->(v:RuleVersion) WHERE NOT r.id IN ['in-epf-ceiling', 'in-esi-ceiling', 'us-flsa-salary'] RETURN r.id AS id, v.status AS status",
      {}, { readOnly: true });
    expect(rows.length).toBe(8);
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(['draft']));
  });
});
