/**
 * The variant report: how a variant of the schemas (src/variant.ts) differs
 * from the schemas we propose on each lock, and how many of the
 * specification's example failures each has. `npm run compare` writes it to
 * `comparison/<variant>.json`, canonical JSON, and `comparison/<variant>.md`,
 * rendered from it.
 */
import { canonicalJson } from "./canonical.ts";
import { resolveBuild, variantNames } from "./builds.ts";
import type { BuildInput, LockBuild } from "./compare.ts";
import { emitSchemas, schemaDirOf } from "./emit.ts";
import { checkExamples, lockExamples, type Failure, type FindingsFile } from "./examples.ts";
import type { SpecLock } from "./lock.ts";
import type { DecisionRecord } from "./mapping.ts";
import { codesOf } from "./rule-checks.ts";
import { emitRules } from "./rules.ts";
import { checkVariantDiff, checkVariantExamples, loadVariant, type Variant, type VariantDifference, type VariantExampleCounts } from "./variant.ts";
import { ruleChecksOf, schemaNamesOfLock } from "./specs/index.ts";

/** One lock's build under a variant: its failures, its differences from the proposed build, and the problems of either. */
export interface VariantLockBuild {
  lock: SpecLock;
  counts: VariantExampleCounts;
  differences: VariantDifference[];
  problems: string[];
}

/** Builds one lock under a variant, from the lock's proposed build, and checks its differences and its example failures. */
export async function buildVariantLock(base: LockBuild, variant: Variant, input: BuildInput, recorded: FindingsFile): Promise<VariantLockBuild> {
  const { lock } = base;
  const b = resolveBuild({ lock, root: input.root, mappings: input.mappings, decisions: input.decisions, kernel: input.kernel, constructors: input.constructors, variant, ir: base.ir });
  const empty = { failures: 0, places: 0, gap: 0, departure: 0 };
  if (b.problems.length > 0) return { lock, counts: empty, differences: [], problems: b.problems.map((p) => `model: ${p}`) };
  const diff = checkVariantDiff(variant, base.model, b.model, input.decisions, lock.name);
  const schemaDir = b.dirOf(schemaDirOf(lock.ir_dir));
  const emitted = emitSchemas(b.model, schemaDir, schemaNamesOfLock(lock));
  if (emitted.problems.length > 0) return { lock, counts: empty, differences: [], problems: emitted.problems.map((p) => `schemas: ${p}`) };
  const converted = b.vectors(input.vectors);
  const rules = emitRules({ model: b.model, ir: b.ir, lock: lock.name, vectors: converted.vectors, decisions: input.decisions, schemaDir, conditionsLeft: emitted.conditions.left, schemaBase: schemaNamesOfLock(lock).base });
  const got = await lockExamples(lock, b.model);
  const ex = checkExamples({ model: b.model, files: emitted.files, schemaDir, examples: got.examples, values: got.values, codes: codesOf(b.kernel.lists ?? { lists: [] }), ruleChecks: ruleChecksOf(lock) });
  const checked = checkVariantExamples(ex.failures, ex.checks.undecided, variant, recorded, lock.name, input.decisions);
  return {
    lock,
    counts: checked.counts,
    differences: diff.differences,
    problems: [...diff.problems, ...converted.problems, ...rules.problems.map((p) => `rules: ${p}`), ...ex.problems.map((p) => `examples: ${p}`), ...checked.problems],
  };
}

/** A lock's example failures in the schemas we propose, counted as a variant's are: those whose recorded causes are all gaps, and the rest. */
export function proposedCounts(failures: Failure[], recorded: FindingsFile, lock: string, decisions: DecisionRecord[]): VariantExampleCounts {
  const kind = new Map(decisions.map((d) => [d.id, d.kind]));
  const key = (f: { example: string; path: string; kind: string; rule?: string }) => `${f.example} ${f.path} ${f.kind} ${f.rule ?? ""}`;
  const gaps = new Set(recorded.findings.filter((f) => (f.locks === undefined || f.locks.includes(lock)) && f.decisions.every((d) => kind.get(d) === "gap")).map(key));
  const gap = failures.filter((f) => gaps.has(key(f))).length;
  return { failures: failures.length, places: new Set(failures.map((f) => `${f.example} ${f.path}`)).size, gap, departure: failures.length - gap };
}

export interface VariantReport {
  format: 1;
  variant: string;
  description: string;
  switches: { decision: string; question: string; option: string; written: string; chosen: string; proposed: string; reads: string }[];
  locks: {
    name: string;
    commit: string;
    examples: { proposed: VariantExampleCounts; variant: VariantExampleCounts };
    differences: VariantDifference[];
  }[];
}

export function buildVariantReport(variant: Variant, decisions: DecisionRecord[], locks: { base: LockBuild; built: VariantLockBuild; proposed: VariantExampleCounts }[]): VariantReport {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const summary = (d: DecisionRecord, id: string) => d.options.find((o) => o.id === id)?.summary ?? "";
  return {
    format: 1,
    variant: variant.name,
    description: variant.description.trim(),
    switches: [...variant.switches]
      .sort((a, b) => (a.decision < b.decision ? -1 : 1))
      .map((s) => {
        const d = byId.get(s.decision)!;
        return { decision: s.decision, question: d.question, option: s.option, written: summary(d, s.option), chosen: d.chosen, proposed: summary(d, d.chosen), reads: s.reads.trim() };
      }),
    locks: locks.map(({ base, built, proposed }) => ({ name: base.lock.name, commit: base.lock.commit, examples: { proposed, variant: built.counts }, differences: built.differences })),
  };
}

export const renderVariantReport = (doc: VariantReport): string => canonicalJson(doc);

/** The report as Markdown, for a reader. */
export function renderVariantReportMarkdown(doc: VariantReport): string {
  const out: string[] = [
    `<!-- Generated by \`npm run compare\` from the variant file variants/${doc.variant}.yaml. Do not edit. -->`,
    "",
    `# The ${doc.variant} variant`,
    "",
    doc.description,
    "",
    "## The specification's example failures",
    "",
    "A failure is one location in one example. A gap's failure, where an example disagrees with the text, fails in both variants.",
    "",
    "| Lock | Variant | Failures | Places | A gap's | A departure's |",
    "|---|---|---|---|---|---|",
  ];
  for (const l of doc.locks) {
    const row = (name: string, c: VariantExampleCounts) => `| \`${l.name}\` | ${name} | ${c.failures} | ${c.places} | ${c.gap} | ${c.departure} |`;
    out.push(row("proposed", l.examples.proposed), row(doc.variant, l.examples.variant));
  }
  out.push("", "## The switches", "");
  for (const s of doc.switches) {
    out.push(`### ${s.decision}: ${s.question}`, "", `- Proposed (\`${s.chosen}\`): ${s.proposed}`, `- ${doc.variant} (\`${s.option}\`): ${s.written}`, "", s.reads, "");
    for (const l of doc.locks) {
      const ds = l.differences.filter((d) => d.decision === s.decision);
      if (ds.length === 0) continue;
      out.push(`On \`${l.name}\`:`, "", "| Type | Member | Change | Proposed | " + doc.variant + " |", "|---|---|---|---|---|");
      for (const d of ds) out.push(`| \`${d.type}\` | ${d.member ? `\`${d.member}\`` : ""} | ${d.change} | \`${d.from}\` | ${d.to ? `\`${d.to}\`` : ""} |`);
      out.push("");
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/** Every variant's report over the locks' proposed builds, as the files `npm run compare` writes, by name under `comparison/`. */
export async function variantReportFiles(builds: LockBuild[], input: BuildInput, recorded: FindingsFile): Promise<{ files: Map<string, string>; reports: VariantReport[]; problems: string[] }> {
  const files = new Map<string, string>();
  const reports: VariantReport[] = [];
  const problems: string[] = [];
  for (const name of variantNames(input.root)) {
    const variant = loadVariant(input.root, name);
    const locks = [];
    for (const base of builds) {
      const built = await buildVariantLock(base, variant, input, recorded);
      for (const p of built.problems) problems.push(`${base.lock.name} (${name}): ${p}`);
      locks.push({ base, built, proposed: proposedCounts(base.failures, recorded, base.lock.name, input.decisions) });
    }
    const doc = buildVariantReport(variant, input.decisions, locks);
    reports.push(doc);
    files.set(`${name}.json`, renderVariantReport(doc));
    files.set(`${name}.md`, renderVariantReportMarkdown(doc));
  }
  return { files, reports, problems };
}
