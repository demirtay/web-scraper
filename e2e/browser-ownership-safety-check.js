#!/usr/bin/env node
/**
 * browser-ownership-safety-check.js
 * REGRESSION/SAFETY TEST for the Browser Process Safety rule (see
 * CLAUDE.md, "## Browser Process Safety — CRITICAL").
 *
 * Proves — empirically, against two REAL, independently-launched browser
 * instances, not by inspection alone — that this project's cleanup path
 * (`closeUp()` in e2e/lib/browser.js) closes ONLY the exact browser
 * instance it was called on, and never collaterally affects a second,
 * completely independent browser instance running at the same time
 * (standing in for "the user's own personal browser window that happens
 * to be open while a test runs").
 *
 * Sequence:
 *   1. Launch instance A ("the user's own browser", simulated — a real,
 *      independent, temp-profile Chromium instance; never the user's
 *      actual profile, which this harness never references anywhere).
 *   2. Launch instance B ("the test's own browser").
 *   3. Confirm both are alive and independently responsive.
 *   4. Call closeUp() on B ONLY.
 *   5. Assert B is now closed AND instance A is STILL alive and
 *      responsive — the core claim under test.
 *   6. Clean up A via its own closeUp() (legitimate: A's own owner
 *      closing its own instance).
 *
 * Run via `npm run test:browser-safety`.
 */
const path = require('path');
const fs = require('fs');
const { createLogger } = require('./lib/log');
const { launchWithExtension } = require('./lib/browser');

const ARTIFACT_DIR = path.join(__dirname, '..', 'test-artifacts', 'latest');

function assert(cond, msg) {
  if (!cond) {
    const err = new Error(msg);
    err.isAssertion = true;
    throw err;
  }
}

async function isResponsive(context) {
  // A real, independent liveness probe — not just "the object exists" —
  // opens a fresh page in the given context and evaluates real JS in it.
  const page = await context.newPage();
  try {
    const result = await page.evaluate(() => 1 + 1);
    return result === 2;
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const log = createLogger(path.join(ARTIFACT_DIR, 'browser-safety-check.log'));
  log.info('=== Browser Process Safety regression check starting ===');

  let instanceA = null;
  let instanceB = null;
  let failure = null;
  const passed = [];

  try {
    log.step('Launching instance A (simulates the user\'s own independent browser)');
    instanceA = await launchWithExtension({ headless: false, log });
    log.info('Instance A user data dir: ' + instanceA.userDataDir);

    log.step('Launching instance B (the test\'s own browser)');
    instanceB = await launchWithExtension({ headless: false, log });
    log.info('Instance B user data dir: ' + instanceB.userDataDir);

    assert(instanceA.userDataDir !== instanceB.userDataDir, 'the two instances must be genuinely separate profiles/processes, not the same one');

    log.step('Confirming both instances are independently alive and responsive');
    assert(await isResponsive(instanceA.context), 'instance A is not responsive before any cleanup — test setup itself is broken');
    assert(await isResponsive(instanceB.context), 'instance B is not responsive before any cleanup — test setup itself is broken');
    passed.push('Both independent browser instances (A and B) launched and confirmed responsive');

    log.step('Closing ONLY instance B via its own closeUp() — this is the real cleanup path every e2e test in this repo uses');
    await instanceB.closeUp(true);

    log.step('Verifying instance B is now closed');
    let bStillResponsive = true;
    try { bStillResponsive = await isResponsive(instanceB.context); } catch (e) { bStillResponsive = false; }
    assert(!bStillResponsive, 'instance B should be closed after its own closeUp(), but it is still responsive');
    passed.push('Instance B (the one actually closed) is confirmed closed');

    log.step('Verifying instance A (the UNRELATED, still-running instance) was NOT affected by closing B');
    const aStillResponsive = await isResponsive(instanceA.context);
    assert(aStillResponsive, 'CRITICAL SAFETY FAILURE: instance A (an unrelated, independently-launched browser) stopped responding after instance B was closed — cleanup is NOT ownership-scoped');
    passed.push('Instance A (the unrelated, independent browser) is CONFIRMED STILL RUNNING AND RESPONSIVE after B\'s cleanup — closeUp() did not collaterally affect it');

    log.info('=== RESULT: PASS ===');
    passed.forEach((p) => log.info('  ✓ ' + p));
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'browser-safety-check-result.json'), JSON.stringify({
      status: 'pass', passedChecks: passed, finishedAt: new Date().toISOString()
    }, null, 2));
  } catch (err) {
    failure = err;
    log.error('=== RESULT: FAIL ===');
    log.error(err.message);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'browser-safety-check-result.json'), JSON.stringify({
      status: 'fail', failedAssertion: err.message, finishedAt: new Date().toISOString()
    }, null, 2));
  } finally {
    // Final cleanup: each instance closed via its OWN closeUp() only —
    // never a name-based kill, exactly the pattern under test. B may
    // already be closed (idempotent — see closeUp()'s own guard).
    if (instanceB) await instanceB.closeUp(true).catch(() => {});
    if (instanceA) await instanceA.closeUp(true).catch(() => {});
    await log.close();
  }

  if (failure) {
    console.error('\nBrowser Process Safety regression check FAILED. See ' + ARTIFACT_DIR + '/browser-safety-check.log');
    process.exitCode = 1;
  } else {
    console.log('\nBrowser Process Safety regression check PASSED. Ownership-scoped cleanup confirmed — closing one browser instance never affects an unrelated one.');
    process.exitCode = 0;
  }
}

main().catch((e) => {
  console.error('FATAL (harness itself crashed):', e);
  process.exitCode = 1;
});
