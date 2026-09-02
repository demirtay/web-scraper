/**
 * amazon-real-diagnostic-reproduction.test.js (FAST/local, no browser)
 * REAL AMAZON EVIDENCE mission — reproduces the EXACT real Active
 * Session Diagnostic from a failed production run:
 *
 *   scraperConfig.containerSelector = "div.a-section.a-spacing-none"
 *   raw=245, newUnique=167
 *   garbage rows: "Amazon's Choice: Overall Pick", "4.7",
 *     "TRY 1,640.85", "Material", "Top Brands", "Customer Reviews", ...
 *   discovery: nextCandidateFound=false, outcome="no-next-candidate",
 *     pagesVisited=1, stopReason="no-more-mechanisms"
 *   crossNavRegistered=true, observer attached=true (not the blocker)
 *
 * ROOT CAUSE traced (no guessing — read before writing this test):
 * content/content.js's migrateContainerSelectorIfStale() only ever runs
 * when RUN_EXTRACTION is invoked. content/discovery.js's own
 * runDiscoveryLoop() (Round 9) now re-validates
 * session.scraperConfig.containerSelector once at loop-start too — but
 * BOTH re-validation paths, before THIS round, only ever tried a
 * single-anchor content/selector.js findRepeatingContainer() climb to
 * repair an over-broad/low-cohesion selector. That climb has its own
 * deliberate "stop once complete" heuristic (countMeaningfulDescendants
 * >= 3) which is correct for its ORIGINAL purpose (Manual Mode,
 * anchored on a human's own confirmed click) but is not a strong enough
 * signal for THIS repair: on a real page where an internal fragment
 * level (e.g. a title-row) already looks "complete enough" on its own,
 * the climb can stop there instead of reaching the TRUE record
 * boundary — producing a "migrated" candidate that is STILL a fragment,
 * whose row-cohesion is not measurably better than the original, so the
 * repair is correctly (from its own narrow logic) rejected, leaving the
 * ORIGINAL stale selector in place. This exactly explains "the
 * revalidation fix didn't repair the real session."
 *
 * FIX (content/content.js only, content/discovery.js delegates to it —
 * see that file's own revalidateScraperConfigIfStale(), unchanged this
 * round): when the single-anchor climb's OWN weakness applies (the
 * over-broad/low-cohesion case), migrateContainerSelectorIfStale() now
 * PREFERS content/autodetect.js's own runAutoDetect() — a strictly more
 * powerful, already-independently-validated signal (hard row-cohesion
 * gate + field-anchored candidate generation, proven across many
 * earlier rounds' own regression tests) — adopting its winning
 * structure's containerSelector AND fields together, atomically. The
 * single-anchor climb remains as a fallback only for a page where
 * WSAutoDetect genuinely isn't available or finds nothing usable.
 *
 * This test drives the SAME production BAŞLA -> RUN_EXTRACTION path
 * (content/content.js's own real, unmodified message handler) with the
 * exact reported stale selector already sitting in per-hostname
 * storage, using a fixture whose garbage rows are literally the real
 * diagnostic's own reported values.
 *
 * Standalone-runnable: `node tests/unit/amazon-real-diagnostic-reproduction.test.js`.
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

function buildRealEvidenceFixture() {
  var dom = createMiniDocument();
  var body = dom.body;

  var grid = el('div', { class: 'search-results-grid' });
  for (var i = 1; i <= CARD_COUNT; i++) {
    // The TRUE product card — a realistic Amazon-shaped noisy utility
    // class combo (no clean semantic name of its own), matching every
    // earlier round's own real-evidence-derived fixtures.
    var card = el('div', { class: 'sg-col-4-of-24 sg-col-4-of-12 s-result-item s-asin sg-col-4-of-16 sg-col s-widget-spacing-small sg-col-4-of-20' });
    var titleWrapper = el('div', { class: 'a-section a-spacing-none' });
    var link = el('a', { href: '/dp/PRODUCT-' + i });
    link.appendChild(el('h2', { class: 'a-size-base-plus a-spacing-none a-color-base a-text-normal' }, 'Desk Lamp Model ' + i));
    titleWrapper.appendChild(link);
    var priceWrapper = el('div', { class: 'a-section a-spacing-none' });
    priceWrapper.appendChild(el('span', { class: 'a-color-base' }, 'TRY ' + (1000 + i * 10) + '.85'));
    card.appendChild(titleWrapper);
    card.appendChild(priceWrapper);
    grid.appendChild(card);
  }
  body.appendChild(grid);

  // The EXACT garbage row texts the real diagnostic reported, all
  // sharing the same generic ".a-section.a-spacing-none" class.
  var sidebar = el('div', { class: 'filter-panel' });
  ["Amazon's Choice: Overall Pick", '4.7', 'Material', 'Top Brands', 'Customer Reviews'].forEach(function (t) {
    sidebar.appendChild(el('div', { class: 'a-section a-spacing-none' }, t));
  });
  body.appendChild(sidebar);

  // Pagination — real Next control, wrapped in the SAME generic class
  // as the stale selector (the real second symptom).
  var nextLink = el('a', {
    class: 's-pagination-next',
    href: '/s?k=desk+lamp&page=2&ref=sr_pg_1',
    'aria-label': 'Go to next page, page 2'
  }, 'Next');
  var paginationWrapper = el('div', { class: 'a-section a-spacing-none' });
  paginationWrapper.appendChild(nextLink);
  body.appendChild(paginationWrapper);

  return { dom: dom, nextLink: nextLink };
}

/** Loads content/selector.js + content/scraper.js + content/autodetect.js
 * + content/content.js together — the REAL, unmodified production
 * BAŞLA/RUN_EXTRACTION path — and captures content.js's own real
 * RUN_EXTRACTION message listener for direct dispatch, exactly like
 * tests/unit/stale-container-selector-migration-fix.test.js's own
 * established pattern. */
function loadProductionExtractionStack(dom, storageStore, hostnameStr) {
  var listeners = [];
  var sandbox = {
    console: console, URL: URL, URLSearchParams: URLSearchParams,
    document: dom.document,
    window: null,
    location: { href: 'https://' + hostnameStr + '/s?k=desk+lamp', hostname: hostnameStr, pathname: '/s', search: '?k=desk+lamp' },
    NodeFilter: { SHOW_ELEMENT: 1 },
    getComputedStyle: function () { return { display: 'block', visibility: 'visible' }; },
    MutationObserver: function () { return { observe: function () {}, disconnect: function () {} }; },
    requestAnimationFrame: function (cb) { return setTimeout(cb, 0); },
    chrome: {
      runtime: { onMessage: { addListener: function (fn) { listeners.push(fn); } }, lastError: null },
      storage: {
        local: {
          get: function (keys, cb) {
            var out = {};
            var list = keys === null || keys === undefined ? Object.keys(storageStore) : (Array.isArray(keys) ? keys : [keys]);
            list.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(storageStore, k)) out[k] = storageStore[k]; });
            cb(out);
          },
          set: function (data, cb) { Object.keys(data).forEach(function (k) { storageStore[k] = data[k]; }); if (cb) cb(); },
          remove: function (keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { delete storageStore[k]; }); if (cb) cb(); }
        }
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.window.getComputedStyle = sandbox.getComputedStyle;
  vm.createContext(sandbox);
  ['utils/storage.js', 'content/selector.js', 'content/scraper.js', 'content/autodetect.js', 'content/content.js'].forEach(function (rel) {
    var full = path.join(REPO_ROOT, rel);
    vm.runInContext(fs.readFileSync(full, 'utf8'), sandbox, { filename: full });
  });

  function dispatch(message) {
    return new Promise(function (resolve) {
      listeners.forEach(function (fn) { fn(message, {}, function (res) { resolve(res); }); });
    });
  }
  return { sandbox: sandbox, dispatch: dispatch };
}

async function run() {
  const suite = makeSuite('amazon-real-diagnostic-reproduction');
  const assert = suite.assert;

  var built = buildRealEvidenceFixture();
  var STALE_SELECTOR = 'div.a-section.a-spacing-none';
  var rawMatchCount = built.dom.document.querySelectorAll(STALE_SELECTOR).length;
  // Real diagnostic: raw=245 for 48 real cards (2 fragments each = 96)
  // + 5 sidebar garbage rows + 1 pagination wrapper = 102 in THIS
  // fixture's own proportions — the exact count differs from the real
  // page (never hardcoded to match it exactly), but the SAME "far more
  // matches than real cards" shape is what matters.
  assert(rawMatchCount > CARD_COUNT * 1.5, 'MISSION PROOF (fixture sanity): the stale selector matches far more than the real ' + CARD_COUNT + ' cards — got ' + rawMatchCount);

  var loaded = loadProductionExtractionStack(built.dom, {}, HOSTNAME);

  // Seed the EXACT stale state the real diagnostic reported.
  var staleState = {
    containerSelector: STALE_SELECTOR,
    columns: [
      { id: 'c1', name: 'Title', relativeSelector: 'h2.a-size-base-plus.a-spacing-none.a-color-base.a-text-normal', attribute: 'text' },
      { id: 'c2', name: 'Price', relativeSelector: 'span.a-color-base', attribute: 'text' }
    ]
  };
  loaded.sandbox.WSStorage_seed = null; // no-op placeholder, storage seeded directly below via the real setState
  await loaded.sandbox.WSStorage.setState(HOSTNAME, staleState);

  // ---- Real execution: the SAME production BAŞLA -> RUN_EXTRACTION
  // path (content/content.js's own real, unmodified message handler). ----
  var res = await loaded.dispatch({ type: 'RUN_EXTRACTION' });
  assert(res && res.ok, 'MISSION PROOF: RUN_EXTRACTION succeeds — got ' + JSON.stringify(res && { ok: res.ok, error: res.error }));

  var migration = res.containerMigration;
  assert(migration && migration.templateMigrationPerformed === true, 'MISSION PROOF (root cause fix): the stale selector IS repaired this time — got ' + JSON.stringify(migration));
  assert(migration.usedAutoDetectRepair === true, 'MISSION PROOF: repaired via the STRONGER runAutoDetect()-based path (not the weaker single-anchor climb that previously failed to improve on the stale selector) — got ' + JSON.stringify(migration));
  assert(migration.migratedContainerSelector.indexOf('a-section') === -1, 'MISSION PROOF: repaired selector is not the generic internal-fragment class — got ' + JSON.stringify(migration.migratedContainerSelector));

  var repairedMatchCount = built.dom.document.querySelectorAll(migration.migratedContainerSelector).length;
  assert(Math.abs(repairedMatchCount - CARD_COUNT) <= 2, 'MISSION PROOF (row count before/after): repaired selector matches ~' + CARD_COUNT + ' real cards (before: ' + rawMatchCount + ') — got ' + repairedMatchCount);

  // ---- Extraction no longer creates standalone garbage rows. ----
  assert(res.rows.length === CARD_COUNT, 'MISSION PROOF: extraction now produces exactly ' + CARD_COUNT + ' rows — got ' + res.rows.length);
  var garbageTexts = ["Amazon's Choice: Overall Pick", '4.7', 'Material', 'Top Brands', 'Customer Reviews'];
  var titleField = migration.migratedContainerSelector ? null : null; // (fields come from res.rows keys directly below)
  var rowValues = res.rows.map(function (r) { return Object.keys(r).map(function (k) { return r[k]; }); }).reduce(function (a, b) { return a.concat(b); }, []);
  garbageTexts.forEach(function (g) {
    assert(rowValues.indexOf(g) === -1, 'MISSION PROOF: garbage text "' + g + '" no longer appears in any extracted row value');
  });

  // ---- Persisted state genuinely holds the repaired selector — this is
  // what a subsequent session.scraperConfig seeding reads from next. ----
  var readBack = await loaded.sandbox.WSStorage.getState(HOSTNAME);
  assert(readBack.containerSelector === migration.migratedContainerSelector, 'MISSION PROOF: the repaired selector is persisted back to per-hostname storage — got ' + JSON.stringify(readBack.containerSelector));
  assert(readBack.containerSelector !== STALE_SELECTOR, 'MISSION PROOF: the stale selector does not survive in persisted state');

  // ---- Next detection now receives the corrected selector and finds
  // the real, enabled Amazon Next link (content/nextdetect.js —
  // completely untouched by this round). ----
  var nextSandbox = {
    console: console, URL: URL, URLSearchParams: URLSearchParams,
    document: built.dom.document,
    location: { href: 'https://' + HOSTNAME + '/s?k=desk+lamp', hostname: HOSTNAME, pathname: '/s', search: '?k=desk+lamp' },
    MouseEvent: function (type) { this.type = type; },
    window: null
  };
  nextSandbox.window = nextSandbox;
  nextSandbox.window.getComputedStyle = function () { return { display: 'block', visibility: 'visible' }; };
  vm.createContext(nextSandbox);
  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'content', 'nextdetect.js'), 'utf8'), nextSandbox, { filename: 'content/nextdetect.js' });

  var withStale = nextSandbox.WSNextDetect.findNextControl(STALE_SELECTOR);
  assert(withStale.found === false, 'MISSION PROOF (bug reproduction): with the OLD stale selector, findNextControl still rejects the real Next control — got ' + JSON.stringify(withStale));

  var withRepaired = nextSandbox.WSNextDetect.findNextControl(readBack.containerSelector);
  assert(withRepaired.found === true, 'MISSION PROOF (item 7 — nextCandidateFound becomes true): with the repaired canonical selector, the real enabled Amazon Next link is found — got ' + JSON.stringify(withRepaired));
  assert(withRepaired.disabled === false, 'MISSION PROOF: correctly reported as enabled');

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
