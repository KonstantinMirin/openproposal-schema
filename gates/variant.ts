/**
 * The gates of the schema variants (src/variant.ts): each variant file is
 * schema-valid, switches every departure off once with an option its record
 * lists, adds primitives whose vectors hold, differs from the schemas we
 * propose only where a switch says, and fails on the specification's
 * examples only as the gaps' findings and its switches' own findings say.
 * The variant's schemas, rules, type examples, and SDK types are held to the
 * same output gates as the schemas we propose, which `scripts/ci.ts` runs on
 * the variant's build.
 */
import type { EmittedFile } from "../src/emit.ts";
import { checkExamples, type FindingsFile, type Loaded, type ModelExample } from "../src/examples.ts";
import { checkKernel, type Kernel } from "../src/kernel.ts";
import type { DecisionRecord, MappingFile } from "../src/mapping.ts";
import type { ModelDoc, ModelType } from "../src/model.ts";
import { checkVariant, checkVariantDiff, checkVariantExamples, loadVariantFile, type Variant } from "../src/variant.ts";
import { defineGate, ROOT } from "./harness.ts";
import type { Check } from "../src/rule-checks.ts";

export const variantLoad = defineGate<{ file: string; name: string }>({
  id: "variant-load",
  title: "variants: each variant file is schema-valid and named after its file",
  code: ["src/variant.ts#loadVariantFile"],
  files: ["variants/variant.schema.json"],
  check: (i) => {
    const v = loadVariantFile(i.file, i.name);
    return { problems: [], note: `${v.name}: ${v.switches.length} switches, ${v.primitives.length} primitives` };
  },
  fixtures: [{ name: "a switch that names no option", mutate: (i) => ({ ...i, file: `${ROOT}/gates/data/variant-load/as-written.yaml` }), expect: "not a valid variant file" }],
});

const withSwitch = (v: Variant, decision: string, f: (s: Variant["switches"][number]) => Variant["switches"][number] | null): Variant => ({
  ...v,
  switches: v.switches.flatMap((s) => (s.decision === decision ? ((x) => (x === null ? [] : [x]))(f(s)) : [s])),
});

export const variantCheck = defineGate<{ variant: Variant; decisions: DecisionRecord[]; kernel: Kernel; mappings: MappingFile[] }>({
  id: "variant-check",
  title: (i) => `${i.variant.name}: every departure is switched off once, by an option its record lists and doesn't choose, each change is one its departure makes, and the variant's primitives hold their vectors`,
  code: ["src/variant.ts#checkVariant", "src/kernel.ts#checkKernel"],
  check: (i) => ({
    problems: [...checkVariant(i.variant, i.decisions, i.kernel, i.mappings), ...checkKernel(ROOT, { ...i.kernel, primitives: i.variant.primitives, file: i.variant.file }, i.decisions)],
    note: `${i.variant.switches.length} departures switched off: ${i.variant.switches.map((s) => `${s.decision} as ${s.option}`).join(", ")}`,
  }),
  fixtures: [
    { name: "a switch that takes the chosen option", mutate: (i) => ({ ...i, variant: withSwitch(i.variant, "D-040", (s) => ({ ...s, option: "duration" })) }), expect: 'takes "duration", the option the schemas we propose take' },
    { name: "a departure with no switch", mutate: (i) => ({ ...i, variant: withSwitch(i.variant, "D-042", () => null) }), expect: "departure D-042 has 0 switches" },
    {
      name: "a retype of an element the departure doesn't cover",
      mutate: (i) => ({ ...i, variant: withSwitch(i.variant, "D-042", (s) => ({ ...s, retype: [{ ir: "key:5.6.1:commitment.amount", from: "Amount", to: "CalendarDate" }] })) }),
      expect: 'retypes "key:5.6.1:commitment.amount", which D-042 doesn\'t cover',
    },
    { name: "a replaced type the departure doesn't introduce", mutate: (i) => ({ ...i, variant: withSwitch(i.variant, "D-037", (s) => ({ ...s, replace: [...(s.replace ?? []), { type: "Timestamp", with: "Identifier" }] })) }), expect: 'replaces "Timestamp", which D-037 doesn\'t introduce' },
    {
      name: "a variant primitive's valid vector its constraints reject",
      mutate: (i) => ({ ...i, variant: { ...i.variant, primitives: i.variant.primitives.map((p) => (p.name === "CalendarDate" ? { ...p, vectors: { ...p.vectors, valid: [...p.vectors.valid, "2026-02-30"] } } : p)) } }),
      expect: 'valid vector "2026-02-30"',
    },
  ],
});

const withProperty = (m: ModelDoc, type: string, member: string, f: (p: ModelType & { properties: Record<string, unknown> }) => ModelType): ModelDoc => ({
  ...m,
  types: m.types.map((t) => (t.name === type && "properties" in t && member in t.properties ? f(t as ModelType & { properties: Record<string, unknown> }) : t)),
});

export const variantDiff = defineGate<{ variant: Variant; proposed: ModelDoc; written: ModelDoc; decisions: DecisionRecord[]; lock: string; problems: string[] }>({
  id: "variant-diff",
  title: "variant: the model resolves, and differs from the proposed one only where a switch says",
  code: ["src/variant.ts#applyVariant", "src/variant.ts#checkVariantDiff", "src/builds.ts#resolveBuild"],
  check: (i) => {
    const r = checkVariantDiff(i.variant, i.proposed, i.written, i.decisions, i.lock);
    const by = new Map<string, number>();
    for (const d of r.differences) by.set(d.change, (by.get(d.change) ?? 0) + 1);
    return { problems: [...i.problems, ...r.problems], note: `${r.differences.length} differences, each a switch's: ${[...by].map(([k, n]) => `${n} ${k}`).join(", ")}` };
  },
  fixtures: [
    {
      name: "a property the variant retypes with no switch",
      mutate: (i) => ({ ...i, written: withProperty(i.written, "LineItem", "channel", (t) => ({ ...t, properties: { ...t.properties, channel: { ...(t.properties.channel as object), type: { kind: "named", name: "Text" } } } }) as unknown as ModelType) }),
      expect: '"LineItem.channel" differs in a way no switch says',
    },
    { name: "a type the variant drops with no switch", mutate: (i) => ({ ...i, written: { ...i.written, types: i.written.types.filter((t) => t.name !== "Timestamp") } }), expect: 'the variant drops "Timestamp", which no switch replaces' },
    {
      name: "a member the variant drops from an option no switch withholds it from",
      mutate: (i) => ({ ...i, written: withProperty(i.written, "PropertiesOption", "id", (t) => ({ ...t, properties: Object.fromEntries(Object.entries(t.properties).filter(([k]) => k !== "id")) }) as ModelType) }),
      expect: 'the variant drops "PropertiesOption.id", which no switch withholds',
    },
  ],
});

export interface VariantExamplesInput {
  model: ModelDoc;
  files: EmittedFile[];
  schemaDir: string;
  examples: ModelExample[];
  values: Map<string, Loaded>;
  codes: ReadonlyMap<string, ReadonlySet<string | number>>;
  /** Every check a rule of the lock may have: the kernel's, the constructors', and the spec's (`checksOf`). */
  ruleChecks: Readonly<Record<string, Check>>;
  variant: Variant;
  recorded: FindingsFile;
  lock: string;
  decisions: DecisionRecord[];
}

export const variantExamples = defineGate<VariantExamplesInput>({
  id: "variant-examples",
  title: "variant: the specification's examples fail only where a gap's recorded finding or a switch's own finding says, and every one of those still fails",
  code: ["src/examples.ts#checkExamples", "src/variant.ts#checkVariantExamples", "src/rule-checks.ts#CHECKS", "src/specs/index.ts#PLUGINS"],
  exemptions: ["specs/*/examples/findings.yaml", "specs/*/variants/*.yaml#findings"],
  check: (i) => {
    const r = checkExamples(i);
    const v = checkVariantExamples(r.failures, r.checks.undecided, i.variant, i.recorded, i.lock, i.decisions);
    const c = v.counts;
    return { problems: [...r.problems, ...v.problems], note: `${c.failures} failures at ${c.places} places: ${c.gap} a gap's, ${c.departure} a switch's; ${r.checks.undecided.length} undecided` };
  },
  fixtures: [
    { name: "a switch's finding removed", mutate: (i) => ({ ...i, variant: withSwitch(i.variant, "D-047", (s) => ({ ...s, findings: (s.findings ?? []).slice(1) })) }), expect: "list it under the switch whose departure causes it" },
    {
      name: "a switch's finding that no longer fails",
      mutate: (i) => ({ ...i, variant: withSwitch(i.variant, "D-047", (s) => ({ ...s, findings: [...(s.findings ?? []), { example: "examples/line-item-display.yaml", path: "/name", kind: "invalid", value: "x", reason: "A finding that never occurs." }] })) }),
      expect: "which no longer fails",
    },
    {
      name: "a gap's recorded finding removed",
      mutate: (i) => ({ ...i, recorded: { ...i.recorded, findings: i.recorded.findings.filter((f) => f.path !== "/materials_due") } }),
      expect: "it is no recorded gap finding",
    },
  ],
});
