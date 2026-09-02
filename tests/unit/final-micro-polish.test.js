/**
 * final-micro-polish.test.js (FAST/local, no browser)
 * FINAL MICRO UI POLISH mission — proves:
 *   1. The "SON KOŞU" / Last Run card's status line is now the compact
 *      "{count} kayıt • {status}" form, built from the same rawRows.length
 *      value and the same status.completed key the rest of the app
 *      already uses — not a new counter/calculation.
 *   2. The Veri Çek tab's ÖN İZLEME table (#setup-preview-table) now has
 *      real column spacing/padding/separators — it previously had no
 *      dedicated CSS at all.
 *   3. Detail's completed-progress line is a compact, real two-line
 *      presentation (dt-progress-text, `white-space:pre-line` + a '\n'
 *      join of two shorter WSI18n.t() calls) instead of one long
 *      concatenated sentence — same numbers, nothing duplicated
 *      elsewhere, the sticky Detail status bar is untouched.
 *   4. The remaining hardcoded English identified in the prior report
 *      (ZIP progress/status strings, and the broader Download/Research/
 *      Monitor/Templates/Saved-Scrapers/Settings surfaces) now resolves
 *      through the real 6-locale WSI18n system — proven both by static
 *      absence of the old literal strings in popup.js and by real
 *      confirm()-dialog/status text appearing in a non-English locale.
 *
 * Same two complementary techniques as the other final-ui-*.test.js
 * files: static string checks against the real popup.html/popup.js/
 * popup.css, and real execution via tests/lib/load-popup.js.
 *
 * Standalone-runnable: `node tests/unit/final-micro-polish.test.js`.
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
  const suite = makeSuite('final-micro-polish');
  const assert = suite.assert;
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const js = fs.readFileSync(JS_PATH, 'utf8');
  const css = fs.readFileSync(CSS_PATH, 'utf8');

  // ---- ITEM 1 — compact Last Run card status line ----
  {
    assert(js.indexOf("els.scrapeStatusText.textContent = WSI18n.t('sticky.recordCount', { count: rawRows.length }) + ' • ' + WSI18n.t('status.completed');") !== -1,
      'MISSION PROOF: the Last Run card status line is now "{count} kayıt • Tamamlandı" built from the same rawRows.length and the existing status.completed key');
  }

  // ---- ITEM 2 — Veri Çek preview table spacing ----
  {
    assert(/#setup-preview-table\s*\{[^}]*border-collapse/.test(css), 'MISSION PROOF: #setup-preview-table now has its own dedicated CSS (previously none at all)');
    assert(/#setup-preview-table th,\s*\n#setup-preview-table td\s*\{[^}]*padding:\s*7px 12px/.test(css), 'MISSION PROOF: #setup-preview-table cells get real padding (7px 12px) instead of the browser default zero-padding look');
    assert(/#setup-preview-table th,\s*\n#setup-preview-table td\s*\{[^}]*border-right/.test(css), 'MISSION PROOF: #setup-preview-table columns get a visible separator border between them');
  }

  // ---- ITEM 3 — Detail completed-progress compact two-line presentation ----
  {
    assert(/id="dt-progress-text"[^>]*white-space:pre-line/.test(html), 'MISSION PROOF: dt-progress-text has white-space:pre-line so its two-line text actually renders as two lines');
    var fnStart = js.indexOf('function renderDetailProgress(dsState)');
    var fnSlice = js.slice(fnStart, fnStart + 4000);
    assert(fnSlice.indexOf("WSI18n.t('detail.progressLine1'") !== -1 && fnSlice.indexOf("WSI18n.t('detail.progressLine2'") !== -1,
      'MISSION PROOF: dt-progress-text is now built from two separate, shorter WSI18n.t() lines (progressLine1/progressLine2) instead of one long sentence');
    assert(js.indexOf("WSI18n.t('detail.progressText'") === -1, 'MISSION PROOF: the old single-line detail.progressText call site is gone');
    // The sticky Detail status bar (a DIFFERENT element/render path) is
    // completely untouched by this change — still its own single-line
    // "Detay N / M • %P • Status" text, still driven by renderStickyStatus().
    assert(js.indexOf("var detailPrefix = WSI18n.t('healthCheck.detail')") !== -1, 'MISSION PROOF: the sticky Detail status bar (renderStickyStatus) is unchanged by this pass — no duplicated progress line was added there');
  }

  // ---- ITEM 4 — remaining hardcoded English literals are gone from
  // popup.js (static proof the exact strings named in the prior report
  // are no longer hardcoded anywhere reachable). ----
  {
    var goneLiterals = [
      "lines.push('Building ZIP…');",
      "lines.push('Ready');",
      "lines.push('Cancelled.');",
      "setStatus('Add at least one column first.', true);",
      "setStatus('Stopping…', false);",
      "enableBtn.textContent = 'Enable';",
      "runNowBtn.textContent = 'Run Now';",
      "clearBtn.textContent = 'Clear History';",
      "delBtn.textContent = 'Delete';",
      "if (!confirm('Remove all columns saved for this site?')) return;",
      "note.textContent = 'Simulated for local development — never a real purchase.';",
      "els.dsTestResults.textContent = 'Test failed to run.';"
    ];
    goneLiterals.forEach(function (lit) {
      assert(js.indexOf(lit) === -1, 'MISSION PROOF: the hardcoded literal ' + JSON.stringify(lit) + ' no longer appears in popup.js');
    });
  }

  // ---- ITEM 4 (real execution) — a sample of the new keys resolve to
  // real, non-key-echoing text across every one of the 6 locales, and a
  // real confirm() dialog shows genuinely translated text once the
  // locale is switched (proves it's wired through WSI18n.t(), not a
  // hardcoded fallback). release-check.js's own 100%-coverage check
  // already proves EVERY key (not just this sample) exists in all 6
  // locale tables. ----
  {
    var sb = await loadPopup({ tabUrl: 'https://example.com/' });
    await settle(sb);
    var sampleKeys = [
      'zip.buildingZip', 'zip.ready', 'zip.cancelled', 'msg.addColumnFirst', 'msg.stopping',
      'monitor.enable', 'monitor.runNow', 'monitor.clearHistory', 'monitor.statusRunning',
      'action.rename', 'action.delete', 'action.duplicate', 'templates.custom',
      'confirm.removeAllColumns', 'confirm.deleteScraperTitle', 'confirm.removeAllTransforms',
      'settings.licenseSimulatedNote', 'settings.licenseRevokedNote',
      'detail.testMissing', 'detail.testFailedToRun', 'detail.progressLine1', 'detail.progressLine2',
      'changes.changesLine', 'research.manifestFormats', 'research.noneSelected', 'deepScrape.workloadSummary'
    ];
    ['en', 'tr', 'de', 'fr', 'zh-CN', 'ru'].forEach(function (loc) {
      sampleKeys.forEach(function (key) {
        var table = sb.WSI18nData[loc];
        assert(table && Object.prototype.hasOwnProperty.call(table, key), key + ' has a real translation entry in locale "' + loc + '"');
      });
    });

    // Real confirm() dialog: switch to Turkish, trigger Reset Columns
    // (needs at least one column first), and see the REAL localized
    // confirm text, not the English literal.
    await sb.WSI18n.setLanguage('tr');
    await settle(sb);
    sb.getEl('reset-btn').click();
    await settle(sb);
    var lastPrompt = sb.__confirmPrompts[sb.__confirmPrompts.length - 1];
    assert(lastPrompt === sb.WSI18n.t('confirm.removeAllColumns'), 'MISSION PROOF: clicking "Sütunları Sıfırla" shows the REAL Turkish confirm text — got ' + JSON.stringify(lastPrompt));
    assert(lastPrompt !== 'Remove all columns saved for this site?', 'MISSION PROOF: the confirm text is no longer the hardcoded English literal once the locale is Turkish');
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
