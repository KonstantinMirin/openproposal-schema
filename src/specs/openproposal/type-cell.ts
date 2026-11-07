import { ExtractError } from "../../errors.ts";
import type { TypeExpr } from "../../grammar/type-expr.ts";

/** The built-in type names OpenProposal's Type column may use. */
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
 * `Timestamp/Offset`, or, in a text that defines its own types, as the
 * stack's § 2.2 does, `Instant`, `Selectable[FormatId]`,
 * `Map[ExclusionType, ExclusionList]`, or a generic type's parameter `T`.
 *
 * Grammar:
 *   union := term ("/" term)*
 *   term  := "Array" "[" union "]"
 *          | Name "[" union ("," union)* "]"
 *          | Scalar | Param | Name
 *   Name  := an uppercase letter, then letters and digits, two characters or more
 *   Param := one uppercase letter
 *
 * A built-in name with arguments, `Array` with other than one, or `Map`
 * with other than two, fails.
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
    const m = /^[A-Za-z][A-Za-z0-9]*/.exec(src.slice(pos));
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
    ws();
    if (src[pos] === "[") {
      pos++;
      const args = [union()];
      ws();
      while (src[pos] === ",") {
        pos++;
        args.push(union());
        ws();
      }
      expect("]");
      if (name === "Array") {
        if (args.length !== 1) fail(`"Array" takes one argument, not ${args.length}`);
        return { kind: "array", items: args[0]! };
      }
      if ((SCALAR_TYPES as readonly string[]).includes(name)) fail(`"${name}" takes no arguments`);
      if (name === "Map" && args.length !== 2) fail(`"Map" takes two arguments, a key type and a value type, not ${args.length}`);
      if (!/^[A-Z][A-Za-z0-9]+$/.test(name)) fail(`"${name}" isn't a type name`);
      return { kind: "apply", name, arguments: args };
    }
    if (name === "Array") fail(`"Array" needs its item type`);
    if ((SCALAR_TYPES as readonly string[]).includes(name)) return { kind: "scalar", name: name as ScalarType };
    if (/^[A-Z]$/.test(name)) return { kind: "param", name };
    if (!/^[A-Z][A-Za-z0-9]+$/.test(name)) fail(`unknown type name "${name}"`);
    return { kind: "named", name };
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
