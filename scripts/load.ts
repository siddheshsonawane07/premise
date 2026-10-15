// Load and latency (STRICT 7.12, PRODUCT_FINAL §11): hook latency as a client sees it, and
// concurrent writers recording edits. Needs a running server and the demo keys.
//
//   set -a; . ./.env.demo.local; set +a
//   npx tsx scripts/load.ts [baseUrl] [seconds] [concurrency]
//   npx tsx scripts/setup-demo.ts --replay   # afterwards: the run leaves thousands of synthetic edits in the demo graph

import { loadConfig } from '../src/config.ts';
import { Db, one } from '../src/db/client.ts';

const base = process.argv[2] ?? 'http://localhost:8080';
const seconds = Number(process.argv[3] ?? 15);
const concurrency = Number(process.argv[4] ?? 20);
const key = process.env.PREMISE_KEY_ASHA;
if (!key) { console.error('Load .env.demo.local first'); process.exit(1); }
// Node's fetch keeps connections alive by default.

const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN; };
const fmt = (xs: number[]) => `p50 ${pct(xs, 50).toFixed(1)} ms, p95 ${pct(xs, 95).toFixed(1)} ms (n=${xs.length})`;

async function timed(path: string, body: unknown): Promise<number> {
  const t = performance.now();
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  await res.arrayBuffer();
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return performance.now() - t;
}

const run = `load-${Date.now()}`;
const ev = (tool: string, path: string, extra: Record<string, unknown> = {}) => ({
  session_id: run, cwd: '/demo/tilldesk', tool_name: tool, tool_input: { file_path: `/demo/tilldesk/${path}`, ...extra }, ...extra,
});

// 1. Latency, one request at a time, connection reused (as Claude Code does: Hook Checks 2026-10-15).
const read: number[] = [];
const pre: number[] = [];
for (let i = 0; i < 300; i++) {
  read.push(await timed('/hooks/read', ev('Read', 'src/wallet/topup.ts')));
  pre.push(await timed('/hooks/pre-edit', ev('Edit', 'src/wallet/topup.ts', { tool_use_id: `${run}-pre-${i}` })));
}
console.log(`Read hook:     ${fmt(read)}`);
console.log(`Pre-edit hook: ${fmt(pre)}`);

// 2. Concurrent writers: every request records a new Change with its RELIED_ON edges.
let sent = 0;
let errors = 0;
const write: number[] = [];
const stopAt = Date.now() + seconds * 1000;
await Promise.all(Array.from({ length: concurrency }, async (_, w) => {
  while (Date.now() < stopAt) {
    const id = `${run}-w${w}-${sent++}`;
    try {
      write.push(await timed('/hooks/post-edit', {
        ...ev('Edit', `src/wallet/load-${w % 10}.ts`), tool_use_id: id,
        tool_input: { file_path: `/demo/tilldesk/src/wallet/load-${w % 10}.ts`, old_string: 'a', new_string: 'b' },
      }));
    } catch { errors++; }
  }
}));
const config = loadConfig();
const db = await Db.connect(config.FALKORDB_URL, config.FALKORDB_PASSWORD);
const row = await one<{ n: number }>(db.team(config.DEMO_TEAM_ID),
  'MATCH (c:Change) WHERE c.id STARTS WITH $run RETURN count(c) AS n', { run: `${run}-w` }, { readOnly: true });
const mem = await db.team(config.DEMO_TEAM_ID).memoryUsage().catch(() => undefined);
await db.close();
console.log(`Post-edit (record a change), ${concurrency} concurrent writers for ${seconds} s: ` +
  `${(write.length / seconds).toFixed(0)} writes/s, ${fmt(write)}, errors ${errors}`);
console.log(`Edits sent ${write.length + errors}, recorded ${row?.n ?? 0}, lost ${write.length - (row?.n ?? 0)}`);
if (mem) console.log(`Demo graph memory after the run: ${JSON.stringify(mem).slice(0, 200)}`);
