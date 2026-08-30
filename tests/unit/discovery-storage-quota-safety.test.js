/**
 * discovery-storage-quota-safety.test.js (FAST/local, no browser)
 * CORE RECOVERY MISSION — proves the REAL, unmodified content/
 * discovery.js (loaded through tests/lib/load-discovery.js, never a
 * reimplementation) no longer silently pretends a discovery session is
 * still running after a genuine chrome.storage.local write failure.
 *
 * ROOT CAUSE (see setSession()'s own header comment in content/
 * discovery.js): setSession() previously resolved its returned promise
 * unconditionally, regardless of chrome.runtime.lastError — a real
 * quota-exceeded write (the exact `Resource::kQuotaBytes quota exceeded`
 * error this project already proved and fixed elsewhere — utils/
 * license.js's persist(), background.js's setDeepScrapeState()/
 * setDeepScrapeFields() — but never here) would silently drop the write:
 * the in-memory `session` the loop was holding showed the new state, but
 * chrome.storage.local kept the STALE prior value, and the very next
 * getSession() re-read (which nearly every loop step does) would fetch
 * that stale value back — desyncing the loop from its own persisted
 * state indefinitely, or leaving the popup (which only ever observes
 * storage) frozen on stale progress forever while discovery.status
 * stayed 'discovering' in storage.
 *
 * Covers the mission's own explicitly required proofs:
 *   1. quota failure cannot leave discovery.status as running/discovering
 *   2. existing rows survive
 *   3. pagesVisited survives
 *   4. the error is visible to diagnostics/UI (discovery.stopReason +
 *      the [WS-PAGE-DIAG] ring buffer, both already read verbatim by
 *      popup.js's renderDiscoveryUI() and WSHealthCheck.
 *      computeHealthSummary() — no separate UI/Health Check change
 *      needed for this to surface there)
 *   5. normal successful storage writes behave exactly as before
 *
 * Standalone-runnable: `node tests/unit/discovery-storage-quota-safety.test.js`.
 */
'use strict';
const { loadDiscovery } = require('../lib/load-discovery');
const { makeSuite } = require('../lib/assert');

async function settle(sandbox, ticks) {
  for (var i = 0; i < (ticks || 40); i++) {
    await new Promise(function (r) { setTimeout(r, 0); });
  }
  if (sandbox && sandbox.WSDiscovery && sandbox.WSDiscovery.flushPageDiagQueue) {
    await sandbox.WSDiscovery.flushPageDiagQueue();
  }
}

function baseDiscoverySession(overrides) {
  return Object.assign({
    sessionId: 's1', hostname: 'example.com', status: 'active',
    startedAt: Date.now(), updatedAt: Date.now(),
    scraperConfig: { containerSelector: '.item', columns: [{ id: 'c_title', name: 'Title', relativeSelector: 'h2', attribute: 'text' }] },
    dedupeKey: null, seenKeys: {}, lastPassNewRows: 0, lastCheckAt: null,
    rows: [
      { c_title: 'row 1' }, { c_title: 'row 2' }, { c_title: 'row 3' },
      { c_title: 'row 4' }, { c_title: 'row 5' }, { c_title: 'row 6' },
      { c_title: 'row 7' }, { c_title: 'row 8' }, { c_title: 'row 9' }, { c_title: 'row 10' }
    ],
    discovery: {
      status: 'discovering', enabled: true, pagesVisited: 5, discoveredUnique: 10,
      maxPages: 500, maxTotalCycles: 2000, scrollCycles: 0, loadMoreActions: 0,
      visitedUrls: ['https://example.com/page5'], lastPaginationAttempt: null,
      currentPageBaselineCandidateCount: 0, updatedAt: Date.now()
    },
    // Pre-populated (as a REAL in-progress session already would be,
    // after ensureInternalEngines() ran on an earlier iteration) so
    // ensureInternalEngines() sees them already present and never
    // touches root.WSAutoScroll/root.WSLoadMore — this loader
    // deliberately never stubs those (see its own header comment: only
    // the diagnostic ring buffer is under test here, not the scraping
    // engines).
    autoScroll: { enabled: true, status: 'exhausted', stopReason: 'no-new-data', cycleCount: 3, maxCycles: 50, consecutiveNoNewData: 3, maxNoNewDataAttempts: 3, pageSignatures: [], updatedAt: Date.now() },
    loadMoreAuto: { enabled: true, status: 'exhausted', stopReason: 'no-candidate', clickCount: 0, maxClicks: 50, consecutiveNoNewData: 0, maxNoNewDataAttempts: 3, pageSignatures: [], updatedAt: Date.now() }
  }, overrides);
}

async function run() {
  const suite = makeSuite('discovery-storage-quota-safety');
  const assert = suite.assert;

  // ---- Isolated proof: setSession() itself now rejects (with a real,
  // tagged Error) on a genuine chrome.runtime.lastError write failure,
  // and the write genuinely does not land. ----
  {
    var store1 = {};
    var sb1 = loadDiscovery({ sharedStore: store1, url: 'https://example.com/page5', quotaFailFn: function () { return true; } });
    await settle(sb1);
    var threw = null;
    try {
      await sb1.WSDiscovery.setSession('example.com', baseDiscoverySession());
    } catch (e) { threw = e; }
    assert(!!threw, 'MISSION PROOF: setSession() rejects on a genuine storage write failure instead of silently resolving');
    assert(threw && /quota/i.test(threw.message), 'MISSION PROOF: the rejection carries the REAL chrome.runtime.lastError message — got: ' + (threw && threw.message));
    assert(threw && threw.isStorageWriteError === true, 'the rejection is tagged isStorageWriteError so callers can distinguish it from a generic exception');
    assert(!store1['ws_live_session::example.com'], 'MISSION PROOF: the failed write genuinely did not land in storage');
  }

  // ---- Isolated proof: setSession()'s SUCCESS path is completely
  // unchanged — normal writes still land exactly as before. ----
  {
    var store2 = {};
    var sb2 = loadDiscovery({ sharedStore: store2, url: 'https://example.com/page5' });
    await settle(sb2);
    var session2 = baseDiscoverySession();
    var resolvedValue;
    var didThrow = false;
    try {
      resolvedValue = await sb2.WSDiscovery.setSession('example.com', session2);
    } catch (e) { didThrow = true; }
    assert(!didThrow, 'MISSION PROOF: a normal, successful write never throws — no regression to the happy path');
    assert(resolvedValue === undefined, 'setSession() still resolves with no value on success, exactly as before');
    assert(!!store2['ws_live_session::example.com'], 'the write genuinely landed in storage');
    var readBack = await sb2.WSDiscovery.getSession('example.com');
    assert(readBack.rows.length === 10 && readBack.discovery.pagesVisited === 5, 'getSession() reads back exactly what was written, unchanged');
  }

  // ---- END-TO-END, real production entry point: START_DISCOVERY's
  // real handler -> runDiscoveryLoopSafe() -> runDiscoveryLoop() hits a
  // genuine write failure on its very first write, then successfully
  // recovers (persists an honest 'error' state) once the transient
  // pressure clears — proving the FULL recovery chain, not just the
  // isolated function. ----
  {
    var store3 = {};
    var callCount3 = 0;
    var sb3 = loadDiscovery({
      sharedStore: store3, url: 'https://example.com/page5',
      quotaFailFn: function (key) {
        if (key !== 'ws_live_session::example.com') return false;
        callCount3++;
        return callCount3 === 1; // first write fails, every later one succeeds — a transient spike clearing
      }
    });
    await settle(sb3); // bootstrap resolves first, finds nothing yet (store is still empty) — harmless
    // Seed the session AFTER bootstrap has already resolved, exactly
    // like the real production contract START_DISCOVERY's own handler
    // documents ("session must already be persisted before this message
    // arrives") — avoids racing the bootstrap-resume block above.
    var seeded3 = baseDiscoverySession();
    store3['ws_live_session::example.com'] = seeded3;

    sb3.__dispatchMessage({ type: 'START_DISCOVERY' });
    await settle(sb3);

    var after3 = store3['ws_live_session::example.com'];
    assert(after3.discovery.status !== 'discovering', 'MISSION PROOF #1: a storage write failure NEVER leaves discovery.status as "discovering" — got ' + after3.discovery.status);
    assert(after3.discovery.status === 'error', 'discovery.status honestly transitions to "error" once the recovery write lands — got ' + after3.discovery.status);
    assert(after3.discovery.stopReason && after3.discovery.stopReason.indexOf('storage-write-failed') !== -1, 'MISSION PROOF #4: stopReason is specifically labeled storage-write-failed (not a generic internal-error) — got: ' + after3.discovery.stopReason);
    assert(after3.discovery.stopReason.indexOf('quota') !== -1, 'MISSION PROOF #4: the REAL storage error text ("...quota exceeded") is surfaced verbatim in stopReason — got: ' + after3.discovery.stopReason);
    assert(after3.rows.length === 10, 'MISSION PROOF #2: all 10 already-collected rows survive the failure — got ' + after3.rows.length);
    assert(after3.discovery.pagesVisited === 5, 'MISSION PROOF #3: pagesVisited (5) survives the failure — got ' + after3.discovery.pagesVisited);
    assert(JSON.stringify(after3.scraperConfig) === JSON.stringify(seeded3.scraperConfig), 'the user\'s scraper configuration (containerSelector/columns) survives byte-for-byte');

    // MISSION PROOF #4 (diagnostics/UI visibility): the failure is also
    // recorded in the [WS-PAGE-DIAG] ring buffer popup.js's own "Copy
    // Pagination Diagnostic"/Health Check report already read.
    var diagEntries3 = (store3['ws_pagination_diag'] && store3['ws_pagination_diag'].entries) || [];
    assert(diagEntries3.some(function (e) { return e.stage === 'STAGE 16/18 storage-write-failed'; }), 'MISSION PROOF #4: a storage-write-failed diagnostic event is recorded — entries: ' + JSON.stringify(diagEntries3.map(function (e) { return e.stage; })));
  }

  // ---- Persistent failure (every write to the session key fails,
  // forever — the true worst case): the loop still genuinely stops
  // (never hangs/loops forever), and the failure remains visible via
  // the diagnostic buffer (a DIFFERENT key, unaffected) even though the
  // session key itself can never be updated. No unhandled rejection. ----
  {
    var unhandled4 = [];
    var onUnhandled4 = function (err) { unhandled4.push(err); };
    process.on('unhandledRejection', onUnhandled4);
    try {
      var store4 = {};
      var sb4 = loadDiscovery({
        sharedStore: store4, url: 'https://example.com/page5',
        quotaFailFn: function (key) { return key === 'ws_live_session::example.com'; } // NEVER succeeds for this key
      });
      await settle(sb4); // bootstrap resolves first against an empty store — harmless
      var seeded4 = baseDiscoverySession();
      store4['ws_live_session::example.com'] = seeded4;

      sb4.__dispatchMessage({ type: 'START_DISCOVERY' });
      await settle(sb4);
      await new Promise(function (r) { setTimeout(r, 30); }); // extra margin — proves it settles, doesn't hang

      assert(unhandled4.length === 0, 'MISSION PROOF: zero unhandled promise rejections even when EVERY recovery attempt also fails — got ' + unhandled4.length);
      var diagEntries4 = (store4['ws_pagination_diag'] && store4['ws_pagination_diag'].entries) || [];
      assert(diagEntries4.some(function (e) { return e.stage === 'STAGE 16/18 storage-write-failed'; }), 'MISSION PROOF: the failure is still recorded in the diagnostic buffer (a different, unaffected key) even when the session key can never be written');
      // Honest, documented limitation: when NO write to this key can
      // ever land, discovery.status in storage cannot be changed either
      // — the engine has still genuinely stopped (proven by settling
      // cleanly with no hang/unhandled rejection above), which is the
      // strongest guarantee possible when storage itself is completely
      // unwritable for this key.
      assert(store4['ws_live_session::example.com'].discovery.status === 'discovering', 'documented limitation: storage genuinely cannot be updated when every write to this key fails — the ENGINE still stopped (see above), proven separately from storage state');
    } finally {
      process.removeListener('unhandledRejection', onUnhandled4);
    }
  }

  // ---- STOP_DISCOVERY's own setSession() call site (the one call site
  // NOT routed through runDiscoveryLoopSafe) never hangs the message
  // channel on a write failure. ----
  {
    var store5 = {};
    var sb5 = loadDiscovery({
      sharedStore: store5, url: 'https://example.com/page5',
      quotaFailFn: function (key) { return key === 'ws_live_session::example.com'; }
    });
    await settle(sb5); // bootstrap resolves first against an empty store — harmless
    var seeded5 = baseDiscoverySession();
    store5['ws_live_session::example.com'] = seeded5;

    var state5 = sb5.__dispatchMessage({ type: 'STOP_DISCOVERY' });
    await settle(sb5);

    assert(state5.called === true, 'MISSION PROOF: STOP_DISCOVERY calls sendResponse() and never hangs the message channel, even when persisting the stopped state fails');
    assert(state5.response && state5.response.ok === true, 'STOP_DISCOVERY still honestly reports ok:true — the in-memory stop (discoveryStopRequested) took effect regardless of whether the storage write landed');
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
