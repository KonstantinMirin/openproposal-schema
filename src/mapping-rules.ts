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
import type { Kernel } from "./kernel.ts";
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

/** The two documents, by the `owner` the extractor gives a field row. */
export const DOCUMENTS: Record<Field["owner"], string> = { proposal: "Proposal", line_item: "LineItem" };

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
  if (segments.length === 1) return DOCUMENTS[f.owner];
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
  return [...new Set([...Object.values(DOCUMENTS), ...defined])].sort();
}

/** The entry rules, tried in order; the first that applies derives the entry. */
export const ENTRY_RULES: EntryRule[] = [
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
    says: "A row of the § 1.1 concept table names a downstream standard, and carries no field, key, value, or marker.",
    derive: (e) => (e.kind === "concept" ? { role: "informative" } : null),
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
    says: "A value list with the same values, in the same order, as a vocabulary another entry defines restates it; one with a kernel primitive's `enum`, such as a daypart window's days and `DayName`, is what the primitive's schema expresses.",
    derive: (e, ctx) => {
      if (e.kind !== "value_list") return null;
      const values = canonicalJson(e.element.items.map((i) => i.value));
      const same = ctx.ir.value_lists.filter((v) => v.id !== e.element.id && canonicalJson(v.items.map((i) => i.value)) === values);
      const defined = same.flatMap((v) => {
        const as = ctx.entries.get(v.id)?.as;
        return as?.role === "type" && as.layer === "vocabulary" ? [as.name] : [];
      });
      const listed = ctx.kernel.primitives.filter((p) => Array.isArray(p.constraints.enum) && canonicalJson(p.constraints.enum.map(String)) === values).map((p) => p.name);
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
    says: "A String, Number, Integer, or Array[String] field, or a key row with no value list or inline object, that exactly one concept of the domain model cites has the concept's type, or a list of it where the row is a list.",
    derive: (e, ctx) => {
      if (e.kind !== "field" && e.kind !== "key") return null;
      if (e.kind === "field" && !["String", "Number", "Integer", "Array[String]"].includes(e.element.type.raw)) return null;
      if (e.kind === "key" && (e.element.value_lists.length > 0 || e.element.inline_objects.length > 0)) return null;
      const c = ctx.kernel.domains ? conceptOfRow(ctx.kernel.domains, e.element.id) : null;
      if (c === null) return null;
      const type: TypeRef = c.type === BOOLEAN ? { kind: "boolean" } : named(c.type);
      const array = e.kind === "field" ? e.element.type.parsed.kind === "array" : e.element.key.path.endsWith("[]");
      return property(ctx.ir, e, array ? list(type) : type);
    },
  },
  {
    id: "enum-row",
    says: "An Enum field, or a key, whose row holds exactly one value list has the vocabulary that list defines.",
    derive: (e, ctx) => {
      if (e.kind !== "field" && e.kind !== "key") return null;
      if (e.kind === "field" && scalarOf(e.element) !== "Enum") return null;
      if (e.element.value_lists.length !== 1 || e.element.inline_objects.length > 0) return null;
      const name = typeNameOf(ctx, e.element.value_lists[0]!);
      return name === null ? null : property(ctx.ir, e, named(name));
    },
  },
  {
    id: "inline-object-row",
    says: "An Object field, an Array[Object] field, or a key whose row holds exactly one inline object, not an option of `available[]`, has that object, or a list of it for an array.",
    derive: (e, ctx) => {
      if (e.kind !== "field" && e.kind !== "key") return null;
      if (e.kind === "field" && ["selectable", "settable", "mixed"].includes(e.element.marker)) return null;
      if (e.element.inline_objects.length !== 1) return null;
      const o = ctx.ir.inline_objects.find((x) => x.id === e.element.inline_objects[0]);
      if (!o || o.anchor !== null) return null;
      const name = typeNameOf(ctx, o.id);
      if (name === null) return null;
      const array = e.kind === "field" ? e.element.type.parsed.kind === "array" : e.element.key.path.endsWith("[]");
      if (e.kind === "field" && e.element.type.raw !== (array ? "Array[Object]" : "Object")) return null;
      return property(ctx.ir, e, array ? list(named(name)) : named(name));
    },
  },
  {
    id: "keyed-object-field",
    says: "An Object field, not marked selectable or settable, that a key table describes has the object that the table describes.",
    derive: (e, ctx) => {
      if (e.kind !== "field" || e.element.type.raw !== "Object" || ["selectable", "settable"].includes(e.element.marker)) return null;
      const table = ctx.ir.tables.find((t) => t.parent?.field === e.element.id && t.layout.startsWith("key-"));
      if (!table || e.element.inline_objects.length > 0) return null;
      return property(ctx.ir, e, named(pascalField(e.element.names[0]!.path)));
    },
  },
  {
    id: "sub-field-array",
    says: "An Array[Object] field whose items have rows of their own, and no inline object, is a list of its `<Field>Entry` object.",
    derive: (e, ctx) => {
      if (e.kind !== "field" || e.element.type.raw !== "Array[Object]" || e.element.inline_objects.length > 0) return null;
      const path = e.element.names[0]!.path;
      if (!ctx.ir.fields.some((f) => f.names[0]!.path.startsWith(`${path}.`))) return null;
      return property(ctx.ir, e, list(named(`${pascalField(path)}Entry`)));
    },
  },
];

/** The declaration rules: types that the IR's structure implies, with no single element that defines them. */
export const DECLARATION_RULES: DeclarationRule[] = [
  {
    id: "document-owner",
    says: "The owners of the field rows are the documents `Proposal` and `LineItem`, each declared at its first field row.",
    derive: (ctx) => {
      const out: Declaration[] = [];
      for (const owner of ["proposal", "line_item"] as const) {
        const first = ctx.ir.fields.find((f) => f.owner === owner);
        if (first) out.push({ name: DOCUMENTS[owner], kind: "document", ir: first.id, source: { rule: "document-owner" } });
      }
      return out;
    },
  },
  {
    id: "key-table-object",
    says: "A key table that names a field or member describes a closed object, named after it and declared at the table's first row.",
    derive: (ctx) =>
      ctx.ir.tables.flatMap((t) => {
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
        if (f.type.raw !== "Array[Object]" || !ctx.ir.fields.some((g) => g.names[0]!.path.startsWith(`${path}.`))) return [];
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
