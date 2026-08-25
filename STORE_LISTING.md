# Chrome Web Store Listing — Draft Copy

Draft copy only. Review and adjust before submitting to the Chrome Web
Store; nothing here has been published yet.

---

## Extension name

Web Scraper

## Short description

_(Chrome Web Store limit: 132 characters)_

> Manually select fields on any page — title, price, seller, image — and
> export the data as Excel, CSV, or JSON. No coding required.

(131 characters)

## Full description

Web Scraper is a manual, click-to-select data extraction tool for Chrome.
Instead of writing selectors or code, you click real examples directly on
a web page — a product title, a price, a seller name, an image — and the
extension learns the pattern and collects the same fields from every
matching item on the page.

**This is a general-purpose extraction tool, not a scraper built for one
specific website.** It has been manually tested on Etsy, eBay, Amazon
Türkiye, and Trendyol, and works well on typical repeating-card page
layouts (product listings, search results, directories, and similar).
Because every website's structure is different, results can vary from
site to site, and you may occasionally need to re-pick a field if a
site's layout changes.

**What it does:**
- Pick columns manually by clicking examples — Title, Price, Seller,
  Image, Link, or any custom field — no CSS selectors required.
- Automatically detects the repeating container once you've picked one
  field, and extracts every matching row on the page.
- Keeps collecting as you browse: works through pagination, infinite
  scroll, and "Load More" buttons, and skips duplicates automatically.
- Save your column setup as a reusable Template for a site you visit
  often.
- Export to Excel (with a frozen header row and autofilter), CSV
  (safe against spreadsheet formula injection), or JSON — or bulk-download
  images as a ZIP file.
- Available in English, Turkish, German, French, Simplified Chinese, and
  Russian.

**What it does not do:**
- It does not guarantee compatibility with every website — page
  structures vary, and some sites may not work well with manual
  selection.
- It does not scrape anything automatically without you first defining
  what to collect.
- It does not send your data anywhere except where you explicitly export
  it to (see Privacy below).

**Pricing:** every feature is available from install with a limited
number of free scraping runs; a one-time purchase unlocks unlimited use.

## Key features

- Manual, click-based column selection (Title / Price / Seller / Image /
  Link / custom)
- Automatic repeating-row (card) detection
- Live, session-based collection across pagination / infinite scroll /
  Load More
- Automatic duplicate removal
- Reusable Templates per site
- Raw data export: Excel (.xlsx), CSV, JSON
- Bulk image download (ZIP)
- 6-language UI (EN, TR, DE, FR, ZH-CN, RU)

## Basic usage instructions

1. Open the extension on a page with a list of similar items (a search
   results page, a product listing page, etc.).
2. Click "Add Column," then click a real example of the field you want
   (e.g., a product title). Repeat for each field you want to collect
   (price, seller, image, link...).
3. Click the main Start button. The extension finds every matching row on
   the page and begins collecting.
4. Browse normally — scroll, click "Load More," or go to the next page.
   New matching rows are collected automatically and duplicates are
   skipped.
5. When you're done, click Finish, review your results, and export as
   Excel, CSV, or JSON — or bulk-download any image column as a ZIP.

## Privacy summary

Web Scraper processes data entirely on your device. It has no connected
backend, no account system, and sends no analytics or telemetry. Your
scraped data only ever leaves the browser when you explicitly export it,
saving directly to your own computer through Chrome's own Downloads
feature. See [PRIVACY.md](PRIVACY.md) for the full policy.

## Permissions explanation

- **activeTab** — lets the extension read and interact with the page
  you're currently viewing, only when you actively use the extension on
  that tab.
- **storage** — saves your scraper configurations, templates, monitoring
  history, preferences, and trial/license status locally in your browser.
- **scripting** — injects the extraction logic into the page you're
  scraping, and removes it when a session ends.
- **downloads** — saves your exported files (Excel/CSV/JSON/images) to
  your computer through Chrome's own Downloads feature.
- **alarms** — powers the optional scheduled monitoring feature, which
  can periodically re-run a saved scraper to check for changes.
- **notifications** — shows a system notification when a monitored
  scraper detects a change, if you've enabled monitoring for it.
- **Host access (requested per-site, not at install)** — the extension
  asks for access to a specific website only when you use it on that
  site, rather than requesting access to every website up front.

## Support text

For questions, bug reports, or feedback, contact the developer at the
support email/address listed on this Chrome Web Store listing page.
