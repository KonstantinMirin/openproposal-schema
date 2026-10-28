/**
 * Example payloads for every named type, for readers of the schemas: each
 * type the lock's schemas emit gets a minimal example and a full one, with
 * values that read like a real payload.
 *
 * - **Values.** A scalar at a property takes, first, the value the
 *   specification's own examples give at that property (`specValues`): the
 *   example files of the lock and the code blocks the model maps to an
 *   example, in the order of the specification's sections, each value in the
 *   order its example writes it. A value counts only where the property's
 *   emitted schema accepts it, so a readable ID where the schema takes a
 *   UUID is skipped. A member whose schema is an open object, which names
 *   no members, takes the whole object an example gives it. A member of a
 *   summary takes the values the examples give the member it projects, such
 *   as a proposal's `seller_name` for the proposal summary's. Otherwise the
 *   member takes its value in the per-field example values
 *   (`field-examples/field-examples.yaml`, src/field-examples.ts), and
 *   else a primitive takes its showcase value (`showcase` in
 *   `kernel/primitives.yaml`), and a vocabulary its most representative
 *   term: the first term a specification example uses, and else its first
 *   core term. A second item of a list takes the second value the
 *   specification gives there, or the primitive's second showcase value, or
 *   the vocabulary's next term, and a selection's second option the second
 *   per-field value.
 * - **Minimal.** The type's corpus baseline (src/corpus.ts, `baselines`):
 *   its required members only, and what `minProperties` and a condition
 *   that holds need, with each scalar the value above, where the example
 *   still holds; otherwise the baseline as it is.
 * - **Full.** Every member present, one item in each list, one key in each
 *   map, the first branch of each union, and the members a condition's
 *   `then` requires or narrows where the condition holds. A list of scalars
 *   holds two items where the specification's examples give two values
 *   there. A copy of `Selectable` holds two options: the first in
 *   `included[]`, the second priced in `pricing` by the first price delta
 *   the specification's examples give the field, or else the full one,
 *   and a `max_select` of at least 1, the specification's where it gives
 *   one, and else the number of options. A part whose rules read its
 *   members starts from the value every rule of the part lists as valid. A
 *   named type's full example is built once and holds the full examples of
 *   the named types it references.
 * - **What holds.** Every example is valid against the type's emitted
 *   schema, under Ajv 2020 with `format` asserted, and no rule that one
 *   payload decides finds a violation in it (src/rule-checks.ts), on any
 *   value of a type the rule reads. Where a member's full value breaks the
 *   type's schema or a rule, as a second delta in a price delta that holds
 *   exactly one, the full example keeps the member's minimal value, or
 *   leaves the member out, and its `notes` say which and why. A type whose
 *   minimal example fails is a problem, and nothing is written.
 * - **Illustrative values.** Where a per-field value carries a note, such
 *   as that its structure is the feedback's proposal and not the
 *   specification's, the type's `illustrative` lists the value's location
 *   in the full example with the note.
 * - **Per-field values that hold.** `checkFieldExamples` fails on an entry
 *   whose element or member no longer exists on the lock, whose value fails
 *   the member's schema or a rule, alone or in its type's full example,
 *   whose value is a specification example value at the member or isn't a
 *   core term of a vocabulary that now has core terms, or whose member the
 *   specification's examples now give a value.
 *
 * The examples are written per lock, to `type-examples/examples.json` and
 * `type-examples/<IR directory under ir/>/examples.json`.
 */
import { posix } from "node:path";
import { canonicalJson } from "./canonical.ts";
import { baselines, partSeeds, Validators } from "./corpus.ts";
import { baseOf, type EmittedFile, schemaIdOf } from "./emit.ts";
import { instanceChecker, type InstanceCheck, type Loaded, type ModelExample } from "./examples.ts";
import { fieldKey, fieldLocations, type FieldExample } from "./field-examples.ts";
import type { Kernel } from "./kernel.ts";
import type { ModelDoc } from "./model.ts";
import type { Check } from "./rule-checks.ts";

type Schema = Record<string, unknown>;

/** Why a full example holds less than every member of its type at one location. */
export interface ExampleNote {
  /** A JSON pointer below the type's value. */
  path: string;
  /** `minimal`: the member holds its minimal value; `omitted`: the member is left out. */
  holds: "minimal" | "omitted";
  reason: string;
}

/** A value of the full example that a per-field entry's note describes. */
export interface IllustrativeNote {
  /** A JSON pointer below the type's value. */
  path: string;
  note: string;
}

/** One named type's examples. */
export interface TypeExample {
  kind: string;
  /** The `$id` of the type's schema, with its fragment. */
  schema: string;
  minimal: unknown;
  full: unknown;
  notes?: ExampleNote[];
  /** The full example's values whose per-field entry carries a note, such as a structure the feedback proposes. */
  illustrative?: IllustrativeNote[];
  /** Rules that can't decide on the full example without something a payload of the type doesn't hold, such as the proposal's seller for a line item. */
  undecided?: { path: string; rule: string }[];
}

export interface TypeExamplesDoc {
  format: 1;
  lock: string;
  /** The specification commit the lock's model was resolved from. */
  commit: string;
  /** Every named type the lock's schemas emit, by name. */
  types: Record<string, TypeExample>;
}

/** The specification's examples on a lock, as `lockExamples` in src/examples.ts loads them. */
export interface SpecExamples {
  examples: ModelExample[];
  /** Each example's loaded value, or why it doesn't load, by example ID. */
  values: Map<string, Loaded>;
}

export interface TypeExamplesInput {
  model: ModelDoc;
  files: EmittedFile[];
  kernel: Kernel;
  /** The lock's schema directory, such as `schemas`, for each type's `$id`. */
  schemaDir: string;
  /** The codes of the lists the repository pins, for the rules that rest on a list (`codesOf`). */
  codes: ReadonlyMap<string, ReadonlySet<string | number>>;
  /** Every check a rule of the lock may have: the kernel's, the constructors', and the spec's (`checksOf`). */
  ruleChecks: Readonly<Record<string, Check>>;
  /** The specification's examples, whose values the examples show first. */
  spec: SpecExamples;
  /** The per-field example values (src/field-examples.ts), every lock's; those in scope on the model's lock apply. */
  fields: FieldExample[];
}

/** Where the scalars of the full examples' own members come from, over every named type: a type's own members, not those of the named types it references. */
export interface ValueSources {
  /** A value a specification example gives at the property. */
  spec: number;
  /** A primitive's showcase value. */
  showcase: number;
  /** A vocabulary's representative term, or its next term for a second item. */
  term: number;
  /** A per-field example value. */
  field: number;
  /** Anything else: a boolean, a `const`, or the baseline's value where no other holds. */
  other: number;
}

export const TYPE_EXAMPLES_DIR = "type-examples";
export const TYPE_EXAMPLES_FILE = "examples.json";

/** The directory of a lock's type examples, from its IR directory: `ir` gives `type-examples`, and `ir/with-open-prs` gives `type-examples/with-open-prs`. */
export function typeExamplesDirOf(irDir: string): string {
  const rel = posix.relative("ir", irDir.split("\\").join("/"));
  if (rel.startsWith("..")) throw new Error(`the IR directory "${irDir}" isn't under ir/`);
  return rel === "" ? TYPE_EXAMPLES_DIR : posix.join(TYPE_EXAMPLES_DIR, rel);
}

/** The committed form: indented JSON with the members in the order of their schema, so a reader sees a payload as it is written. */
export const renderTypeExamples = (doc: TypeExamplesDoc): string => `${JSON.stringify(doc, null, 2)}\n`;

const isMap = (v: unknown): v is Schema => v !== null && typeof v === "object" && !Array.isArray(v);
const isScalar = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const escape = (token: string) => token.replaceAll("~", "~0").replaceAll("/", "~1");
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
/** A schema location, `<file $id>#<JSON pointer>`, from an `$id` with or without its fragment. */
const locationOf = (id: string) => (id.includes("#") ? id : `${id}#`);

/** What a check found, in one line, or null if nothing. */
function failure(c: InstanceCheck): string | null {
  const first = c.errors[0] ?? c.violations[0];
  if (!first) return null;
  return "rule" in first ? `${first.rule}: ${first.path || "/"}: ${first.message}` : `the schema: ${first.path || "/"}: ${first.message}`;
}

/** A section number's parts, such as `[5, 6, 1]` for `5.6.1`; a part that isn't a number sorts after every number, by its text. */
const sectionKey = (ir: string) => (ir.split(":")[1] ?? "").split(".");
function bySection(a: ModelExample, b: ModelExample): number {
  const [x, y] = [sectionKey(a.ir), sectionKey(b.ir)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [p, q] = [x[i], y[i]];
    if (p === q) continue;
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const [m, n] = [Number(p), Number(q)];
    if (Number.isInteger(m) && Number.isInteger(n)) return m - n;
    if (Number.isInteger(m) !== Number.isInteger(n)) return Number.isInteger(m) ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return a.ir < b.ir ? -1 : a.ir > b.ir ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The values the specification's examples give: at each property location, and of each vocabulary, each valid there, once, in the specification's order. */
export interface SpecValues {
  /** By schema location, `<file $id>#<pointer>` of the property, its list's items, or its map's values: scalars, and an open object's whole value. */
  at: Map<string, unknown[]>;
  /** By the schema location of a map's values: the whole values, objects too, as a selection's `pricing` gives a price delta. */
  mapValues: Map<string, unknown[]>;
  /** By vocabulary name: the terms the examples use, wherever they use them. */
  terms: Map<string, unknown[]>;
}

/** Whether the schema at a location, through its references, is an open object: an object that names no members and accepts any. */
function openObject(v: Validators, loc: string): boolean {
  for (let at = loc, hops = 0; hops < 8; hops++) {
    const { node, file } = v.node(at);
    if (typeof node.$ref === "string") {
      at = locationOf(new URL(node.$ref, file).href);
      continue;
    }
    return node.type === "object" && !isMap(node.properties) && !("additionalProperties" in node) && !("anyOf" in node) && !("oneOf" in node) && !("propertyNames" in node);
  }
  return false;
}

/**
 * Where a member of a summary reads the specification's values: each
 * property of a profile and of an object that projects another type, at
 * the location of the property it projects, with what lies below it. The
 * function gives a location's projected location, or undefined.
 */
export function projections(model: ModelDoc, schemaDir: string, base: string | null): (loc: string) => string | undefined {
  const byName = new Map(model.types.map((t) => [t.name, t]));
  const prefixes: [string, string][] = [];
  for (const t of model.types) {
    const target = t.kind === "profile" ? t.document : t.kind === "object" ? t.projects : undefined;
    const u = target === undefined ? undefined : byName.get(target);
    const [from, to] = [schemaIdOf(t, schemaDir, base), u ? schemaIdOf(u, schemaDir, base) : null];
    if (!u || !("properties" in u) || !("properties" in t) || from === null || to === null) continue;
    for (const k of Object.keys(t.properties)) if (k in u.properties) prefixes.push([`${locationOf(from)}/properties/${escape(k)}`, `${locationOf(to)}/properties/${escape(k)}`]);
  }
  return (loc) => {
    for (const [from, to] of prefixes) if (loc === from || loc.startsWith(`${from}/`)) return to + loc.slice(from.length);
    return undefined;
  };
}

/**
 * Reads the scalar values of the specification's examples by the property
 * each one is a value of. Each example is read from its document's schema,
 * a code block field by field, from the specification's first section to
 * its last, and each value at the location the walk reaches by a member, a
 * list's item, or a map's value, through every union branch that accepts
 * it. A value is kept where the location's schema accepts it, and each
 * term where its vocabulary's schema accepts it. A member whose schema is
 * an open object keeps the whole object it's given. An example that
 * doesn't load gives nothing.
 */
export function specValues(model: ModelDoc, v: Validators, schemaDir: string, spec: SpecExamples): SpecValues {
  const at = new Map<string, unknown[]>();
  const mapValues = new Map<string, unknown[]>();
  const terms = new Map<string, unknown[]>();
  const typeAt = new Map(model.types.flatMap((t) => {
    const id = schemaIdOf(t, schemaDir, v.baseOf(schemaDir));
    return id === null ? [] : [[locationOf(id), t] as const];
  }));
  const add = (m: Map<string, unknown[]>, k: string, x: unknown) => {
    const xs = m.get(k) ?? [];
    if (!xs.some((y) => same(y, x))) xs.push(x);
    m.set(k, xs);
  };
  const visit = (loc: string, x: unknown, member: boolean): void => {
    const { node, file } = v.node(loc);
    if (member && (isScalar(x) || (isMap(x) && openObject(v, loc))) && v.valid(loc, x)) add(at, loc, x);
    if (typeof node.$ref === "string") {
      const target = locationOf(new URL(node.$ref, file).href);
      const t = typeAt.get(target);
      if (t?.kind === "vocabulary" && isScalar(x) && v.valid(target, x)) add(terms, t.name, x);
      visit(target, x, false);
      return;
    }
    for (const k of ["anyOf", "oneOf"] as const) {
      if (!Array.isArray(node[k])) continue;
      node[k].forEach((_, i) => {
        const branch = `${loc}/${k}/${i}`;
        if (v.valid(branch, x)) visit(branch, x, false);
      });
    }
    if (isMap(x)) {
      const props = isMap(node.properties) ? node.properties : {};
      for (const [k, y] of Object.entries(x)) {
        if (k in props) visit(`${loc}/properties/${escape(k)}`, y, true);
        else if (isMap(node.additionalProperties)) {
          const values = `${loc}/additionalProperties`;
          if (v.valid(values, y)) add(mapValues, values, y);
          visit(values, y, true);
        }
      }
    }
    if (Array.isArray(x) && isMap(node.items)) for (const y of x) visit(`${loc}/items`, y, true);
  };
  const docs = new Map(model.types.map((t) => [t.name, t]));
  for (const ex of [...spec.examples].sort(bySection)) {
    const loaded = spec.values.get(ex.id);
    const doc = docs.get(ex.object);
    const id = doc ? schemaIdOf(doc, schemaDir, v.baseOf(schemaDir)) : null;
    if (!loaded?.ok || id === null) continue;
    if (!ex.part) visit(locationOf(id), loaded.value, false);
    else if (isMap(loaded.value)) {
      const props = isMap(v.node(locationOf(id)).node.properties) ? (v.node(locationOf(id)).node.properties as Schema) : {};
      for (const [k, y] of Object.entries(loaded.value)) if (k in props) visit(`${locationOf(id)}/properties/${escape(k)}`, y, true);
    }
  }
  return { at, mapValues, terms };
}

/**
 * Builds each named type's minimal and full examples and checks them.
 * Returns the document, the problems, a type the builder can't build or an
 * example that fails its schema or a rule, and where the full examples'
 * values come from.
 */
export function generateTypeExamples(input: TypeExamplesInput): { doc: TypeExamplesDoc; problems: string[]; sources: ValueSources } {
  const { model, files, kernel, schemaDir } = input;
  const problems: string[] = [];
  const v = new Validators(files);
  const { typeValue, build } = baselines(model, v, kernel, schemaDir);
  const seeds = partSeeds(model, v, schemaDir);
  const check = instanceChecker(model, files, schemaDir, input.codes, input.ruleChecks);
  const found = specValues(model, v, schemaDir, input.spec);
  const vectors = new Map(kernel.primitives.map((p) => [p.name, p.vectors.valid]));
  const showcases = new Map(kernel.primitives.map((p) => [p.name, p.showcase]));
  const typeAt = new Map(model.types.flatMap((t) => {
    const id = schemaIdOf(t, schemaDir, v.baseOf(schemaDir));
    return id === null ? [] : [[locationOf(id), t] as const];
  }));
  const holds = (id: string, x: unknown) => failure(check(id, x));
  const projected = projections(model, schemaDir, v.baseOf(schemaDir));
  /** The per-field entries by the schema location of each member they give a value. */
  const fieldAt = new Map(fieldLocations(model, schemaDir, v.baseOf(schemaDir), input.fields).flatMap(({ entry, locations }) => locations.map((l) => [l.at, entry] as const)));

  /** The values the specification gives at a location, or else at the location it projects. */
  const specAt = (loc: string): unknown[] => {
    const own = found.at.get(loc) ?? [];
    const p = own.length === 0 ? projected(loc) : undefined;
    return p === undefined ? own : (found.at.get(p) ?? []).filter((x) => v.valid(loc, x));
  };

  /**
   * The `n`-th value the specification gives at a location, counting round,
   * that the location's schema accepts, and else the `n`-th per-field value;
   * `from` reads another location's values, as a `then` reads its member's.
   */
  const fromSpec = (at: string, n: number, from = at): unknown => {
    const xs = specAt(from).filter((x) => from === at || v.valid(at, x));
    if (xs.length > 0) return structuredClone(xs[n % xs.length]);
    const ys = (fieldAt.get(from)?.values ?? []).filter((x) => v.valid(at, x));
    return ys.length === 0 ? undefined : structuredClone(ys[n % ys.length]);
  };

  /** A vocabulary's terms in the order its examples show them: the terms a specification example uses, then its core terms. */
  const termsOf = (t: Extract<ModelDoc["types"][number], { kind: "vocabulary" }>, id: string): unknown[] => {
    const out: unknown[] = [];
    for (const x of [...(found.terms.get(t.name) ?? []), ...t.terms.map((x) => x.value)]) if (!out.some((y) => same(y, x)) && v.valid(id, x)) out.push(x);
    return out;
  };

  /** A primitive's `n`-th showcase value, counting round, where its schema accepts it, and else its first valid vector. */
  const showcaseOf = (name: string, id: string, n: number): unknown => {
    const xs = (showcases.get(name) ?? []).filter((x) => v.valid(id, x));
    return xs.length > 0 ? xs[n % xs.length] : (vectors.get(name) ?? [typeValue(id, [])])[0];
  };

  /** The full examples by variant and `$id`, each with its notes; variant `n` takes the `n`-th value of each scalar, so a list's second item differs from its first. */
  const fulls = new Map<string, { value: unknown; notes: ExampleNote[] }>();

  /** The value of a node, at the location `at`, that the full builder gives; notes from referenced types stay with them. */
  const fullNode = (node: Schema, file: string, at: string, stack: string[], n: number, from = at): unknown => {
    const given = fromSpec(at, n, from);
    if (given !== undefined) return given;
    if (typeof node.$ref === "string") return fullType(locationOf(new URL(node.$ref, file).href), stack, n).value;
    for (const k of ["anyOf", "oneOf"] as const) {
      if (Array.isArray(node[k])) {
        const branch = node[k][0];
        if (!isMap(branch)) throw new Error(`no ${k} branch 0`);
        return fullNode(branch, file, `${at}/${k}/0`, stack, n);
      }
    }
    if ("const" in node) return node.const;
    if (Array.isArray(node.enum)) return node.enum[n % node.enum.length];
    if (node.type === "object" || isMap(node.properties)) return fullObject(node, file, at, stack, n);
    if (node.type === "array") {
      if (!isMap(node.items)) throw new Error("an array with no items schema");
      const items = `${at}/items`;
      const max = typeof node.maxItems === "number" ? node.maxItems : Infinity;
      // Two items where the specification's examples give two values there, so the list shows it holds more than one.
      const shown = (found.at.get(items) ?? []).length >= 2 ? 2 : 1;
      const count = Math.min(max, Math.max(shown, typeof node.minItems === "number" ? node.minItems : 0));
      const out = Array.from({ length: count }, (_, i) => fullNode(node.items as Schema, file, items, stack, n + i));
      if (node.uniqueItems === true && new Set(out.map((x) => canonicalJson(x))).size < out.length) {
        return count > Math.max(1, typeof node.minItems === "number" ? node.minItems : 0) ? out.slice(0, 1) : build(node, file, [], stack);
      }
      return out;
    }
    return build(node, file, [], stack);
  };

  /** Whether the members an `if` fixes, each a required member with a `const`, hold in the value; null for an `if` of another form. */
  const condition = (c: Schema, value: Schema): boolean | null => {
    if (!isMap(c.if)) return null;
    const required = Array.isArray(c.if.required) ? c.if.required.map(String) : [];
    const props = isMap(c.if.properties) ? c.if.properties : {};
    for (const k of required) {
      const p = props[k];
      if (!isMap(p) || !("const" in p)) return null;
      if (!(k in value) || !same(value[k], p.const)) return false;
    }
    return true;
  };

  const fullObject = (node: Schema, file: string, at: string, stack: string[], n: number): Schema => {
    const props = isMap(node.properties) ? node.properties : {};
    const seed = seeds.get(node);
    const out: Schema = {};
    for (const [k, p] of Object.entries(props)) {
      if (seed && k in seed) out[k] = structuredClone(seed[k]);
      else if (isMap(p)) out[k] = fullNode(p, file, `${at}/properties/${escape(k)}`, stack, n);
    }
    // A map: one key, a value of the key type, with one value.
    if (Object.keys(props).length === 0 && isMap(node.additionalProperties)) {
      const key = isMap(node.propertyNames) ? fullNode(node.propertyNames, file, `${at}/propertyNames`, stack, n) : "key";
      out[String(key)] = fullNode(node.additionalProperties, file, `${at}/additionalProperties`, stack, n);
    }
    // The condition that holds, along the chain of `else`, narrows the members its `then` types; a member's value the specification gives
    // is the member's, where the `then` accepts it.
    let cAt = at;
    for (let c: Schema | undefined = node; c !== undefined; c = isMap(c.else) ? c.else : undefined, cAt = `${cAt}/else`) {
      if (condition(c, out) !== true || !isMap(c.then)) continue;
      const thenProps = isMap(c.then.properties) ? c.then.properties : {};
      for (const [k, p] of Object.entries(thenProps)) {
        if (isMap(p) && !(seed && k in seed)) out[k] = fullNode(p, file, `${cAt}/then/properties/${escape(k)}`, stack, n, `${at}/properties/${escape(k)}`);
      }
    }
    return out;
  };

  /** An option's name, as `included[]` and the `pricing` keys name it (D-007): a string option's value, or an object option's `id`. */
  const nameOf = (o: unknown): string | undefined => (typeof o === "string" ? o : isMap(o) && typeof o.id === "string" ? o.id : undefined);

  /**
   * A full copy of `Selectable`: two options, the first in `included[]` and
   * the second priced in `pricing`, so the change in price shows, and a
   * `max_select` of at least 1. Null where the two options would have the
   * same name, or one has none, as a vocabulary of one term would.
   */
  const fullSelection = (node: Schema, file: string, at: string, stack: string[]): Schema | null => {
    const props = isMap(node.properties) ? node.properties : {};
    const [available, pricing] = [props.available, props.pricing];
    if (!isMap(available) || !isMap(available.items) || !isMap(pricing) || !isMap(pricing.additionalProperties)) return null;
    const options = [0, 1].map((i) => fullNode(available.items as Schema, file, `${at}/properties/available/items`, stack, i));
    const [first, second] = options.map(nameOf);
    if (first === undefined || second === undefined || first === second) return null;
    const out: Schema = {};
    for (const [k, p] of Object.entries(props)) {
      const loc = `${at}/properties/${escape(k)}`;
      if (k === "available") out[k] = options;
      else if (k === "included") out[k] = [first];
      else if (k === "pricing") {
        const values = `${loc}/additionalProperties`;
        const given = found.mapValues.get(values)?.[0];
        out[k] = { [second]: given !== undefined ? structuredClone(given) : fullNode(pricing.additionalProperties as Schema, file, values, stack, 0) };
      }
      else if (k === "max_select") {
        const given = fromSpec(loc, 0);
        out[k] = typeof given === "number" && given >= 1 ? given : options.length;
      } else if (isMap(p)) out[k] = fullNode(p, file, loc, stack, 0);
    }
    return out;
  };

  /**
   * A value with each scalar the full builder's value at its location,
   * variant 0, where there is one: the specification's value, a primitive's
   * showcase value, or a vocabulary's representative term. The structure,
   * members, items, and keys, stays as it is.
   */
  const shown = (loc: string, x: unknown, member: boolean): unknown => {
    const { node, file } = v.node(loc);
    if (member && isScalar(x)) {
      const given = fromSpec(loc, 0);
      if (isScalar(given)) return given;
    }
    if (typeof node.$ref === "string") {
      const target = locationOf(new URL(node.$ref, file).href);
      const t = typeAt.get(target);
      if (isScalar(x) && (t?.kind === "primitive" || (t?.kind === "vocabulary" && termsOf(t, target).length > 0))) return fullType(target, [], 0).value;
      return shown(target, x, false);
    }
    for (const k of ["anyOf", "oneOf"] as const) {
      if (!Array.isArray(node[k])) continue;
      const i = node[k].findIndex((_, i) => v.valid(`${loc}/${k}/${i}`, x));
      return i < 0 ? x : shown(`${loc}/${k}/${i}`, x, false);
    }
    if (isMap(x)) {
      const props = isMap(node.properties) ? node.properties : {};
      return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, k in props ? shown(`${loc}/properties/${escape(k)}`, y, true) : isMap(node.additionalProperties) ? shown(`${loc}/additionalProperties`, y, true) : y]));
    }
    if (Array.isArray(x) && isMap(node.items)) return x.map((y) => shown(`${loc}/items`, y, true));
    return x;
  };

  /** The minimal examples by `$id`: the baseline with the values the examples show, where it holds, and else the baseline. */
  const minimals = new Map<string, unknown>();
  const minimalOf = (id: string): unknown => {
    if (minimals.has(id)) return minimals.get(id);
    const baseline = typeValue(id, []);
    const t = typeAt.get(id);
    const candidate = t?.kind === "primitive" || (t?.kind === "vocabulary" && termsOf(t, id).length > 0) ? fullType(id, [], 0).value : shown(id, baseline, false);
    const value = holds(id, candidate) === null ? candidate : baseline;
    minimals.set(id, value);
    return value;
  };

  /**
   * A named type's full example, in variant `n`. The value the full builder
   * gives is kept if it holds; otherwise the example starts from the minimal
   * one and takes each member's full value, or its minimal value, where it
   * holds, in the order of the schema's members.
   */
  const fullType = (id: string, stack: string[], n: number): { value: unknown; notes: ExampleNote[] } => {
    const memo = `${n} ${id}`;
    const done = fulls.get(memo);
    if (done) return done;
    const t = typeAt.get(id);
    if (t?.kind === "primitive") {
      const result = { value: showcaseOf(t.name, id, n), notes: [] };
      fulls.set(memo, result);
      return result;
    }
    if (t?.kind === "vocabulary") {
      const terms = termsOf(t, id);
      if (terms.length > 0) {
        const result = { value: structuredClone(terms[n % terms.length]), notes: [] };
        fulls.set(memo, result);
        return result;
      }
    }
    const minimal = minimalOf(id);
    if (stack.includes(id)) {
      // A reference back into a type being built takes the minimal value, so the example stays finite.
      return { value: minimal, notes: [{ path: "", holds: "minimal", reason: `${t?.name ?? id} holds itself, so its value inside itself is the minimal one` }] };
    }
    const { node, file } = v.node(id);
    const inner = [...stack, id];
    const selection = t?.kind === "copy" && t.of.constructor === "Selectable" ? fullSelection(node, file, id, inner) : null;
    const candidate = selection ?? fullNode(node, file, id, inner, n);
    let result: { value: unknown; notes: ExampleNote[] };
    if (holds(id, candidate) === null || !isMap(candidate) || !isMap(minimal)) {
      result = { value: holds(id, candidate) === null ? candidate : minimal, notes: holds(id, candidate) === null ? [] : [{ path: "", holds: "minimal", reason: holds(id, candidate)! }] };
    } else {
      const props = isMap(node.properties) ? node.properties : {};
      const keys = [...new Set([...Object.keys(props), ...Object.keys(candidate)])];
      let cur: Schema = {};
      // The minimal example's members first, in the schema's order, so every step starts valid.
      for (const k of keys) if (k in minimal) cur[k] = minimal[k];
      // Each pass takes every member's full value that holds, and else its minimal value if the member is absent, until a
      // pass changes nothing: a member whose condition another member meets, as a time zone does for a day part, follows.
      const why = new Map<string, string>();
      for (let changed = true; changed; ) {
        changed = false;
        for (const k of keys) {
          if (!(k in candidate) || (k in cur && same(cur[k], candidate[k]))) continue;
          const withFull = { ...cur, [k]: candidate[k] };
          const failed = holds(id, withFull);
          if (failed === null) {
            cur = withFull;
            why.delete(k);
            changed = true;
            continue;
          }
          why.set(k, failed);
          if (k in cur) continue;
          const own = isMap(props[k]) ? shown(`${id}/properties/${escape(k)}`, build(props[k] as Schema, file, [], [id]), true) : undefined;
          const withMinimal = own === undefined ? null : { ...cur, [k]: own };
          if (withMinimal !== null && holds(id, withMinimal) === null) {
            cur = withMinimal;
            changed = true;
          }
        }
      }
      const notes: ExampleNote[] = [...why].map(([k, reason]) => ({ path: `/${escape(k)}`, holds: k in cur ? ("minimal" as const) : ("omitted" as const), reason }));
      // Keep the schema's member order.
      const ordered: Schema = {};
      for (const k of keys) if (k in cur) ordered[k] = cur[k];
      result = { value: ordered, notes };
    }
    fulls.set(memo, result);
    return result;
  };

  /** Counts where the scalars of a type's own members come from, down to the named types it references. */
  const sources: ValueSources = { spec: 0, showcase: 0, term: 0, field: 0, other: 0 };
  const tally = (loc: string, x: unknown, member: boolean): void => {
    const { node, file } = v.node(loc);
    if (member && (isScalar(x) || isMap(x)) && specAt(loc).some((y) => same(y, x))) {
      sources.spec++;
      return;
    }
    if (member && (fieldAt.get(loc)?.values ?? []).some((y) => same(y, x))) {
      sources.field++;
      return;
    }
    if (typeof node.$ref === "string") {
      const target = locationOf(new URL(node.$ref, file).href);
      const t = typeAt.get(target);
      if (!isScalar(x) && t !== undefined) return;
      if (t?.kind === "primitive" && (showcases.get(t.name) ?? []).some((y) => same(y, x))) sources.showcase++;
      else if (t?.kind === "vocabulary" && termsOf(t, target).some((y) => same(y, x))) sources.term++;
      else if (t !== undefined) sources.other++;
      else tally(target, x, false);
      return;
    }
    for (const k of ["anyOf", "oneOf"] as const) {
      if (!Array.isArray(node[k])) continue;
      const i = node[k].findIndex((_, i) => v.valid(`${loc}/${k}/${i}`, x));
      if (i >= 0) tally(`${loc}/${k}/${i}`, x, false);
      return;
    }
    if (isScalar(x)) {
      if (member) sources.other++;
      return;
    }
    const props = isMap(node.properties) ? node.properties : {};
    if (isMap(x)) for (const [k, y] of Object.entries(x)) tally(k in props ? `${loc}/properties/${escape(k)}` : `${loc}/additionalProperties`, y, true);
    if (Array.isArray(x) && isMap(node.items)) for (const y of x) tally(`${loc}/items`, y, true);
  };

  /** The locations in a value whose per-field entry carries a note and gives the value there. */
  const marks = (loc: string, x: unknown, path: string, member: boolean, out: IllustrativeNote[]): void => {
    const e = member ? fieldAt.get(loc) : undefined;
    if (e?.note !== undefined && e.values.some((y) => same(y, x))) out.push({ path, note: e.note });
    const { node, file } = v.node(loc);
    if (typeof node.$ref === "string") return marks(locationOf(new URL(node.$ref, file).href), x, path, false, out);
    for (const k of ["anyOf", "oneOf"] as const) {
      if (!Array.isArray(node[k])) continue;
      const i = node[k].findIndex((_, i) => v.valid(`${loc}/${k}/${i}`, x));
      if (i >= 0) marks(`${loc}/${k}/${i}`, x, path, false, out);
      return;
    }
    const props = isMap(node.properties) ? node.properties : {};
    if (isMap(x)) {
      for (const [k, y] of Object.entries(x)) {
        if (k in props) marks(`${loc}/properties/${escape(k)}`, y, `${path}/${escape(k)}`, true, out);
        else if (isMap(node.additionalProperties)) marks(`${loc}/additionalProperties`, y, `${path}/${escape(k)}`, true, out);
      }
    }
    if (Array.isArray(x) && isMap(node.items)) x.forEach((y, i) => marks(`${loc}/items`, y, `${path}/${i}`, true, out));
  };

  const types: Record<string, TypeExample> = {};
  for (const t of [...model.types].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const id = schemaIdOf(t, schemaDir, baseOf(files, schemaDir));
    if (id === null) continue;
    const loc = locationOf(id);
    let minimal: unknown;
    let full: { value: unknown; notes: ExampleNote[] };
    try {
      minimal = minimalOf(loc);
      full = fullType(loc, [], 0);
    } catch (e) {
      problems.push(`${t.name}: no example: ${(e as Error).message}`);
      continue;
    }
    const m = failure(check(id, minimal));
    if (m !== null) problems.push(`${t.name}: the minimal example ${JSON.stringify(minimal)} fails ${m}`);
    const fullCheck = check(id, full.value);
    const f = failure(fullCheck);
    if (f !== null) problems.push(`${t.name}: the full example fails ${f}`);
    if (t.kind !== "primitive" && t.kind !== "vocabulary") tally(loc, full.value, false);
    const illustrative: IllustrativeNote[] = [];
    marks(loc, full.value, "", false, illustrative);
    types[t.name] = {
      kind: t.kind,
      schema: id,
      minimal,
      full: full.value,
      ...(full.notes.length > 0 ? { notes: full.notes } : {}),
      ...(illustrative.length > 0 ? { illustrative } : {}),
      ...(fullCheck.undecided.length > 0 ? { undecided: fullCheck.undecided } : {}),
    };
  }
  return { doc: { format: 1, lock: model.input.lock, commit: model.input.commit, types }, problems, sources };
}

/**
 * Checks a document of type examples against the lock's schemas and rules:
 * it holds one entry for every named type the schemas emit and no other, at
 * the type's `$id`, and each minimal and full example is valid and breaks no
 * rule one payload decides. Returns the problems.
 */
export function checkTypeExamples(doc: TypeExamplesDoc, input: Omit<TypeExamplesInput, "kernel" | "spec" | "fields">): string[] {
  const problems: string[] = [];
  const check = instanceChecker(input.model, input.files, input.schemaDir, input.codes, input.ruleChecks);
  const expected = new Map(input.model.types.flatMap((t) => {
    const id = schemaIdOf(t, input.schemaDir, baseOf(input.files, input.schemaDir));
    return id === null ? [] : [[t.name, id] as const];
  }));
  for (const [name, id] of expected) if (!(name in doc.types)) problems.push(`${name}: no examples`);
  for (const [name, x] of Object.entries(doc.types)) {
    const id = expected.get(name);
    if (id === undefined) {
      problems.push(`${name}: no type the schemas emit has this name`);
      continue;
    }
    if (x.schema !== id) problems.push(`${name}: names the schema ${x.schema}, not ${id}`);
    for (const which of ["minimal", "full"] as const) {
      const why = failure(check(id, x[which]));
      if (why !== null) problems.push(`${name}: the ${which} example fails ${why}`);
    }
  }
  return problems;
}

/**
 * Checks the per-field example values in scope on the lock. An entry fails
 * where no member of a type the schemas emit rests on its IR element by its
 * name, so the element or the member no longer exists; where a value fails
 * the member's emitted schema or a rule one payload decides, on its own or
 * in place in its type's full example; where a value is one the
 * specification's examples give the member, or the member it projects;
 * where the member's vocabulary now has core terms and the value isn't one;
 * and where the specification's examples give the member a value, which the
 * examples show, so the entry no longer applies. Returns the problems and
 * how many entries hold.
 */
export function checkFieldExamples(input: TypeExamplesInput): { problems: string[]; entries: number; locations: number } {
  const { model, files, schemaDir } = input;
  const lock = model.input.lock;
  const v = new Validators(files);
  const found = specValues(model, v, schemaDir, input.spec);
  const projected = projections(model, schemaDir, v.baseOf(schemaDir));
  const check = instanceChecker(model, files, schemaDir, input.codes, input.ruleChecks);
  const doc = generateTypeExamples(input).doc;
  const vocabularies = new Map(model.types.flatMap((t) => (t.kind === "vocabulary" ? [[t.name, t] as const] : [])));
  /** Every value the specification gives at a location or below it, and at the location it projects. */
  const below = (loc: string) => [...found.at].filter(([k]) => k === loc || k.startsWith(`${loc}/`)).flatMap(([, xs]) => xs);
  const givenAt = (loc: string) => {
    const p = projected(loc);
    return [...below(loc), ...(p === undefined ? [] : below(p))];
  };
  const problems: string[] = [];
  const seen = new Set<string>();
  let locations = 0;
  const located = fieldLocations(model, schemaDir, v.baseOf(schemaDir), input.fields);
  for (const { entry, locations: at } of located) {
    const key = fieldKey(entry);
    if (seen.has(key)) problems.push(`${key}: listed twice on lock "${lock}"`);
    seen.add(key);
    if (at.length === 0) {
      problems.push(`${key}: names an element that no longer exists: no member "${entry.member}" of a type the schemas emit rests on ${entry.ir} on lock "${lock}"; remove the entry, or key it by the element that now states the member`);
      continue;
    }
    locations += at.length;
    for (const l of at) {
      const where = `${l.type}.${entry.member}`;
      const given = givenAt(l.at);
      entry.values.forEach((x, n) => {
        const value = `value ${n + 1}, ${JSON.stringify(x)},`;
        const alone = check(l.at, x);
        if (alone.errors.length > 0) problems.push(`${key}: ${value} fails its field's schema at ${where}: ${alone.errors[0]!.path || "/"}: ${alone.errors[0]!.message}`);
        else if (alone.violations.length > 0) problems.push(`${key}: ${value} breaks ${alone.violations[0]!.rule} at ${where}: ${alone.violations[0]!.message}`);
        if (given.some((y) => same(y, x))) problems.push(`${key}: ${value} duplicates a specification example value at ${where}; remove the entry, since the examples show the specification's value`);
        const vocabulary = l.named === undefined ? undefined : vocabularies.get(l.named);
        if (vocabulary && vocabulary.terms.length > 0 && !vocabulary.terms.some((t) => same(t.value, x))) {
          problems.push(`${key}: ${value} isn't a core term of ${vocabulary.name}, which now has core terms (${vocabulary.terms.map((t) => JSON.stringify(t.value)).join(", ")}); remove the entry, since the examples show a core term`);
        }
        const full = doc.types[l.type]?.full;
        if (alone.errors.length === 0 && isMap(full)) {
          const inPlace = failure(check(l.schema, { ...full, [entry.member]: x }));
          if (inPlace !== null) problems.push(`${key}: ${value} breaks ${inPlace} in ${l.type}'s full example`);
        }
      });
      if (given.length > 0 && !entry.values.some((x) => given.some((y) => same(y, x)))) {
        problems.push(`${key}: the specification's examples give ${where} a value, ${JSON.stringify(given[0])}, which the examples show, so the entry no longer applies; remove it`);
      }
    }
  }
  return { problems, entries: located.length, locations };
}
