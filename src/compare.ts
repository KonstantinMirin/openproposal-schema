/**
 * The lock comparison: what a lock changes against the default lock, read
 * from the pipeline's own outputs on both.
 *
 * `npm run compare` runs the pipeline on each lock, from its committed IR
 * and findings, which the extraction gates keep current: the model, the
 * schema files, the rules, the round trip, and the examples. It then writes
 * one report per lock other than the default, `comparison/<lock>.json` and
 * `comparison/<lock>.md`, comparing it with the default lock. The report
 * lists:
 *
 * - the specification elements the lock adds, removes, or changes, by IR ID
 *   and digest, so a new field row is a new element;
 * - the schema changes, as the release differ classes them (src/release.ts):
 *   the models type by type, the rules by ID and content, and the emitted
 *   files entry by entry, each `breaking`, `additive`, or `annotation`, as if
 *   the lock were the next release after the default lock;
 * - where each statement goes: a rule, an obligation, a statement a schema
 *   expresses, or an example, and the ones whose place changes;
 * - the decisions the lock's model and rules cite that the default lock's
 *   don't, and the reverse, and the decisions both cite whose covered
 *   elements differ between the locks;
 * - the findings: the spec lint's, the examples', the round trip's, and the
 *   conditions the schema leaves to the rules, added or removed. A recorded
 *   finding or difference carries its decision and its reason.
 *
 * The JSON form is canonical, every list sorted, and the markdown is a
 * function of it, so the report is a function of the two locks' pipelines.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "./canonical.ts";
import type { Constructors } from "./constructors.ts";
import { citeText, elementDigest, indexElements, type Element } from "./elements.ts";
import { emitSchemas, schemaDirOf, type EmittedFile } from "./emit.ts";
import { codesOf } from "./rule-checks.ts";
import { checkExamples, lockExamples, type Failure, type FindingsFile, type Undecided } from "./examples.ts";
import type { SpecIR } from "./ir-types.ts";
import type { Kernel } from "./kernel.ts";
import type { Finding as LintFinding } from "./lint.ts";
import type { SpecLock } from "./lock.ts";
import { inScope, type DecisionRecord, type MappingFile } from "./mapping.ts";
import { resolveModel, type ModelDoc } from "./model.ts";
import type { FindingsDoc } from "./pipeline.ts";
import { citedDecisions, diffFiles, diffModels, diffRules, type Change } from "./release.ts";
import { roundTrip, type Difference, type DifferencesFile } from "./render.ts";
import { emitRules, type RulesDoc, type VectorFile } from "./rules.ts";

/** Where the reports live: `comparison/<lock>.json` and `comparison/<lock>.md`. */
export const COMPARISON_DIR = "comparison";
/** The default lock's file; every other lock is compared with it. */
export const DEFAULT_LOCK_FILE = "spec-lock.yaml";

/** One lock's pipeline outputs, which the comparison reads. */
export interface LockBuild {
  lock: SpecLock;
  ir: SpecIR;
  lint: LintFinding[];
  model: ModelDoc;
  files: EmittedFile[];
  rules: RulesDoc;
  conditionsLeft: string[];
  differences: Difference[];
  failures: Failure[];
  /** The rules' checks the examples leave undecided. */
  undecided: Undecided[];
}

export interface BuildInput {
  root: string;
  mappings: MappingFile[];
  decisions: DecisionRecord[];
  kernel: Kernel;
  constructors: Constructors;
  vectors: VectorFile[];
}

/**
 * Runs the pipeline on one lock, from its committed IR and findings: the
 * model, the schemas, the rules, the round trip, and the examples. A
 * problem is a stage that didn't run clean; the build is then null.
 */
export async function buildLock(lock: SpecLock, input: BuildInput): Promise<{ build: LockBuild | null; problems: string[] }> {
  const { root, mappings, decisions, kernel, constructors, vectors } = input;
  const ir = JSON.parse(readFileSync(join(root, lock.ir_dir, "spec-ir.json"), "utf8")) as SpecIR;
  const findings = JSON.parse(readFileSync(join(root, lock.ir_dir, "findings.json"), "utf8")) as FindingsDoc;
  const resolved = resolveModel({ ir, lock: lock.name, mappings, decisions, kernel, constructors });
  if (resolved.problems.length > 0) return { build: null, problems: resolved.problems.map((p) => `model: ${p}`) };
  const model = resolved.model;
  const schemaDir = schemaDirOf(lock.ir_dir);
  const emitted = emitSchemas(model, schemaDir);
  if (emitted.problems.length > 0) return { build: null, problems: emitted.problems.map((p) => `schemas: ${p}`) };
  const rules = emitRules({ model, ir, lock: lock.name, vectors, decisions, schemaDir, conditionsLeft: emitted.conditions.left });
  if (rules.problems.length > 0) return { build: null, problems: rules.problems.map((p) => `rules: ${p}`) };
  const rt = roundTrip(model, ir);
  if (rt.problems.length > 0) return { build: null, problems: rt.problems.map((p) => `round trip: ${p}`) };
  let got;
  try {
    got = await lockExamples(lock, model);
  } catch (e) {
    return { build: null, problems: [`examples: ${(e as Error).message.split("\n")[0]}`] };
  }
  const ex = checkExamples({ model, files: emitted.files, schemaDir, examples: got.examples, values: got.values, codes: codesOf(input.kernel.lists ?? { lists: [] }) });
  const exProblems = [...got.listing, ...ex.problems];
  if (exProblems.length > 0) return { build: null, problems: exProblems.map((p) => `examples: ${p}`) };
  return {
    build: { lock, ir, lint: findings.findings, model, files: emitted.files, rules: rules.doc, conditionsLeft: emitted.conditions.left, differences: rt.differences, failures: ex.failures, undecided: ex.checks.undecided },
    problems: [],
  };
}

// ---------------------------------------------------------------------------
// The report

export interface Side {
  lock: string;
  commit: string;
  blob: string;
  ir_sha256: string;
  counts: Record<string, number>;
}

export interface ElementEntry {
  id: string;
  kind: Element["kind"];
  text: string;
}

export interface StatementEntry {
  ir: string;
  text: string;
  level?: string;
  /** Where the model puts it: `rule <owner>`, `obligation <party>`, `schema <type>`, or `example <object>`. */
  placed: string;
}

export interface DecisionEntry {
  id: string;
  status: DecisionRecord["status"];
  question: string;
}

export interface LintEntry {
  id: string;
  kind: string;
  message: string;
  verdict: string;
}

export interface ExampleEntry {
  example: string;
  path: string;
  kind: Failure["kind"];
  message: string;
  decisions?: string[];
  reason?: string;
}

export interface DifferenceEntry {
  table: string;
  row: string;
  column: string;
  spec: string;
  model: string;
  decision?: string;
  reason?: string;
}

export interface ComparisonDoc {
  format: 1;
  base: Side;
  lock: Side;
  elements: { added: ElementEntry[]; removed: ElementEntry[]; changed: (ElementEntry & { was: string })[] };
  /** The release differ's changes from the default lock to this one, by view. */
  changes: (Change & { view: "model" | "rules" | "files" })[];
  statements: { added: StatementEntry[]; removed: StatementEntry[]; moved: (StatementEntry & { was: string })[] };
  decisions: { added: DecisionEntry[]; removed: DecisionEntry[]; reread: (DecisionEntry & { elements: string[] })[] };
  findings: {
    spec: { added: LintEntry[]; removed: LintEntry[]; changed: (LintEntry & { was: string })[] };
    examples: { added: ExampleEntry[]; removed: ExampleEntry[] };
    round_trip: { added: DifferenceEntry[]; removed: DifferenceEntry[]; changed: (DifferenceEntry & { was: { spec: string; model: string } })[] };
    conditions: { added: string[]; removed: string[] };
  };
}

export interface CompareInput {
  base: LockBuild;
  lock: LockBuild;
  decisions: DecisionRecord[];
  recordedFindings: FindingsFile;
  recordedDifferences: DifferencesFile;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const by = <T>(key: (x: T) => string) => (a: T, b: T) => cmp(key(a), key(b));

function counts(b: LockBuild, elements: Map<string, Element>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of elements.values()) out[`elements.${e.kind}`] = (out[`elements.${e.kind}`] ?? 0) + 1;
  for (const t of b.model.types) out[`types.${t.kind}`] = (out[`types.${t.kind}`] ?? 0) + 1;
  out.properties = b.model.types.reduce((n, t) => n + ("properties" in t ? Object.keys(t.properties).length : 0), 0);
  out["statements.rule"] = b.model.rules.length;
  out["statements.obligation"] = b.model.obligations.length;
  out["statements.schema"] = b.model.schema_statements.length;
  out["statements.example"] = b.model.examples.length;
  out.rules = b.rules.rules.length;
  out["schema_files"] = b.files.length;
  out.decisions = citedDecisions(b.model, b.rules).length;
  out["findings.spec"] = b.lint.length;
  out["findings.spec_open"] = b.lint.filter((f) => f.disposition === null).length;
  out["findings.examples"] = b.failures.length;
  out["findings.round_trip"] = b.differences.length;
  out["findings.conditions"] = b.conditionsLeft.length;
  return out;
}

const side = (b: LockBuild, elements: Map<string, Element>): Side => ({
  lock: b.lock.name,
  commit: b.model.input.commit,
  blob: b.model.input.blob,
  ir_sha256: b.model.input.ir_sha256,
  counts: counts(b, elements),
});

function statementsOf(m: ModelDoc): Map<string, StatementEntry> {
  const out = new Map<string, StatementEntry>();
  const put = (s: { ir: string; text: string; level?: string }, placed: string) => out.set(s.ir, { ir: s.ir, text: s.text, ...(s.level !== undefined ? { level: s.level } : {}), placed });
  for (const s of m.rules) put(s, `rule ${s.owner}`);
  for (const s of m.obligations) put(s, `obligation ${s.party}`);
  for (const s of m.schema_statements) put(s, `schema ${s.in}`);
  for (const s of m.examples) put(s, `example ${s.object}`);
  return out;
}

const lintEntry = (f: LintFinding): LintEntry => ({ id: f.id, kind: f.kind, message: f.message, verdict: f.disposition?.verdict ?? "open" });
/** What a lint finding says: its message and its verdict. Its locations and details move with the text around it. */
const lintContent = (f: LintFinding) => canonicalJson({ kind: f.kind, message: f.message, verdict: f.disposition?.verdict ?? "open" });

const exampleKey = (f: { example: string; path: string; kind: string }) => `${f.example}\u0000${f.path}\u0000${f.kind}`;
const differenceKey = (d: { table: string; row: string; column: string }) => `${d.table}\u0000${d.row}\u0000${d.column}`;

/** Compares one lock with the default lock. */
export function compareLocks(input: CompareInput): ComparisonDoc {
  const { base, lock, decisions } = input;
  const [eb, el] = [indexElements(base.ir), indexElements(lock.ir)];

  // The specification's elements, by ID and digest.
  const entry = (e: Element): ElementEntry => ({ id: e.element.id, kind: e.kind, text: citeText(e) });
  const elements: ComparisonDoc["elements"] = { added: [], removed: [], changed: [] };
  for (const [id, e] of el) {
    const was = eb.get(id);
    if (was === undefined) elements.added.push(entry(e));
    else if (elementDigest(was) !== elementDigest(e)) elements.changed.push({ ...entry(e), was: citeText(was) });
  }
  for (const [id, e] of eb) if (!el.has(id)) elements.removed.push(entry(e));

  // The schema, as the release differ sees it.
  const tree = (files: EmittedFile[]) => Object.fromEntries(files.map((f) => [f.path, f.schema]));
  const changes: ComparisonDoc["changes"] = [
    ...diffModels(base.model, lock.model).map((c) => ({ ...c, view: "model" as const })),
    ...diffRules(base.rules, lock.rules, base.model).map((c) => ({ ...c, view: "rules" as const })),
    ...diffFiles(tree(base.files), tree(lock.files)).map((c) => ({ ...c, view: "files" as const })),
  ];

  // Where each statement goes.
  const [sb, sl] = [statementsOf(base.model), statementsOf(lock.model)];
  const statements: ComparisonDoc["statements"] = { added: [], removed: [], moved: [] };
  for (const [id, s] of sl) {
    const was = sb.get(id);
    if (was === undefined) statements.added.push(s);
    else if (was.placed !== s.placed) statements.moved.push({ ...s, was: was.placed });
  }
  for (const [id, s] of sb) if (!sl.has(id)) statements.removed.push(s);

  // The decisions each side rests on.
  const records = new Map(decisions.map((d) => [d.id, d]));
  const decision = (id: string): DecisionEntry => {
    const d = records.get(id);
    return { id, status: d?.status ?? "proposed", question: d?.question ?? "(no decision record)" };
  };
  const [db, dl] = [new Set(citedDecisions(base.model, base.rules)), new Set(citedDecisions(lock.model, lock.rules))];
  const coversOn = (d: DecisionRecord, name: string) => new Set(d.covers.filter((c) => inScope(c.locks, name)).map((c) => `${c.ir}\u0000${c.digest}`));
  const reread: ComparisonDoc["decisions"]["reread"] = [];
  for (const id of dl) {
    const d = records.get(id);
    if (!db.has(id) || d === undefined) continue;
    const [cb, cl] = [coversOn(d, base.lock.name), coversOn(d, lock.lock.name)];
    const differs = new Set([...cb].filter((c) => !cl.has(c)).concat([...cl].filter((c) => !cb.has(c))).map((c) => c.split("\u0000")[0]!));
    if (differs.size > 0) reread.push({ ...decision(id), elements: [...differs].sort() });
  }

  // The findings.
  const [lb, ll] = [new Map(base.lint.map((f) => [f.id, f])), new Map(lock.lint.map((f) => [f.id, f]))];
  const spec: ComparisonDoc["findings"]["spec"] = { added: [], removed: [], changed: [] };
  for (const [id, f] of ll) {
    const was = lb.get(id);
    if (was === undefined) spec.added.push(lintEntry(f));
    else if (lintContent(was) !== lintContent(f)) spec.changed.push({ ...lintEntry(f), was: was.message });
  }
  for (const [id, f] of lb) if (!ll.has(id)) spec.removed.push(lintEntry(f));

  const recordedFinding = (f: Failure, name: string) => input.recordedFindings.findings.find((r) => inScope(r.locks, name) && r.example === f.example && r.path === f.path && r.kind === f.kind);
  const exampleEntry = (f: Failure, name: string): ExampleEntry => {
    const r = recordedFinding(f, name);
    return { example: f.example, path: f.path, kind: f.kind, message: f.message, ...(r ? { decisions: r.decisions, reason: r.reason } : {}) };
  };
  const [fb, fl] = [new Set(base.failures.map(exampleKey)), new Set(lock.failures.map(exampleKey))];
  const examples = {
    added: lock.failures.filter((f) => !fb.has(exampleKey(f))).map((f) => exampleEntry(f, lock.lock.name)),
    removed: base.failures.filter((f) => !fl.has(exampleKey(f))).map((f) => exampleEntry(f, base.lock.name)),
  };

  const recordedDifference = (d: Difference, name: string) =>
    input.recordedDifferences.differences.find((r) => inScope(r.locks, name) && r.table === d.table && r.row === d.row && r.column === d.column);
  const differenceEntry = (d: Difference, name: string): DifferenceEntry => {
    const r = recordedDifference(d, name);
    return { table: d.table, row: d.row, column: d.column, spec: d.spec, model: d.model, ...(r ? { decision: r.decision, reason: r.reason } : {}) };
  };
  const [rb, rl] = [new Map(base.differences.map((d) => [differenceKey(d), d])), new Map(lock.differences.map((d) => [differenceKey(d), d]))];
  const roundTripFindings: ComparisonDoc["findings"]["round_trip"] = {
    added: lock.differences.filter((d) => !rb.has(differenceKey(d))).map((d) => differenceEntry(d, lock.lock.name)),
    removed: base.differences.filter((d) => !rl.has(differenceKey(d))).map((d) => differenceEntry(d, base.lock.name)),
    changed: lock.differences.flatMap((d) => {
      const was = rb.get(differenceKey(d));
      return was !== undefined && (was.spec !== d.spec || was.model !== d.model) ? [{ ...differenceEntry(d, lock.lock.name), was: { spec: was.spec, model: was.model } }] : [];
    }),
  };

  const [cb, cl] = [new Set(base.conditionsLeft), new Set(lock.conditionsLeft)];
  const conditions = { added: lock.conditionsLeft.filter((c) => !cb.has(c)), removed: base.conditionsLeft.filter((c) => !cl.has(c)) };

  const byId = by<{ id: string }>((x) => x.id);
  const byIr = by<{ ir: string }>((x) => x.ir);
  const byExample = by<ExampleEntry>((x) => exampleKey(x));
  const byDifference = by<DifferenceEntry>((x) => differenceKey(x));
  const viewRank = { model: 0, rules: 1, files: 2 } as const;
  return {
    format: 1,
    base: side(base, eb),
    lock: side(lock, el),
    elements: { added: elements.added.sort(byId), removed: elements.removed.sort(byId), changed: elements.changed.sort(byId) },
    changes: changes.sort((x, y) => viewRank[x.view] - viewRank[y.view] || cmp(x.type, y.type) || cmp(x.member ?? "", y.member ?? "") || cmp(x.change, y.change) || cmp(x.detail, y.detail)),
    statements: { added: statements.added.sort(byIr), removed: statements.removed.sort(byIr), moved: statements.moved.sort(byIr) },
    decisions: {
      added: [...dl].filter((d) => !db.has(d)).sort().map(decision),
      removed: [...db].filter((d) => !dl.has(d)).sort().map(decision),
      reread: reread.sort(byId),
    },
    findings: {
      spec: { added: spec.added.sort(byId), removed: spec.removed.sort(byId), changed: spec.changed.sort(byId) },
      examples: { added: examples.added.sort(byExample), removed: examples.removed.sort(byExample) },
      round_trip: { added: roundTripFindings.added.sort(byDifference), removed: roundTripFindings.removed.sort(byDifference), changed: roundTripFindings.changed.sort(byDifference) },
      conditions: { added: conditions.added.sort(), removed: conditions.removed.sort() },
    },
  };
}

export const renderComparison = (doc: ComparisonDoc): string => canonicalJson(doc);

// ---------------------------------------------------------------------------
// The markdown

/** A table cell: one line, pipes escaped. */
const cell = (s: string) => s.replace(/\s+/g, " ").trim().replaceAll("|", "\\|");
const code = (s: string) => `\`${s.replaceAll("`", "")}\``;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function table(header: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ["None.", ""];
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => ":---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`), ""];
}

const COUNT_LABELS: [string, string][] = [
  ["elements.field", "Field rows"],
  ["elements.key", "Key rows"],
  ["elements.definition", "Value definitions"],
  ["elements.value_list", "Value lists"],
  ["elements.inline_object", "Inline objects"],
  ["elements.statement", "RFC 2119 statements"],
  ["elements.sentence", "Other sentences that name an identifier"],
  ["elements.code_block", "Code blocks"],
  ["types.object", "Objects"],
  ["types.vocabulary", "Vocabularies"],
  ["types.union", "Unions"],
  ["types.copy", "Constructor copies"],
  ["types.document", "Documents"],
  ["types.profile", "Profiles"],
  ["properties", "Properties"],
  ["rules", "Rules, with vectors"],
  ["statements.obligation", "Obligations"],
  ["schema_files", "Schema files"],
  ["decisions", "Decisions cited"],
  ["findings.spec", "Spec lint findings"],
  ["findings.spec_open", "Spec lint findings without a verdict"],
  ["findings.examples", "Example findings"],
  ["findings.round_trip", "Round-trip differences"],
  ["findings.conditions", "Conditions left to the rules"],
];

/** The order the report lists element kinds in: the tables first, then the prose, then the appendices. */
const ELEMENT_KINDS: Element["kind"][] = ["field", "key", "definition", "marker", "concept", "value_list", "inline_object", "statement", "sentence", "identifier_list", "code_block", "appendix_a", "appendix_b"];

/** The report as markdown, for people to read. A function of the JSON form. */
export function renderComparisonMarkdown(doc: ComparisonDoc): string {
  const [b, l] = [doc.base, doc.lock];
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines);
  const classes = (view: string) => {
    const cs = doc.changes.filter((c) => c.view === view);
    return (["breaking", "additive", "annotation"] as const).map((k) => cs.filter((c) => c.class === k).length);
  };

  push(
    `# Lock comparison: \`${l.lock}\` against \`${b.lock}\``,
    "",
    `Generated by \`npm run compare\` from the pipeline's outputs on both locks; don't edit it. The data is in [\`${l.lock}.json\`](${l.lock}.json).`,
    "",
    "| Lock | Commit | Spec blob | IR SHA-256 |",
    "| :--- | :--- | :--- | :--- |",
    `| \`${b.lock}\` | \`${b.commit.slice(0, 7)}\` | \`${b.blob.slice(0, 8)}\` | \`${b.ir_sha256.slice(0, 12)}\` |`,
    `| \`${l.lock}\` | \`${l.commit.slice(0, 7)}\` | \`${l.blob.slice(0, 8)}\` | \`${l.ir_sha256.slice(0, 12)}\` |`,
    "",
    "## Summary",
    "",
  );
  const [m, r, f] = [classes("model"), classes("rules"), classes("files")];
  push(
    `- **Specification:** ${plural(doc.elements.added.length, "element")} added, ${doc.elements.removed.length} removed, and ${doc.elements.changed.length} changed.`,
    `- **Schema changes,** as the release differ classes them from \`${b.lock}\` to \`${l.lock}\`: in the model, ${m[0]} breaking, ${m[1]} additive, and ${m[2]} annotation; in the rules, ${r[0]}, ${r[1]}, and ${r[2]}; in the schema files, ${f[0]}, ${f[1]}, and ${f[2]}.`,
    `- **Statements:** ${doc.statements.added.length} placed that \`${b.lock}\` lacks, ${doc.statements.removed.length} gone, and ${doc.statements.moved.length} placed elsewhere.`,
    `- **Decisions:** ${doc.decisions.added.length} cited only with \`${l.lock}\`, ${doc.decisions.removed.length} only on \`${b.lock}\`, and ${doc.decisions.reread.length} cited on both whose covered text differs.`,
    `- **Findings:** spec lint ${doc.findings.spec.added.length} added, ${doc.findings.spec.removed.length} removed, ${doc.findings.spec.changed.length} changed; examples ${doc.findings.examples.added.length} added, ${doc.findings.examples.removed.length} removed; round trip ${doc.findings.round_trip.added.length} added, ${doc.findings.round_trip.removed.length} removed, ${doc.findings.round_trip.changed.length} changed; conditions left to the rules ${doc.findings.conditions.added.length} added, ${doc.findings.conditions.removed.length} removed.`,
    "",
  );
  push(...table([" ", code(b.lock), code(l.lock), "Change"], COUNT_LABELS.map(([k, label]) => {
    const [x, y] = [b.counts[k] ?? 0, l.counts[k] ?? 0];
    return [label, String(x), String(y), y === x ? "" : y > x ? `+${y - x}` : `${y - x}`];
  })));

  const kinds = (es: ElementEntry[]) => ELEMENT_KINDS.filter((k) => es.some((e) => e.kind === k));
  push("## Specification elements", "", `Elements by IR ID. An element is changed when its digest differs: a table row's source bytes, or any other element's content.`, "");
  push(`### Added (${doc.elements.added.length})`, "");
  for (const k of kinds(doc.elements.added)) {
    const es = doc.elements.added.filter((e) => e.kind === k);
    push(`#### ${k} (${es.length})`, "", ...table(["ID", "Text"], es.map((e) => [code(e.id), e.text])));
  }
  push(`### Removed (${doc.elements.removed.length})`, "", ...table(["ID", "Kind", "Text"], doc.elements.removed.map((e) => [code(e.id), e.kind, e.text])));
  push(`### Changed (${doc.elements.changed.length})`, "", ...table(["ID", "Kind", `On \`${b.lock}\``, `With \`${l.lock}\``], doc.elements.changed.map((e) => [code(e.id), e.kind, e.was, e.text])));

  push(
    "## Schema changes",
    "",
    `The release differ (\`src/release.ts\`) run as if \`${l.lock}\` were the next release after \`${b.lock}\`. \`breaking\`: a payload valid on \`${b.lock}\` may be invalid with \`${l.lock}\`. \`additive\`: it accepts or defines more. \`annotation\`: only prose changes. Each view lists a change it shows, so one change can appear in more than one view.`,
    "",
  );
  for (const [view, title] of [["model", "Model"], ["rules", "Rules"], ["files", "Schema files"]] as const) {
    const cs = doc.changes.filter((c) => c.view === view);
    push(`### ${title} (${cs.length})`, "");
    for (const k of ["breaking", "additive", "annotation"] as const) {
      const ck = cs.filter((c) => c.class === k);
      if (ck.length === 0) continue;
      push(`#### ${k} (${ck.length})`, "", ...table(["Type", "Member", "Change", "Detail"], ck.map((c) => [code(c.type), c.member !== undefined ? code(c.member) : "", c.change, c.detail])));
    }
    if (cs.length === 0) push("None.", "");
  }

  push("## Statements", "", "Where the model places each statement: a rule on its owner, an obligation on a party, a statement a type's schema expresses, or an example of an object.", "");
  push(`### Added (${doc.statements.added.length})`, "", ...table(["IR", "Level", "Placed", "Text"], doc.statements.added.map((s) => [code(s.ir), s.level ?? "", s.placed, s.text])));
  push(`### Removed (${doc.statements.removed.length})`, "", ...table(["IR", "Level", "Placed", "Text"], doc.statements.removed.map((s) => [code(s.ir), s.level ?? "", s.placed, s.text])));
  push(`### Placed elsewhere (${doc.statements.moved.length})`, "", ...table(["IR", `On \`${b.lock}\``, `With \`${l.lock}\``, "Text"], doc.statements.moved.map((s) => [code(s.ir), s.was, s.placed, s.text])));

  push("## Decisions", "", "The decision records each lock's model and rules cite.", "");
  push(`### Cited only with \`${l.lock}\` (${doc.decisions.added.length})`, "", ...table(["Decision", "Status", "Question"], doc.decisions.added.map((d) => [d.id, d.status, d.question])));
  push(`### Cited only on \`${b.lock}\` (${doc.decisions.removed.length})`, "", ...table(["Decision", "Status", "Question"], doc.decisions.removed.map((d) => [d.id, d.status, d.question])));
  push(
    `### Cited on both, over text that differs (${doc.decisions.reread.length})`,
    "",
    "The decision covers an element that differs between the locks, one that only one lock has or whose text differs, so it quotes that element once per lock.",
    "",
    ...table(["Decision", "Status", "Elements", "Question"], doc.decisions.reread.map((d) => [d.id, d.status, d.elements.map(code).join(", "), d.question])),
  );

  push("## Findings", "");
  const spec = doc.findings.spec;
  push(`### Spec lint, added (${spec.added.length})`, "", ...table(["Finding", "Verdict", "Message"], spec.added.map((x) => [code(x.id), x.verdict, x.message])));
  push(`### Spec lint, removed (${spec.removed.length})`, "", ...table(["Finding", "Verdict", "Message"], spec.removed.map((x) => [code(x.id), x.verdict, x.message])));
  push(`### Spec lint, changed (${spec.changed.length})`, "", ...table(["Finding", "Verdict", `On \`${b.lock}\``, `With \`${l.lock}\``], spec.changed.map((x) => [code(x.id), x.verdict, x.was, x.message])));
  const exRows = (xs: ExampleEntry[]) => xs.map((x) => [code(x.example), code(x.path === "" ? "/" : x.path), x.kind, (x.decisions ?? []).join(", "), x.reason ?? x.message]);
  push(`### Examples, added (${doc.findings.examples.added.length})`, "", ...table(["Example", "Location", "Kind", "Decision", "Reason"], exRows(doc.findings.examples.added)));
  push(`### Examples, removed (${doc.findings.examples.removed.length})`, "", ...table(["Example", "Location", "Kind", "Decision", "Reason"], exRows(doc.findings.examples.removed)));
  const rtRows = (xs: DifferenceEntry[]) => xs.map((x) => [x.table, x.row, x.column, x.spec, x.model, x.decision ?? ""]);
  push(`### Round trip, added (${doc.findings.round_trip.added.length})`, "", ...table(["Table", "Row", "Column", "Specification", "Model", "Decision"], rtRows(doc.findings.round_trip.added)));
  push(`### Round trip, removed (${doc.findings.round_trip.removed.length})`, "", ...table(["Table", "Row", "Column", "Specification", "Model", "Decision"], rtRows(doc.findings.round_trip.removed)));
  push(
    `### Round trip, changed (${doc.findings.round_trip.changed.length})`,
    "",
    "A difference at the same cell on both locks, whose text changes.",
    "",
    ...table(["Table", "Row", "Column", `On \`${b.lock}\``, `With \`${l.lock}\``, "Decision"], doc.findings.round_trip.changed.map((x) => [x.table, x.row, x.column, `specification "${x.was.spec}", model "${x.was.model}"`, `specification "${x.spec}", model "${x.model}"`, x.decision ?? ""])),
  );
  push(`### Conditions left to the rules, added (${doc.findings.conditions.added.length})`, "", ...table(["Condition"], doc.findings.conditions.added.map((c) => [c])));
  push(`### Conditions left to the rules, removed (${doc.findings.conditions.removed.length})`, "", ...table(["Condition"], doc.findings.conditions.removed.map((c) => [c])));

  while (out.at(-1) === "") out.pop();
  return `${out.join("\n")}\n`;
}
