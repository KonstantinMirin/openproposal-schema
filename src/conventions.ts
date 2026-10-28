/**
 * The convention gates on the resolved model (type rules § 2 to § 8). Each
 * check takes the model `src/model.ts` resolves for one lock, except the
 * module declarations, which hold across locks, and returns its problems;
 * empty means the convention holds.
 *
 * - layers: no type references a type of a higher layer, and the type graph
 *   has no cycle (§ 3);
 * - modules: a module's types reference only the kernel and the modules its
 *   mapping file lists in `depends`, every listed module is referenced on
 *   some lock, and the declared graph is a DAG (§ 3);
 * - inline: every type position is a named type, the boolean, a named copy,
 *   or a list or map whose items are named types or named copies (§ 4);
 * - beside a reference: a `$ref` carries nothing but a description, and a
 *   shell's slot nothing but `$model` and a description (§ 5);
 * - keywords: every schema the model holds uses standard JSON Schema 2020-12
 *   keywords only (§ 2);
 * - unions: `oneOf` only with a `const` tag in every branch, no `allOf`, and
 *   `anyOf` only where § 8 allows it; every union cites a decision (§ 8);
 * - lists: no two vocabularies, or a vocabulary and a kernel list, have the
 *   same values, and `enum` occurs only where a list is defined (§ 5).
 *
 * `modelStructures` gives the duplication gate every named type in the model.
 */
import type { Constructors } from "./constructors.ts";
import { slots, substitute, renderType } from "./constructors.ts";
import type { NamedStructure } from "./duplication.ts";
import type { Kernel } from "./kernel.ts";
import { inScope, type DecisionRecord, type MappingFile, type TypeRef } from "./mapping.ts";
import { KERNEL_MODULE } from "./mapping-rules.ts";
import type { ModelDoc, ModelType } from "./model.ts";

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const index = (model: ModelDoc) => new Map(model.types.map((t) => [t.name, t]));

/** The strongly connected components of a graph with more than one node or a self-loop: its cycles. */
export function cycles(nodes: string[], edges: (n: string) => string[]): string[][] {
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const known = new Set(nodes);
  const visit = (n: string) => {
    order.set(n, order.size);
    low.set(n, order.get(n)!);
    stack.push(n);
    onStack.add(n);
    for (const m of edges(n)) {
      if (!known.has(m)) continue;
      if (!order.has(m)) {
        visit(m);
        low.set(n, Math.min(low.get(n)!, low.get(m)!));
      } else if (onStack.has(m)) low.set(n, Math.min(low.get(n)!, order.get(m)!));
    }
    if (low.get(n) === order.get(n)) {
      const scc: string[] = [];
      let m: string;
      do {
        m = stack.pop()!;
        onStack.delete(m);
        scc.push(m);
      } while (m !== n);
      if (scc.length > 1 || edges(n).includes(n)) out.push(scc.sort());
    }
  };
  for (const n of [...nodes].sort()) if (!order.has(n)) visit(n);
  return out.sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
}

/** Type rules § 3: a type references only types of its own layer or below, every reference resolves, and no reference chain returns to its start. */
export function layerProblems(model: ModelDoc): string[] {
  const types = index(model);
  const problems: string[] = [];
  for (const t of model.types) {
    for (const r of t.references) {
      const u = types.get(r);
      if (!u) problems.push(`${t.module}: ${t.kind} "${t.name}" references "${r}", which the model doesn't define`);
      else if (u.layer > t.layer) problems.push(`${t.module}: ${t.kind} "${t.name}" (layer ${t.layer}) references the ${u.kind} "${r}" (layer ${u.layer}); a layer uses only the layers below it (type rules § 3)`);
    }
  }
  for (const c of cycles([...types.keys()], (n) => types.get(n)?.references ?? [])) {
    problems.push(`the types ${c.map((n) => `"${n}"`).join(", ")} reference each other in a cycle (type rules § 3)`);
  }
  return problems;
}

/**
 * Type rules § 3, per lock: every reference from a module's type to another
 * module's type goes to the kernel or to a module that the referencing
 * module's mapping file lists in `depends`.
 */
export function moduleProblems(model: ModelDoc, mappings: MappingFile[]): string[] {
  const types = index(model);
  const depends = new Map(mappings.map((m) => [m.module, new Set(m.depends ?? [])]));
  const problems = new Set<string>();
  for (const t of model.types) {
    for (const r of t.references) {
      const target = types.get(r)?.module;
      if (target === undefined || target === t.module || target === KERNEL_MODULE) continue;
      if (t.module === KERNEL_MODULE) problems.add(`kernel: ${t.kind} "${t.name}" references "${r}" of module "${target}"; the kernel references no module (type rules § 3)`);
      else if (!depends.get(t.module)?.has(target)) {
        problems.add(`mapping/${t.module}.yaml: ${t.kind} "${t.name}" references "${r}" of module "${target}", which "depends" doesn't list (type rules § 3)`);
      }
    }
  }
  return [...problems];
}

/**
 * Type rules § 3, across locks: every listed dependency names another
 * module, the kernel aside, and is referenced on at least one lock, and the
 * declared module graph is a DAG.
 */
export function dependsProblems(models: ModelDoc[], mappings: MappingFile[]): string[] {
  const problems: string[] = [];
  const modules = new Set(mappings.map((m) => m.module));
  const used = new Set<string>();
  for (const model of models) for (const m of model.modules) for (const r of m.references) used.add(`${m.name}\u0000${r}`);
  for (const m of mappings) {
    for (const d of m.depends ?? []) {
      if (d === m.module || d === KERNEL_MODULE || !modules.has(d)) problems.push(`${m.file}: "depends" lists "${d}", which is ${d === m.module ? "the module itself" : d === KERNEL_MODULE ? "the kernel, which every module may reference" : "no module"}`);
      else if (!used.has(`${m.module}\u0000${d}`)) problems.push(`${m.file}: "depends" lists "${d}", but no type of "${m.module}" references a type of "${d}" on any lock; remove it`);
    }
  }
  const graph = new Map(mappings.map((m) => [m.module, m.depends ?? []]));
  for (const c of cycles([...graph.keys()], (n) => graph.get(n) ?? [])) problems.push(`the modules ${c.map((n) => `"${n}"`).join(", ")} depend on each other in a cycle; the module graph is a DAG (type rules § 3)`);
  return problems;
}

/** Whether a type in a type position is named or inline as type rules § 4 allows. Returns the problem, or null. */
function positionProblem(t: TypeRef, constructors: Constructors, template: boolean): string | null {
  const inline = (x: TypeRef) => x.kind === "apply" && constructors.constructors.find((c) => c.name === x.constructor)?.naming.from === "inline";
  switch (t.kind) {
    case "named":
    case "boolean":
      return null;
    case "parameter":
      return template ? null : `parameter "${t.name}" outside a template`;
    case "apply": {
      if (!inline(t)) return null;
      const bad = Object.values(t.arguments).filter((a) => !(a.kind === "named" || (a.kind === "apply" && !inline(a)) || (template && a.kind === "parameter")));
      return bad.length === 0 ? null : `${renderType(t)} is inline, and an inline list or map holds named types or named copies only, not ${bad.map(renderType).join(", ")}`;
    }
  }
}

/**
 * Type rules § 4: every property of an object, a document, or a profile,
 * every union branch, and every slot of a template, a part, or a copy (with
 * its arguments bound) is a named type, the boolean, a named copy, or a list
 * or map of named types or named copies.
 */
export function inlineProblems(model: ModelDoc, constructors: Constructors): string[] {
  const problems: string[] = [];
  const check = (where: string, t: TypeRef, template = false) => {
    const p = positionProblem(t, constructors, template);
    if (p) problems.push(`${where}: ${p} (type rules § 4)`);
  };
  for (const t of model.types) {
    const where = `${t.module}: ${t.kind} "${t.name}"`;
    switch (t.kind) {
      case "object":
      case "document":
      case "profile":
        for (const [k, p] of Object.entries(t.properties)) check(`${where}: property "${k}"`, p.type);
        break;
      case "union":
        for (const b of t.any_of) check(`${where}: branch ${renderType(b)}`, b);
        break;
      case "constructor":
        for (const s of slots(t.shell)) check(`${where}: slot`, s.$model, true);
        break;
      case "copy": {
        const c = constructors.constructors.find((x) => x.name === t.of.constructor);
        for (const s of slots(c?.shell ?? {})) check(`${where}: slot`, substitute(s.$model, t.of.arguments));
        break;
      }
    }
  }
  for (const p of constructors.parts) for (const s of slots(p.shell)) check(`kernel: part "${p.name}": slot`, s.$model);
  return problems;
}

/** Every schema the model holds, with where it is: the primitives', the parts', and the copies' filled schemas. */
function schemasOf(model: ModelDoc): { where: string; schema: unknown; type: ModelType }[] {
  return model.types.flatMap((t) => (t.kind === "primitive" || t.kind === "part" || t.kind === "copy" ? [{ where: `${t.module}: ${t.kind} "${t.name}"`, schema: t.schema, type: t }] : []));
}

/** Keywords whose value maps names to schemas. */
const NAME_MAPS = new Set(["properties", "patternProperties", "$defs", "dependentSchemas"]);
/** Keywords whose value is instance data or a list of names, not a schema. */
const DATA = new Set(["const", "enum", "examples", "default", "required", "dependentRequired", "type", "$ref", "$schema", "$id", "description", "title", "pattern", "format"]);

/** Visits every subschema of a schema, with its JSON pointer. A shell's slot is a leaf. */
export function walkSchemas(schema: unknown, visit: (s: Record<string, unknown>, pointer: string) => void, pointer = ""): void {
  if (!isMap(schema)) return;
  visit(schema, pointer);
  if ("$model" in schema) return;
  for (const [k, v] of Object.entries(schema)) {
    if (DATA.has(k)) continue;
    if (NAME_MAPS.has(k) && isMap(v)) for (const [name, s] of Object.entries(v)) walkSchemas(s, visit, `${pointer}/${k}/${name}`);
    else if (Array.isArray(v)) v.forEach((s, i) => walkSchemas(s, visit, `${pointer}/${k}/${i}`));
    else walkSchemas(v, visit, `${pointer}/${k}`);
  }
}

/** The standard JSON Schema 2020-12 keywords the published schema may use (type rules § 2): core identifiers and references, the applicators, the validation keywords, `format`, and four annotations. */
export const KEYWORDS = new Set([
  "$schema", "$id", "$ref", "$defs",
  "anyOf", "oneOf", "allOf", "not", "if", "then", "else", "dependentSchemas", "prefixItems", "items", "contains",
  "properties", "patternProperties", "additionalProperties", "propertyNames", "unevaluatedItems", "unevaluatedProperties",
  "type", "enum", "const", "multipleOf", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum", "maxLength", "minLength", "pattern",
  "maxItems", "minItems", "uniqueItems", "maxContains", "minContains", "maxProperties", "minProperties", "required", "dependentRequired",
  "format", "title", "description", "examples", "default",
]);

/** Type rules § 2: every key of every schema and shell the model holds is a standard 2020-12 keyword; a shell's slot holds `$model` and a description. */
export function keywordProblems(model: ModelDoc): string[] {
  const problems: string[] = [];
  const check = (where: string, schema: unknown, shell: boolean) =>
    walkSchemas(schema, (s, pointer) => {
      for (const k of Object.keys(s)) {
        if (shell && k === "$model" && "$model" in s) continue;
        if (!KEYWORDS.has(k)) problems.push(`${where}${pointer ? ` at ${pointer}` : ""}: "${k}" is no standard JSON Schema 2020-12 keyword the schema may use (type rules § 2)`);
      }
    });
  for (const { where, schema } of schemasOf(model)) check(where, schema, false);
  for (const t of model.types) if (t.kind === "constructor") check(`kernel: constructor "${t.name}": shell`, t.shell, true);
  return problems;
}

/** Type rules § 5: a property never adds a constraint beside its `$ref`, only its description and the default its row states; a slot carries a description at most, and so does every `$ref` in a named type's filled schema. */
export function besideReferenceProblems(model: ModelDoc): string[] {
  const problems: string[] = [];
  const PROPERTY = new Set(["type", "presence", "condition", "cases", "marker", "description", "default", "sources", "given"]);
  for (const { where, schema } of schemasOf(model)) {
    walkSchemas(schema, (s, pointer) => {
      if (!("$ref" in s)) return;
      const extra = Object.keys(s).filter((k) => k !== "$ref" && k !== "description");
      if (extra.length > 0) problems.push(`${where} at ${pointer || "/"}: ${extra.map((k) => `"${k}"`).join(", ")} beside a $ref; constraints live only on named types (type rules § 5)`);
    });
  }
  for (const t of model.types) {
    if (t.kind === "constructor") {
      for (const s of slots(t.shell)) {
        const extra = Object.keys(s).filter((k) => k !== "$model" && k !== "description");
        if (extra.length > 0) problems.push(`kernel: constructor "${t.name}": a slot carries ${extra.map((k) => `"${k}"`).join(", ")}; a slot carries nothing but a description (type rules § 7)`);
      }
    }
    if (t.kind === "object" || t.kind === "document" || t.kind === "profile") {
      for (const [k, p] of Object.entries(t.properties)) {
        const extra = Object.keys(p).filter((x) => !PROPERTY.has(x));
        if (extra.length > 0) problems.push(`${t.module}: ${t.kind} "${t.name}": property "${k}" carries ${extra.map((x) => `"${x}"`).join(", ")} beside its type (type rules § 5)`);
      }
    }
  }
  return problems;
}

/**
 * Type rules § 8: no `allOf` anywhere; no `enum` that holds an integer
 * (§ 6); every `oneOf` branch requires a
 * property whose schema is a `const` that names the branch, with a distinct
 * value per branch, except at the root of a primitive whose values are a few
 * titled integer codes (§ 6); `anyOf` only at the root of a copy whose template is a
 * union, such as `CatalogRefOr`, or of a fallback union. Every union type
 * cites a decision record, which says why the specification leaves it
 * untagged, and has at least two branches.
 */
export function unionProblems(model: ModelDoc, constructors: Constructors): string[] {
  const problems: string[] = [];
  const unionShells = new Set(constructors.constructors.filter((c) => isMap(c.shell) && "anyOf" in c.shell).map((c) => c.name));
  const check = (where: string, schema: unknown, rootAnyOf: boolean, rootCodes = false) =>
    walkSchemas(schema, (s, pointer) => {
      const at = `${where}${pointer ? ` at ${pointer}` : ""}`;
      if ("allOf" in s) problems.push(`${at}: "allOf"; objects are named and referenced whole, so no schema inherits from another (type rules § 8)`);
      if (Array.isArray(s.enum) && s.enum.some((v) => Number.isInteger(v))) problems.push(`${at}: an enum holds an integer; a code is a titled const branch (type rules § 6)`);
      if ("anyOf" in s && !(pointer === "" && rootAnyOf)) problems.push(`${at}: "anyOf" where type rules § 8 allows none: only an open vocabulary and the untagged unions draft 1 requires`);
      // A primitive whose values are a few named codes is titled const branches at its root, which tag no union.
      if ("oneOf" in s && !(pointer === "" && rootCodes && isTitledCodes(s))) {
        const branches = Array.isArray(s.oneOf) ? s.oneOf : [];
        const tags = branches.map((b) => tagOf(b));
        const missing = tags.findIndex((x) => x === null);
        if (missing >= 0) problems.push(`${at}: oneOf branch ${missing} has no required property with a "const" value; oneOf is for tagged unions only (type rules § 8)`);
        else {
          const values = tags.map((x) => JSON.stringify(x));
          if (new Set(values).size !== values.length) problems.push(`${at}: two oneOf branches have the same tag; each tag names one branch (type rules § 8)`);
        }
      }
    });
  for (const { where, schema, type } of schemasOf(model)) check(where, schema, type.kind === "copy" && (type.fallback || unionShells.has(type.of.constructor)), type.kind === "primitive");
  for (const t of model.types) if (t.kind === "constructor") check(`kernel: constructor "${t.name}": shell`, t.shell, unionShells.has(t.name));
  for (const t of model.types) {
    if (t.kind !== "union") continue;
    if (t.decisions.length === 0) problems.push(`${t.module}: union "${t.name}" cites no decision record; every untagged union goes to the implementation feedback through one (type rules § 8)`);
    if (t.any_of.length < 2) problems.push(`${t.module}: union "${t.name}" has ${t.any_of.length} branch(es); a union has at least two`);
  }
  return problems;
}

/** Whether a schema is an integer primitive's titled codes: `type: integer` and `oneOf` two or more titled integer consts and nothing else, as `IntegerFlag`'s `0` (No) and `1` (Yes) (type rules § 6). */
export const isTitledCodes = (s: Record<string, unknown>): boolean =>
  s.type === "integer" &&
  Array.isArray(s.oneOf) &&
  s.oneOf.length >= 2 &&
  s.oneOf.every((b) => isMap(b) && Number.isInteger(b.const) && typeof b.title === "string" && b.title !== "" && Object.keys(b).every((k) => k === "const" || k === "title" || k === "description")) &&
  new Set(s.oneOf.map((b) => (b as { const: number }).const)).size === s.oneOf.length &&
  new Set(s.oneOf.map((b) => (b as { title: string }).title)).size === s.oneOf.length;

/** The tag of a `oneOf` branch: a required property whose schema is a `const`, as `{ property, value }`, or null. */
export function tagOf(branch: unknown): { property: string; value: unknown } | null {
  if (!isMap(branch) || !isMap(branch.properties) || !Array.isArray(branch.required)) return null;
  for (const p of branch.required) {
    const s = (branch.properties as Record<string, unknown>)[p as string];
    if (isMap(s) && "const" in s) return { property: p as string, value: s.const };
  }
  return null;
}

/**
 * The open vocabularies with no core terms that the decisions set aside
 * (`sets_aside`, D-041), on the model's lock, and the problems: an open
 * vocabulary with no core terms that no decision lists, and a listed type
 * that the lock's model lacks, that has terms or is closed, that doesn't
 * rest on the listing decision and its element, or that no property of the
 * field's name holds. A vocabulary that states no terms has no structure, so
 * the duplication and value-list gates set aside exactly this set.
 */
export function unstatedVocabularies(model: ModelDoc, decisions: DecisionRecord[]): { names: Set<string>; problems: string[] } {
  const lock = model.input.lock;
  const problems: string[] = [];
  const names = new Set<string>();
  const types = new Map(model.types.map((t) => [t.name, t]));
  const holders = (name: string) =>
    model.types.flatMap((t) => ("properties" in t ? Object.entries(t.properties).filter(([, p]) => typeNames(p.type).includes(name)).map(([k]) => k) : []));
  for (const d of decisions) {
    for (const x of d.sets_aside ?? []) {
      if (!inScope(x.locks, lock)) continue;
      const where = `${d.file}: sets_aside "${x.type}" (${x.field})`;
      const t = types.get(x.type);
      if (t?.kind !== "vocabulary") problems.push(`${where}: no vocabulary of that name on lock "${lock}"; remove it, or limit it to the locks that have it`);
      else if (!t.open || t.terms.length > 0) problems.push(`${where}: it ${t.open ? `lists ${t.terms.length} core terms` : "is closed"} on lock "${lock}", so it has a structure; remove it`);
      else if (!t.decisions.includes(d.id) || !t.sources.includes(x.ir)) problems.push(`${where}: on lock "${lock}" it rests on ${t.decisions.join(", ") || "no decision"} and ${t.sources.join(", ")}, not on ${d.id} and ${x.ir}`);
      else if (!holders(x.type).includes(x.field.split(".").at(-1)!.replace(/\[\]$/, ""))) problems.push(`${where}: no property named for the field holds it on lock "${lock}"`);
      else names.add(x.type);
    }
  }
  for (const t of model.types) {
    if (t.kind === "vocabulary" && t.open && t.terms.length === 0 && !names.has(t.name) && !problems.some((p) => p.includes(`"${t.name}"`))) {
      problems.push(`${t.module}: vocabulary "${t.name}": an open vocabulary with no core terms on lock "${lock}" that no decision's sets_aside lists with its field; list it, or give it its terms`);
    }
  }
  return { names, problems };
}

/** The named types a type position references. */
const typeNames = (t: TypeRef): string[] => (t.kind === "named" ? [t.name] : t.kind === "apply" ? Object.values(t.arguments).flatMap(typeNames) : []);

/**
 * Type rules § 5: each value list is defined once. No two vocabularies, and
 * no vocabulary and kernel list, have the same values, open or closed, except
 * the open vocabularies with no core terms that a decision sets aside
 * (`unstatedVocabularies`), which list no values; and `enum` occurs only in a
 * primitive, never in a part, a copy, or a shell, where it would be an inline
 * copy of a list. A vocabulary that cites another standard's code list is
 * that list, so two vocabularies of two lists whose codes happen to be the
 * same numbers, such as AdCOM's API frameworks and placement subtypes, are
 * two lists; two vocabularies of one list are one. A specification's own
 * labeled list, as each of AdCOM's lists is, is its codes with their labels,
 * so two such lists are one only when their codes and labels both agree.
 */
export function listProblems(model: ModelDoc, decisions: DecisionRecord[] = []): string[] {
  const unstatedTerms = unstatedVocabularies(model, decisions);
  const problems: string[] = [...unstatedTerms.problems];
  const lists = new Map<string, string[]>();
  const add = (values: unknown[], name: string, list?: string) => {
    const key = JSON.stringify([list ?? null, values.map((v) => JSON.stringify(v)).sort()]);
    lists.set(key, [...(lists.get(key) ?? []), name]);
  };
  for (const t of model.types) {
    // A specification's own labeled list, such as AdCOM's `List: Device Types`, is its codes with their labels: two are one list only when both agree.
    if (t.kind === "vocabulary" && !unstatedTerms.names.has(t.name)) add(t.labeled ? t.terms.map((x) => [x.value, x.annotation ?? null]) : t.terms.map((x) => x.value), t.name, t.list?.name);
    if (t.kind === "primitive" && Array.isArray(t.schema.enum)) add(t.schema.enum, t.name);
  }
  for (const [key, names] of lists) {
    if (names.length > 1) problems.push(`${names.map((n) => `"${n}"`).join(", ")} list the same values ${(JSON.parse(key) as [string | null, string[]])[1].join(", ")}; each list is defined once and referenced (type rules § 5)`);
  }
  const check = (where: string, schema: unknown) =>
    walkSchemas(schema, (s, pointer) => {
      if ("enum" in s) problems.push(`${where}${pointer ? ` at ${pointer}` : ""}: an inline "enum"; a list is a vocabulary or a kernel primitive, referenced where it is used (type rules § 5)`);
    });
  for (const { where, schema, type } of schemasOf(model)) if (type.kind !== "primitive") check(where, schema);
  for (const t of model.types) if (t.kind === "constructor") check(`kernel: constructor "${t.name}": shell`, t.shell);
  return problems;
}

/** A type as the duplication gate fingerprints it: a name for a named type or a copy, and the inline forms spelled out. */
function typeKey(t: TypeRef): unknown {
  switch (t.kind) {
    case "named":
    case "parameter":
      return { $ref: t.name };
    case "boolean":
      return { type: "boolean" };
    case "apply":
      return { apply: t.constructor, ...(t.name ? { name: t.name } : {}), arguments: Object.fromEntries(Object.entries(t.arguments).map(([k, v]) => [k, typeKey(v)])) };
  }
}

/**
 * An open object with no properties and no profile, whose structure the
 * specification never states (D-016). It is named after its field and states
 * nothing, so there is no structure to define twice, and the duplication gate
 * sets it aside. A property a constructor gives an option, as the `id` an
 * object option carries (D-046), is the constructor's, not the object's, so
 * an open option with only that property states nothing either. An open
 * vocabulary with no core terms is set aside only where a decision lists it
 * (`unstatedVocabularies`).
 */
export const unstated = (t: ModelType) => t.kind === "object" && t.open && Object.values(t.properties).every((p) => p.given !== undefined) && t.includes === undefined;

/**
 * Every named type in the model, for the duplication gate (type rules § 5):
 * a primitive, a part, or a copy as its schema; a vocabulary as its terms and
 * openness; an object, a document, or a profile as its properties' types and
 * presence, its openness, and its profile; a union as its branches. An object
 * whose structure is unstated is left out (`unstated`), and so is each
 * vocabulary of `setAside`, the open vocabularies with no core terms that a
 * decision lists (`unstatedVocabularies`).
 */
export function modelStructures(model: ModelDoc, kernel: Kernel, constructors?: Constructors, setAside: Set<string> = new Set()): NamedStructure[] {
  const concept = new Map<string, string>([...kernel.primitives.map((p) => [p.name, p.concept] as const), ...(constructors?.parts ?? []).map((p) => [p.name, p.concept] as const)]);
  const props = (p: Record<string, { type: TypeRef; presence: string }>) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { type: typeKey(v.type), presence: v.presence }]));
  return model.types.flatMap((t): NamedStructure[] => {
    const where = `${t.module}: ${t.kind} "${t.name}"`;
    const named = (structure: unknown, extra: Partial<NamedStructure> = {}) => [{ name: t.name, structure, where, ...extra }];
    switch (t.kind) {
      case "primitive":
      case "part":
        return named(t.schema, concept.has(t.name) ? { concept: concept.get(t.name)! } : {});
      case "copy":
        return named(t.schema, { copyOf: t.application });
      case "vocabulary":
        // In a labeled list a code says nothing by itself; its label is what it means, so two such lists of the same codes are one structure only with the same labels.
        return setAside.has(t.name) ? [] : named({ vocabulary: t.terms.map((x) => (t.labeled && x.annotation !== undefined ? [x.value, x.annotation] : x.value)), open: t.open });
      case "object":
        return unstated(t) ? [] : named({ object: props(t.properties), open: t.open, includes: t.includes ?? null });
      case "document":
        return named({ document: props(t.properties) });
      case "profile":
        return named({ profile: props(t.properties), document: t.document });
      case "union":
        return named({ anyOf: t.any_of.map(typeKey) });
      case "constructor":
        return [];
    }
  });
}

/** Every per-lock convention gate, by name, with its problems. */
export function checkConventions(model: ModelDoc, mappings: MappingFile[], kernel: Kernel, constructors: Constructors, decisions: DecisionRecord[] = []): Record<string, string[]> {
  return {
    layers: layerProblems(model),
    modules: moduleProblems(model, mappings),
    inline: inlineProblems(model, constructors),
    "beside a reference": besideReferenceProblems(model),
    keywords: keywordProblems(model),
    unions: unionProblems(model, constructors),
    lists: listProblems(model, decisions),
  };
}
