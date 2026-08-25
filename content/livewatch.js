/**
 * livewatch.js
 * V1 SIMPLIFIED SESSION WORKFLOW: the passive "keep collecting while the
 * user keeps browsing" watcher behind BAŞLA/BİTİR. Deliberately does NOT
 * drive navigation/scrolling/clicking itself (that's content/pagination.js's
 * job, for the separate, still-fully-working explicit Run Mode flow) — it
 * only watches for DOM changes the user's OWN browsing already caused
 * (clicking the site's own next-page link, scrolling, clicking the site's
 * own Load More button) and reacts, so the popup never has to ask "which
 * pagination mode?".
 *
 * Every actual scraping step is a direct call to already-existing, already-
 * tested logic, never reimplemented here:
 *   - WSScraper.runExtraction()      (content/scraper.js)   — get a fresh
 *     snapshot of every currently-matching row on the page right now.
 *   - WSAutoDetect.classifyExtractedRows() (content/autodetect.js) — reject
 *     ad/promo/nav/malformed rows, same logic AUTO mode already uses,
 *     works identically on manually-built columns (structural, not
 *     name-based, inference).
 *   - WSRunState.buildRowKey()/mergeNewRows() (utils/runstate.js) — the
 *     existing dedup mechanism: diff a fresh extraction against
 *     `seenKeys`, keep only genuinely new rows.
 * The only genuinely new piece is the long-lived MutationObserver + quiet-
 * period debounce that decides WHEN to run the pass above — modeled on
 * content/domwait.js's own "wait for the DOM to settle" pattern, adapted
 * to run repeatedly for the life of the session instead of resolving once.
 *
 * Session state lives in chrome.storage.local under
 * `ws_live_session::<hostname>` — NOT chrome.storage.session (see the
 * ROOT CAUSE #3 comment further down for why) — the exact same mechanism
 * (and the exact same reason: survive popup close/reopen, survive a real
 * page navigation destroying this content script) content/pagination.js's
 * own run state already uses for Auto Scroll/Multi-page/Load More. `status` on that
 * object is the single source of truth for "is this session still
 * active?" — re-read fresh at the top of every detection pass (never
 * trusted from a stale in-memory copy), so a BİTİR click from the popup
 * can never be silently overwritten by an in-flight pass that started
 * just before it.
 *
 * Registers its own chrome.runtime.onMessage listener, separate from
 * content.js's and pagination.js's — nothing here touches picking,
 * Current-Page Preview, or the explicit Auto Scroll/Multi-page/Load More
 * loops.
 */
(function (root) {
  'use strict';

  if (window.__wsLiveWatchInjected) return;
  window.__wsLiveWatchInjected = true;

  var LOG_PREFIX = '[Web Scraper:livewatch]';
  var QUIET_MS = 700;       // settle window before re-extracting after a mutation burst
  // Real pages (ads, trackers, "recently viewed" widgets, lazy-loaded
  // images, live-chat badges) can mutate the DOM continuously enough that
  // a pure "reset the timer on every mutation" debounce NEVER goes quiet —
  // this real-Chrome-observed failure mode is why a hard ceiling exists:
  // even under nonstop background noise, a pass is forced at least this
  // often, exactly like content/domwait.js's own waitForDomStable() pairs
  // a quiet-period timer with a hard timeout for the same reason.
  var MAX_WAIT_MS = 4000;
  var MAX_ROWS = 1000;      // soft cap, mirrors WSRunState's DEFAULT_AUTO_SCROLL_LIMITS.maxRows

  function hostname() {
    return location.hostname;
  }

  // Real-Chrome fix: normalize at the KEY level (not at every call site)
  // so no caller can forget — see WSRunState.normalizeHostname's own
  // header comment (utils/runstate.js) for the exact bug this closes.
  function sessionKey(host) {
    return 'ws_live_session::' + root.WSRunState.normalizeHostname(host);
  }

  // REAL-CHROME ROOT CAUSE #3: chrome.storage.session defaults to
  // TRUSTED_CONTEXTS-only access (popup/background/options) — content
  // scripts are NOT granted access unless the background service worker
  // explicitly calls chrome.storage.session.setAccessLevel(), which this
  // codebase never did. That silently explains every symptom exactly:
  // the popup (trusted) wrote the session fine; a content script's read
  // doesn't throw, doesn't error, it just resolves with an empty result
  // — indistinguishable from "genuinely no session" without checking
  // chrome.runtime.lastError, which the original code never did either.
  // Fixed by moving off chrome.storage.session entirely, onto
  // chrome.storage.local — already proven working from THIS extension's
  // content scripts (content.js's column-picker save path has used
  // WSStorage.setState()/chrome.storage.local directly from a content
  // script since V1.2, real-Chrome-verified) — rather than relying on a
  // setAccessLevel() call that would need to be correctly re-asserted
  // for the life of the extension. Also satisfies the explicit
  // requirement that the active session live in a genuinely persistent,
  // extension-owned location, not scoped to any one context's lifetime.
  var STORAGE_AREA_NAME = 'local';

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

  /** DEV-ONLY diagnostic helper: enumerates every ws_live_session::* key
   * CURRENTLY present in storage (not just the one this hostname expects)
   * — directly distinguishes "session was never written" (empty list),
   * "written under another key" (a DIFFERENT key present), and "reader
   * using the wrong key" (the expected key present but getSession still
   * returned null, which would itself be a bug in sessionKey/getSession
   * consistency, verifiable by comparing this list's contents). */
  function listAllSessionKeys() {
    return new Promise(function (resolve) {
      chrome.storage.local.get(null, function (all) {
        var keys = Object.keys(all || {}).filter(function (k) { return k.indexOf('ws_live_session::') === 0; });
        resolve(keys);
      });
    });
  }

  // ---- one active watch per content-script instance (a page only ever
  // has one live session for its own hostname at a time) ----
  var observer = null;
  var quietTimer = null;
  var hardTimer = null;
  var passInFlight = false;
  var passQueuedAgain = false;

  function detachObserver() {
    if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } observer = null; }
    if (quietTimer) { clearTimeout(quietTimer); quietTimer = null; }
    if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
  }

  /** Shared scheduler for every change signal below (DOM mutations, URL/
   * history navigation) — a dual-timer debounce: `quietTimer` keeps
   * getting pushed back by each new signal (settle before re-extracting,
   * so a fast-arriving batch of rows is captured in one pass instead of
   * many partial ones), while `hardTimer` is set ONLY ONCE per burst and
   * is NEVER pushed back — guaranteeing a pass fires at least every
   * MAX_WAIT_MS even if the page never truly goes quiet. `reason` is
   * carried through purely for the dev diagnostic (which signal actually
   * triggered this pass) and never affects behavior. */
  function scheduleDetectionPass(reason) {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(function () { firePass(reason || 'dom-mutation'); }, QUIET_MS);
    if (!hardTimer) hardTimer = setTimeout(function () { firePass('hard-timeout'); }, MAX_WAIT_MS);
  }
  function firePass(reason) {
    if (quietTimer) { clearTimeout(quietTimer); quietTimer = null; }
    if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
    runDetectionPass(reason);
  }

  var NAVIGATION_REASONS = { 'pushState': true, 'replaceState': true, 'popstate': true, 'resume-on-load': true, 'start-watch': true };

  /** One extract -> classify -> dedupe/merge -> persist pass. Always
   * re-reads the session fresh from storage first (never trusts an
   * in-memory copy) so a BİTİR that landed just before this pass started
   * is never silently undone. Every outcome — including a SKIPPED pass
   * (no active session, soft cap reached, extraction threw) — is logged
   * to session.diagnostics, so "did a rescan even happen" is always
   * answerable from the stored session object, not just inferred from
   * whether the row count moved. */
  function runDetectionPass(reason) {
    reason = reason || 'manual';
    if (passInFlight) { passQueuedAgain = true; return; }
    passInFlight = true;
    var host = hostname();
    var pageUrl = location.href;
    var pageChangeDetected = !!NAVIGATION_REASONS[reason];
    getSession(host).then(function (session) {
      if (!session || session.status !== 'active') {
        detachObserver();
        return null; // no session to log a diagnostic entry onto
      }
      // NEW FEATURE — AUTOMATIC PAGINATION real-browser bug, found and
      // fixed via real-site testing (books.toscrape.com): while Auto
      // Next is actively running, content/autopaginate.js ALSO scrapes
      // and persists this exact same session on every page (it has to —
      // that's its whole job). Both this function and that one do
      // "read-entire-session -> mutate a local copy -> write the whole
      // thing back", with no coordination between them — on a freshly
      // loaded page (both fire their own resume-on-load bootstrap at
      // once), a real race was observed: this pass's own write landed
      // AFTER autopaginate.js's had already advanced pageCount/status,
      // and since this function never touches (or even knows about)
      // `autoPaginate`, its own snapshot — read a few ms earlier, before
      // that advance — silently carried the STALE pageCount/status
      // forward and overwrote the newer values, leaving Auto Next
      // permanently stuck. Deferring entirely to autopaginate.js
      // whenever it's actively driving THIS session (it already does
      // the exact same extract/classify/merge/persist work this
      // function would have) removes the race at the source instead of
      // trying to make either side more resilient to it. Zero effect
      // when Auto Next is off/absent (the overwhelming default) — this
      // check is simply never true, so this function's behavior for
      // every session created before this feature existed, or with the
      // toggle left off, is completely unchanged.
      if (session.autoPaginate && session.autoPaginate.enabled && session.autoPaginate.status !== 'stopped') {
        return null;
      }
      // NEW FEATURE — INFINITE SCROLL: identical reasoning/fix as
      // autoPaginate directly above — content/autoscroll.js's own
      // runUntilExhausted() ALSO scrapes and persists this exact same
      // session on every cycle while it is active, so this pass must
      // defer to it for exactly the same race-condition reason. Zero
      // effect when Auto Scroll is off/absent.
      if (session.autoScroll && session.autoScroll.enabled && session.autoScroll.status !== 'stopped') {
        return null;
      }
      // Defensive: WSRunState.mergeNewRows() unconditionally writes
      // progress.rowsCollected — this session's shape is deliberately
      // simpler than the full WSRunState object, so guarantee that one
      // field exists regardless of how the session was created, rather
      // than depending on every caller remembering to include it.
      if (!session.progress) session.progress = { rowsCollected: session.rows.length };
      var datasetBefore = session.rows.length;
      if (session.rows.length >= MAX_ROWS) {
        // Soft cap reached — never delete already-collected rows, just
        // stop growing the dataset further. Still logged: rescanTriggered
        // false, operation NONE.
        return logPass(session, { at: Date.now(), pageUrl: pageUrl, changeReason: reason, pageChangeDetected: pageChangeDetected, rescanTriggered: false, skipReason: 'max-rows-cap', raw: 0, accepted: 0, excluded: 0, duplicates: 0, newRows: 0, datasetBefore: datasetBefore, datasetAfter: datasetBefore, operation: 'NONE' }, host);
      }
      var extraction;
      try {
        extraction = root.WSScraper.runExtraction(session.scraperConfig);
      } catch (e) {
        return logPass(session, { at: Date.now(), pageUrl: pageUrl, changeReason: reason, pageChangeDetected: pageChangeDetected, rescanTriggered: false, skipReason: 'extraction-threw', raw: 0, accepted: 0, excluded: 0, duplicates: 0, newRows: 0, datasetBefore: datasetBefore, datasetAfter: datasetBefore, operation: 'NONE' }, host);
      }
      var candidateRows = extraction.rows || [];
      var accepted = candidateRows;
      if (candidateRows.length >= 5 && root.WSAutoDetect && typeof root.WSAutoDetect.classifyExtractedRows === 'function') {
        try {
          var classified = root.WSAutoDetect.classifyExtractedRows(session.scraperConfig.columns, candidateRows);
          accepted = candidateRows.filter(function (row, idx) {
            var v = classified.verdicts[idx];
            return !v || v.verdict !== 'exclude';
          });
        } catch (e) { /* classification is best-effort — never blocks collection */ }
      }
      // mergeNewRows ALWAYS concatenates onto the session's EXISTING
      // rows (runState.rows.concat(added)) — structurally an append,
      // never a replace. operation is logged as 'APPEND' unconditionally
      // for a completed rescan so this is verifiable, not assumed.
      var merge = root.WSRunState.mergeNewRows(session, accepted, session.scraperConfig.columns);
      session = merge.runState;
      session.lastPassNewRows = merge.newUniqueCount;
      session.lastCheckAt = Date.now();
      session.updatedAt = Date.now();
      return logPass(session, {
        at: Date.now(), pageUrl: pageUrl, changeReason: reason, pageChangeDetected: pageChangeDetected, rescanTriggered: true,
        raw: candidateRows.length, accepted: accepted.length, excluded: candidateRows.length - accepted.length,
        duplicates: accepted.length - merge.newUniqueCount, newRows: merge.newUniqueCount,
        datasetBefore: datasetBefore, datasetAfter: session.rows.length, operation: 'APPEND'
      }, host);
    }).catch(function (e) { console.error(LOG_PREFIX, 'pass failed, waiting for next mutation', e); })
      .then(function () {
        passInFlight = false;
        if (passQueuedAgain) { passQueuedAgain = false; runDetectionPass('queued-retry'); }
      });
  }

  /** Appends one diagnostic entry (capped to the last 20 passes so a long
   * session's storage footprint stays bounded) and persists the session.
   * `session.status` is included per-entry so "is the session still
   * active" is answerable from history, not just the live value. */
  function logPass(session, entry, host) {
    entry.sessionStillActive = session.status === 'active';
    session.diagnostics = (session.diagnostics || []).concat([entry]).slice(-20);
    console.log(LOG_PREFIX, 'pass', entry);
    return setSession(host, session);
  }

  function attachObserver() {
    hookHistoryApi(); // idempotent — safe to call every time a watch (re)starts
    if (observer) return; // already watching
    observer = new MutationObserver(function () { scheduleDetectionPass('dom-mutation'); });
    try {
      observer.observe(document.body, { childList: true, subtree: true });
    } catch (e) {
      observer = null;
    }
  }

  /** Explicit URL/navigation signal, requested independently of DOM
   * mutations: a client-side router (Etsy-style SPA pagination, "Next"
   * without a full reload) may swap content in a way that still triggers
   * childList mutations most of the time, but pushState/replaceState and
   * back/forward (popstate) are hooked directly too, so a same-document
   * navigation is never missed even in an edge case where the resulting
   * DOM change is too subtle for the observer alone. Installed once per
   * page load (guarded) and left in place for the page's lifetime —
   * inert after BİTİR/no active session, since scheduleDetectionPass's
   * own runDetectionPass always re-checks session.status first. */
  function hookHistoryApi() {
    if (window.__wsLiveWatchHistoryHooked) return;
    window.__wsLiveWatchHistoryHooked = true;
    ['pushState', 'replaceState'].forEach(function (method) {
      var original = history[method];
      if (typeof original !== 'function') return;
      history[method] = function () {
        var result = original.apply(this, arguments);
        scheduleDetectionPass(method);
        return result;
      };
    });
    window.addEventListener('popstate', function () { scheduleDetectionPass('popstate'); });
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return;

    if (message.type === 'START_LIVE_WATCH') {
      attachObserver();
      runDetectionPass('start-watch'); // catch anything already on the page beyond the initial extraction
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'STOP_LIVE_WATCH') {
      detachObserver();
      sendResponse({ ok: true });
      return true;
    }

    // DEV-ONLY diagnostics (see popup.js's isDevelopmentInstall()-gated
    // "Copy Session Diagnostic" — same reachability contract as the
    // existing AUTO-detection diagnostic tool). Read-only: returns
    // whatever is already in storage, touches nothing.
    if (message.type === 'GET_LIVE_SESSION_DIAGNOSTIC') {
      var normalizedDomain = root.WSRunState.normalizeHostname(hostname());
      var expectedKey = sessionKey(hostname());
      Promise.all([getSession(hostname()), listAllSessionKeys()]).then(function (results) {
        var session = results[0], allKeys = results[1];
        sendResponse({
          ok: true, session: session, currentUrl: location.href, observing: !!observer,
          // SESSION STORAGE — the exact fields requested: proves whether
          // the problem is (A) never written [allKeys empty], (B) written
          // under another key [allKeys has a DIFFERENT key], (C) written
          // into another storage backend [not applicable once everything
          // uses chrome.storage.local consistently — storageBackend below
          // documents which one this reader actually used], (D) deleted
          // during navigation [allKeys empty but was previously
          // non-empty — compare across two diagnostic reads], or
          // (E) reader using the wrong key [expectedKey would not match
          // an entry actually present in allKeys].
          storageDiagnostic: {
            normalizedDomain: normalizedDomain,
            expectedStorageKey: expectedKey,
            storageBackend: 'chrome.storage.' + STORAGE_AREA_NAME,
            keyExists: !!session,
            allMatchingSessionKeys: allKeys,
            activeSessionId: session ? session.sessionId : null,
            rowCount: session ? session.rows.length : null
          }
        });
      }).catch(function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); });
      return true;
    }
  });

  // Resume across a real page navigation (classic multi-page-style
  // pagination that destroys and re-creates this content script) — same
  // pattern content/pagination.js's own resumeRunState uses: on load,
  // check storage for an already-active session for this hostname, and
  // if found, pick the watch back up on its own without any popup
  // involvement (the popup may well be closed at this exact moment).
  getSession(hostname()).then(function (session) {
    if (session && session.status === 'active') {
      attachObserver();
      runDetectionPass('resume-on-load');
    }
  }).catch(function () { /* ignore — nothing to resume */ });

  root.WSLiveWatch = {
    // Exposed for targeted testing only — production code never calls
    // these directly, only through the message listener above.
    runDetectionPass: runDetectionPass,
    attachObserver: attachObserver,
    detachObserver: detachObserver
  };
})(window);
