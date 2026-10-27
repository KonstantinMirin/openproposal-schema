import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { loadConstructors } from "../src/constructors.ts";
import { checkDomains, checkDomainSources, conceptOfRow, homonymProblems, kernelTypes, propertyProblems, resolveType, useProblems, type Domains } from "../src/domains.ts";
import { emitSchemas, schemaIdOf } from "../src/emit.ts";
import { installFormats } from "../src/formats.ts";
import type { SpecIR } from "../src/ir-types.ts";
import { loadKernel } from "../src/kernel.ts";
import { loadDecisions, loadMappings } from "../src/mapping.ts";
import { resolveModel, type ModelDoc, type ModelType } from "../src/model.ts";
import { ROOT } from "./helpers.ts";

const KERNEL = loadKernel(ROOT);
const DOMAINS = KERNEL.domains!;
const CONSTRUCTORS = loadConstructors(ROOT);
const MAPPINGS = loadMappings(ROOT, join(ROOT, "mapping"));
const DECISIONS = loadDecisions(ROOT, join(ROOT, "decisions"));
const TYPES = kernelTypes(KERNEL.primitives, CONSTRUCTORS.parts, { kernel: KERNEL.file, constructors: CONSTRUCTORS.file });
const ir = (dir: string) => JSON.parse(readFileSync(join(ROOT, dir, "spec-ir.json"), "utf8")) as SpecIR;
const LOCKS: { lock: string; ir: SpecIR; model: ModelDoc; dir: string }[] = [
  ["main", "ir", "schemas"],
  ["with-open-prs", join("ir", "with-open-prs"), "schemas/with-open-prs"],
].map(([lock, irDir, dir]) => {
  const x = ir(irDir!);
  return { lock: lock!, ir: x, model: resolveModel({ ir: x, lock: lock!, mappings: MAPPINGS, decisions: DECISIONS, kernel: KERNEL, constructors: CONSTRUCTORS }).model, dir: dir! };
});
const domains = (edit: (d: Domains) => void): Domains => {
  const d = structuredClone(DOMAINS);
  edit(d);
  return d;
};
const concept = (d: Domains, name: string) => d.domains.flatMap((x) => x.concepts).find((c) => c.name === name)!;

test("the committed domain model is sound, current on both locks, and every lock's model obeys it", () => {
  assert.deepEqual(checkDomains(DOMAINS, TYPES, DECISIONS), []);
  for (const l of LOCKS) {
    assert.deepEqual(checkDomainSources(l.ir, l.lock, DOMAINS, TYPES), [], l.lock);
    assert.deepEqual(useProblems(l.model, l.lock, TYPES), [], l.lock);
    assert.deepEqual(propertyProblems(l.model, l.lock, DOMAINS, DECISIONS), [], l.lock);
  }
  assert.deepEqual(homonymProblems(LOCKS.map((l) => l.model), DOMAINS), []);
});

test("time has four concepts, and every time value of every lock fits one", () => {
  const time = DOMAINS.domains.find((d) => d.name === "time")!;
  assert.deepEqual(time.concepts.map((c) => c.type), ["Timestamp", "Duration", "DaypartWindow", "TimeZone"]);
  for (const l of LOCKS) {
    for (const t of l.model.types) {
      if (!("properties" in t)) continue;
      for (const [k, p] of Object.entries(t.properties)) {
        const r = resolveType(p.type, l.model, DOMAINS);
        if (r === null || "vocabulary" in r) continue;
        const c = DOMAINS.domains.find((d) => d.concepts.some((x) => x.name === r.concept));
        if (/(_at|_until|_from|_start|_end|_time|duration|period|window|latency|_s)$/.test(k)) assert.equal(c?.name, "time", `${l.lock}: ${t.name}.${k}`);
      }
    }
  }
});

test("a concept whose type declares another concept, and a kernel type no concept names, fail", () => {
  const swapped = checkDomains(domains((d) => (concept(d, "count").type = "Fraction")), TYPES, DECISIONS);
  assert.ok(swapped.some((p) => /concept "count": its type "Fraction" declares the concept "fraction"/.test(p)), swapped.join("\n"));
  assert.ok(swapped.some((p) => /Count declares the concept "count", which doesn't name it/.test(p)), swapped.join("\n"));
  const unknown = checkDomains(DOMAINS, [...TYPES, { ...TYPES[0]!, name: "Orphan", concept: "orphan" }], DECISIONS);
  assert.ok(unknown.some((p) => /Orphan declares the concept "orphan", which .* doesn't define/.test(p)), unknown.join("\n"));
  const decision = checkDomains(domains((d) => (concept(d, "amount").requires!.decision = "D-999")), TYPES, DECISIONS);
  assert.ok(decision.some((p) => /cites decision "D-999", which doesn't exist/.test(p)), decision.join("\n"));
});

test("a concept the lock publishes cites an element in scope or a standard", () => {
  const bare = domains((d) => (concept(d, "text").sources = { spec: concept(d, "text").sources.spec!.map((c) => ({ ...c, locks: ["with-open-prs"] })) }));
  const [main, prs] = LOCKS.map((l) => checkDomainSources(l.ir, l.lock, bare, TYPES));
  assert.deepEqual(main, [`${DOMAINS.file}: concept "text": cites no specification element on lock "main" and no standard`]);
  assert.deepEqual(prs, []);
  const stale = domains((d) => (concept(d, "text").sources.spec![0]!.digest = "f".repeat(64)));
  assert.match(checkDomainSources(LOCKS[0]!.ir, "main", stale, TYPES)[0]!, /concept "text": stale digest for "field:4\.2:description"/);
});

test("a row one concept cites is typed by the concept; a row two concepts cite is typed by neither", () => {
  assert.equal(conceptOfRow(DOMAINS, "field:4.1:version")?.type, "Count", "a proposal's version counts its revisions");
  assert.equal(conceptOfRow(DOMAINS, "key:3.1:pricing#meaning/object:1"), null);
  const entry = MAPPINGS.flatMap((m) => m.entries).find((e) => e.ir === "field:4.1:version")!;
  assert.deepEqual(entry.source, { rule: "domain-row" });
});

test("a primitive no document reaches on a lock isn't published there", () => {
  const prs = LOCKS[1]!;
  const digest = prs.model.types.find((t) => t.name === "Digest")!;
  assert.ok(digest);
  assert.equal(LOCKS[0]!.model.types.find((t) => t.name === "Digest"), undefined);
  const orphan: ModelType = { ...digest, name: "Orphan", sources: [] };
  const model = { ...prs.model, types: [...prs.model.types, orphan] };
  const problems = useProblems(model, prs.lock, [...TYPES, { name: "Orphan", kind: "primitive", concept: "digest", spec: [], standards: [], where: KERNEL.file }]);
  assert.ok(problems.some((p) => /primitive "Orphan": no document reaches it on lock "with-open-prs"/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /primitive "Orphan": cites no specification element on lock "with-open-prs" and no standard/.test(p)), problems.join("\n"));
});

test("a property typed by the term grammar, by a component, or with money and no currency fails", () => {
  const main = LOCKS[0]!;
  const edited = (object: string, property: string, name: string): ModelDoc => {
    const m = structuredClone(main.model);
    const t = m.types.find((x) => x.name === object) as Extract<ModelType, { kind: "object" }>;
    t.properties[property]!.type = { kind: "named", name };
    return m;
  };
  const has = (problems: string[], re: RegExp) => assert.ok(problems.some((p) => re.test(p)), problems.join("\n"));
  has(propertyProblems(edited("FrequencyCap", "basis", "NamespacedTerm"), "main", DOMAINS, DECISIONS), /"FrequencyCap": property "basis": its type is the term grammar/);
  has(propertyProblems(edited("FrequencyCap", "basis", "TimeOfDay"), "main", DOMAINS, DECISIONS), /"FrequencyCap": property "basis": its type is a component of the concept "daypart-window"/);
  const money = propertyProblems(edited("HoldStatus", "hold_duration", "Amount"), "main", DOMAINS, DECISIONS);
  has(money, /"HoldStatus": property "hold_duration": carries a value of the concept "amount" with no sibling "currency" .* "lacking" lists none of key:5\.6\.2:hold_status\.hold_duration/);
});

/**
 * The money gate (type rules § 3a) passes a value without its currency only
 * where the concept's `lacking` lists one of its elements: an object that
 * carries its currency doesn't rest on the decision, so deleting the currency
 * fails the gate itself, not only the round trip or the examples.
 */
test("deleting the currency from an object that carries one fails the money gate", () => {
  for (const [lock, object] of [["main", "Commitment"], ["main", "PricingEntry"], ["with-open-prs", "Commitment"], ["with-open-prs", "MinCommitmentEntry"], ["with-open-prs", "PricingEntry"]] as const) {
    const m = structuredClone(LOCKS.find((l) => l.lock === lock)!.model);
    const t = m.types.find((x) => x.name === object) as Extract<ModelType, { kind: "object" }>;
    delete t.properties.currency;
    const problems = propertyProblems(m, lock, DOMAINS, DECISIONS);
    assert.ok(problems.some((p) => new RegExp(`"${object}": property "[a-z_]+": carries a value of the concept "amount" with no sibling "currency"`).test(p)), `${lock}: ${object}: ${problems.join("\n")}`);
  }
  // A currency of another concept is no currency.
  const m = structuredClone(LOCKS[0]!.model);
  (m.types.find((x) => x.name === "Commitment") as Extract<ModelType, { kind: "object" }>).properties.currency!.type = { kind: "named", name: "Text" };
  assert.ok(propertyProblems(m, "main", DOMAINS, DECISIONS).some((p) => /"Commitment": property "amount": carries a value of the concept "amount" with no sibling "currency"/.test(p)));
});

test("the elements that lack a currency are listed, covered by the decision, and current; every money concept but the currency requires it", () => {
  const stale = propertyProblems(LOCKS[0]!.model, "main", domains((d) => concept(d, "amount").requires!.lacking.push({ ir: "key:5.6.1:commitment.amount" })), DECISIONS);
  assert.ok(stale.some((p) => /concept "amount": requires: lacking lists "key:5\.6\.1:commitment\.amount", but no value of the concept rests on it without its sibling on lock "main"/.test(p)), stale.join("\n"));
  const uncovered = checkDomains(domains((d) => concept(d, "amount").requires!.lacking.push({ ir: "field:5.6:hold_status" })), TYPES, DECISIONS);
  assert.ok(uncovered.some((p) => /lacking lists "field:5\.6:hold_status", which D-036 doesn't cover/.test(p)), uncovered.join("\n"));
  const missing = checkDomains(domains((d) => delete concept(d, "option-price-delta").requires), TYPES, DECISIONS);
  assert.ok(missing.some((p) => /concept "option-price-delta" of the domain "money" states no "requires"/.test(p)), missing.join("\n"));
});

test("a recurring member name with two concepts needs a homonym, and a homonym that no longer differs fails", () => {
  const unlisted = homonymProblems(LOCKS.map((l) => l.model), domains((d) => (d.homonyms = d.homonyms.filter((h) => h.member !== "version"))));
  assert.equal(unlisted.length, 1, unlisted.join("\n"));
  assert.match(unlisted[0]!, /the member name "version" resolves to 2 concepts: count \(/);
  const stale = homonymProblems(LOCKS.map((l) => l.model), domains((d) => d.homonyms.push({ member: "currency", decision: "D-036", reason: "Every currency is one concept." })));
  assert.deepEqual(stale, [`${DOMAINS.file}: homonym "currency" resolves to one concept on every lock; remove it`]);
});

/**
 * Money and its currency (type rules § 3a): every object that carries a money
 * value carries its currency beside it, required with the value. On each lock
 * and for each such object, a value without a currency is invalid, and a
 * currency with no value is valid unless the specification requires the value.
 */
test("money vectors: an amount without its currency is invalid, and a currency alone is valid unless the amount is required", () => {
  let objects = 0;
  for (const l of LOCKS) {
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
    installFormats(ajv);
    for (const f of emitSchemas(l.model, l.dir).files) ajv.addSchema(f.schema);
    for (const t of l.model.types) {
      if (t.kind !== "object") continue;
      const money = Object.entries(t.properties).filter(([, p]) => p.type.kind === "named" && ["Amount", "PriceAdjustment"].includes(p.type.name));
      // An object whose basis reads its amount has its own vectors, below.
      if (money.length === 0 || !("currency" in t.properties) || money.some(([, p]) => p.cases !== undefined)) continue;
      objects++;
      const validate = ajv.getSchema(schemaIdOf(t, l.dir)!)!;
      // The members the object requires whatever its money says, from the committed examples' values.
      const base: Record<string, unknown> = {};
      for (const [k, p] of Object.entries(t.properties)) {
        if (p.presence !== "required" || k === "currency" || money.some(([m]) => m === k)) continue;
        base[k] = { flight_start: "2026-10-06T00:00:00-04:00", flight_end: "2026-12-21T00:00:00-05:00", idempotency_key: "7c9e6679-7425-40de-944b-e07fc1f90ae7", proposal_id: "7c9e6679-7425-40de-944b-e07fc1f90ae8", version: 3, cost_method: "CPM" }[k];
      }
      const where = `${l.lock}: ${t.name}`;
      for (const [k, p] of money) {
        if (p.presence === "required" && t.properties.currency!.presence === "conditional") continue;
        assert.equal(validate({ ...base, ...Object.fromEntries(money.filter(([m]) => m === k || t.properties[m]!.presence === "required").map(([m]) => [m, 10])) }), false, `${where}: ${k} without currency`);
        assert.equal(validate({ ...base, ...Object.fromEntries(money.filter(([m]) => m === k || t.properties[m]!.presence === "required").map(([m]) => [m, 10])), currency: "USD" }), true, `${where}: ${k} with currency: ${JSON.stringify(validate.errors)}`);
      }
      const amountRequired = money.some(([, p]) => p.presence === "required");
      assert.equal(validate({ ...base, currency: "USD" }), !amountRequired, `${where}: a currency alone`);
    }
  }
  assert.ok(objects >= 2, `${objects} objects carry money and a currency`);
});

/**
 * A basis says what an amount is (type rules § 3a, D-036): the commitment's
 * and a `min_commitment[]` threshold's `amount` is money, with its currency
 * required, when `basis` is `spend`, and a whole count of units, with no
 * currency, when `basis` is `units`.
 */
test("a basis types its amount: money with its currency for spend, a count with none for units", () => {
  const uuid = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const cases: { lock: string; object: string; base: Record<string, unknown> }[] = [
    { lock: "main", object: "Commitment", base: { flight_start: "2026-10-06T00:00:00-04:00", flight_end: "2026-12-21T00:00:00-05:00", idempotency_key: uuid } },
    { lock: "with-open-prs", object: "Commitment", base: { flight_start: "2026-10-06T00:00:00-04:00", flight_end: "2026-12-21T00:00:00-05:00", idempotency_key: uuid, proposal_id: uuid, version: 1 } },
    { lock: "with-open-prs", object: "MinCommitmentEntry", base: { line_item_id: uuid } },
  ];
  for (const { lock, object, base } of cases) {
    const l = LOCKS.find((x) => x.lock === lock)!;
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
    installFormats(ajv);
    for (const f of emitSchemas(l.model, l.dir).files) ajv.addSchema(f.schema);
    const validate = ajv.getSchema(schemaIdOf(l.model.types.find((t) => t.name === object)!, l.dir)!)!;
    const where = `${lock}: ${object}`;
    assert.equal(validate({ ...base, basis: "spend", amount: 80000 }), false, `${where}: spend without currency`);
    assert.equal(validate({ ...base, basis: "spend", amount: 80000, currency: "USD" }), true, `${where}: spend with currency`);
    assert.equal(validate({ ...base, basis: "spend", amount: 80000.5, currency: "USD" }), true, `${where}: a spend amount in cents`);
    assert.equal(validate({ ...base, basis: "units", amount: 500000 }), true, `${where}: units without currency: ${JSON.stringify(validate.errors)}`);
    assert.equal(validate({ ...base, basis: "units", amount: 0.5 }), false, `${where}: half a unit`);
    assert.equal(validate({ ...base, basis: "units", amount: -1 }), false, `${where}: a negative count`);
  }
  // A threshold's amount is read by its basis, so it carries one.
  const prs = LOCKS[1]!;
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  installFormats(ajv);
  for (const f of emitSchemas(prs.model, prs.dir).files) ajv.addSchema(f.schema);
  const threshold = ajv.getSchema(schemaIdOf(prs.model.types.find((t) => t.name === "MinCommitmentEntry")!, prs.dir)!)!;
  assert.equal(threshold({ line_item_id: uuid, amount: 50000, currency: "USD" }), false);
  assert.equal(threshold({ line_item_id: uuid }), true);
});

test("a basis whose type isn't one of its terms' concepts, or that no object reads, fails", () => {
  const off = resolveModel({ ir: LOCKS[0]!.ir, lock: "main", mappings: MAPPINGS, decisions: DECISIONS, kernel: { ...KERNEL, domains: domains((d) => (d.bases[0]!.terms = { spend: "count", units: "fraction" })) }, constructors: CONSTRUCTORS });
  assert.ok(off.problems.some((p) => /"Commitment": property "amount": its basis "basis" reads it as count for "spend", fraction for "units"/.test(p)), off.problems.join("\n"));
  const unread = propertyProblems(LOCKS[0]!.model, "main", domains((d) => d.bases.push({ vocabulary: "HoldScope", member: "amount", terms: { proposal: "amount", line_item: "count" }, decision: "D-036" })), DECISIONS);
  assert.ok(unread.some((p) => /basis "HoldScope": no object holds it beside "amount" on lock "main"/.test(p)), unread.join("\n"));
});
