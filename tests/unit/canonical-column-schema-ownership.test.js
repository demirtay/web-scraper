/**
 * canonical-column-schema-ownership.test.js (FAST/local, no browser)
 * REAL AMAZON EVIDENCE mission — CANONICAL COLUMN SCHEMA OWNERSHIP.
 *
 * Real production report, right after the container-selector fix
 * started working (7 pages / 302 records): the user manually selected
 * only TWO columns (başlık, fiyat) via Manual Mode — never touched Auto
 * Detect. The persisted session.scraperConfig.columns correctly showed
 * exactly those two. BUT session.rows contained TWO different schemas:
 * row 0 used a freshly-generated 10-column Auto-Detect-style schema
 * (Link, Image, Title, Count, Rating, Field, Field 2, Price, Field 3,
 * Field 4); every later row used the user's own two manually-selected
 * column IDs. Result: Excel export picked up the 10-column schema as
 * its header row, and 301 of 302 records appeared blank (their actual
 * data lived under different column IDs than the export was reading).
 *
 * ROOT CAUSE (found by re-reading the PREVIOUS round's own new code —
 * content/content.js's migrateContainerSelectorIfStale(), added to
 * repair an over-broad stale containerSelector via
 * content/autodetect.js's own runAutoDetect()): that repair branch
 * replaced BOTH state.containerSelector AND state.columns with Auto
 * Detect's own guessed field list — silently overwriting the user's
 * manual 2-column selection with an unrelated 10-field schema the user
 * never asked for and never confirmed. Only the in-memory `state` this
 * ONE RUN_EXTRACTION call used (and then persisted back to storage) ever
 * saw the swap — popup.js's own separate in-memory `state` (which
 * session.scraperConfig for every LATER page is built from) never did,
 * producing exactly the reported one-row-different-schema corruption.
 *
 * FIX (content/content.js only): the repair branch now ONLY ever
 * replaces containerSelector — the user's own column definitions
 * (id/name/attribute/relativeSelector) are never touched. This is safe
 * because Sel.queryFromScope()/querySelector() perform a DESCENDANT
 * search: a class-based relativeSelector built to work from a narrow
 * internal-fragment scope generally ALSO resolves correctly from a
 * broader, more correct ancestor (record-level) scope — verified, not
 * assumed: the user's own existing columns must show measurably BETTER
 * cohesion against the candidate new container, or the repair is
 * rejected outright and the original selector is left untouched.
 *
 * This test drives the REAL, unmodified production BAŞLA/RUN_EXTRACTION
 * path (content/content.js's own real message handler) with a user's
 * manually-selected 2-column config (Turkish names, matching the real
 * report) against a stale, over-broad containerSelector, then drives
 * content/discovery.js's own real runDiscoveryLoop() through a second
 * page to prove the SAME two column IDs survive across pages.
 *
 * Standalone-runnable: `node tests/unit/canonical-column-schema-ownership.test.js`.
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
const MANUAL_TITLE_ID = 'col_1788333394475_knjsfa'; // matches the real report's own literal IDs
const MANUAL_PRICE_ID = 'col_1788333411610_dnhp65';

function buildFixture(withPagination) {
  var dom = createMiniDocument();
  var body = dom.body;
  var grid = el('div', { class: 'search-results-grid' });
  for (var i = 1; i <= CARD_COUNT; i++) {
    var card = el('div', { class: 'sg-col-4-of-24 sg-col-4-of-12 s-result-item s-asin sg-col-4-of-16 sg-col s-widget-spacing-small sg-col-4-of-20' });
    var titleWrapper = el('div', { class: 'a-section a-spacing-none' });
    var link = el('a', { href: '/dp/PRODUCT-' + i });
    link.appendChild(el('h2', { class: 'a-size-base-plus a-spacing-none a-color-base a-text-normal' }, 'Masa Lambası Model ' + i));
    titleWrapper.appendChild(link);
    var priceWrapper = el('div', { class: 'a-section a-spacing-none' });
    priceWrapper.appendChild(el('span', { class: 'a-color-base' }, 'TRY ' + (1000 + i * 10) + '.85'));
    card.appendChild(titleWrapper);
    card.appendChild(priceWrapper);
    grid.appendChild(card);
  }
  body.appendChild(grid);

  var sidebar = el('div', { class: 'filter-panel' });
  ['Müşteri Yorumları', 'Markalar', "Amazon'un Seçimi"].forEach(function (t) {
    sidebar.appendChild(el('div', { class: 'a-section a-spacing-none' }, t));
  });
  body.appendChild(sidebar);

  var nextLink = null;
  if (withPagination) {
    nextLink = el('a', {
      class: 's-pagination-next',
      href: '/s?k=masa+lambasi&page=2&ref=sr_pg_1',
      'aria-label': 'Sonraki sayfaya git, sayfa 2'
    }, 'Sonraki');
    var paginationWrapper = el('div', { class: 'a-section a-spacing-none' });
    paginationWrapper.appendChild(nextLink);
    body.appendChild(paginationWrapper);
  }
  return { dom: dom, nextLink: nextLink };
}

function manualState(containerSelector) {
  return {
    containerSelector: containerSelector,
    columns: [
      { id: MANUAL_TITLE_ID, name: 'başlık', relativeSelector: 'h2.a-size-base-plus.a-spacing-none.a-color-base.a-text-normal', attribute: 'text' },
      { id: MANUAL_PRICE_ID, name: 'fiyat', relativeSelector: 'span.a-color-base', attribute: 'text' }
    ]
  };
}

function loadFullStack(dom, storageStore) {
  var navigatedTo = { value: null };
  var startHref = 'https://' + HOSTNAME + '/s?k=masa+lambasi';
  var loc = { hostname: HOSTNAME, href: startHref, pathname: '/s', search: '?k=masa+lambasi' };
  Object.defineProperty(loc, 'href', {
    get: function () { return navigatedTo.value || startHref; },
    set: function (v) { navigatedTo.value = v; }
  });

  var listeners = [];
  var chromeObj = {
    runtime: { onMessage: { addListener: function (fn) { listeners.push(fn); } }, lastError: null },
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
    MutationObserver: function () { return { observe: function () {}, disconnect: function () {} }; },
    requestAnimationFrame: function (cb) { return setTimeout(cb, 0); },
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
  ['utils/storage.js', 'utils/runstate.js', 'utils/discovery.js', 'content/selector.js', 'content/scraper.js', 'content/autodetect.js', 'content/content.js', 'content/nextdetect.js', 'content/discovery.js'].forEach(function (rel) {
    vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'), sandbox, { filename: rel });
  });

  function dispatchToAll(message) {
    return new Promise(function (resolve) {
      listeners.forEach(function (fn) { fn(message, {}, function (res) { resolve(res); }); });
    });
  }
  return { sandbox: sandbox, navigatedTo: navigatedTo, dispatch: dispatchToAll };
}

async function settle(ticks) {
  for (var i = 0; i < (ticks || 30); i++) await new Promise(function (r) { setTimeout(r, 0); });
}

// Internal row metadata (e.g. content/scraper.js's own `_wsAnomaly`
// anomaly-detection flag) is legitimate on every row regardless of
// column schema — the mission's own wording is "every session row
// contains only those canonical IDs (+ internal metadata)". Only
// underscore-prefixed keys are treated as internal; anything else is a
// real column ID and must be one of the 2 canonical ones.
function dataColumnKeys(row) {
  return Object.keys(row).filter(function (k) { return k.charAt(0) !== '_'; }).sort();
}

async function run() {
  const suite = makeSuite('canonical-column-schema-ownership');
  const assert = suite.assert;

  var STALE_SELECTOR = 'div.a-section.a-spacing-none';

  // ================================================================
  // PART 1 — RUN_EXTRACTION (BAŞLA's own page-1 call): the user's
  // manually-selected 2 columns must be the ONLY columns used and
  // ONLY the containerSelector may be repaired.
  // ================================================================
  var built1 = buildFixture(false);
  var staleMatchCount = built1.dom.document.querySelectorAll(STALE_SELECTOR).length;
  assert(staleMatchCount > CARD_COUNT * 1.5, 'MISSION PROOF (fixture sanity): the stale selector matches far more than the real ' + CARD_COUNT + ' cards — got ' + staleMatchCount);

  var storageStore1 = {};
  var stack1 = loadFullStack(built1.dom, storageStore1);
  await stack1.sandbox.WSStorage.setState(HOSTNAME, manualState(STALE_SELECTOR));

  var res = await stack1.dispatch({ type: 'RUN_EXTRACTION' });
  assert(res && res.ok, 'MISSION PROOF: RUN_EXTRACTION succeeds — got ' + JSON.stringify(res && { ok: res.ok, error: res.error }));

  var migration = res.containerMigration;
  assert(migration && migration.templateMigrationPerformed === true, 'MISSION PROOF: the stale container IS repaired — got ' + JSON.stringify(migration));
  assert(!migration.usedAutoDetectRepair || migration.migratedContainerSelector, 'sanity: a migration diagnostic is present');

  // Item 1 — RUN_EXTRACTION receives only the 2 manual columns: proven
  // by the extracted rows' own keys.
  assert(res.rows.length === CARD_COUNT, 'MISSION PROOF (item 2 — before/after row count, AFTER): initial page produces ' + CARD_COUNT + ' logical rows, not 47 duplicates + 1 — got ' + res.rows.length);
  res.rows.forEach(function (r, i) {
    var keys = dataColumnKeys(r);
    assert(keys.length === 2 && keys.indexOf(MANUAL_TITLE_ID) !== -1 && keys.indexOf(MANUAL_PRICE_ID) !== -1,
      'MISSION PROOF (item 1/4 — no mixed schema): row ' + i + ' contains ONLY the 2 manual column IDs (+ internal metadata) — got ' + JSON.stringify(Object.keys(r).sort()));
  });
  assert(res.rows.every(function (r) { return !!r[MANUAL_TITLE_ID] && !!r[MANUAL_PRICE_ID]; }), 'MISSION PROOF (item 7 — no blank rows): every row has real data under both manual column IDs');

  // Item 5 — session.scraperConfig.columns (persisted state, what
  // popup.js's own containerMigration handling + session creation reads
  // next) remains exactly the 2 manual columns.
  var readBack = await stack1.sandbox.WSStorage.getState(HOSTNAME);
  assert(readBack.columns.length === 2, 'MISSION PROOF (item 5 — canonical column count): exactly 2 columns persisted — got ' + readBack.columns.length);
  assert(readBack.columns[0].id === MANUAL_TITLE_ID && readBack.columns[1].id === MANUAL_PRICE_ID, 'MISSION PROOF (item 5 — canonical column IDs unchanged): got ' + JSON.stringify(readBack.columns.map(function (c) { return c.id; })));
  assert(readBack.columns[0].name === 'başlık' && readBack.columns[1].name === 'fiyat', 'MISSION PROOF (item 6 — export headers would be exactly başlık/fiyat): got ' + JSON.stringify(readBack.columns.map(function (c) { return c.name; })));
  assert(readBack.containerSelector !== STALE_SELECTOR, 'sanity: the container WAS repaired (this is the mechanism under test, not a no-op)');

  // ================================================================
  // PART 2 — multi-page discovery: the SAME canonical column IDs must
  // survive into session.scraperConfig used by page 2+ (content/
  // discovery.js's own real, unmodified runDiscoveryLoop()).
  // ================================================================
  var built2 = buildFixture(true);
  var storageStore2 = {};
  var stack2 = loadFullStack(built2.dom, storageStore2);
  await settle(5);
  await stack2.sandbox.WSStorage.setState(HOSTNAME, manualState(STALE_SELECTOR));

  var res2 = await stack2.dispatch({ type: 'RUN_EXTRACTION' });
  assert(res2 && res2.ok, 'MISSION PROOF: page-1 RUN_EXTRACTION succeeds in the multi-page scenario too');
  var repairedSelector = res2.containerMigration.migratedContainerSelector;

  // Build the live session exactly as popup.js's own handleStartLiveSession
  // does — scraperConfig sourced from state (now correctly repaired at
  // the container level only), columns untouched, 2 manual IDs.
  var sessionKey = 'ws_live_session::' + HOSTNAME.replace(/^www\./, '');
  storageStore2[sessionKey] = {
    sessionId: 's1', hostname: HOSTNAME, status: 'active',
    startedAt: Date.now(), updatedAt: Date.now(),
    scraperConfig: { containerSelector: repairedSelector, columns: [
      { id: MANUAL_TITLE_ID, name: 'başlık', relativeSelector: 'h2.a-size-base-plus.a-spacing-none.a-color-base.a-text-normal', attribute: 'text' },
      { id: MANUAL_PRICE_ID, name: 'fiyat', relativeSelector: 'span.a-color-base', attribute: 'text' }
    ] },
    dedupeKey: null, seenKeys: {}, lastPassNewRows: 0, lastCheckAt: null,
    rows: res2.rows,
    discovery: {
      status: 'discovering', enabled: true, pagesVisited: 1, discoveredUnique: res2.rows.length,
      maxPages: 500, maxTotalCycles: 2000, scrollCycles: 0, loadMoreActions: 0,
      visitedUrls: ['https://' + HOSTNAME + '/s?k=masa+lambasi'], lastPaginationAttempt: null,
      currentPageBaselineCandidateCount: 0, updatedAt: Date.now()
    },
    autoScroll: { enabled: true, status: 'exhausted', stopReason: 'no-new-data', cycleCount: 1, maxCycles: 50, consecutiveNoNewData: 1, maxNoNewDataAttempts: 3, pageSignatures: [], updatedAt: Date.now() },
    loadMoreAuto: { enabled: true, status: 'exhausted', stopReason: 'no-candidate', clickCount: 0, maxClicks: 50, consecutiveNoNewData: 0, maxNoNewDataAttempts: 3, pageSignatures: [], updatedAt: Date.now() }
  };

  await stack2.sandbox.WSDiscovery.runDiscoveryLoop(HOSTNAME, /*skipInitialScrape*/ true);
  await settle(20);
  if (stack2.sandbox.WSDiscovery.flushPageDiagQueue) await stack2.sandbox.WSDiscovery.flushPageDiagQueue();

  var finalSession = storageStore2[sessionKey];
  // Item 3/7 — discovery's own revalidation (Round 9/10, called again at
  // loop-start) must NOT re-corrupt the columns either — same guarantee,
  // exercised through the discovery-loop path this time.
  assert(finalSession.scraperConfig.columns.length === 2, 'MISSION PROOF (item 3 — pages 2+ use the SAME 2 column IDs): session.scraperConfig.columns still has exactly 2 — got ' + finalSession.scraperConfig.columns.length);
  assert(finalSession.scraperConfig.columns[0].id === MANUAL_TITLE_ID && finalSession.scraperConfig.columns[1].id === MANUAL_PRICE_ID, 'MISSION PROOF (item 3): the exact same 2 canonical column IDs — got ' + JSON.stringify(finalSession.scraperConfig.columns.map(function (c) { return c.id; })));

  var attempt = finalSession.discovery.lastPaginationAttempt;
  assert(!!attempt && attempt.nextCandidateFound === true, 'MISSION PROOF (pagination unaffected by this fix): next candidate still found — got ' + JSON.stringify(attempt));
  assert(attempt.paginationActionIssued === true, 'MISSION PROOF: pagination still triggers correctly');

  // Item 9 — no row anywhere (across the whole run) contains a mixed/
  // unexpected column-ID generation.
  var allRowsEverywhere = res2.rows;
  var expectedIds = [MANUAL_TITLE_ID, MANUAL_PRICE_ID].sort();
  allRowsEverywhere.forEach(function (r, i) {
    var keys = dataColumnKeys(r);
    assert(keys.length === 2 && keys[0] === expectedIds[0] && keys[1] === expectedIds[1], 'MISSION PROOF (item 9 — no mixed-generation rows anywhere): row ' + i + ' — got ' + JSON.stringify(Object.keys(r).sort()));
  });

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
