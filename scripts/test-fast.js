/**
 * test-fast.js — FAST test level (see TESTING.md).
 *
 * The permanent `npm run test:fast` entry point. Covers, in order:
 *   1. `node --check` syntax validation of every product/test JS file
 *      in the repo (excluding node_modules/dist/test-artifacts).
 *   2. Every tests/unit/*.test.js pure-logic unit test (loaded and run
 *      in-process via each file's own exported `run()`).
 *   3. scripts/check-test-infra-safety.js (static Browser Process
 *      Safety regression guard).
 *   4. scripts/release-check.js (the existing static release gate).
 *
 * MUST NOT launch a browser. Nothing in this file, or anything it
 * requires/spawns, may import Playwright or touch e2e/lib/browser.js —
 * that is the whole point of a fast level a developer can run on every
 * save. See CLAUDE.md's testing-policy section for when FAST alone is
 * sufficient vs. when FAST+SITE or full RELEASE is required.
 *
 * Usage: node scripts/test-fast.js
 * Exit code: 0 if everything passed, 1 otherwise.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');

// Directories never walked for syntax-checking or unit-test discovery —
// third-party code, build output, and generated test evidence are not
// this project's own source.
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'test-artifacts']);

let sections = 0, sectionFailures = 0;
function section(name, fn) {
  sections++;
  console.log('\n=== ' + name + ' ===');
  try {
    var ok = fn();
    if (ok === false) { sectionFailures++; console.error('SECTION FAILED: ' + name); }
  } catch (e) {
    sectionFailures++;
    console.error('SECTION CRASHED: ' + name + ' — ' + (e && e.stack || e));
  }
}

function walkJsFiles(dir, out) {
  out = out || [];
  var entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  entries.forEach(function (entry) {
    if (EXCLUDED_DIRS.has(entry.name)) return;
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  });
  return out;
}

function runSyntaxChecks() {
  var files = walkJsFiles(PROJECT_ROOT);
  var checked = 0, failed = 0;
  files.forEach(function (file) {
    checked++;
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (e) {
      failed++;
      var rel = path.relative(PROJECT_ROOT, file);
      console.error('FAIL: syntax error in ' + rel);
      console.error((e.stderr || e.message || '').toString().trim());
    }
  });
  console.log('Syntax-checked ' + checked + ' files, ' + failed + ' failures');
  return failed === 0;
}

function discoverUnitTests() {
  var dir = path.join(PROJECT_ROOT, 'tests', 'unit');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(function (f) { return f.endsWith('.test.js'); })
    .map(function (f) { return path.join(dir, f); });
}

// Each tests/unit/*.test.js file exports a `run()` that returns either a
// plain {assertions, failures} result or a Promise of one (a handful of
// files touch async storage APIs, e.g. detailscope-and-templates.test.js
// — Promise support is a deliberate, permanent part of this contract,
// not a special case for one file). Running inside this async function
// lets every file be awaited uniformly regardless of which shape it uses.
async function runUnitTestsAsync() {
  var files = discoverUnitTests();
  if (!files.length) {
    console.error('FAIL: no tests/unit/*.test.js files found');
    return false;
  }
  var totalAssertions = 0, totalFailures = 0, crashed = 0;
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var rel = path.relative(PROJECT_ROOT, file);
    try {
      var mod = require(file);
      if (!mod || typeof mod.run !== 'function') {
        crashed++;
        console.error('CRASHED: ' + rel + ' does not export a run() function');
        continue;
      }
      var result = await mod.run();
      if (!result || typeof result.assertions !== 'number') {
        crashed++;
        console.error('CRASHED: ' + rel + ' run() did not return {assertions, failures}');
        continue;
      }
      totalAssertions += result.assertions;
      totalFailures += result.failures;
    } catch (e) {
      crashed++;
      console.error('CRASHED running ' + rel + ': ' + (e && e.stack || e));
    }
  }
  console.log(files.length + ' unit test files, ' + totalAssertions + ' assertions, ' + totalFailures + ' failures, ' + crashed + ' crashed');
  return totalFailures === 0 && crashed === 0;
}

function runSubscript(rel) {
  try {
    execFileSync(process.execPath, [path.join(PROJECT_ROOT, rel)], { stdio: 'inherit', cwd: PROJECT_ROOT });
    return true;
  } catch (e) {
    return false;
  }
}

async function main() {
  section('1/4 — Syntax check (node --check, every product/test .js file)', runSyntaxChecks);

  sections++;
  console.log('\n=== 2/4 — Unit tests (tests/unit/*.test.js) ===');
  try {
    var ok = await runUnitTestsAsync();
    if (!ok) { sectionFailures++; console.error('SECTION FAILED: 2/4 — Unit tests'); }
  } catch (e) {
    sectionFailures++;
    console.error('SECTION CRASHED: 2/4 — Unit tests — ' + (e && e.stack || e));
  }

  section('3/4 — Browser Process Safety static scan (check-test-infra-safety.js)', function () {
    return runSubscript(path.join('scripts', 'check-test-infra-safety.js'));
  });

  section('4/4 — Release-readiness static gate (release-check.js)', function () {
    return runSubscript(path.join('scripts', 'release-check.js'));
  });

  console.log('\n=== FAST summary ===');
  console.log(sections + ' sections, ' + sectionFailures + ' failed');
  console.log(sectionFailures === 0 ? 'FAST: PASS' : 'FAST: FAIL');
  process.exit(sectionFailures === 0 ? 0 : 1);
}

main();
