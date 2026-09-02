/**
 * realdomdiag.js
 * REAL AMAZON EVIDENCE mission — TEMPORARY, READ-ONLY, evidence-only
 * diagnostic. Exists to capture what content/autodetect.js and the real
 * page DOM actually look like on a real, live Amazon tab, since every
 * synthetic unit fixture built so far has been proven (by repeated real-
 * Chrome retests) to not represent the real Amazon markup closely
 * enough. This file does NOT change, call, or depend on any production
 * decision logic beyond READING content/autodetect.js's own existing,
 * already-read-only runAutoDetectDiagnostic() output — it never calls
 * runAutoDetect() itself, never triggers a scrape, never touches
 * content/nextdetect.js, never clicks/triggers anything, never writes to
 * chrome.storage, never navigates. Every function below only ever reads
 * document.* and returns plain data.
 *
 * Reachable only via the dev-only "📋 Copy Real DOM Diagnostic" button
 * (popup.html/popup.js, gated behind WSLicense.isDevelopmentInstall(),
 * same contract as every other Copy *Diagnostic button in this codebase)
 * and the RUN_REAL_DOM_DIAGNOSTIC message this file's own listener
 * handles below.
 */
(function (root) {
  'use strict';

  function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max) + '…[truncated, ' + str.length + ' chars total]' : str;
  }

  function abbreviatedOuterHTML(el, max) {
    try { return truncate(el.outerHTML, max || 1000); } catch (e) { return '(outerHTML read failed: ' + (e && e.message || e) + ')'; }
  }

  /** Climbs from `el` (inclusive) looking for the nearest ancestor
   * carrying `attrName` — read-only, bounded depth. */
  function nearestAncestorWithAttr(el, attrName) {
    var node = el;
    var guard = 0;
    while (node && node.nodeType === 1 && guard < 40) {
      if (node.hasAttribute && node.hasAttribute(attrName)) {
        return { tagName: node.tagName, value: node.getAttribute(attrName), outerHTMLAbbrev: abbreviatedOuterHTML(node, 300) };
      }
      node = node.parentElement;
      guard++;
    }
    return null;
  }

  /**
   * PART A — ROW DETECTION evidence. Calls content/autodetect.js's own,
   * completely unmodified, already read-only runAutoDetectDiagnostic()
   * (the exact same function the pre-existing "Copy AUTO Diagnostic"
   * button already uses) and reshapes its output into the exact fields
   * requested, plus raw inspection of the first 10 elements the WINNING
   * selector actually matches on the real page right now, plus Amazon
   * data-attribute evidence (data-component-type/data-asin) gathered
   * purely for diagnostic purposes — never fed back into any selection
   * decision.
   */
  function collectRowDetectionEvidence() {
    var out = { available: false };
    if (!root.WSAutoDetect || typeof root.WSAutoDetect.runAutoDetectDiagnostic !== 'function') {
      out.error = 'WSAutoDetect.runAutoDetectDiagnostic is not available in this page context';
      return out;
    }
    var diag;
    try { diag = root.WSAutoDetect.runAutoDetectDiagnostic(); } catch (e) {
      out.error = 'runAutoDetectDiagnostic() threw: ' + (e && e.message || e);
      return out;
    }
    out.available = true;
    out.winnerReason = diag.winnerReason || null;
    out.finalStructureCount = diag.finalStructureCount;
    out.rejectedCandidateCount = diag.rejectedCandidateCount;
    out.cohesionRejectedCount = diag.cohesionRejectedCount;
    out.scopeDriftRejectedCount = diag.scopeDriftRejectedCount;
    out.fragmentGroupsConsolidated = diag.fragmentGroupsConsolidated;
    out.anchoredCandidateCount = diag.anchoredCandidateCount;
    out.fieldAnchoredCandidateCount = diag.fieldAnchoredCandidateCount;

    out.finalSelectedContainerSelector = diag.winner ? diag.winner.containerSelector : null;
    out.finalMatchedElementCount = diag.winner ? diag.winner.matchedElementCount : null;

    // Merge topCandidatesBeforeRanking (has fragmentation/elementsPerParent
    // — see content/autodetect.js's own summarizeRawCandidate()) with
    // topCandidatesAfterRanking (has the built selector/score/per-field
    // coverage/cohesion — see its own finalStructures push) by
    // candidateId, so every requested field is available in ONE place
    // per candidate without reimplementing anything.
    var beforeByIndex = {};
    (diag.topCandidatesBeforeRanking || []).forEach(function (c) { beforeByIndex[c.candidateId] = c; });
    out.topCandidates = (diag.topCandidatesAfterRanking || []).map(function (c) {
      var before = (typeof c.candidateId === 'number') ? beforeByIndex[c.candidateId] : null;
      return {
        selector: c.containerSelector,
        elementCount: (c.matchedElementCount != null) ? c.matchedElementCount : c.itemCount,
        score: c.score,
        coveragePerField: (c.fields || []).map(function (f) { return { name: f.name, attribute: f.attribute, coverage: f.coverage }; }),
        cohesion: c.rowCohesion || null,
        fragmentationPenaltyApplied: before ? before.fragmentationPenaltyApplied : null,
        elementsPerParent: before ? before.elementsPerParent : null,
        consolidatedFromParentCount: before ? before.consolidatedFromParentCount : null,
        anchoredFromHeading: !!c.anchoredFromHeading,
        fieldAnchored: !!c.fieldAnchored,
        source: c.source || 'repeating-group'
      };
    });
    // Also include raw rejected candidates (largest-first, already capped
    // to 40 by runAutoDetectDiagnostic itself) so a candidate that never
    // reached the "final" stage is still visible with its own reason.
    out.rejectedCandidates = (diag.rejectedCandidates || []).map(function (c) {
      return {
        approxSelector: c.approxSelector, itemCount: c.itemCount, score: c.score,
        elementsPerParent: c.elementsPerParent, fragmentationPenaltyApplied: c.fragmentationPenaltyApplied,
        rejectionReason: c.rejectionReason
      };
    });

    out.firstRowElements = [];
    if (out.finalSelectedContainerSelector) {
      var matches;
      try { matches = document.querySelectorAll(out.finalSelectedContainerSelector); } catch (e) { matches = []; }
      for (var i = 0; i < Math.min(10, matches.length); i++) {
        var el = matches[i];
        out.firstRowElements.push({
          index: i,
          tagName: el.tagName,
          className: (el.className && el.className.baseVal) || el.className || '',
          id: el.id || '',
          dataComponentType: (el.getAttribute && el.getAttribute('data-component-type')) || null,
          dataAsin: (el.getAttribute && el.getAttribute('data-asin')) || null,
          nearestAncestorWithDataComponentType: nearestAncestorWithAttr(el, 'data-component-type'),
          nearestAncestorWithDataAsin: nearestAncestorWithAttr(el, 'data-asin'),
          outerHTMLAbbrev: abbreviatedOuterHTML(el, 1000)
        });
      }
    }

    // Amazon data-attribute evidence — PURELY diagnostic (never used to
    // drive any actual selection decision in autodetect.js/nextdetect.js;
    // this file doesn't modify either).
    var asinEls = document.querySelectorAll('[data-asin]');
    var uniqueAsins = {};
    Array.prototype.forEach.call(asinEls, function (el) {
      var v = el.getAttribute('data-asin');
      if (v) uniqueAsins[v] = true;
    });
    out.uniqueNonEmptyDataAsinCount = Object.keys(uniqueAsins).length;
    out.searchResultComponentCount = document.querySelectorAll('[data-component-type="s-search-result"][data-asin]').length;

    return out;
  }

  function describePaginationCandidate(el) {
    var parent = el.parentElement;
    return {
      tagName: el.tagName,
      className: (el.className && el.className.baseVal) || el.className || '',
      textContent: truncate((el.textContent || '').replace(/\s+/g, ' ').trim(), 200),
      ariaLabel: (el.getAttribute && el.getAttribute('aria-label')) || null,
      href: (el.tagName === 'A' && el.getAttribute) ? (el.getAttribute('href') || null) : null,
      rel: (el.getAttribute && el.getAttribute('rel')) || null,
      disabled: !!(el.disabled || (el.hasAttribute && el.hasAttribute('disabled'))),
      ariaDisabled: (el.getAttribute && el.getAttribute('aria-disabled')) || null,
      parentTagName: parent ? parent.tagName : null,
      parentClassName: parent ? ((parent.className && parent.className.baseVal) || parent.className || '') : null,
      outerHTMLAbbrev: abbreviatedOuterHTML(el, 1000)
    };
  }

  /** PART B — REAL PAGINATION DOM evidence. Raw, unfiltered queries for
   * every selector/pattern the mission listed explicitly — deliberately
   * NOT routed through content/nextdetect.js's own tier logic (that
   * logic is exactly what real-Chrome evidence is needed to evaluate),
   * so this reports what genuinely EXISTS on the page regardless of
   * whether the current detector would ever consider it. */
  function collectPaginationEvidence() {
    var out = {};

    function addAll(label, selector) {
      var matches;
      try { matches = document.querySelectorAll(selector); } catch (e) { out[label] = { selector: selector, error: String(e && e.message || e) }; return; }
      out[label] = { selector: selector, count: matches.length, elements: Array.prototype.slice.call(matches).map(describePaginationCandidate) };
    }
    addAll('dotSPaginationNext', '.s-pagination-next');
    addAll('aDotSPaginationNext', 'a.s-pagination-next');
    addAll('ariaLabelNextUpper', '[aria-label*="Next" i]');
    addAll('ariaLabelNextLower', '[aria-label*="next" i]');

    // href-substring checks require iterating anchors directly — CSS has
    // no case-insensitive-substring href selector without a fixed case.
    var allAnchors = Array.prototype.slice.call(document.querySelectorAll('a[href]'));
    var hrefPageParam = allAnchors.filter(function (a) { return (a.getAttribute('href') || '').indexOf('page=') !== -1; });
    var hrefRefSrPg = allAnchors.filter(function (a) { return (a.getAttribute('href') || '').indexOf('ref=sr_pg_') !== -1; });
    out.hrefContainsPageParam = { count: hrefPageParam.length, elements: hrefPageParam.slice(0, 20).map(describePaginationCandidate) };
    out.hrefContainsRefSrPg = { count: hrefRefSrPg.length, elements: hrefRefSrPg.slice(0, 20).map(describePaginationCandidate) };

    // Closest ancestor HTML for the visible pagination bar (Previous /
    // page numbers / Next together) — tries Amazon's own well-documented
    // class first (diagnostic evidence only, exactly what the mission
    // asked to check — never shipped as production selection logic),
    // then falls back to a fully generic "smallest element whose own
    // text contains both a previous-like and a next-like word" search.
    var barEl = document.querySelector('.s-pagination-strip') || document.querySelector('nav[aria-label*="pagination" i], [class*="pagination" i]') || null;
    if (!barEl) {
      var all = document.querySelectorAll('body *');
      var best = null, bestLen = Infinity;
      for (var i = 0; i < all.length; i++) {
        var t = (all[i].textContent || '');
        if (t.length < bestLen && /previous|önceki/i.test(t) && /\bnext\b|\bsonraki\b/i.test(t)) {
          best = all[i]; bestLen = t.length;
        }
      }
      barEl = best;
    }
    out.paginationBar = barEl ? {
      tagName: barEl.tagName, className: (barEl.className && barEl.className.baseVal) || barEl.className || '',
      outerHTMLAbbrev: abbreviatedOuterHTML(barEl, 3000)
    } : { note: 'no pagination bar found via .s-pagination-strip, a pagination landmark, or the generic Previous+Next text heuristic' };

    return out;
  }

  function collectRealDomDiagnostic() {
    return {
      generatedAt: new Date().toISOString(),
      url: location.href,
      documentReadyState: document.readyState,
      rowDetection: collectRowDetectionEvidence(),
      pagination: collectPaginationEvidence()
    };
  }

  root.WSRealDomDiag = { collect: collectRealDomDiagnostic };

  if (!window.__wsRealDomDiagListenerRegistered) {
    window.__wsRealDomDiagListenerRegistered = true;
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || message.type !== 'RUN_REAL_DOM_DIAGNOSTIC') return;
      // Read-only DOM inspection is synchronous, but still respond async
      // so a slow/large page doesn't block the message channel opening —
      // same pattern content/autodetect.js's own RUN_AUTO_DETECT_DIAGNOSTIC
      // handler already uses.
      setTimeout(function () {
        try {
          sendResponse({ ok: true, report: collectRealDomDiagnostic() });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message || e) });
        }
      }, 0);
      return true;
    });
  }
})(typeof window !== 'undefined' ? window : globalThis);
