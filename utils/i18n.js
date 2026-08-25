/**
 * i18n.js — V1 FINAL internationalization engine (PART B).
 *
 * ARCHITECTURE DECISION (spec #9 "evaluate the ACTUAL project first"):
 * this is a CENTRALIZED INTERNAL TRANSLATION MODULE, not Chrome's native
 * `_locales/messages.json` + chrome.i18n API. Reasons, concretely:
 *   1. chrome.i18n.getMessage() is locked to the BROWSER's UI language for
 *      the lifetime of the extension context — there is no supported way
 *      to let a user pick a language inside the popup and see it change
 *      immediately. Spec #7 explicitly requires "changing language should
 *      update visible UI immediately, no browser restart required" — the
 *      native API cannot satisfy that requirement at all.
 *   2. This project already has an established "one small self-contained
 *      utils/*.js module + its own chrome.storage.local key" convention
 *      (utils/settings.js, utils/license.js, ...) that a plain internal
 *      module fits naturally, whereas _locales/ is a parallel, separate
 *      packaging concept the rest of the project has no analog for.
 *   3. Interpolation ("{count} runs left") and simple plural selection are
 *      needed (spec #12/#13); Chrome's messages.json supports placeholders
 *      but pluralization would need hand-rolled key suffixes anyway — no
 *      real benefit over doing the same thing in a plain JS object.
 * So: translations live in utils/i18n-data.js as plain, static JS object
 * literals (WSI18nData) — no eval, no new Function, no fetch, no remote
 * dependency (spec #25) — and this file is the small engine that reads
 * them, with English as the unconditional structural fallback (spec #6/9).
 *
 * PERSISTENCE (spec #8): reuses utils/settings.js's EXISTING `ws_settings`
 * storage key/schema — a `language` field lives alongside
 * researchFormatDefaults/exportPreferences, no new storage key invented.
 * `language: 'auto'` (the default) means "follow browser-detected
 * language, re-detected each load"; any other value is an explicit user
 * selection that ALWAYS wins (spec #6) until they change it again.
 *
 * SCOPE (spec #10/#46): every extension-owned string reachable through the
 * PRIMARY user journey (tabs, workflow, saved scrapers, columns, run
 * modes, results toolbar top level, monitor, research, settings, the
 * trial paywall) is translated in all 6 locales. A documented, smaller set
 * of advanced/secondary configuration micro-UI (individual transform
 * operation names, deep-scrape/auto-detect/structured-data sub-field
 * forms, export/download option internals) intentionally ships English-
 * only for V1 and falls back safely — see the coverage report this module
 * can generate (WSI18n.coverageReport()) and "Chrome Extension
 * projeler.txt" for the exact list of intentional exceptions.
 */
(function (root) {
  'use strict';

  var SUPPORTED = ['en', 'tr', 'de', 'fr', 'zh-CN', 'ru'];
  var FALLBACK = 'en';
  var NATIVE_NAMES = { en: 'English', tr: 'Türkçe', de: 'Deutsch', fr: 'Français', 'zh-CN': '简体中文', ru: 'Русский' };

  // Current in-memory language — resolved once per popup session by init()
  // (see popup.js) and never silently changed afterward except by an
  // explicit user action (the language selector), matching every other
  // piece of session state in this project.
  var currentLang = FALLBACK;

  function supportedLocales() { return SUPPORTED.slice(); }
  function nativeName(code) { return NATIVE_NAMES[code] || code; }
  function getCurrentLanguage() { return currentLang; }

  /** Best-effort match of a raw browser/UI locale string (e.g. "tr-TR",
   * "zh-Hans-CN", "de") down to one of our 6 supported codes. Never
   * throws, never returns anything outside SUPPORTED — an unrecognized
   * locale safely resolves to English (spec #6's "else English"). */
  function normalizeLocale(raw) {
    if (!raw || typeof raw !== 'string') return FALLBACK;
    var lower = raw.toLowerCase();
    if (lower.indexOf('zh') === 0) return 'zh-CN'; // V1 ships one Chinese locale (Simplified); Traditional/HK/TW also fall here rather than silently defaulting to English, since Simplified is the closer approximation of the two.
    var base = lower.split('-')[0];
    for (var i = 0; i < SUPPORTED.length; i++) {
      if (SUPPORTED[i].toLowerCase() === base) return SUPPORTED[i];
    }
    return FALLBACK;
  }

  /** Spec #6: "detect Chrome/browser UI language on first install if
   * practical/reliable, else English." chrome.i18n.getUILanguage() is
   * synchronous, permission-free, and available in every extension
   * context — the practical/reliable option. Wrapped defensively: some
   * test/host environments won't have chrome.i18n at all. */
  function detectBrowserLanguage() {
    try {
      if (root.chrome && root.chrome.i18n && typeof root.chrome.i18n.getUILanguage === 'function') {
        return normalizeLocale(root.chrome.i18n.getUILanguage());
      }
    } catch (e) { /* fall through to English */ }
    return FALLBACK;
  }

  /** Resolves the language to actually use this session: an explicit
   * saved selection always wins (spec #6); 'auto' (or missing/corrupt)
   * re-detects from the browser every time, so a user who never chose a
   * language keeps following their browser if it changes. Reads through
   * WSSettings (spec #8's "existing storage architecture") — this
   * function is the ONLY place language persistence is read, mirroring
   * every other module's single-load-point convention. */
  async function resolveLanguage() {
    try {
      var settings = await root.WSSettings.load();
      var saved = settings && settings.language;
      if (saved && saved !== 'auto' && SUPPORTED.indexOf(saved) !== -1) return saved;
    } catch (e) { /* fall through to detection */ }
    return detectBrowserLanguage();
  }

  /** Explicit user selection — spec #6/#8: always wins from now on,
   * persisted through WSSettings so it survives close/reopen/restart/
   * reload/upgrade exactly like every other setting in this project. */
  async function setLanguage(code) {
    if (SUPPORTED.indexOf(code) === -1) return { ok: false, error: 'Unsupported language: ' + code };
    currentLang = code; // switch immediately — the DOM re-render must not wait on a storage round trip
    try {
      await root.WSSettings.setLanguage(code);
    } catch (e) { /* persistence is best-effort; the in-memory language for THIS session is already switched */ }
    return { ok: true };
  }

  /** Simple English pluralization rule (spec #13: "don't overengineer if
   * simple singular/plural keys suffice") — exactly two forms, `_one` for
   * count === 1, `_other` for everything else (0, 2+, negative, etc.).
   * Every locale's data file follows the same two-suffix convention
   * regardless of that language's own real plural rules, deliberately —
   * V1's plural surface is small (run counts, row counts, file counts)
   * and a two-bucket rule reads naturally in all 6 supported languages
   * for these specific phrases. */
  function pluralKey(key, count) {
    return key + (count === 1 || count === -1 ? '_one' : '_other');
  }

  function lookupRaw(lang, key) {
    var table = root.WSI18nData && root.WSI18nData[lang];
    if (!table) return undefined;
    return table[key];
  }

  function interpolate(str, params) {
    if (!params) return str;
    return str.replace(/\{(\w+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    });
  }

  /**
   * The one translation entry point every caller uses.
   * t(key[, params])
   * t(key, { count: N })  — if a `_one`/`_other` pair exists for key, the
   *                          plural form matching N is used automatically.
   * Fallback order (spec #6/#9/#22): current language -> English -> the
   * raw key itself (never undefined/null — spec #9's hard requirement).
   */
  function t(key, params) {
    if (!key || typeof key !== 'string') return '';
    var lookupKey = key;
    if (params && typeof params.count === 'number') {
      var plural = pluralKey(key, params.count);
      if (lookupRaw(currentLang, plural) !== undefined || lookupRaw(FALLBACK, plural) !== undefined) {
        lookupKey = plural;
      }
    }
    var value = lookupRaw(currentLang, lookupKey);
    if (value === undefined) value = lookupRaw(FALLBACK, lookupKey);
    if (value === undefined) return key; // last-resort: never blank/undefined (spec #9/#22)
    return interpolate(value, params);
  }

  /** Applies every `[data-i18n]` / `[data-i18n-title]` /
   * `[data-i18n-aria-label]` / `[data-i18n-placeholder]` element found
   * under `root_` (defaults to `document`) using the CURRENT language.
   * Pure re-render — never touches scraped data, never triggers any
   * network/storage work of its own (spec #26 performance: language
   * switching only relabels UI). Safe to call repeatedly (idempotent). */
  function applyToDom(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;
    var nodes = doc.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute('data-i18n');
      if (!key) continue;
      var params;
      var rawParams = el.getAttribute('data-i18n-params');
      if (rawParams) {
        try { params = JSON.parse(rawParams); } catch (e) { params = undefined; }
      }
      el.textContent = t(key, params);
    }
    var titleNodes = doc.querySelectorAll('[data-i18n-title]');
    for (var j = 0; j < titleNodes.length; j++) {
      var tEl = titleNodes[j];
      var tKey = tEl.getAttribute('data-i18n-title');
      if (tKey) tEl.setAttribute('title', t(tKey));
    }
    var ariaNodes = doc.querySelectorAll('[data-i18n-aria-label]');
    for (var k = 0; k < ariaNodes.length; k++) {
      var aEl = ariaNodes[k];
      var aKey = aEl.getAttribute('data-i18n-aria-label');
      if (aKey) aEl.setAttribute('aria-label', t(aKey));
    }
    var phNodes = doc.querySelectorAll('[data-i18n-placeholder]');
    for (var p = 0; p < phNodes.length; p++) {
      var pEl = phNodes[p];
      var pKey = pEl.getAttribute('data-i18n-placeholder');
      if (pKey) pEl.setAttribute('placeholder', t(pKey));
    }
    // Accessibility (spec #24): keep the document's own declared language
    // in sync so screen readers announce content correctly.
    if (doc.documentElement) doc.documentElement.setAttribute('lang', currentLang);
  }

  /** Resolves the language for this session (spec #6/#8) and applies it
   * to the DOM once. Called once near the very top of popup.js's init(),
   * mirroring the trial-modal-listener ordering fix (V1 FINAL Bug #1) —
   * language should be correct before the user can see or interact with
   * anything. */
  async function init(doc) {
    currentLang = await resolveLanguage();
    applyToDom(doc);
    return currentLang;
  }

  /** spec #45: automated translation-coverage audit. For each supported
   * locale, reports how many of English's own keys exist in that locale
   * vs. fall back to English. English itself is always 100% (it IS the
   * canonical key set). */
  function coverageReport() {
    var enTable = (root.WSI18nData && root.WSI18nData.en) || {};
    var enKeys = Object.keys(enTable);
    var report = {};
    for (var i = 0; i < SUPPORTED.length; i++) {
      var lang = SUPPORTED[i];
      if (lang === FALLBACK) { report[lang] = { total: enKeys.length, translated: enKeys.length, percent: 100 }; continue; }
      var table = (root.WSI18nData && root.WSI18nData[lang]) || {};
      var translated = 0;
      for (var j = 0; j < enKeys.length; j++) {
        if (Object.prototype.hasOwnProperty.call(table, enKeys[j])) translated++;
      }
      report[lang] = { total: enKeys.length, translated: translated, percent: enKeys.length ? Math.round((translated / enKeys.length) * 1000) / 10 : 100 };
    }
    return report;
  }

  root.WSI18n = {
    SUPPORTED: SUPPORTED,
    FALLBACK: FALLBACK,
    supportedLocales: supportedLocales,
    nativeName: nativeName,
    normalizeLocale: normalizeLocale,
    detectBrowserLanguage: detectBrowserLanguage,
    resolveLanguage: resolveLanguage,
    getCurrentLanguage: getCurrentLanguage,
    setLanguage: setLanguage,
    t: t,
    applyToDom: applyToDom,
    init: init,
    coverageReport: coverageReport
  };
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
