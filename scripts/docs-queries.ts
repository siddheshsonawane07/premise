// Copies the Cypher from src/db/queries.ts into the README (the core queries) and
// docs/QUERIES.md (all of them), each with the comment that says what it is for. A change to a
// query updates both in the same commit (STRICT 10); test/docs.test.ts fails if they drift.
//
//   npx tsx scripts/docs-queries.ts          # rewrite
//   npx tsx scripts/docs-queries.ts --check  # exit 1 if out of date

import fs from 'node:fs';
import { CONTROL, TEAM } from '../src/db/queries.ts';

/** The queries the product's claim rests on, shown in the README itself. */
export const CORE = [
  'TEAM.rulesForPath', 'TEAM.recordLookup', 'TEAM.sessionLookups', 'TEAM.recordChange',
  'TEAM.supersede', 'TEAM.affectedFiles', 'TEAM.affectedViaDerived', 'TEAM.openTask', 'TEAM.claimTask',
  'TEAM.handOff', 'TEAM.shortestToRegulators', 'TEAM.rulePageRank', 'TEAM.ruleClusters',
];

function docs(): Map<string, string> {
  const src = fs.readFileSync('src/db/queries.ts', 'utf8');
  const out = new Map<string, string>();
  for (const m of src.matchAll(/\/\*\*([\s\S]*?)\*\/\s*\n\s*(\w+):\s*`/g)) {
    out.set(m[2]!, m[1]!.split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim()).filter(Boolean).join(' '));
  }
  return out;
}

function dedent(s: string): string {
  const lines = s.replace(/^\n+|\s+$/g, '').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  return lines.map((l) => l.slice(indent)).join('\n');
}

function section(names: string[]): string {
  const d = docs();
  const all = { ...Object.fromEntries(Object.entries(CONTROL).map(([k, v]) => [`CONTROL.${k}`, v])),
    ...Object.fromEntries(Object.entries(TEAM).map(([k, v]) => [`TEAM.${k}`, v])) };
  return names.map((n) => {
    const name = n.split('.')[1]!;
    return `#### \`${n}\`\n\n${d.get(name) ?? ''}\n\n\`\`\`cypher\n${dedent(all[n as keyof typeof all] as string)}\n\`\`\`\n`;
  }).join('\n');
}

export function render(): { readme: string; queries: string } {
  const readme = fs.readFileSync('README.md', 'utf8');
  const block = `<!-- queries:start -->\n${section(CORE)}<!-- queries:end -->`;
  const nextReadme = readme.replace(/<!-- queries:start -->[\s\S]*?<!-- queries:end -->/, block);
  const names = [...Object.keys(CONTROL).map((k) => `CONTROL.${k}`), ...Object.keys(TEAM).map((k) => `TEAM.${k}`)];
  const queries = `# Every Cypher query Premise runs\n\nGenerated from \`src/db/queries.ts\` by \`scripts/docs-queries.ts\`; do not edit by hand. ` +
    `Values always travel as parameters (\`$name\`). \`_control\` holds teams, members and hashed keys; each team has its own graph, \`t_<teamId>\`.\n\n` +
    `## \`_control\`\n\n${section(names.filter((n) => n.startsWith('CONTROL.')))}\n## A team's graph\n\n${section(names.filter((n) => n.startsWith('TEAM.')))}`;
  return { readme: nextReadme, queries };
}

if (process.argv[1]?.endsWith('docs-queries.ts')) {
  const { readme, queries } = render();
  if (process.argv.includes('--check')) {
    const stale = fs.readFileSync('README.md', 'utf8') !== readme || !fs.existsSync('docs/QUERIES.md') || fs.readFileSync('docs/QUERIES.md', 'utf8') !== queries;
    if (stale) { console.error('README.md or docs/QUERIES.md is out of date: run npx tsx scripts/docs-queries.ts'); process.exit(1); }
    console.log('Query docs are up to date.');
  } else {
    fs.mkdirSync('docs', { recursive: true });
    fs.writeFileSync('README.md', readme);
    fs.writeFileSync('docs/QUERIES.md', queries);
    console.log('README.md and docs/QUERIES.md updated.');
  }
}
