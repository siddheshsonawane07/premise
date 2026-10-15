import { createHash, randomBytes } from 'node:crypto';
import { type Db, one, run } from './db/client.ts';
import { CONTROL, TEAM } from './db/queries.ts';
import { ensureTeamSchema } from './db/schema.ts';

// A member key is the only credential. Only its SHA-256 is stored (in `_control`), and the
// key alone decides which team graph a request may touch: no request names its tenant.

export type Role = 'developer' | 'compliance';

export interface Principal {
  memberId: string;
  name: string;
  role: Role;
  teamId: string;
}

export function generateKey(): string {
  return `pk_${randomBytes(24).toString('base64url')}`;
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export async function authenticate(db: Db, key: string | undefined): Promise<Principal | undefined> {
  if (!key || !key.startsWith('pk_') || key.length > 100) return undefined;
  return one<Principal>(db.control(), CONTROL.authKey, { hash: hashKey(key) }, { readOnly: true });
}

/** Read the key from `Authorization: Bearer <key>`. */
export function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m?.[1];
}

export async function createTeam(db: Db, id: string, name: string): Promise<void> {
  await run(db.control(), CONTROL.createTeam, { id, name });
  await ensureTeamSchema(db.team(id));
}

/** Creates the member (in `_control` and in the team graph) and returns a new key. */
export async function createMember(
  db: Db, teamId: string, member: { id: string; name: string; role: Role },
): Promise<string> {
  await run(db.control(), CONTROL.createMember, { teamId, ...member });
  await run(db.team(teamId), TEAM.upsertMember, member);
  const key = generateKey();
  await run(db.control(), CONTROL.createKey, { memberId: member.id, hash: hashKey(key), at: Date.now() });
  return key;
}
