/**
 * amazon-pagination-fix.test.js (FAST/local, no browser)
 * AMAZON PAGINATION FIX mission — real production report: a real Amazon
 * search run (https://www.amazon.com/s?k=desk+lamp, visible working
 * Previous | 1 | 2 | 3 | ... | 7 | Next pagination) collected 167 unique
 * records then stopped at "1 sayfa tarandı" instead of continuing to
 * page 2+.
 *
 * ROOT CAUSE (content/nextdetect.js): `pointsAtHigherPage()` — the Tier 4
 * href-page-number fallback — required BOTH the current AND candidate
 * URL to already carry an explicit page-number parameter/path before
 * comparing them. A page 1 whose URL omits the parameter entirely
 * (`?k=desk+lamp`, no `&page=1`) — one of the single most common
 * real-world pagination conventions, not an Amazon-specific quirk — could
 * therefore never be recognized as "before" a candidate explicitly
 * carrying `&page=2`. A second, related gap: Tier 3's pagination-landmark
 * detection only ever searched a landmark's DESCENDANTS
 * (`landmark.querySelectorAll('a[href], button')`), so a real, common
 * pattern where the Next control's OWN class contains "pagination"
 * (rather than a separate wrapping element) was never checked against
 * itself.
 *
 * This file loads the REAL, unmodified content/nextdetect.js against
 * realistic fixture markup built with tests/lib/mini-dom.js (see that
 * file's own header for why a hand-rolled DOM stub was used instead of
 * jsdom). Standalone-runnable: `node tests/unit/amazon-pagination-fix.test.js`.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createMiniDocument, el } = require('../lib/mini-dom');
const { makeSuite } = require('../lib/assert');
const { loadPopup } = require('../lib/load-popup');

const NEXTDETECT_PATH = path.join(__dirname, '..', '..', 'content', 'nextdetect.js');
const POPUP_JS_PATH = path.join(__dirname, '..', '..', 'popup', 'popup.js');
const POPUP_HTML_PATH = path.join(__dirname, '..', '..', 'popup', 'popup.html');

/** Loads the real nextdetect.js into a fresh sandbox backed by a fresh
 * mini-DOM + a given `location` (href/hostname/pathname/search), so each
 * test case gets a clean, independent WSNextDetect + document pair. */
function loadNextDetect(locationHref) {
  var url = new URL(locationHref);
  var dom = createMiniDocument();
  var sandbox = {
    console: console, URL: URL, URLSearchParams: URLSearchParams,
    document: dom.document,
    location: { href: url.href, hostname: url.hostname, pathname: url.pathname, search: url.search },
    window: null
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  var code = fs.readFileSync(NEXTDETECT_PATH, 'utf8');
  vm.runInContext(code, sandbox, { filename: NEXTDETECT_PATH });
  return { WSNextDetect: sandbox.WSNextDetect, dom: dom };
}

async function settle(ticks) {
  for (var i = 0; i < (ticks || 30); i++) await new Promise(function (r) { setTimeout(r, 0); });
}

async function run() {
  const suite = makeSuite('amazon-pagination-fix');
  const assert = suite.assert;
  const popupJs = fs.readFileSync(POPUP_JS_PATH, 'utf8');
  const popupHtml = fs.readFileSync(POPUP_HTML_PATH, 'utf8');

  // ============================================================
  // TASK A — obsolete checkboxes genuinely removed, BAŞLA unaffected
  // ============================================================
  {
    assert(popupHtml.indexOf('id="auto-next-toggle"') === -1, 'MISSION PROOF: #auto-next-toggle ("Otomatik Sonraki") no longer exists in popup.html');
    assert(popupHtml.indexOf('id="auto-scroll-toggle"') === -1, 'MISSION PROOF: #auto-scroll-toggle ("Otomatik Kaydırma") no longer exists in popup.html');
    assert(popupJs.indexOf("getElementById('auto-next-toggle')") === -1, 'MISSION PROOF: popup.js no longer maps #auto-next-toggle');
    assert(popupJs.indexOf("getElementById('auto-scroll-toggle')") === -1, 'MISSION PROOF: popup.js no longer maps #auto-scroll-toggle');
    assert(popupJs.indexOf('els.autoNextToggle') === -1, 'MISSION PROOF: popup.js no longer references els.autoNextToggle anywhere');
    assert(popupJs.indexOf('els.autoScrollToggle') === -1, 'MISSION PROOF: popup.js no longer references els.autoScrollToggle anywhere');

    // Real execution: BAŞLA still starts a live session + Discovery with
    // NO opt-in checkbox involved at all (the elements plainly cannot be
    // read since they no longer exist — this proves the real handler
    // path still works end-to-end, not just that the strings are gone).
    var sentToContent = [];
    var sb = await loadPopup({
      tabUrl: 'https://example.com/',
      seedLocalStorage: { 'ws_state::example.com': { containerSelector: '.item', columns: [{ id: 'c1', name: 'Title', relativeSelector: 'h1', attribute: 'text' }] } },
      sendMessageImpl: function (t, m) { sentToContent.push(m.type); return { ok: true, rows: [{ c1: 'Row 1' }], containerMigration: null }; }
    });
    await settle(30);
    sb.clickBasla();
    await settle(60);
    assert(sentToContent.indexOf('RUN_EXTRACTION') !== -1, 'MISSION PROOF: BAŞLA still performs the real extraction with the checkboxes gone');
    assert(sentToContent.indexOf('START_DISCOVERY') !== -1, 'MISSION PROOF: BAŞLA still starts the automatic Discovery engine with no checkbox opt-in required');
  }

  // ============================================================
  // TASK C — generic Next-control detection fixes
  // ============================================================

  // ---- 2. Standard enabled Next pagination (regression baseline —
  // exact accessible-name match, Tier 2, completely unmodified) ----
  {
    var loaded = loadNextDetect('https://shop.example.com/listings?page=2');
    var nav = el('nav', { 'aria-label': 'Pagination' });
    var prevA = el('a', { href: '/listings?page=1' }, 'Previous');
    var nextA = el('a', { href: '/listings?page=3' }, 'Next');
    nav.appendChild(prevA); nav.appendChild(nextA);
    loaded.dom.body.appendChild(nav);
    var res = loaded.WSNextDetect.findNextControl(null);
    assert(res.found === true, 'MISSION PROOF: a standard, exact "Next" link is still found (Tier 2 unmodified) — got ' + JSON.stringify(res));
    assert(res.disabled === false, 'a real enabled Next is reported as not disabled');
    assert(res.method === 'accessible-name', 'matched via the exact accessible-name tier — got ' + res.method);
  }

  // ---- 3. Disabled/final Next stops correctly (regression baseline) ----
  {
    var loaded = loadNextDetect('https://shop.example.com/listings?page=7');
    var nav = el('nav', { 'aria-label': 'Pagination' });
    var nextA = el('a', { href: '/listings?page=8', 'aria-disabled': 'true' }, 'Next');
    nav.appendChild(nextA);
    loaded.dom.body.appendChild(nav);
    var res = loaded.WSNextDetect.findNextControl(null);
    assert(res.found === true && res.disabled === true, 'MISSION PROOF: a disabled Next is found but correctly reported disabled — got ' + JSON.stringify(res));
  }

  // ---- No candidate at all -> found:false (regression baseline) ----
  {
    var loaded = loadNextDetect('https://shop.example.com/listings');
    loaded.dom.body.appendChild(el('p', {}, 'No more results.'));
    var res = loaded.WSNextDetect.findNextControl(null);
    assert(res.found === false, 'MISSION PROOF: a page with no pagination control at all correctly reports found:false');
  }

  // ---- 7. Amazon-like pagination markup, generically detected ----
  // (root cause #1 — implicit page 1, no page param on the CURRENT url —
  // href-page-number fallback, Tier 4). The candidate deliberately has
  // NO "next"-ish accessible name and NO "pagination"-flavored class
  // anywhere (a plain numbered page-2 link, matching this tier's own
  // documented "fallback only" scope) so this test can only pass via the
  // Tier 4 fix actually being effective, not by accident via Tier 2/3.
  {
    var loaded = loadNextDetect('https://www.amazon.example/s?k=desk+lamp'); // NOTE: not a real amazon.com fetch — a same-shaped fixture URL, same hostname as the candidate href below
    loaded.dom.body.appendChild(el('a', { href: '/s?k=desk+lamp&page=2', class: 'plain-page-link' }, '2'));
    var res = loaded.WSNextDetect.findNextControl(null);
    assert(res.found === true, 'MISSION PROOF: an implicit-page-1 -> explicit-page-2 href is now detected generically (Tier 4 fix) — got ' + JSON.stringify(res));
    assert(res.method === 'href-page-number', 'matched via the href-page-number fallback tier — got ' + res.method);
  }

  // ---- root cause #2 — a real Next control whose OWN class contains
  // "pagination" (not a separate wrapper), accessible name "Go to next
  // page" (contains "next" as a whole word — matches Tier 3's LOOSE
  // check, but not Tier 2's EXACT check), and an href that does NOT
  // carry a recognizable page-number pattern at all (isolates the Tier-3
  // self-inclusion fix from the Tier-4 fix above — this candidate can
  // ONLY be found via Tier 3). ----
  {
    var loaded = loadNextDetect('https://shop.example.com/catalog');
    var nextLink = el('a', { href: '/catalog/more-results', class: 'results-pagination-next', 'aria-label': 'Go to next page' });
    loaded.dom.body.appendChild(nextLink);
    var res = loaded.WSNextDetect.findNextControl(null);
    assert(res.found === true, 'MISSION PROOF: a Next control whose own class (not a wrapper) contains "pagination" is now found (Tier 3 self-inclusion fix) — got ' + JSON.stringify(res));
    assert(res.method === 'pagination-landmark', 'matched via the pagination-landmark tier — got ' + res.method);
  }

  // ---- 8. No duplicate-page loop introduced by the Tier 4 fix — a
  // candidate href pointing at the SAME implicit page (no page param at
  // all) must never be treated as "next". ----
  {
    var loaded = loadNextDetect('https://shop.example.com/catalog');
    // A self-referential/"current page" link with no page param and no
    // recognizable Next signal at all.
    loaded.dom.body.appendChild(el('a', { href: '/catalog', class: 'unrelated-widget-next' }, 'Refresh'));
    var res = loaded.WSNextDetect.findNextControl(null);
    assert(res.found === false, 'MISSION PROOF: a same-page link with no page param is never mistaken for "next" — got ' + JSON.stringify(res));
  }

  // ---- No duplicate-page loop — candidate href explicitly repeats the
  // CURRENT page number (already-paginated site, page 2 of 2, a
  // self-link back to page 2) must never be treated as "next" either. ----
  {
    var loaded = loadNextDetect('https://shop.example.com/listings?page=2');
    loaded.dom.body.appendChild(el('a', { href: '/listings?page=2', class: 'current-pagination-link' }, '2'));
    var res = loaded.WSNextDetect.findNextControl(null);
    assert(res.found === false, 'MISSION PROOF: a same-page-number link (page=2 -> page=2) is never mistaken for "next" — got ' + JSON.stringify(res));
  }

  // ---- Container-selector exclusion still works (unmodified rule):
  // a "next"-like control that lives INSIDE the scraper's own repeating
  // card is never eligible, however strong its other signals look. ----
  {
    var loaded = loadNextDetect('https://shop.example.com/listings');
    var card = el('div', { class: 'product-card' });
    card.appendChild(el('a', { href: '/listings?page=2' }, 'Next')); // e.g. a per-card "view next image" control, not real site pagination
    loaded.dom.body.appendChild(card);
    var res = loaded.WSNextDetect.findNextControl('.product-card');
    assert(res.found === false, 'MISSION PROOF: a Next-shaped control inside the scraper\'s own container selector is still correctly rejected — got ' + JSON.stringify(res));
  }

  // ---- Combined, closer-to-the-real-report fixture: a full Previous |
  // 1 | 2 | 3 | ... | 7 | Next strip, implicit page 1 (no `page` param
  // on the current URL, exactly as reported), Next control's own class
  // containing "pagination", bare-arrow-only visible content. Whichever
  // specific tier ends up matching first, the end result must be
  // found:true, not the reported found:false/no-more-mechanisms. ----
  {
    var loaded = loadNextDetect('https://www.amazon.example/s?k=desk+lamp');
    var strip = el('span', { class: 's-pagination-strip', 'aria-label': 'pagination' });
    strip.appendChild(el('span', { class: 's-pagination-item s-pagination-previous s-pagination-disabled' }, 'Previous'));
    strip.appendChild(el('span', { class: 's-pagination-item s-pagination-selected' }, '1'));
    [2, 3].forEach(function (n) { strip.appendChild(el('a', { href: '/s?k=desk+lamp&page=' + n, class: 's-pagination-item' }, String(n))); });
    strip.appendChild(el('span', { class: 's-pagination-item s-pagination-ellipsis' }, '…'));
    strip.appendChild(el('a', { href: '/s?k=desk+lamp&page=7', class: 's-pagination-item' }, '7'));
    strip.appendChild(el('a', { href: '/s?k=desk+lamp&page=2', class: 's-pagination-item s-pagination-next' }, '»'));
    loaded.dom.body.appendChild(strip);
    var res = loaded.WSNextDetect.findNextControl(null);
    assert(res.found === true && res.disabled !== true, 'MISSION PROOF: the full reported "Previous | 1 | 2 | 3 | ... | 7 | Next" shape, page 1 implicit, is now found and enabled — got ' + JSON.stringify(res));
  }

  // ---- 6. Existing Etsy-shaped fixture still passes (Tier 1, rel="next") ----
  {
    var loaded = loadNextDetect('https://www.etsy.example/search?q=lamp&page=1');
    loaded.dom.body.appendChild(el('a', { href: '/search?q=lamp&page=2', rel: 'next' }, 'Next results'));
    var res = loaded.WSNextDetect.findNextControl(null);
    assert(res.found === true && res.method === 'rel-next', 'MISSION PROOF: an explicit rel="next" link (Tier 1) is still found first, unaffected by this pass — got ' + JSON.stringify(res));
  }

  return suite.summarize();
}

if (require.main === module) {
  run().then(function (result) { process.exit(result.failures ? 1 : 0); })
    .catch(function (e) { console.error('CRASHED:', e.stack || e); process.exit(1); });
}

module.exports = { run: run };
