import type { Principal } from '../auth.ts';
import { type Db, run } from '../db/client.ts';
import { TEAM } from '../db/queries.ts';
import { formatFigure } from './rules.ts';

// why(path): the chain behind a file's latest changes, as the nodes and edges it came
// through (STRICT 4.4), plus the same chain in words.

export interface GNode { id: string; kind: string; label: string }
export interface GEdge { from: string; to: string; type: string; label?: string }
export interface Why { path: string; nodes: GNode[]; edges: GEdge[]; text: string }

interface ChangeRow {
  changeId: string; at: number; diff: string; sessionId: string; tool?: string; memberId: string; member: string;
  tier?: string; versionId?: string; n?: number; figure?: number; unit?: string; status?: string; citation?: string;
  ruleId?: string; title?: string; jurisdiction?: string; supersededBy: string[];
}
interface TaskRow {
  taskId: string; status: string; due: string; tier: string; assignee: string; versionId: string;
  propagationId: string; verdictId?: string; verdict?: string; verdictReason?: string;
}

export async function why(db: Db, who: Principal, path: string): Promise<Why> {
  const g = db.team(who.teamId);
  const [changes, tasks] = await Promise.all([
    run<ChangeRow>(g, TEAM.whyChanges, { path }, { readOnly: true }),
    run<TaskRow>(g, TEAM.whyTasks, { path }, { readOnly: true }),
  ]);
  const nodes = new Map<string, GNode>();
  const edges: GEdge[] = [];
  const node = (id: string, kind: string, label: string) => { if (!nodes.has(id)) nodes.set(id, { id, kind, label }); return id; };
  const edge = (from: string, to: string, type: string, label?: string) => {
    if (!edges.some((e) => e.from === from && e.to === to && e.type === type)) edges.push({ from, to, type, label });
  };

  const file = node(`file:${path}`, 'File', path);
  for (const c of changes) {
    const ch = node(`change:${c.changeId}`, 'Change', `change ${new Date(c.at).toISOString().slice(0, 16).replace('T', ' ')}`);
    const se = node(`session:${c.sessionId}`, 'Session', `${c.tool ?? 'session'} ${c.sessionId.slice(0, 8)}`);
    const me = node(`member:${c.memberId}`, 'Member', c.member);
    edge(ch, file, 'TO');
    edge(ch, se, 'IN');
    edge(se, me, 'BY');
    if (c.versionId && c.ruleId) {
      const v = node(`version:${c.versionId}`, 'RuleVersion', `v${c.n} ${formatFigure(c.figure, c.unit).replace(/ \(.*\)$/, '')} (${c.status})`);
      const r = node(`rule:${c.ruleId}`, 'Rule', c.title ?? c.ruleId);
      const j = node(`jurisdiction:${c.jurisdiction}`, 'Jurisdiction', c.jurisdiction ?? '?');
      edge(ch, v, 'RELIED_ON', c.tier);
      edge(v, r, 'OF');
      edge(r, j, 'APPLIES_IN');
      for (const n of c.supersededBy) {
        edge(node(`version:${n}`, 'RuleVersion', `v${n.split('@')[1]} (newer)`), v, 'SUPERSEDES');
      }
    }
  }
  for (const t of tasks) {
    const tk = node(`task:${t.taskId}`, 'ReviewTask', `task ${t.status}, due ${t.due}`);
    edge(tk, file, 'FOR');
    edge(tk, node(`version:${t.versionId}`, 'RuleVersion', t.versionId), 'BECAUSE');
    edge(tk, node(`member:assignee:${t.assignee}`, 'Member', t.assignee), 'ASSIGNED');
    if (t.verdictId) edge(tk, node(`verdict:${t.verdictId}`, 'Verdict', `Reviewer: ${t.verdict}`), 'HAS');
  }

  const lines = [`Why ${path} is the way it is:`];
  for (const c of changes) {
    const when = new Date(c.at).toISOString().slice(0, 16).replace('T', ' ');
    lines.push(c.versionId
      ? `- ${when}: ${c.member}'s ${c.tool ?? 'agent'} session changed it relying on ${c.title} [${c.jurisdiction}] v${c.n} ` +
        `(${formatFigure(c.figure, c.unit)}, ${c.status}) at tier ${c.tier}.` +
        (c.supersededBy.length ? ` That version has since been superseded by ${c.supersededBy.join(', ')}.` : '')
      : `- ${when}: ${c.member}'s session changed it; no rule governed the change.`);
  }
  for (const t of tasks) {
    lines.push(`- Review task ${t.taskId} (${t.status}, due ${t.due}) assigned to ${t.assignee}` +
      (t.verdict ? `; Reviewer says ${t.verdict}: ${t.verdictReason}` : '') + '.');
  }
  if (!changes.length) lines.push('- No recorded changes.');
  return { path, nodes: [...nodes.values()], edges, text: lines.join('\n') };
}
