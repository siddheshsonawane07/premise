import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Principal } from '../auth.ts';
import type { Db } from '../db/client.ts';
import { formatFigure, lookupRule, recordRule } from '../core/rules.ts';
import { myTasks } from '../core/tasks.ts';
import { PathOutsideRepo } from '../paths.ts';

// The MCP tools. A fresh server is built per request with the caller's Principal closed over,
// so the tenant always comes from the key and no tool accepts a team, a member or Cypher.

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

const RepoPath = z.string().min(1).max(300)
  .describe('Path of the file you are writing, relative to the repository root, e.g. src/wallet/limits.ts');

/** Agents sometimes send an absolute path; keep the part from the first known top-level folder. */
export function normalisePath(p: string): string {
  const clean = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean.startsWith('/')) {
    if (clean.split('/').includes('..')) throw new PathOutsideRepo('Path must stay inside the repository');
    return clean;
  }
  const parts = clean.split('/').filter(Boolean);
  const top = ['src', 'test', 'tests', 'lib', 'app', 'apps', 'packages', 'scripts', 'docs'];
  const i = parts.findIndex((s) => top.includes(s));
  if (i === -1) throw new PathOutsideRepo('Give the path relative to the repository root');
  return parts.slice(i).join('/');
}

export function buildMcpServer(db: Db, who: Principal): McpServer {
  const server = new McpServer({ name: 'premise', version: '0.1.0' });

  server.registerTool('rule_lookup', {
    title: 'Look up a rule',
    description:
      'Get the current, cited figure of a rule (a regulatory limit, threshold, rate) before writing it into code. ' +
      'Always pass the path of the file you are writing: Premise records that this file relies on the rule, ' +
      'so the file is found again when the rule changes.',
    inputSchema: z.object({
      rule: z.string().min(2).max(80).describe('Rule id (e.g. in-cash-load) or words from its title (e.g. "cash loading")'),
      path: RepoPath,
      jurisdiction: z.enum(['IN', 'US']).optional().describe('Market, if the rule exists in several'),
    }),
  }, async ({ rule, path, jurisdiction }) => {
    const res = await lookupRule(db, who, { rule, path: normalisePath(path), jurisdiction });
    if (!res.found.length) return text(`No rule matches "${rule}". Ask the user; do not guess the figure.`);
    const lines = res.found.map((v) =>
      `[${v.jurisdiction}] ${v.title} (rule id ${v.ruleId}, version ${v.n}, ${v.status}): ` +
      `${formatFigure(v.figure, v.unit) || 'no single figure'}. ${v.text} ` +
      `Citation: ${v.citation}. Effective ${v.effectiveFrom}.`);
    if (res.recordedFor) lines.push(`Recorded: ${res.recordedFor} relies on this.`);
    if (res.proposedScope) lines.push(`${res.proposedScope} was outside the rule's scope; a scope widening was proposed.`);
    return text(lines.join('\n'));
  });

  server.registerTool('record_rule', {
    title: 'Record a rule',
    description: 'Record a new rule (regulation, decision or constraint) with its first version, citation and the folders it governs.',
    inputSchema: z.object({
      id: z.string().regex(/^[a-z0-9-]{3,40}$/),
      title: z.string().min(3).max(120),
      type: z.enum(['regulation', 'decision', 'constraint']),
      risk: z.enum(['low', 'medium', 'high']),
      jurisdiction: z.enum(['IN', 'US']),
      text: z.string().min(3).max(1000),
      figure: z.number().int().optional(),
      unit: z.enum(['paise', 'cents', 'percent', 'none']).optional(),
      citation: z.string().min(3).max(300),
      effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      status: z.enum(['draft', 'final']),
      scope: z.array(z.string().min(1).max(200)).max(10),
    }),
  }, async (args) => {
    const r = await recordRule(db, who, { ...args, owner: who.memberId, scope: args.scope.map(normalisePath) });
    return text(`Recorded ${r.ruleId} as version ${r.versionId}.`);
  });

  server.registerTool('my_tasks', {
    title: 'My review tasks',
    description: 'Review tasks assigned to you: files written under a rule version that has since changed, with deadlines.',
    inputSchema: z.object({}),
  }, async () => {
    const tasks = await myTasks(db, who);
    if (!tasks.length) return text('No open review tasks.');
    return text(tasks.map((t) =>
      `${t.taskId}: ${t.path} — ${t.title}: ${formatFigure(t.oldFigure, t.unit)} → ${formatFigure(t.newFigure, t.unit)}. ` +
      `Due ${t.due}. Status ${t.status}.${t.verdict ? ` Reviewer: ${t.verdict} (${t.verdictReason}).` : ''}`).join('\n'));
  });

  return server;
}
