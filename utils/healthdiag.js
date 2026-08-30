/**
 * healthdiag.js
 * SELF-DIAGNOSTICS / HEALTH CHECK mission — the shared, bounded diagnostic
 * EVENT BUFFER every context (popup, background) writes into so the
 * dev-only "Sağlık Kontrolü" panel can explain a run's full lifecycle
 * without the user chasing DevTools logs across contexts.
 *
 * Deliberately NOT a duplicate of content/discovery.js's own
 * ws_pagination_diag ring buffer (mission: "do not create conflicting
 * duplicate systems if they can be unified") — that buffer already owns
 * PER-PAGE discovery/pagination events in full detail and keeps doing so,
 * completely unmodified. THIS buffer covers the lifecycle stages that
 * buffer was never scoped to: the START FLOW (popup.js, before
 * START_DISCOVERY is even sent) and Detail Enrichment (background.js).
 * The Health Check panel reads BOTH buffers and merges them into one
 * report/summary — see popup.js's gatherHealthCheckInput().
 *
 * Two independent SCOPES share one physical key/buffer:
 *   - 'main'   — the main-scrape start flow (popup.js)
 *   - 'detail' — Detail Enrichment (background.js)
 * clearScope() removes only that scope's own entries, never the other's —
 * "new main scrape clears main-run diagnostics, new Detail run clears
 * Detail-run diagnostics" (mission section 7) is a PARTIAL clear, not a
 * full-buffer wipe.
 *
 * Same architecture as content/discovery.js's pushPageDiag (bounded ring
 * buffer, serialized fire-and-forget writes, hard size guard on any one
 * entry, never throws) — kept as an independent local implementation
 * rather than a cross-file call, matching this project's own established
 * "local copy of a shared pattern" convention (see DETAIL_FIELD_MAX_BYTES/
 * DEEP_SCRAPE_FIELD_MAX_BYTES for a prior example) — this one, unlike
 * that one, genuinely needs to run in THREE different contexts (content
 * script, popup, background service worker) via three different loading
 * mechanisms (dynamic script injection, <script> tag, importScripts), so
 * it earns being a real shared module instead.
 *
 * No chrome.storage.local size explosion risk: every entry is capped at
 * HEALTH_DIAG_ENTRY_MAX_BYTES, the whole buffer at HEALTH_DIAG_MAX_ENTRIES
 * — see sanitizeEntry() below. Never stores DOM/HTML/full rows/
 * screenshots/large result payloads (mission section 7).
 */
(function (root) {
  'use strict';

  var HEALTH_DIAG_KEY = 'ws_health_diag';
  var HEALTH_DIAG_MAX_ENTRIES = 200;
  var HEALTH_DIAG_ENTRY_MAX_BYTES = 2000;
  var writeQueue = Promise.resolve();

  function storageGet(key) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([key], function (result) { resolve((result && result[key]) || null); });
      } catch (e) { resolve(null); }
    });
  }

  function storageSet(data) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.set(data, function () { resolve(); });
      } catch (e) { resolve(); }
    });
  }

  function emptyContainer() {
    return { schemaVersion: 1, entries: [] };
  }

  /** Defensive backstop, identical reasoning to content/discovery.js's own
   * sanitizeDiagEntry(): no real call site is ever expected to pass
   * anything large (every field below is a short string/small plain
   * object), but this guarantees it structurally even if one did. */
  function sanitizeEntry(entry) {
    try {
      var json = JSON.stringify(entry);
      if (json.length <= HEALTH_DIAG_ENTRY_MAX_BYTES) return entry;
      return {
        t: entry.t, scope: entry.scope, stage: entry.stage,
        reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 200) + '…[truncated — entry exceeded ' + HEALTH_DIAG_ENTRY_MAX_BYTES + ' bytes]' : null,
        data: null,
        truncated: true
      };
    } catch (e) { return { t: entry && entry.t, scope: entry && entry.scope, stage: 'sanitize-error', truncated: true }; }
  }

  /**
   * @param {string} scope 'main' | 'detail'
   * @param {string} stage short label (e.g. 'start-clicked',
   *   'permissions-resolved', 'run-extraction-received')
   * @param {object} [data] small plain object of extra compact fields
   *   (e.g. { rowCount, hostname, runId }) — never DOM/HTML/large arrays.
   * Never throws, never returns a promise the caller is expected to
   * await — same fire-and-forget contract as content/discovery.js's
   * pushPageDiag, for the same reason (a diagnostic write must NEVER be
   * able to affect scraping).
   */
  function pushEvent(scope, stage, data) {
    try {
      var entry = sanitizeEntry({
        t: Date.now(),
        scope: scope,
        stage: stage,
        data: data || null
      });
      writeQueue = writeQueue.then(function () {
        return storageGet(HEALTH_DIAG_KEY).then(function (existing) {
          var buf = ((existing && existing.entries) || []).concat([entry]);
          if (buf.length > HEALTH_DIAG_MAX_ENTRIES) buf = buf.slice(buf.length - HEALTH_DIAG_MAX_ENTRIES);
          var data2 = {};
          data2[HEALTH_DIAG_KEY] = { schemaVersion: 1, entries: buf };
          return storageSet(data2);
        });
      }).catch(function () { /* never let one failed write poison future pushes */ });
    } catch (e) { /* diagnostic-only — must NEVER break the caller's real work */ }
  }

  /** Removes only entries for the given scope, leaving the other scope's
   * own history completely untouched. Returns a promise purely so a test/
   * caller CAN await it if it wants to — production call sites never do
   * (fire-and-forget, same contract as pushEvent). */
  function clearScope(scope) {
    return writeQueue = writeQueue.then(function () {
      return storageGet(HEALTH_DIAG_KEY).then(function (existing) {
        var buf = ((existing && existing.entries) || []).filter(function (e) { return e.scope !== scope; });
        var data = {};
        data[HEALTH_DIAG_KEY] = { schemaVersion: 1, entries: buf };
        return storageSet(data);
      });
    }).catch(function () { /* best-effort */ });
  }

  /** Full buffer (both scopes) — used by the Health Check report/UI. */
  function getBuffer() {
    return storageGet(HEALTH_DIAG_KEY).then(function (c) { return c || emptyContainer(); });
  }

  function flushQueue() { return writeQueue; }

  root.WSHealthDiag = {
    HEALTH_DIAG_KEY: HEALTH_DIAG_KEY,
    HEALTH_DIAG_MAX_ENTRIES: HEALTH_DIAG_MAX_ENTRIES,
    HEALTH_DIAG_ENTRY_MAX_BYTES: HEALTH_DIAG_ENTRY_MAX_BYTES,
    pushEvent: pushEvent,
    clearScope: clearScope,
    getBuffer: getBuffer,
    // Exposed for targeted testing only.
    flushQueue: flushQueue
  };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
