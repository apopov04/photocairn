// Tiny DOM helpers for building tool panels.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

/** Labeled range slider. onInput(value) fires live; onChange(value) on release. */
export function slider({ label, min, max, value = 0, step = 1, format = (v) => v, onInput, onChange }) {
  const out = h("output", {}, format(value));
  const input = h("input", { type: "range", min, max, step, value });
  input.addEventListener("input", () => { out.textContent = format(+input.value); onInput?.(+input.value); });
  input.addEventListener("change", () => onChange?.(+input.value));
  // Double-click a slider to reset it.
  input.addEventListener("dblclick", () => { input.value = value; input.dispatchEvent(new Event("input")); input.dispatchEvent(new Event("change")); });
  const el = h("label", {}, h("span", { class: "lab" }, label, out), input);
  el.input = input;
  el.set = (v) => { input.value = v; out.textContent = format(+v); };
  return el;
}

/** Segmented single-choice buttons. options: [{ value, label, title }] */
export function seg(options, value, onChange) {
  const el = h("div", { class: "seg", role: "radiogroup" });
  const set = (v) => {
    value = v;
    for (const b of el.children) b.classList.toggle("on", b.dataset.v === String(v));
  };
  for (const o of options) {
    el.append(h("button", { "data-v": String(o.value), title: o.title, disabled: o.disabled, onclick: () => { set(o.value); onChange?.(o.value); } }, o.label));
  }
  set(value);
  el.set = set;
  return el;
}

export const PALETTE = ["#ffffff", "#000000", "#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#0a84ff", "#af52de"];

/** Color swatches plus a custom color picker. Optional "transparent" choice. */
export function swatches({ value, onChange, transparent = false, extra = [] }) {
  const el = h("div", { class: "swatches" });
  const picker = h("input", { type: "color", value: /^#[0-9a-f]{6}$/i.test(value) ? value : "#3a6df0", title: "Custom color" });
  const set = (v) => {
    value = v;
    for (const b of el.querySelectorAll(".swatch")) b.classList.toggle("on", b.dataset.v === v);
  };
  const add = (v, title, cls = "") => el.append(h("button", {
    class: `swatch ${cls}`, "data-v": v, title, "aria-label": title,
    style: cls ? "" : `background:${v}`, onclick: () => { set(v); onChange(v); },
  }));
  if (transparent) add("transparent", "Transparent", "transparent");
  for (const x of extra) el.append(x);
  for (const c of PALETTE) add(c, c);
  picker.addEventListener("input", () => { set(picker.value); onChange(picker.value); });
  el.append(picker);
  set(value);
  el.set = set;
  return el;
}

export function progress() {
  const bar = h("i");
  const el = h("div", { class: "progress" }, bar);
  el.set = (p) => { el.classList.toggle("indeterminate", p == null); bar.style.width = p == null ? "" : `${Math.round(p * 100)}%`; };
  return el;
}

export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
