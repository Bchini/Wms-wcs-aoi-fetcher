import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointInRings, polygonIntersectsRect } from '../web/geometry.js';

const SQUARE = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]; // one ring, outer only

test('pointInRings: a point clearly inside the polygon', () => {
  assert.equal(pointInRings([5, 5], SQUARE), true);
});

test('pointInRings: a point clearly outside the polygon', () => {
  assert.equal(pointInRings([15, 15], SQUARE), false);
});

test('pointInRings: a hole ring excludes its interior', () => {
  const withHole = [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]],
  ];
  assert.equal(pointInRings([5, 5], withHole), false); // inside the hole
  assert.equal(pointInRings([1, 1], withHole), true); // inside the ring, outside the hole
});

test('polygonIntersectsRect: rect fully inside the polygon', () => {
  assert.equal(polygonIntersectsRect(SQUARE, [2, 2, 8, 8]), true);
});

test('polygonIntersectsRect: polygon fully inside the rect', () => {
  assert.equal(polygonIntersectsRect(SQUARE, [-5, -5, 15, 15]), true);
});

test('polygonIntersectsRect: a polygon vertex lands inside the rect', () => {
  assert.equal(polygonIntersectsRect(SQUARE, [5, 5, 15, 15]), true);
});

test('polygonIntersectsRect: disjoint shapes', () => {
  assert.equal(polygonIntersectsRect(SQUARE, [100, 100, 110, 110]), false);
});

test('polygonIntersectsRect: a thin polygon strip passes through the rect with no vertex or corner inside either', () => {
  // A long thin rectangle polygon spanning x=-100..100, y=4..6, crossing a
  // tile rect at x=0..10, y=0..10 -- neither shape's vertices land inside
  // the other, only edges cross. This is exactly the case the edge-crossing
  // check exists for.
  const strip = [[[-100, 4], [100, 4], [100, 6], [-100, 6], [-100, 4]]];
  assert.equal(polygonIntersectsRect(strip, [0, 0, 10, 10]), true);
});

test('polygonIntersectsRect: an L-shaped AOI correctly skips the tile in its missing corner', () => {
  // L-shape covering the left column and bottom row of a 3x3 grid (tiles
  // 0..10 each), missing the top-right tile at [20,20,30,30].
  const lShape = [
    [[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30], [0, 0]],
  ];
  assert.equal(polygonIntersectsRect(lShape, [0, 0, 10, 10]), true); // bottom-left
  assert.equal(polygonIntersectsRect(lShape, [20, 0, 30, 10]), true); // bottom-right (bottom row)
  assert.equal(polygonIntersectsRect(lShape, [0, 20, 10, 30]), true); // top-left (left column)
  assert.equal(polygonIntersectsRect(lShape, [20, 20, 30, 30]), false); // the missing corner
});
