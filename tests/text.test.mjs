// Text layout: word wrapping inside a text box. Uses a fake measure (10 px per character).
import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapLines, layout } from "../js/text.js";

const m = (s) => s.length * 10;

test("no width: only breaks at newlines", () => {
  assert.deepEqual(wrapLines("hello world\nbye", 0, m), ["hello world", "bye"]);
});

test("wraps words to fit the box", () => {
  assert.deepEqual(wrapLines("the quick brown fox", 100, m), ["the quick", "brown fox"]);
  assert.deepEqual(wrapLines("the quick brown fox", 60, m), ["the", "quick", "brown", "fox"]);
});

test("trailing spaces don't force a wrap", () => {
  assert.deepEqual(wrapLines("abcd efgh", 40, m), ["abcd", "efgh"]);
});

test("breaks words longer than the box", () => {
  assert.deepEqual(wrapLines("abcdefghij xy", 40, m), ["abcd", "efgh", "ij", "xy"]);
});

test("keeps empty lines and leading spaces", () => {
  assert.deepEqual(wrapLines("a\n\n  b", 100, m), ["a", "", "  b"]);
  assert.deepEqual(wrapLines("", 100, m), [""]);
});

test("layout size: fixed box width or widest line", () => {
  const t = { text: "one two three", size: 20, w: 0 };
  let L = layout(t, m);
  assert.equal(L.w, 130); assert.equal(L.lines.length, 1); assert.equal(L.h, 24);
  L = layout({ ...t, w: 80 }, m);
  assert.equal(L.w, 80); assert.deepEqual(L.lines.map((l) => l.text), ["one two", "three"]); assert.equal(L.h, 48);
});
