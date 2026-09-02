/**
 * discovery-canonical-selector-ownership.test.js (FAST/local, no browser)
 * REAL AMAZON EVIDENCE mission — CANONICAL SELECTOR OWNERSHIP round.
 *
 * Real-world contradiction that triggered this round: a FRESH Auto
 * Detect pass on the real Amazon page correctly found the true ~48-row
 * product-card selector, yet the CURRENT LIVE SESSION (and its own
 * Next-Detect diagnostic) still showed the old, stale
 * "div.a-section.a-spacing-none" — even after content/content.js's own
 * RUN_EXTRACTION-time migration fix (a previous round) was already
 * shipped.
 *
 * ROOT CAUSE traced (no code guessed, only read): content/content.js's
 * migrateContainerSelectorIfStale() only ever runs when RUN_EXTRACTION
 * is actually invoked — i.e., when a scrape is freshly (re)started. But
 * once a discovery session EXISTS, content/discovery.js's own
 * runDiscoveryLoop() reads session.scraperConfig.containerSelector
 * fresh every iteration and uses it FOREVER, for that session's entire
 * lifetime, with NO re-validation of any kind — and, critically,
 * content/discovery.js's own bootstrap-resume block (its file-bottom
 * code, run on EVERY fresh content-script injection — a real page
 * reload or extension reload included) picks up ANY still-running
 * session and hands it straight back into this exact loop with its OWN
 * frozen-in-time scraperConfig, completely disconnected from whatever a
 * NEWER Auto Detect result a user has since produced. A session created
 * (or left running) before this project's own container-precision
 * fixes existed — or simply stuck mid-run from an earlier real report —
 * can therefore keep using its own stale selector indefinitely, no
 * matter how many times Auto Detect is re-run afterward, because
 * nothing ever tells THAT SESSION to look again.
 *
 * FIX (content/discovery.js only): a new revalidateScraperConfigIfStale()
 * — the SAME re-validation mechanism content/content.js's own
 * migrateContainerSelectorIfStale() already uses and already proved
 * safe (row-cohesion-based staleness detection, re-anchor via
 * Sel.findRepeatingContainer + buildContainerSelector, only ever accept
 * a MEASURABLY better replacement) — applied exactly ONCE, at the very
 * start of runDiscoveryLoop()'s own run (covers both a genuinely fresh
 * START_DISCOVERY and a resumed instance's first pass), never
 * re-applied per page.
 *
 * This test proves the exact scenario production evidence exposed: an
 * ALREADY-EXISTING live session — never touched by RUN_EXTRACTION in
 * this test at all, simulating a bootstrap-resumed instance — still
 * carries the stale "div.a-section.a-spacing-none" selector, and
 * content/discovery.js's own real, unmodified runDiscoveryLoop() (its
 * own "exposed for targeted testing only" entry point) self-heals it
 * before ever reaching next-page detection.
 *
 * Also proves the opposite: a legitimate, already-healthy selector
 * (real cohesion, reasonable match count) is left completely untouched
 * when there is no newer/better structure to find — this fix must never
 * second-guess a selector that's already working.
 *
 * Standalone-runnable: `node tests/unit/discovery-canonical-selector-ownership.test.js`.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createMiniDocument, el } = require('../lib/mini-dom');
const { makeSuite } = require('../lib/assert');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CARD_COUNT = 48;
const HOSTNAME = 'www.amazon.com';

function buildFixture() {
  var dom = createMiniDocument();
  var body = dom.body;

  var grid = el('div', { class: 'search-results-grid' });
  for (var i = 1; i <= CARD_COUNT; i++) {
    var card = el('div', { class: 'card-result' });
    var titleWrapper = el('div', { class: 'a-section a-spacing-none' });
    var link = el('a', { href: '/dp/PRODUCT-' + i });
    link.appendChild(el('h2', {}, 'Desk Lamp Model ' + i));
    titleWrapper.appendChild(link);
    var priceWrapper = el('div', { class: 'a-section a-spacing-none' });
    priceWrapper.appendChild(el('span', { class: 'a-color-base' }, '$' + (10 + i) + '.99'));
    card.appendChild(titleWrapper);
    card.appendChild(priceWrapper);
    grid.appendChild(card);
  }
  body.appendChild(grid);

  var sidebar = el('div', { class: 'filter-panel' });
  ['Customer Reviews', 'Brands', 'Color & Finish', 'Wattage'].forEach(function (t) {
    sidebar.appendChild(el('div', { class: 'a-section a-spacing-none' }, t));
  });
  body.appendChild(sidebar);

  var nextLink = el('a', {
    class: 's-pagination-next',
    href: '/s?k=desk+lamp&page=2&ref=sr_pg_1',
    'aria-label': 'Go to next page, page 2'
  }, 'Next');
  var paginationWrapper = el('div', { class: 'a-section a-spacing-none' }); // same generic class as the stale selector — the exact real second symptom
  paginationWrapper.appendChild(nextLink);
  body.appendChild(paginationWrapper);

  return { dom: dom, nextLink: nextLink };
}

function loadDiscoveryStack(dom, storageStore) {
  var navigatedTo = { value: null };
  var startHref = 'https://' + HOSTNAME + '/s?k=desk+lamp';
  var loc = { hostname: HOSTNAME, href: startHref };
  Object.defineProperty(loc, 'href', {
    get: function () { return navigatedTo.value || startHref; },
    set: function (v) { navigatedTo.value = v; }
  });

  var chromeObj = {
    runtime: { onMessage: { addListener: function () {} }, lastError: null },
    storage: {
      local: {
        get: function (keys, cb) {
          var out = {};
          var list = keys === null || keys === undefined ? Object.keys(storageStore) : (Array.isArray(keys) ? keys : [keys]);
          list.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(storageStore, k)) out[k] = JSON.parse(JSON.stringify(storageStore[k])); });
          cb(out);
        },
        set: function (data, cb) { Object.keys(data).forEach(function (k) { storageStore[k] = data[k]; }); if (cb) cb(); },
        remove: function (keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { delete storageStore[k]; }); if (cb) cb(); }
      }
    }
  };

  var sandbox = {
    console: console, JSON: JSON, Object: Object, Array: Array, Math: Math, Date: Date,
    Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout,
    AbortController: AbortController, URL: URL, URLSearchParams: URLSearchParams,
    MouseEvent: function (type) { this.type = type; },
    NodeFilter: { SHOW_ELEMENT: 1 },
    getComputedStyle: function () { return { display: 'block', visibility: 'visible' }; },
    chrome: chromeObj,
    document: dom.document,
    location: loc,
    WSAutoScroll: { runUntilExhausted: function (session) { return Promise.resolve(session); } },
    WSLoadMore: { runUntilExhausted: function (session) { return Promise.resolve(session); } },
    WSDomWait: {
      waitForNavigationOrMutation: function (opts) {
        return new Promise(function (resolve) {
          var before = loc.href;
          if (typeof opts.trigger === 'function') opts.trigger();
          setTimeout(function () { resolve(loc.href !== before ? 'url-changed' : 'timeout'); }, 0);
        });
      },
      waitForDomStable: function () { return Promise.resolve({ reason: 'settled' }); }
    },
    window: null
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.getComputedStyle = sandbox.getComputedStyle;
  dom.document.baseURI = startHref;

  vm.createContext(sandbox);
  ['utils/runstate.js', 'utils/discovery.js', 'content/selector.js', 'content/scraper.js', 'content/autodetect.js', 'content/content.js', 'content/nextdetect.js', 'content/discovery.js'].forEach(function (rel) {
    vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'), sandbox, { filename: rel });
  });
  return { sandbox: sandbox, navigatedTo: navigatedTo };
}

function sessionWithSelector(containerSelector, rows) {
  return {
    sessionId: 's1', hostname: HOSTNAME, status: 'active',
    startedAt: Date.now(), updatedAt: Date.now(),
    scraperConfig: { containerSelector: containerSelector, columns: [
      { id: 'c_title', name: 'Title', relativeSelector: 'h2', attribute: 'text' },
      { id: 'c_price', name: 'Price', relativeSelector: 'span.a-color-base', attribute: 'text' }
    ] },
    dedupeKey: null, seenKeys: {}, lastPassNewRows: 0, lastCheckAt: null,
    rows: rows,
    discovery: {
      status: 'discovering', enabled: true, pagesVisited: 1, discoveredUnique: rows.length,
      maxPages: 500, maxTotalCycles: 2000, scrollCycles: 0, loadMoreActions: 0,
      visitedUrls: ['https://' + HOSTNAME + '/s?k=desk+lamp'], lastPaginationAttempt: null,
      currentPageBaselineCandidateCount: 0, updatedAt: Date.now()
    },
    autoScroll: { enabled: true, status: 'exhausted', stopReason: 'no-new-data', cycleCount: 1, maxCycles: 50, consecutiveNoNewData: 1, maxNoNewDataAttempts: 3, pageSignatures: [], updatedAt: Date.now() },
    loadMoreAuto: { enabled: true, status: 'exhausted', stopReason: 'no-candidate', clickCount: 0, maxClicks: 50, consecutiveNoNewData: 0, maxNoNewDataAttempts: 3, pageSignatures: [], updatedAt: Date.now() }
  };
}

async function settle(ticks) {
  for (var i = 0; i < (ticks || 30); i++) await new Promise(function (r) { setTimeout(r, 0); });
}

async function run() {
  const suite = makeSuite('discovery-canonical-selector-ownership');
  const assert = suite.assert;

  // ================================================================
  // SCENARIO A — an ALREADY-EXISTING session (never touched by
  // RUN_EXTRACTION in this test at all — simulating a bootstrap-resumed
  // instance, or one that predates the fix entirely) still carries the
  // stale ".a-section.a-spacing-none" selector. Prove runDiscoveryLoop()
  // self-heals it, then correctly finds+triggers the real Next control.
  // ================================================================
  {
    var built = buildFixture();
    var STALE_SELECTOR = 'div.a-section.a-spacing-none';
    var staleRowsGarbage = built.dom.document.querySelectorAll(STALE_SELECTOR).length;
    assert(staleRowsGarbage > CARD_COUNT * 2, 'MISSION PROOF (fixture sanity): the stale selector matches far more than the real ' + CARD_COUNT + ' cards — got ' + staleRowsGarbage);

    var storageStore = {};
    var loaded = loadDiscoveryStack(built.dom, storageStore);
    await settle(5); // let the (no-op, empty storage) bootstrap attempt finish

    var sessionKey = 'ws_live_session::' + HOSTNAME.replace(/^www\./, '');
    // Existing session, ALREADY carrying the stale selector and 167-ish
    // "rows" (irrelevant to this test's own row content) — never
    // created via THIS test's own RUN_EXTRACTION call, exactly modeling
    // an existing/resumed session content.js's own fix never touches.
    storageStore[sessionKey] = sessionWithSelector(STALE_SELECTOR, (function () { var r = []; for (var i = 0; i < 167; i++) r.push({ c_title: 'x', c_price: 'y' }); return r; })());

    await loaded.sandbox.WSDiscovery.runDiscoveryLoop(HOSTNAME, /*skipInitialScrape*/ true);
    await settle(20);
    if (loaded.sandbox.WSDiscovery.flushPageDiagQueue) await loaded.sandbox.WSDiscovery.flushPageDiagQueue();

    var finalSession = storageStore[sessionKey];
    assert(finalSession.scraperConfig.containerSelector !== STALE_SELECTOR, 'MISSION PROOF (item 4/7 — canonical selector, no stale survival): session.scraperConfig.containerSelector is no longer the stale selector — got ' + JSON.stringify(finalSession.scraperConfig.containerSelector));
    assert(finalSession.scraperConfig.containerSelector.indexOf('a-section') === -1, 'MISSION PROOF: the migrated selector is not the generic internal-fragment class either');
    var migratedMatchCount = built.dom.document.querySelectorAll(finalSession.scraperConfig.containerSelector).length;
    assert(Math.abs(migratedMatchCount - CARD_COUNT) <= 2, 'MISSION PROOF (item 2): the canonical selector matches ~' + CARD_COUNT + ' real product rows — got ' + migratedMatchCount);

    var attempt = finalSession.discovery.lastPaginationAttempt;
    assert(!!attempt && attempt.nextCandidateFound === true, 'MISSION PROOF (item 5): next candidate found, NOT rejected because of the stale selector — got ' + JSON.stringify(attempt));
    assert(attempt.paginationActionIssued === true, 'MISSION PROOF (item 6): pagination action issued');
    assert(loaded.navigatedTo.value && loaded.navigatedTo.value.indexOf('page=2') !== -1, 'MISSION PROOF (item 6): navigation target is page=2 — got ' + JSON.stringify(loaded.navigatedTo.value));

    // Item 7: old stale selector never written back anywhere in storage.
    var allStoredValues = JSON.stringify(storageStore);
    assert(allStoredValues.indexOf('a-section.a-spacing-none') === -1, 'MISSION PROOF (item 7): the old stale selector string does not appear anywhere in final storage state');
  }

  // ================================================================
  // SCENARIO B — a legitimate, already-healthy selector (real cohesion,
  // reasonable match count) must be left COMPLETELY untouched — this
  // fix must never second-guess a selector that's already working
  // (mission's own explicit "verify a legitimate saved/manual selector
  // is preserved when there is NO newer Auto Detect result").
  // ================================================================
  {
    var built2 = buildFixture();
    var GOOD_SELECTOR = 'div.card-result';
    var storageStore2 = {};
    var loaded2 = loadDiscoveryStack(built2.dom, storageStore2);
    await settle(5);

    var sessionKey2 = 'ws_live_session::' + HOSTNAME.replace(/^www\./, '');
    storageStore2[sessionKey2] = sessionWithSelector(GOOD_SELECTOR, (function () { var r = []; for (var i = 0; i < CARD_COUNT; i++) r.push({ c_title: 'x', c_price: 'y' }); return r; })());

    await loaded2.sandbox.WSDiscovery.runDiscoveryLoop(HOSTNAME, true);
    await settle(20);
    if (loaded2.sandbox.WSDiscovery.flushPageDiagQueue) await loaded2.sandbox.WSDiscovery.flushPageDiagQueue();

    var finalSession2 = storageStore2[sessionKey2];
    assert(finalSession2.scraperConfig.containerSelector === GOOD_SELECTOR, 'MISSION PROOF (preservation): an already-healthy selector is left completely untouched — got ' + JSON.stringify(finalSession2.scraperConfig.containerSelector));
    var attempt2 = finalSession2.discovery.lastPaginationAttempt;
    assert(!!attempt2 && attempt2.nextCandidateFound === true, 'MISSION PROOF: pagination still works correctly for an already-healthy, untouched selector');
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
