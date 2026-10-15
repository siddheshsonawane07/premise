import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { Principal } from '../auth.ts';
import { getPropagation, NotAllowed, type PropagationView, receipt, resolveTask, supersede } from '../core/change.ts';
import { formatFigure } from '../core/rules.ts';
import { why } from '../core/why.ts';
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
    const [rules, props, tasks] = await Promise.all([
      run<RuleRow>(g, TEAM.listRules, {}, { readOnly: true }),
      run<{ id: string }>(g, TEAM.listPropagations, { limit: 8 }, { readOnly: true }),
      run<TaskRow>(g, TEAM.allTasks, { now: Date.now() }, { readOnly: true }),
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
          <p class="muted">Citation: ${x.citation}. Effective ${x.effectiveFrom}. Rule id <code>${x.ruleId}</code>.</p>
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

  // ── Receipt ──────────────────────────────────────────────────────────────
  r.get('/receipt/:id', wrap(async (req, res, who) => {
    const p = await getPropagation(db, who.teamId, String(req.params.id));
    if (!p) return res.status(404).send(page({ title: 'Not found', who: who.name, active: '', body: html`<p>No such rule change.</p>` }));
    const rows = await run<FindingRow>(db.team(who.teamId), TEAM.findings, { id: p.id }, { readOnly: true });
    res.send(page({ title: 'Receipt', who: who.name, active: '', refresh: p.status === 'done' ? undefined : 2, body: html`
      <h1>${p.dryRun ? 'Dry run' : 'Rule change'}: ${p.title} ${badge('', p.jurisdiction)}</h1>
      <p class="receipt">${receipt(p)}</p>
      ${p.dryRun ? html`<p class="muted">Draft: nothing is assigned until the rule is made final. The final run starts fresh from the graph.</p>` : ''}
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
      before the edit; <b>in scope</b> = the file sits in the rule's folders but nothing was shown (a hand or shell edit).</p>
    ` }));
  }));

  // ── Why ──────────────────────────────────────────────────────────────────
  r.get('/why', wrap(async (req, res, who) => {
    const files = await run<{ path: string; changes: number }>(db.team(who.teamId), TEAM.listFiles, {}, { readOnly: true });
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    const w = p ? await why(db, who, p) : undefined;
    res.send(page({ title: 'Why', who: who.name, active: '/why', body: html`
      <h1>Why is this file the way it is?</h1>
      <form method="get" action="/why" class="inline">
        <select name="path" onchange="this.form.submit()"><option value="">Choose a file…</option>
          ${files.map((f) => html`<option value="${f.path}" ${f.path === p ? raw('selected') : ''}>${f.path} (${f.changes})</option>`)}
        </select>
      </form>
      ${w ? html`
        <div id="graph" class="graph" aria-label="The path from this file to the rules its changes relied on"></div>
        <pre class="why">${w.text}</pre>
        <script type="application/json" id="why-data">${raw(JSON.stringify({ nodes: w.nodes, edges: w.edges }).replace(/</g, '\\u003c'))}</script>
      ` : ''}
    `, script: w ? '<script src="/static/vendor/cytoscape.min.js"></script><script src="/static/app.js"></script>' : undefined }));
  }));

  // ── Tasks ────────────────────────────────────────────────────────────────
  r.get('/tasks', wrap(async (_req, res, who) => {
    const tasks = await run<TaskRow>(db.team(who.teamId), TEAM.allTasks, { now: Date.now() }, { readOnly: true });
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
              <button>${status === 'proposed_clear' ? 'confirm clear' : 'resolve'}</button></form>`}</td>
        </tr>`)}</tbody></table>` : html`<p class="muted">None.</p>`}`;
      })}
    ` }));
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
