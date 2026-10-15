// Creates the Tilldesk demo team from nothing: members, repo, markets, folders' markets, and
// version 1 of each rule. Writes the members' keys to .env.demo.local (git-ignored).
//
//   npx tsx scripts/setup-demo.ts            # refuses if the team exists
//   npx tsx scripts/setup-demo.ts --reset    # deletes the team's graph first

import fs from 'node:fs';
import { createMember, createTeam, type Principal } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { recordRule } from '../src/core/rules.ts';
import { chainFor } from '../src/core/rules.ts';
import { Db, run } from '../src/db/client.ts';
import { CONTROL, TEAM } from '../src/db/queries.ts';
import { ensureControlSchema } from '../src/db/schema.ts';
import { DEMO } from '../demo/demo.ts';

const config = loadConfig();
const db = await Db.connect(config.FALKORDB_URL, config.FALKORDB_PASSWORD);
await ensureControlSchema(db.control());
const teamId = config.DEMO_TEAM_ID;

const existing = await run<{ id: string }>(db.control(), CONTROL.listTeams, {}, { readOnly: true });
if (existing.some((t) => t.id === teamId)) {
  if (!process.argv.includes('--reset')) {
    console.error(`Team ${teamId} exists. Use --reset to rebuild it.`);
    process.exit(1);
  }
  await db.team(teamId).delete().catch(() => {});
  await run(db.control(), 'MATCH (:Team {id: $id})<-[:IN]-(:Member)<-[:FOR]-(k:Key) DETACH DELETE k', { id: teamId });
  await run(db.control(), 'MATCH (:Team {id: $id})<-[:IN]-(m:Member) DETACH DELETE m', { id: teamId });
  await run(db.control(), 'MATCH (t:Team {id: $id}) DETACH DELETE t', { id: teamId });
}

await createTeam(db, teamId, DEMO.teamName);
const keys: Record<string, string> = {};
const people: Record<string, Principal> = {};
for (const m of DEMO.members) {
  const id = `${teamId}.${m.id}`;
  keys[m.id] = await createMember(db, teamId, { id, name: m.name, role: m.role });
  people[m.id] = { memberId: id, name: m.name, role: m.role, teamId };
}

const g = db.team(teamId);
await run(g, TEAM.upsertRepo, { id: DEMO.repo.id, name: DEMO.repo.name });
for (const j of DEMO.jurisdictions) await run(g, TEAM.upsertJurisdiction, j);
for (const s of DEMO.serves) await run(g, TEAM.serves, { ...s, chain: chainFor([s.path], true) });
for (const r of DEMO.rules) await recordRule(db, people[r.recordedBy]!, { ...r.rule, owner: people[r.recordedBy]!.memberId });

const lines = Object.entries(keys).map(([id, k]) => `PREMISE_KEY_${id.toUpperCase()}=${k}`);
fs.writeFileSync('.env.demo.local', `${lines.join('\n')}\n`, { mode: 0o600 });
console.log(`Team ${teamId}: ${DEMO.members.length} members, ${DEMO.rules.length} rules. Keys in .env.demo.local`);
await db.close();
