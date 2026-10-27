import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkDuplication, fingerprint, type NamedStructure } from "../src/duplication.ts";
import type { SpecIR } from "../src/ir-types.ts";
import { checkKernelEngines, engineCases, loadOracleGaps, type Engines } from "../src/engines.ts";
import { checkKernel, checkKernelNames, checkKernelSources, kernelStructures, loadKernel, patternPortability, vectorCases, type Kernel, type Primitive } from "../src/kernel.ts";
import { sharedStructures } from "../src/domains.ts";
import { loadDecisions, type MappingFile } from "../src/mapping.ts";
import { ROOT } from "./helpers.ts";

const KERNEL = loadKernel(ROOT);
const DECISIONS = loadDecisions(ROOT, join(ROOT, "decisions"));
const LOCKS: [string, SpecIR][] = [
  ["main", JSON.parse(readFileSync(join(ROOT, "ir", "spec-ir.json"), "utf8")) as SpecIR],
  ["with-open-prs", JSON.parse(readFileSync(join(ROOT, "ir", "with-open-prs", "spec-ir.json"), "utf8")) as SpecIR],
];

/** The committed kernel with one primitive changed by `edit`. */
function withPrimitive(name: string, edit: (p: Primitive) => void): Kernel {
  const k = structuredClone(KERNEL);
  const p = k.primitives.find((x) => x.name === name);
  assert.ok(p, `no primitive ${name}`);
  edit(p);
  return k;
}

const twins = (k: Kernel) => checkDuplication(kernelStructures(k), sharedStructures(k.domains), true);
const prim = (name: string) => KERNEL.primitives.find((p) => p.name === name)!;
const body = (pattern: string) => pattern.replace(/^\^/, "").replace(/\$$/, "");

test("the kernel defines each primitive the type rules name, once", () => {
  assert.deepEqual(
    KERNEL.primitives.map((p) => p.name).sort(),
    [
      "Amount", "CatalogRef", "Count", "CurrencyCode", "DayName", "Digest", "Domain", "Duration",
      "ExternalId", "FormatId", "Fraction", "NamespacedTerm", "PercentChange",
      "PriceAdjustment", "Text", "TimeOfDay", "TimeZone", "Timestamp", "Url", "Uuid", "VendorCode",
    ],
  );
  for (const p of KERNEL.primitives) {
    assert.ok(Object.keys(p.sources).length > 0, `${p.name} has no source`);
    assert.ok(p.description.length > 0, `${p.name} has no description`);
  }
});

test("the committed kernel is sound, current on both locks, and has no undeclared twins", () => {
  assert.deepEqual(checkKernel(ROOT, KERNEL, DECISIONS), []);
  for (const [lock, ir] of LOCKS) assert.deepEqual(checkKernelSources(ir, lock, KERNEL), [], lock);
  assert.deepEqual(twins(KERNEL), []);
});

test("twins of different concepts are distinct only where the domain model declares their shared structure", () => {
  assert.equal(fingerprint(kernelStructures(KERNEL).find((s) => s.name === "ExternalId")!.structure), fingerprint(kernelStructures(KERNEL).find((s) => s.name === "Text")!.structure));
  const one = withPrimitive("Text", (p) => (p.concept = "external-id"));
  const problems = twins(one);
  assert.ok(problems.some((p) => /"ExternalId" and "Text" have the same structure .* and represent one concept, "external-id"/.test(p)), problems.join("\n"));
  // Without the declaration, two concepts' twins fail.
  const undeclared = structuredClone(KERNEL);
  undeclared.domains!.shared_structures = undeclared.domains!.shared_structures.filter((x) => !x.concepts.includes("text"));
  const bare = twins(undeclared);
  assert.equal(bare.length, 1, bare.join("\n"));
  assert.ok(bare.some((p) => /"ExternalId" and "Text" have the same structure .* represent the concepts "external-id" and "text", which no shared structure .* lists together/.test(p)), bare.join("\n"));
});

test("a shared structure whose types no longer share it, or that names a concept no type represents, fails", () => {
  const apart = structuredClone(KERNEL);
  for (const p of apart.primitives) if (p.name !== "Text") p.constraints = { ...p.constraints, minLength: 1 };
  assert.ok(twins(apart).some((p) => /shared structure external-id, text: their types no longer share one structure/.test(p)), twins(apart).join("\n"));
  const ghost = structuredClone(KERNEL);
  ghost.domains!.shared_structures[0]!.concepts.push("budget");
  assert.ok(twins(ghost).some((p) => /no type represents "budget"; remove it from the set/.test(p)), twins(ghost).join("\n"));
});

test("a Budget twin of Amount fails the duplication gate, under a concept of its own or of money", () => {
  for (const concept of ["budget", "amount"]) {
    const k = structuredClone(KERNEL);
    k.primitives.push({ ...structuredClone(prim("Amount")), name: "Budget", concept, description: "A budget bound, a sum of money, never negative." });
    const problems = twins(k);
    assert.equal(problems.length, 1, `${concept}: ${problems.join("\n")}`);
    assert.match(problems[0]!, /"Amount" and "Budget" have the same structure/);
  }
});

test("a new primitive with an existing structure is a twin, whatever its description", () => {
  const k = structuredClone(KERNEL);
  k.primitives.push({ ...structuredClone(prim("Fraction")), name: "Percentage", description: "A share of a whole, from 0 to 1." });
  const problems = twins(k);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0]!, /"Fraction" and "Percentage" have the same structure/);
});

test("a twin without a concept is a twin of every type with its structure", () => {
  const a: NamedStructure = { name: "A", structure: { type: "string" }, concept: "text", where: "t" };
  const b: NamedStructure = { name: "B", structure: { type: "string" }, where: "t" };
  assert.equal(checkDuplication([a, b]).length, 1);
  const declared = { sets: [{ concepts: ["text", "external-id"], decisions: ["D-024"] }], file: "domains.yaml" };
  assert.equal(checkDuplication([a, { ...b, concept: "external-id" }]).length, 1, "two concepts with one structure need a declaration");
  assert.deepEqual(checkDuplication([a, { ...b, concept: "external-id" }], declared), []);
  assert.equal(checkDuplication([a, b], declared).length, 1, "a declaration doesn't cover a type without a concept");
});

test("a name defined twice fails, in the kernel or in the mapping", () => {
  const k = structuredClone(KERNEL);
  k.primitives.push(structuredClone(prim("Digest")));
  assert.ok(twins(k).some((p) => /"Digest" is already defined/.test(p)));
  const mapping: MappingFile = {
    format: 1,
    module: "pricing",
    sections: [],
    file: "mapping/pricing.yaml",
    entries: [{ ir: "field:5.6:pricing[].currency", digest: "0".repeat(64), source: { rule: "x" }, as: { role: "type", name: "CurrencyCode", layer: "object" } }],
  };
  assert.match(checkKernelNames(KERNEL, [mapping])[0]!, /defines "CurrencyCode", which is a kernel primitive/);
});

test("the fingerprint ignores annotations and enum order, but not property names", () => {
  const a: NamedStructure = { name: "A", structure: { type: "string", enum: ["x", "y"], description: "one" }, where: "t" };
  const b: NamedStructure = { name: "B", structure: { enum: ["y", "x"], type: "string", title: "two" }, where: "t" };
  assert.equal(fingerprint(a.structure), fingerprint(b.structure));
  assert.equal(checkDuplication([a, b]).length, 1);
  const withProp = (name: string) => ({ type: "object", properties: { [name]: { type: "string" } } });
  assert.notEqual(fingerprint(withProp("description")), fingerprint(withProp("title")));
});

test("a namespaced term's term admits every term the specification spells, on both locks", () => {
  const pattern = prim("NamespacedTerm").constraints.pattern!;
  const term = new RegExp(`^${pattern.slice(pattern.lastIndexOf(":") + 1)}`, "u");
  for (const [lock, ir] of LOCKS) {
    const terms = [...ir.value_lists.flatMap((v) => v.items.map((i) => i.value)), ...ir.definitions.map((d) => d.value)];
    assert.ok(terms.length > 50, lock);
    assert.deepEqual(terms.filter((t) => !term.test(t)), [], lock);
  }
});

test("NamespacedTerm is a Domain, a colon, and a term", () => {
  const p = (n: string) => prim(n).constraints.pattern!;
  assert.ok(p("NamespacedTerm").startsWith(`^${body(p("Domain"))}:`));
});

test("a stale spec source fails on the lock it applies to only", () => {
  const k = withPrimitive("Domain", (p) => {
    p.sources.spec![1]!.digest = "f".repeat(64);
  });
  const [main, prs] = LOCKS.map(([lock, ir]) => checkKernelSources(ir, lock, k));
  assert.deepEqual(main, []);
  assert.equal(prs!.length, 1);
  assert.match(prs![0]!, /Domain: stale digest for "field:5\.2:properties" on lock "with-open-prs"/);
  const quoted = withPrimitive("CurrencyCode", (p) => {
    p.sources.spec![0]!.quote = "ISO 4217, edited by hand";
  });
  assert.match(checkKernelSources(LOCKS[0]![1], "main", quoted)[0]!, /the quote for "field:5\.6:pricing\[\]\.currency" differs from the IR/);
});

test("a vector with the wrong verdict, a rule the schema already enforces, and a missing heading fail", () => {
  const wrong = checkKernel(ROOT, withPrimitive("Fraction", (p) => p.vectors.valid.push(70)), DECISIONS);
  assert.deepEqual(wrong, [`${KERNEL.file}: Fraction: valid vector 70 is rejected by the constraint set`]);
  const redundant = checkKernel(ROOT, withPrimitive("CurrencyCode", (p) => p.rules![0]!.invalid.push("usd")), DECISIONS);
  assert.equal(redundant.length, 1, redundant.join("\n"));
  assert.match(redundant[0]!, /rule "kernel:CurrencyCode:assigned" vector "usd" is rejected/);
  const heading = checkKernel(ROOT, withPrimitive("Count", (p) => (p.sources.design![0]!.section = "5. No such section")), DECISIONS);
  assert.match(heading[0]!, /has no heading "5\. No such section"/);
  const decision = checkKernel(ROOT, withPrimitive("Fraction", (p) => (p.decision = "D-999")), DECISIONS);
  assert.match(decision[0]!, /cites decision "D-999", which doesn't exist/);
});

test("non-portable patterns are refused", () => {
  assert.deepEqual(patternPortability("^[A-Z]{3}$"), []);
  assert.deepEqual(patternPortability("^(?:a|b)\\.c$"), []);
  assert.deepEqual(patternPortability("^\\d+$"), ["uses \\d (Unicode digits in Python)"]);
  assert.deepEqual(patternPortability("^(?=a)a$"), ["uses lookahead"]);
  assert.deepEqual(patternPortability("^(a)\\1$"), ["uses a backreference"]);
  assert.match(patternPortability("^(a$")[0]!, /doesn't compile/);
  for (const p of KERNEL.primitives) if (p.constraints.pattern) assert.deepEqual(patternPortability(p.constraints.pattern), [], p.name);
});

test("the fingerprint keeps instance data: const values and dependentRequired names", () => {
  const constOf = (description: string) => ({ const: { description } });
  assert.notEqual(fingerprint(constOf("a")), fingerprint(constOf("b")));
  const a: NamedStructure = { name: "A", structure: constOf("a"), where: "t" };
  const b: NamedStructure = { name: "B", structure: constOf("b"), where: "t" };
  assert.deepEqual(checkDuplication([a, b]), []);
  const dependent = (names: string[]) => ({ type: "object", dependentRequired: { title: names } });
  assert.notEqual(fingerprint(dependent(["x"])), fingerprint(dependent(["y"])));
  assert.equal(fingerprint(dependent(["x", "y"])), fingerprint(dependent(["y", "x"])));
  assert.equal(fingerprint({ const: "x", description: "one" }), fingerprint({ const: "x", title: "two" }));
});

test("a primitive that restricts spelling gets a trailing-newline mutant of each valid vector", () => {
  const currency = vectorCases(prim("CurrencyCode"));
  assert.deepEqual(currency.filter((c) => c.mutant).map((c) => c.value), ["USD\n", "EUR\n", "SGD\n"]);
  assert.ok(currency.filter((c) => c.mutant).every((c) => !c.valid));
  assert.ok(vectorCases(prim("Timestamp")).some((c) => c.mutant && c.value === "2026-10-25T09:00:00Z\n"));
  assert.deepEqual(vectorCases(prim("Text")).filter((c) => c.mutant), []);
  assert.deepEqual(vectorCases(prim("Count")).filter((c) => c.mutant), []);
});

test("a mutant the constraint set accepts fails the Ajv check", () => {
  const loose = checkKernel(ROOT, withPrimitive("CurrencyCode", (p) => (p.constraints.pattern = "^[A-Z]{3}\n?$")), DECISIONS);
  assert.deepEqual(loose, [
    `${KERNEL.file}: CurrencyCode: trailing-newline mutant "USD\\n" is accepted by the constraint set`,
    `${KERNEL.file}: CurrencyCode: trailing-newline mutant "EUR\\n" is accepted by the constraint set`,
    `${KERNEL.file}: CurrencyCode: trailing-newline mutant "SGD\\n" is accepted by the constraint set`,
  ]);
});

test("a rule's decision must exist, and a rule's spec source goes stale", () => {
  const missing = checkKernel(ROOT, withPrimitive("CurrencyCode", (p) => (p.rules![0]!.source = { decision: "D-999" })), DECISIONS);
  assert.deepEqual(missing, [`${KERNEL.file}: CurrencyCode: rule "kernel:CurrencyCode:assigned": cites decision "D-999", which doesn't exist`]);
  const stale = withPrimitive("CurrencyCode", (p) => {
    p.rules![0]!.source = { spec: [{ ...structuredClone(p.sources.spec![0]!), digest: "f".repeat(64) }] };
  });
  const problems = checkKernelSources(LOCKS[0]![1], "main", stale);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0]!, /CurrencyCode: rule "kernel:CurrencyCode:assigned": stale digest/);
});

test("Count stops at 2^53 - 1, and Domain rejects an IP address literal", () => {
  assert.equal(prim("Count").constraints.maximum, Number.MAX_SAFE_INTEGER);
  assert.ok(prim("Count").vectors.invalid.includes(Number.MAX_SAFE_INTEGER + 1));
  const domain = new RegExp(prim("Domain").constraints.pattern!, "u");
  for (const v of ["1.2.3.4", "192.168.0.1", "examplepub.123"]) assert.ok(!domain.test(v), v);
  assert.ok(domain.test("xn--bcher-kva.xn--p1ai"));
});

/** The values the real oracle rejects against their stated verdict, under a listed gap. */
const GAPPED = new Set(loadOracleGaps(ROOT).gaps.flatMap((g) => g.vectors.map((x) => x.value)));

/** Engines that agree with ECMA-262 everywhere, and an oracle that agrees with the stated verdicts but for the listed gaps, with `edit` applied. */
function fakeEngines(edit: { oracle?: (value: unknown, valid: boolean) => boolean; go?: (pattern: string, value: string) => boolean; jsonschema?: string } = {}): Engines {
  return {
    python: (cases) => ({
      jsonschema: edit.jsonschema ?? "4.26.0",
      python: "3.12.7",
      verdicts: cases.map((c) => {
        const ecma = c.pattern !== undefined && typeof c.value === "string" ? new RegExp(c.pattern, "u").test(c.value) : null;
        return { oracle: (edit.oracle ? edit.oracle(c.value, c.valid) : c.valid) && !GAPPED.has(c.value), re: ecma, re_anchored: ecma };
      }),
    }),
    go: (cases) => ({ go: "go1.26.8", verdicts: cases.map((c) => (edit.go ? edit.go(c.pattern, c.value) : new RegExp(c.pattern, "u").test(c.value))) }),
  };
}

test("the engine check reports a pattern verdict that differs between engines", () => {
  assert.deepEqual(checkKernelEngines(ROOT, KERNEL, fakeEngines()).problems, []);
  const go = checkKernelEngines(ROOT, KERNEL, fakeEngines({ go: (p, v) => (v === "USD" ? false : new RegExp(p, "u").test(v)) })).problems;
  assert.deepEqual(go, [
    `${KERNEL.file}: CurrencyCode: valid vector "USD": the pattern matches in ECMA-262, but Go's RE2 disagrees`,
    `${KERNEL.file}: CurrencyCode: rule "kernel:CurrencyCode:assigned" vector "USD": the pattern matches in ECMA-262, but Go's RE2 disagrees`,
  ]);
});

test("the oracle may accept a trailing-newline mutant, and nothing else that it should reject", () => {
  const newline = checkKernelEngines(ROOT, KERNEL, fakeEngines({ oracle: (v, valid) => valid || (typeof v === "string" && v.endsWith("\n")) }));
  assert.deepEqual(newline.problems, []);
  assert.match(newline.note, /oracle jsonschema 4\.26\.0 accepts 41 mutants/);
  const wrong = checkKernelEngines(ROOT, KERNEL, fakeEngines({ oracle: (v, valid) => valid || v === "P" })).problems;
  assert.deepEqual(wrong, [`${KERNEL.file}: Duration: invalid vector "P": the oracle accepts it, and no gap in tools/oracle/gaps.yaml lists it`]);
  // A valid vector the oracle rejects passes only under a gap that lists it with that verdict, and a listed gap the oracle no longer has fails.
  const gaps = loadOracleGaps(ROOT);
  const unlisted = checkKernelEngines(ROOT, KERNEL, fakeEngines(), { ...gaps, gaps: gaps.gaps.filter((g) => g.id !== "OG-2") }).problems;
  assert.deepEqual(unlisted, [`${KERNEL.file}: Timestamp: valid vector "0000-01-01T00:00:00Z": the oracle rejects it, and no gap in tools/oracle/gaps.yaml lists it`]);
  const healed = checkKernelEngines(ROOT, KERNEL, { ...fakeEngines(), python: (cases) => ({ jsonschema: "4.26.0", python: "3.12.7", verdicts: fakeEngines().python(cases).verdicts.map((v, n) => ({ ...v, oracle: cases[n]!.valid })) }) }, gaps).problems;
  assert.deepEqual(healed.map((p) => p.replace(/^.*?: /, "")), [
    'OG-1: the oracle no longer rejects Timestamp "2016-12-31T23:59:60Z" against its stated verdict, or no vector states it; remove it',
    'OG-2: the oracle no longer rejects Timestamp "0000-01-01T00:00:00Z" against its stated verdict, or no vector states it; remove it',
  ]);
  const stale = checkKernelEngines(ROOT, KERNEL, fakeEngines(), { ...gaps, oracle: "jsonschema 4.26.0, rfc3339-validator 0.1.3" }).problems;
  assert.match(stale[0]!, /written for rfc3339-validator 0\.1\.3, but tools\/oracle\/requirements\.txt pins 0\.1\.4/);
  const version = checkKernelEngines(ROOT, KERNEL, fakeEngines({ jsonschema: "4.25.0" })).problems;
  assert.match(version[0]!, /the oracle is jsonschema 4\.25\.0, but tools\/oracle\/requirements\.txt pins 4\.26\.0/);
});

test("the real engines agree on the committed kernel, and RE2 refuses a pattern it can't compile", () => {
  const report = checkKernelEngines(ROOT, KERNEL);
  assert.deepEqual(report.problems, []);
  assert.equal(engineCases(KERNEL).filter((c) => c.mutant).length, 41);
  assert.match(report.note, /the oracle differs on 2 vectors under a listed gap \(OG-1, OG-2\)/);
  const unicode = checkKernelEngines(ROOT, withPrimitive("CurrencyCode", (p) => (p.constraints.pattern = "^[\\u0041-Z]{3}$")));
  assert.match(unicode.problems[0]!, /RE2 doesn't compile/);
});

test("every primitive declares a showcase value, and one the schema rejects or a rule rejects fails", () => {
  for (const p of KERNEL.primitives) assert.ok(p.showcase.length >= 1, p.name);
  assert.deepEqual(prim("Amount").showcase[0], 18.5);
  const rejected = checkKernel(ROOT, withPrimitive("Amount", (p) => (p.showcase = [-18.5])), DECISIONS);
  assert.ok(rejected.some((x) => x.endsWith("Amount: showcase value -18.5 is rejected by the constraint set")), rejected.join("\n"));
  const unassigned = checkKernel(ROOT, withPrimitive("CurrencyCode", (p) => (p.showcase = ["USD", "ABC"])), DECISIONS);
  assert.ok(unassigned.some((x) => x.includes('CurrencyCode: showcase value "ABC" breaks rule "kernel:CurrencyCode:assigned"')), unassigned.join("\n"));
  const unlisted = checkKernel(ROOT, withPrimitive("TimeZone", (p) => (p.showcase = ["America/Springfield"])), DECISIONS);
  assert.ok(unlisted.some((x) => x.includes('TimeZone: showcase value "America/Springfield" breaks rule "kernel:TimeZone:listed"')), unlisted.join("\n"));
});
