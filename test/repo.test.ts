import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { strayAtRoot } from "../gates/setup.ts";
import { cliSpec } from "../src/builds.ts";
import { checkProfile, loadProfile, reaches, STAGES, stageOf, type Stage } from "../src/profile.ts";
import { loadLock, repoRoot } from "../src/lock.ts";
import { DEFAULT_LOCK, lockFiles, REPO_ROOT, specNames, specRoot } from "../src/repo.ts";
import { ROOT, SPEC } from "./helpers.ts";

test("the repository's root holds specs/, and each spec's folder holds its locks", () => {
  assert.equal(REPO_ROOT, ROOT);
  assert.deepEqual(specNames(), ["adcom", "dealsapi", "openproposal"]);
  assert.equal(specRoot(), SPEC);
  assert.deepEqual(lockFiles(SPEC), [join(SPEC, "spec-input", "spec-lock.yaml"), join(SPEC, "spec-input", "with-open-prs.lock.yaml")], "the default lock first");
  // The default lock comes first even where another lock's name sorts before it.
  const tmp = mkdtempSync(join(tmpdir(), "locks-"));
  mkdirSync(join(tmp, "spec-input"));
  for (const f of ["release-1.lock.yaml", "spec-lock.yaml", "a.lock.yaml", "zz.lock.yaml", "notes.yaml"]) writeFileSync(join(tmp, "spec-input", f), "");
  assert.deepEqual(lockFiles(tmp).map((f) => f.slice(tmp.length + 12)), ["spec-lock.yaml", "a.lock.yaml", "release-1.lock.yaml", "zz.lock.yaml"]);
  assert.equal(DEFAULT_LOCK, join(SPEC, "spec-input", "spec-lock.yaml"));
});

test("a lock's root is its spec's folder, against which its paths resolve", () => {
  for (const f of lockFiles(SPEC)) assert.equal(repoRoot(loadLock(f)), SPEC);
});

test("specNames lists every folder under specs/, a folder without a profile too, which then fails its load", () => {
  const root = mkdtempSync(join(tmpdir(), "specs-"));
  try {
    for (const d of ["b", "a", "notes/spec-input"]) mkdirSync(join(root, "specs", d), { recursive: true });
    for (const d of ["a", "b"]) writeFileSync(join(root, "specs", d, "spec.yaml"), "");
    writeFileSync(join(root, "specs", "README.md"), "");
    assert.deepEqual(specNames(root), ["a", "b", "notes"]);
    assert.throws(() => loadProfile(join(root, "specs", "notes")), /no profile; every spec folder holds a spec\.yaml/);
    assert.deepEqual(specNames(join(root, "none")), [], "no specs/ folder");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a CLI works on the spec its --lock or --spec names, the default spec otherwise, and refuses two different ones", () => {
  assert.equal(cliSpec({}), SPEC);
  assert.equal(cliSpec({ spec: "openproposal" }), SPEC);
  assert.equal(cliSpec({ lock: join(SPEC, "spec-input", "with-open-prs.lock.yaml") }), SPEC);
  assert.equal(cliSpec({ lock: join(SPEC, "spec-input", "spec-lock.yaml"), spec: "openproposal" }), SPEC);
  assert.throws(() => cliSpec({ lock: join(SPEC, "spec-input", "spec-lock.yaml"), spec: "other" }), /--lock names a lock of specs\/openproposal, and --spec names specs\/other/);
});

test("the root's moved folders track nothing, and its format folders only their format schemas", () => {
  assert.deepEqual(strayAtRoot(["mapping/mapping.schema.json", "releases/release.schema.json", "ir/spec-ir.schema.json"]), []);
  assert.deepEqual(strayAtRoot(["schemas/kernel/1/kernel.json", "feedback/comment.md", "mapping/commercial.yaml", "ir/main/spec-ir.json", "releases/main/1.0.0/release.json"]), ["schemas/kernel/1/kernel.json", "feedback/comment.md", "mapping/commercial.yaml", "ir/main/spec-ir.json", "releases/main/1.0.0/release.json"]);
});

test("every relative link in the README and under docs/ names a file of the repository", () => {
  const docs = ["README.md", ...readdirSync(join(ROOT, "docs"), { recursive: true }).map(String).filter((f) => f.endsWith(".md")).map((f) => join("docs", f))];
  const broken: string[] = [];
  for (const doc of docs) {
    for (const m of readFileSync(join(ROOT, doc), "utf8").matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      const target = m[1]!;
      if (/^[a-z]+:/.test(target) || target.startsWith("/")) continue;
      if (!existsSync(join(ROOT, dirname(doc), target))) broken.push(`${doc}: ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

test("a spec still being added holds no file of a stage it hasn't reached, and CI runs its gates through the stage its profile names", () => {
  const adcom = loadProfile(specRoot("adcom"));
  const base = { profile: adcom, text: null, roles: [], findingKinds: [], locks: 2 };
  assert.deepEqual(STAGES, ["input", "extract", "model", "schemas", "outputs"]);
  assert.equal(stageOf({}), "outputs");
  assert.ok(reaches("model", "extract") && !reaches("extract", "model"));
  const at = (through: Exclude<Stage, "outputs">, entries: string[]) => checkProfile({ ...base, profile: { ...adcom, through }, text: { layouts: [], keywords: () => ["MUST"] }, entries }).filter((p) => p.includes("stage writes"));
  assert.deepEqual(at("input", ["spec-input", "spec.yaml", "build"]), []);
  assert.match(at("input", ["ir"]).join("\n"), /says the spec has reached "input", and it holds ir, which the "extract" stage writes/);
  assert.match(at("extract", ["ir", "mapping"]).join("\n"), /holds mapping, which the "model" stage writes/);
  assert.match(at("model", ["ir", "mapping", "rules"]).join("\n"), /holds rules, which the "schemas" stage writes/);
  assert.deepEqual(at("model", ["ir", "mapping", "decisions", "kernel-binding.yaml"]), []);
  assert.match(at("model", ["ir", "mapping", "vectors"]).join("\n"), /holds vectors, which the "schemas" stage writes/);
  // A spec at its schemas holds its schemas, rules, and vectors, and none of its other outputs.
  assert.deepEqual(at("schemas", ["ir", "mapping", "schemas", "rules", "vectors"]), []);
  assert.match(at("schemas", ["ir", "schemas", "corpus"]).join("\n"), /holds corpus, which the "outputs" stage writes/);
  assert.match(at("schemas", ["ir", "schemas", "examples"]).join("\n"), /holds examples, which the "outputs" stage writes/);
  const stray = checkProfile({ ...base, text: { layouts: [], keywords: () => ["MUST"] }, entries: ["spec.yaml", "spec-input", "notes"] });
  assert.match(stray.join("\n"), /the spec's folder holds notes, which no stage of the pipeline writes and no gate reads/);
});
