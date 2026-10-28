import { join } from "node:path";
import { canonicalJson } from "./canonical.ts";
import type { NamedStructure } from "./duplication.ts";
import { indexElements } from "./elements.ts";
import type { SpecIR } from "./ir-types.ts";
import { assertingAjv, decisionCheck, designCheck, primitiveStructure, type DesignSource, type Kernel, type Primitive } from "./kernel.ts";
import { checkCovers, inScope, readYaml, type Cover, type DecisionRecord, type MappingFile, type Members, type TypeRef } from "./mapping.ts";
import { compileSchema } from "./pipeline.ts";
import { REPO_ROOT } from "./repo.ts";
import { bound, loadBinding } from "./binding.ts";

/** What an argument may be (`kernel/constructors.schema.json`, `parameter.accepts`). */
export type Accepts = "any" | "named" | "string" | "ordered" | "unordered" | "closed";

export interface Parameter {
  name: string;
  accepts: Accepts;
  optional?: boolean;
  /** The parameter whose options this one names: its argument, for a string option, or `Uuid`, an object option's `id` (D-007). */
  names?: string;
  /** The member an object option carries, typed by this parameter's argument and required: its `id` (D-046), and the departure for an option whose members the text lists without it (D-047). */
  carries?: { member: string; decision: string; departure?: string; description: string };
  description: string;
}

export type Naming = { from: "field"; suffix: string } | { from: "argument"; parameter: string; suffix: string } | { from: "inline" };

/** A type position in a shell. */
export interface Slot {
  $model: TypeRef;
  description?: string;
}

/** A shell: JSON Schema 2020-12 keywords whose type positions are slots. The format schema fixes which keywords occur. */
export type Shell = Record<string, unknown>;

export interface VectorBlock {
  arguments: Record<string, TypeRef>;
  valid: unknown[];
  invalid: unknown[];
}

export interface ConstructorRule extends VectorBlock {
  id: string;
  statement: string;
  source: { spec?: Cover[]; decision?: string; decision_locks?: string[] };
}

export interface Sources {
  spec: Cover[];
  standards?: { name: string; url: string }[];
  design?: DesignSource[];
}

export interface Constructor {
  name: string;
  description: string;
  parameters: Parameter[];
  naming: Naming;
  shell: Shell;
  fallback?: { parameter: string; suffix: string; statement: string; decision: string };
  rules?: ConstructorRule[];
  vectors: VectorBlock[];
  sources: Sources;
  /** Why the constructor stays though no lock applies it: the decision that says so. */
  kept?: { decision: string; reason: string };
}

/** A rule on a value of a part (type rules § 9), named `kernel:<Part>:<token>`. */
export interface PartRule {
  id: string;
  statement: string;
  source: { spec?: Cover[]; decision?: string; decision_locks?: string[] };
  valid: unknown[];
  invalid: unknown[];
}

export interface Part {
  name: string;
  description: string;
  /** The concept of `kernel/domains.yaml` the part represents. */
  concept: string;
  shell: Shell;
  /** The decisions behind the members and constraints the sources don't state, each on the locks it lists; without `locks`, on every lock. */
  decisions?: { decision: string; locks?: string[] }[];
  rules?: PartRule[];
  sources: Sources;
  vectors: { valid: unknown[]; invalid: unknown[] };
}

export interface Constructors {
  format: 1;
  constructors: Constructor[];
  parts: Part[];
  /** The file the constructors came from, for messages. */
  file: string;
  /** The spec's kernel binding the spec sources and decisions came from (src/binding.ts); none for the definitions alone. */
  binding?: string;
}

export const CONSTRUCTORS_FILE = join("kernel", "constructors.yaml");
const CONSTRUCTORS_SCHEMA = join("kernel", "constructors.schema.json");

/**
 * Loads `kernel/constructors.yaml` from `root`, with a spec's kernel binding
 * merged in (`spec`, the spec's folder; null for the definitions alone), and
 * validates it against its schema. Throws if it is invalid.
 */
export function loadConstructors(root: string, spec: string | null, file = join(root, CONSTRUCTORS_FILE)): Constructors {
  const binding = spec === null ? null : loadBinding(spec);
  const raw = readYaml(file) as { constructors?: unknown[]; parts?: unknown[] };
  const doc = bound("constructors", file, raw, binding);
  const refs = [join(REPO_ROOT, "mapping", "mapping.schema.json"), join(REPO_ROOT, "kernel", "kernel.schema.json")];
  const errors = compileSchema(join(REPO_ROOT, CONSTRUCTORS_SCHEMA), refs)(doc);
  // The kernel file defines templates and parts; a spec's binding may leave them all out of its kernel, the file never.
  if (!Array.isArray(raw.constructors) || raw.constructors.length === 0 || !Array.isArray(raw.parts) || raw.parts.length === 0) errors.push("the kernel file defines no constructor or no part; it holds at least one of each, and a spec's binding leaves out the ones its text never uses");
  if (errors.length > 0) throw new Error(`${file}${binding ? ` with ${binding.file}` : ""}: not a valid constructors file: ${errors.join("; ")}`);
  return { ...(doc as Omit<Constructors, "file" | "binding">), file, ...(binding ? { binding: binding.file } : {}) };
}

/** The kernel and the constructors: every named type a template may reference. */
export interface Model {
  kernel: Kernel;
  constructors: Constructors;
}

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isSlot = (v: unknown): v is Slot => isMap(v) && "$model" in v;

/** Every slot in a shell, in document order. */
export function slots(shell: unknown): Slot[] {
  if (isSlot(shell)) return [shell];
  if (Array.isArray(shell)) return shell.flatMap(slots);
  if (isMap(shell)) return Object.values(shell).flatMap(slots);
  return [];
}

/** Every type reference in a type, including itself and its arguments at any depth. */
function refsIn(t: TypeRef): TypeRef[] {
  return t.kind === "apply" ? [t, ...Object.values(t.arguments).flatMap(refsIn)] : [t];
}

/** Replaces each parameter in `t` by its argument from `env`. A parameter that `env` doesn't bind stays as it is. */
export function substitute(t: TypeRef, env: Record<string, TypeRef>): TypeRef {
  if (t.kind === "parameter") return env[t.name] ?? t;
  if (t.kind !== "apply") return t;
  const args = Object.fromEntries(Object.entries(t.arguments).map(([k, v]) => [k, substitute(v, env)]));
  return { ...t, arguments: args };
}

/** `negotiation_history[]` and `pricing[].floor` name the fields `NegotiationHistory` and `Floor`. */
export function pascalField(field: string): string {
  const last = field.split(".").pop()!.replaceAll("[]", "");
  return last
    .split("_")
    .filter((w) => w !== "")
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
}

/** A model type name, as `mapping/mapping.schema.json` defines it. */
export const TYPE_NAME = /^[A-Z][A-Za-z0-9]*$/;

/**
 * The field that a mapping entry's IR element names, for naming its copies
 * (type rules § 7), or the reason it names none. A field or key row names the
 * field in its path, such as `pricing[].floor`. A member of an inline object
 * has the ID `<object ID>/<member path>`, the form the IR gives a member's
 * value list, so `field:5.5:frequency_cap#description/object:1/max` names
 * `max`, whether or not the member has a row of its own. Anything else, such
 * as the object itself or a row that names two fields, names no one field.
 */
export function fieldOf(ir: string): { field: string } | { problem: string } {
  const hash = ir.indexOf("#");
  if (hash >= 0) {
    const member = /\/object:\d+\/([^/]+)$/.exec(ir.slice(hash));
    if (member) return { field: member[1]! };
    return { problem: `"${ir}" names no field, key, or object member` };
  }
  const row = /^(?:field|key):[^:]+:(.+)$/.exec(ir);
  if (!row) return { problem: `"${ir}" names no field, key, or object member` };
  if (row[1]!.includes(",")) return { problem: `"${ir}" names more than one field` };
  return { field: row[1]! };
}

/** Renders a type for messages, as in `Selectable<CatalogRefOr<Audience>>`. */
export function renderType(t: TypeRef): string {
  switch (t.kind) {
    case "named":
    case "parameter":
      return t.name;
    case "boolean":
      return "boolean";
    case "apply":
      return `${t.constructor}<${Object.entries(t.arguments)
        .map(([k, v]) => `${k}=${renderType(v)}`)
        .join(", ")}>`;
  }
}

/**
 * Names the concrete copy of an application (type rules § 7), or returns
 * `null` for a constructor that is emitted inline. `field` is the field that
 * uses the copy. A name the mapping gives overrides the derived one.
 */
export function copyName(model: Model, t: Extract<TypeRef, { kind: "apply" }>, field?: string): string | null {
  if (t.name !== undefined) return t.name;
  const c = model.constructors.constructors.find((x) => x.name === t.constructor);
  if (!c) throw new Error(`no constructor "${t.constructor}"`);
  switch (c.naming.from) {
    case "inline":
      return null;
    case "field":
      if (field === undefined) throw new Error(`a copy of ${c.name} is named after its field, and none is given; name the copy with a decision record`);
      return pascalField(field) + c.naming.suffix;
    case "argument": {
      const arg = t.arguments[c.naming.parameter];
      if (arg?.kind === "named") return arg.name + c.naming.suffix;
      if (arg?.kind === "apply") {
        const inner = copyName(model, arg, field);
        if (inner !== null) return inner + c.naming.suffix;
      }
      throw new Error(`a copy of ${c.name} is named after its argument ${c.naming.parameter}, which must be a named type or a named copy, not ${arg ? renderType(arg) : "nothing"}`);
    }
  }
}

/** The JSON Schema that a reference to the named type `name` becomes. */
export type RefFor = (name: string) => string;
const localRef: RefFor = (name) => `#/$defs/${name}`;

/**
 * Applies templates. Each named copy it makes is recorded in `copies` under
 * its name, so a bundle can hold every copy a schema references.
 */
export class Instantiator {
  readonly copies = new Map<string, { schema: Record<string, unknown>; type: string; of: Extract<TypeRef, { kind: "apply" }>; fallback: boolean }>();
  private readonly byName: Map<string, Constructor>;

  constructor(
    private readonly model: Model,
    private readonly ref: RefFor = localRef,
  ) {
    this.byName = new Map(model.constructors.constructors.map((c) => [c.name, c]));
  }

  private constructorOf(name: string): Constructor {
    const c = this.byName.get(name);
    if (!c) throw new Error(`no constructor "${name}"`);
    return c;
  }

  /** The schema of a closed type: a reference to a named type or a copy, the boolean, or an inline list or map. */
  schemaOf(t: TypeRef, field?: string): Record<string, unknown> {
    switch (t.kind) {
      case "named":
        return { $ref: this.ref(t.name) };
      case "boolean":
        return { type: "boolean" };
      case "parameter":
        throw new Error(`parameter "${t.name}" is unbound`);
      case "apply": {
        const c = this.constructorOf(t.constructor);
        if (c.naming.from === "inline") return this.fill(c.shell, t.arguments, field) as Record<string, unknown>;
        return { $ref: this.ref(this.copy(t, field)) };
      }
    }
  }

  /**
   * Makes the named copy of an application and returns the name a property
   * references: the union with the bare value when the use supplies the
   * fallback parameter, otherwise the full form.
   */
  copy(t: Extract<TypeRef, { kind: "apply" }>, field?: string): string {
    const c = this.constructorOf(t.constructor);
    const name = copyName(this.model, t, field);
    if (name === null) throw new Error(`${c.name} is emitted inline and has no copy`);
    this.record(name, { description: c.description, ...(this.fill(c.shell, t.arguments, field) as Record<string, unknown>) }, t, false);
    const bare = c.fallback ? t.arguments[c.fallback.parameter] : undefined;
    if (!c.fallback || bare === undefined) return name;
    const union = name + c.fallback.suffix;
    this.record(union, { description: c.description, anyOf: [this.schemaOf(bare, field), { $ref: this.ref(name) }] }, t, true);
    return union;
  }

  /** Records a copy under its name. `of` is the application it copies; `fallback` marks the union with the bare value. */
  private record(name: string, schema: Record<string, unknown>, of: Extract<TypeRef, { kind: "apply" }>, fallback: boolean): void {
    const type = fallback ? `${renderType(of)} or its bare value` : renderType(of);
    const seen = this.copies.get(name);
    if (seen && canonicalJson(seen.schema) !== canonicalJson(schema)) {
      throw new Error(`two different copies are both named "${name}": ${seen.type} and ${type}`);
    }
    if (!seen) this.copies.set(name, { schema, type, of, fallback });
  }

  /** Replaces each slot of a shell with the schema of its type, with the parameters bound to `args`. */
  fill(shell: unknown, args: Record<string, TypeRef>, field?: string): unknown {
    if (isSlot(shell)) {
      const { $model, ...rest } = shell;
      return { ...rest, ...this.schemaOf(substitute($model, args), field) };
    }
    if (Array.isArray(shell)) return shell.map((s) => this.fill(s, args, field));
    if (isMap(shell)) return Object.fromEntries(Object.entries(shell).map(([k, v]) => [k, this.fill(v, args, field)]));
    return shell;
  }
}

/** A model with no types, for filling a shell whose slots name only named types. */
const NO_TYPES: Model = { kernel: { format: 1, primitives: [], file: "" }, constructors: { format: 1, constructors: [], parts: [], file: "" } };

/**
 * A part as the schema every use references. A part's slots name primitives,
 * other parts, and lists of them, so filling it needs the inline `List`
 * constructor and nothing else.
 */
export function partSchema(p: Part, constructors?: Constructors): Record<string, unknown> {
  const inline = (constructors?.constructors ?? []).filter((c) => c.naming.from === "inline");
  const model: Model = { ...NO_TYPES, constructors: { ...NO_TYPES.constructors, constructors: inline } };
  return { description: p.description, ...(new Instantiator(model).fill(p.shell, {}) as Record<string, unknown>) };
}

/**
 * A standalone schema for one type, with every primitive, part, and copy it
 * needs in `$defs`. `parts` overrides a part's schema, as the resolved model
 * will.
 */
export function bundle(model: Model, t: TypeRef, field = "vector"): Record<string, unknown> {
  const inst = new Instantiator(model);
  const root = t.kind === "apply" && copyName(model, t, field) !== null ? { $ref: localRef(inst.copy(t, field)) } : inst.schemaOf(t, field);
  const defs: Record<string, unknown> = {};
  for (const p of model.kernel.primitives) defs[p.name] = { description: p.description, ...primitiveStructure(p) };
  for (const p of model.constructors.parts) defs[p.name] = partSchema(p, model.constructors);
  for (const [name, c] of inst.copies) defs[name] = c.schema;
  return { $schema: "https://json-schema.org/draft/2020-12/schema", $defs: defs, ...root };
}

/** The parts as named types, for the duplication gate, each with the concept it represents. */
export function partStructures(c: Constructors): NamedStructure[] {
  return c.parts.map((p) => ({ name: p.name, structure: partSchema(p, c), concept: p.concept, where: c.file }));
}

const ORDERED_FORMATS = new Set(["date-time"]);

/** Whether a primitive's values are ordered: a number or a date-time. */
const isOrdered = (p: Primitive) => p.type !== "string" || ORDERED_FORMATS.has(p.constraints.format ?? "");

/** What an accepts kind admits, in words, for messages. */
const ACCEPTS: Record<Exclude<Accepts, "any">, string> = {
  named: "a named type or a named copy",
  string: "a type whose values are strings",
  ordered: "a primitive whose values are ordered (a number or a date-time)",
  unordered: "a named type or a named copy that isn't an ordered primitive, so it has no `min` / `max` range",
  closed: "a type whose values aren't objects, or are objects that reject the members they don't name, so a value can't carry both it and a `catalog_ref`",
};

/** Whether a parameter that accepts `inner` may be passed where `outer` is accepted. */
function narrows(inner: Accepts, outer: Accepts): boolean {
  if (outer === "any" || inner === outer) return true;
  if (outer === "named") return inner !== "any";
  if (outer === "closed") return inner === "string" || inner === "ordered";
  return false;
}

/** A type the mapping defines, by an entry or a declaration, as the constructor checks see it. */
export interface MappedType {
  layer: "primitive" | "constructor" | "vocabulary" | "object" | "document" | "union";
  /** An object's or a vocabulary's `open`. */
  open?: boolean;
  /** A union's branches. */
  anyOf?: TypeRef[];
}

/** The types the mapping defines, by name: each type entry and each declaration. */
export function mappedTypes(mappings: MappingFile[]): Map<string, MappedType> {
  const types = new Map<string, MappedType>();
  for (const m of mappings) {
    for (const e of m.entries) if (e.as.role === "type") types.set(e.as.name, { layer: e.as.layer, ...(e.as.open === undefined ? {} : { open: e.as.open }) });
    for (const d of m.types ?? []) {
      types.set(d.name, { layer: d.kind, ...(d.open === undefined ? {} : { open: d.open }), ...(d.any_of ? { anyOf: d.any_of } : {}) });
    }
  }
  return types;
}

/**
 * Whether a type's values can carry members the type doesn't name. A
 * primitive and the boolean are scalars, a part or a copy is as closed as its
 * shell, and a vocabulary's values are strings. An object the mapping
 * defines is as closed as its `open` says, a document is closed, and a union
 * is as closed as its branches. A type the model doesn't know is unknown.
 */
function closedness(model: Model, t: TypeRef, layers: ReadonlyMap<string, MappedType>, seen = new Set<string>()): "closed" | "open" | "unknown" {
  if (t.kind === "boolean") return "closed";
  if (t.kind === "parameter") return "unknown";
  if (t.kind === "named") {
    if (model.kernel.primitives.some((p) => p.name === t.name)) return "closed";
    const part = model.constructors.parts.find((p) => p.name === t.name);
    if (part) return shellClosedness(model, part.shell, {}, layers);
    const mapped = layers.get(t.name);
    if (mapped === undefined || seen.has(t.name)) return "unknown";
    switch (mapped.layer) {
      case "vocabulary":
      case "document":
        return "closed";
      case "object":
        return mapped.open === undefined ? "unknown" : mapped.open ? "open" : "closed";
      case "union": {
        const branches = (mapped.anyOf ?? []).map((b) => closedness(model, b, layers, new Set([...seen, t.name])));
        return branches.includes("open") ? "open" : branches.includes("unknown") ? "unknown" : "closed";
      }
      default:
        return "unknown";
    }
  }
  const c = model.constructors.constructors.find((x) => x.name === t.constructor);
  return c ? shellClosedness(model, c.shell, t.arguments, layers) : "unknown";
}

function shellClosedness(model: Model, shell: Shell, args: Record<string, TypeRef>, layers: ReadonlyMap<string, MappedType>): "closed" | "open" | "unknown" {
  if (shell.type === "array") return "closed";
  if (shell.type === "object") return shell.additionalProperties === false ? "closed" : "open";
  const branches = slots(shell).map((s) => closedness(model, substitute(s.$model, args), layers));
  return branches.includes("open") ? "open" : branches.includes("unknown") ? "unknown" : "closed";
}

/**
 * Checks an application's constructor and arguments, and returns the
 * problems. `params` are the parameters in scope, inside a template; a
 * parameter outside a template is a problem. `layers` gives the layer of
 * each type the mapping defines.
 */
function applicationProblems(model: Model, t: TypeRef, where: string, params: Map<string, Parameter> | null, layers: ReadonlyMap<string, MappedType> = new Map()): string[] {
  const problems: string[] = [];
  const constructors = new Map(model.constructors.constructors.map((c) => [c.name, c]));
  const primitives = new Map(model.kernel.primitives.map((p) => [p.name, p]));
  const parts = new Set(model.constructors.parts.map((p) => p.name));
  const isInline = (r: TypeRef) => r.kind === "apply" && constructors.get(r.constructor)?.naming.from === "inline";

  const accepts = (arg: TypeRef, accept: Accepts, what: string) => {
    if (arg.kind === "parameter") {
      const p = params?.get(arg.name);
      if (p && !narrows(p.accepts, accept)) problems.push(`${where}: ${what} accepts ${accept}, but parameter ${p.name} accepts ${p.accepts}`);
      return;
    }
    if (accept === "any") return;
    const fail = () => problems.push(`${where}: ${what} accepts ${ACCEPTS[accept]}, not ${renderType(arg)}`);
    const named = arg.kind === "named" || (arg.kind === "apply" && !isInline(arg));
    if (!named) {
      problems.push(`${where}: ${what} accepts ${ACCEPTS.named}, not ${renderType(arg)} (type rules § 4)`);
      return;
    }
    const prim: Primitive | undefined = arg.kind === "named" ? primitives.get(arg.name) : undefined;
    switch (accept) {
      case "named":
        return;
      case "string":
        if (arg.kind === "apply" || parts.has((arg as { name: string }).name) || (prim && prim.type !== "string")) fail();
        return;
      case "ordered":
        if (!prim || !isOrdered(prim)) fail();
        return;
      case "unordered":
        if (prim && isOrdered(prim)) fail();
        return;
      case "closed": {
        const c = closedness(model, arg, layers);
        if (c === "open") fail();
        if (c === "unknown") {
          problems.push(`${where}: ${what} accepts ${ACCEPTS.closed}, and the model doesn't say whether ${renderType(arg)} is closed (rule:2.2:696ee27b)`);
        }
        return;
      }
    }
  };

  for (const r of refsIn(t)) {
    if (r.kind === "named") {
      if (constructors.has(r.name)) problems.push(`${where}: "${r.name}" is a constructor; apply it instead of naming it`);
      else if (params !== null && !primitives.has(r.name) && !parts.has(r.name)) problems.push(`${where}: "${r.name}" is neither a primitive nor a part`);
    } else if (r.kind === "parameter") {
      if (params === null) problems.push(`${where}: parameter "${r.name}" outside a template`);
      else if (!params.has(r.name)) problems.push(`${where}: parameter "${r.name}" isn't declared`);
    } else if (r.kind === "apply") {
      const c = constructors.get(r.constructor);
      if (!c) {
        problems.push(`${where}: no constructor "${r.constructor}"`);
        continue;
      }
      if (params !== null && r.name !== undefined) problems.push(`${where}: a template can't override the name of a ${c.name} copy`);
      const declared = new Map(c.parameters.map((p) => [p.name, p]));
      for (const k of Object.keys(r.arguments)) if (!declared.has(k)) problems.push(`${where}: ${c.name} has no parameter "${k}"`);
      for (const p of c.parameters) {
        const arg = r.arguments[p.name];
        if (arg === undefined) {
          if (!p.optional) problems.push(`${where}: ${c.name} needs an argument for ${p.name}`);
          continue;
        }
        accepts(arg, p.accepts, `${c.name}'s ${p.name}`);
        const option = p.names === undefined ? undefined : r.arguments[p.names];
        const want = option === undefined || arg.kind === "parameter" ? null : optionName(model, option, layers);
        if (want !== null && canonicalJson(want) !== canonicalJson(arg)) {
          problems.push(`${where}: ${c.name}'s ${p.name} names an option of ${p.names}, ${renderType(option!)}, so it is ${renderType(want)}, not ${renderType(arg)}: a string option is named by its value, and an object option by its \`id\`, a \`Uuid\` (D-007)`);
        }
      }
    }
  }
  return problems;
}

/**
 * The type that names an option of type `t` (D-007): a string option, a
 * string primitive or a vocabulary, is named by its value, so by `t` itself,
 * and an object option, an object, a part, a union, or a copy, by its `id`, a
 * `Uuid`, the identity a party mints. Null for a parameter, inside a
 * template, where the argument isn't known.
 */
export function optionName(model: Model, t: TypeRef, layers: ReadonlyMap<string, MappedType>): TypeRef | null {
  if (t.kind === "parameter") return null;
  if (t.kind === "named") {
    const prim = model.kernel.primitives.find((p) => p.name === t.name);
    if (prim?.type === "string" || layers.get(t.name)?.layer === "vocabulary") return t;
  }
  return { kind: "named", name: "Uuid" };
}

/**
 * The nesting gate (type rules § 7): no constructor occurs inside an
 * application of itself, in the arguments or in the shells the application
 * expands to. A named type ends the expansion, because it is referenced, not
 * nested: its own definition is checked on its own. Returns the problems.
 */
export function nestingProblems(model: Model, t: TypeRef, where: string): string[] {
  const constructors = new Map(model.constructors.constructors.map((c) => [c.name, c]));
  const problems = new Set<string>();
  const walk = (r: TypeRef, stack: string[]) => {
    if (r.kind !== "apply") return;
    const c = constructors.get(r.constructor);
    if (!c) return;
    const path = [...stack, c.name];
    if (stack.includes(c.name)) {
      problems.add(`${where}: ${c.name} is nested inside itself: ${path.join(" > ")}`);
      return;
    }
    for (const arg of Object.values(r.arguments)) walk(arg, path);
    for (const s of slots(c.shell)) if (s.$model.kind === "apply") walk(substitute(s.$model, r.arguments), path);
  };
  walk(t, []);
  return [...problems];
}

/** The application of a constructor to its own parameters, which stands for the template. */
const generic = (c: Constructor): Extract<TypeRef, { kind: "apply" }> => ({
  kind: "apply",
  constructor: c.name,
  arguments: Object.fromEntries(c.parameters.map((p) => [p.name, { kind: "parameter", name: p.name } as TypeRef])),
});

/**
 * The lock-independent constructor checks. Returns the problems; empty means
 * the templates are sound:
 *
 * - constructor, part, and parameter names are unique, and none is a primitive;
 * - every slot names a primitive, a part, a declared parameter, or an
 *   application whose arguments fit the parameters; a part's slots name
 *   primitives, other parts, and lists of them (the domain gate checks that
 *   each part is used);
 * - every required parameter is used, and an optional one is only a fallback
 *   that the shell doesn't use; only a named copy has a fallback, and a copy
 *   named after its argument takes a named argument;
 * - every vector gets its verdict from Ajv as an asserting 2020-12 validator,
 *   and the schema accepts every rule vector, so a rule adds what the schema
 *   can't; a rule's ID names its owner and is unique;
 * - every design source and decision exists, and no decision is superseded or withdrawn.
 */
export function checkConstructors(root: string, model: Model, decisions: DecisionRecord[]): string[] {
  const problems: string[] = [];
  const { constructors: file } = model;
  const citesDecision = decisionCheck(decisions, problems);
  const design = designCheck(root, problems);
  const primitives = new Set(model.kernel.primitives.map((p) => p.name));
  const names = new Set<string>();
  for (const n of [...file.constructors.map((c) => c.name), ...file.parts.map((p) => p.name)]) {
    if (names.has(n)) problems.push(`${file.file}: "${n}" is defined twice`);
    if (primitives.has(n)) problems.push(`${file.file}: "${n}" is a kernel primitive`);
    names.add(n);
  }

  const rules = new Set<string>();
  for (const c of file.constructors) {
    const where = `${file.file}: ${c.name}`;
    const params = new Map<string, Parameter>();
    for (const p of c.parameters) {
      if (params.has(p.name)) problems.push(`${where}: parameter ${p.name} is declared twice`);
      params.set(p.name, p);
    }
    const shellRefs = slots(c.shell).flatMap((s) => refsIn(s.$model));
    for (const s of slots(c.shell)) problems.push(...applicationProblems(model, s.$model, `${where}: shell`, params));
    const inShell = new Set(shellRefs.filter((r) => r.kind === "parameter").map((r) => (r as { name: string }).name));
    for (const p of c.parameters) {
      const isFallback = c.fallback?.parameter === p.name;
      if (isFallback && (!p.optional || inShell.has(p.name))) problems.push(`${where}: the fallback parameter ${p.name} must be optional and unused in the shell`);
      if (!isFallback && p.optional) problems.push(`${where}: parameter ${p.name} is optional but isn't the fallback`);
      if (!isFallback && !inShell.has(p.name)) problems.push(`${where}: parameter ${p.name} isn't used in the shell`);
    }
    if (c.fallback && !params.has(c.fallback.parameter)) problems.push(`${where}: the fallback parameter ${c.fallback.parameter} isn't declared`);
    if (c.fallback) citesDecision(`${where}: fallback`, c.fallback.decision);
    for (const p of c.parameters) {
      if (p.carries) citesDecision(`${where}: parameter ${p.name} carries`, p.carries.decision);
      if (p.carries?.departure) citesDecision(`${where}: parameter ${p.name} carries`, p.carries.departure);
    }
    if (c.fallback && c.naming.from === "inline") problems.push(`${where}: an inline constructor can't have a fallback, which is a named union`);
    if (c.fallback && !c.sources.spec.some((s) => s.ir === c.fallback!.statement)) problems.push(`${where}: the fallback statement "${c.fallback.statement}" isn't one of its spec sources`);
    if ("anyOf" in c.shell && c.naming.from === "inline") problems.push(`${where}: a union is named, so it can't be emitted inline`);
    if (c.naming.from === "argument") {
      const p = params.get(c.naming.parameter);
      if (!p || p.accepts === "any") problems.push(`${where}: a copy named after ${c.naming.parameter} needs a parameter that accepts a named type`);
    }

    const verdicts = (block: VectorBlock, what: string, all: boolean | null) => {
      const app: TypeRef = { kind: "apply", constructor: c.name, arguments: block.arguments };
      const bad = [...applicationProblems(model, app, `${where}: ${what}`, null), ...nestingProblems(model, app, `${where}: ${what}`)];
      problems.push(...bad);
      if (bad.length > 0) return;
      let validate;
      try {
        validate = assertingAjv().compile(bundle(model, app));
      } catch (e) {
        problems.push(`${where}: ${what}: the copy doesn't compile: ${(e as Error).message}`);
        return;
      }
      const check = (v: unknown, expected: boolean, kind: string) => {
        if (validate(v) !== expected) problems.push(`${where}: ${what}: ${kind} ${JSON.stringify(v)} is ${expected ? "rejected" : "accepted"} by the copy ${renderType(app)}`);
      };
      for (const v of block.valid) check(v, true, all === null ? "valid vector" : "rule vector");
      for (const v of block.invalid) check(v, all === null ? false : true, all === null ? "invalid vector" : "rule vector");
    };
    c.vectors.forEach((b, i) => verdicts(b, `vectors[${i}]`, null));
    for (const r of c.rules ?? []) {
      if (rules.has(r.id)) problems.push(`${where}: rule "${r.id}" is defined twice`);
      rules.add(r.id);
      if (r.id.split(":")[1] !== c.name) problems.push(`${where}: rule "${r.id}" must be named constructor:${c.name}:<token>, after the constructor that owns it`);
      if (r.source.decision !== undefined) citesDecision(`${where}: rule "${r.id}"`, r.source.decision);
      verdicts(r, `rule "${r.id}"`, true);
    }
    design(where, c.sources.design ?? []);
  }

  const partNames = new Set(file.parts.map((p) => p.name));
  for (const p of file.parts) {
    const where = `${file.file}: ${p.name}`;
    for (const s of slots(p.shell)) {
      const t = s.$model;
      const item = t.kind === "apply" && t.constructor === "List" ? t.arguments.T : t;
      if (item?.kind !== "named" || !(primitives.has(item.name) || partNames.has(item.name)) || item.name === p.name) {
        problems.push(`${where}: a part references primitives, other parts, and lists of them only, not ${renderType(t)}`);
      }
    }
    let validate;
    try {
      validate = assertingAjv().compile(bundle(model, { kind: "named", name: p.name }));
    } catch (e) {
      problems.push(`${where}: the part doesn't compile: ${(e as Error).message}`);
      continue;
    }
    for (const v of p.vectors.valid) if (!validate(v)) problems.push(`${where}: valid vector ${JSON.stringify(v)} is rejected`);
    for (const v of p.vectors.invalid) if (validate(v)) problems.push(`${where}: invalid vector ${JSON.stringify(v)} is accepted`);
    for (const r of p.rules ?? []) {
      if (rules.has(r.id)) problems.push(`${where}: rule "${r.id}" is defined twice`);
      rules.add(r.id);
      if (r.id.split(":")[1] !== p.name) problems.push(`${where}: rule "${r.id}" must be named kernel:${p.name}:<token>, after the part that owns it`);
      if (r.source.decision !== undefined) citesDecision(`${where}: rule "${r.id}"`, r.source.decision);
      for (const v of [...r.valid, ...r.invalid]) if (!validate(v)) problems.push(`${where}: rule "${r.id}" vector ${JSON.stringify(v)} is rejected by the part's schema`);
    }
    for (const d of p.decisions ?? []) citesDecision(where, d.decision);
    design(where, p.sources.design ?? []);
  }
  return problems;
}

/**
 * Checks the constructors' spec sources against one lock's IR: every source,
 * a constructor's, a part's, and a rule's, names an element with its current
 * digest and quote, and every constructor and part cites at least one element
 * on the lock. A changed row makes what rests on it stale.
 */
export function checkConstructorSources(ir: SpecIR, lock: string, c: Constructors): string[] {
  const problems: string[] = [];
  const elements = indexElements(ir);
  for (const x of [...c.constructors, ...c.parts]) {
    const where = `${c.binding ?? c.file}: ${x.name}`;
    checkCovers(where, x.sources.spec, elements, lock, problems);
    if (!x.sources.spec.some((s) => inScope(s.locks, lock))) problems.push(`${where}: cites no spec row on lock "${lock}"`);
    for (const r of ("rules" in x ? x.rules : undefined) ?? []) checkCovers(`${where}: rule "${r.id}"`, r.source.spec ?? [], elements, lock, problems);
  }
  return problems;
}

/**
 * The nesting gate over the whole model (type rules § 7): no template nests a
 * constructor inside itself, and neither does any type the mapping states
 * (`typeUses`). Returns the problems.
 */
export function checkNesting(model: Model, mappings: MappingFile[]): string[] {
  const problems = model.constructors.constructors.flatMap((c) => nestingProblems(model, generic(c), `${model.constructors.file}: ${c.name}: template`));
  for (const u of typeUses(mappings)) problems.push(...nestingProblems(model, u.type, u.where));
  return problems;
}

/**
 * The constructors the mapping applies on some lock: each one an entry or a
 * declaration applies, at any depth of its arguments, and each one the shell
 * of an applied constructor or of a part the mapping reaches applies, as
 * `Selectable`'s `pricing` applies `Map`.
 */
export function appliedConstructors(model: Model, mappings: MappingFile[]): Set<string> {
  const byName = new Map(model.constructors.constructors.map((c) => [c.name, c]));
  const parts = new Map(model.constructors.parts.map((p) => [p.name, p]));
  const applied = new Set<string>();
  const seenParts = new Set<string>();
  const visit = (t: TypeRef): void => {
    for (const r of refsIn(t)) {
      if (r.kind === "apply" && !applied.has(r.constructor)) {
        applied.add(r.constructor);
        const c = byName.get(r.constructor);
        if (c) for (const s of slots(c.shell)) visit(s.$model);
      }
      if (r.kind === "named" && parts.has(r.name) && !seenParts.has(r.name)) {
        seenParts.add(r.name);
        for (const s of slots(parts.get(r.name)!.shell)) visit(s.$model);
      }
    }
  };
  for (const u of typeUses(mappings)) visit(u.type);
  return applied;
}

/**
 * Every constructor is applied on some lock (`appliedConstructors`), or its
 * `kept` cites a decision that says why it stays: a template no field uses
 * is a form the specification doesn't write. A `kept` on a constructor that
 * is applied is stale. Returns the problems.
 */
export function checkApplied(model: Model, mappings: MappingFile[], decisions: DecisionRecord[]): string[] {
  const problems: string[] = [];
  const citesDecision = decisionCheck(decisions, problems);
  const applied = appliedConstructors(model, mappings);
  for (const c of model.constructors.constructors) {
    const where = `${model.constructors.file}: ${c.name}`;
    if (c.kept) citesDecision(`${where}: kept`, c.kept.decision);
    if (applied.has(c.name) && c.kept) problems.push(`${where}: is applied on some lock, so its \`kept\` is stale; remove it`);
    if (!applied.has(c.name) && !c.kept) problems.push(`${where}: no mapping entry or applied template applies it on any lock; apply it, remove it, or cite under \`kept\` the decision that says why it stays`);
  }
  return problems;
}

/** One type the mapping states, where it states it, and the field its copies are named after, or why it names none. */
export interface TypeUse {
  where: string;
  type: TypeRef;
  field: { field: string } | { problem: string };
}

/**
 * Every type the mapping states: a property's type, named after the field
 * its entry's IR element names (`fieldOf`); a member's type, named after the
 * member; and a union branch, named after the field the declaration's IR
 * element names.
 */
export function typeUses(mappings: MappingFile[]): TypeUse[] {
  const uses: TypeUse[] = [];
  const members = (where: string, m: Members | undefined) => {
    for (const [key, v] of Object.entries(m ?? {})) uses.push({ where: `${where}: member "${key}"`, type: v.type, field: { field: key } });
  };
  for (const m of mappings) {
    for (const e of m.entries) {
      const where = `${m.file}: entry "${e.ir}"`;
      if (e.as.role === "property") uses.push({ where, type: e.as.type, field: fieldOf(e.ir) });
      if (e.as.role === "type" || e.as.role === "members" || e.as.role === "profile") members(where, e.as.members);
    }
    for (const d of m.types ?? []) {
      const where = `${m.file}: type "${d.name}"`;
      members(where, d.members);
      const field = d.ir === undefined ? { problem: `the declaration of "${d.name}" names no IR element` } : fieldOf(d.ir);
      for (const t of d.any_of ?? []) uses.push({ where, type: t, field });
    }
  }
  return uses;
}

/**
 * Applies every constructor application in the mapping (`typeUses`). Returns
 * the instantiator, which holds the copies, and the problems: an application
 * that doesn't fit its constructor, nests one inside itself, or has no name,
 * and two different copies with one name.
 */
function instantiateMapping(model: Model, mappings: MappingFile[]): { inst: Instantiator; problems: string[] } {
  const problems: string[] = [];
  const layers = mappedTypes(mappings);
  const inst = new Instantiator(model);
  for (const { where, type: t, field } of typeUses(mappings)) {
    const bad = applicationProblems(model, t, where, null, layers);
    problems.push(...bad);
    if (bad.length > 0 || t.kind !== "apply" || nestingProblems(model, t, where).length > 0) continue;
    try {
      inst.schemaOf(t, "field" in field ? field.field : undefined);
    } catch (err) {
      problems.push(`${where}: ${(err as Error).message}${"problem" in field ? ` (${field.problem})` : ""}`);
    }
  }
  return { inst, problems };
}

/**
 * Checks every constructor application in the mapping: the constructor
 * exists, the arguments fit its parameters, every copy gets a name that is a
 * model type name, and no two different copies get one name. `checkNesting`
 * checks the nesting. A mapping entry can't define a type with a
 * constructor's or a part's name, and a copy can't take the name of a type
 * the model already defines.
 */
export function checkMappingConstructors(model: Model, mappings: MappingFile[]): string[] {
  const problems: string[] = [];
  const defined = new Set<string>([
    ...model.kernel.primitives.map((p) => p.name),
    ...model.constructors.constructors.map((c) => c.name),
    ...model.constructors.parts.map((p) => p.name),
  ]);
  for (const m of mappings) {
    const defines = [
      ...m.entries.flatMap((e) => (e.as.role === "type" ? [{ where: `entry "${e.ir}"`, name: e.as.name }] : [])),
      ...(m.types ?? []).map((d) => ({ where: `type "${d.name}"`, name: d.name })),
    ];
    for (const { where, name } of defines) {
      if (model.constructors.constructors.some((c) => c.name === name) || model.constructors.parts.some((p) => p.name === name)) {
        problems.push(`${m.file}: ${where} defines "${name}", which ${CONSTRUCTORS_FILE} defines`);
      }
      defined.add(name);
    }
  }
  const { inst, problems: applied } = instantiateMapping(model, mappings);
  problems.push(...applied);
  for (const [name, c] of inst.copies) {
    if (!TYPE_NAME.test(name)) problems.push(`${name}: the copy ${c.type} gets a name that isn't a model type name (${TYPE_NAME.source})`);
    if (defined.has(name)) problems.push(`${name}: the copy ${c.type} takes the name of a type the model already defines; override its name with a decision record`);
  }
  return problems;
}

/**
 * The copies the mapping's applications make, as named types for the
 * duplication gate. Each one records the application it copies, so copies
 * of one template applied to the same arguments aren't twins (type rules § 5).
 */
export function copyStructures(model: Model, mappings: MappingFile[]): NamedStructure[] {
  const { inst } = instantiateMapping(model, mappings);
  return [...inst.copies].map(([name, c]) => ({ name, structure: c.schema, where: `copy ${c.type}`, copyOf: c.type }));
}
