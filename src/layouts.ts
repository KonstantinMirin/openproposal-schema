import type { Section } from "./ir-types.ts";

/** A header cell: literal text, or a placeholder for one code span whose value the table describes. */
export type HeaderCell = string | { code: true };

export interface Layout {
  id: string;
  kind: "field" | "key" | "definition" | "marker" | "concept" | "appendix_a" | "appendix_b";
  header: HeaderCell[];
  /** Where the layout may appear; a match elsewhere fails extraction. */
  allowed: (section: Section) => boolean;
  allowedText: string;
}

const inPart = (part: Section["part"]) => (s: Section) => s.part === part;
const topNumber = (s: Section) => s.id.split(/[./]/)[0];

/**
 * Every table header layout the specification uses. A table whose header
 * matches none of these fails extraction, so a new layout is a deliberate
 * change here, never a silent skip.
 */
export const LAYOUTS: readonly Layout[] = [
  {
    id: "field",
    kind: "field",
    header: ["Field", "Type", "Mutability", "Description"],
    allowed: (s) => s.part === "body" && ["4", "5"].includes(topNumber(s)!),
    allowedText: "§ 4.x or § 5.x",
  },
  {
    id: "key-required-meaning",
    kind: "key",
    header: ["Key", "Required", "Meaning"],
    allowed: inPart("body"),
    allowedText: "the body",
  },
  {
    id: "key-required-meaning-mapping",
    kind: "key",
    header: ["Key", "Required", "Meaning", "AdCOM 1.0, OpenRTB 2.6"],
    allowed: inPart("body"),
    allowedText: "the body",
  },
  {
    id: "key-meaning",
    kind: "key",
    header: ["Key", "Meaning"],
    allowed: inPart("body"),
    allowedText: "the body",
  },
  {
    id: "value-condition",
    kind: "definition",
    header: [{ code: true }, "Condition"],
    allowed: inPart("body"),
    allowedText: "the body",
  },
  {
    id: "value-distribution-device",
    kind: "definition",
    header: ["Value", "Distribution channel", "Device types"],
    allowed: inPart("body"),
    allowedText: "the body",
  },
  {
    id: "marker-meaning",
    kind: "marker",
    header: ["Marker", "Meaning"],
    allowed: inPart("body"),
    allowedText: "the body",
  },
  {
    id: "concept-standard",
    kind: "concept",
    header: ["OpenProposal concept", "Downstream standard"],
    allowed: inPart("body"),
    allowedText: "the body",
  },
  {
    id: "appendix-a",
    kind: "appendix_a",
    header: ["Field", "Section", "Type", "Marker"],
    allowed: (s) => s.id === "A",
    allowedText: "Appendix A",
  },
  {
    id: "appendix-b",
    kind: "appendix_b",
    header: ["Marker", "Count", "Meaning", "Fields"],
    allowed: (s) => s.id === "B",
    allowedText: "Appendix B",
  },
];

/** A header cell as rendered: plain text, or one code span in backticks. */
export interface RenderedHeader {
  text: string;
  /** Set when the cell is exactly one code span. */
  code: string | null;
}

export function matchLayout(header: readonly RenderedHeader[]): Layout | null {
  return (
    LAYOUTS.find(
      (l) =>
        l.header.length === header.length &&
        l.header.every((cell, i) => (typeof cell === "string" ? cell === header[i]!.text : header[i]!.code !== null)),
    ) ?? null
  );
}
