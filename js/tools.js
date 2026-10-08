// Tool panels and their canvas interactions. Each factory gets the app context
// and returns { title, body, cursor?, down?, move?, up?, overlay?, cleanup?,
// onDocChange? }. Pointer callbacks receive points in image coordinates.

import * as ops from "./ops.js";
import { makeCanvas, ctx2d, copyCanvas, getImageData, canvasFromImageData, resizeCanvas, makeLayer, BLEND_MODES } from "./editor.js";
import { h, slider, seg, swatches, progress, nextFrame } from "./ui.js";

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
    if (busy) return;
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
  return {
    title: "Resize",
    body: [
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
      }, () => setPct(1), "Resize"),
    ],
    onDocChange() { w = A.doc.width; hgt = A.doc.height; sync(); },
  };
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
      A.setSource(canvasFromImageData(runAdjust(base, vals, scale)));
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
    btns.apply.disabled = true; btns.apply.textContent = "Applying…";
    await nextFrame();
    const out = canvasFromImageData(runAdjust(getImageData(A.doc.canvas), vals, 1));
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
  const render = () => { if (current === "none") return A.setSource(null); A.setSource(canvasFromImageData(mixed(base))); };
  make();
  const btns = applyButtons(async () => {
    if (current === "none") return A.toast("Pick a filter first.");
    btns.apply.disabled = true;
    await nextFrame();
    const out = canvasFromImageData(mixed(getImageData(A.doc.canvas)));
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

export function redactTool(A) {
  let mode = localStorage.getItem("pc-redact") || "blur", strength = 60, color = "#000000", drag = null;
  const colorRow = swatches({ value: color, onChange: (v) => { color = v; } });
  colorRow.hidden = mode !== "box";
  const warn = h("p", { class: "note" }, "For passwords, card numbers or IDs, use Solid box. Blur and pixelation can sometimes be reversed.");
  function applyRect(r) {
    r = { x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), w: Math.ceil(r.w), h: Math.ceil(r.h) };
    r.w = Math.min(r.w, A.doc.width - r.x); r.h = Math.min(r.h, A.doc.height - r.y);
    if (r.w < 3 || r.h < 3) return;
    A.doc.commit((c) => {
      const x = ctx2d(c);
      if (mode === "box") { x.fillStyle = color; x.fillRect(r.x, r.y, r.w, r.h); return; }
      const pad = mode === "blur" ? Math.ceil(Math.min(r.w, r.h) * 0.6) : 0;
      const sx = Math.max(0, r.x - pad), sy = Math.max(0, r.y - pad);
      const sw = Math.min(c.width, r.x + r.w + pad) - sx, sh = Math.min(c.height, r.y + r.h + pad) - sy;
      const img = x.getImageData(sx, sy, sw, sh);
      const k = strength / 100;
      if (mode === "pixelate") ops.pixelateRect(img, r.x - sx, r.y - sy, r.w, r.h, Math.max(4, Math.min(r.w, r.h) * (0.05 + 0.3 * k)));
      else ops.blurRect(img, r.x - sx, r.y - sy, r.w, r.h, Math.max(3, Math.min(r.w, r.h) * (0.05 + 0.25 * k)));
      x.putImageData(img, sx, sy);
    });
  }
  return {
    title: "Blur out",
    body: [
      h("p", { class: "hint" }, "Drag over faces, names, number plates or anything private."),
      seg([{ value: "blur", label: "Blur" }, { value: "pixelate", label: "Pixelate" }, { value: "box", label: "Solid box" }], mode, (v) => {
        mode = v; localStorage.setItem("pc-redact", v); colorRow.hidden = v !== "box";
      }),
      slider({ label: "Strength", min: 10, max: 100, value: strength, onInput: (v) => { strength = v; } }),
      colorRow, warn,
    ],
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
/* Draw (pen, highlighter, shapes, arrows)                                     */
/* -------------------------------------------------------------------------- */

function drawShape(x, kind, a, b, width) {
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
  x.stroke();
}

export function drawTool(A) {
  let kind = localStorage.getItem("pc-draw") || "pen";
  let color = localStorage.getItem("pc-color") || "#ff3b30";
  let size = Math.max(2, Math.round(minSide(A.doc) / 160)), hover = null, g = null;
  const sizeSlider = slider({ label: "Size", min: 1, max: Math.max(40, Math.round(minSide(A.doc) / 12)), value: size, onInput: (v) => { size = v; A.redraw(); } });
  return {
    title: "Draw",
    body: [
      seg([
        { value: "pen", label: "Pen" }, { value: "marker", label: "Highlighter" }, { value: "arrow", label: "Arrow" },
        { value: "line", label: "Line" }, { value: "rect", label: "Box" }, { value: "ellipse", label: "Circle" },
      ], kind, (v) => { kind = v; localStorage.setItem("pc-draw", v); }),
      swatches({ value: color, onChange: (v) => { color = v; localStorage.setItem("pc-color", v); } }),
      sizeSlider,
      h("p", { class: "hint" }, "Hold Shift for straight 45° lines."),
    ],
    cursor: "brush",
    wantsPointer: true,
    hover(p) { hover = p; A.redraw(); },
    down(p) { A.doc.begin(); g = { base: copyCanvas(A.doc.canvas), pts: [p], a: p, b: p }; this.move(p); },
    move(p, e) {
      hover = p;
      if (!g) return A.redraw();
      if (e?.shiftKey && kind !== "pen" && kind !== "marker") {
        const dx = p.x - g.a.x, dy = p.y - g.a.y, ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
        p = { x: g.a.x + Math.cos(ang) * len, y: g.a.y + Math.sin(ang) * len };
      }
      g.pts.push(p); g.b = p;
      const x = A.doc.canvas.getContext("2d");
      x.save();
      x.globalCompositeOperation = "copy"; x.drawImage(g.base, 0, 0); x.globalCompositeOperation = "source-over";
      x.strokeStyle = color; x.lineCap = x.lineJoin = "round";
      if (kind === "marker") { x.globalAlpha = 0.35; x.lineWidth = size * 4; x.lineCap = "square"; strokePoints(x, g.pts); }
      else if (kind === "pen") { x.lineWidth = size; strokePoints(x, g.pts); }
      else { x.lineWidth = size; drawShape(x, kind, g.a, g.b, size); }
      x.restore();
      A.refreshView();
    },
    up() { if (g) { g = null; A.doc.emit(); } },
    overlay(ctx, view) { brushCursor(ctx, view, hover, kind === "marker" ? size * 2 : size / 2); },
  };
}

/* -------------------------------------------------------------------------- */
/* Text                                                                        */
/* -------------------------------------------------------------------------- */

const FONTS = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  impact: 'Impact, "Arial Black", "Helvetica Neue", sans-serif',
  hand: '"Comic Sans MS", "Chalkboard SE", "Marker Felt", cursive',
};

function layoutText(ctx, t) {
  ctx.font = `${t.bold ? 700 : 400} ${t.size}px ${FONTS[t.font]}`;
  const lines = t.text.split("\n");
  const lh = t.size * 1.2;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const w = Math.max(1, ...widths), hgt = lines.length * lh;
  return { lines, lh, widths, w, h: hgt };
}

function paintText(ctx, t) {
  const L = layoutText(ctx, t);
  const left = t.x - L.w / 2, top = t.y - L.h / 2;
  if (t.box) {
    const pad = t.size * 0.35;
    ctx.fillStyle = t.boxColor;
    ctx.beginPath();
    ctx.roundRect(left - pad, top - pad * 0.6, L.w + pad * 2, L.h + pad * 1.2, pad * 0.8);
    ctx.fill();
  }
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  L.lines.forEach((line, i) => {
    const y = top + L.lh * (i + 0.5);
    if (t.outline) {
      ctx.lineJoin = "round"; ctx.lineWidth = Math.max(2, t.size / 7);
      ctx.strokeStyle = isLight(t.color) ? "#000" : "#fff";
      ctx.strokeText(line, t.x, y);
    }
    ctx.fillStyle = t.color;
    ctx.fillText(line, t.x, y);
  });
  return { x: left, y: top, w: L.w, h: L.h };
}

function isLight(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150;
}

export function textTool(A) {
  const t = {
    text: "Your text", font: "sans", bold: true, color: "#ffffff", outline: true, box: false, boxColor: "#000000",
    size: Math.round(minSide(A.doc) / 10), x: A.doc.width / 2, y: A.doc.height / 2,
  };
  let drag = null, placed = true;
  const area = h("textarea", { rows: 2, spellcheck: "true" }, t.text);
  area.addEventListener("input", () => { t.text = area.value; A.redraw(); });
  const btns = applyButtons(() => {
    if (!t.text.trim()) return A.toast("Type some text first.");
    // Each text goes on its own layer so it can be moved or removed later.
    A.doc.change((d) => {
      const c = makeCanvas(d.width, d.height);
      paintText(c.getContext("2d"), t);
      d.layers.splice(d.active + 1, 0, makeLayer(c, `Text: ${t.text.trim().split("\n")[0].slice(0, 24)}`));
      d.active += 1;
    });
    placed = false;
    A.toast("Text added as a new layer. Tap the photo to place another.");
  }, () => { t.x = A.doc.width / 2; t.y = A.doc.height / 2; placed = true; A.redraw(); }, "Add text");
  setTimeout(() => { area.focus(); area.select(); }, 50);
  const bounds = () => {
    const x = document.createElement("canvas").getContext("2d");
    const L = layoutText(x, t);
    return { x: t.x - L.w / 2, y: t.y - L.h / 2, w: L.w, h: L.h };
  };
  return {
    title: "Text",
    body: [
      area,
      h("label", {}, "Font", seg([
        { value: "sans", label: "Sans" }, { value: "serif", label: "Serif" }, { value: "impact", label: "Bold" },
        { value: "mono", label: "Mono" }, { value: "hand", label: "Casual" },
      ], t.font, (v) => { t.font = v; A.redraw(); })),
      slider({ label: "Size", min: 8, max: Math.round(minSide(A.doc) / 2), value: t.size, onInput: (v) => { t.size = v; A.redraw(); } }),
      swatches({ value: t.color, onChange: (v) => { t.color = v; A.redraw(); } }),
      h("div", { class: "row" },
        h("label", { class: "checkbox" }, h("input", { type: "checkbox", checked: t.bold, onchange: (e) => { t.bold = e.target.checked; A.redraw(); } }), "Bold"),
        h("label", { class: "checkbox" }, h("input", { type: "checkbox", checked: t.outline, onchange: (e) => { t.outline = e.target.checked; A.redraw(); } }), "Outline"),
        h("label", { class: "checkbox" }, h("input", { type: "checkbox", checked: t.box, onchange: (e) => { t.box = e.target.checked; A.redraw(); } }), "Background")),
      h("p", { class: "hint" }, "Drag the text on the photo to move it."),
      btns,
    ],
    cursor: "crosshair",
    wantsPointer: true,
    down(p) {
      const b = bounds(), pad = 10 / A.view.zoom;
      if (placed && p.x > b.x - pad && p.x < b.x + b.w + pad && p.y > b.y - pad && p.y < b.y + b.h + pad) drag = { dx: t.x - p.x, dy: t.y - p.y };
      else { t.x = p.x; t.y = p.y; placed = true; drag = { dx: 0, dy: 0 }; }
      A.redraw();
    },
    move(p) { if (drag) { t.x = p.x + drag.dx; t.y = p.y + drag.dy; A.redraw(); } },
    up() { drag = null; },
    hover(p) {
      if (!p) return;
      const b = bounds();
      A.setCursorStyle(placed && p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h ? "move" : "crosshair");
    },
    overlay(ctx, view) {
      if (!placed || !t.text) return;
      ctx.save();
      ctx.translate(view.panX, view.panY); ctx.scale(view.zoom, view.zoom);
      const b = paintText(ctx, t);
      ctx.restore();
      const a = view.toScreen(b.x, b.y);
      ctx.setLineDash([5, 4]); ctx.strokeStyle = "rgba(58,109,240,.9)"; ctx.lineWidth = 1;
      ctx.strokeRect(a.x - 6, a.y - 6, b.w * view.zoom + 12, b.h * view.zoom + 12);
    },
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
    if (layerOnly()) A.doc.commit(fnLayer(A.doc.canvas), {});
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
        if (layerOnly()) A.doc.commit(rotateFree(A.doc.canvas, deg, false), {});
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

export function layersTool(A) {
  let moving = false, drag = null;
  const list = h("ol", { class: "layers", "aria-label": "Layers (top first)" });
  const opacity = slider({
    label: "Opacity", min: 0, max: 100, value: 100, format: (v) => `${v}%`,
    onInput: (v) => liveProp({ opacity: v / 100 }),
    onChange: () => endLive(),
  });
  const blend = h("select", { "aria-label": "Blend mode" }, BLEND_MODES.map(([v, label]) => h("option", { value: v }, label)));
  blend.onchange = () => A.doc.setLayerProps(A.doc.active, { blend: blend.value });

  // Live property edits record one undo step per gesture.
  let liveStarted = false;
  function liveProp(props) {
    const d = A.doc;
    if (!liveStarted) { d.record(); liveStarted = true; }
    d.layers[d.active] = { ...d.layer, ...props };
    A.refreshView();
  }
  function endLive() { if (liveStarted) { liveStarted = false; A.doc.emit(); } }

  const btn = (label, title, onclick, cls = "") => h("button", { title, "aria-label": title, class: cls, onclick }, label);
  const addBlank = () => A.doc.change((d) => {
    d.layers.splice(d.active + 1, 0, makeLayer(makeCanvas(d.width, d.height), `Layer ${d.layers.length + 1}`));
    d.active += 1;
  });
  const duplicate = () => A.doc.change((d) => {
    const l = d.layer;
    d.layers.splice(d.active + 1, 0, makeLayer(copyCanvas(l.canvas), `${l.name} copy`, { opacity: l.opacity, blend: l.blend, visible: l.visible }));
    d.active += 1;
  });
  const remove = () => {
    if (!A.doc.hasLayers) return A.toast("An image needs at least one layer.");
    A.doc.change((d) => { d.layers.splice(d.active, 1); d.active = Math.min(d.active, d.layers.length - 1); });
  };
  const moveBy = (dir) => {
    const d = A.doc, j = d.active + dir;
    if (j < 0 || j >= d.layers.length) return;
    d.change((d) => { [d.layers[d.active], d.layers[j]] = [d.layers[j], d.layers[d.active]]; d.active = j; });
  };
  const mergeDown = () => {
    const d = A.doc;
    if (d.active === 0) return A.toast("There's no layer below to merge into.");
    d.change((d) => {
      const top = d.layers[d.active], below = d.layers[d.active - 1];
      const c = copyCanvas(below.canvas), x = c.getContext("2d");
      if (top.visible) { x.globalAlpha = top.opacity; x.globalCompositeOperation = top.blend; x.drawImage(top.canvas, 0, 0); }
      d.layers.splice(d.active - 1, 2, { ...below, canvas: c, meta: {} });
      d.active -= 1;
    });
  };
  const flatten = () => {
    if (!A.doc.hasLayers) return A.toast("There's only one layer.");
    A.doc.change((d) => { d.layers = [makeLayer(copyCanvas(d.composite()), "Background")]; d.active = 0; });
  };
  const rename = (i) => {
    const name = prompt("Layer name", A.doc.layers[i].name);
    if (name && name.trim()) A.doc.setLayerProps(i, { name: name.trim().slice(0, 40) });
  };

  const moveBtn = h("button", { class: "grow", onclick: () => { moving = !moving; moveBtn.classList.toggle("on", moving); A.setCursorStyle(moving ? "move" : ""); } }, "✥ Move layer");

  function render() {
    const d = A.doc;
    list.replaceChildren();
    for (let i = d.layers.length - 1; i >= 0; i--) {
      const l = d.layers[i];
      const eye = h("button", { class: "icon-btn eye", title: l.visible ? "Hide layer" : "Show layer", "aria-label": l.visible ? "Hide layer" : "Show layer", html: l.visible ? EYE : EYE_OFF });
      eye.onclick = (e) => { e.stopPropagation(); d.setLayerProps(i, { visible: !l.visible }); };
      const name = h("span", { class: "lname", title: "Double-click to rename" }, l.name);
      const sub = h("span", { class: "lsub" }, [l.opacity < 1 ? `${Math.round(l.opacity * 100)}%` : "", l.blend !== "source-over" ? BLEND_MODES.find((b) => b[0] === l.blend)[1] : ""].filter(Boolean).join(" · "));
      const li = h("li", {
        class: `${i === d.active ? "active" : ""} ${l.visible ? "" : "hidden-layer"}`, tabindex: 0,
        onclick: () => { if (d.active !== i) { d.active = i; d.emit(); } },
        ondblclick: () => rename(i),
        onkeydown: (e) => { if (e.key === "Enter") rename(i); },
      }, thumb(l, d.width, d.height), h("span", { class: "linfo" }, name, sub), eye);
      list.append(li);
    }
    opacity.set(Math.round(d.layer.opacity * 100));
    blend.value = d.layer.blend;
  }

  const addInput = h("input", { type: "file", accept: "image/*", hidden: true });
  addInput.onchange = () => { const f = addInput.files[0]; addInput.value = ""; if (f) A.addImageLayer(f, f.name); };

  render();
  return {
    title: "Layers",
    body: [
      list,
      h("div", { class: "layer-actions" },
        btn("+ New", "New empty layer", addBlank),
        btn("+ Image", "Add a photo as a new layer", () => addInput.click()),
        btn("Duplicate", "Duplicate layer", duplicate),
        btn("Delete", "Delete layer", remove, "danger")),
      h("div", { class: "layer-actions" },
        btn("↑ Up", "Move layer up", () => moveBy(1)),
        btn("↓ Down", "Move layer down", () => moveBy(-1)),
        btn("Merge down", "Merge into the layer below", mergeDown),
        btn("Flatten", "Merge all layers into one", flatten)),
      h("div", { class: "sub" }, "Selected layer"),
      opacity,
      h("label", {}, "Blend mode", blend),
      h("div", { class: "row" }, moveBtn),
      h("p", { class: "hint" }, "Other tools edit the selected layer. Crop, resize, rotate and corners apply to the whole image. You can also paste or drop a photo to add it as a layer."),
      addInput,
    ],
    onDocChange: render,
    get wantsPointer() { return moving; },
    down(p) { drag = { start: p, base: A.doc.canvas }; },
    move(p) {
      if (!drag) return;
      const dx = Math.round(p.x - drag.start.x), dy = Math.round(p.y - drag.start.y);
      const c = makeCanvas(A.doc.width, A.doc.height);
      c.getContext("2d").drawImage(drag.base, dx, dy);
      drag.shifted = c; drag.dx = dx; drag.dy = dy;
      A.setSource(c);
    },
    up() {
      if (!drag) return;
      const { shifted, dx, dy } = drag; drag = null;
      A.setSource(null);
      if (shifted && (dx || dy)) A.doc.commit(shifted, {});
    },
    cleanup() { A.setCursorStyle(""); },
  };
}
