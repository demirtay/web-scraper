/**
 * discovery.js
 * AUTOMATIC DATA DISCOVERY ENGINE — pure, DOM-free core. No chrome.* APIs,
 * no DOM — loaded identically in the popup and in content scripts, exactly
 * like utils/runstate.js (which this file complements, never replaces).
 *
 * DISCOVERY vs PROCESSING (mission's own central architectural rule):
 * these stay two distinct concepts everywhere in this codebase.
 *   - DISCOVERY is content/discovery.js's job: automatically traverse a
 *     site (reusing the existing, unmodified Auto Scroll/Auto Next/new
 *     Load More engines) and accumulate every genuinely-unique record
 *     directly into session.rows, via the SAME WSRunState.mergeNewRows
 *     dedup/ordering mechanism every collection path in this project
 *     already uses. session.rows, in the order mergeNewRows appended to
 *     it, IS the discovery registry — stable discovery order comes for
 *     free from mergeNewRows' own "always concat, never reorder"
 *     contract (utils/runstate.js), so this file does not duplicate a
 *     second parallel registry (mission section 9: "avoid doing the same
 *     expensive work twice").
 *   - PROCESSING is choosing ALL or the FIRST N of that already-
 *     extracted registry and hand it to the completely unmodified
 *     existing pipeline (popup.js's rawRows -> computeTransformedResult
 *     -> Data Cleaning -> preview/export). This file exposes the pure
 *     selection/validation logic; popup.js wires it to the real
 *     activeLiveSession (see popup.js's processAll()/processFirst()).
 *
 * This file also holds the pure bookkeeping helpers content/discovery.js
 * needs for its own counters/loop-protection (mission sections 15-22):
 * duplicate-encounter accounting, page-advance bookkeeping, and
 * visited-traversal-state loop detection — all plain functions over
 * plain serializable objects, unit-testable with zero chrome/DOM mocks,
 * same spirit as utils/runstate.js's own stop-condition evaluators.
 */
(function (root) {
  'use strict';

  // Mission section 25 — clean internal status model for the future UI.
  var STATUSES = [
    'idle', 'discovering', 'discovery_paused', 'discovery_stopped',
    'discovery_complete', 'processing', 'processing_stopped',
    'processing_complete', 'error'
  ];

  // Mission section 22: "Internal runaway protection is allowed... Do not
  // arbitrarily cap discovery at 500/1000/5000... make it high, documented,
  // configurable internally, and report if reached." These are safety nets
  // only, never product limits — a real, well-behaved site traversing this
  // many pages/cycles is not expected to exist; if one genuinely does,
  // safetyLimitReached is set honestly rather than silently reporting a
  // fabricated "complete".
  var DEFAULT_MAX_PAGES = 2000;
  var DEFAULT_MAX_VISITED_STATES = 4000; // loop-protection history cap (bounded memory, mission section 32/33)
  var DEFAULT_MAX_TOTAL_CYCLES = 20000; // scroll+load-more cycles combined, across the whole discovery run

  function now() { return Date.now(); }

  /** Fresh discovery sub-object, seeded once per live session by
   * content/discovery.js's START_DISCOVERY handler / popup.js's
   * handleStartLiveSession. Every field here is additive to the existing
   * live-session shape (utils/runstate.js's own session.rows/seenKeys are
   * reused as-is, untouched by this object). */
  function createDiscoveryState(opts) {
    opts = opts || {};
    return {
      enabled: true,
      status: 'discovering',
      discoveredUnique: 0,
      duplicateEncounters: 0,
      // Rows whose CONTAINER matched the repeating-card selector but were
      // rejected by the existing ad/promo/nav/malformed-row classifier
      // (WSAutoDetect.classifyExtractedRows, unmodified — reused exactly
      // as every other collection path already does) before ever
      // reaching the dedupe step. Precisely tracked only during content/
      // discovery.js's own explicit per-page scrape (see
      // recordScrapePassOutcome below) — a documented, honest scope
      // limit: rows the reused Auto Scroll/Load More engines' own opaque
      // internal cycles individually exclude are still correctly kept
      // OUT of discoveredUnique, just not separately counted here.
      invalidSkipped: 0,
      // TRAVERSAL FIX mission (section 3): additional, purely additive
      // diagnostic counters — internal/development-only (mission section
      // 7: "detailed diagnostics can remain internal"), never renaming or
      // replacing the fields above that popup UI/tests already depend on.
      // rawRecordsSeen is the cumulative raw-DOM-match count across every
      // scrape pass (see recordScrapePassOutcome) — always >= discoveredUnique
      // + invalidSkipped + duplicateEncounters, a useful sanity total.
      // noGrowthCycles counts consecutive expansion phases (scrape/scroll/
      // load-more) that added zero new unique rows, reset the moment one
      // does — a direct signal for "how close to exhaustion are we,"
      // exposed for diagnostics only; it does NOT drive any new stop
      // condition on its own (the existing per-engine retry budgets and
      // next/loop/safety-limit checks already own that decision — mission
      // section 3's own "do not stop merely because one attempt produced
      // no result").  paginationCycles counts genuine Next-control
      // advances specifically (distinct from pagesVisited, which also
      // counts the starting page) — incremented in onPageAdvance below.
      rawRecordsSeen: 0,
      noGrowthCycles: 0,
      paginationCycles: 0,
      pagesVisited: 1,
      scrollCycles: 0,
      loadMoreActions: 0,
      currentTraversalMethod: null, // 'scroll' | 'load-more' | 'pagination' | null
      discoveryComplete: false,
      stopReason: null,
      safetyLimitReached: false,
      siteAdvertisedTotal: opts.siteAdvertisedTotal != null ? opts.siteAdvertisedTotal : null, // informational only — NEVER authoritative (mission section 35/36)
      visitedUrls: opts.startUrl ? [opts.startUrl] : [],
      pageSignatures: [],
      visitedStates: [], // loop protection (mission section 21): url+fingerprint+count triples
      currentPageBaselineCandidateCount: 0, // resets on every page advance — see recordExpansionDelta
      maxPages: opts.maxPages || DEFAULT_MAX_PAGES,
      maxVisitedStates: opts.maxVisitedStates || DEFAULT_MAX_VISITED_STATES,
      maxTotalCycles: opts.maxTotalCycles || DEFAULT_MAX_TOTAL_CYCLES,
      totalCycles: 0,
      processingSelection: null, // set once processAll()/processFirst(n) runs — {mode, requested, effective, processedCount}
      startedAt: now(),
      updatedAt: now()
    };
  }

  /**
   * Mission section 16: "Discovery needs to prevent traversal count
   * inflation... Preserve enough metadata so final processing can still
   * report duplicate-related statistics correctly." Computes how many of
   * this expansion step's candidate cards were genuine re-encounters
   * (not simply "still present from before"), from a single before/after
   * measurement around one expansion phase (one full scroll-to-exhaustion
   * run, one full load-more-to-exhaustion run, or one fresh page load) —
   * deliberately NOT per-cycle, since the arithmetic telescopes: the sum
   * of every cycle's own delta equals this one before/after delta, so no
   * per-cycle hook into the reused Auto Scroll/Load More engines is
   * needed (mission section 9's own "do not blur Discovery/Processing
   * merely to optimize" is satisfied by NOT touching those engines'
   * internals at all here).
   *
   * `baselineCandidateCount` is the candidate-card count measured
   * immediately BEFORE this expansion phase ran; it must be reset to 0 by
   * the caller on every genuine page advance (onPageAdvance below) — a
   * fresh page's cards are never "still present from the old page",
   * however many of them turn out to duplicate an EARLIER page's records
   * (mission's own pagination-overlap test: that overlap IS a genuine
   * duplicate encounter, correctly counted here because the baseline was
   * reset to 0 for the new page).
   *
   * Known, documented limitation (honest, not silently wrong): a
   * virtualized list whose DOM candidate count does not simply grow
   * (older cards evicted as new ones append, e.g. a sliding window) can
   * under-count duplicateEncounters for that one expansion phase, because
   * this formula only sees the net candidate-count delta, not the true
   * churn. It never affects `discoveredUnique` (still exactly
   * session.rows.length, always correct) — only this secondary,
   * informational statistic.
   */
  function recordExpansionDelta(discovery, beforeCandidateCount, afterCandidateCount, beforeUnique, afterUnique) {
    var candidateDelta = Math.max(0, (afterCandidateCount || 0) - (beforeCandidateCount || 0));
    var uniqueDelta = Math.max(0, (afterUnique || 0) - (beforeUnique || 0));
    var duplicatesThisPhase = Math.max(0, candidateDelta - uniqueDelta);
    discovery.duplicateEncounters += duplicatesThisPhase;
    discovery.discoveredUnique = afterUnique;
    discovery.currentPageBaselineCandidateCount = afterCandidateCount || 0;
    discovery.noGrowthCycles = uniqueDelta > 0 ? 0 : (discovery.noGrowthCycles || 0) + 1;
    discovery.updatedAt = now();
    return discovery;
  }

  /**
   * Precise sibling of recordExpansionDelta above, used ONLY where the
   * real classification outcome is directly available — i.e., content/
   * discovery.js's own explicit per-page scrape, which sees the genuine
   * raw-DOM-match count, the post-classification accepted count, AND the
   * post-dedupe genuinely-new count as three separate real numbers, not
   * an inferred delta. Correctly splits mission section 9's two distinct
   * counters instead of conflating them the way the coarser
   * candidate-count delta necessarily does: a row that never passed
   * classification (an ad/promo/malformed match) is genuinely different
   * from a row that passed classification but turned out to duplicate an
   * already-discovered record.
   */
  function recordScrapePassOutcome(discovery, rawCount, acceptedCount, newUniqueCount, afterUnique, afterCandidateCount) {
    var excluded = Math.max(0, (rawCount || 0) - (acceptedCount || 0));
    var duplicates = Math.max(0, (acceptedCount || 0) - (newUniqueCount || 0));
    discovery.invalidSkipped += excluded;
    discovery.duplicateEncounters += duplicates;
    discovery.rawRecordsSeen = (discovery.rawRecordsSeen || 0) + (rawCount || 0);
    discovery.noGrowthCycles = (newUniqueCount || 0) > 0 ? 0 : (discovery.noGrowthCycles || 0) + 1;
    discovery.discoveredUnique = afterUnique;
    discovery.currentPageBaselineCandidateCount = afterCandidateCount || 0;
    discovery.updatedAt = now();
    return discovery;
  }

  /** Called exactly when a genuine new page is loaded (a real Next
   * navigation or SPA-style content swap) — resets the per-page baseline
   * so the NEXT expansion-delta measurement treats every card on the new
   * page as "new to this page" (mission's pagination-overlap test:
   * records repeated from an earlier page are still correctly counted as
   * duplicate ENCOUNTERS, never silently dropped from that count, while
   * never being double-counted as unique). */
  function onPageAdvance(discovery) {
    discovery.currentPageBaselineCandidateCount = 0;
    // NOTE: pagesVisited is deliberately NOT incremented here — see
    // content/discovery.js's own detailed comment (found via real-browser
    // testing) for why that counter is incremented earlier, at the
    // moment a new page is confirmed SCRAPED, not here at
    // navigation-confirmation time (a real full-page navigation can
    // destroy the script instance before a write made HERE would ever
    // land).
    discovery.currentTraversalMethod = 'pagination';
    // paginationCycles (mission section 3 diagnostics): both call sites
    // in content/discovery.js's STEP 4 ('url-changed' AND 'dom-changed')
    // only ever reach onPageAdvance() after a legitimate Next control was
    // actually found and clicked — a genuine pagination advance either
    // way, full navigation or SPA-style swap — so counting it here once,
    // in the one shared function both branches call, is correct for both
    // without duplicating the increment at each call site.
    discovery.paginationCycles = (discovery.paginationCycles || 0) + 1;
    discovery.updatedAt = now();
    return discovery;
  }

  /** Loop protection (mission section 21): a stable identity for "have we
   * genuinely been in this exact traversal state before" — URL + content
   * fingerprint + current unique count, so a true content loop (Next
   * pointing back at an already-seen page, alternating A/B URLs, a sticky
   * button producing no real change) is detected even if only one of the
   * three signals alone would have looked ambiguous. Bounded history
   * (maxVisitedStates) keeps memory flat regardless of how long discovery
   * runs (mission section 32/33 — performance at 10,000+ records). */
  function buildTraversalStateId(url, contentSignature, uniqueCount) {
    return (url || '') + '::' + (contentSignature || '') + '::' + uniqueCount;
  }

  function registerVisitedState(discovery, stateId) {
    var looped = discovery.visitedStates.indexOf(stateId) !== -1;
    if (!looped) {
      discovery.visitedStates.push(stateId);
      if (discovery.visitedStates.length > discovery.maxVisitedStates) {
        discovery.visitedStates.shift();
      }
    }
    return looped;
  }

  /**
   * Mission section 27: processFirst(n) validation. Never fails
   * catastrophically on bad input (0, negative, non-integer, a string, or
   * a request larger than what was actually discovered) — normalizes
   * safely or returns a clear, structured validation result, per the
   * mission's own explicit "Do NOT fail catastrophically... Normalize
   * safely to available count or return a clear validation result."
   * @param {number} discoveredUnique authoritative count — session.rows.length, never a site-advertised total
   * @param {'all'|'first'} mode
   * @param {*} n only meaningful for mode:'first'
   */
  function validateSelection(discoveredUnique, mode, n) {
    discoveredUnique = Number(discoveredUnique) || 0;
    if (mode === 'all') {
      return { ok: true, mode: 'all', requested: discoveredUnique, effective: discoveredUnique, normalized: false };
    }
    if (mode !== 'first') {
      return { ok: false, error: 'invalid-mode', mode: mode };
    }
    if (discoveredUnique <= 0) {
      return { ok: false, error: 'nothing-discovered-yet' };
    }
    var isPlainInteger = typeof n === 'number' && isFinite(n) && Math.floor(n) === n;
    if (!isPlainInteger) {
      // Reject non-integers ("2.5"), non-numeric ("abc"), NaN/Infinity —
      // never silently coerce/round, since that could quietly select a
      // different N than what was actually requested.
      return { ok: false, error: 'not-an-integer', requested: n };
    }
    if (n < 1) {
      return { ok: false, error: 'must-be-at-least-one', requested: n };
    }
    var effective = Math.min(n, discoveredUnique);
    return { ok: true, mode: 'first', requested: n, effective: effective, normalized: effective !== n };
  }

  /** Pure slice — the actual "processing selection" step (mission section
   * 27/28). Never mutates `rows`; never fabricates entries past what was
   * actually discovered (mission section 36) — `selectRows` is only ever
   * called with an already-validated, already-clamped `n`. */
  function selectRows(rows, mode, n) {
    rows = rows || [];
    if (mode === 'all') return rows.slice();
    var count = Math.max(0, Math.min(Number(n) || 0, rows.length));
    return rows.slice(0, count);
  }

  root.WSDiscoveryCore = {
    STATUSES: STATUSES,
    DEFAULT_MAX_PAGES: DEFAULT_MAX_PAGES,
    DEFAULT_MAX_VISITED_STATES: DEFAULT_MAX_VISITED_STATES,
    DEFAULT_MAX_TOTAL_CYCLES: DEFAULT_MAX_TOTAL_CYCLES,
    createDiscoveryState: createDiscoveryState,
    recordExpansionDelta: recordExpansionDelta,
    recordScrapePassOutcome: recordScrapePassOutcome,
    onPageAdvance: onPageAdvance,
    buildTraversalStateId: buildTraversalStateId,
    registerVisitedState: registerVisitedState,
    validateSelection: validateSelection,
    selectRows: selectRows
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
