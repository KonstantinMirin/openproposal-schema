/** The gates that check the model against the specification's own forms: the round trip of its tables, and its examples. */
import { basename, join } from "node:path";
import type { EmittedFile } from "../src/emit.ts";
import { checkExamples, checkFindings, checkUndecided, lockExamples, loadFindings, oracleAgrees, type ExampleCase, type FindingsFile, type Loaded, type ModelExample } from "../src/examples.ts";
import { checkDeskTests, loadDeskTests, REVIEW_MARK, type CheckerRun, type DeskTestsInput } from "../src/desk-tests.ts";
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
    // The Deals API's tables: a code's label the model changed, and a default it dropped, render differently from the text.
    {
      name: "a Deals API code label the model changed",
      spec: "dealsapi",
      mutate: (i) => ({ ...i, model: withType(i.model, "PublisherCount", (t) => ({ ...(t as Extract<typeof t, { kind: "vocabulary" }>), terms: (t as Extract<typeof t, { kind: "vocabulary" }>).terms.map((x) => (x.value === 2 ? { ...x, annotation: "many publishers" } : x)) })) }),
      expect: "`2` = many publishers",
    },
    {
      name: "a property the model adds to a Deals API object",
      spec: "dealsapi",
      mutate: (i) => ({ ...i, model: withType(i.model, "Deal", (t) => {
        const d = t as Extract<typeof t, { kind: "document" }>;
        return { ...d, properties: { ...d.properties, region: { ...d.properties.name!, sources: [] } } };
      }) }),
      expect: "Deal.region",
    },
    {
      name: "a Deals API property the model moves to another object",
      spec: "dealsapi",
      mutate: (i) => {
        const cur = (i.model.types.find((t) => t.name === "Terms") as Extract<(typeof i.model.types)[number], { kind: "object" }>).properties.cur!;
        const moved = withType(i.model, "Terms", (t) => {
          const o = t as Extract<typeof t, { kind: "object" }>;
          const { cur: _c, ...rest } = o.properties;
          return { ...o, properties: rest };
        });
        return { ...i, model: withType(moved, "Deal", (t) => ({ ...(t as Extract<typeof t, { kind: "document" }>), properties: { ...(t as Extract<typeof t, { kind: "document" }>).properties, cur } })) };
      },
      expect: "field:object-terms:cur",
    },
    {
      name: "a Deals API default the model dropped",
      spec: "dealsapi",
      mutate: (i) => ({ ...i, model: withType(i.model, "Terms", (t) => {
        const o = t as Extract<typeof t, { kind: "object" }>;
        const { default: _d, ...cur } = o.properties.cur!;
        return { ...o, properties: { ...o.properties, cur } };
      }) }),
      expect: 'now the specification writes "string; default "USD"" and the model renders "string"',
    },
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

// Desk tests ----------------------------------------------------------------------

export const deskTestsLoad = defineGate<{ file: string }>({
  id: "desk-tests-load",
  title: "desk tests: expected file schema-valid",
  code: ["src/desk-tests.ts#loadDeskTests"],
  check: (i) => {
    const s = loadDeskTests(i.file);
    return { problems: [], note: `${basename(s.dir)}: ${s.examples.length} payloads, ${s.findings.length} expected rejections, on lock "${s.lock}"` };
  },
  fixtures: [{ name: "a finding with no reason", mutate: () => ({ file: join(ROOT, "gates/data/desk-tests-load/expected.yaml") }), expect: "not a valid desk-tests file" }],
});

/** The set the desk-tests gate's fixtures change: IAB Australia's, on the stack lock, whatever other sets the lock has. */
const IAB_SET = "iab-au-2026-11";
const onIab = (i: { sets: DeskTestsInput[] }, change: (s: DeskTestsInput) => DeskTestsInput) => {
  if (!i.sets.some((s) => basename(s.set.dir) === IAB_SET)) throw new Error(`the lock has no desk-test set ${IAB_SET}`);
  return { ...i, sets: i.sets.map((s) => (basename(s.set.dir) === IAB_SET ? change(s) : s)) };
};
/** The second set, IAB Australia's billable-day and `calendar_zone` line items, whose checker-only findings the fixtures below change. */
const CALENDAR_SET = "iab-au-2026-11-calendar";
const onCalendar = (i: { sets: DeskTestsInput[] }, change: (s: DeskTestsInput) => DeskTestsInput) => {
  if (!i.sets.some((s) => basename(s.set.dir) === CALENDAR_SET)) throw new Error(`the lock has no desk-test set ${CALENDAR_SET}`);
  return { ...i, sets: i.sets.map((s) => (basename(s.set.dir) === CALENDAR_SET ? change(s) : s)) };
};
const A3 = "billable-day-a3-mon-1800-tue-0600-two-days-spend.yaml";
const D01 = "calendar-zone-d01-mon-0600-1800.yaml";
/** A fixture's change to one SDK's run of the IAB set. */
const onSdk = (language: string, change: (r: CheckerRun) => CheckerRun) => (i: { sets: DeskTestsInput[] }) =>
  onIab(i, (s) => {
    if (!s.sdks.some((r) => r.label.startsWith(`the ${language} SDK`))) throw new Error(`the set has no ${language} SDK run`);
    return { ...s, sdks: s.sdks.map((r) => (r.label.startsWith(`the ${language} SDK`) ? change(r) : r)) };
  });

export const deskTests = defineGate<{ sets: DeskTestsInput[] }>({
  id: "desk-tests",
  title: "desk tests: each payload of each set gets its recorded verdict from the schemas and rules, from the lock's own checker, and from each SDK",
  // The spec plugins' rule checks reach the check through its input, as for the examples gate; the checker's and the SDKs' runs are part of the input.
  code: ["src/desk-tests.ts#checkDeskTests", "src/desk-tests.ts#runDeskChecker", "src/desk-tests.ts#runDeskSdks", "src/rule-checks.ts#CHECKS", "src/specs/index.ts#PLUGINS"],
  files: ["tools/sdk/findings.py"],
  exemptions: ["specs/*/desk-tests/*/expected.yaml"],
  check: (i) => {
    const problems: string[] = [];
    const notes: string[] = [];
    for (const s of i.sets) {
      const name = basename(s.set.dir);
      const r = checkDeskTests(s);
      problems.push(...r.problems.map((p) => `${name}: ${p}`));
      const findings = new Set(s.set.findings.map((f) => f.example));
      const rejected = findings.size;
      const checkerOnly = new Set(s.set.checker_only.map((c) => c.example).filter((x) => !findings.has(x))).size;
      const engines = [`the schemas and rules`, s.checker.label, ...s.sdks.map((x) => x.label)];
      notes.push(
        `${name}: ${s.set.examples.length} payloads, ${s.set.examples.length - rejected - checkerOnly} clean and ${rejected} rejected, each at its recorded location, by ${engines.slice(0, -1).join(", ")}, and ${engines.at(-1)}${checkerOnly > 0 ? `, and ${checkerOnly} rejected by the checker alone` : ""}; ${s.set.sdk_gaps.length} recorded SDK gap${s.set.sdk_gaps.length === 1 ? "" : "s"}; ${s.set.checker_only.length} recorded checker-only finding${s.set.checker_only.length === 1 ? "" : "s"}; ${s.set.undecided.length} recorded undecided`,
      );
    }
    return { problems, note: `${notes.join("; ")}; 0 mismatches` };
  },
  fixtures: [
    {
      name: "an expected rejection removed",
      mutate: (i) => onIab(i, (s) => ({ ...s, set: { ...s.set, findings: s.set.findings.filter((f) => f.example !== "dooh-v2-p9-demographic.yaml") } })),
      expect: "dooh-v2-p9-demographic.yaml /delivery_counting/impression_multiplier/demographic (invalid): the schemas and rules on lock",
    },
    {
      name: "a clean payload that now fails the schemas",
      mutate: (i) =>
        onIab(i, (s) => {
          const at = s.payloads.get("dooh-v2-b-pg.yaml")!;
          const payloads = new Map(s.payloads);
          if (at.ok) payloads.set("dooh-v2-b-pg.yaml", { ok: true, value: { ...(at.value as Record<string, unknown>), route_note: "both" } });
          return { ...s, payloads };
        }),
      expect: "dooh-v2-b-pg.yaml /route_note (undefined_key): the schemas and rules",
    },
    {
      name: "a payload the checker no longer rejects",
      mutate: (i) => onIab(i, (s) => ({ ...s, checker: { ...s.checker, failures: s.checker.failures.filter((f) => f.example !== "dooh-v2-p11-c-no-multiplier.yaml") } })),
      expect: "dooh-v2-p11-c-no-multiplier.yaml /delivery_counting: scripts/check_examples.py at",
    },
    {
      name: "a clean payload the checker rejects",
      mutate: (i) => onIab(i, (s) => ({ ...s, checker: { ...s.checker, failures: [...s.checker.failures, { example: "dooh-v2-c-both.yaml", path: "/pricing/0", message: "a changed verdict" }] } })),
      expect: "dooh-v2-c-both.yaml /pricing/0: scripts/check_examples.py at",
    },
    {
      name: "a rejection the checker reports elsewhere",
      mutate: (i) => onIab(i, (s) => ({ ...s, checker: { ...s.checker, failures: s.checker.failures.map((f) => (f.example === "dooh-v2-p8-phases.yaml" ? { ...f, path: "/commitment" } : f)) } })),
      expect: "dooh-v2-p8-phases.yaml /commitment/phases: scripts/check_examples.py at",
    },
    {
      name: "a payload the expected file doesn't list",
      mutate: (i) => onIab(i, (s) => ({ ...s, payloads: new Map([...s.payloads, ["extra.yaml", { ok: true, value: {} }]]) })),
      expect: "extra.yaml is in the folder and isn't listed under examples",
    },
    {
      name: "a recorded undecided check removed",
      mutate: (i) => onIab(i, (s) => ({ ...s, set: { ...s.set, undecided: s.set.undecided.filter((u) => u.example !== "dooh-v2-a0-direct-12wk.yaml") } })),
      expect: "dooh-v2-a0-direct-12wk.yaml / (rule:5.4:3a677601): undecided on lock",
    },
    {
      name: "a checker run that failed",
      mutate: (i) => onIab(i, (s) => ({ ...s, checker: { ...s.checker, problems: ["scripts/check_examples.py exited 2: Traceback"] } })),
      expect: "exited 2",
    },
    {
      name: "a checker-only finding the checker doesn't make",
      mutate: (i) => onCalendar(i, (s) => ({ ...s, set: { ...s.set, checker_only: [...s.set.checker_only, { example: D01, path: "", elements: ["sentence:5.6.5:10182d60"], reason: "a finding no engine makes" }] } })),
      expect: "no longer rejects it there, where iab-au-2026-11-calendar/expected.yaml records a checker-only finding",
    },
    {
      name: "an SDK that makes a checker-only finding",
      mutate: (i) =>
        onCalendar(i, (s) => ({
          ...s,
          set: { ...s.set, checker_only: [...s.set.checker_only, { example: D01, path: "", elements: ["sentence:5.6.5:10182d60"], reason: "a finding the checker makes" }] },
          checker: { ...s.checker, failures: [...s.checker.failures, { example: D01, path: "", message: "a TIME count" }] },
          sdks: s.sdks.map((r, n) => (n === 0 ? { ...r, failures: [...r.failures, { example: D01, path: "", message: "a TIME count" }] } : r)),
        })),
      expect: "records it as checker only; record the finding under findings and remove the entry",
    },
    {
      name: "a checker-only finding that reads no element of the IR",
      mutate: (i) =>
        onCalendar(i, (s) => ({
          ...s,
          set: { ...s.set, checker_only: [...s.set.checker_only, { example: D01, path: "", elements: ["sentence:5.6.5:00000000"], reason: "a finding the checker makes" }] },
          checker: { ...s.checker, failures: [...s.checker.failures, { example: D01, path: "", message: "a TIME count" }] },
        })),
      expect: "reads sentence:5.6.5:00000000, which is no element of lock",
    },
    {
      name: "a checker-only finding that is a schemas finding too",
      mutate: (i) => onCalendar(i, (s) => ({ ...s, set: { ...s.set, checker_only: [...s.set.checker_only, { example: "calendar-zone-d09-zone-with-hour.yaml", path: "/pricing/0/cost_parameters/rate_unit", elements: ["sentence:5.6.5:10182d60"], reason: "a finding twice over" }] } })),
      expect: "records it under findings and as checker only",
    },
    {
      name: "an SDK gap for a rule the SDKs check from its program",
      mutate: (i) => onCalendar(i, (s) => ({ ...s, set: { ...s.set, sdk_gaps: [...s.set.sdk_gaps, { example: A3, path: "", rule: "sentence:5.6.5:aa43e614", reason: "a gap the SDKs closed" }] } })),
      expect: "records an SDK gap for sentence:5.6.5:aa43e614, which the SDKs check now, from its program",
    },
    {
      name: "a drafted reason left for review",
      mutate: (i) => onIab(i, (s) => ({ ...s, set: { ...s.set, findings: s.set.findings.map((f) => (f.example === "dooh-v2-p8-phases.yaml" ? { ...f, reason: REVIEW_MARK } : f)) } })),
      expect: 'iab-au-2026-11/expected.yaml: dooh-v2-p8-phases.yaml /commitment/phases: the reason is "TODO: review"',
    },
    {
      name: "a drafted SDK gap left for review",
      mutate: (i) => onIab(i, (s) => ({ ...s, set: { ...s.set, sdk_gaps: s.set.sdk_gaps.map((g) => ({ ...g, reason: REVIEW_MARK })) } })),
      expect: 'dooh-v2-p11-c-no-multiplier.yaml /delivery_counting (rule:5.6.4:e58650b7): the reason is "TODO: review"',
    },
    {
      name: "a README left for review",
      mutate: (i) => onIab(i, (s) => ({ ...s, set: { ...s.set, readme: `${s.set.readme ?? ""}\n${REVIEW_MARK}: the permission\n` } })),
      expect: 'iab-au-2026-11/README.md: holds "TODO: review"',
    },
    {
      name: "a set with no README",
      mutate: (i) => onIab(i, (s) => ({ ...s, set: { ...s.set, readme: null } })),
      expect: "iab-au-2026-11/README.md: missing",
    },
    {
      name: "an SDK that accepts a payload the other engines reject",
      mutate: onSdk("Go", (r) => ({ ...r, failures: r.failures.filter((f) => f.example !== "dooh-v2-p8-phases.yaml") })),
      expect: /dooh-v2-p8-phases\.yaml \/commitment\/phases: the Go SDK \([^)]+\) doesn't reject it there$/,
    },
    {
      name: "an SDK that rejects a clean payload",
      mutate: onSdk("Python", (r) => ({ ...r, failures: [...r.failures, { example: "dooh-v2-c-both.yaml", path: "/pricing/0", message: "a changed verdict" }] })),
      expect: /dooh-v2-c-both\.yaml \/pricing\/0: the Python SDK \([^)]+\) rejects it, and iab-au-2026-11\/expected\.yaml expects the SDKs to accept it/,
    },
    {
      name: "an SDK that rejects a payload elsewhere",
      mutate: onSdk("TypeScript", (r) => ({ ...r, failures: r.failures.map((f) => (f.example === "dooh-v2-p12-offset-instant.yaml" ? { ...f, path: "/commitment/flight" } : f)) })),
      expect: /dooh-v2-p12-offset-instant\.yaml \/commitment\/flight: the TypeScript SDK \([^)]+\) rejects it, and .* expects it rejected only at \/commitment\/flight\/start/,
    },
    {
      name: "an SDK that rejects a payload at a recorded SDK gap",
      mutate: onSdk("TypeScript", (r) => ({ ...r, failures: [...r.failures, { example: "dooh-v2-p11-c-no-multiplier.yaml", path: "/delivery_counting", message: "a rule the SDK checks now" }] })),
      expect: "records under sdk_gaps that no SDK type checks rule:5.6.4:e58650b7; review the verdict and remove the entry",
    },
    {
      name: "a rule's finding the SDK gaps don't record",
      mutate: (i) => onIab(i, (s) => ({ ...s, set: { ...s.set, sdk_gaps: [] } })),
      expect: "so record rule:5.6.4:e58650b7 there under sdk_gaps, with the reason",
    },
    {
      name: "an SDK gap recorded for a schema's finding",
      mutate: (i) => onIab(i, (s) => ({ ...s, set: { ...s.set, sdk_gaps: [...s.set.sdk_gaps, { example: "dooh-v2-p8-phases.yaml", path: "/commitment/phases", rule: "rule:5.6.4:e58650b7", reason: "a gap that isn't one" }] } })),
      expect: "dooh-v2-p8-phases.yaml /commitment/phases: iab-au-2026-11/expected.yaml records an SDK gap for rule:5.6.4:e58650b7, and the file has no finding of that rule there",
    },
    {
      name: "an SDK run that failed",
      mutate: onSdk("Go", (r) => ({ ...r, failures: [], problems: ["the Go SDK didn't run: the Go harness failed"] })),
      expect: "the Go SDK didn't run",
    },
  ],
});
