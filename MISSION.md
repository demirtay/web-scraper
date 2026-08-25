# Current Mission

**Status: COMPLETE**

Implement, harden, and real-browser-verify INFINITE SCROLL (Auto
Scroll) for ClickScrape — additive to the existing, real-browser-
verified Automatic Pagination (Auto Next) feature, not a replacement or
redesign. Default OFF; when OFF, existing behavior (including Auto
Next) must remain byte-for-byte unchanged.

# Acceptance Criteria — Definition of Done

- [x] Existing architecture inspected
- [x] Auto Scroll UI added cleanly (near Auto Next, OFF by default)
- [x] Auto Scroll OFF preserves old behavior
- [x] Real page scroll happens automatically
- [x] Additional items load
- [x] New rows append to existing session
- [x] Prior rows remain
- [x] Duplicates controlled
- [x] Virtualized lists do not erase collected data
- [x] No-new-data/end-of-results stops cleanly
- [x] Loop safety works (max cycles, consecutive-no-new-data threshold)
- [x] Stop works
- [x] Finish works
- [x] Auto Next still works (regression-checked)
- [x] Auto Next + Auto Scroll coexist safely (scroll-to-exhaustion on
      each page, then Next)
- [x] Focused tests pass (14 scenarios from the task spec)
- [x] Full regression suite has no new related failures
- [x] release-check passes
- [x] REAL Chrome test executed
- [x] REAL public infinite-scroll site tested (quotes.toscrape.com/scroll)
- [x] At least 3 real load/scroll cycles verified (10 → 20 → 30 → 40 rows,
      3 real cycles; loop continued to a 4th before Stop, ending at 50)
- [x] Screenshots/logs actually inspected (not just trusted) — 4
      screenshots visually confirmed genuine scroll progress and real,
      distinct quote content at each stage (see Tests)
- [x] No fabricated data
- [x] No unrelated functionality regressed

# Work Completed

- **UI**: added an optional "Auto Scroll" checkbox to `popup/popup.html`,
  reusing the existing checkbox row next to Auto Next, plus a shared
  status line and the SAME DURDUR button (no new button). Default OFF.
  Added i18n keys (`liveSession.autoScrollLabel`,
  `liveSession.scrollingRows`) across all 6 locales.
- **New file `content/autoscroll.js`**: the core Infinite Scroll engine.
  `runUntilExhausted(session, host, controller, skipInitialScrape)` —
  reusable from 3 call sites (its own START_AUTO_SCROLL handler, its own
  bootstrap-resume, and `autopaginate.js`'s coexistence call) via the
  proven `skipInitialScrape` pattern. Growth-aware wait
  (MutationObserver + polling against a scrollHeight/card-count
  baseline, never a fixed sleep as the sole signal). Sole stop trigger:
  `consecutiveNoNewData >= maxNoNewDataAttempts` (default 3) — page
  height/card-count growth are early-exit optimizations only, never
  independent stop conditions (see Errors/Fixes below for why the
  original signature-repeat independent stop was wrong and removed).
  Safety limits: `maxCycles` (default 30, resettable per-page in
  coexistence mode), `MAX_ELAPSED_MS` (3 min per scroll-to-exhaustion
  call). Scroll-target detection (`findScrollTarget`/
  `isActuallyScrollable`) walks up from the first card looking for a
  genuinely scrollable ancestor (`overflow-y: auto/scroll` AND
  `scrollHeight - clientHeight > 40px`), falling back to the main
  document/window — never an unrelated sidebar/carousel.
- **Coexistence (`content/autopaginate.js`)**: when both Auto Next and
  Auto Scroll are enabled, the loop scrolls the current page to
  exhaustion (via `WSAutoScroll.runUntilExhausted`) BEFORE looking for a
  Next control, on every page including page 1 — the exact ordering the
  spec's "preferred behavior" describes. Real production bug found via
  the focused combined-mode test and fixed: Auto Scroll's own
  `status: 'stopped'` (written by its own natural per-page exhaustion)
  was being read as a permanent stop by the coexistence gate, so Auto
  Scroll never re-armed on page 2+. Fixed by re-arming (`status` back to
  `'running'`, counters reset) whenever autoPaginate is still running and
  finds autoScroll `'stopped'` — reasoning: a genuine user Stop/Finish
  always stops autoPaginate too, so a 'stopped' autoScroll seen while
  autoPaginate is still active can only ever mean "exhausted on the
  previous page."
- **Race-condition guard (`content/livewatch.js`)**: extended the
  existing autoPaginate deferral guard in `runDetectionPass` to also
  defer to Auto Scroll while it's active, for the identical
  already-proven reason (both drive the exact same
  extract/classify/merge/persist session write with no coordination
  otherwise).
- **`popup/popup.js`**: Auto Scroll toggle wiring, session-object
  `autoScroll` seeding at BAŞLA, `START_AUTO_SCROLL` sent only when Auto
  Next is OFF (autopaginate.js's own coexistence call is the sole driver
  when both are ON — never two competing scroll loops), `STOP_AUTO_SCROLL`
  sent on BİTİR, DURDUR handler and `renderLiveSessionUI` updated to
  independently track and stop/display both sub-features.
- **`background/background.js`**: `content/autoscroll.js` added to
  `CONTENT_FILES` (13 content scripts total).
- **Manifest/CONTENT_FILES parser safety**: all new explanatory comments
  about the `content/autoscroll.js` entry placed OUTSIDE the array
  literal (after `];`), per the known `scripts/release-check.js`
  apostrophe-in-comment parser fragility documented in the prior mission.
- **Real production bug found and fixed via real-browser testing**
  (`content/autoscroll.js`'s `scrollOnce`): against
  `https://quotes.toscrape.com/scroll` — a real site whose own scroll
  listener only fires its "load more" AJAX call when the window is
  within 1px of the LITERAL document bottom — `scrollIntoView` on the
  last known card alone left the real scroll position short of that
  threshold (the page has a real `<footer>` below the results), so the
  site's own trigger silently never fired: 3 full real scroll cycles
  produced zero genuine growth (confirmed via storage snapshots and
  screenshots). Fixed by always finishing each scroll with an explicit
  settle to the target's true current bottom (`scrollHeight`), not only
  in the no-cards fallback branch. Focused/regression suites re-verified
  green after the fix (see Tests).
- **Real E2E test-harness bug found and fixed** (own new file,
  `e2e/tests/autoscroll-real-site.test.js`, not production code): the
  first draft hand-seeded `seenKeys` with an ad-hoc string format instead
  of `WSRunState.buildRowKey`'s actual `'entire-row'` format (columns
  joined by U+241F), causing page-1 rows to be judged "new" again on the
  next scrape. Fixed by seeding `rows: []`/`seenKeys: {}` and merging the
  first batch through the real `WSRunState.mergeNewRows`, mirroring
  `popup.js`'s own real seeding pattern exactly (never hand-rolled).

# Tests

Focused suite `test-v1-autoscroll-content.js` (scratchpad, 14 scenarios
matching the task spec 1:1, JSDOM-based): **29/29 assertions pass, 0
failures.** Includes a full combined-mode integration test (TEST 14)
that boots `content/nextdetect.js` + `content/autopaginate.js` +
`content/autoscroll.js` together and drives a real page-1-scroll-to-
exhaustion → navigate → page-2-scroll-to-exhaustion flow end-to-end,
asserting continuous accumulation (40 → 55 → 70 rows) with 0 duplicates
spanning both scrolling and navigation.

Full regression suite (all 31 scratchpad `test-v1*.js` files):
**0 new failures.** The only 2 failing files
(`test-v1-autodetect-diagnostic-popup.js`,
`test-v1-ux-simplification.js`) are pre-existing, already-documented,
unrelated to this mission (a JSDOM null-dereference in an unrelated
diagnostic-panel click helper, and a nav-visibility assertion in the
prior UX-simplification pass) — confirmed identical before and after
this mission's changes.

`node scripts/release-check.js`: **18/18 checks pass.** 13 content
scripts resolve (includes `content/autoscroll.js`), 100% i18n coverage
across all 6 locales, production ZIP builds cleanly (37 entries).

Real-browser E2E scenario `e2e/tests/autoscroll-real-site.test.js`
(new, mirrors the proven `autopaginate-real-site.test.js` structure)
targets `https://quotes.toscrape.com/scroll` — a real, live, public
site purpose-built for infinite-scroll scraper testing (same
Zyte/Scrapy family as `books.toscrape.com`, already used for Automatic
Pagination's real-site test), confirmed by direct inspection (real
`div.quote` cards appended via a real `$(window).on('scroll', ...)` +
`/api/quotes?page=N` AJAX handler, 10 items/page, no login/CAPTCHA
required to scroll).

9 real-browser runs made across this session (all headed, real Chromium,
real extension, real site). Runs 1–2 (before the seenKeys fix) reached
real scrolling and surfaced the seenKeys test-harness bug above. Run 3
(after that fix) surfaced the real `scrollOnce` production bug above (0
genuine growth across 3 real cycles) — screenshots and storage snapshots
inspected directly, not just assertion text, per spec's explicit
requirement. Runs 4–8 (after the `scrollOnce` fix) all stalled at
`chrome.permissions.request()` for 90s+ without resolving. Diagnosed as
an environment-level condition (not a code defect): a clean sanity
re-run of the pre-existing, completely UNMODIFIED
`e2e/tests/autopaginate-real-site.test.js` against a different origin
failed identically at the identical API call, and system memory at
diagnosis time was critically low (~393MB free / ~7.9GB, ~5%). Reported
to the user as a blocker; the user freed memory (429MB free confirmed
before retry) and asked for a retry.

**Run 9 (after memory was freed): PASS.** Full real-browser verification
succeeded:
- Real page opened (`https://quotes.toscrape.com/scroll`), real popup
  rendered with the Auto Scroll toggle present, real optional host
  permission granted, real `CONTENT_FILES` bundle injected.
- Real initial extraction: 10 real quotes (e.g. "The world as we have
  created it..." — Albert Einstein), no fabricated data.
- Real Auto Scroll loop started via `START_AUTO_SCROLL`; storage
  snapshots showed genuine growth **10 → 20 → 30 → 40 rows across 3
  real, distinct scroll/load cycles** within ~3 seconds — comfortably
  meeting the "at least 3 real load/scroll cycles" requirement. The loop
  continued naturally to a 5th cycle (50 rows) before the harness sent
  Stop.
- **4 screenshots visually inspected** (not just trusted): `infinite-
  initial.png` (top of page, first 4 quotes), `infinite-scroll-1.png`
  (scrolled deep, showing genuinely different real quotes — William
  Nicholson, Jorge Luis Borges, George Eliot — with the real page
  `<footer>`/"Made with ❤ by Zyte" now visible at the bottom, directly
  confirming the `scrollOnce` true-bottom-settle fix reached the site's
  actual scroll-trigger threshold), `infinite-final.png` (further real
  quotes — Marilyn Monroe, Martin Luther King Jr., James Baldwin —
  scrollbar further down), `popup-progress.png` (popup renders
  correctly; shows the documented, pre-existing "can't be scraped —
  attached to itself" harness limitation, same as the proven Automatic
  Pagination test, not a defect).
- Duplicate protection: 0 duplicate rows across the 40-row growth
  snapshot (real 'entire-row' dedupe, verified against `WSRunState`'s
  own actual key format).
- Prior rows preserved: the very first quote (Einstein) was still
  present after all real scrolling.
- Real `STOP_AUTO_SCROLL` (DURDUR): loop stopped, `stopReason: 'user'`,
  50 rows preserved (no data loss).
- Real Finish (BİTİR): `session.status: 'finished'`, all 50 rows intact
  and ready for export.
- Minor, non-blocking console noise observed on the real site
  (`Failed to load resource: 404` — an unrelated site asset;
  `Unchecked runtime.lastError: Access to storage is not allowed from
  this context.` ×3) — did not affect any collected data or assertion;
  the same unchecked-lastError pattern already exists, unmodified, in
  the proven `autopaginate.js`/`livewatch.js` storage helpers, so this
  is pre-existing and out of this mission's scope, not a regression.

# Remaining Problems

- Real combined-mode (Auto Scroll + Auto Next together) real-site test
  not attempted — quotes.toscrape.com/scroll has no pagination
  counterpart and books.toscrape.com has no infinite scroll, so per spec
  section 20 this is verified via the JSDOM integration fixture (TEST
  14, `test-v1-autoscroll-content.js`) instead, which drives the real
  `content/nextdetect.js` + `content/autopaginate.js` +
  `content/autoscroll.js` production code together end-to-end
  (page-1-scroll-to-exhaustion → navigate → page-2-scroll-to-exhaustion,
  40 → 55 → 70 rows, 0 duplicates spanning both).

# Blockers

None remaining. A temporary environment-level blocker (`chrome.
permissions.request()` hanging under critically low system memory —
~393MB free / ~7.9GB, confirmed NOT caused by this mission's code via a
sanity re-run of the untouched, previously-proven Automatic Pagination
real-site test on a different origin) was reported to the user; the
user freed memory and asked for a retry, which then passed cleanly (see
Tests, Run 9).

# Final Verification

- Focused tests: 29/29 assertions (14 scenarios) — PASS.
- Full regression suite (31 files): 0 new failures (2 pre-existing,
  documented, unrelated failures unchanged).
- `node scripts/release-check.js`: 18/18 — PASS.
- Real-browser verification: PASS (Run 9) — real page, real popup, real
  permission grant, real extraction, real scroll-triggered growth (10 →
  20 → 30 → 40, 3+ real cycles), real dedupe, real Stop, real Finish, 4
  screenshots visually confirmed.
- Definition of Done: all 22 items satisfied.
