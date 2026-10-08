// Painting and selection tools: brush group (brush, pencil, pen, highlighter),
// eraser, shapes group (line, arrow, rectangle, ellipse), fill group (paint
// bucket, gradient), eyedropper, selection group (marquee, lasso, polygon,
// magic wand), move and free transform.
//
// Every pixel edit goes through applyPaint()/withinSelection(), which honour
// the current selection and the layer's "lock transparent pixels" setting.

import * as ops from "./ops.js";
import { makeCanvas, copyCanvas, getImageData, layerExtent, layerFromExtent } from "./editor.js";
import { h, slider, seg, swatches } from "./ui.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const minSide = (d) => Math.min(d.width, d.height);

/* ------------------------------- shared helpers ------------------------------- */

/** Refuse to edit locked/hidden layers. need: "pixels" | "position". */
export function guard(A, need = "pixels") {
  const l = A.doc.layer, k = l.lock || {};
  if (k.all) { A.toast(`"${l.name}" is locked. Unlock it in Layers.`); return false; }
  if (need === "pixels" && k.pixels) { A.toast(`"${l.name}" has its pixels locked.`); return false; }
  if (need === "position" && k.position) { A.toast(`"${l.name}" has its position locked.`); return false; }
  if (need === "pixels" && !l.visible) { A.toast("This layer is hidden. Show it to edit it."); return false; }
  return true;
}

/** Copy of `paint` with everything outside the selection removed. */
function clipToSelection(A, paint) {
  const sel = A.doc.selection;
  if (!sel) return paint;
  const c = copyCanvas(paint), x = c.getContext("2d");
  x.globalCompositeOperation = "destination-in";
  x.drawImage(sel.mask, 0, 0);
  return c;
}

/**
 * Composite a paint layer (strokes, fills...) onto `base` (the active layer).
 * erase=true removes pixels instead. Respects selection and alpha lock.
 */
export function applyPaint(A, base, paint, { opacity = 1, erase = false, blend = "source-over" } = {}) {
  let p = clipToSelection(A, paint);
  const lockAlpha = A.doc.layer.lock?.alpha;
  const out = copyCanvas(base), x = out.getContext("2d");
  x.globalAlpha = opacity;
  if (erase && lockAlpha) {
    // Photoshop behaviour: erasing on a transparency-locked layer paints the background color.
    const bg = copyCanvas(p), bx = bg.getContext("2d");
    bx.globalCompositeOperation = "source-in"; bx.fillStyle = A.colors.bg; bx.fillRect(0, 0, bg.width, bg.height);
    p = bg;
    x.globalCompositeOperation = "source-atop";
  } else {
    x.globalCompositeOperation = erase ? "destination-out" : lockAlpha ? "source-atop" : blend;
  }
  x.drawImage(p, 0, 0);
  return out;
}

/** Replace `base` with `edited` only inside the selection (whole layer if none). */
export function withinSelection(A, base, edited) {
  const sel = A.doc.selection;
  let out = edited;
  if (sel) {
    out = copyCanvas(base);
    const x = out.getContext("2d");
    x.globalCompositeOperation = "destination-out"; x.drawImage(sel.mask, 0, 0);
    x.globalCompositeOperation = "source-over"; x.drawImage(clipToSelection(A, edited), 0, 0);
  }
  if (A.doc.layer.lock?.alpha) { // keep the original transparency
    if (out === edited) out = copyCanvas(edited);
    const x = out.getContext("2d");
    x.globalCompositeOperation = "destination-in"; x.drawImage(base, 0, 0);
  }
  return out;
}

function colorRow(A, which = "fg") {
  const sw = swatches({ value: A.colors[which], onChange: (v) => A.setColor(which, v) });
  sw.sync = () => sw.set(A.colors[which]);
  return sw;
}

/** Brush outline: a circle of radius r, or a rectangle (half-width r, half-height ry). */
function brushCursor(ctx, view, p, r, square = false, ry = r) {
  if (!p) return;
  const s = view.toScreen(p.x, p.y), R = Math.max(1.5, r * view.zoom), RY = Math.max(1.5, ry * view.zoom);
  ctx.lineWidth = 1.5;
  for (const [color, off] of [["rgba(0,0,0,.6)", 1], ["rgba(255,255,255,.95)", 0]]) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    if (square) ctx.rect(s.x - R - off, s.y - RY - off, (R + off) * 2, (RY + off) * 2);
    else ctx.arc(s.x, s.y, R + off, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** Throttle expensive preview composites to one per animation frame. */
function frameThrottle(fn) {
  let queued = false;
  const run = () => { queued = false; fn(); };
  const call = () => { if (!queued) { queued = true; requestAnimationFrame(run); } };
  call.flush = () => { if (queued) { queued = false; fn(); } };
  return call;
}

/* ------------------------------ brush engine ------------------------------ */

const CHISEL = 0.35; // highlighter tip: width as a fraction of its height

function makeStamp(size, hardness, color, chisel = false) {
  const r = size / 2, dim = Math.ceil(size) + 2;
  const c = makeCanvas(dim, dim), x = c.getContext("2d");
  const cx = dim / 2;
  if (chisel) {
    const w = Math.max(1, size * CHISEL);
    x.fillStyle = color; x.fillRect(cx - w / 2, cx - r, w, size);
  } else if (hardness >= 0.99) {
    x.fillStyle = color; x.beginPath(); x.arc(cx, cx, r, 0, Math.PI * 2); x.fill();
  } else {
    const [R, G, B] = ops.hexToRgb(color);
    const g = x.createRadialGradient(cx, cx, 0, cx, cx, r);
    g.addColorStop(0, `rgba(${R},${G},${B},1)`);
    g.addColorStop(Math.max(0.01, hardness), `rgba(${R},${G},${B},1)`);
    g.addColorStop(1, `rgba(${R},${G},${B},0)`);
    x.fillStyle = g; x.fillRect(0, 0, dim, dim);
  }
  return c;
}

/** Aliased, pixel-sharp tip: round for the pencil, square for the Block eraser. */
function makePixelStamp(size, color, square) {
  const s = Math.max(1, Math.round(size)), c = makeCanvas(s, s), x = c.getContext("2d");
  x.fillStyle = color;
  if (square) x.fillRect(0, 0, s, s);
  else ops.circleSpans(s).forEach(([a, b], y) => x.fillRect(a, y, b - a, 1));
  return c;
}

/** Accumulates one stroke into its own canvas (so opacity applies once per stroke). */
class Stroke {
  // pixel: false, "round" (pencil) or "square" (Block eraser).
  constructor(w, hgt, { size, hardness = 1, color = "#000", pixel = false, chisel = false }) {
    this.canvas = makeCanvas(w, hgt);
    this.x = this.canvas.getContext("2d");
    this.pixel = !!pixel; this.last = null;
    this.stamp = pixel ? makePixelStamp(size, color, pixel === "square") : makeStamp(size, hardness, color, chisel);
    // Round tips can step ~sqrt(size)/2 apart: the scallops between dabs stay under 1/16 px.
    this.spacing = pixel === "round" ? Math.max(1, Math.sqrt(size) / 2) : pixel ? 1 : Math.max(0.5, size * 0.1);
  }
  dab(p) {
    const d = this.stamp.width / 2;
    if (this.pixel) this.x.drawImage(this.stamp, Math.round(p.x - d), Math.round(p.y - d));
    else this.x.drawImage(this.stamp, p.x - d, p.y - d);
  }
  to(p) {
    if (!this.last) { this.dab(p); this.last = p; return; }
    const dx = p.x - this.last.x, dy = p.y - this.last.y, dist = Math.hypot(dx, dy);
    if (dist < this.spacing) return;
    const n = Math.floor(dist / this.spacing);
    for (let i = 1; i <= n; i++) this.dab({ x: this.last.x + (dx * i) / n, y: this.last.y + (dy * i) / n });
    this.last = p;
  }
}

let lastStrokeEnd = null; // for Shift+click straight lines

/** Variants of the brush tool group, which share one rail button. */
export const BRUSHES = [
  { value: "brush", label: "Brush", key: "B" },
  { value: "pencil", label: "Pencil", key: "N" },
  { value: "pen", label: "Pen" },
  { value: "highlighter", label: "Highlighter" },
];

const HINTS = {
  brush: "Soft or hard round brush.",
  pencil: "Hard-edged, pixel-sharp lines.",
  pen: "Smooth ink lines; steadies shaky strokes, good for writing and signatures.",
  highlighter: "Flat, see-through ink that darkens what is under it, like a real highlighter.",
};

/** Brush-group variants and the eraser share one implementation. */
export function paintTool(A, kind = "brush") {
  const key = `pc-${kind}`;
  const saved = JSON.parse(localStorage.getItem(key) || "null") || {};
  const m = minSide(A.doc);
  const defSize = { pencil: 2, pen: Math.max(2, Math.round(m / 300)), highlighter: Math.max(12, Math.round(m / 25)) }[kind] || Math.max(4, Math.round(m / 60));
  const o = {
    size: saved.size || defSize,
    hardness: saved.hardness ?? (kind === "eraser" ? 80 : 70),
    opacity: saved.opacity ?? (kind === "highlighter" ? 70 : 100),
    block: !!saved.block,
    color: saved.color || "#ffcc00", // highlighter keeps its own color, yellow by default
  };
  const save = () => localStorage.setItem(key, JSON.stringify(o));
  let hover = null, g = null;
  const isPixel = () => kind === "pencil" ? "round" : kind === "eraser" && o.block ? "square" : false;
  const hasHardness = () => kind === "brush" || (kind === "eraser" && !o.block);
  const chisel = kind === "highlighter", smooth = kind === "pen";
  const maxSize = Math.max(200, Math.round(m / 3));
  const sizeS = slider({ label: "Size", min: 1, max: maxSize, value: o.size, format: (v) => `${v} px`, onInput: (v) => { o.size = v; save(); A.redraw(); } });
  const hardS = slider({ label: "Hardness", min: 0, max: 100, value: o.hardness, format: (v) => `${v}%`, onInput: (v) => { o.hardness = v; save(); } });
  const opS = slider({ label: "Opacity", min: 1, max: 100, value: o.opacity, format: (v) => `${v}%`, onInput: (v) => { o.opacity = v; save(); } });
  const colors = kind === "eraser" ? null
    : chisel ? Object.assign(swatches({ value: o.color, onChange: (v) => { o.color = v; save(); } }), { sync() {} })
    : colorRow(A);
  const modeSeg = kind === "eraser" ? seg([{ value: "soft", label: "Brush" }, { value: "block", label: "Block" }], o.block ? "block" : "soft", (v) => { o.block = v === "block"; hardS.hidden = !hasHardness(); save(); }) : null;
  hardS.hidden = !hasHardness();
  const paintOpts = () => ({ opacity: o.opacity / 100, erase: kind === "eraser", blend: chisel ? "multiply" : "source-over" });

  const compose = () => {
    if (!g) return;
    A.setSource(applyPaint(A, g.base, g.stroke.canvas, paintOpts()));
  };
  const throttled = frameThrottle(compose);

  return {
    title: kind === "eraser" ? "Eraser" : BRUSHES.find((b) => b.value === kind).label,
    body: [
      modeSeg,
      sizeS, hardS, opS,
      colors,
      h("p", { class: "hint" }, kind === "eraser"
        ? "Shift+click erases a straight line. [ and ] change the size."
        : `${HINTS[kind]} Shift+click draws a straight line. Alt+click picks a color. [ and ] change the size.`),
    ].filter(Boolean),
    cursor: "brush",
    wantsPointer: true,
    onColorChange() { colors?.sync(); },
    hover(p) { hover = p; A.redraw(); },
    down(p, e) {
      if (e?.altKey && kind !== "eraser") { pickColor(A, p, e.shiftKey ? "bg" : "fg"); return; }
      if (!guard(A)) return;
      const d = A.doc;
      g = {
        base: d.canvas, at: p, raw: p,
        stroke: new Stroke(d.width, d.height, {
          size: o.size, hardness: hasHardness() ? o.hardness / 100 : 1, pixel: isPixel(), chisel,
          color: kind === "eraser" ? "#000" : chisel ? o.color : A.colors.fg,
        }),
      };
      if (e?.shiftKey && lastStrokeEnd) g.stroke.to(lastStrokeEnd);
      g.stroke.to(p);
      throttled();
    },
    move(p) {
      hover = p;
      if (!g) return A.redraw();
      g.raw = p;
      // The pen trails the pointer a little, which smooths out jitter.
      g.at = smooth ? { x: g.at.x + (p.x - g.at.x) * 0.35, y: g.at.y + (p.y - g.at.y) * 0.35 } : p;
      g.stroke.to(g.at);
      throttled();
    },
    up() {
      if (!g) return;
      if (smooth) g.stroke.to(g.raw);
      throttled.flush();
      const out = applyPaint(A, g.base, g.stroke.canvas, paintOpts());
      lastStrokeEnd = g.stroke.last;
      g = null;
      A.setSource(null);
      A.doc.commit(out, {});
    },
    keydown(e) {
      if (e.key === "[" || e.key === "]") {
        const step = Math.max(1, Math.round(o.size * 0.15));
        o.size = clamp(o.size + (e.key === "]" ? step : -step), 1, maxSize);
        sizeS.set(o.size); save(); A.redraw();
        return true;
      }
    },
    overlay(ctx, view) {
      const r = Math.max(0.5, o.size / 2);
      brushCursor(ctx, view, hover, chisel ? r * CHISEL : r, isPixel() === "square" || chisel, r);
    },
    cleanup() { A.setSource(null); },
  };
}

/* ---------------------------------- shapes ---------------------------------- */

function shapePath(x, kind, a, b, width) {
  x.beginPath();
  if (kind === "rect") x.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  else if (kind === "ellipse") x.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2 || 0.5, Math.abs(b.y - a.y) / 2 || 0.5, 0, 0, Math.PI * 2);
  else {
    x.moveTo(a.x, a.y); x.lineTo(b.x, b.y);
    if (kind === "arrow") {
      const ang = Math.atan2(b.y - a.y, b.x - a.x), len = Math.max(width * 3.2, 12);
      x.moveTo(b.x - len * Math.cos(ang - 0.45), b.y - len * Math.sin(ang - 0.45));
      x.lineTo(b.x, b.y);
      x.lineTo(b.x - len * Math.cos(ang + 0.45), b.y - len * Math.sin(ang + 0.45));
    }
  }
}

/** Variants of the Shapes tool group (values are prefixed where they'd clash with selection kinds). */
export const SHAPES = [
  { value: "line", label: "Line" },
  { value: "arrow", label: "Arrow" },
  { value: "shape-rect", label: "Rectangle" },
  { value: "shape-ellipse", label: "Ellipse" },
];

export function shapesTool(A, variant = "shape-rect") {
  const sv = SHAPES.find((s) => s.value === variant) || SHAPES[2];
  const kind = sv.value.replace("shape-", ""), closed = kind === "rect" || kind === "ellipse";
  // Width, opacity and "filled" are shared by all shapes; `kind` is kept for older versions.
  const saved = JSON.parse(localStorage.getItem("pc-shapes") || "null") || {};
  const o = { kind, size: saved.size || Math.max(2, Math.round(minSide(A.doc) / 160)), fill: !!saved.fill, opacity: saved.opacity ?? 100 };
  const save = () => localStorage.setItem("pc-shapes", JSON.stringify(o));
  let g = null;
  const colors = colorRow(A);
  const fillBox = h("input", { type: "checkbox", checked: o.fill, onchange: (e) => { o.fill = e.target.checked; save(); } });
  const render = () => {
    const d = A.doc, paint = makeCanvas(d.width, d.height), x = paint.getContext("2d");
    x.strokeStyle = x.fillStyle = A.colors.fg;
    x.lineWidth = o.size; x.lineCap = x.lineJoin = "round";
    shapePath(x, o.kind, g.a, g.b, o.size);
    if (o.fill && (o.kind === "rect" || o.kind === "ellipse")) x.fill(); else x.stroke();
    return applyPaint(A, g.base, paint, { opacity: o.opacity / 100 });
  };
  const throttled = frameThrottle(() => g && A.setSource(render()));
  return {
    title: sv.label,
    body: [
      colors,
      slider({ label: "Line width", min: 1, max: Math.max(40, Math.round(minSide(A.doc) / 12)), value: o.size, format: (v) => `${v} px`, onInput: (v) => { o.size = v; save(); } }),
      slider({ label: "Opacity", min: 1, max: 100, value: o.opacity, format: (v) => `${v}%`, onInput: (v) => { o.opacity = v; save(); } }),
      closed ? h("label", { class: "checkbox" }, fillBox, "Filled") : null,
      h("p", { class: "hint" }, closed ? `Drag to draw. Hold Shift for a perfect ${kind === "rect" ? "square" : "circle"}.` : "Drag to draw. Hold Shift for 45° angles."),
    ].filter(Boolean),
    cursor: "crosshair",
    wantsPointer: true,
    onColorChange() { colors.sync(); },
    down(p) { if (!guard(A)) return; g = { base: A.doc.canvas, a: p, b: p }; throttled(); },
    move(p, e) {
      if (!g) return;
      if (e?.shiftKey) {
        const dx = p.x - g.a.x, dy = p.y - g.a.y;
        if (o.kind === "rect" || o.kind === "ellipse") { const m = Math.max(Math.abs(dx), Math.abs(dy)); p = { x: g.a.x + Math.sign(dx || 1) * m, y: g.a.y + Math.sign(dy || 1) * m }; }
        else { const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy); p = { x: g.a.x + Math.cos(ang) * len, y: g.a.y + Math.sin(ang) * len }; }
      }
      g.b = p;
      throttled();
    },
    up() { if (!g) return; const out = render(); g = null; A.setSource(null); A.doc.commit(out, {}); },
    cleanup() { A.setSource(null); },
  };
}

/* -------------------------------- eyedropper -------------------------------- */

let pickSample = +(localStorage.getItem("pc-pick-size") || 1);
let pickAll = localStorage.getItem("pc-pick-all") !== "0";

export function pickColor(A, p, which = "fg") {
  const src = pickAll ? A.composite() : A.doc.canvas;
  const r = (pickSample - 1) / 2;
  const x0 = clamp(Math.floor(p.x) - r, 0, src.width - 1), y0 = clamp(Math.floor(p.y) - r, 0, src.height - 1);
  const w = Math.min(pickSample, src.width - x0), hh = Math.min(pickSample, src.height - y0);
  const d = src.getContext("2d", { willReadFrequently: true }).getImageData(x0, y0, w, hh).data;
  let R = 0, G = 0, B = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { if (!d[i + 3]) continue; R += d[i]; G += d[i + 1]; B += d[i + 2]; n++; }
  if (!n) return null;
  const hex = ops.rgbToHex(R / n, G / n, B / n);
  A.setColor(which, hex);
  return hex;
}

export function eyedropperTool(A) {
  let down = false;
  const out = h("div", { class: "pick-out" });
  const show = () => { out.replaceChildren(h("span", { class: "pick-chip", style: `background:${A.colors.fg}` }), h("code", {}, A.colors.fg.toUpperCase())); };
  show();
  return {
    title: "Eyedropper",
    body: [
      h("p", { class: "hint" }, "Click or drag on the image to pick a color. Alt+click picks the background color."),
      out,
      h("label", {}, "Sample", seg([{ value: "1", label: "1 px" }, { value: "3", label: "3×3" }, { value: "5", label: "5×5" }], String(pickSample), (v) => { pickSample = +v; localStorage.setItem("pc-pick-size", v); })),
      h("label", {}, "From", seg([{ value: "all", label: "All layers" }, { value: "layer", label: "Current layer" }], pickAll ? "all" : "layer", (v) => { pickAll = v === "all"; localStorage.setItem("pc-pick-all", pickAll ? "1" : "0"); })),
    ],
    cursor: "crosshair",
    wantsPointer: true,
    onColorChange: show,
    down(p, e) { down = true; this.which = e?.altKey ? "bg" : "fg"; pickColor(A, p, this.which); },
    move(p) { if (down) pickColor(A, p, this.which); },
    up() { down = false; },
  };
}

/* ------------------------------- paint bucket ------------------------------- */

function maskCanvas(mask, w, hgt) {
  const img = new ImageData(w, hgt);
  for (let i = 0; i < mask.length; i++) img.data[i * 4 + 3] = mask[i];
  const c = makeCanvas(w, hgt);
  c.getContext("2d").putImageData(img, 0, 0);
  return c;
}

/** Variants of the fill tool group, which share one rail button (G cycles, K jumps to the bucket). */
export const FILLS = [
  { value: "fill", label: "Paint bucket", short: "Bucket", key: "K" },
  { value: "gradient", label: "Gradient", key: "G" },
];

export function fillTool(A) {
  const saved = JSON.parse(localStorage.getItem("pc-fill") || "null") || {};
  const o = { tolerance: saved.tolerance ?? 32, contiguous: saved.contiguous ?? true, all: !!saved.all, opacity: saved.opacity ?? 100 };
  const save = () => localStorage.setItem("pc-fill", JSON.stringify(o));
  const colors = colorRow(A);
  return {
    title: "Paint bucket",
    body: [
      colors,
      slider({ label: "Tolerance", min: 0, max: 100, value: o.tolerance, onInput: (v) => { o.tolerance = v; save(); } }),
      slider({ label: "Opacity", min: 1, max: 100, value: o.opacity, format: (v) => `${v}%`, onInput: (v) => { o.opacity = v; save(); } }),
      h("label", { class: "checkbox" }, h("input", { type: "checkbox", checked: o.contiguous, onchange: (e) => { o.contiguous = e.target.checked; save(); } }), "Contiguous (only connected areas)"),
      h("label", { class: "checkbox" }, h("input", { type: "checkbox", checked: o.all, onchange: (e) => { o.all = e.target.checked; save(); } }), "Sample all layers"),
      h("p", { class: "hint" }, "Click an area to fill it with the color. Higher tolerance fills more similar colors."),
    ],
    cursor: "crosshair",
    wantsPointer: true,
    onColorChange() { colors.sync(); },
    down(p) {
      if (!guard(A)) return;
      const d = A.doc;
      if (p.x < 0 || p.y < 0 || p.x >= d.width || p.y >= d.height) return;
      const src = getImageData(o.all ? A.composite() : d.canvas);
      const mask = ops.floodMask(src, p.x, p.y, o.tolerance, o.contiguous);
      const paint = maskCanvas(mask, d.width, d.height), x = paint.getContext("2d");
      x.globalCompositeOperation = "source-in"; x.fillStyle = A.colors.fg; x.fillRect(0, 0, d.width, d.height);
      d.commit(applyPaint(A, d.canvas, paint, { opacity: o.opacity / 100 }), {});
    },
  };
}

/* --------------------------------- gradient --------------------------------- */

export function gradientTool(A) {
  const saved = JSON.parse(localStorage.getItem("pc-grad") || "null") || {};
  const o = { type: saved.type || "linear", to: saved.to || "bg", opacity: saved.opacity ?? 100 };
  const save = () => localStorage.setItem("pc-grad", JSON.stringify(o));
  let g = null;
  const preview = h("div", { class: "grad-preview" });
  const sync = () => {
    const end = o.to === "bg" ? A.colors.bg : "transparent";
    preview.style.background = `linear-gradient(90deg, ${A.colors.fg}, ${end}), repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 0 0 / 10px 10px`;
  };
  sync();
  const render = () => {
    const d = A.doc, paint = makeCanvas(d.width, d.height), x = paint.getContext("2d");
    const [r, gg, b] = ops.hexToRgb(A.colors.fg);
    const end = o.to === "bg" ? A.colors.bg : `rgba(${r},${gg},${b},0)`;
    const grad = o.type === "radial"
      ? x.createRadialGradient(g.a.x, g.a.y, 0, g.a.x, g.a.y, Math.max(1, Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y)))
      : x.createLinearGradient(g.a.x, g.a.y, g.b.x, g.b.y);
    grad.addColorStop(0, A.colors.fg); grad.addColorStop(1, end);
    x.fillStyle = grad; x.fillRect(0, 0, d.width, d.height);
    return applyPaint(A, g.base, paint, { opacity: o.opacity / 100 });
  };
  const throttled = frameThrottle(() => g && A.setSource(render()));
  return {
    title: "Gradient",
    body: [
      h("p", { class: "hint" }, "Drag across the image: the gradient runs from start to end. Uses the colors at the bottom of the toolbar."),
      preview,
      h("label", {}, "Style", seg([{ value: "linear", label: "Linear" }, { value: "radial", label: "Radial" }], o.type, (v) => { o.type = v; save(); })),
      h("label", {}, "Fade to", seg([{ value: "bg", label: "Second color" }, { value: "clear", label: "Transparent" }], o.to, (v) => { o.to = v; save(); sync(); })),
      slider({ label: "Opacity", min: 1, max: 100, value: o.opacity, format: (v) => `${v}%`, onInput: (v) => { o.opacity = v; save(); } }),
    ],
    cursor: "crosshair",
    wantsPointer: true,
    onColorChange: sync,
    down(p) { if (!guard(A)) return; g = { base: A.doc.canvas, a: p, b: p }; },
    move(p, e) {
      if (!g) return;
      if (e?.shiftKey) { const dx = p.x - g.a.x, dy = p.y - g.a.y, ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy); p = { x: g.a.x + Math.cos(ang) * len, y: g.a.y + Math.sin(ang) * len }; }
      g.b = p; throttled(); A.redraw();
    },
    up() {
      if (!g) return;
      if (Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) < 2) { g = null; A.setSource(null); return; }
      const out = render(); g = null; A.setSource(null); A.doc.commit(out, {});
    },
    overlay(ctx, view) {
      if (!g) return;
      const a = view.toScreen(g.a.x, g.a.y), b = view.toScreen(g.b.x, g.b.y);
      ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = "#fff"; ctx.strokeStyle = "#000"; ctx.lineWidth = 1;
      for (const q of [a, b]) { ctx.beginPath(); ctx.arc(q.x, q.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    },
    cleanup() { A.setSource(null); },
  };
}

/* --------------------------------- selection --------------------------------- */
// A selection is { mask: canvas (alpha = selected), inverted? }. The marching
// ants are traced from the mask, so any shape (lasso, magic wand...) works.

function shapeCanvas(w, hgt, s) {
  const c = makeCanvas(w, hgt), x = c.getContext("2d");
  x.fillStyle = "#000";
  x.beginPath();
  if (s.kind === "ellipse") x.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.max(0.5, s.w / 2), Math.max(0.5, s.h / 2), 0, 0, Math.PI * 2);
  else if (s.kind === "poly") { s.pts.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y))); x.closePath(); }
  else x.rect(s.x, s.y, s.w, s.h);
  x.fill();
  return c;
}

/** Combine a mask canvas into the doc selection. op: new | add | subtract | intersect */
export function selectMask(A, shape, op = "new") {
  const d = A.doc;
  if (op === "new" || !d.selection) {
    if (op === "subtract" || op === "intersect") return;
    d.selection = { mask: shape };
  } else {
    const mask = copyCanvas(d.selection.mask), x = mask.getContext("2d");
    x.globalCompositeOperation = op === "add" ? "source-over" : op === "subtract" ? "destination-out" : "destination-in";
    x.drawImage(shape, 0, 0);
    d.selection = { mask };
  }
  if (!ops.alphaBounds(getImageData(d.selection.mask), 127)) d.selection = null;
  A.selectionChanged();
}

export function selectShape(A, s, op = "new") {
  selectMask(A, shapeCanvas(A.doc.width, A.doc.height, s), op);
}

/** Magic wand: select pixels similar to the one at p. */
export function selectSimilar(A, p, { tolerance = 32, contiguous = true, all = false } = {}, op = "new") {
  const d = A.doc;
  if (p.x < 0 || p.y < 0 || p.x >= d.width || p.y >= d.height) { if (op === "new") deselect(A); return; }
  const mask = ops.floodMask(getImageData(all ? A.composite() : d.canvas), p.x, p.y, tolerance, contiguous);
  selectMask(A, maskCanvas(mask, d.width, d.height), op);
}

export function selectAll(A) {
  const d = A.doc;
  d.selection = { mask: shapeCanvas(d.width, d.height, { kind: "rect", x: 0, y: 0, w: d.width, h: d.height }) };
  A.selectionChanged();
}

export function deselect(A) { if (A.doc.selection) { A.doc.selection = null; A.selectionChanged(); } }

export function invertSelection(A) {
  const d = A.doc;
  if (!d.selection) return selectAll(A);
  const mask = makeCanvas(d.width, d.height), x = mask.getContext("2d");
  x.fillStyle = "#000"; x.fillRect(0, 0, d.width, d.height);
  x.globalCompositeOperation = "destination-out"; x.drawImage(d.selection.mask, 0, 0);
  if (!ops.alphaBounds(getImageData(mask), 127)) return deselect(A);
  d.selection = { mask, inverted: !d.selection.inverted };
  A.selectionChanged();
}

export function selectionBounds(A) {
  const s = A.doc.selection;
  return s ? ops.alphaBounds(getImageData(s.mask), 8) : null;
}

/** Delete the selected pixels from the active layer. */
export function clearSelection(A) {
  if (!A.doc.selection) return A.toast("Select an area first (or use Layers › Clear to empty the layer).");
  if (!guard(A)) return;
  A.doc.commit(applyPaint(A, A.doc.canvas, A.doc.selection.mask, { erase: true }), {});
}

export function fillSelection(A) {
  if (!guard(A)) return;
  const d = A.doc, paint = makeCanvas(d.width, d.height), x = paint.getContext("2d");
  x.fillStyle = A.colors.fg; x.fillRect(0, 0, d.width, d.height);
  d.commit(applyPaint(A, d.canvas, paint), {});
}

/** Copy (or cut) the selection to a new layer. */
export function selectionToLayer(A, cut = false, makeLayer) {
  const d = A.doc;
  if (!d.selection) return A.toast("Select an area first.");
  const piece = copyCanvas(d.canvas), x = piece.getContext("2d");
  x.globalCompositeOperation = "destination-in"; x.drawImage(d.selection.mask, 0, 0);
  if (cut && !guard(A)) return;
  d.change((doc) => {
    if (cut) doc.layers[doc.active] = { ...doc.layer, canvas: applyPaint(A, doc.canvas, doc.selection.mask, { erase: true }), meta: {} };
    doc.layers.splice(doc.active + 1, 0, makeLayer(piece, `${doc.layer.name} ${cut ? "cut" : "copy"}`));
    doc.active += 1;
  });
}

export function cropToSelection(A) {
  const b = selectionBounds(A);
  if (!b) return A.toast("Select an area first.");
  A.doc.commitAll((c) => {
    const out = makeCanvas(b.w, b.h);
    out.getContext("2d").drawImage(c, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    return out;
  });
  A.view.fit();
}

// Traced outlines, cached per mask canvas.
const outlines = new WeakMap();
function outlineOf(mask) {
  let o = outlines.get(mask);
  if (!o) {
    const img = getImageData(mask);
    o = ops.maskOutline(img.data, img.width, img.height, 4, 3);
    // A very noisy selection can have huge numbers of specks; skip the tiniest.
    const total = o.reduce((n, l) => n + l.length, 0);
    if (total > 400000) o = o.filter((l) => l.length > 8);
    outlines.set(mask, o);
  }
  return o;
}

/** Marching-ants outline of the selection (screen space). */
export function drawSelectionOutline(ctx, view, doc, phase) {
  const sel = doc.selection;
  if (!sel) return;
  const loops = outlineOf(sel.mask), z = view.zoom, px = view.panX, py = view.panY;
  const path = new Path2D();
  for (const l of loops) {
    for (let i = 0; i < l.length; i += 2) {
      const sx = Math.round(l[i] * z + px) + 0.5, sy = Math.round(l[i + 1] * z + py) + 0.5;
      if (i) path.lineTo(sx, sy); else path.moveTo(sx, sy);
    }
    path.closePath();
  }
  ctx.save();
  ctx.lineWidth = 1;
  for (const [color, off] of [["#000", 0], ["#fff", 4]]) {
    ctx.strokeStyle = color; ctx.setLineDash([4, 4]); ctx.lineDashOffset = -phase + off;
    ctx.stroke(path);
  }
  ctx.restore();
}

/** Selection kinds, which share the Select rail button (M cycles them, W jumps to the wand). */
export const SEL_KINDS = [
  { value: "rect", label: "Rectangle", title: "Drag a rectangle", key: "M" },
  { value: "ellipse", label: "Ellipse", title: "Drag an ellipse" },
  { value: "lasso", label: "Lasso", title: "Draw around an area freehand" },
  { value: "polygon", label: "Polygon", title: "Click corner points, click the first point or double-click to finish" },
  { value: "wand", label: "Magic wand", title: "Click a color to select similar pixels (W)", key: "W" },
];

// The selection mode outlives switching between selection tools (this session only).
let selMode = "new";

/** kind: one of SEL_KINDS (each is its own tool on the Select rail button). */
export function selectTool(A, makeLayer, kind = "rect") {
  let drag = null, poly = null, hover = null;
  const k = SEL_KINDS.find((x) => x.value === kind) || SEL_KINDS[0];
  kind = k.value;
  const savedWand = JSON.parse(localStorage.getItem("pc-wand") || "null") || {};
  const wand = { tolerance: savedWand.tolerance ?? 12, contiguous: savedWand.contiguous ?? true, all: !!savedWand.all };
  const saveWand = () => localStorage.setItem("pc-wand", JSON.stringify(wand));
  const modeSeg = seg([
    { value: "new", label: "New" }, { value: "add", label: "Add" }, { value: "subtract", label: "Subtract" }, { value: "intersect", label: "Intersect" },
  ], selMode, (v) => { selMode = v; });
  const has = () => !!A.doc.selection;
  const actions = h("div", { class: "layer-actions" });
  const sync = () => {
    actions.replaceChildren(
      h("button", { onclick: () => selectAll(A), title: "Ctrl+A" }, "All"),
      h("button", { onclick: () => deselect(A), disabled: !has(), title: "Ctrl+D" }, "None"),
      h("button", { onclick: () => invertSelection(A), title: "Ctrl+Shift+I" }, "Invert"),
      h("button", { onclick: () => cropToSelection(A), disabled: !has() }, "Crop"),
      h("button", { onclick: () => selectionToLayer(A, false, makeLayer), disabled: !has(), title: "Ctrl+J" }, "Copy → layer"),
      h("button", { onclick: () => selectionToLayer(A, true, makeLayer), disabled: !has() }, "Cut → layer"),
      h("button", { onclick: () => fillSelection(A), disabled: !has() }, "Fill"),
      h("button", { class: "danger", onclick: () => clearSelection(A), disabled: !has(), title: "Delete" }, "Delete"),
    );
  };
  sync();
  const HINTS = {
    rect: "Drag to select.", ellipse: "Drag to select.",
    lasso: "Hold and draw around the area. Let go to close the shape.",
    polygon: "Click to place corners. Click the first point, double-click or press Enter to finish. Backspace removes the last point, Esc cancels.",
    wand: "Click a color to select it and similar colors around it. Higher tolerance selects more.",
  };
  const hint = h("p", { class: "hint" });
  const wandOpts = h("div", { class: "stack" },
    slider({ label: "Tolerance", min: 0, max: 100, value: wand.tolerance, onInput: (v) => { wand.tolerance = v; saveWand(); } }),
    h("label", { class: "checkbox" }, h("input", { type: "checkbox", checked: wand.contiguous, onchange: (e) => { wand.contiguous = e.target.checked; saveWand(); } }), "Contiguous (only connected areas)"),
    h("label", { class: "checkbox" }, h("input", { type: "checkbox", checked: wand.all, onchange: (e) => { wand.all = e.target.checked; saveWand(); } }), "Sample all layers"));
  hint.textContent = `${HINTS[kind]} Hold Shift to add, Alt to subtract. Brushes, fills, adjustments and filters then only affect the selected area.`;
  let lastClick = { t: 0, p: null };
  const opFor = (e) => (e?.shiftKey && e?.altKey ? "intersect" : e?.shiftKey ? "add" : e?.altKey ? "subtract" : selMode);
  const finishPoly = () => {
    const p = poly; poly = null; hover = null;
    if (p && p.pts.length >= 3) selectShape(A, { kind: "poly", pts: p.pts }, p.op);
    A.redraw();
  };
  const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) * A.view.zoom < 8;
  const polyArea = (pts) => Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p.x * q.y - q.x * p.y; }, 0)) / 2;
  return {
    title: k.label,
    body: [
      hint,
      kind === "wand" ? wandOpts : null,
      h("label", {}, "Mode", modeSeg),
      actions,
    ].filter(Boolean),
    cursor: "crosshair",
    wantsPointer: true,
    onSelectionChange: sync,
    onDocChange: sync,
    down(p, e) {
      if (kind === "wand") { selectSimilar(A, p, wand, opFor(e)); return; }
      if (kind === "polygon") {
        const now = performance.now(), dbl = now - lastClick.t < 400 && lastClick.p && near(p, lastClick.p);
        lastClick = { t: now, p };
        if (!poly) { poly = { pts: [p], op: opFor(e) }; A.redraw(); return; }
        if (near(p, poly.pts[0]) || (dbl && poly.pts.length >= 3)) { finishPoly(); return; }
        poly.pts.push(p); A.redraw(); return;
      }
      drag = { a: p, b: p, pts: [p], op: opFor(e) };
    },
    move(p) {
      if (kind === "polygon" && poly) { hover = p; A.redraw(); return; }
      if (!drag) return;
      drag.b = p;
      const last = drag.pts[drag.pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) * A.view.zoom >= 2) drag.pts.push(p);
      A.redraw();
    },
    hover(p) { if (poly) { hover = p; A.redraw(); } },
    up() {
      if (!drag) return;
      const { a, b, op, pts } = drag; drag = null;
      if (kind === "lasso") {
        if (pts.length < 3 || polyArea(pts) < 4) { if (op === "new") deselect(A); A.redraw(); return; }
        selectShape(A, { kind: "poly", pts }, op);
        return;
      }
      const s = { kind, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
      if (s.w < 2 || s.h < 2) { if (op === "new") deselect(A); A.redraw(); return; }
      selectShape(A, s, op);
    },
    keydown(e) {
      if (!poly) return false;
      if (e.key === "Enter") { finishPoly(); return true; }
      if (e.key === "Escape") { poly = null; hover = null; A.redraw(); return true; }
      if (e.key === "Backspace" || e.key === "Delete") {
        poly.pts.pop();
        if (!poly.pts.length) poly = null;
        A.redraw(); return true;
      }
      return false;
    },
    overlay(ctx, view) {
      const style = () => { ctx.strokeStyle = "#3a6df0"; ctx.fillStyle = "rgba(58,109,240,.12)"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); };
      if (poly) {
        const pts = hover ? [...poly.pts, hover] : poly.pts;
        style();
        ctx.beginPath();
        pts.forEach((q, i) => { const s = view.toScreen(q.x, q.y); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
        if (pts.length > 2) ctx.fill();
        ctx.stroke();
        const s0 = view.toScreen(poly.pts[0].x, poly.pts[0].y);
        ctx.setLineDash([]); ctx.fillStyle = hover && near(hover, poly.pts[0]) ? "#3a6df0" : "#fff";
        ctx.beginPath(); ctx.arc(s0.x, s0.y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        return;
      }
      if (!drag) return;
      style();
      ctx.beginPath();
      if (kind === "lasso") {
        drag.pts.forEach((q, i) => { const s = view.toScreen(q.x, q.y); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
        const e = view.toScreen(drag.b.x, drag.b.y); ctx.lineTo(e.x, e.y);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        return;
      }
      const a = view.toScreen(Math.min(drag.a.x, drag.b.x), Math.min(drag.a.y, drag.b.y));
      const w = Math.abs(drag.b.x - drag.a.x) * view.zoom, hh = Math.abs(drag.b.y - drag.a.y) * view.zoom;
      if (kind === "ellipse") ctx.ellipse(a.x + w / 2, a.y + hh / 2, w / 2, hh / 2, 0, 0, Math.PI * 2); else ctx.rect(a.x, a.y, w, hh);
      ctx.fill(); ctx.stroke();
    },
    cleanup() { poly = null; drag = null; },
  };
}

/* ----------------------------------- move ----------------------------------- */

/**
 * Split the active layer into the selected piece and the rest. Works on the
 * whole layer, including pixels moved off the canvas earlier, so they come
 * back intact. piece/rest are in the coordinates of ext.canvas.
 */
function liftSelection(A) {
  const d = A.doc, sel = d.selection, ext = layerExtent(d.layer, d.width, d.height);
  if (!sel) return { ext, piece: ext.canvas, rest: null };
  const piece = makeCanvas(ext.canvas.width, ext.canvas.height), px = piece.getContext("2d");
  px.drawImage(sel.mask, ext.x, ext.y);
  px.globalCompositeOperation = "source-in"; px.drawImage(ext.canvas, 0, 0);
  const rest = copyCanvas(ext.canvas), rx = rest.getContext("2d");
  rx.globalCompositeOperation = "destination-out"; rx.drawImage(sel.mask, ext.x, ext.y);
  return { ext, piece, rest };
}

function shiftSelection(A, dx, dy) {
  const d = A.doc, sel = d.selection;
  if (!sel) return;
  const mask = makeCanvas(d.width, d.height);
  mask.getContext("2d").drawImage(sel.mask, dx, dy);
  d.selection = ops.alphaBounds(getImageData(mask), 127) ? { mask } : null;
  A.selectionChanged();
}

/** The whole layer after moving the lifted piece by (dx, dy). */
function moved(lifted, dx, dy) {
  const { ext, piece, rest } = lifted;
  if (!rest) return { canvas: piece, x: ext.x - dx, y: ext.y - dy };
  const left = Math.max(0, -dx), top = Math.max(0, -dy);
  const out = makeCanvas(piece.width + Math.abs(dx), piece.height + Math.abs(dy)), x = out.getContext("2d");
  x.drawImage(rest, left, top);
  x.drawImage(piece, left + dx, top + dy);
  return { canvas: out, x: ext.x + left, y: ext.y + top };
}

const visiblePart = (A, ext) => layerFromExtent(ext, A.doc.width, A.doc.height).canvas;

function commitExtent(A, ext, meta = {}) {
  const { canvas, over } = layerFromExtent(ext, A.doc.width, A.doc.height);
  A.doc.commit(canvas, meta, { over });
}

/** Moving a whole text layer keeps it editable: its text box moves along. */
function movedMeta(A, dx, dy) {
  const t = A.doc.meta.text;
  return t && !A.doc.selection ? { text: { ...t, x: t.x + dx, y: t.y + dy } } : {};
}

export function moveTool(A) {
  let drag = null;
  const nudge = (dx, dy) => {
    if (!guard(A, "position")) return;
    commitExtent(A, moved(liftSelection(A), dx, dy), movedMeta(A, dx, dy));
    shiftSelection(A, dx, dy);
  };
  return {
    title: "Move",
    body: [
      h("p", { class: "hint" }, "Drag to move the selected layer, or just the selected area if there is a selection. Arrow keys nudge by 1 px (Shift: 10 px)."),
      h("div", { class: "row" },
        h("button", { class: "grow", onclick: () => alignLayer(A, "center") }, "Center on canvas")),
    ],
    cursorStyle: "move",
    wantsPointer: true,
    down(p) { if (!guard(A, "position")) return; drag = { start: p, lifted: liftSelection(A), dx: 0, dy: 0 }; },
    move(p, e) {
      if (!drag) return;
      let dx = Math.round(p.x - drag.start.x), dy = Math.round(p.y - drag.start.y);
      if (e?.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      drag.dx = dx; drag.dy = dy;
      A.setSource(visiblePart(A, moved(drag.lifted, dx, dy)));
    },
    up() {
      if (!drag) return;
      const { lifted, dx, dy } = drag; drag = null;
      A.setSource(null);
      if (dx || dy) { commitExtent(A, moved(lifted, dx, dy), movedMeta(A, dx, dy)); shiftSelection(A, dx, dy); }
    },
    keydown(e) {
      const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!k) return;
      const s = e.shiftKey ? 10 : 1;
      nudge(k[0] * s, k[1] * s);
      return true;
    },
    cleanup() { A.setSource(null); },
  };
}

function alignLayer(A) {
  if (!guard(A, "position")) return;
  const lifted = liftSelection(A);
  const b = ops.alphaBounds(getImageData(lifted.piece));
  if (!b) return A.toast("This layer is empty.");
  const bx = b.x - lifted.ext.x, by = b.y - lifted.ext.y; // in document coordinates
  const dx = Math.round((A.doc.width - b.w) / 2 - bx), dy = Math.round((A.doc.height - b.h) / 2 - by);
  if (!dx && !dy) return;
  commitExtent(A, moved(lifted, dx, dy), movedMeta(A, dx, dy));
  shiftSelection(A, dx, dy);
}

/* ------------------------------ free transform ------------------------------ */

export function transformTool(A) {
  let st = null, drag = null;
  const wIn = h("input", { type: "number", step: 1, min: 1, inputmode: "decimal" });
  const hIn = h("input", { type: "number", step: 1, min: 1, inputmode: "decimal" });
  const aIn = h("input", { type: "number", step: 0.5, inputmode: "decimal" });
  const keep = h("input", { type: "checkbox", checked: true });
  const status = h("p", { class: "hint" });

  function start() {
    st = null;
    A.setSource(null);
    const d = A.doc;
    if (d.layer.lock?.all || d.layer.lock?.position || d.layer.lock?.pixels) { status.textContent = "This layer is locked. Unlock it in Layers to transform it."; return; }
    const lifted = liftSelection(A);
    const b = ops.alphaBounds(getImageData(lifted.piece));
    if (!b) { status.textContent = "Nothing to transform on this layer."; return; }
    const src = makeCanvas(b.w, b.h);
    src.getContext("2d").drawImage(lifted.piece, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    const ext = lifted.ext;
    st = { src, rest: lifted.rest, ext, w0: b.w, h0: b.h, cx: b.x - ext.x + b.w / 2, cy: b.y - ext.y + b.h / 2, w: b.w, h: b.h, angle: 0, fx: 1, fy: 1, hadSelection: !!d.selection };
    status.textContent = "Drag a corner to scale, outside a corner to rotate, inside to move. Enter applies, Esc cancels.";
    sync();
  }

  // Draws the rest of the layer plus the transformed piece, with the document's top-left at (ox, oy).
  const drawInto = (out, ox, oy) => {
    const x = out.getContext("2d");
    if (st.rest) x.drawImage(st.rest, ox - st.ext.x, oy - st.ext.y);
    x.imageSmoothingQuality = "high";
    x.translate(ox + st.cx, oy + st.cy); x.rotate(st.angle); x.scale(st.fx * (st.w / st.w0), st.fy * (st.h / st.h0));
    x.drawImage(st.src, -st.w0 / 2, -st.h0 / 2);
    return out;
  };
  // Preview: just the document area.
  const render = () => drawInto(makeCanvas(A.doc.width, A.doc.height), 0, 0);
  // Result: the whole layer, so nothing transformed past the edge is lost.
  const renderWhole = () => {
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => toWorld({ x: (sx * st.w) / 2, y: (sy * st.h) / 2 }));
    let l = Math.min(...pts.map((p) => p.x)), t = Math.min(...pts.map((p) => p.y));
    let r = Math.max(...pts.map((p) => p.x)), btm = Math.max(...pts.map((p) => p.y));
    if (st.rest) { l = Math.min(l, -st.ext.x); t = Math.min(t, -st.ext.y); r = Math.max(r, st.rest.width - st.ext.x); btm = Math.max(btm, st.rest.height - st.ext.y); }
    l = Math.floor(l) - 1; t = Math.floor(t) - 1; r = Math.ceil(r) + 1; btm = Math.ceil(btm) + 1;
    return { canvas: drawInto(makeCanvas(r - l, btm - t), -l, -t), x: -l, y: -t };
  };
  const throttled = frameThrottle(() => { if (st) A.setSource(render()); });
  function sync() {
    if (!st) return;
    wIn.value = Math.round((st.w / st.w0) * 100); hIn.value = Math.round((st.h / st.h0) * 100);
    aIn.value = Math.round(((st.angle * 180) / Math.PI) * 10) / 10;
    throttled(); A.redraw();
  }
  wIn.oninput = () => { if (!st) return; const f = Math.max(1, +wIn.value || 1) / 100; if (keep.checked) st.h = st.h0 * f; st.w = st.w0 * f; sync(); };
  hIn.oninput = () => { if (!st) return; const f = Math.max(1, +hIn.value || 1) / 100; if (keep.checked) st.w = st.w0 * f; st.h = st.h0 * f; sync(); };
  aIn.oninput = () => { if (!st) return; st.angle = ((+aIn.value || 0) * Math.PI) / 180; sync(); };

  const apply = () => {
    if (!st) return;
    const whole = renderWhole(), hadSel = st.hadSelection;
    st = null; A.setSource(null);
    commitExtent(A, whole);
    if (hadSel) deselect(A);
    start();
  };
  const cancel = () => { start(); };

  // Geometry helpers in box-local coordinates.
  const toLocal = (p) => { const dx = p.x - st.cx, dy = p.y - st.cy, c = Math.cos(-st.angle), s = Math.sin(-st.angle); return { x: dx * c - dy * s, y: dx * s + dy * c }; };
  const toWorld = (q) => { const c = Math.cos(st.angle), s = Math.sin(st.angle); return { x: st.cx + q.x * c - q.y * s, y: st.cy + q.x * s + q.y * c }; };
  const HANDLES = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];

  function hit(p) {
    const q = toLocal(p), tol = 12 / A.view.zoom, hw = st.w / 2, hh = st.h / 2;
    for (const [sx, sy] of HANDLES) if (Math.abs(q.x - sx * hw) <= tol && Math.abs(q.y - sy * hh) <= tol) return { type: "scale", sx, sy };
    if (Math.abs(q.x) <= hw && Math.abs(q.y) <= hh) return { type: "move" };
    return { type: "rotate" };
  }

  start();
  return {
    title: "Transform",
    body: [
      status,
      h("div", { class: "row" }, h("label", { class: "grow" }, "Width %", wIn), h("label", { class: "grow" }, "Height %", hIn), h("label", { class: "grow" }, "Angle °", aIn)),
      h("label", { class: "checkbox" }, keep, "Keep proportions"),
      h("div", { class: "row" },
        h("button", { class: "grow", onclick: () => { if (st) { st.fx *= -1; sync(); } } }, "↔ Flip"),
        h("button", { class: "grow", onclick: () => { if (st) { st.fy *= -1; sync(); } } }, "↕ Flip"),
        h("button", { class: "grow", onclick: () => { if (st) { st.angle += Math.PI / 2; sync(); } } }, "↻ 90°")),
      h("div", { class: "row" }, h("button", { class: "primary grow", onclick: apply }, "Apply"), h("button", { onclick: cancel }, "Cancel")),
    ],
    wantsPointer: true,
    onDocChange() { if (!drag) start(); },
    hover(p) {
      if (!p || !st) return;
      const t = hit(p);
      A.setCursorStyle(t.type === "move" ? "move" : t.type === "rotate" ? "alias" : (t.sx * t.sy > 0 ? "nwse-resize" : t.sx * t.sy < 0 ? "nesw-resize" : t.sx ? "ew-resize" : "ns-resize"));
    },
    down(p) {
      if (!st) return;
      const t = hit(p);
      drag = { ...t, start: p, s0: { ...st }, a0: Math.atan2(p.y - st.cy, p.x - st.cx) };
    },
    move(p, e) {
      if (!drag || !st) return;
      const s0 = drag.s0;
      if (drag.type === "move") { st.cx = s0.cx + p.x - drag.start.x; st.cy = s0.cy + p.y - drag.start.y; }
      else if (drag.type === "rotate") {
        let a = s0.angle + Math.atan2(p.y - s0.cy, p.x - s0.cx) - drag.a0;
        if (e?.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
        st.angle = a;
      } else {
        // Scale against the opposite handle, in the box's rotated frame.
        st.cx = s0.cx; st.cy = s0.cy;
        const q = toLocal(p);
        const { sx, sy } = drag;
        const ox = -sx * s0.w / 2, oy = -sy * s0.h / 2;
        let w = sx ? Math.max(2, Math.abs(q.x - ox)) : s0.w;
        let hh = sy ? Math.max(2, Math.abs(q.y - oy)) : s0.h;
        const proportional = keep.checked !== !!e?.shiftKey;
        if (proportional && sx && sy) { const f = Math.max(w / s0.w, hh / s0.h); w = s0.w * f; hh = s0.h * f; }
        else if (proportional && sx && !sy) hh = s0.h * (w / s0.w);
        else if (proportional && sy && !sx) w = s0.w * (hh / s0.h);
        const ncx = sx ? ox + (sx * w) / 2 : 0, ncy = sy ? oy + (sy * hh) / 2 : 0;
        const c = toWorld({ x: ncx, y: ncy });
        st.w = w; st.h = hh; st.cx = c.x; st.cy = c.y;
      }
      sync();
    },
    up() { drag = null; },
    keydown(e) {
      if (e.key === "Enter") { apply(); return true; }
      if (e.key === "Escape" && st) { cancel(); return true; }
    },
    overlay(ctx, view) {
      if (!st) return;
      const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => view.toScreen(...Object.values(toWorld({ x: (sx * st.w) / 2, y: (sy * st.h) / 2 }))));
      ctx.strokeStyle = "#3a6df0"; ctx.lineWidth = 1.5;
      ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.stroke();
      ctx.fillStyle = "#fff";
      for (const [sx, sy] of HANDLES) {
        const q = view.toScreen(...Object.values(toWorld({ x: (sx * st.w) / 2, y: (sy * st.h) / 2 })));
        ctx.beginPath(); ctx.rect(q.x - 5, q.y - 5, 10, 10); ctx.fill(); ctx.stroke();
      }
      const c = view.toScreen(st.cx, st.cy);
      ctx.beginPath(); ctx.arc(c.x, c.y, 4, 0, Math.PI * 2); ctx.stroke();
    },
    cleanup() { A.setSource(null); A.setCursorStyle(""); },
  };
}
