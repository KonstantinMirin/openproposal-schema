/**
 * The interface between the spec-neutral pipeline and one specification.
 *
 * A specification's profile, `specs/<spec>/spec.yaml` (src/profile.ts), says
 * how the pipeline reads it. A specification read from its text names a
 * plugin under `src/specs/<plugin>/`, which gives the readers that only that
 * text needs: its table layouts and row readers, its type and presence
 * grammar, its value-list forms, and its section numbering
 * (`TextFrontEnd`). The extractor (src/extract.ts) reads everything else the
 * same way for every specification. A plugin may also give the checks of
 * its own rules, the fidelity oracle's readers of its text, and the notation
 * the round trip renders its tables in; a specification without them has
 * none of those, and needs no stub.
 *
 * A specification whose input is a published schema set, with no text to
 * extract, has no plugin: its profile's `front_end` is `schemas`, and a
 * schema-only front end reads it.
 */
import type { TableCell, TableRow } from "mdast";
import type { FieldPath } from "../grammar/path.ts";
import type { TypeExpr } from "../grammar/type-expr.ts";
import type { Loc, Section, SpecIR, Table, Text } from "../ir-types.ts";
import type { Layout, RenderedHeader } from "../layouts.ts";
import type { Token } from "../markdown.ts";
import type { RoundTripNotation } from "../render.ts";
import type { Check } from "../rule-checks.ts";
import type { Rfc2119Keyword } from "../sentences.ts";
import type { ConstraintReader } from "../fidelity.ts";
import type { Finding } from "../lint.ts";

/** The IR collection a table row goes to. The extractor reads `key`, `definition`, `marker`, and `concept` rows; the plugin's `readRow` reads every other kind. */
export type RowKind = Layout["kind"];

/** How a text identifies its sections: by their numbers, or by the anchors their headings write. */
export type SectionIds = "numbered" | "anchored";

/** The row kinds the extractor reads the same way for every specification. */
export const GENERIC_ROWS: readonly RowKind[] = ["key", "definition", "marker", "concept"];

/** What a heading opens: the document's title, or a section with its number, its title, and the part of the document it is in. */
export type SectionHead = { kind: "title" } | { kind: "section"; number: string | null; title: string; part: Section["part"]; id?: string };

/** The value list a run of tokens writes, from the token at `start` to the token at `end`. */
export interface ValueListRead {
  items: { value: string; annotation: string | null }[];
  /** The index of the last token of the list. */
  end: number;
  /** The token indexes the list's values sit at, which no other reading may take. */
  taken: number[];
  subject: { identifier: string; relation: "from" } | null;
  context_after: string | null;
}

/** The identifier list a run of tokens writes, such as the Summary Representation's keys joined by `·`. */
export interface IdentifierListRead {
  items: { text: string; code: boolean }[];
  end: number;
}

/** What the extractor hosts in one cell or block: the IDs of the value lists, inline objects, and statements it holds. */
export interface Hosted {
  value_lists: string[];
  inline_objects: string[];
  statements: string[];
}

/** One table row a plugin reads, with the table it is in. */
export interface RowInput {
  row: TableRow;
  cells: TableCell[];
  layout: Layout;
  table: Table;
  header: RenderedHeader[];
  loc: Loc;
  digest: string;
}

/** What the extractor gives a plugin's readers: the IR it builds, and the readers it shares. */
export interface ExtractContext {
  readonly ir: SpecIR;
  /** The section the reader is in. */
  readonly section: Section;
  /** Claims an element ID; a second claim of the same ID fails extraction. */
  claim(id: string, at: number, what: string): void;
  /** The source markdown of a node, byte for byte. */
  slice(node: TableCell): string;
  cellText(cell: TableCell): Text;
  /** A name cell: one code span, or several joined by `·`. */
  nameCell(cell: TableCell, at: number): FieldPath[];
  /** Reads the value lists, inline objects, identifier lists, statements, and code spans of one cell or block. */
  phrasing(host: string, origin: "table_cell" | "prose", tokens: Token[], loc: Loc, opts?: { statements: boolean; structures: boolean }): Hosted;
}

/**
 * The readers of a specification read from its text. A reader the text
 * needs none of is left out: with no `readRow`, the text has only the rows
 * the extractor reads; with no `readTypeCell`, no type cells; with no
 * `readValueList` or `readIdentifierList`, no such lists; with no `markers`,
 * no mutability markers; and with no `statesConventions`, no conventions
 * paragraph.
 */
export interface TextFrontEnd {
  /** Every table header layout the text uses; a table that matches none fails extraction. */
  layouts: readonly Layout[];
  /** The IR collection a layout's rows go to. */
  rowKind(layout: Layout): RowKind;
  /** Reads a row of a kind outside `GENERIC_ROWS` into the IR. */
  readRow?(kind: RowKind, input: RowInput, ctx: ExtractContext): void;
  /** Parses a type cell, such as `Array[Object]`, into the IR's type expression. Throws on a form the grammar doesn't know. */
  readTypeCell?(raw: string, line: number): TypeExpr;
  /** The object a section's key table describes, named by its heading, as AdCOM's `Object: Ad` names `Ad`; null where the heading names none. */
  objectOf?(section: Section): string | null;
  /**
   * How the text identifies its sections, which every plugin states: by the
   * number each heading writes, as OpenProposal's "4.1 Identity", an
   * unnumbered heading by its parent's number (`numbered`); or by the
   * anchor each heading writes, as AdCOM's `<a name="list_devicetypes">`
   * (`anchored`). A citation names a numbered section by its number and an
   * anchored one by its heading.
   */
  sections: SectionIds;
  /** Whether braces in text write inline objects, as OpenProposal's `{ a, b }` does; true unless false, as for a text whose braces only quote JSON. */
  inlineObjects?: boolean;
  /** Reads the value list that starts at `tokens[start]`, or null. `taken` are tokens another reading holds. */
  readValueList?(tokens: readonly Token[], start: number, taken: ReadonlySet<number>): ValueListRead | null;
  /** Reads the identifier list that starts at `tokens[start]`, or null. */
  readIdentifierList?(tokens: readonly Token[], start: number): IdentifierListRead | null;
  /** What a heading opens, given the section it follows. `name` is the anchor the heading writes for itself, as `<a name="…">`, or null; a section may take it as its ID. */
  sectionOf(heading: { text: string; depth: number; anchor: string; name: string | null }, current: Section): SectionHead;
  /** The mutability markers a field row may carry, and a Required cell may name; null when the text has none. */
  markers?: readonly string[];
  /** The RFC 2119 keywords a sentence's prose states. */
  keywords(prose: string): Rfc2119Keyword[];
  /** The abbreviations the text writes mid-sentence, as "i.e.", whose period ends no sentence; none unless listed. */
  abbreviations?: readonly string[];
  /** Whether a sentence with keywords only names them, as a conventions paragraph does, and states no requirement. */
  statesConventions?(prose: string, keywords: readonly Rfc2119Keyword[]): boolean;
  /** Called with each paragraph's tokens, for a reader that collects prose. */
  onParagraph?(tokens: Token[], ctx: ExtractContext): void;
  /** The specification's own lint checks, beside the generic ones; each finding's kind is one of `FINDING_KINDS`. */
  lint?(ir: SpecIR): Omit<Finding, "disposition">[];
  /** Called once every block is read, before the IR's counts. */
  finalize?(ctx: ExtractContext): void;
}

/** One specification's plugin. */
export interface SpecPlugin {
  /** The plugin's name, its folder under src/specs/. */
  id: string;
  text: TextFrontEnd;
  /** The deterministic checks of the specification's own rules, by rule ID. */
  ruleChecks?: Readonly<Record<string, Check>>;
  /** The fidelity oracle's readers of the specification's text. */
  fidelity?: ConstraintReader;
  /** The notation the round trip renders the specification's tables in. */
  roundTrip?: RoundTripNotation;
}
