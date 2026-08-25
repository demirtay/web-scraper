/**
 * etsy-popup.test.js
 * PHASE 3 proof-of-concept: exercises the REAL, unmodified ClickScrape
 * extension against a REAL public Etsy page. No mocked DOM, no faked
 * selectors — every check below drives the extension's own actual
 * message protocol (content/content.js, content/autodetect.js,
 * background/background.js's real CONTENT_FILES injection list, and the
 * real chrome.permissions.request() the extension itself calls) exactly
 * as the popup itself would, just orchestrated programmatically so it
 * works without Chrome's native (Playwright-unautomatable)
 * toolbar-popup UI.
 *
 * Steps (spec Phase 3 A-G):
 *   A. Open a real Etsy shower-curtain search page.
 *   C. Open the ClickScrape popup (as its own page — see the file-level
 *      note in run.js about why, and the known limitation this implies).
 *   D/E. Confirm the popup renders and its real controls are visible.
 *   (permission) Grant the real, unmodified optional host permission
 *      the extension itself requests — via the extension's own real
 *      chrome.permissions.request() API, called from the popup page
 *      context (required: this API only works from an extension page
 *      with a DOM, not from the background service worker).
 *   B. Confirm the content script actually loads/responds (PING).
 *   F. Confirm the extension can communicate with the Etsy tab.
 *   G. Screenshots at every stage.
 */
const path = require('path');

const ETSY_URL = 'https://www.etsy.com/search?q=shower+curtain&category=home_living';
const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'test-artifacts', 'latest');

// Substrings that indicate a bot-challenge/CAPTCHA page rather than real
// Etsy content — checked so a challenge is reported HONESTLY as the
// genuine external blocker it is, never silently treated as a pass.
// LANGUAGE-DEPENDENT TEXT ALONE IS NOT RELIABLE — confirmed the hard
// way: an English-only marker list completely missed a REAL Turkish-
// language Etsy CAPTCHA page ("Bu kişinin bir robot değil, siz
// olduğunuzdan emin olmak istiyoruz") on the very first real run,
// producing a false PASS. Structural DOM markers (below) are the
// primary, language-independent signal now; text markers (several
// languages) are kept as a secondary check.
const CHALLENGE_TEXT_MARKERS = [
  // English — generic
  'captcha', 'are you a robot', 'access to this page has been denied',
  'press and hold', 'press & hold', 'checking your browser', 'just a moment',
  'verify you are human', 'unusual traffic',
  // English — Etsy's OWN actual real challenge wording, confirmed
  // verbatim from two independent real runs against this environment's
  // IP ("Verification Required" / "Slide right to secure your access" /
  // "We detected unusual activity from your device or network" /
  // "Automated (bot) activity on your network"). The FIRST fix here
  // (generic phrases only) still missed this exact wording on the very
  // next run — real proof the marker list needs the SITE'S OWN actual
  // text, not just generic guesses.
  'verification required', 'slide right to secure', 'unusual activity from your device',
  'automated (bot) activity', 'rapid taps or clicks',
  // Turkish (observed verbatim on an earlier run, different locale)
  'robot değil', 'doğrulama gerekli', 'erişiminizi güvenceye alın',
  // Spanish / French / German (common Etsy locales) — best-effort
  'no soy un robot', 'não sou um robô', 'je ne suis pas un robot',
  'ich bin kein roboter', 'nicht automatisiert'
];
// Structural, language-independent: known CAPTCHA/anti-bot widget
// providers' own DOM signatures.
const CHALLENGE_DOM_SELECTORS = [
  'iframe[src*="recaptcha" i]', 'iframe[title*="recaptcha" i]',
  'iframe[src*="hcaptcha" i]', '#px-captcha', '[id*="captcha" i]',
  '[class*="captcha" i]', 'iframe[src*="challenges.cloudflare" i]',
  // PerimeterX/HUMAN Security (Etsy's actual vendor, confirmed by the
  // real challenge observed) commonly namespaces its DOM with "px-".
  '[id*="px-" i]', '[class*="px-" i]'
];

function assert(cond, msg) {
  if (!cond) {
    const err = new Error(msg);
    err.isAssertion = true;
    throw err;
  }
}

/**
 * @param {{context, extensionId, serviceWorker, log}} ctx
 * @returns {Promise<{passed: string[], details: object}>}
 */
async function run(ctx) {
  const { context, extensionId, log } = ctx;
  const passed = [];
  const details = {};

  // ---- A. Open a real Etsy page ----
  log.step('A. Opening real Etsy page: ' + ETSY_URL);
  const etsyPage = await context.newPage();
  const consoleErrors = [];
  etsyPage.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  etsyPage.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  await etsyPage.goto(ETSY_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await etsyPage.waitForLoadState('load', { timeout: 30000 }).catch(() => { /* best-effort */ });
  details.finalUrl = etsyPage.url();
  details.pageTitle = await etsyPage.title().catch(() => '(unavailable)');
  log.info('Landed on: ' + details.finalUrl + ' — title: "' + details.pageTitle + '"');

  // Screenshot BEFORE the challenge check, deliberately — even a
  // detected-blocker run must leave a real, honest screenshot of
  // whatever was actually on screen, never skip it because the check
  // is about to fail.
  // timeout raised from Playwright's 30s default — a heavily loaded dev
  // machine (many unrelated Chrome/Node processes) has been observed to
  // make the standard "wait for fonts to finish loading" screenshot
  // precondition take longer than that on a real, content-heavy page
  // like Etsy's; this is a resource-contention allowance, not a
  // correctness change.
  await etsyPage.screenshot({ path: path.join(ARTIFACT_DIR, 'browser.png'), fullPage: false, timeout: 60000 });
  log.info('Saved browser.png');

  // REAL BUG, found by actually looking at the screenshot twice more
  // even after "fixing" text/DOM detection: the widget only ever showed
  // up in the SCREENSHOT, never in document.body.innerText OR any
  // top-frame querySelector — meaning it renders inside an IFRAME
  // (typical for PerimeterX/HUMAN-style challenges, isolated on
  // purpose). document.body.innerText/querySelector on the top page
  // NEVER see into a frame's own document at all — checking every frame
  // Playwright has attached to (page.frames(), which includes nested/
  // cross-origin frames it can still read via CDP) is the actual fix,
  // not another wording guess.
  let bodyTextSample = '';
  let domChallengeHit = null;
  for (const frame of etsyPage.frames()) {
    try {
      const frameText = await frame.evaluate(() => document.body ? document.body.innerText.slice(0, 3000).toLowerCase() : '');
      bodyTextSample += ' ' + frameText;
    } catch (e) { /* frame navigated away/detached mid-check, or genuinely inaccessible — skip it, not fatal */ }
    if (!domChallengeHit) {
      try {
        const hit = await frame.evaluate((selectors) => {
          for (const sel of selectors) { try { if (document.querySelector(sel)) return sel; } catch (e) { /* invalid selector in this engine */ } }
          return null;
        }, CHALLENGE_DOM_SELECTORS);
        if (hit) domChallengeHit = hit;
      } catch (e) { /* same as above */ }
    }
  }
  details.framesChecked = etsyPage.frames().length;
  const textChallengeHit = CHALLENGE_TEXT_MARKERS.find((m) => bodyTextSample.includes(m) || (details.pageTitle || '').toLowerCase().includes(m));
  const challengeHit = domChallengeHit ? ('DOM selector "' + domChallengeHit + '" (frame)') : (textChallengeHit ? ('text "' + textChallengeHit + '" (frame)') : null);
  if (challengeHit) {
    const err = new Error('EXTERNAL BLOCKER: Etsy served an anti-bot challenge/CAPTCHA page (matched ' + challengeHit + ') instead of real search results. This requires human interaction and cannot be bypassed — per SAFETY rules, this harness does not attempt to.');
    err.isExternalBlocker = true;
    err.details = details;
    throw err;
  }
  passed.push('A. Real Etsy page opened (no CAPTCHA/challenge detected — checked both DOM markers and multi-language text)');

  // ---- C/D/E. Open the popup and confirm it renders with real controls ----
  log.step('C. Opening the popup as its own page: chrome-extension://' + extensionId + '/popup/popup.html');
  const popupPage = await context.newPage();
  const popupConsoleErrors = [];
  popupPage.on('console', (msg) => { if (msg.type() === 'error') popupConsoleErrors.push(msg.text()); });
  popupPage.on('pageerror', (err) => popupConsoleErrors.push('pageerror: ' + err.message));
  await popupPage.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await popupPage.waitForTimeout(600); // let popup.js's own async init() (permissions/storage reads) settle
  passed.push('C. Popup page opened successfully (chrome-extension:// URL loaded, no navigation error)');

  await popupPage.screenshot({ path: path.join(ARTIFACT_DIR, 'popup.png'), fullPage: true, timeout: 60000 });
  log.info('Saved popup.png');

  const bodyHtmlLen = await popupPage.evaluate(() => document.body ? document.body.innerHTML.length : 0);
  assert(bodyHtmlLen > 500, 'popup.html rendered essentially empty (body innerHTML length ' + bodyHtmlLen + ') — real UI did not render');
  passed.push('D. Popup DOM actually rendered (body content present, not blank)');

  // Real, unmodified control ids from popup.html — checked for
  // PRESENCE IN THE DOM (existing, not synthesized for this test),
  // regardless of which of the popup's own real UI states (normal
  // setup screen vs. its own "unsupported page" fallback — see the
  // known-limitation note in run.js) is currently showing.
  const controlIds = ['add-column-btn', 'basla-btn', 'columns-list'];
  const controlPresence = await popupPage.evaluate((ids) => {
    const out = {};
    ids.forEach((id) => { out[id] = !!document.getElementById(id); });
    return out;
  }, controlIds);
  details.popupControlsPresentInDom = controlPresence;
  log.info('Popup real control ids present in DOM: ' + JSON.stringify(controlPresence));
  const allPresent = controlIds.every((id) => controlPresence[id]);
  assert(allPresent, 'one or more real popup controls missing from the DOM entirely: ' + JSON.stringify(controlPresence));
  passed.push('E. Real popup controls exist in the rendered DOM (' + controlIds.join(', ') + ')');

  // Diagnostic (not a hard pass/fail): whether popup.js resolved the
  // ETSY tab as its own operating target, or — the known, documented
  // Playwright-testing limitation — resolved itself (since opening
  // popup.html as an ordinary tab makes chrome.tabs.query({active:true,
  // currentWindow:true}) return that tab, not Etsy's). Recorded
  // honestly either way; see run.js's REMAINING LIMITATIONS note.
  const popupTargetHostname = await popupPage.evaluate(() => {
    return new Promise((resolve) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const t = tabs && tabs[0];
          resolve(t ? { url: t.url, id: t.id } : null);
        });
      } catch (e) { resolve(null); }
    });
  });
  details.popupActiveTabResolution = popupTargetHostname;
  log.info('popup.js resolves chrome.tabs.query({active:true,currentWindow:true}) as: ' + JSON.stringify(popupTargetHostname));
  if (popupTargetHostname && /etsy\.com/.test(popupTargetHostname.url || '')) {
    passed.push('BONUS: popup correctly resolved the real Etsy tab as its active target (not just itself)');
  } else {
    log.warn('KNOWN LIMITATION: popup opened as a standalone page resolves ITSELF as the "active tab", not the Etsy tab — this is an artifact of Playwright not being able to drive the native toolbar-popup surface, not a defect in the extension. See run.js REMAINING LIMITATIONS.');
  }

  // ---- Grant the REAL optional host permission via the extension's OWN
  // real API — chrome.permissions.request() only works from an
  // extension page with a DOM (not the background service worker),
  // which is why this runs here, through the already-open popup page,
  // rather than from the service worker like the injection step below.
  // This is the exact same call popup.js's own handleStartLiveSession()
  // makes as its first step in real production use; only the trigger
  // (a real user's BAŞLA click vs. this harness calling it directly) is
  // different — the API call itself is 100% real and unmodified. ----
  log.step('Requesting the real optional host permission for etsy.com (chrome.permissions.request)');
  const permResult = await popupPage.evaluate(() => {
    return chrome.permissions.request({ origins: ['https://*.etsy.com/*'] })
      .then((granted) => ({ granted }))
      .catch((e) => ({ error: String(e && e.message || e) }));
  });
  details.hostPermissionGrant = permResult;
  log.info('chrome.permissions.request result: ' + JSON.stringify(permResult));
  assert(permResult.granted === true, 'chrome.permissions.request({origins:["https://*.etsy.com/*"]}) did not resolve granted:true — ' + JSON.stringify(permResult));
  passed.push('Real optional host permission for etsy.com granted via the extension\'s own unmodified chrome.permissions.request() API');

  // ---- B/F. Confirm the content script loads and can communicate ----
  // Driven from the background service worker's OWN real code — the
  // exact same chrome.scripting.executeScript(CONTENT_FILES) +
  // chrome.tabs.sendMessage path popup.js's sendToContent() uses, just
  // invoked here instead of through the native toolbar-popup UI
  // (Playwright cannot drive that surface — see PHASE 2 of the task).
  log.step('B/F. Injecting the real content-script bundle into the Etsy tab and PINGing it');
  const sw = ctx.serviceWorker;
  const pingResult = await sw.evaluate(async () => {
    // `active`/`windowId`/`id` are never permission-gated (unlike
    // `url`/`title`), so this reliably finds a tab even before/without
    // host permission for its URL — used only to get an id here; the
    // Etsy tab is the most-recently-focused one at this point in the
    // flow (the popup page was opened after it, but chrome.tabs' own
    // "active"/"lastFocusedWindow" notion tracks per-WINDOW state, and
    // both pages share one window/context here).
    const tabs = await chrome.tabs.query({});
    const etsyTab = tabs.find((t) => typeof t.url === 'string' && /etsy\.com/.test(t.url));
    if (!etsyTab) return { ok: false, error: 'no etsy tab found via chrome.tabs.query({}) — tab.url was not visible (host permission not granted?)', allTabs: tabs.map((t) => ({ id: t.id, url: t.url })) };
    const tabId = etsyTab.id;
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
  });
  details.contentScriptPing = pingResult;
  log.info('Content-script PING result: ' + JSON.stringify(pingResult));
  assert(pingResult.ok, 'content script did not load/respond to PING on the real Etsy tab — ' + (pingResult.error || JSON.stringify(pingResult)));
  passed.push('B. Content script actually loaded into the Etsy tab (real chrome.scripting.executeScript, real CONTENT_FILES)');
  passed.push('F. Extension <-> Etsy tab communication confirmed (real chrome.tabs.sendMessage PING round-trip)');

  // ---- F (extra, optional per spec): real AUTO-detect engine against the real page ----
  log.step('F (extra). Triggering the REAL automatic field-detection engine (RUN_AUTO_DETECT) against the real Etsy DOM');
  const autoDetectResult = await sw.evaluate(async (tabId) => {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'RUN_AUTO_DETECT' });
      return res;
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }, pingResult.tabId);
  details.autoDetect = {
    ok: autoDetectResult && autoDetectResult.ok,
    structureCount: autoDetectResult && Array.isArray(autoDetectResult.structures) ? autoDetectResult.structures.length : 0
  };
  log.info('RUN_AUTO_DETECT result: ok=' + details.autoDetect.ok + ', structures found=' + details.autoDetect.structureCount);
  if (autoDetectResult && autoDetectResult.ok) {
    passed.push('F-extra. Real automatic field-detection engine ran against the real Etsy page (' + details.autoDetect.structureCount + ' structure(s) found)');
  } else {
    log.warn('AUTO-detect did not report ok:true — not treated as a hard failure (spec: "if it can SAFELY be triggered" — PING already proved real communication); recorded for diagnostics only: ' + JSON.stringify(autoDetectResult));
  }

  // Refresh the popup screenshot once more now that a real scrape target
  // exists in the tab set, purely for a more representative final artifact.
  await popupPage.screenshot({ path: path.join(ARTIFACT_DIR, 'popup.png'), fullPage: true, timeout: 60000 }).catch(() => {});

  details.consoleErrors = { etsyPage: consoleErrors, popupPage: popupConsoleErrors };
  if (consoleErrors.length) log.warn('Etsy page console errors observed: ' + JSON.stringify(consoleErrors.slice(0, 10)));
  if (popupConsoleErrors.length) log.warn('Popup page console errors observed: ' + JSON.stringify(popupConsoleErrors.slice(0, 10)));

  return { passed, details, etsyPage, popupPage };
}

module.exports = { run, ETSY_URL, ARTIFACT_DIR };
