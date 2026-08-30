/**
 * detailscope-and-templates.test.js (FAST level)
 * Pure-logic coverage for utils/detailscope.js + utils/detailtemplates.js
 * (Detail Enrichment's scope/URL-list selection and per-hostname
 * template store) — loaded and executed for real, unmodified, via
 * tests/lib/load-modules.js. Standalone-runnable: `node tests/unit/detailscope-and-templates.test.js`.
 */
'use strict';
const { loadModules } = require('../lib/load-modules');
const { makeSuite } = require('../lib/assert');

async function run() {
  const suite = makeSuite('detailscope-and-templates');
  const assert = suite.assert;

  const sandbox = loadModules(['utils/downloads.js', 'utils/detailscope.js', 'utils/storage.js', 'utils/detailtemplates.js']);
  const S = sandbox.WSDetailScope;
  const T = sandbox.WSDetailTemplates;
  const D = sandbox.WSDownloads;

  // ---- validateScope ----
  assert(S.validateScope({ mode: 'all' }, 100).effective === 100, 'all scope effective=total');
  assert(S.validateScope({ mode: 'first', n: 100 }, 1283).effective === 100, 'first 100 effective');
  assert(S.validateScope({ mode: 'first', n: 500 }, 1283).effective === 500, 'first 500 effective');
  assert(S.validateScope({ mode: 'first', n: 5000 }, 1283).effective === 1283, 'first N clamps to total (over-large)');
  assert(S.validateScope({ mode: 'first', n: 5000 }, 1283).normalized === true, 'over-large first N reported normalized');
  assert(S.validateScope({ mode: 'first', n: 0 }, 100).ok === false, 'first 0 rejected');
  assert(S.validateScope({ mode: 'first', n: -5 }, 100).ok === false, 'first -5 rejected');
  assert(S.validateScope({ mode: 'first', n: 2.5 }, 100).ok === false, 'first 2.5 rejected');
  assert(S.validateScope({ mode: 'first', n: 'abc' }, 100).ok === false, 'first "abc" rejected');
  assert(S.validateScope({ mode: 'first', n: 10 }, 0).ok === false, 'first N with zero rows rejected');
  assert(S.validateScope({ mode: 'selected', selectedKeys: [] }, 100).ok === false, 'selected with empty keys rejected');
  assert(S.validateScope({ mode: 'selected', selectedKeys: ['a', 'b'] }, 100).effective === 2, 'selected effective = key count');
  assert(S.validateScope({ mode: 'bogus' }, 100).ok === false, 'invalid mode rejected');
  assert(S.validateScope(null, 100).ok === false, 'null scope rejected');

  // ---- selectScopedRows ----
  var rows = [];
  for (var i = 0; i < 1283; i++) rows.push({ url: 'https://x.test/p' + i, title: 'T' + i });
  var keyFn = function (r) { return r.url; };

  assert(S.selectScopedRows(rows, { mode: 'all' }, keyFn).length === 1283, 'all scope selects everything');
  assert(S.selectScopedRows(rows, { mode: 'first', n: 100 }, keyFn).length === 100, 'first 100 selects 100');
  assert(S.selectScopedRows(rows, { mode: 'first', n: 100 }, keyFn)[0].url === 'https://x.test/p0', 'first N preserves original order');
  assert(S.selectScopedRows(rows, { mode: 'first', n: 500 }, keyFn).length === 500, 'first 500 selects 500');
  var selectedKeys = ['https://x.test/p5', 'https://x.test/p500', 'https://x.test/p1000'];
  var sel = S.selectScopedRows(rows, { mode: 'selected', selectedKeys: selectedKeys }, keyFn);
  assert(sel.length === 3, 'selected scope selects exactly the 3 chosen rows');
  assert(sel.every(function (r) { return selectedKeys.indexOf(r.url) !== -1; }), 'selected scope rows all match chosen keys');
  assert(S.selectScopedRows(rows, { mode: 'first', n: 100 }, keyFn) !== rows, 'selectScopedRows never returns the original array reference');

  // ---- buildDetailUrlList ----
  var rowsWithDupes = [
    { link: 'https://etsy.com/a' }, { link: 'https://etsy.com/b' }, { link: 'https://etsy.com/a' },
    { link: '' }, { link: null }, { link: 'javascript:alert(1)' }, { link: 'data:text/plain;base64,AA==' }
  ];
  var built = S.buildDetailUrlList(rowsWithDupes, 'link', D.validateDownloadUrl);
  assert(built.urls.length === 2, 'buildDetailUrlList dedupes and validates: expected 2, got ' + built.urls.length);
  assert(built.urls.indexOf('https://etsy.com/a') !== -1 && built.urls.indexOf('https://etsy.com/b') !== -1, 'buildDetailUrlList keeps the right urls');
  assert(built.totalRows === 7, 'buildDetailUrlList totalRows counts all rows');
  assert(built.missingUrl === 2, 'buildDetailUrlList counts empty/null as missingUrl');
  assert(built.invalidUrl === 2, 'buildDetailUrlList counts javascript:/data: as invalidUrl');

  // ---- WSDetailTemplates ----
  var host = 'example.test';
  var listBefore = await T.list(host);
  assert(Array.isArray(listBefore) && listBefore.length === 0, 'list() starts empty for a fresh hostname');

  var fields = [
    { id: 'x1', name: 'Seller', relativeSelector: '.shop-name', attribute: 'text', multiple: 'first' },
    { id: 'x2', name: 'Materials', relativeSelector: '.materials', attribute: 'text', multiple: 'all' }
  ];
  var saveRes = await T.save(host, 'Product Details', fields, 'Link');
  assert(saveRes.ok === true, 'save() succeeds with valid name+fields');
  assert(saveRes.template.fields[0].id === undefined, 'saved field is stripped of its ephemeral id');

  var dupRes = await T.save(host, 'Product Details', fields, 'Link');
  assert(dupRes.ok === false && dupRes.error === 'name-taken', 'save() rejects a duplicate template name');
  assert((await T.save(host, '  ', fields, 'Link')).error === 'name-required', 'save() rejects an empty/whitespace name');
  assert((await T.save(host, 'Empty', [], 'Link')).error === 'no-fields', 'save() rejects zero fields');

  var listAfter = await T.list(host);
  assert(listAfter.length === 1, 'list() reflects exactly one saved template');
  assert((await T.list('other-host.test')).length === 0, 'templates are scoped per-hostname');

  var idCounter = 0;
  var makeId = function () { idCounter++; return 'newid_' + idCounter; };
  var instantiated = T.instantiateFields(listAfter[0], makeId);
  assert(instantiated.length === 2, 'instantiateFields returns the same field count');
  assert(instantiated[0].id === 'newid_1' && instantiated[1].id === 'newid_2', 'instantiateFields assigns FRESH ids');
  assert(instantiated[0].name === 'Seller' && instantiated[1].name === 'Materials', 'instantiateFields preserves field names');

  assert((await T.remove(host, listAfter[0].id)) === true, 'remove() returns true for an existing template id');
  assert((await T.remove(host, listAfter[0].id)) === false, 'remove() returns false for an already-removed id');
  assert((await T.list(host)).length === 0, 'list() is empty again after remove()');

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e); process.exit(1); });
}

module.exports = { run: run };
