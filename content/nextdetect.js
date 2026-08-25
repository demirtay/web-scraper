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

  function candidateElements() {
    return Array.prototype.slice.call(document.querySelectorAll('a[href], button'));
  }

  /** Same-origin, unambiguous "this href points at a HIGHER page number
   * than the current URL" check — deliberately narrow (mirrors
   * WSRunState.detectUrlPaginationPattern's own restraint: only a short
   * allow-list of well-known parameter shapes, never an arbitrary
   * numeric query param, and never a different hostname). */
  function pointsAtHigherPage(href) {
    var next;
    try { next = new URL(href, location.href); } catch (e) { return false; }
    if (next.hostname !== location.hostname) return false;
    var cur = location;
    for (var i = 0; i < PAGE_NUM_QUERY_KEYS.length; i++) {
      var k = PAGE_NUM_QUERY_KEYS[i];
      var curParams = new URLSearchParams(cur.search);
      var cv = curParams.get(k), nv = next.searchParams.get(k);
      if (cv !== null && nv !== null && /^\d+$/.test(cv) && /^\d+$/.test(nv) && parseInt(nv, 10) > parseInt(cv, 10)) return true;
    }
    var curPath = cur.pathname.match(PAGE_NUM_PATH_RE);
    var nextPath = next.pathname.match(PAGE_NUM_PATH_RE);
    if (curPath && nextPath && parseInt(nextPath[1], 10) > parseInt(curPath[1], 10)) return true;
    return false;
  }

  function clickTrigger(el) {
    return function () { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); };
  }
  function navigateTrigger(href) {
    var url = new URL(href, location.href).toString();
    return function () { location.href = url; };
  }

  /**
   * Finds the best candidate "next page" control on the current page.
   * @param {string|null} containerSelector the scraper's own repeating-
   *   card selector — any control found inside it is never eligible,
   *   however strong its other signals look.
   * @returns {{found:boolean, disabled?:boolean, method?:string, trigger?:Function}}
   */
  function findNextControl(containerSelector) {
    // Tier 0: <link rel="next"> in <head> — authoritative pagination
    // metadata, not clickable, so navigated to directly.
    var linkNext = document.querySelector('head link[rel="next"][href]');
    if (linkNext) {
      var href0 = linkNext.getAttribute('href');
      if (href0) return { found: true, disabled: false, method: 'link-rel-next', trigger: navigateTrigger(href0) };
    }

    var candidates = candidateElements();

    // Tier 1: rel="next" on a real clickable element.
    for (var i = 0; i < candidates.length; i++) {
      var el1 = candidates[i];
      if (el1.getAttribute('rel') === 'next' && !rejected(el1, containerSelector)) {
        return { found: true, disabled: isDisabledElement(el1), method: 'rel-next', trigger: clickTrigger(el1) };
      }
    }

    // Tier 2: exact accessible-name match.
    for (var j = 0; j < candidates.length; j++) {
      var el2 = candidates[j];
      if (EXACT_NEXT_RE.test(accessibleName(el2)) && !rejected(el2, containerSelector)) {
        return { found: true, disabled: isDisabledElement(el2), method: 'accessible-name', trigger: clickTrigger(el2) };
      }
    }

    // Tier 3: inside a recognizable pagination landmark — loose "next"/
    // "sonraki" text match, OR a bare right-pointing arrow (">"/"›"/"→"/
    // "»", no other text — a real, common pattern for icon-only Next
    // controls with no aria-label at all). Both checks are directional/
    // scoped ON PURPOSE: a bare arrow is only ever trusted here, never
    // page-wide, and only a RIGHT-pointing one — a "‹ Previous" control
    // sitting right next to it in the same landmark never matches.
    var landmarks = document.querySelectorAll('nav[aria-label*="pagination" i], [class*="pagination" i], [role="navigation"]');
    for (var k = 0; k < landmarks.length; k++) {
      var within = landmarks[k].querySelectorAll('a[href], button');
      for (var m = 0; m < within.length; m++) {
        var el3 = within[m];
        if (rejected(el3, containerSelector)) continue;
        if (LOOSE_NEXT_RE.test(accessibleName(el3)) || BARE_ARROW_RE.test(rawAccessibleName(el3))) {
          return { found: true, disabled: isDisabledElement(el3), method: 'pagination-landmark', trigger: clickTrigger(el3) };
        }
      }
    }

    // Tier 4: href page-number fallback — a real anchor only, never a button.
    for (var n = 0; n < candidates.length; n++) {
      var el4 = candidates[n];
      if (el4.tagName !== 'A' || rejected(el4, containerSelector)) continue;
      var href4 = el4.getAttribute('href');
      if (href4 && pointsAtHigherPage(href4)) {
        return { found: true, disabled: isDisabledElement(el4), method: 'href-page-number', trigger: clickTrigger(el4) };
      }
    }

    return { found: false };
  }

  root.WSNextDetect = {
    findNextControl: findNextControl,
    isDisabledElement: isDisabledElement,
    accessibleName: accessibleName,
    rawAccessibleName: rawAccessibleName
  };
})(typeof window !== 'undefined' ? window : globalThis);
