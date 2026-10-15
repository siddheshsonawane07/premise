import path from 'node:path';

// Hooks send absolute paths, which carry the developer's home directory. Premise stores only
// paths relative to the repo root (STRICT 3, 16.3), and refuses anything outside it.

export class PathOutsideRepo extends Error {}

const MAX_DEPTH = 12;

/** `/Users/x/proj/src/a.ts` with root `/Users/x/proj` → `src/a.ts`. */
export function toRepoPath(root: string, filePath: string): string {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  const rel = path.relative(path.resolve(root), path.resolve(abs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathOutsideRepo('Path is outside the repository');
  }
  const posix = rel.split(path.sep).join('/');
  if (posix.split('/').length > MAX_DEPTH) throw new PathOutsideRepo('Path is too deep');
  return posix;
}

/** Every folder above a file, nearest first: `src/wallet/a.ts` → [`src/wallet`, `src`, `.`]. */
export function foldersAbove(repoPath: string): string[] {
  const parts = repoPath.split('/').slice(0, -1);
  const out: string[] = [];
  for (let i = parts.length; i > 0; i--) out.push(parts.slice(0, i).join('/'));
  out.push('.');
  return out;
}

/** The folder a file or folder sits in: `src/wallet/a.ts` → `src/wallet`; `src` → `.`. */
export function parentOf(repoPath: string): string {
  const i = repoPath.lastIndexOf('/');
  return i === -1 ? '.' : repoPath.slice(0, i);
}
