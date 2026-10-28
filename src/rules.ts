/**
 * Stage 5b, the rules emitter: lists every rule that JSON Schema can't
 * express (type rules § 9), each with its ID, the specification text it comes
 * from, the type that owns it, the types it applies to, and its valid and
 * invalid test vectors. It reads one lock's model, the lock's IR for the
 * text and the digests, and the reviewed vectors under `vectors/`.
 *
 * The rules are:
 *
 * - each mapping entry the model lists as a rule, under its IR element's ID
 *   and owned by the object the mapping names;
 * - one rule per mutability marker, under its § 3 marker row's ID and owned
 *   by the `Marker` vocabulary (type rules § 2). A rule statement that the
 *   mapping gives to `Marker` must sit in a marker row's meaning, and it is
 *   part of that marker's rule, so the rule is stated once;
 * - the primitives' and the constructors' rules, with the vectors the kernel
 *   files give them.
 *
 * Every rule has at least one valid and one invalid vector, and a rule
 * without them fails. A vector is a payload, a pair of versions with the
 * party that made the change (every marker rule's vectors are pairs), or a
 * payload with what its receiver does. The schema of the vectors' type
 * accepts every payload (`checkRuleVectors`), so the rule, not the schema,
 * decides each vector.
 */
import { existsSync, readdirSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { installFormats } from "./formats.ts";
import { canonicalJson } from "./canonical.ts";
import { elementDigest, indexElements, type Element } from "./elements.ts";
import { baseOf, type EmittedFile, schemaIdOf } from "./emit.ts";
import type { SpecIR } from "./ir-types.ts";
import { inScope, readYaml, type DecisionRecord, type TypeRef } from "./mapping.ts";
import { compileSchema } from "./pipeline.ts";
import type { ModelDoc, ModelType } from "./model.ts";
import { REPO_ROOT } from "./repo.ts";

/** A payload, for a rule about one payload. */
export interface PayloadVector {
  value: unknown;
  context?: Record<string, unknown>;
}
/** Two versions and the party that produced `after` from `before`, for a mutability rule. */
export interface ChangeVector {
  party: "buyer" | "seller";
  before: unknown;
  after: unknown;
  context?: Record<string, unknown>;
}
/** A payload and what its receiver does with it. */
export interface ReceiptVector {
  value: unknown;
  response: "process" | "skip" | "reject";
  context?: Record<string, unknown>;
}
export type Vector = PayloadVector | ChangeVector | ReceiptVector;

export interface VectorEntry {
  rule: string;
  digest: string;
  locks?: string[];
  decision?: string;
  /** IR elements beyond the rule's own text that the vectors rest on; the cited decision covers each. */
  sources?: string[];
  type?: string;
  valid: Vector[];
  invalid: Vector[];
}

export interface VectorFile {
  format: 1;
  module: string;
  rules: VectorEntry[];
  /** The file the entries came from, for messages. */
  file: string;
}

/** One published rule. */
export interface Rule {
  id: string;
  /** The type that owns the rule: an object or document (type rules § 5), the `Marker` vocabulary, a primitive, or a constructor. */
  owner: string;
  /** The specification text the rule comes from, or the kernel's statement of it. */
  statement: string;
  /** The RFC 2119 level of the statement, where it has one. */
  level?: string;
  /**
   * What an invalid vector means. `error`: the payload or the change doesn't
   * conform, and a conformance suite rejects it. `warning`: the rule is at
   * SHOULD level, which RFC 2119 lets an implementation depart from with a
   * reason, so a conformance suite reports the vector and doesn't reject it.
   */
  severity: "error" | "warning";
  /** The IR elements it rests on. */
  sources: string[];
  decisions: string[];
  standard?: { name: string; url: string };
  /** The types the rule applies to: its owner; the properties that carry a marker, as `<type>.<property>`; or every copy of a constructor. */
  applies_to: string[];
  vectors: {
    /** The named type each payload is an instance of, and the `$id` of its schema; a constructor rule's payloads are of the template applied to `arguments`. */
    type?: string;
    schema?: string;
    arguments?: Record<string, TypeRef>;
    valid: Vector[];
    invalid: Vector[];
  };
}

export interface RulesDoc {
  format: 1;
  input: { lock: string; commit: string; blob: string };
  rules: Rule[];
}

export const VECTORS_DIR = "vectors";
const VECTORS_SCHEMA = join(VECTORS_DIR, "vectors.schema.json");
export const RULES_FILE = "rules.json";

/**
 * Loads `<dir>/*.yaml`, a spec's `vectors/` (`VECTORS_DIR` in its folder),
 * and validates each file against the vectors schema. A file's `module` must
 * equal its name. Throws on the first invalid file.
 */
export function loadVectors(dir: string): VectorFile[] {
  const validate = compileSchema(join(REPO_ROOT, VECTORS_SCHEMA));
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => {
      const file = join(dir, f);
      const doc = readYaml(file);
      const errors = validate(doc);
      if (errors.length > 0) throw new Error(`${file}: not a valid vectors file: ${errors.join("; ")}`);
      const v = doc as Omit<VectorFile, "file">;
      if (v.module !== basename(f, ".yaml")) throw new Error(`${file}: "module" is "${v.module}"; it must equal the file name "${basename(f, ".yaml")}"`);
      return { ...v, file };
    });
}

/**
 * A lock's rules directory, from its IR directory, as its schema directory
 * is: `ir` gives `rules`, and `ir/with-open-prs` gives `rules/with-open-prs`.
 */
export function rulesDirOf(irDir: string): string {
  const rest = posix.relative("ir", irDir.split("\\").join("/"));
  if (rest.startsWith("..")) throw new Error(`the IR directory "${irDir}" isn't under ir/`);
  return posix.join("rules", rest);
}

export const isChange = (v: Vector): v is ChangeVector => "party" in v;
export const isReceipt = (v: Vector): v is ReceiptVector => "response" in v;

/** The payloads of a vector that its type's schema must accept. */
export const payloadsOf = (v: Vector): [string, unknown][] => (isChange(v) ? [["before", v.before], ["after", v.after]] : [["value", v.value]]);

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

/** RFC 2119 levels that allow a departure with a reason: an invalid vector of a rule at one of them is a warning. */
const SHOULD_LEVELS = new Set(["SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED"]);
export const severityOf = (level: string | undefined): Rule["severity"] => (level !== undefined && SHOULD_LEVELS.has(level) ? "warning" : "error");

/** The specification text an element states a rule in: a statement's sentence, or, for a value list in prose, the sentences on its line. */
function textOf(e: Element, elements: Map<string, Element>): { text: string; also: string[]; identifiers: string[] } {
  if (e.kind === "statement") return { text: e.element.text, also: [], identifiers: e.element.identifiers };
  if (e.kind === "marker") return { text: e.element.meaning.text, also: [], identifiers: [] };
  if (e.kind === "value_list" && e.element.origin === "prose") {
    const { host, loc } = e.element;
    const holders = [...elements.values()].flatMap((x) => ((x.kind === "sentence" || x.kind === "statement") && x.element.host === host && x.element.loc.line === loc.line ? [x.element] : []));
    if (holders.length > 0) return { text: holders.map((h) => h.text).join(" "), also: holders.map((h) => h.id), identifiers: holders.flatMap((h) => h.identifiers) };
  }
  return { text: "", also: [], identifiers: [] };
}

export interface RulesInput {
  model: ModelDoc;
  ir: SpecIR;
  lock: string;
  vectors: VectorFile[];
  decisions: DecisionRecord[];
  /** The lock's schema directory, such as `schemas`, for each vector type's `$id`. */
  schemaDir: string;
  /** The conditional properties the schema leaves to the rules, as the schema emitter lists them: `<type>.<property>: <reason>`. */
  conditionsLeft: string[];
  /** The base of the schema tree's `$id`s (`SchemaNames.base`), for each vector type's `$id`. */
  schemaBase: string;
}

/**
 * Emits one lock's rules. Returns the document and the problems; a problem
 * means the document isn't to be written. Fails on a rule with no vectors,
 * on vectors for no rule, on a stale digest, on a decision that doesn't
 * cover the rule, on vectors in the file of a module that doesn't own the
 * rule's section, on a vector type the schema doesn't emit, on a marker rule
 * whose vector isn't a pair of versions, on a vector that is both valid and
 * invalid, on a context key that names no property, on a vectors source
 * that the entry's decision doesn't cover, on a `Marker` rule statement
 * outside a marker row, and on a condition the schema leaves to the rules
 * whose row no rule lists as a source.
 */
export function emitRules(input: RulesInput): { doc: RulesDoc; problems: string[] } {
  const { model, ir, lock, vectors, decisions, schemaDir, schemaBase } = input;
  const problems: string[] = [];
  const elements = indexElements(ir);
  const types = new Map(model.types.map((t) => [t.name, t]));
  const rules = new Map<string, Rule>();
  const add = (r: Rule, where: string) => {
    if (rules.has(r.id)) problems.push(`${where}: rule "${r.id}" is listed twice on lock "${lock}"`);
    else rules.set(r.id, r);
  };

  // Marker rules: one per marker, from its § 3 row, with the rule statements that sit in the row.
  const markerTypes = model.types.filter((t): t is Extract<ModelType, { kind: "vocabulary" }> => t.kind === "vocabulary" && t.attribute === "marker");
  const markerNames = new Set(markerTypes.map((t) => t.name));
  const markerRule = new Map<string, Rule>();
  for (const v of markerTypes) {
    for (const term of v.terms) {
      const rows = term.sources.filter((s) => elements.get(s)?.kind === "marker");
      if (rows.length !== 1) {
        problems.push(`${v.module}: marker "${term.value}" has ${rows.length} marker rows on lock "${lock}"; its rule takes its one row's ID`);
        continue;
      }
      const row = rows[0]!;
      const e = elements.get(row)!;
      const appliesTo = model.types.flatMap((t) => ("properties" in t ? Object.entries(t.properties).filter(([, p]) => p.marker === term.value).map(([k]) => `${t.name}.${k}`) : []));
      const r: Rule = {
        id: row,
        owner: v.name,
        statement: textOf(e, elements).text,
        severity: "error",
        sources: [row],
        decisions: [...v.decisions],
        applies_to: sorted(appliesTo),
        vectors: { valid: [], invalid: [] },
      };
      markerRule.set(row, r);
      add(r, `${v.module}: vocabulary "${v.name}"`);
    }
  }

  // The mapping's rules.
  for (const m of model.rules) {
    const e = elements.get(m.ir);
    const where = `rule "${m.ir}"`;
    if (!e) {
      problems.push(`${where}: lock "${lock}" has no IR element "${m.ir}"`);
      continue;
    }
    const owner = types.get(m.owner);
    if (!owner) {
      problems.push(`${where}: its owner "${m.owner}" is no type in the model on lock "${lock}"`);
      continue;
    }
    if (owner.kind === "vocabulary" && owner.attribute === "marker") {
      // A statement in a marker row's meaning is part of that marker's rule.
      const host = e.kind === "statement" ? e.element.host.split("#")[0]! : "";
      const r = markerRule.get(host);
      if (!r) {
        problems.push(`${where}: the mapping gives it to "${m.owner}", but it doesn't sit in a § 3 marker row, so no marker's rule holds it`);
        continue;
      }
      r.sources = sorted([...r.sources, m.ir]);
      r.decisions = sorted([...r.decisions, ...m.decisions]);
      continue;
    }
    const t = textOf(e, elements);
    if (t.text === "") problems.push(`${where}: the ${e.kind} element states no sentence for the rule to quote`);
    // A statement in a field or key row's description is about that row's property: the row is a source, and the rule applies to the owner's property it defines.
    const hostRow = e.kind === "statement" ? e.element.host.split("#")[0]! : "";
    const hostKind = elements.get(hostRow)?.kind;
    const rowOfField = hostKind === "field" || hostKind === "key" ? hostRow : undefined;
    const fieldOf = rowOfField && "properties" in owner ? Object.entries(owner.properties).filter(([, p]) => p.sources.includes(rowOfField)).map(([k]) => `${owner.name}.${k}`) : [];
    add(
      {
        id: m.ir,
        owner: m.owner,
        statement: t.text,
        ...(m.level ? { level: m.level } : {}),
        severity: severityOf(m.level),
        sources: sorted([m.ir, ...t.also, ...(rowOfField ? [rowOfField] : [])]),
        decisions: sorted(m.decisions),
        applies_to: fieldOf.length > 0 ? sorted(fieldOf) : [m.owner],
        vectors: { valid: [], invalid: [] },
      },
      where,
    );
  }

  // Vectors: one entry per rule on the lock, in the file of the module that owns the rule's section.
  const sectionModule = new Map(model.modules.flatMap((m) => m.sections.map((s) => [s, m.name] as const)));
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const seen = new Map<string, string>();
  for (const f of vectors) {
    for (const v of f.rules) {
      if (!inScope(v.locks, lock)) continue;
      const where = `${f.file}: rule "${v.rule}"`;
      const first = seen.get(v.rule);
      if (first !== undefined) {
        problems.push(`${where}: already has vectors in ${first} on lock "${lock}"`);
        continue;
      }
      seen.set(v.rule, f.file);
      const r = rules.get(v.rule);
      const e = elements.get(v.rule);
      if (!r || !e) {
        problems.push(`${where}: names no rule on lock "${lock}"; vectors belong to a rule the mapping states or to a marker row`);
        continue;
      }
      const now = elementDigest(e);
      if (now !== v.digest) problems.push(`${where}: stale digest on lock "${lock}": recorded ${v.digest.slice(0, 12)}, current ${now.slice(0, 12)}; review the vectors against the rule, then run: npm run cite -- ${v.rule}`);
      const module = sectionModule.get(e.element.loc.section);
      if (module !== f.module) problems.push(`${where}: the rule sits in § ${e.element.loc.section}, which module "${module ?? "none"}" owns, so its vectors go in vectors/${module ?? "<module>"}.yaml`);
      if (v.decision !== undefined) {
        const d = byId.get(v.decision);
        if (!d) problems.push(`${where}: cites decision "${v.decision}", which doesn't exist`);
        else if (d.status === "superseded") problems.push(`${where}: cites "${d.id}", which is superseded by "${d.superseded_by}"`);
        else if (!d.covers.some((c) => c.ir === v.rule && inScope(c.locks, lock))) problems.push(`${where}: cites "${d.id}", which doesn't cover "${v.rule}" on lock "${lock}"`);
        else r.decisions = sorted([...r.decisions, d.id]);
      }
      for (const src of v.sources ?? []) {
        const d = v.decision === undefined ? undefined : byId.get(v.decision);
        if (!elements.has(src)) problems.push(`${where}: its source "${src}" is no IR element on lock "${lock}"`);
        else if (!d) problems.push(`${where}: its source "${src}" needs a decision that covers it; cite one with "decision"`);
        else if (!d.covers.some((c) => c.ir === src && inScope(c.locks, lock))) problems.push(`${where}: its source "${src}" isn't covered by "${d.id}" on lock "${lock}"`);
        else r.sources = sorted([...r.sources, src]);
      }
      const typeName = v.type ?? r.owner;
      const t = types.get(typeName);
      const schema = t ? schemaIdOf(t, schemaDir, schemaBase) : null;
      if (!t || schema === null) problems.push(`${where}: its vectors are instances of "${typeName}", which the schema doesn't emit on lock "${lock}"; name an emitted type with "type"`);
      const all = [...v.valid, ...v.invalid];
      if (markerNames.has(r.owner) && !all.every(isChange)) problems.push(`${where}: a marker rule is about two versions and the party that changed one into the other, so each of its vectors is a pair (type rules § 9)`);
      const valid = new Set(v.valid.map((x) => canonicalJson(x)));
      for (const x of v.invalid) if (valid.has(canonicalJson(x))) problems.push(`${where}: ${JSON.stringify(x)} is both valid and invalid`);
      for (const x of all) {
        for (const k of Object.keys(x.context ?? {})) {
          const [ct, cp] = k.split(".");
          const owner = types.get(ct!);
          if (!owner || !("properties" in owner) || !(cp! in owner.properties)) problems.push(`${where}: the context key "${k}" names no property in the model on lock "${lock}"`);
        }
      }
      r.vectors = { type: typeName, ...(schema ? { schema } : {}), valid: v.valid, invalid: v.invalid };
    }
  }

  // A condition the schema leaves to the rules belongs to the rule whose vectors entry names the condition's row as a source.
  for (const left of input.conditionsLeft) {
    const match = /^([A-Z][A-Za-z0-9]*)\.([a-z][a-z0-9_]*):/.exec(left);
    if (!match) {
      problems.push(`the condition "${left}" names no <type>.<property>`);
      continue;
    }
    const [, typeName, property] = match;
    const t = types.get(typeName!);
    const rows = (t && "properties" in t ? t.properties[property!]?.sources : undefined) ?? [];
    const naming = [...rules.values()].filter((r) => !markerNames.has(r.owner) && rows.some((row) => r.sources.includes(row)));
    if (rows.length === 0 || naming.length === 0) {
      problems.push(`the schema leaves the condition of ${typeName}.${property} to the rules, but no rule names its row (${rows.join(", ") || "none"}) on lock "${lock}"; map the sentence that states the condition as a rule, and list the row under "sources" in that rule's vectors entry (type rules § 9)`);
    }
  }

  // The primitives' and the constructors' rules, with the kernel files' vectors.
  for (const k of model.kernel_rules) {
    const owner = types.get(k.owner);
    if (!owner) {
      problems.push(`rule "${k.id}": its owner "${k.owner}" is no type in the model on lock "${lock}"`);
      continue;
    }
    const wrap = (xs: unknown[]): Vector[] => xs.map((value) => ({ value }));
    const copies = owner.kind === "constructor" ? model.types.filter((t) => t.kind === "copy" && t.of.constructor === owner.name).map((t) => t.name) : [owner.name];
    const schema = owner.kind === "constructor" ? null : schemaIdOf(owner, schemaDir, schemaBase);
    add(
      {
        id: k.id,
        owner: k.owner,
        statement: k.statement,
        severity: "error",
        sources: k.sources,
        decisions: k.decisions,
        ...(k.standard ? { standard: k.standard } : {}),
        applies_to: sorted(copies),
        vectors: {
          ...(owner.kind === "constructor" ? { arguments: k.arguments ?? {} } : { type: owner.name, ...(schema ? { schema } : {}) }),
          valid: wrap(k.valid),
          invalid: wrap(k.invalid),
        },
      },
      `rule "${k.id}"`,
    );
  }

  // Type rules § 9: a rule without vectors fails.
  for (const r of rules.values()) {
    if (r.vectors.valid.length === 0 || r.vectors.invalid.length === 0) {
      problems.push(`rule "${r.id}" (owner ${r.owner}) has ${r.vectors.valid.length} valid and ${r.vectors.invalid.length} invalid vectors on lock "${lock}"; every rule needs at least one of each (type rules § 9)`);
    }
  }

  const doc: RulesDoc = {
    format: 1,
    input: { lock, commit: model.input.commit, blob: model.input.blob },
    rules: [...rules.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  return { doc, problems };
}

/** The rules as `rules/rules.json` holds them: canonical JSON. */
export const renderRules = (doc: RulesDoc): string => canonicalJson(doc);

/**
 * The isolation gate: the schema of each rule's vector type accepts every
 * payload of every vector, valid and invalid, and each context value is an
 * instance of the type of the property its key names. So the schema passes
 * each vector, and the rule alone decides it (type rules § 9). Runs Ajv 2020
 * with `format` asserted on the lock's emitted files. A constructor rule's
 * vectors are checked by the constructor gate, on the template applied to
 * their arguments.
 */
export function checkRuleVectors(doc: RulesDoc, model: ModelDoc, files: EmittedFile[], schemaDir: string): string[] {
  const problems: string[] = [];
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  installFormats(ajv);
  try {
    for (const f of files) ajv.addSchema(f.schema);
  } catch (e) {
    return [`Ajv doesn't load the schemas: ${(e as Error).message}`];
  }
  const types = new Map(model.types.map((t) => [t.name, t]));
  const verdict = (schema: string, value: unknown): string | null => {
    let validate;
    try {
      validate = ajv.getSchema(schema);
    } catch (e) {
      return `Ajv doesn't compile ${schema}: ${(e as Error).message}`;
    }
    if (!validate) return `no schema has the $id ${schema}`;
    if (validate(value)) return null;
    return (validate.errors ?? []).slice(0, 3).map((x) => `${x.instancePath || "/"} ${x.message ?? ""}`).join(", ");
  };
  const contextSchema = (key: string): string | null => {
    const [t, p] = key.split(".");
    const owner = types.get(t!);
    const prop = owner && "properties" in owner ? owner.properties[p!] : undefined;
    if (!prop || prop.type.kind !== "named") return null;
    const named = types.get(prop.type.name);
    return named ? schemaIdOf(named, schemaDir, baseOf(files, schemaDir)) : null;
  };
  for (const r of doc.rules) {
    const schema = r.vectors.schema;
    if (schema === undefined) {
      if (r.vectors.arguments === undefined) problems.push(`rule "${r.id}": its vectors name no schema`);
      continue;
    }
    for (const [label, list] of [["valid", r.vectors.valid], ["invalid", r.vectors.invalid]] as const) {
      list.forEach((v, i) => {
        for (const [part, value] of payloadsOf(v)) {
          const why = verdict(schema, value);
          if (why) problems.push(`rule "${r.id}": ${label} vector ${i + 1}: the ${r.vectors.type} schema rejects its ${part} (${why}); a rule vector passes the schema, so the rule alone decides it (type rules § 9)`);
        }
        for (const [k, value] of Object.entries(v.context ?? {})) {
          const s = contextSchema(k);
          const why = s === null ? `"${k}" has no named type` : verdict(s, value);
          if (why) problems.push(`rule "${r.id}": ${label} vector ${i + 1}: context "${k}": ${why}`);
        }
      });
    }
  }
  return problems;
}
