// Text layers. A text layer keeps its parameters in layer.meta.text
// ({ text, font, weight, italic, size, color, outline, bg, align, x, y, w })
// and is re-rendered from them whenever it's edited, like Photoshop's text
// layers. (x, y) is the top-left of the text box in document pixels; w is the
// wrapping width, or 0 for a single unwrapped line per paragraph.

import { makeCanvas, layerFromExtent } from "./editor.js";

export const FONTS = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  impact: 'Impact, "Arial Black", "Helvetica Neue", sans-serif',
  hand: '"Comic Sans MS", "Chalkboard SE", "Marker Felt", cursive',
};

export const fontCss = (t) => `${t.italic ? "italic " : ""}${t.weight} ${t.size}px ${FONTS[t.font] || FONTS.sans}`;
export const hasBg = (t) => !!t.bg && t.bg !== "transparent";

/** Break text into lines no wider than `width` (0 = only at newlines). measure(str) gives px. */
export function wrapLines(text, width, measure) {
  const out = [];
  for (const para of text.split("\n")) {
    if (!width) { out.push(para); continue; }
    let line = "";
    const push = () => { out.push(line.trimEnd()); line = ""; };
    // Each token is a word plus the spaces after it.
    for (const tok of para.match(/\s*\S+\s*/g) || [para]) {
      if (line && measure((line + tok).trimEnd()) > width) push();
      if (!line && measure(tok.trimEnd()) > width) {
        for (const ch of tok) { if (line && ch.trim() && measure(line + ch) > width) push(); line += ch; }
      } else line += tok;
    }
    push();
  }
  return out;
}

/** Lines and box size for text params t. */
export function layout(t, measure) {
  const lines = wrapLines(t.text, t.w, measure).map((s) => ({ text: s, width: measure(s) }));
  const lh = t.size * 1.2;
  const w = t.w || Math.max(1, ...lines.map((l) => l.width));
  return { lines, lh, w, h: lines.length * lh };
}

let scratch = null;
/** Layout measured with the browser's canvas text metrics. */
export function measureText(t) {
  scratch ||= makeCanvas(1, 1).getContext("2d");
  scratch.font = fontCss(t);
  return layout(t, (s) => scratch.measureText(s).width);
}

const bgPad = (t) => t.size * 0.35;

/** The text box in document pixels, including the background when there is one. */
export function textBox(t, L = measureText(t)) {
  const p = hasBg(t) ? bgPad(t) : 0;
  return { x: t.x - p, y: t.y - p * 0.6, w: L.w + p * 2, h: L.h + p * 1.2 };
}

/** Draw text params t into ctx (document coordinates). */
export function drawText(ctx, t, L = measureText(t)) {
  if (hasBg(t)) {
    const b = textBox(t, L);
    ctx.fillStyle = t.bg;
    ctx.beginPath(); ctx.roundRect(b.x, b.y, b.w, b.h, bgPad(t) * 0.8); ctx.fill();
  }
  ctx.font = fontCss(t);
  ctx.textBaseline = "middle";
  ctx.textAlign = t.align;
  const lx = t.align === "left" ? t.x : t.align === "right" ? t.x + L.w : t.x + L.w / 2;
  L.lines.forEach((line, i) => {
    const y = t.y + L.lh * (i + 0.5);
    if (t.outline) {
      ctx.lineJoin = "round"; ctx.lineWidth = Math.max(2, t.size / 7);
      ctx.strokeStyle = isLight(t.color) ? "#000" : "#fff";
      ctx.strokeText(line.text, lx, y);
    }
    ctx.fillStyle = t.color;
    ctx.fillText(line.text, lx, y);
  });
}

function isLight(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150;
}

/** Layer props ({ canvas, over }) for text t on a W x H document. Text past the edges is kept in `over`. */
export function renderText(t, W, H) {
  const L = measureText(t), b = textBox(t, L), m = t.size * 0.6; // room for glyph overhang and outline
  const left = Math.floor(Math.min(0, b.x - m)), top = Math.floor(Math.min(0, b.y - m));
  const right = Math.ceil(Math.max(W, b.x + b.w + m)), bottom = Math.ceil(Math.max(H, b.y + b.h + m));
  const c = makeCanvas(right - left, bottom - top), x = c.getContext("2d");
  x.translate(-left, -top);
  drawText(x, t, L);
  return layerFromExtent({ canvas: c, x: -left, y: -top }, W, H);
}

/** Index of the topmost visible text layer under p (document coords), or -1. */
export function textLayerAt(doc, p, tol = 0) {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i], t = l.meta?.text;
    if (!t || !l.visible) continue;
    const b = textBox(t);
    if (p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol) return i;
  }
  return -1;
}

export const layerName = (text) => `Text: ${text.trim().split("\n")[0].slice(0, 24)}`;
