import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import ajvFormats from "ajv-formats";
import { canonicalJson } from "../src/canonical.ts";
import { loadConstructors } from "../src/constructors.ts";
import { walkSchemas } from "../src/conventions.ts";
import { checkEmitted, DIALECT, emitSchemas, kebab, SCHEMA_BASE, schemaDirOf, type EmittedFile } from "../src/emit.ts";
import type { SpecIR } from "../src/ir-types.ts";
import { loadKernel } from "../src/kernel.ts";
import { loadDecisions, loadMappings } from "../src/mapping.ts";
import { resolveModel, type ModelDoc } from "../src/model.ts";
import { ajvProblems, oracleProblems, spawnOracle } from "../src/schema-check.ts";
import { ROOT } from "./helpers.ts";

const KERNEL = loadKernel(ROOT);
const CONSTRUCTORS = loadConstructors(ROOT);
const MAPPINGS = loadMappings(ROOT, join(ROOT, "mapping"));
const DECISIONS = loadDecisions(ROOT, join(ROOT, "decisions"));
const ir = (dir: string) => JSON.parse(readFileSync(join(ROOT, dir, "spec-ir.json"), "utf8")) as SpecIR;
const resolve = (lock: string, dir: string) => resolveModel({ ir: ir(dir), lock, mappings: MAPPINGS, decisions: DECISIONS, kernel: KERNEL, constructors: CONSTRUCTORS }).model;
const LOCKS: [string, ModelDoc, string][] = [
  ["main", resolve("main", "ir"), "schemas"],
  ["with-open-prs", resolve("with-open-prs", join("ir", "with-open-prs")), "schemas/with-open-prs"],
];
const [, MAIN, MAIN_DIR] = LOCKS[0]!;
const [, PRS, PRS_DIR] = LOCKS[1]!;

const fileOf = (files: EmittedFile[], path: string) => {
  const f = files.find((x) => x.path === path);
  assert.ok(f, `no file ${path}`);
  return f.schema;
};
const defOf = (files: EmittedFile[], path: string, name: string) => {
  const defs = fileOf(files, path).$defs as Record<string, Record<string, unknown>>;
  assert.ok(defs[name], `${path} defines no ${name}`);
  return defs[name]!;
};

/** Ajv over every file, with a validator for one of them. */
function validatorFor(files: EmittedFile[], dir: string, path: string, fragment = "") {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  ajvFormats.default(ajv);
  for (const f of files) ajv.addSchema(f.schema);
  const v = ajv.getSchema(`${SCHEMA_BASE}${dir}/${path}${fragment}`);
  assert.ok(v, `no schema ${path}${fragment}`);
  return v;
}

test("each lock's model emits with no problem, follows the output conventions, and is valid 2020-12 under Ajv", () => {
  for (const [lock, model, dir] of LOCKS) {
    const e = emitSchemas(model, dir);
    assert.deepEqual(e.problems, [], `${lock}: ${e.problems.join("\n")}`);
    assert.deepEqual(checkEmitted(e.files, model, dir), [], lock);
    assert.deepEqual(ajvProblems(e.files), [], lock);
    assert.deepEqual(e.files.map((f) => f.path), [...e.files.map((f) => f.path)].sort(), "files are sorted by path");
    for (const f of e.files) assert.equal(f.text, canonicalJson(f.schema));
  }
});

test("every named type but a constructor and a model attribute's vocabulary is emitted once, at the file its layer and module give it", () => {
  const { files } = emitSchemas(MAIN, MAIN_DIR);
  const emitted = files.flatMap((f) => (f.schema.$defs ? Object.keys(f.schema.$defs as object) : [String(f.schema.title)]));
  assert.equal(new Set(emitted).size, emitted.length, "each type once");
  const published = MAIN.types.filter((t) => t.kind !== "constructor" && !(t.kind === "vocabulary" && t.attribute !== undefined));
  assert.deepEqual(emitted.sort(), published.map((t) => t.name).sort());
  assert.ok(defOf(files, "kernel/1/kernel.json", "Amount"));
  assert.ok(defOf(files, "kernel/1/kernel.json", "PriceDelta"), "a part is the kernel's");
  assert.ok(!emitted.includes("Marker"), "the marker vocabulary stays in the model (type rules § 2)");
  assert.ok(defOf(files, "modules/creative/1/creative.json", "FormatsSelection"), "a copy is its module's");
  assert.equal(fileOf(files, "documents/1/line-item.json").title, "LineItem");
  assert.equal(fileOf(files, "documents/1/line-item-summary.json").title, "LineItemSummary");
  for (const name of ["Selectable", "List", "CatalogRefOr"]) assert.ok(!emitted.includes(name), `the template ${name} isn't emitted`);
  assert.equal(kebab("LineItemSummary"), "line-item-summary");
});

test("each file is one resource with its $id at its path, and references between files are relative", () => {
  const { files } = emitSchemas(PRS, PRS_DIR);
  const doc = fileOf(files, "documents/1/proposal.json");
  assert.equal(doc.$schema, DIALECT);
  assert.equal(doc.$id, `${SCHEMA_BASE}schemas/with-open-prs/documents/1/proposal.json`);
  const props = doc.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(props.proposal_id, { $ref: "../../kernel/1/kernel.json#/$defs/Uuid", description: "Unique identity for the proposal object" });
  assert.equal((props.status as { $ref: string }).$ref, "../../modules/proposal/1/proposal.json#/$defs/ProposalStatus");
  const manifest = fileOf(files, "documents/1/manifest.json").properties as Record<string, { items: unknown }>;
  assert.deepEqual(manifest.proposals!.items, { $ref: "../../modules/publication/1/publication.json#/$defs/ProposalsEntry" });
  const commercial = defOf(files, "modules/commercial/1/commercial.json", "Commitment").properties as Record<string, { $ref: string }>;
  assert.equal(commercial.basis!.$ref, "#/$defs/CommitmentBasis", "a reference within a file stays local");
});

test("an object is closed unless the mapping marks it open, requires what the specification requires, and states a condition on a sibling with if / then", () => {
  const { files, conditions } = emitSchemas(MAIN, MAIN_DIR);
  const c = defOf(files, "modules/commercial/1/commercial.json", "Commitment");
  assert.equal(c.type, "object");
  assert.equal(c.additionalProperties, false);
  assert.deepEqual(c.required, ["amount", "basis", "flight_end", "flight_start", "idempotency_key"]);
  assert.deepEqual(c.if, { properties: { basis: { const: "spend" } }, required: ["basis"] });
  assert.deepEqual(c.then, { required: ["currency"] });
  assert.deepEqual(c.else, { if: { properties: { basis: { const: "units" } }, required: ["basis"] }, then: { properties: { amount: { $ref: "../../../kernel/1/kernel.json#/$defs/Count" } } } }, "a units commitment's amount is a count, chained in else");
  assert.deepEqual(conditions, { expressed: ["Commitment.currency", "Proposal.brief_ref"], left: [] });
  const open = defOf(files, "modules/proposal/1/proposal.json", "Assent");
  assert.deepEqual(Object.keys(open).sort(), ["description", "type"], "an open object whose structure is unstated, with what its row says of it");
  assert.match(String(open.description), /assent records.*WS1.*states no members/);

  const v = validatorFor(files, MAIN_DIR, "modules/commercial/1/commercial.json", "#/$defs/Commitment");
  const base = { amount: 1000, flight_start: "2026-11-01T00:00:00-04:00", flight_end: "2026-11-30T00:00:00-05:00", idempotency_key: "7c9e6679-7425-40de-944b-e07fc1f90ae7" };
  assert.equal(v({ ...base, basis: "spend", currency: "USD" }), true);
  assert.equal(v({ ...base, basis: "spend" }), false, "currency REQUIRED when basis = spend");
  assert.equal(v({ ...base, basis: "units" }), true);
  assert.equal(v({ ...base, basis: "units", amount: 1000.5 }), false, "amount is a count when basis = units");
  assert.equal(v({ ...base, basis: "spend", amount: 1000.5, currency: "USD" }), true, "amount is money when basis = spend");
  assert.equal(v({ ...base, basis: "units", note: "x" }), false, "a closed object rejects a member it doesn't name");
});

test("a condition that names no sibling and value is left to the rules", () => {
  const { conditions } = emitSchemas(PRS, PRS_DIR);
  assert.deepEqual(conditions.expressed, ["Commitment.currency", "LineItem.terms_ref", "LineItem.time_zone", "MinCommitmentEntry.currency", "Proposal.brief_ref"]);
  assert.equal(conditions.left.length, 1);
  assert.match(conditions.left[0]!, /^Placement\.plcmt: "REQUIRED for video ads/);
});

test("a member required with a sibling or a sibling's member is a dependency, beside the object's own if / then", () => {
  const { files } = emitSchemas(PRS, PRS_DIR);
  const li = fileOf(files, "documents/1/line-item.json");
  assert.deepEqual(li.dependentRequired, { daypart: ["time_zone"] });
  assert.deepEqual(li.dependentSchemas, { frequency_cap: { if: { properties: { frequency_cap: { type: "object", required: ["period"] } } }, then: { required: ["time_zone"] } } });
  assert.ok(li.if !== undefined, "the terms condition stays the object's own if / then");
  const v = validatorFor(files, PRS_DIR, "documents/1/line-item.json");
  const base = JSON.parse(readFileSync(join(ROOT, "corpus", "with-open-prs", "cases.json"), "utf8")).constraints.find((c: { id: string }) => c.id === "LineItem#/additionalProperties").baseline;
  assert.equal(v(base), true);
  assert.equal(v({ ...base, frequency_cap: { period: "day" } }), false, "a cap with a period needs the clock");
  assert.equal(v({ ...base, frequency_cap: { period: "day" }, time_zone: "viewer_local" }), true);
  assert.equal(v({ ...base, frequency_cap: { period: "P1D" }, time_zone: "viewer_local" }), false, "a period is a calendar period, not a length of time");
  assert.equal(v({ ...base, frequency_cap: { max: { max: 3 } } }), true, "a cap with no period needs no clock");
  assert.equal(v({ ...base, daypart: { allowed: [] } }), false, "a daypart needs the clock");
  assert.equal(v({ ...base, daypart: { allowed: [] }, time_zone: "America/New_York" }), true);
  assert.deepEqual(emitSchemas(MAIN, MAIN_DIR).files.find((f) => f.path === "documents/1/line-item.json")!.schema.dependentSchemas, undefined, "main has no time zone");
});

test("a daypart window starts at any time of day but 24:00, which only ends one", () => {
  const { files } = emitSchemas(MAIN, MAIN_DIR);
  const window = validatorFor(files, MAIN_DIR, "kernel/1/kernel.json", "#/$defs/DaypartWindow");
  assert.equal(window({ days: ["monday"], start: "23:00", end: "24:00" }), true);
  assert.equal(window({ days: ["monday"], start: "24:00", end: "24:00" }), false);
  assert.equal(window({ days: ["monday"], start: { hour: 6, minute: 0 }, end: "10:00" }), false, "a time of day is one HH:MM string");
  assert.equal(window("24:00"), false, "only type rejects a value that is no object");
  const time = validatorFor(files, MAIN_DIR, "kernel/1/kernel.json", "#/$defs/TimeOfDay");
  for (const ok of ["00:00", "09:30", "23:59", "24:00"]) assert.equal(time(ok), true, ok);
  for (const bad of ["24:30", "25:00", "9:00", "09:00:00"]) assert.equal(time(bad), false, bad);
});

test("a vocabulary is an enum, and an open one is anyOf its core enum and NamespacedTerm; a code's label goes in the description", () => {
  const { files } = emitSchemas(PRS, PRS_DIR);
  assert.deepEqual(defOf(files, "modules/proposal/1/proposal.json", "ProposalType"), { type: "string", enum: ["standard", "custom"] });
  assert.deepEqual(defOf(files, "modules/line-item/1/line-item.json", "Channel"), {
    anyOf: [{ type: "string", enum: ["display", "video", "audio", "ctv", "dooh", "native"] }, { $ref: "../../../kernel/1/kernel.json#/$defs/NamespacedTerm" }],
  });
  const plcmt = defOf(files, "modules/inventory/1/inventory.json", "PlcmtSubtype");
  assert.deepEqual({ ...plcmt, description: undefined }, { type: "integer", enum: [1, 2, 3, 4, 5, 6, 7, 8, 9], description: undefined });
  assert.match(String(plcmt.description), /^The codes of AdCOM 1\.0 List: Plcmt Subtypes - Video \(https:\/\/github\.com\/InteractiveAdvertisingBureau\/AdCOM\/blob\/26c59ba[^)]*\); `1`: Instream; .*`9`: In-scene$/);
  // A list that reserves codes for vendors extends its vocabulary with them, not with namespaced terms.
  const api = defOf(files, "modules/inventory/1/inventory.json", "ApiFramework");
  assert.deepEqual(api.anyOf, [{ type: "integer", enum: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, { $ref: "../../../kernel/1/kernel.json#/$defs/VendorCode" }]);
  const apiV = validatorFor(files, PRS_DIR, "modules/inventory/1/inventory.json", "#/$defs/ApiFramework");
  for (const [x, ok] of [[7, true], [500, true], [10, false], [499, false], ["examplepub.example:x", false]] as const) assert.equal(apiV(x), ok, String(x));
  const playV = validatorFor(files, PRS_DIR, "modules/inventory/1/inventory.json", "#/$defs/PlaybackMethod");
  for (const [x, ok] of [[11, true], [12, false], [500, false]] as const) assert.equal(playV(x), ok, String(x));
  assert.deepEqual(defOf(files, "modules/audience/1/audience.json", "Provenance"), {
    description: "No core terms are listed yet, so every term is namespaced.",
    $ref: "../../../kernel/1/kernel.json#/$defs/NamespacedTerm",
  });
  const terms = validatorFor(files, PRS_DIR, "modules/audience/1/audience.json", "#/$defs/Provenance");
  assert.equal(terms("examplepub.example:modeled"), true);
  assert.equal(terms("modeled"), false, "a bare term is no core term until the specification lists it");
  const v = validatorFor(files, PRS_DIR, "modules/line-item/1/line-item.json", "#/$defs/Channel");
  assert.equal(v("ctv"), true);
  assert.equal(v("examplepub.example:podcast_host_read"), true);
  assert.equal(v("podcast"), false);
});

test("an object that includes a profile carries the profile's fields itself, with no allOf", () => {
  const { files } = emitSchemas(PRS, PRS_DIR);
  const entry = defOf(files, "modules/publication/1/publication.json", "ProposalsEntry");
  const summary = fileOf(files, "documents/1/proposal-summary.json");
  const fields = Object.keys(entry.properties as object);
  for (const k of Object.keys(summary.properties as object)) assert.ok(fields.includes(k), `ProposalsEntry carries ${k}`);
  assert.ok(fields.includes("full_url") && fields.includes("version"));
  assert.equal(entry.additionalProperties, undefined, "the mapping marks it open");
  assert.ok(!JSON.stringify(entry).includes("allOf"));
});

test("a union is anyOf its branches, named after its field", () => {
  const { files } = emitSchemas(PRS, PRS_DIR);
  assert.deepEqual(defOf(files, "modules/targeting/1/targeting.json", "Geo"), { anyOf: [{ $ref: "#/$defs/GeoSelection" }, { $ref: "#/$defs/GeoBounds" }] });
});

test("no mutability marker reaches the schema, neither as a key nor as a vocabulary", () => {
  for (const [lock, model, dir] of LOCKS) {
    const marker = model.types.find((t) => t.name === "Marker");
    assert.ok(marker && marker.kind === "vocabulary", lock);
    assert.equal(marker.attribute, "marker", `${lock}: the model marks Marker as the marker attribute's values`);
    const terms = new Set(marker.terms.map((x) => String(x.value)));
    assert.equal(terms.size, 7, lock);
    const files = emitSchemas(model, dir).files;
    for (const f of files) {
      assert.ok(!/marker|"x-|mutability/i.test(f.text), `${lock}: ${f.path} mentions a marker`);
      const defs = Object.keys((f.schema.$defs ?? {}) as Record<string, unknown>);
      assert.ok(!defs.includes("Marker"), `${lock}: ${f.path} defines Marker`);
      walkSchemas(f.schema, (s, pointer) => {
        if (!Array.isArray(s.enum)) return;
        const hit = s.enum.filter((v) => terms.has(String(v)));
        assert.deepEqual(hit, [], `${lock}: ${f.path} at ${pointer}: an enum holds marker terms`);
      });
    }
  }
});

test("the emitter fails on a payload type that references the marker vocabulary", () => {
  const model = structuredClone(MAIN);
  const c = model.types.find((t) => t.name === "Commitment");
  assert.ok(c && c.kind === "object");
  c.properties.basis = { ...c.properties.basis!, type: { kind: "named", name: "Marker" } };
  c.references = [...new Set([...c.references.filter((r) => r !== "CommitmentBasis"), "Marker"])].sort();
  assert.match(emitSchemas(model, MAIN_DIR).problems.join("\n"), /references "Marker", which the model doesn't emit, since it lists the model's `marker` attribute/);
});

test("the model fails a vocabulary that mixes marker rows with payload terms", () => {
  const mappings = structuredClone(MAPPINGS);
  const kernel = mappings.find((m) => m.module === "kernel")!;
  const term = kernel.entries.find((e) => e.as.role === "term" && e.ir === "marker:3:derived")!;
  const moved = mappings.flatMap((m) => m.entries).find((e) => e.as.role === "term" && !e.ir.startsWith("marker:"));
  assert.ok(moved && moved.as.role === "term");
  term.as = { ...term.as, vocabulary: moved.as.vocabulary } as typeof term.as;
  const r = resolveModel({ ir: ir("ir"), lock: "main", mappings, decisions: DECISIONS, kernel: KERNEL, constructors: CONSTRUCTORS });
  assert.match(r.problems.join("\n"), /mixes § 3 marker rows with payload terms/);
});

test("conditions on one sibling chain through else, and conditions on two siblings fail, since they would need allOf", () => {
  const model = structuredClone(MAIN);
  const c = model.types.find((t) => t.name === "Commitment");
  assert.ok(c && c.kind === "object");
  c.properties.derived_units = { ...c.properties.derived_units!, presence: "conditional", condition: "REQUIRED when `basis = units`" };
  const chained = emitSchemas(model, MAIN_DIR);
  assert.deepEqual(chained.problems, []);
  assert.deepEqual(defOf(chained.files, "modules/commercial/1/commercial.json", "Commitment").else, {
    if: { properties: { basis: { const: "units" } }, required: ["basis"] },
    then: { properties: { amount: { $ref: "../../../kernel/1/kernel.json#/$defs/Count" } }, required: ["derived_units"] },
  });
  const prs = structuredClone(PRS);
  const li = prs.types.find((t) => t.name === "LineItem");
  assert.ok(li && li.kind === "document");
  li.properties.placement = { ...li.properties.placement!, presence: "conditional", condition: "REQUIRED when `channel = video`" };
  const e = emitSchemas(prs, PRS_DIR);
  assert.equal(e.problems.length, 1, e.problems.join("\n"));
  assert.match(e.problems[0]!, /conditions on channel and terms_acceptance_required need one if \/ then each.*"allOf"/);
});

test("the emitter fails on a condition whose value its sibling's vocabulary lacks", () => {
  const model = structuredClone(MAIN);
  const c = model.types.find((t) => t.name === "Commitment");
  assert.ok(c && c.kind === "object");
  c.properties.currency = { ...c.properties.currency!, condition: "REQUIRED when `basis = budget`" };
  assert.match(emitSchemas(model, MAIN_DIR).problems.join("\n"), /"budget" is no term of the vocabulary "CommitmentBasis"/);
});

test("the output gate fails on a nonstandard keyword, a constraint beside a $ref, allOf, untagged oneOf, a misplaced anyOf, a broken reference, and a required name the object lacks", () => {
  const { files } = emitSchemas(MAIN, MAIN_DIR);
  const broken = (edit: (defs: Record<string, Record<string, unknown>>) => void): string[] => {
    const copy = structuredClone(files);
    const f = copy.find((x) => x.path === "modules/commercial/1/commercial.json")!;
    edit(f.schema.$defs as Record<string, Record<string, unknown>>);
    f.text = canonicalJson(f.schema);
    return checkEmitted(copy, MAIN, MAIN_DIR);
  };
  const props = (d: Record<string, Record<string, unknown>>) => d.Commitment!.properties as Record<string, Record<string, unknown>>;
  const cases: [string, (d: Record<string, Record<string, unknown>>) => void, RegExp][] = [
    ["an x- key", (d) => (d.Commitment!["x-op-mutability"] = "immutable"), /"x-op-mutability" is no standard/],
    ["$dynamicRef", (d) => (props(d).amount = { $dynamicRef: "#option" }), /"\$dynamicRef" is no standard/],
    ["discriminator", (d) => (d.Commitment!.discriminator = { propertyName: "basis" }), /"discriminator" is no standard/],
    ["a constraint beside a $ref", (d) => (props(d).amount!.minimum = 1), /"minimum" beside a \$ref/],
    ["allOf", (d) => (d.Commitment!.allOf = [{ type: "object" }]), /"allOf"/],
    ["untagged oneOf", (d) => (d.Commitment!.oneOf = [{ type: "object" }, { type: "object" }]), /no required "const" tag/],
    ["anyOf in an object", (d) => (d.Commitment!.anyOf = [{ required: ["amount"] }, { required: ["basis"] }]), /"anyOf" where type rules § 8 allows none/],
    ["a broken reference", (d) => (props(d).amount!.$ref = "../../../kernel/1/kernel.json#/$defs/Money"), /defines no "Money"/],
    ["a missing file", (d) => (props(d).amount!.$ref = "../../pricing/1/pricing.json#/$defs/Amount"), /isn't emitted/],
    ["a required name the object lacks", (d) => (d.Commitment!.then = { required: ["currencey"] }), /requires "currencey", which is no property/],
  ];
  for (const [what, edit, want] of cases) assert.match(broken(edit).join("\n"), want, what);
});

test("Ajv rejects a file that isn't valid 2020-12 or whose reference doesn't resolve", () => {
  const { files } = emitSchemas(MAIN, MAIN_DIR);
  const edited = (edit: (s: Record<string, unknown>) => void) => {
    const copy = structuredClone(files);
    edit(copy.find((x) => x.path === "kernel/1/kernel.json")!.schema);
    return ajvProblems(copy).join("\n");
  };
  assert.match(edited((s) => ((s.$defs as Record<string, Record<string, unknown>>).Amount!.minimum = "0")), /not a valid 2020-12 schema/);
  assert.match(edited((s) => ((s.$defs as Record<string, Record<string, unknown>>).Amount!.$ref = "#/$defs/Nothing")), /doesn't compile|can't resolve/);
  assert.match(edited((s) => ((s.$defs as Record<string, Record<string, unknown>>).Amount!.minimam = 0)), /doesn't compile.*unknown keyword/);
});

test("the oracle gate fails when the oracle isn't the pinned version", () => {
  const fake = (jsonschema: string, referencing: string) => () => ({ jsonschema, referencing, problems: [] });
  assert.deepEqual(oracleProblems(ROOT, [], fake("4.26.0", "0.37.0")).problems, []);
  assert.match(oracleProblems(ROOT, [], fake("4.25.1", "0.37.0")).problems.join(), /pins 4\.26\.0/);
  assert.match(oracleProblems(ROOT, [], fake("4.26.0", "0.36.2")).problems.join(), /pins 0\.37\.0/);
});

const VENV = existsSync(join(ROOT, ".venv", "bin", "python"));

test("the reference oracle rejects a missing definition, a missing file, and an invalid keyword value", { skip: VENV ? false : "no oracle venv at .venv; run: npm run setup:oracle" }, () => {
  const { files } = emitSchemas(MAIN, MAIN_DIR);
  assert.deepEqual(oracleProblems(ROOT, files, spawnOracle(ROOT)).problems, [], "the emitted set passes");
  const copy = structuredClone(files);
  const kernel = copy.find((x) => x.path === "kernel/1/kernel.json")!.schema.$defs as Record<string, Record<string, unknown>>;
  kernel.Amount!.minimum = "0";
  const commercial = copy.find((x) => x.path === "modules/commercial/1/commercial.json")!.schema.$defs as Record<string, Record<string, unknown>>;
  const props = commercial.Commitment!.properties as Record<string, Record<string, unknown>>;
  props.amount!.$ref = "../../../kernel/1/kernel.json#/$defs/Money";
  props.currency!.$ref = "../../pricing/1/pricing.json#/$defs/Amount";
  const problems = oracleProblems(ROOT, copy, spawnOracle(ROOT)).problems.join("\n");
  assert.match(problems, /kernel\/1\/kernel\.json: not a valid 2020-12 schema: '0' is not of type 'number'/);
  assert.match(problems, /commercial\.json at \/\$defs\/Commitment\/properties\/amount: \$ref \.\.\/\.\.\/\.\.\/kernel\/1\/kernel\.json#\/\$defs\/Money doesn't resolve/);
  assert.match(problems, /commercial\.json at \/\$defs\/Commitment\/properties\/currency: \$ref \.\.\/\.\.\/pricing\/1\/pricing\.json#\/\$defs\/Amount doesn't resolve/);
});

test("a lock's schema directory follows its IR directory", () => {
  assert.equal(schemaDirOf("ir"), "schemas");
  assert.equal(schemaDirOf("ir/with-open-prs"), "schemas/with-open-prs");
  assert.throws(() => schemaDirOf("elsewhere"), /isn't under ir\//);
});

test("a daypart window names at least one day, each once, as bounds on its own list", () => {
  for (const [m, dir] of [[MAIN, MAIN_DIR], [PRS, PRS_DIR]] as const) {
    const { files } = emitSchemas(m, dir);
    const window = (fileOf(files, "kernel/1/kernel.json").$defs as Record<string, Record<string, unknown>>).DaypartWindow!;
    assert.deepEqual((window.properties as Record<string, unknown>).days, { type: "array", items: { $ref: "#/$defs/DayName" }, minItems: 1, uniqueItems: true });
    assert.equal(window.dependentSchemas, undefined, "the bounds sit on the list, where every generator reads them")
    const v = validatorFor(files, dir, "kernel/1/kernel.json", "#/$defs/DaypartWindow");
    assert.equal(v({ days: ["monday", "friday"], start: "06:00", end: "10:00" }), true);
    assert.equal(v({ days: [], start: "06:00", end: "10:00" }), false, "a window with no day");
    assert.equal(v({ days: ["monday", "monday"], start: "06:00", end: "10:00" }), false, "a day twice");
  }
});

test("a frequency cap's period says its terms spell OpenDirect's codes, which are calendar periods with weeks from Monday, and flight runs between two points in time", () => {
  for (const [m, dir] of [[MAIN, MAIN_DIR], [PRS, PRS_DIR]] as const) {
    const { files } = emitSchemas(m, dir);
    const period = (fileOf(files, "modules/targeting/1/targeting.json").$defs as Record<string, { description: string }>).FrequencyCapPeriod!;
    assert.match(period.description, /^The period a frequency cap counts over\. Each term is OpenDirect 2\.1's code spelled as the specification spells its terms\./);
    assert.match(period.description, /`hour`, `day`, `week`, and `month` are calendar periods on the line item's clock/);
    assert.match(period.description, /a week starts on Monday/);
    assert.match(period.description, /`flight`, OpenDirect's `LineDuration`, is no calendar period: it runs from the flight's start to its end/);
    assert.match(period.description, /The codes of OpenDirect 2\.1 Line\.frequencyinterval \(https:/);
  }
});
