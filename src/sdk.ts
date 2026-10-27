/**
 * Stage 5c, the SDK types: the language-neutral form of one lock's model that
 * the TypeScript, Python, and Go emitters read (type rules § 10).
 *
 * The emitters generate classes from the model, not from the schema. Every
 * named type the schema emits becomes one declaration with the same name,
 * and every constructor that isn't filled in place becomes a generic
 * template, so a property of `Selectable<FormatId, FormatId>` is typed
 * `Selectable<FormatId, FormatId>`, and the copy the schema names after its field,
 * `FormatsSelection`, is an alias of that application. `List` and `Map` are
 * filled in place, as the schema fills them, so they become each language's
 * own list and map. A template is generated for every constructor, used or
 * not, because a constructor rule holds for the template itself (§ 9).
 *
 * What a type's schema states beside its properties' types, what an object
 * requires, whether it is closed, its member counts, and the condition it
 * holds, comes from the emitter's own local schema of the type
 * (`localSchemas`), so the classes and the schema can't state two different
 * things. Each property's type comes from the model, and the builder checks
 * that it is the type the schema references. A keyword the builder doesn't
 * know fails it, so no constraint is dropped.
 */
import { Instantiator } from "./constructors.ts";
import { canonicalJson } from "./canonical.ts";
import { fieldOfSources, localSchemas, locationOf, nestedIf, templatesOf } from "./emit.ts";
import type { TypeRef } from "./mapping.ts";
import { KERNEL_MODULE } from "./mapping-rules.ts";
import { extensionOf, VENDOR_CODE, type ModelDoc, type ModelProperty, type ModelType } from "./model.ts";
import { PROPOSED } from "./builds.ts";
import { AS_WRITTEN, variantDir } from "./variant.ts";

/** A type position: a named type, the boolean, a list or map of a type, a template applied to types, or a template's parameter. */
export type Expr =
  | { k: "ref"; name: string }
  | { k: "boolean" }
  | { k: "list"; item: Expr }
  | { k: "map"; key: Expr; value: Expr }
  /** `copy` is the named copy the schema references for this use, where the use names one. */
  | { k: "apply"; template: string; args: Expr[]; copy?: string }
  | { k: "param"; name: string };

export interface SdkProperty {
  name: string;
  expr: Expr;
  required: boolean;
  description?: string;
}

/** What an object's schema states. */
export interface Shape {
  /** Sorted by name. */
  properties: SdkProperty[];
  /** Whether the object accepts members it doesn't name. */
  open: boolean;
  minProperties?: number;
  maxProperties?: number;
  /** `dependentSchemas: { <member>: { maxProperties: n } }`: when the member is present, the object holds at most `n` members. */
  dependent: { member: string; maxProperties: number }[];
  /** `dependentRequired: { <member>: [<name>, …] }`: when the member is present, the object holds each name, as a money value holds its currency. */
  requires: { member: string; names: string[] }[];
  /**
   * `dependentSchemas: { <member>: { if: { properties: { <member>: { type: "object", required: [<inner>, …] } } }, then: { required: [<name>, …] } } }`:
   * when the member is an object that holds each inner member, the object holds each name, as a line item whose frequency cap
   * has a period holds its time zone.
   */
  within: { member: string; inner: string[]; names: string[] }[];
  /**
   * A list member's `minItems` and `uniqueItems`, beside its `items`: the list holds at least `minItems` items, each once where
   * `unique`, as a daypart window's `days`.
   */
  bounds: { member: string; minItems: number; unique: boolean }[];
  /** `if: { type: "object", properties: { <sibling>: { const } }, required: [<sibling>] }, then: false`: the object is invalid while the sibling equals the value, as a daypart window whose `start` is `24:00`. */
  rejects: { sibling: string; value: string | number | boolean }[];
  /**
   * `if` the sibling equals the value, `then` the names are required and each
   * typed member is a value of its type too, as a commitment's `amount` is a
   * `Count` while `basis` is `units`. The conditions read one sibling, each
   * value once, chained through `else`, so at most one of them holds.
   */
  conditions: { sibling: string; value: string | number | boolean; require: string[]; types: { name: string; expr: Expr }[] }[];
}

/** Every type expression a shape holds: its properties', and its conditions' typed members'. */
export const shapeExprs = (shape: Shape): Expr[] => [...shape.properties.map((p) => p.expr), ...shape.conditions.flatMap((c) => c.types.map((x) => x.expr))];

export const FORMATS = ["date", "date-time", "duration", "uri", "uuid"] as const;
export type Format = (typeof FORMATS)[number];

/** What a scalar's schema states. */
export interface Scalar {
  json: "string" | "number" | "integer" | "boolean";
  enum?: (string | number)[];
  pattern?: string;
  format?: Format;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
}

interface Common {
  name: string;
  module: string;
  /** One paragraph for the declaration's doc comment. */
  doc: string;
  /** The declarations this one references, sorted. */
  deps: string[];
}

export type SdkType = Common &
  (
    | { kind: "scalar"; scalar: Scalar }
    /** `extension` names the type an open vocabulary's other terms are: `NamespacedTerm`, or `VendorCode` for a list that reserves vendor codes. */
    | { kind: "enum"; json: "string" | "integer"; values: (string | number)[]; labels: (string | undefined)[]; open: boolean; extension: string }
    | { kind: "object"; role: "part" | "object" | "document" | "profile"; shape: Shape }
    | { kind: "union"; branches: Expr[] }
    /** A copy: an alias of a template applied to its arguments. */
    | { kind: "alias"; expr: Extract<Expr, { k: "apply" }>; application: string }
  );

/** A generic template: a constructor's shell, or its fallback, the bare value or the full form (D-008). */
export interface SdkTemplate {
  name: string;
  module: string;
  doc: string;
  deps: string[];
  /** In order. `string` is a parameter whose values are strings, such as a map key. */
  params: { name: string; accepts: string; description: string }[];
  body: { kind: "object"; shape: Shape } | { kind: "union"; branches: Expr[] };
  /** For a fallback template, the constructor whose full form it holds. */
  fallbackOf?: string;
}

/** How an SDK names the model it comes from: "the `main` lock", and for a variant "the `main` lock, as-written variant". */
export const lockPhrase = (input: SdkModel["input"]): string => `the \`${input.lock}\` lock${input.variant ? `, ${input.variant} variant` : ""}`;

/**
 * Where one build's SDK comes from, which each SDK states as constants, so
 * code can tell at run time which build it loaded: the specification's
 * commit and the blob of its file, the lock that pins them, the variant,
 * `as-written` or `proposed`, and the schema release the types match.
 */
export interface Provenance {
  commit: string;
  blob: string;
  lock: string;
  variant: string;
  /** The digest of the build's schema tree, as a release manifest's `digest` records it: the SHA-256 of the JCS bytes of `{ <path>: <schema> }` over every file. */
  schemaRelease: string;
}

/** The provenance of an SDK model whose schema tree has the digest `schemaRelease`. */
export const provenanceOf = (sdk: SdkModel, schemaRelease: string): Provenance => ({ commit: sdk.input.commit, blob: sdk.input.blob, lock: sdk.input.lock, variant: sdk.input.variant ?? PROPOSED, schemaRelease });

/** What each SDK says of each provenance constant, for its doc comment. */
export const PROVENANCE_DOCS = {
  commit: "The commit of the OpenProposal specification repository that the types are generated from.",
  blob: "The Git blob SHA of the specification file at that commit.",
  lock: "The lock that pins the commit: `main`, or `with-open-prs`, which is `main` with the pull requests that were open on the day of the lock merged in.",
  variant: "The build: `as-written`, the specification as its text and examples write it, or `proposed`, with the changes we propose.",
  schemaRelease:
    "The schema files the types match, by the digest of the whole tree: the SHA-256 of the JCS (RFC 8785) bytes of `{ <path>: <schema> }` over every file, as a release manifest's `digest` records it.",
} as const;

/**
 * A vocabulary's terms as constants, the way code built around enums reads
 * them: `Channels.DISPLAY` for the term `display` of `Channel`. The class,
 * or the TypeScript const object, is the vocabulary's name in the plural,
 * and each member the term in upper snake case, or `CODE_<n>` for an
 * integer term. An open vocabulary's constants are its core terms only: a
 * field of it still takes any namespaced term, or vendor code, as a plain
 * value. The field types stay the vocabulary itself.
 */
export interface Constants {
  name: string;
  /** The vocabulary. */
  of: string;
  members: { name: string; value: string | number; label?: string }[];
  /** The type an open vocabulary's other terms are, such as `NamespacedTerm`; undefined for a closed one. */
  extension?: string;
}

/** A vocabulary's name in the plural: `Channels`, `HoldStates`, `CommitmentBases`, `ProposalStatuses`, `Parties`. */
export function plural(name: string): string {
  if (/sis$/.test(name)) return `${name.slice(0, -2)}es`;
  if (/[^aeiou]y$/.test(name)) return `${name.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(name)) return `${name}es`;
  return `${name}s`;
}

/** A term as a constant's name: `display` gives `DISPLAY`, `PREFERRED_DEAL` stays, `oauth2_client_credentials` gives `OAUTH2_CLIENT_CREDENTIALS`, and the integer 3 gives `CODE_3`. */
export const constantName = (term: string | number): string =>
  typeof term === "number" ? `CODE_${term < 0 ? `MINUS_${-term}` : term}` : term.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();

/** A type's constants, or null for a type that isn't a vocabulary with terms. */
export function constantsOf(t: SdkType): Constants | null {
  const values = t.kind === "enum" ? t.values : t.kind === "scalar" ? (t.scalar.enum ?? []) : [];
  if (values.length === 0) return null;
  const labels = t.kind === "enum" ? t.labels : [];
  return {
    name: plural(t.name),
    of: t.name,
    members: values.map((v, i) => ({ name: constantName(v), value: v, ...(labels[i] ? { label: labels[i] } : {}) })),
    ...(t.kind === "enum" && t.open ? { extension: t.extension } : {}),
  };
}

/** Every type's constants, by the type's name, with the problems their names have: a class named like a type, a template, or another class, and a member that isn't a unique name. */
export function allConstants(sdk: SdkModel): { constants: Map<string, Constants>; problems: string[] } {
  const constants = new Map<string, Constants>();
  const problems: string[] = [];
  const taken = new Set<string>([...sdk.types.keys(), ...sdk.templates.keys()]);
  for (const t of sdk.types.values()) {
    const c = constantsOf(t);
    if (!c) continue;
    if (taken.has(c.name)) problems.push(`${t.name}: its constants' name, ${c.name}, is taken`);
    taken.add(c.name);
    const seen = new Set<string>();
    for (const m of c.members) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(m.name) || seen.has(m.name)) problems.push(`${t.name}: the term ${JSON.stringify(m.value)} gives the constant ${c.name}.${m.name}, which isn't a unique name`);
      seen.add(m.name);
    }
    constants.set(t.name, c);
  }
  return { constants, problems };
}

/** What a constants class says of itself. */
export const constantsDoc = (c: Constants): string =>
  c.extension === undefined
    ? `The terms of \`${c.of}\`, as constants.`
    : `The core terms of \`${c.of}\`, as constants. The vocabulary is open, so a field of it also takes ${c.extension === "NamespacedTerm" ? "a namespaced term" : "a vendor's code"} (\`${c.extension}\`) as a plain value.`;

export interface SdkModel {
  input: { lock: string; commit: string; blob: string; variant?: string };
  /** Every declaration, in an order where each comes after the declarations it references, ties broken by name. */
  order: string[];
  types: Map<string, SdkType>;
  templates: Map<string, SdkTemplate>;
  /** The modules that hold a declaration, sorted, the kernel first. */
  modules: string[];
  /** The names the gate sends a value of a type under: every named type the schema emits. */
  emitted: string[];
}

type Schema = Record<string, unknown>;
const isMap = (v: unknown): v is Schema => v !== null && typeof v === "object" && !Array.isArray(v);
const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type ConstructorType = Extract<ModelType, { kind: "constructor" }>;

/** Whether a constructor filled in place is a list or a map, from its shell, or null. */
function inlineForm(c: ConstructorType): { list: string } | { key: string; value: string } | null {
  const s = c.shell;
  const slot = (v: unknown) => (isMap(v) && isMap(v.$model) && v.$model.kind === "parameter" && Object.keys(v).length === 1 ? String(v.$model.name) : null);
  const keys = Object.keys(s).sort().join(",");
  if (keys === "items,type" && s.type === "array" && slot(s.items)) return { list: slot(s.items)! };
  if (keys === "additionalProperties,propertyNames,type" && s.type === "object" && slot(s.propertyNames) && slot(s.additionalProperties)) {
    return { key: slot(s.propertyNames)!, value: slot(s.additionalProperties)! };
  }
  return null;
}

/** The names an expression references: named types, templates, and copies. */
export function exprNames(e: Expr): string[] {
  switch (e.k) {
    case "ref":
      return [e.name];
    case "boolean":
    case "param":
      return [];
    case "list":
      return exprNames(e.item);
    case "map":
      return [...exprNames(e.key), ...exprNames(e.value)];
    case "apply":
      return [e.template, ...(e.copy ? [e.copy] : []), ...e.args.flatMap(exprNames)];
  }
}

/** Renders an expression for messages and doc comments, as in `Selectable<CatalogRefOr<AudiencesOption>>`. */
export function renderExpr(e: Expr): string {
  switch (e.k) {
    case "ref":
    case "param":
      return e.name;
    case "boolean":
      return "boolean";
    case "list":
      return `List<${renderExpr(e.item)}>`;
    case "map":
      return `Map<${renderExpr(e.key)}, ${renderExpr(e.value)}>`;
    case "apply":
      return `${e.template}<${e.args.map(renderExpr).join(", ")}>`;
  }
}

/**
 * Builds the SDK form of one lock's model. Returns the problems; a problem
 * means no SDK is to be written.
 */
export function buildSdkModel(model: ModelDoc): { sdk: SdkModel; problems: string[] } {
  const problems: string[] = [];
  const local = localSchemas(model);
  problems.push(...local.problems);
  const byName = new Map(model.types.map((t) => [t.name, t]));
  const constructors = new Map(model.types.flatMap((t): [string, ConstructorType][] => (t.kind === "constructor" ? [[t.name, t]] : [])));
  const inst = new Instantiator(templatesOf(model));

  /** A type position from the model. `field` names the copies a use makes; without it, applications name no copy, as in a template. */
  const exprOf = (t: TypeRef, where: string, field?: string, named = true, full = false): Expr => {
    switch (t.kind) {
      case "named":
        return { k: "ref", name: t.name };
      case "boolean":
        return { k: "boolean" };
      case "parameter":
        return { k: "param", name: t.name };
      case "apply": {
        const c = constructors.get(t.constructor);
        if (!c) throw new Error(`${where}: no constructor "${t.constructor}"`);
        const arg = (p: string) => {
          const a = t.arguments[p];
          if (!a) throw new Error(`${where}: ${c.name} needs the argument ${p}`);
          return exprOf(a, where, field, named);
        };
        if (c.naming.from === "inline") {
          const form = inlineForm(c);
          if (!form) throw new Error(`${where}: ${c.name} is filled in place, but its shell is neither a list nor a map`);
          return "list" in form ? { k: "list", item: arg(form.list) } : { k: "map", key: arg(form.key), value: arg(form.value) };
        }
        const params = c.parameters.filter((p) => !p.optional).map((p) => p.name);
        const args = params.map(arg);
        const bare = c.fallback && !full ? t.arguments[c.fallback.parameter] : undefined;
        const template = bare ? c.name + c.fallback!.suffix : c.name;
        if (bare) args.push(exprOf(bare, where, field, named));
        if (!named) return { k: "apply", template, args };
        return { k: "apply", template, args, copy: inst.copy(t, field) };
      }
    }
  };

  /** The schema an expression stands for in an emitted type's local schema, to check the two agree. */
  const schemaOfExpr = (e: Expr): Schema => {
    switch (e.k) {
      case "ref":
        return { $ref: `#/$defs/${e.name}` };
      case "boolean":
        return { type: "boolean" };
      case "list":
        return { type: "array", items: schemaOfExpr(e.item) };
      case "map":
        return { type: "object", propertyNames: schemaOfExpr(e.key), additionalProperties: schemaOfExpr(e.value) };
      case "apply":
        if (!e.copy) throw new Error(`${renderExpr(e)} names no copy`);
        return { $ref: `#/$defs/${e.copy}` };
      case "param":
        throw new Error(`parameter "${e.name}" is unbound`);
    }
  };

  /** A type position from a local schema whose references are all named: a part's member. */
  const exprOfSchema = (s: unknown, where: string): Expr => {
    if (!isMap(s)) throw new Error(`${where}: not a schema`);
    const { description: _d, ...rest } = s;
    const keys = Object.keys(rest).sort().join(",");
    if (keys === "$ref" && typeof rest.$ref === "string" && rest.$ref.startsWith("#/$defs/")) return { k: "ref", name: rest.$ref.slice("#/$defs/".length) };
    if (keys === "type" && rest.type === "boolean") return { k: "boolean" };
    if (keys === "items,type" && rest.type === "array") return { k: "list", item: exprOfSchema(rest.items, `${where}/items`) };
    if (keys === "additionalProperties,propertyNames,type" && rest.type === "object") {
      return { k: "map", key: exprOfSchema(rest.propertyNames, `${where}/propertyNames`), value: exprOfSchema(rest.additionalProperties, `${where}/additionalProperties`) };
    }
    throw new Error(`${where}: ${JSON.stringify(s)} is no named type, boolean, list, or map`);
  };

  const OBJECT_KEYS = new Set(["type", "properties", "required", "additionalProperties", "minProperties", "maxProperties", "dependentSchemas", "dependentRequired", "if", "then", "else", "description"]);

  /** What an object's schema states. `exprs` gives each property's type; `description` its description. */
  const shapeOf = (s: Schema, exprs: (key: string, node: unknown) => Expr, where: string): Shape => {
    for (const k of Object.keys(s)) if (!OBJECT_KEYS.has(k)) throw new Error(`${where}: the SDK emitters don't know the keyword "${k}" on an object`);
    if (s.type !== "object") throw new Error(`${where}: an object's schema has "type" ${JSON.stringify(s.type)}`);
    if (s.additionalProperties !== undefined && s.additionalProperties !== false) throw new Error(`${where}: "additionalProperties" is ${JSON.stringify(s.additionalProperties)}; an object is closed or open (type rules § 4)`);
    const props = isMap(s.properties) ? s.properties : {};
    const required = new Set(Array.isArray(s.required) ? s.required.map(String) : []);
    for (const r of required) if (!(r in props)) throw new Error(`${where}: requires "${r}", which is no property`);
    /** A list member's bounds, `minItems` and `uniqueItems` beside its `items`, which the shape checks; the rest is the member's type. */
    const bounds: Shape["bounds"] = [];
    const unbounded = (key: string, node: unknown): unknown => {
      if (!isMap(node) || node.type !== "array" || (node.minItems === undefined && node.uniqueItems === undefined)) return node;
      const { minItems, uniqueItems, ...rest } = node;
      if ((minItems !== undefined && !Number.isInteger(minItems)) || (uniqueItems !== undefined && uniqueItems !== true)) throw new Error(`${where}: "${key}" has bounds the SDK emitters don't know: minItems ${JSON.stringify(minItems)}, uniqueItems ${JSON.stringify(uniqueItems)}`);
      bounds.push({ member: key, minItems: minItems === undefined ? 0 : Number(minItems), unique: uniqueItems === true });
      return rest;
    };
    const shape: Shape = {
      properties: Object.keys(props)
        .sort(byString)
        .map((key) => {
          const node = props[key];
          const description = isMap(node) && typeof node.description === "string" && node.description !== "" ? node.description : undefined;
          return { name: key, expr: exprs(key, unbounded(key, node)), required: required.has(key), ...(description ? { description } : {}) };
        }),
      open: s.additionalProperties === undefined,
      dependent: [],
      requires: [],
      within: [],
      bounds,
      rejects: [],
      conditions: [],
    };
    if (s.minProperties !== undefined) shape.minProperties = Number(s.minProperties);
    if (s.maxProperties !== undefined) shape.maxProperties = Number(s.maxProperties);
    if (s.dependentSchemas !== undefined) {
      if (!isMap(s.dependentSchemas)) throw new Error(`${where}: "dependentSchemas" isn't an object`);
      for (const [member, d] of Object.entries(s.dependentSchemas).sort(([a], [b]) => byString(a, b))) {
        if (!(member in props)) throw new Error(`${where}: "dependentSchemas" names "${member}", which is no property`);
        const inner = nestedIf(s, member);
        if (inner !== null) {
          const names = ((d as { then: { required: unknown[] } }).then.required).map(String);
          for (const n of names) if (!(n in props)) throw new Error(`${where}: "dependentSchemas/${member}" requires "${n}", which is no property`);
          shape.within.push({ member, inner, names });
          continue;
        }
        if (!isMap(d) || Object.keys(d).join(",") !== "maxProperties" || !Number.isInteger(d.maxProperties)) {
          throw new Error(`${where}: "dependentSchemas/${member}" is ${JSON.stringify(d)}; the SDK emitters know only { maxProperties: n } and an if on the member's own members with a then that requires names`);
        }
        shape.dependent.push({ member, maxProperties: Number(d.maxProperties) });
      }
    }
    if (s.dependentRequired !== undefined) {
      if (!isMap(s.dependentRequired)) throw new Error(`${where}: "dependentRequired" isn't an object`);
      for (const [member, names] of Object.entries(s.dependentRequired).sort(([a], [b]) => byString(a, b))) {
        if (!Array.isArray(names) || names.length === 0) throw new Error(`${where}: "dependentRequired/${member}" isn't a list of names`);
        for (const n of [member, ...names.map(String)]) if (!(n in props)) throw new Error(`${where}: "dependentRequired" names "${n}", which is no property`);
        shape.requires.push({ member, names: names.map(String) });
      }
    }
    // A value one member can't take: `if` its `const`, `then: false`, with no `else`.
    if (s.then === false) {
      const i = s.if;
      const sib = isMap(i) && isMap(i.properties) ? Object.keys(i.properties) : [];
      const c = sib.length === 1 && isMap(i) && isMap(i.properties) ? i.properties[sib[0]!] : undefined;
      const ok =
        isMap(i) &&
        Object.keys(i).sort().join(",") === "properties,required,type" &&
        i.type === "object" &&
        isMap(c) &&
        Object.keys(c).join(",") === "const" &&
        ["string", "number", "boolean"].includes(typeof c.const) &&
        Array.isArray(i.required) &&
        i.required.length === 1 &&
        i.required[0] === sib[0] &&
        s.else === undefined;
      if (!ok) throw new Error(`${where}: the SDK emitters know "then": false only as if { type: "object", properties: { <member>: { const } }, required: [<member>] }, with no else`);
      if (!(sib[0]! in props)) throw new Error(`${where}: the condition names "${sib[0]}", which is no property`);
      shape.rejects.push({ sibling: sib[0]!, value: (c as { const: string | number | boolean }).const });
      return shape;
    }
    // A condition chain: `if` / `then`, and the next condition in `else`, each `then` requiring members or typing them.
    let node: Schema | undefined = s.if !== undefined || s.then !== undefined || s.else !== undefined ? s : undefined;
    while (node !== undefined) {
      const i = node.if;
      const t = node.then;
      const sib = isMap(i) && isMap(i.properties) ? Object.keys(i.properties) : [];
      const constNode = sib.length === 1 && isMap(i) && isMap(i.properties) ? i.properties[sib[0]!] : undefined;
      const thenKeys = isMap(t) ? Object.keys(t).sort() : [];
      const ok =
        isMap(i) &&
        Object.keys(i).sort().join(",") === "properties,required" &&
        sib.length === 1 &&
        isMap(constNode) &&
        Object.keys(constNode).join(",") === "const" &&
        ["string", "number", "boolean"].includes(typeof constNode.const) &&
        Array.isArray(i.required) &&
        i.required.length === 1 &&
        i.required[0] === sib[0] &&
        isMap(t) &&
        thenKeys.length > 0 &&
        thenKeys.every((k) => k === "required" || k === "properties") &&
        (t.required === undefined || Array.isArray(t.required)) &&
        (t.properties === undefined || isMap(t.properties)) &&
        (node === s || Object.keys(node).every((k) => k === "if" || k === "then" || k === "else"));
      if (!ok) throw new Error(`${where}: the SDK emitters know a condition only as if { properties: { <sibling>: { const } }, required: [<sibling>] } then { required, properties }, chained through else`);
      const then = t as { required?: unknown[]; properties?: Record<string, unknown> };
      const require = (then.required ?? []).map(String);
      const types = Object.entries(then.properties ?? {})
        .sort(([a], [b]) => byString(a, b))
        .map(([name, x]) => ({ name, expr: exprOfSchema(x, `${where}: then/properties/${name}`) }));
      for (const r of [sib[0]!, ...require, ...types.map((x) => x.name)]) if (!(r in props)) throw new Error(`${where}: the condition names "${r}", which is no property`);
      const value = (constNode as { const: string | number | boolean }).const;
      if (shape.conditions.some((c) => c.sibling !== sib[0] || c.value === value)) throw new Error(`${where}: the conditions read more than one sibling, or one value twice`);
      shape.conditions.push({ sibling: sib[0]!, value, require, types });
      node = node.else === undefined ? undefined : isMap(node.else) ? (node.else as Schema) : (() => { throw new Error(`${where}: "else" isn't a schema`); })();
    }
    return shape;
  };

  const SCALAR_KEYS = new Set(["type", "enum", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "description"]);
  const scalarOf = (s: Schema, where: string): Scalar => {
    for (const k of Object.keys(s)) if (!SCALAR_KEYS.has(k)) throw new Error(`${where}: the SDK emitters don't know the keyword "${k}" on a scalar`);
    if (!["string", "number", "integer", "boolean"].includes(String(s.type))) throw new Error(`${where}: a scalar has "type" ${JSON.stringify(s.type)}`);
    const scalar: Scalar = { json: s.type as Scalar["json"] };
    if (s.enum !== undefined) {
      if (!Array.isArray(s.enum) || !s.enum.every((v) => typeof v === "string" || Number.isInteger(v))) throw new Error(`${where}: "enum" holds a value that is neither a string nor an integer`);
      scalar.enum = s.enum as (string | number)[];
    }
    if (s.format !== undefined) {
      if (!(FORMATS as readonly unknown[]).includes(s.format)) throw new Error(`${where}: the SDK emitters don't know the format ${JSON.stringify(s.format)}`);
      scalar.format = s.format as Format;
    }
    if (s.pattern !== undefined) scalar.pattern = String(s.pattern);
    for (const k of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength"] as const) {
      if (s[k] === undefined) continue;
      if (typeof s[k] !== "number") throw new Error(`${where}: "${k}" isn't a number`);
      scalar[k] = s[k] as number;
    }
    const strings = ["pattern", "format", "minLength", "maxLength"].filter((k) => s[k] !== undefined);
    const numbers = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"].filter((k) => s[k] !== undefined);
    if (strings.length > 0 && scalar.json !== "string") throw new Error(`${where}: ${strings.join(", ")} on a ${scalar.json}`);
    if (numbers.length > 0 && scalar.json !== "number" && scalar.json !== "integer") throw new Error(`${where}: ${numbers.join(", ")} on a ${scalar.json}`);
    return scalar;
  };

  const docOf = (t: ModelType): string => {
    switch (t.kind) {
      case "primitive":
      case "part":
      case "constructor":
        return t.description;
      case "vocabulary":
        if (t.terms.length === 0) return `The \`${t.name}\` vocabulary: no core terms are listed yet, so every term is namespaced (\`NamespacedTerm\`).`;
        return `The \`${t.name}\` vocabulary: ${t.terms.map((x) => `\`${x.value}\``).join(", ")}${t.open ? (t.list?.vendor ? `, or a vendor's code from ${t.list.vendor.from} up (\`${VENDOR_CODE}\`), which ${t.list.standard} ${t.list.name} reserves` : ", or a namespaced term (`NamespacedTerm`), since the vocabulary is open") : ""}.${t.description ? ` ${t.description}` : ""}`;
      case "object":
        return `The \`${t.name}\` object of the \`${t.module}\` module${t.open ? ". It is open, so it keeps the members it doesn't name" : ""}.${t.description ? ` ${t.description}` : ""}`;
      case "document":
        return `The OpenProposal \`${t.name}\` document.`;
      case "profile":
        return `The OpenProposal \`${t.name}\` profile: the fields of the \`${t.document}\` document that the specification lists for it.`;
      case "union":
        return `The \`${t.name}\` union: a value of any one of its branches.`;
      case "copy":
        return `The copy \`${t.application}\`${t.fallback ? ", or its bare value" : ""}.`;
    }
  };

  const types = new Map<string, SdkType>();
  const templates = new Map<string, SdkTemplate>();
  const emitted: string[] = [];
  const add = (t: SdkType) => {
    if (types.has(t.name) || templates.has(t.name)) problems.push(`the name "${t.name}" is declared twice`);
    types.set(t.name, t);
  };
  const depsOf = (name: string, exprs: Expr[], extra: string[] = []) => [...new Set([...exprs.flatMap(exprNames), ...extra])].filter((n) => n !== name).sort(byString);

  for (const t of model.types) {
    const where = `${t.module}: ${t.kind} "${t.name}"`;
    try {
      if (t.kind === "constructor") {
        const params = t.parameters.filter((p) => !p.optional).map((p) => ({ name: p.name, accepts: p.accepts, description: p.description }));
        if (t.naming.from === "inline") {
          if (!inlineForm(t)) problems.push(`${where}: filled in place, but its shell is neither a list nor a map`);
          continue;
        }
        const slotExpr = (node: unknown, w: string): Expr => {
          if (!isMap(node) || !isMap(node.$model)) throw new Error(`${w}: no slot`);
          const extra = Object.keys(node).filter((k) => k !== "$model" && k !== "description");
          if (extra.length > 0) throw new Error(`${w}: ${extra.join(", ")} beside a slot`);
          return exprOf(node.$model as TypeRef, w, undefined, false);
        };
        const shell = t.shell;
        let body: SdkTemplate["body"];
        if ("anyOf" in shell) {
          const extra = Object.keys(shell).filter((k) => k !== "anyOf" && k !== "description");
          if (extra.length > 0 || !Array.isArray(shell.anyOf)) throw new Error(`${where}: a union shell holds ${extra.join(", ")}`);
          body = { kind: "union", branches: shell.anyOf.map((b, i) => slotExpr(b, `${where}: anyOf/${i}`)) };
        } else {
          body = { kind: "object", shape: shapeOf(shell, (key, node) => slotExpr(node, `${where}: property "${key}"`), where) };
        }
        const exprs = body.kind === "union" ? body.branches : body.shape.properties.map((p) => p.expr);
        templates.set(t.name, { name: t.name, module: t.module, doc: t.description, deps: depsOf(t.name, exprs), params, body });
        if (t.fallback) {
          const optional = t.parameters.find((p) => p.name === t.fallback!.parameter);
          if (!optional) throw new Error(`${where}: the fallback names the parameter "${t.fallback.parameter}", which it lacks`);
          const name = t.name + t.fallback.suffix;
          const base: Expr = { k: "apply", template: t.name, args: params.map((p) => ({ k: "param", name: p.name })) };
          const bare: Expr = { k: "param", name: optional.name };
          templates.set(name, {
            name,
            module: t.module,
            doc: `A \`${t.name}\` field's bare value, or its full form (${t.fallback.decision}).`,
            deps: [t.name],
            params: [...params, { name: optional.name, accepts: optional.accepts, description: optional.description }],
            body: { kind: "union", branches: [bare, base] },
            fallbackOf: t.name,
          });
        }
        continue;
      }
      if (!locationOf(t)) continue;
      const schema = local.schemas.get(t.name);
      if (!schema) throw new Error(`${where}: the emitter gives no schema`);
      emitted.push(t.name);
      const common = { name: t.name, module: t.module, doc: docOf(t) };
      switch (t.kind) {
        case "primitive":
          if (schema.type === "object") throw new Error(`${where}: a primitive object`);
          add({ ...common, deps: [], kind: "scalar", scalar: scalarOf(schema, where) });
          break;
        case "part": {
          const shape = shapeOf(schema, (key, node) => exprOfSchema(node, `${where}: property "${key}"`), where);
          add({ ...common, deps: depsOf(t.name, shapeExprs(shape)), kind: "object", role: "part", shape });
          break;
        }
        case "vocabulary": {
          const values = t.terms.map((x) => x.value);
          const json = values.every((v) => typeof v === "string") ? "string" : values.every((v) => Number.isInteger(v)) ? "integer" : null;
          if (json === null) throw new Error(`${where}: its terms are neither all strings nor all integers`);
          add({ ...common, deps: t.open ? [extensionOf(t)] : [], kind: "enum", json, values, labels: t.terms.map((x) => x.annotation), open: t.open, extension: extensionOf(t) });
          break;
        }
        case "object":
        case "document":
        case "profile": {
          const props: Record<string, ModelProperty> = { ...t.properties };
          if (t.kind === "object" && t.includes !== undefined) {
            const profile = byName.get(t.includes);
            if (profile?.kind !== "profile") throw new Error(`${where}: includes "${t.includes}", which is no profile`);
            for (const [k, p] of Object.entries(profile.properties)) if (!(k in props)) props[k] = p;
          }
          const shape = shapeOf(
            schema,
            (key, node) => {
              const p = props[key];
              if (!p) throw new Error(`${where}: the schema has the property "${key}", which the model lacks`);
              const e = exprOf(p.type, `${where}: property "${key}"`, key);
              const { description: _d, ...want } = isMap(node) ? node : {};
              if (canonicalJson(schemaOfExpr(e)) !== canonicalJson(want)) {
                throw new Error(`${where}: property "${key}" is ${renderExpr(e)}, but the schema states ${JSON.stringify(want)}`);
              }
              return e;
            },
            where,
          );
          const missing = Object.keys(props).filter((k) => !shape.properties.some((p) => p.name === k));
          if (missing.length > 0) throw new Error(`${where}: the model has the properties ${missing.join(", ")}, which the schema lacks`);
          add({ ...common, deps: depsOf(t.name, shapeExprs(shape)), kind: "object", role: t.kind, shape });
          break;
        }
        case "union": {
          const field = fieldOfSources(t.sources);
          const branches = t.any_of.map((b, i) => exprOf(b, `${where}: branch ${i + 1}`, field));
          const want = (Array.isArray(schema.anyOf) ? schema.anyOf : []).map((b) => canonicalJson(b));
          if (canonicalJson(branches.map((b) => canonicalJson(schemaOfExpr(b)))) !== canonicalJson(want)) throw new Error(`${where}: its branches aren't the ones the schema states`);
          add({ ...common, deps: depsOf(t.name, branches), kind: "union", branches });
          break;
        }
        case "copy": {
          const e = exprOf(t.of, where, undefined, false, !t.fallback);
          if (e.k !== "apply") throw new Error(`${where}: a copy of a constructor filled in place`);
          add({ ...common, deps: depsOf(t.name, [e]), kind: "alias", expr: e, application: t.application });
          break;
        }
      }
    } catch (e) {
      problems.push((e as Error).message);
    }
  }

  // Every name a declaration references is declared, and the references form no cycle.
  const declared = new Set([...types.keys(), ...templates.keys()]);
  const deps = new Map<string, string[]>([...[...types.values()].map((t): [string, string[]] => [t.name, t.deps]), ...[...templates.values()].map((t): [string, string[]] => [t.name, t.deps])]);
  for (const [name, ds] of deps) for (const d of ds) if (!declared.has(d)) problems.push(`"${name}" references "${d}", which no declaration defines`);
  const order: string[] = [];
  const placed = new Set<string>();
  const pending = [...declared].sort(byString);
  while (pending.length > 0) {
    const i = pending.findIndex((n) => deps.get(n)!.every((d) => placed.has(d) || !declared.has(d)));
    if (i < 0) {
      problems.push(`the references among ${pending.join(", ")} form a cycle`);
      break;
    }
    const [n] = pending.splice(i, 1);
    order.push(n!);
    placed.add(n!);
  }
  const modules = [...new Set([...[...types.values()].map((t) => t.module), ...[...templates.values()].map((t) => t.module)])].sort((a, b) =>
    a === KERNEL_MODULE ? -1 : b === KERNEL_MODULE ? 1 : byString(a, b),
  );
  return { sdk: { input: { lock: model.input.lock, commit: model.input.commit, blob: model.input.blob, ...(model.input.variant ? { variant: model.input.variant } : {}) }, order, types, templates, modules, emitted: emitted.sort(byString) }, problems };
}

/** The expression of a template applied to a model type, for a case that names an application rather than a named type, such as a constructor vector. */
export function applicationExpr(model: ModelDoc, constructor: string, args: Record<string, TypeRef>): Expr {
  const c = model.types.find((t): t is ConstructorType => t.kind === "constructor" && t.name === constructor);
  if (!c) throw new Error(`no constructor "${constructor}"`);
  const of = (t: TypeRef): Expr => {
    switch (t.kind) {
      case "named":
        return { k: "ref", name: t.name };
      case "boolean":
        return { k: "boolean" };
      case "parameter":
        throw new Error(`parameter "${t.name}" is unbound`);
      case "apply":
        return applicationExpr(model, t.constructor, t.arguments);
    }
  };
  if (c.naming.from === "inline") {
    const form = inlineForm(c);
    if (!form) throw new Error(`${c.name} is neither a list nor a map`);
    return "list" in form ? { k: "list", item: of(args[form.list]!) } : { k: "map", key: of(args[form.key]!), value: of(args[form.value]!) };
  }
  const params = c.parameters.filter((p) => !p.optional).map((p) => p.name);
  const out = params.map((p) => {
    const a = args[p];
    if (!a) throw new Error(`${c.name} needs the argument ${p}`);
    return of(a);
  });
  const bare = c.fallback ? args[c.fallback.parameter] : undefined;
  if (bare) return { k: "apply", template: c.name + c.fallback!.suffix, args: [...out, of(bare)] };
  return { k: "apply", template: c.name, args: out };
}

/** The variant whose SDK is the default tree, `sdk/`: the types as the specification writes them, which is closest to what a consumer writes. */
export const DEFAULT_SDK_VARIANT = AS_WRITTEN;

/**
 * A build's SDK directory, from its lock's IR directory and its variant, which
 * is undefined for the schemas we propose. The default variant's SDK is the
 * default tree: `ir` gives `sdk`, and `ir/with-open-prs` gives
 * `sdk/with-open-prs`. Every other build's is an opt-in tree under
 * `sdk/<variant>/`, and the schemas we propose are `proposed`: `sdk/proposed`
 * and `sdk/proposed/with-open-prs`.
 */
export function sdkDirOf(irDir: string, variant: string | undefined): string {
  const rest = irDir.split("\\").join("/").replace(/^ir\/?/, "");
  if (irDir !== "ir" && !irDir.split("\\").join("/").startsWith("ir/")) throw new Error(`the IR directory "${irDir}" isn't under ir/`);
  const base = rest === "" ? "sdk" : `sdk/${rest}`;
  return variant === DEFAULT_SDK_VARIANT ? base : variantDir(base, variant ?? PROPOSED);
}

/** One generated file: its path under the lock's SDK directory, and its text. */
export interface SdkFile {
  path: string;
  text: string;
}
