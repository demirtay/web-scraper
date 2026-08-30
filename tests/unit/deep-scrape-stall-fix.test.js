/**
 * deep-scrape-stall-fix.test.js (FAST level)
 * STALL-FIX mission — real Etsy report: "72/125 completed, then the job
 * stopped making progress forever" (user had to manually Stop). Root
 * cause: several real chrome.* calls inside the extraction pipeline
 * (chrome.tabs.update, chrome.scripting.executeScript, chrome.tabs.
 * sendMessage) had no independent timeout of their own — if any single
 * one of them ever failed to settle (a real, documented class of Chrome
 * extension messaging flakiness), that ONE record blocked the entire
 * concurrency-1 queue forever. This file proves, directly against the
 * real, unmodified background.js: the hard per-record timeout (the
 * actual fix), per-record diagnostics, worker-tab poisoning/isolation
 * after a stall, the watchdog, and STOP/RESUME still behaving correctly
 * with the new machinery in place. Loaded via tests/lib/load-background.js.
 * Standalone-runnable: `node tests/unit/deep-scrape-stall-fix.test.js`.
 */
'use strict';
const { loadBackground, makeFakeResponse } = require('../lib/load-background');
const { makeSuite } = require('../lib/assert');

async function run() {
  const suite = makeSuite('deep-scrape-stall-fix');
  const assert = suite.assert;

  // ---- THE CORE FIX: a record whose real navigation/extraction hangs
  // FOREVER (the exact reported shape — nothing ever calls back) no
  // longer blocks the queue; it times out and the NEXT record still
  // gets processed. This is a direct reproduction-and-proof of the
  // reported 72/125 stall. ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(403); }, // force the real-navigation path, matching the real Etsy shape
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) {
        var url = sb.__tabs.tabs[tabId] && sb.__tabs.tabs[tabId].url;
        if (url === 'https://example.com/stuck-forever') return; // never calls cb — the exact real-world hang this mission reports
        cb({ ok: true, row: { c_x: 'real value for ' + url } });
      }
    });
    var state = {
      runId: 'stall-run', results: {}, fields: [{ id: 'c_x' }], maxAttempts: 1,
      recordTimeoutMs: 200, // small on purpose — a real FAST test cannot wait out a real 30s default
      counts: {}, delayMode: 'custom', customDelayMs: 0
    };
    var stuckUrl = 'https://example.com/stuck-forever';
    var nextUrl = 'https://example.com/next-record';
    state.results[stuckUrl] = { status: 'pending', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    state.results[nextUrl] = { status: 'pending', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    var controller = new AbortController();

    var t0 = Date.now();
    await sb.fetchOneDetailPage(stuckUrl, state.fields, controller, state);
    var elapsedMs = Date.now() - t0;
    assert(elapsedMs < 5000, 'THE FIX: a record that hangs forever is bounded by the hard per-record timeout (elapsed ' + elapsedMs + 'ms, recordTimeoutMs=200) — never blocks indefinitely');
    assert(state.results[stuckUrl].status === 'failed' && state.results[stuckUrl].failureType === 'TIMEOUT', 'the stuck record is honestly classified TIMEOUT — got: ' + JSON.stringify(state.results[stuckUrl]));

    // THE actual reported symptom, proven fixed: the QUEUE continues —
    // the record AFTER the stuck one still gets processed normally.
    await sb.fetchOneDetailPage(nextUrl, state.fields, controller, state);
    // STORAGE ARCHITECTURE FIX: field VALUES live in the separate
    // ws_deepscrape_fields key now, not inline on the control record.
    var fieldsAfterNext = await sb.getDeepScrapeFields();
    assert(state.results[nextUrl].status === 'completed' && fieldsAfterNext[nextUrl].c_x === 'real value for ' + nextUrl,
      'PROOF: the record AFTER a stalled one is NOT blocked — it processes and completes normally');

    // Worker-tab isolation: the tab used by the stuck record must be
    // poisoned (closed, never reused) — the next record gets a genuinely
    // fresh tab, never inheriting whatever broken state caused the stall.
    assert(sb.__tabs.created.length === 2, 'WORKER-TAB ISOLATION: the poisoned (stalled) tab is never reused — the next record gets a fresh tab (2 tabs created total, not 1)');
    assert(sb.__tabs.removed.indexOf(sb.__tabs.created[0]) !== -1, 'the stalled record\'s own tab was actually closed (poisoned), not leaked open');
  }

  // ---- PER-RECORD DIAGNOSTICS: recordId/url/stage/stageStartedAt/
  // lastProgressAt/attempt/workerTabId are real and observable while a
  // record is in flight, and cleared once it reaches a terminal outcome ----
  {
    var observedStages = [];
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(200); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) { cb({ ok: true, row: { c_a: 'v' } }); }
    });
    var url = 'https://example.com/diag-test';
    var state = { runId: 'diag-run', results: {}, fields: [{ id: 'c_a' }], maxAttempts: 1, recordTimeoutMs: 5000, counts: {}, delayMode: 'custom', customDelayMs: 0 };
    state.results[url] = { status: 'pending', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    var controller = new AbortController();
    await sb.fetchOneDetailPage(url, state.fields, controller, state);
    assert(state.currentRecordDiag === null, 'DIAGNOSTICS: currentRecordDiag is cleared once the record reaches a real terminal outcome (no stale "in flight" info left behind)');
    var persisted = await sb.getDeepScrapeState();
    assert(persisted.currentRecordDiag === null, 'DIAGNOSTICS: the cleared diag is actually persisted, readable back via getDeepScrapeState');
  }
  {
    // Observe an IN-FLIGHT diag by racing our own read against a
    // deliberately slow (but real, eventually-resolving) extraction.
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(403); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) {
        setTimeout(function () { cb({ ok: true, row: { c_a: 'v' } }); }, 150); // slow but real — resolves before the 5s recordTimeoutMs
      }
    });
    var url2 = 'https://example.com/diag-inflight';
    var state2 = { runId: 'diag-run-2', results: {}, fields: [{ id: 'c_a' }], maxAttempts: 1, recordTimeoutMs: 5000, counts: {}, delayMode: 'custom', customDelayMs: 0 };
    state2.results[url2] = { status: 'pending', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    var controller2 = new AbortController();
    var donePromise = sb.fetchOneDetailPage(url2, state2.fields, controller2, state2);
    await new Promise(function (r) { setTimeout(r, 50); }); // let it get partway through
    assert(state2.currentRecordDiag, 'DIAGNOSTICS: a real, non-null diag object is observable WHILE a record is in flight');
    assert(state2.currentRecordDiag.url === url2 && state2.currentRecordDiag.recordId === url2, 'DIAGNOSTICS: the in-flight diag correctly identifies its own record/URL');
    assert(typeof state2.currentRecordDiag.workerTabId === 'number', 'DIAGNOSTICS: the in-flight diag reports the real owned worker tab id it is using');
    assert(['VALIDATING', 'NAVIGATING', 'WAITING_FOR_LOAD', 'WAITING_FOR_CONTENT_SCRIPT', 'EXTRACTING'].indexOf(state2.currentRecordDiag.stage) !== -1,
      'DIAGNOSTICS: the in-flight diag reports one of the real, documented stage names — got: ' + state2.currentRecordDiag.stage);
    await donePromise;
  }

  // ---- STOP still works correctly with the new timeout machinery: a
  // real abort during a slow-but-not-yet-timed-out attempt is honored
  // immediately, not after waiting out the full per-record timeout ----
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
    var url3 = 'https://example.com/stop-test';
    var state3 = { runId: 'stop-run-2', results: {}, fields: [], maxAttempts: 1, recordTimeoutMs: 10000, counts: {}, delayMode: 'custom', customDelayMs: 0 };
    state3.results[url3] = { status: 'pending', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    var controller3 = new AbortController();
    var t1 = Date.now();
    var p3 = sb.fetchOneDetailPage(url3, state3.fields, controller3, state3);
    await new Promise(function (r) { setTimeout(r, 50); });
    controller3.abort();
    await p3;
    var stopElapsed = Date.now() - t1;
    assert(stopElapsed < 2000, 'STOP interrupts an in-flight record almost immediately (elapsed ' + stopElapsed + 'ms), never waiting out the full 10000ms per-record timeout');
    assert(state3.results[url3].status !== 'failed', 'STOP does not mark the interrupted record as a real failure — it is left pending/fetching for a later resume, never fabricated as an error');
  }

  // ---- RESUME after a real STOP: the completed records are preserved
  // exactly, and the STILL-PENDING ones (never the completed ones) are
  // what actually get re-processed — mirrors the real report's own
  // numbers (72 completed, 53 pending) ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(200); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) {
        var url = sb.__tabs.tabs[tabId] && sb.__tabs.tabs[tabId].url;
        cb({ ok: true, row: { c_r: 'value for ' + url } });
      }
    });
    var completedUrls = ['https://example.com/done-1', 'https://example.com/done-2'];
    var pendingUrls = ['https://example.com/pending-1'];
    var state4 = {
      runId: 'resume-stall-run', status: 'running', fields: [{ id: 'c_r' }],
      results: {}, concurrency: 1, maxAttempts: 1, recordTimeoutMs: 5000,
      delayMode: 'custom', customDelayMs: 0,
      currentUrl: null, currentRecordDiag: null, error: null, startedAt: Date.now(), updatedAt: Date.now(), finishedAt: null
    };
    completedUrls.forEach(function (u) {
      state4.results[u] = { status: 'completed', error: null, httpStatus: 200, finalUrl: u, retryStatus: null, failureType: null };
    });
    pendingUrls.forEach(function (u) {
      state4.results[u] = { status: 'pending', error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    });
    state4.counts = sb.deepScrapeCounts(state4.results);
    await sb.setDeepScrapeState(state4);
    // STORAGE ARCHITECTURE FIX: field VALUES live in the separate
    // ws_deepscrape_fields key now — seed the already-completed urls'
    // values there directly, matching what a real prior run would have.
    var seedFields = {};
    completedUrls.forEach(function (u) { seedFields[u] = { c_r: 'PRESERVED — ' + u }; });
    await sb.setDeepScrapeFields(seedFields);

    await sb.resumeInterruptedDeepScrapeItems({ runId: 'resume-stall-run' });
    var resumed = await sb.getDeepScrapeState();
    var resumedFields4 = await sb.getDeepScrapeFields();
    assert(resumed.status === 'completed', 'RESUME reaches a real terminal state — got: ' + resumed.status);
    completedUrls.forEach(function (u) {
      assert(resumedFields4[u].c_r === 'PRESERVED — ' + u, 'RESUME never re-visits an already-completed record — "' + u + '" keeps its original value untouched');
    });
    pendingUrls.forEach(function (u) {
      assert(resumed.results[u].status === 'completed' && resumedFields4[u].c_r === 'value for ' + u, 'RESUME actually processes the pending record "' + u + '" left over from before the stop/interruption');
    });
    assert(resumed.counts.completed === 3, 'RESUME reaches the real terminal count: all 3 records (2 preserved + 1 newly resumed) end up completed');
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
