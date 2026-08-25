/**
 * destinations.js (V1.24)
 * A small, reusable abstraction over WHERE exported data can go — spec
 * #14's "destination architecture". Two destinations are fully
 * implemented today (Download and Clipboard — both just point at
 * functionality this project already had before V1.24: triggerDownload/
 * CSV/Excel/JSON in popup.js, and the existing Copy feature). A third,
 * Google Sheets, is DELIBERATELY LEFT UNCONFIGURED — see the long comment
 * below for exactly why, and exactly what would be required to finish it.
 *
 * ============================================================
 * GOOGLE SHEETS — WHY IT ISN'T FULLY IMPLEMENTED, AND WHAT WOULD BE
 * NEEDED (spec #13's own explicit instruction: "Do not fake an
 * integration... If production-ready integration cannot be completed
 * without external credentials/setup that do not exist in this
 * repository: DO NOT hardcode fake credentials. Instead: implement a
 * clean destination abstraction, document exact required setup,
 * optionally provide development-safe scaffolding, keep the feature
 * disabled until configured.")
 * ============================================================
 * A real Google Sheets export needs:
 *   1. A Google Cloud project with the Sheets API (and, for a
 *      spreadsheet-picker UX, the Drive API) enabled.
 *   2. An OAuth 2.0 Client ID registered for a Chrome Extension (Google's
 *      "chrome-extension://<your-extension-id>" identity flow), which
 *      requires the extension to already have a STABLE, PUBLISHED
 *      extension ID — something that doesn't exist for an
 *      unpublished/dev-loaded extension in this repository.
 *   3. manifest.json would need an "oauth2" key with that real client_id
 *      and the https://www.googleapis.com/auth/spreadsheets scope (and
 *      the "identity" permission), none of which can be added truthfully
 *      without a real, provisioned client ID — adding a placeholder
 *      value would be exactly the "fake credentials" spec #13 forbids.
 *   4. Secure token handling via chrome.identity.getAuthToken (never
 *      storing a raw token in chrome.storage.local in plaintext long-
 *      term; never logging it — spec #15's "Never expose OAuth tokens in
 *      UI/logs" is honored by this scaffold simply never handling a
 *      token at all yet).
 *
 * None of that exists in this repository, and inventing placeholder
 * values for any of it would make the extension either non-functional
 * (a fake client_id makes chrome.identity.getAuthToken fail) or, worse,
 * LOOK like it works while silently doing nothing or erroring
 * unpredictably. Per spec #13, the correct choice is this file: a real,
 * usable abstraction (list()/isConfigured()/EXPORT VIA the SAME
 * canonical (columns, rows) pair Download/Clipboard already use) with
 * Google Sheets explicitly marked unavailable until a real client ID is
 * supplied. Finishing it later is a scoped, well-understood follow-up:
 * provision the 4 items above, fill in requestAuthToken() and
 * exportToGoogleSheets() below (currently throwing a clear
 * "not configured" error), and flip GOOGLE_SHEETS_CLIENT_ID.
 */
(function (root) {
  'use strict';

  // Left EMPTY deliberately — see the header comment. A real deployment
  // would set this to a provisioned OAuth Client ID; this file NEVER
  // ships a placeholder/fake value here, per spec #13.
  var GOOGLE_SHEETS_CLIENT_ID = '';

  function isGoogleSheetsConfigured() {
    return typeof GOOGLE_SHEETS_CLIENT_ID === 'string' && GOOGLE_SHEETS_CLIENT_ID.trim().length > 0;
  }

  /**
   * Every destination this abstraction knows about, in a fixed, stable
   * shape a UI can render generically:
   *   id, name, description, icon, available (can be used right now),
   *   reason (why not, when available is false)
   */
  function list() {
    return [
      { id: 'download', name: 'Download', description: 'Save CSV, Excel, JSON, or NDJSON directly to your computer.', icon: '⬇️', available: true, reason: null },
      { id: 'clipboard', name: 'Clipboard', description: 'Copy rows as TSV, CSV, or JSON to paste elsewhere.', icon: '📋', available: true, reason: null },
      {
        id: 'google-sheets', name: 'Google Sheets', description: 'Send rows directly into a new or existing spreadsheet.', icon: '📊',
        available: isGoogleSheetsConfigured(),
        reason: isGoogleSheetsConfigured() ? null : 'Not configured — this deployment has no Google OAuth Client ID set up. See utils/destinations.js and Chrome Extension projeler.txt for the exact setup steps.'
      }
    ];
  }

  function getDestination(id) {
    return list().filter(function (d) { return d.id === id; })[0] || null;
  }

  /**
   * The real export call — deliberately throws a clear, catchable error
   * (never silently "succeeds" doing nothing, never fakes a network
   * call) until GOOGLE_SHEETS_CLIENT_ID above is genuinely provisioned.
   * A caller (popup.js) is expected to catch this and show it as an
   * ordinary status message, exactly like any other export failure.
   * @param {{columns:Object[], rows:Object[]}} data the SAME canonical
   *   (transformed/filtered/sorted, optionally column-selected) dataset
   *   every other export/destination already uses — no separate data
   *   path for Sheets.
   * @param {{mode:'new'|'existing', spreadsheetId?:string, title?:string}} target
   */
  async function exportToGoogleSheets(data, target) {
    if (!isGoogleSheetsConfigured()) {
      throw new Error('Google Sheets isn’t set up for this installation yet (no OAuth Client ID configured). Use Download or Clipboard instead.');
    }
    // NOT REACHED until GOOGLE_SHEETS_CLIENT_ID is real — intentionally
    // left as a stub rather than a half-working network call. A real
    // implementation would: request a token via chrome.identity.
    // getAuthToken, create/open the target spreadsheet via the Sheets
    // API, write `data.columns`/`data.rows` as a single values.update
    // call, and NEVER log or display the token itself (spec #15).
    throw new Error('Google Sheets export is not yet implemented.');
  }

  root.WSDestinations = {
    list: list,
    getDestination: getDestination,
    isGoogleSheetsConfigured: isGoogleSheetsConfigured,
    exportToGoogleSheets: exportToGoogleSheets
  };
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
