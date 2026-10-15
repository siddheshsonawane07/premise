import { ConstraintType, EntityType, type Graph } from 'falkordb';
import { exclusiveSchema, run as runQuery } from './client.ts';

// Every schema statement runs inside exclusiveSchema (see client.ts), so no other query overlaps it.
const run: typeof runQuery = (g, c, p = {}, o = {}) => runQuery(g, c, p, { ...o, schema: true });

// The closed list of node labels and their keys (STRICT 7.5). Every key gets a range
// index and a unique constraint, so a retried hook can never create a second node.
// Created at start-up if missing, then verified; a missing one stops the process (STRICT 5.8).

type Key = readonly [label: string, property: string];

export const TEAM_KEYS: readonly Key[] = [
  ['Member', 'id'],
  ['Repo', 'id'],
  ['Folder', 'path'],
  ['File', 'path'],
  ['Jurisdiction', 'code'],
  ['Rule', 'id'],
  ['RuleVersion', 'id'],
  ['Session', 'id'],
  ['Lookup', 'id'],
  ['Change', 'id'],
  ['Propagation', 'id'],
  ['ReviewTask', 'id'],
  ['Verdict', 'id'],
  ['Claim', 'id'],
  ['FileSnapshot', 'hash'],
];

// Indexed for filtering, not unique.
export const TEAM_EXTRA_INDEXES: readonly Key[] = [
  ['ReviewTask', 'status'],
  ['Change', 'at'],
  ['Lookup', 'at'],
  ['Propagation', 'status'],
  ['RuleVersion', 'rule_id'],
];

/** Full-text indexes: rule_lookup finds rules by words in their title. */
export const TEAM_FULLTEXT: readonly Key[] = [
  ['Rule', 'title'],
];

export const CONTROL_KEYS: readonly Key[] = [
  ['Team', 'id'],
  ['Member', 'id'],
  ['Key', 'hash'],
  ['Budget', 'day'],
];

export class SchemaMissing extends Error {}

export async function ensureTeamSchema(graph: Graph): Promise<void> {
  await exclusiveSchema(() => ensure(graph, TEAM_KEYS, TEAM_EXTRA_INDEXES, TEAM_FULLTEXT));
}

export async function ensureControlSchema(graph: Graph): Promise<void> {
  await exclusiveSchema(() => ensure(graph, CONTROL_KEYS, []));
}

export async function verifyTeamSchema(graph: Graph): Promise<void> {
  await verify(graph, TEAM_KEYS, TEAM_EXTRA_INDEXES, TEAM_FULLTEXT);
}

async function ensure(graph: Graph, keys: readonly Key[], extra: readonly Key[], fulltext: readonly Key[] = []): Promise<void> {
  const have = await readSchema(graph);
  for (const [label, prop] of fulltext) {
    if (!have.fulltext.has(`${label}.${prop}`)) await run(graph, `CREATE FULLTEXT INDEX FOR (n:${label}) ON (n.${prop})`);
  }
  for (const [label, prop] of [...keys, ...extra]) {
    if (!have.indexes.has(`${label}.${prop}`)) {
      // Label and property names come from the closed lists above, never from input.
      await run(graph, `CREATE INDEX FOR (n:${label}) ON (n.${prop})`);
    }
  }
  for (const [label, prop] of keys) {
    if (!have.constraints.has(`${label}.${prop}`)) {
      await graph.constraintCreate(ConstraintType.UNIQUE, EntityType.NODE, label, prop);
    }
  }
  await waitOperational(graph, keys);
  await verify(graph, keys, extra, fulltext);
}

async function verify(graph: Graph, keys: readonly Key[], extra: readonly Key[], fulltext: readonly Key[] = []): Promise<void> {
  const have = await readSchema(graph);
  const missing = [
    ...[...keys, ...extra].filter(([l, p]) => !have.indexes.has(`${l}.${p}`)).map(([l, p]) => `index ${l}.${p}`),
    ...keys.filter(([l, p]) => !have.constraints.has(`${l}.${p}`)).map(([l, p]) => `unique ${l}.${p}`),
    ...fulltext.filter(([l, p]) => !have.fulltext.has(`${l}.${p}`)).map(([l, p]) => `full-text ${l}.${p}`),
  ];
  if (missing.length) throw new SchemaMissing(`Graph is missing: ${missing.join(', ')}`);
}

async function waitOperational(graph: Graph, keys: readonly Key[]): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const rows = await run<{ label: string; properties: string[]; status: string }>(
      graph, 'CALL db.constraints() YIELD label, properties, status RETURN label, properties, status', {}, { readOnly: true });
    const pending = rows.filter((r) => r.status !== 'OPERATIONAL'
      && keys.some(([l, p]) => l === r.label && r.properties.includes(p)));
    if (!pending.length) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new SchemaMissing('Unique constraints did not become operational');
}

async function readSchema(graph: Graph): Promise<{ indexes: Set<string>; fulltext: Set<string>; constraints: Set<string> }> {
  // A graph that does not exist yet has no indexes; FalkorDB reports that as an error.
  try {
    const idx = await run<{ label: string; properties: string[]; types: Record<string, string[]>; entitytype: string }>(
      graph, 'CALL db.indexes() YIELD label, properties, types, entitytype RETURN label, properties, types, entitytype', {}, { readOnly: true });
    const ofType = (t: string) => new Set(idx.filter((r) => r.entitytype === 'NODE')
      .flatMap((r) => r.properties.filter((p) => (r.types?.[p] ?? []).includes(t)).map((p) => `${r.label}.${p}`)));
    const con = await run<{ label: string; properties: string[]; status: string; type: string }>(
      graph, 'CALL db.constraints() YIELD type, label, properties, status RETURN type, label, properties, status', {}, { readOnly: true });
    return {
      indexes: ofType('RANGE'),
      fulltext: ofType('FULLTEXT'),
      constraints: new Set(con.filter((r) => r.type === 'UNIQUE' && r.status === 'OPERATIONAL')
        .flatMap((r) => r.properties.map((p) => `${r.label}.${p}`))),
    };
  } catch (err) {
    if (/Invalid graph operation on empty key|empty key/i.test(String(err))) {
      return { indexes: new Set(), fulltext: new Set(), constraints: new Set() };
    }
    throw err;
  }
}
