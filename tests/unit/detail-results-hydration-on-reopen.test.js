/**
 * detail-results-hydration-on-reopen.test.js (FAST/local, no browser)
 * BUG FIX — real production report: a fully COMPLETED Detail Enrichment
 * run's own field data (already sitting correctly in ws_deepscrape_run/
 * ws_deepscrape_fields) never appeared in the Results table or any
 * export after the popup was closed and reopened, even though nothing
 * about the underlying data was missing or wrong.
 *
 * ROOT CAUSE (see popup.js's hydrateDetailResultsIfAny() own header
 * comment): the only existing call to mergeDetailResults() ran too early
 * in init()'s own sequence — at that point `detailConfig` (selected
 * fields/source column) was still unhydrated (only ever populated
 * lazily by renderDetailSetup(), which requires visiting the Detay tab)
 * AND `rawRows` was still empty (restoreLiveSessionIfAny(), which
 * actually populates it, runs ~400 lines later in the same init()).
 *
 * FIX: a new, dedicated hydrateDetailResultsIfAny() step, called once
 * IMMEDIATELY AFTER restoreLiveSessionIfAny() resolves (so rawRows is
 * final) — reads whatever a COMPLETED/STOPPED/ERROR-terminal Detail run
 * already has in storage and merges it, using the exact same, unmodified
 * mergeDetailResults()/ensureDetailConfigHydrated() functions this
 * project already had. Never sends a message to background.js, never
 * opens a tab, never re-fetches a single product page — pure hydration
 * of already-finished work.
 *
 * Drives the REAL, unmodified popup.js via tests/lib/load-popup.js — a
 * genuinely fresh popup load (simulating "popup closed, then reopened"),
 * never a reimplementation of hydrateDetailResultsIfAny()/
 * mergeDetailResults().
 *
 * Standalone-runnable: `node tests/unit/detail-results-hydration-on-reopen.test.js`.
 */
'use strict';
const { loadPopup } = require('../lib/load-popup');
const { makeSuite } = require('../lib/assert');

async function settle(ticks) {
  for (var i = 0; i < (ticks || 40); i++) await new Promise(function (r) { setTimeout(r, 0); });
}

/** Builds a realistic seed: a completed main scrape (5 rows, standing in
 * for the real 1,263) with a Link-type source column, a COMPLETED Detail
 * run over all 5 URLs (4 successful, 1 "missing"/partial — standing in
 * for the real 1,175/88 split), the field values already persisted, and
 * the field CONFIGURATION already persisted (matching the Bug #2
 * ws_detail_active_config fix from the prior mission — configuration
 * survives independently of any run/popup lifecycle). */
function fullSeed() {
  var rows = [
    { c_title: 'Product 1', c_link: 'https://example.com/listing/1' },
    { c_title: 'Product 2', c_link: 'https://example.com/listing/2' },
    { c_title: 'Product 3', c_link: 'https://example.com/listing/3' },
    { c_title: 'Product 4', c_link: 'https://example.com/listing/4' },
    { c_title: 'Product 5', c_link: 'https://example.com/listing/5' } // this one will be "missing" (partial, no seller value)
  ];
  var detailFields = [
    { id: 'f_seller', name: 'Seller', relativeSelector: '.seller-name', attribute: 'text', multiple: 'first' },
    { id: 'f_desc', name: 'Description', relativeSelector: '.desc', attribute: 'text', multiple: 'first' }
  ];
  var results = {};
  var fieldsMap = {};
  [1, 2, 3, 4].forEach(function (n) {
    var url = 'https://example.com/listing/' + n;
    results[url] = { status: 'completed', error: null, httpStatus: 200, finalUrl: null, retryStatus: null, failureType: null };
    fieldsMap[url] = { f_seller: 'Seller ' + n, f_desc: 'Description text for product ' + n };
  });
  var missingUrl = 'https://example.com/listing/5';
  results[missingUrl] = { status: 'partial', error: null, httpStatus: 200, finalUrl: null, retryStatus: null, failureType: null };
  fieldsMap[missingUrl] = { f_seller: '', f_desc: '' }; // page loaded, but nothing extractable — genuinely missing, never fabricated

  return {
    'ws_live_session::example.com': {
      sessionId: 's1', hostname: 'example.com', status: 'active',
      rows: rows, seenKeys: {}, lastPassNewRows: 0, lastCheckAt: null,
      progress: { rowsCollected: rows.length }
    },
    'ws_state::example.com': { containerSelector: '.item', columns: [{ id: 'c_title', name: 'Title', relativeSelector: 'h2', attribute: 'text' }, { id: 'c_link', name: 'Link', relativeSelector: 'a', attribute: 'href' }] },
    'ws_detail_active_config::example.com': { sourceColumnId: 'c_link', fields: detailFields },
    'ws_deepscrape_run': {
      runId: 'dse_1788000000000_abc123', status: 'completed', fields: detailFields, results: results,
      counts: { total: 5, completed: 4, pending: 0, fetching: 0, partial: 1, failed: 0, skipped: 0, timeouts: 0 },
      currentUrl: null, currentRecordDiag: null, error: null,
      startedAt: Date.now() - 60000, updatedAt: Date.now(), finishedAt: Date.now()
    },
    'ws_deepscrape_fields': fieldsMap
  };
}

async function run() {
  const suite = makeSuite('detail-results-hydration-on-reopen');
  const assert = suite.assert;

  // ---- The exact reported scenario: main scrape + completed Detail run
  // + persisted field data + persisted field CONFIG already sitting in
  // storage BEFORE the popup ever loads (simulating "popup closed after
  // Detail completed, now reopened") — no RUN_EXTRACTION/BAŞLA click at
  // all, this is a pure reopen. ----
  var sentToBackground = [];
  var sentToContent = [];
  var sb = await loadPopup({
    seedLocalStorage: fullSeed(),
    tabUrl: 'https://example.com/some-listing-page',
    runtimeSendMessageImpl: function (message) { sentToBackground.push(message); return { ok: true }; },
    sendMessageImpl: function (tabId, message) { sentToContent.push(message); return { ok: true }; }
  });
  await settle();

  // ---- MISSION PROOF: hydration restored the Detail columns/values
  // into the actual in-memory rawRows the Results table/exports read
  // from (exposed via the real, existing __wsDiscoveryTestHooks test
  // seam — never a reimplementation). ----
  var rawRows = sb.__wsDiscoveryTestHooks.getRawRows();
  assert(rawRows.length === 5, 'MISSION PROOF: all 5 (standing in for the real 1,263) main-scrape rows are preserved exactly — got ' + rawRows.length);

  var dtSellerColId = 'dt_f_seller';
  var dtDescColId = 'dt_f_desc';
  var row1 = rawRows.filter(function (r) { return r.c_link === 'https://example.com/listing/1'; })[0];
  assert(row1 && row1[dtSellerColId] === 'Seller 1', 'MISSION PROOF: Detail column value for a successful record is hydrated from ALREADY-STORED data — got ' + JSON.stringify(row1 && row1[dtSellerColId]));
  assert(row1 && row1[dtDescColId] === 'Description text for product 1', 'the second Detail field is also hydrated correctly');

  var row5 = rawRows.filter(function (r) { return r.c_link === 'https://example.com/listing/5'; })[0];
  assert(row5 && row5[dtSellerColId] === '', 'MISSION PROOF: the "missing" record (partial, no seller value) stays genuinely BLANK — never fabricated — got ' + JSON.stringify(row5 && row5[dtSellerColId]));

  // ---- MISSION PROOF: no Detail worker/navigation of any kind was
  // started during hydration — this is a pure read of already-finished
  // work, never a new scrape. ----
  assert(sentToBackground.length === 0, 'MISSION PROOF: hydration sends ZERO messages to background.js — no new Detail run, no re-fetch of any product page — got ' + JSON.stringify(sentToBackground));
  assert(sentToContent.length === 0, 'MISSION PROOF: hydration sends ZERO messages to the content script (no RUN_EXTRACTION/navigation) — got ' + JSON.stringify(sentToContent));

  // ---- MISSION PROOF: the exported dataset (real "Export Data" -> CSV
  // button flow, never a reimplementation of the export pipeline) also
  // contains the Detail columns/values. ----
  var csvBtn = sb.getEl('export-csv-btn');
  csvBtn.click();
  await settle();
  assert(sb.__blobsCreated.length === 1, 'MISSION PROOF: clicking the real CSV export button produced a real download — got ' + sb.__blobsCreated.length + ' blob(s)');
  var csvContent = sb.__blobsCreated[0].content;
  assert(csvContent.indexOf('Seller') !== -1, 'MISSION PROOF: the exported CSV header row includes the Detail "Seller" column — csv head: ' + csvContent.slice(0, 300));
  assert(csvContent.indexOf('Seller 1') !== -1, 'MISSION PROOF: the exported CSV contains the real hydrated Detail VALUE ("Seller 1"), not just the column header');
  assert(csvContent.indexOf('Description text for product 2') !== -1, 'a second row\'s Detail value is present in the export too');

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
