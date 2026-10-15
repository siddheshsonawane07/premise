// Every Cypher query Premise runs, by name (STRICT 5.4). Values always travel as
// parameters ($name), never joined into the text (STRICT 5.5). These are copied into the
// README with what each is for.

/** `_control` graph: teams, members, hashed keys. */
export const CONTROL = {
  /** Q1. Which member and team a key belongs to. The only way a request learns its tenant. */
  authKey: `
    MATCH (k:Key {hash: $hash})-[:FOR]->(m:Member)-[:IN]->(t:Team)
    RETURN m.id AS memberId, m.name AS name, m.role AS role, t.id AS teamId`,

  createTeam: `
    MERGE (t:Team {id: $id})
    ON CREATE SET t.name = $name
    RETURN t.id AS id`,

  createMember: `
    MATCH (t:Team {id: $teamId})
    MERGE (m:Member {id: $id})
    ON CREATE SET m.name = $name, m.role = $role
    MERGE (m)-[:IN]->(t)
    RETURN m.id AS id`,

  createKey: `
    MATCH (m:Member {id: $memberId})
    CREATE (k:Key {hash: $hash, created_at: $at})-[:FOR]->(m)
    RETURN m.id AS memberId`,

  listTeams: `
    MATCH (t:Team)
    RETURN t.id AS id`,
} as const;

/** One team's graph, `t_<teamId>`. */
export const TEAM = {
  /** The team graph keeps its own Member node so edges never cross graphs. */
  upsertMember: `
    MERGE (m:Member {id: $id})
    SET m.name = $name, m.role = $role
    RETURN m.id AS id`,
} as const;
