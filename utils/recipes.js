/**
 * recipes.js
 * "Saved Scrapers" CRUD — persists reusable scraper CONFIGURATION
 * (selectors, extraction types, container info) so it can be reloaded and
 * re-run later or on similar pages. Deliberately stores nothing about
 * RESULT DATA (scraped rows) — see popup.js's results pipeline, which
 * keeps rows in memory only, never in chrome.storage. Used only by the
 * popup (never injected into pages).
 *
 * Storage: a single key, `ws_saved_scrapers`, isolated from the V1.1
 * per-hostname "current configuration" key (`ws_state::<hostname>`,
 * owned by storage.js) so V1.2 can't corrupt or migrate that existing
 * data — it's simply never touched.
 */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'ws_saved_scrapers';
  var SCHEMA_VERSION = 1;

  function emptyContainer() {
    return { schemaVersion: SCHEMA_VERSION, scrapers: [] };
  }

  function load() {
    return new Promise(function (resolve) {
      chrome.storage.local.get([STORAGE_KEY], function (result) {
        var data = result && result[STORAGE_KEY];
        if (!data || typeof data !== 'object' || !Array.isArray(data.scrapers)) {
          resolve(emptyContainer());
          return;
        }
        resolve(data);
      });
    });
  }

  /** Rejects on a storage write failure (e.g. quota exceeded, extension
   * context invalidated) instead of silently resolving as if it
   * succeeded — every caller below now surfaces this as {ok:false,
   * error} rather than reporting success while the write never actually
   * landed (which would otherwise look exactly like "the change appears
   * applied in memory/this response, but a later fresh read shows the
   * old data"). */
  function persist(container) {
    var data = {};
    data[STORAGE_KEY] = container;
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

  function makeId() {
    return 'scraper_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  async function listScrapers() {
    var c = await load();
    return c.scrapers.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  }

  async function getScraper(id) {
    var c = await load();
    return c.scrapers.find(function (s) { return s.id === id; }) || null;
  }

  function nameTaken(scrapers, name, excludeId) {
    var lower = name.trim().toLowerCase();
    return scrapers.some(function (s) { return s.id !== excludeId && s.name.trim().toLowerCase() === lower; });
  }

  /**
   * Creates a new saved scraper from the current working configuration.
   * Stores exactly what's needed to re-run it later — nothing more:
   * hostname/pathname (for URL matching), containerSelector, and columns
   * (id, name, relativeSelector, attribute — the same shape the V1.1
   * engine already uses, so no translation layer is needed).
   *
   * V1.3 additive fields (all optional — a scraper saved under V1.2 simply
   * lacks them, and loads back exactly as it did before: mode defaults to
   * 'current-page', dedupeKey to 'entire-row', no next-button/limits):
   *   mode: 'current-page' | 'auto-scroll' | 'multi-page' | 'load-more' (V1.19)
   *   nextButtonConfig: {relativeSelector} | null — also reused, unchanged
   *     shape, as Load More's "button to click" config (V1.19)
   *   dedupeKey: 'entire-row' | a column id
   *   limits: {maxRows, maxScrolls, noNewDataAttempts} (auto-scroll) |
   *     {maxPages, maxRows, delayMs, retryCount} (multi-page) |
   *     {maxClicks, maxRows, noNewDataAttempts, delayMs, retryCount}
   *     (load-more, V1.19) | null — delayMs/retryCount/noNewDataAttempts
   *     are all V1.19-additive within these same objects too; a limits
   *     object saved under V1.3-V1.18 simply lacks them and every run
   *     defaults them to 0/0/3, reproducing pre-V1.19 behavior exactly
   *
   * V1.19 additive fields (see saveScraper's own inline comment for the
   * exact shape — same guarantee: absent on any pre-V1.19 record, and
   * mode:'multi-page' with no paginationMethod runs as 'nextButton'):
   *   paginationMethod: 'nextButton' | 'urlPattern'
   *   urlPatternConfig: {kind, key, style, start, step} | null
   *
   * V1.5 additive fields (same backward-compatibility guarantee — a
   * scraper saved under V1.4 or earlier simply lacks them and the
   * download setup panel just falls back to its own defaults):
   *   downloadColumn: a column id | null
   *   filenameTemplate: string
   *   folderName: string
   *   skipDuplicates: boolean
   *
   * V1.6 additive field (same guarantee — a scraper saved under V1.5 or
   * earlier simply lacks it and the Snapshots panel falls back to its own
   * default, per spec priority: user-chosen key > a Link-like column >
   * Entire Row):
   *   compareKey: 'entire-row' | a column NAME (not id — see changes.js's
   *     header comment for why snapshots/comparisons key by column name)
   *
   * V1.7 additive fields (same guarantee — a scraper saved under V1.6 or
   * earlier simply lacks them and Run behaves exactly as before: no
   * transforms applied):
   *   transforms: [] | an ordered list of transform configs (see
   *     utils/transforms.js) to replay on top of a fresh scrape. Never
   *     includes a "Current filtered rows"-scoped transform (spec #31 —
   *     those are row-position-dependent and not portable across runs).
   *   autoApplyTransforms: boolean — whether Run should apply them
   *     automatically (still always under explicit user control: this is
   *     just what the checkbox was set to when the scraper was saved).
   *
   * V1.8 additive fields (same guarantee — a scraper saved under V1.7 or
   * earlier simply lacks them, monitoring.enabled defaults false, and
   * background.js never schedules anything for it):
   *   lastKnownUrl: the full URL (with query string, unlike
   *     hostname/pathname which deliberately ignore it for page-match
   *     purposes) captured whenever the scraper is saved/updated — used
   *     ONLY to reopen the right page for a scheduled run (e.g. an eBay
   *     search with a specific `_nkw=`), never for interactive matching.
   *   monitoring: {
   *     enabled: boolean,
   *     intervalMinutes: number|null,  // one of MONITOR_INTERVALS
   *     lastRunAt: number|null, nextRunAt: number|null,
   *     lastRunStatus: 'success'|'error'|'running'|null,
   *     lastRunSummary: string, lastError: string|null,
   *     notifyOnChanges: boolean  // V1.9 — see below
   *   }
   *
   * V1.9 additive monitoring field (same guarantee — a scraper saved
   * under V1.8 or earlier simply lacks it and defaults to true, matching
   * every other "on by default, always user-controlled" toggle in this
   * project, e.g. autoApplyTransforms):
   *   monitoring.notifyOnChanges: boolean — whether a monitored run
   *     firing chrome.notifications.create() when it finds changes or
   *     errors. Deliberately does NOT notify on a successful run with
   *     zero changes, nor on the very first snapshot (nothing to compare
   *     against yet) — a notification every routine check would defeat
   *     the point of "tell me when something's different".
   *
   * V1.10 additive monitoring field (same guarantee — a scraper saved
   * under V1.9 or earlier simply lacks it and starts with an empty
   * array; the popup's History button just doesn't show until there's
   * at least one entry):
   *   monitoring.history: [{
   *     at: number, status: 'success'|'error',
   *     totalRows: number|null, newCount: number|null,
   *     removedCount: number|null, changedCount: number|null,
   *     error: string|null
   *   }] — newest first, capped at MONITOR_HISTORY_LIMIT entries per
   *   scraper (oldest silently dropped past that, same "keep it bounded"
   *   policy as snapshots' own retention). Appended ONLY by
   *   updateMonitoringStatus (i.e. only for a run that actually
   *   finished, success or error — never for the transient 'running'
   *   status write) — see background.js's finishMonitoringRun.
   *   clearMonitoringHistory() below empties ONLY this array; it never
   *   touches lastRunAt/lastRunStatus/lastRunSummary/lastError (the
   *   "current" run info) or anything else on the scraper record.
   *
   * V1.11 additive monitoring field (same guarantee — a scraper saved
   * under V1.10 or earlier simply lacks it and reads as false, so a
   * pre-V1.11 record's most recent successful run displays as SUCCESS
   * rather than a fabricated CHANGED):
   *   monitoring.lastRunHasChanges: boolean — whether the latest
   *     COMPLETED run (status 'success') found at least one new/removed/
   *     changed row. Deliberately a field of its own, parallel to
   *     lastRunStatus/lastRunSummary/lastError, rather than being derived
   *     from history[0] — history is user-clearable (Clear History,
   *     V1.10) and clearing it must never make an otherwise-unrelated
   *     "did the last run find changes" fact disappear too. background.js
   *     sets this explicitly (true or false) on EVERY finished run,
   *     success or error, so it never lingers stale from an older run —
   *     though badge/summary logic always checks lastRunStatus === 'error'
   *     first regardless, so this value is only ever consulted on success.
   *
   * V1.12 additive field (same guarantee — a scraper saved under V1.11
   * or earlier simply lacks it; the Research Bundle panel just computes
   * fresh defaults per its own spec #3 instead of reading a saved
   * preference — see setResearchPrefs below):
   *   research: {
   *     datasetNameTemplate: string, includeCsv/Xlsx/Json: boolean,
   *     includeImages/Files: boolean, imageColumnId/fileColumnId:
   *     string|null, filenameTemplate: string
   *   } — deliberately a plain object literal here rather than importing
   *   utils/research.js's emptyResearchPrefs(): background.js's
   *   importScripts list doesn't load research.js (it's popup-only, see
   *   that file's header comment) and recipes.js is shared by both, so
   *   duplicating this tiny default avoids adding a load-order
   *   dependency background.js would never actually need.
   */
  var MONITOR_INTERVALS = [60, 360, 720, 1440]; // hourly, 6h, 12h, daily (minutes) — practical chrome.alarms periods
  var MONITOR_HISTORY_LIMIT = 50;

  function emptyMonitoring() {
    return { enabled: false, intervalMinutes: null, lastRunAt: null, nextRunAt: null, lastRunStatus: null, lastRunSummary: '', lastError: null, notifyOnChanges: true, history: [], lastRunHasChanges: false };
  }

  /**
   * V1.18 additive field (same backward-compatibility guarantee as every
   * field above — a scraper saved under V1.17 or earlier simply lacks it
   * and self-heals to emptyDeepScrape() the moment it's touched; Deep
   * Scraping simply never runs for it, exactly like monitoring.enabled
   * defaulting false):
   *   deepScrape: {
   *     enabled: boolean,
   *     sourceColumnId: a column id | null — which column's per-row
   *       value is treated as the detail-page URL to follow,
   *     fields: [{id, name, relativeSelector, attribute, attributeName?,
   *       multiple: 'first'|'all'}] — the columns to extract from EACH
   *       detail page, in the exact same shape utils/storage.js's own
   *       columns already use (spec #2: "reuse V1.17 selector/extraction
   *       architecture"), plus one new `multiple` field (spec #17/#18).
   *     concurrency: number — simultaneous detail-page fetches (default 4,
   *       spec #8's "3-5 simultaneous requests" range),
   *     delayMode: 'auto' | 'custom',
   *     customDelayMs: number | null — only consulted when delayMode is
   *       'custom' (see background.js's DEEP_SCRAPE_AUTO_DELAY_MS for
   *       what 'auto' actually resolves to)
   *   }
   * Deliberately its own top-level field, NOT nested inside monitoring or
   * research — Deep Scraping is a distinct concern from either (spec #25:
   * monitoring must NEVER silently start performing deep requests just
   * because deepScrape.enabled is true — background.js's runScheduledScrape
   * never reads this field at all, by design).
   */
  function emptyDeepScrape() {
    // V1.20 additive: retryLimit (spec "Configurable retry limits" —
    // previously a hardcoded background.js constant). Default of 3
    // matches the pre-V1.20 hardcoded value exactly, so an existing
    // scraper's Deep Scrape behavior is unchanged until a user
    // deliberately adjusts it.
    return { enabled: false, sourceColumnId: null, fields: [], concurrency: 4, delayMode: 'auto', customDelayMs: null, retryLimit: 3 };
  }

  function normalizeDeepScrape(raw) {
    var base = emptyDeepScrape();
    if (!raw || typeof raw !== 'object') return base;
    return {
      enabled: !!raw.enabled,
      sourceColumnId: raw.sourceColumnId || null,
      fields: Array.isArray(raw.fields) ? raw.fields : [],
      concurrency: (typeof raw.concurrency === 'number' && raw.concurrency >= 1 && raw.concurrency <= 8) ? raw.concurrency : base.concurrency,
      delayMode: raw.delayMode === 'custom' ? 'custom' : 'auto',
      customDelayMs: (typeof raw.customDelayMs === 'number' && raw.customDelayMs >= 0) ? raw.customDelayMs : null,
      retryLimit: (typeof raw.retryLimit === 'number' && raw.retryLimit >= 1 && raw.retryLimit <= 8) ? raw.retryLimit : base.retryLimit
    };
  }

  function emptyResearchPrefs() {
    return {
      datasetNameTemplate: '',
      includeCsv: false, includeXlsx: true, includeJson: true,
      includeImages: true, includeFiles: false,
      imageColumnId: null, fileColumnId: null,
      filenameTemplate: ''
    };
  }
  async function saveScraper(input) {
    var c = await load();
    if (!input.name || !input.name.trim()) {
      return { ok: false, error: 'Scraper name can’t be empty.' };
    }
    if (nameTaken(c.scrapers, input.name, null)) {
      return { ok: false, error: 'A scraper named "' + input.name.trim() + '" already exists.' };
    }
    var now = Date.now();
    var scraper = {
      id: makeId(),
      name: input.name.trim(),
      hostname: input.hostname,
      pathname: input.pathname,
      containerSelector: input.containerSelector || null,
      columns: input.columns || [],
      mode: input.mode || 'current-page',
      nextButtonConfig: input.nextButtonConfig || null,
      // V1.19 additive fields — a scraper saved under V1.18 or earlier
      // simply lacks them; a mode of 'multi-page' with no
      // paginationMethod defaults to 'nextButton' (the ONLY method that
      // ever existed before V1.19), so an old saved Multi-page scraper
      // re-runs byte-for-byte identically:
      //   paginationMethod: 'nextButton' | 'urlPattern'
      //   urlPatternConfig: {kind, key, style, start, step} | null
      paginationMethod: input.paginationMethod || 'nextButton',
      urlPatternConfig: input.urlPatternConfig || null,
      dedupeKey: input.dedupeKey || 'entire-row',
      limits: input.limits || null,
      downloadColumn: input.downloadColumn || null,
      filenameTemplate: input.filenameTemplate || '',
      folderName: input.folderName || 'Web Scraper',
      skipDuplicates: input.skipDuplicates !== false,
      compareKey: input.compareKey || 'entire-row',
      transforms: input.transforms || [],
      autoApplyTransforms: input.autoApplyTransforms !== false,
      lastKnownUrl: input.url || null,
      monitoring: emptyMonitoring(),
      research: emptyResearchPrefs(),
      deepScrape: normalizeDeepScrape(input.deepScrape),
      createdAt: now,
      updatedAt: now
    };
    c.scrapers.push(scraper);
    try { await persist(c); } catch (e) { return { ok: false, error: 'Could not save: ' + e.message }; }
    return { ok: true, scraper: scraper };
  }

  /** Refreshes an existing scraper's selectors/columns (and V1.3 run / V1.5 download options) after edits, keeping its id/name/hostname/pathname/createdAt. */
  async function updateScraper(id, input) {
    var c = await load();
    var scraper = c.scrapers.find(function (s) { return s.id === id; });
    if (!scraper) return { ok: false, error: 'That saved scraper no longer exists.' };
    scraper.containerSelector = input.containerSelector || null;
    scraper.columns = input.columns || [];
    if (input.mode !== undefined) scraper.mode = input.mode || 'current-page';
    if (input.nextButtonConfig !== undefined) scraper.nextButtonConfig = input.nextButtonConfig || null;
    if (input.paginationMethod !== undefined) scraper.paginationMethod = input.paginationMethod || 'nextButton';
    if (input.urlPatternConfig !== undefined) scraper.urlPatternConfig = input.urlPatternConfig || null;
    if (!scraper.paginationMethod) scraper.paginationMethod = 'nextButton'; // self-heal a pre-V1.19 record on its first update, same pattern as V1.18's deepScrape self-heal
    if (input.dedupeKey !== undefined) scraper.dedupeKey = input.dedupeKey || 'entire-row';
    if (input.limits !== undefined) scraper.limits = input.limits || null;
    if (input.downloadColumn !== undefined) scraper.downloadColumn = input.downloadColumn || null;
    if (input.filenameTemplate !== undefined) scraper.filenameTemplate = input.filenameTemplate || '';
    if (input.folderName !== undefined) scraper.folderName = input.folderName || 'Web Scraper';
    if (input.skipDuplicates !== undefined) scraper.skipDuplicates = input.skipDuplicates !== false;
    if (input.compareKey !== undefined) scraper.compareKey = input.compareKey || 'entire-row';
    if (input.transforms !== undefined) scraper.transforms = input.transforms || [];
    if (input.autoApplyTransforms !== undefined) scraper.autoApplyTransforms = input.autoApplyTransforms !== false;
    if (input.url !== undefined) scraper.lastKnownUrl = input.url || null;
    if (input.deepScrape !== undefined) scraper.deepScrape = normalizeDeepScrape(input.deepScrape);
    if (!scraper.monitoring) scraper.monitoring = emptyMonitoring(); // self-heal a pre-V1.8 record
    if (!scraper.research) scraper.research = emptyResearchPrefs(); // self-heal a pre-V1.12 record
    if (!scraper.deepScrape) scraper.deepScrape = emptyDeepScrape(); // self-heal a pre-V1.18 record
    scraper.updatedAt = Date.now();
    try { await persist(c); } catch (e) { return { ok: false, error: 'Could not save: ' + e.message }; }
    return { ok: true, scraper: scraper };
  }

  /** V1.18: persists the Deep Scraping configuration on its own, mirroring
   * setResearchPrefs' narrow-patch pattern — never touches columns/
   * containerSelector/monitoring/research/transforms/anything else on the
   * scraper record. */
  async function setDeepScrapeConfig(id, patch) {
    var c = await load();
    var scraper = c.scrapers.find(function (s) { return s.id === id; });
    if (!scraper) return { ok: false, error: 'That saved scraper no longer exists.' };
    if (!scraper.deepScrape) scraper.deepScrape = emptyDeepScrape();
    scraper.deepScrape = normalizeDeepScrape(Object.assign({}, scraper.deepScrape, patch));
    scraper.updatedAt = Date.now();
    try { await persist(c); } catch (e) { return { ok: false, error: 'Could not save deep scraping settings: ' + e.message }; }
    return { ok: true, scraper: scraper };
  }

  /**
   * V1.12: persists whichever Research Bundle options the user actually
   * had selected when they clicked "Create Bundle" — called ONLY after a
   * bundle is successfully started, and only when a Saved Scraper is
   * currently loaded (spec #21's "if it can be done additively"). Never
   * touches monitoring, snapshots, transforms, or anything else on the
   * scraper record — deliberately as narrow as setMonitoringConfig is
   * for the monitoring schedule (spec #22: research bundles and
   * monitoring must stay completely separate).
   */
  async function setResearchPrefs(id, patch) {
    var c = await load();
    var scraper = c.scrapers.find(function (s) { return s.id === id; });
    if (!scraper) return { ok: false, error: 'That saved scraper no longer exists.' };
    if (!scraper.research) scraper.research = emptyResearchPrefs();
    ['datasetNameTemplate', 'includeCsv', 'includeXlsx', 'includeJson', 'includeImages', 'includeFiles', 'imageColumnId', 'fileColumnId', 'filenameTemplate'].forEach(function (key) {
      if (patch[key] !== undefined) scraper.research[key] = patch[key];
    });
    scraper.updatedAt = Date.now();
    try { await persist(c); } catch (e) { return { ok: false, error: 'Could not save research bundle settings: ' + e.message }; }
    return { ok: true, scraper: scraper };
  }

  /**
   * V1.8: enable/disable scheduled monitoring or change its interval —
   * a CONFIG change (bumps updatedAt), distinct from updateMonitoringStatus
   * below (which records the OUTCOME of a run). Disabling/re-enabling
   * NEVER clears lastRunAt/lastRunStatus/lastRunSummary/lastError —
   * those are run HISTORY, not live-monitoring-only state, and stay
   * exactly as they were through any number of Disable/Enable cycles;
   * only a fresh run (updateMonitoringStatus) ever overwrites them.
   * `nextRunAt` is the one exception deliberately included in THIS
   * patch (not updateMonitoringStatus's "run outcome" set): re-enabling
   * creates a brand new chrome.alarms entry, so the displayed next-run
   * time must be recomputed from THAT new alarm, not left showing the
   * stale schedule from whatever run happened before the last Disable.
   * Disabling clears it to null (no alarm exists while disabled, so
   * there is no real "next run" to show).
   */
  async function setMonitoringConfig(id, patch) {
    var c = await load();
    var scraper = c.scrapers.find(function (s) { return s.id === id; });
    if (!scraper) return { ok: false, error: 'That saved scraper no longer exists.' };
    if (!scraper.monitoring) scraper.monitoring = emptyMonitoring();
    if (patch.enabled !== undefined) scraper.monitoring.enabled = !!patch.enabled;
    if (patch.intervalMinutes !== undefined) scraper.monitoring.intervalMinutes = patch.intervalMinutes;
    if (patch.nextRunAt !== undefined) scraper.monitoring.nextRunAt = patch.nextRunAt;
    if (patch.notifyOnChanges !== undefined) scraper.monitoring.notifyOnChanges = patch.notifyOnChanges !== false;
    scraper.updatedAt = Date.now();
    try { await persist(c); } catch (e) { return { ok: false, error: 'Could not save monitoring settings: ' + e.message }; }
    return { ok: true, scraper: scraper };
  }

  /**
   * V1.8: records the OUTCOME of a scheduled/manual-"Run Now" pass —
   * status/timestamps/summary only. Never touches columns/containerSelector/
   * transforms/snapshots, and a failed run's error here never rolls back
   * anything a previous successful run already produced (spec: failed
   * runs must not destroy the previous snapshot or scraper configuration
   * — this function structurally can't, since it only ever writes these
   * five status fields).
   */
  async function updateMonitoringStatus(id, patch) {
    var c = await load();
    var scraper = c.scrapers.find(function (s) { return s.id === id; });
    if (!scraper) return { ok: false, error: 'That saved scraper no longer exists.' };
    if (!scraper.monitoring) scraper.monitoring = emptyMonitoring();
    if (patch.status !== undefined) scraper.monitoring.lastRunStatus = patch.status;
    if (patch.lastRunAt !== undefined) scraper.monitoring.lastRunAt = patch.lastRunAt;
    if (patch.nextRunAt !== undefined) scraper.monitoring.nextRunAt = patch.nextRunAt;
    if (patch.summary !== undefined) scraper.monitoring.lastRunSummary = patch.summary || '';
    if (patch.error !== undefined) scraper.monitoring.lastError = patch.error || null;
    // V1.11: parallel to lastRunStatus/lastRunSummary — see the field's
    // doc comment above for why this is its own field rather than being
    // derived from history[0].
    if (patch.hasChanges !== undefined) scraper.monitoring.lastRunHasChanges = !!patch.hasChanges;
    // V1.10: only present for a run that actually FINISHED (never the
    // transient 'running' write) — see background.js's finishMonitoringRun.
    if (patch.historyEntry) {
      if (!Array.isArray(scraper.monitoring.history)) scraper.monitoring.history = []; // self-heal a pre-V1.10 record
      scraper.monitoring.history.unshift(patch.historyEntry);
      if (scraper.monitoring.history.length > MONITOR_HISTORY_LIMIT) scraper.monitoring.history.length = MONITOR_HISTORY_LIMIT;
    }
    try { await persist(c); } catch (e) { return { ok: false, error: 'Could not save run status: ' + e.message }; }
    return { ok: true, scraper: scraper };
  }

  /** V1.10: clears ONLY the run history array — never touches
   * lastRunAt/lastRunStatus/lastRunSummary/lastError (the "current" run
   * info stays exactly as it was), enabled/intervalMinutes/nextRunAt
   * (the schedule), notifyOnChanges, columns/containerSelector/
   * transforms, or anything in the separate snapshots store. */
  async function clearMonitoringHistory(id) {
    var c = await load();
    var scraper = c.scrapers.find(function (s) { return s.id === id; });
    if (!scraper) return { ok: false, error: 'That saved scraper no longer exists.' };
    if (!scraper.monitoring) scraper.monitoring = emptyMonitoring();
    scraper.monitoring.history = [];
    try { await persist(c); } catch (e) { return { ok: false, error: 'Could not clear history: ' + e.message }; }
    return { ok: true, scraper: scraper };
  }

  /** Every scraper whose monitoring.enabled is true — what background.js
   * reconciles chrome.alarms against, and what the popup's Monitoring
   * section lists. */
  async function listMonitoredScrapers() {
    var all = await listScrapers();
    return all.filter(function (s) { return s.monitoring && s.monitoring.enabled; });
  }

  async function renameScraper(id, newName) {
    var c = await load();
    var scraper = c.scrapers.find(function (s) { return s.id === id; });
    if (!scraper) return { ok: false, error: 'That saved scraper no longer exists.' };
    if (!newName || !newName.trim()) return { ok: false, error: 'Scraper name can’t be empty.' };
    if (nameTaken(c.scrapers, newName, id)) {
      return { ok: false, error: 'A scraper named "' + newName.trim() + '" already exists.' };
    }
    scraper.name = newName.trim();
    scraper.updatedAt = Date.now();
    try { await persist(c); } catch (e) { return { ok: false, error: 'Could not save: ' + e.message }; }
    return { ok: true, scraper: scraper };
  }

  async function deleteScraper(id) {
    var c = await load();
    var before = c.scrapers.length;
    c.scrapers = c.scrapers.filter(function (s) { return s.id !== id; });
    try { await persist(c); } catch (e) { return { ok: false, error: 'Could not delete: ' + e.message }; }
    return { ok: c.scrapers.length < before };
  }

  /**
   * Simple, safe URL match: hostname must match exactly; pathname must
   * match exactly (query string/hash deliberately ignored, so e.g. the
   * same eBay search page with a different `_nkw=` value still matches).
   * Never fuzzy-matches across different hostnames or different page
   * paths — a scraper only ever runs where it was actually built for, or
   * after the user explicitly confirms a mismatch warning.
   */
  function matchesPage(scraper, hostname, pathname) {
    return scraper.hostname === hostname && scraper.pathname === pathname;
  }

  // ---- "which saved scraper is currently loaded on this hostname" -------
  // Deliberately kept in its own tiny per-hostname key, completely separate
  // from storage.js's `ws_state::<hostname>` (the V1.1 current-configuration
  // object that content.js reads/writes). That way this bookkeeping never
  // has to touch — or risk breaking — anything the scraper engine owns; it
  // only exists so the "Update Scraper" button can find its way back after
  // Add Column closes and reopens the popup.

  function loadedKey(hostname) {
    return 'ws_loaded_scraper::' + hostname;
  }

  function getLoadedScraperId(hostname) {
    var key = loadedKey(hostname);
    return new Promise(function (resolve) {
      chrome.storage.local.get([key], function (result) {
        resolve((result && result[key]) || null);
      });
    });
  }

  function setLoadedScraperId(hostname, id) {
    var data = {};
    data[loadedKey(hostname)] = id;
    return new Promise(function (resolve) {
      chrome.storage.local.set(data, resolve);
    });
  }

  root.WSRecipes = {
    listScrapers: listScrapers,
    getScraper: getScraper,
    saveScraper: saveScraper,
    updateScraper: updateScraper,
    renameScraper: renameScraper,
    deleteScraper: deleteScraper,
    matchesPage: matchesPage,
    getLoadedScraperId: getLoadedScraperId,
    setLoadedScraperId: setLoadedScraperId,
    setMonitoringConfig: setMonitoringConfig,
    updateMonitoringStatus: updateMonitoringStatus,
    clearMonitoringHistory: clearMonitoringHistory,
    listMonitoredScrapers: listMonitoredScrapers,
    setResearchPrefs: setResearchPrefs,
    emptyResearchPrefs: emptyResearchPrefs,
    setDeepScrapeConfig: setDeepScrapeConfig,
    emptyDeepScrape: emptyDeepScrape,
    normalizeDeepScrape: normalizeDeepScrape,
    MONITOR_INTERVALS: MONITOR_INTERVALS,
    MONITOR_HISTORY_LIMIT: MONITOR_HISTORY_LIMIT
  };
})(typeof window !== 'undefined' ? window : globalThis);
