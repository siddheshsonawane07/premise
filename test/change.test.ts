import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onRead, postEdit, sessionStart, stopSweep } from '../src/core/activity.ts';
import {
  claimTask, handOff, NotAllowed, receipt, resolveTask, type Review, runPropagation, supersede,
} from '../src/core/change.ts';
import { lookupRule } from '../src/core/rules.ts';
import { why } from '../src/core/why.ts';
import { auditCsv, auditPack } from '../src/core/audit.ts';
import { type Db, run } from '../src/db/client.ts';
import { dropTeam, testDb } from './helpers/db.ts';
import { editEv, makeWorld, readEv, ROOT, type World, writeEv } from './helpers/world.ts';

// The demo's story, as tests: Tilldesk is built, the RBI draft is dry-run, it becomes final,
// tasks open, a typo does not close one, a lookup-and-fix does.

let db: Db;
let w: World;

// Stand-in Reviewer: receipt-email.ts has no figure, everything else needs changing.
const fakeReview: Review = async (_db, _team, job) =>
  job.path.endsWith('receipt-email.ts')
    ? { verdict: 'still_fine', reason: 'No figure in this file' }
    : { verdict: 'needs_change', reason: 'Uses the old limit' };

const IN_DRAFT = {
  ruleId: 'in-cash-load', text: 'Cash loaded into a full-KYC wallet is capped at ₹10,000 a month (draft).',
  figure: 10_000_00, unit: 'paise' as const, citation: 'RBI draft Master Direction on PPIs, 2026-04-22',
  effectiveFrom: '2026-11-14', reason: 'RBI draft cuts cash loading by 80%', draft: true,
};

async function tasks(): Promise<{ path: string; status: string; assignee: string; due: string }[]> {
  return run(db.team(w.teamId), `
    MATCH (t:ReviewTask)-[:FOR]->(f:File) MATCH (t)-[:ASSIGNED]->(m:Member)
    RETURN f.path AS path, t.status AS status, m.name AS assignee, t.due AS due ORDER BY path`, {}, { readOnly: true });
}

beforeAll(async () => {
  db = await testDb();
  w = await makeWorld(db);
  // Build Tilldesk the way the captured sessions will.
  await sessionStart(db, w.asha, { session_id: 'asha-1' });
  await lookupRule(db, w.asha, { rule: 'in-cash-load', path: 'src/wallet/limits.ts' });
  await postEdit(db, w.asha, writeEv('asha-1', 'src/wallet/limits.ts', 'export const CASH_LOAD_MONTHLY_PAISE = 50_000_00;'));
  await onRead(db, w.asha, readEv('asha-1', 'src/wallet/topup.ts'));
  await postEdit(db, w.asha, writeEv('asha-1', 'src/wallet/topup.ts', 'import { CASH_LOAD_MONTHLY_PAISE } from "./limits.ts";'));
  await onRead(db, w.asha, readEv('asha-1', 'src/wallet/receipt-email.ts'));
  await postEdit(db, w.asha, writeEv('asha-1', 'src/wallet/receipt-email.ts', 'export const subject = "Your top-up";'));
  await lookupRule(db, w.asha, { rule: 'in-cash-load', path: 'src/core/cash-intake.ts' });
  await lookupRule(db, w.asha, { rule: 'us-ctr', path: 'src/core/cash-intake.ts' });
  await postEdit(db, w.asha, writeEv('asha-1', 'src/core/cash-intake.ts', 'shared'));
  await stopSweep(db, w.asha, { session_id: 'asha-1', cwd: ROOT, files: [{ path: 'src/wallet/messages.ts', mtimeMs: Date.now() + 5000 }] });
  await sessionStart(db, w.ben, { session_id: 'ben-1' });
  await lookupRule(db, w.ben, { rule: 'cash loading', path: 'src/admin/monthly-compliance.ts' });
  await postEdit(db, w.ben, writeEv('ben-1', 'src/admin/monthly-compliance.ts', 'if (cashLoaded > 40_000_00) alert();'));
  await lookupRule(db, w.ben, { rule: 'us-ctr', path: 'src/markets/us/ctr-report.ts' });
  await postEdit(db, w.ben, writeEv('ben-1', 'src/markets/us/ctr-report.ts', 'if (cash > 10_000_00) file();'));
});
afterAll(async () => { await dropTeam(db, w.teamId); await db.close(); });

describe('a draft: dry run', () => {
  let pid = '';

  it('a developer can only propose a draft, not make it final', async () => {
    await expect(supersede(db, w.asha, { ...IN_DRAFT, draft: false })).rejects.toBeInstanceOf(NotAllowed);
  });

  it('finds every file changed under the old version, opens no tasks, leaves CURRENT', async () => {
    const r = await supersede(db, w.chitra, IN_DRAFT);
    pid = r.propagationId;
    expect(r.versionId).toBe('in-cash-load@2');
    const p = await runPropagation(db, w.teamId, pid, fakeReview);
    expect(p).toMatchObject({ filesTotal: 6, needsReview: 5, cleared: 1, asked: 3, shown: 1, inScope: 1, dryRun: true });
    expect(await tasks()).toEqual([]);
    const [cur] = await run<{ id: string }>(db.team(w.teamId),
      "MATCH (:Rule {id: 'in-cash-load'})-[:CURRENT]->(v) RETURN v.id AS id");
    expect(cur?.id).toBe('in-cash-load@1');
  });

  it('the receipt says so in one sentence', async () => {
    const [p] = await run<Record<string, unknown>>(db.team(w.teamId), 'MATCH (p:Propagation {id: $id}) RETURN p.id AS id', { id: pid });
    expect(p).toBeDefined();
    const { getPropagation } = await import('../src/core/change.ts');
    const text = receipt((await getPropagation(db, w.teamId, pid))!);
    expect(text).toMatch(/^Dry run, no tasks opened\./);
    expect(text).toContain('₹50,000 → ₹10,000');
    expect(text).toContain('6 files were changed under the old version: 5 would need review (3 asked, 1 shown, 1 in scope), 1 the Reviewer would clear');
  });

  it('a US draft never touches India-only files', async () => {
    const r = await supersede(db, w.chitra, {
      ruleId: 'us-ctr', text: 'Hypothetical: report cash over $30,000 (STREAMLINE Act, not enacted).', figure: 30_000_00,
      unit: 'cents', citation: 'H.R. 1799 (hypothetical)', effectiveFrom: '2027-01-01', reason: 'Bill in Congress', draft: true,
    });
    await runPropagation(db, w.teamId, r.propagationId, fakeReview);
    const found = await run<{ path: string }>(db.team(w.teamId),
      'MATCH (:Propagation {id: $id})-[:FOUND]->(f:File) RETURN f.path AS path ORDER BY path', { id: r.propagationId });
    expect(found.map((f) => f.path)).toEqual(['src/core/cash-intake.ts', 'src/markets/us/ctr-report.ts']);
  });
});

describe('final: propagation and tasks', () => {
  let finalPid = '';

  it('moves CURRENT, opens one task per file for the owner, due on the effective date', async () => {
    const r = await supersede(db, w.chitra, { ...IN_DRAFT, text: 'Capped at ₹10,000 a month.', draft: false });
    finalPid = r.propagationId;
    expect(r.versionId).toBe('in-cash-load@3');
    await runPropagation(db, w.teamId, finalPid, fakeReview);
    const t = await tasks();
    expect(t).toHaveLength(6);
    expect(t.find((x) => x.path === 'src/admin/monthly-compliance.ts')).toMatchObject({ assignee: 'Ben', status: 'open', due: '2026-11-14' });
    expect(t.find((x) => x.path === 'src/wallet/receipt-email.ts')?.status).toBe('proposed_clear');
    expect(t.filter((x) => x.status === 'open')).toHaveLength(5);
  });

  it('the typo trap: an unrelated edit does not close the task', async () => {
    await onRead(db, w.asha, readEv('asha-2', 'src/wallet/topup.ts'));
    await postEdit(db, w.asha, editEv('asha-2', 'src/wallet/topup.ts', 'teh', 'the'));
    expect((await tasks()).find((x) => x.path === 'src/wallet/topup.ts')?.status).toBe('open');
  });

  it('a lookup of the OLD version does not close it either', async () => {
    // Ben's session from before the change still has its v1 lookup; a new edit without a new lookup.
    await postEdit(db, w.ben, editEv('ben-1', 'src/admin/monthly-compliance.ts', 'alert()', 'alert(id)'));
    expect((await tasks()).find((x) => x.path === 'src/admin/monthly-compliance.ts')?.status).toBe('open');
  });

  it('a fix after looking up the NEW version closes it', async () => {
    await sessionStart(db, w.ben, { session_id: 'ben-2' });
    const res = await lookupRule(db, w.ben, { rule: 'in-cash-load', path: 'src/admin/monthly-compliance.ts' });
    expect(res.found[0]?.figure).toBe(10_000_00);
    const r = await postEdit(db, w.ben, editEv('ben-2', 'src/admin/monthly-compliance.ts', '40_000_00', '8_000_00'));
    expect(r.resolved).toBe(1);
    expect((await tasks()).find((x) => x.path === 'src/admin/monthly-compliance.ts')?.status).toBe('resolved');
  });

  it('running the final again opens no duplicates and drops the fixed file', async () => {
    await run(db.team(w.teamId), "MATCH (p:Propagation {id: $id}) SET p.status = 'queued'", { id: finalPid });
    const p = await runPropagation(db, w.teamId, finalPid, fakeReview);
    expect(p.filesTotal).toBe(5);
    expect(await tasks()).toHaveLength(6);
  });

  it('a task is resolved only with a reason', async () => {
    const [t] = await run<{ id: string }>(db.team(w.teamId),
      "MATCH (t:ReviewTask {status: 'proposed_clear'}) RETURN t.id AS id");
    await expect(resolveTask(db, w.chitra, t!.id, 'ok')).rejects.toBeInstanceOf(NotAllowed);
    expect(await resolveTask(db, w.chitra, t!.id, 'Confirmed: no figure in the receipt email')).toBe(true);
  });
});

describe('coordination', () => {
  it('50 concurrent claims on one task: exactly one wins (plan §15.3)', async () => {
    const [t] = await run<{ id: string }>(db.team(w.teamId),
      "MATCH (t:ReviewTask {status: 'open'})-[:FOR]->(:File {path: 'src/wallet/limits.ts'}) RETURN t.id AS id");
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => claimTask(db, i % 2 ? w.asha : w.ben, t!.id)));
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(results.filter((r) => !r.claimed).every((r) => r.holder === 'Asha' || r.holder === 'Ben')).toBe(true);
  });
});

describe('why', () => {
  it('returns the path as nodes and edges: change → session → member, RELIED_ON → version, SUPERSEDES', async () => {
    const res = await why(db, w.asha, 'src/wallet/limits.ts');
    const kinds = new Set(res.nodes.map((n) => n.kind));
    for (const k of ['File', 'Change', 'Session', 'Member', 'RuleVersion', 'Rule', 'Jurisdiction', 'ReviewTask']) {
      expect(kinds.has(k)).toBe(true);
    }
    expect(res.edges.some((e) => e.type === 'RELIED_ON' && e.label === 'asked')).toBe(true);
    expect(res.edges.some((e) => e.type === 'SUPERSEDES')).toBe(true);
    expect(res.text).toContain('superseded by');
  });
});

describe('audit evidence', () => {
  it('every version, who approved the final and why, and the changes made under each version', async () => {
    const pack = (await auditPack(db, w.chitra, 'in-cash-load'))!;
    expect(pack.versions.map((v) => [v.versionId, v.status])).toEqual([
      ['in-cash-load@1', 'final'], ['in-cash-load@2', 'draft'], ['in-cash-load@3', 'final'],
    ]);
    expect(pack.versions[2]).toMatchObject({ approvedBy: 'Chitra', supersedes: 'in-cash-load@1' });
    const v1 = pack.versions[0]!;
    expect(v1.changes.find((c) => c.path === 'src/admin/monthly-compliance.ts')).toMatchObject({ tier: 'asked', member: 'Ben' });
    expect(pack.propagations.filter((p) => !p.dryRun)[0]!.tasks.length).toBeGreaterThan(0);
  });

  it('the CSV has a row per change and cannot smuggle a spreadsheet formula', async () => {
    const pack = (await auditPack(db, w.chitra, 'in-cash-load'))!;
    pack.versions[0]!.changes[0]!.member = '=HYPERLINK("x")';
    const csv = auditCsv(pack);
    expect(csv.split('\n')[0]).toContain('"model"');
    expect(csv).toContain('"' + "'" + '=HYPERLINK(""x"")"');
  });

  it('an unknown rule has no evidence pack', async () => {
    expect(await auditPack(db, w.chitra, 'no-such-rule')).toBeUndefined();
  });
});

describe('handoff', () => {
  it('the assignee hands a task on with a note; the claim ends; the next session of the new owner opens with the note', async () => {
    const [t] = await run<{ id: string; who: string }>(db.team(w.teamId),
      "MATCH (t:ReviewTask {status: 'open'})-[:FOR]->(:File {path: 'src/wallet/limits.ts'}) MATCH (t)-[:ASSIGNED]->(m) RETURN t.id AS id, m.name AS who");
    expect(t!.who).toBe('Asha');
    await expect(handOff(db, w.asha, t!.id, 'ben', 'short')).rejects.toBeInstanceOf(NotAllowed);
    const r = await handOff(db, w.asha, t!.id, 'ben', 'Limit moves to 10_000_00; tests in wallet.test.ts need the new boundary too');
    expect(r).toEqual({ fromName: 'Asha', toName: 'Ben' });
    const [claims] = await run<{ live: number }>(db.team(w.teamId),
      'MATCH (c:Claim)-[:ON]->(:ReviewTask {id: $id}) WHERE c.expires_at > $now RETURN count(c) AS live', { id: t!.id, now: Date.now() + 1 });
    expect(claims!.live).toBe(0);
    const ctx = await sessionStart(db, w.ben, { session_id: 'ben-handoff' });
    expect(ctx).toContain('Handed to you by Asha: "Limit moves to 10_000_00');
    expect(ctx).not.toContain('undefined');
  });

  it('someone who is neither the assignee nor compliance cannot hand it on', async () => {
    const [t] = await run<{ id: string }>(db.team(w.teamId),
      "MATCH (t:ReviewTask)-[:FOR]->(:File {path: 'src/wallet/limits.ts'}) MATCH (t)-[:ASSIGNED]->(:Member {name: 'Ben'}) RETURN t.id AS id");
    await expect(handOff(db, w.asha, t!.id, 'asha', 'taking it back without asking')).rejects.toBeInstanceOf(NotAllowed);
  });
});
