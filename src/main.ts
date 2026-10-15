import { loadConfig } from './config.ts';
import { Db, run } from './db/client.ts';
import { CONTROL } from './db/queries.ts';
import { ensureControlSchema, ensureTeamSchema } from './db/schema.ts';
import { createApp } from './server.ts';

// Start-up: connect, create or verify every index and constraint on every graph, and refuse
// to start if one is missing (STRICT 5.8). Then serve.

async function main() {
  const config = loadConfig();
  const db = await Db.connect(config.FALKORDB_URL, config.FALKORDB_PASSWORD);
  await ensureControlSchema(db.control());
  const teams = await run<{ id: string }>(db.control(), CONTROL.listTeams, {}, { readOnly: true });
  for (const t of teams) await ensureTeamSchema(db.team(t.id));
  console.log(`premise: FalkorDB ok, ${teams.length} team graph(s) verified`);

  const app = createApp(db, config);
  const server = app.listen(config.PORT, () => console.log(`premise: listening on ${config.PORT}`));
  const stop = () => server.close(() => void db.close().finally(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error('premise: refusing to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
