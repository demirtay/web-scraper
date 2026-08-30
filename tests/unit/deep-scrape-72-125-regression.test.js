/**
 * deep-scrape-72-125-regression.test.js (FAST level)
 * STALL-FIX mission ROUND 3 — the EXACT regression model the user's own
 * real Etsy report described: 72 SUCCESS records, record 73 enters
 * PROCESSING and never responds, records 74-125 pending (53 remaining).
 * Frozen here as a permanent, deterministic regression test against the
 * real, unmodified background.js (only chrome.* and fetch() mocked).
 *
 * Proves both of the mission's own explicit scenarios:
 *   A. Record 73 times out (bounded, no endless retry) and the queue
 *      keeps going — completed 72 remain untouched, records 74-125 all
 *      complete, the job reaches a real terminal state.
 *   B. Record 73 hangs and the user presses STOP: STOPPED is reached
 *      WITHOUT waiting for record 73, all 72 completed results and the
 *      53 remaining pending records are preserved exactly, and a
 *      subsequent RESUME only re-processes the unfinished ones (never
 *      re-touching the 72 already-completed records).
 *
 * Standalone-runnable: `node tests/unit/deep-scrape-72-125-regression.test.js`.
 */
'use strict';
const { loadBackground, makeFakeResponse } = require('../lib/load-background');
const { makeSuite } = require('../lib/assert');

var TOTAL = 125;
var COMPLETED_COUNT = 72;
var STUCK_INDEX = 72; // 0-based -> record #73 (the 73rd of 125)

function urlFor(i) { return 'https://example.com/listing/' + (1000 + i); }

function buildState(runId, recordTimeoutMs) {
  var results = {};
  for (var i = 0; i < TOTAL; i++) {
    var u = urlFor(i);
    if (i < COMPLETED_COUNT) {
      results[u] = { status: 'completed', error: null, httpStatus: 200, finalUrl: u, retryStatus: null, failureType: null };
    } else {
      results[u] = { status: 'pending', error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    }
  }
  return {
    runId: runId, status: 'running', fields: [{ id: 'c_title' }], results: results,
    concurrency: 1, maxAttempts: 1, recordTimeoutMs: recordTimeoutMs,
    stopRequested: false, lease: null, delayMode: 'custom', customDelayMs: 0,
    currentUrl: null, currentRecordDiag: null, error: null,
    startedAt: Date.now(), updatedAt: Date.now(), finishedAt: null
  };
}

// STORAGE ARCHITECTURE FIX: field VALUES live in the separate
// ws_deepscrape_fields key now, not inline on state.results[url] — this
// seeds that companion key to match buildState's own pre-completed
// records.
function buildFieldsSeed() {
  var seed = {};
  for (var i = 0; i < COMPLETED_COUNT; i++) { seed[urlFor(i)] = { c_title: 'Title ' + i }; }
  return seed;
}

function pendingUrls(state, fromIndex) {
  var out = [];
  for (var i = fromIndex; i < TOTAL; i++) out.push(urlFor(i));
  return out;
}

async function run() {
  const suite = makeSuite('deep-scrape-72-125-regression');
  const assert = suite.assert;

  // ---- SCENARIO A: record 73 hangs forever, times out, and the queue
  // continues through 74-125 to a real terminal state ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(403); }, // force the real-navigation path, matching the real reported Etsy shape
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) {
        var url = sb.__tabs.tabs[tabId] && sb.__tabs.tabs[tabId].url;
        if (url === urlFor(STUCK_INDEX)) return; // the exact reported hang — never calls back
        cb({ ok: true, row: { c_title: 'Real title for ' + url } });
      }
    });
    var runId = 'regression-72-125-timeout';
    var state = buildState(runId, 250); // small on purpose — a FAST test cannot wait out a real 30s default
    await sb.setDeepScrapeState(state);
    await sb.setDeepScrapeFields(buildFieldsSeed());

    var urls = pendingUrls(state, STUCK_INDEX); // records 73..125 (53 records) — the 72 already-completed are NOT re-run
    var controller = new AbortController();
    sb.deepScrapeAbortControllers[runId] = controller;
    await sb.runDeepScrapeUrls(state, urls, controller);

    var final = await sb.getDeepScrapeState();
    var finalFields = await sb.getDeepScrapeFields();
    assert(final.status === 'completed', 'MISSION REGRESSION A: the 125-record job reaches a real terminal state despite record 73 hanging forever — got: ' + final.status);
    for (var i = 0; i < COMPLETED_COUNT; i++) {
      var u = urlFor(i);
      if (final.results[u].status !== 'completed' || finalFields[u].c_title !== 'Title ' + i) {
        assert(false, 'the 72 already-completed records must remain byte-for-byte untouched — record ' + i + ' was altered');
        break;
      }
    }
    assert(final.results[urlFor(STUCK_INDEX)].status === 'failed' && final.results[urlFor(STUCK_INDEX)].failureType === 'TIMEOUT',
      'MISSION REGRESSION A: record 73 is honestly classified TIMEOUT (bounded, no endless retry) — got: ' + JSON.stringify(final.results[urlFor(STUCK_INDEX)]));
    var laterCompleted = 0;
    for (var j = STUCK_INDEX + 1; j < TOTAL; j++) { if (final.results[urlFor(j)].status === 'completed') laterCompleted++; }
    assert(laterCompleted === TOTAL - STUCK_INDEX - 1, 'MISSION REGRESSION A: every record AFTER the stuck one (74-125, 52 records) still completes — got ' + laterCompleted + ' of ' + (TOTAL - STUCK_INDEX - 1));
    assert(final.counts.completed === COMPLETED_COUNT + laterCompleted, 'final counts honestly reflect 72 original + ' + laterCompleted + ' newly-completed records');
  }

  // ---- SCENARIO B: record 73 hangs, the user presses STOP — STOPPED is
  // reached WITHOUT waiting for record 73, and RESUME afterward only
  // re-processes the genuinely unfinished records ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(403); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) {
        var url = sb.__tabs.tabs[tabId] && sb.__tabs.tabs[tabId].url;
        if (url === urlFor(STUCK_INDEX)) return; // hangs — this run will be stopped before it ever gets a chance to time out
        cb({ ok: true, row: { c_title: 'Real title for ' + url } });
      }
    });
    var runId2 = 'regression-72-125-stop';
    var state2 = buildState(runId2, 999999); // deliberately huge — proves STOP does not wait for the per-record timeout either
    await sb.setDeepScrapeState(state2);
    await sb.setDeepScrapeFields(buildFieldsSeed());

    var urls2 = pendingUrls(state2, STUCK_INDEX);
    var controller2 = new AbortController();
    sb.deepScrapeAbortControllers[runId2] = controller2;
    var runPromise = sb.runDeepScrapeUrls(state2, urls2, controller2);

    // Let it actually reach and start hanging on record 73.
    var reachedStuck = false;
    var waitStart = Date.now();
    while (Date.now() - waitStart < 3000) {
      var mid = await sb.getDeepScrapeState();
      if (mid && mid.lease && mid.lease.recordId === urlFor(STUCK_INDEX)) { reachedStuck = true; break; }
      await new Promise(function (r) { setTimeout(r, 20); });
    }
    assert(reachedStuck, 'setup check: the run genuinely reached record 73 and is now hanging on it (a real persisted lease for it exists)');

    var t0 = Date.now();
    // The real popup Stop path, out-of-band: persist the request, then
    // (the fast path, since this run IS genuinely alive right here)
    // abort its real controller directly — exactly what
    // reconcileDeepScrapeJob would also do if dispatched via a message.
    await sb.persistDeepScrapeStopRequest(runId2);
    controller2.abort();
    await runPromise;
    var stopElapsed = Date.now() - t0;

    var stopped = await sb.getDeepScrapeState();
    var stoppedFields = await sb.getDeepScrapeFields();
    assert(stopElapsed < 2000, 'MISSION REGRESSION B: STOPPED is reached almost immediately (elapsed ' + stopElapsed + 'ms) — never waiting out record 73\'s own (deliberately huge) per-record timeout');
    assert(stopped.status === 'stopped', 'MISSION REGRESSION B: the job reaches a real STOPPED state — got: ' + stopped.status);
    for (var k = 0; k < COMPLETED_COUNT; k++) {
      var uk = urlFor(k);
      if (stopped.results[uk].status !== 'completed' || stoppedFields[uk].c_title !== 'Title ' + k) {
        assert(false, 'all 72 already-completed results must be preserved exactly through STOP — record ' + k + ' was altered');
        break;
      }
    }
    var remainingPreserved = 0;
    for (var m = STUCK_INDEX; m < TOTAL; m++) { if (stopped.results[urlFor(m)].status !== 'completed') remainingPreserved++; }
    assert(remainingPreserved === TOTAL - STUCK_INDEX, 'MISSION REGRESSION B: all 53 remaining records (73-125) are preserved as not-yet-completed after STOP — got ' + remainingPreserved + ' of ' + (TOTAL - STUCK_INDEX));

    // ---- RESUME: only the genuinely unfinished records (73-125) are
    // re-processed; the 72 already-completed ones are never re-touched ----
    var resumeSb = sb; // same instance/mocks — record 73's mock still hangs forever, so let RESUME's own real per-record timeout handle it this time
    stopped.recordTimeoutMs = 250;
    await resumeSb.setDeepScrapeState(stopped);
    delete resumeSb.deepScrapeAbortControllers[runId2]; // simulate a genuinely fresh resume, no lingering live controller
    await resumeSb.resumeInterruptedDeepScrapeItems({ runId: runId2 });

    var resumed = await resumeSb.getDeepScrapeState();
    var resumedFieldsMap = await resumeSb.getDeepScrapeFields();
    assert(resumed.status === 'completed', 'MISSION REGRESSION B (resume): the resumed job reaches a real terminal state — got: ' + resumed.status);
    for (var n = 0; n < COMPLETED_COUNT; n++) {
      var un = urlFor(n);
      if (resumed.results[un].status !== 'completed' || resumedFieldsMap[un].c_title !== 'Title ' + n) {
        assert(false, 'RESUME must never re-touch an already-completed record — record ' + n + ' was altered');
        break;
      }
    }
    assert(resumed.results[urlFor(STUCK_INDEX)].status === 'failed' && resumed.results[urlFor(STUCK_INDEX)].failureType === 'TIMEOUT',
      'RESUME genuinely re-processes record 73 (which still hangs) and it is honestly classified TIMEOUT — got: ' + JSON.stringify(resumed.results[urlFor(STUCK_INDEX)]));
    var resumedLaterCompleted = 0;
    for (var p = STUCK_INDEX + 1; p < TOTAL; p++) { if (resumed.results[urlFor(p)].status === 'completed') resumedLaterCompleted++; }
    assert(resumedLaterCompleted === TOTAL - STUCK_INDEX - 1, 'RESUME completes every record after the stuck one (52 records) — got ' + resumedLaterCompleted);
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
