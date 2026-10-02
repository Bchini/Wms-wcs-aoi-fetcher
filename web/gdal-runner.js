// Runs the actual raster clip/mosaic/reproject entirely in the browser via
// gdal3.js (GDAL compiled to WebAssembly). No server-side processing at all,
// which is what lets this app run on Cloudflare's free Workers plan (no
// Containers, no paid plan).
//
// A multi-tile WMS mosaic is composited on a <canvas> instead of with GDAL:
// gdal3.js's gdalwarp() takes exactly one source dataset and it has no
// gdalbuildvrt. Every GetMap tile is requested in the target CRS at exactly
// the target resolution, so it already sits on the output pixel grid -- it is
// drawn at its pixel offset with no resampling or reprojection. GDAL (loaded
// in parallel with the downloads) is only used once at the end, to wrap the
// composited PNG into a georeferenced GeoTIFF.

const GDAL_VERSION = '2.8.1';
const GDAL_CDN_BASE = `https://cdn.jsdelivr.net/npm/gdal3.js@${GDAL_VERSION}/dist/package`;
const GDAL_SCRIPT_INTEGRITY = 'sha384-yW4c2Jx7lsREjJg58+ZI5U6gAso2bRAPw3LdzPWm7z8+rMJ24R7AS+EFyXDPxgYM';

function loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    if (integrity) {
      script.integrity = integrity;
      script.crossOrigin = 'anonymous';
    }
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove(); // a failed tag must not linger, or a retry would stack a second one
      reject(new Error(`Could not load ${src}`));
    };
    document.head.appendChild(script);
  });
}

let gdalPromise = null;
/**
 * Load gdal3.js (once) and return its initialized API object. A failed load
 * is not cached, so a transient CDN error doesn't need a page reload.
 */
export function loadGdal() {
  if (!gdalPromise) {
    gdalPromise = loadScript(`${GDAL_CDN_BASE}/gdal3.js`, GDAL_SCRIPT_INTEGRITY)
      .then(() => window.initGdalJs({ path: GDAL_CDN_BASE, useWorker: false }))
      .catch((error) => {
        gdalPromise = null;
        throw error;
      });
  }
  return gdalPromise;
}

function outputPath(filePath) {
  return filePath.local || filePath.real || filePath;
}

async function fetchViaProxy(url) {
  const response = await fetch(`/api/proxy?url=${encodeURIComponent(url)}`);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let detail = text;
    try {
      detail = JSON.parse(text).error || text; // the proxy answers errors as {"error": "..."}
    } catch {
      // not JSON -- keep the raw text
    }
    throw new Error(detail || `The source server returned HTTP ${response.status}.`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Fetch a single WCS GetCoverage response and clip/reproject it onto
 * [minx, miny, maxx, maxy] at `resolution`. Returns a GeoTIFF Blob.
 */
export async function runWcs({ url, bounds, resolution, crs }, onProgress) {
  const Gdal = await loadGdal();
  onProgress?.({ phase: 'fetching', done: 0, total: 1 });
  const bytes = await fetchViaProxy(url);
  onProgress?.({ phase: 'fetching', done: 1, total: 1 });

  onProgress?.({ phase: 'processing', done: 0, total: 1 });
  const opened = await Gdal.open(new File([bytes], 'coverage.tif'));
  const [source] = opened.datasets;
  if (!source) {
    throw new Error('The server did not return a readable coverage.');
  }
  try {
    const [minx, miny, maxx, maxy] = bounds;
    const clipped = await Gdal.gdalwarp(source, [
      '-of', 'GTiff',
      '-t_srs', crs,
      '-te', String(minx), String(miny), String(maxx), String(maxy),
      '-tr', String(resolution), String(resolution),
      '-co', 'COMPRESS=DEFLATE',
    ]);
    const outBytes = await Gdal.getFileBytes(outputPath(clipped));
    onProgress?.({ phase: 'processing', done: 1, total: 1 });
    return new Blob([outBytes], { type: 'image/tiff' });
  } finally {
    Gdal.close(source);
  }
}

const TILE_CONCURRENCY = 3; // polite to public GIS servers, still ~3x faster than one at a time

/** Run `worker` over `items` with at most `limit` in flight; stops starting new items after a failure. */
async function mapPool(items, limit, worker) {
  let next = 0;
  let failed = false;
  const lane = async () => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        await worker(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/** Decode a GetMap response, turning "the server answered with an XML error" into a readable message. */
async function decodeTile(bytes, tile) {
  try {
    return await createImageBitmap(new Blob([bytes]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    const head = new TextDecoder().decode(bytes.subarray(0, 300)).trim();
    const detail = head.startsWith('<') ? ` The server said: ${head.replace(/\s+/g, ' ')}` : '';
    throw new Error(`Tile r${tile.row}c${tile.col} was not a readable image.${detail}`);
  }
}

/**
 * Fetch every WMS GetMap tile in `tiles`, draw each at its pixel offset on a
 * canvas covering [minx, miny, maxx, maxy], and wrap the result in a
 * georeferenced GeoTIFF Blob. Areas with no fetched tile (tiles the user left
 * out) stay transparent.
 */
export async function runWms({ tiles, bounds, resolution, crs }, onProgress) {
  const [minx, miny, maxx, maxy] = bounds;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((maxx - minx) / resolution));
  canvas.height = Math.max(1, Math.round((maxy - miny) / resolution));
  const ctx = canvas.getContext('2d');

  const gdalReady = loadGdal();
  gdalReady.catch(() => {}); // surfaced where it is awaited; avoids an unhandled rejection if a tile fails first

  const total = tiles.length;
  let done = 0;
  onProgress?.({ phase: 'tiles', done, total });
  await mapPool(tiles, TILE_CONCURRENCY, async (tile) => {
    const bitmap = await decodeTile(await fetchViaProxy(tile.url), tile);
    try {
      const x = Math.round((tile.txmin - minx) / resolution);
      const y = Math.round((maxy - tile.tymax) / resolution);
      // Scaled to the planned size so a server that clamps the image still lands on the grid.
      ctx.drawImage(bitmap, x, y, tile.width, tile.height);
    } finally {
      bitmap.close();
    }
    done += 1;
    onProgress?.({ phase: 'tiles', done, total });
  });

  onProgress?.({ phase: 'compositing', done: 0, total: 1 });
  const Gdal = await gdalReady;
  const compositedBlob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The mosaic is too large for this browser to encode.'))),
      'image/png'
    )
  );
  const opened = await Gdal.open(new File([compositedBlob], 'composited.png'));
  const [composited] = opened.datasets;
  if (!composited) throw new Error('Could not read back the composited mosaic.');
  try {
    const finalTif = await Gdal.gdal_translate(composited, [
      '-of', 'GTiff',
      '-a_srs', crs,
      '-a_ullr', String(minx), String(maxy), String(maxx), String(miny),
      '-co', 'COMPRESS=DEFLATE',
    ]);
    const finalBytes = await Gdal.getFileBytes(outputPath(finalTif));
    onProgress?.({ phase: 'compositing', done: 1, total: 1 });
    return new Blob([finalBytes], { type: 'image/tiff' });
  } finally {
    Gdal.close(composited);
  }
}
