<p align="center"><img src="icons/icon.svg" width="72" alt=""></p>

<h1 align="center">Photocairn</h1>

<p align="center"><b>Quick photo edits in your browser. No ads, no account, nothing uploaded.</b></p>

<p align="center"><a href="https://silicairn.com/photocairn/"><b>Open Photocairn →</b></a></p>

<p align="center"><img src="docs/screenshot.png" alt="Photocairn removing the background from a photo of a pug in a blanket" width="860"></p>

Sometimes you just need to cut out a background, crop a photo square or blur a name in a screenshot. You don't want to install Photoshop, start a trial, make an account or put up with an ad-covered "free" site that uploads your photo somewhere.

Photocairn is a fast, focused editor for exactly those jobs. **Everything runs on your device.** The AI background removal runs in your browser through WebAssembly. The page's security policy doesn't allow it to connect to any other server, so your photos stay with you.

## What it does

- **Remove background.** AI cutout that runs locally. Choose *Fast* (4.6 MB model) or *Best quality* (44 MB, cached after the first use). You can then:
  - keep the background transparent, swap in a solid color or blur the original background
  - touch up the edges with *Erase* and *Restore* brushes
- **Layers.** Stack photos, text and drawings. Each layer can be shown or hidden, renamed, reordered, duplicated, moved, merged or flattened, and has its own opacity and blend mode (Multiply, Screen, Overlay, Soft light and 12 more). Paste or drop a photo to add it as a layer. Other tools edit the selected layer; crop, resize, rotate and corners apply to the whole image.
- **Crop.** Free crop or presets (1:1, 4:5, 3:2, 16:9, 9:16), and straighten with an automatic crop.
- **Rotate & flip.** Rotate 90° left or right, flip horizontally or vertically, or rotate by any angle. Works on the whole image or just the current layer.
- **Resize.** By pixels or percent, with one-tap sizes (1080 px, 1920 px, 512 px). Downscaling uses multiple steps so results stay sharp.
- **Adjust.** Brightness, contrast, exposure, highlights, shadows, saturation, warmth, tint, sharpen and soften.
- **Filters.** Mono, Sepia, Vivid, Warm, Cool, Fade, Noir, Vintage and Invert, each with a strength slider.
- **Blur out.** Drag over faces, plates or private details to blur, pixelate or cover them with a solid box.
- **Draw.** Pen, highlighter, arrows, lines, boxes and circles, for marking up screenshots.
- **Text.** Captions with outline and background options. Drag to place. Each text goes on its own layer.
- **Corners & border.** Rounded corners, circle crop for profile pictures, and colored or transparent borders.
- **Save.** PNG, JPG or WebP, with a quality slider, an output size slider and a live file-size estimate. You can also copy to the clipboard. **Location and camera data (EXIF) are always removed.**
- **Editing basics:**
  - undo/redo
  - hold to compare with the original
  - zoom and pan (pinch on phones)
  - open by drag & drop or paste
  - keyboard shortcuts
  - works offline and can be installed as an app

## Privacy

- No uploads, accounts, analytics, ads or cookies.
- A strict Content-Security-Policy (`connect-src 'self'`) means the page *can't* send data to any other server, even by accident.
- The AI models and the WebAssembly runtime are served from the same site and then cached locally.

## Keyboard shortcuts

- `Ctrl/⌘ + O`: open
- `Ctrl/⌘ + S`: save
- `Ctrl/⌘ + Z`: undo
- `Ctrl/⌘ + Shift + Z` or `Ctrl/⌘ + Y`: redo
- `0`: fit to screen
- `1`: actual size
- `+` / `−`: zoom
- Hold `Space`: pan
- Hold `\`: compare with the original
- `Enter`: apply crop
- `Esc`: close the tool

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
- `js/tools.js`: one factory per tool. Each one builds its panel and handles pointer input in image coordinates.
- `js/bg-worker.js`: background removal in a Web Worker. It runs [U²-Net](https://github.com/xuebinqin/U-2-Net) models with [ONNX Runtime Web](https://onnxruntime.ai/), and the mask is upscaled and applied on a canvas.
- `sw.js`: service worker for offline use.

Third-party components and their licenses are listed in [THIRD_PARTY.md](THIRD_PARTY.md).

## License

[MIT](LICENSE)
