import fs from 'node:fs';
import path from 'node:path';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import express, { type NextFunction, type Request, type Response } from 'express';
import { authenticate, bearer, type Principal } from './auth.ts';
import type { Config } from './config.ts';
import { onRead, postEdit, preEdit, READ_TOOLS, EDIT_TOOLS, sessionStart, stopSweep, type ToolEvent } from './core/activity.ts';
import { type Db, DbUnreachable } from './db/client.ts';
import { buildMcpServer } from './mcp/tools.ts';
import { PathOutsideRepo } from './paths.ts';
import type { PropagationQueue } from './propagate/queue.ts';
import { webRoutes } from './web/routes.ts';

// One Express app: hook endpoints, the MCP endpoint, health. Every hook reply is 200 with a
// JSON body, because Claude Code ignores status codes on HTTP hooks; a block must be a `deny`.

type Authed = Request & { who?: Principal };

const UNREACHABLE =
  "Premise's memory (FalkorDB) is unreachable, so edits to files are blocked until it is back. Tell the user.";

export function createApp(db: Db, config: Config, queue: PropagationQueue) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));

  app.get('/healthz', async (_req, res) => {
    try {
      await db.listGraphs();
      res.json({ db: 'ok' });
    } catch {
      res.status(503).json({ db: 'unreachable' });
    }
  });

  const auth = async (req: Authed, res: Response, next: NextFunction) => {
    try {
      const who = await authenticate(db, bearer(req.header('authorization')));
      if (!who) return res.status(401).json({ error: 'invalid key' });
      req.who = who;
      capture(config, req, who);
      next();
    } catch (err) {
      if (err instanceof DbUnreachable) return unreachable(req, res);
      next(err);
    }
  };

  // ── Hooks ──────────────────────────────────────────────────────────────

  app.post('/hooks/session-start', auth, wrap(async (req, res) => {
    const b = req.body as { session_id: string; tool?: string; branch?: string; model?: string };
    const context = await sessionStart(db, req.who!, b);
    res.json({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
  }));

  app.post('/hooks/read', auth, wrap(async (req, res) => {
    const ev = req.body as ToolEvent;
    if (!READ_TOOLS.has(ev.tool_name)) return res.json({});
    const context = await onRead(db, req.who!, ev);
    res.json(context ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } } : {});
  }));

  app.post('/hooks/pre-edit', auth, wrap(async (req, res) => {
    const ev = req.body as ToolEvent;
    if (!EDIT_TOOLS.has(ev.tool_name)) return res.json({});
    const d = await preEdit(db, req.who!, ev);
    res.json({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: d.decision,
        ...(d.decision === 'allow' ? (d.context ? { additionalContext: d.context } : {}) : { permissionDecisionReason: d.reason }),
      },
    });
  }));

  app.post('/hooks/post-edit', auth, wrap(async (req, res) => {
    const ev = req.body as ToolEvent;
    if (!EDIT_TOOLS.has(ev.tool_name)) return res.json({});
    await postEdit(db, req.who!, ev);
    res.json({});
  }));

  app.post('/hooks/stop', auth, wrap(async (req, res) => {
    const b = req.body as { session_id: string; cwd: string; files: { path: string; mtimeMs: number; content?: string }[] };
    await stopSweep(db, req.who!, { session_id: b.session_id, cwd: b.cwd, files: Array.isArray(b.files) ? b.files : [] });
    res.json({});
  }));

  // ── MCP (stateless: a fresh server per request, the caller's key closed over) ──

  app.post('/mcp', auth, wrap(async (req, res) => {
    const server = buildMcpServer(db, req.who!, queue);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }));
  app.get('/mcp', (_req, res) => res.status(405).json({ error: 'stateless server: POST only' }));

  app.use(webRoutes(db, queue, config.PREMISE_WEB_MEMBER));

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof DbUnreachable) return unreachable(req, res);
    if (err instanceof PathOutsideRepo) return res.json({});
    console.error(`[${req.method} ${req.path}]`, err);
    if (req.path === '/hooks/pre-edit') {
      return res.json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: 'Premise could not check this edit (internal error). Tell the user.' } });
    }
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

/** FalkorDB down: edits are denied in plain words (STRICT 4.5); reads say why. */
function unreachable(req: Request, res: Response) {
  if (req.path === '/hooks/pre-edit') {
    return res.json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: UNREACHABLE } });
  }
  if (req.path === '/hooks/read' || req.path === '/hooks/session-start') {
    const event = req.path === '/hooks/read' ? 'PostToolUse' : 'SessionStart';
    return res.json({ hookSpecificOutput: { hookEventName: event, additionalContext: UNREACHABLE } });
  }
  res.status(503).json({ error: UNREACHABLE });
}

function wrap(fn: (req: Authed, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => { fn(req as Authed, res).catch(next); };
}

/** While CAPTURE_DIR is set, every authenticated request body is appended for the replay seed. */
function capture(config: Config, req: Request, who: Principal) {
  if (!config.CAPTURE_DIR || !req.path.startsWith('/hooks/') && req.path !== '/mcp') return;
  fs.mkdirSync(config.CAPTURE_DIR, { recursive: true });
  const file = path.join(config.CAPTURE_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  fs.appendFileSync(file, `${JSON.stringify({ at: Date.now(), route: req.path, member: who.memberId, body: req.body })}\n`);
}
