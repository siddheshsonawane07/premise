// What breaks without the graph (STRICT 4.2, 4.6). Two runs:
//  1. Hooks off: the same rules, but no session ever recorded what it was shown or asked.
//     The rule change then finds nothing: the links exist only because the graph kept them.
//  2. FalkorDB off: a running Premise server, the database stopped. Edits are denied in plain
//     words; nothing falls back to another store. (Needs `npm start` running and Docker.)
//
//   npx tsx scripts/ablate.ts

import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.ts';
import { getPropagation, receipt, runPropagation, supersede } from '../src/core/change.ts';
import { Db, one } from '../src/db/client.ts';
import { CONTROL } from '../src/db/queries.ts';
import type { Principal } from '../src/auth.ts';
import { deleteTeam, seedDemo } from '../src/replay/seed.ts';

const config = loadConfig();
const db = await Db.connect(config.FALKORDB_URL, config.FALKORDB_PASSWORD);
const CHANGE = {
  ruleId: 'in-cash-load', text: 'Cash loaded into a full-KYC prepaid wallet is capped at ₹10,000 a month.', figure: 10_000_00,
  unit: 'paise' as const, citation: 'RBI draft Master Direction on PPIs, 2026-04-22', effectiveFrom: '2026-11-14',
  reason: 'Ablation run', draft: true,
};

async function dryRun(teamId: string, events?: string): Promise<string> {
  await seedDemo(db, teamId, events);
  const chitra = await one<Principal>(db.control(), CONTROL.principalById, { id: `${teamId}.chitra` }, { readOnly: true });
  const s = await supersede(db, chitra!, CHANGE);
  await runPropagation(db, teamId, s.propagationId);
  const text = receipt((await getPropagation(db, teamId, s.propagationId))!);
  await deleteTeam(db, teamId);
  return text;
}

console.log('1. The same rule change, with and without what the hooks recorded\n');
console.log(`   With the graph's records:  ${await dryRun('ablate_on', 'demo/events/tilldesk.jsonl')}`);
console.log(`   Hooks off (nothing kept):  ${await dryRun('ablate_off')}\n`);
await db.close();

console.log('2. FalkorDB stopped under a running server\n');
const url = `http://localhost:${config.PORT}`;
const key = process.env.PREMISE_KEY_ASHA;
if (!key) {
  console.log('   Skipped: load .env.demo.local and start the server first.');
} else {
  const body = JSON.stringify({ session_id: 'ablate', cwd: '/demo/tilldesk', tool_name: 'Edit', tool_use_id: 'ablate-1',
    tool_input: { file_path: '/demo/tilldesk/src/wallet/limits.ts', old_string: 'a', new_string: 'b' } });
  const edit = async () => (await fetch(`${url}/hooks/pre-edit`, { method: 'POST', body,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } })).json() as Promise<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }>;
  execFileSync('docker', ['compose', 'stop', 'falkordb'], { stdio: 'ignore' });
  try {
    const r = (await edit()).hookSpecificOutput;
    console.log(`   An agent's edit: ${r?.permissionDecision}: "${r?.permissionDecisionReason}"`);
    const h = await fetch(`${url}/healthz`);
    console.log(`   /healthz: ${h.status} ${await h.text()}`);
  } finally {
    execFileSync('docker', ['compose', 'start', 'falkordb'], { stdio: 'ignore' });
  }
}
