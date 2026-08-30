/**
 * site-scenarios.js
 * Declares which existing e2e/tests/*.test.js scenarios make up each
 * SITE-level acceptance suite, and in what order. e2e/site-runner.js
 * (the shared-context orchestrator) reads this file — it is the ONE
 * place that defines "what does a full site acceptance run for X
 * consist of", so a future scenario is added here once rather than
 * duplicated into multiple runner scripts.
 *
 * REUSE, NOT DUPLICATION (mission's own explicit instruction): every
 * scenario listed below is an EXISTING, already-written e2e/tests/*.js
 * file — this config only sequences them. No scraping/extraction logic
 * is re-implemented here.
 *
 * SITE CHOICE NOTE (documented honestly, not silently worked around):
 * this project's own test history (see e2e/tests/etsy-popup.test.js and
 * e2e/tests/cleaning-real-site.test.js's header comments) has repeatedly
 * confirmed real Etsy pages reliably serve an anti-bot challenge to this
 * harness's automated browser. The 'etsy' suite below still targets real
 * Etsy directly (per this mission's explicit instruction — the
 * originally-reported picker bug was found on Etsy) and will honestly
 * report BLOCKED_BY_SITE if that challenge appears again, which is a
 * legitimate, expected, non-regression outcome, NOT a harness failure.
 * The comprehensive workflow/picker/detail-enrichment coverage — the
 * part that actually proves or disproves product behavior — runs against
 * books.toscrape.com/quotes.toscrape.com ('primary-workflow' suite
 * below), this project's own already-established reliable real-site
 * substitute for exactly this reason (every scenario listed there
 * predates this file and already made that same site choice on its own).
 *
 * timeoutMs is generous (default 300000 = 5 min) specifically to leave
 * room for a REAL manual "Allow" click on a Chrome permission prompt
 * (CLAUDE.md: "user will manually click Allow... do not spend
 * engineering time bypassing... use reasonable timeouts") while still
 * bounding the historically-observed 45+ minute stalls under real
 * resource pressure — an unresponsive scenario is reported as
 * BLOCKED_RESOURCE, not waited on indefinitely.
 */
'use strict';

const DEFAULT_TIMEOUT_MS = 300000;

const suites = {
  smoke: {
    label: 'SITE harness smoke test',
    scenarios: [
      { name: 'site-harness-smoke', timeoutMs: 90000 }
    ]
  },
  etsy: {
    label: 'Etsy',
    scenarios: [
      { name: 'etsy-popup', timeoutMs: DEFAULT_TIMEOUT_MS }
    ]
  },
  'etsy-detail-picker': {
    label: 'Etsy Detail Enrichment / Element Picker (real Etsy, dedicated)',
    scenarios: [
      { name: 'etsy-detail-picker-real-flow', timeoutMs: 420000 }
    ]
  },
  'detail-enrichment-fetch-fallback': {
    label: 'Detail Enrichment fetch-then-real-navigation fallback (HTTP-403-ON-ETSY bug-fix mission)',
    scenarios: [
      { name: 'detail-enrichment-fetch-fallback-books', timeoutMs: 300000 },
      { name: 'detail-enrichment-fetch-fallback-etsy', timeoutMs: 300000 }
    ]
  },
  'detail-enrichment-real-stop': {
    label: 'Detail Enrichment real Stop-button UI path (STALL-FIX mission round 3)',
    scenarios: [
      { name: 'detail-enrichment-real-stop', timeoutMs: 180000 }
    ]
  },
  'primary-workflow': {
    label: 'Primary real-site workflow + picker + Detail Enrichment (books.toscrape.com / quotes.toscrape.com)',
    scenarios: [
      { name: 'discovery-popup-start-real-site', timeoutMs: DEFAULT_TIMEOUT_MS },
      { name: 'discovery-popup-live-render-real-site', timeoutMs: DEFAULT_TIMEOUT_MS },
      { name: 'discovery-scroll-real-site', timeoutMs: DEFAULT_TIMEOUT_MS },
      { name: 'discovery-pagination-real-site', timeoutMs: DEFAULT_TIMEOUT_MS },
      { name: 'autopaginate-real-site', timeoutMs: DEFAULT_TIMEOUT_MS },
      { name: 'autoscroll-real-site', timeoutMs: DEFAULT_TIMEOUT_MS },
      { name: 'cleaning-real-site', timeoutMs: DEFAULT_TIMEOUT_MS },
      { name: 'picker-interception-real-flow', timeoutMs: DEFAULT_TIMEOUT_MS },
      { name: 'picker-popup-lifecycle-real-flow', timeoutMs: DEFAULT_TIMEOUT_MS },
      { name: 'detail-enrichment-real-flow', timeoutMs: DEFAULT_TIMEOUT_MS },
      { name: 'detail-enrichment-smoke', timeoutMs: 180000 }
    ]
  },
  amazon: {
    label: 'Amazon',
    scenarios: [
      { name: 'site-acceptance-amazon', timeoutMs: DEFAULT_TIMEOUT_MS }
    ]
  },
  ebay: {
    label: 'eBay',
    scenarios: [
      { name: 'site-acceptance-ebay', timeoutMs: DEFAULT_TIMEOUT_MS }
    ]
  }
};

// 'all' — every real-site-targeting suite, for a full `npm run test:sites`
// gate (RELEASE level composes this). Deliberately excludes 'smoke'
// (that's a harness self-check, not a product acceptance suite).
const ALL_SITE_SUITE_NAMES = ['etsy', 'etsy-detail-picker', 'detail-enrichment-fetch-fallback', 'detail-enrichment-real-stop', 'primary-workflow', 'amazon', 'ebay'];

module.exports = { suites: suites, DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS, ALL_SITE_SUITE_NAMES: ALL_SITE_SUITE_NAMES };
