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

test("a lock's tag must still name its commit wherever a clone is reachable", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdirSync } = await import("node:fs");
  const { checkSnapshot } = await import("../src/fetch.ts");
  const dir = mkdtempSync(join(tmpdir(), "tag-"));
  const clone = join(dir, "clone");
  mkdirSync(clone);
  const git = (...args: string[]) => execFileSync("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(clone, "spec.md"), "# One\n");
  git("add", "spec.md");
  git("commit", "-q", "-m", "one");
  const one = git("rev-parse", "HEAD");
  git("tag", "v1");
  writeFileSync(join(clone, "spec.md"), "# Two\n");
  git("commit", "-q", "-am", "two");
  const blob = git("rev-parse", `${one}:spec.md`);
  const spec = join(dir, "specs", "x");
  mkdirSync(join(spec, "spec-input", "snapshots", "v1"), { recursive: true });
  writeFileSync(join(spec, "spec-input", "snapshots", "v1", "spec.md"), "# One\n");
  const lock = (tag: string) => {
    const file = join(spec, "spec-input", `${tag}.lock.yaml`);
    writeFileSync(file, `name: v1\nupstream: https://example.invalid/x\ncommit: ${one}\npath: spec.md\nblob: ${blob}\nir_dir: ir\nrequired: true\ntag: ${tag}\nsources:\n  - git: ${clone}\n  - snapshot: spec-input/snapshots/v1\n`);
    return loadLock(file);
  };
  assert.deepEqual(checkSnapshot(lock("v1")).problems, []);
  git("tag", "-f", "v1", "HEAD");
  assert.match(checkSnapshot(lock("v1")).problems.join("\n"), /the tag v1 in .* names [0-9a-f]{40}, not the locked [0-9a-f]{7}/);
  assert.match(checkSnapshot(lock("v2")).problems.join("\n"), /the tag v2 in .* names no commit/);
});
