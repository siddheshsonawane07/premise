// Imports a repository's .claude/rules/*.md into a team as versioned rules (jurisdiction TEAM),
// with each file's `paths:` front matter as its scope. Run it again after a rules file changes:
// a new version is recorded and propagated, so code written under the old convention is found.
//
//   npx tsx scripts/import-rules.ts <repo-dir> [member-id, default <team>.chitra]

import { loadConfig } from '../src/config.ts';
import type { Principal } from '../src/auth.ts';
import { runPropagation } from '../src/core/change.ts';
import { importRules } from '../src/core/import.ts';
import { Db, one } from '../src/db/client.ts';
import { CONTROL } from '../src/db/queries.ts';
import { makeReviewer } from '../src/review/reviewer.ts';

const [repo, memberArg] = process.argv.slice(2);
if (!repo) { console.error('usage: import-rules.ts <repo-dir> [member-id]'); process.exit(1); }
const config = loadConfig();
const db = await Db.connectWithRetry(config.FALKORDB_URL, config.FALKORDB_PASSWORD);
const who = await one<Principal>(db.control(), CONTROL.principalById, { id: memberArg ?? `${config.DEMO_TEAM_ID}.chitra` }, { readOnly: true });
if (!who) { console.error('No such member'); process.exit(1); }
for (const r of await importRules(db, who, repo)) {
  console.log(`${r.action.padEnd(12)} ${r.ruleId}  (${r.file})`);
  if (r.propagationId) await runPropagation(db, who.teamId, r.propagationId, makeReviewer(config.ANTHROPIC_API_KEY, config.REVIEW_DAILY_CAP_USD));
}
await db.close();
