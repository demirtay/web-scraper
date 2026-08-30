# TESTING.md — ClickScrape's three-level QA / release gate

This documents the permanent, three-level testing system built to close a
specific, real gap: automated/unit tests were passing while the user kept
finding bugs manually on real Etsy pages. From this system's introduction
onward, more of that real-user QA is done by the automated harness itself,
through the real production entry points (real popup clicks, real
`chrome.*` APIs, real content-script injection) — never by calling
internal scraper/helper functions directly to fake a pass ("Anti-False-
Pass Rule").

See `CLAUDE.md`'s "Testing policy" section for *when* each level is
required for a given change. This file documents *what each level does*.

## The three levels

| Level | Command | Launches a browser? | Typical runtime |
|---|---|---|---|
| FAST | `npm run test:fast` | Never | a few seconds |
| SITE | `npm run test:sites[:suite]` | Yes — one shared instance | seconds to ~10 min per suite |
| RELEASE | `npm run test:release` | Yes (via SITE) | FAST + full SITE, several minutes |

### FAST — `npm run test:fast`

Runs, in order, and must NOT launch a browser:
1. `node --check` syntax validation of every product/test `.js` file in
   the repo (excluding `node_modules`, `dist`, `test-artifacts`).
2. Every `tests/unit/*.test.js` — pure-logic unit tests over the real,
   unmodified `utils/*.js` modules, loaded via a Node `vm` sandbox
   (`tests/lib/load-modules.js`) that stands in for the browser globals
   these files expect (`window`/`self`/`chrome.storage`/`URL`). Each file
   uses the project's own established convention (`tests/lib/assert.js`'s
   `makeSuite()` — a small local `assert()` + `N assertions, N failures`),
   just centralized instead of copy-pasted or left in a scratch file.
3. `scripts/check-test-infra-safety.js` — the existing static Browser
   Process Safety regression guard.
4. `scripts/release-check.js` — the existing 18-check static release
   gate (manifest sanity, no eval/remote code, i18n coverage, ZIP build).

Run this on every save / before every commit. It catches logic
regressions in the pure business logic (cleaners, run-state/dedup,
discovery accounting, CSV escaping, Detail scope/templates) and static
release issues, in seconds, with zero real-browser risk or resource cost.

**What FAST does NOT catch**: anything that only manifests in a real
Chrome session — popup lifecycle (a real toolbar popup's JS context dying
on focus loss), real message-passing timing, real DOM structure on a real
site, real permission prompts, real click interception on a real page.
That is what SITE is for.

### SITE — `npm run test:sites[:suite]`

The real-browser level, driven through the REAL production path: a real
page in a real (Playwright-launched, isolated, non-headless) Chrome
window → the real extension → a real popup action (or the documented
Playwright workaround for it, see below) → the real
`chrome.scripting`/`chrome.tabs.sendMessage` flow → the content script →
the actual on-page result. Every SITE scenario is an existing
`e2e/tests/*.test.js` module (unchanged contract:
`run(ctx) -> {passed, details}`); `e2e/site-runner.js` only adds
sequencing, timeouts, and resource safety on top — it is a thin
orchestration layer, not a second test framework.

Suites (`e2e/site-scenarios.js` is the single source of truth):

| Suite | `npm run` | What it covers |
|---|---|---|
| `smoke` | `test:sites:smoke` | Harness self-check only — browser launches, extension detected, one reliable page opens, popup renders. No site-acceptance assertions. Run this FIRST when the harness itself changes. |
| `etsy` | `test:sites:etsy` | Real Etsy: page open (with anti-bot-challenge detection), popup render, real host-permission grant, real content-script PING, best-effort auto-detect. |
| `primary-workflow` | `test:sites:primary-workflow` | The comprehensive workflow + Detail Enrichment/picker suite (10 scenarios) — page open → extension load → field select/detect → preview → scrape start → pagination/infinite-scroll/load-more → dedup → cleaning → export generation, AND the full 11-item Detail Enrichment/picker checklist (open Detail → start "Örnek Sayfada Alan Seç" → real background-orchestrated activation → picker visibly active → hover highlight → click nested anchor with NO navigation → value captured → **survives real popup closure** → reopened Detail shows the field → detail-enrichment run visits real URLs → values joined to the right records). Runs against `books.toscrape.com`/`quotes.toscrape.com` — see "Why not Etsy for this suite" below. |
| `amazon` | `test:sites:amazon` | Real Amazon: same basic-acceptance shape as `etsy` (page open, popup, permission, PING, auto-detect). |
| `ebay` | `test:sites:ebay` | Real eBay: same basic-acceptance shape. |
| *(all)* | `test:sites` | Every suite above except `smoke`, sequentially, one shared browser. |

**Why not Etsy for the picker/workflow suite**: this project's own test
history (see `e2e/tests/etsy-popup.test.js` and
`e2e/tests/cleaning-real-site.test.js` header comments) has repeatedly,
confirmedly hit a real Etsy anti-bot challenge against this harness's
automated browser — a genuine `BLOCKED_BY_SITE` condition, not a bug.
`books.toscrape.com`/`quotes.toscrape.com` are this project's own
established, reliable real-site substitutes for exercising the
extension's actual code paths (DOM interaction, picker click
interception, popup lifecycle, message passing) when the *site's own
markup* isn't what's under test. The `etsy` suite still targets real Etsy
directly and will honestly report `BLOCKED_BY_SITE` if the challenge
reappears — that is an accepted, expected, non-regression outcome, not a
harness failure, and is never silently bypassed.

**Outcomes** (see `test-artifacts/latest/site-runner-summary.json` after
any SITE run):
- **PASS** — the scenario ran to completion through the real production
  path and every one of its assertions held.
- **FAIL** — a real assertion failed. This IS a product regression signal
  and blocks RELEASE.
- **BLOCKED_BY_SITE** — a CAPTCHA/login/consent/rate-limit/bot-protection
  page was detected instead of real content. Not a pass, but also not
  automatically a regression — never bypassed.
- **BLOCKED_RESOURCE** — a scenario timed out (default 5 min budget,
  generous enough for a real manual Chrome "Allow" click, bounded enough
  to never repeat this project's own observed 45+ minute stalls under
  real memory pressure) or the whole run's wall-clock budget (default 20
  min) was exceeded. The ENTIRE remaining run is aborted cleanly the
  moment this happens — the harness does not keep pushing an already-
  unhealthy browser/session.

**Mandatory evidence**, written to `test-artifacts/latest/` after every
run: `site-runner.log` (full step-by-step log), `site-runner-summary.json`
(per-scenario status, elapsed time, `passed[]` checks, `details` —
selected/extracted columns, sample values, counts, console errors, etc.,
exactly as each scenario module already records them), and screenshots at
each scenario's own checkpoints (e.g. `test-artifacts/latest/site-smoke/`,
`.../site-amazon/`, and the flat `test-artifacts/latest/*.png` files the
pre-existing scenarios already wrote). Nothing here is committed to git —
same as the pre-existing `test-artifacts/` convention.

**Resource safety** (see `e2e/site-runner.js`'s own header comment for
the full rationale): ONE shared browser context for the whole invocation,
scenarios run strictly sequentially, pages opened by one scenario are
closed before the next one starts, per-scenario AND whole-run timeouts,
and cleanup only ever closes the ONE context this run itself created
(`launch.closeUp()`) — never a broader, name/image-based process kill.
See `CLAUDE.md`'s "Browser Process Safety — CRITICAL" section, which this
file's architecture is built directly on top of, unmodified.

**Permission prompts**: several scenarios call the extension's own real
`chrome.permissions.request()`. If Chrome shows a real permission prompt
that needs a human click, the run will appear to pause at that step —
this is expected; click "Allow" in the real Chrome window the harness
opened. The per-scenario timeout (default 5 min) bounds how long the
harness waits before giving up and reporting `BLOCKED_RESOURCE`.

### RELEASE — `npm run test:release`

`scripts/test-release.js` runs, in order: full FAST → the live Browser
Process Safety regression (`e2e/browser-ownership-safety-check.js`) →
every real-site SITE suite (`e2e/site-runner.js --all`). This is the only
level whose result may ever be described as "release verified" — per
CLAUDE.md, a session must NOT report a build as verified if the required
real-site tests didn't actually run.

Exit codes are deliberately distinct:
- **0** — everything ran and passed cleanly. Safe to call this VERIFIED.
- **1** — a genuine failure (FAST failed, a SITE scenario FAILed, or the
  browser-safety regression failed). NOT release-safe.
- **2** — no hard failure, but at least one SITE scenario came back
  `BLOCKED_BY_SITE`/`BLOCKED_RESOURCE` — real-site coverage is
  *incomplete*. Report this honestly as "not fully verified," never as a
  clean pass; re-run `npm run test:sites` once the blocking condition has
  cleared.

## Test selection policy (what to run for a given change)

See `CLAUDE.md`'s own "Testing policy" section — the authoritative,
concise version. Summary:

| Change type | Required level |
|---|---|
| UI/CSS-only | FAST |
| Scraping/parser/selector/content-script logic | FAST + SITE |
| Pagination/navigation/discovery logic | FAST + SITE |
| Detail Enrichment / picker | FAST + SITE (including the `primary-workflow` suite) |
| Export/cleaning logic | FAST + a targeted export-related SITE suite (`primary-workflow` covers `cleaning-real-site`/`detail-enrichment-real-flow`'s export generation) |
| Before any release | RELEASE (mandatory) |

Never report a change as "fully verified" when the level the change
actually required wasn't executed.
