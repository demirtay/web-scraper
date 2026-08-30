/**
 * test-release.js — RELEASE test level (see TESTING.md).
 *
 * The comprehensive pre-release gate: full FAST + full SITE (every real-
 * site acceptance suite — Etsy, the primary workflow/picker/Detail
 * Enrichment suite, Amazon, eBay) + the Browser Process Safety
 * regression check. This is the ONLY level that may ever be reported as
 * "release verified" — mission's own explicit rule: "Must NOT report
 * VERIFIED if required real-site tests didn't run."
 *
 * Exit codes (distinct on purpose — a blocked site is not the same
 * severity as a real product regression):
 *   0 — everything ran and passed cleanly. Safe to call this VERIFIED.
 *   1 — a genuine FAILURE occurred (FAST failed, a SITE scenario FAILed,
 *       or the browser-safety regression check failed). NOT release-safe.
 *   2 — no hard failure, but at least one SITE scenario came back
 *       BLOCKED_BY_SITE or BLOCKED_RESOURCE — real-site coverage is
 *       INCOMPLETE. Per mission: a blocked test is not automatically a
 *       product regression, but this run must NOT be reported as fully
 *       verified either. See the printed summary for exactly what did
 *       not run and why.
 *
 * Usage: node scripts/test-release.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const ARTIFACT_DIR = path.join(PROJECT_ROOT, 'test-artifacts', 'latest');

function runStep(label, args) {
  console.log('\n########################################');
  console.log('# ' + label);
  console.log('########################################');
  try {
    execFileSync(process.execPath, args, { stdio: 'inherit', cwd: PROJECT_ROOT });
    return true;
  } catch (e) {
    console.error('STEP FAILED: ' + label + ' (exit code ' + (e.status != null ? e.status : '?') + ')');
    return false;
  }
}

function readSiteSummary() {
  const p = path.join(ARTIFACT_DIR, 'site-runner-summary.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function main() {
  const fastOk = runStep('1/3 — FAST (syntax + unit tests + infra-safety scan + release-check)', [path.join(PROJECT_ROOT, 'scripts', 'test-fast.js')]);

  const safetyOk = runStep('2/3 — Browser Process Safety live regression (browser-ownership-safety-check.js)', [path.join(PROJECT_ROOT, 'e2e', 'browser-ownership-safety-check.js')]);

  console.log('\n########################################');
  console.log('# 3/3 — SITE (full real-site acceptance: etsy, primary-workflow, amazon, ebay)');
  console.log('########################################');
  // Run directly (not via runStep) since e2e/site-runner.js's own exit
  // code only reflects hard FAILures, not BLOCKED_* — this gate needs to
  // read the actual summary to distinguish the two, not just the exit code.
  let siteRanOk = true;
  try {
    execFileSync(process.execPath, [path.join(PROJECT_ROOT, 'e2e', 'site-runner.js'), '--all', '--overall-timeout-ms=1800000'], { stdio: 'inherit', cwd: PROJECT_ROOT });
  } catch (e) {
    siteRanOk = false; // a real FAIL among scenarios (site-runner.js's own exit code convention)
  }
  const siteSummary = readSiteSummary();

  console.log('\n=== RELEASE summary ===');
  console.log('FAST: ' + (fastOk ? 'PASS' : 'FAIL'));
  console.log('Browser Process Safety regression: ' + (safetyOk ? 'PASS' : 'FAIL'));
  if (!siteSummary) {
    console.log('SITE: no site-runner-summary.json found — treating as FAIL (harness itself did not complete)');
  } else {
    console.log('SITE counts: ' + JSON.stringify(siteSummary.counts));
    if (siteSummary.aborted) console.log('SITE run was aborted early: ' + siteSummary.aborted);
    siteSummary.results.forEach((r) => console.log('  ' + r.status.padEnd(16) + r.suite + ' / ' + r.scenario));
  }

  const siteHasFail = !siteSummary || siteRanOk === false || (siteSummary.counts && siteSummary.counts.FAIL > 0);
  const siteHasBlocked = siteSummary && siteSummary.counts && (siteSummary.counts.BLOCKED_BY_SITE > 0 || siteSummary.counts.BLOCKED_RESOURCE > 0);

  if (!fastOk || !safetyOk || siteHasFail) {
    console.log('\nRELEASE: FAIL — this build is NOT release-safe. See the step output above for the specific failure(s).');
    process.exitCode = 1;
    return;
  }
  if (siteHasBlocked) {
    console.log('\nRELEASE: NOT FULLY VERIFIED — no hard failures, but one or more real-site scenarios were BLOCKED_BY_SITE or BLOCKED_RESOURCE (see list above). Per CLAUDE.md, this is not automatically a product regression, but this run must NOT be reported as a clean "VERIFIED" release gate — re-run test:sites once the blocking condition (CAPTCHA/login/resource pressure) has cleared.');
    process.exitCode = 2;
    return;
  }

  console.log('\nRELEASE: VERIFIED — FAST clean, Browser Process Safety regression clean, every real-site SITE scenario ran and PASSed.');
  process.exitCode = 0;
}

main();
