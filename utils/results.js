/**
 * results.js
 * Pure, DOM-free transforms over already-extracted rows: numeric parsing,
 * filter, remove-duplicates, sort, and the JSON/TSV serializers used by
 * JSON export and Copy to Clipboard. Runs only in the popup — the V1.1
 * scraper engine (content/*.js) never touches this file and is completely
 * unaware "result data" is post-processed at all.
 *
 * Deliberately conservative: anywhere a value's meaning is genuinely
 * ambiguous (e.g. "1.234" — European thousands or a 3-decimal number?),
 * parseNumeric returns null rather than guessing, per spec.
 */
(function (root) {
  'use strict';

  // ---- numeric parsing ----------------------------------------------

  /**
   * Parses a scraped text value into a number, or null if it can't be
   * read unambiguously. Handles:
   *   - currency symbols: $ £ € ₺ ¥
   *   - thousands/decimal separator disambiguation (US "1,234.56" vs
   *     EU "1.234,56" vs a bare decimal comma "25,50")
   *   - "k"/"K" (thousand) and "m"/"M" (million) suffixes attached to
   *     the number, e.g. "2.2k" -> 2200
   *   - a trailing space + "b"/"B" (Turkish "Bin" = thousand), e.g.
   *     "2,2 B" -> 2200 — NOT English "billion", which is genuinely
   *     ambiguous with the Turkish convention and is therefore not
   *     supported as a bare attached suffix
   */
  /**
   * Does the locale disambiguation work of parseNumeric, but stops short
   * of parseFloat — returns the canonical decimal-separator STRING form
   * (e.g. "25,50" -> "25.50", preserving the original precision/trailing
   * zeros) plus the suffix multiplier/sign, or null if the value can't be
   * read unambiguously. Factored out so other code (V1.7's Normalize
   * Number transform) can reuse the exact same disambiguation logic
   * without re-parsing back through a float and losing that precision —
   * parseNumeric itself is just this plus a final parseFloat.
   * @returns {{str:string, multiplier:number, negative:boolean}|null}
   */
  function normalizeNumericString(raw) {
    if (raw === null || raw === undefined) return null;
    var s = String(raw).trim();
    if (!s) return null;

    var negative = /^-/.test(s) || /^\(.*\)$/.test(s);
    s = s.replace(/^[-+]/, '').replace(/^\(|\)$/g, '').trim();

    // Strip currency symbols and anything that isn't a digit, separator,
    // whitespace, or one of the supported suffix letters.
    s = s.replace(/[^\d.,\skKmM bB]/g, '').trim();
    if (!s) return null;

    var multiplier = 1;
    var spaceSuffix = s.match(/^(.*\d)\s+[bB]$/);
    if (spaceSuffix) {
      s = spaceSuffix[1];
      multiplier = 1000; // Turkish "Bin"
    } else {
      var attachedSuffix = s.match(/^(.*\d)\s*([kKmM])$/);
      if (attachedSuffix) {
        s = attachedSuffix[1];
        multiplier = /[kK]/.test(attachedSuffix[2]) ? 1000 : 1000000;
      }
    }

    s = s.trim();
    if (!/\d/.test(s)) return null;

    var hasComma = s.indexOf(',') !== -1;
    var hasDot = s.indexOf('.') !== -1;
    var normalized;

    if (hasComma && hasDot) {
      normalized = s.lastIndexOf(',') > s.lastIndexOf('.')
        ? s.replace(/\./g, '').replace(',', '.') // comma is the decimal separator
        : s.replace(/,/g, '');                    // dot is the decimal separator
    } else if (hasComma) {
      var commaCount = (s.match(/,/g) || []).length;
      var afterComma = s.length - s.lastIndexOf(',') - 1;
      normalized = (commaCount === 1 && afterComma <= 2)
        ? s.replace(',', '.')  // "25,50" / "25,5" -> decimal
        : s.replace(/,/g, ''); // "1,234" / "1,234,567" -> thousands
    } else if (hasDot) {
      var dotCount = (s.match(/\./g) || []).length;
      var afterDot = s.length - s.lastIndexOf('.') - 1;
      if (dotCount > 1) {
        normalized = s.replace(/\./g, ''); // "1.234.567" -> can only be thousands grouping
      } else if (afterDot <= 2) {
        normalized = s; // "19.99" / "4.5" -> clear decimal
      } else {
        return null; // single dot + exactly 3 digits after: genuinely ambiguous, refuse to guess
      }
    } else {
      normalized = s;
    }

    if (isNaN(parseFloat(normalized))) return null;
    return { str: normalized, multiplier: multiplier, negative: negative };
  }

  function parseNumeric(raw) {
    var n = normalizeNumericString(raw);
    if (!n) return null;
    var num = parseFloat(n.str) * n.multiplier;
    return n.negative ? -num : num;
  }

  function isNumericColumn(rows, columnId) {
    var nonEmpty = rows.filter(function (r) { return r[columnId]; });
    if (!nonEmpty.length) return false;
    var parseable = nonEmpty.filter(function (r) { return parseNumeric(r[columnId]) !== null; });
    return parseable.length / nonEmpty.length >= 0.8;
  }

  // ---- filter ----------------------------------------------------------

  var TEXT_CONDITIONS = ['contains', 'not-contains', 'equals', 'not-equals', 'empty', 'not-empty'];
  var NUMERIC_ONLY_CONDITIONS = ['gt', 'lt'];

  /**
   * @param {Object[]} rows
   * @param {{columnId:string, condition:string, value:string}} filter
   * @returns {{rows: Object[]|null, error: string|null}}
   */
  function applyFilter(rows, filter) {
    if (!filter || !filter.columnId || !filter.condition) return { rows: rows, error: null };
    var condition = filter.condition;
    var raw = filter.value || '';

    if (NUMERIC_ONLY_CONDITIONS.indexOf(condition) !== -1) {
      var target = parseNumeric(raw);
      if (target === null) {
        return { rows: null, error: 'Filter value "' + raw + '" isn’t a recognizable number.' };
      }
      var filtered = rows.filter(function (row) {
        var n = parseNumeric(row[filter.columnId]);
        if (n === null) return false;
        return condition === 'gt' ? n > target : n < target;
      });
      return { rows: filtered, error: null };
    }

    var needle = raw.toLowerCase();
    var out = rows.filter(function (row) {
      var v = row[filter.columnId] || '';
      var vLower = String(v).toLowerCase();
      switch (condition) {
        case 'contains': return vLower.indexOf(needle) !== -1;
        case 'not-contains': return vLower.indexOf(needle) === -1;
        case 'equals': return vLower === needle;
        case 'not-equals': return vLower !== needle;
        case 'empty': return !v;
        case 'not-empty': return !!v;
        default: return true;
      }
    });
    return { rows: out, error: null };
  }

  // ---- remove duplicates ------------------------------------------------

  /**
   * @param {Object[]} rows
   * @param {{id:string}[]} columns
   * @param {string} mode 'entire-row' or a specific column id
   */
  function removeDuplicates(rows, columns, mode) {
    var seen = Object.create(null);
    var kept = [];
    var removed = 0;
    rows.forEach(function (row) {
      var key = mode === 'entire-row'
        ? columns.map(function (c) { return row[c.id] || ''; }).join('␟')
        : String(row[mode] || '');
      if (Object.prototype.hasOwnProperty.call(seen, key)) {
        removed++;
      } else {
        seen[key] = true;
        kept.push(row);
      }
    });
    return { rows: kept, removedCount: removed };
  }

  // ---- sort ---------------------------------------------------------

  /**
   * @param {Object[]} rows
   * @param {string} columnId
   * @param {'asc'|'desc'} direction
   */
  function applySort(rows, columnId, direction) {
    var numeric = isNumericColumn(rows, columnId);
    var indexed = rows.map(function (row, i) { return { row: row, i: i }; });

    indexed.sort(function (a, b) {
      var av = a.row[columnId] || '';
      var bv = b.row[columnId] || '';

      if (numeric) {
        var an = parseNumeric(av);
        var bn = parseNumeric(bv);
        var aEmpty = an === null;
        var bEmpty = bn === null;
        if (aEmpty && bEmpty) return a.i - b.i;
        if (aEmpty) return 1;  // unparseable always sorts last, regardless of direction
        if (bEmpty) return -1;
        var cmp = an - bn;
        return direction === 'desc' ? -cmp : cmp;
      }

      var cmp2 = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return direction === 'desc' ? -cmp2 : cmp2;
    });

    return indexed.map(function (x) { return x.row; });
  }

  // ---- serializers -------------------------------------------------

  /** Builds the plain {ColumnName: value} object one row turns into for
   * both rowsToJSON and rowsToNDJSON — a single shared shape so the two
   * formats can never silently drift apart. */
  function rowToPlainObject(columns, row) {
    var obj = {};
    columns.forEach(function (c) { obj[c.name] = row[c.id] || ''; });
    return obj;
  }

  function rowsToJSON(columns, rows) {
    var objects = rows.map(function (row) { return rowToPlainObject(columns, row); });
    return JSON.stringify(objects, null, 2);
  }

  /** V1.24 spec #7: JSON Lines / NDJSON — one compact JSON object per
   * line, no enclosing array/brackets, no comma between records. Useful
   * for large datasets and developer/streaming workflows (a consumer can
   * process one line at a time without holding the whole file in
   * memory) — a clearly SEPARATE, explicitly-labeled export option from
   * plain JSON, never a hidden variant of it. */
  function rowsToNDJSON(columns, rows) {
    return rows.map(function (row) { return JSON.stringify(rowToPlainObject(columns, row)); }).join('\n');
  }

  function rowsToTSV(columns, rows) {
    function escapeCell(v) {
      // Tabs/newlines would break the grid structure when pasted into a
      // spreadsheet, so collapse them to a single space; nothing else
      // needs escaping in a TSV paste.
      return String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ');
    }
    var lines = [columns.map(function (c) { return escapeCell(c.name); }).join('\t')];
    rows.forEach(function (row) {
      lines.push(columns.map(function (c) { return escapeCell(row[c.id]); }).join('\t'));
    });
    return lines.join('\r\n');
  }

  root.WSResults = {
    parseNumeric: parseNumeric,
    normalizeNumericString: normalizeNumericString,
    isNumericColumn: isNumericColumn,
    applyFilter: applyFilter,
    removeDuplicates: removeDuplicates,
    applySort: applySort,
    rowsToJSON: rowsToJSON,
    rowsToNDJSON: rowsToNDJSON,
    rowsToTSV: rowsToTSV,
    rowToPlainObject: rowToPlainObject,
    TEXT_CONDITIONS: TEXT_CONDITIONS,
    NUMERIC_ONLY_CONDITIONS: NUMERIC_ONLY_CONDITIONS
  };
})(typeof window !== 'undefined' ? window : globalThis);
