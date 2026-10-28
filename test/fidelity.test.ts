import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkFidelity, readingsOf, violates as violatesWith, type FidelityInput, type SpecConstraint } from "../src/fidelity.ts";
import { FIDELITY, literal, readCondition, readConstraints, rightValues, wrongValues } from "../src/specs/openproposal/fidelity-readers.ts";
import { loadConstructors } from "../src/constructors.ts";
import { emitSchemas, schemaDirOf, type SchemaNames } from "../src/emit.ts";
import type { TypeExpr } from "../src/grammar/type-expr.ts";
import type { SpecIR } from "../src/ir-types.ts";
import { loadKernel } from "../src/kernel.ts";
import { loadLock } from "../src/lock.ts";
import { loadDecisions, loadMappings, type DecisionRecord } from "../src/mapping.ts";
import { resolveModel } from "../src/model.ts";
import { emitRules, loadVectors, VECTORS_DIR } from "../src/rules.ts";
import { fidelity, loadExpected, type ExpectedFile } from "../gates/fidelity.ts";
import { extractText, FIELD_HEADER, lineItems, OP_SCHEMA, ROOT, SPEC } from "./helpers.ts";

const PRS = JSON.parse(readFileSync(join(SPEC, "ir", "with-open-prs", "spec-ir.json"), "utf8")) as SpecIR;
const read = (ir: SpecIR) => readConstraints(ir);
const violates = (c: SpecConstraint, payload: unknown) => violatesWith(c, payload, FIDELITY);
const byId = (cs: SpecConstraint[], id: string) => cs.find((c) => c.id === id);

test("literal reads booleans and decimal integers, and keeps every other value a string", () => {
  assert.equal(literal("true"), true);
  assert.equal(literal("0"), 0);
  assert.equal(literal("spend"), "spend");
  assert.equal(literal("01"), "01");
});

test("a REQUIRED when `a = b` key reads as a condition, with the sibling's other listed values as the side where the member may be absent", () => {
  const c = byId(read(PRS).constraints, "key:5.6.1:commitment.currency#conditional@line_item.commitment.currency");
  assert.ok(c && c.form === "conditional" && "when" in c);
  assert.deepEqual(c.when, { member: "basis", value: "spend", up: 0 });
  assert.deepEqual(c.otherwise, ["units"]);
});

test("the § 3.1 keys attach to every field the introducing statement names by marker", () => {
  const { constraints } = read(PRS);
  const selectable = PRS.fields.filter((f) => f.marker === "selectable").map((f) => f.names[0]!.path).sort();
  const attached = constraints.filter((c) => c.element === "key:3.1:available[]").map((c) => c.at.path.map((s) => s.name).join(".")).sort();
  assert.deepEqual(attached, selectable);
});

test("a MUST-contain statement reads the next block's list and the block that continues it with 'plus', and a prose item stays unread", () => {
  const { constraints, unread } = read(PRS);
  const contains = constraints.filter((c) => c.form === "contains");
  assert.ok(contains.some((c) => c.element === "block:2.1:3/identifiers:1" && c.at.member.name === "line_item_id"));
  assert.ok(contains.some((c) => c.element === "block:2.1:4/identifiers:1" && c.at.member.name === "seller_name"));
  // `formats.included[]` is two steps: `formats` in the summary, and `included` in it.
  assert.ok(byId(contains, "block:2.1:3/identifiers:1#contains@block:2.1:3/identifiers:1.formats"));
  assert.ok(byId(contains, "block:2.1:3/identifiers:1#contains@block:2.1:3/identifiers:1.formats.included[]"));
  assert.ok(unread.some((u) => u.text === "property names"));
});

test("a 'whichever of' list is a projection with each step optional, and a decision's reading of a prose item joins its list's projection", () => {
  const { constraints, projections, restated } = read(PRS);
  const placement = projections.find((p) => p.list === "block:2.1:7/identifiers:1");
  assert.deepEqual(placement?.paths.map((p) => [p.segments.map((x) => x.name).join("."), p.presence]), [["placement.reward", "optional"], ["placement.instl", "optional"], ["placement.plcmt", "optional"], ["placement.skip", "optional"]]);
  assert.ok(byId(constraints, "block:2.1:7/identifiers:1#optional@block:2.1:7/identifiers:1.placement"));
  assert.ok(byId(constraints, "block:2.1:7/identifiers:1#optional@block:2.1:7/identifiers:1.placement.skip"));
  assert.ok(restated.some((r) => r.element === "rule:2.1:5d7284d5"));
  const readings = [{ list: "block:2.1:3/identifiers:1", decision: "D-028", item: "property names", paths: ["properties.available[].name"] }];
  const withReading = readConstraints(PRS, undefined, readings);
  const summary = withReading.projections.find((p) => p.list === "block:2.1:3/identifiers:1");
  assert.deepEqual(summary?.paths.filter((p) => p.presence === "kept").map((p) => [p.segments.map((x) => x.name).join("."), p.decision]), [["properties.available.name", "D-028"]]);
  // The reading states no presence, and the prose item it reads is no longer unread.
  assert.ok(!withReading.constraints.some((c) => c.at.member.name === "name" && c.element === "block:2.1:3/identifiers:1"));
  assert.ok(!withReading.unread.some((u) => u.text === "property names"));
  assert.deepEqual(withReading.refused, []);
  assert.deepEqual(readingsOf(loadMappings(join(SPEC, "mapping")), "main"), [{ list: "block:2.1:3/identifiers:1", decision: "D-028", item: "property names", paths: ["properties.available[].name"] }]);
});

test("a decision's reading that would widen a projection, or reads no prose item of its list, is refused and joins no projection", () => {
  const list = "block:2.1:3/identifiers:1";
  const { projections, refused, unread } = readConstraints(PRS, undefined, [
    { list, decision: "D-028", item: "property names", paths: ["properties.available[].name", "formats.available[]", "pricing.currency"] },
    { list, decision: "D-999", item: "format names", paths: ["placement.api"] },
    { list: "block:2.1:7/identifiers:1", decision: "D-998", item: "property names", paths: ["placement.api"] },
  ]);
  const kept = projections.find((p) => p.list === list)?.paths.filter((p) => p.presence === "kept").map((p) => p.segments.map((x) => x.name).join("."));
  // Only the path that starts at a field no code path names joins; formats and pricing are code paths' fields.
  assert.deepEqual(kept, ["properties.available.name"]);
  assert.deepEqual(
    refused.map((r) => [r.decision, r.path ?? null]),
    [
      ["D-028", "formats.available[]"],
      ["D-028", "pricing.currency"],
      ["D-999", null],
      ["D-998", null],
    ],
  );
  assert.match(refused[0]!.why, /which the list's code path "formats\.included\[\]" names/);
  assert.match(refused[2]!.why, /the list writes no prose item "format names"/);
  assert.match(refused[3]!.why, /no MUST-contain statement introduces the list/);
  // The prose item D-028 reads is read; no other reading reads one.
  assert.ok(!unread.some((u) => u.element === list && u.text === "property names"));
});

test("a value list the text leaves open states no invalid value, and the report says so", () => {
  const { constraints, unread } = read(PRS);
  const platform = constraints.find((c) => c.element === "key:5.2:apps[].platform#meaning/values:1");
  assert.ok(platform && platform.form === "values" && platform.open);
  assert.ok(unread.some((u) => u.element === "key:5.2:apps[].platform#meaning/values:1" && u.form.startsWith("an open value list")));
});

test("a condition on a member of an enclosing object reads, and a case the text qualifies with prose is on neither side", () => {
  const c = byId(read(PRS).constraints, "key:5.2.2:placement.plcmt#conditional@line_item.placement.plcmt");
  assert.ok(c && c.form === "conditional" && "when" in c);
  // `channel` is the line item's, one object above `placement`.
  assert.deepEqual(c.when, { member: "channel", value: "video", up: 1 });
  assert.ok(c.otherwise.length > 1, "every other channel is a side where plcmt may be absent");
  assert.ok(!c.otherwise.includes("video") && !c.otherwise.includes("ctv"));
  assert.ok(c.otherwise.includes("display"));
});

test("a condition reads as a member equal to a value, or as a label with the cases it means, and nothing looser", () => {
  assert.deepEqual(readCondition("`basis = spend`"), { member: "basis", value: "spend", undecided: [] });
  assert.deepEqual(readCondition("`terms_acceptance_required` is `true`"), { member: "terms_acceptance_required", value: true, undecided: [] });
  assert.deepEqual(readCondition("video ads (`channel` `video`, or video on `channel` `ctv`)"), { member: "channel", value: "video", undecided: ["ctv"] });
  assert.equal(readCondition("video ads (`channel` `video`, or `channel` `ctv`)"), null, "two values that hold it");
  assert.equal(readCondition("video ads (`channel` `video`, or `format` `vast`)"), null, "two members");
  assert.equal(readCondition("video ads"), null);
});

test("a condition whose member's row lists no values is tested where it holds, and the other side is counted unread, not dropped", () => {
  const ir = extractText(lineItems(`### 5.1 Identity\n\n${FIELD_HEADER}\n| \`mode\` | String | immutable | The mode |\n| \`code\` | Integer | immutable | REQUIRED when \`mode\` is \`x\`. A code |\n`));
  const { constraints, unread } = read(ir);
  const c = byId(constraints, "field:5.1:code#conditional@line_item.code");
  assert.ok(c && c.form === "conditional" && "when" in c);
  assert.deepEqual(c.otherwise, []);
  assert.ok(unread.some((u) => u.element === "field:5.1:code" && u.form.startsWith("a condition's other side")));
});

test("values outside a value list read: a sentence's values per key, and a named list's codes, closed or left open by 'such as'", () => {
  const { constraints } = read(PRS);
  const enforcement = byId(constraints, "sentence:5.5:262ff404#values@line_item.exclusions_accepted.enforcement");
  assert.ok(enforcement && enforcement.form === "values");
  assert.deepEqual(enforcement.values, ["pre_serve", "best_effort"]);
  assert.equal(enforcement.entries, true);
  assert.equal(enforcement.open, false);
  const plcmt = byId(constraints, "key:5.2.2:placement.plcmt#values@line_item.placement.plcmt");
  assert.ok(plcmt && plcmt.form === "values");
  assert.deepEqual(plcmt.values, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(plcmt.open, false);
  const api = byId(constraints, "key:5.2.2:placement.api[]#values@line_item.placement.api[]");
  assert.ok(api && api.form === "values");
  assert.deepEqual(api.values, [6, 7, 9]);
  assert.equal(api.open, true);
});

test("a YAML block under a field's name gives each member's value as written, and a placeholder value stays unread", () => {
  const { constraints, unread } = read(PRS);
  const types = byId(constraints, "code:5.5:1#example@line_item.exclusions_accepted.types[]");
  assert.ok(types && types.form === "example");
  assert.deepEqual(types.value, ["domain", "app_bundle", "iab_content_category", "keyword"]);
  assert.ok(unread.some((u) => u.element === "code:5.5:1" && u.text.startsWith("exclusions.list_ref") && u.form.includes("placeholder")));
});

test("every statement and sentence the oracle doesn't read is listed with its form, and one it reads through a row is not called behavior", () => {
  const { constraints, unread, restated } = read(PRS);
  const seen = new Set([...constraints.map((c) => c.element), ...unread.map((u) => u.element), ...restated.map((r) => r.element)]);
  for (const s of [...PRS.statements, ...PRS.sentences]) assert.ok(seen.has(s.id), s.id);
  assert.deepEqual(restated.find((r) => r.element === "rule:4.2:86398bec"), { element: "rule:4.2:86398bec", constraint: "field:4.2:description#required@proposal.description" });
  assert.deepEqual(restated.find((r) => r.element === "rule:5.2:f3d3f9e8"), { element: "rule:5.2:f3d3f9e8", constraint: "key:5.2.2:placement.plcmt#conditional@line_item.placement.plcmt" });
  assert.ok(restated.some((r) => r.element === "rule:2.1:2e481f6f"), "the MUST-contain statement reads through its list");
  assert.equal(unread.find((u) => u.element === "rule:5.2.2:463dfafd")?.form, "a type stated in prose, not in a Type cell");
});

test("a field row's REQUIRED sentence and stated type read from a synthetic specification", () => {
  const ir = extractText(lineItems(`### 5.1 Identity\n\n${FIELD_HEADER}\n| \`code\` | Integer | immutable | REQUIRED. A code |\n`));
  const { constraints } = read(ir);
  assert.ok(byId(constraints, "field:5.1:code#required@line_item.code"));
  const t = byId(constraints, "field:5.1:code#type@line_item.code");
  assert.ok(t && t.form === "type" && t.type.kind === "scalar" && t.type.name === "Integer");
});

const scalar = (name: string): TypeExpr => ({ kind: "scalar", name }) as TypeExpr;

test("a stated type's wrong values include a string of no format where every string it takes has one, and its right values a fraction where it takes any number", () => {
  assert.deepEqual(wrongValues(scalar("Timestamp")), [0, "not-a-time"]);
  assert.deepEqual(wrongValues({ kind: "union", members: [scalar("Timestamp"), scalar("Offset")] } as TypeExpr), [0, "not-a-time"]);
  assert.deepEqual(wrongValues({ kind: "union", members: [scalar("String"), scalar("Timestamp")] } as TypeExpr), [0], "a String member takes any string, so only another JSON type is wrong");
  assert.deepEqual(wrongValues(scalar("Integer")), ["0", 0.5]);
  assert.deepEqual(wrongValues(scalar("Number")), ["0"]);
  assert.deepEqual(wrongValues({ kind: "array", items: scalar("Timestamp") } as TypeExpr), ["x", [0]]);
  assert.deepEqual(rightValues(scalar("Number")), [0.5]);
  assert.deepEqual(rightValues(scalar("Integer")), []);
  assert.deepEqual(rightValues({ kind: "array", items: scalar("Number") } as TypeExpr), [[0.5]]);
});

test("a payload violates a constraint only where every object on the path is present, and a condition only where it holds", () => {
  const { constraints } = read(PRS);
  const c = byId(constraints, "key:5.2.2:placement.plcmt#conditional@line_item.placement.plcmt")!;
  assert.equal(violates(c, { channel: "video", placement: { skip: true } }), true);
  assert.equal(violates(c, { channel: "video", placement: { plcmt: 1 } }), false);
  assert.equal(violates(c, { channel: "display", placement: { skip: true } }), false);
  assert.equal(violates(c, { channel: "video" }), false, "no placement, so no placement lacks plcmt");
  const values = byId(constraints, "key:5.2.2:placement.plcmt#values@line_item.placement.plcmt")!;
  assert.equal(violates(values, { placement: { plcmt: 10 } }), true);
  assert.equal(violates(values, { placement: { plcmt: 9 } }), false);
});

test("a row REQUIRED with either reads as required with each member the sentence before names, from the member's own object", () => {
  const c = byId(read(PRS).constraints, "field:5.5:time_zone#conditional@line_item.time_zone");
  assert.ok(c && c.form === "conditional" && "with" in c);
  assert.deepEqual(c.with, [["daypart"], ["frequency_cap", "period"]]);
  assert.equal(violates(c, { frequency_cap: { period: "P1D" } }), true);
  assert.equal(violates(c, { daypart: { allowed: [] } }), true);
  assert.equal(violates(c, { frequency_cap: { period: "P1D" }, time_zone: "UTC" }), false);
  assert.equal(violates(c, { frequency_cap: { max: { max: 3 } } }), false, "a cap with no period needs no clock");
  assert.equal(violates(c, {}), false);
});

test("a presence with members reads from code spans, and one beside another clause stays unread", () => {
  const ir = extractText(lineItems(`### 5.1 Identity\n\n${FIELD_HEADER}\n| \`mode\` | String | immutable | The mode |\n| \`code\` | Integer | immutable | REQUIRED with \`mode\`. A code |\n| \`tag\` | String | immutable | REQUIRED with \`mode\`; otherwise OPTIONAL. A tag |\n`));
  const { constraints, unread } = read(ir);
  const c = byId(constraints, "field:5.1:code#conditional@line_item.code");
  assert.ok(c && c.form === "conditional" && "with" in c);
  assert.deepEqual(c.with, [["mode"]]);
  assert.ok(unread.some((u) => u.element === "field:5.1:tag" && u.form.startsWith("a presence with members beside another clause")));
});

test("the schema's dependencies give time_zone the verdicts its row states", () => {
  const r = checkFidelity(gateInput());
  const id = "field:5.5:time_zone#conditional@line_item.time_zone";
  assert.ok(r.constraints.some((c) => c.id === id));
  assert.deepEqual(r.disagreements.filter((d) => d.constraint === id), []);
  assert.deepEqual(r.problems.filter((p) => p.startsWith(id)), []);
});

// The real input of the gate on the open-PRs lock, built as `npm run ci` builds it.
let built: (FidelityInput & { expected: ExpectedFile; names: SchemaNames }) | undefined;
function gateInput(): FidelityInput & { expected: ExpectedFile; names: SchemaNames } {
  if (built) return built;
  const lock = loadLock(join(SPEC, "spec-input", "with-open-prs.lock.yaml"));
  const decisions = loadDecisions(join(SPEC, "decisions"));
  const kernel = loadKernel(ROOT, SPEC);
  const mappings = loadMappings(join(SPEC, "mapping"));
  const { model } = resolveModel({ ir: PRS, lock: lock.name, mappings, decisions, kernel, constructors: loadConstructors(ROOT, SPEC) });
  const schemaDir = schemaDirOf(lock.ir_dir);
  const emitted = emitSchemas(model, schemaDir, OP_SCHEMA);
  const rules = emitRules({ model, ir: PRS, lock: lock.name, vectors: loadVectors(join(SPEC, VECTORS_DIR)), decisions, schemaDir, conditionsLeft: emitted.conditions.left, schemaBase: OP_SCHEMA.base }).doc;
  built = { ir: PRS, lock: lock.name, model, files: emitted.files, kernel, rules, decisions, readings: readingsOf(mappings, lock.name), schemaDir, expected: loadExpected(), readers: FIDELITY, names: OP_SCHEMA };
  return built;
}
const D039_VALUES = "key:5.2.2:placement.reward#meaning/values:1";
type Cover = DecisionRecord["covers"][number];
const withD039 = <I extends FidelityInput>(i: I, change: (c: Cover) => Cover): I => ({ ...i, decisions: i.decisions.map((d) => (d.id === "D-039" ? { ...d, covers: d.covers.map(change) } : d)) });

test("a departure excuses only the element and the form its cover lists, and a listed form that excuses nothing is a problem", () => {
  const i = gateInput();
  const r = checkFidelity(i);
  assert.ok(r.departed.some((d) => d.decision === "D-039" && d.element === D039_VALUES && d.status === "proposed"), "a proposed departure excuses, and says so");
  // The form on the row's cover, not on its value list's: the value list's disagreement is no longer excused.
  const moved = checkFidelity(withD039(i, (c) => (c.ir === D039_VALUES ? { ...c, departs: undefined } : c.ir === "key:5.2.2:placement.reward" ? { ...c, departs: ["values"] } : c)));
  assert.ok(moved.disagreements.some((d) => d.element === D039_VALUES && d.form === "values"));
  assert.ok(moved.problems.some((p) => p.includes("D-039: departs from the values form of key:5.2.2:placement.reward on")));
  // A form the element never disagrees in.
  const extra = checkFidelity(withD039(i, (c) => (c.ir === D039_VALUES ? { ...c, departs: ["values", "required"] } : c)));
  assert.ok(extra.problems.some((p) => p.includes(`departs from the required form of ${D039_VALUES}`)));
});

test("no rule excuses a constraint by naming its element: only a listed rule on the path, with an invalid vector the constraint rules out, does", () => {
  const i = gateInput();
  const included = "key:3.1:included[]";
  assert.ok(i.rules.rules.some((r) => r.sources.includes(included)), "a rule names the element among its sources");
  const model = structuredClone(i.model);
  for (const t of model.types) if (t.kind === "copy" && t.of.constructor === "Selectable") t.schema = { ...t.schema, required: ["available"] };
  const r = checkFidelity({ ...i, model, files: emitSchemas(model, i.schemaDir, OP_SCHEMA).files });
  assert.ok(r.disagreements.filter((d) => d.element === included && d.form === "required").length >= 12);
  assert.deepEqual(r.ruled, []);
  // The plcmt condition: unlisted, it disagrees; listed with its rule, the rule carries it; listed with another rule, it disagrees still.
  const plcmt = "key:5.2.2:placement.plcmt#conditional@line_item.placement.plcmt";
  assert.ok(checkFidelity(i).disagreements.some((d) => d.constraint === plcmt));
  const listed = checkFidelity({ ...i, ruled: [{ constraint: plcmt, rule: "rule:5.2:f3d3f9e8" }] });
  assert.ok(listed.ruled.some((d) => d.constraint === plcmt && d.rule === "rule:5.2:f3d3f9e8"));
  const elsewhere = checkFidelity({ ...i, ruled: [{ constraint: plcmt, rule: "rule:5.8:6ee577a5" }] });
  assert.ok(elsewhere.disagreements.some((d) => d.constraint === plcmt));
  assert.ok(elsewhere.problems.some((p) => p.startsWith(`${plcmt}: listed as left to rule:5.8:6ee577a5, but`)));
});

test("the expected file: an unlisted disagreement fails, a listed one whose detail changed fails, and a listed one that no longer occurs fails", async () => {
  const i = gateInput();
  assert.deepEqual((await fidelity.check(i)).problems, []);
  // A summary that leaves a path it MUST contain optional disagrees with the text.
  const model = structuredClone(i.model);
  const summary = model.types.find((t) => t.name === "LineItemSummary");
  assert.ok(summary && summary.kind === "profile");
  summary.properties.line_item_id!.presence = "optional";
  const loose = { ...i, model, files: emitSchemas(model, i.schemaDir, OP_SCHEMA).files };
  const constraint = "block:2.1:3/identifiers:1#contains@block:2.1:3/identifiers:1.line_item_id";
  const detail = '"line_item_id" absent is invalid, but the schema accepts it';
  const without = await fidelity.check(loose);
  assert.ok(without.problems.some((p) => p === `${constraint}: ${detail}; fix the model, or record a departure that covers block:2.1:3/identifiers:1`), without.problems.join("\n"));
  const group = { owner: "a test", reason: "A test.", disagreements: [{ constraint, locks: ["with-open-prs"], detail }] };
  assert.deepEqual((await fidelity.check({ ...loose, expected: { ...i.expected, groups: [group] } })).problems, [], "a listed disagreement passes");
  const changed = await fidelity.check({ ...loose, expected: { ...i.expected, groups: [{ ...group, disagreements: [{ ...group.disagreements[0]!, detail: "another detail" }] }] } });
  assert.ok(changed.problems.some((p) => p.includes(`${constraint} changed on lock "with-open-prs"`)));
  const fixed = await fidelity.check({ ...i, expected: { ...i.expected, groups: [group] } });
  assert.ok(fixed.problems.some((p) => p.includes(`${constraint} no longer disagrees on lock "with-open-prs"; remove it, as a test does`)));
  const stale = await fidelity.check({ ...i, expected: { ...i.expected, ruled: [...(i.expected.ruled ?? []), { constraint: "gone", locks: ["with-open-prs"], rule: "rule:5.2:f3d3f9e8", reason: "A test." }] } });
  assert.ok(stale.problems.some((p) => p.includes("gone is no longer left to rule:5.2:f3d3f9e8")));
  const other = await fidelity.check({ ...i, expected: { ...i.expected, ruled: (i.expected.ruled ?? []).map((x) => ({ ...x, locks: ["main"] })) } });
  assert.ok(other.problems.some((p) => p.includes('"plcmt" absent while channel = "video" is invalid')), "an entry on another lock doesn't apply here");
});

test("a conditional tests every other value its member's row lists, not only the first", () => {
  const i = gateInput();
  const model = structuredClone(i.model);
  const placement = model.types.find((t) => t.name === "Placement");
  assert.ok(placement && placement.kind === "object");
  placement.properties.plcmt!.presence = "required";
  const r = checkFidelity({ ...i, model, files: emitSchemas(model, i.schemaDir, OP_SCHEMA).files });
  const c = byId(read(PRS).constraints, "key:5.2.2:placement.plcmt#conditional@line_item.placement.plcmt")!;
  assert.ok(c.form === "conditional" && "when" in c);
  const rejected = r.disagreements.filter((d) => d.constraint === c.id && d.detail.includes("is valid, but the schema rejects it")).map((d) => /channel = "([^"]+)"/.exec(d.detail)?.[1]);
  assert.deepEqual(rejected.sort(), [...(c.otherwise as string[])].sort());
});

test("a closed vocabulary no closed value list reaches is counted unread, and one a list reaches is not", () => {
  const { unread } = checkFidelity(gateInput());
  const vocabularies = unread.filter((u) => u.form === "a closed vocabulary no closed value list the oracle reads reaches").map((u) => u.text.split(":")[0]);
  assert.ok(vocabularies.includes("ExclusionType"));
  assert.ok(!vocabularies.includes("Enforcement") && !vocabularies.includes("PlcmtSubtype"));
});

test("a sentence that gives members the codes of named lists is read with the lists' codes, and unread without them", () => {
  const lists = loadKernel(ROOT, SPEC).lists;
  const sentence = PRS.sentences.find((s) => /take any code in List:/.test(s.text))!;
  const of = (cs: SpecConstraint[]) => cs.filter((c) => c.element === sentence.id && c.form === "values").map((c) => [c.at.member.name, "values" in c ? c.values : null, "open" in c ? c.open : null]);
  assert.deepEqual(of(readConstraints(PRS, lists).constraints).sort(), [
    ["api", [1, 2, 3, 4, 5, 6, 7, 8, 9], false],
    ["playmethod", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], false],
    ["plcmt", [1, 2, 3, 4, 5, 6, 7, 8, 9], false],
  ]);
  assert.deepEqual(of(read(PRS).constraints), []);
  assert.ok(read(PRS).unread.some((u) => u.element === sentence.id && u.form === "a named list whose codes the sentence doesn't write"));
});

test("a row's namespaced options read as their examples, each valid, and each without its namespace invalid; another namespace stays unread", () => {
  const c = byId(read(PRS).constraints, "field:5.4:formats#namespaced@line_item.formats.available[]");
  assert.ok(c && c.form === "namespaced");
  assert.deepEqual(c.examples, ["display/300x250", "audio/host-read-30s"]);
  assert.equal(c.items, true);
  const md = lineItems(["### 5.4 Creative", "", FIELD_HEADER, "| `shapes` | Object | selectable | `available[]` of shape ids namespaced by vendor, `included[]` |"].join("\n"));
  const { constraints, unread } = read(extractText(md));
  assert.ok(!constraints.some((x) => x.form === "namespaced"));
  assert.ok(unread.some((u) => u.element === "field:5.4:shapes" && u.form === "a namespace the row states in prose, with no example of its form"));
});

test("a named list that reserves vendor codes lists each of them: 500 is an API framework, and 499 and 10 aren't", () => {
  const lists = loadKernel(ROOT, SPEC).lists;
  const sentence = PRS.sentences.find((s) => /take any code in List:/.test(s.text))!;
  const api = readConstraints(PRS, lists).constraints.find((c) => c.element === sentence.id && c.at.member.name === "api");
  assert.ok(api && api.form === "values");
  assert.equal(api.vendor, 500);
  const plcmt = readConstraints(PRS, lists).constraints.find((c) => c.element === sentence.id && c.at.member.name === "plcmt");
  assert.ok(plcmt && plcmt.form === "values" && plcmt.vendor === undefined, "a list with no vendor codes is closed at its codes");
  const payload = (codes: number[]) => ({ placement: { api: codes } });
  assert.equal(violates(api, payload([7, 500, 1024])), false);
  assert.equal(violates(api, payload([499])), true);
  assert.equal(violates(api, payload([10])), true);
  const r = checkFidelity(gateInput());
  assert.ok(!r.disagreements.some((d) => d.constraint === api.id), r.disagreements.map((d) => d.detail).join("; "));
});
