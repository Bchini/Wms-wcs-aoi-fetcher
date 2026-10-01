// Thin Leaflet glue for picking which planned WMS tiles to actually
// download: draws each tile as a clickable rectangle over an OSM basemap.
// All the geometry (reprojecting tiles/AOI, deciding what overlaps what)
// lives in ogc.js/geometry.js, which stay plain and unit-testable; this
// file only exists to talk to the DOM and to Leaflet -- same split as
// gdal-runner.js (WASM glue) vs ogc.js (pure request-building logic).

const LEAFLET_VERSION = '1.9.4';
const LEAFLET_BASE = `https://cdnjs.cloudflare.com/ajax/libs/leaflet/${LEAFLET_VERSION}`;
const LEAFLET_JS_INTEGRITY =
  'sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==';
const LEAFLET_CSS_INTEGRITY =
  'sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==';

function loadStylesheet(href, integrity) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.integrity = integrity;
  link.crossOrigin = 'anonymous';
  document.head.appendChild(link);
}

function loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.integrity = integrity;
    script.crossOrigin = 'anonymous';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
}

let leafletPromise = null;
/** Load Leaflet (once) and return its global `L` namespace. */
function loadLeaflet() {
  if (!leafletPromise) {
    loadStylesheet(`${LEAFLET_BASE}/leaflet.min.css`, LEAFLET_CSS_INTEGRITY);
    leafletPromise = loadScript(`${LEAFLET_BASE}/leaflet.min.js`, LEAFLET_JS_INTEGRITY).then(() => window.L);
  }
  return leafletPromise;
}

const SELECTED_STYLE = { color: '#164f42', weight: 1, fillColor: '#d7f55f', fillOpacity: 0.45 };
const UNSELECTED_STYLE = { color: '#8a8477', weight: 1, fillColor: '#8a8477', fillOpacity: 0.08 };

/**
 * Build a Leaflet map inside `container` showing one clickable rectangle
 * per tile in `tiles` (each a planWmsTiles() tile; `toLonLat(x, y)` converts
 * its corners, in whatever CRS the tiles are in, to EPSG:4326 [lon, lat] for
 * display -- Leaflet itself always works in lat/lng regardless of what CRS
 * the actual GetMap requests use).
 *
 * `container` must already be visible (non-zero size) when this is called:
 * Leaflet measures it once at construction time.
 *
 * `onChange(selection)` fires after every click toggle and after
 * setSelection(), so the caller can keep a "N of M selected" status line
 * in sync without polling.
 *
 * Returns `{ getSelection(), setSelection(keys), destroy() }`; `keys` is a
 * Set of ogc.js's tileKey(tile) strings ("row,col").
 */
export async function createTilePicker(container, { tiles, toLonLat, initialSelection, onChange }) {
  const L = await loadLeaflet();
  container.innerHTML = '';
  const map = L.map(container);
  map.setView([0, 0], 2); // placeholder so layers below have a view to attach to
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  const selection = new Set(initialSelection || tiles.map((tile) => `${tile.row},${tile.col}`));
  const rectangles = new Map();
  let bounds = null;

  for (const tile of tiles) {
    const key = `${tile.row},${tile.col}`;
    const sw = toLonLat(tile.txmin, tile.tymin);
    const ne = toLonLat(tile.txmax, tile.tymax);
    if (!sw || !ne) continue; // unsupported CRS for display -- caller should not have called us at all in that case
    const latLngBounds = L.latLngBounds([sw[1], sw[0]], [ne[1], ne[0]]);
    if (!bounds) bounds = L.latLngBounds(latLngBounds.getSouthWest(), latLngBounds.getNorthEast());
    else bounds.extend(latLngBounds);

    const rect = L.rectangle(latLngBounds, selection.has(key) ? SELECTED_STYLE : UNSELECTED_STYLE);
    rect.on('click', () => {
      if (selection.has(key)) selection.delete(key);
      else selection.add(key);
      rect.setStyle(selection.has(key) ? SELECTED_STYLE : UNSELECTED_STYLE);
      onChange?.(new Set(selection));
    });
    rect.addTo(map);
    rectangles.set(key, rect);
  }

  if (bounds) map.fitBounds(bounds, { padding: [12, 12] });

  return {
    getSelection: () => new Set(selection),
    setSelection(keys) {
      selection.clear();
      for (const key of keys) selection.add(key);
      for (const [key, rect] of rectangles) rect.setStyle(selection.has(key) ? SELECTED_STYLE : UNSELECTED_STYLE);
      onChange?.(new Set(selection));
    },
    destroy() {
      map.remove();
    },
  };
}
