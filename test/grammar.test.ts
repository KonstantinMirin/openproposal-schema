import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTypeExpr } from "../src/grammar/type-expr.ts";
import { parseInlineObject } from "../src/grammar/inline-object.ts";
import { parsePresence, resolveWith } from "../src/grammar/required.ts";
import { parsePath } from "../src/grammar/path.ts";
import { MARKERS } from "../src/extract.ts";

test("type expressions parse into the small grammar", () => {
  assert.deepEqual(parseTypeExpr("String"), { kind: "scalar", name: "String" });
  assert.deepEqual(parseTypeExpr("Array[Object]"), { kind: "array", items: { kind: "scalar", name: "Object" } });
  assert.deepEqual(parseTypeExpr("String/Object"), {
    kind: "union",
    members: [
      { kind: "scalar", name: "String" },
      { kind: "scalar", name: "Object" },
    ],
  });
  assert.deepEqual(parseTypeExpr("Timestamp/Offset").kind, "union");
  assert.deepEqual(parseTypeExpr("Array[Array[String]]"), {
    kind: "array",
    items: { kind: "array", items: { kind: "scalar", name: "String" } },
  });
});

test("an unknown or malformed type expression is an error, not a string", () => {
  assert.throws(() => parseTypeExpr("Map[String]"), /unknown type name "Map"/);
  assert.throws(() => parseTypeExpr("Array[Object"), /expected "\]"/);
  assert.throws(() => parseTypeExpr("String or Object"), /unexpected/);
  assert.throws(() => parseTypeExpr(""), /expected a type name/);
});

test("inline objects parse keys, arrays, nested objects, and value lists", () => {
  const form = parseInlineObject("{ max: { min, max }, period, basis: device | household | listener, segments[] }");
  assert.equal(form.combinator, "all");
  assert.deepEqual(
    form.members.map((m) => [m.key, m.array, m.value?.kind ?? null]),
    [
      ["max", false, "object"],
      ["period", false, null],
      ["basis", false, "values"],
      ["segments", true, null],
    ],
  );
  const basis = form.members[2]!.value;
  assert.deepEqual(basis, { kind: "values", items: ["device", "household", "listener"] });
});

test("an object whose members are separated by | is a one_of", () => {
  const form = parseInlineObject("{ option_id: { delta_cpm | delta_flat | delta_pct } }");
  const inner = form.members[0]!.value;
  assert.equal(inner?.kind, "object");
  if (inner?.kind === "object") {
    assert.equal(inner.object.combinator, "one_of");
    assert.deepEqual(
      inner.object.members.map((m) => m.key),
      ["delta_cpm", "delta_flat", "delta_pct"],
    );
  }
});

test("a malformed inline object is an error", () => {
  assert.throws(() => parseInlineObject("{ a, b | c }"), /mixes/);
  assert.throws(() => parseInlineObject("{ a: }"), /expected a name/);
  assert.throws(() => parseInlineObject("{ a.b }"), /unexpected "\."/);
});

test("presence parses levels, conditions, fallbacks, and markers", () => {
  assert.deepEqual(parsePresence("REQUIRED", MARKERS), { kind: "clauses", clauses: [{ level: "REQUIRED", qualifier: null, condition: null }] });
  assert.deepEqual(parsePresence("REQUIRED when `basis = spend`", MARKERS).kind, "clauses");
  assert.deepEqual(parsePresence("REQUIRED for video ads; otherwise OPTIONAL", MARKERS), {
    kind: "clauses",
    clauses: [
      { level: "REQUIRED", qualifier: "for", condition: "video ads" },
      { level: "OPTIONAL", qualifier: "otherwise", condition: null },
    ],
  });
  assert.deepEqual(parsePresence("derived", MARKERS), { kind: "marker", marker: "derived" });
  assert.throws(() => parsePresence("Mandatory", MARKERS), /unparsed presence/);
});

test("presence reads the members a with clause names, and resolves either against the sentence before", () => {
  assert.deepEqual(parsePresence("REQUIRED with `daypart` or `frequency_cap.period`", MARKERS), {
    kind: "clauses",
    clauses: [{ level: "REQUIRED", qualifier: "with", condition: "`daypart` or `frequency_cap.period`", members: ["daypart", "frequency_cap.period"] }],
  });
  const either = parsePresence("REQUIRED with either", MARKERS);
  assert.deepEqual(either, { kind: "clauses", clauses: [{ level: "REQUIRED", qualifier: "with", condition: "either" }] });
  assert.deepEqual(resolveWith(either, ["daypart", "frequency_cap.period"], "REQUIRED with either"), {
    kind: "clauses",
    clauses: [{ level: "REQUIRED", qualifier: "with", condition: "either", members: ["daypart", "frequency_cap.period"] }],
  });
  assert.throws(() => resolveWith(either, null, "REQUIRED with either"), /names exactly two members, not none/);
  assert.throws(() => resolveWith(either, ["daypart"], "REQUIRED with either"), /names exactly two members, not 1/);
  assert.throws(() => parsePresence("REQUIRED with the daypart", MARKERS), /neither "either" nor code spans/);
});

test("paths split into segments with array markers", () => {
  assert.deepEqual(parsePath("pricing[].cost_method").segments, [
    { name: "pricing", array: true },
    { name: "cost_method", array: false },
  ]);
  assert.throws(() => parsePath("pricing[]x"), /not a field path/);
});
