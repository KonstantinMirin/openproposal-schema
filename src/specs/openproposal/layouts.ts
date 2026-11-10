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
    // The stack's field tables state each row's type in the text's own type names and its presence in a Required column.
    {
      id: "field-required",
      kind: "field",
      header: ["Field", "Type", "Required", "Mutability", "Description"],
      allowed: (s) => s.part === "body" && fieldSections.includes(topNumber(s)!),
      allowedText: sectionsText(fieldSections),
    },
    {
      id: "key-type-required-meaning",
      kind: "key",
      header: ["Key", "Type", "Required", "Meaning"],
      type: "Type",
      typed: true,
      allowed: inPart("body"),
      allowedText: "the body",
    },
    {
      id: "key-type-required-meaning-mutability",
      kind: "key",
      header: ["Key", "Type", "Required", "Meaning", "Mutability"],
      type: "Type",
      typed: true,
      marker: "Mutability",
      allowed: inPart("body"),
      allowedText: "the body",
    },
    {
      id: "key-type-required-meaning-mapping",
      kind: "key",
      header: ["Key", "Type", "Required", "Meaning", "AdCOM 1.0, OpenRTB 2.6"],
      type: "Type",
      typed: true,
      mapping: "AdCOM 1.0, OpenRTB 2.6",
      allowed: inPart("body"),
      allowedText: "the body",
    },
    // The stack's § 2.2 defines its shared types, one a row, by name.
    {
      id: "type-form-rules",
      kind: "definition",
      header: ["Type", "Form", "Rules"],
      allowed: inPart("body"),
      allowedText: "the body",
    },
    // The stack's value tables, each headed by the field or key whose values it defines.
    ...[
      ["Returned when"],
      ["Distribution channel", "Device types"],
      ["The governing file declares"],
      ["Who hosts the creative", "What reaches the seller"],
      ["Entry", "Meaning"],
      ["Kind", "Usual `direction`", "Definition"],
      ["Deal mechanism", { code: true } as const],
      ["Downstream standard", "`reference_type` (§ 5.10)", "Change path"],
      [{ code: true } as const, "One unit", "Rate per", { code: true } as const],
    ].map(
      (rest): Layout => ({
        id: `value-${rest.map((h) => (typeof h === "string" ? h.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "code")).join("-")}`,
        kind: "definition",
        header: [{ code: true }, ...rest],
        allowed: inPart("body"),
        allowedText: "the body",
      }),
    ),
    // The stack's tables that name no field, key, or value: how a standard takes the agreed line item's values, the layers of
    // § 1.2, the Web Bot Auth profile's signature rules and failure statuses, the § 4.3.1 interactions, and the § 4.3.4 instants.
    ...[
      ["Deals API 1.0", "OpenRTB 2.6", "From the agreed line item"],
      ["OpenDirect 2.1", "From the agreed line item"],
      ["Layer", "Question", "Answered by", "Owner", "In the proposal object"],
      ["Rule", "Requests", "Responses"],
      ["Status", "Meaning", "Basis"],
      ["Interaction", "Actor", "Effect; history `action`"],
      ["Instant", "Ends", "Effect when passed"],
    ].map(
      (header): Layout => ({
        id: `table-${header.map((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).join("-")}`,
        kind: "concept",
        header,
        allowed: inPart("body"),
        allowedText: "the body",
      }),
    ),
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
      id: "appendix-a-required",
      kind: "appendix_a",
      header: ["Field", "Section", "Type", "Required", "Marker"],
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
