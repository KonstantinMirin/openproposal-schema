import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConstructors } from "../src/constructors.ts";
import { checkCorpus, checkOldCorpus, constraintsOf, corpusDirOf, generateCorpus, labelledCases, oracleLabels, renderCorpus, type CorpusDoc } from "../src/corpus.ts";
import { emitSchemas, type EmittedFile } from "../src/emit.ts";
import type { InstanceOracle } from "../src/examples.ts";
import type { SpecIR } from "../src/ir-types.ts";
import { loadKernel } from "../src/kernel.ts";
import { loadDecisions, loadMappings } from "../src/mapping.ts";
import { resolveModel, type ModelDoc } from "../src/model.ts";
import { emitRules, loadVectors, type RulesDoc } from "../src/rules.ts";
import { ROOT } from "./helpers.ts";

const KERNEL = loadKernel(ROOT);
const CONSTRUCTORS = loadConstructors(ROOT);
const MAPPINGS = loadMappings(ROOT, join(ROOT, "mapping"));
const DECISIONS = loadDecisions(ROOT, join(ROOT, "decisions"));
const VECTORS = loadVectors(ROOT);
const ORACLE = "4.26.0";

interface Lock {
  lock: string;
  irDir: string;
  schemaDir: string;
  model: ModelDoc;
  files: EmittedFile[];
  rules: RulesDoc;
}

function lockOf(lock: string, irDir: string, schemaDir: string): Lock {
  const ir = JSON.parse(readFileSync(join(ROOT, irDir, "spec-ir.json"), "utf8")) as SpecIR;
  const model = resolveModel({ ir, lock, mappings: MAPPINGS, decisions: DECISIONS, kernel: KERNEL, constructors: CONSTRUCTORS }).model;
  const emitted = emitSchemas(model, schemaDir);
  const rules = emitRules({ model, ir, lock, vectors: VECTORS, decisions: DECISIONS, schemaDir, conditionsLeft: emitted.conditions.left }).doc;
  return { lock, irDir, schemaDir, model, files: emitted.files, rules };
}
const MAIN = lockOf("main", "ir", "schemas");
const PRS = lockOf("with-open-prs", join("ir", "with-open-prs"), "schemas/with-open-prs");
const generate = (l: Lock, files = l.files, model = l.model) => generateCorpus({ model, files, rules: l.rules, kernel: KERNEL, schemaDir: l.schemaDir, oracle: ORACLE });
const CORPUS = generate(MAIN).doc;
const caseOf = (doc: CorpusDoc, id: string) => doc.constraints.find((c) => c.id === id)!;

test("each lock's corpus generates with no problem, passes the isolation check, and is the committed file", () => {
  for (const l of [MAIN, PRS]) {
    const r = generate(l);
    assert.deepEqual(r.problems, [], `${l.lock}: ${r.problems.join("\n")}`);
    assert.deepEqual(checkCorpus(r.doc, l.files, l.model, l.rules, l.schemaDir), [], l.lock);
    assert.ok(r.doc.constraints.length > 0 && r.doc.rules.length === l.rules.rules.length, l.lock);
    assert.equal(readFileSync(join(ROOT, corpusDirOf(l.irDir), "cases.json"), "utf8"), renderCorpus(r.doc), l.lock);
  }
});

test("the corpus is the same whatever the order of the model's types and the schema files", () => {
  const model = { ...MAIN.model, types: [...MAIN.model.types].reverse() };
  assert.equal(renderCorpus(generate(MAIN, [...MAIN.files].reverse(), model).doc), renderCorpus(CORPUS));
});

test("a required member's mutant drops the member, and a condition's baseline makes its if hold", () => {
  const then = caseOf(CORPUS, "Commitment#/then/required/currency");
  assert.equal((then.baseline as Record<string, unknown>).basis, "spend");
  assert.ok("currency" in (then.baseline as object) && !("currency" in (then.mutant as object)));
  const basis = caseOf(CORPUS, "Commitment#/required/basis");
  assert.deepEqual(Object.keys(basis.mutant as object).sort(), Object.keys(basis.baseline as object).filter((k) => k !== "basis").sort());
});

test("a primitive's mutant is its first reviewed invalid vector that isolates the constraint, and spelling constraints get a trailing-newline mutant", () => {
  // `https://exa mple.example/` matches Url's pattern, so only its format rejects it.
  assert.equal(caseOf(CORPUS, "Url#/format").mutant, "https://exa mple.example/");
  assert.equal(caseOf(CORPUS, "Url#/pattern").mutant, "http://examplepub.example/terms");
  const currency = caseOf(CORPUS, "CurrencyCode#/pattern");
  assert.equal(currency.newline, `${currency.baseline}\n`);
  // A count's bound: one past 2^53 − 1.
  assert.equal(caseOf(CORPUS, "Count#/maximum").mutant, 9007199254740992);
  // Domain's maxLength: a longer name that still matches its pattern.
  const domain = caseOf(CORPUS, "Domain#/maxLength");
  assert.ok(typeof domain.mutant === "string" && domain.mutant.length > 253 && domain.mutant.endsWith(String(domain.baseline)));
});

test("a property-count constraint's mutant keeps the other counts: PriceDelta takes exactly one member", () => {
  assert.equal(Object.keys(caseOf(CORPUS, "PriceDelta#/maxProperties").mutant as object).length, 2);
  // Adding a member would break maxProperties too, so the closed-object mutant renames the one member.
  assert.deepEqual(Object.keys(caseOf(CORPUS, "PriceDelta#/additionalProperties").mutant as object), ["undefined_member"]);
  assert.deepEqual(caseOf(CORPUS, "PriceDelta#/minProperties").mutant, {});
});

test("a type beside an enum is implied, and a type beside a pattern is a constraint", () => {
  const walked = constraintsOf({ type: "string", enum: ["a", "b"] });
  assert.deepEqual(walked.implied, [{ keyword: "type", at: "", by: "enum" }]);
  assert.deepEqual(walked.found, [{ keyword: "enum", at: "" }]);
  assert.deepEqual(constraintsOf({ type: "string", pattern: "^a$" }).found.map((f) => f.keyword).sort(), ["pattern", "type"]);
  // A value of another type than the enum's isn't implied away.
  assert.deepEqual(constraintsOf({ type: "string", enum: [1] }).implied, []);
  assert.ok(CORPUS.implied.some((x) => x.id === "CommitmentBasis#/type" && x.by === "enum"));
});

test("an if isn't walked, a keyword the corpus doesn't know is reported, and required lists one constraint per name", () => {
  const walked = constraintsOf({ type: "object", if: { properties: { a: { const: 1 } }, required: ["a"] }, then: { required: ["b"] }, required: ["a", "c"], not: {} });
  assert.deepEqual(walked.found.map((f) => `${f.at}/${f.keyword}${f.name ? `/${f.name}` : ""}`).sort(), ["/required/a", "/required/c", "/then/required/b", "/type"]);
  assert.deepEqual(walked.unknown, [`/: "not"`]);
});

test("the isolation check fails on a missing case, a stray case, a valid mutant, and a mutant that something else rejects too", () => {
  const without = { ...CORPUS, constraints: CORPUS.constraints.filter((c) => c.id !== "Url#/format") };
  assert.match(checkCorpus(without, MAIN.files, MAIN.model, MAIN.rules, MAIN.schemaDir).join("\n"), /Url#\/format: a constraint with no case/);
  const stray = { ...CORPUS, constraints: [...CORPUS.constraints, { ...caseOf(CORPUS, "Url#/format"), id: "Url#/minLength" }] };
  assert.match(checkCorpus(stray, MAIN.files, MAIN.model, MAIN.rules, MAIN.schemaDir).join("\n"), /Url#\/minLength: a case for no constraint/);
  const edit = (id: string, mutant: unknown) => ({ ...CORPUS, constraints: CORPUS.constraints.map((c) => (c.id === id ? { ...c, mutant } : c)) });
  assert.match(checkCorpus(edit("Url#/format", caseOf(CORPUS, "Url#/format").baseline), MAIN.files, MAIN.model, MAIN.rules, MAIN.schemaDir).join("\n"), /Url#\/format: the mutant is valid/);
  // `http://exa mple` fails Url's pattern as well as its format.
  assert.match(checkCorpus(edit("Url#/format", "http://exa mple"), MAIN.files, MAIN.model, MAIN.rules, MAIN.schemaDir).join("\n"), /Url#\/format: the mutant doesn't isolate the constraint/);
  const rules = { ...CORPUS, rules: CORPUS.rules.slice(1) };
  assert.match(checkCorpus(rules, MAIN.files, MAIN.model, MAIN.rules, MAIN.schemaDir).join("\n"), /no cases in the corpus/);
});

test("the oracle must reach every label, except a trailing-newline mutant the stock oracle accepts, which is counted", () => {
  const cases = labelledCases(CORPUS);
  const truthful: InstanceOracle = (_f, cs) => ({ jsonschema: ORACLE, referencing: "0.37.0", verdicts: cs.map((c) => c.valid) });
  assert.deepEqual(oracleLabels(MAIN.files, CORPUS, truthful, ORACLE).problems, []);
  const newlines = new Set(cases.flatMap((c, i) => (c.newline ? [i] : [])));
  const lenient: InstanceOracle = (_f, cs) => ({ jsonschema: ORACLE, referencing: "0.37.0", verdicts: cs.map((c, i) => c.valid || newlines.has(i)) });
  const r = oracleLabels(MAIN.files, CORPUS, lenient, ORACLE);
  assert.deepEqual(r.problems, []);
  assert.match(r.note, new RegExp(`accepts ${newlines.size} of ${newlines.size} trailing-newline mutants`));
  const wrong: InstanceOracle = (_f, cs) => ({ jsonschema: ORACLE, referencing: "0.37.0", verdicts: cs.map(() => true) });
  assert.match(oracleLabels(MAIN.files, CORPUS, wrong, ORACLE).problems.join("\n"), /Url#\/format mutant: labelled invalid, but the oracle says valid/);
  assert.match(oracleLabels(MAIN.files, CORPUS, truthful, "9.9.9").problems.join("\n"), /pin 9\.9\.9/);
});

test("the old corpus check passes on its own release and fails on a narrowed schema or a flipped rule vector", () => {
  assert.deepEqual(checkOldCorpus(CORPUS, MAIN.files, MAIN.rules), []);
  const narrowed = MAIN.files.map((f) => {
    if (!f.path.endsWith("commercial.json")) return f;
    const schema = structuredClone(f.schema) as { $defs: Record<string, { required: string[] }> };
    schema.$defs.Commitment!.required.push("derived_units");
    return { ...f, schema };
  });
  assert.match(checkOldCorpus(CORPUS, narrowed, MAIN.rules).join("\n"), /the old baseline of Commitment#\/required\/amount is invalid under the new schemas/);
  const rule = MAIN.rules.rules.find((r) => r.vectors.valid.length > 0)!;
  const flipped = { ...MAIN.rules, rules: MAIN.rules.rules.map((r) => (r.id === rule.id ? { ...r, vectors: { ...r.vectors, invalid: [...r.vectors.invalid, r.vectors.valid[0]!] } } : r)) };
  assert.match(checkOldCorpus(CORPUS, MAIN.files, flipped).join("\n"), new RegExp(`rule "${rule.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}": old valid vector 1 is an invalid vector of the rule now`));
});

test("a part's baseline holds its rules: every daypart window a baseline holds ends after it starts", () => {
  for (const file of ["corpus/cases.json", "corpus/with-open-prs/cases.json"]) {
    const doc = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as { constraints: { id: string; baseline?: unknown }[] };
    let windows = 0;
    const walk = (v: unknown, id: string): void => {
      if (Array.isArray(v)) return v.forEach((x) => walk(x, id));
      if (v === null || typeof v !== "object") return;
      const o = v as Record<string, unknown>;
      if ("days" in o && typeof o.start === "string" && typeof o.end === "string") {
        windows++;
        assert.ok(o.start < o.end, `${file}: ${id}: the baseline window ${JSON.stringify(o)} doesn't end after it starts`);
      }
      Object.values(o).forEach((x) => walk(x, id));
    };
    for (const c of doc.constraints) walk(c.baseline, c.id);
    assert.ok(windows > 0, `${file} holds a daypart window baseline`);
  }
});
