/**
 * Stage 5a, the JSON Schema emitter: turns one lock's model into concrete
 * (monomorphized) JSON Schema 2020-12 files. It reads nothing but the model.
 *
 * Every named type the model holds is emitted once, except the constructors,
 * which are templates that exist only in the model (type rules § 3), and a
 * vocabulary that lists a model attribute's values, such as the mutability
 * markers, which belong to the rules (§ 2). A type's file follows from its
 * layer and module:
 *
 * - `kernel/1/kernel.json`: the kernel's primitives and parts, and any
 *   vocabulary it emits, under `$defs`;
 * - `modules/<module>/1/<module>.json`: a module's vocabularies, objects,
 *   unions, and the copies it states, under `$defs`;
 * - `documents/1/<document>.json`: one document or profile (layer 5), as the
 *   file's root schema, so a payload validates against the file itself.
 *
 * The `1` is the major version, which goes in the path and the `$id`; minor
 * versions and digests live only in the release manifest. Each file's `$id`
 * is its path under the spec's base (`SchemaNames`), and every `$ref` between files is
 * relative, so the tree resolves the same at any base.
 *
 * Only standard 2020-12 keywords occur (type rules § 2). A vocabulary is an
 * `enum`, or, when open, `anyOf` its core `enum` and the kernel's
 * `NamespacedTerm` (§ 6). An object lists its properties, `required` as the
 * specification states it, and `additionalProperties: false` unless the
 * mapping marks it open (§ 4); an object that includes a profile carries the
 * profile's fields itself, with no `allOf` (§ 3). A property is a `$ref`, the
 * boolean, or an inline list or map, with its row's description beside it
 * and nothing else (§ 5). A conditional property whose condition names a
 * sibling and one of its values, such as "REQUIRED when `basis = spend`",
 * becomes `if` / `then` (§ 8); any other condition is a rule, left to the
 * rules output and listed in `conditions.left`. Mutability markers never
 * appear, neither on a property nor as a vocabulary (§ 2).
 */
import { posix } from "node:path";
import { canonicalJson } from "./canonical.ts";
import { fieldOf, Instantiator, type Constructor, type Model as Templates } from "./constructors.ts";
import { isTitledCodes, KEYWORDS, tagOf, walkSchemas } from "./conventions.ts";
import type { TypeRef } from "./mapping.ts";
import { KERNEL_MODULE } from "./mapping-rules.ts";
import type { SectionIds } from "./specs/plugin.ts";
import { Ajv2020 } from "ajv/dist/2020.js";
import { installFormats } from "./formats.ts";
import { registryFileById, withImports } from "./imports.ts";
import { extensionOf, type ModelDoc, type ModelProperty, type ModelType } from "./model.ts";

export const DIALECT = "https://json-schema.org/draft/2020-12/schema";
/** The base of every emitted `$id`: the public site, which serves each schema file at the path its `$id` names (`npm run site`). */
/**
 * What a spec's schemas are named by, from its profile's `names`
 * (src/profile.ts): the base of every `$id`, under which each file sits at
 * its path, and the specification's name, which each file's description
 * gives.
 */
export interface SchemaNames {
  base: string;
  short: string;
  /** How the spec's text identifies its sections, which its plugin states: a module's description cites numbered sections, and names an anchored text's module by what it holds. */
  sections: SectionIds;
}

/** The base of a schema tree's `$id`s, from any of its files: the file's `$id` without the tree's directory and the file's path. Null for an empty tree. */
export function baseOf(files: readonly EmittedFile[], dir: string): string | null {
  const f = files[0];
  if (!f || typeof f.schema.$id !== "string") return null;
  const tail = posix.join(dir, f.path);
  const id = f.schema.$id;
  if (!id.endsWith(tail)) throw new Error(`${f.path}: the $id ${id} doesn't end in its path ${tail}`);
  return id.slice(0, -tail.length);
}
/** The major version of every kernel, module, and document path; the release manifest moves one. */
export const MAJOR = 1;
/** The directories a lock's schema tree holds. */
export const SCHEMA_ROOTS = ["kernel", "modules", "documents"] as const;

/** One emitted file: its path under the lock's schema directory, its schema, and its bytes. */
export interface EmittedFile {
  path: string;
  schema: Record<string, unknown>;
  text: string;
}

export interface Emitted {
  files: EmittedFile[];
  /** The conditional properties, as `<type>.<property>`: those the schema expresses with `if` / `then`, and those left to the rules, with the reason. */
  conditions: { expressed: string[]; left: string[] };
  problems: string[];
}

/**
 * A lock's schema directory, from its IR directory, as the model's build
 * directory is: `ir` gives `schemas`, and `ir/with-open-prs` gives
 * `schemas/with-open-prs`.
 */
export function schemaDirOf(irDir: string): string {
  const rest = posix.relative("ir", irDir.split("\\").join("/"));
  if (rest.startsWith("..")) throw new Error(`the IR directory "${irDir}" isn't under ir/`);
  return posix.join("schemas", rest);
}

/** `LineItemSummary` is the file `line-item-summary.json`. */
export const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Where a named type is emitted: its file and the fragment that points at it in that file. */
export interface Location {
  file: string;
  fragment: string;
}

/**
 * Where a type is emitted, or null when the schema leaves it out: a
 * constructor, a template that exists only in the model (type rules § 3), and
 * a vocabulary that lists a model attribute's values, such as the mutability
 * markers, which are rules (§ 2).
 */
export function locationOf(t: ModelType): Location | null {
  if (t.kind === "constructor") return null;
  if (t.kind === "vocabulary" && t.attribute !== undefined) return null;
  if (t.layer === 5) return { file: `documents/${MAJOR}/${kebab(t.name)}.json`, fragment: "" };
  if (t.module === KERNEL_MODULE) return { file: `kernel/${MAJOR}/kernel.json`, fragment: `#/$defs/${t.name}` };
  return { file: `modules/${t.module}/${MAJOR}/${t.module}.json`, fragment: `#/$defs/${t.name}` };
}

/**
 * The `$id` of the schema a named type is emitted as, with the fragment that
 * points at it, such as `…/schemas/modules/commercial/1/commercial.json#/$defs/HoldStatus`,
 * or null when the schema leaves the type out. `dir` is the lock's schema
 * directory, as `emitSchemas` takes it, and `base` the base of its `$id`s
 * (`SchemaNames.base`, or `baseOf` the tree's files); with no base, null.
 */
export function schemaIdOf(t: ModelType, dir: string, base: string | null): string | null {
  const l = locationOf(t);
  return l && base !== null ? `${base}${posix.join(dir, l.file)}${l.fragment}` : null;
}

/** The templates the model holds, for applying them; the emitter reads nothing but the model. */
export function templatesOf(model: ModelDoc): Templates {
  const constructors = model.types.flatMap((t): Constructor[] =>
    t.kind === "constructor" ? [{ name: t.name, description: t.description, parameters: t.parameters, naming: t.naming, shell: t.shell, ...(t.fallback ? { fallback: t.fallback } : {}), vectors: [], sources: { spec: [] } }] : [],
  );
  return { kernel: { format: 1, primitives: [], file: "model.json" }, constructors: { format: 1, constructors, parts: [], file: "model.json" } };
}

/** The field a type's copies are named after: the field its one source names, if it names one. */
export function fieldOfSources(sources: string[]): string | undefined {
  if (sources.length !== 1) return undefined;
  const named = fieldOf(sources[0]!);
  return "field" in named ? named.field : undefined;
}

/** A condition the schema can state: a sibling property equal to one value. */
const CONDITION = [/^REQUIRED when `([a-z][a-z0-9_]*) = ([^`\s]+)`$/, /^REQUIRED when `([a-z][a-z0-9_]*)` is `([^`]+)`$/];

/** A presence the schema can state with `dependentRequired` and `dependentSchemas`: required with any of the members it names. */
const WITH = /^REQUIRED with (`[a-z][a-z0-9_.]*`(?: or `[a-z][a-z0-9_.]*`)*)$/;

/**
 * The members a dependency's `if` requires of the member it keys, as the
 * emitter writes a presence required with a member of a sibling's object:
 * `dependentSchemas: { m: { if: { properties: { m: { type: "object", required: [...] } } }, then: { required } } }`.
 * Null for any other dependency, such as `{ maxProperties: 1 }`.
 */
export function nestedIf(node: Record<string, unknown>, member: string): string[] | null {
  const d = isMap(node.dependentSchemas) ? node.dependentSchemas[member] : undefined;
  if (!isMap(d) || !isMap(d.if) || !isMap(d.then) || Object.keys(d).sort().join(",") !== "if,then") return null;
  const props = isMap(d.if.properties) ? d.if.properties : {};
  const m = props[member];
  if (Object.keys(d.if).join(",") !== "properties" || Object.keys(props).join(",") !== member || !isMap(m) || !Array.isArray(m.required)) return null;
  if (Object.keys(m).sort().join(",") !== "required,type" || m.type !== "object") return null;
  if (Object.keys(d.then).join(",") !== "required" || !Array.isArray(d.then.required)) return null;
  return m.required.map(String);
}

/** The schema of each named type the schema emits, with every `$ref` still local (`#/$defs/<name>`), the conditions, and the problems. */
export interface LocalSchemas {
  schemas: Map<string, Record<string, unknown>>;
  conditions: { expressed: string[]; left: string[] };
  problems: string[];
}

/**
 * The schema of each named type the schema emits, before it is placed in a
 * file: every `$ref` is local, `#/$defs/<name>`, whatever file holds the
 * type. The emitter places these; the SDK emitters read them for what a
 * type's schema states beside its properties' types, such as what an object
 * requires and the condition it holds.
 */
export function localSchemas(model: ModelDoc): LocalSchemas {
  const problems: string[] = [];
  const types = new Map(model.types.map((t) => [t.name, t]));
  const inst = new Instantiator(templatesOf(model));
  const conditions = { expressed: [] as string[], left: [] as string[] };

  /** A property: its type's schema, with its description and the default its row states beside it. */
  const propertySchema = (p: ModelProperty, key: string, where: string): Record<string, unknown> => {
    try {
      return { ...inst.schemaOf(p.type, key), ...(p.description ? { description: p.description } : {}), ...(p.default !== undefined ? { default: p.default } : {}) };
    } catch (e) {
      problems.push(`${where}: property "${key}": ${(e as Error).message}`);
      return {};
    }
  };

  /** The `const` a condition's value is for the sibling's type, or the reason it has none. */
  const conditionValue = (sibling: ModelProperty, raw: string): { value: unknown } | { left: string } | { problem: string } => {
    const t: TypeRef = sibling.type;
    if (t.kind === "boolean") return raw === "true" || raw === "false" ? { value: raw === "true" } : { problem: `"${raw}" is no boolean` };
    const v = t.kind === "named" ? types.get(t.name) : undefined;
    if (v?.kind !== "vocabulary") return { left: "the sibling isn't a vocabulary or the boolean" };
    const term = v.terms.find((x) => String(x.value) === raw);
    return term ? { value: term.value } : { problem: `"${raw}" is no term of the vocabulary "${v.name}"` };
  };

  /** An object, a document, or a profile: its properties, what it requires, whether it is closed, and the one condition it can state. */
  const objectSchema = (t: Extract<ModelType, { kind: "object" | "document" | "profile" }>, where: string): Record<string, unknown> => {
    const props: Record<string, ModelProperty> = { ...t.properties };
    if (t.kind === "object" && t.includes !== undefined) {
      const profile = types.get(t.includes);
      if (profile?.kind !== "profile") problems.push(`${where}: includes "${t.includes}", which is no profile`);
      else for (const [k, p] of Object.entries(profile.properties)) if (!(k in props)) props[k] = p;
    }
    const keys = Object.keys(props).sort();
    const schema: Record<string, unknown> = { type: "object", ...(t.kind === "object" && t.description ? { description: t.description } : {}) };
    if (keys.length > 0) schema.properties = Object.fromEntries(keys.map((k) => [k, propertySchema(props[k]!, k, where)]));
    const required = keys.filter((k) => props[k]!.presence === "required");
    if (required.length > 0) schema.required = required;
    if (!(t.kind === "object" && t.open)) schema.additionalProperties = false;
    const dependent: Record<string, string[]> = structuredClone(t.dependent_required ?? {});
    const nested: Record<string, { member: string; require: string[] }> = {};

    // The conditions: each conditional property's, and each type case. They all read one sibling, each value at most once, so
    // they chain as if / then / else, one `if` per value, which needs no `allOf` (type rules § 8).
    const stated: { sibling: string; value: unknown; require: string[]; types: Record<string, string> }[] = [];
    const at = (sibling: string, value: unknown) => {
      let s = stated.find((x) => x.sibling === sibling && canonicalJson(x.value) === canonicalJson(value));
      if (!s) stated.push((s = { sibling, value, require: [], types: {} }));
      return s;
    };
    for (const k of keys) {
      const p = props[k]!;
      const withMembers = p.presence === "conditional" ? WITH.exec(p.condition ?? "") : null;
      if (withMembers) {
        // Required with any of the members it names: a sibling's presence requires it (`dependentRequired`), and so does a
        // member of a sibling's object, while that sibling is present (`dependentSchemas`), so no `if` sits beside the object's own.
        const name = `${t.name}.${k}`;
        const left: string[] = [];
        for (const path of [...withMembers[1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)) {
          const [head, inner, ...deeper] = path.split(".");
          const sibling = props[head!];
          const target = sibling?.type.kind === "named" ? types.get(sibling.type.name) : undefined;
          if (!sibling || head === k) left.push(`"${path}" names no other property of "${t.name}"`);
          else if (inner === undefined) dependent[head!] = [...new Set([...(dependent[head!] ?? []), k])];
          else if (deeper.length > 0 || target?.kind !== "object" || !(inner in target.properties)) left.push(`"${path}" names no member of the object "${head}" holds`);
          else if (nested[head!] !== undefined && nested[head!]!.member !== inner) left.push(`"${head}" already conditions on its member "${nested[head!]!.member}"`);
          else nested[head!] = { member: inner, require: [...new Set([...(nested[head!]?.require ?? []), k])] };
        }
        if (left.length > 0) conditions.left.push(`${name}: "${p.condition}": ${left.join("; ")}`);
        else conditions.expressed.push(name);
      } else if (p.presence === "conditional") {
        const name = `${t.name}.${k}`;
        const match = CONDITION.map((re) => re.exec(p.condition ?? "")).find((m) => m !== null);
        if (!match) {
          conditions.left.push(`${name}: ${p.condition === undefined ? "the condition is unstated" : `"${p.condition}" names no sibling and value`}`);
        } else if (!props[match[1]!]) {
          conditions.left.push(`${name}: "${p.condition}" names "${match[1]}", which is no property of "${t.name}"`);
        } else {
          const v = conditionValue(props[match[1]!]!, match[2]!);
          if ("problem" in v) problems.push(`${where}: property "${k}": "${p.condition}": ${v.problem}`);
          else if ("left" in v) conditions.left.push(`${name}: "${p.condition}": ${v.left}`);
          else at(match[1]!, v.value).require.push(k);
        }
      }
      for (const c of p.cases ?? []) {
        const sibling = props[c.when.member];
        const v = sibling ? conditionValue(sibling, c.when.value) : { problem: `"${c.when.member}" is no property of "${t.name}"` };
        if ("value" in v) at(c.when.member, v.value).types[k] = c.type.name;
        else problems.push(`${where}: property "${k}": the case when "${c.when.member}" is "${c.when.value}": ${"problem" in v ? v.problem : v.left}`);
        if (!types.has(c.type.name)) problems.push(`${where}: property "${k}": the case when "${c.when.member}" is "${c.when.value}" names "${c.type.name}", which is no named type`);
      }
    }
    if (Object.keys(dependent).length > 0) {
      schema.dependentRequired = Object.fromEntries(Object.keys(dependent).sort().map((m) => [m, [...dependent[m]!].sort()]));
    }
    if (Object.keys(nested).length > 0) {
      schema.dependentSchemas = Object.fromEntries(
        Object.keys(nested)
          .sort()
          .map((m) => [m, { if: { properties: { [m]: { type: "object", required: [nested[m]!.member] } } }, then: { required: [...nested[m]!.require].sort() } }]),
      );
    }
    if (new Set(stated.map((s) => s.sibling)).size > 1) {
      problems.push(`${where}: conditions on ${[...new Set(stated.map((s) => s.sibling))].join(" and ")} need one if / then each, and holding them together needs "allOf", which type rules § 8 forbids`);
    } else {
      // The conditions follow the order of the sibling's terms, each later one in the `else` of the one before.
      const order = (x: (typeof stated)[number]) => {
        const st = props[x.sibling]!.type;
        const v = st.kind === "named" ? types.get(st.name) : undefined;
        return v?.kind === "vocabulary" ? v.terms.findIndex((term) => canonicalJson(term.value) === canonicalJson(x.value)) : x.value === true ? 0 : 1;
      };
      stated.sort((a, b) => order(a) - order(b));
      let node: Record<string, unknown> = schema;
      for (const [i, s] of stated.entries()) {
        if (i > 0) node = (node.else = {}) as Record<string, unknown>;
        const then: Record<string, unknown> = {};
        const narrowed = Object.keys(s.types).sort();
        if (narrowed.length > 0) then.properties = Object.fromEntries(narrowed.map((k) => [k, { $ref: `#/$defs/${s.types[k]}` }]));
        if (s.require.length > 0) then.required = [...s.require].sort();
        node.if = { properties: { [s.sibling]: { const: s.value } }, required: [s.sibling] };
        node.then = then;
        for (const k of s.require) conditions.expressed.push(`${t.name}.${k}`);
      }
    }
    return schema;
  };

  /** The schema of one named type, with every `$ref` still local (`#/$defs/<name>`). */
  const typeSchema = (t: ModelType): Record<string, unknown> => {
    const where = `${t.module}: ${t.kind} "${t.name}"`;
    switch (t.kind) {
      case "primitive":
      case "part":
      case "copy":
        return structuredClone(t.schema);
      case "vocabulary": {
        const values = t.terms.map((x) => x.value);
        const type = values.every((v) => typeof v === "string") ? "string" : values.every((v) => Number.isInteger(v)) ? "integer" : undefined;
        const core = { ...(type ? { type } : {}), enum: values };
        // A vocabulary that cites another standard's code list names the list, at its pinned commit.
        const notes = [
          ...(t.description ? [t.description.replace(/\.$/, "")] : []),
          ...(t.list ? [`The codes of ${t.list.standard} ${t.list.name} (${t.list.url})`] : []),
          ...t.terms.filter((x) => x.annotation !== undefined).map((x) => `\`${x.value}\`: ${x.annotation}`),
          ...((t.vendor ?? t.list?.vendor) ? [`from ${(t.vendor ?? t.list?.vendor)!.from} up: ${(t.vendor ?? t.list?.vendor)!.label}`] : []),
        ];
        // A vocabulary of a list a registry on this site keeps is that registry's vocabulary: a reference to it, which copies no code.
        if (t.list?.registry) return { description: `The codes of ${t.list.standard} ${t.list.name} (${t.list.url}), as the ${t.list.standard} registry defines them`, $ref: `${t.list.registry.schema}#/$defs/${t.list.registry.def}` };
        // An open vocabulary whose core terms the specification doesn't list accepts namespaced terms only (D-041).
        if (t.open && values.length === 0) return { description: "No core terms are listed yet, so every term is namespaced.", $ref: "#/$defs/NamespacedTerm" };
        // An integer-coded vocabulary names each code: one titled const branch per code, and its extension as a branch of its own (type rules § 6).
        if (type === "integer") return integerCoded(t, types, problems);
        return { ...(notes.length > 0 ? { description: notes.join("; ") } : {}), ...(t.open ? { anyOf: [core, { $ref: `#/$defs/${extensionOf(t)}` }] } : core) };
      }
      case "union": {
        const field = fieldOfSources(t.sources);
        return {
          anyOf: t.any_of.map((b) => {
            try {
              return inst.schemaOf(b, field);
            } catch (e) {
              problems.push(`${where}: ${(e as Error).message}`);
              return {};
            }
          }),
        };
      }
      case "object":
      case "document":
      case "profile":
        return objectSchema(t, where);
      case "constructor":
        throw new Error(`a constructor has no schema of its own`);
    }
  };

  const schemas = new Map<string, Record<string, unknown>>();
  for (const t of model.types) if (locationOf(t)) schemas.set(t.name, typeSchema(t));
  conditions.expressed.sort();
  conditions.left.sort();
  return { schemas, conditions, problems };
}

/**
 * Emits one lock's model. `dir` is the lock's schema directory relative to
 * the repository root, such as `schemas` or `schemas/with-open-prs`, which
 * each `$id` includes. Returns the files sorted by path, the conditions, and
 * the problems; a problem means the files aren't to be written.
 */
export function emitSchemas(model: ModelDoc, dir: string, names: SchemaNames): Emitted {
  const localOf = localSchemas(model);
  const problems: string[] = [...localOf.problems];
  const conditions = localOf.conditions;
  const types = new Map(model.types.map((t) => [t.name, t]));
  const locations = new Map<string, Location>();
  for (const t of model.types) {
    const l = locationOf(t);
    if (l) locations.set(t.name, l);
  }
  const documents = new Map<string, string>();
  for (const [name, l] of locations) {
    if (l.fragment !== "") continue;
    const other = documents.get(l.file);
    if (other) problems.push(`the documents "${other}" and "${name}" would both be ${l.file}`);
    documents.set(l.file, name);
  }

  /** Rewrites every local `$ref` of a schema in `file` to where its type is emitted. */
  const relocate = (schema: unknown, file: string, where: string): unknown => {
    if (Array.isArray(schema)) return schema.map((s) => relocate(s, file, where));
    if (!isMap(schema)) return schema;
    return Object.fromEntries(
      Object.entries(schema).map(([k, v]) => {
        if (k !== "$ref" || typeof v !== "string") return [k, relocate(v, file, where)];
        // A reference into a registry another spec publishes keeps its absolute `$id`.
        if (/^https:\/\//.test(v)) return [k, v];
        const name = v.replace(/^#\/\$defs\//, "");
        const l = locations.get(name);
        if (!l) {
          const t = types.get(name);
          const why = t?.kind === "vocabulary" && t.attribute !== undefined ? `, since it lists the model's \`${t.attribute}\` attribute, which is a rule (type rules § 2)` : "";
          problems.push(`${where}: references "${name}", which the model doesn't emit${why}`);
          return [k, v];
        }
        const path = l.file === file ? "" : posix.relative(posix.dirname(file), l.file);
        return [k, `${path}${l.fragment}`];
      }),
    );
  };

  const defs = new Map<string, Record<string, unknown>>();
  const roots = new Map<string, { type: ModelType; schema: Record<string, unknown> }>();
  for (const t of model.types) {
    const l = locations.get(t.name);
    if (!l) continue;
    const where = `${l.file}: ${t.kind} "${t.name}"`;
    const local = localOf.schemas.get(t.name)!;
    const refs = [...new Set(refNamesOf(local))].sort();
    // A registry's vocabulary is the registry's schema, so its extension, which the model and the SDK keep, is the registry's too.
    // An integer-coded vocabulary writes its extension as a branch of its own, so its schema references no primitive, though the model and the SDK keep it.
    const references = t.kind === "vocabulary" && (t.list?.registry || isIntegerCoded(t)) ? [] : t.references;
    if (canonicalJson(refs) !== canonicalJson(references)) {
      problems.push(`${where}: the schema references ${refs.join(", ") || "nothing"}, but the model says ${references.join(", ") || "nothing"}`);
    }
    const schema = relocate(local, l.file, where) as Record<string, unknown>;
    if (l.fragment === "") roots.set(l.file, { type: t, schema });
    else defs.set(l.file, { ...(defs.get(l.file) ?? {}), [t.name]: schema });
  }

  const modules = new Map(model.modules.map((m) => [m.name, m]));
  const files: EmittedFile[] = [];
  const add = (path: string, schema: Record<string, unknown>) => files.push({ path, schema, text: canonicalJson(schema) });
  const head = (path: string, title: string, description: string) => ({ $schema: DIALECT, $id: `${names.base}${posix.join(dir, path)}`, title, description });
  for (const [file, d] of defs) {
    const module = file.startsWith("kernel/") ? KERNEL_MODULE : file.split("/")[1]!;
    const ids = modules.get(module)?.sections ?? [];
    const kinds = new Set(Object.keys(d).map((n) => types.get(n)?.kind));
    // A text whose sections carry anchors, not numbers, as AdCOM's, names a module by what it holds.
    const anchored = names.sections === "anchored";
    const sections = anchored ? "" : sectionList(ids);
    const kernelHolds = anchored
      ? ["the primitives", ...(kinds.has("part") ? ["the parts that constructor copies share"] : []), ...(kinds.has("vocabulary") ? ["the kernel vocabularies"] : [])]
      : ["the primitives", "the value objects and the parts that constructor copies share", ...(kinds.has("vocabulary") ? ["the kernel vocabularies"] : [])];
    const count = (kind: string, one: string, many: string) => {
      const n = Object.keys(d).filter((x) => types.get(x)?.kind === kind).length;
      return n === 0 ? [] : [`${n} ${n === 1 ? one : many}`];
    };
    const holds = [...count("vocabulary", "vocabulary", "vocabularies"), ...count("object", "object", "objects"), ...count("union", "union", "unions"), ...count("copy", "constructor copy", "constructor copies")];
    const series = (xs: string[]) => (xs.length > 2 ? `${xs.slice(0, -1).join(", ")}, and ${xs.at(-1)}` : xs.join(" and "));
    const description =
      module === KERNEL_MODULE
        ? `The ${names.short} kernel: ${series(kernelHolds)}${sections ? `, from ${sections}` : ""}.`
        : anchored
          ? `The ${names.short} \`${module}\` module: its ${series(holds)}.`
          : `The ${names.short} \`${module}\` module: the vocabularies, objects, unions, and constructor copies${sections ? ` of ${sections}` : ""}.`;
    add(file, { ...head(file, module, description), $defs: d });
  }
  for (const [file, { type, schema }] of roots) {
    const description = type.kind === "profile" ? `The ${names.short} \`${type.name}\` profile: the fields of the \`${type.document}\` document that the specification lists for it.` : `The ${names.short} \`${type.name}\` document.`;
    add(file, { ...head(file, type.name, description), ...schema });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, conditions, problems };
}

/** Whether a vocabulary's codes are integers, which its schema names one by one. */
export const isIntegerCoded = (t: ModelType): boolean => t.kind === "vocabulary" && t.terms.length > 0 && t.terms.every((x) => Number.isInteger(x.value));

/**
 * A code's name, from its row's text: the name the row starts with before a
 * colon and a space, as "Instream: Pre-roll, …" names `Instream` (a URL's
 * colon is no such colon), or else the text, without a leading "- ", a URL,
 * or a final period, and cut at its first clause where it runs past 60
 * characters.
 */
export function codeTitle(text: string): string {
  const named = /^(.{1,60}?):\s/.exec(text)?.[1];
  let t = (named ?? text).replace(/^\s*-\s+/, "").replace(/\s*https?:\/\/\S+/g, "").trim().replace(/\.$/, "");
  if (t.length > 60) {
    // The first clause break outside parentheses: a sentence's end, a dash, a semicolon, a parenthesis, or a comma.
    let depth = 0;
    for (let n = 0; n < t.length; n++) {
      if (t[n] === "(") depth++;
      else if (t[n] === ")") depth = Math.max(0, depth - 1);
      if (n < 10 || (depth > 0 && t[n] !== "(")) continue;
      if ([". ", " - ", "; ", ", "].some((x) => t.startsWith(x, n)) || (t[n] === "(" && depth === 1 && t[n - 1] === " ")) {
        t = t.slice(0, t[n] === "(" ? n - 1 : n);
        break;
      }
    }
  }
  return t;
}

/**
 * The names of a list's codes. A name two codes share before their colons is
 * a class the list groups codes by, as Feed Types' `AOD`, so those codes are
 * named by the text after it; a name still shared takes its code.
 */
export function codeTitles(terms: readonly { value: unknown; annotation?: string; meanings?: string[] }[]): string[] {
  const texts = terms.map((x) => x.annotation ?? String(x.value));
  // A code the list gives twice is named by each of its meanings, as "deal is complete or deal is archived".
  const first = terms.map((x, n) => (x.meanings ? x.meanings.map(codeTitle).join(" or ") : codeTitle(texts[n]!)));
  const shared = (xs: string[]) => new Set(xs.filter((x, n) => xs.indexOf(x) !== n));
  const classes = shared(first);
  const second = texts.map((t, n) => (classes.has(first[n]!) && /^.{1,60}?:\s/.test(t) ? codeTitle(t.replace(/^.{1,60}?:\s/, "")) : first[n]!));
  const still = shared(second);
  return second.map((t, n) => (still.has(t) ? `${t} (${String(terms[n]!.value)})` : t));
}

/**
 * An integer-coded vocabulary's schema: `type: integer` and `oneOf` a branch
 * per code, `{ const, title, description }`, where the title is the code's
 * name and the description its row's text, where that says more. A vendor
 * range adds `{ type: integer, minimum, title: "Vendor-specific" }`; another
 * extension, such as Start Delay Modes' media offset, adds its primitive's
 * constraints as a branch, without the codes it would also match, so each
 * value matches one branch. The vocabulary keeps its title, the list it
 * comes from, and a short description.
 */
function integerCoded(t: Extract<ModelType, { kind: "vocabulary" }>, types: Map<string, ModelType>, problems: string[]): Record<string, unknown> {
  const vendor = t.vendor ?? t.list?.vendor;
  const codes = t.terms.map((x) => x.value as number);
  const titles = codeTitles(t.terms);
  const branches: Record<string, unknown>[] = t.terms.map((x, n) => {
    const text = x.annotation ?? String(x.value);
    const title = titles[n]!;
    return { const: x.value, title, ...(text !== title ? { description: text } : {}) };
  });
  if (vendor) branches.push({ type: "integer", minimum: vendor.from, title: "Vendor-specific", ...(vendor.label ? { description: vendor.label } : {}) });
  else if (t.open) {
    const ext = types.get(extensionOf(t));
    const schema = ext?.kind === "primitive" ? (structuredClone(ext.schema) as Record<string, unknown>) : {};
    const { description, ...constraints } = schema;
    const inRange = codes.filter((c) => (typeof constraints.minimum !== "number" || c >= constraints.minimum) && (typeof constraints.maximum !== "number" || c <= constraints.maximum));
    // No enum holds an integer (type rules § 6): the one code the extension would also match is a `not` of its const; several, which no list has, are a problem.
    if (inRange.length > 1) problems.push(`${t.module}: vocabulary "${t.name}": its extension ${extensionOf(t)} would also match the codes ${inRange.join(", ")}, and a branch leaves out one code, by a \`not\` of its const`);
    const leave = inRange.length === 1 ? { not: { const: inRange[0] } } : {};
    branches.push({ ...constraints, title: extensionOf(t).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^(.)(.*)$/, (_, a: string, b: string) => a + b.toLowerCase()), ...(typeof description === "string" ? { description } : {}), ...leave });
  }
  // A list's title, or, for the specification's own labeled list, the vocabulary's name in words, as "Seller Deal Status".
  const title = /\bList:\s[^,;]+/.exec(t.description ?? "")?.[0] ?? t.list?.name ?? (t.labeled ? t.name.replace(/([a-z])([A-Z])/g, "$1 $2") : undefined);
  const description = t.list ? `The codes of ${t.list.standard} ${t.list.name} (${t.list.url})` : (t.description ?? "").replace(/, each with its row's text/, "").replace(/\.$/, "");
  return { ...(title ? { title } : {}), ...(description ? { description } : {}), type: "integer", oneOf: branches };
}

/** Every `$ref` value in a schema. */
function refValues(schema: unknown): string[] {
  const out: string[] = [];
  walkSchemas(schema, (s) => {
    if (typeof s.$ref === "string") out.push(s.$ref);
  });
  return out;
}

const refNamesOf = (schema: unknown) => refValues(schema).filter((r) => !/^https:\/\//.test(r)).map((r) => r.replace(/^#\/\$defs\//, ""));

/** "§ 5.6, § 5.6.1, and § 5.6.2", from section IDs; a subsection without a number counts as its numbered parent. */
function sectionList(ids: string[]): string {
  const numbered = [...new Set(ids.map((s) => s.split("/")[0]!))].filter((s) => s !== "front");
  const parts = numbered.map((s) => `§ ${s}`);
  if (parts.length <= 2) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

/**
 * The gate on the emitted files (type rules § 2, § 5, § 8), independent of
 * the emitter: each file has its `$schema`, its `$id` at its path, a title,
 * and a description; every required name is a property of its object, or,
 * in an `if` or a `then`, of the object the condition sits in; every key is
 * a standard 2020-12 keyword, so no `x-`
 * key, `$dynamicRef`, `$dynamicAnchor`, `$vocabulary`, or `discriminator`; a
 * `$ref` carries a description at most and points at a type some file
 * emits; no `allOf`; `oneOf` only tagged; and `anyOf` only at the root of a
 * type whose model kind allows it: an open vocabulary, a union, or a copy
 * whose template or fallback is a union.
 */
export function checkEmitted(files: EmittedFile[], model: ModelDoc, dir: string, base: string): string[] {
  const problems: string[] = [];
  const byPath = new Map(files.map((f) => [f.path, f.schema]));
  const types = new Map(model.types.map((t) => [t.name, t]));
  const unionShells = new Set(model.types.filter((t) => t.kind === "constructor" && "anyOf" in t.shell).map((t) => t.name));
  const mayAnyOf = (t: ModelType | undefined) =>
    t !== undefined && ((t.kind === "vocabulary" && t.open) || t.kind === "union" || (t.kind === "copy" && (t.fallback || unionShells.has(t.of.constructor))));

  // Each default beside a $ref, which must be a value of the type it references.
  const defaults: { at: string; file: string; ref: string; value: unknown }[] = [];
  for (const f of files) {
    const s = f.schema;
    if (s.$schema !== DIALECT) problems.push(`${f.path}: "$schema" is ${JSON.stringify(s.$schema)}, not ${DIALECT}`);
    const id = `${base}${posix.join(dir, f.path)}`;
    if (s.$id !== id) problems.push(`${f.path}: "$id" is ${JSON.stringify(s.$id)}, not its path ${id}`);
    for (const k of ["title", "description"]) if (typeof s[k] !== "string" || s[k] === "") problems.push(`${f.path}: no "${k}"`);
    if (f.text !== canonicalJson(s)) problems.push(`${f.path}: the bytes aren't the schema's canonical JSON`);

    const isDocument = !("$defs" in s);
    const roots: [string, unknown, ModelType | undefined][] = isDocument
      ? [["", s, types.get(String(s.title))]]
      : Object.entries(isMap(s.$defs) ? s.$defs : {}).map(([name, d]) => [`/$defs/${name}`, d, types.get(name)]);
    const nodes = new Map<string, Record<string, unknown>>();
    walkSchemas(s, (node, pointer) => nodes.set(pointer, node));
    walkSchemas(s, (node, pointer) => {
      const at = `${f.path}${pointer ? ` at ${pointer}` : ""}`;
      if (Array.isArray(node.required)) {
        // A condition's `if` and `then` require properties of the object they sit in, and so does a dependency's `then`; a
        // dependency's `if` requires members of the member it keys, the object that member's `$ref` names.
        const dependency = /^(.*)\/dependentSchemas\/([^/]+)\/(?:then|if\/properties\/([^/]+))$/.exec(pointer);
        const holder = dependency ? nodes.get(dependency[1]!) : undefined;
        const keyed = dependency?.[3] !== undefined && isMap(holder?.properties) ? (holder.properties as Record<string, unknown>)[dependency[3]] : undefined;
        const scope = dependency
          ? dependency[3] === undefined
            ? [node, holder]
            : [node, isMap(keyed) && typeof keyed.$ref === "string" ? refTarget(String(keyed.$ref), f.path, byPath) : undefined]
          : /\/(if|then|else)$/.test(pointer)
            ? [node, nodes.get(pointer.replace(/\/(if|then|else)$/, ""))]
            : [node];
        for (const r of node.required) {
          if (!scope.some((x) => isMap(x?.properties) && String(r) in x.properties)) problems.push(`${at}: requires "${String(r)}", which is no property of its object`);
        }
      }
      for (const k of Object.keys(node)) {
        if (!KEYWORDS.has(k)) problems.push(`${at}: "${k}" is no standard JSON Schema 2020-12 keyword the schema may use (type rules § 2)`);
      }
      if (pointer !== "" && ("$schema" in node || "$id" in node)) problems.push(`${at}: a nested "$schema" or "$id"; every file is one resource`);
      if ("$ref" in node) {
        // Annotations may sit beside a $ref: the description, and the default a row states; a constraint may not.
        const extra = Object.keys(node).filter((k) => k !== "$ref" && k !== "description" && k !== "default");
        if (extra.length > 0) problems.push(`${at}: ${extra.map((k) => `"${k}"`).join(", ")} beside a $ref; constraints live only on named types (type rules § 5)`);
        if ("default" in node) defaults.push({ at, file: String(s.$id), ref: String(node.$ref), value: node.default });
        const problem = refProblem(String(node.$ref), f.path, byPath);
        if (problem) problems.push(`${at}: ${problem}`);
      }
      if ("allOf" in node) problems.push(`${at}: "allOf"; no schema inherits from another (type rules § 8)`);
      // A code is a titled const branch wherever it sits, so no enum holds an integer (type rules § 6).
      if (Array.isArray(node.enum) && node.enum.some((v) => Number.isInteger(v))) problems.push(`${at}: an enum holds the integer${node.enum.filter((v) => Number.isInteger(v)).length > 1 ? "s" : ""} ${node.enum.filter((v) => Number.isInteger(v)).join(", ")}; write each code as a titled const branch, or leave one out with a \`not\` of its const (type rules § 6)`);
      const root = roots.find(([p]) => p === pointer);
      // An integer-coded vocabulary names each code, so a bare enum of integers at a vocabulary's root fails (type rules § 6).
      if (root?.[2]?.kind === "vocabulary") {
        const bare = [node, ...(Array.isArray(node.anyOf) ? node.anyOf : [])].find((x) => isMap(x) && Array.isArray(x.enum) && x.enum.length > 0 && x.enum.every((v) => Number.isInteger(v)));
        if (bare) problems.push(`${at}: the integer-coded vocabulary "${root[2].name}" is a bare enum; emit each code as a titled const branch of a oneOf (type rules § 6)`);
      }
      // An integer-coded vocabulary that isn't a registry's is titled const branches, not another form such as an anyOf of consts.
      if (root?.[2] && isIntegerCoded(root[2]) && !(root[2].kind === "vocabulary" && root[2].list?.registry) && !(node.type === "integer" && Array.isArray(node.oneOf))) problems.push(`${at}: the integer-coded vocabulary "${root[2].name}" isn't type integer with titled const branches in a oneOf (type rules § 6)`);
      if ("oneOf" in node && node.type === "integer" && root?.[2]?.kind === "primitive") {
        // A primitive whose values are a few named codes, as IntegerFlag: titled integer consts, each once, and nothing else (type rules § 6).
        if (!isTitledCodes(node) || Object.keys(node).some((k) => !["type", "oneOf", "description"].includes(k))) problems.push(`${at}: the primitive "${root[2].name}" is no titled codes: type integer and a oneOf of two or more titled integer consts, each code and title once, and nothing else (type rules § 6)`);
      } else if ("oneOf" in node && node.type === "integer" && root?.[2]?.kind === "vocabulary") {
        // An integer-coded vocabulary: a titled const branch per code, and at most one titled integer branch for its extension, no branch matching another's value.
        const branches = (Array.isArray(node.oneOf) ? node.oneOf : []).filter(isMap);
        const consts = branches.filter((b) => "const" in b);
        const rest = branches.filter((b) => !("const" in b));
        if (consts.some((b) => !Number.isInteger(b.const) || typeof b.title !== "string" || b.title === "")) problems.push(`${at}: a code's branch is no integer const with a title (type rules § 6)`);
        if (new Set(consts.map((b) => b.const)).size !== consts.length) problems.push(`${at}: two branches have the same code (type rules § 6)`);
        if (rest.length > 1 || rest.some((b) => b.type !== "integer" || typeof b.title !== "string" || b.title === "")) problems.push(`${at}: a branch other than a code's is no titled integer extension, or there are several (type rules § 6)`);
        // Each value matches exactly one branch: the extension leaves every code in its range to the code's own branch.
        for (const b of rest) {
          const inRange = consts.map((c) => c.const as number).filter((c) => (typeof b.minimum !== "number" || c >= b.minimum) && (typeof b.maximum !== "number" || c <= b.maximum));
          const left = isMap(b.not) && "const" in b.not ? [b.not.const] : [];
          const both = inRange.filter((c) => !left.includes(c));
          if (both.length > 0) problems.push(`${at}: the extension branch also takes the code${both.length > 1 ? "s" : ""} ${both.join(", ")}, so ${both.length > 1 ? "they match" : "it matches"} two branches and fail${both.length > 1 ? "" : "s"} (type rules § 6)`);
        }
        const titles = consts.map((b) => b.title);
        if (new Set(titles).size !== titles.length) problems.push(`${at}: two codes have the same title, which an SDK's names would collide on (type rules § 6)`);
        if (typeof node.title !== "string" || typeof node.description !== "string") problems.push(`${at}: an integer-coded vocabulary has no title or no description naming its list (type rules § 6)`);
        const t = root[2]!;
        const want = t.kind === "vocabulary" ? t.terms.map((x) => x.value) : [];
        if (JSON.stringify([...consts.map((b) => b.const)].sort()) !== JSON.stringify([...want].sort())) problems.push(`${at}: the codes are ${consts.map((b) => b.const).join(", ")}, where the model's are ${want.join(", ")}`);
      } else if ("oneOf" in node) {
        const tags = (Array.isArray(node.oneOf) ? node.oneOf : []).map(tagOf);
        if (tags.some((x) => x === null)) problems.push(`${at}: a oneOf branch has no required "const" tag (type rules § 8)`);
        else if (new Set(tags.map((x) => JSON.stringify(x))).size !== tags.length) problems.push(`${at}: two oneOf branches have the same tag (type rules § 8)`);
      }
      if ("anyOf" in node) {
        if (!root || !mayAnyOf(root[2])) problems.push(`${at}: "anyOf" where type rules § 8 allows none: only at the root of an open vocabulary, a union, or a union copy`);
      }
    });
  }
  if (defaults.length > 0) {
    // A default is a value its type accepts, or a receiver that applies it reads a value the schema rejects.
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    installFormats(ajv);
    for (const f of withImports(files)) if (!ajv.getSchema(String(f.schema.$id))) ajv.addSchema(f.schema);
    for (const d of defaults) {
      const ref = URL.canParse(d.ref, d.file) ? new URL(d.ref, d.file).href : d.ref;
      const validate = ajv.getSchema(ref);
      if (!validate) problems.push(`${d.at}: its default can't be checked, since its $ref ${d.ref} resolves to no schema`);
      else if (!validate(d.value)) problems.push(`${d.at}: the default ${JSON.stringify(d.value)} is no value of the type its $ref names (${ajv.errorsText(validate.errors)})`);
    }
  }
  return problems;
}

/** Whether a `$ref` in `from` resolves to a schema some emitted file holds, or the problem. */
/** The `$defs` entry a `$ref` names, from the file it sits in, or undefined. */
function refTarget(ref: string, from: string, files: Map<string, Record<string, unknown>>): Record<string, unknown> | undefined {
  const [path, fragment = ""] = ref.split("#");
  const target = /^https:\/\//.test(path!) ? registryFileById(path!)?.schema : files.get(path === "" ? from : posix.normalize(posix.join(posix.dirname(from), path!)));
  const m = /^\/\$defs\/([A-Za-z0-9]+)$/.exec(fragment);
  const d = m && target && isMap(target.$defs) ? target.$defs[m[1]!] : undefined;
  return isMap(d) ? d : undefined;
}

function refProblem(ref: string, from: string, files: Map<string, Record<string, unknown>>): string | null {
  const [path, fragment = ""] = ref.split("#");
  // A reference across hosts names a registry's committed file by its `$id`.
  const external = /^https:\/\//.test(path!);
  const file = external ? path! : path === "" ? from : posix.normalize(posix.join(posix.dirname(from), path!));
  const target = external ? registryFileById(file)?.schema : files.get(file);
  if (!target) return external ? `"$ref" ${ref} names ${file}, which no registry spec on this site has committed` : `"$ref" ${ref} names the file ${file}, which isn't emitted`;
  if (fragment === "") return null;
  const m = /^\/\$defs\/([A-Za-z0-9]+)$/.exec(fragment);
  if (!m) return `"$ref" ${ref} points at something other than a "$defs" entry`;
  if (!isMap(target.$defs) || !(m[1]! in target.$defs)) return `"$ref" ${ref}: ${file} defines no "${m[1]}"`;
  return null;
}
