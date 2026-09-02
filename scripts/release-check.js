/**
 * release-check.js  (V1.14 — Automated Release-Readiness Check)
 *
 * Runs a set of pass/fail checks against the source tree AND a freshly
 * built dist/ ZIP (via build-release.js), and exits non-zero if anything
 * fails. Meant to be run before every Chrome Web Store submission.
 *
 * Usage:  node scripts/release-check.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const buildRelease = require('./build-release.js');

let checks = 0, failures = 0;
function check(name, fn) {
  checks++;
  try {
    var result = fn();
    if (result === false) throw new Error('check returned false');
    console.log('PASS: ' + name + (typeof result === 'string' ? ' — ' + result : ''));
  } catch (e) {
    failures++;
    console.error('FAIL: ' + name + ' — ' + e.message);
  }
}

function readManifest() {
  var raw = fs.readFileSync(path.join(PROJECT_ROOT, 'manifest.json'), 'utf8');
  return JSON.parse(raw);
}

// ---- Minimal ZIP central-directory reader (read-only, just enough to
// list entry names back out of a ZIP built by utils/zip.js's buildZip) ----
function listZipEntryNames(zipPath) {
  var buf = fs.readFileSync(zipPath);
  // Find End Of Central Directory record (search from the end; no ZIP
  // comment is ever written by buildZip, so it's always the last 22 bytes).
  var eocdSig = 0x06054b50;
  var eocdOffset = -1;
  for (var i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === eocdSig) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Not a valid ZIP (no End Of Central Directory record found).');
  var totalEntries = buf.readUInt16LE(eocdOffset + 10);
  var centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

  var names = [];
  var ptr = centralDirOffset;
  for (var n = 0; n < totalEntries; n++) {
    var sig = buf.readUInt32LE(ptr);
    if (sig !== 0x02014b50) throw new Error('Malformed central directory entry at offset ' + ptr);
    var nameLen = buf.readUInt16LE(ptr + 28);
    var extraLen = buf.readUInt16LE(ptr + 30);
    var commentLen = buf.readUInt16LE(ptr + 32);
    var name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    names.push(name);
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function main() {
  var manifest = null;

  check('manifest.json parses as valid JSON', function () {
    manifest = readManifest();
    return true;
  });

  check('manifest.json has manifest_version 3', function () {
    if (!manifest) throw new Error('manifest not loaded');
    if (manifest.manifest_version !== 3) throw new Error('manifest_version is ' + manifest.manifest_version + ', expected 3');
    return true;
  });

  check('manifest.json has a non-empty semantic version', function () {
    if (!manifest.version || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
      throw new Error('version "' + manifest.version + '" is missing or not in x.y.z form');
    }
    return manifest.version;
  });

  check('required runtime files exist on disk', function () {
    var required = [
      'manifest.json', 'background/background.js', 'popup/popup.html', 'popup/popup.js', 'popup/popup.css',
      'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png'
    ];
    var missing = required.filter(function (rel) { return !fs.existsSync(path.join(PROJECT_ROOT, rel)); });
    if (missing.length) throw new Error('missing: ' + missing.join(', '));
    return required.length + ' files present';
  });

  check('background.service_worker file exists', function () {
    var sw = manifest.background && manifest.background.service_worker;
    if (!sw) throw new Error('manifest has no background.service_worker');
    if (!fs.existsSync(path.join(PROJECT_ROOT, sw))) throw new Error(sw + ' does not exist on disk');
    return sw;
  });

  check('icons referenced by manifest all exist on disk', function () {
    var iconSets = [manifest.icons || {}, (manifest.action && manifest.action.default_icon) || {}];
    var missing = [];
    iconSets.forEach(function (set) {
      Object.keys(set).forEach(function (size) {
        var rel = set[size];
        if (!fs.existsSync(path.join(PROJECT_ROOT, rel))) missing.push(rel);
      });
    });
    if (missing.length) throw new Error('missing: ' + missing.join(', '));
    return 'all icon paths resolve';
  });

  check('action.default_popup file exists', function () {
    var popup = manifest.action && manifest.action.default_popup;
    if (!popup) throw new Error('manifest has no action.default_popup');
    if (!fs.existsSync(path.join(PROJECT_ROOT, popup))) throw new Error(popup + ' does not exist on disk');
    return popup;
  });

  check('dynamically-injected content scripts (CONTENT_FILES) exist on disk', function () {
    // background.js and popup.js each declare the same CONTENT_FILES
    // array of paths relative to their own directory (../content/*.js)
    // used with chrome.scripting.registerContentScript/executeScript —
    // there is no static "content_scripts" manifest key in this
    // extension by design (V1.2's on-demand-injection architecture), so
    // this is the actual source of truth for "which content scripts ship".
    var bgSrc = fs.readFileSync(path.join(PROJECT_ROOT, 'background/background.js'), 'utf8');
    var m = bgSrc.match(/CONTENT_FILES\s*=\s*\[([\s\S]*?)\]/);
    if (!m) throw new Error('could not find CONTENT_FILES array in background.js');
    var relFromBg = Array.from(m[1].matchAll(/['"]([^'"]+)['"]/g)).map(function (x) { return x[1]; });
    if (!relFromBg.length) throw new Error('CONTENT_FILES array parsed empty');
    var missing = relFromBg.filter(function (rel) {
      // chrome.scripting's `js` paths are extension-root-relative (not
      // relative to background.js's own file location).
      return !fs.existsSync(path.join(PROJECT_ROOT, rel));
    });
    if (missing.length) throw new Error('missing: ' + missing.join(', '));
    return relFromBg.length + ' content scripts resolve';
  });

  check('no <script src="http...> or remote-executed JS in popup.html', function () {
    var html = fs.readFileSync(path.join(PROJECT_ROOT, 'popup/popup.html'), 'utf8');
    var scriptSrcs = Array.from(html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/gi)).map(function (x) { return x[1]; });
    var remote = scriptSrcs.filter(function (s) { return /^https?:\/\//i.test(s); });
    if (remote.length) throw new Error('remote script src found: ' + remote.join(', '));
    return scriptSrcs.length + ' script tags, all local';
  });

  check('no eval()/new Function()/remote importScripts() in runtime JS', function () {
    var dirs = ['background', 'content', 'popup', 'utils'];
    var offenders = [];
    dirs.forEach(function (d) {
      var abs = path.join(PROJECT_ROOT, d);
      fs.readdirSync(abs).forEach(function (f) {
        if (!f.endsWith('.js')) return;
        var src = fs.readFileSync(path.join(abs, f), 'utf8');
        if (/\beval\s*\(/.test(src)) offenders.push(d + '/' + f + ': eval(');
        if (/new\s+Function\s*\(/.test(src)) offenders.push(d + '/' + f + ': new Function(');
        var impMatches = src.match(/importScripts\(([\s\S]*?)\)/);
        if (impMatches && /https?:\/\//i.test(impMatches[1])) offenders.push(d + '/' + f + ': remote importScripts()');
      });
    });
    if (offenders.length) throw new Error(offenders.join('; '));
    return 'clean';
  });

  // ---- V1 FINAL PART C spec #42: "add a release check ensuring
  // production packaging does NOT expose QA trial-reset/force-unlock/
  // payment-simulation controls." The QA harness (popup.html's
  // #settings-dev-switcher, and its handleQa*/handleDevLicenseSwitch
  // wiring in popup.js) is architecturally gated behind
  // WSLicense.isDevelopmentInstall() — chrome.management.getSelf()
  // reporting installType==='development', which is true ONLY for an
  // unpacked/sideloaded install and can never be true for a real
  // Chrome-Web-Store install regardless of anything shipped in the ZIP.
  // This check doesn't re-verify that runtime gate (covered by
  // test-v1final-partbc-i18n-qa.js's TEST 7/8/9); it statically confirms
  // the SOURCE STILL HONORS that architecture — no QA/dev control was
  // added outside the gated container, and no dev-only license.js
  // function gained a second, ungated call site anywhere in the
  // packaged runtime. ----
  check('QA trial-state/force-unlock controls are not reachable outside the isDevelopmentInstall()-gated container', function () {
    var html = fs.readFileSync(path.join(PROJECT_ROOT, 'popup/popup.html'), 'utf8');
    var devSwitcherMatch = html.match(/<div id="settings-dev-switcher"[^>]*>[\s\S]*?<\/div>\s*<\/section>/);
    if (!devSwitcherMatch) throw new Error('could not find the #settings-dev-switcher container in popup.html');
    if (!/<div id="settings-dev-switcher" hidden>/.test(html)) throw new Error('#settings-dev-switcher is not `hidden` by default in the shipped HTML');
    var devSwitcherHtml = devSwitcherMatch[0];
    var qaControlIds = ['qa-trial-state-a-btn', 'qa-trial-state-b-btn', 'qa-trial-state-c-btn', 'qa-trial-state-d-btn', 'qa-trial-state-e-btn', 'qa-trial-reset-btn', 'settings-dev-license'];
    qaControlIds.forEach(function (id) {
      var re = new RegExp('id="' + id + '"|name="' + id + '"', 'g');
      var totalCount = (html.match(re) || []).length;
      var insideCount = (devSwitcherHtml.match(re) || []).length;
      if (totalCount === 0) throw new Error('expected QA control "' + id + '" was not found at all — has the harness moved?');
      if (totalCount !== insideCount) throw new Error('QA control "' + id + '" appears OUTSIDE the gated #settings-dev-switcher container (' + (totalCount - insideCount) + ' occurrence(s)) — this is a production QA-bypass risk');
    });

    var popupJs = fs.readFileSync(path.join(PROJECT_ROOT, 'popup/popup.js'), 'utf8');
    var qaHandlerNames = ['handleQaSetTrialRunsUsed', 'handleQaSimulateUnlock', 'handleQaResetTrialState', 'handleDevLicenseSwitch'];
    qaHandlerNames.forEach(function (fn) {
      // Every reference must be either the function's own `function fn(`
      // definition, or a reference reachable only via the
      // els.qaTrialState*/els.settingsDevSwitcher-scoped wiring already
      // covered by the HTML-side check above. A crude but effective
      // proxy: the function name must never appear inside background.js
      // or any content/*.js file (the only other places a hidden
      // "auto-unlock" style call could realistically be smuggled in).
      ['background/background.js'].concat(fs.existsSync(path.join(PROJECT_ROOT, 'content')) ? fs.readdirSync(path.join(PROJECT_ROOT, 'content')).filter(function (f) { return f.endsWith('.js'); }).map(function (f) { return 'content/' + f; }) : []).forEach(function (rel) {
        var abs = path.join(PROJECT_ROOT, rel);
        if (!fs.existsSync(abs)) return;
        var src = fs.readFileSync(abs, 'utf8');
        if (src.indexOf(fn) !== -1) throw new Error(fn + ' is referenced from ' + rel + ' — QA/dev-only license controls must only ever be reachable from the gated popup Settings UI');
      });
    });

    var licenseJs = fs.readFileSync(path.join(PROJECT_ROOT, 'utils/license.js'), 'utf8');
    var devOnlyLicenseFns = ['activateDevLicense', 'resetToTrialDev', 'simulateRevokedDev', 'setTrialRunsUsedDev'];
    devOnlyLicenseFns.forEach(function (fn) {
      if (!new RegExp('function\\s+' + fn + '\\s*\\(').test(licenseJs)) throw new Error('expected DEV ONLY function ' + fn + ' not found in utils/license.js — has it been renamed/removed without updating this check?');
      ['background/background.js'].forEach(function (rel) {
        var abs = path.join(PROJECT_ROOT, rel);
        if (!fs.existsSync(abs)) return;
        var src = fs.readFileSync(abs, 'utf8');
        if (src.indexOf(fn) !== -1) throw new Error('DEV ONLY WSLicense.' + fn + ' is referenced from ' + rel + ' — background code must never call a dev-only license bypass');
      });
    });
    return qaControlIds.length + ' QA controls confirmed gated, ' + qaHandlerNames.length + ' handlers + ' + devOnlyLicenseFns.length + ' dev-only license functions confirmed unreachable outside popup Settings';
  });

  // ---- V1 AUTO DETECTION DIAGNOSTICS: same production-exposure risk
  // category as the QA trial harness above (a debugging tool that must
  // never reach ordinary users), same architecture (WSLicense.
  // isDevelopmentInstall() gate), so it gets its own release check
  // mirroring the one above rather than being folded into it — the two
  // features are unrelated (trial/license vs. detection debugging) and
  // keeping them as separate checks means either can fail independently
  // with an unambiguous error message. ----
  check('AUTO detection diagnostic tool is not reachable outside the isDevelopmentInstall()-gated panel', function () {
    var html = fs.readFileSync(path.join(PROJECT_ROOT, 'popup/popup.html'), 'utf8');
    // FINAL UI REORGANIZATION mission — #auto-diag-panel is now a
    // <details> (joins the "▸ Geliştirici Araçları" convention every
    // other dev panel uses), not a plain <div>; hidden/reveal gating is
    // otherwise completely unchanged.
    if (!/<details id="auto-diag-panel"[^>]*\bhidden\b/.test(html)) throw new Error('#auto-diag-panel is not `hidden` by default in the shipped HTML');
    var diagPanelMatch = html.match(/<details id="auto-diag-panel"[^>]*>[\s\S]*?<\/details>/);
    if (!diagPanelMatch) throw new Error('could not find the #auto-diag-panel container in popup.html');
    var diagPanelHtml = diagPanelMatch[0];
    var diagControlIds = ['auto-diag-copy-btn', 'auto-diag-status', 'auto-diag-textarea'];
    diagControlIds.forEach(function (id) {
      var re = new RegExp('id="' + id + '"', 'g');
      var totalCount = (html.match(re) || []).length;
      var insideCount = (diagPanelHtml.match(re) || []).length;
      if (totalCount === 0) throw new Error('expected diagnostic control "' + id + '" was not found at all — has the harness moved?');
      if (totalCount !== insideCount) throw new Error('diagnostic control "' + id + '" appears OUTSIDE the gated #auto-diag-panel container — this is a production exposure risk');
    });

    var popupJs = fs.readFileSync(path.join(PROJECT_ROOT, 'popup/popup.js'), 'utf8');
    if (!/function revealAutoDiagPanelIfDev[\s\S]{0,300}isDevelopmentInstall/.test(popupJs)) {
      throw new Error('revealAutoDiagPanelIfDev() no longer visibly gates on WSLicense.isDevelopmentInstall() — the diagnostic panel could become reachable in production');
    }
    ['handleCopyAutoDiagnostic', 'formatAutoDiagnosticReport'].forEach(function (fn) {
      ['background/background.js'].forEach(function (rel) {
        var abs = path.join(PROJECT_ROOT, rel);
        if (!fs.existsSync(abs)) return;
        var src = fs.readFileSync(abs, 'utf8');
        if (src.indexOf(fn) !== -1) throw new Error(fn + ' is referenced from ' + rel + ' — the diagnostic tool must only ever be reachable from the gated popup UI');
      });
    });
    return diagControlIds.length + ' diagnostic controls confirmed gated inside #auto-diag-panel, reveal path confirmed to check isDevelopmentInstall()';
  });

  // ---- Same reachability contract, mirrored for the Detay tab's own
  // Detail Field Picker activation diagnostic ("▸ Geliştirici Araçları"
  // inside #tab-panel-detay). Never had a dedicated static check before
  // this mission — added now for the same "production build hides all
  // dev-only diagnostic UI" guarantee every other panel already has. ----
  check('Detail picker diagnostic tool is not reachable outside the isDevelopmentInstall()-gated panel', function () {
    var html = fs.readFileSync(path.join(PROJECT_ROOT, 'popup/popup.html'), 'utf8');
    if (!/<details id="detail-pick-diag-panel"[^>]*\bhidden\b/.test(html)) throw new Error('#detail-pick-diag-panel is not `hidden` by default in the shipped HTML');
    var diagPanelMatch = html.match(/<details id="detail-pick-diag-panel"[^>]*>[\s\S]*?<\/details>/);
    if (!diagPanelMatch) throw new Error('could not find the #detail-pick-diag-panel container in popup.html');
    var diagPanelHtml = diagPanelMatch[0];
    var diagControlIds = ['detail-pick-diag-copy-btn', 'detail-pick-diag-status', 'detail-pick-diag-textarea'];
    diagControlIds.forEach(function (id) {
      var re = new RegExp('id="' + id + '"', 'g');
      var totalCount = (html.match(re) || []).length;
      var insideCount = (diagPanelHtml.match(re) || []).length;
      if (totalCount === 0) throw new Error('expected diagnostic control "' + id + '" was not found at all — has the harness moved?');
      if (totalCount !== insideCount) throw new Error('diagnostic control "' + id + '" appears OUTSIDE the gated #detail-pick-diag-panel container — this is a production exposure risk');
    });

    var popupJs = fs.readFileSync(path.join(PROJECT_ROOT, 'popup/popup.js'), 'utf8');
    if (!/function revealDetailPickDiagPanelIfDev[\s\S]{0,300}isDevelopmentInstall/.test(popupJs)) {
      throw new Error('revealDetailPickDiagPanelIfDev() no longer visibly gates on WSLicense.isDevelopmentInstall() — the diagnostic panel could become reachable in production');
    }
    return diagControlIds.length + ' diagnostic controls confirmed gated inside #detail-pick-diag-panel, reveal path confirmed to check isDevelopmentInstall()';
  });

  // ---- FINAL UI REORGANIZATION mission — #session-diag-panel/
  // #pagination-diag-panel/#health-check-panel are now consolidated
  // inside ONE outer <details id="results-devtools-panel"> ("▸
  // Geliştirici Araçları"), which is itself gated (hidden by default,
  // only unhidden by revealResultsDevToolsPanelIfDev() after a real
  // isDevelopmentInstall() check) — the group's own <summary> label must
  // never be reachable in a production/store build either, not just its
  // contents. One consolidated check replaces the previous 3 separate
  // ones (each panel's own individual reveal-gate is still verified
  // too), reflecting the new nested structure precisely rather than
  // trying to pattern-match stale HTML shapes. ----
  check('Results-tab dev-only diagnostics are not reachable outside the isDevelopmentInstall()-gated Developer Tools group', function () {
    var html = fs.readFileSync(path.join(PROJECT_ROOT, 'popup/popup.html'), 'utf8');
    if (!/<details id="results-devtools-panel"[^>]*\bhidden\b/.test(html)) throw new Error('#results-devtools-panel is not `hidden` by default in the shipped HTML');
    var groupMatch = html.match(/<details id="results-devtools-panel"[^>]*>[\s\S]*?<\/details>/);
    if (!groupMatch) throw new Error('could not find the #results-devtools-panel container in popup.html');
    var groupHtml = groupMatch[0];

    var innerPanels = ['session-diag-panel', 'pagination-diag-panel', 'health-check-panel'];
    innerPanels.forEach(function (panelId) {
      var panelHiddenRe = new RegExp('<div id="' + panelId + '"[^>]*\\bhidden\\b');
      if (!panelHiddenRe.test(groupHtml)) throw new Error('#' + panelId + ' is not `hidden` by default inside #results-devtools-panel');
    });

    var diagControlIds = [
      'session-diag-copy-btn', 'session-diag-status', 'session-diag-textarea',
      'pagination-diag-copy-btn', 'pagination-diag-status', 'pagination-diag-textarea',
      'health-check-run-btn', 'health-check-copy-report-btn', 'health-check-copy-history-btn', 'health-check-clear-btn',
      'health-check-overall', 'health-check-main', 'health-check-pagination', 'health-check-ui-sync',
      'health-check-storage', 'health-check-detail', 'health-check-last-progress', 'health-check-current-page',
      'health-check-result-count', 'health-check-last-issue', 'health-check-status', 'health-check-textarea'
    ];
    diagControlIds.forEach(function (id) {
      var re = new RegExp('id="' + id + '"', 'g');
      var totalCount = (html.match(re) || []).length;
      var insideCount = (groupHtml.match(re) || []).length;
      if (totalCount === 0) throw new Error('expected diagnostic control "' + id + '" was not found at all — has the harness moved?');
      if (totalCount !== insideCount) throw new Error('diagnostic control "' + id + '" appears OUTSIDE the gated #results-devtools-panel container — this is a production exposure risk');
    });

    var popupJs = fs.readFileSync(path.join(PROJECT_ROOT, 'popup/popup.js'), 'utf8');
    [
      'revealResultsDevToolsPanelIfDev', 'revealSessionDiagPanelIfDev',
      'revealPaginationDiagPanelIfDev', 'revealHealthCheckPanelIfDev'
    ].forEach(function (fnName) {
      var re = new RegExp('function ' + fnName + '[\\s\\S]{0,300}isDevelopmentInstall');
      if (!re.test(popupJs)) throw new Error(fnName + '() no longer visibly gates on WSLicense.isDevelopmentInstall() — the diagnostic panel could become reachable in production');
    });
    [
      'handleCopySessionDiagnostic', 'formatSessionDiagnosticReport',
      'handleCopyPaginationDiagnostic', 'formatPaginationDiagnosticReport',
      'handleCopyHealthReport', 'handleCopyHealthHistory', 'handleClearHealthDiagnostics', 'gatherHealthCheckInput'
    ].forEach(function (fn) {
      ['background/background.js'].forEach(function (rel) {
        var abs = path.join(PROJECT_ROOT, rel);
        if (!fs.existsSync(abs)) return;
        var src = fs.readFileSync(abs, 'utf8');
        if (src.indexOf(fn) !== -1) throw new Error(fn + ' is referenced from ' + rel + ' — the diagnostic tool must only ever be reachable from the gated popup UI');
      });
    });
    return diagControlIds.length + ' diagnostic controls confirmed gated inside #results-devtools-panel, every reveal path confirmed to check isDevelopmentInstall()';
  });

  // ---- V1 FINAL PART B spec #45: automated translation-coverage audit.
  // Loads the real catalog files in a throwaway sandbox (no chrome.*
  // needed — WSI18n.coverageReport() is pure) and reports per-locale
  // coverage against English's own key set. Fails the release if any
  // supported locale drifts below 100% coverage of the CURRENT catalog
  // (a key added in English but never translated elsewhere) — this is a
  // regression guard, not a promise that literally every user-facing
  // string in the whole extension has a translation key yet (V1
  // intentionally ships a documented set of advanced/secondary strings
  // English-only — see "Chrome Extension projeler.txt"). ----
  check('translation catalog has 100% key coverage across all supported locales', function () {
    var sandbox = { console: console };
    sandbox.self = sandbox;
    var vm = require('vm');
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(PROJECT_ROOT, 'utils/i18n-data.js'), 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(path.join(PROJECT_ROOT, 'utils/i18n.js'), 'utf8'), sandbox);
    var report = sandbox.WSI18n.coverageReport();
    var lines = [];
    var short = false;
    Object.keys(report).forEach(function (lang) {
      lines.push(lang + ':' + report[lang].percent + '%');
      if (report[lang].percent < 100) short = true;
    });
    if (short) throw new Error('coverage below 100% — ' + lines.join(', '));
    return lines.join(', ');
  });

  var builtZipPath = null;
  check('production package builds successfully', function () {
    var result = buildRelease.build();
    builtZipPath = result.outPath;
    if (!fs.existsSync(builtZipPath)) throw new Error('build() returned but ' + builtZipPath + ' does not exist');
    return path.relative(PROJECT_ROOT, builtZipPath);
  });

  var zipNames = null;
  check('production ZIP has manifest.json at the ZIP root', function () {
    if (!builtZipPath) throw new Error('no built ZIP to inspect (previous check failed)');
    zipNames = listZipEntryNames(builtZipPath);
    if (zipNames[0] !== 'manifest.json') throw new Error('first entry is "' + zipNames[0] + '", expected "manifest.json"');
    if (zipNames.indexOf('manifest.json') !== 0) throw new Error('manifest.json is not at the root (nested path found)');
    return true;
  });

  check('production ZIP contains no forbidden development files', function () {
    if (!zipNames) throw new Error('no ZIP listing available (previous check failed)');
    var forbidden = zipNames.filter(function (n) {
      return buildRelease.isForbidden(path.basename(n)) || /^(scripts|dist|\.git|node_modules)\//.test(n) || n === '.git';
    });
    if (forbidden.length) throw new Error('forbidden entries present: ' + forbidden.join(', '));
    return zipNames.length + ' entries, none forbidden';
  });

  check('production ZIP entry count matches expected runtime file set', function () {
    var expected = buildRelease.collectRuntimeFiles().length;
    if (!zipNames) throw new Error('no ZIP listing available (previous check failed)');
    if (zipNames.length !== expected) throw new Error('ZIP has ' + zipNames.length + ' entries, expected ' + expected);
    return zipNames.length + ' entries';
  });

  console.log('\n' + checks + ' checks, ' + failures + ' failures');
  process.exit(failures ? 1 : 0);
}

main();
