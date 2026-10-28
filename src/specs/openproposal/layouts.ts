import type { Section } from "../../ir-types.ts";
import type { Layout } from "../../layouts.ts";
import type { DocumentOwner } from "../../profile.ts";

const inPart = (part: Section["part"]) => (s: Section) => s.part === part;
const topNumber = (s: Section) => s.id.split(/[./]/)[0];

/** A list of sections as a sentence names them: "§ 4.x or § 5.x". */
const sectionsText = (sections: readonly string[]) => sections.map((n) => `§ ${n}.x`).join(" or ");

/**
 * Every table header layout OpenProposal uses. A table whose header matches
 * none of these fails extraction, so a new layout is a deliberate change
 * here, never a silent skip. Field rows may appear only in the sections the
 * profile's documents own, § 4 and § 5.
 */
export function layoutsOf(documents: readonly DocumentOwner[]): readonly Layout[] {
  const fieldSections = documents.map((d) => d.section);
  return [
    {
      id: "field",
      kind: "field",
      header: ["Field", "Type", "Mutability", "Description"],
      allowed: (s) => s.part === "body" && fieldSections.includes(topNumber(s)!),
      allowedText: sectionsText(fieldSections),
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
}
