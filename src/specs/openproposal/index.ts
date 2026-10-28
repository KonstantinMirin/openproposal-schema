/**
 * The OpenProposal plugin: the readers of OpenProposal 3.0's text, built
 * from its profile, `specs/openproposal/spec.yaml`.
 */
import type { SpecProfile } from "../../profile.ts";
import { GENERIC_ROWS, type SpecPlugin } from "../plugin.ts";
import { FIDELITY } from "./fidelity-readers.ts";
import { layoutsOf } from "./layouts.ts";
import { ROUND_TRIP } from "./render.ts";
import { RULE_CHECKS } from "./rule-checks.ts";
import { appendixARow, appendixBRow, fieldRow, finalize, MARKERS, onParagraph } from "./rows.ts";
import { keywords, readIdentifierList, readValueList, sectionOf, statesConventions } from "./text.ts";
import { parseTypeExpr } from "./type-cell.ts";

export function openproposal(profile: SpecProfile): SpecPlugin {
  const documents = profile.documents ?? [];
  return {
    id: "openproposal",
    text: {
      layouts: layoutsOf(documents),
      rowKind: (layout) => layout.kind,
      readRow: (kind, input, ctx) => {
        switch (kind) {
          case "field":
            return fieldRow(input, ctx, documents);
          case "appendix_a":
            return appendixARow(input, ctx);
          case "appendix_b":
            return appendixBRow(input, ctx);
          default:
            throw new Error(`the OpenProposal plugin reads no "${kind}" row; the extractor reads ${GENERIC_ROWS.join(", ")}`);
        }
      },
      readTypeCell: parseTypeExpr,
      readValueList,
      readIdentifierList,
      sectionOf,
      markers: MARKERS,
      keywords,
      statesConventions,
      onParagraph,
      finalize,
    },
    ruleChecks: RULE_CHECKS,
    fidelity: FIDELITY,
    roundTrip: ROUND_TRIP,
  };
}
