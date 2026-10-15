// Builds the Tilldesk demo team from nothing and writes the members' keys to .env.demo.local
// (git-ignored). With --replay, also replays the committed capture of the real sessions.
//
//   npx tsx scripts/setup-demo.ts            # empty team: rules only, for capturing sessions
//   npx tsx scripts/setup-demo.ts --replay   # the demo graph, rebuilt from demo/events/tilldesk.jsonl

import fs from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { Db } from '../src/db/client.ts';
import { seedDemo } from '../src/replay/seed.ts';

const config = loadConfig();
const db = await Db.connect(config.FALKORDB_URL, config.FALKORDB_PASSWORD);
const events = process.argv.includes('--replay') ? 'demo/events/tilldesk.jsonl' : undefined;
const keys = await seedDemo(db, config.DEMO_TEAM_ID, events);
const lines = Object.entries(keys).map(([id, k]) => `PREMISE_KEY_${id.toUpperCase()}=${k}`);
fs.writeFileSync('.env.demo.local', `${lines.join('\n')}\n`, { mode: 0o600 });
console.log(`Team ${config.DEMO_TEAM_ID} rebuilt${events ? ` and replayed from ${events}` : ''}. Keys in .env.demo.local`);
await db.close();
