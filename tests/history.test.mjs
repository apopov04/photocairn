// History labels, jumping to a step, and trimming, on a fake canvas (only
// sizes matter: the history never looks at pixels).
import { test } from "node:test";
import assert from "node:assert/strict";

class FakeCanvas {
  width = 0; height = 0;
  getContext() { return { drawImage() {}, fillRect() {}, clearRect() {} }; }
}
globalThis.document = { createElement: () => new FakeCanvas() };

const { Doc, makeCanvas, makeLayer } = await import("../js/editor.js");

const newDoc = (w = 10, h = 10) => new Doc(makeCanvas(w, h), "photo");
const labels = (d) => d.history.map((e) => e.label);
const states = (d) => d.history.map((e) => e.state[0]).join("");

test("the first entry is the opened image and steps get labels", () => {
  const d = newDoc();
  assert.deepEqual(d.history, [{ label: "Open", state: "current" }]);
  d.label("Brush").commit(makeCanvas(10, 10));
  d.commit(makeCanvas(10, 10)); // no label, no labeler
  d.labeler = () => "Gradient";
  d.commit(makeCanvas(10, 10));
  d.label("Merge down").change((x) => x.layers.push(makeLayer(makeCanvas(10, 10), "L2")));
  d.setLayerProps(0, { visible: false });
  d.setLayerProps(0, { blend: "multiply" });
  assert.deepEqual(labels(d), ["Open", "Brush", "Edit", "Gradient", "Merge down", "Hide layer", "Blend mode"]);
  assert.equal(states(d), "ppppppc");
  assert.equal(d.historyIndex, 6);
});

test("an explicit label beats the derived and fallback ones", () => {
  const d = newDoc();
  d.labeler = () => "Brush";
  d.label("Show all").setLayerProps(0, { visible: true });
  assert.deepEqual(labels(d), ["Open", "Show all"]);
});

test("an unused label doesn't leak into a later step", async () => {
  const d = newDoc();
  d.label("Delete selection"); // e.g. the commit was refused after labelling
  await Promise.resolve();
  d.commit(makeCanvas(10, 10));
  assert.deepEqual(labels(d), ["Open", "Edit"]);
});

test("undo and redo keep each step's label", () => {
  const d = newDoc();
  for (const l of ["A", "B", "C"]) d.label(l).commit(makeCanvas(10, 10));
  d.undo(); d.undo();
  assert.deepEqual(labels(d), ["Open", "A", "B", "C"]);
  assert.equal(states(d), "pcff");
  assert.equal(d.stateLabel, "A");
  d.redo();
  assert.equal(states(d), "ppcf");
  assert.equal(d.stateLabel, "B");
});

test("goTo jumps several steps with one change notification", () => {
  const d = newDoc();
  const canvases = [d.canvas];
  for (const l of ["A", "B", "C", "D"]) { const c = makeCanvas(10, 10); canvases.push(c); d.label(l).commit(c); }
  let calls = 0;
  d.onChange(() => calls++);

  d.goTo(1);
  assert.equal(calls, 1);
  assert.equal(d.canvas, canvases[1]);
  assert.equal(states(d), "pcfff");
  assert.equal(d.undoStack.length, 1);
  assert.equal(d.redoStack.length, 3);

  d.goTo(4);
  assert.equal(calls, 2);
  assert.equal(d.canvas, canvases[4]);
  assert.equal(states(d), "ppppc");

  d.goTo(0);
  assert.equal(d.canvas, canvases[0]);
  assert.equal(d.stateLabel, "Open");

  d.goTo(0); // already there: nothing happens
  assert.equal(calls, 3);
  d.goTo(99); // clamped to the newest step
  assert.equal(d.canvas, canvases[4]);
});

test("goTo restores layer structure and size", () => {
  const d = newDoc(10, 10);
  d.label("New layer").change((x) => { x.layers.push(makeLayer(makeCanvas(10, 10), "L2")); x.active = 1; });
  d.label("Crop").commitAll(() => makeCanvas(4, 6));
  assert.deepEqual([d.layers.length, d.width, d.height], [2, 4, 6]);
  d.goTo(0);
  assert.deepEqual([d.layers.length, d.width, d.height, d.active], [1, 10, 10, 0]);
  d.goTo(2);
  assert.deepEqual([d.layers.length, d.width, d.height, d.active], [2, 4, 6, 1]);
});

test("a new step after going back drops the redo states", () => {
  const d = newDoc();
  for (const l of ["A", "B", "C"]) d.label(l).commit(makeCanvas(10, 10));
  d.goTo(1);
  d.label("Fill").commit(makeCanvas(10, 10));
  assert.deepEqual(labels(d), ["Open", "A", "Fill"]);
  assert.equal(states(d), "ppc");
});

test("historySeq changes whenever the list does", () => {
  const d = newDoc();
  const seqs = [d.historySeq];
  d.commit(makeCanvas(10, 10)); seqs.push(d.historySeq);
  d.undo(); seqs.push(d.historySeq);
  d.redo(); seqs.push(d.historySeq);
  assert.equal(new Set(seqs).size, seqs.length);
  const s = d.historySeq;
  d.emit(); // e.g. picking another layer
  assert.equal(d.historySeq, s);
});

test("steps dropped by the memory cap are counted", () => {
  // Each 6000 x 6000 canvas counts 144 MB of the 400 MB budget.
  const d = newDoc(6000, 6000);
  for (let i = 1; i <= 6; i++) d.label(`Step ${i}`).commit(makeCanvas(6000, 6000));
  assert.ok(d.trimmed > 0, "some steps were dropped");
  const h = d.history;
  assert.equal(h.length + d.trimmed, 7, "kept + dropped = all states");
  assert.notEqual(h[0].label, "Open");
  assert.equal(h.at(-1).label, "Step 6");
  d.goTo(0);
  assert.equal(d.stateLabel, h[0].label);
});
