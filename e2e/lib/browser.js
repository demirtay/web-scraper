/**
 * browser.js
 * Launches a REAL Chrome browser with the CURRENT unpacked ClickScrape
 * extension loaded from this repository — a genuinely separate,
 * temporary profile every run (never the user's real Chrome profile,
 * never reused/persisted across runs unless explicitly asked).
 *
 * Extension loading in Chromium requires a persistent context with
 * headless disabled (Playwright/Chromium do not support
 * --load-extension in classic headless mode) — this is a real technical
 * constraint, not a preference, so `headless` here only controls
 * whether the window is left open longer / slowed down for viewing, not
 * whether it renders at all. A visible window is a hard requirement of
 * this harness either way.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** A handful of well-known Windows install locations, checked ONLY as a
 * last-resort fallback if Playwright's own `channel: 'chrome'`
 * resolution fails for some reason — normally unnecessary, since
 * `channel: 'chrome'` already finds a real system Chrome install
 * without needing a hardcoded path (spec: "Do not unnecessarily
 * hardcode it" — same principle applied here to the browser binary,
 * not just the extension id). */
function fallbackChromePaths() {
  const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  return [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : null
  ].filter(Boolean);
}

/**
 * Launches Chrome with the extension loaded, in a fresh temp profile.
 * @param {{headless?: boolean, log: object}} opts
 * @returns {Promise<{context: import('playwright').BrowserContext, userDataDir: string, extensionPath: string, closeUp: Function}>}
 */
async function launchWithExtension(opts) {
  const log = opts.log;
  const extensionPath = REPO_ROOT;

  if (!fs.existsSync(path.join(extensionPath, 'manifest.json'))) {
    throw new Error('manifest.json not found at ' + extensionPath + ' — extension path is wrong.');
  }

  // A brand-new temp directory every run — this is the "completely
  // separate temporary/test Chrome profile" requirement. Never the
  // user's real profile (that lives under their normal Chrome user-data
  // dir, e.g. %LOCALAPPDATA%\Google\Chrome\User Data — never referenced
  // anywhere in this file).
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clickscrape-e2e-profile-'));
  log.info('Temp Chrome profile: ' + userDataDir);
  log.info('Extension path (unpacked, this repo): ' + extensionPath);

  const args = [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    // Predictable output regardless of the host machine's own locale —
    // a real, confirmed issue: without this, a real Etsy anti-bot
    // challenge page was once served in Turkish (matching this host's
    // locale) and the harness's own text-based challenge detection,
    // which only listed English phrases at the time, silently missed
    // it. DOM-structural detection (see e2e/tests/etsy-popup.test.js)
    // no longer depends on language at all, but a consistent locale
    // still makes every other observation reproducible across machines.
    '--lang=en-US'
  ];

  const launchOpts = {
    headless: false, // required for extension loading; see file header
    args,
    viewport: null,  // let the real OS window size drive the viewport, like a real user session
    ignoreDefaultArgs: ['--disable-extensions']
  };

  // BROWSER SELECTION — empirically determined, not a style preference:
  // Google Chrome STABLE channel (confirmed here on v151) now silently
  // ignores --load-extension/--disable-extensions-except entirely — a
  // real, documented Chrome anti-malware policy change (unpacked/
  // command-line extension loading on Stable now requires the profile's
  // OWN Developer Mode toggle to already be persisted, which a fresh
  // temp profile never has). Verified directly: launching with
  // channel:'chrome' produces a running browser with ZERO extensions
  // registered on chrome://extensions and no service worker — not a
  // flag/path mistake, the flag is simply not honored by that build.
  // Playwright's OWN bundled Chromium ("Chromium for Testing") has none
  // of Google Chrome-branded Stable's consumer policies applied and
  // loads --load-extension correctly — confirmed the same way. This is
  // squarely "use Playwright unless there is a strong technical reason
  // not to" (there is one, for real Chrome specifically): Playwright's
  // bundled browser IS the technically-correct choice for extension
  // automation today, not a fallback of last resort. Real installed
  // Chrome is still tried as a SECONDARY attempt below purely so a
  // future environment where this Chrome-Stable restriction is lifted
  // (or a Chrome build/policy without it) keeps working without a code
  // change — but it is expected, right now, to not actually register
  // the extension even if the browser itself launches.
  let context;
  let usedBrowser = 'playwright-bundled-chromium';
  try {
    context = await chromium.launchPersistentContext(userDataDir, launchOpts);
  } catch (e) {
    log.warn('Playwright bundled Chromium launch failed (' + e.message + ') — trying channel:"chrome" (real Google Chrome).');
    try {
      context = await chromium.launchPersistentContext(userDataDir, Object.assign({ channel: 'chrome' }, launchOpts));
      usedBrowser = 'chrome (channel)';
      log.warn('Launched via real Chrome — NOTE: current Chrome Stable versions are known to ignore --load-extension; verify the extension actually registered (this harness does, via detectExtensionId).');
    } catch (e2) {
      log.warn('channel:"chrome" also failed (' + e2.message + ') — trying fallback executablePath candidates.');
      const candidates = fallbackChromePaths();
      let launched = false;
      for (const exe of candidates) {
        if (!fs.existsSync(exe)) continue;
        try {
          context = await chromium.launchPersistentContext(userDataDir, Object.assign({ executablePath: exe }, launchOpts));
          usedBrowser = exe;
          launched = true;
          break;
        } catch (e3) { log.warn('  candidate failed: ' + exe + ' — ' + e3.message); }
      }
      if (!launched) {
        throw new Error('Could not launch ANY browser — neither Playwright\'s bundled Chromium (try `npx playwright install chromium`), nor real Chrome via channel, nor any known install-path candidate. This is a genuine environment blocker, not a code bug. ' + e.message);
      }
    }
  }
  log.info('Launched browser: ' + usedBrowser + ', headless=false, persistent context.');

  async function closeUp(deleteProfile) {
    try { await context.close(); } catch (e) { /* already closed */ }
    if (deleteProfile !== false) {
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* best-effort cleanup */ }
    }
  }

  return { context, userDataDir, extensionPath, closeUp };
}

/**
 * Detects the loaded extension's real, assigned ID programmatically —
 * never hardcoded. MV3 extensions register a background service worker
 * whose URL is chrome-extension://<id>/<service_worker path> the moment
 * Chrome loads them; Playwright surfaces that worker on the persistent
 * context. Falls back to waiting for the 'serviceworker' event if the
 * worker hasn't spun up yet at the moment this is called.
 */
async function detectExtensionId(context, log, timeoutMs) {
  let worker = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  if (!worker) {
    log.info('No service worker registered yet — waiting for it to spin up...');
    try {
      worker = await context.waitForEvent('serviceworker', { timeout: timeoutMs || 10000 });
    } catch (e) {
      return null;
    }
  }
  const m = worker.url().match(/^chrome-extension:\/\/([a-z]{32})\//);
  if (!m) return null;
  log.info('Detected extension ID: ' + m[1] + ' (from service worker URL ' + worker.url() + ')');
  return { id: m[1], serviceWorker: worker };
}

module.exports = { launchWithExtension, detectExtensionId, REPO_ROOT };
