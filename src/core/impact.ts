import type { Principal } from '../auth.ts';
import { type Db, run } from '../db/client.ts';
import { TEAM } from '../db/queries.ts';
import type { GEdge, GNode, Why } from './why.ts';

// FalkorDB's graph algorithms, used where their answer is the product's answer:
// algo.SPpaths (how a file connects to a regulator), algo.pageRank (which rules others are built
// on), algo.WCC (which rules are coupled through shared code).

export interface RegulatorPath {
  jurisdiction: string;
  regulator: string;
  hops: number;
  ids: string[];
  kinds: string[];
  labels: string[];
  rels: string[];
}

/** A meaningful connection reads: file ← edit → version → rule (→ rules it is built on) → market. */
const MEANINGFUL = /^TO>RELIED_ON>OF(>DERIVES_FROM)*>APPLIES_IN$/;

export async function shortestToRegulators(db: Db, who: Principal, path: string): Promise<RegulatorPath[]> {
  const rows = await run<RegulatorPath>(db.team(who.teamId), TEAM.shortestToRegulators, { path }, { readOnly: true });
  return rows.filter((r) => MEANINGFUL.test(r.rels.join('>')));
}

/** Draw the shortest paths over the why-graph: add what is missing, mark what is on a path. */
export function overlayPaths(w: Why, paths: RegulatorPath[]): Why & { nodes: (GNode & { sp?: boolean })[]; edges: (GEdge & { sp?: boolean })[] } {
  const nodes = w.nodes.map((n) => ({ ...n })) as (GNode & { sp?: boolean })[];
  const edges = w.edges.map((e) => ({ ...e })) as (GEdge & { sp?: boolean })[];
  for (const p of paths) {
    p.ids.forEach((id, i) => {
      let n = nodes.find((x) => x.id === id);
      if (!n) { n = { id, kind: p.kinds[i]!, label: p.labels[i] ?? id }; nodes.push(n); }
      n.sp = true;
      if (i === 0) return;
      const a = p.ids[i - 1]!;
      const e = edges.find((x) => (x.from === a && x.to === id) || (x.from === id && x.to === a));
      if (e) e.sp = true;
      else edges.push({ from: a, to: id, type: p.rels[i - 1]!, sp: true });
    });
  }
  return { ...w, nodes, edges };
}

export interface RuleImpact {
  ruleId: string;
  title: string;
  risk: string;
  jurisdiction: string;
  figure?: number;
  unit?: string;
  direct: number;
  viaDerived: number;
  derived: string[];
  pageRank: number;
}

export interface Impact {
  rules: RuleImpact[];
  clusters: { componentId: number; rules: string[]; files: number }[];
  coupling: { path: string; rules: string[] }[];
}

export async function impact(db: Db, who: Principal): Promise<Impact> {
  const g = db.team(who.teamId);
  const ro = { readOnly: true };
  const [rank, blast, clusters, coupling] = await Promise.all([
    run<{ ruleId: string; score: number }>(g, TEAM.rulePageRank, {}, ro),
    run<Omit<RuleImpact, 'pageRank'>>(g, TEAM.blastRadius, {}, ro),
    run<Impact['clusters'][number]>(g, TEAM.ruleClusters, {}, ro),
    run<Impact['coupling'][number]>(g, TEAM.couplingFiles, {}, ro),
  ]);
  const score = new Map(rank.map((r) => [r.ruleId, r.score]));
  const rules = blast
    .map((b) => ({ ...b, pageRank: score.get(b.ruleId) ?? 0 }))
    .sort((a, b) => b.pageRank - a.pageRank || (b.direct + b.viaDerived) - (a.direct + a.viaDerived));
  return { rules, clusters, coupling };
}
