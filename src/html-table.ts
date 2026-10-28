/**
 * Reads a table a specification writes in HTML, as AdCOM does, into the same
 * markdown table node the extractor reads a pipe table as, so the extractor
 * reads both the same way.
 *
 * The reader knows the tags a table and its cells use, `table`, `tr`, `td`,
 * and `th`, and in a cell `a`, `br`, `code`, `strong`, `b`, `em`, and `i`;
 * any other tag, any markup it can't read, such as a comment, any character
 * reference it doesn't know, and any text outside a cell, fails extraction,
 * as an unknown table layout does. A closing `</tr>` or `</td>` with nothing open
 * is skipped, and a cell with no `<tr>` before it opens a row, as a
 * browser's HTML parser does, so the rows are the ones GitHub shows. Each node keeps its offsets in the
 * specification, so a row's digest and quote are its source bytes.
 */
import type { PhrasingContent, Table, TableCell, TableRow } from "mdast";
import { ExtractError } from "./errors.ts";

type Pos = { line: number; column: number; offset: number };

/** The named character references the tables write, and the numeric ones. */
const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };

/** Decodes the character references of a run of text; an unknown name stays as written. */
export function decodeEntities(s: string, line = 0): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (all, name: string) => {
    if (name[0] === "#") {
      const cp = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!(cp >= 0 && cp <= 0x10ffff)) throw new ExtractError(`the character reference "${all}" names no character`, line);
      return String.fromCodePoint(cp);
    }
    const v = ENTITIES[name.toLowerCase()];
    if (v === undefined) throw new ExtractError(`the character reference "${all}", which the reader doesn't know`, line);
    return v;
  });
}

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z][\w:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
const CELL_TAGS = new Set(["a", "br", "code", "strong", "b", "em", "i"]);

/** Whether a block of HTML opens a table. */
export const opensTable = (html: string): boolean => /^\s*<table[\s>]/i.test(html);

/** Whether a block of HTML closes the table it holds. */
export const closesTable = (html: string): boolean => /<\/table\s*>\s*$/i.test(html);

/**
 * Parses the HTML table that the specification's bytes hold from `start` to
 * `end` into a table node, with the first row as its header. `text` is the
 * whole specification, whose offsets the nodes keep.
 */
export function readHtmlTable(text: string, start: number, end: number): Table {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const pos = (offset: number): Pos => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo]! + 1, offset };
  };
  const at = (offset: number) => pos(offset).line;
  const span = (a: number, b: number) => ({ start: pos(a), end: pos(b) });

  const rows: TableRow[] = [];
  let table: { start: number } | null = null;
  let tableEnd = -1;
  let row: { start: number; cells: TableCell[] } | null = null;
  let cell: { start: number; inner: number } | null = null;
  let last = start;
  const outside = (from: number, to: number) => {
    const between = text.slice(from, to);
    if (between.trim() !== "") throw new ExtractError(`text "${between.trim().slice(0, 40)}" outside a table cell`, at(from + between.search(/\S/)));
  };
  TAG.lastIndex = start;
  for (let m = TAG.exec(text); m !== null && m.index < end; m = TAG.exec(text)) {
    const [whole, close, rawName] = m as unknown as [string, string, string];
    const name = rawName.toLowerCase();
    const s = m.index;
    const e = s + whole.length;
    if (cell !== null) {
      // Inside a cell, only the cell's own close ends it; the cell's tags are read with its content.
      if (name === "td" || name === "th") {
        if (!close) throw new ExtractError(`a <${name}> inside a cell that isn't closed`, at(s));
        row!.cells.push({ type: "tableCell", children: phrasing(text, cell.inner, s, at, span), position: span(cell.start, e) });
        cell = null;
        last = e;
      } else if (name === "tr" || name === "table") throw new ExtractError(`a <${close}${name}> inside a cell that isn't closed`, at(s));
      else if (!CELL_TAGS.has(name)) throw new ExtractError(`unsupported HTML tag <${close}${rawName}> in a table cell`, at(s));
      continue;
    }
    outside(last, s);
    last = e;
    switch (name) {
      case "table":
        if (close) {
          if (table === null) throw new ExtractError("a </table> with no <table>", at(s));
          if (row !== null) throw new ExtractError("a </table> inside a row that isn't closed", at(s));
          tableEnd = e;
        } else {
          if (table !== null) throw new ExtractError("a <table> inside a table", at(s));
          table = { start: s };
        }
        break;
      case "tr":
        if (close) {
          // A browser skips a </tr> that closes nothing, and so does the reader.
          if (row === null) break;
          rows.push({ type: "tableRow", children: row.cells, position: span(row.start, e) });
          row = null;
        } else {
          if (table === null) throw new ExtractError("a <tr> outside a table", at(s));
          if (row !== null) throw new ExtractError("a <tr> inside a row that isn't closed", at(s));
          row = { start: s, cells: [] };
        }
        break;
      case "td":
      case "th":
        if (close) break;
        // A cell with no <tr> before it opens a row, as a browser's parser opens one.
        if (row === null) {
          if (table === null) throw new ExtractError(`a <${name}> outside a table`, at(s));
          row = { start: s, cells: [] };
        }
        cell = { start: s, inner: e };
        break;
      default:
        throw new ExtractError(`unsupported HTML tag <${close}${rawName}> in a table`, at(s));
    }
    if (tableEnd >= 0) break;
  }
  if (table === null || tableEnd < 0) throw new ExtractError("an HTML table with no </table>", at(start));
  outside(tableEnd, end);
  if (rows.length === 0) throw new ExtractError("an HTML table with no rows", at(start));
  return { type: "table", align: rows[0]!.children.map(() => null), children: rows, position: span(table.start, tableEnd) };
}

/** A cell's content, from `from` to `to` in the specification, as phrasing nodes: text, code spans, bold, italics, links, and line breaks. */
function phrasing(text: string, from: number, to: number, at: (o: number) => number, span: (a: number, b: number) => { start: Pos; end: Pos }): PhrasingContent[] {
  const root: { node: { children: PhrasingContent[] } | null; tag: string; start: number; code?: boolean }[] = [{ node: { children: [] }, tag: "", start: from }];
  const top = () => root[root.length - 1]!;
  let last = from;
  const flush = (upTo: number) => {
    if (upTo <= last) return;
    const raw = text.slice(last, upTo);
    // Markup the reader didn't take as a tag, such as a comment, would read as words; it fails instead.
    const stray = /<[A-Za-z!/?]/.exec(raw);
    if (stray) throw new ExtractError(`markup "${raw.slice(stray.index, stray.index + 20)}" in a table cell that the reader doesn't know`, at(last + stray.index));
    const t = top();
    if (t.code) t.node!.children.push({ type: "text", value: raw, position: span(last, upTo) });
    else t.node!.children.push({ type: "text", value: decodeEntities(raw, at(last)), position: span(last, upTo) });
  };
  const inner = new RegExp(TAG.source, "g");
  inner.lastIndex = from;
  for (let m = inner.exec(text); m !== null && m.index < to; m = inner.exec(text)) {
    const [whole, close, rawName] = m as unknown as [string, string, string];
    const name = rawName.toLowerCase();
    const s = m.index;
    const e = s + whole.length;
    flush(s);
    last = e;
    if (top().code && !(close && name === "code")) throw new ExtractError(`a <${close}${rawName}> inside a <code> in a table cell`, at(s));
    if (name === "br") {
      top().node!.children.push({ type: "break", position: span(s, e) });
      continue;
    }
    if (!close) {
      const href = /\shref\s*=\s*"([^"]*)"/i.exec(m[3] ?? "")?.[1] ?? "";
      const node =
        name === "code"
          ? { children: [] }
          : name === "strong" || name === "b"
            ? { type: "strong", children: [], position: span(s, e) }
            : name === "em" || name === "i"
              ? { type: "emphasis", children: [], position: span(s, e) }
              : { type: "link", url: decodeEntities(href), children: [], position: span(s, e) };
      root.push({ node: node as unknown as { children: PhrasingContent[] }, tag: name, start: s, code: name === "code" });
      continue;
    }
    const open = top();
    const same = (a: string, b: string) => a === b || (["strong", "b"].includes(a) && ["strong", "b"].includes(b)) || (["em", "i"].includes(a) && ["em", "i"].includes(b));
    if (root.length === 1 || !same(open.tag, name)) throw new ExtractError(`a </${rawName}> that closes no open <${rawName}> in a table cell`, at(s));
    root.pop();
    const node = open.node as unknown as PhrasingContent & { children?: PhrasingContent[]; value?: string; position: { start: Pos; end: Pos } };
    if (open.code) {
      const kids = (open.node as { children: { value: string }[] }).children ?? [];
      const code = { type: "inlineCode", value: decodeEntities(kids.map((k) => k.value).join(""), at(open.start)), position: span(open.start, e) } as PhrasingContent;
      top().node!.children.push(code);
    } else {
      node.position = span(open.start, e);
      top().node!.children.push(node);
    }
  }
  flush(to);
  // The cell's end closes what it left open, as a browser's parser closes it: bold, italics, and a link. An open code span fails.
  while (root.length > 1) {
    const open = root.pop()!;
    if (open.code) throw new ExtractError(`a <code> in a table cell with no </code>`, at(open.start));
    const node = open.node as unknown as PhrasingContent & { position: { start: Pos; end: Pos } };
    node.position = span(open.start, to);
    top().node!.children.push(node);
  }
  return root[0]!.node!.children;
}
