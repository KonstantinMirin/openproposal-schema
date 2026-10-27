// A known-bad input for the npm-test gate: one test that fails.
import { test } from "node:test";
import assert from "node:assert/strict";

test("a failing test", () => {
  assert.equal(1 + 1, 3);
});
