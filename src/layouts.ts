/**
 * A table header layout: the cells a table's header row writes, the IR
 * collection its rows go to, and where it may appear. Each specification's
 * plugin lists its own (`TextFrontEnd.layouts`).
 */
import type { Section } from "./ir-types.ts";

/** A header cell: literal text, or a placeholder for one code span whose value the table describes. */
export type HeaderCell = string | { code: true };

export interface Layout {
  id: string;
  kind: "field" | "key" | "definition" | "marker" | "concept" | "appendix_a" | "appendix_b";
  header: HeaderCell[];
  /** For a definition layout: whether the value cell is one code span (the default) or text, as AdCOM's list codes are. */
  value?: "code" | "text";
  /** For a key layout: whether the key cell is one code span (the default), or may also be one identifier written as text. */
  key?: "code" | "code-or-text";
  /** For a key layout: the header of the column that says what the key means, `Meaning` by default. */
  meaning?: string;
  /** For a key layout: the header of a column that gives the key's type, which the row keeps as written. */
  type?: string;
  /** Where the layout may appear; a match elsewhere fails extraction. */
  allowed: (section: Section) => boolean;
  allowedText: string;
}

/** A header cell as rendered: plain text, or one code span in backticks. */
export interface RenderedHeader {
  text: string;
  /** Set when the cell is exactly one code span. */
  code: string | null;
}

/** The layout a table's header matches, among a specification's layouts (`TextFrontEnd.layouts`), or null. */
export function matchLayout(layouts: readonly Layout[], header: readonly RenderedHeader[]): Layout | null {
  return (
    layouts.find(
      (l) =>
        l.header.length === header.length &&
        l.header.every((cell, i) => (typeof cell === "string" ? cell === header[i]!.text : header[i]!.code !== null)),
    ) ?? null
  );
}
