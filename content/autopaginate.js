/**
 * autopaginate.js
 * AUTOMATIC PAGINATION (Auto Next) — OPTIONAL, opt-in-per-session
 * automatic continuation of the V1 SIMPLIFIED SESSION WORKFLOW
 * (BAŞLA/BİTİR, content/livewatch.js). OFF by default; when a session's
 * `autoPaginate` field is absent (every session created before this
 * feature existed, and every session where the user left the toggle
 * OFF), this file's message handlers are simply never invoked and its
 * resume-on-load bootstrap is a no-op — existing live-session behavior
 * is byte-for-byte unchanged.
 *
 * Deliberately a SEPARATE file/loop from content/pagination.js's
 * runMultiPageLoop — that is the existing, untouched, explicit Run Mode
 * wizard (user-configured nextButtonConfig, separate ws_run::<hostname>
 * storage key). This file drives the SAME ws_live_session::<hostname>
 * session content/livewatch.js already owns (spec: "Reuse the existing
 * working live-session system... never replace previous rows"), using
 * GENERIC next-control detection (content/nextdetect.js) instead of a
 * user-picked selector, because the live-session flow has no selector-
 * configuration step at all.
 *
 * Structurally mirrors content/pagination.js's runMultiPageLoop closely
 * (same proven shape: read-fresh-state -> act -> wait-for-navigation-or-
 * mutation -> either continue in this instance or hand off to the next
 * one via storage) — reusing content/domwait.js's existing
 * waitForNavigationOrMutation/waitForDomStable exactly as pagination.js
 * does, never reimplementing page-load detection.
 *
 * Registers its own chrome.runtime.onMessage listener, separate from
 * content.js's/pagination.js's/livewatch.js's — nothing here touches
 * picking, manual Run Mode, or the passive MutationObserver watcher.
 */
(function (root) {
  'use strict';

  if (window.__wsAutoPaginateInjected) return;
  window.__wsAutoPaginateInjected = true;

  var LOG_PREFIX = '[Web Scraper:autopaginate]';
  var DEFAULT_MAX_PAGES = 20; // spec: "This is NOT a product limitation. It is only a runaway-loop safety guard."
  var NAV_TIMEOUT_MS = 8000;
  var SETTLE_QUIET_MS = 500;
  var SETTLE_TIMEOUT_MS = 5000;

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

  // Same fast-path-abort pattern content/pagination.js already uses:
  // the storage status check at the top of every loop iteration is the
  // AUTHORITATIVE stop mechanism (works even across a navigation, where
  // this in-memory controller no longer exists) — aborting an in-flight
  // wait too just makes DURDUR/BİTİR feel instant when this script
  // instance happens to still be the live one.
  var currentAbortController = null;
  function freshAbort() {
    currentAbortController = new AbortController();
    return currentAbortController;
  }

  /** True while this session is still eligible for the auto-pagination
   * loop to keep running: the session itself must be 'active' (BİTİR —
   * STOP_LIVE_WATCH's sibling — sets 'finished' and this must stop
   * immediately, same as it stops the passive watcher), and
   * autoPaginate must exist, be enabled, and not already stopped
   * (DURDUR, or a previous natural stop condition). */
  function stillRunning(session) {
    return !!(session && session.status === 'active' && session.autoPaginate &&
      session.autoPaginate.enabled && session.autoPaginate.status !== 'stopped');
  }

  function finalize(session, host, reason) {
    session.autoPaginate.status = 'stopped';
    session.autoPaginate.stopReason = reason;
    session.autoPaginate.updatedAt = Date.now();
    console.log(LOG_PREFIX, 'STOP REASON:', reason, 'pages:', session.autoPaginate.pageCount, 'rows:', session.rows.length);
    return setSession(host, session);
  }

  /** Extract -> (best-effort) classify -> dedupe/merge -> persist — the
   * exact same three primitives content/livewatch.js's own
   * runDetectionPass uses (WSScraper.runExtraction /
   * WSAutoDetect.classifyExtractedRows / WSRunState.mergeNewRows), so a
   * row accepted/rejected by Auto Next is judged identically to one
   * accepted/rejected by the passive watcher. Never reimplements any of
   * this logic — only reuses it. */
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
    var merge = root.WSRunState.mergeNewRows(session, accepted, session.scraperConfig.columns);
    session = merge.runState;
    session.lastPassNewRows = merge.newUniqueCount;
    session.lastCheckAt = Date.now();
    session.updatedAt = Date.now();
    return { session: session, accepted: accepted, newUniqueCount: merge.newUniqueCount };
  }

  /**
   * One "(maybe scrape) -> find Next -> click -> wait -> continue" cycle
   * per content-script instance. Runs until this session either stops
   * naturally, is told to stop (DURDUR/BİTİR), or a real navigation
   * hands the loop off to the next content-script instance (see the
   * file header comment).
   *
   * `skipInitialScrape` — true ONLY for the very first call, made by the
   * START_AUTO_PAGINATE message handler right after BAŞLA: popup.js's
   * handleStartLiveSession has ALREADY scraped and merged page 1's rows
   * as part of the ordinary BAŞLA extraction, before this loop is even
   * started, so re-scraping the identical page here would find zero
   * genuinely new rows and immediately (and wrongly) trip the
   * "navigation produced no new rows -> stop" condition before ever
   * reaching page 2. Every OTHER entry point — bootstrapResume (a fresh
   * script instance after a real navigation) and the loop's own
   * 'dom-changed' continuation (an SPA route change within the same
   * instance) — always land on a page that has never been scraped by
   * anything yet, so they always scrape first.
   */
  async function runAutoPaginateLoop(host, skipInitialScrape) {
    var controller = freshAbort();
    console.log(LOG_PREFIX, 'loop start/resume', { url: location.href, skipInitialScrape: !!skipInitialScrape });
    var firstIteration = true;

    while (true) {
      var session = await getSession(host);
      if (!stillRunning(session)) {
        console.log(LOG_PREFIX, 'loop exiting — session no longer eligible', session && session.status, session && session.autoPaginate && session.autoPaginate.status);
        return;
      }
      var ap = session.autoPaginate;

      if (!(firstIteration && skipInitialScrape)) {
        // ---- scrape the page we just landed on ----
        var settleWait = await root.WSDomWait.waitForDomStable({ quietMs: SETTLE_QUIET_MS, timeoutMs: SETTLE_TIMEOUT_MS, signal: controller.signal });
        if (settleWait.reason === 'aborted') return;

        session = await getSession(host);
        if (!stillRunning(session)) return;
        ap = session.autoPaginate;

        var passResult;
        try {
          passResult = scrapeCurrentPage(session);
        } catch (e) {
          await finalize(session, host, 'page-load-timeout');
          return;
        }
        session = passResult.session;

        // CONTENT-ONLY signature — deliberately NOT location.href, unlike
        // content/pagination.js's own use of this same shared helper.
        // WSRunState.computePageSignature(url, rows, cols) returns
        // "url::contentHash"; passing a constant '' here collapses that
        // to a pure content fingerprint (reusing the exact same trusted
        // hash algorithm, not reimplementing it) — spec's own explicit
        // requirement: "URL changes but result fingerprint is identical
        // -> stop". A URL-inclusive signature (pagination.js's own use)
        // can never satisfy that by construction (two different URLs
        // always produce two different combined strings even with
        // byte-identical content) — this session's own
        // autoPaginate.pageSignatures array is entirely separate from
        // pagination.js's own runState.pageSignatures, so this only
        // affects Auto Next's own loop detection, nothing shared.
        var signature = root.WSRunState.computePageSignature('', passResult.accepted, session.scraperConfig.columns);
        if (ap.pageSignatures.indexOf(signature) !== -1) {
          await setSession(host, session);
          await finalize(session, host, 'signature-repeat');
          return;
        }
        ap.pageSignatures.push(signature);
        ap.pageCount++;

        console.log(LOG_PREFIX, 'page scraped', { pageCount: ap.pageCount, newRows: passResult.newUniqueCount, totalRows: session.rows.length, url: location.href });

        if (passResult.newUniqueCount === 0) {
          await setSession(host, session);
          await finalize(session, host, 'no-new-data');
          return;
        }
        if (ap.pageCount >= ap.maxPages) {
          await setSession(host, session);
          await finalize(session, host, 'max-pages');
          return;
        }
        await setSession(host, session);
      }
      firstIteration = false;

      // ---- NEW FEATURE — INFINITE SCROLL coexistence (spec section 14):
      // "scroll current page until exhausted, THEN Next". When the
      // user has ALSO enabled Auto Scroll on this session,
      // content/autoscroll.js's own reusable runUntilExhausted() runs
      // to completion HERE, on every page (including page 1), before
      // this loop ever looks for a Next control — exactly the ordering
      // spec section 2's "preferred behavior" describes. When Auto
      // Scroll is off/absent (the overwhelming default), this whole
      // block is skipped entirely and behavior is identical to before
      // this feature existed. Never two competing scroll loops: this is
      // the ONLY call site that drives scrolling while autoPaginate is
      // active — content/autoscroll.js's own standalone bootstrap
      // explicitly refuses to also start one on a session where
      // autoPaginate is enabled (see that file's own bootstrap comment). ----
      if (session.autoScroll && session.autoScroll.enabled && root.WSAutoScroll) {
        if (session.autoScroll.status === 'stopped') {
          // REAL BUG found and fixed via focused testing (TEST 14):
          // autoScroll only ever reaches 'stopped' HERE (with
          // autoPaginate still stillRunning()) via a natural per-page
          // exhaustion (no-new-data / max-cycles / max-elapsed-time /
          // extraction-error) reached on the PREVIOUS page. A genuine
          // user Stop/Finish always stops autoPaginate too (see
          // handleStopAutoPaginate / STOP_AUTO_SCROLL+STOP_AUTO_PAGINATE
          // both sent together in popup.js), which would have already
          // made the top-of-loop stillRunning(session) check exit this
          // loop before ever reaching this block — so a 'stopped'
          // autoScroll seen here can never be a real user stop. Per spec
          // section 2's flow ("scroll current page until exhausted, THEN
          // Next... on the new page, run Auto Scroll again"), each page
          // gets its own full scroll budget — re-arm it for this page.
          session.autoScroll.status = 'running';
          session.autoScroll.stopReason = null;
          session.autoScroll.cycleCount = 0;
          session.autoScroll.consecutiveNoNewData = 0;
          session.autoScroll.pageSignatures = [];
          session.autoScroll.updatedAt = Date.now();
          await setSession(host, session);
        }
        // skipInitialScrape:true — by this exact point in the loop, the
        // current page has ALWAYS already been scraped once: either by
        // popup.js's own BAŞLA extraction (page 1) or by THIS loop's own
        // scrape block a few lines above (page 2+, when
        // skipInitialScrape/firstIteration allowed it to run). See
        // content/autoscroll.js's own doc comment on runUntilExhausted
        // for the full reasoning.
        session = await root.WSAutoScroll.runUntilExhausted(session, host, controller, true);
        if (!stillRunning(session)) return;
        ap = session.autoPaginate;
      }

      // ---- find Next on the CURRENT (now-scraped) page ----
      var nextInfo;
      try {
        nextInfo = root.WSNextDetect.findNextControl(session.scraperConfig.containerSelector);
      } catch (e) {
        nextInfo = { found: false };
      }
      if (!nextInfo.found) { await finalize(session, host, 'no-next'); return; }
      if (nextInfo.disabled) { await finalize(session, host, 'next-disabled'); return; }

      // ---- trigger it, and wait for either a real navigation or an
      // in-place (SPA-style) content swap — never a fixed sleep. ----
      var urlBefore = location.href;
      ap.status = 'navigating';
      await setSession(host, session);

      var navResult = await root.WSDomWait.waitForNavigationOrMutation({
        timeoutMs: NAV_TIMEOUT_MS,
        urlBefore: urlBefore,
        signal: controller.signal,
        trigger: nextInfo.trigger
      });

      if (navResult === 'aborted') return; // storage was already updated by whoever aborted us (DURDUR/BİTİR)

      if (navResult === 'timeout') {
        // spec: "If page fails to load: stop auto pagination safely and
        // keep collected data." — re-read first in case DURDUR/BİTİR
        // landed while we were waiting.
        var stalled = await getSession(host) || session;
        if (stillRunning(stalled)) await finalize(stalled, host, 'page-load-timeout');
        return;
      }

      // Something changed — re-read fresh (never trust the in-memory
      // copy across an await) before deciding what happens next.
      session = await getSession(host);
      if (!stillRunning(session)) return;
      ap = session.autoPaginate;
      var newUrl = location.href;

      if (navResult === 'url-changed') {
        if (!root.WSRunState.isSameOrigin(newUrl, session.hostname)) {
          await finalize(session, host, 'origin-changed');
          return;
        }
        if (ap.visitedUrls.indexOf(newUrl) !== -1) {
          await finalize(session, host, 'url-repeat');
          return;
        }
        ap.visitedUrls.push(newUrl);
        ap.status = 'running';
        await setSession(host, session);
        // A real navigation just destroyed (or is about to destroy) this
        // script instance — the freshly-injected instance on the new
        // page picks the loop back up on its own (see bootstrapResume
        // below), exactly like content/pagination.js's own
        // 'url-changed' handoff.
        return;
      }

      // 'dom-changed' — SPA-style same-document update; this instance is
      // still alive, so loop back around and scrape the new content
      // (firstIteration is now false, so the scrape block above always
      // runs on the next pass).
      if (newUrl !== urlBefore && ap.visitedUrls.indexOf(newUrl) === -1) ap.visitedUrls.push(newUrl);
      ap.status = 'running';
      await setSession(host, session);
    }
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return;

    if (message.type === 'START_AUTO_PAGINATE') {
      // The session (with its autoPaginate sub-object already seeded by
      // the popup, status:'running') must already be persisted before
      // this message arrives — mirrors START_LIVE_WATCH's own contract.
      // skipInitialScrape:true — this is always page 1, whose rows
      // popup.js's handleStartLiveSession already scraped and merged as
      // part of the ordinary BAŞLA extraction, before this message was
      // even sent.
      runAutoPaginateLoop(hostname(), true);
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'STOP_AUTO_PAGINATE') {
      if (currentAbortController) currentAbortController.abort();
      getSession(hostname()).then(function (session) {
        if (!session || !session.autoPaginate) { sendResponse({ ok: true }); return; }
        session.autoPaginate.status = 'stopped';
        session.autoPaginate.stopReason = 'user';
        session.autoPaginate.updatedAt = Date.now();
        setSession(hostname(), session).then(function () { sendResponse({ ok: true }); });
      });
      return true;
    }
  });

  // Resume across a real page navigation, exactly like
  // content/pagination.js's/content/livewatch.js's own bootstrap: a
  // fresh script instance checks storage on load for a session whose
  // auto-pagination loop was left running by the OUTGOING instance right
  // before a real navigation, and picks it back up on its own — no
  // popup involvement needed (spec test #9/#12: "full page navigation
  // creates new content-script instance -> existing session resumes
  // correctly").
  //
  // REAL BUG found and fixed via real-site testing (books.toscrape.com,
  // a genuine full-page-reload pagination site — unlike every prior
  // JSDOM test, which modeled navigation via history.pushState, a
  // same-document operation that never destroys the running script): a
  // REAL full navigation can — and, observed directly, sometimes does —
  // terminate the outgoing script instance (and everything it was
  // awaiting, including its own pending waitForNavigationOrMutation
  // poll) BEFORE that instance's 'url-changed' handler ever gets to run
  // and write `ap.status = 'running'` back. The navigation itself still
  // succeeds — Chrome doesn't need JS to keep running for its own
  // browser-level navigation to complete — only the outgoing script's
  // own bookkeeping write is lost. Requiring status to be EXACTLY
  // 'running' here meant a resume could permanently wedge at
  // 'navigating' with no script ever picking it back up again. Fixed by
  // using the SAME eligibility check the loop itself already uses
  // (stillRunning() — "not explicitly 'stopped'") instead of a stricter,
  // one-value check: 'navigating' is exactly as resumable as 'running'
  // here — a fresh instance either way just needs to scrape whatever
  // page it actually landed on and continue, which is exactly what
  // runAutoPaginateLoop's own scrape-first (skipInitialScrape:false)
  // behavior already does correctly regardless of which of the two
  // statuses it finds.
  getSession(hostname()).then(function (session) {
    if (stillRunning(session)) {
      console.log(LOG_PREFIX, 'bootstrap: resuming active auto-pagination session', session.sessionId, 'previous status:', session.autoPaginate.status);
      runAutoPaginateLoop(hostname());
    }
  }).catch(function () { /* nothing to resume */ });

  root.WSAutoPaginate = {
    DEFAULT_MAX_PAGES: DEFAULT_MAX_PAGES,
    // Exposed for targeted testing only — production code never calls
    // this directly, only through the message listener above.
    runAutoPaginateLoop: runAutoPaginateLoop
  };
})(window);
