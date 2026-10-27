import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyExceptions, loadExceptions } from "../src/exceptions.ts";
import type { Finding } from "../src/lint.ts";

const finding = (id: string): Finding => ({
  id,
  kind: "unresolved_identifier",
  message: "m",
  subjects: [],
  locs: [],
  details: {},
  disposition: null,
});

function registry(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "op-exc-"));
  const file = join(dir, "exceptions.yaml");
  writeFileSync(file, yaml);
  return file;
}

test("an exception marks its finding with the verdict and reason", () => {
  const file = registry(`exceptions:\n  - { finding: "unresolved_identifier:ETag", verdict: accepted, reason: "HTTP header, not a field." }\n`);
  const findings = [finding("unresolved_identifier:ETag")];
  assert.deepEqual(applyExceptions(findings, loadExceptions(file), "main"), []);
  assert.deepEqual(findings[0]!.disposition, { verdict: "accepted", reason: "HTTP header, not a field." });
});

test("a stale exception is reported, and one scoped to another lock is ignored", () => {
  const file = registry(
    [
      "exceptions:",
      `  - { finding: "unresolved_identifier:Gone", verdict: accepted, reason: "No longer in the spec text." }`,
      `  - { finding: "unresolved_identifier:Other", verdict: accepted, reason: "Only in the other lock.", locks: [other] }`,
    ].join("\n"),
  );
  assert.deepEqual(applyExceptions([], loadExceptions(file), "main"), [
    `stale exception "unresolved_identifier:Gone": lock "main" has no such finding`,
  ]);
});

test("verdicts are a fixed vocabulary, and a reason is required", () => {
  assert.throws(
    () => loadExceptions(registry(`exceptions:\n  - { finding: x, verdict: ignore, reason: "Twelve chars at least." }\n`)),
    /verdict "ignore"; use one of accepted, false_positive, mapping, feedback/,
  );
  assert.throws(() => loadExceptions(registry(`exceptions:\n  - { finding: x, verdict: accepted, reason: "short" }\n`)), /reason of at least 12/);
  assert.throws(() => loadExceptions(registry(`exceptions:\n  - { finding: x, verdict: accepted, reason: "Long enough here.", why: y }\n`)), /unknown key "why"/);
});

test("two entries for one finding are reported", () => {
  const file = registry(
    [
      "exceptions:",
      `  - { finding: "f", verdict: accepted, reason: "First entry for it." }`,
      `  - { finding: "f", verdict: mapping, reason: "Second entry for it." }`,
    ].join("\n"),
  );
  assert.deepEqual(applyExceptions([finding("f")], loadExceptions(file), "main"), [`duplicate exception for "f"`]);
});
