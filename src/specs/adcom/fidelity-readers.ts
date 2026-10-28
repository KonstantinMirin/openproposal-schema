/**
 * AdCOM's readers for the fidelity oracle (src/fidelity.ts): what each list's
 * rows say a value of the list may and may not be, read from the IR alone.
 * Each code a row names is valid. A `500+` row makes the vendor range valid
 * from its first code, and the code below it invalid where no row names it;
 * a list with no such row makes 500 invalid. A `>0` row makes every positive
 * integer valid. A code no row names and no range covers is invalid: one
 * past the highest or the lowest code, and the first one missing between
 * two codes. So are a code written as a string and a number with a
 * fraction. A row whose value is none of these fails the gate. The objects'
 * rows, which a later phase maps, are listed as unread.
 */
import type { ConstraintReader, ListConstraint } from "../../fidelity.ts";
import type { SpecIR } from "../../ir-types.ts";

const CODE = /^-?(0|[1-9][0-9]*)$/;
const VENDOR = /^([1-9][0-9]*)\+$/;

export function readLists(ir: SpecIR): ListConstraint[] {
  const out: ListConstraint[] = [];
  for (const t of ir.tables) {
    const rows = ir.definitions.filter((d) => d.loc.table === t.id);
    if (rows.length === 0) continue;
    const codes = rows.filter((d) => CODE.test(d.value)).map((d) => Number(d.value));
    const vendor = rows.map((d) => VENDOR.exec(d.value)).find((m) => m !== null);
    const positive = rows.some((d) => d.value === ">0");
    const unreadable = rows.filter((d) => !CODE.test(d.value) && !VENDOR.test(d.value) && d.value !== ">0").map((d) => ({ row: d.id, value: d.value }));
    const covered = (n: number) => codes.includes(n) || (vendor !== undefined && n >= Number(vendor[1])) || (positive && n > 0);
    const valid = codes.map((c) => ({ value: c as unknown, why: `the code ${c}` }));
    const invalid: ListConstraint["invalid"] = [];
    if (vendor) {
      const from = Number(vendor[1]);
      valid.push({ value: from, why: `the first code of the vendor range ${vendor[0]}` }, { value: from + 1, why: `a code of the vendor range ${vendor[0]}` });
      if (!covered(from - 1)) invalid.push({ value: from - 1, why: "the code below the vendor range, which no row names" });
    } else if (!covered(500)) invalid.push({ value: 500, why: "the first code of a vendor range, which the list doesn't reserve" });
    if (positive) valid.push({ value: 1, why: "the first value of the row >0" }, { value: 30, why: "a value of the row >0" });
    if (codes.length > 0) {
      // A code no row names: one above the highest, or below the lowest where every code above is covered.
      const high = Math.max(...codes) + 1;
      const low = Math.min(...codes) - 1;
      if (!covered(high)) invalid.push({ value: high, why: "a code no row names" });
      else if (!covered(low)) invalid.push({ value: low, why: "a code no row names" });
      // The first code missing between two codes, where the codes skip one, as 16 in 10–15, 20–22.
      const sorted = [...new Set(codes)].sort((a, b) => a - b);
      const gap = sorted.slice(1).map((c, i) => [sorted[i]!, c] as const).find(([a, c]) => c - a > 1 && !covered(a + 1));
      if (gap && !invalid.some((x) => x.value === gap[0] + 1)) invalid.push({ value: gap[0] + 1, why: "a code no row names, between two the list names" });
      invalid.push({ value: String(codes[0]), why: "a code written as a string" }, { value: codes[0]! + 0.5, why: "a number with a fraction" });
    }
    out.push({ id: `${t.id}#values`, element: rows[0]!.id, rows: rows.map((d) => d.id), valid, invalid, ...(unreadable.length > 0 ? { unreadable } : {}) });
  }
  return out;
}

export const FIDELITY: ConstraintReader = {
  readConstraints(ir: SpecIR) {
    // The objects' rows state types, presence, and defaults that the objects phase maps; until then they are read by no form.
    const unread = ir.keys.map((k) => ({ element: k.id, form: "an object's attribute, which a later phase maps", text: `${k.key.path}: ${k.type?.text ?? ""}` }));
    return { constraints: [], unread, restated: [], projections: [], refused: [] };
  },
  readLists,
  hasStatedType: () => false,
  wrongValues: () => [],
  rightValues: () => [],
};
