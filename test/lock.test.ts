import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLock } from "../src/lock.ts";

const SHA = "a".repeat(40);
const BASE = `name: t\nupstream: https://github.com/o/r\ncommit: ${SHA}\npath: spec.md\nblob: ${SHA}\nir_dir: ir/t\nrequired: false\nsources:\n  - snapshot: s\n`;
const write = (text: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "lock-")), "t.lock.yaml");
  writeFileSync(file, text);
  return file;
};

test("a lock that merges PRs dates their heads and says what it changed beside them", () => {
  const merged = `${BASE}heads_on: "2026-10-26"\nmerge_order:\n  - { pr: 1, head: ${SHA} }\nedits:\n  - "added \`x\` to the example of #1"\n`;
  const lock = loadLock(write(merged));
  assert.equal(lock.heads_on, "2026-10-26");
  assert.deepEqual(lock.edits, ["added `x` to the example of #1"]);
  const plain = loadLock(write(BASE));
  assert.equal(plain.heads_on, null);
  assert.deepEqual(plain.edits, []);
  assert.throws(() => loadLock(write(`${BASE}merge_order:\n  - { pr: 1, head: ${SHA} }\n`)), /needs "heads_on"/);
  assert.throws(() => loadLock(write(`${BASE}heads_on: "2026-10-26"\n`)), /which the lock doesn't have/);
  assert.throws(() => loadLock(write(`${BASE}heads_on: "2026-02-30"\nmerge_order: []\n`)), /calendar date/);
  assert.throws(() => loadLock(write(`${BASE}heads_on: "2026-10-26"\nmerge_order: []\nedits:\n  - ""\n`)), /non-empty strings/);
  assert.throws(() => loadLock(write(`${BASE}edits:\n  - "added a key"\n`)), /merges nothing/);
});
