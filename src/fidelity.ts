/**
 * The fidelity gate: an oracle built from the IR alone, which says what the
 * specification states, checked against what the emitted schemas and rules
 * accept.
 *
 * The coverage gate proves that every element was placed somewhere. This
 * gate proves that the schema still says what the element says. It reads,
 * from the IR and nothing else, every constraint the extractor gives in a
 * form that needs no judgment:
 *
 * - `required` and `optional`: a field description's leading REQUIRED or
 *   OPTIONAL sentence, and a key table's Required cell, RECOMMENDED read as
 *   optional. The § 3.1 key table applies to every field its introducing
 *   statement names by marker ("Every field marked `selectable` MUST
 *   declare:").
 * - `conditional`: REQUIRED when a member equals a value, written
 *   "`a = b`", "`a` is `b`", or "for <what> (`a` `b`, or …)". The member
 *   `a` is a sibling, or a member of an object the path runs through. The
 *   member is required while the condition holds, and may be absent while
 *   `a` holds each other value its row lists. A value the parenthesis names
 *   with more prose, as "video on `channel` `ctv`", is neither side. Or
 *   REQUIRED with members, "REQUIRED with either" after a sentence that
 *   names two, as `time_zone` is with `daypart` or `frequency_cap.period`:
 *   each path runs from the member's own object, the member is required
 *   while any of them is present, and may be absent while none is, or while
 *   a path's first member is present without the rest of it.
 * - `type`: a field row's Type cell, as the JSON type its values have and,
 *   for a timestamp or an offset, a string of its format.
 * - `values`: a value list in a table cell or an inline object; a sentence
 *   "`x` is `a` or `b`", whose values, with "per <key>", are each entry's of
 *   a map; and an enumeration of a named list's codes, "One value from List:
 *   … Label (n), …", which "such as" leaves open; and a sentence that gives
 *   members the codes of named lists, "`a` and `b` take any code in List: X
 *   and List: Y respectively", each list's codes as `kernel/lists.yaml` holds
 *   them, and every code from a list's first vendor code up where the list
 *   reserves vendor codes, as List: API Frameworks reserves 500 and up: the
 *   first vendor code is accepted and the code below it rejected. The lists
 *   are the one input the oracle reads beside the IR: the codes another
 *   standard keeps, which the text names but doesn't write. Each listed value
 *   is accepted, and an unlisted one rejected, unless the text leaves the
 *   list open ("and other …", "such as").
 * - `namespaced`: a row whose options are namespaced, "`available[]` of
 *   registry format ids namespaced by channel (`display/300x250`, …)": each
 *   example is an option, and each example without its namespace, the part
 *   after its first `/`, such as `300x250`, isn't. A row that says
 *   "namespaced" in any other way is listed as unread.
 * - `contains`: a MUST statement that a representation contains the paths
 *   the next block lists, and a following block that continues it with
 *   "plus": each path is required.
 * - `optional`, too, for a MUST statement that a representation gives
 *   "whichever of" the paths its own block lists the full record declares:
 *   each step of each path may be present or absent.
 * - `member`: each member an inline object in a row writes is a member of
 *   the object at the row's place, so a value with it is accepted.
 * - `empty`: a "MAY be empty" statement in a key row: the empty list is
 *   accepted.
 * - `example`: a YAML block the text writes under a field's name: each
 *   member's value as the block writes it is accepted, unless it holds a
 *   `<placeholder>`.
 * - `default`: a value a row states the member takes when it is absent, as
 *   the Deals API's "int, default 2": the schema's node for the member
 *   carries it as its `default`, and a value of the member equal to it is
 *   accepted. A reader that reads a row's Type cell as stating no default
 *   gives the form with no value: the node carries no `default`.
 *
 * Each constraint gets a valid and an invalid vector, an optional member
 * two valid ones, built from a valid baseline of the root it sits in, and
 * the emitted schema must give each its expected verdict. Every
 * disagreement fails, unless a decision of kind `departure` covers that
 * exact element on the lock with the constraint's form under that cover's
 * `departs`, or the caller lists the constraint as left to a rule: then the
 * rule must apply to an object on the constraint's path and give an invalid
 * vector the constraint rejects, or the disagreement fails still.
 *
 * Each list of paths, a `contains` list or a "whichever of" list, is a
 * projection too: each object a listed path steps into, below the root,
 * holds only the members the list's paths name there.
 *
 * The oracle reads no mapping entry and no decision to form its
 * expectations, with one exception: a path a decision reads from an item a
 * list writes in prose, as D-028 reads "property names" as
 * `properties.available[].name`, joins that list's projection, so the
 * objects it steps into hold only what it names. It states no presence,
 * since the text names no member. A reading could widen a projection, since
 * each path it adds lets the objects it steps into hold one more member, so
 * the oracle accepts one only when it names a prose item the list writes and
 * starts at a field none of the list's code paths names; it refuses any
 * other, and the gate fails on it. It finds a path's
 * root by the field row's owner (the `proposal` or `line_item` document)
 * or, for a list, as the type the model places the list in, and follows
 * the path through the emitted schemas. The constraint forms it can't read yet are counted and
 * listed, never skipped silently, and so is every closed vocabulary of the
 * model that no value list the oracle reads reaches.
 */
import { withImports } from "./imports.ts";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { canonicalJson } from "./canonical.ts";
import { baselines, Validators, type Baselines } from "./corpus.ts";
import { baseOf, type EmittedFile, schemaIdOf } from "./emit.ts";
import { installFormats } from "./formats.ts";
import type { PathSegment } from "./grammar/path.ts";
import type { TypeExpr } from "./grammar/type-expr.ts";
import type { Field, SpecIR } from "./ir-types.ts";
import type { Kernel } from "./kernel.ts";
import type { Lists } from "./lists.ts";
import { conceptOfType } from "./domains.ts";
import { pascalField } from "./constructors.ts";
import { decisionsOf, inScope, type DecisionRecord, type MappingFile, stands } from "./mapping.ts";
import type { ModelDoc } from "./model.ts";
import type { Rule, RulesDoc } from "./rules.ts";

type Schema = Record<string, unknown>;
const isMap = (v: unknown): v is Schema => v !== null && typeof v === "object" && !Array.isArray(v);

/** The forms the oracle reads. */
export const FORMS = ["required", "optional", "conditional", "type", "values", "namespaced", "contains", "member", "empty", "example", "default"] as const;
export type Form = (typeof FORMS)[number];

/** Where a constraint sits: a root, then the path to the object that holds the member, then the member. */
export interface SpecLocation {
  /** A document by its field rows' owner, or the type the model places an identifier list in. */
  root: { owner: string } | { list: string };
  /** The path from the root to the object that holds `member`. */
  path: PathSegment[];
  member: PathSegment;
}

export type Expectation =
  | { form: "required" | "optional" | "contains" | "member" | "empty" }
  /** `up` is how many objects above the member's own the condition's member sits: 0 for a sibling. */
  | { form: "conditional"; when: { member: string; value: unknown; up: number }; otherwise: unknown[] }
  /** Required with any member a path names, from the member's own object: `[["daypart"], ["frequency_cap", "period"]]`. */
  | { form: "conditional"; with: string[][] }
  | { form: "type"; type: TypeExpr }
  /** `items`: each value is an item of a list; `entries`: each value is an entry's of a map. */
  /** `vendor`: the first code a named list reserves for vendors, so every integer from it up is listed too. */
  | { form: "values"; values: unknown[]; open: boolean; items: boolean; entries?: boolean; vendor?: number }
  /** Each example is a value, and each example without its namespace, the part after its first `/`, isn't. */
  | { form: "namespaced"; examples: string[]; items: boolean }
  | { form: "example"; value: unknown }
  /** The value a row states the member takes when it is absent, which the schema writes as the member's `default`; with no `value`, the row states none, and the schema writes none. */
  | { form: "default"; value?: unknown };

/** One constraint the specification states, as the oracle reads it from the IR. */
export type SpecConstraint = {
  /** `<element>#<form>@<path>`. */
  id: string;
  /** The IR element the constraint is read from, which a departure must cover. */
  element: string;
  text: string;
  at: SpecLocation;
} & Expectation;


/** A list of paths read as a projection: the type the model places the list in holds the paths it lists, each step projected to them. */
export interface Projection {
  list: string;
  /** The MUST statement that introduces the list. */
  text: string;
  /**
   * The paths the list writes as code, and the paths a decision reads from
   * an item it writes in prose: `required` at each step under a MUST-contain
   * statement, `optional` at each step under a "whichever of" one, and
   * `kept`, the presence the full record gives each step, for a decision's
   * reading, which names the decision.
   */
  paths: { segments: PathSegment[]; presence: "required" | "optional" | "kept"; decision?: string }[];
}

/** The paths a decision reads from one item a list writes in prose, as a profile's mapping entry gives them under `reads`. */
export interface Reading {
  list: string;
  decision: string;
  /** The prose item the paths read, as the list writes it, such as "property names". */
  item: string;
  paths: string[];
}

/** The readings the profile entries of the mappings give on a lock: each entry's `reads`, with the decision its source cites. */
export function readingsOf(mappings: MappingFile[], lock: string): Reading[] {
  return mappings.flatMap((m) =>
    m.entries.flatMap((e) =>
      e.as.role === "profile" && inScope(e.locks, lock) ? (e.as.reads ?? []).map((r) => ({ list: e.ir, decision: decisionsOf(e.source).join(", "), item: r.item, paths: r.paths })) : [],
    ),
  );
}

/** A reading the oracle refuses, since it reads no prose item of a projection's list or would widen what a code path projects. */
export interface Refused {
  list: string;
  decision: string;
  item: string;
  /** The path refused, or none when the whole reading is. */
  path?: string;
  why: string;
}

/** An IR element in a constraint form the oracle can't read yet. */
export interface Unread {
  element: string;
  form: string;
  text: string;
}

/** A statement the oracle reads through another element's constraint: a row's presence it restates, or a MUST-contain list it introduces. */
export interface Restated {
  element: string;
  constraint: string;
}

export const pathText = (l: SpecLocation): string => {
  const root = "owner" in l.root ? l.root.owner : l.root.list;
  const seg = (s: PathSegment) => `${s.name}${s.array ? "[]" : ""}`;
  return [root, ...l.path.map(seg), seg(l.member)].join(".");
};

// Checking the schemas -------------------------------------------------------

export interface Disagreement {
  constraint: string;
  element: string;
  form: Form;
  path: string;
  /** What the oracle expected and what the schema did. */
  detail: string;
}

export interface FidelityResult {
  constraints: SpecConstraint[];
  unread: Unread[];
  restated: Restated[];
  /** Vectors checked, by form. */
  vectors: Record<string, number>;
  /** Disagreements no departure covers and no listed rule carries: each fails the gate, unless the caller expects it. */
  disagreements: Disagreement[];
  /** Disagreements a departure covers, with the departure and its status. */
  departed: (Disagreement & { decision: string; status: string })[];
  /** Invalid vectors the schema accepts that a listed rule carries: the rule applies on the path and gives such an invalid vector. */
  ruled: (Disagreement & { rule: string })[];
  /** The specification's own code lists the oracle read, where it has any. */
  lists?: number;
}

/**
 * A code list the specification writes, read from its rows alone: the values
 * a value of the list may be, such as each code and the first of a vendor
 * range, and values it may not be, such as a code no row names. The oracle
 * finds the list's type as the type the model places its rows in, and checks
 * each value against that type's schema.
 */
export interface ListConstraint {
  id: string;
  /** The list's first row, which a departure would cover. */
  element: string;
  /** Every row of the list. */
  rows: string[];
  valid: { value: unknown; why: string }[];
  invalid: { value: unknown; why: string }[];
  /** Rows whose value the reader can't read, which fail the gate rather than drop out of the vectors. */
  unreadable?: { row: string; value: string }[];
}

/** A constraint the caller lists as left to a rule, because the schema can't state it. */
export interface RuledEntry {
  constraint: string;
  rule: string;
}

export interface FidelityInput {
  ir: SpecIR;
  lock: string;
  model: ModelDoc;
  files: EmittedFile[];
  kernel: Kernel;
  rules: RulesDoc;
  decisions: DecisionRecord[];
  /** The paths a decision reads from a list's prose items on this lock (`readingsOf`), which join the list's projection. */
  readings: Reading[];
  schemaDir: string;
  /** The constraints left to a rule on this lock. Nothing else lets an invalid vector the schema accepts pass. */
  ruled?: RuledEntry[];
  /** The specification's readers of its IR and its stated types (`SpecPlugin.fidelity`). */
  readers: ConstraintReader;
}

/**
 * A specification's readers for the oracle: every constraint its IR states
 * in a form that needs no judgment, and what each type its type cells state
 * accepts. OpenProposal's are in src/specs/openproposal/fidelity-readers.ts.
 */
export interface ConstraintReader {
  readConstraints(ir: SpecIR, lists?: Lists, readings?: Reading[]): { constraints: SpecConstraint[]; unread: Unread[]; restated: Restated[]; projections: Projection[]; refused: Refused[] };
  /** A specification's own code lists, each a value in its own right, as AdCOM's are: the values each list's rows accept and rule out. */
  readLists?(ir: SpecIR): ListConstraint[];
  /** Whether a value has the JSON type a stated type names; a stated type says nothing about the value's range. */
  hasStatedType(v: unknown, t: TypeExpr): boolean;
  /** Values that a stated type rules out. */
  wrongValues(t: TypeExpr): unknown[];
  /** Values that a stated type accepts. */
  rightValues(t: TypeExpr): unknown[];
}

/** A schema node in an emitted file: the node, the file's `$id`, and the JSON pointer to it. */
interface At {
  node: Schema;
  file: string;
  pointer: string;
}

/** The JSON type a value has, as JSON Schema names it. */
export const jsonType = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

/** A word no value list lists, for an invalid value; an open vocabulary takes only a namespaced term beside its core terms. */
const UNLISTED = "unlisted_value";

/**
 * Whether a payload of the constraint's root is one the constraint rules
 * out: on some path through it, where every object on the way is present,
 * the member is absent where it is required or while its condition holds,
 * of a JSON type the stated type doesn't have, or a value no closed list
 * lists. A rule that carries a constraint must give such a payload.
 */
export function violates(c: SpecConstraint, payload: unknown, readers: Pick<ConstraintReader, "hasStatedType">): boolean {
  const steps = [...c.at.path, c.at.member];
  /** Each chain of objects from the root to the one that holds the member. */
  const chains = (v: unknown, i: number, chain: Schema[]): Schema[][] => {
    if (!isMap(v)) return [];
    if (i === steps.length - 1) return [[...chain, v]];
    const next = v[steps[i]!.name];
    const items = Array.isArray(next) ? next : next === undefined ? [] : [next];
    return items.flatMap((x) => chains(x, i + 1, [...chain, v]));
  };
  const name = c.at.member.name;
  return chains(payload, 0, []).some((chain) => {
    const o = chain.at(-1)!;
    switch (c.form) {
      case "required":
      case "contains":
        return !(name in o);
      case "conditional": {
        if ("with" in c) {
          const holds = (v: unknown, path: string[]): boolean => path.length === 0 || (isMap(v) && path[0]! in v && holds(v[path[0]!], path.slice(1)));
          return c.with.some((path) => holds(o, path)) && !(name in o);
        }
        const holder = chain[chain.length - 1 - c.when.up];
        return holder !== undefined && canonicalJson(holder[c.when.member]) === canonicalJson(c.when.value) && !(name in o);
      }
      case "type":
        return name in o && !readers.hasStatedType(o[name], c.type);
      case "values": {
        if (c.open || !(name in o)) return false;
        const x = o[name];
        const values = c.entries && isMap(x) ? Object.values(x) : c.items && Array.isArray(x) ? x : [x];
        const vendor = (y: unknown) => c.vendor !== undefined && Number.isInteger(y) && (y as number) >= c.vendor;
        return values.some((y) => !vendor(y) && !c.values.some((w) => canonicalJson(w) === canonicalJson(y)));
      }
      default:
        return false;
    }
  });
}

/**
 * Checks every constraint the IR states against the emitted schemas and the
 * rules of one lock.
 */
export function checkFidelity(input: FidelityInput): FidelityResult & { problems: string[] } {
  const { ir, lock, model, files, kernel, rules, decisions, readings, schemaDir, readers } = input;
  const { constraints, unread: unreadIr, restated, projections, refused } = readers.readConstraints(ir, kernel.lists, readings);
  const unread = [...unreadIr];
  const v = new Validators(files);
  const make: Baselines = baselines(model, v, kernel, schemaDir);
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
  installFormats(ajv);
  for (const f of withImports(files)) ajv.addSchema(f.schema);
  const validate = (id: string, value: unknown): ErrorObject[] | null => {
    const fn = ajv.getSchema(id);
    if (!fn) throw new Error(`no schema has the $id ${id}`);
    return fn(value) ? null : (fn.errors ?? []);
  };
  const problems: string[] = [];

  // A reading the oracle refuses fails.
  for (const r of refused) problems.push(`${r.list}#reading@${r.path ?? r.item}: ${r.decision} reads the prose item "${r.item}"${r.path ? ` as "${r.path}"` : ""}, but ${r.why}; read only a field none of the list's code paths names, from a prose item the list writes`);

  // A departure excuses a disagreement only on an element it covers on the lock, and only in a form that cover lists under `departs`.
  // A proposed departure excuses too, since none is accepted yet; the gate's line names each with its status.
  const departures = decisions.filter((d) => d.kind === "departure" && stands(d));
  const departureOf = (element: string, form: Form) => departures.find((d) => d.covers.some((c) => c.ir === element && inScope(c.locks, lock) && (c.departs ?? []).includes(form)));
  const ruledOf = new Map((input.ruled ?? []).map((r) => [r.constraint, r.rule]));
  const ruleById = new Map(rules.rules.map((r) => [r.id, r]));

  const types = new Map(model.types.map((t) => [t.name, t]));
  /** The model type whose schema a node is, by `$id` and fragment. */
  const typeAtId = new Map(model.types.flatMap((t) => {
    const id = schemaIdOf(t, schemaDir, baseOf(files, schemaDir));
    return id === null ? [] : [[id.includes("#") ? id : `${id}#`, t.name] as const];
  }));
  const typeOfAt = (at: At) => typeAtId.get(`${at.file}#${at.pointer}`);
  const rootOf = (root: SpecLocation["root"]): At | string => {
    let id: string | null = null;
    if ("owner" in root) {
      // A document is named after its field rows' owner, as the profile's documents are (src/profile.ts).
      const name = pascalField(root.owner);
      const t = types.get(name);
      id = t ? schemaIdOf(t, schemaDir, baseOf(files, schemaDir)) : null;
      if (id === null) return `no ${name} document on the lock`;
    } else {
      const t = model.types.find((x) => x.sources.includes(root.list));
      id = t ? schemaIdOf(t, schemaDir, baseOf(files, schemaDir)) : null;
      if (id === null) return `no emitted type projects the list ${root.list}`;
    }
    return { ...v.node(id), pointer: id.split("#")[1] ?? "" };
  };

  /** Follows `$ref`s to the node they name. */
  const deref = (at: At): At => {
    let cur = at;
    for (let i = 0; typeof cur.node.$ref === "string"; i++) {
      if (i > 32) throw new Error("a $ref chain too long");
      const id = new URL(cur.node.$ref as string, cur.file).href;
      const { node, file } = v.node(id);
      cur = { node, file, pointer: id.split("#")[1] ?? "" };
    }
    return cur;
  };
  const child = (at: At, ...keys: string[]): At => {
    let node: unknown = at.node;
    for (const k of keys) node = Array.isArray(node) ? node[Number(k)] : isMap(node) ? node[k] : undefined;
    if (!isMap(node)) throw new Error(`no schema at ${at.pointer}/${keys.join("/")}`);
    return { node, file: at.file, pointer: `${at.pointer}/${keys.join("/")}` };
  };
  /** The object that has a member: the node itself, or the first `anyOf` branch that does. */
  const objectWith = (at: At, name: string): At | null => {
    const d = deref(at);
    if (isMap(d.node.properties) && name in d.node.properties) return d;
    if (Array.isArray(d.node.anyOf)) {
      for (let i = 0; i < d.node.anyOf.length; i++) {
        const found = objectWith(child(d, "anyOf", String(i)), name);
        if (found) return found;
      }
    }
    return null;
  };

  /** Each object on the way from the root to the member, with the member it holds. */
  interface Step {
    object: At;
    member: PathSegment;
  }
  const resolve = (l: SpecLocation): Step[] | string => {
    const root = rootOf(l.root);
    if (typeof root === "string") return root;
    const steps: Step[] = [];
    let here: At = root;
    const all = [...l.path, l.member];
    for (const [i, s] of all.entries()) {
      const object = objectWith(here, s.name);
      if (!object) return `the schema has no member "${s.name}" at ${steps.map((x) => x.member.name).join(".") || "the root"}`;
      let next = deref(child(object, "properties", s.name));
      const list = next.node.type === "array" && isMap(next.node.items);
      if (s.array && !list) return `the schema's "${s.name}" isn't a list`;
      // A path the text writes without "[]" through a list, such as `pricing.cost_method`, names the member of each item.
      const through = list && (s.array || i < all.length - 1);
      steps.push({ object, member: { name: s.name, array: through } });
      if (through) next = child(next, "items");
      here = next;
    }
    return steps;
  };

  /** A valid instance of the root with every step's member present, the innermost object given by `inner`, and an outer object `pins` holds members fixed in. */
  const embed = (steps: Step[], inner: Schema, pins: Record<number, Record<string, unknown>> = {}): unknown => {
    let value: unknown = inner;
    for (let i = steps.length - 2; i >= 0; i--) {
      const s = steps[i]!;
      // The inner value is pinned, so a member the outer object requires with it, such as a time zone with a frequency cap's
      // period, is there.
      value = make.build(s.object.node, s.object.file, ["properties", s.member.name], [], { ...(pins[i] ?? {}), [s.member.name]: s.member.array ? [value] : value }) as Schema;
    }
    return value;
  };
  /** The innermost object with its member present, and with an item in it where the member is a list. */
  const innermost = (steps: Step[], pin: Record<string, unknown> = {}): Schema => {
    const s = steps.at(-1)!;
    const member = deref(child(s.object, "properties", s.member.name));
    const list = member.node.type === "array" && isMap(member.node.items) && child(s.object, "properties", s.member.name).node.$ref === undefined;
    return make.build(s.object.node, s.object.file, ["properties", s.member.name, ...(list && !(s.member.name in pin) ? ["items"] : [])], [], pin) as Schema;
  };
  const rootId = (steps: Step[]) => `${steps[0]!.object.file}#${steps[0]!.object.pointer}`;

  /** Whether a rule carries a constraint: it applies to an object on the constraint's path, and an invalid vector of the root's type is one the constraint rules out. */
  const carries = (rule: Rule, c: SpecConstraint, steps: Step[]): string | null => {
    const on = steps.map((s) => `${typeOfAt(s.object) ?? "?"}.${s.member.name}`);
    if (!rule.applies_to.some((a) => on.includes(a))) return `${rule.id} applies to ${rule.applies_to.join(", ")}, none of ${on.join(", ")} on the constraint's path`;
    const rootType = typeOfAt(steps[0]!.object);
    if (rule.vectors.type !== rootType) return `${rule.id}'s vectors are of ${rule.vectors.type ?? "no type"}, not ${rootType ?? "the root"}`;
    const shown = rule.vectors.invalid.some((x) => "value" in x && violates(c, (x as { value: unknown }).value, readers));
    return shown ? null : `no invalid vector of ${rule.id} is a payload the constraint rules out`;
  };

  const counts: Record<string, number> = {};
  const disagreements: Disagreement[] = [];
  const departed: FidelityResult["departed"] = [];
  const ruled: FidelityResult["ruled"] = [];
  /** The vocabularies a closed value list reaches, by `$id` and fragment. */
  const reached = new Set<string>();

  for (const c of constraints) {
    const base = { constraint: c.id, element: c.element, form: c.form, path: pathText(c.at) };
    let steps: Step[] | string = resolve(c.at);
    const disagree = (detail: string, invalidAccepted: boolean) => {
      const d = { ...base, detail };
      const decision = departureOf(c.element, c.form);
      const rule = invalidAccepted ? ruledOf.get(c.id) : undefined;
      if (decision !== undefined) {
        departed.push({ ...d, decision: decision.id, status: decision.status });
        return;
      }
      if (rule !== undefined && typeof steps !== "string") {
        const r = ruleById.get(rule);
        const why = r === undefined ? `no rule "${rule}" on the lock` : carries(r, c, steps);
        if (why === null) {
          ruled.push({ ...d, rule });
          return;
        }
        problems.push(`${c.id}: listed as left to ${rule}, but ${why}`);
      }
      disagreements.push(d);
    };
    if (typeof steps === "string") {
      disagree(steps, false);
      continue;
    }
    const st: Step[] = steps;
    const id = rootId(st);
    const name = c.at.member.name;
    /** Checks one vector: the root with the innermost object `inner`. */
    const expect = (valid: boolean, inner: Schema, what: string, pins: Record<number, Record<string, unknown>> = {}): boolean => {
      counts[c.form] = (counts[c.form] ?? 0) + 1;
      let errors: ErrorObject[] | null;
      try {
        errors = validate(id, embed(st, inner, pins));
      } catch (e) {
        problems.push(`${c.id}: ${(e as Error).message}`);
        return false;
      }
      if (valid && errors !== null) {
        disagree(`${what} is valid, but the schema rejects it: ${errors.slice(0, 2).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ")}`, false);
        return false;
      }
      if (!valid && errors === null) {
        disagree(`${what} is invalid, but the schema accepts it`, true);
        return false;
      }
      return true;
    };
    /** The innermost object, or null with a problem when no baseline can be built. */
    const tryInner = (pin: Record<string, unknown>, what: string): Schema | null => {
      try {
        return innermost(st, pin);
      } catch (e) {
        problems.push(`${c.id}: no baseline${what}: ${(e as Error).message}`);
        return null;
      }
    };
    const sibling = c.form === "conditional" && "when" in c && c.when.up === 0;
    const inner = tryInner(sibling && "when" in c ? { [c.when.member]: c.when.value } : {}, "");
    if (inner === null) continue;
    const without = (o: Schema) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== name));
    /** A value of the member at `at` that holds the rest of a path, each step built from its own schema, or null where the schema has no such member. */
    const along = (at: At, rest: string[]): unknown => {
      if (rest.length === 0) return make.build(at.node, at.file, [], []);
      const object = objectWith(at, rest[0]!);
      if (!object) return null;
      // The member's own node, `$ref` and all, so a primitive's value is its first valid vector.
      const value = along(child(object, "properties", rest[0]!), rest.slice(1));
      return value === null ? null : make.build(object.node, object.file, ["properties", rest[0]!], [], { [rest[0]!]: value });
    };
    /**
     * The vectors of a presence required with members: each path present, with
     * and without the member; a path's first member alone; and none. Each
     * path's vectors hold no other path's last member, so each trigger is
     * tested alone and a schema that requires the member with the wrong
     * trigger, or requires the other trigger too, disagrees.
     */
    const withVectors = (paths: string[][]) => {
      const holder = st.at(-1)!.object;
      /** `v` without the last member of path `p`, unless `p` leads to the trigger `own` itself. */
      const drop = (v: unknown, p: string[], own: string[]): unknown => {
        if (!isMap(v) || !(p[0]! in v)) return v;
        const on = own[0] === p[0];
        if (p.length === 1) return on ? v : Object.fromEntries(Object.entries(v).filter(([k]) => k !== p[0]));
        return { ...v, [p[0]!]: drop(v[p[0]!], p.slice(1), on ? own.slice(1) : []) };
      };
      /** An instance with every trigger but `own` dropped. */
      const alone = (o: Schema, own: string[]): Schema => paths.filter((p) => p.join(".") !== own.join(".")).reduce((x, p) => drop(x, p, own) as Schema, o);
      for (const path of paths) {
        const shown = path.join(".");
        let value: unknown;
        let bare: unknown;
        try {
          value = along(holder, path);
          bare = path.length > 1 ? along(holder, path.slice(0, 1)) : null;
        } catch (e) {
          problems.push(`${c.id}: no value with ${shown}: ${(e as Error).message}`);
          continue;
        }
        if (value === null) {
          disagree(`the schema has no member "${shown}" beside "${name}"`, false);
          continue;
        }
        const top = path[0]!;
        const built = tryInner({ [top]: (value as Schema)[top] }, ` with ${shown}`);
        if (built === null) continue;
        const present = alone(built, path);
        if (expect(true, present, `"${name}" present with ${shown}`)) expect(false, without(present), `"${name}" absent with ${shown}`);
        // The first member without the rest of the path: the condition doesn't hold.
        const first = isMap(bare) ? (bare as Schema)[top] : undefined;
        const rest = path.slice(1);
        const holdsRest = (v: unknown, p: string[]): boolean => p.length === 0 || (isMap(v) && p[0]! in v && holdsRest(v[p[0]!], p.slice(1)));
        if (first !== undefined && !holdsRest(first, rest)) {
          const alt = tryInner({ [top]: first }, ` with ${top} and no ${shown}`);
          if (alt !== null) expect(true, without(alone(alt, path)), `"${name}" absent with ${top} but no ${shown}`);
        }
      }
      const none = Object.fromEntries(Object.entries(inner).filter(([k]) => !paths.some((p) => p[0] === k)));
      expect(true, without(none), `"${name}" absent with none of ${paths.map((p) => p.join(".")).join(", ")}`);
    };
    switch (c.form) {
      case "required":
      case "contains":
        if (expect(true, inner, `"${name}" present`)) expect(false, without(inner), `"${name}" absent`);
        break;
      case "member":
        expect(true, inner, `"${name}" present`);
        break;
      case "optional":
        if (expect(true, inner, `"${name}" present`)) expect(true, without(inner), `"${name}" absent`);
        break;
      case "conditional": {
        if ("with" in c) {
          withVectors(c.with);
          break;
        }
        // The condition's member sits in the innermost object, or `up` objects above it.
        const at = st.length - 1 - c.when.up;
        const pinsFor = (x: unknown) => (sibling ? {} : { [at]: { [c.when.member]: x } });
        const when = `${c.when.member} = ${JSON.stringify(c.when.value)}`;
        if (expect(true, inner, `"${name}" present while ${when}`, pinsFor(c.when.value))) expect(false, without(inner), `"${name}" absent while ${when}`, pinsFor(c.when.value));
        for (const other of c.otherwise) {
          const alt = sibling ? tryInner({ [c.when.member]: other }, ` with ${c.when.member} = ${JSON.stringify(other)}`) : inner;
          if (alt === null) continue;
          expect(true, without(alt), `"${name}" absent while ${c.when.member} = ${JSON.stringify(other)}`, pinsFor(other));
        }
        break;
      }
      case "type": {
        const value = inner[name];
        counts.type = (counts.type ?? 0) + 1;
        if (!readers.hasStatedType(value, c.type)) {
          disagree(`the stated type is ${c.text}, but the schema's value for "${name}" is ${JSON.stringify(value)}, a JSON ${jsonType(value)}`, false);
          break;
        }
        if (!expect(true, inner, `"${name}" as ${JSON.stringify(value)}`)) break;
        for (const right of readers.rightValues(c.type)) expect(true, { ...inner, [name]: right }, `"${name}" as ${JSON.stringify(right)}, which is ${c.text},`);
        for (const wrong of readers.wrongValues(c.type)) expect(false, { ...inner, [name]: wrong }, `"${name}" as ${JSON.stringify(wrong)}, which isn't ${c.text},`);
        break;
      }
      case "values": {
        const memberAt = deref(child(st.at(-1)!.object, "properties", name));
        let key = "key";
        if (c.entries) {
          try {
            key = Object.keys(make.build(memberAt.node, memberAt.file, ["additionalProperties"], []) as Schema)[0] ?? key;
          } catch (e) {
            problems.push(`${c.id}: no entry to give a value: ${(e as Error).message}`);
            break;
          }
        }
        const shape = (x: unknown) => (c.entries ? { [key]: x } : c.items ? [x] : x);
        const how = c.entries ? "with an entry of" : c.items ? "listing" : "as";
        // A listed value is pinned, so a condition it sets brings the members it requires.
        const put = (x: unknown, valid: boolean) => (valid ? innermost(st, { [name]: shape(x) }) : { ...inner, [name]: shape(x) });
        let ok = true;
        for (const x of c.values) ok = expect(true, put(x, true), `"${name}" ${how} the listed ${JSON.stringify(x)}`) && ok;
        // The first vendor code is listed, and the code before it isn't.
        if (c.vendor !== undefined) {
          ok = expect(true, put(c.vendor, true), `"${name}" ${how} the vendor code ${c.vendor}`) && ok;
          if (!c.values.includes(c.vendor - 1)) expect(false, put(c.vendor - 1, false), `"${name}" ${how} the unlisted ${c.vendor - 1}, below the vendor codes,`);
        }
        if (ok && !c.open) {
          const numeric = c.values.every((x) => typeof x === "number");
          const unlisted = numeric ? Math.max(...(c.values as number[])) + 1 : UNLISTED;
          expect(false, put(unlisted, false), `"${name}" ${how} the unlisted ${JSON.stringify(unlisted)}`);
          // An integer code list is closed below its lowest code and between two codes it lists, as the Deals API's tag lists
          // `sellerstatus` 0, 1, 2, and 4, and not 3.
          if (numeric && (c.values as number[]).every((x) => Number.isInteger(x))) {
            const codes = [...new Set(c.values as number[])].sort((a, b) => a - b);
            const vendor = (y: number) => c.vendor !== undefined && y >= c.vendor;
            const gap = codes.slice(1).map((x, k) => [codes[k]!, x] as const).find(([a, x]) => x - a > 1 && !vendor(a + 1));
            if (gap) expect(false, put(gap[0] + 1, false), `"${name}" ${how} the unlisted ${gap[0] + 1}, between two listed codes,`);
            if (codes[0]! >= 0) expect(false, put(codes[0]! - 1, false), `"${name}" ${how} the unlisted ${codes[0]! - 1}, below the listed codes,`);
          }
          const values = c.entries ? child(memberAt, "additionalProperties") : c.items && memberAt.node.type === "array" ? child(memberAt, "items") : memberAt;
          const target = deref(values);
          reached.add(`${target.file}#${target.pointer}`);
        }
        break;
      }
      case "namespaced": {
        const shape = (x: unknown) => (c.items ? [x] : x);
        for (const x of c.examples) {
          if (!expect(true, innermost(st, { [name]: shape(x) }), `"${name}" listing the example ${JSON.stringify(x)}`)) continue;
          const bare = x.slice(x.indexOf("/") + 1);
          expect(false, { ...inner, [name]: shape(bare) }, `"${name}" listing ${JSON.stringify(bare)}, the example ${JSON.stringify(x)} without its namespace,`);
        }
        break;
      }
      case "empty":
        expect(true, { ...inner, [name]: [] }, `"${name}" empty`);
        break;
      case "example": {
        const written = tryInner({ [name]: c.value }, " with the example's value");
        if (written !== null) expect(true, written, `"${name}" as the example writes it, ${JSON.stringify(c.value)}`);
        break;
      }
      case "default": {
        // The member's own node, beside its `$ref`, carries the default, which a receiver fills in for an absent member.
        const node = child(st.at(-1)!.object, "properties", name).node;
        counts.default = (counts.default ?? 0) + 1;
        if (!("value" in c)) {
          if ("default" in node) disagree(`the row states no default, but the schema's "${name}" defaults to ${JSON.stringify(node.default)}`, false);
          break;
        }
        if (!("default" in node)) disagree(`the stated default is ${JSON.stringify(c.value)}, but the schema's "${name}" states no default`, false);
        else if (canonicalJson(node.default) !== canonicalJson(c.value)) disagree(`the stated default is ${JSON.stringify(c.value)}, but the schema's "${name}" defaults to ${JSON.stringify(node.default)}`, false);
        else {
          const at = tryInner({ [name]: c.value }, " with the default");
          if (at !== null) expect(true, at, `"${name}" as its default, ${JSON.stringify(c.value)}`);
        }
        break;
      }
    }
  }

  // A projection holds what its list names: each object a listed path steps into, below the root, holds only the members
  // the list's paths name next, and a sibling the domain model makes one of them require, as a rate requires its currency
  // (type rules § 3a). A step that a listed path ends at is the whole field, and the root also holds the members the
  // profile adds, which the list doesn't write as paths. A path a decision reads from a prose item joins its list's
  // projection; no presence constraint resolves it, so a step of it the schema doesn't hold is reported here.
  const conceptOf = kernel.domains ? conceptOfType(kernel.domains) : new Map<string, never>();
  const typeOfMember = (object: At, name: string): string | undefined => {
    let at = deref(child(object, "properties", name));
    if (at.node.type === "array" && isMap(at.node.items)) at = deref(child(at, "items"));
    return typeOfAt(at);
  };
  for (const p of projections) {
    const key = (segs: PathSegment[]) => segs.map((x) => x.name).join(".");
    const ends = new Set(p.paths.map((x) => key(x.segments)));
    const next = new Map<string, { path: PathSegment[]; names: Set<string> }>();
    for (const { segments: segs, presence, decision } of p.paths) {
      if (presence === "kept") {
        const steps = resolve({ root: { list: p.list }, path: segs.slice(0, -1), member: segs.at(-1)! });
        if (typeof steps === "string") problems.push(`${p.list}#projection@${key(segs)}: ${decision} reads the list's prose item as "${key(segs)}", but ${steps}`);
      }
      for (let i = 1; i < segs.length; i++) {
        const k = key(segs.slice(0, i));
        const n = next.get(k) ?? { path: segs.slice(0, i), names: new Set<string>() };
        n.names.add(segs[i]!.name);
        next.set(k, n);
      }
    }
    for (const [k, { path, names }] of [...next].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (ends.has(k)) continue;
      const steps = resolve({ root: { list: p.list }, path, member: { name: [...names][0]!, array: false } });
      // A path the schema doesn't hold is the contains constraint's disagreement, reported there.
      if (typeof steps === "string") continue;
      const object = steps.at(-1)!.object;
      const allowed = new Set(names);
      for (const n of names) {
        const requires = conceptOf.get(typeOfMember(object, n) ?? "")?.concept.requires;
        if (requires) allowed.add(requires.member);
      }
      for (const m of Object.keys(isMap(object.node.properties) ? object.node.properties : {})) {
        if (!allowed.has(m)) problems.push(`${p.list}#projection@${k}: ${p.text} … the schema's "${k}" holds "${m}", which no listed path names and no listed member requires; project the field to ${[...names].map((x) => `"${x}"`).join(", ")}`);
      }
    }
  }

  // A list of the specification's own: each value its rows accept is valid against the type the model places its rows in, and each value they rule out is invalid.
  const lists = readers.readLists?.(ir) ?? [];
  for (const l of lists) {
    for (const u of l.unreadable ?? []) problems.push(`${u.row}: the value "${u.value}", which the list reader can't read; read it, or record why the list needs no vector for it`);
    const base = { constraint: l.id, element: l.element, form: "values" as const, path: l.id };
    const disagree = (detail: string) => {
      const decision = departureOf(l.element, "values");
      if (decision !== undefined) departed.push({ ...base, detail, decision: decision.id, status: decision.status });
      else disagreements.push({ ...base, detail });
    };
    const t = model.types.find((x) => x.kind === "vocabulary" && (x.sources.some((s) => l.rows.includes(s)) || x.terms.some((term) => term.sources.some((s) => l.rows.includes(s)))));
    const id = t ? schemaIdOf(t, schemaDir, baseOf(files, schemaDir)) : null;
    if (id === null) {
      disagree(`no emitted vocabulary holds the rows of ${l.id}`);
      continue;
    }
    reached.add(id.includes("#") ? id : `${id}#`);
    for (const [valid, vectors] of [[true, l.valid], [false, l.invalid]] as const) {
      for (const x of vectors) {
        counts.values = (counts.values ?? 0) + 1;
        let errors: ErrorObject[] | null;
        try {
          errors = validate(id, x.value);
        } catch (e) {
          problems.push(`${l.id}: ${(e as Error).message}`);
          continue;
        }
        if (valid && errors !== null) disagree(`${JSON.stringify(x.value)} (${x.why}) is valid, but ${t!.name}'s schema rejects it`);
        if (!valid && errors === null) disagree(`${JSON.stringify(x.value)} (${x.why}) is invalid, but ${t!.name}'s schema accepts it`);
      }
    }
  }

  // A departure's cover that lists a form must excuse a disagreement of that form on the lock, so `departs` says no more than the schema does.
  for (const d of departures) {
    for (const cover of d.covers) {
      if (!inScope(cover.locks, lock)) continue;
      for (const form of cover.departs ?? []) {
        if (!departed.some((x) => x.decision === d.id && x.element === cover.ir && x.form === form)) problems.push(`${d.id}: departs from the ${form} form of ${cover.ir} on lock "${lock}", but no disagreement of that form occurs there; remove it from that cover's departs`);
      }
    }
  }

  // Every closed vocabulary the schema publishes that no closed value list the oracle reads reaches: its terms are checked nowhere here.
  for (const t of model.types) {
    if (t.kind !== "vocabulary" || t.open || t.attribute !== undefined) continue;
    const id = schemaIdOf(t, schemaDir, baseOf(files, schemaDir));
    // A registry's vocabulary is reached where a value list reaches the registry's schema, which the spec's references.
    const registry = t.list?.registry ? `${t.list.registry.schema}#/$defs/${t.list.registry.def}` : null;
    if (id === null || reached.has(id) || (registry !== null && reached.has(registry))) continue;
    unread.push({ element: t.sources[0] ?? t.name, form: "a closed vocabulary no closed value list the oracle reads reaches", text: `${t.name}: ${t.terms.map((x) => x.value).join(" | ")}` });
  }
  unread.sort((a, b) => (a.element < b.element ? -1 : a.element > b.element ? 1 : a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  return { constraints, unread, restated, vectors: counts, disagreements, departed, ruled, problems, ...(lists.length > 0 ? { lists: lists.length } : {}) };
}

/** The gate's note: what the oracle covers, by form, and what it can't read yet, by form. */
export function fidelityNote(r: FidelityResult): string {
  const byForm = FORMS.map((f) => [f, r.constraints.filter((c) => c.form === f).length] as const).filter(([, n]) => n > 0);
  const vectors = Object.values(r.vectors).reduce((n, x) => n + x, 0);
  const unread = new Map<string, number>();
  for (const u of r.unread) unread.set(u.form, (unread.get(u.form) ?? 0) + 1);
  const by = new Map<string, number>();
  for (const d of r.departed) by.set(`${d.decision} (${d.status})`, (by.get(`${d.decision} (${d.status})`) ?? 0) + 1);
  return [
    `${r.constraints.length} constraints${byForm.length > 0 ? ` (${byForm.map(([f, n]) => `${n} ${f}`).join(", ")})` : ""}${r.lists ? `, ${r.lists} code lists` : ""}, ${vectors} vectors, ${r.restated.length} statements read through another element's constraint`,
    `${r.departed.length} disagreements a departure covers${by.size > 0 ? `: ${[...by].map(([d, n]) => `${n} by ${d}`).join(", ")}` : ""}`,
    `${r.ruled.length} left to a listed rule${r.ruled.length > 0 ? ` (${[...new Set(r.ruled.map((x) => x.rule))].join(", ")})` : ""}`,
    `not read yet: ${[...unread].map(([f, n]) => `${n} ${f}`).join("; ")}`,
  ].join("; ");
}
