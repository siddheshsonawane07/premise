import { randomBytes } from 'node:crypto';
import { Db } from '../../src/db/client.ts';
import { ensureControlSchema } from '../../src/db/schema.ts';

// Tests run against the real pinned FalkorDB (`npm run db:up`), never a mock.
// Each test makes its own team ids and deletes those graphs afterwards.

export async function testDb(): Promise<Db> {
  const db = await Db.connect(
    process.env.FALKORDB_URL ?? 'falkor://localhost:6379',
    process.env.FALKORDB_PASSWORD ?? 'premise-local',
  );
  await ensureControlSchema(db.control());
  return db;
}

export function uniqueTeamId(prefix = 'test'): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}

export async function dropTeam(db: Db, teamId: string): Promise<void> {
  try { await db.team(teamId).delete(); } catch { /* never created */ }
}
