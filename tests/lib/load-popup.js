/**
 * load-popup.js
 * Loads popup/popup.js for real, unmodified, inside a Node `vm` sandbox —
 * same core technique tests/lib/load-background.js already established
 * for background.js, extended to popup.js's much larger real dependency
 * surface: every utils/*.js file popup.html itself loads (in the SAME
 * order), a permissive auto-vivifying DOM stub (popup.js makes 500+
 * document.getElementById calls at module scope building its own `els`
 * map), and promise-based chrome.tabs/chrome.permissions/chrome.scripting
 * mocks (popup.js calls these WITHOUT a callback, unlike background.js's
 * callback-style usage).
 *
 * popup.js runs its own init() immediately at the bottom of the file
 * (`init().catch(...)`) — this loader waits for that to settle before
 * returning, so a test's first call already sees a fully-initialized
 * popup (tabId/hostname/pageUrl resolved, state/license loaded).
 *
 * handleStartLiveSession() (and most other handlers) are NOT exported —
 * exactly like the real popup, the only way in is the real registered
 * DOM event listener. This loader exposes `sandbox.clickBasla()` (fires
 * the REAL captured 'click' listener on #basla-btn) for exactly that
 * reason — real code path, never a reimplementation of it.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Mirrors popup.html's own <script src> list and order exactly.
const SCRIPT_FILES = [
  'utils/storage.js', 'utils/runstate.js', 'utils/discovery.js', 'utils/csv.js', 'utils/zip.js',
  'utils/xlsx.js', 'utils/results.js', 'utils/recipes.js', 'utils/templates.js', 'utils/downloads.js',
  'utils/detailscope.js', 'utils/detailtemplates.js', 'utils/transforms.js', 'utils/cleaners.js',
  'utils/changes.js', 'utils/snapshots.js', 'utils/research.js', 'utils/license.js', 'utils/settings.js',
  'utils/i18n-data.js', 'utils/i18n.js', 'utils/destinations.js',
  'utils/healthdiag.js', 'utils/healthcheck.js', // SELF-DIAGNOSTICS / HEALTH CHECK mission
  'popup/popup.js'
];

function makeStubElement(id) {
  var el = {
    id: id, hidden: false, disabled: false, value: '', textContent: '', innerHTML: '',
    className: '', style: {}, children: [], dataset: {}, max: '', placeholder: '',
    _listeners: Object.create(null),
    addEventListener: function (evt, fn) { (el._listeners[evt] = el._listeners[evt] || []).push(fn); },
    removeEventListener: function (evt, fn) { if (!el._listeners[evt]) return; var i = el._listeners[evt].indexOf(fn); if (i !== -1) el._listeners[evt].splice(i, 1); },
    dispatch: function (evt, arg) { (el._listeners[evt] || []).forEach(function (fn) { fn(arg || {}); }); },
    appendChild: function (child) { el.children.push(child); return child; },
    insertBefore: function (child) { el.children.push(child); return child; },
    removeChild: function () {},
    replaceChildren: function () { el.children = []; },
    setAttribute: function (k, v) { el['_attr_' + k] = v; },
    getAttribute: function (k) { return el['_attr_' + k] != null ? el['_attr_' + k] : null; },
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    closest: function () { return null; },
    focus: function () {}, blur: function () {},
    click: function () { el.dispatch('click', { target: el }); },
    scrollIntoView: function () {},
    getBoundingClientRect: function () { return { top: 0, left: 0, width: 0, height: 0 }; }
  };
  return el;
}

/**
 * @param {object} [opts]
 * @param {function} [opts.sendMessageImpl] (tabId, message) -> response object (or a Promise of one) — backs chrome.tabs.sendMessage
 * @param {function} [opts.quotaFailFn] (key, value) -> boolean — when true, chrome.storage.local.set() for a data object containing that key fails with the real quota error message this mission's own bug report showed
 * @param {string} [opts.tabUrl] defaults to a generic https URL
 * @returns {Promise<object>} sandbox — resolves once popup.js's own init() has settled
 */
async function loadPopup(opts) {
  opts = opts || {};
  const localStore = Object.assign({}, opts.seedLocalStorage || {});
  const sessionStore = Object.assign({}, opts.seedSessionStorage || {});
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
        chrome.runtime.lastError = null;
        if (cb) cb();
      },
      setAccessLevel: function (o, cb) { if (cb) cb(); },
      // SELF-DIAGNOSTICS / HEALTH CHECK mission — real chrome.storage.
      // local.getBytesInUse(keys, cb) contract: null/undefined -> total
      // across every key; an array -> just those keys' combined size.
      // Estimated the same way utils/snapshots.js's own estimateBytes()
      // already does (JSON.stringify(...).length) — close enough for a
      // dev-only diagnostic, never used for any real control-flow
      // decision either in production or here.
      getBytesInUse: function (keys, cb) {
        var list = keys === null || keys === undefined ? Object.keys(store) : (Array.isArray(keys) ? keys : [keys]);
        var total = 0;
        list.forEach(function (k) {
          if (Object.prototype.hasOwnProperty.call(store, k)) {
            try { total += JSON.stringify(store[k]).length; } catch (e) { /* skip */ }
          }
        });
        cb(total);
      },
      QUOTA_BYTES: 10 * 1024 * 1024
    };
  }

  var elCache = Object.create(null);
  function getEl(id) {
    if (!elCache[id]) elCache[id] = makeStubElement(id);
    return elCache[id];
  }

  var doc = {
    getElementById: getEl,
    createElement: function (tag) { var e = makeStubElement('_created_' + tag); e.tagName = tag; return e; },
    createTextNode: function (text) { return { nodeType: 3, textContent: text }; },
    addEventListener: function () {},
    removeEventListener: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    getElementsByName: function () { return []; },
    getElementsByClassName: function () { return []; },
    getElementsByTagName: function () { return []; },
    body: makeStubElement('body'),
    documentElement: makeStubElement('html'),
    activeElement: null
  };

  var tabUrl = opts.tabUrl || 'https://example.com/';
  var chrome = {
    runtime: {
      lastError: null,
      getURL: function (p) { return 'chrome-extension://test-extension-id/' + p; },
      // sendToBackground() (popup.js) calls this promise-style, with no
      // callback — routes to a test-supplied impl so a test can observe
      // exactly which messages the popup actually sent to the real
      // background service worker (e.g. RESET_DEEP_SCRAPE), without
      // needing to load background.js in the same sandbox.
      sendMessage: function (message) {
        var impl = opts.runtimeSendMessageImpl || function () { return { ok: true }; };
        return Promise.resolve(impl(message));
      }
    },
    storage: {
      local: makeArea(localStore),
      session: makeArea(sessionStore),
      onChanged: { addListener: function () {}, removeListener: function () {} }
    },
    tabs: {
      query: function (queryInfo, cb) {
        var tabs = [{ id: 1, url: tabUrl, active: true, windowId: 1, index: 0, title: 'test' }];
        if (typeof cb === 'function') { cb(tabs); return undefined; }
        return Promise.resolve(tabs);
      },
      sendMessage: function (tabId, message) {
        var impl = opts.sendMessageImpl || function () { return { ok: true }; };
        return Promise.resolve(impl(tabId, message));
      },
      get: function (tabId, cb) { cb({ id: tabId, url: tabUrl }); }
    },
    scripting: {
      executeScript: function () { return Promise.resolve([{ result: undefined }]); },
      registerContentScripts: function () { return Promise.resolve(); },
      unregisterContentScripts: function () { return Promise.resolve(); },
      getRegisteredContentScripts: function (o, cb) { cb([]); }
    },
    permissions: {
      request: function () { return Promise.resolve(opts.permissionsGranted !== false); },
      contains: function (o, cb) { cb(true); }
    },
    downloads: { download: function (o, cb) { if (cb) cb(1); }, onChanged: { addListener: function () {} } },
    notifications: { create: function () {} },
    alarms: { create: function () {}, clear: function () {}, onAlarm: { addListener: function () {} } }
  };

  // A local, non-leaking wrapper — never mutates Node's own real global
  // URL class (this file's sandbox object is rebuilt fresh per
  // loadPopup() call, but the real `URL` reference is shared process-
  // wide across every test file scripts/test-fast.js runs in-process;
  // adding static methods directly onto it would silently contaminate
  // every OTHER test). `new SandboxURL(str)` still returns a genuine
  // `new URL(str)` (JS's own `new` semantics: a constructor function
  // that explicitly returns an object uses THAT object instead of the
  // implicit `this`), so every existing `new URL(...)` call site in
  // popup.js keeps working unmodified — this only ADDS the two static
  // Blob-URL methods triggerDownload() needs, real browsers have but
  // Node's URL class does not.
  function SandboxURL(input, base) { return new URL(input, base); }
  SandboxURL.createObjectURL = function () { return 'blob:mock-url'; };
  SandboxURL.revokeObjectURL = function () {};

  const sandbox = {
    console: console, URL: SandboxURL, URLSearchParams: URLSearchParams, Object: Object, Array: Array,
    Math: Math, Date: Date, JSON: JSON, Promise: Promise,
    // __blobsCreated captures every `new Blob([...], opts)` call verbatim
    // (joined content + mime type) so a test can inspect exactly what a
    // real "Export ..." button would have downloaded, without needing
    // real browser Blob-URL machinery.
    __blobsCreated: [],
    Blob: function (parts, blobOpts) {
      var content = (parts || []).map(function (p) {
        if (typeof p === 'string') return p;
        if (p instanceof Uint8Array || Buffer.isBuffer(p)) return Buffer.from(p).toString('utf8');
        return String(p);
      }).join('');
      var entry = { content: content, type: blobOpts && blobOpts.type };
      sandbox.__blobsCreated.push(entry);
      return entry;
    },
    FileReader: function () {},
    setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval,
    chrome: chrome, document: doc, location: { hostname: 'test-extension-id', href: 'chrome-extension://test-extension-id/popup/popup.html' },
    // __clipboardWrites captures every navigator.clipboard.writeText()
    // call verbatim so a test can assert on the REAL text a "Copy ..."
    // button produced, without needing its own separate mock per test.
    __clipboardWrites: [],
    navigator: {
      language: 'en-US',
      clipboard: {
        writeText: function (text) {
          sandbox.__clipboardWrites.push(text);
          return typeof opts.clipboardWriteImpl === 'function' ? opts.clipboardWriteImpl(text) : Promise.resolve();
        }
      }
    },
    // window.confirm() — this project's own established destructive-
    // action-confirmation pattern (see popup.js's many existing
    // confirm(...) call sites). Records every prompt text shown so a
    // test can assert on the EXACT wording, and is independently
    // steerable per test via opts.confirmImpl.
    __confirmPrompts: [],
    confirm: function (msg) {
      sandbox.__confirmPrompts.push(msg);
      return typeof opts.confirmImpl === 'function' ? opts.confirmImpl(msg) : true;
    },
    __storage: { local: localStore, session: sessionStore },
    __els: elCache
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  SCRIPT_FILES.forEach(function (rel) {
    var full = path.join(REPO_ROOT, rel);
    var code = fs.readFileSync(full, 'utf8');
    vm.runInContext(code, sandbox, { filename: full });
  });

  // popup.js's own init() runs immediately at load (init().catch(...)) —
  // give its promise chain real ticks to settle before handing the
  // sandbox back. A handful of microtask/macrotask flushes is enough for
  // every await in init() (all backed by the synchronous mocks above) to
  // resolve fully.
  for (var i = 0; i < 20; i++) {
    await new Promise(function (r) { setTimeout(r, 0); });
  }

  sandbox.clickBasla = function () {
    var el = elCache['basla-btn'];
    if (!el) throw new Error('#basla-btn listener was never registered — init()/wireEventListeners() did not run as expected');
    el.click();
  };
  sandbox.getEl = getEl;

  return sandbox;
}

module.exports = { loadPopup: loadPopup };
