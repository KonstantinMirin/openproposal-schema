/**
 * Stage 7, release: the manifest of one lock's schema tree, and the differ
 * that compares it with the last frozen release.
 *
 * `release.json` sits at the root of the lock's schema tree, beside
 * `kernel/`, `modules/`, and `documents/`. It maps each file's path to its
 * version and its digest, and carries the digest of the whole tree, of the
 * model, and of the rules. A digest is the SHA-256 of the value's RFC 8785
 * (JCS) bytes, written as the kernel's `Digest` primitive writes one: 64
 * lowercase hex characters. Hashing the JCS bytes, not the file's, makes a
 * digest a function of the value alone, so any implementation recomputes it.
 *
 * Versions are Semantic Versioning 2.0.0 cores, `MAJOR.MINOR.PATCH`. The major is the one in
 * every path and `$id` (`MAJOR`). The first release is `<MAJOR>.0.0`. After
 * that, the differ decides the next version from the last frozen release:
 * a breaking change fails within the major; any other change to what a
 * payload must satisfy bumps the minor; a change that alters no validation,
 * such as a description or the spec pin, bumps the patch; no change keeps
 * the version. A file keeps its version while its digest is unchanged, and
 * takes the new release's version when it changes.
 *
 * Breaking means that a payload valid under the last release may be invalid
 * under this one: a removed type, property, term, or union branch; a type
 * that moves to another file or changes its kind; a narrowed type; a new
 * required or conditional member; a closed vocabulary or object that was
 * open; a changed condition; a changed mutability marker, which narrows the
 * changes a party may make between two versions; a new error-level rule on
 * a type the last release had; and a rule that now rejects a vector it
 * accepted.
 *
 * The differ reads three things of each release: the model, type by type;
 * the rules, by ID and content; and the emitted schema files, entry by
 * entry, so a change the model doesn't show, such as one in the emitter,
 * is classed too. A frozen release keeps all three, and its conformance
 * corpus, whose valid cases every later release within the major must
 * still accept (src/corpus.ts, `checkOldCorpus`).
 */
import { withImports } from "./imports.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { canonicalJson, sha256 } from "./canonical.ts";
import type { CorpusDoc } from "./corpus.ts";
import { MAJOR, SCHEMA_ROOTS, schemaIdOf, type EmittedFile } from "./emit.ts";
import { ORACLE_REQUIREMENTS } from "./engines.ts";
import type { TypeRef } from "./mapping.ts";
import type { ModelDoc, ModelProperty, ModelType } from "./model.ts";
import { compileSchema } from "./pipeline.ts";
import { RULES_FILE, type Rule, type RulesDoc } from "./rules.ts";
import { spawnWithInput } from "./spawn.ts";
import { REPO_ROOT } from "./repo.ts";

/** The manifest's name at the root of a lock's schema tree. */
export const RELEASE_FILE = "release.json";
/** Where the frozen releases live: `releases/<lock>/<version>/`. */
export const RELEASES_DIR = "releases";
export const RELEASE_SCHEMA = join(RELEASES_DIR, "release.schema.json");
/** The model a frozen release keeps beside its manifest, for the differ. */
export const FROZEN_MODEL = "model.json";
/** The rules a frozen release keeps beside its manifest, for the differ. */
export const FROZEN_RULES = RULES_FILE;
/** The directory under which a frozen release keeps its schema tree, for the differ. */
export const FROZEN_SCHEMAS = "schemas";
/** The conformance corpus a frozen release keeps, whose valid cases every later release within the major must still accept. */
export const FROZEN_CORPUS = "corpus.json";

/**
 * RFC 8785 JSON Canonicalization Scheme: object keys sorted by their UTF-16
 * code units, no whitespace, numbers and strings as ECMAScript's
 * `JSON.stringify` writes them, which is what RFC 8785 § 3.2.2 specifies.
 * Throws on what I-JSON forbids: a lone surrogate and a non-finite number.
 */
export function jcs(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`JCS: ${value} is no JSON number`);
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (LONE_SURROGATE.test(value)) throw new Error(`JCS: ${JSON.stringify(value)} has a lone surrogate`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${jcs(k)}:${jcs(o[k])}`).join(",")}}`;
  }
  throw new Error(`JCS: a ${typeof value} is no JSON value`);
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The SHA-256 of a value's JCS bytes, as 64 lowercase hex characters. */
export const jcsDigest = (value: unknown): string => sha256(Buffer.from(jcs(value), "utf8"));

export interface FileEntry {
  version: string;
  digest: string;
}

export type ChangeClass = "breaking" | "additive" | "annotation";

/** One difference between the last release's model and this one. */
export interface Change {
  class: ChangeClass;
  /** The named type, or the rule's owner. */
  type: string;
  /** The property, term, branch, or rule the change is about, if not the type itself. */
  member?: string;
  change: string;
  detail: string;
}

export interface ReleaseDoc {
  format: 1;
  lock: string;
  release: string;
  /** The last frozen release this one is compared with, or null for the first. */
  previous: string | null;
  input: { commit: string; blob: string; ir_sha256: string };
  /** The JCS digest of the model the files are emitted from. */
  model: string;
  /** The JCS digest of the lock's rules, `rules.json`. */
  rules: string;
  /** The JCS digest of `{ <path>: <schema> }` over every file. */
  digest: string;
  files: Record<string, FileEntry>;
  /** The differences from the previous release, sorted. */
  changes: Change[];
  /** The JCS digest of each registry file the tree references across hosts, by its `$id`, so a change to an imported list changes the release. */
  imports?: Record<string, string>;
}

/** A frozen release: its manifest, the model it was built from, its rules, its conformance corpus, and its schema tree by path. */
export interface Frozen {
  release: ReleaseDoc;
  model: ModelDoc;
  rules: RulesDoc;
  corpus: CorpusDoc;
  files: Record<string, unknown>;
}

export const renderRelease = (doc: ReleaseDoc): string => canonicalJson(doc);

// ---------------------------------------------------------------------------
// Versions

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** A release version's major, minor, and patch. Releases carry no pre-release or build part. */
export function parseVersion(v: string): [number, number, number] {
  const m = SEMVER.exec(v);
  if (!m) throw new Error(`"${v}" is no release version (MAJOR.MINOR.PATCH)`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

// ---------------------------------------------------------------------------
// The differ

const ANNOTATIONS = new Set(["title", "description", "examples", "default", "$comment"]);
const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Keywords whose value is a map of names to schemas, and keywords whose value is data, not a schema. */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "dependentSchemas", "$defs"]);
const VALUES = new Set(["enum", "const", "required", "type", "dependentRequired"]);

/** A schema without its annotations, at every depth; `true` is `{}`. */
function strip(s: unknown): unknown {
  if (s === true) return {};
  if (Array.isArray(s)) return s.map(strip);
  if (!isMap(s)) return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (ANNOTATIONS.has(k)) continue;
    if (SCHEMA_MAPS.has(k) && isMap(v)) out[k] = Object.fromEntries(Object.entries(v).map(([n, x]) => [n, strip(x)]));
    else out[k] = VALUES.has(k) ? v : strip(v);
  }
  return out;
}

const LOWER_BOUNDS = ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties", "minContains"];
const UPPER_BOUNDS = ["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties", "maxContains"];
/** Keywords the old schema must state the same way for the new one to accept as much. */
const EXACT = ["pattern", "format", "multipleOf", "contentEncoding", "contentMediaType"];
/** Keywords handled together below; anything else must be equal, or absent from the new schema. */
const HANDLED = new Set([
  ...LOWER_BOUNDS,
  ...UPPER_BOUNDS,
  ...EXACT,
  "type",
  "enum",
  "const",
  "$ref",
  "items",
  "propertyNames",
  "properties",
  "additionalProperties",
  "required",
  "uniqueItems",
]);

const typesOf = (t: unknown): Set<string> => new Set(Array.isArray(t) ? (t as string[]) : [t as string]);
const refName = (ref: unknown): string | null => (typeof ref === "string" && ref.startsWith("#/$defs/") ? ref.slice("#/$defs/".length) : null);

/**
 * How `narrowings` follows a `$ref`. `compare` gives the reasons the schema
 * the new reference names accepts less than the one the old reference
 * names; `resolve` gives the schema a reference names on either side, or
 * undefined where it can't.
 */
export interface Refs {
  compare(from: string, to: string, at: string): string[];
  resolve(side: "old" | "new", ref: string): unknown;
}

const onlyRef = (s: Record<string, unknown>) => typeof s.$ref === "string" && Object.keys(s).length === 1;

/**
 * The reasons the schema `b` may reject a value that the schema `a` accepts.
 * Conservative: a change it can't show to keep every value is a reason.
 * Annotations don't count. `refs` follows each `$ref`.
 */
export function narrowings(a0: unknown, b0: unknown, at: string, refs: Refs): string[] {
  const a = strip(a0);
  const b = strip(b0);
  if (same(a, b)) return [];
  if (isMap(b) && Object.keys(b).length === 0) return [];
  if (a === false) return [];
  if (!isMap(a) || !isMap(b)) return [`${at}: the new schema rejects values the old one accepts`];

  // A schema that is only a reference stands for the schema it names.
  if (onlyRef(a) && typeof b.$ref !== "string") {
    const t = refs.resolve("old", a.$ref as string);
    if (t !== undefined) return narrowings(t, b, at, refs);
  }

  // Unions: every old branch fits the new schema, or the old form fits a new branch.
  if (Array.isArray(a.anyOf) && Object.keys(a).length === 1) {
    return (a.anyOf as unknown[]).flatMap((branch, i) => narrowings(branch, b, `${at}/anyOf/${i}`, refs));
  }
  if (Array.isArray(b.anyOf) && Object.keys(b).length === 1) {
    const fits = (b.anyOf as unknown[]).some((branch) => narrowings(a, branch, at, refs).length === 0);
    return fits ? [] : [`${at}: no branch of the new union accepts every value of the old schema`];
  }

  const reasons: string[] = [];
  if (typeof a.$ref === "string" && typeof b.$ref === "string") {
    if (a.$ref !== b.$ref) reasons.push(...refs.compare(a.$ref, b.$ref, at));
  } else if (b.$ref !== undefined) {
    // Values of `a` must fit what the new reference names; `a`'s own keywords are compared below.
    const t = typeof b.$ref === "string" ? refs.resolve("new", b.$ref) : undefined;
    if (t === undefined) reasons.push(`${at}: the new schema references ${String(b.$ref)} where the old one ${a.$ref === undefined ? "was inline" : `referenced ${String(a.$ref)}`}`);
    else {
      const { $ref: _, ...rest } = a;
      reasons.push(...narrowings(rest, t, at, refs));
    }
  }
  if (b.type !== undefined) {
    if (a.type === undefined) reasons.push(`${at}: the new schema restricts the JSON type to ${JSON.stringify(b.type)}`);
    else {
      const bt = typesOf(b.type);
      const lost = [...typesOf(a.type)].filter((t) => !bt.has(t) && !(t === "integer" && bt.has("number")));
      if (lost.length > 0) reasons.push(`${at}: the new schema no longer accepts the JSON type ${lost.join(", ")}`);
    }
  }
  if (b.enum !== undefined) {
    const allowed = new Set((b.enum as unknown[]).map((v) => canonicalJson(v)));
    const old = a.enum !== undefined ? (a.enum as unknown[]) : a.const !== undefined ? [a.const] : null;
    if (old === null) reasons.push(`${at}: the new schema restricts the values to an enum`);
    else {
      const lost = old.filter((v) => !allowed.has(canonicalJson(v)));
      if (lost.length > 0) reasons.push(`${at}: the new enum drops ${lost.map((v) => JSON.stringify(v)).join(", ")}`);
    }
  }
  if (b.const !== undefined) {
    const old = a.const !== undefined ? [a.const] : a.enum !== undefined ? (a.enum as unknown[]) : null;
    if (old === null || old.some((v) => !same(v, b.const))) reasons.push(`${at}: the new schema fixes the value to ${JSON.stringify(b.const)}`);
  }
  for (const k of LOWER_BOUNDS) {
    if (b[k] === undefined) continue;
    if (a[k] === undefined || (a[k] as number) < (b[k] as number)) reasons.push(`${at}: ${k} ${a[k] === undefined ? "added" : "raised"}: ${String(a[k] ?? "none")} to ${String(b[k])}`);
  }
  for (const k of UPPER_BOUNDS) {
    if (b[k] === undefined) continue;
    if (a[k] === undefined || (a[k] as number) > (b[k] as number)) reasons.push(`${at}: ${k} ${a[k] === undefined ? "added" : "lowered"}: ${String(a[k] ?? "none")} to ${String(b[k])}`);
  }
  for (const k of EXACT) {
    if (b[k] !== undefined && !same(a[k], b[k])) reasons.push(`${at}: ${k} ${a[k] === undefined ? "added" : "changed"}: ${JSON.stringify(a[k] ?? null)} to ${JSON.stringify(b[k])}`);
  }
  if (b.uniqueItems === true && a.uniqueItems !== true) reasons.push(`${at}: the new schema requires unique items`);
  for (const k of ["items", "propertyNames"]) {
    if (b[k] !== undefined) reasons.push(...narrowings(a[k] ?? {}, b[k], `${at}/${k}`, refs));
  }

  // Objects: a property the old schema had stays; a new property fits what the old one let through.
  const ap = (a.properties ?? {}) as Record<string, unknown>;
  const bp = (b.properties ?? {}) as Record<string, unknown>;
  const aExtra = a.additionalProperties ?? {};
  for (const [k, s] of Object.entries(ap)) {
    if (!(k in bp)) reasons.push(`${at}: the property "${k}" is removed`);
    else reasons.push(...narrowings(s, bp[k], `${at}/properties/${k}`, refs));
  }
  for (const [k, s] of Object.entries(bp)) {
    if (k in ap || aExtra === false) continue;
    reasons.push(...narrowings(aExtra, s, `${at}/properties/${k}`, refs));
  }
  if (b.additionalProperties !== undefined) reasons.push(...narrowings(aExtra, b.additionalProperties, `${at}/additionalProperties`, refs));
  const required = new Set((a.required ?? []) as string[]);
  const added = ((b.required ?? []) as string[]).filter((k) => !required.has(k));
  if (added.length > 0) reasons.push(`${at}: newly requires ${added.map((k) => `"${k}"`).join(", ")}`);

  // Anything else, such as if / then or dependentSchemas, must stay as it was; dropping it only widens.
  for (const k of Object.keys(b).sort()) {
    if (HANDLED.has(k)) continue;
    if (!same(a[k], b[k])) reasons.push(`${at}: ${k} ${a[k] === undefined ? "added" : "changed"}`);
  }
  return reasons;
}

/** The properties an object, a document, or a profile carries, a profile it includes counted in. */
function propertiesOf(t: ModelType, types: Map<string, ModelType>): Record<string, ModelProperty> | null {
  if (t.kind !== "object" && t.kind !== "document" && t.kind !== "profile") return null;
  const props = { ...t.properties };
  if (t.kind === "object" && t.includes !== undefined) {
    const p = types.get(t.includes);
    if (p?.kind === "profile") for (const [k, v] of Object.entries(p.properties)) if (!(k in props)) props[k] = v;
  }
  return props;
}

const isOpen = (t: ModelType) => t.kind === "object" && t.open;
const schemaOf = (t: ModelType | undefined): Record<string, unknown> | null => (t && (t.kind === "primitive" || t.kind === "part" || t.kind === "copy") ? t.schema : null);
const describe = (r: TypeRef): string =>
  r.kind === "named" ? r.name : r.kind === "boolean" ? "boolean" : r.kind === "parameter" ? r.name : `${r.constructor}<${Object.entries(r.arguments).map(([k, v]) => `${k}=${describe(v)}`).join(", ")}>`;
const RANK = { optional: 0, conditional: 1, required: 2 } as const;

/**
 * Compares the last release's model with this one, type by type. Each
 * difference is a change with its class: `breaking` where a payload or a
 * change valid under the old model may be invalid under the new one,
 * `additive` where the new model accepts more or defines more, and
 * `annotation` where only prose changed. The rules are compared by
 * `diffRules`, and the emitted files by `diffFiles`.
 */
export function diffModels(from: ModelDoc, to: ModelDoc): Change[] {
  const old = new Map(from.types.map((t) => [t.name, t]));
  const neu = new Map(to.types.map((t) => [t.name, t]));
  const changes: Change[] = [];
  const add = (c: ChangeClass, type: string, change: string, detail: string, member?: string) => changes.push({ class: c, type, ...(member !== undefined ? { member } : {}), change, detail });

  /** What a type position loses when it changes from one named type to another. */
  const compareNamed = (x: string, y: string, at: string): string[] => {
    if (x === y) return [];
    const [a, b] = [old.get(x), neu.get(y)];
    if (b?.kind === "union" && b.any_of.some((r) => r.kind === "named" && r.name === x)) return [];
    const [sa, sb] = [schemaOf(a), schemaOf(b)];
    if (sa && sb) return narrowings(sa, sb, at, refs);
    return [`${at}: ${y} is a different type from ${x}`];
  };
  /** A schema in the model references a model type as `#/$defs/<Name>`. */
  const refs: Refs = {
    compare: (x, y, at) => {
      const [a, b] = [refName(x), refName(y)];
      return a !== null && b !== null ? compareNamed(a, b, at) : [`${at}: the new schema references ${y} where the old one referenced ${x}`];
    },
    resolve: (side, ref) => {
      const n = refName(ref);
      return (n !== null && schemaOf((side === "old" ? old : neu).get(n))) || undefined;
    },
  };
  const compareRefs = (a: TypeRef, b: TypeRef, at: string): string[] => {
    if (same(a, b)) return [];
    if (a.kind === "named" && b.kind === "named") return compareNamed(a.name, b.name, at);
    if (a.kind === "apply" && b.kind === "apply" && a.constructor === b.constructor) {
      // Every constructor is covariant in its parameters: each holds values of its argument types.
      const keys = [...new Set([...Object.keys(a.arguments), ...Object.keys(b.arguments)])].sort();
      return keys.flatMap((k) => {
        const [x, y] = [a.arguments[k], b.arguments[k]];
        if (x === undefined) return [`${at}: the argument ${k} is added`];
        if (y === undefined) return [`${at}: the argument ${k} is removed`];
        return compareRefs(x, y, `${at}<${k}>`);
      });
    }
    if (b.kind === "named" && neu.get(b.name)?.kind === "union") {
      const u = neu.get(b.name) as Extract<ModelType, { kind: "union" }>;
      if (u.any_of.some((r) => same(r, a))) return [];
    }
    return [`${at}: ${describe(b)} is a different type from ${describe(a)}`];
  };

  for (const [name, a] of old) {
    if (a.kind === "constructor") continue; // a template; its copies are compared
    const b = neu.get(name);
    if (!b) {
      add("breaking", name, "removed-type", `the ${a.kind} ${name} is removed`);
      continue;
    }
    if (a.kind !== b.kind) add("breaking", name, "changed-kind", `${name} changes from a ${a.kind} to a ${b.kind}`);
    const [ia, ib] = [schemaIdOf(a, "", ""), schemaIdOf(b, "", "")];
    if (ia !== null && ib === null) add("breaking", name, "removed-type", `${name} is no longer emitted`);
    else if (ia !== null && ib !== null && ia !== ib) add("breaking", name, "moved-type", `${name} moves from ${ia} to ${ib}`);

    const [sa, sb] = [schemaOf(a), schemaOf(b)];
    const [pa, pb] = [propertiesOf(a, old), propertiesOf(b, neu)];
    if (sa && sb) {
      const reasons = narrowings(sa, sb, name, refs);
      if (reasons.length > 0) add("breaking", name, "narrowed-type", reasons.join("; "));
      else if (!same(strip(sa), strip(sb))) add("additive", name, "widened-type", `${name} accepts every value it accepted`);
      else if (!same(sa, sb)) add("annotation", name, "description", `${name}'s annotations change`);
    } else if (pa && pb) {
      if (isOpen(a) && !isOpen(b)) add("breaking", name, "closed-object", `${name} now rejects members it doesn't name`);
      if (!isOpen(a) && isOpen(b)) add("additive", name, "opened-object", `${name} now accepts members it doesn't name`);
      if (a.kind === "profile" && b.kind === "profile") {
        // A profile projects a document: the fields and the paths it lists are what it carries.
        if (a.document !== b.document) add("breaking", name, "changed-document", `${name} projects ${b.document}, not ${a.document}`);
        for (const [list, label] of [["fields", "field"], ["paths", "path"]] as const) {
          const kept = new Set(b[list]);
          for (const x of a[list]) if (!kept.has(x)) add("breaking", name, `removed-${label}`, `${name} no longer lists the ${label} ${x}`, x);
          const had = new Set(a[list]);
          for (const x of b[list]) if (!had.has(x)) add("additive", name, `added-${label}`, `${name} also lists the ${label} ${x}`, x);
        }
      }
      for (const [k, p] of Object.entries(pa)) {
        const q = pb[k];
        if (!q) {
          add("breaking", name, "removed-property", `${name}.${k} is removed`, k);
          continue;
        }
        if (RANK[q.presence] > RANK[p.presence]) add("breaking", name, "required-property", `${name}.${k} becomes ${q.presence}${q.condition ? ` (${q.condition})` : ""}, from ${p.presence}`, k);
        else if (RANK[q.presence] < RANK[p.presence]) add("additive", name, "relaxed-property", `${name}.${k} becomes ${q.presence}, from ${p.presence}`, k);
        else if (q.presence === "conditional" && p.condition !== q.condition) add("breaking", name, "changed-condition", `${name}.${k}: "${p.condition ?? ""}" becomes "${q.condition ?? ""}"`, k);
        const reasons = compareRefs(p.type, q.type, `${name}.${k}`);
        if (reasons.length > 0) add("breaking", name, "changed-type", reasons.join("; "), k);
        else if (!same(p.type, q.type)) add("additive", name, "widened-type", `${name}.${k}: ${describe(q.type)} accepts every value of ${describe(p.type)}`, k);
        // A case narrows the property while its sibling holds the term; a case that is new, or that narrows to another type, narrows what was valid.
        const cases = (x: typeof p) => new Map((x.cases ?? []).map((c) => [`${c.when.member} = ${c.when.value}`, c.type.name]));
        const [ca, cb] = [cases(p), cases(q)];
        for (const [when, t] of cb) if (ca.get(when) !== t) add("breaking", name, "changed-case", `${name}.${k}: when ${when} it is ${t}${ca.has(when) ? `, not ${ca.get(when)}` : ""}`, k);
        for (const [when] of ca) if (!cb.has(when)) add("additive", name, "removed-case", `${name}.${k}: when ${when} it is no longer narrowed`, k);
        if (p.marker !== q.marker) add("breaking", name, "changed-marker", `${name}.${k}: the marker ${p.marker ?? "none"} becomes ${q.marker ?? "none"}`, k);
        if (p.description !== q.description) add("annotation", name, "description", `${name}.${k}'s description changes`, k);
      }
      for (const [k, q] of Object.entries(pb)) {
        if (k in pa) continue;
        if (q.presence !== "optional") add("breaking", name, "required-property", `${name}.${k} is added, ${q.presence}${q.condition ? ` (${q.condition})` : ""}`, k);
        else if (isOpen(a)) add("breaking", name, "constrained-property", `${name}.${k} is added to an open object, which accepted it with any value`, k);
        else add("additive", name, "added-property", `${name}.${k} is added, optional`, k);
      }
    } else if (a.kind === "vocabulary" && b.kind === "vocabulary") {
      if (a.open && !b.open) add("breaking", name, "closed-vocabulary", `${name} no longer accepts a namespaced term`);
      if (!a.open && b.open) add("additive", name, "opened-vocabulary", `${name} now accepts a namespaced term`);
      const terms = new Map(b.terms.map((t) => [canonicalJson(t.value), t]));
      for (const t of a.terms) {
        const u = terms.get(canonicalJson(t.value));
        if (!u) add("breaking", name, "removed-term", `${name} drops ${JSON.stringify(t.value)}`, String(t.value));
        else if (t.annotation !== u.annotation) add("annotation", name, "description", `${name} ${JSON.stringify(t.value)}'s label changes`, String(t.value));
      }
      const had = new Set(a.terms.map((t) => canonicalJson(t.value)));
      for (const t of b.terms) if (!had.has(canonicalJson(t.value))) add("additive", name, "added-term", `${name} adds ${JSON.stringify(t.value)}`, String(t.value));
    } else if (a.kind === "union" && b.kind === "union") {
      for (const r of a.any_of) {
        if (b.any_of.some((s) => same(r, s))) continue;
        const kept = b.any_of.some((s) => compareRefs(r, s, name).length === 0);
        if (!kept) add("breaking", name, "removed-branch", `${name} no longer accepts ${describe(r)}`, describe(r));
      }
      for (const s of b.any_of) if (!a.any_of.some((r) => same(r, s))) add("additive", name, "added-branch", `${name} also accepts ${describe(s)}`, describe(s));
    }
  }
  for (const [name, b] of neu) if (b.kind !== "constructor" && !old.has(name)) add("additive", name, "added-type", `the ${b.kind} ${name} is added`);

  return sortChanges(changes);
}

const changeKey = (c: Change) => `${c.type}\u0000${c.member ?? ""}\u0000${c.change}\u0000${c.detail}`;
/** Changes in their manifest order: by type, member, change, and detail. */
export const sortChanges = (changes: Change[]): Change[] => changes.sort((x, y) => (changeKey(x) < changeKey(y) ? -1 : changeKey(x) > changeKey(y) ? 1 : 0));


// ---------------------------------------------------------------------------
// The rules

const vectorSet = (vs: unknown[]) => new Set(vs.map((v) => canonicalJson(v)));

/**
 * Compares the last release's rules with this one's, by ID and by content.
 * A rule's ID doesn't always come from its text: a marker's, a primitive's,
 * and a constructor's rule keep their IDs while their statements and
 * vectors change (type rules § 9), so a rule present in both is compared
 * part by part.
 *
 * - A removed rule constrains nothing any more: `additive`.
 * - An added rule at `error` severity is `breaking` where it applies to a
 *   type or property the last release had, since a payload valid then may
 *   fail it; at `warning` severity, or on new types only, it is `additive`.
 * - A kept rule is `breaking` where it now rejects what it accepted: a
 *   vector valid under the last release is invalid, its severity rises to
 *   `error`, or it applies to a type or property the last release had and
 *   it didn't cover. A change to its statement, level of severity, sources,
 *   targets, or vectors otherwise is `additive`, since what a payload must
 *   satisfy changed; whether every old payload still passes is for the
 *   conformance corpus to show. A change to its owner, decisions, or
 *   standard alone is an `annotation`.
 *
 * `model` is the last release's model, which says what it had.
 */
export function diffRules(from: RulesDoc, to: RulesDoc, model: ModelDoc): Change[] {
  const types = new Map(model.types.map((t) => [t.name, t]));
  /** Whether the last release had a rule's target: a type, or a type's property. */
  const had = (target: string): boolean => {
    const dot = target.indexOf(".");
    const t = types.get(dot < 0 ? target : target.slice(0, dot));
    if (t === undefined) return false;
    if (dot < 0) return true;
    return target.slice(dot + 1) in (propertiesOf(t, types) ?? {});
  };
  const changes: Change[] = [];
  const add = (c: ChangeClass, r: Rule, change: string, detail: string) => changes.push({ class: c, type: r.owner, member: r.id, change, detail });
  const old = new Map(from.rules.map((r) => [r.id, r]));
  const neu = new Map(to.rules.map((r) => [r.id, r]));

  for (const [id, a] of old) if (!neu.has(id)) add("additive", a, "removed-rule", `the rule ${id} is removed`);
  for (const [id, b] of neu) {
    const a = old.get(id);
    if (a === undefined) {
      const reaches = b.applies_to.filter(had);
      if (b.severity === "error" && reaches.length > 0) add("breaking", b, "added-rule", `the rule ${id} is added at error severity on ${reaches.join(", ")}, which the last release had`);
      else add("additive", b, "added-rule", `the rule ${id} is added${b.severity === "warning" ? " at warning severity" : ", on new types only"}`);
      continue;
    }
    const reasons: string[] = [];
    if (a.severity === "warning" && b.severity === "error") reasons.push(`${id}: the severity rises from warning to error`);
    const covered = new Set(a.applies_to);
    const gained = b.applies_to.filter((x) => !covered.has(x) && had(x));
    if (gained.length > 0) reasons.push(`${id}: now applies to ${gained.join(", ")}, which the last release had`);
    const nowInvalid = vectorSet(b.vectors.invalid);
    const flipped = a.vectors.valid.filter((v) => nowInvalid.has(canonicalJson(v)));
    if (flipped.length > 0) reasons.push(`${id}: ${flipped.length} vector${flipped.length === 1 ? "" : "s"} valid under the last release ${flipped.length === 1 ? "is" : "are"} now invalid: ${flipped.map((v) => canonicalJson(v)).join(", ")}`);
    const parts = (["statement", "severity", "sources", "applies_to", "vectors"] as const).filter((k) => !same(a[k], b[k]));
    const notes = (["owner", "level", "decisions", "standard"] as const).filter((k) => !same(a[k] ?? null, b[k] ?? null));
    if (reasons.length > 0) add("breaking", b, "narrowed-rule", reasons.join("; "));
    else if (parts.length > 0) add("additive", b, "changed-rule", `the rule ${id} changes its ${parts.join(", ")}`);
    else if (notes.length > 0) add("annotation", b, "rule-annotation", `the rule ${id} changes its ${notes.join(", ")}`);
  }
  return sortChanges(changes);
}

// ---------------------------------------------------------------------------
// The emitted files

/** Keywords of a file's root that name the file rather than constrain a payload. */
const FILE_KEYS = new Set(["$id", "$schema", "$defs"]);

/** A schema with every `$ref` written as `<path>#<fragment>`, the path relative to the tree's root. */
function absoluteRefs(path: string, s: unknown): unknown {
  if (Array.isArray(s)) return s.map((x) => absoluteRefs(path, x));
  if (!isMap(s)) return s;
  return Object.fromEntries(
    Object.entries(s).map(([k, v]) => {
      if (k !== "$ref" || typeof v !== "string") return [k, absoluteRefs(path, v)];
      const hash = v.indexOf("#");
      const [file, fragment] = hash < 0 ? [v, ""] : [v.slice(0, hash), v.slice(hash)];
      return [k, `${file === "" ? path : posix.normalize(posix.join(posix.dirname(path), file))}${fragment}`];
    }),
  );
}

/** The schema at `<path>#<JSON pointer>` in a tree, or undefined. */
function pointTo(tree: Map<string, unknown>, ref: string): unknown {
  const hash = ref.indexOf("#");
  let at: unknown = tree.get(hash < 0 ? ref : ref.slice(0, hash));
  const pointer = hash < 0 ? "" : ref.slice(hash + 1);
  for (const seg of pointer === "" ? [] : pointer.slice(1).split("/")) {
    if (!isMap(at)) return undefined;
    at = at[seg.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return at;
}

/**
 * Compares the last release's schema files with this one's, entry by
 * entry: each file's root and each of its `$defs`. A change here that the
 * model shows is reported twice, once per view; a change the model doesn't
 * show, such as one the emitter makes, is reported only here. A removed
 * file or entry, and an entry that may reject a value it accepted, is
 * `breaking`; an added one, and an entry that accepts more, is `additive`.
 * An entry whose annotations alone change isn't reported: its file's
 * digest changes, which bumps the patch.
 */
export function diffFiles(from: Record<string, unknown>, to: Record<string, unknown>): Change[] {
  const tree = (files: Record<string, unknown>) => new Map(Object.entries(files).map(([p, s]) => [p, absoluteRefs(p, s)]));
  const [old, neu] = [tree(from), tree(to)];
  const pending = new Set<string>();
  const refs: Refs = {
    compare: (x, y, at) => {
      // The same reference names the same entry, which is compared on its own.
      if (x === y) return [];
      const key = `${x}\u0000${y}`;
      if (pending.has(key)) return [];
      const [a, b] = [pointTo(old, x), pointTo(neu, y)];
      if (a === undefined || b === undefined) return [`${at}: the new schema references ${y} where the old one referenced ${x}`];
      pending.add(key);
      try {
        return narrowings(a, b, at, refs);
      } finally {
        pending.delete(key);
      }
    },
    resolve: (side, ref) => pointTo(side === "old" ? old : neu, ref),
  };
  const changes: Change[] = [];
  const add = (c: ChangeClass, path: string, change: string, detail: string, member?: string) => changes.push({ class: c, type: path, ...(member !== undefined ? { member } : {}), change, detail });
  const compare = (path: string, a: unknown, b: unknown, at: string, member?: string) => {
    const reasons = narrowings(a, b, at, refs);
    if (reasons.length > 0) add("breaking", path, "narrowed-schema", reasons.join("; "), member);
    else if (!same(strip(a), strip(b))) add("additive", path, "widened-schema", `${at} accepts every value it accepted`, member);
  };
  const root = (s: unknown) => (isMap(s) ? Object.fromEntries(Object.entries(s).filter(([k]) => !FILE_KEYS.has(k))) : s);
  const defs = (s: unknown) => (isMap(s) && isMap(s.$defs) ? s.$defs : {});

  for (const [path, a] of old) {
    const b = neu.get(path);
    if (b === undefined) {
      add("breaking", path, "removed-file", `${path} is removed`);
      continue;
    }
    compare(path, root(a), root(b), path);
    const [da, db] = [defs(a), defs(b)];
    for (const [name, s] of Object.entries(da)) {
      if (!(name in db)) add("breaking", path, "removed-definition", `${path}#/$defs/${name} is removed`, name);
      else compare(path, s, db[name], `${path}#/$defs/${name}`, name);
    }
    for (const name of Object.keys(db)) if (!(name in da)) add("additive", path, "added-definition", `${path}#/$defs/${name} is added`, name);
  }
  for (const path of neu.keys()) if (!old.has(path)) add("additive", path, "added-file", `${path} is added`);
  return sortChanges(changes);
}

// ---------------------------------------------------------------------------
// The manifest

/** The digest of every file, from the schema it holds. */
export function fileDigests(files: { path: string; schema: unknown }[]): Record<string, string> {
  return Object.fromEntries(files.map((f) => [f.path, jcsDigest(f.schema)]));
}

/** The digest of the whole tree: of `{ <path>: <schema> }` over every file. */
export const treeDigest = (files: { path: string; schema: unknown }[]): string => jcsDigest(Object.fromEntries(files.map((f) => [f.path, f.schema])));

export interface ReleaseInput {
  model: ModelDoc;
  files: EmittedFile[];
  /** The lock's rules, as `rules.json` holds them. */
  rules: RulesDoc;
  /** The last frozen release of the lock, or null if there is none. */
  previous: Frozen | null;
}

/**
 * Builds one lock's manifest. A problem is a breaking change within the
 * major, or a previous release the differ can't read; the manifest is still
 * built, with a minor bump, so the gate can show it.
 */
/** The digests of the registry files a tree imports, or nothing where it imports none. */
function importDigests(files: EmittedFile[]): { imports?: Record<string, string> } {
  const own = new Set(files.map((f) => String(f.schema.$id)));
  const imported = withImports(files).filter((f) => !own.has(String(f.schema.$id)));
  return imported.length === 0 ? {} : { imports: Object.fromEntries(imported.map((f) => [String(f.schema.$id), jcsDigest(f.schema)] as const).sort(([a], [b]) => (a < b ? -1 : 1))) };
}

export function buildRelease(input: ReleaseInput): { doc: ReleaseDoc; problems: string[] } {
  const { model, files, rules, previous } = input;
  const problems: string[] = [];
  const digests = fileDigests(files);
  const modelDigest = jcsDigest(model);
  const rulesDigest = jcsDigest(rules);
  const base = {
    format: 1 as const,
    lock: model.input.lock,
    input: { commit: model.input.commit, blob: model.input.blob, ir_sha256: model.input.ir_sha256 },
    model: modelDigest,
    rules: rulesDigest,
    digest: treeDigest(files),
    ...importDigests(files),
  };
  const first = `${MAJOR}.0.0`;
  if (!previous) {
    return { doc: { ...base, release: first, previous: null, files: Object.fromEntries(files.map((f) => [f.path, { version: first, digest: digests[f.path]! }])), changes: [] }, problems };
  }

  const prev = previous.release;
  let release: string;
  let changes: Change[] = [];
  if (previous.model.format !== model.format) problems.push(`the release ${prev.release} keeps a model of format ${String(previous.model.format)}, and the differ reads format ${model.format}`);
  else if (previous.rules.format !== rules.format) problems.push(`the release ${prev.release} keeps rules of format ${String(previous.rules.format)}, and the differ reads format ${rules.format}`);
  else {
    const now = Object.fromEntries(files.map((f) => [f.path, f.schema]));
    changes = sortChanges([...diffModels(previous.model, model), ...diffRules(previous.rules, rules, previous.model), ...diffFiles(previous.files, now)]);
  }
  const [major, minor, patch] = parseVersion(prev.release);
  if (major > MAJOR) problems.push(`the last release ${prev.release} has a higher major than this tree's ${MAJOR}`);
  if (major < MAJOR) release = first;
  else {
    for (const c of changes.filter((x) => x.class === "breaking")) problems.push(`breaking change within major ${MAJOR}, against ${prev.release}: ${c.type}${c.member !== undefined ? ` ${c.member}` : ""}: ${c.change}: ${c.detail}`);
    const paths = Object.keys(digests);
    const moved =
      prev.model !== modelDigest ||
      prev.rules !== rulesDigest ||
      paths.length !== Object.keys(prev.files).length ||
      paths.some((p) => prev.files[p]?.digest !== digests[p]);
    if (changes.some((c) => c.class !== "annotation")) release = `${major}.${minor + 1}.0`;
    else if (changes.length > 0 || moved) release = `${major}.${minor}.${patch + 1}`;
    else release = prev.release;
  }
  // Nothing changed since the last frozen release: this is that release, manifest and all.
  if (release === prev.release && problems.length === 0) return { doc: prev, problems };
  const entries = Object.fromEntries(
    files.map((f) => {
      const was = prev.files[f.path];
      return [f.path, { version: was !== undefined && was.digest === digests[f.path] && major === MAJOR ? was.version : release, digest: digests[f.path]! }];
    }),
  );
  return { doc: { ...base, release, previous: prev.release, files: entries, changes }, problems };
}

/**
 * Recomputes a manifest's digests from the bytes of the files: every file it
 * lists exists and parses, its JCS digest is the one listed, every file of
 * the tree is listed, and the tree digest recomputes. `files` maps each path
 * of the tree to its bytes. With `model` and `rules`, their digests
 * recompute too.
 */
export function checkDigests(doc: ReleaseDoc, files: Map<string, Buffer>, model?: ModelDoc, rules?: RulesDoc): string[] {
  const problems: string[] = [];
  const parsed: { path: string; schema: unknown }[] = [];
  for (const path of [...files.keys()].sort()) {
    if (!(path in doc.files)) problems.push(`${path} isn't in ${RELEASE_FILE}`);
    let schema: unknown;
    try {
      schema = JSON.parse(files.get(path)!.toString("utf8"));
    } catch (e) {
      problems.push(`${path}: ${(e as Error).message}`);
      continue;
    }
    parsed.push({ path, schema });
    const digest = jcsDigest(schema);
    const listed = doc.files[path]?.digest;
    if (listed !== undefined && listed !== digest) problems.push(`${path}: the digest is ${digest}, and ${RELEASE_FILE} lists ${listed}`);
  }
  for (const path of Object.keys(doc.files)) if (!files.has(path)) problems.push(`${RELEASE_FILE} lists ${path}, which the tree lacks`);
  if (problems.length === 0 && treeDigest(parsed) !== doc.digest) problems.push(`the tree digest is ${treeDigest(parsed)}, and ${RELEASE_FILE} lists ${doc.digest}`);
  if (model !== undefined && jcsDigest(model) !== doc.model) problems.push(`the model digest is ${jcsDigest(model)}, and ${RELEASE_FILE} lists ${doc.model}`);
  if (rules !== undefined && jcsDigest(rules) !== doc.rules) problems.push(`the rules digest is ${jcsDigest(rules)}, and ${RELEASE_FILE} lists ${doc.rules}`);
  return problems;
}

// ---------------------------------------------------------------------------
// Frozen releases

/** Validates a manifest against `releases/release.schema.json`. Returns error strings. */
export function validateRelease(doc: unknown): string[] {
  return compileSchema(join(REPO_ROOT, RELEASE_SCHEMA))(doc);
}

/** The directory that holds a lock's frozen releases. */
export const releasesDirOf = (root: string, lock: string) => join(root, RELEASES_DIR, lock);

/** The bytes of every file under `kernel/`, `modules/`, and `documents/` of a directory, by path. */
export function readTree(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (rel: string) => {
    const abs = join(dir, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else out.set(p, readFileSync(join(dir, p)));
    }
  };
  for (const d of SCHEMA_ROOTS) walk(d);
  return out;
}

/** A lock's frozen releases, oldest first. Throws on a directory that isn't a valid frozen release. */
export function loadFrozen(root: string, lock: string): Frozen[] {
  const dir = releasesDirOf(root, lock);
  if (!existsSync(dir)) return [];
  const versions = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  for (const v of versions) parseVersion(v);
  return versions.sort(compareVersions).map((v) => {
    const at = join(dir, v);
    const where = (f: string) => join(RELEASES_DIR, lock, v, f);
    for (const f of [RELEASE_FILE, FROZEN_MODEL, FROZEN_RULES, FROZEN_CORPUS]) if (!existsSync(join(at, f))) throw new Error(`${where(f)} is missing; a frozen release keeps its manifest, its model, its rules, its corpus, and its schema tree`);
    const release = JSON.parse(readFileSync(join(at, RELEASE_FILE), "utf8")) as ReleaseDoc;
    const model = JSON.parse(readFileSync(join(at, FROZEN_MODEL), "utf8")) as ModelDoc;
    const rules = JSON.parse(readFileSync(join(at, FROZEN_RULES), "utf8")) as RulesDoc;
    const corpus = JSON.parse(readFileSync(join(at, FROZEN_CORPUS), "utf8")) as CorpusDoc;
    const files: Record<string, unknown> = {};
    for (const [p, bytes] of readTree(join(at, FROZEN_SCHEMAS))) {
      try {
        files[p] = JSON.parse(bytes.toString("utf8"));
      } catch (e) {
        throw new Error(`${where(posix.join(FROZEN_SCHEMAS, p))}: ${(e as Error).message}`);
      }
    }
    const errors = validateRelease(release);
    if (errors.length > 0) throw new Error(`${where(RELEASE_FILE)}: not a valid manifest: ${errors.join("; ")}`);
    if (release.release !== v) throw new Error(`${where(RELEASE_FILE)} names the release ${release.release}`);
    if (release.lock !== lock) throw new Error(`${where(RELEASE_FILE)} names the lock ${release.lock}`);
    return { release, model, rules, corpus, files };
  });
}

/**
 * Checks one frozen release: its schema tree is the one its manifest lists,
 * every digest recomputes, and each file is canonical JSON.
 */
export function checkFrozen(root: string, lock: string, f: Frozen): string[] {
  const at = join(RELEASES_DIR, lock, f.release.release);
  const problems: string[] = [];
  const tree = readTree(join(root, at, FROZEN_SCHEMAS));
  problems.push(...checkDigests(f.release, tree, f.model, f.rules).map((p) => `${at}: ${p}`));
  if (f.model.input?.lock !== lock) problems.push(`${at}: ${FROZEN_MODEL} is the model of the lock ${String(f.model.input?.lock)}`);
  if (f.rules.input?.lock !== lock) problems.push(`${at}: ${FROZEN_RULES} holds the rules of the lock ${String(f.rules.input?.lock)}`);
  if (f.corpus.input?.lock !== lock) problems.push(`${at}: ${FROZEN_CORPUS} holds the corpus of the lock ${String(f.corpus.input?.lock)}`);
  const texts: [string, string][] = [
    [RELEASE_FILE, renderRelease(f.release)],
    [FROZEN_MODEL, canonicalJson(f.model)],
    [FROZEN_RULES, canonicalJson(f.rules)],
    [FROZEN_CORPUS, canonicalJson(f.corpus)],
    ...Object.entries(f.files).map(([p, s]): [string, string] => [posix.join(FROZEN_SCHEMAS, p), canonicalJson(s)]),
  ];
  for (const [file, text] of texts) {
    if (readFileSync(join(root, at, file), "utf8") !== text) problems.push(`${at}/${file} isn't canonical JSON`);
  }
  return problems;
}

/**
 * The decision IDs a model and its rules cite, under `decisions` lists and
 * `decision` keys, sorted. The model's own `decisions` list carries every
 * decision a mapping entry cites, so a decision behind a property's type or
 * an informative row is here too.
 */
export function citedDecisions(model: ModelDoc, rules: RulesDoc): string[] {
  const ids = new Set<string>();
  const walk = (x: unknown, key: string | null): void => {
    if (Array.isArray(x)) for (const v of x) walk(v, key === "decisions" ? "decision" : null);
    else if (x !== null && typeof x === "object") for (const [k, v] of Object.entries(x)) walk(v, k);
    else if (typeof x === "string" && key === "decision") ids.add(x);
  };
  walk(model, null);
  walk(rules, null);
  return [...ids].sort();
}

/**
 * Gate 6: a release rests on reviewed decisions only. The
 * problems: each decision the model or the rules cite that has no record, or
 * whose record is still `proposed`.
 */
export function unreviewedDecisions(model: ModelDoc, rules: RulesDoc, decisions: { id: string; status: string }[]): string[] {
  const status = new Map(decisions.map((d) => [d.id, d.status]));
  return citedDecisions(model, rules).flatMap((id) => {
    const s = status.get(id);
    return s === undefined ? [`cites ${id}, which has no decision record`] : s === "proposed" ? [`rests on ${id}, which is still proposed`] : [];
  });
}

/**
 * Freezes a release as `releases/<lock>/<version>/`: its manifest, its
 * model, its rules, its conformance corpus, and its schema tree under
 * `schemas/`, which the next release's differ and corpus check read. A frozen release can't change: freezing a
 * version again with other bytes throws, and with the same bytes does
 * nothing. Returns whether it wrote the files.
 */
export function freezeRelease(root: string, doc: ReleaseDoc, model: ModelDoc, rules: RulesDoc, corpus: CorpusDoc, schemas: { path: string; schema: unknown }[]): boolean {
  const at = join(releasesDirOf(root, doc.lock), doc.release);
  const files: [string, string][] = [
    [RELEASE_FILE, renderRelease(doc)],
    [FROZEN_MODEL, canonicalJson(model)],
    [FROZEN_RULES, canonicalJson(rules)],
    [FROZEN_CORPUS, canonicalJson(corpus)],
    ...schemas.map((f): [string, string] => [posix.join(FROZEN_SCHEMAS, f.path), canonicalJson(f.schema)]),
  ];
  if (existsSync(at)) {
    const differs = files.filter(([f, text]) => !existsSync(join(at, f)) || readFileSync(join(at, f), "utf8") !== text);
    const listed = new Set(files.map(([f]) => f));
    const extra = [...readTree(join(at, FROZEN_SCHEMAS)).keys()].map((p) => posix.join(FROZEN_SCHEMAS, p)).filter((p) => !listed.has(p));
    if (differs.length > 0 || extra.length > 0) throw new Error(`${join(RELEASES_DIR, doc.lock, doc.release)} is frozen, and ${[...differs.map(([f]) => f), ...extra].slice(0, 5).join(", ")} would change; a frozen release can't change`);
    return false;
  }
  for (const [f, text] of files) {
    mkdirSync(dirname(join(at, f)), { recursive: true });
    writeFileSync(join(at, f), text);
  }
  return true;
}

// ---------------------------------------------------------------------------
// The independent check

/** One manifest for `tools/oracle/release_digests.py`: its schema tree, its model, its rules, or any of them. */
export interface OracleCheck {
  release: string;
  schemas: string | null;
  model: string | null;
  rules: string | null;
}

/**
 * Recomputes the digests with Python's rfc8785, as
 * `tools/oracle/requirements.txt` pins it, from the files on disk. Paths are
 * relative to `root`. Returns the problems and the version that ran.
 */
export function oracleDigests(root: string, checks: OracleCheck[]): { problems: string[]; note: string } {
  const python = join(root, ".venv", "bin", "python");
  if (!existsSync(python)) return { problems: ["no oracle venv at .venv; run: npm run setup:oracle"], note: "" };
  const r = spawnWithInput(python, ["-I", join(root, "tools", "oracle", "release_digests.py")], JSON.stringify({ checks }), { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { problems: [`${python}: ${r.error.message}`], note: "" };
  if (r.status !== 0) return { problems: [`tools/oracle/release_digests.py failed: ${(r.stderr || r.stdout).trim()}`], note: "" };
  const out = JSON.parse(r.stdout) as { rfc8785: string; problems: string[] };
  const pinned = /^rfc8785==(\S+)/m.exec(readFileSync(join(root, ORACLE_REQUIREMENTS), "utf8"))?.[1];
  const problems = [...out.problems];
  if (out.rfc8785 !== pinned) problems.push(`the oracle runs rfc8785 ${out.rfc8785}, but ${ORACLE_REQUIREMENTS} pins ${pinned ?? "none"}; run: npm run setup:oracle`);
  return { problems, note: `rfc8785 ${out.rfc8785}` };
}
