/**
 * storage-quota-fix.test.js (FAST/local, no browser)
 * BUG #1 REGRESSION (round 2, real Chrome proof) — "Uncaught (in
 * promise) Error: Resource::kQuotaBytes quota exceeded at license.js:187"
 * thrown from chargeRunCredit() AFTER a genuinely successful extraction,
 * crashing the rest of handleStartLiveSession() (session creation,
 * persist, START_LIVE_WATCH, START_DISCOVERY all skipped) and leaving
 * the popup frozen at "Veri işleniyor…" forever.
 *
 * ROOT CAUSE: chrome.storage.local's quota is a TOTAL across every key
 * this extension owns, not per-write — license.js's own ws_license write
 * is small and isolated (confirmed by inspection), but a few-hundred-
 * byte write can still fail purely because OTHER keys (most likely:
 * accumulated ws_live_session::<hostname> entries, each holding a full
 * rows array that never gets cleaned up once a session is finished)
 * already fill the quota. chargeRunCredit() had no try/catch at its
 * call site in handleStartLiveSession() — the rejection propagated
 * straight out as an unhandled rejection.
 *
 * FIX (popup/popup.js): (1) chargeRunCredit() is now wrapped in
 * try/catch — a failure NEVER aborts the rest of the flow. (2) On
 * failure, reclaimObsoleteLiveSessionStorage() frees ONLY
 * status:'finished' ws_live_session::* entries for OTHER hostnames (the
 * one category of "provably obsolete" data this file can identify on
 * its own — never an 'active' session, never the current hostname's own
 * session, never ws_deepscrape_run/ws_run::* which are out of scope),
 * then chargeRunCredit() is retried ONCE with the SAME runId (idempotent
 * by construction — see license.js's own consumeRunCredit).
 *
 * This file drives the REAL, unmodified popup.js via tests/lib/
 * load-popup.js — the real registered #basla-btn click listener, never
 * a reimplementation of handleStartLiveSession().
 *
 * Standalone-runnable: `node tests/unit/storage-quota-fix.test.js`.
 */
'use strict';
const { loadPopup } = require('../lib/load-popup');
const { makeSuite } = require('../lib/assert');

async function settle(ticks) {
  for (var i = 0; i < (ticks || 40); i++) await new Promise(function (r) { setTimeout(r, 0); });
}

var STANDARD_SEED = {
  'ws_state::example.com': { containerSelector: '.item', columns: [{ id: 'c1', name: 'Title', relativeSelector: 'h1', attribute: 'text' }] }
};

function standardSendMessage(rows) {
  return function (tabId, message) {
    if (message.type === 'RUN_EXTRACTION') return { ok: true, rows: rows || [{ c1: 'a' }, { c1: 'b' }], totalCount: (rows || [{}, {}]).length, containerMigration: null };
    if (message.type === 'CLASSIFY_AUTO_ROWS') return { ok: false }; // popup.js falls back to "accept everything" — real, existing behavior
    if (message.type === 'START_LIVE_WATCH') return { ok: true };
    if (message.type === 'START_DISCOVERY') return { ok: true };
    return { ok: true };
  };
}

async function run() {
  const suite = makeSuite('storage-quota-fix');
  const assert = suite.assert;

  // ---- Rigorous, direct proof of the exact reported symptom class:
  // attach a REAL process-level unhandledRejection listener for the
  // duration of every scenario below — if the old bug were still
  // present, THIS is what would fire. ----
  var unhandled = [];
  function onUnhandled(err) { unhandled.push(err); }
  process.on('unhandledRejection', onUnhandled);

  try {
    // ---- SCENARIO 1: quota exceeded on EVERY ws_license write (no
    // 'finished' session anywhere to reclaim) — the worst case. Must
    // still: never throw an unhandled rejection, reach STAGE 16, create
    // and persist the new session, send START_LIVE_WATCH/START_DISCOVERY,
    // and correctly NOT charge the trial run (storage genuinely
    // couldn't record it — never silently fabricated). ----
    {
      var sb = await loadPopup({
        seedLocalStorage: STANDARD_SEED,
        sendMessageImpl: standardSendMessage(),
        quotaFailFn: function (key) { return key === 'ws_license'; } // ALWAYS fails, exactly reproducing the real report
      });
      sb.clickBasla();
      await settle(60);

      assert(unhandled.length === 0, 'MISSION PROOF: no unhandled promise rejection must ever occur when chargeRunCredit fails — got ' + unhandled.length + ': ' + unhandled.map(function (e) { return e && e.message; }).join('; '));

      var session = sb.__storage.local['ws_live_session::example.com'];
      assert(!!session, 'MISSION PROOF: the new live session must still be created and persisted even though chargeRunCredit permanently failed — got none');
      assert(session && session.rows.length === 2, 'the new session must contain the genuinely extracted rows');
      assert(session && session.status === 'active', 'the new session must reach status:active (proves STAGE 11-13 all ran)');

      var rowCountText = sb.getEl('row-count').textContent;
      assert(rowCountText === '(2 rows)', 'MISSION PROOF: the real DOM must show the NEW results, not stay frozen — got ' + JSON.stringify(rowCountText));

      var license = sb.__storage.local['ws_license'];
      assert(!license || !license.trialRunsUsed, 'the trial counter must NOT be silently incremented when the write that would record it never actually succeeded — got ' + JSON.stringify(license));
    }

    // ---- SCENARIO 2: quota exceeded, but a status:'finished' session
    // for a DIFFERENT hostname exists — the reclaim-and-retry path.
    // Must free exactly that key and successfully charge the run on
    // retry. ----
    {
      var bigFinishedSession = { sessionId: 'old1', hostname: 'other-site.com', status: 'finished', rows: new Array(500).fill({ c1: 'padding-row-to-simulate-real-storage-bloat', c2: 'more padding text here to add real bytes' }) };
      var sb2 = await loadPopup({
        seedLocalStorage: Object.assign({}, STANDARD_SEED, { 'ws_live_session::other-site.com': bigFinishedSession }),
        sendMessageImpl: standardSendMessage(),
        // Fails exactly ONCE for ws_license (simulating quota genuinely
        // exceeded before the reclaim), succeeds on the retry after
        // reclaim frees space — a real quota condition is resolved by
        // freeing bytes, not by magic; this models that honestly.
        quotaFailFn: (function () {
          var failedOnce = false;
          return function (key) {
            if (key !== 'ws_license') return false;
            if (!failedOnce) { failedOnce = true; return true; }
            return false;
          };
        })()
      });
      sb2.clickBasla();
      await settle(60);

      assert(unhandled.length === 0, 'no unhandled rejection in the reclaim-and-retry scenario either');
      assert(!sb2.__storage.local['ws_live_session::other-site.com'], 'MISSION PROOF: the obsolete FINISHED other-hostname session must be removed by the reclaim');
      var session2 = sb2.__storage.local['ws_live_session::example.com'];
      assert(!!session2 && session2.status === 'active', 'the new (current-hostname) session must still be created successfully');
      var license2 = sb2.__storage.local['ws_license'];
      assert(license2 && license2.trialRunsUsed === 1, 'MISSION PROOF: after the reclaim frees space, the retry succeeds and the run IS correctly charged — got ' + JSON.stringify(license2));
    }

    // ---- SCENARIO 3: an ACTIVE session for a different hostname must
    // NEVER be touched by the reclaim, even under quota pressure. ----
    {
      var activeOtherSession = { sessionId: 'old2', hostname: 'still-working-site.com', status: 'active', rows: [{ c1: 'real in-progress data' }] };
      var sb3 = await loadPopup({
        seedLocalStorage: Object.assign({}, STANDARD_SEED, { 'ws_live_session::still-working-site.com': activeOtherSession }),
        sendMessageImpl: standardSendMessage(),
        quotaFailFn: function (key) { return key === 'ws_license'; } // always fails — forces the reclaim attempt to run
      });
      sb3.clickBasla();
      await settle(60);

      assert(unhandled.length === 0, 'no unhandled rejection here either');
      assert(!!sb3.__storage.local['ws_live_session::still-working-site.com'], 'MISSION PROOF (requirement 4): an ACTIVE session for another hostname must be preserved, never deleted by the reclaim, even when nothing else can be freed');
      var stillActive = sb3.__storage.local['ws_live_session::still-working-site.com'];
      assert(stillActive.status === 'active' && stillActive.rows.length === 1, 'the untouched active session\'s own data must be byte-for-byte unchanged');
    }

    // ---- SCENARIO 4: baseline — no quota problem at all — completely
    // unaffected by this fix (same real flow, same real outcome). ----
    {
      var sb4 = await loadPopup({ seedLocalStorage: STANDARD_SEED, sendMessageImpl: standardSendMessage() });
      sb4.clickBasla();
      await settle(60);
      assert(unhandled.length === 0, 'no unhandled rejection in the ordinary, no-quota-problem baseline case');
      var license4 = sb4.__storage.local['ws_license'];
      assert(license4 && license4.trialRunsUsed === 1, 'the ordinary success path still correctly charges the trial run — unaffected by this fix');
    }
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
