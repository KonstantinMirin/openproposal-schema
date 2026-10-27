import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resolveBuild } from "../src/builds.ts";
import { loadConstructors } from "../src/constructors.ts";
import { loadKernel } from "../src/kernel.ts";
import { loadLock } from "../src/lock.ts";
import { loadDecisions, loadMappings } from "../src/mapping.ts";
import type { ModelDoc, ModelType } from "../src/model.ts";
import { resolveModel } from "../src/model.ts";
import { loadVectors } from "../src/rules.ts";
import { applyVariant, checkVariant, checkVariantDiff, loadVariant, variantDir, type Variant } from "../src/variant.ts";
import { ROOT } from "./helpers.ts";

const KERNEL = loadKernel(ROOT);
const CONSTRUCTORS = loadConstructors(ROOT);
const MAPPINGS = loadMappings(ROOT, join(ROOT, "mapping"));
const DECISIONS = loadDecisions(ROOT, join(ROOT, "decisions"));
const VARIANT = loadVariant(ROOT);
const MAIN = loadLock(join(ROOT, "spec-input", "spec-lock.yaml"));
const PRS = loadLock(join(ROOT, "spec-input", "with-open-prs.lock.yaml"));
const build = (lock: typeof MAIN, variant: Variant | null) => resolveBuild({ lock, root: ROOT, mappings: MAPPINGS, decisions: DECISIONS, kernel: KERNEL, constructors: CONSTRUCTORS, ...(variant ? { variant } : {}) });
const MAIN_WRITTEN = build(MAIN, VARIANT);
const MAIN_PROPOSED = build(MAIN, null);
const PRS_WRITTEN = build(PRS, VARIANT);

const property = (m: ModelDoc, type: string, member: string) => {
  const t = m.types.find((x) => x.name === type);
  assert.ok(t && "properties" in t, `${type} is an object`);
  return t.properties[member];
};

test("variantDir puts the variant after the top directory", () => {
  assert.equal(variantDir("schemas", "as-written"), "schemas/as-written");
  assert.equal(variantDir("schemas/with-open-prs", "as-written"), "schemas/as-written/with-open-prs");
  assert.equal(variantDir("sdk/with-open-prs", undefined), "sdk/with-open-prs");
});

test("the as-written variant resolves on both locks with no problem", () => {
  assert.deepEqual(MAIN_WRITTEN.problems, []);
  assert.deepEqual(PRS_WRITTEN.problems, []);
  assert.equal(MAIN_WRITTEN.model.input.variant, "as-written");
  assert.equal(MAIN_PROPOSED.model.input.variant, undefined);
});

test("as written, a minted ID is any string, a flight is a calendar date, and a span is the text's own form", () => {
  const m = MAIN_WRITTEN.model;
  assert.deepEqual(property(m, "Proposal", "proposal_id")!.type, { kind: "named", name: "Identifier" });
  assert.deepEqual(property(m, "Commitment", "flight_start")!.type, { kind: "named", name: "CalendarDate" });
  assert.deepEqual(property(m, "ProductionOption", "lead_time")!.type, { kind: "named", name: "Text" });
  assert.deepEqual(property(m, "ReportingOption", "cadence")!.type, { kind: "named", name: "BareTerm" });
  assert.deepEqual(property(m, "AudiencesOption", "provenance")!.type, { kind: "named", name: "BareTerm" });
  assert.ok(!m.types.some((t) => t.name === "Uuid" || t.name === "Provenance"), "the replaced types are gone");
  // `hold_duration`, which the text writes as an ISO 8601 duration, keeps its form.
  assert.deepEqual(property(m, "HoldStatus", "hold_duration")!.type, { kind: "named", name: "Duration" });
});

test("as written, the AdCOM flags are 0 or 1 and the AdCOM spans whole seconds", () => {
  const m = PRS_WRITTEN.model;
  for (const k of ["reward", "instl", "skip"]) assert.deepEqual(property(m, "Placement", k)!.type, { kind: "named", name: "IntegerFlag" });
  assert.deepEqual(property(m, "Placement", "skipafter")!.type, { kind: "named", name: "Count" });
  assert.deepEqual(property(m, "Refresh", "min_interval_s")!.type, { kind: "named", name: "Count" });
});

test("as written, the options the text lists without an id carry none, and the others keep theirs", () => {
  const m = MAIN_WRITTEN.model;
  for (const t of ["ProductionOption", "MeasurementSourceOption", "ReportingOption"]) assert.equal(property(m, t, "id"), undefined, `${t} has no id`);
  assert.deepEqual(property(m, "PropertiesOption", "id")!.type, { kind: "named", name: "Identifier" });
  assert.equal(property(m, "CancellationPolicyOption", "id")!.given, "Selectable");
  assert.ok(!(m.types.find((t) => t.name === "ProductionOption") as ModelType).decisions.includes("D-047"));
});

test("the variant's descriptions say what the variant holds, not the proposed form", () => {
  const copy = MAIN_WRITTEN.model.types.find((t) => t.name === "PropertiesSelection");
  assert.ok(copy?.kind === "copy");
  assert.doesNotMatch(JSON.stringify(copy.schema), /UUID/);
  const ts = MAIN_WRITTEN.model.types.find((t) => t.name === "Timestamp");
  assert.ok(ts?.kind === "primitive");
  assert.doesNotMatch(ts.description, /flight/);
});

test("the as-written model differs from the proposed one only where a switch says", () => {
  const r = checkVariantDiff(VARIANT, MAIN_PROPOSED.model, MAIN_WRITTEN.model, DECISIONS, "main");
  assert.deepEqual(r.problems, []);
  assert.ok(r.differences.some((d) => d.decision === "D-047" && d.type === "ReportingOption" && d.change === "withheld"));
  // A change no switch makes is caught.
  const changed: ModelDoc = {
    ...MAIN_WRITTEN.model,
    types: MAIN_WRITTEN.model.types.map((t) => (t.name === "Proposal" && "properties" in t ? ({ ...t, properties: { ...t.properties, seller_name: { ...t.properties.seller_name!, presence: "required" } } } as ModelType) : t)),
  };
  assert.match(checkVariantDiff(VARIANT, MAIN_PROPOSED.model, changed, DECISIONS, "main").problems.join("\n"), /"Proposal.seller_name" differs in a way no switch says/);
});

test("a retype whose element no longer has the proposed type is a problem", () => {
  const stale: Variant = { ...VARIANT, switches: VARIANT.switches.map((s) => (s.decision === "D-042" ? { ...s, retype: [{ ir: "key:5.6.1:commitment.flight_start", from: "Duration", to: "CalendarDate" }] } : s)) };
  const r = applyVariant(stale, { kernel: KERNEL, constructors: CONSTRUCTORS, mappings: MAPPINGS }, "main");
  assert.match(r.problems.join("\n"), /retypes "key:5\.6\.1:commitment\.flight_start" from Duration, but it is/);
});

test("checkVariant holds every departure to one switch, an option it lists, and changes it makes", () => {
  assert.deepEqual(checkVariant(VARIANT, DECISIONS, KERNEL, MAPPINGS), []);
  const gap: Variant = { ...VARIANT, switches: [...VARIANT.switches, { decision: "D-046", option: "optional-id", reads: "A gap switched off, which no variant may do.", withhold: ["PropertiesOption"] }] };
  assert.match(checkVariant(gap, DECISIONS, KERNEL, MAPPINGS).join("\n"), /D-046, which is no departure record in force/);
  const unknown: Variant = { ...VARIANT, switches: VARIANT.switches.map((s) => (s.decision === "D-040" ? { ...s, option: "seconds" } : s)) };
  assert.match(checkVariant(unknown, DECISIONS, KERNEL, MAPPINGS).join("\n"), /takes option "seconds", which D-040 doesn't list/);
});

test("the rule vectors are converted to the written forms, and a withheld member is dropped", () => {
  const vectors = loadVectors(ROOT);
  const r = PRS_WRITTEN.vectors(vectors);
  assert.deepEqual(r.problems, []);
  const entry = r.vectors.flatMap((f) => f.rules).find((e) => e.rule === "rule:5.2:f3d3f9e8")!;
  assert.ok(JSON.stringify(entry.valid).includes('"instl":1'), "true is 1 as written");
  const omid = r.vectors.flatMap((f) => f.rules).find((e) => e.rule === "rule:5.2.2:f9a1a6d5")!;
  assert.doesNotMatch(JSON.stringify(omid.valid), /"id":/, "a measurement source carries no id as written");
  const metrics = r.vectors.flatMap((f) => f.rules).find((e) => e.rule === "rule:5.7:4994173c")!;
  assert.match(JSON.stringify(metrics.valid), /"basis":"impressions"/);
});

test("the proposed model is the same with no variant input", () => {
  const ir = MAIN_PROPOSED.ir;
  const again = resolveModel({ ir, lock: "main", mappings: MAPPINGS, decisions: DECISIONS, kernel: KERNEL, constructors: CONSTRUCTORS, withhold: [] }).model;
  assert.deepEqual(again, MAIN_PROPOSED.model);
});
