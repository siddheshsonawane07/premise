import { createMember, createTeam, type Principal } from '../auth.ts';
import { chainFor, recordRule } from '../core/rules.ts';
import { type Db, run } from '../db/client.ts';
import { CONTROL, TEAM } from '../db/queries.ts';
import { ensureControlSchema } from '../db/schema.ts';
import { DEMO } from '../../demo/demo.ts';
import { readEvents, replay } from './replay.ts';

// Builds the demo team from nothing (STRICT 5.9, 6.3): members, repo, markets, version 1 of
// each rule, then, if a capture is given, replays it. Returns the members' new keys.

export async function teamExists(db: Db, teamId: string): Promise<boolean> {
  const teams = await run<{ id: string }>(db.control(), CONTROL.listTeams, {}, { readOnly: true });
  return teams.some((t) => t.id === teamId);
}

export async function deleteTeam(db: Db, teamId: string): Promise<void> {
  await db.team(teamId).delete().catch(() => {});
  await run(db.control(), CONTROL.deleteTeamKeys, { id: teamId });
  await run(db.control(), CONTROL.deleteTeamMembers, { id: teamId });
  await run(db.control(), CONTROL.deleteTeam, { id: teamId });
}

export async function seedDemo(db: Db, teamId: string, eventsFile?: string, scenario: typeof DEMO = DEMO): Promise<Record<string, string>> {
  await ensureControlSchema(db.control());
  if (await teamExists(db, teamId)) await deleteTeam(db, teamId);

  await createTeam(db, teamId, scenario.teamName);
  const keys: Record<string, string> = {};
  const people: Record<string, Principal> = {};
  for (const m of scenario.members) {
    const id = `${teamId}.${m.id}`;
    keys[m.id] = await createMember(db, teamId, { id, name: m.name, role: m.role });
    people[m.id] = { memberId: id, name: m.name, role: m.role, teamId };
  }
  const g = db.team(teamId);
  await run(g, TEAM.upsertRepo, { id: scenario.repo.id, name: scenario.repo.name });
  for (const j of scenario.jurisdictions) await run(g, TEAM.upsertJurisdiction, j);
  for (const s of scenario.serves) await run(g, TEAM.serves, { ...s, chain: chainFor([s.path], true) });
  for (const r of scenario.rules) await recordRule(db, people[r.recordedBy]!, { ...r.rule, owner: people[r.recordedBy]!.memberId });

  if (eventsFile) await replay(db, teamId, readEvents(eventsFile));
  return keys;
}
