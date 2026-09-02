/**
 * pagination-not-scoped-to-container.test.js (FAST/local, no browser)
 * REAL AMAZON EVIDENCE mission — investigates a specific hypothesis for
 * why production still reported nextCandidateFound=false /
 * "1 sayfa tarandı" even after the clickTrigger direct-navigation fix:
 * "production findNextControl(containerSelector) searches only INSIDE
 * the product-row container, so Amazon's pagination bar — which lives
 * OUTSIDE/adjacent to it — can never be found."
 *
 * TRACE (content/nextdetect.js, read before writing this test — no
 * code changed): `containerSelector` is used in exactly ONE place,
 * rejected()/isInsideScraperContainer() -> `el.closest(containerSelector)`
 * — this only ever EXCLUDES a candidate whose ANCESTOR matches the
 * selector (never click inside my own repeating container — the
 * per-card image-carousel-arrow case the file's own header comment
 * documents). Every actual SEARCH in this file
 * (candidateElements()/document.querySelectorAll, findPaginationRegions'
 * own landmark/cluster queries, findWithinRegion's own
 * region.querySelectorAll) operates on the WHOLE DOCUMENT or on a
 * REGION discovered independently — never restricted to
 * `containerSelector`'s own matches. A Next control living in a
 * sibling/adjacent DOM branch from the product-row container (this
 * test's own exact fixture, matching the mission's own requested real
 * structure) has no ancestor matching `.product-results-container` at
 * all, so isInsideScraperContainer() is false — it is never excluded.
 *
 * RESULT: this test PROVES the hypothesis is FALSE — the current,
 * completely UNMODIFIED content/nextdetect.js and content/discovery.js
 * already find and trigger a real Next control living outside the
 * stored product-row containerSelector, exactly as the architecture
 * requires ("containerSelector scopes ROW extraction; pagination
 * detection searches the page/document independently"). No code was
 * changed to produce this result — this file is diagnosis-only, per
 * this mission's own explicit instruction not to modify any code until
 * the hypothesis was proven.
 *
 * Standalone-runnable: `node tests/unit/pagination-not-scoped-to-container.test.js`.
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

/** Builds EXACTLY the structure this mission specified:
 *   <div id="search">
 *     <div class="product-results-container"> [48 product rows] </div>
 *     <div class="pagination"> <a class="s-pagination-next" ...>Next</a> </div>
 *   </div>
 * Plus a sidebar/filter/related-search block, sibling to #search, to
 * additionally prove no leakage into extraction. */
function buildFixture() {
  var dom = createMiniDocument();
  var body = dom.body;
  var searchDiv = el('div', { id: 'search' });

  var resultsContainer = el('div', { class: 'product-results-container' });
  for (var i = 1; i <= CARD_COUNT; i++) {
    var card = el('div', { class: 's-result-item s-asin', 'data-component-type': 's-search-result', 'data-asin': 'B0TEST' + i });
    card.appendChild(el('h2', {}, 'Desk Lamp Model ' + i));
    card.appendChild(el('span', { class: 'a-color-base' }, '$' + (10 + i) + '.99'));
    resultsContainer.appendChild(card);
  }
  searchDiv.appendChild(resultsContainer);

  var paginationDiv = el('div', { class: 'pagination' });
  var nextLink = el('a', {
    class: 's-pagination-next',
    href: '/s?k=desk+lamp&page=2&ref=sr_pg_1',
    'aria-label': 'Go to next page, page 2'
  }, 'Next');
  paginationDiv.appendChild(nextLink);
  searchDiv.appendChild(paginationDiv);
  body.appendChild(searchDiv);

  // Sidebar/filter/related-search block, sibling to #search — must
  // never leak into extraction or be mistaken for a pagination region.
  var sidebar = el('div', { class: 'filter-panel' });
  ['Customer Reviews', 'Brands', 'Color & Finish', 'Wattage'].forEach(function (t) {
    sidebar.appendChild(el('div', {}, t));
  });
  var related = el('div', { class: 'related-searches' });
  related.appendChild(el('a', { href: '/s?k=related-lamp' }, 'Related search'));
  body.appendChild(sidebar);
  body.appendChild(related);

  return { dom: dom, nextLink: nextLink, resultsContainer: resultsContainer };
}

function loadNextDetect(document, locationHref) {
  var url = new URL(locationHref);
  var navigated = { to: null };
  var loc = { href: url.href, hostname: url.hostname, pathname: url.pathname, search: url.search };
  Object.defineProperty(loc, 'href', {
    get: function () { return navigated.to || url.href; },
    set: function (v) { navigated.to = v; }
  });
  var sandbox = {
    console: console, URL: URL, URLSearchParams: URLSearchParams,
    document: document, location: loc,
    MouseEvent: function (type) { this.type = type; },
    window: null
  };
  sandbox.window = sandbox;
  sandbox.window.getComputedStyle = function () { return { display: 'block', visibility: 'visible' }; };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, 'content', 'nextdetect.js'), 'utf8'), sandbox, { filename: 'content/nextdetect.js' });
  return { WSNextDetect: sandbox.WSNextDetect, navigated: navigated };
}

async function run() {
  const suite = makeSuite('pagination-not-scoped-to-container');
  const assert = suite.assert;

  var built = buildFixture();
  // The mission's own diagram shows product rows NESTED inside
  // ".product-results-container" — the REAL, per-ROW containerSelector
  // production actually stores/uses for extraction is naturally scoped
  // to the repeating card element itself (matching every real
  // containerSelector this codebase has ever produced — one selector
  // per REPEATED record, never the single outer wrapper that holds all
  // of them). ".product-results-container .s-result-item" is exactly
  // that: still fully NESTED inside the wrapper the diagram shows
  // (proving the hypothesis fairly — pagination is still the same
  // "outside/adjacent" distance away), but pointing at the 48 actual
  // repeating rows so the extraction proof below is meaningful.
  var CONTAINER_SELECTOR = '.product-results-container .s-result-item';

  // ---- Sanity: the stored containerSelector matches exactly the 48 real
  // product rows, and the pagination Next link is genuinely NOT one of
  // them, nor inside any of them. ----
  var matchCount = built.dom.document.querySelectorAll(CONTAINER_SELECTOR).length;
  assert(matchCount === CARD_COUNT, 'MISSION PROOF (fixture sanity): the containerSelector matches exactly the ' + CARD_COUNT + ' real product rows — got ' + matchCount);
  assert(built.resultsContainer.querySelectorAll('a.s-pagination-next').length === 0, 'MISSION PROOF (fixture sanity): the pagination Next link is NOT inside .product-results-container at all — confirms this fixture matches the mission\'s own requested real structure');

  // ---- THE HYPOTHESIS TEST: run the REAL, completely unmodified
  // findNextControl() with the EXACT containerSelector production
  // stores (scoped only to product rows, never touching pagination). ----
  var loaded = loadNextDetect(built.dom.document, 'https://' + HOSTNAME + '/s?k=desk+lamp');
  var result = loaded.WSNextDetect.findNextControl(CONTAINER_SELECTOR);
  assert(result.found === true, 'MISSION PROOF (HYPOTHESIS DISPROVED): findNextControl(containerSelector) DOES find the Next control living outside the product-row container — got ' + JSON.stringify(result) + '. If this were false, the container-scoping hypothesis would be CONFIRMED instead.');
  assert(result.disabled === false, 'MISSION PROOF: the real Next control is correctly reported as enabled');
  assert(result.method === 'pagination-landmark', 'MISSION PROOF: found via the loose "next"-text tier (aria-label "Go to next page, page 2") — matches the real diagnostic\'s own finding exactly — got ' + result.method);

  result.trigger();
  assert(loaded.navigated.to === 'https://' + HOSTNAME + '/s?k=desk+lamp&page=2&ref=sr_pg_1', 'MISSION PROOF: the trigger navigates directly to the real page=2 target — got ' + JSON.stringify(loaded.navigated.to));

  // ---- Extraction sanity: 48 rows in, 48 rows out, no sidebar/filter/
  // related-search leakage — proves the container selector itself is
  // completely unaffected by any of this. ----
  var selectorSrc = fs.readFileSync(path.join(REPO_ROOT, 'content', 'selector.js'), 'utf8');
  var scraperSrc = fs.readFileSync(path.join(REPO_ROOT, 'content', 'scraper.js'), 'utf8');
  var extractSandbox = {
    console: console, document: built.dom.document,
    location: { href: 'https://' + HOSTNAME + '/s?k=desk+lamp', hostname: HOSTNAME },
    window: null
  };
  extractSandbox.window = extractSandbox;
  extractSandbox.document.baseURI = 'https://' + HOSTNAME + '/s?k=desk+lamp';
  vm.createContext(extractSandbox);
  vm.runInContext(selectorSrc, extractSandbox, { filename: 'content/selector.js' });
  vm.runInContext(scraperSrc, extractSandbox, { filename: 'content/scraper.js' });
  var extraction = extractSandbox.WSScraper.runExtraction({
    containerSelector: CONTAINER_SELECTOR,
    columns: [
      { id: 'title', name: 'Title', relativeSelector: 'h2', attribute: 'text' },
      { id: 'price', name: 'Price', relativeSelector: 'span.a-color-base', attribute: 'text' }
    ]
  });
  assert(extraction.rows.length === CARD_COUNT, 'MISSION PROOF: 48 product rows remain 48 — got ' + extraction.rows.length);
  var leaked = extraction.rows.some(function (r) {
    return ['Customer Reviews', 'Brands', 'Color & Finish', 'Wattage', 'Related search', 'Next'].indexOf(r.title) !== -1;
  });
  assert(!leaked, 'MISSION PROOF: no sidebar/filter/related-search/pagination text leaked into extracted rows');

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
