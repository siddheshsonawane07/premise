import { loadConfig } from './config.ts';
import { Db, run } from './db/client.ts';
import { CONTROL } from './db/queries.ts';
import { ensureControlSchema, ensureTeamSchema } from './db/schema.ts';
import { PropagationQueue } from './propagate/queue.ts';
import { makeReviewer } from './review/reviewer.ts';
import { seedDemo, teamExists } from './replay/seed.ts';
import { createApp } from './server.ts';

// Start-up: connect, create or verify every index and constraint on every graph, and refuse
// to start if one is missing (STRICT 5.8). Then serve.

const DEMO_EVENTS = 'demo/events/tilldesk.jsonl';

async function main() {
  const config = loadConfig();
  const db = await Db.connectWithRetry(config.FALKORDB_URL, config.FALKORDB_PASSWORD);
  await ensureControlSchema(db.control());
  if (config.DEMO_SEED === 'on' && !(await teamExists(db, config.DEMO_TEAM_ID))) {
    await seedDemo(db, config.DEMO_TEAM_ID, DEMO_EVENTS);
    console.log(`premise: demo team ${config.DEMO_TEAM_ID} was missing; rebuilt from ${DEMO_EVENTS}`);
  }
  const teams = await run<{ id: string }>(db.control(), CONTROL.listTeams, {}, { readOnly: true });
  for (const t of teams) await ensureTeamSchema(db.team(t.id));
  console.log(`premise: FalkorDB ok, ${teams.length} team graph(s) verified`);

  const queue = new PropagationQueue(db, makeReviewer(config.ANTHROPIC_API_KEY, config.REVIEW_DAILY_CAP_USD));
  await queue.resume(teams.map((t) => t.id));
  if (!config.ANTHROPIC_API_KEY) console.log('premise: no ANTHROPIC_API_KEY, so every Reviewer verdict is "unknown"');

  const app = createApp(db, config, queue);
  const server = app.listen(config.PORT, () => console.log(`premise: listening on ${config.PORT}`));
  if (config.DEMO_SEED === 'on' && config.DEMO_RESET_MINUTES) {
    setInterval(() => {
      seedDemo(db, config.DEMO_TEAM_ID, DEMO_EVENTS)
        .then(() => console.log('premise: demo team reset'))
        .catch((err) => console.error('premise: demo reset failed:', err instanceof Error ? err.message : err));
    }, config.DEMO_RESET_MINUTES * 60_000).unref();
  }

  const stop = () => server.close(() => void db.close().finally(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error('premise: refusing to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
