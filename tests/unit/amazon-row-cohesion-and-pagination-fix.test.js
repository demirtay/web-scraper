/**
 * amazon-row-cohesion-and-pagination-fix.test.js (FAST/local, no browser)
 * REAL AMAZON EVIDENCE mission (2nd round) — this fixes the exact
 * mechanism proven by the real persisted scraperConfig from a failed
 * Amazon run:
 *
 *   containerSelector: "div.a-section.a-spacing-none"
 *   title relativeSelector: "h2.a-size-base-plus.a-spacing-none.a-color-base.a-text-normal"
 *   price relativeSelector: "span.a-color-base"
 *   raw=242, duplicates=75, final unique=167 (against ~48 real cards)
 *   garbage rows: "Customer Reviews", "Color & Finish", "Brands",
 *   "Wattage", "4.7", "TRY 1,640.85", "Amazon's Choice: Overall Pick", ...
 *
 * The title and price relativeSelectors prove Title and Price were each
 * individually detected with SOME nonzero coverage, but on almost
 * entirely DISJOINT subsets of the container's own matched instances —
 * this fixture reproduces that exact shape: each card's Title lives in
 * one ".a-section" fragment, Price in a completely SEPARATE
 * ".a-section" fragment, never together on the same instance, and the
 * card wrapper itself carries no clean, semantically-named class (only
 * Amazon-realistic noisy grid-utility classes) — the previous mission's
 * fragmentation-penalty fix alone was not proven sufficient against this
 * exact shape (see the "BEFORE" block below, run with both new rules
 * disabled), only cohesion closes it decisively.
 *
 * Pagination diagnostic on the same real run: pagesVisited=1,
 * nextCandidateFound=false, outcome="no-next-candidate". This fixture's
 * pagination strip uses an ICON-ONLY Next control (no text, no
 * aria-label — a real, common shape no earlier tier in
 * content/nextdetect.js could ever find, since Tier 1/4 need an <a href>
 * with rel="next" or a URL that already advances the page, and Tier 2/3
 * both require matching TEXT) to exercise the new Tier 5 structural
 * fallback specifically.
 *
 * ROW FIX (content/autodetect.js — see TASK 2/4 comments on
 * computeRowCohesion/runAutoDetect for the full mechanism): a row-
 * cohesion penalty, fed by resolving every candidate's OWN detected
 * fields against an evenly-spread sample of its own instances and
 * checking how often those fields resolve to a value TOGETHER on the
 * SAME instance — a multi-field candidate whose fields never co-occur
 * is heavily disqualified regardless of any other signal. Also: TASK 3's
 * addAnchoredCandidates(), which climbs from a heading via the
 * already-proven Sel.findRepeatingContainer (Manual Mode's own
 * algorithm) to discover the correct card-level container structurally,
 * independent of whether that container has any class of its own.
 *
 * PAGINATION FIX (content/nextdetect.js — see TASK 6 comments on Tier 5/
 * findPageNumberCluster for the full mechanism): a new, purely
 * structural fallback tier — find a genuine cluster of >= 3 sibling
 * page-NUMBER links/buttons, locate the current page's own entry, and
 * take whichever clickable element comes immediately after it,
 * regardless of that element's own accessible name.
 *
 * Generic by construction — every class name below is invented, standing
 * in for whatever a real site's own design system calls its analogous
 * elements; nothing in either fix or this test is keyed to any hostname.
 *
 * Standalone-runnable: `node tests/unit/amazon-row-cohesion-and-pagination-fix.test.js`.
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

/** One real-evidence-shaped product card: a wrapper with NO clean
 * semantic class (only Amazon-realistic noisy grid-utility classes —
 * "sg-col-4-of-24" etc.), whose Title lives in ONE internal ".a-section"
 * fragment and Price in a COMPLETELY SEPARATE one — the exact disjoint
 * shape the real persisted relativeSelectors proved. */
function buildCard(n) {
  var card = el('div', { class: 'sg-col-4-of-24 sg-col-4-of-12 s-widget-spacing-small sg-col' });
  var titleRow = el('div', { class: 'a-section a-spacing-none' });
  var link = el('a', { href: '/dp/PRODUCT-' + n });
  link.appendChild(el('h2', { class: 'a-size-base-plus a-spacing-none a-color-base a-text-normal' }, 'Desk Lamp Model ' + n));
  titleRow.appendChild(link);
  var priceRow = el('div', { class: 'a-section a-spacing-none' });
  priceRow.appendChild(el('span', { class: 'a-color-base' }, 'TRY ' + (1000 + n * 10) + '.85'));
  var ratingRow = el('div', { class: 'a-section a-spacing-none' }, (4 + (n % 2) * 0.5) + ' stars');
  var badgeRow = el('div', { class: 'a-section a-spacing-none' }, n <= 3 ? "Amazon's Choice: Overall Pick" : '');
  card.appendChild(titleRow);
  card.appendChild(priceRow);
  card.appendChild(ratingRow);
  if (n <= 3) card.appendChild(badgeRow);
  return card;
}

function buildFixture() {
  var loaded = loadAutoDetect();
  var body = loaded.dom.body;

  var grid = el('div', { class: 'search-results-grid' });
  for (var i = 1; i <= CARD_COUNT; i++) grid.appendChild(buildCard(i));
  body.appendChild(grid);

  // Sidebar/filter labels using the SAME generic ".a-section" wrapper —
  // real evidence's exact garbage rows.
  var sidebar = el('div', { class: 'filter-panel' });
  ['Customer Reviews', '4 Stars & Up', '3 Stars & Up', 'Brands', 'Acme', 'Globex', 'Color & Finish', 'Black', 'White', 'Wattage', '40W', '60W', 'Premium Brands', 'Contoso', 'Base Diameter', '6 inch', 'Recycled materials', 'Certification Body', 'Popular Shopping Ideas'].forEach(function (t) {
    sidebar.appendChild(el('div', { class: 'a-section a-spacing-none' }, t));
  });
  body.appendChild(sidebar);

  // Unrelated UI section using the same generic classes (e.g. a
  // "related products" strip) — must not leak into the dataset either.
  var relatedStrip = el('div', { class: 'a-section a-spacing-none' });
  relatedStrip.appendChild(el('span', {}, 'Popular Shopping Ideas'));
  body.appendChild(relatedStrip);

  // Pagination: "Previous 1 2 3 ... 7 [icon-only Next]" — a real, common
  // client-side-rendered shape where the page-number entries are JS-
  // driven <button>s with NO real navigation href at all (so Tier 4's
  // href-page-number fallback, which only ever considers <a> elements,
  // genuinely cannot fire on any of them), and the Next control itself
  // has NO text and NO aria-label either — sitting immediately after the
  // numbered cluster.
  var pagination = el('nav', { class: 'pagination-strip', 'aria-label': 'Pagination' });
  pagination.appendChild(el('button', {}, 'Previous'));
  for (var p = 1; p <= 7; p++) {
    pagination.appendChild(el('button', {}, String(p)));
  }
  var iconOnlyNext = el('button', { class: 'pagination-icon-btn' }); // no text, no aria-label
  pagination.appendChild(iconOnlyNext);
  body.appendChild(pagination);

  return { loaded: loaded, iconOnlyNext: iconOnlyNext };
}

function loadNextDetectAgainstDocument(document, locationHref) {
  var url = new URL(locationHref);
  var sandbox = {
    console: console, URL: URL, URLSearchParams: URLSearchParams,
    document: document,
    location: { href: url.href, hostname: url.hostname, pathname: url.pathname, search: url.search },
    MouseEvent: function (type) { this.type = type; },
    window: null
  };
  sandbox.window = sandbox;
  sandbox.window.getComputedStyle = function () { return { display: 'block', visibility: 'visible' }; };
  vm.createContext(sandbox);
  var code = fs.readFileSync(NEXTDETECT_PATH, 'utf8');
  vm.runInContext(code, sandbox, { filename: NEXTDETECT_PATH });
  return sandbox.WSNextDetect;
}

async function run() {
  const suite = makeSuite('amazon-row-cohesion-and-pagination-fix');
  const assert = suite.assert;

  var built = buildFixture();
  var WSAutoDetect = built.loaded.WSAutoDetect;
  var WSSelector = built.loaded.WSSelector;
  var WSScraper = built.loaded.WSScraper;

  // ================================================================
  // TASK 1/PART A — trace the exact decision rule (BEFORE: the HARD
  // co-occurrence gate disabled, simulating the OLD "score penalty
  // only" design this round explicitly replaced) vs the shipped AFTER
  // state (the gate active — the fragment candidate must be IMPOSSIBLE
  // to select, not merely outscored).
  // ================================================================
  var autodetectSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'content', 'autodetect.js'), 'utf8');
  var beforeSrc = autodetectSrc
    .replace(
      /continue; \/\/ HARD GATE — this candidate can never become a structure, at any score/,
      '/* HARD GATE disabled for BEFORE trace */'
    )
    // Isolating the cohesion gate specifically also means disabling the
    // separate under-match safety net added the SAME round (a real,
    // independently-discovered bug fix: commonStableClasses() needs
    // siblingEls to compute the TRUE common-class intersection instead
    // of just the representative element's own full class list) — this
    // BEFORE trace is only meant to prove the cohesion gate's own
    // necessity, not conflate it with this unrelated fix.
    .replace(
      /if \(realMatchCount < candidate\.elements\.length\) continue; \/\/ under-matching[^\n]*\n/,
      ''
    );
  assert(beforeSrc !== autodetectSrc, 'TEST SETUP: the BEFORE-trace regex replacements actually matched the real source (if this fails, the source changed shape and the BEFORE simulation below is not meaningful — fix the replaced patterns, don\'t ignore this)');
  function runVariant(src) {
    var dom = require('../lib/mini-dom').createMiniDocument();
    dom.document.baseURI = 'https://shop.example.com/s?k=desk+lamp';
    var sandbox = {
      console: console, URL: URL, URLSearchParams: URLSearchParams, document: dom.document,
      location: { href: 'https://shop.example.com/s?k=desk+lamp', hostname: 'shop.example.com', pathname: '/s', search: '?k=desk+lamp' },
      NodeFilter: { SHOW_ELEMENT: 1 },
      getComputedStyle: function () { return { display: 'block', visibility: 'visible' }; },
      chrome: { runtime: { onMessage: { addListener: function () {} } } }, window: null
    };
    sandbox.window = sandbox; sandbox.window.getComputedStyle = sandbox.getComputedStyle;
    vm.createContext(sandbox);
    ['content/selector.js', 'content/scraper.js'].forEach(function (rel) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8'), sandbox, { filename: rel });
    });
    vm.runInContext(src, sandbox, { filename: 'content/autodetect.js (variant)' });
    var body = dom.body;
    var grid = el('div', { class: 'search-results-grid' });
    for (var i = 1; i <= CARD_COUNT; i++) grid.appendChild(buildCard(i));
    body.appendChild(grid);
    var sidebar = el('div', { class: 'filter-panel' });
    ['Customer Reviews', '4 Stars & Up', 'Brands', 'Color & Finish', 'Wattage', 'Premium Brands', 'Base Diameter', 'Recycled materials', 'Certification Body', 'Popular Shopping Ideas'].forEach(function (t) {
      sidebar.appendChild(el('div', { class: 'a-section a-spacing-none' }, t));
    });
    body.appendChild(sidebar);
    return sandbox.WSAutoDetect.runAutoDetect();
  }
  var beforeResult = runVariant(beforeSrc);
  var afterResult = runVariant(autodetectSrc);
  var beforeFragment = beforeResult.structures.filter(function (s) { return s.containerSelector.indexOf('a-section') !== -1; })[0];
  var afterFragment = afterResult.structures.filter(function (s) { return s.containerSelector.indexOf('a-section') !== -1; })[0];
  assert(beforeFragment, 'MISSION PROOF (TASK 1 trace — OLD design simulated): with the hard gate disabled, the ".a-section" fragment candidate is still SELECTABLE (reported as a structure) — got structures ' + JSON.stringify(beforeResult.structures.map(function (s) { return s.containerSelector; })));
  assert(!afterFragment, 'MISSION PROOF (PART A hard invariant): with the shipped fix, the ".a-section" fragment candidate is COMPLETELY ABSENT from structures — impossible to select, not merely outscored — got ' + JSON.stringify(afterResult.structures.map(function (s) { return s.containerSelector; })));

  // ================================================================
  // TASK 2/3/4 — the winning structure (shipped code) is the true
  // ~48-card level, cohesive (title+price together), never the
  // fragment/sidebar/unrelated-UI level.
  // ================================================================
  var diag = WSAutoDetect.runAutoDetectDiagnostic();
  var result = WSAutoDetect.runAutoDetect();
  assert(result.ok && result.structures.length > 0, 'MISSION PROOF: Auto Detect finds at least one structure');
  var winner = result.structures[0];
  assert(Math.abs(winner.itemCount - CARD_COUNT) <= 2, 'MISSION PROOF (TASK 2/4 before/after logical row count): winning itemCount=' + winner.itemCount + ' (~' + CARD_COUNT + '), not the fragment/sidebar count — full winner: ' + JSON.stringify({ label: winner.label, itemCount: winner.itemCount, containerSelector: winner.containerSelector, score: winner.score, rowCohesion: winner.rowCohesion }));
  assert(winner.rowCohesion && winner.rowCohesion.completeRatio >= 0.6, 'MISSION PROOF (TASK 2 cohesion): the winning structure\'s own fields co-occur together on most sampled instances — completeRatio=' + (winner.rowCohesion && winner.rowCohesion.completeRatio));

  var columns = [
    { id: 'title', name: 'Title', relativeSelector: 'h2', attribute: 'text' },
    { id: 'price', name: 'Price', relativeSelector: 'span.a-color-base', attribute: 'text' },
    { id: 'link', name: 'Link', relativeSelector: 'a', attribute: 'href' }
  ];
  var extraction = WSScraper.runExtraction({ containerSelector: winner.containerSelector, columns: columns });
  assert(extraction.rows.length === CARD_COUNT, 'MISSION PROOF (TASK 2/4 after logical row count): real extraction produces exactly ' + CARD_COUNT + ' rows — got ' + extraction.rows.length);
  var titledAndPriced = extraction.rows.filter(function (r) { return r.title && r.price; });
  assert(titledAndPriced.length === CARD_COUNT, 'MISSION PROOF (TASK 3 — title+price co-occur inside the SAME row): every extracted row has BOTH Title and Price populated together — got ' + titledAndPriced.length + ' of ' + CARD_COUNT);
  var garbageTexts = ['Customer Reviews', 'Color & Finish', 'Brands', 'Wattage', 'Premium Brands', 'Base Diameter', "Amazon's Choice", 'Popular Shopping Ideas'];
  extraction.rows.forEach(function (r) {
    garbageTexts.forEach(function (g) {
      assert((r.title || '').indexOf(g) === -1, 'MISSION PROOF: no sidebar/filter/badge/unrelated-UI text ("' + g + '") leaked into an extracted Title — got ' + JSON.stringify(r.title));
    });
  });
  assert(WSSelector.countMatches(winner.containerSelector) === CARD_COUNT, 'MISSION PROOF: winning selector matches exactly ' + CARD_COUNT + ' elements page-wide — got ' + WSSelector.countMatches(winner.containerSelector));

  // ================================================================
  // TASK 5/6 / PART C — Next detection: BEFORE (the two strong page-wide
  // signals, Tiers 1-2, genuinely can't find an icon-only control) vs
  // AFTER (pagination-region discovery, PART C's rebuilt Tier 3, finds
  // it via structural cluster-adjacency). Location is page=7 — the LAST
  // numbered entry in the cluster — so the immediately-following sibling
  // is unambiguously the icon-only Next control itself, not another
  // (also legitimate) numbered page link.
  // ================================================================
  var WSNextDetect = loadNextDetectAgainstDocument(built.loaded.dom.document, 'https://shop.example.com/s?k=desk+lamp&page=7');
  var diagResult = WSNextDetect.findNextControlDiagnostic(winner.containerSelector);
  assert(diagResult.tiers.length === 4, 'MISSION PROOF (TASK 5 — every stage instrumented): got ' + diagResult.tiers.length + ' tier reports, expected 4 (tiers 0-3, PART C merged the old landmark/cluster/href tiers into one region-first pass)');
  var tiers0to2AllMiss = diagResult.tiers.slice(0, 3).every(function (t) { return t.found === false; });
  assert(tiers0to2AllMiss, 'MISSION PROOF (TASK 5 — exact tier/rejection reason): Tiers 0-2 (link-rel-next, rel-next, exact accessible-name — all page-wide) genuinely fail to find the icon-only Next control — got ' + JSON.stringify(diagResult.tiers.slice(0, 3).map(function (t) { return { tier: t.tier, name: t.name, found: t.found }; })));
  assert(diagResult.regionDiscovery.clusterFound === true && diagResult.regionDiscovery.clusterEntryCount >= 3, 'MISSION PROOF (TASK 6 / PART C): the structural page-number cluster is detected — ' + JSON.stringify(diagResult.regionDiscovery));
  var regionTier = diagResult.tiers[3];
  assert(regionTier.found === true, 'MISSION PROOF (TASK 5/6 after — PART C region-first pass): finds the icon-only Next control — ' + JSON.stringify(regionTier));
  assert(regionTier.regions.some(function (r) { return r.clusterAdjacencyChecked && r.clusterAdjacencyFound; }), 'MISSION PROOF: the match came specifically via structural cluster-adjacency (not loose-text, which an icon-only control has none of) — got ' + JSON.stringify(regionTier.regions));
  assert(diagResult.result.method === 'pagination-cluster-adjacency', 'MISSION PROOF: final result method is the rebuilt structural-adjacency signal — got ' + JSON.stringify(diagResult.result));

  var nextResult = WSNextDetect.findNextControl(winner.containerSelector);
  assert(nextResult.found === true && nextResult.method === 'pagination-cluster-adjacency', 'MISSION PROOF (TASK 6 production path — PART C): findNextControl() itself (not just the diagnostic) finds the icon-only Next via region-first structural adjacency — got ' + JSON.stringify(nextResult));
  nextResult.trigger();
  assert(built.iconOnlyNext.dispatchedTypes.indexOf('click') !== -1, 'MISSION PROOF: the trigger actually clicked the REAL icon-only Next button (a <button>, no real href, so it must be a synthetic click, not a navigateTrigger)');

  // ---- Unrelated numeric/"Next" content elsewhere must not falsely
  // trigger the region pass or get chosen over the real cluster. ----
  var decoyNumber = el('span', {}, '2'); // a lone "2" elsewhere, e.g. a review count fragment — not part of any 3+ cluster
  built.loaded.dom.body.appendChild(decoyNumber);
  var nextResult2 = WSNextDetect.findNextControl(winner.containerSelector);
  assert(nextResult2.found === true && nextResult2.method === 'pagination-cluster-adjacency', 'MISSION PROOF: a single unrelated numeric element elsewhere does not break real region-first detection — got ' + JSON.stringify(nextResult2));

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
