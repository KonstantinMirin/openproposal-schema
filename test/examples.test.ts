import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConstructors } from "../src/constructors.ts";
import { emitSchemas, schemaDirOf } from "../src/emit.ts";
import { checkExamples, checkFindings, checkUndecided, loadFindings, loadJsonYaml, modelExamples, oracleAgrees, reasonProblems, type ExampleCase, type Failure, type FindingsFile, type Loaded, type ModelExample } from "../src/examples.ts";
import type { SpecIR } from "../src/ir-types.ts";
import { loadKernel } from "../src/kernel.ts";
import { loadLock } from "../src/lock.ts";
import { loadDecisions, loadMappings } from "../src/mapping.ts";
import { resolveModel } from "../src/model.ts";
import { codesOf } from "../src/rule-checks.ts";
import { ROOT } from "./helpers.ts";

const KERNEL = loadKernel(ROOT);
const CODES = codesOf(KERNEL.lists!);
const CONSTRUCTORS = loadConstructors(ROOT);
const MAPPINGS = loadMappings(ROOT, join(ROOT, "mapping"));
const DECISIONS = loadDecisions(ROOT, join(ROOT, "decisions"));
const irOf = (dir: string) => JSON.parse(readFileSync(join(ROOT, dir, "spec-ir.json"), "utf8")) as SpecIR;
const modelOf = (lock: string, dir: string) => resolveModel({ ir: irOf(dir), lock, mappings: MAPPINGS, decisions: DECISIONS, kernel: KERNEL, constructors: CONSTRUCTORS }).model;
const MAIN = modelOf("main", "ir");
const PRS = modelOf("with-open-prs", join("ir", "with-open-prs"));
const MAIN_FILES = emitSchemas(MAIN, "schemas").files;

/** Validates in-test examples of a line item against the default lock's schemas. */
function check(examples: { id: string; value: unknown; part?: boolean }[]) {
  const listed: ModelExample[] = examples.map((x) => ({ id: x.id, ir: "sentence:6.2:c19128b7", object: "LineItem", part: x.part ?? false }));
  const values = new Map<string, Loaded>(examples.map((x) => [x.id, { ok: true, value: x.value }]));
  return checkExamples({ model: MAIN, files: MAIN_FILES, schemaDir: "schemas", examples: listed, values, codes: CODES });
}
const at = (fs: Failure[]) => fs.map((f) => `${f.kind} ${f.path}`);

test("each § 6 sentence that names a file is an example of the document its heading names", () => {
  const ids = (m: typeof MAIN) => modelExamples(m).map((x) => `${x.id} ${x.object}${x.part ? " part" : ""}`);
  assert.deepEqual(ids(MAIN), ["examples/line-item-audio.yaml LineItem", "examples/line-item-ctv.yaml LineItem", "examples/line-item-display.yaml LineItem", "examples/proposal.yaml Proposal"]);
  assert.deepEqual(ids(PRS), [
    "code:5.5:1 LineItem part",
    "code:5.5:2 LineItem part",
    "code:5.5:3 LineItem part",
    "code:5.6.3:1 LineItem part",
    "examples/line-item-audio.yaml LineItem",
    "examples/line-item-ctv-bonus.yaml LineItem",
    "examples/line-item-ctv.yaml LineItem",
    "examples/line-item-display.yaml LineItem",
    "examples/line-item-rewarded-video.yaml LineItem",
    "examples/manifest.json Manifest",
    "examples/proposal.yaml Proposal",
  ]);
  const overview = MAPPINGS.find((m) => m.module === "overview")!;
  assert.deepEqual(overview.entries.find((e) => e.ir === "sentence:6:b55a7db8")?.as, { role: "informative" }, "`examples/` names a directory, not a file");
});

test("each lock lists, with its blob, exactly the files the specification names as examples", () => {
  for (const [file, model] of [["spec-lock.yaml", MAIN], ["with-open-prs.lock.yaml", PRS]] as const) {
    const lock = loadLock(join(ROOT, "spec-input", file));
    assert.deepEqual(Object.keys(lock.examples).sort(), modelExamples(model).filter((x) => !x.part).map((x) => x.id), file);
  }
});

test("an example loads under YAML 1.2 core, with JSON types only", () => {
  assert.deepEqual(loadJsonYaml("a: no\nb: 2026-09-24\nc: 0o17\nd: 1.50\n"), { ok: true, value: { a: "no", b: "2026-09-24", c: 15, d: 1.5 } }, "YAML 1.1 would read `no` as false and the date as a date");
  assert.deepEqual(loadJsonYaml('{"a": [1, "x", null, true]}'), { ok: true, value: { a: [1, "x", null, true] } }, "JSON is YAML 1.2");
  const fails = (text: string, why: RegExp) => {
    const r = loadJsonYaml(text);
    assert.ok(!r.ok, text);
    assert.match(r.problems.join("; "), why, text);
  };
  fails("a: 1\na: 2\n", /unique/i);
  fails("3: x\n", /isn't a string/);
  fails("a: .inf\n", /isn't a JSON number/);
  fails("a: !binary aGk=\n", /tag/i);
  fails("a: [1\n", /./);
});

test("a valid line item has no failure, and a catalog reference in a union branch isn't an undefined key", () => {
  const r = check([{ id: "ok", value: { line_item_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", audiences: { available: [{ catalog_ref: "examplepub/audiences/smb@3" }, { id: "9d2e4b61-0c3a-4f5e-8b7d-1a2c3e4f5a6b", provenance: "examplepub.example:modeled" }], included: ["9d2e4b61-0c3a-4f5e-8b7d-1a2c3e4f5a6b"] }, materials_due: "2026-09-24T00:00:00Z" } }]);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.cases.map((c) => c.valid), [true]);
});

test("a failure is one location: a union's errors are one failure, and a key the model doesn't define is one at the key", () => {
  const r = check([{ id: "bad", value: { line_item_id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", materials_due: "2026-09-24", production: { available: [{ id: "a", build_owner: "seller" }], included: [] }, buyer_supplied: { suppression_list: { source: "crm" } } } }]);
  assert.deepEqual(at(r.failures), ["undefined_key /buyer_supplied/suppression_list/source", "invalid /materials_due", "invalid /production/available/0/id"]);
  const byPath = new Map(r.failures.map((f) => [f.path, f]));
  assert.equal(byPath.get("/materials_due")!.value, "2026-09-24");
  assert.ok(byPath.get("/materials_due")!.elements.includes("field:5.4:materials_due"));
  assert.match(byPath.get("/buyer_supplied/suppression_list/source")!.message, /open object/, "the schema accepts a key of an open object, and the walk flags it");
  // The `id` an object option carries is the constructor's, so a readable one rests on what an ID a party mints is, its type's elements.
  assert.deepEqual(byPath.get("/production/available/0/id")!.elements, ["field:4.1:proposal_id", "field:5.1:line_item_id"], "the elements of the deepest type the walk reaches");
  const key = check([{ id: "key", value: { production: { available: [{ id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", colour: "red" }], included: [] } } }]);
  assert.deepEqual(at(key.failures), ["undefined_key /production/available/0/colour"]);
  assert.deepEqual(key.failures[0]!.elements, ["field:5.4:production#description/object:1", "key:3.1:available[]"], "a key an option doesn't name rests on the option's element and the selectable row");
});

test("an object option without its id fails at the option, and a name in included[] rests on the selectable row too", () => {
  const r = check([{ id: "options", value: { measurement_source: { available: [{ vendor: "IAS" }], included: ["IAS"] } } }]);
  assert.deepEqual(at(r.failures), ["invalid /measurement_source/available/0", "invalid /measurement_source/included/0", "rule /measurement_source/included/0"]);
  const byPath = new Map(r.failures.map((f) => [f.path, f]));
  assert.match(byPath.get("/measurement_source/available/0")!.message, /required property 'id'/);
  assert.deepEqual(byPath.get("/measurement_source/available/0")!.elements, ["field:5.7:measurement_source#description/object:1", "key:3.1:available[]"]);
  const invalid = r.failures.find((f) => f.kind === "invalid" && f.path === "/measurement_source/included/0")!;
  assert.ok(invalid.elements.includes("key:3.1:included[]"), "an included[] entry rests on § 3.1's included[] row");
});

test("a UUID in included[] doesn't name an option given as a catalog_ref, so the display example's catalog audience stays a gap whatever form an id takes", () => {
  const display = loadJsonYaml(readFileSync(join(ROOT, "spec-input", "snapshots", "main", "examples", "line-item-display.yaml"), "utf8"));
  assert.ok(display.ok);
  const audiences = (display.value as { audiences: { available: unknown[] } }).audiences;
  assert.deepEqual(audiences.available[0], { catalog_ref: "examplepub/audiences/smb-decision-makers@3" });
  const uuid = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const r = check([{ id: "display", value: { audiences: { available: audiences.available.slice(0, 1), included: [uuid] } } }]);
  // The proposed form makes the entry valid, but no option carries it: what names a catalog option is the open point.
  assert.deepEqual(at(r.failures).filter((x) => x.endsWith("/audiences/included/0")), ["rule /audiences/included/0"]);
  const f = loadFindings(ROOT).findings.filter((x) => x.example === "examples/line-item-display.yaml" && x.path === "/audiences/included/0");
  assert.deepEqual(f.map((x) => [x.kind, x.decisions]), [["invalid", ["D-037"]], ["rule", ["D-007"]]]);
  assert.doesNotMatch(f[0]!.reason, /names an option by its UUID/, "the departure's reason promises no remedy the rule's finding refutes");
});

const PRS_FILES = emitSchemas(PRS, schemaDirOf(join("ir", "with-open-prs"))).files;
/** Validates in-test examples against the open PRs' schemas, where more rules apply. */
function checkPrs(examples: { id: string; value: unknown; part?: boolean; ir?: string }[]) {
  const listed: ModelExample[] = examples.map((x) => ({ id: x.id, ir: x.ir ?? "sentence:6.2:c19128b7", object: "LineItem", part: x.part ?? false }));
  const values = new Map<string, Loaded>(examples.map((x) => [x.id, { ok: true, value: x.value }]));
  return checkExamples({ model: PRS, files: PRS_FILES, schemaDir: schemaDirOf(join("ir", "with-open-prs")), examples: listed, values, codes: CODES });
}

test("the examples gate runs every rule one payload decides on the values of the type it reads, and a rule failure names its rule", () => {
  const uuid = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const r = checkPrs([
    {
      id: "rules",
      value: {
        channel: "video",
        formats: { available: ["video/instream-15s"], included: ["video/instream-15s"], pricing: { "video/instream-15s": { delta_cpm: 1 } } },
        environments: { available: ["ctv", "web_desktop"], included: ["web_desktop"] },
        frequency_cap: { max: { min: 6, max: 1 }, period: "day", basis: "device" },
        daypart: { allowed: [{ days: ["monday"], start: "22:00", end: "02:00" }] },
        time_zone: "America/New_York",
        exclusions: { keyword: ["crypto"] },
        exclusions_accepted: { types: ["domain"] },
        status: "agreed",
        audiences: { available: [{ catalog_ref: "examplepub/audiences/smb@3" }, { id: uuid }], included: [uuid] },
      },
    },
  ]);
  const rules = r.failures.filter((f) => f.kind === "rule").map((f) => `${f.rule} ${f.path}`);
  assert.deepEqual([...rules].sort(), [
    "constructor:Range:ordered /frequency_cap/max",
    "constructor:Selectable:priced-beyond-included /formats/pricing/video~1instream-15s",
    "kernel:DaypartWindow:ordered /daypart/allowed/0",
    "rule:2.2:06ccee9f /audiences/available/0/catalog_ref",
    "rule:5.2.1:cc42a1f8 /environments/available/0",
    "rule:5.2:f3d3f9e8 ",
    "rule:5.5:2eab2842 /exclusions/keyword",
  ]);
  const range = r.failures.find((f) => f.rule === "constructor:Range:ordered")!;
  assert.deepEqual(range.value, { min: 6, max: 1 });
  assert.ok(r.checks.ran > 0);
  assert.deepEqual(r.checks.undecided, []);
  // A MUST rule's failure is an error.
  assert.ok(r.failures.filter((f) => f.kind === "rule").every((f) => f.severity === "error"));
});

test("a rule that turns on what an example leaves out is undecided, not a failure", () => {
  // A line item alone doesn't carry its proposal's seller, whom the measurement vendors are compared with.
  const alone = checkPrs([{ id: "alone", value: { channel: "display", committed_metrics: [{ metric: "viewable_rate", value: 0.7 }], environments: { available: ["app_mobile"], included: ["app_mobile"] }, measurement_source: { available: [{ id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", vendor: "verifier.example" }], included: [] } } }]);
  assert.deepEqual(alone.failures.filter((f) => f.kind === "rule"), []);
  const undecided = (x: typeof alone) => x.checks.undecided.map((u) => `${u.example} ${u.path || "/"} (${u.rule})`);
  assert.deepEqual(undecided(alone), ["alone / (rule:5.2.2:f9a1a6d5)"]);
  // A code block that shows a buyer's exclusions and not the seller's declaration says nothing of what the seller accepts.
  const part = checkPrs([{ id: "code:5.5:1", ir: "code:5.5:1", part: true, value: { exclusions: { keyword: ["crypto"] } } }]);
  assert.deepEqual(part.failures.filter((f) => f.kind === "rule"), []);
  assert.deepEqual(undecided(part), ["code:5.5:1 / (rule:5.5:2eab2842)"]);
  assert.deepEqual(part.checks.undecided[0]!.elements, ["code:5.5:1", "rule:5.5:2eab2842"], "a block's undecided check rests on the block and the rule");
  // A ctv line item with no plcmt: nothing says its ads are video.
  const ctv = checkPrs([{ id: "ctv", value: { channel: "ctv", formats: { available: ["ctv/instream-15s"], included: ["ctv/instream-15s"] } } }]);
  assert.deepEqual(undecided(ctv), ["ctv / (rule:5.2:f3d3f9e8)"]);
  // The same block with the declaration decides it.
  const both = checkPrs([{ id: "code:5.5:1", ir: "code:5.5:1", part: true, value: { exclusions: { keyword: ["crypto"] }, exclusions_accepted: { types: ["domain"] } } }]);
  assert.deepEqual(both.failures.filter((f) => f.kind === "rule").map((f) => `${f.rule} ${f.path}`), ["rule:5.5:2eab2842 /exclusions/keyword"]);
});

test("a part of a document is validated field by field, and a field the document lacks is an undefined key", () => {
  const r = check([{ id: "code:5.5:9", part: true, value: { geo: { allowed: ["US-NY"] }, nonsense: 1 } }]);
  assert.deepEqual(at(r.failures), ["undefined_key /nonsense"]);
  assert.deepEqual(r.cases.map((c) => c.ref.replace(/^.*#/, "#")), ["#/properties/geo"]);
});

test("an example that doesn't load is a failure of the whole example", () => {
  const listed: ModelExample[] = [{ id: "examples/broken.yaml", ir: "sentence:6.2:c19128b7", object: "LineItem", part: false }];
  const r = checkExamples({ model: MAIN, files: MAIN_FILES, schemaDir: schemaDirOf("ir"), examples: listed, values: new Map([["examples/broken.yaml", loadJsonYaml("a: 1\na: 2\n")]]), codes: CODES });
  assert.deepEqual(at(r.failures), ["load "]);
});

test("the gate fails on an unrecorded failure, a changed one, a stale finding, and a decision that covers none of the location", () => {
  const f: Failure = { example: "examples/line-item-display.yaml", path: "/materials_due", kind: "invalid", value: "2026-09-24", message: "test", elements: ["field:5.4:materials_due"] };
  const none: FindingsFile = { format: 1, findings: [], file: "findings.yaml" };
  assert.match(checkFindings([f], none, "main", DECISIONS).join("\n"), /record the finding/);
  const entry = { example: f.example, path: f.path, kind: f.kind, value: f.value, decisions: ["D-017"], reason: "A test of the gate's checks." };
  const file: FindingsFile = { format: 1, findings: [entry], file: "findings.yaml" };
  assert.deepEqual(checkFindings([f], file, "main", DECISIONS), [], "D-017 covers the materials_due row");
  assert.match(checkFindings([{ ...f, value: "2026-09-25" }], file, "main", DECISIONS).join("\n"), /changed on lock/);
  assert.match(checkFindings([{ ...f, kind: "undefined_key" }], file, "main", DECISIONS).join("\n"), /changed on lock/);
  assert.match(checkFindings([], file, "main", DECISIONS).join("\n"), /no longer fails/);
  assert.match(checkFindings([f], { ...file, findings: [{ ...entry, decisions: ["D-034"] }] }, "main", DECISIONS).join("\n"), /covers none of/);
  assert.match(checkFindings([f], { ...file, findings: [{ ...entry, decisions: ["D-999"] }] }, "main", DECISIONS).join("\n"), /no decision record/);
  assert.match(checkFindings([f], { ...file, findings: [entry, entry] }, "main", DECISIONS).join("\n"), /recorded twice/);
  assert.deepEqual(checkFindings([], { ...file, findings: [{ ...entry, locks: ["with-open-prs"] }] }, "main", DECISIONS), [], "a finding out of the lock's scope isn't checked");
});

test("the gate fails on an unrecorded undecided check, a stale one, and a SHOULD rule's finding recorded as an error", () => {
  const u = { example: "examples/line-item-ctv-bonus.yaml", path: "", rule: "rule:5.2:f3d3f9e8", elements: ["rule:5.2:f3d3f9e8"] };
  const entry = { example: u.example, path: u.path, rule: u.rule, decisions: ["D-035"], reason: "A test of the gate's checks." };
  const none: FindingsFile = { format: 1, findings: [], file: "findings.yaml" };
  const file: FindingsFile = { ...none, undecided: [entry] };
  assert.match(checkUndecided([u], none, "with-open-prs", DECISIONS).join("\n"), /record it under undecided/);
  assert.deepEqual(checkUndecided([u], file, "with-open-prs", DECISIONS), []);
  assert.match(checkUndecided([], file, "with-open-prs", DECISIONS).join("\n"), /is decided now/);
  assert.match(checkUndecided([u], { ...none, undecided: [{ ...entry, decisions: ["D-017"] }] }, "with-open-prs", DECISIONS).join("\n"), /covers none of/);
  const f: Failure = { example: "examples/line-item-display.yaml", path: "", kind: "rule", rule: "rule:5.2.2:f9a1a6d5", severity: "warning", value: null, message: "test", elements: ["rule:5.2.2:f9a1a6d5"] };
  const finding = { example: f.example, path: f.path, kind: f.kind, rule: f.rule, value: null, decisions: ["D-035"], reason: "A test of the gate's checks." };
  assert.match(checkFindings([f], { ...none, findings: [finding] }, "with-open-prs", DECISIONS).join("\n"), /is a warning, a SHOULD rule's/);
  assert.deepEqual(checkFindings([f], { ...none, findings: [{ ...finding, severity: "warning" }] }, "with-open-prs", DECISIONS), []);
  assert.match(checkFindings([{ ...f, severity: "error" }], { ...none, findings: [{ ...finding, severity: "warning" }] }, "with-open-prs", DECISIONS).join("\n"), /is an error/);
});

test("the recorded findings file is schema-valid", () => {
  const recorded = loadFindings(ROOT);
  assert.ok(recorded.findings.length > 0);
});

test("the oracle cross-check reports a verdict that differs from Ajv's, and an oracle version the lock file doesn't pin", () => {
  const cases: ExampleCase[] = [{ example: "a", ref: "x", value: 1, valid: true }, { example: "b", ref: "x", value: 2, valid: false }];
  const fake = (verdicts: boolean[], jsonschema = "4.26.0") => () => ({ jsonschema, referencing: "0.37.0", verdicts });
  assert.deepEqual(oracleAgrees(ROOT, [], cases, fake([true, false])).problems, []);
  assert.match(oracleAgrees(ROOT, [], cases, fake([true, true])).problems.join("\n"), /b against x: Ajv says invalid, the oracle valid/);
  assert.match(oracleAgrees(ROOT, [], cases, fake([true, false], "4.0.0")).problems.join("\n"), /pins 4\.26\.0/);
  assert.match(oracleAgrees(ROOT, [], cases, fake([true])).problems.join("\n"), /1 verdicts for 2 cases/);
});

test("a finding of a change we propose says the example follows the text, and never blames it", () => {
  const f = { example: "examples/line-item-display.yaml", path: "/line_item_id" };
  const ok = "The example follows the text, which types `line_item_id` as a String: it writes `x`. We propose a UUID for every ID a party mints.";
  assert.deepEqual(reasonProblems({ ...f, decisions: ["D-037"], reason: ok }, DECISIONS), []);
  const blames = reasonProblems({ ...f, decisions: ["D-037"], reason: "A party mints this ID, so it is a UUID. The example writes the readable name `x`, which the specification should write as a UUID." }, DECISIONS);
  assert.ok(blames.some((p) => /opens "The example follows the text"/.test(p)), blames.join("\n"));
  assert.ok(blames.some((p) => /can't blame the example, as "should" does/.test(p)), blames.join("\n"));
  assert.ok(reasonProblems({ ...f, decisions: ["D-037", "D-041"], reason: `${ok} The specification should say more.` }, DECISIONS).some((p) => /can't blame the example/.test(p)), "a second cause doesn't excuse blame");
  // A gap and a departure in one finding would put one reason in both of the feedback's tables.
  assert.match(reasonProblems({ ...f, decisions: ["D-024", "D-037"], reason: ok }, DECISIONS).join("\n"), /cites a gap and a departure/);
  assert.ok(reasonProblems({ ...f, decisions: ["D-017"], reason: ok }, DECISIONS).some((p) => /every cause is a gap/.test(p)));
  // Every recorded finding passes.
  for (const r of loadFindings(ROOT).findings) assert.deepEqual(reasonProblems(r, DECISIONS), [], `${r.example} ${r.path}`);
});
