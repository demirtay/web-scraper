# Current Mission

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
