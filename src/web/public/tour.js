// The 1-minute walkthrough, drawn by Driver.js (MIT). It starts only when someone asks for it:
// Home's "Run the 1-minute demo" and the header's "Take the 1-minute tour" both go to /tour,
// which opens the demo rule with its form already filled in (/rules?try=<rule>#tour).
// Nine steps: preview the change, what it found, the one-command fix, then one file traced to
// its regulator, and that same trace walked through as a graph. Every step closes with ×, Esc or "Skip tour", and closing ends the tour. Progress
// lives in sessionStorage, for this visit only, and is saved only when the step's own link or
// button is clicked, so a person who wanders off is not dragged back in. While Premise is still
// checking, the receipt's own progress line does the talking and the tour waits.
// Home offers the tour once: a dismissible line, never a tour that starts by itself. Taking,
// skipping or finishing it is remembered in localStorage; raising TOUR_VERSION offers it again.
// ?tour=reset on any page forgets all of that and starts the tour.
(function () {
  var KEY = 'premise-tour-v4';
  var STATUS = 'premise.tour';
  var TOUR_VERSION = 1;
  var store = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* private window */ } },
    end: function () { try { ['', '-fix', '-rule'].forEach(function (k) { sessionStorage.removeItem(KEY + k); }); } catch (e) { /* ignore */ } },
  };
  // 'started' | 'skipped' | 'completed' for this TOUR_VERSION, or null if the offer is still open.
  var status = {
    get: function () {
      try { var s = JSON.parse(localStorage.getItem(STATUS) || 'null'); return s && s.version === TOUR_VERSION ? s.status : null; }
      catch (e) { return null; }
    },
    set: function (s) { try { localStorage.setItem(STATUS, JSON.stringify({ status: s, version: TOUR_VERSION })); } catch (e) { /* blocked storage */ } },
  };

  if (new URLSearchParams(location.search).get('tour') === 'reset') {
    try { localStorage.removeItem(STATUS); } catch (e) { /* ignore */ }
    store.end();
    location.replace('/tour');
    return;
  }

  // Every way into the tour (Home's offer and button, the header's link) counts as taking it.
  document.querySelectorAll('a[href="/tour"]').forEach(function (a) {
    a.addEventListener('click', function () { if (!status.get()) status.set('started'); });
  });

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var page = document.body.getAttribute('data-page');

  var offer = $('[data-tour="offer"]');
  if (offer && !status.get()) {
    offer.hidden = false;
    $('.tour-offer-no', offer).addEventListener('click', function () { status.set('skipped'); offer.hidden = true; });
  }

  if (!window.driver || !window.driver.js) return;
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var narrow = matchMedia('(max-width: 640px)').matches;
  var plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };
  // The Why page's steps (the path, then the graph), so every page can count to the end.
  var WHY_STEPS = 5;
  var total = function (fix) { return (fix ? 4 : 3) + WHY_STEPS; };

  // A pulsing dot on the thing to click.
  var beacon;
  function placeBeacon(el) {
    if (!beacon) { beacon = document.createElement('span'); beacon.className = 'tour-beacon'; beacon.setAttribute('aria-hidden', 'true'); document.body.appendChild(beacon); }
    var r = el.getBoundingClientRect();
    beacon.style.top = (r.top - 7) + 'px';
    beacon.style.left = (r.right - 7) + 'px';
    beacon.hidden = false;
  }
  function hideBeacon() { if (beacon) beacon.hidden = true; }

  // Steps: { el, title, text, click (the element to click, which loads the next page), then (what
  // that click saves for the next page), show/hide (run while the step is up), last }.
  // `n` and `total` number them across pages; the fix step is skipped when there is no fix.
  // Ending it any way but the last step's Done (×, Esc, Skip tour) records it as skipped.
  // The ending is handled here, not in Driver's onDestroyed: Driver skips that hook when the tour
  // is closed during a step's 0.4 s highlight animation.
  function run(steps, n, total) {
    // Next waits for the step's highlight to finish (a click before then is held, not lost):
    // moving on mid-animation leaves Driver's overlay blocking the following step's link.
    var target = null, ready = false, pending = null;
    var follow = function () { if (target && beacon && !beacon.hidden) placeBeacon(target); };
    var end = function (how) {
      hideBeacon();
      steps.forEach(function (s) { if (s.hide) s.hide(); });
      window.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
      store.end();
      status.set(how);
      drv.destroy();
    };
    var drv = window.driver.js.driver({
      animate: !reduce,
      smoothScroll: !reduce,
      allowClose: true,
      allowKeyboardControl: true,
      overlayClickBehavior: function () { /* only × and Esc end it, so a stray click does not */ },
      overlayColor: '#0d1611',
      overlayOpacity: 0.62,
      stagePadding: 8,
      stageRadius: 10,
      popoverOffset: 14,
      showProgress: true,
      onDestroyStarted: function () { end('skipped'); }, // × and Esc
      steps: steps.map(function (s, i) {
        var num = n + i;
        var action = !!s.click;
        return {
          element: s.el,
          disableActiveInteraction: !action,
          onHighlighted: function () {
            ready = true;
            if (s.show) s.show();
            if (pending) { var go = pending; pending = null; setTimeout(go, 0); return; }
            if (!action) {
              target = null; hideBeacon();
              setTimeout(function () { var next = $('.driver-popover-next-btn'); if (next) next.focus({ preventScroll: true }); }, 50);
              return;
            }
            target = s.click;
            // On a phone, lift the thing to click above the bottom sheet so it is not hidden under it.
            var sheet = narrow && $('.driver-popover');
            var under = sheet ? target.getBoundingClientRect().bottom - (sheet.getBoundingClientRect().top - 16) : 0;
            if (under > 0) window.scrollBy(0, under);
            placeBeacon(target);
            target.focus({ preventScroll: true });
          },
          onDeselected: function () { hideBeacon(); if (s.hide) s.hide(); },
          popover: {
            title: '<span class="sr-only">Step ' + num + ' of ' + total + '. </span>' + s.title,
            description: s.text,
            side: narrow ? 'bottom' : (s.side || 'bottom'),
            align: 'start',
            showButtons: action ? ['close'] : ['next', 'close'],
            nextBtnText: s.last ? 'Done' : 'Next',
            doneBtnText: s.last ? 'Done' : 'Next',
            progressText: num + ' of ' + total,
            popoverClass: 'premise-tour' + (narrow ? ' tour-sheet' : '') + (action ? ' tour-action' : ''),
            onPopoverRender: function (pop) {
              if (!s.last) {
                var skip = document.createElement('button');
                skip.type = 'button'; skip.className = 'tour-skip'; skip.textContent = 'Skip tour';
                skip.setAttribute('aria-label', 'Skip the tour');
                skip.addEventListener('click', function () { end('skipped'); });
                pop.footerButtons.before(skip);
              }
              if (!action) return;
              var hint = document.createElement('p'); hint.className = 'tour-hint';
              hint.textContent = s.hint;
              pop.description.after(hint);
            },
            // Next and the → key: an action step only moves on when its target is clicked.
            onNextClick: function () {
              if (action) return;
              var go = function () { ready = false; if (i + 1 < steps.length) drv.moveNext(); else end('completed'); };
              if (ready) go(); else pending = go;
            },
          },
        };
      }),
    });
    steps.forEach(function (s) {
      if (s.click) s.click.addEventListener('click', function () { hideBeacon(); if (s.then) s.then(); }, { once: true });
    });
    window.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    drv.drive();
  }

  var state = store.get(KEY);

  // ── 1. Rules: the demo rule, filled in. Clicking Preview submits the real form.
  if (page === 'rules') {
    var card = $('[data-tour="try"]');
    if (location.hash === '#tour' && card) {
      history.replaceState(null, '', location.pathname + location.search);
      store.end();
      var input = $('input[name="figure"]', card);
      var symbol = $('.money span', card);
      var from = $('.figure', card).textContent.trim();
      var to = (symbol ? symbol.textContent : '') + Number(input.value).toLocaleString(symbol && symbol.textContent === '$' ? 'en-US' : 'en-IN');
      run([{
        el: $('form.change', card), click: $('button[value="draft"]', card), side: 'right',
        title: 'Preview a law change',
        text: 'Already filled in: <b>' + from + ' → ' + to + '</b>. A preview is safe. Nothing changes.',
        hint: 'Click "Preview what it touches".',
        then: function () { store.set(KEY, 'receipt'); },
      }], 1, total(true));
    }
    return;
  }

  // ── 2–4. Receipt: what the change found, the fix, and a file to follow.
  // 'receipt' is saved by the Preview click; the first receipt page then claims it as its own, so
  // that a different receipt opened later in the visit does not pick the tour up.
  var here = 'receipt:' + location.pathname;
  if (page === 'receipt' && (state === 'receipt' || state === here)) {
    if ($('[data-tour="failed"]')) { store.end(); return; } // the page says what went wrong
    var found = $('[data-tour="found"]');
    // Still checking: the page refreshes and the tour picks up when it is done.
    if (!found) { store.set(KEY, here); return; }
    var count = function (sel) { var b = $(sel); return b ? b.querySelectorAll('li').length : 0; };
    var bad = count('[data-tour="bucket-fix"]'), ok = count('[data-tour="bucket-fine"]');
    var title, text;
    if (bad) {
      title = plural(bad, 'file needs', 'files need') + ' a fix' + (ok ? ', ' + plural(ok, 'is', 'are') + ' still fine' : '');
      text = 'Premise found every file that uses the old rule.' + (ok ? ' The fine ones don\'t hold the number themselves.' : '');
    } else if (ok) {
      title = 'No file needs a fix';
      text = plural(ok, 'file uses', 'files use') + ' the old rule, but none hold the number themselves. Nothing to change.';
    } else {
      var open = count('.found .bucket.muted');
      title = plural(open, 'file', 'files') + ' for a person to check';
      text = 'Premise found them, but the AI check couldn\'t run, so a person looks at them.';
    }
    var fix = $('[data-tour="fix"]');
    var link = $('[data-tour="bucket-fix"] a') || $('.found .bucket a');
    var steps = [{ el: found, title: title, text: text, last: !fix && !link }];
    if (fix) steps.push({ el: fix, side: 'top', title: 'Fix them all at once',
      text: 'One command puts every fix on a new branch. Nothing is merged for you.', last: !link });
    if (link) steps.push({ el: link.closest('.bucket'), click: link,
      title: 'Trace a file', text: 'See who changed it, which rule it used, and who made that rule.',
      hint: 'Click a file name.', then: function () { store.set(KEY, 'why'); } });
    store.end();
    store.set(KEY + '-fix', fix ? '1' : '0');
    store.set(KEY + '-rule', ($('[data-tour="rule-title"]') || {}).textContent || '');
    run(steps, 2, total(!!fix));
    return;
  }

  // ── 5–9. Why: the path in words, then the same path as a graph, column by column.
  if (page === 'why' && state === 'why') {
    // The one path for the rule that was just changed, not every rule the file was built on.
    var rule = store.get(KEY + '-rule');
    var chains = [].slice.call(document.querySelectorAll('[data-tour="chain"] > li'));
    var chain = chains.filter(function (li) { return rule && li.textContent.indexOf(rule) >= 0; })[0] || chains[0];
    if (!chain) { store.end(); return; }
    var withFix = store.get(KEY + '-fix') !== '0';
    store.end();
    var graph = $('[data-tour="graph"]');
    var why = [{
      el: chain, last: !graph,
      title: 'This file, traced',
      text: 'Who changed this file, which rule it used, and who made that rule.',
    }];
    if (graph) why.push({
      el: graph, side: 'top',
      title: 'The same trace, as a graph',
      text: 'This is how Premise stores it in FalkorDB. Each dot is a record, each line a link. Read it from left to right.',
    }, {
      el: $('[data-tour="graph-who"]'), side: 'right',
      title: 'Who changed it',
      text: 'The file, the AI edit that changed it, the session it came from and the person who ran it. Premise saves these while the AI works.',
    }, {
      el: $('[data-tour="graph-rules"]'), side: 'left',
      title: 'Which rules it used, and who made them',
      text: 'Each figure the AI relied on, the rule it comes from, and the regulator that sets that rule. Green is checked, orange is not checked yet, red has changed since.',
    }, {
      el: graph, side: 'top', last: true,
      show: function () { if (window.premiseGraph) window.premiseGraph.focusPath(true); },
      hide: function () { if (window.premiseGraph) window.premiseGraph.focusPath(false); },
      title: 'The thick line',
      text: 'FalkorDB\'s shortest-path search finds the route from this file to its regulator. When a rule changes, Premise follows these links back to every file that used it.'
        + '<br><a href="/guesses">Next: numbers an AI guessed →</a>',
    });
    run(why, total(withFix) - why.length + 1, total(withFix));
  }
})();

// Any rule-change form: one submission only. Starting a check takes a few seconds, and a second
// click would queue a second check. The button is changed after the browser has read the form,
// so the button that was clicked (preview or official) is still the one submitted.
(function () {
  document.querySelectorAll('form.change').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (form.dataset.sent) { e.preventDefault(); return; }
      form.dataset.sent = '1';
      var by = e.submitter;
      setTimeout(function () {
        form.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
        if (by) { by.dataset.label = by.textContent; by.textContent = 'Starting…'; }
        form.setAttribute('aria-busy', 'true');
      }, 0);
    });
  });
  // Back to this page from the receipt: the form is usable again.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    document.querySelectorAll('form.change[data-sent]').forEach(function (form) {
      delete form.dataset.sent;
      form.removeAttribute('aria-busy');
      form.querySelectorAll('button').forEach(function (b) {
        b.disabled = false;
        if (b.dataset.label) { b.textContent = b.dataset.label; delete b.dataset.label; }
      });
    });
  });
})();
