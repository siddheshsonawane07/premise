import type { Principal } from '../auth.ts';
import { type Db, run } from '../db/client.ts';
import { TEAM } from '../db/queries.ts';

// The audit evidence pack for one rule, read back from the graph: every version and why it
// changed, every AI change made under each version (who, which session, which model, how
// strongly tied), and every review task with the Reviewer's verdict and its resolution. Designed
// to support change-management evidence; it certifies nothing.

export interface AuditChange {
  change: string; at: number; path: string; tier: string; member: string; session: string; tool?: string; model?: string;
}
export interface AuditVersion {
  ruleId: string; title: string; jurisdiction: string; regulator: string; versionId: string; n: number; status: string;
  figure?: number; unit?: string; text: string; citation: string; effectiveFrom: string; at: number; author: string;
  approvedBy?: string; approvedAt?: number; reason?: string; supersedes?: string; changes: AuditChange[];
}
export interface AuditTask {
  task: string; path: string; status: string; due: string; tier: string; assignee: string; verdict?: string;
  verdictReason?: string; model?: string; promptVersion?: string; resolvedReason?: string; resolvedBy?: string; resolvedAt?: number;
}
export interface AuditPropagation {
  propagationId: string; at: number; dryRun: boolean; fromId: string; toId: string; filesTotal?: number; tasks: AuditTask[];
}
export interface AuditPack {
  ruleId: string; generatedAt: string; note: string; versions: AuditVersion[]; propagations: AuditPropagation[];
}

const NOTE = 'Read from the Premise graph. Designed to support change-management evidence; it certifies nothing and is not legal or compliance advice.';

export async function auditPack(db: Db, who: Principal, ruleId: string): Promise<AuditPack | undefined> {
  const g = db.team(who.teamId);
  const [versions, propagations] = await Promise.all([
    run<AuditVersion>(g, TEAM.auditVersions, { ruleId }, { readOnly: true }),
    run<AuditPropagation>(g, TEAM.auditPropagations, { ruleId }, { readOnly: true }),
  ]);
  if (!versions.length) return undefined;
  return {
    ruleId,
    generatedAt: new Date().toISOString(),
    note: NOTE,
    versions: versions.map((v) => ({ ...v, changes: (v.changes ?? []).filter(Boolean).sort((a, b) => a.at - b.at) })),
    propagations: propagations.map((p) => ({ ...p, tasks: (p.tasks ?? []).filter(Boolean) })),
  };
}

/** One row per change made under any version of the rule, for a spreadsheet. */
export function auditCsv(pack: AuditPack): string {
  const head = ['rule', 'version', 'version_status', 'citation', 'approved_by', 'changed_at_utc', 'file', 'tier', 'member', 'session', 'tool', 'model'];
  const rows = pack.versions.flatMap((v) => v.changes.map((c) => [
    v.ruleId, v.versionId, v.status, v.citation, v.approvedBy ?? '', new Date(c.at).toISOString(), c.path, c.tier, c.member,
    c.session, c.tool ?? '', c.model ?? '',
  ]));
  const cell = (x: unknown) => {
    const s = String(x ?? '');
    // Quote every cell; neutralise a leading formula character (CSV injection into spreadsheets).
    return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
  };
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
}
