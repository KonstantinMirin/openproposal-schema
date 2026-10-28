/**
 * Stage 5e, the conformance corpus: a baseline and a mutant for each
 * constraint the emitted schemas state, plus the rule vectors, as one file
 * per lock, `corpus/cases.json` (and `corpus/with-open-prs/cases.json`).
 *
 * A constraint is one validation keyword at one place in one named type's
 * own schema: a `type`, `enum`, `const`, `pattern`, `format`, bound, length,
 * or count; each name a `required` lists, the `then` of a condition
 * included; a `$ref` a condition's `then` gives a member, which narrows its
 * type while the condition holds; an `additionalProperties: false`; and the
 * `anyOf` of a union.
 * Constraints live only on named types (type rules § 5), so a type's schema
 * is walked up to each `$ref` and no further, and every constraint belongs
 * to exactly one type. An `if` is a condition, not a constraint: a value
 * that fails it is still valid, so nothing under it is walked.
 *
 * Each constraint gets a case: a baseline, the smallest instance of its type
 * that reaches the constraint and is valid, and a mutant, the baseline with
 * the value at the constraint's instance location changed so that the
 * type's schema rejects it and the same schema with that one keyword removed
 * accepts it. So the mutant isolates the constraint: nothing else rejects it.
 * A spelling constraint on a string, a `pattern`, `format`, `enum`, or
 * `const`, also gets the trailing-newline mutant of type rules § 2, which
 * every SDK must reject, when it isolates the constraint too.
 *
 * Values come from the model's types and the kernel's reviewed vectors: a
 * primitive's baseline is its first valid vector, a vocabulary's its first
 * term, and an object's holds its required members, the member on the way
 * to the constraint, and what `minProperties` and a condition's `then`
 * need. Mutants are drawn in order from a primitive's reviewed invalid
 * vectors, then from a fixed list per keyword, and the first that isolates
 * the constraint is kept. Every step is deterministic,
 * and Ajv 2020 decides each candidate, so the file is a function of the
 * schemas, the kernel's vectors, and the rules.
 *
 * A `type` beside an `enum` or a `const` whose values all have that type
 * adds nothing the values don't state, so no mutant can isolate it. It is
 * listed as implied, with the keyword that implies it.
 *
 * The reference oracle labels the corpus: the gate runs python-jsonschema,
 * as `tools/oracle/requirements.txt` pins it, on every case, and its verdict
 * must be the label. The one exception is the known Python `$` defect: the
 * stock oracle may accept a trailing-newline mutant, which the gate counts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { installFormats } from "./formats.ts";
import { canonicalJson } from "./canonical.ts";
import { baseOf, type EmittedFile, nestedIf, schemaIdOf } from "./emit.ts";
import type { InstanceOracle } from "./examples.ts";
import type { Kernel } from "./kernel.ts";
import type { TypeRef } from "./mapping.ts";
import type { ModelDoc } from "./model.ts";
import { payloadsOf, type RulesDoc, type Vector } from "./rules.ts";

/** One constraint's case: a valid baseline and the mutants that only the constraint rejects. */
export interface ConstraintCase {
  /** `<Type>#<pointer to the keyword in the type's schema>`, with the name for a `required` entry, such as `Commitment#/then/required/currency`. */
  id: string;
  /** The named type, and the `$id` of its schema, with the fragment that points at it. */
  type: string;
  schema: string;
  keyword: string;
  /** The JSON pointer of the schema node that holds the keyword, in the type's schema. */
  at: string;
  /** The name a `required` keyword lists, or that a `dependentRequired` member requires. */
  name?: string;
  /** For `dependentRequired`, the member whose presence requires `name`. */
  member?: string;
  /** The JSON pointer of the instance location the keyword applies at. */
  path: string;
  /** Valid: the type's schema accepts it. */
  baseline: unknown;
  /** Invalid: the type's schema rejects it, and accepts it with the keyword removed. */
  mutant: unknown;
  /** Invalid: the baseline's string at `path` with a trailing newline, for a spelling constraint, where it isolates the constraint. */
  newline?: unknown;
}

/** A keyword no mutant can isolate, because a sibling keyword already states it. */
export interface ImpliedKeyword {
  id: string;
  type: string;
  keyword: string;
  at: string;
  /** The sibling keyword that implies it. */
  by: string;
}

/** One rule's vectors, as the rules state them: each valid vector conforms, and each invalid one breaks the rule alone, since the schema accepts its payloads. */
export interface RuleCases {
  rule: string;
  owner: string;
  severity: "error" | "warning";
  type?: string;
  schema?: string;
  arguments?: Record<string, TypeRef>;
  valid: Vector[];
  invalid: Vector[];
}

export interface CorpusDoc {
  format: 1;
  input: { lock: string; commit: string; blob: string };
  /** The reference oracle that labels the cases, as `tools/oracle/requirements.txt` pins it. */
  oracle: { jsonschema: string };
  constraints: ConstraintCase[];
  implied: ImpliedKeyword[];
  rules: RuleCases[];
}

export const CORPUS_FILE = "cases.json";

/**
 * A lock's corpus directory, from its IR directory, as its schema directory
 * is: `ir` gives `corpus`, and `ir/with-open-prs` gives `corpus/with-open-prs`.
 */
export function corpusDirOf(irDir: string): string {
  const rest = posix.relative("ir", irDir.split("\\").join("/"));
  if (rest.startsWith("..")) throw new Error(`the IR directory "${irDir}" isn't under ir/`);
  return posix.join("corpus", rest);
}

export const renderCorpus = (doc: CorpusDoc): string => canonicalJson(doc);

type Schema = Record<string, unknown>;
const isMap = (v: unknown): v is Schema => v !== null && typeof v === "object" && !Array.isArray(v);
const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const escape = (token: string) => token.replaceAll("~", "~0").replaceAll("/", "~1");
const unescape = (token: string) => token.replaceAll("~1", "/").replaceAll("~0", "~");
const tokens = (pointer: string) => (pointer === "" ? [] : pointer.slice(1).split("/").map(unescape));
const pointerOf = (ts: string[]) => ts.map((t) => `/${escape(t)}`).join("");

/** Keywords that hold a constraint of their own. `anyOf` is also an applicator, and `additionalProperties` is a constraint only when it is `false`. */
const CONSTRAINT_KEYWORDS = new Set([
  "type", "enum", "const", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "required", "dependentRequired", "anyOf",
]);
/** Keywords that only apply other schemas, or that annotate. */
const PASSIVE_KEYWORDS = new Set(["$ref", "properties", "items", "additionalProperties", "propertyNames", "if", "then", "else", "dependentSchemas", "description", "title", "$schema", "$id", "examples", "default"]);
/** The keywords that restrict how a string is spelled, so a trailing newline breaks a valid value (type rules § 2). */
const SPELLING = new Set(["pattern", "format", "enum", "const"]);
/** The member a mutant adds to a closed object: a name no object in the model defines. */
const EXTRA_MEMBER = "undefined_member";

/** One constraint the walk finds: the keyword, where its node sits, the name for a `required` entry, and the member that requires it for a `dependentRequired` entry. */
interface Found {
  keyword: string;
  at: string;
  name?: string;
  member?: string;
}

const jsonType = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const hasType = (v: unknown, t: unknown): boolean => {
  const types = Array.isArray(t) ? t : [t];
  const j = jsonType(v);
  return types.some((x) => x === j || (x === "number" && j === "integer"));
};

/**
 * Walks a named type's own schema: every node up to a `$ref`, except under
 * an `if`. Returns the constraints, the implied keywords, and the keywords
 * the corpus doesn't know, which fail it.
 */
export function constraintsOf(schema: Schema): { found: Found[]; implied: (Found & { by: string })[]; unknown: string[] } {
  const found: Found[] = [];
  const implied: (Found & { by: string })[] = [];
  const unknown: string[] = [];
  const walk = (node: Schema, at: string) => {
    // A `$ref` that a condition's `then` gives a member narrows the member's type while the condition holds, so it is a constraint.
    if (typeof node.$ref === "string" && /\/then\/properties\/[^/]+$/.test(at)) found.push({ keyword: "$ref", at });
    for (const [k, v] of Object.entries(node)) {
      if (k === "then" && v === false) {
        // A part's `if` / `then: false` rejects one value of one member (type rules § 4): the `then` is the constraint.
        found.push({ keyword: k, at });
      } else if (k === "required" && Array.isArray(v)) {
        for (const name of v) found.push({ keyword: k, at, name: String(name) });
      } else if (k === "dependentRequired" && isMap(v)) {
        for (const [member, names] of Object.entries(v)) for (const name of Array.isArray(names) ? names : []) found.push({ keyword: k, at, member, name: String(name) });
      } else if (k === "additionalProperties" && v === false) {
        found.push({ keyword: k, at });
      } else if (k === "type" && ("enum" in node || "const" in node)) {
        const values = "const" in node ? [node.const] : Array.isArray(node.enum) ? node.enum : [];
        if (values.every((x) => hasType(x, v))) implied.push({ keyword: k, at, by: "const" in node ? "const" : "enum" });
        else found.push({ keyword: k, at });
      } else if (CONSTRAINT_KEYWORDS.has(k)) {
        found.push({ keyword: k, at });
      } else if (!PASSIVE_KEYWORDS.has(k)) {
        unknown.push(`${at || "/"}: "${k}"`);
      }
      if ((k === "properties" || k === "dependentSchemas") && isMap(v)) {
        for (const [name, s] of Object.entries(v)) if (isMap(s)) walk(s, `${at}/${k}/${escape(name)}`);
      } else if (k === "anyOf" && Array.isArray(v)) {
        v.forEach((s, i) => isMap(s) && walk(s, `${at}/anyOf/${i}`));
      } else if ((k === "items" || k === "propertyNames" || k === "then" || k === "else" || k === "additionalProperties") && isMap(v)) {
        walk(v, `${at}/${k}`);
      }
    }
  };
  walk(schema, "");
  return { found, implied, unknown };
}

const caseId = (type: string, f: Found) => `${type}#${f.at}/${f.keyword}${f.member !== undefined ? `/${escape(f.member)}` : ""}${f.name !== undefined ? `/${escape(f.name)}` : ""}`;

/** The node a pointer names, from a schema. */
function nodeAt(schema: Schema, at: string): Schema {
  let node: unknown = schema;
  for (const t of tokens(at)) node = Array.isArray(node) ? node[Number(t)] : isMap(node) ? node[t] : undefined;
  if (!isMap(node)) throw new Error(`no schema at ${at || "/"}`);
  return node;
}

/** The type's schema with one constraint removed: the keyword, or the one name of a `required`. */
function relaxedSchema(schema: Schema, f: Found): Schema {
  const copy = structuredClone(schema);
  const node = nodeAt(copy, f.at);
  if (f.keyword === "required" && Array.isArray(node.required)) {
    const rest = node.required.filter((n) => n !== f.name);
    if (rest.length > 0) node.required = rest;
    else delete node.required;
  } else if (f.keyword === "dependentRequired" && isMap(node.dependentRequired) && f.member !== undefined) {
    const deps = node.dependentRequired;
    const rest = (Array.isArray(deps[f.member]) ? (deps[f.member] as unknown[]) : []).filter((n) => n !== f.name);
    if (rest.length > 0) deps[f.member] = rest;
    else delete deps[f.member];
    if (Object.keys(deps).length === 0) delete node.dependentRequired;
  } else {
    delete node[f.keyword];
  }
  return copy;
}

/** Every `$ref` of a schema made absolute against the `$id` of the file it sits in, so the schema compiles on its own. */
function absolute(schema: unknown, base: string): unknown {
  if (Array.isArray(schema)) return schema.map((s) => absolute(s, base));
  if (!isMap(schema)) return schema;
  return Object.fromEntries(Object.entries(schema).flatMap(([k, v]) => (k === "$id" || k === "$schema" ? [] : [[k, k === "$ref" && typeof v === "string" ? new URL(v, base).href : absolute(v, base)]])));
}

function setAt(value: unknown, path: string[], replace: (v: unknown) => unknown): unknown {
  if (path.length === 0) return replace(value);
  const [head, ...rest] = path as [string, ...string[]];
  if (Array.isArray(value)) return value.map((x, i) => (i === Number(head) ? setAt(x, rest, replace) : x));
  if (isMap(value)) return { ...value, [head]: setAt(value[head], rest, replace) };
  throw new Error(`the baseline has no ${head}`);
}

function getAt(value: unknown, path: string[]): unknown {
  let v = value;
  for (const t of path) v = Array.isArray(v) ? v[Number(t)] : isMap(v) ? v[t] : undefined;
  return v;
}

const omit = (o: Schema, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/** Values of other JSON types, for a `type` or a union: the first one that isolates the constraint is kept. */
const OTHER_TYPES: unknown[] = ["", 0, 0.5, true, null, [], {}];

/** The schemas of one lock, loaded twice: strict, as the published schemas are checked, and lax, for the relaxed copies, which are fixtures and not published. */
export class Validators {
  private readonly strict: Ajv2020;
  private readonly lax: Ajv2020;
  private readonly relaxed = new Map<string, (v: unknown) => boolean>();
  readonly byId: Map<string, Schema>;

  constructor(private readonly files: EmittedFile[]) {
    this.strict = new Ajv2020({ strict: true, strictRequired: false, allErrors: false });
    this.lax = new Ajv2020({ strict: false, allErrors: false, validateSchema: false });
    installFormats(this.strict);
    installFormats(this.lax);
    for (const f of files) {
      this.strict.addSchema(f.schema);
      this.lax.addSchema(f.schema);
    }
    this.byId = new Map(files.map((f) => [String(f.schema.$id), f.schema]));
  }
  /** The base of the tree's `$id`s, for a type's `$id` (`schemaIdOf`). */
  baseOf(dir: string): string | null {
    return baseOf(this.files, dir);
  }


  /** Whether the schema with this `$id` and fragment accepts the value; throws if no file holds it. */
  valid(schema: string, value: unknown): boolean {
    const validate = this.strict.getSchema(schema);
    if (!validate) throw new Error(`no schema has the $id ${schema}`);
    return validate(value) as boolean;
  }

  /** The schema node an `$id` and fragment name, and the `$id` of its file. */
  node(schema: string): { node: Schema; file: string } {
    const [file, fragment = ""] = schema.split("#") as [string, string?];
    const root = this.byId.get(file);
    if (!root) throw new Error(`no schema has the $id ${file}`);
    return { node: nodeAt(root, fragment), file };
  }

  /** Whether the type's schema with one constraint removed accepts the value. */
  relaxedValid(schema: string, f: Found, value: unknown): boolean {
    const key = `${schema} ${f.at} ${f.keyword} ${f.member ?? ""} ${f.name ?? ""}`;
    let validate = this.relaxed.get(key);
    if (!validate) {
      const { node, file } = this.node(schema);
      const compiled = this.lax.compile(absolute(relaxedSchema(node, f), file) as Schema);
      validate = (v: unknown) => compiled(v) as boolean;
      this.relaxed.set(key, validate);
    }
    return validate(value);
  }
}

export interface CorpusInput {
  model: ModelDoc;
  files: EmittedFile[];
  rules: RulesDoc;
  kernel: Kernel;
  /** The lock's schema directory, such as `schemas`, for each type's `$id`. */
  schemaDir: string;
  /** The jsonschema version the oracle requirements pin. */
  oracle: string;
}

/** A builder of valid instances: `typeValue` for a named type by its `$id`, and `build` for a schema node. */
export interface Baselines {
  /** A valid value of the named type an `$id` names: a primitive's first valid vector, or one built from its schema. */
  typeValue: (id: string, stack: string[]) => unknown;
  /**
   * A valid value of a schema node, in the file `file`, that reaches the
   * node `force` points at. `pin` fixes members of the object at the top,
   * as a condition's `if` fixes them, so the members their conditions
   * require and narrow follow.
   */
  build: (node: Schema, file: string, force: string[], stack: string[], pin?: Record<string, unknown>) => unknown;
}

/**
 * The value each part whose rules read its members starts from, by the
 * part's schema node: a value every rule of the part lists as valid, such as
 * a daypart window whose `end` is later than its `start`, so a value built
 * from it holds the part's rules as well as its schema.
 */
export function partSeeds(model: ModelDoc, v: Validators, schemaDir: string): Map<Schema, Schema> {
  const seeds = new Map<Schema, Schema>();
  for (const t of model.types) {
    if (t.kind !== "part") continue;
    const rules = model.kernel_rules.filter((r) => r.owner === t.name);
    if (rules.length === 0) continue;
    const seed = rules[0]!.valid.find((x) => rules.every((r) => r.valid.some((y) => canonicalJson(y) === canonicalJson(x))));
    if (!isMap(seed)) throw new Error(`no valid vector of every rule of the part "${t.name}" is an object to start from`);
    const id = schemaIdOf(t, schemaDir, v.baseOf(schemaDir));
    if (id !== null) seeds.set(v.node(id).node, seed);
  }
  return seeds;
}

/**
 * The baseline builder the corpus and the fidelity gate share: a
 * primitive's baseline is its first valid vector, a vocabulary's its first
 * term, and an object's holds its required members, the member on the way
 * to a constraint, and what `minProperties` and a condition's `then` need.
 */
export function baselines(model: ModelDoc, v: Validators, kernel: Kernel, schemaDir: string): Baselines {
  const base = v.baseOf(schemaDir);
  const typeAt = new Map(model.types.flatMap((t) => {
    const id = schemaIdOf(t, schemaDir, base);
    return id === null ? [] : [[id, t] as const];
  }));
  const vectors = new Map(kernel.primitives.map((p) => [p.name, p.vectors.valid]));
  const memo = new Map<string, unknown>();
  const seeds = partSeeds(model, v, schemaDir);
  /** A valid value of the named type an `$id` names: a primitive's first valid vector, or one built from its schema. */
  const typeValue = (id: string, stack: string[]): unknown => {
    if (memo.has(id)) return memo.get(id);
    if (stack.includes(id)) throw new Error(`a reference cycle through ${id}`);
    const t = typeAt.get(id);
    let value: unknown;
    if (t?.kind === "primitive") {
      const valid = vectors.get(t.name) ?? [];
      if (valid.length === 0) throw new Error(`the primitive "${t.name}" has no valid vector to start from`);
      value = valid[0];
    } else {
      const { node, file } = v.node(id);
      value = build(node, file, [], [...stack, id]);
    }
    memo.set(id, value);
    return value;
  };

  /** The `if` of an object, read as the members it fixes: each required member with a `const`. */
  const conditionOf = (node: Schema): Record<string, unknown> | null => {
    const c = node.if;
    if (!isMap(c)) return null;
    const required = Array.isArray(c.required) ? c.required.map(String) : [];
    const props = isMap(c.properties) ? c.properties : {};
    const fixed: Record<string, unknown> = {};
    for (const k of required) {
      const p = props[k];
      if (!isMap(p) || !("const" in p)) throw new Error(`an "if" whose member "${k}" has no "const"`);
      fixed[k] = p.const;
    }
    return fixed;
  };
  const holds = (value: Schema, fixed: Record<string, unknown>) => Object.entries(fixed).every(([k, c]) => k in value && canonicalJson(value[k]) === canonicalJson(c));

  /** A value of a member's schema that holds the members a dependency's `if` requires of it, each built from its own schema. */
  const holding = (memberSchema: unknown, file: string, value: unknown, inner: string[], stack: string[]): Schema => {
    if (!isMap(memberSchema) || typeof memberSchema.$ref !== "string") throw new Error(`a dependency's member has no $ref to an object`);
    const target = v.node(new URL(memberSchema.$ref, file).href);
    const props = isMap(target.node.properties) ? target.node.properties : {};
    const out: Schema = { ...(isMap(value) ? value : {}) };
    for (const k of inner) {
      const p = props[k];
      if (!isMap(p)) throw new Error(`the dependency's member has no "${k}"`);
      if (!(k in out)) out[k] = build(p, target.file, [], stack);
    }
    return out;
  };

  /**
   * A valid value of a schema node, in the file `file`, that reaches the
   * node `force` points at: each step on the way is present, an `anyOf`
   * takes the branch it names, and a `then` has its `if` hold.
   */
  const build = (node: Schema, file: string, force: string[], stack: string[], pin: Record<string, unknown> = {}): unknown => {
    const [head, next, ...rest] = force;
    if (typeof node.$ref === "string") {
      if (force.length > 0) throw new Error(`the path ${pointerOf(force)} runs through a $ref`);
      return typeValue(new URL(node.$ref, file).href, stack);
    }
    if (Array.isArray(node.anyOf)) {
      const i = head === "anyOf" ? Number(next) : 0;
      const branch = node.anyOf[i];
      if (!isMap(branch)) throw new Error(`no anyOf branch ${i}`);
      return build(branch, file, head === "anyOf" ? rest : force, stack, pin);
    }
    if ("const" in node) return node.const;
    if (Array.isArray(node.enum)) return node.enum[0];
    const type = node.type;
    if (type === "object" || isMap(node.properties)) {
      const props = isMap(node.properties) ? node.properties : {};
      const out: Schema = {};
      const keys = new Set(Array.isArray(node.required) ? node.required.map(String) : []);
      const fixed: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(pin)) {
        fixed[k] = x;
        keys.add(k);
      }
      if (head === "properties" && next !== undefined) keys.add(next);
      // A constraint in a dependency's `then`: the member is present and holds what the dependency's `if` requires of it.
      let dependency: string | null = null;
      if (head === "dependentSchemas" && next !== undefined) {
        keys.add(next);
        if (rest.length === 1 && rest[0] === "then" && nestedIf(node, next) !== null) dependency = next;
        else if (rest.length > 0) throw new Error(`a constraint nested in "dependentSchemas" at ${pointerOf(force)}`);
      }
      // A constraint in a condition's `then`, at the end of a chain of `else`: the condition holds, and a typed member is present.
      const narrowed: Record<string, Schema> = {};
      if (head === "then" || head === "else") {
        let c: Schema = node;
        let i = 0;
        while (force[i] === "else" && isMap(c.else)) (c = c.else as Schema), i++;
        if (force[i] !== "then" || !isMap(c.then)) throw new Error(`the corpus can't reach ${pointerOf(force)} in a condition`);
        Object.assign(fixed, conditionOf(c) ?? {});
        for (const k of Object.keys(fixed)) keys.add(k);
        const after = force.slice(i + 1);
        const thenProps = isMap(c.then.properties) ? c.then.properties : {};
        if (after.length === 2 && after[0] === "properties" && isMap(thenProps[after[1]!])) {
          keys.add(after[1]!);
          narrowed[after[1]!] = thenProps[after[1]!] as Schema;
        } else if (after.length > 0) throw new Error(`a constraint nested in "then" at ${pointerOf(force)}`);
      }
      const seed = seeds.get(node);
      if (seed) for (const k of Object.keys(seed)) keys.add(k);
      for (const k of [...keys].sort(byString)) {
        const p = narrowed[k] ?? props[k];
        const forced = head === "properties" && k === next;
        if (k in fixed) out[k] = fixed[k];
        else if (seed && k in seed && !forced) out[k] = structuredClone(seed[k]);
        else if (isMap(p)) out[k] = build(p, file, forced ? rest : [], stack);
        else throw new Error(`the member "${k}" has no schema`);
      }
      if (dependency !== null) out[dependency] = holding(props[dependency], file, out[dependency], nestedIf(node, dependency)!, stack);
      if (head === "additionalProperties") {
        const values = node.additionalProperties;
        if (!isMap(values)) throw new Error(`no additionalProperties schema at ${pointerOf(force)}`);
        const key = isMap(node.propertyNames) ? String(build(node.propertyNames, file, [], stack)) : "key";
        out[key] = build(values, file, force.slice(1), stack);
      } else if (head !== undefined && !["properties", "dependentSchemas", "then", "else"].includes(head)) {
        throw new Error(`the corpus can't reach ${pointerOf(force)} in an object`);
      }
      const min = typeof node.minProperties === "number" ? node.minProperties : 0;
      for (const k of Object.keys(props).sort(byString)) {
        if (Object.keys(out).length >= min) break;
        const p = props[k];
        if (!(k in out) && isMap(p)) out[k] = build(p, file, [], stack);
      }
      // Each member present brings the members it requires, and the condition that holds, along the chain, brings the members
      // its `then` requires and types the ones it narrows, until none is missing.
      const dependent = isMap(node.dependentRequired) ? node.dependentRequired : {};
      for (let grew = true; grew; ) {
        grew = false;
        for (const [m, names] of Object.entries(dependent).sort(([a], [b]) => byString(a, b))) {
          if (!(m in out) || !Array.isArray(names)) continue;
          for (const k of names.map(String)) {
            const p = props[k];
            if (!(k in out) && isMap(p)) {
              out[k] = build(p, file, [], stack);
              grew = true;
            }
          }
        }
        // A dependency whose `if` requires members of the member it keys: met, it brings the members its `then` requires.
        for (const m of Object.keys(isMap(node.dependentSchemas) ? node.dependentSchemas : {}).sort(byString)) {
          const inner = nestedIf(node, m);
          const value = out[m];
          if (inner === null || !isMap(value) || !inner.every((x) => x in value)) continue;
          const then = (node.dependentSchemas as Schema)[m] as Schema;
          for (const k of (Array.isArray((then.then as Schema).required) ? ((then.then as Schema).required as unknown[]) : []).map(String).sort(byString)) {
            const p = props[k];
            if (!(k in out) && isMap(p)) {
              out[k] = build(p, file, [], stack);
              grew = true;
            }
          }
        }
        for (let c: Schema | undefined = node; c !== undefined; c = isMap(c.else) ? (c.else as Schema) : undefined) {
          const condition = conditionOf(c);
          if (!condition || !holds(out, condition) || !isMap(c.then)) continue;
          for (const k of (Array.isArray(c.then.required) ? c.then.required : []).map(String).sort(byString)) {
            const p = props[k];
            if (!(k in out) && isMap(p)) {
              out[k] = build(p, file, [], stack);
              grew = true;
            }
          }
          const thenProps = isMap(c.then.properties) ? c.then.properties : {};
          for (const k of Object.keys(thenProps).sort(byString)) if (k in out && !(k in narrowed) && isMap(thenProps[k])) out[k] = build(thenProps[k] as Schema, file, [], stack);
        }
      }
      return out;
    }
    if (type === "array") {
      const items = node.items;
      if (!isMap(items)) throw new Error(`an array with no items schema`);
      if (head === "items") return [build(items, file, force.slice(1), stack)];
      if (force.length > 0) throw new Error(`the corpus can't reach ${pointerOf(force)} in an array`);
      const n = typeof node.minItems === "number" ? node.minItems : 0;
      if (n > 1 && node.uniqueItems === true) throw new Error(`a unique list of at least ${n} items`);
      return Array.from({ length: n }, () => build(items, file, [], stack));
    }
    if (force.length > 0) throw new Error(`the corpus can't reach ${pointerOf(force)}`);
    if (type === "string") {
      if ("pattern" in node || "format" in node) throw new Error(`a string with a pattern or format outside a primitive, so no vector to start from`);
      return "x".repeat(typeof node.minLength === "number" && node.minLength > 1 ? node.minLength : 1);
    }
    if (type === "integer" || type === "number") {
      const lo = typeof node.minimum === "number" ? node.minimum : typeof node.exclusiveMinimum === "number" ? node.exclusiveMinimum + 1 : 0;
      const hi = typeof node.maximum === "number" ? node.maximum : typeof node.exclusiveMaximum === "number" ? node.exclusiveMaximum - 1 : lo;
      return Math.min(lo, hi);
    }
    if (type === "boolean") return true;
    if (type === "null") return null;
    if (type === undefined) return {};
    throw new Error(`the type ${JSON.stringify(type)}`);
  };
  return { typeValue, build };
}

/**
 * Generates one lock's corpus. Returns the document and the problems; a
 * problem means the file isn't to be written. Fails on a keyword the corpus
 * doesn't know, on a type it can't build a valid baseline for, on a
 * constraint no mutant isolates, and on a rule without a valid and an
 * invalid vector.
 */
export function generateCorpus(input: CorpusInput): { doc: CorpusDoc; problems: string[] } {
  const { model, files, rules, kernel, schemaDir } = input;
  const problems: string[] = [];
  const v = new Validators(files);
  const base = baseOf(files, schemaDir);
  const types = model.types.flatMap((t) => {
    const id = schemaIdOf(t, schemaDir, base);
    return id === null ? [] : [{ type: t, id }];
  });
  const typeAt = new Map(types.map((x) => [x.id, x.type]));
  const vectors = new Map(kernel.primitives.map((p) => [p.name, p.vectors.valid]));
  const rejected = new Map(kernel.primitives.map((p) => [p.name, p.vectors.invalid]));

  // Baselines -------------------------------------------------------------
  const { typeValue, build } = baselines(model, v, kernel, schemaDir);

  /**
   * The instance location a constraint applies at, and the object schema
   * that describes the instance there, for the mutants that add or remove
   * members: the nearest node on the way that lists `properties`.
   */
  const locate = (root: Schema, at: string, baseline: unknown): { path: string[]; object: Schema | null } => {
    const path: string[] = [];
    let node: Schema = root;
    let object: Schema | null = isMap(root.properties) ? root : null;
    const ts = tokens(at);
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i]!;
      if (t === "properties") {
        const name = ts[++i]!;
        path.push(name);
        node = (node.properties as Schema)[name] as Schema;
        object = null;
      } else if (t === "items") {
        path.push("0");
        node = node.items as Schema;
        object = null;
      } else if (t === "additionalProperties") {
        const here = getAt(baseline, path);
        const key = isMap(here) ? Object.keys(here).find((k) => !isMap(node.properties) || !(k in node.properties)) : undefined;
        if (key === undefined) throw new Error(`no map entry at ${at}`);
        path.push(key);
        node = node.additionalProperties as Schema;
        object = null;
      } else if (t === "anyOf") {
        node = (node.anyOf as Schema[])[Number(ts[++i])]!;
      } else if (t === "dependentSchemas") {
        node = (node.dependentSchemas as Schema)[ts[++i]!] as Schema;
      } else if (t === "then" || t === "else") {
        node = node[t] as Schema;
      } else {
        throw new Error(`the corpus can't follow "${t}" at ${at}`);
      }
      if (isMap(node.properties)) object = node;
    }
    return { path, object };
  };

  /** The values a mutant may put at the constraint's location, in the order they are tried. */
  const candidates = (f: Found, node: Schema, value: unknown, object: Schema | null, file: string, stack: string[]): unknown[] => {
    const s = typeof value === "string" ? value : "";
    const n = typeof value === "number" ? value : 0;
    const obj = isMap(value) ? value : {};
    const arr = Array.isArray(value) ? value : [];
    const k = node[f.keyword];
    switch (f.keyword) {
      case "type":
        return [...(hasType(0.5, k) || !hasType(0, k) ? [] : [n + 0.5]), ...OTHER_TYPES.filter((x) => !hasType(x, k))];
      case "anyOf":
        return OTHER_TYPES;
      case "enum": {
        const nums = (Array.isArray(k) ? k : []).filter((x): x is number => typeof x === "number");
        return ["", "x", ...(nums.length > 0 ? [Math.max(...nums) + 1, Math.min(...nums) - 1] : []), ...OTHER_TYPES];
      }
      case "const":
        return [typeof k === "string" ? `${k}x` : typeof k === "number" ? k + 1 : typeof k === "boolean" ? !k : "", "", ...OTHER_TYPES];
      case "pattern":
        return ["", "x", " "];
      case "format":
        return ["", "x"];
      case "minimum":
        return [Number(k) - 1, Number(k) - 0.5];
      case "maximum":
        return [Number(k) + 1, Number(k) + 0.5];
      case "exclusiveMinimum":
        return [Number(k), Number(k) - 1];
      case "exclusiveMaximum":
        return [Number(k), Number(k) + 1];
      case "minLength":
        return [s.slice(0, Math.max(0, Number(k) - 1)), ""];
      case "maxLength": {
        const max = Number(k);
        const seg = /^[^.:/@_-]*[.:/@_-]/.exec(s)?.[0] ?? "";
        const prefixed = seg === "" ? [] : [seg.repeat(Math.ceil((max + 1 - s.length) / seg.length)) + s];
        return [...prefixed, "a".repeat(max + 1)];
      }
      case "minItems":
        return [arr.slice(0, Math.max(0, Number(k) - 1))];
      case "maxItems":
        return arr.length > 0 ? [Array.from({ length: Number(k) + 1 }, () => arr[0])] : [];
      case "uniqueItems":
        return arr.length > 0 ? [[...arr, arr[0]]] : [];
      case "required":
      case "dependentRequired":
        return [omit(obj, [f.name!])];
      case "then": {
        // `then: false`: the value with the member the `if` fixes set to its `const`.
        const c = isMap(node.if) && isMap(node.if.properties) ? node.if.properties : {};
        return [{ ...obj, ...Object.fromEntries(Object.entries(c).flatMap(([m, x]) => (isMap(x) && "const" in x ? [[m, x.const]] : []))) }];
      }
      case "$ref": {
        // A narrowed member: the referenced primitive's reviewed invalid vectors, then values of other types.
        const ref = typeof k === "string" ? typeAt.get(new URL(k, file).href) : undefined;
        return [...(ref?.kind === "primitive" ? (rejected.get(ref.name) ?? []) : []), ...OTHER_TYPES];
      }
      case "additionalProperties": {
        const optional = Object.keys(obj).filter((x) => !(Array.isArray(node.required) && node.required.includes(x))).sort(byString);
        return [{ ...obj, [EXTRA_MEMBER]: true }, ...optional.map((x) => ({ ...omit(obj, [x]), [EXTRA_MEMBER]: obj[x] }))];
      }
      case "minProperties": {
        const present = Object.keys(obj).sort(byString);
        return [{}, ...present.map((x) => omit(obj, [x]))];
      }
      case "maxProperties": {
        const props = object && isMap(object.properties) ? object.properties : {};
        const out: unknown[] = [];
        let grown: Schema = { ...obj };
        for (const x of Object.keys(props).sort(byString)) {
          const p = props[x];
          if (x in grown || !isMap(p)) continue;
          grown = { ...grown, [x]: build(p, file, [], stack) };
          out.push(grown);
        }
        return out;
      }
      default:
        return [];
    }
  };

  // Constraint cases ------------------------------------------------------
  const constraints: ConstraintCase[] = [];
  const implied: ImpliedKeyword[] = [];
  for (const { type: t, id } of types) {
    const { node, file } = v.node(id);
    const walked = constraintsOf(node);
    for (const u of walked.unknown) problems.push(`${t.name}: ${u} is a keyword the corpus doesn't know, so it can't build a case for it`);
    for (const x of walked.implied) implied.push({ id: caseId(t.name, x), type: t.name, keyword: x.keyword, at: x.at, by: x.by });
    for (const f of walked.found) {
      const cid = caseId(t.name, f);
      let baseline: unknown;
      let where: { path: string[]; object: Schema | null };
      try {
        // A dependency's baseline holds the member that requires the name, so removing the name breaks only the dependency.
        const force = f.keyword === "dependentRequired" ? [...tokens(f.at), "properties", f.member!] : tokens(f.at);
        baseline = t.kind === "primitive" ? typeValue(id, []) : build(node, file, force, [id]);
        where = locate(node, f.at, baseline);
      } catch (e) {
        problems.push(`${cid}: no baseline: ${(e as Error).message}`);
        continue;
      }
      if (!v.valid(id, baseline)) {
        problems.push(`${cid}: the baseline ${JSON.stringify(baseline)} isn't valid against ${t.name}'s schema`);
        continue;
      }
      const here = getAt(baseline, where.path);
      const atNode = nodeAt(node, f.at);
      const isolates = (candidate: unknown) => {
        const instance = setAt(baseline, where.path, () => candidate);
        return canonicalJson(instance) !== canonicalJson(baseline) && !v.valid(id, instance) && v.relaxedValid(id, f, instance) ? instance : undefined;
      };
      let mutant: unknown;
      // A primitive's reviewed invalid vectors come first, then the keyword's own list.
      for (const c of [...(t.kind === "primitive" ? (rejected.get(t.name) ?? []) : []), ...candidates(f, atNode, here, where.object, file, [id])]) {
        mutant = isolates(c);
        if (mutant !== undefined) break;
      }
      if (mutant === undefined) {
        problems.push(`${cid}: no mutant isolates the constraint: every candidate is valid, or something beside the constraint rejects it`);
        continue;
      }
      const newline = SPELLING.has(f.keyword) && typeof here === "string" ? isolates(`${here}\n`) : undefined;
      constraints.push({
        id: cid,
        type: t.name,
        schema: id,
        keyword: f.keyword,
        at: f.at,
        ...(f.name !== undefined ? { name: f.name } : {}),
        ...(f.member !== undefined ? { member: f.member } : {}),
        path: pointerOf(where.path),
        baseline,
        mutant,
        ...(newline !== undefined ? { newline } : {}),
      });
    }
  }

  // Rule cases --------------------------------------------------------------
  const ruleCases: RuleCases[] = rules.rules.map((r) => ({
    rule: r.id,
    owner: r.owner,
    severity: r.severity,
    ...(r.vectors.type !== undefined ? { type: r.vectors.type } : {}),
    ...(r.vectors.schema !== undefined ? { schema: r.vectors.schema } : {}),
    ...(r.vectors.arguments !== undefined ? { arguments: r.vectors.arguments } : {}),
    valid: r.vectors.valid,
    invalid: r.vectors.invalid,
  }));
  for (const r of ruleCases) {
    if (r.valid.length === 0 || r.invalid.length === 0) problems.push(`rule "${r.rule}": ${r.valid.length} valid and ${r.invalid.length} invalid vectors; every rule needs an isolating invalid vector and a valid one`);
  }

  const ids = new Set<string>();
  for (const c of [...constraints, ...implied]) {
    if (ids.has(c.id)) problems.push(`${c.id}: two constraints have one ID`);
    ids.add(c.id);
  }
  const doc: CorpusDoc = {
    format: 1,
    input: { lock: model.input.lock, commit: model.input.commit, blob: model.input.blob },
    oracle: { jsonschema: input.oracle },
    constraints: constraints.sort((a, b) => byString(a.id, b.id)),
    implied: implied.sort((a, b) => byString(a.id, b.id)),
    rules: ruleCases.sort((a, b) => byString(a.rule, b.rule)),
  };
  return { doc, problems };
}

/**
 * The isolation gate, independent of the generator: the constraints the
 * emitted schemas state are exactly the corpus's cases and implied keywords;
 * every baseline is valid; every mutant is invalid, and valid with its one
 * keyword removed; every implied keyword's sibling states it; and every rule
 * of the lock has its vectors, at least one valid and one invalid, whose
 * payloads its type's schema accepts, so the rule alone decides each.
 */
export function checkCorpus(doc: CorpusDoc, files: EmittedFile[], model: ModelDoc, rules: RulesDoc, schemaDir: string): string[] {
  const problems: string[] = [];
  const v = new Validators(files);
  const want = new Map<string, { found: Found; type: string; schema: string }>();
  const wantImplied = new Map<string, string>();
  const base = baseOf(files, schemaDir);
  for (const t of model.types) {
    const id = schemaIdOf(t, schemaDir, base);
    if (id === null) continue;
    const walked = constraintsOf(v.node(id).node);
    for (const f of walked.found) want.set(caseId(t.name, f), { found: f, type: t.name, schema: id });
    for (const f of walked.implied) wantImplied.set(caseId(t.name, f), f.by);
  }
  const have = new Map(doc.constraints.map((c) => [c.id, c]));
  for (const id of want.keys()) if (!have.has(id)) problems.push(`${id}: a constraint with no case`);
  for (const id of have.keys()) if (!want.has(id)) problems.push(`${id}: a case for no constraint the schemas state`);
  const implied = new Map(doc.implied.map((x) => [x.id, x.by]));
  for (const [id, by] of wantImplied) if (implied.get(id) !== by) problems.push(`${id}: implied by "${by}", which the corpus doesn't list`);
  for (const id of implied.keys()) if (!wantImplied.has(id)) problems.push(`${id}: listed as implied, but no sibling implies it`);

  for (const c of doc.constraints) {
    const w = want.get(c.id);
    if (!w) continue;
    if (c.schema !== w.schema || c.type !== w.type) {
      problems.push(`${c.id}: names ${c.type} at ${c.schema}, not ${w.type} at ${w.schema}`);
      continue;
    }
    try {
      if (!v.valid(c.schema, c.baseline)) problems.push(`${c.id}: the baseline is invalid`);
      for (const [label, m] of [["mutant", c.mutant], ["newline mutant", c.newline]] as const) {
        if (label === "newline mutant" && !("newline" in c)) continue;
        if (v.valid(c.schema, m)) problems.push(`${c.id}: the ${label} is valid`);
        else if (!v.relaxedValid(c.schema, w.found, m)) problems.push(`${c.id}: the ${label} doesn't isolate the constraint: the schema without "${c.keyword}" rejects it too`);
      }
    } catch (e) {
      problems.push(`${c.id}: ${(e as Error).message}`);
    }
  }

  const byRule = new Map(doc.rules.map((r) => [r.rule, r]));
  for (const r of rules.rules) {
    const c = byRule.get(r.id);
    if (!c) {
      problems.push(`rule "${r.id}": no cases in the corpus`);
      continue;
    }
    if (canonicalJson([c.valid, c.invalid]) !== canonicalJson([r.vectors.valid, r.vectors.invalid])) problems.push(`rule "${r.id}": the corpus's vectors aren't the rule's`);
    if (c.valid.length === 0 || c.invalid.length === 0) problems.push(`rule "${r.id}": needs at least one valid and one invalid vector`);
    if (c.schema === undefined) continue;
    for (const x of [...c.valid, ...c.invalid]) {
      for (const [part, value] of payloadsOf(x)) {
        try {
          if (!v.valid(c.schema, value)) problems.push(`rule "${r.id}": a vector's ${part} fails the ${c.type} schema, so the rule doesn't decide it alone`);
        } catch (e) {
          problems.push(`rule "${r.id}": ${(e as Error).message}`);
        }
      }
    }
  }
  for (const id of byRule.keys()) if (!rules.rules.some((r) => r.id === id)) problems.push(`rule "${id}": the corpus has cases for no rule of the lock`);
  return problems;
}

/** One case for the oracle: an instance, the schema it is checked against, and its label. */
export interface LabelledCase {
  example: string;
  ref: string;
  value: unknown;
  valid: boolean;
  /** A trailing-newline mutant, which the stock oracle may accept (type rules § 2). */
  newline?: boolean;
}

/** Every case the oracle labels: each baseline, mutant, and newline mutant, and each payload of a rule vector against its type's schema, which accepts it. */
export function labelledCases(doc: CorpusDoc): LabelledCase[] {
  const out: LabelledCase[] = [];
  for (const c of doc.constraints) {
    out.push({ example: `${c.id} baseline`, ref: c.schema, value: c.baseline, valid: true });
    out.push({ example: `${c.id} mutant`, ref: c.schema, value: c.mutant, valid: false });
    if ("newline" in c) out.push({ example: `${c.id} newline mutant`, ref: c.schema, value: c.newline, valid: false, newline: true });
  }
  for (const r of doc.rules) {
    if (r.schema === undefined) continue;
    for (const [label, list] of [["valid", r.valid], ["invalid", r.invalid]] as const) {
      list.forEach((x, i) => {
        for (const [part, value] of payloadsOf(x)) out.push({ example: `rule "${r.rule}" ${label} vector ${i + 1} ${part}`, ref: r.schema!, value, valid: true });
      });
    }
  }
  return out;
}

/**
 * The labels: the reference oracle reaches every case's label, except that
 * the stock oracle may accept a trailing-newline mutant, the Python `$`
 * defect, which the note counts. Returns the problems and the note.
 */
export function oracleLabels(files: EmittedFile[], doc: CorpusDoc, oracle: InstanceOracle, pinned: string): { problems: string[]; note: string } {
  const cases = labelledCases(doc);
  let run;
  try {
    run = oracle(files, cases.map((c) => ({ example: c.example, ref: c.ref, value: c.value, valid: c.valid })));
  } catch (e) {
    return { problems: [(e as Error).message], note: "" };
  }
  const problems: string[] = [];
  if (run.jsonschema !== pinned) problems.push(`the oracle is jsonschema ${run.jsonschema}, but the requirements pin ${pinned}; run: npm run setup:oracle`);
  if (doc.oracle.jsonschema !== pinned) problems.push(`the corpus names jsonschema ${doc.oracle.jsonschema} as its oracle, but the requirements pin ${pinned}; regenerate with: npm run corpus`);
  if (run.verdicts.length !== cases.length) return { problems: [...problems, `the oracle gave ${run.verdicts.length} verdicts for ${cases.length} cases`], note: "" };
  let accepted = 0;
  cases.forEach((c, i) => {
    if (run.verdicts[i] === c.valid) return;
    if (c.newline && run.verdicts[i]) accepted++;
    else problems.push(`${c.example}: labelled ${c.valid ? "valid" : "invalid"}, but the oracle says ${run.verdicts[i] ? "valid" : "invalid"}`);
  });
  const newlines = cases.filter((c) => c.newline).length;
  return { problems, note: `${cases.length} cases; python-jsonschema ${run.jsonschema} and referencing ${run.referencing} reach every label; the stock oracle accepts ${accepted} of ${newlines} trailing-newline mutants (Python $ matches before a final newline)` };
}

/**
 * Gate 12, its second half: against the last frozen release, every
 * valid case of the old corpus still validates under the new schemas and
 * rules. Each old baseline is valid against its type's schema, by its
 * `$id`, which stays the same within the major; and each old valid rule
 * vector's payloads are valid against the new schema of the rule's type,
 * and the rule, kept under its ID, doesn't list the vector as invalid.
 */
export function checkOldCorpus(old: CorpusDoc, files: EmittedFile[], rules: RulesDoc): string[] {
  const problems: string[] = [];
  const v = new Validators(files);
  const check = (what: string, schema: string, value: unknown) => {
    try {
      if (!v.valid(schema, value)) problems.push(`${what} is invalid under the new schemas`);
    } catch {
      problems.push(`${what}: the new schemas have no ${schema}`);
    }
  };
  for (const c of old.constraints) check(`the old baseline of ${c.id}`, c.schema, c.baseline);
  const now = new Map(rules.rules.map((r) => [r.id, r]));
  for (const r of old.rules) {
    const kept = now.get(r.rule);
    const invalid = new Set((kept?.vectors.invalid ?? []).map((x) => canonicalJson(x)));
    r.valid.forEach((x, i) => {
      const what = `rule "${r.rule}": old valid vector ${i + 1}`;
      if (invalid.has(canonicalJson(x))) problems.push(`${what} is an invalid vector of the rule now`);
      if (r.schema !== undefined) for (const [part, value] of payloadsOf(x)) check(`${what}'s ${part}`, r.schema, value);
    });
  }
  return problems;
}

/** Reads a lock's committed corpus, or null if it has none. */
export function readCorpus(root: string, dir: string): CorpusDoc | null {
  const file = join(root, dir, CORPUS_FILE);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as CorpusDoc) : null;
}
