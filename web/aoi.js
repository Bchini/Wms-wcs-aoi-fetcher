// Reads a GeoJSON document two ways: boundsFromGeoJson() for its overall
// bounding box in EPSG:4326 (used to shrink the requested extent/resolution
// budget, for any geometry type), and polygonsFromGeoJson() for its actual
// polygon rings (used together with web/geometry.js to decide which WMS
// tiles really touch the AOI shape, not just its bounding box). Every
// GeoJSON coordinate is EPSG:4326 per RFC 7946. No shapefile/KML support --
// those need a real parser (or GDAL/OGR itself) this app doesn't run
// client-side.

function walkCoordinates(node, onPoint) {
  if (!Array.isArray(node)) return;
  if (typeof node[0] === 'number' && typeof node[1] === 'number') {
    onPoint(node[0], node[1]);
    return;
  }
  for (const child of node) walkCoordinates(child, onPoint);
}

function walkGeometry(geometry, onPoint) {
  if (!geometry) return;
  if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries || []) walkGeometry(child, onPoint);
    return;
  }
  walkCoordinates(geometry.coordinates, onPoint);
}

/**
 * The [minLon, minLat, maxLon, maxLat] bounding box of every coordinate in
 * a parsed GeoJSON document (a Feature, a FeatureCollection, or a bare
 * geometry). Throws if it carries no usable coordinate, or only a single
 * point (not enough to define an area).
 */
export function boundsFromGeoJson(geojson) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  const onPoint = (lon, lat) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  };

  const type = geojson?.type;
  if (type === 'FeatureCollection') {
    for (const feature of geojson.features || []) walkGeometry(feature?.geometry, onPoint);
  } else if (type === 'Feature') {
    walkGeometry(geojson.geometry, onPoint);
  } else if (type) {
    walkGeometry(geojson, onPoint);
  }

  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
    throw new Error('No usable coordinates found in this GeoJSON file.');
  }
  if (minLon === maxLon || minLat === maxLat) {
    throw new Error('This AOI has no area (looks like a single point, not a polygon).');
  }
  return [minLon, minLat, maxLon, maxLat];
}

function collectPolygons(geometry, out) {
  if (!geometry) return;
  if (geometry.type === 'Polygon') out.push(geometry.coordinates);
  else if (geometry.type === 'MultiPolygon') out.push(...geometry.coordinates);
  else if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries || []) collectPolygons(child, out);
  }
}

/**
 * Every polygon in a parsed GeoJSON document, each as an array of rings
 * (outer ring first, holes after, per GeoJSON's own Polygon/MultiPolygon
 * nesting), all in EPSG:4326. Non-polygon geometries (Point, LineString)
 * are skipped -- there's no "does a tile touch this" test for a bare point
 * or line that's more useful than the bounding-box fallback already covers.
 * Returns [] if the document has no polygon geometry at all.
 */
export function polygonsFromGeoJson(geojson) {
  const polygons = [];
  const type = geojson?.type;
  if (type === 'FeatureCollection') {
    for (const feature of geojson.features || []) collectPolygons(feature?.geometry, polygons);
  } else if (type === 'Feature') {
    collectPolygons(geojson.geometry, polygons);
  } else if (type) {
    collectPolygons(geojson, polygons);
  }
  return polygons;
}
