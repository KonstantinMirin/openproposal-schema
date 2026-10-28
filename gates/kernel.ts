/** The gates on the kernel: the primitives, the constructors and their parts, the value domains, and the duplication gate over every kernel type and copy. */
import { checkApplied, checkConstructors, checkConstructorSources, checkMappingConstructors, checkNesting, copyStructures, loadConstructors, partStructures, typeUses, type Constructors, type Model } from "../src/constructors.ts";
import { checkDomains, checkDomainSources, sharedStructures, type Domains, type KernelType } from "../src/domains.ts";
import { checkDuplication } from "../src/duplication.ts";
import { checkKernelEngines, ORACLE_GAPS, type OracleGaps } from "../src/engines.ts";
import type { SpecIR } from "../src/ir-types.ts";
import { checkKernel, checkKernelNames, checkKernelSources, kernelStructures, loadKernel, type Kernel, type Primitive } from "../src/kernel.ts";
import type { DecisionRecord, MappingFile } from "../src/mapping.ts";
import { defineGate, ROOT } from "./harness.ts";

const withPrimitive = (k: Kernel, name: string, change: (p: Primitive) => Primitive): Kernel => ({ ...k, primitives: k.primitives.map((p) => (p.name === name ? change(p) : p)) });

export const kernelLoad = defineGate<{ spec: string | null; file?: string }>({
  id: "kernel-load",
  title: "kernel: schema-valid",
  code: ["src/kernel.ts#loadKernel"],
  check: (i) => {
    const k = loadKernel(ROOT, i.spec, i.file);
    return { problems: [], note: `${k.primitives.length} primitives, ${k.primitives.reduce((n, p) => n + (p.rules?.length ?? 0), 0)} rules` };
  },
  fixtures: [
    { name: "a primitive with no vectors", mutate: () => ({ spec: null, file: `${ROOT}/gates/data/kernel-load/primitives.yaml` }), expect: "not a valid kernel file" },
    // A kernel file keeps the definitions, and a spec's binding what rests on the spec.
    { name: "a kernel file that cites a spec's element", mutate: (i) => ({ ...i, file: `${ROOT}/gates/data/kernel-load/bound/primitives.yaml` }), expect: "which rest on a spec; a spec's kernel binding gives them" },
    { name: "a binding that gives a primitive's constraints", mutate: (i) => ({ ...i, spec: `${ROOT}/gates/data/kernel-load/defining` }), expect: "which the kernel defines for every spec" },
    { name: "a binding for a primitive the kernel doesn't define", mutate: (i) => ({ ...i, spec: `${ROOT}/gates/data/kernel-load/undefined` }), expect: 'the binding names "NoSuchType", which the kernel doesn\'t define' },
  ],
});

export const kernelCheck = defineGate<{ kernel: Kernel; decisions: DecisionRecord[] }>({
  id: "kernel-check",
  title: "kernel: patterns lint clean, Ajv verdicts hold, showcase values are valid, sources and decisions exist, and a list published outside git stays verifiable",
  code: ["src/kernel.ts#checkKernel", "src/list-copies.ts#checkListCopies"],
  check: (i) => ({ problems: checkKernel(ROOT, i.kernel, i.decisions) }),
  fixtures: [
    { name: "a valid vector the schema rejects", mutate: (i) => ({ ...i, kernel: withPrimitive(i.kernel, "Uuid", (p) => ({ ...p, vectors: { ...p.vectors, valid: [...p.vectors.valid, "not-a-uuid"] } })) }), expect: '"not-a-uuid"' },
    { name: "a showcase value the schema rejects", mutate: (i) => ({ ...i, kernel: withPrimitive(i.kernel, "Amount", (p) => ({ ...p, showcase: [-18.5] })) }), expect: "Amount: showcase value -18.5 is rejected by the constraint set" },
    { name: "a showcase currency ISO 4217 doesn't assign", mutate: (i) => ({ ...i, kernel: withPrimitive(i.kernel, "CurrencyCode", (p) => ({ ...p, showcase: ["ABC"] })) }), expect: 'CurrencyCode: showcase value "ABC" breaks rule "kernel:CurrencyCode:assigned"' },
    { name: "a decision that doesn't exist", mutate: (i) => ({ ...i, kernel: withPrimitive(i.kernel, "Uuid", (p) => ({ ...p, decision: "D-999" })) }), expect: "D-999" },
    {
      name: "ISO 4217 pinned by an unversioned URL with no copy, as a review found",
      mutate: (i) => ({ ...i, kernel: { ...i.kernel, lists: { ...i.kernel.lists!, lists: i.kernel.lists!.lists.map((l) => (l.name === "ISO 4217" ? { ...l, copy: undefined } : l)) } } }),
      expect: "ISO 4217: the URL names no version, so it serves only the keeper's latest file",
    },
    {
      name: "a currency code the copy of List One holds dropped from the list",
      mutate: (i) => ({ ...i, kernel: { ...i.kernel, lists: { ...i.kernel.lists!, lists: i.kernel.lists!.lists.map((l) => (l.name === "ISO 4217" ? { ...l, codes: l.codes.filter((c) => c.code !== "USD") } : l)) } } }),
      expect: "ISO 4217: its copy lists USD, which the list doesn't",
    },
    {
      name: "a copy whose SHA-256 isn't the list's",
      mutate: (i) => ({ ...i, kernel: { ...i.kernel, lists: { ...i.kernel.lists!, lists: i.kernel.lists!.lists.map((l) => (l.name === "ISO 4217" ? { ...l, sha256: "0".repeat(64) } : l)) } } }),
      expect: `not the list's ${"0".repeat(64)}`,
    },
  ],
});

export const kernelEngines = defineGate<{ kernel: Kernel; gaps: OracleGaps }>({
  id: "kernel-engines",
  title: "kernel: patterns agree in ECMA-262, RE2, and Python; the oracle gives the stated verdicts, or a listed gap says why not",
  code: ["src/engines.ts#checkKernelEngines", "src/engines.ts#loadOracleGaps"],
  exemptions: [ORACLE_GAPS],
  check: (i) => checkKernelEngines(ROOT, i.kernel, undefined, i.gaps),
  fixtures: [
    {
      name: "the oracle's leap-second gap no longer listed",
      mutate: (i) => ({ ...i, gaps: { ...i.gaps, gaps: i.gaps.gaps.filter((g) => !g.vectors.some((x) => x.value === "2016-12-31T23:59:60Z")) } }),
      expect: 'Timestamp: valid vector "2016-12-31T23:59:60Z": the oracle rejects it, and no gap in tools/oracle/gaps.yaml lists it',
    },
    {
      name: "a gap listed for a vector the oracle gives its verdict",
      mutate: (i) => ({ ...i, gaps: { ...i.gaps, gaps: [...i.gaps.gaps, { id: "OG-99", reason: "A fixture.", vectors: [{ primitive: "Timestamp", value: "2026-10-25T09:00:00Z", oracle: "rejects" }] }] } }),
      expect: 'OG-99: the oracle no longer rejects Timestamp "2026-10-25T09:00:00Z" against its stated verdict, or no vector states it; remove it',
    },
    {
      name: "a gaps file written for another rfc3339-validator",
      mutate: (i) => ({ ...i, gaps: { ...i.gaps, oracle: "jsonschema 4.26.0, rfc3339-validator 0.1.3" } }),
      expect: "written for rfc3339-validator 0.1.3, but tools/oracle/requirements.txt pins 0.1.4",
    },
    {
      name: "a pattern Python reads as multi-line text",
      mutate: (i) => ({ ...i, kernel: withPrimitive(i.kernel, "CurrencyCode", (p) => ({ ...p, constraints: { ...p.constraints, pattern: "^[A-Z]{3}$" }, vectors: { valid: ["USD"], invalid: ["USD\n"] } })) }),
      expect: "USD\\n",
    },
  ],
});

export const kernelSources = defineGate<{ ir: SpecIR; lock: string; kernel: Kernel }>({
  id: "kernel-sources",
  title: "kernel spec sources current",
  code: ["src/kernel.ts#checkKernelSources"],
  check: (i) => ({ problems: checkKernelSources(i.ir, i.lock, i.kernel) }),
  fixtures: [
    {
      name: "a stale digest",
      mutate: (i) => ({ ...i, kernel: withPrimitive(i.kernel, "Uuid", (p) => ({ ...p, sources: { ...p.sources, spec: p.sources.spec!.map((s, n) => (n === 0 ? { ...s, digest: "0".repeat(64) } : s)) } })) }),
      expect: "field:4.1:proposal_id",
    },
    {
      // Each spec's binding cites its own text: an element of another spec, here the widgets fixture's (test/fixtures/specs/widgets), is no element of this one.
      name: "a binding that cites an element of another spec",
      mutate: (i) => ({ ...i, kernel: withPrimitive(i.kernel, "ExternalId", (p) => ({ ...p, sources: { ...p.sources, spec: [...(p.sources.spec ?? []), { ir: "key:1.1:widget.id", digest: "0".repeat(64), quote: "`id` | REQUIRED | The widget's ID, which the catalog assigns." }] } })) }),
      expect: 'no IR element "key:1.1:widget.id"',
    },
  ],
});

export const constructorsLoad = defineGate<{ spec: string | null; file?: string }>({
  id: "constructors-load",
  title: "constructors: schema-valid",
  code: ["src/constructors.ts#loadConstructors"],
  check: (i) => {
    const c = loadConstructors(ROOT, i.spec, i.file);
    return { problems: [], note: `${c.constructors.length} constructors, ${c.parts.length} parts, ${c.constructors.reduce((n, x) => n + (x.rules?.length ?? 0), 0)} rules` };
  },
  fixtures: [{ name: "a constructor with no shell", mutate: () => ({ spec: null, file: `${ROOT}/gates/data/constructors-load/constructors.yaml` }), expect: "not a valid constructors file" }],
});

export const constructorsCheck = defineGate<{ model: Model; decisions: DecisionRecord[] }>({
  id: "constructors-check",
  title: "constructors: templates sound, Ajv verdicts hold, sources and decisions exist",
  code: ["src/constructors.ts#checkConstructors"],
  check: (i) => ({ problems: checkConstructors(ROOT, i.model, i.decisions) }),
  fixtures: [
    {
      name: "a slot that names a type nobody defines",
      mutate: (i) => {
        const c = i.model.constructors;
        const parts = c.parts.map((p, n) => (n === 0 ? { ...p, shell: JSON.parse(JSON.stringify(p.shell).replace(/"\$model":\{"kind":"named","name":"[A-Za-z]+"\}/, '"$model":{"kind":"named","name":"NoSuchType"}')) } : p));
        return { ...i, model: { ...i.model, constructors: { ...c, parts } } };
      },
      expect: "NoSuchType",
    },
  ],
});

export const constructorSources = defineGate<{ ir: SpecIR; lock: string; constructors: Constructors }>({
  id: "constructor-sources",
  title: "each constructor cites its spec rows, current",
  code: ["src/constructors.ts#checkConstructorSources"],
  check: (i) => ({ problems: checkConstructorSources(i.ir, i.lock, i.constructors) }),
  fixtures: [
    {
      name: "a stale digest",
      mutate: (i) => ({
        ...i,
        constructors: { ...i.constructors, constructors: i.constructors.constructors.map((c, n) => (n === 0 ? { ...c, sources: { ...c.sources, spec: c.sources.spec.map((s) => ({ ...s, digest: "0".repeat(64) })) } } : c)) },
      }),
      expect: "stale",
    },
  ],
});

export const nesting = defineGate<{ model: Model; mappings: MappingFile[] }>({
  id: "nesting",
  title: "nesting: no constructor nests inside itself, in a template or in the mapping",
  code: ["src/constructors.ts#checkNesting"],
  check: (i) => ({ problems: checkNesting(i.model, i.mappings), note: `${i.model.constructors.constructors.length} templates, ${typeUses(i.mappings).filter((u) => u.type.kind === "apply").length} applications` }),
  fixtures: [
    {
      name: "a list of lists",
      mutate: (i) => {
        const list = { kind: "apply", constructor: "List", arguments: { T: { kind: "named", name: "ExternalId" } } };
        const m = i.mappings.map((f, n) => (n === 0 ? { ...f, types: [...(f.types ?? []), { name: "Nested", any_of: [{ kind: "apply", constructor: "List", arguments: { T: list } }, { kind: "named", name: "Text" }], source: { rule: "fixture" } }] } : f));
        return { ...i, mappings: m as MappingFile[] };
      },
      expect: "List",
    },
  ],
});

export const mappingConstructors = defineGate<{ model: Model; mappings: MappingFile[] }>({
  id: "mapping-constructors",
  title: "mapping: every application fits its constructor, and every copy gets a valid, unique name",
  code: ["src/constructors.ts#checkMappingConstructors"],
  check: (i) => ({ problems: checkMappingConstructors(i.model, i.mappings) }),
  fixtures: [
    {
      name: "an application of a constructor that doesn't exist",
      mutate: (i) => ({ ...i, mappings: JSON.parse(JSON.stringify(i.mappings).replace('"constructor":"Selectable"', '"constructor":"NoSuchConstructor"')) as MappingFile[] }),
      expect: "NoSuchConstructor",
    },
    {
      name: "an object option named by an external ID, not by its UUID id",
      mutate: (i) => ({ ...i, mappings: JSON.parse(JSON.stringify(i.mappings).replace('"K":{"kind":"named","name":"Uuid"}', '"K":{"kind":"named","name":"ExternalId"}')) as MappingFile[] }),
      expect: "so it is Uuid, not ExternalId",
    },
    {
      name: "format IDs named by external IDs in included[] and the pricing keys",
      mutate: (i) => ({ ...i, mappings: JSON.parse(JSON.stringify(i.mappings).replace('"T":{"kind":"named","name":"FormatId"},"K":{"kind":"named","name":"FormatId"}', '"T":{"kind":"named","name":"FormatId"},"K":{"kind":"named","name":"ExternalId"}')) as MappingFile[] }),
      expect: "Selectable's K names an option of T, FormatId, so it is FormatId, not ExternalId",
    },
  ],
});

export const constructorsApplied = defineGate<{ model: Model; mappings: MappingFile[]; decisions: DecisionRecord[] }>({
  id: "constructors-applied",
  title: "constructors: every constructor is applied on some lock, or a decision says why it stays",
  code: ["src/constructors.ts#checkApplied"],
  check: (i) => ({ problems: checkApplied(i.model, i.mappings, i.decisions), note: `${i.model.constructors.constructors.length} constructors, ${i.model.constructors.constructors.filter((c) => c.kept).length} kept unapplied` }),
  fixtures: [
    {
      name: "a template no field applies, as OrderedSettable was",
      mutate: (i) => {
        const range = i.model.constructors.constructors.find((c) => c.name === "Range")!;
        const constructors = [...i.model.constructors.constructors, { ...range, name: "OrderedSettable" }];
        return { ...i, model: { ...i.model, constructors: { ...i.model.constructors, constructors } } };
      },
      expect: "OrderedSettable: no mapping entry or applied template applies it on any lock",
    },
    {
      name: "Map unapplied once Selectable's shell no longer applies it, with the mapping's own maps dropped",
      mutate: (i) => {
        const constructors = i.model.constructors.constructors.map((c) => (c.name === "Selectable" ? { ...c, shell: { ...c.shell, properties: { ...(c.shell.properties as object), pricing: { $model: { kind: "named", name: "PriceDelta" } } } } } : c));
        const mappings = JSON.parse(JSON.stringify(i.mappings).replaceAll('"constructor":"Map"', '"constructor":"List"')) as MappingFile[];
        return { ...i, mappings, model: { ...i.model, constructors: { ...i.model.constructors, constructors } } };
      },
      expect: "Map: no mapping entry or applied template applies it on any lock",
    },
    {
      name: "an applied constructor that still carries a kept",
      mutate: (i) => ({ ...i, model: { ...i.model, constructors: { ...i.model.constructors, constructors: i.model.constructors.constructors.map((c) => (c.name === "Range" ? { ...c, kept: { decision: "D-011", reason: "A fixture's reason." } } : c)) } } }),
      expect: "Range: is applied on some lock, so its `kept` is stale; remove it",
    },
    {
      name: "an unapplied template kept by a decision that doesn't exist",
      mutate: (i) => {
        const range = i.model.constructors.constructors.find((c) => c.name === "Range")!;
        const constructors = [...i.model.constructors.constructors, { ...range, name: "OrderedSettable", kept: { decision: "D-999", reason: "A fixture's reason." } }];
        return { ...i, model: { ...i.model, constructors: { ...i.model.constructors, constructors } } };
      },
      expect: 'OrderedSettable: kept: cites decision "D-999", which doesn\'t exist',
    },
  ],
});

export const domainsCheck = defineGate<{ domains: Domains; types: KernelType[]; decisions: DecisionRecord[] }>({
  id: "domains-check",
  title: "domains: every concept names one type that declares it, every primitive and part declares a concept that names it, and every cited decision exists",
  code: ["src/domains.ts#checkDomains"],
  check: (i) => {
    const concepts = i.domains.domains.reduce((n, x) => n + x.concepts.length, 0);
    return { problems: checkDomains(i.domains, i.types, i.decisions), note: `${i.domains.domains.length} domains, ${concepts} concepts, ${i.types.length} kernel types, ${i.domains.homonyms.length} homonyms` };
  },
  fixtures: [
    { name: "a kernel type of a concept the domains don't list", mutate: (i) => ({ ...i, types: i.types.map((t) => (t.name === "Amount" ? { ...t, concept: "budget" } : t)) }), expect: "budget" },
    { name: "a concept whose decision doesn't exist", mutate: (i) => ({ ...i, decisions: i.decisions.filter((d) => d.id !== "D-036") }), expect: "D-036" },
  ],
});

export const domainSources = defineGate<{ ir: SpecIR; lock: string; domains: Domains; types: KernelType[] }>({
  id: "domain-sources",
  title: "domains: every concept cites its sources, current, and a published concept cites an element or a standard",
  code: ["src/domains.ts#checkDomainSources"],
  check: (i) => ({ problems: checkDomainSources(i.ir, i.lock, i.domains, i.types) }),
  fixtures: [
    {
      name: "a stale concept source",
      mutate: (i) => ({
        ...i,
        domains: { ...i.domains, domains: i.domains.domains.map((d) => ({ ...d, concepts: d.concepts.map((c) => (c.name === "amount" ? { ...c, sources: { ...c.sources, spec: (c.sources.spec ?? []).map((s) => ({ ...s, digest: "0".repeat(64) })) } } : c)) })) },
      }),
      expect: "amount",
    },
  ],
});

/** The duplication gate's input: every named type of the kernel, the parts, and the mapping's copies. */
export const duplicationKernel = defineGate<{ kernel: Kernel; model: Model | null; mappings: MappingFile[] }>({
  id: "duplication-kernel",
  title: "duplication: each named type defined once, no structural twins unless their concepts share a structure the domain model declares",
  code: ["src/duplication.ts#checkDuplication", "src/kernel.ts#checkKernelNames", "src/kernel.ts#kernelStructures", "src/constructors.ts#copyStructures", "src/domains.ts#sharedStructures"],
  exemptions: ["kernel/domains.yaml#shared_structures", "specs/*/kernel-binding.yaml#shared_structures"],
  check: (i) => {
    const copies = i.model ? copyStructures(i.model, i.mappings) : [];
    const types = [...kernelStructures(i.kernel), ...(i.model ? partStructures(i.model.constructors) : []), ...copies];
    const twins = [...checkDuplication(types, sharedStructures(i.kernel.domains), true), ...checkKernelNames(i.kernel, i.mappings)];
    const concepts = new Set(types.flatMap((t) => (t.concept ? [t.concept] : []))).size;
    return { problems: twins, note: `${types.length} named types, ${copies.length} of them copies; the kernel types represent ${concepts} concepts` };
  },
  fixtures: [
    {
      name: "a Budget twin of Amount, of a concept of its own",
      mutate: (i) => {
        const amount = i.kernel.primitives.find((p) => p.name === "Amount")!;
        return { ...i, kernel: { ...i.kernel, primitives: [...i.kernel.primitives, { ...amount, name: "Budget", concept: "budget" }] } };
      },
      expect: "Budget",
    },
    {
      name: "a Budget twin of Amount, of Amount's concept",
      mutate: (i) => {
        const amount = i.kernel.primitives.find((p) => p.name === "Amount")!;
        return { ...i, kernel: { ...i.kernel, primitives: [...i.kernel.primitives, { ...amount, name: "Budget" }] } };
      },
      expect: "Budget",
    },
  ],
});
