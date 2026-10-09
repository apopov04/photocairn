// The scripting API's description, argument checking and helpers (js/api-spec.js),
// and that the generated docs are in step with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  METHODS, METHOD, normalize, describe, signature, normColor, dataUrlToBytes,
  resizeDims, clipRect, rotation, resolveLayer, APP_VERSION, API_VERSION, LOOKS, BLENDS,
} from "../js/api-spec.js";
import { outputs } from "../scripts/api-docs.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), "utf8");

test("every method is described, has an example and is implemented", () => {
  const impl = read("js/api.js");
  assert.equal(new Set(METHODS.map((m) => m.name)).size, METHODS.length);
  for (const m of METHODS) {
    assert.ok(m.desc && m.returns && m.group, m.name);
    assert.match(m.example, new RegExp(`photocairn\\.${m.name}\\(`), m.name);
    assert.ok(new RegExp(`\\n    (async )?${m.name}(\\(|,)`).test(impl), `${m.name} is implemented in api.js`);
    for (const p of m.params) {
      assert.ok(p.desc, `${m.name}.${p.name} has a description`);
      if (p.type === "enum") assert.ok(p.values.length, `${m.name}.${p.name} lists its values`);
    }
    for (const n of m.positional || []) assert.ok(m.params.some((p) => p.name === n), `${m.name}: positional ${n}`);
    const d = describe(m);
    assert.equal(JSON.parse(JSON.stringify(d)).name, m.name); // JSON-friendly
  }
});

test("versions", () => {
  assert.equal(API_VERSION, 1);
  assert.equal(APP_VERSION, JSON.parse(read("package.json")).version);
  assert.ok(LOOKS.includes("sepia") && !LOOKS.includes("none"));
  assert.ok(BLENDS.includes("multiply"));
});

test("signatures", () => {
  assert.equal(signature(METHOD.crop), "crop({ x, y, width, height })");
  assert.equal(signature(METHOD.rotate), "rotate(degrees)");
  assert.equal(signature(METHOD.undo), "undo(steps?)");
  assert.equal(signature(METHOD.editText).startsWith("editText(layer, { text?"), true);
});

test("normalize: positional arguments, options objects and defaults", () => {
  assert.deepEqual(normalize("rotate", [90]), { degrees: 90 });
  assert.deepEqual(normalize("rotate", [{ degrees: -90 }]), { degrees: -90 });
  assert.deepEqual(normalize("look", ["Sepia"]), { name: "sepia", strength: 100 });
  assert.deepEqual(normalize("look", ["mono", { strength: 40 }]), { name: "mono", strength: 40 });
  assert.deepEqual(normalize("editText", [2, { text: "hi" }]), { layer: 2, text: "hi" });
  assert.deepEqual(normalize("editText", [{ layer: "Title", size: 30 }]), { layer: "Title", size: 30 });
  assert.deepEqual(normalize("undo", []), { steps: 1 });
  assert.deepEqual(normalize("undo", [3]), { steps: 3 });
  assert.deepEqual(normalize("moveLayer", ["up", { layer: 0 }]), { direction: "up", layer: 0 });
  assert.deepEqual(normalize("deleteLayer", []), {});
  assert.deepEqual(normalize("redact", [{ x: 1, y: 2, width: 3, height: 4 }]), { x: 1, y: 2, width: 3, height: 4, mode: "blur", strength: 60, color: "#000000" });
  assert.deepEqual(normalize("adjust", [{ brightness: 10.4 }]).brightness, 10); // integers are rounded
  assert.deepEqual(normalize("drawShape", [{ type: "line", from: [1, 2], to: { x: 3, y: 4 } }]).from, { x: 1, y: 2 });
  assert.deepEqual(normalize("fillSelection", ["#ABC"]), { color: "#aabbcc" });
  assert.equal(normalize("newImage", [{ width: 10, height: 10, background: "transparent" }]).background, "transparent");
  assert.equal(normalize("removeBackground", [{ background: "blur" }]).background, "blur");
  assert.equal(normalize("addText", [{ text: "a", weight: 400 }]).weight, 400);
});

test("normalize: clear errors", () => {
  const err = (name, args, re) => assert.throws(() => normalize(name, args), re);
  err("crop", [{ x: 1, y: 1, width: 5 }], /crop\(\) needs "height"/);
  err("adjust", [{ brightnes: 5 }], /no option "brightnes".*Options: brightness/);
  err("adjust", [{ brightness: 101 }], /at most 100, got 101/);
  err("resize", [{ width: 0 }], /at least 1/);
  err("flip", ["sideways"], /"horizontal", "vertical"/);
  err("fill", [{ x: 1, y: 1, color: "red" }], /hex color/);
  err("newImage", [{ width: "10", height: 10 }], /must be a number/);
  err("select", [{ type: "polygon", points: [{ x: 1 }] }], /points/);
  err("selectAll", [{ foo: 1 }], /takes no options/);
  err("rotate", [90, {}, 3], /at most 2 arguments/);
  err("open", [42], /File, Blob, data: URL/);
  err("selectLayer", [1.5], /layer index/);
  err("nope", [], /Unknown method/);
});

test("colors", () => {
  assert.equal(normColor("#F80"), "#ff8800");
  assert.equal(normColor(" #12ab9F "), "#12ab9f");
  assert.equal(normColor("#12345"), null);
  assert.equal(normColor("red"), null);
});

test("data URLs are decoded without fetch", () => {
  const b = dataUrlToBytes("data:image/png;base64,iVBORw0KGgo=");
  assert.equal(b.mime, "image/png");
  assert.deepEqual([...b.bytes], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const t = dataUrlToBytes("data:,Hello%2C%20world");
  assert.equal(t.mime, "text/plain");
  assert.equal(new TextDecoder().decode(t.bytes), "Hello, world");
  assert.throws(() => dataUrlToBytes("data:nocomma"), /valid data: URL/);
});

test("resize keeps the aspect ratio when one side is missing", () => {
  assert.deepEqual(resizeDims(4000, 3000, { width: 1080 }), { width: 1080, height: 810 });
  assert.deepEqual(resizeDims(4000, 3000, { height: 300 }), { width: 400, height: 300 });
  assert.deepEqual(resizeDims(4000, 3000, { width: 10, height: 10 }), { width: 10, height: 10 });
  assert.deepEqual(resizeDims(3, 1000, { width: 1 }), { width: 1, height: 333 });
  assert.throws(() => resizeDims(10, 10, {}), /width, height or both/);
});

test("rectangles are clipped to the image", () => {
  assert.deepEqual(clipRect({ x: -10, y: 5.5, width: 50, height: 10 }, 30, 30), { x: 0, y: 5, width: 30, height: 11 });
  assert.deepEqual(clipRect({ x: 0, y: 0, width: 30, height: 30 }, 30, 30), { x: 0, y: 0, width: 30, height: 30 });
  assert.equal(clipRect({ x: 40, y: 0, width: 5, height: 5 }, 30, 30), null);
});

test("rotation angles", () => {
  assert.equal(rotation(0), null);
  assert.equal(rotation(360), null);
  assert.deepEqual(rotation(90), { quarter: 1 });
  assert.deepEqual(rotation(-270), { quarter: 1 });
  assert.deepEqual(rotation(-90), { quarter: -1 });
  assert.deepEqual(rotation(180), { quarter: 2 });
  assert.deepEqual(rotation(15), { free: 15 });
  assert.deepEqual(rotation(-15), { free: -15 });
  assert.deepEqual(rotation(350), { free: -10 });
});

test("layers by index or name", () => {
  const layers = [{ name: "Background" }, { name: "Text: Hi" }, { name: "Dup" }, { name: "Dup" }];
  assert.equal(resolveLayer(layers, undefined, 2), 2);
  assert.equal(resolveLayer(layers, 1, 0), 1);
  assert.equal(resolveLayer(layers, "Text: Hi", 0), 1);
  assert.throws(() => resolveLayer(layers, 4, 0), /0 \(bottom\) to 3 \(top\)/);
  assert.throws(() => resolveLayer(layers, "Nope", 0), /no layer named "Nope"/);
  assert.throws(() => resolveLayer(layers, "Dup", 0), /2 layers are named "Dup".*2, 3/);
});

test("generated docs are up to date (run npm run docs)", () => {
  for (const [file, make] of Object.entries(outputs)) assert.equal(read(file), make(), `${file} is stale: run npm run docs`);
  const full = read("llms-full.txt"), page = read("developers/index.html");
  for (const m of METHODS) {
    assert.ok(full.includes(`#### \`${m.name}(`), `llms-full.txt documents ${m.name}`);
    assert.ok(page.includes(`id="${m.name}"`), `the docs page has #${m.name}`);
  }
  assert.ok(!page.includes("{{"), "no template placeholders left");
});

test("llms.txt lists every method; robots and sitemap point at the docs", () => {
  const llms = read("llms.txt");
  assert.match(llms, /^# Photocairn\n\n> /);
  for (const m of METHODS) assert.ok(new RegExp(`\\b${m.name}\\b`).test(llms), `llms.txt mentions ${m.name}`);
  assert.match(read("robots.txt"), /Sitemap: https:\/\/photocairn\.silicairn\.com\/sitemap\.xml/);
  const sitemap = read("sitemap.xml");
  for (const u of ["/", "/developers/", "/llms.txt"]) assert.ok(sitemap.includes(`<loc>https://photocairn.silicairn.com${u}</loc>`));
  const build = read("build.sh");
  for (const f of ["llms.txt", "llms-full.txt", "robots.txt", "sitemap.xml", "developers"]) assert.ok(build.includes(f), `build.sh copies ${f}`);
});
