import fs from 'node:fs';
import type { Principal } from '../auth.ts';
import { onRead, postEdit, preEdit, sessionStart, stopSweep, type ToolEvent } from '../core/activity.ts';
import { lookupRule, type NewRule, recordRule } from '../core/rules.ts';
import { type Db, one } from '../db/client.ts';
import { CONTROL } from '../db/queries.ts';
import { normalisePath } from '../mcp/tools.ts';
import type { CapturedEvent } from './scrub.ts';

// The demo seed: captured hook events of real agent sessions, fed in order through the same
// functions a live session calls, so the demo graph is built by the same code. The live site
// says so. File modification times are shifted to replay time so the Stop sweep sees the same
// "newer on disk than anything recorded" relationships as the original session did.

export function readEvents(file: string): CapturedEvent[] {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as CapturedEvent);
}

export async function replay(db: Db, teamId: string, events: CapturedEvent[]): Promise<{ applied: number; skipped: number }> {
  const who = new Map<string, Principal>();
  const principal = async (memberId: string): Promise<Principal> => {
    // Captured member ids name the demo team; map them onto whatever team is being seeded.
    const local = `${teamId}.${memberId.split('.').pop()}`;
    if (!who.has(local)) {
      const p = await one<Principal>(db.control(), CONTROL.principalById, { id: local }, { readOnly: true });
      if (!p) throw new Error(`Replay: member ${local} does not exist; run the demo setup first`);
      who.set(local, p);
    }
    return who.get(local)!;
  };

  let applied = 0;
  let skipped = 0;
  for (const e of events) {
    const p = await principal(e.member);
    const b = e.body;
    switch (e.route) {
      case '/hooks/session-start':
        await sessionStart(db, p, b as { session_id: string; tool?: string; branch?: string });
        break;
      case '/hooks/read':
        await onRead(db, p, b as unknown as ToolEvent);
        break;
      case '/hooks/pre-edit':
        await preEdit(db, p, b as unknown as ToolEvent);
        break;
      case '/hooks/post-edit':
        await postEdit(db, p, b as unknown as ToolEvent);
        break;
      case '/hooks/stop': {
        const shift = Date.now() - e.at;
        const files = ((b.files ?? []) as { path: string; mtimeMs: number }[]).map((f) => ({ ...f, mtimeMs: f.mtimeMs + shift }));
        await stopSweep(db, p, { session_id: String(b.session_id), cwd: String(b.cwd), files });
        break;
      }
      case '/mcp': {
        const params = b.params as { name?: string; arguments?: Record<string, string> } | undefined;
        if (params?.name === 'rule_lookup' && params.arguments) {
          const a = params.arguments;
          await lookupRule(db, p, { rule: a.rule ?? '', path: normalisePath(a.path ?? ''), jurisdiction: a.jurisdiction });
        } else if (params?.name === 'record_rule' && params.arguments) {
          // A rule recorded during the captured sessions is applied where it happened in time.
          const a = params.arguments as unknown as Omit<NewRule, 'owner'>;
          await recordRule(db, p, { ...a, owner: p.memberId, scope: a.scope.map(normalisePath) });
        } else {
          skipped++;
          continue;
        }
        break;
      }
      default:
        skipped++;
        continue;
    }
    applied++;
  }
  return { applied, skipped };
}
