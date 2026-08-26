/**
 * autoscroll.js
 * INFINITE SCROLL (Auto Scroll) — OPTIONAL, opt-in-per-session automatic
 * continuation of the V1 SIMPLIFIED SESSION WORKFLOW (BAŞLA/BİTİR,
 * content/livewatch.js), for sites that load more results by scrolling
 * instead of (or in addition to) a "Next" control. OFF by default; when
 * a session's `autoScroll` field is absent (every session created
 * before this feature existed, and every session where the user left
 * the toggle OFF), this file's message handlers are simply never
 * invoked and its resume-on-load bootstrap is a no-op — existing
 * behavior (including content/autopaginate.js's own Auto Next, and the
 * passive live-session watcher) is byte-for-byte unchanged.
 *
 * Reuses the exact same three primitives every other collection path in
 * this project already uses — WSScraper.runExtraction /
 * WSAutoDetect.classifyExtractedRows / WSRunState.mergeNewRows — never
 * reimplementing extraction or dedup logic, only deciding WHEN to
 * re-scrape and HOW to make more content appear (scrolling).
 *
 * COEXISTENCE WITH AUTO NEXT (content/autopaginate.js): this file
 * exposes `runUntilExhausted(session, host, controller)` as a REUSABLE,
 * pure async function — not just an internal implementation detail of
 * this file's own standalone loop. When BOTH `autoScroll` and
 * `autoPaginate` are enabled on a session, content/autopaginate.js
 * calls this function directly, once per page, BEFORE its own
 * find-Next step — giving exactly the spec's preferred flow ("scroll
 * current page to exhaustion, then Next, then scroll the new page").
 * When Auto Next is OFF, this file's own message-driven
 * START_AUTO_SCROLL handler calls the same function directly. Either
 * way, there is exactly ONE scroll-loop implementation.
 */
(function (root) {
  'use strict';

  if (window.__wsAutoScrollInjected) return;
  window.__wsAutoScrollInjected = true;

  var LOG_PREFIX = '[Web Scraper:autoscroll]';
  var DEFAULT_MAX_CYCLES = 30; // spec: "This is NOT a product/licensing limit. It is only runaway-loop protection."
  var DEFAULT_MAX_NO_NEW_DATA = 3; // spec section 6: "2 or 3 consecutive no-new-data attempts"
  var MAX_ELAPSED_MS = 3 * 60 * 1000; // defensive time-based safety net, on top of the cycle-count limit
  var GROWTH_WAIT_TIMEOUT_MS = 6000; // how long to wait for new content to actually appear after one scroll
  var GROWTH_POLL_MS = 250;
  var SETTLE_QUIET_MS = 400; // brief settle before the FIRST scrape of a cycle, same spirit as autopaginate.js's own SETTLE_QUIET_MS

  function hostname() {
    return location.hostname;
  }

  function sessionKey(host) {
    return 'ws_live_session::' + root.WSRunState.normalizeHostname(host);
  }

  function getSession(host) {
    var key = sessionKey(host);
    return new Promise(function (resolve) {
      chrome.storage.local.get([key], function (result) {
        resolve((result && result[key]) || null);
      });
    });
  }

  function setSession(host, session) {
    var data = {};
    data[sessionKey(host)] = session;
    return new Promise(function (resolve) {
      chrome.storage.local.set(data, resolve);
    });
  }

  var currentAbortController = null;
  function freshAbort() {
    currentAbortController = new AbortController();
    return currentAbortController;
  }

  /** True while THIS session's Auto Scroll is still eligible to keep
   * running — mirrors content/autopaginate.js's own stillRunning()
   * exactly (same contract: the live session itself must be 'active',
   * and the sub-feature must be enabled and not explicitly 'stopped'). */
  function stillRunning(session) {
    return !!(session && session.status === 'active' && session.autoScroll &&
      session.autoScroll.enabled && session.autoScroll.status !== 'stopped');
  }

  function finalize(session, host, reason) {
    session.autoScroll.status = 'stopped';
    session.autoScroll.stopReason = reason;
    session.autoScroll.updatedAt = Date.now();
    console.log(LOG_PREFIX, 'STOP REASON:', reason, 'cycles:', session.autoScroll.cycleCount, 'rows:', session.rows.length);
    return setSession(host, session);
  }

  // =====================================================================
  // SCROLL TARGET DETECTION (spec section 12: "do NOT scroll unrelated
  // UI panels, sidebars, chat windows, image carousels, horizontal
  // sliders, or the extension popup itself. Prefer the main document
  // unless strong evidence indicates the repeated result container has
  // its own vertical scroll area.")
  // =====================================================================

  /** True only for an element that is BOTH styled as vertically
   * scrollable (overflow-y auto/scroll) AND actually has more content
   * than fits (scrollHeight meaningfully exceeds clientHeight) — either
   * alone is a common false positive (plenty of elements are styled
   * `overflow:auto` defensively without ever actually overflowing). */
  function isActuallyScrollable(el) {
    if (!el || el === document.documentElement || el === document.body) return false;
    var style;
    try { style = window.getComputedStyle(el); } catch (e) { return false; }
    if (!style) return false;
    var overflowY = style.overflowY;
    if (overflowY !== 'auto' && overflowY !== 'scroll') return false;
    return (el.scrollHeight - el.clientHeight) > 40; // small fuzz — a few px of overflow is not a real scroll area
  }

  /**
   * Finds the effective scroll container for the repeated result cards.
   * Walks UP from the scraper's own container elements (never from some
   * unrelated part of the page — this is exactly what keeps a sidebar/
   * chat-widget/carousel's own independent scroll area from ever being
   * considered: those elements are never an ANCESTOR of the actual
   * result cards, so this walk structurally never reaches them).
   * Falls back to the main document (window scrolling) — the common
   * case, and the spec's own explicit preference — when no ancestor of
   * the result cards is genuinely, independently scrollable.
   * @returns {{el: Element|null, isWindow: boolean}}
   */
  function findScrollTarget(containerSelector) {
    var cards;
    try { cards = containerSelector ? document.querySelectorAll(containerSelector) : []; } catch (e) { cards = []; }
    if (cards.length) {
      var el = cards[0].parentElement;
      var hops = 0;
      while (el && el !== document.body && hops < 12) {
        if (isActuallyScrollable(el)) return { el: el, isWindow: false };
        el = el.parentElement;
        hops++;
      }
    }
    return { el: null, isWindow: true };
  }

  function scrollMetrics(target) {
    if (target.isWindow) {
      var doc = document.documentElement;
      return {
        scrollHeight: Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0),
        scrollTop: window.scrollY,
        clientHeight: window.innerHeight
      };
    }
    return { scrollHeight: target.el.scrollHeight, scrollTop: target.el.scrollTop, clientHeight: target.el.clientHeight };
  }

  function isAtBottom(target, thresholdPx) {
    var m = scrollMetrics(target);
    return (m.scrollTop + m.clientHeight) >= (m.scrollHeight - (thresholdPx || 100));
  }

  /** STEP 4 (spec): "Prefer controlled scrolling rather than jumping
   * blindly to the absolute bottom." Primary strategy: scrollIntoView on
   * the LAST currently-known result card (naturally adaptive to
   * variable card heights, and — unlike a fixed pixel increment — always
   * advances to genuinely new territory even on a very tall or very
   * short card). Falls back to a viewport-height increment when no
   * cards are found yet (e.g. the very first scroll of a cycle where
   * nothing matched, though in practice STEP 1 already scraped first).
   *
   * REAL BUG found and fixed via real-browser testing against
   * https://quotes.toscrape.com/scroll: that site's own scroll listener
   * only fires its "load more" AJAX call when the window is within 1px
   * of the LITERAL document bottom (`Math.abs(scrollTop - (docHeight -
   * winHeight)) <= 1`) — a genuinely common real-world infinite-scroll
   * pattern. `scrollIntoView({block:'end'})` on the last known card only
   * scrolls until THAT card's own bottom edge reaches the viewport
   * bottom; any trailing chrome below it (this site has a real
   * `<footer>` after the results, and many real sites have one) leaves
   * the actual scrollTop short of the true document bottom by that
   * footer's height, comfortably outside a 1px tolerance — so the site's
   * own trigger silently never fired, and Auto Scroll span 3 full real
   * cycles with zero genuine growth (confirmed via saved screenshots and
   * storage snapshots, not assumed). scrollIntoView alone is adaptive to
   * card height but does not know about a site's own scroll-trigger
   * math; a card being "in view" and the PAGE being "at the bottom" are
   * two different things a real site is free to distinguish. Fixed by
   * always finishing with an explicit settle to the target's own true
   * current bottom (`scrollHeight`) after scrollIntoView, not only in
   * the no-cards fallback branch — cheap, still lands at essentially the
   * same place scrollIntoView already got close to for the common case,
   * and closes this real gap for the (also common) trailing-footer case. */
  function scrollOnce(target, containerSelector) {
    var cards;
    try { cards = containerSelector ? document.querySelectorAll(containerSelector) : []; } catch (e) { cards = []; }
    if (cards.length) {
      var last = cards[cards.length - 1];
      try { last.scrollIntoView({ block: 'end', behavior: 'auto' }); } catch (e) { /* fall through to the bottom-settle below regardless */ }
    }
    if (target.isWindow) {
      var doc = document.documentElement;
      var trueBottom = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0);
      window.scrollTo({ top: trueBottom, left: 0, behavior: 'auto' });
    } else {
      target.el.scrollTop = target.el.scrollHeight;
    }
  }

  /**
   * STEP 5 (spec): wait for NEW CONTENT, not merely a fixed sleep —
   * polls for either the scroll container's height or the repeated
   * result-card count to exceed the pre-scroll baseline, backed by a
   * MutationObserver so it resolves as soon as growth is observed
   * rather than only at the next poll tick, with a hard timeout so a
   * page that genuinely has no more content to load can't stall the
   * loop forever (see the caller's own consecutive-no-new-data handling
   * for what happens when growth genuinely never arrives).
   * `timeoutMs` defaults to GROWTH_WAIT_TIMEOUT_MS but is overridable —
   * exposed as session.autoScroll.growthTimeoutMs, same pattern this
   * project already uses for maxCycles/maxNoNewDataAttempts (per-session
   * configurable, tests use a short one; production uses the default).
   * @returns {Promise<{grew: boolean, reason: string}>}
   */
  function waitForGrowth(target, containerSelector, baseline, signal, timeoutMs) {
    return new Promise(function (resolve) {
      var settled = false;
      var pollTimer = null;
      var hardTimer = null;
      var observer = null;

      function currentCount() {
        try { return containerSelector ? document.querySelectorAll(containerSelector).length : 0; } catch (e) { return 0; }
      }

      function check() {
        if (settled) return;
        var m = scrollMetrics(target);
        var count = currentCount();
        if (m.scrollHeight > baseline.scrollHeight || count > baseline.count) {
          finish(true, count > baseline.count ? 'card-count-increased' : 'height-increased');
        }
      }

      function finish(grew, reason) {
        if (settled) return;
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (hardTimer) clearTimeout(hardTimer);
        if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } }
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve({ grew: grew, reason: reason });
      }

      function onAbort() { finish(false, 'aborted'); }
      if (signal) {
        if (signal.aborted) { finish(false, 'aborted'); return; }
        signal.addEventListener('abort', onAbort);
      }

      try {
        observer = new MutationObserver(check);
        observer.observe(target.isWindow ? document.body : target.el, { childList: true, subtree: true });
      } catch (e) { observer = null; }
      pollTimer = setInterval(check, GROWTH_POLL_MS);
      hardTimer = setTimeout(function () { finish(false, 'timeout'); }, timeoutMs || GROWTH_WAIT_TIMEOUT_MS);
      check(); // in case growth already happened synchronously as part of the scroll itself
    });
  }

  /** Extract -> (best-effort) classify -> dedupe/merge — identical
   * primitives to content/autopaginate.js's own scrapeCurrentPage; kept
   * as a local copy rather than a cross-file call so this file has no
   * hard load-order dependency on autopaginate.js (either can be
   * injected/used independently). */
  function scrapeCurrentPage(session) {
    var extraction = root.WSScraper.runExtraction(session.scraperConfig);
    var candidateRows = extraction.rows || [];
    var accepted = candidateRows;
    if (candidateRows.length >= 5 && root.WSAutoDetect && typeof root.WSAutoDetect.classifyExtractedRows === 'function') {
      try {
        var classified = root.WSAutoDetect.classifyExtractedRows(session.scraperConfig.columns, candidateRows);
        accepted = candidateRows.filter(function (row, idx) {
          var v = classified.verdicts[idx];
          return !v || v.verdict !== 'exclude';
        });
      } catch (e) { /* best-effort — never blocks collection */ }
    }
    var merge = root.WSRunState.mergeNewRows(session, accepted, session.scraperConfig.columns, { baseUrl: location.href });
    session = merge.runState;
    session.lastPassNewRows = merge.newUniqueCount;
    session.lastCheckAt = Date.now();
    session.updatedAt = Date.now();
    return { session: session, accepted: accepted, newUniqueCount: merge.newUniqueCount };
  }

  /**
   * Runs Auto Scroll cycles against the CURRENT page until a stop
   * condition is met (spec section 5: A-H), returning only once
   * genuinely finished — reusable both by this file's own standalone
   * loop (Auto Next OFF) and directly by content/autopaginate.js (Auto
   * Next ON, spec section 14's "scroll current page until exhausted,
   * THEN Next").
   *
   * Authoritative stop signal is always "zero genuinely new unique rows
   * for N consecutive cycles" (spec section 6) — page-height/card-count
   * growth are used only internally, as an early-exit optimization
   * inside waitForGrowth (decide when it's even worth re-scraping),
   * never as independent stop conditions on their own; a virtualized
   * list that doesn't grow scrollHeight proportionally, for instance,
   * would make a height-only stop condition unreliable, while "did a
   * real extraction pass find new unique rows" is robust regardless of
   * how the page manages its own DOM.
   *
   * `skipInitialScrape` — true whenever the CURRENT page's content has
   * already been scraped by whatever called this function, immediately
   * before calling it — true for both real callers of a fresh
   * invocation: popup.js's own BAŞLA extraction (standalone Auto
   * Scroll, via the START_AUTO_SCROLL message handler below) and
   * content/autopaginate.js's own scrape block (combined mode — by the
   * time autopaginate.js reaches its own call to this function, on
   * EITHER page 1 (scraped by BAŞLA) or page 2+ (scraped by
   * autopaginate's own scrape block earlier in the SAME loop
   * iteration), the current page has always just been scraped already).
   * false only for a genuine bootstrap-resume on a brand-new,
   * never-scraped page (this file's own bootstrap below, mirroring
   * content/autopaginate.js's identical skipInitialScrape contract
   * exactly). Re-scraping an already-scraped page here would find zero
   * new rows and silently consume one of the limited consecutive-no-
   * new-data attempts before any real scrolling ever happened.
   * @param {object} session current session object (already includes autoScroll)
   * @param {string} host normalized hostname (storage key scope)
   * @param {AbortController} [controller] optional — a fresh one is created if omitted
   * @param {boolean} [skipInitialScrape]
   * @returns {Promise<object>} the final, persisted session
   */
  async function runUntilExhausted(session, host, controller, skipInitialScrape) {
    // Defensive: every real production call site already gates this
    // (never called with a null/absent autoScroll — see START_AUTO_SCROLL,
    // bootstrapResume, and content/autopaginate.js's own coexistence
    // check, all below/elsewhere), but a public, exported function
    // should not crash on bad input regardless of what today's callers
    // happen to avoid.
    if (!stillRunning(session)) return session;
    controller = controller || freshAbort();
    var startedAt = Date.now();
    var firstIteration = true;
    console.log(LOG_PREFIX, 'scroll-to-exhaustion start', { url: location.href, cycleCount: session.autoScroll.cycleCount, skipInitialScrape: !!skipInitialScrape });

    while (true) {
      session = await getSession(host);
      if (!stillRunning(session)) return session;
      var as = session.autoScroll;

      if (Date.now() - startedAt > MAX_ELAPSED_MS) {
        await finalize(session, host, 'max-elapsed-time');
        return await getSession(host);
      }

      if (!(firstIteration && skipInitialScrape)) {
        // ---- STEP 1: scrape currently visible/loaded items ----
        var settleWait = await root.WSDomWait.waitForDomStable({ quietMs: SETTLE_QUIET_MS, timeoutMs: 3000, signal: controller.signal });
        if (settleWait.reason === 'aborted') return await getSession(host);

        session = await getSession(host);
        if (!stillRunning(session)) return session;
        as = session.autoScroll;

        var passResult;
        try {
          passResult = scrapeCurrentPage(session);
        } catch (e) {
          console.error(LOG_PREFIX, 'extraction threw mid-scroll — stopping safely, data preserved', e);
          await finalize(session, host, 'extraction-error');
          return await getSession(host);
        }
        session = passResult.session;

        // ---- STEP 3/E (content-only, url-independent — see
        // content/autopaginate.js's own identical reasoning for why a
        // page-URL-inclusive signature can never detect "content
        // repeats"). Tracked but — REAL BUG found and fixed via focused
        // testing (spec's own TEST 3 vs TEST 6 exposed it directly —
        // see the file's own history/comment trail): for a scroll-
        // loaded page, EVERY scrape re-reads the FULL currently-visible
        // card set (not just newly-appended cards), so "zero genuinely
        // new unique rows" and "identical full-pass content signature"
        // are, in practice, the SAME event for this collection mode —
        // unlike content/autopaginate.js's own use of this same helper,
        // where a genuinely EARLIER page can be revisited under a
        // completely different scrape. Treating a single signature
        // repeat as an INSTANT stop (as an early version of this file
        // did) directly violated spec section 6 ("do not stop
        // immediately after one slow load"): a page that has simply not
        // finished loading its next batch yet re-scrapes the exact same
        // visible cards and would trip an instant stop before ever
        // giving the site a second chance. Signature repetition is
        // still recorded (useful diagnostic history) but no longer an
        // independent immediate-stop trigger — the SAME
        // consecutiveNoNewData threshold below is the one, correctly
        // lenient, authoritative signal for both "genuinely no more
        // content" (spec's case D) and "identical fingerprint" (case E),
        // which is exactly right since a repeated signature always
        // implies newUniqueCount===0 for this collection mode anyway. ----
        var signature = root.WSRunState.computePageSignature('', passResult.accepted, session.scraperConfig.columns);
        if (as.pageSignatures.indexOf(signature) === -1) {
          as.pageSignatures.push(signature);
          if (as.pageSignatures.length > 50) as.pageSignatures.shift(); // bounded, matches this project's other capped-history conventions
        }

        if (passResult.newUniqueCount > 0) {
          as.consecutiveNoNewData = 0;
        } else {
          as.consecutiveNoNewData++;
        }

        console.log(LOG_PREFIX, 'cycle scraped', { cycleCount: as.cycleCount, newRows: passResult.newUniqueCount, consecutiveNoNewData: as.consecutiveNoNewData, totalRows: session.rows.length });
        await setSession(host, session);

        // ---- STEP 6/D+E (spec 6): do not stop after one slow load —
        // only after N consecutive attempts with zero genuinely new
        // rows (this is also what catches a repeated fingerprint — see
        // the comment above for why the two are the same signal here). ----
        if (as.consecutiveNoNewData >= as.maxNoNewDataAttempts) {
          await finalize(session, host, 'no-new-data');
          return await getSession(host);
        }
        // ---- J/safety: max scroll cycles ----
        if (as.cycleCount >= as.maxCycles) {
          await finalize(session, host, 'max-cycles');
          return await getSession(host);
        }
      }
      firstIteration = false;

      // ---- STEP 3/4: measure state, then scroll ----
      var target = findScrollTarget(session.scraperConfig.containerSelector);
      var baseline = scrollMetrics(target);
      var baselineCount = 0;
      try { baselineCount = session.scraperConfig.containerSelector ? document.querySelectorAll(session.scraperConfig.containerSelector).length : 0; } catch (e) { /* ignore */ }

      // A (spec 5): already at the bottom of a non-growing page — still
      // goes through the SAME consecutive-attempts counter above rather
      // than stopping immediately here, exactly per spec section 6's
      // "do not stop immediately after one slow load" — being at the
      // bottom is not itself a hard stop, only a (very likely) predictor
      // that the next extraction will find nothing new.
      scrollOnce(target, session.scraperConfig.containerSelector);
      as.cycleCount++;
      await setSession(host, session);

      // ---- STEP 5: wait for NEW CONTENT (not a fixed sleep) ----
      var growth = await waitForGrowth(target, session.scraperConfig.containerSelector, { scrollHeight: baseline.scrollHeight, count: baselineCount }, controller.signal, as.growthTimeoutMs);
      if (growth.reason === 'aborted') return await getSession(host);
      console.log(LOG_PREFIX, 'post-scroll wait result', growth);
      // Loop back around regardless of whether growth was observed —
      // the NEXT iteration's own extraction pass (STEP 1/7) is the
      // authoritative "did anything genuinely new actually appear"
      // check (spec: "actual page-state validation is required",
      // satisfied by a real extraction, not just a height/count proxy).
    }
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return;

    if (message.type === 'START_AUTO_SCROLL') {
      // Mirrors content/autopaginate.js's START_AUTO_PAGINATE contract:
      // the session (with autoScroll already seeded, status:'running')
      // must already be persisted before this arrives. If autoPaginate
      // is ALSO enabled on this session, this message is never sent at
      // all by popup.js — autopaginate.js's own loop calls
      // runUntilExhausted() directly instead (see this file's header
      // comment) — so there is never a risk of two independent loops
      // both driving the same page's scrolling at once.
      // skipInitialScrape:true — this page's rows were already scraped
      // and merged by popup.js's own BAŞLA extraction before this
      // message was even sent (see the skipInitialScrape doc comment on
      // runUntilExhausted itself for the full reasoning).
      getSession(hostname()).then(function (session) {
        runUntilExhausted(session, hostname(), null, true);
      });
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'STOP_AUTO_SCROLL') {
      if (currentAbortController) currentAbortController.abort();
      getSession(hostname()).then(function (session) {
        if (!session || !session.autoScroll) { sendResponse({ ok: true }); return; }
        session.autoScroll.status = 'stopped';
        session.autoScroll.stopReason = 'user';
        session.autoScroll.updatedAt = Date.now();
        setSession(hostname(), session).then(function () { sendResponse({ ok: true }); });
      });
      return true;
    }
  });

  // Resume across a real page navigation/reload — same rationale as
  // content/autopaginate.js's own bootstrap (see that file's detailed
  // comment on why `stillRunning()` — not a stricter single-status
  // check — is correct here too). Infinite-scroll sites rarely navigate
  // at all (that's the point of the pattern), but a soft/client-side
  // route change or a manual reload while Auto Scroll is active should
  // still resume cleanly rather than silently going stale. Only fires
  // when autoPaginate is NOT also driving this session (autoPaginate's
  // own bootstrap calls runUntilExhausted() itself in that combined
  // case — see content/autopaginate.js) to guarantee exactly one
  // scroll-loop per session, never two competing instances.
  // NEW FEATURE — AUTOMATIC DATA DISCOVERY ENGINE: content/discovery.js
  // seeds and drives this EXACT SAME session.autoScroll sub-object
  // automatically (no user toggle), calling runUntilExhausted() directly
  // itself, exactly like content/autopaginate.js's own combined mode
  // already did before discovery.js existed. Without this exclusion, a
  // session actively owned by discovery.js would ALSO be picked up by
  // this bootstrap the moment any fresh content-script instance loads
  // (a real Next navigation, an SPA route change) — two independent
  // loops racing to scroll/scrape/persist the same session, the exact
  // failure class content/livewatch.js's own header comment documents in
  // detail for the autoPaginate/autoScroll pair. Mirrors the
  // `!(session.autoPaginate && session.autoPaginate.enabled)` exclusion
  // immediately to its left — same reasoning, one more legitimate owner.
  getSession(hostname()).then(function (session) {
    var ownedByDiscovery = !!(session && session.discovery && session.discovery.enabled &&
      session.discovery.status === 'discovering');
    if (stillRunning(session) && !(session.autoPaginate && session.autoPaginate.enabled) && !ownedByDiscovery) {
      console.log(LOG_PREFIX, 'bootstrap: resuming active auto-scroll session', session.sessionId);
      runUntilExhausted(session, hostname());
    }
  }).catch(function () { /* nothing to resume */ });

  root.WSAutoScroll = {
    DEFAULT_MAX_CYCLES: DEFAULT_MAX_CYCLES,
    DEFAULT_MAX_NO_NEW_DATA: DEFAULT_MAX_NO_NEW_DATA,
    runUntilExhausted: runUntilExhausted,
    findScrollTarget: findScrollTarget,
    isActuallyScrollable: isActuallyScrollable
  };
})(window);
