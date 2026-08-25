/**
 * pagination.js
 * Auto Scroll and Multi-page run orchestration. This is the ONLY new
 * moving part added on top of the untouched V1.1/V1.2 scraper engine —
 * it calls WSScraper.runExtraction() exactly as Preview always has, and
 * layers a resumable state machine (WSRunState, utils/runstate.js) plus
 * DOM-stability waiting (WSDomWait, content/domwait.js) on top.
 *
 * Registers its OWN chrome.runtime.onMessage listener, separate from
 * content.js's, so the V1.1/V1.2 picking/extraction message handling in
 * content.js is never touched.
 *
 * Run state lives in chrome.storage.session (cleared when the browser
 * closes — appropriate, since perfect resume across a full restart is
 * explicitly out of scope), keyed by hostname so it survives real page
 * navigation within a Multi-page run without depending on this script's
 * own in-memory state (which is destroyed on navigation). The popup is
 * responsible for registering a dynamic content script (via
 * chrome.scripting.registerContentScript, scoped to just the run's
 * hostname, requested via chrome.permissions at Start time) so this file
 * gets re-injected automatically after each page change; on load it
 * checks storage for an active run and resumes the loop on its own.
 */
(function () {
  'use strict';

  if (window.__wsPaginationInjected) return;
  window.__wsPaginationInjected = true;

  var LOG_PREFIX = '[Web Scraper:pagination]';

  function hostname() {
    return location.hostname;
  }

  function runKey(host) {
    return 'ws_run::' + host;
  }

  function getRunState(host) {
    var key = runKey(host);
    return new Promise(function (resolve) {
      chrome.storage.session.get([key], function (result) {
        resolve((result && result[key]) || null);
      });
    });
  }

  function setRunState(host, runState) {
    var data = {};
    data[runKey(host)] = runState;
    return new Promise(function (resolve) {
      chrome.storage.session.set(data, resolve);
    });
  }

  // Best-effort fast-path cancellation for a run loop that's alive in
  // THIS script instance. The storage status check at the top of every
  // pass is the authoritative mechanism (it's what makes Stop work across
  // a navigation, where this in-memory controller no longer exists), but
  // aborting the current wait too makes Stop feel instant when possible.
  var currentAbortController = null;

  function freshAbort() {
    currentAbortController = new AbortController();
    return currentAbortController;
  }

  async function finalizeRun(runState, status, reason) {
    WSRunState.setStatus(runState, status, { stopReason: reason });
    await setRunState(runState.hostname, runState);
    console.log(LOG_PREFIX, 'RUN ' + status.toUpperCase(), 'reason:', reason, 'rows:', runState.rows.length);
  }

  function resolveNextButton(nextButtonConfig) {
    if (!nextButtonConfig || !nextButtonConfig.relativeSelector) {
      return { found: false };
    }
    var el;
    try {
      el = document.querySelector(nextButtonConfig.relativeSelector);
    } catch (e) {
      el = null;
    }
    if (!el) return { found: false };

    var disabled = !!(el.disabled || el.hasAttribute('disabled') ||
      el.getAttribute('aria-disabled') === 'true' ||
      Array.prototype.some.call(el.classList || [], function (c) { return /disabled/i.test(c); }));
    if (!disabled) {
      var style = window.getComputedStyle(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) disabled = true;
    }
    return { found: true, element: el, disabled: disabled };
  }

  // =====================================================================
  // AUTO SCROLL
  // =====================================================================

  async function runAutoScrollLoop(runState) {
    var controller = freshAbort();
    console.log(LOG_PREFIX, 'AUTO SCROLL start', { limits: runState.limits, dedupeKey: runState.dedupeKey });

    while (true) {
      var fresh = await getRunState(runState.hostname);
      if (!fresh || fresh.status !== 'running') {
        console.log(LOG_PREFIX, 'AUTO SCROLL loop exiting — status is', fresh && fresh.status);
        return;
      }
      runState = fresh;

      var extraction = WSScraper.runExtraction(runState.scraperConfig);
      var mergeResult = WSRunState.mergeNewRows(runState, extraction.rows, runState.scraperConfig.columns);
      runState = mergeResult.runState;
      runState.progress.lastPassNewRows = mergeResult.newUniqueCount;
      runState.progress.noNewDataStreak = mergeResult.newUniqueCount > 0 ? 0 : runState.progress.noNewDataStreak + 1;

      console.log(LOG_PREFIX, 'AUTO SCROLL pass', {
        scrollNumber: runState.progress.scrollCount,
        scrollHeight: WSDomWait.getScrollMetrics().scrollHeight,
        rowsFound: extraction.rows.length,
        newRows: mergeResult.newUniqueCount,
        totalRows: runState.rows.length
      });

      await setRunState(runState.hostname, runState);

      var stopCheck = WSRunState.evaluateAutoScrollStop(runState);
      if (stopCheck.shouldStop) {
        await finalizeRun(runState, 'completed', stopCheck.reason);
        return;
      }

      if (WSDomWait.isAtBottom(80)) {
        // one more chance in case more content is still lazy-loading
        await WSDomWait.sleep(500, controller.signal);
        if (WSDomWait.isAtBottom(80)) {
          await finalizeRun(runState, 'completed', 'reached-bottom');
          return;
        }
      }

      WSDomWait.incrementalScroll(0.8);
      runState.progress.scrollCount++;
      await setRunState(runState.hostname, runState);

      var waitResult = await WSDomWait.waitForDomStable({ quietMs: 500, timeoutMs: 5000, signal: controller.signal });
      if (waitResult.reason === 'aborted') {
        console.log(LOG_PREFIX, 'AUTO SCROLL abort observed mid-wait');
        return; // storage state was already set to stopped by whoever aborted us
      }
    }
  }

  // =====================================================================
  // MULTI-PAGE (V1.19: now supports two `paginationMethod`s —
  // 'nextButton', the original V1.3 click-driven mechanism, and
  // 'urlPattern', new — plus a spec #6 configurable delay/retry-count
  // and a spec #17/#36 origin guard, all of it opt-in-by-default-absence
  // so an old saved scraper — no paginationMethod field at all —
  // resolves to 'nextButton' with delayMs:0/retryCount:0 and behaves
  // byte-for-byte like V1.3/V1.18.)
  // =====================================================================

  /** V1.20: builds an onRetry callback bound to one specific runState —
   * writes a short human-readable retry status into progress and
   * persists it immediately, so a popup watching this run's storage key
   * sees "Retrying (2 of 3)…" live rather than the page just silently
   * going quiet mid-retry. Fire-and-forget (the retry loop itself
   * doesn't need to wait on this write landing). */
  function makeRetryReporter(runState) {
    return function (attempt, maxAttempts) {
      runState.progress.retriesUsed = attempt;
      runState.progress.retryStatus = 'Retrying (' + attempt + ' of ' + maxAttempts + ')…';
      setRunState(runState.hostname, runState);
    };
  }

  var RETRY_BACKOFF_MAX_MS = 30000; // never wait longer than this between retries, however high retryCount is configured

  /** V1.20: attempt 0's wait is always exactly `delayMs` (spec #6's
   * "Delay Between Pages" pacing feature — unchanged from V1.19). Every
   * RETRY after a genuine timeout backs off exponentially instead of
   * repeating the same fixed delay, so a real transient hiccup gets
   * progressively more room to clear without a high retryCount turning
   * into a tight, site-hammering loop. Base grows from whichever is
   * larger of the configured delayMs or a sensible 1000ms floor (so
   * retries still back off meaningfully even when delayMs is 0, the
   * default), capped at RETRY_BACKOFF_MAX_MS. */
  function retryBackoffMs(attempt, delayMs) {
    if (attempt === 0) return delayMs;
    var base = Math.max(delayMs, 1000);
    return Math.min(base * Math.pow(2, attempt - 1), RETRY_BACKOFF_MAX_MS);
  }

  /** Runs one trigger (a Next-button click or a URL-pattern navigation)
   * and waits for it to take effect, retrying up to `retryCount` extra
   * times on a timeout before giving up — spec #6's "Retry Count" /
   * spec #14's "navigation timeout" handling, now with exponential
   * backoff between retries (V1.20). `onRetry(attempt, maxAttempts)`,
   * if given, lets the caller surface a user-visible "Retrying (2 of
   * 3)…" status (V1.20 spec: "user-visible error/retry status instead
   * of silent failure") — purely a reporting hook, never affects control
   * flow. */
  async function triggerAndWaitWithRetry(triggerFn, urlBefore, controller, retryCount, delayMs, onRetry) {
    var attempt = 0;
    while (true) {
      var waitMs = retryBackoffMs(attempt, delayMs);
      if (waitMs > 0) {
        var slept = await WSDomWait.sleep(waitMs, controller.signal);
        if (slept === 'aborted') return 'aborted';
      }
      var navResult = await WSDomWait.waitForNavigationOrMutation({
        timeoutMs: 6000,
        urlBefore: urlBefore,
        signal: controller.signal,
        // Fired only once the observer/URL-poll are already armed, so a
        // click/navigation that mutates synchronously (very common) is
        // never missed — see domwait.js for why ordering matters here.
        trigger: triggerFn
      });
      if (navResult !== 'timeout' || attempt >= retryCount) return navResult;
      attempt++;
      console.log(LOG_PREFIX, 'page-change action timed out — retrying (attempt ' + (attempt + 1) + ' of ' + (retryCount + 1) + ')');
      if (typeof onRetry === 'function') onRetry(attempt, retryCount + 1);
    }
  }

  /** Resolves this pass's next action, independent of which pagination
   * method is configured — 'nextButton' resolves the on-page control
   * (unchanged V1.3 behavior); 'urlPattern' computes the next URL from
   * runState.urlPatternConfig (V1.19 new) without needing any selector
   * at all. Both shapes converge on {found, disabled, trigger, label}
   * so the calling loop stays method-agnostic. */
  function resolveNextAction(runState) {
    if (runState.paginationMethod === 'urlPattern') {
      var cfg = runState.urlPatternConfig;
      if (!cfg || !cfg.key) return { found: false };
      var currentValue = typeof runState.progress.urlPatternValue === 'number' ? runState.progress.urlPatternValue : cfg.start;
      var step = cfg.step > 0 ? cfg.step : 1;
      var nextValue = currentValue + step;
      var nextUrl = WSRunState.buildNextPageUrl(location.href, cfg, nextValue);
      if (!nextUrl) return { found: false }; // the live URL no longer matches the configured pattern shape
      if (!WSRunState.isSameOrigin(nextUrl, runState.hostname)) return { found: false, originBlocked: true };
      return {
        found: true, disabled: false, nextValue: nextValue,
        trigger: function () { location.href = nextUrl; }
      };
    }
    var nextInfo = resolveNextButton(runState.nextButtonConfig);
    if (!nextInfo.found || nextInfo.disabled) return nextInfo;
    return {
      found: true, disabled: false,
      trigger: function () { nextInfo.element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); }
    };
  }

  async function runMultiPageLoop(runState) {
    var controller = freshAbort();
    console.log(LOG_PREFIX, 'MULTI-PAGE resume/continue', { page: runState.progress.pageNumber, url: location.href, method: runState.paginationMethod || 'nextButton' });

    while (true) {
      var fresh = await getRunState(runState.hostname);
      if (!fresh || fresh.status !== 'running') {
        console.log(LOG_PREFIX, 'MULTI-PAGE loop exiting — status is', fresh && fresh.status);
        return;
      }
      runState = fresh;

      var waitResult = await WSDomWait.waitForDomStable({ quietMs: 400, timeoutMs: 5000, signal: controller.signal });
      if (waitResult.reason === 'aborted') return;

      var extraction = WSScraper.runExtraction(runState.scraperConfig);
      var mergeResult = WSRunState.mergeNewRows(runState, extraction.rows, runState.scraperConfig.columns);
      runState = mergeResult.runState;
      runState.progress.lastPassNewRows = mergeResult.newUniqueCount;

      var signature = WSRunState.computePageSignature(location.href, extraction.rows, runState.scraperConfig.columns);

      console.log(LOG_PREFIX, 'MULTI-PAGE page', {
        pageNumber: runState.progress.pageNumber,
        url: location.href,
        signature: signature,
        rowsFound: extraction.rows.length,
        newRows: mergeResult.newUniqueCount,
        totalRows: runState.rows.length,
        method: runState.paginationMethod || 'nextButton'
      });

      if (WSRunState.isPageSignatureRepeated(runState, signature)) {
        console.log(LOG_PREFIX, 'STOP REASON: loop (page signature repeated)');
        await finalizeRun(runState, 'stopped', 'loop');
        return;
      }
      runState.pageSignatures.push(signature);
      await setRunState(runState.hostname, runState);

      var stopCheck = WSRunState.evaluateMultiPageStop(runState);
      if (stopCheck.shouldStop) {
        await finalizeRun(runState, 'completed', stopCheck.reason);
        return;
      }

      var nextInfo = resolveNextAction(runState);
      if (nextInfo.originBlocked) {
        console.log(LOG_PREFIX, 'STOP REASON: origin-changed (URL-pattern target left the site)');
        await finalizeRun(runState, 'stopped', 'origin-changed');
        return;
      }
      if (!nextInfo.found) {
        console.log(LOG_PREFIX, 'STOP REASON: next-not-found');
        await finalizeRun(runState, 'error', 'next-not-found');
        return;
      }
      if (nextInfo.disabled) {
        console.log(LOG_PREFIX, 'STOP REASON: disabled-next (treated as natural completion)');
        await finalizeRun(runState, 'completed', 'disabled-next');
        return;
      }

      var urlBefore = location.href;
      runState.status = 'waiting';
      runState.progress.pageNumber++;
      if (typeof nextInfo.nextValue === 'number') runState.progress.urlPatternValue = nextInfo.nextValue;
      await setRunState(runState.hostname, runState);

      var limits = runState.limits || WSRunState.DEFAULT_MULTI_PAGE_LIMITS;
      var navResult = await triggerAndWaitWithRetry(nextInfo.trigger, urlBefore, controller, limits.retryCount || 0, limits.delayMs || 0, makeRetryReporter(runState));
      console.log(LOG_PREFIX, 'navigation result:', navResult);
      runState.progress.retriesUsed = 0;
      runState.progress.retryStatus = null; // clear any "Retrying…" status now that this attempt has settled, one way or another

      if (navResult === 'aborted') return;

      if (navResult === 'timeout') {
        console.log(LOG_PREFIX, 'STOP REASON: page-not-changed');
        var stalled = await getRunState(runState.hostname) || runState;
        await finalizeRun(stalled, 'error', 'page-not-changed');
        return;
      }

      if (navResult === 'url-changed') {
        // spec #17/#36 origin guard: checked HERE, not on the new page —
        // run state is keyed by the run's OWN hostname
        // (ws_run::<hostname>), so a script freshly injected on a
        // different hostname would be reading the WRONG storage key and
        // could never discover (or correctly stop) this run. This
        // instance still has both the real location (just navigated) and
        // the run's expected hostname in hand, so it's the only place
        // this check can actually work.
        if (!WSRunState.isSameOrigin(location.href, runState.hostname)) {
          console.log(LOG_PREFIX, 'STOP REASON: origin-changed');
          var offSite = await getRunState(runState.hostname) || runState;
          await finalizeRun(offSite, 'stopped', 'origin-changed');
          return;
        }
        // A real same-origin navigation is in flight — this script
        // instance's job is done; the freshly-loaded page's own
        // pagination.js instance will see status:'running' in storage
        // and resume automatically.
        var beforeNav = await getRunState(runState.hostname) || runState;
        beforeNav.status = 'running';
        await setRunState(beforeNav.hostname, beforeNav);
        return;
      }

      // 'dom-changed' -> SPA-style same-document update; this script
      // instance is still alive, so just continue the loop.
      runState.status = 'running';
      await setRunState(runState.hostname, runState);
    }
  }

  // =====================================================================
  // LOAD MORE (V1.19 new mode) — structurally the multi-page click loop,
  // but a Load More button virtually never navigates (it appends to the
  // SAME document), so the stop semantics differ in one deliberate way:
  // the button disappearing/becoming disabled is treated as a natural
  // completion (spec #5/#8), never an error — unlike Multi-page's
  // next-not-found, which stays an error (unchanged, V1.3 behavior).
  // =====================================================================

  async function runLoadMoreLoop(runState) {
    var controller = freshAbort();
    console.log(LOG_PREFIX, 'LOAD MORE start/continue', { clicks: runState.progress.clickCount });

    while (true) {
      var fresh = await getRunState(runState.hostname);
      if (!fresh || fresh.status !== 'running') {
        console.log(LOG_PREFIX, 'LOAD MORE loop exiting — status is', fresh && fresh.status);
        return;
      }
      runState = fresh;

      var extraction = WSScraper.runExtraction(runState.scraperConfig);
      var mergeResult = WSRunState.mergeNewRows(runState, extraction.rows, runState.scraperConfig.columns);
      runState = mergeResult.runState;
      runState.progress.lastPassNewRows = mergeResult.newUniqueCount;
      runState.progress.noNewDataStreak = mergeResult.newUniqueCount > 0 ? 0 : runState.progress.noNewDataStreak + 1;

      var signature = WSRunState.computePageSignature(location.href, extraction.rows, runState.scraperConfig.columns);

      console.log(LOG_PREFIX, 'LOAD MORE pass', {
        clickCount: runState.progress.clickCount,
        rowsFound: extraction.rows.length,
        newRows: mergeResult.newUniqueCount,
        totalRows: runState.rows.length
      });

      if (WSRunState.isPageSignatureRepeated(runState, signature)) {
        console.log(LOG_PREFIX, 'STOP REASON: loop (content signature repeated)');
        await finalizeRun(runState, 'stopped', 'loop');
        return;
      }
      runState.pageSignatures.push(signature);
      await setRunState(runState.hostname, runState);

      var stopCheck = WSRunState.evaluateLoadMoreStop(runState);
      if (stopCheck.shouldStop) {
        await finalizeRun(runState, 'completed', stopCheck.reason);
        return;
      }

      var btnInfo = resolveNextButton(runState.nextButtonConfig);
      if (!btnInfo.found) {
        // Never found even once (the very first pass) means the
        // configured button doesn't actually exist here — a real setup
        // problem, reported as an error exactly like Multi-page's
        // next-not-found. Disappearing AFTER at least one successful
        // click, though, is Load More's normal "reached the end" signal.
        if (runState.progress.clickCount === 0) {
          console.log(LOG_PREFIX, 'STOP REASON: next-not-found (Load More button never found)');
          await finalizeRun(runState, 'error', 'next-not-found');
        } else {
          console.log(LOG_PREFIX, 'STOP REASON: button-gone (treated as natural completion)');
          await finalizeRun(runState, 'completed', 'button-gone');
        }
        return;
      }
      if (btnInfo.disabled) {
        console.log(LOG_PREFIX, 'STOP REASON: disabled-next (treated as natural completion)');
        await finalizeRun(runState, 'completed', 'disabled-next');
        return;
      }

      var urlBefore = location.href;
      runState.status = 'waiting';
      runState.progress.clickCount++;
      await setRunState(runState.hostname, runState);

      var limits = runState.limits || WSRunState.DEFAULT_LOAD_MORE_LIMITS;
      var navResult = await triggerAndWaitWithRetry(function () {
        btnInfo.element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }, urlBefore, controller, limits.retryCount || 0, limits.delayMs || 0, makeRetryReporter(runState));
      console.log(LOG_PREFIX, 'load-more result:', navResult);
      runState.progress.retriesUsed = 0;
      runState.progress.retryStatus = null;

      if (navResult === 'aborted') return;

      if (navResult === 'timeout') {
        console.log(LOG_PREFIX, 'STOP REASON: page-not-changed (no new content after clicking)');
        var stalled = await getRunState(runState.hostname) || runState;
        await finalizeRun(stalled, 'error', 'page-not-changed');
        return;
      }

      if (navResult === 'url-changed') {
        // Unusual for Load More (spec #5 expects a same-document
        // append), but tolerated rather than assumed impossible — same
        // origin guard + resume-on-load handoff as Multi-page (see that
        // loop's identical branch for why the check must happen here).
        if (!WSRunState.isSameOrigin(location.href, runState.hostname)) {
          console.log(LOG_PREFIX, 'STOP REASON: origin-changed');
          var offSite = await getRunState(runState.hostname) || runState;
          await finalizeRun(offSite, 'stopped', 'origin-changed');
          return;
        }
        var beforeNav = await getRunState(runState.hostname) || runState;
        beforeNav.status = 'running';
        await setRunState(beforeNav.hostname, beforeNav);
        return;
      }

      // 'dom-changed' — the expected case: new items appended in place.
      runState.status = 'running';
      await setRunState(runState.hostname, runState);
    }
  }

  // =====================================================================
  // Resume-on-load bootstrap: meaningful for multi-page AND load-more
  // (V1.19 — Load More tolerates a real navigation, see runLoadMoreLoop's
  // 'url-changed' branch, so it needs the exact same fresh-script-
  // instance handoff multi-page has always used). Auto Scroll never
  // navigates, so it never needs to be picked back up by a fresh script
  // instance — its whole run lives within one instance's lifetime,
  // kicked off explicitly by START_AUTO_SCROLL.
  // =====================================================================

  // NOTE on the origin guard (spec #17/#36): run state is stored under a
  // key scoped to the run's OWN hostname (ws_run::<hostname>), so a
  // freshly-injected script on a page that navigated OFF that hostname
  // would be looking at the WRONG storage key here — it can't discover
  // (or correct) a run it doesn't share a key with. The guard is
  // therefore checked earlier, by the OUTGOING script instance itself,
  // right when it observes 'url-changed' (see runMultiPageLoop's/
  // runLoadMoreLoop's own 'url-changed' branches) — it still has both
  // the run's real hostname AND the new location in hand at that exact
  // moment, and writes the stop directly to the correct (original) key.
  (function bootstrapResume() {
    getRunState(hostname()).then(function (runState) {
      if (runState && (runState.mode === 'multi-page' || runState.mode === 'load-more') && runState.status === 'running') {
        console.log(LOG_PREFIX, 'bootstrap: resuming active ' + runState.mode + ' run after navigation', runState.runId);
        if (runState.mode === 'load-more') runLoadMoreLoop(runState);
        else runMultiPageLoop(runState);
      }
    });
  })();

  // =====================================================================
  // Messages (separate listener from content.js's — never interferes
  // with column-picking / RUN_EXTRACTION / PING)
  // =====================================================================

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return;

    if (message.type === 'START_AUTO_SCROLL') {
      var asState = WSRunState.createRunState({
        tabId: message.tabId,
        hostname: hostname(),
        mode: 'auto-scroll',
        containerSelector: message.containerSelector,
        columns: message.columns,
        dedupeKey: message.dedupeKey,
        limits: message.limits
      });
      WSRunState.setStatus(asState, 'running');
      setRunState(hostname(), asState).then(function () {
        sendResponse({ ok: true, runId: asState.runId });
        runAutoScrollLoop(asState);
      });
      return true;
    }

    if (message.type === 'START_MULTI_PAGE') {
      var mpState = WSRunState.createRunState({
        tabId: message.tabId,
        hostname: hostname(),
        mode: 'multi-page',
        containerSelector: message.containerSelector,
        columns: message.columns,
        dedupeKey: message.dedupeKey,
        limits: message.limits,
        nextButtonConfig: message.nextButtonConfig,
        // V1.19 additive — both undefined for a pre-V1.19 caller,
        // createRunState defaults paginationMethod to 'nextButton'.
        paginationMethod: message.paginationMethod,
        urlPatternConfig: message.urlPatternConfig
      });
      WSRunState.setStatus(mpState, 'running');
      setRunState(hostname(), mpState).then(function () {
        sendResponse({ ok: true, runId: mpState.runId });
        runMultiPageLoop(mpState);
      });
      return true;
    }

    // V1.19 new mode.
    if (message.type === 'START_LOAD_MORE') {
      var lmState = WSRunState.createRunState({
        tabId: message.tabId,
        hostname: hostname(),
        mode: 'load-more',
        containerSelector: message.containerSelector,
        columns: message.columns,
        dedupeKey: message.dedupeKey,
        limits: message.limits,
        nextButtonConfig: message.nextButtonConfig
      });
      WSRunState.setStatus(lmState, 'running');
      setRunState(hostname(), lmState).then(function () {
        sendResponse({ ok: true, runId: lmState.runId });
        runLoadMoreLoop(lmState);
      });
      return true;
    }

    if (message.type === 'STOP_RUN') {
      if (currentAbortController) currentAbortController.abort(); // fast path, if we're the live instance
      getRunState(hostname()).then(function (rs) {
        if (!rs) { sendResponse({ ok: true }); return; }
        WSRunState.setStatus(rs, 'stopped', { stopReason: 'user' });
        setRunState(hostname(), rs).then(function () { sendResponse({ ok: true }); });
      });
      return true;
    }

    // V1.20 — a genuinely distinct action from Stop (same abort/storage
    // mechanics, different resulting status). Works for every mode —
    // auto-scroll/multi-page/load-more all share the same top-of-loop
    // "still status:'running'?" check, so writing 'paused' here makes
    // whichever loop is currently live exit cleanly exactly like Stop
    // already does, with all rows/progress collected so far intact.
    if (message.type === 'PAUSE_RUN') {
      if (currentAbortController) currentAbortController.abort();
      getRunState(hostname()).then(function (rs) {
        if (!rs) { sendResponse({ ok: true }); return; }
        WSRunState.pauseRunState(rs);
        setRunState(hostname(), rs).then(function () { sendResponse({ ok: true }); });
      });
      return true;
    }

    if (message.type === 'RESUME_RUN') {
      getRunState(hostname()).then(function (rs) {
        if (!rs) { sendResponse({ ok: false, error: 'No paused run found on this page.' }); return; }
        WSRunState.resumeRunState(rs);
        setRunState(hostname(), rs).then(function () {
          sendResponse({ ok: true });
          if (rs.mode === 'auto-scroll') runAutoScrollLoop(rs);
          else if (rs.mode === 'load-more') runLoadMoreLoop(rs);
          else runMultiPageLoop(rs);
        });
      });
      return true;
    }

    if (message.type === 'GET_RUN_STATE') {
      getRunState(hostname()).then(function (rs) { sendResponse({ ok: true, runState: rs }); });
      return true;
    }
  });
})();
