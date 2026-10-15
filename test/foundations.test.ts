import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate, bearer, createMember, createTeam } from '../src/auth.ts';
import { Db, DbUnreachable, run } from '../src/db/client.ts';
import { ensureTeamSchema, SchemaMissing, verifyTeamSchema } from '../src/db/schema.ts';
import { foldersAbove, parentOf, PathOutsideRepo, toRepoPath } from '../src/paths.ts';
import { dropTeam, testDb, uniqueTeamId } from './helpers/db.ts';

let db: Db;
const teams: string[] = [];

beforeAll(async () => { db = await testDb(); });
afterAll(async () => {
  for (const t of teams) await dropTeam(db, t);
  await db.close();
});

describe('schema (STRICT 5.8)', () => {
  it('creates every index and unique constraint, then verifies them', async () => {
    const id = uniqueTeamId(); teams.push(id);
    await ensureTeamSchema(db.team(id));
    await expect(verifyTeamSchema(db.team(id))).resolves.toBeUndefined();
  });

  it('refuses when an index is missing', async () => {
    const id = uniqueTeamId(); teams.push(id);
    await ensureTeamSchema(db.team(id));
    await db.team(id).constraintDrop('UNIQUE' as never, 'NODE' as never, 'Change', 'id');
    await expect(verifyTeamSchema(db.team(id))).rejects.toBeInstanceOf(SchemaMissing);
  });

  it('a duplicate key is refused, so a retried hook cannot make a second node', async () => {
    const id = uniqueTeamId(); teams.push(id);
    await ensureTeamSchema(db.team(id));
    await run(db.team(id), 'CREATE (:Change {id: $id})', { id: 'toolu_1' });
    await expect(run(db.team(id), 'CREATE (:Change {id: $id})', { id: 'toolu_1' })).rejects.toThrow(/unique/i);
  });
});

describe('timeouts (STRICT 5.10)', () => {
  it('cuts off a slow write and rolls it back', async () => {
    const id = uniqueTeamId(); teams.push(id);
    const g = db.team(id);
    await expect(run(g, 'UNWIND range(1, 3000000) AS x CREATE (:Slow {x: x})', {}, { timeoutMs: 50 }))
      .rejects.toThrow(/time/i);
    const [row] = await run<{ n: number }>(g, 'MATCH (s:Slow) RETURN count(s) AS n', {}, { readOnly: true });
    expect(row?.n ?? 0).toBe(0);
  });
});

describe('unreachable database (STRICT 4.5)', () => {
  it('reports DbUnreachable, not a hang', async () => {
    await expect(Db.connect('falkor://localhost:6999', 'x')).rejects.toBeInstanceOf(DbUnreachable);
  });
});

describe('keys and tenancy (STRICT 5.7)', () => {
  it('a key resolves to exactly its own member and team', async () => {
    const a = uniqueTeamId('ta'); const b = uniqueTeamId('tb'); teams.push(a, b);
    await createTeam(db, a, 'Team A');
    await createTeam(db, b, 'Team B');
    const keyA = await createMember(db, a, { id: `${a}.asha`, name: 'Asha', role: 'developer' });
    const keyB = await createMember(db, b, { id: `${b}.ben`, name: 'Ben', role: 'compliance' });
    expect(await authenticate(db, keyA)).toMatchObject({ teamId: a, memberId: `${a}.asha`, role: 'developer' });
    expect(await authenticate(db, keyB)).toMatchObject({ teamId: b, role: 'compliance' });
  });

  it('a wrong or malformed key gets nothing', async () => {
    expect(await authenticate(db, 'pk_notarealkey')).toBeUndefined();
    expect(await authenticate(db, 'Bearer x')).toBeUndefined();
    expect(await authenticate(db, undefined)).toBeUndefined();
  });

  it('reads the bearer header', () => {
    expect(bearer('Bearer pk_abc')).toBe('pk_abc');
    expect(bearer('Basic xyz')).toBeUndefined();
  });
});

describe('paths (STRICT 3, 16.3)', () => {
  it('stores repo-relative paths only', () => {
    expect(toRepoPath('/home/x/tilldesk', '/home/x/tilldesk/src/wallet/limits.ts')).toBe('src/wallet/limits.ts');
    expect(toRepoPath('/home/x/tilldesk', 'src/a.ts')).toBe('src/a.ts');
  });

  it('refuses paths outside the repo', () => {
    expect(() => toRepoPath('/home/x/tilldesk', '/etc/passwd')).toThrow(PathOutsideRepo);
    expect(() => toRepoPath('/home/x/tilldesk', '/home/x/tilldesk/../other/a.ts')).toThrow(PathOutsideRepo);
    expect(() => toRepoPath('/home/x/tilldesk', '/home/x/tilldesk')).toThrow(PathOutsideRepo);
  });

  it('walks folders upwards', () => {
    expect(foldersAbove('src/wallet/limits.ts')).toEqual(['src/wallet', 'src', '.']);
    expect(foldersAbove('index.ts')).toEqual(['.']);
    expect(parentOf('src/wallet/limits.ts')).toBe('src/wallet');
    expect(parentOf('src')).toBe('.');
  });
});
