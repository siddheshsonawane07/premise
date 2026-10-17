import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { Principal } from '../auth.ts';
import { getPropagation, handOff, NotAllowed, type PropagationView, receipt, resolveTask, supersede } from '../core/change.ts';
import { formatFigure } from '../core/rules.ts';
import { auditCsv, auditPack } from '../core/audit.ts';
import { impact, overlayPaths, shortestToRegulators } from '../core/impact.ts';
import { why } from '../core/why.ts';
import { confirmGuess, type Guess, listGuesses } from '../core/guesses.ts';
import { fixSet } from '../core/fix.ts';
import { type Db, one, run } from '../db/client.ts';
import { CONTROL, TEAM } from '../db/queries.ts';
import type { PropagationQueue } from '../propagate/queue.ts';
import { html, page, raw } from './html.ts';

// The web view: Overview, Rules (record and change), Receipt, Why (the path, drawn), Tasks.
// The browser acts as one member chosen on the server (PREMISE_WEB_MEMBER); its key never
// reaches the browser.

const here = path.dirname(fileURLToPath(import.meta.url));

interface RuleRow {
  ruleId: string; title: string; risk: string; jurisdiction: string; versionId: string; n: number; figure?: number;
  unit?: string; status: string; citation: string; effectiveFrom: string; text: string;
  scopes: { path: string | null; source: string | null }[];
}
interface TaskRow {
  taskId: string; status: string; due: string; tier: string; path: string; assignee: string; ruleId: string;
  propagationId: string; verdict?: string; verdictReason?: string; claimBy?: string; resolvedReason?: string;
}
interface FindingRow {
  path: string; tier: string; owner?: string; taskId?: string; taskStatus?: string; verdict?: string; reason?: string; patch?: string;
}

const fig = (f?: number, u?: string) => formatFigure(f, u).replace(/ \(.*\)$/, '');
const badge = (cls: string, text: string) => html`<span class="badge ${cls}">${text}</span>`;
const verdictBadge = (v?: string) =>
  v === 'needs_change' ? badge('bad', 'needs change') : v === 'still_fine' ? badge('ok', 'still fine') : badge('muted', v ?? 'not reviewed');
const tierBadge = (t: string) => badge(`tier-${t}`, t.replace('_', ' '));

export function webRoutes(db: Db, queue: PropagationQueue, memberId: string | undefined): Router {
  const r = express.Router();
  r.use('/static', express.static(path.join(here, 'public'), { maxAge: '1h' }));
  r.use('/static/vendor', express.static(path.join(here, '..', '..', 'node_modules', 'cytoscape', 'dist'), { maxAge: '1d' }));
  r.use(express.urlencoded({ extended: false, limit: '20kb' }));

  const viewer = async (): Promise<Principal> => {
    if (!memberId) throw new NotAllowed('PREMISE_WEB_MEMBER is not set, so the web view has no member to act as.');
    const p = await one<Principal>(db.control(), CONTROL.principalById, { id: memberId }, { readOnly: true });
    if (!p) throw new NotAllowed(`Web member ${memberId} does not exist.`);
    return p;
  };
  const wrap = (fn: (req: Request, res: Response, who: Principal) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => { viewer().then((who) => fn(req, res, who)).catch(next); };

  // ── Overview ─────────────────────────────────────────────────────────────
  r.get('/', wrap(async (_req, res, who) => {
    const g = db.team(who.teamId);
    const [rules, props, tasks, guesses] = await Promise.all([
      run<RuleRow>(g, TEAM.listRules, {}, { readOnly: true }),
      run<{ id: string }>(g, TEAM.listPropagations, { limit: 8 }, { readOnly: true }),
      run<TaskRow>(g, TEAM.allTasks, { now: Date.now() }, { readOnly: true }),
      listGuesses(db, who.teamId),
    ]);
    const views = (await Promise.all(props.map((p) => getPropagation(db, who.teamId, p.id)))).filter(Boolean) as PropagationView[];
    const open = tasks.filter((t) => t.status !== 'resolved');
    res.send(page({ title: 'Overview', who: who.name, active: '/', body: html`
      <h1>Which code was written under which rule</h1>
      <p class="lede">Premise records, at the moment an AI agent edits a file, which version of which rule it was shown or looked up.
      When a rule changes, it follows the graph to every file written under the old version.</p>
      <section class="cards">
        <div class="card"><div class="n">${rules.length}</div><div>rules</div></div>
        <div class="card"><div class="n">${open.length}</div><div>open review tasks</div></div>
        <div class="card"><div class="n">${views.length}</div><div>recent rule changes</div></div>
        <a class="card" href="/guesses"><div class="n">${guesses.length}</div><div>guessed figures to confirm</div></a>
      </section>
      <h2>Recent rule changes</h2>
      ${views.length ? html`<ul class="receipts">${views.map((p) => html`<li><a href="/receipt/${p.id}">${badge(p.dryRun ? 'muted' : 'warn', p.dryRun ? 'dry run' : 'final')} ${receipt(p)}</a></li>`)}</ul>`
        : html`<p class="muted">No rule has changed yet. <a href="/rules">Change one</a>.</p>`}
    ` }));
  }));

  // ── Rules ────────────────────────────────────────────────────────────────
  r.get('/rules', wrap(async (_req, res, who) => {
    const rules = await run<RuleRow>(db.team(who.teamId), TEAM.listRules, {}, { readOnly: true });
    res.send(page({ title: 'Rules', who: who.name, active: '/rules', body: html`
      <h1>Rules</h1>
      ${rules.map((x) => {
        const declared = x.scopes.filter((s) => s.path && s.source === 'declared');
        const proposed = x.scopes.filter((s) => s.path && s.source === 'proposed');
        return html`<article class="rule">
          <header><span class="j">${x.jurisdiction}</span> <h2>${x.title}</h2> ${badge(x.status === 'final' ? 'ok' : 'warn', `v${x.n} ${x.status}`)}</header>
          <p class="figure">${fig(x.figure, x.unit) || 'no single figure'}</p>
          <p>${x.text}</p>
          <p class="muted">Citation: ${x.citation}. Effective ${x.effectiveFrom}. Rule id <code>${x.ruleId}</code>. <a href="/audit/${x.ruleId}">Audit evidence</a></p>
          <p>Scope: ${declared.map((s) => html`<code>${s.path}</code> `)}</p>
          ${proposed.length ? html`<p>Proposed by agents' lookups: ${proposed.map((s) => html`
            <form method="post" action="/rules/${x.ruleId}/accept-scope" class="inline"><input type="hidden" name="path" value="${s.path}">
            <code>${s.path}</code> <button>accept</button></form> `)}</p>` : ''}
          <details><summary>Change this rule</summary>
            <form method="post" action="/rules/${x.ruleId}/supersede" class="change">
              <label>New text <textarea name="text" required maxlength="1000">${x.text}</textarea></label>
              <label>New figure (${x.unit ?? 'none'}) <input name="figure" type="number" step="1" value="${x.figure ?? ''}"></label>
              <label>Citation <input name="citation" required maxlength="300" value="${x.citation}"></label>
              <label>Effective from <input name="effectiveFrom" type="date" required value="${x.effectiveFrom}"></label>
              <label>Reason <input name="reason" required maxlength="300" placeholder="Why it changed"></label>
              <input type="hidden" name="unit" value="${x.unit ?? ''}">
              <div class="row">
                <button name="mode" value="draft">Dry run as draft</button>
                ${who.role === 'compliance' ? html`<button name="mode" value="final" class="primary">Make final and open tasks</button>` : ''}
              </div>
            </form>
          </details>
        </article>`;
      })}
    ` }));
  }));

  r.post('/rules/:id/supersede', wrap(async (req, res, who) => {
    const b = req.body as Record<string, string>;
    const figure = b.figure ? Number.parseInt(b.figure, 10) : undefined;
    const unit = (['paise', 'cents', 'percent', 'none'].includes(b.unit ?? '') ? b.unit : undefined) as 'paise' | 'cents' | undefined;
    const s = await supersede(db, who, {
      ruleId: String(req.params.id), text: String(b.text ?? '').slice(0, 1000), figure: Number.isFinite(figure) ? figure : undefined, unit,
      citation: String(b.citation ?? '').slice(0, 300), effectiveFrom: String(b.effectiveFrom ?? ''),
      reason: String(b.reason ?? '').slice(0, 300), draft: b.mode !== 'final',
    });
    queue.enqueue(who.teamId, s.propagationId);
    await queue.wait(s.propagationId, 8000);
    res.redirect(303, `/receipt/${s.propagationId}`);
  }));

  r.post('/rules/:id/accept-scope', wrap(async (req, res, who) => {
    await run(db.team(who.teamId), TEAM.acceptScope, { ruleId: String(req.params.id), path: String(req.body.path ?? '') });
    res.redirect(303, '/rules');
  }));

  // ── Guessed figures: drafts an agent recorded, waiting for compliance ─────
  r.get('/guesses', wrap(async (_req, res, who) => {
    const guesses = await listGuesses(db, who.teamId);
    const files = (g: Guess) => [...new Set([...g.files, ...g.asked])].sort();
    res.send(page({ title: 'Guessed figures', who: who.name, active: '/guesses', body: html`
      <h1>Figures an AI agent guessed (${guesses.length})</h1>
      <p class="lede">An agent that needed a figure no one had recorded wrote it down as a draft, with its source, instead of
      typing it silently into the code. Each one waits here for compliance. The most-relied-on comes first: if it is wrong,
      it is wrong in every file listed.</p>
      ${guesses.length ? guesses.map((g) => html`<article class="rule">
        <header><span class="j">${g.jurisdiction}</span> <h2>${g.title}</h2> ${badge('warn', 'unconfirmed')}</header>
        <p class="figure">${fig(g.figure, g.unit) || 'no single figure'}</p>
        <p>${g.text}</p>
        <p class="muted">Recorded by ${g.authorName ?? 'an agent'}'s agent. Its source: ${g.citation}.</p>
        <p><b>${files(g).length} file${files(g).length === 1 ? '' : 's'} already built on it:</b>
          ${files(g).map((p) => html`<a href="/why?path=${encodeURIComponent(p)}"><code>${p}</code></a> `)}</p>
        ${who.role === 'compliance' ? html`<div class="row">
          <details><summary>Confirm it</summary>
            <form method="post" action="/guesses/${g.ruleId}/confirm" class="change">
              <label>The source you checked it against <input name="citation" required maxlength="300"
                value="${g.citation.replace(/^unverified:\s*from memory\s*[—-]\s*/i, '')}"></label>
              <button class="primary">Confirm ${fig(g.figure, g.unit)}</button>
            </form>
          </details>
          <details><summary>Correct it</summary>
            <form method="post" action="/rules/${g.ruleId}/supersede" class="change">
              <label>Correct text <textarea name="text" required maxlength="1000">${g.text}</textarea></label>
              <label>Correct figure (${g.unit ?? 'none'}) <input name="figure" type="number" step="1" value="${g.figure ?? ''}"></label>
              <label>Source <input name="citation" required maxlength="300" placeholder="Where the correct figure comes from"></label>
              <label>Effective from <input name="effectiveFrom" type="date" required value="${g.effectiveFrom}"></label>
              <input type="hidden" name="reason" value="Corrected an agent's guess">
              <input type="hidden" name="unit" value="${g.unit ?? ''}">
              <button name="mode" value="final" class="primary">Correct it and open tasks for these files</button>
            </form>
          </details>
        </div>` : html`<p class="muted">Only a compliance member can confirm or correct it.</p>`}
      </article>`) : html`<p class="muted">No guessed figures are waiting.</p>`}
    ` }));
  }));

  r.post('/guesses/:id/confirm', wrap(async (req, res, who) => {
    await confirmGuess(db, who, String(req.params.id), String(req.body.citation ?? ''));
    res.redirect(303, '/guesses');
  }));

  // ── Receipt ──────────────────────────────────────────────────────────────
  r.get('/receipt/:id', wrap(async (req, res, who) => {
    const p = await getPropagation(db, who.teamId, String(req.params.id));
    if (!p) return res.status(404).send(page({ title: 'Not found', who: who.name, active: '', body: html`<p>No such rule change.</p>` }));
    const rows = await run<FindingRow>(db.team(who.teamId), TEAM.findings, { id: p.id }, { readOnly: true });
    res.send(page({ title: 'Receipt', who: who.name, active: '', refresh: p.status === 'done' ? undefined : 2, body: html`
      <h1>${p.dryRun ? 'Dry run' : 'Rule change'}: ${p.title} ${badge('', p.jurisdiction)}</h1>
      <p class="receipt">${receipt(p)}</p>
      ${p.dryRun ? html`<p class="muted">Draft: nothing is assigned until the rule is made final. The final run starts fresh from the graph.</p>` : ''}
      ${(() => {
        const fixes = rows.filter((f) => f.verdict === 'needs_change' && f.patch).length;
        return fixes ? html`<div class="card fix"><b>One-click fix: ${fixes} file${fixes === 1 ? '' : 's'} with a proposed fix.</b>
          In the repository, run <code>npx premise-fix ${p.id}</code>. It puts every fix on a new branch,
          <code>premise/${p.toId.replace('@', '-v')}</code>, cut from your current commit, without touching your checkout or
          <code>main</code>; a fix whose file has changed since it was reviewed is skipped and listed. Premise never merges.
          <a href="/receipt/${p.id}/fix.patch">Download the patch</a> instead.</div>` : '';
      })()}
      <table>
        <thead><tr><th>File</th><th>Linked because</th><th>Owner</th><th>Reviewer</th><th>Task</th></tr></thead>
        <tbody>${rows.map((f) => html`<tr>
          <td><a href="/why?path=${encodeURIComponent(f.path)}"><code>${f.path}</code></a></td>
          <td>${tierBadge(f.tier)}</td>
          <td>${f.owner ?? ''}</td>
          <td>${verdictBadge(f.verdict)}<div class="small">${f.reason ?? ''}</div>
              ${f.patch ? html`<details><summary>suggested patch</summary><pre>${f.patch}</pre></details>` : ''}</td>
          <td>${f.taskId ? html`${f.taskStatus?.replace('_', ' ')}` : html`<span class="muted">—</span>`}</td>
        </tr>`)}</tbody>
      </table>
      <p class="muted small">Tiers: <b>asked</b> = the agent looked the rule up while writing this file; <b>shown</b> = Premise showed it the rule
      before the edit; <b>in scope</b> = the file sits in the rule's folders but nothing was shown (a hand or shell edit); <b>session</b> = written in a session that looked the rule up for another file.</p>
    ` }));
  }));

  r.get('/receipt/:id/fix.patch', wrap(async (req, res, who) => {
    const set = await fixSet(db, who.teamId, String(req.params.id));
    if (!set || !set.files.length) return res.status(404).type('text/plain').send('No proposed fixes for this rule change.');
    res.attachment(`premise-${set.toId.replace('@', '-v')}.patch`).type('text/x-diff').send(set.files.map((f) => f.patch).join(''));
  }));

  // ── Why ──────────────────────────────────────────────────────────────────
  r.get('/why', wrap(async (req, res, who) => {
    const files = await run<{ path: string; changes: number }>(db.team(who.teamId), TEAM.listFiles, {}, { readOnly: true });
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    const paths = p ? await shortestToRegulators(db, who, p) : [];
    const w = p ? overlayPaths(await why(db, who, p), paths) : undefined;
    res.send(page({ title: 'Why', who: who.name, active: '/why', body: html`
      <h1>Why is this file the way it is?</h1>
      <form method="get" action="/why" class="inline">
        <select name="path" onchange="this.form.submit()"><option value="">Choose a file…</option>
          ${files.map((f) => html`<option value="${f.path}" ${f.path === p ? raw('selected') : ''}>${f.path} (${f.changes})</option>`)}
        </select>
      </form>
      ${w ? html`
        <h2>Shortest connection to each regulator <span class="small">(FalkorDB <code>algo.SPpaths</code>, highlighted)</span></h2>
        ${paths.length ? html`<ul class="paths">${paths.map((sp) => html`<li><b>${sp.jurisdiction}</b> (${sp.regulator}), ${sp.hops} hops: ${sp.labels.map((l, i) => html`${i ? html` <span class="rel">${sp.rels[i - 1]}</span> ` : ''}<code>${l}</code>`)}</li>`)}</ul>`
          : html`<p class="muted">This file is not connected to any regulator: no change to it relied on a rule.</p>`}
        <div id="graph" class="graph" aria-label="The path from this file to the rules its changes relied on"></div>
        <pre class="why">${w.text}</pre>
        <script type="application/json" id="why-data">${raw(JSON.stringify({ nodes: w.nodes, edges: w.edges }).replace(/</g, '\\u003c'))}</script>
      ` : ''}
    `, script: w ? '<script src="/static/vendor/cytoscape.min.js"></script><script src="/static/app.js"></script>' : undefined }));
  }));

  // ── Impact: graph algorithms over the whole team graph ─────────────────────
  r.get('/impact', wrap(async (_req, res, who) => {
    const im = await impact(db, who);
    const max = Math.max(...im.rules.map((x) => x.pageRank), 0.0001);
    res.send(page({ title: 'Impact', who: who.name, active: '/impact', body: html`
      <h1>Where a rule change would land</h1>
      <p class="lede">Computed over the whole graph with FalkorDB's built-in algorithms, not by searching the code.</p>
      <h2>Foundational rules <span class="small">(<code>algo.pageRank</code> over <code>DERIVES_FROM</code>)</span></h2>
      <table><thead><tr><th>Rule</th><th>Figure</th><th>Foundational</th><th>Files written under it</th><th>Via rules built on it</th></tr></thead>
      <tbody>${im.rules.map((x) => html`<tr>
        <td><b>[${x.jurisdiction}]</b> ${x.title}<div class="small"><code>${x.ruleId}</code>${x.derived.length ? html` · built on by ${x.derived.join(', ')}` : ''}</div></td>
        <td>${fig(x.figure, x.unit)}</td>
        <td><div class="bar"><span style="width:${raw(String(Math.round((x.pageRank / max) * 100)))}%"></span></div><div class="small">${x.pageRank.toFixed(3)}</div></td>
        <td>${x.direct}</td><td>${x.viaDerived}</td>
      </tr>`)}</tbody></table>
      <h2>Rules coupled through shared code <span class="small">(<code>algo.WCC</code>)</span></h2>
      ${im.clusters.map((c) => html`<p>${c.rules.length > 1 ? 'Coupled:' : 'On its own:'} ${c.rules.map((id) => html`<code>${id}</code> `)} <span class="small">(${c.files} files)</span></p>`)}
      ${im.coupling.length ? html`<p class="muted">Files that tie them together, each written under more than one rule:</p>
        <ul>${im.coupling.map((f) => html`<li><a href="/why?path=${encodeURIComponent(f.path)}"><code>${f.path}</code></a>: ${f.rules.join(', ')}</li>`)}</ul>` : ''}
    ` }));
  }));

  // ── Audit evidence for one rule ────────────────────────────────────────────
  r.get('/audit/:id/evidence.json', wrap(async (req, res, who) => {
    const pack = await auditPack(db, who, String(req.params.id));
    if (!pack) return res.status(404).json({ error: 'no such rule' });
    res.attachment(`premise-audit-${pack.ruleId}.json`).json(pack);
  }));
  r.get('/audit/:id/evidence.csv', wrap(async (req, res, who) => {
    const pack = await auditPack(db, who, String(req.params.id));
    if (!pack) return res.status(404).send('no such rule');
    res.attachment(`premise-audit-${pack.ruleId}.csv`).type('text/csv').send(auditCsv(pack));
  }));
  r.get('/audit/:id', wrap(async (req, res, who) => {
    const pack = await auditPack(db, who, String(req.params.id));
    if (!pack) return res.status(404).send(page({ title: 'Not found', who: who.name, active: '', body: html`<p>No such rule.</p>` }));
    const first = pack.versions[0]!;
    const when = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '');
    res.send(page({ title: 'Audit', who: who.name, active: '/rules', body: html`
      <h1>Audit evidence: ${first.title} ${badge('', first.jurisdiction)}</h1>
      <p class="lede">${pack.note}</p>
      <p><a href="/audit/${pack.ruleId}/evidence.json">Download JSON</a> · <a href="/audit/${pack.ruleId}/evidence.csv">Download CSV</a></p>
      ${pack.versions.map((v) => html`<article class="rule">
        <header><h2>Version ${v.n}</h2> ${badge(v.status === 'final' ? 'ok' : 'warn', v.status)} <span class="figure-sm">${fig(v.figure, v.unit)}</span></header>
        <p>${v.text}</p>
        <p class="muted">Citation: ${v.citation}. Effective ${v.effectiveFrom}. Recorded ${when(v.at)} by ${v.author.split('.').pop()}${v.approvedBy ? html`, approved by ${v.approvedBy}` : ''}.
          ${v.supersedes ? html`Supersedes <code>${v.supersedes}</code>: ${v.reason ?? ''}.` : ''}</p>
        ${v.changes.length ? html`<table><thead><tr><th>When (UTC)</th><th>File</th><th>Tier</th><th>Who</th><th>Session · tool · model</th></tr></thead><tbody>
          ${v.changes.map((c) => html`<tr><td>${when(c.at)}</td><td><a href="/why?path=${encodeURIComponent(c.path)}"><code>${c.path}</code></a></td>
            <td>${tierBadge(c.tier)}</td><td>${c.member}</td><td class="small">${c.session.slice(0, 8)} · ${c.tool ?? ''} · ${c.model ?? 'unknown'}</td></tr>`)}
        </tbody></table>` : html`<p class="muted">No code was written under this version.</p>`}
      </article>`)}
      <h2>Rule changes and their review</h2>
      ${pack.propagations.length ? pack.propagations.map((p) => html`<h3>${p.dryRun ? 'Dry run' : 'Final'} ${p.fromId} → ${p.toId}, ${when(p.at)}: ${p.filesTotal ?? 0} files</h3>
        ${p.tasks.length ? html`<table><tbody>${p.tasks.map((t) => html`<tr><td><code>${t.path}</code></td><td>${t.assignee}</td><td>${t.status.replace('_', ' ')}</td>
          <td>${verdictBadge(t.verdict)}<div class="small">${t.model ? `${t.model}, prompt ${t.promptVersion}` : ''}</div></td><td class="small">${t.resolvedReason ?? ''}</td></tr>`)}</tbody></table>`
          : html`<p class="muted">${p.dryRun ? 'Dry run: no tasks opened.' : 'No tasks.'}</p>`}`)
        : html`<p class="muted">This rule has not changed.</p>`}
    ` }));
  }));

  // ── Tasks ────────────────────────────────────────────────────────────────
  r.get('/tasks', wrap(async (_req, res, who) => {
    const tasks = await run<TaskRow>(db.team(who.teamId), TEAM.allTasks, { now: Date.now() }, { readOnly: true });
    const members = await run<{ id: string; name: string }>(db.team(who.teamId), TEAM.listMembers, {}, { readOnly: true });
    const groups = [['open', 'Open'], ['proposed_clear', 'Reviewer proposes to clear'], ['resolved', 'Resolved']] as const;
    res.send(page({ title: 'Tasks', who: who.name, active: '/tasks', body: html`
      <h1>Review tasks</h1>
      ${groups.map(([status, label]) => {
        const list = tasks.filter((t) => t.status === status);
        return html`<h2>${label} (${list.length})</h2>${list.length ? html`<table><tbody>${list.map((t) => html`<tr>
          <td><a href="/why?path=${encodeURIComponent(t.path)}"><code>${t.path}</code></a></td>
          <td>${t.ruleId}</td><td>${tierBadge(t.tier)}</td><td>${t.assignee}${t.claimBy ? html` <span class="small">(claimed by ${t.claimBy})</span>` : ''}</td>
          <td>due ${t.due}</td><td>${verdictBadge(t.verdict)}</td>
          <td>${status === 'resolved' ? html`<span class="small">${t.resolvedReason ?? ''}</span>` : html`
            <form method="post" action="/tasks/${t.taskId}/resolve" class="inline">
              <input name="reason" required minlength="10" maxlength="500" placeholder="Reason" value="${status === 'proposed_clear' ? 'Confirmed the Reviewer: the file does not use the figure' : ''}">
              <button>${status === 'proposed_clear' ? 'confirm clear' : 'resolve'}</button></form>
            <details class="small"><summary>hand off</summary><form method="post" action="/tasks/${t.taskId}/hand-off" class="inline">
              <select name="to">${members.filter((m) => m.name !== t.assignee).map((m) => html`<option value="${m.id}">${m.name}</option>`)}</select>
              <input name="note" required minlength="10" maxlength="500" placeholder="What they need to know">
              <button>hand off</button></form></details>`}</td>
        </tr>`)}</tbody></table>` : html`<p class="muted">None.</p>`}`;
      })}
    ` }));
  }));

  r.post('/tasks/:id/hand-off', wrap(async (req, res, who) => {
    await handOff(db, who, String(req.params.id), String(req.body.to ?? ''), String(req.body.note ?? ''));
    res.redirect(303, '/tasks');
  }));

  r.post('/tasks/:id/resolve', wrap(async (req, res, who) => {
    await resolveTask(db, who, String(req.params.id), String(req.body.reason ?? ''));
    res.redirect(303, '/tasks');
  }));

  r.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof NotAllowed) return res.status(400).send(page({ title: 'Not allowed', who: '', active: '', body: html`<p class="error">${err.message}</p><p><a href="javascript:history.back()">Back</a></p>` }));
    next(err);
  });

  return r;
}
