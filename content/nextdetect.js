/**
 * nextdetect.js
 * AUTOMATIC PAGINATION (Auto Next) — generic, site-agnostic "next page"
 * control detector. Pure DOM scanning, no chrome.* APIs, no state, no
 * side effects until the caller actually invokes the returned `trigger`
 * function — exactly the same "detection is free, acting is explicit"
 * shape content/autodetect.js's classifyExtractedRows already uses, so
 * it can be unit-tested in JSDOM without any messaging/storage mocks.
 *
 * Deliberately NEVER driven by a user-picked selector (unlike
 * content/pagination.js's resolveNextButton/nextButtonConfig, which is
 * — that's the existing, untouched, explicit Run Mode wizard). This
 * module exists specifically for the OPTIONAL "Auto Next" toggle on the
 * simplified BAŞLA/BİTİR live-session workflow, where there is no
 * selector configuration step at all.
 *
 * PRIORITY ORDER (strongest, least ambiguous signal first — spec:
 * "Keep detection generic... Do NOT hardcode Etsy-only behavior. Site-
 * specific heuristics may be fallback only"):
 *   0. <link rel="next"> in the document head (standard pagination
 *      metadata — not clickable, so its href is navigated to directly).
 *   1. A clickable element with rel="next".
 *   2. A clickable element whose accessible name (aria-label, else
 *      title, else visible text) is EXACTLY "Next" / "Next page" /
 *      "Sonraki" / "Sonraki sayfa" (locale-aware, case-insensitive,
 *      symbols like » › > stripped before comparing).
 *   3. A clickable element inside a recognizable pagination landmark
 *      (nav[aria-label*="pagination"], [class*="pagination"],
 *      [role="navigation"]) whose accessible name loosely contains
 *      "next"/"sonraki".
 *   4. A same-origin <a href> that unambiguously advances a page-number
 *      URL parameter (?page=N -> N+1, /page/N/ -> N+1) — fallback only.
 *
 * NEVER returns a control found inside the scraper's own repeating
 * container (a "next" arrow belonging to one product card's own image
 * carousel, not site pagination — checked at every tier), or inside an
 * obvious ad/carousel/slider wrapper — spec: "Never click: ads, product
 * cards, unrelated arrows, carousel next buttons."
 */
(function (root) {
  'use strict';

  var DISABLED_CLASS_RE = /\bdisabled\b/i;
  // Exact accessible-name match (after stripping decorative symbols) —
  // spec's own example phrases, English + Turkish. A name that's PURELY
  // a decorative arrow (">"/"›"/"→"/"»", no other text) normalizes to
  // an empty string after stripping — deliberately NOT matched here
  // (too weak/ambiguous on its own, real risk of hitting some unrelated
  // arrow icon elsewhere on the page); such bare-arrow controls are
  // only trusted inside a confirmed pagination landmark — see Tier 3.
  var EXACT_NEXT_RE = /^(next|next page|sonraki|sonraki sayfa)$/i;
  // Loose containment, used ONLY inside a confirmed pagination landmark
  // (Tier 3).
  var LOOSE_NEXT_RE = /\bnext\b|\bsonraki\b/i;
  // Bare directional-arrow accessible name (">"/"›"/"→"/"»", no other
  // text) — checked against the UN-stripped name (rawAccessibleName),
  // since normalizeName() would otherwise erase it to nothing before
  // this could ever match. Only trustworthy inside a confirmed
  // pagination landmark (Tier 3), never as a page-wide signal.
  var BARE_ARROW_RE = /^[>›»→]+$/;
  var PAGE_NUM_QUERY_KEYS = ['page', 'p', 'pg'];
  var PAGE_NUM_PATH_RE = /\/page\/(\d+)(?:\/|$)/i;
  // spec: "Never click: ... modal Next buttons, onboarding Next" — added
  // to the existing carousel/slider/ad exclusion list, same mechanism.
  var EXCLUDE_WRAPPER_SELECTOR = '[class*="carousel" i], [class*="slider" i], [class*="swiper" i], [data-carousel], ins.adsbygoogle, ' +
    '[class*="advert" i], [id*="advert" i], [role="dialog"], [aria-modal="true"], [class*="modal" i], [id*="modal" i], ' +
    '[class*="onboarding" i], [class*="tour" i], [class*="walkthrough" i], [class*="tooltip" i]';

  function isDisabledElement(el) {
    if (!el) return false;
    if (el.disabled || el.hasAttribute('disabled')) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    if (Array.prototype.some.call(el.classList || [], function (c) { return DISABLED_CLASS_RE.test(c); })) return true;
    try {
      var style = window.getComputedStyle(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
    } catch (e) { /* ignore — getComputedStyle can throw in a detached/foreign doc, treat as not-disabled */ }
    return false;
  }

  function normalizeName(str) {
    return String(str || '').replace(/[»›><«‹«»‹›→←]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function accessibleName(el) {
    var aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return normalizeName(aria);
    var title = el.getAttribute('title');
    if (title && title.trim()) return normalizeName(title);
    return normalizeName(el.textContent);
  }

  /** Same source priority as accessibleName(), but WITHOUT stripping
   * directional-arrow symbols — needed specifically to recognize a
   * control whose ENTIRE accessible name is a bare arrow ("›"/"→"/
   * "»"/">", no other text), which normalizeName()'s stripping would
   * otherwise erase to nothing before any regex ever saw it. Used only
   * for that one narrow check, only inside an already-confirmed
   * pagination landmark (Tier 3) — never trusted as a page-wide signal. */
  function rawAccessibleName(el) {
    var aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    var title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    return String(el.textContent || '').trim();
  }

  function isExcludedWrapper(el) {
    try { return !!el.closest(EXCLUDE_WRAPPER_SELECTOR); } catch (e) { return false; }
  }

  function isInsideScraperContainer(el, containerSelector) {
    if (!containerSelector) return false;
    try { return !!el.closest(containerSelector); } catch (e) { return false; }
  }

  function rejected(el, containerSelector) {
    return isExcludedWrapper(el) || isInsideScraperContainer(el, containerSelector);
  }

  // REAL AMAZON EVIDENCE mission — ROOT CAUSE C: pagination discovery's
  // own search (findPaginationRegions/findWithinRegion/the page-wide
  // tiers above) has never been SCOPED to containerSelector — every
  // search here is document.querySelectorAll/querySelector, whole-page,
  // by construction. The ONE real coupling is this exclusion safety
  // check (isInsideScraperContainer) — a legitimate, necessary rule
  // ("never click a Next control that's actually part of one product
  // card's own image carousel"), but one that silently mis-fires when
  // containerSelector itself is implausibly broad (the real Amazon
  // failure: a container selector that also happened to wrap the site's
  // OWN pagination strip, wrongly excluding the real Next control at
  // every tier). Pagination belongs to the PAGE, not the record
  // container — a selector matching an implausible fraction of the
  // WHOLE page can no longer be a genuine "one repeated record" selector
  // by definition, so it is no longer trusted for this exclusion at all
  // (falls back to isExcludedWrapper's own carousel/modal/ad checks,
  // which remain fully independent of containerSelector). A normally-
  // scoped container selector (the overwhelming common case) is
  // completely unaffected — this only ever loosens an already-broken
  // exclusion, never a working one.
  var MAX_CONTAINER_EXCLUSION_COVERAGE = 0.5;

  function isContainerSelectorTooBroadForExclusion(containerSelector) {
    try {
      var totalElements = document.querySelectorAll('*').length;
      if (!totalElements) return false;
      var matchCount = document.querySelectorAll(containerSelector).length;
      return matchCount > totalElements * MAX_CONTAINER_EXCLUSION_COVERAGE;
    } catch (e) {
      return false;
    }
  }

  /** Computed ONCE per findNextControl()/findNextControlDiagnostic()
   * call (never per-candidate — isContainerSelectorTooBroadForExclusion
   * itself does two DOM-wide queries, too expensive to repeat for every
   * candidate examined) — returns containerSelector unchanged when it's
   * plausibly scoped, or null when it's too broad to trust for
   * exclusion, so every downstream call site (rejected/
   * isInsideScraperContainer, findPaginationRegions, findWithinRegion,
   * findClusterAdjacency, findPageNumberCluster) automatically stops
   * excluding anything on its account, with zero changes needed at any
   * of those call sites. */
  function effectiveContainerSelector(containerSelector) {
    if (!containerSelector) return null;
    return isContainerSelectorTooBroadForExclusion(containerSelector) ? null : containerSelector;
  }

  function candidateElements() {
    return Array.prototype.slice.call(document.querySelectorAll('a[href], button'));
  }

  /** Same-origin, unambiguous "this href points at a HIGHER page number
   * than the current URL" check — deliberately narrow (mirrors
   * WSRunState.detectUrlPaginationPattern's own restraint: only a short
   * allow-list of well-known parameter shapes, never an arbitrary
   * numeric query param, and never a different hostname).
   *
   * AMAZON PAGINATION FIX — real production report: a real Amazon search
   * page (page 1 of a multi-page result set, `?k=desk+lamp` with NO
   * `page` parameter at all) has a visible, working Next control whose
   * href genuinely points at `?k=desk+lamp&page=2` — but this function
   * used to require BOTH the current AND next URL to already carry the
   * page-number param/path explicitly before comparing them, so a page 1
   * with no param present at all could never be recognized as "before"
   * page 2. This is not an Amazon-specific quirk: omitting the parameter
   * entirely on the first page (rather than writing an explicit `page=1`)
   * is one of the single most common real-world pagination conventions —
   * the fix below is the same generic, narrow-allow-list check as
   * before, just no longer requiring the CURRENT url to redundantly
   * restate an implicit page 1. */
  function pointsAtHigherPage(href) {
    var next;
    try { next = new URL(href, location.href); } catch (e) { return false; }
    if (next.hostname !== location.hostname) return false;
    var cur = location;
    for (var i = 0; i < PAGE_NUM_QUERY_KEYS.length; i++) {
      var k = PAGE_NUM_QUERY_KEYS[i];
      var curParams = new URLSearchParams(cur.search);
      var cvRaw = curParams.get(k), nv = next.searchParams.get(k);
      // Absent on the CURRENT url only == implicit page 1 (the param is
      // simply never written for the first page) — still requires the
      // NEXT url to explicitly carry a real numeric value for this exact
      // known key, so this never turns into "trust any arbitrary param."
      var cv = cvRaw !== null ? cvRaw : '1';
      if (nv !== null && /^\d+$/.test(cv) && /^\d+$/.test(nv) && parseInt(nv, 10) > parseInt(cv, 10)) return true;
    }
    var curPathMatch = cur.pathname.match(PAGE_NUM_PATH_RE);
    var nextPath = next.pathname.match(PAGE_NUM_PATH_RE);
    var curPage = curPathMatch ? parseInt(curPathMatch[1], 10) : 1; // same implicit-page-1 reasoning as above
    if (nextPath && parseInt(nextPath[1], 10) > curPage) return true;
    return false;
  }

  /**
   * REAL AMAZON EVIDENCE mission — real-browser proof, traced through the
   * actual production path (RUN_EXTRACTION -> session persistence ->
   * START_DISCOVERY -> discovery loop -> findNextControl -> trigger):
   * with row detection and the containerSelector both already confirmed
   * correct, and the real Amazon Next anchor confirmed FOUND by this
   * exact, unmodified function (method="pagination-landmark" — its
   * aria-label "Go to next page, page 2" matches LOOSE_NEXT_RE but not
   * the exact-name tier), discovery still finalized as complete after
   * page 1. Every text/rel-based tier (Tier 1 rel=next, Tier 2 exact
   * accessible-name, the region loose-text/bare-arrow match) has ALWAYS
   * used clickTrigger() — a synthetic MouseEvent dispatch — even when
   * the found element is a real `<a href>` whose destination is already
   * known with certainty. A synthetic click's default action (following
   * the link) is not guaranteed to fire identically to a real user
   * click on every real site — a page's own click handling, an
   * intermediate redirect/interstitial, or a framework intercepting the
   * event can all silently swallow it, and content/discovery.js's own
   * waitForNavigationOrMutation() then times out with no visible error,
   * which is indistinguishable from "there was nothing more to do."
   *
   * Fix, centralized in ONE place so every tier benefits with zero
   * call-site changes: whenever the found element is a real anchor with
   * an href that INDEPENDENTLY verifies as "points at a higher page"
   * (pointsAtHigherPage() — the same narrow, already-proven check the
   * href-based tiers already use, never an arbitrary link), prefer
   * direct navigation over a synthetic click — the destination is
   * already known, so there is no reason to depend on whether a
   * synthetic event actually triggers the browser's native "follow this
   * link" behavior. A control with no real advancing href at all (a
   * JS-driven SPA control, `href="#"`, a plain `<button>`, none) still
   * gets the synthetic click here — the only way to activate it at all,
   * completely unchanged from before. Generic by construction — no
   * hostname/site check anywhere in this condition.
   */
  function clickTrigger(el) {
    if (el && el.tagName === 'A' && el.hasAttribute && el.hasAttribute('href')) {
      var href = el.getAttribute('href');
      if (href && pointsAtHigherPage(href)) return navigateTrigger(href);
    }
    return function () { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); };
  }
  function navigateTrigger(href) {
    var url = new URL(href, location.href).toString();
    return function () { location.href = url; };
  }

  /** REAL AMAZON EVIDENCE mission PART C — resolves an anchor's href to
   * an absolute URL string (or null for a non-anchor / hrefless
   * element), so the caller can inspect/log the intended destination
   * BEFORE the trigger actually fires (spec: "Capture href BEFORE
   * click"). Never throws — a malformed href resolves to null rather
   * than propagating a URL constructor exception. */
  function resolveAnchorHref(el) {
    if (!el || el.tagName !== 'A' || !el.hasAttribute('href')) return null;
    try { return new URL(el.getAttribute('href'), location.href).toString(); } catch (e) { return null; }
  }

  var PURE_NUMBER_RE = /^\d+$/;

  /** Same implicit-page-1 convention pointsAtHigherPage() already uses:
   * an absent page-number param/path on the CURRENT url means page 1,
   * never a guess at an arbitrary param. */
  function getCurrentPageNumber() {
    var curParams = new URLSearchParams(location.search);
    for (var i = 0; i < PAGE_NUM_QUERY_KEYS.length; i++) {
      var v = curParams.get(PAGE_NUM_QUERY_KEYS[i]);
      if (v !== null && /^\d+$/.test(v)) return parseInt(v, 10);
    }
    var m = (location.pathname || '').match(PAGE_NUM_PATH_RE);
    if (m) return parseInt(m[1], 10);
    return 1;
  }

  /** Finds the largest genuine "page-number cluster" on the page: a
   * shared parent with >= 3 clickable children (or children whose own
   * accessible name is a bare number) whose accessible name is PURELY a
   * page number. Requires several real number-only entries together —
   * a single stray numeric link elsewhere on the page never qualifies,
   * so this stays a high-confidence, generic pagination signature. */
  function findPageNumberCluster(containerSelector) {
    var candidates = candidateElements();
    var numericEntries = candidates.filter(function (el) {
      if (rejected(el, containerSelector)) return false;
      return PURE_NUMBER_RE.test(normalizeName(accessibleName(el)));
    });
    if (numericEntries.length < 3) return null;
    var buckets = [];
    numericEntries.forEach(function (el) {
      var p = el.parentElement;
      if (!p) return;
      var bucket = null;
      for (var i = 0; i < buckets.length; i++) { if (buckets[i].parent === p) { bucket = buckets[i]; break; } }
      if (!bucket) { bucket = { parent: p, entries: [] }; buckets.push(bucket); }
      bucket.entries.push(el);
    });
    buckets.sort(function (a, b) { return b.entries.length - a.entries.length; });
    var best = buckets[0];
    return (best && best.entries.length >= 3) ? best : null;
  }

  var PAGINATION_LANDMARK_SELECTOR = 'nav[aria-label*="pagination" i], [class*="pagination" i], [role="navigation"]';

  /**
   * REAL AMAZON EVIDENCE mission PART C REBUILD — "rework detection
   * around PAGINATION STRUCTURE rather than only fragile selectors/text
   * tiers." Discovers pagination REGIONS first: every recognized
   * landmark element, UNION the shared parent of any genuine page-number
   * cluster found anywhere on the page (findPageNumberCluster, above —
   * >= 3 sibling clickable elements whose accessible name is purely a
   * number, a generic structural signature no class name is needed
   * for). A cluster's own parent already covered by a landmark match is
   * not added twice. Landmarks are listed first (a real semantic/class
   * signal is higher-confidence than a purely positional one), but every
   * region is tried in order until one produces a usable result.
   */
  function findPaginationRegions(containerSelector) {
    var regions = [];
    var landmarks = document.querySelectorAll(PAGINATION_LANDMARK_SELECTOR);
    for (var i = 0; i < landmarks.length; i++) regions.push(landmarks[i]);

    var cluster = findPageNumberCluster(containerSelector);
    if (cluster) {
      var alreadyCovered = regions.indexOf(cluster.parent) !== -1 ||
        regions.some(function (r) { return r.contains && r.contains(cluster.parent); });
      if (!alreadyCovered) regions.push(cluster.parent);
    }
    return { regions: regions, cluster: cluster };
  }

  /** Within ONE pagination region, tries the same signal priority the
   * old landmark tier used (loose "next"/"sonraki" text, or a bare
   * right-pointing arrow — both directional/scoped on purpose, only ever
   * trusted inside a confirmed region, never page-wide), then — new this
   * round — structural adjacency (the clickable element immediately
   * after the CURRENT page's own entry in a genuine number cluster, so
   * an icon-only Next control with no text/aria-label at all is still
   * found), then an href that unambiguously advances the page number,
   * scoped to just this region's own anchors. */
  function findWithinRegion(region, cluster, containerSelector) {
    var within = Array.prototype.slice.call(region.querySelectorAll('a[href], button'));
    // AMAZON PAGINATION FIX (kept from the previous round): a real,
    // common naming pattern is a site putting "pagination" directly in
    // the CLICKABLE Next control's own class (e.g. Amazon's own
    // documented "s-pagination-next" on the <a> itself, not a separate
    // wrapper) — querySelectorAll only searches DESCENDANTS, so a region
    // that IS itself the clickable element needs to be added explicitly.
    if ((region.tagName === 'A' && region.hasAttribute('href')) || region.tagName === 'BUTTON') within.push(region);

    for (var m = 0; m < within.length; m++) {
      var el = within[m];
      if (rejected(el, containerSelector)) continue;
      if (LOOSE_NEXT_RE.test(accessibleName(el)) || BARE_ARROW_RE.test(rawAccessibleName(el))) {
        return { found: true, disabled: isDisabledElement(el), method: 'pagination-landmark', href: resolveAnchorHref(el), trigger: clickTrigger(el) };
      }
    }

    if (cluster && cluster.parent === region) {
      var adjacency = findClusterAdjacency(cluster, containerSelector);
      if (adjacency) return adjacency;
    }

    for (var n = 0; n < within.length; n++) {
      var elHref = within[n];
      if (elHref.tagName !== 'A' || rejected(elHref, containerSelector)) continue;
      var hrefN = elHref.getAttribute('href');
      if (hrefN && pointsAtHigherPage(hrefN)) {
        // PART C spec: "for anchors, prefer reliable native
        // activation/location navigation rather than synthetic-only
        // dispatch" — we have already independently verified this
        // anchor's own href genuinely advances the page number, so a
        // direct navigation is at least as reliable as a synthetic
        // click and avoids depending on the page's own click handler
        // actually being attached/working.
        return { found: true, disabled: isDisabledElement(elHref), method: 'href-page-number', href: resolveAnchorHref(elHref), trigger: navigateTrigger(hrefN) };
      }
    }
    return null;
  }

  /** Structural adjacency within a confirmed number cluster: finds the
   * entry matching the CURRENT page number, then takes whichever
   * clickable element comes immediately after it — regardless of that
   * element's own accessible name (or lack of one entirely). Covers an
   * icon-only Next control (no text, no aria-label, sometimes even a
   * non-anchor <button> with no href at all) that no text/rel-based
   * signal could ever find. */
  function findClusterAdjacency(cluster, containerSelector) {
    var currentPageNum = getCurrentPageNumber();
    var siblings = Array.prototype.slice.call(cluster.parent.children);
    var currentIdx = -1;
    for (var s = 0; s < siblings.length; s++) {
      var sName = normalizeName(accessibleName(siblings[s]));
      if (PURE_NUMBER_RE.test(sName) && parseInt(sName, 10) === currentPageNum) { currentIdx = s; break; }
    }
    if (currentIdx === -1) return null;
    for (var t = currentIdx + 1; t < siblings.length; t++) {
      var sibEl = siblings[t];
      var clickable = ((sibEl.tagName === 'A' && sibEl.hasAttribute('href')) || sibEl.tagName === 'BUTTON')
        ? sibEl : (sibEl.querySelector ? sibEl.querySelector('a[href], button') : null);
      if (!clickable || rejected(clickable, containerSelector)) continue;
      var href = resolveAnchorHref(clickable);
      return {
        found: true, disabled: isDisabledElement(clickable), method: 'pagination-cluster-adjacency', href: href,
        // Same "prefer a resolved href over a synthetic click" reasoning
        // as findWithinRegion's own href tier above — only applies when
        // this specific element actually IS a real anchor with a real
        // href; a <button> (the common icon-only shape) still gets a
        // synthetic click, which is the only way to activate it at all.
        trigger: href ? navigateTrigger(clickable.getAttribute('href')) : clickTrigger(clickable)
      };
    }
    return null;
  }

  /**
   * Finds the best candidate "next page" control on the current page.
   *
   * REAL AMAZON EVIDENCE mission PART C REBUILD: Tier 0 (<link rel=next>)
   * and the two strongest, least-ambiguous page-wide signals (an
   * explicit rel="next" element, an EXACT "Next"/"Sonraki" accessible
   * name) are tried FIRST, unchanged from every previously-verified
   * site's behavior (Etsy included) — these signals are unambiguous
   * enough that scoping them to a "region" first would only add risk for
   * zero benefit. Everything WEAKER and more ambiguous (a loose text/
   * bare-arrow match, a structural "next after the current page number"
   * inference, an href that merely happens to advance the page number)
   * is now evaluated PAGINATION-REGION-FIRST: discover the actual
   * pagination region(s) on the page, then look for a Next control
   * inside them — never page-wide for these weaker signals, closing the
   * real risk of matching something structurally unrelated to
   * pagination. A final page-wide fallback (this function's own tail)
   * preserves the original page-wide href/rel/exact-name behavior for a
   * page with a lone Next control and genuinely no surrounding
   * landmark/cluster markup at all.
   *
   * @param {string|null} containerSelector the scraper's own repeating-
   *   card selector — any control found inside it is never eligible,
   *   however strong its other signals look.
   * @returns {{found:boolean, disabled?:boolean, method?:string, href?:string|null, trigger?:Function}}
   */
  function findNextControl(rawContainerSelector) {
    // ROOT CAUSE C — see effectiveContainerSelector()'s own comment.
    // Computed once, used for every exclusion check below.
    var containerSelector = effectiveContainerSelector(rawContainerSelector);

    // Tier 0: <link rel="next"> in <head> — authoritative pagination
    // metadata, not clickable, so navigated to directly.
    var linkNext = document.querySelector('head link[rel="next"][href]');
    if (linkNext) {
      var href0 = linkNext.getAttribute('href');
      if (href0) {
        var resolved0 = null;
        try { resolved0 = new URL(href0, location.href).toString(); } catch (e) { /* leave null */ }
        return { found: true, disabled: false, method: 'link-rel-next', href: resolved0, trigger: navigateTrigger(href0) };
      }
    }

    var candidates = candidateElements();

    // Strong, page-wide signals — unchanged priority/scope.
    for (var i = 0; i < candidates.length; i++) {
      var el1 = candidates[i];
      if (el1.getAttribute('rel') === 'next' && !rejected(el1, containerSelector)) {
        return { found: true, disabled: isDisabledElement(el1), method: 'rel-next', href: resolveAnchorHref(el1), trigger: clickTrigger(el1) };
      }
    }
    for (var j = 0; j < candidates.length; j++) {
      var el2 = candidates[j];
      if (EXACT_NEXT_RE.test(accessibleName(el2)) && !rejected(el2, containerSelector)) {
        return { found: true, disabled: isDisabledElement(el2), method: 'accessible-name', href: resolveAnchorHref(el2), trigger: clickTrigger(el2) };
      }
    }

    // Weaker/ambiguous signals — pagination-region-first.
    var discovered = findPaginationRegions(containerSelector);
    for (var r = 0; r < discovered.regions.length; r++) {
      var result = findWithinRegion(discovered.regions[r], discovered.cluster, containerSelector);
      if (result) return result;
    }

    // Page-wide fallback: no region produced anything usable (or none
    // was found at all) — the original, unscoped href-page-number check,
    // so a page with numbered links but no landmark/cluster markup this
    // file recognizes still works exactly as it always has.
    for (var n = 0; n < candidates.length; n++) {
      var el4 = candidates[n];
      if (el4.tagName !== 'A' || rejected(el4, containerSelector)) continue;
      var href4 = el4.getAttribute('href');
      if (href4 && pointsAtHigherPage(href4)) {
        return { found: true, disabled: isDisabledElement(el4), method: 'href-page-number', href: resolveAnchorHref(el4), trigger: navigateTrigger(href4) };
      }
    }

    return { found: false };
  }

  /**
   * REAL AMAZON EVIDENCE mission TASK 5 / PART C REBUILD — DEV-ONLY
   * instrumented mirror of findNextControl() above: runs the EXACT SAME
   * decision logic, in the same order, calling the same helper functions
   * (never a reimplementation of any matching/rejection rule), but
   * records what happened at every stage for every candidate examined
   * instead of stopping at the first match. Adds no behavior to
   * production Next-detection — findNextControl() itself is untouched
   * by this function's existence, and this function is only reachable
   * from a popup dev-tools control gated behind
   * WSLicense.isDevelopmentInstall(), same contract as
   * content/autodetect.js's runAutoDetectDiagnostic().
   */
  function findNextControlDiagnostic(rawContainerSelector) {
    // ROOT CAUSE C — see effectiveContainerSelector()'s own comment.
    var containerSelector = effectiveContainerSelector(rawContainerSelector);
    var report = {
      url: (typeof location !== 'undefined' ? location.href : ''),
      containerSelector: rawContainerSelector || null,
      containerSelectorTrusted: !rawContainerSelector || containerSelector === rawContainerSelector,
      tiers: []
    };

    function describe(el) {
      return {
        tag: el.tagName, text: normalizeName(el.textContent).slice(0, 60),
        ariaLabel: el.getAttribute('aria-label') || null, title: el.getAttribute('title') || null,
        href: el.tagName === 'A' ? (el.getAttribute('href') || null) : null,
        disabled: isDisabledElement(el),
        rejectedExcludedWrapper: isExcludedWrapper(el),
        rejectedInsideScraperContainer: isInsideScraperContainer(el, containerSelector)
      };
    }

    var linkNext = document.querySelector('head link[rel="next"][href]');
    report.tiers.push({ tier: 0, name: 'link-rel-next', found: !!linkNext, href: linkNext ? linkNext.getAttribute('href') : null });
    if (linkNext && linkNext.getAttribute('href')) {
      report.result = { found: true, method: 'link-rel-next' };
      return report;
    }

    var candidates = candidateElements();

    var tier1Inspected = [];
    var tier1Found = null;
    for (var i = 0; i < candidates.length; i++) {
      var el1 = candidates[i];
      if (el1.getAttribute('rel') !== 'next') continue;
      var d1 = describe(el1);
      d1.rejected = d1.rejectedExcludedWrapper || d1.rejectedInsideScraperContainer;
      tier1Inspected.push(d1);
      if (!d1.rejected && !tier1Found) tier1Found = { found: true, method: 'rel-next', disabled: d1.disabled };
    }
    report.tiers.push({ tier: 1, name: 'rel-next (page-wide)', candidatesInspected: tier1Inspected, found: !!tier1Found });
    if (tier1Found) { report.result = tier1Found; return report; }

    var tier2Inspected = [];
    var tier2Found = null;
    for (var j = 0; j < candidates.length; j++) {
      var el2 = candidates[j];
      var name2 = accessibleName(el2);
      if (!EXACT_NEXT_RE.test(name2)) continue;
      var d2 = describe(el2);
      d2.accessibleName = name2;
      d2.rejected = d2.rejectedExcludedWrapper || d2.rejectedInsideScraperContainer;
      tier2Inspected.push(d2);
      if (!d2.rejected && !tier2Found) tier2Found = { found: true, method: 'accessible-name', disabled: d2.disabled };
    }
    report.tiers.push({ tier: 2, name: 'accessible-name (page-wide)', candidatesInspected: tier2Inspected, found: !!tier2Found });
    if (tier2Found) { report.result = tier2Found; return report; }

    // PART C REBUILD — pagination-region discovery, then within-region
    // signals, mirroring findWithinRegion()/findClusterAdjacency() above
    // exactly (same helper calls, same order).
    var discovered = findPaginationRegions(containerSelector);
    var currentPageNum = getCurrentPageNumber();
    report.regionDiscovery = {
      landmarksFound: document.querySelectorAll(PAGINATION_LANDMARK_SELECTOR).length,
      clusterFound: !!discovered.cluster,
      clusterEntryCount: discovered.cluster ? discovered.cluster.entries.length : 0,
      currentPageNumber: currentPageNum,
      regionsToTry: discovered.regions.length
    };

    var regionResult = null;
    var regionReports = [];
    for (var r = 0; r < discovered.regions.length && !regionResult; r++) {
      var region = discovered.regions[r];
      var within = Array.prototype.slice.call(region.querySelectorAll('a[href], button'));
      if ((region.tagName === 'A' && region.hasAttribute('href')) || region.tagName === 'BUTTON') within.push(region);
      var inspected = [];
      var looseFound = null;
      for (var m = 0; m < within.length; m++) {
        var el3 = within[m];
        var loose = LOOSE_NEXT_RE.test(accessibleName(el3));
        var bareArrow = BARE_ARROW_RE.test(rawAccessibleName(el3));
        if (!loose && !bareArrow) continue;
        var d3 = describe(el3);
        d3.matchedVia = loose ? 'loose-text' : 'bare-arrow';
        d3.rejected = d3.rejectedExcludedWrapper || d3.rejectedInsideScraperContainer;
        inspected.push(d3);
        if (!d3.rejected && !looseFound) looseFound = { found: true, method: 'pagination-landmark', disabled: d3.disabled, href: resolveAnchorHref(el3) };
      }
      var adjacencyChecked = false;
      var adjacencyFound = null;
      var adjacencyInspected = [];
      if (!looseFound && discovered.cluster && discovered.cluster.parent === region) {
        adjacencyChecked = true;
        var siblings = Array.prototype.slice.call(region.children);
        var currentIdx = -1;
        for (var s = 0; s < siblings.length; s++) {
          var sName = normalizeName(accessibleName(siblings[s]));
          if (PURE_NUMBER_RE.test(sName) && parseInt(sName, 10) === currentPageNum) { currentIdx = s; break; }
        }
        if (currentIdx !== -1) {
          for (var t = currentIdx + 1; t < siblings.length; t++) {
            var sibEl = siblings[t];
            var clickable = ((sibEl.tagName === 'A' && sibEl.hasAttribute('href')) || sibEl.tagName === 'BUTTON')
              ? sibEl : (sibEl.querySelector ? sibEl.querySelector('a[href], button') : null);
            if (!clickable) continue;
            var d5 = describe(clickable);
            d5.rejected = d5.rejectedExcludedWrapper || d5.rejectedInsideScraperContainer;
            adjacencyInspected.push(d5);
            if (!d5.rejected && !adjacencyFound) adjacencyFound = { found: true, method: 'pagination-cluster-adjacency', disabled: d5.disabled, href: resolveAnchorHref(clickable) };
          }
        }
      }
      var hrefFound = null;
      var hrefInspected = [];
      if (!looseFound && !adjacencyFound) {
        for (var n = 0; n < within.length; n++) {
          var el4 = within[n];
          if (el4.tagName !== 'A') continue;
          var href4 = el4.getAttribute('href');
          if (!href4 || !pointsAtHigherPage(href4)) continue;
          var d4 = describe(el4);
          d4.rejected = d4.rejectedExcludedWrapper || d4.rejectedInsideScraperContainer;
          hrefInspected.push(d4);
          if (!d4.rejected && !hrefFound) hrefFound = { found: true, method: 'href-page-number', disabled: d4.disabled, href: resolveAnchorHref(el4) };
        }
      }
      regionReports.push({
        regionPath: (region.tagName || '').toLowerCase() + (region.className ? '.' + String(region.className).trim().replace(/\s+/g, '.') : ''),
        looseTextCandidatesInspected: inspected, looseTextFound: !!looseFound,
        clusterAdjacencyChecked: adjacencyChecked, clusterAdjacencyCandidatesInspected: adjacencyInspected, clusterAdjacencyFound: !!adjacencyFound,
        hrefCandidatesInspected: hrefInspected, hrefFound: !!hrefFound
      });
      regionResult = looseFound || adjacencyFound || hrefFound;
    }
    report.tiers.push({ tier: 3, name: 'pagination-region (loose-text / cluster-adjacency / href, in that order, per region)', regions: regionReports, found: !!regionResult });
    if (regionResult) { report.result = regionResult; return report; }

    var tier4Inspected = [];
    var tier4Found = null;
    for (var p = 0; p < candidates.length; p++) {
      var el4b = candidates[p];
      if (el4b.tagName !== 'A') continue;
      var href4b = el4b.getAttribute('href');
      if (!href4b || !pointsAtHigherPage(href4b)) continue;
      var d4b = describe(el4b);
      d4b.rejected = d4b.rejectedExcludedWrapper || d4b.rejectedInsideScraperContainer;
      tier4Inspected.push(d4b);
      if (!d4b.rejected && !tier4Found) tier4Found = { found: true, method: 'href-page-number', disabled: d4b.disabled, href: resolveAnchorHref(el4b) };
    }
    report.tiers.push({ tier: 4, name: 'href-page-number (page-wide fallback — no region produced a usable candidate)', candidatesInspected: tier4Inspected, found: !!tier4Found });
    if (tier4Found) { report.result = tier4Found; return report; }

    report.result = { found: false };
    return report;
  }

  root.WSNextDetect = {
    findNextControl: findNextControl,
    findNextControlDiagnostic: findNextControlDiagnostic,
    isDisabledElement: isDisabledElement,
    accessibleName: accessibleName,
    rawAccessibleName: rawAccessibleName
  };
})(typeof window !== 'undefined' ? window : globalThis);
