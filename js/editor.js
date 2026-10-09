// Document model (the working canvas + undo history) and the viewport that
// draws it on screen with zoom and pan.

export function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(c) {
  return c.getContext("2d", { willReadFrequently: true });
}

export function copyCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext("2d").drawImage(src, 0, 0);
  return c;
}

export function getImageData(c) {
  return ctx2d(c).getImageData(0, 0, c.width, c.height);
}

export function canvasFromImageData(img) {
  const c = makeCanvas(img.width, img.height);
  const id = img instanceof ImageData ? img : new ImageData(img.data, img.width, img.height);
  c.getContext("2d").putImageData(id, 0, 0);
  return c;
}

/** High-quality downscale by repeated halving, then a final smooth step. */
export function resizeCanvas(src, w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  let cur = src;
  while (cur.width / 2 >= w && cur.height / 2 >= h) {
    const half = makeCanvas(Math.round(cur.width / 2), Math.round(cur.height / 2));
    const x = half.getContext("2d");
    x.imageSmoothingQuality = "high";
    x.drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  const out = makeCanvas(w, h);
  const x = out.getContext("2d");
  x.imageSmoothingQuality = "high";
  x.drawImage(cur, 0, 0, w, h);
  return out;
}

/*
 * Layers are stored at document size, but moving a layer partly off the
 * canvas must not destroy what went over the edge. layer.over keeps the whole
 * layer: { canvas, x, y, base }, where (x, y) is where the document's top-left
 * sits inside over.canvas and base is the document-size canvas cut from it.
 */

/** The whole layer, including pixels outside the document: { canvas, x, y }. */
export function layerExtent(layer, W, H) {
  const o = layer.over;
  if (!o) return { canvas: layer.canvas, x: 0, y: 0 };
  if (o.base === layer.canvas) return { canvas: o.canvas, x: o.x, y: o.y };
  // The visible part was edited since it was cut: keep those edits and what's off-canvas.
  const left = Math.min(0, o.x), top = Math.min(0, o.y);
  const right = Math.max(o.canvas.width, o.x + W), bottom = Math.max(o.canvas.height, o.y + H);
  const c = makeCanvas(right - left, bottom - top), x = c.getContext("2d");
  x.drawImage(o.canvas, -left, -top);
  x.clearRect(o.x - left, o.y - top, W, H);
  x.drawImage(layer.canvas, o.x - left, o.y - top);
  return { canvas: c, x: o.x - left, y: o.y - top };
}

/** Layer props ({ canvas, over }) for a whole layer placed with the document's top-left at (ext.x, ext.y). */
export function layerFromExtent(ext, W, H) {
  const canvas = makeCanvas(W, H);
  canvas.getContext("2d").drawImage(ext.canvas, -ext.x, -ext.y);
  const hidden = ext.x > 0 || ext.y > 0 || ext.x + W < ext.canvas.width || ext.y + H < ext.canvas.height;
  return { canvas, over: hidden ? { canvas: ext.canvas, x: ext.x, y: ext.y, base: canvas } : null };
}

const HISTORY_BUDGET = 400 * 1024 * 1024; // bytes of pixels kept for undo

export const BLEND_MODES = [
  ["source-over", "Normal"], ["multiply", "Multiply"], ["screen", "Screen"], ["overlay", "Overlay"],
  ["darken", "Darken"], ["lighten", "Lighten"], ["color-dodge", "Color dodge"], ["color-burn", "Color burn"],
  ["hard-light", "Hard light"], ["soft-light", "Soft light"], ["difference", "Difference"], ["exclusion", "Exclusion"],
  ["hue", "Hue"], ["saturation", "Saturation"], ["color", "Color"], ["luminosity", "Luminosity"],
];

let layerSeq = 0;
// Photoshop-style locks: alpha = transparent pixels, pixels = image pixels,
// position = moving/transforming, all = everything.
export const NO_LOCK = Object.freeze({ alpha: false, pixels: false, position: false, all: false });
/**
 * A layer is a full-document-size canvas plus display properties. Layer
 * objects are treated as immutable snapshots: edits replace the object (and a
 * canvas is never drawn into after it has been recorded in history), so undo
 * can keep references instead of pixel copies.
 */
export function makeLayer(canvas, name, props = {}) {
  return { id: ++layerSeq, name, canvas, visible: true, opacity: 1, blend: "source-over", meta: {}, lock: NO_LOCK, ...props };
}

export class Doc {
  /** Build a document from existing layers (e.g. an opened PSD). */
  static fromLayers(layers, width, height, name) {
    const d = new Doc(makeCanvas(width, height), name);
    d.layers = layers;
    d.active = layers.length - 1;
    d.original = copyCanvas(d.composite());
    return d;
  }

  constructor(canvas, name = "image") {
    this.width = canvas.width;
    this.height = canvas.height;
    this.layers = [makeLayer(canvas, "Background")];
    this.active = 0;
    this.original = copyCanvas(canvas);
    this.name = name;
    this.undoStack = [];
    this.redoStack = [];
    // History labels: every state remembers the step that produced it ("Brush",
    // "Merge down"...). label() names the next step; labeler() is the fallback.
    this.stateLabel = "Open";
    this.pendingLabel = null;
    this.labeler = null;
    this.trimmed = 0;      // oldest steps dropped by trim() to save memory
    this.historySeq = 0;   // bumped whenever the list of steps changes
    this.listeners = new Set();
    this.version = 0;
    this._composite = null;
    // Current selection: null, or { mask: canvas (alpha = selected), inverted? }.
    // Not part of undo history; cleared whenever the image size changes.
    this.selection = null;
  }

  /* ---- active layer shortcuts (what most tools edit) ---- */
  get layer() { return this.layers[this.active]; }
  get canvas() { return this.layer.canvas; }
  set canvas(c) { this.layers[this.active] = { ...this.layer, canvas: c }; this.touch(); }
  get meta() { return this.layer.meta; }
  set meta(m) { this.layers[this.active] = { ...this.layer, meta: m }; }

  onChange(fn) { this.listeners.add(fn); }
  emit() { this.touch(); for (const fn of this.listeners) fn(this); }
  touch() { this.version++; this._composite = null; }

  /** All visible layers flattened, optionally swapping in a preview for one layer. */
  composite(override = null, overrideIndex = this.active) {
    const only = this.layers.length === 1 && this.layers[0];
    if (only && only.visible && only.opacity === 1) return override || only.canvas; // fast path
    if (!override && this._composite) return this._composite;
    const out = makeCanvas(this.width, this.height);
    const x = out.getContext("2d");
    this.layers.forEach((l, i) => {
      if (!l.visible || l.opacity <= 0) return;
      x.globalAlpha = l.opacity;
      x.globalCompositeOperation = l.blend;
      x.drawImage(i === overrideIndex && override ? override : l.canvas, 0, 0, this.width, this.height);
    });
    if (!override) this._composite = out;
    return out;
  }

  get hasLayers() { return this.layers.length > 1; }

  /* ---- history ---- */
  snapshot() {
    return { layers: this.layers.slice(), active: this.active, width: this.width, height: this.height, label: this.stateLabel };
  }
  restore(s) {
    if (s.width !== this.width || s.height !== this.height) this.selection = null;
    this.layers = s.layers; this.active = s.active; this.width = s.width; this.height = s.height;
    if (s.label) this.stateLabel = s.label;
  }

  /** Name the next undo step, e.g. doc.label("Merge down").change(...). Applies to the next record() in this task only. */
  label(text) {
    this.pendingLabel = text;
    queueMicrotask(() => { if (this.pendingLabel === text) this.pendingLabel = null; });
    return this;
  }

  /** Start a new undo step. `fallback` names it unless label() did; then the app's labeler, then "Edit". */
  record(fallback) {
    this.undoStack.push(this.snapshot());
    this.stateLabel = this.pendingLabel || fallback || this.labeler?.() || "Edit";
    this.pendingLabel = null;
    this.redoStack = [];
    this.historySeq++;
    this.trim();
  }

  /**
   * Replace the active layer's pixels (canvas, or fn that draws into a copy).
   * `extra` overrides other layer props, e.g. { over: null } to drop off-canvas pixels.
   */
  commit(next, meta = {}, extra = {}) {
    this.record();
    // Text and shape layers turn into plain pixels when edited otherwise; the app tells the user.
    if (this.layer.meta?.text && !meta.text) this.rasterized = "text";
    else if (this.layer.meta?.shape && !meta.shape) this.rasterized = "shape";
    let c = next;
    if (typeof next === "function") { c = copyCanvas(this.canvas); next(c); }
    this.layers[this.active] = { ...this.layer, canvas: c, meta, ...extra };
    this.emit();
  }

  /** Start an in-place drawing gesture on the active layer (brush strokes). */
  begin() {
    this.record();
    this.layers[this.active] = { ...this.layer, canvas: copyCanvas(this.canvas), meta: { ...this.meta } };
  }

  /** Transform every layer (crop, resize, rotate...). fn(canvas) returns a new canvas. */
  commitAll(fn) {
    this.record();
    if (this.layers.some((l) => l.meta?.text)) this.rasterized = "text";
    else if (this.layers.some((l) => l.meta?.shape)) this.rasterized = "shape";
    this.layers = this.layers.map((l, i) => ({ ...l, canvas: fn(l.canvas, i), meta: {}, over: null }));
    const w = this.layers[0].canvas.width, hgt = this.layers[0].canvas.height;
    if (w !== this.width || hgt !== this.height) this.selection = null;
    this.width = w; this.height = hgt;
    this.emit();
  }

  /** Change layer structure/properties with one undo step. fn mutates this.layers/this.active. */
  change(fn) {
    this.record();
    fn(this);
    this.active = Math.max(0, Math.min(this.layers.length - 1, this.active));
    this.emit();
  }

  setLayerProps(i, props, recordHistory = true) {
    if (recordHistory) this.record(propsLabel(props));
    this.layers[i] = { ...this.layers[i], ...props };
    this.emit();
  }

  trim() {
    // Count each canvas once: snapshots share unchanged layers.
    const seen = new Set();
    let bytes = 0;
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      for (const l of this.undoStack[i].layers) {
        if (seen.has(l.canvas)) continue;
        seen.add(l.canvas);
        bytes += l.canvas.width * l.canvas.height * 4;
        if (l.over && !seen.has(l.over.canvas)) { seen.add(l.over.canvas); bytes += l.over.canvas.width * l.over.canvas.height * 4; }
      }
      if (bytes > HISTORY_BUDGET && i < this.undoStack.length - 2) {
        this.undoStack.splice(0, i + 1);
        this.trimmed += i + 1;
        this.historySeq++;
        break;
      }
    }
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  undo() { if (this.step(-1)) this.emit(); }
  redo() { if (this.step(1)) this.emit(); }

  /** Undo (dir < 0) or redo one step without notifying listeners. */
  step(dir) {
    const [from, to] = dir < 0 ? [this.undoStack, this.redoStack] : [this.redoStack, this.undoStack];
    if (!from.length) return false;
    to.push(this.snapshot());
    this.restore(from.pop());
    this.historySeq++;
    return true;
  }

  /**
   * The history list, oldest first: [{ label, state: "past"|"current"|"future" }].
   * Index i is the state after i steps since the oldest one kept (see `trimmed`).
   */
  get history() {
    const past = this.undoStack.map((s) => ({ label: s.label, state: "past" }));
    const future = this.redoStack.map((s) => ({ label: s.label, state: "future" })).reverse();
    return [...past, { label: this.stateLabel, state: "current" }, ...future];
  }
  get historyIndex() { return this.undoStack.length; }

  /** Jump to history entry i by undoing or redoing as many steps as needed, with one change notification. */
  goTo(i) {
    i = Math.max(0, Math.min(this.undoStack.length + this.redoStack.length, i));
    let n = i - this.undoStack.length;
    if (!n) return;
    const dir = Math.sign(n);
    for (; n; n -= dir) this.step(dir);
    this.emit();
  }
}

/** A readable history label for a setLayerProps() change. */
function propsLabel(p) {
  if ("visible" in p) return p.visible ? "Show layer" : "Hide layer";
  if ("name" in p) return "Rename layer";
  if ("blend" in p) return "Blend mode";
  if ("opacity" in p) return "Layer opacity";
  if ("lock" in p) return "Layer lock";
  return "Layer properties";
}

/** Screen viewport: draws a source canvas with zoom/pan and an overlay hook. */
export class View {
  constructor(stage) {
    this.stage = stage;
    this.ctx = stage.getContext("2d");
    this.zoom = 1; this.panX = 0; this.panY = 0;
    this.source = null;       // canvas currently displayed (doc or a preview)
    this.imgW = 0; this.imgH = 0; // document size; previews are drawn stretched to it
    this.drawOverlay = null;  // (ctx, view) => void, in screen space
    this.dpr = window.devicePixelRatio || 1;
    this.checker = this.makeChecker();
    this.dirty = true;
    new ResizeObserver(() => this.resize()).observe(stage.parentElement);
    const loop = () => { if (this.dirty) this.render(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  makeChecker() {
    const c = makeCanvas(16, 16), x = c.getContext("2d");
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    x.fillStyle = dark ? "#2a2a2e" : "#ffffff"; x.fillRect(0, 0, 16, 16);
    x.fillStyle = dark ? "#36363b" : "#e9e9ee"; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
    return this.ctx.createPattern(c, "repeat");
  }

  resize() {
    const r = this.stage.parentElement.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.stage.width = Math.max(1, Math.round(r.width * this.dpr));
    this.stage.height = Math.max(1, Math.round(r.height * this.dpr));
    this.stage.style.width = r.width + "px";
    this.stage.style.height = r.height + "px";
    // Keep the photo fitted while panels open/close, unless the user zoomed.
    if (this.fitPending || this.autoFit) this.fit();
    this.dirty = true;
  }

  get cssW() { return this.stage.width / this.dpr; }
  get cssH() { return this.stage.height / this.dpr; }

  fit(w = this.imgW, h = this.imgH) {
    if (!w) return;
    if (this.cssW < 10) { this.fitPending = true; return; }
    this.fitPending = false;
    this.autoFit = true;
    const pad = this.cssW < 600 ? 16 : 48;
    this.zoom = Math.min((this.cssW - pad) / w, (this.cssH - pad) / h, 4);
    this.panX = (this.cssW - w * this.zoom) / 2;
    this.panY = (this.cssH - h * this.zoom) / 2;
    this.dirty = true;
  }

  actualSize() {
    if (!this.source) return;
    this.zoomAt(1 / this.zoom, this.cssW / 2, this.cssH / 2);
  }

  zoomAt(factor, sx, sy) {
    this.autoFit = false;
    const nz = Math.min(32, Math.max(0.02, this.zoom * factor));
    const f = nz / this.zoom;
    this.panX = sx - (sx - this.panX) * f;
    this.panY = sy - (sy - this.panY) * f;
    this.zoom = nz;
    this.dirty = true;
  }

  toImage(sx, sy) { return { x: (sx - this.panX) / this.zoom, y: (sy - this.panY) / this.zoom }; }
  toScreen(ix, iy) { return { x: ix * this.zoom + this.panX, y: iy * this.zoom + this.panY }; }

  render() {
    this.dirty = false;
    const { ctx, dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.stage.width, this.stage.height);
    if (!this.source) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = (this.imgW || this.source.width) * this.zoom, h = (this.imgH || this.source.height) * this.zoom;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.25)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 4;
    ctx.fillStyle = this.checker;
    ctx.fillRect(this.panX, this.panY, w, h);
    ctx.restore();
    ctx.imageSmoothingEnabled = this.zoom < 2 || this.source.width !== this.imgW;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.source, this.panX, this.panY, w, h);
    if (this.drawOverlay) { ctx.save(); this.drawOverlay(ctx, this); ctx.restore(); }
  }
}
