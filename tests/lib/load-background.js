/**
 * load-background.js
 * Loads background/background.js for real, unmodified, inside a Node
 * `vm` sandbox — the same core technique tests/lib/load-modules.js
 * already established for utils/*.js, extended with a richer `chrome.*`
 * mock (background.js is a real MV3 service worker, not a plain
 * `(function(root){...})` module: it calls `importScripts()` for its own
 * utils/ dependencies and registers several `chrome.*.on*.addListener`
 * listeners at its own top level) plus a real, synchronous, in-memory
 * `fetch()` stub so HTTP-path tests (validateDetailUrl/resolveDetailPage)
 * can control exactly what response each URL "returns" without any real
 * network access.
 *
 * Every mocked `chrome.tabs`/`chrome.scripting` call is backed by a tiny,
 * real in-memory tab registry (see `sandbox.__tabs`) — tests can inspect
 * exactly which tab ids were created/navigated/removed, proving worker-
 * tab ownership/reuse for real rather than asserting on a black box.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BACKGROUND_PATH = path.join(REPO_ROOT, 'background', 'background.js');

/**
 * @param {object} [opts]
 * @param {function} [opts.fetchImpl] (url, opts) -> Promise<FakeResponse>
 *   — see makeFakeResponse below for the shape a test should return.
 * @returns {object} sandbox — every background.js top-level function
 *   (classifyHttpFailure, resolveDetailPage, fetchOneDetailPage,
 *   deepScrapeCounts, acquireWorkerTab, ...) is a plain property on it,
 *   callable directly. `sandbox.__tabs` exposes the in-memory tab
 *   registry {tabs: {id: {url, status}}, nextId, created: [ids...],
 *   removed: [ids...], updated: [{id,url}...]} for ownership/reuse
 *   assertions. `sandbox.__storage` exposes the raw chrome.storage
 *   backing stores, same shape as load-modules.js.
 */
function loadBackground(opts) {
  opts = opts || {};
  const localStore = {};
  const sessionStore = {};

  // STORAGE-QUOTA test hook (mission requirement 6 — "handle quota
  // errors explicitly"): opts.quotaFailFn(key, value) -> boolean lets a
  // test simulate the real chrome.runtime.lastError = "Resource::
  // kQuotaBytes quota exceeded" failure mode for a specific key, exactly
  // matching real Chrome's own synchronous-during-callback lastError
  // contract (see utils/license.js's own persist() for the same pattern
  // this mirrors).
  var quotaFailFn = opts.quotaFailFn || function () { return false; };

  function makeArea(store) {
    return {
      get: function (keys, cb) {
        var out = {};
        var list = keys === null || keys === undefined ? Object.keys(store) : (Array.isArray(keys) ? keys : [keys]);
        list.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k]; });
        cb(out);
      },
      set: function (data, cb) {
        var failed = Object.keys(data).some(function (k) { return quotaFailFn(k, data[k]); });
        if (failed) {
          chrome.runtime.lastError = { message: 'Resource::kQuotaBytes quota exceeded' };
          if (cb) cb();
          chrome.runtime.lastError = null;
          return;
        }
        Object.keys(data).forEach(function (k) { store[k] = data[k]; });
        chrome.runtime.lastError = null;
        if (cb) cb();
      },
      remove: function (keys, cb) {
        (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { delete store[k]; });
        if (cb) cb();
      },
      setAccessLevel: function (opts2, cb) { if (cb) cb(); }
    };
  }

  // ---- In-memory tab registry — real ownership/lifecycle tracking, not
  // a no-op stub, so tests can prove "one tab, reused" for real. ----
  var tabRegistry = { tabs: Object.create(null), nextId: 1, created: [], removed: [], updated: [] };
  var updatedListeners = [];
  var alarmRegistry = Object.create(null);
  var alarmListeners = [];

  function fireTabComplete(tabId) {
    // Synchronous-enough for tests: fires on the next microtask so
    // `chrome.tabs.create`/`update`'s own callback has already returned
    // (matches real Chrome's own async-callback-then-later-event
    // ordering) without needing any real timers.
    Promise.resolve().then(function () {
      tabRegistry.tabs[tabId].status = 'complete';
      updatedListeners.forEach(function (fn) { try { fn(tabId, { status: 'complete' }); } catch (e) { /* ignore */ } });
    });
  }

  const chromeTabs = {
    create: function (createOpts, cb) {
      var id = tabRegistry.nextId++;
      tabRegistry.tabs[id] = { url: createOpts.url, status: 'loading' };
      tabRegistry.created.push(id);
      fireTabComplete(id);
      cb({ id: id, url: createOpts.url });
    },
    update: function (tabId, updateOpts, cb) {
      if (!tabRegistry.tabs[tabId]) { chrome.runtime.lastError = { message: 'No tab with id ' + tabId + '.' }; cb(undefined); chrome.runtime.lastError = null; return; }
      tabRegistry.tabs[tabId].url = updateOpts.url;
      tabRegistry.tabs[tabId].status = 'loading';
      tabRegistry.updated.push({ id: tabId, url: updateOpts.url });
      fireTabComplete(tabId);
      cb({ id: tabId, url: updateOpts.url });
    },
    get: function (tabId, cb) {
      var t = tabRegistry.tabs[tabId];
      if (!t) { chrome.runtime.lastError = { message: 'No tab.' }; cb(undefined); chrome.runtime.lastError = null; return; }
      cb({ id: tabId, url: t.url, status: t.status });
    },
    remove: function (tabId, cb) {
      delete tabRegistry.tabs[tabId];
      tabRegistry.removed.push(tabId);
      if (cb) cb();
    },
    query: function (queryInfo, cb) { cb([]); },
    sendMessage: opts.sendMessageImpl || function (tabId, message, cb) { cb(undefined); },
    onUpdated: {
      addListener: function (fn) { updatedListeners.push(fn); },
      removeListener: function (fn) { var i = updatedListeners.indexOf(fn); if (i !== -1) updatedListeners.splice(i, 1); }
    }
  };

  const chromeScripting = {
    executeScript: opts.executeScriptImpl || function () { return Promise.resolve([{ result: undefined }]); }
  };

  var installedListeners = [];
  var startupListeners = [];
  var messageListeners = [];
  var chrome = {
    runtime: {
      lastError: null,
      getURL: function (p) { return 'chrome-extension://test-extension-id/' + p; },
      onInstalled: { addListener: function (fn) { installedListeners.push(fn); } },
      onStartup: { addListener: function (fn) { startupListeners.push(fn); } },
      onMessage: { addListener: function (fn) { messageListeners.push(fn); } }
    },
    storage: {
      local: makeArea(localStore),
      session: makeArea(sessionStore),
      onChanged: { addListener: function () {}, removeListener: function () {} }
    },
    tabs: chromeTabs,
    scripting: {
      executeScript: chromeScripting.executeScript,
      getRegisteredContentScripts: function (o, cb) { cb([]); },
      registerContentScript: function (o, cb) { if (cb) cb(); },
      unregisterContentScripts: function (o, cb) { if (cb) cb(); }
    },
    alarms: {
      // Real (if minimal) in-memory tracking — so a test can prove an
      // alarm was actually created/cleared with the right name/period,
      // and can manually fire a real alarm tick via __fireAlarm below
      // (simulating exactly what a real chrome.alarms wake-up delivers —
      // this is the STALL-FIX ROUND 2 mechanism, so tests need to be
      // able to drive it for real, not just assert it was "set up").
      create: function (name, info) { alarmRegistry[name] = info || {}; },
      clear: function (name, cb) { delete alarmRegistry[name]; if (cb) cb(true); },
      getAll: function (cb) { cb(Object.keys(alarmRegistry).map(function (n) { return Object.assign({ name: n }, alarmRegistry[n]); })); },
      onAlarm: { addListener: function (fn) { alarmListeners.push(fn); } }
    },
    downloads: {
      download: function (o, cb) { if (cb) cb(1); }, cancel: function () {},
      onChanged: { addListener: function () {} }
    },
    notifications: { create: function () {} },
    permissions: {
      contains: function (o, cb) { cb(true); },
      request: function (o) { return Promise.resolve(true); }
    }
  };

  const sandbox = {
    console: console,
    URL: URL,
    URLSearchParams: URLSearchParams,
    chrome: chrome,
    setTimeout: setTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    clearTimeout: clearTimeout,
    AbortController: AbortController,
    Promise: Promise,
    Object: Object,
    Array: Array,
    Math: Math,
    Date: Date,
    JSON: JSON,
    __tabs: tabRegistry,
    __storage: { local: localStore, session: sessionStore },
    __alarms: alarmRegistry,
    // STALL-FIX ROUND 2 test hook: fires a real chrome.alarms.onAlarm
    // event to every registered listener, exactly the shape a genuine
    // alarm wake-up delivers — lets a test simulate "the service worker
    // was just restarted and a scheduled alarm just fired" for real,
    // rather than only asserting an alarm was scheduled.
    __fireAlarm: function (alarm) {
      alarmListeners.forEach(function (fn) { fn(alarm); });
    },
    // STALL-FIX ROUND 2 test hooks: simulate a manual "reload extension"
    // (onInstalled with reason:'update') or a real browser restart
    // (onStartup) — both real production dispatch paths, not just the
    // recovery helper function in isolation.
    __fireInstalled: function (details) {
      installedListeners.forEach(function (fn) { fn(details || { reason: 'update' }); });
    },
    __fireStartup: function () {
      startupListeners.forEach(function (fn) { fn(); });
    },
    // STALL-FIX ROUND 3 test hook: dispatches a message to EVERY real
    // registered chrome.runtime.onMessage listener, exactly like real
    // Chrome does (dispatch-to-all, not dispatch-to-first) — the
    // dedicated reconciler listener and whichever OTHER listener owns
    // this message type both fire for real. Resolves with whichever
    // listener actually called sendResponse (matching real Chrome: only
    // one reply ever wins), or null if none did.
    __dispatchMessage: function (message) {
      return new Promise(function (resolve) {
        var responded = false;
        var sendResponse = function (res) { if (!responded) { responded = true; resolve(res); } };
        var anyAsync = false;
        messageListeners.forEach(function (fn) {
          var keepChannelOpen = fn(message, {}, sendResponse);
          if (keepChannelOpen === true) anyAsync = true;
        });
        if (!anyAsync && !responded) resolve(null);
      });
    }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  // Real fetch, backed by a test-supplied implementation — never real
  // network access. Defaults to always-network-error if the test doesn't
  // supply one, so a forgotten mock fails loudly instead of silently
  // hitting the real internet.
  sandbox.fetch = function (url, fetchOpts) {
    var impl = opts.fetchImpl || function () { return Promise.reject(new TypeError('No fetchImpl provided to loadBackground() for URL: ' + url)); };
    return Promise.resolve(impl(url, fetchOpts));
  };

  sandbox.importScripts = function () {
    Array.prototype.slice.call(arguments).forEach(function (rel) {
      var resolved = path.resolve(path.dirname(BACKGROUND_PATH), rel);
      var code = fs.readFileSync(resolved, 'utf8');
      vm.runInContext(code, sandbox, { filename: resolved });
    });
  };

  vm.createContext(sandbox);
  var code = fs.readFileSync(BACKGROUND_PATH, 'utf8');
  vm.runInContext(code, sandbox, { filename: BACKGROUND_PATH });
  return sandbox;
}

/** Builds a fetch()-like fake Response object matching what
 * background.js's own deepScrapeFetch/validateDetailUrl expect to read
 * (`.ok`, `.status`, `.headers.get('content-type')`, `.url`, and a
 * `.body.cancel()` no-op). */
function makeFakeResponse(status, opts2) {
  opts2 = opts2 || {};
  return {
    ok: status >= 200 && status < 300,
    status: status,
    url: opts2.finalUrl || null,
    headers: { get: function (name) { return name.toLowerCase() === 'content-type' ? (opts2.contentType || 'text/html') : null; } },
    body: { cancel: function () {} }
  };
}

module.exports = { loadBackground: loadBackground, makeFakeResponse: makeFakeResponse, REPO_ROOT: REPO_ROOT };
