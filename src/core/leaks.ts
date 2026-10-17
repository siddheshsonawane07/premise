import path from 'node:path';
import type { Principal } from '../auth.ts';
import { type Db, one, run } from '../db/client.ts';
import { TEAM } from '../db/queries.ts';
import { figureSpellings, formatFigure, mentionsFigure, pathsUp } from './rules.ts';

// The leak guard. A well-built app keeps a legal figure in one setting that everything else
// reads. When an agent is about to type that figure somewhere else, Premise denies the edit
// once and names the setting to import. Retrying the same edit goes through, because the
// number may mean something else (an ESI test input of ₹15,000 is not the EPF ceiling).

interface Candidate { ruleId: string; title: string; versionId: string; figure: number; unit?: string; jurisdiction: string }
export interface Leak extends Candidate { home: string; name: string; importers: number }

/** The text an edit adds, and the text it replaces. */
export function addedText(toolInput: Record<string, unknown>, before?: string): { added: string; removed: string } {
  if (typeof toolInput.content === 'string') return { added: toolInput.content, removed: before ?? '' };
  const edits = Array.isArray(toolInput.edits) ? toolInput.edits as Record<string, unknown>[] : [toolInput];
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return { added: edits.map((e) => str(e.new_string)).join('\n'), removed: edits.map((e) => str(e.old_string)).join('\n') };
}

/** `export const NAME = 1_500_000` (optionally typed) for one of the spellings, or undefined. */
export function exportedName(content: string, spellings: string[]): string | undefined {
  for (const s of spellings) {
    const m = content.match(new RegExp(`export\\s+const\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=]*)?=\\s*${s}(?![\\d_.])`));
    if (m) return m[1];
  }
  return undefined;
}

/** The figures this edit types that already live in a setting elsewhere, not yet warned about. */
export async function findLeaks(
  db: Db, who: Principal, session: string, filePath: string, toolInput: Record<string, unknown>,
): Promise<Leak[]> {
  const g = db.team(who.teamId);
  const before = typeof toolInput.content === 'string'
    ? (await one<{ content: string }>(g, TEAM.latestSnapshot, { path: filePath }, { readOnly: true }))?.content
    : undefined;
  const { added, removed } = addedText(toolInput, before);
  if (!added) return [];
  const served = await one<{ codes: string[] }>(g, TEAM.servedBy, { folders: pathsUp(filePath).slice(1) }, { readOnly: true });
  const candidates = await run<Candidate>(g, TEAM.figuresInMarket, { markets: served?.codes ?? [] }, { readOnly: true });

  const leaks: Leak[] = [];
  for (const c of candidates) {
    const terms = figureSpellings(c.figure, c.unit);
    if (!terms.length || !mentionsFigure(added, terms) || mentionsFigure(removed, terms)) continue;
    const homes = await run<{ path: string; content: string; importers: number }>(g, TEAM.figureHome, { terms }, { readOnly: true });
    const home = homes.map((h) => ({ ...h, name: exportedName(h.content, terms) })).find((h) => h.name);
    // No setting holds it yet, or this file is the setting: nothing to point to.
    if (!home || home.path === filePath) continue;
    leaks.push({ ...c, home: home.path, name: home.name!, importers: home.importers });
  }
  if (!leaks.length) return [];
  const warned = await run<{ versionId: string }>(g, TEAM.leakWarned, {
    session, path: filePath, versionIds: leaks.map((l) => l.versionId),
  }, { readOnly: true });
  const seen = new Set(warned.map((w) => w.versionId));
  return leaks.filter((l) => !seen.has(l.versionId));
}

export async function markLeakWarned(db: Db, who: Principal, session: string, filePath: string, leaks: Leak[], tool: string) {
  await run(db.team(who.teamId), TEAM.markLeakWarned, {
    session, member: who.memberId, path: filePath, versionIds: leaks.map((l) => l.versionId), at: Date.now(), tool,
  });
}

export function forLeak(filePath: string, leaks: Leak[]): string {
  const lines = leaks.map((l) => {
    let spec = path.posix.relative(path.posix.dirname(filePath), l.home);
    if (!spec.startsWith('.')) spec = `./${spec}`;
    const users = l.importers ? `, which ${l.importers} file${l.importers === 1 ? '' : 's'} already import${l.importers === 1 ? 's' : ''}` : '';
    return `- ${formatFigure(l.figure, l.unit)} is the figure of "${l.title}" [${l.jurisdiction}]. ` +
      `It already lives in ${l.home} as ${l.name}${users}. Use: import { ${l.name} } from '${spec}';`;
  });
  return [
    `Premise: this edit to ${filePath} types a figure that already has one home:`,
    ...lines,
    '',
    'Read it from there, so a change to the rule is made in one place. In a test, build the case from the ' +
      `constant (for example ${leaks[0]!.name} + 1) so the test follows the setting.`,
    'If the number here means something else, retry the same edit and it will go through.',
  ].join('\n');
}
