/**
 * license.js
 * V1.15 introduced the usage-based trial/license model (replacing V1.14's
 * feature-based Free/Pro gating entirely): every feature is available to
 * every user; a new user gets 10 free SUCCESSFUL scraping runs, then a
 * one-time $5 purchase unlocks unlimited use. This file is the single
 * source of truth for that state, exactly as it was in V1.15 — nothing
 * about the TRIAL ACCOUNTING (consumeRunCredit/hasRunsRemaining) below
 * changed in V1.16; every V1.15 test still passes unmodified.
 *
 * V1.16 — Commercial Release Architecture — extends this same file with
 * the STATE MODEL and STUB FUNCTIONS the full production flow needs
 * (Extension -> Upgrade button -> hosted checkout -> payment -> backend
 * -> license creation -> activation token -> extension activation ->
 * server verification -> permanent Unlimited status), WITHOUT
 * integrating any real payment provider or backend yet — every new
 * function below fails closed exactly like V1.15's activateLicense()
 * already did, and LICENSE_API_BASE_URL/CHECKOUT_URL stay null (V1.14's
 * established "coming soon" convention: a real destination that doesn't
 * exist yet is never faked). See "Chrome Extension projeler.txt"'s V1.16
 * section for the full API contract, security model, and commercial
 * release checklist this file is scaffolding for.
 *
 * Storage: one isolated key, `ws_license`, additive/independent of every
 * other key exactly like V1.14's `ws_plan` was. schemaVersion bumped
 * 1 -> 2 for the new fields below, but normalize() defaults every one of
 * them independently of the stored version number (this project's
 * standing convention: tolerate an old/short shape by defaulting missing
 * fields, never branch on schemaVersion) — a V1.15 install's existing
 * 6-field record loads perfectly under V1.16 with the 5 new fields
 * defaulted, and nothing about the trial/licensed state it already had
 * is lost or reset.
 *
 * V1.14's `ws_plan` key remains DELIBERATELY never read here (see the
 * V1.15-era reasoning, unchanged).
 */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'ws_license';
  var SCHEMA_VERSION = 2;
  var TRIAL_TOTAL_RUNS = 10;
  // 'revoked' (V1.16): a license that WAS valid (the user paid) but the
  // server later reports it invalid (refund/chargeback/dispute) — kept
  // structurally distinct from 'trial' so the UI can explain WHY access
  // is blocked, even though the two behave identically for the actual
  // run-credit math (see hasRunsRemaining/consumeRunCredit: only an
  // exact 'licensed' status ever bypasses the counter — 'revoked' falls
  // through to the same trialRunsUsed/trialRunsRemaining accounting
  // 'trial' uses, which is exactly right: trialRunsUsed is NEVER reset
  // by becoming licensed OR by being revoked, so a revoked user who was
  // already well past 10 runs while licensed is correctly blocked again
  // immediately, with no separate "revoked counter" to keep in sync).
  var STATUSES = ['trial', 'licensed', 'revoked'];
  // Idempotency ledger cap (spec: "Prevent double charging if completion
  // callbacks/messages fire more than once for the same run") — a run's
  // id only ever needs to be remembered long enough to catch a duplicate
  // delivery of ITS OWN completion event, never forever; capping keeps
  // this key's storage footprint bounded no matter how long a user has
  // been on the extension.
  var MAX_CHARGED_LEDGER = 200;

  // ---- V1.16 production-flow placeholders — see this file's header
  // comment. Both intentionally null: inventing a fake production URL
  // (spec's explicit instruction) would be worse than no URL at all,
  // since it could look real. Every function below that would need one
  // of these checks for null FIRST and fails closed with an honest
  // "not connected yet" error before attempting any network call. ----
  var CHECKOUT_URL = null; // hosted checkout page (e.g. a Stripe Checkout session URL) once a backend exists
  var LICENSE_API_BASE_URL = null; // backend base URL for create-checkout / verify-license / recover-license
  var PURCHASE_URL = CHECKOUT_URL; // V1.15 name, kept as an alias — nothing in this codebase reads it directly today

  // Informational-only policy constant (V1.16 spec #5: "define how the
  // extension should behave offline after successful activation"). NOT
  // enforced as a hard lock anywhere in this file — see the V1.16
  // roadmap section's explicit "remaining item requiring a decision" on
  // whether a prolonged-offline license should eventually be treated
  // differently. Exists so the UI can show "last verified N days ago"
  // and so that decision has a concrete number to start from.
  var OFFLINE_GRACE_DAYS = 14;

  function emptyLicenseState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      licenseStatus: 'trial',
      trialRunsUsed: 0,
      licenseKey: null,
      licenseVerifiedAt: null,
      chargedRunIds: [],
      // ---- V1.16 additions (all null/default until a real backend exists) ----
      purchaseId: null, // the backend's purchase/order id — lets support look up a purchase without exposing the license key itself
      customerEmail: null, // optional, only ever collected for the recovery flow (spec #7 "license recovery") — never required to use the extension
      verificationSource: 'none', // 'none' | 'dev-simulated' | 'server' — TRANSPARENCY only, never a gating input (gating only ever reads licenseStatus)
      lastServerCheckAt: null, // when verifyLicenseWithServer() last got ANY response (success OR failure) from a real backend
      lastServerCheckResult: null // null | 'ok' | 'revoked' | 'network-error' | 'not-configured'
    };
  }

  /** Normalizes whatever is actually in storage against emptyLicenseState()
   * — the same defensive "missing/corrupt field never crashes, just falls
   * back to a safe default" convention every other *.js module in this
   * project already uses for its own storage key. Deliberately does NOT
   * branch on the stored schemaVersion number — a V1.15 record simply has
   * 5 of these fields absent, which fall back to their defaults exactly
   * like a freshly-installed user's would. */
  function normalize(raw) {
    var base = emptyLicenseState();
    if (!raw || typeof raw !== 'object') return base;
    var verificationSources = ['none', 'dev-simulated', 'server'];
    var checkResults = ['ok', 'revoked', 'network-error', 'not-configured'];
    return {
      schemaVersion: SCHEMA_VERSION,
      licenseStatus: STATUSES.indexOf(raw.licenseStatus) !== -1 ? raw.licenseStatus : base.licenseStatus,
      trialRunsUsed: (typeof raw.trialRunsUsed === 'number' && isFinite(raw.trialRunsUsed) && raw.trialRunsUsed >= 0) ? raw.trialRunsUsed : base.trialRunsUsed,
      licenseKey: typeof raw.licenseKey === 'string' ? raw.licenseKey : base.licenseKey,
      licenseVerifiedAt: (typeof raw.licenseVerifiedAt === 'number' && isFinite(raw.licenseVerifiedAt)) ? raw.licenseVerifiedAt : base.licenseVerifiedAt,
      chargedRunIds: Array.isArray(raw.chargedRunIds) ? raw.chargedRunIds.slice(-MAX_CHARGED_LEDGER) : base.chargedRunIds,
      purchaseId: typeof raw.purchaseId === 'string' ? raw.purchaseId : base.purchaseId,
      customerEmail: typeof raw.customerEmail === 'string' ? raw.customerEmail : base.customerEmail,
      verificationSource: verificationSources.indexOf(raw.verificationSource) !== -1 ? raw.verificationSource : base.verificationSource,
      lastServerCheckAt: (typeof raw.lastServerCheckAt === 'number' && isFinite(raw.lastServerCheckAt)) ? raw.lastServerCheckAt : base.lastServerCheckAt,
      lastServerCheckResult: checkResults.indexOf(raw.lastServerCheckResult) !== -1 ? raw.lastServerCheckResult : base.lastServerCheckResult
    };
  }

  /** Maps the raw state to a single UI dispatch key — the one thing
   * popup.js should switch on when deciding what to render, instead of
   * re-deriving the same "licensed vs revoked vs exhausted" logic in
   * multiple places. Deliberately NOT persisted (always recomputed). */
  function computeUiStatus(state) {
    if (state.licenseStatus === 'licensed') return 'licensed';
    if (state.licenseStatus === 'revoked') return 'revoked';
    return state.trialRunsUsed < TRIAL_TOTAL_RUNS ? 'trial-active' : 'trial-exhausted';
  }

  /** Adds the computed, UI-facing convenience fields on top of the raw
   * persisted shape — trialRunsRemaining/trialTotalRuns/isLicensed/
   * uiStatus/daysSinceLastServerCheck are NEVER separately persisted (a
   * second source of truth for the same fact is exactly how "remaining"
   * and "used" drift apart over time); they are recomputed fresh every
   * time from the raw fields. */
  function withComputed(state) {
    var isLicensed = state.licenseStatus === 'licensed';
    var daysSinceLastServerCheck = state.lastServerCheckAt == null ? null : Math.floor((Date.now() - state.lastServerCheckAt) / (24 * 60 * 60 * 1000));
    return Object.assign({}, state, {
      trialTotalRuns: TRIAL_TOTAL_RUNS,
      trialRunsRemaining: isLicensed ? Infinity : Math.max(0, TRIAL_TOTAL_RUNS - state.trialRunsUsed),
      isLicensed: isLicensed,
      uiStatus: computeUiStatus(state),
      daysSinceLastServerCheck: daysSinceLastServerCheck,
      offlineGraceExceeded: isLicensed && daysSinceLastServerCheck != null && daysSinceLastServerCheck > OFFLINE_GRACE_DAYS
    });
  }

  function rawLoad() {
    return new Promise(function (resolve) {
      chrome.storage.local.get([STORAGE_KEY], function (result) {
        resolve(normalize(result && result[STORAGE_KEY]));
      });
    });
  }

  function loadLicenseState() {
    return rawLoad().then(withComputed);
  }

  function persist(state) {
    var data = {};
    // Only ever writes the raw persisted shape — never the computed
    // convenience fields (see withComputed's own comment on why).
    data[STORAGE_KEY] = {
      schemaVersion: SCHEMA_VERSION,
      licenseStatus: state.licenseStatus,
      trialRunsUsed: state.trialRunsUsed,
      licenseKey: state.licenseKey,
      licenseVerifiedAt: state.licenseVerifiedAt,
      chargedRunIds: state.chargedRunIds,
      purchaseId: state.purchaseId,
      customerEmail: state.customerEmail,
      verificationSource: state.verificationSource,
      lastServerCheckAt: state.lastServerCheckAt,
      lastServerCheckResult: state.lastServerCheckResult
    };
    return new Promise(function (resolve, reject) {
      chrome.storage.local.set(data, function () {
        if (chrome.runtime && chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'Storage write failed.'));
          return;
        }
        resolve(withComputed(normalize(data[STORAGE_KEY])));
      });
    });
  }

  // Same same-context write-serialization pattern background.js's own
  // serializeMonitoringOp already established for V1.8 — guards against
  // two nearly-simultaneous consumeRunCredit() calls (or a charge racing
  // a dev-mode license switch, or a server verification response) within
  // ONE extension context (popup or background) losing an update to a
  // classic read-modify-write race. Does not protect across two separate
  // popup instances open in two different browser windows at once — a
  // known, documented, low-impact edge case, same honesty-about-limits
  // convention this project already applies to MV3 service-worker
  // suspension elsewhere.
  var opQueue = Promise.resolve();
  function serialize(fn) {
    var result = opQueue.then(fn, fn);
    opQueue = result.then(function () {}, function () {});
    return result;
  }

  /** Unchanged from V1.15: an 'isLicensed' account always has runs
   * remaining. A 'revoked' account is NOT isLicensed (see the STATUSES
   * comment above), so it correctly falls through to the same
   * trialRunsRemaining check 'trial' uses — no special-casing needed. */
  function hasRunsRemaining(state) {
    return !!(state && (state.isLicensed || state.trialRunsRemaining > 0));
  }

  /**
   * Unchanged from V1.15 — the ONE place trialRunsUsed is ever
   * incremented. See the V1.15 roadmap section for the full contract;
   * nothing about this function's behavior changed in V1.16. A licensed
   * user's calls always short-circuit before touching the ledger or the
   * counter; a 'revoked' user is NOT licensed, so their calls go through
   * the normal counting path exactly like 'trial' (though in practice
   * they're almost always already at/over the 10-run cap, since
   * trialRunsUsed was frozen — never incremented — for the whole time
   * they were licensed, and the UI gate blocks the run before this is
   * ever reached once 0 remain).
   */
  function consumeRunCredit(runId) {
    return serialize(function () {
      return rawLoad().then(function (state) {
        if (state.licenseStatus === 'licensed') {
          return Object.assign(withComputed(state), { charged: false, reason: 'licensed' });
        }
        if (runId && state.chargedRunIds.indexOf(runId) !== -1) {
          return Object.assign(withComputed(state), { charged: false, reason: 'duplicate' });
        }
        state.trialRunsUsed += 1;
        if (runId) {
          state.chargedRunIds = state.chargedRunIds.concat([runId]).slice(-MAX_CHARGED_LEDGER);
        }
        return persist(state).then(function (saved) {
          return Object.assign(saved, { charged: true, reason: 'charged' });
        });
      });
    });
  }

  /** DEV ONLY (spec: "explicitly labeled DEV-only mechanism... production
   * behavior must never trust a simple local flag as proof of purchase").
   * Callers MUST gate this behind isDevelopmentInstall() themselves —
   * this function does not check it again itself, matching how V1.14's
   * dev plan switcher was structured (the UI that can reach this control
   * is what's gated, not a redundant internal check every call would
   * need to repeat). licenseKey is set to an obviously-fake, clearly-
   * labeled sentinel value — never a plausible-looking real license
   * token — so storage contents alone make it unmistakable this was
   * simulated, not purchased. verificationSource:'dev-simulated' makes
   * this doubly explicit for any future UI/support tooling that inspects
   * it (V1.16: purely informational, never a gating input by itself). */
  function activateDevLicense() {
    return serialize(function () {
      return rawLoad().then(function (state) {
        state.licenseStatus = 'licensed';
        state.licenseKey = 'DEV-SIMULATED-LICENSE';
        state.licenseVerifiedAt = Date.now();
        state.verificationSource = 'dev-simulated';
        return persist(state);
      });
    });
  }

  /** DEV ONLY companion to activateDevLicense() — resets back to a fresh
   * trial (including clearing the charged-run ledger and every V1.16
   * purchase/verification field) so a developer can repeatedly exercise
   * the full 10-run -> purchase -> activation flow without reinstalling. */
  function resetToTrialDev() {
    return serialize(function () {
      return persist(emptyLicenseState());
    });
  }

  /** DEV ONLY — the counterpart to activateDevLicense(), for exercising
   * the 'revoked' UI states (spec #7: "refunded/revoked license") without
   * a real backend. Deliberately does NOT reset trialRunsUsed/
   * chargedRunIds — a real revocation would never un-happen a user's
   * accumulated run history either. */
  function simulateRevokedDev() {
    return serialize(function () {
      return rawLoad().then(function (state) {
        state.licenseStatus = 'revoked';
        state.lastServerCheckAt = Date.now();
        state.lastServerCheckResult = 'revoked';
        return persist(state);
      });
    });
  }

  /** DEV ONLY (V1 FINAL PART C spec #27-32) — sets trialRunsUsed to an
   * EXACT value for manual QA of the real 10-free-runs -> paywall flow
   * without having to actually perform N real scrapes to reach a
   * specific count. Same gating contract as activateDevLicense/
   * resetToTrialDev/simulateRevokedDev above: callers MUST check
   * isDevelopmentInstall() themselves before this is ever reachable —
   * this function does not re-check it, and is not wired to any control
   * a production/Chrome-Web-Store build's UI exposes (see popup.html's
   * #settings-dev-switcher, which this shares its hidden-unless-dev
   * container with, and scripts/release-check.js's QA-bypass check).
   * Always forces licenseStatus back to 'trial' (a QA run-count doesn't
   * make sense to view while simulating 'licensed'/'revoked' — those are
   * exercised via the existing dev switcher instead) and clears the
   * charged-run ledger (chargedRunIds) so it can never suppress a
   * dev-set count from actually gating the next Preview/Start/Deep
   * Scrape click — a stale ledger entry is otherwise irrelevant here
   * since QA runIds are never reused, but clearing it keeps this
   * function's result fully deterministic and independent of whatever
   * ledger state happened to exist before. `n` is clamped into
   * [0, TRIAL_TOTAL_RUNS] — this mirrors normalize()'s own defensive
   * clamping (spec #3's "completedRuns>10 must normalize safely") rather
   * than trusting the caller's UI to only ever offer valid values. */
  function setTrialRunsUsedDev(n) {
    var clamped = Math.max(0, Math.min(TRIAL_TOTAL_RUNS, Math.floor(Number(n) || 0)));
    return serialize(function () {
      return rawLoad().then(function (state) {
        state.licenseStatus = 'trial';
        state.trialRunsUsed = clamped;
        state.chargedRunIds = [];
        state.licenseKey = null;
        state.licenseVerifiedAt = null;
        state.verificationSource = null;
        state.lastServerCheckAt = null;
        state.lastServerCheckResult = null;
        return persist(state);
      });
    });
  }

  /**
   * THE integration point for a real payment/license system (see this
   * file's header comment). V1.15 shipped this as a stub that can NEVER
   * grant access — there is no server to verify anything against yet,
   * and faking success here would be exactly the "fake payment
   * verification" both V1.15 and V1.16 explicitly forbid. Unchanged in
   * V1.16 except for a `reason` code on the failure so callers can start
   * branching on WHY (not-configured today; invalid/network-error/
   * expired once a real backend exists) without another shape change
   * later. A future version replaces this function's body with a real
   * activation-token verification call; every caller already only checks
   * `.ok`, so nothing else needs to change.
   */
  function activateLicense(licenseKey) {
    void licenseKey; // reserved for the future real verification call
    if (!LICENSE_API_BASE_URL) {
      return Promise.resolve({
        ok: false,
        reason: 'not-configured',
        error: 'Online purchase and license verification are not connected yet in this build.'
      });
    }
    // Unreachable today (LICENSE_API_BASE_URL is always null) — this is
    // where a real POST LICENSE_API_BASE_URL + '/activate-license' call
    // goes once a backend exists. See the V1.16 API contract for the
    // exact request/response shape.
    return Promise.resolve({ ok: false, reason: 'not-configured', error: 'License activation is not connected yet in this build.' });
  }

  /**
   * V1.16 — kicks off the hosted-checkout half of the flow (spec #2/#3:
   * "create checkout"). Stubbed identically to activateLicense(): fails
   * closed with an honest reason, never opens a fake checkout page, never
   * invents a URL. Once a backend exists, this POSTs
   * LICENSE_API_BASE_URL + '/create-checkout' (optionally with
   * `email`) and resolves {ok:true, checkoutUrl} for the caller to open
   * in a new tab.
   */
  function createCheckoutSession(email) {
    void email;
    if (!CHECKOUT_URL && !LICENSE_API_BASE_URL) {
      return Promise.resolve({
        ok: false,
        reason: 'not-configured',
        error: 'Checkout is not connected yet in this build.'
      });
    }
    return Promise.resolve({ ok: false, reason: 'not-configured', error: 'Checkout is not connected yet in this build.' });
  }

  /**
   * V1.16 — spec #7 "license recovery": lets a user who already paid but
   * lost their activation (new browser profile, cleared storage, etc.)
   * re-associate this install with their existing purchase, normally by
   * email. Stubbed the same way as every other server-calling function
   * here. Once a backend exists, POSTs LICENSE_API_BASE_URL +
   * '/recover-license' with `email` and, on a match, resolves
   * {ok:true, licenseKey, purchaseId} for the caller to feed into
   * activateLicense(); on no match, {ok:false, reason:'not-found'}.
   */
  function recoverLicense(email) {
    void email;
    if (!LICENSE_API_BASE_URL) {
      return Promise.resolve({
        ok: false,
        reason: 'not-configured',
        error: 'License recovery is not connected yet in this build.'
      });
    }
    return Promise.resolve({ ok: false, reason: 'not-configured', error: 'License recovery is not connected yet in this build.' });
  }

  /**
   * V1.16 — spec #5/#6: periodic re-verification while online, with a
   * FAIL-OPEN policy: any failure to reach the server (not configured,
   * network error, timeout) leaves the locally-stored licenseStatus
   * completely UNCHANGED — only an explicit `{revoked:true}` response
   * from the server is ever allowed to move a 'licensed' account to
   * 'revoked'. This is deliberate and important: a user with a
   * legitimate license who is offline, or hits a flaky network, or is
   * using this build before a backend exists at all, must never lose
   * access because a verification call merely failed to complete.
   *
   * `opts.__fetchImpl` / `opts.__baseUrlOverride` exist ONLY for tests —
   * no real caller in this codebase ever passes them — letting the state
   * machine below (the part that actually matters and will survive once
   * a real backend is wired in) be exercised deterministically today
   * without needing a real server or real network access.
   */
  function verifyLicenseWithServer(opts) {
    opts = opts || {};
    var baseUrl = opts.__baseUrlOverride !== undefined ? opts.__baseUrlOverride : LICENSE_API_BASE_URL;
    var fetchImpl = opts.__fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);

    return serialize(function () {
      return rawLoad().then(function (state) {
        if (!baseUrl) {
          state.lastServerCheckAt = Date.now();
          state.lastServerCheckResult = 'not-configured';
          return persist(state).then(function (saved) {
            return Object.assign(saved, { ok: false, reason: 'not-configured' });
          });
        }
        if (!fetchImpl) {
          state.lastServerCheckAt = Date.now();
          state.lastServerCheckResult = 'network-error';
          return persist(state).then(function (saved) {
            return Object.assign(saved, { ok: false, reason: 'network-error' });
          });
        }
        return fetchImpl(baseUrl + '/verify-license', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ licenseKey: state.licenseKey })
        }).then(function (res) {
          return res.json().then(function (body) {
            state.lastServerCheckAt = Date.now();
            if (body && body.revoked === true) {
              state.licenseStatus = 'revoked';
              state.lastServerCheckResult = 'revoked';
            } else if (body && body.valid === true) {
              state.lastServerCheckResult = 'ok';
            } else {
              // An explicit "not valid" response that isn't a revocation
              // (e.g. a malformed/unknown key) — treated as informational
              // only for now; never auto-downgrades licenseStatus by
              // itself (only an explicit revoked:true does). Real policy
              // for this case is a V1.16 open decision — see the roadmap.
              state.lastServerCheckResult = 'ok';
            }
            return persist(state).then(function (saved) {
              return Object.assign(saved, { ok: true, reason: state.lastServerCheckResult });
            });
          });
        }).catch(function () {
          // Network failure, timeout, non-JSON response, etc. — fail
          // open: licenseStatus is untouched, only the check-freshness
          // fields move, so the UI can show "offline, last verified…"
          // without ever silently revoking access.
          state.lastServerCheckAt = Date.now();
          state.lastServerCheckResult = 'network-error';
          return persist(state).then(function (saved) {
            return Object.assign(saved, { ok: false, reason: 'network-error' });
          });
        });
      });
    });
  }

  /** Identical implementation to V1.14's utils/plan.js / V1.15's
   * license.js — unchanged. chrome.management.getSelf() is
   * permission-free per Chrome's extension platform (no manifest change
   * needed); reports installType 'development' ONLY for an unpacked/
   * sideloaded extension, never for a real Chrome Web Store install, and
   * fails closed (false) on any error so an environment where this check
   * can't run is always treated as production. */
  function isDevelopmentInstall() {
    return new Promise(function (resolve) {
      try {
        if (!chrome.management || !chrome.management.getSelf) { resolve(false); return; }
        chrome.management.getSelf(function (info) {
          if (chrome.runtime && chrome.runtime.lastError) { resolve(false); return; }
          resolve(!!(info && info.installType === 'development'));
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  root.WSLicense = {
    STORAGE_KEY: STORAGE_KEY,
    TRIAL_TOTAL_RUNS: TRIAL_TOTAL_RUNS,
    OFFLINE_GRACE_DAYS: OFFLINE_GRACE_DAYS,
    PURCHASE_URL: PURCHASE_URL,
    CHECKOUT_URL: CHECKOUT_URL,
    LICENSE_API_BASE_URL: LICENSE_API_BASE_URL,
    emptyLicenseState: emptyLicenseState,
    loadLicenseState: loadLicenseState,
    hasRunsRemaining: hasRunsRemaining,
    consumeRunCredit: consumeRunCredit,
    activateDevLicense: activateDevLicense,
    resetToTrialDev: resetToTrialDev,
    simulateRevokedDev: simulateRevokedDev,
    setTrialRunsUsedDev: setTrialRunsUsedDev,
    activateLicense: activateLicense,
    createCheckoutSession: createCheckoutSession,
    recoverLicense: recoverLicense,
    verifyLicenseWithServer: verifyLicenseWithServer,
    isDevelopmentInstall: isDevelopmentInstall
  };
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
