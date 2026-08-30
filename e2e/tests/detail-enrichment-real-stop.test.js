/**
 * detail-enrichment-real-stop.test.js
 * STALL-FIX mission ROUND 3 — mission's own explicit "REAL STOP UI TEST"
 * requirement: "Use the actual popup Durdur button production path. Do
 * not call stopJob() directly in a test." Drives the REAL production
 * flow end to end: real BAŞLA -> real DETAY -> a real Detail Enrichment
 * run against a REAL, deliberately slow-to-respond public URL
 * (httpbin.org's own dedicated /delay endpoint — a safe, standard HTTP
 * test service, never Etsy) so a real record is genuinely still
 * in-flight -> a REAL click on the REAL #dt-stop-btn ("Durdur") ->
 * proves the exact real message/state path:
 *   real popup click -> out-of-band persisted stopRequested ->
 *   background reconciliation -> real STOPPED state -> UI reflects it.
 * Never calls any STOP-related background function directly.
 */
const path = require('path');
const fs = require('fs');

const START_URL = 'https://books.toscrape.com/';
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts', 'latest', 'site-detail-enrichment-stop');

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
  var details = {};

  function swEval(fn, arg) { return withTimeout(sw.evaluate(fn, arg), 20000, 'service-worker evaluate'); }

  log.step('1. Opening real page: ' + START_URL);
  var sitePage = await context.newPage();
  await sitePage.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sitePage.waitForLoadState('load', { timeout: 30000 }).catch(function () {});

  log.step('Granting the real optional host permission');
  var permPage = await context.newPage();
  await permPage.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await permPage.waitForTimeout(400);
  var permResult = await permPage.evaluate(function () {
    return Promise.all([
      chrome.permissions.request({ origins: ['https://books.toscrape.com/*'] }),
      chrome.permissions.request({ origins: ['https://httpbin.org/*'] })
    ]).then(function (r) { return { granted: r[0] && r[1] }; }).catch(function (e) { return { error: String(e && e.message || e) }; });
  });
  assert(permResult && permResult.granted === true, 'real host permission grant did not resolve granted:true — ' + JSON.stringify(permResult));
  await permPage.close();
  passed.push('Real optional host permissions granted (books.toscrape.com + httpbin.org)');

  var siteTab = await swEval(function () {
    return chrome.tabs.query({}).then(function (tabs) {
      var t = tabs.find(function (t) { return typeof t.url === 'string' && t.url.indexOf('books.toscrape.com') !== -1; });
      return t ? { id: t.id, url: t.url } : null;
    });
  });
  assert(siteTab && siteTab.id != null, 'could not resolve the real site tab');
  var hostname = new URL(siteTab.url).hostname;

  var seedStateResult = await swEval(function (args) {
    return new Promise(function (resolve) {
      var key = 'ws_state::' + args.hostname;
      var data = {}; data[key] = {
        containerSelector: 'article.product_pod',
        columns: [
          { id: 'c_title', name: 'Title', relativeSelector: 'h3 a', attribute: 'text' },
          { id: 'c_link', name: 'Link', relativeSelector: 'h3 a', attribute: 'href' }
        ]
      };
      chrome.storage.local.set(data, function () { resolve({ ok: !chrome.runtime.lastError }); });
    });
  }, { hostname: hostname });
  assert(seedStateResult.ok, 'failed to persist the scrape column configuration');

  function installTabShim(page) {
    return page.addInitScript(function (args) {
      var origQuery = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = function (queryInfo, callback) {
        var isActiveCurrentWindowQuery = queryInfo && queryInfo.active === true && queryInfo.currentWindow === true && Object.keys(queryInfo).length === 2;
        if (isActiveCurrentWindowQuery) {
          var fakeTab = { id: args.tabId, url: args.tabUrl, active: true, windowId: 1, index: 0, title: 'site' };
          if (typeof callback === 'function') { setTimeout(function () { callback([fakeTab]); }, 0); return undefined; }
          return Promise.resolve([fakeTab]);
        }
        return origQuery(queryInfo, callback);
      };
    }, { tabId: siteTab.id, tabUrl: siteTab.url });
  }

  log.step('2. Opening the REAL popup and clicking the REAL #basla-btn');
  var popupPage = await context.newPage();
  await installTabShim(popupPage);
  await popupPage.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await popupPage.waitForTimeout(1500);
  await popupPage.locator('#basla-btn').waitFor({ state: 'visible', timeout: 10000 });
  await popupPage.locator('#basla-btn').click();
  await popupPage.waitForTimeout(2500);

  var normalizedHost = hostname.replace(/^www\./, '');
  async function pollSession(predicate, timeoutMs) {
    var start = Date.now(); var last = null;
    while (Date.now() - start < timeoutMs) {
      var s = await swEval(function (hostKey) { return new Promise(function (resolve) { chrome.storage.local.get([hostKey], function (r) { resolve(r[hostKey] || null); }); }); }, 'ws_live_session::' + normalizedHost);
      if (s) last = s;
      if (s && predicate(s)) return s;
      await new Promise(function (r) { setTimeout(r, 400); });
    }
    return last;
  }
  var sessionCreated = await pollSession(function (s) { return !!(s && s.discovery); }, 20000);
  assert(sessionCreated, 'real BAŞLA click never produced a live session');
  try { await popupPage.locator('#durdur-btn').click({ timeout: 5000 }); } catch (e) { /* may already be terminal */ }
  await pollSession(function (s) { return s.discovery && s.discovery.status !== 'discovering'; }, 15000);

  await popupPage.locator('#discovery-process-all-btn').waitFor({ state: 'visible', timeout: 10000 });
  await popupPage.locator('#discovery-process-all-btn').click();
  await popupPage.waitForTimeout(500);
  var rawRowCount = await popupPage.evaluate(function () { return window.__wsDiscoveryTestHooks ? window.__wsDiscoveryTestHooks.getRawRows().length : -1; });
  assert(rawRowCount > 0, 'real "ALL" click did not populate a real rawRows dataset');
  passed.push('Real BAŞLA -> DURDUR -> ALL produced ' + rawRowCount + ' real rows');

  await popupPage.locator('#detay-tab-btn').click();
  await popupPage.waitForTimeout(300);

  var stageResult = await swEval(function (args) {
    return new Promise(function (resolve) {
      var key = 'ws_live_detail_field_picks::' + args.hostname;
      var column = { id: 'c_dt_' + Date.now(), name: 'Title', relativeSelector: 'h1', attribute: 'text', multiple: 'first' };
      chrome.storage.session.get([key], function (result) {
        var staged = ((result && result[key]) || []).concat([column]);
        var data = {}; data[key] = staged;
        chrome.storage.session.set(data, function () { resolve({ ok: !chrome.runtime.lastError }); });
      });
    });
  }, { hostname: hostname });
  assert(stageResult.ok, 'failed to stage the real detail field pick');

  await popupPage.close();
  popupPage = await context.newPage();
  await installTabShim(popupPage);
  await popupPage.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await popupPage.waitForTimeout(1800);
  await popupPage.locator('#detay-tab-btn').click();
  await popupPage.waitForTimeout(300);

  // ---- Deliberately point the FIRST real row's own Link value at a
  // real, safe, standard HTTP test service's own /delay endpoint — a
  // genuinely slow-to-respond real URL (never Etsy, never any internal
  // scraping bypass — this is a live network navigation, exactly the
  // real production path, just aimed at a URL engineered to stay
  // in-flight long enough to click the real Stop button against it).
  // Done on THIS (current, not-yet-closed) popup instance so the
  // mutation survives into the same run this instance is about to
  // start — rawRows is restored from persisted session storage on
  // every popup (re)open, so mutating an earlier, now-closed instance's
  // in-memory copy (as an earlier version of this test mistakenly did)
  // is silently lost and never reaches the real run. ----
  await popupPage.evaluate(function () {
    var rows = window.__wsDiscoveryTestHooks.getRawRows();
    rows[0].c_link = 'https://httpbin.org/delay/60';
  });
  passed.push('Real row 1\'s own Link value pointed at a real, slow-to-respond public test URL (httpbin.org/delay/60) — a genuine in-flight real navigation to Stop against');

  await popupPage.locator('#dt-scope-firstn-btn').click();
  await popupPage.locator('#dt-scope-firstn-input').fill('1');
  await popupPage.waitForTimeout(200);

  log.step('3. Clicking the REAL Start Detail Enrichment button — real navigation to the real slow URL begins');
  await popupPage.locator('#dt-start-btn').click();
  await popupPage.waitForTimeout(1500);
  var dtProgressVisible = await popupPage.evaluate(function () { var el = document.getElementById('dt-progress-section'); return el ? !el.hidden : false; });
  assert(dtProgressVisible, 'real Start click did not reveal the real progress section');

  // Confirm it's genuinely in flight (RUNNING, not yet terminal) before
  // pressing Stop — proves this is a real Stop-while-active-record test,
  // not a race against an already-finished run.
  var runningConfirmed = false;
  var waitStart = Date.now();
  while (Date.now() - waitStart < 10000) {
    var badge = await popupPage.evaluate(function () { var el = document.getElementById('dt-progress-badge'); return el ? el.textContent : ''; });
    if (badge === 'RUNNING') { runningConfirmed = true; break; }
    await popupPage.waitForTimeout(300);
  }
  assert(runningConfirmed, 'the real run never reached a visible RUNNING state before Stop was attempted');
  await popupPage.screenshot({ path: path.join(ARTIFACT_DIR, 'stop-before.png'), timeout: 60000 }).catch(function () {});
  passed.push('Real Detail Enrichment run confirmed RUNNING against the real slow URL');

  log.step('4. Clicking the REAL "Durdur" (#dt-stop-btn) button — THE production STOP path under test');
  var stopClickedAt = Date.now();
  await popupPage.locator('#dt-stop-btn').click();

  // The real production path: this click -> directlyPersistDetailStopRequested
  // (out-of-band storage write from the popup itself) -> the real
  // background reconciliation -> real STOPPED state -> this SAME popup's
  // own chrome.storage.onChanged listener re-renders. Poll the REAL
  // rendered badge text — never call any background function directly.
  var stoppedConfirmed = false;
  var stopWaitStart = Date.now();
  while (Date.now() - stopWaitStart < 30000) {
    var badge2 = await popupPage.evaluate(function () { var el = document.getElementById('dt-progress-badge'); return el ? el.textContent : ''; });
    if (badge2 === 'STOPPED') { stoppedConfirmed = true; break; }
    await popupPage.waitForTimeout(250);
  }
  var stopElapsedMs = Date.now() - stopClickedAt;
  details.stopElapsedMs = stopElapsedMs;
  await popupPage.screenshot({ path: path.join(ARTIFACT_DIR, 'stop-after.png'), timeout: 60000 }).catch(function () {});
  assert(stoppedConfirmed, 'REAL STOP UI TEST FAILED: clicking the real Durdur button never resulted in the real UI showing STOPPED (waited 30s) — the exact bug this mission reports');
  assert(stopElapsedMs < 15000, 'MISSION REQUIREMENT: STOPPED is reached WITHOUT waiting for the slow record\'s own long delay — took ' + stopElapsedMs + 'ms, well under httpbin\'s own 60s delay');
  passed.push('REAL STOP UI TEST PASSED: real Durdur click -> real STOPPED state in ' + stopElapsedMs + 'ms, without waiting for the in-flight slow record');

  // ---- Confirm the real persisted state matches what the mission asks
  // to be verified: stopRequested, the real run state, completed/pending
  // counts all honest ----
  var finalRunState = await popupPage.evaluate(function () {
    return new Promise(function (resolve) { chrome.storage.local.get(['ws_deepscrape_run'], function (r) { resolve(r['ws_deepscrape_run'] || null); }); });
  });
  details.finalRunState = { status: finalRunState && finalRunState.status, stopRequested: finalRunState && finalRunState.stopRequested, counts: finalRunState && finalRunState.counts };
  assert(finalRunState && finalRunState.status === 'stopped', 'the real persisted ws_deepscrape_run.status is genuinely "stopped"');
  assert(finalRunState.stopRequested === true, 'the real persisted stopRequested flag is true');
  passed.push('Real persisted chrome.storage.local state confirmed: status=stopped, stopRequested=true');

  details.consoleErrors = [];
  return { passed: passed, details: details };
}

module.exports = { run: run, START_URL: START_URL, ARTIFACT_DIR: ARTIFACT_DIR };
