/**
 * healthcheck-rules.test.js (FAST/local, no browser)
 * SELF-DIAGNOSTICS / HEALTH CHECK mission — proves the REAL, unmodified
 * utils/healthcheck.js computeHealthSummary() rules engine (loaded via
 * tests/lib/load-modules.js, never a reimplementation), pure over plain
 * input objects, no chrome APIs or DOM involved.
 *
 * Covers 6 of the mission's own explicitly required test proofs:
 *   1. healthy run reports HEALTHY
 *   2. stale popup while engine advances reports WARNING
 *   3. no progress while RUNNING reports STALLED
 *   4. navigation timeout is detected
 *   5. storage quota error reports FAILED
 *   6. Detail progress freeze is detected
 *
 * Standalone-runnable: `node tests/unit/healthcheck-rules.test.js`.
 */
'use strict';
const { loadModules } = require('../lib/load-modules');
const { makeSuite } = require('../lib/assert');

function run() {
  const suite = makeSuite('healthcheck-rules');
  const assert = suite.assert;
  const sb = loadModules(['utils/healthcheck.js']);
  const HC = sb.WSHealthCheck;

  function baseSession(overrides) {
    return Object.assign({
      sessionId: 's1', status: 'active', updatedAt: Date.now(),
      rows: new Array(462).fill(0).map(function (_, i) { return { c_title: 'row ' + i }; }),
      discovery: Object.assign({
        status: 'discovering', pagesVisited: 8, updatedAt: Date.now(),
        lastPaginationAttempt: null
      }, overrides && overrides.discovery)
    }, overrides, { discovery: Object.assign({ status: 'discovering', pagesVisited: 8, updatedAt: Date.now(), lastPaginationAttempt: null }, overrides && overrides.discovery) });
  }

  // ---- 1. A genuinely healthy, actively-progressing run reports HEALTHY. ----
  {
    var now1 = Date.now();
    var session1 = baseSession({ discovery: { status: 'discovering', pagesVisited: 8, updatedAt: now1 - 2000 } });
    var summary1 = HC.computeHealthSummary({ now: now1, mainSession: session1 });
    assert(summary1.overall === 'HEALTHY', 'MISSION PROOF: a healthy, actively-progressing run reports overall HEALTHY — got ' + summary1.overall + ' (' + summary1.overallReason + ')');
    assert(summary1.mainStatus === 'HEALTHY', 'mainStatus is HEALTHY');
    assert(summary1.overallReason.indexOf('page 8') !== -1 && summary1.overallReason.indexOf('462') !== -1, 'MISSION PROOF: HEALTHY reason names the exact page/row counts — got: ' + summary1.overallReason);
    assert(summary1.pagesVisited === 8 && summary1.resultCount === 462, 'summary exposes currentPage/pagesVisited/resultCount for the UI');
  }

  // ---- 2. Stale popup (UI several pages behind the persisted engine)
  // reports WARNING, not STALLED/FAILED. ----
  {
    var now2 = Date.now();
    var session2 = baseSession({ discovery: { status: 'discovering', pagesVisited: 11, updatedAt: now2 - 1000 } });
    var summary2 = HC.computeHealthSummary({
      now: now2, mainSession: session2,
      uiState: { visiblePagesVisited: 8, visibleResultCount: null, isRunningInUI: true, isCompletedInUI: false }
    });
    assert(summary2.overall === 'WARNING', 'MISSION PROOF: a stale popup (3 pages behind the engine) reports overall WARNING — got ' + summary2.overall + ' (' + summary2.overallReason + ')');
    assert(summary2.uiSyncStatus === 'WARNING', 'uiSyncStatus is WARNING');
    assert(summary2.overallReason.indexOf('3 page') !== -1, 'MISSION PROOF: the reason names the exact page lag (3) — got: ' + summary2.overallReason);
  }

  // ---- 3. No progress at all while status is RUNNING reports STALLED. ----
  {
    var now3 = Date.now();
    var session3 = baseSession({ discovery: { status: 'discovering', pagesVisited: 11, updatedAt: now3 - 45000 }, updatedAt: now3 - 45000 });
    var summary3 = HC.computeHealthSummary({ now: now3, mainSession: session3 });
    assert(summary3.overall === 'STALLED', 'MISSION PROOF: no progress for 45s while RUNNING reports overall STALLED — got ' + summary3.overall + ' (' + summary3.overallReason + ')');
    assert(summary3.mainStatus === 'STALLED' && summary3.reasons.some(function (r) { return r.code === 'no-progress'; }), 'the no-progress rule specifically fired');
    assert(summary3.overallReason.indexOf('45s') !== -1, 'MISSION PROOF: the reason names the exact elapsed time (45s) — got: ' + summary3.overallReason);
  }

  // ---- 4. A pagination trigger issued but never confirmed within the
  // navigation-timeout threshold is detected as its own distinct STALLED
  // reason (navigation timeout), even before the generic no-progress
  // window would otherwise have caught it. ----
  {
    var now4 = Date.now();
    var session4 = baseSession({
      discovery: {
        status: 'discovering', pagesVisited: 11, updatedAt: now4 - 3000,
        lastPaginationAttempt: { at: now4 - 15000, paginationActionIssued: true, paginationActionSucceeded: false, method: 'next-link' }
      }
    });
    var summary4 = HC.computeHealthSummary({ now: now4, mainSession: session4 });
    assert(summary4.overall === 'STALLED', 'MISSION PROOF: navigation issued 15s ago with no confirmation reports overall STALLED — got ' + summary4.overall + ' (' + summary4.overallReason + ')');
    assert(summary4.reasons.some(function (r) { return r.code === 'nav-timeout'; }), 'MISSION PROOF: the nav-timeout rule specifically fired — reasons: ' + JSON.stringify(summary4.reasons));
    assert(summary4.overallReason.indexOf('navigation issued') !== -1 && summary4.overallReason.indexOf('15s') !== -1, 'MISSION PROOF: the reason names "navigation issued...15s ago" — got: ' + summary4.overallReason);
  }

  // ---- 5. A recorded storage quota error reports FAILED, overriding
  // every other (lesser) signal. ----
  {
    var now5 = Date.now();
    var session5 = baseSession({ discovery: { status: 'discovering', pagesVisited: 5, updatedAt: now5 - 1000 } });
    var summary5 = HC.computeHealthSummary({
      now: now5, mainSession: session5,
      storage: { bytesInUse: 500000, quotaBytes: 10485760, quotaErrorDetected: true, quotaErrorAt: now5 - 4000 }
    });
    assert(summary5.overall === 'FAILED', 'MISSION PROOF: a recorded storage quota error reports overall FAILED — got ' + summary5.overall + ' (' + summary5.overallReason + ')');
    assert(summary5.storageStatus === 'FAILED', 'storageStatus is FAILED');
    assert(summary5.overallReason.indexOf('quota exceeded') !== -1, 'MISSION PROOF: the reason explicitly names "quota exceeded" — got: ' + summary5.overallReason);
  }

  // ---- 6. Detail worker actively navigating (URL/index advancing) while
  // completed count is frozen is detected as STALLED. ----
  {
    var now6 = Date.now();
    var summary6 = HC.computeHealthSummary({
      now: now6,
      detail: {
        status: 'running', total: 125, completed: 72, pending: 53,
        workerActive: true, currentUrl: 'https://etsy.com/listing/999', currentIndex: 73,
        lastProgressAt: now6 - 30000
      }
    });
    assert(summary6.overall === 'STALLED', 'MISSION PROOF: Detail worker navigating with completed count frozen for 30s reports overall STALLED — got ' + summary6.overall + ' (' + summary6.overallReason + ')');
    assert(summary6.detailStatus === 'STALLED' && summary6.reasons.some(function (r) { return r.code === 'detail-freeze'; }), 'the detail-freeze rule specifically fired');
    assert(summary6.overallReason.indexOf('completed count has not advanced') !== -1, 'MISSION PROOF: the reason explicitly names "completed count has not advanced" — got: ' + summary6.overallReason);
  }

  // ---- Extra: a Detail run that IS progressing normally never falsely
  // flags detail-freeze (proves the rule is not simply "worker active"). ----
  {
    var now7 = Date.now();
    var summary7 = HC.computeHealthSummary({
      now: now7,
      detail: { status: 'running', total: 125, completed: 90, workerActive: true, currentUrl: 'https://etsy.com/listing/999', currentIndex: 91, lastProgressAt: now7 - 2000 }
    });
    assert(summary7.overall === 'HEALTHY', 'a genuinely progressing Detail run stays HEALTHY — got ' + summary7.overall + ' (' + summary7.overallReason + ')');
  }

  // ---- Extra: no active session/detail at all is HEALTHY-idle, never a
  // false STALLED/WARNING. ----
  {
    var summary8 = HC.computeHealthSummary({});
    assert(summary8.overall === 'HEALTHY', 'an idle extension (no active run) reports HEALTHY, not a false alarm — got ' + summary8.overall);
  }

  // ---- BUG #1 diagnosis requirement: classifyStalledStage() correctly
  // distinguishes auto-scroll / load-more / next-page-detection /
  // navigation / reinjection-bootstrap / no-events-at-all, from the tail
  // of a merged [WS-PAGE-DIAG] event list, and is threaded all the way
  // through computeHealthSummary()'s own mainMessage/overallReason. ----
  {
    function pageEvt(t, stage) { return { t: t, scope: 'pagination', stage: stage, data: null }; }

    // Auto Scroll started, never finished (STAGE 4 with no STAGE 5).
    var t1 = Date.now();
    var events1 = [pageEvt(t1 - 30000, 'STAGE 1/2/3'), pageEvt(t1 - 29000, 'STAGE 4')];
    var guess1 = HC.classifyStalledStage(events1, 'discovering');
    assert(guess1 && guess1.stage === 'auto-scroll', 'MISSION PROOF: STAGE 4 with no following STAGE 5 is classified as auto-scroll — got ' + JSON.stringify(guess1));

    // Load More started, never finished (STAGE 6 with no STAGE 7/8/9).
    var events2 = [pageEvt(t1 - 30000, 'STAGE 5'), pageEvt(t1 - 29000, 'STAGE 6')];
    var guess2 = HC.classifyStalledStage(events2, 'discovering');
    assert(guess2 && guess2.stage === 'load-more', 'MISSION PROOF: STAGE 6 with no following STAGE 7/8/9 is classified as load-more — got ' + JSON.stringify(guess2));

    // Next-page detection started, never resolved (STAGE 10, no 11/12).
    var events3 = [pageEvt(t1 - 30000, 'STAGE 7/8/9'), pageEvt(t1 - 29000, 'STAGE 10')];
    var guess3 = HC.classifyStalledStage(events3, 'discovering');
    assert(guess3 && guess3.stage === 'next-page-detection', 'MISSION PROOF: STAGE 10 with no following STAGE 11/12 is classified as next-page-detection — got ' + JSON.stringify(guess3));

    // Navigation/mutation wait started, never resolved (STAGE 14, no 15).
    var events4 = [pageEvt(t1 - 30000, 'STAGE 13'), pageEvt(t1 - 29000, 'STAGE 14')];
    var guess4 = HC.classifyStalledStage(events4, 'discovering');
    assert(guess4 && guess4.stage === 'navigation', 'MISSION PROOF: STAGE 14 with no following STAGE 15 is classified as navigation — got ' + JSON.stringify(guess4));

    // No pagination events at all -> reinjection/bootstrap suspected.
    var guess5 = HC.classifyStalledStage([], 'discovering');
    assert(guess5 && guess5.stage === 'reinjection-or-bootstrap', 'MISSION PROOF: zero pagination diagnostic events is classified as reinjection-or-bootstrap — got ' + JSON.stringify(guess5));

    // Bootstrap did not resume -> reinjection/bootstrap.
    var events6 = [pageEvt(t1 - 5000, 'STAGE 18 bootstrap-not-resuming')];
    var guess6 = HC.classifyStalledStage(events6, 'discovering');
    assert(guess6 && guess6.stage === 'reinjection-or-bootstrap', 'MISSION PROOF: "bootstrap-not-resuming" as the last event is classified as reinjection-or-bootstrap — got ' + JSON.stringify(guess6));

    // Not 'discovering' -> no classification attempted at all.
    assert(HC.classifyStalledStage(events1, 'discovery_complete') === null, 'classifyStalledStage returns null when discovery is not actively "discovering"');

    // End-to-end: computeHealthSummary() folds the stage guess into
    // BOTH mainMessage and the top-level overallReason (not just a
    // buried per-section field) for a real page-1-stall-shaped input.
    var session9 = {
      sessionId: 's9', status: 'active', updatedAt: t1 - 25000,
      rows: new Array(689).fill(0).map(function (_, i) { return { c_title: 'row ' + i }; }),
      autoScroll: { status: 'running', stopReason: null, cycleCount: 12 },
      loadMoreAuto: { status: 'idle', stopReason: null, clickCount: 0 },
      discovery: { status: 'discovering', pagesVisited: 1, updatedAt: t1 - 25000, lastPaginationAttempt: null }
    };
    var summary9 = HC.computeHealthSummary({ now: t1, mainSession: session9, diagEvents: events1 });
    assert(summary9.overall === 'STALLED', 'end-to-end page-1-stall-shaped input reports STALLED — got ' + summary9.overall);
    assert(summary9.stalledStageGuess && summary9.stalledStageGuess.stage === 'auto-scroll', 'MISSION PROOF: computeHealthSummary() exposes stalledStageGuess end-to-end — got ' + JSON.stringify(summary9.stalledStageGuess));
    assert(summary9.mainMessage.indexOf('likely stage: auto-scroll') !== -1, 'MISSION PROOF: mainMessage includes the stage guess — got: ' + summary9.mainMessage);
    assert(summary9.overallReason.indexOf('likely stage: auto-scroll') !== -1, 'MISSION PROOF: overallReason (the TOP-LEVEL verdict shown first) also includes the stage guess, not just a buried per-section field — got: ' + summary9.overallReason);
  }

  return suite.summarize();
}

if (require.main === module) {
  var result = run();
  process.exit(result.failures ? 1 : 0);
}

module.exports = { run: run };
