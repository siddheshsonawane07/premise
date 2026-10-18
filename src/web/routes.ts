import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { Principal } from '../auth.ts';
import { getPropagation, handOff, NotAllowed, type PropagationView, resolveTask, supersede } from '../core/change.ts';
import { formatFigure } from '../core/rules.ts';
import { auditCsv, auditPack } from '../core/audit.ts';
import { impact, overlayPaths, shortestToRegulators } from '../core/impact.ts';
import { why, type WhyStep } from '../core/why.ts';
import { confirmGuess, type Guess, listGuesses } from '../core/guesses.ts';
import { fixSet } from '../core/fix.ts';
import { type Db, one, run } from '../db/client.ts';
import { CONTROL, TEAM } from '../db/queries.ts';
import type { PropagationQueue } from '../propagate/queue.ts';
import { ASSET_V, html, page, raw } from './html.ts';

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
// Some agents stored a rate in basis points with no unit; their wording says so. Show it as a percent.
const guessFig = (g: Guess) => g.unit === 'none' && g.figure !== undefined && /basis points/i.test(g.text)
  ? `${g.figure / 100}%` : fig(g.figure, g.unit);
const badge = (cls: string, text: string) => html`<span class="badge ${cls}">${text}</span>`;
const verdictBadge = (v?: string) =>
  v === 'needs_change' ? badge('bad', 'needs change') : v === 'still_fine' ? badge('ok', 'still fine') : badge('muted', v ?? 'not reviewed');
// Why a file was linked to a rule, in words; the stored tier name stays in the tooltip.
const TIER_WORDS: Record<string, string> = {
  asked: 'its AI looked the rule up', shown: 'its AI was shown the rule', in_scope: "edited in the rule's folders",
  session: 'looked up in the same session', mentions: 'still has the old figure',
};
const tierBadge = (t: string) => html`<span class="badge tier-${t}" title="tier: ${t}">${TIER_WORDS[t] ?? t.replace('_', ' ')}</span>`;

/** A rule change in one short line, for people; receipt() keeps the counted form for agents and tests. */
function summary(p: PropagationView): string {
  const what = `${p.title}: ${fig(p.oldFigure, p.unit) || 'old'} → ${fig(p.newFigure, p.unit) || 'new'}`;
  if (p.status !== 'done') return `${what} · checking…`;
  const fix = p.needsReview ?? 0;
  const fine = p.cleared ?? 0;
  return `${what} · ${fix} need${fix === 1 ? 's' : ''} a fix${fine ? `, ${fine} fine` : ''}`;
}

/** Home's picture of the product: four panels, left to right (top to bottom on a phone). */
function howItWorks(example: string) {
  const file = (name: string, cls = '') => html`<span class="d-file ${cls}"><span class="d-lines"></span>${name}</span>`;
  return html`<div class="flow" role="img" aria-label="How Premise works, in four steps">
    <div class="panel">
      <span class="step-n">1</span><b>AI writes code</b>
      <div class="pic">${file('payslip.ts')}<span class="d-tag">built on ${example}</span></div>
    </div>
    <span class="flow-arrow" aria-hidden="true"></span>
    <div class="panel">
      <span class="step-n">2</span><b>A rule changes</b>
      <div class="pic d-change"><span class="d-old">${example}</span><span class="d-to">→</span><span class="d-new">new figure</span></div>
    </div>
    <span class="flow-arrow" aria-hidden="true"></span>
    <div class="panel">
      <span class="step-n">3</span><b>Premise finds every file</b>
      <div class="pic"><svg viewBox="0 0 224 104" class="d-graph" aria-hidden="true">
        <line x1="38" y1="52" x2="96" y2="14"></line><line x1="38" y1="52" x2="96" y2="52"></line>
        <line x1="38" y1="52" x2="96" y2="90"></line><line x1="152" y1="52" x2="168" y2="52" class="dash"></line>
        <circle cx="24" cy="52" r="15" class="rule"></circle>
        <rect x="96" y="4" width="56" height="20" rx="4"></rect><rect x="96" y="42" width="56" height="20" rx="4"></rect>
        <rect x="96" y="80" width="56" height="20" rx="4"></rect><rect x="168" y="42" width="52" height="20" rx="4" class="far"></rect>
        <text x="24" y="56" text-anchor="middle" class="on-rule">rule</text>
        <text x="124" y="18" text-anchor="middle">file</text><text x="124" y="56" text-anchor="middle">file</text>
        <text x="124" y="94" text-anchor="middle">file</text><text x="194" y="56" text-anchor="middle">setting</text>
      </svg></div>
    </div>
    <span class="flow-arrow" aria-hidden="true"></span>
    <div class="panel">
      <span class="step-n">4</span><b>Fixes, ready to merge</b>
      <div class="pic d-sort"><span class="d-bad">needs a fix → on a branch</span><span class="d-ok">still fine → cleared</span></div>
    </div>
  </div>`;
}

/** The receipt's picture: the change, the files built on the old version, and how they were sorted. */
function foundDiagram(p: PropagationView, rows: FindingRow[]) {
  const fix = rows.filter((f) => f.verdict === 'needs_change');
  const fine = rows.filter((f) => f.verdict === 'still_fine');
  const open = rows.filter((f) => f.verdict !== 'needs_change' && f.verdict !== 'still_fine');
  const list = (fs: FindingRow[]) => html`<ul>${fs.map((f) => html`<li><a href="/why?path=${encodeURIComponent(f.path)}"><code>${f.path}</code></a></li>`)}</ul>`;
  const box = (cls: string, tour: string, fs: FindingRow[], label: string) => html`<div class="bucket ${cls}" ${tour ? raw(`data-tour="${tour}"`) : ''}>
    <p class="count"><b>${fs.length}</b> ${label}</p>${list(fs)}</div>`;
  return html`<div class="found" data-tour="found">
    <p class="found-change">${fig(p.oldFigure, p.unit) || 'old'} → ${fig(p.newFigure, p.unit) || 'new'}</p>
    <div class="buckets">
      ${fix.length ? box('bad', 'bucket-fix', fix, fix.length === 1 ? 'file needs a fix' : 'files need a fix') : ''}
      ${fine.length ? box('ok', 'bucket-fine', fine, fine.length === 1 ? 'file is fine' : 'files are fine') : ''}
      ${open.length ? box('muted', '', open, 'for a person to check') : ''}
    </div>
  </div>`;
}

// The changes the demos were measured on (demo/payroll/PROTOCOL.md, test/change.test.ts). "Run the
// 1-minute demo" opens one of these rules with its form already filled in, so a first-time visitor
// previews a real change without typing. The figure is in rupees or dollars, as a person types it.
interface Suggestion { figure: number; citation: string; effectiveFrom?: string; reason: string }
const TOUR_SUGGEST: Record<string, Suggestion> = {
  'in-epf-ceiling': { figure: 25_000, citation: 'Union Cabinet decision of 16 September 2026 (notification pending)',
    effectiveFrom: '2026-09-16', reason: 'The government raised the EPF wage ceiling' },
  'in-cash-load': { figure: 10_000, citation: 'RBI draft Master Direction on PPIs, released 2026-04-22',
    effectiveFrom: '2026-11-14', reason: 'RBI draft cuts cash loading by 80%' },
  'us-flsa-salary': { figure: 844, citation: 'What-if: the vacated 2024 DOL salary level (29 CFR 541.600)',
    reason: 'Testing a return to the 2024 salary level' },
};
/** The rule the demo uses: the first official rule with a suggestion, in the Rules page's order. */
const demoRule = (rules: RuleRow[]) => rules.find((x) => x.status === 'final' && x.figure !== undefined && TOUR_SUGGEST[x.ruleId]);

/** The rule's wording with its old money figure swapped for the new one, so the wording never contradicts the figure. */
function withFigure(text: string, old: number | undefined, next: number, unit: string | undefined): string {
  const money = unit === 'paise' ? ['₹', 'en-IN'] : unit === 'cents' ? ['$', 'en-US'] : undefined;
  if (!money || old === undefined) return text;
  const say = (n: number) => money[0] + n.toLocaleString(money[1]);
  return text.split(say(old / 100)).join(say(next));
}

/** A figure field in the unit a person thinks in: ₹ or $ for money (stored in paise or cents). */
function figureInput(id: string, label: string, figure: number | undefined, unit: string | undefined, typed?: number) {
  const money = unit === 'paise' ? '₹' : unit === 'cents' ? '$' : '';
  const value = typed !== undefined ? String(typed) : figure === undefined ? '' : money ? String(figure / 100) : String(figure);
  const hint = money ? `in ${money === '₹' ? 'rupees' : 'dollars'}` : unit === 'percent' ? 'in percent' : unit && unit !== 'none' ? `in ${unit}` : '';
  return html`<label for="fig-${id}">${label}${hint ? html` <span class="small">(${hint})</span>` : ''}</label>
    <div class="money">${money ? html`<span>${money}</span>` : ''}<input id="fig-${id}" name="figure" type="number" step="any" value="${value}"></div>`;
}

export function webRoutes(db: Db, queue: PropagationQueue, memberId: string | undefined): Router {
  const r = express.Router();
  r.use('/static', express.static(path.join(here, 'public'), { maxAge: '1h' }));
  r.use('/static/vendor', express.static(path.join(here, '..', '..', 'node_modules', 'cytoscape', 'dist'), { maxAge: '1d' }));
  // Driver.js (MIT) draws the walkthrough's spotlight and popovers; served from the app, no CDN.
  r.use('/static/driver', express.static(path.join(here, '..', '..', 'node_modules', 'driver.js', 'dist'), { maxAge: '1d' }));
  r.use(express.urlencoded({ extended: false, limit: '20kb' }));

  const viewer = async (): Promise<Principal> => {
    if (!memberId) throw new NotAllowed('PREMISE_WEB_MEMBER is not set, so the web view has no member to act as.');
    const p = await one<Principal>(db.control(), CONTROL.principalById, { id: memberId }, { readOnly: true });
    if (!p) throw new NotAllowed(`Web member ${memberId} does not exist.`);
    return p;
  };
  const wrap = (fn: (req: Request, res: Response, who: Principal) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => { viewer().then((who) => fn(req, res, who)).catch(next); };

  // The walkthrough's entry point (Home's button, the header's link): the demo rule, its form
  // filled in. Without JavaScript it is still the whole demo, minus the popovers.
  r.get('/tour', wrap(async (_req, res, who) => {
    const d = demoRule(await run<RuleRow>(db.team(who.teamId), TEAM.listRules, {}, { readOnly: true }));
    res.redirect(303, d ? `/rules?try=${encodeURIComponent(d.ruleId)}#tour` : '/rules');
  }));

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
    const official = rules.filter((x) => x.status === 'final').length;
    const example = fig(rules.find((x) => x.status === 'final' && x.figure !== undefined)?.figure,
      rules.find((x) => x.status === 'final' && x.figure !== undefined)?.unit) || 'the old figure';
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const demo = demoRule(rules);
    const next = demo && TOUR_SUGGEST[demo.ruleId]!.figure;
    const demoTo = demo && next !== undefined
      ? fig(demo.unit === 'paise' || demo.unit === 'cents' ? Math.round(next * 100) : next, demo.unit) : '';
    const todo = [
      guesses.length ? html`<li><a href="/guesses"><b>${plural(guesses.length, 'number', 'numbers')} an AI guessed</b></a>
        <span class="muted">Check them.</span></li>` : '',
      open.length ? html`<li><a href="/tasks"><b>${plural(open.length, 'file', 'files')} to fix</b></a>
        <span class="muted">Already assigned.</span></li>` : '',
    ].filter(Boolean);
    res.send(page({ title: 'Home', who: who.name, active: '/', body: html`
      ${demo ? html`<div class="tour-offer" data-tour="offer" hidden>
        <p><b>New here?</b> See Premise work in 1 minute.</p>
        <a class="button primary" href="/tour">Take the tour</a>
        <button type="button" class="tour-offer-no">No thanks</button>
      </div>` : ''}
      <h1>When a rule changes, find the code it breaks</h1>
      <p class="lede">Premise remembers which rule each AI edit followed.</p>

      ${demo ? html`<section class="start">
        <div>
          <h2>See it in 1 minute</h2>
          <p class="start-change"><b>${demo.title}</b><span>${fig(demo.figure, demo.unit)} → ${demoTo}</span></p>
          <p class="small">A safe preview. Nothing gets assigned.</p>
        </div>
        <div class="start-go">
          <a class="button primary big" href="/tour">Run the demo</a>
          <a class="small" href="/rules">or change a rule yourself</a>
        </div>
      </section>` : html`<section class="start">
        <div>
          <h2>Try it</h2>
          <p>Change one of your ${official} rules. A preview is safe: nothing gets assigned.</p>
        </div>
        <a class="button primary big" href="/rules">Change a rule</a>
      </section>`}

      <h2>Waiting for you</h2>
      ${todo.length ? html`<ul class="todo">${todo}</ul>` : html`<p class="muted">Nothing right now.</p>`}

      <h2>How it works</h2>
      ${howItWorks(example)}

      <h2>Recent rule changes</h2>
      ${views.length ? html`<ul class="receipts">${views.map((p) => html`<li><a href="/receipt/${p.id}">${badge(p.dryRun ? 'muted' : 'warn', p.dryRun ? 'preview' : 'official')} ${summary(p)}</a></li>`)}</ul>`
        : html`<p class="muted">None yet.</p>`}
    ` }));
  }));

  // ── Rules ────────────────────────────────────────────────────────────────
  r.get('/rules', wrap(async (req, res, who) => {
    const g = db.team(who.teamId);
    const [all, reach] = await Promise.all([
      run<RuleRow>(g, TEAM.listRules, {}, { readOnly: true }),
      run<{ ruleId: string; direct: number; viaDerived: number }>(g, TEAM.blastRadius, {}, { readOnly: true }),
    ]);
    const files = new Map(reach.map((x) => [x.ruleId, x.direct + x.viaDerived]));
    // Agents' unconfirmed figures have their own page; this one is the team's official rules.
    const rules = all.filter((x) => x.status === 'final');
    const drafts = all.length - rules.length;
    // ?try=<rule> (from /tour): that rule's form opens filled in with its suggested change.
    const tryId = typeof req.query.try === 'string' && TOUR_SUGGEST[req.query.try] ? req.query.try : undefined;
    res.send(page({ title: 'Rules', who: who.name, active: '/rules', body: html`
      <h1>Your rules</h1>
      <p class="lede">Change a rule to see which files it breaks.
      ${drafts ? html` ${drafts} more wait in <a href="/guesses">Guesses</a>.` : ''}</p>
      ${rules.map((x) => {
        const declared = x.scopes.filter((s) => s.path && s.source === 'declared');
        const proposed = x.scopes.filter((s) => s.path && s.source === 'proposed');
        const n = files.get(x.ruleId) ?? 0;
        const s = x.ruleId === tryId && x.figure !== undefined ? TOUR_SUGGEST[x.ruleId] : undefined;
        return html`<article class="rule" id="rule-${x.ruleId}" ${s ? raw('data-tour="try"') : ''}>
          <header><span class="j">${x.jurisdiction}</span> <h2>${x.title}</h2></header>
          <div class="facts">
            <p class="figure">${fig(x.figure, x.unit) || 'no single figure'}</p>
            <p class="reach"><b>${n}</b> file${n === 1 ? '' : 's'} use it</p>
          </div>
          <details class="quiet"><summary>Details</summary>
            <p>${x.text}</p>
            <p class="small">Source: ${x.citation}. Since ${x.effectiveFrom}. Version ${x.n}. <a href="/audit/${x.ruleId}">Audit trail</a></p>
            ${proposed.length ? html`<p class="small"><b>Also used outside ${declared.map((s) => s.path).join(', ')}.</b> Add these so future edits get checked:</p>
              <ul class="plain">${proposed.map((s) => html`<li><form method="post" action="/rules/${x.ruleId}/accept-scope" class="inline">
                <input type="hidden" name="path" value="${s.path}"><code>${s.path}</code> <button>add</button></form></li>`)}</ul>` : ''}
          </details>
          <details class="act" ${s ? raw('open') : ''}><summary class="button primary">Change this rule</summary>
            <form method="post" action="/rules/${x.ruleId}/supersede" class="change">
              ${s ? html`<p class="filled">Already filled in. Just press Preview.</p>` : ''}
              ${figureInput(x.ruleId, 'New figure', x.figure, x.unit, s?.figure)}
              <details class="quiet more"><summary>Wording, source and date</summary>
                <label for="text-${x.ruleId}">Wording <span class="small">(the old figure in it is updated for you)</span></label><textarea id="text-${x.ruleId}" name="text" required maxlength="1000">${s ? withFigure(x.text, x.figure, s.figure, x.unit) : x.text}</textarea>
                <label for="cit-${x.ruleId}">Legal source</label><input id="cit-${x.ruleId}" name="citation" required maxlength="300" value="${s?.citation ?? x.citation}">
                <label for="eff-${x.ruleId}">In force from</label><input id="eff-${x.ruleId}" name="effectiveFrom" type="date" required value="${s?.effectiveFrom ?? x.effectiveFrom}">
                <label for="why-${x.ruleId}">Why it changed</label><input id="why-${x.ruleId}" name="reason" required maxlength="300" value="${s?.reason ?? 'The rule changed'}">
              </details>
              <input type="hidden" name="unit" value="${x.unit ?? ''}">
              ${x.figure !== undefined ? html`<input type="hidden" name="oldFigure" value="${x.figure}">` : ''}
              <div class="row">
                <button name="mode" value="draft" class="primary">Preview what it touches</button>
                ${who.role === 'compliance' ? html`<button name="mode" value="final">Make it official and assign fixes</button>` : ''}
              </div>
              <p class="small">Preview is safe. Nothing changes.</p>
            </form>
          </details>
        </article>`;
      })}
    ` }));
  }));

  r.post('/rules/:id/supersede', wrap(async (req, res, who) => {
    const b = req.body as Record<string, string>;
    const unit = (['paise', 'cents', 'percent', 'none'].includes(b.unit ?? '') ? b.unit : undefined) as 'paise' | 'cents' | undefined;
    // Money is typed in rupees or dollars (figureInput) and stored in paise or cents.
    const typed = b.figure ? Number.parseFloat(b.figure) : undefined;
    const figure = typed === undefined || !Number.isFinite(typed) ? undefined
      : Math.round(unit === 'paise' || unit === 'cents' ? typed * 100 : typed);
    // The wording is folded away on the form, so a money figure in it follows the new figure.
    const oldFigure = b.oldFigure ? Number.parseFloat(b.oldFigure) : undefined;
    const text = oldFigure !== undefined && Number.isFinite(oldFigure) && typed !== undefined && Number.isFinite(typed)
      ? withFigure(String(b.text ?? ''), oldFigure, typed, unit) : String(b.text ?? '');
    const s = await supersede(db, who, {
      ruleId: String(req.params.id), text: text.slice(0, 1000), figure: Number.isFinite(figure) ? figure : undefined, unit,
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
    const shown = (g: Guess) => guessFig(g) || 'no single figure';
    res.send(page({ title: 'Guessed figures', who: who.name, active: '/guesses', body: html`
      <h1>Numbers an AI guessed (${guesses.length})</h1>
      <p class="lede">The AI needed these numbers and found no record, so it wrote down its best guess. Check each one.</p>
      ${guesses.length ? guesses.map((g) => html`<article class="rule">
        <header><span class="j">${g.jurisdiction}</span> <h2>${g.title}</h2> ${badge('warn', 'not checked')}</header>
        <div class="facts">
          <p class="figure">${shown(g)}</p>
          <p class="reach">guessed by ${g.authorName ? `${g.authorName}'s AI` : 'an AI'} · <b>${files(g).length}</b> file${files(g).length === 1 ? '' : 's'} use it</p>
        </div>
        <details class="quiet"><summary>Details</summary>
          <p>${g.text}</p>
          <p class="small">Its source: ${g.citation}.</p>
          <p class="small">${files(g).map((p) => html`<a href="/why?path=${encodeURIComponent(p)}"><code>${p}</code></a> `)}</p>
        </details>
        ${who.role === 'compliance' ? html`<div class="row">
          <details><summary>Confirm it</summary>
            <form method="post" action="/guesses/${g.ruleId}/confirm" class="change">
              <label>The source you checked it against <input name="citation" required maxlength="300"
                value="${g.citation.replace(/^unverified:\s*from memory\s*[—-]\s*/i, '')}"></label>
              <button class="primary">Confirm ${shown(g)}</button>
            </form>
          </details>
          <details><summary>Correct it</summary>
            <form method="post" action="/rules/${g.ruleId}/supersede" class="change">
              <label>Correct text <textarea name="text" required maxlength="1000">${g.text}</textarea></label>
              ${figureInput(`g-${g.ruleId}`, 'Correct figure', g.figure, g.unit)}
              <label>Source <input name="citation" required maxlength="300" placeholder="Where the correct figure comes from"></label>
              <label>Effective from <input name="effectiveFrom" type="date" required value="${g.effectiveFrom}"></label>
              <input type="hidden" name="reason" value="Corrected an agent's guess">
              <input type="hidden" name="unit" value="${g.unit ?? ''}">
              <button name="mode" value="final" class="primary">Correct it and open tasks for these files</button>
            </form>
          </details>
        </div>` : html`<p class="muted">Only compliance can confirm or correct it.</p>`}
      </article>`) : html`<p class="muted">Nothing to check.</p>`}
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
    const checking = p.status !== 'done' && p.status !== 'failed';
    const read = rows.filter((f) => f.verdict).length;
    res.send(page({ title: 'Receipt', who: who.name, active: '', refresh: checking ? 2 : undefined, body: html`
      <h1>${p.dryRun ? 'Preview' : 'Rule changed'}: <span data-tour="rule-title">${p.title}</span></h1>
      ${p.status === 'done' ? html`<p class="lede">${p.dryRun ? 'Only a preview. Nothing was changed.' : `Fixes assigned, due ${p.effectiveFrom}.`}</p>` : ''}
      ${checking ? html`<p class="checking" data-tour="status" role="status"><span class="spin" aria-hidden="true"></span>
        ${rows.length ? `Checking files: ${read} of ${rows.length} done.` : 'Finding every file that uses the old rule…'}
        This page updates itself.</p>` : ''}
      ${p.status === 'failed' ? html`<div class="card failed" data-tour="failed" role="alert"><b>Premise couldn't finish.</b>
        Nothing was assigned. <a href="/rules">Try again</a>.</div>` : ''}
      ${p.status === 'done' ? foundDiagram(p, rows) : ''}
      ${(() => {
        // Only once every file is checked: a count taken mid-run would be wrong.
        const fixes = p.status === 'done' ? rows.filter((f) => f.verdict === 'needs_change' && f.patch).length : 0;
        return fixes ? html`<div class="card fix" data-tour="fix"><b>Fix all ${fixes} with one command</b>
          <pre class="cmd"><code>npx premise-fix ${p.id}</code></pre>
          <span class="small">The fixes go on a new branch for you to review. <a href="/receipt/${p.id}/fix.patch">Download them instead</a></span></div>` : '';
      })()}
      <details class="quiet"><summary>See each file and why</summary>
      <table>
        <thead><tr><th>File</th><th>How it's linked</th><th>Last changed by</th><th>AI check</th><th>Fix task</th></tr></thead>
        <tbody>${rows.map((f) => html`<tr>
          <td><a href="/why?path=${encodeURIComponent(f.path)}"><code>${f.path}</code></a></td>
          <td>${tierBadge(f.tier)}</td>
          <td>${f.owner ?? ''}</td>
          <td>${verdictBadge(f.verdict)}<div class="small">${f.reason ?? ''}</div>
              ${f.patch ? html`<details><summary>the proposed fix</summary><pre>${f.patch}</pre></details>` : ''}</td>
          <td>${f.taskId ? html`${f.taskStatus?.replace('_', ' ')}` : html`<span class="muted">—</span>`}</td>
        </tr>`)}</tbody>
      </table>
      <p class="small">Strongest link first: the AI looked the rule up; it was shown the rule; the file is in the rule's folders;
      the rule was looked up for another file; the file still has the old number.</p>
      </details>
    ` }));
  }));

  r.get('/receipt/:id/fix.patch', wrap(async (req, res, who) => {
    const set = await fixSet(db, who.teamId, String(req.params.id));
    if (!set || !set.files.length) return res.status(404).type('text/plain').send('No proposed fixes for this rule change.');
    res.attachment(`premise-${set.toId.replace('@', '-v')}.patch`).type('text/x-diff').send(set.files.map((f) => f.patch).join(''));
  }));

  // ── Why ──────────────────────────────────────────────────────────────────
  r.get('/why', wrap(async (req, res, who) => {
    const [files, guesses] = await Promise.all([
      run<{ path: string; changes: number }>(db.team(who.teamId), TEAM.listFiles, {}, { readOnly: true }),
      listGuesses(db, who.teamId),
    ]);
    const guessed = new Map(guesses.map((g) => [g.ruleId, guessFig(g)]));
    const p = typeof req.query.path === 'string' ? req.query.path : '';
    const paths = p ? await shortestToRegulators(db, who, p) : [];
    const w = p ? overlayPaths(await why(db, who, p), paths) : undefined;
    const regulator = new Map(paths.map((sp) => [sp.jurisdiction, sp.regulator]));
    const MARKET: Record<string, string> = { IN: 'India', US: 'United States', TEAM: 'Team convention' };
    const day = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    // One chain per rule: the latest change that relied on it, and how many there were.
    const byRule = new Map<string, { step: WhyStep; count: number }>();
    for (const st of w?.steps ?? []) {
      if (!st.ruleId) continue;
      const seen = byRule.get(st.ruleId);
      if (seen) seen.count++; else byRule.set(st.ruleId, { step: st, count: 1 });
    }
    // The graph's dots in the same words and colours as the rows above it.
    const said = new Map<string, { text: string; tone: string }>();
    for (const st of w?.steps ?? []) {
      if (!st.ruleId) continue;
      said.set(`version:${st.ruleId}@${st.n}`, {
        text: (st.status !== 'final' && guessed.get(st.ruleId)) || fig(st.figure, st.unit),
        tone: st.supersededBy.length ? 'changed' : st.status === 'final' ? 'ok' : 'warn',
      });
      for (const v of st.supersededBy) said.set(`version:${v}`, { text: `New version (v${v.split('@')[1]})`, tone: 'new' });
    }
    const TOOL: Record<string, string> = { 'claude-code': 'Claude Code', cursor: 'Cursor' };
    const words = (n: { id: string; kind: string; label: string }) => {
      if (n.kind === 'Change' && n.label.startsWith('change ')) return `AI edit, ${day(Date.parse(n.label.slice(7).replace(' ', 'T') + 'Z'))}`;
      if (n.kind === 'Session') { const t = n.label.split(' ')[0] ?? ''; return `${TOOL[t] ?? t} session`; }
      if (n.kind === 'RuleVersion') return said.get(n.id)?.text ?? n.label;
      if (n.kind === 'Jurisdiction') { const r = regulator.get(n.label); return (MARKET[n.label] ?? n.label) + (r ? ` · ${r}` : ''); }
      if (n.kind === 'ReviewTask') return n.label.replace(/^task /, 'Fix task, ');
      return n.label;
    };
    const graph = w && {
      nodes: w.nodes.map((n) => ({ ...n, text: words(n), tone: said.get(n.id)?.tone })),
      edges: w.edges,
    };
    res.send(page({ title: 'Why', who: who.name, active: '/why', body: html`
      <h1>Why is this file the way it is?</h1>
      <p class="lede">Pick a file. See which rules it follows, and who made them.</p>
      <form method="get" action="/why" class="inline">
        <label for="why-path" class="small">File</label>
        <select id="why-path" name="path" onchange="this.form.submit()"><option value="">Choose a file…</option>
          ${files.map((f) => html`<option value="${f.path}" ${f.path === p ? raw('selected') : ''}>${f.path}</option>`)}
        </select>
      </form>
      ${w ? html`
        ${byRule.size ? html`<h2 class="why-file"><code>${p}</code> follows ${byRule.size} rule${byRule.size === 1 ? '' : 's'}</h2>
        <ol class="chains" data-tour="chain">${[...byRule.values()].map(({ step: st, count }) => html`<li class="chain">
          <span class="link"><b>${st.member}</b>'s AI, ${day(st.at)}${count > 1 ? html` <span class="small">+${count - 1}</span>` : ''}</span>
          <span class="arrow" aria-hidden="true">→</span>
          <span class="link rule"><b>${st.title}</b>: ${(st.status !== 'final' && guessed.get(st.ruleId ?? '')) || fig(st.figure, st.unit)}
            ${st.status === 'final' ? '' : badge('warn', 'not checked')}
            ${st.supersededBy.length ? html`<span class="badge bad">changed since</span>` : ''}</span>
          <span class="arrow" aria-hidden="true">→</span>
          <span class="link market">${MARKET[st.jurisdiction ?? ''] ?? st.jurisdiction}${regulator.get(st.jurisdiction ?? '') ? html` · ${regulator.get(st.jurisdiction ?? '')}` : ''}</span>
        </li>`)}</ol>` : html`<p class="muted">No AI change to this file used a rule.</p>`}
        ${w.tasks.length ? html`<h2>Fixes for this file</h2><ul class="plain">${w.tasks.map((t) => html`<li>
          ${t.status === 'resolved' ? badge('ok', 'done') : t.status === 'proposed_clear' ? badge('muted', 'probably fine') : badge('warn', 'to fix')}
          ${t.assignee}, due ${t.due}${t.verdict ? html` ${verdictBadge(t.verdict)}` : ''}</li>`)}</ul>` : ''}
        <details class="quiet graph-details" open>
          <summary>The same thing, as a graph in FalkorDB</summary>
          <ul class="legend small">
            <li>Figures:</li><li><i class="dot ok"></i>Checked</li><li><i class="dot warn"></i>Not checked</li>
            <li><i class="dot changed"></i>Changed since</li><li><i class="thick"></i>Shortest path to the regulator (<code>algo.SPpaths</code>)</li>
          </ul>
          <div class="graph-scroll"><div class="graph-wrap" data-tour="graph">
            <div class="graph-head" aria-hidden="true">
              <span>File</span><span><code>← TO</code>Edited by</span><span><code>RELIED_ON →</code>Figure it used</span>
              <span><code>OF →</code>Rule</span><span><code>APPLIES_IN →</code>Regulator</span>
            </div>
            <div id="graph" class="graph" aria-label="The path from this file to the rules its changes relied on"></div>
            <div class="graph-spots" aria-hidden="true"><i data-tour="graph-who"></i><i data-tour="graph-rules"></i></div>
          </div></div>
          <details class="quiet"><summary>Show as text</summary><pre class="why">${w.text}</pre></details>
        </details>
        <script type="application/json" id="why-data">${raw(JSON.stringify(graph).replace(/</g, '\\u003c'))}</script>
      ` : ''}
    `, script: w ? `<script src="/static/vendor/cytoscape.min.js"></script><script src="/static/app.js?v=${ASSET_V}"></script>` : undefined }));
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
    const groups = [['open', 'To fix'], ['proposed_clear', 'Probably fine: confirm'], ['resolved', 'Done']] as const;
    res.send(page({ title: 'Tasks', who: who.name, active: '/tasks', body: html`
      <h1>Files to fix</h1>
      <p class="lede">Each goes to whoever's AI last changed it, due when the new rule starts.</p>
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
