/**
 * background.js
 * MV3 service worker. Owns:
 *   - small V1.3 hygiene (install log, stale dynamic-content-script cleanup)
 *   - V1.5 Bulk Download orchestration: the actual chrome.downloads calls,
 *     concurrency-limited queue processing, and chrome.downloads.onChanged
 *     tracking. This lives here (not the popup) so downloads keep
 *     progressing reliably even if the popup closes — MV3 service workers
 *     can be suspended and revived, so ALL of this is driven by
 *     re-checkable state in chrome.storage.session plus event listeners
 *     registered at the top level (required for MV3 to guarantee they
 *     fire after a service-worker wake-up), never by an in-memory loop
 *     that would be lost if the worker is killed.
 *   - V1.8 Scheduled Monitoring: chrome.alarms-driven headless re-runs of
 *     a Saved Scraper, reusing the exact same content-script messages the
 *     popup sends interactively (RUN_EXTRACTION / START_AUTO_SCROLL /
 *     START_MULTI_PAGE), then the same utils/transforms.js + snapshots.js
 *     + changes.js the popup uses — see the V1.8 section below.
 *
 * chrome.downloads is only ever usable from a privileged extension page
 * (background or popup) — never a content script — so the Bulk Download
 * section needs no awareness of the scraper engine at all; it only ever
 * receives plain {url, filename} items already produced by
 * utils/downloads.js. Monitoring, unlike downloads, DOES need the scraper
 * engine's *messages* (not its code — content/*.js is untouched) plus the
 * same pure utils/ modules the popup already uses.
 */

importScripts(
  '../utils/downloads.js',
  '../utils/storage.js',
  '../utils/recipes.js',
  '../utils/results.js',
  '../utils/transforms.js',
  '../utils/changes.js',
  '../utils/snapshots.js',
  '../utils/zip.js' // V1.13.2 — ZIP container writer + base64 helpers (see the V1.13.2 section below). Manifest BYTES (csv/xlsx/json/dataset-info.json) are still generated in the popup, same as V1.12 — this file only ever receives already-finished {name, dataB64} file descriptors for them, never regenerates manifest content itself.
  // V1.15 note: utils/plan.js (V1.14's Free/Pro feature-gate module) was
  // removed entirely — the new trial/license model (utils/license.js) is
  // popup.js-only. Monitoring is a fully available feature under the new
  // model and NEVER consumes trial credits, so background.js has no
  // reason to load or reference any licensing module at all.
);

chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') {
    console.log('Web Scraper installed.');
  }
  reconcileMonitoringAlarms();
});

chrome.runtime.onStartup.addListener(function () {
  if (!chrome.scripting || !chrome.scripting.getRegisteredContentScripts) return;
  chrome.scripting.getRegisteredContentScripts({}, function (scripts) {
    if (chrome.runtime.lastError || !scripts) return;
    var staleIds = scripts
      .filter(function (s) { return s.id && s.id.indexOf('ws-pagination-') === 0; })
      .map(function (s) { return s.id; });
    if (staleIds.length) {
      chrome.scripting.unregisterContentScripts({ ids: staleIds }, function () {
        void chrome.runtime.lastError; // best-effort cleanup, nothing to react to either way
      });
    }
  });
  reconcileMonitoringAlarms();
  healStaleRunningStatuses();
});

// =====================================================================
// V1.5 Bulk Download
// =====================================================================

var DOWNLOAD_RUN_KEY = 'ws_download_run';
var DEFAULT_CONCURRENCY = 4;

function getDownloadRunState() {
  return new Promise(function (resolve) {
    chrome.storage.session.get([DOWNLOAD_RUN_KEY], function (result) {
      resolve((result && result[DOWNLOAD_RUN_KEY]) || null);
    });
  });
}

function setDownloadRunState(runState) {
  var data = {};
  data[DOWNLOAD_RUN_KEY] = runState;
  return new Promise(function (resolve) {
    chrome.storage.session.set(data, resolve);
  });
}

function computeDownloadCounts(items) {
  var c = { total: items.length, pending: 0, downloading: 0, completed: 0, failed: 0, skipped: 0, cancelled: 0 };
  items.forEach(function (it) { c[it.status] = (c[it.status] || 0) + 1; });
  return c;
}

/**
 * Starts (or resumes pumping) a download run: fills free concurrency
 * slots from the pending queue. Called after every state-changing event
 * (start, an item completing/failing, a retry) — this event-driven shape
 * is what makes the queue resilient to the service worker being
 * suspended and woken back up mid-run.
 */
async function pumpDownloadQueue() {
  var runState = await getDownloadRunState();
  if (!runState || runState.status !== 'downloading') return;

  var inFlight = runState.items.filter(function (it) { return it.status === 'downloading'; }).length;
  var slots = runState.concurrency - inFlight;
  if (slots <= 0) return;

  var pending = runState.items.filter(function (it) { return it.status === 'pending'; });
  var toStart = pending.slice(0, slots);

  if (!toStart.length) {
    await maybeFinalizeDownloadRun();
    return;
  }

  var folder = WSDownloads.sanitizeFolderName(runState.folderName) || 'Web Scraper';

  for (var i = 0; i < toStart.length; i++) {
    var item = toStart[i];
    item.status = 'downloading';
    try {
      var downloadId = await new Promise(function (resolve, reject) {
        chrome.downloads.download(
          { url: item.url, filename: folder + '/' + item.filename, conflictAction: 'uniquify', saveAs: false },
          function (id) {
            if (chrome.runtime.lastError || id === undefined) {
              reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'failed to start'));
            } else {
              resolve(id);
            }
          }
        );
      });
      item.downloadId = downloadId;
    } catch (e) {
      item.status = 'failed';
      item.error = String((e && e.message) || e);
    }
  }

  runState.counts = computeDownloadCounts(runState.items);
  runState.updatedAt = Date.now();
  await setDownloadRunState(runState);
}

async function maybeFinalizeDownloadRun() {
  var runState = await getDownloadRunState();
  if (!runState) return;
  var stillActive = runState.items.some(function (it) { return it.status === 'pending' || it.status === 'downloading'; });
  if (stillActive) return;
  if (runState.status === 'downloading' || runState.status === 'stopping') {
    runState.status = runState.status === 'stopping' ? 'stopped' : 'completed';
    runState.updatedAt = Date.now();
    await setDownloadRunState(runState);
  }
}

async function startDownloadRun(items, folderName, concurrency) {
  var runState = {
    runId: 'dlrun_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    status: 'downloading',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    folderName: folderName || 'Web Scraper',
    concurrency: concurrency || DEFAULT_CONCURRENCY,
    items: items,
    counts: computeDownloadCounts(items)
  };
  await setDownloadRunState(runState);
  await pumpDownloadQueue();
  return getDownloadRunState();
}

/**
 * Stop: blocks new downloads from starting (status -> 'stopping'),
 * flips still-pending items straight to 'cancelled' (they were never
 * handed to chrome.downloads at all), and cancels ONLY the downloadIds
 * this run itself started and is still tracking as 'downloading' — never
 * touches any other download in the user's history. Completed files are
 * never removed.
 */
async function stopDownloadRun() {
  var runState = await getDownloadRunState();
  if (!runState) return null;

  runState.status = 'stopping';
  runState.items.forEach(function (it) {
    if (it.status === 'pending') it.status = 'cancelled';
  });
  runState.counts = computeDownloadCounts(runState.items);
  runState.updatedAt = Date.now();
  await setDownloadRunState(runState);

  var inFlightIds = runState.items
    .filter(function (it) { return it.status === 'downloading' && it.downloadId != null; })
    .map(function (it) { return it.downloadId; });

  for (var i = 0; i < inFlightIds.length; i++) {
    await new Promise(function (resolve) { chrome.downloads.cancel(inFlightIds[i], function () { resolve(); }); });
  }

  await maybeFinalizeDownloadRun();
  return getDownloadRunState();
}

async function retryFailedDownloads() {
  var runState = await getDownloadRunState();
  if (!runState) return null;
  runState.items.forEach(function (it) {
    if (it.status === 'failed') {
      it.status = 'pending';
      it.downloadId = null;
      it.error = null;
    }
  });
  runState.status = 'downloading';
  runState.counts = computeDownloadCounts(runState.items);
  runState.updatedAt = Date.now();
  await setDownloadRunState(runState);
  await pumpDownloadQueue();
  return getDownloadRunState();
}

/**
 * All four ways the outside world can mutate the download run state
 * (starting a run, an onChanged event, Stop, Retry Failed) do their own
 * read-modify-write against chrome.storage.session. If two of them ever
 * ran concurrently — entirely possible: chrome.downloads.onChanged fires
 * once per download, so two downloads finishing close together dispatch
 * two overlapping async listener calls — the second one to read the
 * state would read a stale copy from before the first one's write,
 * silently reverting it (a classic lost-update race). This tiny promise
 * chain serializes every such operation so they always run one at a
 * time, however many events land back to back.
 */
var downloadOpQueue = Promise.resolve();
function serializeDownloadOp(fn) {
  var result = downloadOpQueue.then(fn, fn);
  downloadOpQueue = result.then(function () {}, function () {}); // never let a rejection break the chain for later callers
  return result;
}

// Registered at the TOP LEVEL (not inside an async function or another
// callback) — MV3 requires this for Chrome to guarantee delivery even
// after the service worker was suspended and just woke back up for this
// exact event.
chrome.downloads.onChanged.addListener(function (delta) {
  serializeDownloadOp(function () { return handleDownloadChanged(delta); })
    .catch(function (e) { console.error('[Web Scraper] download onChanged handler error:', e); });
});

async function handleDownloadChanged(delta) {
  var runState = await getDownloadRunState();
  if (!runState) return;
  var item = runState.items.filter(function (it) { return it.downloadId === delta.id; })[0];
  if (!item) return; // not one of ours — never touch downloads we didn't start

  if (delta.state && delta.state.current === 'complete') {
    item.status = 'completed';
  } else if (delta.state && delta.state.current === 'interrupted') {
    item.status = (runState.status === 'stopping') ? 'cancelled' : 'failed';
    item.error = (delta.error && delta.error.current) || 'interrupted';
  } else {
    return; // an in-progress byte-count update etc. — nothing to react to
  }

  runState.counts = computeDownloadCounts(runState.items);
  runState.updatedAt = Date.now();
  await setDownloadRunState(runState);
  await pumpDownloadQueue();
  await maybeFinalizeDownloadRun();
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) return;

  if (message.type === 'START_DOWNLOAD_RUN') {
    serializeDownloadOp(function () { return startDownloadRun(message.items, message.folderName, message.concurrency); })
      .then(function (rs) { sendResponse({ ok: true, runState: rs }); });
    return true;
  }

  if (message.type === 'STOP_DOWNLOAD_RUN') {
    serializeDownloadOp(function () { return stopDownloadRun(); })
      .then(function (rs) { sendResponse({ ok: true, runState: rs }); });
    return true;
  }

  if (message.type === 'RETRY_FAILED_DOWNLOADS') {
    serializeDownloadOp(function () { return retryFailedDownloads(); })
      .then(function (rs) { sendResponse({ ok: true, runState: rs }); });
    return true;
  }

  if (message.type === 'GET_DOWNLOAD_RUN_STATE') {
    getDownloadRunState().then(function (rs) { sendResponse({ ok: true, runState: rs }); });
    return true;
  }
});

// =====================================================================
// V1.8 Scheduled Monitoring
//
// A monitored Saved Scraper gets a chrome.alarms entry (name
// `ws_monitor::<scraperId>`). When it fires (or the user clicks "Run Now"
// in the popup), runScheduledScrape():
//   1. opens the scraper's last-known URL in a new, INACTIVE background
//      tab (never steals focus, never touches the user's other tabs),
//   2. waits for it to finish loading, injects the same content scripts
//      the popup would,
//   3. reuses the EXACT SAME messages the popup sends interactively
//      (RUN_EXTRACTION for current-page; START_AUTO_SCROLL /
//      START_MULTI_PAGE + watching the same ws_run::<hostname> session
//      key for everything else) — content/*.js is completely unaware of
//      whether a popup or the background service worker asked it to run,
//      so nothing there needed to change,
//   4. replays the scraper's saved transforms (utils/transforms.js) if
//      autoApplyTransforms is on — same module, same rules as the popup,
//   5. saves a snapshot and compares it against the previous one
//      (utils/snapshots.js + utils/changes.js — same modules, same
//      policies as the interactive Snapshots panel),
//   6. records ONLY the outcome (status/timestamps/compact summary) via
//      WSRecipes.updateMonitoringStatus — never touches columns,
//      containerSelector, transforms, or any existing snapshot, so a
//      failed run can never destroy prior state (it structurally can't:
//      the snapshot-writing step in 5 simply never runs on a failure),
//   7. always closes the tab it opened, success or failure.
//
// Chrome platform note: a background-created tab is NOT covered by
// activeTab (that only ever grants access following a direct user
// gesture on the tab that's currently active), so scripting a tab we
// opened ourselves needs a real, persistent host permission for that
// origin. Enabling monitoring in the popup requests it via
// chrome.permissions.request() at that moment (a genuine user gesture);
// this file only ever checks chrome.permissions.contains() (no
// gesture needed) and fails a run cleanly — never silently — if it's
// missing or was later revoked.
// =====================================================================

var MONITOR_DEFAULT_INTERVAL = 60; // minutes, matches WSRecipes.MONITOR_INTERVALS[0]
var RUN_COMPLETION_TIMEOUT_MS = 5 * 60 * 1000; // auto-scroll/multi-page cap, mirrors their own maxRows/maxPages limits already bounding real duration
var TAB_LOAD_TIMEOUT_MS = 30 * 1000;

// Mirrors popup.js's CONTENT_FILES exactly — kept in sync manually since
// there's no shared module purely for a file-path list without adding a
// dependency the other way.
var CONTENT_FILES = [
  'utils/storage.js',
  'utils/runstate.js',
  'content/selector.js',
  'content/structureddata.js',
  'content/scraper.js',
  'content/domwait.js',
  'content/content.js',
  'content/pagination.js',
  'content/autodetect.js',
  'content/livewatch.js'
];

function alarmNameFor(scraperId) {
  return 'ws_monitor::' + scraperId;
}

function originPatternForHost(hostname) {
  return '*://' + hostname + '/*';
}

/** Same lost-update protection as downloadOpQueue, kept as a separate
 * queue on purpose: monitoring writes and download writes touch
 * different storage keys and have no reason to wait on each other. */
var monitoringOpQueue = Promise.resolve();
function serializeMonitoringOp(fn) {
  var result = monitoringOpQueue.then(fn, fn);
  monitoringOpQueue = result.then(function () {}, function () {});
  return result;
}

/** Rebuilds every monitoring alarm from the persisted Saved Scrapers list
 * — called on install/startup so alarms survive a browser restart even
 * though chrome.alarms itself already persists them; this also self-heals
 * if an alarm was ever lost, and clears any alarm for a scraper that's
 * been deleted or had monitoring turned off since. */
async function reconcileMonitoringAlarms() {
  var existing = await new Promise(function (resolve) { chrome.alarms.getAll(resolve); });
  var staleMonitorAlarms = existing.filter(function (a) { return a.name.indexOf('ws_monitor::') === 0; });
  for (var i = 0; i < staleMonitorAlarms.length; i++) {
    await new Promise(function (resolve) { chrome.alarms.clear(staleMonitorAlarms[i].name, resolve); });
  }

  var monitored = await WSRecipes.listMonitoredScrapers();
  var now = Date.now();
  monitored.forEach(function (scraper) {
    var interval = scraper.monitoring.intervalMinutes || MONITOR_DEFAULT_INTERVAL;
    var nextRunAt = scraper.monitoring.nextRunAt;
    var delayMinutes = (nextRunAt && nextRunAt > now) ? (nextRunAt - now) / 60000 : 1; // overdue/never-run -> fire soon, not instantly (avoids a startup stampede)
    chrome.alarms.create(alarmNameFor(scraper.id), { delayInMinutes: delayMinutes, periodInMinutes: interval });
  });
}

/** A scraper stuck showing "running" forever (because the browser closed
 * or the extension reloaded mid-run) would look broken — self-heals it
 * to a clear error status rather than a permanent false "running". */
async function healStaleRunningStatuses() {
  var scrapers = await WSRecipes.listScrapers();
  for (var i = 0; i < scrapers.length; i++) {
    var s = scrapers[i];
    if (s.monitoring && s.monitoring.lastRunStatus === 'running') {
      await serializeMonitoringOp(function (id) {
        return function () {
          return WSRecipes.updateMonitoringStatus(id, { status: 'error', error: 'Interrupted (browser or extension restarted mid-run).' });
        };
      }(s.id));
    }
  }
}

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (!alarm || alarm.name.indexOf('ws_monitor::') !== 0) return;
  var scraperId = alarm.name.slice('ws_monitor::'.length);
  runScheduledScrape(scraperId).catch(function (e) {
    console.error('[Web Scraper] scheduled run error:', e);
  });
});

function sendMessageToTab(tabId, message) {
  return new Promise(function (resolve) {
    chrome.tabs.sendMessage(tabId, message, function (response) {
      void chrome.runtime.lastError; // no listener yet / navigated away — resolve(null) below covers it
      resolve(response || null);
    });
  });
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timed out waiting for the page to load.'));
    }, timeoutMs);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete' || done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
    // covers the race where the tab is already 'complete' before we
    // finished attaching the listener above
    chrome.tabs.get(tabId, function (tab) {
      void chrome.runtime.lastError;
      if (tab && tab.status === 'complete' && !done) {
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

/** Waits for content/pagination.js's ws_run::<hostname> session state to
 * reach a terminal status, event-driven via chrome.storage.onChanged
 * (not a sleep-poll loop) so it reacts immediately and doesn't depend on
 * a particular wake cadence. */
function waitForRunCompletion(runKey, timeoutMs) {
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      chrome.storage.onChanged.removeListener(listener);
      resolve(null); // timeout — caller treats null as failure
    }, timeoutMs);
    var TERMINAL = ['completed', 'stopped', 'error'];
    function finish(v) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.storage.onChanged.removeListener(listener);
      resolve(v);
    }
    function listener(changes, areaName) {
      if (areaName !== 'session' || !changes[runKey]) return;
      var v = changes[runKey].newValue;
      if (v && TERMINAL.indexOf(v.status) !== -1) finish(v);
    }
    chrome.storage.onChanged.addListener(listener);
    chrome.storage.session.get([runKey], function (result) {
      var v = result && result[runKey];
      if (v && TERMINAL.indexOf(v.status) !== -1) finish(v);
    });
  });
}

async function runExtractionForMode(tabId, scraper) {
  var mode = scraper.mode || 'current-page';
  var hostname = scraper.hostname;
  var runKey = 'ws_run::' + hostname;

  if (mode === 'current-page') {
    // RUN_EXTRACTION (content/content.js) reads the CURRENT ws_state::<hostname>
    // config rather than anything in the message, so it must be primed
    // first — exactly what applyLoadedScraper() does interactively.
    var previousState = await WSStorage.getState(hostname);
    await WSStorage.setState(hostname, { containerSelector: scraper.containerSelector, columns: scraper.columns });
    try {
      var res = await sendMessageToTab(tabId, { type: 'RUN_EXTRACTION' });
      if (!res || !res.ok) return { ok: false, error: 'Extraction failed (content script did not respond).' };
      return { ok: true, rows: res.rows };
    } finally {
      // restore whatever config (if any) was there before — never leave a
      // stray overwrite behind for the user's own interactive session on
      // this same hostname.
      await WSStorage.setState(hostname, previousState);
    }
  }

  // V1.19 spec #13: keep scheduled Monitoring conservative — a saved
  // scraper's NEW 'load-more' mode never runs headlessly under
  // Monitoring, deliberately, until that path gets its own dedicated
  // testing. Existing 'auto-scroll'/'multi-page' Monitoring support
  // (V1.3/V1.8, unchanged) keeps working exactly as it always has,
  // including a 'multi-page' scraper using V1.19's new URL-pattern
  // method — that's still the SAME already-allowed multi-page trust
  // category, just a different next-step-resolution method, and the
  // same maxPages/maxRows/delayMs safety limits still apply.
  if (mode === 'load-more') {
    return { ok: false, error: 'Load More is not yet supported in scheduled Monitoring. Switch this scraper to Current Page, Auto Scroll, or Multi-page, or disable Monitoring.' };
  }

  var existingRun = await new Promise(function (resolve) { chrome.storage.session.get([runKey], function (r) { resolve(r && r[runKey]); }); });
  if (existingRun && ['running', 'preparing', 'waiting'].indexOf(existingRun.status) !== -1) {
    return { ok: false, error: 'A run for this site was already in progress — skipped this scheduled run.' };
  }

  var registeredId = null;
  if (mode === 'multi-page') {
    var origin = originPatternForHost(hostname);
    registeredId = 'ws-pagination-' + hostname;
    try {
      await chrome.scripting.registerContentScript({ id: registeredId, matches: [origin], js: CONTENT_FILES, runAt: 'document_idle', persistAcrossSessions: false });
    } catch (e) {
      try { await chrome.scripting.unregisterContentScripts({ ids: [registeredId] }); } catch (e2) { /* ignore */ }
      try { await chrome.scripting.registerContentScript({ id: registeredId, matches: [origin], js: CONTENT_FILES, runAt: 'document_idle', persistAcrossSessions: false }); } catch (e3) {
        return { ok: false, error: 'Could not prepare Multi-page for this site.' };
      }
    }
  }

  var startMessage = mode === 'auto-scroll'
    ? { type: 'START_AUTO_SCROLL', tabId: tabId, containerSelector: scraper.containerSelector, columns: scraper.columns, dedupeKey: scraper.dedupeKey || 'entire-row', limits: scraper.limits || undefined }
    : {
      type: 'START_MULTI_PAGE', tabId: tabId, containerSelector: scraper.containerSelector, columns: scraper.columns,
      dedupeKey: scraper.dedupeKey || 'entire-row', limits: scraper.limits || undefined, nextButtonConfig: scraper.nextButtonConfig,
      paginationMethod: scraper.paginationMethod || 'nextButton', urlPatternConfig: scraper.urlPatternConfig || null
    };

  var startRes = await sendMessageToTab(tabId, startMessage);
  if (!startRes || !startRes.ok) {
    if (registeredId) { try { await chrome.scripting.unregisterContentScripts({ ids: [registeredId] }); } catch (e) { /* ignore */ } }
    return { ok: false, error: 'Could not start ' + mode + ' on this page.' };
  }

  var finalState = await waitForRunCompletion(runKey, RUN_COMPLETION_TIMEOUT_MS);
  if (registeredId) { try { await chrome.scripting.unregisterContentScripts({ ids: [registeredId] }); } catch (e) { /* ignore */ } }

  if (!finalState) return { ok: false, error: 'Timed out waiting for the run to finish.' };
  if (finalState.status === 'error') return { ok: false, error: 'Run ended in an error: ' + (finalState.stopReason || finalState.error || 'unknown') };
  return { ok: true, rows: finalState.rows || [] };
}

/**
 * @param {Object} result {status, summary, error, hasChanges?, totalRows?,
 *   newCount?, removedCount?, changedCount?} — the row-count fields are
 *   omitted for an error result (nothing was successfully compared) and
 *   become a V1.10 history entry with those fields left null,
 *   distinguishing "failed, no stats available" from "succeeded with zero
 *   changes". hasChanges (V1.11) feeds monitoring.lastRunHasChanges, the
 *   dashboard's CHANGED-vs-SUCCESS distinction — always explicit (true or
 *   false) on a success result so a stale prior value never lingers.
 */
async function finishMonitoringRun(scraperId, intervalMinutes, result) {
  var interval = intervalMinutes || MONITOR_DEFAULT_INTERVAL;
  var now = Date.now();
  await serializeMonitoringOp(function () {
    return WSRecipes.updateMonitoringStatus(scraperId, {
      status: result.status,
      lastRunAt: now,
      nextRunAt: now + interval * 60000,
      summary: result.summary || '',
      error: result.error || null,
      hasChanges: result.hasChanges === true,
      historyEntry: {
        at: now,
        status: result.status,
        totalRows: result.totalRows != null ? result.totalRows : null,
        newCount: result.newCount != null ? result.newCount : null,
        removedCount: result.removedCount != null ? result.removedCount : null,
        changedCount: result.changedCount != null ? result.changedCount : null,
        error: result.error || null
      }
    });
  });
}

// =====================================================================
// V1.9 Notifications: a native chrome.notifications alert whenever a
// monitored run (scheduled OR manual "Run Now") finds actual changes, or
// fails outright. Deliberately silent for a successful run with ZERO
// changes and for the very first snapshot of a scraper (nothing to
// compare against yet) — a notification on every routine check would
// defeat the point of "tell me when something's actually different".
// Per-scraper opt-out via monitoring.notifyOnChanges (default true, same
// "on by default, always user-controlled" pattern as every other toggle
// in this project — see recipes.js's header comment).
// =====================================================================

function notifyMonitoringResult(scraper, message, isError) {
  if (!scraper || !scraper.monitoring || scraper.monitoring.notifyOnChanges === false) return;
  if (!chrome.notifications || !chrome.notifications.create) return; // defensive — missing permission/unsupported context
  try {
    chrome.notifications.create('ws_monitor_notify::' + scraper.id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: (isError ? '⚠ Web Scraper — ' : '📡 Web Scraper — ') + scraper.name,
      message: message,
      priority: isError ? 2 : 0
    }, function () { void chrome.runtime.lastError; }); // best-effort — a notification failing to display never breaks the monitoring run itself
  } catch (e) {
    console.error('[Web Scraper] notification error:', e);
  }
}

/** The full headless run: see the section header comment above for the
 * step-by-step. Exposed to both the alarm listener and the "Run Now"
 * message handler — identical code path either way. */
async function runScheduledScrape(scraperId) {
  var scraper = await WSRecipes.getScraper(scraperId);
  if (!scraper) {
    chrome.alarms.clear(alarmNameFor(scraperId));
    return;
  }
  if (!scraper.monitoring || !scraper.monitoring.enabled) return; // stale/disabled — nothing to do

  // V1.15: Monitoring is fully available under the new trial/license
  // model and NEVER consumes a trial run credit — the 10-run trial
  // applies only to user-initiated scraping (Preview/Start Run in
  // popup.js). V1.14's Pro-only gate here (WSPlan.hasFeature('monitoring'))
  // is removed entirely along with the rest of the Free/Pro model.

  await serializeMonitoringOp(function () { return WSRecipes.updateMonitoringStatus(scraperId, { status: 'running' }); });

  var origin = originPatternForHost(scraper.hostname);
  var hasPermission = await new Promise(function (resolve) { chrome.permissions.contains({ origins: [origin] }, resolve); });
  if (!hasPermission) {
    var permissionError = 'Site permission not granted — disable and re-enable Monitoring for this scraper to grant it.';
    await finishMonitoringRun(scraperId, scraper.monitoring.intervalMinutes, { status: 'error', error: permissionError });
    notifyMonitoringResult(scraper, permissionError, true);
    return;
  }

  var url = scraper.lastKnownUrl || ('https://' + scraper.hostname + scraper.pathname);
  var tabId = null;
  try {
    var tab = await new Promise(function (resolve, reject) {
      chrome.tabs.create({ url: url, active: false }, function (t) {
        if (chrome.runtime.lastError || !t) reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Could not open a background tab.'));
        else resolve(t);
      });
    });
    tabId = tab.id;

    await waitForTabComplete(tabId, TAB_LOAD_TIMEOUT_MS);
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: CONTENT_FILES });

    var extraction = await runExtractionForMode(tabId, scraper);
    if (!extraction.ok) throw new Error(extraction.error || 'Extraction failed.');

    var columns = (scraper.columns || []).map(function (c) { return { id: c.id, name: c.name, attribute: c.attribute }; });
    var effective = { rows: extraction.rows, columns: columns };
    if (scraper.autoApplyTransforms !== false && scraper.transforms && scraper.transforms.length) {
      effective = WSTransforms.applyTransforms(extraction.rows, columns, scraper.transforms, { baseUrl: url });
    }
    var namedColumns = effective.columns.map(function (c) { return { name: c.name, attribute: c.attribute }; });
    var namedRows = WSChanges.toNamedRows(effective.columns, effective.rows);

    var previousSnapshot = await WSSnapshots.getLatestSnapshot({ scraperId: scraperId });
    var saveRes = await WSSnapshots.saveSnapshot({
      scraperId: scraperId, scraperName: scraper.name, url: url,
      hostname: scraper.hostname, pathname: scraper.pathname,
      columns: namedColumns, rows: namedRows, uniqueKey: scraper.compareKey || 'entire-row'
    });
    if (!saveRes.ok) throw new Error(saveRes.error || 'Could not save a snapshot.');

    var summary;
    var hasChanges = false;
    // V1.10: every successful run's row-count breakdown, regardless of
    // whether it triggers a notification — feeds monitoring.history.
    // The first snapshot has no previous run to compare against, so it's
    // recorded as "every row is new" (an intuitive, honest reading of
    // "here's what monitoring first saw"), never as a notification.
    var historyStats;
    if (previousSnapshot) {
      var cmp = WSChanges.compareDatasets(previousSnapshot.rows, namedRows, namedColumns, { keyMode: scraper.compareKey || 'entire-row' });
      summary = '+' + cmp.stats.newCount + ' new, -' + cmp.stats.removedCount + ' removed, ~' + cmp.stats.changedCount + ' changed';
      if (cmp.stats.priceDecreased || cmp.stats.priceIncreased) summary += ' (price: ↓' + cmp.stats.priceDecreased + ' ↑' + cmp.stats.priceIncreased + ')';
      hasChanges = cmp.stats.newCount > 0 || cmp.stats.removedCount > 0 || cmp.stats.changedCount > 0;
      historyStats = { totalRows: namedRows.length, newCount: cmp.stats.newCount, removedCount: cmp.stats.removedCount, changedCount: cmp.stats.changedCount };
    } else {
      summary = 'First snapshot captured (' + namedRows.length + ' rows).';
      // No notification for the very first snapshot — there is nothing to
      // compare against yet, so "changes" is meaningless here.
      historyStats = { totalRows: namedRows.length, newCount: namedRows.length, removedCount: 0, changedCount: 0 };
    }

    await finishMonitoringRun(scraperId, scraper.monitoring.intervalMinutes, Object.assign({ status: 'success', summary: summary, hasChanges: hasChanges }, historyStats));
    if (hasChanges) notifyMonitoringResult(scraper, summary, false);
  } catch (e) {
    var errorMessage = String((e && e.message) || e);
    await finishMonitoringRun(scraperId, scraper.monitoring.intervalMinutes, { status: 'error', error: errorMessage });
    notifyMonitoringResult(scraper, errorMessage, true);
  } finally {
    if (tabId !== null) {
      try { await new Promise(function (resolve) { chrome.tabs.remove(tabId, resolve); }); } catch (e) { /* tab may already be gone */ }
    }
  }
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) return;

  if (message.type === 'SET_MONITORING') {
    // nextRunAt is recomputed HERE (not left stale) whenever monitoring is
    // (re-)enabled, since a brand new chrome.alarms entry is about to be
    // created below with exactly this delay — the displayed "Next run"
    // must always reflect the alarm that actually exists, never a schedule
    // left over from before an earlier Disable. Disabling clears it to
    // null: no alarm exists while disabled, so there is no real next run.
    // lastRunAt/lastRunStatus/lastRunSummary/lastError are NEVER part of
    // this patch — setMonitoringConfig structurally cannot touch them.
    var interval = message.intervalMinutes || MONITOR_DEFAULT_INTERVAL;
    var patch = { enabled: message.enabled, intervalMinutes: message.intervalMinutes };
    patch.nextRunAt = message.enabled ? (Date.now() + interval * 60000) : null;
    if (message.notifyOnChanges !== undefined) patch.notifyOnChanges = message.notifyOnChanges;

    serializeMonitoringOp(function () {
      return WSRecipes.setMonitoringConfig(message.scraperId, patch);
    }).then(function (res) {
      if (!res.ok) { sendResponse(res); return; }
      if (message.enabled) {
        chrome.alarms.create(alarmNameFor(message.scraperId), { delayInMinutes: interval, periodInMinutes: interval });
      } else {
        chrome.alarms.clear(alarmNameFor(message.scraperId));
      }
      sendResponse(res);
    });
    return true;
  }

  if (message.type === 'SET_NOTIFY') {
    // V1.9: touches ONLY notifyOnChanges — never enabled/intervalMinutes/
    // nextRunAt, so it never recreates the chrome.alarms entry or
    // disturbs the actual monitoring schedule as a side effect of
    // toggling a notification preference.
    serializeMonitoringOp(function () {
      return WSRecipes.setMonitoringConfig(message.scraperId, { notifyOnChanges: message.notifyOnChanges });
    }).then(function (res) { sendResponse(res); });
    return true;
  }

  if (message.type === 'CLEAR_MONITORING_HISTORY') {
    // V1.10: routed through background.js (not called directly from the
    // popup) for the same reason every other monitoring mutation is —
    // serializeMonitoringOp is the only thing preventing a concurrent
    // scheduled run's status write from racing a popup-initiated write
    // to the same ws_saved_scrapers blob; a direct popup-side write
    // would bypass that queue entirely.
    serializeMonitoringOp(function () {
      return WSRecipes.clearMonitoringHistory(message.scraperId);
    }).then(function (res) { sendResponse(res); });
    return true;
  }

  if (message.type === 'RUN_MONITORED_NOW') {
    // Fire-and-acknowledge: the run can take a while (page load +
    // extraction), so the popup doesn't block on it — it reflects
    // progress via chrome.storage.onChanged on ws_saved_scrapers instead,
    // same live-update pattern as run/download progress in V1.3/V1.5.
    runScheduledScrape(message.scraperId).catch(function (e) {
      console.error('[Web Scraper] "Run Now" error:', e);
    });
    sendResponse({ ok: true, started: true });
    return true;
  }
});

// =====================================================================
// V1.13.2 ZIP Bundle: replaces one-chrome.downloads.download()-call-per-
// asset (V1.5's Bulk Download, and V1.12 Research Bundle's asset queue,
// which reused V1.5's queue) with fetch()-everything-then-package-into-
// ONE-zip-then-ONE-download. Chrome's downloads UI/save dialog piling up
// dozens of entries for a single logical "give me these 60 images" action
// was the exact complaint this replaces — the user now performs exactly
// one download action per bundle, always.
//
// Division of labor deliberately mirrors V1.12's Research Bundle:
//   - the POPUP still plans everything synchronous/pure (Dataset IDs,
//     filenames, dedup, manifest CONTENT) via the exact same
//     WSDownloads/WSResearch/WSCsv/WSXlsx calls it already made — V1.13.2
//     changed WHERE the resulting bytes end up (one zip via background.js
//     instead of N/a-few direct chrome.downloads.download() calls from
//     the popup), never how they're computed;
//   - BACKGROUND.js is now additionally responsible for fetch()ing each
//     asset's bytes, assembling the final ZIP (WSZip.buildZip, the same
//     writer xlsx.js has used since V1.1 for its own container), and
//     making the ONE chrome.downloads.download() call — living here (not
//     the popup) for the same reason every other multi-step background
//     operation in this file does: it keeps progressing even if the
//     popup that started it gets closed... with one caveat, see below.
//
// fetch() (unlike chrome.downloads.download(), which always bypassed
// CORS via Chrome's own download manager) DOES enforce CORS from an
// extension context UNLESS the extension holds a matching host
// permission for that origin — so enabling Images/Files in a bundle now
// also requires a one-time chrome.permissions.request() for exactly the
// origins the queued asset URLs point to (never a blanket <all_urls>
// grab) — requested by the POPUP at the moment of a genuine user gesture
// (the "Download Images"/"Create Bundle" click), matching every other
// permission-request in this project; this file only ever calls the
// gesture-free chrome.permissions.contains() before fetching.
//
// KNOWN LIMITATION (documented, not silently accepted): the bytes
// fetched so far and the AbortController backing Stop/cancellation both
// live ONLY in this service worker's in-memory state (zipRunContexts/
// zipAbortControllers below) — chrome.storage.session only ever holds
// lightweight per-item STATUS, never the actual image bytes (which would
// blow well past session storage's quota for even a modest bundle). If
// the service worker is killed and restarted mid-run (the same general
// MV3 constraint V1.8's own header comment already calls out for long
// monitored runs), an in-progress zip run cannot resume — the popup will
// simply stop seeing progress updates for it. A short Preview/Bulk-
// Download-sized run (tens of images, well under a minute of fetching)
// is very unlikely to hit this in practice.
// =====================================================================

var ZIP_RUN_KEY = 'ws_zip_run';

/** Same lost-update protection as download/monitoring's own queues, kept
 * separate on purpose — zip runs never need to wait on either of those. */
var zipOpQueue = Promise.resolve();
function serializeZipOp(fn) {
  var result = zipOpQueue.then(fn, fn);
  zipOpQueue = result.then(function () {}, function () {});
  return result;
}

function getZipRunState() {
  return new Promise(function (resolve) {
    chrome.storage.session.get([ZIP_RUN_KEY], function (result) { resolve((result && result[ZIP_RUN_KEY]) || null); });
  });
}
function setZipRunState(state) {
  var data = {};
  data[ZIP_RUN_KEY] = state;
  return new Promise(function (resolve) { chrome.storage.session.set(data, resolve); });
}

// runId -> AbortController; runId -> { manifestFiles: [{name,data:Uint8Array}], fetchedBytes: {itemId: Uint8Array} }
// Both in-memory only — see the KNOWN LIMITATION note above.
var zipAbortControllers = Object.create(null);
var zipRunContexts = Object.create(null);

function zipCounts(items) {
  var c = { total: items.length, pending: 0, fetching: 0, fetched: 0, failed: 0 };
  items.forEach(function (it) { c[it.status] = (c[it.status] || 0) + 1; });
  return c;
}

/** Fetches one asset's raw bytes. Never throws for an ordinary failure
 * (bad status, network error) — those come back as {ok:false, error},
 * which the caller records on that one item WITHOUT aborting the rest of
 * the run (spec: "missing/failed images must not abort the whole ZIP").
 * A genuine cancellation (AbortError) is deliberately re-thrown so the
 * caller can tell "this item failed" apart from "the whole run was
 * cancelled while this item was in flight". */
async function fetchAssetBytes(url, signal) {
  var res;
  try {
    res = await fetch(url, { signal: signal, credentials: 'omit' });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
  try {
    var buf = await res.arrayBuffer();
    return { ok: true, bytes: new Uint8Array(buf) };
  } catch (e) {
    return { ok: false, error: 'Could not read the response body.' };
  }
}

/** Runs `worker` over `items` with at most `concurrency` in flight at
 * once — same shape as V1.5's chrome.downloads concurrency limiter, just
 * driving fetch() calls instead of chrome.downloads.download() calls.
 *
 * `item` is passed as a genuine function PARAMETER to runOne(), not
 * closed over from a `var` shared across loop iterations — the while
 * loop below runs several iterations synchronously (up to `concurrency`
 * of them) before any of their `.then()` callbacks actually execute
 * (those are always deferred to a later microtask), so a `var item`
 * captured directly inside the loop body would have already been
 * reassigned to the LAST iteration's value by the time earlier
 * callbacks finally ran — every concurrent worker in that batch would
 * silently process the same final item instead of its own, permanently
 * skipping the others. Caught by this version's own 60-item test. */
function runWithConcurrency(items, concurrency, worker) {
  return new Promise(function (resolve) {
    if (!items.length) { resolve(); return; }
    var idx = 0, active = 0;
    function runOne(item) {
      active++;
      Promise.resolve().then(function () { return worker(item); }).catch(function () {}).then(function () {
        active--;
        if (idx >= items.length && active === 0) resolve();
        else launch();
      });
    }
    function launch() {
      while (active < concurrency && idx < items.length) {
        runOne(items[idx++]);
      }
    }
    launch();
  });
}

/** Builds the final ZIP from whatever manifest files + successfully-
 * fetched asset bytes are available right now, and makes the ONE
 * chrome.downloads.download() call for it — regardless of how many
 * individual assets failed (a failed asset simply isn't in the zip; its
 * status stays 'failed' in the run state for the popup to show/offer
 * Retry Failed on, per spec — the zip itself is never blocked on 100%
 * success). */
async function finalizeZip(state, items, ctx) {
  state.status = 'zipping';
  state.updatedAt = Date.now();
  await serializeZipOp(function () { return setZipRunState(state); });

  var files = ctx.manifestFiles.map(function (f) { return { name: f.name, data: f.data }; });
  items.forEach(function (it) {
    if (it.status === 'fetched' && ctx.fetchedBytes[it.id]) files.push({ name: it.filename, data: ctx.fetchedBytes[it.id] });
  });

  var zipBytes;
  try {
    zipBytes = WSZip.buildZip(files);
  } catch (e) {
    state.status = 'error';
    state.error = 'Could not build the ZIP archive: ' + String((e && e.message) || e);
    state.updatedAt = Date.now();
    await serializeZipOp(function () { return setZipRunState(state); });
    return;
  }

  var dataUrl = 'data:application/zip;base64,' + WSZip.bytesToBase64(zipBytes);
  var relativeFilename = (state.folderName ? state.folderName + '/' : '') + state.zipFilename;

  try {
    var downloadId = await new Promise(function (resolve, reject) {
      chrome.downloads.download({ url: dataUrl, filename: relativeFilename, conflictAction: 'uniquify', saveAs: false }, function (id) {
        if (chrome.runtime.lastError || id === undefined) {
          reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Could not save the ZIP file.'));
        } else {
          resolve(id);
        }
      });
    });
    state.status = 'completed';
    state.downloadId = downloadId;
    state.error = null;
  } catch (e) {
    state.status = 'error';
    state.error = String((e && e.message) || e);
  }
  state.updatedAt = Date.now();
  await serializeZipOp(function () { return setZipRunState(state); });
}

/** Called once a fetch phase (initial run OR a retry) finishes without
 * being cancelled. A 'research' run's manifest depends on the FINAL
 * per-item fetch outcome (Asset Status), which the popup — not this file
 * — knows how to compute (utils/research.js is popup-only, see its own
 * header comment); this file only ever gets already-finished manifest
 * BYTES handed to it. So a research run pauses at 'awaiting-manifest'
 * and waits for the popup's PROVIDE_RESEARCH_MANIFEST reply instead of
 * finalizing immediately — every other kind ('images'/'files', which
 * never has a manifest at all) finalizes right away. */
async function afterFetchPhase(state, items, ctx) {
  if (state.kind === 'research') {
    state.status = 'awaiting-manifest';
    state.updatedAt = Date.now();
    await serializeZipOp(function () { return setZipRunState(state); });
    return;
  }
  await finalizeZip(state, items, ctx);
}

/** The full pipeline for a brand new zip run: check permission, fetch
 * every queued item, then finalize. `payload` (see popup.js's
 * buildZipRunPayload): { runId, kind: 'images'|'files'|'research',
 * zipFilename, folderName, items: [{id,url,filename}], manifestFiles:
 * [{name, dataB64}], concurrency, originPatterns }. */
async function runZipBundle(payload) {
  var runId = payload.runId;
  var items = payload.items.map(function (it) { return { id: it.id, url: it.url, filename: it.filename, status: 'pending', error: null }; });
  var state = {
    runId: runId, kind: payload.kind, status: 'fetching',
    folderName: payload.folderName, zipFilename: payload.zipFilename,
    items: items, counts: zipCounts(items), error: null,
    createdAt: Date.now(), updatedAt: Date.now()
  };
  await serializeZipOp(function () { return setZipRunState(state); });

  var ctx = {
    manifestFiles: (payload.manifestFiles || []).map(function (f) { return { name: f.name, data: WSZip.base64ToBytes(f.dataB64) }; }),
    fetchedBytes: Object.create(null)
  };
  zipRunContexts[runId] = ctx;

  if (payload.originPatterns && payload.originPatterns.length) {
    var hasPermission = await new Promise(function (resolve) { chrome.permissions.contains({ origins: payload.originPatterns }, resolve); });
    if (!hasPermission) {
      state.status = 'error';
      state.error = 'Site permission not granted — try again and accept the permission prompt to download these assets.';
      state.updatedAt = Date.now();
      await serializeZipOp(function () { return setZipRunState(state); });
      return;
    }
  }

  var controller = new AbortController();
  zipAbortControllers[runId] = controller;
  try {
    await runWithConcurrency(items, payload.concurrency || 4, function (item) { return fetchOneZipItem(item, controller, state, ctx); });
  } finally {
    delete zipAbortControllers[runId];
  }

  if (controller.signal.aborted) {
    state.status = 'cancelled';
    state.updatedAt = Date.now();
    await serializeZipOp(function () { return setZipRunState(state); });
    return;
  }

  await afterFetchPhase(state, items, ctx);
}

async function fetchOneZipItem(item, controller, state, ctx) {
  if (controller.signal.aborted) return;
  item.status = 'fetching';
  var res;
  try {
    res = await fetchAssetBytes(item.url, controller.signal);
  } catch (e) {
    return; // AbortError — the run-level cancelled check above handles this item (still 'fetching'/'pending', never counted as failed)
  }
  if (res.ok) {
    item.status = 'fetched';
    ctx.fetchedBytes[item.id] = res.bytes;
  } else {
    item.status = 'failed';
    item.error = res.error;
  }
  state.counts = zipCounts(state.items);
  state.updatedAt = Date.now();
  await serializeZipOp(function () { return setZipRunState(state); });
}

/** Re-fetches ONLY the items still marked 'failed' in the current run
 * state, reusing the SAME item ids/filenames (spec #16/#8 — Dataset
 * IDs/filenames never change on a retry) and the manifest files + already
 * -fetched bytes cached in zipRunContexts from the original run, then
 * rebuilds and re-downloads ONE fresh zip containing everything that has
 * succeeded so far (original successes + this retry's). */
async function retryFailedZipItems(message) {
  var runId = message.runId;
  var state = await getZipRunState();
  if (!state || state.runId !== runId) return;
  var ctx = zipRunContexts[runId];
  if (!ctx) {
    state.status = 'error';
    state.error = 'This run can no longer be retried (the extension was reloaded or restarted) — please start a new bundle.';
    state.updatedAt = Date.now();
    await serializeZipOp(function () { return setZipRunState(state); });
    return;
  }

  var failedItems = state.items.filter(function (it) { return it.status === 'failed'; });
  if (!failedItems.length) return;

  failedItems.forEach(function (it) { it.status = 'pending'; it.error = null; });
  state.status = 'fetching';
  state.counts = zipCounts(state.items);
  state.updatedAt = Date.now();
  await serializeZipOp(function () { return setZipRunState(state); });

  var controller = new AbortController();
  zipAbortControllers[runId] = controller;
  try {
    await runWithConcurrency(failedItems, message.concurrency || 4, function (item) { return fetchOneZipItem(item, controller, state, ctx); });
  } finally {
    delete zipAbortControllers[runId];
  }

  if (controller.signal.aborted) {
    state.status = 'cancelled';
    state.updatedAt = Date.now();
    await serializeZipOp(function () { return setZipRunState(state); });
    return;
  }

  await afterFetchPhase(state, state.items, ctx);
}

/** Resumes a 'research' run that's parked at 'awaiting-manifest' — the
 * popup computed manifest.csv/xlsx/json + dataset-info.json from the
 * run's final per-item statuses (utils/research.js's job, popup-only)
 * and handed the finished bytes back here. Silently ignored if the run
 * has moved on (wrong runId, or no longer actually awaiting one) —
 * defensive against a stale/duplicate message, never a hard error. */
async function provideResearchManifest(message) {
  var runId = message.runId;
  var state = await getZipRunState();
  if (!state || state.runId !== runId || state.status !== 'awaiting-manifest') return;
  var ctx = zipRunContexts[runId];
  if (!ctx) return;
  ctx.manifestFiles = (message.manifestFiles || []).map(function (f) { return { name: f.name, data: WSZip.base64ToBytes(f.dataB64) }; });
  await finalizeZip(state, state.items, ctx);
}

// =====================================================================
// V1.18 Deep Scraping: follows a link column from an already-scraped
// list page out to each linked detail page, extracts a small set of
// user-configured fields from each, and merges the result back by URL.
// One additional link depth ONLY (spec #19 — deliberately no recursive
// crawler): every URL here comes from data the list scrape already
// produced, nothing is ever discovered by following links found ON a
// detail page itself.
//
// ARCHITECTURE — two network round-trips per URL, deliberately:
//   1. fetch() validates the URL first: real HTTP status code, content-
//      type, and the final URL after redirects (spec #30/#31) — none of
//      which chrome.tabs/chrome.webNavigation expose without extra
//      permissions this project doesn't otherwise need. The response
//      BODY is never read here (cancelled immediately) — this step is
//      pure validation, not extraction.
//   2. ONLY on a validated success, a real (inactive) background tab
//      loads the page and content/content.js's RUN_DETAIL_EXTRACTION
//      runs the ACTUAL extraction — reusing content/scraper.js's
//      WSScraper.runDetailExtraction + every existing WSSelector
//      primitive completely unchanged (spec #2/#3: "reuse V1.17
//      selector/extraction architecture, do not create a separate
//      engine"). This is the exact same tab-lifecycle pattern V1.8
//      Monitoring already uses (chrome.tabs.create inactive ->
//      waitForTabComplete -> executeScript CONTENT_FILES -> message ->
//      chrome.tabs.remove) — chosen deliberately over a fetch()+DOMParser
//      pipeline because (a) DOMParser is not reliably available in an
//      MV3 extension service worker, and (b) a raw fetch() only ever
//      sees a page's INITIAL server-rendered HTML — many real detail
//      pages render their actual content via JavaScript, which only a
//      real tab load can see, matching how Preview/Auto Detect already
//      work on any page.
//
// Concurrency (spec #8: "queue -> worker pool -> fetch -> parse ->
// extract -> merge") reuses runWithConcurrency VERBATIM — the exact same
// generic limiter the V1.13.2 ZIP pipeline already uses, proven and
// already covered by its own regression test.
// =====================================================================

var DEEP_SCRAPE_RUN_KEY = 'ws_deepscrape_run';
var DEEP_SCRAPE_MAX_ATTEMPTS = 3; // spec #10: limited retries, never infinite — the DEFAULT; V1.20 makes this configurable per-run (state.maxAttempts), see runDeepScrape
var DEEP_SCRAPE_AUTO_DELAY_MS = 400; // spec #9's "Auto / Safe Default" pacing between dispatches from one worker slot — conservative, never hammers a site
var DEEP_SCRAPE_FETCH_TIMEOUT_MS = 15000;
var DEEP_SCRAPE_TAB_TIMEOUT_MS = 20000;
var DEEP_SCRAPE_RETRY_BACKOFF_MAX_MS = 30000; // V1.20: exponential backoff between per-URL retry attempts never waits longer than this
// javascript:/data:/chrome:/chrome-extension:/edge:/about:/file: — spec #5's
// explicit "reject dangerous or unsupported schemes" list plus the
// obvious same-family internal-page schemes.
var DEEP_SCRAPE_REJECTED_SCHEME_RE = /^(javascript|data|chrome|chrome-extension|edge|about|file|blob):/i;

var deepScrapeOpQueue = Promise.resolve();
function serializeDeepScrapeOp(fn) {
  var result = deepScrapeOpQueue.then(fn, fn);
  deepScrapeOpQueue = result.then(function () {}, function () {});
  return result;
}

function getDeepScrapeState() {
  return new Promise(function (resolve) {
    chrome.storage.session.get([DEEP_SCRAPE_RUN_KEY], function (result) { resolve((result && result[DEEP_SCRAPE_RUN_KEY]) || null); });
  });
}
function setDeepScrapeState(state) {
  var data = {};
  data[DEEP_SCRAPE_RUN_KEY] = state;
  return new Promise(function (resolve) { chrome.storage.session.set(data, resolve); });
}

// runId -> AbortController, in-memory only (same documented MV3-
// service-worker-suspension limitation as the ZIP pipeline's own
// zipAbortControllers — a run survives a popup close/reopen fine, but
// not the service worker itself being killed and restarted mid-run).
var deepScrapeAbortControllers = Object.create(null);

function deepScrapeCounts(results) {
  var c = { total: 0, pending: 0, fetching: 0, completed: 0, partial: 0, failed: 0, skipped: 0 };
  Object.keys(results).forEach(function (url) {
    c.total++;
    var st = results[url].status;
    c[st] = (c[st] || 0) + 1;
  });
  return c;
}

/** Promise-based delay that resolves early (rejecting with an AbortError,
 * same shape a real fetch() abort throws) the moment `signal` aborts —
 * used for both retry backoff and the pacing delay between dispatches,
 * so Stop takes effect immediately instead of waiting out a pending
 * delay first. */
function deepScrapeDelay(ms, signal) {
  return new Promise(function (resolve, reject) {
    if (signal && signal.aborted) { reject(makeAbortError()); return; }
    var t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', function onAbort() {
        clearTimeout(t);
        signal.removeEventListener('abort', onAbort);
        reject(makeAbortError());
      });
    }
  });
}
function makeAbortError() {
  var e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

/** fetch() with an independent per-request timeout layered on top of the
 * run-level cancellation signal, without depending on AbortSignal.any()
 * (not assumed available). */
function deepScrapeFetch(url, opts, timeoutMs, parentSignal) {
  var controller = new AbortController();
  function onParentAbort() { controller.abort(); }
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', onParentAbort);
  }
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  return fetch(url, Object.assign({}, opts, { signal: controller.signal })).then(
    function (res) { clearTimeout(timer); if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort); return res; },
    function (err) { clearTimeout(timer); if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort); throw err; }
  );
}

/** spec #30/#31: classifies an HTTP status into a short, honest failure
 * reason and whether it's worth retrying — 404/403 are permanent (retrying
 * won't fix a page that doesn't exist or is blocking us), 429/5xx are
 * transient (spec #9/#10 — a server hiccup or rate limit can clear up a
 * few seconds later). */
function classifyHttpFailure(status) {
  if (status === 404) return { reason: 'HTTP 404', retryable: false };
  if (status === 403) return { reason: 'blocked/permission (HTTP 403)', retryable: false };
  if (status === 429) return { reason: 'HTTP 429 (rate limited)', retryable: true };
  if (status >= 500) return { reason: 'HTTP ' + status, retryable: true };
  return { reason: 'HTTP ' + status, retryable: false };
}

/** Step 1 of 2 (see this section's header comment): validates a detail
 * URL via a lightweight fetch — real HTTP status, content-type (must
 * look like HTML — spec #30's "do not attempt DOM extraction from binary
 * files"), and the final URL after any redirects (spec #31), all WITHOUT
 * ever reading/parsing the response body (cancelled immediately either
 * way — this step is pure validation). */
async function validateDetailUrl(url, signal) {
  var res;
  try {
    res = await deepScrapeFetch(url, { method: 'GET', credentials: 'omit', redirect: 'follow' }, DEEP_SCRAPE_FETCH_TIMEOUT_MS, signal);
  } catch (e) {
    if (e && e.name === 'AbortError' && signal && signal.aborted) throw e; // real run cancellation — propagate, never counted as a page failure
    return { ok: false, retryable: true, error: 'Network error or timeout.', httpStatus: null };
  }
  try { if (res.body && res.body.cancel) res.body.cancel(); } catch (e) { /* ignore — best-effort cleanup only */ }
  if (!res.ok) {
    var cls = classifyHttpFailure(res.status);
    return { ok: false, retryable: cls.retryable, error: cls.reason, httpStatus: res.status };
  }
  var contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType && contentType.indexOf('html') === -1 && contentType.indexOf('xml') === -1) {
    return { ok: false, retryable: false, error: 'Non-HTML response (' + (contentType.split(';')[0] || 'unknown type') + ').', httpStatus: res.status };
  }
  return { ok: true, httpStatus: res.status, finalUrl: res.url || url };
}

/** Step 2 of 2: the real extraction, via the exact V1.8-Monitoring-style
 * tab lifecycle. Returns {ok:true, fields} on a normal response (even if
 * every field came back empty — that's a 'partial' page-status decision
 * for the CALLER to make, see fetchOneDetailPage, never this function's
 * job) or {ok:false, retryable, error}. */
async function extractDetailFields(url, fields, signal) {
  if (signal && signal.aborted) throw makeAbortError();
  var tabId = null;
  try {
    var tab = await new Promise(function (resolve, reject) {
      chrome.tabs.create({ url: url, active: false }, function (t) {
        if (chrome.runtime.lastError || !t) reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Could not open a background tab.'));
        else resolve(t);
      });
    });
    tabId = tab.id;
    await waitForTabComplete(tabId, DEEP_SCRAPE_TAB_TIMEOUT_MS);
    if (signal && signal.aborted) throw makeAbortError();
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: CONTENT_FILES });
    var res = await sendMessageToTab(tabId, { type: 'RUN_DETAIL_EXTRACTION', fields: fields });
    if (!res || !res.ok) return { ok: false, retryable: true, error: res && res.error ? res.error : 'Extraction failed (content script did not respond).' };
    return { ok: true, fields: res.row || {} };
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    return { ok: false, retryable: true, error: String((e && e.message) || e) };
  } finally {
    if (tabId !== null) { try { await new Promise(function (resolve) { chrome.tabs.remove(tabId, resolve); }); } catch (e2) { /* tab may already be gone */ } }
  }
}

/** One URL's full attempt sequence: validate -> extract, with up to
 * DEEP_SCRAPE_MAX_ATTEMPTS tries and increasing backoff, but ONLY for
 * transient failures (spec #10: "attempt 1, wait, attempt 2, wait
 * longer, attempt 3, fail" — never an infinite loop, and a permanent
 * failure like 404 never wastes retries). Distinguishes 'completed'
 * (extraction ran and produced at least one real value) from 'partial'
 * (the page loaded fine but every configured field came back empty —
 * spec #11/#16: a real, distinct signal from "couldn't reach the page
 * at all") from 'failed' (never got a usable response after every
 * retry). */
async function fetchOneDetailPage(url, fields, controller, state) {
  if (controller.signal.aborted) return;
  var record = state.results[url];
  record.status = 'fetching';
  state.counts = deepScrapeCounts(state.results);
  state.updatedAt = Date.now();
  await serializeDeepScrapeOp(function () { return setDeepScrapeState(state); });

  var maxAttempts = state.maxAttempts || DEEP_SCRAPE_MAX_ATTEMPTS; // V1.20: configurable per run (deepScrapeConfig.retryLimit), defaults unchanged
  var attempt = 0, lastError = null, lastHttpStatus = null;
  while (attempt < maxAttempts) {
    attempt++;
    if (controller.signal.aborted) return;
    var validation = await validateDetailUrl(url, controller.signal);
    if (validation.ok) {
      var extraction = await extractDetailFields(validation.finalUrl, fields, controller.signal);
      if (extraction.ok) {
        var hasAnyValue = Object.keys(extraction.fields).some(function (k) {
          var v = extraction.fields[k];
          return Array.isArray(v) ? v.length > 0 : !!v;
        });
        record.status = hasAnyValue ? 'completed' : 'partial';
        record.fields = extraction.fields;
        record.finalUrl = validation.finalUrl;
        record.httpStatus = validation.httpStatus;
        record.error = null;
        lastError = null;
        break;
      }
      lastError = extraction.error;
      lastHttpStatus = validation.httpStatus;
      if (!extraction.retryable) break;
    } else {
      lastError = validation.error;
      lastHttpStatus = validation.httpStatus;
      if (!validation.retryable) break;
    }
    if (attempt < maxAttempts) {
      // V1.20: exponential backoff (1s, 2s, 4s, ... capped) instead of
      // V1.18's linear attempt*1000 — a real transient hiccup gets
      // progressively more room to clear, and a higher configured retry
      // limit no longer turns into a tight, site-hammering loop.
      var backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), DEEP_SCRAPE_RETRY_BACKOFF_MAX_MS);
      // V1.20: user-visible retry status (spec: "user-visible error/retry
      // status instead of silent failure") — purely informational, never
      // read by any control-flow decision.
      record.retryStatus = 'Retrying (' + attempt + ' of ' + maxAttempts + ')…';
      state.updatedAt = Date.now();
      await serializeDeepScrapeOp(function () { return setDeepScrapeState(state); });
      try { await deepScrapeDelay(backoffMs, controller.signal); } catch (e) { return; } // cancelled mid-backoff
    }
  }
  record.retryStatus = null;
  if (lastError !== null) {
    record.status = 'failed';
    record.error = lastError;
    record.httpStatus = lastHttpStatus;
  }
  state.currentUrl = null;
  state.counts = deepScrapeCounts(state.results);
  state.updatedAt = Date.now();
  await serializeDeepScrapeOp(function () { return setDeepScrapeState(state); });

  // Spec #9's pacing: a small stagger after EVERY page (success or
  // failure) before this worker slot picks up its next URL — applied
  // here (once per completed unit of work) rather than globally, so it
  // scales naturally with concurrency instead of serializing everything.
  if (!controller.signal.aborted) {
    var delayMs = state.delayMode === 'custom' && typeof state.customDelayMs === 'number' ? state.customDelayMs : DEEP_SCRAPE_AUTO_DELAY_MS;
    if (delayMs > 0) { try { await deepScrapeDelay(delayMs, controller.signal); } catch (e) { /* cancelled — fine, we're done anyway */ } }
  }
}

/** The full pipeline for a brand-new (or re-armed) Deep Scrape run.
 * `payload`: { runId, urls: [uniqueAbsoluteUrl,...], fields: [...],
 * concurrency, delayMode, customDelayMs, originPatterns }. Permission is
 * only ever CHECKED here (chrome.permissions.contains) — REQUESTING it
 * happens in popup.js at the real user gesture (Start Deep Scrape click),
 * the exact same division of responsibility the ZIP pipeline already
 * uses for the same reason (a service worker has no user-gesture
 * context to request permissions from). */
async function runDeepScrape(payload) {
  var runId = payload.runId;
  var results = Object.create(null);
  // Defense in depth (spec #5) — popup.js already filters via
  // WSDownloads.validateDownloadUrl (http/https only) before ever
  // building this list, but background.js never trusts a caller-supplied
  // URL list blindly either; anything matching a rejected scheme is
  // recorded 'skipped' (never silently dropped — spec #5/#9's "do not
  // silently fail") and never reaches fetch()/a real tab at all.
  var acceptedUrls = [];
  (payload.urls || []).forEach(function (url) {
    if (DEEP_SCRAPE_REJECTED_SCHEME_RE.test(url)) {
      results[url] = { status: 'skipped', fields: null, error: 'Unsupported or unsafe URL scheme.', httpStatus: null, finalUrl: null, retryStatus: null };
    } else {
      results[url] = { status: 'pending', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null };
      acceptedUrls.push(url);
    }
  });
  var state = {
    runId: runId, status: 'running',
    fields: payload.fields || [], results: results, counts: deepScrapeCounts(results),
    delayMode: payload.delayMode || 'auto', customDelayMs: payload.customDelayMs || null,
    // V1.20 additive — persisted so a later Retry Failed Items op can
    // reuse the exact same worker-pool size and retry limit without
    // needing any in-memory-only context (unlike the ZIP pipeline's
    // zipRunContexts, Deep Scrape's state is fully JSON-serializable —
    // nothing about it depends on the service worker staying alive
    // between the original run and a later retry).
    concurrency: payload.concurrency || 4, maxAttempts: payload.retryLimit || DEEP_SCRAPE_MAX_ATTEMPTS,
    currentUrl: null, error: null,
    startedAt: Date.now(), updatedAt: Date.now(), finishedAt: null
  };
  await serializeDeepScrapeOp(function () { return setDeepScrapeState(state); });

  if (payload.originPatterns && payload.originPatterns.length) {
    var hasPermission = await new Promise(function (resolve) { chrome.permissions.contains({ origins: payload.originPatterns }, resolve); });
    if (!hasPermission) {
      state.status = 'error';
      state.error = 'Site permission not granted — try again and accept the permission prompt to visit these detail pages.';
      state.finishedAt = Date.now();
      state.updatedAt = Date.now();
      await serializeDeepScrapeOp(function () { return setDeepScrapeState(state); });
      return;
    }
  }

  var controller = new AbortController();
  deepScrapeAbortControllers[runId] = controller;
  await runDeepScrapeUrls(state, acceptedUrls, controller);
}

/** V1.20: the shared "run this list of URLs through fetchOneDetailPage
 * with the run's own concurrency, then finalize the run state" tail —
 * factored out of runDeepScrape so retryFailedDeepScrapeItems (below)
 * can reuse it exactly rather than duplicating the finalize/status logic
 * (spec: "reuse current infrastructure rather than creating duplicate
 * systems"). `urls` may be the FULL accepted list (a fresh run) or just
 * the subset currently 'failed' (a retry) — either way this is the only
 * place state.status transitions to its terminal value. */
async function runDeepScrapeUrls(state, urls, controller) {
  try {
    await runWithConcurrency(urls, state.concurrency || 4, function (url) {
      state.currentUrl = url;
      return fetchOneDetailPage(url, state.fields, controller, state);
    });
  } finally {
    delete deepScrapeAbortControllers[state.runId];
  }

  state.currentUrl = null;
  state.status = controller.signal.aborted ? 'stopped' : 'completed';
  state.finishedAt = Date.now();
  state.updatedAt = Date.now();
  await serializeDeepScrapeOp(function () { return setDeepScrapeState(state); });
}

/** V1.20 — spec: "Retry failed pages/steps without restarting the entire
 * scrape". Mirrors retryFailedZipItems' exact shape: resets only the
 * 'failed' URLs back to 'pending' and re-runs JUST those through the
 * same fetch-validate-extract pipeline, leaving every already-completed/
 * partial/skipped result untouched — never re-fetches a URL that
 * already succeeded, never restarts the whole operation. Since Deep
 * Scrape's URL->result map is keyed by URL (not appended to), retrying
 * can never produce a duplicate row/result entry — the SAME key is just
 * overwritten with a fresh outcome. Does NOT charge an additional trial
 * credit: popup.js's charge gate is keyed by runId and fires only once
 * per runId ever (see maybeChargeForCompletedRun/deepScrapeChargedRunIds
 * — a retry reuses the SAME runId, so it's a no-op there by
 * construction, never a new run for trial-accounting purposes). */
async function retryFailedDeepScrapeItems(message) {
  var runId = message.runId;
  var state = await getDeepScrapeState();
  if (!state || state.runId !== runId) return;
  if (['running', 'preparing'].indexOf(state.status) !== -1) return; // already active — nothing to retry yet

  var failedUrls = Object.keys(state.results).filter(function (url) { return state.results[url].status === 'failed'; });
  if (!failedUrls.length) return;

  failedUrls.forEach(function (url) {
    state.results[url] = { status: 'pending', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null };
  });
  state.status = 'running';
  state.error = null;
  state.finishedAt = null;
  state.counts = deepScrapeCounts(state.results);
  state.updatedAt = Date.now();
  await serializeDeepScrapeOp(function () { return setDeepScrapeState(state); });

  var controller = new AbortController();
  deepScrapeAbortControllers[runId] = controller;
  await runDeepScrapeUrls(state, failedUrls, controller);
}

/** spec #4/#20: the popup's "Test Detail Fields" sample preview — runs
 * the exact SAME validate-then-extract pipeline a real run uses (no
 * separate code path to keep in sync), just without retries/session-
 * state tracking/pacing, since this is a quick, small (<=3 URL),
 * synchronous-feeling check the popup awaits directly rather than a
 * tracked background run. */
async function testDeepScrapeSample(urls, fields) {
  var results = Object.create(null);
  await runWithConcurrency(urls, 3, async function (url) {
    var validation = await validateDetailUrl(url, null);
    if (!validation.ok) { results[url] = { status: 'failed', error: validation.error }; return; }
    var extraction = await extractDetailFields(validation.finalUrl, fields, null);
    if (!extraction.ok) { results[url] = { status: 'failed', error: extraction.error }; return; }
    var hasAny = Object.keys(extraction.fields).some(function (k) {
      var v = extraction.fields[k];
      return Array.isArray(v) ? v.length > 0 : !!v;
    });
    results[url] = { status: hasAny ? 'completed' : 'partial', fields: extraction.fields, finalUrl: validation.finalUrl };
  });
  return results;
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) return;

  if (message.type === 'TEST_DEEP_SCRAPE_SAMPLE') {
    testDeepScrapeSample(message.urls || [], message.fields || []).then(function (results) {
      sendResponse({ ok: true, results: results });
    }).catch(function (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    });
    return true;
  }

  if (message.type === 'START_DEEP_SCRAPE') {
    runDeepScrape(message).catch(function (e) {
      console.error('[Web Scraper] deep scrape error:', e);
    });
    sendResponse({ ok: true, started: true });
    return true;
  }

  if (message.type === 'STOP_DEEP_SCRAPE') {
    var dsController = deepScrapeAbortControllers[message.runId];
    if (dsController) dsController.abort();
    sendResponse({ ok: true });
    return true;
  }

  // V1.20 — spec #10: retry only the failed detail pages of a completed/
  // stopped/errored run, without restarting the whole operation.
  if (message.type === 'RETRY_FAILED_DEEP_SCRAPE_ITEMS') {
    retryFailedDeepScrapeItems(message).catch(function (e) {
      console.error('[Web Scraper] deep scrape retry error:', e);
    });
    sendResponse({ ok: true, started: true });
    return true;
  }

  if (message.type === 'GET_DEEP_SCRAPE_STATE') {
    getDeepScrapeState().then(function (state) { sendResponse({ ok: true, runState: state }); });
    return true;
  }
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) return;

  if (message.type === 'START_ZIP_RUN') {
    runZipBundle(message).catch(function (e) {
      console.error('[Web Scraper] zip run error:', e);
    });
    sendResponse({ ok: true, started: true });
    return true;
  }

  if (message.type === 'STOP_ZIP_RUN') {
    var controller = zipAbortControllers[message.runId];
    if (controller) controller.abort();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'RETRY_FAILED_ZIP_ITEMS') {
    retryFailedZipItems(message).catch(function (e) {
      console.error('[Web Scraper] zip retry error:', e);
    });
    sendResponse({ ok: true, started: true });
    return true;
  }

  if (message.type === 'GET_ZIP_RUN_STATE') {
    getZipRunState().then(function (state) { sendResponse({ ok: true, runState: state }); });
    return true;
  }

  if (message.type === 'PROVIDE_RESEARCH_MANIFEST') {
    provideResearchManifest(message).catch(function (e) {
      console.error('[Web Scraper] research manifest finalize error:', e);
    });
    sendResponse({ ok: true });
    return true;
  }
});
