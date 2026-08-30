/**
 * health-check-report.test.js (FAST/local, no browser)
 * SELF-DIAGNOSTICS / HEALTH CHECK mission — drives the REAL, unmodified
 * popup.js via tests/lib/load-popup.js (a real #basla-btn click producing
 * a real session + real 'main'-scope ws_health_diag events, then the
 * REAL registered #health-check-copy-report-btn/#health-check-clear-btn
 * click listeners — never a reimplementation of handleStartLiveSession/
 * handleCopyHealthReport/handleClearHealthDiagnostics).
 *
 * Covers the mission's own remaining required test proofs:
 *   10. report output ("Raporu Kopyala") contains all required sections
 *   9b. "Tanılamayı Temizle" (Clear Diagnostics), exercised through the
 *       real UI button, never touches the just-created real session/
 *       result/license/settings data — complements healthdiag-buffer.
 *       test.js's own pure-module proof of the same contract.
 *
 * Standalone-runnable: `node tests/unit/health-check-report.test.js`.
 */
'use strict';
const { loadPopup } = require('../lib/load-popup');
const { makeSuite } = require('../lib/assert');

async function settle(ticks) {
  for (var i = 0; i < (ticks || 40); i++) await new Promise(function (r) { setTimeout(r, 0); });
}

var STANDARD_SEED = {
  'ws_state::example.com': { containerSelector: '.item', columns: [{ id: 'c1', name: 'Title', relativeSelector: 'h1', attribute: 'text' }] }
};

function standardSendMessage(rows) {
  return function (tabId, message) {
    if (message.type === 'RUN_EXTRACTION') return { ok: true, rows: rows || [{ c1: 'a' }, { c1: 'b' }, { c1: 'c' }], totalCount: 3, containerMigration: null };
    if (message.type === 'CLASSIFY_AUTO_ROWS') return { ok: false };
    if (message.type === 'START_LIVE_WATCH') return { ok: true };
    if (message.type === 'START_DISCOVERY') return { ok: true };
    return { ok: true };
  };
}

async function run() {
  const suite = makeSuite('health-check-report');
  const assert = suite.assert;

  var sb = await loadPopup({
    seedLocalStorage: STANDARD_SEED,
    sendMessageImpl: standardSendMessage(),
    tabUrl: 'https://example.com/'
  });
  sb.clickBasla();
  await settle();

  // ---- "Raporu Kopyala" produces a compact plain-text report containing
  // every section mission section 10 explicitly requires. ----
  {
    var reportBtn = sb.getEl('health-check-copy-report-btn');
    reportBtn.click();
    await settle();

    assert(sb.__clipboardWrites.length >= 1, 'MISSION PROOF: clicking "Raporu Kopyala" writes a report to the clipboard — got ' + sb.__clipboardWrites.length + ' writes');
    var report = sb.__clipboardWrites[sb.__clipboardWrites.length - 1];

    var required = [
      'Extension version', 'Generated:', 'Hostname:', 'OVERALL:',
      'sessionId:', 'session.status:', 'resultCount:', 'pagesVisited:', 'discovery.status:',
      'lastPaginationAttempt', 'UI <-> engine consistency', 'Storage', 'bytesInUse:',
      'Largest diagnostic-relevant keys', 'Detail Enrichment', 'Detected health issues',
      'Last 20 diagnostic events'
    ];
    required.forEach(function (marker) {
      assert(report.indexOf(marker) !== -1, 'MISSION PROOF: the report contains the required section/marker "' + marker + '" — report was:\n' + report.slice(0, 2000));
    });

    // The real session this BAŞLA click created is genuinely named in
    // the report — proves it reflects REAL gathered state, not a stub.
    assert(report.indexOf('example.com') !== -1, 'the report names the real current hostname');
    assert(/sessionId: livesess_/.test(report), 'the report names the real session id created by this BAŞLA click');

    // At least one real START-FLOW diagnostic event (pushed during the
    // clickBasla() flow above) shows up in the last-20-events section.
    assert(report.indexOf('start-clicked') !== -1 || report.indexOf('session-created') !== -1, 'MISSION PROOF: the report\'s diagnostic-events section includes real START FLOW events from the just-completed BAŞLA run — report tail:\n' + report.slice(-1500));
  }

  // ---- "Tanılama Geçmişini Kopyala" produces the FULL diagnostic
  // history (a superset of the report's own last-20). ----
  {
    var historyBtn = sb.getEl('health-check-copy-history-btn');
    historyBtn.click();
    await settle();
    var history = sb.__clipboardWrites[sb.__clipboardWrites.length - 1];
    assert(history.indexOf('ClickScrape Diagnostic History') !== -1, 'MISSION PROOF: "Tanılama Geçmişini Kopyala" produces its own distinct full-history report');
    assert(/Total events: \d+/.test(history), 'the history report states a total event count');
  }

  // ---- "Tanılamayı Temizle", exercised through the REAL button, clears
  // ONLY diagnostic logs — the just-created real session/license/
  // settings data survive byte-for-byte. ----
  {
    var beforeSession = JSON.stringify(sb.__storage.local['ws_live_session::example.com']);
    var beforeLicense = JSON.stringify(sb.__storage.local['ws_license']);
    var beforeSettings = JSON.stringify(sb.__storage.local['ws_settings']);
    assert(!!beforeSession && beforeSession !== 'undefined', 'setup check: a real session genuinely exists in storage before clearing diagnostics');

    var clearBtn = sb.getEl('health-check-clear-btn');
    clearBtn.click();
    await settle();

    assert(JSON.stringify(sb.__storage.local['ws_live_session::example.com']) === beforeSession, 'MISSION PROOF: "Tanılamayı Temizle" leaves the real main-scrape session byte-for-byte untouched');
    assert(JSON.stringify(sb.__storage.local['ws_license']) === beforeLicense, 'MISSION PROOF: "Tanılamayı Temizle" leaves license data byte-for-byte untouched');
    assert(JSON.stringify(sb.__storage.local['ws_settings']) === beforeSettings, 'MISSION PROOF: "Tanılamayı Temizle" leaves settings data byte-for-byte untouched');

    var diagAfter = sb.__storage.local['ws_health_diag'];
    assert(!diagAfter || (diagAfter.entries || []).length === 0, 'MISSION PROOF: "Tanılamayı Temizle" genuinely empties the diagnostic event buffer');
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
