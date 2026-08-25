/**
 * xlsx.js
 * A minimal, dependency-free .xlsx (OOXML spreadsheet) writer. Runs in the
 * popup only (never injected into pages). No CDN/remote code — everything
 * needed to build the handful of XML parts Excel requires is implemented
 * here from scratch; the actual ZIP container is utils/zip.js's
 * WSZip.buildZip (an .xlsx file IS a ZIP archive) — load zip.js before
 * this file. V1.13.2 extracted that ZIP writer out into its own module so
 * the new image/research-bundle ZIP packaging could reuse it verbatim
 * instead of a second implementation; this file's own output is
 * byte-for-byte unchanged by that move.
 *
 * Cells are written as inline strings (t="inlineStr") BY DEFAULT, not
 * shared strings or typed numbers — this keeps the writer simple and,
 * more importantly, guarantees Excel never "helpfully" reinterprets a
 * scraped value (e.g. a SKU like "0501234567" turning into a number and
 * losing its leading zero, or a long numeric-looking id flipping to
 * scientific notation). Everything round-trips as exactly the text that
 * was extracted, unless opts.typeCells is explicitly turned on (V1.24,
 * see buildWorkbook's own doc comment).
 *
 * V1.24 SECURITY NOTE (spec #38, "CSV/XLSX formula injection must be
 * considered"): unlike CSV — which carries NO type information, so a
 * spreadsheet program decides purely from a cell's leading character
 * whether to treat it as a formula, making a leading-quote defensive
 * prefix necessary (see utils/csv.js) — an OOXML cell explicitly typed
 * t="inlineStr" (or the new opt-in t="n" numeric cells below) is NOT
 * reinterpreted as a formula on load; Excel/LibreOffice/Sheets trust the
 * file's own structural type metadata. Deliberately NOT applying CSV's
 * leading-quote mitigation here, then — doing so would needlessly alter
 * legitimate scraped text in a format where the underlying vulnerability
 * doesn't actually exist, contradicting this file's own "exact round-
 * trip" design goal. This is a reasoned, documented decision, not an
 * oversight — the CSV writer is where the real protection lives.
 */
(function (root) {
  'use strict';

  function utf8(str) {
    return new TextEncoder().encode(str);
  }

  function xmlEscape(str) {
    return String(str).replace(/[&<>"']/g, function (ch) {
      switch (ch) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&apos;';
      }
      return ch;
    });
  }

  // Strip control characters XML 1.0 can't legally contain (scraped pages
  // occasionally include stray U+0000-U+001F from odd markup/encoding).
  function xmlSafeText(str) {
    return String(str).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  function colLetter(index) {
    var letters = '';
    var n = index;
    do {
      letters = String.fromCharCode(65 + (n % 26)) + letters;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return letters;
  }

  // A conservative "safe to write as a real Excel number" check (V1.24
  // opt-in typed cells, spec #6 "numeric values where safely typed"):
  // requires a clean decimal with NO leading zero ahead of another digit
  // (so "0501234567" — a SKU, not the number 501234567 — is correctly
  // rejected and stays text) and a bounded digit count (avoids floating-
  // point precision loss on a very long numeric-looking string).
  var SAFE_NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;
  function isSafeNumericValue(str) {
    if (!SAFE_NUMBER_RE.test(str)) return false;
    return str.replace(/[-.]/g, '').length <= 15;
  }

  function cellXml(colIndex, rowIndex, value, opts) {
    var ref = colLetter(colIndex) + rowIndex;
    var raw = value === null || value === undefined ? '' : String(value);
    if (opts && opts.typeCells && raw !== '' && isSafeNumericValue(raw)) {
      return '<c r="' + ref + '"><v>' + raw + '</v></c>';
    }
    var safe = xmlEscape(xmlSafeText(raw));
    return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + safe + '</t></is></c>';
  }

  function buildSheetViewsXml(opts) {
    if (!opts.freezeHeader) return '';
    return '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>';
  }

  /** A simple, deterministic "widest cell wins" column-width heuristic
   * (character-count based, which is what Excel's own width unit
   * approximates anyway) — bounded so one pathological long value can't
   * blow a column out to an unusable width. */
  function buildColsXml(columns, rows, opts) {
    if (!opts.columnWidths || !columns.length) return '';
    var cols = columns.map(function (c, i) {
      var maxLen = String(c.name).length;
      rows.forEach(function (r) {
        var v = r[c.id];
        if (v !== null && v !== undefined && v !== '') {
          var len = String(v).length;
          if (len > maxLen) maxLen = len;
        }
      });
      var width = Math.min(60, Math.max(8, maxLen + 2));
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + width + '" customWidth="1"/>';
    }).join('');
    return '<cols>' + cols + '</cols>';
  }

  function buildAutoFilterXml(columns, rows, opts) {
    if (!opts.autoFilter || !columns.length) return '';
    var lastCol = colLetter(columns.length - 1);
    var lastRow = rows.length + 1; // +1 for the header row
    return '<autoFilter ref="A1:' + lastCol + lastRow + '"/>';
  }

  // Element order below follows the OOXML worksheet schema exactly
  // (sheetViews, cols, sheetData, autoFilter — anything out of this order
  // is technically invalid and some readers reject it outright).
  function buildSheetXml(columns, rows, opts) {
    opts = opts || {};
    var lines = [];
    lines.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    lines.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
    lines.push(buildSheetViewsXml(opts));
    lines.push(buildColsXml(columns, rows, opts));
    lines.push('<sheetData>');

    var headerCells = columns.map(function (c, i) { return cellXml(i, 1, c.name, null); }).join(''); // header is always plain text, never number-typed
    lines.push('<row r="1">' + headerCells + '</row>');

    rows.forEach(function (row, rIdx) {
      var rowNum = rIdx + 2;
      var cells = columns.map(function (c, cIdx) {
        return cellXml(cIdx, rowNum, row[c.id] || '', opts);
      }).join('');
      lines.push('<row r="' + rowNum + '">' + cells + '</row>');
    });

    lines.push('</sheetData>');
    lines.push(buildAutoFilterXml(columns, rows, opts));
    lines.push('</worksheet>');
    return lines.join('');
  }

  var CONTENT_TYPES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';

  var ROOT_RELS_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  var WORKBOOK_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>' +
    '</workbook>';

  var WORKBOOK_RELS_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  var STYLES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  /**
   * Builds a complete .xlsx file as a Uint8Array from an ordered list of
   * columns ({id, name}) and row objects keyed by column id.
   * @param {{freezeHeader?:boolean, autoFilter?:boolean, columnWidths?:boolean, typeCells?:boolean}} [opts]
   *   freezeHeader (default true) — spec #6's "freeze header row"
   *   autoFilter (default true) — spec #6's "basic autofilter"
   *   columnWidths (default true) — spec #6's "sensible column widths"
   *   typeCells (default FALSE — opt-in) — write a clean, safe-looking
   *     numeric value as a real Excel number (t="n") instead of text, so
   *     e.g. a V1.23-normalized Price column sorts/sums natively in
   *     Excel. Left off by default to preserve this module's original,
   *     deliberate "never reinterpret scraped text" guarantee for every
   *     caller that hasn't explicitly opted in.
   */
  function buildWorkbook(columns, rows, opts) {
    opts = Object.assign({ freezeHeader: true, autoFilter: true, columnWidths: true, typeCells: false }, opts || {});
    var sheetXml = buildSheetXml(columns, rows, opts);
    var files = [
      { name: '[Content_Types].xml', data: utf8(CONTENT_TYPES_XML) },
      { name: '_rels/.rels', data: utf8(ROOT_RELS_XML) },
      { name: 'xl/workbook.xml', data: utf8(WORKBOOK_XML) },
      { name: 'xl/_rels/workbook.xml.rels', data: utf8(WORKBOOK_RELS_XML) },
      { name: 'xl/styles.xml', data: utf8(STYLES_XML) },
      { name: 'xl/worksheets/sheet1.xml', data: utf8(sheetXml) }
    ];
    return root.WSZip.buildZip(files);
  }

  root.WSXlsx = {
    buildWorkbook: buildWorkbook,
    isSafeNumericValue: isSafeNumericValue
  };
})(typeof window !== 'undefined' ? window : globalThis);
