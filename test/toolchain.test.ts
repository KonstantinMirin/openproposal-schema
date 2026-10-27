import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkToolchain, checkWorkflow, compareVersions, goDirective, parseRequirements, satisfies, toolchainDirective, trackedGoMods, venvPython } from "../src/toolchain.ts";
import { ROOT } from "./helpers.ts";

test("toolchain: a hash-locked requirements file yields its exact pins, markers, and normalized names", () => {
  const text = [
    "#",
    "# pip-compile --generate-hashes",
    "#",
    "jsonschema[format]==4.26.0 \\",
    "    --hash=sha256:abc",
    "    # via -r requirements.in",
    "typing_extensions==4.16.0 ; python_full_version < '3.13' \\",
    "    --hash=sha256:def",
    "",
  ].join("\n");
  assert.deepEqual(parseRequirements(text), [
    { name: "jsonschema", version: "4.26.0", marker: null },
    { name: "typing-extensions", version: "4.16.0", marker: "python_full_version < '3.13'" },
  ]);
  assert.throws(() => parseRequirements("jsonschema>=4 \\\n"), /isn't an exact pin/);
});

test("toolchain: versions compare part by part, and engines ranges read as npm writes them", () => {
  assert.ok(compareVersions("go1.26.8", "1.25") > 0);
  assert.equal(compareVersions("1.25", "1.25.0"), 0);
  assert.ok(compareVersions("v22.13.1", "23") < 0);
  assert.ok(satisfies("22.13.1", ">=22 <23"));
  assert.ok(!satisfies("23.0.0", ">=22 <23"));
  assert.ok(!satisfies("20.11.0", ">=22 <23"));
  assert.ok(satisfies("22", ">=22 <23"));
  assert.throws(() => satisfies("22.0.0", "^22"), /isn't a comparator/);
});

test("toolchain: the venv's Python comes from setup:oracle, and a go.mod's directive is read", () => {
  assert.equal(venvPython("python3.12 -m venv .venv && .venv/bin/pip install"), "3.12");
  assert.throws(() => venvPython("python3 -m venv .venv"), /pinned python3\.x/);
  assert.equal(goDirective("module x\n\ngo 1.25\n"), "1.25");
  assert.throws(() => goDirective("module x\n"), /no go directive/);
});

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const workflow = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

test("toolchain: the committed workflow runs every setup script and the gate script at the pinned versions", () => {
  assert.deepEqual(checkWorkflow(workflow, pkg, trackedGoMods(ROOT)), []);
});

test("toolchain: a workflow that skips a setup script, ends elsewhere, or runs another version fails", () => {
  const mods = trackedGoMods(ROOT);
  const without = workflow.replace(/^\s*- run: npm run setup:plaingen\n/m, "");
  assert.notEqual(without, workflow);
  assert.deepEqual(checkWorkflow(without, pkg, mods), ["the workflow doesn't run: npm run setup:plaingen"]);
  const extra = { ...pkg, scripts: { ...pkg.scripts, "setup:other": "true" } };
  assert.deepEqual(checkWorkflow(workflow, extra, mods), ["the workflow doesn't run: npm run setup:other"]);
  const late = workflow.replace("      - run: npm run ci\n", "      - run: npm run ci\n      - run: echo done\n");
  assert.deepEqual(checkWorkflow(late, pkg, mods), ["the workflow's last step isn't: npm run ci"]);
  assert.match(checkWorkflow(workflow.replace("node-version: 22", "node-version: 24"), pkg, mods).join("; "), /node-version "24" doesn't satisfy/);
  assert.match(checkWorkflow(workflow.replace('python-version: "3.12"', 'python-version: "3.13"'), pkg, mods).join("; "), /python-version "3\.13" isn't 3\.12/);
  assert.match(checkWorkflow(workflow.replace("go-version-file: tools/regexcheck/go.mod", "go-version-file: go.mod"), pkg, mods).join("; "), /isn't a tracked go\.mod/);
  assert.match(checkWorkflow(workflow.replace("npm ci --ignore-scripts", "npm install"), pkg, mods).join("; "), /doesn't install with: npm ci --ignore-scripts/);
});

test("toolchain: a workflow that can skip a step, ignore a failure, or not run on main and pull requests fails", () => {
  const mods = trackedGoMods(ROOT);
  const skipped = workflow.replace("      - run: npm run setup:plaingen\n", "      - if: false\n        run: npm run setup:plaingen\n");
  assert.notEqual(skipped, workflow);
  assert.deepEqual(checkWorkflow(skipped, pkg, mods), ["step 8 (npm run setup:plaingen) carries an if, which can skip it"]);
  const ignored = workflow.replace("      - run: npm run ci\n", "      - run: npm run ci\n        continue-on-error: true\n");
  assert.notEqual(ignored, workflow);
  assert.deepEqual(checkWorkflow(ignored, pkg, mods), ["step 10 (npm run ci) carries continue-on-error, which ignores its failure"]);
  assert.deepEqual(checkWorkflow(workflow.replace("      - run: npm run ci\n", "      - run: npm run ci\n        continue-on-error: false\n"), pkg, mods), []);
  const job = workflow.replace("    runs-on: ubuntu-latest\n", "    runs-on: ubuntu-latest\n    if: github.event_name == 'push'\n    continue-on-error: true\n");
  assert.notEqual(job, workflow);
  assert.deepEqual(checkWorkflow(job, pkg, mods), ['the job "gates" carries an if, which can skip it', 'the job "gates" carries continue-on-error, which ignores its failure']);
  assert.deepEqual(checkWorkflow(workflow.replace("    branches: [main]\n", "    branches: [dev]\n"), pkg, mods), ["the workflow doesn't run on a push to main"]);
  assert.deepEqual(checkWorkflow(workflow.replace("  pull_request:\n", "  pull_request:\n    paths: [src/**]\n"), pkg, mods), ["the workflow doesn't run on every pull request"]);
  assert.deepEqual(checkWorkflow(workflow.replace("  pull_request:\n", ""), pkg, mods), ["the workflow doesn't run on every pull request"]);
});

test("toolchain: a workflow that names no base for the gate decisions, or doesn't fetch it before the gate script, fails", () => {
  const mods = trackedGoMods(ROOT);
  const unnamed = workflow.replace(/^ {6}GATE_BASE: .*\n/m, "");
  assert.notEqual(unnamed, workflow);
  assert.match(checkWorkflow(unnamed, pkg, mods).join("; "), /the job doesn't set GATE_BASE/);
  const other = workflow.replace("github.event.pull_request.base.sha || github.event.before", "github.sha");
  assert.match(checkWorkflow(other, pkg, mods).join("; "), /the job doesn't set GATE_BASE/);
  const unfetched = workflow.replace(/^ {6}- run: git fetch .*\n/m, "");
  assert.notEqual(unfetched, workflow);
  assert.deepEqual(checkWorkflow(unfetched, pkg, mods), ['the workflow doesn\'t fetch the base before the gate script: git fetch --no-tags --depth=1 origin "$GATE_BASE"']);
  const skipped = workflow.replace("      - run: git fetch", "      - if: false\n        run: git fetch");
  assert.match(checkWorkflow(skipped, pkg, mods).join("; "), /\(git fetch [^)]*\) carries an if/);
});

test("toolchain: Go is pinned exactly by a toolchain directive, and setup-go reads it", () => {
  assert.equal(toolchainDirective("module x\n\ngo 1.25\n\ntoolchain go1.26.8\n"), "go1.26.8");
  assert.equal(toolchainDirective("module x\n\ngo 1.25\n"), null);
  const mods = trackedGoMods(ROOT);
  const file = /go-version-file: (\S+)/.exec(workflow)![1]!;
  assert.notEqual(toolchainDirective(mods[file]!), null, `${file} pins the toolchain`);
  const unpinned = { ...mods, [file]: mods[file]!.replace(/^toolchain .*\n/m, "") };
  assert.match(checkWorkflow(workflow, pkg, unpinned).join("; "), /has no toolchain directive/);
});

test("toolchain: this machine runs the pinned toolchain", () => {
  const r = checkToolchain(ROOT);
  assert.deepEqual(r.problems, []);
  assert.match(r.note, /^Node 22\./);
});
