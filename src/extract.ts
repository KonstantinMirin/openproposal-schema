import GithubSlugger, { slug } from "github-slugger";
import type { Blockquote, Code, Heading, List, Node, RootContent, Table as MdTable, TableCell, TableRow } from "mdast";
import { collapse, lineAt, parseMarkdown, plain, render, tokenize, type Token } from "./markdown.ts";
import { ExtractError } from "./errors.ts";
import { sha256 } from "./canonical.ts";
import { parseTypeExpr, type TypeExpr } from "./grammar/type-expr.ts";
import { IDENTIFIER_PATH, parsePath, type FieldPath } from "./grammar/path.ts";
import { matchBrace, parseInlineObject, type ObjectForm } from "./grammar/inline-object.ts";
import { parsePresence, resolveWith, type Presence } from "./grammar/required.ts";
import { findKeywords, LEVEL_ORDER, splitSentences } from "./sentences.ts";
import { matchLayout, type Layout, type RenderedHeader } from "./layouts.ts";
import type {
  AppendixARow,
  AppendixBRow,
  CodeSpan,
  Column,
  Distribution,
  Field,
  InputRecord,
  IrObjectForm,
  Loc,
  ParentRef,
  Section,
  SpecIR,
  Table,
  Text,
} from "./ir-types.ts";

/** The mutability markers a field row may carry. A row with any other marker fails extraction. */
export const MARKERS = [
  "immutable",
  "seller-set",
  "selectable",
  "settable",
  "supplied",
  "requestable",
  "derived",
  "mixed",
] as const;

const OWNERS: Record<string, Field["owner"]> = { "4": "proposal", "5": "line_item" };

interface Hosted {
  value_lists: string[];
  inline_objects: string[];
  statements: string[];
}

interface PhrasingOptions {
  statements: boolean;
  structures: boolean;
}

/** Extracts the intermediate representation from the specification text. Deterministic: the output depends only on `text` and `input`. */
export function extract(text: string, input: InputRecord): SpecIR {
  return new Extractor(text, input).run();
}

class Extractor {
  private readonly ir: SpecIR;
  private readonly slugger = new GithubSlugger();
  private readonly ids = new Set<string>();
  private readonly counters = new Map<string, number>();
  private section: Section;
  private stack: Section[] = [];
  private label: { label: string; identifier: string | null } | null = null;
  private distribution: Token[][] = [];
  private rowsSeen = 0;

  constructor(
    private readonly text: string,
    input: InputRecord,
  ) {
    this.section = {
      id: "front",
      number: null,
      title: "",
      heading: "",
      depth: 0,
      anchor: "",
      part: "front",
      parent: null,
      line: 1,
    };
    this.ir = {
      ir_version: 1,
      input,
      counts: {},
      sections: [this.section],
      tables: [],
      fields: [],
      keys: [],
      definitions: [],
      markers: [],
      concepts: [],
      value_lists: [],
      inline_objects: [],
      statements: [],
      sentences: [],
      code_spans: [],
      identifier_lists: [],
      code_blocks: [],
      appendix_a: null,
      appendix_b: null,
    };
  }

  run(): SpecIR {
    const tree = parseMarkdown(this.text);
    for (const node of tree.children) this.block(node);
    this.finalize();
    return this.ir;
  }

  // ----- Blocks -----

  private block(node: RootContent): void {
    switch (node.type) {
      case "heading":
        return this.heading(node);
      case "paragraph":
        return this.paragraph(node.children);
      case "list":
        return this.list(node);
      case "blockquote":
        return this.blockquote(node);
      case "table":
        return this.table(node);
      case "code":
        return this.code(node);
      case "thematicBreak":
        return;
      case "html":
        if (/^<!--[\s\S]*-->$/.test(node.value.trim())) return;
        throw new ExtractError("unsupported raw HTML block", line(node));
      default:
        throw new ExtractError(`unsupported block "${node.type}"`, line(node));
    }
  }

  private list(node: List): void {
    for (const item of node.children) {
      for (const child of item.children) {
        if (child.type === "paragraph" || child.type === "list" || child.type === "code") this.block(child);
        else throw new ExtractError(`unsupported list item content "${child.type}"`, line(child));
      }
    }
  }

  private blockquote(node: Blockquote): void {
    for (const child of node.children) this.block(child);
  }

  private heading(node: Heading): void {
    const text = plain(tokenize(node.children));
    const anchor = this.slugger.slug(text);
    const at = line(node);
    if (node.depth === 1) {
      const front = this.ir.sections[0]!;
      Object.assign(front, { title: text, heading: text, depth: 1, anchor, line: at });
      this.section = front;
      this.stack = [front];
      this.label = null;
      return;
    }
    let number: string | null = null;
    let title = text;
    let m: RegExpExecArray | null;
    if ((m = /^(\d+(?:\.\d+)*)\.?\s+(.+)$/.exec(text))) {
      number = m[1]!;
      title = m[2]!;
    } else if ((m = /^Appendix ([A-Z])\b\s*[—–-]?\s*(.*)$/.exec(text))) {
      number = m[1]!;
      title = m[2]!;
    }
    let part = this.section.part;
    if (number !== null && /^[A-Z]$/.test(number)) part = "appendix";
    else if (number !== null && part === "front" && node.depth === 2) part = "body";
    while (this.stack.length > 0 && this.stack[this.stack.length - 1]!.depth >= node.depth) this.stack.pop();
    const parent = this.stack[this.stack.length - 1] ?? null;
    const id = number ?? `${parent?.id ?? "front"}/${anchor}`;
    this.claim(id, at, "section");
    const section: Section = { id, number, title, heading: text, depth: node.depth, anchor, part, parent: parent?.id ?? null, line: at };
    this.ir.sections.push(section);
    this.stack.push(section);
    this.section = section;
    this.label = null;
  }

  private paragraph(children: Parameters<typeof tokenize>[0]): void {
    const tokens = tokenize(children);
    if (tokens.length === 0) return;
    const at = tokens[0]!.line;
    if (tokens[0]!.strong) {
      const lead: Token[] = [];
      for (const t of tokens) {
        if (!t.strong) break;
        lead.push(t);
      }
      const firstCode = tokens.find((t) => t.kind === "code");
      this.label = { label: plain(lead).replace(/[.:]$/, ""), identifier: firstCode?.value ?? null };
    }
    if (this.section.parent === "B" && this.section.title === "What the distribution says") this.distribution.push(tokens);
    const host = `block:${this.section.id}:${this.next(`block:${this.section.id}`)}`;
    this.phrasing(host, "prose", tokens, { section: this.section.id, line: at });
  }

  private code(node: Code): void {
    const id = `code:${this.section.id}:${this.next(`code:${this.section.id}`)}`;
    this.claim(id, line(node), "code block");
    this.ir.code_blocks.push({
      id,
      lang: node.lang ?? null,
      text: node.value,
      digest: sha256(node.value),
      loc: { section: this.section.id, line: line(node) },
    });
  }

  // ----- Tables -----

  private table(node: MdTable): void {
    const [head, ...rows] = node.children;
    const at = line(node);
    if (!head) throw new ExtractError("table without a header row", at);
    const header: RenderedHeader[] = head.children.map((cell) => {
      const toks = tokenize(cell.children);
      return { text: render(toks), code: toks.length === 1 && toks[0]!.kind === "code" ? toks[0]!.value : null };
    });
    const layout = matchLayout(header);
    if (!layout) {
      throw new ExtractError(`unknown table layout "| ${header.map((h) => h.text).join(" | ")} |" in § ${this.section.id}`, at);
    }
    if (!layout.allowed(this.section)) {
      throw new ExtractError(`table layout "${layout.id}" belongs in ${layout.allowedText}, found in § ${this.section.id}`, at);
    }
    const id = `table:${this.section.id}:${this.next(`table:${this.section.id}`)}`;
    this.claim(id, at, "table");
    const table: Table = {
      id,
      layout: layout.id,
      section: this.section.id,
      line: at,
      header: header.map((h) => h.text),
      rows: rows.length,
      parent: this.parentOf(layout, header),
    };
    this.ir.tables.push(table);
    rows.forEach((row, i) => {
      this.rowsSeen++;
      const rowLine = line(row);
      if (row.children.length !== header.length) {
        throw new ExtractError(`row has ${row.children.length} cells; layout "${layout.id}" has ${header.length}`, rowLine);
      }
      const loc: Loc = { section: this.section.id, line: rowLine, table: id, row: i + 1 };
      const digest = sha256(collapse(this.slice(row)));
      switch (layout.kind) {
        case "field":
          return this.fieldRow(row, loc, digest);
        case "key":
          return this.keyRow(row, layout, table, header, loc, digest);
        case "definition":
          return this.definitionRow(row, layout, table, header, loc, digest);
        case "marker":
          return this.markerRow(row, loc, digest);
        case "concept":
          return this.conceptRow(row, header, loc, digest);
        case "appendix_a":
          return this.appendixARow(row, table, loc, digest);
        case "appendix_b":
          return this.appendixBRow(row, table, loc, digest);
      }
    });
    this.label = null;
  }

  /** Finds the object a key or definition table describes. The field or inline object it names is resolved in `finalize`. */
  private parentOf(layout: Layout, header: RenderedHeader[]): ParentRef | null {
    if (layout.kind !== "key" && layout.kind !== "definition") return null;
    const base = { field: null, member_of: null };
    const headerCode = header[0]!.code;
    if (headerCode !== null) return { via: "header", label: headerCode, identifier: headerCode, ...base };
    const s = this.section;
    if (s.number !== null && /^[a-z_][a-z0-9_]*$/.test(s.title)) {
      return { via: "heading", label: s.heading, identifier: s.title, ...base };
    }
    if (this.label) return { via: "label", label: this.label.label, identifier: this.label.identifier, ...base };
    return { via: "section", label: s.heading, identifier: null, ...base };
  }

  private fieldRow(row: TableRow, loc: Loc, digest: string): void {
    const [nameC, typeC, markerC, descC] = row.children as [TableCell, TableCell, TableCell, TableCell];
    const names = this.nameCell(nameC, loc.line);
    const owner = OWNERS[this.section.id.split(/[./]/)[0]!];
    if (!owner) throw new ExtractError(`no owner object for a field in § ${this.section.id}`, loc.line);
    const id = `field:${this.section.id}:${names.map((n) => n.path).join(",")}`;
    this.claim(id, loc.line, "field");
    const typeRaw = plain(tokenize(typeC.children));
    const marker = plain(tokenize(markerC.children));
    if (!(MARKERS as readonly string[]).includes(marker)) {
      throw new ExtractError(`unknown mutability marker "${marker}"`, loc.line);
    }
    const descTokens = tokenize(descC.children);
    const hosted = this.phrasing(`${id}#description`, "table_cell", descTokens, loc);
    this.ir.fields.push({
      id,
      owner,
      names,
      name_cell: this.slice(nameC).trim(),
      type: { raw: typeRaw, parsed: parseTypeExpr(typeRaw, loc.line) },
      marker,
      description: this.cellText(descC),
      presence: this.descriptionPresence(descTokens),
      ...hosted,
      digest,
      loc,
    });
  }

  private keyRow(row: TableRow, layout: Layout, table: Table, header: RenderedHeader[], loc: Loc, digest: string): void {
    const cells = row.children;
    const key = parsePath(this.singleCode(cells[0]!, loc.line, "key"), loc.line);
    const parent = table.parent?.identifier;
    const id = `key:${this.section.id}:${parent ? parent + "." : ""}${key.path}`;
    this.claim(id, loc.line, "key");
    const col = (name: string) => header.findIndex((h) => h.text === name);
    const hosted = emptyHosted();
    let required: { raw: string; parsed: Presence } | null = null;
    const ri = col("Required");
    if (ri >= 0) {
      const toks = tokenize(cells[ri]!.children);
      const raw = render(toks);
      required = { raw, parsed: resolveWith(parsePresence(raw, MARKERS, loc.line), null, raw, loc.line) };
      merge(hosted, this.phrasing(`${id}#required`, "table_cell", toks, loc, { statements: false, structures: false }));
    }
    const mi = col("Meaning");
    const meaning = cells[mi]!;
    merge(hosted, this.phrasing(`${id}#meaning`, "table_cell", tokenize(meaning.children), loc));
    let mapping: (Text & { column: string }) | null = null;
    if (layout.header.length > 3 && cells[3]) mapping = { column: header[3]!.text, ...this.cellText(cells[3]) };
    this.ir.keys.push({ id, layout: layout.id, key, required, meaning: this.cellText(meaning), mapping, ...hosted, digest, loc });
  }

  private definitionRow(row: TableRow, layout: Layout, table: Table, header: RenderedHeader[], loc: Loc, digest: string): void {
    const cells = row.children;
    const value = this.singleCode(cells[0]!, loc.line, "value");
    const subject = table.parent?.identifier ?? null;
    const id = `def:${this.section.id}:${subject ? subject + "." : ""}${value}`;
    this.claim(id, loc.line, "definition");
    const hosted = emptyHosted();
    const columns: Column[] = [];
    cells.slice(1).forEach((cell, i) => {
      const name = header[i + 1]!.text;
      columns.push({ name, ...this.cellText(cell) });
      merge(hosted, this.phrasing(`${id}#${slug(name)}`, "table_cell", tokenize(cell.children), loc));
    });
    this.ir.definitions.push({ id, layout: layout.id, subject, value, columns, ...hosted, digest, loc });
  }

  private markerRow(row: TableRow, loc: Loc, digest: string): void {
    const [markerC, meaningC] = row.children as [TableCell, TableCell];
    const marker = this.singleCode(markerC, loc.line, "marker");
    const id = `marker:${this.section.id}:${marker}`;
    this.claim(id, loc.line, "marker");
    const hosted = this.phrasing(`${id}#meaning`, "table_cell", tokenize(meaningC.children), loc);
    this.ir.markers.push({ id, marker, meaning: this.cellText(meaningC), ...hosted, digest, loc });
  }

  private conceptRow(row: TableRow, header: RenderedHeader[], loc: Loc, digest: string): void {
    const id = `concept:${this.section.id}:${loc.row}`;
    this.claim(id, loc.line, "concept");
    const hosted = emptyHosted();
    const columns: Column[] = row.children.map((cell, i) => {
      const name = header[i]!.text;
      merge(hosted, this.phrasing(`${id}#${slug(name)}`, "table_cell", tokenize(cell.children), loc));
      return { name, ...this.cellText(cell) };
    });
    this.ir.concepts.push({ id, columns, ...hosted, digest, loc });
  }

  private appendixARow(row: TableRow, table: Table, loc: Loc, digest: string): void {
    const [nameC, sectionC, typeC, markerC] = row.children as [TableCell, TableCell, TableCell, TableCell];
    const names = this.nameCell(nameC, loc.line);
    const sectionCell = plain(tokenize(sectionC.children));
    const typeRaw = plain(tokenize(typeC.children));
    let parsed: TypeExpr | null = null;
    try {
      parsed = parseTypeExpr(typeRaw, loc.line);
    } catch {
      parsed = null; // Appendix A is a claim to check; stage 2 reports a type it can't parse.
    }
    const id = `appendix-a:${loc.row}`;
    this.claim(id, loc.line, "Appendix A row");
    const rowRecord: AppendixARow = {
      id,
      names,
      name_cell: this.slice(nameC).trim(),
      section_cell: sectionCell,
      section_number: /^(\d+(?:\.\d+)*)\s/.exec(sectionCell)?.[1] ?? null,
      type: { raw: typeRaw, parsed },
      marker: plain(tokenize(markerC.children)),
      digest,
      loc,
    };
    this.ir.appendix_a ??= { section: this.section.id, table: table.id, rows: [] };
    this.ir.appendix_a.rows.push(rowRecord);
  }

  private appendixBRow(row: TableRow, table: Table, loc: Loc, digest: string): void {
    const [markerC, countC, meaningC, fieldsC] = row.children as [TableCell, TableCell, TableCell, TableCell];
    const marker = plain(tokenize(markerC.children));
    const countCell = plain(tokenize(countC.children));
    const id = `appendix-b:${marker}`;
    this.claim(id, loc.line, "Appendix B row");
    const rowRecord: AppendixBRow = {
      id,
      marker,
      count: /^\d+$/.test(countCell) ? Number(countCell) : null,
      count_cell: countCell,
      meaning: render(tokenize(meaningC.children)),
      fields: this.appendixBFields(tokenize(fieldsC.children), loc.line),
      digest,
      loc,
    };
    this.ir.appendix_b ??= { section: this.section.id, table: table.id, rows: [], distribution: null };
    this.ir.appendix_b.rows.push(rowRecord);
  }

  /** Parses "`a`, `b` · `c`, `d` (proposal)" into field labels. */
  private appendixBFields(tokens: Token[], at: number): AppendixBRow["fields"] {
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

  // ----- Cells -----

  /** Parses a Field cell: one code span, or several joined by `·`. */
  private nameCell(cell: TableCell, at: number): FieldPath[] {
    const tokens = tokenize(cell.children);
    const names: FieldPath[] = [];
    tokens.forEach((t, i) => {
      if (i % 2 === 0) {
        if (t.kind !== "code") throw new ExtractError(`field cell "${render(tokens)}" is not code spans joined by "·"`, at);
        names.push(parsePath(t.value, at));
      } else if (t.kind !== "text" || t.value.trim() !== "·") {
        throw new ExtractError(`field cell "${render(tokens)}" is not code spans joined by "·"`, at);
      }
    });
    if (names.length === 0 || tokens.length % 2 === 0) throw new ExtractError(`empty or malformed field cell "${render(tokens)}"`, at);
    return names;
  }

  private singleCode(cell: TableCell, at: number, what: string): string {
    const tokens = tokenize(cell.children);
    if (tokens.length !== 1 || tokens[0]!.kind !== "code") {
      throw new ExtractError(`${what} cell "${render(tokens)}" is not a single code span`, at);
    }
    return tokens[0]!.value;
  }

  private cellText(cell: TableCell): Text {
    return { markdown: this.slice(cell).trim(), text: render(tokenize(cell.children)) };
  }

  private descriptionPresence(tokens: Token[]): Presence | null {
    const sentences = splitSentences(tokens);
    for (const [i, s] of sentences.entries()) {
      if (/^(REQUIRED|RECOMMENDED|OPTIONAL)\b/.test(s.text)) {
        return resolveWith(parsePresence(s.text, MARKERS, s.line), i > 0 ? sentences[i - 1]!.codes : null, s.text, s.line);
      }
    }
    return null;
  }

  // ----- Inline content -----

  /** Extracts inline objects, value lists, identifier lists, statements, and code spans from one block or cell. */
  private phrasing(host: string, origin: "table_cell" | "prose", tokens: Token[], loc: Loc, opts?: PhrasingOptions): Hosted {
    const o = opts ?? { statements: true, structures: true };
    const out = emptyHosted();
    if (this.section.part === "appendix") return out;
    const consumed = new Set<number>();
    if (o.structures) {
      this.inlineObjects(host, origin, tokens, loc, consumed, out);
      this.valueLists(host, origin, tokens, loc, consumed, out);
      this.identifierLists(host, tokens, loc);
    }
    if (o.statements) this.statements(host, origin, tokens, loc, out);
    tokens.forEach((t, i) => {
      if (t.kind !== "code" || consumed.has(i)) return;
      this.ir.code_spans.push({ value: t.value, ...classifyCode(t.value), host, loc: { ...loc, line: t.line } });
    });
    return out;
  }

  private inlineObjects(host: string, origin: "table_cell" | "prose", tokens: Token[], loc: Loc, consumed: Set<number>, out: Hosted): void {
    const chars: { ti: number; off: number }[] = [];
    tokens.forEach((t, ti) => {
      for (let off = 0; off < t.value.length; off++) chars.push({ ti, off });
    });
    const flat = tokens.map((t) => t.value).join("");
    let n = 0;
    for (let i = flat.indexOf("{"); i !== -1; i = flat.indexOf("{", i)) {
      const start = chars[i]!;
      const at = lineAt(tokens[start.ti]!, start.off);
      const end = matchBrace(flat, i);
      if (end < 0) throw new ExtractError(`unbalanced "{" in "${render(tokens)}"`, at);
      const src = flat.slice(i, end + 1);
      const form = parseInlineObject(src, at);
      const span = new Set(chars.slice(i, end + 1).map((c) => c.ti));
      const kinds = new Set([...span].map((ti) => tokens[ti]!.kind));
      for (const ti of span) if (tokens[ti]!.kind === "code") consumed.add(ti);

      let between = start.off > 0 || tokens[start.ti]!.kind === "text" ? tokens[start.ti]!.value.slice(0, start.off) : "";
      let k = start.ti - 1;
      while (k >= 0 && tokens[k]!.kind === "text") between = tokens[k--]!.value + between;
      const anchor = k >= 0 && tokens[k]!.kind === "code" && /^\s*of\s*$/.test(between) ? tokens[k]!.value : null;

      const id = `${host}/object:${++n}`;
      this.claim(id, at, "inline object");
      const objLoc = { ...loc, line: at };
      this.ir.inline_objects.push({
        id,
        host,
        origin,
        source: kinds.size === 1 ? (kinds.has("code") ? "code" : "text") : "mixed",
        text: collapse(src),
        anchor,
        form: this.objectForm(form, id, [], objLoc),
        context_before: clauseBefore(flat.slice(0, i)),
        context_after: clauseAfter(flat.slice(end + 1)),
        loc: objLoc,
      });
      out.inline_objects.push(id);
      i = end + 1;
    }
  }

  private objectForm(form: ObjectForm, objectId: string, path: string[], loc: Loc): IrObjectForm {
    return {
      combinator: form.combinator,
      members: form.members.map((m) => {
        const memberPath = [...path, m.key + (m.array ? "[]" : "")];
        if (m.value === null) return { key: m.key, array: m.array, value: null };
        if (m.value.kind === "object") {
          return { key: m.key, array: m.array, value: { kind: "object", object: this.objectForm(m.value.object, objectId, memberPath, loc) } };
        }
        let valueList: string | null = null;
        if (m.value.items.length >= 2) {
          valueList = `${objectId}/${memberPath.join(".")}`;
          this.claim(valueList, loc.line, "value list");
          this.ir.value_lists.push({
            id: valueList,
            host: objectId,
            origin: "inline_object",
            subject: { identifier: memberPath.join("."), relation: "member" },
            items: m.value.items.map((value) => ({ value, annotation: null })),
            context_after: null,
            loc,
          });
        }
        return { key: m.key, array: m.array, value: { kind: "values", items: m.value.items, value_list: valueList } };
      }),
    };
  }

  /** Finds runs of code spans separated by `|`, as in "`a` \| `b` (default) \| `c`". */
  private valueLists(host: string, origin: "table_cell" | "prose", tokens: Token[], loc: Loc, consumed: Set<number>, out: Hosted): void {
    let n = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.kind !== "code" || consumed.has(i)) continue;
      const items = [{ value: t.value, annotation: null as string | null }];
      let j = i;
      for (;;) {
        const sep = tokens[j + 1];
        const next = tokens[j + 2];
        if (!sep || sep.kind !== "text" || !next || next.kind !== "code" || consumed.has(j + 2)) break;
        const m = /^\s*(?:\(([^()]*)\))?\s*\|\s*$/.exec(sep.value);
        if (!m) break;
        if (m[1] !== undefined) items[items.length - 1]!.annotation = collapse(m[1]);
        items.push({ value: next.value, annotation: null });
        j += 2;
      }
      if (items.length < 2) continue;
      let contextAfter: string | null = null;
      const after = tokens[j + 1];
      if (after?.kind === "text") {
        let rest = after.value;
        const m = /^\s*\(([^()]*)\)/.exec(rest);
        if (m) {
          items[items.length - 1]!.annotation = collapse(m[1]!);
          rest = rest.slice(m[0].length);
        }
        contextAfter = clauseAfter(rest);
      }
      const before = tokens[i - 1];
      const subjectToken = tokens[i - 2];
      const subject =
        before?.kind === "text" && /^\s*from\s*$/.test(before.value) && subjectToken?.kind === "code"
          ? { identifier: subjectToken.value, relation: "from" as const }
          : null;
      for (let k = i; k <= j; k += 2) consumed.add(k);
      const id = `${host}/values:${++n}`;
      this.claim(id, t.line, "value list");
      this.ir.value_lists.push({ id, host, origin, subject, items, context_after: contextAfter, loc: { ...loc, line: t.line } });
      out.value_lists.push(id);
      i = j;
    }
  }

  /** Finds runs of three or more items joined by `·`, such as the Summary Representation key list. */
  private identifierLists(host: string, tokens: Token[], loc: Loc): void {
    let n = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.kind !== "code") continue;
      const items = [{ text: t.value, code: true }];
      let j = i;
      for (;;) {
        const sep = tokens[j + 1];
        const next = tokens[j + 2];
        if (!sep || sep.kind !== "text" || !next || next.kind !== "code") break;
        const embedded = /^\s*·\s*([^·`]+?)\s*·\s*$/.exec(sep.value);
        if (embedded) items.push({ text: collapse(embedded[1]!), code: false });
        else if (!/^\s*·\s*$/.test(sep.value)) break;
        items.push({ text: next.value, code: true });
        j += 2;
      }
      if (items.length < 3) continue;
      const id = `${host}/identifiers:${++n}`;
      this.claim(id, t.line, "identifier list");
      this.ir.identifier_lists.push({ id, host, items, loc: { ...loc, line: t.line } });
      i = j;
    }
  }

  /**
   * Records each RFC 2119 sentence as a statement. In prose, a sentence with
   * no keyword that names an identifier or a term (has a code span) is
   * recorded as a sentence, so a decision that rests on it can digest it.
   */
  private statements(host: string, origin: "table_cell" | "prose", tokens: Token[], loc: Loc, out: Hosted): void {
    const uniqueId = (base: string) => {
      let id = base;
      for (let k = 2; this.ids.has(id); k++) id = `${base}-${k}`;
      return id;
    };
    for (const s of splitSentences(tokens)) {
      const keywords = findKeywords(s.prose);
      const identifiers: string[] = [];
      for (const c of s.codes) {
        const cls = classifyCode(c);
        const name = cls.kind === "path" ? c : cls.kind === "expression" ? cls.lhs : null;
        if (name !== null && !identifiers.includes(name)) identifiers.push(name);
      }
      if (keywords.length === 0) {
        if (origin !== "prose" || s.codes.length === 0) continue;
        const id = uniqueId(`sentence:${this.section.id}:${sha256(s.text).slice(0, 8)}`);
        this.claim(id, s.line, "sentence");
        this.ir.sentences.push({ id, host, part: this.section.part === "front" ? "front" : "body", text: s.text, identifiers, loc: { ...loc, line: s.line } });
        continue;
      }
      // The conventions paragraph names the keywords; it states no requirement.
      if (/RFC 2119/.test(s.prose) && keywords.length >= 5) continue;
      const id = uniqueId(`rule:${this.section.id}:${sha256(s.text).slice(0, 8)}`);
      this.claim(id, s.line, "statement");
      this.ir.statements.push({
        id,
        host,
        part: this.section.part === "front" ? "front" : "body",
        keywords,
        level: LEVEL_ORDER.find((k) => keywords.includes(k))!,
        text: s.text,
        identifiers,
        loc: { ...loc, line: s.line },
      });
      out.statements.push(id);
    }
  }

  // ----- Finalize -----

  private finalize(): void {
    const typed =
      this.ir.fields.length +
      this.ir.keys.length +
      this.ir.definitions.length +
      this.ir.markers.length +
      this.ir.concepts.length +
      (this.ir.appendix_a?.rows.length ?? 0) +
      (this.ir.appendix_b?.rows.length ?? 0);
    if (typed !== this.rowsSeen) throw new ExtractError(`parsed ${typed} of ${this.rowsSeen} table rows`);

    for (const table of this.ir.tables) if (table.parent?.identifier) this.resolveParent(table);
    if (this.ir.appendix_b) this.ir.appendix_b.distribution = this.parseDistribution();
    this.ir.counts = this.counts();
  }

  private resolveParent(table: Table): void {
    const parent = table.parent!;
    const ident = parent.identifier!.replaceAll("[]", "");
    const top = table.section.split(/[./]/)[0];
    const sameTop = (section: string) => section.split(/[./]/)[0] === top;
    const fields = this.ir.fields.filter((f) => f.names.some((n) => n.segments[n.segments.length - 1]!.name === ident));
    const field =
      fields.find((f) => table.section.startsWith(f.loc.section + ".")) ?? fields.find((f) => sameTop(f.loc.section)) ?? fields[0];
    if (field) {
      parent.field = field.id;
      return;
    }
    const hasMember = (form: IrObjectForm): boolean =>
      form.members.some((m) => m.key === ident || (m.value?.kind === "object" && hasMember(m.value.object)));
    const objects = this.ir.inline_objects.filter((o) => hasMember(o.form));
    const object = objects.find((o) => sameTop(o.loc.section)) ?? objects[0];
    if (object) parent.member_of = object.id;
  }

  private parseDistribution(): Distribution | null {
    if (this.distribution.length === 0) return null;
    const text = collapse(this.distribution.map((t) => plain(t)).join(" "));
    const a =
      /Of (\d+) fields, (\d+) are touched by the buyer — (\d+) selectable, (\d+) settable, (\d+) supplied and (\d+) requestable\. The remaining (\d+) are/.exec(
        text,
      );
    const b = /Only the (\d+) requestable fields require a round trip\. Everything else the buyer touches — (\d+) fields —/.exec(text);
    if (!a || !b) return null;
    const n = (s: string | undefined) => Number(s);
    const section = this.ir.sections.find((s) => s.parent === "B" && s.title === "What the distribution says")!;
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
      loc: { section: section.id, line: this.distribution[0]![0]!.line },
    };
  }

  private counts(): SpecIR["counts"] {
    const tally = <T>(items: readonly T[], key: (t: T) => string | string[]) => {
      const out: Record<string, number> = {};
      for (const item of items) for (const k of [key(item)].flat()) out[k] = (out[k] ?? 0) + 1;
      return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
    };
    const body = this.ir.statements.filter((s) => s.part === "body");
    return {
      sections: this.ir.sections.length,
      tables: this.ir.tables.length,
      tables_by_layout: tally(this.ir.tables, (t) => t.layout),
      table_rows: this.rowsSeen,
      table_rows_by_layout: Object.fromEntries(
        Object.entries(tally(this.ir.tables, (t) => t.layout)).map(([layout]) => [
          layout,
          this.ir.tables.filter((t) => t.layout === layout).reduce((sum, t) => sum + t.rows, 0),
        ]),
      ),
      fields: this.ir.fields.length,
      field_names: this.ir.fields.reduce((sum, f) => sum + f.names.length, 0),
      fields_by_marker: tally(this.ir.fields, (f) => f.marker),
      fields_by_owner: tally(this.ir.fields, (f) => f.owner),
      keys: this.ir.keys.length,
      keys_by_layout: tally(this.ir.keys, (k) => k.layout),
      definitions: this.ir.definitions.length,
      markers: this.ir.markers.length,
      concepts: this.ir.concepts.length,
      value_lists: this.ir.value_lists.length,
      value_lists_by_origin: tally(this.ir.value_lists, (v) => v.origin),
      inline_objects: this.ir.inline_objects.length,
      inline_objects_by_origin: tally(this.ir.inline_objects, (o) => o.origin),
      statements: this.ir.statements.length,
      statements_body: body.length,
      statements_by_level: tally(body, (s) => s.level),
      statements_with_keyword: tally(body, (s) => s.keywords),
      sentences: this.ir.sentences.length,
      code_spans: this.ir.code_spans.length,
      identifier_lists: this.ir.identifier_lists.length,
      code_blocks: this.ir.code_blocks.length,
      appendix_a_rows: this.ir.appendix_a?.rows.length ?? 0,
      appendix_b_rows: this.ir.appendix_b?.rows.length ?? 0,
    };
  }

  // ----- Helpers -----

  private slice(node: Node): string {
    const s = node.position?.start.offset;
    const e = node.position?.end.offset;
    if (s === undefined || e === undefined) throw new ExtractError("node without a source position");
    return this.text.slice(s, e);
  }

  private next(counter: string): number {
    const n = (this.counters.get(counter) ?? 0) + 1;
    this.counters.set(counter, n);
    return n;
  }

  private claim(id: string, at: number, what: string): void {
    if (this.ids.has(id)) throw new ExtractError(`duplicate ${what} id "${id}"`, at);
    this.ids.add(id);
  }
}

function line(node: Node): number {
  return node.position?.start.line ?? 0;
}

function emptyHosted(): Hosted {
  return { value_lists: [], inline_objects: [], statements: [] };
}

function merge(into: Hosted, from: Hosted): void {
  into.value_lists.push(...from.value_lists);
  into.inline_objects.push(...from.inline_objects);
  into.statements.push(...from.statements);
}

/** A format of a time of day written with a colon, as `HH:MM`, `hh:mm`, or `09:30`: its pieces name no member. */
const TIME_FORMAT = /^(?:[0-9]{2}|[Hh]{2}):(?:[0-9]{2}|[Mm]{2})(?::(?:[0-9]{2}|[Ss]{2}))?$/;

/**
 * Classifies a code span as an identifier path, an `lhs = rhs` / `lhs: rhs`
 * expression, a literal, or something else. A time-of-day format such as
 * `HH:MM` is no expression, so it names no identifier; any other `a:b` is
 * read as `a: b`, so a misspelled member in it is still checked.
 */
export function classifyCode(value: string): Pick<CodeSpan, "kind" | "lhs" | "rhs"> {
  if (/^-?\d+(\.\d+)?$/.test(value) || ["true", "false", "null"].includes(value)) return { kind: "literal", lhs: null, rhs: null };
  if (IDENTIFIER_PATH.test(value)) return { kind: "path", lhs: null, rhs: null };
  if (TIME_FORMAT.test(value)) return { kind: "other", lhs: null, rhs: null };
  const m = /^(\S+?)\s*(?:=|:)\s*([A-Za-z0-9_][\w.-]*)$/.exec(value);
  if (m && IDENTIFIER_PATH.test(m[1]!)) return { kind: "expression", lhs: m[1]!, rhs: m[2]! };
  return { kind: "other", lhs: null, rhs: null };
}

/** The clause before a position: text after the last sentence or `;` break, or null. */
function clauseBefore(text: string): string | null {
  const parts = text.split(/(?:[.;])\s+/);
  const out = collapse(parts[parts.length - 1] ?? "");
  return out === "" ? null : out;
}

/** The clause after a position: text up to the next `.`, `;` or `,` break, or null. */
function clauseAfter(text: string): string | null {
  const out = collapse(text.split(/[.;,](?:\s|$)/)[0] ?? "");
  return out === "" ? null : out;
}
