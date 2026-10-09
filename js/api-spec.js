// The public scripting API (window.photocairn): its description and argument
// checking. This file is the single source of truth for photocairn.help(),
// the argument validation in api.js, and the generated API reference in
// llms-full.txt and developers/index.html (see scripts/api-docs.mjs).
// Pure: no DOM, so it runs in Node tests too.

import { LOOK_NAMES } from "./ops.js";
import { BLEND_MODES } from "./editor.js";

export const API_VERSION = 1;
export const APP_VERSION = "1.0.0"; // keep in step with package.json (a unit test checks)

export const LOOKS = LOOK_NAMES.filter((n) => n !== "none");
export const BLENDS = BLEND_MODES.map(([v]) => v);
export const ADJUSTMENTS = ["brightness", "contrast", "exposure", "highlights", "shadows", "saturation", "warmth", "tint"];

/* ---------------------------- parameter shorthands ---------------------------- */

const P = (name, type, desc, more = {}) => ({ name, type, desc, ...more });
const req = (name, type, desc, more = {}) => P(name, type, desc, { required: true, ...more });
const xy = (what) => [req("x", "number", `Left edge of the ${what}, in image pixels.`), req("y", "number", `Top edge of the ${what}, in image pixels.`)];
const wh = (what) => [req("width", "number", `Width of the ${what}, in pixels.`, { min: 1 }), req("height", "number", `Height of the ${what}, in pixels.`, { min: 1 })];
const selMode = P("mode", "enum", "How to combine with an existing selection.", { values: ["new", "add", "subtract", "intersect"], default: "new" });
const layerRef = (desc = "Layer to use: index (0 = bottom) or exact name. Default: the active layer.") => P("layer", "layer", desc);

/**
 * Every method of window.photocairn. Fields:
 *   name, desc (one line), params [{ name, type, desc, required?, default?, min?, max?, values? }],
 *   positional: params that may be passed as plain arguments before the options object,
 *   returns, example, group (for the docs), history: label it adds to History (if any).
 * defaultText: a default that isn't a literal value (documentation only).
 * Types: number, integer, boolean, string, enum, color (#rgb / #rrggbb), point ({x, y}),
 * points ([{x, y}, ...]), layer (index or name), source (File/Blob/data URL/URL), function.
 */
export const METHODS = [
  /* ---- discovery ---- */
  { group: "Discovery", name: "help", desc: "Describe every method (or one): parameters with types, ranges and defaults.",
    params: [P("method", "string", "Only describe this method.")], positional: ["method"],
    returns: "Array of method descriptions (or one description).", example: "await photocairn.help('crop')" },
  { group: "Discovery", name: "info", desc: "Describe the open image: size, layers, selection and history.",
    params: [], returns: "{ open, name, width, height, layers: [{ index, id, name, visible, opacity, blend, isText, text?, locked }], activeLayer, selection: null | { x, y, width, height }, history: { labels, index, canUndo, canRedo } }",
    example: "await photocairn.info()" },

  /* ---- files ---- */
  { group: "Opening and saving", name: "open", desc: "Open an image (JPG, PNG, WebP, AVIF, GIF, PSD), replacing the current one without asking.",
    params: [req("source", "source", "A File or Blob, a data: URL, or an http(s) URL. URLs from other sites are blocked by the page's security policy: pass a data URL or Blob instead."),
      P("name", "string", "File name to show and to base the export name on.", { defaultText: "the File's or URL's name, else \"image\"" })],
    positional: ["source"], history: "Open", returns: "info()", example: "await photocairn.open(dataUrl, { name: 'photo.jpg' })" },
  { group: "Opening and saving", name: "newImage", desc: "Start a new blank image, replacing the current one without asking.",
    params: [req("width", "integer", "Width in pixels.", { min: 1, max: 8000 }), req("height", "integer", "Height in pixels.", { min: 1, max: 8000 }),
      P("background", "color", "Fill color, or \"transparent\".", { default: "#ffffff", transparent: true })],
    history: "New image", returns: "info()", example: "await photocairn.newImage({ width: 1080, height: 1080, background: 'transparent' })" },
  { group: "Opening and saving", name: "getImage", desc: "The flattened image as a data URL, optionally downscaled (cheap to show to a vision model). Never downloads.",
    params: [P("format", "enum", "Image format.", { values: ["png", "jpeg", "webp"], default: "png" }),
      P("quality", "integer", "JPEG/WebP quality.", { min: 1, max: 100, default: 85 }),
      P("maxSize", "integer", "Longest side in pixels; larger images are scaled down. 0 = full size.", { min: 0, default: 0 })],
    returns: "data URL string", example: "await photocairn.getImage({ format: 'jpeg', maxSize: 1024 })" },
  { group: "Opening and saving", name: "export", desc: "Encode the image like File › Save. Returns it, and downloads it only if download is true.",
    params: [P("format", "enum", "File format. psd keeps layers.", { values: ["png", "jpeg", "webp", "psd"], default: "png" }),
      P("quality", "integer", "JPEG/WebP quality.", { min: 1, max: 100, default: 85 }),
      P("scale", "integer", "Size in percent of the image (not for psd).", { min: 1, max: 100, default: 100 }),
      P("as", "enum", "Return a data URL string or a Blob.", { values: ["dataURL", "blob"], default: "dataURL" }),
      P("download", "boolean", "Also save the file through the browser's download.", { default: false }),
      P("filename", "string", "Download file name (the extension is added).", { defaultText: "<image name>-edited" }),
      P("stripMetadata", "boolean", "Exports never contain EXIF/GPS or other metadata; false is not supported.", { default: true })],
    returns: "data URL string, or Blob with as: 'blob'", example: "await photocairn.export({ format: 'webp', quality: 80 })" },

  /* ---- geometry ---- */
  { group: "Geometry", name: "crop", desc: "Crop the whole image (all layers) to a rectangle. The rectangle is clipped to the image.",
    params: [...xy("area to keep"), ...wh("area to keep")], history: "Crop", returns: "info()",
    example: "await photocairn.crop({ x: 100, y: 50, width: 800, height: 600 })" },
  { group: "Geometry", name: "resize", desc: "Scale the whole image. Give width, height or both; with one, the aspect ratio is kept.",
    params: [P("width", "integer", "New width in pixels.", { min: 1, max: 16000 }), P("height", "integer", "New height in pixels.", { min: 1, max: 16000 })],
    history: "Resize", returns: "info()", example: "await photocairn.resize({ width: 1080 })" },
  { group: "Geometry", name: "rotate", desc: "Rotate the whole image clockwise. 90/180/270 are lossless; other angles grow the canvas (transparent corners).",
    params: [req("degrees", "number", "Clockwise angle; negative turns counter-clockwise.", { min: -360, max: 360 })], positional: ["degrees"],
    history: "Rotate 90° CW / Rotate 90° CCW / Rotate 180° / Rotate", returns: "info()", example: "await photocairn.rotate(90)" },
  { group: "Geometry", name: "flip", desc: "Mirror the whole image.",
    params: [req("direction", "enum", "Which way to flip.", { values: ["horizontal", "vertical"] })], positional: ["direction"],
    history: "Flip horizontal / Flip vertical", returns: "info()", example: "await photocairn.flip('horizontal')" },

  /* ---- adjustments ---- */
  { group: "Adjustments and filters", name: "adjust", desc: "Light and color adjustments, sharpen and soften (Image › Adjustments). Edits the active layer, inside the selection if there is one.",
    params: [...ADJUSTMENTS.map((k) => P(k, "integer", `${k[0].toUpperCase() + k.slice(1)}.`, { min: -100, max: 100, default: 0 })),
      P("sharpen", "integer", "Sharpen (unsharp mask).", { min: 0, max: 100, default: 0 }),
      P("soften", "integer", "Soften (blur).", { min: 0, max: 100, default: 0 })],
    history: "Adjust", returns: "info()", example: "await photocairn.adjust({ brightness: 15, contrast: 10, warmth: -20 })" },
  { group: "Adjustments and filters", name: "look", desc: "Apply a one-tap filter (Filter › Filters) to the active layer, inside the selection if there is one.",
    params: [req("name", "enum", "Filter name.", { values: LOOKS }), P("strength", "integer", "Strength in percent.", { min: 0, max: 100, default: 100 })],
    positional: ["name"], history: "Filters", returns: "info()", example: "await photocairn.look('mono', { strength: 80 })" },
  { group: "Adjustments and filters", name: "removeBackground", desc: "Cut out the main subject of the active layer with on-device AI. Downloads the model from this site on first use (then cached).",
    params: [P("model", "enum", "fast: 4.6 MB model. best: 44 MB model, cleaner edges.", { values: ["fast", "best"], default: "fast" }),
      P("background", "color", "New background: \"transparent\", a color, or \"blur\" for a blurred copy of the photo.", { default: "transparent", transparent: true, extra: ["blur"] }),
      P("onProgress", "function", "Called with { stage: 'download'|'loading'|'thinking', progress: 0..1 }.")],
    history: "Remove background", returns: "info()", example: "await photocairn.removeBackground({ model: 'fast' })" },
  { group: "Adjustments and filters", name: "redact", desc: "Blur, pixelate or cover a rectangle on the active layer (the Blur out tools).",
    params: [...xy("area"), ...wh("area"),
      P("mode", "enum", "box is a solid, irreversible cover; use it for passwords, card numbers and IDs.", { values: ["blur", "pixelate", "box"], default: "blur" }),
      P("strength", "integer", "Blur/pixelate strength.", { min: 10, max: 100, default: 60 }),
      P("color", "color", "Box color (mode box).", { default: "#000000" })],
    history: "Blur / Pixelate / Solid box", returns: "info()", example: "await photocairn.redact({ x: 40, y: 300, width: 420, height: 60, mode: 'pixelate' })" },

  /* ---- selection ---- */
  { group: "Selection", name: "select", desc: "Select a rectangle, ellipse or polygon. Later edits (adjust, look, fill, brush...) stay inside it. Not an undo step.",
    params: [P("type", "enum", "Shape of the selection.", { values: ["rect", "ellipse", "polygon"], default: "rect" }),
      P("x", "number", "Left edge (rect, ellipse)."), P("y", "number", "Top edge (rect, ellipse)."),
      P("width", "number", "Width (rect, ellipse).", { min: 1 }), P("height", "number", "Height (rect, ellipse).", { min: 1 }),
      P("points", "points", "Corners (polygon), at least 3: [{ x, y }, ...]."), selMode],
    returns: "info().selection (null if nothing ended up selected)", example: "await photocairn.select({ type: 'ellipse', x: 200, y: 120, width: 300, height: 300 })" },
  { group: "Selection", name: "selectColor", desc: "Magic wand: select pixels similar in color to the one at (x, y).",
    params: [req("x", "number", "Sample point x."), req("y", "number", "Sample point y."),
      P("tolerance", "integer", "How different a color may be and still be selected.", { min: 0, max: 100, default: 12 }),
      P("contiguous", "boolean", "Only connected areas.", { default: true }),
      P("allLayers", "boolean", "Sample the flattened image instead of the active layer.", { default: false }), selMode],
    returns: "info().selection", example: "await photocairn.selectColor({ x: 5, y: 5, tolerance: 20 })" },
  { group: "Selection", name: "selectAll", desc: "Select the whole image.", params: [], returns: "info().selection", example: "await photocairn.selectAll()" },
  { group: "Selection", name: "deselect", desc: "Remove the selection.", params: [], returns: "null", example: "await photocairn.deselect()" },
  { group: "Selection", name: "invertSelection", desc: "Select everything that isn't selected (selects all if nothing is).", params: [], returns: "info().selection", example: "await photocairn.invertSelection()" },
  { group: "Selection", name: "deleteSelection", desc: "Erase the selected pixels of the active layer (to transparency).", params: [], history: "Delete selection", returns: "info()", example: "await photocairn.deleteSelection()" },
  { group: "Selection", name: "fillSelection", desc: "Fill the selection (or the whole layer if nothing is selected) with a color.",
    params: [req("color", "color", "Fill color.")], positional: ["color"], history: "Fill", returns: "info()", example: "await photocairn.fillSelection('#ffffff')" },
  { group: "Selection", name: "cropToSelection", desc: "Crop the image to the selection's bounding box.", params: [], history: "Crop to selection", returns: "info()", example: "await photocairn.cropToSelection()" },

  /* ---- drawing ---- */
  { group: "Drawing", name: "fill", desc: "Paint bucket: fill the area around (x, y) that has a similar color.",
    params: [req("x", "number", "Point x."), req("y", "number", "Point y."), req("color", "color", "Fill color."),
      P("tolerance", "integer", "How different a color may be and still be filled.", { min: 0, max: 100, default: 32 }),
      P("contiguous", "boolean", "Only connected areas.", { default: true }),
      P("opacity", "integer", "Opacity in percent.", { min: 1, max: 100, default: 100 }),
      P("allLayers", "boolean", "Decide the area from the flattened image.", { default: false })],
    history: "Fill", returns: "info()", example: "await photocairn.fill({ x: 10, y: 10, color: '#ff3b30' })" },
  { group: "Drawing", name: "drawShape", desc: "Draw a line, arrow, rectangle or ellipse on the active layer.",
    params: [req("type", "enum", "Shape.", { values: ["line", "arrow", "rect", "ellipse"] }),
      req("from", "point", "Start point (a corner for rect/ellipse): { x, y }."), req("to", "point", "End point (the opposite corner): { x, y }."),
      P("color", "color", "Stroke/fill color.", { default: "#000000" }),
      P("width", "number", "Line width in pixels.", { min: 1, max: 1000, default: 4 }),
      P("fill", "boolean", "Fill rect/ellipse instead of outlining it.", { default: false }),
      P("opacity", "integer", "Opacity in percent.", { min: 1, max: 100, default: 100 })],
    history: "Line / Arrow / Rectangle / Ellipse", returns: "info()", example: "await photocairn.drawShape({ type: 'arrow', from: { x: 50, y: 50 }, to: { x: 300, y: 200 }, color: '#ff3b30', width: 8 })" },
  { group: "Drawing", name: "brushStroke", desc: "Paint one stroke through the given points with a brush, pencil, pen, highlighter or eraser.",
    params: [req("points", "points", "Stroke path: [{ x, y }, ...] (one point makes a dot)."),
      P("kind", "enum", "Brush type.", { values: ["brush", "pencil", "pen", "highlighter", "eraser"], default: "brush" }),
      P("size", "number", "Tip diameter in pixels.", { min: 1, max: 2000, default: 12 }),
      P("color", "color", "Paint color (ignored by the eraser).", { default: "#000000" }),
      P("opacity", "integer", "Opacity in percent.", { min: 1, max: 100, default: 100 }),
      P("hardness", "integer", "Edge hardness (brush and eraser).", { min: 0, max: 100, default: 70 })],
    history: "Brush / Pencil / Pen / Highlighter / Eraser", returns: "info()", example: "await photocairn.brushStroke({ points: [{ x: 10, y: 10 }, { x: 200, y: 80 }], size: 20, color: '#0a84ff' })" },

  /* ---- text ---- */
  { group: "Text", name: "addText", desc: "Add an editable text layer above the active layer.",
    params: [req("text", "string", "The text; \\n starts a new line."),
      P("x", "number", "Left edge of the text box. Default: centered."), P("y", "number", "Top edge of the text box. Default: centered."),
      P("size", "number", "Font size in pixels.", { min: 4, max: 2000, defaultText: "1/10 of the shorter side" }),
      P("font", "enum", "Font family (impact is shown as Bold in the app, hand as Casual).", { values: ["sans", "serif", "impact", "mono", "hand"], default: "sans" }),
      P("weight", "enum", "Font weight.", { values: [300, 400, 600, 700, 900], default: 700 }),
      P("italic", "boolean", "Italic.", { default: false }),
      P("color", "color", "Text color.", { default: "#000000" }),
      P("background", "color", "Box behind the text, or \"transparent\".", { default: "transparent", transparent: true }),
      P("outline", "boolean", "Contrasting outline around the letters.", { default: true }),
      P("align", "enum", "Line alignment.", { values: ["left", "center", "right"], default: "center" }),
      P("boxWidth", "number", "Wrap lines at this width in pixels; 0 = no wrapping.", { min: 0, default: 0 })],
    history: "Text", returns: "{ index, id, name, box: { x, y, width, height } }", example: "await photocairn.addText({ text: 'Hello', x: 40, y: 40, size: 64, color: '#ffffff', align: 'left' })" },
  { group: "Text", name: "editText", desc: "Change a text layer: any addText option (text, x, y, size, color...). Unchanged options keep their values.",
    params: [req("layer", "layer", "The text layer: index (0 = bottom) or exact name."),
      P("text", "string", "New text."), P("x", "number", "Left edge."), P("y", "number", "Top edge."),
      P("size", "number", "Font size.", { min: 4, max: 2000 }),
      P("font", "enum", "Font family.", { values: ["sans", "serif", "impact", "mono", "hand"] }),
      P("weight", "enum", "Font weight.", { values: [300, 400, 600, 700, 900] }), P("italic", "boolean", "Italic."),
      P("color", "color", "Text color."), P("background", "color", "Box color or \"transparent\".", { transparent: true }),
      P("outline", "boolean", "Outline."), P("align", "enum", "Alignment.", { values: ["left", "center", "right"] }),
      P("boxWidth", "number", "Wrap width; 0 = no wrapping.", { min: 0 })],
    positional: ["layer"], history: "Text", returns: "{ index, id, name, box }", example: "await photocairn.editText(1, { text: 'Hello again', color: '#ff3b30' })" },

  /* ---- layers ---- */
  { group: "Layers", name: "addLayer", desc: "Add a layer above the active one: blank, or an image scaled to fit and centered. It becomes the active layer.",
    params: [P("name", "string", "Layer name."), P("image", "source", "Image for the layer (File/Blob/data URL/same-site URL). Default: blank.")],
    history: "New layer / Place image", returns: "info()", example: "await photocairn.addLayer({ name: 'Notes' })" },
  { group: "Layers", name: "selectLayer", desc: "Make a layer the active one (most edits apply to the active layer). Not an undo step.",
    params: [req("layer", "layer", "Index (0 = bottom) or exact name.")], positional: ["layer"], returns: "info()", example: "await photocairn.selectLayer(0)" },
  { group: "Layers", name: "setLayer", desc: "Change a layer's name, visibility, opacity, blend mode or locks.",
    params: [layerRef(), P("name", "string", "New name."), P("visible", "boolean", "Show or hide."),
      P("opacity", "integer", "Opacity in percent.", { min: 0, max: 100 }),
      P("blend", "enum", "Blend mode.", { values: BLENDS }),
      P("lock", "object", "Locks to set: { alpha?, pixels?, position?, all? } (booleans).")],
    history: "Rename layer / Show layer / Hide layer / Layer opacity / Blend mode / Layer lock", returns: "info()", example: "await photocairn.setLayer({ opacity: 50, blend: 'multiply' })" },
  { group: "Layers", name: "duplicateLayer", desc: "Copy a layer; the copy goes above it and becomes active.", params: [layerRef()], positional: ["layer"], history: "Duplicate layer", returns: "info()", example: "await photocairn.duplicateLayer()" },
  { group: "Layers", name: "moveLayer", desc: "Move a layer one step up or down the stack.",
    params: [req("direction", "enum", "Which way.", { values: ["up", "down"] }), layerRef()], positional: ["direction"], history: "Move layer up / Move layer down", returns: "info()", example: "await photocairn.moveLayer('up')" },
  { group: "Layers", name: "deleteLayer", desc: "Delete a layer (an image keeps at least one).", params: [layerRef()], positional: ["layer"], history: "Delete layer", returns: "info()", example: "await photocairn.deleteLayer('Notes')" },
  { group: "Layers", name: "mergeDown", desc: "Merge the active layer into the one below.", params: [], history: "Merge down", returns: "info()", example: "await photocairn.mergeDown()" },
  { group: "Layers", name: "flatten", desc: "Merge all layers into one.", params: [], history: "Flatten image", returns: "info()", example: "await photocairn.flatten()" },

  /* ---- history ---- */
  { group: "History", name: "undo", desc: "Undo the last step(s).", params: [P("steps", "integer", "How many steps.", { min: 1, default: 1 })], positional: ["steps"], returns: "info()", example: "await photocairn.undo()" },
  { group: "History", name: "redo", desc: "Redo undone step(s).", params: [P("steps", "integer", "How many steps.", { min: 1, default: 1 })], positional: ["steps"], returns: "info()", example: "await photocairn.redo()" },
];

export const METHOD = Object.fromEntries(METHODS.map((m) => [m.name, m]));

/** The JSON-friendly description returned by help(). */
export function describe(m) {
  const out = { name: m.name, signature: signature(m), description: m.desc, params: m.params.map((p) => {
    const d = { name: p.name, type: p.type, description: p.desc, required: !!p.required };
    if (p.default !== undefined || p.defaultText) d.default = p.default ?? p.defaultText;
    for (const k of ["min", "max", "values"]) if (p[k] !== undefined) d[k] = p[k];
    return d;
  }), returns: m.returns, example: m.example };
  if (m.history) out.history = m.history;
  return out;
}

/** e.g. "crop({ x, y, width, height })" or "rotate(degrees)". */
export function signature(m) {
  const pos = m.positional || [];
  const rest = m.params.filter((p) => !pos.includes(p.name)).map((p) => p.name + (p.required ? "" : "?"));
  const parts = pos.map((n) => n + (m.params.find((p) => p.name === n).required ? "" : "?"));
  if (rest.length) parts.push(`{ ${rest.join(", ")} }${rest.every((r) => r.endsWith("?")) ? "?" : ""}`);
  return `${m.name}(${parts.join(", ")})`;
}

/* --------------------------------- validation --------------------------------- */

const isPlain = (v) => v != null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** "#abc" -> "#aabbcc" (lowercase); null if not a hex color. */
export function normColor(v) {
  if (typeof v !== "string" || !HEX.test(v.trim())) return null;
  let s = v.trim().slice(1).toLowerCase();
  if (s.length === 3) s = [...s].map((c) => c + c).join("");
  return `#${s}`;
}

function point(v) {
  if (Array.isArray(v) && v.length === 2) v = { x: v[0], y: v[1] };
  if (!isPlain(v) || !Number.isFinite(v.x) || !Number.isFinite(v.y)) return null;
  return { x: v.x, y: v.y };
}

/** Check one value against its parameter spec. Returns the normalized value or throws. */
function check(m, p, v) {
  const where = `${m.name}(): "${p.name}"`;
  const fail = (want) => { throw new TypeError(`${where} must be ${want}, got ${JSON.stringify(v) ?? String(v)}.`); };
  const range = (n) => {
    if (p.min !== undefined && n < p.min) throw new RangeError(`${where} must be at least ${p.min}, got ${n}.`);
    if (p.max !== undefined && n > p.max) throw new RangeError(`${where} must be at most ${p.max}, got ${n}.`);
    return n;
  };
  switch (p.type) {
    case "number": if (typeof v !== "number" || !Number.isFinite(v)) fail("a number"); return range(v);
    case "integer": if (typeof v !== "number" || !Number.isFinite(v)) fail("a number"); return range(Math.round(v));
    case "boolean": if (typeof v !== "boolean") fail("true or false"); return v;
    case "string": if (typeof v !== "string") fail("a string"); return v;
    case "function": if (typeof v !== "function") fail("a function"); return v;
    case "object": if (!isPlain(v)) fail("an object"); return v;
    case "enum": {
      const hit = p.values.find((x) => x === v || (typeof x === "string" && typeof v === "string" && x.toLowerCase() === v.toLowerCase()));
      if (hit === undefined) fail(`one of ${p.values.map((x) => JSON.stringify(x)).join(", ")}`);
      return hit;
    }
    case "color": {
      if (p.transparent && v === "transparent") return v;
      if (p.extra?.includes(v)) return v;
      const c = normColor(v);
      if (!c) fail(`a hex color like "#ff8800"${p.transparent ? ' or "transparent"' : ""}${p.extra ? ` or ${p.extra.map((x) => `"${x}"`).join(", ")}` : ""}`);
      return c;
    }
    case "point": return point(v) || fail("a point { x, y } with numbers");
    case "points": {
      if (!Array.isArray(v) || !v.length) fail("a non-empty array of points [{ x, y }, ...]");
      return v.map((q) => point(q) || fail("an array of points [{ x, y }, ...]"));
    }
    case "layer": if (!(typeof v === "string" || (typeof v === "number" && Number.isInteger(v)))) fail("a layer index (0 = bottom) or a layer name"); return v;
    case "source": {
      const blob = typeof Blob !== "undefined" && v instanceof Blob;
      if (!blob && typeof v !== "string") fail("a File, Blob, data: URL or http(s) URL");
      return v;
    }
    default: return v;
  }
}

/**
 * Turn the arguments of a call into one checked options object with defaults.
 * Positional parameters come first; a trailing plain object holds the rest.
 * A single plain object is always taken as the options object.
 */
export function normalize(name, args) {
  const m = METHOD[name];
  if (!m) throw new Error(`Unknown method "${name}".`);
  const pos = m.positional || [];
  let opts = {};
  let i = 0;
  if (!(args.length === 1 && isPlain(args[0]))) {
    for (; i < pos.length && i < args.length; i++) {
      if (isPlain(args[i]) && i === args.length - 1) break; // the options object, with optional positionals left out
      if (args[i] !== undefined) opts[pos[i]] = args[i];
    }
  }
  const rest = args.slice(i);
  if (rest.length > 1) throw new TypeError(`${signature(m)} takes at most ${pos.length + 1} arguments.`);
  if (rest.length === 1 && rest[0] !== undefined) {
    if (!isPlain(rest[0])) throw new TypeError(`${signature(m)}: expected an options object, got ${typeof rest[0]}.`);
    opts = { ...rest[0], ...opts };
  }
  const known = new Set(m.params.map((p) => p.name));
  for (const k of Object.keys(opts)) {
    if (!known.has(k)) throw new TypeError(`${m.name}() has no option "${k}". ${known.size ? `Options: ${[...known].join(", ")}.` : "It takes no options."} See photocairn.help("${m.name}").`);
  }
  const out = {};
  for (const p of m.params) {
    const v = opts[p.name];
    if (v === undefined || v === null) {
      if (p.required) throw new TypeError(`${m.name}() needs "${p.name}": ${p.desc} Usage: ${signature(m)}`);
      if (p.default !== undefined) out[p.name] = p.default;
      continue;
    }
    out[p.name] = check(m, p, v);
  }
  return out;
}

/* ---------------------------------- helpers ---------------------------------- */

/** Decode a data: URL into { mime, bytes } (no fetch: the page's CSP blocks fetching data: URLs). */
export function dataUrlToBytes(url) {
  const m = /^data:([^,]*?),(.*)$/s.exec(url);
  if (!m) throw new Error("That isn't a valid data: URL.");
  const meta = m[1].split(";"), base64 = meta.includes("base64");
  const mime = meta[0] || "text/plain";
  let bytes;
  if (base64) {
    const bin = atob(m[2].replace(/\s+/g, ""));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else bytes = new TextEncoder().encode(decodeURIComponent(m[2]));
  return { mime, bytes };
}

/** Width and height for a resize where one side may be missing (keeps the aspect ratio). */
export function resizeDims(w, h, o) {
  if (o.width == null && o.height == null) throw new TypeError("resize() needs width, height or both.");
  const width = o.width ?? Math.max(1, Math.round((w * o.height) / h));
  const height = o.height ?? Math.max(1, Math.round((h * o.width) / w));
  return { width, height };
}

/** Intersect a rectangle with a W x H image, rounded to whole pixels. null if nothing is left. */
export function clipRect(r, W, H) {
  const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(W, Math.ceil(r.x + r.width)), y1 = Math.min(H, Math.ceil(r.y + r.height));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** Normalize an angle: { quarter: 1 | 2 | -1 } for right angles, { free: degrees } otherwise, or null for 0/360. */
export function rotation(deg) {
  let d = ((deg % 360) + 360) % 360;
  if (d === 0) return null;
  if (d === 90) return { quarter: 1 };
  if (d === 180) return { quarter: 2 };
  if (d === 270) return { quarter: -1 };
  if (d > 180) d -= 360;
  return { free: d };
}

/** Find a layer index from an index (0 = bottom) or exact name. */
export function resolveLayer(layers, ref, active) {
  if (ref === undefined || ref === null) return active;
  if (typeof ref === "number") {
    if (ref < 0 || ref >= layers.length) throw new RangeError(`There's no layer ${ref}: layers go from 0 (bottom) to ${layers.length - 1} (top).`);
    return ref;
  }
  const hits = layers.map((l, i) => (l.name === ref ? i : -1)).filter((i) => i >= 0);
  if (!hits.length) throw new RangeError(`There's no layer named "${ref}". Layers: ${layers.map((l) => JSON.stringify(l.name)).join(", ")}.`);
  if (hits.length > 1) throw new RangeError(`${hits.length} layers are named "${ref}"; use an index (${hits.join(", ")}).`);
  return hits[0];
}
