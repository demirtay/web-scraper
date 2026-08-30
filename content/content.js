/**
 * content.js
 * Runs in the page. Owns the element-picking UI (hover outline + naming
 * panel, both rendered inside a shadow root so page CSS can't interfere)
 * and answers messages from the popup:
 *   - START_PICK: enter selection mode (purpose: 'column' [default] or
 *     'next-button' — V1.3 reuses this exact same picker for selecting a
 *     pagination "Next" control, see resolveNextButtonInfo/
 *     renderNextButtonPanel below)
 *   - RUN_EXTRACTION: run the stored columns against the live page
 *
 * The popup closes as soon as the user clicks anywhere on the page (normal
 * browser behavior for extension popups), so once picking starts this
 * script drives the whole flow on its own and writes the new column
 * straight to chrome.storage.local (or, for a next-button pick, to
 * chrome.storage.session — see below). The popup simply re-reads storage
 * the next time it opens.
 *
 * Depends on WSStorage (utils/storage.js) and WSScraper/WSSelector
 * (content/scraper.js, content/selector.js), all injected before this file.
 * Auto Scroll / Multi-page run orchestration lives entirely in
 * content/pagination.js, which registers its own separate
 * chrome.runtime.onMessage listener — this file and its picking behavior
 * are otherwise unchanged from V1.2.
 *
 * BUG FIX — VISUAL ELEMENT PICKER (real Etsy bug: clicking a link during
 * picker mode navigated the page instead of being captured): picker mode
 * now works via a full-viewport transparent "glass pane" overlay
 * (overlayEl) that owns every pointer event for the duration of picking,
 * rather than a document-level capture-phase listener racing the page's
 * own (already-registered, possibly earlier) listeners — see
 * resolveOverlayTarget()'s own header comment for the complete root-cause
 * explanation and why only this approach can structurally guarantee the
 * underlying page never sees the event at all. Applies identically to
 * every pick purpose this file supports ('column', 'next-button',
 * 'detail-field', 'live-detail-field') — one shared mechanism, fixed once.
 */
(function () {
  'use strict';

  // Guard against being injected twice into the same page.
  if (window.__wsContentInjected) return;
  window.__wsContentInjected = true;

  var LOG_PREFIX = '[Web Scraper]';

  // Defensive fallback for any environment without a real paint loop
  // (some automated-testing DOM environments don't implement it) — real
  // Chrome always has requestAnimationFrame, so this branch never runs
  // there; it exists purely so the mousemove throttle below degrades
  // gracefully instead of throwing.
  var raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function (cb) { return setTimeout(cb, 16); };

  var pickModeActive = false;
  var pickPurpose = 'column'; // 'column' | 'next-button' | 'detail-field' | 'live-detail-field'
  var pickTargetHostname = null; // V1.18: which LIST page's Deep Scraping config a 'detail-field'/'live-detail-field' pick stages into — see enterPickMode

  /** DETAIL ENRICHMENT (VERİ/SONUÇ/DETAY flow): 'live-detail-field' is a
   * second, independent detail-field pick purpose — behaviorally
   * identical to the existing V1.18 'detail-field' purpose (same picker
   * UI, same panel, same {name/selector/attribute/multiple} shape) but
   * staged under its OWN session-storage key prefix, so a pick made from
   * the new DETAY tab can never collide with (or get silently consumed
   * by) the older, still-fully-working Advanced "Deep Scraping" panel's
   * own staging area, and vice versa — both can coexist on the same
   * hostname without interfering with each other. Nothing about the
   * existing 'detail-field' purpose's own behavior changes here. */
  function isDetailPickPurpose(purpose) { return purpose === 'detail-field' || purpose === 'live-detail-field'; }
  function detailStagingKeyPrefix(purpose) { return purpose === 'live-detail-field' ? 'ws_live_detail_field_picks::' : 'ws_detail_field_picks::'; }
  var hoveredEl = null;
  var shadowHost, shadowRoot, highlightEl, bannerEl, bannerTextEl, panelEl, hoverLabelEl, overlayEl;
  var testerDebounceTimer = null; // V1.17: the current panel's live-selector-tester debounce handle, if any

  function hostname() {
    return location.hostname;
  }

  /**
   * BUG FIX — DETAIL VISUAL ELEMENT PICKER (real bug, confirmed via
   * manual testing on a real Etsy listing page): the picker used to
   * listen for mousemove/click on `document` itself (capture phase) and
   * rely on preventDefault()/stopPropagation()/stopImmediatePropagation()
   * inside that listener to stop the page's own click behavior (link
   * navigation, button activation, the site's own click handlers). That
   * only works if OUR listener is guaranteed to run, and to run, BEFORE
   * anything on the page can act on the event — which capture-phase
   * registration order does NOT guarantee against a real, already-loaded
   * page: a site's own capture-phase listener registered on `window` (a
   * shallower node than `document` in the propagation path — window is
   * visited before document during capture) or on `document` itself
   * EARLIER than ours (our listener is only ever added long after page
   * load, when the user actually clicks "Pick a Field" — every one of
   * the page's own listeners was already registered before that) can run
   * first and call its own stopPropagation(), which prevents our
   * later-registered `document` listener from ever firing at all — our
   * own preventDefault() call never even executes. This is exactly what
   * a real, non-trivial site like Etsy was observed doing: clicking a
   * link/nested element during picker mode navigated normally, and
   * ClickScrape never saw the click.
   *
   * THE FIX: never let the real page element receive the event AT ALL.
   * overlayEl (see ensureUI()) is a full-viewport, transparent,
   * `position:fixed` div with the highest z-index this file ever uses,
   * shown only while picker mode is active — the BROWSER's own
   * hit-testing resolves IT as the target of every pointer event over
   * the viewport, structurally, before any JavaScript ever runs, so no
   * page listener — regardless of where or when it was registered — can
   * ever see the event. This is the same "glass pane" technique
   * browser DevTools' own element inspector uses, and it is the only
   * approach that can genuinely guarantee "website click handlers must
   * NOT run" rather than merely "hopefully run after ours does".
   *
   * Since the event's own target/composedPath is now always just this
   * file's own overlay (never anything on the real page), the previous
   * `event.composedPath()`-based resolution has nothing useful left to
   * resolve — the REAL element under the cursor is found geometrically
   * instead, via `document.elementsFromPoint()`, which (like
   * composedPath() before it) operates on the fully flattened/composed
   * tree and so still correctly reaches into any open shadow root
   * (including nested ones) exactly as the original Reddit
   * <shreddit-post> fix required — this preserves that fix's own
   * guarantee, just via geometry instead of event-path inspection.
   * `elementsFromPoint` returns every element at that point, topmost
   * first — index 0 is always this file's own overlay (it's always the
   * topmost thing while shown), so the first entry that ISN'T the
   * overlay (or its own host, defensively) is the real, intended target.
   */
  function resolveOverlayTarget(e) {
    if (typeof document.elementsFromPoint !== 'function') return null;
    var stack = document.elementsFromPoint(e.clientX, e.clientY);
    for (var i = 0; i < stack.length; i++) {
      var el = stack[i];
      if (el && el.nodeType === 1 && el !== overlayEl && el !== shadowHost) return el;
    }
    return null;
  }

  function ensureUI() {
    if (shadowHost) return;

    shadowHost = document.createElement('div');
    shadowHost.style.all = 'initial';
    document.body.appendChild(shadowHost);
    shadowRoot = shadowHost.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent =
      // BUG FIX — DETAIL VISUAL ELEMENT PICKER: a full-viewport, invisible
      // "glass pane" that owns EVERY pointer event while picker mode is
      // active — see resolveOverlayTarget()/startCapturing()'s own header
      // comments for the full root-cause story. z-index deliberately
      // higher than every other element THIS file ever creates (and than
      // any realistic real-world page z-index) so it is always the
      // topmost hit-tested element regardless of what the underlying
      // page does with its own stacking contexts. display:none by
      // default — a hidden element receives no pointer events at all and
      // has zero footprint, which is also this file's own cleanup
      // mechanism (see stopCapturing()).
      '.ws-picker-overlay{position:fixed;top:0;left:0;width:100%;height:100%;' +
      'z-index:2147483005;background:transparent;cursor:crosshair;display:none;}' +
      '.ws-highlight{position:fixed;pointer-events:none;border:2px solid #4F46E5;' +
      'background:rgba(79,70,229,0.15);border-radius:4px;z-index:2147483000;display:none;' +
      'box-sizing:border-box;}' +
      // BUG REOPEN — unmistakable page-level indicator (mission's own
      // explicit ask): a bolder banner with a bright accent border/dot,
      // so "picker mode is active" is obvious at a glance directly on
      // the real page — never only inferable from logs or from the
      // (much subtler) previous plain-dark banner.
      '.ws-banner{position:fixed;top:12px;left:50%;transform:translateX(-50%);' +
      'background:#111827;color:#fff;font:700 14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'padding:10px 18px;border-radius:8px;z-index:2147483001;display:none;box-shadow:0 4px 16px rgba(0,0,0,0.35);' +
      'border:2px solid #22c55e;letter-spacing:.01em;}' +
      '.ws-banner .ws-banner-dot{display:inline-block;width:9px;height:9px;border-radius:50%;' +
      'background:#22c55e;margin-right:8px;vertical-align:middle;animation:ws-banner-pulse 1.1s ease-in-out infinite;}' +
      '@keyframes ws-banner-pulse{0%,100%{opacity:1;}50%{opacity:.25;}}' +
      '.ws-panel{position:fixed;bottom:20px;right:20px;width:300px;background:#fff;color:#111827;' +
      'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;border-radius:10px;' +
      'box-shadow:0 8px 30px rgba(0,0,0,0.25);padding:14px;z-index:2147483002;display:none;}' +
      '.ws-panel h3{margin:0 0 6px;font-size:14px;}' +
      '.ws-panel .ws-meta{color:#6b7280;font-size:12px;margin-bottom:10px;}' +
      '.ws-panel .ws-warn{color:#b91c1c;font-size:12px;margin-bottom:10px;}' +
      '.ws-panel label{display:block;font-size:11px;font-weight:600;color:#6b7280;margin:8px 0 3px;' +
      'text-transform:uppercase;letter-spacing:.03em;}' +
      '.ws-panel input,.ws-panel select{width:100%;box-sizing:border-box;padding:6px 8px;' +
      'border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:inherit;}' +
      '.ws-panel .ws-example{font-size:11.5px;color:#4338CA;background:#eef2ff;border-radius:6px;' +
      'padding:5px 7px;margin-top:5px;word-break:break-all;max-height:54px;overflow-y:auto;}' +
      '.ws-panel .ws-actions{display:flex;gap:8px;margin-top:12px;}' +
      '.ws-panel button{flex:1;padding:7px 10px;border-radius:6px;border:none;font-size:13px;cursor:pointer;}' +
      '.ws-btn-primary{background:#4F46E5;color:#fff;}' +
      '.ws-btn-primary:hover{background:#4338CA;}' +
      '.ws-btn-secondary{background:#f3f4f6;color:#111827;}' +
      '.ws-btn-secondary:hover{background:#e5e7eb;}' +
      // ---- V1.17 additions ----
      '.ws-hover-label{position:fixed;pointer-events:none;background:#111827;color:#fff;' +
      'font:11px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:2px 6px;' +
      'border-radius:4px;z-index:2147483000;display:none;white-space:nowrap;}' +
      '.ws-panel .ws-advanced-toggle{background:none;border:none;color:#4F46E5;font-size:11.5px;' +
      'font-weight:600;cursor:pointer;padding:4px 0;text-align:left;flex:none;width:100%;}' +
      '.ws-panel .ws-advanced-toggle:hover{text-decoration:underline;background:none;}' +
      '.ws-panel .ws-advanced-section{border-top:1px solid #e5e7eb;margin-top:8px;padding-top:6px;}' +
      '.ws-panel .ws-selector-row{display:flex;align-items:center;gap:6px;margin-top:2px;}' +
      '.ws-panel .ws-selector-row input{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;}' +
      '.ws-panel .ws-quality-tag{font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;white-space:nowrap;}' +
      '.ws-panel .ws-quality-good{background:#ecfdf5;color:#047857;}' +
      '.ws-panel .ws-quality-fair{background:#eef2ff;color:#4338ca;}' +
      '.ws-panel .ws-quality-fragile{background:#fffbeb;color:#b45309;}' +
      '.ws-panel .ws-tester-status{font-size:11.5px;color:#374151;margin-top:6px;}' +
      '.ws-panel .ws-tester-status.ws-tester-invalid{color:#b91c1c;}' +
      '.ws-panel .ws-tester-preview{font-size:11px;color:#4338CA;background:#eef2ff;border-radius:6px;' +
      'padding:5px 7px;margin-top:4px;max-height:70px;overflow-y:auto;}' +
      '.ws-panel .ws-tester-preview div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '.ws-panel .ws-attr-name-row{margin-top:4px;}';
    shadowRoot.appendChild(style);

    // BUG FIX — DETAIL VISUAL ELEMENT PICKER: created once, shown/hidden
    // per pick session by startCapturing()/stopCapturing() — see this
    // file's own onMouseMove/onClick (bound directly to THIS element, not
    // document) and resolveOverlayTarget() for the full mechanism.
    overlayEl = document.createElement('div');
    overlayEl.className = 'ws-picker-overlay';
    shadowRoot.appendChild(overlayEl);
    overlayEl.addEventListener('mousemove', onMouseMove);
    overlayEl.addEventListener('click', onClick);
    // A real, observed root cause this fix specifically targets: some
    // sites/frameworks trigger their own navigation/activation logic on
    // mousedown rather than waiting for click (or a mousedown handler
    // elsewhere on the page reacts before our own click handler would
    // ever run) — since the overlay is now the ONLY element that ever
    // receives ANY pointer event for the duration of picker mode, a bare
    // preventDefault() here is enough to neutralize that path too; there
    // is no real page listener to "race" any more; page listeners never
    // pointer-event target that page element and receive the event at all.
    overlayEl.addEventListener('mousedown', function (e) { if (pickModeActive) e.preventDefault(); });

    highlightEl = document.createElement('div');
    highlightEl.className = 'ws-highlight';
    shadowRoot.appendChild(highlightEl);

    hoverLabelEl = document.createElement('div');
    hoverLabelEl.className = 'ws-hover-label';
    shadowRoot.appendChild(hoverLabelEl);

    bannerEl = document.createElement('div');
    bannerEl.className = 'ws-banner';
    var bannerDot = document.createElement('span');
    bannerDot.className = 'ws-banner-dot';
    bannerEl.appendChild(bannerDot);
    bannerTextEl = document.createElement('span');
    bannerTextEl.textContent = 'ClickScrape — PICKER ACTIVE: click an element to select it — Esc to cancel';
    bannerEl.appendChild(bannerTextEl);
    shadowRoot.appendChild(bannerEl);

    panelEl = document.createElement('div');
    panelEl.className = 'ws-panel';
    shadowRoot.appendChild(panelEl);
  }

  function positionHighlight(el) {
    var r = el.getBoundingClientRect();
    highlightEl.style.left = r.left + 'px';
    highlightEl.style.top = r.top + 'px';
    highlightEl.style.width = r.width + 'px';
    highlightEl.style.height = r.height + 'px';
    highlightEl.style.display = 'block';
  }

  function hideHighlight() {
    if (highlightEl) highlightEl.style.display = 'none';
  }

  // ---- V1.17 #3: Live Selector Tester — highlights every element the
  // Advanced selector field currently matches on the real page. Uses a
  // plain inline outline (restored exactly on clear) rather than a class
  // toggle + injected global stylesheet rule, since it must reach elements
  // OUTSIDE this file's own shadow root with zero risk of leaking a class
  // name into the page's own CSS. Capped (MULTI_HIGHLIGHT_MAX) so a
  // selector that matches thousands of elements on a huge page can never
  // turn "highlight the matches" into a layout-thrashing loop (spec #14). ----
  var MULTI_HIGHLIGHT_MAX = 60;
  var multiHighlighted = []; // [{el, outline, outlineOffset}]

  function clearMultiHighlight() {
    multiHighlighted.forEach(function (entry) {
      entry.el.style.outline = entry.outline;
      entry.el.style.outlineOffset = entry.outlineOffset;
    });
    multiHighlighted = [];
  }

  function applyMultiHighlight(elements) {
    clearMultiHighlight();
    var capped = elements.slice(0, MULTI_HIGHLIGHT_MAX);
    capped.forEach(function (el) {
      if (!el || el.nodeType !== 1) return;
      multiHighlighted.push({ el: el, outline: el.style.outline, outlineOffset: el.style.outlineOffset });
      el.style.outline = '2px solid #059669';
      el.style.outlineOffset = '1px';
    });
  }

  // V1.17 #14 (performance): a page with heavy layout/paint cost (huge
  // DOM, expensive CSS) firing mousemove at native rate can visibly
  // stutter if every event does synchronous work. rAF-throttling collapses
  // any burst of events between two paints into a single highlight
  // update — position math + DOM writes never exceed one per frame,
  // regardless of how fast the mouse actually moves.
  var pendingMoveEvent = null;
  var moveRafScheduled = false;

  function onMouseMove(e) {
    if (!pickModeActive) return;
    pendingMoveEvent = e;
    if (moveRafScheduled) return;
    moveRafScheduled = true;
    raf(function () {
      moveRafScheduled = false;
      var ev = pendingMoveEvent;
      pendingMoveEvent = null;
      if (!ev || !pickModeActive) return;
      var el = resolveOverlayTarget(ev);
      if (!el || el === hoveredEl) return;
      hoveredEl = el;
      positionHighlight(el);
      updateHoverLabel(el);
    });
  }

  /** Spec #1: "clearly show what will be selected" while hovering, BEFORE
   * the user commits with a click. Deliberately cheap (tag + up to 2
   * meaningful classes, no full selector generation) — this runs on every
   * hovered element, so it must never do the same expensive uniqueness
   * search buildRelativeSelector does. */
  function quickDescribeElement(el) {
    var tag = el.tagName.toLowerCase();
    var classes = window.WSSelector && window.WSSelector.getStableClasses ? window.WSSelector.getStableClasses(el) : [];
    var desc = tag;
    if (classes.length) desc += '.' + classes.slice(0, 2).join('.');
    return desc;
  }

  function updateHoverLabel(el) {
    if (!hoverLabelEl) return;
    hoverLabelEl.textContent = quickDescribeElement(el);
    var r = el.getBoundingClientRect();
    // Sits just above the highlighted box when there's room, otherwise
    // just below it — never off-screen.
    var top = r.top - 22;
    hoverLabelEl.style.left = Math.max(4, r.left) + 'px';
    hoverLabelEl.style.top = (top >= 0 ? top : r.bottom + 4) + 'px';
    hoverLabelEl.style.display = 'block';
  }

  function hideHoverLabel() {
    if (hoverLabelEl) hoverLabelEl.style.display = 'none';
  }

  function onClick(e) {
    if (!pickModeActive) return;
    // Structurally the real page never receives this event at all (see
    // resolveOverlayTarget()'s own header comment) — these three calls
    // are kept anyway, per this bug fix's own explicit requirement, as
    // defense-in-depth against the (only theoretically possible) case of
    // e.target briefly resolving to something other than our own overlay.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    var resolved = resolveOverlayTarget(e);
    console.log(LOG_PREFIX, 'pick click', {
      'overlay event.target': e.target,
      'resolved (real) target': resolved,
      tagName: resolved && resolved.tagName,
      textContent: resolved ? (resolved.textContent || '').trim().slice(0, 120) : ''
    });
    // Defensive only — elementsFromPoint always finds at least
    // <html>/<body> for any on-screen point, so this should never
    // actually trigger in practice; if it somehow does, staying in pick
    // mode (rather than calling handlePicked(null)) is the safe choice.
    if (!resolved) return;

    stopCapturing();
    handlePicked(resolved);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      exitPickMode();
    }
  }

  function startCapturing() {
    if (overlayEl) overlayEl.style.display = 'block';
    document.addEventListener('keydown', onKeyDown, true);
  }

  // Stops hover/click interception (used once an element has been picked)
  // but leaves Escape active so the naming panel can still be dismissed.
  // BUG FIX — DETAIL VISUAL ELEMENT PICKER: hiding overlayEl IS the
  // cleanup here — a display:none element is not hit-tested at all, so
  // it receives no further pointer events and the underlying page's own
  // click/link/button behavior is fully restored the instant this runs
  // (mission requirement: "All picker listeners/highlights/temporary
  // state must be removed after successful selection/cancellation/
  // termination/error" — this function is that ONE cleanup path,
  // called from every one of those cases: onClick right before
  // handlePicked, and exitPickMode for Escape/Done/cancel).
  function stopCapturing() {
    pickModeActive = false;
    hoveredEl = null;
    if (overlayEl) overlayEl.style.display = 'none';
    hideHighlight();
    hideHoverLabel();
    pendingMoveEvent = null;
    if (bannerEl) bannerEl.style.display = 'none';
  }

  function enterPickMode(purpose, extra) {
    ensureUI();
    pickPurpose = purpose || 'column';
    if (isDetailPickPurpose(pickPurpose)) pickTargetHostname = (extra && extra.targetHostname) || pickTargetHostname;
    pickModeActive = true;
    // BUG REOPEN — mission's own explicit ask: an "unmistakable" page-
    // level indicator that picker mode is active, visible on the real
    // page itself (not only in logs) — every variant now leads with the
    // same unambiguous "ClickScrape — PICKER ACTIVE" prefix.
    bannerTextEl.textContent = pickPurpose === 'next-button'
      ? 'ClickScrape — PICKER ACTIVE: click the "Next" / pagination control — Esc to cancel'
      : isDetailPickPurpose(pickPurpose)
        ? 'ClickScrape — PICKER ACTIVE: click a field to add it — pick as many as you need, Esc when done'
        : 'ClickScrape — PICKER ACTIVE: click an element to select it — Esc to cancel';
    bannerEl.style.display = 'block';
    panelEl.style.display = 'none';
    startCapturing();
  }

  function exitPickMode() {
    stopCapturing();
    document.removeEventListener('keydown', onKeyDown, true);
    if (panelEl) panelEl.style.display = 'none';
    clearMultiHighlight();
    if (testerDebounceTimer) { clearTimeout(testerDebounceTimer); testerDebounceTimer = null; }
  }

  function handlePicked(el) {
    if (pickPurpose === 'next-button') {
      var nbInfo = resolveNextButtonInfo(el);
      console.log(LOG_PREFIX, 'next-button pick resolved', nbInfo);
      renderNextButtonPanel(el, nbInfo);
      return;
    }
    // V1.18 #3: picking a Detail Page field — the page being picked on
    // has no "repeating container" concept of its own (it's a single
    // detail record, exactly like pickElementInfo's existing null-
    // container fallback), and results stage into a session key scoped
    // to the ORIGINAL list page's hostname (pickTargetHostname, passed
    // through START_PICK) rather than this page's own ws_state — the
    // popup picks staged fields up when reopened there (see popup.js's
    // checkForPendingDetailFieldPicks, mirroring the existing V1.3
    // next-button-pick recovery pattern exactly).
    //
    // BUG FIX — real production report + real Chrome storage audit: this
    // used to call WSScraper.pickElementInfo(el, null), which — with no
    // existing container passed — runs Sel.findRepeatingContainer(el),
    // a heuristic built for LIST pages (repeating cards/rows). A single
    // Detail page has no such concept at all, but the heuristic doesn't
    // know that and can still detect SOME broad matching pattern
    // elsewhere on a real, complex page (related items, review cards,
    // etc.) — and when the clicked element itself gets classified as
    // that "container", the resulting relativeSelector becomes ':scope',
    // which content/scraper.js's runDetailExtraction previously (mis)
    // read as "the entire page body", persisting up to ~140KB of raw
    // page HTML/text per record (confirmed: ~8.92MB of a real ~9MB
    // ws_deepscrape_run). Fixed at the source: a Detail pick now always
    // resolves an ABSOLUTE selector for the EXACT clicked element via
    // Sel.buildSelectorForElement — the same primitive resolveNextButtonInfo
    // above already uses for the same reason (no repeating-container
    // concept applies there either) — which can structurally never
    // produce ':scope'.
    if (isDetailPickPurpose(pickPurpose)) {
      var detailAttribute = WSSelector.suggestAttribute(el);
      var detailSelector = WSSelector.buildSelectorForElement(el);
      var detailInfo = {
        ok: !!detailSelector,
        reason: detailSelector ? undefined : 'unresolvable',
        containerSelector: null,
        relativeSelector: detailSelector,
        matchCount: detailSelector ? WSSelector.countMatches(detailSelector) : 0,
        attribute: detailAttribute,
        previewText: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)
      };
      var stagingKey = detailStagingKeyPrefix(pickPurpose) + (pickTargetHostname || hostname());
      chrome.storage.session.get([stagingKey], function (result) {
        var staged = (result && result[stagingKey]) || [];
        renderPanel(el, { columns: staged }, detailInfo);
      });
      return;
    }
    WSStorage.getState(hostname()).then(function (state) {
      var info = WSScraper.pickElementInfo(el, state.containerSelector);
      console.log(LOG_PREFIX, 'pick resolved', {
        'generated selector': info.relativeSelector,
        'detected repeating container': info.containerSelector,
        'selector match count': info.matchCount,
        ok: info.ok,
        reason: info.reason
      });
      renderPanel(el, state, info);
    });
  }

  /**
   * Resolves everything V1.3's pagination orchestration needs to
   * re-locate and evaluate a "Next" control on future page loads: an
   * absolute selector (reusing WSSelector.buildSelectorForElement
   * unchanged — the same engine used for single-record pages), and a
   * best-effort disabled/visibility check using only generic,
   * non-site-specific signals.
   */
  function resolveNextButtonInfo(el) {
    var selector = WSSelector.buildSelectorForElement(el);
    return {
      ok: !!selector,
      relativeSelector: selector,
      matchCount: selector ? WSSelector.countMatches(selector) : 0,
      disabled: isLikelyDisabled(el),
      tagName: el.tagName,
      previewText: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)
    };
  }

  function isLikelyDisabled(el) {
    if (el.disabled) return true;
    if (el.hasAttribute('disabled')) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    if (el.classList && Array.prototype.some.call(el.classList, function (c) { return /disabled/i.test(c); })) return true;
    var style = window.getComputedStyle(el);
    if (style && (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0)) return true;
    return false;
  }

  function renderNextButtonPanel(pickedEl, info) {
    panelEl.innerHTML = '';
    panelEl.style.display = 'block';

    if (!info.ok) {
      var warn = document.createElement('div');
      warn.className = 'ws-warn';
      warn.textContent = "Couldn't build a reliable selector for this element. Try a different one.";
      panelEl.appendChild(warn);
      var closeBtn = document.createElement('button');
      closeBtn.className = 'ws-btn-secondary';
      closeBtn.style.width = '100%';
      closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', exitPickMode);
      panelEl.appendChild(closeBtn);
      return;
    }

    var title = document.createElement('h3');
    title.textContent = 'Confirm Next Button';
    panelEl.appendChild(title);

    if (info.disabled) {
      var warn2 = document.createElement('div');
      warn2.className = 'ws-warn';
      warn2.textContent = '⚠ This element currently looks disabled — that’s fine if this page happens to be the last one, but double-check you picked the right control.';
      panelEl.appendChild(warn2);
    }

    var meta = document.createElement('div');
    meta.className = 'ws-meta';
    meta.textContent = 'Matches ' + info.matchCount + ' element(s) on this page' +
      (info.previewText ? ' — "' + info.previewText + '"' : '');
    panelEl.appendChild(meta);

    var actions = document.createElement('div');
    actions.className = 'ws-actions';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'ws-btn-secondary';
    cancelBtn.textContent = 'Cancel';
    var confirmBtn = document.createElement('button');
    confirmBtn.className = 'ws-btn-primary';
    confirmBtn.textContent = 'Use This Button';
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    panelEl.appendChild(actions);

    cancelBtn.addEventListener('click', exitPickMode);
    confirmBtn.addEventListener('click', function () {
      var key = 'ws_next_button_pick::' + hostname();
      var data = {};
      data[key] = {
        relativeSelector: info.relativeSelector,
        matchCount: info.matchCount,
        disabled: info.disabled,
        previewText: info.previewText,
        pickedAt: Date.now()
      };
      chrome.storage.session.set(data, exitPickMode);
    });
  }

  function suggestColumnName(attribute, existingNames) {
    var base = attribute === 'href' ? 'Link' : attribute === 'src' ? 'Image' : attribute === 'alt' ? 'Alt Text' : 'Column';
    var name = base;
    var n = 2;
    while (existingNames.indexOf(name) !== -1) {
      name = base + ' ' + n;
      n++;
    }
    return name;
  }

  /**
   * Builds the list of extraction-type options to offer for the picked
   * element, tag-appropriate and ordered with the most likely choice
   * first. Every option still gets computed against the *actual* clicked
   * element (via WSSelector.extractValue) so the panel can show a live,
   * truthful example rather than a generic description.
   */
  // V1.17 #1/#7: HTML and Attribute... are offered for every element type
  // — an advanced escape hatch (arbitrary data-*/aria-*/any attribute, or
  // raw inner HTML) that's useful regardless of tag, unlike text/href/src/
  // alt which are genuinely tag-appropriate.
  var ADVANCED_ATTRIBUTE_OPTIONS = [
    { value: 'html', label: 'HTML content' },
    { value: 'attr', label: 'Attribute…' }
  ];

  function attributeOptionsFor(el) {
    var tag = el.tagName;
    if (tag === 'A' || tag === 'AREA') {
      return [
        { value: 'text', label: 'Text content' },
        { value: 'href', label: 'Link URL' }
      ].concat(ADVANCED_ATTRIBUTE_OPTIONS);
    }
    if (tag === 'IMG') {
      return [
        { value: 'src', label: 'Image source' },
        { value: 'alt', label: 'Alt text' }
      ].concat(ADVANCED_ATTRIBUTE_OPTIONS);
    }
    // Generic element: offer everything, since it may contain a nested
    // <a>/<img> that extractValue already knows how to fall back to.
    return [
      { value: 'text', label: 'Text content' },
      { value: 'href', label: 'Link URL' },
      { value: 'src', label: 'Image source' },
      { value: 'alt', label: 'Alt text' }
    ].concat(ADVANCED_ATTRIBUTE_OPTIONS);
  }

  function renderPanel(pickedEl, state, info) {
    panelEl.innerHTML = '';
    panelEl.style.display = 'block';

    if (!info.ok) {
      var msg = info.reason === 'outside-container'
        ? 'This element is not inside the repeating item you picked earlier. Choose an element from the same type of card/row, or hit Reset in the popup to start over.'
        : "Couldn't build a reliable selector for this element. Try a different one.";
      var warn = document.createElement('div');
      warn.className = 'ws-warn';
      warn.textContent = msg;
      panelEl.appendChild(warn);

      var closeBtn = document.createElement('button');
      closeBtn.className = 'ws-btn-secondary';
      closeBtn.style.width = '100%';
      closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', exitPickMode);
      panelEl.appendChild(closeBtn);
      return;
    }

    var title = document.createElement('h3');
    title.textContent = 'Name this column';
    panelEl.appendChild(title);

    var meta = document.createElement('div');
    meta.className = 'ws-meta';
    // V1.17 #1: match count in the spec's own worked-example wording.
    meta.textContent = info.matchCount + ' match' + (info.matchCount === 1 ? '' : 'es') +
      (info.previewText ? ' — "' + info.previewText.slice(0, 40) + '"' : '');
    panelEl.appendChild(meta);

    var nameLabel = document.createElement('label');
    nameLabel.textContent = 'Column Name';
    panelEl.appendChild(nameLabel);

    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.spellcheck = false;
    var existingNames = state.columns.map(function (c) { return c.name; });
    nameInput.value = suggestColumnName(info.attribute, existingNames);
    panelEl.appendChild(nameInput);

    // V1.17 #1: a labeled, always-visible "Selector" read-out (spec's own
    // basic-mode example: "Price / .product-card .price / 48 matches /
    // Text") plus a compact quality tag — advanced technical REASONS stay
    // out of the basic view (spec: "do not overwhelm normal users").
    var selectorLabel = document.createElement('label');
    selectorLabel.textContent = 'Selector';
    panelEl.appendChild(selectorLabel);
    var selectorRow = document.createElement('div');
    selectorRow.className = 'ws-selector-row';
    var selectorDisplay = document.createElement('div');
    selectorDisplay.style.cssText = 'flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:#374151;overflow-wrap:anywhere;';
    var isStringSelector = typeof info.relativeSelector === 'string';
    selectorDisplay.textContent = isStringSelector ? info.relativeSelector : '(inside shadow DOM — not directly editable)';
    var qualityTagEl = document.createElement('span');
    qualityTagEl.className = 'ws-quality-tag';
    selectorRow.appendChild(selectorDisplay);
    selectorRow.appendChild(qualityTagEl);
    panelEl.appendChild(selectorRow);

    function setQualityTag(selectorForScoring) {
      var quality = WSSelector.scoreSelectorQuality(selectorForScoring);
      qualityTagEl.textContent = quality.label;
      qualityTagEl.className = 'ws-quality-tag ws-quality-' + quality.label.toLowerCase();
      qualityTagEl.title = (quality.reasons || []).join('; ');
      return quality;
    }
    setQualityTag(info.relativeSelector);

    var attrLabel = document.createElement('label');
    attrLabel.textContent = 'Extract';
    panelEl.appendChild(attrLabel);

    var attrSelect = document.createElement('select');
    var options = attributeOptionsFor(pickedEl);
    // Keep the suggested attribute selected if it's offered; otherwise
    // default to the first (most likely) option for this element type.
    var hasSuggested = options.some(function (o) { return o.value === info.attribute; });
    options.forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === (hasSuggested ? info.attribute : options[0].value)) o.selected = true;
      attrSelect.appendChild(o);
    });
    panelEl.appendChild(attrSelect);

    // V1.17 #7: revealed only when "Attribute…" is chosen — the one
    // extraction type that needs an extra piece of input to mean anything.
    var attrNameRow = document.createElement('div');
    attrNameRow.className = 'ws-attr-name-row';
    attrNameRow.hidden = true;
    var attrNameLabel = document.createElement('label');
    attrNameLabel.textContent = 'Attribute name';
    var attrNameInput = document.createElement('input');
    attrNameInput.type = 'text';
    attrNameInput.spellcheck = false;
    attrNameInput.placeholder = 'data-product-id';
    attrNameRow.appendChild(attrNameLabel);
    attrNameRow.appendChild(attrNameInput);
    panelEl.appendChild(attrNameRow);

    var exampleEl = document.createElement('div');
    exampleEl.className = 'ws-example';
    panelEl.appendChild(exampleEl);

    function updateExample() {
      attrNameRow.hidden = attrSelect.value !== 'attr';
      var val = WSSelector.extractValue(pickedEl, attrSelect.value, null, attrNameInput.value.trim());
      exampleEl.textContent = val ? 'Example: ' + val.slice(0, 140) : 'Example: (empty on this element)';
    }
    attrSelect.addEventListener('change', updateExample);
    attrNameInput.addEventListener('input', updateExample);
    updateExample();

    // =====================================================================
    // V1.17 #3/#16: Advanced — Live Selector Tester, collapsed by default
    // (progressive disclosure: spec #16 explicitly keeps this out of the
    // default beginner path). Only offered when the generated selector is
    // a plain string (not a shadow-DOM multi-hop array — editing THAT as
    // free text has no safe, honest representation, so it's skipped with
    // a clear explanation rather than silently broken — spec #15).
    // =====================================================================
    var effectiveSelector = info.relativeSelector;
    var testerDebounceLocal = null;

    if (isStringSelector) {
      var advancedToggle = document.createElement('button');
      advancedToggle.type = 'button';
      advancedToggle.className = 'ws-advanced-toggle';
      advancedToggle.textContent = '▸ Advanced';
      panelEl.appendChild(advancedToggle);

      var advancedSection = document.createElement('div');
      advancedSection.className = 'ws-advanced-section';
      advancedSection.hidden = true;

      var testerLabel = document.createElement('label');
      testerLabel.textContent = 'Test / edit selector';
      var testerInput = document.createElement('input');
      testerInput.type = 'text';
      testerInput.spellcheck = false;
      testerInput.value = info.relativeSelector;
      var testerStatus = document.createElement('div');
      testerStatus.className = 'ws-tester-status';
      var testerPreview = document.createElement('div');
      testerPreview.className = 'ws-tester-preview';
      testerPreview.hidden = true;

      advancedSection.appendChild(testerLabel);
      advancedSection.appendChild(testerInput);
      advancedSection.appendChild(testerStatus);
      advancedSection.appendChild(testerPreview);
      panelEl.appendChild(advancedSection);

      advancedToggle.addEventListener('click', function () {
        advancedSection.hidden = !advancedSection.hidden;
        advancedToggle.textContent = (advancedSection.hidden ? '▸' : '▾') + ' Advanced';
        if (advancedSection.hidden) clearMultiHighlight(); else runLiveSelectorTest(testerInput.value);
      });

      // The SAME containers the real scrape will use (spec: the tester
      // must reflect actual extraction semantics, not a disconnected
      // page-wide query) — mirrors content/scraper.js's runExtraction
      // container resolution exactly.
      var effectiveContainerSelector = state.containerSelector || info.containerSelector;
      function resolveContainers() {
        if (!effectiveContainerSelector) return [document.body];
        try { return Array.prototype.slice.call(document.querySelectorAll(effectiveContainerSelector)); }
        catch (e) { return []; }
      }

      function runLiveSelectorTest(rawSelector) {
        clearMultiHighlight();
        var trimmed = (rawSelector || '').trim();
        if (!trimmed) {
          testerStatus.className = 'ws-tester-status ws-tester-invalid';
          testerStatus.textContent = 'Enter a selector to test.';
          testerPreview.hidden = true;
          return;
        }
        // WSSelector.queryFromScope() deliberately SWALLOWS a bad selector
        // internally (returns null, same as "no match" — the right choice
        // for real extraction, where a stale saved selector must never
        // throw). The tester needs to tell those two cases apart for the
        // user, so it validates syntax explicitly first, via the browser's
        // own parser (document.querySelectorAll throws SyntaxError on
        // genuinely invalid CSS) — :scope is skipped since it's this
        // codebase's own sentinel, not real CSS syntax.
        var sawError = false;
        if (trimmed !== ':scope') {
          try { document.querySelectorAll(trimmed); } catch (e) { sawError = true; }
        }

        var containers = resolveContainers();
        var matchedEls = [];
        var values = [];
        if (!sawError) {
          containers.forEach(function (containerEl) {
            var el;
            try {
              el = trimmed === ':scope' ? containerEl : WSSelector.queryFromScope(containerEl, trimmed);
            } catch (e) {
              sawError = true;
              return;
            }
            if (el) {
              matchedEls.push(el);
              var v = WSSelector.extractValue(el, attrSelect.value, containerEl, attrNameInput.value.trim());
              if (v) values.push(v);
            }
          });
        }

        if (sawError) {
          testerStatus.className = 'ws-tester-status ws-tester-invalid';
          testerStatus.textContent = 'Invalid selector.';
          testerPreview.hidden = true;
          return;
        }

        testerStatus.className = 'ws-tester-status';
        testerStatus.textContent = 'MATCHES: ' + matchedEls.length + (containers.length > 1 ? ' of ' + containers.length + ' items' : '');
        if (matchedEls.length === 0) {
          testerStatus.textContent = '0 matches';
        }
        setQualityTag(trimmed);
        applyMultiHighlight(matchedEls);

        if (values.length) {
          testerPreview.hidden = false;
          testerPreview.innerHTML = '';
          values.slice(0, 5).forEach(function (v) {
            var line = document.createElement('div');
            line.textContent = v.length > 80 ? v.slice(0, 80) + '…' : v;
            testerPreview.appendChild(line);
          });
        } else {
          testerPreview.hidden = true;
        }

        // A validly-editing power user's chosen selector becomes what
        // "Add Column" actually saves — this is the precise-control path
        // spec #1 asks for ("a power user should be able to precisely
        // control extraction").
        effectiveSelector = trimmed;
        selectorDisplay.textContent = trimmed;
      }

      testerInput.addEventListener('input', function () {
        if (testerDebounceLocal) clearTimeout(testerDebounceLocal);
        var val = testerInput.value;
        // V1.17 #14: debounced — re-testing on every keystroke against a
        // large page would repeatedly re-run querySelectorAll/extraction.
        testerDebounceLocal = setTimeout(function () { runLiveSelectorTest(val); }, 200);
        testerDebounceTimer = testerDebounceLocal;
      });
    }

    // V1.18 #17/#18: a Detail Page field's selector may legitimately match
    // MORE than one element on the page (a feature list, an image
    // gallery) — offered ONLY for 'detail-field' picks, since a normal
    // list-page column's relativeSelector is always evaluated per-row/
    // per-container and "multiple" has no meaning there.
    var multipleCheckbox = null;
    if (isDetailPickPurpose(pickPurpose)) {
      var multipleRow = document.createElement('div');
      multipleRow.className = 'ws-checkbox-row';
      multipleRow.style.marginTop = '6px';
      var multipleLabel = document.createElement('label');
      multipleLabel.style.cssText = 'display:flex;align-items:center;gap:6px;text-transform:none;font-weight:400;color:#111827;margin:0;';
      multipleCheckbox = document.createElement('input');
      multipleCheckbox.type = 'checkbox';
      multipleLabel.appendChild(multipleCheckbox);
      multipleLabel.appendChild(document.createTextNode('This may match multiple values — extract all'));
      multipleRow.appendChild(multipleLabel);
      panelEl.appendChild(multipleRow);
    }

    var isDetailField = isDetailPickPurpose(pickPurpose);
    var actions = document.createElement('div');
    actions.className = 'ws-actions';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'ws-btn-secondary';
    cancelBtn.textContent = isDetailField ? 'Done' : 'Cancel';
    var addBtn = document.createElement('button');
    addBtn.className = 'ws-btn-primary';
    addBtn.textContent = isDetailField ? 'Add Field' : 'Add Column';
    actions.appendChild(cancelBtn);
    actions.appendChild(addBtn);
    panelEl.appendChild(actions);

    cancelBtn.addEventListener('click', exitPickMode);
    addBtn.addEventListener('click', function () {
      var name = nameInput.value.trim() || suggestColumnName(info.attribute, existingNames);
      var column = {
        id: WSStorage.makeColumnId(),
        name: name, // deliberately independent of the extraction type
        relativeSelector: effectiveSelector,
        attribute: attrSelect.value
      };
      // V1 SIMPLIFIED SESSION WORKFLOW: persist the exact value the user
      // just saw on this ONE clicked element (the same computation
      // updateExample() already does for its own transient in-page
      // "Example:" text) so the popup's setup-tab preview table can show
      // it later without ever re-touching the page — this is deliberately
      // NOT re-derived from a live query at popup-render time, so it
      // always reflects literally the example the user picked, not
      // whatever the page currently contains. Purely additive/optional —
      // every existing column-consuming code path (extraction, export,
      // Saved Scrapers, Templates) already ignores unknown fields.
      var sampleVal = WSSelector.extractValue(pickedEl, attrSelect.value, null, attrNameInput.value.trim());
      if (sampleVal) column.sampleValue = sampleVal.slice(0, 200);
      // attributeName is ONLY ever set for attribute==='attr' columns —
      // every other existing/new column shape is completely unaffected
      // (spec #13: new metadata must use backward-compatible defaults;
      // extractValue's attributeName param is simply undefined/ignored
      // for every other attribute value, exactly like today).
      if (attrSelect.value === 'attr') column.attributeName = attrNameInput.value.trim();

      if (isDetailField) {
        column.multiple = (multipleCheckbox && multipleCheckbox.checked) ? 'all' : 'first';
        // BUG REOPEN Phase 5: "store/return at minimum... source URL" —
        // the real sample page this field was actually picked on, purely
        // informational (never re-read to drive any control-flow
        // decision), useful for a user or a future diagnostic to see
        // exactly which page produced a given selector.
        column.pickedFromUrl = location.href;
        var stagingKey = detailStagingKeyPrefix(pickPurpose) + (pickTargetHostname || hostname());
        chrome.storage.session.get([stagingKey], function (result) {
          var staged = ((result && result[stagingKey]) || []).concat([column]);
          var data = {};
          data[stagingKey] = staged;
          chrome.storage.session.set(data, function () {
            // Stay in pick mode for the next field (spec's own numbered
            // workflow: pick Description, then Brand, then SKU, all in
            // one Element Picker activation) — Done/Esc is the only way
            // to actually exit. Re-enters with the SAME purpose that was
            // active (never hardcoded) so a 'live-detail-field' pick
            // session stays on its own staging key across multiple adds.
            enterPickMode(pickPurpose, { targetHostname: pickTargetHostname });
          });
        });
        return;
      }

      var newState = {
        containerSelector: state.containerSelector || info.containerSelector,
        columns: state.columns.concat([column])
      };
      WSStorage.setState(hostname(), newState).then(exitPickMode);
    });

    setTimeout(function () {
      nameInput.focus();
      nameInput.select();
    }, 0);
  }

  // REAL REGRESSION FIX: legacy-template migration for a persisted,
  // over-specific containerSelector (a real Etsy case: an old saved
  // Title+Price template whose containerSelector baked in per-item
  // wt-order-*-N reorder classes, collapsing coverage to ~2 cards, even
  // after content/selector.js's own repeated-container discovery was
  // fixed — the FIX only applies going forward, to a freshly-clicked
  // selector; it never revisits a selector that's already sitting in
  // storage). Runs at the START of every RUN_EXTRACTION (both classic
  // Preview/Extract and BAŞLA's live session, and it doesn't matter
  // whether the persisted state came from ordinary column-picking or
  // from loading a Saved Scraper template — both funnel through
  // WSStorage.getState/RUN_EXTRACTION the same way) — never a separate,
  // one-off codepath, so it's not something the user could accidentally
  // skip.
  //
  // Generic, not Etsy-specific: validates the STORED selector by
  // actually querying it against the live page; only treats it as stale
  // when it matches an implausibly small number of elements (<=2). To
  // migrate, it finds a genuine live anchor — one of the stored columns'
  // own relativeSelector, resolved inside whichever single stale-
  // container instance still exists — and reruns the EXACT SAME
  // repeated-container discovery logic a fresh manual click already
  // uses (WSSelector.findRepeatingContainer + buildContainerSelector),
  // so there is no second, parallel selector-generation algorithm to
  // keep in sync. Only replaces the stored selector when the migrated
  // one is a genuine, strictly better match — never on a tie, never
  // downgrading a page that legitimately only has 1-2 real records.
  var STALE_CONTAINER_MATCH_CEILING = 2;

  function migrateContainerSelectorIfStale(state) {
    var diag = {
      storedContainerSelector: state.containerSelector || null,
      matchCountBefore: null,
      migratedContainerSelector: null,
      matchCountAfter: null,
      templateMigrationPerformed: false
    };
    if (!state.containerSelector || !Array.isArray(state.columns) || !state.columns.length) return diag;

    var matchCountBefore;
    try {
      matchCountBefore = document.querySelectorAll(state.containerSelector).length;
    } catch (e) {
      matchCountBefore = 0;
    }
    diag.matchCountBefore = matchCountBefore;
    // 0 matches means the stored selector is broken in a different way
    // (the page changed shape entirely) — there's no live anchor to
    // re-derive from, so this migration path (which only ever
    // REGENERALIZES an over-specific selector) correctly leaves it
    // alone rather than guessing.
    if (matchCountBefore < 1 || matchCountBefore > STALE_CONTAINER_MATCH_CEILING) return diag;

    var containers = document.querySelectorAll(state.containerSelector);
    var anchorEl = null;
    for (var i = 0; i < containers.length && !anchorEl; i++) {
      for (var c = 0; c < state.columns.length && !anchorEl; c++) {
        var col = state.columns[c];
        if (!col.relativeSelector || col.relativeSelector === ':scope') continue;
        var fieldEl = WSSelector.queryFromScope(containers[i], col.relativeSelector);
        if (fieldEl) anchorEl = fieldEl;
      }
    }
    if (!anchorEl) return diag; // no resolvable field inside the stale container — can't safely re-anchor

    var detected = WSSelector.findRepeatingContainer(anchorEl);
    if (!detected.container) return diag;
    var migrated = WSSelector.buildContainerSelector(detected.container, undefined, detected.siblings);
    var matchCountAfter = WSSelector.countMatches(migrated);
    diag.migratedContainerSelector = migrated;
    diag.matchCountAfter = matchCountAfter;

    if (migrated && migrated !== state.containerSelector && matchCountAfter > matchCountBefore) {
      state.containerSelector = migrated;
      diag.templateMigrationPerformed = true;
    }
    return diag;
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return;

    if (message.type === 'PING') {
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'START_PICK') {
      enterPickMode(message.purpose, { targetHostname: message.targetHostname });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'RUN_EXTRACTION') {
      // BUG FIX — "BAŞLA does not actually start a new scrape" (real
      // production report: UI hangs at "Veri işleniyor…" forever after
      // an existing session's results are already showing): this whole
      // promise chain had NO .catch() anywhere. If WSStorage.getState()
      // rejected, or migrateContainerSelectorIfStale()/WSScraper.
      // runExtraction() threw (e.g. a malformed/stale selector against
      // the CURRENT page's real DOM shape), sendResponse() was simply
      // never called — the message channel this `return true` keeps
      // open then never closes, so popup.js's own
      // `await chrome.tabs.sendMessage(...)` in sendToContent() hangs
      // indefinitely. This is the exact same class of silent-async-
      // death bug already found and fixed elsewhere in this project
      // (content/discovery.js's own runDiscoveryLoopSafe() wrapper) —
      // never previously hardened here. The added .catch() guarantees
      // sendResponse() is ALWAYS eventually called, converting a silent
      // infinite hang into an honest, immediate {ok:false, error} popup.
      // js's existing readError handling already reacts to correctly —
      // no popup.js change needed for that. This also naturally unsticks
      // handleStartLiveSession()'s own `runTriggerInFlight` guard (only
      // ever reset in that function's own `finally`, which cannot run
      // while its `await sendToContent(...)` is hung) — a fresh BAŞLA
      // click was previously silently swallowed by that guard forever
      // once one run got stuck this way.
      WSStorage.getState(hostname()).then(function (state) {
        var migration = migrateContainerSelectorIfStale(state); // mutates state.containerSelector in place when it migrates
        var persisted = migration.templateMigrationPerformed
          ? WSStorage.setState(hostname(), state) // step 5: save the migrated template back automatically
          : Promise.resolve();
        return persisted.then(function () {
          var result = WSScraper.runExtraction(state);
          sendResponse({ ok: true, rows: result.rows, totalCount: result.totalCount, containerMigration: migration });
        });
      }).catch(function (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
      return true; // keep the message channel open for the async response
    }

    // V1.18: runs Deep Scraping's Detail Page Fields against THIS page,
    // treated as a single record (no repeating container) — used both by
    // background.js's real deep-scrape worker (one tab per detail URL)
    // and by the popup's "Test Detail Fields" sample preview.
    if (message.type === 'RUN_DETAIL_EXTRACTION') {
      try {
        // BUG FIX: runDetailExtraction now returns {row, rejectedFields}
        // (oversized/whole-page values are refused, never silently
        // persisted — see that function's own header comment) — passed
        // through unchanged so background.js's fetchOneDetailPage can
        // mark the record honestly instead of ever treating a rejected
        // field as a successful, complete extraction.
        var result = WSScraper.runDetailExtraction(message.fields || []);
        sendResponse({ ok: true, row: result.row, rejectedFields: result.rejectedFields });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
      return true;
    }
  });
})();
