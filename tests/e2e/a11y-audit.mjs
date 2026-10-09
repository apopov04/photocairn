// Accessibility audit: walks the app through many states (welcome, every tool and
// variant, flyouts, menus, panels, dialogs, phone width) and reads Chrome's real
// accessibility tree (CDP Accessibility.getFullAXTree) in each one. It prints every
// interactive node whose accessible name is missing or poor, and exits non-zero if
// there are any. Usage:
//   PORT=8102 node tests/serve.mjs &
//   CHROME=/path/to/chrome URL=http://localhost:8102/ node tests/e2e/a11y-audit.mjs
// Poor names: empty; only symbols (e.g. "×", "↔"); a bare hex colour; a button inside a
// wrapping <label> that took the label's caption as its name (e.g. "Mode" for "New"); or
// the same name on several controls of one state and group (an agent can't tell them apart).
// Options: SHOTS=<dir> saves a screenshot per state (for before/after pixel checks; transitions,
// animations, the caret and the toast's timer-driven visibility are switched off first so runs are
// repeatable; a few anti-aliased pixels can still vary between identical runs);
// `node a11y-audit.mjs --compare <dirA> <dirB>` compares two such folders pixel by pixel.
// VERBOSE=1 also lists every interactive node with its role and name; STATES=<regex> audits only matching states.
import puppeteer from "puppeteer-core";
import fs from "fs";
import path from "path";

const CHROME = process.env.CHROME || "/usr/bin/chromium";
const launch = () => puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"] });

if (process.argv[2] === "--compare") {
  const [a, b] = process.argv.slice(3);
  const browser = await launch();
  const page = await browser.newPage();
  let bad = 0;
  for (const f of fs.readdirSync(a).filter((f) => f.endsWith(".png")).sort()) {
    if (!fs.existsSync(path.join(b, f))) { console.log(`${f}: missing in ${b}`); bad++; continue; }
    const A = fs.readFileSync(path.join(a, f)), B = fs.readFileSync(path.join(b, f));
    if (A.equals(B)) { console.log(`${f}: identical`); continue; }
    const r = await page.evaluate(async (x, y) => {
      const load = async (s) => { const i = new Image(); i.src = `data:image/png;base64,${s}`; await i.decode(); const c = new OffscreenCanvas(i.width, i.height), g = c.getContext("2d"); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height); };
      const p = await load(x), q = await load(y);
      if (p.width !== q.width || p.height !== q.height) return { size: true };
      let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let i = 0; i < p.data.length; i += 4) {
        if (p.data[i] !== q.data[i] || p.data[i + 1] !== q.data[i + 1] || p.data[i + 2] !== q.data[i + 2] || p.data[i + 3] !== q.data[i + 3]) {
          n++; const px = (i / 4) % p.width, py = Math.floor(i / 4 / p.width);
          x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
        }
      }
      return { n, box: n ? [x0, y0, x1, y1] : null };
    }, A.toString("base64"), B.toString("base64"));
    if (r.size) { console.log(`${f}: different size`); bad++; }
    else if (r.n) { console.log(`${f}: ${r.n} pixels differ in box ${r.box.join(",")}`); bad++; }
    else console.log(`${f}: identical pixels`);
  }
  await browser.close();
  console.log(bad ? `${bad} screenshot(s) differ` : "all screenshots identical");
  process.exit(bad ? 1 : 0);
}

const URL_ = process.env.URL || "http://localhost:8080/";
const SHOTS = process.env.SHOTS || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const img = fs.readFileSync(new URL("./sample.jpg", import.meta.url)).toString("base64");

// Roles an agent would act on. Everything focusable is checked too.
const INTERACTIVE = new Set(["button", "checkbox", "combobox", "slider", "spinbutton", "textbox", "searchbox", "menuitem", "menuitemradio",
  "menuitemcheckbox", "radio", "tab", "link", "switch", "listbox", "option", "PopUpButton", "ColorWell", "separator", "tabpanel", "dialog", "progressbar"]);
const poor = (name) => {
  const n = name.trim();
  if (!n) return "empty name";
  if (!/[\p{L}\p{N}]/u.test(n)) return `symbol-only name "${n}"`;
  if (/^#[0-9a-f]{3,8}$/i.test(n)) return `hex colour as name "${n}"`;
  return null;
};

const browser = await launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
const cdp = await page.createCDPSession();

const results = [];
const ONLY = process.env.STATES ? new RegExp(process.env.STATES) : null;
async function audit(state) {
  if (ONLY && !ONLY.test(state)) return;
  await new Promise((r) => setTimeout(r, 200));
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const found = [], named = [];
  for (const n of nodes) {
    if (n.ignored) continue;
    const role = n.role?.value || "";
    const focusable = n.properties?.some((p) => p.name === "focusable" && p.value.value);
    const isSep = role === "separator";
    if (!(INTERACTIVE.has(role) || focusable) || (isSep && !focusable)) continue;
    if (["RootWebArea", "generic", "none", "StaticText"].includes(role) && !focusable) continue;
    if (role === "RootWebArea") continue;
    const name = n.name?.value ?? "";
    let where = "", own = "", group = "";
    if (n.backendDOMNodeId) {
      try {
        const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: n.backendDOMNodeId });
        const r = await cdp.send("Runtime.callFunctionOn", {
          objectId: object.objectId, returnByValue: true,
          functionDeclaration: `function () {
            const e = this, c = e.closest("[id]");
            const where = (c && c !== e ? "#" + c.id + " " : "") + e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\\s+/).join(".") : "") + (e.dataset && (e.dataset.tool || e.dataset.v || e.dataset.tab) ? "[" + (e.dataset.tool || e.dataset.v || e.dataset.tab) + "]" : "");
            const own = e.tagName === "BUTTON" && e.closest("label") && !e.hasAttribute("aria-label") && !e.hasAttribute("aria-labelledby") ? e.textContent.replace(/\\s+/g, " ").trim() : "";
            const group = e.closest("[role=radiogroup], [role=group], [role=menu], [role=dialog], dialog");
            return { where, own, group: group ? group.getAttribute("aria-label") || group.id || "" : "" };
          }`,
        });
        ({ where, own, group } = r.result.value);
        await cdp.send("Runtime.releaseObject", { objectId: object.objectId });
      } catch { /* node went away */ }
    }
    const value = n.value?.value;
    named.push({ role, name, where, value, group });
    // A button inside a wrapping <label> takes the label's text as its name (e.g. "Mode" for the "New" button).
    const why = poor(name) || (own && !name.replace(/\s+/g, " ").includes(own) ? `name "${name}" doesn't match its text "${own}" (taken from a wrapping <label>?)` : null);
    if (why) found.push({ role, name, where, why });
  }
  // Same name on several controls in one state (history rows may repeat a tool name, so they're exempt).
  const byName = new Map();
  for (const x of named) {
    if (!x.name.trim() || ["tabpanel", "dialog", "separator", "progressbar"].includes(x.role) || x.where.includes("hrow")) continue;
    // Names only need to be unique within their named group (radiogroup, group, menu), e.g. "Text color › White".
    const k = `${x.role}|${x.group}|${x.name.trim().toLowerCase()}`;
    byName.set(k, [...(byName.get(k) || []), x]);
  }
  for (const xs of byName.values()) if (xs.length > 1) for (const x of xs) found.push({ ...x, why: `duplicate name "${x.name}" (${xs.length}×)` });
  results.push({ state, found, total: named.length });
  console.log(`\n== ${state}: ${named.length} interactive, ${found.length} problem(s)`);
  for (const f of found) console.log(`  [${f.role}] ${f.why}  @ ${f.where}`);
  if (process.env.VERBOSE) for (const x of named) console.log(`    ${x.role}: "${x.name}"${x.value != null && x.value !== "" ? ` = ${x.value}` : ""}  @ ${x.where}`);
  if (SHOTS) {
    // Deterministic pixels: no transitions, animations or caret, and no timings in the text.
    await ev(() => {
      if (!document.getElementById("a11y-freeze")) document.head.append(Object.assign(document.createElement("style"), { id: "a11y-freeze", textContent: "*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; } .toast { visibility: hidden !important; }" }));
      for (const e of document.querySelectorAll("#panel .hint")) e.textContent = e.textContent.replace(/Done in [\d.]+s/, "Done in 0.0s");
    });
    await new Promise((r) => setTimeout(r, 150));
    await page.screenshot({ path: path.join(SHOTS, `${state.replace(/[^\w-]+/g, "_")}.png`) });
  }
}

const ev = (fn, ...a) => page.evaluate(fn, ...a);
const openSample = () => ev(async (b64) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await window.__photocairn.open(new Blob([bin], { type: "image/jpeg" }), "test-photo.jpg");
}, img);
const tool = (t) => ev((t) => window.__photocairn.selectTool(t), t);
const blurActive = () => ev(() => document.activeElement?.blur());
const tab = (t) => ev((t) => document.querySelector(`.side-tabs [data-tab="${t}"]`).click(), t);
const flyout = (t) => ev((t) => document.querySelector(`#tools [data-tool="${t}"]`).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })), t);
const closeFloating = () => page.keyboard.press("Escape");
const menu = (m) => ev((m) => [...document.querySelectorAll("#menus .menu-btn")].find((b) => b.textContent === m).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })), m);
const menuItem = (m, it) => ev((m, it) => {
  [...document.querySelectorAll("#menus .menu-btn")].find((b) => b.textContent === m).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  [...document.querySelectorAll(".menu-pop button")].find((b) => b.firstChild.textContent === it).click();
}, m, it);
const closeDialog = () => ev(() => document.querySelector("dialog[open]")?.close());

async function desktop() {
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.goto(URL_, { waitUntil: "networkidle0" });
  await audit("welcome");
  await menuItem("Help", "Keyboard shortcuts"); await audit("dialog-shortcuts"); await closeDialog();
  await menuItem("Help", "About Photocairn"); await audit("dialog-about"); await closeDialog();
  await menuItem("File", "New…"); await audit("dialog-new"); await closeDialog();
  await openSample();
  await audit("opened");
  for (const m of ["File", "Edit", "Image", "Layer", "Select", "Filter", "View", "Help"]) { await menu(m); await audit(`menu-${m}`); await closeFloating(); }
  await menuItem("File", "Metadata: view & remove…"); await new Promise((r) => setTimeout(r, 500)); await audit("dialog-metadata-file"); await closeDialog();
  const variants = {
    select: ["rect", "ellipse", "lasso", "polygon", "wand"], paint: ["brush", "pencil", "pen", "highlighter"],
    fills: ["fill", "gradient"], shapes: ["line", "arrow", "shape-rect", "shape-ellipse"], redact: ["blur", "pixelate", "box"],
  };
  for (const g of Object.keys(variants)) { await tool(variants[g][0]); await flyout(g); await audit(`flyout-${g}`); await closeFloating(); }
  for (const t of ["move", ...variants.select, "crop", ...variants.paint, "eraser", ...variants.fills, "eyedropper", ...variants.shapes, "text",
    "cutout", ...variants.redact, "transform", "adjust", "looks", "resize", "rotate", "frame", "export"]) {
    await tool(t); await blurActive(); await audit(`tool-${t}`);
  }
  await tool("resize"); await ev(() => document.querySelector('#panel .seg [data-v="canvas"]')?.click()); await audit("tool-canvas-size");
  await tool("select"); await ev(() => window.__photocairn.view && document.querySelector("#panel button")?.click()); // Select all
  await audit("tool-select-with-selection");
  // Text: add a text layer and edit it.
  await tool("text"); await ev(() => [...document.querySelectorAll("#panel button")].find((b) => b.textContent === "Add text")?.click());
  await audit("tool-text-editing");
  await ev(() => [...document.querySelectorAll("#panel button")].find((b) => b.textContent === "Done")?.click());
  await ev(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); await window.__photocairn.addLayer(new Blob([bin], { type: "image/jpeg" }), "pug.jpg"); }, img);
  await tool("move"); await tab("layers"); await audit("layers-panel");
  await tab("history"); await audit("history-panel");
  await tab("props");
  // Background removal: the progress bar while it runs, then the after-panel.
  await tool("cutout");
  await ev(() => [...document.querySelectorAll("#panel button")].find((b) => b.textContent === "Remove background").click());
  await page.waitForFunction(() => { const p = document.querySelector("#panel .progress"); return p && !p.hidden; }, { timeout: 30000 }).catch(() => {});
  await audit("tool-cutout-running");
  await page.waitForFunction(() => !!window.__photocairn.doc.meta.subject, { timeout: 200000, polling: 500 });
  await audit("tool-cutout-done");
}

async function phone() {
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.goto(URL_, { waitUntil: "networkidle0" });
  await audit("phone-welcome");
  await openSample();
  await audit("phone-opened");
  await ev(() => document.querySelector("#btn-menu").click()); await audit("phone-menu-sheet"); await closeFloating();
  await tool("brush"); await audit("phone-tool-brush");
  await flyout("paint"); await audit("phone-flyout-paint"); await closeFloating();
  await tab("layers"); await audit("phone-layers");
  await tab("history"); await audit("phone-history");
  await tool("export"); await audit("phone-export");
}

await desktop();
await phone();
await browser.close();

const total = results.reduce((s, r) => s + r.found.length, 0);
const unique = new Set(results.flatMap((r) => r.found.map((f) => `${f.role}|${f.name}|${f.where}|${f.why.split(" (")[0]}`)));
console.log(`\nStates audited: ${results.length}. Problems: ${total} (${unique.size} unique controls).`);
if (errors.length) console.log("page errors:\n" + errors.join("\n"));
process.exit(total || errors.length ? 1 : 0);
