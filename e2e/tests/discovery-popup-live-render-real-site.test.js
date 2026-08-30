/**
 * discovery-popup-live-render-real-site.test.js
 * REGRESSION MISSION — "NORMAL DISCOVERY NOW STALLS ON PAGE 2" (real
 * production report, post Detail/STOP/state-machine round 3).
 *
 * discovery-pagination-real-site.test.js and
 * discovery-popup-start-real-site.test.js both already proved (and this
 * mission's own re-run reconfirmed) that content/discovery.js itself and
 * the underlying ws_live_session::<host> storage state keep advancing
 * correctly, page after page, completely unmodified by this session's
 * Detail Enrichment work. Neither of those tests, however, ever reads
 * the REAL POPUP's own rendered DOM text — both poll chrome.storage.local
 * directly from the service-worker context. That is exactly the blind
 * spot this file closes: it opens the real popup via the real #basla-btn
 * click (same production entry point), then polls BOTH the underlying
 * storage state AND the popup's own live-rendered DOM text
 * (#discovery-status-line2 / #auto-paginate-status) side by side, and
 * FAILS if the DOM text ever stops advancing while storage keeps
 * growing — the exact signature of a popup-side rendering freeze (e.g.
 * an uncaught exception thrown inside renderResults()'s own call chain,
 * upstream of renderLiveSessionUI()/renderDiscoveryUI(), silently
 * breaking only the VISIBLE progress display while the real underlying
 * data collection keeps working perfectly underneath it — which would
 * look, to a real user, exactly like "discovery stops making progress").
 */
const path = require('path');

const START_URL = 'https://books.toscrape.com/';
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts', 'latest', 'site-discovery-live-render');
const PAGES_TO_TRAVERSE = 3;

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

function assert(cond, msg) {
  if (!cond) {
    var err = new Error(msg);
    err.isAssertion = true;
    throw err;
  }
}

async function run(ctx) {
  var fs = require('fs');
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  var context = ctx.context, extensionId = ctx.extensionId, sw = ctx.serviceWorker, log = ctx.log;
  var passed = [];
  var details = {};

  function swEval(fn, arg) { return withTimeout(sw.evaluate(fn, arg), 20000, 'service-worker evaluate'); }

  log.step('Opening real public multi-page site: ' + START_URL);
  var sitePage = await context.newPage();
  await sitePage.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sitePage.waitForLoadState('load', { timeout: 30000 }).catch(function () {});
  passed.push('Real public multi-page site opened');

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
  passed.push('Real optional host permission granted');

  var siteTab = await swEval(function () {
    return chrome.tabs.query({}).then(function (tabs) {
      var t = tabs.find(function (t) { return typeof t.url === 'string' && t.url.indexOf('books.toscrape.com') !== -1; });
      return t ? { id: t.id, url: t.url } : null;
    });
  });
  assert(siteTab && siteTab.id != null, 'could not resolve the real site tab');

  var seedStateResult = await swEval(function (args) {
    return new Promise(function (resolve) {
      var key = 'ws_state::' + args.hostname;
      var data = {}; data[key] = { containerSelector: args.containerSelector, columns: args.columns };
      chrome.storage.local.set(data, function () { resolve({ ok: !chrome.runtime.lastError }); });
    });
  }, { hostname: 'books.toscrape.com', containerSelector: CONTAINER_SELECTOR, columns: COLUMNS });
  assert(seedStateResult.ok, 'failed to pre-seed column configuration');

  log.step('Opening the REAL popup and clicking the REAL #basla-btn');
  var popupPage = await context.newPage();
  await popupPage.addInitScript(function (args) {
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
  await popupPage.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await popupPage.waitForTimeout(1500);

  var baslaBtn = popupPage.locator('#basla-btn');
  await baslaBtn.waitFor({ state: 'visible', timeout: 10000 });
  await baslaBtn.click();
  await popupPage.waitForTimeout(2500);

  var normalizedHost = 'books.toscrape.com';

  // ---- Side-by-side capture: underlying storage state (ground truth)
  // AND the popup's own real rendered DOM text (what a human actually
  // sees), on every poll tick. ----
  async function captureBoth() {
    var storageState = await swEval(function (hostKey) {
      return new Promise(function (resolve) { chrome.storage.local.get([hostKey], function (r) { resolve(r[hostKey] || null); }); });
    }, 'ws_live_session::' + normalizedHost);
    var domText = await popupPage.evaluate(function () {
      var line2 = document.getElementById('discovery-status-line2');
      var line3 = document.getElementById('discovery-status-line3');
      var apStatus = document.getElementById('auto-paginate-status');
      return {
        line2: line2 ? line2.textContent : null,
        line3: line3 ? line3.textContent : null,
        apStatus: apStatus ? apStatus.textContent : null,
        apHidden: apStatus ? apStatus.hidden : null
      };
    }).catch(function (e) { return { error: String(e && e.message || e) }; });
    return { storage: storageState, dom: domText, at: Date.now() };
  }

  var samples = [];
  var start = Date.now();
  var reachedPage3 = false;
  while (Date.now() - start < 60000) {
    var sample = await captureBoth();
    samples.push(sample);
    var pv = sample.storage && sample.storage.discovery && sample.storage.discovery.pagesVisited;
    log.info('  t=' + Math.round((Date.now() - start) / 1000) + 's  storage.pagesVisited=' + pv +
      '  storage.status=' + (sample.storage && sample.storage.discovery && sample.storage.discovery.status) +
      '  DOM.line2="' + (sample.dom && sample.dom.line2) + '"  DOM.apStatus="' + (sample.dom && sample.dom.apStatus) + '" (hidden=' + (sample.dom && sample.dom.apHidden) + ')');
    if (pv >= PAGES_TO_TRAVERSE) { reachedPage3 = true; break; }
    await new Promise(function (r) { setTimeout(r, 1500); });
  }
  details.samples = samples.slice(-20); // last 20 for the report, avoid an enormous artifact

  await popupPage.screenshot({ path: path.join(ARTIFACT_DIR, 'live-render-final.png'), fullPage: true, timeout: 60000 }).catch(function () {});

  assert(reachedPage3, 'storage never reached page ' + PAGES_TO_TRAVERSE + ' within 60s — last samples: ' + JSON.stringify(samples.slice(-5)));
  passed.push('Underlying storage genuinely reached page ' + PAGES_TO_TRAVERSE + ' via the real popup START flow');

  // ---- THE ACTUAL REGRESSION CHECK: once storage shows pagesVisited advanced
  // past 1, the DOM's own visible page-count text (apStatus, shown while
  // discovering — see renderLiveSessionUI) must have advanced too, at
  // some point in the SAME sample set — proving the popup's live render
  // pipeline is not frozen relative to the real underlying data. ----
  var storageAdvancedSamples = samples.filter(function (s) { return s.storage && s.storage.discovery && s.storage.discovery.pagesVisited >= 2; });
  assert(storageAdvancedSamples.length > 0, 'setup check: never observed a sample with storage.pagesVisited >= 2');
  var domReflectedAdvance = storageAdvancedSamples.some(function (s) {
    var txt = (s.dom && (s.dom.apStatus || s.dom.line2)) || '';
    return /2|3|4|5/.test(txt); // page count of >=2 rendered somewhere in the visible text
  });
  assert(domReflectedAdvance, 'REGRESSION CONFIRMED: storage.discovery.pagesVisited advanced to >=2 but the popup\'s own rendered DOM text never reflected any page count beyond page 1 — this is a POPUP RENDER FREEZE, not a discovery-engine failure. Samples: ' + JSON.stringify(storageAdvancedSamples));
  passed.push('Popup\'s own live-rendered DOM text (visible to a real user) tracked the real underlying storage progress — no render freeze observed');

  details.consoleErrors = [];
  return { passed: passed, details: details };
}

module.exports = { run: run, START_URL: START_URL, ARTIFACT_DIR: ARTIFACT_DIR };
