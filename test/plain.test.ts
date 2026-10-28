import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { checkExemptions, checkExemptionsFile, EXEMPTIONS_FILE, type ExemptionsFile, loadExemptions, pinnedPlainGenerator, plainDivergences, plainModuleOf, plainTarget } from "../src/plain-parity.ts";
import type { ModelDoc } from "../src/model.ts";
import type { SdkCase } from "../src/sdk-parity.ts";
import { ROOT, SPEC } from "./helpers.ts";

const file = (exemptions: ExemptionsFile["exemptions"], generator = "datamodel-code-generator 0.86.0"): ExemptionsFile => ({ format: 1, generator, exemptions, file: "x.yaml" });

test("each published schema file is one module, with no version directory in its name", () => {
  assert.equal(plainModuleOf("kernel/1/kernel.json"), "kernel_kernel");
  assert.equal(plainModuleOf("modules/line-item/1/line-item.json"), "modules_line_item_line_item");
  assert.equal(plainModuleOf("documents/1/line-item-summary.json"), "documents_line_item_summary");
});

test("a plain target names each type's module, and a template application has one only through its named copy", () => {
  const model = { types: [{ name: "Count", kind: "primitive", module: "kernel", layer: 1 }, { name: "FormatsSelection", kind: "copy", module: "creative", layer: 3 }] } as unknown as ModelDoc;
  assert.deepEqual(plainTarget(model, { k: "list", item: { k: "ref", name: "Count" } }), { k: "list", item: { k: "ref", name: "Count", module: "kernel_kernel" } });
  assert.equal(plainTarget(model, { k: "apply", template: "Selectable", args: [{ k: "ref", name: "Count" }] }), null);
  assert.deepEqual(plainTarget(model, { k: "apply", template: "Selectable", args: [], copy: "FormatsSelection" }), { k: "ref", name: "FormatsSelection", module: "modules_creative_creative" });
});

test("the divergences are a wrong verdict, an error, and a value that doesn't encode back", () => {
  const cases: SdkCase[] = [
    { label: "a", target: { k: "ref", name: "T" }, value: 1, valid: false },
    { label: "b", target: { k: "ref", name: "T" }, value: 1, valid: true },
    { label: "c", target: { k: "ref", name: "T" }, value: "PT48H", valid: true },
    { label: "d", target: { k: "ref", name: "T" }, value: 1, json: "1.0", valid: true },
  ];
  const d = plainDivergences(cases, { engine: "x", verdicts: [true, false, true, true], dumps: [1, null, "P2D", 1], errors: [null, "boom", null, null] });
  assert.deepEqual(d.map((x) => [x.label, x.kind]), [["a", "verdict"], ["b", "error"], ["c", "encoding"]]);
});

test("an unlisted divergence fails, a listed one that no longer occurs fails, and one the lock doesn't run is left to the check across locks", () => {
  const ex = file([{ id: "PG-1", reason: "r", cases: [{ label: "a", kind: "verdict" }, { label: "gone", kind: "verdict" }, { label: "elsewhere", kind: "verdict" }] }]);
  const r = checkExemptions([{ label: "a", kind: "verdict", detail: "" }, { label: "new", kind: "error", detail: "boom" }], new Set(["a", "new", "gone"]), ex, "main");
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0]!, /^new: error: boom; no exemption/);
  assert.match(r.problems[1]!, /PG-1: gone \[verdict\] no longer diverges/);
  assert.deepEqual(r.used, ["PG-1"]);
  assert.deepEqual([...r.absent], ["PG-1 elsewhere [verdict]"]);
  // The same label diverging another way is not covered.
  assert.equal(checkExemptions([{ label: "a", kind: "encoding", detail: "" }], new Set(["a"]), file([{ id: "PG-1", reason: "r", cases: [{ label: "a", kind: "verdict" }] }]), "main").problems.length, 2);
  // An exemption scoped to another lock covers nothing here.
  assert.equal(checkExemptions([{ label: "a", kind: "verdict", detail: "" }], new Set(["a"]), file([{ id: "PG-1", locks: ["with-open-prs"], reason: "r", cases: [{ label: "a", kind: "verdict" }] }]), "main").problems.length, 1);
});

test("the exemptions file must be written for the pinned generator, with each ID and each case once", () => {
  const dup = file([
    { id: "PG-1", reason: "r", cases: [{ label: "a", kind: "verdict" }] },
    { id: "PG-1", reason: "r", locks: ["nowhere"], cases: [{ label: "a", kind: "verdict" }] },
  ], "datamodel-code-generator 0.1.0");
  const problems = checkExemptionsFile(dup, "0.86.0", ["main"]);
  assert.ok(problems.some((p) => p.includes("pins 0.86.0")));
  assert.ok(problems.some((p) => p.includes("PG-1 is used twice")));
  assert.ok(problems.some((p) => p.includes('unknown lock "nowhere"')));
  assert.deepEqual(checkExemptionsFile(file([{ id: "PG-1", reason: "r", cases: [{ label: "a", kind: "verdict" }] }, { id: "PG-2", reason: "r", cases: [{ label: "a", kind: "verdict" }] }]), "0.86.0", ["main"]), ['x.yaml: a [verdict] is exempt twice on lock "main"']);
});

test("the committed exemptions file is schema-valid and written for the pinned generator", () => {
  const ex = loadExemptions(join(SPEC, EXEMPTIONS_FILE));
  assert.deepEqual(checkExemptionsFile(ex, pinnedPlainGenerator(ROOT), ["main", "with-open-prs"]), []);
  assert.equal(ex.file, join(SPEC, "plain-generator", "exemptions.yaml"));
});
