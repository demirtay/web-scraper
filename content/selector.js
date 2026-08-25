/**
 * selector.js
 * Core selector-generation and data-extraction algorithms. Runs inside the
 * page's content script context. Everything is attached to window.WSSelector
 * so content.js can call into it without a bundler/module system.
 *
 * Selector priority (closest match to the spec):
 *   1. a unique, meaningful #id
 *   2. stable class combinations
 *   3. safe data-* attributes
 *   4. semantic attributes (itemprop, role, type, name, rel...)
 *   5. parent + child composition
 *   6. DOM path fallback (nth-child chain)
 *
 * Generated/dynamic-looking class and id names (e.g. "css-1a2b3c",
 * "x7f81aa") are filtered out wherever possible so selectors keep working
 * across re-renders.
 *
 * SHADOW DOM: modern sites (e.g. Reddit's shreddit-* web components) build
 * each repeating item as a custom element with an *open* shadow root, so
 * the actual title/score/author text lives inside encapsulated DOM that
 * plain parentElement/querySelector traversal can't see or reach. Every
 * traversal helper below therefore has a shadow-aware variant that crosses
 * OUT of an open shadow root via `shadowRoot.host` while climbing, and
 * relative selectors that need to cross back INTO a shadow root to reach
 * their target are represented as an array of per-tree hops instead of a
 * single string (see buildRelativeSelector / queryFromScope). Closed
 * shadow roots are never pierced — traversal simply stops there, same as
 * hitting any other opaque boundary.
 */
(function (root) {
  'use strict';

  // Attribute names we trust to hold a stable, *semantic* value that is
  // typically repeated identically across every instance of a repeating
  // card (e.g. data-testid="listing-title" on every listing). Attributes
  // that usually carry a per-record identifier (id, data-id, data-key...)
  // are deliberately excluded — using their value would only match the
  // one record it was captured from.
  var SAFE_VALUE_ATTRS = [
    'data-testid', 'data-test', 'data-qa', 'data-cy', 'data-component',
    'data-field', 'data-role', 'itemprop', 'role', 'rel', 'type', 'name'
  ];

  // Attribute-name fragments that usually mean "this holds a per-instance
  // identifier" — never trusted for selector matching.
  var UNSTABLE_NAME_HINTS = /id|key|index|uuid|guid|sku|token|hash/i;

  // Marker used inside a relative-selector array to mean "no query needed
  // here — the current scope element IS this hop's result, just enter its
  // shadowRoot for the next hop." Produced when the container passed into
  // buildRelativeSelector is itself the shadow host of the field being
  // picked (see the ':host' handling below).
  var HOST_MARKER = ':host';

  function cssEscape(str) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(str);
    }
    return String(str).replace(/([^\w-])/g, '\\$1');
  }

  function escapeAttrValue(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function isLikelyDynamicClass(cls) {
    if (!cls || cls.length < 2) return true;
    if (/^(css|sc|jsx|styled|emotion|chakra|MuiBox|ng-)/i.test(cls)) return true;
    if (/--[a-z0-9]{5,}$/i.test(cls)) return true; // e.g. Button--f3a1b2
    if (/^[a-z]{1,3}-[0-9a-f]{5,}$/i.test(cls)) return true; // e.g. a-1f2e3d4
    if (/^[a-zA-Z0-9_-]{6,}$/.test(cls)) {
      var digitCount = (cls.match(/[0-9]/g) || []).length;
      if (digitCount / cls.length > 0.25) return true;
    }
    if (/^[a-f0-9]{6,}$/i.test(cls)) return true; // pure hex-looking hash
    // V1 AUTO DETECTION IMPROVEMENT — a flat (no hyphen/underscore/digit),
    // all-lowercase-letter class of 5+ characters with NO vowels at all
    // (a/e/i/o/u/y) is very unlikely to be a real, human-chosen word or
    // BEM/utility class name (English class names — "grid"/"card"/"nav"/
    // "wrap"/"list"/"item"/"price"/"title" and virtually every other
    // short real word — always contain at least one). It IS the shape a
    // per-instance CSS-module/component-library class often takes when
    // it isn't caught by the hex/digit-ratio checks above (e.g. a base36
    // fragment that happens to draw only letters). Deliberately narrow
    // (flat tokens only — a hyphenated/camelCase compound is already
    // reasonably safe on its own) to minimize false positives against
    // legitimate short class names.
    if (/^[a-z]{5,}$/.test(cls) && !/[aeiouy]/.test(cls)) return true;
    return false;
  }

  function isLikelyDynamicId(id) {
    if (!id) return true;
    if (/^(ember|react|radix|mui|vue|headlessui|:r)/i.test(id)) return true;
    if (/^:.*:$/.test(id)) return true; // React useId style ":r3f:"
    var digitCount = (id.match(/[0-9]/g) || []).length;
    if (id.length >= 8 && digitCount / id.length > 0.4) return true;
    return false;
  }

  function getStableClasses(el) {
    if (!el.classList || !el.classList.length) return [];
    return Array.prototype.filter.call(el.classList, function (c) {
      return !isLikelyDynamicClass(c);
    });
  }

  function countMatches(selector, scope) {
    try {
      return (scope || document).querySelectorAll(selector).length;
    } catch (e) {
      return 0;
    }
  }

  /**
   * REAL REGRESSION FIX: real repeated cards routinely carry a handful of
   * PER-ITEM utility classes alongside their shared structural ones —
   * responsive "order" classes used to reorder a CSS grid (a real Etsy
   * case: wt-order-xs-0/md-0/lg-0, a different number on every card),
   * sale/favorited/bestseller badges, A/B-test flags. None of these are
   * "dynamic-looking" (isLikelyDynamicClass correctly leaves them alone —
   * they're real, readable, human-chosen class names, just per-instance
   * ones), so requiring an EXACT stable-class-list match between two
   * cards fails the moment their order/badge classes differ, even though
   * they're structurally the exact same kind of card. Two elements now
   * count as the same repeating shape when they share the same tag AND a
   * clear MAJORITY of their stable classes overlap, rather than requiring
   * every single class to match — tolerant of a few varying per-item
   * classes while still requiring genuine structural similarity (an
   * unrelated same-tag element elsewhere with a mostly-different class
   * list still correctly fails to match).
   */
  function sameSignature(a, b) {
    if (a.tagName !== b.tagName) return false;
    var ca = getStableClasses(a);
    var cb = getStableClasses(b);
    if (!ca.length && !cb.length) return true; // both class-less — same as before
    if (!ca.length || !cb.length) return false; // one has classes, the other doesn't -> different structural role
    var common = ca.filter(function (c) { return cb.indexOf(c) !== -1; });
    var minLen = Math.min(ca.length, cb.length);
    return (common.length / minLen) >= 0.5;
  }

  function isShadowRoot(node) {
    return !!(node && node.nodeType === 11 && node.host);
  }

  /**
   * Builds the best local ("this element only, relative to its immediate
   * parent") selector fragment for one element.
   */
  function localSegment(el) {
    var tag = el.tagName.toLowerCase();
    var stableClasses = getStableClasses(el);
    if (stableClasses.length) {
      return tag + stableClasses.map(function (c) { return '.' + cssEscape(c); }).join('');
    }

    for (var i = 0; i < SAFE_VALUE_ATTRS.length; i++) {
      var attrName = SAFE_VALUE_ATTRS[i];
      if (UNSTABLE_NAME_HINTS.test(attrName)) continue;
      if (el.hasAttribute(attrName)) {
        var val = el.getAttribute(attrName);
        if (val && val.length > 0 && val.length < 60) {
          return tag + '[' + attrName + '="' + escapeAttrValue(val) + '"]';
        }
      }
    }

    var parentEl = el.parentElement;
    if (parentEl) {
      var sameTagSiblings = Array.prototype.filter.call(parentEl.children, function (c) {
        return c.tagName === el.tagName;
      });
      if (sameTagSiblings.length > 1) {
        var idx = sameTagSiblings.indexOf(el) + 1;
        return tag + ':nth-of-type(' + idx + ')';
      }
    }
    return tag;
  }

  /**
   * nth-child DOM path from `scopeNode` down to `targetEl`, both required
   * to live in the same tree (no shadow crossing inside this function —
   * callers split the work into per-tree hops before calling it). Uses
   * parentNode (not parentElement) throughout so scopeNode may be either
   * an Element or a ShadowRoot.
   */
  function buildNthChildPath(scopeNode, targetEl) {
    var parts = [];
    var node = targetEl;
    var guard = 0;
    while (node && node !== scopeNode && guard < 30) {
      var parentNode = node.parentNode;
      var idx = 1;
      if (parentNode && parentNode.children) {
        idx = Array.prototype.indexOf.call(parentNode.children, node) + 1;
      }
      parts.unshift(node.tagName.toLowerCase() + ':nth-child(' + idx + ')');
      node = parentNode;
      guard++;
    }
    return parts.join(' > ');
  }

  /**
   * Resolves one non-shadow-crossing hop: tries progressively longer
   * ancestor-suffix selectors (shortest/most-specific first) until one
   * uniquely resolves to `expectedTarget` within `scope`, falling back to
   * an nth-child path. This is the original single-tree algorithm,
   * unchanged in behavior — just factored out so it can run once per hop.
   */
  function resolveHopSelector(scope, chain, expectedTarget) {
    for (var start = chain.length - 1; start >= 0; start--) {
      var candidate = chain.slice(start).join(' > ');
      var matches;
      try {
        matches = scope.querySelectorAll(candidate);
      } catch (e) {
        continue;
      }
      if (matches.length === 1 && matches[0] === expectedTarget) {
        return candidate;
      }
    }
    return buildNthChildPath(scope, expectedTarget) || null;
  }

  /**
   * Builds a selector for `targetEl` that resolves correctly when queried
   * from `scopeEl` via queryFromScope() (see below). Used both for
   * per-column selectors relative to a repeating container, and as the
   * base of the absolute single-element selector (scoped to document.body).
   *
   * Returns a plain CSS selector string when targetEl and scopeEl are in
   * the same DOM tree (the common case — identical to the original,
   * pre-shadow-DOM-aware behavior). Returns an array of selector strings
   * when the path from scopeEl to targetEl crosses one or more open
   * shadow-root boundaries; queryFromScope() knows how to resolve that
   * array by entering `.shadowRoot` between hops.
   */
  function buildRelativeSelector(scopeEl, targetEl) {
    if (targetEl === scopeEl) return ':scope';

    // Walk from targetEl up to scopeEl, splitting the path into "hops" at
    // every shadow-root boundary crossed. rawHops is built innermost-first
    // (chronological climbing order) and reversed at the end.
    var rawHops = [];
    var currentChain = [];
    var currentHopTarget = null;
    var node = targetEl;
    var guard = 0;
    var crossedAny = false;

    while (node && node !== scopeEl && guard < 60) {
      currentChain.unshift(localSegment(node));
      if (currentHopTarget === null) currentHopTarget = node;

      var pn = node.parentNode;
      if (isShadowRoot(pn)) {
        crossedAny = true;
        rawHops.push({ chain: currentChain, target: currentHopTarget, isHostMarker: false });
        currentChain = [];
        currentHopTarget = null;
        node = pn.host;
        continue;
      }
      node = node.parentElement;
      guard++;
    }

    if (node !== scopeEl) {
      // targetEl isn't actually a descendant of scopeEl (in the light DOM
      // or reachable open shadow trees).
      return null;
    }

    if (currentChain.length > 0) {
      rawHops.push({ chain: currentChain, target: currentHopTarget, isHostMarker: false });
    } else if (crossedAny) {
      // scopeEl itself is exactly the shadow host for the innermost hop —
      // nothing to query for this outer hop, just note we start there.
      rawHops.push({ chain: [], target: scopeEl, isHostMarker: true });
    }

    rawHops.reverse(); // now outer-to-inner: rawHops[0] resolves against scopeEl

    if (!crossedAny) {
      // No shadow boundaries at all: identical to the original single-tree
      // algorithm, returned as a plain string.
      return resolveHopSelector(scopeEl, rawHops[0].chain, rawHops[0].target);
    }

    var result = [];
    var scope = scopeEl;
    for (var i = 0; i < rawHops.length; i++) {
      var hop = rawHops[i];
      var sel = hop.isHostMarker ? HOST_MARKER : resolveHopSelector(scope, hop.chain, hop.target);
      if (!sel) return null;
      result.push(sel);

      if (i < rawHops.length - 1) {
        var resolvedEl = hop.isHostMarker ? scope : queryOne(scope, sel);
        if (!resolvedEl || !resolvedEl.shadowRoot) return null; // closed/missing shadow root — can't continue
        scope = resolvedEl.shadowRoot;
      }
    }
    return result;
  }

  function queryOne(scope, selector) {
    if (!scope) return null;
    if (selector === HOST_MARKER) return scope;
    try {
      return scope.querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  /**
   * Resolves a stored relativeSelector (string OR array, see
   * buildRelativeSelector) against a live scope element, transparently
   * entering shadow roots between array hops. This is what extraction
   * (scraper.js) and container-relative lookups should always use instead
   * of a raw `scope.querySelector(...)` call.
   */
  function queryFromScope(scope, selectorOrArray) {
    if (!scope) return null;
    if (typeof selectorOrArray === 'string') {
      return queryOne(scope, selectorOrArray);
    }
    if (!Array.isArray(selectorOrArray)) return null;

    var current = scope;
    for (var i = 0; i < selectorOrArray.length; i++) {
      if (!current) return null;
      var sel = selectorOrArray[i];
      var found = queryOne(current, sel);
      if (!found) return null;
      if (i < selectorOrArray.length - 1) {
        if (!found.shadowRoot) return null;
        current = found.shadowRoot;
      } else {
        current = found;
      }
    }
    return current;
  }

  /**
   * Shadow-aware equivalent of Element.closest(): walks up crossing out of
   * open shadow roots via their host, since native `.closest()` cannot see
   * past a shadow boundary.
   */
  function closestAcrossShadow(el, selector) {
    var node = el;
    var guard = 0;
    while (node && guard < 60) {
      if (node.nodeType === 1 && typeof node.matches === 'function') {
        try {
          if (node.matches(selector)) return node;
        } catch (e) {
          return null; // invalid selector
        }
      }
      var parentNode = node.parentNode;
      if (isShadowRoot(parentNode)) {
        node = parentNode.host;
      } else {
        node = node.parentElement;
      }
      guard++;
    }
    return null;
  }

  /**
   * Builds a selector that uniquely identifies `el` in the whole document.
   * Used for single-record pages (no repeating container detected) and for
   * pointing at a specific ancestor (e.g. a container's parent) by itself.
   */
  function buildSelectorForElement(el) {
    // buildRelativeSelector short-circuits to ':scope' when the target IS
    // the scope root, which is only meaningful for a *scoped* query
    // (containerEl.querySelector). Used at document level that would be
    // wrong, so these two boundary elements get literal selectors instead.
    if (el === document.body) return 'body';
    if (el === document.documentElement) return 'html';

    if (el.id && !isLikelyDynamicId(el.id)) {
      var idSel = '#' + cssEscape(el.id);
      var matches = countMatches(idSel);
      if (matches === 1 && document.querySelector(idSel) === el) {
        return idSel;
      }
    }
    var rel = buildRelativeSelector(document.body, el);
    if (typeof rel === 'string') return rel;
    // el lives inside a shadow tree relative to document.body — an array
    // result isn't usable as a plain document-level selector, so fall
    // back to a light-DOM path up to the shadow host at minimum.
    return buildNthChildPath(document.body, el) || null;
  }

  /**
   * Rough "how many distinct pieces of real content does this element
   * already contain" count, used only to tell a single BARE field (a
   * class-less <td> holding just text, or a title wrapped in a plain
   * span/anchor with no other content) apart from an already-complete
   * multi-field RECORD (a product card with its own title + price +
   * image + link). Not a precise content model — a cheap structural
   * signal, deliberately shallow-bounded (depth <= 4, which covers every
   * real card/row shape tested so far) so it stays fast on click.
   *
   * Only counts genuine LEAF content — an element with NO element
   * children of its own that still has real text (or an <img>/<source>,
   * which never has text children at all) — so a plain wrapper chain
   * around a single piece of text (e.g. <td><span><a>Title</a></span>
   * </td>, a real Hacker News shape) counts as exactly ONE meaningful
   * piece, not one per wrapper level. Without this, a title's own
   * wrapping span+anchor would look like "2 fields" and be mistaken for
   * an already-complete record, blocking the climb to the real repeating
   * row and collapsing the container down to individual title cells.
   *
   * The caller's "already a complete record" threshold is deliberately
   * >= 3, not >= 2: a real Hacker News title cell alone already reaches
   * 2 (the title text plus its small "(site.com)" domain annotation,
   * both inside the same span.titleline) without being a second field —
   * still just one title. A genuine multi-field card (title + price +
   * image, the minimum for the reported regression) reaches 3+.
   */
  function countMeaningfulDescendants(el) {
    if (!el || !el.children) return 0;
    var count = 0;
    function walk(node, depth) {
      if (depth > 4) return;
      Array.prototype.forEach.call(node.children || [], function (child) {
        var isMedia = child.tagName === 'IMG' || child.tagName === 'SOURCE';
        var isLeaf = !child.children || !child.children.length;
        var text = isLeaf ? (child.textContent || '').replace(/\s+/g, ' ').trim() : '';
        if (isMedia || (isLeaf && text)) count++;
        walk(child, depth + 1);
      });
    }
    walk(el, 0);
    return count;
  }

  /**
   * Climbs up from `el` looking for the repeating "card"/"row" that
   * contains it: the ancestor (possibly `el` itself) whose siblings, under
   * the same parent, share its tag name and stable class signature.
   *
   * Keeps climbing through a *contiguous* run of qualifying levels, but —
   * REAL REGRESSION FIX (real-world case: Etsy category grid grouping
   * every 4 product cards into a shared "row" wrapper div purely for CSS
   * layout, itself also repeating 16x across the page) — does NOT
   * automatically keep climbing to the OUTERMOST qualifying level once an
   * inner level already looks like a complete, self-contained record
   * (countMeaningfulDescendants >= 3: it already has its own title +
   * price + image + link, or similar). Climbing past that point just
   * groups multiple UNRELATED records (several different products) under
   * one "container," collapsing the eventual container selector down to
   * however many ROW wrappers exist (e.g. 16) instead of the true ~64
   * individual cards, and forcing per-field relative selectors down the
   * fragile nth-child fallback path (see buildRelativeSelector) since no
   * class-based selector can uniquely resolve one specific card's field
   * from within a row shared by several identical siblings.
   *
   * Only a genuinely THIN inner level (<=2 meaningful descendants — the
   * documented reason this climb exists at all: two class-less <td> cells
   * in the same <tr> both match tag+signature, but the row one level up
   * is the real repeating record; a single title cell with a small
   * "(site.com)" annotation also stays under this bar) still lets a
   * coarser ancestor win.
   * Conversely, when `el` itself is the repeating unit (e.g. clicking
   * directly on one <li> in a class-less list) and no further ancestor
   * also qualifies, `el`'s own level is kept, exactly as before.
   *
   * Shadow-aware: siblings are always checked against the element's real
   * parentNode (an Element or a ShadowRoot, both of which expose
   * `.children`), and climbing crosses out of an open shadow root via its
   * host so a repeating light-DOM ancestor (e.g. many <shreddit-post>
   * custom elements) can still be found even when the clicked field lives
   * deep inside one post's shadow-encapsulated internals.
   */
  function findRepeatingContainer(el) {
    var candidate = el;
    var guard = 0;
    var found = null;
    while (candidate && candidate !== document.documentElement && guard < 24) {
      var parentNode = candidate.parentNode;
      if (!parentNode || !parentNode.children) break;

      var siblings = Array.prototype.filter.call(parentNode.children, function (sib) {
        return sib === candidate || sameSignature(sib, candidate);
      });
      if (siblings.length >= 2) {
        if (found && countMeaningfulDescendants(found.container) >= 3) {
          break; // inner level is already a complete record — stop, don't group multiple records under a coarser layout wrapper
        }
        // `siblings` (the actual matched sibling ELEMENTS, not just a
        // count) is returned alongside the container so the selector-
        // generation step can build a selector from classes common to
        // ALL of them, instead of just this one clicked instance — see
        // buildContainerSelector's siblingEls parameter.
        found = { container: candidate, siblingCount: siblings.length, siblings: siblings };
      } else if (found) {
        break; // the chain of repeating levels just ended; use the last one found
      }

      if (isShadowRoot(parentNode)) {
        candidate = parentNode.host;
      } else if (parentNode.nodeType === 1) {
        candidate = parentNode;
      } else {
        break;
      }
      guard++;
    }
    return found || { container: null, siblingCount: 1, siblings: [] };
  }

  /**
   * REAL REGRESSION FIX: a single element's own stable classes can
   * include PER-ITEM utility classes that just happen to be real,
   * readable words (not caught by isLikelyDynamicClass at all) — a real
   * Etsy case: wt-order-xs-0/md-0/lg-0, a different number on every
   * card, used to reorder a CSS grid. Baking those into a container
   * selector makes it match only the handful of cards that happen to
   * share that exact same per-item value, instead of the whole repeated
   * set. When the caller supplies the actual matched sibling elements
   * (see findRepeatingContainer's `siblings`), this keeps only the
   * classes common to EVERY one of them — a class that varies per card
   * (order/badge/A-B-test flags) naturally drops out, while classes that
   * genuinely describe the shared card shape (layout/column-span/
   * component classes) survive, without ever blindly stripping a class
   * just because of its name or shape.
   */
  function commonStableClasses(containerEl, siblingEls) {
    var base = getStableClasses(containerEl);
    if (!siblingEls || siblingEls.length < 2) return base;
    return base.filter(function (c) {
      return siblingEls.every(function (sib) {
        return sib === containerEl || (sib.classList && sib.classList.contains(c));
      });
    });
  }

  /**
   * Builds a selector that matches every instance of a repeating container
   * element (not just the one instance it was derived from). Containers
   * are assumed to live in the light DOM (true for every site tested so
   * far, including Reddit, where the repeating unit is the custom element
   * itself, not something inside its shadow root).
   *
   * `expectedCount`, when given, is the exact number of elements the
   * caller already grouped through its own (more careful, structurally-
   * scoped) candidate-detection walk — e.g. AUTO detection's
   * findCandidateGroups(), which can reject a same-tag/same-class
   * element elsewhere on the page that doesn't share the group's actual
   * structural position (a different parent, a different repeating
   * pattern). A plain tag+class CSS selector has no such awareness: it
   * matches EVERY element in the whole document with that tag and those
   * classes, which can silently pick up extra elements the original
   * grouping correctly excluded (real-world case: a promotional/ad card
   * reusing the same product-card class name elsewhere in the DOM,
   * correctly excluded from the detected group but still matched by its
   * class selector at extraction time). When `expectedCount` is given,
   * each candidate selector is required to reproduce that EXACT count
   * before being accepted; a selector that matches too few (too
   * narrow — would under-extract) or too many (too broad — would pull
   * in unrelated elements) is rejected and a more specific variant is
   * tried instead. Omit `expectedCount` for callers with no known group
   * size (e.g. Manual Mode's single clicked element) to keep the exact
   * pre-existing, more lenient behavior.
   *
   * `siblingEls`, when given (Manual Mode, via findRepeatingContainer's
   * `siblings`), is the actual set of matched sibling elements — used to
   * strip per-item-only classes via commonStableClasses (see above)
   * before ever building a selector string, and as a coverage floor: a
   * candidate is never accepted if it matches FEWER elements than the
   * sibling set we already found directly in the DOM (the exact "matches
   * only 1-2 while dozens of structurally similar cards exist" failure
   * this fixes).
   */
  function buildContainerSelector(containerEl, expectedCount, siblingEls) {
    var tag = containerEl.tagName.toLowerCase();
    var stableClasses = commonStableClasses(containerEl, siblingEls);
    var classSuffix = stableClasses.map(function (c) { return '.' + cssEscape(c); }).join('');
    var hasExpectation = typeof expectedCount === 'number' && expectedCount > 0;
    var coverageFloor = Math.max(2, siblingEls ? siblingEls.length : 0);

    function matchesExactly(sel) { return hasExpectation && countMatches(sel) === expectedCount; }
    function meetsCoverageFloor(sel) { return countMatches(sel) >= coverageFloor; }

    if (stableClasses.length) {
      var classSel = tag + classSuffix;
      if (hasExpectation ? matchesExactly(classSel) : meetsCoverageFloor(classSel)) return classSel;
    }

    var parentEl = containerEl.parentElement;
    if (parentEl) {
      var parentSel = buildSelectorForElement(parentEl);
      if (parentSel) {
        // Parent-scoped, class-qualified variant first — the most
        // specific option, and the one most likely to disambiguate an
        // unrelated same-class element living under a different parent
        // elsewhere on the page.
        if (stableClasses.length) {
          var scopedClassSel = parentSel + ' > ' + tag + classSuffix;
          if (matchesExactly(scopedClassSel)) return scopedClassSel;
        }
        var childSel = parentSel + ' > ' + tag;
        if (hasExpectation ? matchesExactly(childSel) : meetsCoverageFloor(childSel)) return childSel;
      }
    }

    // No candidate reproduced the exact expected count. Fall back to the
    // best pre-existing approximation rather than returning nothing —
    // this only happens when the DOM genuinely offers no selector that
    // isolates exactly the detected group, an edge case no worse than
    // this function's original (pre-expectedCount) behavior.
    if (stableClasses.length) {
      var fallbackClassSel = tag + classSuffix;
      if (countMatches(fallbackClassSel) >= 2) return fallbackClassSel;
    }
    if (parentEl) {
      var fallbackParentSel = buildSelectorForElement(parentEl);
      if (fallbackParentSel) {
        var fallbackChildSel = fallbackParentSel + ' > ' + tag;
        if (countMatches(fallbackChildSel) >= 1) return fallbackChildSel;
      }
    }
    return tag;
  }

  /**
   * Suggests a default extraction type for a freshly-picked element.
   * Prefers Text when there's meaningful visible text (matches how a user
   * reads the page), even for <a>/<img>, since the href/src are still
   * available as an explicit dropdown choice.
   */
  function suggestAttribute(el) {
    var hasText = !!(el.textContent || '').replace(/\s+/g, ' ').trim();
    if (hasText) return 'text';
    if (el.tagName === 'IMG' || el.tagName === 'SOURCE') return 'src';
    if (el.tagName === 'A' || el.tagName === 'AREA') return 'href';
    return 'text';
  }

  function resolveUrl(url) {
    if (!url) return '';
    try {
      return new URL(url, document.baseURI).href;
    } catch (e) {
      return url;
    }
  }

  function isPlaceholderImageUrl(url) {
    if (!url) return true;
    // The literal base64 header of a 1x1 transparent GIF — an extremely
    // common, well-known lazy-load placeholder signature (not tied to any
    // one site), safe to recognize by exact prefix.
    if (/^data:image\/gif;base64,R0lGODlhAQAB/i.test(url)) return true;
    if (/^data:/i.test(url) && url.length < 100) return true; // tiny inline placeholder/spacer
    if (/\b(blank|placeholder|spacer|1x1|transparent|noimage|no[-_]?photo|dummy)\b/i.test(url)) return true;
    return false;
  }

  function hrefFromAnchor(anchorEl) {
    if (!anchorEl) return '';
    var raw = anchorEl.getAttribute('href') || '';
    if (!raw || /^javascript:/i.test(raw.trim())) return '';
    return anchorEl.href || resolveUrl(raw);
  }

  // ---- image URL resolution (V1.5.1 robustness pass) -----------------------
  //
  // eBay-style real-world testing surfaced very low image coverage (4/62
  // rows) on modern repeating-card layouts. Root cause was twofold:
  //  1) srcFromImage only looked at a fixed, short list of lazy-load
  //     attributes and took the FIRST srcset candidate (usually the
  //     *smallest*/lowest-quality one, sometimes a placeholder), never
  //     considered a <picture>/<source> ancestor, and never inspected
  //     descendant markup beyond one direct `el.querySelector('img')`.
  //  2) When a card's structure didn't exactly match the relativeSelector
  //     captured from the one card the user originally clicked (common on
  //     sites that vary card markup for sponsored/video/carousel variants),
  //     extraction silently returned '' for that row with no fallback.
  //
  // The functions below fix both, purely with classical DOM heuristics
  // (sizes, srcset descriptors, generic non-site-specific keyword hints) —
  // no AI/LLM, no eBay-specific selectors or hostnames anywhere.

  /**
   * Parses a `srcset`/`data-srcset` attribute value into
   * {url, width, density} candidates. Malformed entries (missing
   * descriptor, stray commas/whitespace) are simply skipped rather than
   * throwing, per spec's "graceful fallback" requirement.
   */
  function parseSrcset(srcset) {
    if (!srcset) return [];
    return String(srcset).split(',').map(function (entry) {
      var trimmed = entry.trim();
      if (!trimmed) return null;
      var parts = trimmed.split(/\s+/);
      var url = parts[0];
      if (!url) return null;
      var descriptor = parts[1] || '';
      var width = null, density = null;
      if (/^\d+w$/i.test(descriptor)) width = parseInt(descriptor, 10);
      else if (/^\d+(\.\d+)?x$/i.test(descriptor)) density = parseFloat(descriptor);
      return { url: url, width: width, density: density };
    }).filter(Boolean);
  }

  /** Picks the highest-resolution candidate out of a srcset: prefers the
   * largest `w` (width) descriptor, then the largest `x` (density)
   * descriptor, then the first listed URL if none carry a descriptor. */
  function bestFromSrcset(srcset) {
    var candidates = parseSrcset(srcset);
    if (!candidates.length) return '';
    var withWidth = candidates.filter(function (c) { return c.width != null; });
    if (withWidth.length) {
      withWidth.sort(function (a, b) { return b.width - a.width; });
      return withWidth[0].url;
    }
    var withDensity = candidates.filter(function (c) { return c.density != null; });
    if (withDensity.length) {
      withDensity.sort(function (a, b) { return b.density - a.density; });
      return withDensity[0].url;
    }
    return candidates[0].url;
  }

  var LAZY_SRC_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-image'];

  /**
   * Resolves the best URL for a single <img> (or <source>) element, in
   * priority order:
   *   1. currentSrc (the URL the browser actually resolved/is displaying —
   *      already accounts for srcset/picture, so it wins whenever usable)
   *   2. best candidate from the element's own srcset
   *   3. src / the element's own attribute
   *   4. common lazy-load data-* attributes (generic names, not site-tied)
   *   5. a <picture> ancestor's <source srcset> candidates
   * A candidate is skipped in favor of the next one only when it looks
   * like a placeholder (isPlaceholderImageUrl); the very first non-empty
   * candidate is still kept as a last-resort fallback so a real-but-odd
   * URL is never discarded outright.
   */
  function resolveSingleImageUrl(imgEl) {
    if (!imgEl) return '';
    var candidates = [];

    if (imgEl.currentSrc) candidates.push(imgEl.currentSrc);

    var ownSrcset = imgEl.getAttribute && imgEl.getAttribute('srcset');
    if (ownSrcset) {
      var bestOwn = bestFromSrcset(ownSrcset);
      if (bestOwn) candidates.push(bestOwn);
    }

    if (imgEl.src) candidates.push(imgEl.src);

    for (var i = 0; i < LAZY_SRC_ATTRS.length; i++) {
      var val = imgEl.getAttribute && imgEl.getAttribute(LAZY_SRC_ATTRS[i]);
      if (val) candidates.push(val);
    }
    var lazySrcset = imgEl.getAttribute && imgEl.getAttribute('data-srcset');
    if (lazySrcset) {
      var bestLazy = bestFromSrcset(lazySrcset);
      if (bestLazy) candidates.push(bestLazy);
    }

    var picture = imgEl.closest ? imgEl.closest('picture') : null;
    if (picture) {
      var sources = picture.querySelectorAll('source[srcset]');
      for (var j = 0; j < sources.length; j++) {
        var bestSource = bestFromSrcset(sources[j].getAttribute('srcset'));
        if (bestSource) candidates.push(bestSource);
      }
    }

    var firstNonEmpty = '';
    for (var k = 0; k < candidates.length; k++) {
      var c = candidates[k];
      if (!c) continue;
      if (!firstNonEmpty) firstNonEmpty = c;
      if (!isPlaceholderImageUrl(c)) return resolveUrl(c);
    }
    return firstNonEmpty ? resolveUrl(firstNonEmpty) : '';
  }

  /** Resolves an image URL starting from whatever element the column's
   * relativeSelector actually matched: the img/source/picture itself, or a
   * wrapper (div/a/span/...) containing one. */
  function imageUrlFromElement(el) {
    if (!el) return '';
    if (el.tagName === 'IMG' || el.tagName === 'SOURCE') return resolveSingleImageUrl(el);
    if (el.tagName === 'PICTURE') {
      var innerImg = el.querySelector('img');
      if (innerImg) return resolveSingleImageUrl(innerImg);
      var innerSource = el.querySelector('source[srcset]');
      return innerSource ? resolveSingleImageUrl(innerSource) : '';
    }
    var img = el.querySelector ? el.querySelector('img') : null;
    if (img) return resolveSingleImageUrl(img);
    var source = el.querySelector ? el.querySelector('source[srcset]') : null;
    return source ? resolveSingleImageUrl(source) : '';
  }

  // Generic (non-site-specific) keyword hints for things that are almost
  // never the "main" image of a card: avatars, rating stars, badges,
  // navigation arrows, loading spinners, tracking pixels, etc.
  var ICON_HINT_RE = /\b(avatar|icon|logo|sprite|rating|star|badge|flag|spinner|loading|pixel|tracking|swatch|checkbox|radio-btn|arrow|chevron|caret)\b/i;
  var MIN_MEANINGFUL_DIMENSION = 24; // px — below this, treat as icon/tracking-pixel sized

  function elementSizeHint(el) {
    if (typeof el.naturalWidth === 'number' && el.naturalWidth > 0) {
      return { width: el.naturalWidth, height: el.naturalHeight || el.naturalWidth, known: true };
    }
    var wAttr = parseInt(el.getAttribute && el.getAttribute('width'), 10);
    var hAttr = parseInt(el.getAttribute && el.getAttribute('height'), 10);
    if (wAttr > 0 || hAttr > 0) {
      return { width: wAttr || hAttr, height: hAttr || wAttr, known: true };
    }
    if (typeof el.getBoundingClientRect === 'function') {
      try {
        var rect = el.getBoundingClientRect();
        if (rect && (rect.width > 0 || rect.height > 0)) {
          return { width: rect.width, height: rect.height, known: true };
        }
      } catch (e) { /* ignore */ }
    }
    return { width: 0, height: 0, known: false };
  }

  function isHiddenElement(el) {
    if (!el || typeof window === 'undefined' || !window.getComputedStyle) return false;
    try {
      var style = window.getComputedStyle(el);
      return !!(style && (style.display === 'none' || style.visibility === 'hidden'));
    } catch (e) {
      return false;
    }
  }

  /**
   * Scores one <img> candidate found inside a card: larger, visible,
   * "product-photo-shaped" images score higher; icons/avatars/badges and
   * tracking pixels score low or negative. Every signal here is generic —
   * dimensions, visibility, and common English UI-keyword hints — never a
   * specific site's class/attribute name.
   */
  function scoreImageCandidate(imgEl, containerEl, indexInDocumentOrder) {
    var size = elementSizeHint(imgEl);
    var maxDim = Math.max(size.width, size.height);
    var score = 0;

    if (size.known) {
      if (maxDim > 0 && maxDim < MIN_MEANINGFUL_DIMENSION) return -1000;
      score += Math.min(size.width * size.height, 250000);
    }

    var hints = (imgEl.className || '') + ' ' + (imgEl.getAttribute('alt') || '') + ' ' + (imgEl.getAttribute('id') || '');
    var parent = imgEl.parentElement;
    var depth = 0;
    while (parent && parent !== containerEl && depth < 3) {
      hints += ' ' + (parent.className || '');
      parent = parent.parentElement;
      depth++;
    }
    if (ICON_HINT_RE.test(hints)) score -= 500;

    if (isHiddenElement(imgEl)) score -= 1000;

    // A slight bonus for appearing earlier in document order: a card's
    // main photo conventionally comes before secondary badges/icons.
    score += Math.max(0, 20 - indexInDocumentOrder * 2);

    return score;
  }

  /**
   * Card-relative fallback (spec #7): used only when the column's own
   * relativeSelector fails to resolve inside a given row/card, or resolves
   * to an element with no usable image at all. Searches ONLY within
   * `containerEl` (never the whole document, never another row) so row
   * alignment is always preserved — a card with genuinely no image simply
   * yields '', it never borrows another row's picture.
   */
  function findBestImageCandidate(containerEl) {
    if (!containerEl || !containerEl.querySelectorAll) return '';
    var imgs = Array.prototype.slice.call(containerEl.querySelectorAll('img'));
    if (!imgs.length) return '';

    var best = '', bestScore = -Infinity;
    imgs.forEach(function (imgEl, idx) {
      var candidate = resolveSingleImageUrl(imgEl);
      if (!candidate) return;
      var score = scoreImageCandidate(imgEl, containerEl, idx);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    });
    // A candidate that scored in icon/hidden-penalty territory is worse
    // than no candidate at all — don't surface it.
    return bestScore > -500 ? best : '';
  }

  // ---- price/amount-shaped field fallback (real regression) ----------------
  //
  // REAL REGRESSION: a discounted product card commonly shows BOTH a
  // current/sale price AND a struck-through original price, both marked
  // up with the SAME class (e.g. "currency-value"). Because the clicked
  // calibration example lived in a discounted card, buildRelativeSelector
  // was forced to add a positional (nth-of-type) prefix to tell the two
  // apart in THAT one card — correct there, but a NON-discounted card
  // only has ONE such element, so the same position often resolves to
  // nothing, or to an unrelated element (e.g. just the currency-symbol
  // span, "TL" with no digits at all). Same underlying category of bug as
  // the container-selector regression (a position that only generalizes
  // within the ONE calibration instance's exact shape), one level down —
  // now at the FIELD level instead of the container level.
  //
  // isStruckThrough/findWithinCardTextFallback below are used ONLY as a
  // fallback (never override an already-good, digit-bearing value), and
  // are entirely generic — no site-specific selector, no assumption about
  // sibling order. They only look for OTHER elements inside the SAME
  // card sharing the target's own bare local segment (the last hop of its
  // relativeSelector, e.g. "span.currency-value" — the part of the
  // selector that identifies WHAT the field is, stripped of the
  // positional prefix that identifies WHICH one).

  /** True when `el` (or one of its ancestors up to `boundaryEl`) is
   * visually struck through — a <del>/<s>/<strike> element, or computed
   * text-decoration containing "line-through". This is the near-universal
   * way "original/was" prices are shown crossed out across e-commerce
   * sites, and is a far more reliable "this is the OLD price" signal than
   * any class name or DOM position. */
  function isStruckThrough(el, boundaryEl) {
    var node = el;
    var guard = 0;
    while (node && node.nodeType === 1 && guard < 8) {
      if (/^(DEL|S|STRIKE)$/.test(node.tagName)) return true;
      if (typeof window !== 'undefined' && window.getComputedStyle) {
        try {
          var style = window.getComputedStyle(node);
          // Checked separately and concatenated, not `a || b` — some DOM
          // implementations (jsdom included) resolve the longhand
          // textDecorationLine to the literal, truthy string "none" even
          // when the shorthand textDecoration correctly reports
          // "line-through", which would short-circuit an `||` fallback
          // and silently defeat this whole check.
          var deco = ((style && style.textDecorationLine) || '') + ' ' + ((style && style.textDecoration) || '');
          if (/line-through/i.test(deco)) return true;
        } catch (e) { /* ignore */ }
      }
      if (node === boundaryEl) break;
      node = node.parentElement;
      guard++;
    }
    return false;
  }

  /** The bare, position-free local segment of a stored relativeSelector —
   * e.g. "span:nth-of-type(2) > span.currency-value" -> "span.currency-value".
   * That trailing segment is always the target element's OWN local
   * selector (buildRelativeSelector always climbs target-first, see its
   * own comment), so re-querying it alone, scoped to one card, finds
   * every element in that card that looks like the SAME kind of field —
   * exactly the candidate set a discounted card's current+original price
   * pair (or a non-discounted card's single price) both belong to.
   * Returns null for ':scope' or an array (shadow-DOM hop list), or when
   * the segment has NO class/attribute at all (just a bare tag, or a bare
   * tag+:nth-of-type — e.g. "span") — REAL REGRESSION (v1.30.9): re-
   * querying a bare tag inside a card matches EVERY element of that tag
   * (review-count badges, seller-name spans, "Star Seller" labels, price
   * spans, all at once), which is exactly how the fallback leaked into
   * unrelated columns. A field with no distinguishing class/attribute at
   * all gives this fallback nothing safe to re-search by, so it correctly
   * does nothing instead of guessing broadly.
   */
  function lastSelectorSegment(relativeSelector) {
    if (typeof relativeSelector !== 'string' || relativeSelector === ':scope' || !relativeSelector) return null;
    var parts = relativeSelector.split('>').map(function (s) { return s.trim(); }).filter(Boolean);
    var last = parts.length ? parts[parts.length - 1] : null;
    if (!last || !/[.\[]/.test(last)) return null; // must carry a real .class or [attr] — never a bare tag/position
    return last;
  }

  // REAL REGRESSION (v1.30.9): a plain "/\d/.test(text)" check accepted
  // review counts ("(56)", "(11)"), rating counts, and any other bare
  // number as if it were a price. A genuine price/amount always carries
  // SOME currency context alongside its digits (a symbol, or a short
  // currency code like "TL"/"USD"/"EUR") — a parenthesized bare count
  // never does. Both checks are fully generic — no fixed list of sites,
  // symbols are the common Unicode currency signs and codes are any
  // 2-3 letter uppercase token, not any one specific currency.
  var CURRENCY_SYMBOL_RE = /[$€£₺¥₹₩₪₫₴₦₱฿]/;
  var CURRENCY_CODE_RE = /\b[A-Z]{2,3}\b/;
  var PARENTHESIZED_COUNT_RE = /^\(\s*[\d.,]+\+?\s*\)$/;

  // ---- text-field contamination detection (real regression) ----------------
  //
  // REAL REGRESSION: a Title (or any other plain-text) field's own
  // relativeSelector, applied across cards with slightly varying DOM
  // shape, can resolve — on SOME cards — to a wider ancestor than the
  // one the user actually clicked, one that also wraps price/badge/
  // review-count text (e.g. "3,498.08 TL Robin Botanical Bird Fabric
  // Shower Curtain"). This is NOT the price-field fallback's "search
  // nearby for a better candidate" — the spec is explicit: no
  // neighboring-text fallback for Title. What IS allowed, and what
  // narrowToStructuralMatch below does, is looking STRICTLY INSIDE the
  // over-broad match for a descendant sharing the reference's own tag/
  // leaf shape (the wider match is, structurally, an ANCESTOR of the
  // real title node on these cards — never a sideways/neighboring
  // search) — and only when EXACTLY ONE such candidate exists, never a
  // guess among several. When no such candidate exists, or the wider
  // match itself carries no useful reference tag, this rejects (blanks)
  // rather than keeping the polluted text — "leave Title blank rather
  // than taking a broader parent/container."
  //
  // containsContaminationFragment only DETECTS contamination (a price-
  // shaped fragment or a parenthesized count/percentage fragment
  // embedded ANYWHERE in the text) — fully generic, no fixed currency
  // list, no site-specific wording — matching every reported fragment
  // ("3,498.08 TL", "(8,245)", "(155)", "(30% off)") without needing to
  // hardcode English phrases like "Star Seller"/"Sale Price" at all.
  //
  // The amount must look FORMATTED like a real listed price — cents
  // (".XX") or thousands-grouping ("X,XXX") — not a bare small integer.
  // A real regression: an unqualified "\d[\d.,]*" matched a genuinely
  // clean title that just happens to mention a casual dollar figure
  // mid-sentence ("Hacking with Claude on a $27 smart watch") — that's
  // real content, not a field boundary leak; a genuine leaked price is
  // always formatted like one (every reported example has 2 decimals).
  var FORMATTED_AMOUNT_SRC = '(?:\\d{1,3}(?:,\\d{3})+(?:\\.\\d{2})?|\\d+\\.\\d{2})';
  var EMBEDDED_PRICE_FRAGMENT_RE = new RegExp(
    FORMATTED_AMOUNT_SRC + '\\s*[$€£₺¥₹₩₪₫₴₦₱฿]|' +
    '[$€£₺¥₹₩₪₫₴₦₱฿]\\s*' + FORMATTED_AMOUNT_SRC + '|' +
    '\\b' + FORMATTED_AMOUNT_SRC + '\\s+[A-Z]{2,3}\\b'
  );
  var EMBEDDED_COUNT_FRAGMENT_RE = /\(\s*[\d,]+(?:\.\d+)?\s*%?(?:\s+off)?\s*\)/i;
  // A bare 4-digit number in parens with NO thousands separator and no
  // "%"/"off" qualifier, in the plausible calendar-year range, is almost
  // always a parenthetical year annotation ("(2020)", "(2022)") — a
  // universal, generic convention (real Hacker News titles use it
  // constantly) — not a review count: a genuinely large review/rating
  // count is conventionally comma-separated (e.g. the actual reported
  // "(8,245)"), and a smaller genuine count wouldn't coincidentally be
  // exactly 4 digits AND fall in a year-shaped range. A real regression:
  // without this exclusion, "(2020)"/"(2022)" in otherwise-clean titles
  // were being rejected as if they were review counts.
  var BARE_FOUR_DIGIT_YEAR_RE = /^\(\s*(\d{4})\s*\)$/;

  /** True when `text` contains a price-shaped fragment or a
   * parenthesized count/percentage fragment ANYWHERE within it — not
   * just when the whole string IS one (unlike looksLikePriceText below,
   * which judges a value in isolation). Used to detect a text field
   * that has picked up neighboring metadata rather than resolving to
   * just the field itself. */
  function containsContaminationFragment(text) {
    var t = String(text || '');
    if (!t) return false;
    if (EMBEDDED_PRICE_FRAGMENT_RE.test(t)) return true;
    var countMatch = t.match(EMBEDDED_COUNT_FRAGMENT_RE);
    if (!countMatch) return false;
    var yearMatch = countMatch[0].trim().match(BARE_FOUR_DIGIT_YEAR_RE);
    if (yearMatch) {
      var year = parseInt(yearMatch[1], 10);
      if (year >= 1000 && year <= 2999) return false; // parenthetical year, not a count
    }
    return true;
  }

  /**
   * Looks STRICTLY INSIDE `el` (an over-broad match — an ANCESTOR of the
   * real title node on some card shapes, never a sibling/neighbor) for a
   * descendant that shares `referenceTagName` (the tag the calibration
   * reference resolved to, e.g. "H3") AND is itself a leaf (no element
   * children — matching the reference's own plain-text shape). Also
   * accepts `el` itself when it already IS a leaf of that tag (the
   * ordinary, uncontaminated case — this makes the function safe to call
   * unconditionally). Returns null — never guesses — when el's own tag
   * doesn't match and no such single descendant exists, OR when more
   * than one candidate exists (genuinely ambiguous, can't tell which one
   * is "the title" without guessing).
   */
  function narrowToStructuralMatch(el, referenceTagName) {
    if (!el || !referenceTagName) return null;
    if (el.tagName === referenceTagName && (!el.children || !el.children.length)) return el;
    if (!el.querySelectorAll) return null;
    var candidates;
    try { candidates = Array.prototype.filter.call(el.querySelectorAll(referenceTagName), function (c) { return !c.children || !c.children.length; }); } catch (e) { return null; }
    return candidates.length === 1 ? candidates[0] : null;
  }

  /** True only for text that genuinely looks like a priced amount: has a
   * digit, is NOT a bare parenthesized count ("(56)"), and carries a
   * currency symbol or currency-code-shaped token — either in its own
   * text, or in `contextText` when given (see looksLikePriceElement).
   * Used both to decide whether a column's OWN reference value
   * establishes a price role at all (scraper.js's
   * classifyPriceColumnRoles) and to filter fallback candidates — the
   * fallback must never accept a review count, a "Star Seller" badge, or
   * a seller name just because it contains a digit. */
  function looksLikePriceText(text, contextText) {
    var t = String(text || '').trim();
    if (!t || !/\d/.test(t) || PARENTHESIZED_COUNT_RE.test(t)) return false;
    var ctx = contextText != null ? String(contextText) : t;
    return CURRENCY_SYMBOL_RE.test(ctx) || CURRENCY_CODE_RE.test(ctx);
  }

  /** Same check as looksLikePriceText, but sources the currency-context
   * signal from the candidate element's own text AND its immediate
   * parent's text only. Real markup very commonly splits the number
   * ("3.175,70") and the currency code/symbol ("TL") into SIBLING
   * elements/text nodes within one shared price wrapper — exactly "the
   * same price block" the digits live in — so requiring the currency
   * marker inside the EXACT SAME element as the digits would wrongly
   * reject a perfectly genuine price.
   *
   * Only consults the parent when the parent itself looks like a small,
   * single-purpose price wrapper — at most 3 direct element children
   * (a real price block: just the number and its currency unit, maybe
   * one more decorator). A real regression proved that checking the
   * parent's full text UNCONDITIONALLY reaches OUTSIDE the price block
   * entirely whenever the field's parent IS the whole card (the common
   * shape for a Title element, which usually has no price-block-style
   * wrapper of its own) — a Title whose product name happens to contain
   * a digit got misclassified as a price column purely because the
   * card's OWN price spans, several siblings away under that same big
   * parent, were reachable through it. Gating on a small child count
   * keeps this scoped to genuine price wrappers, never a big card-level
   * container. */
  function looksLikePriceElement(el) {
    if (!el) return false;
    var ownText = el.textContent || '';
    var parent = el.parentElement;
    var parentLooksLikeTightWrapper = !!(parent && parent.children && parent.children.length <= 3);
    var parentText = parentLooksLikeTightWrapper ? (parent.textContent || '') : '';
    return looksLikePriceText(ownText, ownText + ' ' + parentText);
  }

  /**
   * Searches `containerEl` for every element matching `coreSelector` (see
   * lastSelectorSegment — already guaranteed to carry a real class/
   * attribute, never a bare tag) that genuinely looks like a price (see
   * looksLikePriceText — rejects review counts, badges, plain digits with
   * no currency context), and picks one:
   *  - preferStruckThrough === true (this column's role was established
   *    as "the struck-through/original price" — see scraper.js's
   *    classifyPriceColumnRoles): ONLY a genuinely struck-through
   *    price-looking candidate qualifies. Returns '' when none exists —
   *    an old-price column must stay EMPTY on a non-discounted card,
   *    never silently reuse the current price.
   *  - preferStruckThrough === false/unknown (current/sale-price role,
   *    or no role established yet): prefers a NOT-struck-through
   *    candidate; falls back to any price-looking one only if every
   *    candidate happens to be struck through (better than nothing).
   * Never searches outside `containerEl` — a card with genuinely no
   * matching price simply yields '', it never borrows another row's.
   */
  function findWithinCardTextFallback(containerEl, coreSelector, preferStruckThrough) {
    if (!containerEl || !coreSelector) return '';
    var candidates;
    try { candidates = Array.prototype.slice.call(containerEl.querySelectorAll(coreSelector)); } catch (e) { return ''; }
    var priceLike = candidates.filter(function (el) { return looksLikePriceElement(el); });
    if (!priceLike.length) return '';
    var struck = priceLike.filter(function (el) { return isStruckThrough(el, containerEl); });
    var notStruck = priceLike.filter(function (el) { return !isStruckThrough(el, containerEl); });
    var pick = preferStruckThrough ? struck[0] : (notStruck[0] || priceLike[0]);
    return pick ? (pick.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  /**
   * REAL REGRESSION (v1.30.10): on a real, non-discounted Etsy card, the
   * clicked/stored current-price selector resolves to a CURRENCY-ONLY
   * element ("TL") — not because a class-based search finds nothing (the
   * discounted-card fallback above already handles that), but because
   * the real markup puts the currency code on its OWN small element and
   * the actual number is a SIBLING within the same shared price wrapper,
   * NOT sharing that element's class at all (so findWithinCardTextFallback's
   * same-class re-search, correct for the discounted case, can't see it —
   * there's nothing of that exact class to find).
   *
   * DOM relationship this recovers: `currencyEl.parentElement` — the one
   * immediate ancestor both the currency text and the price number live
   * directly inside (the shared "price block") — is inspected for its
   * OTHER direct children (element or plain text node), and the first
   * one containing a digit (and not struck through, and not a bare
   * parenthesized count) is treated as the number. Deliberately scoped
   * to ONLY that one immediate parent's direct children — never the
   * whole card, never a class-based search — so a review count, rating,
   * badge, or shipping line living anywhere else in the card is
   * structurally unreachable from here, regardless of what it contains.
   *
   * Returns the reconstructed "<number> <currency>" string (e.g.
   * "2,538.67 TL"), or '' when no qualifying numeric sibling exists in
   * that one parent (never guesses further out).
   */
  function findSiblingNumericPrice(currencyEl, boundaryEl) {
    if (!currencyEl || !currencyEl.parentElement) return '';
    var parent = currencyEl.parentElement;
    // Never reconstruct a CURRENT price out of a struck-through block —
    // that would be the original/old price's own currency unit.
    if (isStruckThrough(parent, boundaryEl)) return '';

    var currencyText = (currencyEl.textContent || '').replace(/\s+/g, ' ').trim();
    if (!currencyText) return '';

    var numericText = '';
    Array.prototype.some.call(parent.childNodes, function (node) {
      if (node === currencyEl) return false;
      var isTextNode = node.nodeType === 3;
      var isElementNode = node.nodeType === 1;
      if (!isTextNode && !isElementNode) return false;
      if (isElementNode && isStruckThrough(node, boundaryEl)) return false; // never the crossed-out original
      var t = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && /\d/.test(t) && !PARENTHESIZED_COUNT_RE.test(t)) {
        numericText = t;
        return true; // stop at the first qualifying sibling
      }
      return false;
    });

    return numericText ? (numericText + ' ' + currencyText).trim() : '';
  }

  function extractValue(el, attribute, containerEl, attributeName) {
    if (attribute === 'href') {
      if (!el) return '';
      if (el.tagName === 'A' || el.tagName === 'AREA') return hrefFromAnchor(el);
      var link = closestAcrossShadow(el, 'a[href]') || (el.querySelector ? el.querySelector('a[href]') : null);
      return hrefFromAnchor(link);
    }

    if (attribute === 'src') {
      if (el && el.tagName === 'IFRAME') return resolveUrl(el.src || el.getAttribute('src') || '');
      var direct = imageUrlFromElement(el);
      if (direct) return direct;
      // el was null (selector didn't match in this card) or matched
      // something with no usable image inside it — fall back to scoring
      // every image actually present in this row's own container.
      return containerEl ? findBestImageCandidate(containerEl) : '';
    }

    if (!el) return '';

    if (attribute === 'alt') {
      if (el.tagName === 'IMG') return el.getAttribute('alt') || '';
      var innerImg = el.querySelector ? el.querySelector('img') : null;
      return innerImg ? (innerImg.getAttribute('alt') || '') : (el.getAttribute ? (el.getAttribute('alt') || '') : '');
    }

    // V1.17 #7: arbitrary attribute extraction (data-*, aria-*, title,
    // srcset, any attribute name at all) — advanced-user escape hatch
    // when none of the built-in extraction types fit. The raw attribute
    // value is returned completely unmodified (spec #6: "do not silently
    // alter the original value").
    if (attribute === 'attr') {
      if (!attributeName) return '';
      return el.getAttribute ? (el.getAttribute(attributeName) || '') : '';
    }

    // V1.17 #1: raw HTML extraction — the element's own markup content,
    // for cases plain text can't represent (e.g. a description field with
    // meaningful <br>/<b> formatting the user wants to keep). Never
    // trimmed/normalized like the 'text' path below — HTML is returned
    // byte-for-byte as the browser serializes it.
    if (attribute === 'html') {
      return el.innerHTML != null ? el.innerHTML : '';
    }

    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // =====================================================================
  // V1.17 #6: field TYPE detection — metadata only, never mutates the
  // extracted value itself. Classifies a small sample of already-extracted
  // raw strings into a likely display type so the picker/Auto Detect UI
  // can show a helpful hint ("Currency-like text", "Date-like text"...).
  // Deliberately simple regex/heuristic classification, not statistical
  // analysis of the full dataset — that's explicitly out of scope (V1.x is
  // the raw-collection engine, not V2's analysis engine).
  // =====================================================================

  var FIELD_TYPE_CURRENCY_RE = /(?:[$€£₺¥₹]\s?\d[\d.,]*\d?|\d[\d.,]*\d\s?[$€£₺¥₹])/;
  var FIELD_TYPE_NUMBER_RE = /^\s*-?[\d,]+(?:\.\d+)?\s*[%kKmMbB]?\s*$/;
  var FIELD_TYPE_URL_RE = /^(https?:)?\/\//i;
  var FIELD_TYPE_DATE_RE = /\b(\d+\s?(?:min|hour|hr|day|week|month|year)s?\s?ago|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}|\d{4}-\d{2}-\d{2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4})\b/i;

  /**
   * `samples` is a small array of already-extracted raw strings (never
   * mutated or re-derived here). Returns one of: 'currency' | 'number' |
   * 'url' | 'date' | 'text' | 'empty'. A minimum agreement ratio (60%) is
   * required before committing to a specific type — otherwise 'text',
   * the always-safe default, matching this file's existing
   * guessSemanticName-style "don't overclaim" convention.
   */
  function detectFieldType(samples) {
    var nonEmpty = (samples || []).filter(function (s) { return s != null && String(s).trim() !== ''; });
    if (!nonEmpty.length) return 'empty';
    var ratio = function (re) { return nonEmpty.filter(function (v) { return re.test(String(v).trim()); }).length / nonEmpty.length; };
    if (ratio(FIELD_TYPE_CURRENCY_RE) >= 0.6) return 'currency';
    if (ratio(FIELD_TYPE_URL_RE) >= 0.6) return 'url';
    if (ratio(FIELD_TYPE_DATE_RE) >= 0.6) return 'date';
    if (ratio(FIELD_TYPE_NUMBER_RE) >= 0.6) return 'number';
    return 'text';
  }

  // =====================================================================
  // V1.17 #12: Selector Health/Quality — a purely informational score over
  // an ALREADY-GENERATED selector string, never fed back into generation
  // itself (buildRelativeSelector/buildContainerSelector are unchanged —
  // spec #13: "do not rewrite working V1.16 functionality"). Exists so the
  // picker/Advanced UI can show a simple "Good / Fair / Fragile" read-out
  // without exposing raw scoring internals to a normal user.
  // =====================================================================

  function selectorQualityLabel(score) {
    if (score >= 70) return 'Good';
    if (score >= 40) return 'Fair';
    return 'Fragile';
  }

  /**
   * Scores a single selector STRING (never an array-form shadow-hop
   * selector — those are always scored 'Fair' as a neutral default, since
   * their per-hop pieces are already the most-stable-available choice by
   * construction). Dimensions, all generic/structural — never a
   * statistical claim about the underlying DATA:
   *   + a leading #id segment (very stable)
   *   + meaningful class or data-attribute or semantic-attribute segments
   *     (stable)
   *   - each :nth-child()/:nth-of-type() segment (positional, fragile —
   *     breaks the moment a sibling is added/removed/reordered)
   *   - a selector matching what looks like a dynamic/generated class or
   *     id (isLikelyDynamicClass/Id — should already have been filtered
   *     out by generation, but scored honestly if one slips through)
   *   - excessive depth (many combinator segments — longer chains are
   *     more likely to break when a site restructures markup)
   * Returns {score: 0-100, label: 'Good'|'Fair'|'Fragile', reasons: [...]}
   * — `reasons` is short, human-readable, and intentionally not shown to
   * a normal user (spec: "do not overwhelm normal users with technical
   * scoring"); Advanced UI may surface it.
   */
  function scoreSelectorQuality(selector) {
    if (!selector || typeof selector !== 'string') {
      return { score: 50, label: 'Fair', reasons: ['multi-part selector (shadow DOM) — not individually scored'] };
    }
    if (selector === ':scope') {
      return { score: 100, label: 'Good', reasons: ['refers to the container element itself'] };
    }

    var segments = selector.split('>').map(function (s) { return s.trim(); }).filter(Boolean);
    var score = 60; // neutral baseline
    var reasons = [];

    if (/^#[\w-]/.test(segments[0])) {
      score += 25;
      reasons.push('starts from a stable #id');
    }

    var nthCount = (selector.match(/:nth-(?:child|of-type)\(/g) || []).length;
    if (nthCount > 0) {
      score -= Math.min(35, nthCount * 15);
      reasons.push(nthCount + ' positional :nth-*() step' + (nthCount === 1 ? '' : 's') + ' (breaks if sibling order changes)');
    }

    var classMatches = selector.match(/\.([\w-]+)/g) || [];
    if (classMatches.length) {
      var dynamicLooking = classMatches.filter(function (c) { return isLikelyDynamicClass(c.slice(1)); });
      if (dynamicLooking.length) {
        score -= 20;
        reasons.push('contains a class that looks auto-generated');
      } else {
        score += 10;
        reasons.push('uses meaningful class name' + (classMatches.length === 1 ? '' : 's'));
      }
    }

    if (/\[data-[\w-]+(="[^"]*")?\]/.test(selector) || /\[(?:itemprop|role|type|name|rel)(="[^"]*")?\]/.test(selector)) {
      score += 10;
      reasons.push('uses a semantic/data attribute');
    }

    if (segments.length > 4) {
      score -= (segments.length - 4) * 5;
      reasons.push('deep selector path (' + segments.length + ' levels)');
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    return { score: score, label: selectorQualityLabel(score), reasons: reasons };
  }

  root.WSSelector = {
    getStableClasses: getStableClasses,
    isLikelyDynamicClass: isLikelyDynamicClass,
    isLikelyDynamicId: isLikelyDynamicId,
    countMatches: countMatches,
    findRepeatingContainer: findRepeatingContainer,
    countMeaningfulDescendants: countMeaningfulDescendants,
    commonStableClasses: commonStableClasses,
    buildContainerSelector: buildContainerSelector,
    buildRelativeSelector: buildRelativeSelector,
    buildSelectorForElement: buildSelectorForElement,
    queryFromScope: queryFromScope,
    closestAcrossShadow: closestAcrossShadow,
    suggestAttribute: suggestAttribute,
    extractValue: extractValue,
    resolveUrl: resolveUrl,
    // image resolution internals — exposed for targeted unit testing
    isPlaceholderImageUrl: isPlaceholderImageUrl,
    parseSrcset: parseSrcset,
    bestFromSrcset: bestFromSrcset,
    resolveSingleImageUrl: resolveSingleImageUrl,
    imageUrlFromElement: imageUrlFromElement,
    findBestImageCandidate: findBestImageCandidate,
    scoreImageCandidate: scoreImageCandidate,
    // price/amount field fallback (real regression) — exposed for
    // targeted unit testing and for scraper.js's per-column role check
    isStruckThrough: isStruckThrough,
    lastSelectorSegment: lastSelectorSegment,
    looksLikePriceText: looksLikePriceText,
    containsContaminationFragment: containsContaminationFragment,
    narrowToStructuralMatch: narrowToStructuralMatch,
    looksLikePriceElement: looksLikePriceElement,
    findWithinCardTextFallback: findWithinCardTextFallback,
    findSiblingNumericPrice: findSiblingNumericPrice,
    // V1.17: field-type metadata + selector quality scoring
    detectFieldType: detectFieldType,
    scoreSelectorQuality: scoreSelectorQuality
  };
})(window);
