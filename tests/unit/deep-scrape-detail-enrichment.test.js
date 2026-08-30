/**
 * deep-scrape-detail-enrichment.test.js (FAST level)
 * HTTP-403-ON-ETSY bug-fix mission — pure-logic coverage for
 * background/background.js's Detail Enrichment engine: request-path
 * routing (fetch validation -> real-navigation fallback), failure
 * classification (MISSING/HTTP_BLOCKED/SITE_CHALLENGE/NAVIGATION_ERROR/
 * SELECTOR_ERROR/TIMEOUT), row association (state.results keyed by URL,
 * never array position), checkpoint persistence, and worker-tab
 * ownership/reuse (one owned tab, never one tab per product). Loaded via
 * tests/lib/load-background.js — the REAL, unmodified background.js,
 * with only chrome.* and fetch() mocked (never the logic under test
 * itself). Standalone-runnable: `node tests/unit/deep-scrape-detail-enrichment.test.js`.
 */
'use strict';
const { loadBackground, makeFakeResponse } = require('../lib/load-background');
const { makeSuite } = require('../lib/assert');

async function run() {
  const suite = makeSuite('deep-scrape-detail-enrichment');
  const assert = suite.assert;

  // ---- classifyHttpFailure: status -> {reason, retryable, failureType} ----
  {
    const sb = loadBackground({});
    const c404 = sb.classifyHttpFailure(404);
    assert(c404.failureType === 'MISSING' && c404.retryable === false, 'classifyHttpFailure: 404 -> MISSING, non-retryable');
    const c403 = sb.classifyHttpFailure(403);
    assert(c403.failureType === 'HTTP_BLOCKED', 'classifyHttpFailure: 403 -> HTTP_BLOCKED (the real reported Etsy case)');
    const c429 = sb.classifyHttpFailure(429);
    assert(c429.failureType === 'HTTP_BLOCKED' && c429.retryable === true, 'classifyHttpFailure: 429 -> HTTP_BLOCKED, retryable (rate limit)');
    const c500 = sb.classifyHttpFailure(500);
    assert(c500.failureType === 'HTTP_BLOCKED' && c500.retryable === true, 'classifyHttpFailure: 500 -> HTTP_BLOCKED, retryable');
  }

  // ---- THE CORE FIX: fetch() 403 falls back to real navigation, which
  // succeeds — the exact reported Etsy shape (125/125 HTTP 403) ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(403); },
      executeScriptImpl: function (params) {
        if (params.files) return Promise.resolve([{}]); // CONTENT_FILES injection — no return value used
        return Promise.resolve([{ result: false }]); // challenge check: not a challenge page
      },
      sendMessageImpl: function (tabId, message, cb) {
        cb({ ok: true, row: { c_desc: 'Real value extracted via real navigation' } });
      }
    });
    const resolved = await sb.resolveDetailPage('run1', 'https://www.etsy.com/listing/123/example', [{ id: 'c_desc' }], null);
    assert(resolved.ok === true, 'THE FIX: fetch() 403 falls back to real navigation, which succeeds — resolveDetailPage returns ok:true');
    assert(resolved.fields.c_desc === 'Real value extracted via real navigation', 'THE FIX: the real-navigation-extracted value is what gets returned, not fabricated');
    assert(sb.__tabs.created.length === 1, 'THE FIX: exactly one real tab was created to serve the real-navigation fallback');
  }

  // ---- A genuinely MISSING page (404) is trusted as-is — no real
  // navigation is wasted confirming it ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(404); }
    });
    const resolved = await sb.resolveDetailPage('run2', 'https://example.com/gone', [], null);
    assert(resolved.ok === false && resolved.failureType === 'MISSING', '404 is classified MISSING and treated as final');
    assert(sb.__tabs.created.length === 0, '404 (MISSING) never triggers a real-navigation fallback — no tab is created');
  }

  // ---- A network-level fetch failure ALSO falls back to real navigation
  // ("blocked or unreliable" per the mission's own PHASE 2 framing) ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return Promise.reject(new TypeError('Failed to fetch')); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) { cb({ ok: true, row: { c_x: 'value' } }); }
    });
    const resolved = await sb.resolveDetailPage('run3', 'https://example.com/x', [{ id: 'c_x' }], null);
    assert(resolved.ok === true, 'a network-level fetch failure also falls back to real navigation, which can still succeed');
  }

  // ---- Real navigation ALSO blocked (a genuine site challenge) —
  // honestly classified SITE_CHALLENGE, never bypassed, never retried ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(403); },
      executeScriptImpl: function (params) {
        if (params.files) return Promise.resolve([{}]);
        return Promise.resolve([{ result: true }]); // challenge DOM marker found
      }
    });
    const resolved = await sb.resolveDetailPage('run4', 'https://www.etsy.com/listing/999/blocked', [], null);
    assert(resolved.ok === false && resolved.failureType === 'SITE_CHALLENGE', 'a real navigation that is ALSO blocked is classified SITE_CHALLENGE, not a generic HTTP 403');
    assert(resolved.retryable === false, 'SITE_CHALLENGE is never retried (no bypass attempt, no hammering)');
  }

  // ---- Real navigation succeeds but the content script reports a
  // genuine extraction-side failure — SELECTOR_ERROR, distinct from a
  // site block ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(200); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) { cb({ ok: false, error: 'Selector did not match any element.' }); }
    });
    const resolved = await sb.resolveDetailPage('run5', 'https://example.com/ok-but-bad-selector', [], null);
    assert(resolved.ok === false && resolved.failureType === 'SELECTOR_ERROR', 'a real page that loads fine but whose selector fails is classified SELECTOR_ERROR, distinct from HTTP_BLOCKED/SITE_CHALLENGE');
  }

  // ---- Normal success path (fetch 200, real nav succeeds) is unchanged ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(200, { finalUrl: 'https://example.com/final' }); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) { cb({ ok: true, row: { c_y: 'y' } }); }
    });
    const resolved = await sb.resolveDetailPage('run6', 'https://example.com/normal', [], null);
    assert(resolved.ok === true && resolved.finalUrl === 'https://example.com/final', 'the normal fetch-succeeds-then-extract path is unchanged and still works');
  }

  // ---- WORKER-TAB OWNERSHIP: one tab, reused across multiple pages,
  // never one tab per product ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(403); }, // force the real-navigation path every time
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) { cb({ ok: true, row: { c_z: 'v' } }); }
    });
    const runId = 'reuse-run';
    await sb.resolveDetailPage(runId, 'https://example.com/p1', [{ id: 'c_z' }], null);
    await sb.resolveDetailPage(runId, 'https://example.com/p2', [{ id: 'c_z' }], null);
    await sb.resolveDetailPage(runId, 'https://example.com/p3', [{ id: 'c_z' }], null);
    assert(sb.__tabs.created.length === 1, 'MISSION REQUIREMENT: processing 3 real pages sequentially under ONE runId creates exactly ONE real tab, never one per product');
    assert(sb.__tabs.updated.length === 3, 'the SAME owned tab is navigated (chrome.tabs.update) for each of the 3 pages');
    assert(sb.__tabs.updated.every(function (u) { return u.id === sb.__tabs.created[0]; }), 'every navigation reuses the exact same owned tab id');

    await sb.closeAllWorkerTabs(runId);
    assert(sb.__tabs.removed.length === 1 && sb.__tabs.removed[0] === sb.__tabs.created[0], 'closeAllWorkerTabs closes exactly the one owned tab, once, at run end');
  }

  // ---- Worker-tab pool never touches a DIFFERENT run's own tab ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(403); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) { cb({ ok: true, row: {} }); }
    });
    await sb.resolveDetailPage('runA', 'https://example.com/a', [], null);
    await sb.resolveDetailPage('runB', 'https://example.com/b', [], null);
    assert(sb.__tabs.created.length === 2, 'two different runIds each get their own owned tab (never shared across runs)');
    var tabA = sb.__tabs.created[0], tabB = sb.__tabs.created[1];
    await sb.closeAllWorkerTabs('runA');
    assert(sb.__tabs.removed.indexOf(tabA) !== -1, 'closeAllWorkerTabs(runA) closes runA\'s own tab');
    assert(sb.__tabs.removed.indexOf(tabB) === -1, 'closeAllWorkerTabs(runA) does NOT touch runB\'s own, still-active tab — never a broader action');
  }

  // ---- ROW ASSOCIATION: state.results is keyed by URL, never array
  // position — a URL processed "out of order" still lands under its own
  // correct key ----
  {
    const sb = loadBackground({
      fetchImpl: function (url) { return makeFakeResponse(200, { finalUrl: url }); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) {
        var url = sb.__tabs.tabs[tabId].url;
        cb({ ok: true, row: { c_title: 'Title for ' + url } });
      }
    });
    var urls = ['https://example.com/r1', 'https://example.com/r2', 'https://example.com/r3'];
    var state = { runId: 'assoc-run', results: {}, fields: [{ id: 'c_title' }], maxAttempts: 1, counts: {}, delayMode: 'custom', customDelayMs: 0 };
    urls.forEach(function (u) { state.results[u] = { status: 'pending', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null }; });
    var controller = new AbortController();
    // Process out of declared order — proves association is by URL key, not iteration/array position.
    await sb.fetchOneDetailPage(urls[2], state.fields, controller, state);
    await sb.fetchOneDetailPage(urls[0], state.fields, controller, state);
    await sb.fetchOneDetailPage(urls[1], state.fields, controller, state);
    // STORAGE ARCHITECTURE FIX: extracted field values now live in the
    // separate ws_deepscrape_fields key, not inline on state.results[url]
    // — see background.js's persistDetailResultFields.
    var fieldsMap = await sb.getDeepScrapeFields();
    assert(fieldsMap[urls[0]].c_title === 'Title for ' + urls[0], 'row 0 correctly associated with its OWN url\'s extracted value');
    assert(fieldsMap[urls[1]].c_title === 'Title for ' + urls[1], 'row 1 correctly associated with its OWN url\'s extracted value');
    assert(fieldsMap[urls[2]].c_title === 'Title for ' + urls[2], 'row 2 correctly associated with its OWN url\'s extracted value');
    assert(state.results[urls[0]].status === 'completed' && state.results[urls[1]].status === 'completed' && state.results[urls[2]].status === 'completed', 'all 3 rows completed successfully');
  }

  // ---- CHECKPOINT PERSISTENCE: fetchOneDetailPage writes real,
  // inspectable progress to chrome.storage.local as it goes ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(200); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) { cb({ ok: true, row: { c_a: 'v' } }); }
    });
    var url = 'https://example.com/checkpoint';
    var state = { runId: 'checkpoint-run', results: {}, fields: [{ id: 'c_a' }], maxAttempts: 1, counts: {}, delayMode: 'custom', customDelayMs: 0 };
    state.results[url] = { status: 'pending', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    await sb.setDeepScrapeState(state);
    var controller = new AbortController();
    await sb.fetchOneDetailPage(url, state.fields, controller, state);
    var persisted = await sb.getDeepScrapeState();
    assert(persisted && persisted.results[url].status === 'completed', 'checkpoint: the real, completed per-URL result is actually persisted to chrome.storage.local, readable back via getDeepScrapeState');
  }

  // ---- RETRY: a retryable failure (TIMEOUT) is retried up to
  // maxAttempts; a non-retryable one (MISSING) is not ----
  // Isolated check (bypassing the real-navigation fallback, which — by
  // design — would take over and report ITS OWN, more authoritative
  // classification if it also failed): validateDetailUrl itself
  // correctly classifies a fetch-level AbortError as TIMEOUT.
  {
    const sb = loadBackground({
      fetchImpl: function () { return Promise.reject(Object.assign(new Error('timeout'), { name: 'AbortError' })); }
    });
    const v = await sb.validateDetailUrl('https://example.com/slow', new AbortController().signal);
    assert(v.ok === false && v.failureType === 'TIMEOUT' && v.retryable === true, 'validateDetailUrl classifies a fetch-level AbortError as TIMEOUT, retryable');
  }

  // End-to-end retry count: a URL whose real-navigation fallback ALSO
  // keeps failing (content script never responds — NAVIGATION_ERROR,
  // retryable) is retried up to maxAttempts before being recorded failed.
  {
    var attemptCount = 0;
    const sb = loadBackground({
      fetchImpl: function () {
        attemptCount++;
        return Promise.reject(Object.assign(new Error('timeout'), { name: 'AbortError' }));
      },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) { cb(undefined); } // content script never responds
    });
    var url = 'https://example.com/always-fails';
    var state = { runId: 'retry-run', results: {}, fields: [], maxAttempts: 2, counts: {}, delayMode: 'custom', customDelayMs: 0 };
    state.results[url] = { status: 'pending', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    var controller = new AbortController();
    await sb.fetchOneDetailPage(url, state.fields, controller, state);
    assert(attemptCount === 2, 'a persistently-failing (retryable) URL is retried up to maxAttempts — 2 fetch attempts made');
    assert(state.results[url].status === 'failed' && state.results[url].failureType === 'NAVIGATION_ERROR', 'after exhausting retries, the failure is honestly recorded with a real, specific failureType (NAVIGATION_ERROR — the real navigation\'s own, more authoritative classification), not a generic HTTP 403');
  }
  {
    var attemptCount2 = 0;
    const sb = loadBackground({
      fetchImpl: function () { attemptCount2++; return makeFakeResponse(404); }
    });
    var url2 = 'https://example.com/genuinely-missing';
    var state2 = { runId: 'no-retry-run', results: {}, fields: [], maxAttempts: 3, counts: {}, delayMode: 'custom', customDelayMs: 0 };
    state2.results[url2] = { status: 'pending', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    var controller2 = new AbortController();
    await sb.fetchOneDetailPage(url2, state2.fields, controller2, state2);
    assert(attemptCount2 === 1, 'a MISSING (non-retryable) failure is NOT retried even though maxAttempts is 3 — only 1 attempt made');
    assert(state2.results[url2].failureType === 'MISSING', 'the final recorded failureType is MISSING');
  }

  // ---- deepScrapeCounts: honest aggregation ----
  {
    const sb = loadBackground({});
    var counts = sb.deepScrapeCounts({
      a: { status: 'completed' }, b: { status: 'completed' }, c: { status: 'partial' },
      d: { status: 'failed' }, e: { status: 'skipped' }, f: { status: 'pending' }
    });
    assert(counts.total === 6 && counts.completed === 2 && counts.partial === 1 && counts.failed === 1 && counts.skipped === 1 && counts.pending === 1,
      'deepScrapeCounts aggregates every status bucket honestly — got ' + JSON.stringify(counts));
  }

  // ---- STOP: aborting a run mid-flight ends it cleanly as 'stopped'
  // (never crashes, never falsely reports 'completed') and cleans up its
  // owned worker tab ----
  {
    const sb = loadBackground({
      fetchImpl: function (url, fetchOpts) {
        return new Promise(function (resolve, reject) {
          if (fetchOpts && fetchOpts.signal) {
            fetchOpts.signal.addEventListener('abort', function () {
              var e = new Error('Aborted'); e.name = 'AbortError'; reject(e);
            });
          }
          // deliberately never resolves on its own — only STOP (the
          // abort signal) ever settles this, proving STOP actually takes
          // effect rather than the run just happening to finish first.
        });
      }
    });
    var runPromise = sb.runDeepScrape({ runId: 'stop-test-run', urls: ['https://example.com/slow'], fields: [], concurrency: 1 });
    await new Promise(function (r) { setTimeout(r, 50); }); // let the run actually start
    var controller = sb.deepScrapeAbortControllers['stop-test-run'];
    assert(controller, 'STOP: a real AbortController is registered for the running job while it is in flight');
    controller.abort();
    await runPromise;
    var stateAfterStop = await sb.getDeepScrapeState();
    assert(stateAfterStop.status === 'stopped', 'STOP: the run ends in status "stopped" (never falsely "completed") once aborted — got: ' + stateAfterStop.status);
    assert(!sb.deepScrapeTabPools['stop-test-run'], 'STOP: the run\'s own worker-tab pool is cleaned up (closeAllWorkerTabs ran) once stopped');
  }

  // ---- RESUME: a run interrupted mid-flight (service worker restarted —
  // simulated here by state left at 'running' with no live controller for
  // its runId) picks back up and finishes the remaining, not-yet-
  // completed URLs, leaving already-completed ones untouched ----
  {
    const sb = loadBackground({
      fetchImpl: function () { return makeFakeResponse(200); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) { cb({ ok: true, row: { c_r: 'resumed-value' } }); }
    });
    var doneUrl = 'https://example.com/already-done';
    var stuckUrl = 'https://example.com/interrupted';
    var interruptedState = {
      runId: 'resume-test-run', status: 'running', fields: [{ id: 'c_r' }],
      results: {}, concurrency: 1, maxAttempts: 1,
      delayMode: 'custom', customDelayMs: 0,
      currentUrl: null, error: null, startedAt: Date.now(), updatedAt: Date.now(), finishedAt: null
    };
    interruptedState.results[doneUrl] = { status: 'completed', error: null, httpStatus: 200, finalUrl: doneUrl, retryStatus: null, failureType: null };
    interruptedState.results[stuckUrl] = { status: 'fetching', error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    interruptedState.counts = sb.deepScrapeCounts(interruptedState.results);
    await sb.setDeepScrapeState(interruptedState);
    // STORAGE ARCHITECTURE FIX: field VALUES live in the separate
    // ws_deepscrape_fields key now — seed it directly here too, matching
    // what a real already-completed record would have.
    await sb.setDeepScrapeFields({ [doneUrl]: { c_r: 'already here before the interruption' } });
    // No sb.deepScrapeAbortControllers['resume-test-run'] entry — exactly
    // what "genuinely interrupted, not actually still running" looks like.

    await sb.resumeInterruptedDeepScrapeItems({ runId: 'resume-test-run' });
    var resumed = await sb.getDeepScrapeState();
    var resumedFields = await sb.getDeepScrapeFields();
    assert(resumed.status === 'completed', 'RESUME: the resumed run reaches a real terminal state — got: ' + resumed.status);
    assert(resumedFields[doneUrl].c_r === 'already here before the interruption', 'RESUME: an already-completed URL is left untouched, never re-fetched');
    assert(resumed.results[stuckUrl].status === 'completed' && resumedFields[stuckUrl].c_r === 'resumed-value', 'RESUME: the URL stuck mid-flight at interruption time is genuinely re-processed and completes');
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
