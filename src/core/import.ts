import fs from 'node:fs';
import path from 'node:path';
import type { Principal } from '../auth.ts';
import { type Db, one, run } from '../db/client.ts';
import { TEAM } from '../db/queries.ts';
import { supersede } from './change.ts';
import { recordRule, versionHash } from './rules.ts';

// A team's existing rules files become versioned rules in the graph. Claude Code's
// .claude/rules/*.md already carry a scope in their `paths:` front matter; Premise keeps every
// version, links code to them like any rule, and when a file changes, the import records a new
// version, so code written under the old convention is found.

export interface ParsedRule { file: string; id: string; title: string; text: string; scope: string[] }

export function parseRuleFile(file: string, content: string): ParsedRule {
  let body = content;
  let paths: string[] = [];
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (fm) {
    body = content.slice(fm[0].length);
    const block = fm[1]!;
    const inline = /^paths:\s*\[(.*)\]\s*$/m.exec(block);
    const single = /^paths:\s*["']?([^"'\n[\]]+)["']?\s*$/m.exec(block);
    if (inline) paths = inline[1]!.split(',').map((p) => p.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else if (/^paths:\s*$/m.test(block)) {
      const after = block.slice(block.search(/^paths:\s*$/m)).split('\n').slice(1);
      for (const line of after) {
        const m = /^\s*-\s*["']?([^"'\n]+?)["']?\s*$/.exec(line);
        if (!m) break;
        paths.push(m[1]!);
      }
    } else if (single) paths = [single[1]!.trim()];
  }
  const heading = /^#\s+(.+)$/m.exec(body);
  const name = path.basename(file, '.md');
  const text = body.replace(/^#\s+.+$/m, '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  return {
    file,
    id: `team-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`.slice(0, 40),
    title: (heading?.[1] ?? name).trim().slice(0, 120),
    text: text || '(empty)',
    scope: [...new Set(paths.map(globToFolder))],
  };
}

/** `src/wallet/**` → `src/wallet`; `**\/*.ts` or `*` → `.` (the whole repo). */
export function globToFolder(glob: string): string {
  const parts = glob.replace(/^\.\//, '').split('/');
  const fixed: string[] = [];
  for (const p of parts) {
    if (/[*?[{]/.test(p)) break;
    fixed.push(p);
  }
  // A path ending in a file name (no wildcard) scopes that file's folder.
  if (fixed.length === parts.length && /\.[a-z0-9]+$/i.test(fixed[fixed.length - 1] ?? '')) fixed.pop();
  return fixed.length ? fixed.join('/') : '.';
}

export interface ImportResult { file: string; ruleId: string; action: 'created' | 'unchanged' | 'new version'; propagationId?: string }

export async function importRules(db: Db, who: Principal, repoDir: string): Promise<ImportResult[]> {
  const dir = path.join(repoDir, '.claude', 'rules');
  if (!fs.existsSync(dir)) return [];
  const g = db.team(who.teamId);
  await run(g, TEAM.upsertJurisdiction, { code: 'TEAM', name: 'Team convention', regulator: 'the team' });
  const today = new Date().toISOString().slice(0, 10);
  const out: ImportResult[] = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const r = parseRuleFile(`.claude/rules/${name}`, fs.readFileSync(path.join(dir, name), 'utf8'));
    const scope = r.scope.length ? r.scope : ['.'];
    const current = await one<{ hash: string }>(g, TEAM.currentHash, { id: r.id }, { readOnly: true });
    if (!current) {
      await recordRule(db, who, {
        id: r.id, title: r.title, type: 'constraint', owner: who.memberId, risk: 'low', jurisdiction: 'TEAM', text: r.text,
        citation: `${r.file} (imported)`, effectiveFrom: today, status: 'final', scope,
      });
      out.push({ file: r.file, ruleId: r.id, action: 'created' });
    } else if (current.hash !== versionHash(r.text)) {
      const s = await supersede(db, who, {
        ruleId: r.id, text: r.text, citation: `${r.file} (imported)`, effectiveFrom: today,
        reason: `${r.file} changed`, draft: false,
      });
      out.push({ file: r.file, ruleId: r.id, action: 'new version', propagationId: s.propagationId });
    } else {
      out.push({ file: r.file, ruleId: r.id, action: 'unchanged' });
    }
  }
  return out;
}
