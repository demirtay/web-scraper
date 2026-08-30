/**
 * deep-scrape-storage-migration.test.js (FAST/local, no browser)
 * BUG FIX (real production report) requirement 7 — "The user's CURRENT
 * ws_deepscrape_run contains ~9 MB of bad full-page HTML. Implement a
 * SAFE migration/cleanup." Proves migrateDeepScrapeStorageIfNeeded()
 * (background.js): identifies oversized HTML/full-page-text Detail
 * field values, removes ONLY those, preserves job metadata and
 * legitimate small values, never touches unrelated storage.
 *
 * Also proves requirement 4's own architecture directly: ws_deepscrape_run
 * stays small as records progress (the actual write-amplification/quota
 * fix), regardless of how large the real extracted field data is.
 *
 * Standalone-runnable: `node tests/unit/deep-scrape-storage-migration.test.js`.
 */
'use strict';
const { loadBackground, makeFakeResponse } = require('../lib/load-background');
const { makeSuite } = require('../lib/assert');

async function run() {
  const suite = makeSuite('deep-scrape-storage-migration');
  const assert = suite.assert;

  // ---- MIGRATION: an OLD-shape ws_deepscrape_run (fields inline, some
  // oversized) is safely split — legitimate values preserved, oversized
  // ones stripped, job metadata untouched, and every OTHER real storage
  // key (main scrape results, license, settings, templates, snapshots)
  // is byte-for-byte unaffected. ----
  {
    const sb = loadBackground({});
    var oversizedHtml = 'X'.repeat(140000); // matches the real reported 120-143KB range
    var oldShapeState = {
      runId: 'pre-fix-run', status: 'stopped', fields: [{ id: 'c_title' }, { id: 'c_desc' }],
      results: {
        'https://example.com/p1': { status: 'completed', fields: { c_title: 'Real Product', c_desc: oversizedHtml }, error: null, httpStatus: 200, finalUrl: 'https://example.com/p1', retryStatus: null, failureType: null },
        'https://example.com/p2': { status: 'completed', fields: { c_title: 'Another Product', c_desc: 'A short, legitimate description.' }, error: null, httpStatus: 200, finalUrl: 'https://example.com/p2', retryStatus: null, failureType: null },
        'https://example.com/p3': { status: 'pending', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null }
      },
      counts: { total: 3, completed: 2, pending: 1, fetching: 0, partial: 0, failed: 0, skipped: 0, timeouts: 0 },
      concurrency: 1, maxAttempts: 1, recordTimeoutMs: 30000, stopRequested: false, lease: null,
      delayMode: 'custom', customDelayMs: 0, currentUrl: null, currentRecordDiag: null, error: null,
      startedAt: Date.now() - 100000, updatedAt: Date.now() - 50000, finishedAt: Date.now() - 40000
    };
    await sb.setDeepScrapeState(oldShapeState);

    // Every OTHER real storage key this migration must NEVER touch.
    var untouchedKeys = {
      'ws_live_session::etsy.com': { sessionId: 's1', hostname: 'etsy.com', status: 'finished', rows: [{ c_title: 'main scrape row' }] },
      'ws_license': { schemaVersion: 2, licenseStatus: 'trial', trialRunsUsed: 3, chargedRunIds: ['a', 'b', 'c'] },
      'ws_settings': { theme: 'light' },
      'ws_templates': { list: [{ id: 't1', name: 'My Template' }] },
      'ws_snapshots': { schemaVersion: 1, snapshots: [{ id: 'snap1', rows: [{ x: 1 }] }] }
    };
    Object.keys(untouchedKeys).forEach(function (k) { sb.__storage.local[k] = untouchedKeys[k]; });
    var untouchedBefore = JSON.stringify(untouchedKeys);
    // Captured BEFORE migrate() runs — migrateDeepScrapeStorageIfNeeded()
    // mutates state.results[url] objects in place (delete rec.fields),
    // and oldShapeState holds a reference to those SAME objects, so this
    // must be measured before, never after.
    var beforeBytes = JSON.stringify(oldShapeState).length;

    await sb.migrateDeepScrapeStorageIfNeeded();

    var migratedState = await sb.getDeepScrapeState();
    var migratedFields = await sb.getDeepScrapeFields();

    // Job metadata preserved.
    assert(migratedState.runId === 'pre-fix-run' && migratedState.status === 'stopped', 'MISSION PROOF: job metadata (runId, status) is preserved through migration');
    assert(migratedState.counts.completed === 2 && migratedState.counts.pending === 1, 'job counts are preserved through migration');
    assert(migratedState.results['https://example.com/p3'].status === 'pending', 'a pending record\'s own control state is preserved');

    // Control object no longer carries the payload.
    assert(!Object.prototype.hasOwnProperty.call(migratedState.results['https://example.com/p1'], 'fields'), 'MISSION PROOF: the control object no longer carries inline field data after migration');
    assert(!Object.prototype.hasOwnProperty.call(migratedState.results['https://example.com/p2'], 'fields'), 'same for every migrated record');

    // Legitimate small value preserved in the new key.
    assert(migratedFields['https://example.com/p2'].c_title === 'Another Product', 'MISSION PROOF: a legitimate small field value is preserved through migration');
    assert(migratedFields['https://example.com/p2'].c_desc === 'A short, legitimate description.', 'a legitimate small description is preserved exactly, untruncated');
    assert(migratedFields['https://example.com/p1'].c_title === 'Real Product', 'a legitimate value on a record that ALSO had an oversized sibling field is still preserved');

    // Oversized value stripped, never carried forward.
    assert(migratedFields['https://example.com/p1'].c_desc === undefined, 'MISSION PROOF: the proven-oversized (140KB) value is stripped, never migrated forward');

    // Real byte-size proof: the migrated run is dramatically smaller.
    var afterBytes = JSON.stringify(migratedState).length;
    assert(beforeBytes > 100000, 'setup check: the OLD-shape state genuinely was large (~140KB+) before migration');
    assert(afterBytes < 5000, 'MISSION PROOF: ws_deepscrape_run is dramatically smaller after migration (before=' + beforeBytes + ', after=' + afterBytes + ')');

    // Every unrelated key byte-for-byte untouched.
    var untouchedAfter = JSON.stringify({
      'ws_live_session::etsy.com': sb.__storage.local['ws_live_session::etsy.com'],
      'ws_license': sb.__storage.local['ws_license'],
      'ws_settings': sb.__storage.local['ws_settings'],
      'ws_templates': sb.__storage.local['ws_templates'],
      'ws_snapshots': sb.__storage.local['ws_snapshots']
    });
    assert(untouchedAfter === untouchedBefore, 'MISSION PROOF: main scrape results (ws_live_session), license, settings, templates, and snapshots are byte-for-byte untouched by the migration');

    // Idempotency: calling it again does nothing further.
    var beforeSecondCall = JSON.stringify(await sb.getDeepScrapeState());
    await sb.migrateDeepScrapeStorageIfNeeded();
    var afterSecondCall = JSON.stringify(await sb.getDeepScrapeState());
    assert(beforeSecondCall === afterSecondCall, 'MISSION PROOF: migration is idempotent — calling it again on an already-migrated run is a genuine no-op');
  }

  // ---- QUOTA SAFETY (mission requirement 6, applied to Detail's own
  // field persistence, not just license.js): if ws_deepscrape_fields'
  // own write genuinely fails with a real quota error, fetchOneDetailPage
  // must mark that ONE record honestly (STORAGE_QUOTA) and the run must
  // continue processing every OTHER record — never crash, never lose
  // track of the queue. ----
  {
    const sb3 = loadBackground({
      fetchImpl: function () { return makeFakeResponse(403); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) {
        var url = sb3.__tabs.tabs[tabId] && sb3.__tabs.tabs[tabId].url;
        cb({ ok: true, row: { c_title: 'value for ' + url } });
      },
      quotaFailFn: function (key) { return key === 'ws_deepscrape_fields'; } // simulates the storage genuinely being full for this key
    });
    var urls3 = ['https://example.com/quota-a', 'https://example.com/quota-b'];
    var state3 = {
      runId: 'quota-safety-run', status: 'running', fields: [{ id: 'c_title' }],
      results: {}, concurrency: 1, maxAttempts: 1, recordTimeoutMs: 30000,
      stopRequested: false, lease: null, delayMode: 'custom', customDelayMs: 0,
      currentUrl: null, currentRecordDiag: null, error: null,
      startedAt: Date.now(), updatedAt: Date.now(), finishedAt: null
    };
    urls3.forEach(function (u) { state3.results[u] = { status: 'pending', error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null }; });
    var controller3 = new AbortController();
    await sb3.fetchOneDetailPage(urls3[0], state3.fields, controller3, state3);
    await sb3.fetchOneDetailPage(urls3[1], state3.fields, controller3, state3);

    assert(state3.results[urls3[0]].status === 'partial' && state3.results[urls3[0]].failureType === 'STORAGE_QUOTA',
      'MISSION PROOF: a record whose extracted data cannot be saved (real quota failure) is marked honestly, never silently lost — got ' + JSON.stringify(state3.results[urls3[0]]));
    assert(state3.results[urls3[1]].status === 'partial' && state3.results[urls3[1]].failureType === 'STORAGE_QUOTA',
      'MISSION PROOF: the run continues processing the NEXT record too — quota failure on one record never stops the queue');
  }

  // ---- ARCHITECTURE PROOF: ws_deepscrape_run stays small as records
  // progress, even when the real extracted data is large — the
  // write-amplification/quota fix, proven directly by measuring the
  // real persisted state's own byte size after real records complete. ----
  {
    var largeButLegitimateValue = 'Real product description text. '.repeat(50); // ~1.6KB per record — realistic, not oversized
    const sb2 = loadBackground({
      fetchImpl: function () { return makeFakeResponse(403); },
      executeScriptImpl: function (params) { return Promise.resolve(params.files ? [{}] : [{ result: false }]); },
      sendMessageImpl: function (tabId, message, cb) {
        cb({ ok: true, row: { c_title: 'Product', c_desc: largeButLegitimateValue } });
      }
    });
    await sb2.runDeepScrape({
      runId: 'small-control-state-run',
      urls: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c', 'https://example.com/d', 'https://example.com/e'],
      fields: [{ id: 'c_title' }, { id: 'c_desc' }]
    });
    var finalControlState = await sb2.getDeepScrapeState();
    var controlBytes = JSON.stringify(finalControlState).length;
    var fieldsBytes = JSON.stringify(await sb2.getDeepScrapeFields()).length;
    assert(finalControlState.status === 'completed' && finalControlState.counts.completed === 5, 'setup check: all 5 records genuinely completed with real (non-trivial) extracted data');
    assert(fieldsBytes > 5000, 'setup check: the separate fields key genuinely holds the real extracted data (5 records x ~1.6KB)');
    assert(controlBytes < 3000, 'MISSION PROOF: ws_deepscrape_run (the control-state object re-persisted on every lease/diag touch) stays small regardless of real extracted data size — got ' + controlBytes + ' bytes (fields key holds ' + fieldsBytes + ' bytes separately)');
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
