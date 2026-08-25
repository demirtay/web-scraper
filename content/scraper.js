/**
 * scraper.js
 * Bridges a raw clicked DOM element to the column data model, and runs the
 * stored columns against the live page to produce table rows. Sits on top
 * of selector.js (WSSelector). Attached to window.WSScraper.
 */
(function (root) {
  'use strict';

  var Sel = root.WSSelector;
  var SD = root.WSStructuredData; // V1.21 — may be undefined in an older bundle/test harness that hasn't loaded it; every call site below guards for that

  /**
   * Given the element the user just clicked, figures out:
   *  - which repeating container it belongs to (auto-detecting one if this
   *    is the first column, or reusing the existing one otherwise)
   *  - a selector for the clicked element relative to that container
   *  - how many rows the container selector currently matches
   *  - a suggested attribute (text / href / src) based on the tag
   *
   * @param {Element} clickedEl
   * @param {string|null} existingContainerSelector
   */
  function pickElementInfo(clickedEl, existingContainerSelector) {
    var attribute = Sel.suggestAttribute(clickedEl);
    var previewText = (clickedEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);

    if (existingContainerSelector) {
      var containerInstance = Sel.closestAcrossShadow(clickedEl, existingContainerSelector);
      if (!containerInstance) {
        return {
          ok: false,
          reason: 'outside-container',
          previewText: previewText
        };
      }
      var relSelector = Sel.buildRelativeSelector(containerInstance, clickedEl);
      if (!relSelector) {
        return { ok: false, reason: 'unresolvable', previewText: previewText };
      }
      return {
        ok: true,
        containerSelector: existingContainerSelector,
        relativeSelector: relSelector,
        matchCount: Sel.countMatches(existingContainerSelector),
        attribute: attribute,
        previewText: previewText
      };
    }

    var detected = Sel.findRepeatingContainer(clickedEl);
    if (detected.container) {
      // Pass the actual matched sibling elements through so the
      // container selector is built from classes common to ALL of them
      // (see buildContainerSelector's siblingEls param) — not just this
      // one clicked instance's own classes, which can include per-item
      // classes (order/badge/A-B-test flags) that collapse the selector
      // down to a handful of matches instead of the full repeated set.
      var containerSelector = Sel.buildContainerSelector(detected.container, undefined, detected.siblings);
      var relative = Sel.buildRelativeSelector(detected.container, clickedEl);
      if (!relative) {
        return { ok: false, reason: 'unresolvable', previewText: previewText };
      }
      return {
        ok: true,
        containerSelector: containerSelector,
        relativeSelector: relative,
        matchCount: Sel.countMatches(containerSelector),
        attribute: attribute,
        previewText: previewText
      };
    }

    // No repeating pattern found — treat the whole page as a single record.
    return {
      ok: true,
      containerSelector: null,
      relativeSelector: Sel.buildSelectorForElement(clickedEl),
      matchCount: 1,
      attribute: attribute,
      previewText: previewText
    };
  }

  /**
   * Runs the stored container/column selectors against the live DOM and
   * returns extracted rows plus a total row count.
   * @param {{containerSelector: string|null, columns: Array}} state
   */
  /** V1.21 — computes the page-level structured-data snapshot at most
   * ONCE per extraction call (never per row/column), and only if the
   * scraper actually has at least one structured column configured —
   * a scraper with none pays zero cost for this. Guarded against SD
   * being unavailable (older bundle/test harness) so a structured
   * column simply resolves empty rather than throwing. */
  function maybeGetStructuredSnapshot(columns) {
    if (!SD) return null;
    var hasStructuredColumn = columns.some(function (c) { return c.attribute === 'structured'; });
    if (!hasStructuredColumn) return null;
    try { return SD.getSnapshot(); } catch (e) { return null; }
  }

  /** V1.21 — page-level, not per-row: the SAME resolved value is applied
   * to every row a list-page extraction produces, since JSON-LD/meta
   * describes the PAGE (or its single primary entity), not each
   * individual repeating item. This is honest, documented behavior
   * (spec: never fabricate a distinct per-row value that isn't really
   * there) — the natural, distinct-per-row case is Deep Scraping's
   * runDetailExtraction below, where each call IS one page. */
  function extractStructuredValue(col, snapshot) {
    if (!SD || !snapshot || !col.structuredPath) return '';
    try { return SD.getValueAtPath(snapshot, col.structuredPath) || ''; } catch (e) { return ''; }
  }

  /**
   * PRICE FIELD FALLBACK (real regression, hardened after v1.30.9 leaked
   * into unrelated columns): established ONCE per extraction pass, not
   * per row — for each 'text' column, checks the FIRST card where its
   * stored relativeSelector actually resolves to a value that genuinely
   * LOOKS LIKE A PRICE (Sel.looksLikePriceText — has a digit, a currency
   * symbol/code, and is not a bare parenthesized count like a review
   * total) and records whether THAT resolution was struck-through. This
   * is what lets findWithinCardTextFallback tell a "current price"
   * column from an "old/original price" column later, purely from how
   * its own reference value actually looks on the page — never from
   * column name/id, so it works for any language/naming (fiyat/price/
   * preis/...).
   *
   * A column whose reference is NOT price-shaped (a shop/seller name, a
   * title, a review count, a badge — ANY value with no currency context)
   * gets `null` here — and, critically, a `null` role means the fallback
   * in runExtraction below is NEVER attempted for that column, on ANY
   * row, no matter what that row's raw value looks like. This is what
   * v1.30.9 got wrong: it triggered the fallback for ANY 'text' column
   * whose CURRENT row happened to lack a digit (true for a shop name on
   * every single row), which let it wander into review counts/badges/
   * price text on the Seller column. Only a column whose OWN reference
   * value already proved it's a genuine price field is ever eligible.
   */
  function classifyPriceColumnRoles(columns, containers) {
    var roles = {};
    columns.forEach(function (col) {
      roles[col.id] = null;
      if (col.attribute !== 'text' || typeof col.relativeSelector !== 'string' || col.relativeSelector === ':scope') return;
      for (var i = 0; i < containers.length; i++) {
        var el = Sel.queryFromScope(containers[i], col.relativeSelector);
        if (!el) continue;
        var text = (el.textContent || '').trim();
        if (!text) continue; // keep looking only past genuinely EMPTY resolutions
        // The FIRST container where this column resolves to ANY non-
        // empty text is the reference — decide role from THAT ONE,
        // whether or not it looks price-like, and stop scanning either
        // way. A real regression: the old code kept hunting PAST a
        // non-price first reference for a LATER row that happened to
        // look price-like — which let a contaminated Title row (its
        // relativeSelector landing on a wider ancestor that also wraps
        // price text on some card) falsely calibrate Title as a price
        // column, since its own genuinely clean first reference doesn't
        // look like a price and got skipped rather than settling the
        // question.
        if (!Sel.looksLikePriceElement(el)) return; // settles as null — not a price column
        roles[col.id] = Sel.isStruckThrough(el, containers[i]);
        return;
      }
    });
    return roles;
  }

  /**
   * TITLE FIELD CONTAMINATION FIX (real regression): established ONCE
   * per extraction pass, same architecture as classifyPriceColumnRoles
   * above but for the opposite direction — for each 'text' column that
   * is NOT already a price column, checks the FIRST card where the
   * stored relativeSelector resolves to a NON-EMPTY value and records
   * whether that reference value is "clean" (Sel.containsContaminationFragment
   * returns false — no embedded price/count fragment anywhere in it).
   *
   * A column whose own reference proves clean (true) is expected to stay
   * clean on every row — a title, seller name, or any other plain-text
   * field never legitimately contains a price or review-count fragment.
   * If some OTHER row's resolution for that same column DOES contain
   * one, that resolution has clearly landed on a wider ancestor than the
   * one the user actually selected (varying card markup made the same
   * relativeSelector match a bigger wrapper on that card) — runExtraction
   * below blanks it rather than keeping the polluted text or searching
   * for something else (spec: "leave Title blank rather than taking a
   * broader parent/container" — no neighboring-text fallback for this).
   *
   * A column whose reference was itself already contaminated (false),
   * or that never resolved to anything, gets `null` and is left
   * completely alone — this fix only ever REJECTS a row that regressed
   * from an established clean baseline, it never guesses at a column
   * with no such baseline. Also records the reference element's own
   * tagName (e.g. "H3") — runExtraction uses it to try narrowing INTO an
   * over-broad match before falling back to blank (see
   * Sel.narrowToStructuralMatch).
   */
  function classifyCleanTextColumns(columns, containers, priceColumnRoles) {
    var info = {};
    columns.forEach(function (col) {
      info[col.id] = null;
      if (col.attribute !== 'text' || typeof col.relativeSelector !== 'string' || col.relativeSelector === ':scope') return;
      if (priceColumnRoles[col.id] !== null) return; // already a price column — handled entirely by its own role logic
      for (var i = 0; i < containers.length; i++) {
        var el = Sel.queryFromScope(containers[i], col.relativeSelector);
        if (!el) continue;
        var text = (el.textContent || '').trim();
        if (!text) continue;
        info[col.id] = { clean: !Sel.containsContaminationFragment(text), tagName: el.tagName };
        return;
      }
    });
    return info;
  }

  function runExtraction(state) {
    var columns = state && state.columns ? state.columns : [];
    if (!columns.length) return { rows: [], totalCount: 0 };

    var containers;
    if (state.containerSelector) {
      try {
        containers = Array.prototype.slice.call(document.querySelectorAll(state.containerSelector));
      } catch (e) {
        containers = [];
      }
    } else {
      containers = [document.body];
    }

    var structuredSnapshot = maybeGetStructuredSnapshot(columns);
    var priceColumnRoles = classifyPriceColumnRoles(columns, containers);
    var cleanTextColumns = classifyCleanTextColumns(columns, containers, priceColumnRoles);

    var rows = containers.map(function (containerEl, containerIndex) {
      var row = {};
      columns.forEach(function (col) {
        if (col.attribute === 'structured') {
          row[col.id] = extractStructuredValue(col, structuredSnapshot);
          return;
        }
        // V1.22 (Templates spec #2's "Search Results: Position" field) —
        // a computed 1-based row number, never resolved from the DOM or
        // structured data at all. Deliberately excluded from the "did
        // any column produce a value" liveness check below (it's always
        // truthy by construction, so it must never be allowed to make an
        // otherwise-empty, non-matching container look like real data).
        if (col.attribute === 'position') {
          row[col.id] = String(containerIndex + 1);
          return;
        }
        // relativeSelector is either a plain CSS selector string (the
        // common case) or an array of hops that cross into one or more
        // open shadow roots (see selector.js) — queryFromScope resolves
        // either form, plus the ':scope' self-reference sentinel.
        var el = col.relativeSelector === ':scope' ? containerEl : Sel.queryFromScope(containerEl, col.relativeSelector);
        var value = Sel.extractValue(el, col.attribute, containerEl, col.attributeName);
        // PRICE FIELD FALLBACK (real regression, hardened after v1.30.9
        // leaked into Seller/Title/review counts): gated ENTIRELY on
        // `role !== null` — i.e., this SPECIFIC column's own reference
        // value already proved, once, that it's a genuine price field
        // (see classifyPriceColumnRoles above). A column with no such
        // role (Seller, Title, review count, anything non-price) NEVER
        // enters this block, on any row, regardless of what that row's
        // value looks like — v1.30.9's bug was triggering on "this row's
        // value has no digit," which is true of every legitimate shop
        // name too. Within a genuine price column, fires in two cases:
        //  1. the value doesn't genuinely look like a price at all
        //     (empty, currency-symbol-only "TL", or any other non-price
        //     text) — the reported "TL only"/missing-price symptom.
        //  2. the value DOES look like a price, but disagrees with this
        //     column's role: an "old/original price" column (role ===
        //     true) whose resolved element ISN'T struck-through has, on
        //     THIS card, actually grabbed the current price by accident
        //     (a non-discounted card has no genuine original price at
        //     that position) — must not be silently kept, since "eski
        //     fiyat" must stay blank rather than duplicate "fiyat".
        //     Symmetrically, a "current price" column (role === false)
        //     whose resolved element IS struck-through has grabbed the
        //     original price by accident and must be corrected.
        var role = col.attribute === 'text' ? priceColumnRoles[col.id] : null;
        if (role !== null) {
          // Prefer the element-aware check (also consults the immediate
          // parent for a sibling currency symbol/code — see
          // looksLikePriceElement) when the primary selector actually
          // resolved to something; falls back to a plain text check only
          // when it didn't resolve at all (nothing to inspect the parent
          // of).
          var looksPrice = el ? Sel.looksLikePriceElement(el) : Sel.looksLikePriceText(value);
          var roleMismatch = looksPrice && !!el &&
            ((role === true && !Sel.isStruckThrough(el, containerEl)) ||
             (role === false && Sel.isStruckThrough(el, containerEl)));
          if (!looksPrice || roleMismatch) {
            var fallback = '';
            // REAL REGRESSION (v1.30.10): a real non-discounted card's
            // current-price selector can resolve to a CURRENCY-ONLY
            // element ("TL") whose price NUMBER is a sibling that does
            // NOT share its class at all (so the same-class search below
            // can't see it). Tried FIRST, only for the current-price role
            // and only when the value has no digit whatsoever — never
            // for the old-price role, which must stay blank rather than
            // reconstruct a fabricated value when nothing struck-through
            // exists. Strictly scoped to the resolved element's own
            // immediate parent (see findSiblingNumericPrice) — never the
            // whole card.
            if (role === false && el && !/\d/.test(value || '')) {
              fallback = Sel.findSiblingNumericPrice(el, containerEl);
            }
            var coreSelector = fallback ? null : Sel.lastSelectorSegment(col.relativeSelector);
            if (!fallback && coreSelector) fallback = Sel.findWithinCardTextFallback(containerEl, coreSelector, role === true);
            // A role mismatch means the CURRENT value is known-wrong for
            // this column — always replace it (with the fallback, or
            // with '' when no genuine candidate exists), never keep it.
            // A "doesn't look like a price at all" case only replaces
            // when the fallback actually found something better.
            if (roleMismatch || fallback) value = fallback;
          }
        }
        // TITLE FIELD CONTAMINATION FIX (real regression): a column
        // proven "clean" by its own reference (see
        // classifyCleanTextColumns above) must never contain a price/
        // review-count fragment on ANY row — if this row's resolution
        // does, the relativeSelector has landed on a wider ANCESTOR than
        // the one actually selected (real: "3,498.08 TL Robin Botanical
        // Bird Fabric Shower Curtain", "(8,245) Star Seller Fairycore
        // Aesthetic..."). Tries narrowing STRICTLY INSIDE that over-broad
        // match for the one descendant sharing the reference's own tag/
        // leaf shape (never a sideways/neighboring search — see
        // Sel.narrowToStructuralMatch); only accepted if narrowing
        // itself yields clean text. Otherwise blanked outright — "leave
        // Title blank rather than taking a broader parent/container."
        // Never runs for a column with no established clean baseline
        // (cleanTextColumns[col.id] === null) — this can only ever
        // reject/narrow a regression from a proven-clean reference,
        // never guess at an unclassified column.
        var textInfo = col.attribute === 'text' ? cleanTextColumns[col.id] : null;
        if (textInfo && textInfo.clean && Sel.containsContaminationFragment(value)) {
          var narrowed = el ? Sel.narrowToStructuralMatch(el, textInfo.tagName) : null;
          var narrowedText = narrowed ? Sel.extractValue(narrowed, col.attribute, containerEl, col.attributeName) : '';
          value = (narrowed && !Sel.containsContaminationFragment(narrowedText)) ? narrowedText : '';
        }
        row[col.id] = value;
      });
      return row;
    });

    // Drop containers where none of the columns produced a value — usually
    // means the container matched something unrelated to the scraped data.
    // (A 'position' column is always truthy by construction and is
    // therefore excluded from this liveness check — see above.)
    var nonPositionColumns = columns.filter(function (col) { return col.attribute !== 'position'; });
    if (nonPositionColumns.length) {
      rows = rows.filter(function (row) {
        return nonPositionColumns.some(function (col) { return row[col.id]; });
      });
    }
    // else: every column is 'position' (an unusual, edge-case scraper) —
    // there is nothing else to check liveness against, so every detected
    // container is kept rather than discarding all of them.

    flagAnomalies(columns, rows);

    return { rows: rows, totalCount: rows.length };
  }

  /**
   * Simple, rule-based anomaly flagging (no ML/AI): marks rows that look
   * structurally different from the majority of extracted rows, without
   * ever removing them — the user decides what to do with flagged rows.
   * Mutates each row in place, adding a non-enumerable-looking `_wsAnomaly`
   * key (a short reason string, or null) that export code ignores because
   * it only ever reads columns by their known column ids.
   *
   * Rules (all simple thresholds, intentionally not "smart"):
   *  - a column that's populated in most rows (>=70%) but empty here
   *  - a value far shorter than the typical value for that column
   */
  function flagAnomalies(columns, rows) {
    if (rows.length < 3 || !columns.length) {
      rows.forEach(function (r) { r._wsAnomaly = null; });
      return rows;
    }

    var popRate = {};
    var medianLen = {};
    columns.forEach(function (c) {
      var nonEmpty = rows.filter(function (r) { return r[c.id]; });
      popRate[c.id] = nonEmpty.length / rows.length;
      var lens = nonEmpty.map(function (r) { return String(r[c.id]).length; }).sort(function (a, b) { return a - b; });
      medianLen[c.id] = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
    });

    rows.forEach(function (row) {
      var reasons = [];
      columns.forEach(function (c) {
        var val = row[c.id];
        if (!val) {
          if (popRate[c.id] >= 0.7) reasons.push(c.name + ' missing');
          return;
        }
        var len = String(val).length;
        if (medianLen[c.id] >= 8 && len < medianLen[c.id] * 0.15) {
          reasons.push(c.name + ' unusually short');
        }
      });
      row._wsAnomaly = reasons.length ? reasons.join(', ') : null;
    });

    return rows;
  }

  /**
   * V1.18 — Deep Scraping: extracts ONE record's worth of fields from the
   * CURRENT page treated as a single detail page (no repeating container
   * concept — same "whole page is one record" semantics
   * pickElementInfo/runExtraction already use when containerSelector is
   * null), with one addition runExtraction's list-row path doesn't need:
   * `field.multiple === 'all'` extracts EVERY matching element's value as
   * a real array (spec #17/#18 — "First"/"All" strategies for a selector
   * that can match more than one element, e.g. `.features li` or a
   * gallery's `.thumb img`), instead of just the first match.
   *
   * Deliberately kept SEPARATE from runExtraction rather than adding
   * `multiple` support there — list-page columns always stay single-
   * string-valued (zero risk to the existing CSV/Excel/JSON export code
   * for ordinary columns); the array-value concept is scoped ONLY to
   * detail-page fields, which the deep-scrape merge step (background.js/
   * popup.js) is the one place that needs to understand it.
   *
   * Still built entirely out of the SAME WSSelector primitives
   * (queryFromScope/extractValue) — no separate selector engine.
   */
  function runDetailExtraction(fields) {
    var row = {};
    // V1.21: computed once for the whole detail page, not per field —
    // this is the naturally distinct-per-page case structured columns
    // fit best (spec #8 Deep Scraping compatibility): each detail page
    // Deep Scraping visits typically HAS its own JSON-LD Product entity,
    // so the SAME saved field (e.g. "Product.offers.price") resolves to
    // a genuinely different, correct value on every page.
    var structuredSnapshot = maybeGetStructuredSnapshot(fields || []);
    (fields || []).forEach(function (col) {
      if (col.attribute === 'structured') {
        row[col.id] = extractStructuredValue(col, structuredSnapshot);
        return;
      }
      // V1.22: 'position' has no real meaning for a single detail page
      // (there is no "row N of M" concept here) — resolves to '1' rather
      // than being silently undefined; a template field this doesn't
      // suit is expected to simply not be used in a Deep Scrape context.
      if (col.attribute === 'position') {
        row[col.id] = '1';
        return;
      }
      if (col.multiple === 'all') {
        var matches;
        try {
          matches = col.relativeSelector === ':scope' ? [document.body] : document.body.querySelectorAll(col.relativeSelector);
        } catch (e) {
          matches = [];
        }
        var values = [];
        Array.prototype.forEach.call(matches, function (el) {
          var v = Sel.extractValue(el, col.attribute, document.body, col.attributeName);
          if (v) values.push(v);
        });
        row[col.id] = values;
      } else {
        var el = col.relativeSelector === ':scope' ? document.body : Sel.queryFromScope(document.body, col.relativeSelector);
        row[col.id] = Sel.extractValue(el, col.attribute, document.body, col.attributeName);
      }
    });
    return row;
  }

  root.WSScraper = {
    pickElementInfo: pickElementInfo,
    runExtraction: runExtraction,
    runDetailExtraction: runDetailExtraction
  };
})(window);
