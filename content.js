(function () {
  'use strict';

  const MAP_CLASS = 'rm-inline-map';
  const MAP_WRAPPER_CLASS = 'rm-inline-map-wrapper';
  const PROCESSED_ATTR = 'data-rm-map-done';

  // Fix Leaflet's default marker icon paths to use extension-bundled images.
  function fixLeafletIconPaths() {
    delete L.Icon.Default.prototype._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconUrl: chrome.runtime.getURL('lib/marker-icon.png'),
      iconRetinaUrl: chrome.runtime.getURL('lib/marker-icon-2x.png'),
      shadowUrl: chrome.runtime.getURL('lib/marker-shadow.png'),
    });
  }

  // ── Data extraction ──────────────────────────────────────────────────────────

  // Rightmove is a Next.js app. __NEXT_DATA__ is inaccessible to content scripts
  // (isolated world), but Next.js always writes it as a DOM script tag with
  // id="__NEXT_DATA__" and type="application/json" — which content scripts can read.
  function buildCoordMap() {
    const coords = {};
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return coords;
    let data;
    try { data = JSON.parse(el.textContent); } catch (_) { return coords; }
    const properties = data?.props?.pageProps?.searchResults?.properties;
    if (!Array.isArray(properties)) return coords;
    for (const prop of properties) {
      const id = String(prop?.id ?? '');
      const lat = prop?.location?.latitude;
      const lng = prop?.location?.longitude;
      if (id && lat != null && lng != null) {
        coords[id] = { lat, lng };
      }
    }
    return coords;
  }

  function safeGet(fn) {
    try { return fn(); } catch (_) { return null; }
  }

  // ── DOM helpers ──────────────────────────────────────────────────────────────

  // Extract the Rightmove property ID from a card element via its /properties/{id} link.
  function getPropertyId(card) {
    const link = card.querySelector('a[href*="/properties/"]');
    if (link) {
      const m = link.getAttribute('href').match(/\/properties\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  // ── Map injection ────────────────────────────────────────────────────────────

  function injectMap(card, coords) {
    if (card.hasAttribute(PROCESSED_ATTR)) return;
    card.setAttribute(PROCESSED_ATTR, '1');

    const wrapper = document.createElement('div');
    wrapper.className = MAP_WRAPPER_CLASS;

    const mapEl = document.createElement('div');
    mapEl.className = MAP_CLASS;
    wrapper.appendChild(mapEl);

    // Append to the card itself — CSS positions the wrapper absolutely on the
    // right edge and adds padding-right to the card to push its content left.
    card.appendChild(wrapper);

    // Use IntersectionObserver so we only initialise Leaflet when the card
    // scrolls into view — keeps the page responsive with 20+ results.
    const observer = new IntersectionObserver((entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        obs.unobserve(entry.target);
        initLeaflet(mapEl, coords);
      }
    }, { rootMargin: '200px' });

    observer.observe(wrapper);
  }

  function initLeaflet(el, coords) {
    const map = L.map(el, {
      center: [coords.lat, coords.lng],
      zoom: 15,
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      keyboard: false,
      tap: false,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
    }).addTo(map);

    L.marker([coords.lat, coords.lng]).addTo(map);

    // Re-centre and repaint whenever the container is resized (e.g. window resize).
    new ResizeObserver(() => map.invalidateSize()).observe(el);

    // Clicking the mini-map opens the full Rightmove map tab for this property.
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const link = el.closest('[class*="propertyCardContainerWrapper"]')
                     ?.querySelector('a[href*="/properties/"]');
      if (link) {
        window.open(link.href.replace(/#.*$/, '#/map-view'), '_blank');
      }
    });
  }

  // ── Main loop ────────────────────────────────────────────────────────────────

  function processPage(coordMap) {
    if (Object.keys(coordMap).length === 0) return;

    const cards = [...document.querySelectorAll('[class*="propertyCardContainerWrapper"]')];

    for (const card of cards) {
      if (card.hasAttribute(PROCESSED_ATTR)) continue;
      const id = getPropertyId(card);
      if (id && coordMap[id]) {
        injectMap(card, coordMap[id]);
      }
    }
  }

  function init() {
    fixLeafletIconPaths();

    const coordMap = buildCoordMap();

    if (Object.keys(coordMap).length === 0) {
      // The page may still be loading its data scripts. Retry a few times.
      let attempts = 0;
      const interval = setInterval(() => {
        const map = buildCoordMap();
        if (Object.keys(map).length > 0 || ++attempts >= 10) {
          clearInterval(interval);
          if (Object.keys(map).length > 0) run(map);
        }
      }, 500);
      return;
    }

    run(coordMap);
  }

  function run(coordMap) {
    processPage(coordMap);

    // Re-run when Rightmove's React app swaps in new cards (pagination, filters).
    const observer = new MutationObserver(() => processPage(coordMap));
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
