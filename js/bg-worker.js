// Background-removal worker. Runs a U^2-Net-family model with ONNX Runtime Web
// (WebAssembly) entirely on this device. Models are served by this same site
// and cached locally after the first download; no image ever leaves the browser.

import * as ort from "../vendor/ort/ort.wasm.min.mjs";
import { u2netInput } from "./ops.js";

const SIZE = 320;
const CACHE = "photocairn-models-v1";
const MODELS = {
  fast: { parts: ["u2netp.onnx"], bytes: 4574861 },
  best: { parts: ["silueta.onnx.part0", "silueta.onnx.part1"], bytes: 44173029 },
};

ort.env.wasm.wasmPaths = new URL("../vendor/ort/", import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

const sessions = {};

async function fetchModel(name, onProgress) {
  const { parts, bytes } = MODELS[name];
  const cache = "caches" in self ? await caches.open(CACHE).catch(() => null) : null;
  const buffers = [];
  let loaded = 0;
  for (const part of parts) {
    const url = new URL(`../models/${part}`, import.meta.url).href;
    let res = cache ? await cache.match(url) : null;
    const fromCache = !!res;
    if (!res) {
      res = await fetch(url);
      if (!res.ok) throw new Error(`Couldn't download the model (${res.status}).`);
    }
    const reader = res.clone().body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(Math.min(1, loaded / bytes), fromCache);
    }
    if (cache && !fromCache) await cache.put(url, res).catch(() => {});
    buffers.push(...chunks);
  }
  const all = new Uint8Array(buffers.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of buffers) { all.set(c, off); off += c.length; }
  return all;
}

async function getSession(name, onProgress) {
  if (!sessions[name]) {
    sessions[name] = (async () => {
      const bytes = await fetchModel(name, onProgress);
      return ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
    })();
    sessions[name].catch(() => delete sessions[name]);
  }
  return sessions[name];
}

self.onmessage = async (e) => {
  const { id, bitmap, model } = e.data;
  const post = (msg) => self.postMessage({ id, ...msg });
  try {
    const session = await getSession(model, (p, cached) => post({ type: "progress", stage: cached ? "loading" : "download", progress: p }));
    post({ type: "progress", stage: "thinking", progress: 1 });

    // Resize to the model's input size with smooth (bilinear+) sampling.
    const canvas = new OffscreenCanvas(SIZE, SIZE);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);
    bitmap.close?.();
    const rgba = ctx.getImageData(0, 0, SIZE, SIZE).data;

    const input = new ort.Tensor("float32", u2netInput(rgba, SIZE), [1, 3, SIZE, SIZE]);
    const out = await session.run({ [session.inputNames[0]]: input });
    const mask = out[session.outputNames[0]].data; // 1x1x320x320, first (fused) output
    post({ type: "done", mask: Float32Array.from(mask), size: SIZE });
  } catch (err) {
    post({ type: "error", message: err?.message || String(err) });
  }
};
