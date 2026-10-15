import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { postEdit } from '../src/core/activity.ts';
import { runPropagation, supersede } from '../src/core/change.ts';
import { lookupRule, recordRule } from '../src/core/rules.ts';
import { type Db, run } from '../src/db/client.ts';
import { PropagationQueue } from '../src/propagate/queue.ts';
import { createApp } from '../src/server.ts';
import { dropTeam, testDb } from './helpers/db.ts';
import { makeWorld, ROOT, type World, writeEv } from './helpers/world.ts';

// Separate memory per tenant (Track 2, STRICT 5.7), through the real HTTP surface: with team A's
// key, every hook and MCP tool is tried against team B's rules, files and tasks. Nothing of B's
// may come back, and nothing of B's may change.

let db: Db;
let a: World;
let b: World;
let server: Server;
let base = '';
let bTask = '';

async function mcp(key: string, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.text();
  const data = body.split('\n').find((l) => l.startsWith('data: '));
  return JSON.stringify(data ? JSON.parse(data.slice(6)) : body);
}

async function hook(key: string, route: string, body: unknown): Promise<string> {
  const res = await fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body),
  });
  return res.text();
}

beforeAll(async () => {
  db = await testDb();
  a = await makeWorld(db);
  b = await makeWorld(db);
  // B alone has a secret rule, a file written under it, and a task.
  await recordRule(db, b.chitra, {
    id: 'b-secret', title: 'Zanzibar settlement window', type: 'decision', owner: b.chitra.memberId, risk: 'low',
    jurisdiction: 'IN', text: 'Settle Zanzibar batches within 42 minutes.', citation: 'Team B decision', effectiveFrom: '2026-01-01',
    status: 'final', scope: ['src/zanzibar'],
  });
  await lookupRule(db, b.ben, { rule: 'b-secret', path: 'src/zanzibar/settle.ts' });
  await postEdit(db, b.ben, writeEv('b-1', 'src/zanzibar/settle.ts', 'const WINDOW = 42;'));
  const s = await supersede(db, b.chitra, { ruleId: 'b-secret', text: 'Within 30 minutes.', citation: 'Team B', effectiveFrom: '2026-12-01', reason: 'faster', draft: false });
  await runPropagation(db, b.teamId, s.propagationId);
  const [t] = await run<{ id: string }>(db.team(b.teamId), 'MATCH (t:ReviewTask) RETURN t.id AS id');
  bTask = t!.id;

  const app = createApp(db, loadConfig({ PREMISE_WEB_MEMBER: undefined } as NodeJS.ProcessEnv), new PropagationQueue(db));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server?.close();
  await dropTeam(db, a.teamId);
  await dropTeam(db, b.teamId);
  await db.close();
});

describe('team A cannot reach team B (plan §15.1)', () => {
  it('rule_lookup does not find B\'s rule, by id or by words', async () => {
    for (const rule of ['b-secret', 'Zanzibar settlement']) {
      const out = await mcp(a.keys.ben, 'rule_lookup', { rule, path: 'src/zanzibar/settle.ts' });
      expect(out).toContain('No recorded rule matches');
      expect(out).not.toContain('42');
    }
  });

  it('why shows none of B\'s history for the same path', async () => {
    const out = await mcp(a.keys.ben, 'why', { path: 'src/zanzibar/settle.ts' });
    expect(out).toContain('No recorded changes');
    expect(out).not.toMatch(/Zanzibar|b-secret/);
  });

  it('my_tasks, claim_task and resolve_task cannot see or touch B\'s task', async () => {
    expect(await mcp(a.keys.ben, 'my_tasks', {})).toContain('No open review tasks');
    expect(await mcp(a.keys.ben, 'claim_task', { task_id: bTask })).toContain('Not claimed');
    expect(await mcp(a.keys.chitra, 'resolve_task', { task_id: bTask, reason: 'trying to close another team\'s task' })).toContain('is not open');
    const [t] = await run<{ status: string }>(db.team(b.teamId), 'MATCH (t:ReviewTask {id: $id}) RETURN t.status AS status', { id: bTask });
    expect(t?.status).toBe('open');
  });

  it('the Read hook shows A nothing of B\'s rules on the same path', async () => {
    const out = await hook(a.keys.ben, '/hooks/read', {
      session_id: 'a-1', cwd: ROOT, tool_name: 'Read', tool_input: { file_path: `${ROOT}/src/zanzibar/settle.ts` },
    });
    expect(out).toBe('{}');
  });

  it('an edit by A to the same path is recorded in A\'s graph only', async () => {
    await hook(a.keys.ben, '/hooks/post-edit', {
      session_id: 'a-2', cwd: ROOT, tool_name: 'Edit', tool_use_id: 'a-edit-1',
      tool_input: { file_path: `${ROOT}/src/zanzibar/settle.ts`, old_string: '42', new_string: '41' },
    });
    const inA = await run<{ n: number }>(db.team(a.teamId), "MATCH (c:Change {id: 'a-edit-1'}) RETURN count(c) AS n");
    const inB = await run<{ n: number }>(db.team(b.teamId), "MATCH (c:Change {id: 'a-edit-1'}) RETURN count(c) AS n");
    expect(inA[0]?.n).toBe(1);
    expect(inB[0]?.n).toBe(0);
  });

  it('a wrong key gets nothing at all', async () => {
    const res = await fetch(`${base}/hooks/read`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer pk_forged' }, body: '{}' });
    expect(res.status).toBe(401);
  });
});
