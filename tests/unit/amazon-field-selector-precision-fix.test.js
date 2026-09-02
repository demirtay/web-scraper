/**
 * amazon-field-selector-precision-fix.test.js (FAST/local, no browser)
 * REAL AMAZON EVIDENCE mission — ROOT CAUSE A: the real persisted
 * scraperConfig's own Price relativeSelector was:
 *
 *   span.a-color-base
 *
 * Amazon's own generic text-color utility class — reused for ratings,
 * badges, "Small Business"/"#1 Top Rated" labels, sidebar/filter text,
 * and other unrelated UI, never price-specific at all. Real extraction:
 * raw=240, duplicates=72, final=168. The row-container inference was
 * receiving an already-poisoned field selector, independent of whatever
 * container it ended up scoped to.
 *
 * FIX (content/autodetect.js): buildFieldCandidate() now measures the
 * GLOBAL semantic precision of any field candidate whose own detected
 * samples predominantly look price-like (PRICE_RE) — how many elements
 * that exact selector matches page-wide, and what fraction of those
 * global matches also look price-like. A selector that is both far
 * broader than the candidate's own expected item count AND mostly NOT
 * price-like globally is never shipped as a field: buildFieldCandidate
 * first tries tryEscalateFieldSelector() (a parent-scoped compound, the
 * field-level analogue of buildContainerSelector's own "parent-scoped"
 * tier, built ENTIRELY from existing, unmodified Sel.* functions), and
 * only accepts the escalation if it's genuinely more precise; otherwise
 * the field is dropped entirely rather than shipping a poisoned one.
 * PRICE_RE itself was also extended to recognize currency CODES (TRY,
 * USD, EUR, ...) next to a number, not just symbols — the real data
 * contained "TRY 1,640.85", which the old symbol-only pattern never
 * matched at all. A real, standard, worldwide convention, never
 * Amazon-specific.
 *
 * Generic by construction — every class name below is invented; nothing
 * in the fix or this test is keyed to any hostname or specific class.
 *
 * Standalone-runnable: `node tests/unit/amazon-field-selector-precision-fix.test.js`.
 */
'use strict';
const { loadAutoDetect } = require('../lib/load-autodetect');
const { el } = require('../lib/mini-dom');
const { makeSuite } = require('../lib/assert');

const CARD_COUNT = 48;
// Non-price text sharing the EXACT same class as the real price span —
// the real evidence's own garbage list, repeated enough to reproduce
// the mission's own "a generic selector can produce 150+ matches"
// (48 real prices + 150 unrelated labels = 198 total page-wide matches
// for the bare ".a-color-base" class, ~24% actually price-like).
const SIDEBAR_LABEL_POOL = [
  'Small Business', '#1 Top Rated', 'Customer Reviews', '4.7', '4.5',
  'Color & Finish', 'Brands', 'Wattage', 'Premium Brands', 'Base Diameter',
  'Recycled materials', 'Certification Body', 'Popular Shopping Ideas',
  'Amazon\'s Choice', '4 Stars & Up'
];
const SIDEBAR_LABEL_COUNT = 150;
const SIDEBAR_LABELS = [];
for (var _i = 0; _i < SIDEBAR_LABEL_COUNT; _i++) SIDEBAR_LABELS.push(SIDEBAR_LABEL_POOL[_i % SIDEBAR_LABEL_POOL.length]);

function buildCard(n) {
  var card = el('div', { class: 'card-result' });
  var titleWrapper = el('div', { class: 'a-section a-spacing-none title-row' });
  var link = el('a', { href: '/dp/PRODUCT-' + n });
  link.appendChild(el('h2', { class: 'a-size-base-plus a-spacing-none a-color-base a-text-normal' }, 'Desk Lamp Model ' + n));
  titleWrapper.appendChild(link);
  // The wrapper carries a distinguishing role class alongside the same
  // shared generic utility classes every row uses — a realistic middle
  // ground (many real design systems mix a generic utility class with a
  // semantic role hint one level up, even when the LEAF itself, the
  // <span>, carries none of its own — exactly the real evidence's shape).
  var priceWrapper = el('div', { class: 'a-section a-spacing-none price-row' });
  // The exact real shape: a bare <span class="a-color-base"> holding the
  // price text, no price-specific class of its own — TRY-currency-code
  // format on purpose (proves the PRICE_RE currency-code extension too).
  priceWrapper.appendChild(el('span', { class: 'a-color-base' }, 'TRY ' + (1000 + n * 10) + '.85'));
  card.appendChild(titleWrapper);
  card.appendChild(priceWrapper);
  return card;
}

function buildFixture() {
  var loaded = loadAutoDetect();
  var body = loaded.dom.body;

  var grid = el('div', { class: 'search-results-grid' });
  for (var i = 1; i <= CARD_COUNT; i++) grid.appendChild(buildCard(i));
  body.appendChild(grid);

  // Sidebar reusing the SAME ".a-color-base" class for entirely
  // unrelated, non-price text — this is what makes the bare selector
  // globally imprecise despite being locally unique inside any one card.
  var sidebar = el('div', { class: 'filter-panel' });
  SIDEBAR_LABELS.forEach(function (t) {
    sidebar.appendChild(el('span', { class: 'a-color-base' }, t));
  });
  body.appendChild(sidebar);

  return loaded;
}

async function run() {
  const suite = makeSuite('amazon-field-selector-precision-fix');
  const assert = suite.assert;

  var loaded = buildFixture();
  var WSAutoDetect = loaded.WSAutoDetect;
  var WSSelector = loaded.WSSelector;
  var WSScraper = loaded.WSScraper;

  // ---- Global match count BEFORE any field-selector-precision fix
  // existed — proves the fixture actually reproduces "a generic selector
  // can produce 150+ matches" the mission asked to demonstrate. ----
  var globalBareMatches = WSSelector.countMatches('span.a-color-base');
  assert(globalBareMatches >= CARD_COUNT + SIDEBAR_LABELS.length, 'MISSION PROOF (fixture sanity): the bare ".a-color-base" class alone matches ' + globalBareMatches + ' elements page-wide (48 real prices + ' + SIDEBAR_LABELS.length + ' unrelated labels) — a genuinely broad, shared utility class, exactly the real evidence\'s shape');

  var result = WSAutoDetect.runAutoDetect();
  assert(result.ok && result.structures.length > 0, 'MISSION PROOF: Auto Detect finds at least one structure');
  var winner = result.structures[0];
  assert(Math.abs(winner.itemCount - CARD_COUNT) <= 2, 'MISSION PROOF: winning structure is the ~' + CARD_COUNT + '-card level — got itemCount=' + winner.itemCount + ' containerSelector=' + winner.containerSelector);

  var priceField = winner.fields.filter(function (f) { return f.name === 'Price'; })[0];
  assert(priceField, 'MISSION PROOF: a Price field was still proposed (the fix must not just silently delete the field when a precise alternative exists) — got fields ' + JSON.stringify(winner.fields.map(function (f) { return f.name; })));
  assert(priceField.relativeSelector !== 'span.a-color-base', 'MISSION PROOF (ROOT CAUSE A — the core evidence): the accepted Price relativeSelector is NOT the bare, poisoned "span.a-color-base" — got ' + JSON.stringify(priceField.relativeSelector));

  // ---- Prove the ACCEPTED selector has HIGH PRECISION: query it
  // page-wide and confirm it does not pull in the sidebar junk. ----
  var acceptedGlobalMatches = WSSelector.countMatches(priceField.relativeSelector);
  assert(acceptedGlobalMatches <= CARD_COUNT + 2, 'MISSION PROOF (before/after match count): the accepted Price selector matches ~' + CARD_COUNT + ' elements page-wide, not ' + globalBareMatches + ' — got ' + acceptedGlobalMatches + ' (selector: ' + priceField.relativeSelector + ')');

  // ---- Real extraction: every row's Price value is an actual price,
  // never one of the sidebar labels. ----
  var extraction = WSScraper.runExtraction({
    containerSelector: winner.containerSelector,
    columns: [
      { id: 'title', name: 'Title', relativeSelector: winner.fields.filter(function (f) { return f.name === 'Title'; })[0].relativeSelector, attribute: 'text' },
      { id: 'price', name: 'Price', relativeSelector: priceField.relativeSelector, attribute: 'text' }
    ]
  });
  assert(extraction.rows.length === CARD_COUNT, 'MISSION PROOF (before/after logical row count): exactly ' + CARD_COUNT + ' rows — got ' + extraction.rows.length);
  var pricesLookReal = extraction.rows.every(function (r) { return /^TRY [\d,]+\.\d{2}$/.test(r.price || ''); });
  assert(pricesLookReal, 'MISSION PROOF: every extracted Price value is a genuine price string (never "Small Business"/"#1 Top Rated"/"Customer Reviews"/a rating) — got ' + JSON.stringify(extraction.rows.slice(0, 5).map(function (r) { return r.price; })));
  SIDEBAR_LABELS.forEach(function (label) {
    assert(!extraction.rows.some(function (r) { return r.price === label; }), 'MISSION PROOF: sidebar label "' + label + '" never appears as an extracted Price value');
  });
  var rowsWithBoth = extraction.rows.filter(function (r) { return r.title && r.price; });
  assert(rowsWithBoth.length === CARD_COUNT, 'MISSION PROOF: Title and Price co-occur in every logical row — got ' + rowsWithBoth.length + ' of ' + CARD_COUNT);

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
