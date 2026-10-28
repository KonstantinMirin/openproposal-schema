import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConstructors } from "../src/constructors.ts";
import {
  besideReferenceProblems,
  checkConventions,
  cycles,
  dependsProblems,
  inlineProblems,
  keywordProblems,
  layerProblems,
  listProblems,
  modelStructures,
  moduleProblems,
  unionProblems,
  unstated,
  unstatedVocabularies,
} from "../src/conventions.ts";
import { sharedStructures } from "../src/domains.ts";
import { checkDuplication } from "../src/duplication.ts";
import type { SpecIR } from "../src/ir-types.ts";
import { loadKernel } from "../src/kernel.ts";
import { loadDecisions, loadMappings, type MappingFile, type TypeRef } from "../src/mapping.ts";
import { resolveModel, type ModelDoc, type ModelType } from "../src/model.ts";
import { ROOT, SPEC } from "./helpers.ts";

const KERNEL = loadKernel(ROOT, SPEC);
const CONSTRUCTORS = loadConstructors(ROOT, SPEC);
const MAPPINGS = loadMappings(join(SPEC, "mapping"));
const DECISIONS = loadDecisions(join(SPEC, "decisions"));
const LOCKS: [string, SpecIR][] = [
  ["main", JSON.parse(readFileSync(join(SPEC, "ir", "spec-ir.json"), "utf8")) as SpecIR],
  ["with-open-prs", JSON.parse(readFileSync(join(SPEC, "ir", "with-open-prs", "spec-ir.json"), "utf8")) as SpecIR],
];
const MODELS = LOCKS.map(([lock, ir]) => resolveModel({ ir, lock, mappings: MAPPINGS, decisions: DECISIONS, kernel: KERNEL, constructors: CONSTRUCTORS }).model);
const MODEL = MODELS[1]!;

const named = (name: string): TypeRef => ({ kind: "named", name });
const list = (t: TypeRef): TypeRef => ({ kind: "apply", constructor: "List", arguments: { T: t } });

/** The with-open-prs model with one type changed by `edit`. */
function edited(name: string, edit: (t: ModelType) => void): ModelDoc {
  const copy = structuredClone(MODEL);
  const t = copy.types.find((x) => x.name === name);
  assert.ok(t, `no type ${name}`);
  edit(t);
  return copy;
}

test("every convention holds on the committed model of each lock", () => {
  for (const model of MODELS) {
    for (const [gate, problems] of Object.entries(checkConventions(model, MAPPINGS, KERNEL, CONSTRUCTORS, DECISIONS))) assert.deepEqual(problems, [], `${model.input.lock}: ${gate}`);
    const vocabularies = unstatedVocabularies(model, DECISIONS);
    assert.deepEqual(vocabularies.problems, [], model.input.lock);
    assert.deepEqual(checkDuplication(modelStructures(model, KERNEL, CONSTRUCTORS, vocabularies.names), sharedStructures(KERNEL.domains)), [], model.input.lock);
  }
  assert.deepEqual(dependsProblems(MODELS, MAPPINGS), []);
});

test("cycles finds every strongly connected component with more than one node, or a self-loop", () => {
  const g: Record<string, string[]> = { a: ["b"], b: ["c"], c: ["a"], d: ["d"], e: ["a"] };
  assert.deepEqual(
    cycles(Object.keys(g), (n) => g[n] ?? []),
    [["a", "b", "c"], ["d"]],
  );
  assert.deepEqual(cycles(["x", "y"], (n) => (n === "x" ? ["y"] : [])), []);
});

test("a reference to a higher layer, or a cycle, fails the layer gate", () => {
  const up = edited("Channel", (t) => t.references.push("Commitment"));
  assert.match(layerProblems(up).join("\n"), /vocabulary "Channel" \(layer 3\) references the object "Commitment" \(layer 4\)/);
  const loop = structuredClone(MODEL);
  loop.types.find((t) => t.name === "Commitment")!.references.push("HoldStatus");
  loop.types.find((t) => t.name === "HoldStatus")!.references.push("Commitment");
  assert.match(layerProblems(loop).join("\n"), /the types "Commitment", "HoldStatus" reference each other in a cycle/);
  const missing = edited("Commitment", (t) => t.references.push("Ghost"));
  assert.match(layerProblems(missing).join("\n"), /references "Ghost", which the model doesn't define/);
});

test("a reference to a module that depends doesn't list, or from the kernel to a module, fails", () => {
  const undeclared = structuredClone(MAPPINGS);
  undeclared.find((m) => m.module === "targeting")!.depends = [];
  assert.match(moduleProblems(MODEL, undeclared).join("\n"), /mapping\/targeting\.yaml: object "AppBundleEntry" references "StorePlatform" of module "inventory", which "depends" doesn't list/);
  const kernel = edited("Marker", (t) => t.references.push("Channel"));
  assert.match(moduleProblems(kernel, MAPPINGS).join("\n"), /kernel: vocabulary "Marker" references "Channel" of module "line-item"; the kernel references no module/);
});

test("an unused, self, kernel, or unknown depends entry, or a cycle of depends, fails", () => {
  const withDeps = (deps: Record<string, string[]>): MappingFile[] => structuredClone(MAPPINGS).map((m) => (m.module in deps ? { ...m, depends: deps[m.module] } : m));
  const unused = dependsProblems(MODELS, withDeps({ audience: ["settlement"] }));
  assert.match(unused.join("\n"), /"depends" lists "settlement", but no type of "audience" references a type of "settlement" on any lock; remove it/);
  const odd = dependsProblems(MODELS, withDeps({ audience: ["audience", "kernel", "nowhere"] })).join("\n");
  assert.match(odd, /lists "audience", which is the module itself/);
  assert.match(odd, /lists "kernel", which is the kernel/);
  assert.match(odd, /lists "nowhere", which is no module/);
  const loop = dependsProblems(MODELS, withDeps({ inventory: ["targeting"] })).join("\n");
  assert.match(loop, /the modules "inventory", "targeting" depend on each other in a cycle/);
});

test("an inline form other than the boolean or a list or map of named types fails", () => {
  const nested = edited("Commitment", (t) => {
    if (t.kind === "object") t.properties.amount!.type = list(list(named("Amount")));
  });
  assert.match(inlineProblems(nested, CONSTRUCTORS).join("\n"), /property "amount": List<T=List<T=Amount>> is inline, and an inline list or map holds named types or named copies only/);
  const booleans = edited("Commitment", (t) => {
    if (t.kind === "object") t.properties.amount!.type = list({ kind: "boolean" });
  });
  assert.match(inlineProblems(booleans, CONSTRUCTORS).join("\n"), /List<T=boolean> is inline/);
  const parameter = edited("Geo", (t) => {
    if (t.kind === "union") t.any_of.push({ kind: "parameter", name: "T" });
  });
  assert.match(inlineProblems(parameter, CONSTRUCTORS).join("\n"), /parameter "T" outside a template/);
  // A list of named copies is fine.
  const copies = edited("Commitment", (t) => {
    if (t.kind === "object") t.properties.amount!.type = list({ kind: "apply", constructor: "Range", arguments: { T: named("Amount") } });
  });
  assert.deepEqual(inlineProblems(copies, CONSTRUCTORS), []);
});

test("a constraint beside a $ref, an extra key on a slot, or a constraint on a property fails", () => {
  const beside = edited("FormatsSelection", (t) => {
    if (t.kind === "copy") (t.schema.properties as Record<string, Record<string, unknown>>).max_select!.minimum = 1;
  });
  assert.match(besideReferenceProblems(beside).join("\n"), /copy "FormatsSelection" at \/properties\/max_select: "minimum" beside a \$ref/);
  const slot = edited("Range", (t) => {
    if (t.kind === "constructor") ((t.shell.properties as Record<string, Record<string, unknown>>).min!).pattern = "^x$";
  });
  assert.match(besideReferenceProblems(slot).join("\n"), /constructor "Range": a slot carries "pattern"/);
  const property = edited("Commitment", (t) => {
    if (t.kind === "object") (t.properties.amount as unknown as Record<string, unknown>).maximum = 10;
  });
  assert.match(besideReferenceProblems(property).join("\n"), /property "amount" carries "maximum" beside its type/);
});

test("a non-standard keyword fails, in a schema or in a shell", () => {
  const custom = edited("PriceDelta", (t) => {
    if (t.kind === "part") t.schema["x-openproposal-marker"] = "seller-set";
  });
  assert.match(keywordProblems(custom).join("\n"), /part "PriceDelta": "x-openproposal-marker" is no standard JSON Schema 2020-12 keyword/);
  const discriminator = edited("CatalogRefOr", (t) => {
    if (t.kind === "constructor") t.shell.discriminator = { propertyName: "kind" };
  });
  assert.match(keywordProblems(discriminator).join("\n"), /constructor "CatalogRefOr": shell: "discriminator"/);
  const dynamic = edited("FormatsSelection", (t) => {
    if (t.kind === "copy") (t.schema.properties as Record<string, Record<string, unknown>>).available!.$dynamicRef = "#T";
  });
  assert.match(keywordProblems(dynamic).join("\n"), /at \/properties\/available: "\$dynamicRef"/);
});

test("allOf, a stray anyOf, an untagged oneOf, and a union with no decision fail the union gate", () => {
  const allOf = edited("PriceDelta", (t) => {
    if (t.kind === "part") t.schema.allOf = [{ $ref: "#/$defs/Id" }];
  });
  assert.match(unionProblems(allOf, CONSTRUCTORS).join("\n"), /part "PriceDelta": "allOf"/);
  const anyOf = edited("FormatsSelection", (t) => {
    if (t.kind === "copy") (t.schema.properties as Record<string, unknown>).max_select = { anyOf: [{ $ref: "#/$defs/Count" }, { type: "boolean" }] };
  });
  assert.match(unionProblems(anyOf, CONSTRUCTORS).join("\n"), /copy "FormatsSelection" at \/properties\/max_select: "anyOf" where type rules § 8 allows none/);
  const branch = (tag: unknown) => ({ type: "object", required: ["kind"], properties: { kind: { const: tag } } });
  const tagged = edited("PriceDelta", (t) => {
    if (t.kind === "part") t.schema.oneOf = [branch("a"), branch("b")];
  });
  assert.deepEqual(unionProblems(tagged, CONSTRUCTORS), []);
  const untagged = edited("PriceDelta", (t) => {
    if (t.kind === "part") t.schema.oneOf = [branch("a"), { type: "object" }];
  });
  assert.match(unionProblems(untagged, CONSTRUCTORS).join("\n"), /oneOf branch 1 has no required property with a "const" value/);
  const same = edited("PriceDelta", (t) => {
    if (t.kind === "part") t.schema.oneOf = [branch("a"), branch("a")];
  });
  assert.match(unionProblems(same, CONSTRUCTORS).join("\n"), /two oneOf branches have the same tag/);
  const undecided = edited("Geo", (t) => {
    t.decisions = [];
    if (t.kind === "union") t.any_of = t.any_of.slice(0, 1);
  });
  const problems = unionProblems(undecided, CONSTRUCTORS).join("\n");
  assert.match(problems, /union "Geo" cites no decision record/);
  assert.match(problems, /union "Geo" has 1 branch\(es\)/);
});

test("two lists with the same values, or an inline enum, fail the list gate", () => {
  const twin = edited("HoldScope", (t) => {
    if (t.kind === "vocabulary") t.terms = [{ value: "buyer", sources: [] }, { value: "seller", sources: [] }];
  });
  assert.match(listProblems(twin).join("\n"), /"HoldScope", "Party" list the same values/);
  const weekday = edited("HoldScope", (t) => {
    if (t.kind === "vocabulary") t.terms = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].map((value) => ({ value, sources: [] }));
  });
  assert.match(listProblems(weekday).join("\n"), /"DayName", "HoldScope" list the same values/);
  const inline = edited("FormatsSelection", (t) => {
    if (t.kind === "copy") (t.schema.properties as Record<string, unknown>).mode = { enum: ["a", "b"] };
  });
  assert.match(listProblems(inline).join("\n"), /copy "FormatsSelection" at \/properties\/mode: an inline "enum"/);
});

test("the duplication gate sees objects and vocabularies, and sets aside only open objects with no members and the empty vocabularies a decision lists", () => {
  const listed = unstatedVocabularies(MODEL, DECISIONS).names;
  const structures = modelStructures(MODEL, KERNEL, CONSTRUCTORS, listed);
  const left = MODEL.types.filter(unstated).map((t) => t.name);
  assert.ok(left.includes("Assent") && left.includes("CreativePolicy"));
  // An open option whose only member is the `id` the constructor gives it states nothing of its own either (D-046).
  assert.ok(left.includes("CancellationPolicyOption") && left.includes("ExclusivityOption"));
  assert.ok(!structures.some((s) => left.includes(s.name)));
  const stated = structuredClone(MODEL);
  const option = stated.types.find((t) => t.name === "ExclusivityOption") as Extract<ModelType, { kind: "object" }>;
  option.properties.term = { type: { kind: "named", name: "Text" }, presence: "optional", sources: [] };
  assert.ok(!stated.types.filter(unstated).some((t) => t.name === "ExclusivityOption"), "a member of its own makes it stated");
  assert.deepEqual([...listed].sort(), ["AssetApprovalStatus", "AvailabilityBasis", "AvailabilityUnit", "CreativeDeliveryProtocol", "MeasurementBasis", "Provenance", "ReportingDeliveryMechanism"]);
  assert.ok(!structures.some((s) => listed.has(s.name)));
  assert.ok(structures.some((s) => s.name === "Commitment") && structures.some((s) => s.name === "Channel"));
  const copy = structuredClone(MODEL);
  const hold = structuredClone(copy.types.find((t) => t.name === "HoldStatus")!);
  hold.name = "HoldStatusTwin";
  copy.types.push(hold);
  assert.match(checkDuplication(modelStructures(copy, KERNEL, CONSTRUCTORS, listed)).join("\n"), /"HoldStatus" and "HoldStatusTwin" have the same structure/);
});

test("an empty open vocabulary that no decision lists fails the duplication and value-list gates, and so does a stale listing", () => {
  // A twin of an empty vocabulary, under a name no decision lists.
  const twin = structuredClone(MODEL);
  twin.types.push({ ...structuredClone(twin.types.find((t) => t.name === "AvailabilityUnit")!), name: "ReportingFrequency" });
  const unlisted = unstatedVocabularies(twin, DECISIONS);
  assert.ok(unlisted.problems.some((p) => /vocabulary "ReportingFrequency": an open vocabulary with no core terms .* that no decision's sets_aside lists/.test(p)), unlisted.problems.join("\n"));
  assert.ok(listProblems(twin, DECISIONS).some((p) => /"ReportingFrequency": an open vocabulary with no core terms/.test(p)));
  // Without the listings, two empty vocabularies list the same values, and are twins.
  const bare = listProblems(MODEL, []);
  assert.ok(bare.some((p) => /"AssetApprovalStatus", "AvailabilityBasis", .* list the same values/.test(p)), bare.join("\n"));
  assert.ok(checkDuplication(modelStructures(MODEL, KERNEL, CONSTRUCTORS, new Set())).some((p) => /"AssetApprovalStatus" and "AvailabilityBasis" have the same structure/.test(p)));
  // A listing whose vocabulary has terms, is gone, or rests on another element is stale.
  const decisions = structuredClone(DECISIONS);
  const d041 = decisions.find((d) => d.id === "D-041")!;
  d041.sets_aside!.push({ type: "Channel", field: "channel", ir: "field:5.1:channel" }, { type: "ReportingCadence", field: "reporting.available[].cadence", ir: "field:5.7:reporting#description/object:1" });
  d041.sets_aside![0]!.ir = "field:5.4:assets[]";
  const stale = unstatedVocabularies(MODEL, decisions).problems;
  assert.ok(stale.some((p) => /sets_aside "Channel" \(channel\): it lists \d+ core terms .* so it has a structure/.test(p)), stale.join("\n"));
  assert.ok(stale.some((p) => /sets_aside "ReportingCadence" .*: no vocabulary of that name on lock "with-open-prs"/.test(p)), stale.join("\n"));
  assert.ok(stale.some((p) => /sets_aside "AssetApprovalStatus" .* not on D-041 and field:5\.4:assets\[\]$/.test(p)), stale.join("\n"));
});
test("two vocabularies of two code lists with the same numbers are two lists, and two of one list are one", () => {
  assert.deepEqual(listProblems(MODEL, DECISIONS), [], "API frameworks and placement subtypes both hold 1 to 9");
  const same = edited("ApiFramework", (t) => {
    if (t.kind === "vocabulary") t.list = { ...t.list!, name: "List: Plcmt Subtypes - Video" };
  });
  assert.match(listProblems(same, DECISIONS).join("\n"), /"ApiFramework", "PlcmtSubtype" list the same values/);
  const unlisted = structuredClone(MODEL);
  for (const t of unlisted.types) if ((t.name === "ApiFramework" || t.name === "PlcmtSubtype") && t.kind === "vocabulary") delete t.list;
  assert.match(listProblems(unlisted, DECISIONS).join("\n"), /"ApiFramework", "PlcmtSubtype" list the same values/);
});
