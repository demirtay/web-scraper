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
are plain Node scripts (no test framework) living outside this repo in
the session's scratchpad directory, each asserting via a small local
`assert()` helper and printing `N assertions, N failures`.
`scripts/release-check.js` is the pre-release validation gate (manifest
sanity, no eval/remote code, dev-diagnostics gating, i18n coverage,
production ZIP build). Branches: `main` (public releases),
`stable/v1.31.0` (frozen snapshot), `develop` (active work).

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
