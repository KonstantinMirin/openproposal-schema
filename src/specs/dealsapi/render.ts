/**
 * The Deals API's notation for the round trip (src/render.ts): each object's
 * `Attribute | Type | Description` table rendered from the model, row by
 * row, so the text and the schemas can't drift apart.
 *
 * What the model owns is rendered from the model: each attribute's name;
 * its Type cell, the base type in the text's words, `string`, `int`,
 * `float`, or `object`, with ` array` for a list, then `default` and the
 * value the property defaults to, then `required` for a required property;
 * and, inside the Description cell, each code list the row writes, from the
 * vocabulary or the titled codes the property takes, in the form the text
 * writes it, `` `n` = label `` runs or a sentence's "n = label, n = label".
 * The prose around a list is the IR's, copied verbatim: the model doesn't
 * own prose.
 *
 * Each table is its object's: the rows' owner names the object, as
 * `terms` names `Terms`, so a row pairs only with that object's property,
 * and a property the object has that cites no row of the table is a row the
 * text lacks, appended at the end.
 */
import type { Field, SpecIR, ValueList } from "../../ir-types.ts";
import type { TypeRef } from "../../mapping.ts";
import { pascalField } from "../../constructors.ts";
import type { ModelDoc, ModelProperty, ModelType } from "../../model.ts";
import type { RenderedRow, RenderedTable, RoundTripNotation } from "../../render.ts";

/** The tables the model renders: the objects' attribute tables. */
const attributeTables = (ir: SpecIR) => ir.tables.filter((t) => t.layout === "attribute");

const code = (s: string) => `\`${s}\``;
/** A name cell as the IR keeps it, with its leading pipe, as the cell's text. */
const cellText = (s: string) => s.replace(/^\s*\|/, "").replace(/\|\s*$/, "").trim();

/** A list's form in the text: `` `n` = label `` runs, or, in a sentence, "n = label, n = label". */
const listForms = (items: { value: string; label: string }[]): { cell: string; sentence: string } => ({
  cell: items.map((i) => `${code(i.value)} = ${i.label}`).join(" "),
  sentence: items.map((i) => `${i.value} = ${i.label}`).join(", "),
});

export const ROUND_TRIP: RoundTripNotation = {
  specTables(ir) {
    return attributeTables(ir).map((t) => ({
      id: t.id,
      layout: t.layout,
      section: t.section,
      header: t.header,
      rows: ir.fields.filter((f) => f.loc.table === t.id).map((f) => ({ row: f.id, cells: [cellText(f.name_cell), f.type_cell ?? f.type.raw, f.description.text], elements: [f.id] })),
    }));
  },
  renderTables(model: ModelDoc, ir: SpecIR) {
    const problems: string[] = [];
    const types = new Map(model.types.map((t) => [t.name, t]));
    /** The object a table's rows are attributes of, named by their owner. */
    const objectOf = (owner: string): Extract<ModelType, { kind: "object" | "document" }> | null => {
      const t = types.get(pascalField(owner));
      return t?.kind === "object" || t?.kind === "document" ? t : null;
    };
    /** The property of the row's own object that cites the row. */
    const propertyOf = (f: Field): { name: string; p: ModelProperty } | null => {
      const t = objectOf(f.owner);
      for (const [name, p] of Object.entries(t?.properties ?? {})) if (p.sources.includes(f.id)) return { name, p };
      return null;
    };
    /** A type in the text's words: the JSON type its schema has. */
    const base = (ref: TypeRef, where: string): string => {
      if (ref.kind === "apply" && ref.constructor === "List") return `${base(ref.arguments.T!, where)} array`;
      if (ref.kind === "boolean") return "boolean";
      if (ref.kind !== "named") {
        problems.push(`${where}: a type the Deals API's notation doesn't write`);
        return "?";
      }
      const t = types.get(ref.name);
      if (t === undefined) {
        problems.push(`${where}: no type "${ref.name}" in the model`);
        return "?";
      }
      return jsonWord(t);
    };
    const jsonWord = (t: ModelType): string => {
      if (t.kind === "vocabulary") return t.terms.every((x) => typeof x.value === "number") ? "int" : "string";
      if (t.kind === "object" || t.kind === "document" || t.kind === "part") return "object";
      if (t.kind === "primitive") {
        const json = (t.schema as { type?: string }).type;
        const word = { integer: "int", number: "float", object: "object", string: "string", boolean: "boolean", array: "array" }[json ?? ""];
        if (word === undefined) problems.push(`the primitive "${t.name}" has no JSON type the Deals API's notation writes`);
        return word ?? "?";
      }
      problems.push(`the type "${t.name}" is no kind the Deals API's notation writes`);
      return "?";
    };
    /** The codes a property takes, each with its label, from its vocabulary or its primitive's titled codes; a code the list gives twice once per meaning. */
    const codesOf = (ref: TypeRef): { value: string; label: string }[] | null => {
      const named = ref.kind === "apply" && ref.constructor === "List" ? ref.arguments.T! : ref;
      const t = named.kind === "named" ? types.get(named.name) : undefined;
      if (t?.kind === "vocabulary") return t.terms.flatMap((x) => (x.meanings ?? [x.annotation ?? ""]).map((label) => ({ value: String(x.value), label })));
      const oneOf = t?.kind === "primitive" ? (t.schema as { oneOf?: { const: number; title: string }[] }).oneOf : undefined;
      return oneOf ? oneOf.map((b) => ({ value: String(b.const), label: b.title })) : null;
    };
    /** The Description cell: the IR's prose, with each code list the row writes rendered from the property's codes. */
    const description = (f: Field, p: ModelProperty): string => {
      let text = f.description.text;
      const lists = f.value_lists.map((id) => ir.value_lists.find((v) => v.id === id)).filter((v): v is ValueList => v !== undefined);
      for (const v of lists) {
        const spec = listForms(v.items.map((i) => ({ value: i.value, label: i.annotation ?? "" })));
        const mine = codesOf(p.type);
        if (mine === null) {
          problems.push(`${f.id}: the row lists codes, and its property takes no vocabulary or titled codes`);
          continue;
        }
        const rendered = listForms(mine);
        if (text.includes(spec.cell)) text = text.replace(spec.cell, rendered.cell);
        else if (text.includes(spec.sentence)) text = text.replace(spec.sentence, rendered.sentence);
        else problems.push(`${f.id}: can't find the codes "${spec.cell}" in the cell's text`);
      }
      return text;
    };
    const tables: RenderedTable[] = [];
    for (const t of attributeTables(ir)) {
      const rows: RenderedRow[] = [];
      const fields = ir.fields.filter((x) => x.loc.table === t.id);
      for (const f of fields) {
        const found = propertyOf(f);
        if (found === null) {
          rows.push({ row: f.id, cells: [], elements: [f.id] });
          continue;
        }
        const { name, p } = found;
        const type = [base(p.type, f.id), ...(p.default !== undefined ? [`default ${JSON.stringify(p.default)}`] : []), ...(p.presence === "required" ? ["required"] : [])].join(", ");
        rows.push({ row: f.id, cells: [code(name), type, description(f, p)], elements: [...new Set([f.id, ...p.sources])].sort() });
      }
      // A property of the table's object that cites none of its rows is a row the text lacks.
      const object = fields[0] ? objectOf(fields[0].owner) : null;
      const rowIds = new Set(fields.map((f) => f.id));
      for (const [name, p] of Object.entries(object?.properties ?? {})) {
        if (p.sources.some((s) => rowIds.has(s))) continue;
        const type = [base(p.type, `${object!.name}.${name}`), ...(p.default !== undefined ? [`default ${JSON.stringify(p.default)}`] : []), ...(p.presence === "required" ? ["required"] : [])].join(", ");
        rows.push({ row: `${object!.name}.${name}`, cells: [code(name), type, p.description ?? ""], elements: [...p.sources].sort() });
      }
      tables.push({ id: t.id, layout: t.layout, section: t.section, header: t.header, rows });
    }
    return { tables, figures: null, problems };
  },
  specFigures: () => null,
  describeFigures: () => ({ title: "", text: "" }),
};
