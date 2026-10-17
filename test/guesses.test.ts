import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postEdit, sessionStart } from '../src/core/activity.ts';
import { findAffected, NotAllowed, supersede } from '../src/core/change.ts';
import { confirmGuess, listGuesses } from '../src/core/guesses.ts';
import { agentRecordRule } from '../src/core/rules.ts';
import { type Db, run } from '../src/db/client.ts';
import { dropTeam, testDb } from './helpers/db.ts';
import { makeWorld, type World, writeEv } from './helpers/world.ts';

// An agent needs the EPF contribution rate, finds no rule, and records 12% from memory as a
// draft linked to the file it is writing. Compliance sees it in the queue with that file, and
// either confirms it in place or corrects it, which finds the file.

let db: Db;
let w: World;
const guess = (id: string, figure: number, folder: string) => ({
  id, title: `EPF contribution rate ${id}`, type: 'regulation' as const, risk: 'high' as const, jurisdiction: 'IN',
  text: `Employee and employer each contribute ${figure}% of basic wages.`, figure, unit: 'percent' as const,
  citation: 'unverified: from memory — EPF Act, 1952, section 6', effectiveFrom: '1952-03-04', status: 'final' as const,
  scope: [folder],
});

beforeAll(async () => {
  db = await testDb();
  w = await makeWorld(db);
  await sessionStart(db, w.asha, { session_id: 'g-asha' });
  await agentRecordRule(db, w.asha, { ...guess('in-epf-rate', 12, 'src/pf'), path: 'src/pf/epf.ts' });
  await postEdit(db, w.asha, writeEv('g-asha', 'src/pf/epf.ts', 'export const EPF_RATE_PERCENT = 12;'));
  await sessionStart(db, w.ben, { session_id: 'g-ben' });
  await agentRecordRule(db, w.ben, { ...guess('in-epf-rate-b', 10, 'src/pf-b'), path: 'src/pf-b/epf.ts' });
  await postEdit(db, w.ben, writeEv('g-ben', 'src/pf-b/epf.ts', 'export const EPF_RATE_B = 10;'));
});
afterAll(async () => { await dropTeam(db, w.teamId); await db.close(); });

describe('the guessed-figures queue', () => {
  it('lists an agent\'s draft with who recorded it and the files built on it; final rules are not listed', async () => {
    const q = await listGuesses(db, w.teamId);
    expect(q.map((g) => g.ruleId).sort()).toEqual(['in-epf-rate', 'in-epf-rate-b']);
    const g = q.find((x) => x.ruleId === 'in-epf-rate')!;
    expect(g.authorName).toBe('Asha');
    expect(g.files).toEqual(['src/pf/epf.ts']);
    expect(g.citation).toMatch(/^unverified/);
  });

  it('only compliance confirms, and only against a real source', async () => {
    await expect(confirmGuess(db, w.asha, 'in-epf-rate', 'EPF Act, 1952, s. 6')).rejects.toThrow(NotAllowed);
    await expect(confirmGuess(db, w.chitra, 'in-epf-rate', 'unverified: still from memory')).rejects.toThrow(NotAllowed);
  });

  it('confirming makes the draft final in place, approved by compliance, and empties it from the queue', async () => {
    expect(await confirmGuess(db, w.chitra, 'in-epf-rate', 'EPF and MP Act, 1952, section 6 (checked 2026-10-17)')).toBe('in-epf-rate@1');
    const [v] = await run<{ status: string; src: string; by: string }>(db.team(w.teamId),
      "MATCH (v:RuleVersion {id: 'in-epf-rate@1'})-[:APPROVED_BY]->(m:Member) RETURN v.status AS status, v.verified_citation AS src, m.name AS by");
    expect(v).toEqual({ status: 'final', src: 'EPF and MP Act, 1952, section 6 (checked 2026-10-17)', by: 'Chitra' });
    expect((await listGuesses(db, w.teamId)).map((g) => g.ruleId)).toEqual(['in-epf-rate-b']);
    await expect(confirmGuess(db, w.chitra, 'in-epf-rate', 'again')).rejects.toThrow(NotAllowed);
  });

  it('a confirmed figure keeps its code: a later change still finds the file', async () => {
    const { found } = await findAffected(db, w.teamId, {
      ruleId: 'in-epf-rate', jurisdiction: 'IN', fromId: 'in-epf-rate@1', toId: 'none', oldFigure: 12, unit: 'percent',
    });
    expect(found.map((f) => f.path)).toEqual(['src/pf/epf.ts']);
  });

  it('correcting a guess is a rule change that finds the code built on the wrong figure', async () => {
    const s = await supersede(db, w.chitra, {
      ruleId: 'in-epf-rate-b', text: 'Employee and employer each contribute 12% of basic wages.', figure: 12, unit: 'percent',
      citation: 'EPF and MP Act, 1952, section 6', effectiveFrom: '1952-03-04', reason: "Corrected an agent's guess", draft: false,
    });
    const [p] = await run<{ from: string }>(db.team(w.teamId),
      'MATCH (:Propagation {id: $id})-[:FROM]->(v) RETURN v.id AS from', { id: s.propagationId });
    expect(p?.from).toBe('in-epf-rate-b@1');
    const { found } = await findAffected(db, w.teamId, {
      ruleId: 'in-epf-rate-b', jurisdiction: 'IN', fromId: 'in-epf-rate-b@1', toId: s.versionId, oldFigure: 10, unit: 'percent',
    });
    expect(found.map((f) => f.path)).toEqual(['src/pf-b/epf.ts']);
    expect(await listGuesses(db, w.teamId)).toEqual([]);
  });
});
