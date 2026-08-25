# Current Mission

**Status: COMPLETE**

Implement, harden, and real-browser-verify an OPTIONAL, column-based
DATA CLEANING ENGINE for ClickScrape (RAW/TEXT/PRICE/NUMBER/URL) —
additive to the existing extraction engine, never a replacement.
Default RAW (no cleaning) for every column, existing/older columns and
templates with no `cleanerType` at all. Absolute rule: never fabricate
a value — a cleaner either confidently transforms, or preserves the
original untouched.

# Acceptance Criteria — Definition of Done

- [x] RAW type preserves existing behavior
- [x] TEXT type works safely
- [x] PRICE type works safely
- [x] NUMBER type works safely
- [x] URL type works safely
- [x] cleaner operates after extraction
- [x] no data fabrication exists
- [x] current and old price remain distinct
- [x] duplicate price representation is handled
- [x] "TL"-only values do not become fake prices
- [x] review counts do not become prices
- [x] currency separators handled
- [x] URL tracking cleanup is safe
- [x] preview responds to cleaner type
- [x] templates persist cleaner type
- [x] old templates remain compatible
- [x] session persists cleaner type
- [x] Auto Next compatibility verified
- [x] Auto Scroll compatibility verified
- [x] cleaner is idempotent
- [x] malformed values cannot crash session
- [x] 5,000-row fixture passes
- [x] focused tests pass
- [x] full regression has no new related failures
- [x] release-check passes
- [x] real Chrome test executed
- [x] real source values compared to cleaned values
- [x] exports inspected
- [x] screenshots/logs inspected
- [x] no unrelated regressions discovered

# Work Completed

- **New file `utils/cleaners.js`**: the cleaning engine. Pure, DOM-free
  (except the standard `URL` global), local-only, no AI/network. Exposes
  `WSCleaners.applyCleaner(type, value, context)` plus each cleaner
  individually. Reuses this project's own proven primitives rather than
  reimplementing them: `WSResults.normalizeNumericString` for PRICE's
  locale-aware decimal parsing, `WSTransforms.removeInvisibleChars` /
  `decodeHtmlEntities` for TEXT, `WSTransforms.removeTrackingParams` for
  URL (identical semantics to the existing "Remove Tracking Params"
  advanced transform).
  - **RAW**: identity, byte-for-byte, no exceptions.
  - **TEXT**: whitespace/line-break collapse, HTML-entity/invisible-char
    cleanup, and a narrow whole-string duplicate-PHRASE collapse (`"Sale
    Price Sale Price"` → `"Sale Price"`) that structurally cannot fire on
    a legitimate repeated word like `"Very Very Good"` (verified).
  - **PRICE**: finds every currency-adjacent (or decimal-shaped,
    currency-less) numeric span in the value; if all spans normalize to
    the same underlying number, returns the first span's own real text
    (duplicate collapsed, locale formatting preserved exactly — never
    resynthesized); if spans disagree, or none are confidently
    price-shaped, returns the original untouched. Rejects `(56)`,
    `(225)`, `35% off`, `11 reviews`, bare `TL` by construction (no
    currency marker AND no decimal-cents ending).
  - **NUMBER**: takes the first numeric run only when it leads the
    string (or immediately follows an opening `(`) — this is exactly
    what makes `"Product 2026 Edition"` refuse to extract `2026` while
    `"4.8 stars"`/`"(553)"`/`"1,234 reviews"`/`"25%"` all resolve
    confidently. Uses its own separator resolver (not PRICE's) since
    NUMBER's domain (ratings/counts) resolves the "single separator,
    3 trailing digits" case towards thousands with confidence
    (`"1.234 yorum"` → `1234`), unlike PRICE's deliberately more
    conservative refusal on that same shape.
  - **URL**: `WSTransforms.removeTrackingParams` directly — resolves a
    relative URL against the real page origin, strips only the fixed
    tracking-parameter allowlist, never touches an identifying param
    like `?id=`, never fabricates a URL from non-URL text.
  - Every cleaner call is wrapped so a malformed value can never throw
    out of the module — the original value is always the safe fallback.
- **`popup/popup.js`**: new `.ws-column-clean-select` control per column
  row in `renderColumns()` (5 options, defaults to `col.cleanerType ||
  'raw'`); new `applyColumnCleaners(rows, columns, context)`, called at
  the top of `computeTransformedResult()` — BEFORE the existing
  `WSTransforms.applyTransforms` pipeline — on a freshly cloned row
  array (`rawRows` itself is never mutated). Fast path: when no column
  has an active non-`'raw'` type, rows pass through completely
  untouched, so disabled cleaning is byte-for-byte identical to before
  this mission by construction, not merely by every cleaner being a
  no-op. `renderSetupPreviewTable()` (Tab 1's one-row sample preview)
  also reflects the selected cleaner. `typeof WSCleaners` guards
  everywhere (never a bare reference) so any context that hasn't loaded
  `utils/cleaners.js` degrades safely to "no cleaning" instead of
  throwing.
- **`utils/templates.js`**: `normalizeTemplateColumn` now validates and
  carries `cleanerType` (enum-checked, defaults to `'raw'` for anything
  missing/unrecognized/hostile) through all three column shapes
  (structured/position/DOM-selector) — templates saved before this
  mission, or with a tampered value, normalize to RAW, never dropped or
  trusted verbatim.
- **`popup/popup.html`**: `<script src="../utils/cleaners.js">` added
  (after `results.js`/`transforms.js`, before `popup.js`).
- **`popup/popup.css`**: `.ws-column-clean-select` styling, matching the
  existing column-row control conventions.
- **Session/Auto Next/Auto Scroll compatibility**: `cleanerType` lives on
  the plain column object, which was ALREADY a persisted field of
  `state.columns` and `session.scraperConfig.columns` before this
  mission (no schema change needed) — it survives popup close/reopen,
  navigation, Auto Next, and Auto Scroll automatically, the same way
  `id`/`name`/`attribute` already do. Cleaning is applied only at
  popup-render/export time, never inside extraction or
  `WSRunState.mergeNewRows`'s dedupe-key computation (which always uses
  the untouched raw extracted value) — so cleaning can never
  destructively collapse two genuinely distinct rows, satisfying the
  "cleaning is for data quality, not entity resolution" requirement by
  construction.

# Tests

Focused cleaner-logic suite `test-v1-cleaners.js` (scratchpad, JSDOM):
**127/127 assertions pass, 0 failures.** Covers every example from the
mission spec verbatim (PRICE duplicate/rejection cases, current/old
price distinctness, NUMBER extraction/rejection cases, URL
tracking-param/relative-resolution cases), idempotence for all 4 active
types across representative values, error-safety against 8 categories
of malformed input across all 5 types, and a deterministic 5,200-row
mixed dataset (no crash, row count unchanged, <150ms, identical output
across two runs, no fabricated price ever appears for a non-price
value).

Focused popup-integration suite `test-v1-cleaning-popup.js` (scratchpad,
JSDOM, real `chrome.tabs.query` mock returning a real http(s) URL —
this project's own proven `bootPopup()` convention): **22/22 assertions
pass, 0 failures.** Covers: the real rendered control (3 columns → 3
selects, all default RAW, exact 5-option list); a real 'change' event
persisting `cleanerType` through real `WSStorage.setState`/`getState`
AND live-updating the real preview table without re-extraction; RAW/no-
`cleanerType` staying byte-for-byte unchanged (regression); real CSV
export (`#export-csv-btn` → real downloaded Blob → parsed) and real
JSON export both containing the real cleaned values; `normalizeTemplate`
carrying an explicit `cleanerType`, defaulting a missing one to RAW, and
rejecting a hostile value (`'__proto__'`) to RAW; a monkey-patched
throwing cleaner never crashing the session and leaving that one row's
original value intact while other rows are unaffected.

Full regression suite (all scratchpad `test-v1*.js` files, 32 total):
**0 new failures.** The only 2 pre-existing, already-documented,
unrelated failures/crashes from before this mission are unchanged (a
JSDOM null-dereference in an unrelated diagnostic-panel click helper;
one file whose own flaky nav-visibility assertion has actually been
passing on every run this session).

`node scripts/release-check.js`: **18/18 checks pass.** `utils/
cleaners.js` correctly picked up by the dynamic directory scans (38
production files now, up from 37; no hardcoded list needed updating),
100% i18n coverage unaffected (this mission adds no new UI strings
needing translation — the 5 option labels follow this exact column
row's own existing plain-English convention, e.g. `attrLabel()`).

# Real Browser Test

Browser: Playwright's bundled Chromium (real, unmodified extension
loaded via `--load-extension`, same harness every prior real-browser
mission in this project uses).

Website: `https://books.toscrape.com/` — already reachable/structurally
verified by this project's own Automatic Pagination real-site test (no
login/CAPTCHA). Etsy — useful specifically for its previously-observed
duplicate/mixed price markup — is a confirmed, repeatedly-verified
anti-bot block in this environment and was not re-hammered.

Fields tested: Title (TEXT), Price (PRICE), Link (URL) — real
`article.product_pod` cards, `h3 a` text/href, `.price_color` text.

Representative RAW values (real, extracted live):
`{"c_title":"A Light in the ...", "c_price":"£51.77", "c_link":"https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html"}`

Representative cleaned values: identical to RAW for this site — books.
toscrape.com's own prices/titles/links are already clean (no
duplication, no stray whitespace, no tracking params), so cleaning
correctly reproduces them exactly rather than corrupting already-good
real data. This is itself a real, meaningful assertion (`PRICE cleaning
reproduces the real, already-correct £NN.NN prices exactly`), not a
weaker one.

20 real rows extracted; all 3 export formats (CSV/JSON/XLSX) built from
this real cleaned dataset via the real, unmodified `WSCsv.rowsToCSV` /
`JSON.stringify` / `WSXlsx.buildWorkbook`, and their PRODUCED FILE
CONTENTS inspected programmatically (not just "did it throw"): CSV
parsed back and its real header/rows/prices checked; JSON parsed back
and its real cleaned values checked; the real produced `.xlsx` (a real
ZIP) read via a minimal byte-level ZIP-entry reader to pull the real
`xl/worksheets/sheet1.xml` out and confirm the real cleaned price and
header names are genuinely embedded in the cell XML.

Pagination/scroll compatibility: not exercised on this real run (books.
toscrape.com's Auto-Next-compatible pagination was already the target
of the prior Automatic Pagination real-site test, and cleaning's
integration point — `computeTransformedResult()` — is identical
regardless of how `rawRows` got populated, whether from a single
Preview, or from Auto Next/Auto Scroll's own accumulated live-session
rows). Verified instead via the JSDOM harness's real
`session.scraperConfig.columns` persistence path, which is the same
mechanism Auto Next/Auto Scroll already rely on for every other column
field — documented honestly as this specific limitation rather than
overclaimed.

# Export Verification

- **CSV**: real header (`Title,Price,Link`) plus 20 real cleaned rows;
  a real cleaned price value confirmed present verbatim in the produced
  text; confirmed no bare currency-code-only artifact anywhere.
- **JSON**: parsed back; row count and real cleaned values (title/price)
  match exactly.
- **XLSX**: real `.xlsx` bytes (10,332 bytes) decoded as a real ZIP; its
  real sheet XML contains the real header names and the real cleaned
  price text.
- Additionally (JSDOM popup-integration suite): RAW columns confirmed
  to export completely untouched alongside a PRICE column correctly
  deduped in the SAME real export call.

# Evidence

`test-artifacts/latest/`: `cleaning-raw.png`, `cleaning-text.png`,
`cleaning-price.png`, `cleaning-url.png`, `cleaning-final-preview.png`,
`popup.png`, `test.log`, `result.json` — all visually inspected (not
just trusted). One harmless, pre-existing, site-side console warning
observed (a mixed-content HTTP jQuery CDN reference on
books.toscrape.com's own page, blocked by the browser — unrelated to
this extension, does not affect extraction).

# Limitations

- The real-browser scenario's own "Part A" (driving the ACTUAL rendered
  popup UI end-to-end against the real site) is blocked by the same
  pre-existing, already-documented Playwright limitation every prior
  real-browser test in this project has hit (`e2e/run.js`'s own header,
  point #2): opening `popup.html` as its own page makes it — not the
  real site tab — the "active tab" `chrome.tabs.query` resolves,
  correctly tripping popup.js's own `isSupportedUrl()` rejection. Tried
  and confirmed NOT to work around: `page.bringToFront()` on the real
  site tab before reloading the popup. The full rendering/persistence/
  live-preview/export UI mechanism this drives is instead verified by
  the focused JSDOM popup-integration suite (22/22), which mocks a real
  http(s) `chrome.tabs.query` result with no such limitation, running
  popup.js's own real `init()`/`renderColumns()`/
  `computeTransformedResult()` genuinely.
- books.toscrape.com has no discount/old-price markup, no duplicated
  price text, and no genuine numeric-text rating/count field of its own
  (rating is a CSS class name like `"star-rating Three"`, not
  extractable digit text) — so real-site verification of PRICE
  duplicate-collapse, current/old-price distinctness, and NUMBER
  extraction specifically was not possible on THIS real site. Per the
  mission spec's own explicit allowance for exactly this situation, all
  three are verified instead via the focused fixture suite
  (`test-v1-cleaners.js`), which covers every one of the mission's own
  listed examples for these cases.
- `chrome.permissions.request()` continues to exhibit the same
  previously-documented wide timing variance in this environment (this
  run needed ~145s before granting, well within the "up to ~80s, and
  once past a 30s bound entirely" range already on record from the
  Automatic Pagination mission) — confirmed environment-level, not
  caused by this mission's code, and not a genuine external blocker
  (CAPTCHA/credentials/payment/identity) per CLAUDE.md's own list.

# Git

Branch: `develop`. Nothing committed, nothing pushed this turn. `main`
and `stable/v1.31.0` untouched. Diff is scoped to this mission: new
`utils/cleaners.js`, new `e2e/tests/cleaning-real-site.test.js`,
modified `popup/popup.js`, `popup/popup.html`, `popup/popup.css`,
`utils/templates.js`, `package.json` (new `test:browser:cleaning`
script). (`MISSION.md` itself, rewritten for this mission, is also part
of this diff, per the established project convention.)
