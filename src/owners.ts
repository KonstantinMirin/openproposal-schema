/**
 * The owners of a text's field rows, and which of them an attribute of
 * another owner holds. A text that writes each object as its own table, as
 * the Deals API writes `Object: Terms`, names the object an attribute holds
 * by the attribute's name, typed `object` or an array of objects: `terms`
 * holds `Object: Terms`, and `buyerstatus` holds `Object: BuyerStatus`. Such
 * an owner is an object, not a document.
 */
import { pascalField } from "./constructors.ts";
import type { TypeExpr } from "./grammar/type-expr.ts";
import type { Field, SpecIR } from "./ir-types.ts";

/** The owner whose rows a field holds: a field of another owner, typed an object or a list of objects, whose name is that owner's document name in any case; null for any other field. */
export function heldOwnerOf(ir: Pick<SpecIR, "fields">, f: Field): string | null {
  // Only an object, or a list of objects: a field that may also hold a string, as "string or object", holds no owner's rows alone.
  const t = f.type.parsed;
  const object = (x: TypeExpr) => x.kind === "scalar" && x.name === "Object";
  if (!object(t) && !(t.kind === "array" && object(t.items))) return null;
  const name = f.names[0]!.segments.at(-1)!.name.toLowerCase();
  const owners = [...new Set(ir.fields.map((g) => g.owner))].filter((o) => o !== f.owner && pascalField(o).toLowerCase() === name);
  return owners.length === 1 ? owners[0]! : null;
}
