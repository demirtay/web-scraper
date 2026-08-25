# Privacy Policy — Web Scraper

_Last updated: 2026-08-25_

## Summary

Web Scraper processes data **entirely on your device**. It has no
connected backend, no account system, and does not send analytics or
telemetry of any kind. This is enforced by the code itself, not just
stated here — the extension makes no network requests except the two
described below, both of which are direct results of actions you take.

## What the extension stores

The extension stores the following locally, in Chrome's own extension
storage (`chrome.storage`) on your device — never uploaded anywhere:

- Your saved scraper configurations and templates (which fields/selectors
  you defined for a given site)
- Snapshots and change-detection history for scrapers you choose to
  monitor
- Your extension preferences (language, export settings, etc.)
- Your free-trial run count / license status (see below)
- The data you scrape, for as long as it takes you to review and export
  it (or until you clear it)

None of this is synced to any server the extension's developer operates,
because no such server currently exists for this data.

## When data leaves your browser

Data leaves the browser only in these cases, and only as a direct result
of something you explicitly did:

1. **You export your scraped data.** Clicking Excel/CSV/JSON/image-ZIP
   export saves a file directly to your own computer via Chrome's
   Downloads feature. This never goes through any server belonging to
   Web Scraper.
2. **You download images/files found on a page you scraped.** These are
   fetched directly from the site that hosts them (not from any Web
   Scraper server) and saved to your computer, the same way your browser
   downloads any file you click.
3. **Future paid-unlock verification (not active yet).** If a future
   version of the extension adds real license-purchase verification, only
   your email and license key would be sent to a license server to
   confirm your purchase — never any scraped page content or browsing
   history. As of this release, no such server is configured; the
   purchase/verification code paths in this build are inert stubs that
   always fail closed (see "Trial & paid unlock" below).

## Permissions

See `STORE_LISTING.md` for the full explanation of why each Chrome
permission is requested. In short: the extension only ever reads the page
you're actively viewing (and only after you've told it to), and only
requests access to a specific website's data when you use the extension
on that site.

## Trial & paid unlock

The extension currently ships a local, on-device free-trial counter (a
fixed number of free scraping runs, then a prompt to purchase unlimited
use). This counter is stored in `chrome.storage.local` on your device.
There is currently **no server-side purchase or license-verification
system connected** — the code paths for checkout/activation/recovery are
present but intentionally return "not configured" rather than granting
access, so no payment can currently be faked or fabricated by the
extension itself.

## Data you scrape from other websites

When you use this extension, you are extracting data from pages you
choose to visit, subject to that site's own terms of service. Web Scraper
does not decide what to collect on your behalf — it only acts on the
fields you manually select. You are responsible for how you use any data
you export.

## Contact

For privacy questions about this extension, contact the developer at the
support address listed on its Chrome Web Store listing page.
