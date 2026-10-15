import { createHash } from 'node:crypto';
import type { Principal } from '../auth.ts';
import { type Db, one, run } from '../db/client.ts';
import { TEAM } from '../db/queries.ts';
import { parentOf, toRepoPath } from '../paths.ts';
import { forDeny, forRead, forSessionStart, type RuleLine, type TaskLine } from './context.ts';
import { chainFor, pathsUp } from './rules.ts';

// What happens on each hook (IMPLEMENTATION_PLAN §3.1), independent of transport: the HTTP
// routes, the command-line hook and the replay all call these.

export const READ_TOOLS = new Set(['Read']);
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

export type Tier = 'asked' | 'shown' | 'in_scope';

export interface ToolEvent {
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
}

interface ScopedRule extends RuleLine { shown: boolean; asked: boolean }

const SIX_HOURS = 6 * 3_600_000;
const MAX_DIFF = 4_000;
const MAX_SNAPSHOT = 100_000;

function filePathOf(ev: ToolEvent): string {
  const p = ev.tool_input.file_path;
  if (typeof p !== 'string' || !p) throw new Error('tool_input.file_path missing');
  return toRepoPath(ev.cwd, p);
}

async function scopedRules(db: Db, who: Principal, session: string, path: string): Promise<ScopedRule[]> {
  return run<ScopedRule>(db.team(who.teamId), TEAM.rulesForPath, {
    path, pathsUp: pathsUp(path), session, member: who.memberId, fallbackSince: Date.now() - SIX_HOURS,
  }, { readOnly: true });
}

async function fileTasks(db: Db, who: Principal, path: string): Promise<TaskLine[]> {
  return run<TaskLine>(db.team(who.teamId), TEAM.fileTasks, { path, now: Date.now() }, { readOnly: true });
}

async function markShown(db: Db, who: Principal, session: string, path: string, versionIds: string[], tool: string) {
  if (!versionIds.length) return;
  await run(db.team(who.teamId), TEAM.markShown, {
    session, member: who.memberId, path, versionIds, at: Date.now(), tool,
  });
}

export function tierOf(r: { shown: boolean; asked: boolean }): Tier {
  return r.asked ? 'asked' : r.shown ? 'shown' : 'in_scope';
}

// ── SessionStart ────────────────────────────────────────────────────────────

export async function sessionStart(
  db: Db, who: Principal, ev: { session_id: string; tool?: string; branch?: string },
): Promise<string> {
  const g = db.team(who.teamId);
  const at = Date.now();
  await run(g, TEAM.openSession, {
    session: ev.session_id, member: who.memberId, tool: ev.tool ?? 'claude-code', branch: ev.branch ?? 'unknown', at,
  });
  const prev = await one<{ previous: number | null }>(g, TEAM.previousSession, {
    member: who.memberId, session: ev.session_id,
  }, { readOnly: true });
  const changed = prev?.previous
    ? await run<RuleLine>(g, TEAM.versionsSince, { since: prev.previous }, { readOnly: true })
    : [];
  const tasks = await run<TaskLine>(g, TEAM.myTasks, { member: who.memberId }, { readOnly: true });
  return forSessionStart(changed, tasks);
}

// ── Read ────────────────────────────────────────────────────────────────────

/** Context to put next to the file, or undefined when no rule governs it. Marks what it showed. */
export async function onRead(db: Db, who: Principal, ev: ToolEvent, tool = 'claude-code'): Promise<string | undefined> {
  const path = filePathOf(ev);
  const [rules, tasks] = await Promise.all([scopedRules(db, who, ev.session_id, path), fileTasks(db, who, path)]);
  await markShown(db, who, ev.session_id, path, rules.map((r) => r.versionId), tool);
  const content = readContent(ev.tool_response);
  if (content !== undefined) await recordSnapshot(db, who, path, content);
  return forRead(path, rules, tasks);
}

// ── Before an edit ──────────────────────────────────────────────────────────

export type Decision =
  | { decision: 'allow'; context?: string }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; reason: string };

/**
 * The guarantee: an edit to a governed file goes through only if this session was shown, or
 * looked up, the current version of every rule in scope. If not, it is denied once and the
 * deny itself shows the rules. A file with someone else's open task or live claim asks the user.
 */
export async function preEdit(db: Db, who: Principal, ev: ToolEvent, tool = 'claude-code'): Promise<Decision> {
  const path = filePathOf(ev);
  const [rules, tasks] = await Promise.all([scopedRules(db, who, ev.session_id, path), fileTasks(db, who, path)]);
  const unseen = rules.filter((r) => !r.shown && !r.asked);
  if (unseen.length) {
    await markShown(db, who, ev.session_id, path, unseen.map((r) => r.versionId), tool);
    return { decision: 'deny', reason: forDeny(path, unseen) };
  }
  // A claim is by a member: an MCP call carries the member's key but not Claude Code's session.
  const others = tasks.filter((t) =>
    (t.claimMember && t.claimMember !== who.memberId) || t.assignee !== who.memberId);
  if (others.length) {
    return { decision: 'ask', reason: forRead(path, [], others) ?? `Open review task on ${path}` };
  }
  return tasks.length ? { decision: 'allow', context: forRead(path, [], tasks) } : { decision: 'allow' };
}

// ── After an edit ───────────────────────────────────────────────────────────

/** Record the change with the rule versions it relied on, in one query (Q7). */
export async function postEdit(
  db: Db, who: Principal, ev: ToolEvent, tool = 'claude-code',
): Promise<{ resolved: number; duplicate?: boolean; relied: { versionId: string; tier: Tier }[] }> {
  const path = filePathOf(ev);
  const rules = await scopedRules(db, who, ev.session_id, path);
  const relied = rules.map((r) => ({ versionId: r.versionId, tier: tierOf(r) }));
  const changeId = ev.tool_use_id ?? `${ev.session_id}:${path}:${Date.now()}`;
  const result = await writeChange(db, who, {
    session: ev.session_id, tool, path, changeId, diff: diffOf(ev), relied,
  });
  const content = editedContent(ev);
  if (content !== undefined) await recordSnapshot(db, who, path, content);
  return { ...result, relied };
}

async function writeChange(
  db: Db, who: Principal,
  c: { session: string; tool: string; path: string; changeId: string; diff: string; relied: { versionId: string; tier: Tier }[] },
): Promise<{ resolved: number; duplicate?: boolean }> {
  try {
    const row = await one<{ resolved: number }>(db.team(who.teamId), TEAM.recordChange, {
      session: c.session, member: who.memberId, tool: c.tool, branch: 'unknown',
      path: c.path, dir: parentOf(c.path), chain: chainFor([c.path]),
      changeId: c.changeId, diff: c.diff, at: Date.now(), relied: c.relied,
      resolvedReason: 'Fixed in a change that looked up the new version of the rule',
    });
    return { resolved: row?.resolved ?? 0 };
  } catch (err) {
    // A retried hook with the same tool_use_id: the change is already recorded.
    if (/unique constraint/i.test(String(err))) return { resolved: 0, duplicate: true };
    throw err;
  }
}

// ── Stop: edits made outside the agent's tools ──────────────────────────────

/**
 * `git status` at the end of a turn: any modified file in some rule's scope, changed since the
 * session began, with no recorded change from this session, is recorded at tier `in_scope`.
 */
export async function stopSweep(
  db: Db, who: Principal, ev: { session_id: string; cwd: string; files: { path: string; mtimeMs: number }[] },
): Promise<string[]> {
  const g = db.team(who.teamId);
  const started = await one<{ startedAt: number }>(g, TEAM.openSession, {
    session: ev.session_id, member: who.memberId, tool: 'claude-code', branch: 'unknown', at: Date.now(),
  });
  const since = started?.startedAt ?? Date.now() - SIX_HOURS;
  const candidates: string[] = [];
  for (const f of ev.files.slice(0, 200)) {
    if (f.mtimeMs < since) continue;
    try { candidates.push(toRepoPath(ev.cwd, f.path)); } catch { /* outside the repo */ }
  }
  if (!candidates.length) return [];
  const done = await one<{ paths: string[] }>(g, TEAM.changedInSession, {
    session: ev.session_id, paths: candidates,
  }, { readOnly: true });
  const recorded: string[] = [];
  for (const path of candidates.filter((p) => !done?.paths.includes(p))) {
    const rules = await scopedRules(db, who, ev.session_id, path);
    if (!rules.length) continue;
    const r = await writeChange(db, who, {
      session: ev.session_id, tool: 'claude-code', path, changeId: `stop:${ev.session_id}:${path}`,
      diff: '(edited outside the agent\'s tools; found by git status at the end of the turn)',
      relied: rules.map((x) => ({ versionId: x.versionId, tier: 'in_scope' as const })),
    });
    if (!r.duplicate) recorded.push(path);
  }
  return recorded;
}

// ── Snapshots and diffs ─────────────────────────────────────────────────────

export async function recordSnapshot(db: Db, who: Principal, path: string, content: string): Promise<void> {
  const hash = createHash('sha256').update(content).digest('hex');
  await run(db.team(who.teamId), TEAM.recordSnapshot, {
    path, dir: parentOf(path), chain: chainFor([path]), hash,
    content: content.length > MAX_SNAPSHOT ? content.slice(0, MAX_SNAPSHOT) : content, at: Date.now(),
  });
}

/** A whole-file Read's content; partial reads (offset/limit) are not snapshots. */
function readContent(resp: unknown): string | undefined {
  const file = (resp as { file?: { content?: unknown; startLine?: number; numLines?: number; totalLines?: number } })?.file;
  if (!file || typeof file.content !== 'string') return undefined;
  if ((file.startLine ?? 1) !== 1) return undefined;
  if (typeof file.numLines === 'number' && typeof file.totalLines === 'number' && file.numLines < file.totalLines) return undefined;
  return file.content;
}

/** The file after the edit: Write's content, or Edit's originalFile with the replacement applied. */
export function editedContent(ev: ToolEvent): string | undefined {
  const i = ev.tool_input;
  if (ev.tool_name === 'Write' && typeof i.content === 'string') return i.content;
  const r = ev.tool_response as { originalFile?: unknown } | undefined;
  if (ev.tool_name === 'Edit' && typeof r?.originalFile === 'string'
    && typeof i.old_string === 'string' && typeof i.new_string === 'string') {
    return i.replace_all ? r.originalFile.split(i.old_string).join(i.new_string) : r.originalFile.replace(i.old_string, () => i.new_string as string);
  }
  return undefined;
}

export function diffOf(ev: ToolEvent): string {
  const i = ev.tool_input;
  let d: string;
  if (typeof i.old_string === 'string' && typeof i.new_string === 'string') {
    d = `- ${i.old_string}\n+ ${i.new_string}`;
  } else if (Array.isArray(i.edits)) {
    d = (i.edits as { old_string?: string; new_string?: string }[])
      .map((e) => `- ${e.old_string ?? ''}\n+ ${e.new_string ?? ''}`).join('\n');
  } else if (typeof i.content === 'string') {
    d = `(whole file written)\n${i.content}`;
  } else {
    d = '(no diff available)';
  }
  return d.length > MAX_DIFF ? `${d.slice(0, MAX_DIFF)}\n…` : d;
}
