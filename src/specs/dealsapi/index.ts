/**
 * The Deals API plugin: the readers of the IAB Tech Lab Deals API 1.0 text
 * (the Deal Sync API), built from its profile, `specs/dealsapi/spec.yaml`.
 *
 * The text writes each object as an `Attribute | Type | Description` table
 * under a heading `Object: <Name>`, whose rows are the object's attributes:
 * the object's name, in snake case, is the rows' owner, as `buyer_seat` for
 * `Object: BuyerSeat`. A Type cell states the base type and, after a `;` or a
 * `,`, the attribute's presence and default (type-cell.ts). A Description
 * cell lists an integer code's meanings as `` `n` = label `` runs split by
 * line breaks, or in prose, "where 0 = …, 1 = …" (text.ts). The Example
 * Scenarios table writes values of four attributes per scenario. Every
 * heading follows an anchor, `<a name="object-deal"></a>`, which is the
 * section's ID; the first H1 is the title, and each later H1 opens a part of
 * the body. The text states no RFC 2119 convention and writes its keywords
 * in lowercase, so a keyword in any case makes a statement.
 */
import type { Layout } from "../../layouts.ts";
import { ExtractError } from "../../errors.ts";
import type { Section, SpecIR } from "../../ir-types.ts";
import { heldOwnerOf } from "../../owners.ts";
import type { DocumentOwner, SpecProfile } from "../../profile.ts";
import { GENERIC_ROWS, type SectionHead, type SpecPlugin } from "../plugin.ts";
import { FIDELITY } from "./fidelity-readers.ts";
import { ROUND_TRIP } from "./render.ts";
import { RULE_CHECKS } from "./rule-checks.ts";
import { attributeRow, ownerOfObject } from "./rows.ts";
import { keywords, objectOf, readValueList } from "./text.ts";

const isObject = (s: Section) => objectOf(s) !== null;

/** Every table header layout the Deals API uses. A table that matches none fails extraction. */
export const LAYOUTS: readonly Layout[] = [
  { id: "attribute", kind: "field", header: ["Attribute", "Type", "Description"], allowed: isObject, allowedText: "an Object: section" },
  // The Example Scenarios table: one scenario per row, and the values it gives the attributes its other columns name.
  { id: "scenario", kind: "concept", header: ["Scenario", "curationfee", "auxdata", "pubcount", "dinventory"], allowed: (s) => s.part === "body" && s.title === "Example Scenarios", allowedText: "the Example Scenarios section" },
];

/**
 * A heading: the first H1, before any section, is the document's title.
 * Every other heading is a section whose ID is the anchor written before
 * it, or, for one with none, as the table of contents, its slug under its
 * parent. Each H1 after the title opens a part of the body; a heading
 * before the first, the table of contents, is front matter.
 */
export function sectionOf(heading: { text: string; depth: number; name: string | null }, current: Section): SectionHead {
  const { text, depth, name } = heading;
  if (depth === 1 && current.id === "front" && current.title === "") return { kind: "title" };
  const part = depth === 1 ? "body" : current.part;
  return { kind: "section", number: null, title: text.replace(/\s+/g, " ").trim(), part, ...(name !== null ? { id: name } : {}) };
}

/**
 * Holds the profile's documents to the text: each is the object of the
 * section it names, an object no other object's attribute holds, and every
 * other object is one that an attribute holds, as `terms` holds `Object:
 * Terms`, so no object is neither a document nor held.
 */
export function checkDocuments(ir: SpecIR, documents: readonly DocumentOwner[]): void {
  const owners = [...new Set(ir.fields.map((f) => f.owner))];
  // A text with no attribute rows describes no object, so it has no document to check.
  if (owners.length === 0) return;
  for (const d of documents) {
    const section = ir.sections.find((s) => s.id === d.section);
    const object = section ? objectOf(section) : null;
    if (object === null || ownerOfObject(object) !== d.owner) throw new ExtractError(`the profile names the document ${d.document} at the section "${d.section}", which ${section ? `describes ${object === null ? "no object" : `the object ${object}`}` : "the text doesn't have"}`);
  }
  const held = new Set(ir.fields.flatMap((f) => heldOwnerOf(ir, f) ?? []));
  for (const o of owners) {
    const isDocument = documents.some((d) => d.owner === o);
    if (isDocument && held.has(o)) throw new ExtractError(`the profile names "${o}" a document, and an attribute of another object holds it`);
    if (!isDocument && !held.has(o)) throw new ExtractError(`the rows of "${o}" are no document the profile names, and no attribute of another object holds them`);
  }
}

export function dealsapi(profile: SpecProfile): SpecPlugin {
  const documents = profile.documents ?? [];
  return {
    id: "dealsapi",
    text: {
      layouts: LAYOUTS,
      rowKind: (layout) => layout.kind,
      readRow: (kind, input, ctx) => {
        if (kind !== "field") throw new Error(`the Deals API plugin reads no "${kind}" row; the extractor reads ${GENERIC_ROWS.join(", ")}`);
        return attributeRow(input, ctx);
      },
      readValueList,
      sectionOf,
      sections: "anchored",
      // The text writes no brace at all, so no inline object.
      inlineObjects: false,
      keywords,
      // The text writes "(i.e. OpenRTB bid requests)" mid-sentence.
      abbreviations: ["i.e.", "e.g."],
      finalize: (ctx) => checkDocuments(ctx.ir, documents),
    },
    ruleChecks: RULE_CHECKS,
    fidelity: FIDELITY,
    roundTrip: ROUND_TRIP,
  };
}
