# ClickScrape — Product Checkpoint & Roadmap

This file is a permanent, persistent record of product decisions and
direction — not a task tracker (see `MISSION.md` for the current
in-progress engineering task) and not user-facing copy (see `README.md`/
`STORE_LISTING.md`). It exists so any future session (human or Claude)
can recover the product's state and intent without re-deriving it from
chat history. Update it by adding new dated checkpoints below the
existing ones — never delete a past checkpoint, since it's a historical
record of what was decided and why.

---

## Checkpoint: V1 Release Readiness — 2026-08-26

### Product decision

ClickScrape v1 is now considered **commercially usable and
release-ready** at the core-product level.

We will **not** delay the initial release indefinitely while adding
every planned feature. When Lemon Squeezy activation/payment
infrastructure is ready, the current stable v1 feature set should be
prepared for release. Development continues after launch as **v1.1+**.

### Real-world verified behavior

A real Etsy test was completed successfully. Observed:

- Automatic pagination works without manual page navigation.
- ClickScrape automatically traversed **22 pages**.
- **1,283 unique records** were discovered.
- **51 duplicate records** were detected/rejected.
- **0 invalid/empty records** were reported.
- Discovery stopped automatically when no additional data was available.
- Preview works.
- Manual column selection works.
- Automatic column detection works for high-confidence columns but does
  not need to detect every possible column.
- Missing columns can be added manually.
- Data cleaning works.
- Price / old-price cleaning looked correct in the real XLSX.
- Canonical deduplication worked.
- CSV / JSON / XLSX export works.
- Bulk image download was tested with the real dataset and successfully
  downloaded the images.
- Browser Process Safety must remain intact.

**Important product decision:** Automatic column detection does **not**
need to guess every possible field. It is preferable to automatically
detect fewer high-confidence columns and let the user manually add
additional fields through the preview workflow, rather than
automatically selecting incorrect fields.

### Seller field note

Some Etsy advertisement cards expose **"Ad by Etsy seller"** instead of
the actual shop name.

This is **not** currently considered a ClickScrape bug. If the real
seller/store name is not present on the listing card, ClickScrape cannot
reliably obtain it without visiting the product detail page. Do **not**
fabricate seller names. This requirement belongs to the future **Detail
Enrichment** feature (see below).

### Release strategy

Current v1 should be released once payment/licensing/store
infrastructure is ready. Do not keep postponing release solely to add
additional large features.

Release workflow, later:

1. Preserve/verify current working `develop` checkpoint.
2. Run final regression/release verification.
3. Prepare `main`/release version.
4. Build clean Chrome Web Store package.
5. Complete listing/screenshots/privacy materials.
6. Connect and verify Lemon Squeezy payment/licensing.
7. Release v1.0.
8. Continue development as v1.1+.

---

## Post-Launch Product Architecture

Planned primary UI flow:

```
VERİ  |  SONUÇ  |  DETAY
```

- **DETAY** should initially be disabled.
- After the main scraping **SONUÇ** (result) dataset exists, DETAY
  becomes available.
- Normal scraping must remain independent from Detail Enrichment. A user
  who only needs list/card data should never be forced to run
  detail-page scraping.

---

## Detail Enrichment (highest-priority post-launch feature)

Workflow:

1. Main discovery collects the listing/card dataset.
2. RESULT (SONUÇ) is produced normally.
3. User optionally opens DETAY.
4. ClickScrape uses the product/detail URLs already collected.
5. It visits selected detail pages.
6. It extracts fields unavailable on the listing cards.
7. It merges those fields back into the correct existing rows.

Potential fields:

- Seller/store name
- Description
- Materials
- Dimensions/specifications
- Category
- Rating
- Review count
- Other site-specific detail fields

Scope options (eventually):

- ALL records
- First 100
- First 500
- First N
- Selected records
- Potentially only records missing selected fields

Example UI shape:

```
1,283 products found.

Detail enrichment:

[ ALL 1,283 ]
[ FIRST 100 ]
[ FIRST 500 ]
[ FIRST ____ ]
[ SELECTED RECORDS ]
```

### Detail engine requirements

Do **not** open hundreds/thousands of tabs simultaneously — use
controlled concurrency. The engine must support:

- progress tracking
- success count
- missing count
- error count
- STOP
- resume/checkpoint
- correct row-to-detail-page association
- safe memory usage
- low-RAM machines
- rate-conscious navigation
- failure recovery

Example progress display:

```
137 / 500 completed
Successful: 132
Missing: 3
Errors: 2
```

---

## Other Post-Launch Features (priority order)

1. Detail Enrichment
2. Bulk URL Scraping
3. ALL / FIRST N processing workflow
4. Auto Detect improvements
5. UI redesign

### Auto Detect future direction

Use confidence-based detection. High-confidence fields may be
automatically selected. Lower-confidence fields may be suggested rather
than automatically selected. **Wrong automatic data is worse than
requiring the user to manually add a field.**

---

## UI Principle

The user should **not** need to understand scraping implementation
details. Normal user workflow should eventually be approximately:

```
Open website
  → choose/detect columns
  → START
  → ClickScrape determines traversal automatically
  → dataset discovered
  → RESULT
  → optional DETAIL enrichment
```

Implementation concepts such as Auto Next, Auto Scroll, Pagination mode,
Infinite Scroll mode, and Load More mode should not need to be normal
user-facing decisions. ClickScrape should determine these automatically
whenever possible.

---

## Commercial Strategy

The objective is not merely to build a functioning scraper. The
objective is to build one of the strongest practical browser scraping
tools while remaining dramatically cheaper and simpler than expensive
competitors.

Competitor features matter. Future feature decisions should be evaluated
using:

1. Does a strong paid competitor offer it?
2. Do real users need it?
3. Does it materially save time or enable valuable work?
4. Can ClickScrape implement it reliably?
5. Can we make the workflow simpler?
6. Does it justify the product's paid value?

A low entry price around **$5.99** has been discussed. Final
pricing/licensing can be finalized during release preparation.

---

## Current Development Rule

The currently working scraping engine is valuable. Do **not**
unnecessarily rewrite working components while implementing future
features.

Preserve:

- automatic traversal
- deduplication
- cleaning
- export
- image download
- preview
- manual columns
- browser process safety

Future development should **extend** this stable core rather than
destabilize it.
