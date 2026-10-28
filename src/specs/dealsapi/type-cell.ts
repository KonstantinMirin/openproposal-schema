/**
 * The Deals API's type cell (plan § 4.2): a base type, optionally an array,
 * then qualifiers, each after a `;` or a `,`, that state the attribute's
 * presence and default, as `string; **required**`, `int, default 0,
 * recommended`, and `string; default "USD"`.
 *
 *   cell      := base [" array"] (sep qualifier)*
 *   base      := "string" | "int" | "integer" | "float" | "object"
 *   sep       := ";" | ","
 *   qualifier := "required" | "recommended" | "default" literal
 *   literal   := an integer, a decimal, or a string in double quotes
 *
 * A qualifier may be bold, as `**required**`; the cell is read as plain
 * text, so the bold leaves no mark. Any other form fails extraction.
 */
import { ExtractError } from "../../errors.ts";
import type { Presence, PresenceLevel } from "../../grammar/required.ts";
import type { TypeExpr } from "../../grammar/type-expr.ts";

/** The scalar each base type the text writes stands for, in the IR's type names, which every plugin shares. */
const BASES: Readonly<Record<string, string>> = { string: "String", int: "Integer", integer: "Integer", float: "Number", object: "Object" };

/** What a type cell states: the base type as written and as the IR names it, the attribute's presence, and its default. */
export interface TypeCell {
  /** The base type as the cell writes it, as `string array`. */
  base: string;
  parsed: TypeExpr;
  presence: Presence | null;
  default: { raw: string; value: string | number } | null;
}

const LITERAL = /^default\s+(-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?|"[^"]*")$/;

/** Parses a type cell's plain text. Throws on a base, qualifier, or literal the grammar doesn't know, and on a qualifier stated twice. */
export function parseTypeCell(text: string, line: number): TypeCell {
  const [head, ...rest] = text.trim().split(/\s*[;,]\s*/);
  const m = /^(string|int|integer|float|object)( array)?$/.exec(head ?? "");
  if (!m) throw new ExtractError(`unparsed type cell "${text}": its base "${head}" is none of ${Object.keys(BASES).join(", ")}, with or without " array"`, line);
  const scalar: TypeExpr = { kind: "scalar", name: BASES[m[1]!]! };
  let level: PresenceLevel | null = null;
  let def: TypeCell["default"] = null;
  for (const q of rest) {
    if (q === "required" || q === "recommended") {
      if (level !== null) throw new ExtractError(`unparsed type cell "${text}": it states presence twice`, line);
      level = q === "required" ? "REQUIRED" : "RECOMMENDED";
      continue;
    }
    const d = LITERAL.exec(q);
    if (!d) throw new ExtractError(`unparsed type cell "${text}": the qualifier "${q}" is none of required, recommended, or default with a number or a quoted string`, line);
    if (def !== null) throw new ExtractError(`unparsed type cell "${text}": it states a default twice`, line);
    const raw = d[1]!;
    def = { raw, value: raw.startsWith('"') ? raw.slice(1, -1) : Number(raw) };
  }
  // A default is a value of the base type: a number for a number, an integer for an integer, and a string for a string.
  if (def !== null) {
    const name = BASES[m[1]!]!;
    const fits = m[2] === undefined && (typeof def.value === "string" ? name === "String" : name === "Number" || (name === "Integer" && Number.isInteger(def.value)));
    if (!fits) throw new ExtractError(`unparsed type cell "${text}": the default ${def.raw} is no value of ${head}`, line);
  }
  return {
    base: head!,
    parsed: m[2] ? { kind: "array", items: scalar } : scalar,
    presence: level === null ? null : { kind: "clauses", clauses: [{ level, qualifier: null, condition: null }] },
    default: def,
  };
}
