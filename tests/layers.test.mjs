// Moving a layer off the canvas and back must not crop it. Runs the real Move
// tool against a tiny fake canvas (binary alpha is enough to check geometry).
import { test } from "node:test";
import assert from "node:assert/strict";

class FakeCanvas {
  constructor() { this._w = 0; this._h = 0; this.data = new Uint8ClampedArray(0); }
  get width() { return this._w; } set width(v) { this._w = v; this.data = new Uint8ClampedArray(this._w * this._h * 4); }
  get height() { return this._h; } set height(v) { this._h = v; this.data = new Uint8ClampedArray(this._w * this._h * 4); }
  getContext() { return this._ctx ||= new FakeCtx(this); }
}
class FakeCtx {
  constructor(c) { this.canvas = c; this.globalCompositeOperation = "source-over"; this.fillStyle = [255, 0, 0, 255]; }
  set(x, y, px) { const c = this.canvas; if (x < 0 || y < 0 || x >= c.width || y >= c.height) return; c.data.set(px, (y * c.width + x) * 4); }
  get(x, y) { const c = this.canvas; return x < 0 || y < 0 || x >= c.width || y >= c.height ? [0, 0, 0, 0] : [...c.data.subarray((y * c.width + x) * 4, (y * c.width + x) * 4 + 4)]; }
  blit(srcAt, sx0, sy0, w, h) {
    const op = this.globalCompositeOperation, c = this.canvas, clearOutside = op === "source-in" || op === "destination-in";
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const inside = x >= sx0 && y >= sy0 && x < sx0 + w && y < sy0 + h;
      if (!inside && !clearOutside) continue;
      const s = inside ? srcAt(x - sx0, y - sy0) : [0, 0, 0, 0], d = this.get(x, y);
      if (op === "source-over") { if (s[3]) this.set(x, y, s); }
      else if (op === "destination-out") { if (s[3]) this.set(x, y, [0, 0, 0, 0]); }
      else if (op === "source-in") this.set(x, y, d[3] ? s : [0, 0, 0, 0]);
      else if (op === "destination-in") this.set(x, y, s[3] ? d : [0, 0, 0, 0]);
    }
  }
  drawImage(img, ...a) {
    let sx = 0, sy = 0, sw = img.width, sh = img.height, dx, dy;
    if (a.length === 2) [dx, dy] = a; else if (a.length === 4) [dx, dy] = a; else [sx, sy, sw, sh, dx, dy] = a;
    const ic = img.getContext();
    this.blit((x, y) => ic.get(sx + x, sy + y), Math.round(dx), Math.round(dy), sw, sh);
  }
  fillRect(x, y, w, h) { const f = this.fillStyle; this.blit(() => f, x, y, w, h); }
  clearRect(x, y, w, h) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, [0, 0, 0, 0]); }
  getImageData(x, y, w, h) { const out = new Uint8ClampedArray(w * h * 4); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.set(this.get(x + i, y + j), (j * w + i) * 4); return { data: out, width: w, height: h }; }
}
const el = () => ({ style: {}, classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, setAttribute() {}, append() {}, replaceChildren() {}, dataset: {} });
globalThis.document = { createElement: (t) => (t === "canvas" ? new FakeCanvas() : el()), createTextNode: () => el() };
globalThis.localStorage = { getItem: () => null, setItem() {} };

const { Doc, makeCanvas, makeLayer } = await import("../js/editor.js");
const { moveTool } = await import("../js/paint.js");

function setup() {
  const doc = new Doc(makeCanvas(10, 10));
  const top = makeCanvas(10, 10);
  top.getContext().fillRect(2, 2, 4, 4); // 4x4 block at (2,2)
  doc.layers.push(makeLayer(top, "Block")); doc.active = 1;
  const A = { doc, toast: (m) => { throw new Error(m); }, selectionChanged() {}, setSource() {}, redraw() {}, setCursorStyle() {} };
  return { doc, A, tool: moveTool(A) };
}
const drag = (tool, dx, dy) => { tool.down({ x: 0, y: 0 }); tool.move({ x: dx, y: dy }); tool.up(); };
const opaque = (doc) => { const c = doc.canvas.getContext(), out = []; for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if (c.get(x, y)[3]) out.push(`${x},${y}`); return out.sort().join(" "); };
const block = (x0, y0) => { const out = []; for (let y = y0; y < y0 + 4; y++) for (let x = x0; x < x0 + 4; x++) out.push(`${x},${y}`); return out.sort().join(" "); };

test("layer moved off the canvas comes back whole", () => {
  const { doc, tool } = setup();
  drag(tool, 7, 0);
  assert.equal(opaque(doc), ["9,2", "9,3", "9,4", "9,5"].sort().join(" "));
  // Work on something else in between: another layer, then a stroke on this one.
  doc.active = 0; doc.commit((c) => c.getContext().fillRect(0, 9, 1, 1));
  doc.active = 1; doc.commit((c) => c.getContext().fillRect(0, 0, 1, 1));
  drag(tool, -7, 0);
  assert.equal(opaque(doc), block(2, 2)); // the (0,0) dab went off the left edge
  drag(tool, 7, 0);
  assert.equal(opaque(doc), [...block(9, 2).split(" ").filter((p) => +p.split(",")[0] < 10), "0,0"].sort().join(" "));
});

test("selection moved off the canvas is kept on the layer", () => {
  const { doc, tool } = setup();
  const mask = makeCanvas(10, 10); mask.getContext().fillRect(2, 2, 4, 4);
  doc.selection = { mask, shapes: [{ kind: "rect", x: 2, y: 2, w: 4, h: 4 }] };
  drag(tool, 0, 6);
  assert.equal(opaque(doc), ["2,8", "3,8", "4,8", "5,8", "2,9", "3,9", "4,9", "5,9"].sort().join(" "));
  doc.selection = null; // deselect, then move the whole layer back
  drag(tool, 0, -6);
  assert.equal(opaque(doc), block(2, 2));
});

test("undo restores the off-canvas pixels too", () => {
  const { doc, tool } = setup();
  drag(tool, 8, 0); drag(tool, -8, 0);
  assert.equal(opaque(doc), block(2, 2));
  doc.undo(); doc.undo();
  assert.equal(opaque(doc), block(2, 2));
});

test("clear layer drops off-canvas pixels", () => {
  const { doc, tool } = setup();
  drag(tool, 9, 0);
  doc.commit(makeCanvas(10, 10), {}, { over: null });
  drag(tool, -9, 0);
  assert.equal(opaque(doc), "");
});
