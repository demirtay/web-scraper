/**
 * detail-enrichment-false-positive-challenge-detection.test.js (FAST/local, no browser)
 * REAL CHROME DETAIL RETEST FAILED AGAIN mission — real production
 * report: a healthy 303-row/7-page main scrape, then a Detail Enrichment
 * run that visibly navigated to many real Amazon product pages, yet
 * produced ZERO completed/partial records and ZERO stored field values
 * (0/302) for every one of the 7 configured fields (weight, dimensions,
 * materyal, base, type, about, yorum sayısı) — despite the field
 * SELECTORS themselves being proven correct (the picker's own preview
 * showed real values for every field).
 *
 * TRACE (worker navigates -> page ready -> extractor runs ->
 * relativeSelectors execute -> values produced -> message sent ->
 * background receives -> ws_deepscrape_fields[url] written -> record
 * completed/partial):
 *
 * FIRST BROKEN TRANSITION: background.js's own resolveDetailPage() ->
 * extractDetailFields() calls pageLooksLikeChallenge(tabId) BEFORE ever
 * running the extractor (see extractDetailFields's own comment: "Checked
 * BEFORE extraction so a challenge page is never mistaken for a page
 * that simply has no matching selector content"). pageLooksLikeChallenge
 * queried DEEP_SCRAPE_CHALLENGE_SELECTORS, which included
 * `[id*="px-" i]` and `[class*="px-" i]` — matching ANY element whose
 * id/class attribute contains the substring "px-" ANYWHERE, not merely
 * PerimeterX's own actual challenge markup (already correctly, narrowly
 * covered by the separate `#px-captcha` entry). "px-" is an extremely
 * common short prefix in real-world CSS (Tailwind-style spacing
 * utilities, ad/analytics "pixel" wrapper ids, hashed CSS-in-JS class
 * names) — a real, complex, React-driven page like an Amazon product
 * listing is near-certain to contain at least one unrelated element
 * matching this substring. Every real navigation was therefore
 * misclassified SITE_CHALLENGE (retryable:false) BEFORE the actual
 * RUN_DETAIL_EXTRACTION message was ever sent to the content script —
 * explaining every reported symptom: real navigation observed (it
 * happens BEFORE the false-positive check), fast non-retrying failures
 * cycling through many distinct URLs (SITE_CHALLENGE never retries), and
 * zero values ever reaching ws_deepscrape_fields for any record (the
 * extractor genuinely never ran).
 *
 * FIX: background.js's DEEP_SCRAPE_CHALLENGE_SELECTORS — removed the two
 * overbroad "px-" substring entries; the specific #px-captcha marker and
 * every other provider's own real marker are untouched.
 *
 * This test drives the REAL, unmodified wsDetectChallengeDom() function
 * and DEEP_SCRAPE_CHALLENGE_SELECTORS array from background.js (captured
 * via a real chrome.scripting.executeScript({func, args}) call — never a
 * reimplementation), plus the REAL, unmodified resolveDetailPage()/
 * fetchOneDetailPage()/runDeepScrapeUrls() end-to-end for a 3-5 record
 * run, via tests/lib/load-background.js.
 *
 * Standalone-runnable:
 * `node tests/unit/detail-enrichment-false-positive-challenge-detection.test.js`.
 */
'use strict';
const { loadBackground, makeFakeResponse } = require('../lib/load-background');
const { createMiniDocument, el } = require('../lib/mini-dom');
const { makeSuite } = require('../lib/assert');

// The OLD (buggy) selector list, reproduced verbatim from git history —
// used ONLY to prove what the real, unmodified wsDetectChallengeDom()
// function would have returned against it (never a reimplementation of
// wsDetectChallengeDom itself, only of the now-removed CONFIG it used to
// be called with).
const OLD_BUGGY_SELECTORS = [
  'iframe[src*="recaptcha" i]', 'iframe[title*="recaptcha" i]',
  'iframe[src*="hcaptcha" i]', '#px-captcha', '[id*="captcha" i]',
  '[class*="captcha" i]', 'iframe[src*="challenges.cloudflare" i]',
  '[id*="px-" i]', '[class*="px-" i]'
];

/** A realistic-shaped Amazon-style product detail page: real product
 * content plus incidental "px-" substring markup that has NOTHING to do
 * with any anti-bot challenge (a lazy-load wrapper using Tailwind-style
 * spacing utility classes, and an analytics "pixel" tracking div) — the
 * exact class of real-world markup the mission's own report showed was
 * being misclassified. */
function buildRealProductPageDom() {
  var doc = createMiniDocument();
  var wrapper = el('div', { class: 'a-section lazy-load-wrapper sm:px-4 md:px-8' });
  wrapper.appendChild(el('h1', { id: 'productTitle' }, 'Wedge Pillow, Acrylonitrile Butadiene Styrene Base'));
  wrapper.appendChild(el('div', { class: 'a-section' }, 'Weight: 0.83 kg'));
  doc.body.appendChild(wrapper);
  // Unrelated third-party analytics beacon wrapper — a completely
  // ordinary, harmless element real e-commerce pages carry.
  doc.body.appendChild(el('div', { id: 'ga-px-tracker-9182' }));
  return doc.document;
}

/** A page genuinely showing a PerimeterX CAPTCHA challenge. */
function buildRealChallengePageDom() {
  var doc = createMiniDocument();
  doc.body.appendChild(el('div', { id: 'px-captcha' }, 'Please verify you are a human'));
  return doc.document;
}

/** A page genuinely showing a reCAPTCHA challenge (different provider). */
function buildRecaptchaPageDom() {
  var doc = createMiniDocument();
  doc.body.appendChild(el('iframe', { src: 'https://www.google.com/recaptcha/api2/anchor?x=1' }));
  return doc.document;
}

async function run() {
  const suite = makeSuite('detail-enrichment-false-positive-challenge-detection');
  const assert = suite.assert;

  // Capture the REAL, unmodified wsDetectChallengeDom + the REAL,
  // unmodified (now-fixed) DEEP_SCRAPE_CHALLENGE_SELECTORS straight out
  // of background.js, via the exact call it makes in production —
  // chrome.scripting.executeScript({target, func, args}).
  var capturedFunc = null, capturedSelectors = null;
  var sbCapture = loadBackground({
    executeScriptImpl: function (params) {
      if (typeof params.func === 'function') { capturedFunc = params.func; capturedSelectors = params.args[0]; }
      return Promise.resolve([{ result: false }]);
    }
  });
  await sbCapture.pageLooksLikeChallenge(1); // tabId irrelevant — this mock never touches a real tab
  assert(typeof capturedFunc === 'function', 'sanity: captured the real wsDetectChallengeDom function reference from background.js');
  assert(Array.isArray(capturedSelectors) && capturedSelectors.length > 0, 'sanity: captured the real (now-fixed) DEEP_SCRAPE_CHALLENGE_SELECTORS array');

  // =====================================================================
  // PART 1 — THE BUG ITSELF, proven directly against the REAL, captured
  // wsDetectChallengeDom(), run once with the OLD selector config and
  // once with the CURRENT (fixed) one.
  // =====================================================================
  var realProductDoc = buildRealProductPageDom();

  function runDetector(doc, selectors) {
    // wsDetectChallengeDom references the free variable `document` — its
    // closure is bound to background.js's own VM sandbox context (NOT
    // Node's own `global`), so `document` must be set on THAT sandbox
    // object for this function's lookup to see it — exactly mirroring
    // how a real chrome.scripting.executeScript `func` call sees the
    // target page's own global `document`.
    sbCapture.document = doc;
    try { return capturedFunc(selectors); } finally { delete sbCapture.document; }
  }

  var oldResult = runDetector(realProductDoc, OLD_BUGGY_SELECTORS);
  assert(oldResult === true, 'MISSION PROOF (THE BUG ITSELF): the OLD selector config false-positives on a real, ordinary product page — got ' + oldResult);

  var newResult = runDetector(realProductDoc, capturedSelectors);
  assert(newResult === false, 'MISSION PROOF (THE FIX): the CURRENT (fixed) selector config does NOT false-positive on the exact same real product page — got ' + newResult);

  // =====================================================================
  // PART 2 — genuine challenges are still correctly detected after the
  // fix (the fix removes noise, never real detection capability).
  // =====================================================================
  assert(runDetector(buildRealChallengePageDom(), capturedSelectors) === true, 'MISSION PROOF: a REAL PerimeterX challenge page (#px-captcha) is still correctly detected after the fix');
  assert(runDetector(buildRecaptchaPageDom(), capturedSelectors) === true, 'MISSION PROOF: a REAL reCAPTCHA challenge page is still correctly detected after the fix');

  // =====================================================================
  // PART 3 — END-TO-END, 3-5 records (per the mission's own explicit
  // scale requirement — never a 302-record run): the REAL, unmodified
  // resolveDetailPage()/fetchOneDetailPage()/runDeepScrapeUrls() pipeline,
  // with a fake worker tab that "navigates" to a real product-page DOM
  // carrying the exact same incidental "px-" markup, proving records now
  // reach 'completed' with real stored field values.
  // =====================================================================
  var PRODUCT_COUNT = 4;
  var urls = [];
  for (var i = 1; i <= PRODUCT_COUNT; i++) urls.push('https://www.amazon.com/dp/PRODUCT-' + i);

  var sampleFields = { weight: '0.83 kg', dimensions: '14.37"D x 4.5"W x 15.35"H', materyal: 'Acrylonitrile Butadiene Styrene', base: 'Wedge', type: 'ABS' };
  var fieldDefs = Object.keys(sampleFields).map(function (name) { return { id: 'f_' + name, name: name, relativeSelector: '.' + name, attribute: 'text', multiple: 'first' }; });

  var sb = loadBackground({
    fetchImpl: function () { return makeFakeResponse(403); }, // Amazon's own fetch()-based bot-protection — falls back to real navigation, exactly like the real Etsy/Amazon case
    executeScriptImpl: function (params) {
      if (params.files) return Promise.resolve([{}]); // CONTENT_FILES injection
      if (typeof params.func === 'function') {
        // The real challenge check, run against a real product-page DOM
        // carrying the same incidental "px-" markup the real report hit.
        // (See runDetector() above for why this must be set on the
        // background.js sandbox object itself, not Node's own global.)
        sb.document = buildRealProductPageDom();
        try { return Promise.resolve([{ result: params.func.apply(null, params.args) }]); } finally { delete sb.document; }
      }
      return Promise.resolve([{ result: false }]);
    },
    sendMessageImpl: function (tabId, message, cb) {
      // The real content-script extraction result shape (RUN_DETAIL_EXTRACTION response).
      var row = {};
      fieldDefs.forEach(function (f) { row[f.id] = sampleFields[f.name]; });
      cb({ ok: true, row: row, rejectedFields: [] });
    }
  });

  var results = Object.create(null);
  urls.forEach(function (u) { results[u] = { status: 'pending', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null }; });
  var state = {
    runId: 'dse_test_run', status: 'running', fields: fieldDefs, results: results,
    counts: sb.deepScrapeCounts(results), concurrency: 2, maxAttempts: 3, recordTimeoutMs: 30000,
    stopRequested: false, lease: null, currentUrl: null, currentRecordDiag: null, error: null,
    startedAt: Date.now(), updatedAt: Date.now(), finishedAt: null
  };
  sb.__storage.local['ws_deepscrape_run'] = state;
  sb.__storage.local['ws_deepscrape_fields'] = {};

  var controller = new AbortController();
  await sb.runDeepScrapeUrls(state, urls, controller);

  var finalRun = sb.__storage.local['ws_deepscrape_run'];
  var finalFieldsMap = sb.__storage.local['ws_deepscrape_fields'];

  assert(finalRun.status === 'completed', 'MISSION PROOF: the run reaches a real terminal "completed" state — got ' + finalRun.status);
  assert(finalRun.counts.completed === PRODUCT_COUNT, 'MISSION PROOF (THE ACTUAL FIX, end-to-end): all ' + PRODUCT_COUNT + ' records reach status=completed (was 0/302 in the real report) — got ' + finalRun.counts.completed + '/' + PRODUCT_COUNT + ' — counts: ' + JSON.stringify(finalRun.counts));
  urls.forEach(function (u, idx) {
    assert(finalRun.results[u].status === 'completed', 'record ' + idx + ' (' + u + ') is completed — got ' + finalRun.results[u].status + (finalRun.results[u].failureType ? ' (' + finalRun.results[u].failureType + ': ' + finalRun.results[u].error + ')' : ''));
    assert(finalRun.results[u].failureType === null, 'record ' + idx + ' has no failureType (specifically never SITE_CHALLENGE) — got ' + finalRun.results[u].failureType);
  });

  // ws_deepscrape_fields now genuinely holds every real value — proving
  // the "0 stored, 0/302" report is resolved end-to-end, not just at the
  // status level.
  Object.keys(sampleFields).forEach(function (name) {
    var fieldId = 'f_' + name;
    var populated = urls.filter(function (u) { return finalFieldsMap[u] && finalFieldsMap[u][fieldId] === sampleFields[name]; }).length;
    assert(populated === PRODUCT_COUNT, 'MISSION PROOF: Detail field "' + name + '" has real stored values for all ' + PRODUCT_COUNT + ' records (was 0/302 in the real report) — got ' + populated + '/' + PRODUCT_COUNT);
  });

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
