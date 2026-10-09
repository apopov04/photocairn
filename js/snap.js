// Snapping for Move and Free transform: line a box up with the canvas edges and
// centre lines, and with the edges and centres of the other visible layers.
// Pure geometry (no DOM) apart from drawGuides, so it's unit-tested in Node.
//
// Targets are { xs, ys }: lists of { v, a, b } where v is the line's position
// on that axis and [a, b] its extent on the other axis (used to draw guides).

/** Snap lines for a set of boxes (canvas first, then layers). */
export function targetsFrom(boxes) {
  const xs = [], ys = [];
  for (const r of boxes) {
    for (const v of [r.x, r.x + r.w / 2, r.x + r.w]) xs.push({ v, a: r.y, b: r.y + r.h });
    for (const v of [r.y, r.y + r.h / 2, r.y + r.h]) ys.push({ v, a: r.x, b: r.x + r.w });
  }
  return { xs, ys };
}

// Closest target to any of the given positions, within tol.
function nearest(positions, lines, tol) {
  let best = null;
  for (const p of positions) {
    for (const t of lines) {
      const d = t.v - p;
      if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, t };
    }
  }
  return best;
}

// Guide for a matched line, spanning both the target and the snapped box.
const guide = (axis, t, lo, hi) => ({ axis, v: t.v, from: Math.min(t.a, lo), to: Math.max(t.b, hi) });

/**
 * Snap a box { x, y, w, h } (its edges and centre) to the targets.
 * Returns the shift to apply { dx, dy } and the guides to draw.
 * axes limits snapping to "x", "y" or both (default).
 */
export function snapBox(box, targets, tol, axes = "xy") {
  let dx = 0, dy = 0;
  const guides = [];
  const sx = axes.includes("x") && nearest([box.x, box.x + box.w / 2, box.x + box.w], targets.xs, tol);
  const sy = axes.includes("y") && nearest([box.y, box.y + box.h / 2, box.y + box.h], targets.ys, tol);
  if (sx) dx = sx.d;
  if (sy) dy = sy.d;
  if (sx) guides.push(guide("x", sx.t, box.y + dy, box.y + dy + box.h));
  if (sy) guides.push(guide("y", sy.t, box.x + dx, box.x + dx + box.w));
  return { dx, dy, guides };
}

/** Snap a single point (e.g. a resize handle) to the targets. */
export function snapPoint(p, targets, tol, axes = "xy") {
  const sx = axes.includes("x") && nearest([p.x], targets.xs, tol);
  const sy = axes.includes("y") && nearest([p.y], targets.ys, tol);
  const x = sx ? sx.t.v : p.x, y = sy ? sy.t.v : p.y;
  const guides = [];
  if (sx) guides.push(guide("x", sx.t, y, y));
  if (sy) guides.push(guide("y", sy.t, x, x));
  return { x, y, guides };
}

/** Draw snap guides (document coordinates) on the screen overlay. */
export function drawGuides(ctx, view, guides) {
  if (!guides?.length) return;
  ctx.save();
  ctx.strokeStyle = "#ff2d95"; // magenta: stands out on photos, like Photoshop's smart guides
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  for (const g of guides) {
    const a = g.axis === "x" ? view.toScreen(g.v, g.from) : view.toScreen(g.from, g.v);
    const b = g.axis === "x" ? view.toScreen(g.v, g.to) : view.toScreen(g.to, g.v);
    const ext = 12; // run a little past the ends so short guides stay visible
    if (g.axis === "x") { const x = Math.round(a.x) + 0.5; ctx.moveTo(x, a.y - ext); ctx.lineTo(x, b.y + ext); }
    else { const y = Math.round(a.y) + 0.5; ctx.moveTo(a.x - ext, y); ctx.lineTo(b.x + ext, y); }
  }
  ctx.stroke();
  ctx.restore();
}
