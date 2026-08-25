/**
 * snapshots.js
 * V1.6 Snapshot persistence — chrome.storage.local CRUD for saved dataset
 * snapshots, following the exact same module shape as recipes.js (single
 * storage key holding a {schemaVersion, snapshots:[]} container). Local
 * only — no backend/cloud involved. Used only by the popup.
 *
 * A snapshot stores the ENTIRE scraped dataset (never a filtered view —
 * see spec #24) at the moment it was captured, name-keyed (see
 * changes.js's toNamedRows) so comparisons stay meaningful even if a
 * Saved Scraper's internal column ids change between runs.
 *
 * Snapshot object shape:
 * {
 *   id, scraperId (string|null — null for an ad-hoc/temporary snapshot),
 *   scraperName, url, hostname, pathname, createdAt, rowCount,
 *   columns: [{name, attribute}], rows: [{ColumnName: value, ...}],
 *   uniqueKey: 'entire-row' | a column name
 * }
 */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'ws_snapshots';
  var SCHEMA_VERSION = 1;
  var DEFAULT_RETENTION_PER_GROUP = 10;
  var FALLBACK_QUOTA_BYTES = 10 * 1024 * 1024; // Chrome's real MV3 chrome.storage.local.QUOTA_BYTES, mirrored here as a fallback for environments (e.g. unit tests) that don't expose the constant
  var WARN_RATIO = 0.8;

  function emptyContainer() {
    return { schemaVersion: SCHEMA_VERSION, snapshots: [] };
  }

  function load() {
    return new Promise(function (resolve) {
      chrome.storage.local.get([STORAGE_KEY], function (result) {
        var data = result && result[STORAGE_KEY];
        if (!data || typeof data !== 'object' || !Array.isArray(data.snapshots)) {
          resolve(emptyContainer());
          return;
        }
        resolve(data);
      });
    });
  }

  function persist(container) {
    var data = {};
    data[STORAGE_KEY] = container;
    return new Promise(function (resolve, reject) {
      chrome.storage.local.set(data, function () {
        if (chrome.runtime && chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'storage write failed'));
          return;
        }
        resolve();
      });
    });
  }

  function makeId() {
    return 'snap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  /** Snapshots group by their Saved Scraper (retention/listing scope), or
   * by hostname+pathname for ad-hoc snapshots taken without one — spec
   * #25 explicitly allows both. */
  function groupKeyFor(snapshot) {
    return snapshot.scraperId || ('adhoc::' + snapshot.hostname + '::' + (snapshot.pathname || ''));
  }

  function groupKeyForFilter(filter) {
    return filter.scraperId || ('adhoc::' + filter.hostname + '::' + (filter.pathname || ''));
  }

  function estimateBytes(container) {
    try { return JSON.stringify(container).length; } catch (e) { return 0; }
  }

  function getQuotaBytes() {
    return (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && chrome.storage.local.QUOTA_BYTES) || FALLBACK_QUOTA_BYTES;
  }

  async function listSnapshots(filter) {
    var c = await load();
    var groupKey = groupKeyForFilter(filter || {});
    return c.snapshots
      .filter(function (s) { return groupKeyFor(s) === groupKey; })
      .sort(function (a, b) { return b.createdAt - a.createdAt; });
  }

  async function getLatestSnapshot(filter) {
    var list = await listSnapshots(filter);
    return list[0] || null;
  }

  async function getSnapshot(id) {
    var c = await load();
    return c.snapshots.filter(function (s) { return s.id === id; })[0] || null;
  }

  async function countSnapshots(filter) {
    return (await listSnapshots(filter)).length;
  }

  /**
   * @param {Object} input {scraperId, scraperName, url, hostname, pathname,
   *   columns, rows, uniqueKey, retentionLimit}
   * @returns {{ok:true, snapshot, warning:string|null, prunedCount:number}
   *          |{ok:false, error:string}}
   */
  async function saveSnapshot(input) {
    if (!input || !Array.isArray(input.rows) || !input.rows.length) {
      return { ok: false, error: 'Nothing to snapshot — the current results are empty.' };
    }
    var c = await load();
    var snapshot = {
      id: makeId(),
      scraperId: input.scraperId || null,
      scraperName: input.scraperName || (input.hostname || 'Untitled'),
      url: input.url || '',
      hostname: input.hostname || '',
      pathname: input.pathname || '',
      createdAt: Date.now(),
      rowCount: input.rows.length,
      columns: input.columns || [],
      rows: input.rows,
      uniqueKey: input.uniqueKey || 'entire-row'
    };

    var candidateSnapshots = c.snapshots.concat([snapshot]);
    var groupKey = groupKeyFor(snapshot);
    var retention = input.retentionLimit || DEFAULT_RETENTION_PER_GROUP;
    var group = candidateSnapshots
      .filter(function (s) { return groupKeyFor(s) === groupKey; })
      .sort(function (a, b) { return b.createdAt - a.createdAt; });

    var prunedIds = Object.create(null);
    if (group.length > retention) {
      group.slice(retention).forEach(function (s) { prunedIds[s.id] = true; });
    }
    var finalSnapshots = candidateSnapshots.filter(function (s) { return !prunedIds[s.id]; });
    var finalContainer = { schemaVersion: SCHEMA_VERSION, snapshots: finalSnapshots };

    var bytes = estimateBytes(finalContainer);
    var quota = getQuotaBytes();
    if (bytes > quota) {
      return { ok: false, error: 'Snapshot storage limit reached — delete some old snapshots and try again.' };
    }

    try {
      await persist(finalContainer);
    } catch (e) {
      return { ok: false, error: 'Could not save snapshot: ' + e.message };
    }

    var warning = bytes > quota * WARN_RATIO
      ? 'Snapshot storage is getting large (' + Math.round(bytes / 1024 / 1024 * 10) / 10 + 'MB of ' + Math.round(quota / 1024 / 1024) + 'MB). Consider deleting old snapshots.'
      : null;

    return { ok: true, snapshot: snapshot, warning: warning, prunedCount: Object.keys(prunedIds).length };
  }

  async function deleteSnapshot(id) {
    var c = await load();
    var before = c.snapshots.length;
    c.snapshots = c.snapshots.filter(function (s) { return s.id !== id; });
    await persist(c);
    return { ok: c.snapshots.length < before };
  }

  root.WSSnapshots = {
    listSnapshots: listSnapshots,
    getLatestSnapshot: getLatestSnapshot,
    getSnapshot: getSnapshot,
    countSnapshots: countSnapshots,
    saveSnapshot: saveSnapshot,
    deleteSnapshot: deleteSnapshot,
    DEFAULT_RETENTION_PER_GROUP: DEFAULT_RETENTION_PER_GROUP
  };
})(typeof window !== 'undefined' ? window : globalThis);
