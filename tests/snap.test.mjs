import { test } from "node:test";
import assert from "node:assert/strict";
import { targetsFrom, snapBox, snapPoint } from "../js/snap.js";

const canvas = { x: 0, y: 0, w: 1000, h: 800 };

test("snaps a box's edge to the canvas edge within tolerance only", () => {
  const t = targetsFrom([canvas]);
  const near = snapBox({ x: 4, y: 200, w: 100, h: 100 }, t, 6);
  assert.equal(near.dx, -4);
  assert.equal(near.dy, 0);
  assert.equal(near.guides.length, 1);
  assert.equal(near.guides[0].axis, "x");
  assert.equal(snapBox({ x: 20, y: 300, w: 100, h: 100 }, t, 6).dx, 0);
});

test("snaps centre to centre and right edge to right edge", () => {
  const t = targetsFrom([canvas]);
  assert.equal(snapBox({ x: 448, y: 10, w: 100, h: 50 }, t, 6).dx, 2); // centre 498 -> 500
  assert.equal(snapBox({ x: 897, y: 10, w: 100, h: 50 }, t, 6).dx, 3); // right 997 -> 1000
  assert.equal(snapBox({ x: 100, y: 352, w: 100, h: 100 }, t, 6).dy, -2); // centre 402 -> 400
});

test("snaps side by side to another layer and picks the closest line", () => {
  const t = targetsFrom([canvas, { x: 200, y: 200, w: 100, h: 100 }]);
  // left edge 303 is 3 from the other layer's right edge (300)
  const r = snapBox({ x: 303, y: 600, w: 50, h: 50 }, t, 6);
  assert.equal(r.dx, -3);
  // guide spans from the other layer down to the moved box
  assert.deepEqual([r.guides[0].v, r.guides[0].from, r.guides[0].to], [300, 200, 650]);
});

test("axes limit snapping (used when Shift locks an axis)", () => {
  const t = targetsFrom([canvas]);
  const r = snapBox({ x: 3, y: 2, w: 10, h: 10 }, t, 6, "y");
  assert.equal(r.dx, 0);
  assert.equal(r.dy, -2);
});

test("snapPoint snaps a handle to lines", () => {
  const t = targetsFrom([canvas]);
  const r = snapPoint({ x: 996, y: 401 }, t, 6);
  assert.deepEqual([r.x, r.y, r.guides.length], [1000, 400, 2]);
  assert.deepEqual([snapPoint({ x: 700, y: 650 }, t, 6).x, snapPoint({ x: 700, y: 650 }, t, 6).guides.length], [700, 0]);
});
