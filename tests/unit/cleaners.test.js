/**
 * cleaners.test.js (FAST level)
 * Pure-logic coverage for utils/cleaners.js — the automatic Data
 * Cleaning Engine (PRICE/TEXT/NUMBER/URL/RAW, inference, and the
 * always-on semantic-integrity pass). Loaded and executed for real,
 * unmodified. Standalone-runnable: `node tests/unit/cleaners.test.js`.
 */
'use strict';
const { loadModules } = require('../lib/load-modules');
const { makeSuite } = require('../lib/assert');

function run() {
  const suite = makeSuite('cleaners');
  const assert = suite.assert;

  const sandbox = loadModules(['utils/results.js', 'utils/downloads.js', 'utils/transforms.js', 'utils/cleaners.js']);
  const C = sandbox.WSCleaners;

  // ---- RAW: byte-for-byte, no exceptions ----
  assert(C.cleanRaw('  spaced  ') === '  spaced  ', 'RAW never trims');
  assert(C.applyCleaner('raw', '  spaced  ') === '  spaced  ', 'applyCleaner raw is byte-for-byte');

  // ---- TEXT ----
  assert(C.cleanText('  a   b \n c\t d ') === 'a b c d', 'TEXT collapses whitespace/newlines/tabs');
  assert(C.cleanText('Sale Price Sale Price') === 'Sale Price', 'TEXT collapses an exact whole-string duplicate phrase');
  assert(C.cleanText('Very Very Good') === 'Very Very Good', 'TEXT never touches a real repeated word like "Very Very Good"');
  assert(C.cleanText('') === '', 'TEXT on empty string stays empty');
  assert(C.cleanText(null) === null, 'TEXT on null is left as-is (isBlank passthrough)');

  // ---- PRICE — the mission's own real-world example ----
  assert(C.cleanPrice('Sale Price 920.59 TL 920.59 TL') === '920.59 TL', 'PRICE collapses a duplicated real-world price example');
  assert(C.cleanPrice('$29.99') === '$29.99', 'PRICE leaves an already-clean price alone');
  assert(C.cleanPrice('29.99') === '29.99', 'PRICE accepts a currency-less price with a decimal-cents tail');
  assert(C.cleanPrice('(56)') === '(56)', 'PRICE never treats a bare parenthesized count as a price');
  assert(C.cleanPrice('35% off') === '35% off', 'PRICE never treats a percentage as a price');
  assert(C.cleanPrice('11 reviews') === '11 reviews', 'PRICE never treats a bare review count as a price');
  assert(C.cleanPrice('$10 or $20') === '$10 or $20', 'PRICE refuses to guess between two genuinely different prices');
  assert(C.priceNumericValue('$29.99') === 29.99, 'priceNumericValue extracts the real numeric value');
  assert(C.priceNumericValue('11 reviews') === null, 'priceNumericValue returns null for a non-price value, never a guess');
  assert(C.priceNumericValue('$10 or $20') === null, 'priceNumericValue refuses two different prices (ambiguous)');

  // ---- NUMBER ----
  assert(C.cleanNumber('4.8 stars') === '4.8', 'NUMBER extracts a leading decimal rating');
  assert(C.cleanNumber('1,234 reviews') === '1234', 'NUMBER treats a leading 1,234-style count as thousands-grouped');
  assert(C.cleanNumber('(553)') === '553', 'NUMBER accepts a bare parenthesized count');
  assert(C.cleanNumber('Product 2026 Edition') === 'Product 2026 Edition', 'NUMBER never extracts a number embedded in real prose');
  assert(C.cleanNumber('25%') === '25', 'NUMBER extracts a leading percentage value');

  // ---- URL (needs WSTransforms.removeTrackingParams, loaded above) ----
  var cleanedUrl = C.cleanUrl('https://www.etsy.com/listing/123?ref=abc&ga_order=xyz', { baseUrl: 'https://www.etsy.com/' });
  assert(cleanedUrl.indexOf('ref=abc') === -1, 'URL strips known tracking params (ref)');
  assert(cleanedUrl.indexOf('/listing/123') !== -1, 'URL preserves the real navigable path');
  assert(C.cleanUrl('  https://example.com  ') !== '  https://example.com  ', 'URL trims/normalizes whitespace around a real URL');

  // ---- inferCleanerType — automatic, generic, multi-locale ----
  assert(C.inferCleanerType('Price') === 'price', 'infer: "Price" -> price');
  assert(C.inferCleanerType('Fiyat') === 'price', 'infer: "Fiyat" (TR) -> price');
  assert(C.inferCleanerType('Old Price') === 'price', 'infer: "Old Price" -> price (old price uses the same cleaner)');
  assert(C.inferCleanerType('Eski Fiyat') === 'price', 'infer: "Eski Fiyat" (TR) -> price');
  assert(C.inferCleanerType('Link') === 'url', 'infer: "Link" -> url');
  // KNOWN PRE-EXISTING BUG (found while writing this test, not fixed here
  // per mission instructions not to change product behavior for tests):
  // LINK_NAME_RE is `/\b(?:link|url|bağlantı)\b/i`. JS regex `\b` is
  // ASCII-only ([A-Za-z0-9_]); "bağlantı" ends in the Turkish dotless-ı
  // (U+0131), which is NOT a `\w` char, so the trailing `\b` never
  // matches and this branch is dead code for any real Turkish "Bağlantı"
  // column name. Documented here as a real, reported finding; the
  // assertion below pins the CURRENT (buggy) behavior so this test keeps
  // passing until it is deliberately fixed.
  assert(C.inferCleanerType('Bağlantı') === null, 'infer: "Bağlantı" (TR) currently fails to match url (pre-existing \\b/Unicode bug in LINK_NAME_RE — see comment above)');
  assert(C.inferCleanerType('Seller') === null, 'infer: "Seller" -> no inference (no seller cleanerType exists)');
  assert(C.inferCleanerType('Title') === null, 'infer: "Title" -> no inference');

  // ---- isGenericSellerLabel — reject boilerplate, never a real shop name ----
  assert(C.isGenericSellerLabel('Ad by Etsy seller') === true, 'seller: "Ad by Etsy seller" is boilerplate');
  assert(C.isGenericSellerLabel('Sponsored') === true, 'seller: "Sponsored" is boilerplate');
  assert(C.isGenericSellerLabel('Star Seller') === true, 'seller: "Star Seller" is boilerplate');
  assert(C.isGenericSellerLabel('Seller') === true, 'seller: bare "Seller" is boilerplate');
  assert(C.isGenericSellerLabel('Shop') === true, 'seller: bare "Shop" is boilerplate');
  assert(C.isGenericSellerLabel('MaisonEsmee') === false, 'seller: a real shop name is never rejected');
  assert(C.isGenericSellerLabel('The Corner Shop') === false, 'seller: a real shop name CONTAINING "Shop" is never falsely rejected');
  assert(C.isGenericSellerLabel('Ad Astra Designs') === false, 'seller: a real shop name STARTING WITH "Ad" is never falsely rejected');

  // ---- applySemanticIntegrityFixes — always-on, cross-column ----
  var columns = [
    { id: 'c_price', name: 'Price' },
    { id: 'c_old', name: 'Old Price' },
    { id: 'c_seller', name: 'Seller' }
  ];
  var rows = [
    { c_price: '$29.99', c_old: '$29.99', c_seller: 'Ad by Etsy seller' }, // duplicate old price + boilerplate seller
    { c_price: '$29.99', c_old: '$49.99', c_seller: 'MaisonEsmee' } // genuine discount + real seller — must survive untouched
  ];
  var fixed = C.applySemanticIntegrityFixes(rows, columns);
  assert(fixed[0].c_old === '', 'integrity fix: Old Price blanked when it duplicates Current Price');
  assert(fixed[0].c_seller === '', 'integrity fix: boilerplate Seller blanked');
  assert(fixed[1].c_old === '$49.99', 'integrity fix: a genuinely DIFFERENT old price is preserved (real discount)');
  assert(fixed[1].c_seller === 'MaisonEsmee', 'integrity fix: a real seller name is preserved');
  assert(rows[0].c_old === '$29.99', 'applySemanticIntegrityFixes never mutates the input rows in place');
  assert(C.applySemanticIntegrityFixes([], columns) instanceof Array, 'applySemanticIntegrityFixes handles an empty row set gracefully');
  assert(C.applySemanticIntegrityFixes(rows, []) === rows, 'applySemanticIntegrityFixes is a no-op with no columns to act on');

  // ---- applyCleaner dispatcher never throws ----
  assert(C.applyCleaner('price', undefined) === undefined, 'applyCleaner never throws on undefined');
  assert(C.applyCleaner('bogus-type', 'x') === 'x', 'applyCleaner falls back to raw for an unknown type');

  return suite.summarize();
}

if (require.main === module) {
  var result = run();
  process.exit(result.failures ? 1 : 0);
}

module.exports = { run: run };
