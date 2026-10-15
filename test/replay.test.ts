import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db, run } from '../src/db/client.ts';
import { personalLeaks } from '../src/replay/scrub.ts';
import { deleteTeam, seedDemo } from '../src/replay/seed.ts';
import { testDb, uniqueTeamId } from './helpers/db.ts';

// The demo seed is the capture of five real agent sessions building Tilldesk (2026-10-15), and
// Chitra recording the early-warning rule, derived from the RBI limit, between the fourth and fifth.
// Replaying it into an empty team must rebuild the same links the live sessions made.

const EVENTS = 'demo/events/tilldesk.jsonl';
let db: Db;
const teamId = uniqueTeamId('replay');

beforeAll(async () => {
  db = await testDb();
  await seedDemo(db, teamId, EVENTS);
});
afterAll(async () => { await deleteTeam(db, teamId); await db.close(); });

describe('the committed capture', () => {
  it('holds nothing personal: no home directory, no email address', () => {
    expect(personalLeaks(fs.readFileSync(EVENTS, 'utf8'))).toEqual([]);
  });
});

describe('replay rebuilds the live graph', () => {
  it('links each file to the rule versions at the tiers the live sessions recorded', async () => {
    const rows = await run<{ v: string; path: string; tiers: string[] }>(db.team(teamId), `
      MATCH (c:Change)-[r:RELIED_ON]->(v:RuleVersion)
      MATCH (c)-[:TO]->(f:File)
      RETURN v.id AS v, f.path AS path, collect(DISTINCT r.tier) AS tiers
      ORDER BY v, path`, {}, { readOnly: true });
    expect(rows.map((r) => `${r.v} ${r.path} ${r.tiers.join(',')}`)).toEqual([
      'in-cash-load@1 src/admin/monthly-compliance.ts asked',
      'in-cash-load@1 src/admin/weekly-digest.ts asked',
      'in-cash-load@1 src/core/cash-intake.ts asked',
      'in-cash-load@1 src/wallet/index.ts shown',
      'in-cash-load@1 src/wallet/limits.ts asked',
      'in-cash-load@1 src/wallet/messages.ts in_scope',
      'in-cash-load@1 src/wallet/receipt-email.ts shown',
      'in-cash-load@1 src/wallet/topup.ts asked',
      'in-cash-load@1 test/admin.test.ts session',
      'in-cash-load@1 test/core.test.ts session',
      'in-cash-load@1 test/digest.test.ts session',
      'in-cash-load@1 test/wallet.test.ts asked',
      'in-early-warning@1 src/admin/weekly-digest.ts asked',
      'in-early-warning@1 test/digest.test.ts session',
      'us-ctr@1 src/core/cash-intake.ts asked',
      'us-ctr@1 src/markets/us/ctr-report.ts asked',
      'us-ctr@1 test/core.test.ts session',
      'us-ctr@1 test/us.test.ts session',
    ]);
  });

  it('keeps the trap file as the agent wrote it: a bare 40_000_00', async () => {
    const [row] = await run<{ c: string }>(db.team(teamId),
      "MATCH (:File {path: 'src/admin/monthly-compliance.ts'})-[:LATEST]->(s:FileSnapshot) RETURN s.content AS c", {}, { readOnly: true });
    expect(row?.c).toContain('40_000_00');
    expect(row?.c).not.toMatch(/50_000_00|50,000|import|\/\//);
  });
});
