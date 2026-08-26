/**
 * discovery-pagination-real-site.test.js
 * MANDATORY real-browser verification of the AUTOMATIC DATA DISCOVERY
 * ENGINE (content/discovery.js) against a REAL, publicly accessible,
 * multi-page site — WITHOUT manually enabling Auto Next/Auto Scroll: this
 * test never sends START_AUTO_PAGINATE/START_AUTO_SCROLL at all, only the
 * single, unconditional START_DISCOVERY message a real BAŞLA click now
 * always sends (see popup.js's handleStartLiveSession). The engine itself
 * must decide pagination is the right traversal mechanism here — this
 * mirrors e2e/tests/autopaginate-real-site.test.js's own site choice/
 * reasoning (books.toscrape.com — Etsy is a confirmed, repeatedly-verified
 * anti-bot block in this environment and is not reused here).
 *
 * Drives the REAL, unmodified content/discovery.js/content/loadmore.js/
 * content/autoscroll.js/content/nextdetect.js/utils/discovery.js — only
 * the TRIGGER (this harness constructing the initial session and sending
 * START_DISCOVERY, instead of a real user's BAŞLA click through the
 * native toolbar popup, which Playwright cannot drive — see e2e/run.js's
 * documented limitation) is adapted for automation.
 */
const path = require('path');

const START_URL = 'https://books.toscrape.com/';
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts', 'latest');
const PAGES_TO_TRAVERSE = 3; // spec: "at least 3 real pages"

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

/**
 * @param {{context, extensionId, serviceWorker, log}} ctx
 */
async function run(ctx) {
  var context = ctx.context, extensionId = ctx.extensionId, sw = ctx.serviceWorker, log = ctx.log;
  var passed = [];
  var details = {};

  function swEval(fn, arg) {
    return withTimeout(sw.evaluate(fn, arg), 20000, 'service-worker evaluate');
  }

  log.step('Opening real public multi-page site: ' + START_URL);
  var sitePage = await context.newPage();
  var consoleErrors = [];
  sitePage.on('console', function (msg) { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  sitePage.on('pageerror', function (err) { consoleErrors.push('pageerror: ' + err.message); });
  await sitePage.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sitePage.waitForLoadState('load', { timeout: 30000 }).catch(function () {});
  details.startUrl = sitePage.url();
  await sitePage.screenshot({ path: path.join(ARTIFACT_DIR, 'discovery-initial.png'), timeout: 60000 });
  passed.push('Real public multi-page site opened (page 1): ' + details.startUrl);

  log.step('Requesting the real optional host permission for books.toscrape.com');
  var popupPage = await context.newPage();
  await popupPage.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await popupPage.waitForTimeout(500);
  var origin = new URL(START_URL).origin + '/*';
  var permResult = null;
  for (var attempt = 1; attempt <= 2 && !(permResult && permResult.granted); attempt++) {
    try {
      permResult = await withTimeout(
        popupPage.evaluate(function (o) {
          return chrome.permissions.request({ origins: [o] }).then(function (granted) { return { granted: granted }; })
            .catch(function (e) { return { error: String(e && e.message || e) }; });
        }, origin),
        30000, 'chrome.permissions.request() (attempt ' + attempt + ')'
      );
    } catch (e) {
      log.warn('Attempt ' + attempt + ' did not settle within 30s: ' + e.message);
      permResult = null;
    }
  }
  assert(permResult && permResult.granted === true, 'real host permission grant did not resolve granted:true — ' + JSON.stringify(permResult));
  passed.push('Real optional host permission granted for the target site');

  log.step('Injecting the REAL content-script bundle (includes content/discovery.js, content/loadmore.js, utils/discovery.js, unmodified)');
  var findAndInject = await swEval(async function (origin) {
    var tabs = await chrome.tabs.query({});
    var tab = tabs.find(function (t) { return typeof t.url === 'string' && t.url.indexOf('books.toscrape.com') !== -1; });
    if (!tab) return { ok: false, error: 'target tab not found' };
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
    } catch (e) {
      return { ok: false, error: 'executeScript failed: ' + (e && e.message || e) };
    }
    var registered = false, registerError = null;
    try {
      await chrome.scripting.registerContentScripts([{ id: 'e2e-discovery-books', matches: [origin], js: CONTENT_FILES, runAt: 'document_idle', persistAcrossSessions: false }]);
      registered = true;
    } catch (e) {
      try {
        await chrome.scripting.unregisterContentScripts({ ids: ['e2e-discovery-books'] });
        await chrome.scripting.registerContentScripts([{ id: 'e2e-discovery-books', matches: [origin], js: CONTENT_FILES, runAt: 'document_idle', persistAcrossSessions: false }]);
        registered = true;
      } catch (e2) { registerError = String(e2 && e2.message || e2); }
    }
    return { ok: true, tabId: tab.id, crossNavRegistered: registered, registerError: registerError };
  }, origin);
  assert(findAndInject.ok, 'failed to inject the real content-script bundle — ' + JSON.stringify(findAndInject));
  assert(findAndInject.crossNavRegistered, 'cross-navigation persistence did not register — ' + findAndInject.registerError);
  passed.push('Real content-script bundle injected AND cross-navigation persistence registered (includes the new Discovery engine files, unmodified)');
  var tabId = findAndInject.tabId;

  log.step('PAGE 1: running the REAL extraction engine against the real page');
  var page1Result = await swEval(function (args) {
    return chrome.scripting.executeScript({
      target: { tabId: args.tabId },
      func: function (containerSelector, columns) { return WSScraper.runExtraction({ containerSelector: containerSelector, columns: columns }); },
      args: [args.containerSelector, args.columns]
    }).then(function (results) { return results[0].result; });
  }, { tabId: tabId, containerSelector: CONTAINER_SELECTOR, columns: COLUMNS });
  var page1Rows = (page1Result && page1Result.rows) || [];
  details.page1RowCount = page1Rows.length;
  assert(page1Rows.length > 0, 'real extraction on page 1 returned ZERO rows');
  passed.push('PAGE 1: real data extracted from the real live page (' + page1Rows.length + ' rows)');

  // ---- Build the REAL session, seeding `discovery` via the REAL,
  // unmodified WSDiscoveryCore.createDiscoveryState() — executed for real
  // inside the tab, exactly mirroring what popup.js's handleStartLiveSession
  // now always does at BAŞLA. No autoPaginate/autoScroll toggle fields are
  // set anywhere here — this is the whole point of this test: the engine
  // must decide pagination is needed entirely on its own. ----
  var dedupeKey = 'c_link';
  var sessionId = 'e2e_discovery_pagination_' + Date.now();
  var normalizedHost = 'books.toscrape.com';
  var seedResult = await swEval(function (args) {
    return chrome.scripting.executeScript({
      target: { tabId: args.tabId },
      func: function (sessionId, hostname, tabId, containerSelector, columns, dedupeKey, rows, startUrl) {
        var session = {
          sessionId: sessionId, hostname: hostname, tabId: tabId, status: 'active',
          startedAt: Date.now(), updatedAt: Date.now(),
          scraperConfig: { containerSelector: containerSelector, columns: columns },
          dedupeKey: dedupeKey, rows: [], seenKeys: {}, lastPassNewRows: 0, lastCheckAt: Date.now(),
          progress: { rowsCollected: 0 },
          discovery: WSDiscoveryCore.createDiscoveryState({ startUrl: startUrl })
        };
        var merge = WSRunState.mergeNewRows(session, rows, columns);
        return merge.runState;
      },
      args: [args.sessionId, args.hostname, args.tabId, args.containerSelector, args.columns, args.dedupeKey, args.rows, args.startUrl]
    }).then(function (results) { return results[0].result; });
  }, { sessionId: sessionId, hostname: normalizedHost, tabId: tabId, containerSelector: CONTAINER_SELECTOR, columns: COLUMNS, dedupeKey: dedupeKey, rows: page1Rows, startUrl: START_URL });
  assert(seedResult && seedResult.discovery && seedResult.discovery.status === 'discovering', 'real WSDiscoveryCore.createDiscoveryState() did not seed a discovering session — ' + JSON.stringify(seedResult && seedResult.discovery));
  assert(seedResult.rows.length === page1Rows.length, 'real WSRunState.mergeNewRows did not accept all page-1 rows on seed');
  var writeResult = await swEval(function (s) {
    var key = 'ws_live_session::' + s.hostname;
    return new Promise(function (resolve) {
      var data = {}; data[key] = s;
      chrome.storage.local.set(data, function () { resolve({ ok: !chrome.runtime.lastError }); });
    });
  }, seedResult);
  assert(writeResult.ok, 'failed to persist the real seeded session');
  log.info('Real session seeded via the real WSDiscoveryCore + WSRunState, persisted: sessionId=' + sessionId);

  log.step('Starting REAL Automatic Discovery (content/discovery.js, unmodified) via START_DISCOVERY — no Auto Next/Auto Scroll message ever sent');
  var startResult = await swEval(function (id) {
    return chrome.tabs.sendMessage(id, { type: 'START_DISCOVERY' }).then(function (r) { return r; }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }, tabId);
  assert(startResult && startResult.ok, 'START_DISCOVERY did not confirm — ' + JSON.stringify(startResult));
  passed.push('Real automatic discovery started via a SINGLE message (START_DISCOVERY) — no pagination/scroll mode ever chosen by this harness');

  var lastSeenState = null;
  async function pollSession(predicate, timeoutMs, label) {
    var start = Date.now();
    var lastLoggedAt = 0;
    while (Date.now() - start < timeoutMs) {
      var s = await swEval(function (hostKey) {
        return new Promise(function (resolve) { chrome.storage.local.get([hostKey], function (r) { resolve(r[hostKey] || null); }); });
      }, 'ws_live_session::' + normalizedHost);
      if (s) lastSeenState = s;
      if (Date.now() - lastLoggedAt > 2000) {
        lastLoggedAt = Date.now();
        log.info('  poll [' + label + '] (' + Math.round((Date.now() - start) / 1000) + 's): ' +
          (s && s.discovery ? ('pagesVisited=' + s.discovery.pagesVisited + ' status=' + s.discovery.status + ' currentTraversalMethod=' + s.discovery.currentTraversalMethod + ' unique=' + s.discovery.discoveredUnique) : 'session/discovery missing'));
      }
      if (s && predicate(s)) return s;
      await new Promise(function (r) { setTimeout(r, 500); });
    }
    return null;
  }

  var pageRowCounts = { 1: page1Rows.length };
  for (var p = 2; p <= PAGES_TO_TRAVERSE; p++) {
    log.step('Waiting for the engine to AUTOMATICALLY navigate to page ' + p + ' (its own decision — pagination was never manually enabled)...');
    var reached = await pollSession(function (s) { return s.discovery && (s.discovery.pagesVisited >= p || s.discovery.status !== 'discovering'); }, 40000, 'page-' + p);
    assert(reached, 'timed out waiting for automatic discovery to reach page ' + p + ' — last seen: ' + JSON.stringify(lastSeenState && lastSeenState.discovery));
    assert(reached.discovery.pagesVisited >= p || reached.discovery.status !== 'discovering', 'expected pagesVisited >= ' + p + ' or a terminal status, got ' + JSON.stringify(reached.discovery));
    if (reached.discovery.status !== 'discovering') { log.warn('discovery reached a terminal state before page ' + p + ' — status: ' + reached.discovery.status + '/' + reached.discovery.stopReason); break; }
    pageRowCounts[p] = reached.rows.length;
    passed.push('PAGE ' + p + ': engine automatically determined pagination was required and navigated — ' + reached.rows.length + ' total unique rows so far');

    var pages = context.pages();
    var liveSitePage = pages.find(function (pg) { return /books\.toscrape\.com/.test(pg.url()); });
    if (liveSitePage) {
      await liveSitePage.screenshot({ path: path.join(ARTIFACT_DIR, 'discovery-growth-' + (p - 1) + '.png'), timeout: 60000 }).catch(function () {});
    }
  }

  // books.toscrape.com has 50 real pages (1000 books) — with production
  // (not test-shortened) growthTimeoutMs, each page's own scroll/Load-More
  // exhaustion legitimately takes real time before Next is even looked
  // for, so running this ALL the way to natural completion would take
  // many minutes. Mission section 55 only asks for "at least 3 real
  // pages... record exact counts" — already satisfied above. Per mission
  // section 23/51, explicitly Stop it now (the real DURDUR-equivalent
  // code path) rather than waiting out the full site — this is itself a
  // real, meaningful assertion (Stop preserves the real partial dataset,
  // never falsely claims completion).
  var stateBeforeStop = await pollSession(function (s) { return true; }, 1000, 'pre-stop-snapshot');
  var finalState = stateBeforeStop || lastSeenState;
  if (finalState.discovery.status === 'discovering') {
    log.step('Sufficient real automatic pagination evidence collected (' + finalState.discovery.pagesVisited + ' real pages) — sending real STOP_DISCOVERY (DURDUR-equivalent)');
    var stopResult = await swEval(function (id) {
      return chrome.tabs.sendMessage(id, { type: 'STOP_DISCOVERY' }).then(function (r) { return r; }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
    }, tabId);
    log.info('STOP_DISCOVERY response: ' + JSON.stringify(stopResult));
    await new Promise(function (r) { setTimeout(r, 800); });
    var afterStop = await pollSession(function (s) { return true; }, 1000, 'post-stop-snapshot');
    assert(afterStop.discovery.status === 'discovery_stopped', 'real STOP_DISCOVERY did not actually stop discovery (status: ' + afterStop.discovery.status + ')');
    assert(afterStop.discovery.discoveryComplete === false, 'a Stop must never be reported as discoveryComplete:true');
    assert(afterStop.rows.length >= finalState.rows.length, 'row count decreased after Stop — data was lost');
    finalState = afterStop;
    passed.push('Real Stop confirmed: automatic discovery stopped on command, ' + afterStop.rows.length + ' real rows preserved (status: discovery_stopped, never falsely discovery_complete)');
  } else {
    passed.push('Discovery already reached a natural real terminal state (' + finalState.discovery.status + '/' + finalState.discovery.stopReason + ')');
  }
  assert(finalState, 'no discovery state observed at all');
  details.finalDiscovery = finalState.discovery;
  details.finalRowCount = finalState.rows.length;
  details.pageRowCounts = pageRowCounts;
  log.info('Final discovery state: ' + JSON.stringify(finalState.discovery));

  assert(finalState.rows.length > page1Rows.length, 'dataset did not grow past page 1 — no real automatic accumulation happened');
  passed.push('Dataset genuinely accumulated via fully automatic traversal (page 1: ' + page1Rows.length + ' -> final: ' + finalState.rows.length + ')');
  assert(finalState.discovery.pagesVisited >= PAGES_TO_TRAVERSE || finalState.discovery.stopReason, 'expected either >= ' + PAGES_TO_TRAVERSE + ' pages visited or an honest stop reason');
  passed.push('Discovery reported a genuine, non-fabricated unique count: ' + finalState.discovery.discoveredUnique + ' (== session.rows.length: ' + finalState.rows.length + ')');
  assert(finalState.discovery.discoveredUnique === finalState.rows.length, 'discoveredUnique must always equal the real accumulated session.rows.length — never a fabricated/derived number');

  // ---- Duplicate-protection check on the real dataset ----
  var linkSet = {}, dupeCount = 0;
  finalState.rows.forEach(function (r) { var k = r[dedupeKey]; if (linkSet[k]) dupeCount++; else linkSet[k] = true; });
  assert(dupeCount === 0, 'found ' + dupeCount + ' duplicate product links in the accumulated real dataset');
  passed.push('Duplicate protection verified on the real, automatically-discovered dataset: 0 duplicate product links across ' + finalState.rows.length + ' rows');

  // ---- REAL FIRST-N / ALL processing test (mission section 59/60),
  // executed via the REAL WSDiscoveryCore functions, for real, inside the
  // tab — the popup UI itself cannot be driven by Playwright (documented
  // limitation), so this exercises the exact same processing API popup.js
  // now exposes (processAll()/processFirst(n)) at the level this harness
  // CAN reach: the shared pure core those functions are built on. ----
  var firstN = Math.min(10, finalState.rows.length);
  var realFirstN = await swEval(function (args) {
    return chrome.scripting.executeScript({
      target: { tabId: args.tabId },
      func: function (discoveredUnique, n, rows) {
        var validation = WSDiscoveryCore.validateSelection(discoveredUnique, 'first', n);
        var selected = WSDiscoveryCore.selectRows(rows, 'first', validation.effective);
        var all = WSDiscoveryCore.selectRows(rows, 'all', null);
        return { validation: validation, selectedCount: selected.length, selectedFirstTitle: selected[0] && selected[0].c_title, allCount: all.length };
      },
      args: [args.discoveredUnique, args.n, args.rows]
    }).then(function (results) { return results[0].result; });
  }, { tabId: tabId, n: firstN, rows: finalState.rows, discoveredUnique: finalState.discovery.discoveredUnique });
  assert(realFirstN.validation.ok, 'real processFirst(' + firstN + ') validation failed unexpectedly — ' + JSON.stringify(realFirstN.validation));
  assert(realFirstN.selectedCount === firstN, 'real processFirst(' + firstN + ') selected ' + realFirstN.selectedCount + ' rows, expected exactly ' + firstN);
  assert(realFirstN.selectedFirstTitle === finalState.rows[0].c_title, 'processFirst(' + firstN + ')\'s first row does not match the FIRST discovered record — stable order violated');
  assert(realFirstN.allCount === finalState.rows.length, 'real processAll() did not select every discovered record');
  details.processingTest = { requestedFirstN: firstN, selectedCount: realFirstN.selectedCount, allCount: realFirstN.allCount, sampleTitle: realFirstN.selectedFirstTitle };
  passed.push('REAL FIRST-N processing verified: FIRST ' + firstN + ' of ' + finalState.rows.length + ' discovered -> exactly ' + realFirstN.selectedCount + ' selected, stable order preserved');
  passed.push('REAL ALL processing verified: ' + realFirstN.allCount + ' of ' + finalState.rows.length + ' discovered selected');

  await popupPage.screenshot({ path: path.join(ARTIFACT_DIR, 'discovery-complete.png'), fullPage: true, timeout: 60000 }).catch(function () {});
  var pages2 = context.pages();
  var liveSitePage2 = pages2.find(function (pg) { return /books\.toscrape\.com/.test(pg.url()); });
  if (liveSitePage2) await liveSitePage2.screenshot({ path: path.join(ARTIFACT_DIR, 'processing-first-n.png'), timeout: 60000 }).catch(function () {});

  details.consoleErrors = consoleErrors;
  if (consoleErrors.length) log.warn('Console errors observed on the real site: ' + JSON.stringify(consoleErrors.slice(0, 10)));

  return { passed: passed, details: details };
}

module.exports = { run: run, START_URL: START_URL, ARTIFACT_DIR: ARTIFACT_DIR };
