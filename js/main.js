// Photocairn: app shell. Opening/saving files, the viewport's pointer and
// keyboard handling, and switching between tools.

import { Doc, View, makeCanvas, resizeCanvas, makeLayer } from "./editor.js";
import { formatBytes, fitSize } from "./ops.js";
import { h } from "./ui.js";
import * as T from "./tools.js";
import * as P from "./paint.js";
import * as PSD from "./psd.js";

const $ = (s) => document.querySelector(s);
const app = $("#app"), stageWrap = $("#stage-wrap"), panel = $("#panel");
const fileInput = $("#file"), toastEl = $("#toast");
const view = new View($("#stage"));
const MAX_PIXELS = 16_777_216; // iOS Safari's canvas limit (4096 x 4096)

let doc = null, tool = null, toolName = null;
// A tool's live preview: either of the active layer (composited with the other
// layers) or, with whole=true, of the entire image (e.g. corners/border).
let preview = null;

function display() {
  if (!doc) return;
  let w = doc.width, hgt = doc.height;
  if (preview?.whole) { view.source = preview.canvas; w = preview.w; hgt = preview.h; }
  else view.source = doc.composite(preview?.canvas || null);
  if (w !== view.imgW || hgt !== view.imgH) { view.imgW = w; view.imgH = hgt; view.fit(); }
  view.dirty = true;
}

/* ----------------------------- context for tools ----------------------------- */

const A = {
  get doc() { return doc; },
  view,
  toast,
  redraw() { view.dirty = true; },
  refreshView() { doc.touch(); display(); },
  /** Preview the active layer as `canvas` (null clears). Pass w/h to preview the whole image instead. */
  setSource(canvas, w, hgt) {
    preview = canvas ? { canvas, whole: !!w, w, h: hgt } : null;
    display();
  },
  /** Flattened image of all visible layers. */
  composite() { return doc.composite(); },
  setCursor(kind) {
    stageWrap.classList.toggle("crosshair", kind === "crosshair");
    stageWrap.classList.toggle("brush", kind === "brush");
    stageWrap.classList.toggle("pan", kind === "pan" || !kind);
  },
  setCursorStyle(css) { stageWrap.style.cursor = css || ""; },
  addImageLayer: (blob, name) => addImageLayer(blob, name),
  colors: { fg: localStorage.getItem("pc-fg") || "#000000", bg: localStorage.getItem("pc-bg") || "#ffffff" },
  setColor(which, hex) {
    A.colors[which] = hex;
    localStorage.setItem(`pc-${which}`, hex);
    renderColorWell();
    tool?.onColorChange?.();
  },
  selectionChanged() {
    updateAnts();
    tool?.onSelectionChange?.();
    view.dirty = true;
  },
};

/* ------------------------- colors & selection outline ------------------------ */

function renderColorWell() {
  $("#fg-well").style.background = A.colors.fg;
  $("#bg-well").style.background = A.colors.bg;
  $("#fg-input").value = A.colors.fg;
  $("#bg-input").value = A.colors.bg;
}
$("#fg-input").addEventListener("input", (e) => A.setColor("fg", e.target.value));
$("#bg-input").addEventListener("input", (e) => A.setColor("bg", e.target.value));
$("#fg-well").onclick = () => $("#fg-input").click();
$("#bg-well").onclick = () => $("#bg-input").click();
const swapColors = () => { const { fg, bg } = A.colors; A.setColor("fg", bg); A.setColor("bg", fg); };
const resetColors = () => { A.setColor("fg", "#000000"); A.setColor("bg", "#ffffff"); };
$("#swap-colors").onclick = swapColors;
$("#reset-colors").onclick = resetColors;
renderColorWell();

// Marching ants: animate the dash offset while a selection exists.
let antsPhase = 0, antsTimer = null;
function updateAnts() {
  if (doc?.selection && !antsTimer) antsTimer = setInterval(() => { antsPhase = (antsPhase + 1) % 8; view.dirty = true; }, 120);
  if (!doc?.selection && antsTimer) { clearInterval(antsTimer); antsTimer = null; }
}
view.drawOverlay = (ctx, v) => {
  if (doc?.selection) P.drawSelectionOutline(ctx, v, doc, antsPhase);
  tool?.overlay?.(ctx, v);
};

/* ------------------------------------ toast ----------------------------------- */

let toastTimer;
function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
}

/* ---------------------------------- opening ---------------------------------- */

const baseName = (n) => (n || "image").replace(/\.[^.]+$/, "").replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "image";

function decodeWithImg(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
    img.src = url;
  });
}

async function decode(blob, name) {
  if (blob.type && !blob.type.startsWith("image/") && !PSD.isPsd(blob, name)) { toast("That file isn't an image."); return null; }
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    try { return await decodeWithImg(blob); }
    catch {
      const heic = /hei[cf]/i.test(blob.type + name);
      toast(heic ? "This browser can't open HEIC photos. On iPhone, share the photo as JPG or open it in Safari." : "Couldn't open that image.", 4500);
      return null;
    }
  }
}

/** Add an image as a new layer above the selected one, scaled down to fit and centered. */
async function addImageLayer(blob, name = "image") {
  if (!blob || !doc) return;
  let src;
  if (PSD.isPsd(blob, name)) {
    try { const p = await PSD.readPsd(blob); src = Doc.fromLayers(p.layers, p.width, p.height, name).composite(); }
    catch (err) { return toast(`Couldn't open that PSD: ${err.message}`, 5000); }
  } else src = await decode(blob, name);
  if (!src) return;
  const s = fitSize(src.width, src.height, doc.width, doc.height);
  const c = makeCanvas(doc.width, doc.height), x = c.getContext("2d");
  x.imageSmoothingQuality = "high";
  x.drawImage(src, Math.round((doc.width - s.width) / 2), Math.round((doc.height - s.height) / 2), s.width, s.height);
  src.close?.();
  doc.change((d) => {
    d.layers.splice(d.active + 1, 0, makeLayer(c, baseName(name).slice(0, 30) || "Image"));
    d.active += 1;
  });
  if (toolName !== "layers") selectTool("layers");
  toast("Added as a new layer. Use Move layer to position it.");
}

async function openPsd(blob, name) {
  toast("Opening PSD…", 8000);
  try {
    const p = await PSD.readPsd(blob);
    if (p.width * p.height > MAX_PIXELS) return toast(`This PSD is ${p.width} × ${p.height}, too large to edit here.`, 4500);
    setDoc(Doc.fromLayers(p.layers, p.width, p.height, baseName(name)));
    toast(`Opened ${p.layers.length} layer${p.layers.length === 1 ? "" : "s"}.`);
  } catch (err) {
    console.error(err);
    toast(`Couldn't open that PSD: ${err.message}`, 5000);
  }
}

async function openBlob(blob, name = "image") {
  if (!blob) return;
  if (doc?.canUndo && !confirm("Open a new image? Your current edits will be lost.")) return;
  if (PSD.isPsd(blob, name)) return openPsd(blob, name);
  const src = await decode(blob, name);
  if (!src) return;
  let w = src.width, hgt = src.height;
  if (w * hgt > MAX_PIXELS) {
    const s = Math.sqrt(MAX_PIXELS / (w * hgt));
    w = Math.floor(w * s); hgt = Math.floor(hgt * s);
    toast(`Large photo scaled to ${w} × ${hgt} so it works smoothly.`, 4000);
  }
  const c = makeCanvas(w, hgt);
  const x = c.getContext("2d");
  x.imageSmoothingQuality = "high";
  x.drawImage(src, 0, 0, w, hgt);
  src.close?.();
  setDoc(new Doc(c, baseName(name)));
}

function setDoc(d) {
  doc = d;
  doc.onChange(onDocChange);
  app.classList.remove("empty");
  selectTool(null);
  preview = null;
  view.imgW = 0; display();
  requestAnimationFrame(() => { view.resize(); view.fit(); });
  updateChrome();
  document.title = `${doc.name} · Photocairn`;
}

function onDocChange() {
  display();
  updateChrome();
  updateLayerNote();
  updateAnts();
  tool?.onDocChange?.();
  scheduleExportEstimate();
}

function updateChrome() {
  $("#btn-undo").disabled = !doc?.canUndo;
  $("#btn-redo").disabled = !doc?.canRedo;
}

/* ------------------------------- new blank image ------------------------------ */

const NEW_PRESETS = [
  ["1080 × 1080", 1080, 1080, "Square post"], ["1080 × 1350", 1080, 1350, "Portrait post"],
  ["1080 × 1920", 1080, 1920, "Story / reel"], ["1920 × 1080", 1920, 1080, "Full HD"],
  ["1200 × 630", 1200, 630, "Link preview"], ["512 × 512", 512, 512, "Icon / avatar"],
];
function newImageDialog() {
  let bg = localStorage.getItem("pc-new-bg") || "white";
  const wIn = h("input", { type: "number", min: 1, max: 8000, value: localStorage.getItem("pc-new-w") || 1080, required: true });
  const hIn = h("input", { type: "number", min: 1, max: 8000, value: localStorage.getItem("pc-new-h") || 1080, required: true });
  const bgSeg = h("div", { class: "seg" }, ...[["white", "White"], ["transparent", "Transparent"], ["fg", "Main color"]].map(([v, label]) =>
    h("button", { type: "button", class: v === bg ? "on" : "", onclick: (e) => { bg = v; for (const b of bgSeg.children) b.classList.toggle("on", b === e.currentTarget); } }, label)));
  const dlg = h("dialog", { "aria-label": "New image" },
    h("form", { method: "dialog" },
      h("h2", {}, "New blank image"),
      h("div", { class: "seg" }, ...NEW_PRESETS.map(([label, w, hh, title]) => h("button", { type: "button", title, onclick: () => { wIn.value = w; hIn.value = hh; } }, label))),
      h("div", { class: "row", style: "display:flex;gap:10px" }, h("label", { style: "flex:1" }, "Width (px)", wIn), h("label", { style: "flex:1" }, "Height (px)", hIn)),
      h("label", {}, "Background", bgSeg),
      h("div", { class: "row", style: "display:flex;gap:8px;justify-content:flex-end" },
        h("button", { type: "button", onclick: () => dlg.close() }, "Cancel"),
        h("button", { class: "primary", value: "ok" }, "Create")),
    ));
  dlg.addEventListener("close", () => {
    dlg.remove();
    if (dlg.returnValue !== "ok") return;
    const w = Math.max(1, Math.min(8000, Math.round(+wIn.value))), hh = Math.max(1, Math.min(8000, Math.round(+hIn.value)));
    if (w * hh > MAX_PIXELS) return toast("That's too large. Try 4096 × 4096 or smaller.");
    if (doc?.canUndo && !confirm("Start a new image? Your current edits will be lost.")) return;
    localStorage.setItem("pc-new-w", w); localStorage.setItem("pc-new-h", hh); localStorage.setItem("pc-new-bg", bg);
    const c = makeCanvas(w, hh), x = c.getContext("2d");
    if (bg !== "transparent") { x.fillStyle = bg === "fg" ? A.colors.fg : "#ffffff"; x.fillRect(0, 0, w, hh); }
    setDoc(new Doc(c, "untitled"));
  });
  document.body.append(dlg);
  dlg.showModal();
}
$("#btn-new").onclick = newImageDialog;
$("#btn-new-2").onclick = newImageDialog;

fileInput.addEventListener("change", () => { const f = fileInput.files[0]; fileInput.value = ""; if (f) openBlob(f, f.name); });
const pick = () => fileInput.click();
$("#btn-open").onclick = pick;
$("#btn-open-2").onclick = pick;

// Drag & drop anywhere.
let dragDepth = 0;
const dropTarget = () => (doc ? stageWrap : $("#drop"));
addEventListener("dragenter", (e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); dragDepth++; dropTarget().classList.add("dragover"); } });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; stageWrap.classList.remove("dragover"); $("#drop").classList.remove("dragover"); } });
addEventListener("dragover", (e) => e.preventDefault());
addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0;
  stageWrap.classList.remove("dragover"); $("#drop").classList.remove("dragover");
  const f = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/") || /\.(heic|heif|avif|psd)$/i.test(f.name));
  if (!f) return toast("Drop an image file.");
  doc ? addImageLayer(f, f.name) : openBlob(f, f.name);
});

// Paste.
addEventListener("paste", (e) => {
  if (e.target.closest?.("input, textarea")) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (item) { e.preventDefault(); doc ? addImageLayer(item.getAsFile(), "Pasted") : openBlob(item.getAsFile(), "pasted"); }
});

/* ---------------------------------- tools ---------------------------------- */

const FACTORIES = {
  cutout: T.cutoutTool, crop: T.cropTool, resize: T.resizeTool, adjust: T.adjustTool,
  looks: T.looksTool, redact: T.redactTool, text: T.textTool, frame: T.frameTool,
  layers: T.layersTool, rotate: T.rotateTool,
  move: P.moveTool, select: (a) => P.selectTool(a, makeLayer), transform: P.transformTool,
  brush: (a) => P.paintTool(a, "brush"), pencil: (a) => P.paintTool(a, "pencil"), eraser: (a) => P.paintTool(a, "eraser"),
  shapes: P.shapesTool, fill: P.fillTool, gradient: P.gradientTool, eyedropper: P.eyedropperTool,
  export: exportTool,
};

function selectTool(name, toggle = true) {
  if (name && name === toolName && !toggle) return;
  if (tool) { tool.cleanup?.(); }
  preview = null;
  display();
  tool = null;
  A.setCursor("pan"); A.setCursorStyle("");
  panel.replaceChildren();
  if (name === toolName || !name) { toolName = null; markTool(); view.dirty = true; return; }
  toolName = name;
  tool = FACTORIES[name](A);
  if (tool.cursor) A.setCursor(tool.cursor);
  if (tool.cursorStyle) A.setCursorStyle(tool.cursorStyle);
  layerNote = LAYER_TOOLS.has(name) ? h("p", { class: "layer-note" }) : null;
  panel.append(
    h("div", { class: "panel-head" }, h("h2", {}, tool.title), h("button", { class: "x", "aria-label": "Close", onclick: () => selectTool(null) }, "×")),
    ...[layerNote, ...tool.body].filter(Boolean),
  );
  updateLayerNote();
  markTool();
  view.dirty = true;
}

// Tools that edit only the selected layer (others act on the whole image).
const LAYER_TOOLS = new Set(["cutout", "adjust", "looks", "redact", "move", "transform", "brush", "pencil", "eraser", "shapes", "fill", "gradient"]);
let layerNote = null;
function updateLayerNote() {
  if (!layerNote || !doc) return;
  layerNote.hidden = !doc.hasLayers;
  layerNote.textContent = `Editing layer: ${doc.layer.name}`;
}

function markTool() {
  for (const b of document.querySelectorAll("#tools button")) b.classList.toggle("active", b.dataset.tool === toolName);
  $("#btn-export").classList.toggle("on", toolName === "export");
}

$("#tools").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tool]");
  if (b && doc) selectTool(b.dataset.tool);
});

/* --------------------------------- viewport -------------------------------- */

const pointers = new Map();
let gesture = null; // { type: 'pan'|'tool'|'pinch', ... }

function localPoint(e) {
  const r = stageWrap.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

let spaceDown = false;
stageWrap.addEventListener("pointerdown", (e) => {
  if (!doc) return;
  stageWrap.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, localPoint(e));
  if (pointers.size === 2) {
    if (gesture?.type === "tool") { tool?.up?.(); }
    const [a, b] = [...pointers.values()];
    gesture = { type: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    return;
  }
  if (pointers.size > 2) return;
  const p = localPoint(e);
  const wants = tool && (tool.wantsPointer ?? !!tool.down);
  if (e.button === 1 || spaceDown || !wants || e.button === 2) {
    gesture = { type: "pan", last: p };
    stageWrap.classList.add("panning");
  } else {
    gesture = { type: "tool" };
    tool.down(view.toImage(p.x, p.y), e);
  }
});

stageWrap.addEventListener("pointermove", (e) => {
  if (!doc) return;
  const p = localPoint(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
  if (gesture?.type === "pinch" && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    view.panX += mid.x - gesture.mid.x; view.panY += mid.y - gesture.mid.y;
    view.zoomAt(dist / gesture.dist, mid.x, mid.y);
    gesture.dist = dist; gesture.mid = mid;
    updateZoomLabel();
    return;
  }
  if (gesture?.type === "pan") {
    view.panX += p.x - gesture.last.x; view.panY += p.y - gesture.last.y;
    gesture.last = p; view.dirty = true; view.autoFit = false;
    return;
  }
  const ip = view.toImage(p.x, p.y);
  if (gesture?.type === "tool") {
    // Coalesced events give smoother brush strokes on fast moves.
    const evs = e.getCoalescedEvents?.() || [e];
    for (const ce of evs.length ? evs : [e]) { const lp = localPoint(ce); tool?.move?.(view.toImage(lp.x, lp.y), e); }
  } else if (e.pointerType !== "touch") tool?.hover?.(ip);
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (gesture?.type === "tool") tool?.up?.(view.toImage(...Object.values(localPoint(e))), e);
  if (pointers.size === 0) { gesture = null; stageWrap.classList.remove("panning"); }
  else if (gesture?.type === "pinch" && pointers.size === 1) { gesture = { type: "pan", last: [...pointers.values()][0] }; }
}
stageWrap.addEventListener("pointerup", endPointer);
stageWrap.addEventListener("pointercancel", endPointer);
stageWrap.addEventListener("pointerleave", () => { if (!gesture) tool?.hover?.(null); });
stageWrap.addEventListener("contextmenu", (e) => e.preventDefault());

stageWrap.addEventListener("wheel", (e) => {
  if (!doc) return;
  e.preventDefault();
  const p = localPoint(e);
  const mouseWheel = e.deltaMode !== 0 || (Math.abs(e.deltaY) >= 40 && e.deltaX === 0 && Number.isInteger(e.deltaY));
  if (e.ctrlKey || e.metaKey || mouseWheel) {
    view.zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
    updateZoomLabel();
  } else {
    view.panX -= e.deltaX; view.panY -= e.deltaY; view.dirty = true; view.autoFit = false;
  }
}, { passive: false });

function updateZoomLabel() { $("#zoom-label").textContent = `${Math.round(view.zoom * 100)}%`; }
const origRender = view.render.bind(view);
view.render = () => { origRender(); updateZoomLabel(); };

$("#btn-fit").onclick = () => view.fit();
$("#btn-zoom-in").onclick = () => { view.zoomAt(1.25, view.cssW / 2, view.cssH / 2); };
$("#btn-zoom-out").onclick = () => { view.zoomAt(0.8, view.cssW / 2, view.cssH / 2); };
$("#zoom-label").onclick = () => view.actualSize();
$("#zoom-label").style.cursor = "pointer";
$("#btn-undo").onclick = () => doc?.undo();
$("#btn-redo").onclick = () => doc?.redo();
$("#btn-export").onclick = () => doc && selectTool("export");

// Hold to compare with the original photo.
let comparing = null;
function compare(on) {
  if (!doc) return;
  if (on && !comparing) {
    comparing = { source: view.source, w: view.imgW, h: view.imgH, zoom: view.zoom, panX: view.panX, panY: view.panY, overlay: view.drawOverlay };
    view.source = doc.original; view.imgW = doc.original.width; view.imgH = doc.original.height; view.drawOverlay = null;
    view.fit();
    $("#btn-compare").classList.add("on");
  } else if (!on && comparing) {
    Object.assign(view, { source: comparing.source, imgW: comparing.w, imgH: comparing.h, zoom: comparing.zoom, panX: comparing.panX, panY: comparing.panY, drawOverlay: comparing.overlay });
    comparing = null; view.dirty = true;
    $("#btn-compare").classList.remove("on");
  }
}
const cmp = $("#btn-compare");
cmp.addEventListener("pointerdown", (e) => { cmp.setPointerCapture(e.pointerId); compare(true); });
cmp.addEventListener("pointerup", () => compare(false));
cmp.addEventListener("pointercancel", () => compare(false));

/* --------------------------------- keyboard -------------------------------- */

addEventListener("keydown", (e) => {
  const typing = e.target.closest?.("input:not([type=range]):not([type=checkbox]), textarea");
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "o") { e.preventDefault(); pick(); return; }
  if (!doc) return;
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); if (toolName !== "export") selectTool("export"); return; }
  if (typing) return;
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? doc.redo() : doc.undo(); return; }
  if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); doc.redo(); return; }
  if (tool?.keydown?.(e)) { e.preventDefault(); return; }
  const k = e.key.toLowerCase();
  if (mod && k === "a") { e.preventDefault(); P.selectAll(A); return; }
  if (mod && k === "d") { e.preventDefault(); P.deselect(A); return; }
  if (mod && e.shiftKey && k === "i") { e.preventDefault(); P.invertSelection(A); return; }
  if (mod && k === "j") { e.preventDefault(); P.selectionToLayer(A, false, makeLayer); return; }
  if (mod && k === "t") { e.preventDefault(); selectTool("transform", false); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && !mod) { e.preventDefault(); P.clearSelection(A); return; }
  if (!mod && !e.altKey) {
    const shortcut = { v: "move", m: "select", b: "brush", n: "pencil", e: "eraser", i: "eyedropper", k: "fill", g: "gradient", u: "shapes", t: "text", c: "crop", l: "layers" }[k];
    if (shortcut) { selectTool(shortcut, false); return; }
    if (k === "x") { swapColors(); return; }
    if (k === "d") { resetColors(); return; }
  }
  if (e.key === " ") { spaceDown = true; stageWrap.classList.add("pan"); e.preventDefault(); }
  else if (e.key === "Escape") { if (doc.selection) P.deselect(A); else selectTool(null); }
  else if (e.key === "0") view.fit();
  else if (e.key === "1") view.actualSize();
  else if (e.key === "+" || e.key === "=") view.zoomAt(1.25, view.cssW / 2, view.cssH / 2);
  else if (e.key === "-") view.zoomAt(0.8, view.cssW / 2, view.cssH / 2);
  else if (e.key === "\\") compare(true);
});
addEventListener("keyup", (e) => {
  if (e.key === " ") { spaceDown = false; if (tool && (tool.wantsPointer ?? !!tool.down)) stageWrap.classList.remove("pan"); }
  if (e.key === "\\") compare(false);
});

addEventListener("beforeunload", (e) => { if (doc?.canUndo) { e.preventDefault(); e.returnValue = ""; } });

/* ---------------------------------- export --------------------------------- */

const canEncode = (type) => { const c = makeCanvas(1, 1); return c.toDataURL(type).startsWith(`data:${type}`); };
const WEBP = canEncode("image/webp");
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/vnd.adobe.photoshop": "psd" };
let estimateTimer = null, refreshExport = null;
function scheduleExportEstimate() { if (refreshExport) { clearTimeout(estimateTimer); estimateTimer = setTimeout(refreshExport, 250); } }

function hasTransparency(canvas) {
  const s = fitSize(canvas.width, canvas.height, 256, 256);
  const small = resizeCanvas(canvas, s.width, s.height);
  const d = small.getContext("2d").getImageData(0, 0, small.width, small.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

async function renderExport(o) {
  if (o.format === "image/vnd.adobe.photoshop") {
    const blob = await PSD.writePsd(doc);
    return { blob, w: doc.width, h: doc.height, layered: doc.layers.length };
  }
  const w = Math.max(1, Math.round((doc.width * o.scale) / 100)), hgt = Math.max(1, Math.round((doc.height * o.scale) / 100));
  const flat = doc.composite();
  let c = o.scale === 100 ? flat : resizeCanvas(flat, w, hgt);
  if (o.format === "image/jpeg") { // JPEG has no transparency: put it on white
    const flat = makeCanvas(c.width, c.height), x = flat.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, flat.width, flat.height); x.drawImage(c, 0, 0);
    c = flat;
  }
  return new Promise((res) => c.toBlob((b) => res({ blob: b, w: c.width, h: c.height }), o.format, o.quality / 100));
}

function exportTool() {
  const frag = $("#tpl-export").content.cloneNode(true);
  const root = h("div", { style: "display:contents" }, frag);
  const transparent = hasTransparency(doc.composite());
  const o = {
    format: localStorage.getItem("pc-format") || (transparent ? "image/png" : "image/jpeg"),
    quality: 85, scale: 100,
  };
  if (o.format === "image/webp" && !WEBP) o.format = "image/png";
  if (transparent && o.format === "image/jpeg") o.format = "image/png";
  const meta = root.querySelector("#export-meta");
  const qRow = root.querySelector(".q-row");
  const segEl = root.querySelector('[data-name="format"]');
  const nameIn = root.querySelector('[name="filename"]');
  nameIn.value = `${doc.name}-edited`;
  const q = root.querySelector('[name="quality"]'), sc = root.querySelector('[name="scale"]');
  const qOut = q.parentElement.querySelector("output"), sOut = sc.parentElement.querySelector("output");
  const syncUi = () => {
    for (const b of segEl.children) b.classList.toggle("on", b.dataset.v === o.format);
    const psd = o.format === "image/vnd.adobe.photoshop";
    qRow.hidden = o.format === "image/png" || psd;
    sc.parentElement.hidden = psd;
    qOut.textContent = `${o.quality}%`;
    sOut.textContent = `${o.scale}%`;
  };
  for (const b of segEl.children) {
    if (b.dataset.v === "image/webp" && !WEBP) { b.disabled = true; b.title = "This browser can't save WebP"; }
    b.onclick = () => {
      o.format = b.dataset.v; localStorage.setItem("pc-format", o.format); syncUi(); refresh();
      if (o.format === "image/jpeg" && transparent) toast("JPG has no transparency: see-through areas will turn white.", 3500);
    };
  }
  q.oninput = () => { o.quality = +q.value; syncUi(); scheduleExportEstimate(); };
  sc.oninput = () => { o.scale = +sc.value; syncUi(); scheduleExportEstimate(); };
  let last = null, seq = 0;
  async function refresh() {
    const my = ++seq;
    meta.textContent = "Calculating…";
    const r = await renderExport(o);
    if (my !== seq) return;
    last = r;
    meta.textContent = `${r.w} × ${r.h} px · ${formatBytes(r.blob.size)}` + (r.layered ? ` · ${r.layered} layer${r.layered === 1 ? "" : "s"}, opens in Photoshop, GIMP, Photopea` : "");
  }
  refreshExport = refresh;
  root.querySelector('[data-action="download"]').onclick = async () => {
    const r = last && last.blob ? last : await renderExport(o);
    const name = `${baseName(nameIn.value) || "image"}.${EXT[o.format]}`;
    const a = h("a", { href: URL.createObjectURL(r.blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    toast(`Saved ${name}`);
  };
  root.querySelector('[data-action="copy"]').onclick = async () => {
    try {
      const blob = renderExport({ ...o, format: "image/png" }).then((r) => r.blob);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("Copied to clipboard");
    } catch { toast("Your browser didn't allow copying. Use Download instead."); }
  };
  syncUi(); refresh();
  return { title: "Save image", body: [root], cleanup() { refreshExport = null; } };
}

/* ------------------------------ install / offline ----------------------------- */

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

// Files opened via the installed app's "Open with" (PWA file handling).
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (p) => { const f = await p.files?.[0]?.getFile(); if (f) openBlob(f, f.name); });
}

// Debug/test hook (used by the automated browser tests).
window.__photocairn = { open: openBlob, addLayer: addImageLayer, get doc() { return doc; }, view, selectTool };
