import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { stringify } from "yaml";
import { constructorEditionsOn, kernelEditionsOn } from "../src/editions.ts";
import { loadConstructors } from "../src/constructors.ts";
import { checkDeskTests, deskSdks, deskTestFiles, loadDeskPayloads, loadDeskTests, REVIEW_MARK, runDeskChecker, runDeskSdks, type CheckerRun, type DeskTests } from "../src/desk-tests.ts";
import { deskAdd, draftExpected, draftReadme, gistIdOf, readGist, readSource } from "../src/desk-add.ts";
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

test("desk:add copies a folder's payloads, judges them with every engine, and drafts an expected file the gate fails until it is reviewed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "desk-add-"));
  try {
    // A local folder stands in for the gist: three of IAB Australia's line items, one with an integral float in an integer
    // field, which every engine reads as the integer, as JSON Schema and the stack's checker since 6d5a6f9 do, and a file that is
    // no payload.
    const source = join(dir, "gist");
    mkdirSync(source);
    for (const n of ["dooh-v2-b-pg.yaml", "dooh-v2-p8-phases.yaml", "dooh-v2-p11-c-no-multiplier.yaml"]) copyFileSync(join(IAB, n), join(source, n));
    writeFileSync(join(source, "float-code.yaml"), readFileSync(join(IAB, "dooh-v2-b-pg.yaml"), "utf8").replace("price_type: 3,", "price_type: 3.0,"));
    writeFileSync(join(source, "notes.txt"), "run logs\n");
    const into = join(dir, "desk-tests");
    const lock = loadLock(join(SPEC, "spec-input", `${LOCK}.lock.yaml`));
    const r = await deskAdd({ source: readSource(source), set: "a-new-set", specDir: SPEC, lock, root: ROOT, date: "2026-11-12", work: join(dir, "work"), into });
    assert.deepEqual(r.payloads, ["dooh-v2-b-pg.yaml", "dooh-v2-p11-c-no-multiplier.yaml", "dooh-v2-p8-phases.yaml", "float-code.yaml"]);
    assert.deepEqual(r.skipped, ["notes.txt"]);
    // `price_type: 3.0` is clean in all five engines.
    assert.deepEqual(r.clean, ["dooh-v2-b-pg.yaml", "float-code.yaml"]);
    assert.deepEqual(r.rejected, ["dooh-v2-p11-c-no-multiplier.yaml", "dooh-v2-p8-phases.yaml"]);
    assert.deepEqual(r.disagreements, []);
    assert.match(r.report, /^- 0 payloads the engines disagree on, left out of expected\.yaml\.$/m);

    // The draft: a verdict where every engine agrees, every reason the review mark.
    const set = loadDeskTests(join(r.dir, "expected.yaml"));
    assert.deepEqual(set.examples, ["dooh-v2-b-pg.yaml", "dooh-v2-p11-c-no-multiplier.yaml", "dooh-v2-p8-phases.yaml", "float-code.yaml"]);
    assert.deepEqual(set.findings.map((f) => [f.example, f.path, f.kind, f.reason]), [
      ["dooh-v2-p11-c-no-multiplier.yaml", "/delivery_counting", "rule", REVIEW_MARK],
      ["dooh-v2-p8-phases.yaml", "/commitment/phases", "undefined_key", REVIEW_MARK],
    ]);
    assert.deepEqual(set.sdk_gaps.map((g) => [g.example, g.path, g.rule]), [["dooh-v2-p11-c-no-multiplier.yaml", "/delivery_counting", "rule:5.6.4:e58650b7"]]);
    assert.ok(set.undecided.every((u) => u.reason === REVIEW_MARK) && set.undecided.length === 4);
    // The README quotes what the files say of themselves, and leaves the attribution to the reviewer.
    assert.match(set.readme ?? "", /^> THEORETICAL\. Every screen, id, coordinate, domain and figure is invented\.$/m);
    assert.match(set.readme ?? "", new RegExp(`^${REVIEW_MARK}: say who wrote them`, "m"));
    assert.ok(!existsSync(join(r.dir, "notes.txt")));

    // The gate fails on the draft: every review mark, and the README's; and on nothing else, since every engine agrees.
    const payloads = loadDeskPayloads(set.dir);
    const checker = await runDeskChecker(lock, set, join(dir, "work", "gate-checker"));
    const sdks = await runDeskSdks(set, payloads, SDKS, join(dir, "work", "gate-sdks"));
    const problems = checkDeskTests({ set, model: MODEL, files: FILES, schemaDir: SCHEMA_DIR, payloads, codes: codesOf(KERNEL.lists!), ruleChecks: RULE_CHECKS, checker, sdks }).problems;
    assert.equal(problems.filter((p) => p.includes(`the reason is "${REVIEW_MARK}"`)).length, 2 + 1 + 4, problems.join("\n"));
    assert.ok(problems.some((p) => p.includes(`README.md: holds "${REVIEW_MARK}"`)));
    assert.equal(problems.length, 2 + 1 + 4 + 1, problems.join("\n"));

    // A payload the engines disagree on, as the integral float was before 6d5a6f9, where the checker rejected it: the draft
    // leaves it out, and reports where each engine rejects it.
    const schemas = checkExamples({ model: MODEL, files: FILES, schemaDir: SCHEMA_DIR, examples: set.examples.map((id) => ({ id, ir: "desk:a-new-set", object: "LineItem", part: false })), values: payloads, codes: codesOf(KERNEL.lists!), ruleChecks: RULE_CHECKS });
    const older = { ...checker, failures: [...checker.failures, { example: "float-code.yaml", path: "/pricing/0/price_type", message: "is not Integer" }] };
    const d = draftExpected({ set: { ...set, findings: [], undecided: [], sdk_gaps: [] }, failures: schemas.failures, undecided: schemas.checks.undecided, checker: older, sdks });
    assert.deepEqual(d.disagreements.map((x) => [x.example, x.engines.map((e) => e.paths.join(" "))]), [["float-code.yaml", ["", "/pricing/0/price_type", "", "", ""]]]);
    assert.deepEqual(d.expected.examples, ["dooh-v2-b-pg.yaml", "dooh-v2-p11-c-no-multiplier.yaml", "dooh-v2-p8-phases.yaml"]);
    // A set is added once.
    await assert.rejects(deskAdd({ source: readSource(source), set: "a-new-set", specDir: SPEC, lock, root: ROOT, date: "2026-11-12", work: join(dir, "work"), into }), /exists; a set is added once/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("desk:add reads a gist at its current revision through the API, and names its source in the README", () => {
  assert.equal(gistIdOf("https://gist.github.com/jaanijuk/8ab1ede477027e0db81a1be02f6914b8"), "8ab1ede477027e0db81a1be02f6914b8");
  assert.equal(gistIdOf("https://gist.github.com/8ab1ede477027e0db81a1be02f6914b8#file-a-yaml"), "8ab1ede477027e0db81a1be02f6914b8");
  assert.equal(gistIdOf("https://example.com/x"), null);
  const calls: string[][] = [];
  const api = {
    id: "8ab1ede477027e0db81a1be02f6914b8",
    html_url: "https://gist.github.com/jaanijuk/8ab1ede477027e0db81a1be02f6914b8",
    description: "desk tests",
    updated_at: "2026-11-12T00:00:00Z",
    owner: { login: "jaanijuk" },
    history: [{ version: "c9435ae0105d25c1daa4a60becd7f9d2c1910549" }, { version: "0".repeat(40) }],
    files: { "a.yaml": { filename: "a.yaml", content: "# Every figure is invented.\nline_item_id: a\n" }, "README.md": { filename: "README.md", content: "# x\n" } },
  };
  const s = readGist("https://gist.github.com/jaanijuk/8ab1ede477027e0db81a1be02f6914b8", (args) => (calls.push(args), JSON.stringify(api)));
  assert.deepEqual(calls, [["api", "gists/8ab1ede477027e0db81a1be02f6914b8"]]);
  assert.equal(s.gist?.revision, "c9435ae0105d25c1daa4a60becd7f9d2c1910549");
  assert.deepEqual([...s.files.keys()], ["a.yaml", "README.md"]);
  const readme = draftReadme({ set: "s", source: s, payloads: ["a.yaml"], skipped: ["README.md"], date: "2026-11-12", lock: LOCK, verdicts: new Map([["a.yaml", "Clean"]]) });
  assert.match(readme, /from the gist <https:\/\/gist\.github\.com\/jaanijuk\/8ab1ede477027e0db81a1be02f6914b8> of \[@jaanijuk\]\(https:\/\/github\.com\/jaanijuk\), at revision `c9435ae0105d25c1daa4a60becd7f9d2c1910549`, on 2026-11-12/);
  assert.match(readme, /^> Every figure is invented\.$/m);
  assert.throws(() => readGist(api.id, () => JSON.stringify({ ...api, files: { "big.yaml": { filename: "big.yaml", truncated: true } } })), /too large for the API/);
});
