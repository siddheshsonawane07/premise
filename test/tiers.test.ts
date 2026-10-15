import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onRead, postEdit, preEdit, sessionStart, stopSweep } from '../src/core/activity.ts';
import { lookupRule } from '../src/core/rules.ts';
import { type Db, run } from '../src/db/client.ts';
import { dropTeam, testDb } from './helpers/db.ts';
import { editEv, makeWorld, readEv, ROOT, type World, writeEv } from './helpers/world.ts';

// IMPLEMENTATION_PLAN §15.2: the product's claim is that each edit is linked to the rules it
// relied on, at the right strength. These are the cases.

let db: Db;
let w: World;

beforeAll(async () => { db = await testDb(); w = await makeWorld(db); });
afterAll(async () => { await dropTeam(db, w.teamId); await db.close(); });

async function tiersOf(changeId: string): Promise<Record<string, string>> {
  const rows = await run<{ v: string; tier: string }>(db.team(w.teamId),
    'MATCH (:Change {id: $id})-[r:RELIED_ON]->(v:RuleVersion) RETURN v.id AS v, r.tier AS tier', { id: changeId });
  return Object.fromEntries(rows.map((r) => [r.v, r.tier]));
}

describe('session start', () => {
  it('opens the session and tells the agent to look figures up', async () => {
    const ctx = await sessionStart(db, w.asha, { session_id: 's-start' });
    expect(ctx).toMatch(/rule_lookup/);
  });
});

describe('reading a governed file', () => {
  it('shows the rule in scope, with figure and citation', async () => {
    const ctx = await onRead(db, w.asha, readEv('s-read', 'src/wallet/topup.ts'));
    expect(ctx).toContain('₹50,000');
    expect(ctx).toContain('RBI Master Direction on PPIs, 2021');
    expect(ctx).not.toContain('Currency transaction');
  });

  it('shows nothing for an ungoverned file', async () => {
    expect(await onRead(db, w.asha, readEv('s-read', 'src/index.ts'))).toBeUndefined();
  });
});

describe('the edit guard', () => {
  it('denies once when the rule was not shown, then allows the retry', async () => {
    const ev = editEv('s-guard', 'src/wallet/limits.ts');
    const first = await preEdit(db, w.asha, ev);
    expect(first.decision).toBe('deny');
    expect(first.decision === 'deny' && first.reason).toContain('₹50,000');
    expect((await preEdit(db, w.asha, ev)).decision).toBe('allow');
  });

  it('allows an ungoverned file straight away', async () => {
    expect((await preEdit(db, w.asha, editEv('s-guard2', 'README.md'))).decision).toBe('allow');
  });
});

describe('tiers (plan §15.2)', () => {
  it('lookup for this path by this member, then edit → asked', async () => {
    await sessionStart(db, w.asha, { session_id: 's-a1' });
    await lookupRule(db, w.asha, { rule: 'in-cash-load', path: 'src/wallet/limits.ts' });
    const ev = editEv('s-a1', 'src/wallet/limits.ts');
    await postEdit(db, w.asha, ev);
    expect(await tiersOf(ev.tool_use_id!)).toEqual({ 'in-cash-load@1': 'asked' });
  });

  it('lookup by another member does not make it asked', async () => {
    await sessionStart(db, w.ben, { session_id: 's-b1' });
    await lookupRule(db, w.asha, { rule: 'in-cash-load', path: 'src/wallet/fees.ts' });
    const ev = editEv('s-b1', 'src/wallet/fees.ts');
    await postEdit(db, w.ben, ev);
    expect(await tiersOf(ev.tool_use_id!)).toEqual({ 'in-cash-load@1': 'in_scope' });
  });

  it('lookup for another path does not make this one asked', async () => {
    await sessionStart(db, w.asha, { session_id: 's-a2' });
    await lookupRule(db, w.asha, { rule: 'in-cash-load', path: 'src/wallet/other.ts' });
    const ev = editEv('s-a2', 'src/wallet/messages.ts');
    await postEdit(db, w.asha, ev);
    expect(await tiersOf(ev.tool_use_id!)).toEqual({ 'in-cash-load@1': 'in_scope' });
  });

  it('read (shown), then edit → shown', async () => {
    await onRead(db, w.asha, readEv('s-a3', 'src/wallet/topup.ts'));
    const ev = editEv('s-a3', 'src/wallet/topup.ts');
    await postEdit(db, w.asha, ev);
    expect(await tiersOf(ev.tool_use_id!)).toEqual({ 'in-cash-load@1': 'shown' });
  });

  it('denied once (the deny showed it), then edit → shown', async () => {
    const ev = editEv('s-a4', 'src/wallet/receipt-email.ts');
    await preEdit(db, w.asha, ev);
    await postEdit(db, w.asha, ev);
    expect(await tiersOf(ev.tool_use_id!)).toEqual({ 'in-cash-load@1': 'shown' });
  });

  it('a lookup outside the scope links the file as asked and proposes a scope', async () => {
    await sessionStart(db, w.ben, { session_id: 's-b2' });
    const res = await lookupRule(db, w.ben, { rule: 'cash loading', path: 'src/admin/monthly-compliance.ts' });
    expect(res.found[0]?.figure).toBe(50_000_00);
    expect(res.proposedScope).toBe('src/admin/monthly-compliance.ts');
    const ev = writeEv('s-b2', 'src/admin/monthly-compliance.ts', 'if (cashLoaded > 40_000_00) alert();');
    await postEdit(db, w.ben, ev);
    expect(await tiersOf(ev.tool_use_id!)).toEqual({ 'in-cash-load@1': 'asked' });
  });

  it('a shared folder serving India and the US relies on both rules', async () => {
    await sessionStart(db, w.asha, { session_id: 's-a5' });
    await lookupRule(db, w.asha, { rule: 'in-cash-load', path: 'src/core/cash-intake.ts' });
    await lookupRule(db, w.asha, { rule: 'us-ctr', path: 'src/core/cash-intake.ts' });
    const ev = writeEv('s-a5', 'src/core/cash-intake.ts', 'shared');
    await postEdit(db, w.asha, ev);
    expect(await tiersOf(ev.tool_use_id!)).toEqual({ 'in-cash-load@1': 'asked', 'us-ctr@1': 'asked' });
  });

  it('a US folder never sees the India rule', async () => {
    const ctx = await onRead(db, w.ben, readEv('s-b3', 'src/markets/us/ctr-report.ts'));
    expect(ctx).toContain('$10,000');
    expect(ctx).not.toContain('₹');
  });

  it('a retried hook with the same tool_use_id records one change', async () => {
    const ev = editEv('s-a6', 'src/wallet/topup.ts');
    await postEdit(db, w.asha, ev);
    const again = await postEdit(db, w.asha, ev);
    expect(again.duplicate).toBe(true);
    const [row] = await run<{ n: number }>(db.team(w.teamId), 'MATCH (c:Change {id: $id}) RETURN count(c) AS n', { id: ev.tool_use_id });
    expect(row?.n).toBe(1);
  });

  it('a hand edit caught at Stop → in_scope', async () => {
    await sessionStart(db, w.asha, { session_id: 's-a7' });
    const recorded = await stopSweep(db, w.asha, {
      session_id: 's-a7', cwd: ROOT,
      files: [{ path: 'src/wallet/messages.ts', mtimeMs: Date.now() + 60_000 }, { path: 'src/index.ts', mtimeMs: Date.now() + 1000 }],
    });
    expect(recorded).toEqual(['src/wallet/messages.ts']);
    const [stopId] = await run<{ id: string }>(db.team(w.teamId), "MATCH (c:Change) WHERE c.id STARTS WITH 'stop:s-a7:src/wallet/messages.ts' RETURN c.id AS id");
    expect(await tiersOf(stopId!.id)).toEqual({ 'in-cash-load@1': 'in_scope' });
  });

  it('stores only repo-relative paths', async () => {
    const [row] = await run<{ n: number }>(db.team(w.teamId),
      "MATCH (f) WHERE f.path STARTS WITH '/' RETURN count(f) AS n");
    expect(row?.n).toBe(0);
  });

  it('keeps the latest content of an edited file for the Reviewer', async () => {
    const ev = editEv('s-a8', 'src/wallet/limits.ts', '50_000_00', '10_000_00', 'export const L = 50_000_00;');
    await postEdit(db, w.asha, ev);
    const [row] = await run<{ c: string }>(db.team(w.teamId),
      "MATCH (:File {path: 'src/wallet/limits.ts'})-[:LATEST]->(s:FileSnapshot) RETURN s.content AS c");
    expect(row?.c).toBe('export const L = 10_000_00;');
  });
});
