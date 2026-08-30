/**
 * site-acceptance-amazon.test.js
 * Real-Amazon basic acceptance scenario (SITE level — see TESTING.md).
 * Built and ready per the QA-gate mission; NOT executed the session it
 * was written in (explicit instruction: Etsy alone for the first real
 * SITE run, Amazon/eBay deliberately deferred). Uses the shared core in
 * e2e/lib/basic-site-acceptance.js — see that file for exactly what is
 * and isn't covered (page open + challenge check, popup render, real
 * permission grant, real content-script PING, best-effort auto-detect).
 */
const path = require('path');
const { runBasicSiteAcceptance } = require('../lib/basic-site-acceptance');

const START_URL = 'https://www.amazon.com/s?k=desk+lamp';
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts', 'latest', 'site-amazon');

async function run(ctx) {
  const fs = require('fs');
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  return runBasicSiteAcceptance(ctx, {
    label: 'Amazon',
    url: START_URL,
    hostnamePattern: /amazon\./i,
    permissionOrigin: 'https://*.amazon.com/*',
    artifactDir: ARTIFACT_DIR,
    artifactPrefix: 'amazon'
  });
}

module.exports = { run, START_URL, ARTIFACT_DIR };
