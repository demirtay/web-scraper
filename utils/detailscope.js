/**
 * detailscope.js
 * DETAIL ENRICHMENT — pure, chrome-API-free scope/URL-list logic for the
 * new VERİ/SONUÇ/DETAY flow's own detail-page processing step. Mirrors
 * this project's established convention (utils/downloads.js,
 * utils/discovery.js): plain functions over plain serializable
 * data, no DOM, no chrome.* calls, loaded only by the popup (see
 * popup.html) — so it's directly unit-testable with a small local
 * assert() helper, no mocks needed.
 *
 * Mission's own explicit requirement: "Do not assume that a
 * 1,283-record dataset should automatically cause 1,283 detail-page
 * visits. The user decides." — selectScopedRows() below is the ONE
 * place that decision is made, always from an explicit, validated
 * scope the user chose, never a default that silently processes
 * everything.
 */
(function (root) {
  'use strict';

  var SCOPE_MODES = ['all', 'first', 'selected'];

  /**
   * Validates a requested scope against how many rows actually exist to
   * scope over. Never fails catastrophically on bad input (mirrors
   * WSDiscoveryCore.validateSelection's own "0/-5/2.5/'abc'/oversized N"
   * contract exactly, reused here for the exact same reason: a scope
   * chooser is the same shape of user input) — returns a clear,
   * structured `{ok:false, error}` for genuinely invalid input, and
   * safely clamps an over-large N down to what's actually available
   * rather than fabricating rows past that.
   * @param {{mode:'all'|'first'|'selected', n?:number, selectedKeys?:string[]}} scope
   * @param {number} totalRows
   */
  function validateScope(scope, totalRows) {
    totalRows = Number(totalRows) || 0;
    if (!scope || SCOPE_MODES.indexOf(scope.mode) === -1) {
      return { ok: false, error: 'invalid-mode' };
    }
    if (scope.mode === 'all') {
      return { ok: true, mode: 'all', requested: totalRows, effective: totalRows, normalized: false };
    }
    if (scope.mode === 'selected') {
      var keys = Array.isArray(scope.selectedKeys) ? scope.selectedKeys : [];
      if (!keys.length) return { ok: false, error: 'nothing-selected' };
      return { ok: true, mode: 'selected', requested: keys.length, effective: keys.length, normalized: false };
    }
    // mode === 'first'
    if (totalRows <= 0) return { ok: false, error: 'no-rows' };
    var n = scope.n;
    var isPlainInteger = typeof n === 'number' && isFinite(n) && Math.floor(n) === n;
    if (!isPlainInteger) return { ok: false, error: 'not-an-integer', requested: n };
    if (n < 1) return { ok: false, error: 'must-be-at-least-one', requested: n };
    var effective = Math.min(n, totalRows);
    return { ok: true, mode: 'first', requested: n, effective: effective, normalized: effective !== n };
  }

  /**
   * Pure slice/filter — never mutates `rows`. `keyFn(row)` derives the
   * SAME stable identity token the caller used to build `selectedKeys`
   * (never a raw array index — mission: "The selection must use stable
   * record identity... Do NOT merge by array position", which applies
   * to SELECTION every bit as much as to the later merge-back step, so
   * this function is deliberately incapable of taking a plain index
   * list at all).
   * @param {object[]} rows
   * @param {{mode:'all'|'first'|'selected', n?:number, selectedKeys?:string[]}} scope
   * @param {function(object):string} keyFn
   */
  function selectScopedRows(rows, scope, keyFn) {
    rows = rows || [];
    if (!scope) return [];
    if (scope.mode === 'all') return rows.slice();
    if (scope.mode === 'first') {
      var n = Math.max(0, Math.min(Number(scope.n) || 0, rows.length));
      return rows.slice(0, n);
    }
    if (scope.mode === 'selected') {
      var wanted = Object.create(null);
      (scope.selectedKeys || []).forEach(function (k) { wanted[k] = true; });
      return rows.filter(function (row) { return !!wanted[keyFn(row)]; });
    }
    return [];
  }

  /**
   * Dedupes + validates detail-page URLs from a chosen source column,
   * reusing WSDownloads.validateDownloadUrl verbatim (same http(s)-only,
   * no-data-url contract Bulk Download already enforces — a detail page
   * must be a real navigable destination). Row alignment is irrelevant
   * by design: each surviving URL keeps no positional link back to a
   * row at all — the caller re-associates results by URL VALUE later
   * (mission: never by array position).
   * @param {object[]} rows
   * @param {string} sourceColumnId
   * @param {function(string):{ok:boolean,scheme?:string}} validateFn — WSDownloads.validateDownloadUrl
   */
  function buildDetailUrlList(rows, sourceColumnId, validateFn) {
    var seen = Object.create(null);
    var urls = [];
    var totalRows = 0, missingUrl = 0, invalidUrl = 0;
    (rows || []).forEach(function (row) {
      totalRows++;
      var raw = sourceColumnId ? row[sourceColumnId] : null;
      if (!raw) { missingUrl++; return; }
      var validation = validateFn(raw);
      if (!validation.ok || validation.scheme === 'data') { invalidUrl++; return; }
      if (!seen[raw]) { seen[raw] = true; urls.push(raw); }
    });
    return { urls: urls, totalRows: totalRows, missingUrl: missingUrl, invalidUrl: invalidUrl };
  }

  root.WSDetailScope = {
    SCOPE_MODES: SCOPE_MODES,
    validateScope: validateScope,
    selectScopedRows: selectScopedRows,
    buildDetailUrlList: buildDetailUrlList
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
