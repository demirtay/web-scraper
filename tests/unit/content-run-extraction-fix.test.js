/**
 * content-run-extraction-fix.test.js (FAST/local, no browser)
 * BUG #1 REGRESSION — "BAŞLA does not actually start a new scrape / UI
 * hangs forever at 'Veri işleniyor…'" (real production report).
 *
 * ROOT CAUSE (proven by code reading, not guessed — see MISSION.md):
 * content/content.js's RUN_EXTRACTION handler (the content-script side
 * of handleStartLiveSession()'s FIRST content-script round trip) had NO
 * .catch() anywhere in its promise chain
 * (WSStorage.getState().then(fn).then(fn2)). If ANYTHING in that chain
 * rejected or threw (a stale/malformed containerSelector against the
 * CURRENT real page — migrateContainerSelectorIfStale()/WSScraper.
 * runExtraction() — or WSStorage.getState()/setState() itself),
 * sendResponse() was simply never called. Since the handler
 * `return true`s to keep the message channel open for an async reply,
 * popup.js's own `await chrome.tabs.sendMessage(tabId, {type:
 * 'RUN_EXTRACTION'})` (inside sendToContent()) then hangs forever — the
 * exact "Veri işleniyor…" freeze reported. This also explains "an old
 * session blocks the new run": handleStartLiveSession()'s own
 * `runTriggerInFlight` guard is only ever reset in its own `finally`
 * block, which cannot run while its own `await sendToContent(...)` is
 * permanently hung — so every SUBSEQUENT BAŞLA click was silently
 * swallowed by that guard, forever, with no error ever shown.
 *
 * This file loads the REAL, unmodified content/content.js inside a
 * minimal Node `vm` sandbox (same core technique tests/lib/
 * load-background.js already established for background.js) — real
 * code under test, never a reimplementation of the fix — and drives its
 * REAL registered RUN_EXTRACTION message listener directly.
 *
 * Standalone-runnable: `node tests/unit/content-run-extraction-fix.test.js`.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeSuite } = require('../lib/assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONTENT_PATH = path.join(REPO_ROOT, 'content', 'content.js');

/**
 * Loads the real content/content.js in a minimal sandbox. `opts.getStateImpl`/
 * `opts.runExtractionImpl` let a test control exactly how WSStorage/
 * WSScraper behave (including throwing/rejecting), without ever touching
 * the real file's own control-flow code.
 */
function loadContentScript(opts) {
  opts = opts || {};
  var messageListeners = [];

  var sandbox = {
    console: console,
    Promise: Promise,
    Object: Object,
    Array: Array,
    Math: Math,
    Date: Date,
    JSON: JSON,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    location: { hostname: opts.hostname || 'example.com', href: 'https://' + (opts.hostname || 'example.com') + '/' },
    requestAnimationFrame: function (cb) { return setTimeout(cb, 16); },
    // Minimal DOM stub — real content.js only touches `document` inside
    // picker-mode functions this test never exercises; RUN_EXTRACTION's
    // own path (migrateContainerSelectorIfStale/WSScraper.runExtraction)
    // is fully mocked below via WSStorage/WSScraper, so it never actually
    // needs a real DOM either.
    document: {
      addEventListener: function () {},
      removeEventListener: function () {},
      querySelectorAll: function () { return []; },
      querySelector: function () { return null; },
      body: { textContent: '' },
      createElement: function () { return { style: {}, addEventListener: function () {}, setAttribute: function () {}, appendChild: function () {} }; }
    },
    chrome: {
      runtime: {
        onMessage: { addListener: function (fn) { messageListeners.push(fn); } }
      }
    },
    WSStorage: {
      getState: opts.getStateImpl || function () { return Promise.resolve({ containerSelector: null, columns: [] }); },
      setState: opts.setStateImpl || function () { return Promise.resolve(); },
      makeColumnId: function () { return 'c_test'; }
    },
    WSScraper: {
      runExtraction: opts.runExtractionImpl || function () { return { rows: [], totalCount: 0 }; },
      runDetailExtraction: function () { return {}; },
      pickElementInfo: function () { return null; }
    },
    WSSelector: {}
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  var code = fs.readFileSync(CONTENT_PATH, 'utf8');
  vm.runInContext(code, sandbox, { filename: CONTENT_PATH });

  return {
    /** Dispatches a message to every real registered listener, exactly
     * like real Chrome's dispatch-to-all — resolves with whatever the
     * listener passed to sendResponse, or a sentinel if none ever did
     * (used to detect the ORIGINAL hang: a listener that returns true
     * but never calls sendResponse leaves this promise pending forever,
     * which the test races against a bounded timeout to prove). */
    dispatch: function (message, timeoutMs) {
      return new Promise(function (resolve) {
        var responded = false;
        var sendResponse = function (res) { if (!responded) { responded = true; resolve({ timedOut: false, response: res }); } };
        messageListeners.forEach(function (fn) { fn(message, {}, sendResponse); });
        setTimeout(function () { if (!responded) resolve({ timedOut: true, response: null }); }, timeoutMs || 500);
      });
    }
  };
}

async function run() {
  const suite = makeSuite('content-run-extraction-fix');
  const assert = suite.assert;

  // ---- 1. THE ACTUAL FIX: an exception deep in the chain
  // (WSScraper.runExtraction throwing — the real, plausible cause: a
  // stale/malformed selector against the CURRENT page's real DOM shape)
  // must now surface as an honest, immediate {ok:false, error} response
  // — never an unbounded hang. ----
  {
    var cs = loadContentScript({
      getStateImpl: function () { return Promise.resolve({ containerSelector: '.product', columns: [{ id: 'c1', relativeSelector: 'h1', attribute: 'text' }] }); },
      runExtractionImpl: function () { throw new Error('simulated real-page extraction failure'); }
    });
    var result = await cs.dispatch({ type: 'RUN_EXTRACTION' }, 500);
    assert(!result.timedOut, 'MISSION PROOF (BUG #1): RUN_EXTRACTION must NEVER hang forever when WSScraper.runExtraction() throws — got a timeout, meaning sendResponse was never called (the exact reported "Veri işleniyor…" freeze)');
    assert(result.response && result.response.ok === false, 'RUN_EXTRACTION must respond with ok:false on a genuine extraction failure — got ' + JSON.stringify(result.response));
    assert(result.response && typeof result.response.error === 'string' && result.response.error.indexOf('simulated real-page extraction failure') !== -1,
      'the real underlying error message must be surfaced, not swallowed — got ' + JSON.stringify(result.response));
  }

  // ---- 2. A rejected WSStorage.getState() (e.g. a genuine storage
  // access error) must also surface as an honest error, not a hang. ----
  {
    var cs2 = loadContentScript({
      getStateImpl: function () { return Promise.reject(new Error('simulated storage read failure')); }
    });
    var result2 = await cs2.dispatch({ type: 'RUN_EXTRACTION' }, 500);
    assert(!result2.timedOut, 'MISSION PROOF (BUG #1): a rejected WSStorage.getState() must never hang RUN_EXTRACTION forever');
    assert(result2.response && result2.response.ok === false, 'must respond with ok:false — got ' + JSON.stringify(result2.response));
  }

  // ---- 3. The ordinary success path is completely unaffected by the
  // fix — same response shape as before. ----
  {
    var cs3 = loadContentScript({
      getStateImpl: function () { return Promise.resolve({ containerSelector: '.product', columns: [] }); },
      runExtractionImpl: function () { return { rows: [{ c1: 'a' }, { c1: 'b' }], totalCount: 2 }; }
    });
    var result3 = await cs3.dispatch({ type: 'RUN_EXTRACTION' }, 500);
    assert(!result3.timedOut, 'the ordinary success path must still respond promptly');
    assert(result3.response && result3.response.ok === true && result3.response.rows.length === 2,
      'a genuinely successful extraction must still return ok:true with the real rows — got ' + JSON.stringify(result3.response));
  }

  // ---- 4. Static source guard: the real fix (a .catch() on this exact
  // promise chain) must remain present — permanent regression coverage
  // against a future edit accidentally removing it again. ----
  {
    var src = fs.readFileSync(CONTENT_PATH, 'utf8');
    var handlerStart = src.indexOf("message.type === 'RUN_EXTRACTION'");
    assert(handlerStart !== -1, 'the RUN_EXTRACTION handler must exist in content/content.js');
    var handlerSlice = src.slice(handlerStart, handlerStart + 3500);
    assert(/\}\)\.catch\(function \(e\) \{/.test(handlerSlice), 'the RUN_EXTRACTION handler\'s promise chain must have a .catch() guaranteeing sendResponse is always eventually called');
    assert(/sendResponse\(\{ ok: false, error:/.test(handlerSlice), 'the .catch() must respond with an honest {ok:false, error} rather than silently swallowing the failure');
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
