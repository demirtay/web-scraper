/**
 * build-release.js  (V1.14 — Production Build/Package Script)
 *
 * Produces dist/web-scraper-v<manifest version>.zip containing ONLY the
 * files Chrome actually needs to run the extension: manifest.json at the
 * ZIP root, plus the background/, content/, popup/, utils/, and icons/
 * directories in full. Nothing else in the project (tests, this scripts/
 * folder, node stuff, docs, scratch files, .git) is ever eligible — this
 * is an explicit ALLOWLIST of runtime paths, not a denylist, so a stray
 * dev file dropped next to real code can never leak into the package by
 * accident.
 *
 * Reuses utils/zip.js's dependency-free buildZip() (the same ZIP writer
 * V1.13.2 uses for bulk-download/research bundles at runtime) instead of
 * a second implementation or any external zip library — Node 18+ provides
 * the TextEncoder/btoa globals that file needs, so `require`-ing it here
 * attaches window.WSZip/self.WSZip -> globalThis.WSZip directly, no shim.
 *
 * Usage:  node scripts/build-release.js
 * Output: dist/web-scraper-v<version>.zip  (also prints a file listing +
 *         byte size, and the manifest version it packaged).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');

// Runtime-required top-level entries. Every one of these is either a
// single file copied verbatim, or a directory walked recursively and
// included in full — there is no partial-directory inclusion, so adding
// a new real runtime file under an already-allowlisted directory needs
// no change here, and nothing can be missed by forgetting to list it.
const RUNTIME_ENTRIES = [
  { type: 'file', rel: 'manifest.json' },
  { type: 'dir', rel: 'background' },
  { type: 'dir', rel: 'content' },
  { type: 'dir', rel: 'popup' },
  { type: 'dir', rel: 'utils' },
  { type: 'dir', rel: 'icons' }
];

// Defensive filename denylist applied while walking allowlisted
// directories — guards against OS/editor cruft (Thumbs.db, .DS_Store) or
// a test/scratch file someone accidentally saves inside a runtime folder
// ever ending up in the package, without excluding any real asset type.
const FORBIDDEN_NAME_PATTERNS = [
  /^\./,                 // dotfiles (.DS_Store, .gitkeep, etc.)
  /^Thumbs\.db$/i,
  /^desktop\.ini$/i,
  /(^|[\\/])test[-_]/i,  // test-*.js style files, if ever misplaced
  /\.test\.js$/i,
  /\.spec\.js$/i
];

function isForbidden(name) {
  return FORBIDDEN_NAME_PATTERNS.some(function (re) { return re.test(name); });
}

function walkDir(absDir, relDir, out) {
  var entries = fs.readdirSync(absDir, { withFileTypes: true });
  entries.forEach(function (entry) {
    if (isForbidden(entry.name)) {
      console.warn('  [skipped — forbidden name] ' + path.join(relDir, entry.name));
      return;
    }
    var absPath = path.join(absDir, entry.name);
    var relPath = path.join(relDir, entry.name);
    if (entry.isDirectory()) {
      walkDir(absPath, relPath, out);
    } else if (entry.isFile()) {
      out.push({ abs: absPath, rel: relPath });
    }
  });
}

function collectRuntimeFiles() {
  var files = [];
  RUNTIME_ENTRIES.forEach(function (entry) {
    var abs = path.join(PROJECT_ROOT, entry.rel);
    if (!fs.existsSync(abs)) {
      throw new Error('Required runtime path is missing: ' + entry.rel);
    }
    if (entry.type === 'file') {
      files.push({ abs: abs, rel: entry.rel });
    } else {
      walkDir(abs, entry.rel, files);
    }
  });
  return files;
}

function toZipName(relPath) {
  // ZIP entry names always use forward slashes, regardless of the host
  // OS's path separator (Windows path.join produces backslashes here).
  return relPath.split(path.sep).join('/');
}

function build() {
  var manifestRaw = fs.readFileSync(path.join(PROJECT_ROOT, 'manifest.json'), 'utf8');
  var manifest = JSON.parse(manifestRaw); // throws on invalid JSON — fail loudly, never package a broken manifest
  if (!manifest.version) {
    throw new Error('manifest.json has no "version" field.');
  }

  var files = collectRuntimeFiles();

  // Require utils/zip.js for its buildZip() implementation. It has no
  // module.exports of its own (it's written to attach to self/window/
  // globalThis in a browser or service-worker context) — under plain
  // Node, none of self/window exist, so its IIFE falls through to
  // globalThis, and requiring it here is enough to make WSZip available.
  require(path.join(PROJECT_ROOT, 'utils', 'zip.js'));
  if (!globalThis.WSZip || typeof globalThis.WSZip.buildZip !== 'function') {
    throw new Error('utils/zip.js did not expose WSZip.buildZip — cannot package.');
  }

  var zipEntries = files.map(function (f) {
    return { name: toZipName(f.rel), data: fs.readFileSync(f.abs) };
  });
  // manifest.json MUST be first / at the ZIP root — Chrome doesn't
  // actually care about entry order, but keeping it first makes manual
  // inspection (unzip -l) immediately readable, and release-check.js
  // asserts on it explicitly.
  zipEntries.sort(function (a, b) {
    if (a.name === 'manifest.json') return -1;
    if (b.name === 'manifest.json') return 1;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });

  var zipBytes = globalThis.WSZip.buildZip(zipEntries);

  var distDir = path.join(PROJECT_ROOT, 'dist');
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
  var outPath = path.join(distDir, 'web-scraper-v' + manifest.version + '.zip');
  fs.writeFileSync(outPath, zipBytes);

  console.log('Packaged ' + zipEntries.length + ' files (' + zipBytes.length + ' bytes) into:');
  console.log('  ' + outPath);
  console.log('manifest.json version: ' + manifest.version);
  console.log('\nContents:');
  zipEntries.forEach(function (e) { console.log('  ' + e.name); });

  return { outPath: outPath, manifest: manifest, entries: zipEntries };
}

if (require.main === module) {
  try {
    build();
  } catch (e) {
    console.error('BUILD FAILED: ' + e.message);
    process.exit(1);
  }
}

module.exports = { build: build, collectRuntimeFiles: collectRuntimeFiles, RUNTIME_ENTRIES: RUNTIME_ENTRIES, isForbidden: isForbidden };
