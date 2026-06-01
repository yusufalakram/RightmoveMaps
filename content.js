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

  function parseProperties(properties) {
    const coords = {};
    if (!Array.isArray(properties)) return coords;
    for (const prop of properties) {
      const id = String(prop?.id ?? '');
      const lat = prop?.location?.latitude;
      const lng = prop?.location?.longitude;
      if (id && lat != null && lng != null) coords[id] = { lat, lng };
    }
    return coords;
  }

  function buildCoordMap() {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return {};
    let data;
    try { data = JSON.parse(el.textContent); } catch (_) { return {}; }
    return parseProperties(data?.props?.pageProps?.searchResults?.properties);
  }

  function getBuildId() {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return null;
    try { return JSON.parse(el.textContent)?.buildId ?? null; } catch (_) { return null; }
  }

  // Fetch the new page's property data from Next.js's data endpoint.
  // On SPA navigation, __NEXT_DATA__ is stale; this gets the current page's coords.
  async function fetchPageCoords(buildId) {
    const url = `/_next/data/${buildId}${location.pathname}.json${location.search}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return {};
      const data = await res.json();
      return parseProperties(data?.pageProps?.searchResults?.properties);
    } catch (_) { return {}; }
  }

  // ── DOM helpers ──────────────────────────────────────────────────────────────

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

    const photoSection = card.querySelector('[class*="propertyCardPhotoSection"]');
    if (photoSection) {
      photoSection.insertAdjacentElement('afterend', wrapper);
    } else {
      card.appendChild(wrapper);
    }

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
      dragging: true,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      keyboard: false,
      tap: false,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
    }).addTo(map);

    L.marker([coords.lat, coords.lng]).addTo(map);

    new ResizeObserver(() => map.invalidateSize()).observe(el);

    let dragged = false;
    map.on('dragstart', () => { dragged = true; });

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dragged) { dragged = false; return; }
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
      if (id && coordMap[id]) injectMap(card, coordMap[id]);
    }
  }

  function init() {
    fixLeafletIconPaths();

    const coordMap = buildCoordMap();

    if (Object.keys(coordMap).length === 0) {
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

  function run(initialCoordMap) {
    const buildId = getBuildId();
    let currentCoordMap = initialCoordMap;
    let lastUrl = location.href;

    processPage(currentCoordMap);

    // On Next.js SPA pagination, __NEXT_DATA__ is stale. Fetch the new page's
    // data from the Next.js data endpoint and refresh the coord map.
    async function onNavigate() {
      if (!buildId) return;
      const newCoords = await fetchPageCoords(buildId);
      if (Object.keys(newCoords).length > 0) {
        currentCoordMap = newCoords;
        processPage(currentCoordMap);
      }
    }

    // history.pushState patches in content scripts only affect the isolated world,
    // not the page's world. Poll location.href instead — it IS shared.
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        onNavigate();
      }
    }, 200);

    window.addEventListener('popstate', () => {
      lastUrl = location.href;
      onNavigate();
    });

    // Re-run when React swaps in new cards (covers the case where cards appear
    // after onNavigate has already updated currentCoordMap).
    const observer = new MutationObserver(() => processPage(currentCoordMap));
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
