// Captured hook events carry the developer's home directory (cwd, file paths, transcript paths)
// and session plumbing. Before a capture is committed as the demo seed, keep only what the
// replay needs and move every path under a neutral root (STRICT 3, 16.3).

export const DEMO_ROOT = '/demo/tilldesk';

export interface CapturedEvent {
  at: number;
  route: string;
  member: string;
  body: Record<string, unknown>;
}

const KEEP_HOOK_FIELDS = ['session_id', 'cwd', 'tool_name', 'tool_input', 'tool_response', 'tool_use_id', 'files', 'tool', 'branch'];

export function scrubEvent(e: CapturedEvent, realRoot: string): CapturedEvent | undefined {
  let body: Record<string, unknown>;
  if (e.route === '/mcp') {
    // Only tool calls change the graph; the handshake and listings are dropped.
    if (e.body.method !== 'tools/call') return undefined;
    body = { method: 'tools/call', params: e.body.params };
  } else {
    body = Object.fromEntries(Object.entries(e.body).filter(([k]) => KEEP_HOOK_FIELDS.includes(k)));
  }
  return { at: e.at, route: e.route, member: e.member, body: rewrite(body, realRoot) as Record<string, unknown> };
}

function rewrite(v: unknown, root: string): unknown {
  if (typeof v === 'string') return v.split(root).join(DEMO_ROOT);
  if (Array.isArray(v)) return v.map((x) => rewrite(x, root));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x, root)]));
  return v;
}

/** Anything that still looks personal: a home directory or an email address. */
export function personalLeaks(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\/(Users|home)\/[^/"\\\s]+/g)) found.add(m[0]);
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.(?:com|org|net|io|in|dev|co)\b/g)) found.add(m[0]);
  return [...found];
}
