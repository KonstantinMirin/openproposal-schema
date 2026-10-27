import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConstructors } from "../src/constructors.ts";
import type { SpecIR } from "../src/ir-types.ts";
import { loadKernel } from "../src/kernel.ts";
import { loadDecisions, loadMappings } from "../src/mapping.ts";
import { resolveModel, type ModelDoc, type ModelType } from "../src/model.ts";
import { checkDifferences, loadDifferences, normalize, roundTrip, specTables, type Difference, type DifferencesFile } from "../src/render.ts";
import { ROOT } from "./helpers.ts";

const KERNEL = loadKernel(ROOT);
const CONSTRUCTORS = loadConstructors(ROOT);
const MAPPINGS = loadMappings(ROOT, join(ROOT, "mapping"));
const DECISIONS = loadDecisions(ROOT, join(ROOT, "decisions"));
const RECORDED = loadDifferences(ROOT);
const irOf = (dir: string) => JSON.parse(readFileSync(join(ROOT, dir, "spec-ir.json"), "utf8")) as SpecIR;
const LOCKS: [string, SpecIR][] = [
  ["main", irOf("ir")],
  ["with-open-prs", irOf(join("ir", "with-open-prs"))],
];
const modelOf = (lock: string, ir: SpecIR) => resolveModel({ ir, lock, mappings: MAPPINGS, decisions: DECISIONS, kernel: KERNEL, constructors: CONSTRUCTORS }).model;
const [, PRS_IR] = LOCKS[1]!;
const PRS = modelOf("with-open-prs", PRS_IR);

/** A copy of the model with one type changed. */
function edit(model: ModelDoc, name: string, change: (t: ModelType) => void): ModelDoc {
  const copy = structuredClone(model);
  const t = copy.types.find((x) => x.name === name);
  assert.ok(t, `no type ${name}`);
  change(t);
  return copy;
}
const props = (t: ModelType) => {
  assert.ok("properties" in t);
  return t.properties;
};
/** The differences a changed model has beyond the recorded ones. */
const extra = (model: ModelDoc) => roundTrip(model, PRS_IR).differences.filter((d) => !(d.row === "field:5.2:properties" && d.column === "Description"));
const at = (ds: Difference[]) => ds.map((d) => `${d.table} ${d.row} [${d.column}]`);

test("on each lock, the rendered tables equal the specification's, but for the recorded differences", () => {
  for (const [lock, ir] of LOCKS) {
    const rt = roundTrip(modelOf(lock, ir), ir);
    assert.deepEqual(rt.problems, [], lock);
    assert.deepEqual(checkDifferences(rt.differences, RECORDED, lock, DECISIONS), [], lock);
    assert.ok(rt.figures, `${lock}: the distribution's figures render`);
    assert.deepEqual(rt.figures.model, rt.figures.spec, lock);
    const tables = new Set(rt.model.map((t) => t.layout));
    for (const layout of ["field", "key-required-meaning", "marker-meaning", "appendix-a", "appendix-b"]) assert.ok(tables.has(layout), `${lock}: renders ${layout}`);
  }
});

test("every table the model renders holds as many rows as the specification's", () => {
  for (const [lock, ir] of LOCKS) {
    const rt = roundTrip(modelOf(lock, ir), ir);
    for (const s of specTables(ir)) {
      const m = rt.model.find((t) => t.id === s.id);
      assert.ok(m, `${lock}: ${s.id} renders`);
      assert.equal(m.rows.length, s.rows.length, `${lock}: ${s.id}`);
    }
  }
});

test("a cell is compared with whitespace, escaped pipes, and backticks normalized", () => {
  assert.equal(normalize("`a` \\| `b`  c "), "a | b c");
  assert.equal(normalize("{ x,\n y }"), "{ x, y }");
});

test("a changed marker differs in its row, in Appendix A and B, and in the distribution", () => {
  const changed = edit(PRS, "LineItem", (t) => (props(t).channel!.marker = "selectable"));
  const ds = at(extra(changed));
  assert.ok(ds.includes("table:5.1:1 field:5.1:channel [Mutability]"), ds.join("\n"));
  assert.ok(ds.some((d) => d.startsWith("table:A:1 ") && d.endsWith("[Marker]")), ds.join("\n"));
  assert.ok(ds.includes("table:B:1 appendix-b:immutable [Count]"), ds.join("\n"));
  assert.ok(ds.includes("table:B:1 appendix-b:selectable [Fields]"), ds.join("\n"));
  assert.ok(ds.some((d) => d.endsWith("distribution [selectable]")), ds.join("\n"));
});

test("a term the vocabulary adds, or a member an object adds, differs in the cell that writes them", () => {
  const terms = edit(PRS, "Channel", (t) => {
    assert.ok(t.kind === "vocabulary");
    t.terms.push({ value: "radio", sources: [] });
  });
  const ds = extra(terms);
  assert.ok(at(ds).includes("table:5.1:1 field:5.1:channel [Description]"), at(ds).join("\n"));
  assert.match(ds.find((d) => d.row === "field:5.1:channel")!.model, /`native` \| `radio`/);
  assert.ok(at(ds).includes("table:5.1.1:1 Channel:radio [*]"), "a term with no definition row is a row the table lacks");

  const member = edit(PRS, "AssetsEntry", (t) => (props(t).checksum = { type: { kind: "named", name: "Digest" }, presence: "optional", sources: [] }));
  const assets = extra(member).find((d) => d.row === "field:5.4:assets[]");
  assert.ok(assets, "the inline object's cell differs");
  assert.match(assets.model, /approval_status, checksum \}/);
});

test("a key the object adds is a row the key table lacks, and a changed presence differs in the Required cell", () => {
  const added = edit(PRS, "Commitment", (t) => (props(t).note = { type: { kind: "named", name: "Text" }, presence: "optional", sources: [] }));
  assert.ok(at(extra(added)).includes("table:5.6.1:1 Commitment.note [*]"));
  const optional = edit(PRS, "Commitment", (t) => (props(t).amount!.presence = "optional"));
  const d = extra(optional).find((x) => x.row === "key:5.6.1:commitment.amount");
  assert.deepEqual(d && [d.column, d.spec, d.model], ["Required", "REQUIRED", "OPTIONAL"]);
});

test("a property the model drops is a row it lacks, and a changed type differs in the Type cell", () => {
  const dropped = edit(PRS, "LineItem", (t) => delete props(t).formats);
  const ds = at(extra(dropped));
  assert.ok(ds.includes("table:5.4:1 field:5.4:formats [*]"), ds.join("\n"));
  const retyped = edit(PRS, "Proposal", (t) => (props(t).version!.type = { kind: "named", name: "Amount" }));
  const d = extra(retyped).find((x) => x.row === "field:4.1:version" && x.column === "Type");
  assert.deepEqual(d && [d.spec, d.model], ["Integer", "Number"]);
});

test("the Type column writes unions, lists, and formats in the specification's notation", () => {
  const rt = roundTrip(PRS, PRS_IR);
  const cell = (row: string) => rt.model.flatMap((t) => t.rows).find((r) => r.row === row)?.cells[1];
  assert.equal(cell("field:5.4:materials_due"), "Timestamp/Offset");
  assert.equal(cell("field:4.2:specifications"), "String/Object");
  assert.equal(cell("field:4.2:best_for[]"), "Array[String]");
  assert.equal(cell("field:5.5:geo"), "Object");
});

test("a Required cell is read as the presence it states", () => {
  const rt = roundTrip(PRS, PRS_IR);
  const spec = specTables(PRS_IR).flatMap((t) => t.rows);
  const cell = (row: string) => spec.find((r) => r.row === row)?.cells[1];
  assert.equal(cell("key:5.2:apps[].domain"), "OPTIONAL", "RECOMMENDED is optional (type rules § 4)");
  assert.equal(cell("key:5.6.1:commitment.derived_units"), "derived", "a marker in the cell stands as the key's marker");
  assert.equal(cell("key:5.2.2:placement.plcmt"), "REQUIRED for video ads (`channel` `video`, or video on `channel` `ctv`)");
  const model = rt.model.flatMap((t) => t.rows).find((r) => r.row === "key:5.6.1:commitment.derived_units");
  assert.equal(model?.cells[1], "derived", "the model carries the marker the key row writes");
});

test("the gate fails on an unrecorded difference, a changed one, a stale one, and a decision that covers none of the row", () => {
  const d: Difference = { table: "table:5.1:1", row: "field:5.1:channel", column: "Mutability", spec: "immutable", model: "selectable", elements: ["field:5.1:channel", "field:5.1:channel#description/values:1"] };
  const none: DifferencesFile = { format: 1, differences: [], file: "differences.yaml" };
  assert.match(checkDifferences([d], none, "main", DECISIONS).join("\n"), /fix the mapping, or record the difference/);
  const entry = { table: d.table, row: d.row, column: d.column, spec: d.spec, model: d.model, decision: "D-013", reason: "A test of the gate's checks." };
  const file: DifferencesFile = { format: 1, differences: [entry], file: "differences.yaml" };
  assert.deepEqual(checkDifferences([d], file, "main", DECISIONS), [], "D-013 covers the channel row's value list");
  assert.match(checkDifferences([{ ...d, model: "derived" }], file, "main", DECISIONS).join("\n"), /changed on lock/);
  assert.match(checkDifferences([], file, "main", DECISIONS).join("\n"), /no longer differs/);
  const other = { ...file, differences: [{ ...entry, decision: "D-034" }] };
  assert.match(checkDifferences([d], other, "main", DECISIONS).join("\n"), /covers none of/);
  const missing = { ...file, differences: [{ ...entry, decision: "D-999" }] };
  assert.match(checkDifferences([d], missing, "main", DECISIONS).join("\n"), /no decision record/);
  assert.deepEqual(checkDifferences([], { ...file, differences: [{ ...entry, locks: ["with-open-prs"] }] }, "main", DECISIONS), [], "an entry out of the lock's scope isn't checked");
});
