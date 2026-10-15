import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';
import { type Db, one, run } from '../db/client.ts';
import { TEAM } from '../db/queries.ts';
import type { Review, ReviewJob, Verdict } from '../core/change.ts';
import { formatFigure } from '../core/rules.ts';
import { Budget } from './budget.ts';

// The Reviewer: for one file and one rule change, does the file need changing? It reads the
// file's latest snapshot, the old and new versions, the diffs written under the old version,
// and every other rule the file relies on. It proposes; it never edits code or closes a task
// (plan D4, STRICT 7.8). Verdicts are cached in the graph by (content hash, rule version).

export const MODEL = 'claude-haiku-5-5';
export const PROMPT_VERSION = 'r1';
const MAX_FILE = 20_000;

const VerdictSchema = z.object({
  verdict: z.enum(['needs_change', 'still_fine', 'unknown']),
  reason: z.string().describe('One or two sentences, at most 400 characters, naming the line or value that decides it.'),
  lines: z.array(z.number().int()).describe('Line numbers that depend on the rule; empty if none.'),
  patch: z.string().optional().describe('For needs_change only: the corrected lines, as a short unified diff.'),
});

const SYSTEM = `You review one source file after a regulatory rule changed. Decide whether the file still follows the NEW version of the rule.

- The figure may appear in any form: the smallest currency unit (paise, cents), a literal amount, a percentage of the limit, a derived threshold (for example 80% of the limit), user-facing text, or a constant imported from elsewhere.
- Answer still_fine only if nothing in the file depends on the rule's figure or wording.
- Answer needs_change if any value, message or check in the file would be wrong under the new version. Suggest a minimal patch.
- If the file relies on other rules (listed), your patch must keep them correct.
- Answer unknown when the file is truncated, unclear, or you cannot tell.
- Never claim the code is compliant with any regulation. You judge only consistency with the rule text given.`;

export function makeReviewer(apiKey: string | undefined, dailyCapUsd: number): Review {
  if (!apiKey) {
    return async (db, teamId, job) => cached(db, teamId, job, async () => ({
      verdict: 'unknown', reason: 'No reviewer model is configured (ANTHROPIC_API_KEY is not set).', model: 'none',
    }));
  }
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  return async (db, teamId, job) => cached(db, teamId, job, async (snapshot, others) => {
    const budget = new Budget(db, dailyCapUsd);
    if (await budget.exhausted()) {
      return { verdict: 'unknown', reason: 'The daily review budget is used up; try again tomorrow.', model: MODEL };
    }
    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt(job, snapshot, others) }],
      output_config: { effort: 'low', format: zodOutputFormat(VerdictSchema) },
    });
    await budget.spend(res.usage.input_tokens, res.usage.output_tokens);
    if (res.stop_reason === 'refusal') return { verdict: 'unknown', reason: 'The model declined to review this file.', model: MODEL };
    const out = res.parsed_output;
    if (!out) return { verdict: 'unknown', reason: 'The model gave an unreadable answer.', model: MODEL };
    return {
      verdict: out.verdict,
      reason: out.reason.slice(0, 400),
      ...(out.verdict === 'needs_change' && out.patch ? { patch: out.patch.slice(0, 4000) } : {}),
      model: MODEL,
    };
  });
}

interface Other { ruleId: string; title: string; jurisdiction: string; text: string; figure?: number; unit?: string }

/** Look the verdict up by (snapshot hash, new version); call the model only on a miss. */
async function cached(
  db: Db, teamId: string, job: ReviewJob,
  decide: (snapshot: string, others: Other[]) => Promise<Verdict & { model: string }>,
): Promise<Verdict> {
  const g = db.team(teamId);
  const snap = await one<{ hash: string; content: string }>(g, TEAM.latestSnapshot, { path: job.path }, { readOnly: true });
  if (!snap) return { verdict: 'unknown', reason: 'Premise has no copy of this file yet.' };
  const id = `${snap.hash.slice(0, 24)}:${job.toId}`;
  const hit = await one<Verdict>(g, TEAM.verdictFor, { id }, { readOnly: true });
  if (hit) return { ...hit, id };
  const others = await run<Other>(g, TEAM.otherRulesForFile, { path: job.path, ruleId: job.ruleId }, { readOnly: true });
  const v = await decide(snap.content, others);
  // Only a model's answer is cached; "no model" or "budget used up" must not stick.
  if (v.model === 'none' || /budget/i.test(v.reason)) return { verdict: v.verdict, reason: v.reason };
  await run(g, TEAM.writeVerdict, {
    id, hash: snap.hash, versionId: job.toId, verdict: v.verdict, reason: v.reason, model: v.model,
    promptVersion: PROMPT_VERSION, at: Date.now(), patch: v.patch ? { patch: v.patch } : {},
  });
  return { verdict: v.verdict, reason: v.reason, patch: v.patch, id };
}

function prompt(job: ReviewJob, snapshot: string, others: Other[]): string {
  const file = snapshot.length > MAX_FILE ? `${snapshot.slice(0, MAX_FILE)}\n…(truncated)` : snapshot;
  const numbered = file.split('\n').map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join('\n');
  return [
    `Rule: ${job.title} [${job.jurisdiction}]`,
    `OLD version: ${formatFigure(job.oldFigure, job.unit)}. ${job.oldText}`,
    `NEW version: ${formatFigure(job.newFigure, job.unit)}. ${job.newText}`,
    job.via?.length
      ? `This file was written under rules DERIVED from the changed rule, so it can depend on the changed figure without naming it:\n${job.via.map((d) => `- ${d.title}: ${formatFigure(d.figure, d.unit)}. ${d.text} (derived: ${d.how.filter(Boolean).join('; ') || 'built on it'})`).join('\n')}`
      : '',
    others.length
      ? `This file also relies on (keep these correct):\n${others.map((o) => `- [${o.jurisdiction}] ${o.title}: ${formatFigure(o.figure, o.unit)}. ${o.text}`).join('\n')}`
      : '',
    `File: ${job.path}`,
    '```',
    numbered,
    '```',
  ].filter(Boolean).join('\n\n');
}
