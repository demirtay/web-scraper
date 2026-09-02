/**
 * mini-dom.js
 * AMAZON PAGINATION FIX mission — a small, deliberately-scoped fake DOM
 * for testing content/nextdetect.js's real, unmodified findNextControl()
 * logic against realistic fixture markup, without pulling in a full DOM
 * engine. `jsdom` is present in this environment's node_modules, but
 * verified (via package-lock.json — it appears in no package's own
 * `dependencies`) to be a stray, UNTRACKED local artifact, not part of
 * the actual resolved dependency tree — relying on it would silently
 * break on any clean `npm install`/CI run. This file implements exactly
 * the CSS-selector vocabulary content/nextdetect.js's own source
 * actually issues (fixed string literals, never arbitrary/user-supplied
 * — enumerated in this file's own test usage), nothing more:
 *   - simple selectors: tag, .class, [attr], [attr="value"], [attr*="value"],
 *     the case-insensitive " i" flag, tag.class combos.
 *   - comma-separated groups (`a[href], button`).
 *   - a single space (descendant combinator) — only ever 2 parts deep in
 *     this codebase (`head link[rel="next"][href]`).
 *   - closest()/querySelectorAll()/querySelector(), each exactly as real
 *     DOM defines them for this bounded grammar.
 */
'use strict';

function MiniElement(tagName) {
  this.tagName = String(tagName || 'div').toUpperCase();
  // Real DOM: every Element has nodeType === 1 (Node.ELEMENT_NODE) — a
  // real gap found this mission: content/selector.js's
  // findRepeatingContainer() checks `parentNode.nodeType === 1` before
  // continuing its ancestor climb (the correct, real-browser-safe way to
  // distinguish an Element parent from a Document/ShadowRoot parent,
  // both of which expose `.children` too but must be climbed out of
  // differently). Without this, the climb always broke after exactly one
  // step in every mini-dom-backed test.
  this.nodeType = 1;
  this._attrs = Object.create(null);
  this.children = [];
  this.parentNode = null;
  this.disabled = false;
  this._text = '';
  this._listeners = Object.create(null);
  this.dispatchedTypes = [];
}
MiniElement.prototype.getAttribute = function (name) {
  return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
};
MiniElement.prototype.setAttribute = function (name, value) { this._attrs[name] = String(value); };
MiniElement.prototype.hasAttribute = function (name) { return Object.prototype.hasOwnProperty.call(this._attrs, name); };
MiniElement.prototype.removeAttribute = function (name) { delete this._attrs[name]; };
Object.defineProperty(MiniElement.prototype, 'className', {
  get: function () { return this.getAttribute('class') || ''; },
  set: function (v) { this.setAttribute('class', v); }
});
Object.defineProperty(MiniElement.prototype, 'classList', {
  // Real DOM: Element.classList is a DOMTokenList, which has a real
  // .contains(token) method (content/selector.js's own
  // commonStableClasses() calls it) alongside array-like .indexOf()
  // access this file's own selector matching already relied on — a
  // plain JS array supports both once .contains is attached directly to
  // it (real gap found this mission: without it, commonStableClasses()
  // — reachable in production every time buildContainerSelector() is
  // called with its siblingEls argument, which autodetect.js was
  // ALSO separately found this same mission to have never been passing
  // — silently threw here for the first time this session, since no
  // earlier test had ever actually exercised this exact call path).
  get: function () {
    var arr = (this.className || '').split(/\s+/).filter(Boolean);
    arr.contains = function (token) { return arr.indexOf(token) !== -1; };
    return arr;
  }
});
Object.defineProperty(MiniElement.prototype, 'textContent', {
  get: function () {
    if (this.children.length) return this.children.map(function (c) { return c.textContent || ''; }).join('');
    return this._text;
  },
  set: function (v) { this._text = v; this.children = []; }
});
MiniElement.prototype.appendChild = function (child) { child.parentNode = this; this.children.push(child); return child; };
Object.defineProperty(MiniElement.prototype, 'parentElement', {
  get: function () { return (this.parentNode && this.parentNode.nodeType !== 9) ? this.parentNode : null; }
});
// Real <img>/<a> elements auto-resolve their `src`/`href` ATTRIBUTE into
// an absolute-URL PROPERTY of the same name — content/selector.js's own
// resolveSingleImageUrl()/hrefFromAnchor() prefer that live property over
// getAttribute(). Mirrored here as a simple passthrough (test fixtures
// always use already-absolute image URLs; a relative href still resolves
// correctly via those functions' own getAttribute()-based fallback path).
Object.defineProperty(MiniElement.prototype, 'src', {
  get: function () { return this.getAttribute('src') || ''; }
});
MiniElement.prototype.dispatchEvent = function (evt) {
  this.dispatchedTypes.push(evt && evt.type);
  ((this._listeners[evt && evt.type]) || []).forEach(function (fn) { fn(evt); });
  return true;
};
MiniElement.prototype.addEventListener = function (type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); };
MiniElement.prototype.closest = function (selectorGroup) {
  var branches = splitTopLevelCommas(selectorGroup).map(function (b) { return parseSimple(b.trim()); });
  var cursor = this;
  while (cursor) {
    for (var i = 0; i < branches.length; i++) { if (matchesSimple(cursor, branches[i])) return cursor; }
    cursor = cursor.parentNode;
  }
  return null;
};
MiniElement.prototype.querySelectorAll = function (selectorGroup) { return selectAll(this, selectorGroup); };
MiniElement.prototype.querySelector = function (selectorGroup) { return selectAll(this, selectorGroup)[0] || null; };
MiniElement.prototype.matches = function (selectorGroup) {
  var self = this;
  return splitTopLevelCommas(selectorGroup).some(function (b) { return matchesSimple(self, parseSimple(b.trim())); });
};

// ---- bounded selector grammar ----
function splitTopLevelCommas(sel) { return sel.split(','); }

function parseSimple(sel) {
  sel = sel.trim();
  var tagMatch = sel.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  var tag = tagMatch ? tagMatch[0].toUpperCase() : null;
  var rest = tag ? sel.slice(tagMatch[0].length) : sel;
  // #id — DETAIL ENRICHMENT VERIFICATION mission: background.js's real,
  // unmodified DEEP_SCRAPE_CHALLENGE_SELECTORS array includes a literal
  // `#px-captcha` entry — needed so a test can drive that REAL selector
  // list (not a reimplementation of it) against a fake DOM.
  var id = null;
  var idMatch = rest.match(/^#[a-zA-Z0-9_-]+/);
  if (idMatch) { id = idMatch[0].slice(1); rest = rest.slice(idMatch[0].length); }
  // MULTIPLE chained class selectors (".a.b.c") — a real, common CSS
  // compound selector shape content/selector.js's own localSegment()/
  // buildContainerSelector() genuinely produce (a stable-class-based
  // selector lists EVERY stable class, not just one). Loops the same
  // way attrRe already does below, instead of the single classMatch this
  // used to stop at — REAL AMAZON EVIDENCE mission: a real production
  // selector like "div.a-section.a-spacing-none.price-row" silently lost
  // every class after the first under the old single-match version,
  // making two structurally-different elements (different SECOND/THIRD
  // classes) look identical to this fake DOM's own selector matching.
  var classes = [];
  var classRe = /^\.[a-zA-Z0-9_-]+/;
  var classMatch;
  while ((classMatch = rest.match(classRe))) {
    classes.push(classMatch[0].slice(1));
    rest = rest.slice(classMatch[0].length);
  }
  var attrs = [];
  // The case-insensitive " i" flag (when present) sits INSIDE the
  // brackets, immediately before the closing `]` — e.g. `[class*="x" i]`
  // — matching real CSS attribute-selector syntax exactly.
  var attrRe = /\[([a-zA-Z-]+)(?:([*^$]?=)"([^"]*)")?(\s+i)?\]/g;
  var m;
  while ((m = attrRe.exec(rest))) {
    attrs.push({ name: m[1], op: m[2] || null, value: m[3] != null ? m[3] : null, ci: !!m[4] });
  }
  return { tag: tag, id: id, classes: classes, attrs: attrs };
}

function matchesSimple(el, parsed) {
  if (!el || el.nodeType === 9) return false; // never matches the document root itself
  if (parsed.tag && el.tagName !== parsed.tag) return false;
  if (parsed.id && el.getAttribute('id') !== parsed.id) return false;
  for (var c = 0; c < parsed.classes.length; c++) {
    if (el.classList.indexOf(parsed.classes[c]) === -1) return false;
  }
  for (var i = 0; i < parsed.attrs.length; i++) {
    var a = parsed.attrs[i];
    if (!el.hasAttribute(a.name)) return false;
    if (a.op) {
      var v = el.getAttribute(a.name) || '';
      var target = a.value || '';
      if (a.ci) { v = v.toLowerCase(); target = target.toLowerCase(); }
      if (a.op === '*=' && v.indexOf(target) === -1) return false;
      if (a.op === '=' && v !== target) return false;
    }
  }
  return true;
}

function collectAllDescendants(root, out) {
  out = out || [];
  for (var i = 0; i < root.children.length; i++) {
    out.push(root.children[i]);
    collectAllDescendants(root.children[i], out);
  }
  return out;
}

function hasMatchingAncestor(el, parsed) {
  var cursor = el.parentNode;
  while (cursor) {
    if (matchesSimple(cursor, parsed)) return true;
    cursor = cursor.parentNode;
  }
  return false;
}

/** Splits a single selector branch into its descendant-combinator chain
 * (whitespace-separated simple selectors) — but ONLY on whitespace
 * OUTSIDE `[...]` brackets, since a bracket's own case-insensitive flag
 * syntax (`[attr*="value" i]`) contains a real space that is NOT a
 * combinator. */
function splitDescendantChain(str) {
  var parts = [];
  var current = '';
  var depth = 0;
  for (var i = 0; i < str.length; i++) {
    var c = str[i];
    if (c === '[') depth++;
    if (c === ']') depth--;
    if (/\s/.test(c) && depth === 0) {
      if (current) { parts.push(current); current = ''; }
    } else {
      current += c;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function selectAll(root, selectorGroup) {
  var branches = splitTopLevelCommas(selectorGroup);
  var allEls = collectAllDescendants(root);
  var seen = [];
  var results = [];
  branches.forEach(function (branch) {
    var parts = splitDescendantChain(branch.trim()).map(parseSimple);
    allEls.forEach(function (el) {
      if (!matchesSimple(el, parts[parts.length - 1])) return;
      for (var i = parts.length - 2; i >= 0; i--) {
        if (!hasMatchingAncestor(el, parts[i])) return;
      }
      if (seen.indexOf(el) === -1) { seen.push(el); results.push(el); }
    });
  });
  return results;
}

/** A pre-order-DFS TreeWalker (SHOW_ELEMENT only — the sole filter value
 * content/autodetect.js's own real code ever passes), matching real
 * TreeWalker semantics closely enough for that file's own usage:
 * `currentNode` starts at `root` itself; each `.nextNode()` call moves to
 * the next element in document order and returns it (`null` once
 * exhausted). */
function createTreeWalker(root) {
  var flat = [root].concat(collectAllDescendants(root));
  var idx = 0;
  return {
    nextNode: function () {
      idx++;
      if (idx >= flat.length) return null;
      return flat[idx];
    }
  };
}

/** Builds a fresh { document, head, body } triple, plus a `el(tag, attrs,
 * text)` convenience builder that also auto-appends into `body` unless
 * `opts.detached` is passed. */
function createMiniDocument() {
  var html = new MiniElement('html');
  var head = new MiniElement('head');
  var body = new MiniElement('body');
  html.appendChild(head);
  html.appendChild(body);
  var doc = {
    nodeType: 9,
    documentElement: html, head: head, body: body,
    readyState: 'complete',
    querySelectorAll: function (sel) { return selectAll(html, sel); },
    querySelector: function (sel) { return selectAll(html, sel)[0] || null; },
    createTreeWalker: function (root) { return createTreeWalker(root); }
  };
  return { document: doc, head: head, body: body, html: html };
}

function el(tag, attrs, text) {
  var e = new MiniElement(tag);
  attrs = attrs || {};
  Object.keys(attrs).forEach(function (k) {
    if (k === 'disabled') { e.disabled = !!attrs[k]; return; }
    e.setAttribute(k, attrs[k]);
  });
  if (text != null) e.textContent = text;
  return e;
}

module.exports = { MiniElement: MiniElement, createMiniDocument: createMiniDocument, el: el };
