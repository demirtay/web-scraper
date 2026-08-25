/**
 * templates.js (V1.22)
 * "Templates" — reusable STARTING configurations that speed up building a
 * new scraper without locking the user into anything. Deliberately named
 * "Templates" (not "Recipes") in code AND in the UI to avoid confusion
 * with the pre-existing utils/recipes.js (WSRecipes), which is this
 * project's SAVED SCRAPER persistence module and is completely untouched
 * by this file — a Template and a Saved Scraper are different concepts
 * that happen to share some field shapes.
 *
 * Popup-only (never injected into a page) — matches applying a template
 * to whatever RUN_AUTO_DETECT / SCAN_STRUCTURED_DATA already returned to
 * the popup, reusing V1.17's Auto Detect and V1.21's Structured Data
 * engines completely as-is rather than building a second detection
 * system (spec #7/#28's explicit instruction).
 *
 * Two kinds of template, one schema:
 *   - BUILT-IN templates (8, defined below, never stored/never
 *     deletable) carry `fieldHints` — semantic INTENTIONS ("find a
 *     product name", "find a price") to be matched against the CURRENT
 *     page's Auto Detect / Structured Data results at apply time. They
 *     never carry real selectors of their own, since they're generic
 *     and page-agnostic by design.
 *   - CUSTOM templates (chrome.storage.local, key `ws_templates`) carry
 *     real, already-resolved `columns` (and optional pagination/Deep
 *     Scrape config) captured from an existing working scraper via
 *     "Save as Template" — applying one is a direct, literal copy, no
 *     matching needed, since it's inherently page-specific already.
 *
 * Data shape (both kinds):
 * {
 *   schemaVersion: 1,
 *   id: string,                 // 'builtin_<name>' | 'tpl_<timestamp>_<rand>'
 *   name: string,
 *   description: string,
 *   category: 'ecommerce'|'search'|'article'|'directory'|'realestate'|
 *             'jobs'|'table'|'list'|'custom',
 *   icon: string,                // a single emoji, purely decorative
 *   builtin: boolean,
 *   applyStrategy: 'match-hints'|'use-autodetect-table'|'use-autodetect-top'|'direct-columns',
 *   fieldHints: [{ name, structuredLabels: [string], semanticNames: [string], attribute }],
 *   columns: [ {id,name,relativeSelector,attribute,attributeName,structuredPath,structuredKind} ],
 *   containerSelector: string|null,
 *   paginationConfig: {mode, paginationMethod, urlPatternConfig, nextButtonConfig, dedupeKey, limits} | null,
 *   deepScrapeConfig: {enabled, sourceColumnId, fields, concurrency, delayMode, customDelayMs, retryLimit} | null,
 *   transforms: [] | an ordered V1.23 transform pipeline (see
 *     utils/transforms.js) — optional, custom templates only; built-in
 *     templates never carry one (see V1.23's PRIMARY GOAL note below),
 *   createdAt: number, updatedAt: number
 * }
 */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'ws_templates';
  var SCHEMA_VERSION = 1;
  var MAX_STRING_LEN = 2000; // generous but bounded — defends against a malicious/corrupt import stuffing huge strings, never a real limitation for genuine template data
  var VALID_ATTRIBUTES = ['text', 'html', 'href', 'src', 'alt', 'attr', 'structured', 'position'];
  // NEW FEATURE — DATA CLEANING ENGINE: the optional per-column cleaner
  // type (see utils/cleaners.js). Mirrors VALID_ATTRIBUTES' own pattern
  // exactly — an unrecognized/missing value normalizes to 'raw', never
  // dropped or left as untrusted input, so an OLDER saved template (with
  // no cleanerType field at all) behaves identically to one explicitly
  // set to 'raw' (mission spec #20: "Existing saved templates without
  // cleanerType: must default to RAW").
  var VALID_CLEANER_TYPES = ['raw', 'text', 'price', 'number', 'url'];
  function normalizeCleanerType(raw) {
    return VALID_CLEANER_TYPES.indexOf(raw) !== -1 ? raw : 'raw';
  }
  var VALID_CATEGORIES = ['ecommerce', 'search', 'article', 'directory', 'realestate', 'jobs', 'table', 'list', 'custom'];

  function makeTemplateId() {
    return 'tpl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  function emptyContainer() {
    return { schemaVersion: SCHEMA_VERSION, templates: [] };
  }

  function load() {
    return new Promise(function (resolve) {
      chrome.storage.local.get([STORAGE_KEY], function (result) {
        var data = result && result[STORAGE_KEY];
        if (!data || typeof data !== 'object' || !Array.isArray(data.templates)) { resolve(emptyContainer()); return; }
        resolve(data);
      });
    });
  }

  function persist(container) {
    var data = {};
    data[STORAGE_KEY] = container;
    return new Promise(function (resolve, reject) {
      chrome.storage.local.set(data, function () {
        if (chrome.runtime && chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message || 'Storage write failed.')); return; }
        resolve();
      });
    });
  }

  // =====================================================================
  // Validation / normalization (spec #11 versioning, #23 security) — an
  // imported or corrupt record is NEVER trusted as-is. Every field is
  // rebuilt from scratch into a fresh plain object with a known, narrow
  // shape; anything unrecognized/malformed is silently dropped (never
  // partially-applied, never thrown into later code as a surprise type).
  // No field here is EVER executed — every value stays inert data
  // (a CSS selector string, a dotted path string, a plain enum) exactly
  // like a normal manually-built scraper's own columns already are.
  // =====================================================================

  function safeString(v, fallback) {
    if (typeof v !== 'string') return fallback === undefined ? '' : fallback;
    return v.slice(0, MAX_STRING_LEN);
  }
  function safeStringOrNull(v) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') return null;
    return v.slice(0, MAX_STRING_LEN);
  }
  function safeBool(v, fallback) {
    return typeof v === 'boolean' ? v : !!fallback;
  }
  function safeInt(v, fallback, min, max) {
    var n = typeof v === 'number' && isFinite(v) ? Math.round(v) : fallback;
    if (typeof min === 'number' && n < min) n = fallback;
    if (typeof max === 'number' && n > max) n = fallback;
    return n;
  }

  /** Normalizes one column entry (from a custom template's `columns`,
   * whether freshly captured or freshly imported) into the exact same
   * shape a hand-built scraper column already has — reusing the SAME
   * attribute enum content/scraper.js already understands, so an
   * applied template column is indistinguishable from a manually-added
   * one anywhere downstream (spec #5's "must remain editable using the
   * normal scraper UI"; spec #17's "must behave exactly like manually-
   * created V1.21 structured columns"). */
  function normalizeTemplateColumn(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var attribute = VALID_ATTRIBUTES.indexOf(raw.attribute) !== -1 ? raw.attribute : null;
    if (!attribute) return null;
    var name = safeString(raw.name, '').trim();
    if (!name) return null;
    if (attribute === 'structured') {
      var structuredPath = safeStringOrNull(raw.structuredPath);
      if (!structuredPath) return null; // a structured column with no path is meaningless — drop it rather than keep a broken one
      return {
        id: root.WSStorage ? root.WSStorage.makeColumnId() : ('col_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
        name: name, relativeSelector: null, attribute: 'structured',
        structuredPath: structuredPath,
        structuredKind: ['image', 'url', 'text'].indexOf(raw.structuredKind) !== -1 ? raw.structuredKind : 'text',
        cleanerType: normalizeCleanerType(raw.cleanerType)
      };
    }
    if (attribute === 'position') {
      return { id: root.WSStorage ? root.WSStorage.makeColumnId() : ('col_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)), name: name, relativeSelector: ':scope', attribute: 'position', cleanerType: normalizeCleanerType(raw.cleanerType) };
    }
    var relativeSelector = raw.relativeSelector === ':scope' ? ':scope' : safeStringOrNull(raw.relativeSelector);
    if (!relativeSelector) return null; // a DOM column with no selector at all can never extract anything — drop it
    return {
      id: root.WSStorage ? root.WSStorage.makeColumnId() : ('col_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
      name: name, relativeSelector: relativeSelector, attribute: attribute,
      attributeName: attribute === 'attr' ? safeStringOrNull(raw.attributeName) : null,
      cleanerType: normalizeCleanerType(raw.cleanerType)
    };
  }

  function normalizeFieldHint(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = safeString(raw.name, '').trim();
    if (!name) return null;
    return {
      name: name,
      structuredLabels: Array.isArray(raw.structuredLabels) ? raw.structuredLabels.filter(function (s) { return typeof s === 'string'; }).slice(0, 10) : [],
      semanticNames: Array.isArray(raw.semanticNames) ? raw.semanticNames.filter(function (s) { return typeof s === 'string'; }).slice(0, 10) : [],
      attribute: VALID_ATTRIBUTES.indexOf(raw.attribute) !== -1 ? raw.attribute : 'text'
    };
  }

  /** The full validate+rebuild entry point — used for BOTH a freshly-
   * imported JSON file (untrusted) and a freshly-captured "Save as
   * Template" input (trusted, but normalized through the exact same
   * path anyway so there's only one place this shape is ever built).
   * Returns null (never throws) if the input isn't usable at all. */
  /** normalizeTemplateColumn always mints a BRAND NEW id for every
   * column (never trusts an input id — essential for a hostile import,
   * where a supplied id could otherwise collide unpredictably). That
   * means whatever referenced the ORIGINAL id — a V1.23 transform's
   * `column`/`options.sourceColumns`, or a Deep Scrape config's
   * `sourceColumnId` — would silently point at nothing once normalized,
   * unless it's rewritten through the SAME old-id -> new-id mapping this
   * function builds while normalizing `raw.columns` once. */
  function normalizeColumnsWithIdMap(rawColumns) {
    var idMap = {};
    var columns = Array.isArray(rawColumns) ? rawColumns.map(function (c) {
      var normalized = normalizeTemplateColumn(c);
      if (normalized && c && typeof c === 'object' && typeof c.id === 'string') idMap[c.id] = normalized.id;
      return normalized;
    }).filter(Boolean) : [];
    return { columns: columns, idMap: idMap };
  }

  /** Rewrites every column-id reference inside an (untrusted, not yet
   * sanitized) transform list through idMap — a reference with no entry
   * in idMap (e.g. it pointed at a column that got dropped for being
   * malformed) is left as-is; WSTransforms.sanitizeTransformList/
   * applyOneTransform already handle a dangling reference safely
   * (a clean error, never a crash) exactly like any other stale-column
   * transform does elsewhere in this app. */
  function remapTransformColumnIds(rawTransforms, idMap) {
    if (!Array.isArray(rawTransforms)) return rawTransforms;
    return rawTransforms.map(function (step) {
      if (!step || typeof step !== 'object') return step;
      var clone = Object.assign({}, step);
      if (typeof clone.column === 'string' && idMap[clone.column]) clone.column = idMap[clone.column];
      if (clone.options && typeof clone.options === 'object' && Array.isArray(clone.options.sourceColumns)) {
        clone.options = Object.assign({}, clone.options, { sourceColumns: clone.options.sourceColumns.map(function (id) { return idMap[id] || id; }) });
      }
      return clone;
    });
  }

  function normalizeTemplate(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var name = safeString(raw.name, '').trim();
    if (!name) return null;
    var now = Date.now();

    var colResult = normalizeColumnsWithIdMap(raw && raw.columns);
    var deepScrapeConfig = normalizeDeepScrapeConfigForTemplate(raw.deepScrapeConfig);
    if (deepScrapeConfig && deepScrapeConfig.sourceColumnId && colResult.idMap[deepScrapeConfig.sourceColumnId]) {
      deepScrapeConfig.sourceColumnId = colResult.idMap[deepScrapeConfig.sourceColumnId];
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      id: (typeof raw.id === 'string' && raw.id) ? raw.id.slice(0, 100) : makeTemplateId(),
      name: name,
      description: safeString(raw.description, ''),
      category: VALID_CATEGORIES.indexOf(raw.category) !== -1 ? raw.category : 'custom',
      icon: safeString(raw.icon, '📄').slice(0, 8),
      builtin: false, // an imported/saved template is NEVER marked builtin, however the source data claims — spec #9's "protect built-in templates from accidental deletion/modification" only ever applies to the code-defined constants below
      applyStrategy: 'direct-columns',
      fieldHints: [],
      columns: colResult.columns,
      containerSelector: safeStringOrNull(raw.containerSelector),
      paginationConfig: normalizePaginationConfig(raw.paginationConfig),
      deepScrapeConfig: deepScrapeConfig,
      // V1.23 spec #27: a custom template may optionally carry a
      // transform pipeline captured via "Save as Template". Column
      // references are rewritten through colResult.idMap FIRST (see
      // remapTransformColumnIds above), then sanitized through
      // WSTransforms' OWN untrusted-input rebuilder (never a second
      // validation engine) — safe for both a freshly-captured working
      // pipeline and a hostile imported JSON file alike. A template with
      // no transforms (including every pre-V1.23 one, which never had
      // this field at all) simply gets [].
      transforms: (root.WSTransforms && root.WSTransforms.sanitizeTransformList) ? root.WSTransforms.sanitizeTransformList(remapTransformColumnIds(raw.transforms, colResult.idMap)) : [],
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
      updatedAt: now
    };
  }

  var VALID_MODES = ['current-page', 'auto-scroll', 'multi-page', 'load-more'];
  function normalizePaginationConfig(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (VALID_MODES.indexOf(raw.mode) === -1) return null;
    return {
      mode: raw.mode,
      paginationMethod: raw.paginationMethod === 'urlPattern' ? 'urlPattern' : 'nextButton',
      urlPatternConfig: (raw.urlPatternConfig && typeof raw.urlPatternConfig === 'object') ? {
        kind: raw.urlPatternConfig.kind === 'path' ? 'path' : 'query',
        key: safeString(raw.urlPatternConfig.key, 'page'),
        style: safeString(raw.urlPatternConfig.style, 'page'),
        start: safeInt(raw.urlPatternConfig.start, 1, 0, 100000),
        step: safeInt(raw.urlPatternConfig.step, 1, 1, 10000)
      } : null,
      nextButtonConfig: (raw.nextButtonConfig && typeof raw.nextButtonConfig.relativeSelector === 'string') ? { relativeSelector: raw.nextButtonConfig.relativeSelector.slice(0, MAX_STRING_LEN) } : null,
      dedupeKey: safeString(raw.dedupeKey, 'entire-row'),
      limits: (raw.limits && typeof raw.limits === 'object') ? raw.limits : null // limits' own shape already varies legitimately per mode (V1.19/V1.20) — passed through as an opaque bag of already-validated numbers, never interpreted here
    };
  }

  function normalizeDeepScrapeConfigForTemplate(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.fields) || !raw.fields.length) return null;
    return {
      enabled: safeBool(raw.enabled, false),
      sourceColumnId: safeStringOrNull(raw.sourceColumnId),
      fields: raw.fields.map(normalizeTemplateColumn).filter(Boolean),
      concurrency: safeInt(raw.concurrency, 4, 1, 8),
      delayMode: raw.delayMode === 'custom' ? 'custom' : 'auto',
      customDelayMs: typeof raw.customDelayMs === 'number' ? raw.customDelayMs : null,
      retryLimit: safeInt(raw.retryLimit, 3, 1, 8)
    };
  }

  // =====================================================================
  // Custom template CRUD (spec #9) — chrome.storage.local, isolated key,
  // exactly the same "one blob, load/persist" pattern utils/recipes.js
  // already established for Saved Scrapers.
  // =====================================================================

  function nameTaken(templates, name, excludeId) {
    var lower = name.trim().toLowerCase();
    return templates.some(function (t) { return t.id !== excludeId && t.name.trim().toLowerCase() === lower; });
  }

  async function listCustomTemplates() {
    var c = await load();
    return c.templates.slice().sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  }

  async function getCustomTemplate(id) {
    var c = await load();
    return c.templates.find(function (t) { return t.id === id; }) || null;
  }

  /** Captures a WORKING scraper configuration as a reusable custom
   * template — columns/pagination/Deep Scrape config ONLY, spec #8's
   * explicit "Do NOT save scrape results" (this function's input has no
   * `rows` parameter at all, so there is nothing to accidentally save). */
  async function saveCustomTemplate(input) {
    var c = await load();
    if (!input || !input.name || !String(input.name).trim()) return { ok: false, error: 'Template name can’t be empty.' };
    if (nameTaken(c.templates, input.name, null)) return { ok: false, error: 'A template named "' + String(input.name).trim() + '" already exists.' };
    var template = normalizeTemplate(input);
    if (!template) return { ok: false, error: 'Nothing usable to save as a template.' };
    if (!template.columns.length) return { ok: false, error: 'Add at least one column before saving a template.' };
    template.category = 'custom';
    c.templates.push(template);
    try { await persist(c); } catch (e) { return { ok: false, error: 'Could not save: ' + e.message }; }
    return { ok: true, template: template };
  }

  async function renameCustomTemplate(id, newName) {
    var c = await load();
    var t = c.templates.find(function (x) { return x.id === id; });
    if (!t) return { ok: false, error: 'That template no longer exists.' };
    var trimmed = String(newName || '').trim();
    if (!trimmed) return { ok: false, error: 'Template name can’t be empty.' };
    if (nameTaken(c.templates, trimmed, id)) return { ok: false, error: 'A template named "' + trimmed + '" already exists.' };
    t.name = trimmed;
    t.updatedAt = Date.now();
    try { await persist(c); } catch (e) { return { ok: false, error: 'Could not rename: ' + e.message }; }
    return { ok: true, template: t };
  }

  async function duplicateCustomTemplate(id) {
    var c = await load();
    var t = c.templates.find(function (x) { return x.id === id; });
    if (!t) return { ok: false, error: 'That template no longer exists.' };
    var copy = JSON.parse(JSON.stringify(t));
    copy.id = makeTemplateId();
    var base = t.name + ' (copy)';
    var name = base, n = 2;
    while (nameTaken(c.templates, name, null)) { name = t.name + ' (copy ' + n + ')'; n++; }
    copy.name = name;
    copy.createdAt = copy.updatedAt = Date.now();
    c.templates.push(copy);
    try { await persist(c); } catch (e) { return { ok: false, error: 'Could not duplicate: ' + e.message }; }
    return { ok: true, template: copy };
  }

  async function deleteCustomTemplate(id) {
    var c = await load();
    var before = c.templates.length;
    c.templates = c.templates.filter(function (t) { return t.id !== id; });
    if (c.templates.length === before) return { ok: false, error: 'That template no longer exists.' };
    try { await persist(c); } catch (e) { return { ok: false, error: 'Could not delete: ' + e.message }; }
    return { ok: true };
  }

  // =====================================================================
  // Import / export (spec #10) — a portable JSON document. Import NEVER
  // auto-saves (mirrors normalizeTemplate's "rebuild from scratch,
  // discard anything unrecognized" contract) — the caller decides
  // whether/how to persist what came back, after showing it to the user.
  // =====================================================================

  function exportTemplateToJson(template) {
    // A clean export never leaks the internal builtin/applyStrategy
    // fields (meaningless outside this codebase) — only the portable,
    // re-importable shape.
    var portable = {
      schemaVersion: SCHEMA_VERSION, name: template.name, description: template.description,
      category: template.category === 'custom' ? 'custom' : template.category, icon: template.icon,
      columns: template.columns, containerSelector: template.containerSelector,
      paginationConfig: template.paginationConfig, deepScrapeConfig: template.deepScrapeConfig
    };
    return JSON.stringify(portable, null, 2);
  }

  /** spec #11: a missing/unrecognized schemaVersion is a NEW template
   * (schemaVersion 1 is the only version that has ever existed, so
   * "future" versions — a number higher than what this build knows —
   * fail with a clear, honest compatibility message rather than being
   * silently mis-parsed as version 1). A pre-versioning record (no
   * schemaVersion field at all) is treated as version 1 — the only
   * version that predates the field's own existence. */
  function importTemplateFromJson(jsonString) {
    var parsed;
    try {
      parsed = JSON.parse(jsonString);
    } catch (e) {
      return { ok: false, error: 'That file isn’t valid JSON: ' + String(e && e.message || e) };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'That file doesn’t look like a template (expected a single JSON object).' };
    }
    var version = parsed.schemaVersion === undefined ? 1 : parsed.schemaVersion;
    if (typeof version !== 'number' || version > SCHEMA_VERSION) {
      return { ok: false, error: 'This template was created by a newer version of Web Scraper (schema v' + version + ') and can’t be safely imported here (this version supports up to v' + SCHEMA_VERSION + ').' };
    }
    var template = normalizeTemplate(parsed);
    if (!template) return { ok: false, error: 'That file is missing a template name or has no usable content.' };
    if (!template.columns.length) return { ok: false, error: 'That template has no valid columns — nothing to import.' };
    return { ok: true, template: template };
  }

  // =====================================================================
  // Built-in templates (spec #2) — generic, reusable, never site-specific.
  // fieldHints only; no real columns (see file header). Every hint below
  // is checked against real V1.21 detectFields() labels / V1.17 Auto
  // Detect field names — never invented labels that don't actually occur.
  // =====================================================================

  function hint(name, structuredLabels, semanticNames, attribute) {
    return { name: name, structuredLabels: structuredLabels || [], semanticNames: semanticNames || [], attribute: attribute || 'text' };
  }

  var BUILTIN_TEMPLATES = [
    {
      schemaVersion: SCHEMA_VERSION, id: 'builtin_ecommerce', name: 'E-commerce Product List',
      description: 'Product listings with price, rating, and availability.', category: 'ecommerce', icon: '🛒',
      builtin: true, applyStrategy: 'match-hints', columns: [], containerSelector: null, paginationConfig: null, deepScrapeConfig: null,
      fieldHints: [
        hint('Product Name', ['Name'], ['Title']),
        hint('Price', ['Price'], ['Price']),
        hint('Original Price', [], []),
        hint('Product URL', ['URL'], ['Link'], 'href'),
        hint('Image', ['Image'], ['Image'], 'src'),
        hint('Rating', ['Rating Value'], ['Rating']),
        hint('Review Count', ['Review Count', 'Rating Count'], ['Count']),
        hint('Availability', ['Availability'], []),
        hint('Brand', ['Brand'], []),
        hint('SKU', ['SKU'], []),
        hint('Category', ['Category'], [])
      ]
    },
    {
      schemaVersion: SCHEMA_VERSION, id: 'builtin_search', name: 'Search Results',
      description: 'A results page listing titles, links, and snippets.', category: 'search', icon: '🔎',
      builtin: true, applyStrategy: 'match-hints', columns: [], containerSelector: null, paginationConfig: null, deepScrapeConfig: null,
      fieldHints: [
        hint('Title', ['Name', 'Headline', 'Page Title'], ['Title']),
        hint('URL', ['URL', 'Canonical URL'], ['Link'], 'href'),
        hint('Description', ['Description', 'Meta Description'], ['Description']),
        hint('Position', [], [], 'position')
      ]
    },
    {
      schemaVersion: SCHEMA_VERSION, id: 'builtin_article', name: 'Article / News List',
      description: 'A list of articles or news stories with author and date.', category: 'article', icon: '📰',
      builtin: true, applyStrategy: 'match-hints', columns: [], containerSelector: null, paginationConfig: null, deepScrapeConfig: null,
      fieldHints: [
        hint('Headline', ['Headline', 'Name'], ['Title']),
        hint('URL', ['URL'], ['Link'], 'href'),
        hint('Author', ['Author'], ['Author']),
        hint('Published Date', ['Date Published'], ['Date']),
        hint('Description', ['Description'], ['Description']),
        hint('Image', ['Image', 'OG Image'], ['Image'], 'src')
      ]
    },
    {
      schemaVersion: SCHEMA_VERSION, id: 'builtin_directory', name: 'Directory / Business List',
      description: 'A directory of businesses or listings with contact info.', category: 'directory', icon: '🏢',
      builtin: true, applyStrategy: 'match-hints', columns: [], containerSelector: null, paginationConfig: null, deepScrapeConfig: null,
      fieldHints: [
        hint('Name', ['Name'], ['Title']),
        hint('URL', ['URL'], ['Link'], 'href'),
        hint('Address', ['Address'], []),
        hint('Phone', ['Telephone'], []),
        hint('Rating', ['Rating Value'], ['Rating']),
        hint('Review Count', ['Review Count', 'Rating Count'], ['Count']),
        hint('Category', ['Category'], [])
      ]
    },
    {
      schemaVersion: SCHEMA_VERSION, id: 'builtin_realestate', name: 'Real Estate List',
      description: 'Property listings — structured-data coverage varies by site.', category: 'realestate', icon: '🏠',
      builtin: true, applyStrategy: 'match-hints', columns: [], containerSelector: null, paginationConfig: null, deepScrapeConfig: null,
      fieldHints: [
        hint('Title', ['Name'], ['Title']),
        hint('Price', ['Price'], ['Price']),
        hint('Location', [], []),
        hint('Property URL', ['URL'], ['Link'], 'href'),
        hint('Image', ['Image'], ['Image'], 'src'),
        hint('Property Type', [], []),
        hint('Bedrooms', [], []),
        hint('Bathrooms', [], []),
        hint('Area', [], [])
      ]
    },
    {
      schemaVersion: SCHEMA_VERSION, id: 'builtin_jobs', name: 'Job Listings',
      description: 'Job postings with company, location, and salary.', category: 'jobs', icon: '💼',
      builtin: true, applyStrategy: 'match-hints', columns: [], containerSelector: null, paginationConfig: null, deepScrapeConfig: null,
      fieldHints: [
        hint('Job Title', ['Job Title', 'Name'], ['Title']),
        hint('Company', ['Company'], []),
        hint('Location', ['Location'], []),
        hint('Job URL', ['URL'], ['Link'], 'href'),
        hint('Salary', ['Salary'], ['Price']),
        hint('Employment Type', ['Employment Type'], []),
        hint('Published Date', ['Date Posted'], ['Date'])
      ]
    },
    {
      schemaVersion: SCHEMA_VERSION, id: 'builtin_table', name: 'Generic Table',
      description: 'Extracts an HTML table on the page using its own headers.', category: 'table', icon: '📊',
      builtin: true, applyStrategy: 'use-autodetect-table', columns: [], containerSelector: null, paginationConfig: null, deepScrapeConfig: null,
      fieldHints: []
    },
    {
      schemaVersion: SCHEMA_VERSION, id: 'builtin_list', name: 'Generic List / Cards',
      description: 'Detects the strongest repeating card/list structure on the page.', category: 'list', icon: '📋',
      builtin: true, applyStrategy: 'use-autodetect-top', columns: [], containerSelector: null, paginationConfig: null, deepScrapeConfig: null,
      fieldHints: []
    }
  ];

  function getBuiltinTemplates() { return BUILTIN_TEMPLATES.slice(); }
  function getBuiltinTemplate(id) { return BUILTIN_TEMPLATES.find(function (t) { return t.id === id; }) || null; }
  function getTemplate(id) {
    var builtin = getBuiltinTemplate(id);
    if (builtin) return Promise.resolve(builtin);
    return getCustomTemplate(id);
  }

  // =====================================================================
  // Matching (spec #4/#6/#7) — built-in templates only. Runs entirely
  // over data the popup ALREADY has (an Auto Detect result + a
  // Structured Data scan result) — never re-scans the page itself, never
  // duplicates V1.17/V1.21's own detection logic (spec #26 performance:
  // reuse existing results, don't rescan).
  // =====================================================================

  function bestAutoDetectStructure(autoDetectResult) {
    if (!autoDetectResult || !autoDetectResult.structures || !autoDetectResult.structures.length) return null;
    return autoDetectResult.structures[0]; // already sorted by score — V1.17's own contract
  }

  /** Matches one template's fieldHints against whatever was actually
   * detected on the CURRENT page. Structured-data candidates are tried
   * FIRST (more precise — a real schema.org field, page-level or per-
   * detail-page correct per V1.21's own semantics), then the top Auto
   * Detect structure's own fields by name. A structured/candidate, once
   * consumed by one template field, is never reused for a second one in
   * the SAME apply (spec: never fabricate two fields from one signal).
   * Returns matched (ready-to-add columns) and unmatched (hint names
   * with no evidence found — spec #25: never fabricated, just omitted
   * and clearly reported) separately, plus the containerSelector any
   * DOM-sourced matches would need. */
  function matchBuiltinTemplateFields(template, autoDetectResult, structuredFields) {
    var usedStructuredPaths = Object.create(null);
    var usedAutoDetectIndices = Object.create(null);
    var structured = structuredFields || [];
    var topStructure = bestAutoDetectStructure(autoDetectResult);
    var autoFields = (topStructure && topStructure.fields) || [];

    var matched = [];
    var unmatched = [];

    (template.fieldHints || []).forEach(function (fh) {
      // 1) structured-data match
      for (var i = 0; i < fh.structuredLabels.length; i++) {
        var label = fh.structuredLabels[i];
        var candidateIndex = structured.findIndex(function (f, idx) { return f.label === label && !usedStructuredPaths[f.path] && !usedStructuredPaths['#' + idx]; });
        if (candidateIndex !== -1) {
          var sf = structured[candidateIndex];
          usedStructuredPaths[sf.path] = true;
          matched.push({ hintName: fh.name, source: 'structured', name: fh.name, attribute: 'structured', structuredPath: sf.path, structuredKind: sf.kind || 'text', sampleValue: sf.sampleValue });
          return;
        }
      }
      // 2) Auto Detect match (by V1.17's own controlled name vocabulary)
      for (var j = 0; j < fh.semanticNames.length; j++) {
        var wantName = fh.semanticNames[j].toLowerCase();
        var afIndex = autoFields.findIndex(function (f, idx) { return f.name && f.name.toLowerCase() === wantName && !usedAutoDetectIndices[idx]; });
        if (afIndex !== -1) {
          usedAutoDetectIndices[afIndex] = true;
          var af = autoFields[afIndex];
          matched.push({ hintName: fh.name, source: 'autodetect', name: fh.name, attribute: af.attribute, relativeSelector: af.relativeSelector, attributeName: null, sampleValue: af.samples && af.samples[0] });
          return;
        }
      }
      // 3) computed field (e.g. Position) — never needs external evidence
      if (fh.attribute === 'position') {
        matched.push({ hintName: fh.name, source: 'computed', name: fh.name, attribute: 'position', sampleValue: '1, 2, 3, …' });
        return;
      }
      unmatched.push(fh.name);
    });

    var usesAutoDetect = matched.some(function (m) { return m.source === 'autodetect'; });
    return {
      matched: matched, unmatched: unmatched,
      containerSelector: usesAutoDetect && topStructure ? topStructure.containerSelector : null,
      usesAutoDetect: usesAutoDetect
    };
  }

  /** builtin_table / builtin_list's special strategy — directly reuse
   * whichever Auto Detect structure fits (never re-implements table/
   * card detection; V1.4/V1.17's runAutoDetect already found it). */
  function matchAutoDetectStrategyTemplate(template, autoDetectResult) {
    var structures = (autoDetectResult && autoDetectResult.structures) || [];
    var structure = template.applyStrategy === 'use-autodetect-table'
      ? structures.find(function (s) { return s.label === 'Table Rows'; })
      : structures[0];
    if (!structure) return { matched: [], unmatched: ['(no matching structure detected on this page)'], containerSelector: null, usesAutoDetect: false };
    var matched = structure.fields.map(function (f) {
      return { hintName: f.name, source: 'autodetect', name: f.name, attribute: f.attribute, relativeSelector: f.relativeSelector, attributeName: null, sampleValue: f.samples && f.samples[0] };
    });
    return { matched: matched, unmatched: [], containerSelector: structure.containerSelector, usesAutoDetect: true };
  }

  function matchTemplateFields(template, autoDetectResult, structuredFields) {
    if (template.applyStrategy === 'use-autodetect-table' || template.applyStrategy === 'use-autodetect-top') {
      return matchAutoDetectStrategyTemplate(template, autoDetectResult);
    }
    return matchBuiltinTemplateFields(template, autoDetectResult, structuredFields);
  }

  // =====================================================================
  // Smart suggestions (spec #3) — recommendations only, computed from
  // data the popup already fetched; never triggers a scan on its own,
  // never alters the scraper. Ranked, deduplicated by template id.
  // =====================================================================

  function suggestTemplates(autoDetectResult, structuredScanResult) {
    var suggestions = [];
    function suggest(id, confidence, reason) {
      if (suggestions.some(function (s) { return s.templateId === id; })) return;
      suggestions.push({ templateId: id, confidence: confidence, reason: reason });
    }

    var entities = (structuredScanResult && structuredScanResult.snapshot && structuredScanResult.snapshot.jsonLd && structuredScanResult.snapshot.jsonLd.entities) || [];
    function anyType(names) {
      return entities.some(function (e) {
        var t = e && e['@type'];
        var list = Array.isArray(t) ? t : (t ? [t] : []);
        return list.some(function (one) { return names.indexOf(String(one)) !== -1; });
      });
    }
    if (anyType(['Product'])) suggest('builtin_ecommerce', 'high', 'Product structured data found on this page');
    if (anyType(['Article', 'NewsArticle'])) suggest('builtin_article', 'high', 'Article/NewsArticle structured data found on this page');
    if (anyType(['JobPosting'])) suggest('builtin_jobs', 'high', 'JobPosting structured data found on this page');
    if (anyType(['LocalBusiness', 'Organization'])) suggest('builtin_directory', 'medium', 'Business/Organization structured data found on this page');

    var structures = (autoDetectResult && autoDetectResult.structures) || [];
    if (structures.some(function (s) { return s.label === 'Table Rows'; })) suggest('builtin_table', 'high', 'An HTML table with repeating rows was detected');

    // Real estate: no reliable canonical schema.org signal most sites use
    // (spec's own "RealEstate-like" wording acknowledges this) — a light,
    // honest heuristic based on Auto Detect's own field labels/samples,
    // never a fabricated structured-data claim.
    var REAL_ESTATE_RE = /bed(room)?s?\b|bath(room)?s?\b|sq\.?\s?ft|square\s?feet/i;
    var topStructure = structures[0];
    if (topStructure && topStructure.fields.some(function (f) { return REAL_ESTATE_RE.test(f.name) || (f.samples || []).some(function (s) { return REAL_ESTATE_RE.test(String(s)); }); })) {
      suggest('builtin_realestate', 'medium', 'Bedroom/bathroom/area-like fields were detected');
    }

    if (!suggestions.length && topStructure) suggest('builtin_list', 'low', 'A repeating card/list structure was detected, but no specific type could be confirmed');

    return suggestions;
  }

  root.WSTemplates = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    getBuiltinTemplates: getBuiltinTemplates,
    getBuiltinTemplate: getBuiltinTemplate,
    getTemplate: getTemplate,
    listCustomTemplates: listCustomTemplates,
    getCustomTemplate: getCustomTemplate,
    saveCustomTemplate: saveCustomTemplate,
    renameCustomTemplate: renameCustomTemplate,
    duplicateCustomTemplate: duplicateCustomTemplate,
    deleteCustomTemplate: deleteCustomTemplate,
    exportTemplateToJson: exportTemplateToJson,
    importTemplateFromJson: importTemplateFromJson,
    normalizeTemplate: normalizeTemplate,
    matchTemplateFields: matchTemplateFields,
    suggestTemplates: suggestTemplates
  };
})(typeof window !== 'undefined' ? window : globalThis);
