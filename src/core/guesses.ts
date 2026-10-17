import type { Principal } from '../auth.ts';
import { type Db, one, run } from '../db/client.ts';
import { TEAM } from '../db/queries.ts';
import { NotAllowed } from './change.ts';

// Figures an agent recorded without a source, waiting for compliance. Confirming one makes the
// draft final in place (nothing changed, so nothing to propagate); correcting one is an ordinary
// rule change (supersede), which finds every file built on the guess.

export interface Guess {
  ruleId: string; title: string; jurisdiction: string; versionId: string; figure?: number; unit?: string;
  text: string; citation: string; effectiveFrom: string; authorName?: string; files: string[]; asked: string[];
}

export async function listGuesses(db: Db, teamId: string): Promise<Guess[]> {
  return run<Guess>(db.team(teamId), TEAM.guessedFigures, {}, { readOnly: true });
}

/** Compliance only, and only with a source that is not itself "unverified". */
export async function confirmGuess(db: Db, who: Principal, ruleId: string, citation: string): Promise<string> {
  if (who.role !== 'compliance') throw new NotAllowed('Only a compliance member can confirm a figure.');
  const source = citation.trim();
  if (!source || /^unverified/i.test(source)) throw new NotAllowed('Name the source you checked the figure against.');
  const row = await one<{ versionId: string }>(db.team(who.teamId), TEAM.confirmGuess, {
    ruleId, member: who.memberId, citation: source.slice(0, 300), at: Date.now(), reason: 'Confirmed by compliance',
  });
  if (!row) throw new NotAllowed(`${ruleId} has no draft waiting to be confirmed.`);
  return row.versionId;
}
