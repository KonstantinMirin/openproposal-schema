/** The gates that check the model against the specification's own forms: the round trip of its tables, and its examples. */
import { join } from "node:path";
import type { EmittedFile } from "../src/emit.ts";
import { checkExamples, checkFindings, checkUndecided, lockExamples, loadFindings, oracleAgrees, type ExampleCase, type FindingsFile, type Loaded, type ModelExample } from "../src/examples.ts";
import type { SpecIR } from "../src/ir-types.ts";
import type { SpecLock } from "../src/lock.ts";
import type { DecisionRecord } from "../src/mapping.ts";
import type { ModelDoc } from "../src/model.ts";
import { checkDifferences, type DifferencesFile, loadDifferences, roundTrip, type RoundTripNotation } from "../src/render.ts";
import { defineGate, ROOT } from "./harness.ts";
import { withType } from "./model.ts";
import type { Check } from "../src/rule-checks.ts";

// Round trip --------------------------------------------------------------------

export const differencesLoad = defineGate<{ file: string }>({
  id: "differences-load",
  title: "round trip: differences file schema-valid",
  code: ["src/render.ts#loadDifferences"],
  check: (i) => {
    const d = loadDifferences(i.file);
    return { problems: [], note: `${d.differences.length} recorded difference${d.differences.length === 1 ? "" : "s"}` };
  },
  fixtures: [{ name: "a difference with no decision", mutate: () => ({ file: join(ROOT, "gates/data/differences-load/differences.yaml") }), expect: "not a valid differences file" }],
});

export const differencesLocks = defineGate<{ recorded: DifferencesFile; locks: string[] }>({
  id: "differences-locks",
  title: "round trip: every recorded difference names known locks",
  check: (i) => ({ problems: i.recorded.differences.flatMap((d) => (d.locks ?? []).filter((l) => !i.locks.includes(l)).map((l) => `${d.table} ${d.row} [${d.column}] names the unknown lock "${l}"`)) }),
  fixtures: [{ name: "a difference on an unknown lock", mutate: (i) => ({ ...i, recorded: { ...i.recorded, differences: i.recorded.differences.map((d, n) => (n === 0 ? { ...d, locks: ["no-such-lock"] } : d)) } }), expect: 'names the unknown lock "no-such-lock"' }],
});

export const roundTripGate = defineGate<{ model: ModelDoc; ir: SpecIR; recorded: DifferencesFile; lock: string; decisions: DecisionRecord[]; notation: RoundTripNotation }>({
  id: "round-trip",
  title: "round trip: the tables rendered from the model equal the specification's, or each difference is a recorded decision",
  // The spec plugin's notation reaches the check through its input, so the gate reads every plugin.
  code: ["src/render.ts#roundTrip", "src/render.ts#checkDifferences", "src/specs/index.ts#PLUGINS"],
  exemptions: ["specs/*/roundtrip/differences.yaml"],
  check: (i) => {
    const rt = roundTrip(i.model, i.ir, i.notation);
    const problems = [...rt.problems, ...checkDifferences(rt.differences, i.recorded, i.lock, i.decisions)];
    const rows = rt.model.reduce((n, t) => n + t.rows.length, 0);
    return { problems, note: `${rt.model.length} tables, ${rows} rows; ${rt.differences.length} recorded difference${rt.differences.length === 1 ? "" : "s"}` };
  },
  fixtures: [
    {
      name: "a field's marker the model changed",
      mutate: (i) => ({
        ...i,
        model: withType(i.model, "LineItem", (t) => {
          const d = t as Extract<typeof t, { kind: "document" }>;
          return { ...d, properties: { ...d.properties, min_spend: { ...d.properties.min_spend!, marker: "immutable" } } };
        }),
      }),
      expect: 'the model renders "immutable"',
    },
    { name: "a recorded difference that no longer occurs", mutate: (i) => ({ ...i, recorded: { ...i.recorded, differences: [...i.recorded.differences, { ...i.recorded.differences[0]!, row: "no-such-row" }] } }), expect: "no longer differs" },
  ],
});

// Examples ----------------------------------------------------------------------

export const findingsLoad = defineGate<{ file: string }>({
  id: "findings-load",
  title: "examples: findings file schema-valid",
  code: ["src/examples.ts#loadFindings"],
  check: (i) => {
    const f = loadFindings(i.file);
    return { problems: [], note: `${f.findings.length} recorded finding${f.findings.length === 1 ? "" : "s"}` };
  },
  fixtures: [{ name: "a finding with no decisions", mutate: () => ({ file: join(ROOT, "gates/data/findings-load/findings.yaml") }), expect: "not a valid findings file" }],
});

export const findingsLocks = defineGate<{ recorded: FindingsFile; locks: string[] }>({
  id: "findings-locks",
  title: "examples: every recorded finding names known locks",
  check: (i) => ({ problems: i.recorded.findings.flatMap((f) => (f.locks ?? []).filter((l) => !i.locks.includes(l)).map((l) => `${f.example} ${f.path} names the unknown lock "${l}"`)) }),
  fixtures: [{ name: "a finding on an unknown lock", mutate: (i) => ({ ...i, recorded: { ...i.recorded, findings: i.recorded.findings.map((f, n) => (n === 0 ? { ...f, locks: ["no-such-lock"] } : f)) } }), expect: 'names the unknown lock "no-such-lock"' }],
});

export const examplesListing = defineGate<{ lock: SpecLock; model: ModelDoc }>({
  id: "examples-listing",
  title: "examples: the lock lists, blob-verified, every file the specification names as an example, and every file under examples/",
  code: ["src/examples.ts#lockExamples"],
  check: async (i) => {
    const got = await lockExamples(i.lock, i.model);
    return { problems: got.listing, note: `${Object.keys(i.lock.examples).length} files via ${got.via}` };
  },
  fixtures: [
    {
      name: "an example the lock doesn't list",
      mutate: (i) => ({ ...i, lock: { ...i.lock, examples: Object.fromEntries(Object.entries(i.lock.examples).filter(([p]) => p !== "examples/proposal.yaml")) } }),
      expect: "examples/proposal.yaml",
    },
    { name: "an example blob no source has", mutate: (i) => ({ ...i, lock: { ...i.lock, examples: { ...i.lock.examples, "examples/proposal.yaml": "3".repeat(40) }, sources: i.lock.sources.filter((s) => "snapshot" in s) } }), expect: "3".repeat(40) },
  ],
});

/** One lock's examples with the schemas, the recorded findings, and the decisions. */
export interface ExamplesInput {
  model: ModelDoc;
  files: EmittedFile[];
  schemaDir: string;
  examples: ModelExample[];
  values: Map<string, Loaded>;
  /** The codes of the lists the repository pins, which the currency and zone rules read. */
  codes: ReadonlyMap<string, ReadonlySet<string | number>>;
  /** Every check a rule of the lock may have: the kernel's, the constructors', and the spec's (`checksOf`). */
  ruleChecks: Readonly<Record<string, Check>>;
  recorded: FindingsFile;
  lock: string;
  decisions: DecisionRecord[];
}

export const examplesValidate = defineGate<ExamplesInput>({
  id: "examples-validate",
  title: "examples load under YAML 1.2 core, validate against their documents, use only keys the model defines, and keep every rule a check decides, or each failure is a recorded finding",
  // The spec plugins' rule checks reach the check through its input, so the gate reads them too.
  code: ["src/examples.ts#checkExamples", "src/examples.ts#checkFindings", "src/examples.ts#checkUndecided", "src/rule-checks.ts#CHECKS", "src/specs/index.ts#PLUGINS"],
  exemptions: ["specs/*/examples/findings.yaml"],
  check: (i) => {
    const r = checkExamples(i);
    const problems = [...r.problems, ...checkFindings(r.failures, i.recorded, i.lock, i.decisions), ...checkUndecided(r.checks.undecided, i.recorded, i.lock, i.decisions)];
    const warnings = r.failures.filter((f) => f.severity === "warning").length;
    return {
      problems,
      note: `${i.examples.length} examples, ${i.examples.length - new Set(r.failures.map((f) => f.example)).size} valid; ${r.failures.length} recorded finding${r.failures.length === 1 ? "" : "s"}, ${warnings} of them SHOULD warnings; ${r.checks.ran} rule checks on the examples' values, ${r.checks.undecided.length} recorded undecided`,
    };
  },
  fixtures: [
    {
      name: "a recorded rule finding removed",
      mutate: (i) => {
        const at = i.recorded.findings.findIndex((f) => f.kind === "rule" && (f.locks === undefined || f.locks.includes(i.lock)));
        return { ...i, recorded: { ...i.recorded, findings: i.recorded.findings.filter((_, n) => n !== at) } };
      },
      expect: "(constructor:Selectable:options-named): rule on lock",
    },
    {
      name: "a recorded finding removed",
      mutate: (i) => {
        const inScope = i.recorded.findings.findIndex((f) => f.locks === undefined || f.locks.includes(i.lock));
        return { ...i, recorded: { ...i.recorded, findings: i.recorded.findings.filter((_, n) => n !== inScope) } };
      },
      expect: "record the finding with the decision it rests on",
    },
    {
      name: "a recorded undecided check removed",
      lock: "with-open-prs",
      mutate: (i) => ({ ...i, recorded: { ...i.recorded, undecided: (i.recorded.undecided ?? []).filter((u) => u.rule !== "rule:5.2:f3d3f9e8") } }),
      expect: "examples/line-item-ctv-bonus.yaml / (rule:5.2:f3d3f9e8): undecided on lock",
    },
    {
      name: "a MUST rule's finding recorded as a SHOULD warning",
      mutate: (i) => {
        const at = i.recorded.findings.findIndex((f) => f.kind === "rule" && (f.locks === undefined || f.locks.includes(i.lock)));
        return { ...i, recorded: { ...i.recorded, findings: i.recorded.findings.map((f, n) => (n === at ? { ...f, severity: "warning" as const } : f)) } };
      },
      expect: "is an error on lock",
    },
    {
      name: "a departure finding whose reason blames the example",
      mutate: (i) => {
        const departures = new Set(i.decisions.filter((d) => d.kind === "departure").map((d) => d.id));
        const at = i.recorded.findings.findIndex((f) => (f.locks === undefined || f.locks.includes(i.lock)) && f.decisions.some((d) => departures.has(d)));
        return { ...i, recorded: { ...i.recorded, findings: i.recorded.findings.map((f, n) => (n === at ? { ...f, reason: "The example is wrong." } : f)) } };
      },
      expect: "The example follows the text",
    },
    {
      name: "a finding that cites a gap and a departure, so its reason would sit in both tables",
      mutate: (i) => {
        const departures = new Set(i.decisions.filter((d) => d.kind === "departure").map((d) => d.id));
        const gap = i.decisions.find((d) => d.kind === "gap")!.id;
        const at = i.recorded.findings.findIndex((f) => (f.locks === undefined || f.locks.includes(i.lock)) && f.decisions.some((d) => departures.has(d)));
        return { ...i, recorded: { ...i.recorded, findings: i.recorded.findings.map((f, n) => (n === at ? { ...f, decisions: [...f.decisions, gap] } : f)) } };
      },
      expect: "cites a gap and a departure",
    },
  ],
});

export const examplesOracle = defineGate<{ files: EmittedFile[]; cases: ExampleCase[] }>({
  id: "examples-oracle",
  title: "examples: the reference oracle reaches Ajv's verdict on every example",
  code: ["src/examples.ts#oracleAgrees"],
  check: (i) => oracleAgrees(ROOT, i.files, i.cases),
  fixtures: [{ name: "a verdict the oracle doesn't reach", mutate: (i) => ({ ...i, cases: i.cases.map((c, n) => (n === 0 ? { ...c, valid: !c.valid } : c)) }), expect: /: Ajv says (valid|invalid), the oracle (valid|invalid)$/ }],
});
