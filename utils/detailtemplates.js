/**
 * detailtemplates.js
 * DETAIL ENRICHMENT — "Detail Template Saving" (mission's own explicit
 * requirement): lets the fields/selectors a user configured for the new
 * VERİ/SONUÇ/DETAY flow be saved as a small, reusable, per-hostname
 * template and loaded again on a future dataset from the same site —
 * NEVER applied automatically (this module only ever lists/saves/
 * removes; the popup decides when — and if — to actually load one into
 * the active config, always from an explicit user action).
 *
 * Deliberately its own small, independent store — NOT the existing
 * Saved Scrapers system (utils/recipes.js), which is a much larger
 * concept (container selector, columns, pagination method, download
 * config, monitoring, research prefs, its own Deep Scrape config...) and
 * touching it here would risk destabilizing a proven, working system for
 * a need this module already fully covers on its own: a short list of
 * named field sets, per hostname, nothing else. Same `chrome.storage.
 * local` backend and `ws_*::<hostname>` key convention as
 * utils/storage.js's own column state, for consistency.
 */
(function (root) {
  'use strict';

  function keyForHostname(hostname) {
    return 'ws_detail_templates::' + hostname;
  }

  function makeId() {
    return 'dtpl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  /** @returns {Promise<Array<{id,name,sourceColumnName,fields,createdAt}>>} */
  function list(hostname) {
    var key = keyForHostname(hostname);
    return new Promise(function (resolve) {
      chrome.storage.local.get([key], function (result) {
        var arr = result && result[key];
        resolve(Array.isArray(arr) ? arr : []);
      });
    });
  }

  function nameTaken(templates, name, excludeId) {
    var normalized = String(name || '').trim().toLowerCase();
    return templates.some(function (t) { return t.id !== excludeId && t.name.trim().toLowerCase() === normalized; });
  }

  /**
   * @param {string} hostname
   * @param {string} name
   * @param {Array<{name,relativeSelector,attribute,attributeName?,multiple}>} fields
   * @param {string|null} sourceColumnName — display hint only (e.g. "Link")
   *   for which column the template expects as its detail-URL source;
   *   never used to auto-select anything on load, purely informational.
   * @returns {Promise<{ok:true,template:object}|{ok:false,error:string}>}
   */
  async function save(hostname, name, fields, sourceColumnName) {
    var trimmed = (name || '').trim();
    if (!trimmed) return { ok: false, error: 'name-required' };
    if (!Array.isArray(fields) || !fields.length) return { ok: false, error: 'no-fields' };
    var templates = await list(hostname);
    if (nameTaken(templates, trimmed, null)) return { ok: false, error: 'name-taken' };
    // Strip each field down to its own portable shape (name/selector/
    // attribute/attributeName/multiple) — never persists an id, since
    // ids are ephemeral per-session values regenerated fresh every time
    // a template is loaded (see load() below), and never persists
    // anything DOM-derived (a sample value, a live element reference).
    var portableFields = fields.map(function (f) {
      var out = { name: f.name, relativeSelector: f.relativeSelector, attribute: f.attribute, multiple: f.multiple === 'all' ? 'all' : 'first' };
      if (f.attribute === 'attr') out.attributeName = f.attributeName || '';
      return out;
    });
    var template = { id: makeId(), name: trimmed, sourceColumnName: sourceColumnName || null, fields: portableFields, createdAt: Date.now() };
    templates = templates.concat([template]);
    var data = {};
    data[keyForHostname(hostname)] = templates;
    return new Promise(function (resolve) {
      chrome.storage.local.set(data, function () { resolve({ ok: true, template: template }); });
    });
  }

  /** @returns {Promise<boolean>} true if a template with that id existed and was removed */
  async function remove(hostname, templateId) {
    var templates = await list(hostname);
    var next = templates.filter(function (t) { return t.id !== templateId; });
    if (next.length === templates.length) return false;
    var data = {};
    data[keyForHostname(hostname)] = next;
    return new Promise(function (resolve) {
      chrome.storage.local.set(data, function () { resolve(true); });
    });
  }

  /**
   * Turns a saved template's portable field list back into real,
   * freshly-id'd field objects ready to drop into a detail config's
   * `fields` array — the ONLY place a template's data is ever "applied",
   * and only ever called from an explicit user "Load Template" action in
   * the popup (mission: "Do NOT silently apply saved templates").
   * @param {object} template
   * @param {function():string} makeColumnId — WSStorage.makeColumnId, injected so this file has no hard load-order dependency on utils/storage.js
   */
  function instantiateFields(template, makeColumnId) {
    if (!template || !Array.isArray(template.fields)) return [];
    return template.fields.map(function (f) {
      var out = { id: makeColumnId(), name: f.name, relativeSelector: f.relativeSelector, attribute: f.attribute, multiple: f.multiple === 'all' ? 'all' : 'first' };
      if (f.attribute === 'attr') out.attributeName = f.attributeName || '';
      return out;
    });
  }

  root.WSDetailTemplates = {
    list: list,
    save: save,
    remove: remove,
    instantiateFields: instantiateFields
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
