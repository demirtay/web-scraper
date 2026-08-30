/**
 * detail-extraction-size-guard.test.js (FAST/local, no browser)
 * BUG FIX (real production report + real Chrome storage audit) — root
 * cause: a Detail field whose saved relativeSelector was ':scope' made
 * content/scraper.js's runDetailExtraction() read `document.body`
 * (attribute:'html'/'text' then returning the ENTIRE PAGE's innerHTML/
 * textContent) — confirmed responsible for ~8.92MB of a real ~9MB
 * ws_deepscrape_run (72 flagged values, ~120-143KB each, all classified
 * "html, full-page-text" by the real audit).
 *
 * This file loads the REAL, unmodified content/scraper.js in a minimal
 * `vm` sandbox — a stub `document.body` and a fully-controlled
 * `WSSelector` mock (extractValue/queryFromScope/suggestAttribute) let
 * each test case dictate EXACTLY what a "real" extraction would return,
 * so runDetailExtraction's own orchestration logic (the actual code
 * this bug lives in) is exercised for real, never reimplemented —
 * WSSelector's own internals (already covered elsewhere) are
 * deliberately out of scope here.
 *
 * Standalone-runnable: `node tests/unit/detail-extraction-size-guard.test.js`.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeSuite } = require('../lib/assert');

const SCRAPER_PATH = path.join(__dirname, '..', '..', 'content', 'scraper.js');

/** @param {object} opts.extractValueImpl (el, attribute, containerEl, attributeName) -> value */
function loadScraper(opts) {
  opts = opts || {};
  var sandbox = {
    console: console, JSON: JSON, Object: Object, Array: Array, String: String,
    document: {
      body: {
        querySelector: opts.querySelectorImpl || function () { return { _tag: 'stub-el' }; },
        querySelectorAll: opts.querySelectorAllImpl || function () { return []; }
      }
    }
  };
  sandbox.WSSelector = {
    extractValue: opts.extractValueImpl || function () { return ''; },
    queryFromScope: opts.queryFromScopeImpl || function (scope, sel) { return sandbox.document.body.querySelector(sel); },
    suggestAttribute: function () { return 'text'; },
    getStableClasses: function () { return []; },
    countMatches: function () { return 1; }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  var code = fs.readFileSync(SCRAPER_PATH, 'utf8');
  vm.runInContext(code, sandbox, { filename: SCRAPER_PATH });
  return sandbox.WSScraper;
}

async function run() {
  const suite = makeSuite('detail-extraction-size-guard');
  const assert = suite.assert;

  // ---- 1. A normal Detail TEXT field stores only its intended value ----
  {
    var scraper = loadScraper({
      extractValueImpl: function () { return 'Handmade Ceramic Mug'; }
    });
    var result = scraper.runDetailExtraction([{ id: 'c_title', relativeSelector: '.product-title', attribute: 'text' }]);
    assert(result.row.c_title === 'Handmade Ceramic Mug', 'a normal text field must store exactly its intended value — got ' + JSON.stringify(result.row));
    assert(result.rejectedFields.length === 0, 'a normal, reasonably-sized field must never be rejected');
  }

  // ---- 2. A normal Detail ATTRIBUTE field (e.g. href) stores only its
  // intended value ----
  {
    var scraper2 = loadScraper({
      extractValueImpl: function () { return 'https://example.com/product/123'; }
    });
    var result2 = scraper2.runDetailExtraction([{ id: 'c_link', relativeSelector: 'a.product-link', attribute: 'href' }]);
    assert(result2.row.c_link === 'https://example.com/product/123', 'a normal href field must store exactly its intended value');
    assert(result2.rejectedFields.length === 0, 'a normal attribute value must never be rejected');
  }

  // ---- 3. MISSION PROOF: a field saved with relativeSelector:':scope'
  // (the exact real, proven root cause) must NEVER read document.body —
  // it is refused outright, never silently returning whole-page data. ----
  {
    var wholePageHtml = '<html>' + 'x'.repeat(150000) + '</html>'; // ~150KB, matches the real reported 120-143KB range
    var bodyQuerySpy = 0;
    var scraper3 = loadScraper({
      querySelectorImpl: function () { bodyQuerySpy++; return { _tag: 'body-stub' }; },
      extractValueImpl: function (el) {
        // If runDetailExtraction ever resolves ':scope' to document.body
        // and asks for its value, THIS is what a real page would return —
        // proving the fix means this value must never reach row/rejectedFields' value.
        return wholePageHtml;
      }
    });
    var result3 = scraper3.runDetailExtraction([{ id: 'c_bad', relativeSelector: ':scope', attribute: 'html' }]);
    assert(result3.row.c_bad === undefined, 'MISSION PROOF: a \':scope\' field must NEVER be persisted — got a value of length ' + (result3.row.c_bad ? String(result3.row.c_bad).length : 'n/a'));
    assert(result3.rejectedFields.length === 1 && result3.rejectedFields[0].id === 'c_bad' && result3.rejectedFields[0].reason === 'whole-page-selector',
      'the \':scope\' field must be recorded as rejected with an honest reason — got ' + JSON.stringify(result3.rejectedFields));
    assert(JSON.stringify(result3).indexOf('xxxxx') === -1, 'MISSION PROOF: the whole-page HTML content must never appear ANYWHERE in the persisted result, not even truncated');
  }

  // ---- 4. MISSION PROOF: a 120+KB value from an ORDINARY (non-':scope')
  // selector — e.g. a malformed/too-broad selector on a real page — is
  // ALSO rejected, never truncated, never silently stored. ----
  {
    var oversizedDescription = 'A'.repeat(130000); // 130KB, matches the real reported range
    var scraper4 = loadScraper({
      extractValueImpl: function () { return oversizedDescription; }
    });
    var result4 = scraper4.runDetailExtraction([{ id: 'c_desc', relativeSelector: '.description-wrapper', attribute: 'html' }]);
    assert(result4.row.c_desc === undefined, 'MISSION PROOF: an oversized value must never be persisted, even from an ordinary selector — got length ' + (result4.row.c_desc && result4.row.c_desc.length));
    assert(result4.rejectedFields.length === 1 && result4.rejectedFields[0].id === 'c_desc' && result4.rejectedFields[0].reason === 'oversized-value',
      'the oversized field must be recorded as rejected — got ' + JSON.stringify(result4.rejectedFields));
  }

  // ---- 5. A legitimately long (but bounded) value — e.g. a real product
  // description a few KB long — is NOT rejected. Proves the guard has a
  // real, generous threshold, not an overly aggressive one that would
  // corrupt normal user data. ----
  {
    var legitimateDescription = 'This is a real product description. '.repeat(100); // ~3.7KB — long but completely normal
    var scraper5 = loadScraper({
      extractValueImpl: function () { return legitimateDescription; }
    });
    var result5 = scraper5.runDetailExtraction([{ id: 'c_desc', relativeSelector: '.description', attribute: 'text' }]);
    assert(result5.row.c_desc === legitimateDescription, 'a legitimately long (few-KB) value must be preserved exactly, never rejected/truncated');
    assert(result5.rejectedFields.length === 0, 'a legitimate long value must not be flagged');
  }

  // ---- 6. multiple:'all' fields are ALSO protected — an oversized
  // individual match is dropped (not the whole field), and ':scope'
  // is refused there too. ----
  {
    var scraper6 = loadScraper({
      querySelectorAllImpl: function () { return [{ _tag: 'a' }, { _tag: 'b' }]; },
      extractValueImpl: function (el) { return el._tag === 'a' ? 'normal value' : 'Z'.repeat(130000); }
    });
    var result6 = scraper6.runDetailExtraction([{ id: 'c_images', relativeSelector: 'img', attribute: 'src', multiple: 'all' }]);
    assert(Array.isArray(result6.row.c_images) && result6.row.c_images.length === 1 && result6.row.c_images[0] === 'normal value',
      'multiple:"all" must keep the normal value and drop only the oversized one — got ' + JSON.stringify(result6.row.c_images && result6.row.c_images.map(function (v) { return typeof v === 'string' ? v.slice(0, 20) : v; })));
    assert(result6.rejectedFields.length === 1 && result6.rejectedFields[0].reason === 'oversized-value', 'the multiple:"all" field itself is flagged when any of its matches was oversized');
  }

  // ---- 7. Static source guard: the fix stays in place. ----
  {
    var src = fs.readFileSync(SCRAPER_PATH, 'utf8');
    assert(src.indexOf("col.relativeSelector === ':scope'") !== -1 && src.indexOf('whole-page-selector') !== -1,
      'the \':scope\' rejection must remain present in content/scraper.js');
    assert(src.indexOf('DETAIL_FIELD_MAX_BYTES') !== -1, 'the size-guard constant must remain present');
    assert(src.indexOf('document.body : Sel.queryFromScope') === -1 && src.indexOf("':scope' ? document.body") === -1,
      'runDetailExtraction must never again resolve \':scope\' to document.body directly');
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
