/**
 * settings.js
 * V1.14 lightweight app-level settings — currently just the Research
 * Bundle format defaults shown in Settings > Downloads. Deliberately its
 * own storage key (`ws_settings`), isolated from every other key, so a
 * missing/corrupt value can never affect Saved Scrapers, snapshots,
 * monitoring, or plan state, and vice versa.
 *
 * These are GLOBAL fallback defaults only — a Saved Scraper's own
 * `research` prefs (set the first time a bundle is built while it's
 * loaded, see utils/recipes.js) always take priority once they exist;
 * this only matters for a brand-new scraper (or no scraper at all) that
 * has never had bundle options chosen yet. Before V1.14 that fallback
 * was a hardcoded object in popup.js; this makes it configurable
 * without changing the fallback VALUES anyone was already getting.
 */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'ws_settings';
  var SCHEMA_VERSION = 1;

  function defaultResearchFormatDefaults() {
    // Exactly V1.12's original hardcoded defaults (spec #3 of that
    // version) — introducing this setting must not change anyone's
    // existing out-of-the-box behavior.
    return { includeCsv: false, includeXlsx: true, includeJson: true, includeImages: true, includeFiles: false };
  }

  /** V1.24 spec #28 "Saved export preferences" — a SMALL, deliberately
   * bounded set (delimiter / filename pattern / raw-values-included /
   * copy format) so this stays a lightweight convenience, never a second
   * export-configuration schema. Every field has a safe default that
   * reproduces V1.23-and-earlier's exact out-of-the-box behavior —
   * saving this setting is opt-in (only happens when a user actually
   * changes something in the Export Options panel), so an extension that
   * never touches it behaves identically to before this version existed. */
  function defaultExportPreferences() {
    return {
      csvDelimiter: ',',          // ',' | ';' | '\t'
      filenameTemplate: '',        // '' = use WSDownloads.DEFAULT_EXPORT_FILENAME_TEMPLATE
      includeRawValues: false,     // spec #17: transformed-only by default
      copyFormat: 'tsv'            // 'tsv' | 'csv' | 'json' — spec #8, TSV keeps the pre-V1.24 one-click behavior
    };
  }

  /** V1 FINAL PART B spec #8: language selection reuses this EXISTING
   * `ws_settings` key rather than inventing a new storage location.
   * 'auto' (the default) means "no explicit choice yet — follow the
   * browser-detected language" (see utils/i18n.js's resolveLanguage());
   * any of WSI18n.SUPPORTED means an explicit user selection that always
   * wins from then on. A value outside the supported set (e.g. left over
   * from a future version, or corrupted) safely falls back to 'auto' in
   * load() below — never crashes, never wipes the rest of settings. */
  function defaultLanguage() { return 'auto'; }

  /** V1 WORKFLOW REORG spec: the Scrape tab's AUTO/MANUAL mode preference,
   * same storage pattern as `language` above — 'auto' is the default for
   * a brand-new user; an explicit switch persists here and is honored on
   * every future popup open UNLESS the current page/host already has a
   * loaded saved scraper or existing manual columns configured, in which
   * case popup.js forces Manual for THAT session only (see
   * decideInitialScrapeMode()) without overwriting this stored
   * preference. A value outside {'auto','manual'} self-heals back to
   * 'auto' in load() below. */
  function defaultScrapeMode() { return 'auto'; }

  function emptySettings() {
    return { schemaVersion: SCHEMA_VERSION, researchFormatDefaults: defaultResearchFormatDefaults(), exportPreferences: defaultExportPreferences(), language: defaultLanguage(), scrapeMode: defaultScrapeMode() };
  }

  function load() {
    return new Promise(function (resolve) {
      chrome.storage.local.get([STORAGE_KEY], function (result) {
        var data = result && result[STORAGE_KEY];
        if (!data || typeof data !== 'object') { resolve(emptySettings()); return; }
        // Self-heal a partially-shaped record the same way every other
        // module in this project does — never assume every field exists.
        // This also covers migration from any pre-V1-FINAL/pre-workflow-
        // reorg install: those records simply have no `language`/
        // `scrapeMode` field, so they safely default (browser-detected
        // language / 'auto' scrape mode) rather than crashing or
        // resetting researchFormatDefaults/exportPreferences.
        var lang = typeof data.language === 'string' ? data.language : defaultLanguage();
        if (lang !== 'auto' && root.WSI18n && root.WSI18n.SUPPORTED.indexOf(lang) === -1) lang = defaultLanguage();
        var scrapeMode = (data.scrapeMode === 'auto' || data.scrapeMode === 'manual') ? data.scrapeMode : defaultScrapeMode();
        resolve({
          schemaVersion: SCHEMA_VERSION,
          researchFormatDefaults: Object.assign(defaultResearchFormatDefaults(), data.researchFormatDefaults || {}),
          exportPreferences: Object.assign(defaultExportPreferences(), data.exportPreferences || {}),
          language: lang,
          scrapeMode: scrapeMode
        });
      });
    });
  }

  function persist(settings) {
    var data = {};
    data[STORAGE_KEY] = settings;
    return new Promise(function (resolve, reject) {
      chrome.storage.local.set(data, function () {
        if (chrome.runtime && chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'Storage write failed.'));
          return;
        }
        resolve();
      });
    });
  }

  async function setResearchFormatDefaults(patch) {
    var settings = await load();
    settings.researchFormatDefaults = Object.assign({}, settings.researchFormatDefaults, patch);
    try { await persist(settings); } catch (e) { return { ok: false, error: 'Could not save settings: ' + e.message }; }
    return { ok: true, settings: settings };
  }

  async function setExportPreferences(patch) {
    var settings = await load();
    settings.exportPreferences = Object.assign({}, settings.exportPreferences, patch);
    try { await persist(settings); } catch (e) { return { ok: false, error: 'Could not save settings: ' + e.message }; }
    return { ok: true, settings: settings };
  }

  /** V1 FINAL PART B spec #8: persists an explicit language choice. `code`
   * should be 'auto' or one of WSI18n.SUPPORTED; anything else is stored
   * as-is (load() self-heals an unrecognized value back to 'auto' on next
   * read, same self-healing pattern as every other field here) so a
   * future version adding a 7th language can't get permanently stuck. */
  async function setLanguage(code) {
    var settings = await load();
    settings.language = code;
    try { await persist(settings); } catch (e) { return { ok: false, error: 'Could not save settings: ' + e.message }; }
    return { ok: true, settings: settings };
  }

  /** V1 WORKFLOW REORG — persists an explicit AUTO/MANUAL preference.
   * `mode` should be 'auto' or 'manual'; anything else is stored as-is
   * (load() self-heals back to 'auto' on next read). */
  async function setScrapeMode(mode) {
    var settings = await load();
    settings.scrapeMode = mode;
    try { await persist(settings); } catch (e) { return { ok: false, error: 'Could not save settings: ' + e.message }; }
    return { ok: true, settings: settings };
  }

  root.WSSettings = {
    STORAGE_KEY: STORAGE_KEY,
    emptySettings: emptySettings,
    defaultResearchFormatDefaults: defaultResearchFormatDefaults,
    defaultExportPreferences: defaultExportPreferences,
    defaultLanguage: defaultLanguage,
    defaultScrapeMode: defaultScrapeMode,
    load: load,
    setResearchFormatDefaults: setResearchFormatDefaults,
    setExportPreferences: setExportPreferences,
    setLanguage: setLanguage,
    setScrapeMode: setScrapeMode
  };
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
