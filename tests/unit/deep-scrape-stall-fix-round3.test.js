/**
 * deep-scrape-stall-fix-round3.test.js (FAST level)
 * STALL-FIX mission ROUND 3 — real production finding: round 2's alarm-
 * based recovery (chrome.alarms, "no live controller" staleness signal)
 * was STILL not enough — the user's own real Etsy retest showed the
 * exact same stall recurring, at the same URL, with STOP again having
 * no visible effect. This project's own environment has now shown a
 * genuine 7-MINUTE real stall on a single chrome.permissions.request()
 * call (see MISSION.md), meaning "no live controller yet" is not a
 * reliable-enough signal under real severe resource pressure — a
 * service worker can be merely extremely slow, not dead, for far longer
 * than round 2 assumed, and STOP going through a message round-trip to
 * that same slow/dead worker can itself never complete.
 *
 * ROUND 3 closes both gaps: (1) a LEASE — a pure, persisted, wall-clock
 * deadline (recordId/leaseStartedAt/leaseExpiresAt/attempt) written
 * BEFORE any operation that might hang, checked by reconciliation as a
 * simple Date.now() comparison, independent of service-worker liveness
 * entirely; (2) STOP made genuinely OUT-OF-BAND — the flag can be set by
 * ANY writer (this file proves the background side of that contract;
 * popup.js writes it directly from its own context) and is reconciled
 * on EVERY incoming extension message, not only a once-a-minute alarm.
 *
 * Loaded via tests/lib/load-background.js. Standalone-runnable:
 * `node tests/unit/deep-scrape-stall-fix-round3.test.js`.
 */
'use strict';
const { loadBackground, makeFakeResponse } = require('../lib/load-background');
const { makeSuite } = require('../lib/assert');

async function run() {
  const suite = makeSuite('deep-scrape-stall-fix-round3');
  const assert = suite.assert;

  // ---- LEASE-BASED staleness is a PURE deadline check, independent of
  // state.updatedAt — proven with a state whose updatedAt is RECENT
  // (would NOT have triggered round 2's own "idle since updatedAt"
  // heuristic) but whose lease has still genuinely expired ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(200); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) {
        var url = sb.__tabs.tabs[tabId] && sb.__tabs.tabs[tabId].url;
        cb({ ok: true, row: { c_r: 'value for ' + url } });
      }
    });
    var stuckUrl = 'https://example.com/lease-expired-but-recently-touched';
    var runId = 'lease-precision-run';
    var state = {
      runId: runId, status: 'running', fields: [{ id: 'c_r' }], results: {}, concurrency: 1, maxAttempts: 1, recordTimeoutMs: 30000,
      stopRequested: false, delayMode: 'custom', customDelayMs: 0,
      currentUrl: stuckUrl, currentRecordDiag: null, error: null,
      // The lease itself is expired...
      lease: { recordId: stuckUrl, leaseStartedAt: Date.now() - 60000, leaseExpiresAt: Date.now() - 1000, attempt: 1 },
      startedAt: Date.now() - 60000,
      // ...but updatedAt is RECENT — round 2's own coarser "idle since
      // updatedAt" heuristic would have wrongly concluded this record is
      // still healthy. The lease is what ROUND 3 actually trusts.
      updatedAt: Date.now() - 500, finishedAt: null
    };
    state.results[stuckUrl] = { status: 'fetching', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    state.counts = sb.deepScrapeCounts(state.results);
    await sb.setDeepScrapeState(state);

    sb.__fireAlarm({ name: 'ws_deepscrape_stall_watchdog' });
    var recovered = null;
    var waitStart = Date.now();
    while (Date.now() - waitStart < 5000) {
      var s = await sb.getDeepScrapeState();
      if (s && s.status !== 'running') { recovered = s; break; }
      await new Promise(function (r) { setTimeout(r, 50); });
    }
    assert(recovered, 'ROUND 3: an expired LEASE alone (regardless of a recent updatedAt) is enough to trigger real recovery — a pure deadline check, not a coarser "how long since anything changed" heuristic');
    assert(recovered.status === 'completed', 'the run reaches a genuine terminal state — got: ' + (recovered && recovered.status));
  }

  // ---- OUT-OF-BAND STOP: a stopRequested flag set by ANY writer (not
  // only persistDeepScrapeStopRequest — proving the CONTRACT popup.js's
  // own direct chrome.storage.local write depends on) is honored by
  // reconciliation ----
  {
    const sb = loadBackground({});
    var url = 'https://example.com/stopped-out-of-band';
    var runId = 'out-of-band-stop-run';
    var state = {
      runId: runId, status: 'stopping', fields: [], results: {}, concurrency: 1, maxAttempts: 1, recordTimeoutMs: 30000,
      // Set exactly as popup.js's own directlyPersistStopRequested does —
      // NOT via any background function call — simulating a real popup
      // write straight to storage while the background is unresponsive.
      stopRequested: true, delayMode: 'custom', customDelayMs: 0,
      currentUrl: url, currentRecordDiag: null, error: null,
      lease: { recordId: url, leaseStartedAt: Date.now() - 5000, leaseExpiresAt: Date.now() + 999999, attempt: 1 }, // lease not even expired — Stop must not need to wait for it either
      startedAt: Date.now() - 60000, updatedAt: Date.now() - 5000, finishedAt: null
    };
    state.results[url] = { status: 'fetching', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    state.counts = sb.deepScrapeCounts(state.results);
    await sb.setDeepScrapeState(state);
    assert(!sb.deepScrapeAbortControllers[runId], 'setup check: no live controller — simulating the background being unresponsive when the popup wrote the flag directly');

    sb.__fireAlarm({ name: 'ws_deepscrape_stall_watchdog' });
    var stopped = null;
    var waitStart2 = Date.now();
    while (Date.now() - waitStart2 < 3000) {
      var s2 = await sb.getDeepScrapeState();
      if (s2 && s2.status === 'stopped') { stopped = s2; break; }
      await new Promise(function (r) { setTimeout(r, 30); });
    }
    assert(stopped, 'ROUND 3: a stopRequested flag written by ANY context (simulating the popup\'s own direct out-of-band storage write) is honored by reconciliation, even with an UN-expired lease — Stop never waits for a lease to expire');
    assert(stopped.results[url].status === 'fetching', 'the interrupted record is left as-is (not fabricated into a failure) — its data is never lost by Stop');
  }

  // ---- Reconciliation fires on ANY incoming extension message, not
  // only the stall-watchdog alarm — proven via the REAL dedicated
  // onMessage listener this file registers (not calling the recovery
  // function directly) ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(200); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) {
        var url = sb.__tabs.tabs[tabId] && sb.__tabs.tabs[tabId].url;
        cb({ ok: true, row: { c_r: 'value for ' + url } });
      }
    });
    var stuckUrl = 'https://example.com/recovered-by-a-poll-message';
    var runId = 'poll-triggered-run';
    var state = {
      runId: runId, status: 'running', fields: [{ id: 'c_r' }], results: {}, concurrency: 1, maxAttempts: 1, recordTimeoutMs: 30000,
      stopRequested: false, delayMode: 'custom', customDelayMs: 0,
      currentUrl: stuckUrl, currentRecordDiag: null, error: null,
      lease: { recordId: stuckUrl, leaseStartedAt: Date.now() - 60000, leaseExpiresAt: Date.now() - 1000, attempt: 1 },
      startedAt: Date.now() - 60000, updatedAt: Date.now() - 60000, finishedAt: null
    };
    state.results[stuckUrl] = { status: 'fetching', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    state.counts = sb.deepScrapeCounts(state.results);
    await sb.setDeepScrapeState(state);

    // Exactly what popup.js's own active polling sends while a job is
    // running/stopping — an ordinary GET_DEEP_SCRAPE_STATE call, NOT the
    // alarm. Dispatches through EVERY real registered onMessage listener
    // (GET_DEEP_SCRAPE_STATE is answered by its own handler; the NEW
    // dedicated reconciler listener also fires for this SAME message,
    // exactly like real Chrome dispatches to every registered listener),
    // proving recovery does not require waiting up to a full minute for
    // the next alarm tick while the popup is simply open and polling.
    var response = await sb.__dispatchMessage({ type: 'GET_DEEP_SCRAPE_STATE' });
    assert(response && response.ok, 'the ordinary GET_DEEP_SCRAPE_STATE poll message is still answered normally by its own real handler');

    var recovered = null;
    var waitStart3 = Date.now();
    while (Date.now() - waitStart3 < 5000) {
      var s3 = await sb.getDeepScrapeState();
      if (s3 && s3.status !== 'running') { recovered = s3; break; }
      await new Promise(function (r) { setTimeout(r, 50); });
    }
    assert(recovered, 'ROUND 3: an ORDINARY poll message (not the alarm) also triggers real recovery of a stalled run — fast recovery while the popup is open, not bounded by the alarm\'s own 1-minute period');
    assert(recovered.status === 'completed', 'the poll-recovered run reaches a genuine terminal state — got: ' + (recovered && recovered.status));
  }

  // ---- Race safety: a run that IS still genuinely alive (live
  // controller present) and has Stop requested is never raced — the
  // reconciler calls .abort() and lets that live run's OWN completion
  // logic write the final state itself, never overwriting it from here ----
  {
    const sb = loadBackground({
      fetchImpl: function (url, fetchOpts) {
        return new Promise(function (resolve, reject) {
          if (fetchOpts && fetchOpts.signal) {
            fetchOpts.signal.addEventListener('abort', function () { var e = new Error('Aborted'); e.name = 'AbortError'; reject(e); });
          }
        });
      }
    });
    var url = 'https://example.com/genuinely-still-alive';
    var runPromise = sb.runDeepScrape({ runId: 'alive-run', urls: [url], fields: [], concurrency: 1 });
    await new Promise(function (r) { setTimeout(r, 30); }); // let it actually start and register its real controller
    assert(sb.deepScrapeAbortControllers['alive-run'], 'setup check: the run is genuinely alive with a real, live controller');

    await sb.persistDeepScrapeStopRequest('alive-run');
    await sb.reconcileDeepScrapeJob(); // simulate a message/alarm arriving while the run is still genuinely alive
    var finalState = await runPromise.then(function () { return sb.getDeepScrapeState(); });
    assert(finalState.status === 'stopped', 'the genuinely-alive run\'s own completion logic (not the reconciler) writes the final stopped state — no race, no corrupted intermediate write');
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
