/**
 * OpenProposal's notation for the round trip (src/render.ts): its tables
 * rendered from the model, so the specification and the schemas can't drift
 * apart.
 *
 * What the model owns is rendered from the model: every field's name and
 * path, its Type in the specification's notation, its marker, every key and
 * its presence, every term of a vocabulary, and, inside a description or a
 * meaning, each value list and each inline object the row holds. The prose
 * around them is the IR's, copied verbatim: the model doesn't own prose.
 * Appendix A and B, with the figures of "What the distribution says", are
 * generated whole from the model's properties.
 *
 * Rows keep the specification's order and pair with the IR row the model
 * cites as a source. A model property, term, or appendix row that cites no
 * row of the table is a row the specification lacks, appended at the end.
 *
 * Each cell is compared after normalizing whitespace, escaped pipes, and
 * backticks. A key's Required cell is compared as the presence it states
 * (type rules § 4): REQUIRED, the condition of a conditional key, the marker
 * that stands in the cell, or else OPTIONAL, RECOMMENDED included. A
 * difference is either a recorded decision in `roundtrip/differences.yaml`,
 * or the gate fails.
 */
import { citeText, indexElements, type Element } from "../../elements.ts";
import type { AppendixBRow, Definition, Field, InlineObject, IrMember, Key, MarkerDef, SpecIR, Table, ValueList } from "../../ir-types.ts";
import type { Presence, TypeRef } from "../../mapping.ts";
import { presenceOf } from "../../mapping-rules.ts";
import { conditionText, type ModelDoc, type ModelProperty, type ModelType } from "../../model.ts";
import { normalize, type RenderedRow, type RenderedTable, type RoundTripNotation } from "../../render.ts";

/** The table layouts the model renders. The § 1.1 concept table is informative, and the model holds nothing of it. */
export const RENDERED_LAYOUTS = [
  "field",
  "key-required-meaning",
  "key-meaning",
  "key-required-meaning-mapping",
  "marker-meaning",
  "value-condition",
  "value-distribution-device",
  "appendix-a",
  "appendix-b",
] as const;


/** The figures of Appendix B's "What the distribution says". */
export const FIGURES = ["total", "buyer", "selectable", "settable", "supplied", "requestable", "remaining", "round_trip", "up_front"] as const;
export type Figures = Record<(typeof FIGURES)[number], number>;

const code = (s: string | number) => `\`${s}\``;
/** A name cell as the IR keeps it, `| \`a\` · \`b\``, without its leading delimiter. */
const stripCell = (s: string) => s.replace(/^\s*\|/, "").replace(/\|\s*$/, "").trim();
const lastSegment = (path: string) => path.split(".").pop()!;
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const uniq = <T>(xs: T[]) => [...new Set(xs)];

/**
 * The Type column's word for a primitive with a `format`. The specification's
 * scalar names are JSON types, plus `Timestamp`, an RFC 3339 date-time, and
 * `Offset`, a length of time before an instant, which the kernel writes as an
 * ISO 8601 duration (D-017).
 */
const FORMAT_WORDS: Record<string, string> = { "date-time": "Timestamp", duration: "Offset" };
const JSON_WORDS: Record<string, string> = { string: "String", integer: "Integer", number: "Number", boolean: "Boolean", object: "Object", array: "Array" };

/** The markers whose fields Appendix B's distribution counts as touched by the buyer, as its sentence names them. */
const BUYER_MARKERS = ["selectable", "settable", "supplied", "requestable"] as const;

/** A key's Required cell, written as the presence it states (type rules § 4). */
export function presenceCell(presence: Presence, condition: string | undefined, marker: string | undefined): string {
  if (presence === "required") return "REQUIRED";
  if (presence === "conditional") return condition ?? "REQUIRED when (unstated)";
  return marker ?? "OPTIONAL";
}

/** The Required cell of a key row as the specification states it, in the same reading. */
function specPresenceCell(k: Key): string {
  const p = k.required?.parsed ?? null;
  const marker = p?.kind === "marker" ? p.marker : undefined;
  return presenceCell(presenceOf(k), conditionText(p), marker);
}

/** Every property of an object or a document, with the type that holds it. Profiles project documents, so they hold no row of their own. */
interface Holder {
  type: Extract<ModelType, { kind: "object" | "document" }>;
  name: string;
  property: ModelProperty;
}

class Renderer {
  readonly types: Map<string, ModelType>;
  readonly elements: Map<string, Element>;
  /** The properties that cite each IR element. */
  readonly bySource = new Map<string, Holder[]>();
  readonly problems: string[] = [];

  constructor(
    readonly model: ModelDoc,
    readonly ir: SpecIR,
  ) {
    this.types = new Map(model.types.map((t) => [t.name, t]));
    this.elements = indexElements(ir);
    for (const t of model.types) {
      // A profile and its projections restate the document's properties, so the rows render from the document alone.
      if ((t.kind !== "object" && t.kind !== "document") || (t.kind === "object" && t.projects !== undefined)) continue;
      for (const [name, property] of Object.entries(t.properties)) {
        for (const s of property.sources) this.bySource.set(s, [...(this.bySource.get(s) ?? []), { type: t, name, property }]);
      }
    }
  }

  /** The named types a type reference holds: itself, a copy's application, a union's branches, and an application's arguments. */
  held(t: TypeRef, seen = new Set<string>()): string[] {
    if (t.kind === "named") {
      if (seen.has(t.name)) return [];
      seen.add(t.name);
      const x = this.types.get(t.name);
      if (x?.kind === "copy") return [t.name, ...this.held(x.of, seen)];
      if (x?.kind === "union") return [t.name, ...x.any_of.flatMap((b) => this.held(b, seen))];
      return [t.name];
    }
    if (t.kind === "apply") return Object.values(t.arguments).flatMap((a) => this.held(a, seen));
    return [];
  }

  heldOfKind<K extends ModelType["kind"]>(t: TypeRef, kind: K): Extract<ModelType, { kind: K }>[] {
    return uniq(this.held(t))
      .map((n) => this.types.get(n))
      .filter((x): x is Extract<ModelType, { kind: K }> => x?.kind === kind);
  }

  /** The Type column's notation for a model type. */
  specType(t: TypeRef): string {
    if (t.kind === "boolean") return "Boolean";
    if (t.kind === "parameter") return t.name;
    if (t.kind === "apply") {
      if (t.constructor === "List") return `Array[${this.specType(t.arguments.T!)}]`;
      const c = this.types.get(t.constructor);
      if (c?.kind !== "constructor") return "Object";
      const branches = c.shell.anyOf as Record<string, unknown>[] | undefined;
      if (!branches) return JSON_WORDS[String(c.shell.type)] ?? "Object";
      return this.join(branches.map((b) => this.slotType(b, t.arguments)));
    }
    const x = this.types.get(t.name);
    if (!x) return t.name;
    switch (x.kind) {
      case "primitive": {
        const format = x.schema.format as string | undefined;
        return (format && FORMAT_WORDS[format]) ?? JSON_WORDS[String(x.schema.type)] ?? "String";
      }
      case "vocabulary":
        return "Enum";
      case "union":
        return this.join(x.any_of.map((b) => this.specType(b)));
      case "copy":
        return this.specType(x.of);
      default:
        return "Object";
    }
  }

  /** The notation of one shell branch: a slot, with the application's arguments, or a `$ref` to a part. */
  private slotType(branch: Record<string, unknown>, args: Record<string, TypeRef>): string {
    const slot = branch.$model as TypeRef | undefined;
    if (slot) return this.specType(slot.kind === "parameter" ? (args[slot.name] ?? slot) : slot);
    const ref = typeof branch.$ref === "string" ? branch.$ref.replace(/^#\/\$defs\//, "") : undefined;
    return ref ? this.specType({ kind: "named", name: ref }) : JSON_WORDS[String(branch.type)] ?? "Object";
  }

  private join(words: string[]): string {
    return uniq(words).join("/");
  }

  /** A property's name in a table: `[]` marks a list (type rules § 4). */
  nameOf(name: string, t: TypeRef): string {
    return t.kind === "apply" && t.constructor === "List" ? `${name}[]` : name;
  }

  /** The path to an object's properties from its document, such as `pricing[].` for `PricingEntry`. Empty for a document. */
  pathOf(name: string, seen = new Set<string>()): string | null {
    const t = this.types.get(name);
    if (t?.kind === "document") return "";
    if (seen.has(name)) return null;
    seen.add(name);
    const holders: string[] = [];
    for (const h of this.model.types) {
      if (h.kind !== "object" && h.kind !== "document") continue;
      for (const [k, p] of Object.entries(h.properties)) {
        const direct = p.type.kind === "named" && p.type.name === name;
        const listed = p.type.kind === "apply" && p.type.constructor === "List" && p.type.arguments.T?.kind === "named" && p.type.arguments.T.name === name;
        if (!direct && !listed) continue;
        const up = this.pathOf(h.name, seen);
        if (up !== null) holders.push(`${up}${this.nameOf(k, p.type)}.`);
      }
    }
    return holders.length === 1 ? holders[0]! : null;
  }

  /** The document a type's properties belong to, for Appendix B's owner label. */
  documentOf(name: string, seen = new Set<string>()): string | null {
    const t = this.types.get(name);
    if (t?.kind === "document") return name;
    if (seen.has(name)) return null;
    seen.add(name);
    for (const h of this.model.types) {
      if (h.kind !== "object" && h.kind !== "document") continue;
      if (Object.values(h.properties).some((p) => this.held(p.type).includes(name))) {
        const d = this.documentOf(h.name, seen);
        if (d) return d;
      }
    }
    return null;
  }

  /** The value lists a row writes in its own cell, in order; a member's list belongs to its inline object. */
  ownLists(ids: string[]): ValueList[] {
    return ids.map((id) => this.elements.get(id)).flatMap((e) => (e?.kind === "value_list" && e.element.origin === "table_cell" ? [e.element] : []));
  }

  inlineObjects(ids: string[]): InlineObject[] {
    return ids.map((id) => this.elements.get(id)).flatMap((e) => (e?.kind === "inline_object" ? [e.element] : []));
  }

  /** The terms of a vocabulary as a cell writes them: `\`a\` (label) | \`b\``. */
  termsCell(v: Extract<ModelType, { kind: "vocabulary" }>, quoted: boolean): string {
    return v.terms.map((t) => `${quoted ? code(t.value) : t.value}${t.annotation ? ` (${t.annotation})` : ""}`).join(" | ");
  }

  /**
   * The prose of a row with each value list and inline object it holds
   * rendered from the model. `type` is the type of the property the row
   * maps to; `inlineAsProse` keeps the inline objects as the IR writes them,
   * for a row the model holds no object for.
   */
  prose(where: string, text: string, row: { value_lists: string[]; inline_objects: string[] }, type: TypeRef | null, elements: string[], inlineAsProse = false): string {
    const holes: { at: number; length: number; text: string }[] = [];
    let from = 0;
    const place = (irForm: string, rendered: string) => {
      const at = text.indexOf(irForm, from);
      if (at < 0) {
        this.problems.push(`${where}: can't find "${irForm}" in the cell's text`);
        return;
      }
      holes.push({ at, length: irForm.length, text: rendered });
      from = at + irForm.length;
    };
    const lists = this.ownLists(row.value_lists);
    const objects = inlineAsProse ? [] : this.inlineObjects(row.inline_objects);
    const ordered = [...lists.map((l) => ({ l })), ...objects.map((o) => ({ o }))].sort((a, b) => {
      const ia = text.indexOf("l" in a ? citeText({ kind: "value_list", element: a.l! }) : a.o!.text);
      const ib = text.indexOf("l" in b ? citeText({ kind: "value_list", element: b.l! }) : b.o!.text);
      return ia - ib;
    });
    const targets = new Map<InlineObject, Extract<ModelType, { kind: "object" }> | null>();
    for (const o of objects) targets.set(o, type ? this.objectFor(o, type) : null);
    for (const item of ordered) {
      if ("l" in item) {
        const l = item.l!;
        elements.push(l.id);
        const vocabularies = type ? this.heldOfKind(type, "vocabulary") : [];
        // A JSON boolean's two values are `false` and `true`.
        const rendered = type?.kind === "boolean" ? "`false` | `true`" : vocabularies.length === 1 ? this.termsCell(vocabularies[0]!, true) : (this.codesCell(type) ?? this.memberEnum(l, type));
        place(citeText({ kind: "value_list", element: l }), rendered);
      } else {
        const o = item.o!;
        elements.push(o.id);
        const target = targets.get(o) ?? null;
        const siblings = objects.filter((x) => targets.get(x) === target);
        // An inline object no model object describes may be a kernel part the row's type holds, such as a daypart window.
        const parts = target === null && type ? this.heldOfKind(type, "part") : [];
        place(o.text, target ? this.objectText(o, target, siblings) : parts.length === 1 ? this.partText(o, parts[0]!) : "");
      }
    }
    let out = "";
    let at = 0;
    for (const h of holes.sort((a, b) => a.at - b.at)) {
      out += text.slice(at, h.at) + h.text;
      at = h.at + h.length;
    }
    return out + text.slice(at);
  }

  /** The model object an inline object describes: among the objects the row's type holds, the one that cites it. */
  objectFor(o: InlineObject, type: TypeRef): Extract<ModelType, { kind: "object" }> | null {
    const candidates = this.heldOfKind(type, "object");
    const citing = candidates.filter((c) => c.sources.includes(o.id) || Object.values(c.properties).some((p) => p.sources.includes(o.id)));
    if (citing.length === 1) return citing[0]!;
    return candidates.length === 1 ? candidates[0]! : null;
  }

  /**
   * An object's members, written as the inline object writes them: in the
   * IR's order, then the members the IR doesn't write. Where several inline
   * objects in one row describe one object, each writes the members that
   * cite it, and the last also writes the members that cite none of them.
   */
  objectText(o: InlineObject, target: Extract<ModelType, { kind: "object" }>, siblings: InlineObject[]): string {
    const ids = new Set(siblings.map((s) => s.id));
    const entries = Object.entries(target.properties).filter(([, p]) => {
      if (siblings.length === 1) return true;
      if (p.sources.includes(o.id)) return true;
      return o === siblings[siblings.length - 1] && !p.sources.some((s) => ids.has(s));
    });
    const members = orderBy(entries, o.form.members.map((m) => m.key));
    return `{ ${members.map(([name, p]) => this.memberText(o.id, name, p, o.form.members.find((m) => m.key === name))).join(", ")} }`;
  }

  /** A primitive's titled codes, as `IntegerFlag`'s, in the tables' notation: each code with its name in parentheses, in lower case, as "`0` (no) | `1` (yes)"; null for any other type. */
  codesCell(type: TypeRef | null): string | null {
    const t = type?.kind === "named" ? this.types.get(type.name) : undefined;
    if (t?.kind !== "primitive" || !Array.isArray(t.schema.oneOf)) return null;
    return (t.schema.oneOf as { const: number; title: string }[]).map((b) => `${code(String(b.const))} (${b.title.toLowerCase()})`).join(" | ");
  }

  /**
   * The values a value list gives a member of a part the row's type holds,
   * from the primitive the member's items are, as a daypart window's
   * `days[]` from `monday` | … | `sunday` are a `DayName`; or nothing.
   */
  memberEnum(l: ValueList, type: TypeRef | null): string {
    if (type === null || l.subject === null) return "";
    const member = l.subject.identifier.replace(/\[\]$/, "");
    const names = this.heldOfKind(type, "part").flatMap((part) => {
      const p = ((part.schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {})[member];
      const at = p && typeof p.items === "object" && p.items !== null ? (p.items as Record<string, unknown>) : p;
      const ref = typeof at?.$ref === "string" ? at.$ref.split("/").at(-1)! : null;
      return ref === null ? [] : [ref];
    });
    const enums = uniq(names).flatMap((n) => {
      const t = this.types.get(n);
      return t?.kind === "primitive" && Array.isArray(t.schema.enum) ? [t.schema.enum as (string | number)[]] : [];
    });
    return enums.length === 1 ? enums[0]!.map((v) => code(String(v))).join(" | ") : "";
  }

  /** A part's members, from its schema, in the IR's order: each name, with `[]` for a list. */
  partText(o: InlineObject, part: Extract<ModelType, { kind: "part" }>): string {
    const props = (part.schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    const members = orderBy(Object.entries(props), o.form.members.map((m) => m.key));
    return `{ ${members.map(([name, p]) => `${name}${p.type === "array" ? "[]" : ""}`).join(", ")} }`;
  }

  /** One member: its name, `[]` for a list, and the values or members it writes inline. */
  memberText(objectId: string, name: string, p: ModelProperty, ir: IrMember | undefined): string {
    const head = this.nameOf(name, p.type);
    const listId = `${objectId}/${name}`;
    const own = this.heldOfKind(p.type, "vocabulary").filter((v) => v.sources.includes(listId));
    if (own.length === 1) return `${head}: ${this.termsCell(own[0]!, false)}`;
    if (p.type.kind === "apply" && p.type.constructor !== "List" && p.type.constructor !== "Map") {
      const c = this.types.get(p.type.constructor);
      const props = c?.kind === "constructor" ? Object.keys((c.shell.properties as Record<string, unknown> | undefined) ?? {}) : [];
      if (props.length > 0) {
        const order = ir?.value?.kind === "object" ? ir.value.object.members.map((m) => m.key) : [];
        return `${head}: { ${orderBy(props.map((k) => [k, k] as [string, string]), order).map(([k]) => k).join(", ")} }`;
      }
    }
    return head;
  }
}

/** Entries in the IR's order of their keys, then the rest by name. */
function orderBy<T>(entries: [string, T][], order: string[]): [string, T][] {
  const rank = (k: string) => {
    const i = order.indexOf(k);
    return i < 0 ? order.length : i;
  };
  return [...entries].sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** The rows of a table, in the specification's order. */
function rowsOf<T extends { loc: { table?: string; row?: number } }>(xs: T[], table: Table): T[] {
  return xs.filter((x) => x.loc.table === table.id).sort((a, b) => (a.loc.row ?? 0) - (b.loc.row ?? 0));
}

/** The cells of one IR row, as the specification writes them, in the comparison's reading of the Required column. */
function specCells(e: Element, layout: string): string[] {
  switch (e.kind) {
    case "field": {
      const f = e.element;
      return [stripCell(f.name_cell), f.type.raw, f.marker ?? "", f.description.text];
    }
    case "key": {
      const k = e.element;
      return [code(lastSegment(k.key.path)), ...(layout.startsWith("key-required") ? [specPresenceCell(k)] : []), k.meaning.text, ...(k.mapping ? [k.mapping.text] : [])];
    }
    case "marker":
      return [code(e.element.marker), e.element.meaning.text];
    case "definition":
      return [code(e.element.value), ...e.element.columns.map((c) => c.text)];
    case "appendix_a": {
      const a = e.element;
      return [stripCell(a.name_cell), a.section_cell, a.type.raw, a.marker];
    }
    case "appendix_b": {
      const b = e.element;
      return [b.marker, b.count_cell, b.meaning, b.fields.map((f) => f.label).join(", ")];
    }
    default:
      return [];
  }
}

/** The specification's rendered tables, from the IR rows they hold. */
export function specTables(ir: SpecIR): RenderedTable[] {
  const elements = indexElements(ir);
  const rowKinds: Element["kind"][] = ["field", "key", "marker", "definition", "appendix_a", "appendix_b"];
  const all = [...elements.values()].filter((e) => rowKinds.includes(e.kind) && "loc" in e.element && e.element.loc.table !== undefined);
  return ir.tables
    .filter((t) => (RENDERED_LAYOUTS as readonly string[]).includes(t.layout))
    .map((t) => ({
      id: t.id,
      layout: t.layout,
      section: t.section,
      header: t.header,
      rows: all
        .filter((e) => e.element.loc.table === t.id)
        .sort((a, b) => (a.element.loc.row ?? 0) - (b.element.loc.row ?? 0))
        .map((e) => ({ row: e.element.id, cells: specCells(e, t.layout), elements: [e.element.id] })),
    }));
}

/** One body field row's rendering: the properties that cite it, in the IR's order of their names. */
interface FieldRendering {
  field: Field;
  holders: Holder[];
  name: string;
  type: string;
  marker: string;
}

/** Renders every table the model owns, in the specification's tables and order. */
export function renderTables(model: ModelDoc, ir: SpecIR): { tables: RenderedTable[]; figures: Figures | null; problems: string[] } {
  const r = new Renderer(model, ir);
  const tables: RenderedTable[] = [];
  const shown = new Set<Holder["property"]>();

  // The field rows, which Appendix A and B list again.
  const fieldRows = new Map<string, FieldRendering>();
  const renderField = (f: Field): FieldRendering => {
    const holders = orderBy(
      (r.bySource.get(f.id) ?? []).map((h) => [h.name, h] as [string, Holder]),
      f.names.map((n) => lastSegment(n.path).replaceAll("[]", "")),
    ).map(([, h]) => h);
    for (const h of holders) shown.add(h.property);
    const names = holders.map((h) => {
      const path = r.pathOf(h.type.name);
      if (path === null) r.problems.push(`${f.id}: no single path from a document to "${h.type.name}"`);
      return code(`${path ?? "?."}${r.nameOf(h.name, h.property.type)}`);
    });
    return {
      field: f,
      holders,
      name: names.join(" · "),
      type: uniq(holders.map((h) => r.specType(h.property.type))).join(" · "),
      marker: uniq(holders.map((h) => h.property.marker ?? "")).join(" · "),
    };
  };
  for (const f of ir.fields) fieldRows.set(f.id, renderField(f));

  /** A property the model holds with no row of a table, written in that table's columns. */
  const extraRow = (owner: string, name: string, p: ModelProperty, cells: string[]): RenderedRow => ({ row: `${owner}.${name}`, cells, elements: [...p.sources] });

  const fieldTables = ir.tables.filter((t) => t.layout === "field");
  /** The objects and documents whose properties field rows give, with the last table that holds one of their rows. */
  const lastTable = new Map<string, string>();
  for (const t of fieldTables) for (const f of rowsOf(ir.fields, t)) for (const h of fieldRows.get(f.id)!.holders) lastTable.set(h.type.name, t.id);

  for (const t of ir.tables) {
    if (!(RENDERED_LAYOUTS as readonly string[]).includes(t.layout)) continue;
    const rows: RenderedRow[] = [];
    switch (t.layout) {
      case "field": {
        for (const f of rowsOf(ir.fields, t)) {
          const fr = fieldRows.get(f.id)!;
          const elements = [f.id, ...fr.holders.flatMap((h) => h.property.sources)];
          const type = fr.holders[0]?.property.type ?? null;
          const description = r.prose(f.id, f.description.text, f, type, elements);
          rows.push({ row: f.id, cells: fr.holders.length === 0 ? [] : [fr.name, fr.type, fr.marker, description], elements: sorted(elements) });
        }
        for (const [owner, last] of lastTable) {
          if (last !== t.id) continue;
          const o = r.types.get(owner) as Holder["type"];
          for (const [name, p] of Object.entries(o.properties)) {
            if (p.sources.some((s) => fieldRows.has(s))) continue;
            rows.push(extraRow(owner, name, p, [code(`${r.pathOf(owner) ?? "?."}${r.nameOf(name, p.type)}`), r.specType(p.type), p.marker ?? "", p.description ?? ""]));
          }
        }
        break;
      }
      case "key-required-meaning":
      case "key-meaning":
      case "key-required-meaning-mapping": {
        const keys = rowsOf(ir.keys, t);
        const required = t.layout.startsWith("key-required");
        const owners = uniq(keys.flatMap((k) => (r.bySource.get(k.id) ?? []).map((h) => h.type)));
        if (owners.length > 1) r.problems.push(`${t.id}: its rows are properties of ${owners.map((o) => o.name).join(", ")}; a key table describes one object`);
        const owner = owners.length === 1 ? owners[0]! : null;
        const constructor = owner ? null : model.types.find((c) => c.kind === "constructor" && keys.every((k) => c.sources.includes(k.id)));
        for (const k of keys) {
          const elements = [k.id];
          const mapping = k.mapping ? [k.mapping.text] : [];
          const h = owner ? (r.bySource.get(k.id) ?? []).find((x) => x.type === owner) : undefined;
          if (h) {
            elements.push(...h.property.sources);
            const p = h.property;
            const meaning = r.prose(k.id, k.meaning.text, k, p.type, elements);
            rows.push({ row: k.id, cells: [code(r.nameOf(h.name, p.type)), ...(required ? [presenceCell(p.presence, p.condition, p.marker)] : []), meaning, ...mapping], elements: sorted(elements) });
            continue;
          }
          const shell = constructor?.kind === "constructor" ? constructor.shell : null;
          const name = lastSegment(k.key.path).replaceAll("[]", "");
          const slot = (shell?.properties as Record<string, { $model?: TypeRef }> | undefined)?.[name]?.$model;
          if (!shell || !slot) {
            rows.push({ row: k.id, cells: [], elements });
            continue;
          }
          // A constructor's keys are its shell's properties. Its map key, such as § 3.1's `option_id`, names an option, which the model types as an `ExternalId` but the shell doesn't name as a property (D-007), so its inline form stays prose.
          const presence = ((shell.required as string[] | undefined) ?? []).includes(name) ? "required" : "optional";
          const meaning = r.prose(k.id, k.meaning.text, k, slot, elements, true);
          rows.push({ row: k.id, cells: [code(r.nameOf(name, slot)), ...(required ? [presenceCell(presence, undefined, undefined)] : []), meaning, ...mapping], elements: sorted(elements) });
        }
        const cited = new Set(keys.map((k) => k.id));
        if (owner) {
          for (const [name, p] of Object.entries(owner.properties)) {
            if (p.sources.some((s) => cited.has(s))) continue;
            rows.push(extraRow(owner.name, name, p, [code(r.nameOf(name, p.type)), ...(required ? [presenceCell(p.presence, p.condition, p.marker)] : []), p.description ?? "", ...(t.layout.endsWith("mapping") ? [""] : [])]));
          }
        } else if (constructor?.kind === "constructor") {
          const props = (constructor.shell.properties as Record<string, { $model?: TypeRef }> | undefined) ?? {};
          for (const [name, s] of Object.entries(props)) {
            if (keys.some((k) => lastSegment(k.key.path).replaceAll("[]", "") === name)) continue;
            const presence = ((constructor.shell.required as string[] | undefined) ?? []).includes(name) ? "required" : "optional";
            rows.push({ row: `${constructor.name}.${name}`, cells: [code(s.$model ? r.nameOf(name, s.$model) : name), ...(required ? [presence === "required" ? "REQUIRED" : "OPTIONAL"] : []), ""], elements: [...constructor.sources] });
          }
        } else if (keys.length > 0) {
          r.problems.push(`${t.id}: no object or constructor of the model holds its rows`);
        }
        break;
      }
      case "marker-meaning":
      case "value-condition":
      case "value-distribution-device": {
        const defs: (MarkerDef | Definition)[] = t.layout === "marker-meaning" ? rowsOf(ir.markers, t) : rowsOf(ir.definitions, t);
        const vocabularies = model.types.filter((v): v is Extract<ModelType, { kind: "vocabulary" }> => v.kind === "vocabulary" && v.terms.some((term) => defs.some((d) => term.sources.includes(d.id))));
        if (vocabularies.length > 1) r.problems.push(`${t.id}: its rows are terms of ${vocabularies.map((v) => v.name).join(", ")}; a definition table defines one vocabulary`);
        const v = vocabularies[0];
        for (const d of defs) {
          const term = v?.terms.find((x) => x.sources.includes(d.id));
          const prose = "marker" in d ? [d.meaning.text] : d.columns.map((c) => c.text);
          rows.push({ row: d.id, cells: term ? [code(term.value), ...prose] : [], elements: sorted([d.id, ...(term?.sources ?? [])]) });
        }
        for (const term of v?.terms ?? []) {
          if (term.sources.some((s) => defs.some((d) => d.id === s))) continue;
          rows.push({ row: `${v!.name}:${term.value}`, cells: [code(term.value), ...t.header.slice(1).map(() => "")], elements: [...term.sources] });
        }
        break;
      }
      case "appendix-a":
      case "appendix-b":
        break;
    }
    tables.push({ id: t.id, layout: t.layout, section: t.section, header: t.header, rows });
  }

  // Appendix A and B: every property a field row gives, in the order of the rows, and every document property no row gives.
  const listed: { row: string; name: string; section: string; type: string; marker: string; document: string | null; elements: string[] }[] = [];
  for (const f of ir.fields) {
    const fr = fieldRows.get(f.id)!;
    if (fr.holders.length === 0) continue;
    const section = ir.sections.find((s) => s.id === f.loc.section);
    listed.push({
      row: f.id,
      name: fr.name,
      section: section ? `${section.number ?? section.id} ${section.title}` : f.loc.section,
      type: fr.type,
      marker: fr.marker,
      document: r.documentOf(fr.holders[0]!.type.name),
      elements: sorted([f.id, ...fr.holders.flatMap((h) => h.property.sources)]),
    });
  }
  for (const t of model.types) {
    if (t.kind !== "document" || !lastTable.has(t.name)) continue;
    for (const [name, p] of Object.entries(t.properties)) {
      if (shown.has(p)) continue;
      listed.push({ row: `${t.name}.${name}`, name: code(r.nameOf(name, p.type)), section: "", type: r.specType(p.type), marker: p.marker ?? "", document: t.name, elements: [...p.sources] });
    }
  }

  const a = ir.tables.find((t) => t.layout === "appendix-a");
  if (a) {
    const spec = (ir.appendix_a?.rows ?? []).map((x) => ({ id: x.id, key: `${normalize(stripCell(x.name_cell))}@${x.section_number ?? ""}` }));
    const rows: RenderedRow[] = listed.map((x) => {
      const key = `${normalize(x.name)}@${x.section.split(" ")[0]}`;
      const match = spec.find((s) => s.key === key);
      return { row: match?.id ?? x.row, cells: [x.name, x.section, x.type, x.marker], elements: sorted([...x.elements, ...(match ? [match.id] : [])]) };
    });
    tables.find((t) => t.id === a.id)!.rows = rows;
  }

  const markers = model.types.find((t): t is Extract<ModelType, { kind: "vocabulary" }> => t.kind === "vocabulary" && t.attribute === "marker");
  const order = uniq([...(markers?.terms.map((t) => String(t.value)) ?? []), ...listed.map((x) => x.marker)]);
  const counts = new Map(order.map((m) => [m, listed.filter((x) => x.marker === m)]));
  const b = ir.tables.find((t) => t.layout === "appendix-b");
  if (b) {
    const label = new Map<string, number>();
    for (const x of listed) label.set(x.name, (label.get(x.name) ?? 0) + 1);
    const owner = (d: string | null) => (d ? d.replace(/(?<=[a-z])(?=[A-Z])/g, " ").toLowerCase() : "?");
    const specRows = ir.appendix_b?.rows ?? [];
    tables.find((t) => t.id === b.id)!.rows = order
      .filter((m) => counts.get(m)!.length > 0)
      .map((m) => {
        const xs = counts.get(m)!;
        const spec: AppendixBRow | undefined = specRows.find((s) => s.marker === m);
        const fields = xs.map((x) => (label.get(x.name)! > 1 ? `${x.name} (${owner(x.document)})` : x.name));
        return { row: spec?.id ?? `appendix-b:${m}`, cells: [m, String(xs.length), spec?.meaning ?? "", fields.join(", ")], elements: sorted([...(spec ? [spec.id] : []), ...xs.flatMap((x) => x.elements)]) };
      });
  }

  let figures: Figures | null = null;
  if (ir.appendix_b?.distribution) {
    const n = (m: string) => counts.get(m)?.length ?? 0;
    const total = listed.length;
    const buyer = BUYER_MARKERS.reduce((s, m) => s + n(m), 0);
    figures = { total, buyer, selectable: n("selectable"), settable: n("settable"), supplied: n("supplied"), requestable: n("requestable"), remaining: total - buyer, round_trip: n("requestable"), up_front: buyer - n("requestable") };
  }
  return { tables, figures, problems: r.problems };
}


/** The figures "What the distribution says" states, in the order it states them. */
function specFigures(ir: SpecIR): { figures: Figures; section: string } | null {
  const d = ir.appendix_b?.distribution ?? null;
  if (!d) return null;
  const figures: Figures = { total: d.total, buyer: d.buyer, selectable: d.selectable, settable: d.settable, supplied: d.supplied, requestable: d.requestable, remaining: d.remaining, round_trip: d.round_trip, up_front: d.up_front };
  return { figures, section: d.loc.section };
}

/** The distribution's figures as Appendix B writes them. */
function describeFigures(r: Record<string, number>): { title: string; text: string } {
  const f = r as Figures;
  return {
    title: "What the distribution says",
    text: `Of ${f.total} fields, ${f.buyer} are touched by the buyer: ${f.selectable} \`selectable\`, ${f.settable} \`settable\`, ${f.supplied} \`supplied\`, and ${f.requestable} \`requestable\`. The remaining ${f.remaining} are not. ${f.round_trip} require a round trip; ${f.up_front} resolve up front.`,
  };
}

/** OpenProposal's notation for the round trip. */
export const ROUND_TRIP: RoundTripNotation = { specTables, renderTables, specFigures, describeFigures };
