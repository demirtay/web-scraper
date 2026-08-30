/**
 * discovery-core.test.js (FAST level)
 * Pure-logic coverage for utils/discovery.js — the Automatic Data
 * Discovery Engine's DOM-free core (discovery state shape, duplicate/
 * invalid-row accounting, page-advance bookkeeping, loop-protection
 * traversal-state tracking, and processAll()/processFirst(n) selection
 * validation). Loaded and executed for real, unmodified.
 * Standalone-runnable: `node tests/unit/discovery-core.test.js`.
 */
'use strict';
const { loadModules } = require('../lib/load-modules');
const { makeSuite } = require('../lib/assert');

function run() {
  const suite = makeSuite('discovery-core');
  const assert = suite.assert;

  const sandbox = loadModules(['utils/discovery.js']);
  const D = sandbox.WSDiscoveryCore;

  // ---- createDiscoveryState ----
  var state = D.createDiscoveryState({ startUrl: 'https://www.etsy.com/search?q=x' });
  assert(state.status === 'discovering', 'createDiscoveryState starts in discovering status');
  assert(state.discoveredUnique === 0, 'createDiscoveryState starts with zero discovered');
  assert(state.pagesVisited === 1, 'createDiscoveryState counts the starting page as page 1');
  assert(state.visitedUrls.length === 1 && state.visitedUrls[0] === 'https://www.etsy.com/search?q=x', 'createDiscoveryState seeds visitedUrls with the starting URL');
  assert(state.maxPages === D.DEFAULT_MAX_PAGES, 'createDiscoveryState defaults maxPages to the documented safety-net constant');
  assert(state.safetyLimitReached === false, 'createDiscoveryState starts with safetyLimitReached false');
  var customState = D.createDiscoveryState({ maxPages: 5, siteAdvertisedTotal: 200 });
  assert(customState.maxPages === 5, 'createDiscoveryState honors a custom maxPages override');
  assert(customState.siteAdvertisedTotal === 200, 'createDiscoveryState records an informational site-advertised total');

  // ---- recordScrapePassOutcome (precise per-page accounting) ----
  var s1 = D.createDiscoveryState({});
  D.recordScrapePassOutcome(s1, /*raw*/ 20, /*accepted*/ 18, /*newUnique*/ 15, /*afterUnique*/ 15, /*afterCandidateCount*/ 18);
  assert(s1.invalidSkipped === 2, 'recordScrapePassOutcome: 20 raw - 18 accepted = 2 invalidSkipped (ad/promo/malformed)');
  assert(s1.duplicateEncounters === 3, 'recordScrapePassOutcome: 18 accepted - 15 new-unique = 3 duplicateEncounters');
  assert(s1.discoveredUnique === 15, 'recordScrapePassOutcome sets discoveredUnique to the authoritative afterUnique value');
  assert(s1.rawRecordsSeen === 20, 'recordScrapePassOutcome accumulates rawRecordsSeen');
  assert(s1.noGrowthCycles === 0, 'recordScrapePassOutcome resets noGrowthCycles when new unique rows were found');
  D.recordScrapePassOutcome(s1, 5, 5, 0, 15, 23); // a pass that adds nothing new
  assert(s1.noGrowthCycles === 1, 'recordScrapePassOutcome increments noGrowthCycles on a zero-new-unique pass');
  assert(s1.duplicateEncounters === 8, 'recordScrapePassOutcome keeps accumulating duplicateEncounters across passes (3 + 5)');
  D.recordScrapePassOutcome(s1, 3, 3, 2, 17, 26);
  assert(s1.noGrowthCycles === 0, 'recordScrapePassOutcome resets noGrowthCycles again once growth resumes');

  // ---- recordExpansionDelta (coarser, delta-only accounting for the reused engines) ----
  var s2 = D.createDiscoveryState({});
  D.recordExpansionDelta(s2, /*beforeCandidate*/ 0, /*afterCandidate*/ 30, /*beforeUnique*/ 0, /*afterUnique*/ 25);
  assert(s2.duplicateEncounters === 5, 'recordExpansionDelta: 30 candidate delta - 25 unique delta = 5 duplicates this phase');
  assert(s2.discoveredUnique === 25, 'recordExpansionDelta sets discoveredUnique to the authoritative afterUnique value');
  assert(s2.currentPageBaselineCandidateCount === 30, 'recordExpansionDelta records the new candidate baseline');
  D.recordExpansionDelta(s2, 30, 30, 25, 25); // an exhausted scroll cycle: no growth at all
  assert(s2.noGrowthCycles === 1, 'recordExpansionDelta increments noGrowthCycles when nothing new was found');
  assert(s2.duplicateEncounters === 5, 'recordExpansionDelta never double-counts duplicates on a zero-delta cycle');

  // ---- onPageAdvance ----
  var s3 = D.createDiscoveryState({});
  s3.currentPageBaselineCandidateCount = 40;
  D.onPageAdvance(s3);
  assert(s3.currentPageBaselineCandidateCount === 0, 'onPageAdvance resets the per-page candidate baseline so the new page starts fresh');
  assert(s3.currentTraversalMethod === 'pagination', 'onPageAdvance marks the traversal method as pagination');
  assert(s3.paginationCycles === 1, 'onPageAdvance increments paginationCycles');
  assert(s3.pagesVisited === 1, 'onPageAdvance deliberately does NOT increment pagesVisited itself (owned by the real scrape-confirmation call site)');
  D.onPageAdvance(s3);
  assert(s3.paginationCycles === 2, 'onPageAdvance increments paginationCycles again on a second advance');

  // ---- buildTraversalStateId / registerVisitedState (loop protection) ----
  var s4 = D.createDiscoveryState({});
  var id1 = D.buildTraversalStateId('https://x.test/p2', 'sig-abc', 40);
  assert(D.registerVisitedState(s4, id1) === false, 'registerVisitedState: a genuinely new state is not a loop');
  assert(s4.visitedStates.length === 1, 'registerVisitedState records the new state');
  assert(D.registerVisitedState(s4, id1) === true, 'registerVisitedState: seeing the EXACT same url+signature+count again IS a real loop');
  var id2 = D.buildTraversalStateId('https://x.test/p2', 'sig-abc', 41); // same url+sig but unique count moved on — genuinely new
  assert(D.registerVisitedState(s4, id2) === false, 'registerVisitedState: same url+signature but a different unique count is NOT treated as a loop');

  var s5 = D.createDiscoveryState({ maxVisitedStates: 3 });
  D.registerVisitedState(s5, 'a'); D.registerVisitedState(s5, 'b'); D.registerVisitedState(s5, 'c'); D.registerVisitedState(s5, 'd');
  assert(s5.visitedStates.length === 3, 'registerVisitedState keeps bounded history (maxVisitedStates), evicting the oldest');
  assert(s5.visitedStates.indexOf('a') === -1, 'registerVisitedState evicts the OLDEST entry first (FIFO), not an arbitrary one');
  assert(s5.visitedStates.indexOf('d') !== -1, 'registerVisitedState keeps the most recent entry');

  // ---- validateSelection (processAll/processFirst(n) validation) ----
  assert(D.validateSelection(500, 'all').effective === 500, 'validateSelection: all mode selects everything discovered');
  var sel100 = D.validateSelection(1283, 'first', 100);
  assert(sel100.ok === true && sel100.effective === 100 && sel100.normalized === false, 'validateSelection: first 100 of 1283 is a clean, non-normalized selection');
  var selOver = D.validateSelection(50, 'first', 5000);
  assert(selOver.ok === true && selOver.effective === 50 && selOver.normalized === true, 'validateSelection: an over-large first-N request clamps to what was actually discovered and reports normalized');
  assert(D.validateSelection(0, 'first', 10).error === 'nothing-discovered-yet', 'validateSelection rejects a first-N request when nothing has been discovered yet');
  assert(D.validateSelection(100, 'first', 2.5).error === 'not-an-integer', 'validateSelection rejects a non-integer N rather than silently rounding');
  assert(D.validateSelection(100, 'first', 'abc').error === 'not-an-integer', 'validateSelection rejects a non-numeric N');
  assert(D.validateSelection(100, 'first', NaN).error === 'not-an-integer', 'validateSelection rejects NaN');
  assert(D.validateSelection(100, 'first', 0).error === 'must-be-at-least-one', 'validateSelection rejects N=0');
  assert(D.validateSelection(100, 'first', -5).error === 'must-be-at-least-one', 'validateSelection rejects a negative N');
  assert(D.validateSelection(100, 'bogus-mode', 10).error === 'invalid-mode', 'validateSelection rejects an unrecognized mode');

  // ---- selectRows (the actual, already-validated slice) ----
  var rows = []; for (var i = 0; i < 300; i++) rows.push({ i: i });
  assert(D.selectRows(rows, 'all').length === 300, 'selectRows all returns every row');
  assert(D.selectRows(rows, 'all') !== rows, 'selectRows never returns the original array reference (never mutated by caller)');
  assert(D.selectRows(rows, 'first', 100).length === 100, 'selectRows first 100 slices to exactly 100');
  assert(D.selectRows(rows, 'first', 100)[0].i === 0, 'selectRows first-N preserves discovery order (starts at the first-discovered row)');
  assert(D.selectRows(rows, 'first', 5000).length === 300, 'selectRows never fabricates rows past what was actually discovered, even if asked for more');
  assert(D.selectRows([], 'first', 10).length === 0, 'selectRows on an empty discovery set returns an empty selection, never throws');

  return suite.summarize();
}

if (require.main === module) {
  var result = run();
  process.exit(result.failures ? 1 : 0);
}

module.exports = { run: run };
