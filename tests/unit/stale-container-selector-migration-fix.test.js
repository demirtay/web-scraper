/**
 * stale-container-selector-migration-fix.test.js (FAST/local, no browser)
 * REAL AMAZON EVIDENCE mission — the PROVEN root cause from real-browser
 * diagnostics:
 *
 *   FACT 1: a fresh Auto Detect pass on the real page correctly finds the
 *   true ~48-row product-card container.
 *   FACT 2: the CURRENT persisted session (session.scraperConfig, sourced
 *   from WSStorage's per-hostname state) is still using an old, broad
 *   selector: div.a-section.a-spacing-none.
 *   FACT 3: the real Amazon Next control (text="Next", aria-label="Go to
 *   next page, page 2", href contains page=2) IS found by
 *   findNextControl()'s own detection logic, but is REJECTED at every
 *   tier because rejectedInsideScraperContainer=true — the stale, broad
 *   containerSelector also happens to wrap the site's own pagination
 *   strip.
 *
 * ROOT CAUSE: content/content.js's RUN_EXTRACTION handler
 * (migrateContainerSelectorIfStale) only ever re-validated a STORED
 * containerSelector for being too NARROW (matching <= 2 elements, an
 * old over-specific template) — never for being too BROAD. A stale,
 * broad selector sitting in per-hostname storage (from an older
 * session/template, or from before the page's own markup changed)
 * sailed through completely unvalidated, then session.scraperConfig.
 * containerSelector was seeded from that SAME unvalidated value
 * (popup.js's own handleStartLiveSession, confirmed via its own
 * "content.js's RUN_EXTRACTION handler auto-migrates... migrated
 * selector below" comment) — and content/discovery.js hands that exact
 * value to content/nextdetect.js's findNextControl() as containerSelector,
 * where an over-broad selector can legitimately (and correctly, GIVEN
 * that selector) exclude the real Next control as "inside my own
 * container."
 *
 * FIX (content/content.js only — content/autodetect.js and
 * content/nextdetect.js are BOTH untouched by this specific fix):
 * migrateContainerSelectorIfStale() now ALSO re-validates a selector
 * that matches PLENTY of elements but whose own STORED COLUMNS rarely
 * resolve together on the same instance (the same "row cohesion"
 * invariant content/autodetect.js's own detection pipeline already
 * enforces, reapplied here as a RUNTIME staleness check against
 * whatever happens to already be sitting in storage). When confirmed
 * stale this way, the EXISTING, already-proven re-anchoring mechanism
 * (find a live anchor via one of the stored columns' own
 * relativeSelector, then Sel.findRepeatingContainer + buildContainerSelector
 * — the exact same repeated-container discovery a fresh manual click
 * already uses) re-derives the correct container, and ONLY replaces the
 * stored one when the replacement is measurably better (higher cohesion,
 * no unbounded selector-scope drift of its own) — never downgrading an
 * already-healthy selector.
 *
 * This test proves the FULL real chain end-to-end using the REAL,
 * unmodified content/content.js (loaded via its actual RUN_EXTRACTION
 * message handler — never a reimplementation), content/selector.js,
 * content/scraper.js, utils/storage.js, and content/nextdetect.js:
 *   1. A stale, broad containerSelector sitting in per-hostname storage
 *      gets corrected DURING RUN_EXTRACTION.
 *   2. The corrected selector is persisted back to storage (what
 *      popup.js's own session.scraperConfig seeding reads from next).
 *   3. Real extraction with the corrected selector produces ~48 rows,
 *      not 168+.
 *   4. Using the OLD stale selector directly, the real, unmodified
 *      findNextControl() rejects the real Next control (reproducing the
 *      exact bug) — using the CORRECTED selector, it's found.
 *
 * Generic by construction — no Amazon hostname/class-name check
 * anywhere in the fix; every class name in this fixture is invented,
 * mirroring only the STRUCTURAL shape the real evidence proved (a
 * generic per-field-fragment class also reused to wrap the pagination
 * strip, and real product cards using a completely different, precise
 * class the stale config never knew about).
 *
 * Standalone-runnable: `node tests/unit/stale-container-selector-migration-fix.test.js`.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createMiniDocument, el } = require('../lib/mini-dom');
const { makeSuite } = require('../lib/assert');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CARD_COUNT = 48;

function buildCard(n) {
  var card = el('div', { class: 'card-result' }); // the TRUE, precise per-card class the stale stored config never knew about
  var titleWrapper = el('div', { class: 'a-section a-spacing-none' });
  var link = el('a', { href: '/dp/PRODUCT-' + n });
  link.appendChild(el('h2', {}, 'Desk Lamp Model ' + n));
  titleWrapper.appendChild(link);
  var priceWrapper = el('div', { class: 'a-section a-spacing-none' });
  priceWrapper.appendChild(el('span', { class: 'a-color-base' }, '$' + (10 + n) + '.99'));
  card.appendChild(titleWrapper);
  card.appendChild(priceWrapper);
  return card;
}

function buildFixtureDocument() {
  var dom = createMiniDocument();
  dom.document.baseURI = 'https://shop.example.com/s?k=desk+lamp';
  var body = dom.body;

  var grid = el('div', { class: 'search-results-grid' });
  for (var i = 1; i <= CARD_COUNT; i++) grid.appendChild(buildCard(i));
  body.appendChild(grid);

  // Sidebar reusing the SAME ".a-section.a-spacing-none" generic class
  // as the card-internal fragments — real evidence's own shape.
  var sidebar = el('div', { class: 'filter-panel' });
  ['Customer Reviews', 'Brands', 'Color & Finish', 'Wattage'].forEach(function (t) {
    sidebar.appendChild(el('div', { class: 'a-section a-spacing-none' }, t));
  });
  body.appendChild(sidebar);

  // Pagination strip — the visible Previous/1/2/.../Next bar — its OWN
  // wrapper ALSO carries the same generic ".a-section.a-spacing-none"
  // class (real evidence's exact second symptom: this is what makes the
  // stale broad selector wrongly swallow the real Next control too).
  var paginationWrapper = el('div', { class: 'a-section a-spacing-none' });
  var paginationNav = el('nav', { class: 'pagination-strip', 'aria-label': 'Pagination' });
  for (var p = 1; p <= 7; p++) paginationNav.appendChild(el('a', { href: '?k=desk+lamp&page=' + p }, String(p)));
  var nextLink = el('a', { href: '?k=desk+lamp&page=2', 'aria-label': 'Go to next page, page 2' }, 'Next');
  paginationNav.appendChild(nextLink);
  paginationWrapper.appendChild(paginationNav);
  body.appendChild(paginationWrapper);

  return { dom: dom, nextLink: nextLink };
}

/** Loads the REAL, unmodified content/selector.js + content/scraper.js +
 * content/content.js together into one sandbox with a real, unmodified
 * utils/storage.js backed by an in-memory chrome.storage.local, and
 * captures content.js's own RUN_EXTRACTION message listener so it can be
 * invoked directly — exactly like chrome.tabs.sendMessage() would. */
function loadContentScript(dom, hostnameStr) {
  var storageStore = {};
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
      runtime: {
        onMessage: { addListener: function (fn) { listeners.push(fn); } },
        lastError: null
      },
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
  ['utils/storage.js', 'content/selector.js', 'content/scraper.js', 'content/content.js'].forEach(function (rel) {
    var full = path.join(REPO_ROOT, rel);
    vm.runInContext(fs.readFileSync(full, 'utf8'), sandbox, { filename: full });
  });

  function dispatch(message) {
    return new Promise(function (resolve) {
      var handled = false;
      listeners.forEach(function (fn) {
        var ret = fn(message, {}, function (res) { handled = true; resolve(res); });
        if (ret !== true && !handled) { /* synchronous handlers not used by RUN_EXTRACTION — ignored */ }
      });
    });
  }

  return { sandbox: sandbox, dispatch: dispatch, storageStore: storageStore, WSStorage: sandbox.WSStorage, WSSelector: sandbox.WSSelector };
}

function loadNextDetectAgainstDocument(document, locationHref) {
  var url = new URL(locationHref);
  var navigated = { to: null };
  var loc = { href: url.href, hostname: url.hostname, pathname: url.pathname, search: url.search };
  var sandbox = {
    console: console, URL: URL, URLSearchParams: URLSearchParams,
    document: document,
    location: loc,
    MouseEvent: function (type) { this.type = type; },
    window: null
  };
  // REAL AMAZON EVIDENCE mission — clickTrigger() now navigates directly
  // for a real anchor with a verified higher-page href, instead of a
  // synthetic click — track that too.
  Object.defineProperty(loc, 'href', {
    get: function () { return navigated.to || url.href; },
    set: function (v) { navigated.to = v; }
  });
  sandbox.window = sandbox;
  sandbox.window.getComputedStyle = function () { return { display: 'block', visibility: 'visible' }; };
  vm.createContext(sandbox);
  var code = fs.readFileSync(path.join(REPO_ROOT, 'content', 'nextdetect.js'), 'utf8');
  vm.runInContext(code, sandbox, { filename: 'content/nextdetect.js' });
  return { WSNextDetect: sandbox.WSNextDetect, navigated: navigated };
}

async function run() {
  const suite = makeSuite('stale-container-selector-migration-fix');
  const assert = suite.assert;

  var HOSTNAME = 'shop.example.com';
  var built = buildFixtureDocument();
  var loaded = loadContentScript(built.dom, HOSTNAME);

  // ---- Seed the EXACT stale state the real evidence proved: a broad,
  // generic containerSelector + columns resolved relative to it. ----
  var STALE_SELECTOR = 'div.a-section.a-spacing-none';
  var staleState = {
    containerSelector: STALE_SELECTOR,
    columns: [
      { id: 'c1', name: 'Title', relativeSelector: 'h2', attribute: 'text' },
      { id: 'c2', name: 'Price', relativeSelector: 'span.a-color-base', attribute: 'text' }
    ]
  };
  loaded.storageStore['ws_state::' + HOSTNAME] = staleState;

  var staleMatchCount = loaded.sandbox.document.querySelectorAll(STALE_SELECTOR).length;
  assert(staleMatchCount > CARD_COUNT * 2, 'MISSION PROOF (fixture sanity): the stale selector matches far more than the real ' + CARD_COUNT + ' cards — got ' + staleMatchCount + ' (reproduces the real 242-vs-48 shape)');

  // ---- Real execution: RUN_EXTRACTION through content/content.js's own,
  // completely unmodified message handler. ----
  var res = await loaded.dispatch({ type: 'RUN_EXTRACTION' });
  assert(res && res.ok, 'MISSION PROOF: RUN_EXTRACTION succeeds — got ' + JSON.stringify(res && { ok: res.ok, error: res.error }));

  var migration = res.containerMigration;
  assert(migration, 'MISSION PROOF: containerMigration diagnostic is present on the response');
  assert(migration.templateMigrationPerformed === true, 'MISSION PROOF (ROOT CAUSE fix): the stale, broad selector IS migrated — got ' + JSON.stringify(migration));
  assert(migration.migratedContainerSelector && migration.migratedContainerSelector.indexOf('a-section') === -1, 'MISSION PROOF: the migrated selector is NOT the generic internal-fragment class — got ' + JSON.stringify(migration.migratedContainerSelector));
  var migratedMatchCount = loaded.sandbox.document.querySelectorAll(migration.migratedContainerSelector).length;
  assert(Math.abs(migratedMatchCount - CARD_COUNT) <= 2, 'MISSION PROOF: the migrated selector matches ~' + CARD_COUNT + ' real cards, not ' + staleMatchCount + ' — got ' + migratedMatchCount);

  // ---- Requirement 2/3: the migrated selector is the CANONICAL one —
  // real extraction produces ~48 rows, not 168+/242. ----
  assert(res.rows.length >= CARD_COUNT - 2 && res.rows.length <= CARD_COUNT + 2, 'MISSION PROOF: real extraction (through the now-corrected selector) produces ~' + CARD_COUNT + ' rows — got ' + res.rows.length);

  // ---- Requirement: the corrected selector is PERSISTED back to
  // storage — this is what popup.js's own session.scraperConfig seeding
  // reads from next (session.scraperConfig.containerSelector, per that
  // file's own established, already-verified
  // "content.js's RUN_EXTRACTION handler... already persisted the
  // corrected selector to chrome.storage.local" contract). ----
  var reloadedState = await loaded.WSStorage.getState(HOSTNAME);
  assert(reloadedState.containerSelector === migration.migratedContainerSelector, 'MISSION PROOF: the corrected selector is persisted back to per-hostname storage — got ' + JSON.stringify(reloadedState.containerSelector));

  // ---- Requirement 4/7: pagination now receives the CANONICAL,
  // corrected selector — the real, unmodified findNextControl() accepts
  // the real Next control using it, but (reproducing the exact bug)
  // rejects it when given the OLD stale selector directly. ----
  var nextDetectLoaded = loadNextDetectAgainstDocument(built.dom.document, 'https://' + HOSTNAME + '/s?k=desk+lamp');
  var WSNextDetect = nextDetectLoaded.WSNextDetect;
  var withStale = WSNextDetect.findNextControl(STALE_SELECTOR);
  assert(withStale.found === false, 'MISSION PROOF (bug reproduction): using the OLD stale selector directly, findNextControl() still rejects the real Next control — got ' + JSON.stringify(withStale));

  var withMigrated = WSNextDetect.findNextControl(reloadedState.containerSelector);
  assert(withMigrated.found === true, 'MISSION PROOF (FIX, requirement 4/7): using the CANONICAL, migrated selector, findNextControl() finds the real Next control — got ' + JSON.stringify(withMigrated));
  withMigrated.trigger();
  // REAL AMAZON EVIDENCE mission (later round) — the real Next link has
  // a verified higher-page href, so its trigger now navigates directly
  // instead of dispatching a synthetic click.
  var expectedHref = new URL(built.nextLink.getAttribute('href'), 'https://' + HOSTNAME + '/s?k=desk+lamp').toString();
  assert(nextDetectLoaded.navigated.to === expectedHref, 'MISSION PROOF: the trigger actually navigates to the REAL Next link\'s own href — got ' + JSON.stringify(nextDetectLoaded.navigated.to));

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
