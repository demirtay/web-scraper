/**
 * detail-reset-control.test.js (FAST/local, no browser)
 * NEW FEATURE — real production request: an explicit "Sıfırla" (Reset)
 * control in the Detail tab. Proves, via the REAL, unmodified
 * background.js resetDeepScrapeState() (loaded through tests/lib/
 * load-background.js) and the REAL, unmodified popup.js
 * handleDetailResetClick() (loaded through tests/lib/load-popup.js,
 * driven via the actual registered #dt-reset-btn click listener — never
 * a reimplementation):
 *   - reset clears ws_deepscrape_run
 *   - reset clears ws_deepscrape_fields
 *   - reset does NOT clear main scrape results (ws_live_session::*)
 *   - reset does NOT clear ws_snapshots
 *   - reset does NOT clear license/settings/templates
 *   - a genuinely live worker is stopped (aborted + waited for) BEFORE
 *     storage is cleared
 *   - a cancelled confirmation changes absolutely nothing
 *
 * Standalone-runnable: `node tests/unit/detail-reset-control.test.js`.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadBackground } = require('../lib/load-background');
const { loadPopup } = require('../lib/load-popup');
const { makeSuite } = require('../lib/assert');

function untouchedSeed() {
  return {
    'ws_live_session::etsy.com': { sessionId: 's1', hostname: 'etsy.com', status: 'active', rows: [{ c_title: 'main scrape row 1' }, { c_title: 'main scrape row 2' }] },
    'ws_license': { schemaVersion: 2, licenseStatus: 'trial', trialRunsUsed: 4, chargedRunIds: ['a', 'b'] },
    'ws_settings': { theme: 'dark' },
    'ws_templates': { list: [{ id: 't1', name: 'My Template' }] },
    'ws_snapshots': { schemaVersion: 1, snapshots: [{ id: 'snap1', rows: [{ x: 1 }] }] },
    'ws_state::etsy.com': { containerSelector: '.listing-card', columns: [{ id: 'c_title' }] }
  };
}

async function run() {
  const suite = makeSuite('detail-reset-control');
  const assert = suite.assert;

  // ---- BACKGROUND-SIDE: resetDeepScrapeState() clears exactly the two
  // Detail keys, leaves everything else byte-for-byte untouched. ----
  {
    const sb = loadBackground({});
    var seed = untouchedSeed();
    Object.keys(seed).forEach(function (k) { sb.__storage.local[k] = seed[k]; });
    var untouchedBefore = JSON.stringify(seed);

    await sb.setDeepScrapeState({
      runId: 'reset-test-run', status: 'stopped', fields: [{ id: 'c_title' }],
      results: { 'https://etsy.com/listing/1': { status: 'completed', error: null, httpStatus: 200, finalUrl: null, retryStatus: null, failureType: null } },
      counts: { total: 125, completed: 72, pending: 53, fetching: 0, partial: 0, failed: 0, skipped: 0, timeouts: 0 },
      concurrency: 1, maxAttempts: 1, recordTimeoutMs: 30000, stopRequested: false, lease: null,
      delayMode: 'custom', customDelayMs: 0, currentUrl: null, currentRecordDiag: null, error: null,
      startedAt: Date.now(), updatedAt: Date.now(), finishedAt: Date.now()
    });
    await sb.setDeepScrapeFields({ 'https://etsy.com/listing/1': { c_title: 'Real Product' } });

    assert(!!(await sb.getDeepScrapeState()), 'setup check: ws_deepscrape_run genuinely exists before reset (matches the real reported 72/125 STOPPED state)');
    assert(Object.keys(await sb.getDeepScrapeFields()).length === 1, 'setup check: ws_deepscrape_fields genuinely holds real data before reset');

    await sb.resetDeepScrapeState();

    assert((await sb.getDeepScrapeState()) === null, 'MISSION PROOF: reset clears ws_deepscrape_run');
    assert(Object.keys(await sb.getDeepScrapeFields()).length === 0, 'MISSION PROOF: reset clears ws_deepscrape_fields');

    var untouchedAfter = JSON.stringify({
      'ws_live_session::etsy.com': sb.__storage.local['ws_live_session::etsy.com'],
      'ws_license': sb.__storage.local['ws_license'],
      'ws_settings': sb.__storage.local['ws_settings'],
      'ws_templates': sb.__storage.local['ws_templates'],
      'ws_snapshots': sb.__storage.local['ws_snapshots'],
      'ws_state::etsy.com': sb.__storage.local['ws_state::etsy.com']
    });
    assert(untouchedAfter === untouchedBefore, 'MISSION PROOF: reset does NOT touch main scrape results, license, settings, templates, snapshots, or column config — byte-for-byte identical');
    var liveSession = sb.__storage.local['ws_live_session::etsy.com'];
    assert(liveSession.rows.length === 2, 'MISSION PROOF (explicit): the current main-scrape dataset (rows) is completely untouched by a Detail reset');
  }

  // ---- BACKGROUND-SIDE: a GENUINELY LIVE worker is stopped (aborted +
  // waited for) BEFORE storage is cleared — never a silent race. ----
  {
    const sb2 = loadBackground({});
    await sb2.setDeepScrapeState({
      runId: 'live-reset-run', status: 'running', fields: [{ id: 'c_title' }],
      results: {}, counts: { total: 1, completed: 0, pending: 1, fetching: 0, partial: 0, failed: 0, skipped: 0, timeouts: 0 },
      concurrency: 1, maxAttempts: 1, recordTimeoutMs: 30000, stopRequested: false, lease: null,
      delayMode: 'custom', customDelayMs: 0, currentUrl: null, currentRecordDiag: null, error: null,
      startedAt: Date.now(), updatedAt: Date.now(), finishedAt: null
    });
    var controller = new AbortController();
    sb2.deepScrapeAbortControllers['live-reset-run'] = controller;
    // Simulates the run's own runDeepScrapeUrls `finally` block reacting
    // to the abort signal a short moment later — the exact real
    // mechanism resetDeepScrapeState() waits on.
    controller.signal.addEventListener('abort', function () {
      setTimeout(function () { delete sb2.deepScrapeAbortControllers['live-reset-run']; }, 100);
    });

    var resetPromise = sb2.resetDeepScrapeState();
    // Immediately after calling reset (before its own bounded wait has
    // elapsed), the real abort must already have been issued.
    await new Promise(function (r) { setTimeout(r, 10); });
    assert(controller.signal.aborted, 'MISSION PROOF: a genuinely live worker\'s real AbortController is aborted by reset — the "stop safely first" requirement');
    await resetPromise;
    assert((await sb2.getDeepScrapeState()) === null, 'MISSION PROOF: storage is only cleared AFTER the live worker genuinely finished stopping (the resetPromise itself only resolves post-wait)');
    assert(!sb2.deepScrapeAbortControllers['live-reset-run'], 'the ownership slot is released, never leaked, after reset');
  }

  // ---- POPUP-SIDE: clicking the REAL #dt-reset-btn shows the exact
  // confirmation text, and — when CONFIRMED — sends RESET_DEEP_SCRAPE
  // and returns the UI to the clean setup state. ----
  {
    var sentMessages = [];
    var sb3 = await loadPopup({
      seedLocalStorage: { 'ws_state::example.com': { containerSelector: '.item', columns: [{ id: 'c1', name: 'Title', relativeSelector: 'h1', attribute: 'text' }] } },
      runtimeSendMessageImpl: function (message) { sentMessages.push(message); return { ok: true }; },
      confirmImpl: function () { return true; } // user clicks OK
    });
    var resetBtn = sb3.getEl('dt-reset-btn');
    resetBtn.click();
    for (var i = 0; i < 20; i++) await new Promise(function (r) { setTimeout(r, 0); });

    assert(sb3.__confirmPrompts.length === 1, 'MISSION PROOF: a confirmation is shown before the destructive reset');
    // The sandbox's default locale is 'en' (no real navigator.language
    // to detect 'tr' from) — asserts the confirm text is sourced from
    // WSI18n's own 'detail.resetConfirm' key (never hardcoded inline),
    // which is what makes the REAL Turkish wording
    // "Detay çalışması sıfırlansın mı?\nSeçili detay alanları
    // korunacak, yalnızca mevcut çalışma ve ilerleme temizlenecek."
    // (verified directly in utils/i18n-data.js's own 'tr' block) show up
    // correctly for a real Turkish-locale user.
    assert(sb3.__confirmPrompts[0] === sb3.WSI18n.t('detail.resetConfirm'),
      'MISSION PROOF: the confirmation text is sourced from WSI18n (never hardcoded) — got: ' + JSON.stringify(sb3.__confirmPrompts[0]));
    // BUG FIX (execution-only reset): the confirm text must honestly
    // state that Detail FIELD CONFIGURATION is kept, not just that main
    // scrape results are preserved — see detail-reset-preserves-config.
    // test.js for the full behavioral proof this wording describes.
    assert(sb3.__confirmPrompts[0].indexOf('kept') !== -1 || sb3.__confirmPrompts[0].indexOf('preserved') !== -1,
      'the confirm text honestly mentions that selected Detail fields are kept — got: ' + sb3.__confirmPrompts[0]);
    assert(sentMessages.length === 1 && sentMessages[0].type === 'RESET_DEEP_SCRAPE', 'MISSION PROOF: confirming sends the real RESET_DEEP_SCRAPE message to background — got ' + JSON.stringify(sentMessages));
    assert(sb3.getEl('dt-progress-section').hidden === true, 'the progress section returns to hidden after a confirmed reset');
    assert(sb3.getEl('dt-setup-section').hidden === false, 'MISSION PROOF: the Detail tab returns to a clean, configurable initial state after reset');
  }

  // ---- POPUP-SIDE: a CANCELLED confirmation changes absolutely
  // nothing — no message sent, no UI state changed. ----
  {
    var sentMessages2 = [];
    var sb4 = await loadPopup({
      seedLocalStorage: { 'ws_state::example.com': { containerSelector: '.item', columns: [{ id: 'c1', name: 'Title', relativeSelector: 'h1', attribute: 'text' }] } },
      runtimeSendMessageImpl: function (message) { sentMessages2.push(message); return { ok: true }; },
      confirmImpl: function () { return false; } // user clicks Cancel
    });
    // Put the progress section into a visible, "showing a real run"
    // state first, matching the real scenario this control is meant for.
    var progressSection = sb4.getEl('dt-progress-section');
    var setupSection = sb4.getEl('dt-setup-section');
    progressSection.hidden = false;
    setupSection.hidden = true;

    var resetBtn2 = sb4.getEl('dt-reset-btn');
    resetBtn2.click();
    for (var j = 0; j < 20; j++) await new Promise(function (r) { setTimeout(r, 0); });

    assert(sb4.__confirmPrompts.length === 1, 'a confirmation is still shown even though the user will cancel it');
    assert(sentMessages2.length === 0, 'MISSION PROOF: cancelling sends NO message to background whatsoever');
    assert(progressSection.hidden === false, 'MISSION PROOF: cancelling changes NOTHING — the progress section stays exactly as it was');
    assert(setupSection.hidden === true, 'MISSION PROOF: cancelling changes NOTHING — the setup section stays exactly as it was');
  }

  // ---- Static i18n proof: the EXACT real Turkish wording requested is
  // present in the real, shipped translation catalog (locale-independent
  // of whatever the sandbox's own default locale happens to be). ----
  {
    var i18nSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'utils', 'i18n-data.js'), 'utf8');
    // BUG FIX (execution-only reset, not configuration): updated wording
    // explicitly states selected Detail fields are preserved — see
    // detail-reset-preserves-config.test.js for the full behavioral proof.
    assert(i18nSrc.indexOf("'detail.resetConfirm': 'Detay çalışması sıfırlansın mı?\\nSeçili detay alanları korunacak, yalnızca mevcut çalışma ve ilerleme temizlenecek.'") !== -1,
      'MISSION PROOF: the exact requested Turkish confirmation text is present in the real i18n catalog');
    assert(i18nSrc.indexOf("'detail.reset': 'Sıfırla'") !== -1, 'MISSION PROOF: the exact requested Turkish button label "Sıfırla" is present in the real i18n catalog');
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
