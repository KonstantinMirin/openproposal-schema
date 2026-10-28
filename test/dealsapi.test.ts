import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allLocks } from "../src/builds.ts";
import { classifyCode, extract } from "../src/extract.ts";
import { renderExtractionReport, specReportBlocks, specReportFile, specReportLocks } from "../src/extraction-report.ts";
import type { InputRecord, SpecIR } from "../src/ir-types.ts";
import { lint, type Finding } from "../src/lint.ts";
import { checkDocuments, dealsapi } from "../src/specs/dealsapi/index.ts";
import { parseTypeCell } from "../src/specs/dealsapi/type-cell.ts";
import { snapshotOf } from "../src/fetch.ts";
import { REPO_ROOT, specRoot } from "../src/repo.ts";
import { specOf } from "../src/specs/index.ts";

const DEALS = specRoot("dealsapi");

test("the Deals API is locked at main 3028ddc by default and at the tag 1.0-202602, each with its snapshot, which differ in two lines", () => {
  const locks = allLocks(DEALS);
  assert.deepEqual(locks.map((l) => [l.name, l.commit, l.blob, l.tag ?? null, l.required]), [
    ["main", "3028ddcb8d5faea44bdab272aeaa9be6b5980f81", "c2dc7944d257036aa6dbbe70ca084c4f6670da8e", null, true],
    ["tag-1.0-202602", "938a5d1fdb5705ae53b2584c90b9eb325b71a96b", "f675232c0e0d57b77ce1fc34b74baa2e42bc700a", "1.0-202602", true],
  ]);
  const [main, tag] = locks.map((l) => readFileSync(join(DEALS, snapshotOf(l)!, l.path), "utf8").split("\n"));
  assert.equal(main!.length, tag!.length);
  const differ = main!.flatMap((line, i) => (line === tag![i] ? [] : [i + 1]));
  // The sellerstatus row, where the tag writes `4` twice, and the What it is list's "tenants", which the tag spells "tenents".
  assert.deepEqual(differ, [54, 88]);
  assert.match(tag![87]!, /`4` = deal is complete .*`4` = deal is archived/);
  assert.match(main![87]!, /`3` = deal is complete .*`4` = deal is archived/);
  assert.match(tag![53]!, /outlines the tenents of the Deal\.$/);
  assert.match(main![53]!, /outlines the tenants of the Deal\.$/);
  const { profile, plugin } = specOf(DEALS);
  assert.deepEqual([profile.id, profile.statements, plugin?.id, plugin?.text.sections], ["dealsapi", "any-case", "dealsapi", "anchored"]);
  // The text writes its keywords in lowercase, which the plugin reads.
  assert.deepEqual(plugin!.text.keywords("this should be used"), ["SHOULD"]);
});

// ----- Extraction (P3.2) -----

const TEXT = specOf(DEALS).plugin!.text;
const INPUT: InputRecord = { name: "t", upstream: "u", commit: "c".repeat(40), path: "p.md", blob: "b".repeat(40), base: null, merge_order: null, sha256: "0".repeat(64), bytes: 0 };
/** The fixtures' plugin: the Deals API's readers, with the fixtures' one document, `Object: Thing`. */
const FIXTURE = dealsapi({ ...specOf(DEALS).profile, documents: [{ owner: "thing", document: "Thing", section: "object-thing" }] }).text;
const run = (md: string): SpecIR => extract(md, INPUT, FIXTURE);
const objectTable = (rows: string) => `# Title\n\n<a name="spec"></a>\n# Spec\n\n<a name="object-thing"></a>\n## Object: Thing\n\n| Attribute | Type | Description |\n|-----------|------|-------------|\n${rows}\n`;
const IR = (lock: string) => JSON.parse(readFileSync(join(DEALS, lock === "main" ? "ir" : join("ir", lock), "spec-ir.json"), "utf8")) as SpecIR;
const FINDINGS = (lock: string) => (JSON.parse(readFileSync(join(DEALS, lock === "main" ? "ir" : join("ir", lock), "findings.json"), "utf8")) as { findings: Finding[] }).findings;

test("an anchor on a line of its own names the heading after it, which takes it as its ID, and an anchor that names no heading fails", () => {
  const ir = run(objectTable("| `a` | string | A. |"));
  assert.deepEqual(ir.sections.map((s) => [s.id, s.parent, s.part]), [["front", null, "front"], ["spec", null, "body"], ["object-thing", "spec", "body"]]);
  assert.equal(ir.fields[0]!.id, "field:object-thing:a");
  assert.throws(() => run('# T\n\n<a name="x"></a>\n\nA paragraph.\n'), /the anchor "x" on its own line is followed by a paragraph, not by the heading it names/);
  assert.throws(() => run('# T\n\n<a name="x"></a>\n'), /the anchor "x" on its own line ends the text, with no heading after it/);
  assert.throws(() => run('# T\n\n<a name="x"></a>\n## Two <a name="y"></a>\n'), /a heading with 2 anchors: x, y/);
  assert.throws(() => run('# T\n\n<a name="x"></a>\n\n| Attribute | Type | Description |\n|---|---|---|\n| `a` | string | A. |\n'), /the anchor "x" on its own line is followed by a table/);
  // A heading with no anchor, as the table of contents, takes its slug under its parent, and before the first H1 after the title is front matter.
  assert.deepEqual(run("# T\n\n## Table of Contents\n\n- x\n").sections.map((s) => [s.id, s.part]), [["front", "front"], ["front/table-of-contents", "front"]]);
});

test("a Type cell states the base type, an array, the presence, and the default, and any other form fails", () => {
  const cell = (s: string) => parseTypeCell(s, 1);
  assert.deepEqual(cell("string; required"), { base: "string", parsed: { kind: "scalar", name: "String" }, presence: { kind: "clauses", clauses: [{ level: "REQUIRED", qualifier: null, condition: null }] }, default: null });
  assert.deepEqual(cell("int, default 0, recommended"), { base: "int", parsed: { kind: "scalar", name: "Integer" }, presence: { kind: "clauses", clauses: [{ level: "RECOMMENDED", qualifier: null, condition: null }] }, default: { raw: "0", value: 0 } });
  assert.deepEqual(cell('string; default "USD"').default, { raw: '"USD"', value: "USD" });
  assert.deepEqual(cell("integer array").parsed, { kind: "array", items: { kind: "scalar", name: "Integer" } });
  assert.deepEqual(cell("float").parsed, { kind: "scalar", name: "Number" });
  assert.deepEqual(cell("object array").parsed, { kind: "array", items: { kind: "scalar", name: "Object" } });
  assert.throws(() => cell("bool"), /its base "bool" is none of string, int, integer, float, object/);
  assert.throws(() => cell("string; optional"), /the qualifier "optional" is none of required, recommended, or default/);
  assert.throws(() => cell("int, default x"), /the qualifier "default x"/);
  assert.throws(() => cell("string, required, recommended"), /states presence twice/);
  assert.throws(() => cell("int, default 1, default 2"), /states a default twice/);
  // The row keeps the base as its type, and the whole cell, bold and all, as the text writes it read as text.
  const f = run(objectTable("| `a` | int, **default 2**; **required** | A. |")).fields[0]!;
  assert.deepEqual([f.type.raw, f.type_cell, f.default, f.marker], ["int", "int, default 2; required", { raw: "2", value: 2 }, undefined]);
});

test("a Description cell's `n` = label lines, and a sentence's \"where n = label, n = label\", are value lists of codes with their labels", () => {
  const ir = run(objectTable("| `a` | int | Kinds where:<br> `0` = none<br>  `1` = one, by `x.y`<br>`2` = two<br><br>Codes from 500 up are a vendor's. |\n| `b` | int | Only `0` = none, which is one line. |\n| `c` | int | A flag, where 0 = off, 1 = on. |\n| `d` | int | Where: nothing here = no code. |"));
  const lists = ir.value_lists.map((v) => [v.host, v.items.map((i) => [i.value, i.annotation]), v.context_after]);
  assert.deepEqual(lists, [
    ["field:object-thing:a#description", [["0", "none"], ["1", "one, by `x.y`"], ["2", "two"]], "Codes from 500 up are a vendor's"],
    ["field:object-thing:c#description", [["0", "off"], ["1", "on"]], null],
  ]);
  // A code span inside a label stays a code span; the codes don't.
  assert.deepEqual(ir.code_spans.map((c) => c.value), ["x.y", "0"]);
});

test("a value list that gives one code twice is a finding, as the tag's sellerstatus gives 4 for both complete and archived", () => {
  const ir = run(objectTable("| `s` | int | Status:<br>`0` = on<br>`4` = done<br>`4` = gone |"));
  const f = lint(ir, undefined, { appendices: false, sections: "anchored" }).filter((x) => x.kind === "value_list_duplicate_code");
  assert.deepEqual(f.map((x) => [x.id, x.message]), [["value_list_duplicate_code:field:object-thing:s#description/values:1:4", 'The value list gives `4` 2 times, as "done" and as "gone", so a value of `4` doesn\'t say which it means.']]);
  assert.deepEqual(FINDINGS("main").filter((x) => x.kind === "value_list_duplicate_code"), []);
  assert.deepEqual(FINDINGS("tag-1.0-202602").filter((x) => x.kind === "value_list_duplicate_code").map((x) => x.subjects), [["field:object-deal:sellerstatus#description/values:1"]]);
});

test("both locks extract every row, with the lint's DEAL-1 (tag), DEAL-2, DEAL-10, and 37 rows that state no presence", () => {
  for (const lock of ["main", "tag-1.0-202602"]) {
    const ir = IR(lock);
    const fs = FINDINGS(lock);
    assert.deepEqual([ir.counts.sections, ir.counts.tables, ir.counts.table_rows, ir.counts.fields, ir.counts.concepts, ir.counts.value_lists], [33, 7, 51, 46, 5, 10], lock);
    assert.deepEqual(ir.counts.fields_by_owner, { buyer_seat: 4, buyer_status: 3, curation: 4, deal: 17, inventory: 8, terms: 10 }, lock);
    assert.equal(fs.filter((f) => f.kind === "presence_unstated").reduce((n, f) => n + f.subjects.length, 0), 37, lock);
    // DEAL-2: the guidance writes `curationfee`, which no row names; DEAL-10: `inclinventory.adtype=1,2` names a member `inclinventory` lacks.
    assert.ok(fs.some((f) => f.id === "unresolved_identifier:curationfee"), lock);
    assert.ok(fs.some((f) => f.id === "unresolved_identifier:inclinventory.adtype"), lock);
    // Each anchor is its section's ID, as the text's links name them.
    assert.ok(["object-deal", "terms-object-1", "curation-fee", "receiver-endpoint"].every((id) => ir.sections.some((s) => s.id === id)), lock);
    // An object's attribute names the object another table describes, so only the placeholders `ext` lack a structure.
    assert.deepEqual(fs.filter((f) => f.kind === "object_without_structure").map((f) => f.subjects[0]!.split(":")[1]).sort(), ["object-buyerseat", "object-buyerstatus", "object-curation", "object-deal", "object-inventory", "object-terms"], lock);
  }
  assert.deepEqual(IR("main").fields.find((f) => f.id === "field:object-terms:cur")!.default, { raw: '"USD"', value: "USD" });
});

test("a code span that sets a member to values joined by commas is an expression, so the lint reads its member", () => {
  assert.deepEqual(classifyCode("inclinventory.adtype=1,2"), { kind: "expression", lhs: "inclinventory.adtype", rhs: "1,2" });
  assert.deepEqual(classifyCode("dinventory=1"), { kind: "expression", lhs: "dinventory", rhs: "1" });
  assert.deepEqual(classifyCode("a=1,,2").kind, "other");
});

test("the text's lowercase keywords and \"strongly encouraged\" make statements", () => {
  assert.deepEqual(TEXT.keywords("Implementers are strongly encouraged to discuss."), ["RECOMMENDED"]);
  assert.deepEqual(TEXT.keywords("It is strongly recommended to keep this short."), ["RECOMMENDED"]);
  assert.deepEqual(TEXT.keywords("Receivers are encouraged to poll."), []);
});

test("the Deals API's extraction report lists the counts the committed IR and findings give", () => {
  const file = specReportFile("dealsapi");
  const text = readFileSync(join(REPO_ROOT, file), "utf8");
  assert.equal(renderExtractionReport(text, specReportBlocks(specReportLocks(DEALS), TEXT.layouts), file), text, "run: npm run extraction-report");
  assert.match(text, /\| `attribute` \| Attribute \\\| Type \\\| Description \| 6 \/ 46 \| 6 \/ 46 \|/);
  assert.match(text, /\| Rows that state no presence \(`presence_unstated`\) \| 37 \| 37 \|/);
  assert.match(text, /\| `value_list_duplicate_code` \| 0 \| 1 \|/);
});

test("an anchor on a line of its own is read by its name or id, quoted either way, and fails where it names nothing or sits in a list or a quote", () => {
  for (const a of [`<a name='x'></a>`, `<a id="x"></a>`, `<a name="x" class="y"></a>`, `<a name=x></a>`]) assert.equal(run(`# T\n\n${a}\n## H\n`).sections[1]!.id, "x", a);
  assert.throws(() => run('# T\n\n<a class="y"></a>\n## H\n'), /an anchor on its own line, <a class="y">, names nothing; it needs one name or id/);
  assert.throws(() => run('# T\n\n<a name="x" id="y"></a>\n## H\n'), /names itself 2 times/);
  assert.throws(() => run('# T\n\n- <a name="x"></a>\n\n## H\n'), /the anchor "x" on its own line sits inside a list or a quote/);
  assert.throws(() => run('# T\n\n> <a name="x"></a>\n\n## H\n'), /the anchor "x" on its own line sits inside a list or a quote/);
});

test("a Type cell's default is a value of its base, and a cell with a code span or a link fails", () => {
  assert.throws(() => parseTypeCell('int; default "USD"', 1), /the default "USD" is no value of int/);
  assert.throws(() => parseTypeCell("object, default 3", 1), /the default 3 is no value of object/);
  assert.throws(() => parseTypeCell("int, default 2.5", 1), /the default 2.5 is no value of int/);
  assert.throws(() => parseTypeCell("string array, default \"x\"", 1), /is no value of string array/);
  assert.equal(parseTypeCell("float, default 2.5", 1).default?.value, 2.5);
  assert.throws(() => run(objectTable("| `a` | `string`; required | A. |")), /the Type cell "`string`; required" holds a code span, a link, or HTML/);
  assert.throws(() => run(objectTable("| `a` | [string](#x) | A. |")), /holds a code span, a link, or HTML/);
});

test("a value list may start after a lead that ends in a colon, a prose label may hold an abbreviation, and a sentence goes on past i.e.", () => {
  const ir = run(objectTable("| `a` | int | Kinds: `0` = a<br>`1` = b<br>`2` = c |\n| `b` | int | A flag, where 0 = no, 2 = e.g. both. Then more. |\n| `c` | string | It must match (i.e. OpenRTB requests) as written. |"));
  assert.deepEqual(ir.value_lists.map((v) => v.items.map((i) => [i.value, i.annotation])), [[["0", "a"], ["1", "b"], ["2", "c"]], [["0", "no"], ["2", "e.g. both"]]]);
  assert.deepEqual(ir.statements.map((s) => s.text), ["It must match (i.e. OpenRTB requests) as written."]);
  assert.ok(IR("main").statements.some((s) => s.text.includes("(i.e. OpenRTB bid requests) in the field specified")));
});

test("a code span that sets a member to several values is checked value by value, and a path through an owner resolves", () => {
  const md = objectTable("| `a` | int | Kinds:<br>`1` = one<br>`2` = two |\n| `b` | string | Set `a=1,2`, or `a=1,3`, as `thing.a` says. |");
  const fs = lint(run(md), undefined, { appendices: false, sections: "anchored" });
  assert.deepEqual(fs.filter((f) => f.kind === "expression_value_unknown").map((f) => f.id), ["expression_value_unknown:a=1,3"]);
  assert.deepEqual(fs.filter((f) => f.kind === "unresolved_identifier").map((f) => f.id), []);
  assert.ok(!FINDINGS("main").some((f) => f.id === "unresolved_identifier:deal.id"), "`deal.id` names Object: Deal's `id`");
});

test("the profile's documents are the text's objects that no attribute holds, and every other object is held", () => {
  const ir = IR("main");
  const docs = specOf(DEALS).profile.documents!;
  assert.doesNotThrow(() => checkDocuments(ir, docs));
  assert.throws(() => checkDocuments(ir, docs.slice(0, 1)), /the rows of "buyer_seat" are no document the profile names, and no attribute of another object holds them/);
  assert.throws(() => checkDocuments(ir, [...docs, { owner: "terms", document: "Terms", section: "object-terms" }]), /names "terms" a document, and an attribute of another object holds it/);
  assert.throws(() => checkDocuments(ir, [{ ...docs[0]!, section: "object-terms" }, docs[1]!]), /names the document Deal at the section "object-terms", which describes the object Terms/);
});

// ----- Mapping and model (P3.4) -----

/** A lock's model, as the pipeline builds it. */
async function modelOf(lock: "main" | "tag-1.0-202602") {
  const { resolveBuild } = await import("../src/builds.ts");
  const { loadKernel } = await import("../src/kernel.ts");
  const { loadConstructors } = await import("../src/constructors.ts");
  const { loadDecisions, loadMappings } = await import("../src/mapping.ts");
  const { loadLock } = await import("../src/lock.ts");
  const file = lock === "main" ? "spec-lock.yaml" : `${lock}.lock.yaml`;
  return resolveBuild({ root: DEALS, mappings: loadMappings(join(DEALS, "mapping")), decisions: loadDecisions(join(DEALS, "decisions")), kernel: loadKernel(REPO_ROOT, DEALS), constructors: loadConstructors(REPO_ROOT, DEALS), lock: loadLock(join(DEALS, "spec-input", file)) });
}

test("the Deals API's two documents are its unheld objects, and each object an attribute holds is a closed object named by its heading", async () => {
  const model = (await modelOf("main")).model!;
  const kinds = Object.fromEntries(model.types.filter((t) => ["document", "object"].includes(t.kind)).map((t) => [t.name, t.kind === "object" ? `object${t.open ? " open" : ""}` : t.kind]));
  assert.deepEqual(kinds, { BuyerSeat: "document", BuyerStatus: "object", Curation: "object", Deal: "document", Inventory: "object", Terms: "object" });
  const prop = (t: string, p: string) => (model.types.find((x) => x.name === t) as { properties: Record<string, { type: unknown; presence: string; default?: unknown }> }).properties[p]!;
  assert.deepEqual(prop("Deal", "terms").type, { kind: "named", name: "Terms" });
  assert.deepEqual(prop("BuyerSeat", "buyerstatus").type, { kind: "apply", constructor: "List", arguments: { T: { kind: "named", name: "BuyerStatus" } } });
  // Presence and defaults from the Type cells.
  assert.deepEqual(["id", "origin", "terms", "name", "sellerstatus"].map((p) => prop("Deal", p).presence), ["required", "required", "required", "optional", "optional"]);
  assert.deepEqual([prop("Deal", "sellerstatus").default, prop("Terms", "cur").default, prop("Terms", "pricetype").default], [0, "USD", 2]);
  // Each `ext` is the open Ext, and `guar` the shared integer flag.
  for (const t of ["Deal", "Terms", "Inventory", "Curation", "BuyerSeat", "BuyerStatus"]) assert.deepEqual(prop(t, "ext").type, { kind: "named", name: "Ext" }, t);
  assert.deepEqual(prop("Terms", "guar").type, { kind: "named", name: "IntegerFlag" });
  // A currency with a stated default satisfies the money beside it.
  const terms = model.types.find((t) => t.name === "Terms") as { dependent_required?: Record<string, string[]> };
  assert.equal(terms.dependent_required, undefined);
  // AdCOM's lists, by reference to the registry.
  assert.deepEqual(prop("Inventory", "devicetype").type, { kind: "apply", constructor: "List", arguments: { T: { kind: "named", name: "DeviceType" } } });
  const devicetype = model.types.find((t) => t.name === "DeviceType") as { list?: { registry?: unknown } };
  assert.ok(devicetype.list?.registry, "DeviceType is the registry's");
});

test("each own code list is a labeled vocabulary named by its meaning, pricetype open to exchanges' codes from 500, and the tag's code 4 holds both meanings", async () => {
  const main = (await modelOf("main")).model!;
  const tag = (await modelOf("tag-1.0-202602")).model!;
  const vocab = (m: typeof main, n: string) => m.types.find((t) => t.name === n) as { terms: { value: number; annotation?: string }[]; open: boolean; labeled?: boolean; vendor?: { from: number; label: string } };
  const names = ["SellerDealStatus", "AdType", "AuxiliaryData", "PublisherCount", "DynamicInventory", "PriceType", "IncludedInventory", "CurationFeeType", "BuyerDealStatus"];
  for (const n of names) assert.equal(vocab(main, n).labeled, true, n);
  // Lists with the same codes and different labels are different lists.
  assert.deepEqual(vocab(main, "PublisherCount").terms.map((x) => x.value), vocab(main, "DynamicInventory").terms.map((x) => x.value));
  assert.deepEqual([vocab(main, "PriceType").open, vocab(main, "PriceType").vendor], [true, { from: 500, label: "Exchange-specific auction types" }]);
  assert.deepEqual(vocab(main, "SellerDealStatus").terms.map((x) => x.value), [0, 1, 2, 3, 4]);
  const four = vocab(tag, "SellerDealStatus").terms;
  assert.deepEqual(four.map((x) => x.value), [0, 1, 2, 4]);
  assert.match(four.at(-1)!.annotation!, /^deal is complete .*, or deal is archived \(cannot be active again\)$/);
});

test("the scenario rows are examples of a deal, and the mapping cites each rule the Deals API added", async () => {
  const { loadMappings } = await import("../src/mapping.ts");
  const guidance = loadMappings(join(DEALS, "mapping")).find((m) => m.module === "guidance")!;
  assert.deepEqual(guidance.entries.filter((e) => e.ir.startsWith("concept:")).map((e) => [e.ir, e.as]), [1, 2, 3, 4, 5].map((n) => [`concept:example-scenarios:${n}`, { role: "example", object: "Deal", columns: { curationfee: "curation.curfeetype" } }]));
  const rules = new Set(loadMappings(join(DEALS, "mapping")).flatMap((m) => [...m.entries.map((e) => ("rule" in e.source ? e.source.rule : null)), ...(m.types ?? []).map((t) => ("rule" in t.source ? t.source.rule : null))]));
  for (const r of ["document-owner", "held-object", "held-object-field", "domain-row", "enum-row", "restated-value-list"]) assert.ok(rules.has(r), r);
});

/** The Deals API's mapping, kernel, and constructors on a lock, for the checks a test mutates. */
async function inputsOf(lock: "main" | "tag-1.0-202602") {
  const { loadKernel } = await import("../src/kernel.ts");
  const { loadConstructors } = await import("../src/constructors.ts");
  const { loadDecisions, loadMappings } = await import("../src/mapping.ts");
  const { loadLock } = await import("../src/lock.ts");
  const file = lock === "main" ? "spec-lock.yaml" : `${lock}.lock.yaml`;
  return { ir: IR(lock), lock: loadLock(join(DEALS, "spec-input", file)), mappings: loadMappings(join(DEALS, "mapping")), decisions: loadDecisions(join(DEALS, "decisions")), kernel: loadKernel(REPO_ROOT, DEALS), constructors: loadConstructors(REPO_ROOT, DEALS) };
}

test("a labeled list restates a primitive's codes only where its labels are the titles or the binding cites its row, so the codes alone make no flag", async () => {
  const { checkCoverage } = await import("../src/coverage.ts");
  const i = await inputsOf("main");
  const list = "field:object-deal:dinventory#description/values:1";
  // `dinventory`'s list cut to 0 and 1, read as the integer flag's codes, with the labels it is given.
  const run = (labels: [string, string]) => {
    const ir = { ...i.ir, value_lists: i.ir.value_lists.map((v) => (v.id === list ? { ...v, items: [{ value: "0", annotation: labels[0] === "" ? null : labels[0] }, { value: "1", annotation: labels[1] === "" ? null : labels[1] }] } : v)) };
    const mappings = i.mappings.map((m) => ({ ...m, entries: m.entries.map((e) => (e.ir === list ? { ...e, source: { rule: "restated-value-list" }, as: { role: "schema" as const, in: "IntegerFlag" } } : e)) }));
    return checkCoverage(ir, "main", mappings, i.kernel, i.constructors).rules.filter((p) => p.includes(`entry "${list}"`));
  };
  assert.match(run(["undisclosed", "single publisher"]).join("\n"), /cites rule "restated-value-list", but no mapping rule applies/);
  assert.deepEqual(run(["No", "yes"]), []);
  // `guar`'s labels aren't the titles, and the binding cites its row for the integer flag's concept, so it restates the flag;
  // with the binding's citation gone, it doesn't.
  const guarList = "field:object-terms:guar#description/values:1";
  const guar = i.mappings.flatMap((m) => m.entries).find((e) => e.ir === guarList)!;
  assert.deepEqual([guar.source, guar.as], [{ rule: "restated-value-list" }, { role: "schema", in: "IntegerFlag" }]);
  const guarProblems = (kernel: typeof i.kernel) => checkCoverage(i.ir, "main", i.mappings, kernel, i.constructors).rules.filter((p) => p.includes(`entry "${guarList}"`));
  assert.deepEqual(guarProblems(i.kernel), []);
  const unbound = { ...i.kernel, domains: { ...i.kernel.domains!, domains: i.kernel.domains!.domains.map((d) => ({ ...d, concepts: d.concepts.map((c) => (c.name === "integer-flag" ? { ...c, sources: { ...c.sources, spec: (c.sources.spec ?? []).filter((x) => x.ir !== "field:object-terms:guar") } } : c)) })) } };
  assert.match(guarProblems(unbound).join("\n"), /cites rule "restated-value-list", but no mapping rule applies/);
  // A list that labels one code of two is read by its labels too.
  assert.match(run(["", "single publisher"]).join("\n"), /no mapping rule applies/);
});

test("an attribute holds another object's rows only where it is an object or a list of objects, never a union with another type", async () => {
  const { heldOwnerOf } = await import("../src/owners.ts");
  const ir = IR("main");
  const terms = ir.fields.find((f) => f.id === "field:object-deal:terms")!;
  const status = ir.fields.find((f) => f.id === "field:object-buyerseat:buyerstatus")!;
  assert.deepEqual([heldOwnerOf(ir, terms), heldOwnerOf(ir, status)], ["terms", "buyer_status"]);
  const union = { ...terms, type: { ...terms.type, parsed: { kind: "union" as const, members: [{ kind: "scalar" as const, name: "String" }, { kind: "scalar" as const, name: "Object" }] } } };
  assert.equal(heldOwnerOf(ir, union), null);
  const strings = { ...status, type: { ...status.type, parsed: { kind: "array" as const, items: { kind: "scalar" as const, name: "String" } } } };
  assert.equal(heldOwnerOf(ir, strings), null);
});

test("an own list's vendor range starts where VendorCode does and makes the vocabulary open, from a type entry as from a declaration", async () => {
  const { resolveModel } = await import("../src/model.ts");
  const i = await inputsOf("main");
  const priceType = (m: (as: Record<string, unknown>) => Record<string, unknown>) =>
    resolveModel({ ir: i.ir, lock: "main", mappings: i.mappings.map((f) => ({ ...f, entries: f.entries.map((e) => (e.as.role === "type" && e.as.name === "PriceType" ? { ...e, as: m(e.as as Record<string, unknown>) as typeof e.as } : e)) })), decisions: i.decisions, kernel: i.kernel, constructors: i.constructors }).problems;
  assert.deepEqual(priceType((as) => as), []);
  assert.ok(priceType((as) => ({ ...as, vendor: { from: 1000, label: "Exchange-specific auction types" } })).some((p) => /reserves vendor codes from 1000, but VendorCode starts at 500/.test(p)));
  assert.ok(priceType((as) => ({ ...as, open: false })).some((p) => /has a vendor range, so it is open/.test(p)));
});

test("only a lock name may hold a dot: a module, a rule, an option, a concept, and a variant keep the hyphen-only token", async () => {
  const { compileSchema } = await import("../src/pipeline.ts");
  const at = (f: string) => join(REPO_ROOT, f);
  const vectors = compileSchema(at("vectors/vectors.schema.json"));
  const entry = { rule: "rule:object-deal:5e652de0", digest: "0".repeat(64), valid: [{ value: {} }], invalid: [{ value: {} }] };
  assert.deepEqual(vectors({ format: 1, module: "deal", rules: [{ ...entry, locks: ["tag-1.0-202602"] }] }), []);
  assert.ok(vectors({ format: 1, module: "deal.v1", rules: [entry] }).length > 0);
  const kernel = JSON.parse(readFileSync(at("kernel/kernel.schema.json"), "utf8")) as { $defs: Record<string, { pattern?: string }> };
  const mapping = JSON.parse(readFileSync(at("mapping/mapping.schema.json"), "utf8")) as { $defs: Record<string, { pattern?: string }> };
  const decision = JSON.parse(readFileSync(at("decisions/decision.schema.json"), "utf8")) as { $defs: Record<string, { pattern?: string }> };
  const variant = JSON.parse(readFileSync(at("variants/variant.schema.json"), "utf8")) as { properties: { name: { pattern: string } } };
  for (const p of [kernel.$defs.conceptName!.pattern, mapping.$defs.module!.pattern, mapping.$defs.token!.pattern, decision.$defs.token!.pattern, variant.properties.name.pattern]) {
    assert.equal(new RegExp(p!).test("a.b"), false, p);
    assert.equal(new RegExp(p!).test("a-b"), true, p);
  }
});

// ----- Schemas, rules, and vectors (P3.5) -----

test("the Deals API's rule checks count characters, read the deal as context, and leave undecided what a part of a deal leaves out", async () => {
  const { RULE_CHECKS } = await import("../src/specs/dealsapi/rule-checks.ts");
  const run = (id: string, v: unknown, ctx: { part?: boolean; context?: Record<string, unknown> } = {}) => RULE_CHECKS[id]!(v, { part: ctx.part ?? false, context: ctx.context ?? {} });
  const deal = { id: "d-1", origin: "examplessp.com", terms: {} };
  // 250 characters outside the Basic Multilingual Plane are 500 UTF-16 units, and still 250 characters; one more breaks the
  // should-level limit.
  assert.deepEqual(run("rule:object-deal:5e652de0", { ...deal, desc: "😀".repeat(250) }), []);
  assert.equal(run("rule:object-deal:5e652de0", { ...deal, desc: "😀".repeat(251) })!.length, 1);
  assert.deepEqual(run("rule:object-inventory:2b2c54b3", { sellerids: ["😀".repeat(64)] }), []);
  // `inventory` with no `dinventory` breaks the rule in a whole deal, and is undecided in a part that leaves `dinventory` out.
  assert.deepEqual(run("rule:object-deal:1ff4e5fa", { ...deal, inventory: {} })!.map((x) => x.path), ["/inventory"]);
  assert.equal(run("rule:object-deal:1ff4e5fa", { inventory: {} }, { part: true }), null);
  // A guaranteed deal's terms: terms that send `units` keep the rule, a part with neither `units` nor `guar` can't say, and
  // `guar` 1 with no `units` breaks it, in a part too.
  assert.deepEqual(run("rule:object-terms:ab3aa10d", { units: 10 }, { part: true }), []);
  assert.equal(run("rule:object-terms:ab3aa10d", { totalcost: 10 }, { part: true }), null);
  assert.equal(run("rule:object-terms:ab3aa10d", { guar: 1 })!.length, 1);
  assert.equal(run("rule:object-terms:ab3aa10d", { guar: 1 }, { part: true })!.length, 1);
  // A missing `pricetype` is its default, 2, so no fixed price; 3 with no `dealfloor` breaks the must-level rule, in a part
  // too; terms that send `dealfloor` keep it; a part with neither can't say.
  assert.deepEqual(run("rule:terms-object-1:647b6593", {}), []);
  assert.equal(run("rule:terms-object-1:647b6593", { pricetype: 3 })!.length, 1);
  assert.equal(run("rule:terms-object-1:647b6593", { pricetype: 3 }, { part: true })!.length, 1);
  assert.deepEqual(run("rule:terms-object-1:647b6593", { dealfloor: 2 }, { part: true }), []);
  assert.equal(run("rule:terms-object-1:647b6593", { guar: 1 }, { part: true }), null);
  // The status response's `id` against the pushed deal's, which only the context holds.
  assert.equal(run("rule:object-buyerseat:be619ed4", { id: "d-1", version: "1.0" }), null);
  assert.deepEqual(run("rule:object-buyerseat:be619ed4", { id: "d-2", version: "1.0" }, { context: { "Deal.id": "d-1" } })!.map((x) => x.path), ["/id"]);
});

test("the fidelity oracle reads each Type cell's presence, type, and default, and each Description cell's codes, on both locks", async () => {
  const { FIDELITY } = await import("../src/specs/dealsapi/fidelity-readers.ts");
  for (const lock of ["main", "tag-1.0-202602"]) {
    const { constraints, unread } = FIDELITY.readConstraints(IR(lock));
    const forms = constraints.reduce<Record<string, number>>((n, c) => ({ ...n, [c.form]: (n[c.form] ?? 0) + 1 }), {});
    // Every row's presence, its bare cell's included, its type, and its default or none; six rows say what an empty list means.
    assert.deepEqual(forms, { required: 5, optional: 41, type: 46, values: 10, default: 46, empty: 6 }, lock);
    const at = (id: string) => constraints.find((c) => c.id === id) as { values?: unknown[]; vendor?: number; value?: unknown } | undefined;
    assert.deepEqual([at("field:object-terms:pricetype#default@terms.pricetype")?.value, at("field:object-terms:cur#default@terms.cur")?.value, at("field:object-deal:sellerstatus#default@deal.sellerstatus")?.value], [2, "USD", 0]);
    assert.equal(at("field:object-terms:pricetype#description/values:1#values@terms.pricetype")?.vendor, 500);
    // The tag writes code 4 twice, which is one value.
    assert.deepEqual(at("field:object-deal:sellerstatus#description/values:1#values@deal.sellerstatus")?.values, lock === "main" ? [0, 1, 2, 3, 4] : [0, 1, 2, 4]);
    assert.deepEqual([...new Set(unread.map((u) => u.form))].sort(), ["a list of another specification, whose codes the registry-agreement gate checks", "a scenario row, which the examples read as part of a deal"]);
  }
});

// ----- Examples, corpus, type examples, and the round trip (P3.6) -----

test("each scenario row is part of a deal, its curationfee column read as curation.curfeetype, on both locks", async () => {
  const want = [
    { auxdata: 3, curation: { curfeetype: 4 }, dinventory: 1, pubcount: 1 },
    { auxdata: 1, curation: { curfeetype: 4 }, dinventory: 2, pubcount: 2 },
    { auxdata: 2, curation: { curfeetype: 3 }, dinventory: 2, pubcount: 2 },
    { auxdata: 4, curation: { curfeetype: 1 }, dinventory: 2, pubcount: 1 },
    { auxdata: 2, curation: { curfeetype: 3 }, dinventory: 2, pubcount: 2 },
  ];
  for (const lock of ["main", "tag-1.0-202602"] as const) {
    const model = (await modelOf(lock)).model!;
    assert.deepEqual(model.examples.map((x) => [x.ir, x.object, JSON.parse(x.text)]), want.map((v, n) => [`concept:example-scenarios:${n + 1}`, "Deal", v]), lock);
  }
});

test("the attribute tables render from the model, each code list from its vocabulary, and differ only where D-018 and D-033 say", async () => {
  const { roundTrip, loadDifferences, DIFFERENCES_FILE } = await import("../src/render.ts");
  const { ROUND_TRIP } = await import("../src/specs/dealsapi/render.ts");
  const recorded = loadDifferences(join(DEALS, DIFFERENCES_FILE));
  for (const lock of ["main", "tag-1.0-202602"] as const) {
    const rt = roundTrip((await modelOf(lock)).model!, IR(lock), ROUND_TRIP);
    assert.deepEqual(rt.problems, [], lock);
    assert.equal(rt.model.reduce((n, t) => n + t.rows.length, 0), 46);
    // Every difference is a recorded one, by its cell and its text.
    const key = (d: { table: string; row: string; column: string; spec: string; model: string }) => [d.table, d.row, d.column, d.spec, d.model].join("|");
    assert.deepEqual(rt.differences.map(key).sort(), recorded.differences.map(key).sort(), lock);
    // The tag's code 4, given twice, renders once per meaning, as the text writes it.
    const status = rt.model.flatMap((t) => t.rows).find((r) => r.row === "field:object-deal:sellerstatus")!;
    assert.match(status.cells[2]!, lock === "main" ? /`3` = deal is complete .*`4` = deal is archived/ : /`4` = deal is complete .*`4` = deal is archived/);
  }
  assert.deepEqual([...new Set(recorded.differences.map((d) => d.decision))].sort(), ["D-018", "D-033"]);
});

// ----- The as-written variant (P3.7) -----

test("the as-written variant switches D-004 off on both locks: each of a deal's countries is any string, compared as written, with no ISO 3166-1 check", async () => {
  const { loadVariant } = await import("../src/variant.ts");
  const { resolveBuild } = await import("../src/builds.ts");
  for (const lock of ["main", "tag-1.0-202602"] as const) {
  const i = await inputsOf(lock);
  const variant = loadVariant(DEALS);
  const written = resolveBuild({ root: DEALS, mappings: i.mappings, decisions: i.decisions, kernel: i.kernel, constructors: i.constructors, lock: i.lock, variant }).model!;
  const proposed = (await modelOf(lock)).model!;
  const countries = (m: typeof written) => (m.types.find((t) => t.name === "Terms") as { properties: Record<string, { type: unknown }> }).properties.countries!.type;
  assert.deepEqual(countries(proposed), { kind: "apply", constructor: "List", arguments: { T: { kind: "named", name: "CountryCode" } } });
  assert.deepEqual(countries(written), { kind: "apply", constructor: "List", arguments: { T: { kind: "named", name: "ExternalId" } } });
  assert.ok(!written.types.some((t) => t.name === "CountryCode"));
  assert.ok(!written.kernel_rules.some((r) => r.id === "kernel:CountryCode:assigned"));
  assert.ok(proposed.kernel_rules.some((r) => r.id === "kernel:CountryCode:assigned"));
  assert.deepEqual(variant.switches.map((s) => [s.decision, s.option]), [["D-004", "as-written"]]);
  }
});
