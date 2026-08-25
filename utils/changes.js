/**
 * changes.js
 * V1.6 Change Detection — pure, DOM/chrome-API-free comparison logic
 * between two already-extracted datasets (a "previous" snapshot and the
 * "current" scrape). Mirrors results.js's separation of concerns: this
 * file only ever transforms plain row/column data in memory; it never
 * touches chrome.storage (see snapshots.js for persistence) and never
 * touches the scraper engine (content/*.js) at all.
 *
 * Rows here are always NAME-keyed ({ "Product Name": "...", "Price": "..." })
 * rather than the id-keyed shape the live scraper produces
 * ({ col_172..._ab: "..." }) — see toNamedRows(). This is deliberate:
 * column ids are regenerated per pick/Auto Detect run and can legitimately
 * differ between the run that captured a snapshot and a later run of the
 * "same" Saved Scraper (e.g. after a column was re-added), while the
 * user-visible column NAME is what actually stays meaningful across runs.
 * Snapshots are persisted name-keyed for exactly this reason.
 */
(function (root) {
  'use strict';

  var ROW_KEY_SEPARATOR = '␟'; // matches results.js's removeDuplicates separator

  // ---- basic value normalization (spec #19) ------------------------------

  /**
   * Minimal, conservative normalization to cut down on false-positive
   * "changed" results: trims whitespace and normalizes CRLF/CR to LF.
   * Deliberately does NOT lowercase, strip punctuation, or otherwise
   * transform the data — case sensitivity is preserved per field.
   */
  function normalizeComparisonValue(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/\r\n?/g, '\n').trim();
  }

  /**
   * Link fields get one extra normalization step (spec #20): the URL
   * fragment never changes which resource is linked, so two URLs
   * differing only by #fragment are treated as identical. Reuses
   * WSDownloads' dedup normalizer when available (same rule, one
   * implementation); falls back to an equivalent local strip so this
   * module still works standalone/in isolated tests.
   */
  function normalizeUrlFragment(url) {
    if (!url) return url;
    var reuse = root.WSDownloads && root.WSDownloads.normalizeUrlForDedup;
    if (typeof reuse === 'function') {
      try { return reuse(url); } catch (e) { /* fall through to local logic */ }
    }
    try {
      var u = new (root.URL || URL)(url);
      u.hash = '';
      return u.href;
    } catch (e) {
      return String(url).split('#')[0];
    }
  }

  /**
   * Image (src) fields default to EXACT comparison (spec #21) — CDN query
   * strings often encode real resolution/version info, so no normalization
   * is applied unless the caller explicitly opts into 'ignore-query' (not
   * wired to any UI in V1.6; kept available for future use without
   * enlarging this version's scope).
   */
  function normalizeImageUrl(url, mode) {
    if (mode !== 'ignore-query' || !url) return url;
    try {
      var u = new (root.URL || URL)(url);
      u.search = '';
      u.hash = '';
      return u.href;
    } catch (e) {
      return url;
    }
  }

  function compareValueForColumn(col, raw, options) {
    var v = normalizeComparisonValue(raw);
    if (!col) return v;
    if (col.attribute === 'href') return normalizeUrlFragment(v);
    if (col.attribute === 'src') return normalizeImageUrl(v, options && options.imageComparisonMode);
    return v;
  }

  // ---- row shape conversion ------------------------------------------------

  /** Converts live (id-keyed) rows into the name-keyed shape snapshots and
   * comparisons use — same idea as results.js's rowsToJSON. */
  function toNamedRows(columns, rows) {
    return (rows || []).map(function (row) {
      var obj = {};
      columns.forEach(function (c) { obj[c.name] = row[c.id] || ''; });
      return obj;
    });
  }

  // ---- row key / duplicate detection (spec #3, #17) ------------------------

  /**
   * @param {Object} row name-keyed row
   * @param {{name:string,attribute:string}[]} columns
   * @param {string} keyMode 'entire-row' or a column name
   */
  function buildRowKey(row, columns, keyMode) {
    if (!keyMode || keyMode === 'entire-row') {
      return columns.map(function (c) { return compareValueForColumn(c, row[c.name]); }).join(ROW_KEY_SEPARATOR);
    }
    var col = columns.filter(function (c) { return c.name === keyMode; })[0] || { name: keyMode, attribute: 'text' };
    return compareValueForColumn(col, row[keyMode]);
  }

  /** Counts rows beyond the first occurrence of each key value — i.e. "how
   * many duplicate values", not "how many rows are involved". Used to
   * generate the "N duplicate <key> values found" warning; comparison
   * itself always stays deterministic (last-row-wins per key, see
   * compareDatasets) rather than silently guessing a "best" match. */
  function countDuplicateKeys(rows, columns, keyMode) {
    var seen = Object.create(null);
    var dupCount = 0;
    rows.forEach(function (row) {
      var key = buildRowKey(row, columns, keyMode);
      if (seen[key]) dupCount++;
      else seen[key] = true;
    });
    return dupCount;
  }

  // ---- price detection (spec #7, #8) ---------------------------------------

  var PRICE_NAME_RE = /\b(price|cost|fiyat|fiyatı|tutar|amount)\b/i;
  var CURRENCY_HINT_RE = /[$€£₺¥₹]|\b(usd|eur|try|gbp|jpy|inr)\b/i;

  /** A column is treated as "price-like" if its name suggests it, or a
   * majority of its sampled values carry a currency symbol/code. Reuses
   * WSResults.parseNumeric (the existing filter/sort numeric parser) for
   * everything else — no new number-parsing logic is introduced here. */
  function isPriceLikeColumn(col, sampleValues) {
    if (col && PRICE_NAME_RE.test(col.name || '')) return true;
    var nonEmpty = (sampleValues || []).filter(Boolean);
    if (!nonEmpty.length) return false;
    var hits = nonEmpty.filter(function (v) { return CURRENCY_HINT_RE.test(String(v)); }).length;
    return hits / nonEmpty.length >= 0.5;
  }

  function parseNumericSafe(raw) {
    var fn = root.WSResults && root.WSResults.parseNumeric;
    return typeof fn === 'function' ? fn(raw) : null;
  }

  /**
   * Returns price-change details only when BOTH sides parse to an
   * unambiguous number and the numeric value actually differs (a value
   * that only changed cosmetically, e.g. "$20.00" -> "$20", is still
   * reported as a generic field change by detectFieldChanges, just not
   * categorized as a price move). Returns null otherwise.
   */
  function calculatePriceChange(oldRaw, newRaw) {
    var oldNum = parseNumericSafe(oldRaw);
    var newNum = parseNumericSafe(newRaw);
    if (oldNum === null || newNum === null) return null;
    var delta = newNum - oldNum;
    if (delta === 0) return null;
    var percent = oldNum !== 0 ? (delta / Math.abs(oldNum)) * 100 : null;
    return {
      isPriceChange: true,
      oldNumeric: oldNum,
      newNumeric: newNum,
      delta: delta,
      percent: percent,
      direction: delta < 0 ? 'decreased' : 'increased'
    };
  }

  // ---- field-level diff (spec #6, #18) -------------------------------------

  /**
   * @param {Object} previousRow name-keyed
   * @param {Object} currentRow name-keyed
   * @param {{name:string,attribute:string}[]} columns
   * @param {Object} [priceColumnNames] map of column name -> true
   * @returns {Object[]} one entry per column whose value actually changed
   *   (empty <-> populated counts as changed, per spec #18)
   */
  function detectFieldChanges(previousRow, currentRow, columns, priceColumnNames) {
    var changes = [];
    columns.forEach(function (col) {
      var oldRaw = previousRow[col.name] !== undefined ? previousRow[col.name] : '';
      var newRaw = currentRow[col.name] !== undefined ? currentRow[col.name] : '';
      var oldCmp = compareValueForColumn(col, oldRaw);
      var newCmp = compareValueForColumn(col, newRaw);
      if (oldCmp === newCmp) return;

      var change = { columnName: col.name, attribute: col.attribute, oldValue: oldRaw, newValue: newRaw };
      if (priceColumnNames && priceColumnNames[col.name]) {
        var priceInfo = calculatePriceChange(oldRaw, newRaw);
        if (priceInfo) Object.assign(change, priceInfo);
      }
      changes.push(change);
    });
    return changes;
  }

  // ---- full dataset comparison (spec #4, #5, #28) --------------------------

  /**
   * O(n) comparison via key->row maps (never nested-loop O(n²)).
   *
   * @param {Object[]} previousRows name-keyed
   * @param {Object[]} currentRows name-keyed
   * @param {{name:string,attribute:string}[]} columns
   * @param {{keyMode?:string}} options keyMode: 'entire-row' (default) or a column name
   */
  function compareDatasets(previousRows, currentRows, columns, options) {
    options = options || {};
    var keyMode = options.keyMode || 'entire-row';
    previousRows = previousRows || [];
    currentRows = currentRows || [];

    var priceColumnNames = {};
    columns.forEach(function (col) {
      var samples = previousRows.slice(0, 50).concat(currentRows.slice(0, 50)).map(function (r) { return r[col.name]; });
      if (isPriceLikeColumn(col, samples)) priceColumnNames[col.name] = true;
    });

    var previousDuplicateCount = countDuplicateKeys(previousRows, columns, keyMode);
    var currentDuplicateCount = countDuplicateKeys(currentRows, columns, keyMode);
    var duplicateKeyWarning = (previousDuplicateCount > 0 || currentDuplicateCount > 0)
      ? {
        keyMode: keyMode,
        previousDuplicateCount: previousDuplicateCount,
        currentDuplicateCount: currentDuplicateCount,
        message: 'Duplicate "' + (keyMode === 'entire-row' ? 'Entire Row' : keyMode) + '" values found (' +
          previousDuplicateCount + ' in previous, ' + currentDuplicateCount + ' in current). ' +
          'Comparison may be ambiguous — matching uses the last row seen per key, deterministically, ' +
          'but rows sharing a key can’t be told apart.'
      }
      : null;

    // Map building is O(n): on a duplicate key, the LAST row with that key
    // wins — deterministic (never random/best-guess), and always
    // accompanied by duplicateKeyWarning above so it's never a silent
    // mismatch.
    var previousMap = Object.create(null);
    previousRows.forEach(function (row) { previousMap[buildRowKey(row, columns, keyMode)] = row; });
    var currentMap = Object.create(null);
    currentRows.forEach(function (row) { currentMap[buildRowKey(row, columns, keyMode)] = row; });

    var unchanged = [], changed = [], newRows = [], removedRows = [];

    currentRows.forEach(function (row) {
      var key = buildRowKey(row, columns, keyMode);
      if (!(key in previousMap)) { newRows.push(row); return; }
      var previousRow = previousMap[key];
      var fieldChanges = detectFieldChanges(previousRow, row, columns, priceColumnNames);
      if (fieldChanges.length) {
        changed.push({ key: key, previousRow: previousRow, currentRow: row, fieldChanges: fieldChanges });
      } else {
        unchanged.push(row);
      }
    });

    previousRows.forEach(function (row) {
      var key = buildRowKey(row, columns, keyMode);
      if (!(key in currentMap)) removedRows.push(row);
    });

    var priceDecreased = 0, priceIncreased = 0;
    changed.forEach(function (c) {
      c.fieldChanges.forEach(function (fc) {
        if (!fc.isPriceChange) return;
        if (fc.direction === 'decreased') priceDecreased++;
        else if (fc.direction === 'increased') priceIncreased++;
      });
    });

    return {
      keyMode: keyMode,
      unchanged: unchanged,
      new: newRows,
      removed: removedRows,
      changed: changed,
      priceColumnNames: priceColumnNames,
      duplicateKeyWarning: duplicateKeyWarning,
      stats: {
        previousCount: previousRows.length,
        currentCount: currentRows.length,
        unchangedCount: unchanged.length,
        newCount: newRows.length,
        removedCount: removedRows.length,
        changedCount: changed.length,
        priceDecreased: priceDecreased,
        priceIncreased: priceIncreased
      }
    };
  }

  // ---- change export (spec #22, #23) ---------------------------------------

  /** Export schema: one row per CHANGE (a new row, a removed row, or one
   * changed field — so a row with 3 changed fields becomes 3 export rows,
   * each clearly attributable), which stays readable in a spreadsheet
   * regardless of how many columns the scraper has. `linkColumnName`, if
   * given, adds a Product Link-style column for quick reference. */
  function changesToExportRows(comparisonResult, linkColumnName) {
    var rows = [];
    function linkOf(row) { return linkColumnName && row ? (row[linkColumnName] || '') : ''; }

    comparisonResult.new.forEach(function (row) {
      rows.push({ 'Change Type': 'NEW', 'Field': '', 'Old Value': '', 'New Value': '', 'Link': linkOf(row), _row: row });
    });
    comparisonResult.removed.forEach(function (row) {
      rows.push({ 'Change Type': 'REMOVED', 'Field': '', 'Old Value': '', 'New Value': '', 'Link': linkOf(row), _row: row });
    });
    comparisonResult.changed.forEach(function (c) {
      c.fieldChanges.forEach(function (fc) {
        var type = fc.isPriceChange ? (fc.direction === 'decreased' ? 'PRICE DROPPED' : 'PRICE INCREASED') : 'CHANGED';
        rows.push({
          'Change Type': type, 'Field': fc.columnName,
          'Old Value': fc.oldValue, 'New Value': fc.newValue,
          'Link': linkOf(c.currentRow), _row: c.currentRow
        });
      });
    });
    return rows;
  }

  /** Price-only export schema (spec #23), used when the Price Changes
   * filter is active at export time. */
  function priceChangesToExportRows(comparisonResult, nameColumnName, linkColumnName) {
    var rows = [];
    comparisonResult.changed.forEach(function (c) {
      c.fieldChanges.forEach(function (fc) {
        if (!fc.isPriceChange) return;
        rows.push({
          'Product': nameColumnName ? (c.currentRow[nameColumnName] || '') : '',
          'Old Price': fc.oldValue,
          'New Price': fc.newValue,
          'Difference': fc.delta,
          'Percent': fc.percent === null ? '' : (Math.round(fc.percent * 100) / 100) + '%',
          'Link': linkColumnName ? (c.currentRow[linkColumnName] || '') : ''
        });
      });
    });
    return rows;
  }

  root.WSChanges = {
    normalizeComparisonValue: normalizeComparisonValue,
    normalizeUrlFragment: normalizeUrlFragment,
    normalizeImageUrl: normalizeImageUrl,
    toNamedRows: toNamedRows,
    buildRowKey: buildRowKey,
    countDuplicateKeys: countDuplicateKeys,
    isPriceLikeColumn: isPriceLikeColumn,
    calculatePriceChange: calculatePriceChange,
    detectFieldChanges: detectFieldChanges,
    compareDatasets: compareDatasets,
    changesToExportRows: changesToExportRows,
    priceChangesToExportRows: priceChangesToExportRows
  };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
