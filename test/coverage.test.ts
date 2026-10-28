import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkMappingConstructors, loadConstructors, type Model } from "../src/constructors.ts";
import { checkCoverage, type CoverageResult } from "../src/coverage.ts";
import { indexElements } from "../src/elements.ts";
import type { SpecIR } from "../src/ir-types.ts";
import { loadKernel } from "../src/kernel.ts";
import { writeMappings } from "../src/map-writer.ts";
import { checkMapping, loadDecisions, loadMappings, type MappingFile } from "../src/mapping.ts";
import { objectOfField, objectOfKey, presenceOf } from "../src/mapping-rules.ts";
import { checkSources, identifiersOf, requiredLists } from "../src/mapping-sources.ts";
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

const all = (r: CoverageResult) => [...r.coverage, ...r.location, ...r.rules, ...r.types];
const check = (mappings: MappingFile[], lock = "with-open-prs") => checkCoverage(lock === "main" ? LOCKS[0]![1] : PRS, lock, mappings, KERNEL, CONSTRUCTORS);

/** The committed mapping with one file changed by `edit`. */
function edited(module: string, edit: (m: MappingFile) => void): MappingFile[] {
  const copy = structuredClone(MAPPINGS);
  const m = copy.find((x) => x.module === module);
  assert.ok(m, `no module ${module}`);
  edit(m);
  return copy;
}

const entryOf = (m: MappingFile, ir: string, lock = "with-open-prs") => {
  const e = m.entries.find((x) => x.ir === ir && (x.locks === undefined || x.locks.includes(lock)));
  assert.ok(e, `no entry for ${ir}`);
  return e;
};

test("the committed mapping is a bijection onto each lock's IR, and every check passes", () => {
  for (const [lock, ir] of LOCKS) {
    const r = checkCoverage(ir, lock, MAPPINGS, KERNEL, CONSTRUCTORS);
    assert.deepEqual(all(r), [], `${lock}: ${all(r).join("\n")}`);
    assert.deepEqual(checkMapping(ir, lock, MAPPINGS, DECISIONS), []);
    const inScope = MAPPINGS.flatMap((m) => m.entries.filter((e) => e.locks === undefined || e.locks.includes(lock)));
    assert.equal(inScope.length, indexElements(ir).size, `${lock}: one entry per element`);
  }
  const model: Model = { kernel: KERNEL, constructors: CONSTRUCTORS };
  assert.deepEqual(checkMappingConstructors(model, MAPPINGS), []);
});

test("an element without an entry, or an entry in another section's module, fails the bijection", () => {
  const missing = check(edited("commercial", (m) => (m.entries = m.entries.filter((e) => e.ir !== "field:5.6:min_spend"))));
  assert.match(missing.coverage.join("\n"), /"field:5\.6:min_spend" \(field, § 5\.6\) has no entry on lock "with-open-prs"/);
  const moved = structuredClone(MAPPINGS);
  const from = moved.find((m) => m.module === "commercial")!;
  const entry = entryOf(from, "field:5.6:min_spend");
  from.entries = from.entries.filter((e) => e !== entry);
  moved.find((m) => m.module === "targeting")!.entries.push(entry);
  assert.match(check(moved).coverage.join("\n"), /targeting\.yaml: entry "field:5\.6:min_spend" sits in § 5\.6, which module "commercial" owns/);
  const twice = edited("targeting", (m) => m.sections.push("5.6"));
  assert.match(check(twice).coverage.join("\n"), /section "5\.6" is also owned by module "commercial"/);
  const orphan = edited("appendices", (m) => (m.sections = m.sections.filter((s) => s !== "B")));
  assert.match(check(orphan).coverage.join("\n"), /section "B" \(Fields by marker\) on lock "with-open-prs" belongs to no module/);
});

test("a property sits at the object its path names, with the presence the specification states", () => {
  const object = check(edited("commercial", (m) => {
    const as = entryOf(m, "field:5.6:pricing[].floor").as;
    if (as.role === "property") as.object = "LineItem";
  }));
  assert.match(object.location.join("\n"), /"field:5\.6:pricing\[\]\.floor": the row's path makes it a property of "PricingEntry", not "LineItem"/);
  const presence = check(edited("proposal", (m) => {
    const as = entryOf(m, "field:4.1:seller_id").as;
    if (as.role === "property") as.presence = "required";
  }));
  assert.match(presence.location.join("\n"), /"field:4\.1:seller_id": presence is "required", but the specification states "optional"/);
});

test("an inline object's members are exactly the IR's, typed to match their [] and value lists", () => {
  const invented = check(edited("creative", (m) => {
    const as = entryOf(m, "field:5.4:assets[]#description/object:1").as;
    if (as.role === "type") as.members!.checksum = { type: { kind: "named", name: "Digest" }, presence: "optional" };
  }));
  assert.match(invented.location.join("\n"), /member "checksum" isn't in the IR object; the mapping can't add members \(no invented fields\)/);
  const dropped = check(edited("creative", (m) => {
    const as = entryOf(m, "field:5.4:assets[]#description/object:1").as;
    if (as.role === "type") delete as.members!.url_or_tag;
  }));
  assert.match(dropped.location.join("\n"), /the IR member "url_or_tag" has no type/);
  const notList = check(edited("proposal", (m) => {
    const as = entryOf(m, "field:4.1:negotiation_history[]#description/object:1").as;
    if (as.role === "type") as.members!.fields_changed = { type: { kind: "named", name: "Id" }, presence: "optional" };
  }));
  assert.match(notList.location.join("\n"), /member "fields_changed" is written with \[\] in the specification, so its type is a List/);
  const vocab = check(edited("proposal", (m) => {
    const as = entryOf(m, "field:4.1:negotiation_history[]#description/object:1").as;
    if (as.role === "type") as.members!.actor = { type: { kind: "named", name: "Token" }, presence: "optional" };
  }));
  assert.match(vocab.location.join("\n"), /member "actor" lists the values of "Party", so its type is "Party"/);
  const nested = check(edited("targeting", (m) => {
    const as = entryOf(m, "field:5.5:frequency_cap#description/object:1").as;
    if (as.role === "type") as.members!.max = { type: { kind: "named", name: "Count" }, presence: "optional" };
  }));
  assert.match(nested.location.join("\n"), /member "max" is the object \{ max, min \}, so its type has exactly those members/);
});

test("a rule entry is what its rule derives, and a rule declaration is what its rule declares", () => {
  const changed = check(edited("proposal", (m) => {
    const as = entryOf(m, "field:4.2:description").as;
    if (as.role === "property") as.type = { kind: "named", name: "ExternalId" };
  }));
  assert.match(changed.rules.join("\n"), /entry "field:4\.2:description": rule "domain-row" derives .*"name":"Text".*; run: npm run map/);
  const relabeled = check(edited("proposal", (m) => (entryOf(m, "field:4.1:version").source = { rule: "scalar-field" })));
  assert.match(relabeled.rules.join("\n"), /rule "domain-row" derives/);
  const undeclared = check(edited("commercial", (m) => (m.types = (m.types ?? []).filter((d) => d.name !== "Commitment"))));
  assert.match(undeclared.rules.join("\n"), /rule "key-table-object" declares "Commitment" on lock "with-open-prs", and no mapping file does/);
  assert.match(undeclared.types.join("\n"), /"Commitment" is no type the model defines/);
});

test("every type the mapping names is defined once, and every reference has the right kind", () => {
  const twice = check(edited("audience", (m) => {
    const as = entryOf(m, "field:5.3:audiences#description/object:1").as;
    if (as.role === "type") as.name = "PropertiesOption";
  }));
  assert.match(twice.types.join("\n"), /entry "field:5\.2:properties#description\/object:1": "PropertiesOption" is already defined by .*audience\.yaml/);
  const term = check(edited("kernel", (m) => {
    const as = entryOf(m, "marker:3:derived").as;
    if (as.role === "term") as.vocabulary = "Assent";
  }));
  assert.match(term.types.join("\n"), /"Assent" is a object, and a term belongs to a vocabulary/);
  assert.match(term.rules.join("\n"), /rule "marker-term" derives/);
  const primitive = check(edited("settlement", (m) => {
    const as = entryOf(m, "field:5.10:billing#description/object:1").as;
    if (as.role === "type") as.name = "Domain";
  }));
  assert.match(primitive.types.join("\n"), /"Domain" is already defined by .*kernel\/primitives\.yaml/);
});

test("the mapping files are what npm run map writes, and the writer is idempotent", () => {
  const locks = LOCKS.map(([name, ir]) => ({ name, ir }));
  const out = writeMappings(locks, MAPPINGS, KERNEL, CONSTRUCTORS);
  for (const [file, text] of out) assert.equal(text, readFileSync(file, "utf8"), file);
  // Without its rule entries and rule types, a file is rebuilt the same.
  const decided = MAPPINGS.map((m) => ({ ...m, entries: m.entries.filter((e) => !("rule" in e.source)), types: (m.types ?? []).filter((d) => !("rule" in d.source)) }));
  const again = writeMappings(locks, decided, KERNEL, CONSTRUCTORS);
  for (const [file, text] of again) assert.equal(text, out.get(file), file);
});

test("a row's object follows from its path, and its presence from its stated level", () => {
  const prs = indexElements(PRS);
  const field = (id: string) => prs.get(id)!.element as Parameters<typeof objectOfField>[0];
  const key = (id: string) => prs.get(id)!.element as Parameters<typeof objectOfKey>[1];
  assert.equal(objectOfField(field("field:4.1:proposal_id")), "Proposal");
  assert.equal(objectOfField(field("field:5.6:pricing[].floor")), "PricingEntry");
  assert.equal(objectOfKey(PRS, key("key:5.2:apps[].platform")), "AppsEntry");
  assert.equal(objectOfKey(PRS, key("key:5.6.1:commitment.currency")), "Commitment");
  assert.equal(objectOfKey(PRS, key("key:3.1:pricing")), null);
  assert.equal(presenceOf(field("field:4.2:description")), "required");
  assert.equal(presenceOf(field("field:4.1:brief_ref")), "conditional");
  assert.equal(presenceOf(key("key:5.6.1:commitment.currency")), "conditional");
  assert.equal(presenceOf(key("key:5.2.2:placement.plcmt")), "conditional");
  assert.equal(presenceOf(key("key:5.2:apps[].domain")), "optional", "RECOMMENDED isn't required");
  assert.equal(presenceOf(key("key:5.6.1:commitment.derived_units")), "optional", "a marker in the Required column states no presence");
  assert.equal(presenceOf(field("field:5.6:min_spend")), "optional");
});

test("a decision record can't override a mapping rule", () => {
  const overridden = check(edited("proposal", (m) => (entryOf(m, "field:4.1:version").source = { decision: "D-015" })));
  assert.match(overridden.rules.join("\n"), /entry "field:4\.1:version": rule "domain-row" applies on lock "with-open-prs", so the entry cites it, not a decision record/);
});

const sources = (mappings: MappingFile[], lock = "with-open-prs") => checkSources(lock === "main" ? LOCKS[0]![1] : PRS, lock, mappings, DECISIONS, KERNEL.lists);
const declOf = (m: MappingFile, name: string) => {
  const d = (m.types ?? []).find((x) => x.name === name);
  assert.ok(d, `no type ${name}`);
  return d;
};

test("the committed mapping's members, terms, presence, and names rest on the text they cite", () => {
  for (const [lock] of LOCKS) {
    const r = sources(MAPPINGS, lock);
    assert.deepEqual([...r.sources, ...r.names], [], lock);
  }
});

test("a declared object's member must be written by an element its decisions cover", () => {
  const added = sources(
    edited("publication", (m) => {
      declOf(m, "ProposalsEntry").members!.invented_field = { type: { kind: "named", name: "Text" }, presence: "optional" };
    }),
  );
  assert.match(added.sources.join("\n"), /type "ProposalsEntry": member "invented_field" is written by none of the elements it rests on/);
  const algo = sources(
    edited("targeting", (m) => {
      declOf(m, "ListRef").members!.algo = { type: { kind: "named", name: "Token" }, presence: "optional" };
    }),
  );
  assert.match(algo.sources.join("\n"), /type "ListRef": member "algo" is written by none/);
});

test("a path a decision reads from a prose item steps only through members a covered element writes", () => {
  const invented = sources(
    edited("representation", (m) => {
      const as = m.entries.find((x) => x.ir === "block:2.1:3/identifiers:1" && x.locks?.includes("with-open-prs"))!.as;
      assert.ok(as.role === "profile");
      as.reads = [{ item: "property names", paths: ["properties.available[].colour"] }];
    }),
  );
  assert.match(invented.sources.join("\n"), /entry "block:2\.1:3\/identifiers:1": path "properties\.available\[\]\.colour": member "colour" is written by none of the elements it rests on/);
});

test("a requiring statement that ends with a colon requires the list after it and the one a \"plus\" continues it with", () => {
  assert.deepEqual([...requiredLists(PRS)].filter((id) => id.startsWith("block:2.1:")).sort(), ["block:2.1:3/identifiers:1", "block:2.1:4/identifiers:1"]);
  // The placement keys a summary gives where its line item declares them are listed by a statement that ends with no colon.
  assert.ok(!requiredLists(PRS).has("block:2.1:7/identifiers:1"));
});

test("a member is required only where a covered element states REQUIRED, MUST, or SHALL for it", () => {
  const flipped = sources(
    edited("eligibility", (m) => {
      const as = entryOf(m, "field:5.8:terms_ref#description/object:1").as;
      assert.ok(as.role === "type" && as.members);
      as.members.version!.presence = "required";
    }),
  );
  assert.match(flipped.sources.join("\n"), /entry "field:5\.8:terms_ref#description\/object:1": member "version" is required, but no element it rests on states REQUIRED/);
  // The App identity rows state REQUIRED for `platform` and `bundle`, and D-025 covers them.
  assert.deepEqual(sources(MAPPINGS).sources, []);
});

test("a declared term must be written by an element its decisions cover", () => {
  const changed = sources(
    edited("commercial", (m) => {
      declOf(m, "CostMethod").terms = ["CPM", "CPX", "flat", "bogus"];
    }),
  );
  assert.match(changed.sources.join("\n"), /type "CostMethod": term "CPX" is written by none/);
  assert.match(changed.sources.join("\n"), /term "bogus"/);
  // `best_effort` rests on the § 5.5 sentence, which the IR records and D-025 covers.
  const sentence = indexElements(PRS).get("sentence:5.5:262ff404");
  assert.ok(sentence && identifiersOf(sentence).has("best_effort"));
});

test("an object that includes a profile restates none of its fields, and keeps a document field's type", () => {
  const restated = sources(
    edited("publication", (m) => {
      declOf(m, "ProposalsEntry").members!.seller_name = { type: { kind: "named", name: "Text" }, presence: "optional" };
    }),
  );
  assert.match(restated.sources.join("\n"), /member "seller_name" is a field of the profile "ProposalSummary" it includes/);
  const retyped = sources(
    edited("publication", (m) => {
      declOf(m, "ProposalsEntry").members!.version = { type: { kind: "named", name: "Id" }, presence: "optional" };
    }),
  );
  assert.match(retyped.sources.join("\n"), /member "version" .* but Proposal\.version is/);
});

test("an object is named after the field or member that holds it, unless a cited decision names it", () => {
  const renamed = sources(
    edited("commercial", (m) => {
      declOf(m, "CancellationPolicyOption").name = "CancellationRight";
      const as = entryOf(m, "field:5.6:cancellation_policy").as;
      assert.ok(as.role === "property" && as.type.kind === "apply");
      as.type.arguments.T = { kind: "named", name: "CancellationRight" };
    }),
  );
  assert.match(renamed.names.join("\n"), /holds "CancellationRight" names it "CancellationPolicyOption"/);
});

test("a vocabulary that cites a code list holds one term for each of its codes, and rests on an element or evidence that names the list", () => {
  for (const lock of ["main", "with-open-prs"]) assert.deepEqual(sources(MAPPINGS, lock).sources, [], lock);
  const period = (edit: (d: NonNullable<MappingFile["types"]>[number]) => void) => edited("targeting", (m) => edit(declOf(m, "FrequencyCapPeriod")));
  const problems = (ms: MappingFile[], lock = "with-open-prs") => sources(ms, lock).sources.join("\n");
  assert.match(problems(period((d) => (d.terms = d.terms!.filter((t) => t !== "flight")))), /the code "LineDuration" of OpenDirect 2\.1 Line\.frequencyinterval has no term/);
  assert.match(problems(period((d) => d.terms!.push("fortnight"))), /term "fortnight" stands for no code of OpenDirect 2\.1 Line\.frequencyinterval/);
  assert.match(problems(period((d) => (d.list = { name: "Line.frequencyinterval", codes: { ...d.list!.codes, flight: "Day" } }))), /terms "day" and "flight" stand for one code/);
  assert.match(problems(period((d) => (d.list = { name: "List: Nothing" }))), /cites the list "List: Nothing", which kernel\/lists\.yaml doesn't define/);
  // On main no element names the list, so the decision's evidence must.
  const noEvidence = DECISIONS.map((d) => (d.id === "D-044" ? { ...d, evidence: [] } : d));
  assert.match(checkSources(LOCKS[0]![1], "main", MAPPINGS, noEvidence, KERNEL.lists).sources.join("\n"), /no element it rests on names OpenDirect 2\.1 Line\.frequencyinterval/);
  assert.deepEqual(checkSources(PRS, "with-open-prs", MAPPINGS, noEvidence, KERNEL.lists).sources, [], "with the open PRs, the § 5.5 sentence names it");
});
