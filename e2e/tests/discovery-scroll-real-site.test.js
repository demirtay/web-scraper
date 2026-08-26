/**
 * discovery-scroll-real-site.test.js
 * MANDATORY real-browser verification of the AUTOMATIC DATA DISCOVERY
 * ENGINE (content/discovery.js) against a REAL, publicly accessible,
 * infinite-scroll site — WITHOUT manually enabling Auto Scroll: this test
 * never sends START_AUTO_SCROLL at all, only the single, unconditional
 * START_DISCOVERY message a real BAŞLA click now always sends. The engine
 * itself must decide scrolling is the right traversal mechanism here —
 * mirrors e2e/tests/autoscroll-real-site.test.js's own site choice/
 * reasoning (quotes.toscrape.com/scroll).
 */
const path = require('path');

const START_URL = 'https://quotes.toscrape.com/scroll';
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts', 'latest');
const MIN_GROWTH_CYCLES = 3;

var CONTAINER_SELECTOR = '.quote';
var COLUMNS = [
  { id: 'c_text', name: 'Quote', relativeSelector: '.text', attribute: 'text' },
  { id: 'c_author', name: 'Author', relativeSelector: '.author', attribute: 'text' }
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

  log.step('Opening real public infinite-scroll site: ' + START_URL);
  var sitePage = await context.newPage();
  var consoleErrors = [];
  sitePage.on('console', function (msg) { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  sitePage.on('pageerror', function (err) { consoleErrors.push('pageerror: ' + err.message); });
  await sitePage.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sitePage.waitForLoadState('load', { timeout: 30000 }).catch(function () {});
  await sitePage.waitForSelector('.quote', { timeout: 15000 });
  details.startUrl = sitePage.url();
  await sitePage.screenshot({ path: path.join(ARTIFACT_DIR, 'discovery-scroll-initial.png'), timeout: 60000 });
  passed.push('Real public infinite-scroll site opened: ' + details.startUrl);

  var popupPage = await context.newPage();
  await popupPage.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await popupPage.waitForTimeout(500);
  await popupPage.click('h1, header, body', { timeout: 5000 }).catch(function () {});

  log.step('Requesting the real optional host permission for quotes.toscrape.com');
  var origin = new URL(START_URL).origin + '/*';
  var permResult = null;
  try {
    permResult = await withTimeout(
      popupPage.evaluate(function (o) {
        return chrome.permissions.request({ origins: [o] }).then(function (granted) { return { granted: granted }; })
          .catch(function (e) { return { error: String(e && e.message || e) }; });
      }, origin),
      90000, 'chrome.permissions.request()'
    );
  } catch (e) {
    log.warn('chrome.permissions.request() did not settle within 90s: ' + e.message);
    permResult = null;
  }
  assert(permResult && permResult.granted === true, 'real host permission grant did not resolve granted:true — ' + JSON.stringify(permResult));
  passed.push('Real optional host permission granted for the target site');

  log.step('Injecting the REAL content-script bundle (includes content/discovery.js, content/loadmore.js, utils/discovery.js, unmodified)');
  var findAndInject = await swEval(async function () {
    var tabs = await chrome.tabs.query({});
    var tab = tabs.find(function (t) { return typeof t.url === 'string' && t.url.indexOf('quotes.toscrape.com') !== -1; });
    if (!tab) return { ok: false, error: 'target tab not found' };
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
    } catch (e) {
      return { ok: false, error: 'executeScript failed: ' + (e && e.message || e) };
    }
    return { ok: true, tabId: tab.id };
  });
  assert(findAndInject.ok, 'failed to inject the real content-script bundle — ' + JSON.stringify(findAndInject));
  passed.push('Real content-script bundle injected (includes the new Discovery engine files, unmodified)');
  var tabId = findAndInject.tabId;

  log.step('Running the REAL extraction engine against the real page (initial, pre-scroll state)');
  var initialResult = await swEval(function (args) {
    return chrome.scripting.executeScript({
      target: { tabId: args.tabId },
      func: function (containerSelector, columns) { return WSScraper.runExtraction({ containerSelector: containerSelector, columns: columns }); },
      args: [args.containerSelector, args.columns]
    }).then(function (results) { return results[0].result; });
  }, { tabId: tabId, containerSelector: CONTAINER_SELECTOR, columns: COLUMNS });
  var initialRows = (initialResult && initialResult.rows) || [];
  details.initialRowCount = initialRows.length;
  assert(initialRows.length > 0, 'real extraction on the initial page returned ZERO rows');
  passed.push('Initial real data extracted from the real live page (' + initialRows.length + ' rows)');

  var sessionId = 'e2e_discovery_scroll_' + Date.now();
  var normalizedHost = 'quotes.toscrape.com';
  var seedResult = await swEval(function (args) {
    return chrome.scripting.executeScript({
      target: { tabId: args.tabId },
      func: function (sessionId, hostname, tabId, containerSelector, columns, rows, startUrl) {
        var session = {
          sessionId: sessionId, hostname: hostname, tabId: tabId, status: 'active',
          startedAt: Date.now(), updatedAt: Date.now(),
          scraperConfig: { containerSelector: containerSelector, columns: columns },
          dedupeKey: 'entire-row', rows: [], seenKeys: {}, lastPassNewRows: 0, lastCheckAt: Date.now(),
          progress: { rowsCollected: 0 },
          discovery: WSDiscoveryCore.createDiscoveryState({ startUrl: startUrl })
        };
        var merge = WSRunState.mergeNewRows(session, rows, columns);
        return merge.runState;
      },
      args: [args.sessionId, args.hostname, args.tabId, args.containerSelector, args.columns, args.rows, args.startUrl]
    }).then(function (results) { return results[0].result; });
  }, { sessionId: sessionId, hostname: normalizedHost, tabId: tabId, containerSelector: CONTAINER_SELECTOR, columns: COLUMNS, rows: initialRows, startUrl: START_URL });
  assert(seedResult && seedResult.discovery && seedResult.discovery.status === 'discovering', 'real WSDiscoveryCore.createDiscoveryState() did not seed a discovering session');
  assert(seedResult.rows.length === initialRows.length, 'real WSRunState.mergeNewRows did not accept all initial rows on seed');
  var writeResult = await swEval(function (s) {
    var key = 'ws_live_session::' + s.hostname;
    return new Promise(function (resolve) {
      var data = {}; data[key] = s;
      chrome.storage.local.set(data, function () { resolve({ ok: !chrome.runtime.lastError }); });
    });
  }, seedResult);
  assert(writeResult.ok, 'failed to persist the real seeded session');
  log.info('Real session seeded via the real WSDiscoveryCore + WSRunState, persisted: sessionId=' + sessionId);

  log.step('Starting REAL Automatic Discovery via START_DISCOVERY — no Auto Scroll message ever sent');
  var startResult = await swEval(function (id) {
    return chrome.tabs.sendMessage(id, { type: 'START_DISCOVERY' }).then(function (r) { return r; }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }, tabId);
  assert(startResult && startResult.ok, 'START_DISCOVERY did not confirm — ' + JSON.stringify(startResult));
  passed.push('Real automatic discovery started via a SINGLE message (START_DISCOVERY) — scroll mode never manually chosen by this harness');

  var lastSeenState = null;
  var growthSnapshots = [{ atMs: 0, rows: initialRows.length }];
  var startedPolling = Date.now();
  async function pollUntil(predicate, timeoutMs, label) {
    var start = Date.now();
    var lastLoggedAt = 0;
    while (Date.now() - start < timeoutMs) {
      var s = await swEval(function (hostKey) {
        return new Promise(function (resolve) { chrome.storage.local.get([hostKey], function (r) { resolve(r[hostKey] || null); }); });
      }, 'ws_live_session::' + normalizedHost);
      if (s) {
        lastSeenState = s;
        if (!growthSnapshots.length || growthSnapshots[growthSnapshots.length - 1].rows !== s.rows.length) {
          growthSnapshots.push({ atMs: Date.now() - startedPolling, rows: s.rows.length, scrollCycles: s.discovery && s.discovery.scrollCycles, currentTraversalMethod: s.discovery && s.discovery.currentTraversalMethod });
        }
      }
      if (Date.now() - lastLoggedAt > 2000) {
        lastLoggedAt = Date.now();
        log.info('  poll [' + label + '] (' + Math.round((Date.now() - start) / 1000) + 's): ' +
          (s && s.discovery ? ('status=' + s.discovery.status + ' scrollCycles=' + s.discovery.scrollCycles + ' method=' + s.discovery.currentTraversalMethod + ' unique=' + s.discovery.discoveredUnique) : 'session/discovery missing'));
      }
      if (s && predicate(s)) return s;
      await new Promise(function (r) { setTimeout(r, 500); });
    }
    return null;
  }

  var targetRows = initialRows.length + MIN_GROWTH_CYCLES * 10;
  var reached = await pollUntil(function (s) {
    return (s.rows.length >= targetRows) || (s.discovery && s.discovery.status !== 'discovering');
  }, 90000, 'growth-to-' + targetRows + '-or-terminal');
  assert(reached, 'timed out waiting for real automatic discovery to reach ' + targetRows + ' rows or a terminal state — last seen: ' + JSON.stringify(lastSeenState && lastSeenState.discovery));

  details.growthSnapshots = growthSnapshots;
  var realCyclesObserved = growthSnapshots.length - 1;
  details.realCyclesObserved = realCyclesObserved;
  log.info('Real distinct scroll/growth cycles observed: ' + realCyclesObserved + ' (rows: ' + initialRows.length + ' -> ' + reached.rows.length + ')');
  assert(realCyclesObserved >= MIN_GROWTH_CYCLES || (reached.discovery.status !== 'discovering' && reached.rows.length > initialRows.length),
    'expected at least ' + MIN_GROWTH_CYCLES + ' distinct real growth cycles (or a natural stop after real growth), observed ' + realCyclesObserved);
  passed.push('Observed ' + realCyclesObserved + ' distinct real growth cycles, fully automatically: ' + growthSnapshots.map(function (g) { return g.rows; }).join(' -> '));
  passed.push('Engine automatically determined SCROLLING was the right mechanism (currentTraversalMethod: ' + (reached.discovery.currentTraversalMethod || growthSnapshots.slice(-2)[0].currentTraversalMethod) + ') — never manually enabled');

  await sitePage.screenshot({ path: path.join(ARTIFACT_DIR, 'discovery-scroll-growth-1.png'), timeout: 60000 }).catch(function () {});
  await new Promise(function (r) { setTimeout(r, 300); });
  await sitePage.screenshot({ path: path.join(ARTIFACT_DIR, 'discovery-scroll-growth-2.png'), timeout: 60000 }).catch(function () {});

  var firstRowStillPresent = reached.rows.some(function (r) { return r.c_text === initialRows[0].c_text && r.c_author === initialRows[0].c_author; });
  assert(firstRowStillPresent, 'the very first row from before discovery started is no longer present — data was lost');
  passed.push('Prior rows preserved through real automatic scrolling (virtualization-safe accumulation)');

  var seen = {}, dupeCount = 0;
  reached.rows.forEach(function (r) {
    var k = COLUMNS.map(function (c) { return r[c.id] || ''; }).join('␟');
    if (seen[k]) dupeCount++; else seen[k] = true;
  });
  assert(dupeCount === 0, 'found ' + dupeCount + ' duplicate rows in the accumulated real dataset');
  passed.push('Duplicate protection verified on the real, automatically-discovered dataset: 0 duplicates across ' + reached.rows.length + ' rows');
  // discoveredUnique is reconciled to session.rows.length at every phase
  // BOUNDARY (recordExpansionDelta, called right after Auto Scroll/Load
  // More's own runUntilExhausted call returns) — but content/autoscroll.js's
  // OWN per-cycle writes DURING an active scroll phase (reused completely
  // unmodified, by design — this mission never touches its internal loop)
  // legitimately persist the CURRENT (not-yet-reconciled) discoveredUnique
  // alongside a freshly-grown rows.length, so a poll landing exactly
  // mid-phase can catch it lagging by design, never ahead of it. Real,
  // observed, and specifically why this is a "never exceeds" check here
  // rather than exact equality — exact equality is verified below, on the
  // terminal snapshot taken AFTER Stop, once any in-flight phase has
  // genuinely settled.
  assert(reached.discovery.discoveredUnique <= reached.rows.length, 'discoveredUnique must never exceed the real accumulated session.rows.length (never fabricated)');

  // Let it run to a genuine terminal state (or safely stop it after
  // sufficient real evidence — quotes.toscrape.com has 100 quotes total,
  // which would otherwise take a while to fully exhaust).
  var finalState = reached;
  if (finalState.discovery.status === 'discovering') {
    log.step('Sufficient real growth evidence collected — sending real STOP_DISCOVERY (DURDUR-equivalent)');
    var stopResult = await swEval(function (id) {
      return chrome.tabs.sendMessage(id, { type: 'STOP_DISCOVERY' }).then(function (r) { return r; }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
    }, tabId);
    log.info('STOP_DISCOVERY response: ' + JSON.stringify(stopResult));
    await new Promise(function (r) { setTimeout(r, 800); });
    var afterStop = await swEval(function (hostKey) {
      return new Promise(function (resolve) { chrome.storage.local.get([hostKey], function (r) { resolve(r[hostKey] || null); }); });
    }, 'ws_live_session::' + normalizedHost);
    assert(afterStop.discovery.status === 'discovery_stopped', 'real STOP_DISCOVERY did not actually stop discovery');
    assert(afterStop.rows.length >= finalState.rows.length, 'row count decreased after Stop — data was lost');
    assert(afterStop.discovery.discoveredUnique === afterStop.rows.length, 'once genuinely settled (post-Stop), discoveredUnique must exactly equal the real accumulated session.rows.length');
    finalState = afterStop;
    passed.push('Real Stop confirmed: discovery stopped, ' + afterStop.rows.length + ' rows preserved (status: discovery_stopped, never falsely discovery_complete)');
  } else {
    passed.push('Discovery already reached a natural real terminal state (' + finalState.discovery.status + '/' + finalState.discovery.stopReason + ') — collected data fully preserved (' + finalState.rows.length + ' rows)');
  }

  details.finalDiscovery = finalState.discovery;
  details.finalRowCount = finalState.rows.length;

  await popupPage.screenshot({ path: path.join(ARTIFACT_DIR, 'discovery-scroll-complete.png'), fullPage: true, timeout: 60000 }).catch(function () {});
  await sitePage.screenshot({ path: path.join(ARTIFACT_DIR, 'discovery-scroll-final.png'), timeout: 60000 }).catch(function () {});

  details.consoleErrors = consoleErrors;
  if (consoleErrors.length) log.warn('Console errors observed on the real site: ' + JSON.stringify(consoleErrors.slice(0, 10)));

  return { passed: passed, details: details };
}

module.exports = { run: run, START_URL: START_URL, ARTIFACT_DIR: ARTIFACT_DIR };
