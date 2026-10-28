/**
 * The examples gate (gate 10): every example the
 * specification gives loads under YAML 1.2 core with JSON types only,
 * validates against the emitted schema of the document it shows, and uses
 * only keys the model defines. Every failure is a recorded finding in
 * `examples/findings.yaml`, or the gate fails.
 *
 * - **Which examples.** The model's examples (type rules § 11): each § 6
 *   sentence that names a file under `examples/`, by the `example-file`
 *   mapping rule, is a whole document; each code block a decision maps to an
 *   example (D-033) is part of one, a value for each field it holds.
 * - **Loading.** YAML 1.2 core with unique keys, so `no` stays a string and an
 *   unquoted date stays a string. A value JSON can't hold fails: a key that
 *   isn't a string, `.inf` or `.nan`, or an unknown tag.
 * - **Validation.** Ajv 2020, strict, with `format` asserted, on the lock's
 *   emitted files. A failure is one instance location: an error under a
 *   failed `anyOf` or `oneOf` is part of that union's failure, and a key a
 *   closed object doesn't name is an `undefined_key` failure at the key.
 * - **Undefined keys.** A key of an open object (D-016) that the object
 *   doesn't name passes the schema, but the model doesn't define it, so it is
 *   an `undefined_key` failure too. The walk follows only the union branches
 *   that accept the value.
 * - **What a failure rests on.** The IR elements of the deepest model type
 *   and property the walk reaches at the failure's location, and at a map
 *   whose key its key type rejects, that type's. A copy's member, and each
 *   item of a list member, rests on its template's row for the key, as a
 *   selectable field's `included[]` on § 3.1's. A finding cites a decision
 *   that covers one of them, as a round-trip difference does.
 */
import { withImports } from "./imports.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { installFormats } from "./formats.ts";
import { isScalar, parseDocument, visit } from "yaml";
import { canonicalJson } from "./canonical.ts";
import type { EmittedFile } from "./emit.ts";
import { baseOf, schemaIdOf } from "./emit.ts";
import { ORACLE_REQUIREMENTS, pinnedOracle } from "./engines.ts";
import { materializeExamples } from "./fetch.ts";
import type { SpecLock } from "./lock.ts";
import { inScope, readYaml, retired, stands, type DecisionRecord } from "./mapping.ts";
import { exampleFilesOf } from "./mapping-rules.ts";
import type { ModelDoc, ModelType } from "./model.ts";
import { compileSchema } from "./pipeline.ts";
import { checkedTypes, ordersOf, type Check, type Order } from "./rule-checks.ts";
import { severityOf } from "./rules.ts";
import { spawnWithInput } from "./spawn.ts";
import { REPO_ROOT } from "./repo.ts";

/** One example the model lists: a file, or a code block of the specification. */
export interface ModelExample {
  /** The file's path, such as `examples/proposal.yaml`, or the code block's IR element ID. */
  id: string;
  /** The IR element that maps to the example. */
  ir: string;
  /** The document it shows. */
  object: string;
  /** A code block is part of a document: each field it holds is validated on its own. */
  part: boolean;
  /** A code block's text; a file's bytes come from the lock. */
  text?: string;
}

/** The model's examples, by ID. */
export function modelExamples(model: ModelDoc): ModelExample[] {
  return model.examples
    .map((x): ModelExample => {
      const files = x.ir.startsWith("sentence:") ? exampleFilesOf(x.text) : [];
      return files.length === 1 ? { id: files[0]!, ir: x.ir, object: x.object, part: false } : { id: x.ir, ir: x.ir, object: x.object, part: true, text: x.text };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * A lock's examples with their loaded values. The files come from the lock's
 * sources, blob-verified; it throws when no source yields them. `listing`
 * holds the problems with the lock's list: a file the specification names as
 * an example that the lock doesn't list, a listed file the specification
 * doesn't name, and a file under `examples/` at the commit that the lock
 * doesn't list, when a clone can show them.
 */
export async function lockExamples(lock: SpecLock, model: ModelDoc): Promise<{ examples: ModelExample[]; values: Map<string, Loaded>; listing: string[]; via: string }> {
  const examples = modelExamples(model);
  const got = await materializeExamples(lock);
  const listing: string[] = [];
  const named = new Set(examples.filter((x) => !x.part).map((x) => x.id));
  for (const id of named) if (!(id in lock.examples)) listing.push(`the specification names ${id} as an example, and ${lock.file.split("/").pop()} doesn't list it`);
  for (const p of Object.keys(lock.examples)) if (!named.has(p)) listing.push(`${lock.file.split("/").pop()} lists ${p}, which the specification doesn't name as an example of a document`);
  for (const p of got.listed ?? []) if (!(p in lock.examples)) listing.push(`${p} is under examples/ at ${lock.commit.slice(0, 7)}, and ${lock.file.split("/").pop()} doesn't list it`);
  const values = new Map<string, Loaded>();
  for (const x of examples) {
    if (x.part) values.set(x.id, loadJsonYaml(x.text ?? ""));
    else {
      const bytes = got.files.get(x.id);
      if (!bytes) continue;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        values.set(x.id, { ok: false, problems: ["the file isn't UTF-8"] });
        continue;
      }
      values.set(x.id, loadJsonYaml(text));
    }
  }
  return { examples, values, listing, via: got.via };
}

/** A value loaded as JSON, or why it can't be. */
export type Loaded = { ok: true; value: unknown } | { ok: false; problems: string[] };

/**
 * Loads text as YAML 1.2 core with unique keys, and refuses any value JSON
 * can't hold. JSON is YAML 1.2, so a `.json` example loads the same way.
 */
export function loadJsonYaml(text: string): Loaded {
  const doc = parseDocument(text, { version: "1.2", schema: "core", uniqueKeys: true, prettyErrors: false });
  const problems = [...doc.errors, ...doc.warnings].map((e) => `line ${e.linePos?.[0]?.line ?? "?"}: ${e.message.split("\n")[0]}`);
  visit(doc, {
    Pair(_, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") problems.push(`line ${lineOf(text, pair.key)}: the key ${JSON.stringify(String(isScalar(pair.key) ? pair.key.value : pair.key))} isn't a string`);
    },
    Scalar(_, node) {
      if (typeof node.value === "number" && !Number.isFinite(node.value)) problems.push(`line ${lineOf(text, node)}: ${String(node.source ?? node.value)} isn't a JSON number`);
      if (node.value !== null && !["string", "number", "boolean"].includes(typeof node.value)) problems.push(`line ${lineOf(text, node)}: a ${typeof node.value} isn't a JSON value`);
    },
  });
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: doc.toJS({ maxAliasCount: 100 }) };
}

function lineOf(text: string, node: unknown): number | string {
  const range = (node as { range?: [number, number, number] } | null)?.range;
  return range ? text.slice(0, range[0]).split("\n").length : "?";
}

/** One failure of an example: a location the schema rejects, a key the model doesn't define, or a value a rule's check rejects. */
export interface Failure {
  example: string;
  /** The JSON pointer of the location in the example, `""` for the whole of it. */
  path: string;
  kind: "load" | "invalid" | "undefined_key" | "rule";
  /** The rule a `rule` failure breaks. */
  rule?: string;
  /** A `rule` failure's severity: `warning` for a SHOULD or SHOULD NOT rule, which an implementation may depart from with a reason, and `error` otherwise. */
  severity?: "error" | "warning";
  /** The example's value at the location; null for a failure to load. */
  value: unknown;
  message: string;
  /** The IR elements of the deepest model type and property at the location. */
  elements: string[];
}

/** A value a rule's check can't decide, because the example leaves out what the verdict turns on. */
export interface Undecided {
  example: string;
  /** The JSON pointer of the value the rule reads, `""` for the whole example. */
  path: string;
  rule: string;
  /** The IR elements the rule rests on, and a code block's own. */
  elements: string[];
}

/** One validation case, for the cross-check with the reference oracle: a schema reference and an instance. */
export interface ExampleCase {
  example: string;
  ref: string;
  value: unknown;
  valid: boolean;
}

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const escape = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");
const unescape = (k: string) => k.replace(/~1/g, "/").replace(/~0/g, "~");

/** The value at a JSON pointer, or undefined. */
export function valueAt(root: unknown, path: string): unknown {
  if (path === "") return root;
  let v: unknown = root;
  for (const seg of path.slice(1).split("/").map(unescape)) {
    if (Array.isArray(v)) v = v[Number(seg)];
    else if (isMap(v)) v = v[seg];
    else return undefined;
  }
  return v;
}

const within = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * Validates the examples against one lock's emitted files. `values` holds each
 * example's loaded value, or its load problems, by example ID. Returns every
 * failure, sorted, every case for the oracle, and the problems that stop the
 * gate itself, such as a document the schema doesn't emit.
 */
/** A rule a type's values are checked by, with the elements the rule rests on and its severity. */
export interface CheckedRule {
  id: string;
  sources: string[];
  severity: "error" | "warning";
}

/**
 * The rules each model type's checks read (src/rule-checks.ts), by type
 * name: a constructor's rule on each of its copies, and every other rule on
 * its owner. A kernel or constructor rule is a MUST; a statement's level
 * gives the rest theirs, as the rules file does.
 */
export function checksByType(model: ModelDoc, ruleChecks: Readonly<Record<string, Check>>): Map<string, CheckedRule[]> {
  const checksOn = new Map<string, CheckedRule[]>();
  const ruleList = [...model.kernel_rules.map((r) => ({ id: r.id, owner: r.owner, sources: r.sources, severity: "error" as const })), ...model.rules.map((r) => ({ id: r.ir, owner: r.owner, sources: [r.ir], severity: severityOf(r.level) }))];
  for (const r of ruleList) {
    if (!ruleChecks[r.id]) continue;
    for (const t of checkedTypes(model, r.owner)) checksOn.set(t, [...(checksOn.get(t) ?? []), { id: r.id, sources: r.sources, severity: r.severity }]);
  }
  return checksOn;
}

/** How a copy of a range template compares its bounds, by the copy's name: as the type its `T` names does, numbers as numbers and timestamps as instants. */
export function copyOrders(model: ModelDoc): (name: string) => Order | undefined {
  const types = new Map(model.types.map((t) => [t.name, t]));
  const orders = ordersOf(model.types);
  return (name) => {
    const t = types.get(name);
    const arg = t?.kind === "copy" ? t.of.arguments.T : undefined;
    return arg?.kind === "named" ? orders.get(arg.name) : undefined;
  };
}

/** What a payload's check finds: the schema's errors, the rules' violations, and the rules that can't decide without something the payload doesn't hold. */
export interface InstanceCheck {
  errors: { path: string; message: string }[];
  violations: { path: string; rule: string; message: string }[];
  undecided: { path: string; rule: string }[];
}

/**
 * A checker of payloads against one lock's emitted schemas, as the examples
 * gate checks an example: Ajv 2020, strict, with `format` asserted, and every
 * rule one payload decides on each value of the type it reads, found by the
 * same walk. Returns a function of a schema reference and a value.
 */
export function instanceChecker(model: ModelDoc, files: EmittedFile[], schemaDir: string, codes: ReadonlyMap<string, ReadonlySet<string | number>>, ruleChecks: Readonly<Record<string, Check>>): (ref: string, value: unknown) => InstanceCheck {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  installFormats(ajv);
  for (const f of withImports(files)) ajv.addSchema(f.schema);
  const walker = new Walker(model, withImports(files), schemaDir, ajv);
  const checksOn = checksByType(model, ruleChecks);
  const orderOf = copyOrders(model);
  return (ref, value) => {
    const validate = walker.validator(ref);
    const valid = validate(value) as boolean;
    const errors = valid ? [] : (validate.errors ?? []).map((e) => ({ path: e.instancePath, message: `${e.message ?? e.keyword}${e.keyword === "additionalProperties" ? ` "${String(e.params.additionalProperty)}"` : ""}` }));
    const violations: InstanceCheck["violations"] = [];
    const undecided: InstanceCheck["undecided"] = [];
    if (valid) {
      for (const i of walker.walk(ref, value, "", null, null).instances) {
        const bounds = orderOf(i.type);
        for (const r of checksOn.get(i.type) ?? []) {
          const result = ruleChecks[r.id]!(valueAt(value, i.path), { context: {}, part: false, codes, ...(bounds ? { order: bounds } : {}) });
          if (result === null) undecided.push({ path: i.path, rule: r.id });
          for (const v of result ?? []) violations.push({ path: i.path + v.path, rule: r.id, message: v.message });
        }
      }
    }
    return { errors, violations, undecided };
  };
}

export function checkExamples(input: {
  model: ModelDoc;
  files: EmittedFile[];
  schemaDir: string;
  examples: ModelExample[];
  values: Map<string, Loaded>;
  codes: ReadonlyMap<string, ReadonlySet<string | number>>;
  /** Every check a rule of the lock may have: the kernel's, the constructors', and the spec's (`checksOf`). */
  ruleChecks: Readonly<Record<string, Check>>;
}): {
  failures: Failure[];
  cases: ExampleCase[];
  problems: string[];
  /** The rules' checks that ran on each example's values, and those that couldn't decide without something the example doesn't hold. */
  checks: { ran: number; undecided: Undecided[] };
} {
  const { model, files, schemaDir } = input;
  const problems: string[] = [];
  const checks = { ran: 0, undecided: [] as Undecided[] };
  const failures: Failure[] = [];
  const cases: ExampleCase[] = [];
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  installFormats(ajv);
  try {
    for (const f of withImports(files)) ajv.addSchema(f.schema);
  } catch (e) {
    return { failures, cases, problems: [`Ajv doesn't load the schemas: ${(e as Error).message}`], checks };
  }
  const walker = new Walker(model, withImports(files), schemaDir, ajv);
  const types = new Map(model.types.map((t) => [t.name, t]));
  const checksOn = checksByType(model, input.ruleChecks);
  const orderOf = copyOrders(model);
  for (const ex of input.examples) {
    const loaded = input.values.get(ex.id);
    if (!loaded) {
      problems.push(`${ex.id}: no value to validate`);
      continue;
    }
    if (!loaded.ok) {
      failures.push({ example: ex.id, path: "", kind: "load", value: null, message: loaded.problems.join("; "), elements: [] });
      continue;
    }
    const doc = types.get(ex.object);
    const docId = doc ? schemaIdOf(doc, schemaDir, baseOf(files, schemaDir)) : null;
    if (!doc || !docId) {
      problems.push(`${ex.id}: the schema emits no document "${ex.object}"`);
      continue;
    }
    // A whole example is validated as its document; a part, field by field, each against its property's schema.
    const targets: { at: string; ref: string; value: unknown; type: ModelType | null; property: string | null }[] = [];
    if (!ex.part) targets.push({ at: "", ref: docId, value: loaded.value, type: doc, property: null });
    else if (!isMap(loaded.value)) failures.push({ example: ex.id, path: "", kind: "invalid", value: loaded.value, message: `a part of ${ex.object} is a map of its fields`, elements: [ex.ir] });
    else {
      const props = "properties" in doc ? doc.properties : {};
      for (const [k, v] of Object.entries(loaded.value)) {
        if (!(k in props)) failures.push({ example: ex.id, path: `/${escape(k)}`, kind: "undefined_key", value: v, message: `${ex.object} has no property "${k}"`, elements: [ex.ir] });
        else targets.push({ at: `/${escape(k)}`, ref: `${docId}#/properties/${escape(k)}`, value: v, type: doc, property: k });
      }
    }
    for (const t of targets) {
      const validate = walker.validator(t.ref);
      const valid = validate(t.value) as boolean;
      cases.push({ example: ex.id, ref: t.ref, value: t.value, valid });
      const walk = walker.walk(t.ref, t.value, t.at, t.type, t.property);
      const points = new Map<string, { kind: Failure["kind"]; messages: string[] }>();
      const add = (path: string, kind: Failure["kind"], message: string) => {
        const p = points.get(path) ?? { kind, messages: [] };
        if (kind === "undefined_key") p.kind = kind;
        if (!p.messages.includes(message)) p.messages.push(message);
        points.set(path, p);
      };
      const errors = valid ? [] : (validate.errors ?? []);
      const unions = errors.filter((e) => e.keyword === "anyOf" || e.keyword === "oneOf").map((e) => t.at + e.instancePath);
      const outer = unions.filter((u) => !unions.some((o) => o !== u && within(u, o)));
      for (const e of errors) {
        const at = t.at + e.instancePath;
        const union = outer.find((u) => within(at, u));
        if (union !== undefined) {
          if (at === union && (e.keyword === "anyOf" || e.keyword === "oneOf")) add(union, "invalid", `matches no branch of its ${e.keyword}`);
          else add(union, "invalid", `${e.message ?? e.keyword}${e.keyword === "additionalProperties" ? ` "${String(e.params.additionalProperty)}"` : ""}`);
          continue;
        }
        if (e.keyword === "additionalProperties") add(`${at}/${escape(String(e.params.additionalProperty))}`, "undefined_key", "the object doesn't name the key");
        else add(at, "invalid", e.message ?? e.keyword);
      }
      for (const u of walk.undefinedKeys) add(u, "undefined_key", "an open object the model doesn't define the key of");
      for (const [path, p] of points) {
        failures.push({ example: ex.id, path, kind: p.kind, value: valueAt(t.value, path.slice(t.at.length)) ?? null, message: p.messages.join("; "), elements: walk.elementsAt(path) });
      }
      // Every rule one payload decides runs on each value of the type it reads (type rules § 11).
      for (const i of walk.instances) {
        const bounds = orderOf(i.type);
        for (const r of checksOn.get(i.type) ?? []) {
          const result = input.ruleChecks[r.id]!(valueAt(t.value, i.path.slice(t.at.length)), { context: {}, part: false, codes: input.codes, ...(bounds ? { order: bounds } : {}) });
          checks.ran++;
          if (result === null) checks.undecided.push({ example: ex.id, path: i.path, rule: r.id, elements: [...r.sources].sort() });
          for (const v of result ?? []) {
            const path = i.path + v.path;
            // A rule finding rests on the rule's elements and on those along the path from the value the rule reads to the location.
            const along = v.path.split("/").map((_, n, segs) => i.path + segs.slice(0, n + 1).join("/"));
            failures.push({ example: ex.id, path, kind: "rule", rule: r.id, severity: r.severity, value: valueAt(t.value, path.slice(t.at.length)) ?? null, message: v.message, elements: [...new Set([...along.flatMap((x) => walk.elementsAt(x)), ...r.sources])].sort() });
          }
        }
      }
    }
    // A code block shows part of a document, so the document's rules read the fields it holds, and leave undecided what turns on a field it leaves out.
    if (ex.part && isMap(loaded.value)) {
      for (const r of checksOn.get(ex.object) ?? []) {
        const result = input.ruleChecks[r.id]!(loaded.value, { context: {}, part: true, codes: input.codes });
        checks.ran++;
        if (result === null) checks.undecided.push({ example: ex.id, path: "", rule: r.id, elements: [...new Set([ex.ir, ...r.sources])].sort() });
        for (const v of result ?? []) {
          failures.push({ example: ex.id, path: v.path, kind: "rule", rule: r.id, severity: r.severity, value: valueAt(loaded.value, v.path) ?? null, message: v.message, elements: [...new Set([ex.ir, ...r.sources])].sort() });
        }
      }
    }
  }
  const order = (f: { example: string; path: string; rule?: string }) => `${f.example} ${f.path} ${f.rule ?? ""}`;
  failures.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  checks.undecided.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  return { failures, cases, problems, checks };
}

type Validate = ((v: unknown) => boolean) & { errors?: { keyword: string; instancePath: string; message?: string; params: Record<string, unknown> }[] | null };

/**
 * Walks an instance through the emitted schemas, following `$ref`s across
 * files. It records, at each location, the IR elements of the model types and
 * properties it reaches there, and it reports each key of an open object that
 * the object doesn't name. Inside a union it follows every branch for the
 * elements, but reports keys only in the branches that accept the value.
 */
class Walker {
  private readonly schemas = new Map<string, unknown>();
  private readonly typeAt = new Map<string, ModelType>();
  private readonly byName = new Map<string, ModelType>();
  private readonly validators = new Map<string, Validate>();

  constructor(
    model: ModelDoc,
    files: EmittedFile[],
    schemaDir: string,
    private readonly ajv: InstanceType<typeof Ajv2020>,
  ) {
    for (const f of files) this.schemas.set(String(f.schema.$id), f.schema);
    const base = baseOf(files, schemaDir);
    for (const t of model.types) {
      this.byName.set(t.name, t);
      const id = schemaIdOf(t, schemaDir, base);
      if (id) this.typeAt.set(id.includes("#") ? id : `${id}#`, t);
    }
  }

  validator(ref: string): Validate {
    let v = this.validators.get(ref);
    if (!v) {
      v = this.ajv.compile({ $ref: ref }) as Validate;
      this.validators.set(ref, v);
    }
    return v;
  }

  /** The elements of a copy's template that state the key `k`, a row such as `key:3.1:included[]` for `included`. */
  private rowOf(copy: Extract<ModelType, { kind: "copy" }>, k: string): string[] {
    const template = this.byName.get(copy.of.constructor);
    return (template?.sources ?? []).filter((id) => id.slice(id.lastIndexOf(":") + 1).replaceAll("[]", "") === k);
  }

  /** The schema node a reference names, and the reference in canonical form, `<file>#<pointer>`. */
  private resolve(ref: string, base: string): { key: string; node: unknown } {
    const url = new URL(ref, base);
    const file = url.href.replace(/#.*$/, "");
    const pointer = decodeURIComponent(url.hash.replace(/^#/, ""));
    let node: unknown = this.schemas.get(file);
    for (const seg of pointer === "" ? [] : pointer.slice(1).split("/").map(unescape)) node = isMap(node) ? node[seg] : undefined;
    return { key: `${file}#${pointer}`, node };
  }

  walk(ref: string, value: unknown, at: string, type: ModelType | null, property: string | null): { undefinedKeys: string[]; instances: { path: string; type: string }[]; elementsAt: (path: string) => string[] } {
    const elements = new Map<string, Set<string>>();
    const undefinedKeys: string[] = [];
    // The locations a model type's schema accepts, in the union branches that accept the value, for the rules' checks.
    const instances: { path: string; type: string }[] = [];
    const note = (path: string, sources: string[]) => {
      const s = elements.get(path) ?? new Set<string>();
      for (const x of sources) s.add(x);
      elements.set(path, s);
    };
    if (type && property !== null && "properties" in type) note(at, type.properties[property]?.sources ?? []);
    const visitNode = (key: string, node: unknown, x: unknown, path: string, flag: boolean, owner: ModelType | null): void => {
      if (!isMap(node)) return;
      const [file] = key.split("#");
      if (typeof node.$ref === "string") {
        const r = this.resolve(node.$ref, file!);
        const t = this.typeAt.get(r.key) ?? null;
        if (t) note(path, t.sources);
        if (t && flag && !instances.some((i) => i.path === path && i.type === t.name)) instances.push({ path, type: t.name });
        visitNode(r.key, r.node, x, path, flag, t);
        return;
      }
      for (const k of ["anyOf", "oneOf"] as const) {
        const branches = node[k];
        if (!Array.isArray(branches)) continue;
        branches.forEach((b, i) => {
          const bk = `${key}/${k}/${i}`;
          visitNode(bk, b, x, path, flag && (this.validator(bk)(x) as boolean), null);
        });
      }
      if (isMap(x) && (node.type === "object" || isMap(node.properties))) {
        const props = isMap(node.properties) ? node.properties : {};
        for (const [k, v] of Object.entries(x)) {
          const p = `${path}/${escape(k)}`;
          if (k in props) {
            if (owner && "properties" in owner) note(p, owner.properties[k]?.sources ?? []);
            // A copy's member is its template's: it rests on the row that states the key, as `included[]` on § 3.1's row,
            // and so does each item of a list member.
            const row = owner?.kind === "copy" ? this.rowOf(owner, k) : [];
            note(p, row);
            if (Array.isArray(v)) v.forEach((_, i) => note(`${p}/${i}`, row));
            visitNode(`${key}/properties/${escape(k)}`, props[k], v, p, flag, null);
          } else if (isMap(node.additionalProperties)) visitNode(`${key}/additionalProperties`, node.additionalProperties, v, p, flag, null);
          else if (node.additionalProperties !== false && flag) undefinedKeys.push(p);
        }
      }
      if (Array.isArray(x) && isMap(node.items)) x.forEach((v, i) => visitNode(`${key}/items`, node.items, v, `${path}/${i}`, flag, null));
      // A map's keys are values of its key type, so a key that type rejects rests on the type's elements, at the map.
      if (isMap(x) && isMap(node.propertyNames) && typeof node.propertyNames.$ref === "string") {
        const r = this.resolve(node.propertyNames.$ref, file!);
        const kt = this.typeAt.get(r.key);
        const valid = this.validator(`${key}/propertyNames`);
        if (kt && Object.keys(x).some((k) => !(valid(k) as boolean))) note(path, kt.sources);
      }
    };
    const root = this.resolve(ref, ref);
    const t = this.typeAt.get(root.key) ?? null;
    if (t) note(at, t.sources);
    if (t) instances.push({ path: at, type: t.name });
    visitNode(root.key, root.node, value, at, true, t ?? type);
    return {
      undefinedKeys,
      instances,
      // The elements of the deepest location at or above the path that the walk reached.
      elementsAt: (path: string) => {
        for (let p = path; ; p = p.slice(0, p.lastIndexOf("/"))) {
          const s = elements.get(p);
          if (s && s.size > 0) return [...s].sort();
          if (p === "") return [];
        }
      },
    };
  }
}

/** One recorded finding: a failure the gate expects, and why the example fails there. */
export interface Finding {
  example: string;
  path: string;
  kind: Failure["kind"];
  /** The rule a `rule` finding breaks. */
  rule?: string;
  /** `warning` for a rule finding of a SHOULD or SHOULD NOT rule; a finding without it is an error. */
  severity?: "warning";
  value: unknown;
  /** One decision per cause. */
  decisions: string[];
  reason: string;
  locks?: string[];
}

/** One recorded undecided check: a rule the example's values can't decide, the decision that says why, and the reason. */
export interface RecordedUndecided {
  example: string;
  path: string;
  rule: string;
  decisions: string[];
  reason: string;
  locks?: string[];
}

/**
 * How a finding's reason opens and what it says when a cause is a change we
 * propose (a `departure` record): the example follows the text, so the reason
 * never blames it.
 */
export const DEPARTURE_REASON = { opens: "The example follows the text", proposes: "We propose" } as const;

/** Wording that puts the fault on the example or the text, which a departure's finding can't use. */
const BLAME = /\bshould\b|\bwrong\b|\bmistake|\bplaceholder\b|\bis no\b|\bisn't a\b|\bwhich is neither\b/i;

/**
 * The reason a finding gives, against the kinds of the decisions it cites: a
 * finding of a departure opens with the departure template, proposes the
 * change, and uses no wording that blames the example; a finding of gaps only
 * says where the example disagrees with the text, so it doesn't open with the
 * template; and no finding cites both kinds, so each sits in one table of the
 * feedback.
 */
export function reasonProblems(f: Pick<Finding, "example" | "path" | "decisions" | "reason">, decisions: DecisionRecord[]): string[] {
  const where = `${f.example} ${f.path === "" ? "/" : f.path}`;
  const kinds = f.decisions.map((id) => decisions.find((d) => d.id === id)?.kind);
  const text = f.reason.replace(/\s+/g, " ").trim();
  // One finding sits in one of the feedback's two tables, so its reason speaks in one voice: a place that both
  // disagrees with the text and follows it but not a change we propose is two failures, each with its own causes.
  if (kinds.includes("departure") && kinds.includes("gap")) return [`${where}: cites a gap and a departure, so its reason can't both say where the example disagrees with the text and say that it follows the text; cite the causes of one kind, and record the other kind's failure apart`];
  if (kinds.includes("departure")) {
    const problems: string[] = [];
    if (!text.startsWith(DEPARTURE_REASON.opens)) problems.push(`${where}: a cause is a change we propose, so the reason opens "${DEPARTURE_REASON.opens}", and says what the example writes`);
    if (!text.includes(DEPARTURE_REASON.proposes)) problems.push(`${where}: a cause is a change we propose, so the reason says "${DEPARTURE_REASON.proposes}" and what`);
    const blame = BLAME.exec(text);
    if (blame) problems.push(`${where}: a cause is a change we propose, so the reason can't blame the example, as "${blame[0]}" does`);
    return problems;
  }
  return text.startsWith(DEPARTURE_REASON.opens) ? [`${where}: every cause is a gap, so the example disagrees with the text; say where, not "${DEPARTURE_REASON.opens}"`] : [];
}

export interface FindingsFile {
  format: 1;
  findings: Finding[];
  /** The checks the examples leave undecided, reviewed as the findings are. */
  undecided?: RecordedUndecided[];
  file: string;
}

export const FINDINGS_FILE = join("examples", "findings.yaml");
const FINDINGS_SCHEMA = join("examples", "findings.schema.json");

/** Loads and validates recorded findings, a spec's `examples/findings.yaml` (`FINDINGS_FILE` in its folder). */
export function loadFindings(file: string): FindingsFile {
  const doc = readYaml(file);
  const errors = compileSchema(join(REPO_ROOT, FINDINGS_SCHEMA))(doc);
  if (errors.length > 0) throw new Error(`${file}: not a valid findings file: ${errors.join("; ")}`);
  return { ...(doc as Omit<FindingsFile, "file">), file };
}

/** A finding's key: its example and location, and the rule a rule finding breaks, since one location can fail its schema and a rule. */
const keyOf = (f: { example: string; path: string; rule?: string }) => `${f.example} ${f.path === "" ? "/" : f.path}${f.rule ? ` (${f.rule})` : ""}`;

/**
 * Checks one lock's failures against the record: every failure is recorded,
 * with its kind and the example's value as they are now, and cites a
 * decision that covers one of the elements its location rests on; every
 * recorded finding in the lock's scope still occurs, so a fixed example
 * fails the gate until its finding is removed.
 */
export function checkFindings(failures: Failure[], recorded: FindingsFile, lock: string, decisions: DecisionRecord[]): string[] {
  const problems: string[] = [];
  const scope = recorded.findings.filter((f) => inScope(f.locks, lock));
  const seen = new Set<string>();
  for (const r of scope) {
    if (seen.has(keyOf(r))) problems.push(`${recorded.file}: ${keyOf(r)} is recorded twice on lock "${lock}"`);
    seen.add(keyOf(r));
  }
  for (const f of failures) {
    const r = scope.find((x) => keyOf(x) === keyOf(f));
    if (!r) {
      problems.push(`${keyOf(f)}: ${f.kind} on lock "${lock}": ${f.message} (value ${JSON.stringify(f.value)}); fix the mapping, or record the finding with the decision it rests on`);
      continue;
    }
    if (r.kind !== f.kind || canonicalJson(r.value) !== canonicalJson(f.value)) {
      problems.push(`${recorded.file}: ${keyOf(f)} changed on lock "${lock}": now ${f.kind} with value ${JSON.stringify(f.value)}; review it and record the current failure`);
    }
    // A SHOULD rule's finding is a warning, recorded as one, and a MUST rule's is an error, so the feedback counts them apart.
    if ((f.severity === "warning") !== (r.severity === "warning")) {
      problems.push(`${recorded.file}: ${keyOf(f)} is ${f.severity === "warning" ? "a warning, a SHOULD rule's" : "an error"} on lock "${lock}"; record it ${f.severity === "warning" ? "with severity: warning" : "without a severity"}`);
    }
    for (const id of r.decisions) {
      const decision = decisions.find((d) => d.id === id);
      if (!decision) problems.push(`${recorded.file}: ${keyOf(f)} cites "${id}", which is no decision record`);
      else if (!stands(decision)) problems.push(`${recorded.file}: ${keyOf(f)} cites "${id}", which is ${retired(decision)}`);
      else if (f.elements.length > 0 && !decision.covers.some((c) => inScope(c.locks, lock) && f.elements.includes(c.ir))) {
        problems.push(`${recorded.file}: ${keyOf(f)} cites ${id}, which covers none of ${f.elements.join(", ")} on lock "${lock}"`);
      }
    }
    for (const p of reasonProblems(r, decisions)) problems.push(`${recorded.file}: ${p}`);
  }
  for (const r of scope) {
    if (!failures.some((f) => keyOf(f) === keyOf(r))) problems.push(`${recorded.file}: ${keyOf(r)} no longer fails on lock "${lock}"; remove the finding`);
  }
  return problems;
}

/**
 * Checks one lock's undecided checks against the record, as findings are
 * checked: every check the examples leave undecided is recorded, with a
 * decision that covers one of the elements its rule rests on, and every
 * recorded one in the lock's scope still occurs.
 */
export function checkUndecided(undecided: Undecided[], recorded: FindingsFile, lock: string, decisions: DecisionRecord[]): string[] {
  const problems: string[] = [];
  const scope = (recorded.undecided ?? []).filter((u) => inScope(u.locks, lock));
  const keyOf = (u: { example: string; path: string; rule: string }) => `${u.example} ${u.path === "" ? "/" : u.path} (${u.rule})`;
  const seen = new Set<string>();
  for (const r of scope) {
    if (seen.has(keyOf(r))) problems.push(`${recorded.file}: undecided ${keyOf(r)} is recorded twice on lock "${lock}"`);
    seen.add(keyOf(r));
  }
  for (const u of undecided) {
    const r = scope.find((x) => keyOf(x) === keyOf(u));
    if (!r) {
      problems.push(`${keyOf(u)}: undecided on lock "${lock}": the check turns on what the example leaves out; record it under undecided with the decision that says why`);
      continue;
    }
    for (const id of r.decisions) {
      const decision = decisions.find((d) => d.id === id);
      if (!decision) problems.push(`${recorded.file}: undecided ${keyOf(u)} cites "${id}", which is no decision record`);
      else if (!stands(decision)) problems.push(`${recorded.file}: undecided ${keyOf(u)} cites "${id}", which is ${retired(decision)}`);
      else if (!decision.covers.some((c) => inScope(c.locks, lock) && u.elements.includes(c.ir))) problems.push(`${recorded.file}: undecided ${keyOf(u)} cites ${id}, which covers none of ${u.elements.join(", ")} on lock "${lock}"`);
    }
  }
  for (const r of scope) if (!undecided.some((u) => keyOf(u) === keyOf(r))) problems.push(`${recorded.file}: undecided ${keyOf(r)} is decided now on lock "${lock}"; remove it`);
  return problems;
}

/** What `tools/oracle/instance_verdicts.py` reports. */
export interface OracleInstanceRun {
  jsonschema: string;
  referencing: string;
  verdicts: boolean[];
}

/** Runs cases through the oracle. Tests replace it; the gate uses `spawnInstanceOracle`. */
export type InstanceOracle = (files: EmittedFile[], cases: ExampleCase[]) => OracleInstanceRun;

export function spawnInstanceOracle(root: string): InstanceOracle {
  const python = join(root, ".venv", "bin", "python");
  return (files, cases) => {
    if (!existsSync(python)) throw new Error("no oracle venv at .venv; run: npm run setup:oracle");
    const input = JSON.stringify({ schemas: withImports(files).map((f) => f.schema), cases: cases.map((c) => ({ ref: c.ref, value: c.value })) });
    const r = spawnWithInput(python, ["-I", join(root, "tools", "oracle", "instance_verdicts.py")], input, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw new Error(`${python}: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`tools/oracle/instance_verdicts.py failed: ${(r.stderr || r.stdout).trim()}`);
    return JSON.parse(r.stdout) as OracleInstanceRun;
  };
}

/**
 * The cross-check: the reference oracle, as tools/oracle/requirements.txt
 * pins it, reaches Ajv's verdict on every case. Returns the problems and the
 * versions it ran.
 */
export function oracleAgrees(root: string, files: EmittedFile[], cases: ExampleCase[], oracle: InstanceOracle = spawnInstanceOracle(root)): { problems: string[]; note: string } {
  let run: OracleInstanceRun;
  try {
    run = oracle(files, cases);
  } catch (e) {
    return { problems: [(e as Error).message], note: "" };
  }
  const problems: string[] = [];
  const pinned = pinnedOracle(root);
  if (run.jsonschema !== pinned) problems.push(`the oracle is jsonschema ${run.jsonschema}, but ${ORACLE_REQUIREMENTS} pins ${pinned}; run: npm run setup:oracle`);
  if (run.verdicts.length !== cases.length) return { problems: [...problems, `the oracle gave ${run.verdicts.length} verdicts for ${cases.length} cases`], note: "" };
  cases.forEach((c, i) => {
    if (run.verdicts[i] !== c.valid) problems.push(`${c.example} against ${c.ref}: Ajv says ${c.valid ? "valid" : "invalid"}, the oracle ${run.verdicts[i] ? "valid" : "invalid"}`);
  });
  return { problems, note: `${cases.length} cases; python-jsonschema ${run.jsonschema}, referencing ${run.referencing}` };
}
