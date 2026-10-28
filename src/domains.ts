/**
 * The value domains (type rules § 3a): `kernel/domains.yaml`, the concept
 * inventory the mapping rests on. Each concept says what a value means, names
 * the one model type that represents it, and cites the specification elements
 * and standards it rests on. Every primitive and part declares its concept,
 * and every scalar property of the model resolves to one.
 *
 * The gates:
 *
 * - the file: concept and domain names are unique, one domain holds the
 *   vocabularies, every concept's type and components are kernel types that
 *   declare the concept back, every kernel type declares a concept that names
 *   it, and every decision a concept or a homonym cites exists (`checkDomains`);
 * - sources, per lock: every concept's spec sources are current, and a
 *   concept whose type is published on the lock cites an element in scope or
 *   a standard (`checkDomainSources`);
 * - use, per lock: every primitive and part the model publishes is reached
 *   from a document, and cites an element in scope or a standard (`useProblems`);
 * - properties, per lock: every scalar property resolves to a concept, no
 *   property is typed by a component or by the bare term grammar, an object
 *   that carries a value whose concept requires a sibling carries it or rests
 *   on the decision that says the specification lacks it, and a recurring
 *   member name resolves to one concept or is a homonym that a decision
 *   explains (`propertyProblems`, `homonymProblems`).
 */
import { join } from "node:path";
import { indexElements } from "./elements.ts";
import type { SpecIR } from "./ir-types.ts";
import { checkCovers, inScope, readYaml, type Cover, type DecisionRecord, type TypeRef } from "./mapping.ts";
import type { ModelDoc, ModelProperty, ModelType } from "./model.ts";
import type { SharedStructures } from "./duplication.ts";
import { compileSchema } from "./pipeline.ts";
import { REPO_ROOT } from "./repo.ts";
import { bound, type KernelBinding } from "./binding.ts";

export interface Standard {
  name: string;
  url: string;
}

export interface Concept {
  name: string;
  meaning: string;
  /** A kernel primitive or part, or `boolean`. */
  type: string;
  components?: string[];
  requires?: { member: string; concept: string; decision: string; lacking: { ir: string; locks?: string[] }[] };
  sources: { spec?: Cover[]; standards?: Standard[] };
}

export interface Domain {
  name: string;
  description: string;
  vocabularies?: true;
  concepts: Concept[];
}

export interface Domains {
  format: 1;
  domains: Domain[];
  homonyms: { member: string; decision: string; reason: string }[];
  /** Concepts whose types have one structure, with the decision that makes them distinct types (type rules § 5). */
  shared_structures: SharedStructure[];
  /** Vocabularies whose term says what a sibling's value is (type rules § 3a). */
  bases: Basis[];
  /** The file the domains came from, for messages. */
  file: string;
  /** The spec's kernel binding the spec sources, decisions, and member names came from (src/binding.ts); none for the definitions alone. */
  binding?: string;
}

export interface SharedStructure {
  concepts: string[];
  decisions: string[];
  reason: string;
}

export interface Basis {
  vocabulary: string;
  member: string;
  /** Each term, with the concept the member's value is while the vocabulary holds it. */
  terms: Record<string, string>;
  /** The concept the member's value is for every term `terms` doesn't name, an open vocabulary's extension terms included; the member's own type is then this concept's type. */
  others?: string;
  decision: string;
}

export const DOMAINS_FILE = join("kernel", "domains.yaml");
const DOMAINS_SCHEMA = join("kernel", "domains.schema.json");

/** The type a two-valued flag is: the inline boolean, which no kernel file defines. */
export const BOOLEAN = "boolean";

/** Loads `kernel/domains.yaml` from `root`, with a spec's kernel binding merged in, and validates it against its schema. Throws if it is invalid. */
export function loadDomains(root: string, binding: KernelBinding | null, file = join(root, DOMAINS_FILE)): Domains {
  const doc = bound("domains", file, readYaml(file), binding);
  const errors = compileSchema(join(REPO_ROOT, DOMAINS_SCHEMA), [join(REPO_ROOT, "kernel", "kernel.schema.json")])(doc);
  if (errors.length > 0) throw new Error(`${file}${binding ? ` with ${binding.file}` : ""}: not a valid domains file: ${errors.join("; ")}`);
  return { ...(doc as Omit<Domains, "file" | "binding">), file, ...(binding ? { binding: binding.file } : {}) };
}

/** The shared-structure sets, as the duplication gate reads them. */
export const sharedStructures = (d: Domains | undefined): SharedStructures => ({ sets: d?.shared_structures ?? [], file: d?.file ?? "" });

/** Every concept, by name, with its domain. */
export function conceptIndex(d: Domains): Map<string, { concept: Concept; domain: Domain }> {
  const out = new Map<string, { concept: Concept; domain: Domain }>();
  for (const domain of d.domains) for (const concept of domain.concepts) if (!out.has(concept.name)) out.set(concept.name, { concept, domain });
  return out;
}

/** The concept each type represents: a concept's type, and each of its components. */
export function conceptOfType(d: Domains): Map<string, { concept: Concept; domain: Domain; component: boolean }> {
  const out = new Map<string, { concept: Concept; domain: Domain; component: boolean }>();
  for (const domain of d.domains) {
    for (const concept of domain.concepts) {
      out.set(concept.type, { concept, domain, component: false });
      for (const c of concept.components ?? []) out.set(c, { concept, domain, component: true });
    }
  }
  return out;
}

/** The concept whose spec sources list a field or key row, when exactly one does. Mapping rule `domain-row`. */
export function conceptOfRow(d: Domains, ir: string): Concept | null {
  const found = d.domains.flatMap((x) => x.concepts).filter((c) => (c.sources.spec ?? []).some((s) => s.ir === ir));
  return found.length === 1 ? found[0]! : null;
}

/** A kernel type as the domain checks see it: a primitive or a part, with the concept it declares. */
export interface KernelType {
  name: string;
  kind: "primitive" | "part";
  concept: string;
  /** The locks it is published on; every lock when absent. */
  locks?: string[];
  spec: Cover[];
  standards: Standard[];
  where: string;
}

/**
 * The lock-independent checks on the domain model. Returns the problems;
 * empty means every concept and every kernel type agree.
 */
export function checkDomains(d: Domains, kernel: KernelType[], decisions: DecisionRecord[]): string[] {
  const problems: string[] = [];
  const byName = new Map(kernel.map((k) => [k.name, k]));
  const decided = new Map(decisions.map((x) => [x.id, x]));
  const cites = (where: string, id: string) => {
    const x = decided.get(id);
    if (!x) problems.push(`${where}: cites decision "${id}", which doesn't exist`);
    else if (x.status === "superseded") problems.push(`${where}: cites "${id}", which is superseded by "${x.superseded_by}"`);
  };
  const domains = new Set<string>();
  const concepts = new Set<string>();
  const types = new Map<string, string>();
  for (const domain of d.domains) {
    if (domains.has(domain.name)) problems.push(`${d.file}: domain "${domain.name}" is listed twice`);
    domains.add(domain.name);
    for (const c of domain.concepts) {
      const where = `${d.file}: concept "${c.name}"`;
      if (concepts.has(c.name)) problems.push(`${where} is defined twice; each concept is defined once`);
      concepts.add(c.name);
      for (const [t, role] of [[c.type, "type"], ...(c.components ?? []).map((x) => [x, "component"])] as [string, string][]) {
        const first = types.get(t);
        if (first !== undefined) problems.push(`${where}: "${t}" already represents the concept "${first}"; one type represents one concept`);
        types.set(t, c.name);
        if (t === BOOLEAN) {
          if (role !== "type") problems.push(`${where}: the boolean is a concept's type, not a component`);
          continue;
        }
        const k = byName.get(t);
        if (!k) problems.push(`${where}: its ${role} "${t}" is no kernel primitive or part`);
        else if (k.concept !== c.name) problems.push(`${where}: its ${role} "${t}" declares the concept "${k.concept}"`);
      }
      if (c.requires) {
        cites(`${where}: requires`, c.requires.decision);
        const covers = decided.get(c.requires.decision)?.covers ?? [];
        for (const l of c.requires.lacking) {
          const ok = covers.some((x) => x.ir === l.ir && (l.locks ?? [undefined]).every((lock) => lock === undefined || inScope(x.locks, lock)));
          if (!ok) problems.push(`${where}: requires: lacking lists "${l.ir}", which ${c.requires.decision} doesn't cover; the decision that asks for the sibling covers every element that lacks it`);
        }
      }
    }
  }
  // A domain whose values require a sibling, as money requires its currency, requires it of every concept but the sibling's.
  for (const domain of d.domains) {
    const siblings = new Set(domain.concepts.flatMap((c) => (c.requires ? [c.requires.concept] : [])));
    if (siblings.size === 0) continue;
    for (const c of domain.concepts) {
      if (!c.requires && !siblings.has(c.name)) problems.push(`${d.file}: concept "${c.name}" of the domain "${domain.name}" states no "requires"; every concept of a domain whose values require a sibling requires it, except the sibling's own concept (${[...siblings].join(", ")})`);
    }
  }
  const pairs = new Set<string>();
  for (const x of d.shared_structures) {
    const where = `${d.file}: shared structure ${x.concepts.join(", ")}`;
    for (const id of x.decisions) cites(where, id);
    for (const c of x.concepts) if (!concepts.has(c)) problems.push(`${where}: "${c}" is no concept`);
    for (const a of x.concepts) for (const b of x.concepts) {
      if (a >= b) continue;
      if (pairs.has(`${a} ${b}`)) problems.push(`${where}: "${a}" and "${b}" are listed together twice; list each pair once`);
      pairs.add(`${a} ${b}`);
    }
  }
  for (const b of d.bases) {
    const where = `${d.file}: basis "${b.vocabulary}"`;
    cites(where, b.decision);
    for (const [term, c] of Object.entries(b.terms)) if (!concepts.has(c)) problems.push(`${where}: the term "${term}" reads "${b.member}" as "${c}", which is no concept`);
    if (b.others !== undefined && !concepts.has(b.others)) problems.push(`${where}: every other term reads "${b.member}" as "${b.others}", which is no concept`);
    // With no concept for the other terms, the member's own type is one term's, so two terms are needed for one to narrow it.
    if (b.others !== undefined && Object.keys(b.terms).length === 0) problems.push(`${where}: names no term, so nothing narrows "${b.member}" from "${b.others}"; type it as "${b.others}" and remove the basis`);
    if (b.others === undefined && Object.keys(b.terms).length < 2) problems.push(`${where}: names one term and no concept for the others, so nothing narrows "${b.member}"`);
    if (b.others !== undefined && Object.values(b.terms).includes(b.others)) problems.push(`${where}: a term reads "${b.member}" as "${b.others}", the concept every other term gives it; leave the term out`);
  }
  const vocabularies = d.domains.filter((x) => x.vocabularies);
  if (vocabularies.length !== 1) problems.push(`${d.file}: ${vocabularies.length} domains hold the vocabularies; exactly one does`);
  for (const domain of d.domains) {
    for (const c of domain.concepts) {
      if (c.requires && !concepts.has(c.requires.concept)) problems.push(`${d.file}: concept "${c.name}" requires a sibling of the concept "${c.requires.concept}", which isn't defined`);
    }
  }
  for (const k of kernel) {
    if (!concepts.has(k.concept)) problems.push(`${k.where}: ${k.name} declares the concept "${k.concept}", which ${d.file} doesn't define`);
    else if (types.get(k.name) !== k.concept) problems.push(`${k.where}: ${k.name} declares the concept "${k.concept}", which doesn't name it as its type or a component`);
  }
  const members = new Set<string>();
  for (const h of d.homonyms) {
    if (members.has(h.member)) problems.push(`${d.file}: homonym "${h.member}" is listed twice`);
    members.add(h.member);
    cites(`${d.file}: homonym "${h.member}"`, h.decision);
  }
  return problems;
}

/**
 * The domain model's sources against one lock's IR: every in-scope spec
 * source is current, and every concept whose type the lock publishes cites an
 * element in scope or a standard, so no concept rests on nothing.
 */
export function checkDomainSources(ir: SpecIR, lock: string, d: Domains, kernel: KernelType[]): string[] {
  const problems: string[] = [];
  const elements = indexElements(ir);
  const byName = new Map(kernel.map((k) => [k.name, k]));
  for (const domain of d.domains) {
    for (const c of domain.concepts) {
      const where = `${d.binding ?? d.file}: concept "${c.name}"`;
      checkCovers(where, c.sources.spec ?? [], elements, lock, problems);
      const k = byName.get(c.type);
      const published = c.type === BOOLEAN || (k !== undefined && (k.locks === undefined || k.locks.includes(lock)));
      if (published && !(c.sources.spec ?? []).some((s) => inScope(s.locks, lock)) && (c.sources.standards ?? []).length === 0) {
        problems.push(`${where}: cites no specification element on lock "${lock}" and no standard`);
      }
    }
  }
  return problems;
}

/** The named types a type references, at any depth. */
function reachable(model: ModelDoc, roots: string[]): Set<string> {
  const types = new Map(model.types.map((t) => [t.name, t]));
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const r of types.get(n)?.references ?? []) stack.push(r);
  }
  return seen;
}

/**
 * Every primitive and part one lock's model publishes is reached from a
 * document or a profile, or, in a registry of lists with no document, as
 * AdCOM's, from a vocabulary, which is a payload's value of its own; and it
 * cites a specification element in scope on the lock or a standard. A kernel
 * type no payload can hold isn't published.
 */
export function useProblems(model: ModelDoc, lock: string, kernel: KernelType[]): string[] {
  const problems: string[] = [];
  const documents = model.types.filter((t) => t.layer === 5).map((t) => t.name);
  const reached = reachable(model, documents.length > 0 ? documents : model.types.filter((t) => t.kind === "vocabulary").map((t) => t.name));
  const byName = new Map(kernel.map((k) => [k.name, k]));
  for (const t of model.types) {
    if (t.kind !== "primitive" && t.kind !== "part") continue;
    const k = byName.get(t.name);
    const where = `${k?.where ?? t.module}: ${t.kind} "${t.name}"`;
    if (!reached.has(t.name)) problems.push(`${where}: no document reaches it on lock "${lock}"; remove it, or publish it only on the locks that use it`);
    if (k && !k.spec.some((s) => inScope(s.locks, lock)) && k.standards.length === 0) problems.push(`${where}: cites no specification element on lock "${lock}" and no standard`);
  }
  return problems;
}

/** What a property's type resolves to: a concept, a vocabulary of the term domain, or nothing for a type that isn't scalar. */
export type Resolution = { concept: string; component?: boolean; term?: boolean } | { vocabulary: string } | null;

/**
 * The concept of a type: the boolean's, a kernel type's, a vocabulary's own
 * (the term domain holds every vocabulary), or a list's or a map's items'.
 * An object, a union, a document, or a copy of a constructor that isn't
 * filled in place isn't scalar, and resolves to nothing.
 */
export function resolveType(t: TypeRef, model: ModelDoc, d: Domains): Resolution {
  const types = new Map(model.types.map((x) => [x.name, x]));
  const byType = conceptOfType(d);
  const term = d.domains.find((x) => x.vocabularies)?.name;
  const go = (x: TypeRef): Resolution => {
    switch (x.kind) {
      case "boolean": {
        const c = byType.get(BOOLEAN);
        return c ? { concept: c.concept.name } : { concept: "" };
      }
      case "parameter":
        return null;
      case "named": {
        const t = types.get(x.name);
        if (t?.kind === "vocabulary") return { vocabulary: t.name };
        if (t?.kind !== "primitive" && t?.kind !== "part") return null;
        const c = byType.get(x.name);
        return c ? { concept: c.concept.name, ...(c.component ? { component: true } : {}), ...(c.domain.name === term ? { term: true } : {}) } : { concept: "" };
      }
      case "apply": {
        if (x.constructor === "List") return go(x.arguments.T!);
        if (x.constructor === "Map") return go(x.arguments.V!);
        return null;
      }
    }
  };
  return go(t);
}

const conceptKey = (r: Resolution): string | null => (r === null ? null : "vocabulary" in r ? `vocabulary ${r.vocabulary}` : r.concept);

/** Every property of the model's objects, documents, and profiles, with where it is. */
function propertiesOf(model: ModelDoc): { type: ModelType; name: string; property: ModelProperty }[] {
  return model.types.flatMap((t) => ("properties" in t ? Object.entries(t.properties).map(([name, property]) => ({ type: t, name, property })) : []));
}

/**
 * The property checks on one lock's model: every scalar property resolves to
 * a concept; none is typed by a component of a concept or by a type of the
 * term domain other than a vocabulary; and an object that carries a value of
 * a concept with `requires` carries the sibling member, of the concept it
 * names, or the value's elements are ones the concept's decision covers, so
 * the implementation feedback asks the specification for the sibling.
 */
export function propertyProblems(model: ModelDoc, lock: string, d: Domains, decisions: DecisionRecord[]): string[] {
  const problems: string[] = [];
  const concepts = conceptIndex(d);
  const byType = conceptOfType(d);
  // The elements each concept's `requires` lists as lacking the sibling, in scope on the lock, and those a value rests on.
  const lacking = new Map<string, Set<string>>();
  for (const { concept } of concepts.values()) if (concept.requires) lacking.set(concept.name, new Set(concept.requires.lacking.filter((l) => inScope(l.locks, lock)).map((l) => l.ir)));
  const used = new Set<string>();
  const lacks = (concept: string, sources: string[]) => {
    const hit = sources.filter((x) => lacking.get(concept)?.has(x));
    for (const x of hit) used.add(`${concept} ${x}`);
    return hit.length > 0;
  };
  const siblingProblem = (where: string, concept: string, requires: NonNullable<Concept["requires"]>, sources: string[]) =>
    `${where}: carries a value of the concept "${concept}" with no sibling "${requires.member}" of the concept "${requires.concept}", and the concept's "lacking" lists none of ${sources.join(", ")} on lock "${lock}"`;
  for (const { type, name, property } of propertiesOf(model)) {
    const where = `${type.module}: ${type.kind} "${type.name}": property "${name}"`;
    for (const c of property.cases ?? []) {
      const r = resolveType(c.type, model, d);
      if (r === null || "vocabulary" in r || r.concept === "" || r.component || r.term) problems.push(`${where}: its type while "${c.when.member}" is "${c.when.value}", "${c.type.name}", is no concept's type (type rules § 3a)`);
    }
    const r = resolveType(property.type, model, d);
    if (r === null || "vocabulary" in r) continue;
    if (r.concept === "") problems.push(`${where}: its type represents no concept of ${d.file} on lock "${lock}" (type rules § 3a)`);
    else if (r.component) problems.push(`${where}: its type is a component of the concept "${r.concept}", which only that concept's type holds`);
    else if (r.term) problems.push(`${where}: its type is the term grammar; a property whose values are terms references a named vocabulary (type rules § 6)`);
    const requires = r.concept === "" ? undefined : concepts.get(r.concept)?.concept.requires;
    if (!requires || type.kind === "profile") continue;
    const sibling = "properties" in type ? type.properties[requires.member] : undefined;
    const ok = sibling !== undefined && conceptKey(resolveType(sibling.type, model, d)) === requires.concept;
    if (!ok && !lacks(r.concept, property.sources)) problems.push(siblingProblem(where, r.concept, requires, property.sources));
  }
  for (const t of model.types) {
    if (t.kind !== "part") continue;
    // A part's members aren't model properties: the part and each value it holds need the sibling among its members too.
    const members = (t.schema.properties ?? {}) as Record<string, unknown>;
    for (const n of [t.name, ...t.references]) {
      const c = byType.get(n);
      const requires = c?.concept.requires;
      if (!requires || c!.component || requires.member in members) continue;
      if (!lacks(c!.concept.name, t.sources)) problems.push(siblingProblem(`kernel: part "${t.name}"${n === t.name ? "" : `: holds "${n}"`}`, c!.concept.name, requires, t.sources));
    }
  }
  for (const [concept, irs] of lacking) {
    for (const ir of irs) if (!used.has(`${concept} ${ir}`)) problems.push(`${d.file}: concept "${concept}": requires: lacking lists "${ir}", but no value of the concept rests on it without its sibling on lock "${lock}"; remove it, or limit it to the locks where one does`);
  }
  // A basis is read where its vocabulary is: some object holds both it and the member it reads.
  for (const b of d.bases) {
    if (!model.types.some((t) => t.name === b.vocabulary)) continue;
    const reads = propertiesOf(model).some(({ type, name, property }) => property.type.kind === "named" && property.type.name === b.vocabulary && "properties" in type && b.member in type.properties && name !== b.member);
    if (!reads) problems.push(`${d.file}: basis "${b.vocabulary}": no object holds it beside "${b.member}" on lock "${lock}"; remove it`);
  }
  return problems;
}

/**
 * Recurring member names across the locks' models: the scalar properties
 * named alike resolve to one concept, or the name is a homonym the domain
 * file lists with the decision that explains the difference. A listed
 * homonym whose properties resolve to one concept on every lock fails, so the
 * list can't outlive its reason.
 */
export function homonymProblems(models: ModelDoc[], d: Domains): string[] {
  const problems: string[] = [];
  const byMember = new Map<string, Map<string, Set<string>>>();
  for (const model of models) {
    for (const { type, name, property } of propertiesOf(model)) {
      if (type.kind === "profile") continue;
      const key = conceptKey(resolveType(property.type, model, d));
      if (key === null) continue;
      const m = byMember.get(name) ?? new Map<string, Set<string>>();
      m.set(key, new Set([...(m.get(key) ?? []), `${type.name}.${name}`]));
      byMember.set(name, m);
    }
  }
  const listed = new Map(d.homonyms.map((h) => [h.member, h]));
  for (const [member, concepts] of [...byMember].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (concepts.size <= 1 || listed.has(member)) continue;
    const parts = [...concepts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([c, props]) => `${c} (${[...props].sort().join(", ")})`);
    problems.push(`${d.file}: the member name "${member}" resolves to ${concepts.size} concepts: ${parts.join("; ")}; give them one concept, or list "${member}" under homonyms with the decision that explains the difference`);
  }
  for (const h of d.homonyms) {
    if ((byMember.get(h.member)?.size ?? 0) <= 1) problems.push(`${d.file}: homonym "${h.member}" resolves to one concept on every lock; remove it`);
  }
  return problems;
}

/** The kernel types the domain checks read: every primitive and part, with its concept and sources. */
export function kernelTypes(primitives: { name: string; concept: string; locks?: string[]; sources: { spec?: Cover[]; standards?: Standard[] } }[], parts: { name: string; concept: string; sources: { spec: Cover[]; standards?: Standard[] } }[], files: { kernel: string; constructors: string }): KernelType[] {
  return [
    ...primitives.map((p) => ({ name: p.name, kind: "primitive" as const, concept: p.concept, ...(p.locks ? { locks: p.locks } : {}), spec: p.sources.spec ?? [], standards: p.sources.standards ?? [], where: files.kernel })),
    ...parts.map((p) => ({ name: p.name, kind: "part" as const, concept: p.concept, spec: p.sources.spec, standards: p.sources.standards ?? [], where: files.constructors })),
  ];
}
