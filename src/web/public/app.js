// Draws the why-path from the nodes and edges the server returned (STRICT 4.4), in five fixed
// columns that read left to right: file, the edit and who made it, the figure it used, the rule,
// the regulator. Each rule gets its own row, and the shortest path (algo.SPpaths) is laid on the
// middle row so it reads as one straight line. TO, RELIED_ON, OF and APPLIES_IN are named once in
// the column headings; any other link is named on its line; every line names itself on hover.
(function () {
  var el = document.getElementById('graph');
  var data = document.getElementById('why-data');
  if (!el || !data || !window.cytoscape) return;
  var g = JSON.parse(data.textContent);
  var css = getComputedStyle(document.documentElement);
  var v = function (n) { return css.getPropertyValue(n).trim(); };
  var COL = { File: 0, ReviewTask: 0, Verdict: 0, Change: 1, Session: 1, Member: 1, RuleVersion: 2, Rule: 3, Jurisdiction: 4 };
  var HEADED = { TO: 1, RELIED_ON: 1, OF: 1, APPLIES_IN: 1 };
  var ROW = 70, TOP = 18;

  var byId = {};
  g.nodes.forEach(function (n) { byId[n.id] = n; });
  var kind = function (k) { return g.nodes.filter(function (n) { return n.kind === k; }); };
  var links = function (type, end, id) { return g.edges.filter(function (e) { return e.type === type && e[end] === id; }); };
  var row = {}, next = 0;
  var put = function (id) { if (!(id in row)) row[id] = next++; };

  // Rule versions: each followed by the versions that replaced it; the group on the shortest path
  // goes in the middle.
  var newer = {};
  g.edges.forEach(function (e) { if (e.type === 'SUPERSEDES') newer[e.from] = true; });
  var groups = kind('RuleVersion').filter(function (n) { return !newer[n.id]; }).map(function (n) {
    return [n.id].concat(links('SUPERSEDES', 'to', n.id).map(function (e) { return e.from; }));
  });
  var sp = groups.filter(function (gr) { return byId[gr[0]].sp; })[0];
  if (sp) { groups.splice(groups.indexOf(sp), 1); groups.splice(Math.floor(groups.length / 2), 0, sp); }
  groups.forEach(function (gr) { gr.forEach(put); });
  kind('RuleVersion').forEach(function (n) { put(n.id); });

  // A rule sits level with its first version; a rule reached only through another rule goes below.
  kind('Rule').forEach(function (n) {
    var rs = links('OF', 'to', n.id).map(function (e) { return row[e.from]; });
    if (rs.length) row[n.id] = Math.min.apply(null, rs);
  });
  kind('Rule').forEach(function (n) { put(n.id); });
  var rows = Math.max(next, 1);

  // A regulator sits level with its rule on the shortest path, else in the middle of its rules.
  kind('Jurisdiction').forEach(function (n) {
    var rules = links('APPLIES_IN', 'to', n.id).map(function (e) { return byId[e.from]; }).filter(Boolean);
    var on = rules.filter(function (r) { return r.sp; })[0];
    if (on) row[n.id] = row[on.id];
    else if (rules.length) row[n.id] = rules.reduce(function (s, r) { return s + row[r.id]; }, 0) / rules.length;
    else put(n.id);
  });

  // The edits: the one on the shortest path level with its rule, the others around it; then the
  // sessions and people below them. The file sits level with that edit, its fix tasks below it.
  var middle = sp ? row[sp[0]] : (rows - 1) / 2;
  var changes = kind('Change').sort(function (a, b) { return (b.sp ? 1 : 0) - (a.sp ? 1 : 0); });
  changes.forEach(function (n, i) { row[n.id] = middle + (i % 2 ? (i + 1) / 2 : -i / 2); });
  var below = changes.reduce(function (m, n) { return Math.max(m, row[n.id]); }, middle);
  kind('Session').concat(kind('Member')).forEach(function (n) { row[n.id] = ++below; });
  var file = kind('File')[0];
  var fileRow = changes.length ? row[changes[0].id] : middle;
  if (file) row[file.id] = fileRow;
  kind('ReviewTask').concat(kind('Verdict')).forEach(function (n, i) { row[n.id] = fileRow + 1 + i; });
  g.nodes.forEach(function (n) { put(n.id); });

  var ys = g.nodes.map(function (n) { return row[n.id]; });
  var low = Math.min.apply(null, ys), high = Math.max.apply(null, ys);
  el.style.height = (TOP + (high - low + 1) * ROW) + 'px';

  var tone = { ok: v('--ok'), warn: v('--warn'), changed: v('--bad'), new: v('--muted') };
  // Only the figures carry colour (checked, not checked, changed since), as in the legend.
  var colour = { File: v('--fg'), Change: v('--fg'), Rule: v('--fg'), Jurisdiction: v('--fg'), ReviewTask: v('--bad') };
  var width = function () { return el.clientWidth / 5; };
  var place = function (n) {
    var c = COL[n.data('kind')]; if (c === undefined) c = 2;
    return { x: (c + 0.5) * width(), y: TOP + 8 + (row[n.id()] - low) * ROW };
  };

  var cy = window.cytoscape({
    container: el,
    elements: g.nodes.map(function (n) {
      return { data: { id: n.id, text: n.text || n.label, kind: n.kind, tone: n.tone || '', sp: !!n.sp } };
    }).concat(g.edges.map(function (e, i) {
      return { data: { id: 'e' + i, source: e.from, target: e.to, type: e.type,
        name: e.label ? e.type + ' {' + e.label + '}' : e.type, headed: !!HEADED[e.type], sp: !!e.sp } };
    })),
    layout: { name: 'preset', fit: false },
    zoom: 1, pan: { x: 0, y: 0 },
    userZoomingEnabled: false, userPanningEnabled: false, boxSelectionEnabled: false, autoungrabify: true,
    style: [
      { selector: 'node', style: {
        'label': 'data(text)', 'text-wrap': 'wrap', 'text-max-width': width() - 24,
        'font-family': v('--font-read'), 'font-size': 12.5, 'line-height': 1.3, 'color': v('--fg'),
        'text-valign': 'bottom', 'text-margin-y': 6, 'width': 13, 'height': 13,
        'text-background-color': v('--card'), 'text-background-opacity': 0.92, 'text-background-padding': 2,
        'background-color': function (n) { return tone[n.data('tone')] || colour[n.data('kind')] || v('--muted'); } } },
      { selector: 'node[kind = "File"]', style: { 'shape': 'round-rectangle', 'font-family': v('--mono'), 'font-size': 12 } },
      { selector: 'node[kind = "Jurisdiction"]', style: { 'shape': 'diamond', 'width': 17, 'height': 17 } },
      { selector: 'node[tone = "new"]', style: { 'background-opacity': 0, 'border-width': 2, 'border-color': v('--muted'), 'border-style': 'dashed' } },
      { selector: 'node[?sp]', style: { 'width': 17, 'height': 17, 'font-weight': 500 } },
      { selector: 'edge', style: {
        'curve-style': 'straight', 'width': 1.5, 'line-color': v('--muted'), 'line-opacity': 0.4,
        'target-arrow-shape': 'triangle', 'target-arrow-color': v('--muted'), 'arrow-scale': 0.8,
        'font-family': v('--mono'), 'font-size': 10, 'color': v('--muted'),
        'text-background-color': v('--card'), 'text-background-opacity': 1, 'text-background-padding': 2 } },
      { selector: 'edge[!headed]', style: { 'label': 'data(type)', 'line-style': 'dashed' } },
      { selector: 'edge[?sp]', style: { 'width': 4, 'line-color': v('--accent'), 'line-opacity': 1, 'target-arrow-color': v('--accent'), 'z-index': 10 } },
      { selector: 'edge.hover', style: { 'label': 'data(name)', 'line-opacity': 1, 'z-index': 20 } },
      { selector: '.faded', style: { 'opacity': 0.15 } },
    ],
  });
  cy.nodes().positions(place);
  cy.on('mouseover', 'edge', function (e) { e.target.addClass('hover'); });
  cy.on('mouseout', 'edge', function (e) { e.target.removeClass('hover'); });
  window.addEventListener('resize', function () {
    cy.resize();
    cy.style().selector('node').style('text-max-width', width() - 24).update();
    cy.nodes().positions(place);
  });

  // For the tour: fade everything but the shortest path, and back.
  window.premiseGraph = {
    focusPath: function (on) { cy.elements().filter(function (x) { return !x.data('sp'); }).toggleClass('faded', !!on); },
  };
})();
