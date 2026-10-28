import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConstructors } from "../src/constructors.ts";
import type { SpecIR } from "../src/ir-types.ts";
import { loadKernel } from "../src/kernel.ts";
import { loadDecisions, loadMappings, type MappingFile } from "../src/mapping.ts";
import { renderModel, resolveModel, type ModelDoc, type ModelType } from "../src/model.ts";
import { ROOT, SPEC } from "./helpers.ts";

const KERNEL = loadKernel(ROOT, SPEC);
const CONSTRUCTORS = loadConstructors(ROOT, SPEC);
const MAPPINGS = loadMappings(join(SPEC, "mapping"));
const DECISIONS = loadDecisions(join(SPEC, "decisions"));
const LOCKS: [string, SpecIR][] = [
  ["main", JSON.parse(readFileSync(join(SPEC, "ir", "spec-ir.json"), "utf8")) as SpecIR],
  ["with-open-prs", JSON.parse(readFileSync(join(SPEC, "ir", "with-open-prs", "spec-ir.json"), "utf8")) as SpecIR],
];
const PRS = LOCKS[1]![1];

const resolve = (mappings: MappingFile[] = MAPPINGS, ir = PRS, lock = "with-open-prs") => resolveModel({ ir, lock, mappings, decisions: DECISIONS, kernel: KERNEL, constructors: CONSTRUCTORS });
const MODEL = resolve().model;

function typeOf<K extends ModelType["kind"]>(model: ModelDoc, name: string, kind: K): Extract<ModelType, { kind: K }> {
  const t = model.types.find((x) => x.name === name);
  assert.ok(t, `no type ${name}`);
  assert.equal(t.kind, kind);
  return t as Extract<ModelType, { kind: K }>;
}

/** The committed mapping with one file changed by `edit`. */
function edited(module: string, edit: (m: MappingFile) => void): MappingFile[] {
  const copy = structuredClone(MAPPINGS);
  const m = copy.find((x) => x.module === module);
  assert.ok(m, `no module ${module}`);
  edit(m);
  return copy;
}

test("the committed inputs resolve into a model on each lock with no problem", () => {
  for (const [lock, ir] of LOCKS) {
    const { model, problems } = resolve(MAPPINGS, ir, lock);
    assert.deepEqual(problems, [], `${lock}: ${problems.join("\n")}`);
    assert.equal(model.input.lock, lock);
    assert.equal(model.input.blob, ir.input.blob);
    const names = model.types.map((t) => t.name);
    assert.deepEqual(names, [...names].sort(), "types are sorted by name");
    assert.equal(new Set(names).size, names.length, "each name once");
  }
});

test("the model is the same bytes whatever order the mapping files, entries, and declarations come in", () => {
  const shuffled = structuredClone(MAPPINGS)
    .reverse()
    .map((m) => ({ ...m, entries: [...m.entries].reverse(), types: [...(m.types ?? [])].reverse() }));
  for (const [lock, ir] of LOCKS) {
    assert.equal(renderModel(resolve(shuffled, ir, lock).model), renderModel(resolve(MAPPINGS, ir, lock).model), lock);
  }
});

test("each kind of type sits in its layer, and a copy at the layer of the highest type it holds", () => {
  assert.equal(typeOf(MODEL, "Uuid", "primitive").layer, 1);
  assert.equal(typeOf(MODEL, "Selectable", "constructor").layer, 2);
  assert.equal(typeOf(MODEL, "PriceDelta", "part").layer, 2);
  assert.equal(typeOf(MODEL, "Channel", "vocabulary").layer, 3);
  assert.equal(typeOf(MODEL, "Commitment", "object").layer, 4);
  assert.equal(typeOf(MODEL, "LineItem", "document").layer, 5);
  assert.equal(typeOf(MODEL, "LineItemSummary", "profile").layer, 5);
  // Selectable<FormatId> holds primitives only; Selectable<CatalogRefOr<AudiencesOption>> holds an object.
  assert.equal(typeOf(MODEL, "FormatsSelection", "copy").layer, 2);
  const audiences = typeOf(MODEL, "AudiencesSelection", "copy");
  assert.equal(audiences.layer, 4);
  assert.equal(audiences.module, "audience");
  assert.equal(audiences.application, "Selectable<T=CatalogRefOr<T=AudiencesOption>, K=Uuid>");
  assert.deepEqual(audiences.references, ["AudiencesOptionOrCatalogRef", "Count", "PriceDelta", "Uuid"]);
  // A copy named after its argument belongs to the argument's module.
  assert.equal(typeOf(MODEL, "AudiencesOptionOrCatalogRef", "copy").module, typeOf(MODEL, "AudiencesOption", "object").module);
});

test("properties carry the row's presence, condition, marker, and description, and nothing that constrains", () => {
  const currency = typeOf(MODEL, "Commitment", "object").properties.currency!;
  assert.deepEqual(currency, {
    type: { kind: "named", name: "CurrencyCode" },
    presence: "conditional",
    condition: "REQUIRED when `basis = spend`",
    description: "ISO-4217",
    sources: ["key:5.6.1:commitment.currency"],
  });
  const brief = typeOf(MODEL, "Proposal", "document").properties.brief_ref!;
  assert.equal(brief.marker, "supplied");
  // A row that names two fields gives two properties.
  const proposal = typeOf(MODEL, "Proposal", "document");
  assert.ok("valid_from" in proposal.properties && "valid_until" in proposal.properties);
  assert.deepEqual(proposal.properties.valid_from!.sources, ["field:4.1:valid_from,valid_until"]);
});

test("vocabularies list their terms in specification order, and a decimal term is a JSON integer", () => {
  assert.deepEqual(
    typeOf(MODEL, "Marker", "vocabulary").terms.map((t) => t.value),
    ["immutable", "seller-set", "selectable", "settable", "supplied", "requestable", "derived"],
  );
  assert.deepEqual(typeOf(MODEL, "PlcmtSubtype", "vocabulary").terms.map((t) => t.value), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const provenance = typeOf(MODEL, "Provenance", "vocabulary");
  assert.deepEqual([provenance.open, provenance.terms], [true, []], "an open vocabulary whose terms the specification doesn't list has no core terms");
  const channel = typeOf(MODEL, "Channel", "vocabulary");
  assert.equal(channel.open, true);
  assert.deepEqual(channel.references, ["NamespacedTerm"]);
  const dooh = channel.terms.find((t) => t.value === "dooh")!;
  assert.ok(dooh.sources.includes("def:5.1.1:channel.dooh"), "a definition row adds its source to the term");
});

test("a profile takes its document's properties, and an object that includes it references their types, not the profile", () => {
  const summary = typeOf(MODEL, "LineItemSummary", "profile");
  const item = typeOf(MODEL, "LineItem", "document");
  // A whole field keeps its type; a path the MUST-contain list names is required.
  assert.deepEqual(summary.properties.channel, { ...item.properties.channel, presence: "required" });
  assert.equal(summary.properties.has_requires!.presence, "required");
  // A path through a list or a copy projects it to the members the paths name, with the currency a rate requires.
  assert.deepEqual(summary.properties.pricing!.type, { kind: "apply", constructor: "List", arguments: { T: { kind: "named", name: "LineItemSummaryPricingEntry" } } });
  const entry2 = typeOf(MODEL, "LineItemSummaryPricingEntry", "object");
  assert.equal(entry2.projects, "PricingEntry");
  assert.deepEqual(Object.fromEntries(Object.entries(entry2.properties).map(([k, p]) => [k, p.presence])), { cost_method: "required", currency: "required", gross_rate: "required" });
  const formats = typeOf(MODEL, "LineItemSummaryFormatsSelection", "object");
  assert.deepEqual(Object.keys(formats.properties), ["included"]);
  assert.equal(formats.properties.included!.presence, "required");
  // "Property names" names no member, so its path keeps each step's presence (D-028).
  assert.equal(summary.properties.properties!.presence, "optional");
  assert.equal(typeOf(MODEL, "LineItemSummaryPropertiesSelection", "object").properties.available!.presence, "required");
  assert.deepEqual(Object.keys(typeOf(MODEL, "LineItemSummaryPropertiesOption", "object").properties), ["name"]);
  // The placement keys a summary gives where the line item declares them are optional, a condition included.
  const placement = typeOf(MODEL, "LineItemSummaryPlacement", "object");
  assert.deepEqual(Object.fromEntries(Object.entries(placement.properties).map(([k, p]) => [k, p.presence])), { instl: "optional", plcmt: "optional", reward: "optional", skip: "optional" });
  // The parent proposal's paths, which "plus" continues the list with, are required too.
  const proposal = typeOf(MODEL, "ProposalSummary", "profile");
  assert.ok(Object.values(proposal.properties).every((p) => p.presence === "required"), JSON.stringify(proposal.properties));
  assert.ok(summary.paths.indexOf("line_item_id") < summary.paths.indexOf("transaction_mechanism"), "paths keep specification order");
  const entry = typeOf(MODEL, "ProposalsEntry", "object");
  assert.equal(entry.includes, "ProposalSummary");
  assert.ok(!entry.references.includes("ProposalSummary"));
  assert.ok(entry.references.includes("LinkedExecution"), "the profile's field types");
});

test("rules, obligations, schema statements, and examples are listed with their text", () => {
  assert.ok(MODEL.rules.every((r) => r.text !== "" && r.owner !== ""));
  assert.ok(MODEL.obligations.every((o) => ["seller", "buyer", "consumer", "implementation"].includes(o.party)));
  const ids = MODEL.rules.map((r) => r.ir);
  assert.deepEqual(ids, [...ids].sort());
  assert.ok(MODEL.kernel_rules.some((r) => r.id.startsWith("kernel:")) && MODEL.kernel_rules.some((r) => r.id.startsWith("constructor:")));
  assert.ok(MODEL.counts.informative > 0 && MODEL.counts.rendered > 0);
});

test("the module list records the other modules each module's types reference", () => {
  const modules = new Map(MODEL.modules.map((m) => [m.name, m.references]));
  assert.deepEqual(modules.get("kernel"), []);
  assert.deepEqual(modules.get("targeting"), ["inventory"]);
  assert.deepEqual(modules.get("publication"), ["proposal"]);
});

test("resolution fails on a property of no object, a term of no vocabulary, and a name defined twice", () => {
  const orphan = resolve(
    edited("commercial", (m) => {
      const e = m.entries.find((x) => x.ir === "field:5.6:min_spend")!;
      if (e.as.role === "property") e.as.object = "Nowhere";
    }),
  );
  assert.match(orphan.problems.join("\n"), /"Nowhere" is no object or document in the model/);
  const term = resolve(
    edited("kernel", (m) => {
      const e = m.entries.find((x) => x.ir === "marker:3:immutable")!;
      if (e.as.role === "term") e.as.vocabulary = "Nothing";
    }),
  );
  assert.match(term.problems.join("\n"), /"Nothing" is no vocabulary in the model/);
  const twice = resolve(edited("commercial", (m) => m.types!.push({ name: "Channel", kind: "object", source: { decision: "D-016" }, open: true })));
  assert.match(twice.problems.join("\n"), /"Channel" is already defined in the model/);
});

test("resolution fails on a restated list with a value its vocabulary lacks, and on a profile field its document lacks", () => {
  const ir = structuredClone(PRS);
  const restated = MAPPINGS.flatMap((m) => m.entries).find((e) => e.as.role === "same" && ir.value_lists.some((v) => v.id === e.ir))!;
  ir.value_lists.find((v) => v.id === restated.ir)!.items.push({ value: "extra_value", annotation: null });
  assert.match(resolve(MAPPINGS, ir).problems.join("\n"), /restates "[A-Za-z]+" with "extra_value", which it lacks/);

  const ir2 = structuredClone(PRS);
  ir2.identifier_lists.find((l) => l.id === "block:2.1:4/identifiers:1")!.items.push({ text: "no_such_field", code: true });
  assert.match(resolve(MAPPINGS, ir2).problems.join("\n"), /the profile "ProposalSummary" lists "no_such_field", which is no property of "Proposal"/);
});

test("a geo bound and a device bound are copies of one application, so the copy rule, not a twin, defines them", () => {
  const geo = typeOf(MODEL, "GeoBounds", "copy");
  const device = typeOf(MODEL, "DeviceBounds", "copy");
  assert.equal(geo.application, "Settable<T=ExternalId>");
  assert.equal(device.application, geo.application);
  assert.deepEqual({ ...device.schema, description: undefined }, { ...geo.schema, description: undefined });
  for (const gone of ["OptionKey", "GeoCode", "DeviceCategory", "ContentCategory", "DocumentVersion"]) assert.ok(!MODEL.types.some((t) => t.name === gone), `${gone} is no type`);
});

test("no version is a type of its own: a proposal's version is a count, and the spec's version an external ID", () => {
  const props = (name: string) => (typeOf(MODEL, name, name === "Manifest" ? "document" : name === "Proposal" ? "document" : "object") as { properties: Record<string, { type: unknown; description?: string }> }).properties;
  assert.deepEqual(props("Proposal").version!.type, { kind: "named", name: "Count" });
  assert.deepEqual(props("Commitment").version!.type, { kind: "named", name: "Count" });
  assert.deepEqual(props("NegotiationHistoryEntry").version!.type, { kind: "named", name: "Count" });
  assert.deepEqual(props("Manifest").spec_version!.type, { kind: "named", name: "ExternalId" });
  assert.match(String(props("Manifest").spec_version!.description), /such as `3\.0`/);
  assert.deepEqual(props("TermsRef").version!.type, { kind: "named", name: "ExternalId" });
  for (const gone of ["Version", "SemVer"]) assert.ok(!MODEL.types.some((t) => t.name === gone), `${gone} is no type`);
});

test("fixtures of an independent review: a code's label is the list's full wording, and a content category says the form the text writes", () => {
  // AdCOM 1.0 List: Playback Methods at the pinned commit writes code 7 as one sentence and its gloss, which the label keeps whole.
  const playback = typeOf(MODEL, "PlaybackMethod", "vocabulary");
  assert.equal(
    playback.terms.find((t) => t.value === 7)?.annotation,
    "Continuous Playback - Media playback is set to play additional media automatically without user interaction. The media player will keep playing additional media (playlist or generated) for the user until the user actively stops this from happening.",
  );
  const exclusions = typeOf(MODEL, "Exclusions", "object");
  assert.match(exclusions.properties.iab_content_category!.description ?? "", /writes one as `IAB-CT3\.0:<id>`/);
});

test("a negotiation step's changed fields are external IDs named by their paths, since the text states no path grammar", () => {
  assert.ok(!MODEL.types.some((t) => t.name === "FieldPath"), "FieldPath is no type");
  const entry = typeOf(MODEL, "NegotiationHistoryEntry", "object");
  const changed = entry.properties.fields_changed!;
  assert.deepEqual(changed.type, { kind: "apply", constructor: "List", arguments: { T: { kind: "named", name: "ExternalId" } } });
  assert.match(changed.description ?? "", /each named by its path as the specification's tables write it/);
});

test("every object option carries its id, a UUID, required, which the constructor gives and the mapping doesn't write (D-046)", () => {
  for (const [lock, ir] of LOCKS) {
    const model = resolve(MAPPINGS, ir, lock).model;
    for (const name of ["AudiencesOption", "CancellationPolicyOption", "ExclusivityOption", "MeasurementSourceOption", "ProductionOption", "PropertiesOption", "ReportingOption"]) {
      const t = typeOf(model, name, "object");
      assert.deepEqual(t.properties.id && { type: t.properties.id.type, presence: t.properties.id.presence, given: t.properties.id.given }, { type: { kind: "named", name: "Uuid" }, presence: "required", given: "Selectable" }, `${lock}: ${name}`);
      assert.ok(t.decisions.includes("D-046"), `${lock}: ${name} cites D-046`);
    }
    // An option whose members the text lists without an id departs from the text; an open one and one that writes it don't.
    for (const name of ["MeasurementSourceOption", "ProductionOption", "ReportingOption"]) assert.ok(typeOf(model, name, "object").decisions.includes("D-047"), `${lock}: ${name} cites D-047`);
    for (const name of ["AudiencesOption", "CancellationPolicyOption", "ExclusivityOption", "PropertiesOption"]) assert.ok(!typeOf(model, name, "object").decisions.includes("D-047"), `${lock}: ${name} cites no departure`);
    // A member the text writes keeps its element; one the text doesn't write rests on none.
    assert.deepEqual(typeOf(model, "PropertiesOption", "object").properties.id!.sources, typeOf(model, "PropertiesOption", "object").sources, lock);
    assert.deepEqual(typeOf(model, "MeasurementSourceOption", "object").properties.id!.sources, [], lock);
    // A string option carries nothing: it is its own name.
    assert.equal(model.types.some((t) => t.name === "FormatId" && "properties" in t), false);
  }
  // An option that types its id otherwise fails.
  const typed = structuredClone(MAPPINGS);
  const inv = typed.find((x) => x.module === "inventory")!;
  for (const e of inv.entries) if (e.ir === "field:5.2:properties#description/object:1") (e.as as { members: Record<string, { type: unknown }> }).members.id!.type = { kind: "named", name: "ExternalId" };
  assert.ok(resolve(typed).problems.some((p) => p.includes('"PropertiesOption" is an option named by its `id`, a Uuid, but types `id` as ExternalId')), resolve(typed).problems.join("\n"));
});

test("the two parties are the kernel's vocabulary, beside Marker, and the modules that name them need no other module for it", () => {
  for (const [lock, ir] of LOCKS) {
    const model = resolve(MAPPINGS, ir, lock).model;
    const party = model.types.find((t) => t.name === "Party")!;
    assert.equal(party.module, "kernel", lock);
    assert.deepEqual(party.kind === "vocabulary" && party.terms.map((t) => t.value), ["buyer", "seller"], lock);
    assert.deepEqual(party.sources, ["field:4.1:negotiation_history[]#description/object:1/actor"], `${lock}: its entry stays in § 4.1's module`);
  }
  assert.equal(MAPPINGS.find((m) => m.module === "creative")!.depends, undefined, "creative names Party, the kernel's, and depends on no module");
});
