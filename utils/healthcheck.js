/**
 * healthcheck.js
 * SELF-DIAGNOSTICS / HEALTH CHECK mission — pure, DOM-free, chrome-free
 * rules engine: given a plain snapshot of already-gathered facts (the
 * persisted main session, the popup's own last-rendered UI state, storage
 * byte usage, Detail Enrichment state), decide HEALTHY / WARNING /
 * STALLED / FAILED and say exactly why. Same "pure function over plain
 * serializable objects, loaded identically everywhere" shape as
 * utils/runstate.js — the actual DATA GATHERING (reading chrome.storage,
 * reading what the popup currently has rendered) lives in popup.js, which
 * is the only context that can see "what the UI currently shows"; this
 * file only ever decides what that data MEANS. Diagnoses only — never
 * mutates/resets/restarts anything (mission section 6).
 *
 * Severity precedence when combining multiple signals into one overall
 * verdict: FAILED > STALLED > WARNING > HEALTHY (worst wins).
 */
(function (root) {
  'use strict';

  // No progress (discovery.updatedAt/session.updatedAt not advancing)
  // while discovery.status === 'discovering' for this long -> STALLED.
  var STALL_NO_PROGRESS_MS = 20000;
  // A pagination trigger was issued (lastPaginationAttempt.
  // paginationActionIssued) but never confirmed succeeded for this long ->
  // STALLED, independent of/in addition to the generic no-progress rule
  // above (content/discovery.js's own NAV_TIMEOUT_MS is 8000ms before it
  // self-resolves to a 'timeout' outcome and finalizes stopped — this is
  // deliberately a little longer, catching the window where a real
  // navigation attempt is hung strictly BEFORE that internal timeout has
  // had a chance to fire and record a terminal state).
  var NAV_TIMEOUT_STALL_MS = 10000;
  // Popup's own last-rendered pagesVisited is at least this many pages
  // behind the persisted engine's own pagesVisited -> WARNING.
  var UI_LAG_PAGES_WARN = 1;
  // Same ratio convention already established by utils/snapshots.js's own
  // quota-pressure warning.
  var STORAGE_WARN_RATIO = 0.8;
  // Detail worker genuinely active (workerActive) and navigating
  // (currentUrl/currentIndex present) but completed count hasn't advanced
  // for this long -> STALLED.
  var DETAIL_FREEZE_MS = 20000;

  var SEVERITY_ORDER = { HEALTHY: 0, WARNING: 1, STALLED: 2, FAILED: 3 };

  function fmtSecs(ms) { return Math.round(ms / 1000); }

  /**
   * BUG #1 diagnosis requirement — "capture the exact page-1 stall and
   * tell us whether it is: auto-scroll / load-more / next-page detection
   * / navigation / reinjection-bootstrap / UI-sync-only / another
   * discovery stage." Pure, examines the TAIL of the merged diagnostic
   * event list (content/discovery.js's own [WS-PAGE-DIAG] STAGE markers,
   * forwarded into ws_pagination_diag and merged in by popup.js's
   * mergedDiagEvents()) for a "started but never finished" pair — the
   * single most recent 'pagination'-scope event determines which
   * internal phase never returned, since every phase logs its OWN start
   * marker immediately before entering and its OWN finish marker
   * immediately after returning (see content/discovery.js's own STAGE
   * 4/5, 6/7-8-9, 10/11-12, 13/14/15 pairs).
   *
   * @param {Array<{t,scope,stage,data}>} diagEvents chronologically
   *   sorted (oldest first) — see popup.js's mergedDiagEvents()
   * @param {string} discoveryStatus
   * @returns {{stage:string, detail:string}|null} null when discovery
   *   isn't actively 'discovering' (nothing to classify) or there is
   *   no genuine stall to explain.
   */
  function classifyStalledStage(diagEvents, discoveryStatus) {
    if (discoveryStatus !== 'discovering') return null;
    var pageEvents = (diagEvents || []).filter(function (e) { return e && e.scope === 'pagination'; });
    if (!pageEvents.length) {
      return { stage: 'reinjection-or-bootstrap', detail: 'No pagination diagnostic events recorded at all — the content script may never have (re)started on the current page (reinjection/bootstrap issue), or its own diagnostic buffer was never populated for this run.' };
    }
    var last = pageEvents[pageEvents.length - 1];
    var stage = String(last.stage || '');

    if (/^STAGE 1\/2\/3\b/.test(stage)) {
      return { stage: 'auto-scroll', detail: 'A new loop iteration started (' + stage + ') but never reached Auto Scroll\'s own start marker (STAGE 4) — likely hung inside the per-page scrape/setup step just before it.' };
    }
    if (/^STAGE 4\b/.test(stage)) {
      return { stage: 'auto-scroll', detail: 'Auto Scroll was started (' + stage + ') but never reported finishing (STAGE 5 never followed) — WSAutoScroll.runUntilExhausted appears hung.' };
    }
    if (/^STAGE 6\b/.test(stage)) {
      return { stage: 'load-more', detail: 'Load More detection was started (' + stage + ') but never reported finishing (STAGE 7/8/9 never followed) — WSLoadMore.runUntilExhausted appears hung.' };
    }
    if (/^STAGE 10\b/.test(stage)) {
      return { stage: 'next-page-detection', detail: 'Next-page detection was started (' + stage + ') but never reported a result (STAGE 11/12 never followed) — WSNextDetect.findNextControl appears hung.' };
    }
    if (/^STAGE 13\b/.test(stage)) {
      return { stage: 'navigation', detail: 'A pagination trigger was issued (' + stage + ') but the navigation/mutation wait never started (STAGE 14 never followed).' };
    }
    if (/^STAGE 14\b/.test(stage)) {
      return { stage: 'navigation', detail: 'The navigation/mutation wait was started (' + stage + ') but never resolved (STAGE 15 never followed) — waitForNavigationOrMutation appears hung beyond its own timeout.' };
    }
    if (/^BOOTSTRAP-start\b/.test(stage)) {
      return { stage: 'reinjection-or-bootstrap', detail: 'A fresh content-script instance began its bootstrap check (' + stage + ') but never reported the result (BOOTSTRAP-session-check never followed).' };
    }
    if (stage === 'STAGE 18 bootstrap-not-resuming') {
      return { stage: 'reinjection-or-bootstrap', detail: 'The most recent content-script instance bootstrapped but did NOT resume discovery (stillRunning was false) — the loop never restarted on this page.' };
    }
    if (/STAGE 16|STAGE 1[78]/.test(stage)) {
      return { stage: 'inconsistent', detail: 'The last recorded pagination event (' + stage + ') looks like a terminal/finalize outcome, but discovery.status is still "discovering" — worth double-checking discovery.status was not left stale by a lost write.' };
    }
    return { stage: 'unknown', detail: 'Last recorded pagination event: "' + stage + '" — does not match a known "started but never finished" pattern; inspect the full event list.' };
  }

  /**
   * @param {object} input
   * @param {number} [input.now] defaults to Date.now()
   * @param {object|null} [input.mainSession] the persisted
   *   ws_live_session::<host> object (or null — no active run)
   * @param {object|null} [input.uiState] { visiblePagesVisited,
   *   visibleResultCount, isRunningInUI, isCompletedInUI } — what the
   *   popup's OWN last render actually showed, never re-derived here
   * @param {object|null} [input.storage] { bytesInUse, quotaBytes,
   *   quotaErrorDetected, quotaErrorAt }
   * @param {object|null} [input.detail] { status, total, completed,
   *   pending, error, timeouts, workerActive, currentUrl, previousUrl,
   *   currentIndex, lastProgressAt }
   * @returns {object} the full health summary — see file header for
   *   severity precedence.
   */
  function computeHealthSummary(input) {
    input = input || {};
    var now = typeof input.now === 'number' ? input.now : Date.now();
    var reasons = []; // [{ severity, code, message }]
    function add(severity, code, message) { reasons.push({ severity: severity, code: code, message: message }); }

    // ---- MAIN SCRAPE / PAGINATION STATUS ----
    // Modeled as ONE underlying signal (content/discovery.js's own
    // discovery.status IS this codebase's pagination engine — there is no
    // separate "pagination-only" state to diagnose independently), so
    // mainStatus/paginationStatus intentionally mirror each other; both
    // are exposed as distinct fields purely to match the mission's own
    // UI field list.
    var mainStatus = 'HEALTHY';
    var mainMessage = 'HEALTHY — no active main scrape';
    var lastProgressAt = null;
    var currentPage = null;
    var pagesVisited = null;
    var resultCount = null;

    var stalledStageGuess = null;
    var session = input.mainSession;
    if (session) {
      resultCount = (session.rows && typeof session.rows.length === 'number') ? session.rows.length
        : (typeof session.rowCount === 'number' ? session.rowCount : null);
      var discovery = session.discovery || null;
      if (discovery) {
        pagesVisited = typeof discovery.pagesVisited === 'number' ? discovery.pagesVisited : null;
        currentPage = pagesVisited;
        lastProgressAt = discovery.updatedAt || session.updatedAt || null;

        if (discovery.status === 'discovering') {
          var sinceProgress = lastProgressAt ? (now - lastProgressAt) : null;
          var attempt = discovery.lastPaginationAttempt;

          var stageCode = null;
          if (attempt && attempt.paginationActionIssued === true && attempt.paginationActionSucceeded !== true && attempt.at &&
              (now - attempt.at) >= NAV_TIMEOUT_STALL_MS) {
            mainStatus = 'STALLED';
            mainMessage = 'STALLED — navigation issued ' + fmtSecs(now - attempt.at) + 's ago, no URL/DOM change';
            stageCode = 'nav-timeout';
          } else if (sinceProgress !== null && sinceProgress >= STALL_NO_PROGRESS_MS) {
            mainStatus = 'STALLED';
            mainMessage = 'STALLED — no progress for ' + fmtSecs(sinceProgress) + 's while status is RUNNING';
            stageCode = 'no-progress';
          } else {
            mainMessage = 'HEALTHY — page ' + (pagesVisited || 1) + ', ' + (resultCount == null ? '?' : resultCount) +
              ' unique rows, last progress ' + (sinceProgress == null ? '?' : fmtSecs(sinceProgress)) + 's ago';
          }

          // Only bother classifying WHICH internal stage looks stuck once
          // a real problem is already indicated above — never runs for a
          // genuinely healthy, progressing discovery. Folded into
          // mainMessage BEFORE add() below, so the stage guess reaches
          // overallReason (derived from reasons[].message) too, not just
          // the per-section mainMessage field.
          if (mainStatus !== 'HEALTHY') {
            stalledStageGuess = classifyStalledStage(input.diagEvents, discovery.status);
            if (stalledStageGuess) mainMessage += ' [likely stage: ' + stalledStageGuess.stage + ' — ' + stalledStageGuess.detail + ']';
            add(mainStatus, stageCode, mainMessage);
          }
        } else if (discovery.status === 'discovery_complete') {
          mainMessage = 'HEALTHY — discovery complete, ' + (pagesVisited || 0) + ' pages, ' + (resultCount == null ? '?' : resultCount) + ' rows';
        } else if (discovery.status === 'discovery_stopped') {
          mainMessage = 'HEALTHY — discovery stopped (' + (discovery.stopReason || 'user') + '), ' + (pagesVisited || 0) + ' pages, ' + (resultCount == null ? '?' : resultCount) + ' rows';
        } else if (discovery.status === 'error') {
          mainStatus = 'FAILED';
          mainMessage = 'FAILED — discovery ended in error: ' + (discovery.stopReason || 'unknown');
          add('FAILED', 'discovery-error', mainMessage);
        }
      } else {
        mainMessage = 'HEALTHY — session active, no automatic discovery on this session';
      }
    }

    // ---- UI <-> ENGINE CONSISTENCY ----
    var uiSyncStatus = 'HEALTHY';
    var uiSyncMessage = 'HEALTHY — UI matches engine state';
    var ui = input.uiState;
    if (session && ui) {
      if (typeof ui.visiblePagesVisited === 'number' && typeof pagesVisited === 'number' && pagesVisited - ui.visiblePagesVisited >= UI_LAG_PAGES_WARN) {
        var lag = pagesVisited - ui.visiblePagesVisited;
        uiSyncStatus = 'WARNING';
        uiSyncMessage = 'WARNING — popup progress is ' + lag + ' page' + (lag === 1 ? '' : 's') + ' behind discovery engine';
        add('WARNING', 'ui-lag-pages', uiSyncMessage);
      }
      if (session.discovery && ui.isRunningInUI && ['discovery_complete', 'discovery_stopped', 'error'].indexOf(session.discovery.status) !== -1) {
        uiSyncStatus = 'WARNING';
        uiSyncMessage = 'WARNING — popup says RUNNING while discovery is terminal (' + session.discovery.status + ')';
        add('WARNING', 'ui-says-running-terminal', uiSyncMessage);
      }
      if (session.discovery && ui.isCompletedInUI && session.discovery.status === 'discovering') {
        uiSyncStatus = 'WARNING';
        uiSyncMessage = 'WARNING — popup says completed while discovery is still running';
        add('WARNING', 'ui-says-complete-running', uiSyncMessage);
      }
      if (typeof ui.visibleResultCount === 'number' && typeof resultCount === 'number' && ui.visibleResultCount !== resultCount) {
        uiSyncStatus = 'WARNING';
        uiSyncMessage = 'WARNING — result count differs between persisted session (' + resultCount + ') and rendered UI (' + ui.visibleResultCount + ')';
        add('WARNING', 'result-count-mismatch', uiSyncMessage);
      }
    }

    // ---- STORAGE HEALTH ----
    var storageStatus = 'HEALTHY';
    var storageMessage = 'HEALTHY — storage usage nominal';
    var storage = input.storage;
    if (storage) {
      if (storage.quotaErrorDetected) {
        storageStatus = 'FAILED';
        storageMessage = 'FAILED — chrome.storage.local quota exceeded' + (storage.quotaErrorAt ? ' (' + fmtSecs(now - storage.quotaErrorAt) + 's ago)' : '');
        add('FAILED', 'storage-quota', storageMessage);
      } else if (typeof storage.bytesInUse === 'number' && typeof storage.quotaBytes === 'number' && storage.quotaBytes > 0) {
        var ratio = storage.bytesInUse / storage.quotaBytes;
        if (ratio >= STORAGE_WARN_RATIO) {
          storageStatus = 'WARNING';
          storageMessage = 'WARNING — storage at ' + Math.round(ratio * 100) + '% of quota (' + storage.bytesInUse + ' / ' + storage.quotaBytes + ' bytes)';
          add('WARNING', 'storage-quota-pressure', storageMessage);
        } else {
          storageMessage = 'HEALTHY — storage at ' + Math.round(ratio * 100) + '% of quota';
        }
      }
    }

    // ---- DETAIL ENRICHMENT HEALTH ----
    var detailStatus = 'HEALTHY';
    var detailMessage = 'HEALTHY — no active Detail Enrichment run';
    var detail = input.detail;
    if (detail && detail.status) {
      var completed = typeof detail.completed === 'number' ? detail.completed : 0;
      var total = typeof detail.total === 'number' ? detail.total : null;
      detailMessage = 'HEALTHY — Detail ' + detail.status + ', ' + completed + (total != null ? '/' + total : '') + ' completed';
      if (detail.status === 'error') {
        detailStatus = 'FAILED';
        detailMessage = 'FAILED — Detail Enrichment ended in error';
        add('FAILED', 'detail-error', detailMessage);
      } else if (detail.workerActive) {
        var sinceDetailProgress = detail.lastProgressAt ? now - detail.lastProgressAt : null;
        var isNavigating = !!(detail.currentUrl && (detail.currentIndex != null || (detail.previousUrl && detail.currentUrl !== detail.previousUrl)));
        if (isNavigating && sinceDetailProgress !== null && sinceDetailProgress >= DETAIL_FREEZE_MS) {
          detailStatus = 'STALLED';
          detailMessage = 'STALLED — Detail worker is navigating but completed count has not advanced for ' + fmtSecs(sinceDetailProgress) + 's';
          add('STALLED', 'detail-freeze', detailMessage);
        }
      }
    }

    // ---- OVERALL (worst wins) ----
    var overall = 'HEALTHY';
    [mainStatus, uiSyncStatus, storageStatus, detailStatus].forEach(function (s) {
      if (SEVERITY_ORDER[s] > SEVERITY_ORDER[overall]) overall = s;
    });
    var overallReason;
    if (reasons.length) {
      var worst = reasons.slice().sort(function (a, b) { return SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]; })[0];
      overallReason = worst.message;
    } else {
      overallReason = mainMessage;
    }

    return {
      overall: overall,
      overallReason: overallReason,
      mainStatus: mainStatus, mainMessage: mainMessage,
      paginationStatus: mainStatus, paginationMessage: mainMessage,
      uiSyncStatus: uiSyncStatus, uiSyncMessage: uiSyncMessage,
      storageStatus: storageStatus, storageMessage: storageMessage,
      detailStatus: detailStatus, detailMessage: detailMessage,
      lastProgressAt: lastProgressAt,
      currentPage: currentPage,
      pagesVisited: pagesVisited,
      resultCount: resultCount,
      reasons: reasons,
      lastError: reasons.length ? reasons[reasons.length - 1].message : null,
      stalledStageGuess: stalledStageGuess
    };
  }

  root.WSHealthCheck = {
    STALL_NO_PROGRESS_MS: STALL_NO_PROGRESS_MS,
    NAV_TIMEOUT_STALL_MS: NAV_TIMEOUT_STALL_MS,
    UI_LAG_PAGES_WARN: UI_LAG_PAGES_WARN,
    STORAGE_WARN_RATIO: STORAGE_WARN_RATIO,
    DETAIL_FREEZE_MS: DETAIL_FREEZE_MS,
    computeHealthSummary: computeHealthSummary,
    classifyStalledStage: classifyStalledStage
  };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
