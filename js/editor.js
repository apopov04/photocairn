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

const HISTORY_BUDGET = 400 * 1024 * 1024; // bytes of pixels kept for undo

export class Doc {
  constructor(canvas, name = "image") {
    this.canvas = canvas;
    this.original = copyCanvas(canvas);
    this.name = name;
    this.undoStack = [];
    this.redoStack = [];
    // Tool-specific state that must travel with undo/redo (e.g. the cutout's
    // subject + original pixels). Any ordinary edit resets it.
    this.meta = {};
    this.listeners = new Set();
  }
  get width() { return this.canvas.width; }
  get height() { return this.canvas.height; }

  onChange(fn) { this.listeners.add(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  snapshot() {
    // Canvases are never mutated after they are pushed (begin/commit copy first),
    // so history can hold references instead of copies.
    return { canvas: this.canvas, meta: this.meta };
  }

  /** Record the current state, then replace the canvas (or mutate via fn). */
  commit(next, meta = {}) {
    this.undoStack.push(this.snapshot());
    this.redoStack = [];
    this.trim();
    if (typeof next === "function") { this.canvas = copyCanvas(this.canvas); next(this.canvas); }
    else if (next) this.canvas = next;
    this.meta = meta;
    this.emit();
  }

  /** Push history before an in-place drawing gesture (brush strokes). */
  begin() {
    this.undoStack.push(this.snapshot());
    this.redoStack = [];
    this.trim();
    this.canvas = copyCanvas(this.canvas);
    this.meta = { ...this.meta };
  }

  trim() {
    let bytes = 0;
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      bytes += this.undoStack[i].canvas.width * this.undoStack[i].canvas.height * 4;
      if (bytes > HISTORY_BUDGET && i < this.undoStack.length - 2) {
        this.undoStack.splice(0, i + 1);
        break;
      }
    }
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  undo() {
    if (!this.canUndo) return;
    this.redoStack.push(this.snapshot());
    const s = this.undoStack.pop();
    this.canvas = s.canvas; this.meta = s.meta;
    this.emit();
  }

  redo() {
    if (!this.canRedo) return;
    this.undoStack.push(this.snapshot());
    const s = this.redoStack.pop();
    this.canvas = s.canvas; this.meta = s.meta;
    this.emit();
  }
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
