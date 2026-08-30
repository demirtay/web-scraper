/**
 * runstate.test.js (FAST level)
 * Pure-logic coverage for utils/runstate.js — Auto Scroll / Multi-page /
 * Load More run-state shape, cross-pass dedup (buildRowKey/mergeNewRows/
 * canonicalizeIdentityValue), stop-condition evaluators, page-signature
 * loop detection, and URL-pattern pagination helpers. Loaded and executed
 * for real, unmodified. Standalone-runnable: `node tests/unit/runstate.test.js`.
 */
'use strict';
const { loadModules } = require('../lib/load-modules');
const { makeSuite } = require('../lib/assert');

function run() {
  const suite = makeSuite('runstate');
  const assert = suite.assert;

  const sandbox = loadModules(['utils/runstate.js']);
  const R = sandbox.WSRunState;

  const columns = [{ id: 'title' }, { id: 'link' }, { id: 'price' }];

  // ---- normalizeHostname ----
  assert(R.normalizeHostname('www.Etsy.com') === 'etsy.com', 'normalizeHostname strips leading www. and lowercases');
  assert(R.normalizeHostname('etsy.com') === 'etsy.com', 'normalizeHostname leaves an already-bare hostname alone');
  assert(R.normalizeHostname('') === '', 'normalizeHostname handles empty string');

  // ---- canonicalizeIdentityValue: known product-ID URL shapes win first ----
  assert(R.canonicalizeIdentityValue('https://www.etsy.com/listing/123456789/some-title?ref=abc') === 'etsy:123456789',
    'canonicalizeIdentityValue extracts a stable Etsy listing id, ignoring slug/tracking params');
  assert(R.canonicalizeIdentityValue('https://www.amazon.com/Some-Title/dp/B08N5WRWNW/ref=sr_1_1') === 'amazon:B08N5WRWNW',
    'canonicalizeIdentityValue extracts a stable Amazon ASIN');
  assert(R.canonicalizeIdentityValue('https://www.ebay.com/itm/some-title/1234567890?hash=abc') === 'ebay:1234567890',
    'canonicalizeIdentityValue extracts a stable eBay item id');

  // ---- canonicalizeIdentityValue: generic tracking-param stripping ----
  var a = R.canonicalizeIdentityValue('https://shop.example.com/p/1?utm_source=x&id=42&utm_campaign=y');
  var b = R.canonicalizeIdentityValue('https://shop.example.com/p/1?id=42&utm_source=z');
  assert(a === b, 'canonicalizeIdentityValue resolves two URLs differing only in tracking params to the same identity');
  assert(a.indexOf('utm_source') === -1, 'canonicalizeIdentityValue strips known tracking params entirely');
  assert(a.indexOf('id=42') !== -1, 'canonicalizeIdentityValue NEVER strips a real identifying param like id=');

  var c = R.canonicalizeIdentityValue('https://shop.example.com/p/1?b=2&a=1');
  var d = R.canonicalizeIdentityValue('https://shop.example.com/p/1?a=1&b=2');
  assert(c === d, 'canonicalizeIdentityValue sorts remaining query params so order never causes a false distinction');

  var e = R.canonicalizeIdentityValue('https://shop.example.com/p/1/');
  var f = R.canonicalizeIdentityValue('https://shop.example.com/p/1');
  assert(e === f, 'canonicalizeIdentityValue normalizes a trailing slash');

  assert(R.canonicalizeIdentityValue('not a url at all') === null, 'canonicalizeIdentityValue returns null for a non-URL value');
  assert(R.canonicalizeIdentityValue(null) === null, 'canonicalizeIdentityValue returns null for null');
  assert(R.canonicalizeIdentityValue('') === null, 'canonicalizeIdentityValue returns null for empty string');

  // ---- buildRowKey ----
  var rowA = { title: 'Widget', link: 'https://www.etsy.com/listing/999/x?ref=abc', price: '$10' };
  var rowB = { title: 'Widget (dup)', link: 'https://www.etsy.com/listing/999/y?ref=xyz', price: '$12' };
  assert(R.buildRowKey(rowA, columns, 'link') === R.buildRowKey(rowB, columns, 'link'),
    'buildRowKey resolves two rows with the same canonical listing id to the SAME key even with different titles/tracking params');
  assert(R.buildRowKey(rowA, columns, 'entire-row') !== R.buildRowKey(rowB, columns, 'entire-row'),
    'buildRowKey with entire-row dedupe treats genuinely different row content as different keys');
  assert(R.buildRowKey({ title: 'x' }, columns, 'entire-row') === 'x␟␟', 'entire-row key joins column values in COLUMN order, not object key order, missing values as empty string');
  var rowNonUrl = { title: 'x', link: 'not-a-url', price: '$1' };
  assert(R.buildRowKey(rowNonUrl, columns, 'link') === 'not-a-url', 'buildRowKey falls back to the raw string when the dedupe column is not a resolvable URL');

  // ---- mergeNewRows ----
  var state = R.createRunState({ mode: 'auto-scroll', tabId: 1, hostname: 'etsy.com', columns: columns, dedupeKey: 'link' });
  var res1 = R.mergeNewRows(state, [rowA], columns);
  assert(res1.newUniqueCount === 1, 'mergeNewRows: first pass adds 1 new unique row');
  assert(state.rows.length === 1, 'mergeNewRows: runState.rows reflects the merge');
  var res2 = R.mergeNewRows(state, [rowB], columns);
  assert(res2.newUniqueCount === 0, 'mergeNewRows: a canonically-duplicate row (different tracking params) is silently skipped, not re-added');
  assert(state.rows.length === 1, 'mergeNewRows: duplicate is never appended to rows');
  assert(state.progress.rowsCollected === 1, 'mergeNewRows keeps progress.rowsCollected in sync');
  var rowC = { title: 'Other', link: 'https://www.etsy.com/listing/111/z', price: '$5' };
  var res3 = R.mergeNewRows(state, [rowC], columns);
  assert(res3.newUniqueCount === 1 && state.rows.length === 2, 'mergeNewRows adds a genuinely new row on a later pass');

  // ---- createRunState / setStatus / resumeRunState / pauseRunState ----
  assert(state.status === 'idle', 'createRunState starts idle');
  assert(state.dedupeKey === 'link', 'createRunState preserves the requested dedupeKey');
  R.setStatus(state, 'running');
  assert(state.status === 'running', 'setStatus updates status');
  R.setStatus(state, 'bogus-status');
  assert(state.status === 'running', 'setStatus ignores an invalid status value, leaving state unchanged');
  R.pauseRunState(state);
  assert(state.status === 'paused' && state.stopReason === 'user', 'pauseRunState sets status=paused with stopReason=user');
  assert(state.rows.length === 2, 'pauseRunState preserves already-collected rows');
  R.resumeRunState(state);
  assert(state.status === 'running' && state.stopReason === null, 'resumeRunState resumes a paused run back to running, clearing stopReason');
  R.setStatus(state, 'stopped', { stopReason: 'user' });
  R.resumeRunState(state);
  assert(state.status === 'running', 'resumeRunState also resumes a stopped run (pre-V1.20 behavior preserved)');
  var idleState = R.createRunState({ mode: 'auto-scroll', tabId: 1, hostname: 'x' });
  R.resumeRunState(idleState);
  assert(idleState.status === 'idle', 'resumeRunState is a no-op on a run that is neither stopped nor paused');

  // ---- evaluateAutoScrollStop / evaluateMultiPageStop / evaluateLoadMoreStop ----
  var sAuto = R.createRunState({ mode: 'auto-scroll', tabId: 1, hostname: 'x', limits: { maxRows: 2, maxScrolls: 100, noNewDataAttempts: 3 } });
  sAuto.rows = [{}, {}];
  assert(R.evaluateAutoScrollStop(sAuto).shouldStop === true && R.evaluateAutoScrollStop(sAuto).reason === 'max-rows', 'evaluateAutoScrollStop stops at maxRows');
  var sAuto2 = R.createRunState({ mode: 'auto-scroll', tabId: 1, hostname: 'x', limits: { maxRows: 1000, maxScrolls: 100, noNewDataAttempts: 3 } });
  sAuto2.progress.noNewDataStreak = 3;
  assert(R.evaluateAutoScrollStop(sAuto2).reason === 'no-new-data', 'evaluateAutoScrollStop stops on repeated no-new-data streak');
  assert(R.evaluateAutoScrollStop(R.createRunState({ mode: 'auto-scroll', tabId: 1, hostname: 'x' })).shouldStop === false, 'evaluateAutoScrollStop does not stop a fresh run');

  var sMulti = R.createRunState({ mode: 'multi-page', tabId: 1, hostname: 'x', limits: { maxPages: 3, maxRows: 1000 } });
  sMulti.progress.pageNumber = 3;
  assert(R.evaluateMultiPageStop(sMulti).reason === 'max-pages', 'evaluateMultiPageStop stops at maxPages');

  var sLoadMore = R.createRunState({ mode: 'load-more', tabId: 1, hostname: 'x', limits: { maxClicks: 5, maxRows: 1000, noNewDataAttempts: 3 } });
  sLoadMore.progress.clickCount = 5;
  assert(R.evaluateLoadMoreStop(sLoadMore).reason === 'max-clicks', 'evaluateLoadMoreStop stops at maxClicks');

  // ---- computePageSignature / isPageSignatureRepeated ----
  var sig1 = R.computePageSignature('https://x.test/p1', [{ title: 'A', link: 'l1', price: '$1' }], columns);
  var sig2 = R.computePageSignature('https://x.test/p1', [{ title: 'A', link: 'l1', price: '$1' }], columns);
  var sig3 = R.computePageSignature('https://x.test/p2', [{ title: 'B', link: 'l2', price: '$2' }], columns);
  assert(sig1 === sig2, 'computePageSignature is deterministic for identical url+rows');
  assert(sig1 !== sig3, 'computePageSignature differs for genuinely different url+rows');
  var loopState = R.createRunState({ mode: 'multi-page', tabId: 1, hostname: 'x' });
  loopState.pageSignatures.push(sig1);
  assert(R.isPageSignatureRepeated(loopState, sig1) === true, 'isPageSignatureRepeated detects a real pagination loop');
  assert(R.isPageSignatureRepeated(loopState, sig3) === false, 'isPageSignatureRepeated does not false-positive on a genuinely new page');

  // ---- detectUrlPaginationPattern / buildNextPageUrl / isSameOrigin ----
  var pat1 = R.detectUrlPaginationPattern('https://shop.example.com/search?page=3&q=x');
  assert(pat1.found === true && pat1.style === 'page' && pat1.start === 3 && pat1.step === 1, 'detectUrlPaginationPattern recognizes a ?page= query param');
  var pat2 = R.detectUrlPaginationPattern('https://shop.example.com/category/page/4/');
  assert(pat2.found === true && pat2.kind === 'path' && pat2.start === 4, 'detectUrlPaginationPattern recognizes a /page/N/ path segment');
  var pat3 = R.detectUrlPaginationPattern('https://shop.example.com/search?start=40');
  assert(pat3.found === true && pat3.style === 'offset' && pat3.confidence === 'medium', 'detectUrlPaginationPattern treats offset-style params as medium confidence (no reliable step)');
  var pat4 = R.detectUrlPaginationPattern('https://shop.example.com/search?random=42');
  assert(pat4.found === false, 'detectUrlPaginationPattern never guesses an arbitrary numeric param is pagination');

  var nextUrl = R.buildNextPageUrl('https://shop.example.com/search?page=3&q=x', pat1, 4);
  assert(nextUrl.indexOf('page=4') !== -1 && nextUrl.indexOf('q=x') !== -1, 'buildNextPageUrl increments the page param while preserving unrelated params');
  var nextPathUrl = R.buildNextPageUrl('https://shop.example.com/category/page/4/', pat2, 5);
  assert(nextPathUrl.indexOf('/page/5/') !== -1, 'buildNextPageUrl increments a path-style page segment');
  assert(R.buildNextPageUrl('https://shop.example.com/category/other/4/', pat2, 5) === null, 'buildNextPageUrl returns null when the current URL no longer matches the pattern shape (e.g. unexpected redirect)');

  assert(R.isSameOrigin('https://shop.example.com/page2', 'shop.example.com') === true, 'isSameOrigin accepts a same-hostname candidate');
  assert(R.isSameOrigin('https://ads.other.com/x', 'shop.example.com') === false, 'isSameOrigin rejects a different hostname (e.g. an ad/external redirect)');
  assert(R.isSameOrigin('not a url', 'shop.example.com') === false, 'isSameOrigin fails closed on an unparseable candidate');

  return suite.summarize();
}

if (require.main === module) {
  var result = run();
  process.exit(result.failures ? 1 : 0);
}

module.exports = { run: run };
