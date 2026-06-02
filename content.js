(function () {
  'use strict';

  const MAP_CLASS = 'rm-inline-map';
  const MAP_WRAPPER_CLASS = 'rm-inline-map-wrapper';
  const PROCESSED_ATTR = 'data-rm-map-done';

  const FP_CLASS = 'rm-inline-floorplan';
  const FP_WRAPPER_CLASS = 'rm-inline-floorplan-wrapper';
  const FP_DONE_ATTR = 'data-rm-fp-done';

  // Fix Leaflet's default marker icon paths to use extension-bundled images.
  function fixLeafletIconPaths() {
    delete L.Icon.Default.prototype._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconUrl: chrome.runtime.getURL('lib/marker-icon.png'),
      iconRetinaUrl: chrome.runtime.getURL('lib/marker-icon-2x.png'),
      shadowUrl: chrome.runtime.getURL('lib/marker-shadow.png'),
    });
  }

  // ── Transit overlay (tube / rail lines + stations) ───────────────────────────

  // Bundled GeoJSON is fetched once and shared across every mini-map.
  let transitDataPromise = null;
  function loadTransitData() {
    if (transitDataPromise) return transitDataPromise;
    transitDataPromise = Promise.all([
      fetch(chrome.runtime.getURL('lib/tube-lines.json')).then((r) => r.json()),
      fetch(chrome.runtime.getURL('lib/tube-stations.json')).then((r) => r.json()),
    ])
      .then(([lines, stations]) => ({
        lines: lines.lines || [],
        stations: stations.stations || [],
      }))
      .catch(() => ({ lines: [], stations: [] }));
    return transitDataPromise;
  }

  // TfL roundel marker: mode-coloured ring + blue bar. Cached per colour.
  const ROUNDEL_BAR = '#0019A8';
  const roundelIcons = {};
  function roundelIcon(color) {
    if (roundelIcons[color]) return roundelIcons[color];
    const html =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 26" width="13" height="13">' +
      '<circle cx="13" cy="13" r="10.5" fill="#fff"/>' +
      '<circle cx="13" cy="13" r="8" fill="none" stroke="' + color + '" stroke-width="4.5"/>' +
      '<rect x="0" y="10.5" width="26" height="5" fill="' + ROUNDEL_BAR + '"/>' +
      '</svg>';
    const icon = L.divIcon({
      html,
      className: 'rm-roundel',
      iconSize: [13, 13],
      iconAnchor: [6.5, 6.5],
    });
    roundelIcons[color] = icon;
    return icon;
  }

  // Draw the line segments + stations that fall within the map's current view,
  // re-rendering when the user pans so panning reveals more of the network.
  function addTransitOverlay(map) {
    const layer = L.layerGroup().addTo(map);

    loadTransitData().then(({ lines, stations }) => {
      if (!lines.length && !stations.length) return;

      function render() {
        const b = map.getBounds().pad(0.25);
        const vw = b.getWest(), vs = b.getSouth(), ve = b.getEast(), vn = b.getNorth();
        layer.clearLayers();

        for (const ln of lines) {
          const [w, s, e, n] = ln.bb;
          if (e < vw || w > ve || n < vs || s > vn) continue; // bbox outside view
          L.polyline(ln.g.map(([lng, lat]) => [lat, lng]), {
            color: ln.c,
            weight: 2.5,
            opacity: 0.9,
            interactive: false,
          }).addTo(layer);
        }

        for (const st of stations) {
          const [lng, lat] = st.p;
          if (lng < vw || lng > ve || lat < vs || lat > vn) continue;
          L.marker([lat, lng], {
            icon: roundelIcon(st.c),
            interactive: false,
            keyboard: false,
          }).addTo(layer);
        }
      }

      render();
      map.on('moveend', render);
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
      if (id && lat != null && lng != null) {
        coords[id] = {
          lat,
          lng,
          floorplans: prop?.numberOfFloorplans || 0,
          size: (prop?.displaySize || '').trim(),
        };
      }
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

    // Relocate the address into the map column as a small caption below the map.
    // Clone the text rather than moving the React-owned node (moving it risks a
    // reconciliation crash); the original is hidden via CSS.
    const addressText = card.querySelector('[data-testid="property-address"]')?.textContent?.trim();
    if (addressText) {
      const caption = document.createElement('div');
      caption.className = 'rm-map-address';
      caption.textContent = addressText;
      wrapper.appendChild(caption);
    }

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

    addTransitOverlay(map);

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

  // ── Floorplan injection ──────────────────────────────────────────────────────

  // Search-results JSON only tells us a floorplan *exists* (numberOfFloorplans),
  // not its URL — that lives on the detail page. Scrape the detail HTML for the
  // first property-floorplan media URL. Same-origin, so no host permission needed.
  const FLOORPLAN_RE =
    /https?:\/\/media\.rightmove\.co\.uk\/[^"'\\\s]*?property-floorplan[^"'\\\s]*?\.(?:png|gif|jpe?g)/gi;

  async function fetchFloorplanUrl(id) {
    try {
      const res = await fetch(`/properties/${id}`);
      if (!res.ok) return null;
      const html = await res.text();
      const matches = html.match(FLOORPLAN_RE);
      if (!matches) return null;
      // Prefer the full-res original (no _max_ resize suffix) so we control sizing.
      return matches.find((u) => !/_max_/.test(u)) || matches[0];
    } catch (_) {
      return null;
    }
  }

  // Rewrite a full-res floorplan URL to a bounded thumbnail so we don't pull
  // multi-MB images across every card. /property-floorplan/… → /dir/property-floorplan/…_max_500x500.
  function floorplanThumb(url) {
    if (/_max_/.test(url)) return url;
    return url
      .replace('media.rightmove.co.uk/property-floorplan', 'media.rightmove.co.uk/dir/property-floorplan')
      .replace(/\.(png|gif|jpe?g)$/i, '_max_500x500.$1');
  }

  async function loadFloorplan(inner, id) {
    inner.classList.add('rm-fp-loading');
    const url = await fetchFloorplanUrl(id);
    inner.classList.remove('rm-fp-loading');
    if (!url) {
      inner.classList.add('rm-fp-empty');
      return;
    }

    const img = document.createElement('img');
    img.className = 'rm-fp-img';
    img.loading = 'lazy';
    img.alt = 'Floorplan';
    img.src = floorplanThumb(url);
    // If the resized variant 404s, fall back to the full-res original.
    img.addEventListener('error', () => { if (img.src !== url) img.src = url; });
    inner.appendChild(img);

    inner.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(url, '_blank');
    });
  }

  function injectFloorplan(card, id) {
    if (card.hasAttribute(FP_DONE_ATTR)) return;
    card.setAttribute(FP_DONE_ATTR, '1');

    const wrapper = document.createElement('div');
    wrapper.className = FP_WRAPPER_CLASS;

    const inner = document.createElement('div');
    inner.className = FP_CLASS;
    wrapper.appendChild(inner);

    // Sit beside the map: after the map wrapper if present, else after the photo.
    const mapWrapper = card.querySelector('.' + MAP_WRAPPER_CLASS);
    const photoSection = card.querySelector('[class*="propertyCardPhotoSection"]');
    if (mapWrapper) {
      mapWrapper.insertAdjacentElement('afterend', wrapper);
    } else if (photoSection) {
      photoSection.insertAdjacentElement('afterend', wrapper);
    } else {
      card.appendChild(wrapper);
    }

    const observer = new IntersectionObserver((entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        obs.unobserve(entry.target);
        loadFloorplan(inner, id);
      }
    }, { rootMargin: '200px' });

    observer.observe(wrapper);
  }

  // ── Floor-area injection ──────────────────────────────────────────────────────

  // Search-results JSON only carries displaySize for some listings; the rest are
  // backfilled from the detail page (see fetchSize). The value lands in the native
  // PropertyInformation row alongside the bed/bath icons. Idempotent: re-adds
  // itself if React ever re-renders the row and drops our node.
  const SQFT_CLASS = 'rm-sqft';
  const SQFT_ICON =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path fill="currentColor" d="M4 4h6v2H6v4H4V4Zm10 0h6v6h-2V6h-4V4ZM4 14h2v4h4v2H4v-6Zm16 0v6h-6v-2h4v-4h2Z"/>' +
    '</svg>';

  function injectSqft(card, size) {
    const container = card.querySelector('[class*="PropertyInformation_container"]');
    if (!container || container.querySelector('.' + SQFT_CLASS)) return;

    const text = size.replace(/sq\.?\s*ft\.?/i, 'sq ft');
    const el = document.createElement('span');
    el.className = SQFT_CLASS;
    el.setAttribute('aria-label', text);
    el.innerHTML = SQFT_ICON;
    const label = document.createElement('span');
    label.textContent = text;
    el.appendChild(label);
    container.appendChild(el);
  }

  // ── Main loop ────────────────────────────────────────────────────────────────

  function processPage(coordMap) {
    if (Object.keys(coordMap).length === 0) return;
    const cards = [...document.querySelectorAll('[class*="propertyCardContainerWrapper"]')];
    for (const card of cards) {
      const id = getPropertyId(card);
      const info = id && coordMap[id];
      if (!info) continue;
      if (!card.hasAttribute(PROCESSED_ATTR)) injectMap(card, info);
      if (info.floorplans > 0 && !card.hasAttribute(FP_DONE_ATTR)) injectFloorplan(card, id);
      if (info.size) injectSqft(card, info.size);
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
