import { test } from "node:test";
import assert from "node:assert/strict";
import { extractText, FIELD_HEADER, lineItems } from "./helpers.ts";
import { splitSentences, findKeywords } from "../src/sentences.ts";
import { tokenize, parseMarkdown } from "../src/markdown.ts";
import type { Paragraph } from "mdast";

const fieldTable = (rows: string) => lineItems(`### 5.1 Identity\n\n${FIELD_HEADER}\n${rows}`);

test("an unknown table layout fails extraction", () => {
  const md = lineItems("### 5.1 Identity\n\n| Name | Kind |\n| --- | --- |\n| `a` | b |");
  assert.throws(() => extractText(md), /unknown table layout "\| Name \| Kind \|"/);
});

test("a field table outside § 4 and § 5 fails extraction", () => {
  const md = `# Spec\n\n## 2. Object shape\n\n${FIELD_HEADER}\n| \`a\` | String | immutable | x |\n`;
  assert.throws(() => extractText(md), /layout "field" belongs in § 4.x or § 5.x/);
});

test("a row whose cell count differs from the header fails extraction", () => {
  assert.throws(() => extractText(fieldTable("| `a` | String | immutable |")), /row has 3 cells; layout "field" has 4/);
});

test("an unknown marker or unparsed type fails extraction", () => {
  assert.throws(() => extractText(fieldTable("| `a` | String | negotiable | x |")), /unknown mutability marker "negotiable"/);
  assert.throws(() => extractText(fieldTable("| `a` | Strng | immutable | x |")), /unknown type name "Strng"/);
});

test("a field row yields its path, owner, type, marker, presence, and location", () => {
  const ir = extractText(fieldTable("| `pricing[].floor` | Number | seller-set | OPTIONAL. The lowest rate |"));
  const f = ir.fields[0]!;
  assert.equal(f.id, "field:5.1:pricing[].floor");
  assert.equal(f.owner, "line_item");
  assert.deepEqual(f.type.parsed, { kind: "scalar", name: "Number" });
  assert.equal(f.marker, "seller-set");
  assert.deepEqual(f.presence, { kind: "clauses", clauses: [{ level: "OPTIONAL", qualifier: null, condition: null }] });
  assert.deepEqual(f.loc, { section: "5.1", line: 9, table: "table:5.1:1", row: 1 });
});

test("a combined field cell yields one row with two names", () => {
  const ir = extractText(fieldTable("| `valid_from` · `valid_until` | Timestamp | seller-set | Window |"));
  assert.deepEqual(
    ir.fields[0]!.names.map((n) => n.path),
    ["valid_from", "valid_until"],
  );
  assert.equal(ir.fields[0]!.id, "field:5.1:valid_from,valid_until");
});

test("value lists keep annotations, the `from` subject, and the trailing context", () => {
  const ir = extractText(
    fieldTable(
      [
        "| `mode` | Enum | seller-set | `none` (default) \\| `all` (every line) |",
        "| `env` | Object | selectable | `available[]` from `web` \\| `app` and other places |",
      ].join("\n"),
    ),
  );
  const [mode, env] = ir.value_lists;
  assert.deepEqual(mode!.items, [
    { value: "none", annotation: "default" },
    { value: "all", annotation: "every line" },
  ]);
  assert.equal(mode!.subject, null);
  assert.deepEqual(env!.subject, { identifier: "available[]", relation: "from" });
  assert.equal(env!.context_after, "and other places");
});

test("inline objects record their anchor and register member value lists", () => {
  const ir = extractText(fieldTable("| `props` | Object | selectable | `available[]` of `{ id, kind: a \\| b }`, `included[]` |"));
  const o = ir.inline_objects[0]!;
  assert.equal(o.anchor, "available[]");
  assert.equal(o.source, "code");
  const list = ir.value_lists.find((v) => v.origin === "inline_object")!;
  assert.equal(list.id, `${o.id}/kind`);
  assert.deepEqual(
    list.items.map((i) => i.value),
    ["a", "b"],
  );
  // The code span holding the object is not also reported as a code span.
  assert.deepEqual(
    ir.code_spans.map((c) => c.value),
    ["available[]", "included[]"],
  );
});

test("key tables take their parent from a heading that names a field", () => {
  const md = lineItems(
    [
      "### 5.6 Commercial terms",
      "",
      FIELD_HEADER,
      "| `commitment` | Object | settable | See 5.6.1 |",
      "",
      "#### 5.6.1 commitment",
      "",
      "| Key | Required | Meaning |",
      "| :--- | :--- | :--- |",
      "| `currency` | REQUIRED when `basis = spend` | ISO-4217 |",
    ].join("\n"),
  );
  const ir = extractText(md);
  const k = ir.keys[0]!;
  assert.equal(k.id, "key:5.6.1:commitment.currency");
  assert.equal(ir.tables[1]!.parent?.field, "field:5.6:commitment");
  assert.equal(k.required?.parsed.kind, "clauses");
  assert.deepEqual(
    ir.code_spans.map((c) => [c.kind, c.lhs, c.rhs]),
    [["expression", "basis", "spend"]],
  );
});

test("statements carry keywords, the strongest level, and identifiers; ids are stable", () => {
  const md = lineItems("### 5.2 Rules\n\nA seller MUST NOT change `status`. It MAY revise `notes`. Plain prose.");
  const a = extractText(md);
  const b = extractText(md.replace("### 5.2 Rules", "### 5.2 Rules\n\nAn added paragraph."));
  assert.equal(a.statements.length, 2);
  assert.deepEqual(a.statements[0]!.keywords, ["MUST NOT"]);
  assert.equal(a.statements[0]!.level, "MUST NOT");
  assert.deepEqual(a.statements[0]!.identifiers, ["status"]);
  assert.deepEqual(
    a.statements.map((s) => s.id),
    b.statements.map((s) => s.id),
  );
});

test("a prose sentence with no keyword is a sentence when it names an identifier; table cells and plain prose are not", () => {
  const md = lineItems(
    "### 5.2 Rules\n\n`enforcement` is `pre_serve` or `best_effort`. A seller MUST set `status`. Plain prose.\n\n" +
      `${FIELD_HEADER}\n| \`a\` | String | immutable | \`b\` is a code. |\n`,
  );
  const ir = extractText(md);
  assert.deepEqual(
    ir.sentences.map((s) => [s.text, s.identifiers, s.part]),
    [["`enforcement` is `pre_serve` or `best_effort`.", ["enforcement", "pre_serve", "best_effort"], "body"]],
  );
  assert.match(ir.sentences[0]!.id, /^sentence:5\.2:[0-9a-f]{8}$/);
  assert.equal(ir.statements.length, 1);
});

test("the sentence splitter keeps code spans and abbreviations intact", () => {
  const p = parseMarkdown("Use `app.bundle`. Then e.g. this, see § 5.5. `x` MUST be set. Done").children[0] as Paragraph;
  const s = splitSentences(tokenize(p.children)).map((x) => x.text);
  assert.deepEqual(s, ["Use `app.bundle`.", "Then e.g. this, see § 5.5.", "`x` MUST be set.", "Done"]);
});

test("keyword search counts MUST NOT once, not also as MUST", () => {
  assert.deepEqual(findKeywords("A MUST NOT B, and C MUST D, and E MAY F"), ["MUST NOT", "MUST", "MAY"]);
  assert.deepEqual(findKeywords("Lowercase must and may are not keywords"), []);
});

test("an unnumbered heading inherits its parent's number in its section id", () => {
  const ir = extractText(lineItems("### 5.4 Creative\n\n#### Inspection notes\n\nAn inspector MUST NOT fire events."));
  assert.equal(ir.statements[0]!.loc.section, "5.4/inspection-notes");
});

test("every table row is typed, and ids are unique", () => {
  const md = fieldTable("| `a` | String | immutable | x |\n| `a` | String | immutable | y |");
  assert.throws(() => extractText(md), /duplicate field id "field:5.1:a"/);
});

test("a time-of-day format such as HH:MM names no identifier, and any other colon makes an expression, spaced or not", async () => {
  const { classifyCode } = await import("../src/extract.ts");
  for (const format of ["HH:MM", "hh:mm", "24:00", "09:30", "HH:MM:SS"]) assert.deepEqual(classifyCode(format), { kind: "other", lhs: null, rhs: null }, format);
  assert.deepEqual(classifyCode("cost_method: flat"), { kind: "expression", lhs: "cost_method", rhs: "flat" });
  // A misspelled member in an unspaced expression is still an expression, so the lint checks its member.
  assert.deepEqual(classifyCode("staus:published"), { kind: "expression", lhs: "staus", rhs: "published" });
  assert.deepEqual(classifyCode("cost_method:flat"), { kind: "expression", lhs: "cost_method", rhs: "flat" });
  assert.deepEqual(classifyCode("basis = spend"), { kind: "expression", lhs: "basis", rhs: "spend" });
  assert.deepEqual(classifyCode("basis=spend"), { kind: "expression", lhs: "basis", rhs: "spend" });
});
