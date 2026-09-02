/**
 * load-autodetect.js
 * ROW/CONTAINER OVER-COUNTING FIX mission — loads the REAL, unmodified
 * content/selector.js + content/autodetect.js + content/scraper.js
 * together into one `vm` sandbox backed by tests/lib/mini-dom.js, so
 * Auto Detect's real candidate-discovery/scoring/selector-building
 * pipeline (and the real extraction pipeline that consumes its output)
 * can be exercised against realistic fixture markup — no reimplementation
 * of any of their logic.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createMiniDocument } = require('./mini-dom');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FILES = ['content/selector.js', 'content/autodetect.js', 'content/scraper.js'];

function loadAutoDetect() {
  var dom = createMiniDocument();
  dom.document.baseURI = 'https://shop.example.com/s?k=desk+lamp';
  var sandbox = {
    console: console, URL: URL, URLSearchParams: URLSearchParams,
    document: dom.document,
    location: { href: 'https://shop.example.com/s?k=desk+lamp', hostname: 'shop.example.com', pathname: '/s', search: '?k=desk+lamp' },
    NodeFilter: { SHOW_ELEMENT: 1 },
    getComputedStyle: function (el) { return { display: (el && el._display) || 'block', visibility: (el && el._visibility) || 'visible' }; },
    chrome: { runtime: { onMessage: { addListener: function () {} } } },
    window: null
  };
  sandbox.window = sandbox;
  sandbox.window.getComputedStyle = sandbox.getComputedStyle;
  vm.createContext(sandbox);
  FILES.forEach(function (rel) {
    var full = path.join(REPO_ROOT, rel);
    var code = fs.readFileSync(full, 'utf8');
    vm.runInContext(code, sandbox, { filename: full });
  });
  return { WSAutoDetect: sandbox.WSAutoDetect, WSSelector: sandbox.WSSelector, WSScraper: sandbox.WSScraper, dom: dom };
}

module.exports = { loadAutoDetect: loadAutoDetect };
