import { createMember, createTeam, type Principal } from '../../src/auth.ts';
import type { Db } from '../../src/db/client.ts';
import { run } from '../../src/db/client.ts';
import { TEAM } from '../../src/db/queries.ts';
import type { ToolEvent } from '../../src/core/activity.ts';
import { chainFor, recordRule } from '../../src/core/rules.ts';
import { uniqueTeamId } from './db.ts';

// A small Tilldesk for tests: two developers and a compliance member, India and the US,
// the wallet cash-load rule scoped to src/wallet, the US report rule scoped to src/markets/us.

export const ROOT = '/work/tilldesk';

export interface World {
  teamId: string;
  asha: Principal;
  ben: Principal;
  chitra: Principal;
  keys: Record<'asha' | 'ben' | 'chitra', string>;
}

export async function makeWorld(db: Db): Promise<World> {
  const teamId = uniqueTeamId('w');
  await createTeam(db, teamId, 'Tilldesk');
  const p = (id: string, name: string, role: 'developer' | 'compliance'): Principal =>
    ({ memberId: `${teamId}.${id}`, name, role, teamId });
  const asha = p('asha', 'Asha', 'developer');
  const ben = p('ben', 'Ben', 'developer');
  const chitra = p('chitra', 'Chitra', 'compliance');
  const keys = {} as World['keys'];
  for (const [k, m] of [['asha', asha], ['ben', ben], ['chitra', chitra]] as const) {
    keys[k] = await createMember(db, teamId, { id: m.memberId, name: m.name, role: m.role });
  }

  const g = db.team(teamId);
  await run(g, TEAM.upsertRepo, { id: 'tilldesk', name: 'Tilldesk' });
  await run(g, TEAM.upsertJurisdiction, { code: 'IN', name: 'India', regulator: 'Reserve Bank of India' });
  await run(g, TEAM.upsertJurisdiction, { code: 'US', name: 'United States', regulator: 'FinCEN' });
  for (const [path, code] of [['src/wallet', 'IN'], ['src/markets/us', 'US'], ['src/core', 'IN'], ['src/core', 'US']] as const) {
    await run(g, TEAM.serves, { path, code, chain: chainFor([path], true) });
  }

  await recordRule(db, chitra, {
    id: 'in-cash-load', title: 'Full-KYC wallet cash loading, per month', type: 'regulation', owner: chitra.memberId,
    risk: 'high', jurisdiction: 'IN', text: 'Cash loading into a full-KYC wallet is capped at ₹50,000 a month.',
    figure: 50_000_00, unit: 'paise', citation: 'RBI Master Direction on PPIs, 2021', effectiveFrom: '2021-08-27',
    status: 'final', scope: ['src/wallet'],
  });
  await recordRule(db, chitra, {
    id: 'us-ctr', title: 'Currency transaction report threshold', type: 'regulation', owner: chitra.memberId,
    risk: 'high', jurisdiction: 'US', text: 'Cash transactions over $10,000 in a day are reported.',
    figure: 10_000_00, unit: 'cents', citation: '31 CFR 1010.311', effectiveFrom: '2011-03-01',
    status: 'final', scope: ['src/markets/us'],
  });
  return { teamId, asha, ben, chitra, keys };
}

let n = 0;
export function readEv(session: string, path: string, content = 'x'): ToolEvent {
  return {
    session_id: session, cwd: ROOT, tool_name: 'Read', tool_use_id: `toolu_r${++n}`,
    tool_input: { file_path: `${ROOT}/${path}` },
    tool_response: { type: 'text', file: { filePath: `${ROOT}/${path}`, content, numLines: 1, startLine: 1, totalLines: 1 } },
  };
}

export function editEv(session: string, path: string, oldS = 'a', newS = 'b', original = 'a'): ToolEvent {
  return {
    session_id: session, cwd: ROOT, tool_name: 'Edit', tool_use_id: `toolu_e${++n}`,
    tool_input: { file_path: `${ROOT}/${path}`, old_string: oldS, new_string: newS, replace_all: false },
    tool_response: { filePath: `${ROOT}/${path}`, originalFile: original },
  };
}

export function writeEv(session: string, path: string, content: string): ToolEvent {
  return {
    session_id: session, cwd: ROOT, tool_name: 'Write', tool_use_id: `toolu_w${++n}`,
    tool_input: { file_path: `${ROOT}/${path}`, content },
    tool_response: { filePath: `${ROOT}/${path}`, type: 'create' },
  };
}
