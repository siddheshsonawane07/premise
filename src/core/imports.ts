import path from 'node:path';

// Which repo files a source file imports from, read from its text. Only relative imports count:
// a package (`zod`, `node:fs`) is not a file in the repo. Stored as IMPORTS edges, so a rule
// change can follow a borrowed constant back to the file that defines it.

export interface Import { path: string; names: string[] }

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
// `import … from '…'` and `export … from '…'`, across lines; `import '…'` has no names and is skipped.
// The clause allows only names, spaces, braces, commas and `*`, so it cannot run across a
// statement such as `export function f() {`. The keyword must start a statement, so the
// words "import … from './x'" inside a string do not count.
const FROM = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?([\w$\s{},*]*?)\s*from\s+['"](\.{1,2}\/[^'"]+)['"]/g;

/** `src/wallet/topup.ts` importing `{ LIMIT } from './limits.ts'` → `[{ path: 'src/wallet/limits.ts', names: ['LIMIT'] }]`. */
export function parseImports(fromPath: string, content: string): Import[] {
  if (!CODE.test(fromPath)) return [];
  const byPath = new Map<string, Set<string>>();
  for (const m of content.matchAll(FROM)) {
    const target = resolve(fromPath, m[4]!);
    if (!target || target === fromPath) continue;
    const names = byPath.get(target) ?? new Set<string>();
    for (const n of namesIn(m[3]!)) names.add(n);
    byPath.set(target, names);
  }
  return [...byPath].map(([p, names]) => ({ path: p, names: [...names].sort() }));
}

/** The names a clause brings in, by their name in the source file: `{ A, B as C }` → A, B; `* as X` → *. */
function namesIn(clause: string): string[] {
  const out: string[] = [];
  const braces = clause.match(/\{([\s\S]*)\}/);
  if (braces) {
    for (const part of braces[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push(name);
    }
  }
  if (clause.includes('*')) out.push('*');
  const before = clause.replace(/\{[\s\S]*\}/, '').replace(/\*\s+as\s+[\w$]+/, '').replace(/,/g, ' ').trim();
  if (/^[A-Za-z_$][\w$]*$/.test(before)) out.push('default');
  return out;
}

/** A relative specifier to a repo path. No extension means `.ts`; `.js` in a TS repo means `.ts`. */
function resolve(fromPath: string, spec: string): string | undefined {
  let p = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), spec));
  if (p.startsWith('..')) return undefined;
  if (!CODE.test(p) && !p.endsWith('.json')) p = `${p}.ts`;
  else if (fromPath.endsWith('.ts') && p.endsWith('.js')) p = `${p.slice(0, -3)}.ts`;
  return p;
}
