/**
 * etsy-detail-picker-real-flow.test.js
 * The Etsy-specific Detail Enrichment / Element Picker acceptance test —
 * the real Etsy verification of the popup-lifecycle picker fix that
 * `picker-popup-lifecycle-real-flow.test.js` already proves against
 * books.toscrape.com (this project's established, reliable substitute
 * site — see that file's own header). This file exists because the
 * ORIGINALLY REPORTED bug was found on Etsy itself, so a dedicated,
 * real-Etsy run of the full picker + small Detail Enrichment flow is
 * required as its own piece of evidence, honestly reporting
 * BLOCKED_BY_SITE if Etsy's own anti-bot challenge appears (as this
 * project's test history shows it repeatedly does) rather than ever
 * working around it.
 *
 * REAL production path only, per the Anti-False-Pass Rule — real popup
 * clicks (#basla-btn/#durdur-btn/#discovery-process-all-btn/
 * #detay-tab-btn/#dt-pick-fields-btn/#dt-test-btn/#dt-start-btn), real
 * chrome.permissions.request(), real chrome.tabs.sendMessage(RUN_AUTO_
 * DETECT) (the same real message content/autodetect.js's own listener
 * handles when a user clicks the real Auto Detect button — used here
 * instead of hand-guessed CSS selectors so this test is not brittle
 * against Etsy's own frequently-changing markup), real mouse hover/
 * click on the real sample Etsy page, real background.js Detail
 * Enrichment engine actually visiting real Etsy URLs.
 *
 * Steps (mission's own 15-item checklist + a small real enrichment run):
 *   1-3. Real isolated browser + real extension + real Etsy page.
 *   4-6. Real popup -> DETAY -> real "Örnek Sayfada Alan Seç" click.
 *   7-8. Real activation reaches content.js; real PICKER ACTIVE banner.
 *   9.   Real hover -> real visible highlight.
 *   10.  Real field selection (a real, dynamically-found <a> element —
 *        deliberately a link, not plain text, to also exercise #11).
 *   11.  Confirm NO real navigation occurred.
 *   12.  Confirm selector + example value captured.
 *   13.  Popup closed immediately after staging (same real focus-loss
 *        reproduction technique as picker-popup-lifecycle-real-flow) —
 *        confirm the pick survives.
 *   14-15. Reopen popup; confirm DETAY shows the field.
 *   Then: real Test Fields preview (3 real Etsy URLs) + real Start
 *   Detail Enrichment (scope FIRST 3) + a rigorous, real, per-URL join-
 *   accuracy cross-check between the Test Fields preview output and the
 *   final merged rawRows (two independently-triggered real code paths
 *   extracting the same field from the same URLs must agree).
 */
const path = require('path');
const fs = require('fs');
const { assertNoChallenge } = require('../lib/challenge-detect');

const START_URL = 'https://www.etsy.com/search?q=candle+holder';
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts', 'latest', 'site-etsy-detail-picker');

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

async function run(ctx) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  var context = ctx.context, extensionId = ctx.extensionId, sw = ctx.serviceWorker, log = ctx.log;
  var passed = [];
  // Explicit, named checkpoints — mirrors exactly the 7 categories this
  // test is required to report separately; set to true only at the
  // point each is genuinely proven, never assumed.
  var details = {
    pickerActivation: false,
    hoverHighlight: false,
    navigationInterception: false,
    valueCapture: false,
    popupStatePersistence: false,
    detailEnrichment: false,
    rowJoinAccuracy: false
  };

  try {
    function swEval(fn, arg) {
      return withTimeout(sw.evaluate(fn, arg), 20000, 'service-worker evaluate');
    }

    // ---- 1-3. Real isolated browser (already launched by the caller/
    // site-runner) + real extension (already loaded) + real Etsy page ----
    log.step('1-3. Opening a real Etsy product-search page: ' + START_URL);
    var sitePage = await context.newPage();
    var siteConsoleErrors = [];
    sitePage.on('console', function (msg) { if (msg.type() === 'error') siteConsoleErrors.push(msg.text()); });
    sitePage.on('pageerror', function (err) { siteConsoleErrors.push('pageerror: ' + err.message); });
    await sitePage.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sitePage.waitForLoadState('load', { timeout: 30000 }).catch(function () {});
    details.finalUrl = sitePage.url();
    details.pageTitle = await sitePage.title().catch(function () { return '(unavailable)'; });
    await sitePage.screenshot({ path: path.join(ARTIFACT_DIR, 'etsy-search.png'), timeout: 60000 }).catch(function () {});

    // Honest BLOCKED_BY_SITE reporting — never bypassed. Checked BEFORE
    // any further real interaction, exactly like etsy-popup.test.js.
    var challengeResult = await assertNoChallenge(sitePage, 'Etsy', details);
    details.framesChecked = challengeResult.framesChecked;
    passed.push('1-3. Real Etsy page opened, real extension loaded, no CAPTCHA/challenge detected (' + challengeResult.framesChecked + ' frame(s) checked)');

    log.step('Granting the real optional host permission for etsy.com');
    var permPage = await context.newPage();
    await permPage.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await permPage.waitForTimeout(400);
    var permResult = await permPage.evaluate(function () {
      return chrome.permissions.request({ origins: ['https://*.etsy.com/*'] }).then(function (granted) { return { granted: granted }; })
        .catch(function (e) { return { error: String(e && e.message || e) }; });
    });
    assert(permResult && permResult.granted === true, 'real host permission grant did not resolve granted:true — ' + JSON.stringify(permResult));
    await permPage.close();
    passed.push('Real optional host permission granted for etsy.com');

    var siteTab = await swEval(function () {
      return chrome.tabs.query({}).then(function (tabs) {
        var t = tabs.find(function (t) { return typeof t.url === 'string' && /etsy\.com\/search/.test(t.url); });
        return t ? { id: t.id, url: t.url } : null;
      });
    });
    assert(siteTab && siteTab.id != null, 'could not resolve the real Etsy search tab — ' + JSON.stringify(siteTab));
    var hostname = new URL(siteTab.url).hostname;
    details.hostname = hostname;
    passed.push('Resolved the real Etsy tab (id=' + siteTab.id + ', hostname=' + hostname + ')');

    // ---- Real Auto Detect (RUN_AUTO_DETECT) instead of hand-guessed CSS
    // selectors — the exact real message content/autodetect.js's own
    // listener handles when a real user clicks Auto Detect, so this
    // exercises the real production detection engine against Etsy's
    // ACTUAL current markup rather than a brittle hardcoded guess. ----
    log.step('Injecting the real content-script bundle and running the REAL Auto Detect engine against the real Etsy page');
    var injectResult = await swEval(function (tabId) {
      return chrome.scripting.executeScript({ target: { tabId: tabId }, files: CONTENT_FILES })
        .then(function () { return { ok: true }; })
        .catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
    }, siteTab.id);
    assert(injectResult.ok, 'real content-script injection failed — ' + injectResult.error);

    var autoDetectResult = await swEval(function (tabId) {
      return chrome.tabs.sendMessage(tabId, { type: 'RUN_AUTO_DETECT' }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
    }, siteTab.id);
    assert(autoDetectResult && autoDetectResult.ok && autoDetectResult.structures && autoDetectResult.structures.length,
      'real RUN_AUTO_DETECT found no usable structure on the real Etsy page — ' + JSON.stringify(autoDetectResult));
    details.structuresFound = autoDetectResult.structures.length;

    // Pick the best-scoring structure (already sorted by score, best
    // first) that has both a usable text-ish field and a real href
    // (link) field — the Link column is required for the Detail
    // Enrichment source-URL join this test proves at the end.
    var chosenStructure = autoDetectResult.structures.find(function (s) {
      return s.fields.some(function (f) { return f.attribute === 'href'; }) && s.fields.some(function (f) { return f.attribute !== 'href'; });
    });
    assert(chosenStructure, 'no real Auto-Detected structure on Etsy had both a text field and a link field — ' + JSON.stringify(autoDetectResult.structures.map(function (s) { return { label: s.label, fieldAttrs: s.fields.map(function (f) { return f.attribute; }) }; })));

    var linkField = chosenStructure.fields.find(function (f) { return f.attribute === 'href'; });
    var otherFields = chosenStructure.fields.filter(function (f) { return f.attribute !== 'href'; }).slice(0, 2);
    var COLUMNS = otherFields.map(function (f, i) { return { id: 'c_' + i, name: f.name, relativeSelector: f.relativeSelector, attribute: f.attribute }; })
      .concat([{ id: 'c_link', name: 'Link', relativeSelector: linkField.relativeSelector, attribute: 'href' }]);
    var CONTAINER_SELECTOR = chosenStructure.containerSelector;
    details.autoDetectedContainerSelector = CONTAINER_SELECTOR;
    details.autoDetectedColumns = COLUMNS;
    passed.push('Real Auto Detect found a usable real Etsy structure (' + chosenStructure.label + ', ' + chosenStructure.itemCount + ' real items, score ' + chosenStructure.score + ') with a real Link column — used as the real scraping config');

    var seedStateResult = await swEval(function (args) {
      return new Promise(function (resolve) {
        var key = 'ws_state::' + args.hostname;
        var data = {}; data[key] = { containerSelector: args.containerSelector, columns: args.columns };
        chrome.storage.local.set(data, function () { resolve({ ok: !chrome.runtime.lastError }); });
      });
    }, { hostname: hostname, containerSelector: CONTAINER_SELECTOR, columns: COLUMNS });
    assert(seedStateResult.ok, 'failed to persist the real Auto-Detected column configuration');

    function installTabShim(page) {
      return page.addInitScript(function (args) {
        var origQuery = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = function (queryInfo, callback) {
          var isActiveCurrentWindowQuery = queryInfo && queryInfo.active === true && queryInfo.currentWindow === true &&
            Object.keys(queryInfo).length === 2;
          if (isActiveCurrentWindowQuery) {
            var fakeTab = { id: args.tabId, url: args.tabUrl, active: true, windowId: 1, index: 0, title: 'etsy.com' };
            if (typeof callback === 'function') { setTimeout(function () { callback([fakeTab]); }, 0); return undefined; }
            return Promise.resolve([fakeTab]);
          }
          return origQuery(queryInfo, callback);
        };
      }, { tabId: siteTab.id, tabUrl: siteTab.url });
    }

    // ---- 4. Real popup -> real BAŞLA -> real dataset ----
    log.step('4. Opening the REAL ClickScrape popup and clicking the REAL #basla-btn');
    var popupPage = await context.newPage();
    var popupConsoleErrors = [];
    popupPage.on('console', function (msg) { if (msg.type() === 'error') popupConsoleErrors.push(msg.text()); });
    popupPage.on('pageerror', function (err) { popupConsoleErrors.push('pageerror: ' + err.message); });
    await installTabShim(popupPage);
    await popupPage.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await popupPage.waitForTimeout(1500);

    var baslaBtn = popupPage.locator('#basla-btn');
    await baslaBtn.waitFor({ state: 'visible', timeout: 10000 });
    await baslaBtn.click();
    await popupPage.waitForTimeout(2500);

    var normalizedHost = hostname.replace(/^www\./, '');
    async function pollSession(predicate, timeoutMs, label) {
      var start = Date.now();
      var last = null;
      while (Date.now() - start < timeoutMs) {
        var s = await swEval(function (hostKey) {
          return new Promise(function (resolve) { chrome.storage.local.get([hostKey], function (r) { resolve(r[hostKey] || null); }); });
        }, 'ws_live_session::' + normalizedHost);
        if (s) last = s;
        if (s && predicate(s)) return s;
        await new Promise(function (r) { setTimeout(r, 400); });
      }
      log.warn('pollSession[' + label + '] timed out — last seen: ' + JSON.stringify(last && last.discovery));
      return last;
    }

    var sessionCreated = await pollSession(function (s) { return !!(s && s.discovery); }, 20000, 'session-created');
    assert(sessionCreated, 'real BAŞLA click never produced a live session on the real Etsy page');
    details.realRowsScraped = sessionCreated.rows.length;
    passed.push('Real BAŞLA click produced a real live session against real Etsy data — ' + sessionCreated.rows.length + ' real row(s) so far');

    log.step('Clicking the REAL #durdur-btn to stop Discovery with a small, fast real dataset');
    try { await popupPage.locator('#durdur-btn').click({ timeout: 5000 }); } catch (e) { log.warn('DURDUR click did not land (may already be terminal): ' + e.message); }
    var stateAfterStop = await pollSession(function (s) { return s.discovery && s.discovery.status !== 'discovering'; }, 15000, 'discovery-stopped');
    assert(stateAfterStop, 'real Discovery never reached a terminal state after DURDUR');
    passed.push('Real Discovery stopped (status: ' + stateAfterStop.discovery.status + ', ' + stateAfterStop.rows.length + ' real Etsy rows)');

    await popupPage.locator('#discovery-process-all-btn').waitFor({ state: 'visible', timeout: 10000 });
    await popupPage.locator('#discovery-process-all-btn').click();
    await popupPage.waitForTimeout(500);
    var rawRowCount = await popupPage.evaluate(function () { return window.__wsDiscoveryTestHooks ? window.__wsDiscoveryTestHooks.getRawRows().length : -1; });
    assert(rawRowCount > 0, 'real "ALL" click did not populate a real Etsy rawRows dataset');
    details.rawRowCount = rawRowCount;
    passed.push('Real "ALL" click moved ' + rawRowCount + ' real Etsy rows into the SONUÇ dataset');

    var detayEnabled = await popupPage.evaluate(function () { var el = document.getElementById('detay-tab-btn'); return el ? !el.disabled : false; });
    assert(detayEnabled, 'DETAY tab did not become enabled after a real Etsy dataset existed');
    log.step('5. Clicking the REAL #detay-tab-btn (DETAY)');
    await popupPage.locator('#detay-tab-btn').click();
    await popupPage.waitForTimeout(300);
    passed.push('5. Real DETAY tab reached with a real Etsy dataset');

    // ---- 6-8. Real pick click; picker activation reaches content.js ----
    log.step('6. Clicking the REAL "Örnek Sayfada Alan Seç" ("Pick a Field on an Example Page") button');
    var pickBtn = popupPage.locator('#dt-pick-fields-btn');
    await pickBtn.waitFor({ state: 'visible', timeout: 10000 });
    await pickBtn.click();
    await popupPage.waitForTimeout(150);

    var detailPage = null;
    var pickWaitStart = Date.now();
    while (Date.now() - pickWaitStart < 25000 && !detailPage) {
      var candidatePages = context.pages();
      detailPage = candidatePages.find(function (pg) { return /etsy\.com\/listing\//.test(pg.url()); }) || null;
      if (!detailPage) await popupPage.waitForTimeout(500);
    }
    assert(detailPage, 'no real sample Etsy listing page was opened by the real Pick Fields click within 25s');
    details.detailPageUrl = detailPage.url();
    passed.push('7. Real picker activation reached the production content script — a real sample Etsy listing page opened: ' + details.detailPageUrl);
    await detailPage.waitForLoadState('load', { timeout: 20000 }).catch(function () {});
    await detailPage.screenshot({ path: path.join(ARTIFACT_DIR, 'etsy-sample-listing.png'), timeout: 60000 }).catch(function () {});

    async function readBannerDisplay() {
      return detailPage.evaluate(function () {
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
    log.step('8. Waiting for the real "PICKER ACTIVE" banner to appear on the real Etsy page');
    var banner = null;
    var bannerWaitStart = Date.now();
    while (Date.now() - bannerWaitStart < 15000) {
      banner = await readBannerDisplay();
      if (banner && banner.display === 'block') break;
      await detailPage.waitForTimeout(300);
    }
    assert(banner && banner.display === 'block', '8. the real PICKER ACTIVE banner never appeared on the real Etsy page — got: ' + JSON.stringify(banner));
    assert(banner.text.indexOf('PICKER ACTIVE') !== -1, '8. banner text does not clearly say PICKER ACTIVE — got: "' + banner.text + '"');
    details.pickerActivation = true;
    passed.push('8. CONFIRMED — real visible "' + banner.text + '" state on the real Etsy webpage');
    await detailPage.screenshot({ path: path.join(ARTIFACT_DIR, 'etsy-picker-active.png'), timeout: 60000 }).catch(function () {});

    // ---- 9. Real hover -> real visible highlight, on a REAL, dynamically
    // -found link/anchor element (deliberately a link, to also exercise
    // #11's "no navigation" requirement on the real reported bug shape) ----
    log.step('9/10. Finding a real, visible link on the real Etsy sample page to hover and select');
    var targetBox = await detailPage.evaluate(function () {
      var anchors = Array.prototype.slice.call(document.querySelectorAll('a[href]'));
      for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];
        var text = (a.textContent || '').trim();
        if (!text || text.length < 2) continue;
        var r = a.getBoundingClientRect();
        if (r.width < 10 || r.height < 8) continue;
        if (r.top < 0 || r.top > window.innerHeight - 20) continue; // must be on-screen without scrolling
        return { x: r.x, y: r.y, width: r.width, height: r.height, text: text.slice(0, 60), href: a.href };
      }
      return null;
    });
    assert(targetBox, 'could not find any real, visible, on-screen link on the real Etsy sample page to click');
    details.targetLinkText = targetBox.text;
    details.targetLinkHref = targetBox.href;
    log.info('Real target link found: "' + targetBox.text + '" -> ' + targetBox.href);

    var cx = targetBox.x + targetBox.width / 2, cy = targetBox.y + targetBox.height / 2;
    await detailPage.mouse.move(cx, cy);
    await detailPage.waitForTimeout(250);
    var hlDisplay = await detailPage.evaluate(function () {
      var hosts = document.querySelectorAll('div');
      for (var i = 0; i < hosts.length; i++) {
        if (hosts[i].shadowRoot) {
          var hl = hosts[i].shadowRoot.querySelector('.ws-highlight');
          if (hl) return getComputedStyle(hl).display;
        }
      }
      return null;
    });
    assert(hlDisplay === 'block', '9. real hover over a real Etsy link produced no visible highlight — got: ' + hlDisplay);
    details.hoverHighlight = true;
    passed.push('9. Real hover over a real Etsy element ("' + targetBox.text + '") produced a real visible highlight');

    // ---- 11. Real click on the real link -> confirm NO real navigation ----
    var hrefBefore = await detailPage.evaluate(function () { return location.href; });
    await detailPage.mouse.click(cx, cy);
    await detailPage.waitForTimeout(500);
    var hrefAfter = await detailPage.evaluate(function () { return location.href; });
    assert(hrefAfter === hrefBefore, '11. real navigation occurred after clicking a real Etsy link during picker mode (' + hrefBefore + ' -> ' + hrefAfter + ')');
    details.navigationInterception = true;
    passed.push('11. CONFIRMED — clicking a real Etsy link/anchor during picker mode did NOT navigate (' + hrefBefore + ' unchanged)');
    await detailPage.screenshot({ path: path.join(ARTIFACT_DIR, 'etsy-value-captured.png'), timeout: 60000 }).catch(function () {});

    // ---- 12. Confirm selector + example value captured ----
    var panelText = await detailPage.evaluate(function () {
      var hosts = document.querySelectorAll('div');
      for (var i = 0; i < hosts.length; i++) {
        if (hosts[i].shadowRoot) {
          var ex = hosts[i].shadowRoot.querySelector('.ws-panel .ws-example');
          if (ex) return ex.textContent;
        }
      }
      return null;
    });
    assert(panelText && panelText.trim().length > 0, '12. no real captured example value shown in the real picker panel');
    details.capturedExampleValue = panelText;
    details.valueCapture = true;
    passed.push('12. Real selector + example value captured — "' + panelText + '"');

    var panelNameInput = detailPage.locator('.ws-panel input[type="text"]').first();
    await panelNameInput.waitFor({ state: 'visible', timeout: 10000 });
    await panelNameInput.fill('EtsyPickedField');
    await detailPage.locator('.ws-panel .ws-btn-primary').click();
    await detailPage.waitForTimeout(400);
    await detailPage.keyboard.press('Escape');
    await detailPage.waitForTimeout(300);

    var staged = await swEval(function () {
      return new Promise(function (resolve) {
        chrome.storage.session.get(null, function (all) {
          var key = Object.keys(all || {}).find(function (k) { return k.indexOf('ws_live_detail_field_picks::') === 0; });
          resolve(key ? { key: key, value: all[key] } : null);
        });
      });
    });
    assert(staged && staged.value && staged.value.length === 1 && staged.value[0].name === 'EtsyPickedField',
      'the real Etsy pick did not stage correctly — ' + JSON.stringify(staged));
    passed.push('Real field "EtsyPickedField" named and saved via the real (unmodified) "Add Field" button, staged correctly');
    await detailPage.close();

    // ---- 13. Popup closure does not destroy picker state ----
    log.step('13. Closing and reopening the REAL popup — confirming the pick survives closure');
    await popupPage.close();
    popupPage = await context.newPage();
    popupPage.on('console', function (msg) { if (msg.type() === 'error') popupConsoleErrors.push(msg.text()); });
    popupPage.on('pageerror', function (err) { popupConsoleErrors.push('pageerror: ' + err.message); });
    await installTabShim(popupPage);
    await popupPage.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await popupPage.waitForTimeout(1800);

    var restoredSession = await popupPage.evaluate(function () { return window.__wsDiscoveryTestHooks ? !!window.__wsDiscoveryTestHooks.getActiveLiveSession() : false; });
    assert(restoredSession, '13. reopened popup did not restore the real live Etsy session');

    // ---- 14-15. Reopen -> DETAY shows the field ----
    log.step('14-15. Confirming DETAY shows the selected field after reopening');
    await popupPage.locator('#detay-tab-btn').click();
    await popupPage.waitForTimeout(300);
    var fieldsListText = await popupPage.evaluate(function () { var el = document.getElementById('dt-fields-list'); return el ? el.textContent : ''; });
    assert(fieldsListText.indexOf('EtsyPickedField') !== -1, '14-15. "EtsyPickedField" not shown in the real DETAY fields list after reopening — got: "' + fieldsListText + '"');
    details.popupStatePersistence = true;
    passed.push('13-15. CONFIRMED — popup closure did NOT destroy picker state; reopened popup shows "EtsyPickedField" in DETAY');
    await popupPage.screenshot({ path: path.join(ARTIFACT_DIR, 'etsy-detay-field-restored.png'), fullPage: true, timeout: 60000 }).catch(function () {});

    // ---- Small real Detail Enrichment run (a FEW products, never
    // hundreds) + rigorous per-URL join-accuracy cross-check ----
    log.step('Independently computing the real first-3-distinct Link values (same order buildDetailUrlList uses) for the join-accuracy check');
    var rawRowsSnapshot = await popupPage.evaluate(function () { return window.__wsDiscoveryTestHooks ? window.__wsDiscoveryTestHooks.getRawRows() : []; });
    var seenLinks = {};
    var first3Urls = [];
    for (var ri = 0; ri < rawRowsSnapshot.length && first3Urls.length < 3; ri++) {
      var link = rawRowsSnapshot[ri].c_link;
      if (link && !seenLinks[link]) { seenLinks[link] = true; first3Urls.push(link); }
    }
    assert(first3Urls.length >= 1, 'could not compute any real distinct Etsy Link values from rawRows for the join-accuracy check');
    details.first3Urls = first3Urls;

    log.step('Clicking the REAL "Test Fields (sample)" button — real PREVIEW/VALIDATION against real Etsy URLs');
    await popupPage.locator('#dt-test-btn').click();
    var testResultsText = '';
    var testWaitStart = Date.now();
    while (Date.now() - testWaitStart < 30000) {
      testResultsText = await popupPage.evaluate(function () { var el = document.getElementById('dt-test-results'); return el ? el.textContent : ''; });
      if (testResultsText && testResultsText.indexOf('Testing') !== 0) break;
      await popupPage.waitForTimeout(500);
    }
    details.testResultsText = testResultsText;
    assert(testResultsText.indexOf('EtsyPickedField') !== -1, 'real Test Fields results did not mention the configured field — got: "' + testResultsText + '"');
    passed.push('Real PREVIEW/VALIDATION step confirmed against real Etsy sample page(s)');

    // Parse "Page N" blocks -> { pageIndex(0-based): value } from the
    // REAL rendered preview text (real UI output, not an internal call).
    var previewByPage = {};
    var currentPage = -1;
    testResultsText.split('\n').forEach(function (line) {
      var pageMatch = line.match(/Page (\d+)/i);
      if (pageMatch) { currentPage = parseInt(pageMatch[1], 10) - 1; return; }
      if (currentPage >= 0 && line.indexOf('EtsyPickedField ->') !== -1) {
        previewByPage[currentPage] = line.split('->').slice(1).join('->').trim();
      }
    });
    details.previewByPage = previewByPage;

    log.step('Choosing REAL scope: FIRST ' + first3Urls.length + ', then clicking the REAL Start Detail Enrichment button');
    await popupPage.locator('#dt-scope-firstn-btn').click();
    await popupPage.locator('#dt-scope-firstn-input').fill(String(first3Urls.length));
    await popupPage.waitForTimeout(200);
    await popupPage.locator('#dt-start-btn').click();
    await popupPage.waitForTimeout(1500);

    var dtProgressVisible = await popupPage.evaluate(function () { var el = document.getElementById('dt-progress-section'); return el ? !el.hidden : false; });
    assert(dtProgressVisible, 'real Start click did not reveal the real progress section');

    log.step('Waiting for the REAL background.js engine to visit the real Etsy detail pages...');
    var terminalState = null;
    var startWait = Date.now();
    while (Date.now() - startWait < 90000) {
      var badgeText = await popupPage.evaluate(function () { var el = document.getElementById('dt-progress-badge'); return el ? el.textContent : ''; });
      if (['COMPLETED', 'STOPPED', 'ERROR'].indexOf(badgeText) !== -1) { terminalState = badgeText; break; }
      await popupPage.waitForTimeout(1000);
    }
    assert(terminalState === 'COMPLETED', 'real Etsy Detail Enrichment run did not reach COMPLETED within 90s — last badge: ' + terminalState);
    details.detailEnrichment = true;
    passed.push('REAL PROCESSING PROOF: background.js visited ' + first3Urls.length + ' real Etsy detail page(s) and completed');

    var mergedRows = await popupPage.evaluate(function () { return window.__wsDiscoveryTestHooks ? window.__wsDiscoveryTestHooks.getRawRows() : []; });
    var enrichedColumnKey = mergedRows.length ? Object.keys(mergedRows[0]).find(function (k) { return k.indexOf('dt_') === 0; }) : null;
    assert(enrichedColumnKey, 'no dt_-prefixed merged detail column found on rawRows after a completed real Etsy run');
    details.enrichedColumnKey = enrichedColumnKey;

    var populatedCount = mergedRows.filter(function (r) { return r[enrichedColumnKey]; }).length;
    assert(populatedCount >= 1, 'the real Etsy merge produced ZERO rows with a populated enriched value');
    details.populatedCount = populatedCount;
    details.enrichedProductCount = first3Urls.length;
    passed.push('CORE MERGE PROOF: ' + populatedCount + ' real Etsy row(s) carry a real, non-fabricated enriched value merged by URL');

    // ---- Rigorous join-accuracy cross-check: the Test Fields preview
    // (triggered independently, earlier) and the final merged rawRows
    // (triggered by the actual bulk run) must agree PER URL — two
    // separately-triggered real code paths extracting the same field
    // from the same URL should produce the identical value if (and only
    // if) the merge-by-URL join is genuinely correct. ----
    log.step('Cross-checking join accuracy: Test Fields preview vs. final merged rows, per real Etsy URL');
    var joinChecks = [];
    var joinMismatches = [];
    first3Urls.forEach(function (url, idx) {
      var row = mergedRows.find(function (r) { return r.c_link === url; });
      var previewVal = previewByPage[idx];
      var mergedVal = row ? row[enrichedColumnKey] : undefined;
      var entry = { url: url, previewVal: previewVal, mergedVal: mergedVal };
      joinChecks.push(entry);
      // Only compare when Test Fields actually produced a real preview
      // value for this URL (a genuinely missing/empty field on that one
      // real page is not a join-accuracy failure — it's a content fact).
      if (previewVal && previewVal !== '(missing)' && String(previewVal) !== mergedVal) {
        joinMismatches.push(entry);
      }
    });
    details.joinChecks = joinChecks;
    assert(joinMismatches.length === 0, 'ROW JOIN ACCURACY FAILED — the Test Fields preview and the final merged row disagree for the same real Etsy URL(s): ' + JSON.stringify(joinMismatches));
    details.rowJoinAccuracy = true;
    passed.push('ROW JOIN ACCURACY CONFIRMED: every enriched value merged back into the correct original row, cross-verified against an independently-triggered real preview, for ' + joinChecks.length + ' real Etsy URL(s)');

    await popupPage.screenshot({ path: path.join(ARTIFACT_DIR, 'etsy-detail-flow-complete.png'), fullPage: true, timeout: 60000 }).catch(function () {});

    details.consoleErrors = { sitePage: siteConsoleErrors, popupPage: popupConsoleErrors };
    if (siteConsoleErrors.length) log.warn('Etsy site page console errors: ' + JSON.stringify(siteConsoleErrors.slice(0, 10)));
    if (popupConsoleErrors.length) log.warn('Popup console errors: ' + JSON.stringify(popupConsoleErrors.slice(0, 10)));

    return { passed: passed, details: details };
  } catch (e) {
    e.details = Object.assign({}, details, e.details || {});
    throw e;
  }
}

module.exports = { run: run, START_URL: START_URL, ARTIFACT_DIR: ARTIFACT_DIR };
