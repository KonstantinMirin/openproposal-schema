import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appliedConstructors,
  bundle,
  checkApplied,
  checkConstructors,
  checkConstructorSources,
  checkMappingConstructors,
  checkNesting,
  copyName,
  copyStructures,
  fieldOf,
  Instantiator,
  loadConstructors,
  partSchema,
  partStructures,
  pascalField,
  type Constructor,
  type Model,
} from "../src/constructors.ts";
import { sharedStructures } from "../src/domains.ts";
import { checkDuplication } from "../src/duplication.ts";
import type { SpecIR } from "../src/ir-types.ts";
import { assertingAjv, kernelStructures, loadKernel } from "../src/kernel.ts";
import { inScope, loadDecisions, loadMappings, type MappingFile, type TypeRef } from "../src/mapping.ts";
import { ROOT, SPEC } from "./helpers.ts";

const MODEL: Model = { kernel: loadKernel(ROOT, SPEC), constructors: loadConstructors(ROOT, SPEC) };
const DECISIONS = loadDecisions(join(SPEC, "decisions"));
const LOCKS: [string, SpecIR][] = [
  ["main", JSON.parse(readFileSync(join(SPEC, "ir", "spec-ir.json"), "utf8")) as SpecIR],
  ["with-open-prs", JSON.parse(readFileSync(join(SPEC, "ir", "with-open-prs", "spec-ir.json"), "utf8")) as SpecIR],
];

const named = (name: string): TypeRef => ({ kind: "named", name });
const param = (name: string): TypeRef => ({ kind: "parameter", name });
const apply = (constructor: string, args: Record<string, TypeRef>, name?: string): Extract<TypeRef, { kind: "apply" }> => ({
  kind: "apply",
  constructor,
  arguments: args,
  ...(name === undefined ? {} : { name }),
});

/** The committed model with one constructor changed by `edit`. */
function withConstructor(name: string, edit: (c: Constructor) => void): Model {
  const m = structuredClone(MODEL);
  const c = m.constructors.constructors.find((x) => x.name === name);
  assert.ok(c, `no constructor ${name}`);
  edit(c);
  return m;
}

/** A mapping file whose entries give the named fields these types. */
function mapping(types: [string, TypeRef][]): MappingFile {
  return {
    format: 1,
    module: "test",
    sections: [],
    file: "mapping/test.yaml",
    entries: types.map(([ir, type]) => ({ ir, digest: "0".repeat(64), source: { rule: "test" }, as: { role: "property", object: "LineItem", type, presence: "optional" } })),
  };
}

const sound = (m: Model) => checkConstructors(ROOT, m, DECISIONS);

/** A copy of OpenProposal's folder for its kernel binding alone, with the binding's text changed. */
function specWith(change: (binding: string) => string): string {
  const text = readFileSync(join(SPEC, "kernel-binding.yaml"), "utf8");
  const changed = change(text);
  assert.notEqual(changed, text);
  const dir = join(mkdtempSync(join(tmpdir(), "op-binding-")), "openproposal");
  mkdirSync(dir);
  writeFileSync(join(dir, "kernel-binding.yaml"), changed);
  return dir;
}

test("the model defines the six constructors, their two parts, and the kernel's value object, each once", () => {
  assert.deepEqual(MODEL.constructors.constructors.map((c) => c.name).sort(), ["CatalogRefOr", "List", "Map", "Range", "Selectable", "Settable"]);
  assert.deepEqual(MODEL.constructors.parts.map((p) => p.name).sort(), ["CatalogReference", "DaypartWindow", "PriceDelta"]);
  assert.deepEqual(sound(MODEL), []);
  assert.deepEqual(checkDuplication([...kernelStructures(MODEL.kernel), ...partStructures(MODEL.constructors)], sharedStructures(MODEL.kernel.domains), true), []);
});

test("each constructor cites its spec rows, current on both locks", () => {
  for (const c of MODEL.constructors.constructors) assert.ok(c.sources.spec.length > 0, `${c.name} cites no spec row`);
  for (const [lock, ir] of LOCKS) assert.deepEqual(checkConstructorSources(ir, lock, MODEL.constructors), [], lock);
});

test("a changed spec row makes the constructor that cites it stale, and an edited quote differs from the IR", () => {
  const [lock, ir] = LOCKS[0]!;
  const changed = structuredClone(ir);
  const key = changed.keys.find((k) => k.id === "key:3.1:included[]")!;
  key.digest = "f".repeat(64);
  const stale = checkConstructorSources(changed, lock, MODEL.constructors);
  assert.ok(stale.some((p) => /Selectable: stale digest for "key:3\.1:included\[\]"/.test(p)), stale.join("\n"));
  const quoted = withConstructor("Range", (c) => (c.sources.spec[0]!.quote = "{ min, max }, edited by hand"));
  assert.match(checkConstructorSources(ir, lock, quoted.constructors).join("\n"), /Range: the quote for "field:5\.5:frequency_cap#description\/object:1" differs from the IR/);
});

test("a constructor that cites no row on a lock fails on that lock", () => {
  const m = withConstructor("List", (c) => c.sources.spec.forEach((s) => (s.locks = ["with-open-prs"])));
  assert.match(checkConstructorSources(LOCKS[0]![1], "main", m.constructors).join("\n"), /List: cites no spec row on lock "main"/);
  assert.deepEqual(checkConstructorSources(LOCKS[1]![1], "with-open-prs", m.constructors), []);
});

test("no committed template nests a constructor inside itself", () => {
  assert.deepEqual(checkNesting(MODEL, []), []);
});

test("a template that applies itself, directly or through another template, is nested", () => {
  const direct = withConstructor("List", (c) => (c.shell.items = { $model: apply("List", { T: param("T") }) }));
  assert.match(checkNesting(direct, []).join("\n"), /List: template: List is nested inside itself: List > List/);
  const m = withConstructor("Range", (c) => ((c.shell.properties as Record<string, unknown>).min = { $model: apply("CatalogRefOr", { T: param("T") }) }));
  const cat = m.constructors.constructors.find((c) => c.name === "CatalogRefOr")!;
  cat.shell.anyOf = [{ $model: param("T") }, { $model: apply("Range", { T: param("T") }) }];
  const cycle = checkNesting(m, []).join("\n");
  assert.match(cycle, /Range: template: Range is nested inside itself: Range > CatalogRefOr > Range/);
  assert.match(cycle, /CatalogRefOr: template: CatalogRefOr is nested inside itself: CatalogRefOr > Range > CatalogRefOr/);
});

test("a property type that nests a constructor inside itself fails, also through a template's shell", () => {
  const problems = checkNesting(MODEL, [
    mapping([
      ["field:5.6:pricing[]", apply("List", { T: apply("List", { T: named("ExternalId") }) })],
      ["field:5.2:formats", apply("Selectable", { T: apply("List", { T: named("ExternalId") }) })],
      ["field:5.3:audiences", apply("Selectable", { T: apply("Selectable", { T: named("ExternalId") }) })],
      ["field:5.2:properties", apply("CatalogRefOr", { T: apply("CatalogRefOr", { T: named("Property") }) })],
    ]),
  ]);
  assert.deepEqual(problems, [
    'mapping/test.yaml: entry "field:5.6:pricing[]": List is nested inside itself: List > List',
    'mapping/test.yaml: entry "field:5.2:formats": List is nested inside itself: Selectable > List > List',
    'mapping/test.yaml: entry "field:5.3:audiences": Selectable is nested inside itself: Selectable > Selectable',
    'mapping/test.yaml: entry "field:5.3:audiences": Selectable is nested inside itself: Selectable > List > Selectable',
    'mapping/test.yaml: entry "field:5.2:properties": CatalogRefOr is nested inside itself: CatalogRefOr > CatalogRefOr',
  ]);
});

test("a named type ends the nesting: a list inside an object inside a list is two expressions", () => {
  assert.deepEqual(checkNesting(MODEL, [mapping([["field:5.6:pricing[]", apply("List", { T: named("PricingEntry") })], ["field:5.2:formats", apply("Selectable", { T: apply("CatalogRefOr", { T: named("Audience") }) })]])]), []);
});

test("copies are named after the field, or after the argument, and the fallback after the full form", () => {
  assert.equal(pascalField("negotiation_history[]"), "NegotiationHistory");
  assert.equal(pascalField("pricing[].floor"), "Floor");
  assert.equal(copyName(MODEL, apply("Selectable", { T: named("ExternalId") }), "formats"), "FormatsSelection");
  assert.equal(copyName(MODEL, apply("Settable", { T: named("ExternalId") }), "geo"), "GeoBounds");
  assert.equal(copyName(MODEL, apply("Range", { T: named("Count") }), "frequency_cap.max"), "MaxRange");
  assert.equal(copyName(MODEL, apply("CatalogRefOr", { T: named("Audience") }), "audiences"), "AudienceOrCatalogRef");
  assert.equal(copyName(MODEL, apply("List", { T: named("ExternalId") }), "formats"), null);
  assert.equal(copyName(MODEL, apply("Selectable", { T: named("ExternalId") }, "FormatChoice"), "formats"), "FormatChoice");

  const inst = new Instantiator(MODEL);
  assert.equal(inst.copy(apply("Selectable", { T: apply("CatalogRefOr", { T: named("Audience") }), K: named("Uuid"), B: named("ExternalId") }), "audiences"), "AudiencesSelectionOrValue");
  assert.deepEqual([...inst.copies.keys()], ["AudienceOrCatalogRef", "AudiencesSelection", "AudiencesSelectionOrValue"]);
  const copy = inst.copies.get("AudiencesSelection")!.schema as { properties: Record<string, unknown> };
  assert.deepEqual(copy.properties.available, { type: "array", items: { $ref: "#/$defs/AudienceOrCatalogRef" } });
  // An object option is named by its `id`, a UUID, in `included[]` and the `pricing` keys.
  assert.deepEqual(copy.properties.included, {
    type: "array",
    items: { $ref: "#/$defs/Uuid" },
    description: "The options in the base rate, each named as `available[]` holds it: a string option by its value, and an object option by its `id`, the UUID the seller mints for it.",
  });
  assert.deepEqual(copy.properties.pricing, {
    type: "object",
    propertyNames: { $ref: "#/$defs/Uuid" },
    additionalProperties: { $ref: "#/$defs/PriceDelta" },
    description: "The change in price of each option beyond those included, keyed by the option's name: a string option's value, or an object option's `id`, the UUID the seller mints for it.",
  });
  assert.deepEqual(inst.copies.get("AudiencesSelectionOrValue")!.schema.anyOf, [{ $ref: "#/$defs/ExternalId" }, { $ref: "#/$defs/AudiencesSelection" }]);
  assert.deepEqual(inst.copies.get("AudienceOrCatalogRef")!.schema.anyOf, [{ $ref: "#/$defs/Audience" }, { $ref: "#/$defs/CatalogReference" }]);
});

test("a copy uses only standard 2020-12 keywords and no union keyword but anyOf", () => {
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        keys.add(k);
        if (k !== "properties" && k !== "dependentSchemas" && k !== "$defs") walk(x);
        else Object.values(x as object).forEach(walk);
      }
    }
  };
  for (const c of MODEL.constructors.constructors) for (const b of c.vectors) walk(bundle(MODEL, apply(c.name, b.arguments)));
  const allowed = ["$schema", "$defs", "$ref", "description", "type", "properties", "required", "additionalProperties", "propertyNames", "items", "anyOf", "minProperties", "maxProperties", "dependentSchemas", "pattern", "format", "minimum", "maximum", "maxLength", "enum", "if", "then", "const", "minItems", "uniqueItems"];
  assert.deepEqual([...keys].filter((k) => !allowed.includes(k)), []);
});

test("two different copies with one name fail, the same copy used twice doesn't, and a copy can't take a defined name", () => {
  const same = checkMappingConstructors(MODEL, [mapping([["field:5.5:frequency_cap.max", apply("Range", { T: named("Count") })], ["key:5.9:pacing.max", apply("Range", { T: named("Count") })]])]);
  assert.deepEqual(same, []);
  const clash = checkMappingConstructors(MODEL, [mapping([["field:5.5:frequency_cap.max", apply("Range", { T: named("Count") })], ["key:5.9:flight.max", apply("Range", { T: named("Timestamp") })]])]);
  assert.deepEqual(clash, ['mapping/test.yaml: entry "key:5.9:flight.max": two different copies are both named "MaxRange": Range<T=Count> and Range<T=Timestamp>']);
  const taken = checkMappingConstructors(MODEL, [mapping([["field:5.6:price_delta", apply("Settable", { T: named("ExternalId") }, "PriceDelta")]])]);
  assert.match(taken.join("\n"), /PriceDelta: the copy Settable<T=ExternalId> takes the name of a type the model already defines/);
});

test("arguments must fit the parameters", () => {
  const problems = checkMappingConstructors(MODEL, [
    mapping([
      ["field:a", apply("Range", { T: named("ExternalId") })],
      ["field:b", apply("Map", { K: named("Count"), V: named("ExternalId") })],
      ["field:c", apply("List", { T: { kind: "boolean" } })],
      ["field:d", apply("Selectable", { B: named("ExternalId") })],
      ["field:l", apply("Selectable", { T: named("FormatId"), K: named("ExternalId") })],
      ["field:m", apply("Selectable", { T: named("PriceDelta"), K: named("ExternalId") })],
      ["field:e", apply("List", { T: named("ExternalId"), U: named("ExternalId") })],
      ["field:f", apply("Optional", { T: named("ExternalId") })],
      ["field:g", apply("List", { T: param("T") })],
      ["field:h", apply("Map", { K: named("PriceDelta"), V: named("ExternalId") })],
      ["field:5.9:flight", apply("Range", { T: named("Timestamp") })],
      ["field:j", apply("Settable", { T: named("Count") })],
    ]),
  ]);
  assert.deepEqual(problems, [
    'mapping/test.yaml: entry "field:a": Range\'s T accepts a primitive whose values are ordered (a number or a date-time), not ExternalId',
    'mapping/test.yaml: entry "field:b": Map\'s K accepts a type whose values are strings, not Count',
    'mapping/test.yaml: entry "field:c": List\'s T accepts a named type or a named copy, not boolean (type rules § 4)',
    'mapping/test.yaml: entry "field:d": Selectable needs an argument for T',
    'mapping/test.yaml: entry "field:d": Selectable needs an argument for K',
    "mapping/test.yaml: entry \"field:l\": Selectable's K names an option of T, FormatId, so it is FormatId, not ExternalId: a string option is named by its value, and an object option by its `id`, a `Uuid` (D-007)",
    "mapping/test.yaml: entry \"field:m\": Selectable's K names an option of T, PriceDelta, so it is Uuid, not ExternalId: a string option is named by its value, and an object option by its `id`, a `Uuid` (D-007)",
    'mapping/test.yaml: entry "field:e": List has no parameter "U"',
    'mapping/test.yaml: entry "field:f": no constructor "Optional"',
    'mapping/test.yaml: entry "field:g": parameter "T" outside a template',
    'mapping/test.yaml: entry "field:h": Map\'s K accepts a type whose values are strings, not PriceDelta',
    "mapping/test.yaml: entry \"field:j\": Settable's T accepts a named type or a named copy that isn't an ordered primitive, so it has no `min` / `max` range, not Count",
  ]);
});

test("a settable type without an order gets no range, so min and max are bounds of an ordered type only", () => {
  const unordered = bundle(MODEL, apply("Settable", { T: named("ExternalId") }), "geo");
  const validate = assertingAjv().compile(unordered);
  assert.equal(validate({ allowed: ["US"] }), true);
  assert.equal(validate({ min: "zz", max: "aa" }), false);
  const ordered = assertingAjv().compile(bundle(MODEL, apply("Range", { T: named("Timestamp") }), "flight"));
  assert.equal(ordered({ min: "2026-10-06T00:00:00-04:00" }), true);
  assert.equal(ordered({ allowed: ["2026-10-06T00:00:00-04:00"] }), false);
});

test("CatalogRefOr takes only a closed type, so a value can't carry both an inline value and a catalog_ref", () => {
  const open = structuredClone(MODEL);
  delete open.constructors.parts.find((p) => p.name === "PriceDelta")!.shell.additionalProperties;
  assert.match(sound(open).join("\n"), /CatalogRefOr: vectors\[0\]: CatalogRefOr's T accepts a type whose values aren't objects, or are objects that reject the members they don't name, so a value can't carry both it and a `catalog_ref`, not PriceDelta/);
  const types: MappingFile = {
    format: 1,
    module: "test",
    sections: [],
    file: "mapping/test.yaml",
    entries: [
      { ir: "field:5.2:environments#description/values:1", digest: "0".repeat(64), source: { rule: "test" }, as: { role: "type", name: "Environment", layer: "vocabulary" } },
      { ir: "field:5.3:audiences#description/object:1", digest: "0".repeat(64), source: { rule: "test" }, as: { role: "type", name: "Audience", layer: "object" } },
    ],
  };
  const problems = checkMappingConstructors(MODEL, [
    types,
    mapping([
      ["field:5.2:environments", apply("Selectable", { T: apply("CatalogRefOr", { T: named("Environment") }), K: named("Uuid") })],
      ["field:5.3:audiences", apply("Selectable", { T: apply("CatalogRefOr", { T: named("Audience") }), K: named("Uuid") })],
      ["field:5.4:formats", apply("Selectable", { T: apply("CatalogRefOr", { T: apply("Settable", { T: named("ExternalId") }) }), K: named("Uuid") })],
    ]),
  ]);
  assert.deepEqual(problems, [
    "mapping/test.yaml: entry \"field:5.3:audiences\": CatalogRefOr's T accepts a type whose values aren't objects, or are objects that reject the members they don't name, so a value can't carry both it and a `catalog_ref`, and the model doesn't say whether Audience is closed (rule:2.2:696ee27b)",
  ]);
});

test("a copy is named after the field or the object member its entry's IR element names", () => {
  const ids = new Set([...LOCKS[0]![1].fields.map((f) => f.id), ...LOCKS[0]![1].keys.map((k) => k.id), ...LOCKS[0]![1].value_lists.map((v) => v.id), ...LOCKS[0]![1].inline_objects.map((o) => o.id)]);
  const real = ["field:5.4:creative_delivery#description/object:1/method", "field:5.8:required_credentials[]#description/object:1/scheme", "field:5.6:pricing[].floor", "key:5.6.1:commitment.basis", "field:4.1:negotiation_history[]", "field:5.5:frequency_cap#description/object:1", "field:4.1:valid_from,valid_until"];
  for (const id of real) assert.ok(ids.has(id), `${id} isn't in the IR`);
  assert.deepEqual(fieldOf("field:5.4:creative_delivery#description/object:1/method"), { field: "method" });
  assert.deepEqual(fieldOf("field:5.8:required_credentials[]#description/object:1/scheme"), { field: "scheme" });
  assert.deepEqual(fieldOf("field:5.6:pricing[].floor"), { field: "pricing[].floor" });
  assert.deepEqual(fieldOf("key:5.6.1:commitment.basis"), { field: "commitment.basis" });
  assert.deepEqual(fieldOf("field:5.5:frequency_cap#description/object:1/max"), { field: "max" });
  assert.deepEqual(fieldOf("field:5.5:frequency_cap#description/object:1/max.min"), { field: "max.min" });
  assert.match((fieldOf("field:5.5:frequency_cap#description/object:1") as { problem: string }).problem, /names no field, key, or object member/);
  assert.match((fieldOf("field:4.1:valid_from,valid_until") as { problem: string }).problem, /names more than one field/);
  assert.match((fieldOf("rule:3.2:ee009430") as { problem: string }).problem, /names no field, key, or object member/);

  const named_ = checkMappingConstructors(MODEL, [
    mapping([
      ["field:5.4:creative_delivery#description/object:1/method", apply("Settable", { T: named("ExternalId") })],
      ["field:5.5:frequency_cap#description/object:1/max", apply("Range", { T: named("Count") })],
      ["key:5.6.1:commitment.basis", apply("Settable", { T: named("ExternalId") })],
    ]),
  ]);
  assert.deepEqual(named_, []);
  const copies = copyStructures(MODEL, [mapping([["field:5.4:creative_delivery#description/object:1/method", apply("Settable", { T: named("ExternalId") })], ["field:5.5:frequency_cap#description/object:1/max", apply("Range", { T: named("Count") })]])]);
  assert.deepEqual(copies.map((c) => c.name), ["MethodBounds", "MaxRange"]);

  const unnamed = checkMappingConstructors(MODEL, [
    mapping([
      ["field:5.5:frequency_cap#description/object:1", apply("Range", { T: named("Count") })],
      ["field:4.1:valid_from,valid_until", apply("Range", { T: named("Timestamp") })],
      ["field:4.1:valid_from,valid_until#x", apply("Range", { T: named("Timestamp") }, "ValidityRange")],
      ["field:5.4:creative_delivery#description/object:1/3d_format", apply("Settable", { T: named("ExternalId") })],
    ]),
  ]);
  assert.deepEqual(unnamed, [
    'mapping/test.yaml: entry "field:5.5:frequency_cap#description/object:1": a copy of Range is named after its field, and none is given; name the copy with a decision record ("field:5.5:frequency_cap#description/object:1" names no field, key, or object member)',
    'mapping/test.yaml: entry "field:4.1:valid_from,valid_until": a copy of Range is named after its field, and none is given; name the copy with a decision record ("field:4.1:valid_from,valid_until" names more than one field)',
    "3dFormatBounds: the copy Settable<T=ExternalId> gets a name that isn't a model type name (^[A-Z][A-Za-z0-9]*$)",
  ]);
});

test("copies of one application are one definition, not twins, but a copy still can't twin another type", () => {
  const copies = copyStructures(MODEL, [mapping([["field:5.4:formats", apply("Selectable", { T: named("ExternalId"), K: named("ExternalId") })], ["field:5.4:production", apply("Selectable", { T: named("ExternalId"), K: named("ExternalId") })]])]);
  assert.deepEqual(copies.map((c) => c.name), ["FormatsSelection", "ProductionSelection"]);
  assert.deepEqual(checkDuplication([...kernelStructures(MODEL.kernel), ...partStructures(MODEL.constructors), ...copies], sharedStructures(MODEL.kernel.domains), true), []);
  const twin = { name: "OptionChoice", structure: copies[0]!.structure, where: "mapping/test.yaml" };
  const problems = checkDuplication([...copies, twin]);
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /"FormatsSelection" and "OptionChoice" have the same structure/);
  assert.match(problems.join("\n"), /"OptionChoice" and "ProductionSelection" have the same structure/);
});

test("a template that passes a parameter where it doesn't fit, or names an unknown type, fails", () => {
  const wide = withConstructor("Selectable", (c) => (c.parameters[0]!.accepts = "any"));
  assert.match(sound(wide).join("\n"), /Selectable: shell: List's T accepts named, but parameter T accepts any/);
  const unknown = withConstructor("Selectable", (c) => ((c.shell.properties as Record<string, unknown>).max_select = { $model: named("OptionCount") }));
  assert.match(sound(unknown).join("\n"), /Selectable: shell: "OptionCount" is neither a primitive nor a part/);
  const unused = withConstructor("Range", (c) => c.parameters.push({ name: "U", accepts: "named", description: "A parameter no slot uses." }));
  assert.match(sound(unused).join("\n"), /Range: parameter U isn't used in the shell/);
});

test("the vectors hold: a dropped constraint lets an invalid vector through", () => {
  const m = withConstructor("Settable", (c) => delete c.shell.additionalProperties);
  assert.deepEqual(sound(m), [
    `${MODEL.constructors.file}: Settable: vectors[0]: invalid vector {"allowed":["US"],"max":"US-CA"} is accepted by the copy Settable<T=ExternalId>`,
  ]);
  const empty = withConstructor("Range", (c) => delete c.shell.minProperties);
  assert.deepEqual(sound(empty), [`${MODEL.constructors.file}: Range: vectors[0]: invalid vector {} is accepted by the copy Range<T=Count>`]);
});

test("a rule vector the schema rejects fails, since a rule adds only what the schema can't check", () => {
  const m = withConstructor("Range", (c) => c.rules![0]!.invalid.push({ min: -1, max: 1 }));
  assert.match(sound(m).join("\n"), /Range: rule "constructor:Range:ordered": rule vector \{"min":-1,"max":1\} is rejected by the copy Range<T=Count>/);
  const owner = withConstructor("Range", (c) => (c.rules![0]!.id = "constructor:Selectable:options-named"));
  assert.match(sound(owner).join("\n"), /rule "constructor:Selectable:options-named" is defined twice/);
  assert.match(sound(owner).join("\n"), /Range: rule "constructor:Selectable:options-named" must be named constructor:Range:<token>/);
});

test("the fallback is a union of the bare value and the full form, only when the use supplies it", () => {
  const without = bundle(MODEL, apply("Selectable", { T: named("FormatId"), K: named("FormatId") }), "formats");
  assert.equal(without.$ref, "#/$defs/FormatsSelection");
  assert.equal("FormatsSelectionOrValue" in (without.$defs as object), false);
  const m = withConstructor("Selectable", (c) => (c.fallback!.statement = "rule:3.1:00000000"));
  assert.match(sound(m).join("\n"), /Selectable: the fallback statement "rule:3\.1:00000000" isn't one of its spec sources/);
});

test("a mapping entry can't define a constructor or a part", () => {
  const m: MappingFile = { format: 1, module: "test", sections: [], file: "mapping/test.yaml", entries: [{ ir: "key:3.1:pricing#meaning/object:1", digest: "0".repeat(64), source: { rule: "test" }, as: { role: "type", name: "PriceDelta", layer: "constructor" } }] };
  assert.deepEqual(checkMappingConstructors(MODEL, [m]), [`mapping/test.yaml: entry "key:3.1:pricing#meaning/object:1" defines "PriceDelta", which kernel/constructors.yaml defines`]);
});

test("the constructors schema rejects a shell keyword outside the allowed set, and a constraint beside a slot", () => {
  const raw = readFileSync(join(ROOT, "kernel", "constructors.yaml"), "utf8");
  const rejects = (edited: string, pattern: RegExp) => {
    assert.notEqual(edited, raw);
    const dir = mkdtempSync(join(tmpdir(), "op-constructors-"));
    writeFileSync(join(dir, "constructors.yaml"), edited);
    assert.throws(() => loadConstructors(ROOT, SPEC, join(dir, "constructors.yaml")), pattern);
  };
  rejects(raw.replace("        max_select: { $model: { kind: named, name: Count } }", "        max_select: { $model: { kind: named, name: Count }, minimum: 1 }"), /not a valid constructors file/);
  rejects(raw.replace("      required: [available, included]\n", "      required: [available, included]\n      allOf: [{ required: [available] }]\n"), /not a valid constructors file/);
  rejects(raw.replace("      items: { $model: { kind: parameter, name: T } }", "      items: { $model: { kind: parameter, name: T } }\n      x-op-generic: List"), /not a valid constructors file/);
  // A fallback's decision is the spec's: with none in the binding, the constructor isn't valid.
  assert.throws(() => loadConstructors(ROOT, specWith((b) => b.replace("      statement: rule:3.1:f8b0c287\n      decision: D-008\n", "      statement: rule:3.1:f8b0c287\n"))), /not a valid constructors file/);
});

test("a fallback cites an existing decision", () => {
  const m = withConstructor("Settable", (c) => (c.fallback!.decision = "D-999"));
  assert.match(sound(m).join("\n"), /Settable: fallback: cites decision "D-999", which doesn't exist/);
});

test("the member an object option carries cites an existing decision", () => {
  const m = withConstructor("Selectable", (c) => (c.parameters.find((p) => p.name === "K")!.carries!.decision = "D-999"));
  assert.match(sound(m).join("\n"), /Selectable: parameter K carries: cites decision "D-999", which doesn't exist/);
});

test("a part cites each decision behind it, and each must exist", () => {
  const m = structuredClone(MODEL);
  const part = m.constructors.parts.find((p) => p.name === "DaypartWindow")!;
  assert.deepEqual(part.decisions, [{ decision: "D-004", locks: ["main"] }, { decision: "D-038", locks: ["main"] }, { decision: "D-045" }]);
  part.decisions = [{ decision: "D-004" }, { decision: "D-999" }];
  assert.match(sound(m).join("\n"), /DaypartWindow: cites decision "D-999", which doesn't exist/);
  assert.throws(() => loadConstructors(ROOT, specWith((b) => b.replace("      - { decision: D-045 }\n", "    decision: D-045\n"))), /not a valid constructors file/, "a part lists its decisions");
});

test("a part bounds a list slot only, and only with minItems and uniqueItems, so the bounds sit on the list itself", () => {
  const raw = readFileSync(join(ROOT, "kernel", "constructors.yaml"), "utf8");
  const days = "        days: { $model: { kind: apply, constructor: List, arguments: { T: { kind: named, name: DayName } } }, minItems: 1, uniqueItems: true }\n";
  assert.ok(raw.includes(days));
  const load = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), "op-constructors-"));
    writeFileSync(join(dir, "constructors.yaml"), text);
    return () => loadConstructors(ROOT, SPEC, join(dir, "constructors.yaml"));
  };
  assert.throws(load(raw.replace("        start: { $model: { kind: named, name: TimeOfDay } }\n", "        start: { $model: { kind: named, name: TimeOfDay }, minItems: 1 }\n")), /not a valid constructors file/, "a bound beside a slot that holds no list");
  assert.throws(load(raw.replace(days, days.replace("uniqueItems: true", "maxItems: 7"))), /not a valid constructors file/, "a list keyword other than the two bounds");
  assert.throws(load(raw.replace(days, days.replace(", minItems: 1, uniqueItems: true", "") + "        dependentSchemas: { days: { properties: { days: { type: array, minItems: 1 } } } }\n")), /not a valid constructors file/, "a bound in dependentSchemas, which a generator drops");
  const loaded = load(raw)();
  const part = loaded.parts.find((p) => p.name === "DaypartWindow")!;
  assert.deepEqual(partSchema(part, loaded).properties, { days: { type: "array", items: { $ref: "#/$defs/DayName" }, minItems: 1, uniqueItems: true }, start: { $ref: "#/$defs/TimeOfDay" }, end: { $ref: "#/$defs/TimeOfDay" } });
});

test("every constructor is applied on some lock, Map inside Selectable's pricing, or a decision keeps it", () => {
  const mappings = loadMappings(join(SPEC, "mapping"));
  assert.deepEqual(checkApplied(MODEL, mappings, DECISIONS), []);
  // On main, no entry applies Map; Selectable's shell does.
  const main = mappings.map((m) => ({ ...m, entries: m.entries.filter((e) => inScope(e.locks, "main")), types: (m.types ?? []).filter((d) => inScope(d.locks, "main")) }));
  assert.equal(JSON.stringify(main).includes('"constructor":"Map"'), false);
  assert.deepEqual([...appliedConstructors(MODEL, main)].sort(), ["CatalogRefOr", "List", "Map", "Range", "Selectable", "Settable"]);
  // A template's shell counts only once something applies the template.
  assert.deepEqual([...appliedConstructors(MODEL, [mapping([["field:5.4:formats", apply("Selectable", { T: named("FormatId"), K: named("FormatId") })]])])].sort(), ["List", "Map", "Selectable"]);
  // A part the mapping reaches applies what its shell applies: DaypartWindow's days are a List.
  assert.deepEqual([...appliedConstructors(MODEL, [mapping([["field:5.5:daypart", named("DaypartWindow")]])])], ["List"]);
  const only = [mapping([["field:5.5:geo", apply("Settable", { T: named("ExternalId") })]])];
  assert.deepEqual(checkApplied(MODEL, only, DECISIONS), [
    `${MODEL.constructors.file}: Selectable: no mapping entry or applied template applies it on any lock; apply it, remove it, or cite under \`kept\` the decision that says why it stays`,
    `${MODEL.constructors.file}: Range: no mapping entry or applied template applies it on any lock; apply it, remove it, or cite under \`kept\` the decision that says why it stays`,
    `${MODEL.constructors.file}: CatalogRefOr: no mapping entry or applied template applies it on any lock; apply it, remove it, or cite under \`kept\` the decision that says why it stays`,
    `${MODEL.constructors.file}: Map: no mapping entry or applied template applies it on any lock; apply it, remove it, or cite under \`kept\` the decision that says why it stays`,
  ]);
  const kept = withConstructor("Range", (c) => (c.kept = { decision: "D-011", reason: "A range template for a field the next draft bounds." }));
  assert.deepEqual(checkApplied(kept, only, DECISIONS).filter((p) => p.includes("Range")), []);
  assert.deepEqual(checkApplied(kept, mappings, DECISIONS), [`${MODEL.constructors.file}: Range: is applied on some lock, so its \`kept\` is stale; remove it`]);
});
