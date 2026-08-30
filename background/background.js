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
  '../utils/healthdiag.js', // SELF-DIAGNOSTICS / HEALTH CHECK mission — shared diagnostic event buffer (see its own header comment); Detail Enrichment pushes its 'detail'-scope events into it below.
  '../utils/zip.js' // V1.13.2 — ZIP container writer + base64 helpers (see the V1.13.2 section below). Manifest BYTES (csv/xlsx/json/dataset-info.json) are still generated in the popup, same as V1.12 — this file only ever receives already-finished {name, dataB64} file descriptors for them, never regenerates manifest content itself.
  // V1.15 note: utils/plan.js (V1.14's Free/Pro feature-gate module) was
  // removed entirely — the new trial/license model (utils/license.js) is
  // popup.js-only. Monitoring is a fully available feature under the new
  // model and NEVER consumes trial credits, so background.js has no
  // reason to load or reference any licensing module at all.
);

// DETAIL ENRICHMENT mission — REAL BUG found and fixed via this
// mission's own real-browser testing: chrome.storage.session defaults to
// TRUSTED_CONTEXTS-only access (popup/background/options) — content
// scripts are NOT granted access unless the background service worker
// explicitly calls setAccessLevel(), exactly the same real-Chrome root
// cause content/livewatch.js's own header comment already documents in
// detail for a DIFFERENT storage key (that one was fixed by moving off
// session storage entirely; this one genuinely needs session storage's
// short-lived, auto-clearing semantics, since it's a transient picker-
// to-popup handoff, not a durable job checkpoint). Without this call, a
// content script's chrome.storage.session.set() for the detail-field
// picker's staging keys (ws_detail_field_picks::<hostname>, and this
// mission's own new ws_live_detail_field_picks::<hostname>) silently
// no-ops — no thrown error, no rejected promise, just an empty read
// back later — which is exactly what real-browser testing observed:
// the "Pick Fields on Sample Page" workflow's staged field never
// actually reached storage at all. This single call, made once here
// (top-level service-worker script evaluation, so it re-runs every time
// MV3 suspends/wakes this worker — access level is NOT guaranteed to
// persist across a worker restart), fixes BOTH the pre-existing V1.18
// "Deep Scraping" panel's own identical pattern AND this mission's new
// DETAY tab — the exact same underlying bug, never previously caught
// because neither path had ever been exercised by a real-browser test
// before this mission's own detail-enrichment-real-flow.test.js.
try {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
} catch (e) { /* best-effort — an older Chrome without this API simply keeps the pre-existing (broken) behavior, never worse */ }

chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') {
    console.log('Web Scraper installed.');
  }
  reconcileMonitoringAlarms();
  // STALL-FIX ROUND 2: onInstalled fires with reason:'update' on a
  // manual "reload extension" (chrome://extensions) too — exactly what
  // the user did while diagnosing this real stall. A manual reload tears
  // down the OLD extension instance's scheduled chrome.alarms along with
  // it, so without this, a run left mid-flight at that exact moment
  // would have no alarm left to ever wake its recovery again. Re-arms
  // (and immediately checks) recovery for any run this fresh instance
  // inherited mid-flight.
  reconcileDeepScrapeWatchdogOnWake();
  // STORAGE ARCHITECTURE FIX: a manual "reload extension" is also
  // exactly the moment this fix's own migration needs to run — see
  // migrateDeepScrapeStorageIfNeeded's own header comment. Runs
  // regardless of the current run's status (a real 'stopped' run is
  // exactly the reported case), independent of reconcileDeepScrapeWatchdogOnWake
  // above (which only acts on 'running'/'stopping').
  migrateDeepScrapeStorageIfNeeded().catch(function (e) {
    console.error('[Web Scraper] Deep Scrape storage migration error:', e && e.message);
  });
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
  reconcileDeepScrapeWatchdogOnWake(); // STALL-FIX ROUND 2 — same reasoning as the onInstalled listener above, for a real browser restart
  migrateDeepScrapeStorageIfNeeded().catch(function (e) { // STORAGE ARCHITECTURE FIX — same reasoning as the onInstalled listener above, for a real browser restart
    console.error('[Web Scraper] Deep Scrape storage migration error:', e && e.message);
  });
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
  'content/livewatch.js',
  'content/nextdetect.js',
  'content/autoscroll.js',
  'content/autopaginate.js',
  'utils/discovery.js',
  'content/loadmore.js',
  'content/discovery.js'
];
// NEW FEATURE — AUTOMATIC PAGINATION (Auto Next, optional, OFF by
// default), content/nextdetect.js + content/autopaginate.js above:
// content/nextdetect.js is pure detection logic (no listener of its
// own); content/autopaginate.js registers its own message listener and
// resume-on-load bootstrap, exactly like pagination.js/livewatch.js.
// Neither is invoked unless a session has an explicit autoPaginate field
// (see popup.js, function handleStartLiveSession) — every existing
// session/run is completely unaffected by these two files simply being
// present in the injected set. (Kept OUTSIDE the array literal above,
// not as an inline comment between entries — scripts/release-check.js's
// own CONTENT_FILES parser is a plain quote-delimited regex over the
// array body, which an inline comment containing an apostrophe would
// otherwise corrupt.)
//
// NEW FEATURE — INFINITE SCROLL (Auto Scroll, optional, OFF by
// default), content/autoscroll.js above: exposes a reusable
// runUntilExhausted() function, called either by that file's own
// standalone message listener (Auto Next off) or directly by
// content/autopaginate.js (both features on — see that file's own
// coexistence comment). Never invoked unless a session has an explicit
// autoScroll field — same complete-no-op guarantee as autoPaginate.

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
  if (!alarm) return;
  // STALL-FIX ROUND 2 — see DEEP_SCRAPE_STALL_ALARM_NAME's own header
  // comment: this is what actually recovers a Detail Enrichment run
  // whose original service-worker instance was terminated mid-record.
  if (alarm.name === DEEP_SCRAPE_STALL_ALARM_NAME) {
    reconcileDeepScrapeJob().catch(function (e) {
      console.error('[Web Scraper] Detail Enrichment stall-watchdog error:', e);
    });
    return;
  }
  if (alarm.name.indexOf('ws_monitor::') !== 0) return;
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
// ARCHITECTURE:
//   1. fetch() validates the URL first: real HTTP status code, content-
//      type, and the final URL after redirects (spec #30/#31) — none of
//      which chrome.tabs/chrome.webNavigation expose without extra
//      permissions this project doesn't otherwise need. The response
//      BODY is never read here (cancelled immediately) — this step is
//      pure validation, not extraction.
//   2. On a validated success — OR, per the HTTP-403-ON-ETSY bug-fix
//      mission, as a FALLBACK whenever that plain fetch() gets a bot-
//      protection-shaped rejection (any non-2xx status that isn't a
//      trustworthy "genuinely missing" 404/non-HTML, or a network-level
//      failure/timeout) — a real (inactive) background tab loads the
//      page and content/content.js's RUN_DETAIL_EXTRACTION runs the
//      ACTUAL extraction, reusing content/scraper.js's
//      WSScraper.runDetailExtraction + every existing WSSelector
//      primitive completely unchanged (spec #2/#3: "reuse V1.17
//      selector/extraction architecture, do not create a separate
//      engine").
//
//      ROOT CAUSE of the reported "125/125 HTTP 403 on Etsy" bug: step
//      1's fetch() is sent with `credentials: 'omit'` (no cookies) and
//      none of a real navigation's own browser fingerprint (Sec-Fetch-*
//      navigation headers, TLS/JS client signals) — Etsy's real
//      PerimeterX/HUMAN anti-bot protection (already independently
//      confirmed present on this exact site by this project's own SITE-
//      level tests) rejects exactly that shape of request with HTTP 403,
//      while the SAME URL loads completely normally in a real browser
//      tab (interactively, or via this project's own step 2 below) —
//      confirmed by proving the request path, not assumed (see
//      MISSION.md's own root-cause record for this mission). Previously,
//      step 1 failing was a hard, non-retryable stop — step 2 (the real
//      tab, which already worked fine) was never even reached. The fix
//      is exactly this fallback: on a blocked/unreliable fetch, still
//      try the real tab before giving up. This is NOT a bypass of any
//      anti-bot protection — it uses the exact same real Chrome
//      chrome.tabs navigation (and therefore the same real user
//      session/cookies) any other real navigation already would; nothing
//      is spoofed, faked, or evaded. If the REAL navigation is ALSO
//      challenged (detected via a DOM-structural check, never a network-
//      level guess), that is honestly classified SITE_CHALLENGE, never
//      silently retried or bypassed.
//
//      Tab lifecycle: chosen deliberately over a fetch()+DOMParser
//      pipeline because (a) DOMParser is not reliably available in an
//      MV3 extension service worker, and (b) a raw fetch() only ever
//      sees a page's INITIAL server-rendered HTML — many real detail
//      pages render their actual content via JavaScript, which only a
//      real tab load can see, matching how Preview/Auto Detect already
//      work on any page. UNLIKE the original V1.8-Monitoring-style
//      "create tab -> ... -> remove tab" pattern this used to copy
//      verbatim, ONE tab per concurrent worker is now OWNED and REUSED
//      across every URL that worker processes for the whole run (see the
//      worker-tab pool below) — never one fresh tab per product. Only
//      that run's own owned tab(s) are ever navigated/closed; the user's
//      own tabs are never touched, matching CLAUDE.md's Browser Process
//      Safety rules extended to this runtime feature.
//
// Concurrency (spec #8: "queue -> worker pool -> fetch -> parse ->
// extract -> merge") reuses runWithConcurrency VERBATIM — the exact same
// generic limiter the V1.13.2 ZIP pipeline already uses, proven and
// already covered by its own regression test. The worker-tab pool below
// creates at most `concurrency` real tabs for an ENTIRE run — popup.js's
// own DETAIL_CONCURRENCY already defaults this new tab's runs to 1 (see
// that file's own comment), so this stays a genuinely low-memory-
// footprint feature (exactly one real tab, reused for every record) by
// construction, with room for a future UI to raise it.
// =====================================================================

var DEEP_SCRAPE_RUN_KEY = 'ws_deepscrape_run';
var DEEP_SCRAPE_MAX_ATTEMPTS = 3; // spec #10: limited retries, never infinite — the DEFAULT; V1.20 makes this configurable per-run (state.maxAttempts), see runDeepScrape
var DEEP_SCRAPE_AUTO_DELAY_MS = 400; // spec #9's "Auto / Safe Default" pacing between dispatches from one worker slot — conservative, never hammers a site
var DEEP_SCRAPE_FETCH_TIMEOUT_MS = 15000;
var DEEP_SCRAPE_TAB_TIMEOUT_MS = 20000;
var DEEP_SCRAPE_RETRY_BACKOFF_MAX_MS = 30000; // V1.20: exponential backoff between per-URL retry attempts never waits longer than this
// STALL-FIX mission (real Etsy: 72/125 completed, then stalled forever
// until the user manually pressed Stop) — real root cause: several real
// chrome.* calls inside the extraction pipeline (chrome.tabs.update,
// chrome.scripting.executeScript, chrome.tabs.sendMessage) have NO
// independent timeout of their own; each one's own callback/promise is
// normally reliable but is a real, documented class of Chrome extension
// flakiness (a tab in a stuck/discarded/bfcache state can leave a
// callback never firing) — when this project's own DEEP_SCRAPE_TAB_
// TIMEOUT_MS-bounded waitForTabComplete isn't the thing that hangs, NONE
// of the other steps had any ceiling at all, so ONE bad record could
// block the entire concurrency-1 job forever (exactly the reported
// symptom). DEEP_SCRAPE_RECORD_TIMEOUT_MS is the master safety net: the
// ENTIRE per-attempt resolution (fetch validation + real navigation +
// extraction, whichever stage it's in) is wrapped in exactly one hard
// timeout, so no single record can ever block the queue longer than
// this, regardless of which specific internal call turns out to be the
// one that hung. Configurable per-run (state.recordTimeoutMs), same
// pattern as maxAttempts/concurrency; 30s is a conservative default for
// a real ecommerce detail page (mission's own explicit example value).
var DEEP_SCRAPE_RECORD_TIMEOUT_MS = 30000;
// Watchdog (defense-in-depth ONLY — the per-record timeout above is the
// actual fix and should make this fire essentially never in practice):
// if the job's own state hasn't advanced at ALL for this long while
// still 'running', something is wrong in a way the per-record timeout
// itself didn't catch (e.g. a bug in the timeout wrapper itself) — the
// watchdog aborts the run rather than ever leaving it silently frozen.
var DEEP_SCRAPE_WATCHDOG_CHECK_MS = 5000;
var DEEP_SCRAPE_WATCHDOG_STALL_MULTIPLIER = 2.5; // stall threshold = recordTimeoutMs * this + a fixed margin below
// =====================================================================
// STALL-FIX mission ROUND 2 — real production finding: the in-process
// per-record timeout above (DEEP_SCRAPE_RECORD_TIMEOUT_MS/withRecordTimeout)
// and its in-process setInterval watchdog are BOTH real fixes for a
// genuine code-level hang, and are directly proven to work by this
// project's own unit tests — but a real manual Etsy retest showed the
// stall recurring anyway, at the same record, with the watchdog counter
// staying at 0 the entire time and STOP having no effect either. Both
// symptoms together have exactly one honest explanation: the extension's
// own MV3 SERVICE WORKER ITSELF was terminated while genuinely awaiting
// a long-pending chrome.tabs.sendMessage response (a well-documented MV3
// limitation — a service worker can be reclaimed by Chrome after a
// period with no fresh extension-API activity, EVEN with a promise still
// technically pending, and even more aggressively under real memory
// pressure like this project's own repeatedly-observed low-RAM
// environment). When that happens, EVERYTHING in-memory for that run —
// the AbortController STOP depends on, the worker-tab pool, and
// (critically) the very `setTimeout`/`setInterval` calls that were
// supposed to catch the stall — is destroyed along with it. A `setTimeout`
// scheduled in a service worker is NOT guaranteed to survive; it simply
// never fires if the worker hosting it is gone. `ws_deepscrape_run` in
// chrome.storage.local is left showing `status:'running'` forever,
// because nothing is left alive to ever transition it — exactly the
// reported "UI remains RUNNING, Timeouts: 0, STOP does nothing" symptom.
//
// FIX: chrome.alarms — the one MV3-documented mechanism that is
// GUARANTEED to wake a terminated service worker back up at a scheduled
// time (that is the entire purpose of the alarms API, unlike timers).
// A periodic alarm checks, on every real wake-up (which happens whether
// or not the run's original in-memory state survived): is a run still
// `status:'running'` with no live AbortController in THIS (possibly
// freshly-restarted) instance, and has it gone unmistakably stale (well
// past the per-record timeout, so a genuinely slow-but-alive record is
// never falsely pre-empted)? If so, the run's own original service-
// worker instance is gone — recover it exactly like a real browser-
// restart interruption (reusing the existing, already-proven
// resumeInterruptedDeepScrapeItems machinery), never leaving it frozen.
// STOP is made resilient the same way: the STOP_DEEP_SCRAPE handler
// persists a `stopRequested` flag to storage UNCONDITIONALLY (not only
// when a live in-memory controller happens to exist) — the alarm-driven
// recovery checks this flag first and honors it (transitions cleanly to
// 'stopped') instead of ever resuming a run the user asked to stop.
//
// A single URL that keeps causing this exact recovery (a genuinely
// pathological page, not just one unlucky SW-timing coincidence) is
// permanently given up on (status: 'skipped', a clear error explaining
// why) after DEEP_SCRAPE_MAX_STALE_RECOVERIES attempts — the mission's
// own explicit requirement: "ONE pathological record must NEVER prevent
// record 74, 75, 76... from being processed."
//
// chrome.alarms' own practical minimum period for a packaged (non-dev)
// extension is ~1 minute — this is a genuinely slower detection path
// than the in-process timeout (which still fires immediately in the
// common case where the service worker DOESN'T die), but it is the one
// path that is actually GUARANTEED to run no matter what, which the
// prior, purely in-process fix was not. Both layers are kept — the fast
// in-process path for the common case, this one as the layer that
// actually closes the gap the real-world retest exposed.
// =====================================================================
var DEEP_SCRAPE_STALL_ALARM_NAME = 'ws_deepscrape_stall_watchdog';
var DEEP_SCRAPE_STALL_ALARM_PERIOD_MINUTES = 1; // chrome.alarms' own practical minimum for a packaged extension
var DEEP_SCRAPE_STALE_RECOVERY_THRESHOLD_MS = 90000; // generous margin over DEEP_SCRAPE_RECORD_TIMEOUT_MS — only ever trusted once a record has been silent far longer than its own configured timeout could explain
var DEEP_SCRAPE_MAX_STALE_RECOVERIES = 2; // a URL that stalls the service worker itself this many times is permanently given up on, never retried forever
// STALL-FIX ROUND 3 — real production finding: round 2's alarm-based
// recovery (still real, still kept — see below) was not enough either.
// The user's own real retest showed the EXACT SAME stall recurring even
// with round 2 active, WITH STOP again having no visible effect. Two
// real, concrete architectural gaps, now both closed:
//   1. Round 2's staleness signal was "no LIVE in-memory controller for
//      this runId" — but this project's own environment has now shown a
//      genuine 7-MINUTE stall on a single chrome.permissions.request()
//      call (observed directly during this mission's own regression
//      testing), meaning "the service worker is merely extremely slow
//      right now" (not dead) can masquerade as "still alive" for far
//      longer than a user will wait, AND the round-2 alarm's own
//      1-minute period may itself be delayed that same way under real
//      severe resource pressure. A LEASE (below) fixes this by making
//      staleness a pure Date.now()-vs-a-persisted-deadline comparison —
//      it does not matter WHY the record hasn't finished, only whether
//      its own self-declared deadline has passed.
//   2. STOP still went through `popup.js -> chrome.runtime.sendMessage
//      -> background handler -> persist flag` — a real message
//      round-trip that, under the SAME real resource pressure, can
//      itself take an unknown amount of time to even reach a handler,
//      let alone complete. The popup's own Stop click now writes
//      `stopRequested`/`status:'stopping'` DIRECTLY to chrome.storage.
//      local from the popup's own context (directlyPersistStopRequested,
//      called from popup.js) — this never depends on the background
//      service worker being responsive AT ALL; storage writes succeed
//      independent of whether the reader/other-writer context is alive.
//      The background's own message-based STOP_DEEP_SCRAPE handling is
//      KEPT as a (now redundant, still harmless) fast path for when the
//      service worker happens to be responsive.
// Reconciliation (reconcileDeepScrapeJob, replacing round 2's narrower
// checkDeepScrapeStallOnWake) is now triggered on EVERY incoming
// extension message (a new, dedicated, response-free onMessage
// listener — never interferes with any other listener's own handling),
// not only the once-a-minute alarm — so simply having the popup open and
// polling (added below) gives fast, real recovery, while the alarm
// remains the guaranteed fallback for when the popup is closed.
var DEEP_SCRAPE_LEASE_GRACE_MS = 15000; // extra margin over recordTimeoutMs before a lease is trusted as expired — gives the in-process hard timeout every reasonable chance to handle it first
var DEEP_SCRAPE_POPUP_POLL_MS = 5000; // how often popup.js polls while a job is running/stopping — see popup.js's own pollDetailJobWhileActive
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

// DETAIL ENRICHMENT mission: moved from chrome.storage.session to
// chrome.storage.local — the ONE change to this run-state persistence
// layer, everything else about the engine below is untouched. Deep
// Scrape/Detail Enrichment jobs can run long (hundreds/thousands of
// detail pages) and the mission's own explicit checkpoint/resume
// requirement ("the first 699 must not be lost") needs this state to
// survive more than just a service-worker restart or a popup close/
// reopen (which chrome.storage.session already handled fine) — it must
// also survive the browser itself closing and reopening, which
// chrome.storage.session, by design, does not. chrome.storage.local is a
// strict durability upgrade here: same get/set shape, same single-run-
// slot semantics, same per-URL incremental write pattern already in
// place — nothing about WHEN or HOW OFTEN state is written changes, only
// WHERE it survives to. ws_detail_field_picks (the separate, short-lived
// element-picker staging key) intentionally stays on session storage —
// that is a transient UI handoff, not a job checkpoint.
function getDeepScrapeState() {
  return new Promise(function (resolve) {
    chrome.storage.local.get([DEEP_SCRAPE_RUN_KEY], function (result) { resolve((result && result[DEEP_SCRAPE_RUN_KEY]) || null); });
  });
}
function setDeepScrapeState(state) {
  var data = {};
  data[DEEP_SCRAPE_RUN_KEY] = state;
  return new Promise(function (resolve) { chrome.storage.local.set(data, resolve); });
}

// =====================================================================
// STORAGE ARCHITECTURE FIX (real production report + real Chrome
// storage audit): ws_deepscrape_run used to hold the actual extracted
// Detail-page field VALUES (results[url].fields) directly, inline, next
// to the job-control bookkeeping (status/lease/diag) — and that control
// bookkeeping is re-persisted via setDeepScrapeState on EVERY lease
// renewal and EVERY diagnostic stage touch (~5x per record, every
// attempt), meaning the ENTIRE accumulated fields payload got
// re-serialized and re-written on every one of those touches, not just
// once per record. Combined with unbounded field values (see content/
// scraper.js's own DETAIL_FIELD_MAX_BYTES fix), a real run reached
// ~9MB, and even a routine ws_license write (a few hundred bytes,
// completely unrelated) could then fail with a genuine
// Resource::kQuotaBytes error simply because the TOTAL was already
// full.
//
// Fix: the actual field VALUES now live in their OWN, separate,
// FIXED-NAME key (ws_deepscrape_fields — never keyed by runId, so it
// can never accumulate across past runs the way a per-run key would;
// see runDeepScrape's own reset of it below) — written ONLY when a
// record actually completes (fetchOneDetailPage), never touched by the
// frequent lease/diag writes. ws_deepscrape_run itself now stays small
// (status/error/failureType/retryStatus/staleRecoveries per record —
// no per-record payload) regardless of how large the real extracted
// data grows, which is exactly what STOP/RESUME/lease reconciliation
// ever actually needs to read (see MISSION.md's own architecture
// diagnosis for the full reasoning). popup.js's mergeDetailResults()
// reads this key once, at terminal state, alongside ws_deepscrape_run —
// see that function's own updated comment.
var DEEP_SCRAPE_FIELDS_KEY = 'ws_deepscrape_fields';

function getDeepScrapeFields() {
  return new Promise(function (resolve) {
    chrome.storage.local.get([DEEP_SCRAPE_FIELDS_KEY], function (result) { resolve((result && result[DEEP_SCRAPE_FIELDS_KEY]) || {}); });
  });
}
/** Explicit quota-error handling (mission requirement 6): unlike
 * setDeepScrapeState above (best-effort, never rejects), this REJECTS
 * on a real chrome.runtime.lastError so callers (persistDetailResultFields
 * below) can distinguish "saved" from "storage genuinely full" and mark
 * the record honestly instead of silently losing track of it — the
 * exact same explicit-rejection pattern license.js's own persist()
 * already established for exactly this class of failure. */
function setDeepScrapeFields(fieldsMap) {
  var data = {};
  data[DEEP_SCRAPE_FIELDS_KEY] = fieldsMap;
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
/** Read-modify-write of the ONE shared fields map for the CURRENT run.
 * Never called from the hot lease/diag path — only once per record, at
 * genuine completion (fetchOneDetailPage's own success branch). */
async function persistDetailResultFields(url, fields) {
  var all = await getDeepScrapeFields();
  all[url] = fields;
  await setDeepScrapeFields(all);
}

// Mirrors content/scraper.js's own DETAIL_FIELD_MAX_BYTES exactly — kept
// in sync manually (this project's established "local copy of a shared
// constant" convention, e.g. utils/runstate.js's IDENTITY_TRACKING_PARAMS).
// Used ONLY by the one-time migration below, to decide which values in
// an OLD-shape (pre-fix) ws_deepscrape_run are proven-oversized and must
// be stripped rather than carried forward.
var DEEP_SCRAPE_FIELD_MAX_BYTES = 20000;
function isOversizedFieldValueBg(v) {
  if (typeof v === 'string') return v.length > DEEP_SCRAPE_FIELD_MAX_BYTES;
  if (Array.isArray(v)) { try { return JSON.stringify(v).length > DEEP_SCRAPE_FIELD_MAX_BYTES; } catch (e) { return false; } }
  return false;
}

/** MIGRATION / RECOVERY (mission requirement 7) — real production
 * report: an existing install's ws_deepscrape_run, created before this
 * fix, can hold up to ~9MB of results[url].fields inline (the OLD
 * architecture) — most of it proven-oversized whole-page HTML from the
 * ':scope' bug (see content/scraper.js's own header comment). This
 * moves every record's fields to the new ws_deepscrape_fields key
 * (never keyed by runId — see that key's own comment), stripping ONLY
 * values that are PROVEN oversized (the exact same size guard now
 * applied at extraction time) — a legitimately small, real value is
 * carried forward untouched, never lost.
 *
 * Idempotent and safe to call on every wake (onInstalled/onStartup):
 * if no record on the current ws_deepscrape_run still carries an inline
 * `fields` property, this is a single cheap read and an immediate
 * no-op — nothing is written.
 *
 * Scope, exactly as required: touches ONLY ws_deepscrape_run (job
 * metadata preserved, only the inline `fields` property removed from
 * each record) and ws_deepscrape_fields (created/updated). Never
 * touches ws_live_session::* (main scrape results), ws_license,
 * ws_settings, ws_templates, or ws_snapshots — this function's own
 * chrome.storage.local calls are exhaustively listed above; there are
 * no others. */
async function migrateDeepScrapeStorageIfNeeded() {
  try {
    var state = await getDeepScrapeState();
    if (!state || !state.results) return; // nothing to migrate
    var needsMigration = Object.keys(state.results).some(function (url) {
      return Object.prototype.hasOwnProperty.call(state.results[url], 'fields');
    });
    if (!needsMigration) return; // already on the new architecture — idempotent no-op

    console.warn('[Web Scraper] Migrating ws_deepscrape_run to the new small-control-state architecture (see MISSION.md) — moving legitimate Detail field values to ws_deepscrape_fields and stripping only proven-oversized values.');
    var fieldsMap = await getDeepScrapeFields(); // start from whatever's already there — never clobber a fresher run's own data
    var movedCount = 0, strippedValueCount = 0;
    Object.keys(state.results).forEach(function (url) {
      var rec = state.results[url];
      if (!Object.prototype.hasOwnProperty.call(rec, 'fields')) return;
      var raw = rec.fields;
      if (raw && typeof raw === 'object') {
        var cleaned = {};
        Object.keys(raw).forEach(function (fieldId) {
          var v = raw[fieldId];
          if (isOversizedFieldValueBg(v)) { strippedValueCount++; return; } // proven-oversized — dropped, never migrated forward
          cleaned[fieldId] = v;
        });
        // Never overwrite a value ws_deepscrape_fields might already
        // have for this exact URL from a run that had already been
        // partially migrated — this migration's own idempotency.
        if (!Object.prototype.hasOwnProperty.call(fieldsMap, url)) fieldsMap[url] = cleaned;
        movedCount++;
      }
      delete rec.fields;
    });
    await setDeepScrapeFields(fieldsMap);
    state.updatedAt = Date.now();
    await setDeepScrapeState(state);
    console.warn('[Web Scraper] Deep Scrape storage migration complete: moved ' + movedCount + ' record(s) to ws_deepscrape_fields, stripped ' + strippedValueCount + ' proven-oversized field value(s). ws_live_session::*, ws_license, ws_settings, ws_templates, and ws_snapshots were not touched.');
  } catch (e) {
    console.error('[Web Scraper] Deep Scrape storage migration failed (non-fatal — will retry on the next reload/restart):', e && e.message);
  }
}

// runId -> AbortController, in-memory only (same documented MV3-
// service-worker-suspension limitation as the ZIP pipeline's own
// zipAbortControllers — a run survives a popup close/reopen fine, but
// not the service worker itself being killed and restarted mid-run).
var deepScrapeAbortControllers = Object.create(null);

function deepScrapeCounts(results) {
  var c = { total: 0, pending: 0, fetching: 0, completed: 0, partial: 0, failed: 0, skipped: 0, timeouts: 0 };
  Object.keys(results).forEach(function (url) {
    c.total++;
    var st = results[url].status;
    c[st] = (c[st] || 0) + 1;
    // STALL-FIX mission — a distinct, honest "Timeouts" tally (mission's
    // own explicit UI example: "Errors: 0 • Timeouts: 1", i.e. shown
    // SEPARATELY from generic errors, not folded in). Purely additive: a
    // timeout is still counted in c.failed exactly as before (nothing
    // that already reads c.failed changes meaning), this is a subset
    // count on top.
    if (st === 'failed' && results[url].failureType === 'TIMEOUT') c.timeouts++;
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

/** spec #30/#31, extended by the HTTP-403-ON-ETSY bug-fix mission:
 * classifies an HTTP status into a short, honest failure reason, whether
 * it's worth retrying THE FETCH ITSELF, and one of the mission's own
 * explicit failure-mode categories. 404 (and a non-HTML content-type,
 * tagged separately below) is the one MISSING case — a real, trustworthy
 * "this page genuinely doesn't exist" signal no browser navigation would
 * change, so it is never worth the cost of a real tab. Every OTHER non-
 * 2xx status (401/403/429/5xx/etc.) is tagged HTTP_BLOCKED — not
 * necessarily permanent, but exactly the shape of failure a plain,
 * credential-less fetch() can get from a site's own bot-protection while
 * a real browser navigation would not (see this section's header comment
 * for the concrete, confirmed Etsy/PerimeterX case) — resolveDetailPage
 * below falls back to a real navigation for every HTTP_BLOCKED case. */
function classifyHttpFailure(status) {
  if (status === 404) return { reason: 'HTTP 404 (page not found)', retryable: false, failureType: 'MISSING' };
  if (status === 403) return { reason: 'blocked/permission (HTTP 403)', retryable: false, failureType: 'HTTP_BLOCKED' };
  if (status === 429) return { reason: 'HTTP 429 (rate limited)', retryable: true, failureType: 'HTTP_BLOCKED' };
  if (status >= 500) return { reason: 'HTTP ' + status, retryable: true, failureType: 'HTTP_BLOCKED' };
  return { reason: 'HTTP ' + status, retryable: false, failureType: 'HTTP_BLOCKED' };
}

/** Fast-path validation: a lightweight fetch — real HTTP status,
 * content-type (must look like HTML — spec #30's "do not attempt DOM
 * extraction from binary files"), and the final URL after any redirects
 * (spec #31), all WITHOUT ever reading/parsing the response body
 * (cancelled immediately either way). A failure here is NOT automatically
 * fatal — see resolveDetailPage, which falls back to a real navigation
 * for anything except a confirmed MISSING result. */
async function validateDetailUrl(url, signal) {
  var res;
  try {
    res = await deepScrapeFetch(url, { method: 'GET', credentials: 'omit', redirect: 'follow' }, DEEP_SCRAPE_FETCH_TIMEOUT_MS, signal);
  } catch (e) {
    if (e && e.name === 'AbortError' && signal && signal.aborted) throw e; // real run cancellation — propagate, never counted as a page failure
    if (e && e.name === 'AbortError') return { ok: false, retryable: true, error: 'Request timed out.', httpStatus: null, failureType: 'TIMEOUT' };
    return { ok: false, retryable: true, error: 'Network error.', httpStatus: null, failureType: 'NAVIGATION_ERROR' };
  }
  try { if (res.body && res.body.cancel) res.body.cancel(); } catch (e) { /* ignore — best-effort cleanup only */ }
  if (!res.ok) {
    var cls = classifyHttpFailure(res.status);
    return { ok: false, retryable: cls.retryable, error: cls.reason, httpStatus: res.status, failureType: cls.failureType };
  }
  var contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType && contentType.indexOf('html') === -1 && contentType.indexOf('xml') === -1) {
    return { ok: false, retryable: false, error: 'Non-HTML response (' + (contentType.split(';')[0] || 'unknown type') + ').', httpStatus: res.status, failureType: 'MISSING' };
  }
  return { ok: true, httpStatus: res.status, finalUrl: res.url || url };
}

// =====================================================================
// WORKER-TAB POOL — HTTP-403-ON-ETSY bug-fix mission, "Do NOT open one
// tab per product. Reuse one controlled worker tab where possible."
//
// One pool per run (keyed by runId), at most `concurrency` real tabs
// ever open at once for that run (default concurrency 1 -> exactly one
// tab total, reused sequentially for every record). A tab is ACQUIRED
// from the pool (or created fresh if the pool has none free — bounded by
// however many concurrent fetchOneDetailPage calls are in flight, i.e.
// state.concurrency, never unbounded) before navigating, and RELEASED
// back (never closed) after each page — closed only once, for every tab
// the run owns, when the run reaches a terminal state (see
// closeAllWorkerTabs, called from runDeepScrapeUrls's own cleanup).
// Every tab this pool ever creates is tracked in `pool.owned` so cleanup
// can identify and close ONLY tabs THIS run created — the user's own
// tabs are never enumerated, navigated, or closed (Browser Process
// Safety, extended to this runtime feature exactly as CLAUDE.md
// requires for the E2E test harness).
// =====================================================================
var deepScrapeTabPools = Object.create(null); // runId -> { free: [tabId,...], owned: {tabId: true} }

function acquireWorkerTab(runId) {
  var pool = deepScrapeTabPools[runId] || (deepScrapeTabPools[runId] = { free: [], owned: Object.create(null) });
  if (pool.free.length) return Promise.resolve(pool.free.pop());
  return new Promise(function (resolve, reject) {
    chrome.tabs.create({ url: 'about:blank', active: false }, function (t) {
      if (chrome.runtime.lastError || !t) { reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Could not open a background processing tab.')); return; }
      pool.owned[t.id] = true;
      resolve(t.id);
    });
  });
}
function releaseWorkerTab(runId, tabId) {
  var pool = deepScrapeTabPools[runId];
  if (!pool || !pool.owned[tabId]) return; // not a tab this run owns — never touch it
  pool.free.push(tabId);
}
/** Closes ONLY the real tabs the given run itself created — called once
 * the run reaches a terminal state (completed/stopped/error), never
 * mid-run, from runDeepScrapeUrls's own finally block (covers Stop,
 * natural completion, retry, and resume uniformly, since all four funnel
 * through that one function). A tab the user manually closed in the
 * meantime is simply skipped (chrome.tabs.remove on an already-gone id
 * fails harmlessly, caught below). */
async function closeAllWorkerTabs(runId) {
  var pool = deepScrapeTabPools[runId];
  if (!pool) return;
  delete deepScrapeTabPools[runId];
  var ids = Object.keys(pool.owned);
  for (var i = 0; i < ids.length; i++) {
    try { await new Promise(function (resolve) { chrome.tabs.remove(Number(ids[i]), resolve); }); } catch (e2) { /* already gone */ }
  }
}

/** DETAIL ENRICHMENT RESET (real production request: a real "Sıfırla"
 * button in the Detail tab) — clears ONLY the two Detail Enrichment
 * run-control keys (ws_deepscrape_run, ws_deepscrape_fields), never
 * anything else. If a run is genuinely still live in THIS service-worker
 * instance, it is stopped safely first: the real AbortController is
 * aborted (the exact same mechanism the real Durdur/STOP button already
 * uses) and this function waits, bounded, for that run's own
 * runDeepScrapeUrls `finally` block to actually finish (which itself
 * closes only the tabs THIS run owns — never a broader kill, Browser
 * Process Safety) before clearing storage out from under it. A run that
 * is NOT live (already terminal — 'stopped'/'completed'/'error', the
 * exact real reported case: STOPPED at 72/125) skips the wait entirely
 * and clears immediately. */
async function resetDeepScrapeState() {
  var state = await getDeepScrapeState();
  if (state) {
    var liveController = deepScrapeAbortControllers[state.runId];
    if (liveController) {
      liveController.abort();
      var waitStart = Date.now();
      while (deepScrapeAbortControllers[state.runId] && Date.now() - waitStart < 5000) {
        await new Promise(function (resolve) { setTimeout(resolve, 50); });
      }
    }
    // Best-effort — covers both "the run's own finally block already
    // closed its tabs" (a no-op here, pool already deleted) and "the
    // bounded wait above timed out with tabs still open" (closes only
    // what THIS run itself owns).
    try { await closeAllWorkerTabs(state.runId); } catch (e) { /* best-effort */ }
  }
  await new Promise(function (resolve) {
    chrome.storage.local.remove([DEEP_SCRAPE_RUN_KEY, DEEP_SCRAPE_FIELDS_KEY], resolve);
  });
  try { chrome.alarms.clear(DEEP_SCRAPE_STALL_ALARM_NAME); } catch (e) { /* best-effort */ }
  delete deepScrapeAbortControllers[state && state.runId];
}
/** STALL-FIX mission: called when a record's hard per-record timeout
 * fires while this exact tab was in use — the attempt that was using it
 * is abandoned (its own promise may still be pending/about to settle in
 * the background), so this tab's real state is now UNKNOWN (it may be
 * mid-navigation, may have a wedged content-script, etc.) and must never
 * be handed to a LATER record. Immediately forgets it (so a stray
 * releaseWorkerTab from the abandoned attempt becomes a harmless no-op —
 * see that function's own `pool.owned[tabId]` guard) and closes it
 * (best-effort — this IS still a tab the run itself owns, so closing it
 * is within Browser Process Safety, never a broader action). The NEXT
 * acquireWorkerTab call for this run simply creates a fresh replacement,
 * the same bounded, single-replacement pattern navigateWorkerTab already
 * uses for a tab that turns out to be gone. */
function poisonWorkerTab(runId, tabId) {
  if (tabId == null) return;
  var pool = deepScrapeTabPools[runId];
  if (pool) delete pool.owned[tabId];
  try { chrome.tabs.remove(tabId, function () { void chrome.runtime.lastError; }); } catch (e) { /* best-effort — already gone, or never existed */ }
}
/** Navigates an owned worker tab to `url`. If the tab turns out to be
 * gone (e.g. Chrome reclaimed it, or — should never happen, but handled
 * defensively — something external closed it), forgets it and opens ONE
 * replacement (bounded: never an unbounded respawn loop), tracked under
 * the same ownership pool. Returns the tabId actually navigated (may
 * differ from the input on replacement). */
async function navigateWorkerTab(runId, tabId, url) {
  try {
    await new Promise(function (resolve, reject) {
      chrome.tabs.update(tabId, { url: url }, function (t) {
        if (chrome.runtime.lastError || !t) { reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'The processing tab is no longer available.')); return; }
        resolve(t);
      });
    });
    return tabId;
  } catch (e) {
    var pool = deepScrapeTabPools[runId];
    if (pool) delete pool.owned[tabId];
    return new Promise(function (resolve, reject) {
      chrome.tabs.create({ url: url, active: false }, function (t) {
        if (chrome.runtime.lastError || !t) { reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Could not open a replacement processing tab.')); return; }
        if (pool) pool.owned[t.id] = true;
        resolve(t.id);
      });
    });
  }
}

/** STALL-FIX mission — the master per-record safety net. Races `promise`
 * against BOTH a hard timeout (rejects with a RecordTimeoutError-named
 * error) and the run's own cancellation `signal` (rejects with a real
 * AbortError, same shape everything else in this file already throws),
 * whichever settles first — never leaves a dangling timer or a dangling
 * abort listener once one side wins. `promise` itself is NOT cancelled
 * (JS cannot force-cancel a Promise) — it may still be doing real work
 * in the background after this returns; the caller is responsible for
 * poisoning whatever real resource (a worker tab) that abandoned
 * attempt was using, and for absorbing its eventual settlement so it
 * never surfaces as an unhandled rejection (see fetchOneDetailPage). */
function withRecordTimeout(promise, ms, signal) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return; settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      var e = new Error('Record exceeded the ' + ms + 'ms per-record timeout.');
      e.name = 'RecordTimeoutError';
      reject(e);
    }, ms);
    function onAbort() {
      if (settled) return; settled = true;
      clearTimeout(timer);
      reject(makeAbortError());
    }
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort);
    }
    promise.then(function (v) {
      if (settled) return; settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(v);
    }, function (e) {
      if (settled) return; settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(e);
    });
  });
}

/** STALL-FIX mission — per-record diagnostics (mission's own explicit
 * shape: recordId/URL/stage/stageStartedAt/elapsedMs/lastProgressAt/
 * attempt/workerTabId). One fresh object per fetchOneDetailPage attempt,
 * mutated in place by extractDetailFields/resolveDetailPage as the
 * attempt actually progresses through real stages, and mirrored onto
 * `state.currentRecordDiag` (persisted — inspectable via the real,
 * already-existing GET_DEEP_SCRAPE_STATE message, no new message type
 * needed) so a stuck-or-slow record is honestly observable from outside
 * while it's still in flight, not only after the fact. */
function makeRecordDiag(url, attempt) {
  var now = Date.now();
  return { recordId: url, url: url, stage: 'PENDING', stageStartedAt: now, lastProgressAt: now, attempt: attempt, workerTabId: null };
}
function touchRecordDiag(state, diag, stage) {
  diag.stage = stage;
  diag.stageStartedAt = Date.now();
  diag.lastProgressAt = Date.now();
  state.currentRecordDiag = diag;
  state.updatedAt = Date.now();
  // Fire-and-forget — a diagnostic write must never slow down the actual
  // extraction pipeline it's describing; the periodic writes this file
  // already makes at natural checkpoints (fetching/retry/final) keep
  // this reasonably fresh even if one particular touch's own write is
  // still in flight when the next stage begins.
  serializeDeepScrapeOp(function () { return setDeepScrapeState(state); }).catch(function () {});
}

/** STALL-FIX ROUND 3 — the ONE authoritative, persisted record of which
 * record currently owns the worker, and until when (mission's own
 * "LEASE-BASED RECORD OWNERSHIP" + "PERSIST BEFORE AWAIT" requirements).
 * Written and its storage write AWAITED to completion BEFORE any
 * operation that might hang even starts — so a later reconciliation
 * pass, reading this back from storage, always sees an honest, current
 * deadline. A lease is only ever considered valid while `Date.now() <
 * leaseExpiresAt` — a pure wall-clock comparison, deliberately
 * independent of whether any in-memory controller/promise for this run
 * still exists, so it works even if normal JS timers died along with a
 * suspended/killed service worker. `state.currentRecordDiag.workerTabId`
 * (already kept live by touchRecordDiag) is what a reconciliation pass
 * consults for which real tab to poison — the lease itself owns the
 * TIMING half of ownership, not a second duplicate tab pointer. */
async function persistRecordLease(state, recordId, attempt, recordTimeoutMs) {
  state.lease = { recordId: recordId, leaseStartedAt: Date.now(), leaseExpiresAt: Date.now() + recordTimeoutMs + DEEP_SCRAPE_LEASE_GRACE_MS, attempt: attempt };
  state.currentUrl = recordId;
  state.updatedAt = Date.now();
  await serializeDeepScrapeOp(function () { return setDeepScrapeState(state); });
}
function clearRecordLease(state) {
  state.lease = null;
}

/** STALL-FIX mission — defense-in-depth ONLY (see DEEP_SCRAPE_WATCHDOG_*
 * constants' own comment: the per-record hard timeout above is the
 * actual fix and should make this fire essentially never). Aborts the
 * run, honestly, rather than ever leaving `status: 'running'` frozen
 * with no real progress — the same real AbortController every other
 * cancellation path in this file already uses, so this is observably
 * identical to the user pressing Stop, just triggered internally with a
 * clear, logged reason. */
function startDeepScrapeWatchdog(state, controller) {
  var staleThresholdMs = (state.recordTimeoutMs || DEEP_SCRAPE_RECORD_TIMEOUT_MS) * DEEP_SCRAPE_WATCHDOG_STALL_MULTIPLIER + 10000;
  var timer = setInterval(function () {
    if (controller.signal.aborted) return;
    var idleMs = Date.now() - (state.updatedAt || state.startedAt);
    if (idleMs > staleThresholdMs) {
      var stage = state.currentRecordDiag && state.currentRecordDiag.stage;
      console.error('[Web Scraper] Detail Enrichment watchdog: no progress for ' + idleMs + 'ms (last known stage: ' + stage + ', url: ' + (state.currentUrl || '?') + ') — this should not happen given the per-record hard timeout; aborting the run as a last resort rather than leaving it frozen.');
      controller.abort();
    }
  }, DEEP_SCRAPE_WATCHDOG_CHECK_MS);
  return function stopWatchdog() { clearInterval(timer); };
}

// Small, language-independent, DOM-structural anti-bot/CAPTCHA signature
// check — the same category of signal e2e/lib/challenge-detect.js already
// proved reliable for this project's own real-site test harness (see that
// file's header for the history of why structural markers, not text,
// are the trustworthy signal). Kept deliberately minimal here (production
// code path, not a test) — just enough to honestly distinguish a real
// SITE_CHALLENGE from a genuine extraction/selector problem, never used
// to bypass or work around what it detects.
var DEEP_SCRAPE_CHALLENGE_SELECTORS = [
  'iframe[src*="recaptcha" i]', 'iframe[title*="recaptcha" i]',
  'iframe[src*="hcaptcha" i]', '#px-captcha', '[id*="captcha" i]',
  '[class*="captcha" i]', 'iframe[src*="challenges.cloudflare" i]',
  '[id*="px-" i]', '[class*="px-" i]'
];
// Injected via chrome.scripting.executeScript's `func` (self-contained —
// runs in the target page's own isolated world, cannot reference
// anything from this service-worker scope).
function wsDetectChallengeDom(selectors) {
  for (var i = 0; i < selectors.length; i++) {
    try { if (document.querySelector(selectors[i])) return true; } catch (e) { /* invalid selector in this engine — skip */ }
  }
  return false;
}
async function pageLooksLikeChallenge(tabId) {
  try {
    var results = await chrome.scripting.executeScript({ target: { tabId: tabId }, func: wsDetectChallengeDom, args: [DEEP_SCRAPE_CHALLENGE_SELECTORS] });
    return !!(results && results[0] && results[0].result);
  } catch (e) {
    return false; // inconclusive — never block a legitimate extraction attempt on a check that itself failed
  }
}

/** REAL browser navigation extraction, via an owned/reused worker-pool
 * tab (see above) — never a fresh tab per call. Returns {ok:true, fields}
 * on a normal response (even if every field came back empty — that's a
 * 'partial' page-status decision for the CALLER to make, see
 * fetchOneDetailPage, never this function's job) or {ok:false, retryable,
 * error, failureType}. */
async function extractDetailFields(runId, url, fields, signal, diag, state) {
  if (signal && signal.aborted) throw makeAbortError();
  var tabId = null;
  if (diag && state) touchRecordDiag(state, diag, 'NAVIGATING');
  try {
    tabId = await acquireWorkerTab(runId);
  } catch (e) {
    return { ok: false, retryable: true, error: String((e && e.message) || e), failureType: 'NAVIGATION_ERROR' };
  }
  if (diag) diag.workerTabId = tabId; // from here on, a hard per-record timeout knows exactly which owned tab to poison
  try {
    try {
      tabId = await navigateWorkerTab(runId, tabId, url);
      if (diag) diag.workerTabId = tabId; // navigateWorkerTab may have replaced a gone tab with a fresh one
    } catch (e) {
      return { ok: false, retryable: true, error: String((e && e.message) || e), failureType: 'NAVIGATION_ERROR' };
    }
    if (diag && state) touchRecordDiag(state, diag, 'WAITING_FOR_LOAD');
    try {
      await waitForTabComplete(tabId, DEEP_SCRAPE_TAB_TIMEOUT_MS);
    } catch (e) {
      return { ok: false, retryable: true, error: 'Page did not finish loading in time.', failureType: 'TIMEOUT' };
    }
    if (signal && signal.aborted) throw makeAbortError();

    if (diag && state) touchRecordDiag(state, diag, 'WAITING_FOR_CONTENT_SCRIPT');
    // Real-navigation-blocked check — honest SITE_CHALLENGE, never
    // bypassed. Checked BEFORE extraction so a challenge page is never
    // mistaken for a page that simply has no matching selector content.
    if (await pageLooksLikeChallenge(tabId)) {
      return { ok: false, retryable: false, error: 'Site verification/challenge page detected on this page (BLOCKED_BY_SITE) — not bypassed.', failureType: 'SITE_CHALLENGE' };
    }

    try {
      await chrome.scripting.executeScript({ target: { tabId: tabId }, files: CONTENT_FILES });
    } catch (e) {
      return { ok: false, retryable: true, error: 'Could not run the extractor on this page: ' + String((e && e.message) || e), failureType: 'NAVIGATION_ERROR' };
    }
    if (diag && state) touchRecordDiag(state, diag, 'EXTRACTING');
    var res = await sendMessageToTab(tabId, { type: 'RUN_DETAIL_EXTRACTION', fields: fields });
    if (!res) return { ok: false, retryable: true, error: 'The page did not respond to extraction (content script did not load in time).', failureType: 'NAVIGATION_ERROR' };
    if (!res.ok) return { ok: false, retryable: false, error: res.error || 'Selector extraction failed on this page.', failureType: 'SELECTOR_ERROR' };
    return { ok: true, fields: res.row || {}, rejectedFields: res.rejectedFields || [] };
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    return { ok: false, retryable: true, error: String((e && e.message) || e), failureType: 'NAVIGATION_ERROR' };
  } finally {
    if (tabId !== null) releaseWorkerTab(runId, tabId);
  }
}

/** ONE attempt's full resolution for a single URL — the actual HTTP-403-
 * ON-ETSY bug fix lives here: cheap fetch-based validation first (catches
 * a genuinely MISSING page fast, without the cost of a real navigation),
 * then REAL browser navigation — either as the normal continuation
 * (fetch succeeded) or, whenever the fetch comes back anything OTHER
 * than a confirmed MISSING result (HTTP_BLOCKED / NAVIGATION_ERROR /
 * TIMEOUT), as the FALLBACK. This is what makes Etsy detail pages work:
 * the fetch gets 403'd by Etsy's own bot-protection, so this falls
 * through to a real navigation in the owned worker tab — the exact same
 * real request a normal interactive browser tab already makes
 * successfully. If the real navigation ALSO fails/is challenged, THAT
 * failure (more specific than the original fetch 403) is what gets
 * reported. */
async function resolveDetailPage(runId, url, fields, signal, diag, state) {
  if (diag && state) touchRecordDiag(state, diag, 'VALIDATING');
  var validation = await validateDetailUrl(url, signal);
  if (validation.ok) {
    var extraction = await extractDetailFields(runId, validation.finalUrl, fields, signal, diag, state);
    if (!extraction.ok) return extraction;
    return { ok: true, fields: extraction.fields, finalUrl: validation.finalUrl, httpStatus: validation.httpStatus, rejectedFields: extraction.rejectedFields || [] };
  }
  if (validation.failureType === 'MISSING') return validation; // trustworthy — no real navigation would change this

  var fallback = await extractDetailFields(runId, url, fields, signal, diag, state);
  if (fallback.ok) return { ok: true, fields: fallback.fields, finalUrl: url, httpStatus: null, rejectedFields: fallback.rejectedFields || [] };
  return {
    ok: false,
    retryable: fallback.failureType === 'SITE_CHALLENGE' || fallback.failureType === 'SELECTOR_ERROR' ? false : fallback.retryable,
    error: fallback.error || validation.error,
    httpStatus: validation.httpStatus,
    failureType: fallback.failureType || 'HTTP_BLOCKED'
  };
}

/** One URL's full attempt sequence: resolveDetailPage (fetch-validate,
 * falling back to real navigation as needed), with up to
 * DEEP_SCRAPE_MAX_ATTEMPTS tries and increasing backoff, but ONLY for
 * retryable failures (spec #10: "attempt 1, wait, attempt 2, wait
 * longer, attempt 3, fail" — never an infinite loop, and a permanent
 * failure like MISSING/SITE_CHALLENGE/SELECTOR_ERROR never wastes
 * retries). Distinguishes 'completed' (extraction ran and produced at
 * least one real value) from 'partial' (the page loaded fine but every
 * configured field came back empty — spec #11/#16: a real, distinct
 * signal from "couldn't reach the page at all") from 'failed' (never got
 * a usable response after every retry) — record.failureType (one of
 * MISSING/HTTP_BLOCKED/SITE_CHALLENGE/NAVIGATION_ERROR/SELECTOR_ERROR/
 * TIMEOUT) is additive detail on top of that same, unchanged status
 * vocabulary. */
async function fetchOneDetailPage(url, fields, controller, state) {
  if (controller.signal.aborted) return;
  var record = state.results[url];
  record.status = 'fetching';
  state.counts = deepScrapeCounts(state.results);
  state.updatedAt = Date.now();
  await serializeDeepScrapeOp(function () { return setDeepScrapeState(state); });

  var maxAttempts = state.maxAttempts || DEEP_SCRAPE_MAX_ATTEMPTS; // V1.20: configurable per run (deepScrapeConfig.retryLimit), defaults unchanged
  var recordTimeoutMs = state.recordTimeoutMs || DEEP_SCRAPE_RECORD_TIMEOUT_MS; // STALL-FIX mission
  var attempt = 0, lastError = null, lastHttpStatus = null, lastFailureType = null;
  while (attempt < maxAttempts) {
    attempt++;
    if (controller.signal.aborted) return;
    // STALL-FIX ROUND 3 — PERSIST BEFORE AWAIT (mission's own explicit
    // requirement): the lease is written to storage and its write
    // CONFIRMED to complete BEFORE any operation that might hang even
    // starts. If the service worker dies one line later, this lease's
    // own leaseExpiresAt is what a later reconciliation pass trusts —
    // a pure wall-clock check that needs nothing from this run's own
    // now-gone in-memory state.
    await persistRecordLease(state, url, attempt, recordTimeoutMs);
    if (controller.signal.aborted) { clearRecordLease(state); return; } // a real Stop landed while the lease write was in flight
    var diag = makeRecordDiag(url, attempt);
    var resolvePromise = resolveDetailPage(state.runId, url, fields, controller.signal, diag, state);
    var resolved;
    try {
      resolved = await withRecordTimeout(resolvePromise, recordTimeoutMs, controller.signal);
    } catch (e) {
      if (e && e.name === 'AbortError') { resolvePromise.catch(function () {}); return; } // real STOP — never counted as a page failure
      // STALL-FIX mission — THE actual fix for the reported 72/125 stall:
      // no matter which internal step this attempt was stuck in (see
      // diag.stage), the queue can NEVER block on this one record for
      // longer than recordTimeoutMs. Poison whatever real worker tab
      // this attempt was using (its state is now unknown — never handed
      // to a later record) and absorb the abandoned promise's eventual
      // settlement so it never surfaces as an unhandled rejection once
      // nothing else is awaiting it.
      poisonWorkerTab(state.runId, diag.workerTabId);
      resolvePromise.catch(function () {});
      resolved = { ok: false, retryable: true, error: 'This record exceeded the ' + recordTimeoutMs + 'ms per-record timeout while ' + diag.stage + '.', httpStatus: null, failureType: 'TIMEOUT' };
    }
    if (resolved.ok) {
      var hasAnyValue = Object.keys(resolved.fields).some(function (k) {
        var v = resolved.fields[k];
        return Array.isArray(v) ? v.length > 0 : !!v;
      });
      record.status = hasAnyValue ? 'completed' : 'partial';
      // STORAGE ARCHITECTURE FIX: the actual field VALUES no longer live
      // on `record` itself (see persistDetailResultFields's own header
      // comment) — record.fields is deliberately never set here anymore.
      record.finalUrl = resolved.finalUrl;
      record.httpStatus = resolved.httpStatus;
      record.error = null;
      record.failureType = null;
      // Real, small (field ids + short reason strings only) — never the
      // rejected value itself. Set whenever this attempt refused a
      // field as whole-page/oversized (see content/scraper.js), even if
      // OTHER fields on the same record came through fine — "do not
      // count navigation alone as successful completion" is already
      // enforced by hasAnyValue above (a record whose ONLY configured
      // field was rejected has no other value, so it's honestly
      // 'partial', never 'completed').
      if (resolved.rejectedFields && resolved.rejectedFields.length) {
        record.rejectedFields = resolved.rejectedFields;
        if (!hasAnyValue) {
          record.error = 'One or more Detail fields were rejected as oversized/invalid (e.g. whole-page HTML) — see rejectedFields.';
          record.failureType = 'FIELD_TOO_LARGE';
        }
      } else {
        record.rejectedFields = null;
      }
      // BUG FIX requirement 6 — quota safety, explicit: persistDetailResultFields
      // REJECTS on a genuine storage-quota failure (see setDeepScrapeFields).
      // Never let that crash the run or silently lose track of the
      // record — mark it honestly and keep going; every OTHER record's
      // processing is completely unaffected.
      try {
        await persistDetailResultFields(url, resolved.fields);
      } catch (e) {
        record.status = 'partial';
        record.error = 'Extracted data could not be saved (storage quota exceeded).';
        record.failureType = 'STORAGE_QUOTA';
        console.error('[Web Scraper] Detail Enrichment: could not persist extracted fields for ' + url + ' — record marked accordingly, the run continues:', e && e.message);
        try { if (typeof WSHealthDiag !== 'undefined') WSHealthDiag.pushEvent('detail', 'storage-quota-error', { url: url }); } catch (e2) { /* diagnostic-only */ }
      }
      try { if (typeof WSHealthDiag !== 'undefined') WSHealthDiag.pushEvent('detail', 'record-' + record.status, { url: url }); } catch (e3) { /* diagnostic-only */ }
      lastError = null;
      break;
    }
    lastError = resolved.error;
    lastHttpStatus = resolved.httpStatus;
    lastFailureType = resolved.failureType;
    if (!resolved.retryable) break;
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
    record.failureType = lastFailureType;
    try { if (typeof WSHealthDiag !== 'undefined') WSHealthDiag.pushEvent('detail', 'record-failed', { url: url, reason: lastFailureType || lastError }); } catch (e4) { /* diagnostic-only */ }
  }
  state.currentUrl = null;
  state.currentRecordDiag = null; // this record reached a real terminal outcome — no longer "in flight"
  clearRecordLease(state); // STALL-FIX ROUND 3 — ownership released; nothing left to reclaim for this record
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
      results[url] = { status: 'skipped', fields: null, error: 'Unsupported or unsafe URL scheme.', httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
    } else {
      results[url] = { status: 'pending', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null };
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
    recordTimeoutMs: payload.recordTimeoutMs || DEEP_SCRAPE_RECORD_TIMEOUT_MS, // STALL-FIX mission — configurable per run, same pattern as maxAttempts/concurrency
    stopRequested: false, // STALL-FIX ROUND 3 — see directlyPersistStopRequested/reconcileDeepScrapeJob
    lease: null, // STALL-FIX ROUND 3 — the ONE authoritative record of which record currently owns the worker, and until when (see persistRecordLease)
    currentUrl: null, currentRecordDiag: null, error: null,
    startedAt: Date.now(), updatedAt: Date.now(), finishedAt: null
  };
  await serializeDeepScrapeOp(function () { return setDeepScrapeState(state); });
  // STORAGE ARCHITECTURE FIX: a brand-new run starts with a genuinely
  // FRESH fields payload — ws_deepscrape_fields is a single, fixed-name
  // key (never keyed by runId, so it can never accumulate across past
  // runs), and this run's own results are about to legitimately replace
  // whatever the PREVIOUS run left there, so resetting it here reclaims
  // that space immediately rather than letting it sit unused until the
  // first record of this new run happens to complete. Best-effort —
  // never lets a reset failure block the run from starting.
  try { await setDeepScrapeFields({}); } catch (e) { console.error('[Web Scraper] Could not reset ws_deepscrape_fields at run start (non-fatal):', e && e.message); }
  // SELF-DIAGNOSTICS / HEALTH CHECK mission — a genuinely NEW Detail run
  // gets its own clean diagnostic trace, same "new run resets its own
  // scope" contract content/discovery.js's ws_pagination_diag already
  // established for the main scrape. Best-effort/fire-and-forget — never
  // lets a diagnostic-buffer failure block the run from starting.
  try {
    if (typeof WSHealthDiag !== 'undefined') {
      WSHealthDiag.clearScope('detail');
      WSHealthDiag.pushEvent('detail', 'run-started', { runId: runId, total: acceptedUrls.length, concurrency: state.concurrency });
    }
  } catch (e) { /* diagnostic-only */ }

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
  var stopWatchdog = startDeepScrapeWatchdog(state, controller); // in-process fast path — see its own comment
  // STALL-FIX ROUND 2 — the actual, guaranteed-to-survive-a-dead-service-
  // worker recovery path (see DEEP_SCRAPE_STALL_ALARM_NAME's own header
  // comment above for the full real-world reasoning).
  try { chrome.alarms.create(DEEP_SCRAPE_STALL_ALARM_NAME, { periodInMinutes: DEEP_SCRAPE_STALL_ALARM_PERIOD_MINUTES }); } catch (e) { /* best-effort — alarms API not available in some test doubles */ }
  try {
    await runWithConcurrency(urls, state.concurrency || 4, function (url) {
      state.currentUrl = url;
      return fetchOneDetailPage(url, state.fields, controller, state);
    });
  } finally {
    stopWatchdog();
    delete deepScrapeAbortControllers[state.runId];
    // Terminal state reached (completed/stopped/error) — close ONLY the
    // real tab(s) THIS run itself created (Browser Process Safety; see
    // the worker-tab pool's own header comment above).
    await closeAllWorkerTabs(state.runId);
  }

  state.currentUrl = null;
  state.currentRecordDiag = null;
  state.status = controller.signal.aborted ? 'stopped' : 'completed';
  state.finishedAt = Date.now();
  state.updatedAt = Date.now();
  await serializeDeepScrapeOp(function () { return setDeepScrapeState(state); });
  try { chrome.alarms.clear(DEEP_SCRAPE_STALL_ALARM_NAME); } catch (e) { /* best-effort */ }
  try { if (typeof WSHealthDiag !== 'undefined') WSHealthDiag.pushEvent('detail', 'run-' + state.status, { completed: state.counts && state.counts.completed, total: state.counts && state.counts.total }); } catch (e5) { /* diagnostic-only */ }
}

/** STALL-FIX ROUND 2 — called from chrome.runtime.onInstalled (which
 * fires with reason:'update' on a manual "reload extension" too — the
 * user's own real troubleshooting step while diagnosing this exact
 * stall) and chrome.runtime.onStartup (a real browser restart). Both
 * tear down whatever chrome.alarms the OLD extension instance had
 * scheduled, so a run left mid-flight at that exact moment would
 * otherwise have no alarm left to ever recover it again. Re-arms the
 * watchdog for any run this fresh instance inherited mid-flight, and
 * checks it immediately rather than waiting up to a full minute for the
 * next natural tick — safe either way, since reconcileDeepScrapeJob
 * itself never intervenes before a run has genuinely gone stale. */
async function reconcileDeepScrapeWatchdogOnWake() {
  var state = await getDeepScrapeState();
  if (!state || (state.status !== 'running' && state.status !== 'stopping')) return;
  try { chrome.alarms.create(DEEP_SCRAPE_STALL_ALARM_NAME, { periodInMinutes: DEEP_SCRAPE_STALL_ALARM_PERIOD_MINUTES }); } catch (e) { /* best-effort */ }
  reconcileDeepScrapeJob().catch(function (e) {
    console.error('[Web Scraper] Detail Enrichment reconcile error (on wake):', e);
  });
}

/** STALL-FIX ROUND 3 — the ONE reconciliation pass, called from EVERY
 * real wake-up: the stall-watchdog alarm (guaranteed even if the
 * service worker is fully gone), a real reload/restart
 * (reconcileDeepScrapeWatchdogOnWake), and — new this round — the top of
 * EVERY incoming extension message (see the dedicated onMessage
 * listener below), so simply having the popup open and polling (see
 * popup.js) gives fast, real recovery without waiting for the alarm.
 * Idempotent and cheap when there is nothing to do (the overwhelming
 * common case).
 *
 * TWO independent things are reconciled, in order:
 *   1. stopRequested (see DEEP_SCRAPE_LEASE_GRACE_MS's own header
 *      comment, point 2) — honored REGARDLESS of whether a live
 *      controller exists, but never racing a still-genuinely-alive run's
 *      own completion logic (if the service worker IS alive, this just
 *      makes sure .abort() has actually been called and lets that run's
 *      own, already-correct tail write the final 'stopped' state itself
 *      — never writes over it from here).
 *   2. Lease expiry (point 1) — a PURE Date.now()-vs-leaseExpiresAt
 *      check, independent of service-worker liveness entirely. */
var deepScrapeReconcileInFlight = Object.create(null); // STALL-FIX ROUND 4 — see reconcileDeepScrapeJob's own comment
async function reconcileDeepScrapeJob() {
  var state = await getDeepScrapeState();
  if (!state || (state.status !== 'running' && state.status !== 'stopping')) {
    try { chrome.alarms.clear(DEEP_SCRAPE_STALL_ALARM_NAME); } catch (e) { /* best-effort */ }
    return;
  }
  // STALL-FIX ROUND 4 — re-entrancy guard: this function now runs on
  // EVERY incoming message (see this function's own header comment), so
  // a burst of near-simultaneous messages can dispatch multiple
  // concurrent invocations for the SAME runId before any of them
  // finishes its own reclaim (lease-clear + staleRecoveries increment +
  // write, further down). Without this, two concurrent invocations could
  // both read the same expired lease, both increment staleRecoveries,
  // and both write — a stale counter double-counted, potentially giving
  // up on a record one cycle earlier than DEEP_SCRAPE_MAX_STALE_RECOVERIES
  // actually intends. resumeInterruptedDeepScrapeItems() (called at the
  // tail below) has its own, independent re-entrancy guard already — this
  // one protects the reclaim bookkeeping that happens before it.
  if (deepScrapeReconcileInFlight[state.runId]) return;
  deepScrapeReconcileInFlight[state.runId] = true;
  try {
    return await reconcileDeepScrapeJobLocked(state);
  } finally {
    delete deepScrapeReconcileInFlight[state.runId];
  }
}

async function reconcileDeepScrapeJobLocked(state) {
  var liveController = deepScrapeAbortControllers[state.runId];

  if (state.stopRequested) {
    if (liveController) { liveController.abort(); return; } // genuinely alive — let its own, already-correct completion logic finalize 'stopped' itself; never race it from here
    // No live controller — the run's own original service-worker
    // instance is gone. Honor Stop directly rather than ever leaving the
    // UI stuck at RUNNING/STOPPING.
    state.status = 'stopped';
    state.currentUrl = null;
    state.currentRecordDiag = null;
    clearRecordLease(state);
    state.finishedAt = Date.now();
    state.updatedAt = Date.now();
    await setDeepScrapeState(state);
    await closeAllWorkerTabs(state.runId);
    try { chrome.alarms.clear(DEEP_SCRAPE_STALL_ALARM_NAME); } catch (e) { /* best-effort */ }
    return;
  }

  if (liveController) return; // genuinely alive and not being stopped — the in-process fast path already owns this record
  if (!state.lease) return; // no record currently owns the worker right now (between records, or not yet started) — nothing to reclaim
  if (Date.now() < state.lease.leaseExpiresAt) return; // lease still valid — could be a genuinely slow-but-alive record; never pre-empt early

  console.error('[Web Scraper] Detail Enrichment: run "' + state.runId + '" — the lease for "' + state.lease.recordId + '" (attempt ' + state.lease.attempt + ') expired at ' + new Date(state.lease.leaseExpiresAt).toISOString() + ' with no live controller — its own service-worker instance was almost certainly terminated or starved mid-record. Recovering via the same machinery a real browser-restart interruption already uses.');

  var stuckUrl = state.lease.recordId;
  clearRecordLease(state);
  if (stuckUrl && state.results[stuckUrl] && ['completed', 'partial', 'skipped'].indexOf(state.results[stuckUrl].status) === -1) {
    var rec = state.results[stuckUrl];
    rec.staleRecoveries = (rec.staleRecoveries || 0) + 1;
    if (rec.staleRecoveries > DEEP_SCRAPE_MAX_STALE_RECOVERIES) {
      // Mission's own explicit requirement: one pathological record must
      // NEVER prevent the rest of the queue from being processed —
      // 'skipped' (not 'failed') so resumeInterruptedDeepScrapeItems'
      // own re-queue filter never picks this URL back up again.
      rec.status = 'skipped';
      rec.error = 'This page repeatedly stalled the extension\'s own background process (' + rec.staleRecoveries + ' recovery attempts) and was skipped so the rest of the queue could continue.';
      rec.failureType = 'TIMEOUT';
      rec.retryStatus = null;
    } else {
      rec.status = 'pending'; // let the resume below re-queue and genuinely retry it, bounded
      rec.retryStatus = null;
    }
    state.counts = deepScrapeCounts(state.results);
    await setDeepScrapeState(state);
  }

  await resumeInterruptedDeepScrapeItems({ runId: state.runId });
}

/** STALL-FIX ROUND 2 — persists the Stop request UNCONDITIONALLY,
 * regardless of whether a live in-memory AbortController exists for this
 * runId in the CURRENT service-worker instance. See the STOP_DEEP_SCRAPE
 * handler's own comment for why: if the run's original service-worker
 * instance already died, there is nothing left to .abort() in-process,
 * but this flag survives in chrome.storage.local and is what the next
 * real stall-watchdog alarm wake-up checks to finally, honestly stop the
 * run instead of ever leaving it frozen at RUNNING. */
async function persistDeepScrapeStopRequest(runId) {
  var state = await getDeepScrapeState();
  if (!state || state.runId !== runId) return;
  state.stopRequested = true;
  if (state.status === 'running') state.status = 'stopping'; // honest, immediate UI feedback ("Stopping safely…") — real STOPPED still comes from reconcileDeepScrapeJob
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
  if (deepScrapeAbortControllers[runId]) return; // STALL-FIX ROUND 4 — see resumeInterruptedDeepScrapeItems' own comment for the exact concurrent-reconciliation race this closes
  // Claimed SYNCHRONOUSLY, with zero awaits between the checks above and
  // this line — same reasoning as resumeInterruptedDeepScrapeItems.
  var controller = new AbortController();
  deepScrapeAbortControllers[runId] = controller;

  var failedUrls = Object.keys(state.results).filter(function (url) { return state.results[url].status === 'failed'; });
  if (!failedUrls.length) { delete deepScrapeAbortControllers[runId]; return; }

  failedUrls.forEach(function (url) {
    // STALL-FIX ROUND 2: preserve staleRecoveries across a re-queue —
    // otherwise a URL that has already repeatedly stalled the service
    // worker would get an unbounded number of fresh chances every time
    // ANY retry/resume touches it, defeating DEEP_SCRAPE_MAX_STALE_
    // RECOVERIES entirely.
    var staleRecoveries = state.results[url] && state.results[url].staleRecoveries;
    state.results[url] = { status: 'pending', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null, staleRecoveries: staleRecoveries };
  });
  state.status = 'running';
  state.stopRequested = false; // STALL-FIX ROUND 2 — a fresh retry/resume never inherits a stale Stop request
  state.error = null;
  state.finishedAt = null;
  state.counts = deepScrapeCounts(state.results);
  state.updatedAt = Date.now();
  await serializeDeepScrapeOp(function () { return setDeepScrapeState(state); });

  await runDeepScrapeUrls(state, failedUrls, controller);
}

/** DETAIL ENRICHMENT mission — genuine RESUME (distinct from the V1.20
 * "Retry Failed Items" above, which only ever re-queues 'failed' URLs):
 * a run interrupted mid-flight (service worker restarted, browser
 * closed/reopened) leaves `state.status` stuck at 'running' forever —
 * nothing ever transitions it to a terminal value, since that only
 * happens at the natural end of runDeepScrapeUrls — WITH some URLs
 * frozen at 'pending' or 'fetching' (whichever this SW instance's own
 * worker pool happened to be mid-way through when it died). Re-queues
 * anything not already 'completed'/'partial'/'skipped' — a strict
 * superset of retryFailedDeepScrapeItems' own 'failed'-only scope —
 * without ever touching results that already succeeded (same URL-keyed
 * "just overwrite, never duplicate" guarantee).
 *
 * `deepScrapeAbortControllers[runId]` is the freshness check: if it's
 * still set, a worker pool for this exact runId is genuinely active in
 * THIS service-worker instance right now — resuming would start a
 * SECOND concurrent pool over the same job, so this is a safe no-op in
 * that case (mirrors retryFailedDeepScrapeItems' own 'running'/
 * 'preparing' guard, but keyed on the actual live controller rather than
 * `state.status`, since `state.status` is exactly the field that lies
 * about "still running" after an interruption — that's the whole
 * problem this function exists to fix). */
async function resumeInterruptedDeepScrapeItems(message) {
  var runId = message.runId;
  var state = await getDeepScrapeState();
  if (!state || state.runId !== runId) return;
  if (deepScrapeAbortControllers[runId]) return; // genuinely still running in this SW instance — nothing to resume
  // STALL-FIX ROUND 4 — claim ownership SYNCHRONOUSLY, with ZERO awaits
  // between the check above and this line. ROOT CAUSE this closes (real,
  // reproduced: "worker tab keeps navigating one page after another, but
  // the persisted/displayed completed count never advances"):
  // reconcileDeepScrapeJob() runs on EVERY incoming message (Round 3) —
  // Chrome dispatches one message to ALL registered listeners, so the
  // SAME RESUME_DEEP_SCRAPE/RETRY_FAILED_DEEP_SCRAPE_ITEMS message a
  // user's own Resume/Retry click sends ALSO reaches the dedicated
  // reconciliation listener, and if this record's lease also happens to
  // be expired (the overwhelmingly common case — that's usually WHY the
  // user is clicking Resume at all), reconcileDeepScrapeJob's own
  // lease-reclaim path independently calls this SAME function again, in
  // the same tick. Previously the ownership claim
  // (deepScrapeAbortControllers[runId] = controller) only happened AFTER
  // a further await (persisting the re-queued urls) — wide enough for
  // both concurrent calls to pass the check above before either claimed
  // the slot, spawning TWO parallel resume loops for the same runId.
  // Each holds its own disconnected in-memory `state` snapshot
  // (chrome.storage.local.get() always returns a fresh clone, never a
  // shared reference), so each independently persists its own view of
  // state.counts — the two loops alternately overwrite each other's
  // genuinely-advancing progress. Claiming the slot here, with no await
  // between check and claim, makes this re-entrancy guard actually
  // atomic — a second concurrent call now always sees the slot already
  // taken and returns immediately, exactly as this function's own
  // header comment always intended.
  var controller = new AbortController();
  deepScrapeAbortControllers[runId] = controller;

  var stuckUrls = Object.keys(state.results).filter(function (url) {
    var st = state.results[url].status;
    return st === 'pending' || st === 'fetching' || st === 'failed';
  });
  if (!stuckUrls.length) {
    delete deepScrapeAbortControllers[runId]; // nothing claimed after all — release the slot immediately
    // Nothing left to do — but a dead process may have left `status`
    // stuck at 'running' with no work actually remaining; finalize it
    // honestly rather than leaving the UI showing a run that will never
    // move again.
    if (state.status === 'running') {
      state.status = 'completed';
      state.currentUrl = null;
      state.finishedAt = Date.now();
      state.updatedAt = Date.now();
      await serializeDeepScrapeOp(function () { return setDeepScrapeState(state); });
    }
    return;
  }

  stuckUrls.forEach(function (url) {
    // STALL-FIX ROUND 2: preserve staleRecoveries across a re-queue — see
    // the identical comment in retryFailedDeepScrapeItems above.
    var staleRecoveries = state.results[url] && state.results[url].staleRecoveries;
    state.results[url] = { status: 'pending', fields: null, error: null, httpStatus: null, finalUrl: null, retryStatus: null, failureType: null, staleRecoveries: staleRecoveries };
  });
  state.status = 'running';
  state.stopRequested = false; // STALL-FIX ROUND 2 — a fresh retry/resume never inherits a stale Stop request
  state.error = null;
  state.finishedAt = null;
  state.counts = deepScrapeCounts(state.results);
  state.updatedAt = Date.now();
  await serializeDeepScrapeOp(function () { return setDeepScrapeState(state); });

  await runDeepScrapeUrls(state, stuckUrls, controller);
}

/** spec #4/#20: the popup's "Test Detail Fields" sample preview — runs
 * the exact SAME validate-then-extract pipeline a real run uses (no
 * separate code path to keep in sync), just without retries/session-
 * state tracking/pacing, since this is a quick, small (<=3 URL),
 * synchronous-feeling check the popup awaits directly rather than a
 * tracked background run. */
async function testDeepScrapeSample(urls, fields) {
  var results = Object.create(null);
  // Own small, ephemeral runId/pool (up to 3 concurrent tabs, matching
  // this preview's own concurrency of 3 — still bounded, never unbounded,
  // and closed unconditionally below) — reuses the SAME resolveDetailPage
  // fetch-then-real-navigation-fallback pipeline a real run uses, so this
  // PREVIEW/VALIDATION step gives an honest signal about whether the real
  // run will also need (and get) the real-navigation fallback.
  var testRunId = 'test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  try {
    await runWithConcurrency(urls, 3, async function (url) {
      // STALL-FIX mission: the same hard per-record timeout the real run
      // gets — a slow/stuck sample page must never freeze the "Test
      // Fields" button forever either.
      var diag = makeRecordDiag(url, 1);
      var resolved;
      try {
        resolved = await withRecordTimeout(resolveDetailPage(testRunId, url, fields, null, diag), DEEP_SCRAPE_RECORD_TIMEOUT_MS, null);
      } catch (e) {
        poisonWorkerTab(testRunId, diag.workerTabId);
        resolved = { ok: false, error: 'This sample page exceeded the ' + DEEP_SCRAPE_RECORD_TIMEOUT_MS + 'ms per-record timeout while ' + diag.stage + '.', failureType: 'TIMEOUT' };
      }
      if (!resolved.ok) { results[url] = { status: 'failed', error: resolved.error, failureType: resolved.failureType }; return; }
      var hasAny = Object.keys(resolved.fields).some(function (k) {
        var v = resolved.fields[k];
        return Array.isArray(v) ? v.length > 0 : !!v;
      });
      results[url] = { status: hasAny ? 'completed' : 'partial', fields: resolved.fields, finalUrl: resolved.finalUrl };
    });
  } finally {
    await closeAllWorkerTabs(testRunId);
  }
  return results;
}

// STALL-FIX ROUND 3 — a SEPARATE, dedicated, response-free listener
// (Chrome dispatches every incoming message to ALL registered
// onMessage listeners, so this coexists with every other listener in
// this file without touching any of them) that reconciles the Detail
// Enrichment job on EVERY single incoming extension message — not only
// the once-a-minute alarm. Combined with popup.js's own active polling
// while a job is running/stopping, this gives fast, real recovery
// whenever the popup is open, while the alarm remains the guaranteed
// fallback for when it's closed. Deliberately never calls sendResponse
// and never returns true — it must never interfere with whichever OTHER
// listener actually owns handling this particular message.
chrome.runtime.onMessage.addListener(function () {
  reconcileDeepScrapeJob().catch(function () { /* best-effort — the alarm/next message is still a safety net */ });
});

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
    if (dsController) dsController.abort(); // fast path — the run's own service worker is genuinely still alive right now
    // STALL-FIX ROUND 2: ALSO persist the stop request UNCONDITIONALLY —
    // see DEEP_SCRAPE_STALL_ALARM_NAME's own header comment. If the run's
    // own original service-worker instance is already gone, there is no
    // live controller left to abort here — this flag is what the next
    // real alarm wake-up checks to finally, honestly transition the run
    // to 'stopped', instead of ever leaving the UI stuck at RUNNING (the
    // exact second bug this mission reported).
    persistDeepScrapeStopRequest(message.runId).catch(function (e) {
      console.error('[Web Scraper] could not persist stop request:', e);
    });
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

  // DETAIL ENRICHMENT mission — genuine resume of an interrupted run
  // (pending/fetching/failed all re-queued), see
  // resumeInterruptedDeepScrapeItems's own header comment for exactly
  // how this differs from RETRY_FAILED_DEEP_SCRAPE_ITEMS above.
  if (message.type === 'RESUME_DEEP_SCRAPE') {
    resumeInterruptedDeepScrapeItems(message).catch(function (e) {
      console.error('[Web Scraper] deep scrape resume error:', e);
    });
    sendResponse({ ok: true, started: true });
    return true;
  }

  // DETAIL ENRICHMENT RESET (real production request): a real user's
  // own explicit "Sıfırla" button — clears ONLY Detail Enrichment's own
  // run-control state (ws_deepscrape_run, ws_deepscrape_fields), never
  // main scrape results/license/settings/templates/snapshots. Stops any
  // genuinely live worker safely FIRST (same real .abort() + a bounded
  // wait for its own owned-tab cleanup to actually finish, never a
  // broader kill — Browser Process Safety) before clearing storage out
  // from under it.
  if (message.type === 'RESET_DEEP_SCRAPE') {
    resetDeepScrapeState().then(function () { sendResponse({ ok: true }); })
      .catch(function (e) {
        console.error('[Web Scraper] deep scrape reset error:', e);
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true;
  }
});

// =====================================================================
// BUG REOPEN — DETAIL VISUAL ELEMENT PICKER: real production flow fix.
//
// ROOT CAUSE (confirmed, not guessed): popup.js's own
// handleDtPickFieldsClick() used to run the ENTIRE "open the sample
// detail page -> wait for it to load -> inject the content script ->
// send START_PICK" sequence itself, as one chain of awaits. In the
// REAL Chrome toolbar popup (never reachable by this project's own
// Playwright test harness — see e2e/run.js's own documented
// limitation, exactly how the PRIOR fix's own real-browser testing
// missed this), chrome.tabs.create({active:true}) steals window focus
// away from the popup — and losing focus is one of the standard, well-
// known ways a real browser-action popup is destroyed: its entire JS
// execution context is torn down immediately, mid-await, before any
// later step in that chain ever ran. No highlight, nothing captured,
// nothing returned — the picker was never even being TOLD to start.
//
// THE FIX: this entire sequence now lives HERE, in the service worker,
// which has no dependency on the popup's lifetime at all — triggered by
// a single fire-and-forget message (START_DETAIL_FIELD_PICK) the popup
// sends and can safely be destroyed a millisecond after. Every step is
// persisted to chrome.storage.local (DETAIL_PICK_SESSION_KEY) —
// durable, independent of popup lifetime, readable at any time
// (including a dev-only diagnostic — see popup.js's
// handleCopyDetailPickDiagnostic) to prove exactly which of these
// actually happened, per this mission's own explicit Phase 1/2 ask:
//   1. message received (this handler running at all)
//   2. real tab created (real tab id resolved)
//   3. that real tab finished loading
//   4. content script confirmed reachable (injected fresh, or already
//      present via the persistent registerContentScripts registration
//      handleStartLiveSession already set up for this origin)
//   5. START_PICK actually sent to that exact tab
//   6. the content script's own response — did picker mode genuinely
//      become active on ITS side (ok:true), not just "the message
//      didn't throw"
// =====================================================================

var DETAIL_PICK_SESSION_KEY = 'ws_detail_pick_session';

function setDetailPickSession(state) {
  var data = {};
  data[DETAIL_PICK_SESSION_KEY] = state;
  return new Promise(function (resolve) { chrome.storage.local.set(data, resolve); });
}
function getDetailPickSession() {
  return new Promise(function (resolve) {
    chrome.storage.local.get([DETAIL_PICK_SESSION_KEY], function (result) { resolve((result && result[DETAIL_PICK_SESSION_KEY]) || null); });
  });
}

/** Same "retry once with a fresh content-script injection if the first
 * attempt gets no response" contract this project already uses
 * elsewhere (popup.js's own sendToContent(), for one) — a defensive
 * fallback, not the primary mechanism (the persistent
 * registerContentScripts registration matching this origin SHOULD
 * already have auto-injected the content script by the time the tab
 * finishes loading). Returns whether a fresh injection actually ran, so
 * the caller's own diagnostic record stays honest either way. */
async function sendStartPickWithRetry(tabId, message) {
  var res = await sendMessageToTab(tabId, message);
  var injected = false;
  if (!res) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tabId }, files: CONTENT_FILES });
      injected = true;
    } catch (e) { /* may already be injected — proceed to retry regardless */ }
    res = await sendMessageToTab(tabId, message);
  }
  return { res: res, injected: injected };
}

async function startDetailFieldPick(payload) {
  var diag = {
    startedAt: Date.now(), updatedAt: Date.now(), sampleUrl: payload.sampleUrl, hostname: payload.hostname,
    step: 'received', tabId: null, tabUrl: null, tabLoaded: false, injected: false,
    messageSent: false, messageAcked: false, pickerActive: null, error: null
  };
  await setDetailPickSession(diag);

  try {
    var tab = await new Promise(function (resolve, reject) {
      chrome.tabs.create({ url: payload.sampleUrl, active: true }, function (t) {
        if (chrome.runtime.lastError || !t) reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Could not open the sample page.'));
        else resolve(t);
      });
    });
    diag.tabId = tab.id; diag.tabUrl = tab.url || payload.sampleUrl; diag.step = 'tab-created'; diag.updatedAt = Date.now();
    await setDetailPickSession(diag);

    await waitForTabComplete(tab.id, TAB_LOAD_TIMEOUT_MS);
    diag.tabLoaded = true; diag.step = 'tab-loaded'; diag.updatedAt = Date.now();
    await setDetailPickSession(diag);

    diag.messageSent = true; diag.step = 'sending-start-pick'; diag.updatedAt = Date.now();
    await setDetailPickSession(diag);

    var result = await sendStartPickWithRetry(tab.id, { type: 'START_PICK', purpose: 'live-detail-field', targetHostname: payload.hostname });
    diag.injected = result.injected;
    diag.messageAcked = !!(result.res && result.res.ok);
    diag.pickerActive = diag.messageAcked;
    diag.step = diag.messageAcked ? 'picker-active' : 'no-ack';
    diag.updatedAt = Date.now();
    await setDetailPickSession(diag);
  } catch (e) {
    diag.step = 'error';
    diag.error = String((e && e.message) || e);
    diag.updatedAt = Date.now();
    await setDetailPickSession(diag);
  }
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) return;

  if (message.type === 'START_DETAIL_FIELD_PICK') {
    // Fire-and-forget by design (see this section's own header comment)
    // — sendResponse fires immediately so the popup can safely close
    // right after; startDetailFieldPick() keeps running here regardless.
    startDetailFieldPick(message).catch(function (e) {
      console.error('[Web Scraper] detail field pick error:', e);
    });
    sendResponse({ ok: true, started: true });
    return true;
  }

  if (message.type === 'GET_DETAIL_PICK_SESSION') {
    getDetailPickSession().then(function (state) { sendResponse({ ok: true, session: state }); });
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
