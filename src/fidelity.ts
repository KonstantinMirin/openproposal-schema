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
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { canonicalJson } from "./canonical.ts";
import { baselines, Validators, type Baselines } from "./corpus.ts";
import { schemaIdOf, type EmittedFile } from "./emit.ts";
import { installFormats } from "./formats.ts";
import type { PathSegment } from "./grammar/path.ts";
import type { Presence, PresenceClause } from "./grammar/required.ts";
import type { TypeExpr } from "./grammar/type-expr.ts";
import type { Field, Key, SpecIR, ValueList } from "./ir-types.ts";
import type { Kernel } from "./kernel.ts";
import type { Lists } from "./lists.ts";
import { conceptOfType } from "./domains.ts";
import { decisionsOf, inScope, type DecisionRecord, type MappingFile } from "./mapping.ts";
import type { ModelDoc } from "./model.ts";
import type { Rule, RulesDoc } from "./rules.ts";

type Schema = Record<string, unknown>;
const isMap = (v: unknown): v is Schema => v !== null && typeof v === "object" && !Array.isArray(v);

/** The forms the oracle reads. */
export const FORMS = ["required", "optional", "conditional", "type", "values", "namespaced", "contains", "member", "empty", "example"] as const;
export type Form = (typeof FORMS)[number];

/** Where a constraint sits: a root, then the path to the object that holds the member, then the member. */
export interface SpecLocation {
  /** A document by its field rows' owner, or the type the model places an identifier list in. */
  root: { owner: "proposal" | "line_item" } | { list: string };
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
  | { form: "example"; value: unknown };

/** One constraint the specification states, as the oracle reads it from the IR. */
export type SpecConstraint = {
  /** `<element>#<form>@<path>`. */
  id: string;
  /** The IR element the constraint is read from, which a departure must cover. */
  element: string;
  text: string;
  at: SpecLocation;
} & Expectation;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

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

// Reading the IR --------------------------------------------------------------

/** A condition the oracle reads: a sibling equal to one value, as "`a = b`" or "`a` is `b`". */
const CONDITIONS = [/^`([a-z][a-z0-9_]*) = ([^`\s]+)`$/, /^`([a-z][a-z0-9_]*)` is `([^`]+)`$/];

/**
 * Reads a condition: "`a = b`", "`a` is `b`", or a label and the cases it
 * means in a parenthesis, as "video ads (`channel` `video`, or video on
 * `channel` `ctv`)". In a parenthesis, a case written as the member and its
 * value alone holds the condition; a case with more prose about a member's
 * value can't be decided, so that value is on neither side. Null for any
 * other condition, or for one that names two members or two values.
 */
export function readCondition(text: string): { member: string; value: unknown; undecided: unknown[] } | null {
  for (const r of CONDITIONS) {
    const m = r.exec(text);
    if (m) return { member: m[1]!, value: literal(m[2]!), undecided: [] };
  }
  const p = /^[^`()]+\((.+)\)$/.exec(text);
  if (!p) return null;
  const clean: [string, string][] = [];
  const undecided: [string, string][] = [];
  for (const alt of p[1]!.split(/,? or |, /)) {
    const exact = /^`([a-z][a-z0-9_]*)` `([^`]+)`$/.exec(alt);
    if (exact) {
      clean.push([exact[1]!, exact[2]!]);
      continue;
    }
    const inner = [...alt.matchAll(/`([a-z][a-z0-9_]*)` `([^`]+)`/g)];
    if (inner.length === 0) return null;
    undecided.push(...inner.map((m) => [m[1]!, m[2]!] as [string, string]));
  }
  const members = new Set([...clean, ...undecided].map(([m]) => m));
  if (clean.length !== 1 || members.size !== 1) return null;
  return { member: clean[0]![0], value: literal(clean[0]![1]), undecided: undecided.map(([, v]) => literal(v)) };
}

/** A value as the specification writes it in a code span: `true` and `false` are booleans, and a decimal integer is a number. */
export function literal(text: string): unknown {
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?(0|[1-9][0-9]*)$/.test(text)) return Number(text);
  return text;
}

/** A sentence that lists a member's values: "`x` is `a` or `b`", or "`x` is `a`, `b` or `c` per <key>". */
const VALUE_SENTENCE = /^`([a-z][a-z0-9_]*)` is ((?:`[^`]+`, )*`[^`]+`,? or `[^`]+`)( per [a-z ]+)?\.$/;

/** A row that enumerates codes of a named list, as "One value from List: Plcmt Subtypes - Video: Instream (1), …". */
const LIST_CODES = /\b(?:One value|Values) from List: [^:(]+?(?::| such as) (.+)$/;

/** A sentence that gives members the codes of named lists: "`plcmt`, `playmethod[]` and `api[]` take any code in List: …, List: … and List: … respectively". */
const ANY_CODE = /^((?:`[^`]+`(?:, | and )?)+) takes? any code in (List: .+?)( respectively)?\.$/;

/** A row whose options are namespaced, "`available[]` of registry format ids namespaced by channel (`display/300x250`, …)": each example, and the `/` it writes, the namespace's form. */
const NAMESPACED = /`available\[\]` of [^`()]*?\bnamespaced by [a-z ]+? \(((?:`[^`/\s]+\/[^`\s]+`(?:, )?)+)\)/;

/** A string that a placeholder stands in, as `<url>`, which states no value. */
const PLACEHOLDER = /<[^<>\s]+>/;

const seg = (name: string, array = false): PathSegment => ({ name, array });
const segmentsOf = (path: string): PathSegment[] => path.split(".").map((p) => seg(p.replace(/\[\]$/, ""), p.endsWith("[]")));

/**
 * Reads every constraint the IR states in a form the oracle knows, and lists
 * every element in a constraint form it doesn't. A pure function of the IR.
 */
export function readConstraints(ir: SpecIR, lists?: Lists, readings: Reading[] = []): { constraints: SpecConstraint[]; unread: Unread[]; restated: Restated[]; projections: Projection[]; refused: Refused[] } {
  const constraints: SpecConstraint[] = [];
  const projections: Projection[] = [];
  const refused: Refused[] = [];
  const unread: Unread[] = [];
  const add = (c: DistributiveOmit<SpecConstraint, "id">) => {
    const id = `${c.element}#${c.form}@${pathText(c.at)}`;
    if (!constraints.some((x) => x.id === id)) constraints.push({ ...c, id } as SpecConstraint);
  };
  const fields = ir.fields;
  const fieldById = new Map(fields.map((f) => [f.id, f]));
  const inlineById = new Map(ir.inline_objects.map((o) => [o.id, o]));
  const tableById = new Map(ir.tables.map((t) => [t.id, t]));
  const keyById = new Map(ir.keys.map((k) => [k.id, k]));

  /** Every location a key row's object has: its table's field, a member of an inline object, or each field a § 3.1-style statement names by marker. */
  const keyParents = (k: Key): { root: SpecLocation["root"]; path: PathSegment[] }[] | string => {
    const table = k.loc.table !== undefined ? tableById.get(k.loc.table) : undefined;
    const parent = table?.parent;
    if (!parent) return "a key table with no parent object";
    if (parent.field !== null) {
      const f = fieldById.get(parent.field);
      if (!f || f.names.length !== 1) return "a key table whose field row names no single field";
      return [{ root: { owner: f.owner }, path: f.names[0]!.segments }];
    }
    if (parent.member_of !== null && parent.identifier !== null) {
      const at = inlineAt(parent.member_of);
      if (typeof at === "string") return at;
      return at.map((x) => ({ root: x.root, path: [...x.path, ...segmentsOf(parent.identifier!)] }));
    }
    if (parent.via === "section") {
      const intro = ir.statements.find((s) => s.loc.section === k.loc.section && /^Every field marked `([a-z-]+)` MUST declare:$/.test(s.text));
      const marker = intro ? /`([a-z-]+)`/.exec(intro.text)![1]! : null;
      if (marker === null) return "a key table no statement attaches to a field";
      return fields.filter((f) => f.marker === marker).flatMap((f) => f.names.map((n) => ({ root: { owner: f.owner } as const, path: n.segments })));
    }
    return "a key table whose parent object the IR doesn't name";
  };

  /** Where an inline object's members sit: each place its host row has, then the code span it is introduced by, as "`available[]` of { … }". */
  const inlineAt = (id: string): { root: SpecLocation["root"]; path: PathSegment[] }[] | string => {
    const o = inlineById.get(id);
    if (!o) return `no inline object "${id}"`;
    const rows = rowPlaces(o.host.replace(/#.*$/, ""));
    if (typeof rows === "string") return rows;
    const anchor = o.anchor !== null ? segmentsOf(o.anchor) : [];
    return rows.map((r) => ({ root: r.root, path: [...r.path, ...anchor] }));
  };

  /** Each place a field or key row's value sits: its root, and the path to it. */
  const rowPlaces = (id: string): { root: SpecLocation["root"]; path: PathSegment[]; type: TypeExpr | null }[] | string => {
    const f = fieldById.get(id);
    if (f) return f.names.map((n) => ({ root: { owner: f.owner }, path: n.segments, type: f.type.parsed }));
    const k = keyById.get(id);
    if (!k) return "an element outside a field or key row";
    const parents = keyParents(k);
    if (typeof parents === "string") return parents;
    return parents.map((p) => ({ root: p.root, path: [...p.path, ...k.key.segments], type: null }));
  };

  /** Every field and key row at each of its places, with the value lists its own cell holds. */
  const rows: { id: string; lists: string[]; root: SpecLocation["root"]; path: PathSegment[] }[] = [
    ...fields.flatMap((f) => f.names.map((n) => ({ id: f.id, lists: f.value_lists, root: { owner: f.owner } as SpecLocation["root"], path: n.segments }))),
    ...ir.keys.flatMap((k) => {
      const parents = keyParents(k);
      return typeof parents === "string" ? [] : parents.map((p) => ({ id: k.id, lists: k.value_lists, root: p.root, path: [...p.path, ...k.key.segments] }));
    }),
  ];
  const placeKey = (root: SpecLocation["root"], path: PathSegment[]) => canonicalJson([root, path.map((s) => s.name)]);

  /**
   * The row a condition's member is, as a sibling of the constrained member
   * or as a member of an object its path runs through, nearest first: how
   * many objects up it sits, and the values its own cell lists, or null
   * when it lists none.
   */
  const conditionRow = (root: SpecLocation["root"], path: PathSegment[], member: string): { up: number; values: unknown[] | null } | null => {
    for (let up = 0; up <= path.length; up++) {
      const want = placeKey(root, [...path.slice(0, path.length - up), seg(member)]);
      const row = rows.find((r) => placeKey(r.root, r.path) === want);
      if (!row) continue;
      const list = ir.value_lists.find((v) => row.lists.includes(v.id) && v.origin === "table_cell" && v.subject === null);
      return { up, values: list ? list.items.map((i) => literal(i.value)) : null };
    }
    return null;
  };

  /** The presence constraints of one row at one location. */
  const presence = (element: string, text: string, p: Presence | null, root: SpecLocation["root"], path: PathSegment[], member: PathSegment) => {
    if (p === null) return;
    const at = { root, path, member };
    if (p.kind === "marker") {
      unread.push({ element, form: "a marker in the Required cell, which is a rule about two versions", text });
      return;
    }
    const conditions = p.clauses.filter((c) => c.condition !== null || c.qualifier === "otherwise");
    const plain = p.clauses.filter((c) => c.condition === null && c.qualifier === null);
    if (conditions.length === 0 && plain.length === 1) {
      add({ element, text, at, form: plain[0]!.level === "REQUIRED" ? "required" : "optional" });
      return;
    }
    const withs = p.clauses.filter((c) => c.qualifier === "with");
    if (withs.length > 0) {
      const w = withs[0]!;
      if (p.clauses.length !== 1 || w.level !== "REQUIRED" || w.members === undefined) unread.push({ element, form: "a presence with members beside another clause, or not REQUIRED", text });
      else if (w.members.some((m) => m.includes("[]"))) unread.push({ element, form: "a presence with a member through a list", text });
      else add({ element, text, at, form: "conditional", with: w.members.map((m) => m.split(".")) });
      return;
    }
    const required = p.clauses.filter((c): c is PresenceClause & { condition: string } => c.level === "REQUIRED" && (c.qualifier === "when" || c.qualifier === "for") && c.condition !== null);
    const others = p.clauses.filter((c) => !required.includes(c as never));
    const read = required.length === 1 ? readCondition(required[0]!.condition) : null;
    if (read && others.every((c) => c.level !== "REQUIRED" && c.condition === null)) {
      const row = conditionRow(root, path, read.member);
      if (row === null) {
        unread.push({ element, form: "a presence condition on a member no row names", text });
        return;
      }
      const listed = typeof read.value === "boolean" ? [!read.value] : (row.values ?? []);
      const otherwise = listed.filter((x) => canonicalJson(x) !== canonicalJson(read.value) && !read.undecided.some((u) => canonicalJson(u) === canonicalJson(x)));
      if (typeof read.value !== "boolean" && row.values === null) unread.push({ element, form: "a condition's other side, whose member's row lists no values, so only the side where it holds is tested", text });
      add({ element, text, at, form: "conditional", when: { member: read.member, value: read.value, up: row.up }, otherwise });
      return;
    }
    unread.push({ element, form: "a presence condition in prose, not a member equal to a value", text });
  };

  for (const f of fields) {
    for (const n of f.names) {
      const path = n.segments.slice(0, -1);
      const member = n.segments.at(-1)!;
      presence(f.id, f.description.text, f.presence, { owner: f.owner }, path, member);
      add({ element: f.id, text: f.type.raw, at: { root: { owner: f.owner }, path, member }, form: "type", type: f.type.parsed });
    }
  }
  for (const k of ir.keys) {
    const parents = keyParents(k);
    if (typeof parents === "string") {
      unread.push({ element: k.id, form: parents, text: k.key.path });
      continue;
    }
    for (const p of parents) {
      const path = [...p.path, ...k.key.segments.slice(0, -1)];
      const member = k.key.segments.at(-1)!;
      presence(k.id, `${k.key.path} | ${k.required?.raw ?? ""}`, k.required?.parsed ?? null, p.root, path, member);
    }
  }

  // Value lists.
  for (const v of ir.value_lists) {
    const located = valueAt(v);
    if (typeof located === "string") {
      unread.push({ element: v.id, form: located, text: v.items.map((i) => i.value).join(" | ") });
      continue;
    }
    const open = v.context_after !== null && /^\s*(and|or) other\b/.test(v.context_after);
    if (open) unread.push({ element: v.id, form: "an open value list (\"and other …\"), which states no invalid value", text: `${v.items.map((i) => i.value).join(" | ")} ${v.context_after}` });
    for (const at of located) add({ element: v.id, text: v.items.map((i) => i.value).join(" | "), at: at.at, form: "values", values: v.items.map((i) => literal(i.value)), open, items: at.items });
  }

  /** Where a value list's values sit: its row's value, a selectable field's `available[]` items, or an inline object's member. */
  function valueAt(v: ValueList): { at: SpecLocation; items: boolean }[] | string {
    if (v.origin === "prose") return "a value list in prose, whose subject the IR doesn't name";
    if (v.origin === "inline_object") {
      const objectId = v.id.replace(/\/[^/]+$/, "");
      const at = inlineAt(objectId);
      if (typeof at === "string") return at;
      const o = inlineById.get(objectId)!;
      const m = o.form.members.find((x) => x.key === v.subject?.identifier);
      if (!m) return "an inline object's value list whose member the IR doesn't name";
      return at.map((x) => ({ at: { root: x.root, path: x.path, member: seg(m.key, m.array) }, items: m.array }));
    }
    const places = rowPlaces(v.host.replace(/#.*$/, ""));
    if (typeof places === "string") return places;
    const rows = places.map((r) => ({ root: r.root, segments: r.path, type: r.type }));
    if (rows.length === 0) return "a value list in a row the oracle can't place";
    if (v.subject !== null && !(v.subject.relation === "from" && v.subject.identifier === "available[]")) return `a value list whose subject is "${v.subject.identifier}"`;
    return rows.map((r) => {
      if (v.subject !== null) return { at: { root: r.root, path: r.segments, member: seg("available", true) }, items: true };
      const last = r.segments.at(-1)!;
      return { at: { root: r.root, path: r.segments.slice(0, -1), member: last }, items: last.array || r.type?.kind === "array" };
    });
  }

  // The codes a row enumerates from a named list: "One value from List: … Label (n), …" is closed, and "such as" leaves it open.
  for (const row of [...fields.map((f) => ({ id: f.id, text: f.description.text })), ...ir.keys.map((k) => ({ id: k.id, text: k.meaning.text }))]) {
    const m = LIST_CODES.exec(row.text);
    if (!m) continue;
    const codes = [...m[1]!.matchAll(/\((\d+)\)/g)].map((x) => Number(x[1]));
    if (codes.length === 0) {
      unread.push({ element: row.id, form: "a named list whose codes the row doesn't write", text: row.text });
      continue;
    }
    const open = /\bsuch as\b/.test(row.text.slice(0, m.index + m[0].length - m[1]!.length));
    const places = rowPlaces(row.id);
    if (typeof places === "string") {
      unread.push({ element: row.id, form: places, text: row.text });
      continue;
    }
    if (open) unread.push({ element: row.id, form: "an open value list (\"such as …\"), which states no invalid value", text: row.text });
    for (const p of places) {
      const last = p.path.at(-1)!;
      add({ element: row.id, text: row.text, at: { root: p.root, path: p.path.slice(0, -1), member: last }, form: "values", values: codes, open, items: last.array || p.type?.kind === "array" });
    }
  }

  // A row whose options are namespaced, "`available[]` of … namespaced by <what> (`a/b`, `c/d`)": each example is an option,
  // and an example without its namespace isn't, since a namespace is a prefix the value holds.
  for (const f of fields) {
    const m = NAMESPACED.exec(f.description.text);
    if (!m) {
      if (/\bnamespaced\b/.test(f.description.text)) unread.push({ element: f.id, form: "a namespace the row states in prose, with no example of its form", text: f.description.text });
      continue;
    }
    const examples = [...m[1]!.matchAll(/`([^`]+)`/g)].map((x) => x[1]!);
    for (const n of f.names) add({ element: f.id, text: m[0], at: { root: { owner: f.owner }, path: n.segments, member: seg("available", true) }, form: "namespaced", examples, items: true });
  }

  /** Each place of a member a sentence names by its bare name in its section: a field or key row, or a member an inline object of a row writes. */
  const namedIn = (section: string, name: string): { source: string; at: SpecLocation; array: boolean }[] => {
    const out: { source: string; at: SpecLocation; array: boolean }[] = [];
    for (const r of rows) {
      const last = r.path.at(-1)!;
      const row = fieldById.get(r.id) ?? keyById.get(r.id);
      if (row?.loc.section === section && last.name === name) out.push({ source: r.id, at: { root: r.root, path: r.path.slice(0, -1), member: last }, array: last.array });
    }
    for (const o of ir.inline_objects) {
      if (o.loc.section !== section || !/^(field|key):/.test(o.host)) continue;
      const m = o.form.members.find((x) => x.key === name);
      const at = m ? inlineAt(o.id) : "";
      if (m && typeof at !== "string") for (const x of at) out.push({ source: o.id, at: { root: x.root, path: x.path, member: seg(m.key, m.array) }, array: m.array });
    }
    return out;
  };

  // A sentence that lists a member's values: "`x` is `a` or `b`", each entry's of a map with "per <key>".
  const readSentences = new Set<string>();
  for (const s of ir.sentences) {
    const m = VALUE_SENTENCE.exec(s.text);
    if (!m) continue;
    const places = namedIn(s.loc.section, m[1]!);
    if (places.length === 0 || new Set(places.map((p) => p.source)).size !== 1) {
      unread.push({ element: s.id, form: "a value list in a sentence whose member the oracle can't place in one row", text: s.text });
      continue;
    }
    readSentences.add(s.id);
    const values = [...m[2]!.matchAll(/`([^`]+)`/g)].map((x) => literal(x[1]!));
    for (const p of places) add({ element: s.id, text: s.text, at: p.at, form: "values", values, open: false, items: p.array, ...(m[3] !== undefined ? { entries: true } : {}) });
  }

  // A sentence that gives members the codes of named lists, "`a`, `b` and `c` take any code in List: X, List: Y and List: Z
  // respectively": each member takes exactly its list's codes, as `kernel/lists.yaml` holds them at the commit the text links.
  for (const s of ir.sentences) {
    const m = ANY_CODE.exec(s.text);
    if (!m || lists === undefined) continue;
    const members = [...m[1]!.matchAll(/`([^`]+)`/g)].map((x) => x[1]!);
    const names = m[2]!.split(/, (?=List: )| and (?=List: )/);
    if (members.length !== names.length || (members.length > 1 && m[3] === undefined)) {
      unread.push({ element: s.id, form: "a sentence that pairs members with named lists the oracle can't pair", text: s.text });
      continue;
    }
    const pairs = members.map((member, i) => ({ member, list: lists.lists.find((l) => l.name === names[i]) }));
    if (pairs.some((p) => p.list === undefined)) {
      unread.push({ element: s.id, form: "a named list whose codes kernel/lists.yaml doesn't hold", text: s.text });
      continue;
    }
    const placed = pairs.map((p) => ({ ...p, places: namedIn(s.loc.section, p.member.replace(/\[\]$/, "")) }));
    if (placed.some((p) => p.places.length === 0 || new Set(p.places.map((x) => x.source)).size !== 1)) {
      unread.push({ element: s.id, form: "a value list in a sentence whose member the oracle can't place in one row", text: s.text });
      continue;
    }
    readSentences.add(s.id);
    for (const p of placed) {
      // A list that reserves codes for vendors, as List: API Frameworks reserves "500+ Vendor-specific codes", lists each of them too.
      const vendor = p.list!.vendor !== undefined ? { vendor: p.list!.vendor.from } : {};
      for (const x of p.places) add({ element: s.id, text: s.text, at: x.at, form: "values", values: p.list!.codes.map((c) => c.code), open: false, items: x.array, ...vendor });
    }
  }

  // The members an inline object writes in a row: each is a member of the object at the row's place.
  for (const o of ir.inline_objects) {
    if (!/^(field|key):/.test(o.host)) {
      unread.push({ element: o.id, form: "an inline object in prose, whose subject the IR doesn't name", text: o.text });
      continue;
    }
    const at = inlineAt(o.id);
    if (typeof at === "string") {
      unread.push({ element: o.id, form: at, text: o.text });
      continue;
    }
    if (o.form.combinator !== "all") {
      unread.push({ element: o.id, form: "an inline object that writes alternatives, not members", text: o.text });
      continue;
    }
    // A selectable field's object, which no code span anchors to `available[]`, is an option or the field itself as one reads it.
    const host = fieldById.get(o.host.replace(/#.*$/, ""));
    if (o.anchor === null && host !== undefined && ir.statements.some((s) => new RegExp(`^Every field marked \`${host.marker}\` MUST declare:$`).test(s.text))) {
      unread.push({ element: o.id, form: "an object in a marked field's row that no code span places, so its place is a reading", text: o.text });
      continue;
    }
    for (const m of o.form.members) {
      // A member whose value is a choice of objects, as `{ option_id: { delta_cpm | delta_flat | delta_pct } }`, names a key, not a member.
      if (m.value?.kind === "object" && m.value.object.combinator === "one_of") {
        unread.push({ element: o.id, form: "a key the text writes as a placeholder for many, not a member", text: `${m.key} in ${o.text}` });
        continue;
      }
      for (const x of at) add({ element: o.id, text: o.text, at: { root: x.root, path: x.path, member: seg(m.key, m.array) }, form: "member" });
    }
  }

  // A YAML block the text writes under a field's name: each member's value, as written, is accepted.
  for (const b of ir.code_blocks) {
    if (b.lang !== "yaml") {
      unread.push({ element: b.id, form: "a code block in no data language, which states no value", text: b.text.split("\n")[0]! });
      continue;
    }
    let doc: unknown;
    try {
      doc = parseYaml(b.text, { version: "1.2", schema: "core" });
    } catch {
      unread.push({ element: b.id, form: "a YAML block that doesn't parse", text: b.text.split("\n")[0]! });
      continue;
    }
    if (!isMap(doc)) {
      unread.push({ element: b.id, form: "a YAML block that isn't a map of fields", text: b.text.split("\n")[0]! });
      continue;
    }
    for (const [name, value] of Object.entries(doc)) {
      const named = fields.filter((f) => f.names.some((n) => n.segments.length === 1 && n.segments[0]!.name === name));
      const own = named.filter((f) => f.loc.section === b.loc.section);
      const f = (own.length === 1 ? own : named.length === 1 ? named : [])[0];
      if (f === undefined) {
        unread.push({ element: b.id, form: "an example under a name no single field row has", text: name });
        continue;
      }
      const root = { owner: f.owner } as const;
      const members: [PathSegment[], string, unknown][] = isMap(value) ? Object.entries(value).map(([k, x]) => [[seg(name)], k, x]) : [[[], name, value]];
      for (const [path, member, x] of members) {
        const text = `${[...path.map((s) => s.name), member].join(".")}: ${JSON.stringify(x)}`;
        if (PLACEHOLDER.test(JSON.stringify(x))) {
          unread.push({ element: b.id, form: "an example value with a placeholder, which states no value", text });
          continue;
        }
        add({ element: b.id, text, at: { root, path, member: seg(member, Array.isArray(x)) }, form: "example", value: x });
      }
    }
  }

  // MUST-contain lists, and "MAY be empty".
  /** Each MUST-contain statement the oracle reads, with the first list it reads it into. */
  const containing = new Map<string, string>();
  /** The lists a MUST-contain statement introduces, whose prose items a decision may read. */
  const consulted = new Set<string>();
  const blockOf = (host: string) => /^block:([^:]+):(\d+)$/.exec(host);
  for (const s of ir.statements) {
    if (/^MAY be empty$/.test(s.text)) {
      const host = /^(key:[^#]+)#meaning$/.exec(s.host)?.[1];
      const k = host ? ir.keys.find((x) => x.id === host) : undefined;
      const parents = k ? keyParents(k) : "a statement outside a key row";
      if (!k || typeof parents === "string") {
        unread.push({ element: s.id, form: typeof parents === "string" ? parents : "a statement outside a key row", text: s.text });
        continue;
      }
      for (const p of parents) add({ element: s.id, text: s.text, at: { root: p.root, path: [...p.path, ...k.key.segments.slice(0, -1)], member: k.key.segments.at(-1)! }, form: "empty" });
      continue;
    }
    if (!(s.level === "MUST" && /\bMUST contain\b.*:$/.test(s.text))) continue;
    const b = blockOf(s.host);
    if (!b) continue;
    const lists: string[] = [];
    for (let n = Number(b[2]) + 1; ; n++) {
      const host = `block:${b[1]}:${n}`;
      const list = ir.identifier_lists.find((l) => l.host === host);
      const continues = n === Number(b[2]) + 1 || ir.sentences.some((x) => x.host === host && /^plus\b/.test(x.text));
      if (!list || !continues) break;
      lists.push(list.id);
    }
    if (lists.length === 0) unread.push({ element: s.id, form: "a MUST-contain statement with no identifier list after it", text: s.text });
    else containing.set(s.id, lists[0]!);
    for (const id of lists) {
      const list = ir.identifier_lists.find((l) => l.id === id)!;
      const projection: Projection = { list: id, text: s.text, paths: [] };
      projections.push(projection);
      // A decision's reading joins the projection only where it can't widen it: it reads a prose item the list writes, and
      // each path starts at a field none of the list's code paths names, since a path into an object a code path projects
      // would let that object hold one more member.
      const prose = new Set(list.items.filter((i) => !i.code).map((i) => i.text));
      const coded = new Map(list.items.filter((i) => i.code).map((i) => [segmentsOf(i.text)[0]!.name, i.text] as const));
      const read = readings.filter((r) => r.list === id);
      consulted.add(id);
      for (const r of read) {
        if (!prose.has(r.item)) {
          refused.push({ list: id, decision: r.decision, item: r.item, why: `the list writes no prose item "${r.item}"${prose.size ? `; its prose items are ${[...prose].map((x) => `"${x}"`).join(", ")}` : ""}` });
          continue;
        }
        for (const path of r.paths) {
          const segments = segmentsOf(path);
          const by = coded.get(segments[0]!.name);
          if (by !== undefined) {
            refused.push({ list: id, decision: r.decision, item: r.item, path, why: `"${path}" starts at "${segments[0]!.name}", which the list's code path "${by}" names, so the reading would widen what that path projects` });
            continue;
          }
          projection.paths.push({ segments, presence: "kept", decision: r.decision });
        }
      }
      for (const item of list.items) {
        if (item.code) projection.paths.push({ segments: segmentsOf(item.text), presence: "required" });
        if (!item.code) {
          // A decision that reads this prose item joins the projection, but states no presence.
          if (!read.some((r) => r.item === item.text)) unread.push({ element: id, form: "a listed item in prose, not a path", text: item.text });
          continue;
        }
        const segments = segmentsOf(item.text);
        // Each step of the path is present: the first member in the representation, each later one in the object before it.
        for (let i = 0; i < segments.length; i++) {
          add({ element: id, text: `${s.text} … ${item.text}`, at: { root: { list: id }, path: segments.slice(0, i), member: segments[i]! }, form: "contains" });
        }
      }
    }
  }

  for (const r of readings) if (!consulted.has(r.list)) refused.push({ list: r.list, decision: r.decision, item: r.item, why: "no MUST-contain statement introduces the list, so the reading joins no projection" });

  // A MUST statement that a representation gives "whichever of" the paths its own block lists the full record declares:
  // each step of each path is optional, and the list is a projection.
  const giving = new Map<string, string>();
  for (const s of ir.statements) {
    if (!(s.level === "MUST" && /\bwhichever of\b/.test(s.text) && blockOf(s.host))) continue;
    const list = ir.identifier_lists.find((l) => l.host === s.host);
    if (!list || list.items.some((i) => !i.code)) continue;
    giving.set(s.id, list.id);
    const projection: Projection = { list: list.id, text: s.text, paths: [] };
    projections.push(projection);
    for (const item of list.items) {
      const segments = segmentsOf(item.text);
      projection.paths.push({ segments, presence: "optional" });
      for (let i = 0; i < segments.length; i++) {
        add({ element: list.id, text: `${s.text} … ${item.text}`, at: { root: { list: list.id }, path: segments.slice(0, i), member: segments[i]! }, form: "optional" });
      }
    }
  }

  // A presence statement in a row the oracle reads the presence of restates that row's constraint, or one on the member it names below the row.
  const restated: Restated[] = [];
  const presenceForms = new Set<Form>(["required", "optional", "conditional"]);
  for (const s of ir.statements) {
    const host = s.host.replace(/#.*$/, "");
    if (!/^(field|key):/.test(host) || !/^(REQUIRED|OPTIONAL|RECOMMENDED)$/.test(s.level)) continue;
    const places = rowPlaces(host);
    if (typeof places === "string") continue;
    const own = constraints.find((c) => c.element === host && presenceForms.has(c.form) && /^(REQUIRED|OPTIONAL|RECOMMENDED)\b/.test(s.text));
    const named = s.identifiers.length === 1 ? constraints.find((c) => presenceForms.has(c.form) && c.at.member.name === s.identifiers[0] && places.some((p) => placeKey(p.root, p.path) === placeKey(c.at.root, c.at.path))) : undefined;
    const c = own ?? named;
    if (c) restated.push({ element: s.id, constraint: c.id });
  }

  for (const [statement, list] of containing) {
    const c = constraints.find((x) => x.element === list && x.form === "contains");
    if (c) restated.push({ element: statement, constraint: c.id });
  }
  for (const [statement, list] of giving) {
    const c = constraints.find((x) => x.element === list && x.form === "optional");
    if (c) restated.push({ element: statement, constraint: c.id });
  }

  // Every other statement and sentence, by the form it is in, so the report lists what the oracle doesn't read.
  const read = new Set([...constraints.map((c) => c.element), ...restated.map((r) => r.element), ...readSentences]);
  const listed = new Set(unread.map((u) => u.element));
  for (const s of ir.statements) {
    if (read.has(s.id) || listed.has(s.id)) continue;
    unread.push({ element: s.id, form: statementForm(s.text), text: s.text });
  }
  for (const s of ir.sentences) {
    if (read.has(s.id) || listed.has(s.id)) continue;
    unread.push({ element: s.id, form: sentenceForm(s.text), text: s.text });
  }
  const byText = (a: { element: string; text: string }, b: { element: string; text: string }) => (a.element < b.element ? -1 : a.element > b.element ? 1 : a.text < b.text ? -1 : a.text > b.text ? 1 : 0);
  return { constraints: constraints.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), unread: unread.sort(byText), restated: restated.sort((a, b) => (a.element < b.element ? -1 : 1)), projections, refused };
}

/** A stated type in prose: "Each key takes an integer", or a member that "takes" a JSON type. */
const PROSE_TYPE = /\btakes? (?:an? )?(?:arrays? of )?(?:integers?|strings?|numbers?|booleans?|objects?)\b/;

/** The form of a statement the oracle doesn't read, for the report. */
function statementForm(text: string): string {
  if (PROSE_TYPE.test(text)) return "a type stated in prose, not in a Type cell";
  if (/MUST carry `[^`]+`, `[^`]+` or both/.test(text)) return "at least one of several members";
  if (/either .* or /.test(text) && /MUST declare/.test(text)) return "one of two forms a marked field declares";
  if (/never both|MUST NOT declare both/.test(text)) return "two members that exclude each other";
  if (/whichever of/.test(text)) return "members a summary gives where the full record declares them, with no list of paths in its block";
  if (/REQUIRED for /.test(text)) return "a presence condition in prose, not a member equal to a value";
  return "a statement about behavior or across payloads, which a rule or an obligation carries";
}

/** The form of a sentence the oracle doesn't read, for the report: a sentence has no RFC 2119 keyword, so most describe meaning. */
function sentenceForm(text: string): string {
  if (/\btakes? any code in List:/.test(text)) return "a named list whose codes the sentence doesn't write";
  if (PROSE_TYPE.test(text)) return "a type stated in prose, not in a Type cell";
  if (/^`[^`]+` is `[^`]+`/.test(text)) return "a sentence that gives a member's value in prose";
  if (/\bexamples\/\S+/.test(text)) return "a sentence that names an example file, which the examples gate checks";
  return "a sentence about meaning, with no RFC 2119 keyword";
}

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
}

/** A schema node in an emitted file: the node, the file's `$id`, and the JSON pointer to it. */
interface At {
  node: Schema;
  file: string;
  pointer: string;
}

/** A value of each JSON type a stated type doesn't have. */
const WRONG: Record<string, unknown[]> = {
  String: [0],
  Integer: ["0", 0.5],
  Number: ["0"],
  Boolean: ["true"],
  Object: ["x"],
  Timestamp: [0],
  Offset: [0],
  Enum: [{}],
};

/** A string that is neither a timestamp nor an offset, for a type that takes only strings of a format. */
const NOT_A_TIME = "not-a-time";
const FORMATTED = new Set(["Timestamp", "Offset"]);

/** The JSON type a value has, as JSON Schema names it. */
const jsonType = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

/** Whether a value has the JSON type a stated type names; a stated type says nothing about the value's range. */
export function hasStatedType(v: unknown, t: TypeExpr): boolean {
  if (t.kind === "union") return t.members.some((m) => hasStatedType(v, m));
  if (t.kind === "array") return Array.isArray(v) && v.every((x) => hasStatedType(x, t.items));
  const j = jsonType(v);
  switch (t.name) {
    case "String":
    case "Timestamp":
    case "Offset":
      return j === "string";
    case "Integer":
      return j === "integer";
    case "Number":
      return j === "integer" || j === "number";
    case "Boolean":
      return j === "boolean";
    case "Object":
      return j === "object";
    case "Enum":
      return j === "string" || j === "integer";
  }
}

/** The scalar names a type's values take, a list's by its items. */
const scalarsOf = (t: TypeExpr): string[] => (t.kind === "scalar" ? [t.name] : t.kind === "array" ? scalarsOf(t.items) : t.members.flatMap(scalarsOf));

/**
 * Values that a stated type rules out: another JSON type for each member, a
 * string of no format for a type whose every string member has a format,
 * and for a list, a list of a wrong item.
 */
export function wrongValues(t: TypeExpr): unknown[] {
  if (t.kind === "array") return ["x", ...wrongValues(t.items).filter((x) => !Array.isArray(x)).slice(0, 1).map((x) => [x])];
  const members = t.kind === "union" ? t.members : [t];
  const candidates = members.flatMap((m) => (m.kind === "scalar" ? (WRONG[m.name] ?? []) : wrongValues(m)));
  const names = members.flatMap(scalarsOf);
  const formatted = names.some((n) => FORMATTED.has(n)) && names.every((n) => n !== "String" && n !== "Enum");
  return [...candidates.filter((x) => !hasStatedType(x, t)), ...(formatted ? [NOT_A_TIME] : [])].filter((x, i, a) => a.findIndex((y) => canonicalJson(y) === canonicalJson(x)) === i);
}

/** Values of a stated type beyond the baseline's: a number with a fraction, for a type that takes any number. */
export function rightValues(t: TypeExpr): unknown[] {
  if (t.kind === "array") return rightValues(t.items).map((x) => [x]);
  return scalarsOf(t).includes("Number") ? [0.5] : [];
}

/** A word no value list lists, for an invalid value; an open vocabulary takes only a namespaced term beside its core terms. */
const UNLISTED = "unlisted_value";

/**
 * Whether a payload of the constraint's root is one the constraint rules
 * out: on some path through it, where every object on the way is present,
 * the member is absent where it is required or while its condition holds,
 * of a JSON type the stated type doesn't have, or a value no closed list
 * lists. A rule that carries a constraint must give such a payload.
 */
export function violates(c: SpecConstraint, payload: unknown): boolean {
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
        return name in o && !hasStatedType(o[name], c.type);
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
  const { ir, lock, model, files, kernel, rules, decisions, readings, schemaDir } = input;
  const { constraints, unread: unreadIr, restated, projections, refused } = readConstraints(ir, kernel.lists, readings);
  const unread = [...unreadIr];
  const v = new Validators(files);
  const make: Baselines = baselines(model, v, kernel, schemaDir);
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
  installFormats(ajv);
  for (const f of files) ajv.addSchema(f.schema);
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
  const departures = decisions.filter((d) => d.kind === "departure" && d.status !== "superseded");
  const departureOf = (element: string, form: Form) => departures.find((d) => d.covers.some((c) => c.ir === element && inScope(c.locks, lock) && (c.departs ?? []).includes(form)));
  const ruledOf = new Map((input.ruled ?? []).map((r) => [r.constraint, r.rule]));
  const ruleById = new Map(rules.rules.map((r) => [r.id, r]));

  const types = new Map(model.types.map((t) => [t.name, t]));
  /** The model type whose schema a node is, by `$id` and fragment. */
  const typeAtId = new Map(model.types.flatMap((t) => {
    const id = schemaIdOf(t, schemaDir);
    return id === null ? [] : [[id.includes("#") ? id : `${id}#`, t.name] as const];
  }));
  const typeOfAt = (at: At) => typeAtId.get(`${at.file}#${at.pointer}`);
  const rootOf = (root: SpecLocation["root"]): At | string => {
    let id: string | null = null;
    if ("owner" in root) {
      const name = root.owner === "proposal" ? "Proposal" : "LineItem";
      const t = types.get(name);
      id = t ? schemaIdOf(t, schemaDir) : null;
      if (id === null) return `no ${name} document on the lock`;
    } else {
      const t = model.types.find((x) => x.sources.includes(root.list));
      id = t ? schemaIdOf(t, schemaDir) : null;
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
    const shown = rule.vectors.invalid.some((x) => "value" in x && violates(c, (x as { value: unknown }).value));
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
        if (!hasStatedType(value, c.type)) {
          disagree(`the stated type is ${c.text}, but the schema's value for "${name}" is ${JSON.stringify(value)}, a JSON ${jsonType(value)}`, false);
          break;
        }
        if (!expect(true, inner, `"${name}" as ${JSON.stringify(value)}`)) break;
        for (const right of rightValues(c.type)) expect(true, { ...inner, [name]: right }, `"${name}" as ${JSON.stringify(right)}, which is ${c.text},`);
        for (const wrong of wrongValues(c.type)) expect(false, { ...inner, [name]: wrong }, `"${name}" as ${JSON.stringify(wrong)}, which isn't ${c.text},`);
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
    const id = schemaIdOf(t, schemaDir);
    if (id === null || reached.has(id)) continue;
    unread.push({ element: t.sources[0] ?? t.name, form: "a closed vocabulary no closed value list the oracle reads reaches", text: `${t.name}: ${t.terms.map((x) => x.value).join(" | ")}` });
  }
  unread.sort((a, b) => (a.element < b.element ? -1 : a.element > b.element ? 1 : a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  return { constraints, unread, restated, vectors: counts, disagreements, departed, ruled, problems };
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
    `${r.constraints.length} constraints (${byForm.map(([f, n]) => `${n} ${f}`).join(", ")}), ${vectors} vectors, ${r.restated.length} statements read through another element's constraint`,
    `${r.departed.length} disagreements a departure covers${by.size > 0 ? `: ${[...by].map(([d, n]) => `${n} by ${d}`).join(", ")}` : ""}`,
    `${r.ruled.length} left to a listed rule${r.ruled.length > 0 ? ` (${[...new Set(r.ruled.map((x) => x.rule))].join(", ")})` : ""}`,
    `not read yet: ${[...unread].map(([f, n]) => `${n} ${f}`).join("; ")}`,
  ].join("; ");
}
