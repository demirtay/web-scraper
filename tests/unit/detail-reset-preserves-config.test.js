/**
 * detail-reset-preserves-config.test.js (FAST/local, no browser)
 * BUG #2 FIX — real production report: "Sıfırla" appeared to delete the
 * user's configured Detail fields ("Henüz detay alanı yok" wrongly
 * appearing after a reset). ROOT CAUSE: Detail field CONFIGURATION
 * (fields/selectors/extraction modes/source column) previously lived
 * ONLY in popup.js's own in-memory `detailConfig` variable — never
 * persisted anywhere — so it was lost every time the popup closed, a
 * completely ordinary event during a real, long-running Detail
 * Enrichment job. "Sıfırla"/RESET_DEEP_SCRAPE itself never read or wrote
 * detailConfig; by the time a user reopened the popup and clicked it,
 * the configuration was already gone, making Sıfırla look like the
 * culprit.
 *
 * FIX: the configuration is now persisted under its own small, separate
 * key (`ws_detail_active_config::<hostname>`) — never touched by
 * RESET_DEEP_SCRAPE (background.js's resetDeepScrapeState() only ever
 * reads/writes ws_deepscrape_run/ws_deepscrape_fields) — and restored
 * (merged, never overwritten) into detailConfig the first time the
 * setup screen renders in a popup session.
 *
 * Drives the REAL, unmodified popup.js via tests/lib/load-popup.js — the
 * real registered #dt-reset-btn click listener (handleDetailResetClick),
 * never a reimplementation.
 *
 * Standalone-runnable: `node tests/unit/detail-reset-preserves-config.test.js`.
 */
'use strict';
const { loadPopup } = require('../lib/load-popup');
const { makeSuite } = require('../lib/assert');

async function settle(ticks) {
  for (var i = 0; i < (ticks || 40); i++) await new Promise(function (r) { setTimeout(r, 0); });
}

function detailFieldsSeed() {
  return [
    { id: 'f1', name: 'Seller', relativeSelector: '.seller-name', attribute: 'text', multiple: 'first' },
    { id: 'f2', name: 'Description', relativeSelector: '.product-description', attribute: 'html', multiple: 'first' },
    { id: 'f3', name: 'Materials', relativeSelector: '.materials li', attribute: 'text', multiple: 'all' }
  ];
}

function fullSeed() {
  return {
    'ws_detail_active_config::example.com': { sourceColumnId: 'c1', fields: detailFieldsSeed() },
    'ws_detail_templates::example.com': [{ id: 'dtpl_1', name: 'My Saved Template', sourceColumnName: 'Link', fields: detailFieldsSeed(), createdAt: Date.now() }],
    'ws_live_session::example.com': { sessionId: 's1', hostname: 'example.com', status: 'active', rows: [{ c_title: 'main row 1' }, { c_title: 'main row 2' }] },
    'ws_license': { schemaVersion: 2, licenseStatus: 'trial', trialRunsUsed: 3 },
    'ws_settings': { theme: 'dark' },
    'ws_templates': { list: [{ id: 't1', name: 'My Scraper' }] },
    'ws_deepscrape_run': {
      runId: 'run-72-125', status: 'stopped', fields: detailFieldsSeed(),
      results: { 'https://example.com/listing/1': { status: 'completed' } },
      counts: { total: 125, completed: 72, pending: 53, fetching: 0, partial: 0, failed: 0, skipped: 0, timeouts: 0 },
      currentUrl: null, currentRecordDiag: null, updatedAt: Date.now()
    },
    'ws_deepscrape_fields': { 'https://example.com/listing/1': { f1: 'Real Seller Value' } },
    'ws_state::example.com': { containerSelector: '.item', columns: [{ id: 'c1', name: 'Link', relativeSelector: 'a', attribute: 'href' }] }
  };
}

async function run() {
  const suite = makeSuite('detail-reset-preserves-config');
  const assert = suite.assert;

  // ---- Confirmed reset: clears ONLY run/progress state, preserves
  // EVERYTHING configuration-related plus main scrape results. ----
  {
    var sentMessages = [];
    var sb = await loadPopup({
      seedLocalStorage: fullSeed(),
      runtimeSendMessageImpl: function (message) {
        sentMessages.push(message);
        if (message.type === 'RESET_DEEP_SCRAPE') {
          // Simulates the REAL background.js behavior this message
          // triggers (proven independently by detail-reset-control.
          // test.js against the real resetDeepScrapeState()) — remove
          // exactly the two run-state keys, nothing else.
          delete sb.__storage.local['ws_deepscrape_run'];
          delete sb.__storage.local['ws_deepscrape_fields'];
          return { ok: true };
        }
        return { ok: true };
      },
      confirmImpl: function () { return true; },
      tabUrl: 'https://example.com/'
    });

    var configBefore = JSON.stringify(sb.__storage.local['ws_detail_active_config::example.com']);
    var templatesBefore = JSON.stringify(sb.__storage.local['ws_detail_templates::example.com']);
    var mainSessionBefore = JSON.stringify(sb.__storage.local['ws_live_session::example.com']);
    var licenseBefore = JSON.stringify(sb.__storage.local['ws_license']);
    var settingsBefore = JSON.stringify(sb.__storage.local['ws_settings']);

    var resetBtn = sb.getEl('dt-reset-btn');
    resetBtn.click();
    await settle();

    // ---- RESET run/progress state ----
    assert(sentMessages.some(function (m) { return m.type === 'RESET_DEEP_SCRAPE'; }), 'MISSION PROOF: clicking "Sıfırla" sends RESET_DEEP_SCRAPE');
    assert(!sb.__storage.local['ws_deepscrape_run'], 'MISSION PROOF: reset clears ws_deepscrape_run (job/progress state)');
    assert(!sb.__storage.local['ws_deepscrape_fields'], 'MISSION PROOF: reset clears ws_deepscrape_fields (previous run\'s result payloads)');
    assert(sb.getEl('dt-progress-section').hidden === true, 'progress section returns to hidden');
    assert(sb.getEl('dt-setup-section').hidden === false, 'setup section is shown again');

    // ---- PRESERVED configuration (the actual bug fix) ----
    assert(JSON.stringify(sb.__storage.local['ws_detail_active_config::example.com']) === configBefore,
      'MISSION PROOF: reset leaves the persisted Detail field configuration byte-for-byte untouched');
    var configAfter = sb.__storage.local['ws_detail_active_config::example.com'];
    assert(configAfter.fields.length === 3, 'MISSION PROOF: all 3 configured Detail fields survive the reset — got ' + configAfter.fields.length);
    assert(configAfter.fields[0].name === 'Seller' && configAfter.fields[1].name === 'Description' && configAfter.fields[2].name === 'Materials',
      'MISSION PROOF: the exact same configured field NAMES survive — got ' + configAfter.fields.map(function (f) { return f.name; }).join(', '));
    assert(configAfter.fields[0].relativeSelector === '.seller-name' && configAfter.fields[1].relativeSelector === '.product-description',
      'MISSION PROOF: field SELECTORS survive the reset unchanged');
    assert(configAfter.fields[1].attribute === 'html' && configAfter.fields[2].multiple === 'all',
      'MISSION PROOF: extraction MODES/TYPES (attribute/multiple) survive the reset unchanged');
    assert(configAfter.sourceColumnId === 'c1', 'MISSION PROOF: the selected link-SOURCE COLUMN survives the reset unchanged');

    // The popup's own in-memory detailConfig (hydrated from the
    // persisted key by renderDetailSetup()->ensureDetailConfigHydrated()
    // during this very reset) genuinely renders the fields — the literal
    // UI-level symptom the bug report described was "Henüz detay alanı
    // yok" wrongly appearing.
    assert(sb.getEl('dt-fields-empty').hidden === true, 'MISSION PROOF: the "Henüz detay alanı yok" empty state stays HIDDEN — configured fields are genuinely shown, not lost');

    assert(JSON.stringify(sb.__storage.local['ws_detail_templates::example.com']) === templatesBefore,
      'MISSION PROOF: reset leaves saved Detail templates/configuration untouched');
    assert(JSON.stringify(sb.__storage.local['ws_live_session::example.com']) === mainSessionBefore,
      'MISSION PROOF: reset leaves main scrape results untouched');
    assert(JSON.stringify(sb.__storage.local['ws_license']) === licenseBefore, 'reset leaves license data untouched');
    assert(JSON.stringify(sb.__storage.local['ws_settings']) === settingsBefore, 'reset leaves settings untouched');
  }

  // ---- Cancelled reset changes absolutely nothing — not even a
  // RESET_DEEP_SCRAPE message is sent. ----
  {
    var sentMessages2 = [];
    var sb2 = await loadPopup({
      seedLocalStorage: fullSeed(),
      runtimeSendMessageImpl: function (message) { sentMessages2.push(message); return { ok: true }; },
      confirmImpl: function () { return false; },
      tabUrl: 'https://example.com/'
    });
    var configBefore2 = JSON.stringify(sb2.__storage.local['ws_detail_active_config::example.com']);
    var runBefore2 = JSON.stringify(sb2.__storage.local['ws_deepscrape_run']);

    var resetBtn2 = sb2.getEl('dt-reset-btn');
    resetBtn2.click();
    await settle();

    assert(sentMessages2.length === 0, 'MISSION PROOF: a cancelled reset sends NO message whatsoever');
    assert(JSON.stringify(sb2.__storage.local['ws_detail_active_config::example.com']) === configBefore2, 'MISSION PROOF: a cancelled reset changes nothing — Detail configuration untouched');
    assert(JSON.stringify(sb2.__storage.local['ws_deepscrape_run']) === runBefore2, 'MISSION PROOF: a cancelled reset changes nothing — ws_deepscrape_run untouched');
  }

  // ---- Updated confirmation text explicitly states fields are kept
  // (locale-independent — sourced from WSI18n, real Turkish wording
  // verified in utils/i18n-data.js directly below). ----
  {
    var sb3 = await loadPopup({ seedLocalStorage: fullSeed(), confirmImpl: function () { return false; }, tabUrl: 'https://example.com/' });
    var text = sb3.WSI18n.t('detail.resetConfirm');
    assert(text.indexOf('kept') !== -1 || text.indexOf('preserved') !== -1, 'the confirm text states Detail fields are kept — got: ' + text);

    var fs = require('fs'); var path = require('path');
    var i18nSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'utils', 'i18n-data.js'), 'utf8');
    assert(i18nSrc.indexOf("'detail.resetConfirm': 'Detay çalışması sıfırlansın mı?\\nSeçili detay alanları korunacak, yalnızca mevcut çalışma ve ilerleme temizlenecek.'") !== -1,
      'MISSION PROOF: the exact requested Turkish wording (fields preserved, only run/progress cleared) is present in the real i18n catalog');
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
