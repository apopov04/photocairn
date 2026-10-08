// "Photo metadata" dialog: shows everything hidden in a file and downloads a
// copy with the chosen items removed. Works with or without an open image.

import { h } from "./ui.js";
import { formatBytes } from "./ops.js";
import { GROUPS, parseMetadata, cleanMetadata } from "./metadata.js";

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

function pickFile() {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp" });
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

/** Quick check used when a photo is opened: does it carry GPS data? */
export async function hasGps(blob) {
  try { return !!parseMetadata(new Uint8Array(await blob.arrayBuffer())).gps; } catch { return false; }
}

export async function metadataDialog({ file = null, toast }) {
  if (!file) file = await pickFile();
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let meta;
  try { meta = parseMetadata(bytes); }
  catch (err) { toast(err.message, 4500); return; }

  const remove = new Set(meta.items.filter((i) => i.defaultRemove).map((i) => i.id));
  const boxes = new Map(); // id -> checkbox
  const groupBoxes = new Map(); // group -> checkbox
  const urls = [];

  const countOut = h("p", { class: "meta" });
  const sync = () => {
    for (const [id, cb] of boxes) cb.checked = remove.has(id);
    for (const [g, cb] of groupBoxes) {
      const ids = meta.items.filter((i) => i.group === g).map((i) => i.id);
      const n = ids.filter((id) => remove.has(id)).length;
      cb.checked = n === ids.length; cb.indeterminate = n > 0 && n < ids.length;
    }
    countOut.textContent = meta.items.length
      ? `${remove.size} of ${meta.items.length} item${meta.items.length === 1 ? "" : "s"} will be removed.`
      : "";
    dl.disabled = !remove.size;
  };
  const preset = (fn) => { remove.clear(); for (const i of meta.items) if (fn(i)) remove.add(i.id); sync(); };

  const groups = Object.keys(GROUPS).filter((g) => meta.items.some((i) => i.group === g));
  const sections = groups.map((g) => {
    const items = meta.items.filter((i) => i.group === g);
    const gcb = h("input", { type: "checkbox", "aria-label": `Remove all ${GROUPS[g].label}` });
    gcb.onclick = (e) => { e.stopPropagation(); for (const i of items) gcb.checked ? remove.add(i.id) : remove.delete(i.id); sync(); };
    groupBoxes.set(g, gcb);
    const rows = items.map((i) => {
      const cb = h("input", { type: "checkbox", "aria-label": `Remove ${i.name}` });
      cb.onchange = () => { cb.checked ? remove.add(i.id) : remove.delete(i.id); sync(); };
      boxes.set(i.id, cb);
      let extra = null;
      if (i.thumb) {
        const url = URL.createObjectURL(new Blob([i.thumb], { type: "image/jpeg" }));
        urls.push(url);
        extra = h("img", { src: url, alt: "Embedded thumbnail", class: "md-thumb" });
      }
      return h("label", { class: "md-row" }, cb, h("span", { class: "md-name" }, i.name), h("span", { class: "md-val", title: i.value }, i.value), extra);
    });
    return h("details", { class: `md-group ${GROUPS[g].private ? "private" : ""}`, open: GROUPS[g].private || items.length <= 3 },
      h("summary", {}, gcb, h("b", {}, GROUPS[g].label), h("span", { class: "badge" }, String(items.length)), h("span", { class: "md-hint" }, GROUPS[g].hint)),
      ...rows);
  });

  const dl = h("button", { class: "primary" }, "Download cleaned copy");
  const name = file.name || `photo.${EXT[meta.mime]}`;
  dl.onclick = () => {
    try {
      const out = cleanMetadata(bytes, remove);
      const left = parseMetadata(out).items.length;
      const outName = name.replace(/(\.[^.]+)?$/, (m) => `-clean${m || "." + EXT[meta.mime]}`);
      const a = h("a", { href: URL.createObjectURL(new Blob([out], { type: meta.mime })), download: outName });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      toast(`Saved ${outName}: ${formatBytes(bytes.length - out.length)} smaller, ${left} item${left === 1 ? "" : "s"} left. Picture unchanged.`, 5000);
    } catch (err) { toast(`Couldn't clean this file: ${err.message}`, 5000); }
  };

  const gpsBox = meta.gps ? h("div", { class: "md-alert" },
    h("b", {}, "📍 This photo reveals where it was taken"),
    h("span", {}, ` ${meta.gps.lat}, ${meta.gps.lon} · `),
    h("a", { href: `https://www.openstreetmap.org/?mlat=${meta.gps.lat}&mlon=${meta.gps.lon}#map=16/${meta.gps.lat}/${meta.gps.lon}`, target: "_blank", rel: "noopener noreferrer" }, "View on map")) : null;

  const dlg = h("dialog", { class: "wide", "aria-label": "Photo metadata" },
    h("div", { class: "md-head" },
      h("h2", {}, "Photo metadata"),
      h("button", { class: "x", "aria-label": "Close", onclick: () => dlg.close() }, "×")),
    h("p", { class: "meta" }, `${name} · ${meta.format} · ${formatBytes(bytes.length)}`),
    gpsBox,
    meta.items.length
      ? h("div", { class: "md-presets" }, h("span", {}, "Remove:"),
        h("button", { onclick: () => preset((i) => i.defaultRemove) }, "Private info"),
        h("button", { onclick: () => preset(() => true) }, "Everything"),
        h("button", { onclick: () => preset(() => false) }, "Nothing"))
      : h("p", {}, "✓ No metadata found. This file is already clean."),
    h("div", { class: "md-list" }, sections),
    countOut,
    h("p", { class: "note" }, "Only the selected metadata is removed. The picture itself isn't re-compressed. Images you save from the editor never contain metadata."),
    h("div", { class: "md-foot" },
      h("button", { onclick: async () => { const f = await pickFile(); if (f) { dlg.close(); metadataDialog({ file: f, toast }); } } }, "Inspect another file…"),
      dl));
  dlg.addEventListener("close", () => { urls.forEach((u) => URL.revokeObjectURL(u)); dlg.remove(); });
  document.body.append(dlg);
  sync();
  dlg.showModal();
}
