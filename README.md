# Web Scraper

A Manifest V3 Chrome extension for manual, click-to-select web data
extraction. You pick the fields you want directly on the page (title,
price, seller, image, link, or any other repeating element), and the
extension collects that data into a table you can export as Excel, CSV,
or JSON.

This is a general-purpose extraction tool, not a site-specific scraper.
It has been manually tested against Etsy, eBay, Amazon Türkiye, and
Trendyol, but it makes no guarantee of working on every website — actual
behavior depends on each site's own page structure and may require the
user to adjust column selectors if a site's markup changes.

## Core features

- **Manual column selection** — click real examples on the page to
  define a Title/Price/Seller/Image/Link/custom column; no CSS selector
  knowledge required.
- **Repeated-card detection** — once one column is picked, the extension
  finds the repeating container (product card, listing row, etc.) and
  extracts every matching row on the page.
- **Live session accumulation** — start a session and keep browsing;
  matching new rows are picked up automatically (including through
  pagination, infinite scroll, and "Load More" buttons) and deduplicated
  against what's already been collected.
- **Templates** — save a column/selector configuration as a reusable
  template for a given site.
- **Exports** — Raw Data (Excel with a frozen header + autofilter), CSV
  (formula-injection-safe), JSON, and bulk image download as a ZIP.
- **Localization** — UI available in English, Turkish, German, French,
  Simplified Chinese, and Russian.
- **Free trial** — every feature is available from install with a
  limited number of free scraping runs; a one-time purchase unlocks
  unlimited use (see [PRIVACY.md](PRIVACY.md) and the in-extension
  Settings panel for the current status of the paid unlock).

## Repository layout

```
background/   MV3 service worker (downloads, monitoring alarms, content-script lifecycle)
content/      Scripts injected into the page being scraped (selection, extraction, pagination)
popup/        The extension's UI (HTML/CSS/JS)
utils/        Shared, DOM-free logic (storage, exports, i18n, license/trial state, etc.)
icons/        Extension icons
scripts/      Local dev tooling — release packaging and a pre-release checklist script
```

`scripts/build-release.js` packages only the runtime files Chrome actually
needs (see that file's `RUNTIME_ENTRIES` list) into `dist/web-scraper-v<version>.zip`.
`scripts/release-check.js` runs a set of automated pre-release checks
(manifest validity, no remote/eval'd code, dev-only diagnostics properly
gated, i18n coverage) and then builds that ZIP.

## Development

There is no build step and no npm dependency — everything runs as plain
JavaScript loaded directly by Chrome (or, for local scripts, by Node).

To try a local change:
1. Open `chrome://extensions`, enable Developer Mode, and "Load unpacked"
   pointing at this repository's root folder.
2. After editing any file, click the reload icon on the extension's card
   in `chrome://extensions` (or use the extension's own "Version" text in
   Settings to confirm the reload picked up your change).

To run the pre-release checklist and build a production ZIP:
```
node scripts/release-check.js
```

## License / status

Internal project, not yet published to the Chrome Web Store. See
[STORE_LISTING.md](STORE_LISTING.md) for the draft store copy and
[PRIVACY.md](PRIVACY.md) for the privacy summary.
