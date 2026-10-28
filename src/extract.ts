import GithubSlugger, { slug } from "github-slugger";
import type { Blockquote, Code, Heading, List, Node, RootContent, Table as MdTable, TableCell, TableRow } from "mdast";
import { collapse, lineAt, parseMarkdown, plain, render, tokenize, type Token } from "./markdown.ts";
import { ExtractError } from "./errors.ts";
import { sha256 } from "./canonical.ts";
import { IDENTIFIER_PATH, parsePath, type FieldPath } from "./grammar/path.ts";
import { matchBrace, parseInlineObject, type ObjectForm } from "./grammar/inline-object.ts";
import { parsePresence, resolveWith, type Presence } from "./grammar/required.ts";
import { LEVEL_ORDER, splitSentences } from "./sentences.ts";
import { matchLayout, type Layout, type RenderedHeader } from "./layouts.ts";
import { GENERIC_ROWS, type ExtractContext, type Hosted, type TextFrontEnd } from "./specs/plugin.ts";
import { closesTable, opensTable, readHtmlTable } from "./html-table.ts";
import type {
  CodeSpan,
  Column,
  InputRecord,
  IrObjectForm,
  Loc,
  ParentRef,
  Section,
  SpecIR,
  Table,
  Text,
} from "./ir-types.ts";

interface PhrasingOptions {
  statements: boolean;
  structures: boolean;
}

/**
 * Extracts the intermediate representation from a specification's text,
 * with the readers its plugin gives (`front`). Deterministic: the output
 * depends only on `text`, `input`, and the readers.
 */
export function extract(text: string, input: InputRecord, front: TextFrontEnd): SpecIR {
  return new Extractor(text, input, front).run();
}

class Extractor {
  private readonly ir: SpecIR;
  private readonly slugger = new GithubSlugger();
  private readonly ids = new Set<string>();
  private readonly counters = new Map<string, number>();
  private section: Section;
  private stack: Section[] = [];
  private label: { label: string; identifier: string | null } | null = null;
  private rowsSeen = 0;
  /** What the plugin's readers see of the extraction. */
  private readonly ctx: ExtractContext;

  constructor(
    private readonly text: string,
    input: InputRecord,
    private readonly front: TextFrontEnd,
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
    const self = this;
    this.ctx = {
      ir: this.ir,
      get section() {
        return self.section;
      },
      claim: (id, at, what) => this.claim(id, at, what),
      slice: (node) => this.slice(node),
      cellText: (cell) => this.cellText(cell),
      nameCell: (cell, at) => this.nameCell(cell, at),
      phrasing: (host, origin, tokens, loc, opts) => this.phrasing(host, origin, tokens, loc, opts),
    };
  }

  run(): SpecIR {
    const tree = parseMarkdown(this.text);
    const nodes = tree.children;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      // An HTML table is one table, though a blank line inside it splits it into several HTML blocks.
      if (node.type === "html" && opensTable(node.value)) {
        let j = i;
        while (!closesTable((nodes[j] as { value?: string }).value ?? "")) {
          const next = nodes[j + 1];
          if (!next || next.type !== "html") throw new ExtractError("an HTML table with no </table>", line(node));
          j++;
        }
        this.table(readHtmlTable(this.text, node.position!.start.offset!, nodes[j]!.position!.end.offset!));
        i = j;
        continue;
      }
      this.block(node);
    }
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
    // The anchor a heading writes for itself, as `<a name="list_devicetypes"></a>`, which links name.
    const names = node.children.flatMap((c) => (c.type === "html" ? [...c.value.matchAll(/<a\s[^>]*\bname\s*=\s*"([^"]+)"/gi)].map((m) => m[1]!) : []));
    if (names.length > 1) throw new ExtractError(`a heading with ${names.length} anchors: ${names.join(", ")}`, at);
    const head = this.front.sectionOf({ text, depth: node.depth, anchor, name: names[0] ?? null }, this.section);
    if (head.kind === "title") {
      const front = this.ir.sections[0]!;
      Object.assign(front, { title: text, heading: text, depth: node.depth, anchor, line: at });
      this.section = front;
      this.stack = [front];
      this.label = null;
      return;
    }
    const { number, title, part } = head;
    // The plugin states how its sections are identified, and every heading it reads agrees: a numbered text's section takes its number, or its slug under its parent; an anchored text's takes no number.
    if (this.front.sections === "anchored" && number !== null) throw new ExtractError(`the plugin says the text's sections are anchored, and it reads the number ${number} from the heading "${text}"`, at);
    if (this.front.sections === "numbered" && head.id !== undefined) throw new ExtractError(`the plugin says the text's sections are numbered, and it gives the heading "${text}" the ID "${head.id}" of its own`, at);
    while (this.stack.length > 0 && this.stack[this.stack.length - 1]!.depth >= node.depth) this.stack.pop();
    const parent = this.stack[this.stack.length - 1] ?? null;
    const id = head.id ?? number ?? `${parent?.id ?? "front"}/${anchor}`;
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
    this.front.onParagraph?.(tokens, this.ctx);
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
    const layout = matchLayout(this.front.layouts, header);
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
      const kind = this.front.rowKind(layout);
      switch (kind) {
        case "key":
          return this.keyRow(row, layout, table, header, loc, digest);
        case "definition":
          return this.definitionRow(row, layout, table, header, loc, digest);
        case "marker":
          return this.markerRow(row, loc, digest);
        case "concept":
          return this.conceptRow(row, header, loc, digest);
        default:
          if (GENERIC_ROWS.includes(kind) || !this.front.readRow) throw new ExtractError(`no reader for the row kind "${kind}" of layout "${layout.id}"`, rowLine);
          return this.front.readRow(kind, { row, cells: row.children, layout, table, header, loc, digest }, this.ctx);
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
    const object = layout.kind === "key" ? (this.front.objectOf?.(s) ?? null) : null;
    if (object !== null) return { via: "object", label: s.heading, identifier: object, ...base };
    if (s.number !== null && /^[a-z_][a-z0-9_]*$/.test(s.title)) {
      return { via: "heading", label: s.heading, identifier: s.title, ...base };
    }
    if (this.label) return { via: "label", label: this.label.label, identifier: this.label.identifier, ...base };
    return { via: "section", label: s.heading, identifier: null, ...base };
  }

  private keyRow(row: TableRow, layout: Layout, table: Table, header: RenderedHeader[], loc: Loc, digest: string): void {
    const cells = row.children;
    // A key cell is one code span, or, for a layout that also takes text, as AdCOM's attribute tables write a few, one identifier written plainly.
    const plainKey = layout.key === "code-or-text" ? render(tokenize(cells[0]!.children)) : "";
    const key = parsePath(layout.key === "code-or-text" && IDENTIFIER_PATH.test(plainKey) ? plainKey : this.singleCode(cells[0]!, loc.line, "key"), loc.line);
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
      required = { raw, parsed: resolveWith(parsePresence(raw, this.front.markers ?? [], loc.line), null, raw, loc.line) };
      merge(hosted, this.phrasing(`${id}#required`, "table_cell", toks, loc, { statements: false, structures: false }));
    }
    const mi = col(layout.meaning ?? "Meaning");
    if (mi < 0) throw new ExtractError(`layout "${layout.id}" has no "${layout.meaning ?? "Meaning"}" column`, loc.line);
    const meaning = cells[mi]!;
    merge(hosted, this.phrasing(`${id}#meaning`, "table_cell", tokenize(meaning.children), loc));
    // A layout that names a type column, as AdCOM's `Attribute | Type | Definition`, keeps the row's type cell as written.
    const ti = layout.type !== undefined ? col(layout.type) : -1;
    if (layout.type !== undefined && ti < 0) throw new ExtractError(`layout "${layout.id}" has no "${layout.type}" column`, loc.line);
    const type = ti >= 0 ? { type: this.cellText(cells[ti]!) } : {};
    let mapping: (Text & { column: string }) | null = null;
    if (layout.type === undefined && layout.header.length > 3 && cells[3]) mapping = { column: header[3]!.text, ...this.cellText(cells[3]) };
    this.ir.keys.push({ id, layout: layout.id, key, required, meaning: this.cellText(meaning), ...type, mapping, ...hosted, digest, loc });
  }

  private definitionRow(row: TableRow, layout: Layout, table: Table, header: RenderedHeader[], loc: Loc, digest: string): void {
    const cells = row.children;
    // A value cell is one code span, or, for a layout whose values are written as text, as AdCOM's list codes, its text.
    const value = layout.value === "text" ? render(tokenize(cells[0]!.children)) : this.singleCode(cells[0]!, loc.line, "value");
    if (value === "") throw new ExtractError("an empty value cell", loc.line);
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

  // ----- Inline content -----

  /** Extracts inline objects, value lists, identifier lists, statements, and code spans from one block or cell. */
  private phrasing(host: string, origin: "table_cell" | "prose", tokens: Token[], loc: Loc, opts?: PhrasingOptions): Hosted {
    const o = opts ?? { statements: true, structures: true };
    const out = emptyHosted();
    if (this.section.part === "appendix") return out;
    const consumed = new Set<number>();
    if (o.structures) {
      if (this.front.inlineObjects !== false) this.inlineObjects(host, origin, tokens, loc, consumed, out);
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

  /** Reads each value list the plugin finds in the tokens (`TextFrontEnd.readValueList`). */
  private valueLists(host: string, origin: "table_cell" | "prose", tokens: Token[], loc: Loc, consumed: Set<number>, out: Hosted): void {
    let n = 0;
    for (let i = 0; i < tokens.length; i++) {
      const r = this.front.readValueList?.(tokens, i, consumed) ?? null;
      if (r === null) continue;
      for (const k of r.taken) consumed.add(k);
      const t = tokens[i]!;
      const id = `${host}/values:${++n}`;
      this.claim(id, t.line, "value list");
      this.ir.value_lists.push({ id, host, origin, subject: r.subject, items: r.items, context_after: r.context_after, loc: { ...loc, line: t.line } });
      out.value_lists.push(id);
      i = r.end;
    }
  }

  /** Reads each identifier list the plugin finds in the tokens (`TextFrontEnd.readIdentifierList`). */
  private identifierLists(host: string, tokens: Token[], loc: Loc): void {
    let n = 0;
    for (let i = 0; i < tokens.length; i++) {
      const r = this.front.readIdentifierList?.(tokens, i) ?? null;
      if (r === null) continue;
      const id = `${host}/identifiers:${++n}`;
      this.claim(id, tokens[i]!.line, "identifier list");
      this.ir.identifier_lists.push({ id, host, items: r.items, loc: { ...loc, line: tokens[i]!.line } });
      i = r.end;
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
      const keywords = this.front.keywords(s.prose);
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
      // A conventions paragraph names the keywords; it states no requirement.
      if (this.front.statesConventions?.(s.prose, keywords)) continue;
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
    this.front.finalize?.(this.ctx);
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
export function clauseAfter(text: string): string | null {
  const out = collapse(text.split(/[.;,](?:\s|$)/)[0] ?? "");
  return out === "" ? null : out;
}
