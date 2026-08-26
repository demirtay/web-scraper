# Current Mission

**Status: COMPLETE**

DATA INTEGRITY + FULLY AUTOMATIC DISCOVERY CLEANUP: (1) hide the manual
Auto Next/Auto Scroll checkboxes from normal users — BAŞLA is the single
trigger, automatic discovery (already built in the prior mission) decides
pagination/scroll/Load More entirely on its own; (2) fix duplicate
detection so tracking-parameter variants of the same product (the
real-world Etsy failure: `?ref=`/`click_key=`/`click_sum=` etc.) collapse
to ONE canonical record, both during discovery and at export; (3) fix
Title extraction so it prefers the actual title element inside a
repeating card instead of the whole card's contaminated textContent
(price/rating/review-count/seller-badge/shipping/discount/ad text mixed
in); (4) add a discovery-status + ALL/FIRST-N processing-choice UI panel;
(5) verify CSV/JSON/XLSX export integrity by actually parsing the
generated files, not just checking they don't throw.

# Acceptance Criteria — Definition of Done (mission's own Section 17, verbatim)

- [x] Automatic Next checkbox no longer required/visible to normal users
- [x] Automatic Scroll checkbox no longer required/visible to normal users
- [x] BAŞLA automatically launches discovery (already true from the prior
      mission — reconfirmed unchanged this mission)
- [x] Pagination automatically detected/traversed (reconfirmed, real browser)
- [x] Infinite scroll automatically detected/traversed (reconfirmed, real browser)
- [x] Load More automatically detected where applicable (reconfirmed via fixture suite)
- [x] Discovery stops automatically at exhaustion (reconfirmed, fixture + real browser)
- [x] Duplicate tracking URLs do not create duplicate products
- [x] Etsy listing-ID canonicalization works
- [x] Discovered count represents UNIQUE records
- [x] Title detection prefers the real title element over the whole card
- [x] Giant product-card text is not incorrectly exported as Title
- [x] ALL processing works
- [x] FIRST N processing works
- [x] Stop works
- [x] Finish works
- [x] CSV/JSON/XLSX contents verified (actually parsed back, not just "didn't throw")
- [x] Existing image functionality not broken (untouched this mission; release-check passes)
- [x] Existing templates/configuration not broken (untouched this mission)
- [x] Full regression suite has zero new failures
- [x] Real-browser screenshots visually inspected (not just result.json read)
- [x] Browser-process safety remains intact (regression check re-run, PASS)

# Work Completed

### 1. Canonical record identity / duplicate-detection fix
`utils/runstate.js`: added `canonicalizeIdentityValue(rawValue, baseUrl)` +
`IDENTITY_TRACKING_PARAMS` (26 known tracking/campaign params: utm_*,
gclid/fbclid/msclkid, ref/ref_src/click_key/click_sum, aff_id, spm, etc.)
+ `KNOWN_ID_URL_PATTERNS` (Etsy `/listing/<id>/` → `etsy:<id>`, Amazon
`/dp/<ASIN>/` → `amazon:<ASIN>`, eBay `/itm/<id>/` → `ebay:<id>`).
`buildRowKey()`/`mergeNewRows()` now canonicalize the dedupe-key value
before comparing, with a `context.baseUrl` parameter threaded through
every real call site (`content/discovery.js`, `content/autoscroll.js`,
`content/loadmore.js`, `content/livewatch.js`, `content/autopaginate.js`,
`content/pagination.js` ×3, `popup/popup.js`). Falls back to generic
tracking-param stripping + param-sorting + trailing-slash/host-case
normalization for any URL that doesn't match a known ID pattern; a
non-URL value falls back to raw-string comparison (never silently drops a
row it can't parse). `utils/transforms.js`'s own `TRACKING_PARAMS` list
(the "Remove Tracking Params" transform) was extended to match, for
consistency between what gets deduped and what a user can manually strip.

### 2. Title-extraction contamination fix
`content/autodetect.js`: added `looksLikeTitleContaminated(text)` (flags
2+ embedded prices, rating fractions, review/rating counts, seller
badges, shipping labels, discount percentages, ad labels — checked in 6
languages matching this project's existing i18n locale set) and
`findBestTitleDescendant(rootEl)` (scores heading tags, `itemprop="name"`,
title/name-ish class names and `data-testid`s, and text length, rejecting
any candidate that is itself contaminated or contains a price/rating/
count). `detectFields()`'s anchor-title branch now only falls back to the
whole anchor's raw text when it is NOT contaminated OR no clean
descendant candidate exists — a DOM-selection fix, never a text-stripping
one, so a legitimate title is never mangled to "fix" a false-positive
metadata match.

### 3. Discovery counters: duplicates vs. invalid/empty separated
`utils/discovery.js`: added `invalidSkipped` field + `recordScrapePassOutcome()`,
which — for the one code path with real classification visibility
(`content/discovery.js`'s own explicit per-page scrape) — separately
tracks rows excluded by the row classifier (`invalidSkipped`) from rows
that were valid but already-seen (`duplicateEncounters`). The reused Auto
Scroll/Load-More engines' own opaque internal cycles keep the coarser,
pre-existing conflated `recordExpansionDelta` counting — documented as an
honest, narrow scope limit, not silently pretended away.

### 4. UI cleanup — Auto Next/Auto Scroll hidden, discovery panel added
`popup/popup.html`: the legacy `#auto-next-toggle`/`#auto-scroll-toggle`
checkbox row is now `hidden` (never deleted — `handleStartLiveSession`
already stopped reading their `.checked` state in the prior mission, so
this purely removes a UI element normal users never needed). Added a new
`#discovery-panel` (status lines, `#discovery-choice-panel` with an
ALL/FIRST-N control pair, `#discovery-summary-panel` with found/
processed/duplicates/invalid counts).
`popup/popup.js`: added `renderDiscoveryUI()` (reads `activeLiveSession.
discovery`, shows/hides the three sub-panels by `discovery.status` +
whether a `processingSelection` exists yet, never mentions pagination/
scroll/Load-More by name), wired into `renderLiveSessionUI()`; added
`handleDiscoveryProcessAll()`/`handleDiscoveryProcessFirst()` click
handlers (delegating to the pre-existing, unmodified `processAll()`/
`processFirst(n)`), with inline, translated validation-error feedback for
a bad FIRST-N input.

### 5. i18n
`utils/i18n-data.js`: 19 new keys × 6 locales (en/tr/de/fr/zh-CN/ru),
`_one`/`_other` plural pairs where a count is involved. Verified 100%
coverage via `WSI18n.coverageReport()` and via `scripts/release-check.js`'s
own coverage gate.

# Tests

All run this session, all green (245 assertions total across 8 scratch
suites, plus 18 release-check checks and 6 real-browser scenarios):

| Suite | Assertions | Result |
|---|---|---|
| test-canonical-identity.js | 21 | PASS |
| test-title-extraction.js | 14 | PASS |
| test-discovery-fixtures.js (12 scenarios) | 35 | PASS |
| test-discovery-core.js | 53 | PASS |
| test-regression-existing.js | 25 | PASS |
| test-popup-processing.js | 28 | PASS |
| test-discovery-ui.js (new, 3 scenarios) | 30 | PASS |
| test-export-integrity.js (new) | 41 | PASS |
| `node scripts/release-check.js` | 18 checks | PASS |

Real-browser (Playwright + bundled Chromium, real public sites, real
extension, real messaging — see `test-artifacts/latest/`):

- `discovery-pagination-real-site` (books.toscrape.com) — PASS. 3 real
  pages auto-traversed with NO Auto Next ever enabled, 20→40→60 unique
  rows, 0 duplicates, real Stop preserved data, real FIRST-10/ALL
  processing verified. Screenshots visually confirm real "Page 3 of 50"
  navigation happened.
- `discovery-scroll-real-site` (quotes.toscrape.com/scroll) — PASS (after
  2 flaky `chrome.permissions.request()` timeouts — see Limitations). 3
  real scroll cycles auto-traversed with NO Auto Scroll ever enabled,
  10→40 unique rows, 0 duplicates, engine correctly chose scrolling on
  its own.
- `autopaginate-real-site` (books.toscrape.com, legacy engine) — PASS,
  400 rows/20 pages, 0 duplicates — confirms the reused engine still
  works unmodified.
- `autoscroll-real-site` (quotes.toscrape.com/scroll, legacy engine) —
  PASS, 60 rows accumulated, 0 duplicates.
- `cleaning-real-site` (books.toscrape.com) — PASS. Real CSV/JSON/XLSX
  exports built from real scraped+cleaned data and parsed back
  programmatically (not just "didn't throw").
- `etsy-popup` (default scenario, real Etsy) — genuine EXTERNAL BLOCKER:
  Etsy served a slide-to-verify CAPTCHA challenge, correctly detected and
  reported, not bypassed. Screenshot confirms a real CAPTCHA, not a false
  positive/negative.
- `test:browser-safety` (Browser Process Safety regression check) — PASS.
  Closing the harness's own browser instance never affects an unrelated,
  independently-running browser instance.

All screenshots in every scenario above were opened and visually
inspected, not just read via `result.json`'s `status` field.

# Bugs found and fixed this mission (self-repair loop)

1. **Test-fixture regression, `test-discovery-fixtures.js`** — after
   adding the `context` param to `mergeNewRows`, its own `seedAndStart()`
   helper called `mergeNewRows()` WITHOUT the new context, while every
   real production call site now passes one — a relative-URL-like fixture
   ID (`"item-1"`) canonicalized differently on the un-contexted seed call
   than on every subsequent real call, so page-1 rows were "rediscovered"
   as new on every later page. Root-caused via direct reproduction of
   `canonicalizeIdentityValue()`'s real behavior before concluding it was
   a test-harness bug, not a production one. Fixed by adding the missing
   `{ baseUrl: window.location.href }` to that one call site.
2. **Same bug class, `test-regression-existing.js`** — two hand-seeded
   session fixtures had `seenKeys: { a: true }` (a raw, pre-canonicalization
   key) that no longer matched the real canonicalized key a merge would
   compute — one scenario happened not to exercise a real merge and
   stayed green by luck, the other did and double-counted a row. Fixed by
   computing the expected key with the real production function instead
   of guessing its format.
3. **`ArrayBuffer.isView` vs. `instanceof Uint8Array` in a cross-realm
   Node `vm` sandbox** — `test-export-integrity.js`'s own sandbox
   constructs `Uint8Array`s inside the VM context's own realm, so
   `instanceof` against the host realm's constructor is (correctly) false
   — not a bug in `utils/xlsx.js`/`utils/zip.js`. Fixed the test to use
   the realm-agnostic `ArrayBuffer.isView()`.
4. **Dead `data-i18n-placeholder` HTML attribute** — the new
   `#discovery-first-n-input`'s placeholder was marked with an attribute
   convention (`data-i18n-placeholder`) that doesn't exist anywhere in
   this codebase's actual i18n-application code (every other input in
   `popup.html` hardcodes a plain English placeholder with no i18n at
   all) — the attribute would have silently done nothing, leaving the
   input with no placeholder text ever. Fixed by removing the inert
   attribute and setting `.placeholder` from `renderDiscoveryUI()` via the
   real `WSI18n.t()` call instead, which is both correct and (unlike the
   rest of this project's inputs) actually localized across all 6
   locales, since the translated key already existed with 100% coverage.
5. **`chrome.permissions.request()` real-Chrome timing variance
   (environment characteristic, not a bug)** — the `discovery-scroll-
   real-site` scenario timed out waiting for the real permission grant
   twice in a row (90s each), then passed on the third attempt in under
   2 seconds; an unrelated scenario (`autoscroll-real-site`) targeting the
   exact same origin took ~30s to resolve in between. This exact
   characteristic (wide, environment-level timing variance on this API,
   3s to ~50s+ observed) is independently documented in this file's own
   prior-mission history, confirming it predates this mission's changes
   and isn't caused by anything touched here. No code was changed in
   response — retried per CLAUDE.md's self-repair loop, confirmed not
   reproducible as a real regression.

# Remaining Problems / Limitations

- `discoveredUnique`/`duplicateEncounters` are conflated for the reused
  Auto Scroll/Load-More engines' own internal cycles (only `content/
  discovery.js`'s own explicit per-page scrape gets the precise,
  separated `invalidSkipped` vs. `duplicateEncounters` split) — an
  honest, documented, narrow scope limit inherited from those engines'
  existing opaque internals, not a data-integrity defect (nothing is
  ever mis-classified as unique; the split is just less granular there).
- The real-browser harness cannot drive the native toolbar popup
  (documented, pre-existing Playwright/Chromium limitation — see `e2e/
  run.js`'s own header comment) — the new discovery-status/ALL/FIRST-N
  UI panel is therefore verified in real Chrome only up to the point the
  harness's popup-as-a-page workaround allows (which never reaches
  `renderLiveSessionUI()`'s live-session branch — this is the exact same
  pre-existing gap every prior mission's popup UI work has had, not new).
  The panel's actual rendering/interaction logic is instead exhaustively
  covered by a real popup.html + popup.js JSDOM integration test
  (`test-discovery-ui.js`, 30 assertions, 3 scenarios, real DOM click/
  input events, not the test-only hook seam) — this is the same
  established mitigation this project's prior missions used for the same
  known gap.
- Etsy itself remains a confirmed, repeatable anti-bot CAPTCHA block in
  this environment (reconfirmed again this session, screenshot-verified)
  — per the mission's own explicit allowance, Etsy-specific canonical-
  identity and title-contamination regression tests use deterministic
  local fixtures (`test-canonical-identity.js`, `test-title-extraction.js`)
  instead of a live Etsy page.

# GIT

Branch: `develop`, was in sync with `origin/develop` at session start.
Nothing committed, nothing pushed this session — all changes below are an
uncommitted, reviewable working-tree diff, exactly as instructed
("DO NOT COMMIT. DO NOT PUSH. DO NOT MERGE INTO MAIN."). `main` and
`stable/v1.31.0` untouched.

Modified (13 files, no new files, no deletions):
`content/autodetect.js`, `content/autopaginate.js`, `content/autoscroll.js`,
`content/discovery.js`, `content/livewatch.js`, `content/loadmore.js`,
`content/pagination.js`, `popup/popup.html`, `popup/popup.js`,
`utils/discovery.js`, `utils/i18n-data.js`, `utils/runstate.js`,
`utils/transforms.js`. `MISSION.md` itself, rewritten for this mission, is
also part of this diff, per this project's established convention.
`dist/web-scraper-v1.0.2.zip` was regenerated by `scripts/release-check.js`
but stays gitignored, as always.
