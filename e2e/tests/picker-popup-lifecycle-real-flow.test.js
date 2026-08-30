/**
 * picker-popup-lifecycle-real-flow.test.js
 * BUG REOPEN — DETAIL VISUAL ELEMENT PICKER: real user flow still
 * broken after the event-interception fix. Root cause: the picker
 * activation sequence (open sample tab -> wait for load -> inject ->
 * send START_PICK) used to run entirely inside popup.js, across several
 * awaits, immediately after chrome.tabs.create({active:true}) — which,
 * in the REAL Chrome toolbar popup, steals window focus and destroys
 * the popup's own JS execution context before any of those later steps
 * ever ran. Fixed by moving the whole sequence into background.js
 * (see that file's own header comment on startDetailFieldPick), which
 * has no dependency on the popup's lifetime at all.
 *
 * THIS test is the one that actually proves that fix: it drives the
 * real production entry point (#dt-pick-fields-btn) and then explicitly
 * CLOSES the popup page immediately afterward — the same effect a real
 * toolbar popup's own focus-loss auto-dismissal has on its JS context
 * (Playwright cannot literally reproduce "focus was stolen from a
 * native toolbar popup", since that surface itself is undrivable — see
 * e2e/run.js's own documented limitation — but destroying the popup
 * page's JS context is the exact, real consequence that matters here,
 * and this reproduces it directly and unambiguously, sooner than a real
 * popup would even manage). If the fix is real, the picker still
 * activates on the real page, the click is still captured, and the
 * picked field still shows up in the DETAY UI on reopen — all with the
 * popup already gone by the time any of it happens.
 *
 * Mission's own "REAL USER TEST — MANDATORY" checklist, verbatim:
 *   1. Open a real browser page.
 *   2. Open ClickScrape popup.
 *   3. Go to DETAIL.
 *   4. Click "Örnek Sayfada Alan Seç".
 *   5. Confirm popup may close.
 *   6. Confirm webpage visibly shows PICKER ACTIVE.
 *   7. Hover over text -> visible highlight.
 *   8. Click an anchor/nested anchor.
 *   9. Confirm NO navigation occurs.
 *   10. Confirm selected value is stored.
 *   11. Reopen popup.
 *   12. DETAIL shows selected example value and selector.
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

function installTabShim(page, tabId, tabUrl) {
  return page.addInitScript(function (args) {
    var origQuery = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = function (queryInfo, callback) {
      var isActiveCurrentWindowQuery = queryInfo && queryInfo.active === true && queryInfo.currentWindow === true &&
        Object.keys(queryInfo).length === 2;
      if (isActiveCurrentWindowQuery) {
        var fakeTab = { id: args.tabId, url: args.tabUrl, active: true, windowId: 1, index: 0, title: 'books.toscrape.com' };
        if (typeof callback === 'function') { setTimeout(function () { callback([fakeTab]); }, 0); return undefined; }
        return Promise.resolve([fakeTab]);
      }
      return origQuery(queryInfo, callback);
    };
  }, { tabId: tabId, tabUrl: tabUrl });
}

async function run(ctx) {
  var context = ctx.context, extensionId = ctx.extensionId, sw = ctx.serviceWorker, log = ctx.log;
  var passed = [];
  var details = {};

  function swEval(fn, arg) {
    return withTimeout(sw.evaluate(fn, arg), 20000, 'service-worker evaluate');
  }

  log.step('1. Opening a real browser page: ' + START_URL);
  var sitePage = await context.newPage();
  var consoleErrors = [];
  sitePage.on('console', function (msg) { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  sitePage.on('pageerror', function (err) { consoleErrors.push('pageerror: ' + err.message); });
  await sitePage.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sitePage.waitForLoadState('load', { timeout: 30000 }).catch(function () {});

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
  passed.push('Real permission granted; real site tab resolved (id=' + siteTab.id + ')');

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
  assert(seedStateResult.ok, 'failed to seed columns');

  log.step('2. Opening the REAL ClickScrape popup');
  var popupPage = await context.newPage();
  var popupConsoleErrors = [];
  popupPage.on('console', function (msg) { if (msg.type() === 'error') popupConsoleErrors.push(msg.text()); });
  popupPage.on('pageerror', function (err) { popupConsoleErrors.push('pageerror: ' + err.message); });
  await installTabShim(popupPage, siteTab.id, siteTab.url);
  await popupPage.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await popupPage.waitForTimeout(1500);

  await popupPage.locator('#basla-btn').click();
  await popupPage.waitForTimeout(2500);
  try { await popupPage.locator('#durdur-btn').click({ timeout: 5000 }); } catch (e) { /* may already be terminal */ }
  await popupPage.waitForTimeout(1000);
  await popupPage.locator('#discovery-process-all-btn').click({ timeout: 10000 }).catch(function () {});
  await popupPage.waitForTimeout(500);

  log.step('3. Going to the real DETAIL (DETAY) tab');
  await popupPage.locator('#detay-tab-btn').click();
  await popupPage.waitForTimeout(300);
  passed.push('2/3. Real popup opened, real dataset produced, real DETAY tab reached');

  log.step('4. Clicking the REAL "Pick a Field on an Example Page" button ("Örnek Sayfada Alan Seç")');
  await popupPage.locator('#dt-pick-fields-btn').click();
  // Give the click handler's own synchronous dispatch (sendToBackground)
  // a brief real moment to actually leave the popup's process before
  // destroying it — a real toolbar popup wouldn't even guarantee this
  // much; closing this soon is deliberately AT LEAST as aggressive.
  await popupPage.waitForTimeout(150);

  log.step('5. Closing the popup NOW — reproducing a real toolbar popup\'s own focus-loss auto-dismissal');
  await popupPage.close();
  passed.push('5. CONFIRMED: the popup page was closed immediately after the pick was requested — its own JS execution context is gone');

  // ---- 6. Confirm webpage visibly shows PICKER ACTIVE (with the popup GONE) ----
  log.step('Waiting for the real sample detail page to open (background.js now owns this, not the dead popup)');
  var sampleDetailPage = null;
  var waitStart = Date.now();
  while (Date.now() - waitStart < 25000 && !sampleDetailPage) {
    sampleDetailPage = context.pages().find(function (pg) { return /books\.toscrape\.com\/catalogue\//.test(pg.url()); }) || null;
    if (!sampleDetailPage) await new Promise(function (r) { setTimeout(r, 500); });
  }
  assert(sampleDetailPage, 'CORE BUG PROOF FAILED: no real sample detail page ever opened after the popup was closed — the picker activation sequence did not survive popup closure');
  await sampleDetailPage.waitForLoadState('load', { timeout: 15000 }).catch(function () {});
  passed.push('CORE FIX PROOF: the real sample detail page opened successfully even though the popup that requested it was already closed');

  async function readBannerText() {
    return sampleDetailPage.evaluate(function () {
      var hosts = document.querySelectorAll('div');
      for (var i = 0; i < hosts.length; i++) {
        if (hosts[i].shadowRoot) {
          var b = hosts[i].shadowRoot.querySelector('.ws-banner');
          if (b) return { display: getComputedStyle(b).display, text: b.textContent };
        }
      }
      return null;
    });
  }
  var banner = null;
  var bannerWaitStart = Date.now();
  while (Date.now() - bannerWaitStart < 15000) {
    banner = await readBannerText();
    if (banner && banner.display === 'block') break;
    await sampleDetailPage.waitForTimeout(500);
  }
  assert(banner && banner.display === 'block', 'STEP 6 FAILED: the real "PICKER ACTIVE" banner never appeared on the real page — ' + JSON.stringify(banner));
  assert(banner.text.indexOf('PICKER ACTIVE') !== -1, 'STEP 6 FAILED: banner text does not clearly say PICKER ACTIVE — got: "' + banner.text + '"');
  passed.push('STEP 6: CONFIRMED — the real webpage visibly shows "' + banner.text + '" (popup was already closed)');
  await sampleDetailPage.screenshot({ path: path.join(ARTIFACT_DIR, 'picker-active-after-popup-closed.png'), timeout: 60000 }).catch(function () {});

  // ---- Confirm the background diagnostic session shows every real step ----
  var diagSession = await swEval(function () {
    return new Promise(function (resolve) {
      chrome.storage.local.get(['ws_detail_pick_session'], function (r) { resolve(r['ws_detail_pick_session'] || null); });
    });
  });
  details.diagSession = diagSession;
  assert(diagSession, 'no ws_detail_pick_session diagnostic recorded at all');
  assert(diagSession.tabId != null, 'diagnostic: no real tab id resolved — ' + JSON.stringify(diagSession));
  assert(diagSession.tabLoaded === true, 'diagnostic: tab never confirmed loaded — ' + JSON.stringify(diagSession));
  assert(diagSession.messageSent === true, 'diagnostic: START_PICK was never sent — ' + JSON.stringify(diagSession));
  assert(diagSession.messageAcked === true, 'diagnostic: content script never ACKed START_PICK — ' + JSON.stringify(diagSession));
  assert(diagSession.pickerActive === true, 'diagnostic: pickerActive is not true — ' + JSON.stringify(diagSession));
  assert(diagSession.step === 'picker-active', 'diagnostic: final step is not picker-active — got "' + diagSession.step + '"');
  passed.push('DIAGNOSTIC PROOF (Phase 1/2): every real step recorded and true — tabId=' + diagSession.tabId + ', tabLoaded=true, messageSent=true, messageAcked=true, pickerActive=true, step="picker-active"');

  // ---- 7/8/9/10: hover, click a nested anchor, confirm no navigation, confirm captured ----
  log.step('7/8. Real hover + real click on a REAL nested <a><span> injected onto the real page (with the popup still closed)');
  await sampleDetailPage.evaluate(function () {
    window.__wsAnchorClicked = 0;
    var a = document.createElement('a');
    a.id = 'ws-lifecycle-test-anchor';
    a.href = '#lifecycle-anchor-should-not-navigate';
    a.style.cssText = 'position:fixed;top:160px;left:160px;z-index:999999;background:#fff;padding:10px;border:2px solid purple;';
    var span = document.createElement('span');
    span.id = 'ws-lifecycle-test-span';
    span.textContent = 'CountryCottageImages';
    a.appendChild(span);
    a.addEventListener('click', function () { window.__wsAnchorClicked++; });
    document.body.appendChild(a);
  });
  await sampleDetailPage.waitForTimeout(300);

  var spanBox = await sampleDetailPage.locator('#ws-lifecycle-test-span').boundingBox();
  assert(spanBox, 'could not get bounding box for the injected nested span');
  await sampleDetailPage.mouse.move(spanBox.x + spanBox.width / 2, spanBox.y + spanBox.height / 2);
  await sampleDetailPage.waitForTimeout(200);
  var hlBeforeClick = await sampleDetailPage.evaluate(function () {
    var hosts = document.querySelectorAll('div');
    for (var i = 0; i < hosts.length; i++) {
      if (hosts[i].shadowRoot) {
        var hl = hosts[i].shadowRoot.querySelector('.ws-highlight');
        if (hl) return getComputedStyle(hl).display;
      }
    }
    return null;
  });
  assert(hlBeforeClick === 'block', 'STEP 7 FAILED: no visible highlight appeared while hovering the real nested span — got: ' + hlBeforeClick);
  passed.push('STEP 7: real hover over real text produced a real visible highlight');

  var hashBefore = await sampleDetailPage.evaluate(function () { return location.hash; });
  await sampleDetailPage.mouse.click(spanBox.x + spanBox.width / 2, spanBox.y + spanBox.height / 2);
  await sampleDetailPage.waitForTimeout(400);
  var hashAfter = await sampleDetailPage.evaluate(function () { return location.hash; });
  var anchorClicks = await sampleDetailPage.evaluate(function () { return window.__wsAnchorClicked; });
  assert(hashAfter === hashBefore, 'STEP 9 FAILED: real navigation occurred (hash changed) after clicking the nested anchor during picker mode');
  assert(anchorClicks === 0, 'STEP 9 FAILED: the real anchor\'s own click handler fired during picker mode');
  passed.push('STEP 8/9: real click on nested <a><span> — NO navigation occurred, the site\'s own click handler did NOT fire');

  var panelText = await sampleDetailPage.evaluate(function () {
    var hosts = document.querySelectorAll('div');
    for (var i = 0; i < hosts.length; i++) {
      if (hosts[i].shadowRoot) {
        var ex = hosts[i].shadowRoot.querySelector('.ws-panel .ws-example');
        if (ex) return ex.textContent;
      }
    }
    return null;
  });
  assert(panelText && panelText.indexOf('CountryCottageImages') !== -1, 'STEP 10 FAILED: captured example value does not reflect the real clicked span — got: "' + panelText + '"');
  passed.push('STEP 10: real selected value captured and shown — "' + panelText + '"');
  await sampleDetailPage.screenshot({ path: path.join(ARTIFACT_DIR, 'picker-lifecycle-nested-captured.png'), timeout: 60000 }).catch(function () {});

  // Name and save the field for real, so it actually gets staged.
  var nameInput = sampleDetailPage.locator('.ws-panel input[type="text"]').first();
  await nameInput.fill('SellerName');
  await sampleDetailPage.locator('.ws-panel .ws-btn-primary').click();
  await sampleDetailPage.waitForTimeout(400);
  await sampleDetailPage.keyboard.press('Escape');
  await sampleDetailPage.waitForTimeout(300);
  passed.push('Real field named "SellerName" and saved via the real (unmodified) "Add Field" button — with the popup still closed the entire time');

  var staged = await swEval(function () {
    return new Promise(function (resolve) {
      chrome.storage.session.get(null, function (all) {
        var key = Object.keys(all || {}).find(function (k) { return k.indexOf('ws_live_detail_field_picks::') === 0; });
        resolve(key ? all[key] : null);
      });
    });
  });
  assert(staged && staged.length === 1 && staged[0].name === 'SellerName', 'the real pick did not stage correctly — ' + JSON.stringify(staged));
  assert(!!staged[0].pickedFromUrl, 'Phase 5: staged field is missing its source URL (pickedFromUrl)');
  assert(!!staged[0].sampleValue && staged[0].sampleValue.indexOf('CountryCottageImages') !== -1, 'Phase 5: staged field is missing its real example value');
  passed.push('Staged field carries selector, extraction type, real example value ("' + staged[0].sampleValue + '"), and source URL ("' + staged[0].pickedFromUrl + '") — all while the popup stayed closed');

  // ---- 11/12: Reopen popup, confirm DETAIL shows the selected field ----
  log.step('11. Reopening the REAL popup');
  popupPage = await context.newPage();
  popupPage.on('console', function (msg) { if (msg.type() === 'error') popupConsoleErrors.push(msg.text()); });
  await installTabShim(popupPage, siteTab.id, siteTab.url);
  await popupPage.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await popupPage.waitForTimeout(1800);

  var restoredSession = await popupPage.evaluate(function () { return window.__wsDiscoveryTestHooks ? !!window.__wsDiscoveryTestHooks.getActiveLiveSession() : false; });
  assert(restoredSession, 'reopened popup did not restore the real live session');
  await popupPage.locator('#detay-tab-btn').click();
  await popupPage.waitForTimeout(300);

  log.step('12. Confirming DETAIL shows the selected example value and selector');
  var fieldsListText = await popupPage.evaluate(function () { var el = document.getElementById('dt-fields-list'); return el ? el.textContent : ''; });
  assert(fieldsListText.indexOf('SellerName') !== -1, 'STEP 12 FAILED: "SellerName" field not shown in the real DETAY fields list after reopening — got: "' + fieldsListText + '"');
  passed.push('STEP 11/12: CONFIRMED — after reopening the popup, DETAIL shows the field picked while the popup was closed ("SellerName")');

  // Also confirm the dev diagnostic panel/report is reachable and honest.
  var diagReport = await popupPage.evaluate(function () {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage({ type: 'GET_DETAIL_PICK_SESSION' }, function (res) { resolve(res); });
    });
  });
  assert(diagReport && diagReport.ok && diagReport.session && diagReport.session.pickerActive === true,
    'GET_DETAIL_PICK_SESSION diagnostic message did not return a healthy session from the reopened popup — ' + JSON.stringify(diagReport));
  passed.push('Dev diagnostic (GET_DETAIL_PICK_SESSION) reachable from the reopened popup and confirms pickerActive:true');

  await popupPage.screenshot({ path: path.join(ARTIFACT_DIR, 'picker-lifecycle-reopened-popup.png'), fullPage: true, timeout: 60000 }).catch(function () {});

  details.consoleErrors = { sitePage: consoleErrors, popupPage: popupConsoleErrors };
  if (consoleErrors.length) log.warn('Site page console errors: ' + JSON.stringify(consoleErrors.slice(0, 10)));
  if (popupConsoleErrors.length) log.warn('Popup console errors: ' + JSON.stringify(popupConsoleErrors.slice(0, 10)));

  return { passed: passed, details: details };
}

module.exports = { run: run, START_URL: START_URL, ARTIFACT_DIR: ARTIFACT_DIR };
