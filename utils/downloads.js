/**
 * downloads.js
 * Pure, chrome-API-free logic for V1.5 Bulk Download: URL validation,
 * dedup, file-type detection, filename templating/sanitization/dedup, and
 * queue-item construction. Loaded in both the popup (for the preview
 * summary) and the background service worker (for actually queuing
 * downloads) via importScripts — see background/background.js.
 *
 * Nothing here touches chrome.downloads itself; it only ever produces
 * plain, serializable {url, filename, rowIndex} objects that the caller
 * decides what to do with.
 */
(function (root) {
  'use strict';

  var ALLOWED_SCHEMES = ['http:', 'https:'];
  var MAX_DATA_URL_BYTES = 2 * 1024 * 1024; // 2MB — generous but bounded

  // ---- URL validation ---------------------------------------------------

  /**
   * @returns {{ok:true, scheme:string}|{ok:false, reason:string}}
   */
  function validateDownloadUrl(url) {
    if (!url || typeof url !== 'string') return { ok: false, reason: 'empty' };
    var trimmed = url.trim();
    if (!trimmed) return { ok: false, reason: 'empty' };

    if (/^blob:/i.test(trimmed)) return { ok: false, reason: 'unsupported-blob' };

    if (/^data:/i.test(trimmed)) {
      if (!/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i.test(trimmed)) {
        return { ok: false, reason: 'unsupported-data-url' };
      }
      var approxBytes = trimmed.length * 0.75;
      if (approxBytes > MAX_DATA_URL_BYTES) return { ok: false, reason: 'data-url-too-large' };
      return { ok: true, scheme: 'data' };
    }

    var scheme;
    try {
      scheme = new URL(trimmed).protocol;
    } catch (e) {
      return { ok: false, reason: 'invalid-url' };
    }
    if (ALLOWED_SCHEMES.indexOf(scheme) === -1) {
      return { ok: false, reason: 'disallowed-scheme' };
    }
    return { ok: true, scheme: scheme.replace(':', '') };
  }

  // ---- collection / dedup ------------------------------------------------

  /**
   * Normalizes a URL for duplicate COMPARISON only (the original, exact
   * URL is still what gets downloaded — see collectUniqueUrls). Strips
   * only the fragment, which never affects which resource is fetched.
   * Deliberately leaves the query string untouched: CDN image URLs
   * routinely encode resolution/format/version there (e.g. `?w=800`,
   * `?v=2`), so two URLs differing only in query params are treated as
   * genuinely different images, not duplicates.
   */
  function normalizeUrlForDedup(url) {
    try {
      var u = new URL(url);
      u.hash = '';
      return u.href;
    } catch (e) {
      return String(url).split('#')[0];
    }
  }

  /**
   * V1.13.2: the ZIP-packaging pipeline fetch()es each asset directly
   * (rather than handing individual URLs to chrome.downloads.download(),
   * which never needed host permissions since Chrome's own download
   * manager bypasses CORS entirely) — fetch() from an extension context
   * DOES need a matching host permission for each origin to bypass CORS.
   * This computes the minimal, precise set of `scheme://hostname/*`
   * patterns actually needed (never a blanket <all_urls> request),
   * matching this project's existing minimal-permissions convention (see
   * background.js's originPatternForHost, used the same way for
   * Monitoring). Invalid URLs are silently skipped — validateDownloadUrl
   * already gates what actually gets queued for fetching.
   */
  function uniqueOriginPatterns(urls) {
    var seen = Object.create(null);
    var patterns = [];
    urls.forEach(function (url) {
      var validation = validateDownloadUrl(url);
      if (!validation.ok || validation.scheme === 'data') return; // data: URLs need no host permission
      try {
        var u = new URL(url);
        var pattern = u.protocol + '//' + u.hostname + '/*';
        if (!seen[pattern]) { seen[pattern] = true; patterns.push(pattern); }
      } catch (e) { /* unparseable — already excluded by validateDownloadUrl in practice */ }
    });
    return patterns;
  }

  /**
   * Pulls candidate URLs out of one column across a row set, validating
   * and (optionally) deduplicating them. Row alignment is irrelevant here
   * by design — each surviving item keeps a reference to its own row, so
   * skipped/invalid/empty rows simply produce no item, never a
   * misaligned one.
   */
  function collectUniqueUrls(rows, columnId, skipDuplicates) {
    var seen = Object.create(null);
    var items = [];
    var duplicateCount = 0, invalidCount = 0, emptyCount = 0;

    rows.forEach(function (row, idx) {
      var raw = row[columnId];
      if (!raw) { emptyCount++; return; }
      var validation = validateDownloadUrl(raw);
      if (!validation.ok) { invalidCount++; return; }
      if (skipDuplicates !== false) {
        var key = normalizeUrlForDedup(raw);
        if (seen[key]) { duplicateCount++; return; }
        seen[key] = true;
      }
      items.push({ url: raw, rowIndex: idx, row: row });
    });

    return { items: items, duplicateCount: duplicateCount, invalidCount: invalidCount, emptyCount: emptyCount };
  }

  // ---- file type detection ------------------------------------------------

  var FILE_TYPE_GROUPS = {
    pdf: 'PDF', zip: 'ZIP', csv: 'CSV', xls: 'XLS/XLSX', xlsx: 'XLS/XLSX',
    doc: 'DOC/DOCX', docx: 'DOC/DOCX', txt: 'TXT', json: 'JSON', xml: 'XML',
    jpg: 'Images', jpeg: 'Images', png: 'Images', webp: 'Images', gif: 'Images', svg: 'Images'
  };
  var KNOWN_EXTENSIONS = Object.keys(FILE_TYPE_GROUPS);

  function extensionFromUrl(url) {
    try {
      var pathname;
      if (/^data:/i.test(url)) {
        var m = /^data:([a-z0-9.+-]+)\/([a-z0-9.+-]+);base64,/i.exec(url);
        return m ? m[2].toLowerCase().replace('jpeg', 'jpg') : null;
      }
      pathname = new URL(url).pathname;
      var match = /\.([a-zA-Z0-9]{1,5})$/.exec(pathname);
      return match ? match[1].toLowerCase() : null;
    } catch (e) {
      return null;
    }
  }

  /** @returns {{ext:string|null, group:string, known:boolean}} */
  function detectFileTypeGroup(url) {
    var ext = extensionFromUrl(url);
    if (ext && FILE_TYPE_GROUPS[ext]) return { ext: ext, group: FILE_TYPE_GROUPS[ext], known: true };
    return { ext: ext, group: 'Other', known: false };
  }

  // ---- filename templating -----------------------------------------------

  /**
   * {index} / {row} -> 1-based row position. {<Column Name>} -> that
   * column's value for this row (case-sensitive match against the
   * column's display name). Unknown tokens resolve to empty string
   * rather than throwing, so a stray typo just drops that token instead
   * of failing the whole filename.
   */
  function buildFilenameFromTemplate(template, row, columns, rowIndex) {
    if (!template) return '';
    return template.replace(/\{([^{}]+)\}/g, function (whole, token) {
      var t = token.trim();
      if (t === 'index' || t === 'row') return String(rowIndex + 1);
      var col = columns.filter(function (c) { return c.name === t; })[0];
      return col ? String(row[col.id] || '') : '';
    });
  }

  // ---- V1.24 export filename templating (spec #9-10) ---------------------
  // A SEPARATE, simpler token vocabulary from buildFilenameFromTemplate
  // above (which is per-ROW/per-ASSET — {index}/{ColumnName} — used by
  // Bulk Download and Research Bundle asset filenames). This one is for
  // the single CSV/Excel/JSON/NDJSON EXPORT FILE itself, so its tokens
  // describe the dataset as a whole, never a specific row. Purely data
  // substitution — no expression evaluation of any kind, exactly like
  // buildFilenameFromTemplate.

  function pad2Digits(n) { var s = String(n); return s.length < 2 ? '0' + s : s; }

  /** YYYY-MM-DD, using LOCAL time (matches what a user actually sees on
   * their own clock, not UTC) — deliberately simple/unambiguous, no
   * locale-dependent month/day ordering. */
  function formatDateToken(date) {
    return date.getFullYear() + '-' + pad2Digits(date.getMonth() + 1) + '-' + pad2Digits(date.getDate());
  }

  /** HH-mm-ss with hyphens, not colons — colons are an invalid Windows
   * filename character (see INVALID_FILENAME_CHARS_RE below), so this
   * avoids relying on sanitizeFilename to strip them back out later. */
  function formatTimeToken(date) {
    return pad2Digits(date.getHours()) + '-' + pad2Digits(date.getMinutes()) + '-' + pad2Digits(date.getSeconds());
  }

  var DEFAULT_EXPORT_FILENAME_TEMPLATE = '{scraper}_{date}';

  /**
   * Builds an export FILE's base name (no extension — the caller appends
   * .csv/.xlsx/.json/.ndjson) from a small, fixed token set:
   *   {site}    — hostname (e.g. "ebay.com")
   *   {scraper} — the Saved Scraper's name, or the site if none is loaded
   *   {date}    — YYYY-MM-DD, local time
   *   {time}    — HH-mm-ss, local time
   *   {rows}    — row count being exported
   *   {format}  — 'csv' | 'xlsx' | 'json' | 'ndjson' | ...
   * An unknown token resolves to empty string rather than throwing (same
   * convention as buildFilenameFromTemplate) so a typo never breaks the
   * whole export. Falls back to DEFAULT_EXPORT_FILENAME_TEMPLATE when no
   * template is given, and to a bare 'export' base if that ever somehow
   * still produces nothing usable (e.g. every token empty).
   * @param {string} template
   * @param {{site?:string, scraper?:string, rows?:number, format?:string, date?:Date}} context
   */
  function buildExportFilename(template, context) {
    context = context || {};
    var date = context.date || new Date();
    var tokens = {
      site: context.site || '',
      scraper: context.scraper || context.site || '',
      date: formatDateToken(date),
      time: formatTimeToken(date),
      rows: context.rows != null ? String(context.rows) : '',
      format: context.format || ''
    };
    var raw = String(template || DEFAULT_EXPORT_FILENAME_TEMPLATE).replace(/\{([^{}]+)\}/g, function (whole, token) {
      var t = token.trim();
      return Object.prototype.hasOwnProperty.call(tokens, t) ? tokens[t] : '';
    });
    var base = sanitizeFilename(raw);
    return base || 'export';
  }

  // ---- sanitization -----------------------------------------------------

  var INVALID_FILENAME_CHARS_RE = /[<>:"/\\|?*\x00-\x1F]/g;
  var MAX_FILENAME_BASE_LENGTH = 150;

  function sanitizeFilename(name) {
    var cleaned = String(name || '').replace(INVALID_FILENAME_CHARS_RE, '');
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    cleaned = cleaned.replace(/\.+$/, ''); // trailing dots are invalid on Windows
    if (cleaned.length > MAX_FILENAME_BASE_LENGTH) cleaned = cleaned.slice(0, MAX_FILENAME_BASE_LENGTH).trim();
    return cleaned;
  }

  /** Folder names allow forward slashes (for an optional sub-folder) but
   * are otherwise sanitized the same way, and any ".." path-traversal
   * segment is stripped — chrome.downloads.download()'s `filename` is
   * always relative to the Downloads folder and can't escape it anyway,
   * but this keeps the value predictable and avoids relying on that. */
  function sanitizeFolderName(name) {
    var parts = String(name || '').split('/').map(function (p) { return sanitizeFilename(p); })
      .filter(function (p) { return p && p !== '.' && p !== '..'; });
    return parts.join('/');
  }

  function pad3(n) {
    var s = String(n);
    while (s.length < 3) s = '0' + s;
    return s;
  }

  /**
   * Turns raw {url, rowIndex, row} items into final, unique, sanitized
   * filenames (with extension). Collisions resolve as name.jpg,
   * name_2.jpg, name_3.jpg — matching case-insensitively, since that's
   * how the destination filesystem will actually treat them.
   */
  function generateFilenames(items, options) {
    options = options || {};
    var downloadKind = options.downloadKind || 'file';
    var usedNames = Object.create(null);

    return items.map(function (item, i) {
      var raw = buildFilenameFromTemplate(options.template, item.row, options.columns || [], item.rowIndex);
      var base = sanitizeFilename(raw);
      if (!base) base = (downloadKind === 'image' ? 'image_' : 'file_') + pad3(i + 1);

      var ext = extensionFromUrl(item.url);
      if (!ext && downloadKind === 'image') ext = 'jpg';

      var candidate = ext ? base + '.' + ext : base;
      var finalName = candidate;
      var n = 2;
      while (usedNames[finalName.toLowerCase()]) {
        finalName = ext ? base + '_' + n + '.' + ext : base + '_' + n;
        n++;
      }
      usedNames[finalName.toLowerCase()] = true;

      var typeInfo = detectFileTypeGroup(item.url);
      return {
        url: item.url,
        rowIndex: item.rowIndex,
        filename: finalName,
        extension: ext,
        typeGroup: typeInfo.group,
        typeKnown: typeInfo.known
      };
    });
  }

  // ---- queue construction -------------------------------------------------

  /**
   * @param {Object[]} rows
   * @param {{id:string,name:string}[]} columns
   * @param {{
   *   columnId: string,
   *   downloadKind: 'image'|'file',
   *   template: string,
   *   skipDuplicates: boolean,
   *   typeFilter: string[]|null   // file-type groups to keep (files only)
   * }} options
   */
  function buildDownloadQueue(rows, columns, options) {
    var collected = collectUniqueUrls(rows, options.columnId, options.skipDuplicates);
    var items = collected.items;

    var typeFilterSkipped = 0;
    if (options.downloadKind === 'file' && options.typeFilter) {
      var before = items.length;
      items = items.filter(function (item) {
        return options.typeFilter.indexOf(detectFileTypeGroup(item.url).group) !== -1;
      });
      typeFilterSkipped = before - items.length;
    }

    var named = generateFilenames(items, { template: options.template, columns: columns, downloadKind: options.downloadKind });

    var byType = {};
    named.forEach(function (it) { byType[it.typeGroup] = (byType[it.typeGroup] || 0) + 1; });

    return {
      items: named.map(function (it, idx) {
        return {
          id: 'dl_' + idx + '_' + Math.random().toString(36).slice(2, 8),
          url: it.url, filename: it.filename, rowIndex: it.rowIndex,
          status: 'pending', downloadId: null, error: null
        };
      }),
      stats: {
        totalRows: rows.length,
        unique: named.length,
        duplicates: collected.duplicateCount,
        invalid: collected.invalidCount,
        empty: collected.emptyCount,
        typeFilterSkipped: typeFilterSkipped,
        byType: byType
      }
    };
  }

  root.WSDownloads = {
    validateDownloadUrl: validateDownloadUrl,
    normalizeUrlForDedup: normalizeUrlForDedup,
    uniqueOriginPatterns: uniqueOriginPatterns,
    collectUniqueUrls: collectUniqueUrls,
    extensionFromUrl: extensionFromUrl,
    detectFileTypeGroup: detectFileTypeGroup,
    buildFilenameFromTemplate: buildFilenameFromTemplate,
    buildExportFilename: buildExportFilename,
    DEFAULT_EXPORT_FILENAME_TEMPLATE: DEFAULT_EXPORT_FILENAME_TEMPLATE,
    sanitizeFilename: sanitizeFilename,
    sanitizeFolderName: sanitizeFolderName,
    generateFilenames: generateFilenames,
    buildDownloadQueue: buildDownloadQueue,
    FILE_TYPE_GROUPS: FILE_TYPE_GROUPS,
    KNOWN_EXTENSIONS: KNOWN_EXTENSIONS
  };
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
