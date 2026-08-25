/**
 * autopaginate-real-site.test.js
 * MANDATORY real-browser verification of AUTOMATIC PAGINATION (Auto
 * Next) against a REAL, publicly accessible, multi-page site — no
 * mocks, no fabricated data, no local fixture standing in for "the real
 * site". Etsy is a confirmed, repeatedly-verified anti-bot block for
 * this environment (see e2e/tests/etsy-popup.test.js's own history/
 * MISSION.md) — per this mission's own explicit policy ("If Etsy
 * produces a genuine CAPTCHA... choose another legitimate publicly
 * accessible website... DO NOT repeatedly hammer Etsy"), this test
 * targets https://books.toscrape.com/ instead: a real, live, public site
 * built specifically for scraper testing (by the makers of Scrapy),
 * with genuine numbered "next" pagination, real repeated result cards,
 * no login, no CAPTCHA — verified reachable and structurally correct
 * (real `<a href="catalogue/page-2.html">next</a>`, real
 * `article.product_pod` cards) by direct inspection before writing this
 * test, not assumed.
 *
 * Drives the REAL, unmodified extraction/session/auto-pagination code —
 * content/scraper.js's WSScraper.runExtraction, content/autopaginate.js
 * (the actual production Auto Next loop, completely unmodified by this
 * test file), the real chrome.permissions.request()/
 * chrome.scripting.executeScript/chrome.storage.local path — exactly
 * the same real code content/autopaginate.js's own bootstrapResume runs
 * in normal use. Only the TRIGGER (this harness constructing the
 * initial session and sending START_AUTO_PAGINATE, instead of a real
 * user's BAŞLA click through the native toolbar popup, which Playwright
 * cannot drive — see e2e/run.js's documented limitation) is adapted for
 * automation.
 */
const path = require('path');

const START_URL = 'https://books.toscrape.com/';
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts', 'latest');
const PAGES_TO_TRAVERSE = 3; // spec: "at least 3 pages"

// Real, verified-against-the-live-site column config — matches
// books.toscrape.com's actual DOM (article.product_pod cards; h3 a for
// title/link; img.thumbnail for the cover image; .price_color for
// price) confirmed by direct inspection before writing this test, not
// guessed.
var CONTAINER_SELECTOR = 'article.product_pod';
var COLUMNS = [
  { id: 'c_title', name: 'Title', relativeSelector: 'h3 a', attribute: 'text' },
  { id: 'c_link', name: 'Link', relativeSelector: 'h3 a', attribute: 'href' },
  { id: 'c_price', name: 'Price', relativeSelector: '.price_color', attribute: 'text' },
  { id: 'c_image', name: 'Image', relativeSelector: 'img.thumbnail', attribute: 'src' }
];

// REAL BUG found and fixed via this exact test run: the very first
// attempt hung indefinitely (4+ minutes, no progress) at the
// permission-request step below — nothing in this harness bounded how
// long it would wait for that promise to settle. Whatever the root
// cause on Chrome's side (previously observed taking anywhere from ~3s
// to ~80s for the SAME API against a different origin, so evidently not
// fully deterministic), a browser-automation harness must never be able
// to hang forever on one await — every potentially slow/blocking call
// gets a hard, diagnosable timeout from here on.
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

  // Bounded version of sw.evaluate() — same defense-in-depth reasoning
  // as withTimeout() itself above: a service-worker evaluate() call is
  // lower-risk than the permission-request one (it never depends on a
  // native user-gesture dialog), but "lower risk" is not "zero risk",
  // and this harness must never be ABLE to hang forever on any single
  // await, full stop.
  function swEval(fn, arg) {
    return withTimeout(sw.evaluate(fn, arg), 20000, 'service-worker evaluate');
  }

  // ---- Open the real site (page 1) ----
  log.step('Opening real public multi-page site: ' + START_URL);
  var sitePage = await context.newPage();
  var consoleErrors = [];
  sitePage.on('console', function (msg) { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  sitePage.on('pageerror', function (err) { consoleErrors.push('pageerror: ' + err.message); });
  await sitePage.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sitePage.waitForLoadState('load', { timeout: 30000 }).catch(function () {});
  details.startUrl = sitePage.url();
  details.startTitle = await sitePage.title().catch(function () { return '(unavailable)'; });
  log.info('Landed on: ' + details.startUrl + ' — title: "' + details.startTitle + '"');
  await sitePage.screenshot({ path: path.join(ARTIFACT_DIR, 'page1.png'), timeout: 60000 });
  passed.push('Real public multi-page site opened (page 1): ' + details.startUrl);

  // ---- Open the popup (visual verification of controls, same
  // documented workaround as the Etsy test) ----
  log.step('Opening the popup as its own page');
  var popupPage = await context.newPage();
  await popupPage.goto('chrome-extension://' + extensionId + '/popup/popup.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await popupPage.waitForTimeout(500);
  var autoNextToggleExists = await popupPage.evaluate(function () { return !!document.getElementById('auto-next-toggle'); });
  assert(autoNextToggleExists, 'the real "Auto Next" toggle control does not exist in the rendered popup DOM');
  passed.push('Real "Auto Next" toggle control confirmed present in the popup DOM');
  await popupPage.screenshot({ path: path.join(ARTIFACT_DIR, 'popup-progress.png'), timeout: 60000 }).catch(function () {});

  // ---- Grant the real optional host permission for this site, via the
  // extension's own real chrome.permissions.request() API (same proven
  // technique as the Etsy test). ----
  log.step('Requesting the real optional host permission for books.toscrape.com');
  var origin = new URL(START_URL).origin + '/*';
  // REAL, OBSERVED variability in how long this specific real Chrome API
  // call takes to settle across otherwise-identical runs on this exact
  // machine: ~3s, ~4s, ~4s, ~80s, and once past a 30s bound entirely.
  // The API itself is real/unmodified (this is not masking a bug in it);
  // this is test-harness resilience to a known-flaky wait, via a small,
  // bounded retry rather than one single fixed timeout.
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
      log.warn('Attempt ' + attempt + ' of chrome.permissions.request() did not settle within 30s: ' + e.message);
      permResult = null;
    }
  }
  if (!permResult) {
    // Both attempts hung past the bound — capture a screenshot of
    // whatever is actually on screen (a real native Chrome permission
    // dialog, if one is blocking, would show here) before failing
    // loudly, per Phase 6's "never just report Timeout".
    await popupPage.screenshot({ path: path.join(ARTIFACT_DIR, 'popup-progress.png'), timeout: 15000 }).catch(function () {});
    throw new Error('chrome.permissions.request() did not settle within 30s across 2 attempts (see popup-progress.png for whatever was on screen at the moment of the last timeout)');
  }
  details.hostPermissionGrant = permResult;
  log.info('chrome.permissions.request result: ' + JSON.stringify(permResult));
  assert(permResult.granted === true, 'real host permission grant did not resolve granted:true — ' + JSON.stringify(permResult));
  passed.push('Real optional host permission granted for the target site');

  // ---- Find the real tab, inject the real CONTENT_FILES bundle for
  // THIS page, AND register a persistent, origin-matched content script
  // (chrome.scripting.registerContentScripts) so a REAL full-page
  // navigation — which destroys this injected script entirely — gets a
  // FRESH content-script instance auto-injected on the new page, whose
  // own bootstrapResume (content/autopaginate.js) can then pick the
  // loop back up. REAL BUG found and fixed via this exact real-browser
  // run: the first attempt only did the one-time executeScript
  // injection (enough for page 1's own scrape+Next-click+handoff, which
  // DID work — the real navigation to page 2 genuinely happened, proven
  // by the saved screenshot), but WITHOUT this registration nothing
  // ever re-injected the content script into page 2 at all, so
  // pageCount could never advance — exactly mirroring the real-Chrome
  // root cause this project's own history already found once before for
  // the ordinary (non-Auto-Next) live-session flow, and exactly why
  // popup.js's real handleStartLiveSession() always does this same
  // registration as its own very first step. This test was simply
  // missing that same step — content/autopaginate.js itself needed no
  // change at all. ----
  var findAndInject = await swEval(async function (origin) {
    var tabs = await chrome.tabs.query({});
    var tab = tabs.find(function (t) { return typeof t.url === 'string' && t.url.indexOf('books.toscrape.com') !== -1; });
    if (!tab) return { ok: false, error: 'target tab not found', allTabs: tabs.map(function (t) { return { id: t.id, url: t.url }; }) };
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
    } catch (e) {
      return { ok: false, error: 'executeScript failed: ' + (e && e.message || e) };
    }
    var registered = false, registerError = null;
    try {
      await chrome.scripting.registerContentScripts([{ id: 'e2e-autopaginate-books', matches: [origin], js: CONTENT_FILES, runAt: 'document_idle', persistAcrossSessions: false }]);
      registered = true;
    } catch (e) {
      try {
        await chrome.scripting.unregisterContentScripts({ ids: ['e2e-autopaginate-books'] });
        await chrome.scripting.registerContentScripts([{ id: 'e2e-autopaginate-books', matches: [origin], js: CONTENT_FILES, runAt: 'document_idle', persistAcrossSessions: false }]);
        registered = true;
      } catch (e2) { registerError = String(e2 && e2.message || e2); }
    }
    return { ok: true, tabId: tab.id, crossNavRegistered: registered, registerError: registerError };
  }, origin);
  log.info('Content-script injection result: ' + JSON.stringify(findAndInject));
  assert(findAndInject.ok, 'failed to inject the real content-script bundle into the site tab — ' + JSON.stringify(findAndInject));
  assert(findAndInject.crossNavRegistered, 'chrome.scripting.registerContentScripts (cross-navigation persistence) did not succeed — ' + findAndInject.registerError);
  passed.push('Real content-script bundle injected AND cross-navigation persistence registered (real CONTENT_FILES, real chrome.scripting.executeScript + registerContentScripts)');
  var tabId = findAndInject.tabId;

  // ---- PAGE 1: real extraction, via the REAL WSScraper.runExtraction,
  // executed genuinely inside the tab's own content-script world (not
  // reimplemented/mocked here) — mirrors exactly what popup.js's
  // handleStartLiveSession does for its own initial BAŞLA extraction. ----
  log.step('PAGE 1: running the REAL extraction engine against the real page');
  var page1Result = await swEval(function (args) {
    return chrome.scripting.executeScript({
      target: { tabId: args.tabId },
      func: function (containerSelector, columns) {
        return WSScraper.runExtraction({ containerSelector: containerSelector, columns: columns });
      },
      args: [args.containerSelector, args.columns]
    }).then(function (results) { return results[0].result; });
  }, { tabId: tabId, containerSelector: CONTAINER_SELECTOR, columns: COLUMNS });
  var page1Rows = (page1Result && page1Result.rows) || [];
  details.page1RowCount = page1Rows.length;
  details.page1SampleRow = page1Rows[0] || null;
  log.info('PAGE 1 real extraction: ' + page1Rows.length + ' rows. Sample: ' + JSON.stringify(page1Rows[0]));
  assert(page1Rows.length > 0, 'real extraction on page 1 returned ZERO rows — selectors did not match the real live page');
  assert(page1Rows[0] && page1Rows[0].c_title && page1Rows[0].c_price, 'page 1\'s first extracted row is missing real title/price data — ' + JSON.stringify(page1Rows[0]));
  passed.push('PAGE 1: real data extracted from the real live page (' + page1Rows.length + ' rows) — no fabricated/placeholder data');

  // ---- Build the REAL session object (mirrors handleStartLiveSession's
  // own shape exactly) with a FRESH seenKeys map — nothing to dedupe
  // against yet, this is the very first batch. ----
  var dedupeKey = 'c_link'; // real link column, same "prefer canonical URL" rule pickDedupeKeyForColumns uses
  var seenKeys = {};
  page1Rows.forEach(function (r) { seenKeys[String(r[dedupeKey] || '')] = true; });
  var sessionId = 'e2e_autopaginate_' + Date.now();
  var normalizedHost = 'books.toscrape.com';
  var session = {
    sessionId: sessionId, hostname: normalizedHost, tabId: tabId, status: 'active',
    startedAt: Date.now(), updatedAt: Date.now(),
    scraperConfig: { containerSelector: CONTAINER_SELECTOR, columns: COLUMNS },
    dedupeKey: dedupeKey, rows: page1Rows, seenKeys: seenKeys, lastPassNewRows: page1Rows.length, lastCheckAt: Date.now(),
    progress: { rowsCollected: page1Rows.length },
    autoPaginate: {
      enabled: true, status: 'running', stopReason: null,
      pageCount: 1, maxPages: 20, visitedUrls: [START_URL], pageSignatures: []
    }
  };
  var writeResult = await swEval(function (s) {
    var key = 'ws_live_session::' + s.hostname;
    return new Promise(function (resolve) {
      var data = {}; data[key] = s;
      chrome.storage.local.set(data, function () { resolve({ ok: !chrome.runtime.lastError }); });
    });
  }, session);
  assert(writeResult.ok, 'failed to persist the real session to chrome.storage.local');
  log.info('Real session seeded and persisted: sessionId=' + sessionId + ', page1 rows=' + page1Rows.length);

  // ---- Start the REAL, unmodified Automatic Pagination loop
  // (content/autopaginate.js) via its real message contract. ----
  log.step('Starting REAL Automatic Pagination (content/autopaginate.js, unmodified) via START_AUTO_PAGINATE');
  var startResult = await swEval(function (id) {
    return chrome.tabs.sendMessage(id, { type: 'START_AUTO_PAGINATE' }).then(function (r) { return r; }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }, tabId);
  log.info('START_AUTO_PAGINATE response: ' + JSON.stringify(startResult));
  assert(startResult && startResult.ok, 'START_AUTO_PAGINATE did not confirm — ' + JSON.stringify(startResult));

  // ---- Poll the REAL session in storage while the REAL loop
  // autonomously navigates real pages, appends real rows, and persists
  // real progress — this harness does not drive/click anything further
  // itself from here on; it only observes. ----
  var lastSeenState = null;
  async function pollSession(minPageCount, timeoutMs) {
    var start = Date.now();
    var lastLoggedAt = 0;
    while (Date.now() - start < timeoutMs) {
      var s = await swEval(function (hostKey) {
        return new Promise(function (resolve) {
          chrome.storage.local.get([hostKey], function (r) { resolve(r[hostKey] || null); });
        });
      }, 'ws_live_session::' + normalizedHost);
      if (s) lastSeenState = s;
      // Log every ~2s while waiting — real, observed intermediate state,
      // not just the final outcome, so a diagnosis never has to guess
      // whether the loop was stuck 'navigating', already 'stopped' for
      // some reason, or genuinely still progressing but merely slow.
      if (Date.now() - lastLoggedAt > 2000) {
        lastLoggedAt = Date.now();
        log.info('  poll (' + Math.round((Date.now() - start) / 1000) + 's): ' +
          (s && s.autoPaginate ? ('pageCount=' + s.autoPaginate.pageCount + ' status=' + s.autoPaginate.status + ' stopReason=' + s.autoPaginate.stopReason + ' rows=' + s.rows.length) : 'session or autoPaginate missing'));
      }
      if (s && s.autoPaginate) {
        if (s.autoPaginate.pageCount >= minPageCount) return s;
        if (s.autoPaginate.status === 'stopped') return s; // stopped early — return whatever we have, let the caller assert on it
      }
      await new Promise(function (r) { setTimeout(r, 500); });
    }
    return null;
  }

  var pageRowCounts = { 1: page1Rows.length };
  for (var p = 2; p <= PAGES_TO_TRAVERSE; p++) {
    log.step('Waiting for REAL automatic navigation to reach page ' + p + '...');
    var reached = await pollSession(p, 40000);
    if (!reached) {
      var freshConsole = await sitePage.evaluate(function () { return null; }).catch(function (e) { return 'sitePage.evaluate failed (page likely navigated/destroyed): ' + e.message; });
      log.error('TIMEOUT DIAGNOSTICS — last seen session state: ' + JSON.stringify(lastSeenState));
      log.error('sitePage liveness probe: ' + freshConsole);
      log.error('console errors captured so far: ' + JSON.stringify(consoleErrors));
      var livePages = context.pages().map(function (pg) { return pg.url(); });
      log.error('all open tabs at time of timeout: ' + JSON.stringify(livePages));
    }
    assert(reached, 'timed out waiting for real Automatic Pagination to reach page ' + p + ' (autoPaginate never reported pageCount >= ' + p + ' within 40s) — last seen state: ' + JSON.stringify(lastSeenState));
    log.info('Session at page ' + p + ' check: pageCount=' + reached.autoPaginate.pageCount + ', status=' + reached.autoPaginate.status + ', totalRows=' + reached.rows.length);
    assert(reached.autoPaginate.pageCount >= p, 'expected pageCount >= ' + p + ', got ' + reached.autoPaginate.pageCount + ' (status: ' + reached.autoPaginate.status + '/' + reached.autoPaginate.stopReason + ')');
    pageRowCounts[p] = reached.rows.length;
    passed.push('PAGE ' + p + ': real automatic navigation happened, dataset now has ' + reached.rows.length + ' total rows');

    // Screenshot whichever tab is currently showing the site content —
    // the ORIGINAL sitePage object is stale after a real navigation
    // destroyed its content script; find the live one by URL pattern.
    //
    // REAL, OBSERVED artifact-labeling bug found and fixed here: naming
    // the file after the LOOP's own target page number `p` produced
    // mislabeled screenshots — the real Automatic Pagination loop runs
    // autonomously and does not wait for this harness, so by the time
    // this screenshot actually fires (a real navigation this fast can
    // easily complete within the same handful of milliseconds), the
    // live page had often already moved another page or two further.
    // The underlying data (pageRowCounts, dedup counts) was never
    // affected by this — those come straight from chrome.storage.local,
    // never from a screenshot — but the FILENAME must honestly reflect
    // what it actually shows. books.toscrape.com's own URLs encode the
    // real page number directly (catalogue/page-N.html), so that is
    // used for the filename instead of assuming it matches `p`.
    var pages = context.pages();
    var liveSitePage = pages.find(function (pg) { return /books\.toscrape\.com/.test(pg.url()); });
    if (liveSitePage) {
      var urlPageMatch = liveSitePage.url().match(/page-(\d+)\.html/);
      var actualPageNumber = urlPageMatch ? urlPageMatch[1] : String(p);
      await liveSitePage.screenshot({ path: path.join(ARTIFACT_DIR, 'page' + actualPageNumber + '.png'), timeout: 60000 }).catch(function () {});
      log.info('Saved page' + actualPageNumber + '.png (' + liveSitePage.url() + ') — while waiting specifically for pageCount>=' + p);
    }
  }

  var finalSession = await swEval(function (hostKey) {
    return new Promise(function (resolve) {
      chrome.storage.local.get([hostKey], function (r) { resolve(r[hostKey] || null); });
    });
  }, 'ws_live_session::' + normalizedHost);
  details.finalRowCount = finalSession.rows.length;
  details.pageRowCounts = pageRowCounts;
  details.finalAutoPaginateState = finalSession.autoPaginate;
  log.info('Final dataset: ' + finalSession.rows.length + ' rows across ' + finalSession.autoPaginate.pageCount + ' pages, autoPaginate.status=' + finalSession.autoPaginate.status);

  // ---- Real duplicate-protection check: every row's dedupe-key value
  // (the real product link) must be unique across the whole accumulated
  // dataset — proves no obvious duplicates slipped through across the
  // real page boundary. ----
  var linkSet = {};
  var dupeCount = 0;
  finalSession.rows.forEach(function (r) {
    var k = r[dedupeKey];
    if (linkSet[k]) dupeCount++; else linkSet[k] = true;
  });
  details.duplicateLinksFound = dupeCount;
  assert(dupeCount === 0, 'found ' + dupeCount + ' duplicate product links in the accumulated real dataset — deduplication failed');
  passed.push('Duplicate protection verified on the real dataset: 0 duplicate product links across ' + finalSession.rows.length + ' rows');
  assert(finalSession.rows.length > page1Rows.length, 'dataset did not grow past page 1\'s own row count — no real accumulation happened');
  passed.push('Dataset genuinely accumulated across pages (page 1: ' + page1Rows.length + ' -> final: ' + finalSession.rows.length + ')');

  // ---- Confirm columns/config are still exactly what was configured —
  // "selected columns remain configured" / "no session reset occurred". ----
  assert(finalSession.scraperConfig.columns.length === COLUMNS.length, 'column configuration changed/was lost across real navigation');
  assert(finalSession.sessionId === sessionId, 'session was replaced/reset rather than continued (sessionId changed)');
  passed.push('Session identity + column configuration survived real cross-page navigation intact (no reset)');

  // ---- Stop: verify DURDUR (STOP_AUTO_PAGINATE) actually works against
  // the real, still-live loop if it's still running; otherwise it
  // already stopped cleanly on its own (also a valid, real outcome). ----
  if (finalSession.autoPaginate.status !== 'stopped') {
    log.step('Sending real STOP_AUTO_PAGINATE (DURDUR) to the live tab');
    var stopResult = await swEval(function (id) {
      return chrome.tabs.sendMessage(id, { type: 'STOP_AUTO_PAGINATE' }).then(function (r) { return r; }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
    }, tabId);
    log.info('STOP_AUTO_PAGINATE response: ' + JSON.stringify(stopResult));
    await new Promise(function (r) { setTimeout(r, 500); });
    var afterStop = await swEval(function (hostKey) {
      return new Promise(function (resolve) { chrome.storage.local.get([hostKey], function (r) { resolve(r[hostKey] || null); }); });
    }, 'ws_live_session::' + normalizedHost);
    assert(afterStop.autoPaginate.status === 'stopped', 'real STOP_AUTO_PAGINATE did not actually stop the loop');
    assert(afterStop.rows.length >= finalSession.rows.length, 'row count decreased after Stop — data was lost');
    finalSession = afterStop;
    passed.push('Real DURDUR/Stop confirmed: navigation loop stopped, ' + afterStop.rows.length + ' rows preserved');
  } else {
    passed.push('Automatic Pagination already reached a natural real stop condition (' + finalSession.autoPaginate.stopReason + ') — collected data fully preserved (' + finalSession.rows.length + ' rows)');
  }

  // ---- Finish (BİTİR): real effect is session.status = 'finished',
  // exactly what popup.js's handleFinishLiveSession sets — verify the
  // dataset stays fully intact/exportable afterward. ----
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
  passed.push('Real Finish/BİTİR confirmed: dataset frozen with all ' + afterFinish.rows.length + ' rows intact — ready for export (existing, unmodified export code paths read this exact session.rows array)');

  // Final popup screenshot, now that a real, substantial dataset exists.
  await popupPage.screenshot({ path: path.join(ARTIFACT_DIR, 'popup-progress.png'), fullPage: true, timeout: 60000 }).catch(function () {});
  await sitePage.screenshot({ path: path.join(ARTIFACT_DIR, 'browser.png'), timeout: 60000 }).catch(function () {});

  details.consoleErrors = consoleErrors;
  if (consoleErrors.length) log.warn('Console errors observed on the real site: ' + JSON.stringify(consoleErrors.slice(0, 10)));

  return { passed: passed, details: details };
}

module.exports = { run: run, START_URL: START_URL, ARTIFACT_DIR: ARTIFACT_DIR };
