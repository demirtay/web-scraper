/**
 * domwait.js
 * DOM-stability and scroll-position helpers used by the Auto Scroll and
 * Multi-page orchestration (content/pagination.js). Deliberately avoids
 * relying on a fixed sleep as the primary signal — a MutationObserver
 * "quiet period" heuristic (no DOM changes for N ms = probably done
 * loading) is the main mechanism, with a bounded hard timeout as a
 * fallback so a page that never goes quiet (e.g. a live ticking clock
 * widget) can't stall a run forever.
 */
(function (root) {
  'use strict';

  /**
   * Resolves once `root`'s subtree has had no mutations for `quietMs`,
   * or after `timeoutMs` total, whichever comes first. An optional
   * AbortSignal (options.signal) lets a Stop request cut this short
   * immediately instead of waiting out the full window — this is the
   * single longest-running wait in a scroll/page pass, so it's the one
   * most worth making responsively cancellable.
   * @returns {Promise<{reason:'quiet'|'timeout'|'aborted'}>}
   */
  function waitForDomStable(options) {
    options = options || {};
    var quietMs = options.quietMs || 500;
    var timeoutMs = options.timeoutMs || 5000;
    var scopeEl = options.root || document.body;
    var signal = options.signal;

    return new Promise(function (resolve) {
      var settled = false;
      var quietTimer = null;
      var hardTimer = null;
      var observer = new MutationObserver(function () {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(function () { finish('quiet'); }, quietMs);
      });

      function finish(reason) {
        if (settled) return;
        settled = true;
        if (quietTimer) clearTimeout(quietTimer);
        if (hardTimer) clearTimeout(hardTimer);
        try { observer.disconnect(); } catch (e) { /* ignore */ }
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve({ reason: reason });
      }

      function onAbort() { finish('aborted'); }
      if (signal) {
        if (signal.aborted) { finish('aborted'); return; }
        signal.addEventListener('abort', onAbort);
      }

      observer.observe(scopeEl, { childList: true, subtree: true, attributes: true, characterData: true });
      quietTimer = setTimeout(function () { finish('quiet'); }, quietMs);
      hardTimer = setTimeout(function () { finish('timeout'); }, timeoutMs);
    });
  }

  function getScrollMetrics() {
    var doc = document.documentElement;
    return {
      scrollHeight: Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0),
      scrollY: window.scrollY,
      innerHeight: window.innerHeight
    };
  }

  function isAtBottom(thresholdPx) {
    var m = getScrollMetrics();
    return (m.scrollY + m.innerHeight) >= (m.scrollHeight - (thresholdPx || 100));
  }

  /** Scrolls down by a fraction of the viewport — natural incremental
   * scrolling rather than jumping straight to the bottom, so lazy-load
   * observers on the page trigger the way they would for a real user. */
  function incrementalScroll(fractionOfViewport) {
    var delta = window.innerHeight * (fractionOfViewport || 0.8);
    window.scrollBy({ top: delta, left: 0, behavior: 'auto' });
  }

  function sleep(ms, signal) {
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve('elapsed');
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        resolve('aborted');
      }
      if (signal) {
        if (signal.aborted) { clearTimeout(timer); resolve('aborted'); return; }
        signal.addEventListener('abort', onAbort);
      }
    });
  }

  /**
   * Races a same-document DOM mutation against a location.href change,
   * for the ambiguous moment right after clicking a "Next" control where
   * we don't yet know whether the site will do a real navigation or an
   * SPA-style in-place content swap.
   *
   * `options.trigger`, if given, is called ONLY after the MutationObserver
   * and URL poll are already armed. This matters: a click handler often
   * mutates the DOM (or navigates) synchronously, so triggering it before
   * observation begins would make those very mutations invisible to the
   * observer — the caller would then wait out the full timeout for
   * something that already happened.
   * @returns {Promise<'url-changed'|'dom-changed'|'timeout'>}
   */
  function waitForNavigationOrMutation(options) {
    options = options || {};
    var timeoutMs = options.timeoutMs || 6000;
    var urlBefore = options.urlBefore || location.href;
    var mutationThreshold = options.mutationThreshold || 3; // ignore tiny/incidental mutations
    var signal = options.signal;
    var trigger = options.trigger;

    return new Promise(function (resolve) {
      var settled = false;
      var mutationCount = 0;
      var pollTimer = null;
      var hardTimer = null;
      var observer = new MutationObserver(function (mutations) {
        mutationCount += mutations.length;
        if (mutationCount >= mutationThreshold) finish('dom-changed');
      });

      function finish(reason) {
        if (settled) return;
        settled = true;
        if (pollTimer) clearInterval(pollTimer);
        if (hardTimer) clearTimeout(hardTimer);
        try { observer.disconnect(); } catch (e) { /* ignore */ }
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(reason);
      }

      function onAbort() { finish('aborted'); }
      if (signal) {
        if (signal.aborted) { finish('aborted'); return; }
        signal.addEventListener('abort', onAbort);
      }

      observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      pollTimer = setInterval(function () {
        if (location.href !== urlBefore) finish('url-changed');
      }, 100);
      hardTimer = setTimeout(function () { finish('timeout'); }, timeoutMs);

      if (typeof trigger === 'function') trigger();
    });
  }

  root.WSDomWait = {
    waitForDomStable: waitForDomStable,
    waitForNavigationOrMutation: waitForNavigationOrMutation,
    getScrollMetrics: getScrollMetrics,
    isAtBottom: isAtBottom,
    incrementalScroll: incrementalScroll,
    sleep: sleep
  };
})(window);
