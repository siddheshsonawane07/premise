// The measurement (STRICT 7.11): which files each method flags if a rule's figure changed,
// against an answer key written by hand before measuring. Every method's misses are reported,
// Premise's included.
//
//   npx tsx scripts/measure.ts                                   # Tilldesk: demo/tilldesk, demo/answer-key.json
//   npx tsx scripts/measure.ts --payroll [--rule us-flsa-salary] # Tallyroll (demo/payroll/PROTOCOL.md)

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { Db, run } from '../src/db/client.ts';
import { TEAM } from '../src/db/queries.ts';
import { findAffected } from '../src/core/change.ts';
import { figureSpellings, mentionsFigure } from '../src/core/rules.ts';

type Change = { rule: string; needsChange: string[] };
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const payroll = process.argv.includes('--payroll');
const config = loadConfig();
const dir = payroll ? 'demo/payroll/tallyroll' : 'demo/tilldesk';
const teamId = payroll ? 'tallyroll' : config.DEMO_TEAM_ID;
const raw = JSON.parse(fs.readFileSync(payroll ? 'demo/payroll/answer-key.json' : 'demo/answer-key.json', 'utf8')) as Change | { changes: Change[] };
const changes = 'changes' in raw ? raw.changes : [raw];
const key = changes.find((c) => c.rule === (arg('--rule') ?? changes[0]!.rule));
if (!key) throw new Error(`No answer key for ${arg('--rule')}`);
const truth = new Set(key.needsChange);

function walk(d: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', '.git', '.claude'].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx|js|json|md)$/.test(e.name)) out.push(path.relative(dir, p).split(path.sep).join('/'));
  }
  return out;
}
const files = walk(dir).filter((f) => f.startsWith('src/') || f.startsWith('test/'));

const db = await Db.connect(config.FALKORDB_URL, config.FALKORDB_PASSWORD);
const g = db.team(teamId);
const v1 = (await run<{ figure?: number; unit?: string; jurisdiction: string }>(g,
  'MATCH (r:Rule {id: $id})-[:APPLIES_IN]->(j) MATCH (v:RuleVersion {id: $v}) RETURN v.figure AS figure, v.unit AS unit, j.code AS jurisdiction',
  { id: key.rule, v: `${key.rule}@1` }, { readOnly: true }))[0]!;

// (a) grep for the old figure in every spelling someone might use.
const spellings = figureSpellings(v1.figure, v1.unit);
const grep = files.filter((f) => mentionsFigure(fs.readFileSync(path.join(dir, f), 'utf8'), spellings));

// (b) every file under the rule's declared folders.
const rules = await run<{ ruleId: string; scopes: { path: string | null; source: string | null }[] }>(g, TEAM.listRules, {}, { readOnly: true });
const declared = (rules.find((r) => r.ruleId === key.rule)?.scopes ?? []).filter((s) => s.source === 'declared').map((s) => s.path!);
const folders = files.filter((f) => declared.some((d) => f === d || f.startsWith(`${d}/`)));

// (c) exactly what a rule change would find: relied-on edits, derived rules, and the old figure.
const { found } = await findAffected(db, teamId, {
  ruleId: key.rule, jurisdiction: v1.jurisdiction, fromId: `${key.rule}@1`, toId: 'none', oldFigure: v1.figure, unit: v1.unit,
  authorId: 'compliance',
});
const premise = found.map((f) => f.path);
const tiers = new Map<string, number>();
for (const f of found) tiers.set(f.tier, (tiers.get(f.tier) ?? 0) + 1);
const byTier = [...tiers].map(([t, n]) => `${t} ${n}`).join(', ');
await db.close();

const score = (name: string, flagged: string[]) => {
  const hit = flagged.filter((f) => truth.has(f));
  const miss = [...truth].filter((f) => !flagged.includes(f));
  const extra = flagged.filter((f) => !truth.has(f));
  return { name, found: flagged.length, right: hit.length, missed: miss, extra };
};
const results = [score('grep for the old figure', grep), score("the rule's folders", folders), score('Premise (before the Reviewer)', premise),
  score('grep ∪ Premise', [...new Set([...grep, ...premise])])];

console.log(`${key.rule}: ${truth.size} files need changing. Premise found them as: ${byTier || 'nothing'}.\n`);
console.log('| Method | Flagged | Right | Missed | Flagged but fine |');
console.log('|---|---|---|---|---|');
for (const r of results) {
  console.log(`| ${r.name} | ${r.found} | ${r.right} of ${truth.size} | ${r.missed.map((m) => `\`${m}\``).join(', ') || '—'} | ${r.extra.map((m) => `\`${m}\``).join(', ') || '—'} |`);
}
