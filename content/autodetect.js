/**
 * autodetect.js
 * "Smart Auto Detect" — classical DOM heuristics (no AI/LLM) that scan the
 * current page for repeating structures (product cards, news items, table
 * rows, list items, etc.), score candidates, and propose a
 * containerSelector + columns[] in EXACTLY the shape the manual Add
 * Column flow already produces (see content/scraper.js's pickElementInfo
 * output / utils/storage.js's state shape). That's the whole integration
 * story: once the user applies a detected structure, it becomes ordinary
 * columns — CSV/XLSX/JSON/Filter/Sort/Saved Scrapers need no awareness
 * that Auto Detect exists at all.
 *
 * Reuses the existing, UNCHANGED selector engine wherever possible
 * (WSSelector.buildContainerSelector, buildRelativeSelector,
 * getStableClasses, extractValue, suggestAttribute, queryFromScope) —
 * this file only adds the NEW capability of finding candidates across the
 * whole page instead of starting from one user click, and scoring/naming
 * them.
 *
 * No hostname checks anywhere in this file — every heuristic here is
 * generic DOM/text-pattern analysis.
 */
(function (root) {
  'use strict';

  var Sel = root.WSSelector;

  // ---- tunable limits (perf / safety) ---------------------------------
  var MAX_SCAN_ELEMENTS = 6000;      // cap on how many elements we examine for grouping
  var MAX_CANDIDATES = 8;            // how many top-scored structures we fully analyze
  var MAX_FIELDS_PER_STRUCTURE = 10; // cap suggested columns per structure
  var COVERAGE_SAMPLE_SIZE = 30;     // instances sampled per field for coverage/preview
  var MAX_TIME_MS = 4000;            // soft budget; stop deepening analysis past this

  var EXCLUDE_LEAF_TAGS = { BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, SVG: 1, SCRIPT: 1, STYLE: 1, BR: 1, HR: 1, NOSCRIPT: 1, LABEL: 1 };
  var NAV_ANCESTOR_SELECTOR = 'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]';
  // V1 AUTO DETECTION FIX (real-Chrome eBay diagnostic — candidate 125):
  // the bare "ad" alternative was removed. A 2-letter standalone token is
  // far too generic — on a real, large, deeply-nested page, SOME ancestor
  // within a normal climb depth coincidentally containing "ad" as an
  // isolated id/class token (for reasons entirely unrelated to
  // advertising or navigation) is common, not rare. It was proven to
  // false-positive-penalize a genuine 60-item product-card dataset with
  // 100% link/image/price presence down from a would-be top score to
  // below a 9-item filter/spec accordion with none of those signals.
  // "advert"/"promo"/"banner"/"sponsor" are kept — all specific, real
  // words with materially lower false-positive risk.
  var NAV_KEYWORD_RE = /\b(nav|menu|sidebar|breadcrumb|pagination|pager|footer|header|social|share|cookie|banner|advert|promo|sponsor)\b/i;
  var MAIN_KEYWORD_RE = /\b(main|content|results?|list|grid|items?|cards?|products?|feed|listings?|posts?|search)\b/i;
  // V1 AUTO DETECTION FIX: the id/class keyword ancestor climb is kept
  // intentionally shallow (was 8). A genuine nav/sidebar/footer WRAPPER
  // is almost always a close (1-3 level) ancestor of what it directly
  // contains; the further up the tree a keyword coincidence is found,
  // the less likely it actually describes the candidate's OWN role, and
  // the more likely it's a large, unrelated, shared page-layout
  // container that happens to wrap both real content and something
  // nav-like elsewhere on the page.
  var NAV_KEYWORD_CLIMB_DEPTH = 4;

  // =====================================================================
  // Step 1: candidate repeating-group discovery (whole-page scan)
  // =====================================================================

  function isShadowRoot(node) {
    return !!(node && node.nodeType === 11 && node.host);
  }

  /** Structural signature: tag + stable classes (sorted, joined) —
   * deliberately the same signal proven in content/selector.js's
   * findRepeatingContainer across real sites already. Still used as-is
   * for table row-grouping below (detectTableStructures) and as the
   * "no stable classes at all" fallback bucket in scanRootForGroups —
   * see that function's own comment for why its OWN grouping no longer
   * requires this full combined string to match exactly. */
  function childSignature(el) {
    var tag = el.tagName;
    var classes = Sel.getStableClasses(el).sort().join('.');
    return tag + '|' + classes;
  }

  /**
   * V1 AUTO DETECTION IMPROVEMENT (real-Chrome eBay failure — root cause
   * #2 of 2, see test-v1-autodetect-realworld-classvariance.js): groups
   * every scanned element's direct children by tag + EACH INDIVIDUAL
   * stable class they carry, instead of requiring their FULL combined
   * class set to match exactly. Real card grids very commonly vary a
   * handful of BEM-style modifier/badge classes across only SOME items
   * (sponsored/watched/best-match/price-drop/free-returns/top-rated,
   * etc.) — the OLD exact-full-set signature treated every such
   * variation as a genuinely different element type, fragmenting one
   * real repeating dataset into many small, weak candidates (confirmed
   * empirically: a 40-card set with realistic per-card badge
   * combinations fragmented down to a largest group of just 12 under the
   * old algorithm).
   *
   * Any element whose stable class list is completely empty (e.g. every
   * class it has was filtered out by Sel.getStableClasses as dynamic-
   * looking) still falls back to the exact tag+'' signature bucket, so
   * elements sharing NO real class at all still correctly group when
   * their (now class-less) shape genuinely matches — this is the
   * necessary safety net for content/selector.js's own
   * isLikelyDynamicClass() improvements (see that file) actually paying
   * off when a card's ENTIRE class list turns out to be noise.
   *
   * This is a pure GENERALIZATION of the old behavior, not a narrower
   * replacement: when every child in a set shares an IDENTICAL full
   * class set (every pre-existing test fixture in this project, and the
   * common simple case), each of those shared classes' own bucket
   * already reconstructs the exact same membership — nothing that used
   * to group together can stop grouping together. The trade-off is
   * intentionally accepted: a widely-shared generic utility class
   * (unrelated siblings that merely share one layout/utility class) can
   * now also form a candidate group — bounded to children of the SAME
   * parent only (never page-wide), and still has to survive scoring
   * (content/link/image/price/consistency signals) same as any other
   * candidate, so a genuinely unrelated grouping simply scores poorly
   * and loses rather than being filtered out at this earlier stage.
   *
   * Overall cost stays linear in the number of (element, its children,
   * that child's own stable-class count) triples — bounded by the same
   * MAX_SCAN_ELEMENTS budget as before; a card's stable-class count is
   * typically small (1-4), so this is a modest constant-factor increase,
   * not a complexity-class change.
   */
  function scanRootForGroups(rootNode, budget) {
    var groups = [];
    var scanned = 0;
    var walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT, null);
    var node = rootNode.nodeType === 11 ? walker.nextNode() : rootNode; // ShadowRoot itself isn't an Element

    while (node && scanned < budget.remaining) {
      scanned++;
      var children = node.children;
      if (children && children.length >= 2) {
        var bySig = {};
        for (var i = 0; i < children.length; i++) {
          var child = children[i];
          var tag = child.tagName;
          var stableClasses = Sel.getStableClasses(child);
          if (!stableClasses.length) {
            var emptySig = tag + '|';
            (bySig[emptySig] || (bySig[emptySig] = [])).push(child);
            continue;
          }
          for (var c = 0; c < stableClasses.length; c++) {
            var sig = tag + '|' + stableClasses[c];
            (bySig[sig] || (bySig[sig] = [])).push(child);
          }
        }
        for (var key in bySig) {
          if (bySig[key].length >= 2) {
            groups.push({ parent: node, elements: bySig[key], tag: bySig[key][0].tagName });
          }
        }
      }
      node = walker.nextNode();
    }
    budget.remaining -= scanned;
    return groups;
  }

  // ROW/CONTAINER OVER-COUNTING FIX (real Amazon production report — see
  // consolidateFragmentedGroups below for the full mechanism): the same
  // tag+stable-class signature recurring under this many DIFFERENT
  // parents is the generic signature of "an internal layout row reused
  // several times INSIDE each outer record" (a shared design-system
  // utility class, e.g. Amazon's own "a-section", repeated as siblings
  // inside every product card), never a coincidence worth treating as
  // dozens of independent candidates. A signature seen under FEWER than
  // this many distinct parents is left completely untouched — the
  // common, already-correct case (a genuine repeating structure has its
  // instances as siblings under exactly ONE shared parent, so it was
  // never fragmented in the first place).
  var MIN_DISTINCT_PARENTS_FOR_CONSOLIDATION = 4;

  function groupSignature(g) {
    var repEl = g.elements[0];
    return g.tag + '|' + Sel.getStableClasses(repEl).slice().sort().join('.');
  }

  /**
   * ROW/CONTAINER OVER-COUNTING FIX — real production report: a real
   * Amazon search run (https://www.amazon.com/s?k=desk+lamp) reported
   * 167 unique rows from ~48 visible product cards on page 1 alone.
   *
   * ROOT CAUSE: scanRootForGroups groups elements PER PARENT NODE — so a
   * shared layout/utility class reused several times as direct siblings
   * INSIDE every product card (e.g. Amazon's own generic "a-section",
   * used for a card's title row, price row, rating row, etc.) produces
   * ONE SEPARATE small candidate group PER CARD (48 cards -> up to 48
   * near-identical ~3-4-element candidate groups), instead of being
   * recognized as one page-wide pattern. dedupeCandidates (below) only
   * ever collapses candidates related by DOM containment with a NEARLY
   * EQUAL item count (a real `<div>` vs. its own `<a>` child, count
   * difference <= 2) — a "48 separate ~4-count groups, one per card"
   * situation never triggers that check at all, since none of those 48
   * groups contains another (they live under 48 DIFFERENT parents).
   * Each one competes independently for a slot in the top-MAX_CANDIDATES
   * ranking, crowding out the real, correct "48 product cards" candidate
   * (itself just ONE clean group, since the cards themselves ARE
   * siblings under one shared parent — the results grid). Whichever one
   * of these near-identical per-card fragments happens to win then has
   * its own containerSelector built from a class that, at REAL
   * extraction time, matches every such row on EVERY card page-wide
   * (~167) — one product card producing several rows instead of one.
   *
   * FIX: consolidate every same-signature group recurring under
   * MIN_DISTINCT_PARENTS_FOR_CONSOLIDATION+ different parents into ONE
   * candidate (its real, honest page-wide membership) BEFORE scoring —
   * so it competes exactly ONCE, at its own true achievable score, never
   * dozens of times. A genuine per-card fragment (typically containing
   * only PART of a record's link/image/price, never all three together)
   * scores meaningfully lower under this file's own existing link/image/
   * price signal weighting than the real per-card container (which
   * DOES carry all three together) — so the correct candidate wins on
   * its own merits, through the exact same scoring this file already
   * uses for every other decision, once it's no longer drowned out.
   *
   * Generic by construction — never keyed to any hostname, class name,
   * or site-specific shape; the SAME "internal layout row repeated many
   * times per outer record" pattern this fixes is common to any site
   * built on a component/utility-class design system, not an
   * Amazon-only quirk. A signature that only ever recurs under a
   * handful of parents (the normal case for a genuinely correct,
   * already-singular repeating structure) is left completely
   * untouched — zero behavior change for Etsy/eBay/every other
   * previously-verified site.
   */
  function consolidateFragmentedGroups(groups) {
    var bySig = {};
    var order = [];
    groups.forEach(function (g) {
      var sig = groupSignature(g);
      if (!bySig[sig]) { bySig[sig] = []; order.push(sig); }
      bySig[sig].push(g);
    });
    var result = [];
    order.forEach(function (sig) {
      var entries = bySig[sig];
      if (entries.length === 1) { result.push(entries[0]); return; }
      var distinctParents = [];
      entries.forEach(function (g) { if (distinctParents.indexOf(g.parent) === -1) distinctParents.push(g.parent); });
      if (distinctParents.length < MIN_DISTINCT_PARENTS_FOR_CONSOLIDATION) {
        entries.forEach(function (g) { result.push(g); });
        return;
      }
      var allElements = [];
      entries.forEach(function (g) { allElements = allElements.concat(g.elements); });
      result.push({ parent: null, elements: allElements, tag: entries[0].tag, consolidatedFromGroupCount: entries.length, consolidatedFromParentCount: distinctParents.length });
    });
    return result;
  }

  // REAL AMAZON EVIDENCE mission (TASK 3 — "anchor to common ancestor
  // structure"): scanRootForGroups/consolidateFragmentedGroups above find
  // candidates purely by CLASS-SHARING (elements grouped because they
  // share a stable class). That works well when the true repeating
  // record itself carries a clean, page-wide-unique class — but the real
  // persisted diagnostic proved a case where it doesn't: Amazon's own
  // product-card wrapper apparently has no such class of its own, while
  // an internal utility class shared with sidebar/spec content
  // ("a-section a-spacing-none") was the ONLY thing consistently shared
  // page-wide, so it was the only clean class-based candidate ever
  // generated. This adds a SECOND, structurally-independent discovery
  // method: starting from a heading-like element (a strong "this is
  // probably a title field, not a whole record" signal — the SAME
  // consideration a human relies on when clicking a title in Manual
  // Mode), climb via Sel.findRepeatingContainer — the exact same,
  // already-proven sibling-climbing algorithm Manual Mode's own
  // click-to-select flow uses on real sites today — to the nearest
  // ancestor level that (a) repeats across siblings under one shared
  // parent and (b) already looks like a complete record
  // (countMeaningfulDescendants' "stop once complete" rule, built into
  // findRepeatingContainer itself, so this never over-climbs past the
  // true card boundary). The result is added as one MORE ordinary raw
  // candidate group — it still has to earn its place through the exact
  // same scoring/cohesion/dedup pipeline as every other candidate; this
  // only widens WHERE candidates can come from, never what wins.
  var MAX_ANCHOR_CANDIDATES_EXAMINED = 40;

  function addAnchoredCandidates(groups) {
    var added = [];
    var examined = 0;
    for (var i = 0; i < groups.length && examined < MAX_ANCHOR_CANDIDATES_EXAMINED; i++) {
      var repEl = groups[i].elements && groups[i].elements[0];
      if (!repEl || !repEl.querySelector) continue;
      var heading = /^H[1-6]$/.test(repEl.tagName) ? repEl : repEl.querySelector('h1,h2,h3,h4,h5,h6');
      if (!heading) continue;
      examined++;
      var climbed;
      try { climbed = Sel.findRepeatingContainer(heading); } catch (e) { continue; }
      if (!climbed || !climbed.container || climbed.siblingCount < 2) continue;
      if (climbed.container === repEl) continue; // already the same level scanRootForGroups found
      added.push({ parent: climbed.container.parentNode, elements: climbed.siblings, tag: climbed.container.tagName, anchoredFromHeading: true });
    }
    return added;
  }

  // =====================================================================
  // REAL AMAZON EVIDENCE mission — ROUND 3 REBUILD (PART A): field-
  // anchored common-ancestor candidate generation. This is now the
  // PRIMARY, preferred way multi-field candidates are discovered when
  // the signals exist on the page — not another score adjustment layered
  // on top of the class-sharing scan, an independent, structurally-
  // guaranteed source of candidates. scanRootForGroups (class-sharing)
  // and addAnchoredCandidates (single-heading climb, previous round)
  // both remain — they are what still covers a single-field listing (a
  // table of contents, a plain link list) where there is no second
  // signal to anchor against; the HARD co-occurrence gate in
  // runAutoDetect() below applies uniformly to every candidate regardless
  // of which of these three methods produced it, so a class-shared
  // internal-fragment candidate can never be chosen once 2+ fields are
  // requested and it fails to actually carry them together.
  // =====================================================================

  var MAX_FIELD_ANCHOR_TITLES_EXAMINED = 80;
  var MAX_FIELD_ANCHOR_PRICE_LEAVES = 400;
  var MAX_FIELD_ANCHOR_CLIMB_DEPTH = 12;

  /** Every leaf element (no element children of its own) page-wide whose
   * OWN text matches PRICE_RE — the same signal computeCandidateSignals
   * already uses for priceLikeRatio, just collected as individual
   * elements instead of an aggregate ratio. Bounded so a pathological
   * page (thousands of numeric-looking leaves) can't blow the budget. */
  function collectPriceLikeLeaves(budget) {
    var out = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
    var node = walker.nextNode();
    while (node && out.length < budget) {
      if (!node.children || !node.children.length) {
        var text = normText(node.textContent);
        if (text && PRICE_RE.test(text)) out.push(node);
      }
      node = walker.nextNode();
    }
    return out;
  }

  /** Every heading element page-wide with real text — the same "title
   * candidate" shape addAnchoredCandidates already uses for its own
   * single-signal climb. */
  function collectTitleLikeHeadings(budget) {
    var out = [];
    var headings = document.body.querySelectorAll('h1,h2,h3,h4,h5,h6');
    for (var i = 0; i < headings.length && out.length < budget; i++) {
      if (normText(headings[i].textContent)) out.push(headings[i]);
    }
    return out;
  }

  /** Climbs from one title element's ancestor chain (bounded depth) to
   * the LOWEST ancestor whose subtree also encloses at least one
   * price-like leaf — the generic, structural "this ancestor already
   * contains both a title and a price together, so it's plausibly ONE
   * complete record" boundary. Returns null when no such ancestor exists
   * within the depth budget (a real, correct outcome for a page with
   * titles but genuinely no nearby prices — an article list, a table of
   * contents — where this method should decline rather than guess). */
  function findRecordBoundary(titleEl, priceLeaves) {
    var node = titleEl;
    var depth = 0;
    while (node && node !== document.body && depth < MAX_FIELD_ANCHOR_CLIMB_DEPTH) {
      for (var i = 0; i < priceLeaves.length; i++) {
        if (node !== priceLeaves[i] && node.contains && node.contains(priceLeaves[i])) return node;
      }
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  /**
   * PART A — field-anchored common-ancestor candidate generation (the
   * REBUILD this mission's evidence specifically asked for, replacing
   * "another score penalty against the existing broad selector" with a
   * decision rule that GUARANTEES co-occurrence by construction). Finds
   * every title-like heading page-wide, and for each one climbs to the
   * lowest ancestor that ALSO encloses a price-like value —
   * structurally guaranteeing this candidate's typical instance contains
   * both signals together, never relying on scoring to reward that after
   * the fact. Boundary elements are grouped by structural signature (tag
   * + stable classes) so many titles resolving to the SAME repeating
   * card shape become ONE candidate, not one per title — "items look
   * structurally similar" is enforced by this grouping itself, exactly
   * as consolidateFragmentedGroups already does for the class-sharing
   * scan. A signature reached by only ONE title still gets one more
   * chance via Sel.findRepeatingContainer's own sibling-climb (handles a
   * classless boundary element).
   *
   * Returns [] outright when no price-like signal exists anywhere on the
   * page — deliberately leaves single-field pages entirely to
   * scanRootForGroups/addAnchoredCandidates rather than forcing a
   * meaningless "anchor" search.
   */
  function findFieldAnchoredCandidates() {
    var priceLeaves = collectPriceLikeLeaves(MAX_FIELD_ANCHOR_PRICE_LEAVES);
    if (!priceLeaves.length) return [];
    var titles = collectTitleLikeHeadings(MAX_FIELD_ANCHOR_TITLES_EXAMINED);
    var boundaries = [];
    titles.forEach(function (t) {
      var b = findRecordBoundary(t, priceLeaves);
      if (b && boundaries.indexOf(b) === -1) boundaries.push(b);
    });
    if (boundaries.length < 2) return [];

    var bySig = {};
    var order = [];
    boundaries.forEach(function (b) {
      var sig = b.tagName + '|' + Sel.getStableClasses(b).slice().sort().join('.');
      if (!bySig[sig]) { bySig[sig] = []; order.push(sig); }
      bySig[sig].push(b);
    });

    var candidates = [];
    order.forEach(function (sig) {
      var els = bySig[sig];
      if (els.length >= 2) {
        candidates.push({ parent: els[0].parentNode, elements: els, tag: els[0].tagName, fieldAnchored: true });
        return;
      }
      var climbed;
      try { climbed = Sel.findRepeatingContainer(els[0]); } catch (e) { climbed = null; }
      if (climbed && climbed.container && climbed.siblingCount >= 2) {
        candidates.push({ parent: climbed.container.parentNode, elements: climbed.siblings, tag: climbed.container.tagName, fieldAnchored: true });
      }
    });
    return candidates;
  }

  /** Also looks inside every OPEN shadow root found in the light-DOM scan
   * (never closed ones), one level of shadow nesting deep — matches the
   * most common real pattern (repeating custom elements in light DOM,
   * each hiding its own internal shadow content) without the much larger
   * scope of finding top-level repeating groups whose grouping only
   * exists inside a single shared shadow root. */
  function findCandidateGroups() {
    var budget = { remaining: MAX_SCAN_ELEMENTS };
    var groups = scanRootForGroups(document.body, budget);

    if (budget.remaining > 0) {
      var hosts = document.body.querySelectorAll('*');
      for (var i = 0; i < hosts.length && budget.remaining > 0; i++) {
        var host = hosts[i];
        if (host.shadowRoot) {
          groups = groups.concat(scanRootForGroups(host.shadowRoot, budget));
        }
      }
    }

    var rawGroupCount = groups.length;
    groups = consolidateFragmentedGroups(groups);
    var anchored = addAnchoredCandidates(groups);
    groups = groups.concat(anchored);
    var fieldAnchored = findFieldAnchoredCandidates();
    groups = groups.concat(fieldAnchored);

    // scannedCount is purely ADDITIVE (V1 AUTO DETECTION DIAGNOSTICS) — no
    // existing caller reads it, so this changes nothing for production
    // AUTO detection; it exists only so the dev-only diagnostic can
    // report exactly how many of the page's elements were actually
    // examined vs. MAX_SCAN_ELEMENTS.
    return {
      groups: groups, truncated: budget.remaining <= 0, scannedCount: MAX_SCAN_ELEMENTS - budget.remaining,
      // ROW/CONTAINER OVER-COUNTING FIX diagnostics (mission's own
      // explicit requirement): how many raw per-parent groups existed
      // before consolidation, vs. after — the delta is exactly how many
      // groups were folded together as "internal fragments of a single
      // outer record" rather than treated as independent candidates.
      rawGroupCountBeforeConsolidation: rawGroupCount,
      groupCountAfterConsolidation: groups.length,
      // REAL AMAZON EVIDENCE mission diagnostics (TASK 3): how many
      // extra candidates were discovered via the heading-anchored climb
      // rather than class-sharing.
      anchoredCandidateCount: anchored.length,
      // PART A diagnostics: how many extra candidates were discovered via
      // the NEW field-anchored (title+price common-ancestor) method.
      fieldAnchoredCandidateCount: fieldAnchored.length
    };
  }

  // =====================================================================
  // Step 2: candidate scoring
  // =====================================================================

  function normText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  /** V1 AUTO DETECTION FIX: returns a GRADED match instead of a plain
   * boolean — 'semantic' for a real <nav>/<header>/<footer>/<aside>/ARIA-
   * landmark ancestor (high confidence: an actual HTML element whose
   * ROLE is navigation/chrome, not a guess), 'keyword' for an id/class
   * text match within NAV_KEYWORD_CLIMB_DEPTH ancestor levels (lower
   * confidence — a coincidental naming match, proven capable of firing
   * on a genuine, strong product-card dataset), or 'none'. Scored with
   * different weights in computeCandidateSignals() below specifically so
   * one weak, coincidental keyword match can no longer cost as much as
   * genuinely being inside real navigation markup. */
  function navAncestorMatchKind(el) {
    if (el.closest && el.closest(NAV_ANCESTOR_SELECTOR)) return 'semantic';
    var node = el;
    var depth = 0;
    while (node && node !== document.body && depth < NAV_KEYWORD_CLIMB_DEPTH) {
      var idAndClass = (node.id || '') + ' ' + (node.className && typeof node.className === 'string' ? node.className : '');
      if (NAV_KEYWORD_RE.test(idAndClass)) return 'keyword';
      node = node.parentElement;
      depth++;
    }
    return 'none';
  }

  function isInMainLikeAncestor(el) {
    if (el.closest && el.closest('main, article, [role="main"]')) return true;
    var node = el;
    var depth = 0;
    while (node && node !== document.body && depth < 8) {
      var idAndClass = (node.id || '') + ' ' + (node.className && typeof node.className === 'string' ? node.className : '');
      if (MAIN_KEYWORD_RE.test(idAndClass)) return true;
      node = node.parentElement;
      depth++;
    }
    return false;
  }

  /** V1 AUTO DETECTION IMPROVEMENT — spec #1-3: on top of the pre-existing
   * repeat-count/content/link/image/consistency signals, this adds the
   * signals that distinguish "a list of items a human wants" from a
   * specification/attribute table or a promo/nav pattern:
   *   - price-like content and heading-like titles (spec #1's "repeated
   *     price-like values" / "repeated titles/headings") are POSITIVE
   *     signals a listing dataset almost always has and a spec table
   *     almost never does.
   *   - link-target DIVERSITY (spec #3's "all links point to the same
   *     page" negative signal) — a repeated promo/CTA pattern often
   *     links everywhere to one place; real item cards link to distinct
   *     detail pages.
   *   - an explicit "attribute/spec-list shape" penalty: no links, no
   *     images, and unusually tight text-length consistency together is
   *     the classic shape of a label:value specification/facts table
   *     (spec #3's "structure resembles a specification table for ONE
   *     product") — exactly the real-Chrome eBay failure (a Brand/Type/
   *     Color/Connectivity "Item specifics" panel outscoring the actual
   *     product cards). Every condition must hold together: a genuine
   *     product-card candidate keeps its bonus as long as it has EITHER
   *     links OR images, which real item cards from any site essentially
   *     always do — this penalty only fires on candidates that have
   *     neither. Consistency's own weight is also reduced (was the single
   *     largest signal) since it alone rewards a spec table's uniformly
   *     short label:value text just as much as a genuine card grid.
   */
  /** V1 AUTO DETECTION DIAGNOSTICS — pure mechanical split of the
   * PREVIOUSLY SINGLE scoreCandidate() body into (1) this function, which
   * computes every intermediate signal AND the final score, unchanged
   * arithmetic, byte-for-byte, and (2) scoreCandidate() below, now a
   * one-line wrapper returning just the score. NO scoring/matching logic
   * was altered by this split — every existing test in
   * test-autodetect.js/test-v1-autodetect-quality.js/
   * test-v1-autodetect-realworld-classvariance.js passes unchanged,
   * proving score values are identical to before. This exists ONLY so
   * the new dev-only diagnostic (runAutoDetectDiagnostic below) can
   * report the REAL signals the scorer actually used — hasLinkRatio,
   * hasImageRatio, priceLikeRatio, consistency, the attribute-list
   * penalty, etc. — instead of a second, separately-written
   * approximation that could quietly drift out of sync with the real
   * scoring logic over time. */
  /**
   * REAL AMAZON EVIDENCE mission (persisted diagnostics from a failed
   * real run — containerSelector "div.a-section.a-spacing-none", raw=242
   * page-wide matches for ~48 real product cards): computeCandidateSignals
   * used to always sample the FIRST `sampleSize` elements of a candidate
   * (elements.slice(0, sampleSize)) — for a candidate whose true
   * page-wide population is large and heterogeneous (a generic utility
   * class also reused in a sidebar/spec/filter area far from the product
   * grid), whichever handful of instances happen to occur FIRST in scan
   * order dominates every signal, even when they're not representative
   * of the population as a whole. Evenly-spaced sampling across the FULL
   * element list is a strict generalization: for any candidate with
   * n <= sampleSize (every existing small fixture/real site already
   * verified) this returns byte-for-byte the same elements as
   * elements.slice(0, sampleSize) — zero behavior change. It only
   * changes behavior once n exceeds the sample size, which is exactly
   * the large/heterogeneous-candidate case this fix targets.
   */
  function sampleEvenly(elements, sampleSize) {
    var n = elements.length;
    if (n <= sampleSize) return elements.slice();
    var out = [];
    for (var i = 0; i < sampleSize; i++) {
      out.push(elements[Math.floor(i * n / sampleSize)]);
    }
    return out;
  }

  function computeCandidateSignals(candidate) {
    var elements = candidate.elements;
    var n = elements.length;
    var sampleSize = Math.min(n, 12);
    var sample = sampleEvenly(elements, sampleSize);

    var textLens = sample.map(function (el) { return normText(el.textContent).length; });
    var avgTextLen = textLens.reduce(function (a, b) { return a + b; }, 0) / sampleSize;
    var linkCounts = sample.map(function (el) { return el.querySelectorAll('a[href]').length; });
    var imgCounts = sample.map(function (el) { return el.querySelectorAll('img').length; });
    var hasLinkRatio = linkCounts.filter(function (c) { return c > 0; }).length / sampleSize;
    var hasImageRatio = imgCounts.filter(function (c) { return c > 0; }).length / sampleSize;

    var priceLikeRatio = sample.filter(function (el) { return PRICE_RE.test(normText(el.textContent)); }).length / sampleSize;
    var titleLikeRatio = sample.filter(function (el) { return !!(el.querySelector && el.querySelector('h1,h2,h3,h4,h5,h6')); }).length / sampleSize;

    var hrefs = sample.map(function (el) {
      var a = el.querySelector && el.querySelector('a[href]');
      return a ? (a.getAttribute('href') || '').trim() : null;
    }).filter(Boolean);
    var distinctHrefCount = 0;
    if (hrefs.length) {
      var seenHrefs = {};
      hrefs.forEach(function (h) { if (!seenHrefs[h]) { seenHrefs[h] = 1; distinctHrefCount++; } });
    }
    var linkDiversityRatio = hrefs.length ? distinctHrefCount / hrefs.length : 0;

    var mean = avgTextLen;
    var variance = textLens.reduce(function (sum, l) { return sum + Math.pow(l - mean, 2); }, 0) / sampleSize;
    var stdDev = Math.sqrt(variance);
    var consistency = mean > 0 ? Math.max(0, 1 - Math.min(1, stdDev / mean)) : 0;

    var score = 0;
    score += Math.min(25, Math.log2(n + 1) * 6);                 // repeat count (diminishing returns)
    score += Math.min(20, avgTextLen / 10);                       // content richness
    score += hasLinkRatio * 15;                                   // link presence
    score += hasImageRatio * 8;                                   // image presence (bonus, not required)
    score += priceLikeRatio * 15;                                 // NEW: price-like content — strong listing/product signal
    score += titleLikeRatio * 7;                                  // NEW: heading-like title text
    if (hasLinkRatio > 0.4) score += linkDiversityRatio * 8;       // NEW: links to genuinely different destinations (only meaningful once links exist at all)
    score += consistency * 7;                                     // card-to-card consistency (reduced weight — see comment above)

    var repEl = elements[0];
    // V1 AUTO DETECTION FIX (real-Chrome eBay diagnostic — candidate 125
    // scored 66 instead of ~90+ because navigationPenaltyApplied=true
    // ALSO forced mainContentBonusApplied=false, a double swing from one
    // ancestor-keyword coincidence): mainBonus is now computed FULLY
    // INDEPENDENTLY of navPenalty — a candidate can legitimately show
    // both a nav-keyword coincidence AND genuine main-content markers at
    // once; one no longer silently cancels the other. The nav penalty
    // itself is now GRADED: a real semantic element (an actual <nav>/
    // <aside>/etc.) is high-confidence and keeps the full -30; a mere
    // id/class keyword match — the far less reliable signal that was
    // actually responsible for the real-Chrome failure — is now a
    // smaller -12.
    var navMatch = navAncestorMatchKind(repEl);
    var navPenalty = navMatch !== 'none'; // kept as a plain boolean for existing callers/diagnostics — see navMatchKind for the graded detail
    var mainBonus = isInMainLikeAncestor(repEl);
    if (mainBonus) score += 10;
    if (navMatch === 'semantic') score -= 30;
    else if (navMatch === 'keyword') score -= 12;

    var nearEmptyPenalty = avgTextLen < 3 && hasImageRatio < 0.3; // near-empty, non-visual repeats (likely decorative)
    if (nearEmptyPenalty) score -= 15;

    // The fix for the ORIGINAL real-Chrome eBay failure (item-specifics
    // spec table outscoring product cards):
    var looksLikeAttributeList = hasLinkRatio < 0.15 && hasImageRatio < 0.15 && consistency > 0.55 && n <= 40;
    if (looksLikeAttributeList) score -= 35;

    // V1 AUTO DETECTION FIX (this failure — a strong product-card
    // dataset must "strongly outrank filter/navigation/specification
    // groups with no images/prices" regardless of any ancestor-keyword
    // coincidence): an EXPLICIT, generic counter-signal — near-universal
    // link+image+price presence across a meaningfully large repeated set
    // is about as strong a "this is a real listing dataset" signal as
    // exists, and is deliberately weighted enough to survive even a
    // full semantic nav-penalty hit on its own. Never keyed to any site/
    // class name — purely the same link/image/price ratios and item
    // count already computed above for every candidate.
    var strongProductSignature = hasLinkRatio >= 0.8 && hasImageRatio >= 0.8 && priceLikeRatio >= 0.8 && n >= 10;
    if (strongProductSignature) score += 20;

    // REAL AMAZON EVIDENCE mission — real persisted diagnostic from a
    // failed run: containerSelector "div.a-section.a-spacing-none" won
    // with raw=242 page-wide matches against ~48 real product cards
    // (~5 matches per card). consolidateFragmentedGroups() (above) already
    // records, for every candidate it folds together, how many DISTINCT
    // PARENTS its elements actually came from (consolidatedFromParentCount)
    // — that number was computed but never fed back into scoring, so a
    // consolidated candidate competed purely on its content signals, with
    // no penalty for the one structural fact that actually distinguishes
    // "one row per record" from "several fragments per record": a genuine
    // repeating ITEM container has close to ONE element per distinct
    // parent (the real cards ARE the direct children of one shared grid —
    // each parent contributes exactly one candidate element), while an
    // internal layout primitive reused several times INSIDE every card
    // (a title row, a price row, a rating row, ... all sharing one
    // generic utility class) contributes SEVERAL candidate elements per
    // distinct parent. This is the same "row/card-level structure across
    // siblings" invariant the mission itself names, made mechanical and
    // graded — a candidate averaging meaningfully more than one element
    // per parent is charged in direct proportion to how fragment-shaped
    // it is. A ratio of exactly 1 (or a candidate that was never
    // consolidated at all — the normal, already-correct case for every
    // previously-verified site) gets zero penalty; nothing here is keyed
    // to any hostname, class name, or item count.
    var elementsPerParent = null;
    var fragmentationPenalty = 0;
    if (typeof candidate.consolidatedFromParentCount === 'number' && candidate.consolidatedFromParentCount > 0) {
      elementsPerParent = n / candidate.consolidatedFromParentCount;
      fragmentationPenalty = Math.min(50, Math.max(0, elementsPerParent - 1) * 14);
      score -= fragmentationPenalty;
    }

    return {
      score: Math.max(0, Math.min(100, Math.round(score))),
      itemCount: n, avgTextLen: avgTextLen, hasLinkRatio: hasLinkRatio, hasImageRatio: hasImageRatio,
      priceLikeRatio: priceLikeRatio, titleLikeRatio: titleLikeRatio, linkDiversityRatio: linkDiversityRatio,
      consistency: consistency, navPenalty: navPenalty, navMatchKind: navMatch, mainBonus: mainBonus,
      nearEmptyPenalty: nearEmptyPenalty, looksLikeAttributeList: looksLikeAttributeList,
      strongProductSignature: strongProductSignature,
      elementsPerParent: elementsPerParent, fragmentationPenalty: Math.round(fragmentationPenalty)
    };
  }

  function scoreCandidate(candidate) {
    return computeCandidateSignals(candidate).score;
  }

  function scoreToConfidence(score) {
    if (score >= 65) return 'High';
    if (score >= 40) return 'Medium';
    return 'Low';
  }

  function dedupeCandidates(scored) {
    var kept = [];
    scored.forEach(function (candidate) {
      var isDup = kept.some(function (existing) {
        var a = candidate.elements[0], b = existing.elements[0];
        if (a === b) return true;
        var related = (a.contains && a.contains(b)) || (b.contains && b.contains(a));
        return related && Math.abs(candidate.elements.length - existing.elements.length) <= 2;
      });
      if (!isDup) kept.push(candidate);
    });
    return kept;
  }

  // =====================================================================
  // Step 3: field detection within a chosen container
  // =====================================================================

  function collectLeafCandidates(containerInstance, budgetRemaining) {
    var results = [];
    var seen = 0;
    var stack = [containerInstance];
    var roots = [containerInstance];
    if (containerInstance.shadowRoot) roots.push(containerInstance.shadowRoot);

    roots.forEach(function (root) {
      var kids = root === containerInstance ? containerInstance.children : root.children;
      var toVisit = Array.prototype.slice.call(kids);
      while (toVisit.length && seen < budgetRemaining) {
        var el = toVisit.shift();
        seen++;
        if (EXCLUDE_LEAF_TAGS[el.tagName]) continue;

        if (el.tagName === 'IMG') {
          results.push(el);
          continue;
        }
        if (el.tagName === 'A') {
          results.push(el);
          continue; // don't descend into anchors — treated as one unit
        }
        if (el.children.length === 0) {
          if (normText(el.textContent)) results.push(el);
          continue;
        }
        // container-ish element: descend, plus also look inside its own
        // shadow root if it hosts one (nested web components)
        for (var i = 0; i < el.children.length; i++) toVisit.push(el.children[i]);
        if (el.shadowRoot) {
          for (var j = 0; j < el.shadowRoot.children.length; j++) toVisit.push(el.shadowRoot.children[j]);
        }
      }
    });
    return results;
  }

  /**
   * Collapses ancestor/descendant leaf pairs that yield identical text
   * (e.g. an anchor and the span inside it) down to just the outer one —
   * the "don't propose the same text twice" rule (spec #27 / TEST E).
   *
   * There's deliberately no separate "whole-card blob" ratio filter here:
   * collectLeafCandidates() only ever proposes genuine DOM leaves (no
   * element children) or anchors/images, so a candidate's text can never
   * actually be a concatenation of sibling fields' text — the blob case
   * that filter was meant to prevent structurally cannot occur. A
   * ratio-based filter was tried and removed: it produced false
   * negatives on simple, small cards where the one real field happens to
   * be the container's only content (e.g. a card with just a price and
   * no other text) — those are legitimate single-field candidates, not
   * blobs, and are exactly what TEST D's "missing image" case exercises.
   */
  function filterAndDedupeLeaves(containerInstance, leaves) {
    var filtered = leaves.filter(function (el) {
      return el.tagName === 'IMG' || el.tagName === 'A' || !!normText(el.textContent);
    });

    var kept = [];
    filtered.forEach(function (el) {
      var text = normText(el.textContent);
      var dupIndex = -1;
      for (var i = 0; i < kept.length; i++) {
        var other = kept[i];
        if (other.tagName === 'IMG' || el.tagName === 'IMG') continue;
        var otherText = normText(other.textContent);
        if (text && otherText && text === otherText) {
          var related = (el.contains && el.contains(other)) || (other.contains && other.contains(el));
          if (related) { dupIndex = i; break; }
        }
      }
      if (dupIndex === -1) {
        kept.push(el);
      } else {
        // prefer the OUTER (ancestor) element — simpler selector, and an
        // anchor wrapping a matching-text span should surface as the
        // anchor, not the span, so href stays available.
        if (el.contains && el.contains(kept[dupIndex])) kept[dupIndex] = el;
      }
    });
    return kept;
  }

  // ---- naming heuristics (spec #7) ----

  // REAL AMAZON EVIDENCE mission (ROOT CAUSE A) — real persisted data
  // contained genuine price values written as "TRY 1,640.85" (an ISO
  // 4217 currency CODE, not a symbol) that this pattern never matched at
  // all. A three-letter currency code immediately before/after a number
  // is a real, standard, WORLDWIDE convention (not Amazon-specific) —
  // a short, well-known allow-list (never "any 3 letters", which would
  // false-positive on ordinary words/abbreviations) closes this gap the
  // same way the symbol-based half already worked.
  var CURRENCY_CODE_RE_SRC = '(?:USD|EUR|GBP|TRY|JPY|CNY|INR|RUB|AUD|CAD|CHF|SEK|NOK|DKK|PLN|BRL|MXN|ZAR|AED|SAR|KRW|SGD|HKD|NZD)';
  var PRICE_RE = new RegExp(
    '(?:[$€£₺¥₹]\\s?\\d[\\d.,]*\\d' +
    '|\\d[\\d.,]*\\d\\s?[$€£₺¥₹]' +
    '|\\b' + CURRENCY_CODE_RE_SRC + '\\s?\\d[\\d.,]*\\d' +
    '|\\d[\\d.,]*\\d\\s?' + CURRENCY_CODE_RE_SRC + '\\b)',
    'i'
  );
  var RATING_RE = /^\s*\d(?:[.,]\d)?\s*(?:\/\s*5|\/\s*10|★|stars?)?\s*$/i;
  var DATETIME_RE = /\b(\d+\s?(?:min|hour|hr|day|week|month|year)s?\s?ago|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4})\b/i;
  var AUTHOR_RE = /^(?:u\/|@)[\w.\-]+$/;
  // V1 AUTO DETECTION IMPROVEMENT spec #4: "review(s)"/"rating(s)" added
  // to the recognized count-keyword vocabulary so a genuine review-count
  // field (e.g. "1,234 reviews", "(128 ratings)") gets the more specific
  // "Review Count" name below instead of the generic "Count" fallback —
  // still entirely evidence-driven (the sample text itself must actually
  // say "review"/"rating"), never a guess made from the field's position
  // or name alone.
  var COUNT_RE = /^\s*\(?[\d.,]+\s*[kKmMbB]?\+?\s*(comments?|replies|points?|upvotes?|views?|likes?|shares?|reviews?|ratings?)?\)?\s*$/;
  var REVIEW_COUNT_KEYWORD_RE = /reviews?|ratings?/i;

  function guessSemanticName(samples) {
    var nonEmpty = samples.filter(Boolean);
    if (!nonEmpty.length) return null;
    var ratio = function (re) { return nonEmpty.filter(function (v) { return re.test(v.trim()); }).length / nonEmpty.length; };

    if (ratio(PRICE_RE) >= 0.6) return 'Price';
    if (ratio(AUTHOR_RE) >= 0.6) return 'Author';
    if (ratio(DATETIME_RE) >= 0.5) return 'Date';
    if (ratio(RATING_RE) >= 0.6) return 'Rating';
    if (ratio(COUNT_RE) >= 0.6) {
      var reviewLike = nonEmpty.filter(function (v) { return REVIEW_COUNT_KEYWORD_RE.test(v); }).length / nonEmpty.length;
      return reviewLike >= 0.5 ? 'Review Count' : 'Count';
    }
    return null;
  }

  // V1.17 #5: a longer-prose heuristic (generic length signal, no
  // marketplace-specific wording) — catches job/listing/article/product
  // "description" fields alongside the existing Price/Author/Date/Rating/
  // Count guesses, generically enough to apply to any repeating-card
  // domain (spec's explicit "not mandatory e-commerce assumptions").
  // Deliberately checked ONLY for a non-first text field in
  // assignFieldName below — the FIRST text field on a card is always
  // "Title" regardless of its length (a long headline is still a title,
  // not a description).
  var DESCRIPTION_MIN_AVG_LEN = 60;

  function looksLikeDescription(samples) {
    var nonEmpty = (samples || []).filter(Boolean);
    if (!nonEmpty.length) return false;
    var avgLen = nonEmpty.reduce(function (sum, v) { return sum + v.trim().length; }, 0) / nonEmpty.length;
    return avgLen >= DESCRIPTION_MIN_AVG_LEN;
  }

  // =====================================================================
  // TITLE QUALITY (data-integrity mission, sections 5/6): a real-world
  // failure showed automatic Title detection sometimes returning an
  // ENTIRE product card's textContent — title + rating + review count +
  // "Star Seller" + sale price + old price + discount + seller/shipping
  // text all concatenated — because the card's own primary link (<a>)
  // wraps ALL of that as one clickable unit, and this file's own anchor-
  // text candidate previously always used that whole anchor's textContent
  // verbatim. The fix is architectural (find and select the ACTUAL title
  // element within the anchor), never text-editing/stripping the bad
  // blob after the fact (mission section 6: "prefer selecting the correct
  // DOM element over aggressively cleaning a bad giant text blob" — this
  // project's own established principle already applied to every other
  // cleaner in utils/cleaners.js: never fabricate/mangle, only choose or
  // decline).
  // =====================================================================

  // Embedded (not necessarily exact-match) signals that a text blob mixes
  // in card metadata beyond the title itself — deliberately checked as
  // SUBSTRINGS within a longer string, unlike PRICE_RE/RATING_RE/COUNT_RE
  // above (which classify a field whose ENTIRE value IS that signal).
  // Bilingual (EN + TR), matching this project's own established scope
  // for generic, non-marketplace-specific text heuristics.
  var EMBEDDED_RATING_RE = /\b\d(?:[.,]\d)?\s*(?:out of|\/)\s*5\b/i;
  var EMBEDDED_REVIEW_COUNT_RE = /\(?\b[\d.,]+[kKmM]?\+?\)?\s*(?:reviews?|ratings?|sold|satış|değerlendirme|yorum)\b/i;
  var SELLER_BADGE_RE = /\bstar\s*seller\b|\bbestseller\b|\btop\s*rated\b|\bçok\s*satan\b|\bvitrin\s*mağaza\b/i;
  var SHIPPING_LABEL_RE = /\bfree\s+shipping\b|\bships?\s+from\b|\bücretsiz\s+kargo\b|\bkargo\s+bedava\b/i;
  var DISCOUNT_LABEL_RE = /\b\d{1,3}\s*%\s*(?:off|indirim)\b/i;
  var AD_LABEL_RE = /\b(?:sponsored|advertisement|reklam)\b/i;

  /** Counts price-shaped substrings embedded anywhere in a longer text
   * blob (a global-flag copy of the existing exact-match PRICE_RE) — two
   * or more is a strong "this is a card blob, not a title" signal on its
   * own (mission's own explicit example: "duplicated price information
   * inside many Title values"). */
  function countEmbeddedPrices(text) {
    var re = new RegExp(PRICE_RE.source, 'gi');
    return (text.match(re) || []).length;
  }

  /**
   * True when `text` clearly mixes unrelated card metadata into what
   * should be a clean title — never used to EDIT text, only to decide
   * whether to search for a more specific DOM element instead (see
   * findBestTitleDescendant below). A real title merely CONTAINING a
   * number or a word that resembles one of these patterns in isolation
   * is never enough on its own to trip this (mission: "Do NOT remove
   * legitimate words from real product titles merely because they
   * resemble metadata") — every signal here requires either a repeated/
   * multiple-price shape or a recognizable, distinctly-labeled metadata
   * phrase (star seller, free shipping, N% off, etc.), not a bare number.
   */
  function looksLikeTitleContaminated(text) {
    if (!text) return false;
    if (countEmbeddedPrices(text) >= 2) return true;
    if (EMBEDDED_RATING_RE.test(text)) return true;
    if (EMBEDDED_REVIEW_COUNT_RE.test(text)) return true;
    if (SELLER_BADGE_RE.test(text)) return true;
    if (SHIPPING_LABEL_RE.test(text)) return true;
    if (DISCOUNT_LABEL_RE.test(text)) return true;
    if (AD_LABEL_RE.test(text)) return true;
    return false;
  }

  // Semantic signals for "this element IS a title", checked in DOM order
  // (querySelectorAll's natural document order) — generic across sites,
  // never a single site's own specific class names as the ONLY mechanism
  // (mission section 5: "the title extraction system must be generic...
  // site-specific heuristics may supplement the generic system but must
  // not replace it").
  var TITLE_ELEMENT_SELECTOR = 'h1,h2,h3,h4,h5,h6,[itemprop="name"],' +
    '[class*="title" i],[class*="Title" i],[class*="-name" i],[class*="_name" i],' +
    '[data-testid*="title" i],[data-testid*="name" i]';

  /**
   * Searches WITHIN `rootEl` (typically the card's own primary link) for
   * the single best title-like descendant — never the whole subtree's
   * combined text, always one specific element's own text. Returns null
   * (caller then falls back to the original, unmodified behavior — never
   * a regression) when nothing clean and title-shaped is found.
   */
  function findBestTitleDescendant(rootEl) {
    if (!rootEl || !rootEl.querySelectorAll) return null;
    var candidateEls;
    try { candidateEls = rootEl.querySelectorAll(TITLE_ELEMENT_SELECTOR); } catch (e) { candidateEls = []; }
    var best = null, bestScore = -1;
    Array.prototype.forEach.call(candidateEls, function (el) {
      var text = normText(el.textContent);
      if (!text) return;
      // Never select a descendant that is ITSELF still contaminated, or
      // that is actually a price/rating/count field wearing a heading tag
      // (a real, observed card pattern) — a title candidate must be
      // genuinely clean, not just "closer" to clean than the whole card.
      if (looksLikeTitleContaminated(text)) return;
      if (PRICE_RE.test(text) || RATING_RE.test(text) || COUNT_RE.test(text)) return;
      var score = 0;
      var tag = (el.tagName || '').toLowerCase();
      if (/^h[1-6]$/.test(tag)) score += 60 - (parseInt(tag.charAt(1), 10) * 3); // h1 strongest, h6 weakest, but any heading beats a class-name guess
      if (el.getAttribute && el.getAttribute('itemprop') === 'name') score += 55;
      var cls = (el.className && el.className.baseVal) || el.className || '';
      if (/title|name/i.test(String(cls))) score += 25;
      var testId = el.getAttribute ? (el.getAttribute('data-testid') || '') : '';
      if (/title|name/i.test(testId)) score += 20;
      // Longer (up to a point) reads as more title-like than a two-word
      // fragment, but never rewards runaway length — that's exactly the
      // "whole card blob" failure mode this function exists to avoid.
      score += Math.min(text.length, 80) / 4;
      if (score > bestScore) { bestScore = score; best = el; }
    });
    return best;
  }

  /** Resolves `relSelector`/`attribute` against a sample of `allInstances`
   * and computes coverage/uniqueness/sample values — the sampling core
   * buildFieldCandidate() always needed, now factored out so it can be
   * re-run against an ESCALATED (more specific) selector without
   * duplicating the loop (REAL AMAZON EVIDENCE mission ROOT CAUSE A). */
  function sampleFieldValues(containerScope, relSelector, attribute, allInstances) {
    var sampleN = Math.min(allInstances.length, COVERAGE_SAMPLE_SIZE);
    var nonEmpty = 0;
    var samples = [];
    // V1 AUTO DETECTION IMPROVEMENT spec #5 "Repeated Value Quality":
    // tracked across the FULL sample (not just the 8 values kept for
    // display) so a field that resolves to a genuine, small enumerated
    // set (e.g. "In Stock"/"Out of Stock") doesn't get unfairly punished
    // relative to one that just happens to be the SAME value on every
    // single row (the actual "boilerplate/decorative" case this signal
    // targets — a repeated badge, a repeated "Free Shipping" label, an
    // unrelated column that never actually varies for this dataset).
    var distinctValues = {};
    var distinctCount = 0;
    for (var i = 0; i < sampleN; i++) {
      var inst = allInstances[i];
      var el = relSelector === ':scope' ? inst : Sel.queryFromScope(inst, relSelector);
      var val = Sel.extractValue(el, attribute, inst);
      if (val) {
        nonEmpty++;
        if (samples.length < 8) samples.push(val);
        if (!distinctValues[val]) { distinctValues[val] = 1; distinctCount++; }
      }
    }
    var coverage = sampleN ? nonEmpty / sampleN : 0;
    if (coverage === 0) return null; // never produced a value in the sample — not a usable field
    // Meaningless (always 1.0) for a sample of exactly one row — only a
    // real signal once there's more than one row to actually vary across.
    var uniqueness = nonEmpty > 1 ? distinctCount / nonEmpty : 1;
    return { coverage: coverage, samples: samples, uniqueness: uniqueness, nonEmpty: nonEmpty };
  }

  /**
   * REAL AMAZON EVIDENCE mission — ROOT CAUSE A: the real persisted
   * config's own Price relativeSelector was "span.a-color-base" —
   * Amazon's own generic text-color utility class, reused for ratings,
   * badges, filter labels, and unrelated UI text, never price-specific
   * at all. Sel.buildRelativeSelector (content/selector.js, UNTOUCHED
   * by this fix — Manual Mode uses it too, where the user has already
   * visually confirmed their own click) only ever asks "does this
   * selector uniquely resolve to my target WITHIN this one container
   * instance?" — it has no concept of how generic that selector is
   * PAGE-WIDE, because for a single human-confirmed click that concept
   * doesn't matter. Auto Detect is the one blindly proposing selectors
   * across many candidates with no human confirming each one — this is
   * where a semantic-precision guardrail belongs.
   *
   * For a field whose own detected samples predominantly look price-like
   * (PRICE_RE — see its own comment for why "TRY 1,640.85"-style
   * currency-CODE prices, not just symbol-prefixed ones, are recognized
   * too, a real worldwide convention, never Amazon-specific), measures
   * how many elements that SAME selector matches page-wide, and what
   * fraction of THOSE global matches ALSO look price-like. A selector
   * that is both (a) far broader than this candidate's own expected item
   * count and (b) mostly NOT price-like when queried globally is a
   * confirmed "poisoned" selector — exactly Amazon's own
   * "TRY 1,640.85"/"4.7"/"Small Business"/"#1 Top Rated" all sharing one
   * generic class.
   */
  function measureGlobalSelectorPrecision(relativeSelector, expectedItemCount) {
    if (typeof relativeSelector !== 'string' || relativeSelector === ':scope') return null;
    var globalMatches;
    try { globalMatches = document.querySelectorAll(relativeSelector); } catch (e) { return null; }
    var totalMatches = globalMatches.length;
    if (totalMatches === 0) return null;
    // Evenly-spread sampling (sampleEvenly — see its own comment), never
    // just the first N in document order: the real record-level matches
    // (this selector's own INTENDED targets) are typically clustered
    // early in the DOM (the results grid usually comes before a sidebar/
    // footer/related-content section), so sampling only the front would
    // make an otherwise-imprecise selector look deceptively clean.
    var sample = sampleEvenly(Array.prototype.slice.call(globalMatches), Math.min(totalMatches, 60));
    var priceLikeCount = 0;
    for (var i = 0; i < sample.length; i++) {
      if (PRICE_RE.test(normText(sample[i].textContent))) priceLikeCount++;
    }
    return {
      totalMatches: totalMatches, sampledCount: sample.length, priceLikeRatio: priceLikeCount / sample.length,
      tooManyMatches: expectedItemCount > 0 && totalMatches > expectedItemCount * 3
    };
  }

  /** MISSION A — "search for a more specific selector": escalates to a
   * parent-scoped compound (the field-level analogue of
   * buildContainerSelector's own "parent-scoped" tier) by asking
   * Sel.buildRelativeSelector (untouched, existing, proven code) for a
   * selector to the leaf's OWN PARENT, then appending the leaf's own
   * local tag+stable-class segment as a direct-child combinator. This
   * remains correctly scoped when queried via Sel.queryFromScope(inst,
   * ...) because the parent-selector half was itself already built
   * relative to containerScope — the combinator only needs to match
   * within whatever containerScope's own querySelector call already
   * bounds. Returns null (caller then drops the field entirely rather
   * than ship a poisoned selector) when no parent selector is available,
   * the leaf has no stable class of its own to combine with, or the
   * escalated selector still fails to resolve correctly. */
  function tryEscalateFieldSelector(containerScope, leafEl) {
    var parentEl = leafEl.parentElement;
    if (!parentEl || parentEl === containerScope) return null;
    var parentSel = Sel.buildRelativeSelector(containerScope, parentEl);
    if (typeof parentSel !== 'string') return null;
    var leafClasses = Sel.getStableClasses(leafEl);
    if (!leafClasses.length) return null;
    var leafLocal = leafEl.tagName.toLowerCase() + leafClasses.map(function (c) { return '.' + c; }).join('');
    var escalated = (parentSel === ':scope' ? '' : parentSel + ' ') + '> ' + leafLocal;
    // Verify it actually resolves back to the SAME element it's meant to
    // — never ship an escalated selector that silently points elsewhere.
    var resolved = Sel.queryFromScope(containerScope, escalated);
    if (resolved !== leafEl) return null;
    return escalated;
  }

  function buildFieldCandidate(containerScope, leafEl, allInstances) {
    var relSelector = Sel.buildRelativeSelector(containerScope, leafEl);
    if (!relSelector) return null;

    var attribute = Sel.suggestAttribute(leafEl);
    var sampled = sampleFieldValues(containerScope, relSelector, attribute, allInstances);
    if (!sampled) return null;

    // ROOT CAUSE A gate: only fires for a candidate whose OWN samples
    // already predominantly look price-like — never touches a Title,
    // Link, Image, or any other field type, and never fires on a
    // genuinely precise price selector (the overwhelmingly common case).
    var priceLikeSampleRatio = sampled.samples.length
      ? sampled.samples.filter(function (v) { return PRICE_RE.test(v); }).length / sampled.samples.length
      : 0;
    if (priceLikeSampleRatio >= 0.6) {
      var precision = measureGlobalSelectorPrecision(relSelector, allInstances.length);
      if (precision && precision.tooManyMatches && precision.priceLikeRatio < 0.5) {
        var escalated = tryEscalateFieldSelector(containerScope, leafEl);
        if (escalated) {
          var escalatedPrecision = measureGlobalSelectorPrecision(escalated, allInstances.length);
          var escalatedSampled = sampleFieldValues(containerScope, escalated, attribute, allInstances);
          // Only accept the escalation if it's BOTH still usable
          // (produced real values) and genuinely more precise than the
          // original — otherwise fall through to rejecting the field
          // entirely rather than shipping a selector no better than the
          // poisoned one it was meant to replace.
          if (escalatedSampled && (!escalatedPrecision || !escalatedPrecision.tooManyMatches || escalatedPrecision.priceLikeRatio >= 0.5)) {
            relSelector = escalated;
            sampled = escalatedSampled;
          } else {
            return null;
          }
        } else {
          return null; // no more-specific selector available — drop this field rather than ship a poisoned one
        }
      }
    }

    return {
      relativeSelector: relSelector,
      attribute: attribute,
      tagName: leafEl.tagName,
      uniqueness: sampled.uniqueness,
      coverage: sampled.coverage,
      samples: sampled.samples,
      isAnchor: leafEl.tagName === 'A',
      isImage: leafEl.tagName === 'IMG'
    };
  }

  function pickPrimaryLink(containerInstance) {
    var scopes = [containerInstance];
    if (containerInstance.shadowRoot) scopes.push(containerInstance.shadowRoot);
    var anchors = [];
    scopes.forEach(function (scope) {
      Array.prototype.forEach.call(scope.querySelectorAll('a[href]'), function (a) {
        var href = (a.getAttribute('href') || '').trim();
        if (href && !/^javascript:/i.test(href)) anchors.push(a);
      });
    });
    if (!anchors.length) return null;
    var best = null, bestScore = -1;
    anchors.forEach(function (a) {
      var text = normText(a.textContent);
      var s = text.length;
      if (a.querySelector('img')) s += 30;
      if (a.querySelector('h1,h2,h3,h4,h5,h6')) s += 40;
      if (s > bestScore) { bestScore = s; best = a; }
    });
    return best;
  }

  function assignFieldName(candidate, usedNames, isFirstTextField) {
    var semantic = candidate.attribute === 'text' ? guessSemanticName(candidate.samples) : null;
    var base;
    if (candidate.isPrimaryLinkHref) base = 'Link';
    else if (semantic) base = semantic;
    else if (isFirstTextField) base = 'Title';
    else if (candidate.attribute === 'text' && looksLikeDescription(candidate.samples)) base = 'Description';
    else if (candidate.isImage) base = 'Image';
    else if (candidate.attribute === 'href') base = 'Link';
    // V1 AUTO DETECTION IMPROVEMENT spec #4: "Field" (never invents
    // meaning, spec's own suggested neutral name) instead of the old
    // "Text" fallback — "Text 6"/"Text 7"/"Text 8" read as broken/low-
    // quality to a user; "Field 6"/"Field 7"/"Field 8" reads as an
    // honest "we don't know what this is, here's the raw value."
    else base = 'Field';

    var name = base;
    var n = 2;
    while (usedNames[name]) { name = base + ' ' + n; n++; }
    usedNames[name] = true;
    return name;
  }

  function detectFields(containerInstance, allInstances) {
    var leafBudget = 150;
    var rawLeaves = collectLeafCandidates(containerInstance, leafBudget);
    var leaves = filterAndDedupeLeaves(containerInstance, rawLeaves);

    var primaryLink = pickPrimaryLink(containerInstance);

    var candidates = [];
    var seenSelectors = {};
    var textFieldSeen = false;

    leaves.forEach(function (el) {
      var fc = buildFieldCandidate(containerInstance, el, allInstances);
      if (!fc) return;
      if (seenSelectors[fc.relativeSelector]) return;
      seenSelectors[fc.relativeSelector] = true;

      if (fc.isAnchor) {
        // Text interpretation of the anchor (e.g. a title link). REAL
        // BUG fixed here (data-integrity mission): on a card whose
        // primary link wraps the ENTIRE card (title + rating + review
        // count + badges + price + shipping, all inside one <a>), using
        // this anchor's own full textContent verbatim produced exactly
        // the reported failure — a "Title" value containing all of that.
        // Fixed by searching for the actual title element INSIDE the
        // anchor first (see findBestTitleDescendant's own header comment
        // for why this is a DOM-selection fix, never a text-stripping
        // one) — only falls back to the anchor's own full text when the
        // anchor's text isn't contaminated to begin with, or no cleaner
        // descendant exists (never a regression from prior behavior).
        var anchorText = normText(el.textContent);
        var titleLeaf = el;
        if (looksLikeTitleContaminated(anchorText)) {
          var betterTitleEl = findBestTitleDescendant(el);
          if (betterTitleEl) titleLeaf = betterTitleEl;
        }
        var textFc, textVal;
        if (titleLeaf === el) {
          textFc = Object.assign({}, fc, { attribute: 'text' });
          textVal = Sel.extractValue(el, 'text');
        } else {
          // A genuinely different, more specific element — build its own
          // real candidate (own relativeSelector, own per-instance
          // samples/coverage/uniqueness) via the same generic pipeline
          // every other field candidate uses, never a hand-rolled stand-in.
          // Guarded against seenSelectors the same way the innerImg case
          // below already is — collectLeafCandidates() never descends
          // into an anchor on its own, so this can't collide with an
          // independently-discovered leaf, but the guard costs nothing
          // and keeps this consistent with that established pattern.
          var titleRel = Sel.buildRelativeSelector(containerInstance, titleLeaf);
          if (titleRel && !seenSelectors[titleRel]) {
            seenSelectors[titleRel] = true;
            textFc = buildFieldCandidate(containerInstance, titleLeaf, allInstances);
          }
          textVal = textFc ? (textFc.samples[0] || '') : '';
          if (!textFc || !textVal) {
            // The narrower element didn't actually resolve to a usable
            // value across the sample (e.g. it only exists on this one
            // instance) — fall back to the original anchor-text behavior
            // rather than silently dropping the Title field entirely.
            titleLeaf = el;
            textFc = Object.assign({}, fc, { attribute: 'text' });
            textVal = Sel.extractValue(el, 'text');
          }
        }
        if (textVal && textFc) candidates.push(textFc);
        // Only the PRIMARY link on the card also gets an href candidate —
        // avoids proposing a separate "Link" column per anchor on cards
        // with several links.
        if (el === primaryLink) {
          candidates.push(Object.assign({}, fc, { attribute: 'href', isPrimaryLinkHref: true }));
        }
        // V1 AUTO DETECTION IMPROVEMENT spec #1/#19: a common real card
        // pattern wraps the thumbnail INSIDE the same <a> as the title
        // (e.g. <a href="..."><img/><h3>Title</h3></a>) — collectLeaf-
        // Candidates() deliberately never descends into an anchor (an
        // anchor is always treated as one text/href unit), which meant
        // an image nested this way was previously invisible to field
        // detection entirely, even on an otherwise strong product-card
        // candidate. This proposes it as its own, separately-selectored
        // Image field WITHOUT changing the anchor's own text/href
        // handling above.
        var innerImg = el.querySelector && el.querySelector('img');
        if (innerImg) {
          var imgRel = Sel.buildRelativeSelector(containerInstance, innerImg);
          if (imgRel && !seenSelectors[imgRel]) {
            seenSelectors[imgRel] = true;
            var imgFc = buildFieldCandidate(containerInstance, innerImg, allInstances);
            if (imgFc) candidates.push(imgFc);
          }
        }
        return;
      }
      candidates.push(fc);
    });

    // De-duplicate candidates that resolve to the exact same values across
    // every sampled instance (different selector, same underlying data).
    var byValueKey = {};
    var deduped = [];
    candidates.forEach(function (c) {
      var key = c.attribute + '::' + c.samples.join('|');
      if (!key || c.samples.length === 0) { deduped.push(c); return; }
      if (byValueKey[key]) return; // keep the first (higher in DOM order / simpler)
      byValueKey[key] = true;
      deduped.push(c);
    });

    // Rank: primary link href first, then by coverage desc (ties broken
    // by uniqueness desc — spec #5 "Repeated Value Quality": between two
    // equally-covered fields, the one that actually VARIES row-to-row is
    // the more useful data, not a repeated badge/boilerplate label).
    deduped.sort(function (a, b) {
      if (!!a.isPrimaryLinkHref !== !!b.isPrimaryLinkHref) return a.isPrimaryLinkHref ? -1 : 1;
      if (b.coverage !== a.coverage) return b.coverage - a.coverage;
      return b.uniqueness - a.uniqueness;
    });

    var usedNames = {};
    var fields = deduped.slice(0, MAX_FIELDS_PER_STRUCTURE).map(function (c) {
      var isFirstText = !textFieldSeen && c.attribute === 'text' && !c.isPrimaryLinkHref;
      if (isFirstText) textFieldSeen = true;
      var attr = c.isPrimaryLinkHref ? 'href' : c.attribute;
      return {
        name: assignFieldName(c, usedNames, isFirstText),
        relativeSelector: c.relativeSelector,
        attribute: attr,
        coverage: c.coverage,
        // V1 AUTO DETECTION IMPROVEMENT spec #5: how much this field's
        // value actually varies across sampled rows (1.0 = every row
        // different, near-0 = essentially the same value everywhere) —
        // informational + used by popup.js to decide default-checked
        // preselection, never fed back into extraction itself.
        uniqueness: c.uniqueness,
        confidence: scoreToConfidence(Math.round(c.coverage * 100)),
        samples: c.samples,
        // V1.17 #6: informational field-type metadata only — never fed
        // back into extraction/selector generation, never alters samples.
        fieldType: attr === 'text' ? Sel.detectFieldType(c.samples) : (attr === 'href' ? 'url' : (attr === 'src' ? 'image' : 'text')),
        // V1.17 #12: selector quality — purely informational.
        quality: Sel.scoreSelectorQuality(c.relativeSelector)
      };
    });

    return fields;
  }

  // =====================================================================
  // Step 4: labeling
  // =====================================================================

  function describeStructure(candidate, fields) {
    var tag = candidate.tag;
    if (tag === 'TR') return 'Table Rows';
    if (tag === 'LI') return 'List Items';
    var hasImage = fields.some(function (f) { return f.attribute === 'src'; });
    var hasPrice = fields.some(function (f) { return f.name === 'Price'; });
    if (hasImage && hasPrice) return 'Product Cards';
    if (hasImage) return 'Cards';
    return 'Repeating Items';
  }

  // =====================================================================
  // Table-specific handling (thead -> header names, tbody tr -> rows)
  // =====================================================================

  // V1.17 #10: a colspan-aware "virtual row" — each real <td>/<th> is
  // repeated colSpan times so a positional column INDEX stays aligned
  // with the header across rows that use colspan (e.g. a summary row
  // with one wide cell shouldn't shift every later column's index).
  // rowSpan (a cell spanning DOWN into later rows) is a KNOWN, documented
  // limitation — it is not carried forward into subsequent rows, since
  // doing so correctly requires tracking per-column spans across the
  // whole table and materially raises the risk of Auto Detect itself
  // getting confused on a genuinely malformed table (spec's explicit
  // "do not allow malformed tables to crash Auto Detect" matters more
  // than perfect rowspan fidelity here) — a rowspan'd column simply shows
  // blank on the rows it doesn't literally have a cell for, same as any
  // other missing-cell case already handled below.
  function flattenRowCells(rowEl) {
    var out = [];
    Array.prototype.forEach.call(rowEl.children, function (cell) {
      var span = parseInt(cell.getAttribute && cell.getAttribute('colspan'), 10);
      var count = (span > 0 && span < 100) ? span : 1; // sanity cap against a malformed huge colspan value
      for (var i = 0; i < count; i++) out.push(cell);
    });
    return out;
  }

  function buildTableFieldsForRowGroup(headerCells, rowsArr) {
    var firstRowFlat = flattenRowCells(rowsArr[0]);
    var firstRowCellCount = firstRowFlat.length;
    var fields = [];
    var usedNames = {};

    for (var i = 0; i < firstRowCellCount; i++) {
      var headerText = headerCells[i] ? normText(headerCells[i].textContent) : '';
      var cellEl = firstRowFlat[i];
      if (!cellEl) continue;
      var linkInCell = cellEl.querySelector('a[href]');
      var relSelector = Sel.buildRelativeSelector(rowsArr[0], cellEl);
      if (!relSelector) continue;

      var samples = [];
      var nonEmpty = 0;
      var sampleN = Math.min(rowsArr.length, COVERAGE_SAMPLE_SIZE);
      for (var r = 0; r < sampleN; r++) {
        var rowFlat = flattenRowCells(rowsArr[r]);
        var cell = rowFlat[i];
        var val = cell ? normText(cell.textContent) : '';
        if (val) { nonEmpty++; if (samples.length < 8) samples.push(val); }
      }
      // Only trust the <thead> label for the row-group whose cell count
      // actually matches the header's — a differently-shaped row group in
      // the same physical <table> (e.g. a "subtext" row in an old-style
      // layout table) has no real relationship to that header.
      var name = (headerCells.length === firstRowCellCount && headerText) ? headerText : ('Column ' + (i + 1));
      var base = name; var n = 2;
      while (usedNames[name]) { name = base + ' ' + n; n++; }
      usedNames[name] = true;

      var coverage = sampleN ? nonEmpty / sampleN : 0;
      fields.push({
        name: name, relativeSelector: relSelector, attribute: 'text',
        coverage: coverage, confidence: scoreToConfidence(Math.round(coverage * 100)), samples: samples,
        fieldType: Sel.detectFieldType(samples), quality: Sel.scoreSelectorQuality(relSelector)
      });

      if (linkInCell) {
        var linkRel = Sel.buildRelativeSelector(rowsArr[0], linkInCell);
        if (linkRel) {
          var linkName = name + ' Link';
          var lb = linkName; var ln = 2;
          while (usedNames[linkName]) { linkName = lb + ' ' + ln; ln++; }
          usedNames[linkName] = true;
          fields.push({ name: linkName, relativeSelector: linkRel, attribute: 'href', coverage: coverage, confidence: scoreToConfidence(Math.round(coverage * 100)), samples: [], fieldType: 'url', quality: Sel.scoreSelectorQuality(linkRel) });
        }
      }
    }
    return fields;
  }

  /**
   * Tables get their rows grouped by structural signature — same as any
   * other repeating candidate — rather than assuming every <tr> in a
   * <table> plays the same role. This matters for old-style, non-semantic
   * "whole page is one big <table>" layouts (still found in the wild)
   * that interleave header/nav rows, real data rows, and spacer rows in
   * a single physical table; grouping lets the real data rows separate
   * out and be scored on their own merits instead of being averaged
   * together with layout noise.
   */
  function detectTableStructures() {
    var structures = [];
    var tables = document.querySelectorAll('table');
    Array.prototype.forEach.call(tables, function (table) {
      var bodyRows = Array.prototype.filter.call(table.rows, function (tr) { return !tr.closest('thead'); });
      if (bodyRows.length < 2) return;

      var groups = {};
      bodyRows.forEach(function (tr) {
        var sig = childSignature(tr);
        (groups[sig] || (groups[sig] = [])).push(tr);
      });

      var headerCells = table.querySelectorAll('thead th, thead td');

      Object.keys(groups).forEach(function (sig) {
        var rowsArr = groups[sig];
        if (rowsArr.length < 2) return;
        var fields = buildTableFieldsForRowGroup(headerCells, rowsArr);
        if (!fields.length) return;

        // Score like any other candidate (content/links/consistency), plus
        // a bonus when this group makes up most of the table's rows — a
        // strong signal it's the table's actual data, not incidental rows.
        var baseScore = scoreCandidate({ elements: rowsArr, tag: 'TR' });
        var coverageOfTable = rowsArr.length / bodyRows.length;
        var score = Math.min(100, baseScore + (coverageOfTable >= 0.6 ? 15 : 0));

        structures.push({
          label: 'Table Rows',
          itemCount: rowsArr.length,
          // Same exact-count requirement as the main candidate path below
          // — a table row selector built from just tag+classes could
          // otherwise match rows in a DIFFERENT table on the page that
          // happens to share the same markup pattern.
          containerSelector: Sel.buildContainerSelector(rowsArr[0], rowsArr.length, rowsArr),
          score: score,
          confidence: scoreToConfidence(score),
          fields: fields.slice(0, MAX_FIELDS_PER_STRUCTURE)
        });
      });
    });
    return structures;
  }

  // =====================================================================
  // Orchestration
  // =====================================================================

  /**
   * REAL AMAZON EVIDENCE mission (TASK 2/4 — "row cohesion"): the real
   * persisted scraper config proved Title and Price were each
   * individually "detected" with SOME nonzero coverage
   * (buildFieldCandidate's own coverage check only ever requires
   * coverage > 0), but on almost entirely DISJOINT subsets of the
   * candidate's own matched instances — Title resolved on the instances
   * that happen to be title-rows, Price on the instances that happen to
   * be price-rows, never together on the same instance. No existing
   * check ever verified that the fields a candidate proposes actually
   * belong to the SAME repeated record.
   *
   * For a representative, evenly-spread sample of the candidate's own
   * instances (never just the first few — see sampleEvenly's own
   * comment for why), resolves every detected field against EACH
   * instance and counts how many of that instance's fields resolved to
   * a real value SIMULTANEOUSLY. `completeRatio` — the fraction of
   * instances where MOST detected fields (>= a generous 60%, since a
   * genuinely optional field like a badge or a secondary image
   * legitimately does not appear on every card) are present together —
   * is the row-cohesion signal fed back into scoring below. A candidate
   * with only one detected field is trivially 100% cohesive by
   * construction (there is nothing to co-occur with) and is left alone
   * — this only ever penalizes a MULTI-field candidate whose own fields
   * don't actually belong together.
   */
  function computeRowCohesion(fields, allInstances) {
    if (!fields || fields.length <= 1) {
      return { completeRatio: 1, partialRatio: 0, emptyRatio: 0, sampleSize: 0, fieldCount: fields ? fields.length : 0 };
    }
    var sampleSize = Math.min(allInstances.length, COVERAGE_SAMPLE_SIZE);
    var sample = sampleEvenly(allInstances, sampleSize);
    var completeCount = 0, partialCount = 0, emptyCount = 0;
    sample.forEach(function (inst) {
      var present = 0;
      fields.forEach(function (f) {
        var el = f.relativeSelector === ':scope' ? inst : Sel.queryFromScope(inst, f.relativeSelector);
        var val = Sel.extractValue(el, f.attribute, inst);
        if (val) present++;
      });
      var ratio = present / fields.length;
      if (ratio >= 0.6) completeCount++;
      else if (ratio > 0) partialCount++;
      else emptyCount++;
    });
    var n = sample.length || 1;
    return {
      completeRatio: completeCount / n, partialRatio: partialCount / n, emptyRatio: emptyCount / n,
      sampleSize: sample.length, fieldCount: fields.length
    };
  }

  function runAutoDetect() {
    var t0 = Date.now();
    var tableStructures = detectTableStructures();

    var scan = findCandidateGroups();
    var scored = scan.groups.map(function (g) {
      return Object.assign({}, g, { score: scoreCandidate(g) });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    scored = dedupeCandidates(scored);
    // Skip groups whose representative element is itself inside a <table>
    // (already covered, more precisely, by detectTableStructures above).
    scored = scored.filter(function (c) { return !c.elements[0].closest || !c.elements[0].closest('table'); });
    scored = scored.slice(0, MAX_CANDIDATES);

    // ROW/CONTAINER OVER-COUNTING FIX — second, independent layer of
    // defense (the first is consolidateFragmentedGroups above, which
    // prevents the wrong candidate from ever crowding out the right one
    // in scoring): even a correctly-scored, correctly-chosen candidate's
    // own containerSelector is only ever a BUILT APPROXIMATION
    // (buildContainerSelector, content/selector.js) — if the DOM offers
    // no selector that reproduces this candidate's own detected count
    // exactly, that function's own documented fallback tier accepts the
    // best available approximation rather than nothing (see its own
    // header comment), which can still occasionally drift wide of the
    // originally-detected scope. Rejecting a candidate whose FINAL,
    // real, page-wide selector match count blows past a generous
    // multiple of what was actually detected locally is the same
    // invariant this whole fix is built on: one detected record should
    // produce one row, not several — never Amazon-specific, this simply
    // refuses to ship a selector that provably doesn't mean what it was
    // detected to mean.
    var MAX_SELECTOR_SCOPE_DRIFT = 3;

    // PART A REBUILD (REAL AMAZON EVIDENCE mission, round 3) — HARD
    // INVARIANT, not a score penalty: "A candidate with ZERO rows
    // containing both Title and Price must be impossible to select when
    // both fields are selected." A multi-field candidate whose own
    // fields co-occur on fewer than this fraction of sampled instances
    // is REJECTED OUTRIGHT — never added to `structures`, regardless of
    // how strong its other signals look. A single-field candidate (only
    // one thing detected — nothing to co-occur with) is exempt by
    // definition, same as computeRowCohesion's own completeRatio===1
    // default for that case.
    var MIN_COHESION_RATIO = 0.3;

    var structures = [];
    var cohesionRejectedCount = 0;
    for (var i = 0; i < scored.length; i++) {
      if (Date.now() - t0 > MAX_TIME_MS) break;
      var candidate = scored[i];
      var fields = detectFields(candidate.elements[0], candidate.elements);
      if (!fields.length) continue;

      var cohesion = computeRowCohesion(fields, candidate.elements);
      if (fields.length >= 2 && cohesion.completeRatio < MIN_COHESION_RATIO) {
        cohesionRejectedCount++;
        continue; // HARD GATE — this candidate can never become a structure, at any score
      }

      // expectedCount: require the built selector to reproduce EXACTLY
      // this candidate's own grouped element count, not just "at least a
      // couple of matches somewhere in the document" — otherwise a
      // same-class element that findCandidateGroups() correctly excluded
      // (different structural position — e.g. a promotional card reusing
      // the same product-card class) can still get pulled back in by a
      // too-broad selector when Extract Data re-queries the page later.
      //
      // REAL AMAZON EVIDENCE mission — real, previously-hidden bug found
      // via a test-infrastructure fix: siblingEls (3rd arg) was never
      // passed here, so Sel.commonStableClasses() could never compute
      // the classes actually COMMON to every instance — it silently fell
      // back to the REPRESENTATIVE element's own full class list
      // unfiltered. A representative that happens to carry an EXTRA
      // per-instance class no other sibling has (a real, common shape —
      // a "sponsored"/"best-match"/badge variant class on SOME cards,
      // same real pattern already documented elsewhere in this file)
      // produced a selector scoped to only that one variant instead of
      // every instance. Passing candidate.elements lets
      // commonStableClasses do its own job correctly.
      var containerSelector = Sel.buildContainerSelector(candidate.elements[0], candidate.elements.length, candidate.elements);
      var realMatchCount = Sel.countMatches(containerSelector);
      if (realMatchCount > candidate.elements.length * MAX_SELECTOR_SCOPE_DRIFT) continue;
      if (realMatchCount < candidate.elements.length) continue; // under-matching is just as wrong as over-matching — never ship a selector that provably misses instances this candidate itself already found
      structures.push({
        label: describeStructure(candidate, fields),
        // Honest, real count (mission's own "preview row count should be
        // sane" requirement) — the ACTUAL number of elements
        // containerSelector will really match at extraction time, not
        // the pre-selector-building candidate.elements.length guess,
        // which can legitimately differ once buildContainerSelector's
        // own scoping/fallback logic runs.
        itemCount: realMatchCount,
        containerSelector: containerSelector,
        score: candidate.score,
        confidence: scoreToConfidence(candidate.score),
        rowCohesion: cohesion,
        fields: fields
      });
    }

    structures = tableStructures.concat(structures);
    structures.sort(function (a, b) { return b.score - a.score; });

    // PART A REBUILD — FAIL SAFE: "If no candidate satisfies it, Auto
    // Detect must FAIL SAFE and tell the user it could not determine the
    // repeating row structure instead of producing garbage rows." Only
    // fires when candidates genuinely existed and were rejected
    // specifically by the cohesion gate (never for an ordinary "empty
    // page" / "nothing found at all" case, which already reports
    // ok:false with structures:[] on its own).
    var failSafe = (structures.length === 0 && cohesionRejectedCount > 0);

    return {
      ok: structures.length > 0,
      structures: structures,
      scannedTruncated: scan.truncated,
      elapsedMs: Date.now() - t0,
      cohesionRejectedCount: cohesionRejectedCount,
      failSafe: failSafe,
      failSafeReason: failSafe
        ? 'Could not determine a reliable repeating row structure: the candidates found never contained the selected fields together in the same record. Try Manual Mode (click each field directly) instead.'
        : null
    };
  }

  // =====================================================================
  // V1 AUTO DETECTION DIAGNOSTICS (DEV-ONLY) — this section adds NO new
  // behavior to normal AUTO detection. runAutoDetectDiagnostic() below
  // calls the EXACT SAME functions runAutoDetect() calls
  // (findCandidateGroups/scoreCandidate/dedupeCandidates/detectFields/
  // detectTableStructures/describeStructure/scoreToConfidence — every one
  // of them untouched by this section), in the same order, with the same
  // constants — it just also records what happened at each step instead
  // of discarding that information. runAutoDetect() itself is completely
  // unmodified (it is NOT called by this function, and this function is
  // NOT called by anything except the new dev-only RUN_AUTO_DETECT_
  // DIAGNOSTIC message handled below). Only reachable at all from a
  // popup control gated behind WSLicense.isDevelopmentInstall() — see
  // popup.js's handleCopyAutoDiagnostic() and popup.html's
  // #auto-diag-panel (hidden unless isDevelopmentInstall() resolves
  // true) — never present in a packaged/Chrome-Web-Store build.
  // =====================================================================

  function safeSelector(el, siblingEls) {
    try { return Sel.buildContainerSelector(el, siblingEls && siblingEls.length, siblingEls) || '(no selector)'; } catch (e) { return '(selector build failed: ' + (e && e.message || e) + ')'; }
  }

  function shortElementPath(el) {
    if (!el) return '(none)';
    var tag = el.tagName ? el.tagName.toLowerCase() : '?';
    var id = el.id ? '#' + el.id : '';
    var classes = Sel.getStableClasses(el);
    var classStr = classes.length ? '.' + classes.join('.') : '';
    return tag + id + classStr;
  }

  /** Compact, human-and-JSON-readable summary of one scored raw candidate
   * — reused for every candidate list in the report (before-ranking,
   * after-ranking, rejected) so the shape is consistent throughout. */
  function summarizeRawCandidate(c) {
    var signals = computeCandidateSignals(c);
    return {
      candidateId: c._rawIndex,
      tag: c.tag,
      representativeElementPath: shortElementPath(c.elements[0]),
      allStableClassesOnRepresentative: Sel.getStableClasses(c.elements[0]),
      approxSelector: safeSelector(c.elements[0], c.elements),
      itemCount: c.elements.length,
      score: signals.score,
      confidence: scoreToConfidence(signals.score),
      avgTextLen: Math.round(signals.avgTextLen * 10) / 10,
      hasLinks: signals.hasLinkRatio > 0,
      hasImages: signals.hasImageRatio > 0,
      hasPriceLikeValues: signals.priceLikeRatio > 0,
      hasHeadingLikeTitle: signals.titleLikeRatio > 0,
      linkPresenceRatio: round2(signals.hasLinkRatio),
      imagePresenceRatio: round2(signals.hasImageRatio),
      priceLikeRatio: round2(signals.priceLikeRatio),
      titleLikeRatio: round2(signals.titleLikeRatio),
      linkDiversityRatio: round2(signals.linkDiversityRatio),
      textConsistency: round2(signals.consistency),
      navigationPenaltyApplied: signals.navPenalty,
      navigationPenaltyKind: signals.navMatchKind, // 'none' | 'keyword' (-12) | 'semantic' (-30)
      mainContentBonusApplied: signals.mainBonus,
      nearEmptyPenaltyApplied: signals.nearEmptyPenalty,
      specificationPanelPenaltyApplied: signals.looksLikeAttributeList,
      strongProductSignatureBonusApplied: signals.strongProductSignature,
      // REAL AMAZON EVIDENCE mission — see the fragmentationPenalty
      // comment in computeCandidateSignals for the full mechanism. null
      // when this candidate was never consolidated (the normal case).
      consolidatedFromParentCount: (typeof c.consolidatedFromParentCount === 'number') ? c.consolidatedFromParentCount : null,
      elementsPerParent: signals.elementsPerParent,
      fragmentationPenaltyApplied: signals.fragmentationPenalty
    };
  }

  function round2(n) { return Math.round((n || 0) * 100) / 100; }

  /** Explains, in plain words, which pipeline stage removed a raw
   * candidate that did NOT make it into the final structures — spec #8's
   * "MOST IMPORTANT" requirement. Checks membership at each successive
   * stage, in the exact order runAutoDetect() itself applies them. */
  function computeRejectionReason(candidate, afterSort, afterDedup, afterTableFilter, afterSlice, survivedRawIndexes, timeBudgetExceeded, cohesionRejectedRawIndexes, scopeDriftRejectedRawIndexes, noFieldsRawIndexes) {
    var idx = candidate._rawIndex;
    var inDedup = afterDedup.some(function (c) { return c._rawIndex === idx; });
    if (!inDedup) return 'duplicate candidate — overlapped a higher-scored candidate of similar size (same or an ancestor/descendant element, item counts within 2 of each other)';
    var inTableFilter = afterTableFilter.some(function (c) { return c._rawIndex === idx; });
    if (!inTableFilter) return 'inside a <table> element — covered separately by table-row detection (detectTableStructures), not the general repeating-group scan';
    var inSlice = afterSlice.some(function (c) { return c._rawIndex === idx; });
    if (!inSlice) return 'below the top-' + MAX_CANDIDATES + ' cutoff (MAX_CANDIDATES) after ranking — ' + afterTableFilter.length + ' candidates survived to this point, only the top ' + MAX_CANDIDATES + ' by score are fully analyzed';
    if (survivedRawIndexes[idx]) return '(not actually rejected — included in final structures)';
    if (timeBudgetExceeded) return 'scan time budget (MAX_TIME_MS=' + MAX_TIME_MS + 'ms) was exceeded before this candidate was reached';
    if (noFieldsRawIndexes && noFieldsRawIndexes[idx]) return 'no usable fields could be extracted from this structure (detectFields returned 0 fields)';
    // PART A REBUILD — the HARD co-occurrence gate: 2+ selected fields
    // were detected, but they co-occurred together on too few of this
    // candidate's own sampled instances (see rowCohesion on the raw
    // candidate summary above for the exact ratio) — REJECTED OUTRIGHT,
    // never merely down-scored.
    if (cohesionRejectedRawIndexes && cohesionRejectedRawIndexes[idx]) return 'REJECTED by the hard row-cohesion invariant — its own detected fields (2+) co-occur on too few of its own sampled instances to represent one logical record together (see rowCohesion above)';
    if (scopeDriftRejectedRawIndexes && scopeDriftRejectedRawIndexes[idx]) return 'this candidate\'s own built containerSelector matched far more elements page-wide than were actually detected locally (selector-scope drift) — rejected rather than shipping a selector that provably doesn\'t mean what it was detected to mean';
    return 'no usable fields could be extracted from this structure (detectFields returned 0 fields)';
  }

  /** DEV-ONLY diagnostic pass — mirrors runAutoDetect()'s exact stage
   * order (see that function immediately above) so the report reflects
   * the REAL pipeline, but keeps every intermediate candidate and adds
   * bookkeeping (why each non-surviving raw candidate was dropped, at
   * which stage) instead of discarding it. Answers every numbered item
   * in the V1 AUTO DETECTION DIAGNOSTICS spec. */
  function runAutoDetectDiagnostic() {
    var t0 = Date.now();
    var report = {
      generatedAt: new Date().toISOString(),
      url: location.href,
      documentReadyState: document.readyState,
      totalDomElements: document.querySelectorAll('*').length,
      constants: { MAX_SCAN_ELEMENTS: MAX_SCAN_ELEMENTS, MAX_CANDIDATES: MAX_CANDIDATES, MAX_TIME_MS: MAX_TIME_MS, MAX_FIELDS_PER_STRUCTURE: MAX_FIELDS_PER_STRUCTURE }
    };

    var genStart = Date.now();
    var tableStructures = detectTableStructures();
    var scan = findCandidateGroups();
    report.candidateGenerationDurationMs = Date.now() - genStart;
    report.scannedElements = scan.scannedCount;
    report.scannedTruncated = scan.truncated;
    report.rawCandidateGroupCount = scan.groups.length;
    // ROW/CONTAINER OVER-COUNTING FIX diagnostics (mission's own explicit
    // requirement — "candidate repeating container / matched element
    // count / accepted logical row count / rejected non-product/non-row
    // count"): how many per-parent groups existed before/after
    // consolidateFragmentedGroups folded same-signature fragments (an
    // internal layout row repeated many times inside each outer record)
    // together.
    report.rawGroupCountBeforeConsolidation = scan.rawGroupCountBeforeConsolidation;
    report.groupCountAfterConsolidation = scan.groupCountAfterConsolidation;
    report.fragmentGroupsConsolidated = (scan.rawGroupCountBeforeConsolidation || 0) - (scan.groupCountAfterConsolidation || 0);
    // REAL AMAZON EVIDENCE mission (TASK 3) diagnostics: how many extra
    // candidates were discovered by climbing from a heading via
    // Sel.findRepeatingContainer rather than class-sharing.
    report.anchoredCandidateCount = scan.anchoredCandidateCount || 0;
    // PART A REBUILD diagnostics: how many extra candidates were
    // discovered via the NEW field-anchored (title+price common-ancestor)
    // method — the PRIMARY multi-field discovery method this round.
    report.fieldAnchoredCandidateCount = scan.fieldAnchoredCandidateCount || 0;

    var scored = scan.groups.map(function (g, idx) {
      return Object.assign({}, g, { score: scoreCandidate(g), _rawIndex: idx });
    });
    // "TOP candidates BEFORE final ranking" (spec #9) — scored, but
    // before dedup/table-filter/top-N-cutoff are applied.
    var beforeRanking = scored.slice().sort(function (a, b) { return b.score - a.score; });
    report.topCandidatesBeforeRanking = beforeRanking.slice(0, 10).map(summarizeRawCandidate);

    var rankStart = Date.now();
    var sorted = scored.slice().sort(function (a, b) { return b.score - a.score; });
    var deduped = dedupeCandidates(sorted);
    var tableFiltered = deduped.filter(function (c) { return !c.elements[0].closest || !c.elements[0].closest('table'); });
    var sliced = tableFiltered.slice(0, MAX_CANDIDATES);
    report.rankingDurationMs = Date.now() - rankStart;
    report.candidateCountAfterDedup = deduped.length;
    report.candidateCountAfterTableFilter = tableFiltered.length;
    report.candidateCountAfterTopNCutoff = sliced.length;

    var timeBudgetExceeded = false;
    var finalStructures = [];
    var survivedRawIndexes = {};
    var scopeDriftRejectedCount = 0;
    var scopeDriftRejectedRawIndexes = {};
    var cohesionRejectedCount = 0;
    var cohesionRejectedRawIndexes = {};
    var noFieldsRawIndexes = {};
    var MIN_COHESION_RATIO = 0.3;
    for (var i = 0; i < sliced.length; i++) {
      if (Date.now() - t0 > MAX_TIME_MS) { timeBudgetExceeded = true; break; }
      var candidate = sliced[i];
      var fields = detectFields(candidate.elements[0], candidate.elements);
      if (!fields.length) { noFieldsRawIndexes[candidate._rawIndex] = true; continue; }
      // PART A REBUILD diagnostics — same HARD GATE runAutoDetect() itself
      // applies (see that function's own comment for the full mechanism),
      // so this diagnostic's accept/reject decision always matches real
      // production behavior exactly, never a softer approximation.
      var diagCohesion = computeRowCohesion(fields, candidate.elements);
      if (fields.length >= 2 && diagCohesion.completeRatio < MIN_COHESION_RATIO) {
        cohesionRejectedCount++;
        cohesionRejectedRawIndexes[candidate._rawIndex] = true;
        continue;
      }
      var diagSelector = safeSelector(candidate.elements[0], candidate.elements);
      var diagRealMatchCount = Sel.countMatches(diagSelector);
      if (diagRealMatchCount > candidate.elements.length * 3 || diagRealMatchCount < candidate.elements.length) { scopeDriftRejectedCount++; scopeDriftRejectedRawIndexes[candidate._rawIndex] = true; continue; }
      survivedRawIndexes[candidate._rawIndex] = true;
      finalStructures.push({
        candidateId: candidate._rawIndex,
        label: describeStructure(candidate, fields),
        // itemCount stays the raw candidate.elements.length here (matches
        // this diagnostic's own established pre-existing shape/callers);
        // matchedElementCount is the NEW, honest "what will this selector
        // actually match at real extraction time" figure the mission's
        // own diagnostics requirement asks for.
        itemCount: candidate.elements.length,
        matchedElementCount: diagRealMatchCount,
        containerSelector: diagSelector,
        representativeElementPath: shortElementPath(candidate.elements[0]),
        anchoredFromHeading: !!candidate.anchoredFromHeading,
        fieldAnchored: !!candidate.fieldAnchored,
        rowCohesion: { completeRatio: round2(diagCohesion.completeRatio), partialRatio: round2(diagCohesion.partialRatio), emptyRatio: round2(diagCohesion.emptyRatio), sampleSize: diagCohesion.sampleSize, fieldCount: diagCohesion.fieldCount },
        score: candidate.score,
        confidence: scoreToConfidence(candidate.score),
        fieldCount: fields.length,
        sampleFieldNames: fields.map(function (f) { return f.name; }),
        fields: fields.map(function (f) {
          return { name: f.name, attribute: f.attribute, coverage: round2(f.coverage), uniqueness: typeof f.uniqueness === 'number' ? round2(f.uniqueness) : null, confidence: f.confidence, sample: (f.samples && f.samples[0]) || '' };
        })
      });
    }
    report.timeBudgetExceededDuringFieldDetection = timeBudgetExceeded;
    // "rejected non-product/non-row count" (mission's own explicit
    // diagnostics requirement) — candidates that survived every earlier
    // stage (scoring/dedup/table-filter/top-N-cutoff/field-detection)
    // but were still rejected here because their own built selector's
    // REAL match count blew past a generous multiple of what was
    // actually detected locally (content/autodetect.js's runAutoDetect()
    // applies the exact same rejection, unmodified — this diagnostic
    // just also counts it).
    report.scopeDriftRejectedCount = scopeDriftRejectedCount;
    // PART A REBUILD diagnostics — how many candidates hit the HARD
    // co-occurrence gate (2+ fields detected, but rarely/never together).
    report.cohesionRejectedCount = cohesionRejectedCount;
    report.failSafe = (finalStructures.length === 0 && tableStructures.length === 0 && cohesionRejectedCount > 0);

    var tableStructureSummaries = tableStructures.map(function (s) {
      return { source: 'table', label: s.label, itemCount: s.itemCount, containerSelector: s.containerSelector, score: s.score, confidence: s.confidence, fieldCount: s.fields.length, sampleFieldNames: s.fields.map(function (f) { return f.name; }) };
    });
    var allFinal = tableStructureSummaries.concat(finalStructures.map(function (s) {
      return Object.assign({ source: 'repeating-group' }, s);
    })).sort(function (a, b) { return b.score - a.score; });

    report.finalStructureCount = allFinal.length;
    // "TOP candidates AFTER final ranking" (spec #9) + "why the final
    // dataset won" (spec #10).
    report.topCandidatesAfterRanking = allFinal.slice(0, 10);
    report.winner = allFinal.length ? allFinal[0] : null;
    if (report.winner) {
      var w = report.winner;
      report.winnerReason = 'Highest score (' + w.score + ') among ' + allFinal.length + ' structure(s) that survived candidate generation, scoring, dedup, table-filtering, the top-' + MAX_CANDIDATES + ' cutoff, and field detection. ' +
        (w.source === 'table' ? 'Detected via table-row grouping (detectTableStructures), not the general repeating-group scan.' : 'Detected via the general repeating-group scan.');
    } else {
      report.winnerReason = 'No structure survived the full pipeline (see rejectedCandidates below for what was found and why each was dropped).';
    }

    // spec #11: "whether anything resembling the real product-card
    // collection was ever seen" — scan ALL raw candidates (including
    // ones that never made it past dedup/table-filter/cutoff/fields) for
    // link+image+price signals together, regardless of final outcome.
    report.rawCandidatesWithProductLikeSignals = beforeRanking
      .filter(function (c) {
        var s = computeCandidateSignals(c);
        return s.hasLinkRatio > 0 && s.hasImageRatio > 0 && s.priceLikeRatio > 0;
      })
      .map(function (c) {
        var summary = summarizeRawCandidate(c);
        summary.survivedToFinalStructures = !!survivedRawIndexes[c._rawIndex];
        return summary;
      });

    // spec #8/#12: full rejection accounting, largest/most-interesting
    // (by item count) first, capped to keep the report pasteable.
    var rejected = beforeRanking.filter(function (c) { return !survivedRawIndexes[c._rawIndex]; });
    rejected.sort(function (a, b) { return b.elements.length - a.elements.length; });
    report.rejectedCandidateCount = rejected.length;
    report.rejectedCandidates = rejected.slice(0, 40).map(function (c) {
      var summary = summarizeRawCandidate(c);
      summary.rejectionReason = computeRejectionReason(c, sorted, deduped, tableFiltered, sliced, survivedRawIndexes, timeBudgetExceeded, cohesionRejectedRawIndexes, scopeDriftRejectedRawIndexes, noFieldsRawIndexes);
      return summary;
    });
    if (rejected.length > 40) report.rejectedCandidatesNoteTruncated = (rejected.length - 40) + ' additional rejected candidate(s) not shown (capped at 40, largest-by-item-count first).';

    report.totalDurationMs = Date.now() - t0;
    return report;
  }

  // =====================================================================
  // V1.19 — Pagination Auto-Detect: a conservative, DOM-only heuristic
  // that SUGGESTS a Next-button or Load-More candidate (plus, separately,
  // a URL-pattern guess via WSRunState.detectUrlPaginationPattern) —
  // never starts navigation itself. The popup shows whatever comes back
  // as "Detected: ..." with an explicit user action (Use Detected /
  // Pick Manually) still required before any run can start — spec #2's
  // "Never automatically start navigation just because a candidate
  // exists" / "If detection is ambiguous: use Current Page safely."
  // =====================================================================

  var PAGINATION_NEXT_TEXT_RE = /^(next|next page|»|›|>>|>)$/i;
  var PAGINATION_LOAD_MORE_TEXT_RE = /^(load more|show more|more results|view more|see more|load more results)$/i;

  function paginationNormText(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function paginationIsVisible(el) {
    var style = window.getComputedStyle(el);
    return !!(style && style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) !== 0);
  }

  function paginationCandidateFromElement(el, kind, reason) {
    var selector = Sel.buildSelectorForElement(el);
    if (!selector) return null;
    return {
      kind: kind, // 'next-button' | 'load-more'
      reason: reason,
      relativeSelector: selector,
      matchCount: Sel.countMatches(selector),
      disabled: !!(el.disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true'),
      previewText: paginationNormText(el).slice(0, 60)
    };
  }

  /** Highest-confidence signals first (explicit semantics beat guessed
   * text): rel="next" > aria-label mentioning "next" > a link/button
   * whose own visible text matches a well-known "Next" label. */
  function detectNextButtonCandidate() {
    var relNext = document.querySelector('a[rel~="next"]');
    if (relNext && paginationIsVisible(relNext)) {
      var c1 = paginationCandidateFromElement(relNext, 'next-button', 'rel="next" link');
      if (c1) return c1;
    }
    var ariaNext = document.querySelector('a[aria-label*="next" i], button[aria-label*="next" i]');
    if (ariaNext && paginationIsVisible(ariaNext)) {
      var c2 = paginationCandidateFromElement(ariaNext, 'next-button', 'aria-label mentions "next"');
      if (c2) return c2;
    }
    var controls = document.querySelectorAll('a, button');
    for (var i = 0; i < controls.length; i++) {
      var el = controls[i];
      if (!paginationIsVisible(el)) continue;
      if (PAGINATION_NEXT_TEXT_RE.test(paginationNormText(el))) {
        var c3 = paginationCandidateFromElement(el, 'next-button', 'visible text matches a common "Next" label');
        if (c3) return c3;
      }
    }
    return null;
  }

  function detectLoadMoreCandidate() {
    var controls = document.querySelectorAll('a, button');
    for (var i = 0; i < controls.length; i++) {
      var el = controls[i];
      if (!paginationIsVisible(el)) continue;
      if (PAGINATION_LOAD_MORE_TEXT_RE.test(paginationNormText(el))) {
        var c = paginationCandidateFromElement(el, 'load-more', 'visible text matches a common "Load More" label');
        if (c) return c;
      }
    }
    return null;
  }

  /** Returns exactly one top-level suggestion (never both a Next-button
   * AND a Load-More guess at once — that would just be confusing) plus,
   * independently, a URL-pattern guess (a page can legitimately have
   * both a Next link AND a ?page= URL — the caller/UI decides which
   * method to actually offer). `detected` is null when nothing
   * reasonably conclusive was found, matching spec #2's safe-ambiguous-
   * fallback requirement. */
  function detectPaginationCandidate() {
    var t0 = Date.now();
    var urlPattern = (root.WSRunState && root.WSRunState.detectUrlPaginationPattern)
      ? root.WSRunState.detectUrlPaginationPattern(location.href)
      : { found: false };

    var nextBtn = detectNextButtonCandidate();
    if (nextBtn) {
      return { ok: true, detected: 'pagination', candidate: nextBtn, urlPattern: urlPattern.found ? urlPattern : null, elapsedMs: Date.now() - t0 };
    }
    var loadMore = detectLoadMoreCandidate();
    if (loadMore) {
      return { ok: true, detected: 'load-more', candidate: loadMore, urlPattern: urlPattern.found ? urlPattern : null, elapsedMs: Date.now() - t0 };
    }
    if (urlPattern.found && urlPattern.confidence === 'high') {
      return { ok: true, detected: 'pagination', candidate: null, urlPattern: urlPattern, elapsedMs: Date.now() - t0 };
    }
    return { ok: true, detected: null, candidate: null, urlPattern: urlPattern.found ? urlPattern : null, elapsedMs: Date.now() - t0 };
  }

  // =====================================================================
  // V1 AUTO RESULT CLEANUP — row-quality classification for an
  // ALREADY-EXTRACTED AUTO dataset (spec: 60 real product cards + a
  // couple of promotional/utility inserts sharing the same repeating-
  // group structural role, e.g. eBay's "Shop on eBay" card, extracted
  // as extra non-data rows). Deliberately operates on the extracted
  // VALUES (rows) + the column schema (columns) that already exist in
  // memory by the time AUTO's "Extract Data" completes — no DOM
  // re-querying, so there is zero risk of index misalignment with the
  // caller's own row array, and this reuses PRICE_RE/normText already
  // trusted elsewhere in this file rather than a second, potentially-
  // drifting reimplementation. NEVER called from Manual Mode's own
  // extraction path (see popup.js's handleAutoExtract() — the only
  // caller) — content/scraper.js's existing, non-destructive
  // flagAnomalies() (FLAG-only, never excludes, runs for every
  // extraction regardless of mode) is completely untouched by this
  // section.
  // =====================================================================

  function ratio(items, predicate) {
    var applicable = 0, positive = 0;
    items.forEach(function (item) {
      var v = predicate(item);
      if (v === null) return; // not applicable to this item — excluded from the ratio entirely
      applicable++;
      if (v) positive++;
    });
    return applicable ? positive / applicable : 0;
  }

  function median(nums) {
    var sorted = nums.slice().sort(function (a, b) { return a - b; });
    if (!sorted.length) return 0;
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /** Classifies each row of an extracted dataset as 'accept' | 'flag' |
   * 'exclude' using WEIGHTED, dataset-RELATIVE evidence — never a fixed
   * "all fields required" rule, never an English-phrase blocklist (spec
   * #4's explicit requirement). Column ROLES (which column is link-like/
   * image-like/price-like) are inferred STRUCTURALLY from each column's
   * own `attribute` (href/src/structured+structuredKind, or a 'text'
   * column whose VALUES mostly match PRICE_RE) — never from the
   * column's own name/label, so this works identically no matter which
   * of the 6 supported UI languages named the columns. Every "missing
   * field" signal is gated on that field being present in the STRONG
   * MAJORITY of rows first (>=85%) — on a dataset where a field isn't
   * consistently present at all (e.g. an article list with no prices),
   * the corresponding signal simply never fires for anyone (spec #10/
   * #12: dataset-aware, no e-commerce assumptions forced onto non-
   * commerce datasets). */
  function classifyExtractedRows(columns, rows) {
    var n = rows.length;
    if (n < 5 || !columns || !columns.length) {
      return { verdicts: rows.map(function () { return { verdict: 'accept', reasons: [], weight: 0 }; }), dominantShape: null };
    }

    var linkCols = columns.filter(function (c) { return c.attribute === 'href'; });
    var imageCols = columns.filter(function (c) { return c.attribute === 'src' || (c.attribute === 'structured' && c.structuredKind === 'image'); });
    var textCols = columns.filter(function (c) { return c.attribute === 'text' || (c.attribute === 'structured' && c.structuredKind !== 'image'); });

    // Which text column (if any) looks price-like across the MAJORITY
    // of the rows that actually have a value for it?
    var priceCol = textCols.find(function (c) {
      var nonEmpty = rows.filter(function (r) { return r[c.id]; });
      if (nonEmpty.length < n * 0.4) return false; // too sparse to judge either way
      var priceLikeCount = nonEmpty.filter(function (r) { return PRICE_RE.test(String(r[c.id])); }).length;
      return priceLikeCount / nonEmpty.length >= 0.6;
    });
    // The longest-typical text column is treated as the "title-like"
    // column for the (weak, evidence-combining-only) short-text signal —
    // deliberately the column with the greatest median value length,
    // not a name/position assumption.
    var titleCol = textCols.length ? textCols.reduce(function (best, c) {
      var lens = rows.map(function (r) { return r[c.id] ? String(r[c.id]).length : 0; });
      var med = median(lens);
      return (!best || med > best.medianLen) ? { col: c, medianLen: med } : best;
    }, null) : null;

    function presence(row, cols) { return cols.some(function (c) { return !!row[c.id]; }); }
    // V1 AUTO RESULT CLEANUP FOLLOW-UP (real-Chrome retest — the "Shop on
    // eBay" rows were correctly FLAGGED but not EXCLUDED): a promotional
    // card can carry a non-empty, generic value in the slot the majority
    // of rows use for a real price (e.g. a "Free shipping" banner text)
    // — plain non-empty presence was too weak a check. "Has a price"
    // now means the row's OWN value actually matches PRICE_RE, not just
    // that the cell isn't blank.
    function hasRealPrice(row) { return priceCol && row[priceCol.id] && PRICE_RE.test(String(row[priceCol.id])); }

    var linkPresenceRatio = linkCols.length ? ratio(rows, function (r) { return presence(r, linkCols); }) : null;
    var imagePresenceRatio = imageCols.length ? ratio(rows, function (r) { return presence(r, imageCols); }) : null;
    var pricePresenceRatio = priceCol ? ratio(rows, function (r) { return hasRealPrice(r); }) : null;

    var fieldCounts = rows.map(function (r) { return columns.filter(function (c) { return !!r[c.id]; }).length; });
    var medianFieldCount = median(fieldCounts);

    // Duplicate-value detection (spec #8/#9): dataset-INFERRED, not a
    // literal path-word or filename assumption. Only treated as evidence
    // when the majority of OTHER rows' values are each unique — on a
    // dataset where links/images legitimately repeat a lot, neither
    // signal fires for anyone. Applied to BOTH link and image columns —
    // a promotional card reusing one shared generic icon/banner across
    // every occurrence, while every real product has its own distinct
    // photo, is exactly the kind of evidence spec #9 describes.
    function findDuplicateValues(cols) {
      var dup = {};
      if (!cols.length) return dup;
      var counts = {}, total = 0;
      rows.forEach(function (r) { var v = r[cols[0].id]; if (v) { counts[v] = (counts[v] || 0) + 1; total++; } });
      var uniqueCount = Object.keys(counts).length;
      var uniquenessRatio = total ? uniqueCount / total : 1;
      if (uniquenessRatio >= 0.85) {
        Object.keys(counts).forEach(function (v) { if (counts[v] > 1) dup[v] = true; });
      }
      return dup;
    }
    var linkDuplicateValues = findDuplicateValues(linkCols);
    var imageDuplicateValues = findDuplicateValues(imageCols);

    var dominantShape = {
      rowCount: n, linkPresenceRatio: linkPresenceRatio, imagePresenceRatio: imagePresenceRatio,
      pricePresenceRatio: pricePresenceRatio, medianFieldCount: medianFieldCount,
      priceColumnId: priceCol ? priceCol.id : null, titleColumnId: titleCol ? titleCol.col.id : null
    };

    var verdicts = rows.map(function (row) {
      var reasons = [];
      var weight = 0;

      // V1 AUTO RESULT CLEANUP FOLLOW-UP: the "nearly all rows have this
      // field" gate was lowered from 0.85 to 0.75 (a clear supermajority,
      // still nowhere near the "not consistently present" territory a
      // real non-commerce dataset would show — e.g. an article list's
      // price coverage sits at 0%, not somewhere in the 75-85% band).
      // Real, diverse product listings legitimately don't reach 85%+
      // price coverage (auction-format/"Best Offer"/no-price listings
      // mixed in with normal fixed-price ones) — at the stricter 0.85
      // gate, the missing-price signal could fail to activate AT ALL on
      // a realistic page, silently disabling one of the two strongest
      // signals for every row, promotional or not.
      var missingLink = linkCols.length && linkPresenceRatio >= 0.75 && !presence(row, linkCols);
      if (missingLink) { reasons.push('no link where nearly all rows have one'); weight += 2; }
      var missingImage = imageCols.length && imagePresenceRatio >= 0.75 && !presence(row, imageCols);
      if (missingImage) { reasons.push('no image where nearly all rows have one'); weight += 2; }
      var missingPrice = priceCol && pricePresenceRatio >= 0.75 && !hasRealPrice(row);
      if (missingPrice) { reasons.push('no price-like value where nearly all rows have one'); weight += 2; }
      if (linkCols.length && row[linkCols[0].id] && linkDuplicateValues[row[linkCols[0].id]]) { reasons.push('link is shared with another row while most rows link to a unique destination'); weight += 2; }
      if (imageCols.length && row[imageCols[0].id] && imageDuplicateValues[row[imageCols[0].id]]) { reasons.push('image is shared with another row while most rows have a unique image'); weight += 2; }
      // Missing BOTH the image AND the price signal TOGETHER is
      // materially stronger evidence than either alone (spec's own
      // framing: "especially high link + image + price presence" as the
      // strong positive case implies their combined ABSENCE is the
      // strong negative case) — a small combined bonus reflects that
      // without requiring a 3rd, less reliable signal (duplicate value/
      // low field count/short title) to also happen to fire.
      if (missingImage && missingPrice) { reasons.push('missing BOTH image and price together — the strongest combined signal'); weight += 1; }
      var fc = columns.filter(function (c) { return !!row[c.id]; }).length;
      if (medianFieldCount >= 2 && fc <= medianFieldCount * 0.5) { reasons.push('far fewer populated fields than a typical row'); weight += 1; }
      // Deliberately weak (spec #4: "do not delete rows merely because
      // their title is short") — only ever contributes 1 point, never
      // enough on its own to reach the exclude threshold; only tips the
      // balance when combined with other, independent evidence above.
      if (titleCol && titleCol.medianLen >= 20) {
        var val = row[titleCol.col.id];
        var len = val ? String(val).length : 0;
        if (len > 0 && len < titleCol.medianLen * 0.3) { reasons.push('title much shorter than typical for this dataset'); weight += 1; }
      }

      var verdict = weight >= 5 ? 'exclude' : (weight >= 2 ? 'flag' : 'accept');
      return { verdict: verdict, reasons: reasons, weight: weight };
    });

    return { verdicts: verdicts, dominantShape: dominantShape };
  }

  root.WSAutoDetect = {
    runAutoDetect: runAutoDetect,
    detectPaginationCandidate: detectPaginationCandidate,
    classifyExtractedRows: classifyExtractedRows,
    // DEV-ONLY diagnostics (see the section above) — exported the same
    // way as every other function here; reachability from the UI is
    // gated entirely on the popup side (isDevelopmentInstall()), not
    // here. A content script's own onMessage listener can only ever be
    // reached by this same extension's other privileged contexts
    // (background/popup), never by the web page itself, so leaving this
    // registered is not a production exposure — see popup.js/popup.html
    // for the actual dev-only gate and scripts/release-check.js for the
    // static check confirming it.
    runAutoDetectDiagnostic: runAutoDetectDiagnostic
  };

  // Own message listener (mirrors content/pagination.js's pattern) so
  // content.js — and every message type it already owns (PING,
  // START_PICK, RUN_EXTRACTION) — stays completely untouched by V1.4.
  // Guarded so re-injecting this file (e.g. popup's inject-on-demand
  // fallback) never double-registers the listener.
  if (!window.__wsAutoDetectListenerRegistered) {
    window.__wsAutoDetectListenerRegistered = true;
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || !message.type) return;

      if (message.type === 'RUN_AUTO_DETECT') {
        // Detection is synchronous DOM analysis, but still respond async
        // so a slow page doesn't block the message channel from opening.
        setTimeout(function () {
          try {
            sendResponse(runAutoDetect());
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message || e), structures: [] });
          }
        }, 0);
        return true;
      }

      if (message.type === 'RUN_PAGINATION_AUTO_DETECT') {
        setTimeout(function () {
          try {
            sendResponse(detectPaginationCandidate());
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message || e), detected: null, candidate: null, urlPattern: null });
          }
        }, 0);
        return true;
      }

      if (message.type === 'PREVIEW_STRUCTURE') {
        try {
          var result = root.WSScraper.runExtraction({ containerSelector: message.containerSelector, columns: message.columns });
          sendResponse({ ok: true, rows: result.rows, totalCount: result.totalCount });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        return true;
      }

      if (message.type === 'RUN_AUTO_DETECT_DIAGNOSTIC') {
        setTimeout(function () {
          try {
            sendResponse({ ok: true, report: runAutoDetectDiagnostic() });
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message || e) });
          }
        }, 0);
        return true;
      }

      if (message.type === 'CLASSIFY_AUTO_ROWS') {
        try {
          var classified = classifyExtractedRows(message.columns, message.rows);
          sendResponse({ ok: true, verdicts: classified.verdicts, dominantShape: classified.dominantShape });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
        return true;
      }
    });
  }
})(window);
