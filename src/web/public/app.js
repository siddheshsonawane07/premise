// Draws the why-path from the nodes and edges the server returned (STRICT 4.4).
(function () {
  var el = document.getElementById('graph');
  var data = document.getElementById('why-data');
  if (!el || !data || !window.cytoscape) return;
  var g = JSON.parse(data.textContent);
  var css = getComputedStyle(document.documentElement);
  var v = function (n) { return css.getPropertyValue(n).trim(); };
  var colour = {
    File: v('--fg'), Change: v('--muted'), Session: v('--muted'), Member: v('--ok'),
    RuleVersion: v('--accent'), Rule: v('--accent'), Jurisdiction: v('--warn'),
    ReviewTask: v('--bad'), Verdict: v('--asked'),
  };
  var tierColour = { asked: v('--asked'), shown: v('--shown'), in_scope: v('--in-scope') };
  window.cytoscape({
    container: el,
    elements: g.nodes.map(function (n) { return { data: { id: n.id, label: n.kind + '\n' + n.label, kind: n.kind } }; })
      .concat(g.edges.map(function (e, i) {
        return { data: { id: 'e' + i, source: e.from, target: e.to, label: e.label ? e.type + ' {' + e.label + '}' : e.type, tier: e.label || '' } };
      })),
    layout: { name: 'breadthfirst', directed: true, spacingFactor: 1.15, padding: 20 },
    style: [
      { selector: 'node', style: {
        'label': 'data(label)', 'text-wrap': 'wrap', 'text-max-width': 150, 'font-size': 10, 'color': v('--fg'),
        'text-valign': 'bottom', 'text-margin-y': 4, 'width': 18, 'height': 18,
        'background-color': function (n) { return colour[n.data('kind')] || v('--muted'); } } },
      { selector: 'edge', style: {
        'label': 'data(label)', 'font-size': 9, 'color': v('--muted'), 'text-rotation': 'autorotate',
        'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'width': 1.5,
        'line-color': function (e) { return tierColour[e.data('tier')] || v('--line'); },
        'target-arrow-color': function (e) { return tierColour[e.data('tier')] || v('--line'); } } },
    ],
    wheelSensitivity: 0.2,
  });
})();
