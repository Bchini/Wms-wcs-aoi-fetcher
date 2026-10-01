import {
  wmsBbox,
  wmsCrsParameter,
  serviceUrl,
  planWmsTiles,
  resolutionOptions,
  customResolution,
  reprojectAoiBounds,
  intersectBounds,
  scaleWarningText,
  reprojectPointToLonLat,
  reprojectPolygonsToCrs,
  tileKey,
  tilesIntersectingPolygons,
} from './ogc.js';
import { boundsFromGeoJson, polygonsFromGeoJson } from './aoi.js';
import { runWcs, runWms } from './gdal-runner.js';
import { createTilePicker } from './tile-picker.js';

const form = document.querySelector('#fetch-form');
const urlField = document.querySelector('#service-url');
const detectedPanel = document.querySelector('#detected-panel');
const detectedSummary = document.querySelector('#detected-summary');
const resolutionSelect = document.querySelector('#resolution-select');
const customWidthInput = document.querySelector('#custom-width');
const aoiFileInput = document.querySelector('#aoi-file');
const aoiStatus = document.querySelector('#aoi-status');
const aoiActions = document.querySelector('#aoi-actions');
const aoiClearButton = document.querySelector('#aoi-clear');
const scaleWarningEl = document.querySelector('#scale-warning');
const tilePickerSection = document.querySelector('#tile-picker-section');
const tilePickerMap = document.querySelector('#tile-picker-map');
const tilePickerStatus = document.querySelector('#tile-picker-status');
const tilePickerSelectAll = document.querySelector('#tile-picker-select-all');
const tilePickerClearButton = document.querySelector('#tile-picker-clear');
const processStatus = document.querySelector('#process-status');
const launchButton = document.querySelector('#launch-button');
const progressTrack = document.querySelector('#progress-track');
const progressFill = document.querySelector('#progress-fill');
const feedbackForm = document.querySelector('#feedback-form');
const feedbackMessage = document.querySelector('#feedback-message');
const feedbackStatus = document.querySelector('#feedback-status');
const feedbackButton = feedbackForm.querySelector('button[type="submit"]');

const WMS_TILE_SIZE = 1024;
const DEFAULT_STATUS = "Paste a link and press DETECT to see the layer and choose a resolution.";

// The form works in two steps: DETECT calls /api/resolve and shows a
// resolution dropdown sized to the area's own extent (the fix for a full-
// country request defaulting to a coarse resolution); DOWNLOAD then runs
// GDAL with whichever resolution was chosen. Editing the URL after
// detecting resets back to step one, since a different URL may resolve to
// a different area entirely.
let detected = null; // the last /api/resolve() result
let detectedForUrl = null; // the URL string it was resolved from
let aoiBounds = null; // an uploaded AOI's bbox, reprojected + intersected with detected.bounds
let aoiPolygonsLonLat = null; // the same AOI's actual polygon rings (EPSG:4326), for true-shape tile selection
let tilePicker = null; // the active createTilePicker() instance, or null (WCS, >1 tile unsupported CRS, or just 1 tile)
let tilePickerTiles = []; // the exact tile list `tilePicker` was built from -- compared by length at download time as a cheap staleness guard

function resetAoi() {
  aoiBounds = null;
  aoiPolygonsLonLat = null;
  aoiFileInput.value = '';
  aoiStatus.hidden = true;
  aoiActions.hidden = true;
}

function destroyTilePicker() {
  if (tilePicker) tilePicker.destroy();
  tilePicker = null;
  tilePickerTiles = [];
  tilePickerSection.hidden = true;
}

function resetDetection() {
  detected = null;
  detectedForUrl = null;
  detectedPanel.hidden = true;
  scaleWarningEl.hidden = true;
  customWidthInput.value = '';
  resetAoi();
  destroyTilePicker();
  launchButton.textContent = 'DETECT';
  processStatus.textContent = DEFAULT_STATUS;
}
urlField.addEventListener('input', () => {
  if (urlField.value.trim() !== detectedForUrl) resetDetection();
});

/** [minx, miny, maxx, maxy] actually in effect: the AOI clip if one applied, else the full detected extent. */
function effectiveBounds() {
  return aoiBounds || detected.bounds;
}

/**
 * Recompute the scale-denominator warning against whatever is currently
 * selected (AOI or not, dropdown preset or a typed custom width) -- the
 * `warning` a /api/resolve response carries is only ever valid for that
 * response's own full-extent default request, and goes stale the moment
 * either changes.
 */
function refreshScaleWarning() {
  if (!detected) return;
  const bounds = effectiveBounds();
  const customWidth = Number(customWidthInput.value.trim());
  const resolution = customWidth > 0 ? (bounds[2] - bounds[0]) / customWidth : Number(resolutionSelect.value);
  if (!Number.isFinite(resolution) || resolution <= 0) return;
  const warning = scaleWarningText(detected.maxScaleDenominator, resolution, detected.crs);
  scaleWarningEl.textContent = warning || '';
  scaleWarningEl.hidden = !warning;
}
resolutionSelect.addEventListener('change', refreshScaleWarning);
customWidthInput.addEventListener('input', refreshScaleWarning);

function formatCoord(n) {
  return Math.round(n * 1e5) / 1e5;
}

const TILE_PICKER_CRS = new Set(['EPSG:4326', 'CRS:84', 'EPSG:3857', 'EPSG:900913']);

function updateTilePickerStatus() {
  if (!tilePicker) return;
  const n = tilePicker.getSelection().size;
  const total = tilePickerTiles.length;
  tilePickerStatus.textContent = `${n} of ${total} tile${total > 1 ? 's' : ''} selected — click a tile to toggle it.`;
}

/**
 * (Re)build the tile-selection map for the current bounds/resolution, or
 * hide it when there's nothing to usefully pick from: WCS (never tiled),
 * a CRS the map can't display, or just a single tile. Called after every
 * change that affects the tile grid's shape (resolution, AOI) so the
 * picker shown is always the one `resolveRunParams()` will actually use --
 * runDownload() double-checks this by comparing tile counts before trusting
 * the picker's selection.
 */
async function rebuildTilePicker() {
  if (!detected || detected.service !== 'wms') {
    destroyTilePicker();
    return;
  }
  let resolution;
  try {
    ({ resolution } = resolveRunParams(detected));
  } catch {
    destroyTilePicker(); // an over-budget custom width -- the real error shows up when DOWNLOAD is pressed
    return;
  }
  const bounds = effectiveBounds();
  const [minx, miny, maxx, maxy] = bounds;
  const tiles = planWmsTiles({ minx, miny, maxx, maxy, tileW: WMS_TILE_SIZE, tileH: WMS_TILE_SIZE, resolution });

  if (!TILE_PICKER_CRS.has(detected.crs.toUpperCase()) || tiles.length <= 1) {
    destroyTilePicker();
    return;
  }

  let initialSelection = null;
  if (aoiPolygonsLonLat && aoiPolygonsLonLat.length) {
    const reprojected = reprojectPolygonsToCrs(aoiPolygonsLonLat, detected.crs);
    if (reprojected) initialSelection = tilesIntersectingPolygons(tiles, reprojected);
  }

  if (tilePicker) tilePicker.destroy();
  tilePickerSection.hidden = false;
  tilePickerTiles = tiles;
  tilePicker = await createTilePicker(tilePickerMap, {
    tiles,
    toLonLat: (x, y) => reprojectPointToLonLat(x, y, detected.crs),
    initialSelection,
    onChange: updateTilePickerStatus,
  });
  updateTilePickerStatus();
}
resolutionSelect.addEventListener('change', rebuildTilePicker);
customWidthInput.addEventListener('change', rebuildTilePicker);

tilePickerSelectAll.addEventListener('click', () => {
  if (!tilePicker) return;
  tilePicker.setSelection(tilePickerTiles.map(tileKey));
});
tilePickerClearButton.addEventListener('click', () => {
  if (!tilePicker) return;
  tilePicker.setSelection([]);
});

aoiFileInput.addEventListener('change', async () => {
  const file = aoiFileInput.files[0];
  if (!file) return;
  if (!detected) {
    aoiFileInput.value = '';
    aoiStatus.hidden = false;
    aoiStatus.classList.add('is-error');
    aoiStatus.textContent = 'Press DETECT first, then upload your AOI.';
    return;
  }
  try {
    const geojson = JSON.parse(await file.text());
    const lonLatBounds = boundsFromGeoJson(geojson);
    const reprojected = reprojectAoiBounds(lonLatBounds, detected.crs);
    if (!reprojected) {
      throw new Error(
        `AOI clipping isn't supported for ${detected.crs} yet (only EPSG:4326/EPSG:3857 services). Using the full extent instead.`
      );
    }
    const clipped = intersectBounds(reprojected, detected.bounds);
    if (!clipped) {
      throw new Error("This AOI doesn't overlap the detected layer's extent.");
    }
    aoiBounds = clipped;
    aoiPolygonsLonLat = polygonsFromGeoJson(geojson); // [] for a non-polygon AOI -- tile picking then just uses the bbox clip above
    aoiActions.hidden = false;
    aoiStatus.hidden = false;
    aoiStatus.classList.remove('is-error');
    const [minx, miny, maxx, maxy] = clipped;
    aoiStatus.textContent =
      `AOI applied — downloading only ${formatCoord(minx)}, ${formatCoord(miny)} to ` +
      `${formatCoord(maxx)}, ${formatCoord(maxy)} (${detected.crs}).`;
  } catch (error) {
    aoiBounds = null;
    aoiPolygonsLonLat = null;
    aoiFileInput.value = '';
    aoiActions.hidden = true;
    aoiStatus.hidden = false;
    aoiStatus.classList.add('is-error');
    aoiStatus.textContent = error.message;
  }
  populateResolutionSelect(detected, effectiveBounds());
  refreshScaleWarning();
  await rebuildTilePicker();
});

aoiClearButton.addEventListener('click', async () => {
  resetAoi();
  if (detected) {
    populateResolutionSelect(detected, effectiveBounds());
    refreshScaleWarning();
    await rebuildTilePicker();
  }
});

// Best-effort client-side read of SERVICE/VERSION from the pasted URL, purely
// to label a feedback report — /api/resolve does its own, authoritative
// detection (including a GetCapabilities probe when the URL gives no hint).
function sniffService(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return 'wms'; }
  const service = (parsed.searchParams.get('service') || parsed.searchParams.get('SERVICE') || '').toLowerCase();
  if (['wms', 'wcs'].includes(service)) return service;
  return parsed.pathname.toLowerCase().includes('wcs') ? 'wcs' : 'wms';
}
function sniffVersion(rawUrl, service) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { parsed = null; }
  const version = parsed?.searchParams.get('version') || parsed?.searchParams.get('VERSION') || '';
  const valid = { wms: ['1.1.1', '1.3.0'], wcs: ['1.0.0'] };
  if (valid[service].includes(version)) return version;
  return service === 'wms' ? '1.3.0' : '1.0.0';
}

// Real progress, not a fake timer: resolving the URL is a fixed 5%, fetching
// and warping each tile advances proportionally to tiles done/total, and
// compositing the final mosaic covers the last stretch.
function setProgress(percent) {
  progressFill.style.width = `${percent}%`;
  progressFill.setAttribute('aria-valuenow', String(Math.round(percent)));
}
function showProgress() {
  progressFill.classList.remove('is-done', 'is-error');
  progressTrack.hidden = false;
  setProgress(0);
}
function updateProgress({ phase, done, total }) {
  const fraction = total ? done / total : 0;
  let percent = 0;
  if (phase === 'fetching') percent = 5 + 55 * fraction;
  else if (phase === 'processing') percent = 60 + 25 * fraction;
  else if (phase === 'compositing') percent = 85 + 13 * fraction;
  setProgress(Math.min(98, percent));
}
function finishProgress(success) {
  progressFill.classList.toggle('is-done', success);
  progressFill.classList.toggle('is-error', !success);
  if (success) setProgress(100);
  setTimeout(() => { progressTrack.hidden = true; setProgress(0); }, success ? 900 : 2500);
}

async function resolveUrl(url) {
  const response = await fetch('/api/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function triggerDownload(blob, filename) {
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(downloadUrl);
}

function populateResolutionSelect(resolved, bounds) {
  const options = resolutionOptions(bounds, { tileSize: WMS_TILE_SIZE });
  resolutionSelect.innerHTML = '';
  for (const option of options) {
    const el = document.createElement('option');
    el.value = String(option.resolution);
    const dims = `${option.width} × ${option.height} px`;
    const extra = resolved.service === 'wms' && option.tiles > 1 ? ` · ${option.tiles} tiles` : '';
    el.textContent = `${option.label} — ${dims}${extra}`;
    if (option.label === 'Standard') el.selected = true;
    resolutionSelect.appendChild(el);
  }
  // Standard may have been dropped (e.g. an enormous full-extent area) --
  // fall back to whatever the list's last (coarsest-that-fits) entry is.
  if (!resolutionSelect.value && resolutionSelect.options.length) {
    resolutionSelect.selectedIndex = resolutionSelect.options.length - 1;
  }
}

async function detect(url) {
  launchButton.disabled = true;
  launchButton.textContent = 'DETECTING…';
  processStatus.textContent = 'Detecting the service, layer, and area…';
  try {
    const resolved = await resolveUrl(url);
    detected = resolved;
    detectedForUrl = url;
    resetAoi();
    populateResolutionSelect(resolved, resolved.bounds);
    detectedPanel.hidden = false;
    detectedSummary.textContent =
      `${resolved.service.toUpperCase()} · ${resolved.layer} · ${resolved.crs}`;
    refreshScaleWarning();
    await rebuildTilePicker();
    processStatus.textContent = 'Choose a resolution, then press DOWNLOAD GEOTIFF.';
    launchButton.textContent = 'DOWNLOAD GEOTIFF';
  } catch (error) {
    processStatus.textContent = `Could not detect this URL: ${error.message}`;
    launchButton.textContent = 'DETECT';
  } finally {
    launchButton.disabled = false;
  }
}

/**
 * The [bounds, resolution] a download should actually run with: the AOI
 * clip if one is applied (else the full detected extent), and either the
 * custom pixel width (if the user typed one) or whatever the dropdown has
 * selected. Throws a plain-language Error if the custom width blows the
 * pixel/tile safety budget -- caught by the submit handler before any
 * network request goes out.
 */
function resolveRunParams(resolved) {
  const bounds = effectiveBounds();
  const customWidth = customWidthInput.value.trim();
  if (customWidth) {
    const budget = resolved.service === 'wcs' ? { maxTiles: Infinity, tileSize: WMS_TILE_SIZE } : { tileSize: WMS_TILE_SIZE };
    const { resolution } = customResolution(bounds, Number(customWidth), budget);
    return { bounds, resolution };
  }
  return { bounds, resolution: Number(resolutionSelect.value) };
}

async function runDownload(resolved, bounds, resolution) {
  launchButton.disabled = true;
  launchButton.textContent = 'RUNNING…';
  showProgress();
  try {
    let blob;
    if (resolved.service === 'wcs') {
      processStatus.textContent = `Fetching ${resolved.layer} (WCS) and clipping in your browser…`;
      const params = {
        service: 'WCS',
        version: resolved.version,
        request: 'GetCoverage',
        coverage: resolved.layer,
        crs: resolved.crs,
        response_crs: resolved.crs,
        bbox: bounds.join(','),
        resx: String(resolution),
        resy: String(resolution),
        format: 'GeoTIFF',
      };
      blob = await runWcs(
        { url: serviceUrl(resolved.endpoint, params), bounds, resolution, crs: resolved.crs },
        updateProgress
      );
    } else {
      const [minx, miny, maxx, maxy] = bounds;
      let tiles = planWmsTiles({ minx, miny, maxx, maxy, tileW: WMS_TILE_SIZE, tileH: WMS_TILE_SIZE, resolution });
      // Only apply the tile-picker's selection if it was built from this
      // exact grid (same tile count) -- a mismatch means the picker is
      // stale (shouldn't happen, rebuildTilePicker() runs on every change
      // that affects the grid, but this is a cheap guard against silently
      // dropping tiles the user never meant to deselect).
      if (tilePicker && tilePickerTiles.length === tiles.length) {
        const selection = tilePicker.getSelection();
        tiles = tiles.filter((tile) => selection.has(tileKey(tile)));
        if (!tiles.length) throw new Error('Select at least one tile on the map before downloading.');
      }
      tiles = tiles.map((tile) => ({
        ...tile,
        url: serviceUrl(resolved.endpoint, {
          service: 'WMS',
          version: resolved.version,
          request: 'GetMap',
          layers: resolved.layer,
          styles: '',
          [wmsCrsParameter(resolved.version)]: resolved.crs,
          bbox: wmsBbox(tile.txmin, tile.tymin, tile.txmax, tile.tymax, resolved.crs, resolved.version),
          width: String(tile.width),
          height: String(tile.height),
          format: resolved.imageFormat,
        }),
      }));
      processStatus.textContent = `Fetching ${tiles.length} tile${tiles.length > 1 ? 's' : ''} from ${resolved.layer} (WMS) and mosaicking in your browser…`;
      blob = await runWms(
        { tiles, bounds, resolution, crs: resolved.crs },
        updateProgress
      );
    }

    triggerDownload(blob, `aoi_${resolved.service}.tif`);
    processStatus.textContent = 'Done — your GeoTIFF download has started.';
    finishProgress(true);
  } catch (error) {
    processStatus.textContent = `Processing failed: ${error.message}`;
    finishProgress(false);
  } finally {
    launchButton.disabled = false;
    launchButton.textContent = 'DOWNLOAD GEOTIFF';
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  const url = urlField.value.trim();
  if (detected && detectedForUrl === url) {
    let bounds, resolution;
    try {
      ({ bounds, resolution } = resolveRunParams(detected));
    } catch (error) {
      processStatus.textContent = error.message;
      return;
    }
    await runDownload(detected, bounds, resolution);
  } else {
    await detect(url);
  }
});

feedbackForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = feedbackMessage.value.trim();
  if (!message) return;
  const service = sniffService(urlField.value.trim());
  feedbackButton.disabled = true;
  feedbackStatus.textContent = 'Sending your report…';
  try {
    const response = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, service, protocol: sniffVersion(urlField.value.trim(), service) }),
    });
    if (!response.ok) throw new Error('Feedback request failed');
    feedbackForm.reset();
    feedbackStatus.textContent = 'Thank you — your report was saved. It will help improve the app.';
  } catch {
    feedbackStatus.textContent = 'Your report could not be saved. Please try again shortly.';
  } finally {
    feedbackButton.disabled = false;
  }
});
