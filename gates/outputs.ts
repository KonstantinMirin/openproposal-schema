/** The gates on each lock's emitted schemas, rules, and conformance corpus. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkCorpus, generateCorpus, oracleLabels, type CorpusDoc, type CorpusInput } from "../src/corpus.ts";
import { checkEmitted, emitSchemas, type EmittedFile } from "../src/emit.ts";
import { pinnedOracle } from "../src/engines.ts";
import { spawnInstanceOracle } from "../src/examples.ts";
import type { ModelDoc } from "../src/model.ts";
import { checkProblems, ordersOf } from "../src/rule-checks.ts";
import { checkRuleVectors, emitRules, loadVectors, type RulesDoc, type RulesInput } from "../src/rules.ts";
import { loadFieldExamples, type FieldExample } from "../src/field-examples.ts";
import { checkFieldExamples, checkTypeExamples, generateTypeExamples, type TypeExamplesDoc, type TypeExamplesInput } from "../src/type-examples.ts";
import { ajvProblems, oracleProblems } from "../src/schema-check.ts";
import { committedCurrent, committedTreeCurrent, flipFirst, flipped, onlyGenerated, sameRuns, sameTreeRuns, type CommittedInput, type CommittedTreeInput, type RunsInput, type TrackedInput, type TreeRunsInput } from "./common.ts";
import { defineGate, ROOT } from "./harness.ts";
import { withType } from "./model.ts";

/** A schema file changed by a function of its schema. */
const withFile = (files: EmittedFile[], path: string, change: (s: Record<string, unknown>) => Record<string, unknown>): EmittedFile[] =>
  files.map((f) => {
    if (f.path !== path) return f;
    const schema = change(structuredClone(f.schema));
    return { ...f, schema, text: JSON.stringify(schema) };
  });
const KERNEL_FILE = "kernel/1/kernel.json";
const withAmount = (s: Record<string, unknown>, extra: Record<string, unknown>) => {
  const defs = s.$defs as Record<string, Record<string, unknown>>;
  return { ...s, $defs: { ...defs, Amount: { ...defs.Amount!, ...extra } } };
};

// Schemas -----------------------------------------------------------------------

export const schemasEmit = defineGate<{ model: ModelDoc; dir: string }>({
  id: "schemas-emit",
  title: "schemas emit from the model",
  check: (i) => {
    const e = emitSchemas(i.model, i.dir);
    const c = e.conditions;
    return { problems: e.problems, note: `${e.files.length} files; ${c.expressed.length} conditions as if / then, ${c.left.length} left to the rules${c.left.length > 0 ? `: ${c.left.join("; ")}` : ""}` };
  },
  fixtures: [
    {
      name: "a property of a type the model doesn't define",
      mutate: (i) => ({ ...i, model: withType(i.model, "Commitment", (t) => ({ ...t, references: [...t.references.filter((r) => r !== "Amount"), "NoSuchType"] })) }),
      expect: "but the model says",
    },
  ],
});

export const schemasDeterministic = defineGate<TreeRunsInput>({
  id: "schemas-deterministic",
  title: "deterministic schemas",
  code: ["gates/common.ts#sameTreeRuns"],
  check: sameTreeRuns,
  fixtures: [{ name: "a run writes one file differently", mutate: (i) => ({ ...i, runs: [i.runs[0]!, flipFirst(i.runs[1]!)] }), expect: "run 2: " }],
});

export const schemasCommitted = defineGate<CommittedTreeInput>({
  id: "schemas-committed",
  title: (i) => `committed ${i.dir}/ current`,
  code: ["gates/common.ts#committedTreeCurrent"],
  check: committedTreeCurrent,
  fixtures: [
    { name: "a committed file edited by hand", mutate: (i) => ({ ...i, committed: flipFirst(i.committed) }), expect: "differs" },
    { name: "a committed file missing", mutate: (i) => ({ ...i, committed: new Map([...i.committed].slice(1)) }), expect: "missing" },
  ],
});

export const schemasConventions = defineGate<{ files: EmittedFile[]; model: ModelDoc; dir: string }>({
  id: "schemas-conventions",
  title: "schemas: standard 2020-12 keywords only, nothing beside a $ref, references resolve, unions as type rules § 8 allows",
  code: ["src/emit.ts#checkEmitted"],
  check: (i) => ({ problems: checkEmitted(i.files, i.model, i.dir) }),
  fixtures: [
    { name: "an x- keyword", mutate: (i) => ({ ...i, files: withFile(i.files, KERNEL_FILE, (s) => withAmount(s, { "x-unit": "money" })) }), expect: '"x-unit" is no standard JSON Schema 2020-12 keyword' },
    { name: "an allOf", mutate: (i) => ({ ...i, files: withFile(i.files, KERNEL_FILE, (s) => withAmount(s, { allOf: [{ minimum: 0 }] })) }), expect: '"allOf"' },
  ],
});

export const schemasAjv = defineGate<{ files: EmittedFile[] }>({
  id: "schemas-ajv",
  title: "schemas valid 2020-12 under Ajv (strict), every reference resolved",
  code: ["src/schema-check.ts#ajvProblems"],
  check: (i) => ({ problems: ajvProblems(i.files) }),
  fixtures: [
    { name: "a type Ajv doesn't know", mutate: (i) => ({ files: withFile(i.files, KERNEL_FILE, (s) => withAmount(s, { type: "money" })) }), expect: "not a valid 2020-12 schema: /$defs/Amount/type" },
    { name: "a reference that resolves nowhere", mutate: (i) => ({ files: withFile(i.files, KERNEL_FILE, (s) => withAmount(s, { $ref: "#/$defs/NoSuchType" })) }), expect: "NoSuchType" },
  ],
});

export const schemasOracle = defineGate<{ files: EmittedFile[] }>({
  id: "schemas-oracle",
  title: "schemas valid 2020-12 under the reference oracle, every reference resolved",
  code: ["src/schema-check.ts#oracleProblems"],
  check: (i) => oracleProblems(ROOT, i.files),
  fixtures: [{ name: "a type the metaschema rejects", mutate: (i) => ({ files: withFile(i.files, KERNEL_FILE, (s) => withAmount(s, { type: "money" })) }), expect: "money" }],
});

export const schemasTracked = defineGate<TrackedInput>({
  id: "schemas-tracked",
  title: "every tracked file under schemas/ is emitted by some lock",
  code: ["gates/common.ts#onlyGenerated"],
  check: onlyGenerated,
  fixtures: [{ name: "a hand-written schema", mutate: (i) => ({ ...i, tracked: [...i.tracked, "schemas/modules/extra/1/extra.json"] }), expect: "schemas/modules/extra/1/extra.json" }],
});

// Rules --------------------------------------------------------------------------

export const vectorsLoad = defineGate<{ dir?: string }>({
  id: "vectors-load",
  title: "vectors: schema-valid",
  code: ["src/rules.ts#loadVectors"],
  check: (i) => {
    const v = loadVectors(ROOT, i.dir);
    return { problems: [], note: `${v.length} files, ${v.reduce((n, f) => n + f.rules.length, 0)} rule entries` };
  },
  fixtures: [{ name: "an entry with no vectors", mutate: () => ({ dir: join(ROOT, "gates/data/vectors-load") }), expect: "not a valid vectors file" }],
});

export const rulesEmit = defineGate<RulesInput>({
  id: "rules-emit",
  title: "rules emit: each rule has an ID, its source, its owner, and valid and invalid vectors",
  code: ["src/rules.ts#emitRules"],
  check: (i) => {
    const r = emitRules(i);
    return { problems: r.problems, note: `${r.doc.rules.length} rules, ${r.doc.rules.reduce((n, x) => n + x.vectors.valid.length + x.vectors.invalid.length, 0)} vectors` };
  },
  fixtures: [
    { name: "a rule's invalid vectors deleted", mutate: (i) => ({ ...i, vectors: i.vectors.map((f, n) => (n === 0 ? { ...f, rules: f.rules.map((r, k) => (k === 0 ? { ...r, invalid: [] } : r)) } : f)) }), expect: "every rule needs at least one of each" },
    { name: "a vectors entry with a stale digest", mutate: (i) => ({ ...i, vectors: i.vectors.map((f, n) => (n === 0 ? { ...f, rules: f.rules.map((r, k) => (k === 0 ? { ...r, digest: "0".repeat(64) } : r)) } : f)) }), expect: "stale digest" },
  ],
});

export const ruleVectors = defineGate<{ doc: RulesDoc; model: ModelDoc; files: EmittedFile[]; schemaDir: string }>({
  id: "rule-vectors",
  title: "rule vectors: the schema of each vector's type accepts every payload, so the rule alone decides it",
  code: ["src/rules.ts#checkRuleVectors"],
  check: (i) => ({ problems: checkRuleVectors(i.doc, i.model, i.files, i.schemaDir) }),
  fixtures: [
    {
      name: "a payload its type's schema rejects",
      mutate: (i) => {
        const at = i.doc.rules.findIndex((r) => r.vectors.schema !== undefined && r.vectors.valid.some((v) => "value" in v));
        const rules = i.doc.rules.map((r, n) => (n === at ? { ...r, vectors: { ...r.vectors, valid: [{ value: "not an object" }, ...r.vectors.valid] } } : r));
        return { ...i, doc: { ...i.doc, rules } };
      },
      expect: "a rule vector passes the schema, so the rule alone decides it",
    },
  ],
});

export const ruleChecks = defineGate<{ doc: RulesDoc; model: ModelDoc; codes: ReadonlyMap<string, ReadonlySet<string | number>> }>({
  id: "rule-checks",
  title: "rule checks: every rule one payload decides has a check, which gives each of the rule's vectors its verdict, and reads the pinned list its rule rests on",
  code: ["src/rule-checks.ts#checkProblems"],
  check: (i) => {
    const r = checkProblems(i.doc, ordersOf(i.model.types), i.codes);
    const why = new Map<string, number>();
    for (const u of r.unchecked) why.set(u.why, (why.get(u.why) ?? 0) + 1);
    return { problems: r.problems, note: `${r.checked.length} rules checked on one payload; not checked: ${[...why].map(([w, n]) => `${n} about ${w}`).join(", ")}` };
  },
  fixtures: [
    {
      name: "a check that misses an invalid vector",
      mutate: (i) => ({ ...i, doc: { ...i.doc, rules: i.doc.rules.map((r) => (r.id === "constructor:Range:ordered" ? { ...r, vectors: { ...r.vectors, invalid: [...r.vectors.invalid, { value: { min: 1, max: 6 } }] } } : r)) } }),
      expect: "constructor:Range:ordered: invalid vector 2: the check finds no violation",
    },
    {
      name: "a payload rule with no check",
      mutate: (i) => ({ ...i, doc: { ...i.doc, rules: [...i.doc.rules, { ...i.doc.rules.find((r) => r.id === "constructor:Range:ordered")!, id: "rule:9.9:00000000" }] } }),
      expect: "rule:9.9:00000000: one payload decides it, and it has no check",
    },
    {
      name: "a range whose bounds' type the model doesn't say, so the check can't compare them",
      mutate: (i) => ({ ...i, model: { ...i.model, types: i.model.types.filter((t) => t.name !== "Count") } }),
      expect: "constructor:Range:ordered: valid vector 1: the check can't decide it",
    },
    {
      name: "the currency codes no longer pinned, so the check can't decide",
      mutate: (i) => ({ ...i, codes: new Map([...i.codes].filter(([name]) => name !== "ISO 4217")) }),
      expect: 'kernel:CurrencyCode:assigned: rests on the list "ISO 4217", which kernel/lists.yaml doesn\'t pin',
    },
    {
      name: "a valid vector the check rejects",
      mutate: (i) => ({ ...i, doc: { ...i.doc, rules: i.doc.rules.map((r) => (r.id === "constructor:Selectable:options-named" ? { ...r, vectors: { ...r.vectors, valid: [...r.vectors.valid, { value: { available: [{ vendor: "IAS" }], included: ["IAS"] } }] } } : r)) } }),
      expect: "constructor:Selectable:options-named: valid vector 3: the check finds /included/0",
    },
  ],
});

export const rulesDeterministic = defineGate<RunsInput>({
  id: "rules-deterministic",
  title: "deterministic rules",
  code: ["gates/common.ts#sameRuns"],
  check: sameRuns,
  fixtures: [{ name: "the runs differ", mutate: (i) => ({ ...i, runs: [flipped(i.runs[0]!), i.runs[1]!] }), expect: "run 1 differs" }],
});

export const rulesCommitted = defineGate<CommittedInput>({
  id: "rules-committed",
  title: (i) => `committed ${i.file} current`,
  code: ["gates/common.ts#committedCurrent"],
  check: committedCurrent,
  fixtures: [{ name: "stale committed rules", mutate: (i) => ({ ...i, committed: flipped(i.committed!) }), expect: "isn't what the pipeline writes" }],
});

export const rulesTracked = defineGate<TrackedInput>({
  id: "rules-tracked",
  title: "every tracked file under rules/ is emitted by some lock",
  code: ["gates/common.ts#onlyGenerated"],
  check: onlyGenerated,
  fixtures: [{ name: "a hand-written rules file", mutate: (i) => ({ ...i, tracked: [...i.tracked, "rules/extra.json"] }), expect: "rules/extra.json" }],
});

// Corpus -------------------------------------------------------------------------

export const corpusOraclePin = defineGate<{ root: string }>({
  id: "corpus-oracle-pin",
  title: "corpus: the oracle requirements pin jsonschema",
  code: ["src/engines.ts#pinnedOracle"],
  check: (i) => ({ problems: [], note: `jsonschema ${pinnedOracle(i.root)}` }),
  fixtures: [{ name: "requirements that pin no jsonschema", mutate: () => ({ root: join(ROOT, "gates/data/corpus-oracle-pin") }), expect: "jsonschema" }],
});

export const corpusGenerates = defineGate<CorpusInput>({
  id: "corpus-generates",
  title: "corpus generates: every constraint has an isolating case, and every rule its vectors",
  code: ["src/corpus.ts#generateCorpus"],
  check: (i) => {
    const r = generateCorpus(i);
    const newlines = r.doc.constraints.filter((c) => "newline" in c).length;
    return { problems: r.problems, note: `${r.doc.constraints.length} constraints (${newlines} with a trailing-newline mutant), ${r.doc.implied.length} implied keywords, ${r.doc.rules.length} rules` };
  },
  fixtures: [
    { name: "a rule with no invalid vector", mutate: (i) => ({ ...i, rules: { ...i.rules, rules: i.rules.rules.map((r, n) => (n === 0 ? { ...r, vectors: { ...r.vectors, invalid: [] } } : r)) } }), expect: "every rule needs an isolating invalid vector and a valid one" },
    { name: "a keyword the corpus doesn't know", mutate: (i) => ({ ...i, files: withFile(i.files, KERNEL_FILE, (s) => withAmount(s, { multipleOf: 0.01 })) }), expect: '"multipleOf" is a keyword the corpus doesn\'t know' },
  ],
});

export const corpusDeterministic = defineGate<RunsInput>({
  id: "corpus-deterministic",
  title: "deterministic corpus",
  code: ["gates/common.ts#sameRuns"],
  check: sameRuns,
  fixtures: [{ name: "the runs differ", mutate: (i) => ({ ...i, runs: [i.runs[0]!, flipped(i.runs[1]!)] }), expect: "run 2 differs" }],
});

export const corpusCommitted = defineGate<CommittedInput>({
  id: "corpus-committed",
  title: (i) => `committed ${i.file} current`,
  code: ["gates/common.ts#committedCurrent"],
  check: committedCurrent,
  fixtures: [{ name: "a stale committed corpus", mutate: (i) => ({ ...i, committed: flipped(i.committed!) }), expect: "isn't what the pipeline writes" }],
});

/** The committed corpus with the schemas and rules it must agree with. */
export interface CorpusCheckInput {
  doc: CorpusDoc;
  files: EmittedFile[];
  model: ModelDoc;
  rules: RulesDoc;
  schemaDir: string;
}

const withCase = (doc: CorpusDoc, change: (c: CorpusDoc["constraints"][number]) => CorpusDoc["constraints"][number]): CorpusDoc => ({ ...doc, constraints: doc.constraints.map((c, n) => (n === 0 ? change(c) : c)) });

export const corpusIsolation = defineGate<CorpusCheckInput>({
  id: "corpus-isolation",
  title: "corpus isolation: the cases are the schemas' constraints, each baseline valid, each mutant rejected by its constraint alone",
  code: ["src/corpus.ts#checkCorpus"],
  check: (i) => ({ problems: checkCorpus(i.doc, i.files, i.model, i.rules, i.schemaDir), note: `${i.doc.constraints.length} constraints, ${i.doc.rules.length} rules` }),
  fixtures: [
    { name: "a mutant the schema accepts", mutate: (i) => ({ ...i, doc: withCase(i.doc, (c) => ({ ...c, mutant: c.baseline })) }), expect: "the mutant is valid" },
    { name: "a constraint with no case", mutate: (i) => ({ ...i, doc: { ...i.doc, constraints: i.doc.constraints.slice(1) } }), expect: "a constraint with no case" },
    { name: "a baseline the schema rejects", mutate: (i) => ({ ...i, doc: withCase(i.doc, (c) => ({ ...c, baseline: c.mutant })) }), expect: "the baseline is invalid" },
  ],
});

export const corpusLabels = defineGate<{ files: EmittedFile[]; doc: CorpusDoc; pinned: string }>({
  id: "corpus-labels",
  title: "corpus labels: the reference oracle reaches every case's label",
  code: ["src/corpus.ts#oracleLabels"],
  check: (i) => oracleLabels(i.files, i.doc, spawnInstanceOracle(ROOT), i.pinned),
  fixtures: [
    { name: "a mutant labelled invalid that the oracle accepts", mutate: (i) => ({ ...i, doc: withCase(i.doc, (c) => ({ ...c, mutant: c.baseline })) }), expect: "labelled invalid, but the oracle says valid" },
    { name: "a corpus that names another oracle", mutate: (i) => ({ ...i, doc: { ...i.doc, oracle: { jsonschema: "0.0.1" } } }), expect: "names jsonschema 0.0.1" },
  ],
});

export const corpusTracked = defineGate<TrackedInput>({
  id: "corpus-tracked",
  title: "every tracked file under corpus/ is generated by some lock",
  code: ["gates/common.ts#onlyGenerated"],
  check: onlyGenerated,
  fixtures: [{ name: "a hand-written corpus file", mutate: (i) => ({ ...i, tracked: [...i.tracked, "corpus/extra.json"] }), expect: "corpus/extra.json" }],
});

// Type examples ------------------------------------------------------------------

/** The pinned lists' codes with one list's codes changed. */
const withCodes = (codes: ReadonlyMap<string, ReadonlySet<string | number>>, list: string, change: (c: Set<string | number>) => Set<string | number>) => new Map([...codes].map(([k, v]) => [k, k === list ? change(new Set(v)) : v]));

export const typeExamplesGenerate = defineGate<TypeExamplesInput>({
  id: "type-examples-generate",
  title: "type examples generate: every named type has a minimal and a full example, with the specification's values where they hold, each valid against its schema and breaking no rule one payload decides",
  code: ["src/type-examples.ts#generateTypeExamples"],
  check: (i) => {
    const r = generateTypeExamples(i);
    const entries = Object.values(r.doc.types);
    return { problems: r.problems, note: `${entries.length} types, ${entries.filter((x) => x.notes !== undefined).length} full examples with notes` };
  },
  fixtures: [
    { name: "a schema that rejects its primitive's showcase values and first valid vector", mutate: (i) => ({ ...i, files: withFile(i.files, KERNEL_FILE, (s) => withAmount(s, { minimum: 5000 })) }), expect: "Amount: the minimal example 0 fails the schema" },
    { name: "a currency code the pinned list no longer assigns", mutate: (i) => ({ ...i, codes: withCodes(i.codes, "ISO 4217", (c) => (c.delete("USD"), c)) }), expect: "CurrencyCode: the minimal example \"USD\" fails kernel:CurrencyCode:assigned" },
  ],
});

export const fieldExamplesLoad = defineGate<{ file?: string }>({
  id: "field-examples-load",
  title: "field examples: the per-field example values file schema-valid",
  code: ["src/field-examples.ts#loadFieldExamples"],
  check: (i) => {
    const f = loadFieldExamples(ROOT, i.file);
    return { problems: [], note: `${f.fields.length} entries` };
  },
  fixtures: [{ name: "an entry with three values", mutate: () => ({ file: join(ROOT, "gates/data/field-examples-load/field-examples.yaml") }), expect: "not a valid field examples file" }],
});

/** The type examples' input with one per-field entry added. */
const withField = (i: TypeExamplesInput, e: FieldExample): TypeExamplesInput => ({ ...i, fields: [...i.fields, e] });
/** The type examples' input with the entries for one member changed. */
const withFieldValues = (i: TypeExamplesInput, member: string, change: (e: FieldExample) => FieldExample): TypeExamplesInput => ({ ...i, fields: i.fields.map((e) => (e.member === member ? change(e) : e)) });

export const fieldExamples = defineGate<TypeExamplesInput>({
  id: "field-examples",
  title: "field examples: each per-field value names a member that exists, holds against the member's schema and the rules in its type's full example, and is no value the specification's examples give",
  code: ["src/type-examples.ts#checkFieldExamples"],
  check: (i) => {
    const r = checkFieldExamples(i);
    return { problems: r.problems, note: `${r.entries} entries, at ${r.locations} members` };
  },
  fixtures: [
    { name: "an entry whose value is a specification example value", mutate: (i) => withField(i, { ir: "field:5.1:channel", member: "channel", values: ["display"] }), expect: "duplicates a specification example value at LineItem.channel" },
    { name: "an entry for an element that no longer exists", mutate: (i) => withField(i, { ir: "field:5.9:no_such_field", member: "no_such_field", values: ["Issued at commitment time."] }), expect: "field:5.9:no_such_field no_such_field: names an element that no longer exists" },
    { name: "an entry whose value fails its field's schema", mutate: (i) => withFieldValues(i, "min_impressions", (e) => ({ ...e, values: [-100000] })), expect: "fails its field's schema at CommitmentBounds.min_impressions" },
    { name: "an entry whose value a rule rejects", mutate: (i) => withField(i, { ir: "field:5.6:pricing[].currency", member: "currency", values: ["ABC"] }), expect: "breaks kernel:CurrencyCode:assigned at PricingEntry.currency" },
    {
      name: "a namespaced term where the vocabulary now has core terms",
      lock: "with-open-prs",
      mutate: (i) => withFieldValues(i, "role", ({ locks: _locks, ...e }) => e),
      expect: "isn't a core term of ExternalReferenceRole, which now has core terms",
    },
    { name: "an entry for a member the specification's examples now give a value", mutate: (i) => withField(i, { ir: "field:5.8:visibility", member: "visibility", values: ["public"] }), expect: "the specification's examples give LineItem.visibility a value" },
  ],
});

export const typeExamplesDeterministic = defineGate<RunsInput>({
  id: "type-examples-deterministic",
  title: "deterministic type examples",
  code: ["gates/common.ts#sameRuns"],
  check: sameRuns,
  fixtures: [{ name: "the runs differ", mutate: (i) => ({ ...i, runs: [i.runs[0]!, flipped(i.runs[1]!)] }), expect: "run 2 differs" }],
});

export const typeExamplesCommitted = defineGate<CommittedInput>({
  id: "type-examples-committed",
  title: (i) => `committed ${i.file} current`,
  code: ["gates/common.ts#committedCurrent"],
  check: committedCurrent,
  fixtures: [{ name: "stale committed type examples", mutate: (i) => ({ ...i, committed: flipped(i.committed!) }), expect: "isn't what the pipeline writes" }],
});

/** The committed type examples with the schemas and the rules they must agree with. */
export interface TypeExamplesCheckInput extends Omit<TypeExamplesInput, "kernel" | "spec" | "fields"> {
  doc: TypeExamplesDoc;
}

const withExample = (doc: TypeExamplesDoc, name: string, change: (x: TypeExamplesDoc["types"][string]) => TypeExamplesDoc["types"][string] | undefined): TypeExamplesDoc => ({
  ...doc,
  types: Object.fromEntries(Object.entries(doc.types).flatMap(([n, x]) => {
    const y = n === name ? change(x) : x;
    return y === undefined ? [] : [[n, y]];
  })),
});

export const typeExamplesValid = defineGate<TypeExamplesCheckInput>({
  id: "type-examples-valid",
  title: "committed type examples: one entry per named type, each example valid against its schema and breaking no rule one payload decides",
  code: ["src/type-examples.ts#checkTypeExamples"],
  check: (i) => ({ problems: checkTypeExamples(i.doc, i), note: `${Object.keys(i.doc.types).length} types` }),
  fixtures: [
    { name: "a full example whose basis is no term", mutate: (i) => ({ ...i, doc: withExample(i.doc, "Commitment", (x) => ({ ...x, full: { ...(x.full as object), basis: "barter" } })) }), expect: "Commitment: the full example fails the schema: /basis" },
    {
      name: "a full selection that prices the option it includes",
      mutate: (i) => ({ ...i, doc: withExample(i.doc, "FormatsSelection", (x) => ({ ...x, full: { available: ["display/300x250"], included: ["display/300x250"], pricing: { "display/300x250": { delta_cpm: 1 } } } })) }),
      expect: "FormatsSelection: the full example fails constructor:Selectable:priced-beyond-included",
    },
    { name: "a type with no examples", mutate: (i) => ({ ...i, doc: withExample(i.doc, "Amount", () => undefined) }), expect: "Amount: no examples" },
  ],
});

export const typeExamplesTracked = defineGate<TrackedInput>({
  id: "type-examples-tracked",
  title: "every tracked file under type-examples/ is generated by some lock",
  code: ["gates/common.ts#onlyGenerated"],
  check: onlyGenerated,
  fixtures: [{ name: "a hand-written type examples file", mutate: (i) => ({ ...i, tracked: [...i.tracked, "type-examples/extra.json"] }), expect: "type-examples/extra.json" }],
});

/** Writes a file under `build/ci/fixtures/`, for a fixture whose gate reads files from disk; returns its path from the root. */
export function fixtureFile(name: string, text: string): string {
  const rel = join("build", "ci", "fixtures", name);
  mkdirSync(join(ROOT, rel, ".."), { recursive: true });
  writeFileSync(join(ROOT, rel), text);
  return rel;
}
