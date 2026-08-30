/**
 * load-modules.js
 * Shared loader for the FAST-level unit test suite (tests/unit/*.test.js).
 *
 * ClickScrape's own utils/*.js files are plain, framework-free browser
 * scripts — `(function (root) { ... })(window|self|globalThis)` IIFEs
 * that attach one global per module (WSCleaners, WSRunState, etc.),
 * exactly like every other file in this project (see CLAUDE.md: "no
 * build step, no framework, no bundler"). They are never `require()`-
 * able as-is. This loader runs them for REAL, unmodified, inside a
 * Node `vm` sandbox that stands in for a minimal browser global object
 * — the same technique this project's own real-browser test harness
 * documentation already describes as this codebase's established
 * testing convention, just centralized here once instead of copy-
 * pasted into every unit test file.
 *
 * Deliberately NOT a mocking framework: nothing about the modules
 * themselves is faked. Only `chrome.storage.local`/`chrome.storage.
 * session` are given a tiny real in-memory implementation (so modules
 * that touch chrome.storage — e.g. utils/detailtemplates.js — behave
 * exactly as they would against the real API's own shape) and the
 * `URL`/`URLSearchParams` globals are passed through from Node's own
 * (spec-compliant) implementation, since jsdom-free `vm` contexts don't
 * include them automatically.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * @param {string[]} relativePaths repo-relative paths, loaded in order
 *   (so a file that reads `root.WSOther` at its own top level sees it
 *   already attached — matches this project's own real load order,
 *   e.g. popup.html's <script> tag sequence).
 * @param {object} [extraGlobals] additional globals to seed into the
 *   sandbox before loading (rarely needed — the default chrome/URL
 *   shims cover the overwhelming majority of pure utils/ modules).
 * @returns {object} the sandbox object — every loaded module's own
 *   global (WSCleaners, WSRunState, ...) is a property on it, plus
 *   `__storage` exposing the raw in-memory chrome.storage backing store
 *   for tests that want to seed/inspect it directly.
 */
function loadModules(relativePaths, extraGlobals) {
  const localStore = {};
  const sessionStore = {};

  function makeArea(store) {
    return {
      get: function (keys, cb) {
        var out = {};
        var list = keys === null || keys === undefined ? Object.keys(store) : (Array.isArray(keys) ? keys : [keys]);
        list.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k]; });
        cb(out);
      },
      set: function (data, cb) {
        Object.keys(data).forEach(function (k) { store[k] = data[k]; });
        if (cb) cb();
      },
      remove: function (keys, cb) {
        (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { delete store[k]; });
        if (cb) cb();
      }
    };
  }

  const sandbox = {
    console: console,
    URL: URL,
    URLSearchParams: URLSearchParams,
    chrome: {
      storage: {
        local: makeArea(localStore),
        session: makeArea(sessionStore)
      },
      runtime: { lastError: null }
    },
    __storage: { local: localStore, session: sessionStore }
  };
  // Every utils/ module resolves its own attach target as
  // `typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis)`
  // (or some subset of that chain) — providing all three as the SAME
  // object means every module attaches to one place regardless of
  // which fallback branch it happens to take.
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  if (extraGlobals) Object.assign(sandbox, extraGlobals);

  vm.createContext(sandbox);
  relativePaths.forEach(function (rel) {
    var code = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    vm.runInContext(code, sandbox, { filename: rel });
  });
  return sandbox;
}

module.exports = { loadModules: loadModules, REPO_ROOT: REPO_ROOT };
