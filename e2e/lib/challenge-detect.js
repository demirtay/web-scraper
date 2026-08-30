/**
 * challenge-detect.js
 * Shared CAPTCHA/anti-bot-challenge detector for real-site E2E scenarios.
 * Extracted from the markers/logic e2e/tests/etsy-popup.test.js proved
 * out first (see that file's own header comment for the real, confirmed
 * false-PASS history this design fixes: a challenge rendered in a
 * non-English locale, and later one that only ever appeared inside an
 * IFRAME the top-frame-only check couldn't see at all — both now
 * checked here). New site-acceptance scenarios (Amazon/eBay, etc.)
 * `require` this instead of re-declaring their own marker list.
 * etsy-popup.test.js itself is left exactly as-is (untouched, still
 * working) — this is purely additive shared infrastructure for tests
 * written after it.
 */
'use strict';

const CHALLENGE_TEXT_MARKERS = [
  'captcha', 'are you a robot', 'access to this page has been denied',
  'press and hold', 'press & hold', 'checking your browser', 'just a moment',
  'verify you are human', 'unusual traffic',
  'verification required', 'slide right to secure', 'unusual activity from your device',
  'automated (bot) activity', 'rapid taps or clicks',
  'robot değil', 'doğrulama gerekli', 'erişiminizi güvenceye alın',
  'no soy un robot', 'não sou um robô', 'je ne suis pas un robot',
  'ich bin kein roboter', 'nicht automatisiert',
  // Amazon/eBay-observed wording, added for the new site-acceptance
  // scenarios — kept in the SAME shared list rather than a second one,
  // so every real-site scenario benefits equally.
  'enter the characters you see below', 'sorry, we just need to make sure',
  "to discuss automated access to amazon data", 'robot check',
  'pardon our interruption', "we've detected unusual traffic"
];

const CHALLENGE_DOM_SELECTORS = [
  'iframe[src*="recaptcha" i]', 'iframe[title*="recaptcha" i]',
  'iframe[src*="hcaptcha" i]', '#px-captcha', '[id*="captcha" i]',
  '[class*="captcha" i]', 'iframe[src*="challenges.cloudflare" i]',
  '[id*="px-" i]', '[class*="px-" i]'
];

/**
 * Checks every frame of a real Playwright `page` (not just the top
 * frame — a real, previously-confirmed miss otherwise) for a known
 * anti-bot/CAPTCHA DOM signature or text marker.
 * @param {import('playwright').Page} page
 * @returns {Promise<{hit: string|null, framesChecked: number}>}
 */
async function detectChallenge(page) {
  let bodyTextSample = '';
  let domHit = null;
  for (const frame of page.frames()) {
    try {
      const frameText = await frame.evaluate(() => document.body ? document.body.innerText.slice(0, 3000).toLowerCase() : '');
      bodyTextSample += ' ' + frameText;
    } catch (e) { /* frame navigated away/detached/inaccessible — skip, not fatal */ }
    if (!domHit) {
      try {
        const hit = await frame.evaluate((selectors) => {
          for (const sel of selectors) { try { if (document.querySelector(sel)) return sel; } catch (e) { /* invalid selector in this engine */ } }
          return null;
        }, CHALLENGE_DOM_SELECTORS);
        if (hit) domHit = hit;
      } catch (e) { /* same as above */ }
    }
  }
  const pageTitle = await page.title().catch(() => '');
  const textHit = CHALLENGE_TEXT_MARKERS.find((m) => bodyTextSample.includes(m) || pageTitle.toLowerCase().includes(m));
  const hit = domHit ? ('DOM selector "' + domHit + '" (frame)') : (textHit ? ('text "' + textHit + '" (frame)') : null);
  return { hit, framesChecked: page.frames().length };
}

/** Throws a properly-flagged external-blocker Error (err.isExternalBlocker
 * = true, per CLAUDE.md's BLOCKED_BY_SITE convention) if a challenge was
 * detected; no-ops otherwise. `details` (optional) is attached to the
 * thrown error for evidence capture. */
async function assertNoChallenge(page, siteLabel, details) {
  const result = await detectChallenge(page);
  if (result.hit) {
    const err = new Error('EXTERNAL BLOCKER (BLOCKED_BY_SITE): ' + siteLabel + ' served an anti-bot challenge/CAPTCHA page (matched ' + result.hit + ') instead of real content. This requires human interaction and cannot be bypassed — per CLAUDE.md, this harness does not attempt to.');
    err.isExternalBlocker = true;
    err.details = Object.assign({}, details, { framesChecked: result.framesChecked });
    throw err;
  }
  return result;
}

module.exports = { CHALLENGE_TEXT_MARKERS, CHALLENGE_DOM_SELECTORS, detectChallenge, assertNoChallenge };
