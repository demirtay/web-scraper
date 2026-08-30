/**
 * pagination-diag-buffer.test.js (FAST/local, no browser)
 * NEW DIAGNOSTIC TOOL — real production report: main discovery/pagination
 * stuck on page 11 on real Etsy, and the page's own DevTools console is
 * destroyed on every real pagination navigation, making the existing
 * [WS-PAGE-DIAG] console.log markers alone impractical to chase across a
 * multi-page run. This proves, via the REAL, unmodified content/
 * discovery.js (loaded through tests/lib/load-discovery.js — never a
 * reimplementation):
 *   - diagnostic entries survive a real page navigation / content-script
 *     reinjection (chrome.storage.local, not memory/console, is what
 *     actually persists)
 *   - the ring buffer caps at exactly 100 entries, oldest dropped first
 *   - a genuinely NEW main scrape (START_DISCOVERY) clears the previous
 *     run's diagnostic entries
 *   - diagnostic logging never breaks discovery, even when every
 *     underlying storage write fails
 *   - the buffer stays small — an oversized value is never persisted
 *     verbatim
 *
 * Standalone-runnable: `node tests/unit/pagination-diag-buffer.test.js`.
 */
'use strict';
const { loadDiscovery } = require('../lib/load-discovery');
const { makeSuite } = require('../lib/assert');

/** Lets both the synchronous-plus-microtask push chain (including
 * content/discovery.js's own bootstrap-resume block, which pushes its own
 * BOOTSTRAP-* entries at load time) settle, then awaits the diagnostic
 * write queue itself — same "20 ticks" convention tests/lib/load-popup.js
 * already established for settling its own init() chain. */
async function settle(sandbox, ticks) {
  for (var i = 0; i < (ticks || 20); i++) {
    await new Promise(function (r) { setTimeout(r, 0); });
  }
  await sandbox.WSDiscovery.flushPageDiagQueue();
}

async function run() {
  const suite = makeSuite('pagination-diag-buffer');
  const assert = suite.assert;

  // ---- Entries survive a real page navigation / content-script
  // reinjection: chrome.storage.local (not memory/console) is the thing
  // that actually persists across that transition. ----
  {
    var sharedStore = {};
    var sbA = loadDiscovery({ sharedStore: sharedStore, url: 'https://etsy.com/page1' });
    await settle(sbA);
    sbA.WSDiscovery.clearPaginationDiagBuffer(); // isolate from bootstrap noise
    await settle(sbA);
    sbA.WSDiscovery.pushPageDiag('STAGE 1/2/3', { page: 5, discoveryStatus: 'discovering' });
    await settle(sbA);

    // Simulate the real navigation destroying instance A and a FRESH
    // content-script instance loading on the new page — a brand-new
    // sandbox/closure (fresh pageDiagQueue, fresh everything), but
    // pointed at the SAME backing storage object, exactly like a real
    // navigation.
    var sbB = loadDiscovery({ sharedStore: sharedStore, url: 'https://etsy.com/page2' });
    await settle(sbB);
    sbB.WSDiscovery.pushPageDiag('STAGE 1/2/3', { page: 6, discoveryStatus: 'discovering' });
    await settle(sbB);

    var stages = sharedStore['ws_pagination_diag'].entries.map(function (e) { return e.stage + ':' + e.page; });
    assert(stages.indexOf('STAGE 1/2/3:5') !== -1, 'MISSION PROOF: instance A\'s entry survived into the shared buffer — got ' + JSON.stringify(stages));
    assert(stages.indexOf('STAGE 1/2/3:6') !== -1, 'MISSION PROOF: instance B (fresh, post-navigation) entry also present — got ' + JSON.stringify(stages));
    var idxA = stages.indexOf('STAGE 1/2/3:5'), idxB = stages.indexOf('STAGE 1/2/3:6');
    assert(idxA < idxB, 'MISSION PROOF: chronological order preserved across the navigation — A\'s entry (page 5) precedes B\'s (page 6)');
  }

  // ---- Bounded ring buffer: caps at exactly 100 entries, oldest dropped
  // first. ----
  {
    var store2 = {};
    var sb2 = loadDiscovery({ sharedStore: store2, url: 'https://etsy.com/cap-test' });
    await settle(sb2);
    sb2.WSDiscovery.clearPaginationDiagBuffer();
    await settle(sb2);
    for (var i = 0; i < 105; i++) {
      sb2.WSDiscovery.pushPageDiag('stage-' + i, { page: i });
    }
    await settle(sb2);
    var entries2 = store2['ws_pagination_diag'].entries;
    assert(entries2.length === 100, 'MISSION PROOF: buffer caps at exactly 100 entries even after 105 pushes — got ' + entries2.length);
    assert(entries2[0].stage === 'stage-5', 'MISSION PROOF: the OLDEST entries are dropped first (first surviving entry is stage-5, i.e. stage-0..stage-4 were evicted) — got ' + entries2[0].stage);
    assert(entries2[99].stage === 'stage-104', 'the newest entry (stage-104) is present at the end — got ' + entries2[99].stage);
  }

  // ---- A genuinely NEW main scrape (START_DISCOVERY) clears the
  // previous run's diagnostic entries. ----
  {
    var store3 = {};
    var sb3 = loadDiscovery({ sharedStore: store3, url: 'https://etsy.com/clear-test' });
    await settle(sb3);
    sb3.WSDiscovery.pushPageDiag('STAGE 1/2/3', { page: 3 });
    await settle(sb3);
    assert(store3['ws_pagination_diag'].entries.length > 0, 'setup check: buffer genuinely has entries from a "previous run" before START_DISCOVERY fires');

    sb3.__dispatchMessage({ type: 'START_DISCOVERY' });
    assert(store3['ws_pagination_diag'].entries.length === 0, 'MISSION PROOF: START_DISCOVERY (a genuinely new main scrape) clears the pagination diagnostic buffer synchronously — old run\'s entries are gone');
  }

  // ---- Diagnostic logging never breaks discovery, even when EVERY
  // underlying storage write fails (quota exceeded / any other reason). ----
  {
    var unhandled = [];
    var onUnhandled = function (err) { unhandled.push(err); };
    process.on('unhandledRejection', onUnhandled);
    try {
      var store4 = {};
      var sb4 = loadDiscovery({ sharedStore: store4, url: 'https://etsy.com/quota-fail-test', quotaFailFn: function () { return true; } });
      await settle(sb4);
      var threw = null;
      try {
        sb4.WSDiscovery.pushPageDiag('STAGE 1/2/3', { page: 1 });
        await settle(sb4);
      } catch (e) { threw = e; }
      assert(!threw, 'MISSION PROOF: pushPageDiag() never throws even when every underlying storage write fails — got ' + (threw && threw.message));
      await new Promise(function (r) { setTimeout(r, 20); });
      assert(unhandled.length === 0, 'MISSION PROOF: zero unhandled promise rejections anywhere in the diagnostic write chain when storage writes fail — got ' + unhandled.length);
      // The write genuinely failed (nothing persisted) — proves the
      // quota-failure simulation is real, not silently a no-op success.
      assert(!store4['ws_pagination_diag'] || (store4['ws_pagination_diag'].entries || []).length === 0, 'the failed write genuinely did not persist anything (proves the quota-fail simulation is real)');
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  }

  // ---- The buffer MUST stay small: an oversized value handed to
  // pushPageDiag() is never stored verbatim. ----
  {
    var store5 = {};
    var sb5 = loadDiscovery({ sharedStore: store5, url: 'https://etsy.com/oversize-test' });
    await settle(sb5);
    sb5.WSDiscovery.clearPaginationDiagBuffer();
    await settle(sb5);
    var hugeValue = new Array(5000).join('<div>simulated accidental page HTML</div>'); // ~205KB
    sb5.WSDiscovery.pushPageDiag('STAGE 15/16/17 timeout', { reason: hugeValue });
    await settle(sb5);
    var entries5 = store5['ws_pagination_diag'].entries;
    assert(entries5.length === 1, 'setup check: exactly one entry was pushed');
    var persisted = JSON.stringify(entries5[0]);
    assert(persisted.length < sb5.WSDiscovery.PAGE_DIAG_ENTRY_MAX_BYTES + 500, 'MISSION PROOF: an oversized value is never persisted verbatim — persisted entry stayed small (' + persisted.length + ' bytes) despite a ~' + hugeValue.length + '-byte input');
    assert(entries5[0].truncated === true, 'MISSION PROOF: the oversized entry is honestly marked truncated, never silently accepted as-is');
    assert(persisted.length < hugeValue.length / 100, 'MISSION PROOF: the persisted entry is over 100x smaller than the oversized input — the full payload was never written to storage');
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
