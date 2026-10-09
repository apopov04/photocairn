// window.photocairn: a small, documented scripting API for AI agents and
// automation driving the page in a browser (Playwright, Claude in Chrome,
// ChatGPT agent...). Every method is async, takes JSON-friendly arguments in
// image pixels, and goes through the same code as the UI, so edits respect
// layers, the selection and layer locks, show up in History and can be undone.
//
// The methods, their parameters and defaults are described in api-spec.js,
// which also drives photocairn.help() and the generated docs.
//
// Safety: nothing here fetches a URL or downloads a file unless a method was
// called with that URL or with download: true. The page's Content-Security-Policy
// still only allows connections to this site.

import { Doc, makeCanvas, copyCanvas, getImageData, canvasFromImageData, resizeCanvas, makeLayer } from "./editor.js";
import * as ops from "./ops.js";
import * as T from "./tools.js";
import * as P from "./paint.js";
import { renderText, measureText, textBox, layerName } from "./text.js";
import {
  API_VERSION, APP_VERSION, METHODS, METHOD, describe, normalize,
  dataUrlToBytes, resizeDims, clipRect, rotation, resolveLayer,
} from "./api-spec.js";

const MIME = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", psd: "image/vnd.adobe.photoshop" };
const EXT = { png: "png", jpeg: "jpg", webp: "webp", psd: "psd" };
const NO_DOC = "No image open. Call photocairn.open(source) or photocairn.newImage({ width, height }) first.";

/**
 * Install window.photocairn. ctx comes from main.js:
 * { A (tool context), setDoc, open(blob, name), addImageLayer(blob, name), renderExport(o), layerOps(), baseName(s), maxPixels }
 */
export function installApi(ctx) {
  const { A } = ctx;

  /* ------------------------------- plumbing ------------------------------- */

  const need = () => { if (!A.doc) throw new Error(NO_DOC); return A.doc; };

  /** Throw (instead of the UI's toast) if the active layer can't be edited. need: "pixels" | "position". */
  function editable(d, kind = "pixels") {
    const l = d.layer, k = l.lock || {};
    const where = `The active layer "${l.name}" (index ${d.active})`;
    if (k.all) throw new Error(`${where} is fully locked. Unlock it with photocairn.setLayer({ lock: { all: false } }).`);
    if (kind === "pixels" && k.pixels) throw new Error(`${where} has its pixels locked. Unlock it with photocairn.setLayer({ lock: { pixels: false } }).`);
    if (kind === "position" && k.position) throw new Error(`${where} has its position locked.`);
    if (kind === "pixels" && !l.visible) throw new Error(`${where} is hidden. Show it with photocairn.setLayer({ visible: true }) first.`);
  }

  /** The tool context with a different main color (for helpers that paint with A.colors.fg). */
  const withColor = (fg) => Object.create(A, { colors: { value: { fg, bg: A.colors.bg } } });

  const inside = (d, p, what) => {
    if (p.x < 0 || p.y < 0 || p.x >= d.width || p.y >= d.height) throw new RangeError(`${what} (${p.x}, ${p.y}) is outside the image (${d.width} × ${d.height}).`);
  };

  /** Whole-image operations refit the view, like the menu commands do. */
  const fit = () => A.view.fit();

  async function toBlob(source, what = "source") {
    if (source instanceof Blob) return source;
    if (source.startsWith("data:")) {
      const { mime, bytes } = dataUrlToBytes(source);
      return new Blob([bytes], { type: mime });
    }
    let url;
    try { url = new URL(source, location.href); } catch { throw new TypeError(`${what} must be a File, Blob, data: URL or http(s) URL.`); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError(`${what}: only http(s) and data: URLs are supported, got "${url.protocol}". Pass the Blob or File itself instead.`);
    const hint = "Photocairn's security policy only lets the page load files from its own site (and cross-origin isolation blocks other images), so pass the image as a data: URL or a Blob/File instead.";
    let res;
    try { res = await fetch(url, { credentials: "same-origin" }); }
    catch (err) { throw new Error(`Couldn't fetch ${url.href} (${err.message}). ${hint}`); }
    if (!res.ok) throw new Error(`Couldn't fetch ${url.href}: HTTP ${res.status}. ${hint}`);
    return res.blob();
  }

  const nameOf = (source) => {
    if (source instanceof File) return source.name;
    if (typeof source === "string" && !source.startsWith("data:")) {
      try { return decodeURIComponent(new URL(source, location.href).pathname.split("/").pop()) || "image"; } catch { /* fall through */ }
    }
    return "image";
  };

  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  /** Put a canvas on white (JPEG has no transparency), like the Save panel does. */
  function onWhite(c) {
    const out = makeCanvas(c.width, c.height), x = out.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, out.width, out.height); x.drawImage(c, 0, 0);
    return out;
  }

  const rectArg = (o) => ({ x: o.x, y: o.y, width: o.width, height: o.height });

  /* --------------------------------- methods -------------------------------- */

  function info() {
    const d = A.doc;
    if (!d) return { open: false };
    const b = d.selection ? P.selectionBounds(A) : null;
    return {
      open: true, name: d.name, width: d.width, height: d.height,
      layers: d.layers.map((l, i) => {
        const o = { index: i, id: l.id, name: l.name, visible: l.visible, opacity: Math.round(l.opacity * 100), blend: l.blend, isText: !!l.meta?.text };
        if (l.meta?.text) o.text = l.meta.text.text;
        const k = l.lock || {};
        o.locked = { alpha: !!k.alpha, pixels: !!k.pixels, position: !!k.position, all: !!k.all };
        return o;
      }),
      activeLayer: d.active,
      selection: b ? { x: b.x, y: b.y, width: b.w, height: b.h } : null,
      history: { labels: d.history.map((e) => e.label), index: d.historyIndex, canUndo: d.canUndo, canRedo: d.canRedo },
    };
  }

  const impl = {
    help(o) {
      if (!o.method) return METHODS.map(describe);
      const m = METHOD[o.method];
      if (!m) throw new Error(`There's no method "${o.method}". Methods: ${METHODS.map((x) => x.name).join(", ")}.`);
      return describe(m);
    },

    info,

    /* ---- opening and saving ---- */
    async open(o) {
      const blob = await toBlob(o.source);
      const before = A.doc;
      await ctx.open(blob, o.name || nameOf(o.source));
      if (A.doc === before) throw new Error("Couldn't open that image. Supported: JPG, PNG, WebP, AVIF, GIF and PSD (HEIC only where the browser supports it).");
      return info();
    },

    newImage(o) {
      if (o.width * o.height > ctx.maxPixels) throw new RangeError(`${o.width} × ${o.height} is too large; keep it under ${ctx.maxPixels} pixels (e.g. 4096 × 4096).`);
      const c = makeCanvas(o.width, o.height), x = c.getContext("2d");
      if (o.background !== "transparent") { x.fillStyle = o.background; x.fillRect(0, 0, o.width, o.height); }
      const d = new Doc(c, "untitled");
      d.stateLabel = "New image"; d.origin = `${o.width} × ${o.height}`;
      ctx.setDoc(d);
      return info();
    },

    getImage(o) {
      const d = need();
      let c = d.composite();
      if (o.maxSize && Math.max(c.width, c.height) > o.maxSize) {
        const s = ops.fitSize(c.width, c.height, o.maxSize, o.maxSize);
        c = resizeCanvas(c, s.width, s.height);
      }
      if (o.format === "jpeg") c = onWhite(c);
      const url = c.toDataURL(MIME[o.format], o.quality / 100);
      if (!url.startsWith(`data:${MIME[o.format]}`)) throw new Error(`This browser can't encode ${o.format}. Use png or jpeg.`);
      return url;
    },

    async export(o) {
      const d = need();
      if (o.stripMetadata === false) throw new Error("Exports never contain metadata (the image is re-encoded from pixels), so stripMetadata: false isn't supported. Leave it out.");
      const r = await ctx.renderExport({ format: MIME[o.format], quality: o.quality, scale: o.scale });
      if (!r.blob || (o.format !== "psd" && r.blob.type !== MIME[o.format])) throw new Error(`This browser can't encode ${o.format}. Use png or jpeg.`);
      if (o.download) {
        const name = `${ctx.baseName(o.filename || `${d.name}-edited`) || "image"}.${EXT[o.format]}`;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(r.blob); a.download = name;
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        A.toast(`Saved ${name}`);
      }
      return o.as === "blob" ? r.blob : blobToDataUrl(r.blob);
    },

    /* ---- geometry ---- */
    crop(o) {
      const d = need();
      const r = clipRect(rectArg(o), d.width, d.height);
      if (!r) throw new RangeError(`The crop rectangle is outside the image (${d.width} × ${d.height}).`);
      if (r.x === 0 && r.y === 0 && r.width === d.width && r.height === d.height) return info();
      d.label("Crop").commitAll((layer) => {
        const c = makeCanvas(r.width, r.height);
        c.getContext("2d").drawImage(layer, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
        return c;
      });
      fit();
      return info();
    },

    resize(o) {
      const d = need();
      const s = resizeDims(d.width, d.height, o);
      if (s.width * s.height > ctx.maxPixels) throw new RangeError(`${s.width} × ${s.height} is too large; keep it under ${ctx.maxPixels} pixels.`);
      if (s.width === d.width && s.height === d.height) return info();
      d.label("Resize").commitAll((c) => resizeCanvas(c, s.width, s.height));
      fit();
      return info();
    },

    rotate(o) {
      const d = need(), r = rotation(o.degrees);
      if (!r) return info();
      if (r.quarter === 1) d.label("Rotate 90° CW").commitAll((c) => T.rotateCanvas90(c, 1));
      else if (r.quarter === -1) d.label("Rotate 90° CCW").commitAll((c) => T.rotateCanvas90(c, -1));
      else if (r.quarter === 2) d.label("Rotate 180°").commitAll((c) => T.rotateCanvas90(T.rotateCanvas90(c, 1), 1));
      else {
        const W = d.width, H = d.height;
        d.label("Rotate").commitAll((c) => T.rotateFree(c, r.free, true, W, H));
      }
      fit();
      return info();
    },

    flip(o) {
      const d = need(), hz = o.direction === "horizontal";
      d.label(hz ? "Flip horizontal" : "Flip vertical").commitAll((c) => T.flipCanvas(c, hz));
      return info();
    },

    /* ---- adjustments and filters ---- */
    adjust(o) {
      const d = need();
      const vals = { ...o, blur: o.soften };
      delete vals.soften;
      if (Object.values(vals).every((v) => !v)) throw new Error("Nothing to change: pass at least one non-zero option, e.g. photocairn.adjust({ brightness: 20 }).");
      editable(d);
      const out = P.withinSelection(A, d.canvas, canvasFromImageData(T.runAdjust(getImageData(d.canvas), vals, 1)));
      d.label("Adjust").commit(out);
      return info();
    },

    look(o) {
      const d = need();
      editable(d);
      const img = getImageData(d.canvas), f = ops.look(img, o.name), k = o.strength / 100;
      if (k < 1) for (let i = 0; i < f.data.length; i++) f.data[i] = img.data[i] + (f.data[i] - img.data[i]) * k;
      d.label("Filters").commit(P.withinSelection(A, d.canvas, canvasFromImageData(f)));
      return info();
    },

    async removeBackground(o) {
      const d = need();
      editable(d);
      const layerId = d.layer.id;
      // Like the tool: run on the untouched original when refining an earlier cutout.
      const source = d.meta.original || d.canvas;
      const res = await T.predictMask(source, o.model, (m) => { try { o.onProgress?.({ stage: m.stage, progress: m.progress }); } catch { /* the caller's problem */ } });
      if (A.doc !== d || d.layer.id !== layerId) throw new Error("The image or active layer changed while removing the background; nothing was applied.");
      const mask = ops.normalizeMask(res.mask);
      const mimg = new ImageData(res.size, res.size);
      for (let i = 0; i < mask.length; i++) mimg.data[i * 4 + 3] = mask[i];
      const msmall = makeCanvas(res.size, res.size);
      msmall.getContext("2d").putImageData(mimg, 0, 0);
      const subject = copyCanvas(source), sx = subject.getContext("2d");
      sx.globalCompositeOperation = "destination-in";
      sx.imageSmoothingQuality = "high";
      sx.drawImage(msmall, 0, 0, subject.width, subject.height);
      const meta = { original: source, subject, bg: o.background };
      d.label("Remove background").commit(T.composeCutout(meta), meta);
      return info();
    },

    redact(o) {
      const d = need();
      const r = clipRect(rectArg(o), d.width, d.height);
      if (!r) throw new RangeError(`The area is outside the image (${d.width} × ${d.height}).`);
      editable(d);
      d.label({ blur: "Blur", pixelate: "Pixelate", box: "Solid box" }[o.mode]);
      T.redactRect(d, { x: r.x, y: r.y, w: r.width, h: r.height }, o.mode, o.strength, o.color);
      return info();
    },

    /* ---- selection ---- */
    select(o) {
      need();
      let s;
      if (o.type === "polygon") {
        if (!o.points || o.points.length < 3) throw new TypeError('select({ type: "polygon" }) needs "points" with at least 3 points [{ x, y }, ...].');
        s = { kind: "poly", pts: o.points };
      } else {
        for (const k of ["x", "y", "width", "height"]) if (o[k] === undefined) throw new TypeError(`select({ type: "${o.type}" }) needs x, y, width and height.`);
        s = { kind: o.type, x: o.x, y: o.y, w: o.width, h: o.height };
      }
      P.selectShape(A, s, o.mode);
      return info().selection;
    },

    selectColor(o) {
      const d = need();
      inside(d, o, "The point");
      P.selectSimilar(A, { x: o.x, y: o.y }, { tolerance: o.tolerance, contiguous: o.contiguous, all: o.allLayers }, o.mode);
      return info().selection;
    },

    selectAll() { need(); P.selectAll(A); return info().selection; },
    deselect() { need(); P.deselect(A); return null; },
    invertSelection() { need(); P.invertSelection(A); return info().selection; },

    deleteSelection() {
      const d = need();
      if (!d.selection) throw new Error("Nothing is selected. Call photocairn.select(...) first.");
      editable(d);
      P.clearSelection(A);
      return info();
    },

    fillSelection(o) {
      const d = need();
      editable(d);
      P.fillSelection(withColor(o.color));
      return info();
    },

    cropToSelection() {
      const d = need();
      if (!d.selection) throw new Error("Nothing is selected. Call photocairn.select(...) first.");
      P.cropToSelection(A);
      return info();
    },

    /* ---- drawing ---- */
    fill(o) {
      const d = need();
      inside(d, o, "The point");
      editable(d);
      const src = getImageData(o.allLayers ? d.composite() : d.canvas);
      const paint = P.maskCanvas(ops.floodMask(src, o.x, o.y, o.tolerance, o.contiguous), d.width, d.height), x = paint.getContext("2d");
      x.globalCompositeOperation = "source-in"; x.fillStyle = o.color; x.fillRect(0, 0, d.width, d.height);
      d.label("Fill").commit(P.applyPaint(A, d.canvas, paint, { opacity: o.opacity / 100 }), {});
      return info();
    },

    drawShape(o) {
      const d = need();
      editable(d);
      const paint = makeCanvas(d.width, d.height), x = paint.getContext("2d");
      x.strokeStyle = x.fillStyle = o.color;
      x.lineWidth = o.width; x.lineCap = x.lineJoin = "round";
      P.shapePath(x, o.type, o.from, o.to, o.width);
      if (o.fill && (o.type === "rect" || o.type === "ellipse")) x.fill(); else x.stroke();
      d.label({ line: "Line", arrow: "Arrow", rect: "Rectangle", ellipse: "Ellipse" }[o.type]).commit(P.applyPaint(A, d.canvas, paint, { opacity: o.opacity / 100 }), {});
      return info();
    },

    brushStroke(o) {
      const d = need();
      editable(d);
      const k = o.kind, chisel = k === "highlighter";
      const stroke = new P.Stroke(d.width, d.height, {
        size: o.size, hardness: k === "brush" || k === "eraser" ? o.hardness / 100 : 1,
        pixel: k === "pencil" ? "round" : false, chisel, color: k === "eraser" ? "#000" : o.color,
      });
      for (const p of o.points) stroke.to(p);
      const out = P.applyPaint(A, d.canvas, stroke.canvas, { opacity: o.opacity / 100, erase: k === "eraser", blend: chisel ? "multiply" : "source-over" });
      d.label(k[0].toUpperCase() + k.slice(1)).commit(out, {});
      return info();
    },

    /* ---- text ---- */
    addText(o) {
      const d = need();
      if (!o.text.trim()) throw new TypeError("addText() needs some text.");
      const t = {
        text: o.text, font: o.font, weight: o.weight, italic: o.italic, align: o.align, outline: o.outline,
        bg: o.background, color: o.color, size: o.size ?? Math.max(8, Math.round(Math.min(d.width, d.height) / 10)),
        w: Math.round(o.boxWidth), x: 0, y: 0,
      };
      const L = measureText(t);
      t.x = o.x ?? Math.round((d.width - L.w) / 2);
      t.y = o.y ?? Math.round((d.height - L.h) / 2);
      const r = renderText(t, d.width, d.height);
      d.label("Text").change((dd) => {
        dd.layers.splice(dd.active + 1, 0, makeLayer(r.canvas, layerName(t.text), { over: r.over, meta: { text: t } }));
        dd.active += 1;
      });
      return textResult(d, d.active);
    },

    editText(o) {
      const d = need();
      const i = resolveLayer(d.layers, o.layer, d.active), l = d.layers[i];
      if (!l.meta?.text) throw new Error(`Layer ${i} ("${l.name}") isn't a text layer (painting or filtering a text layer turns it into pixels).`);
      if (l.lock?.all || l.lock?.pixels) throw new Error(`Layer ${i} ("${l.name}") is locked.`);
      const map = { background: "bg", boxWidth: "w" };
      const t = { ...l.meta.text };
      for (const [k, v] of Object.entries(o)) if (k !== "layer") t[map[k] || k] = k === "boxWidth" ? Math.round(v) : v;
      if (!t.text.trim()) throw new TypeError("editText(): the text can't be empty. Use photocairn.deleteLayer() to remove it.");
      d.label("Text").change((dd) => {
        dd.layers[i] = { ...l, ...renderText(t, dd.width, dd.height), meta: { text: t }, name: l.name.startsWith("Text") ? layerName(t.text) : l.name };
      });
      return textResult(d, i);
    },

    /* ---- layers ---- */
    async addLayer(o) {
      const d = need();
      if (o.image !== undefined) {
        const blob = await toBlob(o.image, "image");
        const n = d.layers.length;
        await ctx.addImageLayer(blob, o.name || nameOf(o.image));
        if (A.doc !== d || d.layers.length === n) throw new Error("Couldn't add that image as a layer (unsupported or corrupt image data).");
        return info();
      }
      d.label("New layer").change((dd) => {
        dd.layers.splice(dd.active + 1, 0, makeLayer(makeCanvas(dd.width, dd.height), o.name || `Layer ${dd.layers.length + 1}`));
        dd.active += 1;
      });
      return info();
    },

    selectLayer(o) {
      const d = need(), i = resolveLayer(d.layers, o.layer, d.active);
      if (d.active !== i) { d.active = i; d.emit(); }
      return info();
    },

    setLayer(o) {
      const d = need(), i = resolveLayer(d.layers, o.layer, d.active), l = d.layers[i];
      const props = {};
      if (o.name !== undefined) { if (!o.name.trim()) throw new TypeError("setLayer(): name can't be empty."); props.name = o.name.trim().slice(0, 40); }
      if (o.visible !== undefined) props.visible = o.visible;
      if (o.opacity !== undefined) props.opacity = o.opacity / 100;
      if (o.blend !== undefined) props.blend = o.blend;
      if (o.lock !== undefined) {
        const lock = { ...(l.lock || {}) };
        for (const [k, v] of Object.entries(o.lock)) {
          if (!["alpha", "pixels", "position", "all"].includes(k) || typeof v !== "boolean") throw new TypeError(`setLayer(): lock takes { alpha, pixels, position, all } as true/false, got ${k}: ${JSON.stringify(v)}.`);
          lock[k] = v;
        }
        props.lock = lock;
      }
      if (!Object.keys(props).length) throw new TypeError("setLayer() needs at least one of name, visible, opacity, blend, lock.");
      if (l.lock?.all && props.lock?.all !== false && ("opacity" in props || "blend" in props)) throw new Error(`Layer ${i} ("${l.name}") is fully locked.`);
      if (Object.keys(props).length > 1) d.label("Layer properties"); // one step; editor.js names single changes
      d.setLayerProps(i, props);
      return info();
    },

    duplicateLayer(o) {
      const d = need();
      d.active = resolveLayer(d.layers, o.layer, d.active);
      ctx.layerOps().duplicate();
      return info();
    },

    moveLayer(o) {
      const d = need(), i = resolveLayer(d.layers, o.layer, d.active), j = i + (o.direction === "up" ? 1 : -1);
      if (j < 0 || j >= d.layers.length) throw new RangeError(`Layer ${i} is already at the ${o.direction === "up" ? "top" : "bottom"}.`);
      d.active = i;
      ctx.layerOps().moveBy(o.direction === "up" ? 1 : -1);
      return info();
    },

    deleteLayer(o) {
      const d = need(), i = resolveLayer(d.layers, o.layer, d.active);
      if (d.layers.length < 2) throw new Error("An image needs at least one layer.");
      if (d.layers[i].lock?.all) throw new Error(`Layer ${i} ("${d.layers[i].name}") is fully locked.`);
      d.active = i;
      ctx.layerOps().remove();
      return info();
    },

    mergeDown() {
      const d = need();
      if (d.active === 0) throw new Error("The active layer is the bottom one; there's no layer below to merge into.");
      const below = d.layers[d.active - 1];
      if (below.lock?.all || below.lock?.pixels) throw new Error(`The layer below ("${below.name}") is locked.`);
      ctx.layerOps().mergeDown();
      return info();
    },

    flatten() {
      const d = need();
      if (d.hasLayers) ctx.layerOps().flatten();
      return info();
    },

    /* ---- history ---- */
    undo(o) {
      const d = need();
      if (!d.canUndo) throw new Error("Nothing to undo.");
      d.goTo(d.historyIndex - o.steps);
      return info();
    },
    redo(o) {
      const d = need();
      if (!d.canRedo) throw new Error("Nothing to redo.");
      d.goTo(d.historyIndex + o.steps);
      return info();
    },
  };

  function textResult(d, i) {
    const l = d.layers[i], b = textBox(l.meta.text);
    return { index: i, id: l.id, name: l.name, box: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.w), height: Math.round(b.h) } };
  }

  // One call at a time, in order: each call starts after the previous one settled.
  let queue = Promise.resolve();
  const api = { version: APP_VERSION, apiVersion: API_VERSION };
  for (const m of METHODS) {
    api[m.name] = (...args) => {
      const run = queue.then(() => impl[m.name](normalize(m.name, args)));
      queue = run.catch(() => {});
      return run;
    };
  }
  window.photocairn = Object.freeze(api);
  window.dispatchEvent(new Event("photocairn:ready"));
  return api;
}
