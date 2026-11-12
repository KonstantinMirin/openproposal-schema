import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { stringify } from "yaml";
import { constructorEditionsOn, kernelEditionsOn } from "../src/editions.ts";
import { loadConstructors } from "../src/constructors.ts";
import { checkDeskTests, deskSdks, deskTestFiles, loadDeskPayloads, loadDeskTests, runDeskChecker, runDeskSdks, type CheckerRun, type DeskTests } from "../src/desk-tests.ts";
import { emitSchemas, schemaDirOf } from "../src/emit.ts";
import { findingsGo, findingsPython, findingsTypeScript, locationsOf, pointerIn } from "../src/sdk-parity.ts";
import { checkExamples } from "../src/examples.ts";
import type { SpecIR } from "../src/ir-types.ts";
import { loadKernel } from "../src/kernel.ts";
import { loadLock } from "../src/lock.ts";
import { loadDecisions, loadMappings } from "../src/mapping.ts";
import { resolveModel } from "../src/model.ts";
import { codesOf } from "../src/rule-checks.ts";
import { deskTests } from "../gates/checks.ts";
import { OP_SCHEMA, ROOT, RULE_CHECKS, SPEC } from "./helpers.ts";

const LOCK = "with-our-stack";
const IR_DIR = join("ir", LOCK);
const KERNEL = loadKernel(ROOT, SPEC);
const MODEL = resolveModel({
  ir: JSON.parse(readFileSync(join(SPEC, IR_DIR, "spec-ir.json"), "utf8")) as SpecIR,
  lock: LOCK,
  mappings: loadMappings(join(SPEC, "mapping")),
  decisions: loadDecisions(join(SPEC, "decisions")),
  kernel: kernelEditionsOn(KERNEL, LOCK),
  constructors: constructorEditionsOn(loadConstructors(ROOT, SPEC), LOCK),
}).model;
const SCHEMA_DIR = schemaDirOf(IR_DIR);
const FILES = emitSchemas(MODEL, SCHEMA_DIR, OP_SCHEMA).files;
const IAB = join(SPEC, "desk-tests", "iab-au-2026-11");
const SDKS = deskSdks(join(ROOT, "sdk", "proposed", LOCK));

test("an SDK's path becomes the JSON pointer of the deepest place of the payload it names", () => {
  const value = { committed_metrics: [{ metric: "impressions" }, { metric: "plays" }], "a/b": { "~": 1 }, m: { "0": true } };
  // Pydantic names a union's branch after the member; the finding stays at the union.
  assert.equal(pointerIn(value, ["committed_metrics", 1, "metric", "constrained-str"]), "/committed_metrics/1/metric");
  // A Go pointer's tokens are strings, an index included.
  assert.equal(pointerIn(value, ["committed_metrics", "1", "metric"]), "/committed_metrics/1/metric");
  // A missing member is reported at the object that lacks it, as the schemas report `required`.
  assert.equal(pointerIn(value, ["committed_metrics", 0, "direction"]), "/committed_metrics/0");
  assert.equal(pointerIn(value, ["committed_metrics", 2]), "/committed_metrics");
  assert.equal(pointerIn(value, ["a/b", "~"]), "/a~1b/~0");
  assert.equal(pointerIn(value, ["m", "0"]), "/m/0");
  assert.equal(pointerIn(value, []), "");
});

test("a second desk-test set in its own folder is judged by every engine with no code change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "desk-tests-"));
  try {
    // A second set beside a copy of IAB Australia's, named to sort first, as a set from another contributor may.
    const spec = join(dir, "spec");
    const set = join(spec, "desk-tests", "a-second-set");
    mkdirSync(set, { recursive: true });
    mkdirSync(join(spec, "desk-tests", "iab-au-2026-11"), { recursive: true });
    copyFileSync(join(IAB, "expected.yaml"), join(spec, "desk-tests", "iab-au-2026-11", "expected.yaml"));
    const copies: [string, string][] = [
      ["dooh-v2-b-pg.yaml", "s-clean.yaml"],
      ["dooh-v2-p8-phases.yaml", "s-phases.yaml"],
      ["dooh-v2-p11-c-no-multiplier.yaml", "s-no-multiplier.yaml"],
    ];
    for (const [from, to] of copies) copyFileSync(join(IAB, from), join(set, to));
    writeFileSync(join(set, "README.md"), "# A second set\n\nThree of IAB Australia's line items, renamed, to show a set is a folder.\n");
    const expected: Omit<DeskTests, "file" | "dir"> = {
      format: 1,
      lock: LOCK,
      document: "LineItem",
      checker: "scripts/check_examples.py",
      examples: copies.map(([, to]) => to).sort(),
      findings: [
        { example: "s-no-multiplier.yaml", path: "/delivery_counting", kind: "rule", rule: "rule:5.6.4:e58650b7", reason: "Counts impressions with no multiplier." },
        { example: "s-phases.yaml", path: "/commitment/phases", kind: "undefined_key", reason: "`Commitment` has no `phases`." },
      ],
      undecided: copies.map(([, to]) => ({ example: to, path: "", rule: "rule:5.4:3a677601", reason: "A line item alone shows no proposal status." })),
      sdk_gaps: [{ example: "s-no-multiplier.yaml", path: "/delivery_counting", rule: "rule:5.6.4:e58650b7", reason: "No schema states the condition." }],
    };
    writeFileSync(join(set, "expected.yaml"), stringify(expected));

    const files = deskTestFiles(spec);
    assert.deepEqual(files.map((f) => basename(join(f, ".."))), ["a-second-set", "iab-au-2026-11"]);
    const loaded = loadDeskTests(files[0]!);
    const payloads = loadDeskPayloads(loaded.dir);
    assert.deepEqual([...payloads.keys()], expected.examples, "the README and the expected file aren't payloads");
    const lock = loadLock(join(SPEC, "spec-input", `${LOCK}.lock.yaml`));
    const work = join(dir, "work");
    const checker = await runDeskChecker(lock, loaded, join(work, "checker"));
    const sdks = await runDeskSdks(loaded, payloads, SDKS, join(work, "sdks"));
    assert.deepEqual(
      sdks.map((s) => s.label.replace(/ \(.*\)$/, "")),
      ["the TypeScript SDK", "the Python SDK", "the Go SDK"],
    );
    const input = { set: loaded, model: MODEL, files: FILES, schemaDir: SCHEMA_DIR, payloads, codes: codesOf(KERNEL.lists!), ruleChecks: RULE_CHECKS, checker, sdks };
    const r = checkDeskTests(input);
    assert.deepEqual(r.problems, []);
    for (const v of r.verdicts) {
      const want = v.example === "s-clean.yaml" ? [] : v.example === "s-phases.yaml" ? ["/commitment/phases"] : ["/delivery_counting"];
      assert.equal(v.checker, want.length === 0 ? "clean" : `rejected at ${want.join(", ")}`, v.example);
      // The SDKs accept the rule's finding, as the schema does; the SDK gap records it.
      const sdkWant = v.example === "s-phases.yaml" ? "rejected at /commitment/phases" : "clean";
      assert.deepEqual(Object.values(v.sdks), [sdkWant, sdkWant, sdkWant], v.example);
    }

    // A verdict an SDK doesn't reach fails the set, named by that SDK.
    const accepting: CheckerRun[] = sdks.map((s) => (s.label.startsWith("the Go SDK") ? { ...s, failures: s.failures.filter((f) => f.example !== "s-phases.yaml") } : s));
    assert.match(checkDeskTests({ ...input, sdks: accepting }).problems.join("\n"), /^s-phases\.yaml \/commitment\/phases: the Go SDK \(go[0-9.]+\) doesn't reject it there$/m);
    // An expected file that drops the SDK gap holds the SDKs to the rule they don't check.
    const noGap = checkDeskTests({ ...input, set: { ...loaded, sdk_gaps: [] } }).problems;
    assert.equal(noGap.filter((p) => p.includes("so record rule:5.6.4:e58650b7 there under sdk_gaps")).length, 3, noGap.join("\n"));

    // The gate takes every set of the lock in one run, the second set first, and passes on both.
    const iab = loadDeskTests(join(IAB, "expected.yaml"));
    const iabPayloads = loadDeskPayloads(iab.dir);
    const iabInput = { ...input, set: iab, payloads: iabPayloads, checker: await runDeskChecker(lock, iab, join(work, "iab-checker")), sdks: await runDeskSdks(iab, iabPayloads, SDKS, join(work, "iab-sdks")) };
    const gate = await deskTests.check({ sets: [input, iabInput] });
    assert.deepEqual(gate.problems, []);
    assert.match(gate.note ?? "", /^a-second-set: 3 payloads, 1 clean and 2 rejected, .*; iab-au-2026-11: 23 payloads, 14 clean and 9 rejected, .* and the Go SDK \(go[0-9.]+\); 1 recorded SDK gap; 23 recorded undecided; 0 mismatches$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a line item whose cost parameters break a dependency and a member's own type fails at both places, in the schemas and in every SDK", async () => {
  const cost = { rate_unit: "week", calendar_zone: "+10:00" };
  const pricing = [{ pricing_id: "p1", cost_method: "TIME", cost_parameters: cost, list_rate: 1, currency: "AUD" }];
  const want = ["/pricing/0/cost_parameters/calendar_zone", "/pricing/0/cost_parameters/rate_unit"];
  // The schemas, as the examples and desk-tests gates read them: the line item's `pricing`, checked against its property's schema.
  const r = checkExamples({ model: MODEL, files: FILES, schemaDir: SCHEMA_DIR, examples: [{ id: "p", ir: "desk:test", object: "LineItem", part: true }], values: new Map([["p", { ok: true, value: { pricing } }]]), codes: codesOf(KERNEL.lists!), ruleChecks: RULE_CHECKS });
  assert.deepEqual([...new Set(r.failures.filter((f) => f.kind === "invalid").map((f) => f.path))].sort(), want);
  // Each SDK, on the cost parameters alone and inside a line item's pricing.
  const dir = mkdtempSync(join(tmpdir(), "sdk-locations-"));
  try {
    const items = [{ type: "CostParameters", value: cost }, { type: "PricingEntry", value: pricing[0] }];
    const runs = [await findingsTypeScript(SDKS[0]!.dir, items), findingsPython(ROOT, SDKS[1]!.dir, items), findingsGo(SDKS[2]!.dir, join(dir, "go"), items)];
    for (const run of runs) {
      assert.deepEqual([...locationsOf(cost, run.findings[0]!).keys()].sort(), ["/calendar_zone", "/rate_unit"], run.engine);
      assert.deepEqual([...locationsOf(pricing[0], run.findings[1]!).keys()].sort(), ["/cost_parameters/calendar_zone", "/cost_parameters/rate_unit"], run.engine);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
