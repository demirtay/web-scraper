/**
 * discovery-real-amazon-next-trigger.test.js (FAST/local, no browser)
 * REAL AMAZON EVIDENCE mission — traces the ACTUAL production decision
 * path end-to-end: RUN_EXTRACTION -> session persistence -> START_DISCOVERY
 * -> discovery loop -> findNextControl -> trigger/navigation -> completion,
 * using the REAL, unmodified content/discovery.js (via its own explicitly
 * test-exposed runDiscoveryLoop() — "Exposed for targeted testing only")
 * and content/nextdetect.js — never a rewritten approximation of either.
 *
 * Real-browser evidence proved, in order:
 *   1. Row detection is no longer the bug — the persisted containerSelector
 *      correctly matches the real ~48 product rows
 *      ([data-component-type="s-search-result"][data-asin]).
 *   2. The real Amazon Next anchor genuinely exists in the live DOM,
 *      enabled, with a valid href to page 2:
 *        <a href="/s?k=desk+lamp&page=2&ref=sr_pg_1"
 *           aria-label="Go to next page, page 2"
 *           class="s-pagination-item s-pagination-next s-pagination-button
 *                  s-pagination-button-accessibility s-pagination-separator">
 *          Next
 *        </a>
 *   3. findNextControl(), called in isolation with a correctly-scoped
 *      containerSelector, DOES find this exact anchor (method=
 *      "pagination-landmark" — its aria-label "Go to next page, page 2"
 *      matches the loose "next" text tier, not the exact-name tier).
 *   4. Yet production still finalized as "discovery complete, 1 page".
 *
 * ROOT CAUSE (content/nextdetect.js's clickTrigger(), traced by actually
 * driving content/discovery.js's real STAGE 10-15 branch below): every
 * text/rel-based detection tier (rel=next, exact accessible-name, the
 * region loose-text/bare-arrow match — the tier that matches THIS exact
 * real anchor) has always used a SYNTHETIC MouseEvent dispatch as its
 * trigger, even when the found element is a real `<a href>` whose
 * destination is already known with certainty. A synthetic click's
 * default action is not guaranteed to reliably cause navigation on every
 * real site, and content/discovery.js's own waitForNavigationOrMutation()
 * then times out with no visible error — indistinguishable, from the
 * loop's perspective, from "there was nothing more to do" (this specific
 * test proves the FOUND/finalize branch is fine — see assertions below;
 * the real-Chrome symptom is consistent with the navigation itself never
 * actually happening after a synthetic dispatch).
 *
 * FIX (content/nextdetect.js only, content/discovery.js untouched):
 * clickTrigger() now checks whether the found element is a real anchor
 * with an href that independently verifies as "points at a higher page"
 * (pointsAtHigherPage() — the same narrow, already-proven check the
 * href-based tiers already used) and, if so, returns a direct-navigation
 * trigger instead of a synthetic click — centralized in ONE place so
 * every detection tier benefits with zero call-site changes anywhere
 * else, including content/discovery.js.
 *
 * This test drives content/discovery.js's REAL runDiscoveryLoop() with
 * page 1 already scraped (skipInitialScrape=true, exactly START_DISCOVERY's
 * own real contract) and the EXACT real Next anchor DOM above sitting
 * outside the real product rows, stubbing ONLY content/domwait.js's own
 * timer/MutationObserver-driven wait (a separate module, not part of the
 * traced bug) with a minimal, faithful shim that still calls the REAL
 * `trigger` callback discovery.js hands it and still resolves based on a
 * REAL location.href change — proving:
 *   - next candidate found (not "no-next-candidate")
 *   - NOT finalized via finalizeComplete('no-more-mechanisms')
 *   - the real trigger fires and issues a real navigation toward page=2
 *   - discovery.status ends up correctly reflecting a genuine page
 *     transition, not "discovery_complete" after 1 page.
 *
 * Standalone-runnable: `node tests/unit/discovery-real-amazon-next-trigger.test.js`.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createMiniDocument, el } = require('../lib/mini-dom');
const { makeSuite } = require('../lib/assert');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CARD_COUNT = 48;
const HOSTNAME = 'www.amazon.com';

function buildFixture() {
  var dom = createMiniDocument();
  var body = dom.body;

  var grid = el('div', { class: 'search-results-grid' });
  for (var i = 1; i <= CARD_COUNT; i++) {
    grid.appendChild(el('div', { class: 's-result-item s-asin', 'data-component-type': 's-search-result', 'data-asin': 'B0TEST' + i }, 'card ' + i));
  }
  body.appendChild(grid);

  // The EXACT real Amazon Next anchor from the real DOM diagnostic paste.
  var nextLink = el('a', {
    href: '/s?k=desk+lamp&page=2&ref=sr_pg_1',
    'aria-label': 'Go to next page, page 2',
    class: 's-pagination-item s-pagination-next s-pagination-button s-pagination-button-accessibility s-pagination-separator'
  }, 'Next');
  body.appendChild(nextLink);

  return { dom: dom, nextLink: nextLink };
}

function baseSession(containerSelector) {
  return {
    sessionId: 's1', hostname: HOSTNAME, status: 'active',
    startedAt: Date.now(), updatedAt: Date.now(),
    scraperConfig: { containerSelector: containerSelector, columns: [{ id: 'c_title', name: 'Title', relativeSelector: ':scope', attribute: 'text' }] },
    dedupeKey: null, seenKeys: {}, lastPassNewRows: 0, lastCheckAt: null,
    rows: (function () { var r = []; for (var i = 0; i < CARD_COUNT; i++) r.push({ c_title: 'row ' + i }); return r; })(),
    discovery: {
      status: 'discovering', enabled: true, pagesVisited: 1, discoveredUnique: CARD_COUNT,
      maxPages: 500, maxTotalCycles: 2000, scrollCycles: 0, loadMoreActions: 0,
      visitedUrls: ['https://' + HOSTNAME + '/s?k=desk+lamp'], lastPaginationAttempt: null,
      currentPageBaselineCandidateCount: 0, updatedAt: Date.now()
    },
    // Pre-seeded exactly like tests/unit/discovery-storage-quota-safety.
    // test.js's own established pattern — ensureInternalEngines() then
    // never touches root.WSAutoScroll/root.WSLoadMore at all, so this
    // test's loader deliberately never stubs those (out of scope for the
    // traced bug — page 1 is already fully scraped/skipped).
    autoScroll: { enabled: true, status: 'exhausted', stopReason: 'no-new-data', cycleCount: 1, maxCycles: 50, consecutiveNoNewData: 1, maxNoNewDataAttempts: 3, pageSignatures: [], updatedAt: Date.now() },
    loadMoreAuto: { enabled: true, status: 'exhausted', stopReason: 'no-candidate', clickCount: 0, maxClicks: 50, consecutiveNoNewData: 0, maxNoNewDataAttempts: 3, pageSignatures: [], updatedAt: Date.now() }
  };
}

/** Loads the REAL, unmodified content/discovery.js + content/nextdetect.js
 * together in one sandbox, backed by a real mini-dom (so findNextControl()
 * sees the actual fixture markup) and a real, controllable location.href.
 * content/domwait.js is stubbed — a separate module owning its own
 * timer/MutationObserver mechanics, not part of the traced bug — with a
 * minimal shim that still calls discovery.js's own real `trigger`
 * callback and still resolves based on a REAL href change, never
 * fabricating the outcome. */
function loadDiscoveryWithRealNextDetect(dom, storageStore) {
  var navigatedTo = { value: null };
  var startHref = 'https://' + HOSTNAME + '/s?k=desk+lamp';
  var loc = { hostname: HOSTNAME, href: startHref };
  Object.defineProperty(loc, 'href', {
    get: function () { return navigatedTo.value || startHref; },
    set: function (v) { navigatedTo.value = v; }
  });

  var listeners = [];
  var chromeObj = {
    runtime: { onMessage: { addListener: function (fn) { listeners.push(fn); } }, lastError: null },
    storage: {
      local: {
        get: function (keys, cb) {
          var out = {};
          var list = keys === null || keys === undefined ? Object.keys(storageStore) : (Array.isArray(keys) ? keys : [keys]);
          list.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(storageStore, k)) out[k] = JSON.parse(JSON.stringify(storageStore[k])); });
          cb(out);
        },
        set: function (data, cb) { Object.keys(data).forEach(function (k) { storageStore[k] = data[k]; }); if (cb) cb(); },
        remove: function (keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { delete storageStore[k]; }); if (cb) cb(); }
      }
    }
  };

  var sandbox = {
    console: console, JSON: JSON, Object: Object, Array: Array, Math: Math, Date: Date,
    Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout,
    AbortController: AbortController, URL: URL, URLSearchParams: URLSearchParams,
    MouseEvent: function (type) { this.type = type; },
    NodeFilter: { SHOW_ELEMENT: 1 },
    getComputedStyle: function () { return { display: 'block', visibility: 'visible' }; },
    chrome: chromeObj,
    document: dom.document,
    location: loc,
    // content/domwait.js stub — see this function's own header comment
    // for why this specific module is out of scope, and exactly what
    // real contract this shim preserves (calls the REAL trigger,
    // resolves based on a REAL href change).
    WSDomWait: {
      waitForNavigationOrMutation: function (opts) {
        return new Promise(function (resolve) {
          var before = loc.href;
          if (typeof opts.trigger === 'function') opts.trigger();
          setTimeout(function () {
            resolve(loc.href !== before ? 'url-changed' : 'timeout');
          }, 0);
        });
      },
      // Not exercised by this test (skipInitialScrape=true skips the
      // branch that calls this) — stubbed only as a safety net so an
      // unrelated bootstrap-resume path never crashes with a missing-
      // function error instead of failing this test's own assertions
      // meaningfully.
      waitForDomStable: function () { return Promise.resolve({ reason: 'settled' }); }
    },
    // Auto-scroll/Load-More are explicitly OUT OF SCOPE for this mission
    // (CLAUDE.md's own standing instruction: preserve their behavior
    // unchanged) and genuinely unrelated to the traced bug — this
    // fixture has no infinite-scroll/load-more content at all, so a real
    // engine run would also immediately find nothing to do. Minimal,
    // faithful no-op stubs: return the session UNCHANGED (already
    // 'exhausted' per baseSession's own seeding), never fabricating any
    // row growth or cycle count.
    WSAutoScroll: { runUntilExhausted: function (session) { return Promise.resolve(session); } },
    WSLoadMore: { runUntilExhausted: function (session) { return Promise.resolve(session); } },
    window: null
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.getComputedStyle = sandbox.getComputedStyle;

  vm.createContext(sandbox);
  ['utils/runstate.js', 'utils/discovery.js', 'content/nextdetect.js', 'content/discovery.js'].forEach(function (rel) {
    var full = path.join(REPO_ROOT, rel);
    vm.runInContext(fs.readFileSync(full, 'utf8'), sandbox, { filename: full });
  });
  sandbox.WSDiscovery.registerNextDetect = function () {}; // no-op — WSNextDetect is already the real global set by nextdetect.js above
  return { sandbox: sandbox, navigatedTo: navigatedTo, dispatch: function (message) {
    var state = { called: false, response: null };
    listeners.forEach(function (fn) { fn(message, {}, function (res) { state.called = true; state.response = res; }); });
    return state;
  } };
}

async function settle(ticks) {
  for (var i = 0; i < (ticks || 30); i++) await new Promise(function (r) { setTimeout(r, 0); });
}

async function run() {
  const suite = makeSuite('discovery-real-amazon-next-trigger');
  const assert = suite.assert;

  var built = buildFixture();
  var CONTAINER_SELECTOR = '[data-component-type="s-search-result"][data-asin]';
  var realMatchCount = built.dom.document.querySelectorAll(CONTAINER_SELECTOR).length;
  assert(realMatchCount === CARD_COUNT, 'MISSION PROOF (fixture sanity): the containerSelector matches exactly ' + CARD_COUNT + ' real rows, matching the real diagnostic\'s own proof that row detection is no longer the bug — got ' + realMatchCount);

  // Storage starts EMPTY at load time deliberately — content/discovery.js
  // has its own bootstrap-resume block that fires automatically at
  // module-load time if a running session is already sitting in storage
  // (exactly real Chrome's own "content script re-injected on a fresh
  // page" contract). Seeding AFTER load, then driving runDiscoveryLoop()
  // explicitly ourselves (exactly what content.js's real START_DISCOVERY
  // handler does), avoids a second, unwanted concurrent loop instance.
  var storageStore = {};
  var loaded = loadDiscoveryWithRealNextDetect(built.dom, storageStore);
  await settle(5); // let the (no-op, storage is empty) bootstrap attempt finish

  var sessionKey = 'ws_live_session::' + HOSTNAME.replace(/^www\./, '');
  storageStore[sessionKey] = baseSession(CONTAINER_SELECTOR);

  // ---- Real execution: content/discovery.js's own real, test-exposed
  // runDiscoveryLoop() — never a reimplementation. ----
  await loaded.sandbox.WSDiscovery.runDiscoveryLoop(HOSTNAME, /*skipInitialScrape*/ true);
  await settle(20);
  if (loaded.sandbox.WSDiscovery.flushPageDiagQueue) await loaded.sandbox.WSDiscovery.flushPageDiagQueue();

  var finalSession = storageStore[sessionKey];
  assert(!!finalSession, 'MISSION PROOF: a session still exists in storage after the loop run');
  var attempt = finalSession.discovery.lastPaginationAttempt;
  assert(!!attempt, 'MISSION PROOF: a pagination attempt was recorded');

  // ---- The core proof requested: found, not finalized as no-more-mechanisms. ----
  assert(attempt.nextCandidateFound === true, 'MISSION PROOF (item 4 — "next candidate found"): got ' + JSON.stringify(attempt));
  assert(attempt.outcome !== 'no-next-candidate', 'MISSION PROOF (item 4 — "NOT finalized as no-more-mechanisms"): outcome was NOT no-next-candidate — got ' + attempt.outcome);
  assert(finalSession.discovery.status !== 'discovery_complete' || attempt.paginationActionIssued === true, 'MISSION PROOF: if discovery did reach a terminal state, it is only AFTER a real navigation action was actually issued, never a premature no-candidate finalize — got status=' + finalSession.discovery.status + ' attempt=' + JSON.stringify(attempt));

  // ---- The specific navigation-action proof (item 4/5): the real
  // trigger actually fired and issued a real navigation toward page=2 —
  // not a synthetic click nobody observed the effect of. ----
  assert(attempt.paginationActionIssued === true, 'MISSION PROOF: paginationActionIssued=true — the extension itself invoked the trigger');
  assert(loaded.navigatedTo.value && loaded.navigatedTo.value.indexOf('page=2') !== -1, 'MISSION PROOF (FIX — direct navigation, not a synthetic click nobody can verify): location.href was actually set to the real page=2 URL — got ' + JSON.stringify(loaded.navigatedTo.value));
  assert(attempt.method === 'pagination-landmark', 'MISSION PROOF: matches the real diagnostic\'s own finding — found via the loose "next"-text tier (aria-label "Go to next page, page 2"), not an exact-name match — got ' + attempt.method);

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
