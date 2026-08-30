/**
 * basla-second-run-diagnosis.test.js
 * LIVE-RUNTIME DIAGNOSIS ONLY — BUG #1 re-investigation (the previous
 * content.js RUN_EXTRACTION .catch() fix did NOT resolve the real
 * report: BAŞLA still hangs at "Veri işleniyor…" with the OLD results
 * still visible, on a SECOND real BAŞLA click after a first run already
 * completed and produced results).
 *
 * This test drives the REAL production path TWICE: first a completely
 * normal BAŞLA click (producing real results, matching the user's
 * "182 sonuç çekildi" already-visible state), then CLOSES and REOPENS
 * the popup (a real toolbar popup always reloads fresh on every open —
 * this is the single most faithful way to reproduce "existing results
 * already shown, user clicks BAŞLA again" without any artificial
 * shortcut), then clicks the REAL #basla-btn a SECOND time and captures
 * EVERY console.log from the popup page — including the [WS-DIAG]
 * STAGE markers temporarily added to popup.js's handleStartLiveSession()
 * — so the exact last-reached stage can be read directly from real
 * Chrome output, not inferred.
 *
 * Never asserts a specific outcome — this file's only job is to CAPTURE
 * and report the real console trace for human/AI analysis.
 */
const path = require('path');

const START_URL = 'https://books.toscrape.com/';
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts', 'latest');

var CONTAINER_SELECTOR = 'article.product_pod';
var COLUMNS = [
  { id: 'c_title', name: 'Title', relativeSelector: 'h3 a', attribute: 'text' },
  { id: 'c_link', name: 'Link', relativeSelector: 'h3 a', attribute: 'href' },
  { id: 'c_price', name: 'Price', relativeSelector: '.price_color', attribute: 'text' }
];

function withTimeout(promise, ms, label) {
  var timer;
  var timeout = new Promise(function (_, reject) {
    timer = setTimeout(function () { reject(new Error('TIMEOUT after ' + ms + 'ms waiting for: ' + label)); }, ms);
  });
  return Promise.race([promise, timeout]).finally(function () { clearTimeout(timer); });
}

async function run(ctx) {
  var context = ctx.context, extensionId = ctx.extensionId, sw = ctx.serviceWorker, log = ctx.log;
  var passed = [];
  var details = {};

  function swEval(fn, arg) { return withTimeout(sw.evaluate(fn, arg), 20000, 'service-worker evaluate'); }

  log.step('Opening real public site: ' + START_URL);
  var sitePage = await context.newPage();
  await sitePage.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sitePage.waitForLoadState('load', { timeout: 30000 }).catch(function () {});
  passed.push('Real site opened');

  log.step('Granting the real optional host permission');
  var permPage = await context.newPage();
  await permPage.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await permPage.waitForTimeout(400);
  var origin = new URL(START_URL).origin + '/*';
  var permResult = await permPage.evaluate(function (o) {
    return chrome.permissions.request({ origins: [o] }).then(function (granted) { return { granted: granted }; })
      .catch(function (e) { return { error: String(e && e.message || e) }; });
  }, origin);
  await permPage.close();
  details.permResult = permResult;
  passed.push('Real host permission granted: ' + JSON.stringify(permResult));

  var siteTab = await swEval(function () {
    return chrome.tabs.query({}).then(function (tabs) {
      var t = tabs.find(function (t) { return typeof t.url === 'string' && t.url.indexOf('books.toscrape.com') !== -1; });
      return t ? { id: t.id, url: t.url } : null;
    });
  });
  details.siteTab = siteTab;

  var seedStateResult = await swEval(function (args) {
    return new Promise(function (resolve) {
      var key = 'ws_state::' + args.hostname;
      var data = {}; data[key] = { containerSelector: args.containerSelector, columns: args.columns };
      chrome.storage.local.set(data, function () { resolve({ ok: !chrome.runtime.lastError }); });
    });
  }, { hostname: 'books.toscrape.com', containerSelector: CONTAINER_SELECTOR, columns: COLUMNS });
  details.seedStateResult = seedStateResult;

  function installTabShim(page) {
    return page.addInitScript(function (args) {
      var tabId = args.tabId, tabUrl = args.tabUrl;
      var origQuery = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = function (queryInfo, callback) {
        var isActiveCurrentWindowQuery = queryInfo && queryInfo.active === true && queryInfo.currentWindow === true && Object.keys(queryInfo).length === 2;
        if (isActiveCurrentWindowQuery) {
          var fakeTab = { id: tabId, url: tabUrl, active: true, windowId: 1, index: 0, title: 'books.toscrape.com' };
          if (typeof callback === 'function') { setTimeout(function () { callback([fakeTab]); }, 0); return undefined; }
          return Promise.resolve([fakeTab]);
        }
        return origQuery(queryInfo, callback);
      };
    }, { tabId: siteTab.id, tabUrl: siteTab.url });
  }

  var allConsole = [];
  function attachConsoleCapture(page, label) {
    page.on('console', function (msg) {
      var text = msg.text();
      allConsole.push('[' + label + '] ' + text);
    });
    page.on('pageerror', function (err) {
      allConsole.push('[' + label + '] PAGEERROR: ' + err.message);
    });
  }

  // ---- RUN 1: completely normal first BAŞLA click, exactly like every
  // other real-site test in this suite — produces real results. ----
  log.step('RUN 1: opening popup, clicking REAL #basla-btn (first time)');
  var popupPage1 = await context.newPage();
  attachConsoleCapture(popupPage1, 'RUN1');
  await installTabShim(popupPage1);
  await popupPage1.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await popupPage1.waitForTimeout(1500);
  await popupPage1.locator('#basla-btn').waitFor({ state: 'visible', timeout: 10000 });
  await popupPage1.locator('#basla-btn').click();

  // Poll REAL persisted storage (not the DOM — this is the ground truth)
  // until RUN 1 genuinely completes, up to 60s (this environment has
  // shown severe real resource pressure this session — give it a
  // generous, honest budget rather than assuming a fixed short delay).
  var sessionAfterRun1 = null;
  var run1WaitStart = Date.now();
  var run1Samples = [];
  while (Date.now() - run1WaitStart < 60000) {
    var s1 = await swEval(function (hostKey) {
      return new Promise(function (resolve) { chrome.storage.local.get([hostKey], function (r) { resolve(r[hostKey] || null); }); });
    }, 'ws_live_session::books.toscrape.com');
    run1Samples.push({ t: Date.now() - run1WaitStart, rowCount: s1 ? s1.rows.length : null });
    if (s1 && s1.rows && s1.rows.length > 0) { sessionAfterRun1 = s1; break; }
    await new Promise(function (r) { setTimeout(r, 1000); });
  }
  details.run1WaitSamples = run1Samples;
  details.sessionAfterRun1 = sessionAfterRun1 ? { sessionId: sessionAfterRun1.sessionId, rowCount: sessionAfterRun1.rows.length, status: sessionAfterRun1.status } : null;
  log.info('RUN 1 real persisted session after up to 60s wait: ' + JSON.stringify(details.sessionAfterRun1));

  var run1RowCount = await popupPage1.evaluate(function () {
    var el = document.getElementById('row-count');
    return el ? el.textContent : null;
  });
  details.run1RowCount = run1RowCount;
  await popupPage1.screenshot({ path: path.join(ARTIFACT_DIR, 'basla-diag-run1-after.png'), fullPage: true, timeout: 60000 }).catch(function () {});
  passed.push('RUN 1 real persisted session: ' + JSON.stringify(details.sessionAfterRun1) + ' — DOM row count shown: ' + run1RowCount);

  await popupPage1.close();

  // ---- RUN 2: CLOSE and REOPEN the popup (a real toolbar popup always
  // reloads fresh — this is the faithful reproduction of "existing
  // results already showing, user clicks BAŞLA again"), then click BAŞLA
  // a SECOND time. This is the exact scenario under diagnosis. ----
  log.step('RUN 2: reopening popup fresh (old results should already be visible), clicking REAL #basla-btn (second time)');
  var popupPage2 = await context.newPage();
  attachConsoleCapture(popupPage2, 'RUN2');
  await installTabShim(popupPage2);
  await popupPage2.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await popupPage2.waitForTimeout(1800);

  var rowCountBeforeSecondClick = await popupPage2.evaluate(function () {
    var el = document.getElementById('row-count');
    return el ? el.textContent : null;
  });
  details.rowCountBeforeSecondClick = rowCountBeforeSecondClick;
  await popupPage2.screenshot({ path: path.join(ARTIFACT_DIR, 'basla-diag-run2-before-click.png'), fullPage: true, timeout: 60000 }).catch(function () {});
  log.info('Row count visible BEFORE the second BAŞLA click: ' + rowCountBeforeSecondClick);

  var statusBeforeClick = await popupPage2.evaluate(function () {
    var el = document.getElementById('status-line') || document.querySelector('[class*="status"]');
    return el ? el.textContent : null;
  });
  details.statusBeforeClick = statusBeforeClick;

  // restoreLiveSessionIfAny() (popup.js init()) auto-switches to the
  // Results tab whenever an existing session with rows is found — a real
  // user with existing results (matching "182 sonuç çekildi") who wants
  // to start a NEW scrape clicks the real "Scrape" tab bar button first
  // (#results-go-scrape-btn is the EMPTY-state prompt, only shown with
  // zero results — not applicable here since 20 rows already exist).
  // #basla-btn lives on the Scrape tab panel.
  var scrapeTabBtn = popupPage2.locator('button.ws-tab-btn[data-tab="scrape"]');
  await scrapeTabBtn.click();
  await popupPage2.waitForTimeout(300);
  details.scrapeTabNavigated = true;

  await popupPage2.locator('#basla-btn').waitFor({ state: 'visible', timeout: 10000 });
  var clickAt = Date.now();
  var oldSessionId = sessionAfterRun1 ? sessionAfterRun1.sessionId : null;
  await popupPage2.locator('#basla-btn').click();

  // Poll for up to 60s (matching RUN 1's own honest budget), capturing
  // BOTH the real DOM text AND real persisted storage every second —
  // proves whether/when a genuinely NEW session (different sessionId)
  // ever replaces the old one, not just whether the DOM text changes.
  var samples = [];
  var newSessionSeenAt = null;
  for (var i = 0; i < 60; i++) {
    await popupPage2.waitForTimeout(1000);
    var sample = await popupPage2.evaluate(function () {
      var rowsEl = document.getElementById('row-count');
      var statusEl = document.getElementById('status-line') || document.querySelector('[class*="status"]');
      return { rowCount: rowsEl ? rowsEl.textContent : null, status: statusEl ? statusEl.textContent : null };
    }).catch(function () { return { error: true }; });
    var storageSample = await swEval(function (hostKey) {
      return new Promise(function (resolve) { chrome.storage.local.get([hostKey], function (r) { resolve(r[hostKey] || null); }); });
    }, 'ws_live_session::books.toscrape.com');
    var t = Date.now() - clickAt;
    samples.push({ t: t, dom: sample, storageSessionId: storageSample ? storageSample.sessionId : null, storageRowCount: storageSample ? storageSample.rows.length : null });
    if (storageSample && storageSample.sessionId !== oldSessionId && newSessionSeenAt === null) newSessionSeenAt = t;
  }
  details.pollSamplesAfterSecondClick = samples;
  details.newSessionFirstSeenAtMs = newSessionSeenAt;
  log.info('New session (different sessionId than RUN1) first observed in real storage at: ' + newSessionSeenAt + 'ms after the second click (null = never, within 60s)');

  await popupPage2.screenshot({ path: path.join(ARTIFACT_DIR, 'basla-diag-run2-after-60s.png'), fullPage: true, timeout: 60000 }).catch(function () {});

  var sessionAfterRun2 = await swEval(function (hostKey) {
    return new Promise(function (resolve) { chrome.storage.local.get([hostKey], function (r) { resolve(r[hostKey] || null); }); });
  }, 'ws_live_session::books.toscrape.com');
  details.sessionAfterRun2 = sessionAfterRun2 ? { sessionId: sessionAfterRun2.sessionId, rowCount: sessionAfterRun2.rows.length, status: sessionAfterRun2.status, updatedAt: sessionAfterRun2.updatedAt } : null;

  // ---- THE ACTUAL DIAGNOSIS DATA: every [WS-DIAG] STAGE line captured
  // from the real popup page during the second click, in order. ----
  var diagLines = allConsole.filter(function (l) { return l.indexOf('[WS-DIAG]') !== -1; });
  details.diagLinesRun1 = diagLines.filter(function (l) { return l.indexOf('[RUN1]') === 0; });
  details.diagLinesRun2 = diagLines.filter(function (l) { return l.indexOf('[RUN2]') === 0; });
  details.allConsoleRun2 = allConsole.filter(function (l) { return l.indexOf('[RUN2]') === 0; });

  log.info('=== RUN 1 [WS-DIAG] stages reached ===');
  details.diagLinesRun1.forEach(function (l) { log.info(l); });
  log.info('=== RUN 2 [WS-DIAG] stages reached (THE ACTUAL DIAGNOSIS) ===');
  details.diagLinesRun2.forEach(function (l) { log.info(l); });
  log.info('=== RUN 2 full console (non-DIAG too) ===');
  details.allConsoleRun2.forEach(function (l) { log.info(l); });

  passed.push('Captured ' + details.diagLinesRun1.length + ' RUN1 stage markers and ' + details.diagLinesRun2.length + ' RUN2 stage markers');

  return { passed: passed, details: details };
}

module.exports = { run: run, START_URL: START_URL, ARTIFACT_DIR: ARTIFACT_DIR };
