/**
 * loadmore.js
 * AUTOMATIC DISCOVERY ENGINE — generic, site-agnostic "Load More" / "Show
 * More" / "More Results" / "View More" result-expansion control: detection
 * + click-to-exhaustion, mirroring content/nextdetect.js's (detection) and
 * content/autoscroll.js's (click/scroll-to-exhaustion loop) established
 * shapes exactly, so this reads as "the same kind of file" as those two,
 * not a new pattern.
 *
 * Deliberately NEVER driven by a user-picked selector (unlike
 * content/pagination.js's own EXISTING 'load-more' Run Mode, which A)
 * already exists, B) is untouched by this file, and C) requires an
 * explicit user-configured button selector via its own separate wizard —
 * this module exists specifically for the fully-automatic Discovery
 * Orchestrator (content/discovery.js), which has no selector-configuration
 * step at all, exactly like Auto Next/Auto Scroll before it).
 *
 * No chrome.runtime.onMessage listener and no resume-on-load bootstrap of
 * its own (unlike autopaginate.js/autoscroll.js) — by design. Nothing
 * else in this codebase drives Load More automatically without a
 * user-picked selector, so there is no second, independent trigger this
 * file would ever need to coordinate against; content/discovery.js is the
 * ONLY caller of runUntilExhausted(), always directly, always passing its
 * own AbortController — exactly one driver, always.
 *
 * CANDIDATE SAFETY (mission section 13/46 — "Do not blindly click every
 * button containing 'More'... candidate controls must be associated with
 * the repeated results context"):
 *   1. Accessible name must match a Load-More-ish phrase (English +
 *      Turkish, mirroring nextdetect.js's own bilingual scope), allowing a
 *      trailing generic noun ("Load More Products"/"Show More Results"),
 *      but REJECTED outright if it also contains a narrow-context negative
 *      word (review/description/comment/photo/detail/spec/answer/story/
 *      article/episode/lyrics/…) that signals a DIFFERENT kind of content
 *      than the page's own repeated result cards — this is exactly what
 *      distinguishes "Load More Products" (accepted) from "Load More
 *      Reviews" / "Show More Description" (rejected), and "Read More"
 *      never matches the base phrase at all.
 *   2. The control is never a per-card button found INSIDE one repeating
 *      card (that's a card's own "read more" link, not a page-wide
 *      result-expansion control — excluded via isInsideScraperContainer,
 *      same check content/nextdetect.js's own Next detection already
 *      uses), and never inside an ad/carousel/modal/onboarding wrapper
 *      (reuses nextdetect.js's own exclusion list verbatim). Detection is
 *      otherwise page-wide, exactly like content/nextdetect.js's own
 *      Next-button detection — safety comes from phrase/negative-word
 *      matching (point 1), not from a DOM-proximity/"common ancestor of
 *      the cards" restriction, which degenerates to the card container
 *      itself for the overwhelmingly common one-shared-parent markup
 *      shape and would then incorrectly hide a real Load More button
 *      sitting as the container's own SIBLING (a very common real-world
 *      pattern) — found and fixed via this mission's own fixture testing.
 *   3. A click is only counted a "success" if it produces measurable
 *      growth (new cards or a taller/expanded result container) OR the
 *      caller's own real extraction pass finds genuinely new unique rows
 *      — mirrors content/autoscroll.js's own "an actual extraction pass
 *      is the authoritative signal, height/count are only an early-exit
 *      optimization" design exactly (mission section 13's own "if it does
 *      nothing repeatedly, stop trying it").
 */
(function (root) {
  'use strict';

  var LOG_PREFIX = '[Web Scraper:loadmore]';
  var DEFAULT_MAX_CLICKS = 60; // spec: "This is NOT a product/licensing limit. It is only runaway-loop protection" — mirrors autoscroll.js's own DEFAULT_MAX_CYCLES reasoning
  var DEFAULT_MAX_NO_NEW_DATA = 3; // same lenient "don't stop after one slow load" contract as Auto Scroll (mission section 19)
  var MAX_ELAPSED_MS = 3 * 60 * 1000;
  var GROWTH_WAIT_TIMEOUT_MS = 6000;
  var GROWTH_POLL_MS = 250;
  var SETTLE_QUIET_MS = 400;
  var CLICK_SETTLE_MS = 300; // brief pause after a click before measuring — some sites animate the new cards in

  // Base phrase — allows a trailing generic noun (products/results/items/
  // listings/…) but not an arbitrary trailing word, so "Load More" and
  // "Load More Products" both match while something structurally
  // unrelated does not just because it happens to start with "load more".
  var BASE_PHRASE_RE = /^(load\s*more|show\s*more|more\s*results?|view\s*more|daha\s*fazla(\s*(g[oö]ster|y[uü]kle))?)(\s+[\p{L}]+){0,3}$/iu;
  // Narrow-context negative words — presence anywhere in the accessible
  // name rejects the candidate outright, regardless of the base phrase
  // match (mission section 13/46's own explicit "Load More Reviews"/"Show
  // More Description" examples).
  var NEGATIVE_CONTEXT_RE = /\b(review|yorum|description|a[cç]ıklama|comment|yorumlar|photo|resim|foto[gğ]raf|image|g[oö]rsel|detail|detay|spec|[oö]zellik|answer|cevap|question|soru|story|hikaye|article|makale|episode|b[oö]l[uü]m|lyrics|s[oö]z|chapter|b[oö]l[uü]m[uü])\b/i;
  var EXCLUDE_WRAPPER_SELECTOR = '[class*="carousel" i], [class*="slider" i], [class*="swiper" i], [data-carousel], ins.adsbygoogle, ' +
    '[class*="advert" i], [id*="advert" i], [role="dialog"], [aria-modal="true"], [class*="modal" i], [id*="modal" i], ' +
    '[class*="onboarding" i], [class*="tour" i], [class*="walkthrough" i], [class*="tooltip" i]';

  function hostname() { return location.hostname; }
  function sessionKey(host) { return 'ws_live_session::' + root.WSRunState.normalizeHostname(host); }
  function getSession(host) {
    var key = sessionKey(host);
    return new Promise(function (resolve) {
      chrome.storage.local.get([key], function (result) { resolve((result && result[key]) || null); });
    });
  }
  function setSession(host, session) {
    var data = {};
    data[sessionKey(host)] = session;
    return new Promise(function (resolve) { chrome.storage.local.set(data, resolve); });
  }

  function accessibleName(el) {
    var aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim().replace(/\s+/g, ' ');
    var title = el.getAttribute('title');
    if (title && title.trim()) return title.trim().replace(/\s+/g, ' ');
    return String(el.textContent || '').trim().replace(/\s+/g, ' ');
  }

  function isDisabledElement(el) {
    if (!el) return false;
    if (el.disabled || el.hasAttribute('disabled')) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    if (/\bdisabled\b/i.test(el.className || '')) return true;
    try {
      var style = window.getComputedStyle(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function isExcludedWrapper(el) {
    try { return !!el.closest(EXCLUDE_WRAPPER_SELECTOR); } catch (e) { return false; }
  }

  function isInsideScraperContainer(el, containerSelector) {
    if (!containerSelector) return false;
    try { return !!el.closest(containerSelector); } catch (e) { return false; }
  }

  /** The scope used for growth OBSERVATION (MutationObserver + height
   * baseline) after a click — deliberately just `document.body`, mirroring
   * content/autoscroll.js's own common-case fallback (its `isWindow`
   * branch, used whenever no ancestor of the cards is genuinely,
   * independently scrollable — the overwhelming real-world case). A
   * "nearest common ancestor of the first/last known card" was tried
   * here and rejected: for the ordinary, overwhelmingly common markup
   * shape of ALL cards sharing one immediate parent container, that
   * ancestor degenerates to the container ELEMENT ITSELF (a node
   * trivially "contains" itself) — which would then also become the
   * DETECTION scope in detectLoadMoreControl, incorrectly hiding a real
   * Load More button that (as is extremely common in practice) sits as a
   * SIBLING of the results container rather than a descendant of it.
   * Detection safety instead comes entirely from phrase/negative-word
   * matching plus explicit container/wrapper exclusion (see
   * detectLoadMoreControl below) — the same "safety via matching, not
   * DOM-proximity restriction" approach content/nextdetect.js already
   * uses successfully for Next-button detection. */
  function resultsAncestor() {
    return document.body;
  }

  function candidateElements() {
    return Array.prototype.slice.call(document.querySelectorAll('a[href], button, [role="button"]'));
  }

  /**
   * @param {string|null} containerSelector
   * @returns {{found:boolean, disabled?:boolean, trigger?:Function}}
   */
  function detectLoadMoreControl(containerSelector) {
    var candidates = candidateElements();
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (isExcludedWrapper(el) || isInsideScraperContainer(el, containerSelector)) continue;
      var name = accessibleName(el);
      if (!name) continue;
      if (NEGATIVE_CONTEXT_RE.test(name)) continue;
      if (!BASE_PHRASE_RE.test(name)) continue;
      return {
        found: true,
        disabled: isDisabledElement(el),
        trigger: function () { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); }
      };
    }
    return { found: false };
  }

  /** Same idea as autoscroll.js's waitForGrowth: poll (backed by a
   * MutationObserver for fast resolution) for either the results
   * container's height or the repeated-card count to exceed the
   * pre-click baseline, bounded by a hard timeout. */
  function waitForGrowth(scope, containerSelector, baseline, signal, timeoutMs) {
    return new Promise(function (resolve) {
      var settled = false;
      var pollTimer = null, hardTimer = null, observer = null;
      function currentCount() {
        try { return containerSelector ? document.querySelectorAll(containerSelector).length : 0; } catch (e) { return 0; }
      }
      function currentHeight() {
        try { return scope.scrollHeight || 0; } catch (e) { return 0; }
      }
      function check() {
        if (settled) return;
        var count = currentCount();
        var height = currentHeight();
        if (count > baseline.count || height > baseline.height) {
          finish(true, count > baseline.count ? 'card-count-increased' : 'height-increased');
        }
      }
      function finish(grew, reason) {
        if (settled) return;
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (hardTimer) clearTimeout(hardTimer);
        if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } }
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve({ grew: grew, reason: reason });
      }
      function onAbort() { finish(false, 'aborted'); }
      if (signal) {
        if (signal.aborted) { finish(false, 'aborted'); return; }
        signal.addEventListener('abort', onAbort);
      }
      try {
        observer = new MutationObserver(check);
        observer.observe(scope, { childList: true, subtree: true });
      } catch (e) { observer = null; }
      pollTimer = setInterval(check, GROWTH_POLL_MS);
      hardTimer = setTimeout(function () { finish(false, 'timeout'); }, timeoutMs || GROWTH_WAIT_TIMEOUT_MS);
      check();
    });
  }

  function stillRunning(session) {
    return !!(session && session.status === 'active' && session.loadMoreAuto &&
      session.loadMoreAuto.enabled && session.loadMoreAuto.status !== 'stopped');
  }

  function finalize(session, host, reason) {
    session.loadMoreAuto.status = 'stopped';
    session.loadMoreAuto.stopReason = reason;
    session.loadMoreAuto.updatedAt = Date.now();
    console.log(LOG_PREFIX, 'STOP REASON:', reason, 'clicks:', session.loadMoreAuto.clickCount, 'rows:', session.rows.length);
    return setSession(host, session);
  }

  /** Local copy of the same extract -> classify -> dedupe/merge primitive
   * every other collection path in this project already uses — kept as a
   * local copy (not a cross-file call) so this file has no hard
   * load-order dependency on autopaginate.js/autoscroll.js, matching
   * those files' own established convention exactly. */
  function scrapeCurrentPage(session) {
    var extraction = root.WSScraper.runExtraction(session.scraperConfig);
    var candidateRows = extraction.rows || [];
    var accepted = candidateRows;
    if (candidateRows.length >= 5 && root.WSAutoDetect && typeof root.WSAutoDetect.classifyExtractedRows === 'function') {
      try {
        var classified = root.WSAutoDetect.classifyExtractedRows(session.scraperConfig.columns, candidateRows);
        accepted = candidateRows.filter(function (row, idx) {
          var v = classified.verdicts[idx];
          return !v || v.verdict !== 'exclude';
        });
      } catch (e) { /* best-effort — never blocks collection */ }
    }
    var merge = root.WSRunState.mergeNewRows(session, accepted, session.scraperConfig.columns, { baseUrl: location.href });
    session = merge.runState;
    session.lastPassNewRows = merge.newUniqueCount;
    session.lastCheckAt = Date.now();
    session.updatedAt = Date.now();
    return { session: session, accepted: accepted, newUniqueCount: merge.newUniqueCount };
  }

  /**
   * Runs Load More clicks against the CURRENT page until a stop condition
   * is met — reusable, called directly by content/discovery.js (the only
   * caller), exactly mirroring content/autoscroll.js's runUntilExhausted
   * contract/shape (same skipInitialScrape convention, same
   * consecutive-no-new-data authoritative stop signal, same
   * always-persist-before-returning discipline).
   * @param {object} session must already carry a seeded session.loadMoreAuto
   * @param {string} host
   * @param {AbortController} [controller]
   * @param {boolean} [skipInitialScrape] true when the current page was already scraped by the caller immediately before this call
   * @returns {Promise<object>} the final, persisted session
   */
  async function runUntilExhausted(session, host, controller, skipInitialScrape) {
    if (!stillRunning(session)) return session;
    controller = controller || new AbortController();
    var startedAt = Date.now();
    var firstIteration = true;
    console.log(LOG_PREFIX, 'load-more-to-exhaustion start', { url: location.href, clickCount: session.loadMoreAuto.clickCount, skipInitialScrape: !!skipInitialScrape });

    while (true) {
      session = await getSession(host);
      if (!stillRunning(session)) return session;
      var lm = session.loadMoreAuto;

      if (Date.now() - startedAt > MAX_ELAPSED_MS) {
        await finalize(session, host, 'max-elapsed-time');
        return await getSession(host);
      }

      if (!(firstIteration && skipInitialScrape)) {
        var settleWait = await root.WSDomWait.waitForDomStable({ quietMs: SETTLE_QUIET_MS, timeoutMs: 3000, signal: controller.signal });
        if (settleWait.reason === 'aborted') return await getSession(host);

        session = await getSession(host);
        if (!stillRunning(session)) return session;
        lm = session.loadMoreAuto;

        var passResult;
        try {
          passResult = scrapeCurrentPage(session);
        } catch (e) {
          console.error(LOG_PREFIX, 'extraction threw mid-load-more — stopping safely, data preserved', e);
          await finalize(session, host, 'extraction-error');
          return await getSession(host);
        }
        session = passResult.session;

        var signature = root.WSRunState.computePageSignature('', passResult.accepted, session.scraperConfig.columns);
        if (lm.pageSignatures.indexOf(signature) === -1) {
          lm.pageSignatures.push(signature);
          if (lm.pageSignatures.length > 50) lm.pageSignatures.shift();
        }

        if (passResult.newUniqueCount > 0) lm.consecutiveNoNewData = 0;
        else lm.consecutiveNoNewData++;

        console.log(LOG_PREFIX, 'cycle scraped', { clickCount: lm.clickCount, newRows: passResult.newUniqueCount, consecutiveNoNewData: lm.consecutiveNoNewData, totalRows: session.rows.length });
        await setSession(host, session);

        if (lm.consecutiveNoNewData >= lm.maxNoNewDataAttempts) {
          await finalize(session, host, 'no-new-data');
          return await getSession(host);
        }
        if (lm.clickCount >= lm.maxClicks) {
          await finalize(session, host, 'max-clicks');
          return await getSession(host);
        }
      }
      firstIteration = false;

      var detected;
      try { detected = detectLoadMoreControl(session.scraperConfig.containerSelector); } catch (e) { detected = { found: false }; }
      if (!detected.found) { await finalize(session, host, 'no-load-more'); return await getSession(host); }
      if (detected.disabled) { await finalize(session, host, 'load-more-disabled'); return await getSession(host); }

      var scope = resultsAncestor(session.scraperConfig.containerSelector);
      var baselineCount = 0;
      try { baselineCount = session.scraperConfig.containerSelector ? document.querySelectorAll(session.scraperConfig.containerSelector).length : 0; } catch (e) { /* ignore */ }
      var baselineHeight = scope ? (scope.scrollHeight || 0) : 0;

      try { detected.trigger(); } catch (e) { /* a click handler throwing is the site's problem, not ours — the next pass' extraction/no-growth logic handles it */ }
      lm.clickCount++;
      await setSession(host, session);

      await root.WSDomWait.sleep(CLICK_SETTLE_MS, controller.signal);
      // growthTimeoutMs is optionally overridable per session, mirroring
      // content/autoscroll.js's own identical `session.autoScroll.
      // growthTimeoutMs` convention exactly (documented there: "tests use
      // a short one; production uses the default").
      var growth = await waitForGrowth(scope, session.scraperConfig.containerSelector, { count: baselineCount, height: baselineHeight }, controller.signal, lm.growthTimeoutMs || GROWTH_WAIT_TIMEOUT_MS);
      if (growth.reason === 'aborted') return await getSession(host);
      console.log(LOG_PREFIX, 'post-click wait result', growth);
      // Loop back around — the NEXT iteration's own extraction pass is the
      // authoritative "did anything genuinely new appear" check, exactly
      // like content/autoscroll.js's own design (growth here is only an
      // early-exit optimization, never an independent stop/continue signal).
    }
  }

  root.WSLoadMore = {
    DEFAULT_MAX_CLICKS: DEFAULT_MAX_CLICKS,
    DEFAULT_MAX_NO_NEW_DATA: DEFAULT_MAX_NO_NEW_DATA,
    detectLoadMoreControl: detectLoadMoreControl,
    resultsAncestor: resultsAncestor,
    runUntilExhausted: runUntilExhausted
  };
})(typeof window !== 'undefined' ? window : globalThis);
