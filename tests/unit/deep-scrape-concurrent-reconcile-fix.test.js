/**
 * deep-scrape-concurrent-reconcile-fix.test.js (FAST/local, no browser)
 * BUG #2 REGRESSION — "Detail Enrichment navigates but progress is frozen
 * at 72/125" (real production report).
 *
 * ROOT CAUSE (proven by code reading, not guessed — see MISSION.md):
 * reconcileDeepScrapeJob() runs on EVERY incoming extension message
 * (STALL-FIX ROUND 3's own design — a dedicated, response-free
 * chrome.runtime.onMessage listener). Chrome dispatches one message to
 * ALL registered listeners, so the SAME RESUME_DEEP_SCRAPE (or
 * RETRY_FAILED_DEEP_SCRAPE_ITEMS) message a user's own Resume/Retry
 * click sends ALSO reaches that dedicated reconciler — and if the
 * record's lease also happens to be expired (the common case: that is
 * usually WHY the user is clicking Resume at all), reconcileDeepScrapeJob
 * independently calls resumeInterruptedDeepScrapeItems() again. Before
 * this fix, the ownership claim (deepScrapeAbortControllers[runId] =
 * controller) happened several `await`s after the "already running?"
 * check — wide enough for both concurrent calls to pass the check before
 * either claimed the slot, spawning TWO parallel resume loops for the
 * SAME runId. Each holds its own disconnected in-memory `state` snapshot
 * (chrome.storage.local.get() always returns a fresh clone, never a
 * shared reference), so each independently persists its own view of
 * state.counts — the two loops alternately overwrite each other's
 * genuinely-advancing progress. This is exactly the reproduced "worker
 * tab keeps navigating one page after another, but the persisted/
 * displayed completed count never advances" symptom: one loop's worker
 * tab is genuinely, visibly active, while the OTHER loop's stale writes
 * keep clobbering the count back down.
 *
 * FIX: the ownership claim now happens SYNCHRONOUSLY, with zero awaits
 * between the check and the claim, in both resumeInterruptedDeepScrapeItems
 * and retryFailedDeepScrapeItems — plus a matching re-entrancy guard on
 * reconcileDeepScrapeJob itself (protects its own reclaim bookkeeping,
 * i.e. the staleRecoveries counter, from being double-processed).
 *
 * Standalone-runnable: `node tests/unit/deep-scrape-concurrent-reconcile-fix.test.js`.
 */
'use strict';
const { loadBackground, makeFakeResponse } = require('../lib/load-background');
const { makeSuite } = require('../lib/assert');

var TOTAL = 125;
var COMPLETED_COUNT = 72;
var STUCK_INDEX = 72; // 0-based -> record #73

function urlFor(i) { return 'https://example.com/listing/' + (1000 + i); }

function buildStuckState(runId) {
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
    counts: { total: TOTAL, pending: TOTAL - COMPLETED_COUNT, fetching: 0, completed: COMPLETED_COUNT, partial: 0, failed: 0, skipped: 0, timeouts: 0 },
    concurrency: 1, maxAttempts: 1, recordTimeoutMs: 30000,
    stopRequested: false,
    // The exact reported state: record 73 was mid-flight when its own
    // service-worker instance died — an EXPIRED lease with no live
    // controller, precisely what a real user clicking "Resume" on a
    // stalled run finds.
    lease: { recordId: urlFor(STUCK_INDEX), leaseStartedAt: Date.now() - 999999, leaseExpiresAt: Date.now() - 500000, attempt: 1 },
    delayMode: 'custom', customDelayMs: 0,
    currentUrl: null, currentRecordDiag: null, error: null,
    startedAt: Date.now(), updatedAt: Date.now(), finishedAt: null
  };
}

// STORAGE ARCHITECTURE FIX: field VALUES live in the separate
// ws_deepscrape_fields key now, not inline on state.results[url].
function buildStuckFieldsSeed() {
  var seed = {};
  for (var i = 0; i < COMPLETED_COUNT; i++) { seed[urlFor(i)] = { c_title: 'Title ' + i }; }
  return seed;
}

async function run() {
  const suite = makeSuite('deep-scrape-concurrent-reconcile-fix');
  const assert = suite.assert;

  // ---- MAIN PROOF: a real Resume click races background.js's own
  // dedicated reconcile-on-every-message listener — dispatched via the
  // REAL onMessage fan-out (__dispatchMessage), never calling either
  // function directly. Every URL's own call count is tracked so a
  // duplicate-processing regression (the actual bug) is directly
  // observable, not just inferred from the final count. ----
  {
    var callCounts = {};
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(403); }, // force the real-navigation path
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) {
        var url = sb.__tabs.tabs[tabId] && sb.__tabs.tabs[tabId].url;
        callCounts[url] = (callCounts[url] || 0) + 1;
        // Real navigation genuinely succeeds this time — matches the
        // reported "worker tab DOES continue opening product detail
        // pages one by one" (this is the CONTINUING/successful case,
        // deliberately distinct from the round-3 regression test's own
        // "hangs forever" scenario).
        cb({ ok: true, row: { c_title: 'Real title for ' + url } });
      }
    });
    var runId = 'concurrent-reconcile-72-125';
    var state = buildStuckState(runId);
    await sb.setDeepScrapeState(state);
    await sb.setDeepScrapeFields(buildStuckFieldsSeed());
    // No live controller — matches the real reported state (the run's
    // original service-worker instance is gone; nothing left in memory).
    assert(!sb.deepScrapeAbortControllers[runId], 'setup check: no live controller for this runId (matches the real reported dead-SW state)');

    // THE REAL RACE: dispatch ONE message through the REAL onMessage
    // fan-out — exactly what a real popup Resume click produces (Chrome
    // delivers it to every registered listener, including the dedicated
    // reconciler). Never calls resumeInterruptedDeepScrapeItems or
    // reconcileDeepScrapeJob directly.
    await sb.__dispatchMessage({ type: 'RESUME_DEEP_SCRAPE', runId: runId });

    // Let the (single, correctly-deduplicated) resume loop run to
    // completion — poll real persisted state, exactly as the popup's own
    // 5s poll + storage.onChanged listener would observe it.
    var finalState = null;
    var sawMonotonicRegression = false;
    var lastCompleted = COMPLETED_COUNT;
    var waitStart = Date.now();
    while (Date.now() - waitStart < 5000) {
      var s = await sb.getDeepScrapeState();
      if (s && s.counts) {
        // THE DIRECT PROOF that progress genuinely advances and is never
        // clobbered back down by a duplicate stale-snapshot writer (the
        // actual bug: two parallel loops alternately overwriting each
        // other's progress would show completed COUNT GOING BACKWARDS at
        // some point).
        if (s.counts.completed < lastCompleted) sawMonotonicRegression = true;
        lastCompleted = Math.max(lastCompleted, s.counts.completed);
      }
      if (s && s.status !== 'running' && s.status !== 'stopping') { finalState = s; break; }
      await new Promise(function (r) { setTimeout(r, 5); });
    }
    if (!finalState) finalState = await sb.getDeepScrapeState();

    assert(!sawMonotonicRegression, 'BUG #2 REGRESSION: completed count must never go backwards mid-run (a duplicate parallel loop overwriting the other\'s progress with a stale snapshot) — this is the exact reported "frozen at 72/125 while worker keeps navigating" mechanism');
    assert(finalState.status === 'completed', 'MISSION PROOF: the resumed run reaches a real terminal state — got: ' + finalState.status);
    assert(finalState.counts.completed === TOTAL, 'MISSION PROOF: completed count advances all the way to ' + TOTAL + ' (not frozen at 72) — got ' + finalState.counts.completed);

    var finalFieldsMap = await sb.getDeepScrapeFields();
    for (var i = 0; i < COMPLETED_COUNT; i++) {
      var u0 = urlFor(i);
      assert(finalState.results[u0].status === 'completed' && finalFieldsMap[u0].c_title === 'Title ' + i,
        'the original 72 completed records must remain byte-for-byte untouched — record ' + i + ' was altered');
    }
    for (var j = STUCK_INDEX; j < TOTAL; j++) {
      var u1 = urlFor(j);
      assert(finalState.results[u1].status === 'completed', 'MISSION PROOF: record ' + j + ' (after #72) is genuinely persisted as completed — got ' + finalState.results[u1].status);
    }

    // THE DIRECT DUPLICATE-PROCESSING PROOF: every one of the 53
    // remaining URLs (73-125) must have been messaged EXACTLY ONCE. If
    // the race had spawned two parallel loops, at least one URL would
    // show callCounts > 1 (both loops independently picking it up) or
    // the total would exceed 53 — either way, a duplicate-processing
    // regression is directly, numerically visible here, not inferred.
    var processedUrls = Object.keys(callCounts);
    assert(processedUrls.length === TOTAL - STUCK_INDEX, 'MISSION PROOF: exactly ' + (TOTAL - STUCK_INDEX) + ' distinct URLs were processed (no duplicate loop touched extra/repeat URLs) — got ' + processedUrls.length);
    var totalCalls = processedUrls.reduce(function (sum, u) { return sum + callCounts[u]; }, 0);
    assert(totalCalls === TOTAL - STUCK_INDEX, 'MISSION PROOF: every URL was processed EXACTLY ONCE — a duplicate parallel loop would double-process at least one — total calls: ' + totalCalls + ', expected: ' + (TOTAL - STUCK_INDEX));

    // Ownership slot correctly released — no leaked claim blocking a
    // future genuinely-new run.
    assert(!sb.deepScrapeAbortControllers[runId], 'the ownership claim must be released once the run reaches a terminal state');
  }

  // ---- "worker navigation alone is NOT counted as successful
  // completion": a record whose navigation succeeds but yields no usable
  // extracted fields must never be marked 'completed'. ----
  {
    const sb2 = loadBackground({
      fetchImpl: function () { return makeFakeResponse(403); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) {
        // Real navigation succeeds (ok:true) but extracts NOTHING usable
        // — the exact distinction the mission asks to verify.
        cb({ ok: true, row: { c_title: '' } });
      }
    });
    var runId2 = 'navigation-without-extraction';
    var state2 = {
      runId: runId2, status: 'running', fields: [{ id: 'c_title' }],
      results: { 'https://example.com/empty': { status: 'pending', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null } },
      concurrency: 1, maxAttempts: 1, recordTimeoutMs: 30000, stopRequested: false, lease: null,
      delayMode: 'custom', customDelayMs: 0, currentUrl: null, currentRecordDiag: null, error: null,
      startedAt: Date.now(), updatedAt: Date.now(), finishedAt: null
    };
    await sb2.setDeepScrapeState(state2);
    var controller2 = new AbortController();
    sb2.deepScrapeAbortControllers[runId2] = controller2;
    await sb2.runDeepScrapeUrls(state2, ['https://example.com/empty'], controller2);
    var final2 = await sb2.getDeepScrapeState();
    assert(final2.results['https://example.com/empty'].status === 'partial',
      'navigation succeeding with no usable extracted fields must be classified \'partial\', never \'completed\' — got ' + final2.results['https://example.com/empty'].status);
    assert(final2.counts.completed === 0, 'a navigation-only (no real data) record must never inflate the \'completed\' count — got ' + final2.counts.completed);
  }

  // ---- "restarting does not incorrectly reuse a frozen stale counter":
  // a genuinely NEW run (fresh runId) must never be polluted by an OLD
  // 72/125 run's leftover persisted state. ----
  {
    const sb3 = loadBackground({
      fetchImpl: function () { return makeFakeResponse(403); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) { cb({ ok: true, row: { c_title: 'fresh' } }); }
    });
    var oldRunId = 'old-stale-run-72-125';
    await sb3.setDeepScrapeState(buildStuckState(oldRunId)); // leftover 72/125 state, same shape as the real report
    assert((await sb3.getDeepScrapeState()).counts.completed === COMPLETED_COUNT, 'setup check: the old stale 72/125 state is genuinely persisted before the new run starts');

    // A genuinely new run — different runId, exactly what a real "Start"
    // click (not Resume) produces (see popup.js's makeDetailRunId()).
    await sb3.runDeepScrape({ runId: 'brand-new-run', urls: ['https://example.com/new1', 'https://example.com/new2'], fields: [{ id: 'c_title' }] });
    var freshState = await sb3.getDeepScrapeState();
    assert(freshState.runId === 'brand-new-run', 'MISSION PROOF: a fresh run\'s own persisted state has the NEW runId, not the old stale one — got ' + freshState.runId);
    assert(freshState.status === 'completed', 'the fresh run reaches its own real terminal state — got ' + freshState.status);
    assert(freshState.counts.completed === 2 && freshState.counts.total === 2, 'MISSION PROOF: the fresh run\'s counts reflect ONLY its own 2 new URLs, never inheriting the old run\'s 72/125 — got ' + JSON.stringify(freshState.counts));
    assert(Object.keys(freshState.results).indexOf(urlFor(0)) === -1, 'the fresh run\'s results must not contain any of the old stale run\'s URLs');
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
