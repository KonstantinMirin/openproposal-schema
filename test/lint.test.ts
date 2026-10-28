import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLock } from "../src/lock.ts";
import { materialize } from "../src/fetch.ts";
import { lint } from "../src/lint.ts";
import { FIELD_HEADER, OP, SPEC, extractText, lineItems } from "./helpers.ts";

/** OpenProposal's lint: its appendices, and its numbered sections. */
const OP_LINT = { appendices: true, sections: OP.text.sections };

/** Applies one exact text replacement, failing if the original text is absent. */
function corrupt(text: string, from: string, to: string): string {
  assert.ok(text.includes(from), `fixture text not found: ${from}`);
  return text.replace(from, to);
}

test("Appendix A and B checks find each kind of drift in a corrupted copy of main", async () => {
  const lock = loadLock(`${SPEC}/spec-input/spec-lock.yaml`);
  let text = (await materialize(lock)).bytes.toString("utf8");
  assert.deepEqual(
    lint(extractText(text), undefined, OP_LINT).filter((f) => f.kind.startsWith("appendix_")),
    [],
    "the pinned main spec has consistent appendices",
  );
  text = corrupt(text, "| `seller_id` | 4.1 Identity and lifecycle | String | immutable |\n", "");
  text = corrupt(text, "| `version` | 4.1 Identity and lifecycle | Integer | derived |", "| `version` | 4.1 Identity and lifecycle | Number | seller-set |");
  text = corrupt(text, "| immutable | 6 |", "| immutable | 5 |");
  text = corrupt(text, "Of 71 fields,", "Of 70 fields,");
  const ids = lint(extractText(text), undefined, OP_LINT)
    .filter((f) => f.kind.startsWith("appendix_"))
    .map((f) => f.id);
  assert.deepEqual(ids, [
    "appendix_a_row_missing:field:4.1:seller_id",
    "appendix_a_mismatch:field:4.1:version:marker",
    "appendix_a_mismatch:field:4.1:version:type",
    "appendix_b_count:immutable",
    "appendix_b_distribution:total",
  ]);
});

test("duplicate value sets, unresolved identifiers, and missing structure are reported", () => {
  const md = lineItems(
    [
      "### 5.1 Identity",
      "",
      FIELD_HEADER,
      "| `kind` | Enum | immutable | `a` \\| `b` |",
      "| `mode` | Enum | seller-set | `b` \\| `a` |",
      "| `blob` | Object | seller-set | Free-form detail |",
      "| `method` | Enum | seller-set | CPM, CPC, etc. |",
      "",
      "A seller MUST honour `ghost_field`. Each line item MUST be self-contained.",
    ].join("\n"),
  );
  const ids = lint(extractText(md), undefined, OP_LINT).map((f) => f.id);
  for (const id of [
    "value_set_duplicate:a | b",
    "unresolved_identifier:ghost_field",
    "object_without_structure:field:5.1:blob",
    "enum_without_values:field:5.1:method",
    "presence_unstated:line_item",
  ]) {
    assert.ok(ids.includes(id), `missing ${id} in ${ids.join(", ")}`);
  }
  assert.equal(ids.filter((id) => id.startsWith("must_without_field:")).length, 2);
});

test("the line item's clock names no identifier the lint can't resolve, in #123's text and in its amendment", () => {
  const clock = (daypart: string, window: string, zones: string) =>
    lineItems(
      [
        "### 5.5 Targeting envelope",
        "",
        FIELD_HEADER,
        `| \`daypart\` | Object | settable | \`allowed[]\` of \`{ days[], start, end }\`: ${daypart}, \`end\` exclusive, up to \`24:00\` |`,
        "| `time_zone` | String | seller-set | IANA time zone name, or `viewer_local` (where the ad renders). The clock for `daypart`. REQUIRED with `daypart` |",
        "",
        `**Window shape.** A \`daypart\` window is \`{ days[], start, end }\`, with \`days[]\` ${window}, and \`end\` exclusive.`,
        "",
        `**Clock.** \`time_zone\` names a zone in the IANA time zone database, such as ${zones}.`,
      ].join("\n"),
    );
  const unresolved = (md: string) =>
    lint(extractText(md), undefined, OP_LINT)
      // The excerpt has no § 3.2, which defines `allowed[]`.
      .filter((f) => f.kind === "unresolved_identifier" && f.id !== "unresolved_identifier:allowed[]")
      .map((f) => f.id)
      .sort();
  // #123 as the open-PRs lock pins it: the day range and the example zone stay open; the format and the one value don't.
  assert.deepEqual(unresolved(clock("`monday`–`sunday`, `HH:MM` civil time", "from `monday` to `sunday`, `start` and `end` as `HH:MM`", "`America/New_York` or `UTC`")), [
    "unresolved_identifier:UTC",
    "unresolved_identifier:monday",
    "unresolved_identifier:sunday",
  ]);
  // The amendment lists the days as one value list and writes the format and the examples as plain text.
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => `\`${d}\``).join(" \\| ");
  assert.deepEqual(unresolved(clock(`\`days[]\` from ${days}, HH:MM civil time`, "from Monday to Sunday, `start` and `end` as HH:MM", "America/New_York or UTC")), []);
});

test("a row's one value beside prose resolves where the row writes it and as its field's value, never as a name elsewhere", () => {
  const md = lineItems(
    [
      "### 5.5 Targeting envelope",
      "",
      FIELD_HEADER,
      "| `time_zone` | String | seller-set | IANA time zone name, or `viewer_local` (where the ad renders) |",
      "| `mode` | String | seller-set | `auto`, or `manual` |",
      "",
      "A seller MAY write `viewer_local`, `manual`, or `auto`. When `time_zone = viewer_local`, the seller MUST read the viewer's clock.",
    ].join("\n"),
  );
  const ids = lint(extractText(md), undefined, OP_LINT)
    .filter((f) => f.kind === "unresolved_identifier" || f.kind === "expression_value_unknown")
    .map((f) => f.id)
    .sort();
  // The row's own `viewer_local` resolves, and so does the expression on its field; the bare name in the sentence doesn't.
  assert.deepEqual(ids, ["unresolved_identifier:auto", "unresolved_identifier:manual", "unresolved_identifier:viewer_local"]);
});

test("fixtures of an independent review: a typo that a row's one value or an unspaced colon hid is found", () => {
  const md = lineItems(
    [
      "### 5.5 Targeting envelope",
      "",
      FIELD_HEADER,
      "| `owner` | String | seller-set | A seat ID, or `sellr_id` |",
      "| `status` | Enum | seller-set | `draft` \\| `published` |",
      "",
      "A seller MUST honour `sellr_id`. When `staus:published`, a seller MUST honour `status:archived`.",
    ].join("\n"),
  );
  const ids = lint(extractText(md), undefined, OP_LINT)
    .filter((f) => f.kind === "unresolved_identifier" || f.kind === "expression_value_unknown")
    .map((f) => f.id)
    .sort();
  assert.deepEqual(ids, ["expression_value_unknown:status:archived", "unresolved_identifier:sellr_id", "unresolved_identifier:staus"]);
});

test("the unstated-presence check counts the fields of every owner the rows have, not only OpenProposal's", () => {
  const ir = extractText(lineItems(`${FIELD_HEADER}\n| \`id\` | String | immutable | The ID. |\n| \`name\` | String | seller-set | REQUIRED. The name. |`));
  const deal = { ...ir, fields: ir.fields.map((f) => ({ ...f, owner: "deal_terms" })) };
  const f = lint(deal, undefined, OP_LINT).find((x) => x.kind === "presence_unstated");
  assert.equal(f?.id, "presence_unstated:deal_terms");
  assert.equal(f?.message, "1 of 2 deal terms fields don't say whether they're REQUIRED or OPTIONAL.");
});
