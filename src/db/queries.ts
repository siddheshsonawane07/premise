// Every Cypher query Premise runs, by name (STRICT 5.4). Values always travel as
// parameters ($name), never joined into the text (STRICT 5.5). These are copied into the
// README with what each is for.
//
// Two FalkorDB habits used throughout:
// - A folder chain is written with FOREACH over a list of {child, parent} pairs, so a file at
//   the repo root (empty list) does not stop the query.
// - Nothing is SET on a possibly-null OPTIONAL MATCH result; a FOREACH over an empty-or-one
//   list guards it. On v4.22.0 with the append-only file on, a bare SET on null kills the server.

const FOLDER_CHAIN = `
    FOREACH (link IN $chain |
      MERGE (c:Folder {path: link.child})
      MERGE (p:Folder {path: link.parent})
      MERGE (c)-[:IN]->(p))`;

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

  upsertRepo: `
    MERGE (r:Repo {id: $id})
    ON CREATE SET r.name = $name
    MERGE (root:Folder {path: '.'})
    MERGE (r)-[:HAS]->(root)
    RETURN r.id AS id`,

  upsertJurisdiction: `
    MERGE (j:Jurisdiction {code: $code})
    SET j.name = $name, j.regulator = $regulator
    RETURN j.code AS code`,

  /** Which markets a folder's code runs for. */
  serves: `
    MATCH (j:Jurisdiction {code: $code})
    ${FOLDER_CHAIN}
    MERGE (f:Folder {path: $path})
    MERGE (f)-[:SERVES]->(j)
    RETURN f.path AS path`,

  /** Q3. A new rule with its first version, its jurisdiction and its declared scope (folders). */
  recordRule: `
    MATCH (j:Jurisdiction {code: $jurisdiction})
    CREATE (r:Rule {id: $ruleId, title: $title, type: $type, owner: $owner, risk: $risk})
    CREATE (v:RuleVersion {id: $versionId, rule_id: $ruleId, n: 1, text: $text, hash: $hash, at: $at,
                           author: $author, citation: $citation, effective_from: $effectiveFrom, status: $status})
    SET v += $figure
    CREATE (r)-[:CURRENT]->(v)
    CREATE (r)-[:APPLIES_IN]->(j)
    ${FOLDER_CHAIN}
    FOREACH (p IN $scope |
      MERGE (f:Folder {path: p})
      MERGE (r)-[:SCOPE {source: 'declared'}]->(f))
    RETURN r.id AS ruleId, v.id AS versionId`,

  /** Q4a. Find a rule's current version by id or by words in its title, optionally by market. */
  findRule: `
    MATCH (r:Rule)-[:CURRENT]->(v:RuleVersion)
    MATCH (r)-[:APPLIES_IN]->(j:Jurisdiction)
    WHERE (r.id = $query OR toLower(r.title) CONTAINS $queryLower)
      AND (size($jurisdictions) = 0 OR j.code IN $jurisdictions)
    RETURN r.id AS ruleId, r.title AS title, r.risk AS risk, j.code AS jurisdiction,
           v.id AS versionId, v.n AS n, v.text AS text, v.figure AS figure, v.unit AS unit,
           v.citation AS citation, v.effective_from AS effectiveFrom, v.status AS status
    ORDER BY ruleId
    LIMIT 5`,

  /** Which markets the folders above a path serve. */
  servedBy: `
    MATCH (f:Folder)-[:SERVES]->(j:Jurisdiction)
    WHERE f.path IN $folders
    RETURN collect(DISTINCT j.code) AS codes`,

  /** Q4b. Record that this member asked for this rule version while writing this path. */
  recordLookup: `
    MATCH (m:Member {id: $member})
    MATCH (v:RuleVersion {id: $versionId})
    CREATE (l:Lookup {id: $id, path: $path, at: $at})
    CREATE (l)-[:BY]->(m)
    CREATE (l)-[:OF]->(v)
    RETURN l.id AS id`,

  /** Q4c. A lookup landed outside the rule's scope: propose widening it to that file. */
  proposeScope: `
    MATCH (r:Rule {id: $ruleId})
    ${FOLDER_CHAIN}
    MERGE (d:Folder {path: $dir})
    MERGE (f:File {path: $path})
    MERGE (f)-[:IN]->(d)
    MERGE (r)-[:SCOPE {source: 'proposed'}]->(f)
    RETURN f.path AS path`,

  /**
   * Q5. The current rules governing a path: a SCOPE edge to the file or any folder above it,
   * kept to the markets the path's folders serve (if any). For each, whether this session was
   * already shown it for this path, and whether this member looked it up for this path since
   * the session began. $pathsUp is the path itself followed by every folder above it.
   */
  rulesForPath: `
    OPTIONAL MATCH (sf:Folder)-[:SERVES]->(sj:Jurisdiction)
    WHERE sf.path IN $pathsUp
    WITH collect(DISTINCT sj.code) AS served
    OPTIONAL MATCH (sess:Session {id: $session})
    WITH served, coalesce(sess.started_at, $fallbackSince) AS since
    OPTIONAL MATCH (lastChange:Change)-[:TO]->(:File {path: $path})
    WITH served, since, max(lastChange.at) AS lastEdit
    MATCH (r:Rule)-[:SCOPE]->(s)
    WHERE s.path IN $pathsUp
    MATCH (r)-[:CURRENT]->(v:RuleVersion)
    MATCH (r)-[:APPLIES_IN]->(j:Jurisdiction)
    WITH DISTINCT served, since, lastEdit, r, v, j
    WHERE size(served) = 0 OR j.code IN served
    OPTIONAL MATCH (:Session {id: $session})-[sh:SHOWN {path: $path}]->(v)
    WITH since, lastEdit, r, v, j, count(sh) > 0 AS shown
    OPTIONAL MATCH (:Member {id: $member})<-[:BY]-(lk:Lookup {path: $path})-[:OF]->(v)
    WHERE lk.at >= since
    WITH lastEdit, r, v, j, shown, count(lk) > 0 AS asked
    OPTIONAL MATCH (v)-[:PARENT]->(prev:RuleVersion)
    RETURN r.id AS ruleId, r.title AS title, r.risk AS risk, j.code AS jurisdiction,
           v.id AS versionId, v.n AS n, v.text AS text, v.figure AS figure, v.unit AS unit,
           v.citation AS citation, v.effective_from AS effectiveFrom, v.status AS status, v.at AS versionAt,
           prev.figure AS previousFigure, lastEdit, shown, asked
    ORDER BY ruleId`,

  /** Open review tasks on a file, with who has them and any live claim. */
  fileTasks: `
    MATCH (t:ReviewTask)-[:FOR]->(:File {path: $path})
    WHERE t.status IN ['open', 'proposed_clear']
    MATCH (t)-[:ASSIGNED]->(m:Member)
    MATCH (t)-[:BECAUSE]->(p:Propagation)-[:TO]->(nv:RuleVersion)
    OPTIONAL MATCH (c:Claim)-[:ON]->(t)
    WHERE c.expires_at > $now
    OPTIONAL MATCH (c)-[:BY]->(cs:Session)-[:BY]->(cm:Member)
    RETURN t.id AS taskId, t.status AS status, t.due AS due, t.tier AS tier,
           m.id AS assignee, m.name AS assigneeName, p.rule_id AS ruleId,
           nv.figure AS newFigure, nv.unit AS unit,
           cs.id AS claimSession, cm.name AS claimBy, c.expires_at AS claimExpires`,

  /** Q2. Open (or reopen) a session and link it to its member. */
  openSession: `
    MERGE (s:Session {id: $session})
    ON CREATE SET s.tool = $tool, s.started_at = $at, s.branch = $branch
    WITH s
    MATCH (m:Member {id: $member})
    MERGE (s)-[:BY]->(m)
    RETURN s.started_at AS startedAt`,

  /** When this member's previous session began. */
  previousSession: `
    MATCH (m:Member {id: $member})<-[:BY]-(p:Session)
    WHERE p.id <> $session
    RETURN max(p.started_at) AS previous`,

  /** Rule versions (final or draft) created since a time, with their rule. */
  versionsSince: `
    MATCH (v:RuleVersion)
    WHERE v.at > $since
    MATCH (r:Rule {id: v.rule_id})-[:APPLIES_IN]->(j:Jurisdiction)
    OPTIONAL MATCH (v)-[:PARENT]->(prev:RuleVersion)
    RETURN r.id AS ruleId, r.title AS title, j.code AS jurisdiction, v.id AS versionId, v.n AS n,
           v.status AS status, v.figure AS figure, v.unit AS unit, prev.figure AS previousFigure,
           v.effective_from AS effectiveFrom, v.citation AS citation
    ORDER BY v.at`,

  /** Q18. A member's review tasks, soonest due first. */
  myTasks: `
    MATCH (t:ReviewTask)-[:ASSIGNED]->(:Member {id: $member})
    WHERE t.status IN ['open', 'proposed_clear']
    MATCH (t)-[:FOR]->(f:File)
    MATCH (t)-[:BECAUSE]->(p:Propagation)-[:TO]->(nv:RuleVersion)
    MATCH (p)-[:FROM]->(ov:RuleVersion)
    MATCH (r:Rule {id: p.rule_id})
    OPTIONAL MATCH (t)-[:HAS]->(vd:Verdict)
    RETURN t.id AS taskId, t.status AS status, t.due AS due, t.tier AS tier, f.path AS path,
           r.id AS ruleId, r.title AS title, ov.figure AS oldFigure, nv.figure AS newFigure, nv.unit AS unit,
           vd.verdict AS verdict, vd.reason AS verdictReason
    ORDER BY due`,

  /** Q6. What a hook (or a deny) just showed this session for this path. */
  markShown: `
    MERGE (s:Session {id: $session})
    ON CREATE SET s.tool = $tool, s.started_at = $at
    WITH s
    MATCH (m:Member {id: $member})
    MERGE (s)-[:BY]->(m)
    WITH s
    UNWIND $versionIds AS vid
    MATCH (v:RuleVersion {id: vid})
    MERGE (s)-[e:SHOWN {path: $path}]->(v)
    ON CREATE SET e.at = $at
    RETURN count(e) AS shown`,

  /**
   * Q7. One edit, recorded in one query (STRICT 5.6): the Change, the session and file it
   * belongs to, one RELIED_ON edge per rule version in scope at the tier decided from what was
   * shown or asked, and any open review task this change resolves (it relied on the task's new
   * version at tier `asked`). An unrelated edit, such as a typo fix, resolves nothing.
   */
  recordChange: `
    MERGE (s:Session {id: $session})
    ON CREATE SET s.tool = $tool, s.started_at = $at, s.branch = $branch
    WITH s
    MATCH (m:Member {id: $member})
    MERGE (s)-[:BY]->(m)
    ${FOLDER_CHAIN}
    MERGE (d:Folder {path: $dir})
    MERGE (f:File {path: $path})
    MERGE (f)-[:IN]->(d)
    CREATE (ch:Change {id: $changeId, diff: $diff, at: $at, branch: $branch})
    CREATE (ch)-[:IN]->(s)
    CREATE (ch)-[:TO]->(f)
    WITH ch, f
    UNWIND $relied AS rel
    MATCH (v:RuleVersion {id: rel.versionId})
    CREATE (ch)-[:RELIED_ON {tier: rel.tier}]->(v)
    WITH ch, f, v, rel
    OPTIONAL MATCH (t:ReviewTask)-[:FOR]->(f), (t)-[:BECAUSE]->(:Propagation)-[:TO]->(v)
    WHERE rel.tier = 'asked' AND t.status IN ['open', 'proposed_clear']
    FOREACH (x IN CASE WHEN t IS NULL THEN [] ELSE [t] END |
      SET x.status = 'resolved', x.resolved_reason = $resolvedReason, x.resolved_at = $at)
    RETURN count(DISTINCT t) AS resolved`,

  /** Q8. The file's latest content, for the Reviewer. Snapshots are shared by content hash. */
  recordSnapshot: `
    ${FOLDER_CHAIN}
    MERGE (d:Folder {path: $dir})
    MERGE (f:File {path: $path})
    MERGE (f)-[:IN]->(d)
    WITH f
    OPTIONAL MATCH (f)-[old:LATEST]->(:FileSnapshot)
    WITH f, collect(old) AS olds
    FOREACH (o IN olds | DELETE o)
    MERGE (fs:FileSnapshot {hash: $hash})
    ON CREATE SET fs.content = $content, fs.at = $at
    MERGE (f)-[:LATEST]->(fs)
    RETURN fs.hash AS hash`,

  /** Q9a. Of these paths, which already have a change from this session. */
  changedInSession: `
    MATCH (:Session {id: $session})<-[:IN]-(:Change)-[:TO]->(f:File)
    WHERE f.path IN $paths
    RETURN collect(DISTINCT f.path) AS paths`,
} as const;
