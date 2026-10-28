/**
 * OpenProposal's own rows: the § 4 and § 5 field rows, with their
 * mutability marker and their description's REQUIRED or OPTIONAL sentence,
 * and the Appendix A and B rows that restate them, with the distribution's
 * figures.
 */
import type { TableCell } from "mdast";
import { ExtractError } from "../../errors.ts";
import { parsePresence, resolveWith, type Presence } from "../../grammar/required.ts";
import type { AppendixARow, AppendixBRow, Distribution, SpecIR } from "../../ir-types.ts";
import type { TypeExpr } from "../../grammar/type-expr.ts";
import { collapse, plain, render, tokenize, type Token } from "../../markdown.ts";
import type { DocumentOwner } from "../../profile.ts";
import { splitSentences } from "../../sentences.ts";
import type { ExtractContext, RowInput } from "../plugin.ts";
import { parseTypeExpr } from "./type-cell.ts";

/** The mutability markers a field row may carry. A row with any other marker fails extraction. */
export const MARKERS = ["immutable", "seller-set", "selectable", "settable", "supplied", "requestable", "derived", "mixed"] as const;

/** A field row: its names, its Type cell, its marker, and its description, owned by the document whose section it sits in. */
export function fieldRow(input: RowInput, ctx: ExtractContext, documents: readonly DocumentOwner[]): void {
  const { loc, digest } = input;
  const [nameC, typeC, markerC, descC] = input.cells as [TableCell, TableCell, TableCell, TableCell];
  const names = ctx.nameCell(nameC, loc.line);
  const owner = documents.find((d) => d.section === ctx.section.id.split(/[./]/)[0])?.owner;
  if (!owner) throw new ExtractError(`no owner object for a field in § ${ctx.section.id}`, loc.line);
  const id = `field:${ctx.section.id}:${names.map((n) => n.path).join(",")}`;
  ctx.claim(id, loc.line, "field");
  const typeRaw = plain(tokenize(typeC.children));
  const marker = plain(tokenize(markerC.children));
  if (!(MARKERS as readonly string[]).includes(marker)) {
    throw new ExtractError(`unknown mutability marker "${marker}"`, loc.line);
  }
  const descTokens = tokenize(descC.children);
  const hosted = ctx.phrasing(`${id}#description`, "table_cell", descTokens, loc);
  ctx.ir.fields.push({
    id,
    owner,
    names,
    name_cell: ctx.slice(nameC).trim(),
    type: { raw: typeRaw, parsed: parseTypeExpr(typeRaw, loc.line) },
    marker,
    description: ctx.cellText(descC),
    presence: descriptionPresence(descTokens),
    ...hosted,
    digest,
    loc,
  });
}

/** A description's leading REQUIRED, RECOMMENDED, or OPTIONAL sentence, as a presence. */
function descriptionPresence(tokens: Token[]): Presence | null {
  const sentences = splitSentences(tokens);
  for (const [i, s] of sentences.entries()) {
    if (/^(REQUIRED|RECOMMENDED|OPTIONAL)\b/.test(s.text)) {
      return resolveWith(parsePresence(s.text, MARKERS, s.line), i > 0 ? sentences[i - 1]!.codes : null, s.text, s.line);
    }
  }
  return null;
}

/** An Appendix A row: a field's names, its section, its type, and its marker, as the appendix restates them. */
export function appendixARow(input: RowInput, ctx: ExtractContext): void {
  const { loc, digest, table } = input;
  const [nameC, sectionC, typeC, markerC] = input.cells as [TableCell, TableCell, TableCell, TableCell];
  const names = ctx.nameCell(nameC, loc.line);
  const sectionCell = plain(tokenize(sectionC.children));
  const typeRaw = plain(tokenize(typeC.children));
  let parsed: TypeExpr | null = null;
  try {
    parsed = parseTypeExpr(typeRaw, loc.line);
  } catch {
    parsed = null; // Appendix A is a claim to check; stage 2 reports a type it can't parse.
  }
  const id = `appendix-a:${loc.row}`;
  ctx.claim(id, loc.line, "Appendix A row");
  const rowRecord: AppendixARow = {
    id,
    names,
    name_cell: ctx.slice(nameC).trim(),
    section_cell: sectionCell,
    section_number: /^(\d+(?:\.\d+)*)\s/.exec(sectionCell)?.[1] ?? null,
    type: { raw: typeRaw, parsed },
    marker: plain(tokenize(markerC.children)),
    digest,
    loc,
  };
  ctx.ir.appendix_a ??= { section: ctx.section.id, table: table.id, rows: [] };
  ctx.ir.appendix_a.rows.push(rowRecord);
}

/** An Appendix B row: a marker, its count, its meaning, and the fields it lists. */
export function appendixBRow(input: RowInput, ctx: ExtractContext): void {
  const { loc, digest, table } = input;
  const [markerC, countC, meaningC, fieldsC] = input.cells as [TableCell, TableCell, TableCell, TableCell];
  const marker = plain(tokenize(markerC.children));
  const countCell = plain(tokenize(countC.children));
  const id = `appendix-b:${marker}`;
  ctx.claim(id, loc.line, "Appendix B row");
  const rowRecord: AppendixBRow = {
    id,
    marker,
    count: /^\d+$/.test(countCell) ? Number(countCell) : null,
    count_cell: countCell,
    meaning: render(tokenize(meaningC.children)),
    fields: appendixBFields(tokenize(fieldsC.children), loc.line),
    digest,
    loc,
  };
  ctx.ir.appendix_b ??= { section: ctx.section.id, table: table.id, rows: [], distribution: null };
  ctx.ir.appendix_b.rows.push(rowRecord);
}

/** Parses "`a`, `b` · `c`, `d` (proposal)" into field labels. */
function appendixBFields(tokens: Token[], at: number): AppendixBRow["fields"] {
  const out: AppendixBRow["fields"] = [];
  let names: string[] = [];
  const close = (owner: string | null) => {
    if (names.length === 0) throw new ExtractError("Appendix B field list has an empty entry", at);
    out.push({ label: names.map((n) => "`" + n + "`").join(" · ") + (owner ? ` (${owner})` : ""), names, owner });
    names = [];
  };
  for (const t of tokens) {
    if (t.kind === "code") {
      names.push(t.value);
      continue;
    }
    const m = /^\s*(?:\(([^()]*)\))?\s*([,·])?\s*$/.exec(t.value);
    if (!m) throw new ExtractError(`unparsed Appendix B field list text "${t.value}"`, at);
    if (m[2] === "·") continue;
    if (m[2] === "," || m[1] !== undefined) close(m[1] ?? null);
  }
  if (names.length > 0) close(null);
  return out;
}

/** The section of Appendix B whose prose states the distribution's figures. */
const isDistribution = (ctx: ExtractContext) => ctx.section.parent === "B" && ctx.section.title === "What the distribution says";

/** The paragraphs of each extraction's distribution section, by the IR it builds. */
const paragraphs = new WeakMap<SpecIR, Token[][]>();

/** Keeps a paragraph of the distribution section. */
export function onParagraph(tokens: Token[], ctx: ExtractContext): void {
  if (!isDistribution(ctx)) return;
  const list = paragraphs.get(ctx.ir) ?? [];
  list.push(tokens);
  paragraphs.set(ctx.ir, list);
}

/** Reads the distribution's figures into Appendix B, from "Of N fields, …" and "Only the N requestable fields …". */
export function finalize(ctx: ExtractContext): void {
  if (ctx.ir.appendix_b) ctx.ir.appendix_b.distribution = parseDistribution(ctx.ir, paragraphs.get(ctx.ir) ?? []);
}

function parseDistribution(ir: SpecIR, distribution: Token[][]): Distribution | null {
  if (distribution.length === 0) return null;
  const text = collapse(distribution.map((t) => plain(t)).join(" "));
  const a =
    /Of (\d+) fields, (\d+) are touched by the buyer — (\d+) selectable, (\d+) settable, (\d+) supplied and (\d+) requestable\. The remaining (\d+) are/.exec(
      text,
    );
  const b = /Only the (\d+) requestable fields require a round trip\. Everything else the buyer touches — (\d+) fields —/.exec(text);
  if (!a || !b) return null;
  const n = (s: string | undefined) => Number(s);
  const section = ir.sections.find((s) => s.parent === "B" && s.title === "What the distribution says")!;
  return {
    total: n(a[1]),
    buyer: n(a[2]),
    selectable: n(a[3]),
    settable: n(a[4]),
    supplied: n(a[5]),
    requestable: n(a[6]),
    remaining: n(a[7]),
    round_trip: n(b[1]),
    up_front: n(b[2]),
    loc: { section: section.id, line: distribution[0]![0]!.line },
  };
}
