import assert from "node:assert/strict";
import test from "node:test";
import { clamp } from "../src/clamp.js";

test("keeps values inside the range unchanged", () => {
  assert.equal(clamp(5, 0, 10), 5);
});

test("raises values below the minimum", () => {
  assert.equal(clamp(-3, 0, 10), 0);
});

test("lowers values above the maximum", () => {
  assert.equal(clamp(14, 0, 10), 10);
});
