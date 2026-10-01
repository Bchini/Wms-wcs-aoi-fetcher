import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wmsBbox,
  wmsCrsParameter,
  bboxParamToGeographic,
  serviceUrl,
  tileGrid,
  planWmsTiles,
  resolutionOptions,
  customResolution,
  reprojectAoiBounds,
  intersectBounds,
  webMercatorToLonLat,
  reprojectLonLat,
  reprojectPointToLonLat,
  reprojectPolygonsToCrs,
  tileKey,
  tilesIntersectingPolygons,
} from '../web/ogc.js';

test('wmsBbox: WMS 1.3 EPSG:4326 uses latitude first', () => {
  assert.equal(wmsBbox(1, 2, 3, 4, 'EPSG:4326', '1.3.0'), '2,1,4,3');
});

test('wmsBbox: WMS 1.1.1 keeps easting first', () => {
  assert.equal(wmsBbox(1, 2, 3, 4, 'EPSG:4326', '1.1.1'), '1,2,3,4');
});

test('wmsBbox: projected CRS is never swapped, any version', () => {
  assert.equal(wmsBbox(1, 2, 3, 4, 'EPSG:31982', '1.3.0'), '1,2,3,4');
});

test('wmsCrsParameter matches version', () => {
  assert.equal(wmsCrsParameter('1.3.0'), 'CRS');
  assert.equal(wmsCrsParameter('1.1.1'), 'SRS');
});

test('bboxParamToGeographic is the inverse of wmsBbox', () => {
  const wire = wmsBbox(1, 2, 3, 4, 'EPSG:4326', '1.3.0').split(',').map(Number);
  assert.deepEqual(bboxParamToGeographic(wire, 'EPSG:4326', '1.3.0'), [1, 2, 3, 4]);
});

test('bboxParamToGeographic leaves non-4326/non-1.3 alone', () => {
  assert.deepEqual(bboxParamToGeographic([1, 2, 3, 4], 'EPSG:31982', '1.3.0'), [1, 2, 3, 4]);
  assert.deepEqual(bboxParamToGeographic([1, 2, 3, 4], 'EPSG:4326', '1.1.1'), [1, 2, 3, 4]);
});

test('serviceUrl extends an endpoint that already has a query string', () => {
  assert.equal(
    serviceUrl('https://example.test/wms?token=x', { request: 'GetMap' }),
    'https://example.test/wms?token=x&request=GetMap'
  );
});

test('serviceUrl adds a leading ? when the endpoint has none', () => {
  assert.equal(serviceUrl('https://example.test/wms', { a: '1' }), 'https://example.test/wms?a=1');
});

test('tileGrid: exact multiple of tile size', () => {
  assert.deepEqual(tileGrid(0, 0, 2048, 1024, 1024, 1024, 1), { cols: 2, rows: 1 });
});

test('tileGrid: never returns zero tiles for a nonempty extent', () => {
  assert.deepEqual(tileGrid(0, 0, 0.5, 0.5, 1024, 1024, 1), { cols: 1, rows: 1 });
});

test('planWmsTiles: single tile covers the whole extent', () => {
  const tiles = planWmsTiles({ minx: 0, miny: 0, maxx: 10, maxy: 10, tileW: 1024, tileH: 1024, resolution: 1 });
  assert.equal(tiles.length, 1);
  assert.deepEqual(
    [tiles[0].txmin, tiles[0].tymin, tiles[0].txmax, tiles[0].tymax],
    [0, 0, 10, 10]
  );
  assert.equal(tiles[0].width, 10);
  assert.equal(tiles[0].height, 10);
});

test('planWmsTiles: multiple tiles partition the extent without gaps or overlap', () => {
  const tiles = planWmsTiles({ minx: 0, miny: 0, maxx: 20, maxy: 10, tileW: 10, tileH: 10, resolution: 1 });
  assert.equal(tiles.length, 2);
  assert.equal(tiles[0].txmin, 0);
  assert.equal(tiles[0].txmax, 10);
  assert.equal(tiles[1].txmin, 10);
  assert.equal(tiles[1].txmax, 20);
});

test('resolutionOptions: a small area offers every preset, finest first is sharper', () => {
  const options = resolutionOptions([0, 0, 1, 1]);
  assert.ok(options.length >= 2);
  // Each subsequent preset should be equal-or-finer (smaller resolution
  // value = more pixels) than the previous one.
  for (let i = 1; i < options.length; i += 1) {
    assert.ok(options[i].resolution <= options[i - 1].resolution);
  }
  const standard = options.find((o) => o.label === 'Standard');
  assert.ok(standard);
  assert.equal(Math.max(standard.width, standard.height), 2048);
});

test('resolutionOptions: an enormous area still returns at least one option within budget', () => {
  // A full-continent-scale bbox in degrees -- Standard/High/Maximum would
  // all blow the pixel budget at naive presets, Preview should still fit.
  const options = resolutionOptions([-180, -90, 180, 90]);
  assert.ok(options.length >= 1);
  for (const option of options) {
    assert.ok(option.width * option.height <= 25_000_000);
  }
});

test('resolutionOptions: never proposes more tiles than the WMS tile cap', () => {
  const options = resolutionOptions([-19, 27, 5, 44], { maxTiles: 64, tileSize: 1024 });
  for (const option of options) {
    assert.ok(option.tiles <= 64);
  }
});

test('resolutionOptions: always returns at least one option, even in a pathological case', () => {
  const options = resolutionOptions([-1e7, -1e7, 1e7, 1e7], { maxPixels: 100 });
  assert.equal(options.length, 1);
  assert.equal(options[0].label, 'Maximum (capped)');
  assert.ok(options[0].width * options[0].height <= 100 * 4); // rounding slack
});

test('customResolution: derives height from the requested width, preserving aspect', () => {
  const result = customResolution([0, 0, 20, 10], 4000);
  assert.equal(result.width, 4000);
  assert.equal(result.height, 2000);
});

test('customResolution: rejects a width over the pixel budget', () => {
  assert.throws(() => customResolution([0, 0, 1, 1], 100_000, { maxPixels: 1_000_000 }), /million output pixels/);
});

test('customResolution: rejects a width needing too many WMS tiles', () => {
  assert.throws(
    () => customResolution([0, 0, 100, 100], 50_000, { maxPixels: 1e12, maxTiles: 64, tileSize: 1024 }),
    /WMS tiles/
  );
});

test('customResolution: maxTiles: Infinity bypasses the tile check (for WCS, which is never tiled)', () => {
  const result = customResolution([0, 0, 100, 100], 50_000, { maxPixels: 1e12, maxTiles: Infinity });
  assert.equal(result.width, 50_000);
});

test('customResolution: rejects a non-positive or non-finite width', () => {
  assert.throws(() => customResolution([0, 0, 1, 1], 0), /Enter a whole number/);
  assert.throws(() => customResolution([0, 0, 1, 1], NaN), /Enter a whole number/);
});

test('reprojectAoiBounds: EPSG:4326 and CRS:84 pass through unchanged', () => {
  const bounds = [7.5, 43.8, 10.0, 44.6];
  assert.deepEqual(reprojectAoiBounds(bounds, 'EPSG:4326'), bounds);
  assert.deepEqual(reprojectAoiBounds(bounds, 'CRS:84'), bounds);
});

test('reprojectAoiBounds: converts to EPSG:3857', () => {
  const [minx, miny, maxx, maxy] = reprojectAoiBounds([0, 0, 1, 1], 'EPSG:3857');
  assert.ok(Math.abs(minx) < 1e-6 && Math.abs(miny) < 1e-6);
  assert.ok(maxx > 0 && maxy > 0);
});

test('reprojectAoiBounds: null for a CRS with no closed-form conversion', () => {
  assert.equal(reprojectAoiBounds([0, 0, 1, 1], 'EPSG:25832'), null);
});

test('intersectBounds: overlapping boxes', () => {
  assert.deepEqual(intersectBounds([0, 0, 10, 10], [5, 5, 15, 15]), [5, 5, 10, 10]);
});

test('intersectBounds: null when the boxes do not overlap', () => {
  assert.equal(intersectBounds([0, 0, 1, 1], [5, 5, 6, 6]), null);
});

test('webMercatorToLonLat is the inverse of lonLatToWebMercator', () => {
  const [x, y] = [835_690, 5_430_798];
  const [lon, lat] = webMercatorToLonLat(x, y);
  const back = reprojectLonLat(lon, lat, 'EPSG:3857');
  assert.ok(Math.abs(back[0] - x) < 1e-3);
  assert.ok(Math.abs(back[1] - y) < 1e-3);
});

test('reprojectLonLat: EPSG:4326/CRS:84 pass through, EPSG:3857 converts, others are null', () => {
  assert.deepEqual(reprojectLonLat(7.5, 43.8, 'EPSG:4326'), [7.5, 43.8]);
  assert.deepEqual(reprojectLonLat(7.5, 43.8, 'CRS:84'), [7.5, 43.8]);
  assert.notEqual(reprojectLonLat(7.5, 43.8, 'EPSG:3857')[0], 7.5);
  assert.equal(reprojectLonLat(7.5, 43.8, 'EPSG:25832'), null);
});

test('reprojectPointToLonLat round-trips through EPSG:3857', () => {
  const [x, y] = reprojectLonLat(7.5, 43.8, 'EPSG:3857');
  const [lon, lat] = reprojectPointToLonLat(x, y, 'EPSG:3857');
  assert.ok(Math.abs(lon - 7.5) < 1e-6);
  assert.ok(Math.abs(lat - 43.8) < 1e-6);
});

test('reprojectPolygonsToCrs reprojects every vertex, preserving ring structure', () => {
  const polygons = [[[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]];
  const reprojected = reprojectPolygonsToCrs(polygons, 'EPSG:3857');
  assert.equal(reprojected.length, 1);
  assert.equal(reprojected[0][0].length, 5);
  assert.ok(Math.abs(reprojected[0][0][0][0]) < 1e-6 && Math.abs(reprojected[0][0][0][1]) < 1e-6);
  assert.ok(reprojected[0][0][1][0] > 0); // lon=1 -> positive x in Web Mercator
});

test('reprojectPolygonsToCrs returns null for an unsupported CRS', () => {
  const polygons = [[[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]];
  assert.equal(reprojectPolygonsToCrs(polygons, 'EPSG:25832'), null);
});

test('tileKey is stable and unique per row/col', () => {
  assert.equal(tileKey({ row: 1, col: 2 }), '1,2');
  assert.notEqual(tileKey({ row: 1, col: 2 }), tileKey({ row: 2, col: 1 }));
});

test('tilesIntersectingPolygons: only tiles actually touching a triangular AOI are selected', () => {
  const tiles = [
    { row: 0, col: 0, txmin: 0, tymin: 0, txmax: 10, tymax: 10 },
    { row: 0, col: 1, txmin: 10, tymin: 0, txmax: 20, tymax: 10 },
    { row: 1, col: 0, txmin: 0, tymin: 10, txmax: 10, tymax: 20 },
    { row: 1, col: 1, txmin: 10, tymin: 10, txmax: 20, tymax: 20 }, // well clear of the triangle below
  ];
  // Triangle (0,0)-(15,0)-(0,15): reaches into the bottom-left, bottom-right
  // and top-left tiles, but stays 5 units clear of the top-right tile's
  // nearest corner (10,10) -- no boundary-touching ambiguity.
  const triangle = [[[[0, 0], [15, 0], [0, 15], [0, 0]]]];
  const selected = tilesIntersectingPolygons(tiles, triangle);
  assert.deepEqual([...selected].sort(), ['0,0', '0,1', '1,0']);
});
