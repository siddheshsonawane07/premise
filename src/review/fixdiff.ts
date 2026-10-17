// The Reviewer proposes line replacements against the snapshot it read; Premise turns them into a
// real unified diff, so `git apply` can check it against the developer's file and refuse it if
// the file has changed since. A model writing diff syntax itself produced prose instead.

export interface LineEdit { line: number; text: string }

const CONTEXT = 3;

/** A unified diff for `path` that replaces each edited line (1-based) with `text` (may hold several lines). */
export function diffFromEdits(path: string, content: string, edits: LineEdit[]): string | undefined {
  const old = content.split('\n');
  const trailingNewline = content.endsWith('\n');
  if (trailingNewline) old.pop();
  const byLine = new Map<number, string[]>();
  for (const e of edits) {
    if (!Number.isInteger(e.line) || e.line < 1 || e.line > old.length) continue;
    const next = e.text.replace(/\r/g, '').split('\n');
    if (next.length === 1 && next[0] === old[e.line - 1]) continue; // no change
    byLine.set(e.line, next);
  }
  if (!byLine.size) return undefined;

  // Group edited lines whose context windows touch into one hunk.
  const lines = [...byLine.keys()].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const n of lines) {
    const g = groups.at(-1);
    if (g && n - g.at(-1)! <= CONTEXT * 2 + 1) g.push(n); else groups.push([n]);
  }

  let newOffset = 0;
  const hunks: string[] = [];
  for (const g of groups) {
    const start = Math.max(1, g[0]! - CONTEXT);
    const end = Math.min(old.length, g.at(-1)! + CONTEXT);
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    const NO_EOL = '\\ No newline at end of file';
    for (let n = start; n <= end; n++) {
      const replaced = byLine.get(n);
      const last = n === old.length && !trailingNewline;
      if (replaced) {
        body.push(`-${old[n - 1]}`);
        if (last) body.push(NO_EOL);
        oldCount++;
        for (const r of replaced) { body.push(`+${r}`); newCount++; }
        if (last) body.push(NO_EOL);
      } else {
        body.push(` ${old[n - 1]}`);
        if (last) body.push(NO_EOL);
        oldCount++;
        newCount++;
      }
    }
    hunks.push(`@@ -${start},${oldCount} +${start + newOffset},${newCount} @@\n${body.join('\n')}`);
    newOffset += newCount - oldCount;
  }
  return `--- a/${path}\n+++ b/${path}\n${hunks.join('\n')}\n`;
}
