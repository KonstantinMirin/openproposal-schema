/**
 * The as-written variant: the schemas with every change we propose, every
 * decision of kind `departure`, switched off.
 *
 * `variants/as-written.yaml` names, for each departure, the option of it the
 * variant takes and what that does to the pipeline's inputs before the model
 * resolves: a type the departure introduces is replaced everywhere by the
 * form the text writes (`replace`), an element's type is changed (`retype`),
 * the constructor withholds the member it gives an option whose members the
 * text lists without it (`withhold`), and a rule vector written in the
 * proposed form is converted to the written one (`convert`). The types the
 * written forms need and the schemas we propose don't are the variant's
 * `primitives`. Every point the text leaves open stays filled by its gap
 * record, so the variant differs from the schemas we propose only where a
 * switch says, which `checkVariantDiff` checks on the two resolved models.
 */
import { join, posix } from "node:path";
import { canonicalJson } from "./canonical.ts";
import { renderType, type Constructors } from "./constructors.ts";
import type { Kernel, Primitive } from "./kernel.ts";
import { inScope, readYaml, type DecisionRecord, type Declaration, type MappingEntry, type MappingFile, type Members, type TypeRef } from "./mapping.ts";
import type { ModelDoc, ModelProperty, ModelType } from "./model.ts";
import { compileSchema } from "./pipeline.ts";
import type { Vector, VectorFile } from "./rules.ts";
import { checkUndecided, type Failure, type FindingsFile, type Undecided } from "./examples.ts";

export const VARIANTS_DIR = "variants";
export const AS_WRITTEN = "as-written";
const VARIANT_SCHEMA = join(VARIANTS_DIR, "variant.schema.json");
const KERNEL_SCHEMA = join("kernel", "kernel.schema.json");

/** A type a departure introduces, replaced everywhere by the form the text writes. */
export interface Replace {
  type: string;
  with: string;
  locks?: string[];
}

/** An element's type, or one member's of the object it defines, changed from the proposed form to the written one. */
export interface Retype {
  ir: string;
  member?: string;
  /** The proposed type, which the element must still have: a named type, or `boolean`. */
  from: string;
  to: string;
  locks?: string[];
}

export interface Switch {
  /** The departure record the switch turns off. */
  decision: string;
  /** The option of the record the variant takes: never the chosen one. */
  option: string;
  /** How the variant reads the fields the departure changes, for a reader. */
  reads: string;
  replace?: Replace[];
  retype?: Retype[];
  /** The option objects the constructor gives no member their text doesn't list. */
  withhold?: string[];
  /** A rule vector's value at a retyped member, written in the proposed form, and the written form it becomes. */
  convert?: { from: unknown; to: unknown }[];
  /** Text in the description of a primitive, a constructor, or a declared type that states the proposed form, and what the variant says instead. */
  rewrite?: Rewrite[];
  /** The specification examples' failures under the variant that the departure's switch causes, with why. */
  findings?: VariantFinding[];
}

export interface Rewrite {
  /** The primitive, constructor, or declared type whose descriptions hold the text. */
  in: string;
  from: string;
  to: string;
}

/** A value with every string's `from` replaced by `to`, and how many strings held it. */
function rewritten<T>(v: T, r: Pick<Rewrite, "from" | "to">): { value: T; count: number } {
  let count = 0;
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") {
      if (!x.includes(r.from)) return x;
      count++;
      return x.split(r.from).join(r.to);
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x !== null && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return { value: walk(v) as T, count };
}

export interface Variant {
  format: 1;
  name: string;
  description: string;
  /** Concepts the written forms need that the domain model doesn't hold, each with its meaning. */
  concepts?: { name: string; domain: string; meaning: string }[];
  primitives: Primitive[];
  switches: Switch[];
  file: string;
}

/** Loads `variants/<name>.yaml` and validates it against its schema, which takes a primitive from the kernel's. Throws if it is invalid. */
export function loadVariant(root: string, name = AS_WRITTEN): Variant {
  return loadVariantFile(root, join(root, VARIANTS_DIR, `${name}.yaml`), name);
}

/** Loads a variant file, which must be valid against the variant schema and named `name`. */
export function loadVariantFile(root: string, file: string, name: string): Variant {
  const doc = readYaml(file);
  const errors = compileSchema(join(root, VARIANT_SCHEMA), [join(root, KERNEL_SCHEMA)])(doc);
  if (errors.length > 0) throw new Error(`${file}: not a valid variant file: ${errors.join("; ")}`);
  const v = { ...(doc as Omit<Variant, "file">), file };
  if (v.name !== name) throw new Error(`${file}: "name" is "${v.name}"; it must equal the file name "${name}"`);
  return v;
}

/**
 * A variant's output directory, from the proposed one: the variant's name
 * after the top directory, so `schemas` is `schemas/as-written` and
 * `schemas/with-open-prs` is `schemas/as-written/with-open-prs`.
 */
export function variantDir(dir: string, variant: string | undefined): string {
  if (variant === undefined) return dir;
  const [top, ...rest] = dir.split("\\").join("/").split("/");
  return posix.join(top!, variant, ...rest);
}

/** What a variant makes of the pipeline's inputs on one lock. */
export interface VariantInputs {
  kernel: Kernel;
  constructors: Constructors;
  mappings: MappingFile[];
  withhold: string[];
  /** The rule vectors, with each value at a member a switch changes converted, and each withheld member dropped; a conversion that converts nothing is a problem. */
  convert: (vectors: VectorFile[], model: ModelDoc) => { vectors: VectorFile[]; problems: string[] };
  problems: string[];
}

const named = (name: string): TypeRef => (name === "boolean" ? { kind: "boolean" } : { kind: "named", name });
const nameOf = (t: TypeRef): string | undefined => (t.kind === "boolean" ? "boolean" : t.kind === "named" ? t.name : undefined);

/** A type with every named type `map` lists replaced. */
function renamed(t: TypeRef, map: ReadonlyMap<string, string>): TypeRef {
  if (t.kind === "named") return map.has(t.name) ? { kind: "named", name: map.get(t.name)! } : t;
  if (t.kind === "apply") return { ...t, arguments: Object.fromEntries(Object.entries(t.arguments).map(([k, a]) => [k, renamed(a, map)])) };
  return t;
}
const renamedMembers = (m: Members | undefined, map: ReadonlyMap<string, string>): Members | undefined =>
  m === undefined ? undefined : Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v, type: renamed(v.type, map) }]));

/** The replacements in scope on a lock, by the type each replaces. */
export function replacementsOn(variant: Variant, lock: string): Map<string, string> {
  return new Map(variant.switches.flatMap((s) => (s.replace ?? []).filter((r) => inScope(r.locks, lock)).map((r) => [r.type, r.with] as const)));
}

/**
 * Applies a variant's switches to the pipeline's inputs for one lock. The
 * inputs are copied, never changed. A switch that names an element or a type
 * the inputs don't hold, or a retype whose element no longer has the
 * proposed type, is a problem, so a switch can't go stale silently.
 */
export function applyVariant(variant: Variant, inputs: { kernel: Kernel; constructors: Constructors; mappings: MappingFile[] }, lock: string): VariantInputs {
  const problems: string[] = [];
  const map = replacementsOn(variant, lock);
  const removed = new Set(map.keys());
  const declared = new Set(inputs.mappings.flatMap((m) => (m.types ?? []).filter((d) => inScope(d.locks, lock)).map((d) => d.name)));
  const primitives = new Set(inputs.kernel.primitives.map((p) => p.name));
  for (const [type] of map) {
    if (!declared.has(type) && !primitives.has(type)) problems.push(`${variant.file}: replaces "${type}", which neither the kernel nor a mapping declaration defines on lock "${lock}"`);
  }

  const retypes = variant.switches.flatMap((s) => (s.retype ?? []).filter((r) => inScope(r.locks, lock)).map((r) => ({ ...r, decision: s.decision })));
  const used = new Set<Retype>();
  const retype = (entry: MappingEntry): MappingEntry => {
    let as = entry.as;
    for (const r of retypes.filter((x) => x.ir === entry.ir)) {
      used.add(r);
      const where = `${variant.file}: ${r.decision} retypes "${r.ir}"${r.member ? ` member "${r.member}"` : ""}`;
      if (r.member === undefined) {
        if (as.role !== "property") {
          problems.push(`${where}, which is no property on lock "${lock}"`);
          continue;
        }
        if (nameOf(as.type) !== r.from) problems.push(`${where} from ${r.from}, but it is ${canonicalJson(as.type)} on lock "${lock}"`);
        as = { ...as, type: named(r.to) };
      } else {
        const members = as.role === "type" || as.role === "members" || as.role === "profile" ? as.members : undefined;
        const m = members?.[r.member];
        if (!m) {
          problems.push(`${where}, which the element's object doesn't hold on lock "${lock}"`);
          continue;
        }
        if (nameOf(m.type) !== r.from) problems.push(`${where} from ${r.from}, but it is ${canonicalJson(m.type)} on lock "${lock}"`);
        as = { ...as, members: { ...members, [r.member]: { ...m, type: named(r.to) } } } as MappingEntry["as"];
      }
    }
    return { ...entry, as };
  };

  const mappings = inputs.mappings.map((m): MappingFile => {
    const types = (m.types ?? [])
      .filter((d) => !(inScope(d.locks, lock) && removed.has(d.name)))
      .map((d): Declaration => ({ ...d, ...(d.members ? { members: renamedMembers(d.members, map) } : {}), ...(d.any_of ? { any_of: d.any_of.map((t) => renamed(t, map)) } : {}) }));
    const entries = m.entries.map((e) => {
      const r = inScope(e.locks, lock) ? retype(e) : e;
      const as = r.as;
      switch (as.role) {
        case "property":
          return { ...r, as: { ...as, type: renamed(as.type, map) } };
        case "type":
        case "members":
        case "profile":
          return as.members ? { ...r, as: { ...as, members: renamedMembers(as.members, map)! } } : r;
        default:
          return r;
      }
    });
    return { ...m, ...(m.types ? { types } : {}), entries };
  });
  for (const r of retypes) if (!used.has(r)) problems.push(`${variant.file}: ${r.decision} retypes "${r.ir}", which no mapping entry maps on lock "${lock}"`);

  let kernel: Kernel = { ...inputs.kernel, primitives: [...inputs.kernel.primitives.filter((p) => !removed.has(p.name)), ...variant.primitives] };
  let constructors = inputs.constructors;
  let rewrittenMappings = mappings;
  for (const s of variant.switches) {
    for (const r of s.rewrite ?? []) {
      let count = 0;
      kernel = { ...kernel, primitives: kernel.primitives.map((p) => (p.name === r.in ? ((x) => ((count += x.count), x.value))(rewritten(p, r)) : p)) };
      constructors = { ...constructors, constructors: constructors.constructors.map((c) => (c.name === r.in ? ((x) => ((count += x.count), x.value))(rewritten(c, r)) : c)) };
      rewrittenMappings = rewrittenMappings.map((m) => ({ ...m, ...(m.types ? { types: m.types.map((d) => (d.name === r.in && inScope(d.locks, lock) ? ((x) => ((count += x.count), x.value))(rewritten(d, r)) : d)) } : {}) }));
      if (count === 0) problems.push(`${variant.file}: ${s.decision} rewrites ${JSON.stringify(r.from)} in "${r.in}", whose descriptions don't hold it on lock "${lock}"`);
    }
  }
  const withhold = variant.switches.flatMap((s) => s.withhold ?? []);
  const conversions = variant.switches.flatMap((s) =>
    (s.convert ?? []).filter(() => (s.retype ?? []).some((r) => inScope(r.locks, lock)) || (s.replace ?? []).some((r) => inScope(r.locks, lock))).map((c) => ({ ...c, decision: s.decision, retypes: (s.retype ?? []).filter((r) => inScope(r.locks, lock)), withs: new Set((s.replace ?? []).filter((r) => inScope(r.locks, lock)).map((r) => r.with)) })),
  );

  const convert = (vectors: VectorFile[], model: ModelDoc): { vectors: VectorFile[]; problems: string[] } => {
    const types = new Map(model.types.map((t) => [t.name, t]));
    // The members each conversion applies at, as `<type>.<member>` of the variant's model: a member a switch retypes, or one
    // typed by the form a switch replaces a type with. A conversion that converts nothing is stale.
    const at = new Map<string, typeof conversions>();
    for (const t of model.types) {
      if (!("properties" in t)) continue;
      for (const [k, p] of Object.entries(t.properties)) {
        const typed = p.type.kind === "named" ? p.type.name : p.type.kind === "apply" && p.type.constructor === "List" && p.type.arguments.T?.kind === "named" ? p.type.arguments.T.name : undefined;
        const cs = conversions.filter((c) => c.retypes.some((r) => (r.member === undefined ? p.sources.includes(r.ir) : r.member === k && (p.sources.includes(r.ir) || t.sources.includes(r.ir)))) || (typed !== undefined && c.withs.has(typed)));
        if (cs.length > 0) at.set(`${t.name}.${k}`, cs);
      }
    }
    const used = new Set<object>();
    const withheld = new Set(withhold);
    const swap = (where: string, x: unknown): unknown => {
      const c = (at.get(where) ?? []).find((y) => canonicalJson(y.from) === canonicalJson(x));
      if (c) used.add(c);
      return c ? structuredClone(c.to) : undefined;
    };
    /** A value of a schema node of a copy or a part, which names types by `$ref`. */
    const walkSchema = (node: unknown, value: unknown): unknown => {
      if (node === null || typeof node !== "object") return value;
      const n = node as Record<string, unknown>;
      if (typeof n.$ref === "string") return walk(named(n.$ref.replace(/^#\/\$defs\//, "")), value);
      if (Array.isArray(n.anyOf)) {
        const branch = n.anyOf.find((b) => fits(b, value));
        return branch === undefined ? value : walkSchema(branch, value);
      }
      if (Array.isArray(value)) return n.items === undefined ? value : value.map((x) => walkSchema(n.items, x));
      if (value === null || typeof value !== "object") return value;
      const props = (n.properties ?? {}) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, k in props ? walkSchema(props[k], x) : n.additionalProperties !== undefined && typeof n.additionalProperties === "object" ? walkSchema(n.additionalProperties, x) : x]));
    };
    /** Whether a union branch is the one an object value takes: the named object whose members hold every key, one withheld aside. */
    const fits = (node: unknown, value: unknown): boolean => {
      const ref = node !== null && typeof node === "object" ? (node as { $ref?: unknown }).$ref : undefined;
      const t = typeof ref === "string" ? types.get(ref.replace(/^#\/\$defs\//, "")) : undefined;
      if (!t || !("properties" in t) || value === null || typeof value !== "object" || Array.isArray(value)) return false;
      return Object.keys(value).every((k) => k in t.properties || (withheld.has(t.name) && !(k in t.properties)));
    };
    const walk = (type: TypeRef, value: unknown): unknown => {
      if (value === null || typeof value !== "object") return value;
      if (type.kind === "apply" && (type.constructor === "List" || type.constructor === "Map")) {
        const item = type.arguments.T ?? type.arguments.V;
        if (!item) return value;
        return Array.isArray(value) ? value.map((x) => walk(item, x)) : Object.fromEntries(Object.entries(value).map(([k, x]) => [k, walk(item, x)]));
      }
      if (type.kind === "apply") {
        // Another constructor's application is the copy the model makes of it.
        const { name: _, ...of } = type;
        const copy = model.types.find((x) => x.kind === "copy" && canonicalJson(x.of) === canonicalJson(of));
        return copy ? walk(named(copy.name), value) : value;
      }
      if (type.kind !== "named") return value;
      const t = types.get(type.name);
      if (!t) return value;
      if (t.kind === "copy" || t.kind === "part") return walkSchema(t.schema, value);
      if (t.kind === "union") {
        const branch = t.any_of.find((b) => fits(b.kind === "named" ? { $ref: `#/$defs/${b.name}` } : null, value));
        return branch ? walk(branch, value) : value;
      }
      if (!("properties" in t) || Array.isArray(value)) return value;
      return Object.fromEntries(
        Object.entries(value).flatMap(([k, x]) => {
          const p = t.properties[k];
          // An option the variant withholds a member from drops it, so a vector written with the member stays valid.
          if (!p) return withheld.has(t.name) ? [] : [[k, x]];
          const to = swap(`${t.name}.${k}`, x);
          if (to !== undefined) return [[k, to]];
          const pt = p.type;
          if (Array.isArray(x) && pt.kind === "apply" && pt.constructor === "List") return [[k, x.map((y) => swap(`${t.name}.${k}`, y) ?? walk(pt.arguments.T!, y))]];
          return [[k, walk(p.type, x)]];
        }),
      );
    };
    const payload = (type: string, v: Vector): Vector => {
      const o = v as unknown as Record<string, unknown>;
      return {
        ...v,
        ...("value" in o ? { value: walk(named(type), o.value) } : {}),
        ...("before" in o ? { before: walk(named(type), o.before) } : {}),
        ...("after" in o ? { after: walk(named(type), o.after) } : {}),
      } as Vector;
    };
    const out = vectors.map((f) => ({
      ...f,
      rules: f.rules.map((e) => {
        const type = e.type ?? vectorType(model, e.rule);
        return type === undefined ? e : { ...e, valid: e.valid.map((v) => payload(type, v)), invalid: e.invalid.map((v) => payload(type, v)) };
      }),
    }));
    const stale = conversions.filter((c) => !used.has(c)).map((c) => `${variant.file}: ${c.decision} converts ${JSON.stringify(c.from)} to ${JSON.stringify(c.to)}, which no rule vector on lock "${lock}" holds at a member the switch changes`);
    return { vectors: out, problems: stale };
  };
  return { kernel, constructors, mappings: rewrittenMappings, withhold, convert, problems };
}

/** The type a rule's vectors are payloads of: its owner, as the model places it. */
function vectorType(model: ModelDoc, rule: string): string | undefined {
  return model.rules.find((r) => r.ir === rule)?.owner;
}

/**
 * Checks a variant against the decision records, independently of a lock:
 * every departure that isn't superseded has exactly one switch and every
 * switch names a departure; each switch takes one of its record's options
 * and never the chosen one; a replaced type is a type its record introduces
 * (a primitive that cites it or a type its record sets aside); each retyped
 * element is one its record covers; and each concept a variant primitive
 * names is the domain model's or the variant's own, which is listed once.
 */
export function checkVariant(variant: Variant, decisions: DecisionRecord[], kernel: Kernel, mappings: MappingFile[]): string[] {
  const problems: string[] = [];
  const where = variant.file;
  const departures = decisions.filter((d) => d.kind === "departure" && d.status !== "superseded");
  const byId = new Map(decisions.map((d) => [d.id, d]));
  for (const d of departures) {
    const n = variant.switches.filter((s) => s.decision === d.id).length;
    if (n !== 1) problems.push(`${where}: departure ${d.id} has ${n} switches; the variant switches every departure off exactly once`);
  }
  for (const s of variant.switches) {
    const d = byId.get(s.decision);
    if (!d || d.kind !== "departure" || d.status === "superseded") {
      problems.push(`${where}: a switch names ${s.decision}, which is no departure record in force; a gap stays filled in every variant`);
      continue;
    }
    if (!d.options.some((o) => o.id === s.option)) problems.push(`${where}: ${d.id}'s switch takes option "${s.option}", which ${d.id} doesn't list (${d.options.map((o) => o.id).join(", ")})`);
    if (s.option === d.chosen) problems.push(`${where}: ${d.id}'s switch takes "${s.option}", the option the schemas we propose take, so it switches nothing off`);
    if ((s.replace ?? []).length + (s.retype ?? []).length + (s.withhold ?? []).length === 0) problems.push(`${where}: ${d.id}'s switch changes nothing`);
    for (const r of s.replace ?? []) {
      const primitive = kernel.primitives.find((p) => p.name === r.type);
      const asides = (d.sets_aside ?? []).filter((a) => a.type === r.type);
      const ok = primitive?.decision === d.id || asides.length > 0;
      if (!ok) problems.push(`${where}: ${d.id}'s switch replaces "${r.type}", which ${d.id} doesn't introduce: no primitive that cites it and no type it sets aside`);
      if (asides.length > 0 && canonicalJson(asides.map((a) => a.locks ?? null).sort()) !== canonicalJson([r.locks ?? null])) problems.push(`${where}: ${d.id}'s switch replaces "${r.type}" on ${r.locks?.join(", ") ?? "every lock"}, but ${d.id} sets it aside on ${asides.map((a) => a.locks?.join(", ") ?? "every lock").join("; ")}`);
      if (!kernel.primitives.some((p) => p.name === r.with) && !variant.primitives.some((p) => p.name === r.with)) problems.push(`${where}: ${d.id}'s switch replaces "${r.type}" with "${r.with}", which is no primitive`);
    }
    for (const a of d.sets_aside ?? []) {
      if (!(s.replace ?? []).some((r) => r.type === a.type)) problems.push(`${where}: ${d.id} sets aside "${a.type}", which its switch doesn't replace`);
    }
    for (const r of s.retype ?? []) {
      const covered = d.covers.some((c) => c.ir === r.ir && (r.locks === undefined || r.locks.every((l) => inScope(c.locks, l))));
      if (!covered) problems.push(`${where}: ${d.id}'s switch retypes "${r.ir}", which ${d.id} doesn't cover on ${r.locks?.join(", ") ?? "every lock"}`);
      if (r.to !== "boolean" && !kernel.primitives.some((p) => p.name === r.to) && !variant.primitives.some((p) => p.name === r.to)) problems.push(`${where}: ${d.id}'s switch retypes "${r.ir}" to "${r.to}", which is no primitive`);
    }
    for (const name of s.withhold ?? []) {
      const declared = mappings.some((m) => m.entries.some((e) => e.as.role === "type" && e.as.name === name && "decisions" in e.source)) || mappings.some((m) => (m.types ?? []).some((t) => t.name === name));
      if (!declared) problems.push(`${where}: ${d.id}'s switch withholds a member from "${name}", which the mapping doesn't define`);
    }
    if ((s.convert ?? []).length > 0 && (s.retype ?? []).length + (s.replace ?? []).length === 0) problems.push(`${where}: ${d.id}'s switch converts vector values but changes no member they could sit at`);
  }
  const concepts = new Set([...(kernel.domains?.domains ?? []).flatMap((x) => x.concepts.map((c) => c.name))]);
  const own = new Set<string>();
  const domains = new Set((kernel.domains?.domains ?? []).map((x) => x.name));
  for (const c of variant.concepts ?? []) {
    if (concepts.has(c.name) || own.has(c.name)) problems.push(`${where}: concept "${c.name}" is defined twice`);
    if (!domains.has(c.domain)) problems.push(`${where}: concept "${c.name}" names the value domain "${c.domain}", which kernel/domains.yaml doesn't define`);
    own.add(c.name);
  }
  for (const p of variant.primitives) {
    if (!concepts.has(p.concept) && !own.has(p.concept)) problems.push(`${where}: ${p.name} names concept "${p.concept}", which neither the domain model nor the variant defines`);
    if (kernel.primitives.some((k) => k.name === p.name)) problems.push(`${where}: ${p.name} is a kernel primitive already; a variant adds only the types the written forms need`);
  }
  return problems;
}

/** A property's type with the variant's replacements applied, for the comparison. */
const comparable = (p: ModelProperty, map: ReadonlyMap<string, string>) => canonicalJson({ ...p, type: renamed(p.type, map), ...(p.cases ? { cases: p.cases.map((c) => ({ ...c, type: renamed(c.type, map) })) } : {}) });

/**
 * A type's JSON as the variant reads it, but for its properties, which are
 * compared one by one: its schema's `$ref`s and its application with the
 * replacements read in, and the departures left out of its decisions. An
 * object's references follow from its properties, so they are left out too;
 * so are the decisions of an option the variant withholds a member from,
 * which lose the gap that gives the member, since the variant's must be a
 * subset of the proposed ones.
 */
function comparableType(t: ModelType, map: ReadonlyMap<string, string>, off: ReadonlySet<string>, withheld: boolean): string {
  const refs = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(refs);
    if (v === null || typeof v !== "object") return v;
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => {
        if (k === "$ref" && typeof x === "string") return [k, x.replace(/^#\/\$defs\/(.+)$/, (_, n: string) => `#/$defs/${map.get(n) ?? n}`)];
        if (k === "$model" && x !== null && typeof x === "object") return [k, renamed(x as TypeRef, map)];
        return [k, refs(x)];
      }),
    );
  };
  const out = refs({ ...t, references: [...new Set(t.references.map((r) => map.get(r) ?? r))].sort(), decisions: withheld ? [] : t.decisions.filter((d) => !off.has(d)) }) as Record<string, unknown>;
  if (t.kind === "copy") {
    out.of = renamed(t.of, map);
    out.application = renderType(out.of as TypeRef);
  }
  if (t.kind === "union") out.any_of = t.any_of.map((b) => renamed(b, map));
  if ("properties" in t) {
    delete out.properties;
    delete out.references;
  }
  return canonicalJson(out);
}

/**
 * Checks that the variant's model differs from the proposed one only where a
 * switch says, on one lock: a type only the proposed model holds is one a
 * switch replaces; a type only the variant holds is a variant primitive; a
 * type both hold is the same once the replacements are read into the
 * proposed one and the departures left out of its decisions, but for its
 * properties; a property both hold is the same once read so, unless a retype
 * of a switch in scope names an element it rests on and it has the retype's
 * type; a property only the proposed model holds is a member the constructor
 * gives an option a switch withholds it from; and the variant holds no
 * property the proposed model lacks. Returns the problems and each
 * difference, for the variant report.
 */
export function checkVariantDiff(variant: Variant, proposed: ModelDoc, written: ModelDoc, decisions: DecisionRecord[], lock: string): { problems: string[]; differences: VariantDifference[] } {
  const problems: string[] = [];
  const differences: VariantDifference[] = [];
  const map = replacementsOn(variant, lock);
  const off = new Set(variant.switches.map((s) => s.decision));
  const byName = (m: ModelDoc) => new Map(m.types.map((t) => [t.name, t]));
  const p = byName(proposed);
  const w = byName(written);
  const ownPrimitives = new Set(variant.primitives.map((x) => x.name));
  const ctorRewrites = variant.switches.flatMap((s) => (s.rewrite ?? []).filter((r) => proposed.types.some((t) => t.kind === "constructor" && t.name === r.in)));
  const switchOf = (type: string) => variant.switches.find((s) => (s.replace ?? []).some((r) => r.type === type && inScope(r.locks, lock)));
  for (const [name] of p) {
    if (w.has(name)) continue;
    const s = switchOf(name);
    if (!s) problems.push(`${lock}: the variant drops "${name}", which no switch replaces`);
    else differences.push({ decision: s.decision, type: name, change: "replaced", from: name, to: map.get(name)! });
  }
  for (const [name] of w) if (!p.has(name) && !ownPrimitives.has(name)) problems.push(`${lock}: the variant adds "${name}", which is no variant primitive`);
  const decisionCovers = (id: string, ir: string) => decisions.find((d) => d.id === id)?.covers.some((c) => c.ir === ir && inScope(c.locks, lock)) ?? false;
  for (let [name, a] of p) {
    const b = w.get(name);
    if (!b) continue;
    const withheld = variant.switches.some((s) => (s.withhold ?? []).includes(name));
    const ins = variant.switches.flatMap((s) => (s.rewrite ?? []).filter((r) => r.in === name || (a.kind === "copy" && a.of.constructor === r.in)));
    if (ins.length > 0) {
      const rw = ins.reduce((t, r) => rewritten(t, r).value, a);
      p.set(name, rw);
      a = rw;
    }
    if (comparableType(a, map, off, withheld) !== comparableType(b, map, off, withheld)) problems.push(`${lock}: "${name}" differs beyond its properties in a way no switch says`);
    if (withheld && b.decisions.some((d) => !a.decisions.includes(d))) problems.push(`${lock}: "${name}" cites decisions as written that the proposed type doesn't`);
    if (!("properties" in a) || !("properties" in b)) continue;
    for (let [k, pa] of Object.entries(a.properties)) {
      const pb = b.properties[k];
      // A projection copies a constructor's member descriptions into its own properties, so a constructor's rewrite reaches them too.
      pa = ctorRewrites.reduce((x, r) => rewritten(x, r).value, pa);
      const sources = [...pa.sources, ...a.sources];
      if (!pb) {
        const s = variant.switches.find((x) => (x.withhold ?? []).includes(name));
        if (pa.given === undefined || !s || !a.decisions.includes(s.decision)) problems.push(`${lock}: the variant drops "${name}.${k}", which no switch withholds`);
        else differences.push({ decision: s.decision, type: name, member: k, change: "withheld", from: renderName(pa.type), to: "" });
        continue;
      }
      if (comparable(pa, map) === comparable(pb, map)) {
        const from = renderName(pa.type);
        const to = renderName(pb.type);
        if (from !== to) {
          const s = variant.switches.find((x) => (x.replace ?? []).some((r) => inScope(r.locks, lock) && from.includes(r.type)));
          differences.push({ decision: s?.decision ?? "", type: name, member: k, change: "replaced", from, to });
        }
        continue;
      }
      const r = variant.switches.flatMap((s) => (s.retype ?? []).filter((x) => inScope(x.locks, lock)).map((x) => ({ ...x, decision: s.decision }))).find((x) => (x.member === undefined ? pa.sources.includes(x.ir) : x.member === k && sources.includes(x.ir)) && decisionCovers(x.decision, x.ir));
      const want = r ? comparable({ ...pa, type: named(r.to) }, map) : null;
      if (!r || want !== comparable(pb, map)) problems.push(`${lock}: "${name}.${k}" differs in a way no switch says: ${renderName(pa.type)} proposed, ${renderName(pb.type)} as written`);
      else differences.push({ decision: r.decision, type: name, member: k, change: "retyped", from: renderName(pa.type), to: renderName(pb.type) });
    }
    for (const k of Object.keys(b.properties)) if (!(k in a.properties)) problems.push(`${lock}: the variant adds "${name}.${k}", which no switch says`);
  }
  return { problems, differences: differences.sort((x, y) => (x.decision + x.type + (x.member ?? "") < y.decision + y.type + (y.member ?? "") ? -1 : 1)) };
}

/** One difference between the variant and the schemas we propose, with the departure that makes it. */
export interface VariantDifference {
  decision: string;
  type: string;
  member?: string;
  change: "replaced" | "retyped" | "withheld";
  from: string;
  to: string;
}

function renderName(t: TypeRef): string {
  if (t.kind === "boolean") return "boolean";
  if (t.kind === "named") return t.name;
  if (t.kind === "parameter") return t.name;
  return `${t.constructor}<${Object.values(t.arguments).map(renderName).join(", ")}>`;
}

/** A failure of a specification example that the variant keeps where the schemas we propose record it under a departure, or adds, with why. */
export interface VariantFinding {
  example: string;
  path: string;
  kind: Failure["kind"];
  rule?: string;
  value: unknown;
  locks?: string[];
  reason: string;
}

const findingKey = (f: { example: string; path: string; kind: string; rule?: string }) => `${f.example} ${f.path === "" ? "/" : f.path} ${f.kind}${f.rule ? ` (${f.rule})` : ""}`;

/** The variant's example failures on one lock, counted by cause: the gaps' findings, which fill both variants, and the switches' own. */
export interface VariantExampleCounts {
  failures: number;
  places: number;
  gap: number;
  departure: number;
}

/**
 * Checks one lock's example failures under a variant against the records:
 * every failure is a recorded finding of the schemas we propose whose causes
 * are all gaps, with the same kind and value, since a gap fills both
 * variants, or a finding a switch lists, whose departure covers an element
 * its location rests on; every recorded gap finding in scope still fails, and
 * every finding a switch lists still occurs. The undecided checks are checked
 * against the record as for the proposed schemas (`checkUndecided`).
 */
export function checkVariantExamples(failures: Failure[], undecided: Undecided[], variant: Variant, recorded: FindingsFile, lock: string, decisions: DecisionRecord[]): { problems: string[]; counts: VariantExampleCounts } {
  const problems: string[] = [];
  const kind = new Map(decisions.map((d) => [d.id, d.kind]));
  const gaps = recorded.findings.filter((f) => inScope(f.locks, lock) && f.decisions.every((d) => kind.get(d) === "gap"));
  const listed = variant.switches.flatMap((s) => (s.findings ?? []).filter((f) => inScope(f.locks, lock)).map((f) => ({ ...f, decision: s.decision })));
  const same = (a: { kind: string; value: unknown }, b: { kind: string; value: unknown }) => a.kind === b.kind && canonicalJson(a.value) === canonicalJson(b.value);
  let gap = 0;
  let departure = 0;
  for (const f of failures) {
    const k = findingKey(f);
    if (gaps.some((r) => findingKey(r) === k && same(r, f))) {
      gap++;
      continue;
    }
    const l = listed.find((x) => findingKey(x) === k);
    if (!l) {
      problems.push(`${k}: on lock "${lock}" as ${variant.name}: ${f.message} (value ${JSON.stringify(f.value)}); it is no recorded gap finding, so list it under the switch whose departure causes it`);
      continue;
    }
    if (!same(l, f)) problems.push(`${variant.file}: ${k} changed on lock "${lock}": now ${f.kind} with value ${JSON.stringify(f.value)}`);
    const d = decisions.find((x) => x.id === l.decision);
    if (f.elements.length > 0 && !d?.covers.some((c) => inScope(c.locks, lock) && f.elements.includes(c.ir))) problems.push(`${variant.file}: ${k} sits under ${l.decision}, which covers none of ${f.elements.join(", ")} on lock "${lock}"`);
    departure++;
  }
  for (const r of gaps) if (!failures.some((f) => findingKey(f) === findingKey(r) && same(r, f))) problems.push(`${findingKey(r)}: a gap's finding no longer fails on lock "${lock}" as ${variant.name}; a gap fills both variants, so the variant differs where no switch says`);
  for (const l of listed) if (!failures.some((f) => findingKey(f) === findingKey(l))) problems.push(`${variant.file}: ${l.decision} lists ${findingKey(l)}, which no longer fails on lock "${lock}"; remove it`);
  problems.push(...checkUndecided(undecided, recorded, lock, decisions));
  const places = new Set(failures.map((f) => `${f.example} ${f.path}`)).size;
  return { problems, counts: { failures: failures.length, places, gap, departure } };
}
