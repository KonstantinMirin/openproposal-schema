/**
 * AdCOM's notation for the round trip (src/render.ts): each list's table of
 * codes, as the IR records it and as the model's vocabulary renders it, code
 * by code, with each code's label in the table's columns, and the vendor
 * range a `500+` row writes. The objects' tables wait for the objects phase,
 * and the change log is no list, so neither is rendered.
 */
import type { SpecIR } from "../../ir-types.ts";
import type { ModelDoc } from "../../model.ts";
import type { RenderedTable, RoundTripNotation } from "../../render.ts";

/** The list tables of the IR: the tables of definition rows. */
const listTables = (ir: SpecIR) => ir.tables.filter((t) => ir.definitions.some((d) => d.loc.table === t.id));

/** A label in a table's columns after the value: one column whole, or, for a table with two, the first up to `: ` and the rest. */
function columnsOf(label: string, n: number): string[] {
  if (n <= 1) return [label];
  const at = label.indexOf(": ");
  return at < 0 ? [label, ...Array<string>(n - 1).fill("")] : [label.slice(0, at), label.slice(at + 2)];
}

export const ROUND_TRIP: RoundTripNotation = {
  specTables(ir) {
    return listTables(ir).map((t) => ({
      id: t.id,
      layout: t.layout,
      section: t.section,
      header: t.header,
      rows: ir.definitions.filter((d) => d.loc.table === t.id).map((d) => ({ row: d.id, cells: [d.value, ...d.columns.map((c) => c.text)], elements: [d.id] })),
    }));
  },
  renderTables(model: ModelDoc, ir: SpecIR) {
    const problems: string[] = [];
    const tables: RenderedTable[] = [];
    for (const t of listTables(ir)) {
      const rows = ir.definitions.filter((d) => d.loc.table === t.id).map((d) => d.id);
      // The vocabulary whose terms these rows give, found by its terms' sources.
      const v = model.types.find((x) => x.kind === "vocabulary" && x.terms.some((term) => term.sources.some((s) => rows.includes(s))));
      if (!v || v.kind !== "vocabulary") {
        problems.push(`${t.id}: no vocabulary of the model holds the codes of ${t.section}`);
        continue;
      }
      const n = t.header.length - 1;
      const out: RenderedTable["rows"] = v.terms.map((term) => ({ row: term.sources.find((s) => rows.includes(s)) ?? `${v.name}:${String(term.value)}`, cells: [String(term.value), ...columnsOf(term.annotation ?? "", n)], elements: term.sources }));
      if (v.vendor) out.push({ row: rows.find((r) => r.endsWith(`:${v.vendor!.from}+`)) ?? `${v.name}:vendor`, cells: [`${v.vendor.from}+`, ...columnsOf(v.vendor.label, n)], elements: [] });
      tables.push({ id: t.id, layout: t.layout, section: t.section, header: t.header, rows: out });
    }
    return { tables, figures: null, problems };
  },
  specFigures: () => null,
  describeFigures: () => ({ title: "", text: "" }),
};
