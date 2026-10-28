import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConstructors } from "../src/constructors.ts";
import { baselines, Validators } from "../src/corpus.ts";
import { emitSchemas, schemaIdOf, type EmittedFile } from "../src/emit.ts";
import type { SpecIR } from "../src/ir-types.ts";
import { lockExamples } from "../src/examples.ts";
import { FIELD_EXAMPLES_FILE, type FieldExample, loadFieldExamples } from "../src/field-examples.ts";
import { loadKernel } from "../src/kernel.ts";
import { loadLock } from "../src/lock.ts";
import { loadLists } from "../src/lists.ts";
import { loadDecisions, loadMappings } from "../src/mapping.ts";
import { resolveModel, type ModelDoc } from "../src/model.ts";
import { codesOf } from "../src/rule-checks.ts";
import { checkFieldExamples, checkTypeExamples, generateTypeExamples, renderTypeExamples, specValues, typeExamplesDirOf, type SpecExamples, type TypeExamplesDoc, type ValueSources } from "../src/type-examples.ts";
import { OP_SCHEMA, ROOT, RULE_CHECKS, SPEC } from "./helpers.ts";

const KERNEL = loadKernel(ROOT, SPEC);
const CONSTRUCTORS = loadConstructors(ROOT, SPEC);
const MAPPINGS = loadMappings(join(SPEC, "mapping"));
const DECISIONS = loadDecisions(join(SPEC, "decisions"));
const CODES = codesOf(loadLists(ROOT));
const FIELDS = loadFieldExamples(join(SPEC, FIELD_EXAMPLES_FILE)).fields;

interface Lock {
  irDir: string;
  schemaDir: string;
  model: ModelDoc;
  files: EmittedFile[];
  spec: SpecExamples;
  doc: TypeExamplesDoc;
  problems: string[];
  sources: ValueSources;
}

async function lockOf(lockFile: string, irDir: string, schemaDir: string): Promise<Lock> {
  const lock = loadLock(join(SPEC, "spec-input", lockFile));
  const ir = JSON.parse(readFileSync(join(SPEC, irDir, "spec-ir.json"), "utf8")) as SpecIR;
  const model = resolveModel({ ir, lock: lock.name, mappings: MAPPINGS, decisions: DECISIONS, kernel: KERNEL, constructors: CONSTRUCTORS }).model;
  const files = emitSchemas(model, schemaDir, OP_SCHEMA).files;
  const spec = await lockExamples(lock, model);
  const { doc, problems, sources } = generateTypeExamples({ model, files, kernel: KERNEL, schemaDir, codes: CODES, ruleChecks: RULE_CHECKS, spec, fields: FIELDS });
  return { irDir, schemaDir, model, files, spec, doc, problems, sources };
}
const MAIN = await lockOf("spec-lock.yaml", "ir", "schemas");
const PRS = await lockOf("with-open-prs.lock.yaml", join("ir", "with-open-prs"), "schemas/with-open-prs");
const NO_SPEC: SpecExamples = { examples: [], values: new Map() };
const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

test("every named type the schemas emit gets a minimal and a full example, and the committed files are what the generator writes", () => {
  for (const l of [MAIN, PRS]) {
    assert.deepEqual(l.problems, []);
    const emitted = l.model.types.filter((t) => schemaIdOf(t, l.schemaDir, OP_SCHEMA.base) !== null).map((t) => t.name).sort();
    assert.deepEqual(Object.keys(l.doc.types), emitted);
    // Constructors are templates and have no schema of their own; the documents and the summaries do.
    assert.equal(Object.values(l.doc.types).some((x) => x.kind === "constructor"), false);
    for (const d of ["Proposal", "LineItem", "ProposalSummary", "LineItemSummary"]) assert.ok(d in l.doc.types, d);
    assert.deepEqual(checkTypeExamples(l.doc, { model: l.model, files: l.files, schemaDir: l.schemaDir, codes: CODES, ruleChecks: RULE_CHECKS }), []);
    const committed = readFileSync(join(SPEC, typeExamplesDirOf(l.irDir), "examples.json"), "utf8");
    assert.equal(committed, renderTypeExamples(l.doc));
  }
  assert.equal(typeExamplesDirOf("ir"), "type-examples");
  assert.equal(typeExamplesDirOf(join("ir", "with-open-prs")), "type-examples/with-open-prs");
  assert.throws(() => typeExamplesDirOf("elsewhere"));
});

test("the minimal example is the corpus baseline's members, with the values the full examples show where they hold", () => {
  const v = new Validators(MAIN.files);
  const { typeValue } = baselines(MAIN.model, v, KERNEL, MAIN.schemaDir);
  const shape = (x: unknown): unknown => (Array.isArray(x) ? x.map(shape) : isMap(x) ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, shape(y)])) : typeof x);
  for (const [name, x] of Object.entries(MAIN.doc.types)) {
    // A primitive or a vocabulary shows its showcase value or its representative term; any other type keeps the baseline's structure.
    if (x.kind !== "primitive" && x.kind !== "vocabulary") assert.deepEqual(shape(x.minimal), shape(typeValue(x.schema, [])), name);
  }
  assert.deepEqual(MAIN.doc.types.Amount, { kind: "primitive", schema: MAIN.doc.types.Amount!.schema, minimal: 18.5, full: 18.5 });
  // A commitment's currency is REQUIRED when its basis is `spend`, so the minimal example holds it, with the amount the § 6.2 example commits.
  const commitment = MAIN.doc.types.Commitment!.minimal as Record<string, unknown>;
  assert.deepEqual(Object.keys(commitment).sort(), ["amount", "basis", "currency", "flight_end", "flight_start", "idempotency_key"]);
  assert.equal(commitment.amount, 80000);
});

test("a value comes from the specification's examples where the property's schema accepts it, and else from the primitive's showcase value", () => {
  const lineItem = MAIN.doc.types.LineItem!.full as Record<string, unknown>;
  const pricing = (lineItem.pricing as Record<string, unknown>[])[0]!;
  // § 6.2's display line item prices its CPM at 24.00 gross and 20.40 to the seller, in USD.
  assert.deepEqual([pricing.gross_rate, pricing.seller_rate, pricing.currency, pricing.cost_method], [24, 20.4, "USD", "CPM"]);
  // Without the per-field values, a member no example gives a valid value shows its primitive's showcase value.
  const plain = generateTypeExamples({ model: MAIN.model, files: MAIN.files, kernel: KERNEL, schemaDir: MAIN.schemaDir, codes: CODES, ruleChecks: RULE_CHECKS, spec: MAIN.spec, fields: [] });
  assert.deepEqual(plain.problems, []);
  assert.equal(plain.sources.field, 0);
  const plainItem = plain.doc.types.LineItem!.full as Record<string, unknown>;
  // Its `line_item_id`, "business-daily-display", is no UUID, so the ID is the Uuid showcase value.
  assert.equal(plainItem.line_item_id, KERNEL.primitives.find((p) => p.name === "Uuid")!.showcase[0]);
  // Its `materials_due`, "2026-09-24", is a date and no Timestamp, so the value is the Timestamp showcase value.
  assert.equal(plainItem.materials_due, KERNEL.primitives.find((p) => p.name === "Timestamp")!.showcase[0]);
  // The § 6.2 example gives four geo codes; a list of scalars shows the first two.
  assert.deepEqual((lineItem.geo as Record<string, unknown>).allowed, ["US-NY", "US-CA"]);
  // A vocabulary shows the first term an example uses, not its first core term.
  const status = MAIN.model.types.find((t) => t.name === "LineItemStatus")!;
  assert.ok(status.kind === "vocabulary" && status.terms[0]!.value === "draft");
  assert.equal(MAIN.doc.types.LineItemStatus!.full, "published");
  // Text that no example gives is the showcase sentence.
  assert.equal((plainItem.billing as Record<string, unknown>).payment_terms, KERNEL.primitives.find((p) => p.name === "Text")!.showcase[0]);
  assert.ok(MAIN.sources.spec > 0 && MAIN.sources.showcase > 0 && MAIN.sources.field > 0, JSON.stringify(MAIN.sources));
  // Without the specification's examples or the per-field values, every value is a showcase value, a term, or another value.
  const bare = generateTypeExamples({ model: MAIN.model, files: MAIN.files, kernel: KERNEL, schemaDir: MAIN.schemaDir, codes: CODES, ruleChecks: RULE_CHECKS, spec: NO_SPEC, fields: [] });
  assert.deepEqual(bare.problems, []);
  assert.equal(bare.sources.spec, 0);
  assert.equal(((bare.doc.types.LineItem!.full as Record<string, unknown>).pricing as Record<string, unknown>[])[0]!.gross_rate, 18.5);
});

test("the specification's values are read in its order, by section, and each only where its property's schema accepts it", () => {
  const v = new Validators(PRS.files);
  const lineItem = schemaIdOf(PRS.model.types.find((t) => t.name === "LineItem")!, PRS.schemaDir, OP_SCHEMA.base)!;
  const ok = (value: unknown) => ({ ok: true as const, value });
  const spec: SpecExamples = {
    // Listed out of order: a § 6.10 file first, then a § 6.2 file and a § 5.5 code block.
    examples: [
      { id: "examples/z.yaml", ir: "sentence:6.10:aaaaaaaa", object: "LineItem", part: false },
      { id: "examples/a.yaml", ir: "sentence:6.2:bbbbbbbb", object: "LineItem", part: false },
      { id: "code:5.5:9", ir: "code:5.5:9", object: "LineItem", part: true },
    ],
    values: new Map([
      ["examples/z.yaml", ok({ time_zone: "Europe/London", line_item_id: "not-a-uuid", min_spend: -5 })],
      ["examples/a.yaml", ok({ time_zone: "Asia/Tokyo" })],
      ["code:5.5:9", ok({ time_zone: "America/Chicago" })],
    ]),
  };
  const found = specValues(PRS.model, v, PRS.schemaDir, spec);
  assert.deepEqual(found.at.get(`${lineItem}#/properties/time_zone`), ["America/Chicago", "Asia/Tokyo", "Europe/London"]);
  assert.equal(found.at.get(`${lineItem}#/properties/line_item_id`), undefined);
  assert.equal(found.at.get(`${lineItem}#/properties/min_spend`), undefined);
  const r = generateTypeExamples({ model: PRS.model, files: PRS.files, kernel: KERNEL, schemaDir: PRS.schemaDir, codes: CODES, ruleChecks: RULE_CHECKS, spec, fields: FIELDS });
  assert.deepEqual(r.problems, []);
  assert.equal((r.doc.types.LineItem!.full as Record<string, unknown>).time_zone, "America/Chicago");
});

test("the full example holds every member, one item per list, one key per map, and the first branch of each union", () => {
  const commitment = MAIN.model.types.find((t) => t.name === "Commitment")!;
  assert.ok("properties" in commitment);
  assert.deepEqual(Object.keys(MAIN.doc.types.Commitment!.full as object).sort(), Object.keys(commitment.properties).sort());
  const daypart = MAIN.doc.types.DaypartBounds!.full as { allowed: unknown[] };
  assert.equal(daypart.allowed.length, 1);
  // A daypart window starts from the value its rule lists as valid, so its end is later than its start.
  assert.deepEqual(daypart.allowed[0], { days: ["monday", "friday"], start: "06:00", end: "10:00" });
  const accepted = PRS.doc.types.ExclusionsAccepted!.full as Record<string, unknown>;
  assert.deepEqual(Object.keys(accepted.max_entries as object), ["domain"]);
  // CatalogRefOr's first branch is the inline value, not the reference.
  const option = MAIN.doc.types.PropertiesOptionOrCatalogRef!.full;
  assert.ok(isMap(option) && !("catalog_ref" in option) && "id" in option);
  // A line item's day part needs its time zone with the open PRs, and the full example holds both.
  const lineItem = PRS.doc.types.LineItem!.full as Record<string, unknown>;
  assert.ok("daypart" in lineItem && "time_zone" in lineItem);
});

test("a full selection holds two options, the first included and the second priced, and only a price delta keeps notes on main", () => {
  for (const l of [MAIN, PRS]) {
    for (const t of l.model.types) {
      if (t.kind !== "copy" || t.of.constructor !== "Selectable") continue;
      const x = l.doc.types[t.name]!;
      assert.equal(x.notes, undefined, t.name);
      const full = x.full as { available: unknown[]; included: string[]; pricing: Record<string, unknown>; max_select?: number };
      assert.equal(full.available.length, 2, t.name);
      const names = full.available.map((o) => (typeof o === "string" ? o : (o as { id: string }).id));
      assert.deepEqual(full.included, [names[0]], t.name);
      assert.deepEqual(Object.keys(full.pricing), [names[1]], t.name);
      if ("max_select" in full) assert.ok(full.max_select! >= 1, t.name);
    }
  }
  // § 6.2 prices a larger display format at 3.00 more CPM, and caps the properties at two.
  const formats = MAIN.doc.types.FormatsSelection!;
  assert.deepEqual(formats.full, { available: ["display/300x250", "display/728x90"], included: ["display/300x250"], pricing: { "display/728x90": { delta_cpm: 3 } }, max_select: 2 });
  assert.equal((MAIN.doc.types.PropertiesSelection!.full as { max_select: number }).max_select, 2);
  // A price delta holds exactly one delta, so its full example keeps the first and says why it leaves out the rest.
  const delta = MAIN.doc.types.PriceDelta!;
  assert.deepEqual(delta.notes?.map((n) => [n.path, n.holds]), [["/delta_flat", "omitted"], ["/delta_pct", "omitted"]]);
  assert.match(delta.notes![0]!.reason, /must NOT have more than 1 properties/);
  assert.deepEqual(Object.entries(MAIN.doc.types).filter(([, x]) => x.notes !== undefined).map(([n]) => n), ["PriceDelta"]);
});

test("the check fails a committed example its schema or a rule rejects, and a type with no entry", () => {
  const input = { model: MAIN.model, files: MAIN.files, schemaDir: MAIN.schemaDir, codes: CODES, ruleChecks: RULE_CHECKS };
  const broken = structuredClone(MAIN.doc);
  (broken.types.Commitment!.full as Record<string, unknown>).basis = "barter";
  broken.types.FormatsSelection!.full = { available: ["display/300x250"], included: ["display/300x250"], pricing: { "display/300x250": { delta_cpm: 1 } } };
  delete broken.types.Amount;
  broken.types.Extra = { ...MAIN.doc.types.Count! };
  const problems = checkTypeExamples(broken, input);
  assert.ok(problems.some((p) => p.startsWith("Commitment: the full example fails the schema: /basis")), problems.join("\n"));
  assert.ok(problems.some((p) => p.startsWith("FormatsSelection: the full example fails constructor:Selectable:priced-beyond-included")), problems.join("\n"));
  assert.ok(problems.includes("Amount: no examples"));
  assert.ok(problems.includes("Extra: no type the schemas emit has this name"));
  // A list's code the generator's examples hold, no longer assigned, fails generation.
  const codes = new Map([...CODES].map(([k, c]) => [k, k === "ISO 4217" ? new Set([...c].filter((x) => x !== "USD")) : c]));
  const r = generateTypeExamples({ model: MAIN.model, files: MAIN.files, kernel: KERNEL, schemaDir: MAIN.schemaDir, codes, ruleChecks: RULE_CHECKS, spec: MAIN.spec, fields: FIELDS });
  assert.ok(r.problems.some((p) => p.startsWith('CurrencyCode: the minimal example "USD" fails kernel:CurrencyCode:assigned')), r.problems.join("\n"));
});

test("a member no example gives a value shows its per-field value, and a selection's second option the second value", () => {
  const lineItem = MAIN.doc.types.LineItem!.full as Record<string, Record<string, unknown> & unknown>;
  assert.equal(lineItem.billing!.payment_terms, "Net 30 from the end of the calendar month");
  assert.notEqual(lineItem.billing!.supplier_id, lineItem.billing!.billing_supplier_id);
  assert.match(String((lineItem.assets as unknown as Record<string, unknown>[])[0]!.url_or_tag), /^https:\/\//);
  // A device category is an AdCOM device type code, and the entry's note says why it's a string.
  assert.deepEqual(lineItem.device, { allowed: ["2", "4", "5"] });
  const names = ((lineItem.properties as { available: { name: string }[] }).available).map((o) => o.name);
  assert.deepEqual(names, ["Example Publisher Business News", "Markets Weekly"]);
  // An entry for one lock leaves the other lock's core term alone: with the open PRs, `role` is the core term `io`.
  assert.equal(((PRS.doc.types.LineItem!.full as Record<string, unknown>).external_references as Record<string, unknown>[])[0]!.role, "io");
  // A value whose entry carries a note is listed with it, and the notes on open objects say the structure is our proposal.
  const illustrative = MAIN.doc.types.LineItem!.illustrative ?? [];
  assert.deepEqual(illustrative.map((n) => n.path), ["/approval", "/content_detail", "/creative_policy", "/device", "/specs", "/third_party_tags"]);
  for (const n of illustrative.filter((x) => x.path !== "/device" && x.path !== "/specs")) assert.match(n.note, /our proposal in D-016's feedback, not the specification's/);
  assert.deepEqual(MAIN.doc.types.Proposal!.illustrative?.map((n) => n.path), ["/assent"]);
});

test("an open object shows the whole object an example gives it, and a summary's member the values of the member it projects", () => {
  // § 6.2's display line item writes a suppression list, which the schema keeps an open object.
  const supplied = MAIN.doc.types.BuyerSupplied!.full as Record<string, unknown>;
  assert.deepEqual(supplied.suppression_list, { source: "advertiser_crm", size: 340000, match_method: "ramp_id" });
  // The proposal summary shows the proposal's own values, and the line item summary's price the line item's.
  for (const l of [MAIN, PRS]) {
    const summary = l.doc.types.ProposalSummary!.full as Record<string, unknown>;
    const proposal = l.doc.types.Proposal!.full as Record<string, unknown>;
    for (const k of ["description", "seller_name", "valid_from", "valid_until"]) assert.equal(summary[k], proposal[k], k);
    const price = ((l.doc.types.LineItemSummary!.full as Record<string, unknown>).pricing as Record<string, unknown>[])[0]!;
    assert.equal(price.gross_rate, 24);
  }
});

/** Every value in a value, with its JSON pointer. */
function* leaves(x: unknown, path = ""): Generator<[string, unknown]> {
  if (Array.isArray(x)) for (const [i, y] of x.entries()) yield* leaves(y, `${path}/${i}`);
  else if (isMap(x)) for (const [k, y] of Object.entries(x)) yield* leaves(y, `${path}/${k}`);
  else yield [path, x];
}

test("every bound pair in a full example is ordered, and the documents and summaries show no showcase text, external ID, or extension term", () => {
  const pairs = [["flight_start", "flight_end"], ["valid_from", "valid_until"], ["min", "max"], ["min_impressions", "max_impressions"], ["min_budget", "max_budget"], ["start", "end"]];
  const objects = function* (x: unknown): Generator<Record<string, unknown>> {
    if (Array.isArray(x)) for (const y of x) yield* objects(y);
    else if (isMap(x)) {
      yield x;
      for (const y of Object.values(x)) yield* objects(y);
    }
  };
  const before = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? a < b : /^\d{4}-/.test(String(a)) ? Date.parse(String(a)) < Date.parse(String(b)) : String(a) < String(b));
  const showcase = (name: string) => KERNEL.primitives.find((p) => p.name === name)!.showcase;
  const odd = new Set<unknown>([...showcase("Text"), ...showcase("ExternalId"), ...showcase("NamespacedTerm")]);
  for (const l of [MAIN, PRS]) {
    for (const [name, x] of Object.entries(l.doc.types)) {
      for (const o of objects(x.full)) for (const [lo, hi] of pairs) if (lo! in o && hi! in o) assert.ok(before(o[lo!], o[hi!]), `${name}: ${lo} ${JSON.stringify(o[lo!])} isn't before ${hi} ${JSON.stringify(o[hi!])}`);
    }
    for (const name of ["Proposal", "LineItem", "ProposalSummary", "LineItemSummary"]) {
      for (const [path, v] of leaves(l.doc.types[name]!.full)) assert.ok(!odd.has(v), `${l.model.input.lock}: ${name}${path} is the showcase value ${JSON.stringify(v)}`);
    }
  }
});

test("the per-field check passes the committed entries, and fails a gone element, a value its schema rejects, a specification value, and a term a core term replaces", () => {
  for (const l of [MAIN, PRS]) {
    const r = checkFieldExamples({ model: l.model, files: l.files, kernel: KERNEL, schemaDir: l.schemaDir, codes: CODES, ruleChecks: RULE_CHECKS, spec: l.spec, fields: FIELDS });
    assert.deepEqual(r.problems, []);
    assert.ok(r.entries > 50 && r.locations >= r.entries, JSON.stringify(r));
  }
  const bad: FieldExample[] = [
    ...FIELDS.map((e) => (e.member === "min_impressions" ? { ...e, values: ["many"] } : e.member === "role" ? { ir: e.ir, member: e.member, values: e.values } : e)),
    { ir: "field:5.9:no_such_field", member: "no_such_field", values: ["x"] },
    { ir: "field:5.1:status", member: "status", values: ["published"] },
  ];
  const r = checkFieldExamples({ model: PRS.model, files: PRS.files, kernel: KERNEL, schemaDir: PRS.schemaDir, codes: CODES, ruleChecks: RULE_CHECKS, spec: PRS.spec, fields: bad });
  const has = (s: string) => assert.ok(r.problems.some((p) => p.includes(s)), `${s}\n${r.problems.join("\n")}`);
  has("field:5.9:no_such_field no_such_field: names an element that no longer exists");
  has('value 1, "many", fails its field\'s schema at CommitmentBounds.min_impressions');
  has('value 1, "published", duplicates a specification example value at LineItem.status');
  has("isn't a core term of ExternalReferenceRole, which now has core terms");
});
