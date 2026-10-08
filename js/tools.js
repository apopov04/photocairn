// Tool panels and their canvas interactions. Each factory gets the app context
// and returns { title, body, cursor?, down?, move?, up?, overlay?, cleanup?,
// onDocChange? }. Pointer callbacks receive points in image coordinates.

import * as ops from "./ops.js";
import { makeCanvas, ctx2d, copyCanvas, getImageData, canvasFromImageData, resizeCanvas, makeLayer, BLEND_MODES } from "./editor.js";
import { h, slider, seg, swatches, progress, nextFrame } from "./ui.js";
import { guard, withinSelection } from "./paint.js";
import { renderText, measureText, textBox, textLayerAt, layerName } from "./text.js";
export { textLayerAt };

const minSide = (d) => Math.min(d.width, d.height);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Downscaled copy of the document for fast live previews. */
function previewOf(canvas, max = 1400) {
  const s = Math.min(1, max / Math.max(canvas.width, canvas.height));
  return s === 1 ? copyCanvas(canvas) : resizeCanvas(canvas, canvas.width * s, canvas.height * s);
}

/** Stroke a freehand path (array of {x,y}) with round caps/joins. */
function strokePoints(ctx, pts) {
  ctx.beginPath();
  if (pts.length === 1) {
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[0].x + 0.01, pts[0].y);
  } else {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }
  ctx.stroke();
}

/** Brush cursor overlay (circle of the brush size, in screen space). */
function brushCursor(ctx, view, p, radiusImg) {
  if (!p) return;
  const s = view.toScreen(p.x, p.y), r = Math.max(2, radiusImg * view.zoom);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(0,0,0,.6)";
  ctx.beginPath(); ctx.arc(s.x, s.y, r + 1, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,.95)";
  ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.stroke();
}

/** Live preview limited to the selection (preview canvases are downscaled). */
function previewWithin(A, basePrev, editedPrev) {
  const sel = A.doc.selection;
  if (!sel) return editedPrev;
  const w = basePrev.width, hh = basePrev.height;
  const piece = copyCanvas(editedPrev), px = piece.getContext("2d");
  px.globalCompositeOperation = "destination-in"; px.drawImage(sel.mask, 0, 0, w, hh);
  const out = copyCanvas(basePrev), x = out.getContext("2d");
  x.globalCompositeOperation = "destination-out"; x.drawImage(sel.mask, 0, 0, w, hh);
  x.globalCompositeOperation = "source-over"; x.drawImage(piece, 0, 0);
  return out;
}

function applyButtons(onApply, onReset, applyLabel = "Apply") {
  const apply = h("button", { class: "primary grow", onclick: onApply }, applyLabel);
  const reset = h("button", { onclick: onReset }, "Reset");
  const row = h("div", { class: "row" }, apply, reset);
  row.apply = apply;
  return row;
}

/* -------------------------------------------------------------------------- */
/* Remove background                                                           */
/* -------------------------------------------------------------------------- */

let worker = null, jobId = 0;
const jobs = new Map();
function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./bg-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => jobs.get(e.data.id)?.(e.data);
    worker.onerror = (e) => { for (const fn of jobs.values()) fn({ type: "error", message: e.message || "Worker failed to start." }); worker = null; };
  }
  return worker;
}

async function predictMask(canvas, model, onProgress) {
  const bitmap = await createImageBitmap(canvas);
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    jobs.set(id, (msg) => {
      if (msg.type === "progress") onProgress(msg);
      else { jobs.delete(id); msg.type === "done" ? resolve(msg) : reject(new Error(msg.message)); }
    });
    getWorker().postMessage({ id, bitmap, model }, [bitmap]);
  });
}

/** Composite the cutout subject over the chosen background. */
function composeCutout(meta) {
  const { subject, bg } = meta;
  const out = makeCanvas(subject.width, subject.height);
  const x = out.getContext("2d");
  if (bg === "blur") {
    if (!meta.blurBg) {
      const small = previewOf(meta.original, 900);
      const r = Math.max(6, Math.round(minSide(small) / 30));
      meta.blurBg = resizeCanvas(canvasFromImageData(ops.blur(getImageData(small), r)), subject.width, subject.height);
    }
    x.drawImage(meta.blurBg, 0, 0);
  } else if (bg && bg !== "transparent") {
    x.fillStyle = bg; x.fillRect(0, 0, out.width, out.height);
  }
  x.drawImage(subject, 0, 0);
  return out;
}

export function cutoutTool(A) {
  let model = localStorage.getItem("pc-model") || "fast";
  let busy = false, brushMode = null, size = 0, hover = null, stroke = null;
  const status = h("p", { class: "hint" }, "Finds the main subject and removes everything else. The AI runs on this device; your photo isn't uploaded.");
  const bar = progress(); bar.hidden = true;
  const run = h("button", { class: "primary", onclick: () => go() }, "Remove background");
  const quality = seg([
    { value: "fast", label: "Fast", title: "Small model (4.6 MB download)" },
    { value: "best", label: "Best quality", title: "Larger model (44 MB download, cached after first use)" },
  ], model, (v) => { model = v; localStorage.setItem("pc-model", v); });

  const after = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const body = [status, h("label", {}, "Model", quality), run, bar, after];

  async function go() {
    if (busy || !guard(A)) return;
    busy = true; run.disabled = true; bar.hidden = false; bar.set(0);
    const t0 = performance.now();
    try {
      const doc = A.doc;
      // Run on the untouched original if we're refining an earlier cutout.
      const source = doc.meta.original || doc.canvas;
      const res = await predictMask(source, model, (m) => {
        if (m.stage === "download") { status.textContent = `Downloading the AI model (first time only)… ${Math.round(m.progress * 100)}%`; bar.set(m.progress); }
        else if (m.stage === "loading") { status.textContent = "Loading the AI model…"; bar.set(m.progress); }
        else { status.textContent = "Finding the subject…"; bar.set(null); }
      });
      await nextFrame();
      const mask = ops.normalizeMask(res.mask);
      const mimg = new ImageData(res.size, res.size);
      for (let i = 0; i < mask.length; i++) mimg.data[i * 4 + 3] = mask[i];
      const msmall = makeCanvas(res.size, res.size);
      msmall.getContext("2d").putImageData(mimg, 0, 0);
      const subject = copyCanvas(source);
      const sx = subject.getContext("2d");
      sx.globalCompositeOperation = "destination-in";
      sx.imageSmoothingQuality = "high";
      sx.drawImage(msmall, 0, 0, subject.width, subject.height);
      const meta = { original: source, subject, bg: "transparent" };
      doc.commit(composeCutout(meta), meta);
      status.textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)}s. Pick a background or touch up the edges below.`;
    } catch (err) {
      console.error(err);
      status.textContent = `Something went wrong: ${err.message}`;
    } finally {
      busy = false; run.disabled = false; bar.hidden = true;
    }
  }

  function buildAfter() {
    after.replaceChildren();
    const meta = A.doc.meta;
    if (!meta.subject) { brushMode = null; A.setCursor("pan"); return; }
    run.textContent = "Run again";
    if (!size) size = Math.max(4, Math.round(minSide(A.doc) / 25));
    const blurBtn = h("button", { class: "swatch", "data-v": "blur", title: "Blurred original", "aria-label": "Blurred original", style: "background:linear-gradient(135deg,#9ab,#cba);filter:blur(.5px)" });
    const sw = swatches({
      value: meta.bg, transparent: true, extra: [blurBtn],
      onChange: (v) => {
        const m = { ...A.doc.meta, bg: v };
        A.doc.commit(composeCutout(m), m);
      },
    });
    blurBtn.onclick = () => { sw.set("blur"); const m = { ...A.doc.meta, bg: "blur" }; A.doc.commit(composeCutout(m), m); };
    const modes = seg([
      { value: "off", label: "Off" }, { value: "erase", label: "Erase" }, { value: "restore", label: "Restore" },
    ], brushMode || "off", (v) => { brushMode = v === "off" ? null : v; A.setCursor(brushMode ? "brush" : "pan"); A.redraw(); });
    after.append(
      h("div", { class: "sub" }, "Background"), sw,
      h("div", { class: "sub" }, "Touch up edges"),
      h("p", { class: "hint" }, "Paint to erase leftovers or bring back parts the AI cut off."),
      modes,
      slider({ label: "Brush size", min: 2, max: Math.max(50, Math.round(minSide(A.doc) / 4)), value: size, onInput: (v) => { size = v; A.redraw(); } }),
    );
    A.setCursor(brushMode ? "brush" : "pan");
  }
  buildAfter();

  return {
    title: "Remove background",
    body,
    onDocChange: buildAfter,
    hover(p) { hover = brushMode ? p : null; if (brushMode) A.redraw(); },
    get wantsPointer() { return !!brushMode; },
    down(p) {
      if (!guard(A)) return;
      const doc = A.doc;
      doc.begin();
      const meta = doc.meta;
      meta.subject = copyCanvas(meta.subject);
      stroke = { pts: [p], base: copyCanvas(meta.subject) };
      this.move(p);
    },
    move(p) {
      if (!stroke) return;
      stroke.pts.push(p);
      const meta = A.doc.meta, x = meta.subject.getContext("2d");
      x.globalCompositeOperation = "copy"; x.drawImage(stroke.base, 0, 0);
      x.globalCompositeOperation = brushMode === "erase" ? "destination-out" : "source-over";
      x.lineCap = x.lineJoin = "round"; x.lineWidth = size * 2;
      x.strokeStyle = brushMode === "erase" ? "#000" : x.createPattern(meta.original, "no-repeat");
      strokePoints(x, stroke.pts);
      x.globalCompositeOperation = "source-over";
      A.doc.canvas = composeCutout(meta);
      A.refreshView();
    },
    up() { if (stroke) { stroke = null; A.doc.emit(); } },
    overlay(ctx, view) { if (brushMode) brushCursor(ctx, view, hover, size); },
    cleanup() { A.setCursor("pan"); },
  };
}

export function rotateCanvas90(d, dir) {
  const c = makeCanvas(d.height, d.width), x = c.getContext("2d");
  x.translate(c.width / 2, c.height / 2); x.rotate((dir * Math.PI) / 2); x.drawImage(d, -d.width / 2, -d.height / 2);
  return c;
}

export function flipCanvas(d, horizontal) {
  const c = makeCanvas(d.width, d.height), x = c.getContext("2d");
  x.translate(horizontal ? d.width : 0, horizontal ? 0 : d.height); x.scale(horizontal ? -1 : 1, horizontal ? 1 : -1); x.drawImage(d, 0, 0);
  return c;
}

/* -------------------------------------------------------------------------- */
/* Crop & rotate                                                               */
/* -------------------------------------------------------------------------- */

const ASPECTS = [
  { value: "free", label: "Free" }, { value: "orig", label: "Original" },
  { value: "1", label: "1:1" }, { value: "0.8", label: "4:5" }, { value: "1.5", label: "3:2" },
  { value: "1.7778", label: "16:9" }, { value: "0.5625", label: "9:16" },
];

export function cropTool(A) {
  let aspect = "free", angle = 0, rect, drag = null, rotated = null;
  const sizeOut = h("p", { class: "meta" });
  const doc = () => A.doc;
  const ratio = () => aspect === "free" ? null : aspect === "orig" ? doc().width / doc().height : +aspect;

  function bounds() {
    if (!angle) return { x: 0, y: 0, w: doc().width, h: doc().height };
    const s = ops.rotatedCropSize(doc().width, doc().height, (angle * Math.PI) / 180);
    return { x: (doc().width - s.width) / 2, y: (doc().height - s.height) / 2, w: s.width, h: s.height };
  }

  function resetRect() {
    const b = bounds(), r = ratio();
    let w = b.w, hh = b.h;
    if (r) { if (w / hh > r) w = hh * r; else hh = w / r; }
    rect = { x: b.x + (b.w - w) / 2, y: b.y + (b.h - hh) / 2, w, h: hh };
    update();
  }

  function update() {
    sizeOut.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)} px`;
    A.redraw();
  }

  const rotateBy = (d, deg) => {
    const out = makeCanvas(d.width, d.height), x = out.getContext("2d");
    x.imageSmoothingQuality = "high";
    x.translate(d.width / 2, d.height / 2);
    x.rotate((deg * Math.PI) / 180);
    x.drawImage(d, -d.width / 2, -d.height / 2);
    return out;
  };
  function renderRotation() {
    if (!angle) { rotated = null; A.setSource(null); return; }
    rotated = rotateBy(A.composite(), angle);
    A.setSource(rotated, rotated.width, rotated.height);
  }

  const straighten = slider({
    label: "Straighten", min: -45, max: 45, step: 0.5, value: 0, format: (v) => `${v}°`,
    onInput: (v) => { angle = v; renderRotation(); resetRect(); },
  });

  const rotate90 = (dir) => { doc().commitAll((d) => rotateCanvas90(d, dir)); A.view.fit(); };
  const flip = (hz) => doc().commitAll((d) => flipCanvas(d, hz));

  function apply() {
    const r = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.max(1, Math.round(rect.w)), h: Math.max(1, Math.round(rect.h)) };
    if (!angle && r.x === 0 && r.y === 0 && r.w === doc().width && r.h === doc().height) return A.toast("Drag the corners to choose what to keep.");
    const deg = angle;
    angle = 0; straighten.set(0); rotated = null; A.setSource(null);
    doc().commitAll((layer) => {
      const src = deg ? rotateBy(layer, deg) : layer;
      const c = makeCanvas(r.w, r.h);
      c.getContext("2d").drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      return c;
    });
    A.view.fit();
  }

  const body = [
    h("label", {}, "Aspect ratio", seg(ASPECTS, aspect, (v) => { aspect = v; resetRect(); })),
    h("div", { class: "row" },
      h("button", { title: "Rotate left", onclick: () => rotate90(-1) }, "↺ Left"),
      h("button", { title: "Rotate right", onclick: () => rotate90(1) }, "↻ Right"),
      h("button", { title: "Flip horizontally", onclick: () => flip(true) }, "↔ Flip"),
      h("button", { title: "Flip vertically", onclick: () => flip(false) }, "↕ Flip")),
    straighten,
    sizeOut,
    applyButtons(apply, () => { angle = 0; straighten.set(0); renderRotation(); aspect = "free"; body[0].querySelector(".seg").set("free"); resetRect(); }, "Crop"),
  ];

  // --- pointer interaction ---
  const HANDLE = 14; // px on screen
  function hit(p) {
    const v = A.view, tol = HANDLE / v.zoom;
    const xs = { l: rect.x, r: rect.x + rect.w, c: rect.x + rect.w / 2 };
    const ys = { t: rect.y, b: rect.y + rect.h, m: rect.y + rect.h / 2 };
    const near = (a, b) => Math.abs(a - b) <= tol;
    const hz = near(p.x, xs.l) ? "l" : near(p.x, xs.r) ? "r" : null;
    const vt = near(p.y, ys.t) ? "t" : near(p.y, ys.b) ? "b" : null;
    const inX = p.x > xs.l - tol && p.x < xs.r + tol, inY = p.y > ys.t - tol && p.y < ys.b + tol;
    if (hz && vt) return vt + hz;
    if (!ratio()) {
      if (hz && inY) return hz;
      if (vt && inX) return vt;
    }
    if (p.x > xs.l && p.x < xs.r && p.y > ys.t && p.y < ys.b) return "move";
    return "new";
  }

  function constrain(r, anchor) {
    const b = bounds(), ar = ratio();
    r.w = Math.max(8, r.w); r.h = Math.max(8, r.h);
    if (ar) {
      // Keep aspect: derive height from width, shrink if it overflows.
      r.h = r.w / ar;
      const maxW = anchor.x != null ? (anchor.dirX > 0 ? b.x + b.w - anchor.x : anchor.x - b.x) : b.w;
      const maxH = anchor.y != null ? (anchor.dirY > 0 ? b.y + b.h - anchor.y : anchor.y - b.y) : b.h;
      if (r.w > maxW) { r.w = maxW; r.h = r.w / ar; }
      if (r.h > maxH) { r.h = maxH; r.w = r.h * ar; }
      if (anchor.x != null) r.x = anchor.dirX > 0 ? anchor.x : anchor.x - r.w;
      if (anchor.y != null) r.y = anchor.dirY > 0 ? anchor.y : anchor.y - r.h;
    }
    r.x = clamp(r.x, b.x, b.x + b.w - r.w); r.y = clamp(r.y, b.y, b.y + b.h - r.h);
    r.w = Math.min(r.w, b.x + b.w - r.x); r.h = Math.min(r.h, b.y + b.h - r.y);
    return r;
  }

  resetRect();

  return {
    title: "Crop & rotate",
    body,
    cursor: "crosshair",
    wantsPointer: true,
    onDocChange() { angle = 0; straighten.set(0); rotated = null; A.setSource(null); resetRect(); },
    hover(p) { if (!p) return; A.setCursorStyle({ move: "move", new: "crosshair", tl: "nwse-resize", br: "nwse-resize", tr: "nesw-resize", bl: "nesw-resize", l: "ew-resize", r: "ew-resize", t: "ns-resize", b: "ns-resize" }[hit(p)]); },
    down(p) { drag = { kind: hit(p), start: p, r0: { ...rect } }; },
    move(p) {
      if (!drag) return;
      const { kind, start, r0 } = drag, dx = p.x - start.x, dy = p.y - start.y;
      let r = { ...r0 };
      if (kind === "move") { r.x += dx; r.y += dy; rect = constrain(r, {}); return update(); }
      if (kind === "new") {
        const b = bounds();
        const sx = clamp(start.x, b.x, b.x + b.w), sy = clamp(start.y, b.y, b.y + b.h);
        const ex = clamp(p.x, b.x, b.x + b.w), ey = clamp(p.y, b.y, b.y + b.h);
        r = { x: Math.min(sx, ex), y: Math.min(sy, ey), w: Math.abs(ex - sx), h: Math.abs(ey - sy) };
        rect = constrain(r, ratio() ? { x: sx, y: sy, dirX: ex >= sx ? 1 : -1, dirY: ey >= sy ? 1 : -1 } : {});
        return update();
      }
      const anchor = {};
      if (kind.includes("l")) { r.x = Math.min(r0.x + dx, r0.x + r0.w - 8); r.w = r0.x + r0.w - r.x; anchor.x = r0.x + r0.w; anchor.dirX = -1; }
      if (kind.includes("r")) { r.w = r0.w + dx; anchor.x = r0.x; anchor.dirX = 1; }
      if (kind.includes("t")) { r.y = Math.min(r0.y + dy, r0.y + r0.h - 8); r.h = r0.y + r0.h - r.y; anchor.y = r0.y + r0.h; anchor.dirY = -1; }
      if (kind.includes("b")) { r.h = r0.h + dy; anchor.y = r0.y; anchor.dirY = 1; }
      const b = bounds();
      if (!ratio()) { // clamp edges into bounds
        if (r.x < b.x) { r.w -= b.x - r.x; r.x = b.x; }
        if (r.y < b.y) { r.h -= b.y - r.y; r.y = b.y; }
      }
      rect = constrain(r, anchor);
      update();
    },
    up() { drag = null; },
    keydown(e) { if (e.key === "Enter") { apply(); return true; } },
    overlay(ctx, view) {
      const a = view.toScreen(rect.x, rect.y), b = view.toScreen(rect.x + rect.w, rect.y + rect.h);
      const img0 = view.toScreen(0, 0), img1 = view.toScreen(doc().width, doc().height);
      ctx.fillStyle = "rgba(0,0,0,.5)";
      ctx.beginPath();
      ctx.rect(img0.x, img0.y, img1.x - img0.x, img1.y - img0.y);
      ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.fill("evenodd");
      ctx.strokeStyle = "rgba(255,255,255,.45)"; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < 3; i++) {
        const x = a.x + ((b.x - a.x) * i) / 3, y = a.y + ((b.y - a.y) * i) / 3;
        ctx.moveTo(x, a.y); ctx.lineTo(x, b.y); ctx.moveTo(a.x, y); ctx.lineTo(b.x, y);
      }
      ctx.stroke();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.lineWidth = 4; ctx.lineCap = "round";
      const L = Math.min(18, (b.x - a.x) / 3, (b.y - a.y) / 3);
      ctx.beginPath();
      for (const [x, y, sx, sy] of [[a.x, a.y, 1, 1], [b.x, a.y, -1, 1], [a.x, b.y, 1, -1], [b.x, b.y, -1, -1]]) {
        ctx.moveTo(x + sx * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * L);
      }
      ctx.stroke();
    },
    cleanup() { A.setSource(null); },
  };
}

/* -------------------------------------------------------------------------- */
/* Resize                                                                      */
/* -------------------------------------------------------------------------- */

export function resizeTool(A) {
  let w = A.doc.width, hgt = A.doc.height, lock = true;
  const ratio = () => A.doc.width / A.doc.height;
  const wIn = h("input", { type: "number", min: 1, max: 16000, value: w, inputmode: "numeric" });
  const hIn = h("input", { type: "number", min: 1, max: 16000, value: hgt, inputmode: "numeric" });
  const meta = h("p", { class: "meta" });
  const sync = () => {
    wIn.value = w; hIn.value = hgt;
    const pct = Math.round((w / A.doc.width) * 100);
    meta.textContent = `Now ${A.doc.width} × ${A.doc.height} → ${w} × ${hgt} px (${pct}%)` + (pct > 100 ? ". Enlarging adds no detail." : "");
  };
  wIn.addEventListener("input", () => { w = Math.max(1, Math.round(+wIn.value || 1)); if (lock) { hgt = Math.max(1, Math.round(w / ratio())); hIn.value = hgt; } sync(); });
  hIn.addEventListener("input", () => { hgt = Math.max(1, Math.round(+hIn.value || 1)); if (lock) { w = Math.max(1, Math.round(hgt * ratio())); wIn.value = w; } sync(); });
  const lockBox = h("input", { type: "checkbox", checked: true, onchange: (e) => { lock = e.target.checked; } });
  const setPct = (p) => { w = Math.max(1, Math.round(A.doc.width * p)); hgt = Math.max(1, Math.round(A.doc.height * p)); sync(); };
  const setLong = (n) => { const s = n / Math.max(A.doc.width, A.doc.height); setPct(s); };
  sync();
  const canvasPart = canvasSizeSection(A);
  const imagePart = h("div", { class: "stack" });
  const modeSeg = seg([{ value: "image", label: "Image size" }, { value: "canvas", label: "Canvas size" }], "image", (v) => {
    imagePart.hidden = v !== "image"; canvasPart.hidden = v !== "canvas";
    if (v === "canvas") canvasPart.show(); else A.setSource(null);
  });
  canvasPart.hidden = true;
  imagePart.append(
      h("p", { class: "hint" }, "Scales the whole picture."),
      h("div", { class: "row" }, h("label", { class: "grow" }, "Width", wIn), h("label", { class: "grow" }, "Height", hIn)),
      h("label", { class: "checkbox" }, lockBox, "Keep proportions"),
      h("div", { class: "sub" }, "Quick sizes"),
      h("div", { class: "seg" },
        h("button", { onclick: () => setPct(0.25) }, "25%"), h("button", { onclick: () => setPct(0.5) }, "50%"),
        h("button", { onclick: () => setPct(0.75) }, "75%"), h("button", { onclick: () => setLong(1080), title: "Longest side 1080 px (Instagram)" }, "1080 px"),
        h("button", { onclick: () => setLong(1920), title: "Longest side 1920 px (Full HD)" }, "1920 px"),
        h("button", { onclick: () => setLong(512), title: "Longest side 512 px (avatars, emoji)" }, "512 px")),
      meta,
      applyButtons(() => {
        if (w === A.doc.width && hgt === A.doc.height) return A.toast("That's already the current size.");
        A.doc.commitAll((c) => resizeCanvas(c, w, hgt));
        A.view.fit();
      }, () => setPct(1), "Resize"));
  return {
    title: "Resize",
    body: [modeSeg, imagePart, canvasPart],
    onDocChange() { w = A.doc.width; hgt = A.doc.height; sync(); canvasPart.reset(); },
    cleanup() { A.setSource(null); },
  };
}

/** Canvas size: add or trim space around the image without scaling it. */
function canvasSizeSection(A) {
  let w = A.doc.width, hgt = A.doc.height, ax = 1, ay = 1, fill = "transparent";
  const wIn = h("input", { type: "number", min: 1, max: 16000, inputmode: "numeric" });
  const hIn = h("input", { type: "number", min: 1, max: 16000, inputmode: "numeric" });
  const meta = h("p", { class: "meta" });
  const grid = h("div", { class: "anchor-grid", role: "group", "aria-label": "Anchor" });
  const offset = () => ({ x: Math.round(((w - A.doc.width) * ax) / 2), y: Math.round(((hgt - A.doc.height) * ay) / 2) });
  const build = (c, i, color) => {
    const out = makeCanvas(w, hgt), x = out.getContext("2d");
    if (i === 0 && color !== "transparent") { x.fillStyle = color; x.fillRect(0, 0, w, hgt); }
    const o = offset();
    x.drawImage(c, o.x, o.y);
    return out;
  };
  const fillColor = () => (fill === "bg" ? A.colors.bg : fill === "fg" ? A.colors.fg : "transparent");
  const show = () => {
    wIn.value = w; hIn.value = hgt;
    meta.textContent = `${A.doc.width} × ${A.doc.height} → ${w} × ${hgt} px`;
    for (const b of grid.children) b.classList.toggle("on", +b.dataset.x === ax && +b.dataset.y === ay);
    if (w === A.doc.width && hgt === A.doc.height) return A.setSource(null);
    const prev = build(A.composite(), 0, fillColor());
    A.setSource(prev, prev.width, prev.height);
  };
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
    grid.append(h("button", { "data-x": x, "data-y": y, title: "Anchor", onclick: () => { ax = x; ay = y; show(); } }));
  }
  wIn.oninput = () => { w = Math.max(1, Math.min(16000, Math.round(+wIn.value || 1))); show(); };
  hIn.oninput = () => { hgt = Math.max(1, Math.min(16000, Math.round(+hIn.value || 1))); show(); };
  const addPct = (p) => { w = Math.round(A.doc.width * (1 + p)); hgt = Math.round(A.doc.height * (1 + p)); show(); };
  const square = () => { w = hgt = Math.max(A.doc.width, A.doc.height); show(); };
  const el = h("div", { class: "stack" },
    h("p", { class: "hint" }, "Adds space around the picture (or trims it) without scaling. The anchor sets where the picture sits."),
    h("div", { class: "row" }, h("label", { class: "grow" }, "Width", wIn), h("label", { class: "grow" }, "Height", hIn)),
    h("div", { class: "row", style: "align-items:flex-start;gap:16px" },
      h("label", {}, "Anchor", grid),
      h("label", { class: "grow" }, "New area", seg([{ value: "transparent", label: "Transparent" }, { value: "bg", label: "Second color" }, { value: "fg", label: "Main color" }], fill, (v) => { fill = v; show(); }))),
    h("div", { class: "seg" },
      h("button", { onclick: () => addPct(0.1) }, "+10%"), h("button", { onclick: () => addPct(0.25) }, "+25%"),
      h("button", { onclick: () => square(), title: "Pad to a square" }, "Square")),
    meta,
    applyButtons(() => {
      if (w === A.doc.width && hgt === A.doc.height) return A.toast("Change the width or height first.");
      const color = fillColor();
      A.setSource(null);
      A.doc.commitAll((c, i) => build(c, i, color));
      A.view.fit();
    }, () => { w = A.doc.width; hgt = A.doc.height; show(); }, "Apply"),
  );
  el.show = show;
  el.reset = () => { w = A.doc.width; hgt = A.doc.height; if (!el.hidden) show(); };
  return el;
}

/* -------------------------------------------------------------------------- */
/* Adjust                                                                      */
/* -------------------------------------------------------------------------- */

const ADJ = [
  ["brightness", "Brightness"], ["contrast", "Contrast"], ["exposure", "Exposure"],
  ["highlights", "Highlights"], ["shadows", "Shadows"], ["saturation", "Saturation"],
  ["warmth", "Warmth"], ["tint", "Tint"],
];

function runAdjust(img, v, scale = 1) {
  let out = ops.adjust(img, v);
  if (v.blur) out = ops.blur(out, (v.blur / 4) * scale);
  if (v.sharpen) out = ops.sharpen(out, v.sharpen, 1.2 * Math.max(0.5, scale));
  return out;
}

export function adjustTool(A) {
  const vals = {};
  let preview, base, pending = false;
  const make = () => { preview = previewOf(A.doc.canvas); base = getImageData(preview); };
  make();
  const render = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const scale = preview.width / A.doc.width;
      A.setSource(previewWithin(A, preview, canvasFromImageData(runAdjust(base, vals, scale))));
    });
  };
  const sliders = [];
  for (const [k, label] of ADJ) {
    vals[k] = 0;
    sliders.push(slider({ label, min: -100, max: 100, value: 0, onInput: (v) => { vals[k] = v; render(); } }));
  }
  vals.sharpen = 0; vals.blur = 0;
  sliders.push(slider({ label: "Sharpen", min: 0, max: 100, value: 0, onInput: (v) => { vals.sharpen = v; render(); } }));
  sliders.push(slider({ label: "Soften", min: 0, max: 100, value: 0, onInput: (v) => { vals.blur = v; render(); } }));
  const reset = () => { for (const k in vals) vals[k] = 0; for (const s of sliders) s.set(0); A.setSource(null); };
  const btns = applyButtons(async () => {
    if (Object.values(vals).every((v) => !v)) return A.toast("Move a slider first.");
    if (!guard(A)) return;
    btns.apply.disabled = true; btns.apply.textContent = "Applying…";
    await nextFrame();
    const out = withinSelection(A, A.doc.canvas, canvasFromImageData(runAdjust(getImageData(A.doc.canvas), vals, 1)));
    btns.apply.disabled = false; btns.apply.textContent = "Apply";
    reset();
    A.doc.commit(out);
  }, reset);
  return {
    title: "Adjust",
    body: [h("p", { class: "hint" }, "Double-click a slider to reset it."), ...sliders, btns],
    onDocChange() { make(); reset(); },
    cleanup() { A.setSource(null); },
  };
}

/* -------------------------------------------------------------------------- */
/* Filters (looks)                                                             */
/* -------------------------------------------------------------------------- */

export function looksTool(A) {
  let current = "none", amount = 100, preview, base;
  const grid = h("div", { class: "looks-grid" });
  const label = (n) => (n === "none" ? "Original" : n[0].toUpperCase() + n.slice(1));
  const make = () => {
    preview = previewOf(A.doc.canvas);
    base = getImageData(preview);
    const t = getImageData(resizeCanvas(A.doc.canvas, ...Object.values(ops.fitSize(A.doc.width, A.doc.height, 120, 120))));
    grid.replaceChildren();
    for (const n of ops.LOOK_NAMES) {
      const c = canvasFromImageData(ops.look(t, n));
      grid.append(h("button", { "data-v": n, class: n === current ? "on" : "", onclick: () => { current = n; mark(); render(); } }, c, label(n)));
    }
  };
  const mark = () => { for (const b of grid.children) b.classList.toggle("on", b.dataset.v === current); };
  const mixed = (img) => {
    const f = ops.look(img, current);
    if (amount === 100) return f;
    const k = amount / 100;
    for (let i = 0; i < f.data.length; i++) f.data[i] = img.data[i] + (f.data[i] - img.data[i]) * k;
    return f;
  };
  const render = () => { if (current === "none") return A.setSource(null); A.setSource(previewWithin(A, preview, canvasFromImageData(mixed(base)))); };
  make();
  const btns = applyButtons(async () => {
    if (current === "none") return A.toast("Pick a filter first.");
    if (!guard(A)) return;
    btns.apply.disabled = true;
    await nextFrame();
    const out = withinSelection(A, A.doc.canvas, canvasFromImageData(mixed(getImageData(A.doc.canvas))));
    btns.apply.disabled = false;
    current = "none"; mark(); A.setSource(null);
    A.doc.commit(out);
  }, () => { current = "none"; mark(); render(); });
  return {
    title: "Filters",
    body: [grid, slider({ label: "Strength", min: 0, max: 100, value: 100, format: (v) => `${v}%`, onInput: (v) => { amount = v; render(); } }), btns],
    onDocChange() { make(); render(); },
    cleanup() { A.setSource(null); },
  };
}

/* -------------------------------------------------------------------------- */
/* Blur out (redact)                                                           */
/* -------------------------------------------------------------------------- */

/** Variants of the Blur out tool group, which share one rail button. */
export const REDACT_MODES = [
  { value: "blur", label: "Blur" },
  { value: "pixelate", label: "Pixelate" },
  { value: "box", label: "Solid box" },
];

// Strength and box color carry over when switching between the variants (this session only).
let redactStrength = 60, redactColor = "#000000";

export function redactTool(A, mode = "blur") {
  if (!REDACT_MODES.some((m) => m.value === mode)) mode = "blur";
  let drag = null;
  const box = mode === "box";
  function applyRect(r) {
    r = { x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), w: Math.ceil(r.w), h: Math.ceil(r.h) };
    r.w = Math.min(r.w, A.doc.width - r.x); r.h = Math.min(r.h, A.doc.height - r.y);
    if (r.w < 3 || r.h < 3) return;
    if (!guard(A)) return;
    A.doc.commit((c) => {
      const x = ctx2d(c);
      if (mode === "box") { x.fillStyle = redactColor; x.fillRect(r.x, r.y, r.w, r.h); return; }
      const pad = mode === "blur" ? Math.ceil(Math.min(r.w, r.h) * 0.6) : 0;
      const sx = Math.max(0, r.x - pad), sy = Math.max(0, r.y - pad);
      const sw = Math.min(c.width, r.x + r.w + pad) - sx, sh = Math.min(c.height, r.y + r.h + pad) - sy;
      const img = x.getImageData(sx, sy, sw, sh);
      const k = redactStrength / 100;
      if (mode === "pixelate") ops.pixelateRect(img, r.x - sx, r.y - sy, r.w, r.h, Math.max(4, Math.min(r.w, r.h) * (0.05 + 0.3 * k)));
      else ops.blurRect(img, r.x - sx, r.y - sy, r.w, r.h, Math.max(3, Math.min(r.w, r.h) * (0.05 + 0.25 * k)));
      x.putImageData(img, sx, sy);
    });
  }
  return {
    title: REDACT_MODES.find((m) => m.value === mode).label,
    body: [
      h("p", { class: "hint" }, `Drag over faces, names, number plates or anything private to ${box ? "cover it" : mode === "blur" ? "blur it" : "pixelate it"}.`),
      box ? swatches({ value: redactColor, onChange: (v) => { redactColor = v; } })
        : slider({ label: "Strength", min: 10, max: 100, value: redactStrength, onInput: (v) => { redactStrength = v; } }),
      box ? null : h("p", { class: "note" }, "For passwords, card numbers or IDs, use Solid box (right-click or long-press this tool). Blur and pixelation can sometimes be reversed."),
    ].filter(Boolean),
    cursor: "crosshair",
    wantsPointer: true,
    down(p) { drag = { a: p, b: p }; },
    move(p) { if (drag) { drag.b = p; A.redraw(); } },
    up() {
      if (!drag) return;
      const { a, b } = drag; drag = null;
      applyRect({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
      A.redraw();
    },
    overlay(ctx, view) {
      if (!drag) return;
      const a = view.toScreen(drag.a.x, drag.a.y), b = view.toScreen(drag.b.x, drag.b.y);
      ctx.fillStyle = "rgba(58,109,240,.18)"; ctx.strokeStyle = "#3a6df0"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

const TEXT_STYLE = { font: "sans", weight: 700, italic: false, align: "center", outline: true, bg: "transparent" };

/**
 * Text tool. Each text is its own layer whose parameters live in
 * layer.meta.text (see text.js), so it stays editable: click it to edit,
 * drag to move, drag the side handles to set the wrapping width. Edits are
 * written to the layer live; one editing session is one undo step.
 */
export function textTool(A) {
  const maxSize = Math.max(200, Math.round(minSide(A.doc) / 2));
  const style = { ...TEXT_STYLE, color: A.colors.fg, ...JSON.parse(localStorage.getItem("pc-text") || "null"), size: Math.max(8, Math.round(minSide(A.doc) / 10)) };
  // The text being edited: { id: layer id, t: params, ref: meta.text last written, recorded: undo step taken, created: layer made this session }
  let cur = null, drag = null, hoverIdx = -1, pending = 0, self = false;
  const params = () => (cur ? cur.t : style);
  const indexOf = (id) => A.doc.layers.findIndex((l) => l.id === id);
  const quiet = (fn) => { self = true; try { fn(); } finally { self = false; } };

  /* ---- writing the text into its layer ---- */
  function write() {
    pending = 0;
    if (!cur) return;
    const d = A.doc, i = indexOf(cur.id);
    if (i < 0) { cur = null; return syncUi(); }
    const t = { ...cur.t }, l = d.layers[i];
    quiet(() => {
      if (!cur.recorded) { d.record(); cur.recorded = true; }
      d.layers[i] = { ...l, ...renderText(t, d.width, d.height), meta: { text: t }, name: l.name.startsWith("Text") ? layerName(t.text) : l.name };
      cur.ref = t;
      d.emit();
    });
  }
  const schedule = () => { if (!pending) pending = requestAnimationFrame(write); };
  const flush = () => { if (pending) { cancelAnimationFrame(pending); write(); } };

  /** Change the current text (or the style for the next one). */
  function edit(fn) {
    const t = params(), w0 = cur && !t.w ? measureText(t).w : 0;
    fn(t);
    for (const k of [...Object.keys(TEXT_STYLE), "color", "size"]) style[k] = t[k];
    const { size, ...keep } = style;
    localStorage.setItem("pc-text", JSON.stringify(keep));
    if (!cur) return;
    // Unwrapped text grows from its alignment side, like Photoshop's point text.
    if (!t.w) { const dw = measureText(t).w - w0; t.x -= t.align === "center" ? dw / 2 : t.align === "right" ? dw : 0; }
    schedule();
  }

  /* ---- editing sessions ---- */
  function addText(p, w = 0, center = false, typing = false) {
    done();
    const d = A.doc;
    const t = { ...style, text: area.value.trim() ? area.value : "Your text", w, x: p.x, y: p.y };
    if (!w) {
      const L = measureText(t);
      t.x = p.x - (center || t.align === "center" ? L.w / 2 : t.align === "right" ? L.w : 0);
      t.y = p.y - L.h / 2;
    }
    const r = renderText(t, d.width, d.height);
    quiet(() => d.change((d) => {
      d.layers.splice(d.active + 1, 0, makeLayer(r.canvas, layerName(t.text), { over: r.over, meta: { text: t } }));
      d.active += 1;
    }));
    cur = { id: d.layer.id, t: { ...t }, ref: t, recorded: true, created: true };
    syncUi(); A.redraw();
    if (!typing) focusArea(true);
  }

  function editLayer(i, focus = false) {
    const d = A.doc, l = d.layers[i];
    if (cur?.id === l.id) { if (focus) focusArea(); return true; }
    done();
    if (d.active !== i) quiet(() => { d.active = i; d.emit(); });
    if (!guard(A)) { syncUi(); return false; }
    cur = { id: l.id, t: { ...l.meta.text }, ref: l.meta.text, recorded: false, created: false };
    syncUi(); A.redraw();
    if (focus) focusArea();
    return true;
  }

  /** Pick up the active layer if it's an editable text layer (tool opened, undo, layer picked in the panel). */
  function loadActive() {
    if (pending) { cancelAnimationFrame(pending); pending = 0; }
    const l = A.doc.layer, t = l.meta?.text, k = l.lock || {};
    cur = t && l.visible && !k.all && !k.pixels ? { id: l.id, t: { ...t }, ref: t, recorded: false, created: false } : null;
    syncUi(); A.redraw();
  }

  /** Finish editing. Text left empty removes its layer. */
  function done() {
    if (!cur) return;
    flush();
    const c = cur, d = A.doc, i = indexOf(c.id);
    cur = null;
    if (i >= 0 && !c.t.text.trim()) quiet(() => {
      if (c.created) { d.undo(); d.redoStack.pop(); } // never mind: nothing was added
      else if (d.layers.length > 1) d.change((d) => d.layers.splice(i, 1));
    });
    if (document.activeElement === area) area.blur();
    syncUi(); A.redraw();
  }

  /* ---- panel ---- */
  const area = h("textarea", { rows: 3, spellcheck: "true", placeholder: "Type here to add text" });
  area.addEventListener("input", () => {
    if (!cur) { if (area.value.trim()) addText({ x: A.doc.width / 2, y: A.doc.height / 2 }, 0, true, true); return; }
    edit((t) => { t.text = area.value; });
  });
  area.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); done(); }
  });
  const focusArea = (select = false) => { area.focus({ preventScroll: true }); if (select) area.select(); };

  const fontSeg = seg([
    { value: "sans", label: "Sans" }, { value: "serif", label: "Serif" }, { value: "impact", label: "Bold" },
    { value: "mono", label: "Mono" }, { value: "hand", label: "Casual" },
  ], style.font, (v) => edit((t) => { t.font = v; }));
  const weightSeg = seg([
    { value: 300, label: "Light" }, { value: 400, label: "Regular" }, { value: 600, label: "Semibold" }, { value: 700, label: "Bold" }, { value: 900, label: "Black" },
  ], style.weight, (v) => edit((t) => { t.weight = v; }));
  const sizeRange = h("input", { type: "range", min: 8, max: maxSize, value: style.size, "aria-label": "Font size" });
  const sizeIn = h("input", { type: "number", min: 4, max: 2000, step: 1, value: style.size, inputmode: "numeric", "aria-label": "Font size in pixels" });
  const setSize = (v) => { v = clamp(Math.round(v), 4, 2000); sizeRange.value = v; edit((t) => { t.size = v; }); };
  sizeRange.addEventListener("input", () => { sizeIn.value = sizeRange.value; setSize(+sizeRange.value); });
  sizeIn.addEventListener("input", () => { if (+sizeIn.value >= 4) setSize(+sizeIn.value); });
  const alignSeg = seg([{ value: "left", label: "Left" }, { value: "center", label: "Center" }, { value: "right", label: "Right" }], style.align, (v) => edit((t) => { t.align = v; }));
  const colorSw = swatches({ value: style.color, onChange: (v) => edit((t) => { t.color = v; }) });
  const bgSw = swatches({ value: style.bg, transparent: true, onChange: (v) => edit((t) => { t.bg = v; }) });
  bgSw.querySelector(".swatch.transparent").title = "No background";
  const italic = h("input", { type: "checkbox", checked: style.italic, onchange: (e) => edit((t) => { t.italic = e.target.checked; }) });
  const outline = h("input", { type: "checkbox", checked: style.outline, onchange: (e) => edit((t) => { t.outline = e.target.checked; }) });
  const hint = h("p", { class: "hint" });
  const doneBtn = h("button", { class: "grow", onclick: () => done() }, "Done");

  function syncUi() {
    const t = params();
    if (document.activeElement !== area || !cur) area.value = cur ? t.text : "";
    fontSeg.set(t.font); weightSeg.set(t.weight); alignSeg.set(t.align);
    sizeRange.value = t.size; if (document.activeElement !== sizeIn) sizeIn.value = t.size;
    colorSw.set(t.color); bgSw.set(t.bg);
    italic.checked = t.italic; outline.checked = t.outline;
    doneBtn.disabled = !cur;
    hint.textContent = cur
      ? "Drag the text to move it, drag the side handles to set the box width. Esc or Done when finished."
      : "Click the photo to add text, or drag to draw a text box. Click existing text to edit it.";
  }

  /* ---- canvas interaction ---- */
  const tolOf = (e) => (e?.pointerType === "touch" ? 22 : 10) / A.view.zoom;
  const inside = (b, p, tol) => p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol;
  function hit(p, tol) {
    if (!cur || indexOf(cur.id) < 0) return null;
    const t = cur.t, L = measureText(t);
    for (const side of [-1, 1]) {
      const hx = side < 0 ? t.x : t.x + L.w;
      if (Math.abs(p.x - hx) <= tol && p.y >= t.y - tol && p.y <= t.y + L.h + tol) return { type: "width", side, w0: L.w };
    }
    return inside(textBox(t, L), p, tol / 2) ? { type: "move" } : null;
  }

  loadActive();
  return {
    title: "Text",
    body: [
      area,
      h("div", { class: "field" }, "Font", fontSeg),
      h("div", { class: "field" }, h("span", { class: "lab" }, "Font size", h("span", { class: "num" }, sizeIn, "px")), sizeRange),
      h("div", { class: "field" }, "Weight", weightSeg),
      h("div", { class: "field" }, "Align", alignSeg),
      h("div", { class: "field" }, "Text color", colorSw),
      h("div", { class: "field" }, "Background", bgSw),
      h("div", { class: "row" },
        h("label", { class: "checkbox" }, italic, "Italic"),
        h("label", { class: "checkbox" }, outline, "Outline")),
      hint,
      h("div", { class: "row" },
        h("button", { class: "primary grow", onclick: () => addText({ x: A.doc.width / 2, y: A.doc.height / 2 }, 0, true) }, "Add text"),
        doneBtn),
    ],
    cursorStyle: "text",
    wantsPointer: true,
    editAt(p) { const i = textLayerAt(A.doc, p, 6 / A.view.zoom); if (i >= 0) editLayer(i, true); },
    editLayer: (i) => editLayer(i, true),
    down(p, e) {
      hoverIdx = -1;
      const hh = hit(p, tolOf(e));
      if (hh) { drag = { ...hh, start: p, t0: { ...cur.t }, moved: false }; return; }
      const i = textLayerAt(A.doc, p, tolOf(e) / 2);
      if (i >= 0) { if (editLayer(i)) drag = { type: "move", start: p, t0: { ...cur.t }, moved: false }; return; }
      // Clicking away finishes the current text; the next click adds a new one.
      if (cur) { done(); return; }
      drag = { type: "new", start: p, end: p, moved: false };
    },
    move(p, e) {
      if (!drag) return;
      let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) * A.view.zoom < 4) return;
        if (drag.type === "move" && !guard(A, "position")) { drag = null; return; }
        drag.moved = true;
      }
      if (drag.type === "new") { drag.end = p; return A.redraw(); }
      const t = cur.t, t0 = drag.t0;
      if (drag.type === "move") {
        if (e?.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        t.x = Math.round(t0.x + dx); t.y = Math.round(t0.y + dy);
      } else {
        const w = Math.round(Math.max(t.size, drag.w0 + dx * drag.side));
        t.w = w;
        if (drag.side < 0) t.x = Math.round(t0.x + drag.w0 - w);
      }
      schedule(); A.redraw();
    },
    up(p) {
      const g = drag;
      drag = null;
      if (!g) return;
      if (g.type === "new") {
        if (!p) return; // a second finger started a pinch
        const w = Math.abs(g.end.x - g.start.x);
        if (g.moved && w * A.view.zoom > 16) addText({ x: Math.min(g.start.x, g.end.x), y: Math.min(g.start.y, g.end.y) }, Math.round(w));
        else addText(g.start);
      } else if (g.moved) flush();
      else focusArea();
    },
    hover(p) {
      hoverIdx = -1;
      if (!p) return A.redraw();
      const hh = hit(p, 10 / A.view.zoom);
      if (!hh) hoverIdx = textLayerAt(A.doc, p, 5 / A.view.zoom);
      A.setCursorStyle(hh?.type === "width" ? "ew-resize" : hh || hoverIdx >= 0 ? "move" : "text");
      A.redraw();
    },
    keydown(e) {
      if (e.key === "Escape" && cur) { done(); return true; }
      if (e.key === "Enter" && cur) { focusArea(); return true; }
      if (e.key === "[" || e.key === "]") {
        const s = params().size, step = Math.max(1, Math.round(s * 0.1));
        setSize(clamp(s + (e.key === "]" ? step : -step), 4, 2000)); sizeIn.value = params().size;
        return true;
      }
    },
    onDocChange() {
      if (self) return;
      const l = A.doc.layer;
      // Another change was recorded since: the next edit is a new undo step.
      if (cur && l.id === cur.id && l.meta?.text === cur.ref) { cur.recorded = cur.created = false; syncUi(); }
      else loadActive();
    },
    overlay(ctx, view) {
      const box = (b, dash, color) => {
        const a = view.toScreen(b.x, b.y);
        ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(b.w * view.zoom), Math.round(b.h * view.zoom));
        return a;
      };
      if (drag?.type === "new" && drag.moved) {
        const s = drag.start, e = drag.end;
        box({ x: Math.min(s.x, e.x), y: Math.min(s.y, e.y), w: Math.abs(e.x - s.x), h: Math.abs(e.y - s.y) }, [5, 4], "rgba(58,109,240,.9)");
      }
      const hl = A.doc.layers[hoverIdx];
      if (hl?.meta?.text && hl.id !== cur?.id) box(textBox(hl.meta.text), [3, 3], "rgba(58,109,240,.7)");
      if (!cur || indexOf(cur.id) < 0) return;
      const L = measureText(cur.t);
      const a = box({ x: cur.t.x, y: cur.t.y, w: L.w, h: L.h }, [5, 4], "rgba(58,109,240,.95)");
      ctx.setLineDash([]); ctx.fillStyle = "#fff"; ctx.strokeStyle = "#3a6df0"; ctx.lineWidth = 1.5;
      for (const x of [a.x, a.x + L.w * view.zoom]) {
        ctx.beginPath(); ctx.rect(Math.round(x) - 4.5, Math.round(a.y + (L.h * view.zoom) / 2) - 6.5, 9, 13); ctx.fill(); ctx.stroke();
      }
    },
    cleanup() { done(); A.setCursorStyle(""); },
  };
}

/* -------------------------------------------------------------------------- */
/* Corners & border                                                            */
/* -------------------------------------------------------------------------- */

export function frameTool(A) {
  const v = { radius: 0, circle: false, pad: 0, color: "transparent" };
  const render = () => {
    const out = frame(A.composite(), v);
    A.setSource(out, out.width, out.height);
  };
  const frame = (src, o) => {
    let w = src.width, hh = src.height, sx = 0, sy = 0;
    if (o.circle) { const m = Math.min(w, hh); sx = (w - m) / 2; sy = (hh - m) / 2; w = hh = m; }
    const pad = Math.round((Math.min(w, hh) * o.pad) / 100);
    const out = makeCanvas(w + pad * 2, hh + pad * 2), x = out.getContext("2d");
    if (o.color !== "transparent") {
      x.fillStyle = o.color;
      x.beginPath();
      const outerR = o.circle ? out.width / 2 : (Math.min(out.width, out.height) * o.radius) / 200;
      x.roundRect(0, 0, out.width, out.height, outerR);
      x.fill();
    }
    x.save();
    x.beginPath();
    const r = o.circle ? w / 2 : (Math.min(w, hh) * o.radius) / 200;
    x.roundRect(pad, pad, w, hh, r);
    x.clip();
    x.drawImage(src, sx, sy, w, hh, pad, pad, w, hh);
    x.restore();
    return out;
  };
  const radius = slider({ label: "Rounded corners", min: 0, max: 100, value: 0, format: (x) => `${x}%`, onInput: (x) => { v.radius = x; render(); } });
  const circle = h("input", { type: "checkbox", onchange: (e) => { v.circle = e.target.checked; radius.input.disabled = v.circle; render(); } });
  const border = slider({ label: "Border", min: 0, max: 30, value: 0, format: (x) => `${x}%`, onInput: (x) => { v.pad = x; render(); } });
  const colors = swatches({ value: v.color, transparent: true, onChange: (c) => { v.color = c; render(); } });
  const reset = () => {
    Object.assign(v, { radius: 0, circle: false, pad: 0, color: "transparent" });
    radius.set(0); border.set(0); colors.set("transparent"); circle.checked = false; radius.input.disabled = false;
    A.setSource(null);
  };
  return {
    title: "Corners & border",
    body: [
      radius,
      h("label", { class: "checkbox" }, circle, "Circle (profile picture)"),
      border,
      colors,
      h("p", { class: "note" }, "Rounded and circle shapes need PNG or WebP to keep the corners transparent."),
      applyButtons(() => {
        if (!v.radius && !v.circle && !v.pad) return A.toast("Choose a corner, circle or border first.");
        const opts = { ...v };
        reset();
        // The border color goes on the bottom layer only.
        A.doc.commitAll((c, i) => frame(c, i === 0 ? opts : { ...opts, color: "transparent" }));
        A.view.fit();
      }, reset),
    ],
    cleanup() { A.setSource(null); },
  };
}

/* -------------------------------------------------------------------------- */
/* Rotate & flip                                                               */
/* -------------------------------------------------------------------------- */

/** Rotate by any angle; with expand=true the canvas grows to fit (transparent corners). */
export function rotateFree(d, deg, expand, w = d.width, hgt = d.height) {
  const rad = (deg * Math.PI) / 180, sin = Math.abs(Math.sin(rad)), cos = Math.abs(Math.cos(rad));
  const ow = expand ? Math.round(w * cos + hgt * sin) : d.width;
  const oh = expand ? Math.round(w * sin + hgt * cos) : d.height;
  const c = makeCanvas(ow, oh), x = c.getContext("2d");
  x.imageSmoothingQuality = "high";
  x.translate(ow / 2, oh / 2); x.rotate(rad); x.drawImage(d, -d.width / 2, -d.height / 2);
  return c;
}

export function rotateTool(A) {
  let scope = "image", angle = 0;
  const layerOnly = () => scope === "layer" && A.doc.hasLayers;
  const scopeSeg = seg([{ value: "image", label: "Whole image" }, { value: "layer", label: "Current layer" }], scope, (v) => { scope = v; angleSlider.set(0); angle = 0; A.setSource(null); });
  const scopeRow = h("label", {}, "Apply to", scopeSeg);
  const run = (fnImage, fnLayer) => {
    if (layerOnly()) { if (guard(A, "position")) A.doc.commit(fnLayer(A.doc.canvas), {}, { over: null }); }
    else { A.doc.commitAll(fnImage); A.view.fit(); }
  };
  const preview = () => {
    if (!angle) return A.setSource(null);
    if (layerOnly()) A.setSource(rotateFree(A.doc.canvas, angle, false));
    else { const c = rotateFree(A.composite(), angle, true); A.setSource(c, c.width, c.height); }
  };
  const angleSlider = slider({ label: "Angle", min: -180, max: 180, step: 0.5, value: 0, format: (v) => `${v}°`, onInput: (v) => { angle = v; preview(); } });
  const sync = () => { scopeRow.hidden = !A.doc.hasLayers; };
  sync();
  return {
    title: "Rotate & flip",
    body: [
      scopeRow,
      h("div", { class: "row" },
        h("button", { class: "grow", title: "Rotate 90° left", onclick: () => run((c) => rotateCanvas90(c, -1), (c) => rotateFree(c, -90, false)) }, "↺ Rotate left"),
        h("button", { class: "grow", title: "Rotate 90° right", onclick: () => run((c) => rotateCanvas90(c, 1), (c) => rotateFree(c, 90, false)) }, "↻ Rotate right")),
      h("div", { class: "row" },
        h("button", { class: "grow", onclick: () => run((c) => flipCanvas(c, true), (c) => flipCanvas(c, true)) }, "↔ Flip horizontal"),
        h("button", { class: "grow", onclick: () => run((c) => flipCanvas(c, false), (c) => flipCanvas(c, false)) }, "↕ Flip vertical")),
      angleSlider,
      h("p", { class: "hint" }, "Any angle. The whole image grows to fit; use Crop › Straighten to level a tilted horizon instead."),
      applyButtons(() => {
        if (!angle) return A.toast("Move the angle slider first.");
        const deg = angle; angle = 0; angleSlider.set(0); A.setSource(null);
        if (layerOnly()) A.doc.commit(rotateFree(A.doc.canvas, deg, false), {}, { over: null });
        else {
          const W = A.doc.width, H = A.doc.height;
          A.doc.commitAll((c) => rotateFree(c, deg, true, W, H));
          A.view.fit();
        }
      }, () => { angle = 0; angleSlider.set(0); A.setSource(null); }, "Rotate"),
    ],
    onDocChange() { sync(); if (angle) preview(); },
    cleanup() { A.setSource(null); },
  };
}

/* -------------------------------------------------------------------------- */
/* Layers                                                                      */
/* -------------------------------------------------------------------------- */

function thumb(layer, w, hgt) {
  const s = ops.fitSize(w, hgt, 44, 44);
  const c = makeCanvas(s.width, s.height);
  c.getContext("2d").drawImage(layer.canvas, 0, 0, s.width, s.height);
  c.className = "lthumb";
  return c;
}

const EYE = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

const LOCK_ICONS = {
  alpha: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 2"/><rect x="7" y="7" width="5" height="5" fill="currentColor"/><rect x="12" y="12" width="5" height="5" fill="currentColor"/></svg>',
  pixels: '<svg viewBox="0 0 24 24"><path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L11 15.8 8.2 13z"/><path d="M7 14c-2 0-3 1.5-3 3 0 1.2-.8 2.2-2 3 3 1 7 .5 8-3z"/></svg>',
  position: '<svg viewBox="0 0 24 24"><path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/></svg>',
  all: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
};
const LOCKS = [
  ["alpha", "Transparency", "Lock transparent pixels: paint only where the layer already has pixels"],
  ["pixels", "Pixels", "Lock image pixels: no painting or editing"],
  ["position", "Position", "Lock position: no moving or transforming"],
  ["all", "All", "Lock all: no changes at all"],
];

const ICON = {
  add: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 8v8M8 12h8"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 8"/></svg>',
  dup: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  merge: '<svg viewBox="0 0 24 24"><path d="M8 4v6l4 4 4-4V4M12 14v6"/></svg>',
  clear: '<svg viewBox="0 0 24 24"><path d="M4 20h16M7 16 17 6M7 6l10 10" opacity=".9"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
};

/** The always-visible Layers dock (bottom of the right sidebar). */
export function layersPanel(A) {
  const el = h("div", { class: "layers-panel" });
  const list = h("ol", { class: "layers", "aria-label": "Layers (top first)" });
  const opacity = h("input", { type: "range", min: 0, max: 100, value: 100, "aria-label": "Layer opacity" });
  const opOut = h("output", {}, "100%");
  opacity.addEventListener("input", () => { opOut.textContent = `${opacity.value}%`; liveProp({ opacity: opacity.value / 100 }); });
  opacity.addEventListener("change", () => endLive());
  const blend = h("select", { "aria-label": "Blend mode", title: "Blend mode" }, BLEND_MODES.map(([v, label]) => h("option", { value: v }, label)));
  blend.onchange = () => { if (notAllLocked()) A.doc.setLayerProps(A.doc.active, { blend: blend.value }); else blend.value = A.doc.layer.blend; };
  const lockRow = h("div", { class: "lock-row" });
  const notAllLocked = () => { if (A.doc.layer.lock?.all) { A.toast("This layer is fully locked."); return false; } return true; };

  let liveStarted = false;
  function liveProp(props) {
    const d = A.doc;
    if (d.layer.lock?.all) return;
    if (!liveStarted) { d.record(); liveStarted = true; }
    d.layers[d.active] = { ...d.layer, ...props };
    A.refreshView();
  }
  function endLive() { if (liveStarted) { liveStarted = false; A.doc.emit(); } else render(); }

  const ops_ = layerOps(A);
  const rename = (i) => {
    const name = prompt("Layer name", A.doc.layers[i].name);
    if (name && name.trim()) A.doc.setLayerProps(i, { name: name.trim().slice(0, 40) });
  };
  const toggleLock = (key) => {
    const d = A.doc, cur = d.layer.lock || {};
    d.setLayerProps(d.active, { lock: { ...cur, [key]: !cur[key] } });
  };
  const ib = (icon, title, onclick, cls = "") => h("button", { class: `icon-btn ${cls}`, title, "aria-label": title, html: ICON[icon], onclick });

  function render() {
    const d = A.doc;
    if (!d) return;
    list.replaceChildren();
    for (let i = d.layers.length - 1; i >= 0; i--) {
      const l = d.layers[i];
      const eye = h("button", { class: "icon-btn eye", title: l.visible ? "Hide layer" : "Show layer", "aria-label": l.visible ? "Hide layer" : "Show layer", html: l.visible ? EYE : EYE_OFF });
      eye.onclick = (e) => { e.stopPropagation(); d.setLayerProps(i, { visible: !l.visible }); };
      const locked = l.lock && Object.values(l.lock).some(Boolean);
      const name = h("span", { class: "lname", title: "Double-click to rename" }, l.name);
      const sub = h("span", { class: "lsub" }, [l.meta?.text ? "Text" : "", l.opacity < 1 ? `${Math.round(l.opacity * 100)}%` : "", l.blend !== "source-over" ? BLEND_MODES.find((b) => b[0] === l.blend)[1] : ""].filter(Boolean).join(" · "));
      const li = h("li", {
        class: `${i === d.active ? "active" : ""} ${l.visible ? "" : "hidden-layer"}`, tabindex: 0,
        onclick: () => { if (d.active !== i) { d.active = i; d.emit(); } },
        // Double-click a text layer to edit its text; double-click a name to rename.
        ondblclick: (e) => (l.meta?.text && !e.target.closest(".lname") ? A.editText?.(i) : rename(i)),
        onkeydown: (e) => { if (e.key === "Enter") rename(i); },
      }, eye, thumb(l, d.width, d.height), h("span", { class: "linfo" }, name, sub), locked ? h("span", { class: "lock-ico", title: "Locked", html: LOCK_ICONS.all }) : null);
      list.append(li);
    }
    opacity.value = Math.round(d.layer.opacity * 100); opOut.textContent = `${opacity.value}%`;
    blend.value = d.layer.blend;
    const lock = d.layer.lock || {};
    lockRow.replaceChildren(h("span", { class: "lock-label" }, "Lock:"), ...LOCKS.map(([key, label, title]) =>
      h("button", { class: `icon-btn ${lock[key] ? "on" : ""}`, title, "aria-label": title, "aria-pressed": lock[key] ? "true" : "false", html: LOCK_ICONS[key], onclick: () => toggleLock(key) })));
  }

  el.append(
    h("div", { class: "dock-head" }, h("h2", {}, "Layers")),
    h("div", { class: "layer-props" }, blend, h("label", { class: "op" }, "Opacity", opacity, opOut)),
    lockRow,
    list,
    h("div", { class: "layer-bar" },
      ib("add", "New layer (Ctrl+Shift+N)", ops_.addBlank),
      ib("image", "Add image as layer", () => A.pickLayerImage()),
      ib("dup", "Duplicate layer", ops_.duplicate),
      ib("up", "Move layer up", () => ops_.moveBy(1)),
      ib("down", "Move layer down", () => ops_.moveBy(-1)),
      ib("merge", "Merge down (Ctrl+E)", ops_.mergeDown),
      ib("clear", "Clear layer", ops_.clear),
      ib("trash", "Delete layer", ops_.remove, "danger")),
  );
  return { el, render };
}

/** Layer commands shared by the Layers dock and the Layer menu. */
export function layerOps(A) {
  const lockedAll = () => { if (A.doc.layer.lock?.all) { A.toast("This layer is fully locked."); return true; } return false; };
  const flatInto = (layers) => {
    const d = A.doc, c = makeCanvas(d.width, d.height), x = c.getContext("2d");
    for (const l of layers) { if (!l.visible) continue; x.globalAlpha = l.opacity; x.globalCompositeOperation = l.blend; x.drawImage(l.canvas, 0, 0); }
    return c;
  };
  return {
    addBlank: () => A.doc.change((d) => {
      d.layers.splice(d.active + 1, 0, makeLayer(makeCanvas(d.width, d.height), `Layer ${d.layers.length + 1}`));
      d.active += 1;
    }),
    duplicate: () => A.doc.change((d) => {
      const l = d.layer;
      d.layers.splice(d.active + 1, 0, makeLayer(copyCanvas(l.canvas), `${l.name} copy`, { opacity: l.opacity, blend: l.blend, visible: l.visible, over: l.over, meta: l.meta.text ? { text: l.meta.text } : {} }));
      d.active += 1;
    }),
    remove: () => {
      if (!A.doc.hasLayers) return A.toast("An image needs at least one layer.");
      if (lockedAll()) return;
      A.doc.change((d) => { d.layers.splice(d.active, 1); d.active = Math.min(d.active, d.layers.length - 1); });
    },
    clear: () => { if (guard(A)) A.doc.commit(makeCanvas(A.doc.width, A.doc.height), {}, { over: null }); },
    moveBy: (dir) => {
      const d = A.doc, j = d.active + dir;
      if (j < 0 || j >= d.layers.length) return;
      d.change((d) => { [d.layers[d.active], d.layers[j]] = [d.layers[j], d.layers[d.active]]; d.active = j; });
    },
    mergeDown: () => {
      const d = A.doc;
      if (d.active === 0) return A.toast("There's no layer below to merge into.");
      const below = d.layers[d.active - 1];
      if (below.lock?.all || below.lock?.pixels) return A.toast(`"${below.name}" is locked.`);
      d.change((d) => {
        const top = d.layers[d.active], below = d.layers[d.active - 1];
        const c = copyCanvas(below.canvas), x = c.getContext("2d");
        if (top.visible) { x.globalAlpha = top.opacity; x.globalCompositeOperation = top.blend; x.drawImage(top.canvas, 0, 0); }
        d.layers.splice(d.active - 1, 2, { ...below, canvas: c, meta: {} });
        d.active -= 1;
      });
    },
    mergeVisible: () => {
      const d = A.doc;
      if (d.layers.filter((l) => l.visible).length < 2) return A.toast("Need at least two visible layers.");
      d.change((d) => {
        const merged = makeLayer(flatInto(d.layers), "Merged");
        const firstVis = d.layers.findIndex((l) => l.visible);
        d.layers = d.layers.filter((l, i) => !l.visible || i === firstVis).map((l) => (l.visible ? merged : l));
        d.active = d.layers.indexOf(merged);
      });
    },
    flatten: () => {
      if (!A.doc.hasLayers) return A.toast("There's only one layer.");
      A.doc.change((d) => { d.layers = [makeLayer(copyCanvas(d.composite()), "Background")]; d.active = 0; });
    },
  };
}
