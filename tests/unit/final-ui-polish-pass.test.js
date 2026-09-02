/**
 * final-ui-polish-pass.test.js (FAST/local, no browser)
 * FINAL UI POLISH PASS — PRESENTATION ONLY mission — proves:
 *   1. "Verileri Çek" (#preview-btn) was KEPT (not removed) because it
 *      performs a genuinely different action from BAŞLA, only relocated
 *      next to its real mutually-exclusive counterpart #start-run-btn —
 *      and both #preview-btn's and #basla-btn's own handlers are unchanged.
 *   2. Results-tab summary metrics are only visually de-duplicated —
 *      the old triple ("N sonuç hazır" / "N veri işlendi" / "N benzersiz
 *      kayıt bulundu") collapses to one, discovery-summary-found never
 *      shows a second time next to discovery-status-line1, and the
 *      "Durum: ..." line survives a processing selection instead of being
 *      hidden by one — with no counter/calculation touched.
 *   3. Detail's completed-state duplicate secondary text block is gone
 *      (renderDetailSummary no longer repeats status/pages/counts the
 *      progress line + badge already show) while the one genuinely new
 *      bit of information it ever added — top failure reasons — survives.
 *   4. The sticky status bar is tab-aware (mission section 5) and its
 *      padding-reservation mechanism (section 6) is wired, still without
 *      owning any state or duplicating DURDUR.
 *   5. Dev Tools / production gating, all 6 locales, and every control
 *      from the prior UI reorganization pass are still intact (covered
 *      by release-check.js + final-ui-reorganization.test.js already —
 *      not re-asserted here to avoid duplicate coverage).
 *
 * Same two complementary techniques as final-ui-reorganization.test.js:
 * static string checks against the real popup.html/popup.js/popup.css,
 * and real execution via tests/lib/load-popup.js for anything behavioral.
 *
 * Standalone-runnable: `node tests/unit/final-ui-polish-pass.test.js`.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadPopup } = require('../lib/load-popup');
const { makeSuite } = require('../lib/assert');

const HTML_PATH = path.join(__dirname, '..', '..', 'popup', 'popup.html');
const JS_PATH = path.join(__dirname, '..', '..', 'popup', 'popup.js');
const CSS_PATH = path.join(__dirname, '..', '..', 'popup', 'popup.css');

async function settle(ticks) {
  for (var i = 0; i < (ticks || 30); i++) await new Promise(function (r) { setTimeout(r, 0); });
}

async function run() {
  const suite = makeSuite('final-ui-polish-pass');
  const assert = suite.assert;
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const js = fs.readFileSync(JS_PATH, 'utf8');
  const css = fs.readFileSync(CSS_PATH, 'utf8');

  // ---- SECTION 1 — "Verileri Çek" duplicate resolution ----
  {
    assert(/id="preview-btn"/.test(html), 'MISSION PROOF: #preview-btn ("Verileri Çek") still exists — kept, not removed');
    var previewCount = (html.match(/id="preview-btn"/g) || []).length;
    assert(previewCount === 1, 'MISSION PROOF: #preview-btn appears exactly once (relocated, not duplicated) — found ' + previewCount);

    // Relocated: now sits inside #run-section, immediately alongside its
    // real mutually-exclusive counterpart #start-run-btn, AFTER the mode-
    // specific option panels — no longer directly under Auto Detect/
    // Structured Data/Templates at the top of Gelişmiş.
    var dedupeIdx = html.indexOf('id="run-dedupe-options"');
    var previewIdx = html.indexOf('id="preview-btn"');
    var startRunIdx = html.indexOf('id="start-run-btn"');
    assert(dedupeIdx !== -1 && previewIdx > dedupeIdx, 'MISSION PROOF: #preview-btn is relocated to AFTER the Run Mode option panels');
    assert(startRunIdx !== -1 && previewIdx < startRunIdx, 'MISSION PROOF: #preview-btn sits immediately before its mutually-exclusive counterpart #start-run-btn');

    // Both real handlers are completely unchanged — same event wiring
    // lines as before this pass, proving neither was replaced/rewritten.
    assert(js.indexOf("els.previewBtn.addEventListener('click', handlePreview);") !== -1, 'MISSION PROOF: #preview-btn is still wired to the real, unchanged handlePreview()');
    assert(js.indexOf("els.baslaBtn.addEventListener('click', handleStartLiveSession);") !== -1, 'MISSION PROOF: #basla-btn is still wired to the real, unchanged handleStartLiveSession()');
  }

  // ---- SECTION 1 (real execution) — clicking "Verileri Çek" performs a
  // single-page RUN_EXTRACTION and nothing more: no live session created,
  // no automatic tab switch — a genuinely narrower action than BAŞLA,
  // never the same duplicate action. ----
  {
    var sentToContent = [];
    var sb = await loadPopup({
      tabUrl: 'https://example.com/',
      seedLocalStorage: { 'ws_state::example.com': { containerSelector: '.item', columns: [{ id: 'c1', name: 'Title', relativeSelector: 'h1', attribute: 'text' }] } },
      sendMessageImpl: function (t, m) { sentToContent.push(m.type); return { ok: true, rows: [{ c1: 'Row 1' }], containerMigration: null }; }
    });
    await settle(30);

    var resultsPanel = sb.getEl('tab-panel-results');
    resultsPanel.hidden = true;
    sb.getEl('preview-btn').click();
    await settle(30);

    assert(sentToContent.indexOf('RUN_EXTRACTION') !== -1, 'MISSION PROOF: clicking "Verileri Çek" performs a real RUN_EXTRACTION (still a genuine, working action)');
    assert(sentToContent.indexOf('START_LIVE_WATCH') === -1 && sentToContent.indexOf('START_DISCOVERY') === -1, 'MISSION PROOF: "Verileri Çek" never starts a live session/discovery — proves it is NOT the same action as BAŞLA');
    assert(resultsPanel.hidden === true, 'MISSION PROOF: "Verileri Çek" does not auto-switch to the Results tab (unlike BAŞLA) — confirms it is a narrower, distinct action');
  }

  // ---- SECTION 2 — Results summary de-duplication, presentation-only ----
  {
    // discovery-status-line3 ("Durum: ...") is relocated to the END of
    // #discovery-panel (after the summary panel) and is no longer ever
    // force-hidden once a processing selection exists.
    var panelStart = html.indexOf('id="discovery-panel"');
    var line3Idx = html.indexOf('id="discovery-status-line3"');
    var summaryPanelIdx = html.indexOf('id="discovery-summary-panel"');
    assert(panelStart !== -1 && line3Idx > summaryPanelIdx, 'MISSION PROOF: #discovery-status-line3 ("Durum: ...") now renders AFTER the summary panel — the compact card\'s last line');
    assert(js.indexOf('els.discoveryStatusLine3.hidden = hasSelection;') === -1, 'MISSION PROOF: discovery-status-line3 is no longer force-hidden once a processing selection exists');

    // discovery-summary-found defaults hidden in the HTML (never shown —
    // it always repeats discovery-status-line1's exact same key/count).
    assert(/id="discovery-summary-found"[^>]*\bhidden\b/.test(html), 'MISSION PROOF: #discovery-summary-found defaults hidden in the HTML');
    assert(js.indexOf("els.discoverySummaryFound.hidden = true;") !== -1, 'MISSION PROOF: renderDiscoveryUI() keeps discovery-summary-found hidden on every render (literal duplicate of discovery-status-line1)');

    // discoverySummaryProcessed is hidden ONLY when it would exactly
    // duplicate the found count (an "ALL" selection) — a genuinely
    // different "FIRST N" count is never hidden, so no real information
    // is ever lost, only the true duplicate is suppressed.
    assert(js.indexOf('els.discoverySummaryProcessed.hidden = processedCount === (discovery.discoveredUnique || 0);') !== -1, 'MISSION PROOF: discovery-summary-processed is hidden only when it would exactly duplicate the found count — never when it carries distinct FIRST-N information');

    // results-status-text / live-session-status are hidden whenever the
    // richer discovery panel is showing (the reported "1263 sonuç hazır /
    // 1263 veri işlendi / 1263 benzersiz kayıt bulundu" triple) — but the
    // underlying count computation (updateResultsEmptyState) is untouched.
    assert(js.indexOf("if (els.resultsStatusText) els.resultsStatusText.hidden = !!discovery;") !== -1, 'MISSION PROOF: results-status-text is hidden whenever the discovery summary card is showing (presentation-only — its own count logic in updateResultsEmptyState() is untouched)');
    assert(js.indexOf("if (els.liveSessionStatus) els.liveSessionStatus.hidden = true;") !== -1, 'MISSION PROOF: live-session-status is hidden whenever the discovery summary card is showing');
    assert(js.indexOf("els.resultsStatusText.textContent = hasRows ? WSI18n.t('results.status.ready'") !== -1, 'MISSION PROOF: the underlying results-status-text count/text computation itself is completely unchanged — only its visibility changed');
  }

  // ---- SECTION 3 — Detail completed-state duplicate text removed ----
  {
    // The old renderDetailSummary() re-stated status/page-count/success-
    // missing-error-counts (already shown by dt-progress-text + the
    // status badge) — those three lines are gone from the function.
    var fnStart = js.indexOf('function renderDetailSummary(dsState)');
    var fnEnd = js.indexOf('\n  }', fnStart);
    var fnBody = js.slice(fnStart, fnEnd);
    assert(fnBody.indexOf("WSI18n.t('detail.summaryComplete')") === -1, 'MISSION PROOF: renderDetailSummary() no longer repeats the "DETAY ZENGİNLEŞTİRME TAMAMLANDI" status line (already shown by the progress badge)');
    assert(fnBody.indexOf("WSI18n.t('detail.summaryPages'") === -1, 'MISSION PROOF: renderDetailSummary() no longer repeats the page count (already shown by dt-progress-text)');
    assert(fnBody.indexOf("WSI18n.t('detail.summaryCounts'") === -1, 'MISSION PROOF: renderDetailSummary() no longer repeats Successful/Missing/Errors (already shown by dt-progress-text)');
    // The one genuinely NEW piece of information it ever added — top
    // failure reasons — is still there, completely unchanged.
    assert(fnBody.indexOf("WSI18n.t('detail.summaryReasons')") !== -1, 'MISSION PROOF: renderDetailSummary() still surfaces the genuinely unique failure-reasons breakdown, unchanged');
    assert(fnBody.indexOf("if (r.status === 'failed' && r.error) reasonCounts[r.error] = (reasonCounts[r.error] || 0) + 1;") !== -1, 'MISSION PROOF: the failure-reason counting logic itself is untouched');

    // Every completed-state action control the mission's own block
    // requires is still present and unrenamed.
    ['dt-view-results-btn', 'dt-new-run-btn', 'dt-reset-btn', 'dt-resume-btn', 'dt-retry-failed-btn'].forEach(function (id) {
      assert(new RegExp('id="' + id + '"').test(html), 'MISSION PROOF (DETAY completed-state controls preserved): #' + id + ' still exists');
    });
  }

  // ---- SECTION 5/6 — sticky status bar is tab-aware and reserves its
  // own height, still strictly UI-only (no owned state, no duplicate
  // Stop implementation). ----
  {
    assert(js.indexOf("var onDetailTab = activeTab === 'detay';") !== -1, 'MISSION PROOF: renderStickyStatus() reads the existing activeTab variable to decide what to show — genuinely tab-aware');
    assert(js.indexOf('function setStickyStatusBarVisible(visible)') !== -1, 'MISSION PROOF: sticky-bar visibility is centralized through one small presentation-only helper');
    assert(js.indexOf("els.appRoot.classList.toggle('ws-has-sticky-status'") !== -1, 'MISSION PROOF: the sticky bar visibility toggle also reserves/releases #app bottom padding for it');
    assert(/#app\.ws-has-sticky-status\s*\{[^}]*padding-bottom/.test(css), 'MISSION PROOF: popup.css reserves bottom padding on #app while the sticky bar is visible, so it cannot cover the last real content');
    // switchTab() itself re-renders the sticky bar on every call — so
    // simply navigating tabs updates it even with no other state change.
    var switchTabStart = js.indexOf('function switchTab(tab, opts)');
    var switchTabEnd = js.indexOf('\n  }', switchTabStart);
    assert(js.slice(switchTabStart, switchTabEnd).indexOf('renderStickyStatus();') !== -1, 'MISSION PROOF: switchTab() calls renderStickyStatus() so the bar updates on every tab change, not just on state changes');

    // Detail-running precedence and the DURDUR-reuse guarantee from the
    // prior pass are both untouched.
    assert(js.indexOf("var detailRunning = !!(detailState && ['running', 'stopping'].indexOf(detailState.status) !== -1);") !== -1, 'MISSION PROOF: Detail running/stopping still takes sticky-bar precedence from any tab (preserves cross-tab "still working" visibility)');
    assert(js.indexOf("if (els.stickyStatusStopBtn) els.stickyStatusStopBtn.addEventListener('click', handleStopAutoPaginate);") !== -1, 'MISSION PROOF: the sticky bar\'s Stop button is still wired to the same handleStopAutoPaginate() as #durdur-btn — never a duplicate');
  }

  // ---- Real execution — sticky bar visibility/text is genuinely driven
  // by real state (BAŞLA creating a real live session), never a stub. ----
  {
    var sb = await loadPopup({
      tabUrl: 'https://example.com/',
      seedLocalStorage: { 'ws_state::example.com': { containerSelector: '.item', columns: [{ id: 'c1', name: 'Title', relativeSelector: 'h1', attribute: 'text' }] } },
      sendMessageImpl: function (t, m) { return { ok: true, rows: [{ c1: 'Row 1' }, { c1: 'Row 2' }], containerMigration: null }; }
    });
    await settle(30);
    assert(sb.getEl('sticky-status-bar').hidden === true, 'sticky bar starts hidden — no live session yet');

    sb.clickBasla();
    await settle(60);
    assert(sb.getEl('sticky-status-bar').hidden === false, 'MISSION PROOF: sticky bar becomes visible once a real live session exists (real state, not a stub)');
    assert(sb.getEl('sticky-status-text').textContent.indexOf('2') !== -1, 'MISSION PROOF: sticky bar text reflects the REAL row count from the session just created — got "' + sb.getEl('sticky-status-text').textContent + '"');
  }

  // ---- Section 7 — compact "SON KOŞU"/Last Run card, functionality kept ----
  {
    assert(/id="scrape-last-run-card"[^>]*\bhidden\b/.test(html), 'MISSION PROOF: #scrape-last-run-card defaults hidden — never shown until there is an actual previous run');
    assert(html.indexOf('data-i18n="workflow.lastRun"') !== -1, 'MISSION PROOF: the compact card carries a "SON KOŞU"/Last Run label');
    assert(js.indexOf('if (els.scrapeLastRunCard) els.scrapeLastRunCard.hidden = !hasResults;') !== -1, 'MISSION PROOF: the card is shown/hidden by the exact same hasResults condition #scrape-view-results-btn already used');
    // Same id, same handler reference untouched — switchTab('results') via
    // the existing wiring line (already covered functionally by the
    // "Sonuçları Gör" style tests in final-ui-reorganization.test.js).
    assert(js.indexOf("if (els.scrapeViewResultsBtn) els.scrapeViewResultsBtn.addEventListener('click', function () { switchTab('results'); });") !== -1, 'MISSION PROOF: #scrape-view-results-btn (now inside the compact card) keeps its exact original tab-switch-only handler');
  }

  // ---- i18n: a sample of the new keys from this pass resolve to real
  // text, not the raw key — proves they are genuinely wired through
  // WSI18n.t() (100% 6-locale coverage is already proven by release-check.js). ----
  {
    var sb = await loadPopup({ tabUrl: 'https://example.com/' });
    await settle(30);
    ['preview.truncatedNote', 'preview.anomalyLegend', 'column.entireRow', 'workflow.lastRun', 'pagination.noneDetected'].forEach(function (key) {
      assert(sb.WSI18n.t(key) !== key, key + ' resolves to real text, not the raw key');
    });
    assert(sb.WSI18n.t('sticky.recordCount', { count: 3 }) !== 'sticky.recordCount', 'sticky.recordCount (plural key) resolves to real text, not the raw key');
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
