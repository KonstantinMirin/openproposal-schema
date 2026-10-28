/**
 * The fidelity oracle's readers of the Deals API's text (src/fidelity.ts):
 * the constraints its attribute tables state in a form that needs no
 * judgment, read from the IR alone, and what each type its Type cells name
 * accepts.
 *
 * Each attribute row states, in its Type cell, its base type, its presence,
 * and its default (type-cell.ts): `required` is `required`, and
 * `recommended` is `optional`, as is a bare cell, which states no presence
 * and which type rules § 4 reads as optional. A stated default is the
 * `default` form, and a cell that states none is the form with no value, so
 * the schema gives the attribute no default. A Description cell that says an
 * empty list means all, "If this is empty or missing" or "An empty list
 * implies", is the `empty` form. Its `` `n` = label `` codes are the `values` form,
 * each code a value of the attribute, or of each item for a list; a sentence
 * that reserves "values N and greater", as `pricetype`'s exchange-specific
 * auction types, makes every integer from N up a value too. A row that
 * refers to a list of another specification, as `devicetype` refers to
 * AdCOM's List: Device Types, is listed as unread: the registry-agreement
 * gate checks it. So are the Example Scenarios' rows, which the examples
 * read.
 */
import { jsonType, type ConstraintReader, type Restated, type SpecConstraint, type SpecLocation, type Unread } from "../../fidelity.ts";
import type { PathSegment } from "../../grammar/path.ts";
import type { TypeExpr } from "../../grammar/type-expr.ts";
import type { SpecIR } from "../../ir-types.ts";
import { canonicalJson } from "../../canonical.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** "Exchange-specific auction types can be defined using values 500 and greater": the first code of a vendor range. */
const VENDOR = /\busing values ([1-9][0-9]*) and greater\b/;

/** A sentence that says what an empty list means, as "If this is empty or missing, the deal is assumed to apply to all countries". */
const EMPTY = /\b(?:If this is empty or missing|An empty list implies)\b/;

/** A reference to a list another specification keeps, as "Refer to List: Device Type in AdCOM 1.0". */
const REFERRED_LIST = /\bRefer to List: [A-Z]/;

/** A code as the text writes it: a decimal integer is a number. */
const literal = (text: string): unknown => (/^-?(0|[1-9][0-9]*)$/.test(text) ? Number(text) : text);

export function readConstraints(ir: SpecIR): { constraints: SpecConstraint[]; unread: Unread[]; restated: Restated[]; projections: []; refused: [] } {
  const constraints: SpecConstraint[] = [];
  const unread: Unread[] = [];
  const add = (c: DistributiveOmit<SpecConstraint, "id">) => {
    const id = `${c.element}#${c.form}@${[("owner" in c.at.root ? c.at.root.owner : c.at.root.list), ...c.at.path.map((s) => s.name), c.at.member.name].join(".")}`;
    if (!constraints.some((x) => x.id === id)) constraints.push({ ...c, id } as SpecConstraint);
  };
  const lists = new Map(ir.value_lists.map((v) => [v.id, v]));
  for (const f of ir.fields) {
    for (const n of f.names) {
      const at: SpecLocation = { root: { owner: f.owner }, path: n.segments.slice(0, -1) as PathSegment[], member: n.segments.at(-1)! };
      const text = `${f.names.map((x) => x.path).join(" · ")} | ${f.type.raw} | ${f.description.text}`;
      // Presence: the Type cell's one level, `required` or `recommended`, which is optional.
      const clauses = f.presence?.kind === "clauses" ? f.presence.clauses : [];
      if (f.presence === null) add({ element: f.id, text, at, form: "optional" });
      else if (clauses.length === 1 && clauses[0]!.condition === null && clauses[0]!.qualifier === null) {
        add({ element: f.id, text, at, form: clauses[0]!.level === "REQUIRED" ? "required" : "optional" });
      } else unread.push({ element: f.id, form: "a presence other than one level in the Type cell", text });
      add({ element: f.id, text, at, form: "type", type: f.type.parsed });
      add(f.default !== undefined ? { element: f.id, text, at, form: "default", value: f.default.value } : { element: f.id, text, at, form: "default" });
      if (f.type.parsed.kind === "array" && EMPTY.test(f.description.text)) add({ element: f.id, text, at, form: "empty" });
      // The codes the Description cell lists, each a value of the attribute, or of each item of a list.
      const items = f.type.parsed.kind === "array";
      const vendor = VENDOR.exec(f.description.text);
      for (const id of f.value_lists) {
        const v = lists.get(id);
        if (!v) continue;
        const values = v.items.map((i) => literal(i.value)).filter((x, i, a) => a.findIndex((y) => canonicalJson(y) === canonicalJson(x)) === i);
        add({ element: v.id, text: v.items.map((i) => `${i.value} = ${i.annotation ?? ""}`).join(" | "), at, form: "values", values, open: false, items, ...(vendor ? { vendor: Number(vendor[1]) } : {}) });
      }
      if (REFERRED_LIST.test(f.description.text)) unread.push({ element: f.id, form: "a list of another specification, whose codes the registry-agreement gate checks", text });
    }
  }
  for (const c of ir.concepts) unread.push({ element: c.id, form: "a scenario row, which the examples read as part of a deal", text: c.columns.map((x) => `${x.name}: ${x.text}`).join(" | ") });
  return { constraints, unread, restated: [], projections: [], refused: [] };
}

/** Whether a value has the JSON type a stated type names. */
export function hasStatedType(v: unknown, t: TypeExpr): boolean {
  if (t.kind === "union") return t.members.some((m) => hasStatedType(v, m));
  if (t.kind === "array") return Array.isArray(v) && v.every((x) => hasStatedType(x, t.items));
  const j = jsonType(v);
  switch (t.name) {
    case "String":
      return j === "string";
    case "Integer":
      return j === "integer";
    case "Number":
      return j === "integer" || j === "number";
    case "Object":
      return j === "object";
    default:
      throw new Error(`the Deals API states no type "${t.name}"`);
  }
}

/** Another JSON type for each scalar, and for a list, a value that is no list and a list of a wrong item. */
const WRONG: Record<string, unknown[]> = { String: [42], Integer: ["1", 1.5], Number: ["1.5"], Object: ["x", [1]] };
export function wrongValues(t: TypeExpr): unknown[] {
  if (t.kind === "array") return ["x", ...wrongValues(t.items).slice(0, 1).map((x) => [x])];
  if (t.kind === "union") return t.members.flatMap(wrongValues).filter((x) => !hasStatedType(x, t));
  return WRONG[t.name] ?? [];
}

/** Values of a stated type beyond the baseline's: a number with a fraction, for a type that takes any number. */
export function rightValues(t: TypeExpr): unknown[] {
  if (t.kind === "array") return rightValues(t.items).map((x) => [x]);
  return t.kind === "scalar" && t.name === "Number" ? [0.5] : [];
}

/** The Deals API's readers for the fidelity oracle. */
export const FIDELITY: ConstraintReader = { readConstraints, hasStatedType, wrongValues, rightValues };
