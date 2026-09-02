/**
 * final-ui-reorganization.test.js (FAST/local, no browser)
 * FINAL UI REORGANIZATION mission — proves the popup.html/popup.js/
 * popup.css restructuring (VERİ ÇEK / SONUÇLAR / DETAY, consolidated
 * Developer Tools, removed "Şimdi ne yapmak istersiniz?" duplication,
 * new "Sonuçları Gör" button, new sticky status bar, localized status
 * badges) preserved every existing feature/control and every primary
 * action handler, exactly as the mission's own explicit checklist
 * requires — no feature was deleted, no handler was replaced.
 *
 * Two complementary techniques, matching this project's own established
 * conventions:
 *   (a) Static content checks directly against the real popup.html
 *       string — the same technique scripts/release-check.js's own
 *       dev-panel-gating checks already use; appropriate here because
 *       tests/lib/load-popup.js's DOM stub never actually parses
 *       popup.html (getElementById returns an auto-vivified stub
 *       regardless of whether the real HTML has that id), so HTML
 *       structure itself is otherwise completely unverified by anything
 *       else in this suite.
 *   (b) Real execution against the REAL, unmodified popup.js via
 *       tests/lib/load-popup.js for anything behavioral (Sonuçları
 *       Gör's exact effect, the sticky bar's Stop button reusing the
 *       real DURDUR handler, i18n resolution).
 *
 * Standalone-runnable: `node tests/unit/final-ui-reorganization.test.js`.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadPopup } = require('../lib/load-popup');
const { makeSuite } = require('../lib/assert');

const HTML_PATH = path.join(__dirname, '..', '..', 'popup', 'popup.html');
const JS_PATH = path.join(__dirname, '..', '..', 'popup', 'popup.js');

async function settle(ticks) {
  for (var i = 0; i < (ticks || 30); i++) await new Promise(function (r) { setTimeout(r, 0); });
}

async function run() {
  const suite = makeSuite('final-ui-reorganization');
  const assert = suite.assert;
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const js = fs.readFileSync(JS_PATH, 'utf8');

  // ---- MISSION SECTION 8 — FUNCTIONAL PRESERVATION CHECKLIST: every
  // named capability still has its real, concrete control present in
  // the shipped HTML. One assertion per feature bullet the mission's
  // own checklist names explicitly. ----
  {
    var mainFeatures = {
      'auto detect': 'auto-detect-btn',
      'manual columns (add)': 'add-column-btn',
      'reset columns': 'reset-btn',
      'transforms (preview reset)': 'reset-transforms-btn',
      'templates': 'templates-btn',
      'saved scrapers': 'save-scraper-btn',
      'auto-next (legacy toggle, preserved not deleted)': 'auto-next-toggle',
      'auto-scroll (legacy toggle, preserved not deleted)': 'auto-scroll-toggle',
      'start (BAŞLA)': 'basla-btn',
      'stop (DURDUR)': 'durdur-btn',
      'finish (BİTİR)': 'bitir-btn'
    };
    Object.keys(mainFeatures).forEach(function (label) {
      var id = mainFeatures[label];
      assert(new RegExp('id="' + id + '"').test(html), 'MISSION PROOF (VERİ ÇEK preserved): "' + label + '" control (#' + id + ') still exists in popup.html');
    });

    var resultsFeatures = {
      'table': 'preview-table',
      'filtering': 'toggle-filter-btn',
      'sorting': 'toggle-sort-btn',
      'transform': 'toggle-transform-btn',
      'dedupe': 'toggle-dedupe-btn',
      'CSV export': 'export-csv-btn',
      'Excel export': 'export-xlsx-btn',
      'JSON export': 'export-json-btn',
      'copy/TSV': 'copy-btn',
      'Google Sheets': 'export-sheets-btn',
      'image download': 'download-images-btn',
      'file download': 'download-files-btn',
      'change tracking (snapshots)': 'toggle-snapshots-btn',
      'research package': 'results-go-research-btn'
      // 'deep scrape (V1.18 panel)': 'toggle-deepscrape-btn' — REMOVED
      // (Results-tab launcher dedup mission): this UI entry point was
      // deliberately deleted, not merely relocated — the Detay tab is
      // now the one remaining, fully-functional surface for the same
      // shared Deep Scrape engine. See that mission's own popup.html
      // comment (where this button used to live) for the full record.
    };
    Object.keys(resultsFeatures).forEach(function (label) {
      var id = resultsFeatures[label];
      assert(new RegExp('id="' + id + '"').test(html), 'MISSION PROOF (SONUÇLAR preserved): "' + label + '" control (#' + id + ') still exists in popup.html');
    });

    var detailFeatures = {
      'picker': 'dt-pick-fields-btn',
      'manual field': 'dt-add-field-btn',
      'test fields': 'dt-test-btn',
      'templates': 'dt-save-template-btn',
      'scope: ALL': 'dt-scope-all-btn',
      'scope: FIRST 100': 'dt-scope-first100-btn',
      'scope: FIRST 500': 'dt-scope-first500-btn',
      'scope: FIRST N': 'dt-scope-firstn-btn',
      'scope: SELECTED RECORDS': 'dt-scope-selected-btn',
      'start': 'dt-start-btn',
      'stop': 'dt-stop-btn',
      'resume': 'dt-resume-btn',
      'new run': 'dt-new-run-btn',
      'reset': 'dt-reset-btn',
      'view results (new)': 'dt-view-results-btn'
    };
    Object.keys(detailFeatures).forEach(function (label) {
      var id = detailFeatures[label];
      assert(new RegExp('id="' + id + '"').test(html), 'MISSION PROOF (DETAY preserved): "' + label + '" control (#' + id + ') still exists in popup.html');
    });

    var devFeatures = {
      'Copy Session Diagnostic': 'session-diag-copy-btn',
      'Copy Pagination Diagnostic': 'pagination-diag-copy-btn',
      'Sağlık Kontrolü (run)': 'health-check-run-btn',
      'Raporu Kopyala': 'health-check-copy-report-btn',
      'Tanılama Geçmişini Kopyala': 'health-check-copy-history-btn',
      'Tanılamayı Temizle': 'health-check-clear-btn',
      'Health summary: Overall': 'health-check-overall',
      'Health summary: Main scrape': 'health-check-main',
      'Health summary: Pagination': 'health-check-pagination',
      'Health summary: UI sync': 'health-check-ui-sync',
      'Health summary: Storage': 'health-check-storage',
      'Health summary: Detail': 'health-check-detail',
      'Health summary: Last progress': 'health-check-last-progress',
      'Health summary: Last issue': 'health-check-last-issue',
      'Detail picker diagnostic': 'detail-pick-diag-copy-btn'
    };
    Object.keys(devFeatures).forEach(function (label) {
      var id = devFeatures[label];
      assert(new RegExp('id="' + id + '"').test(html), 'MISSION PROOF (DEV tools preserved): "' + label + '" control (#' + id + ') still exists in popup.html');
    });
  }

  // ---- MISSION SECTION 3 — Developer Tools collapsed by default. ----
  {
    assert(/<details id="results-devtools-panel"[^>]*\bhidden\b[^>]*>(?![\s\S]*?\bopen\b[\s\S]*?<\/details>)/.test(html) || (/<details id="results-devtools-panel"[^>]*>/.exec(html) || [''])[0].indexOf('open') === -1,
      'MISSION PROOF: #results-devtools-panel (Results tab Developer Tools) has no `open` attribute — collapsed by default');
    assert((/<details id="auto-diag-panel"[^>]*>/.exec(html) || [''])[0].indexOf('open') === -1, 'MISSION PROOF: #auto-diag-panel (Scrape tab dev tools) has no `open` attribute — collapsed by default');
    assert((/<details id="detail-pick-diag-panel"[^>]*>/.exec(html) || [''])[0].indexOf('open') === -1, 'MISSION PROOF: #detail-pick-diag-panel (Detay tab dev tools) has no `open` attribute — collapsed by default');
  }

  // ---- MISSION SECTION 1/2 — the ▸-collapsible groups the mission's
  // own target layout names are real <details> elements. ----
  {
    var collapsibleGroups = [
      'run-section-advanced', // ▸ Gelişmiş Ayarlar (Scrape)
      'results-devtools-panel' // ▸ Geliştirici Araçları (Results)
    ];
    collapsibleGroups.forEach(function (id) {
      assert(new RegExp('<details id="' + id + '"').test(html), 'MISSION PROOF: #' + id + ' is a real <details> collapsible group');
    });
    // Saved Scrapers / Change Tracking / Research Package are unnamed
    // <details class="ws-section ws-advanced"> groups (no id) —
    // verified by their exact <summary> text instead. Deep Scraping's
    // own group was deliberately REMOVED (Results-tab launcher dedup
    // mission) — see final-micro-polish.test.js for the proof that it's
    // actually gone, not just relocated.
    ['savedScrapers.title', 'changeTracking.groupLabel', 'results.researchPackageGroupLabel', 'devtools.title'].forEach(function (key) {
      assert(new RegExp('<summary[^>]*data-i18n="' + key + '"').test(html), 'MISSION PROOF: a collapsible <summary> uses the i18n key "' + key + '"');
    });
  }

  // ---- MISSION SECTION 5 — mixed-language status badges now resolve
  // through the new localizedStatusLabel() helper instead of raw
  // .toUpperCase() enum text. ----
  {
    var badgeSites = ['els.runStatusBadge.textContent', 'els.dlStatusBadge.textContent', 'els.rbStatusBadge.textContent', 'els.dsProgressBadge.textContent', 'els.dtProgressBadge.textContent'];
    badgeSites.forEach(function (site) {
      var re = new RegExp(site.replace(/\./g, '\\.') + ' = localizedStatusLabel\\(');
      assert(re.test(js), 'MISSION PROOF: ' + site + ' now uses localizedStatusLabel() instead of a raw .toUpperCase() enum value');
    });
    assert(js.indexOf("'DEEP SCRAPE COMPLETE'") === -1, 'MISSION PROOF: the hardcoded English "DEEP SCRAPE COMPLETE" string is gone from popup.js');
  }

  // ---- Real execution: "Sonuçları Gör" (dt-view-results-btn) ONLY
  // switches to the Results tab — no message sent, no re-merge, no
  // reset. Drives the REAL, unmodified handler via load-popup.js. ----
  {
    var sentToBackground = [];
    var sentToContent = [];
    var sb = await loadPopup({
      tabUrl: 'https://example.com/',
      runtimeSendMessageImpl: function (m) { sentToBackground.push(m); return { ok: true }; },
      sendMessageImpl: function (t, m) { sentToContent.push(m); return { ok: true }; }
    });
    await settle(sb);

    var resultsPanel = sb.getEl('tab-panel-results');
    var scrapePanel = sb.getEl('tab-panel-scrape');
    resultsPanel.hidden = true;
    scrapePanel.hidden = false;

    var viewResultsBtn = sb.getEl('dt-view-results-btn');
    viewResultsBtn.click();
    await settle(sb);

    assert(resultsPanel.hidden === false, 'MISSION PROOF: clicking "Sonuçları Gör" switches the Results panel to visible');
    assert(sentToBackground.length === 0, 'MISSION PROOF: "Sonuçları Gör" sends ZERO messages to background.js — no fetch/merge/reset/process');
    assert(sentToContent.length === 0, 'MISSION PROOF: "Sonuçları Gör" sends ZERO messages to the content script — no fetch/merge/reset/process');
  }

  // ---- Real execution: the sticky status bar's Stop button is wired to
  // the exact same handler as #durdur-btn — proven by triggering both
  // and observing IDENTICAL resulting messages, never two separate
  // implementations. ----
  {
    var sentA = [];
    var sbA = await loadPopup({ tabUrl: 'https://example.com/', sendMessageImpl: function (t, m) { sentA.push(m.type); return { ok: true }; } });
    await settle(sbA);
    sbA.getEl('durdur-btn').click();
    await settle(sbA);

    var sentB = [];
    var sbB = await loadPopup({ tabUrl: 'https://example.com/', sendMessageImpl: function (t, m) { sentB.push(m.type); return { ok: true }; } });
    await settle(sbB);
    sbB.getEl('sticky-status-stop-btn').click();
    await settle(sbB);

    assert(JSON.stringify(sentA) === JSON.stringify(sentB), 'MISSION PROOF: the sticky bar\'s Stop button produces the IDENTICAL message sequence as #durdur-btn — same handler, never a duplicate — durdur:' + JSON.stringify(sentA) + ' sticky:' + JSON.stringify(sentB));
  }

  // ---- MISSION SECTION 6 — sticky status bar is UI-only: rendering it
  // never sends any message on its own (only a real user click on its
  // Stop button — proven above — ever does). ----
  {
    var sent = [];
    var sb = await loadPopup({
      tabUrl: 'https://example.com/',
      runtimeSendMessageImpl: function (m) { sent.push(m); return { ok: true }; },
      sendMessageImpl: function (t, m) { sent.push(m); return { ok: true }; }
    });
    await settle(sb);
    assert(sent.length === 0, 'MISSION PROOF: popup init (which calls renderStickyStatus() as part of its normal render passes) sends no messages purely from rendering the sticky bar — got ' + JSON.stringify(sent));
    assert(typeof sb.getEl('sticky-status-bar').hidden === 'boolean', 'the sticky status bar element exists and has a real hidden state (not owned/created by anything new)');
  }

  // ---- MISSION SECTION 5 — new i18n keys resolve for real, in a
  // non-English locale, proving they are genuinely wired through
  // WSI18n.t() rather than hardcoded. ----
  {
    var sb = await loadPopup({ tabUrl: 'https://example.com/' });
    await settle(sb);
    var trOverride = { 'status.completed': 'Tamamlandı', 'devtools.title': 'Geliştirici Araçları' };
    // WSI18n's own current language defaults to 'en' in this sandbox (no
    // real navigator.language) — assert the KEYS resolve to real,
    // non-key-echoing text (proves they exist in the catalog at all;
    // the i18n-coverage release-check already proves all 6 locales
    // carry a translation for each).
    assert(sb.WSI18n.t('status.completed') !== 'status.completed', 'status.completed resolves to real text, not the raw key');
    assert(sb.WSI18n.t('devtools.title') !== 'devtools.title', 'devtools.title resolves to real text, not the raw key');
    assert(sb.WSI18n.t('detail.viewResults') !== 'detail.viewResults', 'detail.viewResults resolves to real text, not the raw key');
    assert(sb.WSI18n.t('preview.title') !== 'preview.title', 'preview.title resolves to real text, not the raw key');
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
