// Photoshop (.psd) import/export via ag-psd (MIT), loaded only when needed.

import { makeCanvas, makeLayer, NO_LOCK } from "./editor.js";

let loading = null;
function loadLib() {
  if (window.agPsd) return Promise.resolve(window.agPsd);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = new URL("../vendor/ag-psd/ag-psd.js", import.meta.url).href;
      s.onload = () => resolve(window.agPsd);
      s.onerror = () => { loading = null; reject(new Error("Couldn't load the PSD reader.")); };
      document.head.append(s);
    });
  }
  return loading;
}

// PSD blend mode keys (as ag-psd names them) <-> canvas composite operations.
const TO_CANVAS = {
  normal: "source-over", "pass through": "source-over", multiply: "multiply", screen: "screen", overlay: "overlay",
  darken: "darken", lighten: "lighten", "color dodge": "color-dodge", "color burn": "color-burn",
  "hard light": "hard-light", "soft light": "soft-light", difference: "difference", exclusion: "exclusion",
  hue: "hue", saturation: "saturation", color: "color", luminosity: "luminosity",
};
const TO_PSD = Object.fromEntries(Object.entries(TO_CANVAS).filter(([k]) => k !== "pass through").map(([k, v]) => [v, k]));

export const isPsd = (blob, name = "") => /\.psd$/i.test(name) || /photoshop|x-psd/i.test(blob.type || "");

/**
 * Read a PSD into Photocairn layers (bottom first). Groups are flattened into
 * their child layers; a hidden group hides its children. Adjustment layers
 * and effects aren't supported (the layer pixels are used as-is).
 */
export async function readPsd(blob) {
  const ag = await loadLib();
  const psd = ag.readPsd(await blob.arrayBuffer(), { skipThumbnail: true });
  const W = psd.width, H = psd.height, layers = [];
  const walk = (nodes, parentHidden, parentOpacity) => {
    for (const n of nodes || []) {
      const hidden = parentHidden || !!n.hidden;
      const opacity = (n.opacity ?? 1) * parentOpacity;
      if (n.children) { walk(n.children, hidden, opacity); continue; }
      if (!n.canvas) continue; // adjustment/fill layers without pixels
      const c = makeCanvas(W, H);
      c.getContext("2d").drawImage(n.canvas, n.left || 0, n.top || 0);
      layers.push(makeLayer(c, n.name || `Layer ${layers.length + 1}`, {
        visible: !hidden, opacity, blend: TO_CANVAS[n.blendMode] || "source-over",
        lock: n.protected ? { alpha: !!n.protected.transparency, pixels: !!n.protected.composite, position: !!n.protected.position, all: false } : NO_LOCK,
      }));
    }
  };
  walk(psd.children, false, 1);
  if (!layers.length && psd.canvas) {
    const c = makeCanvas(W, H);
    c.getContext("2d").drawImage(psd.canvas, 0, 0);
    layers.push(makeLayer(c, "Background"));
  }
  if (!layers.length) throw new Error("This PSD has no readable layers.");
  return { width: W, height: H, layers };
}

/** Write the document as a layered PSD. */
export async function writePsd(doc) {
  const ag = await loadLib();
  const psd = {
    width: doc.width, height: doc.height,
    canvas: doc.composite(),
    children: doc.layers.map((l) => ({
      name: l.name, canvas: l.canvas, left: 0, top: 0,
      opacity: l.opacity, hidden: !l.visible, blendMode: TO_PSD[l.blend] || "normal",
      protected: { transparency: !!l.lock?.alpha, composite: !!(l.lock?.pixels || l.lock?.all), position: !!(l.lock?.position || l.lock?.all) },
    })),
  };
  const buf = ag.writePsd(psd, { generateThumbnail: false });
  return new Blob([buf], { type: "image/vnd.adobe.photoshop" });
}
