/**
 * csv.test.js (FAST level)
 * Pure-logic coverage for utils/csv.js — RFC 4180 field escaping,
 * delimiter support (comma/semicolon/tab), and CSV formula-injection
 * sanitization (OWASP mitigation, on by default). Loaded and executed
 * for real, unmodified. Standalone-runnable: `node tests/unit/csv.test.js`.
 *
 * NOTE: this project has no CSV *parser* in utils/ (only a serializer) —
 * genuine export parse-back validation (write a real CSV, read it back,
 * confirm row/column fidelity) belongs at the SITE level against a real
 * downloaded file, not here; this file only covers the serializer itself.
 */
'use strict';
const { loadModules } = require('../lib/load-modules');
const { makeSuite } = require('../lib/assert');

function run() {
  const suite = makeSuite('csv');
  const assert = suite.assert;

  const sandbox = loadModules(['utils/csv.js']);
  const C = sandbox.WSCsv;

  // ---- escapeField: RFC 4180 quoting rules ----
  assert(C.escapeField('plain') === 'plain', 'escapeField leaves a plain value unquoted');
  assert(C.escapeField('a,b') === '"a,b"', 'escapeField quotes a value containing the active delimiter');
  assert(C.escapeField('a"b') === '"a""b"', 'escapeField quotes and doubles an internal quote');
  assert(C.escapeField('line1\nline2') === '"line1\nline2"', 'escapeField quotes a value containing a newline');
  assert(C.escapeField(null) === '', 'escapeField renders null as an empty field');
  assert(C.escapeField(undefined) === '', 'escapeField renders undefined as an empty field');
  assert(C.escapeField(42) === '42', 'escapeField stringifies a number');
  assert(C.escapeField('a;b', { delimiter: ';' }) === '"a;b"', 'escapeField quotes on the ACTIVE delimiter (semicolon), not just comma');
  assert(C.escapeField('a,b', { delimiter: ';' }) === 'a,b', 'escapeField with a semicolon delimiter does NOT quote a comma (comma is not the active delimiter)');

  // ---- CSV formula-injection sanitization (default ON) ----
  assert(C.sanitizeFormulaValue('=SUM(A1:A2)') === "'=SUM(A1:A2)", 'sanitizeFormulaValue prefixes a leading = with a force-text quote');
  assert(C.sanitizeFormulaValue('+1234') === "'+1234", 'sanitizeFormulaValue prefixes a leading +');
  assert(C.sanitizeFormulaValue('-1234') === "'-1234", 'sanitizeFormulaValue prefixes a leading -');
  assert(C.sanitizeFormulaValue('@mention') === "'@mention", 'sanitizeFormulaValue prefixes a leading @');
  assert(C.sanitizeFormulaValue('normal text') === 'normal text', 'sanitizeFormulaValue leaves ordinary text untouched');
  assert(C.sanitizeFormulaValue('Product - Blue') === 'Product - Blue', 'sanitizeFormulaValue never touches a hyphen that is NOT the first character');
  assert(C.escapeField('=SUM(A1,A2)') === '"\'=SUM(A1,A2)"', 'escapeField applies formula sanitization BEFORE quoting when the value also needs quoting (comma forces quoting)');
  assert(C.escapeField('=SUM(1)', { sanitizeFormulas: false }) === '=SUM(1)', 'escapeField honors sanitizeFormulas:false for a caller that has made its own informed choice');

  // ---- rowsToCSV: full document assembly ----
  var columns = [{ id: 'title', name: 'Title' }, { id: 'price', name: 'Price' }];
  var rows = [
    { title: 'Widget, Blue', price: '$9.99' },
    { title: 'Gadget "Pro"', price: '$19.99' }
  ];
  var csv = C.rowsToCSV(columns, rows);
  var lines = csv.split('\r\n');
  assert(lines.length === 3, 'rowsToCSV emits one header line + one line per row');
  assert(lines[0] === 'Title,Price', 'rowsToCSV header line lists column NAMES in column order');
  assert(lines[1] === '"Widget, Blue",$9.99', 'rowsToCSV correctly quotes a comma-containing field in a real row');
  assert(lines[2] === '"Gadget ""Pro""",$19.99', 'rowsToCSV correctly escapes an internal quote in a real row');
  assert(csv.indexOf('\r\n') !== -1, 'rowsToCSV uses CRLF line endings per RFC 4180 (Excel compatibility)');

  var tsvColumns = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  var tsv = C.rowsToCSV(tsvColumns, [{ a: '1', b: '2' }], { delimiter: '\t' });
  assert(tsv.split('\r\n')[0] === 'A\tB', 'rowsToCSV honors a tab delimiter end-to-end');

  var emptyCsv = C.rowsToCSV(columns, []);
  assert(emptyCsv === 'Title,Price', 'rowsToCSV with zero rows still emits a valid header-only document');

  return suite.summarize();
}

if (require.main === module) {
  var result = run();
  process.exit(result.failures ? 1 : 0);
}

module.exports = { run: run };
