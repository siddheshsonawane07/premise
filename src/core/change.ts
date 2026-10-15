import { randomUUID } from 'node:crypto';
import type { Principal } from '../auth.ts';
import { type Db, one, run } from '../db/client.ts';
import { TEAM } from '../db/queries.ts';
import { figureProps, formatFigure, type Status, type Unit, versionHash } from './rules.ts';
import type { Tier } from './activity.ts';

// A rule changes: a draft gets a dry run (what would change, no tasks); a final moves CURRENT
// and opens a review task per affected file, due on the new version's effective date.

export class NotAllowed extends Error {}

export interface Supersede {
  ruleId: string;
  text: string;
  figure?: number;
  unit?: Unit;
  citation: string;
  effectiveFrom: string;
  reason: string;
  draft: boolean;
}

export async function supersede(db: Db, who: Principal, s: Supersede): Promise<{ versionId: string; propagationId: string }> {
  // Developers' agents may propose (a draft); only the compliance role makes a rule final.
  if (!s.draft && who.role !== 'compliance') {
    throw new NotAllowed('Only a compliance member can make a rule change final. Record it as a draft.');
  }
  const status: Status = s.draft ? 'draft' : 'final';
  const row = await one<{ versionId: string; propagationId: string }>(db.team(who.teamId), TEAM.supersede, {
    ruleId: s.ruleId, text: s.text, hash: versionHash(s.text, s.figure), at: Date.now(), author: who.memberId,
    citation: s.citation, effectiveFrom: s.effectiveFrom, status, figure: figureProps(s.figure, s.unit),
    reason: s.reason, propagationId: randomUUID(), dryRun: s.draft,
  });
  if (!row) throw new Error(`Unknown rule ${s.ruleId}`);
  return row;
}

export interface Verdict {
  verdict: 'needs_change' | 'still_fine' | 'unknown';
  reason: string;
  patch?: string;
  id?: string;
}

/** Decides one file. The real Reviewer calls a model; without one, every verdict is `unknown`. */
export type Review = (db: Db, teamId: string, job: ReviewJob) => Promise<Verdict>;

export interface ReviewJob {
  propagationId: string;
  ruleId: string;
  title: string;
  jurisdiction: string;
  fromId: string;
  toId: string;
  oldText: string;
  newText: string;
  oldFigure?: number;
  newFigure?: number;
  unit?: string;
  path: string;
}

export const noReviewer: Review = async () => ({ verdict: 'unknown', reason: 'No reviewer model is configured' });

export interface PropagationView {
  id: string;
  status: string;
  dryRun: boolean;
  at: number;
  ruleId: string;
  title: string;
  jurisdiction: string;
  fromId: string;
  toId: string;
  oldFigure?: number;
  newFigure?: number;
  unit?: string;
  newStatus: string;
  effectiveFrom: string;
  oldText: string;
  newText: string;
  citation: string;
  filesTotal?: number;
  needsReview?: number;
  cleared?: number;
  asked?: number;
  shown?: number;
  inScope?: number;
  session?: number;
  unknown?: number;
}

export interface Finding { path: string; tier: Tier; ownerId: string; ownerName: string }

export async function getPropagation(db: Db, teamId: string, id: string): Promise<PropagationView | undefined> {
  return one<PropagationView>(db.team(teamId), TEAM.propagation, { id }, { readOnly: true });
}

/**
 * Run one propagation, fresh from the graph (a final never reuses a dry run's findings).
 * Idempotent: findings are merged, tasks are opened only once per file and version, and
 * verdicts are cached by file content and rule version.
 */
export async function runPropagation(db: Db, teamId: string, id: string, review: Review = noReviewer): Promise<PropagationView> {
  const g = db.team(teamId);
  const p = await getPropagation(db, teamId, id);
  if (!p) throw new Error(`Unknown propagation ${id}`);
  await run(g, TEAM.setPropagationStatus, { id, status: 'running' });

  const found = await run<Finding>(g, TEAM.affectedFiles, { fromId: p.fromId, toId: p.toId }, { readOnly: true });
  for (let i = 0; i < found.length; i += 50) {
    await run(g, TEAM.writeFindings, {
      id, files: found.slice(i, i + 50).map((f) => ({ path: f.path, tier: f.tier, owner: f.ownerName })),
    });
  }

  const verdicts = new Map<string, Verdict>();
  for (let i = 0; i < found.length; i += 3) {
    const batch = found.slice(i, i + 3);
    const results = await Promise.all(batch.map((f) => review(db, teamId, {
      propagationId: id, ruleId: p.ruleId, title: p.title, jurisdiction: p.jurisdiction, fromId: p.fromId, toId: p.toId,
      oldText: p.oldText, newText: p.newText, oldFigure: p.oldFigure, newFigure: p.newFigure, unit: p.unit, path: f.path,
    }).catch((err): Verdict => ({ verdict: 'unknown', reason: `Reviewer failed: ${err instanceof Error ? err.message : err}` }))));
    batch.forEach((f, j) => verdicts.set(f.path, results[j]!));
  }

  if (!p.dryRun) {
    for (const f of found) {
      const v = verdicts.get(f.path)!;
      const task = await one<{ taskId: string }>(g, TEAM.openTask, {
        propagationId: id, path: f.path, assignee: f.ownerId, tier: f.tier, due: p.effectiveFrom,
        taskId: `task-${randomUUID().slice(0, 8)}`,
        // The Reviewer proposes; a person confirms (plan D4).
        status: v.verdict === 'still_fine' ? 'proposed_clear' : 'open',
      });
      if (task && v.id) await run(g, TEAM.attachVerdict, { taskId: task.taskId, verdictId: v.id });
    }
  }

  const cleared = found.filter((f) => verdicts.get(f.path)?.verdict === 'still_fine');
  const review_ = found.filter((f) => verdicts.get(f.path)?.verdict !== 'still_fine');
  await run(g, TEAM.finishPropagation, {
    id,
    filesTotal: found.length,
    needsReview: review_.length,
    cleared: cleared.length,
    asked: review_.filter((f) => f.tier === 'asked').length,
    shown: review_.filter((f) => f.tier === 'shown').length,
    inScope: review_.filter((f) => f.tier === 'in_scope').length,
    session: review_.filter((f) => f.tier === 'session').length,
    unknown: found.filter((f) => verdicts.get(f.path)?.verdict === 'unknown').length,
  });
  return (await getPropagation(db, teamId, id))!;
}

/** The receipt: one sentence built only from the counts and the two versions. */
export function receipt(p: PropagationView, now = Date.now()): string {
  const from = formatFigure(p.oldFigure, p.unit).replace(/ \(.*\)$/, '');
  const to = formatFigure(p.newFigure, p.unit).replace(/ \(.*\)$/, '');
  const what = `${p.title} (${p.jurisdiction}): ${from || 'old version'} → ${to || 'new version'}.`;
  if (p.status !== 'done') return `${what} Propagation ${p.status}.`;
  const tiers = [
    p.asked ? `${p.asked} asked` : '', p.shown ? `${p.shown} shown` : '', p.inScope ? `${p.inScope} in scope` : '',
    p.session ? `${p.session} same session` : '',
  ].filter(Boolean).join(', ');
  const total = p.filesTotal ?? 0;
  const head = `${total} file${total === 1 ? ' was' : 's were'} changed under the old version`;
  const review = `${p.needsReview ?? 0} ${p.dryRun ? 'would need' : 'need'} review${tiers ? ` (${tiers})` : ''}`;
  const cleared = p.cleared ? `, ${p.cleared} the Reviewer ${p.dryRun ? 'would clear' : 'proposes to clear'}` : '';
  if (p.dryRun) return `Dry run, no tasks opened. ${what} ${head}: ${review}${cleared}.`;
  const days = Math.ceil((Date.parse(`${p.effectiveFrom}T00:00:00Z`) - now) / 86_400_000);
  const due = days >= 0 ? ` Due in ${days} days (${p.effectiveFrom}).` : ` Effective since ${p.effectiveFrom}.`;
  return `${what} ${head}: ${review}${cleared}.${due}`;
}

export async function claimTask(db: Db, who: Principal, taskId: string, minutes = 30): Promise<{ claimed: boolean; holder?: string }> {
  const now = Date.now();
  const row = await one<{ claimId: string }>(db.team(who.teamId), TEAM.claimTask, {
    taskId, member: who.memberId, now, expires: now + Math.min(Math.max(minutes, 1), 240) * 60_000, claimId: randomUUID(),
  });
  if (row) return { claimed: true };
  const holder = await one<{ name: string }>(db.team(who.teamId), TEAM.claimHolder, { taskId, now }, { readOnly: true });
  return { claimed: false, holder: holder?.name };
}

export async function resolveTask(db: Db, who: Principal, taskId: string, reason: string): Promise<boolean> {
  if (reason.trim().length < 10) throw new NotAllowed('A task is resolved only with a reason (at least 10 characters).');
  const row = await one(db.team(who.teamId), TEAM.resolveTask, { taskId, reason: reason.trim(), at: Date.now(), member: who.memberId });
  return Boolean(row);
}
