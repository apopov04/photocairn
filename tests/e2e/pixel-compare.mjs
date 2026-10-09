// Compare screenshots of two builds through the same UI states (used to check
// that accessibility-only changes don't alter anything visible).
// Usage: CHROME=... node tests/e2e/pixel-compare.mjs <baseURL> <newURL>
import puppeteer from "puppeteer-core";
import fs from "fs";
const [A, B] = process.argv.slice(2);
const img = fs.readFileSync(new URL("./sample.jpg", import.meta.url)).toString("base64");
const browser = await puppeteer.launch({ executablePath: process.env.CHROME, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
const STILL = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";
async function run(url, w, h) {
  const p = await browser.newPage();
  await p.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: w < 700, hasTouch: w < 700 });
  await p.evaluateOnNewDocument(() => localStorage.clear());
  await p.goto(url, { waitUntil: "networkidle0" });
  await p.addStyleTag({ content: STILL });
  const shots = {};
  const shot = async (n) => { await p.mouse.move(1, 1); await new Promise((r) => setTimeout(r, 400)); shots[n] = await p.screenshot({ encoding: "base64" }); };
  await shot("welcome");
  await p.evaluate(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); await window.__photocairn.open(new Blob([bin], { type: "image/jpeg" }), "t.jpg"); }, img);
  await shot("opened");
  for (const t of ["brush", "fill", "text", "shape-rect", "blur", "adjust", "crop"]) { await p.evaluate((t) => window.__photocairn.selectTool(t), t); await shot(`tool-${t}`); }
  await p.evaluate(() => window.__photocairn.selectTool("select"));
  const btn = await p.$('#tools button[data-tool="select"]');
  if (btn) { const bb = await btn.boundingBox(); await p.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2, { button: "right" }); await new Promise((r) => setTimeout(r, 200)); shots["flyout"] = await p.screenshot({ encoding: "base64" }); await p.keyboard.press("Escape"); }
  await p.close();
  return shots;
}
const cmp = await browser.newPage();
async function diff(a, b) {
  return cmp.evaluate(async (a, b) => {
    const load = (s) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = "data:image/png;base64," + s; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return -1;
    const px = (i) => { const c = new OffscreenCanvas(i.width, i.height), x = c.getContext("2d"); x.drawImage(i, 0, 0); return x.getImageData(0, 0, i.width, i.height).data; };
    const da = px(ia), db = px(ib); let n = 0;
    for (let k = 0; k < da.length; k += 4) if (da[k] !== db[k] || da[k + 1] !== db[k + 1] || da[k + 2] !== db[k + 2]) n++;
    return n;
  }, a, b);
}
let total = 0;
for (const [w, h] of [[1280, 800], [390, 844]]) {
  const sa = await run(A, w, h), sb = await run(B, w, h);
  for (const k of Object.keys(sa)) { const n = sb[k] ? await diff(sa[k], sb[k]) : "missing"; total += n > 0 ? 1 : 0; console.log(`${w}px ${k}: ${n} px differ`); if (n) { fs.writeFileSync(`/tmp/pc-${w}-${k}-a.png`, Buffer.from(sa[k], "base64")); fs.writeFileSync(`/tmp/pc-${w}-${k}-b.png`, Buffer.from(sb[k], "base64")); } }
}
console.log(total ? `${total} state(s) differ` : "identical");
await browser.close();
process.exit(total ? 1 : 0);
