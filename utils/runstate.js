/**
 * runstate.js
 * Pure, DOM-free run-state logic for Auto Scroll and Multi-page runs: the
 * state shape, cross-pass/cross-page deduplication, stop-condition
 * evaluation, and page-signature loop detection. No chrome.* APIs, no DOM
 * — everything here is a plain function over plain serializable objects,
 * loaded identically in the popup and in the content script.
 *
 * The actual scraping call (WSScraper.runExtraction) and DOM mechanics
 * (scrolling, clicking Next, waiting for stability) live elsewhere
 * (content/pagination.js, content/domwait.js) — this file only decides
 * "given what just happened, what should the run do next."
 */
(function (root) {
  'use strict';

  // V1.20 adds 'paused' — a genuinely distinct, explicitly resumable
  // state from 'stopped'. 'stopped' keeps its exact pre-V1.20 meaning
  // and behavior (including remaining resumable — that was already true
  // since V1.3 and is NOT weakened here); 'paused' is a new, additive
  // capability so a user has a real choice between "pause this and
  // continue in a moment" (Pause) and "I'm done, but still want the
  // option to pick it back up" (Stop) — two distinct actions/statuses
  // rather than Pause silently reusing Stop's exact semantics.
  var STATUSES = ['idle', 'preparing', 'running', 'waiting', 'stopping', 'stopped', 'paused', 'completed', 'error'];

  var DEFAULT_AUTO_SCROLL_LIMITS = { maxRows: 1000, maxScrolls: 100, noNewDataAttempts: 3 };
  // V1.19 additive: delayMs (a configurable pause before each page's
  // Next/URL-pattern action, spec #6 "Delay Between Pages") and
  // retryCount (spec #6 "Retry Count" — how many extra attempts a
  // stalled/timed-out page-change gets before it's treated as a real
  // failure) both default to 0, so an EXISTING saved scraper (whose
  // limits object predates these fields) behaves EXACTLY as before —
  // zero delay, zero retries, identical to V1.3's original single-shot
  // timeout-means-stop behavior.
  var DEFAULT_MULTI_PAGE_LIMITS = { maxPages: 10, maxRows: 1000, delayMs: 0, retryCount: 0 };
  // V1.19 NEW mode. maxClicks mirrors maxPages' role; noNewDataAttempts
  // mirrors Auto Scroll's own stop signal (a Load More button that's
  // still present/enabled but stops producing new rows is just as real
  // a "done" signal as the button disappearing).
  var DEFAULT_LOAD_MORE_LIMITS = { maxClicks: 30, maxRows: 1000, noNewDataAttempts: 3, delayMs: 0, retryCount: 0 };

  function makeId(prefix) {
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  /** V1 SIMPLIFIED SESSION WORKFLOW real-Chrome fix: the active-session
   * lookup must resolve to the SAME storage key regardless of which
   * exact hostname variant happened to be captured — real Chrome showed
   * BAŞLA's popup-side hostname (captured once, from `new URL(tab.url)
   * .hostname` at popup-open time) and a LATER page's content-script
   * `location.hostname` disagreeing on the "www." prefix (e.g.
   * "etsy.com" vs "www.etsy.com" for what is, to the user, the exact
   * same site), so a page-2 content script's session lookup silently
   * found nothing even though the URL/domain itself was correctly
   * detected. Deliberately minimal — strips a leading "www." only, no
   * public-suffix-list/eTLD+1 computation — this project has never
   * needed broader domain canonicalization than the concrete case
   * actually observed. Used ONLY for the active live-collect session's
   * own storage key (ws_live_session::<key>, see popup.js/
   * content/livewatch.js) — every OTHER existing hostname-keyed feature
   * (Saved Scrapers, the per-hostname column template, Monitor, Auto
   * Scroll/Multi-page run state) is intentionally left untouched, exact
   * scope requested. Loaded identically in the popup and the content
   * script (same file, same reason every other function here is). */
  function normalizeHostname(host) {
    if (!host) return host;
    return String(host).toLowerCase().replace(/^www\./, '');
  }

  /**
   * Builds a stable dedup key for one row. Always iterates the known
   * `columns` array (never Object.keys(row)), so key order can never
   * depend on incidental object property insertion order.
   */
  function buildRowKey(row, columns, dedupeKey) {
    if (!dedupeKey || dedupeKey === 'entire-row') {
      return columns.map(function (c) { return row[c.id] || ''; }).join('␟');
    }
    return String(row[dedupeKey] || '');
  }

  function defaultLimitsForMode(mode) {
    if (mode === 'auto-scroll') return DEFAULT_AUTO_SCROLL_LIMITS;
    if (mode === 'load-more') return DEFAULT_LOAD_MORE_LIMITS;
    return DEFAULT_MULTI_PAGE_LIMITS;
  }

  function createRunState(input) {
    var now = Date.now();
    var mode = input.mode; // 'auto-scroll' | 'multi-page' | 'load-more' (V1.19)
    return {
      runId: makeId('run'),
      tabId: input.tabId,
      hostname: input.hostname,
      mode: mode,
      status: 'idle',
      startedAt: now,
      updatedAt: now,
      scraperConfig: {
        containerSelector: input.containerSelector || null,
        columns: input.columns || []
      },
      dedupeKey: input.dedupeKey || 'entire-row',
      limits: input.limits || defaultLimitsForMode(mode),
      progress: {
        scrollCount: 0,
        pageNumber: 1,
        clickCount: 0, // V1.19: Load More's own counter, mirrors pageNumber's role
        rowsCollected: 0,
        lastPassNewRows: 0,
        noNewDataStreak: 0,
        retriesUsed: 0, // attempts spent on the CURRENT page/click action, reset each time it succeeds
        // V1.20: a short, user-facing status string while a retry is in
        // flight (e.g. "Retrying (2 of 3)…"), null the rest of the time
        // — spec's "user-visible error/retry status instead of silent
        // failure". Purely informational; never read by any stop-
        // condition logic.
        retryStatus: null,
        // V1.19: the current numeric value of a URL-pattern run's tracked
        // parameter (e.g. the live ?page= value) — kept in progress
        // rather than re-parsed from location.href each pass, so a page
        // that happens to contain other numbers never causes drift.
        urlPatternValue: (input.urlPatternConfig && typeof input.urlPatternConfig.start === 'number') ? input.urlPatternConfig.start : null
      },
      rows: [],
      seenKeys: {},
      pageSignatures: [],
      nextButtonConfig: input.nextButtonConfig || null,
      // V1.19 additive — both null/'nextButton' for any pre-V1.19 run,
      // preserving the original click-driven-only behavior exactly.
      paginationMethod: input.paginationMethod || 'nextButton',
      urlPatternConfig: input.urlPatternConfig || null,
      stopReason: null,
      error: null
    };
  }

  function setStatus(runState, status, extra) {
    if (STATUSES.indexOf(status) === -1) return runState;
    runState.status = status;
    runState.updatedAt = Date.now();
    if (extra) {
      if (extra.stopReason !== undefined) runState.stopReason = extra.stopReason;
      if (extra.error !== undefined) runState.error = extra.error;
    }
    return runState;
  }

  /**
   * Merges a freshly-extracted pass of rows into the run's accumulated,
   * deduplicated dataset. Rows already seen (by the configured dedupe
   * key) are silently skipped — never re-added, never counted as new.
   */
  function mergeNewRows(runState, newRawRows, columns) {
    var seen = runState.seenKeys || {};
    var added = [];
    (newRawRows || []).forEach(function (row) {
      var key = buildRowKey(row, columns, runState.dedupeKey);
      if (!Object.prototype.hasOwnProperty.call(seen, key)) {
        seen[key] = true;
        added.push(row);
      }
    });
    runState.rows = runState.rows.concat(added);
    runState.seenKeys = seen;
    runState.progress.rowsCollected = runState.rows.length;
    return { runState: runState, newUniqueCount: added.length };
  }

  function evaluateAutoScrollStop(runState) {
    var limits = runState.limits || DEFAULT_AUTO_SCROLL_LIMITS;
    if (runState.rows.length >= limits.maxRows) return { shouldStop: true, reason: 'max-rows' };
    if (runState.progress.scrollCount >= limits.maxScrolls) return { shouldStop: true, reason: 'max-scrolls' };
    if (runState.progress.noNewDataStreak >= (limits.noNewDataAttempts || 3)) return { shouldStop: true, reason: 'no-new-data' };
    return { shouldStop: false, reason: null };
  }

  function evaluateMultiPageStop(runState) {
    var limits = runState.limits || DEFAULT_MULTI_PAGE_LIMITS;
    if (runState.rows.length >= limits.maxRows) return { shouldStop: true, reason: 'max-rows' };
    if (runState.progress.pageNumber >= limits.maxPages) return { shouldStop: true, reason: 'max-pages' };
    return { shouldStop: false, reason: null };
  }

  /** V1.19 — Load More's own stop-condition evaluator, mirroring Auto
   * Scroll's shape (maxRows + a no-new-data streak) since a Load More
   * button, like infinite scroll, has no fixed total to count down from.
   * maxClicks is Load More's analogue of Auto Scroll's maxScrolls. */
  function evaluateLoadMoreStop(runState) {
    var limits = runState.limits || DEFAULT_LOAD_MORE_LIMITS;
    if (runState.rows.length >= limits.maxRows) return { shouldStop: true, reason: 'max-rows' };
    if (runState.progress.clickCount >= limits.maxClicks) return { shouldStop: true, reason: 'max-clicks' };
    if (runState.progress.noNewDataStreak >= (limits.noNewDataAttempts || 3)) return { shouldStop: true, reason: 'no-new-data' };
    return { shouldStop: false, reason: null };
  }

  // =====================================================================
  // V1.19 — URL-pattern pagination: pure helpers for detecting a common
  // page/offset query- or path-parameter in a URL and computing the next
  // page's URL from it. Deliberately narrow (spec #4: "Do NOT assume
  // every numeric URL parameter is pagination") — only a short allow-
  // list of well-known parameter names is ever treated as a pagination
  // signal, never an arbitrary numeric query param.
  // =====================================================================

  var URL_PAGE_QUERY_KEYS = ['page', 'p', 'pg'];
  var URL_OFFSET_QUERY_KEYS = ['start', 'offset'];
  var URL_PATH_PAGE_RE = /\/page\/(\d+)(?:\/|$)/i;

  /**
   * Scans a URL for a recognized pagination parameter. Returns
   * {found:false} if nothing recognizable is present — the caller (popup
   * UI) is expected to fall back to letting the user configure one
   * manually rather than guessing further. 'page'-style params default to
   * a step of 1 (confidently a per-page increment); 'offset'-style params
   * have no reliably inferrable step (that's the page SIZE, which the URL
   * alone never reveals) and come back with step:0 + confidence:'medium'
   * so the UI can prompt the user to confirm/enter it rather than
   * silently guessing wrong and skipping or repeating rows.
   */
  function detectUrlPaginationPattern(urlStr) {
    var u;
    try { u = new URL(urlStr); } catch (e) { return { found: false }; }

    for (var i = 0; i < URL_PAGE_QUERY_KEYS.length; i++) {
      var pk = URL_PAGE_QUERY_KEYS[i];
      var pv = u.searchParams.get(pk);
      if (pv !== null && /^\d+$/.test(pv)) {
        return { found: true, kind: 'query', key: pk, style: 'page', start: parseInt(pv, 10), step: 1, confidence: 'high' };
      }
    }
    var pathMatch = u.pathname.match(URL_PATH_PAGE_RE);
    if (pathMatch) {
      return { found: true, kind: 'path', key: 'page', style: 'page', start: parseInt(pathMatch[1], 10), step: 1, confidence: 'high' };
    }
    for (var j = 0; j < URL_OFFSET_QUERY_KEYS.length; j++) {
      var ok = URL_OFFSET_QUERY_KEYS[j];
      var ov = u.searchParams.get(ok);
      if (ov !== null && /^\d+$/.test(ov)) {
        return { found: true, kind: 'query', key: ok, style: 'offset', start: parseInt(ov, 10), step: 0, confidence: 'medium' };
      }
    }
    return { found: false };
  }

  /** Builds the URL for `nextValue` of a previously-detected/configured
   * pattern. Uses a fresh regex/URLSearchParams substitution against
   * whatever the CURRENT page's URL actually is (never the URL the
   * pattern was originally detected on), so this stays correct even if
   * other, unrelated query params change between pages. Returns null if
   * `currentUrl` no longer matches the configured pattern shape at all
   * (e.g. the site redirected somewhere unexpected) — the caller treats
   * that as "can't continue", never as "silently stop pagination". */
  function buildNextPageUrl(currentUrl, patternConfig, nextValue) {
    if (!patternConfig || !patternConfig.key || typeof nextValue !== 'number' || nextValue < 0) return null;
    try {
      if (patternConfig.kind === 'path') {
        var re = new RegExp('(/' + patternConfig.key + '/)(\\d+)', 'i');
        if (!re.test(currentUrl)) return null;
        return currentUrl.replace(re, '$1' + nextValue);
      }
      var u = new URL(currentUrl);
      u.searchParams.set(patternConfig.key, String(nextValue));
      return u.toString();
    } catch (e) {
      return null;
    }
  }

  /** V1.19 spec #17/#36 — the origin/domain guard: a Next-button click or
   * URL-pattern navigation must never be allowed to silently carry a run
   * onto a different hostname (an ad, an external "related items" link,
   * a login redirect, ...). Pure string comparison so it's testable
   * without a real URL object on both sides; an unparseable candidate
   * URL is treated as "left the origin" (fail closed, never fail open). */
  function isSameOrigin(candidateUrl, expectedHostname) {
    try {
      return new URL(candidateUrl).hostname === expectedHostname;
    } catch (e) {
      return false;
    }
  }

  function simpleHash(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = (h * 31 + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  /** Combines the page URL with a hash of that page's extracted rows, so a
   * genuine "Next" that lands back on already-seen content (a pagination
   * loop) is detectable even if the URL alone looks different. */
  function computePageSignature(url, rowsThisPage, columns) {
    var rowsPart = (rowsThisPage || []).map(function (r) {
      return columns.map(function (c) { return r[c.id] || ''; }).join('|');
    }).join('~');
    return (url || '') + '::' + simpleHash(rowsPart);
  }

  function isPageSignatureRepeated(runState, signature) {
    return runState.pageSignatures.indexOf(signature) !== -1;
  }

  /** V1.20: resumes from EITHER 'stopped' (unchanged pre-V1.20 behavior
   * and meaning) or the new 'paused' status — both leave the run in
   * exactly the accumulated state (rows/seenKeys/pageSignatures/progress
   * counters) it was in, continuing rather than restarting. */
  function resumeRunState(runState) {
    if (runState.status !== 'stopped' && runState.status !== 'paused') return runState;
    runState.status = 'running';
    runState.stopReason = null;
    runState.error = null;
    runState.updatedAt = Date.now();
    return runState;
  }

  /** V1.20: the Pause counterpart to setStatus(runState, 'stopped', ...)
   * — a distinct action from Stop (spec: "Pause must not behave like
   * Stop"). Preserves every already-collected row/progress counter
   * exactly like Stop does; the only difference is the status value
   * itself and what it communicates to the user (temporarily halted and
   * meant to be resumed, vs. a deliberate stop that also happens to
   * remain resumable). */
  function pauseRunState(runState) {
    runState.status = 'paused';
    runState.stopReason = 'user';
    runState.updatedAt = Date.now();
    return runState;
  }

  root.WSRunState = {
    STATUSES: STATUSES,
    DEFAULT_AUTO_SCROLL_LIMITS: DEFAULT_AUTO_SCROLL_LIMITS,
    DEFAULT_MULTI_PAGE_LIMITS: DEFAULT_MULTI_PAGE_LIMITS,
    DEFAULT_LOAD_MORE_LIMITS: DEFAULT_LOAD_MORE_LIMITS,
    defaultLimitsForMode: defaultLimitsForMode,
    createRunState: createRunState,
    setStatus: setStatus,
    buildRowKey: buildRowKey,
    mergeNewRows: mergeNewRows,
    normalizeHostname: normalizeHostname,
    evaluateAutoScrollStop: evaluateAutoScrollStop,
    evaluateMultiPageStop: evaluateMultiPageStop,
    evaluateLoadMoreStop: evaluateLoadMoreStop,
    computePageSignature: computePageSignature,
    isPageSignatureRepeated: isPageSignatureRepeated,
    resumeRunState: resumeRunState,
    pauseRunState: pauseRunState,
    detectUrlPaginationPattern: detectUrlPaginationPattern,
    buildNextPageUrl: buildNextPageUrl,
    isSameOrigin: isSameOrigin
  };
})(typeof window !== 'undefined' ? window : globalThis);
