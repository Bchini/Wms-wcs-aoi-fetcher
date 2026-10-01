// Minimal 2D computational geometry for "does this WMS tile touch the AOI":
// point-in-polygon (ray casting, even-odd across rings so a hole ring
// correctly excludes its interior) and segment intersection, combined into
// a polygon-vs-axis-aligned-rectangle overlap test. Not a general-purpose
// geometry engine -- no curves, no proper winding rules beyond even-odd --
// but enough to pick which tiles a real-world AOI polygon actually covers.

/** Even-odd point-in-polygon test across every ring in `rings` (outer + holes). */
export function pointInRings(point, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const crosses = yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
      if (crosses) inside = !inside;
    }
  }
  return inside;
}

/** Whether segments p1-p2 and p3-p4 cross (not just touch at an endpoint). */
function segmentsIntersect(p1, p2, p3, p4) {
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  return (d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0);
}

/**
 * Whether a polygon (`rings`: an array of rings, each an array of [x, y]
 * points, outer ring first per GeoJSON convention) overlaps the
 * axis-aligned rectangle [minx, miny, maxx, maxy]. Three checks, any one
 * is sufficient: a polygon vertex landing inside the rect, a rect corner
 * landing inside the polygon, or an edge crossing -- that last one is what
 * catches a polygon that passes straight through the rect without either
 * shape having a vertex inside the other.
 */
export function polygonIntersectsRect(rings, rect) {
  const [minx, miny, maxx, maxy] = rect;
  const corners = [
    [minx, miny],
    [maxx, miny],
    [maxx, maxy],
    [minx, maxy],
  ];
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x >= minx && x <= maxx && y >= miny && y <= maxy) return true;
    }
  }
  if (corners.some((corner) => pointInRings(corner, rings))) return true;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      for (let k = 0; k < 4; k += 1) {
        if (segmentsIntersect(a, b, corners[k], corners[(k + 1) % 4])) return true;
      }
    }
  }
  return false;
}
