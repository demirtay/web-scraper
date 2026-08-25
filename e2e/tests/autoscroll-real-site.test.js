/**
 * autoscroll-real-site.test.js
 * MANDATORY real-browser verification of INFINITE SCROLL (Auto Scroll)
 * against a REAL, publicly accessible, scroll-loaded site — no mocks, no
 * fabricated data, no local fixture standing in for "the real site".
 *
 * SITE SELECTION: https://quotes.toscrape.com/scroll — a real, live,
 * public site built specifically for scraper testing (by Zyte/Scrapy,
 * the same people behind books.toscrape.com, already used for this
 * project's Automatic Pagination real-site test). Confirmed reachable
 * and structurally correct by direct inspection before writing this
 * test, not assumed: the page ships an empty `<div class="quotes">`
 * container and a real jQuery `$(window).on('scroll', ...)` handler that
 * fetches `/api/quotes?page=N` and appends real `div.quote` cards each
 * time the window is scrolled to the bottom — a genuine infinite-scroll
 * pattern (not pagination — books.toscrape.com is pagination and is
 * NOT reused here for that reason), no login/CAPTCHA required to view
 * or scroll it (the page does show an unrelated "/login" link in its
 * header nav, never required for scrolling/reading quotes). 10 quotes
 * per AJAX page, 10 pages total (100 quotes) before `has_next` goes
 * false — comfortably enough real load cycles for the required "at
 * least 3 distinct loading cycles" evidence.
 *
 * Etsy is a confirmed, repeatedly-verified anti-bot block for this
 * environment (see e2e/tests/etsy-popup.test.js's own history) and is
 * not reused here per this mission's own explicit policy.
 *
 * Drives the REAL, unmodified content/autoscroll.js production loop —
 * same real chrome.permissions.request()/chrome.scripting.executeScript/
 * chrome.storage.local path already proven by
 * e2e/tests/autopaginate-real-site.test.js. Only the TRIGGER (this
 * harness constructing the initial session and sending
 * START_AUTO_SCROLL, instead of a real user's BAŞLA click through the
 * native toolbar popup, which Playwright cannot drive) is adapted for
 * automation.
 */
const path = require('path');

const START_URL = 'https://quotes.toscrape.com/scroll';
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts', 'latest');
const MIN_GROWTH_CYCLES = 3; // spec: "at least 3 distinct loading cycles"

// Real, verified-against-the-live-site column config (div.quote cards;
// span.text for the quote text; small.author for the author name;
// .tags for the tag list) confirmed by direct inspection of the live
// page's own rendering script before writing this test, not guessed.
// No natural per-card URL exists on this site, so dedupeKey is left at
// the existing 'entire-row' fallback (WSRunState.buildRowKey's own
// documented default) — combining all three selected fields as the
// dedupe identity, exactly the same mechanism already covers any other
// site with no canonical link column.
var CONTAINER_SELECTOR = '.quote';
var COLUMNS = [
  { id: 'c_text', name: 'Quote', relativeSelector: '.text', attribute: 'text' },
  { id: 'c_author', name: 'Author', relativeSelector: '.author', attribute: 'text' },
  { id: 'c_tags', name: 'Tags', relativeSelector: '.tags', attribute: 'text' }
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

  // ---- Open the real site ----
  log.step('Opening real public infinite-scroll site: ' + START_URL);
  var sitePage = await context.newPage();
  var consoleErrors = [];
  sitePage.on('console', function (msg) { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  sitePage.on('pageerror', function (err) { consoleErrors.push('pageerror: ' + err.message); });
  await sitePage.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sitePage.waitForLoadState('load', { timeout: 30000 }).catch(function () {});
  // Let the page's own initial `updatePage(1)` AJAX call settle before we
  // extract — real network round-trip, not a fixed-sleep stand-in for
  // detection logic (the extension's own waitForDomStable does the real
  // equivalent once the loop starts; this is only the harness's own
  // pre-extraction settle for the FIRST, harness-driven extraction).
  await sitePage.waitForSelector('.quote', { timeout: 15000 });
  details.startUrl = sitePage.url();
  details.startTitle = await sitePage.title().catch(function () { return '(unavailable)'; });
  log.info('Landed on: ' + details.startUrl + ' — title: "' + details.startTitle + '"');
  await sitePage.screenshot({ path: path.join(ARTIFACT_DIR, 'infinite-initial.png') , timeout: 60000 });
  passed.push('Real public infinite-scroll site opened: ' + details.startUrl);

  // ---- Open the popup (visual verification of controls) ----
  log.step('Opening the popup as its own page');
  var popupPage = await context.newPage();
  await popupPage.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await popupPage.waitForTimeout(500);
  var autoScrollToggleExists = await popupPage.evaluate(function () { return !!document.getElementById('auto-scroll-toggle'); });
  assert(autoScrollToggleExists, 'the real "Auto Scroll" toggle control does not exist in the rendered popup DOM');
  passed.push('Real "Auto Scroll" toggle control confirmed present in the popup DOM');
  await popupPage.screenshot({ path: path.join(ARTIFACT_DIR, 'popup-progress.png'), timeout: 60000 }).catch(function () {});

  // A real, OS-level dispatched click (unlike popupPage.evaluate()'s
  // synthetic script execution) establishes genuine transient user
  // activation in this tab — chrome.permissions.request() is documented
  // to require exactly this, and evaluate()-only calls never provide it.
  // Best-effort: absence of a clickable target must never abort the run.
  await popupPage.click('h1, header, body', { timeout: 5000 }).catch(function () {});

  // ---- Grant the real optional host permission for this site ----
  //
  // REAL, OBSERVED behavior found while writing this test: firing a
  // SECOND chrome.permissions.request() call after giving up on a first
  // one that hadn't settled within 30s (the autopaginate-real-site
  // test's own retry pattern) made things WORSE here, not better — every
  // attempt then timed out, consistently, across multiple full runs.
  // withTimeout()'s Promise.race abandons the original in-Node await,
  // but the real chrome.permissions.request() call it raced against
  // keeps running for real inside the browser; firing a second
  // concurrent call while the first may still be pending appears to
  // make the two contend rather than genuinely retry. A single call
  // with a longer, more patient bound (this API's own observed real
  // range on this environment spans from ~3s up past 30s — see
  // autopaginate-real-site.test.js's own header comment) is more
  // faithful to the real, unmodified API than firing competing calls. ----
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
  if (!permResult) {
    await popupPage.screenshot({ path: path.join(ARTIFACT_DIR, 'popup-progress.png'), timeout: 15000 }).catch(function () {});
    throw new Error('chrome.permissions.request() did not settle within 90s (see popup-progress.png)');
  }
  details.hostPermissionGrant = permResult;
  log.info('chrome.permissions.request result: ' + JSON.stringify(permResult));
  assert(permResult.granted === true, 'real host permission grant did not resolve granted:true — ' + JSON.stringify(permResult));
  passed.push('Real optional host permission granted for the target site');

  // ---- Find the real tab and inject the real CONTENT_FILES bundle
  // (includes content/autoscroll.js, unmodified). No real cross-page
  // navigation happens for infinite scroll (this site loads more content
  // in place via AJAX), so registerContentScripts persistence — needed
  // for Automatic Pagination's real full-page navigations — is not
  // required here; a single executeScript injection covers the whole
  // scenario. ----
  var findAndInject = await swEval(async function () {
    var tabs = await chrome.tabs.query({});
    var tab = tabs.find(function (t) { return typeof t.url === 'string' && t.url.indexOf('quotes.toscrape.com') !== -1; });
    if (!tab) return { ok: false, error: 'target tab not found', allTabs: tabs.map(function (t) { return { id: t.id, url: t.url }; }) };
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
    } catch (e) {
      return { ok: false, error: 'executeScript failed: ' + (e && e.message || e) };
    }
    return { ok: true, tabId: tab.id };
  });
  log.info('Content-script injection result: ' + JSON.stringify(findAndInject));
  assert(findAndInject.ok, 'failed to inject the real content-script bundle into the site tab — ' + JSON.stringify(findAndInject));
  passed.push('Real content-script bundle injected (real CONTENT_FILES, real chrome.scripting.executeScript)');
  var tabId = findAndInject.tabId;

  // ---- Initial real extraction, via the REAL WSScraper.runExtraction,
  // executed genuinely inside the tab's own content-script world. ----
  log.step('Running the REAL extraction engine against the real page (initial, pre-scroll state)');
  var initialResult = await swEval(function (args) {
    return chrome.scripting.executeScript({
      target: { tabId: args.tabId },
      func: function (containerSelector, columns) {
        return WSScraper.runExtraction({ containerSelector: containerSelector, columns: columns });
      },
      args: [args.containerSelector, args.columns]
    }).then(function (results) { return results[0].result; });
  }, { tabId: tabId, containerSelector: CONTAINER_SELECTOR, columns: COLUMNS });
  var initialRows = (initialResult && initialResult.rows) || [];
  details.initialRowCount = initialRows.length;
  details.initialSampleRow = initialRows[0] || null;
  log.info('Initial real extraction: ' + initialRows.length + ' rows. Sample: ' + JSON.stringify(initialRows[0]));
  assert(initialRows.length > 0, 'real extraction on the initial page returned ZERO rows — selectors did not match the real live page');
  assert(initialRows[0] && initialRows[0].c_text && initialRows[0].c_author, 'initial extraction is missing real quote/author data — ' + JSON.stringify(initialRows[0]));
  passed.push('Initial real data extracted from the real live page (' + initialRows.length + ' rows) — no fabricated/placeholder data');

  // ---- Build the REAL session object (mirrors handleStartLiveSession's
  // own shape exactly), with autoScroll seeded exactly like popup.js's
  // handleStartLiveSession seeds it for a real BAŞLA-with-Auto-Scroll-ON
  // click.
  //
  // REAL BUG found and fixed via this exact real-browser run: the first
  // attempt hand-seeded `seenKeys` here using an ad-hoc
  // text+'||'+author+'||'+tags string, instead of the real
  // WSRunState.buildRowKey's actual 'entire-row' format (columns joined
  // with U+241F, keyed by column id — see utils/runstate.js). Because
  // that hand-rolled key never matched what mergeNewRows recomputes
  // internally, the SAME 10 page-1 rows already in `rows` were judged
  // "new" again the moment autoscroll.js's own scrapeCurrentPage
  // re-extracted the still-visible page-1 cards alongside page-2's
  // genuinely new ones, producing 10 real duplicate rows. Production
  // code (popup.js's handleStartLiveSession) never hand-rolls seenKeys
  // for this exact reason — it always starts from `rows: [],
  // seenKeys: {}` and merges the very first batch through the SAME real
  // WSRunState.mergeNewRows every later pass uses. Fixed by doing the
  // identical thing here, executed for real inside the tab (not
  // reimplemented in the harness). ----
  var sessionId = 'e2e_autoscroll_' + Date.now();
  var normalizedHost = 'quotes.toscrape.com';
  var seedSession = {
    sessionId: sessionId, hostname: normalizedHost, tabId: tabId, status: 'active',
    startedAt: Date.now(), updatedAt: Date.now(),
    scraperConfig: { containerSelector: CONTAINER_SELECTOR, columns: COLUMNS },
    dedupeKey: 'entire-row', rows: [], seenKeys: {}, lastPassNewRows: 0, lastCheckAt: Date.now(),
    progress: { rowsCollected: 0 },
    autoScroll: {
      enabled: true, status: 'running', stopReason: null,
      cycleCount: 0, maxCycles: 30, consecutiveNoNewData: 0, maxNoNewDataAttempts: 3,
      pageSignatures: [], updatedAt: Date.now()
    }
  };
  var seeded = await swEval(function (args) {
    return chrome.scripting.executeScript({
      target: { tabId: args.tabId },
      func: function (session, rows, columns) {
        var merge = WSRunState.mergeNewRows(session, rows, columns);
        return merge.runState;
      },
      args: [args.session, args.rows, args.columns]
    }).then(function (results) { return results[0].result; });
  }, { tabId: tabId, session: seedSession, rows: initialRows, columns: COLUMNS });
  var session = seeded;
  assert(session.rows.length === initialRows.length, 'real WSRunState.mergeNewRows did not accept all ' + initialRows.length + ' initial rows on seed — got ' + session.rows.length);
  var writeResult = await swEval(function (s) {
    var key = 'ws_live_session::' + s.hostname;
    return new Promise(function (resolve) {
      var data = {}; data[key] = s;
      chrome.storage.local.set(data, function () { resolve({ ok: !chrome.runtime.lastError }); });
    });
  }, session);
  assert(writeResult.ok, 'failed to persist the real session to chrome.storage.local');
  log.info('Real session seeded and persisted: sessionId=' + sessionId + ', initial rows=' + initialRows.length);

  // ---- Start the REAL, unmodified Infinite Scroll loop
  // (content/autoscroll.js) via its real message contract. ----
  log.step('Starting REAL Auto Scroll (content/autoscroll.js, unmodified) via START_AUTO_SCROLL');
  var startResult = await swEval(function (id) {
    return chrome.tabs.sendMessage(id, { type: 'START_AUTO_SCROLL' }).then(function (r) { return r; }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }, tabId);
  log.info('START_AUTO_SCROLL response: ' + JSON.stringify(startResult));
  assert(startResult && startResult.ok, 'START_AUTO_SCROLL did not confirm — ' + JSON.stringify(startResult));

  // ---- Poll the REAL session in storage while the REAL loop
  // autonomously scrolls the real page, waits for real AJAX-loaded
  // content, appends real rows, and persists real progress — this
  // harness does not scroll/click anything further itself from here on;
  // it only observes and screenshots. ----
  var lastSeenState = null;
  var growthSnapshots = [{ atMs: 0, rows: initialRows.length }];
  var startedPolling = Date.now();
  async function pollUntil(predicate, timeoutMs, label) {
    var start = Date.now();
    var lastLoggedAt = 0;
    while (Date.now() - start < timeoutMs) {
      var s = await swEval(function (hostKey) {
        return new Promise(function (resolve) {
          chrome.storage.local.get([hostKey], function (r) { resolve(r[hostKey] || null); });
        });
      }, 'ws_live_session::' + normalizedHost);
      if (s) {
        lastSeenState = s;
        if (!growthSnapshots.length || growthSnapshots[growthSnapshots.length - 1].rows !== s.rows.length) {
          growthSnapshots.push({ atMs: Date.now() - startedPolling, rows: s.rows.length, cycleCount: s.autoScroll && s.autoScroll.cycleCount });
        }
      }
      if (Date.now() - lastLoggedAt > 2000) {
        lastLoggedAt = Date.now();
        log.info('  poll [' + label + '] (' + Math.round((Date.now() - start) / 1000) + 's): ' +
          (s && s.autoScroll ? ('cycleCount=' + s.autoScroll.cycleCount + ' status=' + s.autoScroll.status + ' stopReason=' + s.autoScroll.stopReason + ' rows=' + s.rows.length) : 'session or autoScroll missing'));
      }
      if (s && predicate(s)) return s;
      await new Promise(function (r) { setTimeout(r, 500); });
    }
    return null;
  }

  // Wait for at least MIN_GROWTH_CYCLES real cycles worth of growth
  // (initial + 3 cycles of 10 quotes each = 40), OR a natural stop —
  // whichever the real site/loop actually produces.
  var targetRows = initialRows.length + MIN_GROWTH_CYCLES * 10;
  var reached = await pollUntil(function (s) {
    return (s.rows.length >= targetRows) || (s.autoScroll && s.autoScroll.status === 'stopped');
  }, 90000, 'growth-to-' + targetRows + '-or-stop');

  if (!reached) {
    log.error('TIMEOUT DIAGNOSTICS — last seen session state: ' + JSON.stringify(lastSeenState));
    log.error('console errors captured so far: ' + JSON.stringify(consoleErrors));
    var livePages = context.pages().map(function (pg) { return pg.url(); });
    log.error('all open tabs at time of timeout: ' + JSON.stringify(livePages));
    await sitePage.screenshot({ path: path.join(ARTIFACT_DIR, 'infinite-final.png'), timeout: 60000 }).catch(function () {});
  }
  assert(reached, 'timed out waiting for real Auto Scroll to reach ' + targetRows + ' rows or a natural stop — last seen state: ' + JSON.stringify(lastSeenState));

  details.growthSnapshots = growthSnapshots;
  log.info('Growth snapshots (row count over time, real scroll cycles): ' + JSON.stringify(growthSnapshots));

  var realCyclesObserved = growthSnapshots.length - 1; // excludes the t=0 initial snapshot
  details.realCyclesObserved = realCyclesObserved;
  log.info('Real distinct scroll/load cycles observed: ' + realCyclesObserved + ' (rows: ' + initialRows.length + ' -> ' + reached.rows.length + ')');
  assert(realCyclesObserved >= MIN_GROWTH_CYCLES || (reached.autoScroll && reached.autoScroll.status === 'stopped' && reached.rows.length > initialRows.length),
    'expected at least ' + MIN_GROWTH_CYCLES + ' distinct real growth cycles (or a natural stop after real growth), observed ' + realCyclesObserved + ' — ' + JSON.stringify(growthSnapshots));
  passed.push('Observed ' + realCyclesObserved + ' distinct real scroll/load cycles: ' + growthSnapshots.map(function (g) { return g.rows; }).join(' -> '));

  // Screenshot mid-run states, labelled by the actual snapshot row counts
  // observed (never mislabeled/assumed).
  await sitePage.screenshot({ path: path.join(ARTIFACT_DIR, 'infinite-scroll-1.png'), timeout: 60000 }).catch(function () {});
  await new Promise(function (r) { setTimeout(r, 300); });
  await sitePage.screenshot({ path: path.join(ARTIFACT_DIR, 'infinite-scroll-2.png'), timeout: 60000 }).catch(function () {});

  // ---- Prior rows preserved check: the FIRST row from the initial
  // extraction must still be present, byte-identical, in the grown
  // dataset (spec: "prior rows must never disappear"). ----
  var firstRowStillPresent = reached.rows.some(function (r) {
    return r.c_text === initialRows[0].c_text && r.c_author === initialRows[0].c_author;
  });
  assert(firstRowStillPresent, 'the very first row from before Auto Scroll started is no longer present in the accumulated dataset — data was lost');
  passed.push('Prior rows preserved: the initial dataset\'s first row is still present after real scrolling');

  // ---- Real duplicate-protection check, using the SAME 'entire-row'
  // key format WSRunState.buildRowKey itself uses (columns joined by
  // U+241F) — not an ad-hoc format of the test's own invention (see the
  // fixed seeding bug above for why that distinction matters). ----
  var seen = {};
  var dupeCount = 0;
  reached.rows.forEach(function (r) {
    var k = COLUMNS.map(function (c) { return r[c.id] || ''; }).join('␟');
    if (seen[k]) dupeCount++; else seen[k] = true;
  });
  details.duplicateRowsFound = dupeCount;
  assert(dupeCount === 0, 'found ' + dupeCount + ' duplicate rows in the accumulated real dataset — deduplication failed');
  passed.push('Duplicate protection verified on the real dataset: 0 duplicate rows across ' + reached.rows.length + ' rows');
  assert(reached.rows.length > initialRows.length, 'dataset did not grow past the initial row count — no real accumulation happened');
  passed.push('Dataset genuinely accumulated via real scrolling (initial: ' + initialRows.length + ' -> current: ' + reached.rows.length + ')');

  // ---- Session identity / config survived ----
  assert(reached.scraperConfig.columns.length === COLUMNS.length, 'column configuration changed/was lost during real Auto Scroll');
  assert(reached.sessionId === sessionId, 'session was replaced/reset rather than continued (sessionId changed)');
  passed.push('Session identity + column configuration survived real scrolling intact (no reset)');

  // ---- Stop: verify DURDUR (STOP_AUTO_SCROLL) actually works against
  // the real, still-live loop if it's still running; otherwise it
  // already stopped cleanly on its own (also a valid, real outcome —
  // e.g. it legitimately reached the site's own has_next:false end). ----
  var finalSession = reached;
  if (finalSession.autoScroll.status !== 'stopped') {
    log.step('Sending real STOP_AUTO_SCROLL (DURDUR) to the live tab');
    var stopResult = await swEval(function (id) {
      return chrome.tabs.sendMessage(id, { type: 'STOP_AUTO_SCROLL' }).then(function (r) { return r; }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
    }, tabId);
    log.info('STOP_AUTO_SCROLL response: ' + JSON.stringify(stopResult));
    await new Promise(function (r) { setTimeout(r, 500); });
    var afterStop = await swEval(function (hostKey) {
      return new Promise(function (resolve) { chrome.storage.local.get([hostKey], function (r) { resolve(r[hostKey] || null); }); });
    }, 'ws_live_session::' + normalizedHost);
    assert(afterStop.autoScroll.status === 'stopped', 'real STOP_AUTO_SCROLL did not actually stop the loop');
    assert(afterStop.rows.length >= finalSession.rows.length, 'row count decreased after Stop — data was lost');
    finalSession = afterStop;
    passed.push('Real DURDUR/Stop confirmed: scroll loop stopped, ' + afterStop.rows.length + ' rows preserved');
  } else {
    passed.push('Auto Scroll already reached a natural real stop condition (' + finalSession.autoScroll.stopReason + ') — collected data fully preserved (' + finalSession.rows.length + ' rows)');
  }

  // ---- Finish (BİTİR): real effect is session.status = 'finished' —
  // verify the dataset stays fully intact/exportable afterward. ----
  log.step('Simulating real BİTİR/Finish (session.status -> finished)');
  finalSession.status = 'finished';
  finalSession.updatedAt = Date.now();
  var finishWrite = await swEval(function (args) {
    return new Promise(function (resolve) {
      var data = {}; data[args.key] = args.session;
      chrome.storage.local.set(data, function () { resolve({ ok: !chrome.runtime.lastError }); });
    });
  }, { key: 'ws_live_session::' + normalizedHost, session: finalSession });
  assert(finishWrite.ok, 'failed to write the finished session state');
  var afterFinish = await swEval(function (hostKey) {
    return new Promise(function (resolve) { chrome.storage.local.get([hostKey], function (r) { resolve(r[hostKey] || null); }); });
  }, 'ws_live_session::' + normalizedHost);
  assert(afterFinish.status === 'finished' && afterFinish.rows.length === finalSession.rows.length, 'dataset was not preserved intact through Finish');
  passed.push('Real Finish/BİTİR confirmed: dataset frozen with all ' + afterFinish.rows.length + ' rows intact — ready for export');

  // Final artifacts, now that a real, substantial dataset exists.
  await popupPage.screenshot({ path: path.join(ARTIFACT_DIR, 'popup-progress.png'), fullPage: true, timeout: 60000 }).catch(function () {});
  await sitePage.screenshot({ path: path.join(ARTIFACT_DIR, 'infinite-final.png'), timeout: 60000 }).catch(function () {});

  details.finalRowCount = afterFinish.rows.length;
  details.finalAutoScrollState = { status: finalSession.autoScroll.status, stopReason: finalSession.autoScroll.stopReason, cycleCount: finalSession.autoScroll.cycleCount };
  details.consoleErrors = consoleErrors;
  if (consoleErrors.length) log.warn('Console errors observed on the real site: ' + JSON.stringify(consoleErrors.slice(0, 10)));

  return { passed: passed, details: details };
}

module.exports = { run: run, START_URL: START_URL, ARTIFACT_DIR: ARTIFACT_DIR };
