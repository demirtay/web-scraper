/**
 * healthdiag-buffer.test.js (FAST/local, no browser)
 * SELF-DIAGNOSTICS / HEALTH CHECK mission — proves the REAL, unmodified
 * utils/healthdiag.js shared diagnostic event buffer (loaded via
 * tests/lib/load-modules.js), covering the mission's own required proofs:
 *   7.  ring buffer is bounded (caps at 200, oldest dropped first)
 *   8.  diagnostic storage failure never affects the caller (never
 *       throws, never produces an unhandled rejection)
 *   9.  diagnostic clear (clearScope) does not touch user/session/
 *       result/license/settings data, and only clears the requested
 *       scope — the OTHER scope's own history survives untouched
 *
 * Standalone-runnable: `node tests/unit/healthdiag-buffer.test.js`.
 */
'use strict';
const { loadModules } = require('../lib/load-modules');
const { makeSuite } = require('../lib/assert');

async function run() {
  const suite = makeSuite('healthdiag-buffer');
  const assert = suite.assert;

  // ---- Ring buffer is bounded at exactly 200 entries, oldest dropped
  // first. ----
  {
    const sb = loadModules(['utils/healthdiag.js']);
    for (var i = 0; i < 205; i++) {
      sb.WSHealthDiag.pushEvent('main', 'stage-' + i, { i: i });
    }
    await sb.WSHealthDiag.flushQueue();
    var buf = sb.__storage.local[sb.WSHealthDiag.HEALTH_DIAG_KEY].entries;
    assert(buf.length === 200, 'MISSION PROOF: buffer caps at exactly 200 entries even after 205 pushes — got ' + buf.length);
    assert(buf[0].stage === 'stage-5', 'MISSION PROOF: the OLDEST entries are dropped first (first surviving entry is stage-5) — got ' + buf[0].stage);
    assert(buf[199].stage === 'stage-204', 'the newest entry (stage-204) is present at the end — got ' + buf[199].stage);
  }

  // ---- clearScope('main') removes ONLY 'main'-scope entries, leaving
  // 'detail'-scope entries (a genuinely different Detail run's own
  // history) completely untouched — proves the PARTIAL-clear contract,
  // not a full-buffer wipe. ----
  {
    const sb2 = loadModules(['utils/healthdiag.js']);
    sb2.WSHealthDiag.pushEvent('main', 'start-clicked', {});
    sb2.WSHealthDiag.pushEvent('detail', 'run-started', {});
    sb2.WSHealthDiag.pushEvent('main', 'permissions-resolved', {});
    await sb2.WSHealthDiag.flushQueue();
    var before = sb2.__storage.local[sb2.WSHealthDiag.HEALTH_DIAG_KEY].entries;
    assert(before.length === 3, 'setup check: 3 events seeded across both scopes');

    await sb2.WSHealthDiag.clearScope('main');
    var after = sb2.__storage.local[sb2.WSHealthDiag.HEALTH_DIAG_KEY].entries;
    assert(after.length === 1, 'MISSION PROOF: clearScope(\'main\') removes only the 2 main-scope entries — got ' + after.length + ' remaining');
    assert(after[0].scope === 'detail' && after[0].stage === 'run-started', 'MISSION PROOF: the Detail scope\'s own entry survives a main-scope clear untouched — got ' + JSON.stringify(after[0]));
  }

  // ---- clearScope() never touches any OTHER storage key — main scrape
  // results, license, settings, snapshots, deep-scrape state all stay
  // byte-for-byte identical. ----
  {
    const sb3 = loadModules(['utils/healthdiag.js']);
    var seed = {
      'ws_live_session::etsy.com': { sessionId: 's1', rows: [{ c_title: 'row 1' }] },
      'ws_license': { schemaVersion: 2, licenseStatus: 'trial', trialRunsUsed: 4 },
      'ws_settings': { theme: 'dark' },
      'ws_snapshots': { schemaVersion: 1, snapshots: [{ id: 'snap1' }] },
      'ws_deepscrape_run': { runId: 'r1', status: 'running' },
      'ws_deepscrape_fields': { 'https://x/1': { c_title: 'v' } }
    };
    Object.keys(seed).forEach(function (k) { sb3.__storage.local[k] = seed[k]; });
    var untouchedBefore = JSON.stringify(seed);

    sb3.WSHealthDiag.pushEvent('main', 'start-clicked', {});
    sb3.WSHealthDiag.pushEvent('detail', 'run-started', {});
    await sb3.WSHealthDiag.flushQueue();
    await sb3.WSHealthDiag.clearScope('main');
    await sb3.WSHealthDiag.clearScope('detail');

    var untouchedAfter = JSON.stringify({
      'ws_live_session::etsy.com': sb3.__storage.local['ws_live_session::etsy.com'],
      'ws_license': sb3.__storage.local['ws_license'],
      'ws_settings': sb3.__storage.local['ws_settings'],
      'ws_snapshots': sb3.__storage.local['ws_snapshots'],
      'ws_deepscrape_run': sb3.__storage.local['ws_deepscrape_run'],
      'ws_deepscrape_fields': sb3.__storage.local['ws_deepscrape_fields']
    });
    assert(untouchedBefore === untouchedAfter, 'MISSION PROOF: clearing both diagnostic scopes never touches main scrape results, license, settings, snapshots, or deep-scrape state — byte-for-byte identical');
    var diagBuf = sb3.__storage.local[sb3.WSHealthDiag.HEALTH_DIAG_KEY].entries;
    assert(diagBuf.length === 0, 'both scopes genuinely cleared from the diagnostic buffer itself');
  }

  // ---- Diagnostic write failure never throws and never produces an
  // unhandled rejection — pushEvent()/clearScope() must NEVER be able to
  // affect the caller's real work. ----
  {
    var unhandled = [];
    var onUnhandled = function (err) { unhandled.push(err); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const sb4 = loadModules(['utils/healthdiag.js'], {
        chrome: {
          storage: {
            local: {
              get: function (keys, cb) { cb({}); },
              set: function (data, cb) {
                // Simulates a real chrome.runtime.lastError quota failure
                // — the write never lands, but the callback still fires,
                // matching the real chrome.storage.local contract.
                if (cb) cb();
              },
              remove: function (keys, cb) { if (cb) cb(); }
            }
          },
          runtime: { lastError: { message: 'Resource::kQuotaBytes quota exceeded' } }
        }
      });
      var threw = null;
      try {
        sb4.WSHealthDiag.pushEvent('main', 'start-clicked', {});
        await sb4.WSHealthDiag.flushQueue();
      } catch (e) { threw = e; }
      assert(!threw, 'MISSION PROOF: pushEvent() never throws even when the underlying storage write is a real quota failure — got ' + (threw && threw.message));
      await new Promise(function (r) { setTimeout(r, 20); });
      assert(unhandled.length === 0, 'MISSION PROOF: zero unhandled promise rejections in the diagnostic write chain during a storage failure — got ' + unhandled.length);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
