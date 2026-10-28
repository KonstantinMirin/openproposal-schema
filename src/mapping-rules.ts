/**
 * The deterministic mapping rules (stage 3). A rule derives an entry's
 * target, or a declaration, from the IR, the kernel, and the entries the
 * decision records decide. A mapping entry or declaration that cites a rule
 * must equal what the rule derives, so `source: { rule }` is a claim the gate
 * checks, and `npm run map` writes every rule entry.
 *
 * A rule applies only where the specification and the type rules decide the
 * answer. Where the prose leaves a choice, the entry cites a decision record
 * instead, and no rule applies.
 */
import { canonicalJson } from "./canonical.ts";
import { pascalField } from "./constructors.ts";
import type { Constructors } from "./constructors.ts";
import type { Element } from "./elements.ts";
import type { Field, IrObjectForm, Key, SpecIR, Table } from "./ir-types.ts";
import { BOOLEAN, conceptOfRow } from "./domains.ts";
import { listedValues, type Kernel } from "./kernel.ts";
import { heldOwnerOf } from "./owners.ts";
import type { Declaration, MappingEntry, Presence, Target, TypeRef } from "./mapping.ts";

/** What a rule may read: one lock's IR, the kernel, and the in-scope mapping on that lock. */
export interface RuleContext {
  ir: SpecIR;
  elements: Map<string, Element>;
  kernel: Kernel;
  constructors: Constructors;
  /** The in-scope entry for each IR element, rule entries included. */
  entries: Map<string, MappingEntry>;
  /** The module that owns a section, from the mapping files' `sections`. */
  moduleOf: (section: string) => string | undefined;
  /** Whether the module that owns a section is one the mapping leaves for a later phase (`deferred` in its file). */
  deferred: (section: string) => boolean;
}

/** The module whose sections define the kernel's own types: § 2.2 and § 3. */
export const KERNEL_MODULE = "kernel";

export interface EntryRule {
  id: string;
  /** What the rule says, for messages and the README. */
  says: string;
  derive(e: Element, ctx: RuleContext): Target | null;
}

export interface DeclarationRule {
  id: string;
  says: string;
  /** Every declaration the rule derives on the lock. */
  derive(ctx: RuleContext): Declaration[];
}

const named = (name: string): TypeRef => ({ kind: "named", name });
const list = (t: TypeRef): TypeRef => ({ kind: "apply", constructor: "List", arguments: { T: t } });

/**
 * The document a field row's owner names: the owner in PascalCase, so
 * `line_item` is `LineItem`, as the spec profile's `documents` list them
 * (the spec-profile gate holds each to it).
 */
export const documentOf = (owner: string): string => pascalField(owner);

/** The owners of a lock's field rows, in the order their first rows come. */
export const ownersOf = (ir: SpecIR): string[] => [...new Set(ir.fields.map((f) => f.owner))];

/** A field's or key's presence as the specification states it (type rules § 4): REQUIRED, a condition, or optional. */
export function presenceOf(row: Field | Key): Presence {
  const p = "names" in row ? row.presence : (row.required?.parsed ?? null);
  if (p === null || p.kind === "marker") return "optional";
  if (p.clauses.some((c) => c.qualifier === "when" || c.qualifier === "for" || c.qualifier === "with")) return "conditional";
  return p.clauses[0]!.level === "REQUIRED" ? "required" : "optional";
}

/**
 * The type a field row is a property of (type rules § 7 naming): its
 * document for a top-level field, and `<Field>Entry` for a sub-field of an
 * array field, so `pricing[].floor` belongs to `PricingEntry`.
 */
export function objectOfField(f: Field): string | null {
  const segments = f.names[0]!.segments;
  if (segments.length === 1) return documentOf(f.owner);
  if (segments.length === 2 && segments[0]!.array) return `${pascalField(segments[0]!.name)}Entry`;
  return null;
}

/** The table a row sits in. */
const tableOf = (ir: SpecIR, row: { loc: { table?: string } }): Table | undefined => ir.tables.find((t) => t.id === row.loc.table);

/**
 * The object a key table describes, named after the field or member that
 * holds it: `commitment` gives `Commitment`, and `apps[]` gives `AppsEntry`.
 * The § 3.1 table names no field, so its keys belong to no object.
 */
export function objectOfKey(ir: SpecIR, k: Key): string | null {
  const id = tableOf(ir, k)?.parent?.identifier;
  if (!id) return null;
  return pascalField(id) + (id.endsWith("[]") ? "Entry" : "");
}

/** The object a row is a property of, or null. */
const objectOfRow = (ir: SpecIR, e: Element): string | null => (e.kind === "field" ? objectOfField(e.element) : e.kind === "key" ? objectOfKey(ir, e.element) : null);

/** The name the mapping gives a type-defining or restating element, or null. */
const typeNameOf = (ctx: RuleContext, ir: string): string | null => {
  const as = ctx.entries.get(ir)?.as;
  return as?.role === "type" || as?.role === "same" ? as.name : null;
};

/** The kernel types whose own spec sources cite an element: primitives, and constructors and parts. */
function kernelCiters(ctx: RuleContext, id: string): { primitives: string[]; templates: string[] } {
  const cites = (s: { spec?: { ir: string }[] } | undefined) => (s?.spec ?? []).some((c) => c.ir === id);
  return {
    primitives: ctx.kernel.primitives.filter((p) => cites(p.sources)).map((p) => p.name),
    templates: [...ctx.constructors.constructors, ...ctx.constructors.parts].filter((c) => cites(c.sources)).map((c) => c.name),
  };
}

/**
 * Whether an inline object writes exactly a part's members: the same keys,
 * `[]` on each member the part's shell holds as a `List`, and no member with
 * a value list or an object of its own.
 */
export function restatesPart(form: IrObjectForm, shell: Record<string, unknown>): boolean {
  const props = shell.properties !== null && typeof shell.properties === "object" ? (shell.properties as Record<string, { $model?: TypeRef }>) : {};
  const keys = Object.keys(props).sort();
  if (canonicalJson(keys) !== canonicalJson(form.members.map((m) => m.key).sort())) return false;
  return form.members.every((m) => {
    const t = props[m.key]?.$model;
    const isList = t?.kind === "apply" && t.constructor === "List";
    return m.value === null && m.array === isList;
  });
}

const scalarOf = (f: Field): string | null => (f.type.parsed.kind === "scalar" ? f.type.parsed.name : null);
/** Whether a field's type is the scalar named, or a list of it, as each plugin's type grammar parses its Type cell: OpenProposal's `Array[String]` and the Deals API's `string array` alike. */
const isScalar = (f: Field, ...names: string[]): boolean => f.type.parsed.kind === "scalar" && names.includes(f.type.parsed.name);
const isListOf = (f: Field, ...names: string[]): boolean => f.type.parsed.kind === "array" && f.type.parsed.items.kind === "scalar" && names.includes(f.type.parsed.items.name);

const property = (ir: SpecIR, e: Element, type: TypeRef): Target | null => {
  if (e.kind !== "field" && e.kind !== "key") return null;
  const object = objectOfRow(ir, e);
  return object === null ? null : { role: "property", object, type, presence: presenceOf(e.element) };
};

/** A file under the specification repository's `examples/`, as a code span names it, such as `examples/proposal.yaml`. */
const EXAMPLE_FILE = /`(examples\/[A-Za-z0-9][A-Za-z0-9._-]*)`/g;

/** The example files a sentence names, in order. */
export const exampleFilesOf = (text: string): string[] => [...text.matchAll(EXAMPLE_FILE)].map((m) => m[1]!);

/** A type name in words, as a heading writes it: `LineItem` is "line item". */
const words = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

/** The documents on the lock: the field rows' owners, and every document a mapping entry defines, such as the § 2.3 manifest. */
function documentsOf(ctx: RuleContext): string[] {
  const defined = [...ctx.entries.values()].flatMap((x) => (x.as.role === "type" && x.as.layer === "document" ? [x.as.name] : []));
  return [...new Set([...ownersOf(ctx.ir).map(documentOf), ...defined])].sort();
}

/** A code a list row writes: a decimal integer, as AdCOM's `3` or `-1`. */
const LIST_CODE = /^-?(0|[1-9][0-9]*)$/;
/** A list row that reserves codes for vendors, as AdCOM's `500+`. */
const VENDOR_ROW = /^([1-9][0-9]*)\+$/;

/**
 * A table of codes a section's heading alone names, as AdCOM's `List: Device
 * Types`: a table of value definitions that names no field, key, or member,
 * whose every row is a code or a vendor range, under a heading of the form
 * `<label>: <name>`. Returns its rows, or null.
 */
function listTable(ir: SpecIR, table: Table | undefined): { title: string; rows: SpecIR["definitions"] } | null {
  if (!table || table.parent?.via !== "section") return null;
  const rows = ir.definitions.filter((d) => d.loc.table === table.id);
  if (rows.length === 0 || !rows.every((d) => LIST_CODE.test(d.value) || VENDOR_ROW.test(d.value))) return null;
  const title = /^[A-Z][A-Za-z ]*:\s*(\S.*)$/.exec(ir.sections.find((s) => s.id === table.section)?.title ?? "")?.[1];
  return title ? { title, rows } : null;
}

/** A word in the singular, by English's regular plurals. */
const singular = (w: string) => (/ies$/i.test(w) ? `${w.slice(0, -3)}y` : /(ss|x|ch|sh|us)es$/i.test(w) ? w.slice(0, -2) : /[^su]s$/i.test(w) ? w.slice(0, -1) : w);

/**
 * The vocabulary a list's name gives (type rules § 6): its words in
 * PascalCase, each written as a word, so an acronym's capitals become one,
 * with the head noun, the last word before a ` - ` qualifier or else the last
 * word, in the singular. `Device Types` gives `DeviceType`, `API Frameworks`
 * `ApiFramework`, and `Plcmt Subtypes - Video` `PlcmtSubtypeVideo`.
 */
export function vocabularyOfList(title: string): string {
  const [head, ...qualifiers] = title.split(/\s+-\s+/);
  const words = (s: string) => s.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const hw = words(head!);
  if (hw.length > 0 && !/\b(in|of|for)\b/i.test(head!)) hw[hw.length - 1] = singular(hw[hw.length - 1]!);
  else {
    // "Slot Position in Pod": the head noun is the word before the preposition.
    const at = hw.findIndex((w) => /^(in|of|for)$/i.test(w));
    if (at > 0) hw[at - 1] = singular(hw[at - 1]!);
  }
  return [...hw, ...qualifiers.flatMap(words)].map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join("");
}

/** The entry rules, tried in order; the first that applies derives the entry. */
export const ENTRY_RULES: EntryRule[] = [
  {
    id: "deferred-module",
    says: "An element in a section of a module the mapping leaves for a later phase, as AdCOM's objects, is informative until that phase maps it; the module's file cites the decision that defers it.",
    derive: (e, ctx) => (ctx.deferred(e.element.loc.section) ? { role: "informative" } : null),
  },
  {
    id: "list-code",
    says: "A code row of a list that a section's heading alone names, as AdCOM's `List: Device Types`, defines one term of the list's vocabulary, the code.",
    derive: (e, ctx) => {
      if (e.kind !== "definition" || !LIST_CODE.test(e.element.value)) return null;
      const list = listTable(ctx.ir, tableOf(ctx.ir, e.element));
      return list ? { role: "term", vocabulary: vocabularyOfList(list.title) } : null;
    },
  },
  {
    id: "vendor-range",
    says: "A list row that reserves codes for vendors, as AdCOM's `500+`, is the vendor branch of the list's vocabulary, which its schema expresses.",
    derive: (e, ctx) => {
      if (e.kind !== "definition" || !VENDOR_ROW.test(e.element.value)) return null;
      const list = listTable(ctx.ir, tableOf(ctx.ir, e.element));
      return list ? { role: "schema", in: vocabularyOfList(list.title) } : null;
    },
  },
  {
    id: "appendix-row",
    says: "An Appendix A or B row is generated from the model, and the round trip checks it.",
    derive: (e) => (e.kind === "appendix_a" || e.kind === "appendix_b" ? { role: "rendered" } : null),
  },
  {
    id: "front-matter",
    says: "A statement in the front matter, such as the draft status, carries no conformance content.",
    derive: (e) => (e.kind === "statement" && e.element.part === "front" ? { role: "informative" } : null),
  },
  {
    id: "concept-row",
    says: "A row of the § 1.1 concept table names a downstream standard, and carries no field, key, value, or marker; a row of a table whose columns after the first are each headed by a member's name, as the Deals API's Example Scenarios, writes values of those members, which a decision reads.",
    derive: (e, ctx) => {
      if (e.kind !== "concept") return null;
      const header = tableOf(ctx.ir, e.element)?.header ?? [];
      return header.length > 1 && header.slice(1).every((h) => /^[a-z][a-z0-9_]*$/.test(h)) ? null : { role: "informative" };
    },
  },
  {
    id: "marker-term",
    says: "A marker row defines one term of the kernel's `Marker` vocabulary.",
    derive: (e) => (e.kind === "marker" ? { role: "term", vocabulary: "Marker" } : null),
  },
  {
    id: "definition-term",
    says: "A value-definition row defines one term of the vocabulary that its table's field's value list defines.",
    derive: (e, ctx) => {
      if (e.kind !== "definition") return null;
      const fieldId = tableOf(ctx.ir, e.element)?.parent?.field;
      const field = fieldId ? ctx.elements.get(fieldId) : undefined;
      if (field?.kind !== "field" || field.element.value_lists.length !== 1) return null;
      const listId = field.element.value_lists[0]!;
      const values = ctx.ir.value_lists.find((v) => v.id === listId)?.items.map((i) => i.value) ?? [];
      const vocabulary = typeNameOf(ctx, listId);
      return vocabulary !== null && values.includes(e.element.value) ? { role: "term", vocabulary } : null;
    },
  },
  {
    id: "presence-statement",
    says: "A statement that is a row's own REQUIRED or OPTIONAL sentence is the presence of the property that row maps to, which the object's schema states.",
    derive: (e, ctx) => {
      if (e.kind !== "statement" || !["REQUIRED", "OPTIONAL", "RECOMMENDED"].some((k) => e.element.text.startsWith(k))) return null;
      const host = ctx.elements.get(e.element.host.split("#")[0]!);
      if (host?.kind !== "field" || host.element.presence === null) return null;
      const as = ctx.entries.get(host.element.id)?.as;
      return as?.role === "property" ? { role: "schema", in: as.object } : null;
    },
  },
  {
    id: "restated-value-list",
    says: "A value list with the same values, in the same order, and the same labels where both label them, as a vocabulary another entry defines restates it; one with a kernel primitive's `enum` or titled codes, such as a daypart window's days and `DayName`, or `0` (no) | `1` (yes) and `IntegerFlag`, is what the primitive's schema expresses, where an unlabeled list has its codes, and a labeled one its titles or a row the kernel binding cites for the primitive's concept.",
    derive: (e, ctx) => {
      if (e.kind !== "value_list") return null;
      const values = canonicalJson(e.element.items.map((i) => i.value));
      // Two lists that both label their codes, as the Deals API's `0` = undisclosed, restate each other only with the same labels: the codes alone say nothing.
      const labeled = (v: typeof e.element) => v.items.every((i) => i.annotation !== null);
      const same = ctx.ir.value_lists.filter((v) => v.id !== e.element.id && canonicalJson(v.items.map((i) => i.value)) === values && (!labeled(v) || !labeled(e.element) || canonicalJson(v.items.map((i) => i.annotation)) === canonicalJson(e.element.items.map((i) => i.annotation))));
      const defined = same.flatMap((v) => {
        const as = ctx.entries.get(v.id)?.as;
        return as?.role === "type" && as.layer === "vocabulary" ? [as.name] : [];
      });
      // A labeled list restates a primitive's titled codes only where its labels are the titles, as `0` (no) | `1` (yes) are
      // `IntegerFlag`'s, or where the kernel binding cites its row for the primitive's concept, as the Deals API's `guar`:
      // `0` = undisclosed, `1` = single publisher has the codes and is no flag.
      const row = e.element.host.split("#")[0]!;
      const bound = (p: (typeof ctx.kernel.primitives)[number]) => ctx.kernel.domains !== undefined && conceptOfRow(ctx.kernel.domains, row)?.type === p.name;
      const titled = (p: (typeof ctx.kernel.primitives)[number]) => p.constraints.oneOf !== undefined && canonicalJson(p.constraints.oneOf.map((b) => b.title.toLowerCase())) === canonicalJson(e.element.items.map((i) => (i.annotation ?? "").toLowerCase()));
      // A list that labels any of its codes is read by its labels, so a half-labeled list doesn't fall back on its codes alone.
      const someLabel = e.element.items.some((i) => i.annotation !== null);
      const fits = (p: (typeof ctx.kernel.primitives)[number]) => !someLabel || bound(p) || titled(p);
      const listed = ctx.kernel.primitives.filter((p) => listedValues(p) !== null && canonicalJson(listedValues(p)!.map(String)) === values && fits(p)).map((p) => p.name);
      if (defined.length + listed.length !== 1) return null;
      return defined.length === 1 ? { role: "same", name: defined[0]! } : { role: "schema", in: listed[0]! };
    },
  },
  {
    id: "restated-part",
    says: "An inline object outside the kernel's sections whose members are exactly one kernel part's, with `[]` on each member the part holds as a list and no values of their own, restates that part, as a daypart window's `{ days[], start, end }` restates `DaypartWindow`.",
    derive: (e, ctx) => {
      if (e.kind !== "inline_object" || e.element.form.combinator !== "all") return null;
      if (ctx.moduleOf(e.element.loc.section) === KERNEL_MODULE) return null;
      const parts = ctx.constructors.parts.filter((p) => restatesPart(e.element.form, p.shell));
      return parts.length === 1 ? { role: "same", name: parts[0]!.name } : null;
    },
  },
  {
    id: "kernel-source",
    says: "In the kernel's sections, a statement, code block, or § 3.1 key that one constructor or part cites as its source, or else exactly one primitive cites, is what that type's schema expresses.",
    derive: (e, ctx) => {
      if (e.kind === "field" || e.kind === "definition" || e.kind === "marker") return null;
      if (ctx.moduleOf(e.element.loc.section) !== KERNEL_MODULE) return null;
      if (e.kind === "key" && objectOfKey(ctx.ir, e.element) !== null) return null;
      const { primitives, templates } = kernelCiters(ctx, e.element.id);
      if (templates.length === 1) return { role: "schema", in: templates[0]! };
      if (templates.length === 0 && primitives.length === 1) return { role: "schema", in: primitives[0]! };
      return null;
    },
  },
  {
    id: "example-file",
    says: "A sentence that names one file under `examples/`, in a section whose title names exactly one document, such as \"See `examples/proposal.yaml`.\" under § 6.1 Proposal, points to an example of that document, which the examples gate validates.",
    derive: (e, ctx) => {
      if (e.kind !== "sentence" || exampleFilesOf(e.element.text).length !== 1) return null;
      const title = ctx.ir.sections.find((s) => s.id === e.element.loc.section)?.title.toLowerCase() ?? "";
      const named = documentsOf(ctx).filter((d) => new RegExp(`(^|[^a-z])${words(d)}($|[^a-z])`).test(title));
      return named.length === 1 ? { role: "example", object: named[0]! } : null;
    },
  },
  {
    id: "prose-sentence",
    says: "A prose sentence with no RFC 2119 keyword states no requirement of its own, so it is informative. A decision that rests on it covers it, so a change to it makes the decision stale.",
    derive: (e) => (e.kind === "sentence" ? { role: "informative" } : null),
  },
  {
    id: "scalar-field",
    says: "A field typed Boolean is the inline boolean, and Timestamp is `Timestamp`.",
    derive: (e, ctx) => {
      if (e.kind !== "field") return null;
      const type = { Boolean: { kind: "boolean" } as TypeRef, Timestamp: named("Timestamp") }[scalarOf(e.element) ?? ""];
      return type ? property(ctx.ir, e, type) : null;
    },
  },
  {
    id: "domain-row",
    says: "A String, Number, Integer, or Array[String] field, or a key row with no inline object, whose only value lists restate the concept's type, that exactly one concept of the domain model cites has the concept's type, or a list of it where the row is a list.",
    derive: (e, ctx) => {
      if (e.kind !== "field" && e.kind !== "key") return null;
      if (e.kind === "field" && !isScalar(e.element, "String", "Number", "Integer") && !isListOf(e.element, "String")) return null;
      if (e.kind === "key" && e.element.inline_objects.length > 0) return null;
      const c = ctx.kernel.domains ? conceptOfRow(ctx.kernel.domains, e.element.id) : null;
      if (c === null) return null;
      // A key's value list may only restate the type's own values, as `0` (no) | `1` (yes) restates `IntegerFlag`'s codes.
      if (e.element.value_lists.length > 0) {
        const own = ctx.kernel.primitives.find((p) => p.name === c.type);
        const codes = own ? listedValues(own) : null;
        const restates = (id: string) => codes !== null && canonicalJson(ctx.ir.value_lists.find((v) => v.id === id)?.items.map((i) => i.value) ?? []) === canonicalJson(codes.map(String));
        if (!e.element.value_lists.every(restates)) return null;
      }
      const type: TypeRef = c.type === BOOLEAN ? { kind: "boolean" } : named(c.type);
      const array = e.kind === "field" ? e.element.type.parsed.kind === "array" : e.element.key.path.endsWith("[]");
      return property(ctx.ir, e, array ? list(type) : type);
    },
  },
  {
    id: "enum-row",
    says: "An Enum field, an Integer field or a list of integers, or a key, whose row holds exactly one value list has the vocabulary that list defines, or a list of it for a list.",
    derive: (e, ctx) => {
      if (e.kind !== "field" && e.kind !== "key") return null;
      if (e.kind === "field" && !isScalar(e.element, "Enum", "Integer") && !isListOf(e.element, "Integer")) return null;
      if (e.element.value_lists.length !== 1 || e.element.inline_objects.length > 0) return null;
      const name = typeNameOf(ctx, e.element.value_lists[0]!);
      if (name === null) return null;
      return property(ctx.ir, e, e.kind === "field" && isListOf(e.element, "Integer") ? list(named(name)) : named(name));
    },
  },
  {
    id: "inline-object-row",
    says: "An Object field, an Array[Object] field, or a key whose row holds exactly one inline object, not an option of `available[]`, has that object, or a list of it for an array.",
    derive: (e, ctx) => {
      if (e.kind !== "field" && e.kind !== "key") return null;
      if (e.kind === "field" && ["selectable", "settable", "mixed"].includes(e.element.marker ?? "")) return null;
      if (e.element.inline_objects.length !== 1) return null;
      const o = ctx.ir.inline_objects.find((x) => x.id === e.element.inline_objects[0]);
      if (!o || o.anchor !== null) return null;
      const name = typeNameOf(ctx, o.id);
      if (name === null) return null;
      const array = e.kind === "field" ? e.element.type.parsed.kind === "array" : e.element.key.path.endsWith("[]");
      if (e.kind === "field" && !(array ? isListOf(e.element, "Object") : isScalar(e.element, "Object"))) return null;
      return property(ctx.ir, e, array ? list(named(name)) : named(name));
    },
  },
  {
    id: "keyed-object-field",
    says: "An Object field, not marked selectable or settable, that a key table describes has the object that the table describes.",
    derive: (e, ctx) => {
      if (e.kind !== "field" || !isScalar(e.element, "Object") || ["selectable", "settable"].includes(e.element.marker ?? "")) return null;
      const table = ctx.ir.tables.find((t) => t.parent?.field === e.element.id && t.layout.startsWith("key-"));
      if (!table || e.element.inline_objects.length > 0) return null;
      return property(ctx.ir, e, named(pascalField(e.element.names[0]!.path)));
    },
  },
  {
    id: "held-object-field",
    says: "An object field, or a list of objects, whose name is another owner's object, as the Deals API's `terms` names `Object: Terms` and `buyerstatus` names `Object: BuyerStatus`, has that object, or a list of it.",
    derive: (e, ctx) => {
      if (e.kind !== "field") return null;
      const held = heldOwnerOf(ctx.ir, e.element);
      if (held === null) return null;
      return property(ctx.ir, e, isListOf(e.element, "Object") ? list(named(documentOf(held))) : named(documentOf(held)));
    },
  },
  {
    id: "sub-field-array",
    says: "An Array[Object] field whose items have rows of their own, and no inline object, is a list of its `<Field>Entry` object.",
    derive: (e, ctx) => {
      if (e.kind !== "field" || !isListOf(e.element, "Object") || e.element.inline_objects.length > 0) return null;
      const path = e.element.names[0]!.path;
      if (!ctx.ir.fields.some((f) => f.names[0]!.path.startsWith(`${path}.`))) return null;
      return property(ctx.ir, e, list(named(`${pascalField(path)}Entry`)));
    },
  },
];

/** The declaration rules: types that the IR's structure implies, with no single element that defines them. */
export const DECLARATION_RULES: DeclarationRule[] = [
  {
    id: "list-vocabulary",
    says: "A list that a section's heading alone names, as AdCOM's `List: Device Types`, is a vocabulary named after the list, declared at its first row, whose terms take their rows' text as labels; a `500+` row makes it open to vendors' codes from 500 up.",
    derive: (ctx) =>
      ctx.ir.tables.flatMap((t) => {
        if (ctx.deferred(t.section)) return [];
        const list = listTable(ctx.ir, t);
        if (!list) return [];
        const vendor = list.rows.map((d) => ({ d, m: VENDOR_ROW.exec(d.value) })).find((x) => x.m !== null);
        return [
          {
            name: vocabularyOfList(list.title),
            kind: "vocabulary" as const,
            ir: list.rows[0]!.id,
            source: { rule: "list-vocabulary" },
            open: vendor !== undefined,
            ...(vendor ? { vendor: { from: Number(vendor.m![1]), label: vendor.d.columns.map((c) => c.text).filter((x) => x !== "").join(": ") } } : {}),
            labeled: true,
            description: `The codes of ${ctx.ir.sections.find((s) => s.id === t.section)!.title}, each with its row's text.`,
          },
        ];
      }),
  },
  {
    id: "document-owner",
    says: "The owners of the field rows are the documents, such as `Proposal` and `LineItem`, each declared at its first field row, but an owner another owner's field holds, which is an object.",
    derive: (ctx) => {
      const out: Declaration[] = [];
      const held = new Set(ctx.ir.fields.flatMap((f) => heldOwnerOf(ctx.ir, f) ?? []));
      for (const owner of ownersOf(ctx.ir).filter((o) => !held.has(o))) {
        const first = ctx.ir.fields.find((f) => f.owner === owner)!;
        out.push({ name: documentOf(owner), kind: "document", ir: first.id, source: { rule: "document-owner" } });
      }
      return out;
    },
  },
  {
    id: "held-object",
    says: "An owner of field rows that another owner's field holds, as `Object: Terms` is the Deals API's `terms`, is a closed object named after it, declared at its first row.",
    derive: (ctx) => {
      const held = new Set(ctx.ir.fields.flatMap((f) => heldOwnerOf(ctx.ir, f) ?? []));
      return ownersOf(ctx.ir)
        .filter((o) => held.has(o))
        .map((owner) => ({ name: documentOf(owner), kind: "object" as const, ir: ctx.ir.fields.find((f) => f.owner === owner)!.id, source: { rule: "held-object" }, open: false }));
    },
  },
  {
    id: "key-table-object",
    says: "A key table that names a field or member describes a closed object, named after it and declared at the table's first row.",
    derive: (ctx) =>
      ctx.ir.tables.flatMap((t) => {
        // A module the mapping leaves for a later phase declares nothing yet.
        if (ctx.deferred(t.section)) return [];
        const first = ctx.ir.keys.find((k) => k.loc.table === t.id);
        const name = first ? objectOfKey(ctx.ir, first) : null;
        return first && name ? [{ name, kind: "object" as const, ir: first.id, source: { rule: "key-table-object" }, open: false }] : [];
      }),
  },
  {
    id: "sub-field-object",
    says: "An array field whose items have rows of their own describes a closed `<Field>Entry` object, declared at the array field's row.",
    derive: (ctx) =>
      ctx.ir.fields.flatMap((f) => {
        const path = f.names[0]!.path;
        if (!isListOf(f, "Object") || !ctx.ir.fields.some((g) => g.names[0]!.path.startsWith(`${path}.`))) return [];
        return [{ name: `${pascalField(path)}Entry`, kind: "object" as const, ir: f.id, source: { rule: "sub-field-object" }, open: false }];
      }),
  },
];

/** Derives the target an entry rule gives an element, or a reason it gives none. */
export function deriveEntry(rule: string, e: Element, ctx: RuleContext): Target | string {
  const r = ENTRY_RULES.find((x) => x.id === rule);
  if (!r) return `no mapping rule "${rule}"; the rules are ${ENTRY_RULES.map((x) => x.id).join(", ")}`;
  return r.derive(e, ctx) ?? `rule "${rule}" doesn't apply to "${e.element.id}"`;
}

/** The first entry rule that applies to an element, with what it derives. */
export function firstRule(e: Element, ctx: RuleContext): { rule: string; as: Target } | null {
  for (const r of ENTRY_RULES) {
    const as = r.derive(e, ctx);
    if (as) return { rule: r.id, as };
  }
  return null;
}
