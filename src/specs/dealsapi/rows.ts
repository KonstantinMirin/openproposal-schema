/**
 * The Deals API's attribute rows: an attribute, its Type cell, which states
 * its presence and default too, and its description, owned by the object
 * whose `Object:` section the table sits in.
 */
import type { TableCell } from "mdast";
import { ExtractError } from "../../errors.ts";
import { plain, render, tokenize } from "../../markdown.ts";
import type { ExtractContext, RowInput } from "../plugin.ts";
import { objectOf } from "./text.ts";
import { parseTypeCell } from "./type-cell.ts";

/** An object's name in snake case, the owner its rows carry: `BuyerSeat` is `buyer_seat`, which names the document or object `BuyerSeat` back. */
export const ownerOfObject = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** An attribute row of an `Object:` table. */
export function attributeRow(input: RowInput, ctx: ExtractContext): void {
  const { loc, digest } = input;
  const [nameC, typeC, descC] = input.cells as [TableCell, TableCell, TableCell];
  const object = objectOf(ctx.section);
  if (object === null) throw new ExtractError(`an attribute row in "${ctx.section.title}", which names no object`, loc.line);
  const names = ctx.nameCell(nameC, loc.line);
  if (names.length !== 1) throw new ExtractError(`an attribute cell names ${names.length} attributes; the text writes one per row`, loc.line);
  const id = `field:${ctx.section.id}:${names[0]!.path}`;
  ctx.claim(id, loc.line, "field");
  // The Type cell is words and bold only; a code span or a link would be read as words and lose what it marks.
  const typeTokens = tokenize(typeC.children);
  if (typeTokens.some((t) => t.kind === "code") || typeC.children.some((c) => c.type === "link" || c.type === "html")) throw new ExtractError(`the Type cell "${render(typeTokens)}" holds a code span, a link, or HTML, which the type-cell grammar doesn't read`, loc.line);
  const typeText = plain(typeTokens).trim();
  const cell = parseTypeCell(typeText, loc.line);
  const hosted = ctx.phrasing(`${id}#description`, "table_cell", tokenize(descC.children), loc);
  ctx.ir.fields.push({
    id,
    owner: ownerOfObject(object),
    names,
    name_cell: ctx.slice(nameC).trim(),
    type: { raw: cell.base, parsed: cell.parsed },
    type_cell: typeText,
    ...(cell.default !== null ? { default: cell.default } : {}),
    description: ctx.cellText(descC),
    presence: cell.presence,
    ...hosted,
    digest,
    loc,
  });
}
