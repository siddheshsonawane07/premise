import { createHash, randomUUID } from 'node:crypto';
import type { Principal } from '../auth.ts';
import { type Db, one, run } from '../db/client.ts';
import { TEAM } from '../db/queries.ts';
import { foldersAbove, parentOf } from '../paths.ts';

export type Status = 'draft' | 'final';
export type Unit = 'paise' | 'cents' | 'percent' | 'none';

export interface RuleVersionView {
  ruleId: string;
  title: string;
  risk?: string;
  jurisdiction: string;
  versionId: string;
  n: number;
  text: string;
  figure?: number;
  unit?: Unit;
  citation: string;
  effectiveFrom: string;
  status: Status;
}

export interface NewRule {
  id: string;
  title: string;
  type: 'regulation' | 'decision' | 'constraint';
  owner: string;
  risk: 'low' | 'medium' | 'high';
  jurisdiction: string;
  text: string;
  figure?: number;
  unit?: Unit;
  citation: string;
  effectiveFrom: string;
  status: Status;
  scope: string[];
  /** An internal rule built on another one, e.g. "alert at 80% of the limit". */
  derivesFrom?: string;
  how?: string;
}

/** {child, parent} pairs for every folder above the given paths, for FOLDER_CHAIN. */
export function chainFor(paths: string[], includeSelf = false): { child: string; parent: string }[] {
  const seen = new Set<string>();
  const out: { child: string; parent: string }[] = [];
  for (const p of paths) {
    const folders = includeSelf ? [p, ...foldersAbove(p)] : foldersAbove(p);
    for (const child of folders) {
      if (child === '.' || seen.has(child)) continue;
      seen.add(child);
      out.push({ child, parent: parentOf(child) });
    }
  }
  return out;
}

/** The path itself, then every folder above it. */
export function pathsUp(repoPath: string): string[] {
  return [repoPath, ...foldersAbove(repoPath)];
}

export function versionHash(text: string, figure?: number): string {
  return createHash('sha256').update(`${text}\u0000${figure ?? ''}`).digest('hex').slice(0, 16);
}

/** Only set figure and unit when present: FalkorDB properties are never null (STRICT §5). */
export function figureProps(figure?: number, unit?: Unit): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  if (typeof figure === 'number' && Number.isFinite(figure)) out.figure = figure;
  if (unit) out.unit = unit;
  return out;
}

export async function recordRule(db: Db, who: Principal, rule: NewRule): Promise<{ ruleId: string; versionId: string }> {
  const g = db.team(who.teamId);
  const row = await one<{ ruleId: string; versionId: string }>(g, TEAM.recordRule, {
    ruleId: rule.id,
    title: rule.title,
    type: rule.type,
    owner: rule.owner,
    risk: rule.risk,
    jurisdiction: rule.jurisdiction,
    versionId: `${rule.id}@1`,
    text: rule.text,
    hash: versionHash(rule.text, rule.figure),
    at: Date.now(),
    author: who.memberId,
    citation: rule.citation,
    effectiveFrom: rule.effectiveFrom,
    status: rule.status,
    figure: figureProps(rule.figure, rule.unit),
    chain: chainFor(rule.scope, true),
    scope: rule.scope,
    derivesFrom: rule.derivesFrom ?? '',
    how: rule.how ?? '',
  });
  if (!row) throw new Error(`Unknown jurisdiction ${rule.jurisdiction}`);
  return row;
}

export interface LookupResult {
  found: RuleVersionView[];
  recordedFor?: string;
  proposedScope?: string;
}

/**
 * rule_lookup: the current version of a rule, by id or title words. The lookup is recorded
 * against the member and the file being written (plan D2, D3); a file outside the rule's
 * scope gets a proposed scope edge.
 */
export async function lookupRule(
  db: Db, who: Principal, args: { rule: string; path: string; jurisdiction?: string },
): Promise<LookupResult> {
  const g = db.team(who.teamId);
  let jurisdictions = args.jurisdiction ? [args.jurisdiction] : [];
  if (!jurisdictions.length) {
    const served = await one<{ codes: string[] }>(g, TEAM.servedBy, { folders: foldersAbove(args.path) }, { readOnly: true });
    jurisdictions = served?.codes ?? [];
  }
  // By id or exact title words first; then FalkorDB's full-text index, which stems and matches
  // prefixes ("cash load limit" → "cash loading").
  const find = async (jur: string[]): Promise<RuleVersionView[]> => {
    const exact = await run<RuleVersionView>(g, TEAM.findRule, {
      query: args.rule, queryLower: args.rule.toLowerCase(), jurisdictions: jur,
    }, { readOnly: true });
    if (exact.length) return exact;
    const text = fullTextQuery(args.rule);
    return text ? run<RuleVersionView>(g, TEAM.searchRules, { text, jurisdictions: jur }, { readOnly: true }) : [];
  };
  let found = await find(jurisdictions);
  // A folder that serves a market only narrows the search; it never hides a rule asked for by id.
  if (!found.length && !args.jurisdiction && jurisdictions.length) found = await find([]);
  if (!found.length) return { found };

  const at = Date.now();
  let proposedScope: string | undefined;
  const inScope = await run<{ ruleId: string }>(g, TEAM.rulesForPath, {
    path: args.path, pathsUp: pathsUp(args.path), session: '', member: who.memberId, fallbackSince: at,
  }, { readOnly: true });
  for (const v of found) {
    await run(g, TEAM.recordLookup, {
      id: randomUUID(), member: who.memberId, versionId: v.versionId, path: args.path, at,
    });
    if (!inScope.some((r) => r.ruleId === v.ruleId)) {
      await run(g, TEAM.proposeScope, {
        ruleId: v.ruleId, path: args.path, dir: parentOf(args.path), chain: chainFor([args.path]),
      });
      proposedScope = args.path;
    }
  }
  return { found, recordedFor: args.path, proposedScope };
}

/**
 * A safe full-text query: words only (the index's own operators are stripped). Any word may
 * match, stemmed or as a prefix, and the index's score ranks rules matching more words first.
 * "Cash-load limit!" → "cash|cash*|load|load*|limit|limit*".
 */
export function fullTextQuery(input: string): string {
  const stop = new Set(['the', 'and', 'for', 'per', 'of', 'a', 'an', 'in', 'on', 'to']);
  const words = (input.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !stop.has(w)).slice(0, 8);
  return words.flatMap((w) => [w, `${w}*`]).join('|');
}

const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** 5000000 paise → "₹50,000 (5000000 paise)". */
export function formatFigure(figure?: number, unit?: string): string {
  if (typeof figure !== 'number') return '';
  if (unit === 'paise') return `${INR.format(figure / 100)} (${figure} paise)`;
  if (unit === 'cents') return `${USD.format(figure / 100)} (${figure} cents)`;
  if (unit === 'percent') return `${figure}%`;
  return String(figure);
}
