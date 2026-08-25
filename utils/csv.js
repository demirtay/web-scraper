/**
 * csv.js
 * Converts extracted rows into a properly escaped CSV string.
 * Loaded directly by the popup (rows are built in the content script and
 * sent back over messaging, so CSV assembly happens where the download is
 * triggered).
 *
 * V1.24 additions (spec #5, #38): an optional delimiter (comma/semicolon/
 * tab) and CSV FORMULA-INJECTION protection, ON BY DEFAULT. CSV carries no
 * type information — when Excel/Google Sheets/LibreOffice opens a CSV
 * file, ANY cell whose text begins with =, +, -, @, a tab, or a carriage
 * return is liable to be interpreted as a formula rather than literal
 * text, regardless of what actually produced that value (a scraped page
 * can absolutely contain a title/price/note that happens to start with
 * one of these — this is a well-known, real vulnerability class ("CSV
 * injection"), not a hypothetical one). The industry-standard mitigation
 * (OWASP's own CSV Injection guidance) is applied by default: such a
 * value gets ONE leading single-quote character prepended before the
 * normal quoting/escaping rules run. Spreadsheet software that opens the
 * file then displays the value as plain text (the leading quote is a
 * recognized "force text" marker, not itself rendered) — the value is
 * preserved, just no longer executable. This does mean the raw underlying
 * text technically differs by one character from what was scraped; that
 * is the documented, accepted trade-off for closing a real security hole
 * (spec #38: "while preserving legitimate data as much as possible").
 * Can be turned off via opts.sanitizeFormulas === false for a caller that
 * has already made its own informed choice (e.g. a value known never to
 * reach a spreadsheet program).
 */
(function (root) {
  'use strict';

  var FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;

  function sanitizeFormulaValue(str) {
    return FORMULA_TRIGGER_RE.test(str) ? "'" + str : str;
  }

  /**
   * Escapes a single CSV field per RFC 4180: wraps the value in double
   * quotes whenever it contains the active delimiter, a quote, a newline
   * or a carriage return, and doubles any internal quotes. Applies
   * formula-injection sanitization first (see header) unless explicitly
   * disabled.
   * @param {*} value
   * @param {{delimiter?:string, sanitizeFormulas?:boolean}} [opts]
   */
  function escapeField(value, opts) {
    var str = value === null || value === undefined ? '' : String(value);
    if (!opts || opts.sanitizeFormulas !== false) str = sanitizeFormulaValue(str);
    var delimiter = (opts && opts.delimiter) || ',';
    if (str.indexOf(delimiter) !== -1 || /["\n\r]/.test(str)) {
      str = '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  /**
   * Builds a CSV string from an ordered list of columns and row objects
   * keyed by column id.
   * @param {{id:string, name:string}[]} columns
   * @param {Object[]} rows
   * @param {{delimiter?:string, sanitizeFormulas?:boolean}} [opts]
   *   delimiter: ',' (default) | ';' | '\t' — spec #5's Comma/Semicolon/Tab
   *   sanitizeFormulas: true (default) — see header comment
   * @returns {string}
   */
  function rowsToCSV(columns, rows, opts) {
    opts = opts || {};
    var delimiter = opts.delimiter || ',';
    var lines = [];
    lines.push(columns.map(function (c) { return escapeField(c.name, opts); }).join(delimiter));
    rows.forEach(function (row) {
      var line = columns.map(function (c) { return escapeField(row[c.id], opts); }).join(delimiter);
      lines.push(line);
    });
    // CRLF is the RFC 4180 convention and keeps Excel happy.
    return lines.join('\r\n');
  }

  root.WSCsv = {
    escapeField: escapeField,
    sanitizeFormulaValue: sanitizeFormulaValue,
    rowsToCSV: rowsToCSV,
    FORMULA_TRIGGER_RE: FORMULA_TRIGGER_RE
  };
})(typeof window !== 'undefined' ? window : globalThis);
