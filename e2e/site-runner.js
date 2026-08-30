#!/usr/bin/env node
/**
 * e2e/site-runner.js — SITE test level (see TESTING.md).
 *
 * The shared-context, sequential, resource-safe orchestrator for real-
 * site acceptance suites. `npm run test:sites` / `test:sites:etsy` /
 * `test:sites:smoke` / etc. all run this with different `--suite=`
 * selections (see e2e/site-scenarios.js for what each suite contains).
 *
 * ARCHITECTURE (deliberately a thin orchestration layer, not a second
 * test framework — mission's own explicit instruction): reuses
 * e2e/lib/browser.js's launchWithExtension/detectExtensionId completely
 * unmodified, and runs EXISTING e2e/tests/*.test.js scenario modules
 * (each already exporting `run(ctx) -> {passed, details}`, the same
 * contract e2e/run.js has always used) — this file only adds sequencing,
 * timeouts, resource safety, and BLOCKED_BY_SITE/BLOCKED_RESOURCE
 * classification on top of what already existed.
 *
 * RESOURCE SAFETY (CLAUDE.md's current mission, "RESOURCE SAFETY —
 * CRITICAL"):
 *   - ONE shared browser context for the entire invocation, however many
 *     suites/scenarios are selected — never a fresh browser per scenario.
 *   - Suites and scenarios run strictly SEQUENTIALLY, never in parallel.
 *   - Pages opened by one scenario are closed before the next scenario
 *     starts (diffed against the page set that existed before it ran) —
 *     bounded memory regardless of how many scenarios run in one
 *     invocation.
 *   - Each scenario has its own timeout (Promise.race — does not cancel
 *     a genuinely stuck underlying operation, only lets the orchestrator
 *     stop waiting on it and move on); the whole invocation also has an
 *     overall wall-clock budget.
 *   - A scenario that times out is reported as BLOCKED_RESOURCE, and the
 *     ENTIRE REMAINING RUN is aborted cleanly rather than continuing to
 *     drive an already-unhealthy browser/session further — matches the
 *     project's own observed history (chrome.permissions.request()
 *     stalling 45+ minutes under real memory pressure); safer to stop
 *     and report than to keep pushing.
 *   - Cleanup ONLY ever closes the ONE context this run itself created
 *     (launch.closeUp()) — see e2e/lib/browser.js's own Browser Process
 *     Safety section; nothing here ever does a broader/name-based kill.
 *
 * Usage:
 *   node e2e/site-runner.js --suite=smoke
 *   node e2e/site-runner.js --suite=etsy
 *   node e2e/site-runner.js --suite=etsy,primary-workflow
 *   node e2e/site-runner.js --all
 *   node e2e/site-runner.js --suite=etsy --overall-timeout-ms=600000
 *
 * Exit code: 0 unless at least one scenario genuinely FAILed or crashed
 * (a BLOCKED_BY_SITE/BLOCKED_RESOURCE result is NOT itself a failure —
 * CLAUDE.md: "a blocked test is NOT a pass, but also not automatically a
 * product regression" — see the printed summary for the honest status
 * of every scenario either way).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createLogger } = require('./lib/log');
const { launchWithExtension, detectExtensionId } = require('./lib/browser');
const { suites, DEFAULT_TIMEOUT_MS, ALL_SITE_SUITE_NAMES } = require('./site-scenarios');

const ARTIFACT_DIR = path.join(__dirname, '..', 'test-artifacts', 'latest');
const OVERALL_TIMEOUT_MS = (() => {
  const arg = process.argv.find((a) => a.startsWith('--overall-timeout-ms='));
  const n = arg ? parseInt(arg.slice('--overall-timeout-ms='.length), 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1200000; // 20 min default whole-run budget
})();

function parseSelectedSuites() {
  if (process.argv.includes('--all')) return ALL_SITE_SUITE_NAMES.slice();
  const arg = process.argv.find((a) => a.startsWith('--suite='));
  if (!arg) return ['smoke']; // safest possible default: never launch a full real-site run unasked
  return arg.slice('--suite='.length).split(',').map((s) => s.trim()).filter(Boolean);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { const e = new Error('TIMEOUT after ' + ms + 'ms: ' + label); e.isTimeout = true; reject(e); }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const log = createLogger(path.join(ARTIFACT_DIR, 'site-runner.log'));
  const runStartedAt = Date.now();
  const selectedSuiteNames = parseSelectedSuites();
  log.info('=== ClickScrape SITE-level real-browser test run starting ===');
  log.info('Selected suites: ' + selectedSuiteNames.join(', '));
  log.info('Overall wall-clock budget: ' + OVERALL_TIMEOUT_MS + 'ms');

  const unknown = selectedSuiteNames.filter((n) => !suites[n]);
  if (unknown.length) {
    log.error('Unknown suite name(s): ' + unknown.join(', ') + ' — known suites: ' + Object.keys(suites).join(', '));
    await log.close();
    process.exitCode = 1;
    return;
  }

  const results = [];
  let launch = null;
  let extInfo = null;
  let aborted = null; // reason string once the run stops early

  try {
    launch = await launchWithExtension({ headless: false, log });
    extInfo = await detectExtensionId(launch.context, log, 15000);
    if (!extInfo) {
      throw new Error('Could not detect the extension ID — no chrome-extension:// service worker registered within the timeout. Extension likely failed to load (see e2e/lib/browser.js header for known Chrome-Stable --load-extension caveat).');
    }
    log.info('Extension loaded, id=' + extInfo.id);

    outer:
    for (const suiteName of selectedSuiteNames) {
      const suite = suites[suiteName];
      log.info('--- Suite: ' + suiteName + ' (' + suite.label + ') ---');
      for (const scenarioConfig of suite.scenarios) {
        if (Date.now() - runStartedAt > OVERALL_TIMEOUT_MS) {
          aborted = 'overall wall-clock budget (' + OVERALL_TIMEOUT_MS + 'ms) exceeded before this scenario could start';
          log.error('BLOCKED_RESOURCE: ' + aborted + ' — remaining scenarios in this run will not be attempted.');
          results.push(makeResult(suiteName, scenarioConfig.name, 'BLOCKED_RESOURCE', { reason: aborted }, 0));
          break outer;
        }

        const scenarioName = scenarioConfig.name;
        const timeoutMs = scenarioConfig.timeoutMs || DEFAULT_TIMEOUT_MS;
        log.step('Scenario: ' + scenarioName + ' (timeout ' + timeoutMs + 'ms)');
        let scenarioModule;
        try {
          scenarioModule = require('./tests/' + scenarioName + '.test');
        } catch (e) {
          log.error('Could not load scenario module ' + scenarioName + ': ' + e.message);
          results.push(makeResult(suiteName, scenarioName, 'FAIL', { error: 'module load failed: ' + e.message }, 0));
          continue;
        }

        const pagesBefore = launch.context.pages();
        const startedAt = Date.now();
        try {
          const result = await withTimeout(
            scenarioModule.run({ context: launch.context, extensionId: extInfo.id, serviceWorker: extInfo.serviceWorker, log }),
            timeoutMs,
            scenarioName
          );
          const elapsedMs = Date.now() - startedAt;
          log.info('PASS: ' + scenarioName + ' (' + elapsedMs + 'ms) — ' + (result.passed || []).length + ' checks passed');
          results.push(makeResult(suiteName, scenarioName, 'PASS', result.details || {}, elapsedMs, result.passed || []));
        } catch (err) {
          const elapsedMs = Date.now() - startedAt;
          if (err.isTimeout) {
            log.error('BLOCKED_RESOURCE: ' + scenarioName + ' timed out after ' + timeoutMs + 'ms — aborting remaining scenarios in this run rather than continuing against a possibly-unhealthy browser/session.');
            results.push(makeResult(suiteName, scenarioName, 'BLOCKED_RESOURCE', { error: err.message }, elapsedMs));
            aborted = scenarioName + ' timed out after ' + timeoutMs + 'ms';
            break outer;
          } else if (err.isExternalBlocker) {
            log.error('BLOCKED_BY_SITE: ' + scenarioName + ' — ' + err.message);
            results.push(makeResult(suiteName, scenarioName, 'BLOCKED_BY_SITE', err.details || { error: err.message }, elapsedMs));
          } else {
            log.error('FAIL: ' + scenarioName + ' — ' + err.message);
            if (err.stack) log.error(err.stack);
            results.push(makeResult(suiteName, scenarioName, 'FAIL', Object.assign({ error: err.message }, err.details || {}), elapsedMs));
          }
        } finally {
          // Resource-safety cleanup: close ONLY the pages THIS scenario
          // opened (diffed against pagesBefore) — ownership-scoped to
          // this run's own context, never a broader action. Screenshots
          // were already written to disk by the scenario before this
          // runs, so nothing evidentiary is lost.
          const pagesAfter = launch.context.pages();
          const newPages = pagesAfter.filter((p) => !pagesBefore.includes(p));
          for (const p of newPages) {
            try { await p.close(); } catch (e) { /* already closed / navigated away */ }
          }
          if (newPages.length) log.info('Closed ' + newPages.length + ' page(s) opened by ' + scenarioName + ' (resource cleanup between scenarios).');

          // ISOLATION cleanup (real bug found the first time this ever
          // ran multiple scenarios back-to-back in one shared context —
          // see this file's header for why context reuse is worth doing,
          // and this note for the cost it has to pay): every existing
          // e2e/tests/*.test.js scenario was written and verified against
          // e2e/run.js's own fresh-profile-per-run isolation, and none of
          // them clean up the storage they seed (a live session, a saved
          // column config, the popup's own last-active-tab preference,
          // etc.) — reusing ONE context without resetting chrome.storage
          // between scenarios let scenario N's leftover state (e.g. the
          // popup restoring "last viewed the Results tab") make scenario
          // N+1's own real popup controls genuinely hidden, a false FAIL
          // with nothing wrong in the product. Clearing storage here
          // reproduces the SAME fresh-install condition each scenario was
          // actually authored against, while still keeping the one
          // browser PROCESS (the expensive, resource-heavy part) shared.
          try {
            await withTimeout(extInfo.serviceWorker.evaluate(() => {
              return new Promise((resolve) => {
                chrome.storage.local.clear(() => {
                  chrome.storage.session.clear(() => resolve());
                });
              });
            }), 10000, 'chrome.storage clear between scenarios');
          } catch (e) {
            log.warn('Could not clear chrome.storage between scenarios (' + e.message + ') — next scenario may see leftover state.');
          }
        }
      }
    }
  } catch (fatalErr) {
    log.error('FATAL (harness/launch itself failed, not a scenario): ' + fatalErr.message);
    if (fatalErr.stack) log.error(fatalErr.stack);
    results.push({ suite: null, scenario: null, status: 'BLOCKED_RESOURCE', details: { error: fatalErr.message }, passed: [], elapsedMs: 0, finishedAt: new Date().toISOString() });
    aborted = aborted || ('fatal harness error: ' + fatalErr.message);
  } finally {
    if (launch) {
      await launch.closeUp(true);
      log.info('Closed the ONE browser context this run created, removed its temp profile: ' + launch.userDataDir);
    }
  }

  const summary = {
    selectedSuites: selectedSuiteNames,
    extensionId: extInfo ? extInfo.id : null,
    aborted: aborted,
    totalElapsedMs: Date.now() - runStartedAt,
    counts: countByStatus(results),
    results: results,
    finishedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'site-runner-summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n=== SITE run summary ===');
  results.forEach((r) => console.log('  ' + r.status.padEnd(16) + r.suite + ' / ' + r.scenario + ' (' + r.elapsedMs + 'ms)'));
  console.log(JSON.stringify(summary.counts));
  if (aborted) console.log('RUN ABORTED EARLY: ' + aborted);
  console.log('Full evidence: ' + path.join(ARTIFACT_DIR, 'site-runner-summary.json'));

  await log.close();
  const hasHardFailure = results.some((r) => r.status === 'FAIL');
  process.exitCode = hasHardFailure ? 1 : 0;
}

function makeResult(suite, scenario, status, details, elapsedMs, passed) {
  return { suite, scenario, status, details: details || {}, passed: passed || [], elapsedMs, finishedAt: new Date().toISOString() };
}

function countByStatus(results) {
  const out = { PASS: 0, FAIL: 0, BLOCKED_BY_SITE: 0, BLOCKED_RESOURCE: 0 };
  results.forEach((r) => { out[r.status] = (out[r.status] || 0) + 1; });
  return out;
}

main().catch((e) => {
  console.error('FATAL (site-runner itself crashed):', e);
  process.exitCode = 1;
});
