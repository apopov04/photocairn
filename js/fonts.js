// Fonts, shared by Filecairn and Photocairn: each app's built-in basics (no
// download), the bundled library (50 free fonts hosted on this site, loaded
// when first used), fonts on this computer (Local Font Access, Chrome/Edge
// desktop, with permission) and uploaded .ttf/.otf files (kept in this
// browser's IndexedDB). Includes the font picker. Nothing is fetched from
// other servers. Call configureFonts() once at startup.

const LIB = new URL("../vendor/fonts/library/", import.meta.url).href;

/** The app's built-in fonts: { id: { name, css } }. Filecairn's map to the standard PDF fonts. */
export const BASIC = {
  sans: { name: "Helvetica", css: "Helvetica, Arial, sans-serif" },
  serif: { name: "Times", css: '"Times New Roman", Times, serif' },
  mono: { name: "Courier", css: '"Courier New", Courier, monospace' },
};
let dbName = "filecairn-fonts";
/** Per-app setup: built-in fonts and where uploads are stored. */
export function configureFonts({ basic, db } = {}) {
  if (basic) { for (const k of Object.keys(BASIC)) delete BASIC[k]; Object.assign(BASIC, basic); }
  if (db) dbName = db;
}
export const isBasic = (id) => !id || id in BASIC;

let catalog = null;
const custom = new Map(); // id -> { id, name, category: "local" | "upload", files: { style: () => Promise<ArrayBuffer> } }
const faces = new Map(); // "id:style" -> Promise<boolean>
const listeners = new Set();
export const onFontLoad = (fn) => listeners.add(fn);

/** The bundled library: [{ id, name, category, alias, styles }]. */
export async function library() {
  catalog ??= fetch(LIB + "fonts.json").then((r) => r.json()).catch(() => []);
  return catalog;
}

/** Everything to show in the picker. */
export async function allFonts() {
  await restoreUploads();
  known = [...(await library()), ...custom.values()];
  return known;
}

let known = [];
/** A font's display name (synchronous; uses the last loaded list). */
export function fontName(id) {
  if (isBasic(id)) return (BASIC[id || "sans"] || Object.values(BASIC)[0]).name;
  return known.find((f) => f.id === id)?.name || String(id).replace(/^(local|upload):/, "");
}

const styleKey = (bold, italic) => (bold && italic ? "bolditalic" : bold ? "bold" : italic ? "italic" : "regular");
// The closest style a font actually has.
function pick(styles, bold, italic) {
  for (const k of [styleKey(bold, italic), bold ? "bold" : null, italic ? "italic" : null, "regular"]) if (k && styles.includes(k)) return k;
  return styles[0];
}

/** CSS font-family for a font id (falls back to a generic family while loading). */
export function cssFamily(id) {
  if (isBasic(id)) return (BASIC[id || "sans"] || Object.values(BASIC)[0]).css;
  return `"fc-${id}", Helvetica, Arial, sans-serif`;
}

async function sourceOf(id) {
  const lib = (await library()).find((f) => f.id === id);
  if (lib) return { styles: lib.styles, get: (k) => fetch(`${LIB}${id}/${k}.ttf`).then((r) => { if (!r.ok) throw new Error("font"); return r.arrayBuffer(); }) };
  if (!custom.has(id) && id.startsWith("local:")) await addLocalFonts(true).catch(() => {});
  if (!custom.has(id) && id.startsWith("upload:")) await restoreUploads();
  const c = custom.get(id);
  return c && { styles: Object.keys(c.files), get: (k) => c.files[k]() };
}

/**
 * Make sure a font (in the requested style, or the nearest one) is available
 * to the page's canvases. Listeners are told when it arrives.
 */
export function ensureFont(id, bold = false, italic = false) {
  if (isBasic(id)) return Promise.resolve(true);
  const want = `${id}:${styleKey(bold, italic)}`;
  if (!faces.has(want)) {
    faces.set(want, (async () => {
      const src = await sourceOf(id);
      if (!src) return false;
      const k = pick(src.styles, bold, italic);
      const face = new FontFace(`fc-${id}`, await src.get(k), { weight: k.includes("bold") ? "700" : "400", style: k.includes("italic") ? "italic" : "normal" });
      document.fonts.add(await face.load());
      listeners.forEach((fn) => fn());
      return true;
    })().catch(() => false));
  }
  return faces.get(want);
}

/** The font file bytes to embed in a PDF (nearest available style), or null. */
export async function fontBytes(id, bold, italic) {
  const src = await sourceOf(id);
  if (!src) return null;
  return src.get(pick(src.styles, bold, italic));
}

/* ------------------------------- your own fonts ------------------------------ */

export const canUseLocalFonts = () => "queryLocalFonts" in window;

/** Add the fonts installed on this computer (asks for permission the first time). Returns how many families. */
export async function addLocalFonts(quiet = false) {
  if (!canUseLocalFonts()) return 0;
  if (quiet) { // only if permission was already given; never prompt behind the user's back
    const st = await navigator.permissions?.query({ name: "local-fonts" }).catch(() => null);
    if (st?.state !== "granted") return 0;
  }
  const list = await window.queryLocalFonts();
  const fams = new Map();
  for (const f of list) {
    const st = (f.style || "").toLowerCase(), k = /bold/.test(st) && /(italic|oblique)/.test(st) ? "bolditalic" : /bold/.test(st) ? "bold" : /(italic|oblique)/.test(st) ? "italic" : /^(regular|normal|book|roman)$/.test(st) ? "regular" : null;
    if (!k) continue;
    if (!fams.has(f.family)) fams.set(f.family, {});
    fams.get(f.family)[k] ??= f;
  }
  for (const [family, styles] of fams) {
    if (!styles.regular) continue;
    const files = {};
    for (const [k, fd] of Object.entries(styles)) files[k] = () => fd.blob().then((b) => b.arrayBuffer());
    custom.set(`local:${family}`, { id: `local:${family}`, name: family, category: "local", files });
  }
  return [...custom.values()].filter((c) => c.category === "local").length;
}

// Uploaded fonts live in IndexedDB so they're still there next time.
const DB = () => new Promise((ok, fail) => { const r = indexedDB.open(dbName, 1); r.onupgradeneeded = () => r.result.createObjectStore("fonts", { keyPath: "key" }); r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
let restored = null;
export function restoreUploads() {
  restored ??= DB().then((db) => new Promise((ok) => {
    const req = db.transaction("fonts").objectStore("fonts").getAll();
    req.onsuccess = () => { for (const rec of req.result) register(rec.family, rec.style, rec.data); ok(); };
    req.onerror = () => ok();
  })).catch(() => {});
  return restored;
}
function register(family, style, data) {
  const id = `upload:${family}`, c = custom.get(id) || { id, name: family, category: "upload", files: {} };
  c.files[style] = async () => data;
  custom.set(id, c);
  return id;
}

/** Add an uploaded .ttf/.otf file. "MyFont-BoldItalic.ttf" joins the "MyFont" family as bold italic. Returns the font id. */
export async function addUploadedFont(file) {
  const base = file.name.replace(/\.(ttf|otf)$/i, "");
  const m = base.match(/^(.*?)[-_ ]?(bold ?italic|bolditalic|bold ?oblique|bold|italic|oblique|regular)$/i);
  const family = (m?.[1] || base).trim() || base;
  const s = (m?.[2] || "regular").toLowerCase().replace(/\s/g, "").replace("oblique", "italic");
  const style = s === "boldoblique" ? "bolditalic" : s;
  const data = await file.arrayBuffer();
  await new FontFace("fc-check", data).load(); // rejects files that aren't usable fonts
  const db = await DB().catch(() => null);
  if (db) db.transaction("fonts", "readwrite").objectStore("fonts").put({ key: `${family}:${style}`, family, style, data });
  return register(family, style, data);
}

/* --------------------------------- the picker -------------------------------- */

const GROUPS = [["basic", "Built in"], ["alias", "Like Microsoft & Apple fonts"], ["sans", "Sans serif"], ["serif", "Serif"], ["mono", "Monospace"], ["display", "Display"], ["script", "Handwriting"], ["local", "On this computer"], ["upload", "Uploaded"]];
let pop = null;
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/**
 * Open the font picker next to `anchor` inside `host` (a positioned element).
 * onPick(id) is called with the chosen font id (already loading). toast(msg) for messages.
 */
export async function openFontPicker({ host, anchor, current, onPick, toast = () => {} }) {
  closeFontPicker();
  const fonts = await allFonts();
  const items = [
    ...Object.entries(BASIC).map(([id, b]) => ({ id, name: b.name, group: "basic", css: b.css })),
    ...fonts.map((f) => ({ id: f.id, name: f.name, group: f.alias ? "alias" : f.category, alias: f.alias })),
  ];
  pop = document.createElement("div");
  pop.className = "fpop"; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", "Choose a font");
  pop.innerHTML = `<input type="search" class="fsearch" placeholder="Search fonts (e.g. Calibri, Garamond)" aria-label="Search fonts"><div class="flist"></div>
    <div class="factions">${canUseLocalFonts() ? '<button type="button" data-fa="local">Use fonts on this computer</button>' : ""}<button type="button" data-fa="upload">Upload font file…</button></div>
    <input type="file" class="fupload" accept=".ttf,.otf,font/ttf,font/otf" multiple hidden>`;
  host.append(pop);
  const render = (q = "") => {
    const ql = q.trim().toLowerCase(), match = (it) => !ql || it.name.toLowerCase().includes(ql) || (it.alias || "").toLowerCase().includes(ql);
    pop.querySelector(".flist").innerHTML = GROUPS.map(([g, label]) => {
      const list = items.filter((it) => it.group === g && match(it));
      return list.length ? `<div class="fgroup">${label}</div>` + list.map((it) => `<button type="button" class="fitem${it.id === (current || "sans") ? " on" : ""}" data-font-id="${esc(it.id)}"${it.css ? ` style="font-family:${esc(it.css.replace(/"/g, "'"))}"` : ""}><span>${esc(it.name)}</span>${it.alias ? `<small>like ${esc(it.alias)}</small>` : ""}</button>`).join("") : "";
    }).join("") || `<p class="hint">No fonts match “${esc(q)}”.</p>`;
  };
  render();
  // Place it under the anchor, or above when there's no room.
  const r = anchor.getBoundingClientRect(), hr = host.getBoundingClientRect(), w = Math.min(280, hr.width - 16);
  pop.style.width = `${w}px`; pop.style.left = `${Math.max(8, Math.min(r.left - hr.left, hr.width - w - 8))}px`;
  const below = r.bottom - hr.top + 6, room = hr.height - below - 8;
  if (room > 260) { pop.style.top = `${below}px`; pop.style.maxHeight = `${room}px`; }
  else { pop.style.bottom = `${hr.bottom - r.top + 6}px`; pop.style.maxHeight = `${Math.max(200, r.top - hr.top - 14)}px`; }
  const qi = pop.querySelector(".fsearch");
  qi.addEventListener("input", () => render(qi.value));
  qi.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") closeFontPicker(); });
  pop.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closeFontPicker(); anchor.focus(); } });
  qi.focus();
  // Hovering a font shows its name in that font (downloads just that one).
  pop.addEventListener("pointerover", (e) => {
    const b = e.target.closest("[data-font-id]"); if (!b || b.dataset.preview) return;
    b.dataset.preview = "1";
    if (!isBasic(b.dataset.fontId)) ensureFont(b.dataset.fontId).then((ok) => { if (ok) b.style.fontFamily = cssFamily(b.dataset.fontId).replace(/"/g, "'"); });
  });
  const pick = (id) => { closeFontPicker(); onPick(id); };
  pop.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-font-id]");
    if (b) return pick(b.dataset.fontId);
    const a = e.target.closest("[data-fa]")?.dataset.fa;
    if (a === "local") {
      try { const n = await addLocalFonts(); toast(n ? `Added ${n} font famil${n === 1 ? "y" : "ies"} from this computer.` : "No fonts were shared."); openFontPicker({ host, anchor, current, onPick, toast }); }
      catch { toast("The browser didn't allow access to your fonts."); }
    }
    if (a === "upload") pop.querySelector(".fupload").click();
  });
  pop.querySelector(".fupload").addEventListener("change", async (e) => {
    let last = null, bad = 0;
    for (const f of e.target.files) { try { last = await addUploadedFont(f); } catch { bad++; } }
    if (bad) toast(`${bad} file${bad === 1 ? "" : "s"} couldn't be read as a font (use .ttf or .otf).`);
    if (last) { await allFonts(); toast("Font added. It's kept in this browser for next time."); pick(last); }
  });
}
export function closeFontPicker() { pop?.remove(); pop = null; }
if (typeof globalThis.document?.addEventListener === "function") document.addEventListener("pointerdown", (e) => { if (pop && !pop.contains(e.target) && !e.target.closest("[data-font-picker]")) closeFontPicker(); }, true);
