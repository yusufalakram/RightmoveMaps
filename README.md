# Rightmove Maps

A Chrome extension that enhances Rightmove property search results with inline maps, so you can see exactly where each property is without opening the listing.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)

## Features

- **Inline map on every card** — a Leaflet/OpenStreetMap map with a pin appears directly on each property card in the search results
- **No API key required** — uses OpenStreetMap tiles, completely free
- **Sidebar removed** — hides the Rightmove right sidebar to give results more horizontal space
- **Ads removed** — hides sponsored/featured agent banners and interstitial ads between results
- **Lazy loading** — maps only initialise when they scroll into view, keeping the page responsive
- **Click to open** — clicking a mini-map opens the full Rightmove map view for that property in a new tab
- **Stays in sync** — a MutationObserver re-processes cards when Rightmove's React app updates the page (pagination, filter changes)

## Installation

This extension is not on the Chrome Web Store. Install it in developer mode:

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the repository folder
5. Navigate to any Rightmove property search results page

Works on for-sale, to-rent, and new homes search results.

## Project structure

```
RightmoveMaps/
├── manifest.json       # Chrome MV3 manifest
├── content.js          # Core logic — reads page data, injects maps
├── content.css         # Map panel layout + Rightmove layout overrides
├── lib/
│   ├── leaflet.js      # Leaflet 1.9.4 (bundled, no CDN)
│   ├── leaflet.css
│   ├── marker-icon.png
│   ├── marker-icon-2x.png
│   └── marker-shadow.png
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## How it works

Rightmove is a Next.js app that embeds all search result data in a `<script id="__NEXT_DATA__" type="application/json">` tag. The content script reads this tag directly (Chrome content scripts run in an isolated world and can't access JS globals, but can read DOM elements), extracts the `location.latitude` / `location.longitude` for each property, matches them to their card elements via the `/properties/{id}` link in each card, and injects a Leaflet map.

## Notes

- Rightmove's CSS class names include hashed suffixes (e.g. `PropertyCard_propertyCardContainerWrapper__mcK1Z`) — the extension targets the stable prefix portion using `[class*="..."]` attribute selectors, so it should survive minor Rightmove updates
- If maps stop appearing after a Rightmove update, the most likely cause is a change to the `__NEXT_DATA__` property structure — check `__NEXT_DATA__.props.pageProps.searchResults.properties[0]?.location` in the browser console
