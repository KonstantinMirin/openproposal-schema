/**
 * The fidelity gate (src/fidelity.ts): the emitted schemas and rules give
 * every constraint the IR states the verdicts the specification says. A
 * disagreement fails, unless a decision of kind `departure` covers its exact
 * element with the constraint's form under that cover's `departs`, or
 * `gates/fidelity-expected.yaml` lists it: under the open task that removes
 * it, or as left to a rule that applies on its path and gives an invalid
 * vector it rules out. A listed disagreement that no longer occurs fails
 * too, and so does a departure's form that excuses nothing, and a projection
 * that holds a member its list, or a decision's reading of the list's prose
 * items, doesn't name. A reading that names no prose item of its list, or
 * starts at a field a code path of the list names, fails, since it would
 * widen a projection; the readings, `reads` in the mapping, are part of the
 * gate's fingerprint, as its other exemptions are.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { emitSchemas, type EmittedFile } from "../src/emit.ts";
import { checkFidelity, fidelityNote, type FidelityInput, type RuledEntry } from "../src/fidelity.ts";
import type { ModelDoc, ModelType } from "../src/model.ts";
import { defineGate, ROOT } from "./harness.ts";

export const EXPECTED_FILE = "gates/fidelity-expected.yaml";

/** Disagreements the gate expects, each group under the open task that removes it, and the constraints left to a rule because the schema can't state them. */
export interface ExpectedFile {
  format: 1;
  groups: { owner: string; reason: string; disagreements: { constraint: string; locks: string[]; detail: string }[] }[];
  ruled?: { constraint: string; locks: string[]; rule: string; reason: string }[];
}

export const loadExpected = (file = join(ROOT, EXPECTED_FILE)): ExpectedFile => parse(readFileSync(file, "utf8"), { version: "1.2", schema: "core" }) as ExpectedFile;

/** The constraints the file leaves to a rule on a lock. */
export const ruledOn = (e: ExpectedFile, lock: string): RuledEntry[] => (e.ruled ?? []).filter((r) => r.locks.includes(lock)).map((r) => ({ constraint: r.constraint, rule: r.rule }));

/** The input with the model changed and the schemas emitted from it again, as a change to the mapping would. */
const remodel = <I extends FidelityInput>(i: I, change: (types: Map<string, ModelType>) => void): I => {
  const model = structuredClone(i.model) as ModelDoc;
  change(new Map(model.types.map((t) => [t.name, t])));
  return { ...i, model, files: emitSchemas(model, i.schemaDir).files };
};
const vocabulary = (types: Map<string, ModelType>, name: string, drop: string) => {
  const t = types.get(name);
  if (t?.kind !== "vocabulary") throw new Error(`no vocabulary ${name}`);
  t.terms = t.terms.filter((x) => String(x.value) !== drop);
};
const property = (types: Map<string, ModelType>, type: string, name: string) => {
  const t = types.get(type);
  const p = t && "properties" in t ? t.properties[name] : undefined;
  if (!p) throw new Error(`no property ${type}.${name}`);
  return p;
};
const PLCMT = "key:5.2.2:placement.plcmt#conditional@line_item.placement.plcmt";
const PLCMT_RULE = "rule:5.2:f3d3f9e8";

const COMMERCIAL = "modules/commercial/1/commercial.json";
const PROPOSAL = "modules/proposal/1/proposal.json";
const LINE_ITEM = "documents/1/line-item.json";
const TIME_ZONE = "field:5.5:time_zone#conditional@line_item.time_zone";
/** The schema files with one document's root schema changed. */
const withDocument = (files: EmittedFile[], path: string, change: (s: Record<string, unknown>) => Record<string, unknown>): EmittedFile[] =>
  files.map((f) => {
    if (f.path !== path) return f;
    const schema = change(structuredClone(f.schema));
    return { ...f, schema, text: JSON.stringify(schema) };
  });

/** The schema files with one `$defs` entry changed. */
const withDef = (files: EmittedFile[], path: string, name: string, change: (s: Record<string, unknown>) => Record<string, unknown>): EmittedFile[] =>
  files.map((f) => {
    if (f.path !== path) return f;
    const schema = structuredClone(f.schema);
    const defs = schema.$defs as Record<string, Record<string, unknown>>;
    defs[name] = change(defs[name]!);
    return { ...f, schema, text: JSON.stringify(schema) };
  });

export const fidelity = defineGate<FidelityInput & { expected: ExpectedFile }>({
  id: "fidelity",
  title: "fidelity: the schemas and rules give every constraint the IR states the specification's verdicts, or a departure covers its element",
  code: ["src/fidelity.ts#checkFidelity", "src/fidelity.ts#readConstraints"],
  exemptions: [EXPECTED_FILE, "mapping/*.yaml#reads"],
  check: (i) => {
    const ruled = ruledOn(i.expected, i.lock);
    const r = checkFidelity({ ...i, ruled });
    const listed = new Map(i.expected.groups.flatMap((g) => g.disagreements.filter((d) => d.locks.includes(i.lock)).map((d) => [d.constraint, { ...d, owner: g.owner }] as const)));
    const problems = [...r.problems];
    for (const x of ruled) if (!r.ruled.some((y) => y.constraint === x.constraint) && !r.disagreements.some((y) => y.constraint === x.constraint)) problems.push(`${EXPECTED_FILE}: ${x.constraint} is no longer left to ${x.rule} on lock "${i.lock}": the schema states it, or the oracle no longer reads it; remove it`);
    const seen = new Set<string>();
    for (const d of r.disagreements) {
      const e = listed.get(d.constraint);
      seen.add(d.constraint);
      if (!e) problems.push(`${d.constraint}: ${d.detail}; fix the model, or record a departure that covers ${d.element}`);
      else if (e.detail !== d.detail) problems.push(`${EXPECTED_FILE}: ${d.constraint} changed on lock "${i.lock}": now ${d.detail}`);
    }
    for (const [c, e] of listed) if (!seen.has(c)) problems.push(`${EXPECTED_FILE}: ${c} no longer disagrees on lock "${i.lock}"; remove it, as ${e.owner} does`);
    return { problems, note: `${fidelityNote(r)}; ${listed.size} disagreements expected under ${[...new Set([...listed.values()].map((e) => e.owner))].join(", ") || "no task"}` };
  },
  fixtures: [
    {
      name: "a units commitment with no currency, which must stay valid",
      mutate: (i) => ({ ...i, files: withDef(i.files, COMMERCIAL, "Commitment", (s) => ({ ...s, required: [...(s.required as string[]), "currency"] })) }),
      expect: '"currency" absent while basis = "units" is valid, but the schema rejects it',
    },
    {
      name: "a spend commitment's currency left optional",
      mutate: (i) => ({ ...i, files: withDef(i.files, COMMERCIAL, "Commitment", (s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== "if" && k !== "then" && k !== "else"))) }),
      expect: '"currency" absent while basis = "spend" is invalid, but the schema accepts it',
    },
    {
      name: "currency deleted from PricingEntry",
      mutate: (i) => ({ ...i, files: withDef(i.files, COMMERCIAL, "PricingEntry", (s) => ({ ...s, properties: Object.fromEntries(Object.entries(s.properties as object).filter(([k]) => k !== "currency")) })) }),
      expect: 'the schema has no member "currency"',
    },
    {
      name: "currency deleted from MinCommitmentEntry",
      lock: "with-open-prs",
      mutate: (i) => ({ ...i, files: withDef(i.files, COMMERCIAL, "MinCommitmentEntry", (s) => ({ ...s, properties: Object.fromEntries(Object.entries(s.properties as object).filter(([k]) => k !== "currency")) })) }),
      expect: 'requires.min_commitment[].currency: the schema has no member "currency"',
    },
    {
      name: "a listed status the schema rejects",
      mutate: (i) => ({ ...i, files: withDef(i.files, PROPOSAL, "ProposalStatus", (s) => ({ ...s, enum: (s.enum as string[]).filter((x) => x !== "expired") })) }),
      expect: 'the listed "expired" is valid, but the schema rejects it',
    },
    {
      name: "a REQUIRED key the schema leaves optional",
      mutate: (i) => ({ ...i, files: withDef(i.files, COMMERCIAL, "Commitment", (s) => ({ ...s, required: (s.required as string[]).filter((x) => x !== "idempotency_key") })) }),
      expect: '"idempotency_key" absent is invalid, but the schema accepts it',
    },
    {
      name: "an Integer row typed as text",
      mutate: (i) => ({ ...i, files: i.files.map((f) => (f.path === "documents/1/proposal.json" ? { ...f, schema: { ...f.schema, properties: { ...(f.schema.properties as object), version: { type: "string" } } } } : f)) }),
      expect: "the stated type is Integer",
    },
    {
      name: "Selectable's included[] no longer required, which a rule of the shell names among its sources",
      lock: "with-open-prs",
      mutate: (i) =>
        remodel(i, (types) => {
          for (const t of types.values()) {
            if (t.kind !== "copy" || t.of.constructor !== "Selectable") continue;
            t.schema = { ...t.schema, required: (t.schema.required as string[]).filter((x) => x !== "included") };
          }
        }),
      expect: 'key:3.1:included[]#required@line_item.formats.included[]: "included" absent is invalid, but the schema accepts it',
    },
    {
      name: "time_zone no longer required with a frequency cap's period",
      lock: "with-open-prs",
      mutate: (i) => ({ ...i, files: withDocument(i.files, LINE_ITEM, (s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== "dependentSchemas"))) }),
      expect: `${TIME_ZONE}: "time_zone" absent with frequency_cap.period is invalid, but the schema accepts it`,
    },
    {
      name: "time_zone required with any frequency cap, a period or not",
      lock: "with-open-prs",
      mutate: (i) =>
        ({ ...i, files: withDocument(i.files, LINE_ITEM, (s) => ({ ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== "dependentSchemas")), dependentRequired: { ...(s.dependentRequired as object), frequency_cap: ["time_zone"] } })) }),
      expect: `${TIME_ZONE}: "time_zone" absent with frequency_cap but no frequency_cap.period is valid, but the schema rejects it`,
    },
    {
      name: "a daypart, not time_zone, required with a frequency cap's period",
      lock: "with-open-prs",
      mutate: (i) => ({ ...i, files: withDocument(i.files, LINE_ITEM, (s) => ({ ...s, dependentSchemas: { frequency_cap: { ...(s.dependentSchemas as Record<string, object>).frequency_cap, then: { required: ["daypart"] } } } })) }),
      expect: `${TIME_ZONE}: "time_zone" present with frequency_cap.period is valid, but the schema rejects it: / must have required property 'daypart'`,
    },
    {
      name: "a daypart required beside time_zone with a frequency cap's period",
      lock: "with-open-prs",
      mutate: (i) => ({ ...i, files: withDocument(i.files, LINE_ITEM, (s) => ({ ...s, dependentSchemas: { frequency_cap: { ...(s.dependentSchemas as Record<string, object>).frequency_cap, then: { required: ["daypart", "time_zone"] } } } })) }),
      expect: `${TIME_ZONE}: "time_zone" present with frequency_cap.period is valid, but the schema rejects it: / must have required property 'daypart'`,
    },
    {
      name: "time_zone no longer required with a daypart",
      lock: "with-open-prs",
      mutate: (i) => ({ ...i, files: withDocument(i.files, LINE_ITEM, (s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== "dependentRequired"))) }),
      expect: `${TIME_ZONE}: "time_zone" absent with daypart is invalid, but the schema accepts it`,
    },
    {
      name: "plcmt required on every channel, not only for video",
      lock: "with-open-prs",
      mutate: (i) => remodel(i, (types) => void (property(types, "Placement", "plcmt").presence = "required")),
      expect: '"plcmt" absent while channel = "display" is valid, but the schema rejects it',
    },
    { name: "Initiated by idling, sound off (11) dropped from the playback methods", lock: "with-open-prs", mutate: (i) => remodel(i, (types) => vocabulary(types, "PlaybackMethod", "11")), expect: '"playmethod" listing the listed 11 is valid, but the schema rejects it' },
    {
      name: "a playback method the list doesn't hold accepted",
      lock: "with-open-prs",
      mutate: (i) => remodel(i, (types) => void (types.get("PlaybackMethod") as { terms: { value: number; sources: string[] }[] }).terms.push({ value: 12, sources: [] })),
      expect: '"playmethod" listing the unlisted 12 is invalid, but the schema accepts it',
    },
    {
      name: "the API frameworks closed, so a vendor's code is rejected",
      lock: "with-open-prs",
      mutate: (i) => remodel(i, (types) => void ((types.get("ApiFramework") as { open: boolean }).open = false)),
      expect: '"api" listing the vendor code 500 is valid, but the schema rejects it',
    },
    {
      name: "the vendor codes from 499, a code List: API Frameworks doesn't hold",
      lock: "with-open-prs",
      mutate: (i) => remodel(i, (types) => void ((types.get("VendorCode") as { schema: Record<string, unknown> }).schema.minimum = 499)),
      expect: '"api" listing the unlisted 499, below the vendor codes, is invalid, but the schema accepts it',
    },
    { name: "In-scene (9) dropped from the plcmt codes", lock: "with-open-prs", mutate: (i) => remodel(i, (types) => vocabulary(types, "PlcmtSubtype", "9")), expect: '"plcmt" as the listed 9 is valid, but the schema rejects it' },
    {
      name: "best_effort and keyword dropped from the exclusion vocabularies",
      lock: "with-open-prs",
      mutate: (i) =>
        remodel(i, (types) => {
          vocabulary(types, "Enforcement", "best_effort");
          vocabulary(types, "ExclusionType", "keyword");
        }),
      expect: '"enforcement" with an entry of the listed "best_effort" is valid, but the schema rejects it',
    },
    { name: "keyword dropped from the exclusion types", lock: "with-open-prs", mutate: (i) => remodel(i, (types) => vocabulary(types, "ExclusionType", "keyword")), expect: /"types" as the example writes it, \[[^\]]*"keyword"\] is valid, but the schema rejects it/ },
    {
      name: "format IDs typed as external IDs, so a format with no channel passes",
      mutate: (i) =>
        remodel(i, (types) => {
          const t = types.get("FormatsSelection");
          if (t?.kind !== "copy") throw new Error("no copy FormatsSelection");
          t.schema = JSON.parse(JSON.stringify(t.schema).replaceAll('"#/$defs/FormatId"', '"#/$defs/ExternalId"')) as typeof t.schema;
        }),
      expect: '"available" listing "300x250", the example "display/300x250" without its namespace, is invalid, but the schema accepts it',
    },
    { name: "gross_rate typed as a count", mutate: (i) => remodel(i, (types) => void (property(types, "PricingEntry", "gross_rate").type = { kind: "named", name: "Count" })), expect: '"gross_rate" as 0.5, which is Number, is valid, but the schema rejects it' },
    { name: "valid_from typed as text", mutate: (i) => remodel(i, (types) => void (property(types, "Proposal", "valid_from").type = { kind: "named", name: "Text" })), expect: '"valid_from" as "not-a-time", which isn\'t Timestamp, is invalid, but the schema accepts it' },
    {
      name: "a rule-carried constraint no longer listed",
      lock: "with-open-prs",
      mutate: (i) => ({ ...i, expected: { ...i.expected, ruled: [] } }),
      expect: `${PLCMT}: "plcmt" absent while channel = "video" is invalid, but the schema accepts it`,
    },
    {
      name: "a listed rule that applies elsewhere",
      lock: "with-open-prs",
      mutate: (i) => ({ ...i, rules: { ...i.rules, rules: i.rules.rules.map((r) => (r.id === PLCMT_RULE ? { ...r, applies_to: ["LineItem.channel"] } : r)) } }),
      expect: `listed as left to ${PLCMT_RULE}, but ${PLCMT_RULE} applies to LineItem.channel`,
    },
    {
      name: "a listed rule with no invalid vector the constraint rules out",
      lock: "with-open-prs",
      mutate: (i) => ({ ...i, rules: { ...i.rules, rules: i.rules.rules.map((r) => (r.id === PLCMT_RULE ? { ...r, vectors: { ...r.vectors, invalid: r.vectors.invalid.map((x) => ({ ...x, value: { channel: "video" } })) } } : r)) } }),
      expect: `no invalid vector of ${PLCMT_RULE} is a payload the constraint rules out`,
    },
    {
      name: "a listed rule-carried constraint that no longer disagrees",
      mutate: (i) => ({ ...i, expected: { ...i.expected, ruled: [...(i.expected.ruled ?? []), { constraint: "no-such-constraint", locks: [i.lock], rule: PLCMT_RULE, reason: "A fixture." }] } }),
      expect: "no-such-constraint is no longer left to",
    },
    {
      name: "a departure's form moved from the value list to its row",
      lock: "with-open-prs",
      mutate: (i) => ({ ...i, decisions: i.decisions.map((d) => (d.id === "D-039" ? { ...d, covers: d.covers.map((c) => (c.ir === "key:5.2.2:placement.reward#meaning/values:1" ? { ...c, departs: undefined } : c.ir === "key:5.2.2:placement.reward" ? { ...c, departs: ["values"] } : c)) } : d)) }),
      expect: '"reward" as the listed 0 is valid, but the schema rejects it',
    },
    {
      name: "a departure's form that excuses no disagreement",
      lock: "with-open-prs",
      mutate: (i) => ({ ...i, decisions: i.decisions.map((d) => (d.id === "D-039" ? { ...d, covers: d.covers.map((c) => (c.ir === "key:5.2.2:placement.reward#meaning/values:1" ? { ...c, departs: ["values", "type"] } : c)) } : d)) }),
      expect: 'D-039: departs from the type form of key:5.2.2:placement.reward#meaning/values:1 on lock "with-open-prs", but no disagreement of that form occurs there',
    },
    {
      name: "a departure no longer recorded as one",
      lock: "with-open-prs",
      mutate: (i) => ({ ...i, decisions: i.decisions.map((d) => (d.id === "D-039" ? { ...d, kind: "gap" } : d)) }),
      expect: '"reward" as the listed 0 is valid, but the schema rejects it',
    },
    {
      name: "a path the summary MUST contain left optional, and listed nowhere",
      mutate: (i) => remodel(i, (types) => void (property(types, "LineItemSummary", "line_item_id").presence = "optional")),
      expect: '"line_item_id" absent is invalid, but the schema accepts it',
    },
    {
      name: "the summary's whole pricing entry, not its two paths, with each member's own presence",
      mutate: (i) => remodel(i, (types) => void (property(types, "LineItemSummary", "pricing").type = { kind: "apply", constructor: "List", arguments: { T: { kind: "named", name: "PricingEntry" } } })),
      expect: '"cost_method" absent is invalid, but the schema accepts it',
    },
    {
      name: "the summary's formats widened back to the whole field, with its required included[]",
      mutate: (i) => remodel(i, (types) => void (property(types, "LineItemSummary", "formats").type = property(types, "LineItem", "formats").type)),
      expect: /the schema's "formats" holds "available", which no listed path names and no listed member requires/,
    },
    {
      name: "the summary's environments widened back to the whole field",
      lock: "with-open-prs",
      mutate: (i) => remodel(i, (types) => void (property(types, "LineItemSummary", "environments").type = property(types, "LineItem", "environments").type)),
      expect: /the schema's "environments" holds "included", which no listed path names and no listed member requires/,
    },
    {
      name: "the summary's placement widened back to the whole field, past the four keys it gives",
      lock: "with-open-prs",
      mutate: (i) => remodel(i, (types) => void (property(types, "LineItemSummary", "placement").type = property(types, "LineItem", "placement").type)),
      expect: /block:2\.1:7\/identifiers:1#projection@placement: .* the schema's "placement" holds "api", which no listed path names/,
    },
    {
      name: "a placement key the summary gives where its line item declares it made required",
      lock: "with-open-prs",
      mutate: (i) => remodel(i, (types) => void (property(types, "LineItemSummaryPlacement", "skip").presence = "required")),
      expect: '"skip" absent is valid, but the schema rejects it',
    },
    {
      name: "the summary's properties widened back to the whole field, past the property names D-028 reads",
      mutate: (i) => remodel(i, (types) => void (property(types, "LineItemSummary", "properties").type = property(types, "LineItem", "properties").type)),
      expect: /block:2\.1:3\/identifiers:1#projection@properties: .* the schema's "properties" holds "included", which no listed path names/,
    },
    {
      name: "a decision's reading of a prose item to a path the schema doesn't hold",
      mutate: (i) => ({ ...i, readings: i.readings.map((r) => ({ ...r, paths: ["properties.available[].title"] })) }),
      expect: 'D-028 reads the list\'s prose item as "properties.available.title", but the schema has no member "title"',
    },
    {
      name: "the summary's formats widened back to the whole field, with a reading of each member the list doesn't name",
      mutate: (i) => ({
        ...remodel(i, (types) => void (property(types, "LineItemSummary", "formats").type = property(types, "LineItem", "formats").type)),
        readings: i.readings.map((r) => ({ ...r, paths: [...r.paths, "formats.available[]", "formats.pricing", "formats.max_select"] })),
      }),
      expect: 'block:2.1:3/identifiers:1#reading@formats.available[]: D-028 reads the prose item "property names" as "formats.available[]", but "formats.available[]" starts at "formats", which the list\'s code path "formats.included[]" names, so the reading would widen what that path projects',
    },
    {
      name: "a decision's reading of a prose item the list doesn't write",
      mutate: (i) => ({ ...i, readings: i.readings.map((r) => ({ ...r, item: "property ids" })) }),
      expect: 'D-028 reads the prose item "property ids", but the list writes no prose item "property ids"; its prose items are "property names"',
    },
    {
      name: "a decision's reading of a list no MUST-contain statement introduces",
      lock: "with-open-prs",
      mutate: (i) => ({ ...i, readings: i.readings.map((r) => ({ ...r, list: "block:2.1:7/identifiers:1" })) }),
      expect: "no MUST-contain statement introduces the list, so the reading joins no projection",
    },
    {
      name: "a proposal path that \"plus\" adds to the summary left optional",
      mutate: (i) => remodel(i, (types) => void (property(types, "ProposalSummary", "valid_until").presence = "optional")),
      expect: '"valid_until" absent is invalid, but the schema accepts it',
    },
    {
      name: "an expected disagreement that no longer occurs",
      mutate: (i) => ({ ...i, expected: { ...i.expected, groups: [...i.expected.groups, { owner: "a fixture", reason: "A fixture.", disagreements: [{ constraint: "no-such-constraint", locks: [i.lock], detail: "none" }] }] } }),
      expect: "no-such-constraint no longer disagrees",
    },
  ],
});
