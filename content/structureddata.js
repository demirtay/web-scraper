/**
 * structureddata.js (V1.21)
 * Detects and parses structured data ALREADY embedded in the page —
 * JSON-LD (<script type="application/ld+json">) and common metadata
 * (document title, meta description, canonical URL, Open Graph, Twitter
 * Card) — and exposes it two ways:
 *   1. getSnapshot() — a normalized, page-level snapshot of everything
 *      found, safe to compute repeatedly and safe against malformed
 *      JSON-LD (a bad block is recorded in `errors` and skipped; it
 *      never throws and never aborts the rest of the scan).
 *   2. detectFields(snapshot) — a flat list of user-pickable field
 *      candidates (name/path/sampleValue) covering the common schema.org
 *      types spec #2 names, for the popup's Structured Data inspector.
 *   3. getValueAtPath(snapshot, path) — resolves one candidate's path
 *      against a (possibly different, later) page's live snapshot —
 *      this is what content/scraper.js calls at actual extraction time.
 *
 * Deliberately supplements, never replaces, DOM/selector extraction
 * (spec: "structured data supplements DOM extraction; it does not
 * replace it") — nothing here ever touches WSSelector's own selector-
 * based extraction path, and a page with zero/broken structured data
 * simply yields an empty snapshot, never a crash and never a fabricated
 * value (spec: "do not silently invent values when structured data is
 * absent").
 */
(function (root) {
  'use strict';

  var Sel = root.WSSelector;

  // =====================================================================
  // JSON-LD parsing — spec #1.
  // =====================================================================

  var MAX_GRAPH_DEPTH = 6; // defends against pathological/malicious nesting; real pages never need more than 1-2

  function collectEntities(parsed, out, depth) {
    if (depth > MAX_GRAPH_DEPTH) return;
    if (Array.isArray(parsed)) {
      parsed.forEach(function (item) { collectEntities(item, out, depth + 1); });
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    if (Array.isArray(parsed['@graph'])) {
      // A pure @graph wrapper's own top-level keys (@context etc.) aren't
      // a usable entity by themselves — only what's inside @graph is.
      collectEntities(parsed['@graph'], out, depth + 1);
      return;
    }
    out.push(parsed);
  }

  /** Never throws. Every block is parsed independently — one malformed
   * <script> never prevents the others (or the rest of the scrape) from
   * working (spec: "never crash the scrape because one structured-data
   * block is invalid"). */
  function parseJsonLdBlocks() {
    var scripts;
    try {
      scripts = document.querySelectorAll('script[type="application/ld+json"]');
    } catch (e) {
      return { entities: [], errors: [{ blockIndex: -1, error: String(e && e.message || e) }] };
    }
    var entities = [];
    var errors = [];
    Array.prototype.forEach.call(scripts, function (script, idx) {
      var text = script.textContent || '';
      if (!text.trim()) return;
      var parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        errors.push({ blockIndex: idx, error: 'Invalid JSON: ' + String(e && e.message || e) });
        return;
      }
      try {
        collectEntities(parsed, entities, 0);
      } catch (e) {
        errors.push({ blockIndex: idx, error: 'Unexpected structure: ' + String(e && e.message || e) });
      }
    });
    return { entities: entities, errors: errors };
  }

  // =====================================================================
  // Metadata — spec #4.
  // =====================================================================

  function metaContent(nameOrProperty) {
    var el;
    try {
      el = document.querySelector('meta[name="' + nameOrProperty + '"], meta[property="' + nameOrProperty + '"]');
    } catch (e) {
      el = null;
    }
    return el ? (el.getAttribute('content') || '').trim() : '';
  }

  function absoluteOrEmpty(url) {
    if (!url) return '';
    try { return Sel && Sel.resolveUrl ? Sel.resolveUrl(url) : url; } catch (e) { return url; }
  }

  function parseMetaTags() {
    var canonicalEl;
    try { canonicalEl = document.querySelector('link[rel="canonical"]'); } catch (e) { canonicalEl = null; }
    return {
      title: (document.title || '').trim(),
      description: metaContent('description'),
      canonical: canonicalEl ? absoluteOrEmpty(canonicalEl.getAttribute('href') || '') : '',
      og: {
        title: metaContent('og:title'),
        description: metaContent('og:description'),
        image: absoluteOrEmpty(metaContent('og:image')),
        url: absoluteOrEmpty(metaContent('og:url')),
        siteName: metaContent('og:site_name'),
        type: metaContent('og:type')
      },
      twitter: {
        card: metaContent('twitter:card'),
        title: metaContent('twitter:title'),
        description: metaContent('twitter:description'),
        image: absoluteOrEmpty(metaContent('twitter:image'))
      },
      author: metaContent('author'),
      keywords: metaContent('keywords')
    };
  }

  function getSnapshot() {
    return { jsonLd: parseJsonLdBlocks(), meta: parseMetaTags() };
  }

  // =====================================================================
  // Generic path resolution — used both by detectFields (to compute a
  // preview sampleValue) and by scraper.js at real extraction time
  // (against whatever page is live THEN, which may differ from the page
  // the field was originally picked on — e.g. a different detail page
  // during Deep Scraping). A path segment is either `.key` or `[n]`.
  // Never throws; a missing/mismatched segment resolves to undefined.
  // =====================================================================

  function typesOf(entity) {
    var t = entity && entity['@type'];
    if (!t) return [];
    return Array.isArray(t) ? t : [t];
  }

  function hasType(entity, typeName) {
    return typesOf(entity).some(function (t) { return String(t).toLowerCase() === typeName.toLowerCase(); });
  }

  function walkPath(root, path) {
    if (!path) return undefined;
    var segments = [];
    path.split('.').forEach(function (part) {
      var m = part.match(/^([^\[\]]*)((?:\[\d+\])*)$/);
      if (!m) { segments.push(part); return; }
      if (m[1]) segments.push(m[1]);
      var idxMatches = m[2] ? m[2].match(/\[\d+\]/g) : null;
      if (idxMatches) idxMatches.forEach(function (im) { segments.push(parseInt(im.slice(1, -1), 10)); });
    });
    var cur = root;
    for (var i = 0; i < segments.length; i++) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[segments[i]];
    }
    return cur;
  }

  /** Normalizes a value that may be a plain leaf, an array (use the
   * first element), or a nested object with a common "the real value is
   * in here" shape (ImageObject.url/contentUrl, an entity with .name)
   * into a single primitive — never fabricates, only unwraps a value
   * that's genuinely already there. */
  function flattenToLeaf(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.length ? flattenToLeaf(value[0]) : '';
    if (typeof value === 'object') {
      if (typeof value.url === 'string') return value.url;
      if (typeof value.contentUrl === 'string') return value.contentUrl;
      if (typeof value.name === 'string') return value.name;
      return '';
    }
    return value;
  }

  function buildBreadcrumbTrail(entity) {
    var items = entity && Array.isArray(entity.itemListElement) ? entity.itemListElement.slice() : [];
    items.sort(function (a, b) { return (a && a.position || 0) - (b && b.position || 0); });
    var names = items.map(function (it) {
      if (!it) return '';
      if (typeof it.name === 'string') return it.name;
      if (it.item && typeof it.item.name === 'string') return it.item.name;
      return '';
    }).filter(Boolean);
    return names.join(' > ');
  }

  function buildFaqSummary(entity) {
    var qs = entity && Array.isArray(entity.mainEntity) ? entity.mainEntity : [];
    var pairs = qs.map(function (q) {
      if (!q || typeof q.name !== 'string') return null;
      var answer = q.acceptedAnswer && typeof q.acceptedAnswer.text === 'string' ? q.acceptedAnswer.text : '';
      return answer ? (q.name + ': ' + answer) : q.name;
    }).filter(Boolean);
    return pairs.join(' | ');
  }

  /** V1.22 (Directory template): a PostalAddress is multi-part, so —
   * same spirit as the breadcrumb trail — this is a single, honest
   * derived field joining whichever real parts are present, never
   * fabricating a missing part. A plain string `address` (some sites
   * skip the structured PostalAddress entirely) is returned as-is. */
  function buildAddressLine(entity) {
    var addr = entity && entity.address;
    if (!addr) return '';
    if (typeof addr === 'string') return addr;
    var parts = [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode].filter(function (p) { return typeof p === 'string' && p; });
    return parts.join(', ');
  }

  /** Resolves ONE candidate path against a (possibly freshly-computed)
   * snapshot. `derived.*` paths are recomputed live from the raw
   * entities every call, never cached from pick time — correct even
   * when the same saved column later runs against a DIFFERENT page
   * (Deep Scraping's whole point). Always returns a string (never
   * throws, never null/undefined) — '' means "not present on this
   * page", exactly like a DOM selector matching nothing. */
  function getValueAtPath(snapshot, path) {
    if (!snapshot || !path) return '';
    try {
      if (path === 'meta.title') return snapshot.meta.title || '';
      if (path.indexOf('meta.') === 0) {
        var v = walkPath(snapshot.meta, path.slice('meta.'.length));
        return flattenToLeaf(v) || '';
      }
      if (path.indexOf('derived.breadcrumb') === 0) {
        var bc = (snapshot.jsonLd.entities || []).filter(function (e) { return hasType(e, 'BreadcrumbList'); })[0];
        return bc ? buildBreadcrumbTrail(bc) : '';
      }
      if (path.indexOf('derived.faq') === 0) {
        var faq = (snapshot.jsonLd.entities || []).filter(function (e) { return hasType(e, 'FAQPage'); })[0];
        return faq ? buildFaqSummary(faq) : '';
      }
      if (path.indexOf('derived.address.') === 0) {
        var addrEntityIndex = parseInt(path.slice('derived.address.'.length), 10);
        var addrEntity = (snapshot.jsonLd.entities || [])[addrEntityIndex];
        return addrEntity ? buildAddressLine(addrEntity) : '';
      }
      if (path.indexOf('jsonLd.') === 0) {
        var rest = path.slice('jsonLd.'.length); // "<entityIndex>.<dotted.path>"
        var dot = rest.indexOf('.');
        var entityIndex = parseInt(dot === -1 ? rest : rest.slice(0, dot), 10);
        var subPath = dot === -1 ? '' : rest.slice(dot + 1);
        var entity = (snapshot.jsonLd.entities || [])[entityIndex];
        if (!entity) return '';
        var raw = subPath ? walkPath(entity, subPath) : entity;
        var leaf = flattenToLeaf(raw);
        if ((subPath.indexOf('image') !== -1 || subPath === 'url' || subPath === 'logo') && typeof leaf === 'string') {
          return absoluteOrEmpty(leaf);
        }
        return leaf === undefined || leaf === null ? '' : String(leaf);
      }
    } catch (e) {
      return ''; // never throw at extraction time — a bad path resolves to empty, same as a DOM selector matching nothing
    }
    return '';
  }

  // =====================================================================
  // Field candidate detection — spec #2/#3. A small, config-driven table
  // of simple leaf fields per schema.org type, plus a few genuinely
  // special-shaped ones (offers/aggregateRating/breadcrumb/faq) that
  // don't fit a flat key->label table.
  // =====================================================================

  var SIMPLE_TYPE_FIELDS = {
    Product: [['name', 'Name'], ['description', 'Description'], ['sku', 'SKU'], ['url', 'URL'], ['category', 'Category']],
    Article: [['headline', 'Headline'], ['description', 'Description'], ['datePublished', 'Date Published'], ['dateModified', 'Date Modified']],
    NewsArticle: [['headline', 'Headline'], ['description', 'Description'], ['datePublished', 'Date Published'], ['dateModified', 'Date Modified']],
    Organization: [['name', 'Name'], ['url', 'URL'], ['telephone', 'Telephone'], ['email', 'Email']],
    Person: [['name', 'Name'], ['jobTitle', 'Job Title'], ['url', 'URL']],
    LocalBusiness: [['name', 'Name'], ['telephone', 'Telephone'], ['priceRange', 'Price Range'], ['url', 'URL']],
    Event: [['name', 'Name'], ['startDate', 'Start Date'], ['endDate', 'End Date'], ['eventStatus', 'Status']],
    WebPage: [['name', 'Name'], ['description', 'Description'], ['url', 'URL'], ['datePublished', 'Date Published'], ['dateModified', 'Date Modified']],
    Review: [['reviewBody', 'Review Text'], ['datePublished', 'Date Published']],
    AggregateRating: [['ratingValue', 'Rating Value'], ['reviewCount', 'Review Count'], ['ratingCount', 'Rating Count'], ['bestRating', 'Best Rating']],
    // V1.22 additive (Job Listings template, spec #2/#3) — same
    // config-driven pattern as every other type here; JobPosting's own
    // nested hiringOrganization/jobLocation/baseSalary are handled by
    // detectJobFields below, the same way Product's nested offers/
    // aggregateRating/brand already are.
    JobPosting: [['title', 'Job Title'], ['description', 'Description'], ['datePosted', 'Date Posted'], ['employmentType', 'Employment Type'], ['validThrough', 'Valid Through']]
  };
  // Image/URL-typed leaf keys, used to give the UI/download-button logic
  // an honest hint about what KIND of value a candidate resolves to —
  // never used to alter the raw value itself.
  var IMAGE_KEYS = { image: true, logo: true };
  var URL_KEYS = { url: true };

  function kindForKey(key) {
    if (IMAGE_KEYS[key]) return 'image';
    if (URL_KEYS[key]) return 'url';
    return 'text';
  }

  function pushIfPresent(out, entity, entityIndex, key, label, groupLabel) {
    var raw = entity[key];
    if (raw === undefined || raw === null || raw === '') return;
    var leaf = flattenToLeaf(raw);
    if (leaf === '' || leaf === undefined) return;
    out.push({
      path: 'jsonLd.' + entityIndex + '.' + key,
      label: label,
      group: groupLabel,
      kind: kindForKey(key),
      sampleValue: String(leaf).slice(0, 120)
    });
  }

  function detectOfferFields(out, entity, entityIndex, groupLabel) {
    var offers = entity.offers;
    if (!offers) return;
    var offer = Array.isArray(offers) ? offers[0] : offers;
    if (!offer || typeof offer !== 'object') return;
    var base = 'jsonLd.' + entityIndex + '.offers' + (Array.isArray(offers) ? '[0]' : '');
    if (hasType(offer, 'AggregateOffer')) {
      [['lowPrice', 'Low Price'], ['highPrice', 'High Price'], ['priceCurrency', 'Price Currency'], ['offerCount', 'Offer Count']].forEach(function (pair) {
        if (offer[pair[0]] !== undefined && offer[pair[0]] !== null && offer[pair[0]] !== '') {
          out.push({ path: base + '.' + pair[0], label: pair[1], group: groupLabel, kind: 'text', sampleValue: String(offer[pair[0]]).slice(0, 120) });
        }
      });
    } else {
      [['price', 'Price'], ['priceCurrency', 'Price Currency'], ['availability', 'Availability'], ['itemCondition', 'Item Condition']].forEach(function (pair) {
        if (offer[pair[0]] !== undefined && offer[pair[0]] !== null && offer[pair[0]] !== '') {
          out.push({ path: base + '.' + pair[0], label: pair[1], group: groupLabel, kind: 'text', sampleValue: String(offer[pair[0]]).slice(0, 120) });
        }
      });
    }
  }

  function detectRatingFields(out, entity, entityIndex, groupLabel) {
    var rating = entity.aggregateRating;
    if (!rating || typeof rating !== 'object') return;
    [['ratingValue', 'Rating Value'], ['reviewCount', 'Review Count'], ['ratingCount', 'Rating Count'], ['bestRating', 'Best Rating']].forEach(function (pair) {
      if (rating[pair[0]] !== undefined && rating[pair[0]] !== null && rating[pair[0]] !== '') {
        out.push({ path: 'jsonLd.' + entityIndex + '.aggregateRating.' + pair[0], label: pair[1], group: groupLabel, kind: 'text', sampleValue: String(rating[pair[0]]).slice(0, 120) });
      }
    });
  }

  function detectBrandField(out, entity, entityIndex, groupLabel) {
    var brand = entity.brand;
    if (!brand) return;
    var leaf = flattenToLeaf(brand);
    if (!leaf) return;
    var path = typeof brand === 'object' ? 'jsonLd.' + entityIndex + '.brand.name' : 'jsonLd.' + entityIndex + '.brand';
    out.push({ path: path, label: 'Brand', group: groupLabel, kind: 'text', sampleValue: String(leaf).slice(0, 120) });
  }

  function detectImageField(out, entity, entityIndex, groupLabel) {
    if (entity.image === undefined || entity.image === null || entity.image === '') return;
    var leaf = flattenToLeaf(entity.image);
    if (!leaf) return;
    out.push({ path: 'jsonLd.' + entityIndex + '.image', label: 'Image', group: groupLabel, kind: 'image', sampleValue: absoluteOrEmpty(String(leaf)).slice(0, 160) });
  }

  function detectAuthorPublisher(out, entity, entityIndex, groupLabel) {
    ['author', 'publisher'].forEach(function (key) {
      var v = entity[key];
      if (!v) return;
      var leaf = flattenToLeaf(v);
      if (!leaf) return;
      var path = typeof v === 'object' ? 'jsonLd.' + entityIndex + '.' + key + '.name' : 'jsonLd.' + entityIndex + '.' + key;
      out.push({ path: path, label: key === 'author' ? 'Author' : 'Publisher', group: groupLabel, kind: 'text', sampleValue: String(leaf).slice(0, 120) });
    });
  }

  /** V1.22: a field nested arbitrarily deep inside an entity (e.g.
   * hiringOrganization.name, jobLocation.address.addressLocality) —
   * generalizes pushIfPresent for shapes deeper than one level, reusing
   * the exact same walkPath/flattenToLeaf getValueAtPath already relies
   * on, so the candidate's path is guaranteed re-resolvable later. */
  function pushNestedIfPresent(out, entity, entityIndex, dottedPath, label, groupLabel) {
    var raw = walkPath(entity, dottedPath);
    var leaf = flattenToLeaf(raw);
    if (leaf === '' || leaf === undefined || leaf === null) return;
    out.push({ path: 'jsonLd.' + entityIndex + '.' + dottedPath, label: label, group: groupLabel, kind: 'text', sampleValue: String(leaf).slice(0, 120) });
  }

  /** V1.22 (Job Listings template): JobPosting's own nested shape —
   * hiringOrganization (Organization|string), jobLocation (Place, with
   * a PostalAddress inside), baseSalary (MonetaryAmount, sometimes
   * wrapping a nested QuantitativeValue.value). Every lookup is
   * optional-chained defensively; a real-world JobPosting missing any
   * of these simply doesn't offer that candidate — never fabricated. */
  function detectJobFields(out, entity, entityIndex, groupLabel) {
    if (typeof entity.hiringOrganization === 'string') {
      pushIfPresent(out, entity, entityIndex, 'hiringOrganization', 'Company', groupLabel);
    } else {
      pushNestedIfPresent(out, entity, entityIndex, 'hiringOrganization.name', 'Company', groupLabel);
    }
    pushNestedIfPresent(out, entity, entityIndex, 'jobLocation.address.addressLocality', 'Location', groupLabel);
    if (!(entity.jobLocation && entity.jobLocation.address && entity.jobLocation.address.addressLocality)) {
      // fall back to a plain string jobLocation, or Place.name, if the full PostalAddress shape isn't present
      pushNestedIfPresent(out, entity, entityIndex, 'jobLocation.name', 'Location', groupLabel);
      if (typeof entity.jobLocation === 'string') pushIfPresent(out, entity, entityIndex, 'jobLocation', 'Location', groupLabel);
    }
    var salaryValue = walkPath(entity, 'baseSalary.value.value');
    if (salaryValue === undefined || salaryValue === null || salaryValue === '') {
      pushNestedIfPresent(out, entity, entityIndex, 'baseSalary.value', 'Salary', groupLabel);
    } else {
      pushNestedIfPresent(out, entity, entityIndex, 'baseSalary.value.value', 'Salary', groupLabel);
    }
    pushNestedIfPresent(out, entity, entityIndex, 'baseSalary.currency', 'Salary Currency', groupLabel);
  }

  /** V1.22 (Directory template): Organization/LocalBusiness's address —
   * exposed as a single derived joined field (see buildAddressLine)
   * rather than several separate street/city/region candidates, since
   * that's how a "Address" column is actually used in practice. */
  function detectAddressField(out, entity, entityIndex, groupLabel) {
    var line = buildAddressLine(entity);
    if (!line) return;
    out.push({ path: 'derived.address.' + entityIndex, label: 'Address', group: groupLabel, kind: 'text', sampleValue: line.slice(0, 160) });
  }

  function groupLabelFor(entity, entityIndex) {
    var types = typesOf(entity);
    return (types[0] || 'Structured Data') + ' #' + (entityIndex + 1);
  }

  function detectJsonLdFields(entities) {
    var out = [];
    entities.forEach(function (entity, entityIndex) {
      if (!entity || typeof entity !== 'object') return;
      var types = typesOf(entity);
      if (!types.length) return;
      var groupLabel = groupLabelFor(entity, entityIndex);

      types.forEach(function (t) {
        var simple = SIMPLE_TYPE_FIELDS[t];
        if (simple) simple.forEach(function (pair) { pushIfPresent(out, entity, entityIndex, pair[0], pair[1], groupLabel); });
      });

      if (hasType(entity, 'Product') || entity.offers) detectOfferFields(out, entity, entityIndex, groupLabel);
      if (entity.aggregateRating) detectRatingFields(out, entity, entityIndex, groupLabel);
      if (entity.brand) detectBrandField(out, entity, entityIndex, groupLabel);
      if (entity.image) detectImageField(out, entity, entityIndex, groupLabel);
      if (hasType(entity, 'Article') || hasType(entity, 'NewsArticle')) detectAuthorPublisher(out, entity, entityIndex, groupLabel);
      if (hasType(entity, 'JobPosting')) detectJobFields(out, entity, entityIndex, groupLabel);
      if (hasType(entity, 'LocalBusiness') || hasType(entity, 'Organization')) detectAddressField(out, entity, entityIndex, groupLabel);

      if (hasType(entity, 'BreadcrumbList')) {
        var trail = buildBreadcrumbTrail(entity);
        if (trail) out.push({ path: 'derived.breadcrumb.' + entityIndex, label: 'Breadcrumb Trail', group: groupLabel, kind: 'text', sampleValue: trail.slice(0, 160) });
      }
      if (hasType(entity, 'FAQPage')) {
        var faqSummary = buildFaqSummary(entity);
        if (faqSummary) out.push({ path: 'derived.faq.' + entityIndex, label: 'FAQ (Q&A)', group: groupLabel, kind: 'text', sampleValue: faqSummary.slice(0, 160) });
      }
    });
    return out;
  }

  function detectMetaFields(meta) {
    var out = [];
    function add(path, label, value, kind) {
      if (!value) return;
      out.push({ path: path, label: label, group: 'Page Metadata', kind: kind || 'text', sampleValue: String(value).slice(0, 160) });
    }
    add('meta.title', 'Page Title', meta.title);
    add('meta.description', 'Meta Description', meta.description);
    add('meta.canonical', 'Canonical URL', meta.canonical, 'url');
    add('meta.og.title', 'OG Title', meta.og.title);
    add('meta.og.description', 'OG Description', meta.og.description);
    add('meta.og.image', 'OG Image', meta.og.image, 'image');
    add('meta.og.siteName', 'OG Site Name', meta.og.siteName);
    add('meta.twitter.title', 'Twitter Title', meta.twitter.title);
    add('meta.twitter.description', 'Twitter Description', meta.twitter.description);
    add('meta.twitter.image', 'Twitter Image', meta.twitter.image, 'image');
    add('meta.author', 'Meta Author', meta.author);
    return out;
  }

  /** The full, popup-facing candidate list for the Structured Data
   * inspector (spec #5/#6) — deliberately deduplicated by path (a page
   * could theoretically define the same field twice) and left in a
   * stable, predictable order: JSON-LD entities first (in document
   * order), page metadata last. */
  function detectFields(snapshot) {
    var jsonLdFields = detectJsonLdFields(snapshot.jsonLd.entities || []);
    var metaFields = detectMetaFields(snapshot.meta || {});
    var seen = Object.create(null);
    return jsonLdFields.concat(metaFields).filter(function (f) {
      if (seen[f.path]) return false;
      seen[f.path] = true;
      return true;
    });
  }

  root.WSStructuredData = {
    getSnapshot: getSnapshot,
    detectFields: detectFields,
    getValueAtPath: getValueAtPath,
    // exposed for targeted unit testing
    parseJsonLdBlocks: parseJsonLdBlocks,
    parseMetaTags: parseMetaTags,
    typesOf: typesOf,
    hasType: hasType
  };

  // Own message listener (mirrors content/autodetect.js's exact pattern)
  // so content.js/pagination.js/autodetect.js stay completely untouched.
  if (!window.__wsStructuredDataListenerRegistered) {
    window.__wsStructuredDataListenerRegistered = true;
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || !message.type) return;

      if (message.type === 'SCAN_STRUCTURED_DATA') {
        setTimeout(function () {
          try {
            var snapshot = getSnapshot();
            sendResponse({ ok: true, snapshot: snapshot, fields: detectFields(snapshot) });
          } catch (e) {
            sendResponse({ ok: false, error: String(e && e.message || e), snapshot: null, fields: [] });
          }
        }, 0);
        return true;
      }
    });
  }
})(window);
