# Current Mission

**Status: COMPLETE**

Implement, harden, and real-browser-verify an AUTOMATIC DATA DISCOVERY
ENGINE for ClickScrape: the user configures columns, then ClickScrape
automatically discovers every accessible unique record through the
current result/listing flow — deciding entirely on its own whether more
records are reached via pagination, infinite scroll, Load More, or a
hybrid — reports an honest "N records found", and only THEN lets the
user choose ALL or FIRST N to process into the final dataset. Discovery
and Processing are architecturally separate. Existing engines (Auto Next,
Auto Scroll) are reused as internal capabilities, not rewritten.

# Acceptance Criteria — Definition of Done

- [x] Existing architecture inspected before writing anything
- [x] `develop` confirmed synced with `origin/develop` at session start
- [x] Discovery and Processing kept as separate concepts
- [x] Automatic discovery orchestrator implemented (`content/discovery.js`)
- [x] User no longer selects Next/Scroll mode (BAŞLA always starts
      discovery; legacy toggles' checked state is no longer read)
- [x] Existing Auto Pagination (`content/autopaginate.js`) reused/preserved, untouched
- [x] Existing Infinite Scroll (`content/autoscroll.js`) reused/preserved — its
      own `runUntilExhausted()` is called directly, unmodified logic
- [x] Load More detection implemented safely (`content/loadmore.js`)
- [x] Pagination discovered automatically
- [x] Infinite Scroll discovered automatically
- [x] Load More discovered automatically
- [x] Hybrid traversal supported (scroll+pagination proven real; Load
      More+pagination proven via fixture)
- [x] Current page exhausted before premature Next
- [x] Unique discovery registry persists (`session.rows`, reused mechanism)
- [x] Canonical/stable dedupe works (reuses `WSRunState.mergeNewRows`)
- [x] Stable discovery order works
- [x] Virtualized DOM does not lose records
- [x] Slow-load protection works (no premature finish)
- [x] False Next protection works
- [x] False Load More protection works
- [x] Loop protection works
- [x] Global completion logic works
- [x] No fabricated totals
- [x] No fabricated records
- [x] Stop preserves partial discovery
- [x] `processAll()` works
- [x] `processFirst(n)` works
- [x] Invalid N handled safely (0, -5, 2.5, "abc", NaN, over-large — never crashes, never fabricates)
- [x] Data Cleaning remains compatible (untouched; regression-verified)
- [x] Templates remain compatible (untouched; regression-verified)
- [x] Session persistence remains compatible
- [x] 10,000-record performance fixture passes
- [x] Focused tests pass
- [x] Full regression has no new related failures
- [x] `release-check.js` passes
- [x] Real paginated site tested automatically (books.toscrape.com)
- [x] Real infinite-scroll site tested automatically (quotes.toscrape.com/scroll)
- [x] At least 3 growth cycles verified where available (3 real pages; 3 real scroll cycles)
- [x] Real FIRST-N processing verified (real, in-tab `WSDiscoveryCore` calls)
- [x] Real ALL processing verified on a reasonable real dataset
- [x] Screenshots/logs/result artifacts inspected (not just status text)
- [x] `main` untouched
- [x] `stable/v1.31.0` untouched
- [x] Nothing committed
- [x] Nothing pushed

# ARCHITECTURE

**Files changed:**
- New: `utils/discovery.js`, `content/loadmore.js`, `content/discovery.js`,
  `e2e/tests/discovery-pagination-real-site.test.js`,
  `e2e/tests/discovery-scroll-real-site.test.js`.
- Modified: `popup/popup.js` (BAŞLA/BİTİR/DURDUR wiring + Processing API),
  `popup/popup.html` (+1 script tag), `background/background.js` /
  `popup/popup.js` (`CONTENT_FILES` arrays), `content/autoscroll.js` (+1
  coordination guard in its bootstrap), `content/livewatch.js` (+1
  coordination guard in its passive watcher), `package.json` (+2 npm scripts).

**Orchestrator design:** `content/discovery.js`'s per-page loop is: scrape
→ Auto Scroll to exhaustion → Load More to exhaustion → find Next → click
→ wait → repeat. It seeds and owns its own internal `session.autoScroll`/
`session.loadMoreAuto` sub-objects — deliberately never the user-toggle-
driven fields `content/autopaginate.js`'s/`content/autoscroll.js`'s own
standalone message listeners respond to — so the existing explicit-toggle
code paths (and their own real-browser tests) stay completely untouched
and independently functional, while discovery always runs both engines
automatically.

**Discovery vs. Processing:** Discovery accumulates the full, deduplicated,
stably-ordered dataset directly into `session.rows` via the *existing*
`WSRunState.mergeNewRows` mechanism — the exact same one BAŞLA/Auto
Next/Auto Scroll always used. Processing (`processAll()`/`processFirst(n)`
in `popup.js`) is therefore never a second extraction pass — it is purely
"select ALL or the FIRST N of the already-fully-extracted registry, in
stable discovery order" (pure logic in `utils/discovery.js`), then hand
that selection to the completely unmodified existing pipeline
(`rawRows` → `computeTransformedResult` → Data Cleaning → preview/export).

**Reuse of Auto Pagination:** `content/nextdetect.js`'s `findNextControl()`
used directly, unmodified — same false-positive protections (carousel/
slider/modal/ad exclusion, container exclusion) as the existing Auto Next feature.

**Reuse of Auto Scroll:** `content/autoscroll.js`'s `runUntilExhausted()`
called directly, unmodified — the exact same function `content/
autopaginate.js`'s own combined mode already called before this mission.

**Load More implementation:** `content/loadmore.js`, built to the identical
`runUntilExhausted(session, host, controller, skipInitialScrape)` contract
as Auto Scroll. Detection is page-wide (mirroring `content/nextdetect.js`'s
own proven approach) — positive phrase match ("Load More"/"Show More"/
"More Results"/"View More" + Turkish equivalents, allowing a trailing
generic noun) AND rejection on any narrow-context negative word (review/
description/comment/photo/detail/etc.), plus exclusion of per-card buttons
and ad/carousel/modal wrappers. No standalone message listener/bootstrap
of its own — `content/discovery.js` is its only caller, so there is never
more than one driver of any engine on a session.

# AUTOMATIC DETECTION

- **Pagination detection:** reused `WSNextDetect.findNextControl()` verbatim.
- **Infinite-scroll detection:** reused `WSAutoScroll.runUntilExhausted()`
  verbatim — its own card-count/height growth signals, MutationObserver-backed.
- **Load More detection:** new, page-wide phrase-match + negative-word
  rejection (see above).
- **Hybrid strategy:** per-page order is scroll → Load More → Next, never
  navigating away while the current page can still reveal more (mission
  section 6). A same-page scroll↔Load-More re-alternation beyond one pass
  is a deliberate, documented scope limit (see Limitations) — every
  mission-specified hybrid example (scroll-then-paginate, several Load
  More clicks before a Next) is exactly this file's own loop, unmodified.
- **Traversal priority:** current-page expansion is always exhausted
  (scroll AND Load More, both to their own natural stop) before Next is
  even looked for.

# DISCOVERY

- **Identity strategy:** reuses the existing `pickDedupeKeyForColumns`
  (prefer a link-like column) → `WSRunState.buildRowKey`/`mergeNewRows`
  dedup mechanism, unmodified — canonical URL when available, else the
  existing `entire-row` fingerprint fallback.
- **Unique registry:** `session.rows`, in `mergeNewRows`'s own
  always-append-never-reorder order — no second parallel registry.
- **Stable ordering:** guaranteed by `mergeNewRows`'s own contract; verified directly (10k fixture, `processFirst` order checks, real FIRST-N test).
- **Dedupe:** reused, unmodified; duplicate-encounter accounting
  (`WSDiscoveryCore.recordExpansionDelta`) is a new, additive, best-effort
  diagnostic layered on top via a before/after candidate-count delta
  around each expansion phase — matches every one of the mission's own
  worked examples exactly (60+20-with-5-dupes→75 not 80; 1-20/18-40
  overlap→40 not 43).
- **Virtualization handling:** free consequence of reusing
  `mergeNewRows`/`session.rows` — verified directly (TEST 43: a sliding
  1-20→11-30→21-40 DOM window still yields the full 1-40 registry).
- **Persistence:** `session.discovery` lives on the same
  `ws_live_session::<hostname>` object every other live-session field
  already uses — survives popup close/reopen and navigation via the
  existing storage mechanism, no new persistence layer.

# COMPLETION

- **No-growth strategy:** reused verbatim from Auto Scroll/Load More's own
  `consecutiveNoNewData >= maxNoNewDataAttempts` (default 3) — never stops
  after one slow load.
- **Global completion conditions:** current-page expansion exhausted (both
  engines) AND no valid Next AND no genuinely new records →
  `discovery_complete`.
- **Loop detection:** `WSDiscoveryCore.buildTraversalStateId`/
  `registerVisitedState` — url+content-signature+unique-count triple,
  bounded history (4000 entries) — catches an exact-repeat loop and an
  alternating-URL loop within a few cycles (verified: TEST 47, pure-core test).
- **Safety limits:** `maxPages` (2000), `maxTotalCycles` (20000), and a
  hard `MAX_LOOP_ITERATIONS` (6000) ceiling — all high, documented,
  reported honestly via `stopReason`/`safetyLimitReached: true`, never
  silently presented as a natural `discovery_complete`.
- **Stop reasons observed in testing:** `no-more-mechanisms`, `next-disabled`,
  `traversal-loop-detected`, `origin-changed`, `url-repeat`,
  `page-load-timeout`, `extraction-error`, `max-pages-safety-limit`,
  `max-total-cycles-safety-limit`, `max-loop-iterations-safety-limit`, `user`.

# PROCESSING

- **`processAll()`/`processFirst(n)`:** in `popup.js`, operating on
  `activeLiveSession.rows` via `WSDiscoveryCore.validateSelection`/
  `selectRows` (pure, in `utils/discovery.js`). No dedicated UI wires these
  yet (explicitly out of this mission's scope — see CLAUDE.md) — exposed
  via `window.__wsDiscoveryTestHooks`, the same "exposed for targeted
  testing only" convention this codebase already uses
  (`WSAutoPaginate.runAutoPaginateLoop`, `WSLiveWatch.runDetectionPass`).
- **Data Cleaning integration:** untouched — processing only narrows
  `rawRows`, which flows into the exact same `computeTransformedResult()`
  → cleaner → transform pipeline as before.
- **Ordering guarantees:** FIRST N always means the first N unique records
  in real discovery order — verified via the 10k fixture and the real
  in-tab FIRST-N test (first selected row's title matched the actual
  first discovered row).
- **Invalid N:** 0/-5/2.5/"abc"/NaN/undefined/null all rejected with a
  structured `{ok:false, error}`, never a crash; an over-large N
  normalizes (clamps) to the real discovered count rather than fabricating rows.

# PERFORMANCE

- **10,000-record test:** `test-discovery-core.js`'s fixture — 10,000
  unique records (with injected re-sent duplicates) processed via the
  REAL `WSRunState.mergeNewRows` in ~10ms, stable order preserved,
  `processFirst` against the real 10k dataset verified.
- **Runtime:** O(n) per pass (hash-map-based `seenKeys`, reused unmodified
  from `WSRunState`) — no O(n²) duplicate checks introduced.
- **Memory:** discovery adds only small, bounded fields to the existing
  session object (`visitedStates`/`visitedUrls`/`pageSignatures`, all
  capped) — no per-record metadata duplication, no DOM/screenshot storage.

# AUTOMATED TESTS

- **`test-discovery-core.js`** (scratchpad, plain Node, no DOM): **53/53
  assertions, 0 failures.** `validateSelection`/`selectRows` (ALL, FIRST N,
  every invalid-N case, over-large-N normalization), duplicate-encounter
  accounting matching the mission's own worked examples exactly,
  visited-state loop detection (exact repeat + alternating-URL loop), and
  the 10,000-record performance/dedupe fixture.
- **`test-discovery-fixtures.js`** (scratchpad, JSDOM via
  `vm.runInContext` — the REAL, unmodified `content/discovery.js` +
  `content/loadmore.js` + REUSED `content/autoscroll.js`/`content/
  nextdetect.js`/`content/domwait.js`/`utils/runstate.js`, only
  `WSScraper.runExtraction` stubbed to read the real live DOM): **35/35
  assertions, 12/12 scenarios pass** — mission TEST sections 37 (basic
  pagination), 38 (basic infinite scroll), 39 (Load More), 40 (hybrid), 41
  (duplicates), 42 (pagination overlap), 43 (virtualized list), 44 (slow
  load), 45 (false Next), 46 (false Load More), 47 (looping Next), 51
  (Stop Discovery).
- **`test-regression-existing.js`** (scratchpad): **25/25 assertions, 0
  failures.** `utils/cleaners.js`, `utils/templates.js`, `utils/
  runstate.js` spot-checks, plus direct verification of this mission's two
  coordination-guard additions (`content/autoscroll.js`'s bootstrap
  correctly excludes a discovery-owned session while its PRE-EXISTING
  autoPaginate exclusion and ordinary standalone-resume behavior remain
  unaffected; `content/livewatch.js` correctly defers to an active
  discovery session while its ordinary passive-watch behavior remains
  unaffected).
- **`test-popup-processing.js`** (scratchpad, JSDOM, real `popup.html` +
  every real script it loads via `vm.runInContext`, real `chrome.tabs.
  query` returning a real http(s) URL — this project's own "bootPopup()"
  convention): **28/28 assertions, 0 failures, 0 console errors during
  real `init()`.** A real 250-row discovered session is restored by the
  real, unmodified `restoreLiveSessionIfAny()`; `processFirst(50)`,
  every invalid-N case, over-large-N normalization, `processAll()`, and a
  second `processFirst(10)` are all exercised through the real
  `window.__wsDiscoveryTestHooks` seam; the real, persisted session
  (verified by re-reading `chrome.storage.local`) correctly shows
  `discovery.status: 'processing_complete'` and the real
  `processingSelection`, with `session.rows` (the full registry) provably
  intact and un-destroyed.
- **`node scripts/release-check.js`: 18/18 checks pass** — the three new
  files are correctly picked up by the dynamic `CONTENT_FILES`/directory
  scans (16 content scripts, up from 13), 100% i18n coverage unaffected
  (no new user-facing strings — discovery's page-count status reuses the
  existing `liveSession.scanningPage` key), production ZIP builds and
  packages cleanly (41 entries).
- **Full regression:** no new related failures across cleaners/templates/
  runstate/session-persistence/coordination.

# REAL PAGINATION TEST

- **Site:** `https://books.toscrape.com/` (same site the pre-existing
  Auto Next real-site test uses).
- **URL:** `https://books.toscrape.com/`
- **Trigger:** a single `START_DISCOVERY` message — `START_AUTO_PAGINATE`/
  `START_AUTO_SCROLL` were never sent.
- **Initial count:** 20 real rows (page 1).
- **Pages traversed:** 3 real pages (page-2.html, page-3.html reached
  automatically), confirmed via real screenshots showing genuinely
  different books and "Page 3 of 50".
- **Growth per page:** 20 → 40 → 60 (exactly 20 real, distinct books per page).
- **Final unique count:** 60, `discoveredUnique === session.rows.length` exactly.
- **Completion/stop reason:** stopped on command (`STOP_DISCOVERY`,
  `stopReason: 'user'`, `discoveryComplete: false`) after 3 pages —
  books.toscrape.com has 50 real pages (1000 books), and with genuine
  production timeouts (not test-shortened), running the engine to full
  natural site exhaustion would take on the order of 15-20 minutes; the
  mission's own real-pagination test spec (section 55) only requires "at
  least 3 real pages... record exact counts", already satisfied.
- **Also verified on this real dataset:** 0 duplicate product links across
  60 rows; real, in-tab `WSDiscoveryCore.validateSelection`/`selectRows`
  FIRST-10 selection (exactly 10, stable order, first row matched) and ALL
  selection (60 of 60).
- Screenshots inspected directly: `discovery-initial.png` (real "1000
  results - showing 1 to 20"), `discovery-growth-2.png` (real "Page 3 of
  50" with different books) — genuinely confirms automatic real navigation.

# REAL INFINITE SCROLL TEST

- **Site:** `https://quotes.toscrape.com/scroll`.
- **Trigger:** a single `START_DISCOVERY` message — `START_AUTO_SCROLL` was never sent.
- **Initial count:** 10 real quotes.
- **Scroll cycles:** 3 real, distinct growth cycles observed automatically.
- **Growth per cycle:** +10 real quotes each (10 → 20 → 30 → 40).
- **Final unique count:** 40 at the growth checkpoint, growing further to
  60 during the brief window before Stop was confirmed — `discoveredUnique
  === session.rows.length` verified exactly on the post-Stop settled snapshot.
- **Completion/stop reason:** stopped on command (`STOP_DISCOVERY`,
  `stopReason` not asserted post-hoc but state correctly `discovery_stopped`,
  `discoveryComplete: false`) after sufficient real growth evidence —
  the site has 100 quotes total; running to full natural exhaustion was
  unnecessary given the mission's own "at least 3 growth cycles" bar was
  already cleared.
- Also verified: the very first quote/author from before scrolling started
  is still present after growth (virtualization-safe); 0 duplicate rows
  across the accumulated dataset.
- Screenshots inspected directly: `discovery-scroll-initial.png` (Einstein/
  Rowling quotes) vs. `discovery-scroll-final.png` (Twilight/Hemingway/
  Helen Keller quotes further down) — genuinely different real content,
  confirming real automatic scrolling occurred.

# REAL LOAD MORE / HYBRID

Load More and same-page scroll+Load-More hybrids were **not** verified
against a real public site this session (no stable, suitable public Load
More demo site was located within this mission's time budget). Per the
mission's own explicit allowance (sections 57/58: "If no stable public
Load More site is available, fixture/integration verification is
acceptable... document honestly"), this mechanism is verified instead via
the JSDOM fixture suite (`TEST 39` — Load More alone reaches 60 unique via
3 real click-driven growth cycles against the real, unmodified `content/
loadmore.js`; `TEST 40` — a hybrid scroll+Load-More+pagination scenario;
`TEST 46` — false-Load-More rejection against real, unmodified detection
logic), which exercises the genuine production code path end-to-end
against a real DOM, with only the site itself (not the engine) simulated.
Documented honestly here rather than overclaimed.

# REAL PROCESSING TEST

- **Discovered count:** 60 (books.toscrape.com run).
- **FIRST N selected:** 10 — `WSDiscoveryCore.validateSelection`/
  `selectRows` called for real, inside the live tab, against the real
  discovered rows.
- **Processed count:** exactly 10, stable order (first selected row's
  title matched the real first-discovered row's title).
- **ALL test result:** 60 of 60 selected.
- **Representative cleaned fields:** Title/Link/Price columns extracted
  live from the real site (e.g. real book titles, real `£NN.NN` prices,
  real `catalogue/...html` links) — the FIRST-N/ALL selection operates on
  these same real, already-cleaned-compatible row objects; Data Cleaning
  itself is unmodified by this mission (verified separately in the
  regression suite).
- Additionally, the full `processAll()`/`processFirst(n)` **popup-level**
  integration (not just the shared core) was verified via
  `test-popup-processing.js` against a real, restored 250-row session —
  see Automated Tests above.

# EVIDENCE

`test-artifacts/latest/`: `discovery-initial.png`, `discovery-growth-1.png`,
`discovery-growth-2.png`, `discovery-complete.png` (pagination run);
`discovery-scroll-initial.png`, `discovery-scroll-growth-1.png`,
`discovery-scroll-growth-2.png`, `discovery-scroll-final.png`,
`discovery-scroll-complete.png` (scroll run); `test.log`, `result.json` —
all visually inspected, not just trusted from status text. One harmless,
pre-existing, site-side console artifact observed on both real sites (a
mixed-content HTTP jQuery CDN reference blocked by the browser on
books.toscrape.com, and an "Access to storage is not allowed from this
context" warning on both — the same class of pre-existing, unrelated
site/extension-boundary console noise prior missions in this project have
already observed and documented; does not affect extraction/discovery).

# REGRESSIONS

Confirmed via the regression suite: `utils/cleaners.js` (RAW/TEXT/PRICE/
NUMBER/URL), `utils/templates.js` (`cleanerType` normalization/defaults),
`utils/runstate.js` (hostname normalization, dedup/order) all still behave
identically. This mission's two small coordination additions verified to
(a) actually prevent a double-driver race with the new engine and (b)
leave every pre-existing coordination path (autoPaginate↔autoScroll↔
livewatch, ordinary standalone Auto Scroll resume, ordinary passive
live-session watching) completely unaffected. `content/autopaginate.js`
and its own real-site test are entirely untouched by this mission.

# REAL BUGS FOUND AND FIXED VIA THIS MISSION'S OWN TESTING

1. **`content/loadmore.js` detection-scope bug:** an initial "common
   ancestor of the first/last known card" scoping heuristic degenerated to
   the card container element itself for the ordinary one-shared-parent
   markup shape (a node trivially "contains" itself), incorrectly hiding a
   real Load More button sitting as the container's own sibling — a very
   common real-world pattern. Fixed by dropping the DOM-proximity
   restriction entirely (mirroring `content/nextdetect.js`'s own
   page-wide-scan-plus-phrase-matching approach).
2. **Race: a Stop request could be silently clobbered by a fabricated
   "discovery_complete"** (a direct violation of mission section 23),
   found via a dedicated fixture test (TEST 51) and confirmed reachable in
   the real browser too. Root cause: `chrome.storage.local.get()`
   resolves with a snapshot frozen at CALL time, not callback-fire time —
   an in-flight engine call aborted mid-wait can re-read storage on its
   own way out at a moment that predates a concurrent `STOP_DISCOVERY`
   request's own write, even though its callback fires after. No amount
   of "re-read fresh right before the terminal write" fully closes this.
   Fixed with a synchronous, in-memory `discoveryStopRequested` flag — set
   in the same tick as `controller.abort()`, checked first (no storage
   round-trip) by `stillRunning()` and by `finalizeComplete`/
   `finalizeStopped` — closing the race completely regardless of storage-read timing.
3. **`pagesVisited` undercounting after a real navigation:** found via the
   real books.toscrape.com run — a real full-page navigation can (and,
   observed directly, does) destroy the outgoing content-script instance
   before its post-navigation bookkeeping write lands (the exact same
   real-Chrome race `content/autopaginate.js`'s own bootstrap comment
   documents in detail for its own counter). The counter was being
   incremented in the wrong place (after the risky navigation, mirroring a
   naive design) instead of the moment a new page is confirmed scraped
   (mirroring `content/autopaginate.js`'s own battle-tested placement).
   Fixed by moving the increment (and the analogous per-page duplicate-
   accounting baseline reset) to the scrape branch itself, which the fresh
   post-navigation script instance reliably executes and persists.
4. **`discoveredUnique` momentarily lagging `session.rows.length`:** found
   via the real quotes.toscrape.com run — `content/autoscroll.js`'s/
   `content/loadmore.js`'s own per-cycle writes (reused completely
   unmodified, by design) persist the session mid-phase with whatever
   `discoveredUnique` happened to be at that moment, always caught up
   again at the next phase boundary — but a poll landing exactly mid-phase
   could observe a lagging (never fabricated-ahead) value. Fixed by having
   every terminal-state write (`finalizeComplete`, `finalizeStopped`, the
   `STOP_DISCOVERY` handler) reconcile `discoveredUnique = rows.length`
   one final time, guaranteeing exact equality at any settled/rest state;
   documented as a narrow, accepted, non-user-visible limitation during an
   actively-running multi-cycle phase (the user-visible row count has
   always read `rows.length` directly, never this field).
5. Two test-harness-only bugs (not product bugs), found and fixed while
   writing the fixture suite: simulating "pagination naturally ends" via a
   *separate* extra click that only removes the Next control (a
   single-node removal produces too few mutations to cross
   `waitForNavigationOrMutation`'s own mutation threshold) instead of
   atomically as part of the *last real* page-advance; and a flat, shared
   scroll/Load-More "call count" schedule silently misaligning once an
   engine's own internal no-growth retry count differed page-to-page
   (fixed with a per-page schedule).

# LIMITATIONS

- Real Load More / hybrid-on-one-page traversal is verified via fixture
  only (see "REAL LOAD MORE / HYBRID" above) — no suitable stable public
  Load More demo site was located this session; documented honestly per
  the mission's own explicit allowance rather than overclaimed.
- `discoveredUnique` can lag `session.rows.length` by a small margin
  *while a scroll/Load-More phase is actively mid-flight* (never ahead,
  never fabricated) — guaranteed exact at every terminal/rest state (see
  bug #4 above). Not user-visible today (the live row count shown anywhere
  in the product reads `rows.length` directly).
- A real hybrid site whose *same page* alternates between scroll and Load
  More more than once (scroll a bit, click Load More, scroll again, click
  Load More again, all on ONE page) is handled with a single pass of each
  per page visit, not a full alternation — a deliberate, documented scope
  limit; every mission-specified hybrid example (different mechanisms on
  different pages, or several same-mechanism actions before a Next) is
  fully supported.
- `siteAdvertisedTotal` (an optional, purely informational field the
  mission explicitly allows) is not populated by any generic detection
  logic this session — left `null` always; never influences the
  authoritative `discoveredUnique` count either way.
- `popup.js`'s BAŞLA → `session.discovery` seeding + `START_DISCOVERY`
  send is verified by careful code review and by the fact that the exact
  downstream contract it produces (a session with `discovery` seeded +
  a `START_DISCOVERY` message) is exhaustively proven correct by both the
  fixture suite and the two real-browser tests, plus `popup.js` as a whole
  loading and running cleanly (0 console errors) through its full
  session-restore/processing path in `test-popup-processing.js` — the BAŞLA
  click handler itself was not driven end-to-end via a real DOM click in
  this session (its surrounding column-picking UI is unrelated to this
  mission and wasn't set up in the harness); this is a narrower gap than
  the fully-proven downstream mechanism, not a known defect.
- `chrome.permissions.request()` continued to exhibit the same
  previously-documented wide timing variance in this environment
  (observed 3s to ~50s across attempts this session) — confirmed
  environment-level, not caused by this mission's code.
- Running the real-browser scenarios as *background* shell tasks was
  observed to get killed by the environment partway through, three times
  in a row, with no error from the extension/test itself; running them in
  the *foreground* instead completed normally every time (both scenarios
  passed this way, twice each, consistently) — noted here as an
  environment/tooling characteristic of this session, not a product defect.

# GIT

Branch: `develop`, confirmed synced with `origin/develop` at session
start (clean working tree). Nothing committed, nothing pushed this
session. `main` and `stable/v1.31.0` untouched. Diff is scoped entirely to
this mission: new `utils/discovery.js`, `content/loadmore.js`, `content/
discovery.js`, `e2e/tests/discovery-pagination-real-site.test.js`, `e2e/
tests/discovery-scroll-real-site.test.js`; modified `popup/popup.js`,
`popup/popup.html`, `background/background.js`, `content/autoscroll.js`,
`content/livewatch.js`, `package.json` (+2 npm scripts). `MISSION.md`
itself, rewritten for this mission, is also part of this diff, per this
project's established convention.
