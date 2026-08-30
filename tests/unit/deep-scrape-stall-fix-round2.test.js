/**
 * deep-scrape-stall-fix-round2.test.js (FAST level)
 * STALL-FIX mission ROUND 2 — real production finding: the round-1 fix
 * (in-process hard per-record timeout + in-process setInterval watchdog)
 * is real and directly proven by deep-scrape-stall-fix.test.js, but a
 * real manual Etsy retest showed the exact same stall recurring anyway —
 * WITH the round-1 Timeouts counter staying at 0 and STOP having no
 * effect. Root cause: the extension's own MV3 service worker can be
 * terminated while genuinely awaiting a long-pending chrome.tabs.
 * sendMessage response — everything in-memory for that run (including
 * the very setTimeout that was supposed to catch the stall) is destroyed
 * with it. This file proves the ACTUAL fix: chrome.alarms-based recovery
 * that survives a dead service worker, and Stop made resilient the same
 * way (persisted as a storage flag, not only an in-memory abort). Loaded
 * via tests/lib/load-background.js (now with a real in-memory alarms
 * mock + a __fireAlarm() test hook to simulate a genuine wake-up).
 * Standalone-runnable: `node tests/unit/deep-scrape-stall-fix-round2.test.js`.
 */
'use strict';
const { loadBackground, makeFakeResponse } = require('../lib/load-background');
const { makeSuite } = require('../lib/assert');

async function run() {
  const suite = makeSuite('deep-scrape-stall-fix-round2');
  const assert = suite.assert;

  // ---- The alarm is actually created while a run is active, and
  // cleared once it reaches a terminal state ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(200); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) { cb({ ok: true, row: { c_a: 'v' } }); }
    });
    var runPromise = sb.runDeepScrape({ runId: 'alarm-run', urls: ['https://example.com/a'], fields: [{ id: 'c_a' }], concurrency: 1 });
    await new Promise(function (r) { setTimeout(r, 20); }); // let the run actually start
    assert(sb.__alarms['ws_deepscrape_stall_watchdog'], 'the stall-watchdog alarm is created while a real run is active');
    assert(sb.__alarms['ws_deepscrape_stall_watchdog'].periodInMinutes === 1, 'the alarm is registered with its documented 1-minute period');
    await runPromise;
    assert(!sb.__alarms['ws_deepscrape_stall_watchdog'], 'the alarm is cleared once the run reaches a real terminal state');
  }

  // ---- THE ACTUAL ROUND-2 FIX: a run whose original service-worker
  // instance is gone (simulated: persisted status:'running', no live
  // AbortController for its runId in THIS instance, and a stale
  // updatedAt — exactly what a real SW restart leaves behind) is
  // recovered by a real alarm wake-up, not left frozen forever ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(200); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) {
        var url = sb.__tabs.tabs[tabId] && sb.__tabs.tabs[tabId].url;
        cb({ ok: true, row: { c_r: 'recovered value for ' + url } });
      }
    });
    var stuckUrl = 'https://example.com/sw-died-here';
    var neverStartedUrl = 'https://example.com/never-even-started';
    var runId = 'dead-sw-run';
    var state = {
      runId: runId, status: 'running', fields: [{ id: 'c_r' }],
      results: {}, concurrency: 1, maxAttempts: 1, recordTimeoutMs: 30000,
      stopRequested: false, delayMode: 'custom', customDelayMs: 0,
      currentUrl: stuckUrl, currentRecordDiag: { recordId: stuckUrl, url: stuckUrl, stage: 'EXTRACTING', stageStartedAt: Date.now() - 200000, lastProgressAt: Date.now() - 200000, attempt: 1, workerTabId: 42 },
      // ROUND 3: the authoritative, EXPIRED lease — this, not a stale
      // updatedAt heuristic, is what a real reconciliation pass trusts.
      lease: { recordId: stuckUrl, leaseStartedAt: Date.now() - 200000, leaseExpiresAt: Date.now() - 100000, attempt: 1 },
      error: null,
      // The critical, real-world signature: last real progress was a
      // LONG time ago — this is what a genuinely dead/starved service
      // worker leaves behind (nothing left alive to keep writing updatedAt).
      startedAt: Date.now() - 300000, updatedAt: Date.now() - 200000, finishedAt: null
    };
    state.results[stuckUrl] = { status: 'fetching', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    state.results[neverStartedUrl] = { status: 'pending', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    state.counts = sb.deepScrapeCounts(state.results);
    await sb.setDeepScrapeState(state);
    // Deliberately NEVER call sb.runDeepScrape/runDeepScrapeUrls for this
    // runId — sb.deepScrapeAbortControllers[runId] stays undefined,
    // exactly like a real service-worker instance that no longer exists.
    assert(!sb.deepScrapeAbortControllers[runId], 'setup check: no live controller exists for this runId (simulating a dead service worker)');

    // Simulate the real alarm firing (chrome.alarms waking a fresh
    // service-worker instance and dispatching the event) rather than
    // calling the recovery function directly — proves the REAL
    // production dispatch path (chrome.alarms.onAlarm -> the listener
    // this file registers), not just the helper function in isolation.
    sb.__fireAlarm({ name: 'ws_deepscrape_stall_watchdog' });
    // The listener's own handler is async and not awaited by __fireAlarm
    // (matching how a real onAlarm listener fires-and-forgets) — poll
    // for the real terminal state instead of a fixed guess.
    var recovered = null;
    var waitStart = Date.now();
    while (Date.now() - waitStart < 5000) {
      var s = await sb.getDeepScrapeState();
      if (s && s.status !== 'running') { recovered = s; break; }
      await new Promise(function (r) { setTimeout(r, 50); });
    }
    assert(recovered, 'ROUND-2 FIX: a real alarm wake-up actually recovers a run whose original service worker is gone — it does not stay frozen at RUNNING forever');
    assert(recovered.status === 'completed', 'the recovered run reaches a genuine terminal state — got: ' + (recovered && recovered.status));
    assert(recovered.results[stuckUrl].staleRecoveries === 1, 'the stuck record is honestly tagged with a staleRecoveries count from the real recovery attempt');
    // STORAGE ARCHITECTURE FIX: field VALUES live in the separate
    // ws_deepscrape_fields key now, not inline on the control record.
    var recoveredFields = await sb.getDeepScrapeFields();
    assert(recovered.results[stuckUrl].status === 'completed' && recoveredFields[stuckUrl].c_r === 'recovered value for ' + stuckUrl,
      'ROUND-2 FIX: the record that was stuck when the service worker died is genuinely RE-PROCESSED (not just marked failed) once real recovery kicks in');
    assert(recovered.results[neverStartedUrl].status === 'completed', 'PROOF: the record that never even started (queued behind the stuck one) is also processed — the dead-service-worker record does not block the rest of the queue');
  }

  // ---- STOP with a dead service worker: persistDeepScrapeStopRequest
  // (what the real STOP_DEEP_SCRAPE handler now calls unconditionally)
  // sets a flag that survives even with no live controller — the next
  // real alarm wake-up honors it and stops the run instead of resuming
  // it (the mission's own SECOND reported bug) ----
  {
    const sb = loadBackground({});
    var url = 'https://example.com/user-pressed-stop';
    var runId = 'stop-dead-sw-run';
    var state = {
      runId: runId, status: 'running', fields: [], results: {}, concurrency: 1, maxAttempts: 1, recordTimeoutMs: 30000,
      stopRequested: false, delayMode: 'custom', customDelayMs: 0,
      currentUrl: url, currentRecordDiag: null, error: null,
      startedAt: Date.now() - 300000, updatedAt: Date.now() - 200000, finishedAt: null
    };
    state.results[url] = { status: 'fetching', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    state.counts = sb.deepScrapeCounts(state.results);
    await sb.setDeepScrapeState(state);

    // Exactly what the real STOP_DEEP_SCRAPE message handler does when
    // there is no live in-memory controller to .abort() — persists the
    // request unconditionally.
    await sb.persistDeepScrapeStopRequest(runId);
    var afterStopRequest = await sb.getDeepScrapeState();
    assert(afterStopRequest.stopRequested === true, 'STOP: the stop request is persisted even though no live controller exists for this runId');
    assert(afterStopRequest.status === 'stopping', 'STOP: honest, immediate UI feedback — status flips to "stopping" right away, before the recovery pass below ever runs (ROUND 3)');

    sb.__fireAlarm({ name: 'ws_deepscrape_stall_watchdog' });
    var stopped = null;
    var waitStart2 = Date.now();
    while (Date.now() - waitStart2 < 3000) {
      var s2 = await sb.getDeepScrapeState();
      if (s2 && s2.status === 'stopped') { stopped = s2; break; }
      await new Promise(function (r) { setTimeout(r, 30); });
    }
    assert(stopped, 'ROUND-2 FIX: the next real alarm wake-up honors a persisted Stop request and actually transitions the run to STOPPED — the UI is never left stuck at RUNNING after a real Stop click');
    assert(stopped.currentUrl === null, 'a stopped run clears its currentUrl');
  }

  // ---- ONE pathological record that keeps stalling the service worker
  // is permanently given up on (never retried forever) — proven by
  // seeding staleRecoveries at the documented bound and confirming the
  // NEXT recovery attempt gives up on it, honestly, and still finishes
  // the rest of the queue ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(200); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) {
        var url = sb.__tabs.tabs[tabId] && sb.__tabs.tabs[tabId].url;
        cb({ ok: true, row: { c_r: 'value for ' + url } });
      }
    });
    var pathologicalUrl = 'https://example.com/always-stalls-the-sw';
    var normalUrl = 'https://example.com/perfectly-fine';
    var runId = 'give-up-run';
    var state = {
      runId: runId, status: 'running', fields: [{ id: 'c_r' }], results: {}, concurrency: 1, maxAttempts: 1, recordTimeoutMs: 30000,
      stopRequested: false, delayMode: 'custom', customDelayMs: 0,
      currentUrl: pathologicalUrl, currentRecordDiag: null, error: null,
      lease: { recordId: pathologicalUrl, leaseStartedAt: Date.now() - 200000, leaseExpiresAt: Date.now() - 100000, attempt: 3 },
      startedAt: Date.now() - 300000, updatedAt: Date.now() - 200000, finishedAt: null
    };
    // Already at the documented bound from PRIOR real recovery attempts
    // (this exact URL has already stalled the service worker
    // DEEP_SCRAPE_MAX_STALE_RECOVERIES times before this test starts).
    state.results[pathologicalUrl] = { status: 'fetching', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null, staleRecoveries: 2 };
    state.results[normalUrl] = { status: 'pending', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    state.counts = sb.deepScrapeCounts(state.results);
    await sb.setDeepScrapeState(state);

    sb.__fireAlarm({ name: 'ws_deepscrape_stall_watchdog' });
    var finalState = null;
    var waitStart3 = Date.now();
    while (Date.now() - waitStart3 < 5000) {
      var s3 = await sb.getDeepScrapeState();
      if (s3 && s3.status !== 'running') { finalState = s3; break; }
      await new Promise(function (r) { setTimeout(r, 50); });
    }
    assert(finalState, 'the run reaches a real terminal state even with one permanently-pathological record');
    assert(finalState.results[pathologicalUrl].status === 'skipped', 'MISSION REQUIREMENT: a record that keeps stalling the service worker is permanently given up on (status skipped), never retried forever — got: ' + (finalState.results[pathologicalUrl] && finalState.results[pathologicalUrl].status));
    assert(finalState.results[pathologicalUrl].failureType === 'TIMEOUT', 'the permanently-given-up-on record is honestly classified TIMEOUT');
    assert(finalState.results[normalUrl].status === 'completed', 'MISSION REQUIREMENT: record 74 (the next one) is NOT blocked by the pathological record — it completes normally');
  }

  // ---- Real manual "reload extension" (the user's own actual
  // troubleshooting step): a fresh service-worker instance's real
  // onInstalled/onStartup listeners re-arm the watchdog and recover any
  // run left mid-flight, rather than needing the user to click Resume
  // themselves or wait out a full alarm period ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(200); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) {
        var url = sb.__tabs.tabs[tabId] && sb.__tabs.tabs[tabId].url;
        cb({ ok: true, row: { c_r: 'value for ' + url } });
      }
    });
    var url = 'https://example.com/mid-flight-when-reloaded';
    var runId = 'reload-run';
    var state = {
      runId: runId, status: 'running', fields: [{ id: 'c_r' }], results: {}, concurrency: 1, maxAttempts: 1, recordTimeoutMs: 30000,
      stopRequested: false, delayMode: 'custom', customDelayMs: 0,
      currentUrl: url, currentRecordDiag: null, error: null,
      lease: { recordId: url, leaseStartedAt: Date.now() - 200000, leaseExpiresAt: Date.now() - 100000, attempt: 1 },
      startedAt: Date.now() - 300000, updatedAt: Date.now() - 200000, finishedAt: null
    };
    state.results[url] = { status: 'fetching', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    state.counts = sb.deepScrapeCounts(state.results);
    await sb.setDeepScrapeState(state);
    assert(!sb.__alarms['ws_deepscrape_stall_watchdog'], 'setup check: this fresh instance has no alarm registered yet (simulating right after a manual reload)');

    sb.__fireInstalled({ reason: 'update' }); // exactly what a manual "reload extension" click fires
    var recovered = null;
    var waitStart4 = Date.now();
    while (Date.now() - waitStart4 < 5000) {
      var s4 = await sb.getDeepScrapeState();
      if (s4 && s4.status !== 'running') { recovered = s4; break; }
      await new Promise(function (r) { setTimeout(r, 50); });
    }
    assert(recovered, 'ROUND-2 FIX: a manual "reload extension" (onInstalled reason:update — the user\'s own real troubleshooting step) automatically recovers a run left mid-flight, without needing the user to click Resume');
    assert(recovered.status === 'completed', 'the reload-recovered run reaches a genuine terminal state — got: ' + (recovered && recovered.status));
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
