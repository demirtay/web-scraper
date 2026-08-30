# CLAUDE.md — Project Execution Protocol

This file is read automatically at the start of every Claude Code session
in this repository. It defines how development work on this project is
carried out — not what the product does (see below) or what the current
task is (see `MISSION.md`).

## Project context (brief)

Web Scraper (ClickScrape) — a Manifest V3 Chrome extension for manual,
click-to-select web data extraction. Vanilla JavaScript, no build step,
no framework, no bundler. Content scripts are injected dynamically
(`chrome.scripting`), never declared statically in `manifest.json`. Tests
are plain Node scripts (no test framework): pure-logic unit tests are a
permanent, committed part of the repo under `tests/unit/` (each asserting
via a small local `assert()` helper and printing `N assertions, N
failures` — see `tests/lib/assert.js`/`tests/lib/load-modules.js`, and
"Testing policy" below); a one-off exploratory script for a single
session still belongs in the session's own scratchpad directory instead.
`scripts/release-check.js` is the pre-release validation gate (manifest
sanity, no eval/remote code, dev-diagnostics gating, i18n coverage,
production ZIP build). Branches: `main` (public releases),
`stable/v1.31.0` (frozen snapshot), `develop` (active work).

## Testing policy — FAST / SITE / RELEASE

Three permanent test levels exist (full detail in `TESTING.md`):
`npm run test:fast` (syntax + `tests/unit/*` pure-logic tests +
infra-safety scan + release-check — no browser, seconds), `npm run
test:sites[:suite]` (real Chrome, real extension, real popup action →
real production message flow → content script → actual result, against
real Etsy/Amazon/eBay/proven-reliable substitute sites — never faked by
calling internal scraper functions directly), and `npm run test:release`
(full FAST + full SITE + the live Browser Process Safety regression —
the only level whose result may ever be reported as "release verified").

**Pick the level the change actually needs, and say so honestly — never
report "fully verified" when the required level wasn't run:**
- UI/CSS-only change → FAST is sufficient.
- Scraping/parser/selector/content-script logic → FAST + SITE.
- Pagination/navigation/discovery logic → FAST + SITE.
- Detail Enrichment / picker → FAST + SITE (`primary-workflow` suite).
- Export/cleaning logic → FAST + the targeted export-related SITE suite.
- Before any release → RELEASE, mandatory, no exceptions.

A SITE scenario blocked by a real CAPTCHA/login/consent/rate-limit page
reports `BLOCKED_BY_SITE`; one that timed out under real resource
pressure reports `BLOCKED_RESOURCE`. Neither is a pass, but neither is
automatically a product regression either — report it exactly as what it
is, never bypassed, never silently treated as green.

## Session start protocol

At the start of every session, before doing anything else:
1. Read this file (`CLAUDE.md`) in full.
2. Read `MISSION.md` in full.
3. Run `git status` (and `git diff` if anything is uncommitted) to see
   the actual current state of the working tree — never assume it
   matches what `MISSION.md` last described.
4. If `MISSION.md`'s "Current Mission" is not marked complete and its
   "Remaining Problems"/"Blockers" don't describe a genuine external
   blocker (see below), resume that mission where it left off instead
   of starting something new or re-asking the user what to do.
5. If the user gives a new task while a previous mission is still open,
   confirm with the user which takes priority rather than silently
   abandoning the open one — but never let an already-CLOSED mission
   block starting new work.

## Browser Process Safety — CRITICAL

**This section applies to EVERY future mission and EVERY agent working in
this repository, permanently, with no exceptions and no expiry.** It
exists because a real-browser test run in this project has, in the past,
closed or interfered with the user's own already-running personal Chrome
windows. That must never happen again.

1. **NEVER close, kill, terminate, restart, reuse, attach to, or
   interfere with any Chrome/Chromium/browser process that was not
   explicitly created by the current automated test run.** The user's
   personal Chrome windows and tabs — profiles already running before a
   test starts, their normal Chrome profile, their existing tabs/windows,
   anything else they have open, any browser they opened manually — are
   completely off-limits, always.

2. **Automated tests must launch their own isolated browser instance**
   (Playwright-managed Chromium, a dedicated/repository-specific temp
   user-data directory — see `e2e/lib/browser.js`'s `launchWithExtension`)
   and must establish ownership of exactly that instance before running
   anything. In this codebase, ownership IS the in-memory `context`
   object `launchWithExtension()` returns — Playwright's own driver binds
   that object to the ONE process it just spawned, not to a process name
   or a PID looked up later, so closing it structurally cannot reach any
   other browser instance, however many are running on the machine.

3. **Cleanup may ONLY close the browser context/page/process that THIS
   test run created** — via `closeUp()` (which calls Playwright's own
   `context.close()`), never anything broader. Never use, and never add,
   a broad OS-level, name/image-based process-kill as cleanup —
   `taskkill /IM`, `pkill`, `killall`, `Stop-Process -Name`, a
   `Get-Process | Stop-Process` pipeline, `wmic process ... delete`, or
   any equivalent — for a browser or for anything else. These are
   indiscriminate across the whole system by construction: they kill
   every matching process, real user windows included. Precise,
   PID-scoped termination of a specific process this run itself already
   identified (`taskkill /PID <pid>` with no `/IM`, `kill <pid>`,
   `Stop-Process -Id <pid>` with no `-Name`) is the only OS-level
   exception, and even that should rarely be needed — prefer the owned
   Playwright object's own `close()` every time.

4. **Do not free RAM or disk by closing the user's applications, Chrome
   windows, VS Code windows, or any other of their processes** — ever,
   for any reason, including "the machine is low on resources." If system
   resources genuinely appear insufficient to proceed, STOP and report
   exactly:

   ```
   BLOCKED: INSUFFICIENT SYSTEM RESOURCES
   ```

   then wait for the user. Do not attempt a workaround that touches
   anything you did not launch yourself.

5. **If browser ownership cannot be determined with certainty, DO NOT
   CLOSE THE BROWSER.** An orphaned automated-test browser window left
   open is a fully acceptable, recoverable outcome. Accidentally closing
   a window that turns out to belong to the user is not, and cannot be
   undone.

6. **Technical enforcement, not just this document:**
   `.claude/hooks/block-browser-process-kill.js` is wired as a
   `PreToolUse` hook (see `.claude/settings.json`) that blocks any
   Bash/PowerShell tool call in this repository matching a broad,
   name-based process-kill pattern, live, before it can run — this is
   not optional guidance an agent can talk itself past; a matching
   command is refused by the tool layer itself. `npm run
   check-test-infra-safety` (`scripts/check-test-infra-safety.js`)
   statically scans this repo's own test infrastructure (`e2e/`,
   `scripts/`, `package.json`) for the same patterns, so a regression
   introduced through any other path (a pasted one-liner, a future
   script, CI) is still caught. `npm run test:browser-safety`
   (`e2e/browser-ownership-safety-check.js`) is a live regression test
   that launches two independent real browser instances and proves
   closing one never affects the other — run it whenever `e2e/lib/
   browser.js`'s own cleanup logic changes.

7. **Before adding or changing ANY code that launches or closes a
   browser** (in `e2e/` or anywhere else a future mission might add),
   re-read this section first, and re-run `npm run test:browser-safety`
   and `npm run check-test-infra-safety` afterward to confirm the
   ownership/cleanup guarantee still holds.

## CORE RULE — see a task through, not to the first attempt

For every development task assigned in this repository, do not stop
after any of:
- writing code
- running one unit test
- saying "implementation complete"
- reporting a likely fix

Instead, work autonomously through this loop, in order, until it
actually terminates (see "When to stop" below):

1. Understand the task — read it fully; identify what "done" means.
2. Inspect the relevant existing code before writing anything.
3. Make a minimal implementation plan.
4. Implement.
5. Run focused tests for the change itself.
6. Run the relevant regression tests (not just the new ones).
7. Inspect any failures.
8. Fix failures that are actually caused by this change.
9. Re-run tests.
10. Repeat steps 6-9 until genuinely green (not "probably fine").
11. Run release/build validation (`node scripts/release-check.js`).
12. Inspect `git diff`/`git status` for unintended changes — anything
    touched that the task didn't call for gets reverted or explained.
13. Verify acceptance criteria one by one, explicitly, against
    `MISSION.md` — not from memory.
14. Only then report completion.

Update `MISSION.md` as you go (not only at the very end) — "Work
Completed" and "Tests" should reflect reality at every step, so a
session that gets interrupted leaves an accurate record behind, not a
stale one.

## SELF-REPAIR LOOP

If a test fails:
1. Analyze the actual failure — read the real error/output, don't guess.
2. Determine whether it is caused by the change just made.
   - If yes: fix it, re-run.
   - If no (pre-existing/unrelated flakiness): say so explicitly in
     `MISSION.md`'s "Remaining Problems", leave it alone, and continue —
     do not fix unrelated issues unless they actually block the mission.
3. Re-run until resolved or confirmed unrelated.

Do not ask the user what to do after every normal code failure. A test
failing, a bug appearing, an approach needing revision, or a first fix
not working are NOT reasons to stop and ask — they are exactly what the
self-repair loop exists to handle. Keep working.

### Genuine external blockers (the ONLY things that justify stopping to ask)

- CAPTCHA requiring human interaction
- Missing account credentials
- External service approval needed
- Unavailable API secret
- Identity/payment verification

Normal code bugs, failing tests, unexpected error messages, a first
approach not working, ambiguous-but-inferable requirements — none of
these are blockers. Only the categories above are. When one of these
occurs, record it in `MISSION.md` under "Blockers" with exactly what is
needed to unblock, and stop — don't work around it with a fake/stub
credential or a simulated approval.

## When to stop

Stop only when one of these is true:
- **A)** Acceptance criteria are satisfied — verified one by one, not
  assumed — and `MISSION.md` reflects this.
- **B)** A genuine external blocker (above) exists and is recorded.
- **C)** Continuing would require an unauthorized destructive action
  (merging to `main`, touching a stable branch, force-pushing,
  committing/pushing without being asked, deleting data, etc. — see
  Change Safety below).

Do not loop indefinitely without one of these conditions being met, and
do not loop blindly — every iteration of the self-repair loop must be
based on an actual observed failure or an actual unmet acceptance
criterion, never repeated for its own sake.

## Real-browser verification (feature development loop)

**Before running any real-browser test, re-read "Browser Process Safety
— CRITICAL" above.** Every step below launches/uses a real Chrome
process — cleanup must stay scoped to exactly the instance that step
launched, never a broad kill.

For any change that touches user-visible or page-interaction behavior
(popup UI, content-script extraction/injection, messaging between
popup/background/content, anything a real Chrome session would exercise
differently than a JSDOM mock), the CORE RULE loop above is extended
with a real-browser step before declaring completion:

```
IMPLEMENT
  → focused tests
  → regression tests
  → npm run test:browser
  → inspect artifacts (test-artifacts/latest/browser.png, popup.png, test.log, result.json)
  → diagnose
  → fix
  → rerun
```

Keep going through this loop while actionable failures caused by the
change remain — same self-repair discipline as the rest of the CORE
RULE, not a separate process. `npm run test:browser:headed` is the
same run with the window kept open a little longer at the end, for a
human to watch; use it when actually debugging visually, not as the
routine check.

**Always look at the screenshots, not just the pass/fail text.** This
harness's own build found a real, confirmed case of a false PASS: an
early version of its CAPTCHA/anti-bot-challenge detector only checked
English text on the page's top frame, so a real Etsy challenge (served
in a different language, and later found to render inside an iframe the
top-frame check couldn't see at all) went completely undetected and the
run reported success. It was only caught by actually opening the saved
`browser.png` and looking at it. Reading `result.json`'s `status` field
alone is not verification — open the PNGs.

**Distinguishing a real bug from a genuine external blocker in a browser
run** follows the exact same rule as the rest of this file: a timeout,
an element not found, a stale selector, a permission call that needs to
be triggered differently — normal code problems, self-repair and keep
going. A real CAPTCHA/anti-bot challenge actually rendered on screen
(confirmed by looking at the screenshot, not assumed from a timeout) is
the one external-blocker category from this list realistically reachable
during browser testing — record it in `MISSION.md`, do not attempt to
solve/bypass it, and treat everything else about that run (did the
browser launch, did the extension load, did the popup render, did
messaging work) as still meaningful, verifiable evidence even if the
target site itself was unreachable that run.

See `e2e/run.js`'s own header comment for the current known, permanent
limitations of this harness (Playwright cannot drive Chrome's native
toolbar-popup UI; real Google Chrome Stable has been observed to ignore
`--load-extension` entirely as of Chrome ~137+, so Playwright's own
bundled Chromium is used instead — both documented in detail there, not
repeated here).

## Change safety

- Preserve working features. When in doubt about whether something is
  "working," treat it as working and leave it alone.
- Prefer minimal changes — the smallest diff that satisfies the mission.
- Do not refactor unrelated systems, even if they look improvable.
- Inspect `git diff` and `git status` before declaring completion — every
  changed file should be explainable by the current mission.
- Work on `develop` unless explicitly told otherwise.
- Do NOT merge to `main`.
- Do NOT modify stable branches (`stable/v1.31.0` or any future
  `stable/*`).
- Do NOT commit or push unless explicitly requested in the task — leave
  finished work as an uncommitted, reviewable diff.
- Do NOT modify the product's actual scraping/extraction behavior,
  exports, templates, credit/license system, or any other working
  application functionality unless the assigned task specifically calls
  for it.
