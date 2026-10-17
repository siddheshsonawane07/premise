import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordSnapshot } from '../src/core/activity.ts';
import { parseImports } from '../src/core/imports.ts';
import { type Db, run } from '../src/db/client.ts';
import { importedSources } from '../src/review/reviewer.ts';
import { dropTeam, testDb } from './helpers/db.ts';
import { makeWorld, type World } from './helpers/world.ts';

// A file that only borrows a constant should not be judged blind: Premise records IMPORTS
// edges from each snapshot and follows them to the file that still holds the old figure.

describe('parseImports', () => {
  it('reads named, default, star and re-exports, relative only, resolved to repo paths', () => {
    const src = [
      "import { FULL_KYC_LIMIT, type Paise, ALERT as A } from './limits.ts';",
      "import fmt from '../core/format';",
      "import * as z from 'zod';",
      "export { FULL_KYC_LIMIT } from './limits.js';",
      "export * from './messages.ts';",
      "import {\n  one,\n  two,\n} from '../core/many.ts';",
      'export function f() { return 1; }',
      "const s = 'not an import from \"./nowhere.ts\"';",
    ].join('\n');
    expect(parseImports('src/wallet/index.ts', src)).toEqual([
      { path: 'src/wallet/limits.ts', names: ['ALERT', 'FULL_KYC_LIMIT', 'Paise'] },
      { path: 'src/core/format.ts', names: ['default'] },
      { path: 'src/wallet/messages.ts', names: ['*'] },
      { path: 'src/core/many.ts', names: ['one', 'two'] },
    ]);
  });

  it('ignores non-code files and paths that leave the repo', () => {
    expect(parseImports('README.md', "import x from './a.ts'")).toEqual([]);
    expect(parseImports('src/a.ts', "import x from '../../../outside.ts'")).toEqual([]);
  });
});

let db: Db;
let w: World;

beforeAll(async () => {
  db = await testDb();
  w = await makeWorld(db);
  // topup imports from the index, which re-exports the limit from limits.ts: two hops.
  await recordSnapshot(db, w.asha, 'src/wallet/topup.ts', "import { LIMIT } from './index.ts';\nexport const ok = (p: number) => p <= LIMIT;");
  await recordSnapshot(db, w.asha, 'src/wallet/index.ts', "export { LIMIT } from './limits.ts';");
  await recordSnapshot(db, w.asha, 'src/wallet/limits.ts', 'export const LIMIT = 50_000_00;');
});
afterAll(async () => { await dropTeam(db, w.teamId); await db.close(); });

describe('IMPORTS edges', () => {
  it('are recorded with the names each import brings in, even before the target is seen', async () => {
    const rows = await run<{ from: string; to: string; names: string[] }>(db.team(w.teamId),
      'MATCH (a:File)-[e:IMPORTS]->(b:File) RETURN a.path AS from, b.path AS to, e.names AS names ORDER BY from');
    expect(rows).toEqual([
      { from: 'src/wallet/index.ts', to: 'src/wallet/limits.ts', names: ['LIMIT'] },
      { from: 'src/wallet/topup.ts', to: 'src/wallet/index.ts', names: ['LIMIT'] },
    ]);
  });

  it('are replaced, not added to, when the content changes', async () => {
    await recordSnapshot(db, w.ben, 'src/wallet/other.ts', "import { A } from './a.ts';");
    await recordSnapshot(db, w.ben, 'src/wallet/other.ts', "import { B } from './b.ts';");
    const rows = await run<{ to: string }>(db.team(w.teamId),
      "MATCH (:File {path: 'src/wallet/other.ts'})-[:IMPORTS]->(b:File) RETURN b.path AS to");
    expect(rows).toEqual([{ to: 'src/wallet/b.ts' }]);
  });

  it('lead the Reviewer from a borrowing file to the file that holds the old figure', async () => {
    const sources = await importedSources(db, w.teamId, { path: 'src/wallet/topup.ts', oldFigure: 50_000_00, unit: 'paise' });
    expect(sources.map((s) => ({ path: s.path, via: s.via, hops: s.hops }))).toEqual([
      { path: 'src/wallet/limits.ts', via: ['src/wallet/topup.ts', 'src/wallet/index.ts', 'src/wallet/limits.ts'], hops: 2 },
    ]);
  });

  it('find nothing once the defining file holds the new figure', async () => {
    await recordSnapshot(db, w.asha, 'src/wallet/limits.ts', 'export const LIMIT = 10_000_00;');
    expect(await importedSources(db, w.teamId, { path: 'src/wallet/topup.ts', oldFigure: 50_000_00, unit: 'paise' })).toEqual([]);
  });
});
