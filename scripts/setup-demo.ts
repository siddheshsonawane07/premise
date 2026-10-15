// Builds the Tilldesk demo team from nothing and writes the members' keys to .env.demo.local
// (git-ignored). With --replay, also replays the committed capture of the real sessions.
//
//   npx tsx scripts/setup-demo.ts            # empty team: rules only, for capturing sessions
//   npx tsx scripts/setup-demo.ts --replay   # the demo graph, rebuilt from demo/events/tilldesk.jsonl
//   npx tsx scripts/setup-demo.ts --payroll  # the second test's team, Tallyroll (demo/payroll/PROTOCOL.md)

import fs from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { Db } from '../src/db/client.ts';
import { seedDemo } from '../src/replay/seed.ts';
import { PAYROLL } from '../demo/payroll.ts';

const config = loadConfig();
const db = await Db.connectWithRetry(config.FALKORDB_URL, config.FALKORDB_PASSWORD);
const payroll = process.argv.includes('--payroll');
const teamId = payroll ? 'tallyroll' : config.DEMO_TEAM_ID;
const events = process.argv.includes('--replay') ? `demo/events/${payroll ? 'tallyroll' : 'tilldesk'}.jsonl` : undefined;
const keys = await seedDemo(db, teamId, events, payroll ? PAYROLL : undefined);
const lines = Object.entries(keys).map(([id, k]) => `PREMISE_KEY_${id.toUpperCase()}=${k}`);
const keyFile = payroll ? '.env.tallyroll.local' : '.env.demo.local';
fs.writeFileSync(keyFile, `${lines.join('\n')}\n`, { mode: 0o600 });
console.log(`Team ${teamId} rebuilt${events ? ` and replayed from ${events}` : ''}. Keys in ${keyFile}`);
await db.close();
