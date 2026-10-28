import { stripArrays } from "./grammar/path.ts";
import { typeMentions } from "./grammar/type-expr.ts";
import type { Field, IrObjectForm, Loc, SpecIR, ValueList } from "./ir-types.ts";
import { heldOwnerOf } from "./owners.ts";
import type { SectionIds } from "./specs/plugin.ts";

/** Every kind of finding the lint reports. Findings are data; none of them fails the build. */
export const FINDING_KINDS = [
  "appendix_a_missing",
  "appendix_a_row_missing",
  "appendix_a_row_extra",
  "appendix_a_mismatch",
  "appendix_a_order",
  "appendix_b_missing",
  "appendix_b_row_missing",
  "appendix_b_row_extra",
  "appendix_b_count",
  "appendix_b_fields",
  "appendix_b_distribution",
  "appendix_b_distribution_unparsed",
  "duplicate_field_disagrees",
  "name_reused_with_different_values",
  "value_set_duplicate",
  "value_set_subset",
  "value_list_duplicate_code",
  "unresolved_identifier",
  "array_suffix_mismatch",
  "expression_value_unknown",
  "object_without_structure",
  "option_shape_missing",
  "enum_without_values",
  "must_without_field",
  "marker_undefined",
  "key_presence_unstated",
  "key_required_is_marker",
  "presence_unstated",
  "unnumbered_heading",
  "section_anchor_irregular",
  "list_without_codes",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export interface Finding {
  id: string;
  kind: FindingKind;
  message: string;
  subjects: string[];
  locs: Loc[];
  details: Record<string, unknown>;
  disposition: { verdict: string; reason: string } | null;
}

/** A place a name is defined, for identifier resolution. */
interface Definer {
  kind: "field" | "field_parent" | "key" | "member" | "value" | "marker";
  id: string;
  /** The name as written there, with any `[]`. */
  written: string;
  /** Defined in a table row (true) or only in prose (false). */
  table: boolean;
}

/** A field owner in prose: its words, as `line_item` is "line item". */
const ownerLabel = (owner: string): string => owner.replaceAll("_", " ");
const BUYER_MARKERS = ["selectable", "settable", "supplied", "requestable"];

/** Runs every stage 2 check over the IR. Deterministic: findings are sorted by kind, then id. */
/** What the lint checks beyond what every text has: the appendices, where the profile turns them on, and section numbers, where the plugin says the text numbers its headings. */
export interface LintOptions {
  appendices: boolean;
  sections: SectionIds;
}

export function lint(ir: SpecIR, own: ((ir: SpecIR) => Omit<Finding, "disposition">[]) | undefined, opts: LintOptions): Finding[] {
  const out: Finding[] = [];
  const add = (f: Omit<Finding, "disposition">) => out.push({ ...f, disposition: null });
  // The specification's own checks, which its plugin gives.
  for (const f of own?.(ir) ?? []) add(f);
  const universe = buildUniverse(ir);

  if (opts.appendices) {
    appendixA(ir, add);
    appendixB(ir, add);
  }
  duplicates(ir, add);
  valueSets(ir, add);
  identifiers(ir, universe, add);
  structure(ir, add);
  musts(ir, universe, add);
  markersAndPresence(ir, add, opts.sections === "numbered");

  const seen = new Set<string>();
  for (const f of out) {
    if (seen.has(f.id)) throw new Error(`lint produced duplicate finding id "${f.id}"`);
    seen.add(f.id);
  }
  const order = (k: FindingKind) => FINDING_KINDS.indexOf(k);
  return out.sort((a, b) => order(a.kind) - order(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

type Add = (f: Omit<Finding, "disposition">) => void;

// ----- Appendix A and B -----

function label(f: { names: { path: string }[] }): string {
  return f.names.map((n) => "`" + n.path + "`").join(" · ");
}

function sectionOf(ir: SpecIR, id: string) {
  return ir.sections.find((s) => s.id === id)!;
}

function appendixA(ir: SpecIR, add: Add): void {
  const a = ir.appendix_a;
  if (!a) {
    add({ id: "appendix_a_missing", kind: "appendix_a_missing", message: "The specification has no Appendix A table.", subjects: [], locs: [], details: {} });
    return;
  }
  const used = new Set<string>();
  const matched: string[] = [];
  for (const f of ir.fields) {
    const section = sectionOf(ir, f.loc.section);
    const row = a.rows.find((r) => !used.has(r.id) && label(r) === label(f) && r.section_number === section.number);
    if (!row) {
      add({
        id: `appendix_a_row_missing:${f.id}`,
        kind: "appendix_a_row_missing",
        message: `Appendix A has no row for ${label(f)} in § ${section.number}.`,
        subjects: [f.id],
        locs: [f.loc],
        details: {},
      });
      continue;
    }
    used.add(row.id);
    matched.push(row.id);
    const pairs: [string, string, string][] = [
      ["section", section.heading, row.section_cell],
      ["type", f.type.raw, row.type.raw],
      ["marker", f.marker ?? "", row.marker],
    ];
    for (const [attr, body, appendix] of pairs) {
      if (body === appendix) continue;
      add({
        id: `appendix_a_mismatch:${f.id}:${attr}`,
        kind: "appendix_a_mismatch",
        message: `Appendix A gives ${label(f)} the ${attr} "${appendix}"; the body says "${body}".`,
        subjects: [f.id, row.id],
        locs: [f.loc, row.loc],
        details: { attribute: attr, body, appendix },
      });
    }
  }
  for (const r of a.rows) {
    if (used.has(r.id)) continue;
    add({
      id: `appendix_a_row_extra:${r.id}`,
      kind: "appendix_a_row_extra",
      message: `Appendix A lists ${label(r)} in "${r.section_cell}", which has no such body row.`,
      subjects: [r.id],
      locs: [r.loc],
      details: { section: r.section_cell, type: r.type.raw, marker: r.marker },
    });
  }
  const inAppendixOrder = a.rows.map((r) => r.id).filter((id) => used.has(id));
  if (inAppendixOrder.join() !== matched.join()) {
    add({
      id: "appendix_a_order",
      kind: "appendix_a_order",
      message: "Appendix A rows are not in body document order.",
      subjects: [a.table],
      locs: [a.rows[0]!.loc],
      details: { body_order: matched, appendix_order: inAppendixOrder },
    });
  }
}

function appendixB(ir: SpecIR, add: Add): void {
  const b = ir.appendix_b;
  if (!b) {
    add({ id: "appendix_b_missing", kind: "appendix_b_missing", message: "The specification has no Appendix B table.", subjects: [], locs: [], details: {} });
    return;
  }
  const labelCount = new Map<string, number>();
  for (const f of ir.fields) labelCount.set(label(f), (labelCount.get(label(f)) ?? 0) + 1);
  const expected = new Map<string, string[]>();
  for (const f of ir.fields) {
    const l = labelCount.get(label(f))! > 1 ? `${label(f)} (${ownerLabel(f.owner)})` : label(f);
    const marker = f.marker ?? "";
    expected.set(marker, [...(expected.get(marker) ?? []), l]);
  }
  for (const [marker, fields] of expected) {
    const row = b.rows.find((r) => r.marker === marker);
    if (!row) {
      add({
        id: `appendix_b_row_missing:${marker}`,
        kind: "appendix_b_row_missing",
        message: `Appendix B has no row for marker "${marker}", which ${fields.length} body fields carry.`,
        subjects: [],
        locs: [],
        details: { fields },
      });
      continue;
    }
    const listed = row.fields.map((f) => f.label);
    if (row.count !== fields.length || row.count !== listed.length) {
      add({
        id: `appendix_b_count:${marker}`,
        kind: "appendix_b_count",
        message: `Appendix B counts ${row.count_cell} "${marker}" fields; the body has ${fields.length} and the row lists ${listed.length}.`,
        subjects: [row.id],
        locs: [row.loc],
        details: { count_cell: row.count_cell, body: fields.length, listed: listed.length },
      });
    }
    if (listed.join("\n") !== fields.join("\n")) {
      add({
        id: `appendix_b_fields:${marker}`,
        kind: "appendix_b_fields",
        message: `Appendix B's "${marker}" field list differs from the body.`,
        subjects: [row.id],
        locs: [row.loc],
        details: {
          missing: fields.filter((f) => !listed.includes(f)),
          extra: listed.filter((f) => !fields.includes(f)),
          order_differs: listed.length === fields.length && listed.every((l) => fields.includes(l)),
        },
      });
    }
  }
  for (const r of b.rows) {
    if (expected.has(r.marker)) continue;
    add({
      id: `appendix_b_row_extra:${r.marker}`,
      kind: "appendix_b_row_extra",
      message: `Appendix B has a row for marker "${r.marker}", which no body field carries.`,
      subjects: [r.id],
      locs: [r.loc],
      details: {},
    });
  }
  const d = b.distribution;
  if (!d) {
    add({
      id: "appendix_b_distribution_unparsed",
      kind: "appendix_b_distribution_unparsed",
      message: `The "What the distribution says" figures can't be read; the sentences no longer match the expected wording.`,
      subjects: [b.table],
      locs: [],
      details: {},
    });
    return;
  }
  const n = (m: string) => expected.get(m)?.length ?? 0;
  const total = ir.fields.length;
  const buyer = BUYER_MARKERS.reduce((sum, m) => sum + n(m), 0);
  const want: Record<string, number> = {
    total,
    buyer,
    selectable: n("selectable"),
    settable: n("settable"),
    supplied: n("supplied"),
    requestable: n("requestable"),
    remaining: total - buyer,
    round_trip: n("requestable"),
    up_front: buyer - n("requestable"),
  };
  for (const [figure, value] of Object.entries(want)) {
    const stated = (d as unknown as Record<string, number>)[figure]!;
    if (stated === value) continue;
    add({
      id: `appendix_b_distribution:${figure}`,
      kind: "appendix_b_distribution",
      message: `"What the distribution says" states ${stated} for ${figure}; the body gives ${value}.`,
      subjects: [b.table],
      locs: [d.loc],
      details: { figure, stated, body: value },
    });
  }
}

// ----- Duplicates and value sets -----

function listsOf(ir: SpecIR, ids: string[]): ValueList[] {
  return ids.map((id) => ir.value_lists.find((v) => v.id === id)!);
}

const setKey = (v: ValueList) => [...new Set(v.items.map((i) => i.value))].sort().join(" | ");

function duplicates(ir: SpecIR, add: Add): void {
  const byPath = new Map<string, Field[]>();
  for (const f of ir.fields) {
    const k = f.names.map((n) => n.path).join(",");
    byPath.set(k, [...(byPath.get(k) ?? []), f]);
  }
  for (const [path, fields] of byPath) {
    if (fields.length < 2) continue;
    const shape = (f: Field) => ({
      type: f.type.raw,
      marker: f.marker,
      values: listsOf(ir, f.value_lists).filter((v) => v.origin === "table_cell" && v.subject === null).map(setKey),
    });
    const shapes = fields.map(shape);
    const differs = (attr: keyof ReturnType<typeof shape>) => new Set(shapes.map((s) => JSON.stringify(s[attr]))).size > 1;
    const attrs = (["type", "marker", "values"] as const).filter(differs);
    if (attrs.length === 0) continue;
    add({
      id: `duplicate_field_disagrees:${path}`,
      kind: "duplicate_field_disagrees",
      message: `\`${path}\` is defined ${fields.length} times, and the definitions differ in ${attrs.join(", ")}.`,
      subjects: fields.map((f) => f.id),
      locs: fields.map((f) => f.loc),
      details: { differs: attrs, definitions: Object.fromEntries(fields.map((f, i) => [f.id, shapes[i]])) },
    });
  }

  // The same name carrying different value sets in different places: fields, keys, and inline object members.
  const byName = new Map<string, { owner: string; values: string }[]>();
  const note = (name: string, owner: string, v: ValueList) =>
    byName.set(stripArrays(name), [...(byName.get(stripArrays(name)) ?? []), { owner, values: setKey(v) }]);
  for (const f of ir.fields) {
    for (const v of listsOf(ir, f.value_lists)) if (v.origin === "table_cell" && v.subject === null) note(f.names[0]!.segments.at(-1)!.name, f.id, v);
  }
  for (const k of ir.keys) for (const v of listsOf(ir, k.value_lists)) note(k.key.segments.at(-1)!.name, k.id, v);
  for (const v of ir.value_lists) if (v.origin === "inline_object") note(v.subject!.identifier.split(".").at(-1)!, v.id, v);
  for (const [name, uses] of byName) {
    const sets = new Set(uses.map((u) => u.values));
    if (sets.size < 2) continue;
    const owners = uses.map((u) => u.owner);
    if (byPath.get(name)?.length === uses.length && uses.every((u) => u.owner.startsWith("field:"))) continue; // Reported above.
    add({
      id: `name_reused_with_different_values:${name}`,
      kind: "name_reused_with_different_values",
      message: `\`${name}\` names ${sets.size} different value sets.`,
      subjects: owners,
      locs: owners.map((o) => locOf(ir, o)),
      details: { uses: Object.fromEntries(uses.map((u) => [u.owner, u.values])) },
    });
  }
}

function valueSets(ir: SpecIR, add: Add): void {
  // A list that gives one value twice, as a code with two meanings, leaves a receiver unable to tell which it means.
  for (const v of ir.value_lists) {
    const seen = new Map<string, (string | null)[]>();
    for (const i of v.items) seen.set(i.value, [...(seen.get(i.value) ?? []), i.annotation]);
    for (const [value, annotations] of seen) {
      if (annotations.length < 2) continue;
      const meanings = annotations.filter((a): a is string => a !== null);
      add({
        id: `value_list_duplicate_code:${v.id}:${value}`,
        kind: "value_list_duplicate_code",
        message: `The value list gives \`${value}\` ${annotations.length} times${meanings.length > 0 ? `, as ${meanings.map((m) => `"${m}"`).join(" and as ")}` : ""}, so a value of \`${value}\` doesn't say which it means.`,
        subjects: [v.id],
        locs: [v.loc],
        details: { value, annotations },
      });
    }
  }
  const groups = new Map<string, ValueList[]>();
  for (const v of ir.value_lists) groups.set(setKey(v), [...(groups.get(setKey(v)) ?? []), v]);
  for (const [key, lists] of groups) {
    if (lists.length < 2) continue;
    add({
      id: `value_set_duplicate:${key}`,
      kind: "value_set_duplicate",
      message: `The value set ${key} is declared ${lists.length} times.`,
      subjects: lists.map((l) => l.id),
      locs: lists.map((l) => l.loc),
      details: { values: key.split(" | ") },
    });
  }
  const sets = [...groups.entries()].map(([key, lists]) => ({ key, values: new Set(key.split(" | ")), lists }));
  for (const sub of sets) {
    const supers = sets.filter((sup) => sup.values.size > sub.values.size && [...sub.values].every((v) => sup.values.has(v)));
    if (supers.length === 0) continue;
    add({
      id: `value_set_subset:${sub.key}`,
      kind: "value_set_subset",
      message: `The value set ${sub.key} is a strict subset of ${supers.map((s) => s.key).join("; and of ")}.`,
      subjects: [...sub.lists.map((l) => l.id), ...supers.flatMap((s) => s.lists.map((l) => l.id))],
      locs: sub.lists.map((l) => l.loc),
      details: { subset: [...sub.values], supersets: supers.map((s) => ({ values: [...s.values], lists: s.lists.map((l) => l.id) })) },
    });
  }
}

// ----- Identifier resolution -----

interface Universe {
  names: Map<string, Definer[]>;
  paths: Map<string, Definer[]>;
  /** The one value each field or key row declares beside prose, by the row's ID: a value of that row's field only, never a name elsewhere. */
  oneValues: Map<string, Set<string>>;
}

/** A clause of prose with no code span that ends in "or" and one term, as "IANA time zone name, or `viewer_local`". */
const ONE_VALUE = /(?:^|[.;]\s)[^`.;]*\bor `([a-z][a-z0-9_]*)`/g;

function buildUniverse(ir: SpecIR): Universe {
  const names = new Map<string, Definer[]>();
  const paths = new Map<string, Definer[]>();
  const put = (map: Map<string, Definer[]>, key: string, d: Definer) => map.set(stripArrays(key), [...(map.get(stripArrays(key)) ?? []), d]);
  const inTable = (host: string) => !host.startsWith("block:");
  for (const f of ir.fields) {
    for (const n of f.names) {
      n.segments.forEach((s, i) => {
        const last = i === n.segments.length - 1;
        put(names, s.name, { kind: last ? "field" : "field_parent", id: f.id, written: s.name + (s.array ? "[]" : ""), table: true });
      });
      put(paths, n.path, { kind: "field", id: f.id, written: n.path, table: true });
      // A row's owner is a name its table defines, so a path through it, as the Deals API's `deal.id`, resolves.
      put(names, f.owner, { kind: "field_parent", id: f.id, written: f.owner, table: true });
      put(paths, `${f.owner}.${n.path}`, { kind: "field", id: f.id, written: `${f.owner}.${n.path}`, table: true });
    }
  }
  for (const k of ir.keys) {
    const last = k.key.segments.at(-1)!;
    put(names, last.name, { kind: "key", id: k.id, written: k.key.path, table: true });
    const p = ir.tables.find((t) => t.id === k.loc.table)!.parent;
    const parent = p?.identifier;
    if (parent) put(paths, `${parent}.${k.key.path}`, { kind: "key", id: k.id, written: `${parent}.${k.key.path}`, table: true });
    // An object a heading names, as AdCOM's `Object: Ad`, is a name its table defines.
    if (parent && p.via === "object") put(names, parent, { kind: "field_parent", id: k.id, written: parent, table: true });
  }
  for (const o of ir.inline_objects) {
    const table = inTable(o.host);
    const field = ir.fields.find((f) => o.host.startsWith(f.id + "#"));
    const prefix = field ? [field.names[0]!.path, ...(o.anchor ? [o.anchor] : [])].join(".") : null;
    const walk = (form: IrObjectForm, path: string[]) => {
      for (const m of form.members) {
        const written = [...path, m.key + (m.array ? "[]" : "")];
        put(names, m.key, { kind: "member", id: o.id, written: written.join("."), table });
        if (prefix) put(paths, `${prefix}.${written.join(".")}`, { kind: "member", id: o.id, written: `${prefix}.${written.join(".")}`, table });
        if (m.value?.kind === "object") walk(m.value.object, written);
      }
    };
    walk(o.form, []);
  }
  for (const v of ir.value_lists) {
    for (const i of v.items) put(names, i.value, { kind: "value", id: v.id, written: i.value, table: inTable(v.host) });
  }
  // A row may declare one value beside prose, as "IANA time zone name, or `viewer_local`": a value list of one, of that
  // row's field only. It isn't a name, so it resolves only where the row writes it and as the value of an expression on
  // the row's field, never as an identifier elsewhere.
  const oneValues = new Map<string, Set<string>>();
  for (const row of [...ir.fields.map((f) => ({ id: f.id, text: f.description.text })), ...ir.keys.map((k) => ({ id: k.id, text: k.meaning.text }))]) {
    for (const m of row.text.matchAll(ONE_VALUE)) oneValues.set(row.id, new Set([...(oneValues.get(row.id) ?? []), m[1]!]));
  }
  for (const d of ir.definitions) put(names, d.value, { kind: "value", id: d.id, written: d.value, table: true });
  for (const m of ir.markers) put(names, m.marker, { kind: "marker", id: m.id, written: m.marker, table: true });
  // The § 3.1 structure keys apply to every selectable field, so `formats.included[]` resolves.
  for (const k of ir.keys) {
    const t = ir.tables.find((tt) => tt.id === k.loc.table)!;
    if (t.parent?.via !== "section") continue;
    for (const f of ir.fields) {
      if (f.marker !== "selectable" && f.names[0]!.path !== "geo") continue;
      put(paths, `${f.names[0]!.path}.${k.key.path}`, { kind: "key", id: k.id, written: `${f.names[0]!.path}.${k.key.path}`, table: true });
    }
  }
  return { names, paths, oneValues };
}

interface Resolution {
  definers: Definer[];
  /** The occurrence's `[]` differs from every definition's. */
  arrayMismatch: string[] | null;
  /** For a dotted path with no exact match, the first segment no table defines. */
  missingSegment: string | null;
}

function resolve(u: Universe, value: string): Resolution {
  const key = stripArrays(value);
  // Every field, key, and member name is in `names` under its last segment, so a one-segment name looks there.
  const exact = key.includes(".") ? u.paths.get(key) : u.names.get(key);
  if (exact && exact.some((d) => d.table)) {
    const table = exact.filter((d) => d.table && d.kind !== "value" && d.kind !== "marker");
    const written = [...new Set(table.map((d) => (key.includes(".") ? d.written : d.written.split(".").at(-1)!)))];
    const mismatch = written.length > 0 && !written.includes(value) ? written : null;
    return { definers: exact, arrayMismatch: mismatch, missingSegment: null };
  }
  if (key.includes(".")) {
    const segs = key.split(".");
    const missing = segs.find((s) => !(u.names.get(s) ?? []).some((d) => d.table));
    if (missing === undefined) return { definers: segs.flatMap((s) => u.names.get(s)!), arrayMismatch: null, missingSegment: null };
    return { definers: [], arrayMismatch: null, missingSegment: missing };
  }
  return { definers: (exact ?? []).filter((d) => d.table), arrayMismatch: null, missingSegment: null };
}

function identifiers(ir: SpecIR, u: Universe, add: Add): void {
  const prose = new Map<string, Definer[]>();
  for (const [k, ds] of u.names) prose.set(k, ds.filter((d) => !d.table));
  const unresolved = new Map<string, { locs: Loc[]; hosts: string[]; missing: string | null }>();
  const mismatched = new Map<string, { locs: Loc[]; hosts: string[]; defined: string[] }>();
  const badValue = new Map<string, { locs: Loc[]; hosts: string[]; known: string[] }>();
  const push = <T extends { locs: Loc[]; hosts: string[] }>(map: Map<string, T>, key: string, init: () => T, loc: Loc, host: string) => {
    const e = map.get(key) ?? init();
    e.locs.push(loc);
    e.hosts.push(host);
    map.set(key, e);
  };
  for (const c of ir.code_spans) {
    if (sectionOf(ir, c.loc.section).part !== "body") continue;
    const name = c.kind === "path" ? c.value : c.kind === "expression" ? c.lhs! : null;
    if (name === null) continue;
    // The one value a row declares, where that row writes it.
    if (c.kind === "path" && u.oneValues.get(c.host.replace(/#(?:description|meaning)$/, ""))?.has(c.value)) continue;
    const r = resolve(u, name);
    if (r.definers.length === 0) {
      push(unresolved, name, () => ({ locs: [], hosts: [], missing: r.missingSegment }), c.loc, c.host);
      continue;
    }
    if (r.arrayMismatch) push(mismatched, name, () => ({ locs: [], hosts: [], defined: r.arrayMismatch! }), c.loc, c.host);
    if (c.kind === "expression") {
      const known = new Set<string>();
      for (const d of r.definers) {
        if (d.kind === "field") for (const v of listsOf(ir, ir.fields.find((f) => f.id === d.id)!.value_lists)) v.items.forEach((i) => known.add(i.value));
        if (d.kind === "key") for (const v of listsOf(ir, ir.keys.find((k) => k.id === d.id)!.value_lists)) v.items.forEach((i) => known.add(i.value));
        if (d.kind === "field" || d.kind === "key") for (const x of u.oneValues.get(d.id) ?? []) known.add(x);
        if (d.kind === "member") {
          for (const v of ir.value_lists) {
            if (v.host === d.id && v.subject?.identifier.split(".").at(-1) === stripArrays(name).split(".").at(-1)) v.items.forEach((i) => known.add(i.value));
          }
        }
      }
      // An expression may set its member to values joined by commas, as `inclinventory.adtype=1,2`, each a value the member takes.
      if (!c.rhs!.split(",").every((v) => known.has(v))) push(badValue, c.value, () => ({ locs: [], hosts: [], known: [...known].sort() }), c.loc, c.host);
    }
  }
  for (const [name, e] of unresolved) {
    const definedInProse = (prose.get(stripArrays(name)) ?? []).map((d) => d.id);
    add({
      id: `unresolved_identifier:${name}`,
      kind: "unresolved_identifier",
      message:
        `\`${name}\` resolves to no table row, key, or table-declared value` +
        (e.missing && e.missing !== stripArrays(name) ? `; no table defines \`${e.missing}\`` : "") +
        (definedInProse.length ? "; only prose declares it" : "") +
        ".",
      subjects: [...new Set(e.hosts)],
      locs: e.locs,
      details: { occurrences: e.locs.length, defined_in_prose: [...new Set(definedInProse)] },
    });
  }
  for (const [name, e] of mismatched) {
    add({
      id: `array_suffix_mismatch:${name}`,
      kind: "array_suffix_mismatch",
      message: `\`${name}\` is written without the \`[]\` its definition carries, or with one it lacks: ${e.defined.map((d) => "`" + d + "`").join(", ")}.`,
      subjects: [...new Set(e.hosts)],
      locs: e.locs,
      details: { defined_as: e.defined },
    });
  }
  for (const [expr, e] of badValue) {
    add({
      id: `expression_value_unknown:${expr}`,
      kind: "expression_value_unknown",
      message: e.known.length
        ? `\`${expr}\` uses a value that isn't in the declared set ${e.known.join(" | ")}.`
        : `\`${expr}\` uses a value, but the field declares no value list to check it against.`,
      subjects: [...new Set(e.hosts)],
      locs: e.locs,
      details: { declared: e.known },
    });
  }
}

// ----- Structure -----

function structure(ir: SpecIR, add: Add): void {
  const parented = new Set(ir.tables.map((t) => t.parent?.field).filter((f): f is string => !!f));
  for (const f of ir.fields) {
    const typeIsObject = typeMentions(f.type.parsed, "Object");
    const isEnum = typeMentions(f.type.parsed, "Enum");
    const hasObject = f.inline_objects.length > 0;
    const hasValues = f.value_lists.length > 0;
    const name = f.names[0]!.path;
    const hasSubRows = ir.fields.some((g) => g.names.some((n) => n.path.startsWith(name + ".") || n.path.startsWith(name.replace(/\[\]$/, "") + "[].")) && g !== f);
    if (isEnum && !hasValues) {
      add({
        id: `enum_without_values:${f.id}`,
        kind: "enum_without_values",
        message: `${label(f)} is typed Enum, but its row declares no backticked value list.`,
        subjects: [f.id],
        locs: [f.loc],
        details: { description: f.description.text },
      });
    }
    // A field that holds another owner's rows, as the Deals API's `terms` holds `Object: Terms`, has their structure.
    if (!typeIsObject || hasObject || parented.has(f.id) || hasSubRows || heldOwnerOf(ir, f) !== null) continue;
    if (f.marker === "selectable" || f.marker === "settable") {
      if (hasValues) continue;
      add({
        id: `option_shape_missing:${f.id}`,
        kind: "option_shape_missing",
        message: `${label(f)} is \`${f.marker}\`, but its options have no shape or value list; only prose describes them.`,
        subjects: [f.id],
        locs: [f.loc],
        details: { marker: f.marker, description: f.description.text },
      });
      continue;
    }
    add({
      id: `object_without_structure:${f.id}`,
      kind: "object_without_structure",
      message: `${label(f)} is typed ${f.type.raw}, and nothing in the specification gives its structure.`,
      subjects: [f.id],
      locs: [f.loc],
      details: { type: f.type.raw, marker: f.marker, description: f.description.text },
    });
  }
}

function musts(ir: SpecIR, u: Universe, add: Add): void {
  for (const s of ir.statements) {
    if (s.part !== "body" || !s.host.startsWith("block:")) continue;
    if (!s.keywords.some((k) => k === "MUST" || k === "MUST NOT" || k === "SHALL" || k === "SHALL NOT")) continue;
    const named = s.identifiers.some((i) => resolve(u, i).definers.some((d) => d.kind === "field" || d.kind === "key" || d.kind === "member" || d.kind === "field_parent"));
    if (named) continue;
    add({
      id: `must_without_field:${s.id}`,
      kind: "must_without_field",
      message: `A ${s.level} statement in § ${s.loc.section} names no field or key: "${s.text}"`,
      subjects: [s.id],
      locs: [s.loc],
      details: { identifiers: s.identifiers },
    });
  }
}

function markersAndPresence(ir: SpecIR, add: Add, numbered: boolean): void {
  const defined = new Set(ir.markers.map((m) => m.marker));
  const undefinedUses = new Map<string, Field[]>();
  // A field row of a text with no markers carries none, so it uses no undefined one.
  for (const f of ir.fields) if (f.marker !== undefined && !defined.has(f.marker)) undefinedUses.set(f.marker, [...(undefinedUses.get(f.marker) ?? []), f]);
  for (const [marker, fields] of undefinedUses) {
    add({
      id: `marker_undefined:${marker}`,
      kind: "marker_undefined",
      message: `${fields.length} fields carry the marker "${marker}", which the § 3 marker table doesn't define.`,
      subjects: fields.map((f) => f.id),
      locs: fields.map((f) => f.loc),
      details: { defined: [...defined] },
    });
  }
  for (const t of ir.tables) {
    if (t.layout !== "key-meaning") continue;
    const keys = ir.keys.filter((k) => k.loc.table === t.id);
    add({
      id: `key_presence_unstated:${t.id}`,
      kind: "key_presence_unstated",
      message: `The key table in § ${t.section} has no Required column, so none of its ${keys.length} keys says whether it must be present.`,
      subjects: keys.map((k) => k.id),
      locs: [{ section: t.section, line: t.line, table: t.id }],
      details: { parent: t.parent?.identifier ?? null },
    });
  }
  for (const k of ir.keys) {
    if (k.required?.parsed.kind !== "marker") continue;
    add({
      id: `key_required_is_marker:${k.id}`,
      kind: "key_required_is_marker",
      message: `\`${k.key.path}\` has the mutability marker "${k.required.raw}" in its Required column, so its presence is unstated.`,
      subjects: [k.id],
      locs: [k.loc],
      details: { required: k.required.raw },
    });
  }
  // Each owner the field rows have, in the order their first rows come.
  for (const owner of [...new Set(ir.fields.map((f) => f.owner))]) {
    const fields = ir.fields.filter((f) => f.owner === owner);
    const unstated = fields.filter((f) => f.presence === null);
    if (unstated.length === 0) continue;
    add({
      id: `presence_unstated:${owner}`,
      kind: "presence_unstated",
      message: `${unstated.length} of ${fields.length} ${ownerLabel(owner)} fields don't say whether they're REQUIRED or OPTIONAL.`,
      subjects: unstated.map((f) => f.id),
      locs: [],
      details: { stated: fields.filter((f) => f.presence !== null).map((f) => f.id) },
    });
  }
  // A text that numbers its headings cites an unnumbered one by its parent's number; a text that numbers none, as AdCOM, cites each by its anchor.
  if (numbered) for (const s of ir.sections) {
    if (s.part !== "body" || s.number !== null) continue;
    const tables = ir.tables.filter((t) => t.section === s.id).length;
    const statements = ir.statements.filter((st) => st.loc.section === s.id).length;
    add({
      id: `unnumbered_heading:${s.id}`,
      kind: "unnumbered_heading",
      message: `"${s.heading}" has no section number, so its content is cited as § ${s.parent}.`,
      subjects: [s.id],
      locs: [{ section: s.id, line: s.line }],
      details: { tables, statements },
    });
  }
}

function locOf(ir: SpecIR, id: string): Loc {
  const all = [...ir.fields, ...ir.keys, ...ir.value_lists, ...ir.inline_objects, ...ir.definitions];
  return all.find((e) => e.id === id)!.loc;
}
