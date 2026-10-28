/** The gates on each lock's model: it resolves, deterministically, and every convention and domain rule holds on it. */
import type { Constructors } from "../src/constructors.ts";
import { checkConventions, dependsProblems, modelStructures, unstated, unstatedVocabularies } from "../src/conventions.ts";
import { homonymProblems, propertyProblems, sharedStructures, useProblems, type Domains, type KernelType } from "../src/domains.ts";
import { checkDuplication } from "../src/duplication.ts";
import type { Kernel } from "../src/kernel.ts";
import type { DecisionRecord, MappingFile } from "../src/mapping.ts";
import { resolveModel, type ModelDoc, type ModelType, type ResolveInput } from "../src/model.ts";
import { flipped, sameRuns, type RunsInput } from "./common.ts";
import { defineGate } from "./harness.ts";

/** The model with one type changed. */
export const withType = (m: ModelDoc, name: string, change: (t: ModelType) => ModelType): ModelDoc => {
  if (!m.types.some((t) => t.name === name)) throw new Error(`the model has no type "${name}"`);
  return { ...m, types: m.types.map((t) => (t.name === name ? change(t) : t)) };
};
/** An object type with one property removed. */
export const withoutProperty = (t: ModelType, member: string): ModelType => {
  if (!("properties" in t) || !(member in t.properties)) throw new Error(`"${t.name}" has no property "${member}"`);
  return { ...t, properties: Object.fromEntries(Object.entries(t.properties).filter(([k]) => k !== member)) } as ModelType;
};

export const modelResolves = defineGate<ResolveInput>({
  id: "model-resolves",
  title: "model resolves",
  code: ["src/model.ts#resolveModel"],
  check: (i) => {
    const r = resolveModel(i);
    return { problems: r.problems, note: `${r.model.types.length} types, ${r.model.rules.length} rules, ${r.model.obligations.length} obligations` };
  },
  fixtures: [
    // A table row read as part of a value: each column it reads by a decision is one its table has.
    {
      name: "an example row that reads a column its table doesn't have",
      spec: "dealsapi",
      mutate: (i) => ({ ...i, mappings: i.mappings.map((m) => ({ ...m, entries: m.entries.map((e) => (e.ir === "concept:example-scenarios:1" ? { ...e, as: { role: "example" as const, object: "Deal", columns: { curationfee: "curation.curfeetype", datafee: "curation.datafee" } } } : e)) })) as MappingFile[] }),
      expect: 'reads the column "datafee", which the row\'s table doesn\'t have',
    },
    {
      name: "an example row whose column names no member of its object",
      spec: "dealsapi",
      mutate: (i) => ({ ...i, mappings: i.mappings.map((m) => ({ ...m, entries: m.entries.map((e) => (e.ir === "concept:example-scenarios:1" ? { ...e, as: { role: "example" as const, object: "Deal" } } : e)) })) as MappingFile[] }),
      expect: 'the column "curationfee" holds curationfee, which Deal has no member for',
    },
    {
      name: "columns read off an element that is no table row",
      spec: "dealsapi",
      mutate: (i) => ({ ...i, mappings: i.mappings.map((m) => ({ ...m, entries: m.entries.map((e) => (e.ir === "sentence:example-1:7f955850" ? { ...e, as: { role: "example" as const, object: "Deal", columns: { seller: "seller" } } } : e)) })) as MappingFile[] }),
      expect: "reads columns, which only a row of a table has, and the element is a sentence",
    },
    {
      name: "a property of an object nobody defines",
      mutate: (i) => ({ ...i, mappings: JSON.parse(JSON.stringify(i.mappings).replace(/("ir":"field:5\.6:min_spend".*?"object":)"LineItem"/, '$1"NoSuchObject"')) as MappingFile[] }),
      expect: '"NoSuchObject" is no',
    },
    {
      name: "an object option whose id isn't the UUID that names it",
      mutate: (i) => ({ ...i, mappings: JSON.parse(JSON.stringify(i.mappings).replace('"id":{"type":{"kind":"named","name":"Uuid"},"presence":"optional"}', '"id":{"type":{"kind":"named","name":"ExternalId"},"presence":"optional"}')) as MappingFile[] }),
      expect: "is an option named by its `id`, a Uuid, but types `id` as ExternalId",
    },
    {
      name: "the id given to an option whose members the text lists, with no departure named",
      mutate: (i) => ({ ...i, constructors: { ...i.constructors, constructors: i.constructors.constructors.map((c) => ({ ...c, parameters: c.parameters.map((p) => (p.carries ? { ...p, carries: { member: p.carries.member, decision: p.carries.decision, description: p.carries.description } } : p)) })) } }),
      expect: "lists its members without `id`, so giving it one departs from the text",
    },
    {
      name: "the departure that gives a listed option its id recorded as a gap",
      mutate: (i) => ({ ...i, decisions: i.decisions.map((d) => (d.id === "D-047" ? { ...d, kind: "gap" as const } : d)) }),
      expect: "D-047 is no departure record",
    },
  ],
});

export const modelDeterministic = defineGate<RunsInput>({
  id: "model-deterministic",
  title: "deterministic model.json",
  code: ["gates/common.ts#sameRuns"],
  check: sameRuns,
  fixtures: [{ name: "the runs differ", mutate: (i) => ({ ...i, runs: [i.runs[0]!, flipped(i.runs[1]!)] }), expect: "run 2 differs" }],
});

/** One lock's model with what the convention gates read. */
export interface ConventionInput {
  model: ModelDoc;
  mappings: MappingFile[];
  kernel: Kernel;
  constructors: Constructors;
  decisions: DecisionRecord[];
}

const convention = (key: string) => (i: ConventionInput) => ({ problems: checkConventions(i.model, i.mappings, i.kernel, i.constructors, i.decisions)[key] ?? [`no convention "${key}"`] });

export const layers = defineGate<ConventionInput>({
  id: "convention-layers",
  title: "layers: no reference to a higher layer, and no cycle among the types",
  code: ["src/conventions.ts#checkConventions"],
  check: convention("layers"),
  fixtures: [
    { name: "a primitive that references an object", mutate: (i) => ({ ...i, model: withType(i.model, "Amount", (t) => ({ ...t, references: [...t.references, "Commitment"] })) }), expect: "a layer uses only the layers below it" },
    { name: "a type that references a type nobody defines", mutate: (i) => ({ ...i, model: withType(i.model, "Commitment", (t) => ({ ...t, references: [...t.references, "NoSuchType"] })) }), expect: "which the model doesn't define" },
  ],
});

export const modules = defineGate<ConventionInput>({
  id: "convention-modules",
  title: "modules: references to other modules only as each mapping file's depends lists them",
  code: ["src/conventions.ts#checkConventions"],
  check: convention("modules"),
  fixtures: [{ name: "a module that drops a dependency it uses", mutate: (i) => ({ ...i, mappings: i.mappings.map((m) => (m.module === "line-item" ? { ...m, depends: [] } : m)) }), expect: "which \"depends\" doesn't list" }],
});

export const inline = defineGate<ConventionInput>({
  id: "convention-inline",
  title: "named or inline: every type position is named, the boolean, a named copy, or a list or map of named types",
  code: ["src/conventions.ts#checkConventions"],
  check: convention("inline"),
  fixtures: [
    {
      name: "a list of lists in a property",
      mutate: (i) => ({
        ...i,
        model: withType(i.model, "Commitment", (t) => {
          const o = t as Extract<ModelType, { kind: "object" }>;
          return { ...o, properties: { ...o.properties, amount: { ...o.properties.amount!, type: { kind: "apply", constructor: "List", arguments: { T: { kind: "apply", constructor: "List", arguments: { T: { kind: "named", name: "Amount" } } } } } } } };
        }),
      }),
      expect: "type rules § 4",
    },
  ],
});

export const besideReference = defineGate<ConventionInput>({
  id: "convention-beside-reference",
  title: "nothing beside a reference: a $ref or a slot carries a description at most",
  code: ["src/conventions.ts#checkConventions"],
  check: convention("beside a reference"),
  fixtures: [
    {
      name: "a constraint beside a $ref in a copy",
      mutate: (i) => {
        const copy = i.model.types.find((t) => t.kind === "copy" && JSON.stringify(t.schema).includes('"$ref"'))!;
        const schema = JSON.parse(JSON.stringify((copy as Extract<ModelType, { kind: "copy" }>).schema).replace(/"\$ref":"([^"]+)"/, '"$ref":"$1","minLength":1'));
        return { ...i, model: withType(i.model, copy.name, (t) => ({ ...t, schema }) as ModelType) };
      },
      expect: "beside a $ref",
    },
  ],
});

export const keywords = defineGate<ConventionInput>({
  id: "convention-keywords",
  title: "keywords: standard JSON Schema 2020-12 keywords only",
  code: ["src/conventions.ts#checkConventions"],
  check: convention("keywords"),
  fixtures: [{ name: "an x- keyword", mutate: (i) => ({ ...i, model: withType(i.model, "Amount", (t) => ({ ...t, schema: { ...(t as Extract<ModelType, { kind: "primitive" }>).schema, "x-unit": "money" } }) as ModelType) }), expect: '"x-unit" is no standard JSON Schema 2020-12 keyword' }],
});

export const unions = defineGate<ConventionInput>({
  id: "convention-unions",
  title: "unions: oneOf only with a const tag, no allOf, anyOf only where type rules § 8 allows it",
  code: ["src/conventions.ts#checkConventions"],
  check: convention("unions"),
  fixtures: [
    { name: "an allOf", mutate: (i) => ({ ...i, model: withType(i.model, "Amount", (t) => ({ ...t, schema: { allOf: [(t as Extract<ModelType, { kind: "primitive" }>).schema] } }) as ModelType) }), expect: '"allOf"' },
    { name: "an enum that holds an integer", mutate: (i) => ({ ...i, model: withType(i.model, "Count", (t) => ({ ...t, schema: { type: "integer", enum: [1, 2] } }) as ModelType) }), expect: "an enum holds an integer; a code is a titled const branch" },
    { name: "a primitive's oneOf that isn't titled codes", lock: "with-open-prs", mutate: (i) => ({ ...i, model: withType(i.model, "IntegerFlag", (t) => ({ ...t, schema: { type: "integer", oneOf: [{ const: 0 }, { const: 1, title: "Yes" }] } }) as ModelType) }), expect: "oneOf branch 0 has no required property with a \"const\" value" },
    { name: "a union with no decision", mutate: (i) => ({ ...i, model: { ...i.model, types: i.model.types.map((t) => (t.kind === "union" ? { ...t, decisions: [] } : t)) } }), expect: "cites no decision record" },
  ],
});

export const lists = defineGate<ConventionInput>({
  id: "convention-lists",
  title: "lists: each value list defined once, and only the open vocabularies with no core terms that a decision lists set aside",
  code: ["src/conventions.ts#checkConventions"],
  exemptions: ["specs/*/decisions/*.yaml#sets_aside"],
  check: convention("lists"),
  fixtures: [
    {
      name: "a second vocabulary with Channel's terms",
      mutate: (i) => {
        const channel = i.model.types.find((t) => t.name === "Channel")!;
        return { ...i, model: { ...i.model, types: [...i.model.types, { ...channel, name: "Channel2" }] } };
      },
      expect: "Channel2",
    },
    {
      name: "an empty open vocabulary no decision lists",
      mutate: (i) => {
        const cadence = i.model.types.find((t) => t.kind === "vocabulary" && t.open && t.terms.length === 0)!;
        return { ...i, model: { ...i.model, types: [...i.model.types, { ...cadence, name: "ReportingFrequency" }] } };
      },
      expect: "ReportingFrequency",
    },
  ],
});

export const duplicationModel = defineGate<{ model: ModelDoc; kernel: Kernel; constructors: Constructors; decisions: DecisionRecord[] }>({
  id: "duplication-model",
  title: "duplication over the model: no undeclared structural twins among its named types",
  code: ["src/duplication.ts#checkDuplication", "src/conventions.ts#modelStructures", "src/conventions.ts#unstatedVocabularies", "src/domains.ts#sharedStructures"],
  exemptions: ["kernel/domains.yaml#shared_structures", "specs/*/kernel-binding.yaml#shared_structures", "specs/*/decisions/*.yaml#sets_aside"],
  check: (i) => {
    const vocabularies = unstatedVocabularies(i.model, i.decisions);
    const structures = modelStructures(i.model, i.kernel, i.constructors, vocabularies.names);
    const twins = [...checkDuplication(structures, sharedStructures(i.kernel.domains)), ...vocabularies.problems];
    const setAside = i.model.types.filter(unstated).length;
    return { problems: twins, note: `${structures.length} named types; ${setAside} open objects with unstated structure, and the ${vocabularies.names.size} open vocabularies with no core terms that a decision lists, set aside` };
  },
  fixtures: [
    {
      name: "a twin of a vocabulary with terms",
      mutate: (i) => {
        const v = i.model.types.find((t) => t.name === "ServingMode")!;
        return { ...i, model: { ...i.model, types: [...i.model.types, { ...v, name: "ServingMode2" }] } };
      },
      expect: "ServingMode2",
    },
    {
      name: "a twin of an empty open vocabulary",
      mutate: (i) => {
        const v = i.model.types.find((t) => t.kind === "vocabulary" && t.open && t.terms.length === 0)!;
        return { ...i, model: { ...i.model, types: [...i.model.types, { ...v, name: "ReportingFrequency" }] } };
      },
      expect: "ReportingFrequency",
    },
    {
      name: "two open options whose `id` is their own, not the one the constructor gives",
      mutate: (i) => {
        const own = (t: ModelType): ModelType => (t.kind === "object" && (t.name === "CancellationPolicyOption" || t.name === "ExclusivityOption") ? { ...t, properties: { id: { ...t.properties.id!, given: undefined } } } : t);
        return { ...i, model: { ...i.model, types: i.model.types.map(own) } };
      },
      expect: '"CancellationPolicyOption" and "ExclusivityOption" have the same structure',
    },
  ],
});

export const domainsUsed = defineGate<{ model: ModelDoc; lock: string; types: KernelType[] }>({
  id: "domains-used",
  title: "domains: every primitive and part the lock publishes is reached from a document and cites an element or a standard",
  code: ["src/domains.ts#useProblems"],
  check: (i) => ({ problems: useProblems(i.model, i.lock, i.types), note: `${i.model.types.filter((t) => t.kind === "primitive" || t.kind === "part").length} kernel types` }),
  fixtures: [
    {
      name: "a published primitive no document reaches",
      mutate: (i) => {
        const amount = i.model.types.find((t) => t.name === "Amount")!;
        return { ...i, model: { ...i.model, types: [...i.model.types, { ...amount, name: "Budget" }] }, types: [...i.types, { ...i.types.find((t) => t.name === "Amount")!, name: "Budget" }] };
      },
      expect: "Budget",
    },
  ],
});

/** One lock's model with the domain model and the decisions, for the property checks. */
export interface PropertyInput {
  model: ModelDoc;
  lock: string;
  domains: Domains;
  decisions: DecisionRecord[];
}

export const domainsProperties = defineGate<PropertyInput>({
  id: "domains-properties",
  title: "domains: every scalar property resolves to a concept, none is typed by the bare term grammar or a component, and every money value has its currency or a decision that asks for it",
  code: ["src/domains.ts#propertyProblems"],
  exemptions: ["specs/*/kernel-binding.yaml#lacking"],
  check: (i) => ({ problems: propertyProblems(i.model, i.lock, i.domains, i.decisions) }),
  fixtures: [
    { name: "currency deleted from Commitment", mutate: (i) => ({ ...i, model: withType(i.model, "Commitment", (t) => withoutProperty(t, "currency")) }), expect: 'object "Commitment": property "amount": carries a value of the concept "amount" with no sibling "currency"' },
    { name: "currency deleted from PricingEntry", mutate: (i) => ({ ...i, model: withType(i.model, "PricingEntry", (t) => withoutProperty(t, "currency")) }), expect: 'object "PricingEntry"' },
    { name: "currency deleted from MinCommitmentEntry", lock: "with-open-prs", mutate: (i) => ({ ...i, model: withType(i.model, "MinCommitmentEntry", (t) => withoutProperty(t, "currency")) }), expect: 'object "MinCommitmentEntry"' },
    {
      name: "a property typed by the bare term grammar",
      mutate: (i) => ({
        ...i,
        model: withType(i.model, "PricingEntry", (t) => {
          const o = t as Extract<ModelType, { kind: "object" }>;
          return { ...o, properties: { ...o.properties, cost_method: { ...o.properties.cost_method!, type: { kind: "named", name: "NamespacedTerm" } } } };
        }),
      }),
      expect: "its type is the term grammar",
    },
    {
      name: "a property typed by a component",
      mutate: (i) => ({
        ...i,
        model: withType(i.model, "PricingEntry", (t) => {
          const o = t as Extract<ModelType, { kind: "object" }>;
          return { ...o, properties: { ...o.properties, gross_rate: { ...o.properties.gross_rate!, type: { kind: "named", name: "TimeOfDay" } } } };
        }),
      }),
      expect: "its type is a component of the concept",
    },
  ],
});

export const homonyms = defineGate<{ models: ModelDoc[]; domains: Domains }>({
  id: "domains-homonyms",
  title: "domains: every recurring member name resolves to one concept, or is a homonym a decision explains",
  code: ["src/domains.ts#homonymProblems"],
  exemptions: ["specs/*/kernel-binding.yaml#homonyms"],
  check: (i) => ({ problems: homonymProblems(i.models, i.domains), note: `${i.domains.homonyms.length} homonyms` }),
  fixtures: [{ name: "a listed homonym removed", mutate: (i) => ({ ...i, domains: { ...i.domains, homonyms: i.domains.homonyms.filter((h) => h.member !== "basis") } }), expect: 'the member name "basis" resolves to' }],
});

export const depends = defineGate<{ models: ModelDoc[]; mappings: MappingFile[] }>({
  id: "modules-depends",
  title: "modules: every depends entry is used on some lock, and the declared module graph is a DAG",
  code: ["src/conventions.ts#dependsProblems"],
  check: (i) => ({ problems: dependsProblems(i.models, i.mappings) }),
  fixtures: [
    { name: "a dependency no type uses", mutate: (i) => ({ ...i, mappings: i.mappings.map((m) => (m.module === "proposal" ? { ...m, depends: [...(m.depends ?? []), "settlement"] } : m)) }), expect: "settlement" },
    { name: "a cycle among the modules", mutate: (i) => ({ ...i, mappings: i.mappings.map((m) => (m.module === "commercial" ? { ...m, depends: [...(m.depends ?? []), "line-item"] } : m)) }), expect: "line-item" },
  ],
});
