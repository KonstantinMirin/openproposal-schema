import { ExtractError } from "../../errors.ts";
import type { TypeExpr } from "../../grammar/type-expr.ts";

/** The type names OpenProposal's Type column may use. Anything else fails. */
export const SCALAR_TYPES = [
  "String",
  "Integer",
  "Number",
  "Boolean",
  "Enum",
  "Object",
  "Timestamp",
  "Offset",
] as const;
export type ScalarType = (typeof SCALAR_TYPES)[number];

/**
 * Parses an OpenProposal Type cell such as `Array[Object]` or
 * `Timestamp/Offset`.
 *
 * Grammar:
 *   union := term ("/" term)*
 *   term  := "Array" "[" union "]" | Scalar
 */
export function parseTypeExpr(raw: string, line?: number): TypeExpr {
  const src = raw.trim();
  let pos = 0;
  const fail = (why: string): never => {
    throw new ExtractError(`unparsed type expression "${raw}": ${why}`, line);
  };
  const ws = () => {
    while (pos < src.length && src[pos] === " ") pos++;
  };
  const word = (): string => {
    ws();
    const m = /^[A-Za-z]+/.exec(src.slice(pos));
    if (!m) return fail(`expected a type name at offset ${pos}`);
    pos += m[0].length;
    return m[0];
  };
  const expect = (ch: string) => {
    ws();
    if (src[pos] !== ch) fail(`expected "${ch}" at offset ${pos}`);
    pos++;
  };
  const term = (): TypeExpr => {
    const name = word();
    if (name === "Array") {
      expect("[");
      const items = union();
      expect("]");
      return { kind: "array", items };
    }
    if (!(SCALAR_TYPES as readonly string[]).includes(name)) fail(`unknown type name "${name}"`);
    return { kind: "scalar", name: name as ScalarType };
  };
  const union = (): TypeExpr => {
    const members = [term()];
    ws();
    while (src[pos] === "/") {
      pos++;
      members.push(term());
      ws();
    }
    return members.length === 1 ? members[0]! : { kind: "union", members };
  };
  const out = union();
  ws();
  if (pos !== src.length) fail(`unexpected "${src.slice(pos)}"`);
  return out;
}
