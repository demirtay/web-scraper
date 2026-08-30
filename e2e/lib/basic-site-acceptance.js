/**
 * basic-site-acceptance.js
 * Shared "does the real extension work at all on this real site" check —
 * the common core of e2e/tests/site-acceptance-amazon.test.js and
 * site-acceptance-ebay.test.js (Etsy's own equivalent,
 * e2e/tests/etsy-popup.test.js, predates this file and is left
 * untouched/unmodified per CLAUDE.md's "preserve working features").
 *
 * Steps, all against 100% real, unmodified production code — never an
 * internal helper called directly (Anti-False-Pass Rule):
 *   1. Open the real site page; detect an anti-bot challenge (shared
 *      e2e/lib/challenge-detect.js) and report BLOCKED_BY_SITE honestly
 *      rather than treating it as a pass or working around it.
 *   2. Open the real popup, confirm it renders with real controls.
 *   3. Grant the real optional host permission via the real
 *      chrome.permissions.request() API (may require a manual "Allow"
 *      click — see CLAUDE.md's Permission Prompts guidance; the caller
 *      is expected to have a reasonable outer timeout).
 *   4. Inject the real content-script bundle and PING it.
 *   5. Trigger the real automatic field-detection engine (best-effort —
 *      not a hard failure if it doesn't find a structure on this
 *      particular page, same as etsy-popup.test.js's own convention).
 */
const path = require('path');
const { assertNoChallenge } = require('./challenge-detect');

function assert(cond, msg) {
  if (!cond) {
    const err = new Error(msg);
    err.isAssertion = true;
    throw err;
  }
}

/**
 * @param {{context, extensionId, serviceWorker, log}} ctx
 * @param {{label:string, url:string, hostnamePattern:RegExp, permissionOrigin:string, artifactDir:string, artifactPrefix:string}} site
 * @returns {Promise<{passed:string[], details:object}>}
 */
async function runBasicSiteAcceptance(ctx, site) {
  const { context, extensionId, log } = ctx;
  const passed = [];
  const details = {};
  const prefix = site.artifactPrefix || site.label.toLowerCase();

  log.step('A. Opening real ' + site.label + ' page: ' + site.url);
  const sitePage = await context.newPage();
  const consoleErrors = [];
  sitePage.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  sitePage.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  await sitePage.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sitePage.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
  details.finalUrl = sitePage.url();
  details.pageTitle = await sitePage.title().catch(() => '(unavailable)');
  log.info('Landed on: ' + details.finalUrl + ' — title: "' + details.pageTitle + '"');

  await sitePage.screenshot({ path: path.join(site.artifactDir, prefix + '-browser.png'), fullPage: false, timeout: 60000 }).catch(() => {});

  const challengeResult = await assertNoChallenge(sitePage, site.label, details);
  details.framesChecked = challengeResult.framesChecked;
  passed.push('A. Real ' + site.label + ' page opened (no CAPTCHA/challenge detected — checked ' + challengeResult.framesChecked + ' frame(s), DOM markers + multi-language text)');

  log.step('B. Opening the popup: chrome-extension://' + extensionId + '/popup/popup.html');
  const popupPage = await context.newPage();
  const popupConsoleErrors = [];
  popupPage.on('console', (msg) => { if (msg.type() === 'error') popupConsoleErrors.push(msg.text()); });
  popupPage.on('pageerror', (err) => popupConsoleErrors.push('pageerror: ' + err.message));
  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await popupPage.waitForTimeout(600);

  const bodyHtmlLen = await popupPage.evaluate(() => document.body ? document.body.innerHTML.length : 0);
  assert(bodyHtmlLen > 500, 'popup.html rendered essentially empty (body innerHTML length ' + bodyHtmlLen + ')');
  const controlIds = ['add-column-btn', 'basla-btn', 'columns-list'];
  const controlPresence = await popupPage.evaluate((ids) => {
    const out = {};
    ids.forEach((id) => { out[id] = !!document.getElementById(id); });
    return out;
  }, controlIds);
  details.popupControlsPresentInDom = controlPresence;
  assert(controlIds.every((id) => controlPresence[id]), 'one or more real popup controls missing from the DOM: ' + JSON.stringify(controlPresence));
  passed.push('B. Popup rendered with real controls present (' + controlIds.join(', ') + ')');

  await popupPage.screenshot({ path: path.join(site.artifactDir, prefix + '-popup.png'), fullPage: true, timeout: 60000 }).catch(() => {});

  log.step('C. Requesting the real optional host permission (' + site.permissionOrigin + ')');
  const permResult = await popupPage.evaluate((origin) => {
    return chrome.permissions.request({ origins: [origin] })
      .then((granted) => ({ granted }))
      .catch((e) => ({ error: String(e && e.message || e) }));
  }, site.permissionOrigin);
  details.hostPermissionGrant = permResult;
  assert(permResult.granted === true, 'chrome.permissions.request did not resolve granted:true — ' + JSON.stringify(permResult));
  passed.push('C. Real optional host permission granted via chrome.permissions.request()');

  log.step('D. Injecting the real content-script bundle and PINGing it');
  const sw = ctx.serviceWorker;
  const pingResult = await sw.evaluate(async (hostnamePatternSource) => {
    const hostnamePattern = new RegExp(hostnamePatternSource, 'i');
    const tabs = await chrome.tabs.query({});
    const siteTab = tabs.find((t) => typeof t.url === 'string' && hostnamePattern.test(t.url));
    if (!siteTab) return { ok: false, error: 'no matching site tab found via chrome.tabs.query({})', allTabs: tabs.map((t) => ({ id: t.id, url: t.url })) };
    const tabId = siteTab.id;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    } catch (e) {
      return { ok: false, error: 'executeScript failed: ' + (e && e.message || e), tabId };
    }
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      return { ok: !!(res && res.ok), tabId, pingResponse: res };
    } catch (e) {
      return { ok: false, error: 'sendMessage failed: ' + (e && e.message || e), tabId };
    }
  }, site.hostnamePattern.source);
  details.contentScriptPing = pingResult;
  assert(pingResult.ok, 'content script did not load/respond to PING — ' + (pingResult.error || JSON.stringify(pingResult)));
  passed.push('D. Content script loaded into the real ' + site.label + ' tab and responded to PING');

  log.step('E. Triggering the real automatic field-detection engine (best-effort)');
  const autoDetectResult = await sw.evaluate(async (tabId) => {
    try { return await chrome.tabs.sendMessage(tabId, { type: 'RUN_AUTO_DETECT' }); }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }, pingResult.tabId);
  details.autoDetect = { ok: autoDetectResult && autoDetectResult.ok, structureCount: autoDetectResult && Array.isArray(autoDetectResult.structures) ? autoDetectResult.structures.length : 0 };
  if (autoDetectResult && autoDetectResult.ok) {
    passed.push('E. Real automatic field-detection engine ran (' + details.autoDetect.structureCount + ' structure(s) found)');
  } else {
    log.warn('AUTO-detect did not report ok:true — not a hard failure (PING already proved real communication): ' + JSON.stringify(autoDetectResult));
  }

  await popupPage.screenshot({ path: path.join(site.artifactDir, prefix + '-popup.png'), fullPage: true, timeout: 60000 }).catch(() => {});

  details.consoleErrors = { sitePage: consoleErrors, popupPage: popupConsoleErrors };
  return { passed, details, sitePage, popupPage };
}

module.exports = { runBasicSiteAcceptance };
