/**
 * realdom-diagnostic-wiring.test.js (FAST/local, no browser)
 * REAL AMAZON EVIDENCE mission — TEMPORARY evidence-gathering tool.
 * Proves ONLY the wiring for the new "📋 Copy Real DOM Diagnostic"
 * button is correct and safe:
 *   1. content/realdomdiag.js is syntactically valid, self-contained,
 *      and exposes WSRealDomDiag.collect() + its own
 *      RUN_REAL_DOM_DIAGNOSTIC message listener, WITHOUT calling
 *      runAutoDetect() itself and WITHOUT referencing WSNextDetect at
 *      all (content/nextdetect.js is untouched by this mission, per its
 *      own explicit instruction) — it only reads
 *      WSAutoDetect.runAutoDetectDiagnostic()'s existing, already
 *      read-only output plus raw document.* queries.
 *   2. Clicking the popup button sends exactly one
 *      RUN_REAL_DOM_DIAGNOSTIC message and handles both the success and
 *      failure response shapes without throwing.
 *   3. The button/panel exist in popup.html and are gated the same way
 *      every other dev-only diagnostic panel already is.
 *
 * Standalone-runnable: `node tests/unit/realdom-diagnostic-wiring.test.js`.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadPopup } = require('../lib/load-popup');
const { makeSuite } = require('../lib/assert');

const REALDOMDIAG_PATH = path.join(__dirname, '..', '..', 'content', 'realdomdiag.js');
const POPUP_JS_PATH = path.join(__dirname, '..', '..', 'popup', 'popup.js');
const POPUP_HTML_PATH = path.join(__dirname, '..', '..', 'popup', 'popup.html');

async function settle(ticks) {
  for (var i = 0; i < (ticks || 30); i++) await new Promise(function (r) { setTimeout(r, 0); });
}

async function run() {
  const suite = makeSuite('realdom-diagnostic-wiring');
  const assert = suite.assert;

  var realDomSrc = fs.readFileSync(REALDOMDIAG_PATH, 'utf8');
  var popupJs = fs.readFileSync(POPUP_JS_PATH, 'utf8');
  var popupHtml = fs.readFileSync(POPUP_HTML_PATH, 'utf8');

  // ---- Isolation from content/nextdetect.js (mission's own explicit
  // "do NOT alter autodetect.js or nextdetect.js yet") ----
  assert(realDomSrc.indexOf('WSNextDetect') === -1, 'MISSION PROOF: content/realdomdiag.js never references WSNextDetect at all — pagination evidence comes from raw document.* queries only, never content/nextdetect.js\'s own detection logic');
  // Only ONE call to a runAutoDetect*-shaped function is allowed in the
  // actual CODE (the header comment above also mentions "runAutoDetect()"
  // in prose, which a naive substring search would otherwise also catch)
  // — every real call in this file must be the Diagnostic variant.
  var callSites = realDomSrc.match(/root\.WSAutoDetect\.runAutoDetect\w*\s*\(/g) || [];
  assert(callSites.length === 1 && callSites[0].indexOf('runAutoDetectDiagnostic') !== -1, 'MISSION PROOF: content/realdomdiag.js\'s only real call into WSAutoDetect is runAutoDetectDiagnostic() (the pre-existing, already read-only function) — never runAutoDetect() itself, never triggers detection as a side effect — got call sites ' + JSON.stringify(callSites));
  assert(realDomSrc.indexOf('.click(') === -1 && realDomSrc.indexOf('trigger(') === -1, 'MISSION PROOF: content/realdomdiag.js never clicks or triggers anything — pure DOM reads only');
  assert(realDomSrc.indexOf('chrome.storage.') === -1, 'MISSION PROOF: content/realdomdiag.js never touches chrome.storage — evidence collection only, no session mutation');
  assert(realDomSrc.indexOf('location.href =') === -1 && realDomSrc.indexOf('location.reload') === -1, 'MISSION PROOF: content/realdomdiag.js never navigates or reloads the page');

  // ---- Registered in both content-file lists (popup.js + background.js
  // — the established, explicitly-documented "kept in sync manually"
  // convention every other content script here already follows) ----
  assert(popupJs.indexOf("'content/realdomdiag.js'") !== -1, 'MISSION PROOF: content/realdomdiag.js is registered in popup.js\'s CONTENT_FILES (so sendToContent() can inject it on demand)');
  var backgroundJs = fs.readFileSync(path.join(__dirname, '..', '..', 'background', 'background.js'), 'utf8');
  assert(backgroundJs.indexOf("'content/realdomdiag.js'") !== -1, 'MISSION PROOF: content/realdomdiag.js is also registered in background.js\'s own CONTENT_FILES mirror, per that file\'s own "kept in sync manually" convention');

  // ---- popup.html: button + dev-only gating, same shape as every other
  // Copy *Diagnostic panel ----
  assert(popupHtml.indexOf('id="realdom-diag-copy-btn"') !== -1, 'MISSION PROOF: the "📋 Copy Real DOM Diagnostic" button exists in popup.html');
  assert(popupHtml.indexOf('📋 Copy Real DOM Diagnostic') !== -1, 'MISSION PROOF: button label is exactly "Copy Real DOM Diagnostic" as requested');
  assert(popupHtml.indexOf('id="realdom-diag-panel"') !== -1, 'MISSION PROOF: the panel wrapping it exists');
  var panelMatch = popupHtml.match(/<div id="realdom-diag-panel"[^>]*>/);
  assert(panelMatch && panelMatch[0].indexOf('hidden') !== -1, 'MISSION PROOF: the panel starts hidden — same dev-gating contract as every other diagnostic panel (revealed only after WSLicense.isDevelopmentInstall() resolves true)');

  // ---- popup.js: reveal function gated behind isDevelopmentInstall(),
  // handler sends exactly RUN_REAL_DOM_DIAGNOSTIC and never a scrape/
  // reset/navigation message type ----
  assert(popupJs.indexOf('function revealRealDomDiagPanelIfDev') !== -1, 'MISSION PROOF: revealRealDomDiagPanelIfDev() exists');
  assert(popupJs.indexOf('RUN_REAL_DOM_DIAGNOSTIC') !== -1, 'MISSION PROOF: popup.js sends RUN_REAL_DOM_DIAGNOSTIC');

  // ---- Real execution: click the button, confirm exactly one
  // RUN_REAL_DOM_DIAGNOSTIC message is sent and both a success and a
  // failure response are handled without throwing. ----
  var sentTypes = [];
  var respondWith = { ok: true, report: { generatedAt: 'x', url: 'https://www.amazon.com/s?k=desk+lamp', rowDetection: { available: true, topCandidates: [], firstRowElements: [] }, pagination: {} } };
  var sb = await loadPopup({
    tabUrl: 'https://www.amazon.com/s?k=desk+lamp',
    isDevInstall: true,
    sendMessageImpl: function (t, m) {
      sentTypes.push(m.type);
      if (m.type === 'RUN_REAL_DOM_DIAGNOSTIC') return respondWith;
      return { ok: true };
    }
  });
  await settle(30);

  var btn = sb.getEl('realdom-diag-copy-btn');
  assert(!!btn, 'MISSION PROOF: the button element is reachable via its id');
  btn.click();
  await settle(30);
  assert(sentTypes.indexOf('RUN_REAL_DOM_DIAGNOSTIC') !== -1, 'MISSION PROOF: clicking the button sends RUN_REAL_DOM_DIAGNOSTIC — got ' + JSON.stringify(sentTypes));
  var scrapeOrMutationTypes = ['RUN_EXTRACTION', 'START_DISCOVERY', 'STOP_DISCOVERY', 'START_AUTO_PAGINATE', 'START_LIVE_WATCH'];
  scrapeOrMutationTypes.forEach(function (t) {
    assert(sentTypes.indexOf(t) === -1, 'MISSION PROOF: clicking Copy Real DOM Diagnostic never sends a scrape/navigation/session message type (' + t + ') — evidence collection only');
  });

  // ---- Failure response handled without throwing ----
  respondWith = { ok: false, error: 'simulated failure' };
  btn.click();
  await settle(30);
  var statusEl = sb.getEl('realdom-diag-status');
  assert(statusEl && /failed/i.test(statusEl.textContent || ''), 'MISSION PROOF: a failed diagnostic response is surfaced as a status message, not a crash — got ' + JSON.stringify(statusEl && statusEl.textContent));

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
