import { FalkorDB, type Graph } from 'falkordb';

// One connection to FalkorDB, one graph per team (`t_<teamId>`), plus `_control`.
// Every query goes through `run`, which adds the parameters, a timeout, and turns
// "can't reach the database" into one error type the hooks can answer loudly (STRICT 4.5).

export class DbUnreachable extends Error {
  constructor(cause?: unknown) {
    super("Premise's memory (FalkorDB) is unreachable");
    this.cause = cause;
  }
}

export type Params = Record<string, unknown>;

const CONTROL_GRAPH = '_control';
const TEAM_ID = /^[a-z][a-z0-9_]{1,30}$/;

// How long to wait for FalkorDB before declaring it unreachable. The server-side
// TIMEOUT_DEFAULT (2 s) bounds query execution; this bounds the network wait.
const CLIENT_WAIT_MS = 2500;
// While the connection is known to be down, give up fast so an edit hook can deny well
// inside its 5-second timeout. Cleared by the next successful reply.
const DOWN_WAIT_MS = 600;
let downSince: number | undefined;

export function teamGraphName(teamId: string): string {
  if (!TEAM_ID.test(teamId)) throw new Error(`Invalid team id: ${teamId}`);
  return `t_${teamId}`;
}

export class Db {
  private constructor(private readonly client: FalkorDB) {}

  static async connect(url: string, password?: string): Promise<Db> {
    const client = await withDeadline(
      FalkorDB.connect({ url, password, socket: { connectTimeout: CLIENT_WAIT_MS } }),
      CLIENT_WAIT_MS,
    );
    // Without a listener, a dropped socket's 'error' event would end the process. The client
    // reconnects by itself; until it does, queries fail fast with DbUnreachable.
    let lastLog = 0;
    client.on('error', (err: unknown) => {
      downSince ??= Date.now();
      if (Date.now() - lastLog > 10_000) {
        lastLog = Date.now();
        console.error('premise: FalkorDB connection error:', err instanceof Error ? err.message : err);
      }
    });
    return new Db(client);
  }

  /** Connect, retrying while FalkorDB is still starting (a fresh container, or a host that starts the app first). */
  static async connectWithRetry(url: string, password?: string, attempts = 15): Promise<Db> {
    for (let i = 1; ; i++) {
      try {
        return await Db.connect(url, password);
      } catch (err) {
        if (!(err instanceof DbUnreachable) || i >= attempts) throw err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  control(): Graph {
    return this.client.selectGraph(CONTROL_GRAPH);
  }

  team(teamId: string): Graph {
    return this.client.selectGraph(teamGraphName(teamId));
  }

  async listGraphs(): Promise<string[]> {
    const list = await withDeadline(this.client.list(), downSince ? DOWN_WAIT_MS : CLIENT_WAIT_MS);
    downSince = undefined;
    return list;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

/** Run one query. Values only ever travel as parameters (STRICT 5.5). */
export async function run<T = Record<string, unknown>>(
  graph: Graph,
  cypher: string,
  params: Params = {},
  opts: { readOnly?: boolean; timeoutMs?: number } = {},
): Promise<T[]> {
  const options = { params: params as never, TIMEOUT: opts.timeoutMs ?? 2000 };
  const call = opts.readOnly ? graph.roQuery<T>(cypher, options) : graph.query<T>(cypher, options);
  const wait = downSince ? DOWN_WAIT_MS : (opts.timeoutMs ?? 2000) + CLIENT_WAIT_MS;
  const reply = await withDeadline(call, wait);
  downSince = undefined;
  return reply.data ?? [];
}

/** First row or undefined. */
export async function one<T = Record<string, unknown>>(
  graph: Graph,
  cypher: string,
  params: Params = {},
  opts: { readOnly?: boolean; timeoutMs?: number } = {},
): Promise<T | undefined> {
  const rows = await run<T>(graph, cypher, params, opts);
  return rows[0];
}

async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DbUnreachable(new Error(`no reply in ${ms} ms`))), ms);
  });
  try {
    return await Promise.race([p, deadline]);
  } catch (err) {
    if (err instanceof DbUnreachable) throw err;
    if (isConnectionError(err)) throw new DbUnreachable(err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isConnectionError(err: unknown): boolean {
  // A refused connection to localhost arrives as an AggregateError (IPv4 and IPv6 both refused).
  if (err instanceof AggregateError) return err.errors.some(isConnectionError);
  const code = (err as { code?: string } | null)?.code ?? '';
  if (/^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|EPIPE)$/.test(code)) return true;
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|Socket closed|ClientClosed|connection is closed/i.test(msg);
}
