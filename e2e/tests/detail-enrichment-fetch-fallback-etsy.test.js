/**
 * detail-enrichment-fetch-fallback-etsy.test.js
 * HTTP-403-ON-ETSY bug-fix mission — TESTING C ("Etsy manual/real
 * acceptance path... a SMALL Etsy sample, e.g. 3-5 products... start
 * Detail Enrichment... no HTTP 403 from background fetch path... If Etsy
 * shows its own verification/challenge page: do not bypass it. Report
 * BLOCKED_BY_SITE."). Real Etsy search page, real Auto Detect (no
 * hardcoded Etsy selectors — see e2e/lib/detail-enrichment-fetch-
 * fallback.js), 3 real detail pages, driven through the real DETAIL ->
 * scope -> Start production path. Honestly reports BLOCKED_BY_SITE if
 * Etsy's own anti-bot challenge appears — at the search page (via the
 * shared challenge-detect check) or, per the mission's own explicit
 * failure taxonomy, if every real detail-page navigation itself gets
 * classified SITE_CHALLENGE by the fixed engine.
 */
const path = require('path');
const fs = require('fs');
const { runDetailEnrichmentFetchFallback } = require('../lib/detail-enrichment-fetch-fallback');
const { assertNoChallenge } = require('../lib/challenge-detect');

const START_URL = 'https://www.etsy.com/search?q=candle+holder';
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts', 'latest', 'site-detail-enrichment-etsy');

async function run(ctx) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  return runDetailEnrichmentFetchFallback(ctx, {
    label: 'Etsy',
    startUrl: START_URL,
    hostnamePattern: /etsy\.com\/search/i,
    permissionOrigin: 'https://*.etsy.com/*',
    scrapeConfig: null, // real Auto Detect — no hardcoded Etsy selectors
    // A deliberately generic, broadly-present selector (h1 — virtually
    // every real product/listing page has exactly one) since this test
    // never interactively picks a field (see the shared lib's header) —
    // if Etsy's challenge blocks every real detail-page navigation
    // (SITE_CHALLENGE), this selector's own precision is moot anyway;
    // the run is honestly reported BLOCKED_BY_SITE either way.
    detailField: { name: 'PageHeading', relativeSelector: 'h1', attribute: 'text' },
    scopeCount: 3, // "3-5 products... never hundreds" — mission's own explicit instruction
    artifactDir: ARTIFACT_DIR,
    artifactPrefix: 'etsy',
    checkChallenge: function (page, details) { return assertNoChallenge(page, 'Etsy', details); }
  });
}

module.exports = { run: run, START_URL: START_URL, ARTIFACT_DIR: ARTIFACT_DIR };
