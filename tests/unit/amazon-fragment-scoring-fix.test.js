/**
 * amazon-fragment-scoring-fix.test.js (FAST/local, no browser)
 * REAL AMAZON EVIDENCE mission — this fixes the exact failure proven by
 * the persisted diagnostics from a real, failed Amazon run (Copy AUTO
 * Diagnostic / Copy Pagination Diagnostic, both dev-only tools already in
 * this codebase), not a hypothetical:
 *
 *   raw=242, duplicates=75, datasetAfter=167, against ~48 real visible
 *   product cards. The persisted scraper config's containerSelector was
 *   "div.a-section.a-spacing-none" — Amazon's own generic internal
 *   utility-class combo, reused throughout the WHOLE page (inside every
 *   product card's own title/price/rating rows, AND inside the sidebar
 *   filter panel, AND inside the pagination wrapper) — never a
 *   product-card-specific class. The extracted rows themselves proved
 *   this: "Customer Reviews", "Color & Finish", "Brands", "Wattage",
 *   standalone ratings/prices, filter/sidebar text — none of that is a
 *   product.
 *
 *   Pagination diagnostic on the SAME run: pagesVisited=1,
 *   nextCandidateFound=false, outcome="no-next-candidate". This is not
 *   an independent bug: content/nextdetect.js's isInsideScraperContainer()
 *   correctly excludes any element whose ancestor matches the scraper's
 *   own containerSelector (never click inside my own repeating
 *   container) — but when that selector is as broad and ubiquitous as
 *   "div.a-section.a-spacing-none", it can legitimately also match an
 *   ancestor of the SITE'S OWN pagination strip, wrongly excluding the
 *   real Next control at every detection tier. Fixing the container
 *   selector (this file) fixes both symptoms at once — proven end-to-end
 *   below using the REAL, unmodified content/nextdetect.js.
 *
 * ROOT CAUSE (content/autodetect.js — content/discovery.js/nextdetect.js/
 * autoscroll.js/loadmore.js/autopaginate.js/background/Detail
 * Enrichment/export logic all completely untouched): consolidateFragmentedGroups()
 * (added in the previous ROW/CONTAINER OVER-COUNTING FIX mission) already
 * computed, for every candidate it folds together from many different
 * DOM parents, exactly how many DISTINCT PARENTS those elements came
 * from (consolidatedFromParentCount) — but that number was never fed
 * back into scoreCandidate()/computeCandidateSignals(). A consolidated
 * candidate therefore competed purely on its raw content signals (link/
 * image/price ratios, text length, consistency), with nothing penalizing
 * the one structural fact that actually separates "one row per record"
 * from "several fragments per record": a genuine repeating item
 * container has close to ONE element per distinct parent (the real
 * cards are themselves the direct children of one shared results grid),
 * while an internal layout primitive reused several times INSIDE every
 * card contributes SEVERAL elements per distinct parent.
 *
 * FIX (both in content/autodetect.js, see that file's own comments for
 * the full mechanism):
 *   1. A fragmentation penalty in computeCandidateSignals(), scaled by
 *      elementsPerParent = itemCount / consolidatedFromParentCount —
 *      zero for any non-consolidated candidate (the ordinary,
 *      already-correct case for every previously-verified site) or one
 *      whose ratio is already close to 1.
 *   2. Evenly-spaced sampling (sampleEvenly) instead of always sampling
 *      the first N elements — for any candidate with n <= 12 (every
 *      existing fixture) this is byte-for-byte identical to before;
 *      it only changes behavior for a large, heterogeneous, consolidated
 *      candidate, so a garbage-diluted population can no longer hide
 *      behind a lucky run of "early" clean-looking instances.
 *
 * Generic by construction — the fixture below uses invented class names
 * ("card-result", "a-section", "filter-option", "pagination-strip", ...)
 * standing in for whatever a real site's own design system calls them;
 * nothing in the fix or this test is keyed to any hostname or specific
 * class name.
 *
 * Standalone-runnable: `node tests/unit/amazon-fragment-scoring-fix.test.js`.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadAutoDetect } = require('../lib/load-autodetect');
const { el } = require('../lib/mini-dom');
const { makeSuite } = require('../lib/assert');

const NEXTDETECT_PATH = path.join(__dirname, '..', '..', 'content', 'nextdetect.js');
const CARD_COUNT = 48;
const FILTER_COUNT = 20; // deliberately larger than the previous mission's fixture — real facet panels list many values (several categories x several options each)
const RELATED_COUNT = 6;

/** One Amazon-like product card: an outer `.card-result` wrapper whose
 * direct children are FOUR internal `.a-section` layout rows (title+
 * link, image, price, rating) — the exact "internal fragment reused
 * several times per card" shape the real diagnostic traced. */
function buildCard(n) {
  var card = el('div', { class: 'card-result' });
  var titleRow = el('div', { class: 'a-section' });
  var link = el('a', { href: '/dp/PRODUCT-' + n });
  link.appendChild(el('h2', {}, 'Desk Lamp Model ' + n));
  titleRow.appendChild(link);
  var imageRow = el('div', { class: 'a-section' });
  imageRow.appendChild(el('img', { src: 'https://img.example.com/lamp-' + n + '.jpg' }));
  var priceRow = el('div', { class: 'a-section' }, '$' + (10 + n) + '.99');
  var ratingRow = el('div', { class: 'a-section' }, (4 + (n % 2) * 0.5) + ' stars (' + (n * 3) + ')');
  card.appendChild(titleRow);
  card.appendChild(imageRow);
  card.appendChild(priceRow);
  card.appendChild(ratingRow);
  return card;
}

/** Builds the full page: results grid (48 cards), a filter sidebar whose
 * facet headers/values ALSO carry the ubiquitous ".a-section" class
 * (exactly the real report's "Customer Reviews"/"Brands"/"Color &
 * Finish"/"Wattage" garbage rows — a shared design-system utility class,
 * not a product-card-specific one), a related-searches block, and a
 * pagination strip whose OWN wrapper is ALSO ".a-section" (reproducing
 * the real diagnostic's second symptom: an over-broad container selector
 * swallowing the site's own pagination control as "inside my own
 * container"). */
function buildFixture() {
  var loaded = loadAutoDetect();
  var body = loaded.dom.body;

  var grid = el('div', { class: 'search-results-grid' });
  for (var i = 1; i <= CARD_COUNT; i++) grid.appendChild(buildCard(i));
  body.appendChild(grid);

  var sidebar = el('div', { class: 'filter-panel' });
  var facetLabels = ['Customer Reviews', '4 Stars & Up', '3 Stars & Up', 'Brands', 'Acme', 'Globex', 'Umbrella', 'Color & Finish', 'Black', 'White', 'Silver', 'Wattage', '40W', '60W', '100W', 'Premium Brands', 'Contoso', 'Initech', 'Base Diameter', '6 inch'];
  for (var f = 0; f < FILTER_COUNT; f++) {
    // Same ubiquitous ".a-section" class as the card's internal rows —
    // no link, no image, no price: pure filter/facet text.
    sidebar.appendChild(el('div', { class: 'a-section' }, facetLabels[f] || ('Filter ' + f)));
  }
  body.appendChild(sidebar);

  var related = el('div', { class: 'related-searches' });
  for (var r = 1; r <= RELATED_COUNT; r++) {
    related.appendChild(el('a', { class: 'related-search-link', href: '/s?k=related-' + r }, 'Related search ' + r));
  }
  body.appendChild(related);

  // Pagination strip: the OUTER wrapper itself also carries the same
  // ubiquitous ".a-section" class (a real, common pattern — a generic
  // design-system utility class wraps essentially every visual block on
  // the page, pagination included), while the strip's own class
  // separately identifies it as a pagination landmark for nextdetect.js.
  var paginationWrapper = el('div', { class: 'a-section' });
  var paginationNav = el('nav', { class: 'pagination-strip', 'aria-label': 'Pagination' });
  for (var p = 1; p <= 7; p++) {
    paginationNav.appendChild(el('a', { href: '?k=desk+lamp&page=' + p }, String(p)));
  }
  var nextLink = el('a', { href: '?k=desk+lamp&page=2', class: 'pagination-strip-next' }, 'Next');
  paginationNav.appendChild(nextLink);
  paginationWrapper.appendChild(paginationNav);
  body.appendChild(paginationWrapper);

  return { loaded: loaded, nextLink: nextLink };
}

/** Loads the REAL, unmodified content/nextdetect.js into its own vm
 * sandbox, but reusing the SAME mini-dom `document` the fixture above was
 * built in — so findNextControl() sees the exact same page. */
function loadNextDetectAgainstDocument(document, locationHref) {
  var url = new URL(locationHref);
  var navigated = { to: null };
  var loc = { href: url.href, hostname: url.hostname, pathname: url.pathname, search: url.search };
  var sandbox = {
    console: console, URL: URL, URLSearchParams: URLSearchParams,
    document: document,
    location: loc,
    // Minimal MouseEvent stub — content/nextdetect.js's clickTrigger()
    // constructs `new MouseEvent('click', {...})` before dispatching it;
    // mini-dom's dispatchEvent only reads `.type` off whatever object it
    // receives, so a plain constructor recording just that is sufficient.
    MouseEvent: function (type) { this.type = type; },
    window: null
  };
  // REAL AMAZON EVIDENCE mission — clickTrigger() now navigates directly
  // (location.href = ...) for a real anchor with a verified higher-page
  // href, instead of always dispatching a synthetic click — track that
  // too, so tests can observe whichever mechanism the real trigger
  // actually used.
  Object.defineProperty(loc, 'href', {
    get: function () { return navigated.to || url.href; },
    set: function (v) { navigated.to = v; }
  });
  sandbox.window = sandbox;
  sandbox.window.getComputedStyle = function () { return { display: 'block', visibility: 'visible' }; };
  vm.createContext(sandbox);
  var code = fs.readFileSync(NEXTDETECT_PATH, 'utf8');
  vm.runInContext(code, sandbox, { filename: NEXTDETECT_PATH });
  return { WSNextDetect: sandbox.WSNextDetect, navigated: navigated };
}

async function run() {
  const suite = makeSuite('amazon-fragment-scoring-fix');
  const assert = suite.assert;

  var built = buildFixture();
  var WSAutoDetect = built.loaded.WSAutoDetect;
  var WSSelector = built.loaded.WSSelector;
  var WSScraper = built.loaded.WSScraper;

  // ---- Diagnostics: the fragmentation penalty actually fired on the
  // consolidated ".a-section" candidate ----
  var diag = WSAutoDetect.runAutoDetectDiagnostic();
  var aSectionRaw = diag.topCandidatesBeforeRanking.filter(function (c) { return c.approxSelector.indexOf('a-section') !== -1; });
  assert(aSectionRaw.length > 0, 'MISSION PROOF: the consolidated ".a-section" candidate is present among the scored candidates (never silently deleted, just outscored)');
  assert(aSectionRaw.some(function (c) { return c.fragmentationPenaltyApplied > 0; }), 'MISSION PROOF: the fragmentation penalty actually fired on the ".a-section" candidate — got ' + JSON.stringify(aSectionRaw.map(function (c) { return { itemCount: c.itemCount, consolidatedFromParentCount: c.consolidatedFromParentCount, elementsPerParent: c.elementsPerParent, fragmentationPenaltyApplied: c.fragmentationPenaltyApplied, score: c.score }; })));

  // ---- The winning structure is the CARD level, not the internal
  // ".a-section" fragment level, and not the sidebar/pagination noise ----
  var result = WSAutoDetect.runAutoDetect();
  assert(result.ok && result.structures.length > 0, 'MISSION PROOF: Auto Detect finds at least one structure on the fixture');
  var winner = result.structures[0];
  assert(Math.abs(winner.itemCount - CARD_COUNT) <= 2, 'MISSION PROOF: the winning structure\'s item count (' + winner.itemCount + ') is ~' + CARD_COUNT + ', not the internal-fragment count or the filter/sidebar count — got ' + JSON.stringify({ label: winner.label, itemCount: winner.itemCount, containerSelector: winner.containerSelector, score: winner.score }));
  assert(winner.containerSelector.indexOf('a-section') === -1, 'MISSION PROOF: the winning containerSelector is not the ubiquitous internal-fragment class — got ' + JSON.stringify(winner.containerSelector));

  // ---- Real extraction through the unmodified content/scraper.js: one
  // row per product card, zero garbage rows ----
  var columns = [
    { id: 'title', name: 'Title', relativeSelector: 'h2', attribute: 'text' },
    { id: 'link', name: 'Link', relativeSelector: 'a', attribute: 'href' },
    { id: 'image', name: 'Image', relativeSelector: 'img', attribute: 'src' }
  ];
  var extraction = WSScraper.runExtraction({ containerSelector: winner.containerSelector, columns: columns });
  assert(extraction.rows.length === CARD_COUNT, 'MISSION PROOF: real extraction with the winning selector produces exactly ' + CARD_COUNT + ' rows — got ' + extraction.rows.length);
  var links = extraction.rows.map(function (r) { return r.link; }).filter(Boolean);
  assert(links.every(function (l) { return /\/dp\/PRODUCT-\d+$/.test(l); }), 'MISSION PROOF: every extracted row is a real product card — no "Customer Reviews"/"Brands"/"Wattage"/filter/related-search/pagination rows leaked in');
  assert(WSSelector.countMatches(winner.containerSelector) === CARD_COUNT, 'MISSION PROOF: the winning selector matches exactly ' + CARD_COUNT + ' elements page-wide — got ' + WSSelector.countMatches(winner.containerSelector));

  // ---- Next detection, using the REAL, unmodified content/nextdetect.js
  // and the WINNING (now correctly-scoped) containerSelector: the real
  // visible "1 2 3 ... 7 Next" pagination control is found, proving the
  // second real-run symptom (nextCandidateFound=false) was a direct
  // consequence of the first bug, not an independent nextdetect.js defect. ----
  var nextDetectLoaded = loadNextDetectAgainstDocument(built.loaded.dom.document, 'https://shop.example.com/s?k=desk+lamp');
  var WSNextDetect = nextDetectLoaded.WSNextDetect;
  var nextResult = WSNextDetect.findNextControl(winner.containerSelector);
  assert(nextResult.found === true, 'MISSION PROOF: with the correctly-scoped container selector, the real Next control IS found — got ' + JSON.stringify(nextResult));
  assert(nextResult.trigger, 'MISSION PROOF: the found Next control has a real trigger function');

  // ---- ROOT CAUSE C fix (later mission round): findNextControl() no
  // longer blindly trusts an implausibly broad containerSelector for its
  // exclusion check — a selector matching more than half of all page
  // elements can't be a genuine "one repeated record" selector, so it's
  // no longer used to exclude anything. Using the SAME over-broad
  // ".a-section" selector directly (simulating exactly what the
  // persisted real-run config actually was) now correctly finds the
  // real Next control anyway — pagination detection is architecturally
  // independent of the record container, not merely lucky when the
  // container happens to be well-scoped. ----
  var nextResultWithBadSelector = WSNextDetect.findNextControl('.a-section');
  assert(nextResultWithBadSelector.found === true, 'MISSION PROOF (ROOT CAUSE C): with the OLD over-broad ".a-section" container selector, findNextControl no longer trusts it for exclusion and still finds the real Next control — got ' + JSON.stringify(nextResultWithBadSelector));

  // ---- An unrelated "Next" button living inside an obvious carousel/
  // slider widget (a per-card image-gallery arrow, NOT site pagination —
  // spec's own "never click: ads, product cards, unrelated arrows,
  // carousel next buttons") must still never win — the real site
  // pagination is found instead, proving the fix doesn't weaken this
  // pre-existing exclusion. ----
  var carouselDecoy = el('div', { class: 'image-carousel' });
  carouselDecoy.appendChild(el('button', {}, 'Next'));
  built.loaded.dom.body.appendChild(carouselDecoy);
  var nextResult2 = WSNextDetect.findNextControl(winner.containerSelector);
  assert(nextResult2.found === true, 'MISSION PROOF: a carousel-wrapped decoy "Next" button does not break detection — got ' + JSON.stringify(nextResult2));
  assert(nextResult2.method !== undefined && nextResult2.trigger, 'MISSION PROOF: the found control has a real trigger');
  // Confirm it's genuinely the real pagination Next, not the carousel
  // decoy: triggering it must dispatch a real click on the real anchor.
  nextResult2.trigger();
  // REAL AMAZON EVIDENCE mission (later round) — the real Next link has
  // a verified higher-page href, so its trigger now navigates directly
  // (location.href = ...) instead of dispatching a synthetic click; a
  // direct navigation to the REAL link's own target is just as strong
  // proof it's not the carousel decoy (which has no real href at all).
  var expectedHref = new URL(built.nextLink.getAttribute('href'), 'https://shop.example.com/s?k=desk+lamp').toString();
  assert(nextDetectLoaded.navigated.to === expectedHref, 'MISSION PROOF: the trigger actually navigates to the REAL pagination Next link\'s own href (' + expectedHref + '), not the carousel decoy — got ' + JSON.stringify(nextDetectLoaded.navigated.to));

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
