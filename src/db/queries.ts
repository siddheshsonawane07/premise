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

  /** Removing a team (the demo reset): keys, then members, then the team. */
  deleteTeamKeys: `
    MATCH (:Team {id: $id})<-[:IN]-(:Member)<-[:FOR]-(k:Key)
    DETACH DELETE k`,

  deleteTeamMembers: `
    MATCH (:Team {id: $id})<-[:IN]-(m:Member)
    DETACH DELETE m`,

  deleteTeam: `
    MATCH (t:Team {id: $id})
    DETACH DELETE t`,

  /** The web view acts as one member, chosen by id on the server (never by the browser). */
  principalById: `
    MATCH (m:Member {id: $id})-[:IN]->(t:Team)
    RETURN m.id AS memberId, m.name AS name, m.role AS role, t.id AS teamId`,

  /** The Reviewer's spend today, in micro-dollars. */
  budgetSpent: `
    MATCH (b:Budget {day: $day})
    RETURN b.spent_microusd AS spent`,

  budgetSpend: `
    MERGE (b:Budget {day: $day})
    ON CREATE SET b.spent_microusd = 0
    SET b.spent_microusd = b.spent_microusd + $micro
    RETURN b.spent_microusd AS spent`,
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
    CREATE (v)-[:OF]->(r)
    CREATE (r)-[:APPLIES_IN]->(j)
    ${FOLDER_CHAIN}
    FOREACH (p IN $scope |
      MERGE (f:Folder {path: p})
      MERGE (r)-[:SCOPE {source: 'declared'}]->(f))
    WITH r, v
    OPTIONAL MATCH (base:Rule {id: $derivesFrom})
    FOREACH (b IN CASE WHEN base IS NULL THEN [] ELSE [base] END |
      CREATE (r)-[:DERIVES_FROM {how: $how}]->(b))
    RETURN r.id AS ruleId, v.id AS versionId`,

  /**
   * Q4d. Find rules by words in their title, through FalkorDB's full-text index (stemmed, prefix
   * matches): "cash load limit" finds "Full-KYC wallet cash loading". Team conventions apply in
   * every market.
   */
  searchRules: `
    CALL db.idx.fulltext.queryNodes('Rule', $text) YIELD node, score
    WITH node AS r, score
    MATCH (r)-[:CURRENT]->(v:RuleVersion)
    MATCH (r)-[:APPLIES_IN]->(j:Jurisdiction)
    WHERE size($jurisdictions) = 0 OR j.code IN $jurisdictions OR j.code = 'TEAM'
    RETURN r.id AS ruleId, r.title AS title, r.risk AS risk, j.code AS jurisdiction,
           v.id AS versionId, v.n AS n, v.text AS text, v.figure AS figure, v.unit AS unit,
           v.citation AS citation, v.effective_from AS effectiveFrom, v.status AS status, score
    ORDER BY score DESC
    LIMIT 5`,

  /** Q4a. Find a rule's current version by id or by words in its title, optionally by market. */
  findRule: `
    MATCH (r:Rule)-[:CURRENT]->(v:RuleVersion)
    MATCH (r)-[:APPLIES_IN]->(j:Jurisdiction)
    WHERE (r.id = $query OR toLower(r.title) CONTAINS $queryLower)
      AND (size($jurisdictions) = 0 OR j.code IN $jurisdictions OR j.code = 'TEAM')
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
    WHERE size(served) = 0 OR j.code IN served OR j.code = 'TEAM'
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

  /**
   * Rule versions this member looked up since the session began, for any file, with their market.
   * An edited file that is not in such a rule's scope still relied on it at tier `session`: the
   * agent had the figure in hand (real sessions copy it into tests written right after).
   */
  sessionLookups: `
    MATCH (s:Session {id: $session})
    MATCH (:Member {id: $member})<-[:BY]-(lk:Lookup)-[:OF]->(v:RuleVersion)
    WHERE lk.at >= s.started_at
    MATCH (r:Rule {id: v.rule_id})-[:APPLIES_IN]->(j:Jurisdiction)
    RETURN DISTINCT v.id AS versionId, r.id AS ruleId, j.code AS jurisdiction`,

  /** Open review tasks on a file, with who has them and any live claim. */
  fileTasks: `
    MATCH (t:ReviewTask)-[:FOR]->(:File {path: $path})
    WHERE t.status IN ['open', 'proposed_clear']
    MATCH (t)-[:ASSIGNED]->(m:Member)
    MATCH (t)-[:BECAUSE]->(p:Propagation)-[:TO]->(nv:RuleVersion)
    OPTIONAL MATCH (c:Claim)-[:ON]->(t)
    WHERE c.expires_at > $now
    OPTIONAL MATCH (c)-[:BY]->(cm:Member)
    RETURN t.id AS taskId, t.status AS status, t.due AS due, t.tier AS tier,
           m.id AS assignee, m.name AS assigneeName, p.rule_id AS ruleId,
           nv.figure AS newFigure, nv.unit AS unit,
           cm.id AS claimMember, cm.name AS claimBy, c.expires_at AS claimExpires`,

  /** Q2. Open (or reopen) a session and link it to its member. */
  openSession: `
    MERGE (s:Session {id: $session})
    ON CREATE SET s.tool = $tool, s.started_at = $at, s.branch = $branch, s.model = $model
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
    MATCH (t:ReviewTask)-[:ASSIGNED]->(me:Member {id: $member})
    WHERE t.status IN ['open', 'proposed_clear']
    MATCH (t)-[:FOR]->(f:File)
    MATCH (t)-[:BECAUSE]->(p:Propagation)-[:TO]->(nv:RuleVersion)
    MATCH (p)-[:FROM]->(ov:RuleVersion)
    MATCH (r:Rule {id: p.rule_id})
    OPTIONAL MATCH (t)-[:HAS]->(vd:Verdict)
    OPTIONAL MATCH (t)-[h:HANDED_OFF]->(me)
    RETURN t.id AS taskId, t.status AS status, t.due AS due, t.tier AS tier, f.path AS path, me.name AS assigneeName,
           r.id AS ruleId, r.title AS title, ov.figure AS oldFigure, nv.figure AS newFigure, nv.unit AS unit,
           vd.verdict AS verdict, vd.reason AS verdictReason, h.note AS handoffNote, h.from_name AS handoffFrom
    ORDER BY due`,

  /**
   * Q17b. Hand a task to someone else, with a note, in one query: the ASSIGNED edge moves, the
   * handoff is kept as an edge carrying the note (not a pasted summary), and any live claim on
   * the task ends. The new owner's next session opens with the note.
   */
  handOff: `
    MATCH (t:ReviewTask {id: $taskId})-[a:ASSIGNED]->(prev:Member)
    WHERE t.status IN ['open', 'proposed_clear']
    MATCH (to:Member {id: $to})
    OPTIONAL MATCH (c:Claim)-[:ON]->(t)
    WHERE c.expires_at > $at
    WITH t, a, prev, to, collect(c) AS claims
    FOREACH (x IN claims | SET x.expires_at = $at)
    DELETE a
    CREATE (t)-[:ASSIGNED]->(to)
    CREATE (t)-[:HANDED_OFF {note: $note, at: $at, from: prev.id, from_name: prev.name, by: $by}]->(to)
    RETURN prev.name AS fromName, to.name AS toName`,

  /** Who is on the team, for handing a task to. */
  listMembers: `
    MATCH (m:Member)
    RETURN m.id AS id, m.name AS name, m.role AS role
    ORDER BY name`,

  /** Who a task is assigned to now. */
  taskAssignee: `
    MATCH (:ReviewTask {id: $taskId})-[:ASSIGNED]->(m:Member)
    RETURN m.id AS id`,

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

  /**
   * Q10. A rule changes, in one query (STRICT 5.6). The new version links to the current one
   * by PARENT and SUPERSEDES {reason}, and a Propagation is queued from old to new. A final
   * moves CURRENT and records who approved it; a draft leaves CURRENT where it is, so the
   * propagation is a dry run.
   */
  supersede: `
    MATCH (r:Rule {id: $ruleId})-[cur:CURRENT]->(old:RuleVersion)
    MATCH (sibling:RuleVersion {rule_id: $ruleId})
    WITH r, cur, old, max(sibling.n) AS top
    CREATE (v:RuleVersion {id: $ruleId + '@' + toString(top + 1), rule_id: $ruleId, n: top + 1,
                           text: $text, hash: $hash, at: $at, author: $author, citation: $citation,
                           effective_from: $effectiveFrom, status: $status})
    SET v += $figure
    CREATE (v)-[:OF]->(r)
    CREATE (v)-[:PARENT]->(old)
    CREATE (v)-[:SUPERSEDES {reason: $reason}]->(old)
    CREATE (p:Propagation {id: $propagationId, rule_id: $ruleId, at: $at, dry_run: $dryRun, status: 'queued'})
    CREATE (p)-[:FROM]->(old)
    CREATE (p)-[:TO]->(v)
    WITH r, cur, old, v, p
    MATCH (author:Member {id: $author})
    FOREACH (x IN CASE WHEN $dryRun THEN [] ELSE [cur] END | DELETE x)
    FOREACH (x IN CASE WHEN $dryRun THEN [] ELSE [1] END |
      CREATE (r)-[:CURRENT]->(v)
      CREATE (v)-[:APPROVED_BY {at: $at}]->(author))
    RETURN v.id AS versionId, old.id AS fromId, p.id AS propagationId`,

  /** A propagation and its two versions. */
  propagation: `
    MATCH (p:Propagation {id: $id})-[:FROM]->(old:RuleVersion)
    MATCH (p)-[:TO]->(nv:RuleVersion)
    MATCH (r:Rule {id: p.rule_id})-[:APPLIES_IN]->(j:Jurisdiction)
    RETURN p.id AS id, p.status AS status, p.dry_run AS dryRun, p.at AS at, r.id AS ruleId, r.title AS title,
           j.code AS jurisdiction, old.id AS fromId, old.figure AS oldFigure, nv.id AS toId, nv.figure AS newFigure,
           nv.unit AS unit, nv.status AS newStatus, nv.effective_from AS effectiveFrom, nv.text AS newText,
           old.text AS oldText, nv.citation AS citation,
           p.files_total AS filesTotal, p.needs_review AS needsReview, p.cleared AS cleared,
           p.asked AS asked, p.shown AS shown, p.in_scope AS inScope, p.session AS session, p.derived AS derived, p.unknown AS unknown`,

  /** Propagations not yet done: re-queued at start-up. */
  unfinishedPropagations: `
    MATCH (p:Propagation)
    WHERE p.status IN ['queued', 'running']
    RETURN p.id AS id
    ORDER BY p.at`,

  setPropagationStatus: `
    MATCH (p:Propagation {id: $id})
    SET p.status = $status
    RETURN p.id AS id`,

  /**
   * Q12. The core query. From the old version, back along RELIED_ON to every Change, and to its
   * File. A file drops out if a later change relied on the new version at tier `asked` (it was
   * fixed by someone who looked the new figure up), or if it already has a resolved task for the
   * new version. For each file that stays: the strongest tier it was linked at, and the member
   * behind its latest change, who receives the task.
   */
  affectedFiles: `
    MATCH (:RuleVersion {id: $fromId})<-[rel:RELIED_ON]-(:Change)-[:TO]->(f:File)
    WITH f, collect(rel.tier) AS tiers
    OPTIONAL MATCH (f)<-[:TO]-(:Change)-[:RELIED_ON {tier: 'asked'}]->(fixed:RuleVersion {id: $toId})
    WITH f, tiers, count(fixed) AS fixedByLookup
    WHERE fixedByLookup = 0
    OPTIONAL MATCH (t:ReviewTask {status: 'resolved'})-[:FOR]->(f), (t)-[:BECAUSE]->(:Propagation)-[:TO]->(:RuleVersion {id: $toId})
    WITH f, tiers, count(t) AS resolved
    WHERE resolved = 0
    MATCH (f)<-[:TO]-(lc:Change)-[:IN]->(:Session)-[:BY]->(m:Member)
    WITH f, tiers, lc, m
    ORDER BY lc.at DESC
    WITH f, tiers, collect(m.id)[0] AS ownerId, collect(m.name)[0] AS ownerName
    RETURN f.path AS path, ownerId, ownerName,
           CASE WHEN 'asked' IN tiers THEN 'asked' WHEN 'shown' IN tiers THEN 'shown'
                WHEN 'in_scope' IN tiers THEN 'in_scope' ELSE 'session' END AS tier
    ORDER BY path`,

  /**
   * Q12b. Rules built on the changed rule. An internal rule such as "alert at 80% of the cash
   * limit" DERIVES_FROM the regulation, so when the regulation changes, code written under the
   * derived rule is affected too, even though it never relied on the regulation itself. Follows
   * DERIVES_FROM up to four hops, then back along RELIED_ON from each derived rule's current
   * version to the files.
   */
  affectedViaDerived: `
    MATCH (:Rule {id: $ruleId})<-[:DERIVES_FROM*1..4]-(d:Rule)-[:CURRENT]->(dv:RuleVersion)
    MATCH (dv)<-[rel:RELIED_ON]-(:Change)-[:TO]->(f:File)
    WITH f, collect(DISTINCT d.id) AS via, collect(rel.tier) AS tiers
    OPTIONAL MATCH (t:ReviewTask {status: 'resolved'})-[:FOR]->(f), (t)-[:BECAUSE]->(:Propagation)-[:TO]->(:RuleVersion {id: $toId})
    WITH f, via, tiers, count(t) AS resolved
    WHERE resolved = 0
    MATCH (f)<-[:TO]-(lc:Change)-[:IN]->(:Session)-[:BY]->(m:Member)
    WITH f, via, tiers, lc, m
    ORDER BY lc.at DESC
    WITH f, via, tiers, collect(m.id)[0] AS ownerId, collect(m.name)[0] AS ownerName
    RETURN f.path AS path, ownerId, ownerName, via,
           CASE WHEN 'asked' IN tiers THEN 'asked' WHEN 'shown' IN tiers THEN 'shown'
                WHEN 'in_scope' IN tiers THEN 'in_scope' ELSE 'session' END AS tier
    ORDER BY path`,

  /** The rules a derived rule is built on, and how, for the Reviewer's prompt. */
  derivedRules: `
    MATCH chain = (:Rule {id: $ruleId})<-[:DERIVES_FROM*1..4]-(d:Rule)
    WHERE d.id IN $ids
    MATCH (d)-[:CURRENT]->(dv:RuleVersion)
    RETURN d.id AS ruleId, d.title AS title, dv.text AS text, dv.figure AS figure, dv.unit AS unit,
           [x IN relationships(chain) | x.how] AS how`,

  /** Q13. What a propagation found, dry run or final, with who would own each file. */
  writeFindings: `
    MATCH (p:Propagation {id: $id})
    UNWIND $files AS x
    MATCH (f:File {path: x.path})
    MERGE (p)-[e:FOUND]->(f)
    SET e.tier = x.tier, e.owner = x.owner, e.via = x.via
    RETURN count(e) AS found`,

  /** A propagation's findings with each file's task (final) or latest verdict (dry run). */
  findings: `
    MATCH (p:Propagation {id: $id})-[e:FOUND]->(f:File)
    MATCH (p)-[:TO]->(nv:RuleVersion)
    OPTIONAL MATCH (t:ReviewTask)-[:BECAUSE]->(p), (t)-[:FOR]->(f)
    OPTIONAL MATCH (t)-[:HAS]->(tv:Verdict)
    OPTIONAL MATCH (f)-[:LATEST]->(:FileSnapshot)<-[:ON]-(sv:Verdict)-[:AGAINST]->(nv)
    RETURN f.path AS path, e.tier AS tier, e.owner AS owner, e.via AS via, t.id AS taskId, t.status AS taskStatus,
           coalesce(tv.verdict, sv.verdict) AS verdict, coalesce(tv.reason, sv.reason) AS reason,
           coalesce(tv.patch, sv.patch) AS patch
    ORDER BY path`,

  /** Every rule with its current version, market and scope. */
  listRules: `
    MATCH (r:Rule)-[:CURRENT]->(v:RuleVersion)
    MATCH (r)-[:APPLIES_IN]->(j:Jurisdiction)
    OPTIONAL MATCH (r)-[s:SCOPE]->(t)
    WITH r, v, j, collect({path: t.path, source: s.source}) AS scopes
    RETURN r.id AS ruleId, r.title AS title, r.risk AS risk, j.code AS jurisdiction, v.id AS versionId, v.n AS n,
           v.figure AS figure, v.unit AS unit, v.status AS status, v.citation AS citation,
           v.effective_from AS effectiveFrom, v.text AS text, scopes
    ORDER BY jurisdiction, ruleId`,

  /** Recent propagations, newest first. */
  listPropagations: `
    MATCH (p:Propagation)
    RETURN p.id AS id
    ORDER BY p.at DESC
    LIMIT $limit`,

  /** Every review task, with verdict and any live claim. */
  allTasks: `
    MATCH (t:ReviewTask)-[:FOR]->(f:File)
    MATCH (t)-[:ASSIGNED]->(m:Member)
    MATCH (t)-[:BECAUSE]->(p:Propagation)
    OPTIONAL MATCH (t)-[:HAS]->(vd:Verdict)
    OPTIONAL MATCH (c:Claim)-[:ON]->(t)
    WHERE c.expires_at > $now
    OPTIONAL MATCH (c)-[:BY]->(cm:Member)
    RETURN t.id AS taskId, t.status AS status, t.due AS due, t.tier AS tier, f.path AS path, m.name AS assignee,
           p.rule_id AS ruleId, p.id AS propagationId, vd.verdict AS verdict, vd.reason AS verdictReason,
           cm.name AS claimBy, t.resolved_reason AS resolvedReason
    ORDER BY due, path`,

  /** Files Premise knows, with how many recorded changes each has. */
  listFiles: `
    MATCH (f:File)
    OPTIONAL MATCH (f)<-[:TO]-(c:Change)
    RETURN f.path AS path, count(c) AS changes
    ORDER BY path`,

  /** Accept a proposed scope: the edge becomes declared. */
  acceptScope: `
    MATCH (r:Rule {id: $ruleId})-[s:SCOPE {source: 'proposed'}]->(t)
    WHERE t.path = $path
    SET s.source = 'declared'
    RETURN t.path AS path`,

  /** The receipt's numbers, as plain number properties (a map cannot be a property). */
  finishPropagation: `
    MATCH (p:Propagation {id: $id})
    SET p.status = 'done', p.files_total = $filesTotal, p.needs_review = $needsReview, p.cleared = $cleared,
        p.asked = $asked, p.shown = $shown, p.in_scope = $inScope, p.session = $session, p.derived = $derived, p.unknown = $unknown
    RETURN p.id AS id`,

  /**
   * Q14. One review task per file and new version, in one query: created only if no open task
   * already exists for that file and version, so running a propagation twice opens no duplicates.
   */
  openTask: `
    MATCH (p:Propagation {id: $propagationId})-[:TO]->(nv:RuleVersion)
    MATCH (f:File {path: $path})
    MATCH (m:Member {id: $assignee})
    OPTIONAL MATCH (existing:ReviewTask)-[:FOR]->(f), (existing)-[:BECAUSE]->(:Propagation)-[:TO]->(nv)
    WHERE existing.status IN ['open', 'proposed_clear']
    WITH p, f, m, count(existing) AS already
    WHERE already = 0
    CREATE (t:ReviewTask {id: $taskId, status: $status, tier: $tier, due: $due})
    CREATE (t)-[:FOR]->(f)
    CREATE (t)-[:BECAUSE]->(p)
    CREATE (t)-[:ASSIGNED]->(m)
    RETURN t.id AS taskId`,

  /** The file's latest snapshot, for the Reviewer. */
  latestSnapshot: `
    MATCH (:File {path: $path})-[:LATEST]->(s:FileSnapshot)
    RETURN s.hash AS hash, s.content AS content`,

  /** The latest diffs to a file that relied on a version. */
  diffsUnder: `
    MATCH (:RuleVersion {id: $versionId})<-[:RELIED_ON]-(c:Change)-[:TO]->(:File {path: $path})
    RETURN c.diff AS diff, c.at AS at
    ORDER BY at DESC
    LIMIT 5`,

  /** Every other current rule this file's changes relied on (the shared-file case). */
  otherRulesForFile: `
    MATCH (:File {path: $path})<-[:TO]-(:Change)-[:RELIED_ON]->(v:RuleVersion)
    WHERE v.rule_id <> $ruleId
    MATCH (r:Rule {id: v.rule_id})-[:CURRENT]->(cur:RuleVersion)
    MATCH (r)-[:APPLIES_IN]->(j:Jurisdiction)
    RETURN DISTINCT r.id AS ruleId, r.title AS title, j.code AS jurisdiction, cur.text AS text,
           cur.figure AS figure, cur.unit AS unit`,

  /** Q15a. A cached verdict for this content and this rule version. */
  verdictFor: `
    MATCH (v:Verdict {id: $id})
    RETURN v.verdict AS verdict, v.reason AS reason, v.patch AS patch, v.model AS model`,

  /** Q15b. Store a verdict on the snapshot and version it judged. */
  writeVerdict: `
    MATCH (s:FileSnapshot {hash: $hash})
    MATCH (rv:RuleVersion {id: $versionId})
    MERGE (v:Verdict {id: $id})
    ON CREATE SET v.verdict = $verdict, v.reason = $reason, v.model = $model, v.prompt_version = $promptVersion, v.at = $at
    SET v += $patch
    MERGE (v)-[:ON]->(s)
    MERGE (v)-[:AGAINST]->(rv)
    RETURN v.id AS id`,

  /** Link a task to its verdict. */
  attachVerdict: `
    MATCH (t:ReviewTask {id: $taskId})
    MATCH (v:Verdict {id: $verdictId})
    MERGE (t)-[:HAS]->(v)
    RETURN t.id AS id`,

  /**
   * Q16. Claim a task, in one query: succeeds only if the task is still open and nobody holds
   * a live claim. FalkorDB runs one graph's writes one at a time, so two claims cannot both win.
   */
  claimTask: `
    MATCH (t:ReviewTask {id: $taskId})
    WHERE t.status IN ['open', 'proposed_clear']
    MATCH (m:Member {id: $member})
    OPTIONAL MATCH (live:Claim)-[:ON]->(t)
    WHERE live.expires_at > $now
    WITH t, m, count(live) AS held
    WHERE held = 0
    CREATE (c:Claim {id: $claimId, expires_at: $expires})
    CREATE (c)-[:ON]->(t)
    CREATE (c)-[:BY]->(m)
    RETURN c.id AS claimId`,

  /** Who holds a live claim on a task. */
  claimHolder: `
    MATCH (c:Claim)-[:ON]->(:ReviewTask {id: $taskId})
    WHERE c.expires_at > $now
    MATCH (c)-[:BY]->(m:Member)
    RETURN m.name AS name, c.expires_at AS expires`,

  /** Q17. Resolve a task, with a reason. */
  resolveTask: `
    MATCH (t:ReviewTask {id: $taskId})
    WHERE t.status IN ['open', 'proposed_clear']
    SET t.status = 'resolved', t.resolved_reason = $reason, t.resolved_at = $at, t.resolved_by = $member
    RETURN t.id AS taskId`,

  /** Q19a. The chain behind a file's latest changes: change, session, member, versions, rules. */
  whyChanges: `
    MATCH (:File {path: $path})<-[:TO]-(c:Change)-[:IN]->(s:Session)-[:BY]->(m:Member)
    WITH c, s, m
    ORDER BY c.at DESC
    LIMIT 6
    OPTIONAL MATCH (c)-[rel:RELIED_ON]->(v:RuleVersion)
    OPTIONAL MATCH (r:Rule {id: v.rule_id})-[:APPLIES_IN]->(j:Jurisdiction)
    OPTIONAL MATCH (newer:RuleVersion)-[:SUPERSEDES]->(v)
    RETURN c.id AS changeId, c.at AS at, c.diff AS diff, s.id AS sessionId, s.tool AS tool,
           m.id AS memberId, m.name AS member, rel.tier AS tier,
           v.id AS versionId, v.n AS n, v.figure AS figure, v.unit AS unit, v.status AS status, v.citation AS citation,
           r.id AS ruleId, r.title AS title, j.code AS jurisdiction,
           collect(DISTINCT newer.id) AS supersededBy
    ORDER BY at DESC`,

  /** Q19b. Tasks and verdicts on a file. */
  whyTasks: `
    MATCH (:File {path: $path})<-[:FOR]-(t:ReviewTask)-[:BECAUSE]->(p:Propagation)-[:TO]->(nv:RuleVersion)
    MATCH (t)-[:ASSIGNED]->(m:Member)
    OPTIONAL MATCH (t)-[:HAS]->(vd:Verdict)
    RETURN t.id AS taskId, t.status AS status, t.due AS due, t.tier AS tier, m.name AS assignee, m.id AS assigneeId,
           nv.id AS versionId, p.id AS propagationId, vd.id AS verdictId, vd.verdict AS verdict, vd.reason AS verdictReason`,

  /**
   * A1. The shortest connection from a file to each market's regulator, by FalkorDB's
   * algo.SPpaths over the edges that carry meaning (an edit, what it relied on, which rule, what
   * it is built on, where it applies). Folder membership is left out: a file sitting in a folder
   * that serves India is not a reason.
   */
  shortestToRegulators: `
    MATCH (f:File {path: $path})
    MATCH (j:Jurisdiction)
    CALL algo.SPpaths({sourceNode: f, targetNode: j, relTypes: ['TO', 'RELIED_ON', 'OF', 'DERIVES_FROM', 'APPLIES_IN'],
                       relDirection: 'both', maxLen: 8})
    YIELD path, pathWeight
    RETURN j.code AS jurisdiction, j.regulator AS regulator, pathWeight AS hops,
           [n IN nodes(path) | CASE labels(n)[0]
              WHEN 'File' THEN 'file:' + n.path
              WHEN 'Change' THEN 'change:' + n.id
              WHEN 'RuleVersion' THEN 'version:' + n.id
              WHEN 'Rule' THEN 'rule:' + n.id
              WHEN 'Jurisdiction' THEN 'jurisdiction:' + n.code
              ELSE labels(n)[0] END] AS ids,
           [n IN nodes(path) | labels(n)[0]] AS kinds,
           [n IN nodes(path) | CASE labels(n)[0] WHEN 'Change' THEN 'an edit' WHEN 'RuleVersion' THEN n.id
              ELSE coalesce(n.path, n.title, n.code) END] AS labels,
           [e IN relationships(path) | type(e)] AS rels
    ORDER BY hops`,

  /**
   * A2. Foundational rules: algo.pageRank over DERIVES_FROM. A rule that other rules are built on
   * ranks higher; changing it moves more than its own figure.
   */
  rulePageRank: `
    CALL algo.pageRank('Rule', 'DERIVES_FROM')
    YIELD node, score
    RETURN node.id AS ruleId, score
    ORDER BY score DESC`,

  /** A3. Blast radius: files ever written under each rule, directly and through derived rules. */
  blastRadius: `
    MATCH (r:Rule)-[:APPLIES_IN]->(j:Jurisdiction)
    MATCH (r)-[:CURRENT]->(v:RuleVersion)
    OPTIONAL MATCH (r)<-[:OF]-(:RuleVersion)<-[:RELIED_ON]-(:Change)-[:TO]->(f:File)
    WITH r, j, v, count(DISTINCT f) AS direct
    OPTIONAL MATCH (r)<-[:DERIVES_FROM*1..4]-(:Rule)<-[:OF]-(:RuleVersion)<-[:RELIED_ON]-(:Change)-[:TO]->(g:File)
    OPTIONAL MATCH (r)<-[:DERIVES_FROM*1..4]-(d:Rule)
    RETURN r.id AS ruleId, r.title AS title, r.risk AS risk, j.code AS jurisdiction, v.figure AS figure, v.unit AS unit,
           direct, count(DISTINCT g) AS viaDerived, collect(DISTINCT d.id) AS derived`,

  /**
   * A4. Coupled rules: FalkorDB's algo.WCC over the code-to-rule graph. Rules land in one
   * component when shared code ties them together, so a change to one can touch files written
   * under another. (Betweenness was tried first: on this engine it follows edge direction only,
   * so a file, which only receives edges, always scores 0.)
   */
  ruleClusters: `
    CALL algo.WCC({nodeLabels: ['File', 'Change', 'RuleVersion', 'Rule'],
                   relationshipTypes: ['TO', 'RELIED_ON', 'OF', 'DERIVES_FROM']})
    YIELD node, componentId
    WITH componentId, collect(CASE WHEN labels(node)[0] = 'Rule' THEN node.id END) AS rules,
         collect(CASE WHEN labels(node)[0] = 'File' THEN node.path END) AS files
    WHERE size(rules) > 0
    RETURN componentId, rules, size(files) AS files
    ORDER BY size(rules) DESC`,

  /** A5. The files that couple rules: written under more than one rule. */
  couplingFiles: `
    MATCH (f:File)<-[:TO]-(:Change)-[:RELIED_ON]->(:RuleVersion)-[:OF]->(r:Rule)
    WITH f, collect(DISTINCT r.id) AS rules
    WHERE size(rules) > 1
    RETURN f.path AS path, rules
    ORDER BY size(rules) DESC, path`,

  /**
   * Q20a. Audit evidence for one rule: every version, with its citation, author, approver and the
   * reason it superseded the one before, and every change made under it: file, member, session,
   * tool, model and tier. What an auditor asks of AI-written code: what policy governed it,
   * who and what wrote it, and how strongly it was tied to the policy at the moment of the edit.
   */
  auditVersions: `
    MATCH (r:Rule {id: $ruleId})<-[:OF]-(v:RuleVersion)
    MATCH (r)-[:APPLIES_IN]->(j:Jurisdiction)
    OPTIONAL MATCH (v)-[ap:APPROVED_BY]->(am:Member)
    OPTIONAL MATCH (v)-[sup:SUPERSEDES]->(old:RuleVersion)
    OPTIONAL MATCH (v)<-[rel:RELIED_ON]-(c:Change)-[:TO]->(f:File)
    OPTIONAL MATCH (c)-[:IN]->(s:Session)-[:BY]->(m:Member)
    WITH r, j, v, am, ap, sup, old,
         collect(CASE WHEN c IS NULL THEN NULL ELSE {change: c.id, at: c.at, path: f.path, tier: rel.tier, member: m.name,
                 session: s.id, tool: s.tool, model: s.model} END) AS changes
    RETURN r.id AS ruleId, r.title AS title, j.code AS jurisdiction, j.regulator AS regulator,
           v.id AS versionId, v.n AS n, v.status AS status, v.figure AS figure, v.unit AS unit, v.text AS text,
           v.citation AS citation, v.effective_from AS effectiveFrom, v.at AS at, v.author AS author,
           am.name AS approvedBy, ap.at AS approvedAt, sup.reason AS reason, old.id AS supersedes, changes
    ORDER BY n`,

  /** Q20b. Every propagation of a rule, with its review tasks, verdicts and resolutions. */
  auditPropagations: `
    MATCH (p:Propagation {rule_id: $ruleId})-[:TO]->(nv:RuleVersion)
    MATCH (p)-[:FROM]->(ov:RuleVersion)
    OPTIONAL MATCH (t:ReviewTask)-[:BECAUSE]->(p)
    OPTIONAL MATCH (t)-[:FOR]->(f:File)
    OPTIONAL MATCH (t)-[:ASSIGNED]->(m:Member)
    OPTIONAL MATCH (t)-[:HAS]->(vd:Verdict)
    WITH p, nv, ov, collect(CASE WHEN t IS NULL THEN NULL ELSE {task: t.id, path: f.path, status: t.status, due: t.due,
                 tier: t.tier, assignee: m.name, verdict: vd.verdict, verdictReason: vd.reason, model: vd.model,
                 promptVersion: vd.prompt_version, resolvedReason: t.resolved_reason, resolvedBy: t.resolved_by,
                 resolvedAt: t.resolved_at} END) AS tasks
    RETURN p.id AS propagationId, p.at AS at, p.dry_run AS dryRun, ov.id AS fromId, nv.id AS toId,
           p.files_total AS filesTotal, tasks
    ORDER BY at`,

  /** Q9a. When Premise last recorded a change to each of these paths. */
  lastChangeAt: `
    MATCH (f:File)<-[:TO]-(c:Change)
    WHERE f.path IN $paths
    RETURN f.path AS path, max(c.at) AS at`,
} as const;
