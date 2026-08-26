# Current Mission

**Status: COMPLETE**

Fix automatic site traversal, accurate product discovery, and output data
cleaning. Two parts: (1) verify/harden the already-built automatic
Discovery Engine (pagination/infinite-scroll/Load-More/hybrid, exhaustion
detection, deduplication) from the prior two missions, adding the
diagnostic counters this mission's own spec named; (2) fix the concrete
real-world Etsy XLSX export data-cleaning failures — duplicated price
text, Old Price duplicating Current Price, "Ad by Etsy seller" exported
as a seller name, and un-stripped tracking parameters in product links —
generically, not hardcoded to Etsy, and automatically (no per-column
manual toggle required).

# Acceptance Criteria — Definition of Done

- [x] Existing architecture inspected before writing anything (content/
      discovery.js, utils/discovery.js, content/scraper.js's own existing
      price-role/title-contamination repair system, utils/cleaners.js)
- [x] `develop` confirmed synced with `origin/develop` at session start
- [x] Reused the working traversal engines — no rewrite; only additive
      diagnostic counters (rawRecordsSeen, noGrowthCycles, paginationCycles)
- [x] Automatic pagination/infinite-scroll/Load-More/hybrid traversal
      reconfirmed working, real browser, both without ever enabling the
      legacy manual toggles
- [x] Exhaustion detection reconfirmed (Next disabled/missing, no-growth
      cycles, traversal-loop detection, safety limits) — no regression
- [x] Deduplication (canonical identity, tracking-param stripping)
      reconfirmed; two new Etsy tracking params (`ga_order`,
      `content_source`) added to both the identity list and the export
      URL-cleaning allowlist, matching the mission's own real example
- [x] PRICE: "Sale Price 920.59 TL 920.59 TL" -> "920.59 TL", verified
      exactly against the mission's own example, applied AUTOMATICALLY
      (column-name-based inference) without requiring a manual per-column
      cleaner selection
- [x] OLD PRICE: never duplicates Current Price — a NEW, always-on
      cross-column safety net (WSCleaners.applySemanticIntegrityFixes)
      blanks it whenever the two cleaned values represent the same
      amount, complementing (not replacing) the existing DOM-level
      strikethrough-based repair in content/scraper.js
- [x] SELLER: generic ad/marketplace boilerplate ("Ad by Etsy seller",
      "Sponsored", "Star Seller", bare "Seller"/"Store"/"Shop") rejected
      and blanked; real shop names (including ones that happen to START
      with "Ad..." or CONTAIN "Shop") never falsely rejected
- [x] LINK: tracking parameters stripped automatically from Link-named
      columns (inferred 'url' cleaner); genuinely identifying/unknown
      params conservatively preserved; the real navigable product URL
      path is never rewritten to an opaque identity string
- [x] IMAGE: untouched, not regressed (verified via unchanged real-browser
      export test)
- [x] SHIPPING: untouched — confirmed no existing or new fabrication logic
      exists anywhere in the codebase for this field
- [x] RAW cleanerType's "byte-for-byte, no exceptions" contract preserved
      exactly — automatic inference only ever applies when a column's
      cleanerType was never explicitly touched by the user
- [x] Performance: 100/1,000/5,000-row datasets tested for the new
      cleaning/integrity pass — linear scaling confirmed (7ms/36ms/149ms)
- [x] Real-browser verification: pagination, infinite scroll, cleaning +
      export all reconfirmed on real public sites
- [x] Full regression suite: zero new failures
- [x] Browser Process Safety preserved and reconfirmed (regression check
      re-run, PASS, both before AND after the mid-mission resource block)

# Work Completed

### 1. Discovery diagnostics (utils/discovery.js) — purely additive
Added `rawRecordsSeen` (cumulative raw-DOM-match count across every
scrape pass), `noGrowthCycles` (consecutive expansion phases with zero
new unique rows — diagnostic only, does not itself trigger a new stop
condition), and `paginationCycles` (genuine Next-control advances,
counted once in the shared `onPageAdvance()` both the same-document and
full-navigation branches call). No existing field renamed or removed —
zero risk to popup UI or existing tests that read the old fields.

### 2. Tracking-parameter list extended (utils/runstate.js, utils/transforms.js)
Added `ga_order` and `content_source` — the two Etsy tracking params named
in this mission's own real-world example, missing from the prior
mission's list — to both `IDENTITY_TRACKING_PARAMS` (dedup identity) and
`TRACKING_PARAMS` (export URL cleaning), kept in sync as this project's
own established convention requires.

### 3. Automatic Data Cleaning (utils/cleaners.js) — the core of this mission
- `priceNumericValue(v)`: extracts the single confident numeric value a
  price-shaped string represents (shares its candidate-span logic with
  `cleanPrice`), or `null` when ambiguous/absent — never guesses.
- `inferCleanerType(columnName)`: pure, generic, multi-locale (EN/TR)
  keyword-based inference — Price/Fiyat/Old Price/Eski Fiyat -> `'price'`,
  Link/URL/Bağlantı -> `'url'`, everything else -> `null` (no cleaning
  changes for it). Consulted ONLY when a column's `cleanerType` was never
  explicitly set by the user (`popup.js`'s new `effectiveCleanerType()`) —
  an explicit choice, including explicit `'raw'`, is never overridden.
- `isGenericSellerLabel(text)`: rejects ad-disclosure/accessibility-
  boilerplate/bare-marketplace-noun values ("Ad by Etsy seller",
  "Sponsored", "Star Seller", bare "Seller"/"Store"/"Shop") without ever
  rejecting a real shop name that merely contains one of those words.
- `applySemanticIntegrityFixes(rows, columns)`: the new always-on
  (never gated by any per-column setting) correctness pass — blanks an
  "Old Price"-named column's value when it numerically equals the
  "Price"-named column's value on the same row, and blanks any
  "Seller"-named column's value that is nothing but generic boilerplate.
  Runs after cleanerType cleaning so the numeric comparison sees already-
  deduplicated price text.

### 4. Wiring (popup/popup.js)
`effectiveCleanerType(col)` — explicit choice wins, else
`WSCleaners.inferCleanerType(col.name)`, else `'raw'`. Used by
`applyColumnCleaners()` (export/results pipeline) and the one-row setup
preview table, so what the user sees before BAŞLA matches what gets
exported. `computeTransformedResult()` now also runs
`WSCleaners.applySemanticIntegrityFixes()` right after column cleaning.

# Tests

359 assertions across 12 scratch suites (0 failures), plus 18/18 release
checks, plus 6 real-browser scenarios:

| Suite | Assertions |
|---|---|
| test-canonical-identity.js (prior mission, reconfirmed) | 21 |
| test-title-extraction.js (prior mission, reconfirmed) | 14 |
| test-discovery-fixtures.js (prior mission, reconfirmed) | 35 |
| test-discovery-core.js (prior mission, reconfirmed) | 53 |
| test-regression-existing.js (prior mission, reconfirmed) | 25 |
| test-popup-processing.js (prior mission, reconfirmed) | 28 |
| test-discovery-ui.js (prior mission, reconfirmed) | 30 |
| test-export-integrity.js (prior mission, reconfirmed) | 41 |
| test-data-cleaning-mission2.js (NEW) | 44 |
| test-discovery-diagnostics-mission2.js (NEW) | 19 |
| test-etsy-cleaning-e2e-mission2.js (NEW) | 29 |
| test-cleaning-performance-mission2.js (NEW) | 20 |

Real-browser (Playwright + bundled Chromium):
- `discovery-pagination-real-site` (books.toscrape.com) — PASS.
- `discovery-scroll-real-site` (quotes.toscrape.com/scroll) — PASS.
- `cleaning-real-site` (books.toscrape.com) — PASS; exercises the
  updated `utils/cleaners.js` directly, real CSV/JSON/XLSX parsed back.
- `autopaginate-real-site` (legacy engine) — PASS on 2nd attempt (see
  Bugs/Flakes below for the 1st-attempt cause).
- `autoscroll-real-site` (legacy engine) — PASS on 2nd attempt (same
  documented `chrome.permissions.request()` timing variance as before).
- `test:browser-safety` — PASS, both before and after the mid-mission
  resource block.

# Bugs / flakes investigated this mission

1. **Genuine session blocker (resolved by the user): system memory
   exhaustion.** Six consecutive real-browser runs failed
   (`chrome.permissions.request()` timing out at 30s/90s/180s, then an
   actual renderer crash) before a read-only check found only ~1GB free
   of 7.7GB RAM. Reported `BLOCKED: INSUFFICIENT SYSTEM RESOURCES` per
   CLAUDE.md, touched nothing beyond deleting orphaned temp profile
   directories left by the crashed runs (disk-only, zero process
   interaction), and waited. The user freed memory and asked to resume;
   every scenario re-run cleanly afterward. Confirmed via `git diff
   --stat` throughout that this was never caused by any code change —
   only 5 files were touched all mission, none of them browser-launch or
   permission-handling code.
2. **`autopaginate-real-site` 1st-attempt failure:** `STOP_AUTO_PAGINATE`
   got `"Could not establish connection. Receiving end does not exist."`
   — a real navigation to a new page was in flight exactly when Stop was
   sent, so the new page's content script hadn't registered its listener
   yet. This test file is completely unmodified by this mission; retried
   immediately and passed cleanly through to natural max-pages completion
   (400 rows/20 pages). Documented as a pre-existing, environment-timing
   race in the TEST's own STOP-vs-navigate sequencing, not a product
   defect — per CLAUDE.md, left alone rather than "fixed" (the mission's
   own explicit rule: never modify a test merely to make it pass).
3. **`autoscroll-real-site` 1st-attempt failure:** the same
   `chrome.permissions.request()` timing variance already documented in
   this file's own history from the prior mission ("observed 3s to ~50s
   across attempts") — passed cleanly on retry.

# Remaining Limitations

- `noGrowthCycles` is a diagnostic-only counter — it does not itself
  drive any new stop condition (the existing per-engine retry budgets,
  Next/loop/safety-limit checks already own that decision), per the
  mission's own "do not stop merely because one attempt produced no
  result."
- `applySemanticIntegrityFixes`'s Old-Price/Seller detection is column-
  NAME-based (generic, multi-word, bilingual EN/TR keyword matching),
  not DOM-based — a column named something outside that vocabulary in
  another language won't be auto-corrected (the existing manual
  cleanerType dropdown remains available as an explicit override for any
  such case).
- Etsy itself remains a confirmed, reproducible anti-bot CAPTCHA block in
  this environment (not re-tested live this mission, since it was
  already reconfirmed in the immediately prior mission and nothing about
  Etsy's own bot-detection is in scope here) — the Etsy-specific
  cleaning regressions this mission fixes are verified via a real-DOM
  (JSDOM) fixture built from the mission's own exact examples instead,
  per the mission's explicit allowance for conditions a public test site
  can't reproduce.

# GIT

Branch: `develop`, was in sync with `origin/develop` at session start.
**Nothing committed, nothing pushed this session** — per explicit
instruction ("Do not commit or push yet"). `main` and `stable/v1.31.0`
untouched. Diff is scoped to exactly 5 files: `popup/popup.js`,
`utils/cleaners.js`, `utils/discovery.js`, `utils/runstate.js`,
`utils/transforms.js` (256 insertions, 11 deletions). `MISSION.md` itself,
rewritten for this mission, is also part of this diff, per this
project's established convention.
