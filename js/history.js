// The History panel (one row per undo step, click to jump back or forward)
// and the resizable right sidebar: tool options, History and Layers stacked
// with drag handles between them.

import { h } from "./ui.js";

/** History panel. getDoc() returns the open document. */
export function historyPanel(getDoc) {
  const list = h("ol", { class: "history", "aria-label": "History, oldest first" });
  const el = h("div", { class: "history-panel" }, h("div", { class: "dock-head" }, h("h2", {}, "History")), list);
  let shown = null, shownSeq = -1;

  list.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]"), d = getDoc();
    if (b && d) d.goTo(+b.dataset.i);
  });

  /** Rebuild the list if the document's steps changed (or always, with force). */
  function render(force = false) {
    const d = getDoc();
    if (!d || (!force && d === shown && d.historySeq === shownSeq)) return;
    shown = d; shownSeq = d.historySeq;
    const rows = [];
    if (d.trimmed) rows.push(h("li", { class: "trimmed" }, `${d.trimmed} older step${d.trimmed === 1 ? "" : "s"} dropped to save memory`));
    d.history.forEach((it, i) => {
      const first = i === 0 && !d.trimmed;
      rows.push(h("li", {}, h("button", {
        type: "button", "data-i": i, class: `hrow ${it.state}`, "aria-current": it.state === "current" ? "step" : null,
        title: it.state === "current" ? "Current state" : it.state === "past" ? "Go back to this step" : "Redo up to this step",
      }, h("span", { class: "hlabel" }, it.label), first && d.origin ? h("span", { class: "hsub" }, d.origin) : null)));
    });
    list.replaceChildren(...rows);
    reveal();
  }
  /** Keep the current step in view without scrolling the page. */
  function reveal() {
    const cur = list.querySelector(".current");
    if (!cur || !list.clientHeight) return;
    const top = cur.offsetTop - list.offsetTop, bottom = top + cur.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }
  new ResizeObserver(reveal).observe(list);
  return { el, render };
}

const STORE = "pc-side-sizes";

/**
 * Drag handles between the stacked sidebar sections. The top section (tool
 * options) takes the remaining space; the History and Layers heights are
 * set in pixels and saved. Double-click a handle to reset its split.
 * sections: [top, middle, bottom]. Minimum heights come from their CSS min-height.
 */
export function resizableStack(sections) {
  const [top, mid, bot] = sections;
  let sizes = {};
  try { sizes = JSON.parse(localStorage.getItem(STORE) || "{}") || {}; } catch { sizes = {}; }
  const apply = () => {
    mid.style.height = sizes.history ? `${sizes.history}px` : "";
    bot.style.height = sizes.layers ? `${sizes.layers}px` : "";
  };
  const save = () => localStorage.setItem(STORE, JSON.stringify(sizes));
  apply();

  const hgt = (el) => el.getBoundingClientRect().height;
  /** Move handle i by dy pixels from the heights captured at the start. */
  function move(i, start, dy) {
    const [t, m, b] = start, mins = sections.map((el) => parseFloat(getComputedStyle(el).minHeight) || 0);
    if (i === 0) {
      sizes.history = Math.round(Math.max(mins[1], Math.min(m - dy, m + t - mins[0])));
    } else {
      const total = m + b;
      sizes.history = Math.round(Math.max(mins[1], Math.min(m + dy, total - mins[2])));
      sizes.layers = Math.round(total - sizes.history);
    }
    apply();
  }

  const handles = [top, mid].map((above, i) => {
    const el = h("div", {
      class: "split", role: "separator", tabindex: 0, "aria-orientation": "horizontal",
      "aria-label": i === 0 ? "Resize tool options and History" : "Resize History and Layers",
      title: "Drag to resize. Double-click to reset",
    });
    above.after(el);
    let drag = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.button) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, y: e.clientY, start: sections.map(hgt) };
      el.classList.add("dragging");
    });
    el.addEventListener("pointermove", (e) => { if (drag?.id === e.pointerId) move(i, drag.start, e.clientY - drag.y); });
    const end = (e) => { if (drag?.id !== e.pointerId) return; drag = null; el.classList.remove("dragging"); save(); };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("dblclick", () => { delete sizes[i === 0 ? "history" : "layers"]; apply(); save(); });
    el.addEventListener("keydown", (e) => {
      const dy = { ArrowUp: -16, ArrowDown: 16 }[e.key];
      if (!dy) return;
      e.preventDefault(); e.stopPropagation(); // not a Move-tool nudge
      move(i, sections.map(hgt), dy);
      save();
    });
    return el;
  });
  return { handles, reset() { sizes = {}; apply(); save(); } };
}
