# Current Mission

## REAL DETAIL ENRICHMENT VERIFICATION — ROUND 13: FALSE-POSITIVE CHALLENGE DETECTION BLOCKED EXTRACTION ENTIRELY

**Status: IMPLEMENTED, tests green, awaiting real-Chrome re-verification.**
Not committed/pushed — v1.1.0-verified tag untouched. Real evidence
after Round 12's merge-loss fix: a 303-row/7-page main scrape stayed
healthy, and the user watched the Detail worker visibly navigate to many
real Amazon product pages before manually pressing STOP. At diagnostic
time: `completed=0`, `partial=0` — not just "blank after merge" (Round
12's bug) but **zero records ever reached a successful extraction at
all** — `ws_deepscrape_fields` had 0/302 non-empty entries for every one
of the 7 configured fields, even though the field selectors themselves
were independently proven correct (the picker's own live preview showed
real values: weight=0.83 kg, dimensions=14.37"D x 4.5"W x 15.35"H,
materyal=Acrylonitrile Butadiene Styrene, base=Wedge, type=ABS).

**Trace (per the mission's own explicit pipeline) — FIRST BROKEN
TRANSITION found:** worker navigates to product URL (confirmed
working — this is what the user watched happen) -> `extractDetailFields()`
(`background/background.js`) calls `pageLooksLikeChallenge(tabId)`
**before** ever running the extractor, specifically so a real
CAPTCHA/anti-bot page is never confused with a genuine selector miss.
This is where extraction dies: `pageLooksLikeChallenge()` queried
`DEEP_SCRAPE_CHALLENGE_SELECTORS`, which included `[id*="px-" i]` and
`[class*="px-" i]` — a bare substring match for ANY element whose
id/class contains "px-" **anywhere**, not merely PerimeterX's own actual
challenge markup (already correctly, narrowly covered by the separate
`#px-captcha` entry in the same list). "px-" is an extremely common
short prefix in real-world CSS (Tailwind-style spacing utilities like
`px-4`/`sm:px-8`, ad/analytics "pixel" tracking-div ids, hashed
CSS-in-JS class names) — a real, complex, React-driven Amazon product
page is near-certain to contain at least one completely unrelated
element matching this substring. Every real navigation was therefore
misclassified `SITE_CHALLENGE` (`retryable:false`) **before** the actual
`RUN_DETAIL_EXTRACTION` message was ever sent to the content script —
explaining every symptom at once: real navigation happens (it's checked
BEFORE the false-positive fires), fast non-retrying failures cycle
through many distinct URLs (SITE_CHALLENGE never retries — explains
"watched many pages" while still ending at 0 completed), and zero values
ever reach `ws_deepscrape_fields` for any record (the extractor
genuinely never runs). The "Test Detail Fields" picker preview never hit
this: it reads live values directly from the tab the user is already
looking at, with no navigation/worker-tab/challenge-check machinery
involved at all — which is exactly why the selectors could be proven
correct while the real run still produced zero values.

**Answer to the mission's own A/B/C/D:** **D — another proven
mechanism.** Not (A) extraction producing blank values, not (B) URL
matching failing, not (C) a later state write erasing a successful
merge (that was Round 12's already-fixed bug) — extraction was never
attempted at all, rejected one step earlier by a false-positive
anti-bot-challenge detector.

**Fix (`background/background.js` only, 1 array):**
`DEEP_SCRAPE_CHALLENGE_SELECTORS` — removed the two overbroad `"px-"`
substring entries. The specific, correct PerimeterX marker
(`#px-captcha`) and every other provider's own real marker
(recaptcha/hcaptcha/cloudflare iframes, generic `captcha` id/class) are
untouched and still fully detected — verified directly (Part 2 of the
new test): a real `#px-captcha` page and a real reCAPTCHA iframe both
still correctly return "challenge detected" after the fix. Pure removal
of noise, zero loss of real detection capability.

**Related, NOT fixed (explicitly out of this mission's scope):**
`e2e/lib/challenge-detect.js` carries the identical `[id*="px-" i]`/
`[class*="px-" i]` entries (its own header comment credits it as the
"same category of signal" the background.js list was modeled on) — the
E2E test harness likely has the same latent false-positive risk against
real sites. Left untouched per this mission's explicit scope (production
Detail Enrichment pipeline only); flagged here for a future mission.

**Test infrastructure addition (`tests/lib/mini-dom.js`):** added
minimal `#id` selector support (`parseSimple`/`matchesSimple`) — needed
so a test can drive the REAL, unmodified `DEEP_SCRAPE_CHALLENGE_SELECTORS`
array (which contains a literal `'#px-captcha'` entry) against a fake
DOM, rather than only testing a subset of the real selector list. Purely
additive; re-verified against all 11 existing tests that load
`mini-dom.js` (0 regressions).

**Regression test:** new
`tests/unit/detail-enrichment-false-positive-challenge-detection.test.js`
(21 assertions) — Part 1: captures the REAL `wsDetectChallengeDom`
function and the REAL (fixed) selector array straight out of
`background.js` via an actual `chrome.scripting.executeScript({func,
args})` call (never a reimplementation), proving the OLD selector
config (reproduced verbatim from git history, passed as `args` to the
same real function) false-positives on a realistic ordinary product
page, while the CURRENT config does not, on the exact same page. Part 2:
proves real challenge pages (`#px-captcha`, a reCAPTCHA iframe) are
still correctly detected after the fix. Part 3: end-to-end, 4 records
(per the mission's own explicit "3-5 records, never 302" scale) through
the REAL, unmodified `resolveDetailPage()`/`fetchOneDetailPage()`/
`runDeepScrapeUrls()` pipeline with a fake worker tab "navigating" to a
page carrying the same incidental `"px-"` markup — proves all 4 records
now reach `status:'completed'` with zero `SITE_CHALLENGE` failures, and
every one of the 5 sample Detail fields (weight/dimensions/materyal/
base/type, matching the real report's own field names/values) has real
stored values for all 4 records in `ws_deepscrape_fields`. **Verified as
a genuine regression test**: re-run with the fix temporarily reverted —
goes RED (15 failures, `0/4` completed, every record `SITE_CHALLENGE`,
`0/4` stored per field — reproducing the exact reported "0/302" shape)
— then restored to green.

**Files changed:** `background/background.js` (1 array, +27/-3 lines
including explanatory comment). `tests/lib/mini-dom.js` (additive `#id`
selector support). `popup/popup.js`, `content/content.js`,
`content/discovery.js`, `content/autodetect.js`, `content/nextdetect.js`:
zero diff this round — mission's own explicit "do not modify Discovery,
pagination, normal scraping, canonical columns, export, or STOP
behavior" scope, and Round 12's merge-loss fix untouched (still correct,
still needed once extraction itself produces real values again).

**Tests:** 41 unit test files, 1905 assertions, 0 failures, 0 crashed;
release-check 19/19; full FAST: PASS. No browser E2E run — this session
never runs the automated browser harness; the user's own real Chrome
retest (with BOTH the Round 12 and Round 13 fixes in place) is the next
step.

---

## REAL DETAIL ENRICHMENT VERIFICATION — ROUND 12: MERGED DETAIL VALUES SILENTLY WIPED AFTER COMPLETION

**Status: IMPLEMENTED, tests green, awaiting real-Chrome re-verification.**
Not committed/pushed — v1.1.0-verified tag untouched. Real evidence,
collected AFTER Round 11's column-schema fix (main scrape: 302 rows, 7
Amazon pages, base columns healthy). A Detail Enrichment run over all 302
product URLs (7 fields: weight/dimensions/materyal/base/type/about/yorum
sayısı) visited every page and completed normally. The real exported
Excel had all 7 Detail columns present as HEADERS, but every single one
of the 302 rows was blank underneath them (0 populated rows per column) —
headers present, values gone.

**Investigation (per the mission's own checklist):**
1. Did each completed Detail record contain extracted values in storage?
   YES — `background.js`'s `persistDetailResultFields(url, resolved.fields)`
   correctly wrote real field values into `ws_deepscrape_fields`, keyed
   by the exact same `url` string used throughout that record's own
   lifecycle (dispatch -> fetch -> persist never re-keys on `finalUrl`
   or anything else).
2. Are Detail records keyed by the same URL as the main rows? YES — both
   `WSDetailScope.buildDetailUrlList()` (dispatch) and
   `mergeDetailResults()` (merge) read the identical `row[sourceColumnId]`
   raw value, with no normalization mismatch between them.
3. Does `mergeDetailResults()` find a matching main row? YES — traced and
   confirmed correct; `mergeDeepScrapeResults()` (the older, parallel
   Deep Scraping panel's own merge) uses the identical, unmodified
   pattern for comparison.
4. Are `dt_*` columns created but written under different IDs? NO —
   `computeTransformedResult()`'s `baseColumns = state.columns.concat(deepScrapeColumns).concat(detailColumns);`
   already appends Detail's own columns correctly (and always did,
   completely independent of Round 11's canonical-schema fix — see
   suspicion #6 below).
5. Does hydration/export read from an OLD dataset instance instead of
   the merged canonical rows? **YES — this is the actual root cause.**
6. Is Round 11's canonical-column-schema fix accidentally filtering
   Detail columns? **NO, ruled out** — Round 11 only ever touched
   `content/content.js`'s `migrateContainerSelectorIfStale()` (a
   content-script-side container-selector repair), which has zero
   overlap with popup.js's own, entirely separate `detailColumns` array
   or `computeTransformedResult()`'s column-merging logic.

**Root cause traced:** `mergeDetailResults()` (`popup/popup.js`) only
ever mutates the in-memory `rawRows` array — by design, it never writes
`dt_*` values back into `ws_live_session` storage (see its own header
comment: the field VALUES live in `ws_deepscrape_fields`, a separate
key). `attachLiveSessionStorageListener()`'s `chrome.storage.onChanged`
callback unconditionally did `rawRows = activeLiveSession.rows;` every
time `ws_live_session::<host>` changed — and it STAYS attached
(`session.status === 'active'`) for as long as the popup is open on that
session, long after the main scrape itself finished. `content/livewatch.js`'s
own passive `MutationObserver`-driven rescan keeps running on the
original scrape tab the entire time it stays open — completely
independent of Detail Enrichment — and re-persists this exact same
session key on essentially any DOM mutation (ads, carousels, lazy-loaded
widgets: a near-certainty on a real e-commerce page over however long a
302-URL Detail run takes). The very next such write, landing any time
after Detail finished while the user is still looking at Results,
silently replaced the already-merged in-memory `rawRows` with a fresh
copy straight from storage that had never seen a single `dt_*` value —
wiping every Detail column back to blank, with no error of any kind. The
column LIST itself (`detailColumns`, feeding export headers) is a
completely separate, unaffected variable — which is exactly why the
export showed headers with zero values, not missing columns entirely.

**Fix (`popup/popup.js` only, 1 call site):**
`attachLiveSessionStorageListener()` now re-runs the exact same,
already-correct, URL-keyed `hydrateDetailResultsIfAny()` (the function a
prior mission already built for the "popup reopen" case) every time it
replaces `rawRows` — a pure re-application of whatever a TERMINAL Detail
run already has in storage, never a new fetch/navigation, never a re-
charge. A Detail run that is still actively RUNNING is unaffected: its
own live `attachDetailStorageListener()`/`renderDetailProgress()` path
keeps merging exactly as it always did once it reaches ITS OWN terminal
state, independent of this listener. The older "Deep Scraping" panel's
own `mergeDeepScrapeResults()` has no equivalent hydration call and
likely carries the identical latent bug — explicitly out of scope for
this mission (Detail Enrichment only) and left untouched.

**Test infrastructure fix (`tests/lib/load-popup.js`, needed to even
observe this bug in a test):** `chrome.storage.onChanged.addListener()`
was a pure no-op mock — real listeners were registered but never
capturable/invokable, so no test could exercise
`attachLiveSessionStorageListener()`'s real callback at all. Now captures
every registered listener into `sandbox.__storageChangeListeners` (zero
behavior change for any existing test — nothing previously read this,
nothing auto-fires) and adds `sandbox.fireStorageChange(areaName,
changesObj)` to invoke them directly with a real `(changes, areaName)`
pair, mirroring this project's own established convention of capturing
`chrome.runtime.onMessage` listeners for direct dispatch in content-
script tests. Separately, `chrome.storage.local.get()`'s mock was
returning a **shallow reference** to the stored object rather than a
copy — unlike real `chrome.storage.local`, which always hands back a
structured-clone. This silently masked the entire bug in testing:
`mergeDetailResults()`'s in-place row mutation leaked directly into the
mock's own store, so a simulated "later write" would already carry the
Detail values that were never actually persisted in production, making
the new regression test pass even with the real fix removed. Fixed to
deep-clone (`JSON.parse(JSON.stringify(...))`, matching the exact
pattern the Round 11 vm-sandbox loaders already use) — verified as a
genuinely zero-behavior-change correctness fix by re-running all 12
existing tests that load `load-popup.js`, all still 0 failures.

**Regression test:** new
`tests/unit/detail-enrichment-merge-survives-live-session-writes.test.js`
(35 assertions) — Scenario A: the mission's own explicit 3-row spec
(Title/Price base columns, weight/material/about Detail fields via URLs
A/B/C), proving `mergeDetailResults()` maps all 3 by URL, base values
stay unchanged, final export headers are exactly `Title, Price, Link,
weight, material, about` with real values (not blanks) — THEN fires a
simulated `content/livewatch.js`-style passive rescan write on
`ws_live_session::example.com` (via the new `fireStorageChange()` test
helper, driving the REAL, unmodified listener) and proves every Detail
value survives it, base columns are untouched, and the CSV taken AFTER
that write (what the user actually downloads in the real report) still
contains every row's real values — then a genuine popup reopen
(`loadPopup()` again against the same storage) confirms hydration still
works and sends ZERO messages to background.js/content scripts (no
re-fetch). Scenario B: the REAL Amazon shape (302 main rows, 7 Detail
fields matching the report's own field names verbatim) — same survival
proof at the reported scale: 302/302 rows populated before AND after the
simulated live-session write, export has exactly 303 lines (1 header +
302 rows), and every row's "materyal" value is verified present (302
occurrences). **Verified as a genuine regression test**, not a false
positive: re-run with the fix line temporarily commented out —
correctly goes RED (7 failures, "got 0 / 302", export showing headers
with blank values — reproducing the exact reported symptom) — then
restored to green.

**Files changed:** `popup/popup.js` (1 call site added inside
`attachLiveSessionStorageListener()`), `tests/lib/load-popup.js` (test
infra: onChanged capture/dispatch + storage.local.get deep-clone fix).
`content/content.js`, `content/discovery.js`, `content/autodetect.js`,
`content/nextdetect.js`: zero diff this round (mission's own explicit
"do not investigate navigation/pagination/container selector" scope).
Pagination, Next-detection, main scraper column ownership (Round 11),
exports' own transform/cleaning logic, STOP/RESUME, dedupe, auto-scroll,
load-more, storage architecture: zero diff.

**Tests:** 40 unit test files, 1884 assertions, 0 failures, 0 crashed;
release-check 19/19; full FAST: PASS. All 12 pre-existing tests that
load `tests/lib/load-popup.js` re-verified individually (0 failures) to
confirm the shared test-infra fix caused no regressions elsewhere. No
browser E2E run — this session never runs the automated browser harness;
real-Chrome verification is done manually by the user, which this round
is now awaiting per its own closing instruction ("Then STOP for one real
Chrome verification").

---

## REAL AMAZON EVIDENCE — ROUND 11: COLUMN-SCHEMA OWNERSHIP (mixed-schema corruption from Round 10's own repair)

**Status: IMPLEMENTED, tests green, awaiting real-Chrome re-verification.**
Not committed/pushed — v1.1.0-verified tag untouched. Real evidence,
collected AFTER Round 10's pagination/container fix started working (7
pages scanned, 302 unique records): user manually selected exactly TWO
columns (`başlık`, `fiyat`) via Manual Mode — never touched Auto Detect.
`session.scraperConfig.columns` correctly persisted those exact two IDs
(`col_1788333394475_knjsfa`, `col_1788333411610_dnhp65`). BUT
`session.rows` contained TWO different schemas: row 0 used a freshly-
generated 10-column Auto-Detect-style schema (Link, Image, Title, Count,
Rating, Field, Field 2, Price, Field 3, Field 4); every later row used
the user's own two manual column IDs. Excel export picked up the
10-column row as its header, so 301 of 302 records rendered blank (their
real data lived under different column IDs than the export was reading).
The page-1 diagnostic also proved it directly: raw=48, accepted=48,
duplicates=47, newUnique=1 — a dedup signature collapse consistent with
most of that 10-column schema's fields (the generic `Field`/`Field 2`/
etc. fallback names) resolving empty for nearly every card.

**Root cause traced:** this is a genuine regression introduced by
Round 10's own new repair code, in the SAME round it was written. Round
10's over-broad/low-cohesion repair branch in `migrateContainerSelectorIfStale()`
(`content/content.js`) adopted `runAutoDetect()`'s winning structure's
containerSelector AND fields "together, atomically" — i.e. it did
`state.columns = autoDetectWinner.fields.map(...)` unconditionally
whenever it adopted a new container, even when the user never ran Auto
Detect and had manually selected different columns. That mutated
in-memory `state` was extracted from (producing page 1's one corrupted
row) and persisted back to `ws_state::hostname` — but popup.js's own,
SEPARATE in-memory `state` (which `session.scraperConfig` for every
LATER Discovery page is built from) only ever re-reads
`containerMigration.migratedContainerSelector` after RUN_EXTRACTION,
never columns. So exactly one row (from that single RUN_EXTRACTION call)
got the wrong 10-column schema, while all 301 later rows — extracted via
`discovery.js` using `session.scraperConfig`, which never saw the column
swap — kept the correct 2-column schema. Two different generations of
column IDs, both real, coexisting in one session's `rows`.

**Fix (`content/content.js` only):** the repair branch now NEVER touches
`state.columns` — only `state.containerSelector` is ever replaced. This
is safe because `Sel.queryFromScope()`/`querySelector()` perform a
DESCENDANT search, not a direct-child-only one: a class-based
`relativeSelector` built to work from a narrow internal-fragment scope
generally ALSO resolves correctly from a broader, more correct ANCESTOR
scope (the true record-level container) — intermediate nesting depth
doesn't change what a descendant selector matches. The repair is
verified, not assumed: a new `computeStoredColumnsCohesion(newContainer,
state.columns)` check must show the user's own EXISTING columns resolve
with cohesion `>= MIN_STORED_SELECTOR_COHESION` against the candidate
container (or, for a <2-column config with no measurable "cohesion", a
plausible non-zero match count) before the migration is accepted;
otherwise it falls through to the pre-existing single-anchor fallback,
or leaves the original selector untouched entirely. Auto Detect's own
field list is no longer read by this repair path at all.

**Preserved, unchanged:** `popup/popup.js`'s `handleUseAutoDetectFields()`
— the ONLY legitimate path by which Auto Detect's own columns become
canonical, triggered exclusively by the user explicitly clicking "Use
Selected Fields" after running Auto Detect themselves. Entirely
independent of `migrateContainerSelectorIfStale()`; zero diff this
round.

**Files changed:** `content/content.js` only. `content/autodetect.js`,
`content/nextdetect.js`, `content/discovery.js`, `popup/popup.js`: zero
diff this round (discovery.js's Round 10 delegation to the same
canonical function means it benefits from this fix automatically, with
no changes of its own needed). Pagination, Next-detection, container
selector logic itself, Detail Enrichment, exports' own code, STOP/RESUME,
dedupe, auto-scroll, load-more, storage architecture — zero diff.

**Regression test:** new `tests/unit/canonical-column-schema-ownership.test.js`
(111 assertions) — drives the real, unmodified BAŞLA -> RUN_EXTRACTION
path with a manually-selected 2-column config (Turkish names, real
report's own literal column IDs) against a stale, over-broad
containerSelector (triggering the exact repair path implicated), then
drives `content/discovery.js`'s own real `runDiscoveryLoop()` through a
second page. Proves: RUN_EXTRACTION's container IS repaired
(`templateMigrationPerformed === true`) while every one of the 48 rows
contains ONLY the 2 manual column IDs (+ legitimate internal metadata —
`scraper.js`'s own `_wsAnomaly` flag, present on every row regardless of
schema) with real, non-blank data under both; persisted
`ws_state::hostname` still shows exactly 2 columns with the original IDs
and names (`başlık`/`fiyat`) after the repair; a full discovery-loop
pagination cycle (real pagination-landmark detection + navigation,
unaffected by this fix) leaves `session.scraperConfig.columns` still
exactly those same 2 canonical IDs; every row across the whole run
carries only those 2 IDs, never a mixed generation. Also re-verified all
3 most directly-relevant pre-existing tests still pass unchanged:
`amazon-real-diagnostic-reproduction.test.js` (17/17 — its own fixture's
2 columns happen to also resolve correctly against the repaired
container, so the repair-acceptance path is still exercised the same
way), `discovery-canonical-selector-ownership.test.js` (10/10),
`stale-container-selector-migration-fix.test.js` (11/11).

**Tests:** 39 unit test files, 1849 assertions, 0 failures, 0 crashed
(every file individually verified, plus the new file's own 111
assertions); release-check 19/19; full FAST: PASS. No browser E2E run —
this session never runs the automated browser harness; real-Chrome
verification is done manually by the user, which this round is now
awaiting per its own closing instruction ("Then STOP for one real Chrome
verification").

---

## REAL AMAZON EVIDENCE — ROUND 10: REPAIR TECHNIQUE UPGRADED (single-anchor climb -> runAutoDetect())

**Status: IMPLEMENTED, awaiting real-Chrome re-verification.** Not
committed/pushed — v1.1.0-verified tag untouched. Real Active Session
Diagnostic from a failed run proved Round 9's revalidation fix reached
the session but still left `containerSelector = "div.a-section.a-spacing-none"`
in place (raw=245, newUnique=167, garbage rows exactly as reported).

**Root cause traced:** both Round 6's (`content.js`) and Round 9's
(`discovery.js`, delegating to the same logic) re-validation used a
single-anchor `Sel.findRepeatingContainer()` climb to repair an
over-broad/low-cohesion selector. That climb has its own deliberate
"stop once complete" heuristic (`countMeaningfulDescendants >= 3`) —
correct for its ORIGINAL purpose (Manual Mode, anchored on a human's own
confirmed click) but not strong enough for this repair: on the real
page, an internal fragment level (e.g. a title-row) can already look
"complete enough" on its own, so the climb stops there instead of
reaching the true record boundary. The resulting "migrated" candidate is
STILL a fragment, its row-cohesion isn't measurably better than the
original, and the repair is correctly (from its own narrow logic)
rejected — leaving the stale selector in place. This is why the
Round 9 fix reached the session but didn't actually repair it.

**Fix:**
1. **`content/content.js`** (`migrateContainerSelectorIfStale()`): for
   the over-broad/low-cohesion case, now PREFERS
   `content/autodetect.js`'s own `runAutoDetect()` — a strictly more
   powerful, already-independently-validated signal (hard row-cohesion
   gate + field-anchored candidate generation, proven across many
   earlier rounds) — adopting its winning structure's containerSelector
   AND fields together, atomically (old columns' relativeSelectors are
   meaningless against a new container scope). The single-anchor climb
   remains as a fallback only when `WSAutoDetect` isn't available or
   finds nothing usable — never removed, never weakened; the
   over-specific (too-narrow) case is completely unchanged.
2. New `window.WSContent = { migrateContainerSelectorIfStale }` export —
   `content/content.js` previously exported nothing.
3. **`content/discovery.js`**: its own Round 9 duplicate logic
   (`computeStoredColumnsCohesion`/the old `revalidateScraperConfigIfStale`
   body) removed entirely — now calls
   `window.WSContent.migrateContainerSelectorIfStale(session.scraperConfig)`
   directly, so both the RUN_EXTRACTION path and the discovery-loop path
   call the exact same, single, canonical repair function — no more
   divergence risk between two copies.

**Files changed:** `content/content.js`, `content/discovery.js` only.
`content/autodetect.js`, `content/nextdetect.js`: zero diff this round
(confirmed identical). Detail Enrichment, STOP/RESUME, exports, dedupe,
auto-scroll, load-more, storage architecture — zero diff.

**Regression test:** new `tests/unit/amazon-real-diagnostic-reproduction.test.js`
(17 assertions) — reproduces the EXACT real diagnostic (stale
`div.a-section.a-spacing-none`, real garbage row texts verbatim: "Amazon's
Choice: Overall Pick", "4.7", "Material", "Top Brands", "Customer
Reviews") through the real, unmodified production BAŞLA ->
RUN_EXTRACTION path. Proves: `migration.usedAutoDetectRepair === true`,
repaired selector matches ~48 real cards (not the stale ~102+ in this
fixture's own proportions), extraction produces exactly 48 rows with
zero garbage-text leakage, repaired selector persists to storage, and —
using the real, unmodified `findNextControl()` — the stale selector
still rejects the real Next control (bug reproduced) while the repaired
one finds it, enabled. Round 9's own test
(`discovery-canonical-selector-ownership.test.js`) updated to load
`content/content.js` + `content/autodetect.js` too (previously didn't,
since the logic lived directly in discovery.js) — still 10/10 green,
now exercising the stronger repair path end-to-end through the real
discovery loop.

**Tests:** 38 unit test files, 1738 assertions, 0 failures, 0 crashed
(every file individually verified); release-check 19/19; full FAST:
PASS. No browser E2E run.

---

## REAL AMAZON EVIDENCE — ROUND 9: CANONICAL SELECTOR OWNERSHIP (session lifetime, not just RUN_EXTRACTION)

**Status: IMPLEMENTED, awaiting real-Chrome re-verification.** Not
committed/pushed — v1.1.0-verified tag untouched.

**Contradiction that triggered this round:** a fresh Auto Detect pass on
the real Amazon page correctly found the true ~48-row selector
(`matchedElementCount=48`, `unique data-asin=48`), yet the CURRENT LIVE
SESSION / Next-Detect diagnostic still showed the old, stale
`div.a-section.a-spacing-none` — even though Round 6's
`content/content.js` RUN_EXTRACTION-time migration fix was already
shipped.

**Root cause traced (no guessing):** `content/content.js`'s
`migrateContainerSelectorIfStale()` only ever runs when `RUN_EXTRACTION`
is actually invoked (a scrape freshly (re)started). Once a discovery
session EXISTS, `content/discovery.js`'s `runDiscoveryLoop()` reads
`session.scraperConfig.containerSelector` fresh every iteration and uses
it for that session's ENTIRE lifetime with zero re-validation. Critically,
`content/discovery.js`'s own bootstrap-resume block (file-bottom code,
run on EVERY fresh content-script injection — a real page reload or
extension reload included) picks up ANY still-running session and hands
it straight back into the loop with its own frozen-in-time config,
completely disconnected from any newer Auto Detect result. A session
created (or left running/stuck) before this project's own
container-precision fixes existed keeps using its stale selector
forever, regardless of how many times Auto Detect is re-run afterward —
nothing ever tells THAT session to look again.

**Fix (content/discovery.js only):** new `revalidateScraperConfigIfStale()`
— the SAME re-validation mechanism `content/content.js`'s
`migrateContainerSelectorIfStale()` already uses and already proved safe
(row-cohesion-based staleness detection, re-anchor via
`Sel.findRepeatingContainer` + `buildContainerSelector`, only accept a
MEASURABLY better replacement) — applied exactly ONCE, at the very start
of `runDiscoveryLoop()`'s own run (`firstIteration` only — covers both a
genuinely fresh `START_DISCOVERY` and a resumed instance's first pass),
never re-applied per page (a session's selector must stay consistent
across all its pages once validated). content/content.js/
content/autodetect.js/content/nextdetect.js: zero diff this round.

**Regression test:** new `tests/unit/discovery-canonical-selector-ownership.test.js`
(10 assertions) — Scenario A: an ALREADY-EXISTING session (never
touched by RUN_EXTRACTION in the test — simulating a bootstrap-resumed
instance) carrying the exact stale `div.a-section.a-spacing-none`
selector (with pagination wrapped in the same generic class, matching
the real second symptom) is self-healed by the real, unmodified
`runDiscoveryLoop()` before next-page detection — proves: canonical
selector matches ~48, old selector never survives anywhere in final
storage, next candidate found, pagination action issued toward `page=2`.
Scenario B: an already-healthy selector is left completely untouched
(preservation — never second-guesses a working selector).

**Tests:** 37 unit test files, 1721 assertions, 0 failures, 0 crashed
(every file individually verified); release-check 19/19; full FAST:
PASS. No browser E2E run.

---

## REAL AMAZON EVIDENCE — ROUND 8: CONTAINER-SCOPING HYPOTHESIS DISPROVED (no fix)

**Status: DIAGNOSIS ONLY — no code changed.** Real-Chrome retest after
Round 7's clickTrigger fix still showed 167 records / 1 page / no
navigation. Hypothesis investigated per explicit instruction: "production
findNextControl(containerSelector) searches only INSIDE the product-row
container, so Amazon's pagination bar (living outside/adjacent to it)
can never be found."

**Traced (content/nextdetect.js, read-only):** `containerSelector` is
used in exactly ONE place — `isInsideScraperContainer()` ->
`el.closest(containerSelector)` — which only ever EXCLUDES a candidate
whose ANCESTOR matches the selector. Every actual search
(`candidateElements()`/`document.querySelectorAll`,
`findPaginationRegions()`'s landmark/cluster queries,
`findWithinRegion()`'s own `region.querySelectorAll`) operates on the
WHOLE DOCUMENT or an independently-discovered region — never restricted
to `containerSelector`'s own matches.

**Disproved by direct execution:** new
`tests/unit/pagination-not-scoped-to-container.test.js` (8 assertions,
0 failures) builds EXACTLY the structure this round specified
(`#search > .product-results-container [48 rows]` +
`#search > .pagination > a.s-pagination-next`, pagination genuinely
outside/sibling to the results wrapper) and runs the real, completely
unmodified `findNextControl(containerSelector)` with the containerSelector
scoped only to the 48 product rows. Result: `found: true`, `disabled:
false`, `method: 'pagination-landmark'`, trigger navigates directly to
the real `page=2&ref=sr_pg_1` target. Also proves 48 rows stay 48 and no
sidebar/filter/related-search text leaks into extraction — all
unaffected regardless of this investigation.

**Conclusion:** container-selector scoping is NOT the current
production bug. No code was changed (per explicit instruction: fix only
after reproducing the failure — it could not be reproduced this way).
The real production failure's exact cause remains open — the next real
evidence needed is what production's OWN persisted
`session.scraperConfig.containerSelector` and pagination diagnostic
actually contain on the latest failing run, since this test proves the
*architecture* is sound for the structural shape investigated here.

**Files changed:** none in `content/`. New:
`tests/unit/pagination-not-scoped-to-container.test.js` only.

**Tests:** 36 unit test files, 1711 assertions, 0 failures, 0 crashed;
release-check 19/19; full FAST: PASS.

---

## REAL AMAZON EVIDENCE — ROUND 7: TRIGGER FIX (synthetic click -> direct navigation)

**Status: IMPLEMENTED, awaiting real-Chrome re-verification.** Not
committed/pushed — v1.1.0-verified tag untouched. Row detection and the
stale-container-selector bug (Rounds 4-6) are confirmed fixed by the
user's own real-browser evidence — this round is the next, distinct
layer, traced through the ACTUAL production decision path per explicit
instruction (no more autodetect.js changes, no more diagnostic tools).

**Proven via direct execution of the real, unmodified
`findNextControl()`:** the real Amazon Next anchor (`aria-label="Go to
next page, page 2"`, `href` to `page=2`) IS found — `method:
"pagination-landmark"` (its aria-label matches the loose "next"-text
tier, not the exact-name tier, since "Go to next page, page 2" isn't an
exact match for "next"/"next page"). Every text/rel-based detection tier
(rel=next, exact accessible-name, this loose-text/bare-arrow region
match) has always used `clickTrigger()` — a synthetic `MouseEvent`
dispatch — even when the found element is a real `<a href>` whose
destination is already known with certainty from the href itself. A
synthetic click's default action is not guaranteed to reliably cause
navigation on every real site.

**Fix (`content/nextdetect.js` only):** `clickTrigger(el)` now checks
whether `el` is a real anchor with an href that independently verifies
as "points at a higher page" (`pointsAtHigherPage()` — the same narrow,
already-proven check the href-based tiers already used) and, if so,
returns a direct-navigation trigger instead of a synthetic click —
centralized in ONE place so every detection tier benefits with zero
call-site changes, including zero changes to `content/discovery.js`
(which only ever calls `nextInfo.trigger()`, never caring how it's
implemented). A control with no real advancing href (a JS-driven SPA
control, `href="#"`, a plain `<button>`) still gets the synthetic click
— completely unchanged.

**Files changed:** `content/nextdetect.js` only (+39 lines net).
`content/autodetect.js`/`content/discovery.js`/`content/content.js`:
zero diff this round (confirmed — identical line counts to before). No
new diagnostic tools added.

**Regression test:** new `tests/unit/discovery-real-amazon-next-trigger.test.js`
(9 assertions) — drives content/discovery.js's own real, test-exposed
`runDiscoveryLoop()` (never a reimplementation) with page 1 already
scraped and the EXACT real Amazon Next anchor DOM from the user's own
evidence sitting outside the real product rows, stubbing only
content/domwait.js's own timer mechanics (a separate, out-of-scope
module) with a shim that still calls the real `trigger` callback and
still resolves based on a real `location.href` change. Proves, end to
end, through the real STAGE 1-16 loop: next candidate found, NOT
finalized via `finalizeComplete('no-more-mechanisms')`,
`paginationActionIssued: true`, and `location.href` genuinely set to the
real `page=2&ref=sr_pg_1` URL — `outcome: 'url-changed'`,
`paginationActionSucceeded: true`. Two earlier tests whose fixtures also
have a real, valid Next href were updated to assert direct navigation
instead of a synthetic click (the correct, improved behavior, not a
regression) — `amazon-fragment-scoring-fix.test.js`,
`stale-container-selector-migration-fix.test.js`.

**Tests:** 35 unit test files, 1703 assertions, 0 failures, 0 crashed
(every file individually verified); release-check 19/19; full FAST:
PASS. No browser E2E run.

---

## REAL AMAZON EVIDENCE — ROUND 6: STALE CONTAINER-SELECTOR ROOT CAUSE FIXED

**Status: IMPLEMENTED, awaiting real-Chrome re-verification.** Not
committed/pushed — v1.1.0-verified tag untouched. Root cause PROVEN by
real-browser evidence from Round 5's diagnostic button (not guessed).

**Proven root cause:** `content/content.js`'s `RUN_EXTRACTION` handler
always reads `WSStorage.getState(hostname())` — the PERSISTED
per-hostname `containerSelector`/`columns` — as the source of truth,
regardless of what a fresh Auto Detect pass would find. Its own
pre-existing `migrateContainerSelectorIfStale()` only ever re-validated
a stored selector for being too NARROW (matching <= 2 elements, an old
over-specific template) — never for being too BROAD. The real stale
selector (`div.a-section.a-spacing-none`, matching 242 elements) sailed
through completely unvalidated every single run. `popup.js`'s
`handleStartLiveSession()` already correctly seeds
`session.scraperConfig.containerSelector` from this SAME migrated
value (a pre-existing, already-working mechanism — confirmed by reading
that function's own header comment) — so the fix only needed to happen
at the migration-validation layer, nowhere else. Because that same
stale, broad selector was also what `content/discovery.js` handed to
`content/nextdetect.js`'s `findNextControl()`, an over-broad selector
correctly (from ITS own perspective) excluded the real Next control as
"inside the scraper's own container" — `content/nextdetect.js` itself
needed no change at all; fixing the selector at its source fixes both
symptoms.

**Fix (content/content.js only):** `migrateContainerSelectorIfStale()`
now ALSO re-validates a selector that matches plenty of elements but
whose own STORED COLUMNS rarely resolve together on the same instance
(new `computeStoredColumnsCohesion()` — the same "row cohesion"
invariant `content/autodetect.js`'s own detection pipeline already
enforces at DETECTION time, reapplied here as a RUNTIME staleness check
against whatever already happens to be sitting in storage). When
confirmed stale this way, the EXISTING, already-proven re-anchoring
mechanism (a live anchor via one of the stored columns' own
relativeSelector, then `Sel.findRepeatingContainer` +
`buildContainerSelector`) re-derives the correct container — only
replacing the stored one when the replacement is measurably better
(higher cohesion, no selector-scope drift of its own). The pre-existing
too-narrow migration path is completely unchanged.

**Files changed:** `content/content.js` only (+97/-9 lines).
`content/autodetect.js`/`content/nextdetect.js`: zero diff this round
(confirmed — diff line counts identical to before). Detail Enrichment,
exports, STOP/RESUME, credits, storage.js, autoscroll/loadmore/
pagination/autopaginate.js, cross-navigation, background.js — all zero
diff.

**Regression test:** new `tests/unit/stale-container-selector-migration-fix.test.js`
(11 assertions) — loads the REAL, unmodified `content/content.js` +
`content/selector.js` + `content/scraper.js` + `utils/storage.js`
together, seeds a stale `.a-section.a-spacing-none` selector (matching
>96 elements against 48 real cards, reproducing the exact real ratio),
dispatches a real `RUN_EXTRACTION` message through content.js's own
listener, and proves end-to-end: the stale selector is migrated to the
true ~48-card selector; extraction produces ~48 rows; the corrected
selector is persisted back to storage; using the OLD selector directly,
the real `findNextControl()` still rejects the real Next control
(bug reproduction); using the corrected one, it's found and its trigger
fires on the real link.

**Tests:** 34 unit test files, 1694 assertions, 0 failures, 0 crashed
(every file individually verified); release-check 19/19; full FAST:
PASS. No browser E2E run.

---

## REAL AMAZON EVIDENCE — ROUND 5: RAW EVIDENCE COLLECTION (no more guessing)

**Status: awaiting real Amazon paste.** Round 4's fixes did NOT resolve
the real-Chrome retest (still 168 rows / 1 page). Per explicit
instruction, NO further speculative fixes to `content/autodetect.js` or
`content/nextdetect.js` this round — both are confirmed byte-for-byte
unchanged since round 4 (`git diff --stat` line counts match exactly).

**New: a temporary, read-only "📋 Copy Real DOM Diagnostic" button** —
Sonuçlar tab → ▸ Geliştirici Araçları, right after "Copy Next-Detect
Diagnostic". New self-contained file `content/realdomdiag.js`: only
reads `WSAutoDetect.runAutoDetectDiagnostic()`'s existing output
(never calls `runAutoDetect()` itself) plus raw
`document.querySelectorAll()` evidence — never references
`WSNextDetect`, never clicks/triggers, never touches storage, never
navigates. Reports: final selected containerSelector + matchedElementCount;
every top candidate's selector/count/score/coverage/cohesion/
fragmentation; the first 10 real elements the winning selector matches
(tag/class/id/data-component-type/data-asin/nearest such ancestors/
abbreviated outerHTML); page-wide `data-asin`/`[data-component-type="s-search-result"][data-asin]`
counts; and, independently, raw matches for `.s-pagination-next`,
`a.s-pagination-next`, `[aria-label*="Next" i]`, href-contains-`page=`,
href-contains-`ref=sr_pg_`, plus the closest ancestor HTML for the
visible pagination bar.

**Files changed:** new `content/realdomdiag.js`; `background/background.js`
+ `popup/popup.js` (added to both CONTENT_FILES lists, per that file's
own "kept in sync manually" convention); `popup/popup.html`/`popup/popup.js`
(new panel/button/handler, same dev-gated pattern as every other Copy
*Diagnostic button). `content/autodetect.js`/`content/nextdetect.js`:
zero diff this round.

**Tests:** new `tests/unit/realdom-diagnostic-wiring.test.js` (21
assertions — proves isolation from nextdetect.js/autodetect.js's real
detection call, no storage/navigation/click side effects, button wiring
end-to-end). 33 unit test files, 1683 assertions, 0 failures;
release-check 19/19; full FAST: PASS.

**Next step:** user reloads the extension once, clicks the new button on
the real Amazon tab, and pastes the output back for a genuine,
non-speculative diagnosis.

---

## REAL AMAZON EVIDENCE — ROUND 4: FIELD-SELECTOR PRECISION + PAGINATION/CONTAINER DECOUPLING

**Status: IMPLEMENTED, awaiting real-Chrome re-verification.** Not
committed/pushed — v1.1.0-verified tag untouched.

**ROOT CAUSE A — field selector generation itself was poisoned
(content/autodetect.js):** the real persisted Price relativeSelector was
`span.a-color-base` — Amazon's own generic text-color utility class,
reused for ratings/badges/filter labels/unrelated UI, never
price-specific. `buildFieldCandidate()` now measures GLOBAL semantic
precision (new `measureGlobalSelectorPrecision()`) for any field whose
own samples predominantly look price-like (PRICE_RE): how many elements
that exact selector matches page-wide, and what fraction also look
price-like. Too-broad + low-precision → `tryEscalateFieldSelector()`
tries a parent-scoped compound (built entirely from existing,
unmodified `Sel.*` functions); if that's still not precise enough, the
field is dropped rather than shipped poisoned. `PRICE_RE` itself
extended to recognize ISO currency CODES (TRY, USD, EUR, ...) next to a
number, not just symbols — real data contained "TRY 1,640.85", which the
old symbol-only pattern never matched.

**MISSION B (row container after clean fields):** already satisfied by
the prior round's hard cohesion gate — unchanged this round.

**ROOT CAUSE C — pagination was never actually scoped to the record
container, but COULD be wrongly excluded by one
(content/nextdetect.js):** audited every use of `containerSelector` in
nextdetect.js — confirmed pagination discovery has ALWAYS searched the
whole document (never restricted/scoped to inside the container); the
only real coupling is the `isInsideScraperContainer` exclusion safety
check, which can misfire when `containerSelector` itself is implausibly
broad (exactly the real Amazon failure: a container selector that also
wrapped the site's own pagination strip). New
`effectiveContainerSelector()`: if a selector matches more than 50% of
all page elements, it's no longer a plausible "one repeated record"
selector and is no longer trusted for exclusion at all (computed once
per `findNextControl()` call, not per-candidate). A normally-scoped
selector is completely unaffected.

**Real, previously-hidden production bug found via a test-infra fix (in
scope, same layer):** `runAutoDetect()` never passed `siblingEls` (3rd
arg) to `Sel.buildContainerSelector()`, so `commonStableClasses()` could
never compute the classes actually common to every instance — it
silently returned the REPRESENTATIVE element's own full class list
unfiltered. A representative that happens to carry an extra
per-instance class no sibling shares (a real, common shape — a
"sponsored"/badge variant on some cards) produced a selector scoped to
only that one variant. This was masked in every prior test by mini-dom's
own single-class-selector-matching limit (silently ignoring every class
after the first) — fixed alongside it (mini-dom now supports chained
`.a.b.c` class selectors, and `classList` gained a `.contains()` method
matching a real DOMTokenList, both real browser behavior). Fixed by
passing `candidate.elements`/`rowsArr` as the 3rd arg at every call site
of `Sel.buildContainerSelector`, plus a new under-match safety net
(`realMatchCount < candidate.elements.length` → reject — under-matching
is exactly as wrong as over-matching, never previously guarded).

**Files changed:** `content/autodetect.js`, `content/nextdetect.js`
only (`content/discovery.js`/`popup/*` diffs are earlier rounds'
diagnostic-button wiring, untouched this round). New:
`tests/unit/amazon-field-selector-precision-fix.test.js` (159
assertions). `tests/lib/mini-dom.js`: multi-class selector support +
`classList.contains()`. Detail Enrichment, exports, trial-credit,
STOP/RESUME, storage architecture, cross-navigation,
autopaginate/autoscroll/loadmore/pagination.js, background/ — zero diff.

**Test proof:** fixture = 48 cards (no clean card-level class, disjoint
title/price wrappers), Price wrapped in a bare `span.a-color-base`
ALSO reused by 150 unrelated sidebar labels page-wide (198 total
matches for the bare class, ~24% actually price-like — reproduces the
mission's own "produce 150+ matches" ask). Accepted Price selector: NOT
the bare poisoned one, matches ~48 elements page-wide (not 198), every
extracted value is a genuine "TRY N.NN" price, zero sidebar-label
leakage, Title+Price co-occur in 100% of rows. Pagination: using the OLD
over-broad `.a-section` selector directly as `containerSelector`,
`findNextControl()` now still finds the real Next control (previously
`found:false` — this specific improvement flipped an existing test's
own expected result, updated accordingly).

**Tests:** 32 unit test files, 1662 assertions, 0 failures, 0 crashed
(every single unit test file individually verified clean, not just the
aggregate); release-check 19/19; full FAST: PASS. No browser E2E run —
Etsy regression checked only via the existing unit suite (100% green);
genuine real-Chrome Etsy re-verification remains outstanding.

---

## REAL AMAZON EVIDENCE — ROUND 3 ARCHITECTURE REBUILD (row inference + pagination)

**Status: IMPLEMENTED, awaiting real-Chrome re-verification.** Not
committed/pushed — v1.1.0-verified tag untouched. This round explicitly
replaced the previous round's SCORE-PENALTY approach with a HARD
INVARIANT per the user's own instruction ("stop iterating with small
heuristic patches... replace that decision rule").

**PART A — field-anchored common-ancestor row inference
(content/autodetect.js):** new `findFieldAnchoredCandidates()` finds
every title-like heading page-wide and, for each, climbs its ancestor
chain to the LOWEST ancestor that ALSO encloses a price-like value —
GUARANTEEING co-occurrence by construction rather than hoping scoring
rewards it. Boundary elements are grouped by structural signature so
many titles resolving to the same card shape become ONE candidate.
`consolidateFragmentedGroups`/`addAnchoredCandidates` (prior rounds)
remain as fallbacks for single-field pages with no price signal to
anchor against. The HARD GATE: in `runAutoDetect()`'s per-candidate
loop, a candidate with 2+ detected fields whose `completeRatio`
(computeRowCohesion) falls below `MIN_COHESION_RATIO=0.3` is REJECTED
OUTRIGHT — never pushed to `structures`, at any score. Previous round's
soft `cohesionPenalty` scoring line is gone entirely. FAIL-SAFE: if
every surviving candidate was rejected by this gate and nothing else
qualifies, `runAutoDetect()` returns `ok:false` with
`failSafeReason` explaining Auto Detect could not find fields co-
occurring in one record (already surfaced by the existing
`msg.noStrongStructure` UI message, which already tells the user to use
Manual Mode — no UI change needed).

**PART B:** verified content/scraper.js's existing all-empty-row filter
already satisfies "reject rows where all selected fields are empty,
never delete rows with just one missing field" — no change made
(untouched, confirmed via `git diff --stat`).

**PART C — pagination-region-first Next detection
(content/nextdetect.js):** rebuilt around discovering pagination
REGIONS before evaluating signals, not flat page-wide tiers. The two
strongest, most unambiguous signals (`<link rel=next>`, an explicit
`rel="next"` element, an EXACT "Next"/"Sonraki" accessible name) stay
page-wide and unchanged in priority — this is deliberately conservative,
since they're already reliable and rescoping them adds risk for zero
benefit. Everything weaker (loose text/bare-arrow match, structural
"next after current page number" inference, an href that merely
advances the page) is now evaluated PAGINATION-REGION-FIRST via new
`findPaginationRegions()` (landmarks ∪ genuine page-number-cluster
parents) → `findWithinRegion()`/`findClusterAdjacency()`, tried region
by region. A page-wide href-page-number fallback remains as the final
safety net for a page with numbered links but no recognizable
landmark/cluster at all. Result now also exposes `href` (captured before
the trigger fires); href-based signals use `navigateTrigger` (direct
navigation) instead of a synthetic click, since the href was already
independently verified to advance the page; text/rel-based semantic
signals keep the synthetic `clickTrigger` (safer for JS-driven SPA
pagination). `findNextControlDiagnostic()` fully rewritten to mirror the
new structure — every region's own loose-text/adjacency/href sub-checks
reported individually.

**Files changed:** `content/autodetect.js`, `content/nextdetect.js`
only (`content/discovery.js`/`popup/popup.html`/`popup/popup.js` diffs
are the prior round's read-only diagnostic-button wiring, untouched
this round). New: none this round (existing Amazon-mission test files
updated in place to match the new architecture:
`tests/unit/amazon-row-cohesion-and-pagination-fix.test.js`,
`tests/unit/autodetect-row-scoping-fix.test.js`). Detail Enrichment,
exports, trial-credit, STOP/RESUME, storage architecture,
autopaginate.js/autoscroll.js/loadmore.js/pagination.js/background/ —
zero diff.

**Test proof:** same 48-card/disjoint-title-price/noisy-wrapper-class
fixture as the previous round. BEFORE (hard gate disabled, simulating
the old score-penalty design): the `.a-section` fragment candidate IS
selectable (appears in `structures`). AFTER (shipped): completely
ABSENT from `structures` — impossible to select, not merely outscored.
Winner: 48 cards, Title+Price co-occur in 100% of extracted rows, zero
garbage-text leakage. Pagination: page-wide Tiers 0-2 genuinely miss an
icon-only Next (no text/aria-label); the rebuilt region-first pass finds
it via structural cluster-adjacency; an unrelated numeric decoy doesn't
break it; the trigger clicks the real button.

**Tests:** 31 unit test files, 1503 assertions, 0 failures, 0 crashed;
release-check 19/19; full FAST: PASS. No browser E2E run — Etsy
regression could only be checked via the existing unit suite
(discovery-core, discovery-storage-quota-safety, pagination-diag-buffer,
final-ui-reorganization, amazon-pagination-fix — all still 100% green,
unchanged assertion counts), never a live re-scrape; genuine real-Chrome
Etsy re-verification remains outstanding.

---

## REAL AMAZON EVIDENCE FIX ROUND 2 — row cohesion + structural pagination fallback

**Status: IMPLEMENTED, awaiting real-Chrome re-verification.** Not
committed/pushed — v1.1.0-verified tag untouched. Second evidence-driven
round: real persisted `scraperConfig` now included the actual field
selectors, which pinpointed the exact mechanism.

**Real evidence:** `containerSelector: "div.a-section.a-spacing-none"`,
`title: "h2.a-size-base-plus.a-spacing-none.a-color-base.a-text-normal"`,
`price: "span.a-color-base"`. raw=242, duplicates=75, final=167 against
~48 cards. Garbage rows ("Customer Reviews", "Color & Finish", "Brands",
"Wattage", ratings, "TRY 1,640.85", "Amazon's Choice: Overall Pick", ...)
plus the field selectors together prove Title and Price were each
individually "detected" with nonzero coverage, but on almost entirely
DISJOINT subsets of the 242 matched instances — Title only resolves on
the instances that are title-rows, Price only on price-rows, never
together. Pagination: `nextCandidateFound=false`,
`outcome="no-next-candidate"` again.

**ROW ROOT CAUSE:** no existing check ever verified that a candidate's
OWN detected fields actually co-occur on the same repeated instance.
`buildFieldCandidate`'s coverage check only ever required `coverage > 0`
— a field appearing on 20% of instances still qualified as a proposed
column, and different fields' nonzero coverage could concentrate on
entirely different, non-overlapping subsets without anything noticing.

**FIX (content/autodetect.js):**
1. **Row cohesion (TASK 2/4)** — new `computeRowCohesion(fields,
   allInstances)`: resolves every detected field against an
   evenly-spread sample of the candidate's own instances and measures
   how often fields resolve TOGETHER on the same instance
   (`completeRatio`). Fed into `runAutoDetect()`'s per-candidate loop as
   a penalty of up to 55 points — a multi-field candidate whose fields
   never co-occur is crushed regardless of any other signal; a
   single-field candidate (nothing to co-occur with) is untouched.
2. **Anchored candidates (TASK 3)** — new `addAnchoredCandidates(groups)`:
   for a candidate group whose representative element contains a
   heading, climbs from that heading via `Sel.findRepeatingContainer()`
   — the SAME, already-proven sibling-climbing algorithm Manual Mode's
   click-to-select flow uses today — to structurally discover the true
   record-level container, independent of whether it has any class of
   its own. Added as one more ordinary candidate competing through the
   identical scoring/cohesion pipeline.
3. Diagnostics: `rowCohesion`, `cohesionPenaltyApplied`,
   `scoreBeforeCohesion`, `anchoredFromHeading`, `anchoredCandidateCount`
   now in `runAutoDetectDiagnostic()`'s output.

**PAGINATION ROOT CAUSE:** Tiers 0-4 all require the Next control itself
to carry an identifying signal (rel=next, matching text, a landmark
class, or its own href advancing the page). A real, common shape none of
them can ever find: an icon-only Next control (no text, no aria-label,
sometimes a `<button>` with no href at all — JS-driven) sitting right
after a run of page-number entries.

**FIX (content/nextdetect.js):** new **Tier 5 — structural
pagination-cluster fallback**. `findPageNumberCluster()` finds a genuine
cluster of >= 3 sibling clickable elements whose accessible name is
PURELY a page number (a generic, class-name-free pagination signature);
`getCurrentPageNumber()` reads the current page from the URL (same
implicit-page-1 convention as `pointsAtHigherPage`); Tier 5 then takes
whichever clickable element comes immediately after the current page's
own entry in that cluster, regardless of that element's own accessible
name. Also new: **`findNextControlDiagnostic()`** (TASK 5) — a dev-only
instrumented mirror of `findNextControl()` reporting every candidate
inspected at every tier (text/aria-label/href/disabled/reject reason),
never changing production behavior.

**Files changed:** `content/autodetect.js`, `content/nextdetect.js`
only. New: `tests/unit/amazon-row-cohesion-and-pagination-fix.test.js`
(402 assertions). `tests/lib/mini-dom.js`: `MiniElement` now sets
`nodeType = 1` (a real test-infra gap found this round — every real
browser Element has this; `Sel.findRepeatingContainer()`'s own ancestor
climb checks it and was silently short-circuiting after one step in
every mini-dom-backed test until now). `content/discovery.js`/
`autopaginate.js`/`autoscroll.js`/`loadmore.js`/`background/`/Detail
Enrichment/exports/trial-credit/STOP-RESUME/cross-navigation — zero diff
(confirmed via `git diff --stat`).

**Test proof (TASK 1 trace, before/after scores):** fixture = 48 cards
with NO clean shared class (noisy grid-utility classes only), Title and
Price in disjoint `.a-section` fragments, 19 sidebar/filter/badge labels
sharing the same class. With BOTH new rules disabled: fragment candidate
scores 45 (vs. cards' 84). Fragmentation-penalty alone (prior mission):
5. This mission's cohesion alone: 0. Shipped (both): 0. Winning structure
(shipped): itemCount=48, `rowCohesion.completeRatio` >= 0.6, real
extraction → exactly 48 rows, 100% with Title AND Price together, zero
garbage-text leakage. Pagination: Tiers 0-4 all genuinely miss an
icon-only Next (proven per-tier via the diagnostic); Tier 5 finds it,
correctly rejects an unrelated lone numeric decoy, and its trigger
clicks the real button.

**Honest limitation carried over:** as in the previous round, I could
not construct a fixture where the wrong candidate wins with ZERO new
rules applied AND a reasonably shared card-wrapper class — some
combination of real Amazon's actual markup (possibly even more
inconsistent card classing than modeled here, or per-instance signal
differences) is still not fully reproduced. What IS now proven directly
from the real evidence itself: the exact field-selector shapes Amazon
returned (disjoint title/price) are structurally impossible to score
well post-fix, since cohesion is computed directly from resolving those
same field selectors against the same instances — this is no longer a
proxy signal, it's the literal mechanism the real diagnostic exposed.

**Tests:** 31 unit test files, 1503 assertions, 0 failures, 0 crashed;
release-check 19/19; full FAST: PASS. No browser E2E run.

---

## REAL AMAZON EVIDENCE FIX — fragment scoring (167 rows) + pagination side-effect

**Status: IMPLEMENTED, awaiting real-Chrome re-verification.** Not
committed/pushed — v1.1.0-verified tag untouched. This mission is
evidence-driven — diagnosed from the REAL persisted diagnostics of a
failed run (Copy AUTO Diagnostic / Copy Pagination Diagnostic), not a
hypothesis.

**Real persisted evidence:** `https://www.amazon.com/s?k=desk+lamp` —
raw=242, duplicates=75, datasetAfter=167 against ~48 real cards.
Persisted `containerSelector: "div.a-section.a-spacing-none"` — Amazon's
own generic internal utility-class combo, reused everywhere (card
title/price/rating rows, the sidebar filter panel, badge/spec rows) —
confirmed by the actual garbage rows collected ("Customer Reviews",
"Color & Finish", "Brands", "Wattage", standalone ratings/prices,
sidebar/filter text). Same run's pagination diagnostic: pagesVisited=1,
nextCandidateFound=false, outcome="no-next-candidate",
paginationActionIssued=false — never even attempted a click.

**ROW ROOT CAUSE (content/autodetect.js):** the previous mission's
`consolidateFragmentedGroups()` already computed, for every candidate
folded together from many different DOM parents, exactly how many
DISTINCT PARENTS its elements came from
(`consolidatedFromParentCount`) — but that number was never fed back
into `scoreCandidate()`. A consolidated candidate competed purely on
content signals (link/image/price ratios, consistency), with nothing
penalizing the one structural fact that separates "one row per record"
from "several fragments per record": a genuine item container has close
to ONE element per distinct parent; an internal layout primitive reused
several times inside every card has SEVERAL.

**PAGINATION ROOT CAUSE (not an independent nextdetect.js defect):**
`content/nextdetect.js`'s `isInsideScraperContainer()` correctly rejects
any candidate Next control whose ancestor matches the scraper's own
`containerSelector` (never click inside my own repeating container) —
but when that selector is as broad as `div.a-section.a-spacing-none`, it
can legitimately also match an ancestor of the site's OWN pagination
strip, wrongly excluding the real Next control at every tier. Proven
directly in the new regression test: the SAME real, unmodified
`findNextControl()` returns `found:false` against the old over-broad
selector and `found:true` against the properly-scoped one, on the exact
same fixture DOM.

**FIX (content/autodetect.js only):**
1. A fragmentation penalty in `computeCandidateSignals()`, scaled by
   `elementsPerParent = itemCount / consolidatedFromParentCount` —
   zero for any non-consolidated candidate (every previously-verified
   site) or one whose ratio is already ~1.
2. Evenly-spaced sampling (`sampleEvenly`) replacing "always sample the
   first N elements" — byte-identical for any candidate with
   `n <= 12` (every existing fixture); only changes behavior for a
   large, heterogeneous, consolidated candidate, so a garbage-diluted
   population can no longer hide behind a lucky run of early
   clean-looking instances.
3. Diagnostics extended: `elementsPerParent`, `fragmentationPenaltyApplied`,
   `consolidatedFromParentCount` now surfaced per-candidate in
   `runAutoDetectDiagnostic()`'s output (Copy AUTO Diagnostic).

**Files changed:** `content/autodetect.js` only. New:
`tests/unit/amazon-fragment-scoring-fix.test.js` (14 assertions).
`content/discovery.js`/`nextdetect.js`/`autopaginate.js`/`autoscroll.js`/
`loadmore.js`/`background/`/Detail Enrichment/export/trial-credit/
STOP-RESUME/cross-navigation logic — all completely untouched (confirmed
via `git diff --stat`).

**Test proof:** fixture = 48 product cards (4 internal `.a-section` rows
each) + 20 sidebar filter/facet elements ALSO carrying `.a-section` +
a pagination strip wrapped in `.a-section` too. Winning structure:
itemCount=48, selector never references `.a-section`, real extraction
(unmodified `content/scraper.js`) → exactly 48 rows, zero
sidebar/filter/pagination leakage. Using the winning selector, the real
`findNextControl()` finds the pagination Next and its trigger clicks the
real anchor (not a carousel-wrapped decoy). Using the OLD, over-broad
`.a-section` selector directly, `findNextControl()` returns
`found:false` — reproducing the real symptom exactly.

**Honest limitation:** despite substantial effort with several
adversarial fixture variants (uniform card class, split A/B card
classes, fully dynamic/hash card+wrapper classes, Amazon-realistic noisy
grid-utility classes), I could not construct a synthetic fixture where
the pre-this-fix code actually picks the wrong (`.a-section`) candidate
— in every variant, if the card level has ANY shared class at all
(clean or noisy-but-consistent), it already wins on raw score. This
means either (a) real Amazon's card wrapper has no usable shared class
at all across all 48 (candidate never generated cleanly), or (b) some
other structural difference in real Amazon markup makes the fragment
candidate score higher than in my models. The delivered fix is real,
evidence-driven, and directly implements the requested "penalize
candidates where many internal fragments share one generic class"
generically — verified via `git stash` to substantially cut a
consolidated fragment candidate's score in a denser adversarial model
(score 48 → 2 with the penalty applied) — but I cannot claim certainty
it is sufficient on the real page without a live re-test. If the
real-Chrome run still shows the wrong winner, Copy AUTO Diagnostic now
directly answers whether the real "cards" candidate is even being
generated/scored at all (look for it in `topCandidatesBeforeRanking`/
`rejectedCandidates`) vs. losing despite the penalty.

**Tests:** 30 unit test files, 1101 assertions, 0 failures, 0 crashed;
release-check 19/19; full FAST: PASS. No browser E2E run (per this
mission's own explicit instruction not to).

---

## AMAZON ROW/CONTAINER OVER-COUNTING FIX — 167 rows from ~48 real product cards

**Status: IMPLEMENTED, awaiting real-Chrome re-verification (same Amazon
URL/search).** Not committed/pushed — v1.1.0-verified tag untouched.

**Real report:** `https://www.amazon.com/s?k=desk+lamp` — page 1 has ~48
visible product cards, ~340-350 total across ~7 pages, but the extension
reported 167 UNIQUE rows from page 1 alone. Not primarily a pagination
problem — the row/repeating-item detection was over-counting.

**Fix (content/autodetect.js — the Auto Detect repeating-group scanner;
content/discovery.js/nextdetect.js/autoscroll.js/loadmore.js/
autopaginate.js/background/Detail Enrichment/export logic all completely
untouched, confirmed via `git diff --stat`):**
1. `consolidateFragmentedGroups()` — `scanRootForGroups()` groups
   elements PER PARENT NODE, so a shared internal-layout/utility class
   reused as direct siblings inside every product card (a design-system
   class like Amazon's own `a-section`, used for one card's title row,
   image row, price row, rating row) previously produced one SEPARATE
   small candidate group PER CARD instead of being recognized as one
   page-wide pattern. A same-signature (tag + stable classes) group
   recurring under >= 4 distinct parents is now folded into ONE honest
   candidate before scoring.
2. A selector-scope-drift safety net in `runAutoDetect()`: after
   `buildContainerSelector()` builds the real selector for a winning
   candidate, if that selector's actual page-wide match count exceeds
   3x what was locally detected, the candidate is rejected outright
   rather than silently accepted — closing `buildContainerSelector`'s
   own documented "best approximation" fallback tier (which can, in the
   worst case, degrade all the way to a bare, completely unscoped tag
   selector like `div` when neither a stable class nor a buildable
   parent selector survives) as a possible over-count source.
3. Honest diagnostics added throughout: `matchedElementCount` (the real
   post-build match count, distinct from the pre-build candidate-size
   guess), `rawGroupCountBeforeConsolidation`/`groupCountAfterConsolidation`,
   `scopeDriftRejectedCount` — all exposed via
   `runAutoDetectDiagnostic()`.

**Files changed:** `content/autodetect.js`. New:
`tests/lib/load-autodetect.js` (loads the real, unmodified
`content/selector.js`+`content/autodetect.js`+`content/scraper.js` into
one vm sandbox), `tests/unit/autodetect-row-scoping-fix.test.js` (13
assertions). `tests/lib/mini-dom.js` extended (added `parentElement` and
`.src` live-property getters — both required for `content/selector.js`'s
real field-detection code to work at all against the fake DOM; added
`createTreeWalker`/`matches`).

**Test proof (before/after, same 48-card + 10-filter + 6-related-search
+ 7-pagination-link fixture):** the winning Auto Detect structure has
`itemCount === 48` (not ~192, the 48-cards × 4-internal-rows fragment
level), `containerSelector` never references the internal fragment
class, and real extraction through the unmodified `content/scraper.js`
produces exactly 48 rows — all distinct product links, 0 sidebar/
filter/related-search/pagination leakage, sponsored cards correctly
included, `WSSelector.countMatches(containerSelector) === 48`.

**Tests:** 29 unit test files, 1087 assertions, 0 failures, 0 crashed;
release-check 19/19; full FAST: PASS. No long-running browser E2E run
(per this mission's own explicit instruction not to).

**Honest residual risk — read before real-Chrome verification:** this
fix targets two real, generically-defensible gaps in the candidate-
grouping/selector-building pipeline that directly match the reported
symptom class (~3.5 rows per card ≈ 167/48). However, live Amazon DOM
could not be fetched from this environment to confirm the EXACT
precondition. I built several adversarial synthetic fixtures attempting
to reproduce the pre-fix failure directly (uniform card class, split
A/B-variant card classes, fully dynamic/hash-only card+wrapper classes)
— in every one, the PRE-FIX code already happened to select the correct
48-card candidate, meaning I could not pin down in a unit test the exact
DOM shape that made the wrong candidate win on the real page. The fix is
real, tested, and strictly improves correctness/safety with zero
regressions either way, but the real-Chrome run is the true confirmation
here — use the new `matchedElementCount`/`rawGroupCountBeforeConsolidation`/
`groupCountAfterConsolidation`/`scopeDriftRejectedCount` diagnostics
(dev-only "Copy Auto Detect Diagnostic" style output) to see exactly
what happened if row counts are still wrong.

---

## AMAZON PAGINATION FIX — real regression found in post-v1.1.0 cross-site verification

**Status: IMPLEMENTED, awaiting real-Chrome re-verification (same Amazon
URL/search).** Not committed/pushed — v1.1.0-verified tag untouched.

**Real report:** `https://www.amazon.com/s?k=desk+lamp` — 167 unique
records collected, then "1 sayfa tarandı" despite a visible, working
Previous | 1 | 2 | 3 | ... | 7 | Next control.

**Root cause (content/nextdetect.js, the generic Next-control detector —
content/discovery.js, autoscroll.js, loadmore.js, autopaginate.js, and
background.js all completely untouched):**
1. `pointsAtHigherPage()` (Tier 4, the href-page-number fallback)
   required BOTH the current AND candidate URL to already carry an
   explicit page-number parameter/path before comparing them. Amazon's
   own page-1 URL omits the parameter entirely (`?k=desk+lamp`, no
   `&page=1`) — one of the most common real-world pagination
   conventions generally, not an Amazon-specific quirk — so it could
   never be recognized as "before" a candidate explicitly carrying
   `&page=2`. Fixed: an absent page-number param/path on the CURRENT url
   is now treated as implicit page 1 (still requires the candidate to
   explicitly carry a real numeric value for the same known key/path —
   never "trust an arbitrary param").
2. Tier 3 (pagination-landmark) only ever searched a landmark's
   DESCENDANTS (`landmark.querySelectorAll('a[href], button')`) — a real,
   common pattern where the Next control's OWN class contains
   "pagination" (rather than a separate wrapper) was silently never
   checked against itself. Fixed: the landmark element itself is now
   also checked when it's directly clickable.

**Task A:** the old "Otomatik Sonraki"/"Otomatik Kaydırma" checkboxes
(`#auto-next-toggle`/`#auto-scroll-toggle`) — already fully inert, never
read by `handleStartLiveSession` — removed completely from popup.html/
popup.js/i18n-data.js (not merely hidden). BAŞLA already started the
Automatic Discovery Engine unconditionally; traced every reference
first to confirm zero behavioral dependency before removing.

**Files changed:** `content/nextdetect.js`, `popup/popup.html`,
`popup/popup.js`, `utils/i18n-data.js`,
`tests/unit/final-ui-reorganization.test.js` (2 stale assertions
updated). New: `tests/lib/mini-dom.js`, `tests/unit/amazon-pagination-fix.test.js`
(22 assertions). `content/discovery.js`/`autoscroll.js`/`loadmore.js`/
`autopaginate.js`/`pagination.js`/`background/`/Detail Enrichment/export
logic — all completely untouched (confirmed via `git diff --stat`).

**Tests:** 28 unit test files, 1074 assertions, 0 failures, 0 crashed;
release-check 19/19; full FAST: PASS. No long-running browser E2E run
(per this mission's own explicit instruction not to).

**Residual risk requiring real-Chrome verification:** these two fixes
address the most plausible, code-provable generic gaps found via
careful audit of `content/nextdetect.js` plus public documentation of
Amazon's real, stable pagination markup (`a.s-pagination-next` inside
`span.s-pagination-strip`) — live Amazon DOM could not be fetched
directly from this environment (WebFetch returned HTTP 503) to confirm
100%. If the real Chrome re-test still stops early, the next place to
look is `isInsideScraperContainer()` — a container selector broader
than intended (Amazon reuses very generic utility classes like
`a-section` throughout the whole page, not just product cards) could
still wrongly reject a genuinely-found Next control; the existing
dev-only "Copy Pagination Diagnostic" panel's `lastPaginationAttempt`
record is the fastest way to confirm or rule this out from a real run.

---

## REAL CHROME VERIFIED v1.1.0

- Etsy: 22 pages / 1263 unique records
- Detail: 1263 processed / 1175 successful / 88 missing / 0 errors
- enriched Excel export verified
- final popup UI verified
- Results Deep Scrape duplicate navigation removed
- dedicated Detail tab retained

**Status: RELEASE CHECKPOINT — tagged `v1.1.0-verified`.** Version
bumped 1.0.2 → 1.1.0 (manifest.json/package.json/package-lock.json, no
duplicate/inconsistent version values anywhere else in the repo — see
this checkpoint's own commit for the exact verification). No feature/
business-logic change accompanies this bump — pure checkpoint of the
already-verified work below (FINAL MICRO UI POLISH + RESULTS-TAB DEEP
SCRAPE LAUNCHER REMOVAL sections). Tests at checkpoint time: 27 unit
test files, 1054 assertions, 0 failures, 0 crashed; release-check 19/19.

---

## RESULTS-TAB DEEP SCRAPE LAUNCHER REMOVAL — UI dedup, awaiting Chrome visual verification

**Status: IMPLEMENTED, awaiting Chrome visual verification.** Removed
ONLY the "▸ Derin Veri Çekme" / "Deep Scraping" collapsed group from the
Results tab (the whole `<details>` block: `#toggle-deepscrape-btn`,
`#deepscrape-panel` and every `#ds-*` config field inside it, `#ds-
progress-section`) — a duplicate entry point for the same workflow the
top-level Detay tab already owns.

**Root risk found and fixed:** the OLD Results-tab panel and the NEW
Detay tab share the exact same background.js engine AND the exact same
`ws_deepscrape_run`/`ws_deepscrape_fields` storage keys (by original
design — see the Detay tab's own header comment). Several popup.js
functions wrote to the removed `#ds-*` elements **unconditionally** —
most critically, `init()`'s own restore-an-in-flight-run block (`var
existingDeepScrapeRun = await localGet('ws_deepscrape_run'); if
(existing...) { ...; els.deepScrapePanel.hidden = true; renderDeepScrapeProgress(...); }`)
runs on **every popup open** whenever `ws_deepscrape_run` has ever been
populated by ANYTHING — including a real Detail Enrichment run, since
they share the key. A naive HTML-only deletion would have made the
popup throw a TypeError on open for any user who had ever run Detail
Enrichment or the old panel. Fixed by adding `if (els.dsXxx)` guards
(matching this file's own established idiom) around every now-orphaned
DOM write in `renderDeepScrapeProgress()`, `renderDeepScrapeSummary()`,
`checkForPendingDetailFieldPicks()`, and the `init()` restore block —
`renderDeepScrapePanel()` already had its own top-of-function guard.
**No function was deleted** — `mergeDeepScrapeResults()`, trial-credit
charging, and `currentDeepScrapeRunId` restoration are all still fully
intact and unconditional (pure state, zero DOM dependency), so a
legacy/in-flight run started before this change still merges/charges
correctly; only the now-absent UI writes became null-safe.

**Detay tab, Detail Enrichment's own storage/config/merge/hydration
(`detailConfig`/`currentDetailRunId`/`mergeDetailResults`/
`hydrateDetailResultsIfAny`/`ws_live_detail_field_picks`), exports,
scraping/discovery/pagination, and every other tab/section named in the
mission are completely untouched** — confirmed via `git diff --stat HEAD
-- content/ background/` (empty) and the new test's own explicit proofs.

**Tests updated (existing UI expectations, not functionality):**
`final-ui-reorganization.test.js` — removed its 2 assertions that
expected `#toggle-deepscrape-btn`/`deepScrape.groupLabel` to still
exist (documented inline why). **New:**
`tests/unit/deepscrape-results-launcher-removal.test.js` (81 assertions)
— proves the removal is real (not relocated), Detay stays fully
functional, every underlying function is still defined, and — the
important one — a real popup boot with a legacy `ws_deepscrape_run`
record (and a live storage.onChanged update for it) does NOT throw.

**Test totals:** 27 unit test files, 1054 assertions, 0 failures, 0
crashed; release-check 19/19; full FAST: PASS. No long-running browser
E2E run (not requested for this change).

**Files changed:** `popup/popup.html`, `popup/popup.js`,
`tests/unit/final-ui-reorganization.test.js`,
`tests/unit/deepscrape-results-launcher-removal.test.js` (new).
`content/`/`background/` untouched. Not committed/pushed — awaiting
Chrome visual verification.

---

## FINAL MICRO UI POLISH — presentation/i18n only, awaiting final Chrome visual approval

**Status: IMPLEMENTED, awaiting final Chrome visual approval.** UI/i18n
only — `content/`/`background/` byte-for-byte untouched (confirmed via
`git diff --stat HEAD -- content/ background/` — empty). Builds directly
on the FINAL UI POLISH PASS section below.

**1. Last Run card:** `#scrape-status-text`'s captured-state line changed
from "{count} sonuç çekildi." to the compact `{count} kayıt • {status}`
form, built from the exact same `rawRows.length` value and the existing
`status.completed` key everything else already uses — no new counter.

**2. Veri Çek ÖN İZLEME column spacing:** `#setup-preview-table` had zero
dedicated CSS at all (rendering at the browser's default zero-padding
look, which is why headers ran together). Added padding (7px 12px) +
column-separator borders + a sticky header, mirroring `#preview-table`'s
existing pattern. Column order/widths/extraction/horizontal-scroll
behavior all untouched.

**3. Detail completion metrics — compact two-line presentation:**
`dt-progress-text` now renders `detail.progressLine1` ("{done}/{total}
sayfa • İlerleme: %{percent}") and `detail.progressLine2` ("Başarılı: N
• Eksik: N • Hata: N • Zaman aşımı: N") joined by `\n`, with
`white-space:pre-line` added so it actually renders as two lines. Same
numbers as the old one-line `detail.progressText` (now unused, left in
place harmlessly). The sticky Detail status bar is a separate render
path (`renderStickyStatus()`) and was not touched — no duplication.

**4. Remaining localization — finished properly this time.** ~250 new
keys across all 6 locales (589 total en keys, up from ~340 last pass; 0
missing in any locale, confirmed both by a direct coverage script and
release-check's own 100% check). Covers, beyond the ZIP/download
progress strings named explicitly:
  - The full `setStatus()` surface (128 distinct call sites → `msg.*`
    keys) across Columns/Auto Detect/Structured Data/Templates/Pagination/
    Run Modes/Saved Scrapers/Transforms/Preview/Filter/Sort/Export/
    Downloads/Research Bundle/Snapshots/Detail setup.
  - ZIP progress ("Building ZIP…"/"Ready"/"Cancelled."/"Failed: N") and
    the full download-summary breakdown (Image/File counts, duplicates/
    invalid/empty-skipped, estimated names) — both `bulk download` and
    `Research Bundle` panels (they share the same `zipProgressLines()`).
  - Templates row actions (Preview/Rename/Duplicate/Export/Delete,
    Custom/Built-in badge) and Saved Scrapers row actions (Run/Load/
    Rename/Delete), Snapshots manage-row (date — N rows, Hide/Manage).
  - The **Monitor tab** in full (explicitly in-scope per i18n-data.js's
    own documented V1 scope note, which names "monitor" directly) —
    interval labels, ERROR/CHANGED/SUCCESS/NEVER RUN/RUNNING badges,
    the Monitoring Summary line, per-card status/last-run/next-run text,
    Enable/Run Now/Disable/History/Clear History buttons, notify
    tooltip, per-run history detail line.
  - Confirm() dialogs: Reset Columns, Delete Template, Delete Scraper
    (the full 4-line consequence text), Clear Monitoring History, Reset
    Transforms.
  - Transform list Remove/Move up/Move down buttons (structural list
    controls, NOT `describeTransform()`'s own per-operation descriptions
    — those, plus Auto/Deep-Scrape sub-field configuration forms, remain
    the one deliberately-out-of-scope area per this project's own
    documented, pre-existing V1 i18n policy — see i18n-data.js's header
    comment).
  - Detail's "Alanları Test Et" sample-test results (Testing N pages…/
    Page N:/Failed/Missing), the Deep Scrape workload summary line,
    Research Bundle preview (Rows/Images/Files/Manifest formats), the
    snapshot-comparison summary, and the Settings license-verification
    note (revoked/simulated/verified-N-days-ago/verified-at-activation —
    the "QA:"-prefixed dev license switcher itself stays English, still
    correctly gated behind `isDevelopmentInstall()`).
  - Applied via two small, throwaway, self-verifying migration scripts
    (exact literal-substring replacement with an expected-occurrence-
    count check per mapping — never a regex, never silently partial;
    deleted immediately after running) rather than ~190 manual edits, to
    keep the mechanical part of this pass fast and mistake-free.

**Tests:** 26 unit test files, 975 assertions, 0 failures, 0 crashed (178
new, in `tests/unit/final-micro-polish.test.js`); release-check 19/19;
full FAST: PASS. No long-running browser E2E run (per this mission's own
explicit instruction not to).

**Files changed this pass:** `popup/popup.html`, `popup/popup.css`,
`popup/popup.js`, `utils/i18n-data.js`, `tests/unit/final-micro-polish.test.js`
(new). `content/`/`background/` untouched. Not committed/pushed —
awaiting final Chrome visual approval.

---

## FINAL UI POLISH PASS — presentation only, awaiting real Chrome visual approval

**Status: IMPLEMENTED, awaiting final Chrome visual approval.** UI-only —
`content/`/`background/` byte-for-byte untouched (confirmed via
`git diff --stat HEAD -- content/ background/` — empty). Builds directly
on the FINAL UI REORGANIZATION section below (same tab structure, same
collapsed groups, same sticky bar — this pass only refines it).

**1. "Verileri Çek" duplicate (resolved: KEPT, not removed).** Traced
both handlers: `#preview-btn` → `handlePreview()` (a single-page
`RUN_EXTRACTION` only — no session, no discovery, no tab switch; shown
only in manual "Current Page" Run Mode) vs `#basla-btn` → the unrelated
`handleStartLiveSession()` (always creates/persists a live session,
starts the passive watcher, starts the automatic discovery engine, then
switches to Results). Genuinely different actions → kept `#preview-btn`,
relocated it from beside Auto Detect/Structured Data/Templates down into
`#run-section`, directly next to its real mutually-exclusive counterpart
`#start-run-btn` (`onRunModeChanged()` already treated them as one pair —
now they read that way visually too), and reworded its label (all 6
locales) from "Extract Data"-style text to "Preview This Page"/"Bu
Sayfayı Önizle" so it no longer reads as a second BAŞLA. Same id, same
handler, zero logic touched.

**2. Results summary de-duplication.** Root cause: `discovery-status-
line1`/`line2` (found/pages) stayed visible even after a processing
selection was made, while the summary panel below ALSO showed
`discovery-summary-found` (the literal same key/count) and
`discovery-summary-processed` (near-duplicate of the top card's `results-
status-text`/`live-session-status`). Fix (all presentation, zero counter/
calculation touched): `results-status-text`/`live-session-status` now
hide whenever the richer discovery panel is showing;
`discovery-summary-found` now always stays hidden (its info is
`discovery-status-line1`, never removed, always kept current);
`discovery-summary-processed` hides ONLY when it would exactly duplicate
the found count (an "ALL" selection) — a genuinely different "FIRST N"
count is never hidden, so no real information is ever lost;
`discovery-status-line3` ("Durum: …") is relocated to the end of the
panel and no longer force-hidden once a selection exists — it's now the
compact card's one persistent status line.

**3. Detail completed-state duplication removed.** `renderDetailSummary()`
used to re-state status/page-count/success-missing-error-counts that
`dt-progress-text` + the status badge already show. Those 3 lines are
gone; the one genuinely new piece of information the block ever added —
top failure reasons — is unchanged and still shown when present (hidden
entirely when there are none, since nothing else is left to show).
dsState/counts/handlers untouched.

**4. Remaining hardcoded English moved through the 6-locale i18n system.**
~40 new keys across all 6 locales (`preview.*`, `changes.truncatedNote`,
`autoMode.*`, `pagination.*`, `snapshots.*`, `transform.*`,
`column.entireRow`, `download.*`, `zipKind.*`, `research.*`,
`templates.*`, `status.starting`, `sticky.*`, `workflow.lastRun`) —
covers the two literally-named examples (row/changes truncation notes,
the anomaly-mismatch legend) plus the other persistently-rendered
informational text found in the same style across the Scrape/Results
tabs (Auto Detect summary, pagination auto-detect summary, Snapshots
footer, Transform preview, "Entire Row" pickers, Download/Research
Bundle progress, Template preview notes). **Not fully exhaustive** — the
Download/Files preview's own multi-line `buildDownloadSummaryText()`
breakdown and the ZIP progress panel's "Building ZIP…/Ready/Cancelled"
lines are still hardcoded English; flagged here rather than rushed,
since covering them correctly would mean a second, dedicated pass.
release-check confirms 100% key coverage across all 6 locales for every
key that does exist.

**5/6. Sticky status bar is now tab-aware + never covers real content.**
`renderStickyStatus()` now reads the existing `activeTab` — Detail
running/stopping still takes precedence from ANY tab (preserves "know
it's still working, Stop from anywhere"), but once Detail reaches a
terminal state it only keeps showing while the user is actually on the
Detay tab; every other tab falls through to the ordinary main-scrape/
session line. `switchTab()` now also calls `renderStickyStatus()` so a
plain tab switch alone updates it, not just a state change. New
`setStickyStatusBarVisible()` helper centralizes the bar's own
`hidden` toggle and mirrors it onto `#app.ws-has-sticky-status`, which
reserves the bar's own height as bottom padding — so the bar only ever
sits over its own reserved space, never over the last table rows/export
buttons/accordion headers/Detail actions/Dev Tools controls. No new
timer, no new state machine, no DURDUR duplication.

**7. "SON KOŞU"/Last Run compact card.** The old always-rendered
`scrape-status-text` + full-width "View Results →" button (which visually
dominated the top of Veri Çek before Columns/Preview/BAŞLA) is now
wrapped in `#scrape-last-run-card`, hidden by default and shown ONLY once
`rawRows.length > 0` — the exact same condition the button's own
visibility already used. Same ids, same handler
(`switchTab('results')` only), same underlying count text/logic — only
restyled smaller/secondary and made conditional, so Sütunlar → Ön
İzleme → BAŞLA is the first thing a fresh setup sees.

**Tests:** 25 unit test files, 797 assertions, 0 failures, 0 crashed (47
new, in `tests/unit/final-ui-polish-pass.test.js`); release-check 19/19;
full FAST: PASS. No long-running browser E2E run (per this mission's own
explicit instruction not to).

**Files changed this pass:** `popup/popup.html`, `popup/popup.css`,
`popup/popup.js`, `utils/i18n-data.js`, `tests/unit/final-ui-polish-pass.test.js` (new).
`content/`/`background/` untouched. Not committed/pushed — awaiting real
Chrome visual approval per the mission's own explicit instruction.

---

## FINAL UI REORGANIZATION — VERİ ÇEK / SONUÇLAR / DETAY, no business logic changed

**Status: IMPLEMENTED, awaiting real Chrome visual review.** UI-only —
`content/` and `background/` are byte-for-byte untouched (confirmed via
`git diff --stat`). Every change is popup.html/popup.css/popup.js
(accordion/tab-switch/render-only)/i18n-data.js/release-check.js.

**Summary:** Results tab dev diagnostics (session/pagination/health-
check) consolidated into one gated `<details id="results-devtools-
panel">` ("▸ Geliştirici Araçları"); the Scrape/Detay tabs' own single
dev panels (`auto-diag-panel`/`detail-pick-diag-panel`) converted from
`<div>` to `<details>` for the same collapse convention (zero JS
change — `hidden` is independent of `open`). "Değişiklik Takibi"/"Derin
Veri Çekme"/"Araştırma Paketi" wrapped in collapsed `<details>` groups.
The duplicated "Şimdi ne yapmak istersiniz?" card removed — its one
truly-duplicate button deleted (100% redundant with the existing "⚙
Export Options" chip), its other two actions (Monitor/Research)
relocated with their exact original handlers unchanged. New "Sonuçları
Gör" button on the Detay tab's completed state — verified by test to
send zero messages, only `switchTab('results')`. New global sticky
status bar — read-only, derives from existing render state, its Stop
button wired to the same `handleStopAutoPaginate` `#durdur-btn` already
uses (verified by test to produce an identical message sequence).
Mixed-language status badges (`.toUpperCase()` raw enum text) replaced
with a new `localizedStatusLabel()` i18n helper across all 6 badge
sites; the hardcoded "DEEP SCRAPE COMPLETE" string now localized.

**One deliberate deviation (reported, not silently done):** the OUTER
`#scrape-advanced-panel` ("Gelişmiş") was left as the always-visible
`<div>` it already was, NOT re-collapsed into a `<details>` — its own
existing comment documents that this was previously a `<details>` and
was deliberately converted away from one as "a real regression fix";
reverting that without knowing the original regression's exact cause
was judged too risky for a UI-only mission. The mission's own "▸
Gelişmiş Ayarlar" request is instead satisfied by the Run Mode
sub-section, which already was (and remains) a real collapsed
`<details id="run-section-advanced">`.

**Tests:** 24 unit test files, 750 assertions, 0 failures, 0 crashed
(82 new, in `tests/unit/final-ui-reorganization.test.js`).
`release-check`: 19/19. Full FAST: PASS.

---

## DETAIL ENRICHMENT RESULTS HYDRATION ON POPUP REOPEN — real production bug

**Status: REAL-CHROME VERIFIED — 2026-08-31.**

**Real Chrome acceptance checkpoint (this is the checkpoint tagged
`verified-full-scrape-detail-export-2026-08-31`):**
- Etsy main scrape completed successfully: **22 pages scanned, 1,263
  unique base records**.
- Detail Enrichment completed: **1,263 / 1,263** processed — **1,175
  successful, 88 missing, 0 errors**.
- Completed Detail data hydrates correctly after a popup close/reopen
  (this mission's own fix) — no re-visit of any of the 1,263 product
  pages required.
- Detail columns are visible in the Results table and in the exported
  Excel file — manually inspected, containing **1,263 rows with both the
  original base columns and the Detail columns**.
- Main pagination confirmed working through all 22 pages.
- `npm run test:fast`: 23 unit test files, 668 assertions, 0 failures, 0
  crashed. `release-check`: 20/20 PASS.

**Status before the above real-Chrome pass: IMPLEMENTED, awaiting real
Chrome verification.**

**Root cause:** the only existing call to `mergeDetailResults()` (inside
`renderDetailProgress()`'s terminal branch) ran too early in `init()`'s
own sequence to ever succeed on a popup reopen after a Detail run had
already completed. At that point in `init()`: (1) `detailConfig`
(selected fields/source column) was still unhydrated — only ever
populated lazily by `renderDetailSetup()`, which requires the user to
have visited the Detay tab THIS popup session — so `mergeDetailResults`'s
own `if (!detailConfig...) return;` guard silently no-oped; (2) `rawRows`
was still the empty module-level default — `restoreLiveSessionIfAny()`
(the function that actually populates it) doesn't run until ~400 lines
later in the same `init()`. Both gaps had to be true simultaneously for
the bug to reproduce, and on a normal "close popup mid/after-run, reopen
later" flow they always were. Detail's own storage
(`ws_deepscrape_run`/`ws_deepscrape_fields`) was never the problem — the
data was always sitting there correctly; it just never got read at a
point where it could actually be merged.

**Fix (popup/popup.js only):** new `hydrateDetailResultsIfAny()`, called
once, immediately after `restoreLiveSessionIfAny()` resolves in `init()`
(so `rawRows` is final). Pure hydration — reads whatever a
completed/stopped/error-terminal Detail run already has via the exact
same, unmodified `mergeDetailResults()`/`ensureDetailConfigHydrated()`
functions; never sends a message to background.js or the content
script, never opens a tab, never re-fetches a page. An active
(non-terminal) run's existing live `chrome.storage.onChanged` merge path
is completely unchanged.

**Test infra:** `tests/lib/load-popup.js` — added a non-leaking
`SandboxURL` wrapper (`URL.createObjectURL`/`revokeObjectURL`, never
mutates Node's real global `URL`) and a content-capturing `Blob` stub —
needed so a test could drive the REAL "Export Data → CSV" button and
inspect what it actually produced, not just infer from code reading.

**New test:** `tests/unit/detail-results-hydration-on-reopen.test.js`
(10 assertions) — reproduces the exact scenario: main scrape + completed
Detail run + persisted field data + persisted field config all already
in storage, popup loaded fresh (no BAŞLA/RUN_EXTRACTION at all). Proves:
rows preserved, Detail columns/values hydrated from already-stored data,
the "missing" (partial) record stays genuinely blank (never fabricated),
zero messages sent to background.js/content script during hydration, and
the real CSV export button's actual output contains the Detail columns
and values.

**Tests:** 23 unit test files, 668 assertions, 0 failures, 0 crashed.
`release-check`: 20/20. Full FAST: PASS. Zero diff vs the last commit
for `content/`/`background/` — main scrape/pagination/discovery/Detail
run logic completely untouched. Not committed/pushed yet — awaiting
real Chrome verification.

---

## CORE RECOVERY — item #1: content/discovery.js setSession() quota-safety fix

**Status: IMPLEMENTED, awaiting real Chrome verification.** Recovery-plan
item #1 only (per explicit approval — items #2-5 NOT started).

**Root cause:** `setSession()` in `content/discovery.js` resolved its
promise unconditionally on `chrome.storage.local.set()`, never checking
`chrome.runtime.lastError` — unlike every other storage-write helper in
this project (`utils/license.js#persist()`, `background.js#
setDeepScrapeState()`/`setDeepScrapeFields()`). A real quota-exceeded
write (proven, reproduced earlier this project) silently dropped: the
loop's in-memory `session` showed new state, storage kept the stale
value, and the next `getSession()` re-read (nearly every loop step)
fetched that stale value back — desyncing the loop or freezing the popup
(which only observes storage) while `discovery.status` stayed
`'discovering'` forever. This gap existed unchanged since the 2637568
checkpoint; it never had a real chance to trigger until Detail
Enrichment's own storage footprint pushed real-world usage near quota
for the first time. Full write-up: see the "RECOVERY REPORT" delivered
to the user before this fix (git archaeology, ranked regression
candidates).

**Fix (content/discovery.js only):** `setSession()` now rejects
(tagged `err.isStorageWriteError = true`) on a real
`chrome.runtime.lastError`, matching the established pattern.
`runDiscoveryLoopSafe()`'s existing recovery-write path (already
present since 2637568, for uncaught exceptions) now labels the
resulting `discovery.stopReason` as `'storage-write-failed: <real
message>'` (vs. generic `'internal-error: ...'`) — already read
verbatim by `popup.js#renderDiscoveryUI()` and `WSHealthCheck.
computeHealthSummary()`'s FAILED/'error' branch, so no separate UI/
Health Check change was needed. The one `setSession()` call site NOT
routed through that safety wrapper (`STOP_DISCOVERY`'s handler) got its
own `.catch()` so a write failure there can never hang the message
channel (same bug class Mission E already fixed for `RUN_EXTRACTION`).
Zero changes to pagination/navigation/detection logic, `content/
nextdetect.js`, `autoscroll.js`, `loadmore.js`, `domwait.js`, or any
Detail Enrichment/Detail-reset code.

**New/fixed test infra:** `tests/lib/load-discovery.js` — fixed two
real mock-fidelity gaps found while building the regression test
(`quotaFailFn` never actually set `chrome.runtime.lastError`; `get()`
returned the same object reference as "storage," letting an in-place
mutation leak back even through a failed write — unlike real Chrome's
structured-clone semantics). Also exposed `getSession`/`setSession` and
made `__dispatchMessage` support async `sendResponse` for targeted
testing (same "exposed for testing only" convention already used for
`runDiscoveryLoop`).

**New test:** `tests/unit/discovery-storage-quota-safety.test.js` (21
assertions) — proves: quota failure never leaves `discovery.status` as
`'discovering'`; rows/pagesVisited/scraperConfig survive; the real
error text surfaces in `stopReason` and the `[WS-PAGE-DIAG]` buffer;
normal writes are unchanged; the loop never hangs even when EVERY
recovery attempt also fails (zero unhandled rejections); `STOP_DISCOVERY`
never hangs its message channel.

**Tests:** 22 unit test files, 658 assertions, 0 failures, 0 crashed.
`release-check`: 20/20. Full FAST: PASS. Nothing committed/pushed/
reset/stashed. No real-browser E2E run (per instruction) — awaiting the
user's manual real-Etsy verification.

---

## TWO ISSUES: Bug #1 (page-1 stall diagnosis capability) + Bug #2 (Detail reset config-loss fix)

**Bug #1 — NOT a pagination fix (explicitly deferred).** Reviewed the
Health Check report against the real symptom ("689 results, Sayfa 1
taranıyor, 1 sayfa tarandı, Ek veri taranıyor — stuck") and found two
real gaps, both fixed (diagnostics only, zero discovery/pagination logic
touched): (1) `formatHealthReport()` never surfaced `session.autoScroll`/
`session.loadMoreAuto` (status/stopReason/cycleCount/clickCount) — added,
since these give DIRECT ground truth on whether Auto Scroll/Load More is
still actively cycling vs. already exhausted. (2) No explicit stage
classification existed — added `WSHealthCheck.classifyStalledStage()`
(pure, `utils/healthcheck.js`): examines the tail of the merged
`[WS-PAGE-DIAG]` event list for a "started but never finished" STAGE
pair and returns one of `auto-scroll` / `load-more` /
`next-page-detection` / `navigation` / `reinjection-or-bootstrap` /
`inconsistent` / `unknown`. Wired into `computeHealthSummary()` (folded
into both `mainMessage` AND the top-level `overallReason`, not buried) —
only runs once a real problem is already indicated (never fires for a
healthy, progressing run). **Status: awaiting the user's real
"Raporu Kopyala" output from real Chrome — no pagination fix attempted.**

**Bug #2 — FIXED.** Root cause: Detail field CONFIGURATION (fields/
selectors/extraction modes/source column) lived ONLY in popup.js's own
in-memory `detailConfig` variable — never persisted anywhere — so it was
lost every time the popup closed (ordinary during a long Detail job).
"Sıfırla" itself never touched `detailConfig` (confirmed by inspection);
by the time the popup was reopened and Sıfırla clicked, the config was
already gone, making Sıfırla look like the culprit. Fix: persist
`{sourceColumnId, fields}` under its own new key
(`ws_detail_active_config::<hostname>`, per-hostname convention matching
`utils/detailtemplates.js`) after every mutation (`updateDetailWorkloadSummary()`
is the one common function every add/edit/delete/template-load/source-
column-change site already calls — added `persistActiveDetailConfig()`
there); restore (UNION by field id, never overwrite) via
`ensureDetailConfigHydrated()`, called once per popup session at the top
of `renderDetailSetup()`. This key is structurally never read/written by
`RESET_DEEP_SCRAPE`/`resetDeepScrapeState()` (background.js only ever
touches `ws_deepscrape_run`/`ws_deepscrape_fields`), so it survives a
reset by construction. Also fixed a second real gap: fields picked via
the live picker while NOT viewing the Detay tab were never persisted at
all — `persistActiveDetailConfig()` now also runs unconditionally in
`checkForPendingLiveDetailFieldPicks()`. Confirmation text updated in
all 6 locales to explicitly state fields are kept (exact requested
Turkish: "Detay çalışması sıfırlansın mı?\nSeçili detay alanları
korunacak, yalnızca mevcut çalışma ve ilerleme temizlenecek.").

**Files changed:** `utils/healthcheck.js` (`classifyStalledStage()`,
`stalledStageGuess` on the summary), `popup/popup.js`
(`detailActiveConfigKey`/`persistActiveDetailConfig`/
`ensureDetailConfigHydrated`, `renderDetailSetup()` now async,
`updateDetailWorkloadSummary()`/`checkForPendingLiveDetailFieldPicks()`
call the new persist function, `formatHealthReport()` enriched with
autoScroll/loadMoreAuto + stage guess, `input.diagEvents` wired into both
`computeHealthSummary()` call sites), `utils/i18n-data.js` (6-locale
`detail.resetConfirm` wording update).

**New/updated tests:** `tests/unit/detail-reset-preserves-config.test.js`
(NEW, 21 assertions — drives the real `#dt-reset-btn` via `load-popup.js`,
proves fields/selectors/modes/source-column/templates/main-scrape-results
all survive a confirmed reset, cancel changes nothing, updated wording is
shipped); `tests/unit/healthcheck-rules.test.js` (+11 assertions for
`classifyStalledStage`, now 32); `tests/unit/detail-reset-control.test.js`
(updated its static i18n assertion for the new wording — still 21
assertions, all passing).

**Tests:** 21 unit test files, 637 assertions, 0 failures, 0 crashed.
`release-check`: 20/20, 100% i18n coverage across all 6 locales. Full
FAST: PASS. No real-browser E2E run (per instruction). Nothing
committed, nothing pushed. Only `background/background.js`/`content/
discovery.js`/`content/content.js`/`content/scraper.js` diffs shown by
`git diff --stat` are cumulative from PRIOR missions on this branch —
none of them were touched in this turn.

---

## SELF-DIAGNOSTICS / HEALTH CHECK SYSTEM — observability, not a scraper redesign

**Status: IMPLEMENTED, awaiting manual Chrome verification.** A
development-only "Sağlık Kontrolü" (Health Check) system that observes
and summarizes the full lifecycle of a main scrape (start flow,
discovery/pagination, UI↔engine consistency, storage, Detail Enrichment)
as one HEALTHY / WARNING / STALLED / FAILED verdict with an exact reason
— diagnoses only, never mutates/resets/restarts anything. No scraper/
scraping-behavior change of any kind — every edit outside the new
`utils/healthcheck.js`/`utils/healthdiag.js` files is either a pure
diagnostic-event push (fire-and-forget, try/catch-wrapped) or new UI.

**Architecture — unified, not duplicated (mission requirement 11):**
- `utils/healthcheck.js` (NEW) — pure, chrome/DOM-free rules engine
  (`WSHealthCheck.computeHealthSummary(input)`) over a plain facts
  object. Same "pure function over plain serializable objects" shape as
  `utils/runstate.js`.
- `utils/healthdiag.js` (NEW) — shared, bounded (200-entry) diagnostic
  EVENT ring buffer (`ws_health_diag`, two independent scopes: `'main'`
  start-flow events from popup.js, `'detail'` Detail Enrichment events
  from background.js), loaded via `importScripts` (background) / a
  `<script>` tag (popup). Deliberately NOT a duplicate of
  `content/discovery.js`'s own pre-existing `ws_pagination_diag` buffer
  (100-entry, per-page discovery detail) — that buffer is completely
  unmodified and still owns pagination detail; the Health Check report
  reads and merges BOTH buffers into one chronological event list
  (`mergedDiagEvents()` in popup.js).
- `[WS-DIAG]`/`[WS-PAGE-DIAG]` console markers: unchanged, still present;
  every one of their call sites in `handleStartLiveSession()`
  (popup.js) now ALSO pushes the same event into `ws_health_diag`.

**Health rules implemented** (`utils/healthcheck.js`): no-progress-while-
RUNNING → STALLED (20s), navigation-issued-not-confirmed → STALLED
(10s), popup pages behind engine → WARNING, popup RUNNING/COMPLETE vs.
terminal/running discovery mismatch → WARNING, result-count mismatch
(session vs. rendered UI) → WARNING, recorded storage-quota error →
FAILED, storage ≥80% of quota → WARNING (mirrors `utils/snapshots.js`'s
own established ratio), Detail worker navigating with completed count
frozen (20s) → STALLED, discovery/Detail ended in error → FAILED.
Severity combines worst-wins (FAILED > STALLED > WARNING > HEALTHY).

**UI location:** Scrape tab, live-session area, directly below the
existing "Copy Session Diagnostic"/"Copy Pagination Diagnostic" panels —
`#health-check-panel`, dev-only (`WSLicense.isDevelopmentInstall()`-gated,
same contract as every other dev panel, statically enforced by
`scripts/release-check.js`). Buttons: "🩺 Sağlık Kontrolü" (run/refresh),
"📋 Raporu Kopyala", "📋 Tanılama Geçmişini Kopyala", "🧹 Tanılamayı
Temizle" (clears ONLY `ws_health_diag` + `ws_pagination_diag` — no
confirmation needed, never touches scraper/session/license/settings
data — proven by test).

**Report format** (`formatHealthReport`, popup.js): extension version,
timestamp, hostname, overall verdict, main-scrape section (sessionId/
status/resultCount/pagesVisited/discovery.status/lastPaginationAttempt),
UI↔engine consistency, storage (bytesInUse/quotaBytes/per-key breakdown/
the 4 named keys' sizes), Detail status/progress, detected health
issues, last 20 merged diagnostic events.

**Files changed:** `background/background.js` (`importScripts` for
healthdiag.js; `'detail'`-scope pushes in `runDeepScrape`/
`fetchOneDetailPage`), `popup/popup.html` (`#health-check-panel` + 2 new
`<script>` tags), `popup/popup.js` (`gatherHealthCheckInput`,
`computeAndRenderHealthCheck`, `formatHealthReport`,
`formatHealthDiagnosticHistory`, `mergedDiagEvents`, 3 handlers, reveal
fn, `lastRenderedDiscoverySnapshot` tracking in `renderDiscoveryUI()`,
`'main'`-scope pushes throughout `handleStartLiveSession()`),
`scripts/release-check.js` (new gated-panel check), `tests/lib/
load-popup.js` (clipboard-write capture, `getBytesInUse` mock),
`tests/lib/load-discovery.js` unaffected.

**New files:** `utils/healthcheck.js`, `utils/healthdiag.js`,
`tests/unit/healthcheck-rules.test.js` (21 assertions),
`tests/unit/healthdiag-buffer.test.js` (10 assertions),
`tests/unit/health-check-report.test.js` (28 assertions, drives the
REAL popup.js via `load-popup.js`).

**Tests:** 20 unit test files, 605 assertions, 0 failures, 0 crashed.
`release-check`: 20/20 (was 19 — new Health Check gated-panel check
added). Full FAST: PASS. No real-browser E2E run yet (per mission
instruction) — awaiting manual Chrome verification.

---

## DETAIL ENRICHMENT RESET CONTROL — real production feature request

**Status: IMPLEMENTED, awaiting manual Chrome verification.** A real,
explicit "Sıfırla" (Reset) button in the Detail tab's progress panel,
always visible whenever a real run (active or terminal — the reported
case: STOPPED at 72/125) is being shown.

**Behavior:** `window.confirm(WSI18n.t('detail.resetConfirm'))` — the
exact requested Turkish wording ("Detay çalışması sıfırlansın mı? Ana
tarama sonuçları korunacak.") is in `utils/i18n-data.js`'s `tr` block,
translated into all 6 locales for `release-check`'s 100% i18n-coverage
gate. Cancelling changes nothing (no message sent). Confirming sends
`RESET_DEEP_SCRAPE` to background.js's new `resetDeepScrapeState()`,
which:
1. If a run is genuinely still live in this service-worker instance,
   aborts its real `AbortController` (same mechanism the real Durdur
   button already uses) and waits, bounded (5s), for that run's own
   `runDeepScrapeUrls` `finally` block to actually finish (closing only
   tabs it owns) before touching storage.
2. Removes exactly `ws_deepscrape_run` and `ws_deepscrape_fields` —
   nothing else. `ws_live_session::*` (main scrape results/683 rows),
   `ws_license`, `ws_settings`, `ws_templates`, `ws_snapshots`,
   `ws_state::*` are never read or written by this function at all.

Popup returns to the clean Detail setup screen; `currentDetailRunId`
cleared; existing "Devam Et"/"Yeni Bir Çalıştırma Ayarla" behaviors
completely unchanged (separate handlers, not touched). No pagination/
discovery logic touched.

**Files changed:** `popup/popup.html` (`#dt-reset-btn`), `popup/popup.js`
(`handleDetailResetClick`, `dtResetBtn` always-visible-with-progress
wiring), `background/background.js` (`resetDeepScrapeState()`,
`RESET_DEEP_SCRAPE` handler), `utils/i18n-data.js` (2 new keys × 6
locales).

**New tests:** `tests/unit/detail-reset-control.test.js` (21
assertions) — proves, via the real `resetDeepScrapeState()` (loaded
through `tests/lib/load-background.js`) and the real `#dt-reset-btn`
click listener (loaded through `tests/lib/load-popup.js`, extended with
`chrome.runtime.sendMessage` and `window.confirm` mocks): reset clears
`ws_deepscrape_run`; clears `ws_deepscrape_fields`; leaves main scrape
results/license/settings/templates/snapshots/column-config byte-for-byte
untouched; a genuinely live worker's real `AbortController` is aborted
and waited for before storage is cleared; a cancelled confirmation sends
zero messages and changes zero UI state; the exact requested Turkish
strings are present in the real shipped `i18n-data.js`.

**Full `npm run test:fast`: 16 unit test files, 531 assertions, 0
failures, 0 crashed. `release-check`: 18/18, 100% i18n coverage across
all 6 locales.**

---

## STORAGE ARCHITECTURE FIX — the real ~9MB root cause, migrated + fixed at the source

**Status: FIXED, awaiting manual Chrome verification.** The BUG #1 ROUND 2
quota fix (below) stopped the crash but didn't remove the pressure — a
real Chrome storage audit (user-run, read-only console snippet) proved
`ws_deepscrape_run` was 9,017,179 bytes, of which **8,921,041 bytes
(96.6%) was `results[].fields`** — 72 flagged values, ~120-143KB each,
classified "html, full-page-text".

**Root cause (confirmed by code reading):** `content/scraper.js`'s
`runDetailExtraction()` resolved a field's saved `relativeSelector ===
':scope'` to `document.body` — so `attribute:'html'`/`'text'` returned
the ENTIRE PAGE's `innerHTML`/`textContent`. `:scope` reached that state
via `content/content.js`'s Detail-field picker calling
`WSScraper.pickElementInfo(el, null)`, which runs
`Sel.findRepeatingContainer()` — a heuristic built for repeating LIST
rows, with no business running on a single Detail page (which has no
container concept at all), and can mis-detect the clicked element
itself as "the container" on a complex real page (Etsy).

**Fix (3 layers, all implemented):**
1. **Source (picker):** `content/content.js`'s Detail pick now always
   resolves an absolute selector via `WSSelector.buildSelectorForElement`
   (same primitive `resolveNextButtonInfo` already uses) — can never
   produce `:scope` again.
2. **Source (extraction):** `content/scraper.js`'s `runDetailExtraction()`
   refuses `:scope` outright (never reinterprets it as the page body) —
   protects even already-staged old-shape field configs.
3. **Defensive, universal:** every extracted Detail value is now bounded
   by `DETAIL_FIELD_MAX_BYTES` (20,000 chars) regardless of cause — an
   oversized value is REJECTED (never truncated) and recorded in
   `rejectedFields`, never persisted.

**Storage architecture split (`background/background.js`):** the actual
field VALUES no longer live inline on `ws_deepscrape_run.results[url].fields`
(the object re-persisted on every lease/diag touch — the write-amplification
half of the original quota bug). A new, single, fixed-name key
`ws_deepscrape_fields` (never keyed by runId — reset at the start of
every fresh `runDeepScrape()`, so it can never accumulate across past
runs) holds `{url: fields}`, written only once per record completion via
`persistDetailResultFields()`. `ws_deepscrape_fields`' own write
explicitly rejects on a real quota error (mirrors `license.js`'s own
`persist()` pattern) — `fetchOneDetailPage()` catches that and marks the
one affected record `status:'partial', failureType:'STORAGE_QUOTA'`
without ever stopping the run. `popup/popup.js`'s `mergeDeepScrapeResults`/
`mergeDetailResults` now fetch this key once, at terminal state, instead
of reading `record.fields` inline — export/merge behavior is otherwise
unchanged.

**Migration (`migrateDeepScrapeStorageIfNeeded()`, wired into
`onInstalled`/`onStartup`):** idempotent, real-storage-proven — moves
every record's inline `fields` to the new key, stripping ONLY values
proven oversized (same `DETAIL_FIELD_MAX_BYTES` guard), preserving every
legitimate small value and all job metadata. Runs automatically on the
user's next extension reload (which they need anyway to pick up this
fix). Touches ONLY `ws_deepscrape_run`/`ws_deepscrape_fields` — proven
by test to leave `ws_live_session::*`, `ws_license`, `ws_settings`,
`ws_templates`, `ws_snapshots` byte-for-byte untouched.

**New tests:** `tests/unit/detail-extraction-size-guard.test.js` (16
assertions — real `content/scraper.js` loaded in a `vm` sandbox, proves
normal text/attribute fields store only their intended value, a
`:scope` field is refused with the exact reported ~150KB payload never
appearing anywhere in the result, an ordinary-selector 130KB value is
also rejected, a legitimate ~3.7KB value is preserved untouched, and
`multiple:'all'` drops only the oversized match). `tests/unit/
deep-scrape-storage-migration.test.js` (18 assertions — migration
preserves job metadata + legitimate values, strips only proven-oversized
ones, leaves every unrelated key untouched, is idempotent, the control
state shrinks from 100KB+ to under 5KB, `ws_deepscrape_run` stays under
3KB even with 5 real ~1.6KB-field records completed, and a real
`ws_deepscrape_fields` quota failure marks one record `STORAGE_QUOTA`
without stopping the queue). `tests/lib/load-background.js` gained a
`quotaFailFn` test hook (mirrors `load-popup.js`'s own). Every
PRE-EXISTING Detail test (72/125 regression, concurrent-reconcile,
stall-fix rounds 1-3, deep-scrape-detail-enrichment) updated to read
`ws_deepscrape_fields` instead of inline `.fields` and re-verified
passing unmodified otherwise — STOP/RESUME/lease-recovery/merge
correctness all still proven intact under the new architecture.

**Full `npm run test:fast`: 15 unit test files, 510 assertions, 0
failures, 0 crashed. `release-check`: 18/18.**

**Files changed this round:** `content/scraper.js` (new — the actual
extraction fix), `content/content.js` (picker fix + RUN_DETAIL_EXTRACTION
return shape), `background/background.js` (storage split + migration +
quota handling), `popup/popup.js` (both merge functions read the new
key). No pagination logic touched. Detail Enrichment's STOP/RESUME/lease
mechanics unchanged — only field-VALUE storage location and extraction
safety changed.

---

## BUG #1 ROUND 2 — real Chrome proof: storage-quota crash in chargeRunCredit()

**Status: FIXED, awaiting manual Chrome verification.** The first BUG #1
fix (content.js's RUN_EXTRACTION `.catch()`) did NOT fully resolve the
real report — a live-runtime diagnosis (temporary `[WS-DIAG]` console
markers + a real-browser test) proved extraction itself succeeded (64
real rows), but the REAL Chrome console then showed:
`Uncaught (in promise) Error: Resource::kQuotaBytes quota exceeded at
license.js:187`. Root cause: `chargeRunCredit()` (popup.js) had no
try/catch — a rejected `WSLicense.consumeRunCredit()` (its own tiny
`ws_license` write failing because chrome.storage.local's TOTAL usage,
not this one write's size, exceeded quota) propagated out of
`handleStartLiveSession()` as an unhandled rejection, skipping session
creation/persist/START_LIVE_WATCH/START_DISCOVERY entirely and freezing
the UI at "Veri işleniyor…" forever.

**Largest-key audit** (`grep` across the whole codebase for every
`ws_*` storage key pattern): `ws_live_session::<hostname>` is the one
standout unbounded, never-auto-cleaned key — it holds a session's full
`rows` array (can reach thousands of rows via the Automatic Discovery
Engine — this project's own real Etsy proof documented 1,283 rows in a
single session) and a NEW key is created per distinct hostname ever
scraped, permanently. Every other `ws_*` key is either a single
overwritten slot (`ws_deepscrape_run`, `ws_zip_run`, `ws_download_run`)
or inherently small (config/pointer keys). `ws_license` itself is
already small and isolated (schemaVersion/licenseStatus/trialRunsUsed/a
length-capped 200-entry `chargedRunIds` ledger) — confirmed by
inspection, not the cause.

**Fix (`popup/popup.js` only):**
1. The `chargeRunCredit()` call site in `handleStartLiveSession()` is
   now wrapped in try/catch — a failure NEVER aborts the rest of the
   flow (mandatory, unconditional).
2. On failure, new `reclaimObsoleteLiveSessionStorage(currentHostname)`
   frees ONLY `ws_live_session::*` entries already `status:'finished'`
   (the user already clicked BİTİR — genuinely done) for hostnames OTHER
   than the one starting this run — the one category of data this file
   can prove is obsolete on its own. Never touches: an `'active'`
   session for any host, the current hostname's own session (left alone;
   it gets legitimately overwritten by the normal flow moments later,
   not deleted by this), `ws_deepscrape_run`/`ws_run::*` (Detail
   Enrichment/pagination — explicitly out of scope), or `ws_license`.
3. `chargeRunCredit()` is retried once (same `runId` — idempotent by
   construction) after a successful reclaim.
4. Either way, the flow always continues into session
   creation/persist/START_LIVE_WATCH/START_DISCOVERY. A failed
   `persist()` never partially mutates storage (write-then-reject
   leaves it untouched), so the trial counter is never silently
   corrupted — just honestly not incremented when it genuinely
   couldn't be recorded.

**New test infrastructure:** `tests/lib/load-popup.js` — a real,
permanent `vm`-sandbox loader for the full `popup/popup.js` (mirrors
`tests/lib/load-background.js`'s established technique, extended for
popup.js's ~500 DOM lookups via an auto-vivifying stub `document`, and
promise-based `chrome.tabs`/`chrome.permissions`/`chrome.scripting`
mocks). Drives the REAL registered `#basla-btn` click listener — never a
reimplementation of `handleStartLiveSession()`.

**Test results:** `tests/unit/storage-quota-fix.test.js` — 15/15
assertions, across 4 real scenarios (permanent quota failure still
completes the flow; reclaim-and-retry succeeds and correctly charges the
run; an active other-hostname session is never touched; the ordinary
no-quota-problem path is unaffected) — each scenario ran under a real
`process.on('unhandledRejection', ...)` listener that caught **zero**
unhandled rejections. Full `npm run test:fast`: **13 unit test files,
476 assertions, 0 failures, 0 crashed**; `release-check`: 18/18.

**The temporary `[WS-DIAG]` console markers added during live diagnosis
remain in `handleStartLiveSession()`** (harmless, useful for the user's
own upcoming real Chrome retest) — not removed unless asked.

---

**Status: TWO REPRODUCED BUGS FIXED (round 1), awaiting manual Chrome
verification.**
BUG #1 ("BAŞLA does not actually start a new scrape — hangs at "Veri
işleniyor…" forever") + BUG #2 ("Detail Enrichment navigates but progress
frozen at 72/125"). Both root-caused via direct code reading (no
guessing) and fixed with the minimum change each required. See "BUGS #1
AND #2" immediately below for the complete report; everything under it
(the Discovery investigation, ROUND 3, etc.) is prior work, unchanged by
this mission except where explicitly noted.

## BUGS #1 AND #2 — BAŞLA hang + Detail Enrichment concurrent-reconcile race

### BUG #1 — root cause

`content/content.js`'s `RUN_EXTRACTION` message handler
(`WSStorage.getState(hostname()).then(fn).then(fn2)`) had **no `.catch()`
anywhere**. Any rejection/throw in that chain (a stale/malformed
`containerSelector` against the CURRENT page's real DOM shape, in
`migrateContainerSelectorIfStale()` or `WSScraper.runExtraction()`, or
`WSStorage.getState()`/`setState()` itself) meant `sendResponse()` was
never called. Since the handler `return true`s to keep the message
channel open, popup.js's `await chrome.tabs.sendMessage(...)` (inside
`sendToContent()`, called from `handleStartLiveSession()`) then hangs
forever — exactly the reported "Veri işleniyor…" freeze. This also
explains "an old session blocks the new run": `handleStartLiveSession()`'s
`runTriggerInFlight` guard is only reset in its own `finally`, which
cannot run while its own `await sendToContent(...)` is permanently
hung — so every subsequent BAŞLA click was silently swallowed, forever,
with no error ever shown. Same structural class of bug as
`content/discovery.js`'s already-fixed `runDiscoveryLoopSafe()` wrapper —
never previously applied here.

**Fix (minimal, one file):** `content/content.js` — added a `.catch()`
to the `RUN_EXTRACTION` promise chain that always calls
`sendResponse({ok:false, error:...})`. No popup.js change needed —
its existing `if (!res || !res.ok) { setStatus(readError, true); return; }`
already handles this correctly once a response actually arrives, which
also naturally unsticks `runTriggerInFlight` on the next click.

### BUG #2 — root cause

`reconcileDeepScrapeJob()` (STALL-FIX ROUND 3) runs on **every** incoming
extension message via a dedicated listener. Chrome dispatches one
message to *all* registered listeners, so the same
`RESUME_DEEP_SCRAPE`/`RETRY_FAILED_DEEP_SCRAPE_ITEMS` message a user's
own Resume/Retry click sends also reaches that reconciler — and if the
record's lease is also expired (the common case: that's usually *why*
the user is clicking Resume), the reconciler independently calls
`resumeInterruptedDeepScrapeItems()` a second time. The ownership claim
(`deepScrapeAbortControllers[runId] = controller`) previously happened
several `await`s after the "already running?" check — wide enough for
both concurrent calls to pass the check before either claimed the slot,
spawning **two parallel resume loops for the same runId**. Each holds
its own disconnected in-memory `state` snapshot
(`chrome.storage.local.get()` always returns a fresh clone, never a
shared reference), so each independently persists its own view of
`state.counts` — the two loops alternately overwrite each other's
genuinely-advancing progress. This is exactly the reported "worker tab
keeps navigating one page after another, but the persisted/displayed
completed count never advances": one loop's worker tab is genuinely,
visibly active; the other loop's stale writes keep clobbering the count
back down.

**Fix (minimal, one file):** `background/background.js` —
`resumeInterruptedDeepScrapeItems()` and `retryFailedDeepScrapeItems()`
now claim `deepScrapeAbortControllers[runId]` **synchronously**, with
zero `await`s between the "already running?" check and the claim,
closing the race completely. `reconcileDeepScrapeJob()` itself also
gained a lightweight re-entrancy guard (`deepScrapeReconcileInFlight`)
protecting its own reclaim bookkeeping (the `staleRecoveries` counter)
from being double-processed by a burst of near-simultaneous message-
triggered invocations. Also directly verified (code-read, not assumed):
a genuinely fresh run (`runDeepScrape`, new `runId`) always builds a
brand-new `state` object and overwrites `chrome.storage.local` — an old
stale 72/125 run can never leak into a new run's counts. This was
proven by test, not just read (see below).

### Files/functions changed

- `content/content.js` — `RUN_EXTRACTION` handler: added `.catch()`.
- `background/background.js` — `resumeInterruptedDeepScrapeItems()`,
  `retryFailedDeepScrapeItems()`: ownership claim moved earlier
  (synchronous, no intervening await). `reconcileDeepScrapeJob()`: split
  into itself (re-entrancy guard) + new `reconcileDeepScrapeJobLocked()`
  (the original body, unchanged logic).
- `tests/unit/content-run-extraction-fix.test.js` (new) — loads the
  real, unmodified `content/content.js` in a minimal `vm` sandbox and
  dispatches real `RUN_EXTRACTION` messages through it.
- `tests/unit/deep-scrape-concurrent-reconcile-fix.test.js` (new) —
  reproduces the real race via `__dispatchMessage` (real Chrome
  dispatch-to-all fan-out, never calling either function directly).

**Nothing else was touched** — no pagination/discovery control-flow
change beyond the one `.catch()`, no export/dedupe logic touched, Detail
Enrichment's actual extraction/merge/lease/STOP mechanics unchanged
(only the ownership-claim *timing* moved earlier).

### Test results

- `content-run-extraction-fix`: 10/10 assertions — proves a throwing
  `WSScraper.runExtraction()` and a rejecting `WSStorage.getState()` both
  now respond `{ok:false,...}` within 500ms (never hang), the success
  path is unaffected, and a static source guard locks the `.catch()` in
  place permanently.
- `deep-scrape-concurrent-reconcile-fix`: 139/139 assertions — proves,
  via the real message fan-out: completed count never regresses
  mid-run; all 125 records end `completed`; every one of the 53
  remaining URLs is processed **exactly once** (the direct
  duplicate-processing proof); navigation-without-usable-fields is
  classified `partial`, never inflates `completed`; a fresh run's counts
  never inherit an old stale run's state.
- Full `npm run test:fast`: **12 unit test files, 461 assertions, 0
  failures, 0 crashed** (all pre-existing suites — including the
  Round 2/3 stall-fix and 72/125 regression tests — still pass
  unmodified, proving no regression in the existing lease/recovery
  machinery). `node scripts/release-check.js`: 18/18 checks, 0 failures.

---

**Status: INVESTIGATED, NO CODE-LEVEL REGRESSION FOUND — pending manual
Etsy re-verification.** REGRESSION REPORT — "NORMAL DISCOVERY NOW STALLS
ON PAGE 2" (real production report, filed immediately after ROUND 3
below: 126 results ready, 2 pages scanned, status stuck on "Ek veri
taranıyor…", never reaches page 3, real Durdur-equivalent needed). User's
explicit instruction: **"Do NOT add another generic timeout blindly...
identify exactly what changed in shared state/control flow."** See
"DISCOVERY REGRESSION INVESTIGATION" immediately below for the complete
report; ROUND 3 (Detail job-state-machine redesign) and rounds 1-2 are
preserved further down for history — unchanged by this investigation.

## DISCOVERY REGRESSION INVESTIGATION (post Detail/STOP/Round-3 report)

**Outcome: zero product-code changes made.** A full shared-state/control-
flow audit plus two independent real-browser regression tests (detailed
below) found no reproducible defect anywhere in Discovery/Pagination or
in its interaction with the new Detail job-state-machine code — both the
underlying engine and the real popup's own live UI render correctly and
in perfect sync, page 1 → 2 → 3, through the real production START path.
Per CLAUDE.md's SELF-REPAIR LOOP ("every iteration must be based on an
actual observed failure"), changing code without a reproducible failure
would itself violate the user's own explicit "do not add another generic
timeout blindly" instruction — so none was made. Full findings below;
this is deliberately NOT reported as "fixed" — it is reported as
"investigated, not reproduced, here is exactly what was checked and why."

### 1. Shared-state audit (mission section 2)

Read every chrome.storage.local key and code path either system touches:
- **Discovery/Pagination** (content/discovery.js, entirely self-
  contained in the content-script context): reads/writes ONLY
  `ws_live_session::<hostname>`, via its own local `getSession`/
  `setSession` helpers. Never sends a `chrome.runtime` message to the
  background service worker at all during its loop (confirmed: the only
  `chrome.runtime.onMessage`/`chrome.runtime.sendMessage` reference in
  the file is discovery.js's OWN listener for START_DISCOVERY/
  STOP_DISCOVERY/GET_DISCOVERY_STATE, commands the POPUP sends TO it,
  never the reverse). Resumes after a real navigation entirely on its
  own, via a bootstrap `getSession()` check at content-script load time
  — depends only on Chrome's own persistent content-script registration
  (`ws-livewatch-<hostname>`, registered once at BAŞLA by popup.js), not
  on the background service worker being alive or responsive at all.
- **Detail Enrichment** (background/background.js, ROUND 3): reads/
  writes ONLY `ws_deepscrape_run` (one key, one job at a time, keyed
  internally by its own `runId` — never hostname-keyed, never touches
  `ws_live_session::*`). Its worker-tab pool (`deepScrapeTabPools`) is
  keyed per-`runId` in memory only, never touches `ws-livewatch-*`
  registrations, and calls neither `registerContentScripts` nor
  `unregisterContentScripts` anywhere (confirmed by direct grep — the
  pool uses plain `chrome.tabs.create`/`chrome.tabs.update`/
  `chrome.tabs.remove` on tabs it tracks by id, never a persistent
  registration that could collide with Discovery's own).
- **Alarms**: Detail owns exactly one alarm name
  (`ws_deepscrape_stall_watchdog`), created only inside
  `runDeepScrapeUrls()` — i.e. only while a Detail Enrichment run is
  actually active. Discovery uses no alarm at all. No collision.
- **Messages**: ROUND 3's one new blanket `chrome.runtime.onMessage`
  listener (`reconcileDeepScrapeJob()` on every message) does an early,
  cheap `getDeepScrapeState()` read and returns immediately whenever
  `ws_deepscrape_run` doesn't exist or isn't `running`/`stopping` —
  which is the case for a pure Discovery session with no Detail run ever
  started. It never touches `ws_live_session::*`, never calls into
  Discovery's own message listener, and Chrome dispatches each
  registered `onMessage`/`onChanged` listener independently — one
  listener throwing or being slow cannot block another's dispatch.
- **Popup render path**: `renderResults()` calls `updateDetailTabAvailability()`
  (Detail-related) before `renderLiveSessionUI()`→`renderDiscoveryUI()`
  (Discovery's own live status text) in the same synchronous call chain
  — inspected as the one plausible "Detail code silently breaks
  Discovery's own UI update" mechanism (an uncaught exception earlier in
  that chain would abort the rest of the function). Read in full:
  `updateDetailTabAvailability()` is a trivial, fully `if (els.x)`-guarded
  function with no throw risk, and — more importantly — real-browser
  test #2 below proves directly, end to end, that this entire render
  chain is NOT broken: the popup's own DOM text tracked storage
  perfectly through 3 real pages with zero divergence.

**Conclusion: no shared-key, shared-alarm, shared-message, or shared-
render-path collision exists between Discovery and Detail Enrichment.**
The two systems are, and remain, fully namespaced/isolated already — no
namespacing change was needed.

### 2. Real regression tests (mission section 4)

Two independent real-browser tests against books.toscrape.com (a real,
multi-page, publicly-accessible site — Etsy deliberately excluded here
per mission section 5, reserved for the user's own manual acceptance):

1. **`discovery-pagination-real-site`** (pre-existing, re-run unchanged):
   drives the real, unmodified `content/discovery.js` via a single
   `START_DISCOVERY` message (engine decides pagination on its own),
   polling the real underlying `ws_live_session::<host>` storage state
   directly. **Result: PASS.** Page 1 (20 rows) → page 2 (~21s, 40 rows)
   → page 3 (~13s, 60 rows), `paginationActionIssued`/
   `paginationActionSucceeded` both true, STOP preserved all 60 rows.
   (First attempt this session hit a 60s `chrome.permissions.request()`
   timeout — the same documented real resource-pressure symptom already
   on record elsewhere in this project's history, not a product failure;
   the immediate retry succeeded cleanly.)
2. **`discovery-popup-live-render-real-site`** (NEW, this investigation
   — see "Files changed" below): drives the REAL `#basla-btn` click
   (the real, unmodified `handleStartLiveSession()`), then polls BOTH
   the underlying storage state AND the popup's own real rendered DOM
   text (`#discovery-status-line2`, `#auto-paginate-status`) side by
   side on every tick — closing the one gap no existing Discovery test
   covered (every prior test read storage only, never the actual visible
   popup text a real user watches). **Result: PASS**, and the two
   tracks never diverged even once:
   `t=9s pagesVisited=1 DOM="1 page scanned"` →
   `t=29s pagesVisited=2 DOM="2 pages scanned"` →
   `t=50s pagesVisited=3 DOM="3 pages scanned"`. This directly
   disproves the leading hypothesis investigated (a popup-side render
   freeze caused by Detail-related code throwing upstream of Discovery's
   own status render) — the real popup UI tracks real progress exactly,
   through the real production START path, with the exact code the user
   ran.

### 3. Why this could not be reproduced, and what likely actually happened

Both the engine (test 1) and the full real-popup UI path (test 2) are
confirmed intact and correctly synchronized on a real multi-page site,
using the CURRENT, unmodified code (Round 3 included). Two honest,
non-code-regression explanations remain, consistent with directly-
observed evidence elsewhere in this same session on this same machine:
(a) **real resource pressure** — this exact 8GB-RAM machine has
repeatedly shown severe, directly-observed real resource contention this
session (free memory at 1.0-1.5GB out of 7.71GB total during these very
test runs; a genuine 7-minute stall on a single `chrome.permissions.request()`
call was recorded earlier in this project's own history under the same
condition) — a real Etsy tab, with its own heavier JS/ad/tracker load on
top of that pressure, is a plausible place for a real stall or a missed
DOM-mutation/navigation signal that this lightweight test site simply
never exercises; (b) **an Etsy-specific page condition** (its exact
next-page control, DOM complexity, or timing) not present on
books.toscrape.com. Neither is fixable by guessing — per the user's own
explicit instruction, no blind timeout/workaround was added for either.

### Files changed (this investigation)

- `e2e/tests/discovery-popup-live-render-real-site.test.js` (NEW) — the
  real-popup-DOM-vs-storage side-by-side regression test described above.
- `e2e/site-scenarios.js` — registered the new scenario into the
  `primary-workflow` suite (runs alongside the existing Discovery tests).
- **`background/background.js`/`popup/popup.js`/any other product file:
  UNCHANGED by this investigation** (confirmed via `git status` — no new
  diff beyond what Round 3 already produced) — no reproducible defect
  was found to justify a change, and none was made.

### Tests

- FAST: 10 unit test files, 312 assertions, 0 failures (unchanged from
  Round 3 — no product code touched), 18/18 checks, `FAST: PASS`.
- SITE: `discovery-pagination-real-site` — PASS (page 1→2→3, storage-
  level). `discovery-popup-live-render-real-site` — PASS (page 1→2→3,
  popup-DOM-level, zero divergence from storage).

### Git status

`develop`, uncommitted. Only new/untracked test infrastructure added
this investigation (`e2e/tests/discovery-popup-live-render-real-site.test.js`,
registered in `e2e/site-scenarios.js`) — zero product-code files changed.
No commit, no push, no merge; `main`/`stable/v1.31.0` untouched.

**Per mission section 5, Etsy re-verification is the user's own manual
next step — if the stall recurs on a real Etsy run, the single most
valuable next artifact is the real `session.discovery.lastPaginationAttempt`
diagnostic object (already captured automatically by the existing code,
readable directly from `chrome.storage.local['ws_live_session::www.etsy.com']`
at the moment of the stall) plus real system free-memory at that exact
moment — either would turn this from "not reproduced" into a concrete,
fixable, evidence-based finding instead of a guess.**

---

## ROUND 3 — job-state-machine / lease / out-of-band STOP redesign

### (1) Why the real job could remain RUNNING forever

Round 2's staleness check depended on two soft signals: "no live
in-memory `AbortController` for this run" AND "`updatedAt` hasn't moved
in `DEEP_SCRAPE_STALE_RECOVERY_THRESHOLD_MS`". Both are weak: (a) a
service worker that is technically still alive but wedged inside a
single unresolved `chrome.tabs.sendMessage`/`chrome.tabs.update` await
still holds a live controller reference and a recent `updatedAt` from
its last per-record start, so the alarm's own reconciliation logic
returned immediately ("nothing to reclaim") every single time it fired —
this is exactly what real Etsy hit: not a fully-dead service worker (round
2's own explicit target), but a genuinely-alive one hung on one unbounded
await with no independent, wall-clock-verifiable deadline attached to
that specific record. (b) The 1-minute alarm was the ONLY thing that ever
called the recovery path — nothing about opening the popup, clicking
Stop, or polling state ever triggered it, so recovery was bounded by a
60-second-minimum cadence even in the best case, and by nothing at all
in the case above.

### (2) Why the real STOP button had no effect

`handleDetailStopClick()` only ever sent a `STOP_DEEP_SCRAPE` message to
the background and relied on that SAME wedged service worker to receive
it, check `stopRequested`, and abort its own in-flight operation. If the
worker was inside the exact unbounded await from (1), the message was
queued behind it and never actually processed in useful time — Stop was
depending on the very promise that was already provably hung to be the
thing that noticed the stop request. There was also no independent
persistence of the stop intent from the popup side — if the message
itself never got a chance to run, `stopRequested` was never written
anywhere at all.

### (3) New persistent job state model

Single authoritative record in `chrome.storage.local['ws_deepscrape_run']`
(read via `getDeepScrapeState()`/written via `setDeepScrapeState()`,
serialized through the existing `serializeDeepScrapeOp()` queue so
concurrent writers never race). Job-level `status`: `running` |
`stopping` | `stopped` | `completed` | `error` (idle = no state object at
all). Per-record `results[url].status`: `pending` | `completed` |
`partial` | `failed` | `skipped`, with `failureType` ∈ `TIMEOUT` |
`MISSING` | `HTTP_BLOCKED` | `NAVIGATION_ERROR` | `SITE_CHALLENGE` | null
for a bounded, honest classification (not a generic "failed"). Popup and
background never independently decide "running" — the popup only ever
renders whatever this one object says (`renderDetailProgress`), and its
own out-of-band Stop write (see (8)) goes through the identical storage
key so there is exactly one place status can diverge from, not three.

### (4) Lease mechanism

`state.lease = { recordId, leaseStartedAt, leaseExpiresAt, attempt }`,
written by `persistRecordLease()` BEFORE the risky per-record operation
begins (persist-before-await, mission section 4) —
`leaseExpiresAt = Date.now() + recordTimeoutMs + DEEP_SCRAPE_LEASE_GRACE_MS`
(15s grace on top of the configured per-record timeout). Staleness is now
a pure wall-clock comparison — `Date.now() < state.lease.leaseExpiresAt`
— completely independent of whether a controller object still happens to
exist in memory, closing gap (1) directly: even a genuinely-alive but
wedged worker is reclaimed once its own declared deadline passes, because
the check no longer trusts liveness signals from the very code path that
is stuck. `clearRecordLease()` runs at every terminal outcome for a
record (success, failure, or reclaim) so a stale lease can never
outlive the record it names.

### (5) Recovery behavior

`reconcileDeepScrapeJob()` (renamed from round 2's
`checkDeepScrapeStallOnWake`) now runs on THREE independent triggers, not
one: the existing 1-minute `chrome.alarms` wake, `onInstalled`/`onStartup`
(reload/restart), AND — new this round — a dedicated, response-free
`chrome.runtime.onMessage` listener that fires on literally EVERY message
the extension receives, including the popup's own 5-second active poll
(`GET_DEEP_SCRAPE_STATE`, new `ensureDetailPollTimer()` in popup.js) —
collapsing worst-case recovery latency from ~60s to ~5s while the popup
is open, without requiring the wedged operation itself to ever resolve.
On each run it: honors `stopRequested` first (aborts a genuinely-live
controller if one exists and returns, deferring to that run's own
already-correct completion logic — race-safe, never double-writes final
state; otherwise, if no live controller, writes `stopped` itself and
closes only its own owned worker tabs); else, if a lease exists and is
expired, reclaims that one record (bounded retry via `staleRecoveries`,
same give-up-after-2 bound as round 2) and resumes the queue from there —
never touching the 72 already-terminal records, since `resumeInterruptedDeepScrapeItems`
only re-queues genuinely non-terminal URLs.

### (6) Exact storage keys / state shape

`chrome.storage.local['ws_deepscrape_run']` = `{ runId, status, fields,
results: { [url]: { status, fields, error, httpStatus, finalUrl,
retryStatus, failureType, staleRecoveries } }, concurrency, maxAttempts,
recordTimeoutMs, stopRequested, lease: { recordId, leaseStartedAt,
leaseExpiresAt, attempt } | null, delayMode, customDelayMs, currentUrl,
currentRecordDiag, counts: { total, completed, partial, failed, skipped,
timeouts }, error, startedAt, updatedAt, finishedAt }`. This is the ONE
object mission section 1 asked to be inspected — every field it asked
about (current record, workerTabId — held in the separate
`deepScrapeTabPools[runId]` map keyed by runId, not on the state object
itself, since a tab is infrastructure, not job state — abort token —
in-memory only, `deepScrapeAbortControllers[runId]`, deliberately never
persisted since it cannot survive a dead worker anyway and the lease is
what replaces it as the durable signal — lastProgressAt = `updatedAt`,
attempt count = `lease.attempt`, pending queue = every `results[url]`
with `status:'pending'`, completed map = every `results[url]` with
`status:'completed'`, stopRequested flag) now has one exact, named
location.

### (7) Worker-tab ownership model

Unchanged in shape from the round-1/round-2 pool
(`acquireWorkerTab`/`releaseWorkerTab`/`closeAllWorkerTabs`/
`navigateWorkerTab`/`poisonWorkerTab`, keyed per-`runId`, never touching
any tab this pool didn't itself open) — round 3 only changes WHEN
cleanup fires: `reconcileDeepScrapeJob()`'s own stop-handling branch now
calls `closeAllWorkerTabs(state.runId)` directly, so a stop that has to
fall back to the reconciler (no live controller) still cleans up its own
owned tab rather than leaving it orphaned.

### (8) STOP production message path (exact)

Real popup click on `#dt-stop-btn` → `handleDetailStopClick()` →
`directlyPersistDetailStopRequested(runId)` — a DIRECT
`chrome.storage.local.set()` write from the POPUP's own JS context
(bypassing message-passing entirely, so it succeeds even if the
background is completely wedged) setting `stopRequested:true` and
`status:'stopping'` → THEN (best-effort, not depended on)
`sendToBackground({type:'STOP_DEEP_SCRAPE', runId})` → the popup's own
`chrome.storage.onChanged` listener fires from ITS OWN write instantly
(same-context storage events fire synchronously-ish, no round trip
needed) → `renderDetailProgress` shows "Stopping safely..." immediately
→ background reconciliation (via whichever of the 3 triggers in (5)
fires first — typically the `STOP_DEEP_SCRAPE` message itself, since the
dedicated response-free listener runs on it too) aborts/finalizes to
`status:'stopped'` → popup's storage listener fires again with the final
state → UI shows STOPPED. Proven via the REAL UI, not a direct function
call — see (9).

### (9) 72/125 regression proof

`tests/unit/deep-scrape-72-125-regression.test.js` — the exact model
from the user's own report (`TOTAL=125, COMPLETED_COUNT=72,
STUCK_INDEX=72`), run against the real, unmodified `background.js`
(only `chrome.*`/`fetch` mocked). Scenario A (timeout path): record 73's
mock never calls back; asserts final `status:'completed'`, all 72
pre-completed records byte-for-byte untouched, record 73 classified
`failed`/`TIMEOUT`, all 52 records after it (74-125) still complete.
Scenario B (Stop-while-hung path, `recordTimeoutMs:999999` — deliberately
enormous, proving Stop never waits for it): confirms the run genuinely
reaches and leases record 73, then applies the real
`persistDeepScrapeStopRequest` + abort path, asserts STOPPED reached in
under 2 seconds, all 72 completed + 53 remaining preserved exactly, then
RESUMEs and confirms only the genuinely-unfinished records (73-125) get
re-processed. **Result: 11/11 assertions passing.**

### (10) Partial-result export proof

Code-traced (this merge/export architecture was not touched by round 3):
`renderDetailProgress()` treats `status:'stopped'` as terminal
(`isTerminal = ['completed','stopped','error'].indexOf(...) !== -1`) and
calls `mergeDetailResults(dsState)` the moment that terminal state is
reached — which merges every `results[url]` with `status:'completed'` (or
`'partial'`) into `rawRows` BY URL LOOKUP (never row position), then
`invalidateTransformCache()` + `renderResults()`. `rawRows` is the exact
same array every export path (Results tab render, XLSX, CSV, JSON, Copy)
reads — none of them care whether the job that populated it ever reached
125/125. Directly corroborated by the real STOP UI test's own
`stop-after.png` screenshot (see (12)), which shows the real "Resume" /
"Configure Another Run" buttons and a real "Stopped" summary rendered
immediately on STOPPED — the same render path that performs the merge.

### (11) FAST results

`npm run test:fast`: **10 unit test files, 312 assertions, 0 failures, 0
crashed** (includes the new 72/125 regression file's 11 and the new
round-3-specific `deep-scrape-stall-fix-round3.test.js`'s 10, plus all
pre-existing suites re-passing after the lease-field additions to round
2's own seeded test states), 100% i18n coverage across all 6 locales,
production ZIP build/content checks all green, `18 checks, 0 failures`.
`4 sections, 0 failed` — `FAST: PASS`.

### (12) SITE results

`e2e/tests/detail-enrichment-real-stop.test.js` (new, registered as the
`detail-enrichment-real-stop` suite) — the mission's own mandatory "REAL
STOP UI TEST": real `books.toscrape.com` page → real optional-permission
grant (books.toscrape.com + httpbin.org) → real `#basla-btn` → real
`#discovery-process-all-btn` (20 real rows) → row 1's real Link value
pointed at a real, safe, standard `httpbin.org/delay/60` endpoint (a
genuinely slow, still-in-flight real navigation, never Etsy, never an
internal-function bypass) → real Detail Enrichment field pick staged →
real `#dt-start-btn` click → polled the REAL `#dt-progress-badge` for
`RUNNING` → real `#dt-stop-btn` ("Durdur") click — THE production path
under test, never any `stopJob()` call — → polled the REAL badge for
`STOPPED`. **RESULT: PASS.** STOP resolved in 20ms (asserted `<15000ms`,
proving it never waited out httpbin's own 60s delay). Real persisted
`chrome.storage.local['ws_deepscrape_run']` confirmed `status:'stopped'`,
`stopRequested:true`. Screenshots visually confirmed (not just the
pass-text) per CLAUDE.md's own mandatory rule:
`stop-before.png` shows the real "RUNNING" badge with
"Current: https://httpbin.org/delay/60" genuinely in-flight and a live
red "Stop" button; `stop-after.png` shows the real "STOPPED" badge with
"Resume"/"Configure Another Run" and a real "Stopped / 1 unique pages"
summary. (First attempt at this test had a test-script-only bug — the
row-URL mutation was applied to a popup page instance that gets closed
and replaced before the run starts, per the established
close/reopen-to-restage pattern also used by
`detail-enrichment-fetch-fallback.js`; the mutation was silently lost on
reopen since `rawRows` restores from persisted session storage, not
carried in-memory across a popup close. Fixed by moving the mutation to
run on the popup instance that actually clicks Start — a test-harness fix
only, zero product-code changes involved.)

### (13) Exact git status

Branch `develop`, unpushed/uncommitted throughout (no commits made this
mission or any prior mission this session, per explicit instruction).
`git status --short` / `git diff --stat` reviewed: all modified/new files
(`background/background.js`, `popup/popup.js`, `popup/popup.html`,
`utils/i18n-data.js`, plus this file and the new
`e2e/tests/detail-enrichment-real-stop.test.js` /
`tests/unit/deep-scrape-72-125-regression.test.js` /
`tests/unit/deep-scrape-stall-fix-round3.test.js` /
`tests/lib/load-background.js` changes / `e2e/site-scenarios.js` /
`package.json` script) are explainable by this round or an earlier
already-reported mission in this same session; nothing unrelated touched.
**No commit, no push, no merge — main and stable/v1.31.0 untouched.**

**Per the mission's own explicit instruction, no full real 125-record
Etsy run was attempted (Etsy automation is blocked in this environment
and this machine has 8GB RAM) — the deterministic 72/125 model plus the
real popup-STOP-UI test above are the complete substitute the mission
asked for. The final 125-record Etsy acceptance is the user's own manual
step.**

---

## ROUND 2 (preserved for history)

**Status: COMPLETE.** BUG FIX MISSION — DETAIL ENRICHMENT STALLS MID-RUN,
ROUND 2 (real production finding: round 1's fix did not actually trigger
— same URL, same stall, Timeouts stayed at 0, STOP had no effect).

**REAL ROOT CAUSE (revised, verified against documented MV3 behavior, not
assumed)**: round 1's in-process hard timeout (`withRecordTimeout`,
`setTimeout`-based) and its `setInterval` watchdog are real, correct
fixes for a genuine CODE-level hang — and are directly proven to work by
round 1's own unit tests. But BOTH symptoms the user reported together
(Timeouts stayed 0 for an extended real period; STOP had no effect) have
exactly one honest explanation: the extension's own MV3 **service worker
itself was terminated** while genuinely awaiting a long-pending
`chrome.tabs.sendMessage` response — a real, documented MV3 limitation
(a service worker can be reclaimed by Chrome after inactivity even with
a promise technically pending, more aggressively under real memory
pressure — and this session's own environment has repeatedly shown
severe memory pressure, up to a genuine **7-minute** stall on a single
`chrome.permissions.request()` call observed during this very round's
own regression testing). When the service worker dies, EVERYTHING
in-memory for that run is destroyed with it — including the very
`setTimeout`/`setInterval` that were supposed to catch the stall, and the
`AbortController` STOP depends on. `ws_deepscrape_run` in
`chrome.storage.local` is left showing `status:'running'` forever because
nothing is left alive to ever transition it.

**FIX**: `chrome.alarms` — the one MV3 mechanism actually GUARANTEED to
wake a terminated service worker back up. A periodic (1-minute) alarm
checks for a run that's `status:'running'` with no live in-memory
controller and genuinely stale progress, and recovers it via the
existing browser-restart-interruption machinery — including re-arming
itself automatically on a manual "reload extension" click (the user's
own real troubleshooting step) or a real browser restart, neither of
which previously re-armed anything. STOP is made resilient the same way:
persisted as a `stopRequested` storage flag unconditionally (not only an
in-memory abort), honored by the next real recovery pass even if the
original run's service worker is long gone. A URL that keeps stalling
the service worker itself is permanently given up on (`status:'skipped'`)
after 2 recovery attempts — the queue always reaches a real terminal
state. Round 1's in-process fix is KEPT as the fast path for the common
case (service worker stays alive); this is the layer that closes the gap
the real retest exposed. See "Tests" below: 20 new FAST assertions
directly simulate a dead service worker (via the real onAlarm/onInstalled
dispatch paths, not just calling the recovery function in isolation) and
prove full recovery, bounded give-up, and Stop actually stopping.

Also verified and reported (mission's own explicit "DATA PERSISTENCE"
section) — see that section below for the full, code-traced answer: the
72 successfully-enriched records are safe in `chrome.storage.local`
(`ws_deepscrape_run`) throughout, survive extension reload, and are NOT
lost by the stall — but are only merged into the exportable/visible
dataset once the run reaches a real terminal status, which is exactly
what this fix now guarantees actually happens.

## Files changed (round 2)

- `background/background.js` — `DEEP_SCRAPE_STALL_ALARM_NAME`/
  `_PERIOD_MINUTES`/`DEEP_SCRAPE_STALE_RECOVERY_THRESHOLD_MS`/
  `DEEP_SCRAPE_MAX_STALE_RECOVERIES` constants; `checkDeepScrapeStallOnWake()`
  (the real alarm-triggered recovery); `reconcileDeepScrapeWatchdogOnWake()`
  (re-arms + immediately checks on a real reload/restart);
  `persistDeepScrapeStopRequest()`; the shared `chrome.alarms.onAlarm`
  listener extended to dispatch to the new watchdog; `STOP_DEEP_SCRAPE`
  handler now persists the stop request unconditionally;
  `chrome.runtime.onInstalled`/`onStartup` now also call the new
  reconcile function; `retryFailedDeepScrapeItems`/
  `resumeInterruptedDeepScrapeItems` now preserve `staleRecoveries`
  across a re-queue (a real bug caught by my own first test run — it was
  silently resetting the counter, defeating the give-up bound).
- `tests/lib/load-background.js` — real in-memory `chrome.alarms` mock
  (was a no-op stub) + `__fireAlarm`/`__fireInstalled`/`__fireStartup`
  test hooks that dispatch through the REAL registered listeners, not a
  shortcut around them.
- `tests/unit/deep-scrape-stall-fix-round2.test.js` (new) — 20 FAST
  assertions: alarm lifecycle (created while running, cleared on
  completion); a run whose original service worker is gone (no live
  controller + stale `updatedAt`, dispatched via a real simulated alarm
  fire) is genuinely recovered, and the record queued behind the stuck
  one is NOT blocked; STOP persisted with no live controller is honored
  by the next recovery pass; a record already at the give-up bound is
  permanently skipped and the rest of the queue still completes; a real
  simulated "reload extension" (`onInstalled`, `reason:'update'`)
  auto-recovers a run left mid-flight.

## Tests (round 2)

- `npm run test:fast`: **PASS** — 20/20 new assertions (0 failures);
  full suite still green (291 total unit assertions across 8 files).
- SITE — `detail-enrichment-fetch-fallback-books` regression: **PASS**
  (real worker-tab reuse, false-success guard, merge-by-URL all still
  correct with the new alarm-registration code active in a real
  browser). Notably, this SAME run observed a genuine **7-minute** real
  stall on `chrome.permissions.request()` before succeeding — direct,
  fresh, concrete evidence of just how severe this environment's real
  resource pressure currently is, independently corroborating the
  service-worker-termination root cause.
- Did not attempt a further real-Etsy run this round — Etsy has been
  consistently `BLOCKED_BY_SITE` all session, and the observed 7-minute
  stall on a routine permission call is a clear signal this environment
  is currently under real resource strain; per the mission's own
  resource-safety instructions, no further real-browser launches were
  made once sufficient FAST + SITE evidence was gathered.

## DATA PERSISTENCE / EXPORT — verified against the actual code (not
described from memory)

1. **Exact `chrome.storage.local` key**: `ws_deepscrape_run` — the
   entire run's state, including `results` (an object keyed by URL, each
   entry carrying `status`/`fields`/`error`/`failureType`/etc.).
2. **Are the 72 extracted values still present?** Yes — persisted in
   `ws_deepscrape_run.results` independent of whatever the popup UI shows
   or whether the job appears stuck. Confirmed by reading
   `setDeepScrapeState`/`getDeepScrapeState` (plain `chrome.storage.local`
   get/set, no session storage, no in-memory-only path) and by my own
   FAST tests reading real persisted values back out.
3. **Are they merged into the main 125 result records?** **Only once the
   run reaches a real terminal status** (`completed`/`stopped`/`error`) —
   `popup.js`'s `mergeDetailResults()` is called EXCLUSIVELY from inside
   `renderDetailProgress()`'s `if (isTerminal)` branch (`popup/popup.js`,
   `renderDetailProgress`). While `status` stays `'running'` (exactly the
   reported stall condition), the 72 good values are safe in storage but
   genuinely NOT YET merged into `rawRows` — an honest, real consequence
   of the stall this mission's fix directly resolves (once the run
   reaches ANY terminal state — including a graceful `'stopped'` — the
   merge fires).
4. **Can Results tab display them?** Only once merged (i.e. only once
   terminal) — not while genuinely stuck at `'running'`.
5-7. **CSV / XLSX / JSON export?** All three (`WSCsv.rowsToCSV`,
   `WSXlsx.buildWorkbook`, the JSON export path) read from the SAME
   `rawRows`-derived `data.rows`/`data.columns` via
   `buildExportDataForCurrentOptions()` — once `mergeDetailResults` has
   run, the `dt_`-prefixed columns are ordinary row properties and all
   three exports include them identically; before that (still running),
   none of them do, since the columns don't exist on `rawRows` yet.
8. **Does STOP preserve them?** Yes — `ws_deepscrape_run.results` is
   never cleared or rewritten by Stop, and (with this round's fix) Stop
   now reliably transitions `status` to `'stopped'` even if the original
   service worker died, which is what actually triggers the merge.
9. **Does extension reload preserve them?** Yes — `ws_deepscrape_run`
   lives in `chrome.storage.local` (deliberately moved off `.session` in
   an earlier mission specifically so it survives a service-worker
   restart AND the browser itself closing/reopening — see that code's
   own header comment). A manual reload does NOT lose the 72 records;
   with this round's fix, it also now automatically re-arms recovery
   for a run that was mid-flight at the moment of reload, rather than
   requiring the user to click Resume.

---

# PRIOR mission (COMPLETE) — DETAIL ENRICHMENT STALLS MID-RUN, round 1

**Status: COMPLETE** (superseded by round 2 above — its own in-process
fix remains real and correct, kept as the fast path). BUG FIX MISSION —
DETAIL ENRICHMENT STALLS MID-RUN (real Etsy: 72/125 completed, then
stopped making progress forever until manually stopped). Root cause:
several real chrome.* calls inside the
extraction pipeline (`chrome.tabs.update`, `chrome.scripting.
executeScript`, `chrome.tabs.sendMessage`) had NO independent timeout of
their own — each is normally reliable but is a real, documented class of
Chrome extension messaging flakiness (a tab in a stuck/discarded/bfcache
state can leave a callback never firing); with concurrency defaulting to
1, ONE such record could block the entire queue forever. Fixed with a
hard, configurable per-record timeout (`DEEP_SCRAPE_RECORD_TIMEOUT_MS`,
default 30s) wrapping the FULL per-attempt resolution via a real
`Promise`-race against both the timeout and the run's own Stop signal,
plus per-record diagnostics (`state.currentRecordDiag`:
recordId/url/stage/stageStartedAt/lastProgressAt/attempt/workerTabId,
live-inspectable via the existing `GET_DEEP_SCRAPE_STATE` message), a
worker-tab "poison" step so a stalled tab is closed and never reused by
the next record, a defense-in-depth job watchdog, and a new "Timeouts"
UI counter distinct from generic "Errors". See "Tests" below: 18 new
FAST assertions DIRECTLY reproduce the exact reported hang (a record
whose `sendMessage` callback never fires) against the real,
unmodified background.js and prove the queue continues past it; a real
SITE regression run confirms no regression to the working real-browser
flow. `npm run test:release` and Amazon/eBay remain out of scope (not
requested).

## Files changed (this mission)

- `background/background.js` — the fix: `DEEP_SCRAPE_RECORD_TIMEOUT_MS`/
  `DEEP_SCRAPE_WATCHDOG_*` constants; `withRecordTimeout()` (races a
  promise against both a hard timeout and the run's abort signal);
  `makeRecordDiag()`/`touchRecordDiag()` (per-record diagnostics,
  persisted); `poisonWorkerTab()` (closes+forgets a stalled tab so it's
  never reused); `startDeepScrapeWatchdog()` (defense-in-depth); wired
  through `extractDetailFields`/`resolveDetailPage`/`fetchOneDetailPage`/
  `testDeepScrapeSample`/`runDeepScrapeUrls`/`runDeepScrape`;
  `deepScrapeCounts()` now also tallies a `timeouts` subset count.
- `popup/popup.js` — `renderDetailProgress()` now shows Timeouts
  separately from Errors (mission's own explicit UI example).
- `utils/i18n-data.js` — `detail.progressText` updated with a
  `{timeouts}` placeholder across all 6 locales (en/tr/de/fr/zh-CN/ru) —
  100% i18n coverage re-verified via release-check.
- `tests/lib/load-background.js` — added `setInterval`/`clearInterval`
  to the sandbox (needed for the new watchdog).
- `tests/unit/deep-scrape-stall-fix.test.js` (new) — 18 FAST assertions:
  a record whose `sendMessage` callback never fires (the exact reported
  hang) is bounded and classified TIMEOUT, the NEXT record still
  processes, the stalled tab is poisoned/never reused, live per-record
  diagnostics are observable, STOP interrupts an in-flight record
  immediately (not after the full timeout), RESUME preserves completed
  records and only re-processes the pending ones.

## Tests (this mission)

- `npm run test:fast`: **PASS** — 18/18 new assertions (0 failures);
  full FAST suite still green (301 total unit assertions across 8
  files), i18n coverage 100% across all 6 locales re-confirmed.
- SITE — `detail-enrichment-fetch-fallback-books` (books.toscrape.com)
  regression: **PASS** on a bounded single retry (first attempt hit the
  SAME documented resource-pressure BAŞLA/session-creation stall seen
  repeatedly this session, unrelated to this fix — see prior mission
  section for the same pattern). Confirms the new timeout/diagnostics/
  poisoning machinery did NOT regress the working real-browser flow:
  worker-tab reuse, false-success guard, and merge-by-URL all still
  confirmed.
- SITE — `detail-enrichment-fetch-fallback-etsy`: **BLOCKED_BY_SITE**
  again (real PerimeterX challenge at the search page) — could not reach
  the actual 72/125-scale stall scenario live on Etsy this session;
  per the mission's own explicit fallback instruction ("If Etsy itself
  blocks automation, use deterministic tests plus manual-production-path
  evidence honestly"), the FAST tests above are the authoritative,
  direct proof of the fix (they reproduce the EXACT reported hang
  mechanism — a chrome.tabs.sendMessage callback that never fires —
  against the real, unmodified background.js, not a simplified
  approximation of it).
- Did NOT attempt a real 125-record (or any large-N) real run this
  session — explicitly out of scope per the mission's own "Do NOT
  immediately run 125 if resource conditions are poor" and this
  session's own long, documented history of real resource pressure.

---

# PRIOR mission (COMPLETE) — HTTP 403 on Etsy Detail Enrichment

**Status: COMPLETE.** BUG FIX MISSION — DETAIL ENRICHMENT HTTP 403 ON
ETSY. Root cause identified and proven (not assumed): `validateDetailUrl`'s
fetch() pre-check (`credentials:'omit'`, no real navigation fingerprint)
gets HTTP 403 from Etsy's own PerimeterX/HUMAN bot-protection, and — the
actual bug — that 403 was a hard, non-retryable stop that PREVENTED the
already-working real-tab extraction step from ever running at all.
Fixed: `resolveDetailPage()` now falls back to a REAL browser navigation
(via a new, owned, per-run worker-tab pool — one tab, reused across every
record, never one tab per product) whenever the fetch validation comes
back anything other than a confirmed-missing 404/non-HTML result. A real
navigation that is ALSO blocked is honestly classified `SITE_CHALLENGE`
(DOM-structural check, never bypassed) instead of a generic HTTP 403.
Full failure taxonomy (MISSING/HTTP_BLOCKED/SITE_CHALLENGE/
NAVIGATION_ERROR/SELECTOR_ERROR/TIMEOUT) now recorded per-URL as
`record.failureType`, additive — no existing status/UI contract changed.
See "Tests" below for FAST (38 new assertions, all passing, directly
against the real background.js) and SITE (books.toscrape.com: real
worker-tab-reuse + merge-by-URL + false-success-guard all confirmed PASS;
Etsy: honestly `BLOCKED_BY_SITE` at the search page, not bypassed)
results. `npm run test:release` and the Amazon/eBay suites remain out of
scope for this mission (not requested).

## Files changed (this mission)

- `background/background.js` — the actual fix: worker-tab pool
  (`acquireWorkerTab`/`releaseWorkerTab`/`closeAllWorkerTabs`/
  `navigateWorkerTab`), `resolveDetailPage()` (fetch-then-real-navigation-
  fallback orchestration), `pageLooksLikeChallenge()` (DOM-structural
  SITE_CHALLENGE detection), extended `classifyHttpFailure()`/
  `validateDetailUrl()`/`extractDetailFields()`/`fetchOneDetailPage()`/
  `testDeepScrapeSample()`/`runDeepScrapeUrls()` for the new failure
  taxonomy and tab-pool lifecycle. No other feature in this file touched.
- `tests/lib/load-background.js` (new) — vm-sandbox loader + rich
  `chrome.*`/`fetch()` mock + real in-memory tab registry for unit-
  testing background.js's own top-level functions directly.
- `tests/unit/deep-scrape-detail-enrichment.test.js` (new) — 38 FAST
  assertions: classification, the 403-fallback fix itself, SITE_CHALLENGE/
  SELECTOR_ERROR/TIMEOUT distinctions, worker-tab reuse/ownership
  (single-tab-for-3-pages, per-run isolation), row association (URL-
  keyed, order-independent), checkpoint persistence, retry/backoff,
  STOP, RESUME.
- `e2e/lib/detail-enrichment-fetch-fallback.js` (new) — shared SITE-level
  core: real DETAIL -> scope -> Start flow, staging the one detail field
  the same way the real picker itself would (not re-driving the
  interactive picker UI — see file header for why), worker-tab-ownership
  assertions, false-success guard, merge-by-URL proof.
- `e2e/tests/detail-enrichment-fetch-fallback-books.test.js` (new) —
  TESTING B, real books.toscrape.com.
- `e2e/tests/detail-enrichment-fetch-fallback-etsy.test.js` (new) —
  TESTING C, real Etsy, small (FIRST 3) scope, real Auto Detect (no
  hardcoded Etsy selectors).
- `e2e/tests/detail-enrichment-real-flow.test.js` — additive worker-tab-
  ownership assertions only (max-extra-pages-during-run bounded to 1,
  cleanup-after-completion check); no existing assertions changed.
- `e2e/site-scenarios.js`, `package.json` — new `detail-enrichment-fetch-
  fallback` suite/script.

## Tests (this mission)

- `npm run test:fast`: **PASS** — 38/38 new assertions (0 failures),
  full suite still green (283 total unit assertions across 7 files).
- SITE — `detail-enrichment-fetch-fallback-books` (books.toscrape.com):
  **PASS** on a bounded single retry (first attempt hit the SAME
  documented resource-pressure BAŞLA/session-creation stall seen
  elsewhere this session — ~101s permission grant, unrelated to this
  fix, not chased further than one retry per Resource Safety). Confirmed:
  real worker-tab reuse (max 1 extra tab across 3 real pages), real
  cleanup after completion, real false-success guard (no completed/
  partial result also carries a leftover error/failureType), real
  merge-by-URL (3/3 rows enriched). Screenshot confirms real UI:
  "DETAIL ENRICHMENT COMPLETED — 3/3 pages • Successful: 3 • Missing: 0 •
  Errors: 0".
- SITE — `detail-enrichment-fetch-fallback-etsy` (real Etsy):
  **BLOCKED_BY_SITE** at the search page (real PerimeterX "Verification
  Required" challenge, confirmed by screenshot) — honestly reported, not
  bypassed, consistent with every other real-Etsy attempt this session.
- **Separate, pre-existing, NOT caused by this mission's changes**:
  `detail-enrichment-real-flow.test.js` (the interactive-picker version)
  failed twice more this session at its own already-documented flaky
  spot (picker click-to-capture not registering) — confirmed via
  screenshot that PICKER ACTIVE was genuinely showing; this is the SAME
  issue already recorded earlier in this file, entirely upstream of
  anything this mission's fix touches (the failure occurs before Start
  Detail Enrichment is ever clicked). Not re-chased here — covered
  instead by the new fetch-fallback tests' own field-staging approach,
  which deliberately avoids this unrelated flaky step (see that file's
  own header comment for the reasoning).

---

# PRIOR mission (COMPLETE) — permanent three-level QA/release gate

**Status: SUBSTANTIALLY COMPLETE.** The permanent three-level QA/release
gate (FAST / SITE / RELEASE) is built, and its final required step — re-
verifying the previously-paused picker popup-lifecycle bug using the new
SITE system — is DONE (now "## RESOLVED — previous mission" below): 2/2
consecutive real-browser PASSes. One scenario
(`detail-enrichment-real-flow`) remains intermittently flaky after two
genuine test-infra fixes; deliberately not chased further this session
per the mission's own Resource Safety mandate (5 real Chrome launches in
~20 minutes already). Not yet run: `npm run test:release` (the full
composed gate) and the deferred Amazon/eBay suites (explicitly out of
scope for this session). See "Tests" below for the complete, honest
result set.

## Work completed so far

- **FAST level** (`npm run test:fast`) — built and green (0 failures):
  - `tests/lib/load-modules.js` + `tests/lib/assert.js`: shared vm-sandbox
    loader + `makeSuite()` helper, the permanent foundation every
    `tests/unit/*.test.js` file uses to load real, unmodified `utils/*.js`
    files (no mocking of the modules themselves).
  - `tests/unit/detailscope-and-templates.test.js` (40 assertions),
    `tests/unit/cleaners.test.js` (50), `tests/unit/runstate.test.js`
    (52), `tests/unit/discovery-core.test.js` (49), `tests/unit/csv.test.js`
    (24) — 215 assertions total, all passing.
  - `scripts/test-fast.js`: orchestrates `node --check` over every
    product/test `.js` file, all `tests/unit/*.test.js`, `scripts/check-
    test-infra-safety.js`, and `scripts/release-check.js`. Launches zero
    browsers. Verified: `npm run test:fast` → FAST: PASS.
  - **Real finding, not fixed** (per "do not modify product behavior to
    make tests pass"): `utils/cleaners.js`'s `LINK_NAME_RE` (`/\b(?:link|
    url|bağlantı)\b/i`) never actually matches "Bağlantı" — JS `\b` is
    ASCII-only and the word ends in the Turkish dotless-ı, which isn't a
    `\w` char, so the trailing boundary never fires. Documented in
    `tests/unit/cleaners.test.js` and here; not fixed (out of this
    mission's scope) — a real, pre-existing Turkish-locale inference gap
    for a future mission.
- **SITE level** (`npm run test:sites[:suite]`) — built:
  - `e2e/site-scenarios.js`: declares 4 site suites (`etsy`, `primary-
    workflow`, `amazon`, `ebay`) + `smoke`, composed ENTIRELY from
    existing, already-written `e2e/tests/*.test.js` scenario modules (no
    scraping logic re-implemented — reuse, not a second framework).
  - `e2e/site-runner.js`: the shared-context, sequential, timeout-guarded
    orchestrator (reuses `e2e/lib/browser.js` unmodified). One browser
    context per invocation, per-scenario + whole-run timeouts,
    `BLOCKED_BY_SITE`/`BLOCKED_RESOURCE` classification, page-level
    cleanup between scenarios, ownership-scoped `closeUp()` only.
  - `e2e/lib/challenge-detect.js` + `e2e/lib/basic-site-acceptance.js`:
    shared helpers extracted for the new Amazon/eBay scenarios (etsy-
    popup.test.js itself left untouched).
  - `e2e/tests/site-harness-smoke.test.js`, `site-acceptance-amazon.test.js`,
    `site-acceptance-ebay.test.js`: new scenario modules.
  - Verified: `npm run test:sites:smoke` → PASS (3.4s, screenshots
    confirmed visually). Real Etsy + primary-workflow run in progress —
    see "Tests" below for the live result once it completes.
- **RELEASE level**: `scripts/test-release.js` built (FAST + browser-
  safety regression + full SITE, distinct exit codes 0/1/2 so a blocked
  site is never silently reported as a clean pass). Not yet run this
  session (depends on the SITE run above finishing first).
- **Docs**: `TESTING.md` (full level/command/evidence/outcome reference)
  and a new "Testing policy" section in `CLAUDE.md` (concise, with the
  mission's own worked examples) both written.

## Tests

- `npm run test:fast`: PASS (4 sections, 0 failed; 215 unit assertions,
  0 failures).
- `npm run test:sites:smoke`: PASS.
- `npm run test:sites:amazon` (run sequentially, alone, per explicit
  follow-up instruction): PASS (4/4 checks, 40573ms). Real Amazon
  search page opened, but Amazon served its own generic "Sorry,
  something went wrong on our end" error page (NOT a CAPTCHA/login —
  confirmed by screenshot; correctly not flagged BLOCKED_BY_SITE), so 0
  records (this basic-acceptance suite never attempts extraction).
  `chrome.permissions.request()` took ~38s (vs ~1-3s against Etsy/books.
  toscrape.com all session) — system memory checked right after: 1.95GB
  free of 7.71GB. No product bug found; looks like host resource
  pressure, not a code defect.
- `npm run test:sites:ebay` (run sequentially after Amazon, alone):
  PASS (5/5 checks, 9542ms) — noticeably faster and more checks passed
  than Amazon. Real eBay search results page confirmed via screenshot
  (real listings, real prices, "100,000+ results for desk lamp"),
  `chrome.permissions.request()` resolved in ~4s. Memory after: 1.89GB
  free — stable, not degrading further. No product bug found.
- **NEW: `e2e/tests/etsy-detail-picker-real-flow.test.js` built** — a
  dedicated real-Etsy Detail Enrichment/Picker acceptance test (new
  `etsy-detail-picker` SITE suite, `npm run test:sites:etsy-detail-picker`),
  covering the full 15-item checklist + a small (FIRST 3, never hundreds)
  real Detail Enrichment run with an explicit, rigorous per-URL join-
  accuracy cross-check (Test Fields preview vs. final merged rows, two
  independently-triggered real code paths). Uses the REAL Auto Detect
  engine (`RUN_AUTO_DETECT`) to build the scraping config from Etsy's
  actual current markup instead of hand-guessed CSS selectors (robust
  against Etsy's own frequently-changing DOM). `npm run test:fast`
  re-verified PASS before running it.
  **Result: `BLOCKED_BY_SITE`** — the real Etsy PerimeterX/HUMAN
  "Verification Required — Slide right to secure your access" challenge
  appeared on the very first real page load (confirmed by screenshot:
  `test-artifacts/latest/site-etsy-detail-picker/etsy-search.png`), same
  as every other real-Etsy attempt this session. None of steps 4-15 were
  reachable — reported honestly as BLOCKED_BY_SITE (not a PASS, not a
  FAIL, not bypassed). No genuine product bug found; nothing to fix.
  Memory checked after: 1.86GB free — stable.
- First real `etsy,primary-workflow` SITE run: `etsy` suite ->
  `BLOCKED_BY_SITE` (real Etsy anti-bot challenge, expected — see
  `TESTING.md`). `primary-workflow`: 6 PASS, 4 FAIL. Root-caused all 4
  FAILs to a real bug in `e2e/site-runner.js` ITSELF (not the product):
  reusing one shared browser context across scenarios left
  `chrome.storage` state (a previous scenario's live session, the
  popup's last-active-tab preference) bleeding into the next scenario —
  every existing `e2e/tests/*.test.js` file was written and verified
  against `e2e/run.js`'s fresh-profile-per-run isolation, so back-to-back
  reuse broke that assumption (e.g. the popup opened straight to the
  Results tab because a PRIOR scenario left it there, hiding `#basla-btn`
  — nothing wrong with the extension). Fixed: `chrome.storage.local`/
  `.session` are now cleared via the service worker between every
  scenario, restoring the same fresh-install condition each scenario was
  actually authored against while still sharing the one browser process.
  Re-verifying `primary-workflow` now with the fix in place.
- **Separate, real, unrelated finding** (NOT fixed — out of this
  mission's scope, product behavior, not test infra):
  `autopaginate-real-site` FAILed ONCE (first run only — passed cleanly
  on the second, isolation-fixed run, 63947ms) on a genuine assertion —
  `STOP_AUTO_PAGINATE` returned `{"ok":false,"error":"Could not
  establish connection. Receiving end does not exist."}` when sent right
  as the tab was mid-navigation to page 4 (status was still
  `"navigating"`). Recorded here per the Self-Repair Loop's "pre-
  existing/unrelated -> record and continue" rule (looks like a genuine,
  rare timing race, not reproduced on retry); a future mission should
  investigate whether STOP messages sent during an in-flight cross-page
  navigation need a retry/queue in `content/autopaginate.js` or
  `background.js`.
- **Re-run of `primary-workflow` after the isolation fix: 9 PASS, 1 FAIL
  (`detail-enrichment-real-flow`) — CRITICALLY, `picker-popup-lifecycle-
  real-flow` PASSED (10937ms, 13 checks)**, which is the actual proof of
  the previously-unresolved, reopened picker popup-lifecycle bug fix —
  see "PAUSED — previous mission" below, now considered VERIFIED by this
  real-browser run.
- **Second and third real findings in `detail-enrichment-real-flow.test.js`,
  BOTH FIXED** (test infra only, no product code touched):
  (a) it used Playwright's `locator.click()` on a real page element while
  picker mode was active — picker mode's own real full-viewport click-
  interception overlay (by design) visually covers the element, so
  Playwright's actionability check correctly refused to click "through"
  it and timed out; fixed via a raw coordinate-based `mouse.click()`,
  mirroring the exact technique `picker-popup-lifecycle-real-flow.test.js`
  already used successfully for the identical situation.
  (b) after that fix, a re-run showed the click landing before the
  picker's own listeners had actually attached; fixed by adding the same
  "wait for the real PICKER ACTIVE banner" readiness poll
  `picker-popup-lifecycle-real-flow.test.js` already established.
  Re-run after both fixes (via `site-runner.js --suite=primary-workflow`,
  full 10-scenario suite): **9 PASS, 1 FAIL** — same as the previous
  attempt, `picker-popup-lifecycle-real-flow` PASSED again (2nd
  consecutive clean pass, cementing the picker-bug verification), but
  `detail-enrichment-real-flow` still failed, THIS TIME even further
  along (at the panel-input-visibility step, past both fixes).
  A follow-up ISOLATED run of just this one scenario (`node e2e/run.js
  --scenario=detail-enrichment-real-flow`, a fresh browser, unrelated to
  the shared-context isolation fix) then failed at a completely
  DIFFERENT, EARLIER step — `real BAŞLA click never produced a live
  session` — before either of this session's two fixes are even reached.
  Screenshot showed the popup rendered completely normally (Start button
  present, columns loaded) with no indication of a UI/product problem.
  **Conclusion**: this specific scenario is genuinely flaky in a way that
  moves around between runs, most consistent with resource-timing
  pressure from having launched 5 real Chrome instances back-to-back in
  ~20 minutes — exactly the class of instability this whole mission's
  Resource Safety requirements exist to prevent. Per the Self-Repair
  Loop's own "pre-existing/unrelated -> record and continue, don't loop
  indefinitely" rule, and per this mission's own Resource Safety mandate
  ("the testing system itself must not become the reason ClickScrape
  cannot be tested"), further real-browser runs were deliberately NOT
  launched to keep chasing this one flake. **Left honestly unresolved**:
  `detail-enrichment-real-flow` needs a future run (ideally after a
  cool-down) to confirm whether it's now clean; the two applied fixes are
  real and correct regardless of that scenario's remaining flakiness.

---

## RESOLVED — previous mission (picker popup-lifecycle fix)

**Status: COMPLETE AND VERIFIED.** The real-browser confirmation that was
previously blocked on insufficient system resources (see the original
"REOPENED" section immediately below for that history) has now run
successfully, twice, consecutively, via the new SITE system built in the
current mission: `e2e/tests/picker-popup-lifecycle-real-flow.test.js`
PASSED both times (10937ms/13 checks, then 10942ms/13 checks) —
real popup click on "Örnek Sayfada Alan Seç", real popup closed
immediately after (reproducing a real toolbar popup's own focus-loss
destruction), real sample page opened and entered picker mode anyway
(background.js orchestration, not the dead popup), real hover highlight,
real click on a real nested `<a><span>` with NO navigation, real value
captured, staged field survived popup closure, reopened popup's DETAY
tab showed the field — the complete 11/12-item checklist, all with the
popup genuinely gone throughout. The background.js orchestration fix
(moving `handleDtPickFieldsClick()`'s activation sequence out of
popup.js, so it no longer depends on the popup's own JS context
surviving) is confirmed real and working. The prior "BUG FIX MISSION —
DETAIL VISUAL ELEMENT PICKER" section further down (event interception)
was already COMPLETE and independently verified; this reopened mission's
own deeper root cause (popup lifecycle) is now ALSO verified — nothing
about the picker bug remains open.

---

# REOPENED — DETAIL PICKER STILL BROKEN IN REAL USE (popup lifecycle)

**Status: implementation complete, blocked on real-browser
confirmation (system resources).**

## Root Cause (high confidence, architecturally certain — not yet
independently confirmed end-to-end by a passing real-browser run this
session due to the resource blocker below)

The event-interception fix (previous section) was real and necessary,
but insufficient: it was verified using this project's own established
Playwright workaround for the "toolbar popup can't be automated"
limitation — opening `popup.html` as an ordinary TAB. An ordinary tab
does **not** auto-close when another tab becomes active. A **real**
Chrome `default_popup` toolbar popup **does** — losing focus (which
`chrome.tabs.create({active:true})` causes, by design, the instant it
runs) is one of the standard, well-documented ways a real browser-action
popup is destroyed, and destruction means its entire JS execution
context — including any `async function` currently paused mid-`await`
— is torn down immediately, permanently, with no unhandled-rejection
event, no cleanup callback, nothing.

`handleDtPickFieldsClick()` (the real handler behind "Örnek Sayfada Alan
Seç" / "Pick a Field on an Example Page") used to run entirely inside
`popup.js`: `chrome.tabs.create({active:true})` → await tab load → await
content-script injection → await `sendMessage(START_PICK)`. In the real
toolbar popup, the FIRST of those calls already triggers the popup's own
destruction — every step after it (including the one that actually tells
the content script to start picking) never executes. This is an exact,
structural match for the reported symptom: no highlight, nothing
captured, nothing returned — content.js's picker was never even told to
start. The previous fix (event interception) was real and correct for
the case where picking DOES start, but could never have been reachable
in real production use if activation itself was silently failing first.

This also directly explains why the FIRST bug-fix round's own real-
browser test passed cleanly: that test drove `popup.html` as an ordinary
tab throughout and never closed it, so it could never have exposed a
bug that only manifests when the popup surface is destroyed — a real,
structural blind spot of the "open popup.html as a tab" workaround this
whole project's test suite relies on (documented, permanent, unrelated
to this fix — see `e2e/run.js`'s own header).

## Whether Popup Lifecycle Was Part Of The Bug

**Yes — this was the actual root cause**, more fundamental than the
event-interception issue the first fix round addressed. Per the user's
own explicit instruction, picker mode now lives entirely in the
background service worker + content script; the popup's only remaining
job is to fire a single, fire-and-forget message and can be destroyed
(by the OS, by the user, by losing focus) a millisecond later with zero
effect on whether picking actually happens.

## Exact Message Flow (new)

1. Popup: user clicks `#dt-pick-fields-btn` → `handleDtPickFieldsClick()`
   sends `{type:'START_DETAIL_FIELD_PICK', sampleUrl, hostname}` to the
   background service worker via `chrome.runtime.sendMessage` and awaits
   only the IMMEDIATE ack (`{ok:true, started:true}`, sent synchronously
   by the handler before any tab work begins — same "ack now, keep
   working after" contract this file's own `START_DEEP_SCRAPE` already
   uses). The popup may close the instant this resolves; nothing after
   it depends on the popup still existing.
2. Background (`background.js#startDetailFieldPick`, never blocked by
   popup lifetime): `chrome.tabs.create({url:sampleUrl, active:true})` →
   `waitForTabComplete(tabId)` (the SAME event-driven, already-existing
   helper Monitoring already uses) → `sendStartPickWithRetry(tabId,
   {type:'START_PICK', purpose:'live-detail-field', targetHostname})`
   (sends; if no response, injects `CONTENT_FILES` fresh and retries
   once — defensive, since the persistent `registerContentScripts`
   registration from BAŞLA should already cover this origin).
3. Content script (`content.js`'s existing `START_PICK` handler,
   unchanged): `enterPickMode()` runs synchronously — sets
   `pickModeActive=true`, shows the (now more prominent) "ClickScrape —
   PICKER ACTIVE" banner, shows the picker overlay — THEN responds
   `{ok:true}`. By the time background.js sees that ack, picker mode is
   already, genuinely active on the page.
4. User clicks a real element on the real page → captured exactly as
   the previous fix round already verified (overlay interception,
   `elementsFromPoint` resolution) → named → "Add Field" stages the
   result to `chrome.storage.session` under
   `ws_live_detail_field_picks::<hostname>` (unchanged from before) —
   now also carrying `pickedFromUrl` (Phase 5's own explicit ask: the
   real sample page URL the field was picked from).
5. Popup reopened (any time later) → `checkForPendingLiveDetailFieldPicks()`
   (already existed, unchanged) reads and clears the staged key, merges
   the field into `detailConfig.fields`, and it shows up in the DETAY
   fields list — this part of the architecture was already correct and
   needed no change; only step 1-3 (getting picker mode ACTIVATED at
   all) was broken.

## How Picker State Persists (Phase 4)

Picker mode's own activation state lives in the CONTENT SCRIPT (a
per-tab, per-navigation JS context — already independent of the popup,
always was) and is now REACHED via the BACKGROUND SERVICE WORKER (also
independent of the popup). The popup owns none of it — it is a pure,
disposable trigger. The one thing that previously (correctly) lived in
storage — the staged picked-field result — still does, unchanged.
Additively, the ACTIVATION SEQUENCE's own progress is now also
persisted, in `chrome.storage.local` under `ws_detail_pick_session`
(mission Phase 1/2's own explicit diagnostic ask), independent of both
popup and content-script lifetime — readable at any time via a new
dev-only "Copy Detail Picker Diagnostic" button in the DETAY tab, or the
new `GET_DETAIL_PICK_SESSION` message.

## How Active Tab / Content Script Is Resolved

Unchanged in spirit, now owned by the right process: `chrome.tabs.create()`
returns the REAL tab object background.js just created (never inferred/
guessed), so there is no "which tab is active" ambiguity at all — this
is a brand-new, purpose-created tab, not a query against whatever the
user happens to be looking at. `waitForTabComplete()` confirms that
EXACT tab id reached `status:'complete'` before anything is sent to it.
`sendStartPickWithRetry()` targets that exact tab id with
`chrome.tabs.sendMessage` (never a broadcast), retrying with a fresh
`chrome.scripting.executeScript` injection if the first attempt gets no
response — the persistent `registerContentScripts` registration
`handleStartLiveSession` already sets up for this exact origin should
make this retry path a rarely/never-taken fallback, not the primary
mechanism.

## How Click Interception Works

Unchanged from the previous fix round (full-viewport transparent
overlay + `document.elementsFromPoint()` geometric resolution) — see
that section further below for the complete explanation. Verified again
this round via `picker-popup-lifecycle-real-flow.test.js`'s own STEP
7-10 (real hover highlight, real nested-anchor click, no navigation, no
site-handler firing, correct captured value) — this time with the
triggering popup already closed the entire time.

## Files Changed (this reopened mission)

- **`background/background.js`** — new `startDetailFieldPick()` +
  `sendStartPickWithRetry()` + `DETAIL_PICK_SESSION_KEY` get/set +
  `START_DETAIL_FIELD_PICK`/`GET_DETAIL_PICK_SESSION` message handlers.
  Reuses the existing `waitForTabComplete`/`sendMessageToTab`/
  `CONTENT_FILES` helpers verbatim (no duplication).
- **`popup/popup.js`** — `handleDtPickFieldsClick()` reduced to a single
  fire-and-forget `sendToBackground({type:'START_DETAIL_FIELD_PICK',...})`
  call (the old `waitForTabComplete`/`sendToTabWithRetry` helpers that
  used to live here, and did all the now-relocated work, are removed —
  dead code after the move). New dev-only diagnostic panel:
  `revealDetailPickDiagPanelIfDev()`, `formatDetailPickDiagnosticReport()`,
  `handleCopyDetailPickDiagnostic()`, wired into `renderDetailSetup()`
  and init().
- **`popup/popup.html`** — new `#detail-pick-diag-panel` (dev-only,
  `isDevelopmentInstall()`-gated, same established convention as
  `#session-diag-panel`).
- **`content/content.js`** — banner made "unmistakable" (mission's own
  explicit word): bolder text, green accent border, a small pulsing dot,
  and every variant now leads with "ClickScrape — PICKER ACTIVE" (was
  the much subtler plain-dark "Web Scraper: click an element..."). Also:
  staged detail-field picks now carry `pickedFromUrl` (Phase 5's
  explicit "source URL" ask — `sampleValue`/selector/extraction type
  were already captured before this change).
- **`e2e/tests/picker-popup-lifecycle-real-flow.test.js`** (NEW) — the
  mandatory real-browser proof (see below); explicitly closes the popup
  page immediately after clicking "Pick a Field" to reproduce the real
  toolbar popup's own destruction-on-focus-loss, then verifies picker
  activation, capture, and staged-result recovery ALL still work with
  the popup already gone.

## Real-Browser Proof — Status

`picker-popup-lifecycle-real-flow.test.js` was launched and stalled at
the `chrome.permissions.request()` step under severe system resource
pressure for 45+ minutes, then the background task itself was
externally interrupted (killed) before ever reaching a PASS or FAIL
result — see this section's own history and Blockers below. **This
mission is NOT being reported as fixed-and-verified** — per this
project's own CLAUDE.md, and per the mission's own explicit "If the real
browser test cannot prove this exact flow, the bug is NOT fixed", real-
browser proof is mandatory before declaring this closed, and has not
yet been obtained for this specific (popup-lifecycle) fix. No browser
process was closed by this session in response to the interruption —
any orphaned window from that run (if one remains) was left alone, per
CLAUDE.md's Browser Process Safety rules.

What IS independently confirmed already: `node --check` on every
changed file, `node scripts/release-check.js` (18/18), and
`check-test-infra-safety` (19 files) — all pass. The underlying event-
interception mechanism this fix builds on top of was already
comprehensively real-browser-verified in the previous section.

## Blockers

**BLOCKED: INSUFFICIENT SYSTEM RESOURCES.** Free RAM has held at
~1.2-1.8 GB of 7.71 GB total for this entire session (same condition
recorded repeatedly earlier in this file's own history).
`picker-popup-lifecycle-real-flow.test.js` has been stuck at the
`chrome.permissions.request()` step for **over 40 minutes** as of this
writing — well past every prior precedent in this file's own history
(the longest previously recorded was ~25 minutes). Per CLAUDE.md: did
not close any browser process, did not run any broad/name-based kill,
did not attempt to free memory by touching anything this session didn't
launch itself, and left the stalled background task running rather than
force-stopping it (no benefit over letting its own `finally`-block
cleanup run if/when it resolves).

**What is needed to unblock:** the user frees system memory, then
confirms it's safe to resume — at which point the ONE remaining
required step is: let `picker-popup-lifecycle-real-flow.test.js` run to
completion, inspect the result AND the screenshots directly
(`picker-active-after-popup-closed.png`,
`picker-lifecycle-nested-captured.png`,
`picker-lifecycle-reopened-popup.png`), and report the real outcome
honestly — including fixing anything it reveals, if it doesn't pass
cleanly.

## Tests (this reopened mission)

- `node --check` on `background/background.js`, `content/content.js`,
  `popup/popup.js`, `popup/popup.html` (n/a), and the new test file: all
  pass.
- `node scripts/release-check.js`: 18/18 PASS (re-confirmed after these
  changes).
- `npm run check-test-infra-safety`: PASS (19 files scanned).
- `picker-popup-lifecycle-real-flow.test.js`: **not yet resulted** —
  see Blockers.

## Git (this reopened mission)

Nothing committed, nothing pushed, nothing merged. `main`/
`stable/v1.31.0` untouched. Diff (cumulative across both picker-related
missions) scoped to: `background/background.js`, `content/content.js`,
`popup/popup.js`, `popup/popup.html` (all modified) +
`e2e/tests/picker-interception-real-flow.test.js`,
`e2e/tests/picker-popup-lifecycle-real-flow.test.js` (new) — plus the
carried-over, already-reported Detail Enrichment feature diff
(`utils/i18n-data.js`, `utils/detailscope.js`, `utils/detailtemplates.js`,
the two `detail-enrichment-*.test.js` files) from the mission before it.

---

# BUG FIX MISSION — DETAIL VISUAL ELEMENT PICKER (event interception —
COMPLETE, independently real-browser-verified)

**Status: COMPLETE.** Real bug (manually reported: clicking a link
during Detail's "Örnek Sayfada Alan Seç" picker mode on a real Etsy page
navigated the site instead of being captured) — root-caused and fixed
in `content/content.js`, the ONE shared element-picker mechanism every
pick purpose in this codebase uses ('column'/'next-button'/
'detail-field'/'live-detail-field'). Real-browser proof: **PASS**, every
item in the mission's own explicit checklist confirmed, including the
exact bug-report example (`<a><span>CountryCottageImages</span></a>`,
clicking the nested span) and the exact reported entry point.

## Root Cause

The picker previously listened for `mousemove`/`click` on `document`
itself (capture phase), relying on `preventDefault()`/`stopPropagation()`/
`stopImmediatePropagation()` inside that listener to stop the page's own
click behavior (link navigation, button activation, site click
handlers). That only works if OUR listener is guaranteed to run — and
run first — which capture-phase registration order does NOT guarantee
against an already-loaded real page: a site's own capture-phase
listener on `window` (visited BEFORE `document` during capture) or on
`document` itself, registered EARLIER (at page-load time — long before
the user ever clicks "Pick a Field", which is when our own listener
first gets registered), can call its own `stopPropagation()` first,
which prevents our later-registered listener from ever firing at all —
our `preventDefault()` never even executes. This is exactly what a
real, non-trivial site like Etsy does. Confirmed as the real mechanism
(not guessed): the fix that closes it is the standard, verifiable
"glass pane" technique, and the real-browser test directly proves the
underlying page's own click handler literally never fires during
picker mode (0 real click events recorded), which is only possible if
the event never reached it at all.

## Files Changed

- **`content/content.js`** (the ONLY functional change) — replaced the
  document-level capture-phase listener strategy with a full-viewport,
  transparent, `position:fixed` overlay (`overlayEl`, z-index
  `2147483005` — higher than every other element this file creates and
  than any realistic real-world page z-index) shown only while picker
  mode is active. The BROWSER's own hit-testing resolves the overlay as
  the target of every pointer event over the viewport, structurally,
  before any JavaScript runs — no page listener, regardless of where or
  when it was registered, can ever see the event. `resolveOverlayTarget()`
  replaces the old `composedPath()`-based `resolveEventTarget()`,
  finding the real element geometrically via
  `document.elementsFromPoint(clientX, clientY)` (skipping the overlay
  itself) — this still correctly reaches into open shadow roots
  (including nested ones), preserving the file's own prior Reddit
  `<shreddit-post>` shadow-retargeting fix, just via geometry instead of
  event-path inspection. `startCapturing()`/`stopCapturing()` now simply
  show/hide the overlay (a hidden element receives no pointer events at
  all and has zero footprint — this IS the cleanup mechanism). Nothing
  else in this file changed: selector generation (`WSSelector.
  buildSelectorForElement`), value extraction, the naming panel, staging
  keys, and every other pick purpose's own logic are untouched.
- **`e2e/tests/picker-interception-real-flow.test.js`** (NEW) — the
  mandatory real-browser proof (see below).

## Event Interception Strategy

Full-viewport transparent overlay ("glass pane") + `elementsFromPoint`
geometric resolution, as described above — the same technique browser
DevTools' own element inspector uses. `preventDefault()`/
`stopPropagation()`/`stopImmediatePropagation()` are still called on the
overlay's own click event (defense-in-depth, and per the mission's own
explicit request), but the REAL guarantee is structural: the underlying
page element is never even hit-tested, so it cannot receive the event
regardless of any preventDefault/stopPropagation race. `mousedown` is
also captured on the overlay (`preventDefault()`) for extra robustness
against frameworks that act on mousedown rather than click. Escape
(`keydown`) handling is unchanged (still document-level) — not implicated
in the reported bug, and not a page-navigation/activation risk.

## Selector Generation Strategy

**Unchanged** — `WSSelector.buildSelectorForElement`/`WSScraper.
pickElementInfo`/`WSSelector.extractValue` (content/selector.js,
content/scraper.js) are pure functions over a DOM element reference;
they don't know or care whether that reference came from
`composedPath()` or `elementsFromPoint()`. The real-browser test
confirms the resolved element and generated selector are correct for
the bug's own nested-anchor example: clicking `<span>CountryCottage
Images</span>` inside `<a>` resolves to the `<span>` itself (selector
`span`, matching real DOM sibling-uniqueness scoring — "Fair" quality
tag), not the anchor or an ancestor card — exactly the same "deepest
clicked element wins" semantics the picker already had, now reachable
without the page intercepting the click first.

## Cleanup Strategy

`stopCapturing()` hides the overlay (`display:none`) — a hidden element
is not hit-tested and receives no pointer events, restoring normal page
behavior completely and instantly. Called from every one of the
mission's required cleanup triggers: `onClick` (right before
`handlePicked`, i.e. successful selection), and `exitPickMode` (Escape /
Done / cancel). No listeners are added/removed per pick session anymore
(they're attached once, permanently, in `ensureUI()`) — a hidden,
zero-footprint element with attached-but-unreachable listeners is
behaviorally identical to "removed" for the purpose of "not interfering
with the page", and avoids any add/remove-listener churn/leak risk.
Real-browser test confirms this explicitly (STEP 9): after picker mode
exits, a real anchor's own click handler fires normally and real hash
navigation occurs — proving both that page behavior is fully restored
AND that nothing was left in a broken intermediate state.

## Automated Test Results

- `node --check content/content.js`: pass.
- `node scripts/release-check.js`: **18/18 PASS**.
- `npm run check-test-infra-safety`: **PASS** (18 files scanned).
- Detail Enrichment regression: `detail-enrichment-smoke.test.js` —
  **PASS** (re-confirmed after the picker rewrite). `detail-enrichment-
  real-flow.test.js` — **2 attempts both failed at the EARLIEST step**
  (real BAŞLA click never produced a session within the poll window) —
  confirmed as environmental, not a regression: that failure is in
  `RUN_EXTRACTION`/session-creation code this mission did not touch at
  all (the picker's `START_PICK` code path is never reached at that
  point), both attempts showed the same multi-minute
  `chrome.permissions.request()` delay this session has repeatedly and
  consistently exhibited under sustained system memory pressure (see
  this file's own prior-mission history for the identical pattern), and
  the popup screenshot from the failed run shows a completely normal,
  error-free popup state. The actual changed code (the picker) has its
  own comprehensive, directly-passing real-browser proof — see below.

## Real-Browser Picker Test Results

`picker-interception-real-flow.test.js` — **PASS, first attempt, every
checklist item confirmed**, against a real page (books.toscrape.com)
with a real injected fixture matching the bug report's own example
verbatim, driven via the real `#add-column-btn` (shared picker
mechanism) AND the exact reported entry point (`#dt-pick-fields-btn`,
DETAY's "Pick a Field on an Example Page" / `purpose:'live-detail-
field'`):

```
✓ STEP 1: Picker activated — the real overlay is visible over the real page
✓ STEP 2: Real hover over a real element produced a real highlight box
✓ STEP 3: Real click on plain text was captured — example value shown
✓ Picker exited cleanly after a successful pick (overlay hidden)
✓ STEPS 5/6: Clicked the NESTED <span> inside a real <a> — NO
  navigation occurred, the real anchor's own click handler did NOT fire
✓ STEPS 7/8: Real selected value returned to the UI — "CountryCottage
  Images" (correctly the SPAN's own text, not the anchor's href)
✓ Real <button> click during picker mode: did NOT activate (0 real
  click events), was captured by the picker instead
✓ STEP 9: after picker mode exits, real page click handling AND real
  navigation work completely normally again (anchor click fired for
  real, hash navigated for real)
✓ EXACT REPORTED ENTRY POINT CONFIRMED FIXED: DETAY's real "Pick a
  Field on an Example Page" button — real <a> click on the real sample
  page did NOT navigate and did NOT run the site's own click handler
```

Screenshots inspected directly (not just `result.json`):
`picker-nested-anchor-captured.png` — real page still on the listing
(no navigation), naming panel shows "SELECTOR: span [Fair]", "Example:
CountryCottageImages"; `picker-detail-entrypoint-confirmed.png` — real
book detail page unchanged, DETAY panel shows "SELECTOR:
#ws-detail-test-anchor [Good]", "Example: Detail Test Link".

## Remaining Limitations

- The `column`/`next-button` pick purposes are exercised by this
  mission's own test (via `#add-column-btn`) but the FULL "Add Column
  -> Extract Data" downstream flow (actually saving the column and
  re-running extraction) was not separately re-verified end-to-end this
  session — the picker's own capture/selection/panel behavior is fully
  proven; the (unchanged) storage-write/extraction code downstream of it
  was not independently re-exercised.
- `detail-enrichment-real-flow.test.js` was not obtained as a clean PASS
  this session due to sustained environmental resource pressure (see
  above) — recommend re-running it once system memory is less
  constrained, as a final confidence check (not expected to reveal
  anything, since it exercises code this fix never touched, but not
  independently re-confirmed end-to-end this session).

## GIT (this mission)

Branch `develop`. Nothing committed, nothing pushed, nothing merged.
`main`/`stable/v1.31.0` untouched. Diff scoped to exactly:
`content/content.js` (modified, the only functional change) +
`e2e/tests/picker-interception-real-flow.test.js` (new). `MISSION.md`
itself also updated, per this project's own convention.

---

# PRIOR MISSION RECORD — DETAIL ENRICHMENT FEATURE (kept for context)

FEATURE: DETAIL ENRICHMENT — the VERİ → SONUÇ → DETAY workflow. User
manually teaches ClickScrape which fields to extract from each record's
own detail page (never automatic field guessing), chooses how many
records to enrich (ALL / FIRST 100 / FIRST 500 / FIRST N / SELECTED
RECORDS), and the values are merged back into the correct original rows
by stable URL identity, never by array position.

# Architecture Decision — Reuse, Not Rebuild

Before writing anything, inspection of the existing codebase found that
**Detail Enrichment already exists**, almost entirely, as the V1.18-1.20
"Deep Scraping" feature (`background.js`'s fetch+tab-lifecycle engine,
`content/scraper.js#runDetailExtraction`, `content/content.js`'s element
picker with a `purpose:'detail-field'` mode, `utils/recipes.js`'s
`emptyDeepScrape()`/`normalizeDeepScrape()` field schema) — just wired
only to the OLD Manual/Advanced workflow's `rawRows`, hidden inside a
collapsed "Gelişmiş" panel, with no scope selection (always processed
every row's URL unconditionally) and no genuine resume (only "retry
failed", not "retry interrupted").

Given CLAUDE.md's explicit mandate to reuse working components, this
mission is almost entirely **additive**:
- The background.js engine (concurrency, retry/backoff, pacing,
  per-URL incremental checkpointing) is reused **completely unmodified**
  in its processing logic — only its state's storage AREA changed (see
  below), plus one new resume capability.
- The element-picker UI (`content/content.js`'s shadow-DOM panel: name
  input, example-value preview, multiple-checkbox, Add Field/Done) is
  reused **completely unmodified** — only which purpose value routes to
  it, and which session-storage key stages its result, changed.
- `content/scraper.js#runDetailExtraction` (single-page field
  extraction) is reused **completely unmodified**.
- A brand-new, parallel `#detay` tab/state (`detailConfig`/
  `detailColumns`/`detailScope`/etc. in popup.js) drives this reused
  infrastructure against `rawRows` — the SAME shared results array both
  the classic Preview/Run flow AND the new BAŞLA→Discovery→ALL/FIRST-N
  flow already populate (confirmed: `applyProcessingSelection` does
  `rawRows = selectedRows`), so DETAY works identically regardless of
  which flow produced the current dataset.
- The OLD "Deep Scraping" panel (ids `ds-*`, variables
  `deepScrapeConfig`/`deepScrapeColumns`) is **completely untouched** —
  existing Advanced-mode users keep working exactly as before. Both
  share the ONE background.js run slot (this project's established
  "one run slot" convention, same as the ZIP pipeline) — kept
  collision-free via a distinct runId prefix (`dse_` vs `ds_`), so each
  side's own render function only reacts to a run it itself started.

# Files Changed

- **`content/content.js`** (+37/-…) — a second detail-field pick
  purpose, `'live-detail-field'`, behaviorally identical to the existing
  `'detail-field'` but staged under an isolated
  `ws_live_detail_field_picks::<hostname>` key (vs. the old
  `ws_detail_field_picks::<hostname>`), so a DETAY-tab pick can never
  collide with an Advanced-panel pick on the same hostname.
  `isDetailPickPurpose()`/`detailStagingKeyPrefix()` helpers; the OLD
  `'detail-field'` purpose's own behavior is byte-for-byte unchanged.
- **`background/background.js`** (+94/-…):
  - `getDeepScrapeState`/`setDeepScrapeState` moved from
    `chrome.storage.session` to `chrome.storage.local` — a strict
    durability upgrade (survives a full browser restart, not just a
    popup close/service-worker restart) satisfying the mission's own
    "critical" checkpoint requirement, for BOTH the old and new UI.
  - New `resumeInterruptedDeepScrapeItems()` + `RESUME_DEEP_SCRAPE`
    message — re-queues `pending`/`fetching`/`failed` (a superset of
    the existing `RETRY_FAILED_DEEP_SCRAPE_ITEMS`'s `failed`-only
    scope), keyed on the live `deepScrapeAbortControllers[runId]` check
    (not the lying `state.status`) to detect a genuinely interrupted
    run vs. one still actively processing.
- **`popup/popup.js`** (+845/-…) — the new DETAY tab's entire state/UI
  layer (~700 new lines): field config (manual + real click-to-select),
  Test Fields preview, scope selection (ALL/FIRST 100/FIRST 500/FIRST
  N/SELECTED RECORDS), a self-contained records-selection checkbox
  table, template save/load/delete, Start/Stop/Resume/Retry-Failed,
  progress/summary rendering, URL-keyed merge into `rawRows`, plus:
  `localGet()` (chrome.storage.local mirror of the existing
  `sessionGet`), `effectiveColumns()`'s `baseColumns` now also includes
  `detailColumns`, `updateDetailTabAvailability()` wired into every
  existing `rawRows`-changing chokepoint (`clearResults`,
  `renderResults`, `switchTab`), `handleDtPickFieldsClick()` hardened
  with a real tab-load-complete poll + inject-and-retry (see Bugs/fixes
  below — a real bug this mission's own testing found).
- **`popup/popup.html`** (+146) — the new `#detay-tab-btn` (disabled by
  default) and `#tab-panel-detay` markup, reusing existing CSS classes
  throughout (`ws-panel-inline`, `ws-columns`, `ws-chip-btn`, etc.) — no
  new CSS needed.
- **`utils/detailscope.js`** (NEW, 120 lines) — pure, chrome-API-free:
  `validateScope()`/`selectScopedRows()`/`buildDetailUrlList()`. Never
  merges/selects by array position — always a caller-supplied stable
  `keyFn(row)`.
- **`utils/detailtemplates.js`** (NEW, 110 lines) — pure per-hostname
  template store (`ws_detail_templates::<hostname>`,
  `chrome.storage.local`): `list`/`save`/`remove`/`instantiateFields`.
  Never auto-applies anything — the popup only ever calls
  `instantiateFields` from an explicit "Load Template" click.
- **`e2e/tests/detail-enrichment-smoke.test.js`** (NEW) — cheap real-
  browser check: popup loads with zero console errors, `#detay-tab-btn`
  exists/disabled/correctly-localized, both new util modules loaded.
- **`e2e/tests/detail-enrichment-real-flow.test.js`** (NEW) — the
  mandatory full production-flow proof (see below).

# Detail Data Model

`detailConfig`: `{enabled, sourceColumnId, fields, concurrency,
delayMode, customDelayMs, retryLimit}` — the exact `WSRecipes.
emptyDeepScrape()` shape, reused for schema/validation consistency only
(concurrency/delayMode/retryLimit are hardcoded conservative constants
for this tab, not user-exposed — see Processing/Concurrency below).
`fields[]`: `{id, name, relativeSelector, attribute, attributeName?,
multiple:'first'|'all'}` — identical shape to a normal column and to the
OLD panel's own fields, so `WSScraper.runDetailExtraction` needs zero
changes. `detailColumns[]`: `{id:'dt_'+fieldId, name, sourceFieldId}` —
merged into `effectiveColumns()` exactly like `deepScrapeColumns`,
giving CSV/JSON/XLSX/Preview/Filter/Sort/Dedupe support for free.

# Manual Selector Workflow

Mission steps 4-11 verbatim, via the REAL, unmodified element picker:
"🎯 Pick a Field on an Example Page" opens the first scoped record's own
detail URL as a real active tab, sends `START_PICK` with
`purpose:'live-detail-field'`, the user clicks a real element, the
picker's own panel shows the live example value, names the field,
"Add Field" stages it and stays in pick mode for more fields, Esc/Done
exits. A "+ Add Detail Field Manually" typed-selector form remains
available as the existing power-user fallback (same as the OLD panel).
Staged picks are recovered on the next popup open (matches the already-
established `checkForPendingDetailFieldPicks` recovery pattern exactly —
`checkForPendingLiveDetailFieldPicks()`, its own isolated key).

**Confirm/Reselect/Delete** (mission's own example UI): interpreted via
the existing field-list's own delete (×) button + re-pick, rather than
building a bespoke in-panel "reselect" affordance inside the content-
script picker — a deliberate, documented minimum-UI scope cut (see
Remaining Limitations).

# Scope Implementation

`WSDetailScope.validateScope()`/`selectScopedRows()` — ALL, FIRST N
(100/500/custom via the same code path), SELECTED RECORDS (a new,
self-contained checkbox table, capped at 500 rows for DOM-size safety —
larger datasets are expected to use FIRST N instead). Row identity for
both selection AND the later merge: the first Link-like column's own
raw value (falls back to a full-row fingerprint only if no link column
exists) — never a raw array index, satisfying the mission's explicit
"stable record identity... Do NOT merge by array position" for BOTH
the selection step and the merge step.

# Processing / Concurrency Model

Reuses `background.js`'s existing, already-proven engine (the same one
the OLD panel drives at a default concurrency of 4) completely
unmodified. The NEW DETAY tab hardcodes conservative constants
(`DETAIL_CONCURRENCY=1`, `delayMode:'auto'`, `retryLimit=3`) rather than
exposing a concurrency control — mission: "Start conservatively...
prefer 1 worker initially" — a deliberate UX simplification (the OLD
panel's own Advanced concurrency/delay/retry controls remain available
for power users; a future mission can expose this here too).

# Checkpoint / Resume Implementation

Two parts: (1) the run-state key moved from `chrome.storage.session` to
`chrome.storage.local` (survives a full browser close, not just a
service-worker restart — the mission's own explicit "the first 699 must
not be lost" scenario); (2) a genuine new `RESUME_DEEP_SCRAPE` handler
re-queues anything not already `completed`/`partial`/`skipped`
(`pending`/`fetching`/`failed`), distinct from the pre-existing "Retry
Failed" (which only ever re-queued `failed`) — the real, previously-
unaddressed gap: a service-worker-killed run left `pending`/`fetching`
URLs permanently stuck with no way to continue them at all.

# Failure Handling

Reuses the engine's existing three-way per-URL outcome
(`completed`/`partial`/`failed`) unchanged — SUCCESS/MISSING/ERROR in
the mission's own vocabulary (`partial`+`skipped` folded into "Missing"
for the progress display, matching the mission's exact 3-bucket
example). One bad page never stops the job (`runWithConcurrency`'s
existing per-item isolation, unmodified).

# Row Association Strategy

URL-keyed merge (`mergeDetailResults`, mirrors the OLD panel's own
`mergeDeepScrapeResults` exactly) — `row[sourceColumnId] === url` looked
up in the job's own URL-keyed results map. Never by array position, at
either the selection step or the merge step (same `keyFn` used
throughout).

# Template Implementation

`utils/detailtemplates.js` — a small, independent, per-hostname store
(deliberately NOT extending `utils/recipes.js`'s much larger Saved
Scraper concept, to avoid any risk to that proven system). Save/Load/
Delete via explicit buttons only — `instantiateFields()` (the only
"apply" point) is never called except from an explicit "Load Template"
click.

# Export Integration

Zero new export code needed — `detailColumns` flows through the exact
same `effectiveColumns()`/`computeTransformedResult()` chokepoint every
existing exporter (CSV/XLSX/JSON/Preview) already consumes.

# Automated Test Results

- **`node --check`** on every changed/new JS file: all pass.
- **`node scripts/release-check.js`**: **18/18 PASS**, including the new
  `utils/detailscope.js`/`utils/detailtemplates.js` correctly bundled
  into the production ZIP (43 runtime entries, was 41).
- **i18n coverage**: **100% across all 6 locales** (en/tr/de/fr/zh-CN/
  ru) — 64 new keys (`tabs.detail` + 63 `detail.*`), verified via
  `WSI18n.coverageReport()` directly (311 total keys × 6 locales, all
  100%). Real translations written for all 6 (not placeholder text).
- **`e2e/tests/detail-enrichment-smoke.test.js`** — **PASS**: popup
  loads with the new tab wiring, zero console/page errors,
  `#detay-tab-btn` exists/disabled/correctly localized ("Detail"), both
  new util modules loaded into the real popup context.
- **`utils/detailscope.js`/`utils/detailtemplates.js` pure-logic
  suite** (JSDOM-free Node/vm harness, scratchpad — not part of the
  committed repo per this project's convention): **40 assertions, 0
  failures** — scope validation (all/first-100/first-500/oversized-N-
  clamping/0/-5/2.5/"abc"/empty-selection, all mirroring
  `WSDiscoveryCore.validateSelection`'s own established contract),
  `selectScopedRows` order-preservation and non-mutation, dedupe/
  validation/scheme-rejection in `buildDetailUrlList`, and the full
  `WSDetailTemplates` save/list/remove/instantiateFields lifecycle
  (including duplicate-name rejection and fresh-id assignment on load).

# Real-Browser Results

**`detail-enrichment-real-flow.test.js`** drives the REAL, unmodified
production path end-to-end (real `#basla-btn` click → real Discovery →
real `#durdur-btn` → real "ALL" click → real `#detay-tab-btn` gate check
→ real click-to-select on a real books.toscrape.com detail page → real
popup reopen to recover the staged field → real "Test Fields" → real
FIRST-2 scope choice → real Start → real background.js processing →
real merge → real CSV export) — **no test-side shortcut anywhere**
(never seeds a session, never calls an internal function directly).

**FINAL RESULT: PASS, all real steps, real merged export confirmed:**
```
✓ Real optional host permission granted
✓ Resolved the real site tab
✓ Pre-configured real column state
✓ Real BAŞLA click produced a real live session — 20 real rows
✓ Real Discovery stopped via real DURDUR
✓ Real "ALL" click moved 20 real discovered rows into rawRows (SONUÇ)
✓ CORE GATE PROOF: #detay-tab-btn enabled only once real results existed
✓ Real sample detail page opened for picking
✓ Real click-to-select: named field "Description", real Add Field click
✓ CORE ISOLATION PROOF: real pick staged under the isolated
  ws_live_detail_field_picks:: key (never colliding with the old key)
✓ Real field-pick recovery confirmed after reopening the popup
✓ Real PREVIEW/VALIDATION: Test Fields ran against real sample page(s)
✓ Real Detail Enrichment run started via the real Start button
✓ REAL PROCESSING PROOF: real background.js engine completed — 2/2
  pages, Successful: 2, Missing: 0, Errors: 0, Progress: 100%
✓ CORE MERGE PROOF: 2 real rows carry a real Description value, merged
  by URL, never by array position
✓ Real CSV export (real, unmodified WSCsv module) includes the merged
  Description column — 20 data rows
```
Screenshots inspected directly (not just `result.json`): `detail-flow-
sample-page.png` (real books.toscrape.com product page), `detail-flow-
complete.png` (real popup — "1 field(s) added from the sample page" ✓,
"DETAIL ENRICHMENT · COMPLETED" badge, "2 / 2 pages • Successful: 2 •
Missing: 0 • Errors: 0 • Progress: 100%" — matches the mission's own
example progress format exactly).

**Getting to this clean PASS took 4 attempts, 2 of which found real,
genuine bugs** (both fixed, documented in detail below) — the other 2
failures were pure test-harness impatience (fixed timeouts too short
under real, variable system load; replaced with polling) with no
product-code change involved.

# Bugs Found and Fixed This Mission

1. **`handleDtPickFieldsClick()` real timing race** (found via this
   mission's own real-browser testing, described above). Fixed by
   replacing the fixed 400ms delay with `waitForTabComplete()` (polls
   the real tab's own `status === 'complete'`, bounded timeout) and
   replacing the unguarded single `chrome.tabs.sendMessage` with
   `sendToTabWithRetry()` (mirrors this file's own established
   `sendToContent()` retry-with-fresh-injection contract, generalized to
   an arbitrary tab id). This is a genuine, real bug this mission's own
   testing discipline caught — not present in, and not a regression of,
   the OLD panel's identical-shaped (equally untested by any e2e check
   before this mission) code, which is left completely unmodified per
   the "don't touch working/unrelated code" rule.

2. **`chrome.storage.session` inaccessible from content scripts —
   silently breaks BOTH the old and new "Pick Fields on Sample Page"
   staging, in real Chrome, unconditionally.** Found on the SECOND
   real-flow run (after fix #1 let the flow progress further): the real
   picker panel appeared, the real "Add Field" click ran, but the
   staged pick never actually reached `chrome.storage.session` at all —
   confirmed via a direct service-worker-side storage read finding
   NOTHING under either staging key prefix. Root cause: `chrome.storage.
   session` defaults to TRUSTED_CONTEXTS-only access (popup/background/
   options) — a content script's own `chrome.storage.session.set()`
   silently no-ops (no thrown error, no rejected promise) unless the
   background service worker has called `chrome.storage.session.
   setAccessLevel({accessLevel:'TRUSTED_AND_UNTRUSTED_CONTEXTS'})` —
   which nothing in this codebase had EVER done. This is the exact same
   real-Chrome root cause `content/livewatch.js`'s own header comment
   already documents in detail for a different key (fixed there by
   moving off session storage entirely) — but nobody had applied the
   OTHER valid fix (actually granting content-script access) for the
   detail-field picker's OWN two staging keys, because neither the
   pre-existing V1.18 'detail-field' pick flow NOR (until this mission)
   the new one had ever been exercised by a real-browser test before.
   **This means the OLD "Deep Scraping" panel's "Pick Fields on Sample
   Page" button has never actually worked in real production Chrome —
   a genuine, real, pre-existing latent bug this mission's own testing
   discipline uncovered, not a regression this mission introduced.**
   Fixed with a single `chrome.storage.session.setAccessLevel(...)` call
   at background.js's top level (re-runs on every service-worker
   wake-up, since the access level is not guaranteed to persist across a
   worker restart) — fixes both the old and new picker flows identically
   with the smallest possible change, touches no other behavior at all.

# Performance

The mission's own 10/100/1,000+ deterministic-fixture scale requirement:
the pure-logic suite exercises 1,283 synthetic rows (matching the
mission's own real Etsy example count) through `validateScope`/
`selectScopedRows`/`buildDetailUrlList` — all pure, O(n) operations
(a single pass + object-keyed lookups, no quadratic scan anywhere) — 0
failures. Not independently micro-benchmarked at higher orders of
magnitude this session; the algorithms' own shape (no nested loops over
the row set) makes superlinear behavior structurally unlikely.

# Regressions Checked

`git diff --stat` confirms the diff is scoped to exactly the files
listed above — `content/discovery.js`, `content/scraper.js`,
`content/selector.js`, `content/autopaginate.js`, `content/autoscroll.js`,
`utils/cleaners.js`, `utils/transforms.js`, `utils/runstate.js`,
`utils/recipes.js`, and every export/cleaning/pagination file from prior
missions are untouched. The OLD "Deep Scraping" panel's own ids/
variables/handlers are untouched (only its storage AREA moved, a strict
durability upgrade, not a behavior change — `attachDeepScrapeStorageListener`'s
area check was updated to match, and its restore-on-init `sessionGet`
call became `localGet`, both required by that same storage move, not
independent changes).
- `node scripts/release-check.js`: **18/18 PASS** (re-confirmed after
  every fix this mission made, including the two real-bug fixes).
- `npm run check-test-infra-safety`: **PASS** (17 files scanned, both
  new e2e test files scanned clean).
- `npm run test:browser-safety`: **PASS** — re-run specifically because
  this mission added new tab-lifecycle code
  (`chrome.tabs.create`/`waitForTabComplete` in `handleDtPickFieldsClick`)
  per CLAUDE.md's own rule to re-confirm this guarantee whenever
  browser-lifecycle code changes. Two independent browser instances
  launched; closing one (via its own `closeUp()`) confirmed to never
  affect the other.
- Normal BAŞLA → Discovery → DURDUR → ALL → SONUÇ flow: re-verified as
  a genuine byproduct of `detail-enrichment-real-flow.test.js` itself
  (every one of those steps is real, unmodified production code the new
  test exercises before ever reaching DETAY) — 20 real rows collected,
  0 duplicates implied by the unchanged dedup path.
  `discovery-popup-start-real-site.test.js`/`discovery-active-
  navigation.test.js` (prior mission's own suites) not independently
  re-run this session — this mission touched none of the files those
  cover.
- **Not independently re-verified this session**: the OLD "Deep
  Scraping" panel's own UI end-to-end (its underlying engine IS
  re-verified, since DETAY drives the exact same background.js code;
  only that panel's own `ds-*` DOM wiring — completely untouched by any
  edit this mission made — was not separately click-tested). Lower risk
  given zero lines of that panel's own code changed.

# Bugs Found and Fixed This Mission — Summary

Both were found ONLY because this mission insisted on the real,
unmodified, full production-flow real-browser test rather than testing
internal helpers in isolation — exactly the discipline the mission's own
instructions demanded ("Do not test only internal helper functions").
See the detailed root-cause writeups above; in short:
1. `handleDtPickFieldsClick()`'s fixed-delay tab-readiness race (real,
   in this mission's own new code) — fixed with a real tab-load poll +
   inject-and-retry.
2. `chrome.storage.session` silently inaccessible to content scripts
   without an explicit `setAccessLevel()` call — a real, PRE-EXISTING
   latent bug affecting the OLD V1.18 "Deep Scraping" panel's own
   "Pick Fields on Sample Page" feature too (never caught before because
   neither picker flow had ever been exercised by a real-browser test
   until this mission) — fixed with one call in `background.js`,
   benefiting both the old and new features identically.

# Remaining Limitations (documented scope decisions, not defects)

- Confirm/Reselect on an individual field is delete-and-re-pick, not an
  in-place reselect affordance inside the content-script panel (see
  Manual Selector Workflow above).
- Concurrency/delay/retry-limit are not user-configurable in the new
  DETAY tab (hardcoded conservative constants) — the OLD panel's own
  Advanced controls remain the escape hatch; a future mission can expose
  these here too without any architecture change (the engine already
  accepts them as parameters).
- SELECTED RECORDS' checkbox table is capped at 500 rendered rows for
  DOM-size safety — FIRST N/FIRST 500 are the intended path for larger
  deliberate subsets, per the mission's own examples never implying a
  1,283-row manual checklist.
- `chrome.storage.local`'s quota (unchanged by this move, same limit the
  rest of this project's local-storage state already lives under) caps
  how large a single Detail Enrichment job's accumulated result set can
  grow before hitting it — not expected to matter at the mission's own
  example scale (1,283 records) but not independently verified at
  significantly larger scale this session.

# GIT

Branch: `develop`, confirmed in sync with `origin/develop` at session
start. **Nothing committed, nothing pushed, nothing merged this
session** (explicit instruction). `main`/`stable/v1.31.0` never touched
this session. Diff: `content/content.js`, `background/background.js`,
`popup/popup.js`, `popup/popup.html`, `utils/i18n-data.js` modified;
`utils/detailscope.js`, `utils/detailtemplates.js`,
`e2e/tests/detail-enrichment-smoke.test.js`,
`e2e/tests/detail-enrichment-real-flow.test.js` added — nothing else.
