/**
 * The fidelity oracle's readers of OpenProposal's text (src/fidelity.ts):
 * the constraints its IR states in a form that needs no judgment, and what
 * each type its Type cells name accepts.
 */

import { parse as parseYaml } from "yaml";
import { canonicalJson } from "../../canonical.ts";
import { jsonType, pathText, type ConstraintReader, type Form, type Projection, type Reading, type Refused, type Restated, type SpecConstraint, type SpecLocation, type Unread } from "../../fidelity.ts";
import type { PathSegment } from "../../grammar/path.ts";
import type { Presence, PresenceClause } from "../../grammar/required.ts";
import type { TypeExpr } from "../../grammar/type-expr.ts";
import type { Key, SpecIR, ValueList } from "../../ir-types.ts";
import type { Lists } from "../../lists.ts";
import type { ScalarType } from "./type-cell.ts";

type Schema = Record<string, unknown>;
const isMap = (v: unknown): v is Schema => v !== null && typeof v === "object" && !Array.isArray(v);
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

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


// Stated types --------------------------------------------------------------

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


/** Whether a value has the JSON type a stated type names; a stated type says nothing about the value's range. */
export function hasStatedType(v: unknown, t: TypeExpr): boolean {
  if (t.kind === "union") return t.members.some((m) => hasStatedType(v, m));
  if (t.kind === "array") return Array.isArray(v) && v.every((x) => hasStatedType(x, t.items));
  const j = jsonType(v);
  switch (t.name as ScalarType) {
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

/** OpenProposal's readers for the fidelity oracle. */
export const FIDELITY: ConstraintReader = { readConstraints, hasStatedType, wrongValues, rightValues };
