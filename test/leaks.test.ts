import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postEdit, preEdit, recordSnapshot, sessionStart } from '../src/core/activity.ts';
import { addedText, exportedName } from '../src/core/leaks.ts';
import { lookupRule } from '../src/core/rules.ts';
import { type Db, run } from '../src/db/client.ts';
import { dropTeam, testDb } from './helpers/db.ts';
import { makeWorld, ROOT, type World, writeEv } from './helpers/world.ts';

// The leak guard: once the cash limit lives in one setting that other files import, an agent
// that types ₹50,000 into another file is told, once, to import the setting instead.

let db: Db;
let w: World;
const edit = (session: string, file: string, oldS: string, newS: string) => ({
  session_id: session, cwd: ROOT, tool_name: 'Edit',
  tool_input: { file_path: `${ROOT}/${file}`, old_string: oldS, new_string: newS },
});

beforeAll(async () => {
  db = await testDb();
  w = await makeWorld(db);
  await recordSnapshot(db, w.asha, 'src/wallet/limits.ts', 'export const FULL_KYC_LIMIT_PAISE: number = 50_000_00;');
  await recordSnapshot(db, w.asha, 'src/wallet/topup.ts', "import { FULL_KYC_LIMIT_PAISE } from './limits.ts';");
  await sessionStart(db, w.ben, { session_id: 'leak-ben' });
  await lookupRule(db, w.ben, { rule: 'in-cash-load', path: 'src/wallet/receipt.ts' });
});
afterAll(async () => { await dropTeam(db, w.teamId); await db.close(); });

describe('helpers', () => {
  it('addedText reads Write, Edit and MultiEdit', () => {
    expect(addedText({ content: 'new' }, 'old')).toEqual({ added: 'new', removed: 'old' });
    expect(addedText({ old_string: 'a', new_string: 'b' })).toEqual({ added: 'b', removed: 'a' });
    expect(addedText({ edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }))
      .toEqual({ added: 'b\nd', removed: 'a\nc' });
  });

  it('exportedName finds a typed or untyped exported constant, whole numbers only', () => {
    expect(exportedName('export const A: number = 50_000_00;', ['50_000_00'])).toBe('A');
    expect(exportedName('export const B = 50_000_00', ['50_000_00'])).toBe('B');
    expect(exportedName('export const C = 50_000_001', ['50_000_00'])).toBeUndefined();
    expect(exportedName('const D = 50_000_00', ['50_000_00'])).toBeUndefined();
  });
});

describe('the leak guard', () => {
  it('denies an edit that types the figure, and names the setting to import', async () => {
    const d = await preEdit(db, w.ben, edit('leak-ben', 'src/wallet/receipt.ts', 'const cap = 0;', 'const cap = 50_000_00;'));
    expect(d.decision).toBe('deny');
    const reason = d.decision === 'deny' ? d.reason : '';
    expect(reason).toContain('src/wallet/limits.ts as FULL_KYC_LIMIT_PAISE');
    expect(reason).toContain("import { FULL_KYC_LIMIT_PAISE } from './limits.ts';");
    expect(reason).toContain('which 1 file already imports');
  });

  it('lets the same edit through on retry, since the number may mean something else', async () => {
    const d = await preEdit(db, w.ben, edit('leak-ben', 'src/wallet/receipt.ts', 'const cap = 0;', 'const cap = 50_000_00;'));
    expect(d.decision).toBe('allow');
  });

  it('records the warning in the graph, against the rule version', async () => {
    const rows = await run<{ v: string; path: string }>(db.team(w.teamId),
      "MATCH (:Session {id: 'leak-ben'})-[e:LEAK_WARNED]->(v:RuleVersion) RETURN v.id AS v, e.path AS path");
    expect(rows).toEqual([{ v: 'in-cash-load@1', path: 'src/wallet/receipt.ts' }]);
  });

  it('says nothing when the setting itself is edited, or the figure was already there', async () => {
    await lookupRule(db, w.ben, { rule: 'in-cash-load', path: 'src/wallet/limits.ts' });
    const own = await preEdit(db, w.ben, edit('leak-ben', 'src/wallet/limits.ts', '50_000_00;', '50_000_00; // RBI'));
    expect(own.decision).toBe('allow');
    await lookupRule(db, w.ben, { rule: 'in-cash-load', path: 'src/wallet/other.ts' });
    await postEdit(db, w.ben, writeEv('leak-ben', 'src/wallet/other.ts', 'const x = 1;'));
    const kept = await preEdit(db, w.ben, edit('leak-ben', 'src/wallet/other.ts', 'a(50_000_00)', 'b(50_000_00)'));
    expect(kept.decision).toBe('allow');
  });

  it('ignores figures of another market: $10,000 in a US file is not the Indian limit', async () => {
    await lookupRule(db, w.ben, { rule: 'us-ctr', path: 'src/markets/us/report.ts' });
    const d = await preEdit(db, w.ben, edit('leak-ben', 'src/markets/us/report.ts', 'x', 'const y = 50_000_00;'));
    expect(d.decision).toBe('allow');
  });
});
