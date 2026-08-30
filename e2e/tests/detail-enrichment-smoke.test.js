/**
 * detail-enrichment-smoke.test.js
 * DETAIL ENRICHMENT mission — Phase 1 (cheap) real-browser smoke check:
 * opens the REAL popup.html and confirms it still loads cleanly with the
 * new DETAY tab wiring in place — zero console/page errors, the new
 * #detay-tab-btn exists and is disabled (mission: "DETAY becomes
 * available only after a valid result dataset exists"), and its i18n
 * label actually resolved (not a raw, untranslated key). This is
 * intentionally NOT the full production-flow proof (see
 * detail-enrichment-real-flow.test.js for that) — it exists to catch a
 * catastrophic wiring/reference bug (a typo'd function name, a missing
 * element id) cheaply, in isolation, before spending a heavier real-site
 * run on the full flow.
 */
const path = require('path');

const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts', 'latest');

function assert(cond, msg) {
  if (!cond) {
    var err = new Error(msg);
    err.isAssertion = true;
    throw err;
  }
}

async function run(ctx) {
  var context = ctx.context, extensionId = ctx.extensionId;
  var passed = [];
  var details = {};

  var popupPage = await context.newPage();
  var consoleErrors = [];
  popupPage.on('console', function (msg) { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  popupPage.on('pageerror', function (err) { consoleErrors.push('pageerror: ' + err.message); });

  await popupPage.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await popupPage.waitForTimeout(1500); // let popup.js's full init() sequence finish (see discovery-popup-start-real-site.test.js's own comment on why this needs real time)

  details.consoleErrors = consoleErrors;
  assert(consoleErrors.length === 0, 'popup.html produced console/page errors on load — ' + JSON.stringify(consoleErrors));
  passed.push('Real popup loaded with the new DETAY tab wiring in place — zero console/page errors');

  var detayBtn = await popupPage.evaluate(function () {
    var el = document.getElementById('detay-tab-btn');
    return el ? { exists: true, disabled: el.disabled, text: el.textContent.trim(), hasDataI18n: el.getAttribute('data-i18n') === 'tabs.detail' } : { exists: false };
  });
  details.detayBtn = detayBtn;
  assert(detayBtn.exists, '#detay-tab-btn does not exist in the real rendered DOM');
  assert(detayBtn.disabled === true, 'DETAY tab must start disabled (no result dataset yet) — was disabled=' + detayBtn.disabled);
  assert(detayBtn.text === 'Detail', 'DETAY tab i18n label did not resolve to the real English translation — got "' + detayBtn.text + '" (a raw untranslated key would show "tabs.detail" literally)');
  passed.push('#detay-tab-btn exists, is disabled by default, and its i18n label resolved correctly ("' + detayBtn.text + '")');

  var detayPanelHidden = await popupPage.evaluate(function () {
    var el = document.getElementById('tab-panel-detay');
    return el ? el.hidden : null;
  });
  assert(detayPanelHidden === true, 'DETAY tab panel should be hidden by default (scrape tab is the initial active tab)');
  passed.push('DETAY tab panel correctly hidden by default');

  // Confirm the new util modules actually loaded into the popup's own JS context.
  var modulesLoaded = await popupPage.evaluate(function () {
    return { detailScope: typeof window.WSDetailScope, detailTemplates: typeof window.WSDetailTemplates };
  });
  details.modulesLoaded = modulesLoaded;
  assert(modulesLoaded.detailScope === 'object', 'WSDetailScope did not load into the popup context');
  assert(modulesLoaded.detailTemplates === 'object', 'WSDetailTemplates did not load into the popup context');
  passed.push('utils/detailscope.js and utils/detailtemplates.js both loaded correctly into the real popup context');

  await popupPage.screenshot({ path: path.join(ARTIFACT_DIR, 'detail-smoke-popup.png'), fullPage: true, timeout: 60000 });

  return { passed: passed, details: details };
}

module.exports = { run: run, ARTIFACT_DIR: ARTIFACT_DIR };
