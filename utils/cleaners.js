/**
 * cleaners.js
 * DATA CLEANING ENGINE — an OPTIONAL, per-column TYPE (RAW/TEXT/PRICE/
 * NUMBER/URL) applied AFTER extraction, ON TOP OF the existing scraper
 * engine and the existing, separate, ADVANCED multi-step transform
 * pipeline (utils/transforms.js). These are two independent, stacked
 * layers by design (mission scope: "reuse cleanly... do not create
 * unnecessary new screens" — this is a NEW, much simpler per-column
 * property, not a redesign of the advanced Transform/Filter/Sort/Dedupe
 * system): a column's `cleanerType` is a single, always-on-by-default
 * ('raw') classification set once in the column list UI, applied to
 * every row's value for that column before anything else (Transforms,
 * Filter, Sort, Dedupe, Export) ever sees it. Extraction itself,
 * dedupe-key computation (WSRunState.buildRowKey — always keyed off the
 * RAW extracted value, never a cleaned one), and session accumulation
 * are completely untouched by this file; it operates purely as a
 * display/export-time (rows, columns) -> (rows) mapper, exactly like
 * WSTransforms does, and is invoked from popup.js's own
 * computeTransformedResult() BEFORE WSTransforms.applyTransforms runs.
 *
 * ABSOLUTE RULE (mission spec #3/#44): a cleaner NEVER fabricates a
 * replacement value. Every function here either (a) returns a genuinely
 * cleaned value it is CONFIDENT about, or (b) returns the ORIGINAL,
 * untouched value when it cannot confidently transform it — never a
 * blank, a zero, a guessed number, or an invented string. RAW performs
 * no cleaning at all, byte-for-byte (mission spec #4).
 *
 * Pure, DOM-free (the URL cleaner uses the standard `URL` global, never
 * DOMParser/eval/network), local-only, no AI, no external calls
 * (mission spec #27). Deterministic and idempotent for every type:
 * applyCleaner(type, applyCleaner(type, v)) === applyCleaner(type, v)
 * (mission spec #18/#33 — verified per-type in the focused test suite).
 * Every cleaner call is wrapped so a single malformed value can never
 * throw out of this module (mission spec #25) — the ORIGINAL value is
 * always the safe fallback.
 *
 * Reuses, rather than reimplements, this project's own already-proven
 * primitives where correct to do so:
 *  - WSResults.normalizeNumericString — the SAME US/EU decimal-vs-
 *    thousands disambiguation Filter/Sort/Transforms already rely on,
 *    for both PRICE and NUMBER.
 *  - WSTransforms.removeInvisibleChars / decodeHtmlEntities — for TEXT.
 *  - WSTransforms.removeTrackingParams — for URL (already resolves a
 *    relative URL against a base origin AND strips only the same
 *    well-known tracking-parameter allowlist; never touches an
 *    identifying parameter like ?id=).
 * None of these dependencies are hard requirements — every reuse site
 * degrades to "return the original value" if the dependency isn't
 * loaded, so this file also works standalone (e.g. in an isolated test).
 */
(function (root) {
  'use strict';

  var CLEANER_TYPES = ['raw', 'text', 'price', 'number', 'url'];

  function isBlank(v) {
    return v === null || v === undefined || String(v).trim() === '';
  }

  // ---- RAW -------------------------------------------------------------
  // Mission spec #4: NO cleaning whatsoever — not even trimming. The
  // identity function, kept as a real function (rather than special-
  // cased away) so applyCleaner's dispatch table stays uniform and
  // testable like every other type.
  function cleanRaw(v) {
    return v;
  }

  // ---- TEXT --------------------------------------------------------------
  // Mission spec #5/#6: conservative, safe normalization only. Never
  // rewrites/summarizes/translates/corrects — only whitespace/line-break
  // collapsing, safe HTML-entity/invisible-character residue cleanup
  // (reusing WSTransforms' own proven implementations), and a very
  // narrow whole-string duplicate-PHRASE collapse (spec #6: "Only remove
  // a repeated fragment if it is clearly identical... Do not incorrectly
  // alter legitimate strings such as 'Very Very Good'").
  //
  // The duplicate check only ever fires when the ENTIRE (already
  // whitespace-normalized) string decomposes as `P + single-space + P`
  // for some non-empty P spanning the WHOLE string, start to end — e.g.
  // "Sale Price Sale Price" -> "Sale Price". A three-word phrase like
  // "Very Very Good" can never satisfy this (there is no split point P
  // such that P + " " + P reconstructs "Very Very Good" exactly), so it
  // is always left untouched — verified explicitly in the focused tests.
  function cleanText(v) {
    if (isBlank(v)) return v;
    var s = String(v);
    var WT = root.WSTransforms;
    if (WT && WT.removeInvisibleChars) s = WT.removeInvisibleChars(s);
    if (WT && WT.decodeHtmlEntities) s = WT.decodeHtmlEntities(s);
    s = s.replace(/\r\n|\r|\n/g, ' ').replace(/\t/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return s;
    var dup = s.match(/^(.+?)\s+\1$/);
    if (dup) return dup[1];
    return s;
  }

  // ---- shared numeric-run helpers (PRICE + NUMBER) -----------------------

  // One greedy numeric "run": a digit, optionally followed by any mix of
  // digits/'.'/',',  ending in a digit (or a single digit alone) — the
  // same simple, proven shape utils/transforms.js's own extractNumber
  // already uses. Deliberately does NOT try to resolve US-vs-EU
  // separators itself; that disambiguation is WSResults.
  // normalizeNumericString's job (reused below), never duplicated here.
  var NUMERIC_RUN_RE = /\d[\d.,]*\d|\d/;

  /** Parses ONE numeric-run substring (already isolated from surrounding
   * text/currency) into a real JS number via WSResults'
   * normalizeNumericString — the exact same locale disambiguation
   * Filter/Sort/Transforms already trust. Used by PRICE, where staying
   * conservative matters most: that helper deliberately REFUSES a
   * single-separator-with-exactly-3-trailing-digits run ("1.234") as
   * genuinely ambiguous (could be a tiny 1.234-unit price or 1,234 units)
   * rather than guess — exactly the caution a price value deserves.
   * Returns null (never NaN, never a guess) if it doesn't resolve
   * cleanly or the dependency isn't loaded. */
  function parseNumericRun(run) {
    var WR = root.WSResults;
    if (!WR || !WR.normalizeNumericString) return null;
    var n = WR.normalizeNumericString(run);
    if (!n) return null;
    var num = parseFloat(n.str) * n.multiplier * (n.negative ? -1 : 1);
    return isNaN(num) ? null : num;
  }

  /** NUMBER's OWN separator resolver — deliberately NOT
   * WSResults.normalizeNumericString, and NOT a duplicate of it either:
   * same digit-grouping heuristic (<=2 trailing digits after the single
   * separator -> decimal, otherwise -> thousands), but WITHOUT that
   * function's PRICE-appropriate refusal on an exactly-3-trailing-digit
   * single separator. NUMBER's own domain is ratings/counts/percentages,
   * where a genuine decimal rating essentially never has 3 decimal
   * places (ratings are X.X or X.XX) while a 3-digit-grouped count is
   * extremely common — so mission spec #13's own example ("1.234 yorum"
   * -> 1234) resolves this specific case towards thousands with
   * confidence, unlike the genuinely-ambiguous general PRICE case. */
  function parseCountLikeNumber(run) {
    var s = String(run).trim();
    if (!s) return null;
    var hasComma = s.indexOf(',') !== -1;
    var hasDot = s.indexOf('.') !== -1;
    var normalized;
    if (hasComma && hasDot) {
      normalized = s.lastIndexOf(',') > s.lastIndexOf('.')
        ? s.replace(/\./g, '').replace(',', '.')
        : s.replace(/,/g, '');
    } else if (hasComma) {
      var afterComma = s.length - s.lastIndexOf(',') - 1;
      var commaCount = (s.match(/,/g) || []).length;
      normalized = (commaCount === 1 && afterComma <= 2) ? s.replace(',', '.') : s.replace(/,/g, '');
    } else if (hasDot) {
      var afterDot = s.length - s.lastIndexOf('.') - 1;
      var dotCount = (s.match(/\./g) || []).length;
      normalized = (dotCount === 1 && afterDot <= 2) ? s : s.replace(/\./g, '');
    } else {
      normalized = s;
    }
    var num = parseFloat(normalized);
    return isNaN(num) ? null : num;
  }

  // ---- NUMBER --------------------------------------------------------------
  // Mission spec #13/#14/#31: extracts a genuine numeric value from
  // number-LIKE text (a rating, a review count, a percentage) while
  // refusing to grab an arbitrary embedded number out of ordinary prose
  // (e.g. "Product 2026 Edition" must NOT become 2026).
  //
  // Confidence rule, chosen to match every example in the mission spec
  // exactly: take the FIRST numeric run found. It is only trusted if the
  // text BEFORE it (trimmed) is either completely empty (the number
  // leads the whole string — "4.8 stars", "1,234 reviews", "25%") or is
  // exactly a single opening parenthesis ("(553)"). Any other leading
  // text (real words, like "Product" before "2026") means the number is
  // just one token embedded inside free-text, not a standalone numeric
  // field, and the value is confidently left unparsed (original
  // preserved — never a guess).
  function cleanNumber(v) {
    if (isBlank(v)) return v;
    var s = String(v);
    var m = s.match(NUMERIC_RUN_RE);
    if (!m) return v; // no digits at all -> nothing to extract, preserve original
    var prefix = s.slice(0, m.index).trim();
    if (prefix !== '' && prefix !== '(') return v; // number is embedded in real text -> not confident, preserve original
    var num = parseCountLikeNumber(m[0]);
    if (num === null) return v;
    return String(num);
  }

  // ---- PRICE -------------------------------------------------------------
  // Mission spec #7-#12/#28/#29: the most safety-critical cleaner.
  // Converts messy price text into one reliable representation without
  // ever guessing, and NEVER invents a price from a non-price value
  // (review counts, percentages, bare parenthetical counts).
  //
  // Strategy: find every "price-shaped span" in the value — a numeric
  // run immediately adjacent (touching, or separated only by whitespace)
  // to a recognized currency symbol/code, in either order, OR a bare
  // numeric run with no currency at all. A bare numeric run only counts
  // as a genuine price CANDIDATE if it ends in a decimal-cents pattern
  // (one or two digits after a final '.' or ',' — e.g. "29.99"); this is
  // what correctly rejects "(56)", "(225)", "35% off", and "11 reviews"
  // (all bare integers with no currency and no decimal ending) while
  // still accepting a genuine currency-less price like "29.99" (mission
  // spec #10's own example). A span WITH a currency marker is always
  // accepted regardless of decimal shape (a whole-number price like
  // "$50" is still a real price).
  //
  // If every accepted candidate span normalizes (via
  // WSResults.normalizeNumericString) to the SAME underlying numeric
  // value, the string is a duplicated representation of one price
  // (mission spec #7's "21.938,40 TL21.938,40TL" -> one price) and the
  // FIRST candidate span's own original text is returned unchanged (its
  // real, already-correctly-formatted substring — never a resynthesized
  // string, so locale-specific separator style is always preserved
  // exactly as extracted). If candidates normalize to genuinely
  // DIFFERENT values, or none are found at all, the cleaner refuses to
  // guess and returns the untouched original value.
  var PRICE_CURRENCY_ALT = '(?:USD|EUR|GBP|TRY|TL|[$€£₺¥])';
  var PRICE_SPAN_RE = new RegExp(
    PRICE_CURRENCY_ALT + '\\s*(?:\\d[\\d.,]*\\d|\\d)' + '|' +
    '(?:\\d[\\d.,]*\\d|\\d)\\s*' + PRICE_CURRENCY_ALT + '|' +
    '(?:\\d[\\d.,]*\\d|\\d)',
    'gi'
  );
  var CURRENCY_MARKER_RE = /(?:USD|EUR|GBP|TRY|TL|[$€£₺¥])/i;
  var DECIMAL_CENTS_TAIL_RE = /[.,]\d{1,2}$/;

  function spanHasCurrency(span) {
    return CURRENCY_MARKER_RE.test(span);
  }

  function cleanPrice(v) {
    if (isBlank(v)) return v;
    var s = String(v);
    var spans = s.match(PRICE_SPAN_RE) || [];
    var candidates = spans.filter(function (span) {
      return spanHasCurrency(span) || DECIMAL_CENTS_TAIL_RE.test(span.trim());
    });
    if (!candidates.length) return v; // nothing confidently price-shaped -> preserve original, never fabricate

    var first = candidates[0].trim();
    var m0 = first.match(NUMERIC_RUN_RE);
    var firstVal = m0 ? parseNumericRun(m0[0]) : null;
    if (firstVal === null) return v;

    for (var i = 1; i < candidates.length; i++) {
      var mi = candidates[i].match(NUMERIC_RUN_RE);
      var val = mi ? parseNumericRun(mi[0]) : null;
      if (val === null) continue;
      if (Math.abs(val - firstVal) > 0.001) return v; // two DIFFERENT price values present -> ambiguous, never guess which is "the" price
    }
    return first; // single price, or a confirmed exact duplicate of it -> the real, already-correct first occurrence
  }

  // ---- URL -----------------------------------------------------------------
  // Mission spec #15/#16: trims, resolves a relative URL against the
  // page origin, and strips only the same well-known tracking-parameter
  // allowlist WSTransforms.removeTrackingParams already uses — reused
  // directly rather than reimplemented, so URL cleaning behaves
  // IDENTICALLY to the existing, already-tested "Remove Tracking
  // Params" advanced transform. Never fabricates a URL from arbitrary
  // text (removeTrackingParams's own `new URL()` call throws and falls
  // back to the original value for anything that isn't genuinely
  // URL-shaped); never strips an identifying parameter like `?id=`
  // (only the fixed TRACKING_PARAMS allowlist is ever touched).
  function cleanUrl(v, context) {
    if (isBlank(v)) return v;
    var WT = root.WSTransforms;
    if (!WT || !WT.removeTrackingParams) return String(v).trim();
    return WT.removeTrackingParams(v, context);
  }

  // ---- dispatcher ------------------------------------------------------

  /** Applies the cleaner for ONE column type to ONE value. Never throws
   * (mission spec #25) — any unexpected error safely falls back to the
   * original, untouched value. `type` defaults to 'raw' for any
   * unrecognized/missing value, matching "existing columns without a
   * cleanerType behave as RAW" (mission spec #2/#20). */
  function applyCleaner(type, value, context) {
    try {
      switch (type) {
        case 'text': return cleanText(value);
        case 'price': return cleanPrice(value);
        case 'number': return cleanNumber(value);
        case 'url': return cleanUrl(value, context);
        case 'raw':
        default: return cleanRaw(value);
      }
    } catch (e) {
      return value; // a single malformed value must never crash the session (spec #25)
    }
  }

  root.WSCleaners = {
    CLEANER_TYPES: CLEANER_TYPES,
    applyCleaner: applyCleaner,
    cleanRaw: cleanRaw,
    cleanText: cleanText,
    cleanPrice: cleanPrice,
    cleanNumber: cleanNumber,
    cleanUrl: cleanUrl
  };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
