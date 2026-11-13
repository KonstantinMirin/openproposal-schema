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
import type { TypeExpr } from "./grammar/type-expr.ts";
import type { Field, IrObjectForm, Key, SpecIR, Table } from "./ir-types.ts";
import { BOOLEAN, conceptOfRow } from "./domains.ts";
import { kernelOn, listedValues, type Kernel } from "./kernel.ts";
import { heldOwnerOf } from "./owners.ts";
import { inScope, type Declaration, type MappingEntry, type Presence, type Target, type TypeRef } from "./mapping.ts";

/** What a rule may read: one lock's IR, the kernel, and the in-scope mapping on that lock. */
export interface RuleContext {
  /** The lock the rules run on. */
  lock: string;
  /** The in-scope declarations of the mapping files on the lock: each one's name, kind, and terms. */
  declared?: { name: string; kind: string; terms?: string[] }[];
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
  /** The owner of each rule whose check is a program, by rule ID, from the spec's `rule-programs.yaml`. */
  programs?: Record<string, { owner: string }>;
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
  const declared = (ctx.declared ?? []).flatMap((d) => (d.kind === "document" ? [d.name] : []));
  return [...new Set([...ownersOf(ctx.ir).map(documentOf), ...defined, ...declared])].sort();
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

/** The layout of a table of shared types, one named type a row, as the stack's § 2.2 writes them. */
const SHARED_TYPES_LAYOUT = "type-form-rules";

/** The row of a table of shared types with this element ID, or null. */
function sharedTypeRowOf(ctx: RuleContext, id: string): SpecIR["definitions"][number] | null {
  const d = ctx.ir.definitions.find((x) => x.id === id);
  return d !== undefined && d.layout === SHARED_TYPES_LAYOUT ? d : null;
}

/** The names of the objects the lock's key tables define, as `objectOfKey` names them. */
const keyObjectsOf = (ir: SpecIR): Set<string> => new Set(ir.keys.flatMap((k) => objectOfKey(ir, k) ?? []));

/**
 * The kernel primitives a text that defines its own types may name: a
 * primitive on the lock whose kernel binding cites, on the lock, the element
 * where the text defines that name, its § 2.2 row (`def:2.2:IntegerFlag`) or
 * its sentence ("`CurrencyCode` is a String: …"). Sharing a name alone isn't
 * enough: the stack's `Url` and `Duration` take forms the kernel's don't.
 */
const kernelNames = (ctx: RuleContext): Map<string, string> => {
  const out = new Map<string, string>();
  for (const p of kernelOn(ctx.kernel, ctx.lock).primitives) {
    for (const c of p.sources.spec ?? []) {
      if (!inScope(c.locks, ctx.lock) || !ctx.elements.has(c.ir)) continue;
      const e = ctx.elements.get(c.ir)!;
      // The name the cited element defines: a § 2.2 row's, or a sentence's "`ClockTime` is …", which may alias the kernel's name, as `ClockTime` is `TimeOfDay`.
      const defined = e.kind === "definition" && e.element.layout === SHARED_TYPES_LAYOUT ? e.element.value : (/^`([A-Z][A-Za-z0-9]*)` is /.exec(c.quote)?.[1] ?? null);
      // A primitive of the name itself wins over one that only cites the same definition, as `NamespacedTerm` cites `VocabularyTerm`'s row.
      // An edition defines its own name only: the stack's `NamespacedTerm` cites the `VocabularyTerm` row for its grammar, and is no `VocabularyTerm`.
      if (defined !== null && p.edition !== undefined && defined !== p.name) continue;
      if (defined !== null && (!out.has(defined) || p.name === defined)) out.set(defined, p.name);
    }
  }
  return out;
};

/** The scalar names the stack's § 2.6 Type cells use, and the plain kernel type each takes where the row gives no other form. */
const PLAIN: Readonly<Record<string, string>> = { String: "PlainString", Integer: "SafeInteger", Number: "PlainNumber", Object: "OpenObject" };

/** The names the in-scope declarations of the lock define, as the vocabularies and unions a decision gives. */
const declaredNames = (ctx: RuleContext): Set<string> => new Set((ctx.declared ?? []).map((d) => d.name));

/** The names of the profiles the entries define, as `LineItemSummary`. */
const profileNames = (ctx: RuleContext): Set<string> => new Set([...ctx.entries.values()].flatMap((x) => (x.as.role === "profile" ? [x.as.name ?? x.as.document + x.as.profile] : [])));

/** A word in PascalCase from snake case: `cost_method` is `CostMethod`. */
const pascal = (w: string) => w.split("_").filter((x) => x !== "").map((x) => x[0]!.toUpperCase() + x.slice(1)).join("");

/** The vocabulary a typed row's own values, or a value table its key heads, define (§ 2.6 "Value lists"). */
export interface RowVocabulary {
  name: string;
  open: boolean;
  /** The element that writes the terms: the row's value list, or the value table's first row. */
  ir: string;
  /** The terms, for a row's own list; a value table's rows give theirs as term entries. */
  terms: string[] | null;
}

/**
 * The core terms a row's text takes from elsewhere (the stack's § 2.6): "the
 * `a.b` terms (§ N)", the own list of the row `b` of the object `a` names, and
 * "the `c` terms of § N", the codes the column `c` of § N's value tables holds.
 */
export function takenFrom(ir: SpecIR, text: string): { terms: string[]; elements: string[] } {
  const clause = /\bCore terms?:(.*?)(?:\.\s+[A-Z]|\.?$)/.exec(text)?.[1] ?? "";
  const out: string[] = [];
  const elements: string[] = [];
  for (const m of clause.matchAll(/\bthe `([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)` terms \(§ [\d.]+\)/g)) {
    const key = ir.keys.find((k) => k.id.endsWith(`:${pascal(m[1]!)}.${m[2]}`));
    const list = key?.value_lists.map((id) => ir.value_lists.find((v) => v.id === id)!).find((v) => v.host === `${key.id}#meaning`);
    if (list) elements.push(list.id);
    out.push(...(list?.items.map((i) => i.value) ?? []));
  }
  for (const m of clause.matchAll(/\bthe `([a-z][a-z0-9_]*)` terms of § ([\d.]+)/g)) {
    for (const d of ir.definitions.filter((x) => x.loc.section === m[2])) {
      const cell = d.columns.find((c) => c.name === `\`${m[1]}\``)?.text ?? "";
      // A cell that names a key, as TIME's `rate_unit`, takes that key's terms, which its own row lists.
      const keyed = (v: string) => ir.keys.some((k) => k.loc.section === m[2] && k.key.path === v);
      const terms = [...cell.matchAll(/`([^`]+)`/g)].map((x) => x[1]!).filter((v) => !keyed(v));
      if (terms.length > 0) elements.push(d.id);
      out.push(...terms);
    }
  }
  return { terms: [...new Set(out)], elements };
}
const takenTerms = (ctx: RuleContext, text: string): string[] => takenFrom(ctx.ir, text).terms;

/** The type a row's Type cell names at its root, under any `Array` or `Selectable`. */
const leafOf = (t: TypeExpr): TypeExpr => (t.kind === "array" ? leafOf(t.items) : t.kind === "apply" && t.name === "Selectable" && t.arguments.length === 1 ? leafOf(t.arguments[0]!) : t);

/**
 * A typed row's vocabulary (§ 2.6): an `Enum` row's list, closed; an `Integer`
 * row's list, closed; and a `VocabularyTerm` row's core terms, open, from its
 * own list or from the value table its key heads. Named from the row's path:
 * the object the row belongs to and its last segment, in PascalCase, so
 * `type` on the proposal is `ProposalType`, `pricing[].cost_method`
 * `PricingEntryCostMethod`, and `AssentEntry.role` `AssentEntryRole`, a
 * list's in the singular. Null for a row with no list, or of another type.
 */
export function rowVocabulary(ctx: RuleContext, e: Element): RowVocabulary | null {
  if (e.kind !== "field" && e.kind !== "key") return null;
  const expr = e.kind === "field" ? (e.element.required !== undefined ? e.element.type.parsed : null) : (e.element.type_expr ?? null);
  if (expr === null) return null;
  const leaf = leafOf(expr);
  const kind = leaf.kind === "scalar" && ["Enum", "Integer"].includes(leaf.name) ? leaf.name : leaf.kind === "named" && leaf.name === "VocabularyTerm" ? "VocabularyTerm" : null;
  if (kind === null) return null;
  const host = `${e.element.id}#${e.kind === "field" ? "description" : "meaning"}`;
  const own = e.element.value_lists.map((id) => ctx.ir.value_lists.find((v) => v.id === id)!).find((v) => v.host === host);
  const path = e.kind === "field" ? e.element.names[0]!.path : e.element.key.path;
  const last = path.split(".").pop()!.replaceAll("[]", "");
  const listed = path.endsWith("[]") || expr.kind === "array";
  const base = `${(e.kind === "field" ? objectOfField(e.element) : objectOfKey(ctx.ir, e.element)) ?? ""}${pascal(last)}`;
  const words = base.match(/[A-Z][a-z0-9]*/g) ?? [base];
  const name = listed ? [...words.slice(0, -1), singular(words.at(-1)!)].join("") : base;
  // Core terms a row takes from another row or a table, as "the `frequency_cap.per` terms (§ 5.5)" or "the `unit` terms of § 5.6.5".
  const taken = kind === "VocabularyTerm" ? takenTerms(ctx, e.kind === "field" ? e.element.description.text : e.element.meaning.text) : [];
  if (own) return { name, open: kind === "VocabularyTerm", ir: own.id, terms: [...new Set([...taken, ...own.items.map((i) => i.value)])] };
  if (kind !== "VocabularyTerm") return null;
  if (taken.length > 0) return { name, open: true, ir: e.element.id, terms: taken };
  // A value table headed by the key's name lists its core terms, as `cost_method`'s does.
  const tables = ctx.ir.tables.filter((t) => t.parent?.via === "header" && t.parent.identifier === last && ctx.ir.definitions.some((d) => d.loc.table === t.id));
  const rows = ctx.ir.fields.filter((f) => f.names[0]!.path.split(".").pop()!.replaceAll("[]", "") === last).length + ctx.ir.keys.filter((k) => k.key.path.split(".").pop()!.replaceAll("[]", "") === last).length;
  // A row that lists no core terms, here or in a table, is an open vocabulary of its own whose terms the text leaves to their definers (§ 2.2).
  // A row that lists no core terms, here or in a table, is an open list whose terms their definers give, which a decision names and sets aside (§ 2.2).
  if (tables.length !== 1 || rows !== 1) return null;
  const first = ctx.ir.definitions.find((d) => d.loc.table === tables[0]!.id)!;
  return { name, open: true, ir: first.id, terms: null };
}

/**
 * The model type a typed row's type expression names, or null where no rule
 * decides it. `String`, `Integer`, `Number`, and `Object` take the plain
 * kernel types; Boolean the inline boolean; a name, the object its key table
 * defines, a declared or entry-defined type, a document, an array field's
 * entry object, or a kernel primitive whose binding cites the text's
 * definition of the name, under that name or the kernel's; `Array[T]` a list;
 * and a generic type, the kernel's constructor of that name on the lock, its
 * arguments in its parameters' order.
 */
export function typeOfExpr(t: TypeExpr, ctx: RuleContext): TypeRef | null {
  switch (t.kind) {
    case "scalar": {
      if (t.name === "Boolean") return { kind: "boolean" };
      const plain = PLAIN[t.name];
      if (plain === undefined) return null;
      const on = kernelOn(ctx.kernel, ctx.lock).primitives.some((p) => p.name === plain) || declaredNames(ctx).has(plain);
      return on ? named(plain) : null;
    }
    case "named": {
      const objects = keyObjectsOf(ctx.ir);
      const templates = [...ctx.constructors.constructors, ...ctx.constructors.parts];
      if (objects.has(t.name) && !templates.some((c) => c.name === t.name) && !profileNames(ctx).has(t.name)) return named(t.name);
      // A type another entry defines, as the § 2.2 vocabulary `Side`, or a declaration, as the union `Measurer`.
      if ([...ctx.entries.values()].some((x) => x.as.role === "type" && x.as.name === t.name) || declaredNames(ctx).has(t.name) || profileNames(ctx).has(t.name)) return named(t.name);
      // A document the field rows describe, as `Array[LineItem]` holds line items.
      if (ownersOf(ctx.ir).map(documentOf).includes(t.name)) return named(t.name);
      // An array field's sub-field rows define its entry object, as `pricing[]`'s define `PricingEntry`.
      if (ctx.ir.fields.some((f) => f.names[0]!.segments.length === 2 && f.names[0]!.segments[0]!.array && `${pascalField(f.names[0]!.segments[0]!.name)}Entry` === t.name)) return named(t.name);
      // A part the text writes for the kernel's, as the stack's `Ext`.
      if (ctx.constructors.parts.some((p) => p.name === t.name)) return named(t.name);
      const k = kernelNames(ctx).get(t.name);
      if (k !== undefined) return named(k);
      // A § 2.2 type whose Form is another type expression, as `Ext` is `Map[Domain, Object]`, is that expression.
      const row = ctx.ir.definitions.find((d) => d.layout === SHARED_TYPES_LAYOUT && d.value === t.name);
      const form = row?.columns.find((c) => c.name === "Form")?.text ?? "";
      const alias = /^`([^`]+)`$/.exec(form)?.[1];
      const parsed = alias !== undefined && alias !== t.name ? parseTypeText(alias) : null;
      return parsed === null ? null : typeOfExpr(parsed, ctx);
    }
    case "array": {
      const item = typeOfExpr(t.items, ctx);
      return item === null ? null : list(item);
    }
    case "apply": {
      const args = t.arguments.map((a) => typeOfExpr(a, ctx));
      if (args.some((a) => a === null)) return null;
      if (t.name === "Map" && args.length === 2) return { kind: "apply", constructor: "Map", arguments: { K: args[0]!, V: args[1]! } };
      const c = ctx.constructors.constructors.find((x) => x.name === t.name);
      const params = (c?.parameters ?? []).filter((p) => !p.optional);
      if (!c || params.length !== args.length) return null;
      return { kind: "apply", constructor: c.name, arguments: Object.fromEntries(params.map((p, i) => [p.name, args[i]!])) };
    }
    default:
      return null;
  }
}

/** The type a lead-in's "holds the keys of `Y`" names: an object, or a constructor applied to one argument, as `Selectable[AudienceOption]`. */
function heldType(text: string, ctx: RuleContext, holder?: string): TypeRef | null {
  const m = /^([A-Z][A-Za-z0-9]*)(?:\[([A-Z][A-Za-z0-9]*)\])?$/.exec(text);
  if (!m) return null;
  if (m[2] === undefined) return typeOfExpr({ kind: "named", name: m[1]! }, ctx);
  const arg: TypeExpr = /^[A-Z]$/.test(m[2]) ? { kind: "param", name: m[2] } : { kind: "named", name: m[2] };
  if (arg.kind === "param") return null;
  // Options typed `VocabularyTerm`, as `ShortfallRemedy` holds `Selectable[VocabularyTerm]`, are the vocabulary a decision names for the object's options.
  if (arg.kind === "named" && arg.name === "VocabularyTerm" && holder !== undefined) {
    // Options typed `VocabularyTerm`, as `ShortfallRemedy` holds `Selectable[VocabularyTerm]`, whose holding row lists their core terms, are
    // the vocabulary those terms make where the text writes the list once more, as `Preemption.remedy`'s (§ 2.6: a list is written once).
    const row = [...ctx.elements.values()].find((x) => (x.kind === "field" || x.kind === "key") && (x.kind === "field" ? x.element.required !== undefined && x.element.type.parsed.kind === "named" && x.element.type.parsed.name === holder : x.element.type_expr?.kind === "named" && x.element.type_expr.name === holder));
    const own = row && (row.kind === "field" || row.kind === "key") ? ctx.ir.value_lists.find((l) => row.element.value_lists.includes(l.id) && l.host === `${row.element.id}#${row.kind === "field" ? "description" : "meaning"}`) : undefined;
    const terms = own ? canonicalJson(own.items.map((i) => i.value)) : null;
    const same = terms === null ? undefined : [...ctx.elements.values()].map((x) => rowVocabulary(ctx, x)).find((v) => v !== null && v.terms !== null && canonicalJson(v.terms) === terms);
    if (same) return { kind: "apply", constructor: "Selectable", arguments: { T: named(same.name) } };
  }
  return typeOfExpr({ kind: "apply", name: m[1]!, arguments: [arg] }, ctx);
}

/** A type expression written in text, as `Map[Domain, Object]`: a name, or a name applied to arguments; null for anything else. */
export function parseTypeText(text: string): TypeExpr | null {
  let pos = 0;
  const src = text.replace(/\s+/g, "");
  const term = (): TypeExpr | null => {
    const m = /^[A-Z][A-Za-z0-9]*/.exec(src.slice(pos));
    if (!m) return null;
    pos += m[0].length;
    const name = m[0];
    if (src[pos] !== "[") return ["String", "Integer", "Number", "Boolean", "Enum", "Object"].includes(name) ? { kind: "scalar", name } : /^[A-Z]$/.test(name) ? { kind: "param", name } : { kind: "named", name };
    pos++;
    const args: TypeExpr[] = [];
    for (;;) {
      const a = term();
      if (a === null) return null;
      args.push(a);
      if (src[pos] === ",") pos++;
      else break;
    }
    if (src[pos] !== "]") return null;
    pos++;
    return name === "Array" && args.length === 1 ? { kind: "array", items: args[0]! } : { kind: "apply", name, arguments: args };
  };
  const t = term();
  return t !== null && pos === src.length ? t : null;
}

/** A condition the schema states: a sibling's value, "REQUIRED when `x` is `v`". */
const SIBLING_VALUE = /^REQUIRED when `([a-z][a-z0-9_]*)` is `([^`]+)`$/;

/** The rows of the object a typed row belongs to, by their key or field name, in the order the text writes them. */
function siblingRows(ctx: RuleContext, row: Element): Element[] {
  const object = objectOfRow(ctx.ir, row);
  return [...ctx.elements.values()].filter((x) => (x.kind === "field" || x.kind === "key") && objectOfRow(ctx.ir, x) === object);
}

const lastOf = (x: Element): string => (x.kind === "field" ? x.element.names[0]!.path : x.kind === "key" ? x.element.key.path : "").split(".").pop()!.replaceAll("[]", "");

/** The values a sibling row takes, where they are a vocabulary's or the boolean's, or null. */
function siblingValues(ctx: RuleContext, sibling: Element): string[] | null {
  const t = typedRowType(sibling, ctx);
  if (t?.kind === "boolean") return ["true", "false"];
  if (t?.kind !== "named") return null;
  const v = rowVocabulary(ctx, sibling);
  if (v?.terms) return v.terms;
  const d = (ctx.declared ?? []).find((x) => x.name === t.name && x.kind === "vocabulary");
  if (d?.terms) return d.terms;
  const entry = [...ctx.entries.entries()].find(([, x]) => x.as.role === "type" && x.as.name === t.name && x.as.layer === "vocabulary");
  const list = entry ? ctx.ir.value_lists.find((l) => l.id === entry[0]) : undefined;
  if (list) return list.items.map((i) => i.value);
  // A vocabulary whose value table lists its terms, as `MediaChannel`'s `channel` table.
  const tables = ctx.ir.tables.filter((tb) => tb.parent?.via === "header" && tb.parent.identifier === lastOf(sibling));
  const rows = ctx.ir.definitions.filter((x) => tables.some((tb) => tb.id === x.loc.table));
  return rows.length > 0 ? rows.map((x) => x.value) : null;
}

/** Whether a typed row's condition is the object's schema's to state (type rules § 8): a sibling's value, read by no other sibling's condition but the one that reads the most. */
function conditionStated(ctx: RuleContext, row: Element): { sibling: string } | null {
  if (row.kind !== "field" && row.kind !== "key") return null;
  const p = row.kind === "field" ? row.element.presence : (row.element.required?.parsed ?? null);
  if (p?.kind !== "clauses" || p.clauses.length !== 1 || p.clauses[0]!.qualifier !== "when") return null;
  const m = SIBLING_VALUE.exec(`REQUIRED when ${p.clauses[0]!.condition}`);
  if (!m) return null;
  const sibling = siblingRows(ctx, row).find((x) => lastOf(x) === m[1]);
  const values = sibling ? siblingValues(ctx, sibling) : null;
  return values !== null && values.includes(m[2]!) ? { sibling: m[1]! } : null;
}

/** Whether a conditional typed row's condition is a rule's: one the schema can't state, or on a sibling other than the one the object's schema reads. */
export function conditionLeft(ctx: RuleContext, row: Element): boolean {
  if (row.kind !== "field" && row.kind !== "key") return false;
  if (presenceOf(row.element) !== "conditional") return false;
  const own = conditionStated(ctx, row);
  if (own === null) return true;
  const counts = new Map<string, number>();
  for (const x of siblingRows(ctx, row)) {
    const s = presenceOf((x as { element: Field | Key }).element) === "conditional" ? conditionStated(ctx, x) : null;
    if (s) counts.set(s.sibling, (counts.get(s.sibling) ?? 0) + 1);
  }
  const keep = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || (a < b ? -1 : 1))[0];
  return own.sibling !== keep;
}

/** A typed row's type: its vocabulary, where its values define one, else its Type cell's (`typeOfExpr`). */
function typedRowType(e: Element, ctx: RuleContext): TypeRef | null {
  if (e.kind !== "field" && e.kind !== "key") return null;
  const expr = e.kind === "field" ? (e.element.required !== undefined ? e.element.type.parsed : null) : (e.element.type_expr ?? null);
  if (expr === null) return null;
  const v = rowVocabulary(ctx, e);
  if (v === null) return typeOfExpr(expr, ctx);
  const wrap = (x: TypeExpr): TypeRef | null => {
    if (x.kind === "array") {
      const i = wrap(x.items);
      return i === null ? null : list(i);
    }
    if (x.kind === "apply" && x.name === "Selectable") {
      const c = ctx.constructors.constructors.find((y) => y.name === "Selectable");
      const p = c?.parameters.find((y) => !y.optional);
      return p ? { kind: "apply", constructor: "Selectable", arguments: { [p.name]: named(v.name) } } : null;
    }
    return named(v.name);
  };
  return wrap(expr);
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
    id: "required-cell",
    says: "A statement that is a typed row's Required cell, as the stack's \"REQUIRED when `role` is `commitment`\", is the presence of the property the row maps to: what the object's schema states where it can state it, a value of one sibling the object's other conditions don't read, and otherwise a rule of the object.",
    derive: (e, ctx) => {
      if (e.kind !== "statement" || !e.element.host.endsWith("#required")) return null;
      const row = ctx.elements.get(e.element.host.slice(0, -"#required".length));
      if (row?.kind !== "field" && row?.kind !== "key") return null;
      const as = ctx.entries.get(row.element.id)?.as;
      // A key of a kernel type's table, as the stack's § 3.1 `Selectable` keys, is that type's schema, its presence too.
      if (as?.role === "schema") return { role: "schema", in: as.in };
      if (as?.role !== "property") return null;
      // A key a table adds to a profile is optional there, whatever its condition on the full form says.
      if ([...ctx.entries.values()].some((x) => x.as.role === "profile" && (x.as.name ?? x.as.document + x.as.profile) === as.object)) return { role: "schema", in: as.object };
      return conditionLeft(ctx, row) ? { role: "rule", object: as.object } : { role: "schema", in: as.object };
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
    id: "row-vocabulary-values",
    says: "A typed row's own value list is the vocabulary the row's values define (§ 2.6), which the vocabulary's schema expresses.",
    derive: (e, ctx) => {
      if (e.kind !== "value_list") return null;
      const host = ctx.elements.get(e.element.host.split("#")[0]!);
      const v = host ? rowVocabulary(ctx, host) : null;
      return v !== null && v.ir === e.element.id ? { role: "schema", in: v.name } : null;
    },
  },
  {
    id: "table-term",
    says: "A row of a value table that the one typed row of its key's name types, as the `cost_method` table's, is a term of that row's vocabulary, or restates one where the row lists its own values (§ 2.6).",
    derive: (e, ctx) => {
      if (e.kind !== "definition") return null;
      const t = tableOf(ctx.ir, e.element);
      if (t?.parent?.via !== "header") return null;
      const name = t.parent.identifier;
      const rows = [...ctx.elements.values()].filter((x) => (x.kind === "field" && x.element.names[0]!.path.split(".").pop()!.replaceAll("[]", "") === name) || (x.kind === "key" && x.element.key.path.split(".").pop()!.replaceAll("[]", "") === name));
      if (rows.length !== 1) return null;
      const row = rows[0]!;
      let v = rowVocabulary(ctx, row);
      // A row typed by a vocabulary a declaration gives, as `channel` is a `MediaChannel`, whose core terms its value table lists.
      if (v === null && (row.kind === "field" || row.kind === "key")) {
        const expr = row.kind === "field" ? (row.element.required !== undefined ? row.element.type.parsed : null) : (row.element.type_expr ?? null);
        const leaf = expr === null ? null : expr.kind === "apply" && expr.name === "Map" ? expr.arguments[0]! : leafOf(expr);
        const d = leaf?.kind === "named" ? (ctx.declared ?? []).find((x) => x.name === leaf.name && x.kind === "vocabulary") : undefined;
        if (d) v = { name: d.name, open: false, ir: "", terms: d.terms ?? null };
      }
      if (v === null) return null;
      if (v.terms === null) return { role: "term", vocabulary: v.name };
      return v.terms.includes(e.element.value) ? { role: "schema", in: v.name } : null;
    },
  },
  {
    id: "shared-type-row",
    says: "A row of a table of shared types whose name the mapping defines, as a vocabulary its Form cell's value list gives, is what that type's schema expresses.",
    derive: (e, ctx) => {
      if (e.kind !== "definition") return null;
      const row = sharedTypeRowOf(ctx, e.element.id);
      if (row === null) return null;
      if (row.value_lists.some((v) => typeNameOf(ctx, v) === row.value)) return { role: "schema", in: row.value };
      // A type the kernel holds in the text's form, under its name or the kernel's, or a declaration gives (§ 2.2).
      const t = typeOfExpr({ kind: "named", name: row.value }, ctx);
      if (t?.kind === "named") return { role: "schema", in: t.name };
      // A type that is another expression, as `Ext` is `Map[Domain, Object]`, is what that expression's constructor expresses.
      if (t?.kind === "apply") return { role: "schema", in: t.constructor };
      const p = kernelOn(ctx.kernel, ctx.lock).primitives.find((x) => x.name === row.value) ?? ctx.constructors.parts.find((x) => x.name === row.value);
      if (p) return { role: "schema", in: p.name };
      // A row a primitive's binding cites as the definition of its form, as the stack's `NamespacedTerm` cites `VocabularyTerm`'s grammar.
      const citing = kernelOn(ctx.kernel, ctx.lock).primitives.find((x) => (x.sources.spec ?? []).some((c) => c.ir === row.id && inScope(c.locks, ctx.lock)));
      return citing ? { role: "schema", in: citing.name } : null;
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
      // A key table the text writes for a kernel part outside the kernel's sections, as the stack's § 5.5 `ClockWindow`, is that part's too.
      const partKey = e.kind === "key" && ctx.constructors.parts.some((p) => p.name === objectOfKey(ctx.ir, e.element));
      if (ctx.moduleOf(e.element.loc.section) !== KERNEL_MODULE && !partKey) return null;
      // A key of a table the text writes for a kernel type, as the stack's § 3.1 `Selectable` keys, is that type's.
      const keyObject = e.kind === "key" ? objectOfKey(ctx.ir, e.element) : null;
      if (keyObject !== null && ![...ctx.constructors.constructors, ...ctx.constructors.parts].some((c) => c.name === keyObject)) return null;
      const { primitives, templates } = kernelCiters(ctx, e.element.id);
      if (templates.length === 1) return { role: "schema", in: templates[0]! };
      if (templates.length === 0 && primitives.length === 1) return { role: "schema", in: primitives[0]! };
      return null;
    },
  },
  {
    id: "example-file",
    says: "A sentence that names one file under `examples/`, in a section whose title names exactly one document, such as \"See `examples/proposal.yaml`.\" under § 6.1 Proposal, points to an example of that document, which the examples gate validates. A title that names no document by its whole name names the one document whose name ends in the title's last word, as \"Publication manifest\" the stack's `ProposalManifest`. A sentence that names several files points to an example of each, the document each file's name starts with, as `line-item-ctv-bonus.yaml` a line item.",
    derive: (e, ctx) => {
      if (e.kind !== "sentence") return null;
      const files = exampleFilesOf(e.element.text);
      const docs = documentsOf(ctx);
      if (files.length > 1) {
        // Each file's document is the longest one whose name, in kebab case, its file name starts with.
        const of = (f: string) => docs.filter((d) => f.split("/").pop()!.startsWith(`${words(d).replaceAll(" ", "-")}`)).sort((a, b) => b.length - a.length)[0];
        const objects = files.map(of);
        if (objects.some((o) => o === undefined)) return null;
        return { role: "example", object: objects[0]!, files: Object.fromEntries(files.map((f, i) => [f, objects[i]!])) };
      }
      if (files.length !== 1) return null;
      const title = ctx.ir.sections.find((s) => s.id === e.element.loc.section)?.title.toLowerCase() ?? "";
      const named = docs.filter((d) => new RegExp(`(^|[^a-z])${words(d)}($|[^a-z])`).test(title));
      if (named.length === 1) return { role: "example", object: named[0]! };
      const last = title.split(/[^a-z]+/).filter(Boolean).pop();
      const ending = named.length === 0 && last !== undefined ? docs.filter((d) => words(d).split(" ").pop() === last) : [];
      return ending.length === 1 ? { role: "example", object: ending[0]! } : null;
    },
  },
  {
    id: "programmed-sentence",
    says: "A prose sentence with no RFC 2119 keyword whose check a rule program states, as § 5.6.5's definitions of a commitment's figures (D-065), is a rule on the program's owner: the program says what the sentence requires of one payload, and the decision its vectors cite says why the sentence is a requirement.",
    derive: (e, ctx) => {
      if (e.kind !== "sentence") return null;
      const owner = ctx.programs?.[e.element.id]?.owner;
      return owner === undefined ? null : { role: "rule", object: owner };
    },
  },
  {
    id: "prose-sentence",
    says: "A prose sentence with no RFC 2119 keyword states no requirement of its own, so it is informative. A decision that rests on it covers it, so a change to it makes the decision stale.",
    derive: (e) => (e.kind === "sentence" ? { role: "informative" } : null),
  },
  {
    id: "typed-row",
    says: "A row of a table that types its rows in the text's own type names and has a Required column, as the stack's, is a property of its object with the type its Type cell names: Boolean the inline boolean, a name the object a key table defines under that name, a document, an array field's entry object, or a kernel primitive whose binding cites the text's definition of that name on the lock, `Array[T]` a list, and `Map[K, V]` and `Range[T]` the kernel's constructors.",
    derive: (e, ctx) => {
      if (e.kind !== "field" && e.kind !== "key") return null;
      // A key of a table the text writes for a kernel type, as `ClockWindow`'s, is that type's schema, not a property.
      if (e.kind === "key" && [...ctx.constructors.constructors, ...ctx.constructors.parts].some((c) => c.name === objectOfKey(ctx.ir, e.element))) return null;
      const type = typedRowType(e, ctx);
      if (type === null) return null;
      // A key that restates another row "in the form its row states", as `RequestedValue`'s, names its copy after its own object, which a decision gives.
      const object = e.kind === "key" ? objectOfKey(ctx.ir, e.element) : null;
      const restates = object !== null && [...ctx.ir.sentences, ...ctx.ir.statements].some((x) => x.text.startsWith(`\`${object}\` holds exactly one key`) && x.text.includes("in the form its row states"));
      if (restates && type.kind === "apply" && type.constructor !== "List") return null;
      return property(ctx.ir, e, type);
    },
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
    id: "marker-vocabulary",
    says: "A marker table whose rows define every marker the field and key rows carry, `mixed` among them where a row carries it, as the stack's § 3, declares the closed kernel vocabulary `Marker`, at its first row, whose terms the rows define.",
    derive: (ctx) => {
      const defined = new Set(ctx.ir.markers.map((m) => m.marker));
      const used = [...ctx.ir.fields.map((f) => f.marker), ...ctx.ir.keys.map((k) => k.marker)].filter((m): m is string => m !== undefined);
      if (ctx.ir.markers.length === 0 || used.length === 0 || !used.every((m) => defined.has(m))) return [];
      return [{ name: "Marker", kind: "vocabulary" as const, ir: ctx.ir.markers[0]!.id, source: { rule: "marker-vocabulary" }, open: false }];
    },
  },
  {
    id: "row-vocabulary",
    says: "A typed row's values define a vocabulary (§ 2.6): an `Enum` or `Integer` row's own list, closed, and a `VocabularyTerm` row's core terms, open, from its own list or the value table its key heads, named after the row's object and key, as `ProposalType` and `AssentEntryRole`, and declared at the element that writes the terms.",
    derive: (ctx) => {
      const out: Declaration[] = [];
      const seen = new Set<string>();
      for (const e of ctx.elements.values()) {
        const v = rowVocabulary(ctx, e);
        if (v === null || seen.has(v.name)) continue;
        seen.add(v.name);
        out.push({ name: v.name, kind: "vocabulary", ir: v.ir, source: { rule: "row-vocabulary" }, open: v.open, ...(v.terms && v.terms.length > 0 ? { terms: v.terms } : {}) });
      }
      return out;
    },
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
    says: "A key table that names a field or member describes a closed object, named after it and declared at the table's first row. One the text calls open, as the stack's § 2.5 \"the open objects `DocumentRef` (§ 2.2), `ErrorObject` (§ 2.4), and `CostParameters`\", is open, and the keys it doesn't list are another definition's. One a statement publishes as a file at a URL, as the stack's § 2.3 `ProposalManifest`, is a document.",
    derive: (ctx) => {
      // The objects a sentence calls open by name, as "and so are the open objects `DocumentRef` (§ 2.2), `ErrorObject` (§ 2.4), …".
      const openNamed = new Set(
        [...ctx.ir.sentences, ...ctx.ir.statements].flatMap((s) => {
          const m = /\bthe open objects? ((?:`[A-Z][A-Za-z0-9]*`[^`.]*)+)/.exec(s.text);
          return m ? [...m[1]!.matchAll(/`([A-Z][A-Za-z0-9]*)`/g)].map((x) => x[1]!) : [];
        }),
      );
      // The objects a statement publishes as a file of their own, as "A seller MAY publish `https://…/openproposal.json`, a `ProposalManifest`",
      // are documents.
      const published = new Set([...ctx.ir.sentences, ...ctx.ir.statements].flatMap((s) => [...s.text.matchAll(/\bpublish(?:es)? `https?:\/\/[^`]+`, an? `([A-Z][A-Za-z0-9]*)`/g)].map((m) => m[1]!)));
      return ctx.ir.tables.flatMap((t): Declaration[] => {
        // A module the mapping leaves for a later phase declares nothing yet.
        if (ctx.deferred(t.section)) return [];
        const first = ctx.ir.keys.find((k) => k.loc.table === t.id);
        const name = first ? objectOfKey(ctx.ir, first) : null;
        // A key table the text writes for a kernel type, as the stack's § 2.2 `Range` keys, describes that type, not an object of its own.
        if (name !== null && [...ctx.constructors.constructors, ...ctx.constructors.parts].some((c) => c.name === name)) return [];
        // So does a key table that adds keys to a profile, as "**`ProposalSummary`** adds this key:" (§ 2.6).
        if (name !== null && [...ctx.entries.values()].some((x) => x.as.role === "profile" && (x.as.name ?? x.as.document + x.as.profile) === name)) return [];
        if (!first || !name) return [];
        // A lead-in that reads "`X` holds the keys of `Y`" (the stack's § 2.6) gives `X` the keys of `Y`: a profile's, which it
        // includes, as `ManifestEntry` holds `ProposalSummary`'s, or an object's or an applied constructor's, which it holds.
        const lead = [...ctx.ir.sentences, ...ctx.ir.statements].find((s) => s.loc.section === t.section && s.text.startsWith(`\`${name}\` holds the keys of \``));
        const held = lead ? /^`[^`]+` holds the keys of `([^`]+)`/.exec(lead.text)![1]! : null;
        const ref = held === null ? null : heldType(held, ctx, name);
        const profile = held !== null && profileNames(ctx).has(held);
        if (published.has(name)) return [{ name, kind: "document" as const, ir: first.id, source: { rule: "key-table-object" } }];
        const open = openNamed.has(name);
        return [{ name, kind: "object" as const, ir: first.id, source: { rule: "key-table-object" }, open, ...(open ? { foreign_keys: true as const } : {}), ...(profile ? { includes: held! } : ref ? { holds: [ref] } : {}) }];
      });
    },
  },
  {
    id: "sub-field-object",
    says: "An array field whose items have rows of their own describes a closed `<Field>Entry` object, declared at the array field's row, where the field is typed Array[Object] or names that object as its item type.",
    derive: (ctx) =>
      ctx.ir.fields.flatMap((f) => {
        const path = f.names[0]!.path;
        // The stack types the array by its entry's name, `Array[PricingEntry]`, the name this rule gives it.
        const entry = `${pascalField(path)}Entry`;
        const typed = f.type.parsed.kind === "array" && f.type.parsed.items.kind === "named" && f.type.parsed.items.name === entry;
        if (!(isListOf(f, "Object") || typed) || !ctx.ir.fields.some((g) => g.names[0]!.path.startsWith(`${path}.`))) return [];
        return [{ name: entry, kind: "object" as const, ir: f.id, source: { rule: "sub-field-object" }, open: false }];
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
