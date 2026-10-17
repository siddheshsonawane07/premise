import type { Db } from '../db/client.ts';
import { run } from '../db/client.ts';
import { TEAM } from '../db/queries.ts';
import { getPropagation } from './change.ts';
import { formatFigure } from './rules.ts';

// One rule change's proposed fixes, for `premise-fix` to put on a branch. Premise never has the
// code; the developer's machine applies them, on a new branch, and a person merges or not.

export interface FixSet {
  propagationId: string;
  ruleId: string;
  toId: string;
  branch: string;
  message: string;
  files: { path: string; patch: string; reason: string }[];
}

export async function fixSet(db: Db, teamId: string, propagationId: string): Promise<FixSet | undefined> {
  const p = await getPropagation(db, teamId, propagationId);
  if (!p || p.status !== 'done') return undefined;
  const rows = await run<{ path: string; verdict?: string; reason?: string; patch?: string }>(
    db.team(teamId), TEAM.findings, { id: propagationId }, { readOnly: true });
  const files = rows
    .filter((r) => r.verdict === 'needs_change' && r.patch)
    .map((r) => ({ path: r.path, patch: r.patch!, reason: r.reason ?? '' }));
  const from = formatFigure(p.oldFigure, p.unit).replace(/ \(.*\)$/, '');
  const to = formatFigure(p.newFigure, p.unit).replace(/ \(.*\)$/, '');
  const change = from && to ? `${from} → ${to}` : `${p.fromId} → ${p.toId}`;
  const message = [
    `Premise: ${p.title} (${p.jurisdiction}), ${change}`,
    '',
    `Fixes proposed by Premise's Reviewer for rule change ${p.toId} (${p.citation}).`,
    'Review every line before merging. Premise made this branch; it never merges.',
    '',
    ...files.map((f) => `- ${f.path}: ${f.reason}`),
  ].join('\n');
  return {
    propagationId, ruleId: p.ruleId, toId: p.toId,
    branch: `premise/${p.toId.replace('@', '-v')}`, message, files,
  };
}
