/**
 * detail-enrichment-merge-survives-live-session-writes.test.js (FAST/local, no browser)
 * REAL DETAIL ENRICHMENT VERIFICATION FAILED mission — real production
 * report: after a healthy 302-row/7-page main scrape completed and a
 * Detail Enrichment run visited every product page and finished
 * ('completed'), the real exported Excel had all 7 Detail columns
 * (weight/dimensions/materyal/base/type/about/yorum sayısı) present as
 * HEADERS but with EVERY ONE of the 302 rows blank under them — even
 * though `ws_deepscrape_run`/`ws_deepscrape_fields` genuinely held the
 * extracted values, correctly keyed by the same URLs as the main rows.
 *
 * ROOT CAUSE (see popup.js's attachLiveSessionStorageListener() own
 * updated header comment): mergeDetailResults() only ever mutates
 * `rawRows` IN MEMORY — by design, it never writes dt_* values back into
 * ws_live_session storage. attachLiveSessionStorageListener()'s
 * chrome.storage.onChanged callback unconditionally did
 * `rawRows = activeLiveSession.rows;` every time ws_live_session::host
 * changed — and it stays attached (session.status === 'active') for as
 * long as the popup is open on that session, long after the main scrape
 * itself finished. content/livewatch.js's own passive MutationObserver-
 * driven rescan keeps running on the original scrape tab for exactly
 * that whole time and re-persists this same session key on essentially
 * any DOM mutation (ads, carousels, lazy widgets) — completely
 * independent of Detail Enrichment. The very next such write, arriving
 * any time after Detail finished (a near-certainty on a real page over
 * however long a 302-URL Detail run takes), silently replaced the
 * already-merged in-memory `rawRows` with a fresh, Detail-column-free
 * copy straight from storage — wiping every dt_* value back to blank,
 * with the columns themselves (a separate, unaffected `detailColumns`
 * list) still correctly present as export headers. That mismatch —
 * headers present, every value blank — is EXACTLY the reported symptom.
 *
 * FIX: attachLiveSessionStorageListener() now re-runs the exact same,
 * already-correct, URL-keyed hydrateDetailResultsIfAny() every time it
 * replaces `rawRows` — a pure re-application of whatever a TERMINAL
 * Detail run already has in storage, never a new fetch/navigation.
 *
 * Drives the REAL, unmodified popup.js via tests/lib/load-popup.js, and
 * a real, unmodified chrome.storage.onChanged listener via the loader's
 * new (purely additive, zero-behavior-change-elsewhere — see its own
 * comment) fireStorageChange() capture/dispatch helper — never a
 * reimplementation of attachLiveSessionStorageListener()/
 * mergeDetailResults()/hydrateDetailResultsIfAny().
 *
 * Standalone-runnable:
 * `node tests/unit/detail-enrichment-merge-survives-live-session-writes.test.js`.
 */
'use strict';
const { loadPopup } = require('../lib/load-popup');
const { makeSuite } = require('../lib/assert');

async function settle(ticks) {
  for (var i = 0; i < (ticks || 40); i++) await new Promise(function (r) { setTimeout(r, 0); });
}

// ---------------------------------------------------------------------
// Scenario A — the mission's own explicit 3-row spec.
// ---------------------------------------------------------------------
function threeRowSeed() {
  var rows = [
    { c_title: 'Widget A', c_price: '$10.00', c_link: 'https://example.com/p/A' },
    { c_title: 'Widget B', c_price: '$20.00', c_link: 'https://example.com/p/B' },
    { c_title: 'Widget C', c_price: '$30.00', c_link: 'https://example.com/p/C' }
  ];
  var detailFields = [
    { id: 'f_weight', name: 'weight', relativeSelector: '.weight', attribute: 'text', multiple: 'first' },
    { id: 'f_material', name: 'material', relativeSelector: '.material', attribute: 'text', multiple: 'first' },
    { id: 'f_about', name: 'about', relativeSelector: '.about', attribute: 'text', multiple: 'first' }
  ];
  var results = {}, fieldsMap = {};
  var data = { A: ['1kg', 'Metal', 'AAA'], B: ['2kg', 'Wood', 'BBB'], C: ['3kg', 'Plastic', 'CCC'] };
  Object.keys(data).forEach(function (k) {
    var url = 'https://example.com/p/' + k;
    results[url] = { status: 'completed', error: null, httpStatus: 200, finalUrl: null, retryStatus: null, failureType: null };
    fieldsMap[url] = { f_weight: data[k][0], f_material: data[k][1], f_about: data[k][2] };
  });
  return {
    'ws_live_session::example.com': {
      sessionId: 's1', hostname: 'example.com', status: 'active',
      rows: rows, seenKeys: {}, lastPassNewRows: 0, lastCheckAt: null,
      discovery: { enabled: true, status: 'no-next-found' }, // main scrape genuinely finished, not mid-discovery
      progress: { rowsCollected: rows.length }
    },
    'ws_state::example.com': { containerSelector: '.item', columns: [
      { id: 'c_title', name: 'Title', relativeSelector: 'h2', attribute: 'text' },
      { id: 'c_price', name: 'Price', relativeSelector: '.price', attribute: 'text' },
      { id: 'c_link', name: 'Link', relativeSelector: 'a', attribute: 'href' }
    ] },
    'ws_detail_active_config::example.com': { sourceColumnId: 'c_link', fields: detailFields },
    'ws_deepscrape_run': {
      runId: 'dse_1788400000000_xyz789', status: 'completed', fields: detailFields, results: results,
      counts: { total: 3, completed: 3, pending: 0, fetching: 0, partial: 0, failed: 0, skipped: 0, timeouts: 0 },
      currentUrl: null, currentRecordDiag: null, error: null,
      startedAt: Date.now() - 60000, updatedAt: Date.now(), finishedAt: Date.now()
    },
    'ws_deepscrape_fields': fieldsMap
  };
}

/** The exact row shape content/livewatch.js's own runDetectionPass() ->
 * WSRunState.mergeNewRows() -> logPass() would persist back to
 * ws_live_session storage on a passive rescan that finds the SAME rows
 * again (no new products) — genuinely no dt_* fields, since that entire
 * pipeline runs inside the content script and has no concept of Detail
 * Enrichment at all. Deliberately reuses the exact same row objects/
 * values already in storage (a real passive rescan wouldn't invent new
 * ones) — the only thing this simulates is a NEW write on the SAME key,
 * exactly what re-triggers attachLiveSessionStorageListener(). */
function simulateLivewatchRescanWrite(sb, sessionKey, currentSession) {
  var fresh = JSON.parse(JSON.stringify(currentSession));
  fresh.updatedAt = Date.now();
  fresh.lastCheckAt = Date.now();
  sb.fireStorageChange('local', (function () { var o = {}; o[sessionKey] = fresh; return o; })());
  return fresh;
}

async function run() {
  const suite = makeSuite('detail-enrichment-merge-survives-live-session-writes');
  const assert = suite.assert;

  // =====================================================================
  // SCENARIO A — mission's own explicit 3-row spec
  // =====================================================================
  var seedA = threeRowSeed();
  var sentToBackgroundA = [], sentToContentA = [];
  var sbA = await loadPopup({
    seedLocalStorage: seedA,
    tabUrl: 'https://example.com/some-listing-page',
    runtimeSendMessageImpl: function (m) { sentToBackgroundA.push(m); return { ok: true }; },
    sendMessageImpl: function (t, m) { sentToContentA.push(m); return { ok: true }; }
  });
  await settle();

  // ---- mergeDetailResults() maps all 3 by URL; base Title/Price
  // unchanged; final rows contain all Detail values. ----
  var rawRowsA = sbA.__wsDiscoveryTestHooks.getRawRows();
  assert(rawRowsA.length === 3, 'MISSION PROOF (item: mergeDetailResults maps all 3 by URL): 3 rows present — got ' + rawRowsA.length);
  var byLink = {};
  rawRowsA.forEach(function (r) { byLink[r.c_link] = r; });
  assert(byLink['https://example.com/p/A'].c_title === 'Widget A' && byLink['https://example.com/p/A'].c_price === '$10.00', 'MISSION PROOF: base Title/Price values remain unchanged for A');
  assert(byLink['https://example.com/p/B'].c_title === 'Widget B' && byLink['https://example.com/p/B'].c_price === '$20.00', 'MISSION PROOF: base Title/Price values remain unchanged for B');
  assert(byLink['https://example.com/p/A']['dt_f_weight'] === '1kg' && byLink['https://example.com/p/A']['dt_f_material'] === 'Metal' && byLink['https://example.com/p/A']['dt_f_about'] === 'AAA', 'MISSION PROOF: row A carries all 3 Detail values');
  assert(byLink['https://example.com/p/B']['dt_f_weight'] === '2kg' && byLink['https://example.com/p/C']['dt_f_weight'] === '3kg', 'MISSION PROOF: rows B/C each carry their OWN Detail values (never cross-mixed, never positional)');

  // ---- final export headers are exactly Title, Price, weight, material, about; exported rows contain real values ----
  var csvBtnA = sbA.getEl('export-csv-btn');
  csvBtnA.click();
  await settle();
  assert(sbA.__blobsCreated.length === 1, 'MISSION PROOF: CSV export produced before the live-session write — sanity baseline');
  var csvBefore = sbA.__blobsCreated[sbA.__blobsCreated.length - 1].content;
  ['Title', 'Price', 'weight', 'material', 'about'].forEach(function (h) {
    assert(csvBefore.indexOf(h) !== -1, 'MISSION PROOF: export header includes "' + h + '" — csv head: ' + csvBefore.slice(0, 200));
  });
  assert(csvBefore.indexOf('1kg') !== -1 && csvBefore.indexOf('Metal') !== -1 && csvBefore.indexOf('AAA') !== -1, 'MISSION PROOF: exported rows contain the actual Detail values, not blanks — csv: ' + csvBefore);

  // =====================================================================
  // THE REAL BUG, reproduced directly: a livewatch-style passive rescan
  // re-persists ws_live_session::example.com AFTER Detail already
  // merged — proving the merged values SURVIVE this (the actual fix),
  // where before this fix they were silently wiped back to blank.
  // =====================================================================
  var sessionKeyA = 'ws_live_session::example.com';
  simulateLivewatchRescanWrite(sbA, sessionKeyA, sbA.__storage.local[sessionKeyA]);
  await settle();

  var rawRowsAfterA = sbA.__wsDiscoveryTestHooks.getRawRows();
  var byLinkAfter = {};
  rawRowsAfterA.forEach(function (r) { byLinkAfter[r.c_link] = r; });
  assert(byLinkAfter['https://example.com/p/A']['dt_f_weight'] === '1kg', 'MISSION PROOF (THE BUG ITSELF): Detail values SURVIVE a later, unrelated ws_live_session write (e.g. content/livewatch.js\'s own passive rescan) — got ' + JSON.stringify(byLinkAfter['https://example.com/p/A']));
  assert(byLinkAfter['https://example.com/p/B']['dt_f_material'] === 'Wood' && byLinkAfter['https://example.com/p/C']['dt_f_about'] === 'CCC', 'MISSION PROOF: ALL rows\' Detail values survive, not just row A');
  assert(byLinkAfter['https://example.com/p/A'].c_title === 'Widget A', 'MISSION PROOF: base columns are untouched by this same write');

  // Real export taken AFTER the late write — this is what the user
  // actually opens in Excel in the real report.
  var csvBtnA2 = sbA.getEl('export-csv-btn');
  csvBtnA2.click();
  await settle();
  var csvAfter = sbA.__blobsCreated[sbA.__blobsCreated.length - 1].content;
  assert(csvAfter.indexOf('1kg') !== -1 && csvAfter.indexOf('2kg') !== -1 && csvAfter.indexOf('3kg') !== -1, 'MISSION PROOF: the REAL exported CSV (post-live-write, matching what the user actually downloads) contains every row\'s real Detail values — csv: ' + csvAfter);
  assert(csvAfter.indexOf('Metal') !== -1 && csvAfter.indexOf('Wood') !== -1 && csvAfter.indexOf('Plastic') !== -1, 'MISSION PROOF: every row\'s "material" value survived into the real export');

  // ---- popup reopen/hydration preserves them; completed Detail run does NOT re-fetch during hydration ----
  var sentToBackgroundReopen = [], sentToContentReopen = [];
  var sbReopen = await loadPopup({
    seedLocalStorage: sbA.__storage.local, // exactly what's left in storage after the above — a genuine reopen
    tabUrl: 'https://example.com/some-listing-page',
    runtimeSendMessageImpl: function (m) { sentToBackgroundReopen.push(m); return { ok: true }; },
    sendMessageImpl: function (t, m) { sentToContentReopen.push(m); return { ok: true }; }
  });
  await settle();
  var reopenRows = sbReopen.__wsDiscoveryTestHooks.getRawRows();
  var reopenByLink = {}; reopenRows.forEach(function (r) { reopenByLink[r.c_link] = r; });
  assert(reopenByLink['https://example.com/p/A']['dt_f_weight'] === '1kg', 'MISSION PROOF: popup reopen/hydration preserves the Detail values — got ' + JSON.stringify(reopenByLink['https://example.com/p/A']));
  assert(sentToBackgroundReopen.length === 0, 'MISSION PROOF: a completed Detail run does NOT re-fetch during hydration — zero messages sent to background.js — got ' + JSON.stringify(sentToBackgroundReopen));
  assert(sentToContentReopen.length === 0, 'MISSION PROOF: zero messages sent to any content script during hydration — got ' + JSON.stringify(sentToContentReopen));

  // =====================================================================
  // SCENARIO B — REAL AMAZON SHAPE: 302 main rows + 7 detail fields.
  // Proves the same survival guarantee at the reported real scale.
  // =====================================================================
  var ROW_COUNT = 302;
  var rowsB = [];
  for (var i = 1; i <= ROW_COUNT; i++) {
    rowsB.push({
      col_1788333394475_knjsfa: 'Masa Lambası Model ' + i, // başlık
      col_1788333411610_dnhp65: 'TRY ' + (1000 + i * 10) + '.85', // fiyat
      col_link: 'https://www.amazon.com/dp/PRODUCT-' + i
    });
  }
  var detailFieldsB = [
    { id: 'f_weight', name: 'weight', relativeSelector: '.w', attribute: 'text', multiple: 'first' },
    { id: 'f_dimensions', name: 'dimensions', relativeSelector: '.d', attribute: 'text', multiple: 'first' },
    { id: 'f_materyal', name: 'materyal', relativeSelector: '.m', attribute: 'text', multiple: 'first' },
    { id: 'f_base', name: 'base', relativeSelector: '.b', attribute: 'text', multiple: 'first' },
    { id: 'f_type', name: 'type', relativeSelector: '.t', attribute: 'text', multiple: 'first' },
    { id: 'f_about', name: 'about', relativeSelector: '.a', attribute: 'text', multiple: 'first' },
    { id: 'f_yorum', name: 'yorum sayısı', relativeSelector: '.y', attribute: 'text', multiple: 'first' }
  ];
  var resultsB = {}, fieldsMapB = {};
  rowsB.forEach(function (r, idx) {
    var url = r.col_link;
    resultsB[url] = { status: 'completed', error: null, httpStatus: 200, finalUrl: null, retryStatus: null, failureType: null };
    fieldsMapB[url] = {
      f_weight: (idx + 1) + 'kg', f_dimensions: (10 + idx) + 'x' + (5 + idx) + 'x' + (2 + idx) + ' cm',
      f_materyal: 'Metal', f_base: 'Ahşap', f_type: 'Masaüstü', f_about: 'Description ' + (idx + 1),
      f_yorum: String(idx * 3)
    };
  });
  var seedB = {
    // normalizeHostname() strips the leading "www." — every key below
    // uses the NORMALIZED host ("amazon.com"), exactly as liveSessionKey()/
    // detailActiveConfigKey() do in the real popup.js, even though the
    // real tab URL (below) is the full www.amazon.com address.
    'ws_live_session::amazon.com': {
      sessionId: 's2', hostname: 'www.amazon.com', status: 'active',
      rows: rowsB, seenKeys: {}, lastPassNewRows: 0, lastCheckAt: null,
      discovery: { enabled: true, status: 'no-next-found', pagesVisited: 7, discoveredUnique: ROW_COUNT },
      progress: { rowsCollected: ROW_COUNT }
    },
    'ws_state::www.amazon.com': { containerSelector: '.card', columns: [
      { id: 'col_1788333394475_knjsfa', name: 'başlık', relativeSelector: 'h2', attribute: 'text' },
      { id: 'col_1788333411610_dnhp65', name: 'fiyat', relativeSelector: '.price', attribute: 'text' },
      { id: 'col_link', name: 'Link', relativeSelector: 'a', attribute: 'href' }
    ] },
    'ws_detail_active_config::amazon.com': { sourceColumnId: 'col_link', fields: detailFieldsB },
    'ws_deepscrape_run': {
      runId: 'dse_1788400500000_amz001', status: 'completed', fields: detailFieldsB, results: resultsB,
      counts: { total: ROW_COUNT, completed: ROW_COUNT, pending: 0, fetching: 0, partial: 0, failed: 0, skipped: 0, timeouts: 0 },
      currentUrl: null, currentRecordDiag: null, error: null,
      startedAt: Date.now() - 600000, updatedAt: Date.now(), finishedAt: Date.now()
    },
    'ws_deepscrape_fields': fieldsMapB
  };

  var sbB = await loadPopup({ seedLocalStorage: seedB, tabUrl: 'https://www.amazon.com/s?k=masa+lambasi' });
  await settle();

  var rawRowsB = sbB.__wsDiscoveryTestHooks.getRawRows();
  assert(rawRowsB.length === ROW_COUNT, 'MISSION PROOF (REAL AMAZON SHAPE): all ' + ROW_COUNT + ' main rows present after hydration — got ' + rawRowsB.length);
  var populatedBefore = rawRowsB.filter(function (r) { return r['dt_f_weight'] && r['dt_f_materyal']; }).length;
  assert(populatedBefore === ROW_COUNT, 'MISSION PROOF: all ' + ROW_COUNT + ' rows carry real Detail values BEFORE the late live-session write — got ' + populatedBefore);

  // The exact real-world trigger: a livewatch-style rescan re-persists
  // the session (7-page discovery genuinely finished — 'no-next-found' —
  // so nothing defers to autoScroll/autoPaginate/discovery's own guards).
  var sessionKeyB = 'ws_live_session::amazon.com';
  simulateLivewatchRescanWrite(sbB, sessionKeyB, sbB.__storage.local[sessionKeyB]);
  await settle();

  var rawRowsAfterB = sbB.__wsDiscoveryTestHooks.getRawRows();
  var populatedAfter = rawRowsAfterB.filter(function (r) { return r['dt_f_weight'] && r['dt_f_materyal'] && r['dt_f_yorum']; }).length;
  assert(populatedAfter === ROW_COUNT, 'MISSION PROOF (REAL AMAZON SHAPE, the actual reported bug): all ' + ROW_COUNT + ' rows still carry real Detail values AFTER a later, unrelated ws_live_session write — got ' + populatedAfter + ' / ' + ROW_COUNT + ' (this is exactly the "0 populated rows" report — before the fix, this assertion fails with populatedAfter === 0)');

  var csvBtnB = sbB.getEl('export-csv-btn');
  csvBtnB.click();
  await settle();
  var csvB = sbB.__blobsCreated[sbB.__blobsCreated.length - 1].content;
  ['başlık', 'fiyat', 'weight', 'dimensions', 'materyal', 'base', 'type', 'about', 'yorum sayısı'].forEach(function (h) {
    assert(csvB.indexOf(h) !== -1, 'MISSION PROOF (REAL AMAZON SHAPE export headers): "' + h + '" present — csv head: ' + csvB.slice(0, 300));
  });
  var lineCount = csvB.trim().split('\n').length;
  assert(lineCount === ROW_COUNT + 1, 'MISSION PROOF: exported CSV has exactly ' + (ROW_COUNT + 1) + ' lines (1 header + ' + ROW_COUNT + ' data rows) — got ' + lineCount);
  assert(csvB.indexOf('150kg') !== -1 || csvB.indexOf('1kg') !== -1, 'MISSION PROOF: real per-row weight values are present in the export, not blank');
  assert((csvB.match(/Metal/g) || []).length >= ROW_COUNT, 'MISSION PROOF: EVERY one of the ' + ROW_COUNT + ' rows\' "materyal" value is present in the export — occurrences: ' + ((csvB.match(/Metal/g) || []).length));

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
