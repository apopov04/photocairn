// Photocairn: app shell. Opening/saving files, the viewport's pointer and
// keyboard handling, and switching between tools.

import { ph } from "./icons.js";
import { Doc, View, makeCanvas, resizeCanvas, makeLayer } from "./editor.js";
import { formatBytes, fitSize } from "./ops.js";
import { h, numField, markRadio } from "./ui.js";
import * as T from "./tools.js";
import * as P from "./paint.js";
import * as PSD from "./psd.js";
import { buildMenus } from "./menus.js";
import { metadataDialog, hasGps } from "./metadata-ui.js";
import { historyPanel, resizableStack } from "./history.js";
import { installApi } from "./api.js";

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
  /** Open text layer i for editing with the Text tool. */
  editText(i) { selectTool("text"); tool.editLayer?.(i); },
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
  if (toastEl.textContent === msg) toastEl.textContent = ""; // so a live region re-announces a repeated message
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
  doc.label(name === "Pasted" ? "Paste" : "Place image").change((d) => {
    d.layers.splice(d.active + 1, 0, makeLayer(c, baseName(name).slice(0, 30) || "Image"));
    d.active += 1;
  });
  showTab("layers");
  toast("Added as a new layer. Use Move layer to position it.");
}

async function openPsd(blob, name) {
  toast("Opening PSD…", 8000);
  try {
    const p = await PSD.readPsd(blob);
    if (p.width * p.height > MAX_PIXELS) return toast(`This PSD is ${p.width} × ${p.height}, too large to edit here.`, 4500);
    const d = Doc.fromLayers(p.layers, p.width, p.height, baseName(name));
    d.origin = name;
    setDoc(d);
    toast(`Opened ${p.layers.length} layer${p.layers.length === 1 ? "" : "s"}.`);
  } catch (err) {
    console.error(err);
    toast(`Couldn't open that PSD: ${err.message}`, 5000);
  }
}

async function openBlob(blob, name = "image", ask = true) {
  if (!blob) return;
  if (ask && doc?.canUndo && !confirm("Open a new image? Your current edits will be lost.")) return;
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
  const d = new Doc(c, baseName(name));
  d.sourceFile = blob instanceof File ? blob : new File([blob], name, { type: blob.type });
  d.origin = name;
  setDoc(d);
  if (await hasGps(blob)) toast("This photo contains its GPS location. See File › Metadata. Saved copies never include it.", 5500);
}

function setDoc(d) {
  doc = d;
  doc.onChange(onDocChange);
  doc.labeler = stepLabel;
  app.classList.remove("empty");
  toolName = null;
  selectTool(railTool);
  layersDock.render();
  historyDock.render(true);
  preview = null;
  view.imgW = 0; display();
  requestAnimationFrame(() => { view.resize(); view.fit(); });
  updateChrome();
  document.title = `${doc.name} · Photocairn`;
}

function onDocChange() {
  if (doc.rasterized) { doc.rasterized = false; toast("Text rasterized: it's now pixels and can no longer be edited as text."); }
  display();
  updateChrome();
  updateLayerNote();
  updateAnts();
  layersDock.render();
  historyDock.render();
  tool?.onDocChange?.();
  scheduleExportEstimate();
}

function updateChrome() {
  $("#btn-undo").disabled = !doc?.canUndo;
  $("#btn-redo").disabled = !doc?.canRedo;
  labelStage();
}

/** The canvas's accessible name: what's open and how big it is (for screen readers and browser agents). */
function labelStage() {
  const n = doc?.layers.length || 0;
  const label = doc ? `Image canvas: ${doc.name}, ${doc.width} × ${doc.height} px${n > 1 ? `, ${n} layers` : ""}` : "Image canvas (no image open)";
  if (view.stage.getAttribute("aria-label") !== label) view.stage.setAttribute("aria-label", label);
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
  const bgSeg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Background" }, ...[["white", "White"], ["transparent", "Transparent"], ["fg", "Main color"]].map(([v, label]) =>
    h("button", { type: "button", role: "radio", "aria-label": label, "aria-checked": String(v === bg), class: v === bg ? "on" : "", onclick: (e) => { bg = v; for (const b of bgSeg.children) markRadio(b, b === e.currentTarget); } }, label)));
  const dlg = h("dialog", { "aria-labelledby": "dlg-new-title", "aria-modal": "true" },
    h("form", { method: "dialog" },
      h("h2", { id: "dlg-new-title" }, "New blank image"),
      h("div", { class: "seg", role: "group", "aria-label": "Size presets" }, ...NEW_PRESETS.map(([label, w, hh, title]) => h("button", { type: "button", title, onclick: () => { wIn.value = w; hIn.value = hh; } }, label))),
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
    const d = new Doc(c, "untitled");
    d.stateLabel = "New image"; d.origin = `${w} × ${hh}`;
    setDoc(d);
  });
  document.body.append(dlg);
  dlg.showModal();
}
$("#btn-new-2").onclick = newImageDialog;

fileInput.addEventListener("change", () => { const f = fileInput.files[0]; fileInput.value = ""; if (f) openBlob(f, f.name); });
const pick = () => fileInput.click();
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

// Tool groups (paint, select, fills, shapes, redact) get their current variant
// as the second argument; see toolGroup() below.
const FACTORIES = {
  cutout: T.cutoutTool, crop: T.cropTool, resize: T.resizeTool, adjust: T.adjustTool,
  looks: T.looksTool, redact: T.redactTool, text: T.textTool, frame: T.frameTool,
  layers: T.layersTool, rotate: T.rotateTool,
  move: P.moveTool, select: (a, v) => P.selectTool(a, makeLayer, v), transform: P.transformTool,
  paint: P.paintTool, eraser: (a) => P.paintTool(a, "eraser"),
  shapes: P.shapesTool, fills: (a, v) => (v === "gradient" ? P.gradientTool(a) : P.fillTool(a)), eyedropper: P.eyedropperTool,
  export: exportTool,
};

// Rail tools stay selected (like Photoshop); "panel" tools opened from the
// menus (Adjust, Resize...) return to the previous rail tool when closed.
const RAIL_TOOLS = new Set(["move", "select", "crop", "cutout", "paint", "eraser", "fills", "eyedropper", "shapes", "text", "redact"]);
let railTool = "move";

function selectTool(name, toggle = false) {
  if (!doc) return;
  if (!name) name = railTool;
  const grp = GROUPS.find((g) => g.has(name));
  if (grp) { // a variant of a tool group, e.g. "pen" or "lasso": rebuild the panel for it
    const v = name;
    name = grp.tool;
    if (v !== grp.value) { grp.set(v); toggle = true; }
  }
  if (name === toolName && !toggle) { showTab("props"); return; }
  if (tool) { tool.cleanup?.(); }
  preview = null;
  display();
  tool = null;
  A.setCursor("pan"); A.setCursorStyle("");
  panel.replaceChildren();
  toolName = name;
  if (RAIL_TOOLS.has(name)) railTool = name;
  tool = FACTORIES[name](A, GROUPS.find((g) => g.tool === name)?.value);
  if (tool.cursor) A.setCursor(tool.cursor);
  if (tool.cursorStyle) A.setCursorStyle(tool.cursorStyle);
  layerNote = LAYER_TOOLS.has(name) ? h("p", { class: "layer-note" }) : null;
  panel.append(
    h("div", { class: "panel-head" }, h("h2", {}, tool.title),
      RAIL_TOOLS.has(name) ? null : h("button", { class: "x", "aria-label": "Close", title: "Close", onclick: () => selectTool(railTool) }, "×")),
    ...[layerNote, ...tool.body].filter(Boolean),
  );
  updateLayerNote();
  markTool();
  describeStage();
  showTab("props");
  view.dirty = true;
}

/** Point the canvas's description at the current tool's name and hint, e.g. "Brush. Shift+click draws a straight line…". */
function describeStage() {
  const head = panel.querySelector(".panel-head h2"), hint = panel.querySelector(".hint");
  if (head) head.id = "tool-title";
  if (hint) hint.id = "tool-hint";
  view.stage.setAttribute("aria-describedby", [head && "tool-title", hint && "tool-hint"].filter(Boolean).join(" "));
}

// Tools that edit only the selected layer (others act on the whole image).
const LAYER_TOOLS = new Set(["cutout", "adjust", "looks", "redact", "move", "transform", "paint", "eraser", "shapes", "fills"]);
let layerNote = null;
function updateLayerNote() {
  if (!layerNote || !doc) return;
  layerNote.hidden = !doc.hasLayers;
  layerNote.textContent = `Editing layer: ${doc.layer.name}`;
}

function markTool() {
  for (const b of document.querySelectorAll("#tools button[data-tool]")) {
    b.classList.toggle("active", b.dataset.tool === toolName);
    b.setAttribute("aria-pressed", String(b.dataset.tool === toolName));
  }
  $("#btn-export").classList.toggle("on", toolName === "export");
}

$("#tools").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tool]");
  if (longPressed) { longPressed = false; return; }
  if (b && doc) selectTool(b.dataset.tool);
});

/* ------------- tool groups: several tools share one rail button ------------- */

// A group's rail button shows its current variant (icon, label, tooltip) and a
// corner mark; right-click or long-press opens a flyout to swap variants. Its
// shortcut key (if any) selects the group, and pressing it again (or with
// Shift) cycles. Each variant is a separate tool: selectTool(variant) rebuilds
// the panel with that variant's settings, so the right-side panel never has
// its own switcher. Variant values must be unique across all groups, and
// differ from the group's own tool name (which means "the current variant").
// Variants: { value, label, short?: rail label, key?: own shortcut }.
const GROUPS = [];
// `group` names the rail button for assistive tech: "Brush tool group: Pencil".
function toolGroup({ tool, name, group, variants, icons, storage, key = "", tip = "", initial }) {
  const btn = $(`#tools button[data-tool="${tool}"]`);
  const keys = variants.map((v) => v.value);
  const saved = localStorage.getItem(storage);
  const g = {
    tool, name, variants, icons, btn, key,
    value: keys.includes(saved) ? saved : keys.includes(initial) ? initial : keys[0],
    has: (v) => keys.includes(v),
    next: () => keys[(keys.indexOf(g.value) + 1) % keys.length],
    set(v) {
      g.value = v;
      localStorage.setItem(storage, v);
      const it = variants.find((x) => x.value === v), k = it.key || key;
      btn.innerHTML = `${icons[v]}<span>${it.short || it.label}</span>`;
      btn.title = `${tip}${it.label}${k ? ` (${k})` : ""}. ${key ? `${key} cycles through ${name.toLowerCase()}. ` : ""}Right-click or long-press to choose.`;
      btn.setAttribute("aria-label", `${group} tool group: ${it.label}`);
      if (k) btn.setAttribute("aria-keyshortcuts", k);
    },
  };
  btn.classList.add("group");
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  g.set(g.value);
  // Keyboard: Arrow Down opens the variants with the current one focused.
  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault(); e.stopPropagation();
    openFlyout(g, true);
  });
  btn.addEventListener("contextmenu", (e) => { e.preventDefault(); if (flyout?.group !== g) openFlyout(g); });
  btn.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    longPressed = false;
    const x0 = e.clientX, y0 = e.clientY;
    pressTimer = setTimeout(() => { longPressed = true; openFlyout(g); }, 450);
    const cancel = (ev) => {
      if (ev.type === "pointermove" && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 10) return;
      clearTimeout(pressTimer);
      for (const t of ["pointermove", "pointerup", "pointercancel"]) btn.removeEventListener(t, cancel);
    };
    for (const t of ["pointermove", "pointerup", "pointercancel"]) btn.addEventListener(t, cancel);
  });
  GROUPS.push(g);
  return g;
}

// The flyout menu (one at a time).
let flyout = null, longPressed = false, pressTimer = 0;
function closeFlyout() {
  if (!flyout) return;
  flyout.group.btn.setAttribute("aria-expanded", "false");
  flyout.group.btn.removeAttribute("aria-controls");
  flyout.remove(); flyout = null;
}
function openFlyout(g, focus = false) {
  if (!doc) return;
  closeFlyout();
  flyout = h("ul", { class: "menu-pop tool-flyout", role: "menu", id: "tool-flyout", "aria-label": g.name }, g.variants.map((v) => h("li", { role: "none" },
    h("button", {
      role: "menuitemradio", "aria-checked": String(v.value === g.value), class: v.value === g.value ? "on" : null,
      "aria-label": v.label, "aria-keyshortcuts": v.key || null,
      onclick: () => { closeFlyout(); selectTool(v.value); },
    }, h("span", { html: g.icons[v.value] }, v.label), v.key ? h("kbd", {}, v.key) : null))));
  flyout.group = g;
  g.btn.setAttribute("aria-expanded", "true");
  g.btn.setAttribute("aria-controls", "tool-flyout");
  document.body.append(flyout);
  // Beside the button (left rail), or above it when that doesn't fit (bottom rail on phones).
  const r = g.btn.getBoundingClientRect(), fw = flyout.offsetWidth, fh = flyout.offsetHeight;
  let left = r.right + 4, top = r.top;
  if (top + fh > innerHeight - 4) { left = r.left; top = r.top - fh - 4; }
  flyout.style.left = `${Math.max(4, Math.min(left, innerWidth - fw - 4))}px`;
  flyout.style.top = `${Math.max(4, top)}px`;
  if (focus) flyout.querySelector('[aria-checked="true"]')?.focus();
}
addEventListener("pointerdown", (e) => { if (flyout && !flyout.contains(e.target)) closeFlyout(); }, true);
addEventListener("keydown", (e) => {
  if (!flyout) return;
  if (e.key === "Escape") { e.stopPropagation(); const b = flyout.group.btn; closeFlyout(); b.focus(); return; }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault(); e.stopPropagation();
  const items = [...flyout.querySelectorAll("button")], i = items.indexOf(document.activeElement);
  items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
}, true);
addEventListener("resize", closeFlyout);
$("#tools").addEventListener("scroll", closeFlyout);

// Brush group: brush, pencil, pen, highlighter.
toolGroup({
  tool: "paint", name: "Brush tools", group: "Brush", variants: P.BRUSHES, storage: "pc-brush-tool", key: "B",
  icons: {
    brush: ph("paint-brush"),
    pencil: ph("pencil-simple"),
    pen: ph("pen-nib"),
    highlighter: ph("highlighter"),
  },
});

// Select group: rectangle, ellipse, lasso, polygon, magic wand (stored as pc-sel, as before).
toolGroup({
  tool: "select", name: "Selection tools", group: "Select", variants: P.SEL_KINDS, storage: "pc-sel", key: "M", tip: "Select: ",
  icons: {
    rect: ph("selection"),
    ellipse: ph("circle-dashed"),
    lasso: ph("lasso"),
    polygon: ph("polygon"),
    wand: ph("magic-wand"),
  },
});

// Fill group: paint bucket and gradient.
toolGroup({
  tool: "fills", name: "Fill tools", group: "Fill", variants: P.FILLS, storage: "pc-fill-tool", key: "G",
  icons: {
    fill: ph("paint-bucket"),
    gradient: ph("gradient"),
  },
});

// Shapes group: line, arrow, rectangle, ellipse (rectangle by default, or the kind last used before shapes became a group).
toolGroup({
  tool: "shapes", name: "Shapes", group: "Shapes", variants: P.SHAPES, storage: "pc-shape-tool", key: "U",
  initial: ((k) => (k === "line" || k === "arrow" ? k : `shape-${k || "rect"}`))(JSON.parse(localStorage.getItem("pc-shapes") || "null")?.kind),
  icons: {
    line: ph("line-segment"),
    arrow: ph("arrow-up-right"),
    "shape-rect": ph("rectangle"),
    "shape-ellipse": ph("circle"),
  },
});

// Redact group: blur, pixelate, solid box (stored as pc-redact, as before).
toolGroup({
  tool: "redact", name: "Blur out tools", group: "Blur out", variants: T.REDACT_MODES, storage: "pc-redact", tip: "Blur out: ",
  icons: {
    blur: ph("drop"),
    pixelate: ph("squares-four"),
    box: ph("square"),
  },
});

/* ------------------------------- right sidebar ------------------------------- */

// Desktop: tool options, History and Layers stacked with drag handles between
// them. Phones: tabs switch between them.
const side = $("#side");
const layersDock = T.layersPanel(A);
$("#layers-dock").append(layersDock.el);
const historyDock = historyPanel(() => doc);
$("#history-dock").append(historyDock.el);
resizableStack([panel, $("#history-dock"), $("#layers-dock")]);

// History labels: commits name themselves with doc.label() where it matters;
// everything else is named after the tool that made it.
const TOOL_LABELS = { "Paint bucket": "Fill", "Crop & rotate": "Crop", "Rotate & flip": "Rotate" };
let lastInput = null; // where the user last clicked or typed
for (const t of ["pointerdown", "keydown"]) addEventListener(t, (e) => { lastInput = e.target; }, true);
function stepLabel() {
  if (lastInput?.closest?.("#layers-dock")) return lastInput.matches("input") ? "Layer opacity" : "Layers";
  return TOOL_LABELS[tool?.title] || tool?.title || "Edit";
}
function showTab(tab) {
  side.dataset.tab = tab;
  for (const b of side.querySelectorAll(".side-tabs button")) {
    const on = b.dataset.tab === tab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
  }
}
showTab("props");
side.querySelector(".side-tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) showTab(b.dataset.tab); });
// Keyboard: arrow keys move between the tabs (the usual tablist pattern).
side.querySelector(".side-tabs").addEventListener("keydown", (e) => {
  const tabs = [...side.querySelectorAll(".side-tabs button")], i = tabs.indexOf(document.activeElement);
  const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (i < 0 || j === undefined) return;
  e.preventDefault(); e.stopPropagation();
  const t = tabs[(j + tabs.length) % tabs.length];
  showTab(t.dataset.tab); t.focus();
});

const layerFileInput = h("input", { type: "file", accept: "image/*,.psd", hidden: true });
layerFileInput.onchange = () => { const f = layerFileInput.files[0]; layerFileInput.value = ""; if (f) addImageLayer(f, f.name); };
document.body.append(layerFileInput);
A.pickLayerImage = () => layerFileInput.click();

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
// Double-click text to edit it (with tools where a click doesn't paint).
stageWrap.addEventListener("dblclick", (e) => {
  if (!doc || !["move", "select", "transform", "eyedropper", "text"].includes(toolName)) return;
  const p = localPoint(e), ip = view.toImage(p.x, p.y);
  if (T.textLayerAt(doc, ip, 6 / view.zoom) < 0) return;
  selectTool("text");
  tool.editAt(ip);
});

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

function updateZoomLabel() {
  const z = `${Math.round(view.zoom * 100)}%`, el = $("#zoom-label");
  if (el.textContent === z) return;
  el.textContent = z;
  el.setAttribute("aria-label", `Zoom ${z} (set to 100%)`);
}
const origRender = view.render.bind(view);
view.render = () => { origRender(); updateZoomLabel(); };

$("#btn-fit").onclick = () => view.fit();
$("#btn-zoom-in").onclick = () => { view.zoomAt(1.25, view.cssW / 2, view.cssH / 2); };
$("#btn-zoom-out").onclick = () => { view.zoomAt(0.8, view.cssW / 2, view.cssH / 2); };
$("#zoom-label").onclick = () => view.actualSize();
$("#zoom-label").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); view.actualSize(); } });
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
    $("#btn-compare").setAttribute("aria-pressed", "true");
  } else if (!on && comparing) {
    Object.assign(view, { source: comparing.source, imgW: comparing.w, imgH: comparing.h, zoom: comparing.zoom, panX: comparing.panX, panY: comparing.panY, drawOverlay: comparing.overlay });
    comparing = null; view.dirty = true;
    $("#btn-compare").classList.remove("on");
    $("#btn-compare").setAttribute("aria-pressed", "false");
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
  if (mod && k === "c" && !e.shiftKey) { e.preventDefault(); copyToClipboard(false); return; }
  if (mod && k === "x") { e.preventDefault(); copyToClipboard(true); return; }
  if (mod && e.shiftKey && k === "n") { e.preventDefault(); L().addBlank(); return; }
  if (mod && k === "e") { e.preventDefault(); L().mergeDown(); return; }
  if (mod && k === "j") { e.preventDefault(); P.selectionToLayer(A, false, makeLayer); return; }
  // Ctrl+T is reserved by browsers (new tab), so Free transform is Ctrl+Alt+T (as in Photopea).
  // e.code, because on a Mac Option changes e.key.
  if (mod && e.altKey && e.code === "KeyT") { e.preventDefault(); selectTool("transform", false); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && !mod) { e.preventDefault(); P.clearSelection(A); return; }
  if (!mod && !e.altKey) {
    // B / M / G / U select the brush / select / fill / shapes group; pressing again (or with Shift) cycles through its variants.
    const grp = GROUPS.find((g) => g.key && g.key.toLowerCase() === k);
    if (grp) { selectTool(toolName === grp.tool || e.shiftKey ? grp.next() : grp.tool, false); return; }
    const shortcut = { v: "move", n: "pencil", w: "wand", e: "eraser", i: "eyedropper", k: "fill", t: "text", c: "crop" }[k];
    if (shortcut) { selectTool(shortcut, false); return; }
    if (k === "l") { showTab("layers"); return; }
    if (k === "x") { swapColors(); return; }
    if (k === "d") { resetColors(); return; }
  }
  if (e.key === " ") { spaceDown = true; stageWrap.classList.add("pan"); e.preventDefault(); }
  else if (e.key === "Escape") { if (doc.selection) P.deselect(A); else if (!RAIL_TOOLS.has(toolName)) selectTool(railTool); }
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
  const qOut = numField(q, { unit: "%", label: "Quality" }), sOut = numField(sc, { unit: "%", label: "Size" });
  q.parentElement.querySelector("output").replaceWith(qOut); sc.parentElement.querySelector("output").replaceWith(sOut);
  const syncUi = () => {
    for (const b of segEl.children) markRadio(b, b.dataset.v === o.format);
    const psd = o.format === "image/vnd.adobe.photoshop";
    qRow.hidden = o.format === "image/png" || psd;
    sc.parentElement.hidden = psd;
  };
  for (const b of segEl.children) {
    b.setAttribute("aria-label", b.textContent);
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

/* ---------------------------------- menus ---------------------------------- */

const has = () => !!doc;
const hasSel = () => !!doc?.selection;
const L = () => T.layerOps(A);
const wholeImage = (fn, label) => { if (!doc) return; doc.label(label).commitAll(fn); view.fit(); };

/** Copy the selection (or the whole layer) to the system clipboard as PNG. */
async function copyToClipboard(cut = false) {
  if (!doc) return;
  let src = doc.canvas, b = { x: 0, y: 0, w: doc.width, h: doc.height };
  if (doc.selection) {
    b = P.selectionBounds(A);
    if (!b) return;
    src = makeCanvas(doc.width, doc.height);
    const x = src.getContext("2d");
    x.drawImage(doc.canvas, 0, 0);
    x.globalCompositeOperation = "destination-in"; x.drawImage(doc.selection.mask, 0, 0);
  }
  const out = makeCanvas(b.w, b.h);
  out.getContext("2d").drawImage(src, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": new Promise((r) => out.toBlob(r, "image/png")) })]);
    if (cut) { if (doc.selection) P.clearSelection(A); else L().clear(); }
    toast(cut ? "Cut to clipboard" : "Copied to clipboard");
  } catch { toast("Your browser didn't allow clipboard access."); }
}

function openMetadata() {
  const f = doc?.sourceFile;
  if (f) metadataDialog({ file: f, toast });
  else metadataDialog({ toast });
}
$("#btn-meta").onclick = () => metadataDialog({ toast });

function openCanvasSize() {
  selectTool("resize");
  panel.querySelector('.seg [data-v="canvas"]')?.click();
}

function shortcutsDialog() {
  const rows = [
    ["Move / Select / Crop", "V / M / C"], ["Next selection tool (Ellipse, Lasso…)", "M again / Shift+M"], ["Magic wand", "W"], ["Brush tools / Pencil / Eraser", "B / N / E"], ["Next brush tool (Pen, Highlighter…)", "B again / Shift+B"],
    ["Fill tools / Paint bucket", "G / K"], ["Next fill tool (Bucket, Gradient)", "G again / Shift+G"], ["Eyedropper", "I"],
    ["Shapes / Text", "U / T"], ["Next shape (Line, Arrow, Rectangle, Ellipse)", "U again / Shift+U"],
    ["Other tools in a toolbar group", "Right-click or long-press it"], ["Free transform", "Ctrl+Alt+T"], ["Swap / reset colors", "X / D"], ["Brush size", "[ / ]"],
    ["Select all / Deselect / Invert", "Ctrl+A / Ctrl+D / Ctrl+Shift+I"], ["Copy / Cut / Paste", "Ctrl+C / Ctrl+X / Ctrl+V"],
    ["Selection to new layer", "Ctrl+J"], ["New layer / Merge down", "Ctrl+Shift+N / Ctrl+E"], ["Delete selected pixels", "Delete"],
    ["Undo / Redo", "Ctrl+Z / Ctrl+Shift+Z"], ["Open / Save", "Ctrl+O / Ctrl+S"], ["Zoom / Fit / 100%", "+ − / 0 / 1"],
    ["Pan", "Hold Space"], ["Compare with original", "Hold \\"], ["Layers panel", "L"],
  ];
  const dlg = h("dialog", { "aria-labelledby": "dlg-keys-title", "aria-modal": "true" },
    h("h2", { id: "dlg-keys-title" }, "Keyboard shortcuts"),
    h("table", { class: "keys", "aria-label": "Shortcuts" }, rows.map(([a, b]) => h("tr", {}, h("td", {}, a), h("td", {}, h("kbd", {}, b))))),
    h("p", { class: "note" }, "Click a step in History to go back to it (or forward again). Drag the lines between Tool, History and Layers to resize them; double-click a line to reset it."),
    h("div", { style: "display:flex;justify-content:flex-end;margin-top:12px" }, h("button", { class: "primary", onclick: () => dlg.close() }, "Close")));
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}

function aboutDialog() {
  const dlg = h("dialog", { "aria-label": "About Photocairn", "aria-modal": "true" },
    h("h2", {}, "Photocairn"),
    h("p", {}, "A free, private photo editor that runs entirely in your browser. No ads, no account, and your images are never uploaded."),
    h("p", {}, "Open source (MIT): ", h("a", { href: "https://github.com/apopov04/photocairn", target: "_blank", rel: "noopener" }, "github.com/apopov04/photocairn")),
    h("div", { style: "display:flex;justify-content:flex-end;margin-top:12px" }, h("button", { class: "primary", onclick: () => dlg.close() }, "Close")));
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg); dlg.showModal();
}

buildMenus($("#menus"), $("#btn-menu"), [
  { label: "File", items: [
    { label: "New…", action: newImageDialog },
    { label: "Open…", shortcut: "Ctrl+O", action: pick },
    { label: "Place image as layer…", action: () => A.pickLayerImage(), enabled: has },
    "-",
    { label: "Save / Export…", shortcut: "Ctrl+S", action: () => selectTool("export"), enabled: has },
    "-",
    { label: "Metadata: view & remove…", action: openMetadata },
  ] },
  { label: "Edit", items: [
    { label: "Undo", shortcut: "Ctrl+Z", action: () => doc.undo(), enabled: () => !!doc?.canUndo },
    { label: "Redo", shortcut: "Ctrl+Shift+Z", action: () => doc.redo(), enabled: () => !!doc?.canRedo },
    "-",
    { label: "Cut", shortcut: "Ctrl+X", action: () => copyToClipboard(true), enabled: has },
    { label: "Copy", shortcut: "Ctrl+C", action: () => copyToClipboard(false), enabled: has },
    "-",
    { label: "Free transform", shortcut: "Ctrl+Alt+T", action: () => selectTool("transform"), enabled: has },
    { label: "Fill with main color", action: () => P.fillSelection(A), enabled: has },
    { label: "Clear", shortcut: "Delete", action: () => P.clearSelection(A), enabled: hasSel },
  ] },
  { label: "Image", items: [
    { label: "Adjustments…", action: () => selectTool("adjust"), enabled: has },
    { label: "Remove background…", action: () => selectTool("cutout"), enabled: has },
    "-",
    { label: "Image size…", action: () => selectTool("resize"), enabled: has },
    { label: "Canvas size…", action: openCanvasSize, enabled: has },
    { label: "Crop", shortcut: "C", action: () => selectTool("crop"), enabled: has },
    { label: "Crop to selection", action: () => P.cropToSelection(A), enabled: hasSel },
    "-",
    { label: "Rotate 90° clockwise", action: () => wholeImage((c) => T.rotateCanvas90(c, 1), "Rotate 90° CW"), enabled: has },
    { label: "Rotate 90° counter-clockwise", action: () => wholeImage((c) => T.rotateCanvas90(c, -1), "Rotate 90° CCW"), enabled: has },
    { label: "Rotate 180°", action: () => wholeImage((c) => T.rotateCanvas90(T.rotateCanvas90(c, 1), 1), "Rotate 180°"), enabled: has },
    { label: "Rotate by angle…", action: () => selectTool("rotate"), enabled: has },
    { label: "Flip horizontal", action: () => doc && doc.label("Flip horizontal").commitAll((c) => T.flipCanvas(c, true)), enabled: has },
    { label: "Flip vertical", action: () => doc && doc.label("Flip vertical").commitAll((c) => T.flipCanvas(c, false)), enabled: has },
    "-",
    { label: "Corners & border…", action: () => selectTool("frame"), enabled: has },
  ] },
  { label: "Layer", items: [
    { label: "New layer", shortcut: "Ctrl+Shift+N", action: () => L().addBlank(), enabled: has },
    { label: "Duplicate layer", action: () => L().duplicate(), enabled: has },
    { label: "Delete layer", action: () => L().remove(), enabled: () => !!doc?.hasLayers },
    { label: "Clear layer", action: () => L().clear(), enabled: has },
    "-",
    { label: "Bring forward", action: () => L().moveBy(1), enabled: has },
    { label: "Send backward", action: () => L().moveBy(-1), enabled: has },
    "-",
    { label: "Merge down", shortcut: "Ctrl+E", action: () => L().mergeDown(), enabled: () => !!doc && doc.active > 0 },
    { label: "Merge visible", action: () => L().mergeVisible(), enabled: () => !!doc?.hasLayers },
    { label: "Flatten image", action: () => L().flatten(), enabled: () => !!doc?.hasLayers },
  ] },
  { label: "Select", items: [
    { label: "All", shortcut: "Ctrl+A", action: () => P.selectAll(A), enabled: has },
    { label: "Deselect", shortcut: "Ctrl+D", action: () => P.deselect(A), enabled: hasSel },
    { label: "Inverse", shortcut: "Ctrl+Shift+I", action: () => P.invertSelection(A), enabled: has },
    "-",
    { label: "Copy to new layer", shortcut: "Ctrl+J", action: () => P.selectionToLayer(A, false, makeLayer), enabled: hasSel },
    { label: "Cut to new layer", action: () => P.selectionToLayer(A, true, makeLayer), enabled: hasSel },
  ] },
  { label: "Filter", items: [
    { label: "Filters…", action: () => selectTool("looks"), enabled: has },
    { label: "Sharpen / Soften…", action: () => selectTool("adjust"), enabled: has },
    { label: "Blur out / redact", action: () => selectTool("redact"), enabled: has },
  ] },
  { label: "View", items: [
    { label: "Zoom in", shortcut: "+", action: () => view.zoomAt(1.25, view.cssW / 2, view.cssH / 2), enabled: has },
    { label: "Zoom out", shortcut: "−", action: () => view.zoomAt(0.8, view.cssW / 2, view.cssH / 2), enabled: has },
    { label: "Fit on screen", shortcut: "0", action: () => view.fit(), enabled: has },
    { label: "Actual size (100%)", shortcut: "1", action: () => view.actualSize(), enabled: has },
    "-",
    { label: "Layers panel", shortcut: "L", action: () => showTab("layers"), enabled: has },
    { label: "History panel", action: () => showTab("history"), enabled: has },
  ] },
  { label: "Help", items: [
    { label: "Keyboard shortcuts", action: shortcutsDialog },
    { label: "About Photocairn", action: aboutDialog },
    { label: "For developers & AI agents", action: () => window.open("developers/", "_blank", "noopener") },
    { label: "Source code on GitHub", action: () => window.open("https://github.com/apopov04/photocairn", "_blank", "noopener") },
  ] },
]);

// Debug/test hook (used by the automated browser tests).
window.__photocairn = { open: openBlob, addLayer: addImageLayer, get doc() { return doc; }, view, selectTool };

// Public scripting API for AI agents and automation: window.photocairn (see js/api.js).
installApi({ A, setDoc, open: (blob, name) => openBlob(blob, name, false), addImageLayer, renderExport, layerOps: L, baseName, maxPixels: MAX_PIXELS });
