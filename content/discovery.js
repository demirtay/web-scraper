/**
 * discovery.js
 * AUTOMATIC DATA DISCOVERY ENGINE — the orchestrator described in this
 * mission: the user configures columns, then ClickScrape automatically
 * discovers every accessible unique record through the current
 * result/listing flow, deciding entirely on its own how additional
 * records are reached (Next-button pagination, infinite scroll, Load
 * More, or a hybrid of these across a single traversal) — never asking
 * the user to pick a mode.
 *
 * ARCHITECTURE — an orchestrator ABOVE the existing engines, not a
 * rewrite of them (mission section 2): this file calls the exact same
 * reusable, already-hardened primitives every other collection path in
 * this project already uses —
 *   - content/nextdetect.js's WSNextDetect.findNextControl() for
 *     pagination detection (completely unmodified),
 *   - content/autoscroll.js's WSAutoScroll.runUntilExhausted() for
 *     infinite-scroll-to-exhaustion (completely unmodified — the SAME
 *     function content/autopaginate.js's own combined mode already
 *     calls directly),
 *   - content/loadmore.js's WSLoadMore.runUntilExhausted() (new, this
 *     mission) for Load-More-to-exhaustion, built to the identical
 *     contract/shape as the two above,
 *   - content/domwait.js/utils/runstate.js for settle-detection,
 *     navigation-vs-mutation detection, dedup, and page-signature loop
 *     detection — all exactly as content/autopaginate.js already uses
 *     them.
 * The three engines above are driven through their OWN internal
 * sub-objects (session.autoScroll / session.loadMoreAuto), seeded and
 * owned entirely by THIS file — never the user-facing session.autoPaginate/
 * session.autoScroll toggles content/autopaginate.js's/content/
 * autoscroll.js's OWN standalone message listeners respond to. This is a
 * deliberate, load-bearing separation: it lets this file always run both
 * engines automatically (no toggle, mission section 3) while leaving the
 * existing explicit-toggle code paths (and their own real-browser tests)
 * completely untouched and still independently functional. (See
 * content/autoscroll.js's own bootstrap-resume guard for the one small,
 * additive coordination change this required there — this file's own
 * session.autoScroll sub-object must never ALSO be picked up by that
 * file's independent resume-on-navigation bootstrap.)
 *
 * PER-PAGE TRAVERSAL ORDER (mission section 6 — "prefer non-navigation
 * expansion first... do not navigate prematurely while the current page
 * can still reveal more results"):
 *   1. scrape whatever is currently on the page
 *   2. run Auto Scroll to its own natural exhaustion
 *   3. run Load More to its own natural exhaustion
 *   4. only THEN look for a legitimate next-page control; if found,
 *      navigate and repeat from 1 on the new page
 *   5. if nothing above yields further access, DISCOVERY COMPLETE
 *
 * A real hybrid site whose SAME page alternates between scroll and Load
 * More more than once (a rare pattern — most real sites use one
 * mechanism per page) is not re-alternated beyond this single pass per
 * page; this is a deliberate, documented scope limit, not an oversight —
 * every mission-specified hybrid example (pagination + scroll on
 * different pages, or several Load More clicks before a Next) is exactly
 * this file's own page-then-navigate loop, unmodified.
 */
(function (root) {
  'use strict';

  if (window.__wsDiscoveryInjected) return;
  window.__wsDiscoveryInjected = true;

  var LOG_PREFIX = '[Web Scraper:discovery]';
  var NAV_TIMEOUT_MS = 8000;
  var SETTLE_QUIET_MS = 500;
  var SETTLE_TIMEOUT_MS = 5000;
  // Mission section 21: "must NEVER loop forever" — a hard ceiling on the
  // outer loop itself, independent of (and in addition to) the
  // maxPages/maxVisitedStates safety nets in utils/discovery.js. Never
  // expected to be reached by any real site given those other limits are
  // always tighter; exists purely as defense-in-depth.
  var MAX_LOOP_ITERATIONS = 6000;

  function hostname() { return location.hostname; }
  function sessionKey(host) { return 'ws_live_session::' + root.WSRunState.normalizeHostname(host); }
  function getSession(host) {
    var key = sessionKey(host);
    return new Promise(function (resolve) {
      chrome.storage.local.get([key], function (result) { resolve((result && result[key]) || null); });
    });
  }
  function setSession(host, session) {
    var data = {};
    data[sessionKey(host)] = session;
    return new Promise(function (resolve) { chrome.storage.local.set(data, resolve); });
  }

  var currentAbortController = null;
  function freshAbort() { currentAbortController = new AbortController(); return currentAbortController; }

  /** REAL BUG found and fixed via this mission's own fixture testing
   * (TEST 51 — Stop Discovery): chrome.storage.local.get() — like the
   * real API it mirrors — resolves with a snapshot frozen at the moment
   * it was CALLED, not at the moment its callback actually fires. A
   * STOP_DISCOVERY request's own storage WRITE can therefore land
   * strictly AFTER an already-in-flight `getSession()` call (anywhere in
   * this loop, including inside finalizeComplete/finalizeStopped's own
   * "re-read fresh before the terminal write" guard) was already
   * DISPATCHED against the pre-stop state — no amount of "read fresh
   * right before writing" closes this, since the read can be dispatched
   * before the write exists yet, and its result is fixed at that instant
   * regardless of how much later it resolves. A plain, synchronous,
   * in-memory flag has no such window: it is set in the SAME synchronous
   * tick as `currentAbortController.abort()` (STOP_DISCOVERY handler,
   * below), and every finalize call in THIS script instance checks it
   * first, with no storage round-trip involved at all. */
  var discoveryStopRequested = false;

  /** True while this session's discovery is still eligible to keep
   * running — mirrors content/autopaginate.js's/content/autoscroll.js's
   * own stillRunning() contract exactly (session itself must be
   * 'active', discovery must be enabled and specifically in the
   * 'discovering' status — 'discovery_paused'/'discovery_stopped'/
   * 'discovery_complete'/'error' all correctly fall through to false
   * here, ending the loop). */
  function stillRunning(session) {
    // discoveryStopRequested (checked FIRST, synchronously, no storage
    // round-trip) closes a real race the `session.discovery.status`
    // check alone cannot: `session` here may be a snapshot returned by
    // WSAutoScroll.runUntilExhausted/WSLoadMore.runUntilExhausted after
    // THEIR OWN internal abort-return path re-read storage at a moment
    // BEFORE this exact Stop request's own write had landed (a real,
    // observed race — found via this mission's own fixture testing,
    // TEST 51). Checking the flag here means EVERY stillRunning() gate
    // in this file's main loop correctly stops immediately once Stop is
    // requested, regardless of whether the `session` object it was just
    // handed happens to carry a stale, pre-stop `discovery.status`.
    return !discoveryStopRequested && !!(session && session.status === 'active' && session.discovery &&
      session.discovery.enabled && session.discovery.status === 'discovering');
  }

  function candidateCount(containerSelector) {
    try { return containerSelector ? document.querySelectorAll(containerSelector).length : 0; } catch (e) { return 0; }
  }

  /** BUG REOPEN (action-ownership diagnostics): a lightweight, diagnostic-
   * ONLY content fingerprint for STEP 4's own pagination-attempt record
   * (below) — proves whether the on-screen content actually changed
   * around the exact moment THIS script issued a Next-control trigger,
   * independent of session.rows (which may not have grown yet at
   * transition time — see finalizeComplete's own note on this). Never
   * fed into any control-flow/loop-detection decision (that stays
   * WSRunState.computePageSignature/buildTraversalStateId, unmodified) —
   * purely an observability aid for real-browser verification. */
  function diagFingerprint(containerSelector) {
    try {
      var count = candidateCount(containerSelector);
      var first = containerSelector ? document.querySelector(containerSelector) : null;
      var sample = first ? (first.textContent || '').trim().slice(0, 200) : (document.body ? document.body.textContent.trim().slice(0, 200) : '');
      return count + ':' + sample.length + ':' + sample;
    } catch (e) { return 'error:' + (e && e.message); }
  }

  /** Local copy of the same extract -> classify -> dedupe/merge primitive
   * every other collection path in this project uses (kept local, not a
   * cross-file call — matches content/autopaginate.js's/content/
   * autoscroll.js's/content/loadmore.js's own established convention). */
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
    return { session: session, accepted: accepted, newUniqueCount: merge.newUniqueCount, rawCount: candidateRows.length };
  }

  /** Seeds the two internally-owned engine sub-objects THIS file drives
   * (idempotent — never resets an already-running one), completely
   * separate from session.autoPaginate/session.autoScroll's own
   * user-toggle-driven fields (see file header). */
  function ensureInternalEngines(session) {
    if (!session.autoScroll) {
      session.autoScroll = {
        enabled: true, status: 'running', stopReason: null,
        cycleCount: 0, maxCycles: root.WSAutoScroll.DEFAULT_MAX_CYCLES,
        consecutiveNoNewData: 0, maxNoNewDataAttempts: root.WSAutoScroll.DEFAULT_MAX_NO_NEW_DATA,
        pageSignatures: [], updatedAt: Date.now()
      };
    }
    if (!session.loadMoreAuto) {
      session.loadMoreAuto = {
        enabled: true, status: 'running', stopReason: null,
        clickCount: 0, maxClicks: root.WSLoadMore.DEFAULT_MAX_CLICKS,
        consecutiveNoNewData: 0, maxNoNewDataAttempts: root.WSLoadMore.DEFAULT_MAX_NO_NEW_DATA,
        pageSignatures: [], updatedAt: Date.now()
      };
    }
    return session;
  }

  /** Re-arms both engines for a fresh page visit — same "each page gets
   * its own full budget" reasoning content/autopaginate.js's own
   * per-page autoScroll re-arm comment documents in detail. */
  function rearmEnginesForNewPage(session) {
    session.autoScroll.status = 'running'; session.autoScroll.stopReason = null;
    session.autoScroll.cycleCount = 0; session.autoScroll.consecutiveNoNewData = 0;
    session.autoScroll.pageSignatures = []; session.autoScroll.updatedAt = Date.now();
    session.loadMoreAuto.status = 'running'; session.loadMoreAuto.stopReason = null;
    session.loadMoreAuto.clickCount = 0; session.loadMoreAuto.consecutiveNoNewData = 0;
    session.loadMoreAuto.pageSignatures = []; session.loadMoreAuto.updatedAt = Date.now();
    return session;
  }

  /**
   * REAL BUG found and fixed via this mission's own fixture testing
   * (TEST 51 — Stop Discovery): a Stop request (STOP_DISCOVERY) writes
   * `session.discovery.status = 'discovery_stopped'` from its OWN,
   * independent async chain — but the orchestration loop's in-flight
   * `finalizeComplete`/`finalizeStopped` call may already be holding an
   * in-memory `session` object read from BEFORE that Stop landed. Writing
   * that stale object's terminal status unconditionally would silently
   * CLOBBER a genuine user Stop with a fabricated "discovery_complete" a
   * few milliseconds later — a direct violation of mission section 23
   * ("Do NOT mark discovery_complete" after a Stop; the abort signal
   * interrupting an in-flight wait is fast, but not provably atomic with
   * the Stop handler's own storage write). Fixed the same way this
   * project has fixed every prior instance of this exact race class
   * (see content/livewatch.js's own detailed history): re-read the
   * session FRESH immediately before the one authoritative terminal
   * write, and skip the write entirely if discovery has ALREADY left the
   * 'discovering' state by then (a concurrent Stop, or — defensively —
   * an already-completed prior finalize) — never overwrite an existing
   * terminal state with a different one.
   */
  function finalizeComplete(sessionAtCallTime, host, reason) {
    if (discoveryStopRequested) {
      console.log(LOG_PREFIX, 'finalizeComplete SKIPPED — a Stop was requested (synchronous flag, no storage race possible)');
      return Promise.resolve(sessionAtCallTime);
    }
    return getSession(host).then(function (fresh) {
      var target = fresh || sessionAtCallTime;
      if (discoveryStopRequested || !target.discovery || target.discovery.status !== 'discovering') {
        console.log(LOG_PREFIX, 'finalizeComplete SKIPPED — discovery already left the discovering state:', target.discovery && target.discovery.status);
        return target;
      }
      target.discovery.status = 'discovery_complete';
      target.discovery.discoveryComplete = true;
      target.discovery.stopReason = reason;
      target.discovery.currentTraversalMethod = null;
      // Reconcile against session.rows.length one last time: content/
      // autoscroll.js's/content/loadmore.js's OWN per-cycle writes (reused
      // completely unmodified) persist the session mid-phase with
      // whatever discoveredUnique happened to be at THAT moment — always
      // caught up again at the next phase-boundary (recordExpansionDelta)
      // during normal operation, but this is the one authoritative "we
      // are about to freeze this forever" write, so it re-derives from
      // the real row count directly rather than trusting whatever value
      // happens to be sitting on `target.discovery` already (found via
      // this mission's own real-browser testing — a poll landing exactly
      // mid-scroll-phase could otherwise observe a lagging value at what
      // should be a fully-settled terminal state).
      target.discovery.discoveredUnique = target.rows.length;
      target.discovery.updatedAt = Date.now();
      console.log(LOG_PREFIX, 'DISCOVERY COMPLETE:', reason, 'unique:', target.discovery.discoveredUnique, 'pages:', target.discovery.pagesVisited);
      return setSession(host, target).then(function () { return target; });
    });
  }

  function finalizeStopped(sessionAtCallTime, host, reason, safetyLimitReached) {
    if (discoveryStopRequested) {
      // The user's own STOP_DISCOVERY handler (below) is the SOLE writer
      // of the 'user'-reasoned stop, synchronously guaranteed to win over
      // whatever internal reason (timeout/safety-limit) this call would
      // otherwise have recorded — never overwrite/race it.
      console.log(LOG_PREFIX, 'finalizeStopped SKIPPED (would-be reason: ' + reason + ') — a Stop was requested (synchronous flag, no storage race possible)');
      return Promise.resolve(sessionAtCallTime);
    }
    return getSession(host).then(function (fresh) {
      var target = fresh || sessionAtCallTime;
      if (discoveryStopRequested || !target.discovery || target.discovery.status !== 'discovering') {
        console.log(LOG_PREFIX, 'finalizeStopped SKIPPED — discovery already left the discovering state:', target.discovery && target.discovery.status);
        return target;
      }
      target.discovery.status = 'discovery_stopped';
      target.discovery.discoveryComplete = false;
      target.discovery.discoveredUnique = target.rows.length; // see finalizeComplete's identical reconciliation comment
      target.discovery.stopReason = reason;
      if (safetyLimitReached) target.discovery.safetyLimitReached = true;
      target.discovery.updatedAt = Date.now();
      console.log(LOG_PREFIX, 'DISCOVERY STOPPED:', reason, 'safetyLimitReached:', !!safetyLimitReached, 'unique:', target.discovery.discoveredUnique);
      return setSession(host, target).then(function () { return target; });
    });
  }

  /**
   * Main orchestration loop — one content-script instance's worth of
   * "(scrape) -> scroll to exhaustion -> load-more to exhaustion -> find
   * Next -> click -> wait -> continue", running until discovery genuinely
   * completes, is stopped, or a real navigation hands off to the next
   * instance (identical handoff pattern to content/autopaginate.js).
   *
   * `skipInitialScrape` — true ONLY for the very first call from the
   * START_DISCOVERY handler: popup.js's handleStartLiveSession already
   * scraped and merged page 1's rows as part of the ordinary BAŞLA
   * extraction, before this message is even sent (identical contract to
   * content/autopaginate.js's own START_AUTO_PAGINATE handler).
   */
  async function runDiscoveryLoop(host, skipInitialScrape) {
    var controller = freshAbort();
    var firstIteration = true;
    var iterations = 0;
    console.log(LOG_PREFIX, 'loop start/resume', { url: location.href, skipInitialScrape: !!skipInitialScrape });

    while (true) {
      iterations++;
      if (iterations > MAX_LOOP_ITERATIONS) {
        var runaway = await getSession(host);
        if (stillRunning(runaway)) await finalizeStopped(runaway, host, 'max-loop-iterations-safety-limit', true);
        return;
      }

      var session = await getSession(host);
      if (!stillRunning(session)) return;
      session = ensureInternalEngines(session);
      var cs = session.scraperConfig.containerSelector;

      if (firstIteration && skipInitialScrape) {
        // Page 1 was already scraped AND merged by popup.js's BAŞLA
        // extraction, before START_DISCOVERY was even sent (identical
        // contract to content/autopaginate.js's own skipInitialScrape).
        // Re-scraping it here would find zero genuinely new rows and
        // wrongly attribute the FULL page-1 candidate count as
        // "duplicates" against a bogus zero baseline — instead, just
        // synchronize discovery's own bookkeeping to the already-true
        // state (no dedupe delta attributable to a starting point).
        session.discovery.discoveredUnique = session.rows.length;
        session.discovery.currentPageBaselineCandidateCount = candidateCount(cs);
        session.discovery.updatedAt = Date.now();
        await setSession(host, session);
      } else {
        var settleWait = await root.WSDomWait.waitForDomStable({ quietMs: SETTLE_QUIET_MS, timeoutMs: SETTLE_TIMEOUT_MS, signal: controller.signal });
        if (settleWait.reason === 'aborted') return;

        session = await getSession(host);
        if (!stillRunning(session)) return;
        session = ensureInternalEngines(session);

        // REAL BUG found and fixed via real-browser testing
        // (books.toscrape.com): `pagesVisited` used to be incremented
        // inside onPageAdvance(), called AFTER a successful navigation —
        // but a REAL full-page navigation can (and, observed directly,
        // does) destroy the outgoing content-script instance BEFORE that
        // write ever lands, exactly the real-Chrome race
        // content/autopaginate.js's own bootstrap comment documents in
        // detail for its OWN counter. The fix mirrors autopaginate.js's
        // own battle-tested placement exactly: increment the counter the
        // moment a genuinely new page/state is confirmed SCRAPED (this
        // branch runs exactly once per page/SPA-state, since scroll/
        // Load-More are driven by their own internal per-engine loops,
        // not by this outer loop) and persist it via THIS branch's own
        // setSession call below — well BEFORE the risky navigation
        // attempt for THIS page even begins (STEP 4, further down), so
        // the write is safely committed long before any
        // script-destroying navigation could touch it.
        session.discovery.pagesVisited++;
        // Same real-Chrome race, same fix, for the per-page duplicate-
        // accounting baseline: `firstIteration && !skipInitialScrape`
        // unambiguously identifies a bootstrap-resume's very first pass
        // (the only two entry points into this function are the
        // START_DISCOVERY handler, always skipInitialScrape:true, and
        // this bootstrap, always skipInitialScrape:false/undefined) — a
        // fresh page whose OUTGOING instance's own onPageAdvance() reset
        // may never have landed. Forcing it to 0 here means this page's
        // own candidate count is never wrongly compared against a stale
        // baseline carried over from the page before it.
        if (firstIteration && !skipInitialScrape) {
          session.discovery.currentPageBaselineCandidateCount = 0;
          // BUG REOPEN — real-browser-confirmed race (books.toscrape.com):
          // the OUTGOING instance's own final STEP-4 write
          // (paginationActionSucceeded:true, outcome, toUrl,
          // fingerprintAfter) — dispatched only AFTER
          // waitForNavigationOrMutation already resolved 'url-changed' —
          // can be lost when the real navigation tears down its script
          // context before that async chrome.storage.local.set() call
          // ever completes (the EARLIER 'issued:true' write, dispatched
          // BEFORE the trigger, reliably survives this same race — see
          // that write's own comment). THIS instance existing at all,
          // freshly bootstrapped on a genuinely new page, is itself
          // conclusive proof the navigation succeeded — reconcile any
          // attempt the outgoing instance left dangling (issued but never
          // confirmed) rather than leaving the diagnostic permanently
          // incomplete despite discovery having plainly kept working.
          var dangling = session.discovery.lastPaginationAttempt;
          if (dangling && dangling.paginationActionIssued === true && dangling.paginationActionSucceeded !== true) {
            dangling.paginationActionSucceeded = true;
            dangling.outcome = dangling.outcome || 'url-changed-confirmed-by-resume';
            dangling.toUrl = location.href;
            dangling.fingerprintAfter = diagFingerprint(cs);
            console.log(LOG_PREFIX, 'reconciled a dangling pagination attempt from the outgoing (destroyed) instance', dangling);
          }
        }

        var passResult;
        try {
          passResult = scrapeCurrentPage(session);
        } catch (e) {
          await finalizeStopped(session, host, 'extraction-error');
          return;
        }
        session = passResult.session;
        var afterCandidates = candidateCount(cs);
        // Precise variant here (not recordExpansionDelta) — this is the
        // ONE point in the loop where the real classification outcome
        // (raw DOM matches -> accepted -> genuinely new) is directly
        // available, correctly separating "invalid/excluded" from
        // "duplicate" instead of conflating them (mission section 9's
        // own two separate counters).
        session.discovery = root.WSDiscoveryCore.recordScrapePassOutcome(session.discovery, passResult.rawCount, passResult.accepted.length, passResult.newUniqueCount, session.rows.length, afterCandidates);

        // Content-only loop/state check (mission section 21) — combines
        // URL + content fingerprint + unique count, same
        // WSRunState.computePageSignature primitive content/autopaginate.js
        // already uses, passed through the SAME "reused, not
        // reimplemented" identity check.
        var signature = root.WSRunState.computePageSignature('', passResult.accepted, session.scraperConfig.columns);
        var stateId = root.WSDiscoveryCore.buildTraversalStateId(location.href, signature, session.rows.length);
        var looped = root.WSDiscoveryCore.registerVisitedState(session.discovery, stateId);
        await setSession(host, session);
        if (looped) { await finalizeComplete(session, host, 'traversal-loop-detected'); return; }

        console.log(LOG_PREFIX, 'page scraped', { pagesVisited: session.discovery.pagesVisited, newRows: passResult.newUniqueCount, totalUnique: session.rows.length, url: location.href });
      }
      firstIteration = false;

      // ---- STEP 2: Auto Scroll to exhaustion (existing, unmodified engine) ----
      session = await getSession(host);
      if (!stillRunning(session)) return;
      session.autoScroll.status = 'running'; session.autoScroll.stopReason = null;
      session.autoScroll.consecutiveNoNewData = 0; session.autoScroll.pageSignatures = [];
      session.autoScroll.updatedAt = Date.now();
      await setSession(host, session);
      var beforeScrollUnique = session.rows.length;
      var beforeScrollCandidates = candidateCount(cs);
      var cyclesBefore = session.autoScroll.cycleCount;
      session = await root.WSAutoScroll.runUntilExhausted(session, host, controller, true);
      if (!stillRunning(session)) return;
      session.discovery.scrollCycles += Math.max(0, session.autoScroll.cycleCount - cyclesBefore);
      var afterScrollCandidates = candidateCount(cs);
      session.discovery = root.WSDiscoveryCore.recordExpansionDelta(session.discovery, beforeScrollCandidates, afterScrollCandidates, beforeScrollUnique, session.rows.length);
      if (session.rows.length > beforeScrollUnique) session.discovery.currentTraversalMethod = 'scroll';
      await setSession(host, session);

      // ---- STEP 3: Load More to exhaustion (new, this mission) ----
      session = await getSession(host);
      if (!stillRunning(session)) return;
      session.loadMoreAuto.status = 'running'; session.loadMoreAuto.stopReason = null;
      session.loadMoreAuto.consecutiveNoNewData = 0; session.loadMoreAuto.pageSignatures = [];
      session.loadMoreAuto.updatedAt = Date.now();
      await setSession(host, session);
      var beforeLmUnique = session.rows.length;
      var beforeLmCandidates = candidateCount(cs);
      var clicksBefore = session.loadMoreAuto.clickCount;
      session = await root.WSLoadMore.runUntilExhausted(session, host, controller, true);
      if (!stillRunning(session)) return;
      session.discovery.loadMoreActions += Math.max(0, session.loadMoreAuto.clickCount - clicksBefore);
      var afterLmCandidates = candidateCount(cs);
      session.discovery = root.WSDiscoveryCore.recordExpansionDelta(session.discovery, beforeLmCandidates, afterLmCandidates, beforeLmUnique, session.rows.length);
      if (session.rows.length > beforeLmUnique) session.discovery.currentTraversalMethod = 'load-more';
      session.discovery.totalCycles = session.discovery.scrollCycles + session.discovery.loadMoreActions;
      await setSession(host, session);
      if (session.discovery.totalCycles >= session.discovery.maxTotalCycles) {
        await finalizeStopped(session, host, 'max-total-cycles-safety-limit', true);
        return;
      }

      // ---- STEP 4: current page genuinely exhausted — look for a
      // legitimate next-page control (existing, unmodified detector) ----
      // BUG REOPEN — ACTION-OWNERSHIP DIAGNOSTICS: every field this
      // mission's own spec names (nextCandidateFound, paginationActionIssued,
      // paginationActionSucceeded, fromUrl, toUrl, fingerprintBefore,
      // fingerprintAfter, uniqueBefore, uniqueAfter) is captured into
      // `attemptDiag` below and persisted onto
      // session.discovery.lastPaginationAttempt (readable directly from
      // chrome.storage.local by a real-browser test, not merely inferred
      // from pagesVisited growth) AND emitted via console.log so it shows
      // up in a captured page-console transcript too.
      // `paginationActionIssued` is set ONLY inside wrappedTrigger below,
      // at the exact moment THIS script actually invokes the detected
      // control's own trigger function — proving the extension itself
      // caused the transition, never merely observed one that happened on
      // its own (a manual click, an unrelated timer, etc.).
      var nextInfo;
      try { nextInfo = root.WSNextDetect.findNextControl(cs); } catch (e) { nextInfo = { found: false }; }
      var attemptDiag = {
        at: Date.now(),
        nextCandidateFound: !!nextInfo.found,
        method: nextInfo.method || null,
        disabled: !!nextInfo.disabled,
        fromUrl: location.href,
        fingerprintBefore: diagFingerprint(cs),
        uniqueBefore: session.rows.length,
        paginationActionIssued: false,
        paginationActionSucceeded: false,
        toUrl: null,
        fingerprintAfter: null,
        uniqueAfter: null,
        outcome: null
      };
      if (!nextInfo.found) {
        attemptDiag.outcome = 'no-next-candidate';
        session.discovery.lastPaginationAttempt = attemptDiag;
        await setSession(host, session);
        console.log(LOG_PREFIX, 'PAGINATION ATTEMPT', attemptDiag);
        await finalizeComplete(session, host, 'no-more-mechanisms');
        return;
      }
      if (nextInfo.disabled) {
        attemptDiag.outcome = 'next-disabled';
        session.discovery.lastPaginationAttempt = attemptDiag;
        await setSession(host, session);
        console.log(LOG_PREFIX, 'PAGINATION ATTEMPT', attemptDiag);
        await finalizeComplete(session, host, 'next-disabled');
        return;
      }

      if (session.discovery.pagesVisited >= session.discovery.maxPages) {
        attemptDiag.outcome = 'max-pages-safety-limit';
        session.discovery.lastPaginationAttempt = attemptDiag;
        await setSession(host, session);
        console.log(LOG_PREFIX, 'PAGINATION ATTEMPT', attemptDiag);
        await finalizeStopped(session, host, 'max-pages-safety-limit', true);
        return;
      }

      var urlBefore = location.href;
      // REAL BUG found and fixed via real-browser testing (books.toscrape.com,
      // this exact mission): a real full-page navigation can — and, on a
      // real site, reliably does — destroy this outgoing content-script
      // instance in the SAME synchronous tick the trigger fires
      // (`nextInfo.trigger()` for a real <a href> control performs actual
      // browser navigation; navigateTrigger's `location.href = url` even
      // more directly), well before any async `chrome.storage.local.set()`
      // issued AFTER that point is guaranteed to have even been DISPATCHED
      // to the browser process, let alone completed — the exact same race
      // class this file's own `pagesVisited` fix (above, in the per-page
      // scrape branch) already fights, for the same underlying reason.
      // Confirmed directly: a first version of this diagnostic that only
      // wrote `lastPaginationAttempt` AFTER `waitForNavigationOrMutation`
      // resolved lost that write on a real navigation nearly every time —
      // pagesVisited (written earlier, safely pre-navigation, by the FRESH
      // page's own next scrape pass) still advanced correctly, but the
      // diagnostic proving the extension itself issued the action was
      // silently empty, which would make this mission's own real-browser
      // verification test flag a false failure. Fixed the same way: get
      // `paginationActionIssued: true` written and DISPATCHED to
      // chrome.storage.local's browser-side backend BEFORE the trigger is
      // ever invoked, not after.
      session.discovery.lastPaginationAttempt = attemptDiag;
      var wrappedTrigger = function () {
        attemptDiag.paginationActionIssued = true;
        console.log(LOG_PREFIX, 'ISSUING pagination action (extension-driven, no user click involved)', { method: nextInfo.method, fromUrl: urlBefore });
        // Fire-and-forget, deliberately NOT awaited (there is no
        // synchronous opportunity to await anything between "decide to
        // trigger" and "actually trigger" — see the comment above): a raw
        // chrome.storage.local.set() call still DISPATCHES its IPC message
        // to the browser process the moment it's called, independent of
        // whether this renderer is still alive by the time its own
        // callback would have fired. Uses the plain API directly (not
        // setSession's Promise wrapper) purely to avoid any unnecessary
        // microtask indirection between this line and the trigger call
        // immediately below it.
        try {
          var raceData = {};
          raceData[sessionKey(host)] = session;
          chrome.storage.local.set(raceData);
        } catch (e) { /* best-effort only — the outer setSession call already persisted issued:false a moment ago */ }
        try {
          nextInfo.trigger();
        } catch (e) {
          // BUG REOPEN root-cause hardening: this call runs SYNCHRONOUSLY
          // inside content/domwait.js's own Promise executor
          // (waitForNavigationOrMutation) — on a real, dynamically-
          // rendered page the detected control can be removed/replaced
          // between detection and invocation (or otherwise throw), and an
          // uncaught throw here would silently REJECT that promise. With
          // nothing downstream ever catching a rejection at that exact
          // point, the entire discovery run would freeze permanently at
          // 'discovering' with zero further activity and no error ever
          // surfaced — precisely this bug report's own symptom. Catching
          // it here keeps this one attempt's diagnostics honest
          // (issued:true, succeeded:false via the timeout branch below)
          // without ever letting a site-side DOM quirk kill the whole
          // loop silently. (runDiscoveryLoopSafe, below, is the second,
          // outer layer of the same guarantee for any OTHER unguarded
          // exception anywhere else in this loop.)
          attemptDiag.triggerError = (e && e.message) || String(e);
          console.error(LOG_PREFIX, 'pagination trigger threw — attempt will honestly report failure, not hang', attemptDiag.triggerError);
        }
      };
      await setSession(host, session);
      var navResult = await root.WSDomWait.waitForNavigationOrMutation({
        timeoutMs: NAV_TIMEOUT_MS, urlBefore: urlBefore, signal: controller.signal, trigger: wrappedTrigger
      });
      if (navResult === 'aborted') {
        attemptDiag.outcome = 'aborted';
        console.log(LOG_PREFIX, 'PAGINATION ATTEMPT', attemptDiag);
        return;
      }

      if (navResult === 'timeout') {
        attemptDiag.outcome = 'timeout';
        attemptDiag.toUrl = location.href;
        attemptDiag.fingerprintAfter = diagFingerprint(cs);
        console.log(LOG_PREFIX, 'PAGINATION ATTEMPT', attemptDiag);
        // A timeout means NO navigation was ever observed — unlike the
        // url-changed/dom-changed branches below, this script instance is
        // guaranteed still alive (nothing destroyed it), so — unlike
        // those branches — persisting the full attemptDiag directly here
        // is safe and reliable, not subject to the outgoing-instance
        // race documented above finalizeStopped's own internal re-read
        // would otherwise silently drop this write.
        var stalled = await getSession(host) || session;
        if (stalled.discovery) {
          stalled.discovery.lastPaginationAttempt = attemptDiag;
          await setSession(host, stalled);
        }
        if (stillRunning(stalled)) await finalizeStopped(stalled, host, 'page-load-timeout');
        return;
      }

      attemptDiag.outcome = navResult; // 'url-changed' | 'dom-changed'
      attemptDiag.paginationActionSucceeded = true;
      attemptDiag.toUrl = location.href;
      attemptDiag.fingerprintAfter = diagFingerprint(cs);

      session = await getSession(host);
      if (!stillRunning(session)) return;
      attemptDiag.uniqueAfter = session.rows.length;
      var newUrl = location.href;

      if (navResult === 'url-changed') {
        if (!root.WSRunState.isSameOrigin(newUrl, session.hostname)) {
          session.discovery.lastPaginationAttempt = attemptDiag;
          console.log(LOG_PREFIX, 'PAGINATION ATTEMPT', attemptDiag);
          await finalizeComplete(session, host, 'origin-changed');
          return;
        }
        if (session.discovery.visitedUrls.indexOf(newUrl) !== -1) {
          session.discovery.lastPaginationAttempt = attemptDiag;
          console.log(LOG_PREFIX, 'PAGINATION ATTEMPT', attemptDiag);
          await finalizeComplete(session, host, 'url-repeat');
          return;
        }
        session.discovery.visitedUrls.push(newUrl);
        if (session.discovery.visitedUrls.length > root.WSDiscoveryCore.DEFAULT_MAX_VISITED_STATES) session.discovery.visitedUrls.shift();
        session = ensureInternalEngines(session);
        session = rearmEnginesForNewPage(session);
        session.discovery = root.WSDiscoveryCore.onPageAdvance(session.discovery);
        session.discovery.lastPaginationAttempt = attemptDiag;
        console.log(LOG_PREFIX, 'PAGINATION ATTEMPT (real navigation confirmed — new page instance resumes)', attemptDiag);
        await setSession(host, session);
        // A real navigation just destroyed (or is about to destroy) this
        // script instance — the freshly-injected instance on the new page
        // picks the loop back up on its own (see bootstrap below).
        return;
      }

      // 'dom-changed' — SPA-style same-document update; this instance is
      // still alive, loop back around and scrape the new content.
      if (newUrl !== urlBefore && session.discovery.visitedUrls.indexOf(newUrl) === -1) {
        session.discovery.visitedUrls.push(newUrl);
      }
      session = ensureInternalEngines(session);
      session = rearmEnginesForNewPage(session);
      session.discovery = root.WSDiscoveryCore.onPageAdvance(session.discovery);
      session.discovery.lastPaginationAttempt = attemptDiag;
      console.log(LOG_PREFIX, 'PAGINATION ATTEMPT (SPA-style content swap confirmed)', attemptDiag);
      await setSession(host, session);
    }
  }

  /** BUG REOPEN (real user-flow report: discovery status stuck at
   * "discovering" forever, no autonomous navigation, only manual
   * navigation ever grew the dataset): runDiscoveryLoop() is invoked
   * fire-and-forget from both the START_DISCOVERY handler and this
   * file's own bootstrap-resume below — an unhandled rejection ANYWHERE
   * in that async function (a real DOM/extraction exception not already
   * caught by scrapeCurrentPage's own try/catch, e.g. from
   * WSAutoScroll.runUntilExhausted/WSLoadMore.runUntilExhausted/
   * WSDiscoveryCore's own helpers) would previously kill the loop
   * completely SILENTLY: no finalize call ever runs, so
   * session.discovery.status stays frozen at 'discovering' forever with
   * no record of why — indistinguishable, from the popup's own UI, from
   * "still legitimately working." This wrapper is the one place both
   * call sites now go through: it never changes what the loop itself
   * does, it only guarantees that if the loop's own promise ever
   * rejects, that failure becomes a visible, honest terminal state
   * (discovery.status = 'error') instead of a silent, unexplained hang. */
  function runDiscoveryLoopSafe(host, skipInitialScrape) {
    var loopPromise;
    try {
      loopPromise = runDiscoveryLoop(host, skipInitialScrape);
    } catch (e) {
      loopPromise = Promise.reject(e);
    }
    return loopPromise.catch(function (err) {
      var msg = (err && err.message) || String(err);
      console.error(LOG_PREFIX, 'runDiscoveryLoop THREW — discovery loop terminated unexpectedly:', msg, err && err.stack);
      return getSession(host).then(function (session) {
        if (!session || !session.discovery) return;
        // Never clobber a real terminal state (complete/stopped) that a
        // finalize* call already committed before the exception hit —
        // same "only write if still discovering" guard finalizeComplete/
        // finalizeStopped already use, for the same reason.
        if (session.discovery.status !== 'discovering') return;
        session.discovery.status = 'error';
        session.discovery.stopReason = 'internal-error: ' + msg;
        session.discovery.discoveredUnique = session.rows.length;
        session.discovery.updatedAt = Date.now();
        return setSession(host, session);
      }).catch(function () { /* best-effort — never throw out of an already-failing path */ });
    });
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return;

    if (message.type === 'START_DISCOVERY') {
      // Session (with discovery already seeded, status:'discovering') must
      // already be persisted before this message arrives — mirrors
      // START_AUTO_PAGINATE's own contract exactly. Resets the stop flag
      // — a fresh START_DISCOVERY always means a brand-new BAŞLA session
      // in this content-script instance's lifetime (a genuinely resumed
      // discovery, e.g. after a real navigation, goes through this file's
      // own bootstrap below instead, which never touched this flag).
      discoveryStopRequested = false;
      runDiscoveryLoopSafe(hostname(), true);
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'STOP_DISCOVERY') {
      // Set SYNCHRONOUSLY, in the same tick as abort() — see this flag's
      // own declaration comment for exactly why this closes a real race
      // an async "read fresh from storage" re-check alone cannot.
      discoveryStopRequested = true;
      if (currentAbortController) currentAbortController.abort();
      getSession(hostname()).then(function (session) {
        if (!session || !session.discovery) { sendResponse({ ok: true }); return; }
        // Mission section 23: Stop preserves the registry as-is —
        // session.rows itself is never touched here. discoveredUnique IS
        // reconciled to the real session.rows.length (never fabricated,
        // simply re-derived from data already sitting right here) — see
        // finalizeComplete's identical comment for why this one-line
        // reconciliation matters at every terminal-state write.
        session.discovery.status = 'discovery_stopped';
        session.discovery.discoveryComplete = false;
        session.discovery.stopReason = 'user';
        session.discovery.discoveredUnique = session.rows.length;
        session.discovery.updatedAt = Date.now();
        setSession(hostname(), session).then(function () { sendResponse({ ok: true }); });
      });
      return true;
    }

    if (message.type === 'GET_DISCOVERY_STATE') {
      getSession(hostname()).then(function (session) {
        sendResponse({ ok: true, discovery: (session && session.discovery) || null, rowCount: session ? session.rows.length : 0 });
      });
      return true;
    }
  });

  // Resume across a real page navigation — identical rationale/pattern to
  // content/autopaginate.js's own bootstrap (stillRunning() rather than a
  // stricter single-status check, for the exact same real-Chrome reason
  // documented there: a navigation can destroy the outgoing instance
  // before its own post-navigation bookkeeping write lands).
  getSession(hostname()).then(function (session) {
    if (stillRunning(session)) {
      console.log(LOG_PREFIX, 'bootstrap: resuming active discovery session', session.sessionId);
      runDiscoveryLoopSafe(hostname());
    }
  }).catch(function () { /* nothing to resume */ });

  root.WSDiscovery = {
    MAX_LOOP_ITERATIONS: MAX_LOOP_ITERATIONS,
    // Exposed for targeted testing only — production code never calls
    // this directly, only through the message listener above.
    runDiscoveryLoop: runDiscoveryLoop
  };
})(window);
