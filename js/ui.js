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

/**
 * Editable number field paired with a range input, like the Text tool's font size.
 * Typing commits on Enter or blur (clamped to min/max, rounded to step) by setting the
 * range and firing its "input" and "change" events, so the range's own listeners do the work.
 * Arrow up/down nudge by one step (Shift: ten steps), Escape reverts. Returns a
 * `<span class="num">` holding the field and the unit; call `.sync()` after setting
 * `range.value` from code. Dragging the range keeps the field in sync on its own.
 */
export function numField(range, { unit = "", label } = {}) {
  const num = (k, d) => (range.getAttribute(k) === null || range.getAttribute(k) === "" ? d : +range.getAttribute(k));
  const min = num("min", 0), max = num("max", 100), step = num("step", 1);
  const decimals = (String(step).split(".")[1] || "").length;
  const field = h("input", {
    type: "number", class: "numf", min, max, step, value: range.value,
    // iOS's decimal keypad has no minus key, so fields that go negative get the default keyboard.
    inputmode: min < 0 ? null : "decimal",
    "aria-label": label ? `${label}${unit ? ` (${unit})` : ""}` : null,
    enterkeyhint: "done", autocomplete: "off",
  });
  const fit = (v) => {
    v = Math.min(max, Math.max(min, v));
    v = min + Math.round((v - min) / step) * step;
    return +Math.min(max, v).toFixed(decimals);
  };
  const sync = () => { field.value = String(+range.value); };
  const commit = (v) => {
    if (!Number.isFinite(v)) { sync(); return; }
    v = fit(v);
    field.value = String(v);
    if (v === +range.value) return;
    range.value = v;
    range.dispatchEvent(new Event("input", { bubbles: true }));
    range.dispatchEvent(new Event("change", { bubbles: true }));
    sync(); // a listener may have refused or adjusted the value (e.g. a locked layer)
  };
  const typed = () => (field.value.trim() === "" ? NaN : +field.value);
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(typed()); field.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); sync(); field.blur(); }
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const base = Number.isFinite(typed()) ? typed() : +range.value;
      commit(base + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
    }
  });
  field.addEventListener("blur", () => commit(typed()));
  field.addEventListener("focus", () => field.select());
  // No live commits from the mouse wheel over a focused field: scrolling the panel shouldn't edit values.
  field.addEventListener("wheel", () => field.blur(), { passive: true });
  range.addEventListener("input", () => { if (document.activeElement !== field) sync(); });
  const el = h("span", { class: "num" }, field, unit || null);
  el.field = field;
  el.sync = sync;
  return el;
}

/** The unit a slider's format() appends to the number ("%", " px" → "px", "°"), "" for a bare
 *  number, or null when the format isn't "number + suffix" (then the slider keeps a read-only output). */
export function unitOf(format, min, max) {
  let unit = null;
  for (const v of [min, max, (min + max) / 2]) {
    const s = String(format(v)), n = String(v);
    if (!s.startsWith(n) || /^[\d.]/.test(s.slice(n.length))) return null;
    const u = s.slice(n.length).trim();
    if (unit !== null && u !== unit) return null;
    unit = u;
  }
  return unit;
}

/** Labeled range slider with an editable number field. onInput(value) fires live; onChange(value)
 *  on release or when a typed value is committed. `unit` defaults to whatever format() appends. */
export function slider({ label, min, max, value = 0, step = 1, format = (v) => v, unit, onInput, onChange }) {
  const input = h("input", { type: "range", min, max, step, value, "aria-label": label });
  if (unit === undefined) unit = unitOf(format, +min, +max);
  let out, sync;
  if (unit === null) { // non-numeric label: read-only output as before
    out = h("output", {}, format(value));
    sync = () => { out.textContent = format(+input.value); };
  } else {
    out = numField(input, { unit, label });
    sync = out.sync;
  }
  input.addEventListener("input", () => { if (unit === null) sync(); onInput?.(+input.value); });
  input.addEventListener("change", () => onChange?.(+input.value));
  // Double-click a slider to reset it.
  input.addEventListener("dblclick", () => { input.value = value; input.dispatchEvent(new Event("input")); input.dispatchEvent(new Event("change")); });
  const lab = h("span", { class: "lab" }, label, out);
  // Clicking the label text shouldn't jump into the number field (and pop a keyboard on phones).
  lab.addEventListener("click", (e) => { if (e.target.tagName !== "INPUT") e.preventDefault(); });
  const el = h("label", {}, lab, input);
  el.input = input;
  el.field = out.field || null;
  el.set = (v) => { input.value = v; sync(); };
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
