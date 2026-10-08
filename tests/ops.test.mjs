import { test } from "node:test";
import assert from "node:assert/strict";
import * as ops from "../js/ops.js";

const solid = (w, h, rgba) => {
  const img = ops.makeImage(w, h);
  for (let i = 0; i < w * h; i++) img.data.set(rgba, i * 4);
  return img;
};

test("adjust with no options is identity", () => {
  const img = solid(4, 4, [10, 120, 250, 200]);
  assert.deepEqual([...ops.adjust(img, {}).data], [...img.data]);
});

test("brightness and contrast move values the right way", () => {
  const img = solid(2, 2, [100, 100, 100, 255]);
  assert.ok(ops.adjust(img, { brightness: 50 }).data[0] > 100);
  assert.ok(ops.adjust(img, { brightness: -50 }).data[0] < 100);
  assert.ok(ops.adjust(img, { contrast: 50 }).data[0] < 100); // below mid-gray gets darker
});

test("saturation -100 makes gray, alpha preserved", () => {
  const out = ops.adjust(solid(1, 1, [200, 50, 50, 77]), { saturation: -100 });
  assert.equal(out.data[0], out.data[1]);
  assert.equal(out.data[1], out.data[2]);
  assert.equal(out.data[3], 77);
});

test("warmth shifts red up and blue down", () => {
  const out = ops.adjust(solid(1, 1, [100, 100, 100, 255]), { warmth: 50 });
  assert.ok(out.data[0] > 100 && out.data[2] < 100);
});

test("looks: mono is gray, invert inverts, all names work", () => {
  const img = solid(2, 2, [200, 40, 90, 255]);
  const m = ops.look(img, "mono");
  assert.equal(m.data[0], m.data[1]);
  assert.equal(ops.look(img, "invert").data[0], 55);
  for (const n of ops.LOOK_NAMES) assert.equal(ops.look(img, n).data.length, img.data.length);
});

test("blur keeps a flat image flat and spreads an impulse", () => {
  const flat = ops.blur(solid(9, 9, [80, 80, 80, 255]), 3);
  assert.ok(flat.data.every((v, i) => (i % 4 === 3 ? v === 255 : Math.abs(v - 80) <= 1)));
  const imp = solid(9, 9, [0, 0, 0, 255]);
  imp.data[(4 * 9 + 4) * 4] = 255;
  const b = ops.blur(imp, 2);
  assert.ok(b.data[(4 * 9 + 4) * 4] < 255 && b.data[(4 * 9 + 5) * 4] > 0);
});

test("sharpen 0 is identity", () => {
  const img = solid(3, 3, [1, 2, 3, 4]);
  assert.deepEqual([...ops.sharpen(img, 0).data], [...img.data]);
});

test("crop copies the right pixels and pads outside", () => {
  const img = ops.makeImage(3, 3);
  for (let i = 0; i < 9; i++) img.data[i * 4] = i;
  const c = ops.crop(img, 1, 1, 2, 2);
  assert.deepEqual([c.data[0], c.data[4], c.data[8], c.data[12]], [4, 5, 7, 8]);
  const o = ops.crop(img, 2, 2, 2, 2);
  assert.equal(o.data[4 * 3], 0);
});

test("pixelateRect averages blocks only inside the rect", () => {
  const img = ops.makeImage(4, 1);
  img.data.set([0, 0, 0, 255, 100, 100, 100, 255, 50, 0, 0, 255, 50, 0, 0, 255]);
  ops.pixelateRect(img, 0, 0, 2, 1, 2);
  assert.equal(img.data[0], 50);
  assert.equal(img.data[4], 50);
  assert.equal(img.data[8], 50);
});

test("blurRect leaves outside pixels untouched", () => {
  const img = ops.makeImage(10, 1);
  for (let i = 0; i < 10; i++) img.data.set([i * 20, 0, 0, 255], i * 4);
  ops.blurRect(img, 5, 0, 5, 1, 2);
  for (let i = 0; i < 5; i++) assert.equal(img.data[i * 4], i * 20);
});

test("normalizeMask maps to 0..255 with firm ends", () => {
  const m = ops.normalizeMask(Float32Array.from([-2, 0, 2]));
  assert.equal(m[0], 0);
  assert.equal(m[2], 255);
  assert.ok(m[1] > 100 && m[1] < 155);
});

test("applyAlpha multiplies alpha", () => {
  const out = ops.applyAlpha(solid(2, 1, [9, 9, 9, 255]), Uint8ClampedArray.from([0, 128]));
  assert.equal(out.data[3], 0);
  assert.equal(out.data[7], 128);
});

test("u2netInput is CHW normalized", () => {
  const t = ops.u2netInput(Uint8ClampedArray.from([255, 0, 0, 255]), 1);
  assert.equal(t.length, 3);
  assert.ok(Math.abs(t[0] - (1 - 0.485) / 0.229) < 1e-5);
  assert.ok(Math.abs(t[1] - (0 - 0.456) / 0.224) < 1e-5);
});

test("rotatedCropSize: 0 is identity, 45deg square halves area", () => {
  assert.deepEqual(ops.rotatedCropSize(100, 50, 0), { width: 100, height: 50 });
  const r = ops.rotatedCropSize(100, 100, Math.PI / 4);
  assert.ok(Math.abs(r.width - 70) <= 1);
});

test("fitSize and formatBytes", () => {
  assert.deepEqual(ops.fitSize(4000, 2000, 1000, 1000), { width: 1000, height: 500 });
  assert.deepEqual(ops.fitSize(10, 10, 1000, 1000), { width: 10, height: 10 });
  assert.equal(ops.formatBytes(512), "512 B");
  assert.equal(ops.formatBytes(2048), "2.0 KB");
  assert.equal(ops.formatBytes(3 * 1024 * 1024), "3.0 MB");
});
