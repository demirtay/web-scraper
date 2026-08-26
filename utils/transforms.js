/**
 * transforms.js
 * V1.7 Data Cleaning / Transform — pure, DOM-free (except stripHtml, which
 * uses the browser's own DOMParser, never executes anything) row/column
 * transform pipeline. Mirrors results.js/changes.js's separation of
 * concerns: this file only ever reads rawRows + a transform CONFIG list
 * and produces a new (rows, columns) pair — it never mutates its inputs
 * and never touches chrome.storage or the scraper engine.
 *
 * NON-DESTRUCTIVE BY DESIGN (spec #24): callers keep rawRows untouched
 * forever and store only the transform list (plain, serializable config
 * objects); the "current" dataset is always reproduced fresh via
 * applyTransforms(rawRows, columns, transforms, context). Undo/Remove
 * step/Reset Transforms are therefore just edits to that config list,
 * never a snapshot of intermediate data.
 *
 * Two transform kinds:
 *  - VALUE transforms (trim, removeCurrency, normalizeNumber, ...): same
 *    column id in, same column id out by default, just a new string
 *    value — UNLESS the step sets `destination:'newColumn'` (V1.23 spec
 *    #19 Column Derivation), in which case it behaves structurally too:
 *    the source column is left completely untouched (raw value preserved
 *    in place, spec #20) and a brand new column receives the transformed
 *    value instead. Omitting `destination` (every pre-V1.23 saved
 *    transform) is exactly the old in-place behavior — fully backward
 *    compatible by construction.
 *  - STRUCTURAL transforms (split in its default 'columns' output mode,
 *    and combine): change the column LIST too (split adds N columns;
 *    combine adds 1 and optionally removes its sources) — so
 *    applyTransforms threads a (rows, columns) pair through every step,
 *    not just rows. Downstream code (Filter/Sort/Export/Download/
 *    Snapshot) is expected to use the COLUMNS this module returns, not
 *    the scraper's original column list, once any structural transform
 *    is present. (V1.23: split's non-'columns' output modes — firstPart/
 *    lastPart/partByIndex/joinParts — produce a SINGLE value per row and
 *    are therefore VALUE transforms, not structural ones; see
 *    isStructuralSplit below.)
 *
 * V1.23 additions (Advanced Data Cleaning / Transformations): more text-
 * cleaning ops (line breaks/tabs, prefix/suffix removal, capitalize-
 * first, HTML-entity decode, Unicode normalize, invisible-character
 * removal), a `mode`-aware Normalize Number (auto/US/EU/custom
 * separators), Normalize Currency (keep text / remove symbol / normalize
 * value — no exchange-rate conversion, ever), Normalize Percentage
 * (explicit number-or-decimal output, never guessed), Normalize Date (a
 * small dedicated parser — deliberately NOT Date.parse, whose ambiguous-
 * format behavior is locale/engine-dependent; ambiguous numeric dates
 * are left untouched unless the user gives an explicit day/month order
 * hint, and no timezone is ever fabricated), Normalize Boolean (fully
 * user-configurable true/false value lists), an extended Fill Empty
 * (spec #14's broader "treat these as missing" token list), Regex
 * Extract "all matches" mode, Extract Domain, per-step enable/disable
 * (`t.enabled === false` to skip, anything else = enabled — so a legacy
 * step with no `enabled` field at all is still active, unchanged), the
 * generic `destination:'newColumn'` mechanism described above, a handful
 * of ready-made Transform Presets (spec #25), and `sanitizeTransformList`
 * — a prototype-pollution-safe rebuild used to accept a transform
 * pipeline from an untrusted V1.22 Template import (spec #23/#27) without
 * ever introducing a second execution path.
 */
(function (root) {
  'use strict';

  var MAX_REGEX_INPUT_LENGTH = 5000; // defensive cap against pathological input on regex ops; scraped cell values never realistically approach this
  var MAX_OPTION_STRING_LEN = 2000; // sanitizeTransformList's per-string cap — matches utils/templates.js's own MAX_STRING_LEN convention
  var MAX_TRANSFORM_STEPS = 50; // sanitizeTransformList's cap on an untrusted imported pipeline length

  // ---- id/name helpers ----------------------------------------------------

  function makeTransformId() {
    return 'tf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  function findColumn(columns, id) {
    return columns.filter(function (c) { return c.id === id; })[0] || null;
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Throws a clean Error on an invalid pattern/flags combination — meant
   * to be called ONCE before mapping over rows, so a bad regex fails fast
   * with one clear message instead of N identical per-row exceptions.
   * Returns the COMPILED RegExp so callers can reuse it across every row
   * instead of recompiling the same pattern once per row. */
  function validateRegex(pattern, flags) {
    if (!pattern) throw new Error('A regular expression pattern is required.');
    try {
      return new RegExp(pattern, String(flags || '').replace(/[^gimsuy]/g, ''));
    } catch (e) {
      throw new Error('Invalid regular expression: ' + e.message);
    }
  }

  // ---- value operations (spec #3-#14, #19-#21) -----------------------------

  function trim(v) { return v == null ? v : String(v).trim(); }

  function collapseWhitespace(v) { return v == null ? v : String(v).replace(/\s+/g, ' ').trim(); }

  function removeLineBreaks(v) { return v == null ? v : String(v).replace(/\r\n|\r|\n/g, ' '); }

  function normalizeLineBreaks(v) { return v == null ? v : String(v).replace(/\r\n|\r/g, '\n'); }

  function removeTabs(v) { return v == null ? v : String(v).replace(/\t/g, ' '); }

  var INVISIBLE_CHARS_RE = /[​‌‍⁠﻿­]/g; // zero-width space/non-joiner/joiner, word joiner, BOM, soft hyphen
  function removeInvisibleChars(v) { return v == null ? v : String(v).replace(INVISIBLE_CHARS_RE, ''); }

  /** Unicode NORMALIZE only (canonical/compatibility COMPOSE) — never
   * DECOMPOSE (NFD/NFKD), which would visibly split accented characters
   * into base+combining-mark pairs. Conservative per spec #3 ("do not
   * destroy legitimate Unicode characters"). */
  function normalizeUnicode(v, opts) {
    if (v == null) return v;
    var s = String(v);
    if (typeof s.normalize !== 'function') return s;
    var form = (opts && opts.form === 'NFKC') ? 'NFKC' : 'NFC';
    try { return s.normalize(form); } catch (e) { return s; }
  }

  // A small, conservative table of the common named entities actually seen
  // in scraped markup — an UNKNOWN named entity is left untouched rather
  // than guessed (never destroys data). Numeric entities (&#39; / &#x27;)
  // are always handled generically below.
  var NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    copy: '©', reg: '®', trade: '™', hellip: '…',
    mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
    ldquo: '“', rdquo: '”', euro: '€', pound: '£',
    yen: '¥', cent: '¢', deg: '°', middot: '·', bull: '•'
  };

  /** Decodes HTML entities WITHOUT parsing/interpreting any markup — a
   * deliberate regex-only implementation (not DOMParser, unlike
   * stripHtml) so a stray literal '<'/'>' in the text is never
   * misinterpreted as a tag and silently dropped. No script execution,
   * ever. */
  function decodeHtmlEntities(v) {
    if (v == null) return v;
    var s = String(v);
    if (s.indexOf('&') === -1) return s; // fast path — most scraped text has no entities at all
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, function (whole, ent) {
      if (ent.charAt(0) === '#') {
        var isHex = ent.charAt(1) === 'x' || ent.charAt(1) === 'X';
        var code = isHex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        if (isNaN(code) || code < 0 || code > 0x10FFFF) return whole;
        try { return String.fromCodePoint(code); } catch (e) { return whole; }
      }
      var lower = ent.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower) ? NAMED_ENTITIES[lower] : whole;
    });
  }

  var CURRENCY_SYMBOL_RE = /[$€£₺¥₹]/g;
  var CURRENCY_CODE_RE = /\b(USD|EUR|GBP|TRY|JPY|INR)\b/gi;

  /** Strips obvious currency symbols/codes only — does NOT re-parse or
   * reformat the number, per spec #5 (that's Normalize Number's job). */
  function removeCurrency(v) {
    if (v == null) return v;
    var s = String(v).replace(CURRENCY_SYMBOL_RE, '').replace(CURRENCY_CODE_RE, '');
    return s.replace(/\s{2,}/g, ' ').trim();
  }

  /** Finds the first numeric-looking run and returns its canonical value
   * as a STRING (spec #33 prefers string output for export compatibility),
   * reusing WSResults.parseNumeric for the actual locale disambiguation —
   * no separate number-parsing logic is introduced here. */
  function extractNumber(v) {
    if (v == null) return '';
    var s = String(v);
    var m = s.match(/\d[\d.,]*\d|\d/);
    if (!m) return '';
    var WR = root.WSResults;
    var parsed = WR && WR.parseNumeric ? WR.parseNumeric(m[0]) : null;
    return parsed === null ? m[0] : String(parsed);
  }

  /**
   * Converts a locale-formatted number to a canonical decimal-string form.
   *
   * opts.mode:
   *  - 'auto' (default): reuses WSResults.normalizeNumericString for the
   *    SAME disambiguation Filter/Sort already use — preserves the
   *    source's decimal precision (e.g. "25,50" -> "25.50") and refuses
   *    to guess a genuinely ambiguous value (V1.23 spec #9: "Do NOT guess
   *    aggressively").
   *  - 'us': '.' is always the decimal separator, ',' is always a
   *    thousands separator, regardless of digit-grouping.
   *  - 'eu': ',' is always the decimal separator, '.' is always a
   *    thousands separator.
   *  - 'custom': opts.decimalSep / opts.thousandsSep (either may be '').
   *
   * Any value that doesn't cleanly reduce to a number under the selected
   * mode is left UNCHANGED — never a silent/aggressive guess.
   */
  function normalizeNumber(v, opts) {
    if (v == null) return v;
    var mode = (opts && opts.mode) || 'auto';

    if (mode === 'auto') {
      var WR = root.WSResults;
      if (!WR || !WR.normalizeNumericString) return v;
      var n = WR.normalizeNumericString(v);
      if (!n) return v;
      if (n.multiplier === 1 && !n.negative) return n.str;
      var val0 = parseFloat(n.str) * n.multiplier * (n.negative ? -1 : 1);
      return isNaN(val0) ? v : String(val0);
    }

    var decimalSep, thousandsSep;
    if (mode === 'us') { decimalSep = '.'; thousandsSep = ','; }
    else if (mode === 'eu') { decimalSep = ','; thousandsSep = '.'; }
    else { decimalSep = (opts && opts.decimalSep) || '.'; thousandsSep = (opts && opts.thousandsSep) != null ? opts.thousandsSep : ''; }

    var s = String(v).trim();
    if (!s) return v;
    var negative = /^-/.test(s) || /^\(.*\)$/.test(s);
    s = s.replace(/^[-+]/, '').replace(/^\(|\)$/g, '').trim();
    s = s.replace(/[^\d.,\s]/g, '').trim(); // strip currency/text — keep only digits, both separator characters, and whitespace
    if (!s) return v;

    if (thousandsSep && thousandsSep !== decimalSep) s = s.split(thousandsSep).join('');
    else if (!thousandsSep) s = s.replace(/\s/g, ''); // no explicit thousands separator configured -> treat stray spaces as thousands grouping
    if (decimalSep !== '.') s = s.split(decimalSep).join('.');

    if (!/\d/.test(s) || !/^\d*\.?\d*$/.test(s)) return v; // didn't reduce to a clean number under this mode -> leave unchanged
    var num = parseFloat(s);
    if (isNaN(num)) return v;
    return String(negative ? -num : num);
  }

  /**
   * Cleans a currency-formatted value. NEVER performs exchange-rate
   * conversion (V1.23 spec #10 — out of scope for V1.x entirely).
   * opts.mode:
   *  - 'keepText' — identity (kept for UI/preset symmetry / documented no-op)
   *  - 'removeSymbol' — strips the symbol/code, keeps the number as text
   *    (delegates to removeCurrency)
   *  - 'normalizeValue' (default) — strips the symbol/code AND reformats
   *    the remaining number via normalizeNumber, honoring opts.numberMode/
   *    decimalSep/thousandsSep (kept as separate option keys from this
   *    transform's own opts.mode so the two enums never collide).
   */
  function normalizeCurrency(v, opts) {
    if (v == null) return v;
    var mode = (opts && opts.mode) || 'normalizeValue';
    if (mode === 'keepText') return v;
    if (mode === 'removeSymbol') return removeCurrency(v);
    var stripped = removeCurrency(v);
    return normalizeNumber(stripped, { mode: (opts && opts.numberMode) || 'auto', decimalSep: opts && opts.decimalSep, thousandsSep: opts && opts.thousandsSep });
  }

  /**
   * Normalizes a percentage value. ONLY ever outputs the mode the user
   * explicitly picked (V1.23 spec #11 — "Do not guess silently"):
   *  - 'asNumber' (default): "18.5 %" -> "18.5"
   *  - 'asDecimal': "18.5 %" -> "0.185"
   */
  function normalizePercentage(v, opts) {
    if (v == null) return v;
    var s = String(v).replace(/%/g, '').trim();
    if (!s) return v;
    var WR = root.WSResults;
    var n = WR && WR.normalizeNumericString ? WR.normalizeNumericString(s) : null;
    if (!n) return v;
    var val = parseFloat(n.str) * n.multiplier * (n.negative ? -1 : 1);
    if (isNaN(val)) return v;
    if (opts && opts.mode === 'asDecimal') val = val / 100;
    return String(val);
  }

  function parseListOpt(s) {
    return String(s || '').split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
  }

  var DEFAULT_TRUE_VALUES = 'yes,y,true,1,available,in stock';
  var DEFAULT_FALSE_VALUES = 'no,n,false,0,unavailable,out of stock';

  /**
   * Maps common values to true/false using FULLY user-configurable lists
   * (V1.23 spec #13 — "Do not impose ecommerce-specific meanings
   * globally"; the defaults above are only a convenience starting point,
   * never hard-imposed). A value matching neither list is handled per
   * opts.unmatchedMode: 'keep' (default — leave untouched), 'empty', or
   * 'custom' (opts.unmatchedValue).
   */
  function normalizeBoolean(v, opts) {
    if (v == null) return v;
    var s = String(v).trim().toLowerCase();
    if (!s) return v;
    var trueList = parseListOpt((opts && opts.trueValues) || DEFAULT_TRUE_VALUES);
    var falseList = parseListOpt((opts && opts.falseValues) || DEFAULT_FALSE_VALUES);
    var outTrue = (opts && opts.outputTrue != null && opts.outputTrue !== '') ? opts.outputTrue : 'true';
    var outFalse = (opts && opts.outputFalse != null && opts.outputFalse !== '') ? opts.outputFalse : 'false';
    if (trueList.indexOf(s) !== -1) return outTrue;
    if (falseList.indexOf(s) !== -1) return outFalse;
    var unmatched = (opts && opts.unmatchedMode) || 'keep';
    if (unmatched === 'empty') return '';
    if (unmatched === 'custom') return (opts && opts.unmatchedValue) || '';
    return v;
  }

  // ---- date normalization (spec #12) ---------------------------------------
  // Deliberately NOT Date.parse()/`new Date(string)` — their handling of
  // ambiguous formats is locale/engine-dependent and exactly the kind of
  // silent misinterpretation this spec forbids. A small dedicated parser
  // instead: ISO and named-month forms are unambiguous and always
  // resolved; a bare numeric D/M/Y-or-M/D/Y form is resolved automatically
  // ONLY when one of the two candidate day/month numbers is >12 (so it can
  // only be the day); a genuinely ambiguous numeric date (both parts <=12)
  // is left UNCHANGED unless the user supplies an explicit dayMonthOrder
  // hint. No timezone is ever fabricated onto a value that didn't have one.

  var MONTH_NAMES = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
    may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
    sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
  };

  function pad2(n) { var s = String(n); return s.length < 2 ? '0' + s : s; }

  function parseDateParts(raw, opts) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return null;

    var iso = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (iso) {
      var y1 = +iso[1], mo1 = +iso[2], d1 = +iso[3];
      if (mo1 >= 1 && mo1 <= 12 && d1 >= 1 && d1 <= 31) {
        return { y: y1, mo: mo1, d: d1, h: iso[4] != null ? +iso[4] : null, mi: iso[5] != null ? +iso[5] : null, sec: iso[6] != null ? +iso[6] : null };
      }
    }

    var tm1 = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
    if (tm1 && MONTH_NAMES[tm1[2].toLowerCase()]) {
      return { y: +tm1[3], mo: MONTH_NAMES[tm1[2].toLowerCase()], d: +tm1[1], h: null, mi: null, sec: null };
    }
    var tm2 = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
    if (tm2 && MONTH_NAMES[tm2[1].toLowerCase()]) {
      return { y: +tm2[3], mo: MONTH_NAMES[tm2[1].toLowerCase()], d: +tm2[2], h: null, mi: null, sec: null };
    }

    var num = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (num) {
      var a = +num[1], b = +num[2], y2 = +num[3];
      var dayFirst;
      if (a > 12 && b <= 12) dayFirst = true;
      else if (b > 12 && a <= 12) dayFirst = false;
      else if (a <= 12 && b <= 12) {
        var order = opts && opts.dayMonthOrder;
        if (order === 'dayFirst') dayFirst = true;
        else if (order === 'monthFirst') dayFirst = false;
        else return null; // genuinely ambiguous, no explicit hint given -> refuse to guess
      } else {
        return null; // both > 12 -> not a valid day/month pair at all
      }
      var day = dayFirst ? a : b, month = dayFirst ? b : a;
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      return { y: y2, mo: month, d: day, h: num[4] != null ? +num[4] : null, mi: num[5] != null ? +num[5] : null, sec: num[6] != null ? +num[6] : null };
    }

    return null;
  }

  function formatDateParts(p, outputFormat) {
    var datePart = p.y + '-' + pad2(p.mo) + '-' + pad2(p.d);
    if (outputFormat === 'YYYY-MM-DD HH:mm') {
      if (p.h == null) return datePart; // no fabricated time-of-day
      return datePart + ' ' + pad2(p.h) + ':' + pad2(p.mi || 0);
    }
    if (outputFormat === 'iso') {
      if (p.h == null) return datePart; // no fabricated time or timezone
      return datePart + 'T' + pad2(p.h) + ':' + pad2(p.mi || 0) + ':' + pad2(p.sec || 0);
    }
    return datePart; // 'YYYY-MM-DD' (default)
  }

  function normalizeDate(v, opts) {
    if (v == null) return v;
    var s = String(v).trim();
    if (!s) return v;
    var parts = parseDateParts(s, opts);
    if (!parts) return v; // unparseable OR ambiguous with no hint -> leave untouched
    return formatDateParts(parts, (opts && opts.outputFormat) || 'YYYY-MM-DD');
  }

  function findReplace(v, opts) {
    if (v == null) return v;
    var s = String(v);
    var find = (opts && opts.find) || '';
    if (!find) return s;
    var replace = (opts && opts.replace) || '';
    var firstOnly = opts && opts.occurrence === 'first';
    if (opts && opts.caseSensitive) {
      if (!firstOnly) return s.split(find).join(replace);
      var idx = s.indexOf(find);
      return idx === -1 ? s : s.slice(0, idx) + replace + s.slice(idx + find.length);
    }
    var re = new RegExp(escapeRegExp(find), firstOnly ? 'i' : 'gi');
    return s.replace(re, replace);
  }

  function regexReplaceValue(v, opts, compiledRe) {
    if (v == null) return v;
    var s = String(v);
    if (s.length > MAX_REGEX_INPUT_LENGTH) return s; // defensive: skip rather than risk a pathological pattern on huge input
    var re = compiledRe;
    if (!re) { try { re = new RegExp(opts.pattern, String(opts.flags || '').replace(/[^gimsuy]/g, '')); } catch (e) { return s; } }
    return s.replace(re, (opts && opts.replacement) || '');
  }

  function toTitleCase(s) {
    return s.replace(/\w\S*/g, function (w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); });
  }

  function changeCase(v, opts) {
    if (v == null) return v;
    var s = String(v);
    var mode = opts && opts.mode;
    if (mode === 'upper') return s.toUpperCase();
    if (mode === 'lower') return s.toLowerCase();
    if (mode === 'title') return toTitleCase(s);
    return s;
  }

  /** Capitalizes ONLY the first letter found — everything else in the
   * string is left exactly as-is (unlike Title Case, which reshapes every
   * word). Conservative about script: only recognizes Latin/Latin-
   * Extended/Cyrillic letters, so text in a script without a case
   * distinction is left untouched rather than guessed at. */
  function capitalizeFirst(v) {
    if (v == null) return v;
    var s = String(v);
    var m = s.match(/[A-Za-zÀ-ɏЀ-ӿ]/);
    if (!m) return s;
    var idx = m.index;
    return s.slice(0, idx) + s.charAt(idx).toUpperCase() + s.slice(idx + 1);
  }

  function prefixSuffix(v, opts) {
    var s = v == null ? '' : String(v);
    return ((opts && opts.prefix) || '') + s + ((opts && opts.suffix) || '');
  }

  function removePrefix(v, opts) {
    if (v == null) return v;
    var s = String(v);
    var prefix = (opts && opts.prefix) || '';
    if (!prefix) return s;
    var hit = (opts && opts.caseSensitive) ? s.indexOf(prefix) === 0 : s.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
    return hit ? s.slice(prefix.length) : s;
  }

  function removeSuffix(v, opts) {
    if (v == null) return v;
    var s = String(v);
    var suffix = (opts && opts.suffix) || '';
    if (!suffix) return s;
    var hit = (opts && opts.caseSensitive) ? s.slice(-suffix.length) === suffix : s.slice(-suffix.length).toLowerCase() === suffix.toLowerCase();
    return hit ? s.slice(0, s.length - suffix.length) : s;
  }

  /** Replaces ONLY empty/null/undefined/whitespace-only values, PLUS any
   * value that case-insensitively matches opts.matchValues (a comma list
   * of extra "missing" tokens like "-, N/A, NA, null, None" — V1.23 spec
   * #14) — never touches a value that's genuinely populated. opts.mode
   * 'custom' (default) fills with opts.value; 'toEmpty' clears the match
   * to an empty string regardless of opts.value. */
  function fillEmpty(v, opts) {
    var isBlank = v === null || v === undefined || String(v).trim() === '';
    var matchList = (opts && opts.matchValues) ? parseListOpt(opts.matchValues) : [];
    var isMatched = !isBlank && matchList.indexOf(String(v).trim().toLowerCase()) !== -1;
    if (!isBlank && !isMatched) return v;
    if (opts && opts.mode === 'toEmpty') return '';
    return (opts && opts.value) || '';
  }

  function normalizeUrl(v, opts, context) {
    if (v == null) return v;
    var s = String(v).trim();
    if (!s) return s;
    var base = context && context.baseUrl;
    var resolved;
    try {
      resolved = new URL(s, base).href; // also normalizes a protocol-relative "//host/path" using the base's own protocol
    } catch (e) {
      return v; // not a resolvable URL — leave untouched rather than corrupt it
    }
    if (opts && opts.removeFragment) {
      try { var u = new URL(resolved); u.hash = ''; resolved = u.href; } catch (e) { /* keep resolved as-is */ }
    }
    return resolved;
  }

  // Generic, well-known tracking parameters only — deliberately NOT a
  // catch-all (spec #14: never strips an arbitrary/unrecognized param).
  // Kept in sync by hand with utils/runstate.js's own identically-named
  // IDENTITY_TRACKING_PARAMS list (that file's own dedupe-identity
  // canonicalization uses this exact same set) — a local copy, not a
  // cross-file reference, since this file isn't loaded in every context
  // that one is (see that file's own comment for why). Extended (data-
  // integrity mission) to also cover Etsy's own `ref`/`click_key`/
  // `click_sum` tracking parameters, the concrete real-world case that
  // originally motivated this list.
  var TRACKING_PARAMS = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid',
    'ref', 'ref_src', 'ref_url', 'ref_page', 'ref_sr', 'referrer',
    'click_key', 'click_sum', 'ga_order', 'content_source',
    'campaign_id', 'campaignid', 'aff_id', 'affiliate_id',
    'spm', 'igshid', 'yclid', 'dclid', '_ga', '_gl'
  ];

  function removeTrackingParams(v, context) {
    if (v == null) return v;
    var s = String(v).trim();
    if (!s) return s;
    var u;
    try { u = new URL(s, context && context.baseUrl); } catch (e) { return v; }
    TRACKING_PARAMS.forEach(function (p) { u.searchParams.delete(p); });
    return u.href;
  }

  /** Derives a piece of a URL — this is a TRANSFORMATION, not analysis
   * (V1.23 spec #16). opts.part:
   *  - 'domain' (default) — hostname with a leading "www." stripped, e.g.
   *    "www.example.com" -> "example.com" (only that one literal prefix;
   *    never a broader subdomain-stripping heuristic)
   *  - 'hostname' — the raw hostname, "www." kept as-is
   *  - 'origin' — protocol + hostname + port
   *  - 'path' — pathname only
   *  - 'query' — the query string, without the leading '?'
   */
  function extractDomain(v, opts, context) {
    if (v == null) return v;
    var s = String(v).trim();
    if (!s) return s;
    var u;
    try { u = new URL(s, context && context.baseUrl); } catch (e) { return v; }
    var part = (opts && opts.part) || 'domain';
    if (part === 'hostname') return u.hostname;
    if (part === 'origin') return u.origin;
    if (part === 'path') return u.pathname;
    if (part === 'query') return u.search.replace(/^\?/, '');
    return u.hostname.replace(/^www\./i, '');
  }

  function regexExtractValue(v, opts, compiledRe) {
    var fallback = opts && opts.fallback === 'original';
    if (v == null) return fallback ? v : '';
    var s = String(v);
    if (s.length > MAX_REGEX_INPUT_LENGTH) return fallback ? s : '';

    var wantAll = !!(opts && opts.all);
    var flags = String((opts && opts.flags) || '');
    if (wantAll && flags.indexOf('g') === -1) flags += 'g';

    var re = compiledRe;
    if (!re) { try { re = new RegExp(opts.pattern, flags); } catch (e) { return fallback ? s : ''; } }

    if (wantAll) {
      re.lastIndex = 0; // a shared/reused compiled regex is stateful under 'g' — always reset before a fresh exec loop
      var g = (opts && opts.group != null) ? opts.group : 0;
      var results = [];
      var m;
      var guard = 0;
      while ((m = re.exec(s)) !== null && guard < 10000) {
        guard++;
        if (m[g] !== undefined) results.push(m[g]);
        if (m[0] === '') re.lastIndex++; // avoid an infinite loop on a zero-length match
      }
      if (!results.length) return fallback ? s : '';
      return results.join(opts && opts.joinWith != null ? opts.joinWith : ', ');
    }

    re.lastIndex = 0;
    var mm = re.exec(s);
    if (!mm) return fallback ? s : '';
    var g2 = (opts && opts.group != null) ? opts.group : 0;
    return mm[g2] !== undefined ? mm[g2] : (fallback ? s : '');
  }

  function substringValue(v, opts) {
    if (v == null) return v;
    var s = String(v);
    var mode = opts && opts.mode;
    if (mode === 'firstN') return s.slice(0, Math.max(0, (opts && opts.n) || 0));
    if (mode === 'lastN') return (opts && opts.n) ? s.slice(-opts.n) : '';
    return s.slice((opts && opts.start) || 0, (opts && opts.end != null) ? opts.end : undefined);
  }

  function stripHtml(v) {
    if (v == null) return v;
    var s = String(v);
    if (!/[<>]/.test(s)) return s; // fast path — most scraped text already has no markup
    if (typeof DOMParser === 'undefined') return s; // non-browser context (e.g. a pure Node test) — leave untouched rather than fail
    try {
      var doc = new DOMParser().parseFromString(s, 'text/html');
      return (doc.body && doc.body.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (e) {
      return s;
    }
  }

  // ---- template fill (spec #18: reuse the filename-template util) ---------

  /** Reuses WSDownloads.buildFilenameFromTemplate (same {ColumnName}/
   * {index} syntax already used by Bulk Download filenames) when it's
   * loaded; falls back to an equivalent local implementation so this
   * module still works standalone/in isolated tests. Missing fields
   * resolve to '' rather than throwing (spec #18). Purely data
   * substitution — no expression evaluation of any kind. */
  function fillTemplate(template, row, columns, rowIndex) {
    var reuse = root.WSDownloads && root.WSDownloads.buildFilenameFromTemplate;
    if (typeof reuse === 'function') return reuse(template, row, columns, rowIndex || 0);
    if (!template) return '';
    return String(template).replace(/\{([^{}]+)\}/g, function (whole, token) {
      var t = token.trim();
      if (t === 'index' || t === 'row') return String((rowIndex || 0) + 1);
      var col = columns.filter(function (c) { return c.name === t; })[0];
      return col ? String(row[col.id] || '') : '';
    });
  }

  // ---- structural operations: split / combine (spec #7-8, #15-#17) --------

  /** Splits a raw value into parts under the three supported modes
   * (delimiter / whitespace / regex), sharing one implementation between
   * the structural "Split Column" and the value-style split output modes
   * (firstPart/lastPart/partByIndex/joinParts) below. Accepts a
   * pre-compiled regex so callers validate/compile ONCE per pipeline
   * build, not once per row. */
  function buildSplitParts(v, opts, compiledRe) {
    var s = String(v == null ? '' : v);
    if (opts.mode === 'regex') {
      var re = compiledRe || validateRegex(opts.pattern, opts.flags);
      return s.split(re);
    }
    if (opts.mode === 'whitespace') {
      var trimmed = s.trim();
      return trimmed ? trimmed.split(/\s+/) : [''];
    }
    var delimiter = opts.delimiter;
    if (!delimiter) throw new Error('Split: a delimiter is required.');
    if (opts.limit === 'first') {
      var idx = s.indexOf(delimiter);
      return idx === -1 ? [s] : [s.slice(0, idx), s.slice(idx + delimiter.length)];
    }
    return s.split(delimiter);
  }

  /** Whether a 'split' step is the STRUCTURAL kind (creates N new
   * columns) vs a VALUE-style kind (a single derived value per row) —
   * missing/'columns' outputMode is the original, pre-V1.23 structural
   * behavior; every other outputMode is new in V1.23. */
  function isStructuralSplit(t) {
    var m = t.options && t.options.outputMode;
    return !m || m === 'columns';
  }

  function applySplit(rows, columns, t) {
    var opts = t.options || {};
    var srcCol = findColumn(columns, t.column);
    if (!srcCol) throw new Error('Split: the source column no longer exists.');

    var outputNames = (opts.outputNames && opts.outputNames.length) ? opts.outputNames : ['Part 1', 'Part 2'];
    var dupName = outputNames.filter(function (name) {
      return columns.some(function (c) { return c.name === name && c.id !== t.column; });
    })[0];
    if (dupName) throw new Error('Split: a column named "' + dupName + '" already exists.');

    var compiledRe = opts.mode === 'regex' ? validateRegex(opts.pattern, opts.flags) : null;
    if (opts.mode !== 'regex' && opts.mode !== 'whitespace' && !opts.delimiter) throw new Error('Split: a delimiter is required.');
    var splitFn = function (v) { return buildSplitParts(v, opts, compiledRe); };

    var newColIds = outputNames.map(function (name, i) { return 'split_' + t.id + '_' + i; });
    var newRows = rows.map(function (row) {
      var clone = Object.assign({}, row);
      var parts = splitFn(row[t.column]);
      newColIds.forEach(function (id, i) { clone[id] = parts[i] !== undefined ? String(parts[i]).trim() : ''; });
      return clone;
    });

    var origIndex = columns.findIndex(function (c) { return c.id === t.column; });
    var toInsert = newColIds.map(function (id, i) { return { id: id, name: outputNames[i], attribute: 'text' }; });
    var newColumns = columns.slice(0, origIndex + 1).concat(toInsert, columns.slice(origIndex + 1));
    if (!opts.keepOriginal) {
      newRows.forEach(function (row) { delete row[t.column]; });
      newColumns = newColumns.filter(function (c) { return c.id !== t.column; });
    }

    return { rows: newRows, columns: newColumns };
  }

  /** Builds the single-value function for split's VALUE-style output
   * modes (firstPart/lastPart/partByIndex/joinParts) — validates/compiles
   * once up front, exactly like buildValueFn does for ordinary transforms. */
  function buildSplitValueFn(opts) {
    var compiledRe = opts.mode === 'regex' ? validateRegex(opts.pattern, opts.flags) : null;
    if (opts.mode !== 'regex' && opts.mode !== 'whitespace' && !opts.delimiter) throw new Error('Split: a delimiter is required.');
    var outputMode = opts.outputMode;
    return function (v) {
      var parts = buildSplitParts(v, opts, compiledRe);
      if (outputMode === 'lastPart') return parts.length ? String(parts[parts.length - 1]).trim() : '';
      if (outputMode === 'partByIndex') {
        var idx = (opts.partIndex != null) ? opts.partIndex : 0;
        return (idx >= 0 && idx < parts.length) ? String(parts[idx]).trim() : '';
      }
      if (outputMode === 'joinParts') {
        var joinWith = opts.joinWith != null ? opts.joinWith : ' ';
        return parts.map(function (p) { return String(p).trim(); }).join(joinWith);
      }
      return parts.length ? String(parts[0]).trim() : ''; // 'firstPart' (also the safe default)
    };
  }

  function applyCombine(rows, columns, t) {
    var opts = t.options || {};
    var sourceIds = opts.sourceColumns || [];
    if (sourceIds.length < 2) throw new Error('Combine: select at least two columns.');
    var missing = sourceIds.filter(function (id) { return !findColumn(columns, id); });
    if (missing.length) throw new Error('Combine: a source column no longer exists.');

    var outputName = (opts.outputName || '').trim();
    if (!outputName) throw new Error('Combine: an output column name is required.');
    if (columns.some(function (c) { return c.name === outputName && sourceIds.indexOf(c.id) === -1; })) {
      throw new Error('Combine: a column named "' + outputName + '" already exists.');
    }

    var template = opts.template || sourceIds.map(function (id) {
      var c = findColumn(columns, id);
      return '{' + (c ? c.name : id) + '}';
    }).join(' ');

    var newColId = 'combine_' + t.id;
    var newRows = rows.map(function (row, idx) {
      var clone = Object.assign({}, row);
      clone[newColId] = fillTemplate(template, row, columns, idx);
      if (!opts.keepOriginal) sourceIds.forEach(function (id) { delete clone[id]; });
      return clone;
    });

    var lastIdx = Math.max.apply(null, sourceIds.map(function (id) { return columns.findIndex(function (c) { return c.id === id; }); }));
    var newColumns = columns.slice(0, lastIdx + 1).concat([{ id: newColId, name: outputName, attribute: 'text' }], columns.slice(lastIdx + 1));
    if (!opts.keepOriginal) newColumns = newColumns.filter(function (c) { return sourceIds.indexOf(c.id) === -1; });

    return { rows: newRows, columns: newColumns };
  }

  // ---- dispatcher -----------------------------------------------------------

  /** Builds a single-value transform function, validating any regex/config
   * ONCE up front (so a bad pattern throws a single clean error rather
   * than failing per-row). Value functions themselves are null-safe and
   * never throw. */
  function buildValueFn(t, context) {
    var opts = t.options || {};
    switch (t.type) {
      case 'trim': return trim;
      case 'collapseWhitespace': return collapseWhitespace;
      case 'removeLineBreaks': return removeLineBreaks;
      case 'normalizeLineBreaks': return normalizeLineBreaks;
      case 'removeTabs': return removeTabs;
      case 'removeInvisibleChars': return removeInvisibleChars;
      case 'normalizeUnicode': return function (v) { return normalizeUnicode(v, opts); };
      case 'decodeHtmlEntities': return decodeHtmlEntities;
      case 'removeCurrency': return removeCurrency;
      case 'extractNumber': return extractNumber;
      case 'normalizeNumber': return function (v) { return normalizeNumber(v, opts); };
      case 'normalizeCurrency': return function (v) { return normalizeCurrency(v, opts); };
      case 'normalizePercentage': return function (v) { return normalizePercentage(v, opts); };
      case 'normalizeDate': return function (v) { return normalizeDate(v, opts); };
      case 'normalizeBoolean': return function (v) { return normalizeBoolean(v, opts); };
      case 'changeCase': return function (v) { return changeCase(v, opts); };
      case 'capitalizeFirst': return capitalizeFirst;
      case 'prefixSuffix': return function (v) { return prefixSuffix(v, opts); };
      case 'removePrefix': return function (v) { return removePrefix(v, opts); };
      case 'removeSuffix': return function (v) { return removeSuffix(v, opts); };
      case 'fillEmpty': return function (v) { return fillEmpty(v, opts); };
      case 'findReplace': return function (v) { return findReplace(v, opts); };
      case 'regexReplace': {
        var reReplace = validateRegex(opts.pattern, opts.flags);
        return function (v) { return regexReplaceValue(v, opts, reReplace); };
      }
      case 'regexExtract': {
        var extractFlags = String(opts.flags || '');
        if (opts.all && extractFlags.indexOf('g') === -1) extractFlags += 'g';
        var reExtract = validateRegex(opts.pattern, extractFlags);
        return function (v) { return regexExtractValue(v, opts, reExtract); };
      }
      case 'normalizeUrl': return function (v) { return normalizeUrl(v, opts, context); };
      case 'removeTrackingParams': return function (v) { return removeTrackingParams(v, context); };
      case 'extractDomain': return function (v) { return extractDomain(v, opts, context); };
      case 'substring': return function (v) { return substringValue(v, opts); };
      case 'stripHtml': return stripHtml;
      default: throw new Error('Unknown transform type: "' + t.type + '".');
    }
  }

  var STRUCTURAL_TYPES = { combine: true };

  /** Applies ONE value-style result (either an ordinary value transform,
   * or split's non-'columns' output modes) either IN PLACE (default,
   * identical to every pre-V1.23 transform) or into a brand-new column
   * (V1.23 spec #19 Column Derivation) when `t.destination === 'newColumn'`
   * — the source column is left completely untouched in that case
   * (spec #20 raw-value preservation). */
  function applyValueStyle(rows, columns, t, fn) {
    if (t.destination === 'newColumn') {
      var newName = (t.newColumnName || '').trim();
      if (!newName) throw new Error('Enter a name for the new column.');
      if (columns.some(function (c) { return c.name === newName; })) throw new Error('Transform: a column named "' + newName + '" already exists.');
      var newColId = 'derived_' + t.id;
      var origIndex = columns.findIndex(function (c) { return c.id === t.column; });
      var newColumns = columns.slice(0, origIndex + 1).concat([{ id: newColId, name: newName, attribute: 'text' }], columns.slice(origIndex + 1));
      var newRows = rows.map(function (row) {
        var clone = Object.assign({}, row);
        clone[newColId] = fn(row[t.column]);
        return clone;
      });
      return { rows: newRows, columns: newColumns };
    }
    var plainRows = rows.map(function (row) {
      var clone = Object.assign({}, row);
      clone[t.column] = fn(row[t.column]);
      return clone;
    });
    return { rows: plainRows, columns: columns };
  }

  /** Applies ONE transform to a (rows, columns) pair, returning a new
   * pair. Never mutates its inputs — every row is shallow-cloned. */
  function applyOneTransform(rows, columns, t, context) {
    if (t.type === 'combine') return applyCombine(rows, columns, t);
    if (t.type === 'split' && isStructuralSplit(t)) return applySplit(rows, columns, t);

    var col = findColumn(columns, t.column);
    if (!col) throw new Error('Transform references a column that no longer exists.');
    var fn = t.type === 'split' ? buildSplitValueFn(t.options || {}) : buildValueFn(t, context);
    return applyValueStyle(rows, columns, t, fn);
  }

  /**
   * Applies the full transform pipeline in order, starting from RAW rows
   * every time (spec #24 — non-destructive: rawRows/baseColumns are never
   * mutated, only read). A step with `enabled === false` is SKIPPED
   * (kept in the list/order, but produces no effect — V1.23 spec #2's
   * "enable/disable individual transforms"; any other value, including a
   * missing field entirely, means enabled — so a transform saved before
   * V1.23 behaves exactly as it always did). A failing transform (bad
   * regex, missing column, etc.) throws with a clean message; callers
   * should catch and fall back to the untransformed dataset rather than
   * let the whole UI break.
   *
   * @param {Object[]} rawRows id-keyed rows exactly as the scraper produced them
   * @param {{id:string,name:string,attribute:string}[]} baseColumns
   * @param {Object[]} transforms ordered list of {id, type, column, options, enabled?, destination?, newColumnName?}
   * @param {{baseUrl?:string}} [context] baseUrl for relative URL resolution
   * @returns {{rows:Object[], columns:Object[]}}
   */
  function applyTransforms(rawRows, baseColumns, transforms, context) {
    var rows = (rawRows || []).map(function (r) { return Object.assign({}, r); });
    var columns = (baseColumns || []).slice();
    (transforms || []).forEach(function (t) {
      if (t.enabled === false) return;
      var result = applyOneTransform(rows, columns, t, context);
      rows = result.rows;
      columns = result.columns;
    });
    return { rows: rows, columns: columns };
  }

  /**
   * Preview-before-apply (spec #21/#22): runs ONE candidate transform
   * against a small sample of rawRows (through any transforms already
   * ahead of it in the pipeline, so the preview reflects reality) and
   * returns before/after example pairs, without touching the real
   * pipeline state.
   * @returns {{ok:true, examples:{before:string,after:string}[], resultColumns:Object[]}|{ok:false, error:string}}
   */
  function previewTransform(rawRows, baseColumns, transformsBefore, candidate, context, sampleSize) {
    sampleSize = sampleSize || 5;
    var sampleRows = (rawRows || []).slice(0, Math.max(sampleSize * 6, 30));
    var basePair;
    try {
      basePair = applyTransforms(sampleRows, baseColumns, transformsBefore, context);
    } catch (e) {
      return { ok: false, error: e.message };
    }

    var afterPair;
    try {
      afterPair = applyOneTransform(basePair.rows, basePair.columns, candidate, context);
    } catch (e) {
      return { ok: false, error: e.message };
    }

    var examples = [];
    if (candidate.type === 'split' && isStructuralSplit(candidate)) {
      var outCols = afterPair.columns.filter(function (c) { return !basePair.columns.some(function (bc) { return bc.id === c.id; }); });
      for (var i = 0; i < basePair.rows.length && examples.length < sampleSize; i++) {
        var beforeVal = basePair.rows[i][candidate.column];
        if (!beforeVal) continue;
        examples.push({ before: beforeVal, after: outCols.map(function (c) { return afterPair.rows[i][c.id]; }).join(' | ') });
      }
    } else if (candidate.type === 'combine') {
      var newCol = afterPair.columns.filter(function (c) { return !basePair.columns.some(function (bc) { return bc.id === c.id; }); })[0];
      var srcIds = (candidate.options && candidate.options.sourceColumns) || [];
      for (var j = 0; j < basePair.rows.length && examples.length < sampleSize; j++) {
        var beforeCombined = srcIds.map(function (id) { return basePair.rows[j][id] || ''; }).join(' + ');
        examples.push({ before: beforeCombined, after: newCol ? afterPair.rows[j][newCol.id] : '' });
      }
    } else {
      var afterColId = (candidate.destination === 'newColumn') ? 'derived_' + candidate.id : candidate.column;
      for (var k = 0; k < basePair.rows.length && examples.length < sampleSize; k++) {
        var b = basePair.rows[k][candidate.column];
        if (b === undefined || b === '') continue; // an empty source value rarely makes a useful example
        examples.push({ before: b, after: afterPair.rows[k][afterColId] });
      }
    }

    return { ok: true, examples: examples, resultColumns: afterPair.columns };
  }

  // ---- transform presets (spec #25) ----------------------------------------
  // Deliberately just a ready-made SEQUENCE of ordinary transform steps —
  // applying one does nothing a user couldn't already build by hand, and
  // every step it adds is immediately editable/removable/reorderable like
  // any other ("Keep them editable. Do not turn presets into locked
  // behavior."). Column-scoped: the caller fills in `column` for each step
  // against whichever column the user picked in the UI.
  var PRESETS = {
    cleanText: {
      label: 'Clean Text',
      description: 'Trim, collapse whitespace, remove invisible characters, and decode HTML entities.',
      steps: [{ type: 'trim' }, { type: 'collapseWhitespace' }, { type: 'removeInvisibleChars' }, { type: 'decodeHtmlEntities' }]
    },
    normalizePrice: {
      label: 'Normalize Price',
      description: 'Trim, then strip the currency symbol/code and reformat the number.',
      steps: [{ type: 'trim' }, { type: 'normalizeCurrency', options: { mode: 'normalizeValue' } }]
    },
    normalizeUrl: {
      label: 'Normalize URL',
      description: 'Trim and resolve to an absolute URL, removing any # fragment.',
      steps: [{ type: 'trim' }, { type: 'normalizeUrl', options: { removeFragment: true } }]
    },
    htmlToText: {
      label: 'HTML to Text',
      description: 'Strip HTML tags, decode entities, and collapse whitespace into readable plain text.',
      steps: [{ type: 'stripHtml' }, { type: 'decodeHtmlEntities' }, { type: 'collapseWhitespace' }]
    }
  };

  // ---- untrusted-input sanitization (spec #23, #27) ------------------------
  // Used to accept a transform pipeline carried inside a V1.22 Template
  // (built by hand OR imported from a JSON file — always untrusted).
  // Exactly the project's established "rebuild into a fixed-key plain
  // object, never `obj[untrustedKey] = value`" pattern (see
  // utils/templates.js's own normalizeTemplate) — nothing here is ever
  // executed; every field stays inert data (an enum string, a number, a
  // plain array of strings), and anything unrecognized is dropped rather
  // than partially trusted.

  var KNOWN_TRANSFORM_TYPES = [
    'trim', 'collapseWhitespace', 'removeLineBreaks', 'normalizeLineBreaks', 'removeTabs', 'removeInvisibleChars',
    'normalizeUnicode', 'decodeHtmlEntities', 'removeCurrency', 'extractNumber', 'normalizeNumber',
    'normalizeCurrency', 'normalizePercentage', 'normalizeDate', 'normalizeBoolean', 'changeCase',
    'capitalizeFirst', 'prefixSuffix', 'removePrefix', 'removeSuffix', 'fillEmpty', 'findReplace',
    'regexReplace', 'regexExtract', 'normalizeUrl', 'removeTrackingParams', 'extractDomain',
    'substring', 'stripHtml', 'split', 'combine'
  ];

  function sanitizeOptionsValue(v, depth) {
    if (depth > 3) return undefined;
    if (v === null) return null;
    if (typeof v === 'string') return v.slice(0, MAX_OPTION_STRING_LEN);
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    if (typeof v === 'boolean') return v;
    if (Array.isArray(v)) {
      return v.slice(0, 50).map(function (x) { return sanitizeOptionsValue(x, depth + 1); }).filter(function (x) { return x !== undefined; });
    }
    return undefined; // objects/functions/anything else inside options -> drop the key entirely (never trusted, never executed)
  }

  function sanitizeOptions(opts) {
    if (!opts || typeof opts !== 'object') return {};
    var out = {};
    Object.keys(opts).slice(0, 30).forEach(function (k) {
      if (typeof k !== 'string' || k.length > 60) return;
      var sv = sanitizeOptionsValue(opts[k], 0);
      if (sv !== undefined) out[k] = sv;
    });
    return out;
  }

  function sanitizeTransformStep(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (KNOWN_TRANSFORM_TYPES.indexOf(raw.type) === -1) return null;
    var column = (typeof raw.column === 'string' && raw.column) ? raw.column.slice(0, 100) : null;
    if (raw.type !== 'combine' && !column) return null;
    var step = {
      id: (typeof raw.id === 'string' && raw.id) ? raw.id.slice(0, 100) : makeTransformId(),
      type: raw.type,
      column: raw.type === 'combine' ? null : column,
      options: sanitizeOptions(raw.options)
    };
    if (raw.enabled === false) step.enabled = false;
    if (raw.destination === 'newColumn' && typeof raw.newColumnName === 'string' && raw.newColumnName.trim()) {
      step.destination = 'newColumn';
      step.newColumnName = raw.newColumnName.slice(0, 200);
    }
    if (Array.isArray(raw.rowIndices)) {
      step.rowIndices = raw.rowIndices.filter(function (n) { return typeof n === 'number' && isFinite(n); }).slice(0, 100000);
    }
    return step;
  }

  /** Rebuilds an ENTIRE transform list from untrusted input (an imported
   * Template's `transforms`, or any other external source) into the exact
   * plain shape applyTransforms expects — never trusts the input as-is,
   * never partially applies a malformed step (it's simply dropped), and
   * caps both the list length and every string/array inside it. */
  function sanitizeTransformList(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, MAX_TRANSFORM_STEPS).map(sanitizeTransformStep).filter(Boolean);
  }

  root.WSTransforms = {
    makeTransformId: makeTransformId,
    applyTransforms: applyTransforms,
    applyOneTransform: applyOneTransform,
    previewTransform: previewTransform,
    isStructuralSplit: isStructuralSplit,
    sanitizeTransformList: sanitizeTransformList,
    PRESETS: PRESETS,
    // individual ops, exposed for targeted unit testing
    trim: trim,
    collapseWhitespace: collapseWhitespace,
    removeLineBreaks: removeLineBreaks,
    normalizeLineBreaks: normalizeLineBreaks,
    removeTabs: removeTabs,
    removeInvisibleChars: removeInvisibleChars,
    normalizeUnicode: normalizeUnicode,
    decodeHtmlEntities: decodeHtmlEntities,
    removeCurrency: removeCurrency,
    extractNumber: extractNumber,
    normalizeNumber: normalizeNumber,
    normalizeCurrency: normalizeCurrency,
    normalizePercentage: normalizePercentage,
    normalizeDate: normalizeDate,
    normalizeBoolean: normalizeBoolean,
    findReplace: findReplace,
    regexReplaceValue: regexReplaceValue,
    changeCase: changeCase,
    capitalizeFirst: capitalizeFirst,
    prefixSuffix: prefixSuffix,
    removePrefix: removePrefix,
    removeSuffix: removeSuffix,
    fillEmpty: fillEmpty,
    normalizeUrl: normalizeUrl,
    removeTrackingParams: removeTrackingParams,
    extractDomain: extractDomain,
    regexExtractValue: regexExtractValue,
    substringValue: substringValue,
    stripHtml: stripHtml,
    fillTemplate: fillTemplate,
    TRACKING_PARAMS: TRACKING_PARAMS
  };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
