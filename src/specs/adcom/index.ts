/**
 * The AdCOM plugin: the readers of AdCOM 1.0's text, built from its profile,
 * `specs/adcom/spec.yaml`.
 *
 * AdCOM writes its tables in HTML: a `List:` section holds a `Value |
 * Definition` table of codes, and an `Object:` section a `Attribute | Type |
 * Definition` table of attributes, with one `Content` table in Markdown.
 * Its headings carry no numbers; each writes its own anchor, as `<a
 * name="list_devicetypes">`, which every link to it names, so a section's ID
 * is that anchor. The text states no RFC 2119 convention and writes its
 * keywords in either case, so a keyword in any case makes a statement.
 */
import type { Section } from "../../ir-types.ts";
import type { Layout } from "../../layouts.ts";
import type { SpecProfile } from "../../profile.ts";
import { findKeywords, type Rfc2119Keyword } from "../../sentences.ts";
import type { SectionHead, SpecPlugin } from "../plugin.ts";
import { lintAdcom } from "./lint.ts";
import { ROUND_TRIP } from "./render.ts";
import { FIDELITY } from "./fidelity-readers.ts";

const isList = (s: Section) => s.part === "body" && /^List:/.test(s.title);
const isObject = (s: Section) => s.part === "body" && /^(Object|Abstract Class):/.test(s.title);

/** Every table header layout AdCOM uses. A table that matches none fails extraction. */
export const LAYOUTS: readonly Layout[] = [
  { id: "html-list", kind: "definition", header: ["Value", "Definition"], value: "text", allowed: isList, allowedText: "a List: section" },
  { id: "html-list-class", kind: "definition", header: ["Value", "Class", "Definition"], value: "text", allowed: isList, allowedText: "a List: section" },
  { id: "html-list-name", kind: "definition", header: ["Value", "Name", "Definition"], value: "text", allowed: isList, allowedText: "a List: section" },
  { id: "html-object", kind: "key", header: ["Attribute", "Type", "Definition"], key: "code-or-text", meaning: "Definition", type: "Type", allowed: isObject, allowedText: "an Object: section" },
  { id: "markdown-object", kind: "key", header: ["Attribute", "Type", "Description"], key: "code-or-text", meaning: "Description", type: "Type", allowed: isObject, allowedText: "an Object: section" },
  // The change log's rows record what each release changed; they name no attribute or code of their own.
  { id: "changelog", kind: "concept", header: ["Version", "Release", "Changes"], allowed: (s) => s.part === "appendix", allowedText: "an appendix" },
];

/**
 * A heading: the first H1, before any section, is the document's title.
 * Every other heading is a section whose ID is the anchor it writes, or,
 * for one that writes none, its slug under its parent. The body is the
 * SPECIFICATION part, and an H1 that starts "Appendix" opens an appendix.
 */
export function sectionOf(heading: { text: string; depth: number; name: string | null }, current: Section): SectionHead {
  const { text, depth, name } = heading;
  if (depth === 1 && current.id === "front" && current.title === "") return { kind: "title" };
  let part = current.part;
  if (depth === 1) part = /^Appendix\b/i.test(text) ? "appendix" : /^SPECIFICATION$/.test(text) ? "body" : "front";
  return { kind: "section", number: null, title: text.replace(/\s+/g, " ").trim(), part, ...(name !== null ? { id: name } : {}) };
}

/**
 * The object an `Object:` or `Abstract Class:` section describes, by the name
 * its heading gives: the name itself where it is one word, as `Ad`, and else
 * its words in PascalCase, as `ExtendedIdentifiers` for "Extended
 * Identifiers", which the objects phase may rename by a decision.
 */
export function objectOf(section: Section): string | null {
  const m = /^(?:Object|Abstract Class):\s*(.+)$/.exec(section.title);
  if (!m) return null;
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(m[1]!)) return m[1]!;
  return m[1]!.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join("");
}

/** The RFC 2119 keywords a sentence writes, in any case. */
export const keywords = (prose: string): Rfc2119Keyword[] => findKeywords(prose.toUpperCase());

export function adcom(_profile: SpecProfile): SpecPlugin {
  return {
    id: "adcom",
    text: {
      layouts: LAYOUTS,
      rowKind: (layout) => layout.kind,
      sectionOf,
      keywords,
      // AdCOM's braces quote JSON, as `{"acct": "123"}`; it writes no inline object form.
      inlineObjects: false,
      numbered: false,
      objectOf,
      lint: lintAdcom,
    },
    roundTrip: ROUND_TRIP,
    fidelity: FIDELITY,
  };
}
