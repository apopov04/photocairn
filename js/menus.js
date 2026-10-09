// Desktop-style menu bar (File, Edit, Image...). On small screens the same
// menus open from a single hamburger button as a full-width sheet.
//
// spec: [{ label, items: [{ label, shortcut?, action, enabled?: () => bool } | "-" ] }]

import { h } from "./ui.js";

/** "Ctrl+Shift+Z" → "Control+Shift+Z" (aria-keyshortcuts syntax). Single keys like "+" or "0" pass through. */
const keyShortcut = (s) => s.split(" / ")[0].replace(/\bCtrl\b/g, "Control").replace("−", "-");

export function buildMenus(bar, toggleBtn, spec) {
  let open = null; // { index, el }

  const close = () => {
    if (!open) return;
    open.el.remove();
    bar.children[open.index]?.classList.remove("open");
    bar.children[open.index]?.setAttribute("aria-expanded", "false");
    bar.children[open.index]?.removeAttribute("aria-controls");
    open = null;
  };

  const itemEls = (menu, done) => menu.items.map((it) => {
    if (it === "-") return h("li", { class: "msep", role: "separator" });
    const enabled = it.enabled ? it.enabled() : true;
    // The shortcut is shown in a <kbd>; assistive tech gets it as aria-keyshortcuts instead of in the name.
    const btn = h("button", {
      role: "menuitem", disabled: !enabled, "aria-label": it.label, "aria-keyshortcuts": it.shortcut ? keyShortcut(it.shortcut) : null,
      onclick: () => { done(); it.action(); },
    }, h("span", {}, it.label), it.shortcut ? h("kbd", {}, it.shortcut) : null);
    return h("li", { role: "none" }, btn);
  });

  const openMenu = (i, focusFirst = false) => {
    close();
    const btn = bar.children[i], r = btn.getBoundingClientRect();
    const el = h("ul", { class: "menu-pop", role: "menu", id: "menu-pop", "aria-labelledby": btn.id, style: `left:${Math.round(r.left)}px;top:${Math.round(r.bottom + 2)}px` }, itemEls(spec[i], close));
    document.body.append(el);
    btn.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-controls", "menu-pop");
    open = { index: i, el };
    if (focusFirst) el.querySelector("button:not(:disabled)")?.focus();
  };

  spec.forEach((menu, i) => {
    const b = h("button", { class: "menu-btn", role: "menuitem", id: `menu-${i}`, "aria-haspopup": "menu", "aria-expanded": "false" }, menu.label);
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); open?.index === i ? close() : openMenu(i); });
    b.addEventListener("pointerenter", () => { if (open && open.index !== i) openMenu(i); });
    b.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") { e.preventDefault(); openMenu(i, true); } });
    bar.append(b);
  });

  // Mobile: one sheet with every menu as a section.
  let sheet = null;
  const closeSheet = () => { sheet?.remove(); sheet = null; toggleBtn.setAttribute("aria-expanded", "false"); };
  toggleBtn.setAttribute("aria-expanded", "false");
  toggleBtn.setAttribute("aria-controls", "menu-sheet");
  toggleBtn.addEventListener("click", () => {
    if (sheet) return closeSheet();
    sheet = h("div", { class: "menu-sheet", role: "menu", id: "menu-sheet", "aria-label": "Menu" },
      spec.map((menu, i) => h("section", { role: "none" }, h("h3", { id: `menu-sheet-${i}`, role: "presentation" }, menu.label),
        h("ul", { role: "group", "aria-labelledby": `menu-sheet-${i}` }, itemEls(menu, closeSheet)))));
    document.body.append(sheet);
    toggleBtn.setAttribute("aria-expanded", "true");
  });

  addEventListener("pointerdown", (e) => {
    if (open && !open.el.contains(e.target) && !bar.contains(e.target)) close();
    if (sheet && !sheet.contains(e.target) && !toggleBtn.contains(e.target)) closeSheet();
  });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (open || sheet)) { close(); closeSheet(); e.stopPropagation(); }
    if (!open) return;
    const items = [...open.el.querySelectorAll("button:not(:disabled)")];
    const idx = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(idx + 1) % items.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); items[(idx - 1 + items.length) % items.length]?.focus(); }
    if (e.key === "ArrowRight") { e.preventDefault(); openMenu((open.index + 1) % spec.length, true); }
    if (e.key === "ArrowLeft") { e.preventDefault(); openMenu((open.index - 1 + spec.length) % spec.length, true); }
  }, true);
  addEventListener("resize", () => { close(); closeSheet(); });
  return { close: () => { close(); closeSheet(); } };
}
