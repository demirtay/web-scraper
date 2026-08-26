# Current Mission

**Status: IN PROGRESS — blocked on insufficient system resources (see
Blockers below), otherwise substantively complete.**

BUG REOPEN: "Automatic Discovery is still passive on the real user flow."
User's real, manual observation: ClickScrape discovers rows correctly,
accumulates unique data as the user manually visits pages, and reports
accurate counts (e.g. "188 results / 188 unique / 3 pages scanned /
status: searching for more data...") — but never autonomously advances
to the next page itself; the user has to click pagination manually.
Prior missions' own real-browser tests did not actually prove this,
because they seeded the discovery session and dispatched START_DISCOVERY
directly from the test harness rather than through a real BAŞLA click in
the popup — this mission's explicit requirement is to prove (and fix, if
broken) the exact same production control-flow path: **user clicks START
in the popup**.

# Root Cause(s) Identified

Two distinct, real bugs were found and fixed — both would independently
produce this exact reported symptom ("discovering" forever, no
autonomous navigation, popup shows only what a user manually collected):

### 1. Silent-death loop failure (the primary, most likely real-world cause)
`content/discovery.js`'s `runDiscoveryLoop()` is invoked fire-and-forget
from both the `START_DISCOVERY` message handler and this file's own
bootstrap-resume — with **no `.catch()` anywhere in that chain**. Any
unhandled exception ANYWHERE inside the loop (a real DOM/API quirk on a
real, messy page — e.g. a detected "Next" control that gets
removed/replaced between detection and click, `getComputedStyle` on a
detached node, or any other exception not already guarded) silently
kills the async function with **zero diagnostic trace**:
`session.discovery.status` stays frozen at `'discovering'` forever,
indistinguishable from the popup's own UI from "still legitimately
working." This is a structural match for the reported symptom — every
engine involved (Auto Scroll/Load More/nav-wait) already has hard
timeouts/cycle budgets, so the ONLY way this system can get permanently
and silently stuck is an uncaught exception ending the loop's promise
chain with nothing downstream ever observing it.

**Fix:** `runDiscoveryLoopSafe()` wraps every entry point into
`runDiscoveryLoop()`; any rejection is caught, logged with the real
underlying error message, and turned into an honest terminal state
(`discovery.status = 'error'`, `stopReason` carries the actual message)
instead of a silent freeze. Also hardened the pagination-trigger
invocation itself (`wrappedTrigger`) with its own local try/catch, since
a throw there runs synchronously inside `content/domwait.js`'s own
Promise executor and would otherwise silently reject that promise with
nothing downstream catching it (the exact same failure class, one level
deeper). Regression-tested directly (JSDOM scenario 2, below): a forced
exception now surfaces as `status: 'error'` with the real message
preserved, never a silent hang.

### 2. Post-navigation diagnostic-write race (found via this mission's
own real-browser testing, confirming the control-flow itself IS
structurally sound)
Adding the mission-required ownership diagnostics
(`session.discovery.lastPaginationAttempt`) exposed — and had to be
fixed around — a second, genuinely real race: on a **real, cross-document
navigation** (not the SPA-style same-document case), Chrome can and does
tear down the outgoing content-script instance's JS execution context
before an async `chrome.storage.local.set()` issued **after** the URL
change is confirmed ever completes. This is the exact same race class
`pagesVisited` was already hardened against in a prior mission (see that
counter's own detailed comment in the file) — but the new diagnostic
write initially fell into it: `paginationActionIssued`/`toUrl`/
`fingerprintAfter`/`paginationActionSucceeded`, written only after
`waitForNavigationOrMutation` resolved `'url-changed'`, were silently
lost on a real navigation nearly every time, even though the real
navigation (and the real dataset growth) had already genuinely happened.

**Fix (two parts, both confirmed via real-browser testing against
books.toscrape.com):**
- `paginationActionIssued: true` is now dispatched via a synchronous,
  fire-and-forget `chrome.storage.local.set()` call **before** the
  trigger is ever invoked (mirrors the existing `pagesVisited` fix's own
  pattern exactly) — this write reliably survives the navigation.
- The freshly-bootstrapped instance on the NEW page reconciles any
  dangling attempt left by a destroyed outgoing instance
  (`paginationActionIssued: true`, never confirmed) the moment it starts
  — its own existence, running on a genuinely different URL, is itself
  conclusive proof the navigation succeeded.

**This second bug is NOT the user's originally reported product defect**
— the underlying pagination control-flow was already actively
issuing/succeeding at real navigation (proven by the real-browser test
below); this was a race in this mission's OWN new diagnostics, found and
fixed in the course of proving the fix works. Documented here in full
because CLAUDE.md's self-repair loop requires it and because it is
genuinely informative about how fragile writes-after-navigation are in
this codebase.

# Exact Files Changed

- `content/discovery.js` — `runDiscoveryLoopSafe()` wrapper (both real
  entry points now go through it); `diagFingerprint()` helper; STEP 4
  fully instrumented with `attemptDiag`
  (nextCandidateFound/paginationActionIssued/paginationActionSucceeded/
  fromUrl/toUrl/fingerprintBefore/fingerprintAfter/uniqueBefore/
  uniqueAfter/outcome), persisted as `session.discovery.
  lastPaginationAttempt`; pre-trigger fire-and-forget "issued" write;
  dangling-attempt reconciliation on fresh-instance bootstrap; wrapped
  trigger invocation with local try/catch. Purely additive — no existing
  control-flow branch, stop condition, or engine call was removed or
  reordered.
- `popup/popup.js` — `renderDiscoveryUI()`'s `isDone`/status-line3 logic
  now also treats the new `'error'` discovery status as a terminal state
  (never silently mislabeled "complete"), reusing the existing, already
  fully-localized `discovery.statusStopped` copy (no new i18n key added,
  so `release-check`'s i18n-coverage gate is unaffected).
- `package.json` — added `test:browser:discovery-start-flow` npm script.
- `content/discovery.js` — also: the `'timeout'` outcome branch now
  persists its full diagnostic directly (safe there — a timeout means no
  navigation ever happened, so this instance is guaranteed still alive,
  unlike the url-changed/dom-changed branches) rather than relying on
  `finalizeStopped`'s own internal re-read to pick up an unpersisted
  mutation, which it would not have.
- `e2e/tests/discovery-popup-start-real-site.test.js` (NEW) — drives the
  REAL, unmodified `popup.js#handleStartLiveSession()` by clicking the
  real `#basla-btn` in the real `popup.html` (not a test-side session
  construction — see its own header comment for exactly how this differs
  from the prior mission's `discovery-pagination-real-site.test.js`, and
  for the one, unavoidable, already-precedented Playwright-toolbar-popup
  tab-resolution shim this required). Asserts
  `paginationActionIssued`/`paginationActionSucceeded` are both `true` at
  every real transition — fails the run if the extension did not itself
  issue the navigation.

# Real-Browser Proof (Page 1 -> 2 -> 3, via the real #basla-btn click)

`npm run test:browser:discovery-start-flow` against
`https://books.toscrape.com/` — **PASSED** (see run below; two earlier
attempts in the same session hit an unrelated, pre-existing real-Chrome
timing flake — see Bugs/flakes below — not a discovery-engine defect):

```
✓ Real BAŞLA click produced a real live session, written by the real production code path
✓ PAGE 1: real BAŞLA extraction collected 20 real rows
✓ Real session correctly entered the "discovering" state via the real, unconditional START_DISCOVERY dispatch
✓ PAGE 2: REAL production Discovery loop autonomously issued its own pagination action — 40 total unique rows so far — paginationActionIssued=true, paginationActionSucceeded=true
✓ PAGE 3: REAL production Discovery loop autonomously issued its own pagination action — 60 total unique rows so far — paginationActionIssued=true, paginationActionSucceeded=true
✓ Real Stop confirmed: 60 real rows preserved (status: discovery_stopped)
✓ CORE BUG-FIX PROOF: dataset genuinely grew via fully autonomous traversal triggered by the real #basla-btn click alone (page 1: 20 -> final: 60), zero manual navigation performed by this test
✓ Duplicate protection verified on the real dataset: 0 duplicate product links across 60 rows
```

Screenshots inspected directly (not just `result.json`'s `status`
field), per CLAUDE.md's own explicit requirement:
- `discovery-start-flow-growth-2.png` — the real site tab shows "Page 3
  of 50" — visual confirmation the browser itself actually navigated.
- `discovery-start-flow-complete.png` — the real popup's Results tab
  shows "60 rows ready / 60 unique records discovered / 3 pages scanned
  / Status: Discovery stopped" — the exact same UI shape the user's bug
  report described (188/188/3/"searching for more"), now reflecting a
  genuinely autonomous 3-page run that only stopped because this test
  explicitly sent Stop after collecting sufficient proof, not because it
  was stuck.

Diagnostics (from the real, persisted session,
`session.discovery.lastPaginationAttempt` at final Stop):
```json
{
  "nextCandidateFound": true,
  "paginationActionIssued": true,
  "paginationActionSucceeded": true,
  "fromUrl": "https://books.toscrape.com/catalogue/page-2.html",
  "toUrl": "https://books.toscrape.com/catalogue/page-3.html",
  "method": "accessible-name",
  "outcome": "url-changed-confirmed-by-resume"
}
```

# Tests

- `discovery-active-navigation.test.js` (JSDOM, scratchpad — not part of
  the committed repo per this project's own testing convention): 31
  assertions, 0 failures.
  - Scenario 1: real, unmodified `content/nextdetect.js` +
    `content/domwait.js` + `utils/runstate.js` + `utils/discovery.js`,
    loaded and executed for real inside a real DOM — proves
    `content/discovery.js` autonomously drives 3 real page transitions
    (genuine `location.href` changes via `dom.reconfigure`), asserts
    `paginationActionIssued`/`paginationActionSucceeded` are both `true`
    at every transition, exactly `2` real clicks total (never more,
    never fewer, never issued by the test itself), correct honest
    exhaustion (`no-more-mechanisms`) on the page with no Next control.
  - Scenario 2: forces an exception inside `WSAutoScroll.
    runUntilExhausted` — proves the loop no longer freezes silently;
    `discovery.status` becomes `'error'` with the real exception message
    preserved in `stopReason`.
- `npm run check-test-infra-safety` — PASS (new e2e test file scanned
  clean, no broad process-kill patterns).
- Real-browser `discovery-popup-start-real-site` — PASS (see above; 2
  runs, both fully green after the diagnostic-race fix).
- **NOT YET RE-RUN this session** (blocked — see below): the full
  regression suite (12 JSDOM scratch suites + `test-discovery-core.js`
  etc. referenced by the immediately prior mission) and `node
  scripts/release-check.js`. These scratch suites live outside the repo
  per this project's convention and were not carried over from the prior
  session — they need to be either regenerated or the prior session's
  originals located before a full regression pass can be claimed
  complete. The cleaning/export code this mission did NOT touch
  (`utils/cleaners.js`, `utils/transforms.js`, `utils/runstate.js` other
  than what's read-only-reused here) — `git diff --stat` confirms these
  files are untouched this session, so no regression is plausible there,
  but this has not yet been independently re-verified by actually
  running those suites.

# Blockers

**BLOCKED: INSUFFICIENT SYSTEM RESOURCES** (mid-way through a further
confirmation run of the new real-browser test, immediately after the
diagnostic-race fix above already had 2 clean PASSing runs recorded).
Checked directly (read-only): **1.2 GB free of 7.71 GB total RAM**, 20
`chrome.exe` processes currently running. This is the exact same
resource-exhaustion condition the immediately prior mission hit and
recorded in this same file (see git history) — `chrome.permissions.
request()` hung for 8+ minutes with no resolution (test.log shows it
stalled at the permission-grant step). Per CLAUDE.md: did NOT close any
browser process, did NOT run any broad/name-based kill, did NOT attempt
to free memory by closing anything the user didn't launch. The hung
background test run (task `bauubf70b`) was left alone rather than
force-killed — an orphaned automated-test browser window is an
acceptable, recoverable outcome; nothing was done that could touch a
window this session didn't itself launch. Waiting for the user to free
memory (or confirm it's safe to proceed) before running any further
real-browser verification.

**What is needed to unblock:** the user frees system memory/closes
unneeded applications (including, if they choose, any leftover
`chrome.exe` processes from this session's own now-closed test runs —
their call, not this session's), then confirms it's safe to resume.

# Remaining Problems / Not Yet Done

- [ ] One more clean confirmation run of `discovery-popup-start-real-site`
      (2/2 completed runs already passed after the fix; a 3rd was
      in-flight when the resource blocker hit) — resume once unblocked.
- [ ] Locate or rebuild the full JSDOM regression suite (12 suites from
      the immediately prior mission) and re-run in full.
- [ ] `node scripts/release-check.js`.
- [ ] Final `git status`/`git diff` inspection for unintended changes
      (spot-checked already via `git diff --stat` — exactly 4
      files touched: `content/discovery.js`, `popup/popup.js`,
      `package.json`, plus the new
      `e2e/tests/discovery-popup-start-real-site.test.js` — nothing in
      `utils/cleaners.js`/`utils/transforms.js`/export code touched).
- [ ] `npm run test:browser-safety` re-confirmation (browser-launch/
      cleanup code itself was not touched this mission, so low risk, but
      the project's own rule is to re-run it whenever real-browser
      verification work like this happens in a session).

# GIT

Branch: `develop`, confirmed in sync with `origin/develop` at session
start (`b3a2594`). **Nothing committed, nothing pushed this session**
(explicit instruction: "DO NOT COMMIT OR PUSH"). `main` and
`stable/v1.31.0` confirmed unchanged (verified against origin at session
start). Diff scope: `content/discovery.js`, `popup/popup.js`,
`package.json` modified; `e2e/tests/discovery-popup-start-real-site.test.js`
added — nothing else.
