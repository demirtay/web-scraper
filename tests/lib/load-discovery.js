/**
 * load-discovery.js
 * Loads content/discovery.js for real, unmodified, inside a Node `vm`
 * sandbox — same core technique tests/lib/load-background.js/load-
 * popup.js already established, scoped down to exactly what this one
 * content script needs at LOAD TIME (its module-scope guard, its
 * chrome.runtime.onMessage listener registration, and its own bootstrap-
 * resume block all run immediately when the file loads, mirroring a real
 * page injection).
 *
 * This loader is deliberately minimal: content/discovery.js's actual
 * scraping/pagination LOGIC (WSScraper, WSAutoScroll, WSLoadMore,
 * WSNextDetect, WSDomWait, WSRunState, WSDiscoveryCore) is NOT stubbed
 * here and is never exercised by the tests that use this loader — those
 * dependencies are only reached from inside runDiscoveryLoop(), which
 * these tests never call. What IS under test is the [WS-PAGE-DIAG]
 * PERSISTENT DIAGNOSTIC RING BUFFER (pushPageDiag/clearPaginationDiagBuffer,
 * exposed on the real, unmodified root.WSDiscovery for targeted testing
 * only — see that file's own comment on the export) — a self-contained
 * feature that only touches chrome.storage.local, never the scraping
 * engines.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * @param {object} store backing plain object
 * @param {function} quotaFailFn (key, value) -> boolean
 * @param {object} runtime the SAME object that becomes sandbox.chrome.
 *   runtime — set()'s failure path sets runtime.lastError synchronously
 *   before invoking the callback and clears it right after, mirroring
 *   the real chrome.storage.local contract exactly (same pattern tests/
 *   lib/load-background.js and tests/lib/load-popup.js already use).
 *   CORE RECOVERY MISSION — this was a real gap in this loader: it
 *   claimed to mirror that contract but never actually set lastError,
 *   so no test using quotaFailFn here could ever exercise code that
 *   correctly checks chrome.runtime.lastError (as content/discovery.js's
 *   own setSession() now does). Fixed here, not in a separate mission,
 *   because it's the exact scaffolding this mission's own required
 *   regression tests need.
 */
function makeArea(store, quotaFailFn, runtime) {
  return {
    get: function (keys, cb) {
      var out = {};
      var list = keys === null || keys === undefined ? Object.keys(store) : (Array.isArray(keys) ? keys : [keys]);
      // Real chrome.storage.local structured-clones on both read and
      // write — the caller's in-memory object and the browser's stored
      // copy are never the same reference. A shallow `out[k] = store[k]`
      // would let a caller's later in-place mutation of the object it
      // got back leak into "storage" even when a subsequent write to it
      // fails — a real, found gap that could make a quota-failure test
      // pass for the wrong reason (mock inaccuracy, not the real fix).
      // JSON round-trip is an accurate enough clone for the plain
      // JSON-serializable session objects this loader ever handles.
      list.forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(store, k)) {
          try { out[k] = JSON.parse(JSON.stringify(store[k])); } catch (e) { out[k] = store[k]; }
        }
      });
      cb(out);
    },
    set: function (data, cb) {
      var failed = Object.keys(data).some(function (k) { return quotaFailFn(k, data[k]); });
      if (failed) {
        runtime.lastError = { message: 'Resource::kQuotaBytes quota exceeded' };
        if (cb) cb();
        runtime.lastError = null;
        return;
      }
      Object.keys(data).forEach(function (k) { store[k] = data[k]; });
      runtime.lastError = null;
      if (cb) cb();
    },
    remove: function (keys, cb) {
      (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { delete store[k]; });
      if (cb) cb();
    }
  };
}

/**
 * @param {object} [opts]
 * @param {object} [opts.sharedStore] — pass the SAME plain object across
 *   two loadDiscovery() calls to simulate a real page navigation
 *   destroying one content-script instance and a fresh one being
 *   reinjected on the new page: chrome.storage.local is the one thing
 *   that genuinely survives that transition in real Chrome (every
 *   in-memory variable/closure — including a fresh IIFE's own
 *   pageDiagQueue — does NOT).
 * @param {function} [opts.quotaFailFn] (key, value) -> boolean
 * @param {string} [opts.url]
 * @returns {object} sandbox — sandbox.WSDiscovery is content/discovery.js's
 *   own real, unmodified exposed test surface; sandbox.__storage is the
 *   backing store object (same as opts.sharedStore when provided).
 */
function loadDiscovery(opts) {
  opts = opts || {};
  const store = opts.sharedStore || {};
  const quotaFailFn = opts.quotaFailFn || function () { return false; };
  var capturedListener = null;

  var runtime = {
    lastError: null,
    onMessage: { addListener: function (fn) { capturedListener = fn; } }
  };
  var chrome = {
    runtime: runtime,
    storage: { local: makeArea(store, quotaFailFn, runtime) }
  };

  var urlStr = opts.url || 'https://example.com/page';
  var u = new URL(urlStr);

  const sandbox = {
    console: console, JSON: JSON, Object: Object, Array: Array, Math: Math, Date: Date,
    Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout,
    AbortController: AbortController,
    chrome: chrome,
    document: {
      querySelectorAll: function () { return []; },
      querySelector: function () { return null; },
      body: { textContent: '' }
    },
    location: { href: urlStr, hostname: u.hostname },
    // Minimal real behavior (not a blind stub) — matches
    // utils/runstate.js's own normalizeHostname exactly, since the
    // bootstrap block below calls this at load time via sessionKey().
    WSRunState: { normalizeHostname: function (h) { return h ? String(h).toLowerCase().replace(/^www\./, '') : h; } }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  var full = path.join(REPO_ROOT, 'content', 'discovery.js');
  var code = fs.readFileSync(full, 'utf8');
  vm.runInContext(code, sandbox, { filename: full });

  sandbox.__storage = store;
  // Fires the REAL registered chrome.runtime.onMessage listener — never a
  // reimplementation — so a test can dispatch e.g. START_DISCOVERY/
  // STOP_DISCOVERY exactly as the real extension messaging would.
  //
  // Returns a STATE OBJECT (not the response value directly), since
  // several real handlers (e.g. STOP_DISCOVERY) call sendResponse()
  // asynchronously, well after this function itself has already
  // returned — `state.called`/`state.response` are mutated in place
  // whenever the real handler eventually calls sendResponse (sync OR
  // async), so a test can dispatch, await a few ticks, then check
  // `state.called`/`state.response` — proving the message channel was
  // genuinely answered and never left hanging.
  sandbox.__dispatchMessage = function (message) {
    if (!capturedListener) throw new Error('chrome.runtime.onMessage listener was never registered by content/discovery.js');
    var state = { called: false, response: null };
    capturedListener(message, {}, function (res) { state.called = true; state.response = res; });
    return state;
  };

  return sandbox;
}

module.exports = { loadDiscovery: loadDiscovery };
