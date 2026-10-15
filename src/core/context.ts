import { formatFigure } from './rules.ts';

// The text Premise puts in front of an agent. Kept under Claude Code's 10,000-character
// limit for additionalContext, past which it is moved to a file (Hook Checks 2026-10-15).

export const MAX_CONTEXT = 9_000;

export const LOOKUP_INSTRUCTION =
  'Before writing any regulated figure (a limit, threshold, rate or amount), look it up with the ' +
  '`rule_lookup` tool, passing the repo-relative path of the file you are writing. Never write such a ' +
  'figure from memory.';

export const CONTRADICTION_INSTRUCTION =
  'If your change contradicts one of these rules, stop, ask the user, and call `supersede` instead of editing.';

export interface RuleLine {
  ruleId: string;
  title: string;
  jurisdiction: string;
  versionId: string;
  n: number;
  figure?: number;
  unit?: string;
  previousFigure?: number;
  citation: string;
  effectiveFrom: string;
  status: string;
  versionAt?: number;
  lastEdit?: number;
}

export interface TaskLine {
  taskId: string;
  status: string;
  due: string;
  assignee?: string;
  assigneeName: string;
  ruleId: string;
  claimMember?: string;
  path?: string;
  newFigure?: number;
  unit?: string;
  claimBy?: string;
  claimExpires?: number;
  handoffNote?: string;
  handoffFrom?: string;
}

export function ruleLine(r: RuleLine): string {
  const fig = formatFigure(r.figure, r.unit);
  const changed = r.lastEdit && r.versionAt && r.versionAt > r.lastEdit
    ? ` CHANGED since this file was last edited${typeof r.previousFigure === 'number' ? ` (was ${formatFigure(r.previousFigure, r.unit)})` : ''}.`
    : '';
  return `- [${r.jurisdiction}] ${r.title}${fig ? `: ${fig}` : ''}. ` +
    `Version ${r.n} (${r.status}), effective ${r.effectiveFrom}. Citation: ${r.citation}. Rule id: ${r.ruleId}.${changed}`;
}

export function daysUntil(isoDate: string, now = Date.now()): number {
  return Math.ceil((Date.parse(`${isoDate}T00:00:00Z`) - now) / 86_400_000);
}

export function taskLine(t: TaskLine, now = Date.now()): string {
  const days = daysUntil(t.due, now);
  const when = days >= 0 ? `due ${t.due} (${days} days)` : `OVERDUE since ${t.due}`;
  const fig = typeof t.newFigure === 'number' ? ` New figure: ${formatFigure(t.newFigure, t.unit)}.` : '';
  const claim = t.claimBy ? ` Claimed by ${t.claimBy}.` : '';
  const what = t.status === 'proposed_clear' ? 'Review task (the Reviewer proposes it can be cleared)' : 'OPEN REVIEW TASK';
  const handoff = t.handoffNote ? ` Handed to you by ${t.handoffFrom ?? 'a teammate'}: "${t.handoffNote}"` : '';
  return `- ${what} ${t.taskId}${t.path ? ` on ${t.path}` : ''}: rule ${t.ruleId} changed; assigned to ${t.assigneeName}, ${when}.${fig}${claim}${handoff}`;
}

export function forRead(path: string, rules: RuleLine[], tasks: TaskLine[]): string | undefined {
  if (!rules.length && !tasks.length) return undefined;
  const parts = [`Premise: rules governing ${path}`];
  if (rules.length) parts.push(...rules.map(ruleLine));
  if (tasks.length) parts.push('', ...tasks.map((t) => taskLine(t)));
  parts.push('', CONTRADICTION_INSTRUCTION, LOOKUP_INSTRUCTION);
  return cap(parts.join('\n'));
}

export function forDeny(path: string, rules: RuleLine[]): string {
  return cap([
    `Premise: ${path} is governed by rules this session has not been shown yet:`,
    ...rules.map(ruleLine),
    '',
    'You have now been shown them. If your edit is consistent with these rules, retry the same edit. ' +
      CONTRADICTION_INSTRUCTION,
    LOOKUP_INSTRUCTION,
  ].join('\n'));
}

export function forSessionStart(changed: RuleLine[], tasks: TaskLine[]): string {
  const parts = ['Premise is recording which rules this session relies on.'];
  if (changed.length) parts.push('', 'Rules that changed since your last session:', ...changed.map(ruleLine));
  if (tasks.length) parts.push('', 'Your review tasks:', ...tasks.map((t) => taskLine(t)));
  parts.push('', LOOKUP_INSTRUCTION);
  return cap(parts.join('\n'));
}

function cap(text: string): string {
  return text.length <= MAX_CONTEXT ? text : `${text.slice(0, MAX_CONTEXT - 40)}\n…(truncated by Premise)`;
}
