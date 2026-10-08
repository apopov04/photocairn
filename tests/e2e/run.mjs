// Browser end-to-end runner. Usage:
//   node tests/serve.mjs &        (serves the app on :8080)
//   CHROME=/path/to/chrome node tests/e2e/run.mjs tests/e2e/tools.txt
// Each line of a scenario file is a step: tool:<name>, clicktext:<label>,
// drag:x1:y1:x2:y2 (fractions of the canvas), tap:x:y, path:x1:y1:x2:y2:..., range:<index>:<value>,
// waitfor:<js expr>, eval:<js expr>, key:<combo>, shot:<name>, wait:<ms>,
// addlayer:<image path>, openfile:<path>, select:<css>:<value>, menu:<Menu>:<Item>.
// Set URL= to test a deployed copy.
// Needs `npm i -D puppeteer-core`.
import puppeteer from "puppeteer-core";
import fs from "fs";
const shots = new URL("./shots", import.meta.url).pathname; fs.mkdirSync(shots, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/chromium", headless: true, args: ["--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"], protocolTimeout: 240000 });
const page = await browser.newPage();
fs.mkdirSync(new URL("./downloads", import.meta.url).pathname, { recursive: true });
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: new URL("./downloads", import.meta.url).pathname });
const errors = [];
page.on("console", (m) => { if (["error", "warning"].includes(m.type())) errors.push(`[${m.type()}] ${m.text()}`); });
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
page.on("workercreated", (w) => { w.on("console", (m) => errors.push(`[worker ${m.type()}] ${m.text()}`)); });
page.on("error", (e) => errors.push(`[crash] ${e.message}`));
const W = +process.env.W || 1280, H = +process.env.H || 800;
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1, isMobile: W < 700, hasTouch: W < 700 });
await page.goto(process.env.URL || "http://localhost:8080/", { waitUntil: "networkidle0" });
const shot = async (n) => { await new Promise((r) => setTimeout(r, 250)); await page.screenshot({ path: `${shots}/${process.env.P || ""}${n}.png` }); };
await shot("01-welcome");
const img = fs.readFileSync(process.env.IMG || new URL("./sample.jpg", import.meta.url).pathname).toString("base64");
await page.evaluate(async (b64) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await window.__photocairn.open(new Blob([bin], { type: "image/jpeg" }), "test-photo.jpg");
}, img);
await shot("02-opened");
const steps = (process.argv[2] ? fs.readFileSync(process.argv[2], "utf8") : "").split("\n").map((s) => s.trim()).filter(Boolean);
for (const s of steps) { console.error("step", s);
  const [name, ...args] = s.split(":");
  if (name === "tool") {
    await page.evaluate((t) => {
      const b = document.querySelector(`#tools button[data-tool="${t}"]`);
      if (b) b.click();
      else if (t === "layers") document.querySelector('.side-tabs [data-tab="layers"]').click();
      else window.__photocairn.selectTool(t);
    }, args[0]);
    await shot(`tool-${args[0]}`);
  }
  else if (name === "menu") { // menu:<Menu>:<Item>
    await page.evaluate((m, it) => {
      const btn = [...document.querySelectorAll("#menus .menu-btn")].find((b) => b.textContent === m);
      btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      [...document.querySelectorAll(".menu-pop button")].find((b) => b.firstChild.textContent === it).click();
    }, args[0], args.slice(1).join(":"));
  }
  else if (name === "click") { await page.evaluate((sel) => document.querySelector(sel).click(), args.join(":")); }
  else if (name === "clicktext") { await page.evaluate((t) => [...document.querySelectorAll("#side button, dialog button")].find((b) => b.textContent.trim() === t || (b.getAttribute("aria-label") || "").startsWith(t)).click(), args.join(":")); }
  else if (name === "wait") { await new Promise((r) => setTimeout(r, +args[0])); }
  else if (name === "waitfor") { await page.waitForFunction(new Function(`return ${args.join(":")}`), { timeout: 200000, polling: 500 }); }
  else if (name === "range") { await page.evaluate((i, v) => { const r = document.querySelectorAll("#side input[type=range]")[+i]; r.value = v; r.dispatchEvent(new Event("input")); r.dispatchEvent(new Event("change")); }, args[0], args[1]); }
  else if (name === "drag") { // drag:x1:y1:x2:y2 in fractions of the stage
    const r = await page.$eval("#stage-wrap", (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
    const [x1, y1, x2, y2] = args.map(Number);
    await page.mouse.move(r.x + r.w * x1, r.y + r.h * y1); await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(r.x + r.w * (x1 + (x2 - x1) * i / 8), r.y + r.h * (y1 + (y2 - y1) * i / 8));
    await page.mouse.up();
  }
  else if (name === "tap" || name === "path") { // tap:x:y clicks; path:x1:y1:x2:y2:... drags through points
    const r = await page.$eval("#stage-wrap", (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
    const mod = /^[A-Z]/.test(args.at(-1) || "") ? args.pop() : null; // optional held key, e.g. tap:x:y:Shift
    const n = args.map(Number), pts = [];
    for (let i = 0; i < n.length; i += 2) pts.push([r.x + r.w * n[i], r.y + r.h * n[i + 1]]);
    if (mod) await page.keyboard.down(mod);
    await page.mouse.move(...pts[0]); await page.mouse.down();
    for (const [a, b] of pts.slice(1)) await page.mouse.move(a, b, { steps: 6 });
    await page.mouse.up();
    if (mod) await page.keyboard.up(mod);
  }
  else if (name === "addlayer") { await page.evaluate(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); await window.__photocairn.addLayer(new Blob([bin], { type: "image/jpeg" }), "pug.jpg"); }, fs.readFileSync(args[0]).toString("base64")); }
  else if (name === "openfile") { await page.evaluate(async (b64, n) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); await window.__photocairn.open(new Blob([bin]), n); }, fs.readFileSync(args[0]).toString("base64"), args[0].split("/").pop()); }
  else if (name === "select") { await page.evaluate((sel, v) => { const e = document.querySelector(sel); e.value = v; e.dispatchEvent(new Event("change")); }, args[0], args[1]); }
  else if (name === "key") { const ks = args[0].split("+"); for (const k of ks.slice(0, -1)) await page.keyboard.down(k); await page.keyboard.press(ks.at(-1)); for (const k of ks.slice(0, -1).reverse()) await page.keyboard.up(k); }
  else if (name === "shot") { await shot(args[0]); }
  else if (name === "eval") { console.log("eval:", await page.evaluate(new Function(`return (${args.join(":")})`))); }
}
console.log("errors:", errors.length ? errors.join("\n") : "none");
await browser.close();
