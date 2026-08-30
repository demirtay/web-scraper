/**
 * picker-interception-real-flow.test.js
 * BUG FIX MISSION — DETAIL VISUAL ELEMENT PICKER.
 *
 * Real, manually-reported bug: on a real Etsy listing page, "Örnek
 * Sayfada Alan Seç" (Pick a Field on an Example Page) did not actually
 * intercept the click — the website handled it normally (a link
 * navigated), and ClickScrape never captured anything. Root cause: the
 * picker relied on a document-level capture-phase listener registered
 * AFTER the page's own JS had already registered its own listeners,
 * which cannot structurally guarantee it runs first. Fixed with a
 * full-viewport transparent "glass pane" overlay (content/content.js's
 * overlayEl) that owns every pointer event while picking is active, so
 * the real page never receives the event at all, regardless of what
 * listeners it has or when they were registered.
 *
 * This test drives the REAL, unmodified production picker (via the
 * real #add-column-btn click — the SAME shared picker mechanism the
 * DETAY tab's "Pick a Field" button also drives, see content/content.js's
 * own header comment: "Applies identically to every pick purpose") on a
 * REAL public page, against an element fixture INJECTED into that real
 * page (a real DOM node, real rendering/layout, real event dispatch —
 * only its exact shape is deliberately controlled to match the bug
 * report's own nested <a><span> example precisely), then separately
 * confirms the exact reported entry point (DETAY's "Pick a Field on an
 * Example Page" / purpose:'live-detail-field') is fixed too.
 *
 * Checklist (mission's own explicit list):
 *   1. Activate Detail picker.
 *   2. Hover element -> highlight appears.
 *   3. Click normal text -> captured.
 *   4. Activate picker again.
 *   5. Click an <a> or nested element inside an <a>.
 *   6. Confirm navigation DOES NOT occur.
 *   7. Confirm selected value is returned to the UI.
 *   8. Confirm example value is visible.
 *   9. Confirm normal website behavior returns after picker exits.
 * Plus: a real <button>, and confirmation via the exact reported DETAY
 * entry point.
 */
const path = require('path');

const START_URL = 'https://books.toscrape.com/';
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts', 'latest');

function withTimeout(promise, ms, label) {
  var timer;
  var timeout = new Promise(function (_, reject) {
    timer = setTimeout(function () { reject(new Error('TIMEOUT after ' + ms + 'ms waiting for: ' + label)); }, ms);
  });
  return Promise.race([promise, timeout]).finally(function () { clearTimeout(timer); });
}

function assert(cond, msg) {
  if (!cond) {
    var err = new Error(msg);
    err.isAssertion = true;
    throw err;
  }
}

// Injected once into the real page — deliberately matches the bug
// report's own nested <a><span> example verbatim, plus a plain-text
// element and a real <button>, covering the mission's full test matrix
// (plain text, span, anchor/link, button, nested text) in one fixture.
var FIXTURE_HTML =
  '<div id="ws-test-fixture" style="position:fixed;top:120px;left:120px;background:#fff;z-index:999999;padding:16px;border:3px solid red;font:14px sans-serif;">' +
  '  <p id="ws-test-text">Plain paragraph text for picking.</p>' +
  '  <a id="ws-test-anchor" href="#test-anchor-should-not-navigate-during-pick">' +
  '    <span id="ws-test-span">CountryCottageImages</span>' +
  '  </a>' +
  '  <button id="ws-test-button" type="button">Click Me</button>' +
  '</div>';

async function run(ctx) {
  var context = ctx.context, extensionId = ctx.extensionId, sw = ctx.serviceWorker, log = ctx.log;
  var passed = [];
  var details = {};

  function swEval(fn, arg) {
    return withTimeout(sw.evaluate(fn, arg), 20000, 'service-worker evaluate');
  }

  log.step('Opening real public page and injecting the test fixture (real DOM, real rendering)');
  var sitePage = await context.newPage();
  var consoleErrors = [];
  sitePage.on('console', function (msg) { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  sitePage.on('pageerror', function (err) { consoleErrors.push('pageerror: ' + err.message); });
  await sitePage.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sitePage.waitForLoadState('load', { timeout: 30000 }).catch(function () {});

  await sitePage.evaluate(function (html) {
    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstElementChild);
    window.__wsTestAnchorClicked = 0;
    window.__wsTestButtonClicked = 0;
    document.getElementById('ws-test-anchor').addEventListener('click', function () { window.__wsTestAnchorClicked++; });
    document.getElementById('ws-test-button').addEventListener('click', function () { window.__wsTestButtonClicked++; });
  }, FIXTURE_HTML);
  passed.push('Real fixture injected into the real page: plain text, a nested <a><span> (matches the bug report\'s own example verbatim), and a real <button>');

  log.step('Granting the real optional host permission');
  var permPage = await context.newPage();
  await permPage.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await permPage.waitForTimeout(400);
  var permResult = await permPage.evaluate(function (o) {
    return chrome.permissions.request({ origins: [o] }).then(function (granted) { return { granted: granted }; })
      .catch(function (e) { return { error: String(e && e.message || e) }; });
  }, new URL(START_URL).origin + '/*');
  assert(permResult && permResult.granted === true, 'real host permission grant did not resolve granted:true — ' + JSON.stringify(permResult));
  await permPage.close();

  var siteTab = await swEval(function () {
    return chrome.tabs.query({}).then(function (tabs) {
      var t = tabs.find(function (t) { return typeof t.url === 'string' && t.url.indexOf('books.toscrape.com') !== -1; });
      return t ? { id: t.id, url: t.url } : null;
    });
  });
  assert(siteTab && siteTab.id != null, 'could not resolve the real site tab');
  passed.push('Real optional host permission granted; resolved the real site tab (id=' + siteTab.id + ')');

  log.step('Opening the REAL popup with the tab-resolution shim (documented Playwright-toolbar-popup workaround)');
  var popupPage = await context.newPage();
  var popupConsoleErrors = [];
  popupPage.on('console', function (msg) { if (msg.type() === 'error') popupConsoleErrors.push(msg.text()); });
  popupPage.on('pageerror', function (err) { popupConsoleErrors.push('pageerror: ' + err.message); });
  await popupPage.addInitScript(function (args) {
    var tabId = args.tabId, tabUrl = args.tabUrl;
    var origQuery = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = function (queryInfo, callback) {
      var isActiveCurrentWindowQuery = queryInfo && queryInfo.active === true && queryInfo.currentWindow === true &&
        Object.keys(queryInfo).length === 2;
      if (isActiveCurrentWindowQuery) {
        var fakeTab = { id: tabId, url: tabUrl, active: true, windowId: 1, index: 0, title: 'books.toscrape.com' };
        if (typeof callback === 'function') { setTimeout(function () { callback([fakeTab]); }, 0); return undefined; }
        return Promise.resolve([fakeTab]);
      }
      return origQuery(queryInfo, callback);
    };
  }, { tabId: siteTab.id, tabUrl: siteTab.url });
  await popupPage.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await popupPage.waitForTimeout(1500);

  // ---- STEP 1: Activate picker (real #add-column-btn — the same
  // shared picker mechanism the DETAY tab's own button drives) ----
  log.step('Clicking the REAL #add-column-btn (activates the real, unmodified production picker)');
  await popupPage.locator('#add-column-btn').click();
  await popupPage.waitForTimeout(600);

  async function overlayVisible() {
    return sitePage.evaluate(function () {
      var hosts = document.querySelectorAll('div');
      for (var i = 0; i < hosts.length; i++) {
        if (hosts[i].shadowRoot) {
          var ov = hosts[i].shadowRoot.querySelector('.ws-picker-overlay');
          if (ov) return getComputedStyle(ov).display !== 'none';
        }
      }
      return null;
    });
  }
  async function highlightRect() {
    return sitePage.evaluate(function () {
      var hosts = document.querySelectorAll('div');
      for (var i = 0; i < hosts.length; i++) {
        if (hosts[i].shadowRoot) {
          var hl = hosts[i].shadowRoot.querySelector('.ws-highlight');
          if (hl) return { display: getComputedStyle(hl).display, left: hl.style.left, top: hl.style.top, width: hl.style.width, height: hl.style.height };
        }
      }
      return null;
    });
  }
  async function panelVisible() {
    return sitePage.evaluate(function () {
      var hosts = document.querySelectorAll('div');
      for (var i = 0; i < hosts.length; i++) {
        if (hosts[i].shadowRoot) {
          var p = hosts[i].shadowRoot.querySelector('.ws-panel');
          if (p) return getComputedStyle(p).display !== 'none';
        }
      }
      return false;
    });
  }
  async function panelExampleText() {
    return sitePage.evaluate(function () {
      var hosts = document.querySelectorAll('div');
      for (var i = 0; i < hosts.length; i++) {
        if (hosts[i].shadowRoot) {
          var ex = hosts[i].shadowRoot.querySelector('.ws-panel .ws-example');
          if (ex) return ex.textContent;
        }
      }
      return null;
    });
  }

  var ovVisible = await overlayVisible();
  assert(ovVisible === true, 'the picker overlay is not visible after activating picker mode — picker did not actually start');
  passed.push('STEP 1: Picker activated — the real overlay (content/content.js) is visible over the real page');

  // ---- STEP 2: hover -> highlight appears ----
  log.step('Hovering the real plain-text element -> expecting the highlight box to appear');
  var textBox = await sitePage.locator('#ws-test-text').boundingBox();
  assert(textBox, 'could not get bounding box for #ws-test-text');
  await sitePage.mouse.move(textBox.x + textBox.width / 2, textBox.y + textBox.height / 2);
  await popupPage.waitForTimeout(150); // rAF-throttled highlight update
  var hl = await highlightRect();
  assert(hl && hl.display === 'block', 'highlight box did not appear on hover — got: ' + JSON.stringify(hl));
  passed.push('STEP 2: Real hover over a real element produced a real highlight — ' + JSON.stringify(hl));

  // ---- STEP 3: click normal text -> captured ----
  log.step('Clicking the real plain-text element -> expecting it to be captured (panel appears)');
  await sitePage.mouse.click(textBox.x + textBox.width / 2, textBox.y + textBox.height / 2);
  await popupPage.waitForTimeout(300);
  var pv = await panelVisible();
  assert(pv === true, 'the naming panel did not appear after clicking plain text — click was not captured');
  var exText = await panelExampleText();
  assert(exText && exText.indexOf('Plain paragraph text for picking') !== -1, 'captured example value does not match the real clicked text — got: "' + exText + '"');
  passed.push('STEP 3: Real click on plain text was captured — real example value shown: "' + exText + '"');
  details.plainTextExample = exText;

  // Dismiss (Cancel) — exits pick mode entirely for the 'column' purpose.
  await sitePage.keyboard.press('Escape');
  await popupPage.waitForTimeout(200);
  assert((await overlayVisible()) === false, 'overlay still visible after Escape — cleanup did not run');
  passed.push('Picker exited cleanly after a successful pick (overlay hidden — cleanup confirmed)');

  // ---- STEP 4/5/6/7/8: re-activate, click the NESTED <span> inside the
  // real <a>, confirm no navigation, confirm the real value is captured ----
  log.step('Re-activating picker and clicking the NESTED <span> inside a real <a> (the bug report\'s own exact example)');
  await popupPage.locator('#add-column-btn').click();
  await popupPage.waitForTimeout(600);
  var urlBeforeSpanClick = sitePage.url();
  var hashBeforeSpanClick = await sitePage.evaluate(function () { return location.hash; });

  var spanBox = await sitePage.locator('#ws-test-span').boundingBox();
  assert(spanBox, 'could not get bounding box for #ws-test-span');
  await sitePage.mouse.move(spanBox.x + spanBox.width / 2, spanBox.y + spanBox.height / 2);
  await popupPage.waitForTimeout(150);
  await sitePage.mouse.click(spanBox.x + spanBox.width / 2, spanBox.y + spanBox.height / 2);
  await popupPage.waitForTimeout(300);

  var urlAfterSpanClick = sitePage.url();
  var hashAfterSpanClick = await sitePage.evaluate(function () { return location.hash; });
  var anchorClickCountAfterPick = await sitePage.evaluate(function () { return window.__wsTestAnchorClicked; });
  assert(urlAfterSpanClick === urlBeforeSpanClick && hashAfterSpanClick === hashBeforeSpanClick,
    'CORE BUG PROOF FAILED: the page navigated (hash changed) after clicking a nested <span> inside a real <a> during picker mode — before: "' + hashBeforeSpanClick + '", after: "' + hashAfterSpanClick + '"');
  assert(anchorClickCountAfterPick === 0, 'CORE BUG PROOF FAILED: the real <a>\'s own click handler fired (' + anchorClickCountAfterPick + ' times) during picker mode — the site\'s own click behavior was NOT suppressed');
  passed.push('STEPS 5/6: Clicked the nested <span> inside a real <a> — NO navigation occurred (hash unchanged), the real anchor\'s own click handler did NOT fire (0 times)');

  var pv2 = await panelVisible();
  assert(pv2 === true, 'the naming panel did not appear after clicking the nested span — click was not captured');
  var exText2 = await panelExampleText();
  assert(exText2 && exText2.indexOf('CountryCottageImages') !== -1, 'captured example value does not reflect the nested span\'s own text — got: "' + exText2 + '"');
  passed.push('STEPS 7/8: Real selected value returned to the UI and visible — example value: "' + exText2 + '" (correctly the SPAN\'s own text, not the anchor\'s href or the whole card)');
  details.nestedSpanExample = exText2;

  await sitePage.screenshot({ path: path.join(ARTIFACT_DIR, 'picker-nested-anchor-captured.png'), timeout: 60000 }).catch(function () {});

  await sitePage.keyboard.press('Escape');
  await popupPage.waitForTimeout(200);

  // ---- A real <button> too ----
  log.step('Re-activating picker and clicking a real <button> — confirming it does not activate');
  await popupPage.locator('#add-column-btn').click();
  await popupPage.waitForTimeout(600);
  var btnBox = await sitePage.locator('#ws-test-button').boundingBox();
  await sitePage.mouse.click(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
  await popupPage.waitForTimeout(300);
  var buttonClickCountAfterPick = await sitePage.evaluate(function () { return window.__wsTestButtonClicked; });
  assert(buttonClickCountAfterPick === 0, 'the real <button>\'s own click handler fired during picker mode — button activation was NOT suppressed');
  assert((await panelVisible()) === true, 'the naming panel did not appear after clicking the real button');
  passed.push('Real <button> click during picker mode: button did NOT activate (0 real click events), and was correctly captured by the picker instead');
  await sitePage.keyboard.press('Escape');
  await popupPage.waitForTimeout(200);

  // ---- STEP 9: confirm normal website behavior returns after picker exits ----
  log.step('Confirming normal website behavior is fully restored after picker mode exits');
  assert((await overlayVisible()) === false, 'overlay still visible after exiting picker mode');
  var anchorBox = await sitePage.locator('#ws-test-anchor').boundingBox();
  await sitePage.mouse.click(anchorBox.x + anchorBox.width / 2, anchorBox.y + anchorBox.height / 2);
  await popupPage.waitForTimeout(300);
  var anchorClickCountNormal = await sitePage.evaluate(function () { return window.__wsTestAnchorClicked; });
  var hashAfterNormalClick = await sitePage.evaluate(function () { return location.hash; });
  assert(anchorClickCountNormal === 1, 'STEP 9 FAILED: the real anchor\'s click handler did not fire on a NORMAL (post-picker) click — normal website behavior was not restored (count: ' + anchorClickCountNormal + ')');
  assert(hashAfterNormalClick === '#test-anchor-should-not-navigate-during-pick', 'STEP 9 FAILED: normal anchor navigation (hash change) did not happen after picker exited — got hash: "' + hashAfterNormalClick + '"');
  passed.push('STEP 9: CONFIRMED — after picker mode exits, the real page\'s own click handling and navigation work completely normally again (anchor click fired for real, hash navigated for real)');

  // ---- Confirm the EXACT reported entry point (DETAY "Pick a Field on
  // an Example Page" / purpose:'live-detail-field') is fixed too — a
  // lighter confirmation reusing the same shared, now-fixed mechanism. ----
  log.step('Confirming the exact reported entry point too: DETAY tab\'s real "Pick a Field on an Example Page" button');
  var seedStateResult = await swEval(function (args) {
    return new Promise(function (resolve) {
      var key = 'ws_state::' + args.hostname;
      var data = {}; data[key] = { containerSelector: 'article.product_pod', columns: [
        { id: 'c_title', name: 'Title', relativeSelector: 'h3 a', attribute: 'text' },
        { id: 'c_link', name: 'Link', relativeSelector: 'h3 a', attribute: 'href' }
      ] };
      chrome.storage.local.set(data, function () { resolve({ ok: !chrome.runtime.lastError }); });
    });
  }, { hostname: 'books.toscrape.com' });
  assert(seedStateResult.ok, 'failed to seed columns for the DETAY confirmation');

  await popupPage.close();
  popupPage = await context.newPage();
  popupPage.on('console', function (msg) { if (msg.type() === 'error') popupConsoleErrors.push(msg.text()); });
  await popupPage.addInitScript(function (args) {
    var tabId = args.tabId, tabUrl = args.tabUrl;
    var origQuery = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = function (queryInfo, callback) {
      var isActiveCurrentWindowQuery = queryInfo && queryInfo.active === true && queryInfo.currentWindow === true &&
        Object.keys(queryInfo).length === 2;
      if (isActiveCurrentWindowQuery) {
        var fakeTab = { id: tabId, url: tabUrl, active: true, windowId: 1, index: 0, title: 'books.toscrape.com' };
        if (typeof callback === 'function') { setTimeout(function () { callback([fakeTab]); }, 0); return undefined; }
        return Promise.resolve([fakeTab]);
      }
      return origQuery(queryInfo, callback);
    };
  }, { tabId: siteTab.id, tabUrl: siteTab.url });
  await popupPage.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await popupPage.waitForTimeout(1500);
  await popupPage.locator('#basla-btn').click();
  await popupPage.waitForTimeout(2500);
  try { await popupPage.locator('#durdur-btn').click({ timeout: 5000 }); } catch (e) { /* may already be terminal */ }
  await popupPage.waitForTimeout(1000);
  await popupPage.locator('#discovery-process-all-btn').click({ timeout: 10000 }).catch(function () {});
  await popupPage.waitForTimeout(500);
  await popupPage.locator('#detay-tab-btn').click();
  await popupPage.waitForTimeout(300);
  await popupPage.locator('#dt-pick-fields-btn').click();

  var sampleDetailPage = null;
  var waitStart = Date.now();
  while (Date.now() - waitStart < 20000 && !sampleDetailPage) {
    sampleDetailPage = context.pages().find(function (pg) { return /books\.toscrape\.com\/catalogue\//.test(pg.url()); }) || null;
    if (!sampleDetailPage) await popupPage.waitForTimeout(500);
  }
  assert(sampleDetailPage, 'no real sample detail page opened via the real DETAY "Pick a Field" button');
  await sampleDetailPage.waitForLoadState('load', { timeout: 15000 }).catch(function () {});

  // Inject a real anchor onto the REAL sample detail page and click it via the REAL 'live-detail-field' picker.
  await sampleDetailPage.evaluate(function () {
    window.__wsDetailAnchorClicked = 0;
    var a = document.createElement('a');
    a.id = 'ws-detail-test-anchor';
    a.href = '#detail-anchor-should-not-navigate';
    a.textContent = 'Detail Test Link';
    a.style.cssText = 'position:fixed;top:150px;left:150px;z-index:999999;background:#fff;padding:8px;border:2px solid blue;';
    a.addEventListener('click', function () { window.__wsDetailAnchorClicked++; });
    document.body.appendChild(a);
  });
  await popupPage.waitForTimeout(500);
  var detailAnchorBox = await sampleDetailPage.locator('#ws-detail-test-anchor').boundingBox();
  var hashBefore = await sampleDetailPage.evaluate(function () { return location.hash; });
  await sampleDetailPage.mouse.click(detailAnchorBox.x + detailAnchorBox.width / 2, detailAnchorBox.y + detailAnchorBox.height / 2);
  await popupPage.waitForTimeout(400);
  var hashAfter = await sampleDetailPage.evaluate(function () { return location.hash; });
  var detailAnchorClicks = await sampleDetailPage.evaluate(function () { return window.__wsDetailAnchorClicked; });
  assert(hashAfter === hashBefore, 'CORE BUG PROOF FAILED (exact reported entry point): the real DETAY sample page navigated after clicking a real <a> during "live-detail-field" picker mode');
  assert(detailAnchorClicks === 0, 'CORE BUG PROOF FAILED (exact reported entry point): the real anchor\'s own click handler fired during "live-detail-field" picker mode');
  passed.push('EXACT REPORTED ENTRY POINT CONFIRMED FIXED: DETAY\'s real "Pick a Field on an Example Page" button — clicking a real <a> on the real sample page did NOT navigate and did NOT run the site\'s own click handler');

  await sampleDetailPage.screenshot({ path: path.join(ARTIFACT_DIR, 'picker-detail-entrypoint-confirmed.png'), timeout: 60000 }).catch(function () {});
  await sampleDetailPage.keyboard.press('Escape').catch(function () {});

  details.consoleErrors = { sitePage: consoleErrors, popupPage: popupConsoleErrors };
  if (consoleErrors.length) log.warn('Site page console errors: ' + JSON.stringify(consoleErrors.slice(0, 10)));
  if (popupConsoleErrors.length) log.warn('Popup console errors: ' + JSON.stringify(popupConsoleErrors.slice(0, 10)));

  return { passed: passed, details: details };
}

module.exports = { run: run, START_URL: START_URL, ARTIFACT_DIR: ARTIFACT_DIR };
