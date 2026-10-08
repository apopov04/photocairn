<p align="center"><img src="icons/icon.svg" width="72" alt=""></p>

<h1 align="center">Photocairn</h1>

<p align="center"><b>Quick photo edits in your browser. No ads, no account, nothing uploaded.</b></p>

<p align="center"><a href="https://silicairn.com/photocairn/"><b>Open Photocairn →</b></a></p>

<p align="center"><img src="docs/screenshot.png" alt="Photocairn removing the background from a photo of a pug in a blanket" width="860"></p>

Sometimes you just need to cut out a background, crop a photo square or blur a name in a screenshot. You don't want to install Photoshop, start a trial, make an account or put up with an ad-covered "free" site that uploads your photo somewhere.

Photocairn is a fast, focused editor for exactly those jobs. **Everything runs on your device.** The AI background removal runs in your browser through WebAssembly. The page's security policy doesn't allow it to connect to any other server, so your photos stay with you.

## What it does

The layout will feel familiar if you've used Photoshop:
- a **menu bar** (File, Edit, Image, Layer, Select, Filter, View, Help)
- **tools** down the left
- the selected tool's **options** at the top right, with the **Layers** panel below them

On phones, the tools sit along the bottom and the options and layers share a tabbed sheet.

**Files**
- Open PNG, JPG, WebP, AVIF, GIF and **PSD** (with layers). You can also drag & drop, paste from the clipboard, or start a **new blank image** (with presets; white, transparent or colored background).
- Save as PNG, JPG, WebP or **layered PSD** (opens in Photoshop, GIMP and Photopea), with quality and size sliders and a live file-size estimate, or copy to the clipboard. **Location and camera data (EXIF) are always removed.**

**Metadata remover** (File › Metadata, or from the start screen without opening the editor)
- Shows everything hidden in a JPEG, PNG or WebP:
  - **GPS location**, with a map link
  - camera make/model, lens and **serial numbers**, software
  - dates and times
  - author, captions and copyright
  - shooting settings
  - maker notes
  - the **embedded thumbnail**, which can show the photo before it was cropped
  - XMP, IPTC, comments, color profile
  - extra data after the image, such as motion-photo video
- Tick what to scrub, or use one click for *Private info*, *Everything* or *Nothing*, then download a cleaned copy.
- The image data is copied byte for byte, so there's **no re-compression**. Removing GPS leaves every other tag exactly as it was.
- When you open a photo that contains a GPS location, you get a warning.

**Edit**
- **Move** (V): drag a layer, or just the selected pixels. Arrow keys nudge.
- **Select** (M): rectangle and ellipse marquee with add, subtract and intersect. Also select all, invert, crop to selection, copy or cut to a new layer, fill, and delete. Painting, fills, adjustments and filters stay inside the selection.
- **Free transform** (Ctrl+T): scale, rotate, flip and move a layer or selection, using handles or exact numbers.
- **Crop**: free or preset ratios, plus straighten.
- **Rotate & flip**: 90° steps, horizontal/vertical flip or any angle, applied to the whole image or one layer.
- **Resize**: image size (scale), plus **canvas size** with an anchor to add space around the image without scaling it.

**Paint**
- **Brush** (B): size, hardness, opacity and color.
- **Pencil** (N): hard, pixel-exact lines.
- **Eraser** (E): soft or block.
- **Paint bucket** (K): tolerance, contiguous or global fill, and sample one layer or all layers.
- **Gradient** (G): linear or radial, fading to the second color or to transparent.
- **Eyedropper** (I): average 1, 3×3 or 5×5 pixels.
- **Shapes** (U): line, arrow, rectangle, ellipse (outlined or filled) and highlighter.
- **Text** (T): click to place text or drag to draw a text box, then drag to move it and drag the side handles to set the wrapping width. Font, font size, weight, italic, alignment, color, outline and background color. Each text is an editable text layer: click it with the Text tool (or double-click it) to change it later. Painting or filtering a text layer turns it into pixels.
- Main and second colors in the toolbar. X swaps them, D resets to black and white. Alt+click with the brush picks a color.

**Layers**
- Create, delete, duplicate, rename, reorder, show/hide, clear, merge down, merge visible and flatten.
- Each layer has its own opacity and blend mode (16 modes).
- **Locks** like Photoshop's: transparent pixels, image pixels, position, or all.

**Photo**
- **Remove background** with AI that runs on your device. *Fast* uses a 4.6 MB model and *Best quality* a 44 MB one. Afterwards you can pick a solid or blurred background and touch up with Erase/Restore brushes.
- **Adjust**: brightness, contrast, exposure, highlights, shadows, saturation, warmth, tint, sharpen and soften.
- **Filters**: Mono, Sepia, Vivid, Warm, Cool, Fade, Noir, Vintage and Invert, with a strength slider.
- **Blur out** faces, plates and private details by blurring, pixelating or covering them with a solid box.
- **Corners & border**: rounded corners, circle crop, and borders.

**Everywhere**
- Undo/redo.
- Hold to compare with the original.
- Zoom in/out, fit, 100% and pan (pinch on phones).
- Works offline and can be installed as an app.

## Privacy

- No uploads, accounts, analytics, ads or cookies.
- A strict Content-Security-Policy (`connect-src 'self'`) means the page *can't* send data to any other server, even by accident.
- The AI models and the WebAssembly runtime are served from the same site and then cached locally.

## Keyboard shortcuts

**Tools**
- `V`: Move
- `M`: Select
- `Ctrl+T`: Transform
- `C`: Crop
- `B`: Brush
- `N`: Pencil
- `E`: Eraser
- `K`: Paint bucket
- `G`: Gradient
- `I`: Eyedropper
- `U`: Shapes
- `T`: Text
- `L`: Layers

**Colors and brushes**
- `X`: swap colors
- `D`: reset colors to black and white
- `[` / `]`: brush size

**Selection**
- `Ctrl+A`: select all
- `Ctrl+D`: deselect
- `Ctrl+Shift+I`: invert selection
- `Ctrl+J`: copy the selection to a new layer
- `Delete`: delete the selected pixels

**File and history**
- `Ctrl+O`: open
- `Ctrl+S`: save
- `Ctrl+Z`: undo
- `Ctrl+Shift+Z` or `Ctrl+Y`: redo

**View**
- `0`: fit to screen
- `1`: 100%
- `+` / `−`: zoom
- Hold `Space`: pan
- Hold `\`: compare with the original

**In tools**
- `Enter`: apply
- `Esc`: cancel, or deselect

## Run it yourself

There's no build step. It's plain HTML, CSS and JavaScript modules.

```bash
git clone https://github.com/apopov04/photocairn.git && cd photocairn
node tests/serve.mjs          # http://localhost:8080
```

Any static host works. To enable multi-threaded WebAssembly (faster background removal), serve it with the cross-origin isolation headers in [`_headers`](_headers), which Cloudflare and Netlify pick up automatically.

## Tests

```bash
npm test                      # unit tests for the image operations (Node, no dependencies)
npm i && CHROME=/path/to/chrome npm run test:e2e   # browser end-to-end scenarios
```

## How it's built

- `js/ops.js`: pure pixel operations (adjustments, filters, blur, sharpen, pixelate, mask handling). They don't touch the DOM, so they're unit-tested in Node.
- `js/editor.js`: the document model (layers plus memory-capped undo history) and the zoomable viewport. Layers are immutable snapshots, so undo stores references instead of pixel copies.
- `js/tools.js`: the crop, resize, adjust, filters, text, layers and other panels. Each tool is a factory that builds its panel and handles pointer input in image coordinates.
- `js/text.js`: text layers. A text layer keeps its text, font, size, colors and box in `layer.meta.text` and is re-rendered from them, so it stays editable (word wrapping is unit-tested in Node).
- `js/paint.js`: the brush engine (stamped strokes with hardness and per-stroke opacity), pencil, eraser, shapes, paint bucket, gradient, eyedropper, selection, move and free transform. All pixel edits go through one function, which respects the selection and layer locks.
- `js/menus.js`: the menu bar (the same menus open from a single button on phones).
- `js/metadata.js`: dependency-free JPEG/PNG/WebP metadata parser and scrubber. It rebuilds EXIF tag by tag, recomputes PNG CRCs, and updates WebP's VP8X flags and RIFF size. `js/metadata-ui.js` is its dialog.
- `js/psd.js`: PSD import/export with [ag-psd](https://github.com/Agamnentzar/ag-psd), loaded only when needed.
- `js/bg-worker.js`: background removal in a Web Worker. It runs [U²-Net](https://github.com/xuebinqin/U-2-Net) models with [ONNX Runtime Web](https://onnxruntime.ai/), and the mask is upscaled and applied on a canvas.
- `sw.js`: service worker for offline use.

Third-party components and their licenses are listed in [THIRD_PARTY.md](THIRD_PARTY.md).

## License

[MIT](LICENSE)
