/**
 * site-acceptance-ebay.test.js
 * Real-eBay basic acceptance scenario (SITE level — see TESTING.md).
 * Built and ready per the QA-gate mission; NOT executed the session it
 * was written in (explicit instruction: Etsy alone for the first real
 * SITE run, Amazon/eBay deliberately deferred). Uses the shared core in
 * e2e/lib/basic-site-acceptance.js — see that file for exactly what is
 * and isn't covered (page open + challenge check, popup render, real
 * permission grant, real content-script PING, best-effort auto-detect).
 */
const path = require('path');
const { runBasicSiteAcceptance } = require('../lib/basic-site-acceptance');

const START_URL = 'https://www.ebay.com/sch/i.html?_nkw=desk+lamp';
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts', 'latest', 'site-ebay');

async function run(ctx) {
  const fs = require('fs');
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  return runBasicSiteAcceptance(ctx, {
    label: 'eBay',
    url: START_URL,
    hostnamePattern: /ebay\./i,
    permissionOrigin: 'https://*.ebay.com/*',
    artifactDir: ARTIFACT_DIR,
    artifactPrefix: 'ebay'
  });
}

module.exports = { run, START_URL, ARTIFACT_DIR };
