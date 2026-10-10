// Pure pixel operations. Every function takes and returns ImageData-shaped
// objects ({ width, height, data: Uint8ClampedArray }) and never touches the
// DOM, so they run the same in the browser, in workers and in Node tests.

export function makeImage(width, height, data) {
  return { width, height, data: data || new Uint8ClampedArray(width * height * 4) };
}

export function cloneImage(img) {
  return makeImage(img.width, img.height, new Uint8ClampedArray(img.data));
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Light / color adjustments. All values are in -100..100 (0 = unchanged).
 *   brightness, contrast, saturation, warmth, tint, exposure, highlights, shadows
 */
export function adjust(img, o = {}) {
  const b = (o.brightness || 0) * 1.28;
  const c = (o.contrast || 0) / 100;
  const cf = c >= 0 ? 1 + c * 2 : 1 + c; // contrast factor 0..3
  const s = 1 + (o.saturation || 0) / 100; // 0..2
  const w = (o.warmth || 0) * 0.3;
  const t = (o.tint || 0) * 0.3;
  const ex = Math.pow(2, (o.exposure || 0) / 50); // ±2 stops
  const hi = (o.highlights || 0) / 100;
  const sh = (o.shadows || 0) / 100;

  // Tone curve as a LUT (exposure, brightness, contrast, highlights, shadows).
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    let v = i * ex + b;
    v = (v - 128) * cf + 128;
    const n = clamp255(v) / 255;
    // Shadows lift the low end, highlights the high end, with smooth falloff.
    v = n + sh * (1 - n) * (1 - n) * n * 2.2 + hi * n * n * (1 - n) * 2.2;
    lut[i] = clamp255(v * 255);
  }

  const out = new Uint8ClampedArray(img.data.length);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = lut[d[i]], g = lut[d[i + 1]], bl = lut[d[i + 2]];
    if (s !== 1) {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      r = l + (r - l) * s; g = l + (g - l) * s; bl = l + (bl - l) * s;
    }
    out[i] = clamp255(r + w);
    out[i + 1] = clamp255(g + t);
    out[i + 2] = clamp255(bl - w);
    out[i + 3] = d[i + 3];
  }
  return makeImage(img.width, img.height, out);
}

// 3x3 color matrices (row-major) for the one-tap looks.
const LOOKS = {
  none: null,
  mono: [0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722],
  sepia: [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131],
  invert: "invert",
  vivid: { saturation: 45, contrast: 15 },
  warm: { warmth: 40, saturation: 10 },
  cool: { warmth: -40, tint: -5 },
  fade: { contrast: -30, brightness: 8, saturation: -25 },
  noir: { mono: true, contrast: 45 },
  vintage: { sepiaMix: 0.55, contrast: -10, brightness: 5 },
};
export const LOOK_NAMES = Object.keys(LOOKS);

function matrix(img, m, mix = 1) {
  const d = img.data, out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const nr = m[0] * r + m[1] * g + m[2] * b;
    const ng = m[3] * r + m[4] * g + m[5] * b;
    const nb = m[6] * r + m[7] * g + m[8] * b;
    out[i] = r + (nr - r) * mix;
    out[i + 1] = g + (ng - g) * mix;
    out[i + 2] = b + (nb - b) * mix;
    out[i + 3] = d[i + 3];
  }
  return makeImage(img.width, img.height, out);
}

export function look(img, name) {
  const l = LOOKS[name];
  if (!l) return cloneImage(img);
  if (l === "invert") {
    const out = cloneImage(img), d = out.data;
    for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
    return out;
  }
  if (Array.isArray(l)) return matrix(img, l);
  let base = img;
  if (l.mono) base = matrix(base, LOOKS.mono);
  if (l.sepiaMix) base = matrix(base, LOOKS.sepia, l.sepiaMix);
  return adjust(base, l);
}

/** Fast approximate gaussian blur: three separable box-blur passes. */
export function blur(img, radius) {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return cloneImage(img);
  const { width: w, height: h } = img;
  let src = new Float32Array(img.data);
  let tmp = new Float32Array(src.length);
  // Box sizes approximating a gaussian with sigma ~ radius/2.
  const boxes = boxesForGauss(r / 2 + 0.5, 3);
  for (const bs of boxes) {
    const br = (bs - 1) >> 1;
    boxPass(src, tmp, w, h, br, true);
    boxPass(tmp, src, w, h, br, false);
  }
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i];
  return makeImage(w, h, out);
}

function boxesForGauss(sigma, n) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

// Running-sum box blur along rows (horizontal) or columns, edge-clamped.
// Alpha-weighted so transparent pixels don't bleed dark fringes.
function boxPass(src, dst, w, h, r, horizontal) {
  if (r <= 0) { dst.set(src); return; }
  const len = horizontal ? w : h, lines = horizontal ? h : w;
  const step = horizontal ? 4 : w * 4;
  const inv = 1 / (2 * r + 1);
  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * w * 4 : line * 4;
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const idx = Math.min(len - 1, Math.max(0, k));
        acc += src[base + idx * step + c];
      }
      for (let i = 0; i < len; i++) {
        dst[base + i * step + c] = acc * inv;
        const addIdx = Math.min(len - 1, i + r + 1);
        const subIdx = Math.max(0, i - r);
        acc += src[base + addIdx * step + c] - src[base + subIdx * step + c];
      }
    }
  }
}

/** Unsharp mask. amount 0..100. */
export function sharpen(img, amount, radius = 1.5) {
  if (!amount) return cloneImage(img);
  const soft = blur(img, radius * 2);
  const k = amount / 50;
  const d = img.data, s = soft.data, out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) {
    out[i] = d[i] + (d[i] - s[i]) * k;
    out[i + 1] = d[i + 1] + (d[i + 1] - s[i + 1]) * k;
    out[i + 2] = d[i + 2] + (d[i + 2] - s[i + 2]) * k;
    out[i + 3] = d[i + 3];
  }
  return makeImage(img.width, img.height, out);
}

/** Pixelate a rectangle in place (mutates img). */
export function pixelateRect(img, x, y, w, h, block) {
  const { width: W, height: H, data: d } = img;
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(W, Math.ceil(x + w)), y1 = Math.min(H, Math.ceil(y + h));
  block = Math.max(2, Math.round(block));
  for (let by = y0; by < y1; by += block) {
    for (let bx = x0; bx < x1; bx += block) {
      const ex = Math.min(x1, bx + block), ey = Math.min(y1, by + block);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = by; yy < ey; yy++) for (let xx = bx; xx < ex; xx++) {
        const i = (yy * W + xx) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; n++;
      }
      r /= n; g /= n; b /= n; a /= n;
      for (let yy = by; yy < ey; yy++) for (let xx = bx; xx < ex; xx++) {
        const i = (yy * W + xx) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
      }
    }
  }
  return img;
}

/** Copy a sub-rectangle out of an image. */
export function crop(img, x, y, w, h) {
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  const out = makeImage(w, h);
  for (let row = 0; row < h; row++) {
    const sy = y + row;
    if (sy < 0 || sy >= img.height) continue;
    for (let col = 0; col < w; col++) {
      const sx = x + col;
      if (sx < 0 || sx >= img.width) continue;
      const si = (sy * img.width + sx) * 4, di = (row * w + col) * 4;
      out.data[di] = img.data[si]; out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2]; out.data[di + 3] = img.data[si + 3];
    }
  }
  return out;
}

/** Blur a blurred copy into a rectangle (redaction). Mutates img. */
export function blurRect(img, x, y, w, h, radius) {
  const pad = Math.ceil(radius * 2);
  const rx = Math.max(0, Math.floor(x) - pad), ry = Math.max(0, Math.floor(y) - pad);
  const rw = Math.min(img.width, Math.ceil(x + w) + pad) - rx;
  const rh = Math.min(img.height, Math.ceil(y + h) + pad) - ry;
  if (rw <= 0 || rh <= 0) return img;
  const b = blur(crop(img, rx, ry, rw, rh), radius);
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(img.width, Math.ceil(x + w)), y1 = Math.min(img.height, Math.ceil(y + h));
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
    const si = ((yy - ry) * rw + (xx - rx)) * 4, di = (yy * img.width + xx) * 4;
    img.data[di] = b.data[si]; img.data[di + 1] = b.data[si + 1];
    img.data[di + 2] = b.data[si + 2]; img.data[di + 3] = b.data[si + 3];
  }
  return img;
}

/**
 * Turn a raw model output (any range) into an 8-bit alpha mask:
 * min-max normalize, then a gentle contrast curve to firm up soft edges.
 */
export function normalizeMask(values, lo = 0.06, hi = 0.94) {
  let mn = Infinity, mx = -Infinity;
  for (const v of values) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const range = mx - mn || 1;
  const out = new Uint8ClampedArray(values.length);
  for (let i = 0; i < values.length; i++) {
    const n = (values[i] - mn) / range;
    out[i] = Math.round(Math.min(1, Math.max(0, (n - lo) / (hi - lo))) * 255);
  }
  return out;
}

/** Multiply an image's alpha by a same-sized 8-bit mask. */
export function applyAlpha(img, mask) {
  const out = cloneImage(img);
  for (let i = 0, p = 3; i < mask.length; i++, p += 4) out.data[p] = (out.data[p] * mask[i]) / 255;
  return out;
}

/** Preprocess RGBA pixels (already at model size) into a CHW float tensor for U^2-Net. */
export function u2netInput(rgba, size) {
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  let mx = 1;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] > mx) mx = rgba[i];
    if (rgba[i + 1] > mx) mx = rgba[i + 1];
    if (rgba[i + 2] > mx) mx = rgba[i + 2];
  }
  const plane = size * size, t = new Float32Array(3 * plane);
  for (let p = 0, i = 0; p < plane; p++, i += 4) {
    for (let c = 0; c < 3; c++) t[c * plane + p] = (rgba[i + c] / mx - mean[c]) / std[c];
  }
  return t;
}

/**
 * Largest axis-aligned rectangle with the image's aspect ratio that fits
 * inside a w x h image rotated by `angle` radians. Used by "straighten".
 */
export function rotatedCropSize(w, h, angle) {
  const a = Math.abs(angle) % Math.PI;
  const sin = Math.abs(Math.sin(a)), cos = Math.abs(Math.cos(a));
  const scale = Math.min(w / (w * cos + h * sin), h / (w * sin + h * cos));
  return { width: Math.floor(w * scale), height: Math.floor(h * scale) };
}

/** Fit (w,h) into a max box keeping aspect. */
export function fitSize(w, h, maxW, maxH) {
  const s = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/**
 * Aliased round tip of diameter d (pixel-art style, like Photoshop's pencil):
 * one [start, end) column span per row. A pixel is in if its centre lies
 * within the circle; the radius is trimmed a hair so 3 px is a plus, not a block.
 */
export function circleSpans(d) {
  d = Math.max(1, Math.round(d));
  const c = d / 2, r2 = (c - 0.1) ** 2, spans = [];
  for (let y = 0; y < d; y++) {
    const dy = y + 0.5 - c, half = Math.sqrt(Math.max(0, r2 - dy * dy));
    const a = Math.max(0, Math.ceil(c - half - 0.5));
    spans.push([a, d - a]);
  }
  return spans;
}

/** Human-readable byte size. */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Paint-bucket region: 255 where a pixel matches the color at (sx, sy) within
 * `tolerance` (0..100, per channel incl. alpha). Contiguous mode uses a
 * scanline flood fill; otherwise every matching pixel in the image is taken.
 * Fully transparent pixels match each other regardless of their hidden RGB.
 */
export function floodMask(img, sx, sy, tolerance = 0, contiguous = true) {
  const { width: w, height: h, data: d } = img;
  const mask = new Uint8Array(w * h);
  sx = Math.floor(sx); sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
  const i0 = (sy * w + sx) * 4;
  const r0 = d[i0], g0 = d[i0 + 1], b0 = d[i0 + 2], a0 = d[i0 + 3];
  const tol = tolerance * 2.55;
  const match = (p) => {
    const i = p * 4;
    if (a0 === 0 && d[i + 3] === 0) return true;
    return Math.abs(d[i] - r0) <= tol && Math.abs(d[i + 1] - g0) <= tol &&
      Math.abs(d[i + 2] - b0) <= tol && Math.abs(d[i + 3] - a0) <= tol;
  };
  if (!contiguous) {
    for (let p = 0; p < w * h; p++) if (match(p)) mask[p] = 255;
    return mask;
  }
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop();
    let x = stack.pop();
    let p = y * w + x;
    while (x >= 0 && !mask[p] && match(p)) { x--; p--; }
    x++; p++;
    let up = false, down = false;
    while (x < w && !mask[p] && match(p)) {
      mask[p] = 255;
      if (y > 0) {
        const q = p - w;
        if (!mask[q] && match(q)) { if (!up) { stack.push(x, y - 1); up = true; } } else up = false;
      }
      if (y < h - 1) {
        const q = p + w;
        if (!mask[q] && match(q)) { if (!down) { stack.push(x, y + 1); down = true; } } else down = false;
      }
      x++; p++;
    }
  }
  return mask;
}

/** Bounding box of pixels with alpha > threshold, or null if empty. */
export function alphaBounds(img, threshold = 0) {
  const { width: w, height: h, data: d } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Parse #rgb / #rrggbb into [r, g, b]. */
export function hexToRgb(hex) {
  let s = hex.replace("#", "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

/**
 * Trace the edges of a selection mask into closed loops for the marching
 * ants. `data` holds one value per pixel at data[(y*w+x)*stride+offset]; a
 * pixel is selected when its value is >= 128. Returns an array of loops, each
 * a flat [x0, y0, x1, y1, ...] list of corner points on the pixel grid.
 */
export function maskOutline(data, w, h, stride = 1, offset = 0) {
  const VW = w + 1, dirs = new Uint8Array(VW * (h + 1)); // bits: 1 right, 2 down, 4 left, 8 up
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * stride + offset] >= 128;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!on(x, y)) continue;
      // Edges run clockwise around selected areas.
      if (!on(x, y - 1)) dirs[y * VW + x] |= 1;
      if (!on(x + 1, y)) dirs[y * VW + x + 1] |= 2;
      if (!on(x, y + 1)) dirs[(y + 1) * VW + x + 1] |= 4;
      if (!on(x - 1, y)) dirs[(y + 1) * VW + x] |= 8;
    }
  }
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1], loops = [];
  for (let v = 0; v < dirs.length; v++) {
    while (dirs[v]) {
      const pts = [];
      let x = v % VW, y = (v / VW) | 0, cur = v, d = -1;
      for (;;) {
        const b = dirs[cur];
        if (!b) break;
        let nd = -1;
        if (d < 0) nd = b & 1 ? 0 : b & 2 ? 1 : b & 4 ? 2 : 3;
        else for (const c of [(d + 1) & 3, d, (d + 3) & 3]) if ((b >> c) & 1) { nd = c; break; }
        if (nd < 0) break;
        dirs[cur] &= ~(1 << nd);
        if (nd !== d) pts.push(x, y); // only keep corners
        d = nd; x += DX[d]; y += DY[d]; cur = y * VW + x;
      }
      loops.push(pts);
    }
  }
  return loops;
}

/**
 * Spot healing: fill the `hole` pixels (1 = fill) of RGBA `data` (w × h) with
 * texture from the surrounding known pixels. Patch-based, like Photoshop's
 * spot healing: holes are filled from the edge inwards ("onion peel"); each
 * pixel takes the centre of the best-matching known patch, trying the offsets
 * its already-filled neighbours used (keeps texture coherent) plus random
 * samples. A second pass refines with the whole neighbourhood filled in.
 * Meant for small areas (blemishes, dust, scratches). Mutates and returns data.
 */
export function inpaint(data, w, h, hole, { radius = 3, samples = 40, seed = 1 } = {}) {
  const N = w * h, known = new Uint8Array(N), off = new Int32Array(N * 2);
  let rnd = seed >>> 0 || 1;
  const rand = (n) => { rnd ^= rnd << 13; rnd ^= rnd >>> 17; rnd ^= rnd << 5; return (rnd >>> 0) % n; };
  const src = []; // original known pixels whose whole patch lies inside the image
  for (let i = 0; i < N; i++) {
    known[i] = hole[i] ? 0 : 1;
    const x = i % w, y = (i / w) | 0;
    if (known[i] && x >= radius && y >= radius && x < w - radius && y < h - radius) src.push(i);
  }
  if (!src.length) return data;
  const orig = Uint8Array.from(known); // sources must be original pixels
  // Patch distance between target t and source s over pixels known at t.
  const dist = (t, s, best) => {
    const tx = t % w, ty = (t / w) | 0, sx = s % w, sy = (s / w) | 0;
    let d = 0, n = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const y = ty + dy; if (y < 0 || y >= h) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const x = tx + dx; if (x < 0 || x >= w) continue;
        const q = y * w + x; if (!known[q]) continue;
        const p = ((sy + dy) * w + sx + dx) * 4, o = q * 4;
        const a = data[o] - data[p], b = data[o + 1] - data[p + 1], c = data[o + 2] - data[p + 2], e = data[o + 3] - data[p + 3];
        d += a * a + b * b + c * c + e * e; n++;
        if (d > best * n) return Infinity; // can't win; stop early
      }
    }
    return n ? d / n : Infinity;
  };
  const okSrc = (s, t) => { const x = s % w, y = (s / w) | 0; return s !== t && orig[s] && x >= radius && y >= radius && x < w - radius && y < h - radius; };
  const fillPixel = (t) => {
    const tx = t % w, ty = (t / w) | 0;
    let best = Infinity, bs = -1;
    const tryS = (s) => { if (!okSrc(s, t)) return; const d = dist(t, s, best); if (d < best) { best = d; bs = s; } };
    // Offsets used by already-filled neighbours (coherence).
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = tx + dx, y = ty + dy; if ((!dx && !dy) || x < 0 || y < 0 || x >= w || y >= h) continue;
      const q = y * w + x; if (known[q] && !orig[q]) { const sx = tx + off[q * 2], sy = ty + off[q * 2 + 1]; if (sx >= 0 && sy >= 0 && sx < w && sy < h) tryS(sy * w + sx); }
    }
    if (bs >= 0) { tryS(bs); } // keep current (refine pass)
    for (let k = 0; k < samples; k++) tryS(src[rand(src.length)]);
    if (bs < 0) return;
    const o = t * 4, p = bs * 4;
    data[o] = data[p]; data[o + 1] = data[p + 1]; data[o + 2] = data[p + 2]; data[o + 3] = data[p + 3];
    off[t * 2] = (bs % w) - tx; off[t * 2 + 1] = ((bs / w) | 0) - ty;
    known[t] = 1;
  };
  // Onion peel: hole pixels in order of distance from the known area.
  const order = [];
  let front = [];
  const seen = Uint8Array.from(known);
  for (let i = 0; i < N; i++) if (!known[i]) {
    const x = i % w, y = (i / w) | 0;
    if ((x > 0 && known[i - 1]) || (x < w - 1 && known[i + 1]) || (y > 0 && known[i - w]) || (y < h - 1 && known[i + w])) { front.push(i); seen[i] = 1; }
  }
  while (front.length) {
    order.push(...front);
    const next = [];
    for (const i of front) {
      const x = i % w, y = (i / w) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && !seen[j]) { seen[j] = 1; next.push(j); }
    }
    front = next;
  }
  for (const t of order) fillPixel(t);
  // Refine once, now that every neighbourhood is complete.
  for (let k = order.length - 1; k >= 0; k--) { const t = order[k]; known[t] = 0; fillPixel(t); known[t] = 1; }
  return data;
}
