#!/usr/bin/env node
/**
 * e2e/run.js
 * REAL browser test harness entry point for ClickScrape (Web Scraper).
 * `npm run test:browser` / `npm run test:browser:headed` both run this.
 *
 * This is NOT mocked-DOM testing: it launches a real, visible Chrome
 * window (a persistent context is required for extension loading in
 * Chromium — headless Chrome cannot load unpacked extensions at all, so
 * a visible window is a hard technical requirement here, not a style
 * choice), loads the CURRENT unpacked extension straight from this
 * repository's own manifest.json, opens a real public Etsy page, and
 * drives the extension's real message protocol against it.
 *
 * SEPARATE PROFILE: every run gets a brand-new temp Chrome user-data
 * directory (see e2e/lib/browser.js) that is deleted afterward — the
 * user's real Chrome profile is never touched, referenced, or reused.
 *
 * `--headed` keeps the window open a few extra seconds at the end
 * (SLOWMO-ish, for a human watching) — both commands otherwise behave
 * identically; a real window is ALWAYS shown either way (see above).
 *
 * ============================================================
 * REMAINING LIMITATIONS (read this before assuming a "failure" here
 * means the extension is broken):
 * ============================================================
 * 1. Playwright cannot drive Chrome's native toolbar-popup UI (clicking
 *    the extension's action icon and interacting with the resulting
 *    popup) — this is a known, documented Playwright/Chromium
 *    limitation, not something this harness failed to figure out. The
 *    task's own PHASE 2 anticipates this and pre-authorizes the
 *    fallback used here: opening chrome-extension://<id>/popup/
 *    popup.html directly as an ordinary page.
 * 2. Because of #1, popup.js's own `chrome.tabs.query({active:true,
 *    currentWindow:true})` (how it normally decides which real-world
 *    tab it's "attached to") resolves to the popup page ITSELF when
 *    opened this way, not the Etsy tab — a real, inherent side effect
 *    of the workaround in #1, not a defect in the extension. This
 *    harness verifies the popup renders and its real controls exist in
 *    the DOM regardless, and separately verifies real extension<->Etsy
 *    communication through the background service worker's own actual
 *    message-passing code (chrome.scripting.executeScript +
 *    chrome.tabs.sendMessage) — a genuinely real code path, just
 *    triggered by the harness instead of a literal toolbar click.
 * 3. Etsy may serve a bot-detection challenge/CAPTCHA to any automated
 *    browser, including a real, visible, non-headless Chrome window.
 *    This harness detects that condition explicitly and reports it as
 *    a genuine external blocker (per CLAUDE.md) rather than treating it
 *    as a pass or silently retrying/bypassing it.
 */
const fs = require('fs');
const path = require('path');
const { createLogger } = require('./lib/log');
const { launchWithExtension, detectExtensionId } = require('./lib/browser');

// Scenario selection: `--scenario=<name>` picks e2e/tests/<name>.test.js
// (default: etsy-popup, the original Phase 3 popup/content-script proof
// of concept — unchanged, still `npm run test:browser`'s default so
// nothing about its documented behavior changes). AUTOMATIC PAGINATION's
// own real-site verification lives in a SEPARATE scenario file
// (autopaginate-real-site) run via `npm run test:browser:autopaginate`,
// rather than replacing the original scenario — both stay independently
// re-runnable by any future session.
const SCENARIO_ARG = process.argv.find((a) => a.startsWith('--scenario='));
const SCENARIO_NAME = SCENARIO_ARG ? SCENARIO_ARG.slice('--scenario='.length) : 'etsy-popup';
const scenario = require('./tests/' + SCENARIO_NAME + '.test');

const ARTIFACT_DIR = path.join(__dirname, '..', 'test-artifacts', 'latest');
const HEADED = process.argv.includes('--headed');

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const log = createLogger(path.join(ARTIFACT_DIR, 'test.log'));
  log.info('=== ClickScrape real-browser E2E test starting ===');
  log.info('Scenario: ' + SCENARIO_NAME);
  log.info('Mode: ' + (HEADED ? '--headed (window stays open briefly at the end)' : 'default (window still visible — see file header; closes immediately after)'));

  let launch = null;
  let extInfo = null;
  let result = null;
  let failure = null;

  try {
    launch = await launchWithExtension({ headless: false, log });
    extInfo = await detectExtensionId(launch.context, log, 15000);
    if (!extInfo) {
      const err = new Error('Could not detect the extension ID — no chrome-extension:// service worker registered within the timeout. The extension likely failed to load. Check: (1) manifest.json is valid, (2) if using real Google Chrome (not Playwright\'s bundled Chromium), current Chrome Stable versions are known to silently ignore --load-extension entirely — see e2e/lib/browser.js\'s header comment.');
      err.isAssertion = true;
      throw err;
    }

    result = await scenario.run({ context: launch.context, extensionId: extInfo.id, serviceWorker: extInfo.serviceWorker, log });

    log.info('=== RESULT: PASS ===');
    result.passed.forEach((p) => log.info('  ✓ ' + p));
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'result.json'), JSON.stringify({
      status: 'pass',
      scenario: SCENARIO_NAME,
      extensionId: extInfo.id,
      testUrl: scenario.ETSY_URL || scenario.START_URL,
      passedChecks: result.passed,
      details: result.details,
      finishedAt: new Date().toISOString()
    }, null, 2));
  } catch (err) {
    failure = err;
    log.error('=== RESULT: ' + (err.isExternalBlocker ? 'EXTERNAL BLOCKER' : 'FAIL') + ' ===');
    log.error(err.message);
    if (err.stack) log.error(err.stack);

    // Capture whatever diagnostics we CAN, from whatever state we
    // actually reached — never just "Timeout" (spec Phase 6).
    const diag = {
      status: err.isExternalBlocker ? 'external-blocker' : 'fail',
      scenario: SCENARIO_NAME,
      failedAssertion: err.message,
      isExternalBlocker: !!err.isExternalBlocker,
      currentUrl: null,
      details: err.details || (result && result.details) || null,
      finishedAt: new Date().toISOString()
    };
    try {
      if (launch && launch.context) {
        const pages = launch.context.pages();
        for (const p of pages) {
          const url = p.url();
          if (/^chrome-extension:\/\//.test(url)) {
            await p.screenshot({ path: path.join(ARTIFACT_DIR, 'popup.png'), fullPage: true, timeout: 60000 }).catch(() => {});
            log.info('Captured popup.png on failure (url: ' + url + ')');
          } else if (!diag.currentUrl || url.startsWith('http')) {
            diag.currentUrl = url;
            await p.screenshot({ path: path.join(ARTIFACT_DIR, 'browser.png'), timeout: 60000 }).catch(() => {});
            log.info('Captured browser.png on failure (url: ' + url + ')');
          }
        }
      }
    } catch (diagErr) {
      log.warn('Could not capture full failure diagnostics: ' + diagErr.message);
    }
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'result.json'), JSON.stringify(diag, null, 2));
  } finally {
    if (HEADED && !failure) {
      log.info('Keeping window open briefly (--headed)...');
      await new Promise((r) => setTimeout(r, 4000));
    }
    if (launch) {
      await launch.closeUp(true);
      log.info('Closed browser, removed temp profile: ' + launch.userDataDir);
    }
    await log.close();
  }

  if (failure) {
    console.error('\nSee ' + ARTIFACT_DIR + ' for screenshots/log/result.json.');
    process.exitCode = 1;
  } else {
    console.log('\nAll artifacts saved to ' + ARTIFACT_DIR);
    process.exitCode = 0;
  }
}

main().catch((e) => {
  console.error('FATAL (harness itself crashed, not the extension under test):', e);
  process.exitCode = 1;
});
