/**
 * detail-enrichment-fetch-fallback-books.test.js
 * HTTP-403-ON-ETSY bug-fix mission — TESTING B ("real browser test on a
 * safe public site... prove one owned detail-processing tab... same tab
 * reused for URL2... tab count remains bounded"). Real books.toscrape.com
 * (this project's own proven-reliable substitute site), 3 real detail
 * pages, driven through the real DETAIL -> scope -> Start production
 * path. See e2e/lib/detail-enrichment-fetch-fallback.js for exactly what
 * is/isn't covered and why the interactive picker click isn't re-driven
 * here (already independently proven elsewhere).
 */
const path = require('path');
const fs = require('fs');
const { runDetailEnrichmentFetchFallback } = require('../lib/detail-enrichment-fetch-fallback');

const START_URL = 'https://books.toscrape.com/';
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts', 'latest', 'site-detail-enrichment-books');

async function run(ctx) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  return runDetailEnrichmentFetchFallback(ctx, {
    label: 'books.toscrape.com',
    startUrl: START_URL,
    hostnamePattern: /books\.toscrape\.com/i,
    permissionOrigin: 'https://books.toscrape.com/*',
    scrapeConfig: {
      containerSelector: 'article.product_pod',
      columns: [
        { id: 'c_title', name: 'Title', relativeSelector: 'h3 a', attribute: 'text' },
        { id: 'c_link', name: 'Link', relativeSelector: 'h3 a', attribute: 'href' },
        { id: 'c_price', name: 'Price', relativeSelector: '.price_color', attribute: 'text' }
      ]
    },
    detailField: { name: 'Description', relativeSelector: '#product_description ~ p', attribute: 'text' },
    scopeCount: 3,
    artifactDir: ARTIFACT_DIR,
    artifactPrefix: 'books'
  });
}

module.exports = { run: run, START_URL: START_URL, ARTIFACT_DIR: ARTIFACT_DIR };
