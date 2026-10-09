# Photocairn for developers and AI agents

> Photocairn (https://photocairn.silicairn.com/) is a free, private photo editor that runs entirely in the browser: remove backgrounds with on-device AI, crop, resize, adjust, blur out details, add text, work with layers and convert formats. No ads, no account, no uploads. Besides the normal UI it has a small scripting API, `window.photocairn`, so AI agents and automation can edit images in the page.

This document covers what Photocairn does, every tool and its settings, the keyboard shortcuts, and the full `window.photocairn` API reference with examples. It's also available as plain text at [llms-full.txt](https://photocairn.silicairn.com/llms-full.txt) (short version: [llms.txt](https://photocairn.silicairn.com/llms.txt)). Source code: [github.com/apopov04/photocairn](https://github.com/apopov04/photocairn) (MIT).

## Privacy

- **Editing runs locally.** Photos are decoded, edited and encoded in the browser tab. Nothing is uploaded: the page's Content-Security-Policy (`connect-src 'self'`) doesn't let it connect to any other server. There are no accounts, analytics, ads or cookies.
- **The AI models are local too.** Background removal runs U²-Net models with ONNX Runtime (WebAssembly) in a Web Worker. The models are downloaded once from this same site and cached.
- **But an AI agent can see what it works on.** If an AI agent drives your browser (ChatGPT agent, Claude in Chrome, a Playwright script that calls a hosted model...), that agent sees the page, its screenshots and anything `getImage()` or `export()` returns, and it may send them to the service that runs its model. Photocairn can't prevent that. Only let an agent handle images you'd be happy to share with that service.
- **The API doesn't reach out on its own.** It only fetches a URL when you pass one to `open()` or `addLayer()`, and only downloads a file when you call `export({ download: true })`. Loading from other sites is blocked by the security policy anyway.

## Quick start for agents

1. Open https://photocairn.silicairn.com/ in the browser.
2. `window.photocairn` is ready once the page has loaded (it also fires a `photocairn:ready` event on `window`).
3. Run JavaScript in the page (DevTools console, Playwright's `page.evaluate`, your agent's "run script" tool):

```js
await photocairn.help();                 // every method with its parameters, ranges and defaults
await photocairn.help("redact");         // one method
await photocairn.open(dataUrl);          // a data: URL, Blob/File, or a URL on this site
await photocairn.adjust({ brightness: 15, warmth: 10 });
await photocairn.info();                 // size, layers, selection, history
const preview = await photocairn.getImage({ format: "jpeg", maxSize: 768 }); // cheap look at the result
const png = await photocairn.export({ format: "png" });                     // data URL of the final image
```

**Conventions**

- `photocairn.version` is the app version, `photocairn.apiVersion` is {{API_VERSION}}. New methods and options may be added in the same API version; anything that breaks existing calls would bump it.
- Every method returns a Promise. Calls run one at a time, in the order they were made.
- Arguments are plain JSON-friendly objects. Most methods take one options object; a few also take their main argument directly: `rotate(90)`, `flip("horizontal")`, `look("mono")`, `editText(1, { ... })`.
- Coordinates and sizes are **image pixels**, with (0, 0) at the top-left of the image, not screen pixels. If you located something on a downscaled `getImage({ maxSize })` preview, scale its coordinates by `info().width / previewWidth`.
- Colors are hex strings: `"#ff8800"` or `"#f80"`. Percentages (opacity, strength, quality) are 0 to 100. Adjustment sliders run from -100 to 100, as in the app.
- Layers are numbered from the bottom: 0 is the bottom layer. Methods that take a `layer` accept that index or the layer's exact name.
- Wrong arguments throw an `Error` that says what was expected, e.g. `crop() needs "y": ...` or `adjust() has no option "brightnes"`. With no image open you get `No image open. Call photocairn.open(source) or photocairn.newImage({ width, height }) first.`
- Every edit goes through the same code as the app's own tools: it acts on the **active layer**, stays inside the **selection** if there is one, refuses **locked** or hidden layers with a clear error, adds one named step to the **History** panel and can be undone with `photocairn.undo()`. Crop, resize, rotate and flip change the whole image (all layers).
- A person watching the tab sees every change happen in the normal UI and can undo it.
- `open()` and `newImage()` replace the current image **without asking**, unlike the app's own Open command. Export first if the current work matters.

**Playwright**

```js
import { chromium } from "playwright";
import fs from "node:fs";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("https://photocairn.silicairn.com/");
await page.waitForFunction(() => window.photocairn);

const dataUrl = "data:image/jpeg;base64," + fs.readFileSync("photo.jpg").toString("base64");
await page.evaluate((u) => photocairn.open(u, { name: "photo.jpg" }), dataUrl);
await page.evaluate(() => photocairn.resize({ width: 1080 }));

const out = await page.evaluate(() => photocairn.export({ format: "webp", quality: 80 }));
fs.writeFileSync("photo.webp", Buffer.from(out.split(",")[1], "base64"));
await browser.close();
```

## Example: remove a background and export

An agent cuts out the subject of a product photo, puts it on white and saves a square JPEG.

```js
await photocairn.open(photoDataUrl, { name: "mug.jpg" });

// Downloads the 4.6 MB "fast" model on first use (cached afterwards), then runs it on this device.
await photocairn.removeBackground({
  model: "fast",                       // or "best": 44 MB, cleaner edges
  background: "#ffffff",               // or "transparent" (default), any hex color, or "blur"
  onProgress: (p) => console.log(p.stage, Math.round(p.progress * 100) + "%"),
});

// Check the result cheaply before saving.
const check = await photocairn.getImage({ format: "jpeg", maxSize: 512 });
// ...show `check` to the vision model; if an edge needs work: await photocairn.undo() and try model: "best".

const { width, height } = await photocairn.info();
const side = Math.min(width, height);
await photocairn.crop({ x: (width - side) / 2, y: (height - side) / 2, width: side, height: side });

const jpeg = await photocairn.export({ format: "jpeg", quality: 90 });   // data URL
// or let the browser save it:
await photocairn.export({ format: "jpeg", quality: 90, download: true, filename: "mug-white" });
```

For a transparent cutout, leave out `background` and export as PNG or WebP (JPEG has no transparency, so see-through areas would turn white).

## Example: blur out part of a screenshot

An agent hides an email address and an API key in a screenshot before it's shared.

```js
await photocairn.open(screenshotDataUrl, { name: "screenshot.png" });
const { width } = await photocairn.info();

// 1. Look at a small copy to find what to hide.
const small = await photocairn.getImage({ format: "jpeg", maxSize: 1024 });
// The vision model finds the email at (412, 96, 260 x 24) on the 1024 px copy.
const s = width / Math.min(1024, width);       // preview pixels to image pixels (1 if not downscaled)

// 2. Blur the email. Blur and pixelation can sometimes be reversed...
await photocairn.redact({ x: 412 * s, y: 96 * s, width: 260 * s, height: 24 * s, mode: "blur", strength: 80 });

// 3. ...so cover secrets (passwords, keys, card numbers) with a solid box.
await photocairn.redact({ x: 180 * s, y: 540 * s, width: 520 * s, height: 30 * s, mode: "box", color: "#000000" });

// 4. Check, then export. Exports never contain metadata.
const after = await photocairn.getImage({ format: "jpeg", maxSize: 1024 });
const png = await photocairn.export({ format: "png" });
```

The History panel now shows *Blur* and *Solid box* steps; `await photocairn.undo()` reverts the last one.

## Tools

The editor looks like a small Photoshop: a menu bar (File, Edit, Image, Layer, Select, Filter, View, Help), tools down the left, and on the right the active tool's options, then History, then Layers. On phones the tools move to the bottom and the panels share a tabbed sheet. Tools that share a toolbar button (brushes, selections, fills, shapes, blur out) have a small corner mark: right-click or long-press to pick another one, or press its key again to cycle. "API" names the matching `window.photocairn` method.

**Files**

- **Open**: PNG, JPG, WebP, AVIF, GIF and PSD (with layers); drag and drop, paste, or File › Open. Very large photos are scaled to 16.7 megapixels. Photos with a GPS location show a warning. API: `open()`.
- **New blank image**: width and height (1 to 8000 px), presets (1080 × 1080, 1080 × 1350, 1080 × 1920, 1920 × 1080, 1200 × 630, 512 × 512), background white, transparent or the main color. API: `newImage()`.
- **Place image as layer** (File menu, or drop/paste onto an open image): adds an image as a new layer, scaled to fit and centered. API: `addLayer({ image })`.
- **Save / Export** (Ctrl+S): format PNG, JPG, WebP or layered PSD; quality 10 to 100% (JPG/WebP); size 10 to 100%; file name; live file-size estimate; Download or Copy to clipboard. Location and camera data are never included. API: `export()`.
- **Metadata: view & remove** (File menu, or from the start screen): lists GPS, camera and lens serials, dates, author, maker notes, the embedded thumbnail, XMP, IPTC and more in a JPEG, PNG or WebP, and saves a cleaned copy without re-compressing it. No API.

**Selecting and moving**

- **Move** (V): drag the active layer, or only the selected pixels. Arrow keys nudge by 1 px (Shift: 10 px). *Center on canvas*. No API.
- **Select** (M, Shift+M cycles): Rectangle, Ellipse, Lasso, Polygon (click corners; click the first point, double-click or Enter to finish) and Magic wand (W; tolerance 0 to 100, default 12; contiguous; sample all layers). Mode: new, add, subtract, intersect (or hold Shift to add, Alt to subtract). Buttons: All, None, Invert, Crop, Copy → layer, Cut → layer, Fill, Delete. Brushes, fills, adjustments and filters then only change the selected area. API: `select()`, `selectColor()`, `selectAll()`, `deselect()`, `invertSelection()`, `cropToSelection()`, `fillSelection()`, `deleteSelection()`.
- **Snap** (View › Snap, Ctrl+Shift+;, on by default): Move and Free transform snap the content's edges and centre to the canvas edges and centre lines and to the edges and centres of other visible layers, with magenta guide lines. Hold Ctrl (Cmd on Mac) while dragging to move freely.
- **Free transform** (Ctrl+Alt+T): scale, rotate, flip and move a layer or selection with handles, or type width %, height % and angle. No API.

**Image**

- **Crop** (C): drag the frame; aspect ratio Free, Original, 1:1, 4:5, 3:2, 16:9 or 9:16; rotate 90° and flip buttons; Straighten -45° to 45°. Enter applies. API: `crop()`.
- **Rotate & flip** (Image menu): 90° steps, 180°, flip horizontal or vertical, or any angle from -180° to 180° (the canvas grows to fit), for the whole image or only the current layer. API: `rotate()`, `flip()` (whole image only).
- **Image size**: width and height in pixels, keep proportions, quick sizes 25/50/75% and longest side 1080/1920/512 px. API: `resize()`.
- **Canvas size**: add or trim space around the image without scaling; anchor; new area transparent, second color or main color. No API.
- **Corners & border**: rounded corners 0 to 100%, circle crop, border 0 to 30% with a color. No API.

**Painting**

- **Brush tools** (B, Shift+B cycles): **Brush** (size, hardness, opacity, main color), **Pencil** (N; hard pixel-exact lines), **Pen** (smoothed ink for writing and signatures), **Highlighter** (flat see-through chisel tip that darkens what's under it; own color, yellow by default). Shift+click draws a straight line, Alt+click picks a color, [ and ] change the size. API: `brushStroke()`.
- **Eraser** (E): Brush (soft, with hardness) or Block (square, pixel-exact); size and opacity. API: `brushStroke({ kind: "eraser" })`.
- **Fill tools** (G, Shift+G cycles): **Paint bucket** (K; tolerance 0 to 100, default 32; opacity; contiguous; sample all layers) and **Gradient** (linear or radial, from the main color to the second color or to transparent; opacity). API: `fill()` (no gradient).
- **Eyedropper** (I): sample 1 px, 3×3 or 5×5, from all layers or the current one. Alt+click sets the second color. No API.
- **Shapes** (U, Shift+U cycles): Line, Arrow, Rectangle and Ellipse; line width, opacity, filled (rectangle and ellipse). Shift keeps 45° angles or a perfect square or circle. API: `drawShape()`.
- **Text** (T): click to add text or drag to draw a wrapping text box. Font (Sans, Serif, Bold, Mono, Casual), size, weight (Light to Black), alignment, text color, background color, italic and outline. Each text is an editable text layer: click it with the Text tool, or double-click it, to change it. Painting or filtering a text layer turns it into pixels. API: `addText()`, `editText()`.
- **Colors**: main and second color at the bottom of the toolbar. X swaps them, D resets to black and white.

**Photo**

- **Remove background**: finds the main subject and removes everything else with AI on this device. Model *Fast* (4.6 MB) or *Best quality* (44 MB). Afterwards: a transparent, colored or blurred background, and Erase/Restore brushes to touch up the edges. API: `removeBackground()` (no touch-up brushes; use `brushStroke({ kind: "eraser" })` to erase).
- **Adjust** (Image › Adjustments): brightness, contrast, exposure, highlights, shadows, saturation, warmth and tint (-100 to 100), sharpen and soften (0 to 100). API: `adjust()`.
- **Filters**: Mono, Sepia, Invert, Vivid, Warm, Cool, Fade, Noir and Vintage, with a strength slider (0 to 100%). API: `look()`.
- **Blur out**: drag over faces, number plates, names or anything private. **Blur** and **Pixelate** (strength 10 to 100) or **Solid box** (a color). Use Solid box for passwords, card numbers and IDs: blur and pixelation can sometimes be reversed. API: `redact()`.

**Layers and history**

- **Layers** panel: new, add image, duplicate, move up/down, merge down, clear and delete; click to select, double-click to rename, eye to show or hide; opacity 0 to 100% and 16 blend modes (Normal, Multiply, Screen, Overlay, Darken, Lighten, Color dodge, Color burn, Hard light, Soft light, Difference, Exclusion, Hue, Saturation, Color, Luminosity); locks for transparent pixels, image pixels, position, or all. Layer menu: merge visible, flatten. API: `addLayer()`, `selectLayer()`, `setLayer()`, `duplicateLayer()`, `moveLayer()`, `deleteLayer()`, `mergeDown()`, `flatten()`.
- **History** panel: one row per step (Brush, Fill, Merge down...), starting with the opened image. Click a step to go back to it, or a dimmed later step to redo up to it. About 400 MB of image data is kept; the oldest steps are dropped first. API: `undo()`, `redo()`, `info().history`.
- **Compare**: hold the compare button (or `\`) to see the original photo.

## Keyboard shortcuts

| Action | Keys |
| --- | --- |
| Move / Select / Crop | V / M / C |
| Next selection tool (Ellipse, Lasso, Polygon, Magic wand) | M again / Shift+M |
| Magic wand | W |
| Brush tools / Pencil / Eraser | B / N / E |
| Next brush tool (Pencil, Pen, Highlighter) | B again / Shift+B |
| Fill tools / Paint bucket | G / K |
| Next fill tool (Paint bucket, Gradient) | G again / Shift+G |
| Eyedropper | I |
| Shapes / Text | U / T |
| Next shape (Line, Arrow, Rectangle, Ellipse) | U again / Shift+U |
| Free transform | Ctrl+Alt+T |
| Snap on / off | Ctrl+Shift+; |
| Swap / reset colors | X / D |
| Brush or text size | [ / ] |
| Select all / Deselect / Invert selection | Ctrl+A / Ctrl+D / Ctrl+Shift+I |
| Copy / Cut / Paste | Ctrl+C / Ctrl+X / Ctrl+V |
| Selection to new layer | Ctrl+J |
| New layer / Merge down | Ctrl+Shift+N / Ctrl+E |
| Delete selected pixels | Delete |
| Undo / Redo | Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y |
| Open / Save | Ctrl+O / Ctrl+S |
| Zoom in / out, Fit, 100% | + / −, 0, 1 |
| Pan | hold Space |
| Compare with the original | hold `\` |
| Layers panel | L |
| Apply (crop, transform) / Cancel or deselect | Enter / Esc |

On a Mac, use Cmd instead of Ctrl.

## API reference

All methods live on `window.photocairn` and return Promises. "History" names the step each call adds to the History panel.

{{API_REFERENCE}}

## Not in the API

These app features have no API method (yet). Most can be approximated:

- **Lasso selection**: use `select({ type: "polygon", points })` with many points.
- **Move and free transform**, rotating a single layer, canvas size, straighten: not available. Crop, resize, rotate and flip work on the whole image.
- **Gradient**, **eyedropper**, **corners & border**, **merge visible**: not available. To read a color, look at `getImage()`.
- **Background touch-up brushes** after `removeBackground()`: erase leftovers with `brushStroke({ kind: "eraser", points, size })`; restoring isn't available (undo and try `model: "best"` instead).
- **Clipboard** copy/paste and the **metadata viewer**: not available. Exports never contain metadata.
- `open()` can't fetch images from other websites (blocked by the page's security policy and cross-origin isolation): pass a data: URL or a Blob instead.
