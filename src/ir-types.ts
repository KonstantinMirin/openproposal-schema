import type { TypeExpr } from "./grammar/type-expr.ts";
import type { FieldPath } from "./grammar/path.ts";
import type { Presence } from "./grammar/required.ts";
import type { Rfc2119Keyword } from "./sentences.ts";

/** Where an element sits in the specification. */
export interface Loc {
  /** Section id: a number such as `5.6.1`, `A`, `front`, or `<parent>/<anchor>` for an unnumbered heading. */
  section: string;
  line: number;
  /** Table id, for an element in a table. */
  table?: string;
  /** 1-based data row, for an element in a table. */
  row?: number;
}

export interface Section {
  id: string;
  /** The heading's own number, or null for an unnumbered heading. */
  number: string | null;
  title: string;
  heading: string;
  depth: number;
  anchor: string;
  part: "front" | "body" | "appendix";
  parent: string | null;
  line: number;
}

export interface Text {
  /** The source markdown, byte for byte. */
  markdown: string;
  /** Normalized text, with code spans in backticks. */
  text: string;
}

export interface Table {
  id: string;
  layout: string;
  section: string;
  line: number;
  header: string[];
  rows: number;
  /** The object a key or definition table describes. */
  parent: ParentRef | null;
}

export interface ParentRef {
  /** How the parent was found: the section heading, a bold paragraph label, the header, or only the section. */
  via: "heading" | "label" | "header" | "section";
  label: string;
  identifier: string | null;
  /** The field row the identifier names, if one does. */
  field: string | null;
  /** The inline object whose member the identifier names, if no field row does. */
  member_of: string | null;
}

interface Hosted {
  value_lists: string[];
  inline_objects: string[];
  statements: string[];
}

export interface Field extends Hosted {
  id: string;
  owner: "proposal" | "line_item";
  names: FieldPath[];
  name_cell: string;
  type: { raw: string; parsed: TypeExpr };
  marker: string;
  description: Text;
  /** From a description sentence that starts with REQUIRED, RECOMMENDED or OPTIONAL. */
  presence: Presence | null;
  digest: string;
  loc: Loc;
}

export interface Key extends Hosted {
  id: string;
  layout: string;
  key: FieldPath;
  required: { raw: string; parsed: Presence } | null;
  meaning: Text;
  /** The external-standard mapping column, where the table has one. */
  mapping: (Text & { column: string }) | null;
  digest: string;
  loc: Loc;
}

export interface Column extends Text {
  name: string;
}

export interface Definition extends Hosted {
  id: string;
  layout: string;
  subject: string | null;
  value: string;
  columns: Column[];
  digest: string;
  loc: Loc;
}

export interface MarkerDef extends Hosted {
  id: string;
  marker: string;
  meaning: Text;
  digest: string;
  loc: Loc;
}

export interface Concept extends Hosted {
  id: string;
  columns: Column[];
  digest: string;
  loc: Loc;
}

export interface ValueItem {
  value: string;
  annotation: string | null;
}

export interface ValueList {
  id: string;
  host: string;
  origin: "table_cell" | "prose" | "inline_object";
  subject: { identifier: string; relation: "from" | "member" } | null;
  items: ValueItem[];
  context_after: string | null;
  loc: Loc;
}

export interface IrObjectForm {
  combinator: "all" | "one_of";
  members: IrMember[];
}

export interface IrMember {
  key: string;
  array: boolean;
  value:
    | null
    | { kind: "object"; object: IrObjectForm }
    | { kind: "values"; items: string[]; value_list: string | null };
}

export interface InlineObject {
  id: string;
  host: string;
  origin: "table_cell" | "prose";
  /** Whether the braces were written as plain text or inside a code span. */
  source: "text" | "code" | "mixed";
  text: string;
  /** The code span the object is introduced by, as in "`available[]` of { … }". */
  anchor: string | null;
  form: IrObjectForm;
  context_before: string | null;
  context_after: string | null;
  loc: Loc;
}

export interface Statement {
  id: string;
  host: string;
  part: "front" | "body";
  keywords: Rfc2119Keyword[];
  level: Rfc2119Keyword;
  text: string;
  identifiers: string[];
  loc: Loc;
}

/** A prose sentence with no RFC 2119 keyword that names an identifier or a term. */
export interface Sentence {
  id: string;
  host: string;
  part: "front" | "body";
  text: string;
  identifiers: string[];
  loc: Loc;
}

export interface CodeSpan {
  value: string;
  kind: "path" | "expression" | "literal" | "other";
  /** For an expression such as `basis = spend` or `visibility: named`. */
  lhs: string | null;
  rhs: string | null;
  host: string;
  loc: Loc;
}

export interface IdentifierList {
  id: string;
  host: string;
  items: { text: string; code: boolean }[];
  loc: Loc;
}

export interface CodeBlock {
  id: string;
  lang: string | null;
  text: string;
  digest: string;
  loc: Loc;
}

export interface AppendixARow {
  id: string;
  names: FieldPath[];
  name_cell: string;
  section_cell: string;
  section_number: string | null;
  type: { raw: string; parsed: TypeExpr | null };
  marker: string;
  digest: string;
  loc: Loc;
}

export interface AppendixBRow {
  id: string;
  marker: string;
  count: number | null;
  count_cell: string;
  meaning: string;
  fields: { label: string; names: string[]; owner: string | null }[];
  digest: string;
  loc: Loc;
}

export interface Distribution {
  total: number;
  buyer: number;
  selectable: number;
  settable: number;
  supplied: number;
  requestable: number;
  remaining: number;
  round_trip: number;
  up_front: number;
  loc: Loc;
}

export interface InputRecord {
  name: string;
  upstream: string;
  commit: string;
  path: string;
  blob: string;
  base: string | null;
  merge_order: unknown[] | null;
  sha256: string;
  bytes: number;
}

export interface SpecIR {
  ir_version: 1;
  input: InputRecord;
  counts: Record<string, number | Record<string, number>>;
  sections: Section[];
  tables: Table[];
  fields: Field[];
  keys: Key[];
  definitions: Definition[];
  markers: MarkerDef[];
  concepts: Concept[];
  value_lists: ValueList[];
  inline_objects: InlineObject[];
  statements: Statement[];
  sentences: Sentence[];
  code_spans: CodeSpan[];
  identifier_lists: IdentifierList[];
  code_blocks: CodeBlock[];
  appendix_a: { section: string; table: string; rows: AppendixARow[] } | null;
  appendix_b: { section: string; table: string; rows: AppendixBRow[]; distribution: Distribution | null } | null;
}
