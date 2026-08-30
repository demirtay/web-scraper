/**
 * site-harness-smoke.test.js
 * LIGHTWEIGHT smoke test of the SITE-level harness itself (e2e/site-
 * runner.js) — proves the shared-context orchestrator can launch the
 * browser, detect the extension, open a real (always-reachable, no
 * anti-bot) page, and open the real popup, WITHOUT running a full
 * site-acceptance suite. This is what "npm run test:sites:smoke" runs
 * before ever attempting a full real-site run — mission requirement:
 * confirm the new harness itself works, and resource usage stays
 * reasonable, before spending a full site-acceptance budget on it.
 *
 * Deliberately does NOT touch Etsy/Amazon/eBay (no reason to spend an
 * anti-bot-risk page load just to prove the harness plumbing works) —
 * books.toscrape.com is this project's own established, proven-reliable
 * real site for exactly this kind of infrastructure check (see
 * cleaning-real-site.test.js's own header for why it was chosen the
 * same way).
 */
const path = require('path');

const START_URL = 'https://books.toscrape.com/';
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts', 'latest', 'site-smoke');

function assert(cond, msg) {
  if (!cond) {
    const err = new Error(msg);
    err.isAssertion = true;
    throw err;
  }
}

async function run(ctx) {
  const fs = require('fs');
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const { context, extensionId, log } = ctx;
  const passed = [];
  const details = {};

  log.step('1. Opening a real, reliable page: ' + START_URL);
  const page = await context.newPage();
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
  details.finalUrl = page.url();
  passed.push('1. Real page opened: ' + details.finalUrl);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, 'smoke-browser.png'), timeout: 60000 }).catch(() => {});

  log.step('2. Confirming the extension ID was already detected by the orchestrator');
  assert(extensionId && /^[a-z]{32}$/.test(extensionId), 'extensionId does not look like a valid detected extension id: ' + extensionId);
  passed.push('2. Extension loaded and its real id detected: ' + extensionId);

  log.step('3. Opening the real popup page');
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await popupPage.waitForTimeout(400);
  const bodyHtmlLen = await popupPage.evaluate(() => document.body ? document.body.innerHTML.length : 0);
  assert(bodyHtmlLen > 500, 'popup.html rendered essentially empty (body innerHTML length ' + bodyHtmlLen + ')');
  passed.push('3. Real popup opened and rendered (body innerHTML length ' + bodyHtmlLen + ')');
  await popupPage.screenshot({ path: path.join(ARTIFACT_DIR, 'smoke-popup.png'), fullPage: true, timeout: 60000 }).catch(() => {});

  return { passed, details, sitePage: page, popupPage };
}

module.exports = { run, START_URL, ARTIFACT_DIR };
