// The measurement (STRICT 7.11): which files would each method flag if the India cash-loading
// limit changed, against a hand-made answer key. Every method's misses are reported, Premise's
// included.
//
//   npx tsx scripts/measure.ts [tilldesk-dir]   (default: demo/tilldesk, the snapshot of the real sessions)

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { Db, run } from '../src/db/client.ts';
import { TEAM } from '../src/db/queries.ts';
import { findAffected } from '../src/core/change.ts';

const dir = process.argv[2] ?? 'demo/tilldesk';
const key = JSON.parse(fs.readFileSync('demo/answer-key.json', 'utf8')) as { rule: string; needsChange: string[] };
const truth = new Set(key.needsChange);

function walk(d: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', '.git', '.claude'].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx|js|json|md)$/.test(e.name)) out.push(path.relative(dir!, p).split(path.sep).join('/'));
  }
  return out;
}
const files = walk(dir).filter((f) => f.startsWith('src/') || f.startsWith('test/'));

// (a) grep for the old figure in every spelling someone might use.
const spellings = /50_000_00|5000000|50_00_000|50000\b|50,000|50_000\b/;
const grep = files.filter((f) => spellings.test(fs.readFileSync(path.join(dir, f), 'utf8')));

// (b) every file under the rule's declared folders, (c) Premise's core query on the demo graph.
const config = loadConfig();
const db = await Db.connect(config.FALKORDB_URL, config.FALKORDB_PASSWORD);
const g = db.team(config.DEMO_TEAM_ID);
const rules = await run<{ ruleId: string; scopes: { path: string | null; source: string | null }[] }>(g, TEAM.listRules, {}, { readOnly: true });
const declared = (rules.find((r) => r.ruleId === key.rule)?.scopes ?? []).filter((s) => s.source === 'declared').map((s) => s.path!);
const folders = files.filter((f) => declared.some((d) => f === d || f.startsWith(`${d}/`)));
// Exactly what a rule change would find: relied-on edits, derived rules, and the old figure.
const v1 = (await run<{ figure?: number; unit?: string; jurisdiction: string }>(g,
  'MATCH (r:Rule {id: $id})-[:APPLIES_IN]->(j) MATCH (v:RuleVersion {id: $v}) RETURN v.figure AS figure, v.unit AS unit, j.code AS jurisdiction',
  { id: key.rule, v: `${key.rule}@1` }, { readOnly: true }))[0]!;
const { found } = await findAffected(db, config.DEMO_TEAM_ID, {
  ruleId: key.rule, jurisdiction: v1.jurisdiction, fromId: `${key.rule}@1`, toId: 'none', oldFigure: v1.figure, unit: v1.unit,
  authorId: 'compliance',
});
const premise = found.map((f) => f.path);
const tiers = new Map<string, number>();
for (const f of found) tiers.set(f.tier, (tiers.get(f.tier) ?? 0) + 1);
const byTier = [...tiers].map(([t, n]) => `${t} ${n}`).join(', ');
await db.close();

const score = (name: string, found: string[]) => {
  const hit = found.filter((f) => truth.has(f));
  const miss = [...truth].filter((f) => !found.includes(f));
  const extra = found.filter((f) => !truth.has(f));
  return { name, found: found.length, right: hit.length, missed: miss, extra };
};
const results = [score('grep for the old figure', grep), score("the rule's folders", folders), score('Premise (before the Reviewer)', premise),
  score('grep ∪ Premise', [...new Set([...grep, ...premise])])];

console.log(`Answer key: ${truth.size} files need changing. Premise found them as: ${byTier}.\n`);
console.log('| Method | Flagged | Right | Missed | Flagged but fine |');
console.log('|---|---|---|---|---|');
for (const r of results) {
  console.log(`| ${r.name} | ${r.found} | ${r.right} of ${truth.size} | ${r.missed.map((m) => `\`${m}\``).join(', ') || '—'} | ${r.extra.map((m) => `\`${m}\``).join(', ') || '—'} |`);
}
