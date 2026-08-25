/**
 * research.js
 * Pure, chrome-API-free logic for V1.12 Research Dataset Builder: assigns
 * stable Dataset IDs to a row set, plans image/file asset downloads by
 * REUSING utils/downloads.js verbatim (no second downloader — see
 * buildAssetPlan's header comment), builds manifest rows/columns, and
 * shapes dataset-info.json. Loaded only by the popup (mirrors recipes.js
 * — background.js's existing download-queue machinery is reused UNCHANGED
 * for actually fetching assets; this module only ever produces plain,
 * serializable data for popup.js to hand to it).
 *
 * Deliberately depends on WSDownloads (must be loaded first) for URL
 * validation/dedup-normalization/filename templating/sanitization — see
 * each function's comment for exactly which WSDownloads function it reuses
 * and why, per V1.12 spec #13 ("do NOT create a second independent
 * downloader").
 */
(function (root) {
  'use strict';

  var DATASET_ID_MIN_WIDTH = 4; // spec #4's examples are 0001/0002/0003

  /** Widens beyond 4 digits only once a dataset actually needs it (e.g.
   * 12345 rows -> IDs 00001..12345), so the common case always matches
   * the spec's exact 4-digit examples. */
  function formatDatasetId(oneBasedIndex, totalCount) {
    var width = Math.max(DATASET_ID_MIN_WIDTH, String(totalCount).length);
    var s = String(oneBasedIndex);
    while (s.length < width) s = '0' + s;
    return s;
  }

  /** Assigns a fresh, sequential 1..N Dataset ID per row in ARRAY ORDER —
   * always over whatever row set is actually passed in, so a "current
   * filtered results" bundle (spec #8) gets clean 0001..NN IDs of its
   * own, never sparse IDs inherited from the row's position in some
   * larger original dataset. */
  function assignDatasetIds(rows) {
    var total = rows.length;
    return rows.map(function (row, i) { return formatDatasetId(i + 1, total); });
  }

  /** Reuses WSDownloads.sanitizeFilename (the exact V1.5 sanitizer, spec
   * #6/#11) rather than a second implementation — a dataset name is a
   * single folder segment (not a path), so the filename sanitizer (which
   * already strips "/" along with every other invalid character) is
   * exactly right, unlike sanitizeFolderName which deliberately allows
   * "/" for sub-folders. */
  function sanitizeDatasetName(name) {
    return root.WSDownloads.sanitizeFilename(name) || 'Research Dataset';
  }

  /** url -> filename, built from whichever items actually got QUEUED
   * (i.e. survived WSDownloads' own dedup). Every row sharing a
   * duplicate URL still resolves to this same entry via
   * normalizeUrlForDedup, even though only the first such row's item is
   * in the list — see buildAssetPlan's header comment (spec #19). */
  function urlToFilenameMap(queueItems) {
    var map = Object.create(null);
    (queueItems || []).forEach(function (it) {
      var key = root.WSDownloads.normalizeUrlForDedup(it.url);
      if (!(key in map)) map[key] = it.filename;
    });
    return map;
  }

  /** url -> the terminal chrome.downloads status ('completed'/'failed'/
   * 'cancelled'/...) from a background.js download-run's items array —
   * the SAME runState shape V1.5's Bulk Download already reflects live,
   * nothing new. Kept as its own tiny pure function so it's testable
   * without a background.js/chrome.downloads mock. */
  function runItemsToStatusMap(runItems) {
    var map = Object.create(null);
    (runItems || []).forEach(function (it) {
      map[root.WSDownloads.normalizeUrlForDedup(it.url)] = it.status;
    });
    return map;
  }

  /**
   * Plans the image and/or file download queues for a research bundle.
   * Reuses WSDownloads.buildDownloadQueue (and therefore
   * collectUniqueUrls + generateFilenames) EXACTLY as V1.5's Bulk
   * Download does — same URL validation, same duplicate-URL skipping,
   * same {template}-token filename generation, same collision-suffix
   * logic, same sanitizeFilename. The only research-bundle-specific
   * pieces are:
   *   1. a synthetic "Dataset ID" column/value injected into a COPY of
   *      each row (never mutates the caller's rows) so the existing
   *      {ColumnName} template syntax can address it like any other
   *      column — the default template is "{Dataset ID}_{<name column>}"
   *      (spec #6's "{DatasetID}_{ProductName} or equivalent"), falling
   *      back to plain "{Dataset ID}" if no name column was supplied;
   *   2. each resulting filename gets an images/ or files/ prefix
   *      PREPENDED (not sanitized as a separate hop — sanitizeFolderName
   *      has always supported a "/" in a filename for exactly this
   *      "optional sub-folder" case), so handing these items straight to
   *      the existing chrome.downloads-backed queue lands them directly
   *      in the right research-bundle subfolder with zero background.js
   *      changes.
   *
   * Duplicate URLs across different rows (spec #19): collectUniqueUrls's
   * own dedup means only ONE row's item is actually queued for a shared
   * URL, so only one network download ever happens for it — but EVERY
   * row (queued or not) resolves to that same item's filename via
   * urlToFilenameMap's normalizeUrlForDedup keying, so the
   * row<->filename relationship in the manifest is correct for both.
   */
  function buildAssetPlan(rows, columns, datasetIds, options) {
    options = options || {};
    var idColumns = columns.concat([{ id: '__datasetId', name: 'Dataset ID' }]);
    var rowsWithId = rows.map(function (row, i) {
      var copy = Object.assign({}, row);
      copy.__datasetId = datasetIds[i];
      return copy;
    });

    var nameColumnName = null;
    if (options.nameColumnId) {
      var nc = columns.filter(function (c) { return c.id === options.nameColumnId; })[0];
      nameColumnName = nc ? nc.name : null;
    }
    var template = nameColumnName ? ('{Dataset ID}_{' + nameColumnName + '}') : '{Dataset ID}';

    var plan = {
      imageQueue: [], fileQueue: [],
      imageUrlToFilename: Object.create(null), fileUrlToFilename: Object.create(null),
      imageStats: null, fileStats: null
    };

    if (options.includeImages && options.imageColumnId) {
      var imgResult = root.WSDownloads.buildDownloadQueue(rowsWithId, idColumns, {
        columnId: options.imageColumnId, downloadKind: 'image', template: template, skipDuplicates: true
      });
      plan.imageQueue = imgResult.items.map(function (it) {
        return Object.assign({}, it, { filename: 'images/' + it.filename });
      });
      plan.imageStats = imgResult.stats;
      plan.imageUrlToFilename = urlToFilenameMap(plan.imageQueue);
    }

    if (options.includeFiles && options.fileColumnId) {
      var fileResult = root.WSDownloads.buildDownloadQueue(rowsWithId, idColumns, {
        columnId: options.fileColumnId, downloadKind: 'file', template: template, skipDuplicates: true
      });
      plan.fileQueue = fileResult.items.map(function (it) {
        return Object.assign({}, it, { filename: 'files/' + it.filename });
      });
      plan.fileStats = fileResult.stats;
      plan.fileUrlToFilename = urlToFilenameMap(plan.fileQueue);
    }

    return plan;
  }

  function lookupAssetFilename(url, urlToFilename) {
    if (!url || !urlToFilename) return '';
    var validation = root.WSDownloads.validateDownloadUrl(url);
    if (!validation.ok) return '';
    var key = root.WSDownloads.normalizeUrlForDedup(url);
    return urlToFilename[key] || '';
  }

  /**
   * One row's Asset Status (spec #18's four-value enum). `included`
   * lets a caller ask "what would this be if this asset type were
   * included" independent of buildManifestRows' own include gating —
   * useful standalone (e.g. tests) as well as internally.
   *   'skipped'    — this bundle doesn't include this asset type at all,
   *                  OR the row's value isn't an actionable URL (empty
   *                  scheme, blob:, etc. — never queued in the first
   *                  place, nothing failed, just not attempted)
   *   'missing'    — a valid URL exists but no run outcome is recorded
   *                  for it yet (row simply has no value at all is the
   *                  common case; a run that was Stopped before reaching
   *                  a valid, queued URL also reads this way — spec #7:
   *                  never silently dropped, always still a real row)
   *   'downloaded' — the queued item (this row's own, or another row's
   *                  sharing the same URL) reached 'completed'
   *   'failed'     — the queued item reached 'failed' or 'cancelled'
   */
  function computeAssetStatus(url, urlToFilename, urlToRunStatus, included) {
    if (!included) return 'skipped';
    if (!url) return 'missing';
    var validation = root.WSDownloads.validateDownloadUrl(url);
    if (!validation.ok) return 'skipped';
    var key = root.WSDownloads.normalizeUrlForDedup(url);
    var runStatus = urlToRunStatus ? urlToRunStatus[key] : undefined;
    // 'completed' was the V1.5-era chrome.downloads-queue vocabulary;
    // 'fetched' is V1.13.2's fetch()-based zip pipeline vocabulary — both
    // mean the same thing here ("this asset's bytes were obtained
    // successfully"), so both are accepted rather than picking one and
    // silently breaking whichever caller still uses the other.
    if (runStatus === 'completed' || runStatus === 'fetched') return 'downloaded';
    if (runStatus === 'failed' || runStatus === 'cancelled') return 'failed';
    return 'missing'; // valid + queued-eligible but no run outcome recorded yet
  }

  /**
   * Builds the manifest's column list and per-row values — spec #5's
   * "Dataset ID | <every original column, using CURRENT/TRANSFORMED
   * values> | Image URL (already one of the original columns) |
   * Downloaded Image Filename [| Image Asset Status]" shape, plus the
   * same pair for files when included. Never drops a row (spec #7): a
   * row with a missing/invalid/not-yet-downloaded asset still gets a
   * full manifest row, just with empty filename fields and an
   * explanatory Asset Status.
   *
   * Two asset-kind status columns (Image Asset Status / File Asset
   * Status) rather than one shared "Asset Status" column when both
   * Images and Files are included — spec #18 names a single column, but
   * a row can have independently different image vs. file outcomes, and
   * collapsing them into one column would be ambiguous. Each column is
   * simply omitted when its asset type isn't included in this bundle at
   * all, matching "optional" in the spec.
   */
  function buildManifestRows(rows, columns, datasetIds, options) {
    options = options || {};
    var manifestColumns = [{ id: '__datasetId', name: 'Dataset ID' }]
      .concat(columns.map(function (c) { return { id: c.id, name: c.name }; }));

    if (options.includeImages) {
      manifestColumns.push({ id: '__imageFilename', name: 'Downloaded Image Filename' });
      manifestColumns.push({ id: '__imageStatus', name: 'Image Asset Status' });
    }
    if (options.includeFiles) {
      manifestColumns.push({ id: '__fileFilename', name: 'Downloaded File Filename' });
      manifestColumns.push({ id: '__fileStatus', name: 'File Asset Status' });
    }

    var manifestRows = rows.map(function (row, i) {
      var out = Object.assign({}, row);
      out.__datasetId = datasetIds[i];
      if (options.includeImages) {
        var imgUrl = options.imageColumnId ? row[options.imageColumnId] : null;
        out.__imageFilename = lookupAssetFilename(imgUrl, options.imageUrlToFilename);
        out.__imageStatus = computeAssetStatus(imgUrl, options.imageUrlToFilename, options.imageUrlToStatus, true);
      }
      if (options.includeFiles) {
        var fileUrl = options.fileColumnId ? row[options.fileColumnId] : null;
        out.__fileFilename = lookupAssetFilename(fileUrl, options.fileUrlToFilename);
        out.__fileStatus = computeAssetStatus(fileUrl, options.fileUrlToFilename, options.fileUrlToStatus, true);
      }
      return out;
    });

    return { columns: manifestColumns, rows: manifestRows };
  }

  /** Shapes dataset-info.json (spec #10, extended by V1.24 spec #24) — a
   * thin, order-stable passthrough so every field the spec names is
   * always present (using a sensible empty default) even if the caller
   * omits it. The V1.24 fields (collectionMode/deepScrapeEnabled/
   * pagesVisited/transformStepCount/templateUsed/exportedAt) are
   * PURELY ADDITIVE — a caller that never passes them (or an OLDER
   * popup.js build, hypothetically) still gets a fully valid
   * dataset-info.json, and nothing here changes how V1.12-V1.23 fields
   * are shaped. */
  function buildDatasetInfo(meta) {
    meta = meta || {};
    return {
      datasetName: meta.datasetName || '',
      createdAt: meta.createdAt || Date.now(),
      sourceURL: meta.sourceURL || null,
      hostname: meta.hostname || null,
      savedScraperName: meta.savedScraperName || null,
      rowCount: meta.rowCount || 0,
      includedFormats: meta.includedFormats || [],
      assetCount: meta.assetCount || 0,
      failedAssetCount: meta.failedAssetCount || 0,
      scraperVersion: meta.scraperVersion || null,
      columns: (meta.columns || []).map(function (c) { return { name: c.name, attribute: c.attribute || null }; }),
      // V1.24 additions:
      collectionMode: meta.collectionMode || 'current-page',
      deepScrapeEnabled: !!meta.deepScrapeEnabled,
      pagesVisited: typeof meta.pagesVisited === 'number' ? meta.pagesVisited : null,
      transformStepCount: typeof meta.transformStepCount === 'number' ? meta.transformStepCount : 0,
      exportedAt: meta.exportedAt || Date.now()
    };
  }

  /**
   * V1.12 additive Saved Scraper field (same backward-compatibility
   * guarantee as every other additive field in this project — a scraper
   * saved under V1.11 or earlier simply lacks `research` and the
   * Research Bundle panel just falls back to computing fresh defaults
   * per spec #3 instead of reading a saved preference):
   *   research: {
   *     datasetNameTemplate: string,       // e.g. "{hostname} Research"
   *     includeCsv/Xlsx/Json: boolean,     // spec #3: Excel+JSON on, CSV off
   *     includeImages/Files: boolean,      // spec #3: Images on IF an image
   *                                        // column exists, Files off
   *     imageColumnId, fileColumnId: string|null,
   *     filenameTemplate: string           // spec #6, e.g. "{Dataset ID}_{Product Name}"
   *   }
   */
  function emptyResearchPrefs() {
    return {
      datasetNameTemplate: '',
      includeCsv: false, includeXlsx: true, includeJson: true,
      includeImages: true, includeFiles: false,
      imageColumnId: null, fileColumnId: null,
      filenameTemplate: ''
    };
  }

  root.WSResearch = {
    DATASET_ID_MIN_WIDTH: DATASET_ID_MIN_WIDTH,
    formatDatasetId: formatDatasetId,
    assignDatasetIds: assignDatasetIds,
    sanitizeDatasetName: sanitizeDatasetName,
    urlToFilenameMap: urlToFilenameMap,
    runItemsToStatusMap: runItemsToStatusMap,
    buildAssetPlan: buildAssetPlan,
    lookupAssetFilename: lookupAssetFilename,
    computeAssetStatus: computeAssetStatus,
    buildManifestRows: buildManifestRows,
    buildDatasetInfo: buildDatasetInfo,
    emptyResearchPrefs: emptyResearchPrefs
  };
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
