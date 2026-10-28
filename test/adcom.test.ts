import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extract } from "../src/extract.ts";
import { readHtmlTable } from "../src/html-table.ts";
import type { InputRecord, SpecIR } from "../src/ir-types.ts";
import { lint } from "../src/lint.ts";
import { parseMarkdown, tokenize } from "../src/markdown.ts";
import { specOf } from "../src/specs/index.ts";
import { specRoot } from "../src/repo.ts";
import type { PhrasingContent } from "mdast";

const ADCOM = specRoot("adcom");
const TEXT = specOf(ADCOM).plugin!.text;
const INPUT: InputRecord = { name: "t", upstream: "u", commit: "c".repeat(40), path: "p.md", blob: "b".repeat(40), base: null, merge_order: null, sha256: "0".repeat(64), bytes: 0 };
const run = (md: string): SpecIR => extract(md, INPUT, TEXT);
const IR = JSON.parse(readFileSync(join(ADCOM, "ir", "spec-ir.json"), "utf8")) as SpecIR;
const TAG = JSON.parse(readFileSync(join(ADCOM, "ir", "tag-202607", "spec-ir.json"), "utf8")) as SpecIR;

/** The model of AdCOM's default lock, as the pipeline builds it. */
async function mainBuild() {
  const { resolveBuild } = await import("../src/builds.ts");
  const { loadKernel } = await import("../src/kernel.ts");
  const { loadConstructors } = await import("../src/constructors.ts");
  const { loadDecisions, loadMappings } = await import("../src/mapping.ts");
  const { loadLock } = await import("../src/lock.ts");
  const { REPO_ROOT } = await import("../src/repo.ts");
  return resolveBuild({ root: ADCOM, mappings: loadMappings(join(ADCOM, "mapping")), decisions: loadDecisions(join(ADCOM, "decisions")), kernel: loadKernel(REPO_ROOT, ADCOM), constructors: loadConstructors(REPO_ROOT, ADCOM), lock: loadLock(join(ADCOM, "spec-input", "spec-lock.yaml")) });
}

const doc = (body: string) => `# **Title**\n\n# SPECIFICATION <a name="spec"></a>\n\n### List:  Things <a name="list_things"></a>\n\nThe codes.\n\n${body}\n`;
const table = (rows: string) => `<table>\n  <tr>\n    <td><strong>Value</strong></td>\n    <td><strong>Definition</strong></td>\n  </tr>\n${rows}\n</table>`;

test("an HTML table reads as rows of cells, each keeping its source bytes, with its tags read as markdown would write them", () => {
  const md = table('  <tr>\n    <td>1</td>\n    <td>One with <code>x</code>, <b>bold</b>, <a href="#y">a link</a><br/>and a break &amp; an entity</td>\n  </tr>');
  const t = readHtmlTable(md, 0, md.length);
  assert.equal(t.children.length, 2);
  const cell = t.children[1]!.children[1]!;
  assert.equal(md.slice(cell.position!.start.offset!, cell.position!.end.offset!).startsWith("<td>One with"), true);
  assert.deepEqual(cell.children.map((c: PhrasingContent) => c.type), ["text", "inlineCode", "text", "strong", "text", "link", "break", "text"]);
  assert.equal(tokenize(cell.children).map((x) => x.value).join(""), "One with x, bold, a link\nand a break & an entity");
});

test("an HTML table holds only the tags a table and its cells use; any other fails extraction", () => {
  assert.throws(() => run(doc(table('  <tr>\n    <td>1</td>\n    <td>One <span>x</span></td>\n  </tr>'))), /unsupported HTML tag <span> in a table cell/);
  assert.throws(() => run(doc(table('  <tbody><tr>\n    <td>1</td>\n    <td>One</td>\n  </tr></tbody>'))), /unsupported HTML tag <tbody> in a table/);
  assert.throws(() => run(doc(table('  <tr>\n    <td>1</td>\n    <td>One <code>x</td>\n  </tr>'))), /a <code> in a table cell with no <\/code>/);
  assert.throws(() => run(doc("<table>\n  <tr><td>1</td><td>x</td></tr>")), /no <\/table>/);
  assert.throws(() => run(doc("<div>x</div>")), /unsupported raw HTML block/);
});

test("an HTML table reads as a browser shows it: a stray </tr> is skipped, a cell with no <tr> opens a row, a blank line doesn't split it, and a cell's end closes its bold", () => {
  const ir = run(doc(table('  <tr>\n    <td>1</td>\n    <td>One</td>\n  </tr>\n  </tr>\n\n  <td>2</td>\n    <td><b>Two, still bold</td>\n  </tr>')));
  assert.deepEqual(ir.definitions.map((d) => [d.id, d.columns[0]!.text]), [["def:list_things:1", "One"], ["def:list_things:2", "Two, still bold"]]);
});

test("inline HTML in prose and headings reads as text, code, and bold; any other tag fails", () => {
  const p = (md: string) => tokenize((parseMarkdown(md).children[0] as { children: PhrasingContent[] }).children);
  assert.deepEqual(p("Use <code>plcmt</code> in <strong>Video</strong>.<br/>Next").map((t) => [t.kind, t.value, t.strong]), [["text", "Use ", false], ["code", "plcmt", false], ["text", " in ", false], ["text", "Video", true], ["text", ".", false], ["text", "\n", false], ["text", "Next", false]]);
  assert.throws(() => p("A <span>x</span>"), /unsupported inline HTML "<span>"/);
  assert.throws(() => p("A <code>x"), /an HTML <code> with no <\/code>/);
});

test("a heading's own anchor is its section's ID, and the body starts at the SPECIFICATION part", () => {
  const ir = run(doc(table('  <tr>\n    <td>500+</td>\n    <td>Vendor-specific codes.</td>\n  </tr>')));
  assert.deepEqual(ir.sections.map((s) => [s.id, s.part, s.title]), [["front", "front", "Title"], ["spec", "body", "SPECIFICATION"], ["list_things", "body", "List: Things"]]);
  assert.equal(ir.definitions[0]!.id, "def:list_things:500+");
});

test("AdCOM extracts every list and object: 44 List: sections, 42 with a table of codes, every row parsed, and the same codes on both locks", () => {
  const lists = IR.sections.filter((s) => s.title.startsWith("List:"));
  assert.equal(lists.length, 44);
  assert.equal(new Set(IR.definitions.map((d) => d.loc.section)).size, 42);
  assert.equal(IR.counts.table_rows, IR.keys.length + IR.definitions.length + IR.concepts.length);
  assert.equal(IR.sections.filter((s) => /^(Object|Abstract Class):/.test(s.title)).length, 46);
  assert.equal(IR.tables.filter((t) => t.layout.endsWith("-object")).length, 46);
  assert.deepEqual(TAG.definitions, IR.definitions);
  // The indented heading is a heading, so its codes are its own list's, not the deprecated list's above it.
  assert.ok(IR.definitions.some((d) => d.id === "def:list_plcmtsubtypesvideo:9"));
  assert.ok(!IR.definitions.some((d) => d.loc.section === "list_placementsubtypesvideo"));
});

test("AdCOM's lint reports the anchor typo, the unprefixed anchor, and the lists with no codes, and no appendix or section number it never writes", () => {
  const kinds = lint(IR, TEXT.lint, { appendices: false, numbered: false }).map((f) => f.id);
  for (const id of ["section_anchor_irregular:list_doohmultipliermeasurementmourcetypes", "section_anchor_irregular:user-agent_source", "list_without_codes:list_doohvenuetypes", "list_without_codes:list_placementsubtypesvideo"]) assert.ok(kinds.includes(id), id);
  assert.ok(!kinds.some((k) => /^(appendix_|unnumbered_heading)/.test(k)));
  // An object its heading names resolves, as `Ad` does; a name in another case, `device.ua`, doesn't.
  assert.ok(!kinds.includes("unresolved_identifier:Ad"));
  assert.ok(kinds.includes("unresolved_identifier:device.ua"));
});

test("an anchor whose href has no quotes reads as its text, as GitHub shows it, and markup the parser leaves as text fails", () => {
  const p = (md: string) => tokenize((parseMarkdown(md).children[0] as { children: PhrasingContent[] }).children);
  assert.equal(p("See the <a href=https://example.com/a#710---x>implementation guide</a> for more.").map((t) => t.value).join(""), "See the implementation guide for more.");
  assert.throws(() => p("A \\<span x=1> tag"), /an HTML tag the Markdown parser left as text/);
  assert.throws(() => p("A <code>a<code>b</code>"), /HTML "<code>" inside an HTML <code>/);
  assert.throws(() => p("A b</b> c"), /a <\/b> with no <b> before it/);
});

test("an HTML table cell fails on markup or a character reference the reader doesn't know, and on a tag inside a code span", () => {
  const cell = (inner: string) => run(doc(table(`  <tr>\n    <td>1</td>\n    <td>${inner}</td>\n  </tr>`)));
  assert.throws(() => cell("One <!-- hidden --> visible"), /markup "<!-- hidden -->/);
  assert.throws(() => cell("Caf&eacute;"), /the character reference "&eacute;", which the reader doesn't know/);
  assert.throws(() => cell("A &#99999999; B"), /names no character/);
  assert.throws(() => cell("<code>a<br>b</code>"), /a <br> inside a <code> in a table cell/);
  assert.equal(cell("A &amp; B &#38; C&nbsp;D").definitions[0]!.columns[0]!.text, "A & B & C D");
});

test("every AdCOM object table names its object, and the lint reports each anchor that departs from the pattern, with how", () => {
  for (const t of IR.tables.filter((x) => x.layout.endsWith("-object"))) assert.ok(t.parent?.identifier, t.id);
  assert.ok(IR.keys.some((k) => k.id === "key:object_eids:ExtendedIdentifiers.source"));
  const found = lint(IR, TEXT.lint, { appendices: false, numbered: false }).filter((f) => f.kind === "section_anchor_irregular");
  const reasons = Object.fromEntries(found.map((f) => [f.subjects[0], (f.details as { reason: string }).reason]));
  assert.deepEqual(reasons, { list_doohmultipliermeasurementmourcetypes: "spelling", list_idmatchmethod: "spelling", list_poddedupe: "abbreviation", object_eid_uids: "abbreviation", object_eids: "abbreviation", "user-agent_source": "prefix" });
  const missing = run(`# **T**\n\n# SPECIFICATION <a name="spec"></a>\n\n### List:  Things\n\nNo anchor.\n`);
  assert.match(lint(missing, TEXT.lint, { appendices: false, numbered: false }).map((f) => f.message).join("\n"), /List: Things writes no anchor of its own/);
});

test("a list's vocabulary is its title in PascalCase with its head noun in the singular, so every name follows from the title alone", async () => {
  const { vocabularyOfList } = await import("../src/mapping-rules.ts");
  const names: [string, string][] = [["Device Types", "DeviceType"], ["API Frameworks", "ApiFramework"], ["Plcmt Subtypes - Video", "PlcmtSubtypeVideo"], ["Creative Subtypes - Audio/Video", "CreativeSubtypeAudioVideo"], ["Slot Position in Pod", "SlotPositionInPod"], ["User-Agent Source", "UserAgentSource"], ["Category Taxonomies", "CategoryTaxonomy"], ["DOOH Multiplier Measurement Source Types", "DoohMultiplierMeasurementSourceType"], ["Production Qualities", "ProductionQuality"], ["Pod Sequence", "PodSequence"]];
  for (const [title, name] of names) assert.equal(vocabularyOfList(title), name, title);
});

test("AdCOM's model holds one vocabulary per list with codes, each term labeled by its row, open to vendors' codes where a 500+ row reserves them, and the same on both locks", async () => {
  const { resolveBuild } = await import("../src/builds.ts");
  const { loadKernel } = await import("../src/kernel.ts");
  const { loadConstructors } = await import("../src/constructors.ts");
  const { loadDecisions, loadMappings } = await import("../src/mapping.ts");
  const { loadLock } = await import("../src/lock.ts");
  const { REPO_ROOT } = await import("../src/repo.ts");
  const input = { root: ADCOM, mappings: loadMappings(join(ADCOM, "mapping")), decisions: loadDecisions(join(ADCOM, "decisions")), kernel: loadKernel(REPO_ROOT, ADCOM), constructors: loadConstructors(REPO_ROOT, ADCOM) };
  const [main, tag] = ["spec-lock.yaml", "tag-202607.lock.yaml"].map((f) => resolveBuild({ ...input, lock: loadLock(join(ADCOM, "spec-input", f)) }));
  for (const b of [main!, tag!]) assert.deepEqual(b.problems, []);
  const vocab = (name: string) => main!.model.types.find((t) => t.name === name) as { kind: string; open: boolean; terms: { value: unknown; annotation?: string }[]; vendor?: { from: number }; extension?: string };
  const vocabularies = main!.model.types.filter((t) => t.kind === "vocabulary");
  assert.equal(vocabularies.length, 42);
  assert.deepEqual(vocab("DeviceType").terms.slice(0, 3).map((t) => [t.value, t.annotation]), [[1, "Mobile/Tablet - General"], [2, "Personal Computer"], [3, "Connected TV"]]);
  assert.equal(vocab("ApiFramework").open, true);
  assert.equal(vocab("ApiFramework").vendor?.from, 500);
  assert.equal(vocab("DeviceType").open, false);
  assert.deepEqual([vocab("StartDelayMode").extension, vocab("StartDelayMode").terms.map((t) => t.value)], ["MediaOffset", [0, -1, -2]]);
  assert.deepEqual(vocab("FeedType").terms[0]!.annotation, "AOD: Music streaming service");
  // Both locks give the same lists, term for term.
  const lists = (b: typeof main) => JSON.stringify(b!.model.types.filter((t) => t.kind === "vocabulary"));
  assert.equal(lists(tag), lists(main));
  // The kernel holds only what AdCOM's lists use; OpenProposal's text leaves out the media offset.
  assert.deepEqual(main!.model.types.filter((t) => t.kind === "primitive").map((t) => t.name).sort(), ["MediaOffset", "VendorCode"]);
  assert.ok(!loadKernel(REPO_ROOT, specRoot("openproposal")).primitives.some((p) => p.name === "MediaOffset"));
});

test("a binding leaves a kernel item out with absent alone, and a deferred module cites a decision that covers its sections", async () => {
  const { mergeBinding, unboundIn, BOUND_PATHS } = await import("../src/binding.ts");
  const merged = mergeBinding({ primitives: [{ name: "A", type: "string" }, { name: "B", type: "integer" }] }, { primitives: [{ name: "A", absent: true }] }, "x") as { primitives: { name: string }[] };
  assert.deepEqual(merged.primitives.map((p) => p.name), ["B"]);
  assert.match(unboundIn({ primitives: [{ name: "A", absent: true, decision: "D-001" }] }, BOUND_PATHS.primitives).join("\n"), /absent \(an absent item gives nothing else/);
  const { checkMapping, loadDecisions, loadMappings } = await import("../src/mapping.ts");
  const mappings = loadMappings(join(ADCOM, "mapping"));
  const decisions = loadDecisions(join(ADCOM, "decisions"));
  assert.deepEqual(checkMapping(IR, "main", mappings, decisions), []);
  const moved = mappings.map((m) => (m.deferred ? { ...m, deferred: { decision: "D-005" } } : m));
  assert.match(checkMapping(IR, "main", moved, decisions).join("\n"), /deferred: cites "D-005", which covers no element of the module's sections/);
  const missing = mappings.map((m) => (m.deferred ? { ...m, deferred: { decision: "D-999" } } : m));
  assert.match(checkMapping(IR, "main", missing, decisions).join("\n"), /deferred: cites decision "D-999", which doesn't exist/);
});

test("a vocabulary of the specification's own codes is open exactly when it gives a vendor range or an extension, and its vendor range starts where the vendor code does", async () => {
  const { resolveModel } = await import("../src/model.ts");
  const { loadKernel } = await import("../src/kernel.ts");
  const { loadConstructors } = await import("../src/constructors.ts");
  const { loadDecisions, loadMappings } = await import("../src/mapping.ts");
  const { REPO_ROOT } = await import("../src/repo.ts");
  const base = { ir: IR, lock: "main", decisions: loadDecisions(join(ADCOM, "decisions")), kernel: loadKernel(REPO_ROOT, ADCOM), constructors: loadConstructors(REPO_ROOT, ADCOM) };
  const mappings = loadMappings(join(ADCOM, "mapping"));
  const withDecl = (name: string, change: (d: Record<string, unknown>) => Record<string, unknown>) => mappings.map((m) => ({ ...m, types: (m.types ?? []).map((d) => (d.name === name ? (change({ ...d }) as unknown as typeof d) : d)) }));
  const problems = (name: string, change: (d: Record<string, unknown>) => Record<string, unknown>) => resolveModel({ ...base, mappings: withDecl(name, change) }).problems.join("\n");
  assert.deepEqual(resolveModel({ ...base, mappings }).problems, []);
  assert.match(problems("StartDelayMode", (d) => ({ ...d, open: false })), /has an extension, so it is open/);
  assert.match(problems("StartDelayMode", (d) => ({ ...d, extension: "Nope" })), /its extension "Nope" is no kernel primitive/);
  assert.match(problems("StartDelayMode", (d) => ({ ...d, vendor: { from: 500, label: "x" } })), /gives both a vendor range and an extension/);
});

test("two labeled lists are one list only when their codes and labels agree, and a structural twin needs both too", async () => {
  const { listProblems, modelStructures } = await import("../src/conventions.ts");
  const { checkDuplication } = await import("../src/duplication.ts");
  const term = (value: number, annotation: string) => ({ value, annotation, sources: [] });
  const vocab = (name: string, terms: ReturnType<typeof term>[], labeled = true) => ({ name, kind: "vocabulary" as const, layer: 3, module: "lists", sources: [], decisions: [], references: [], open: false, terms, ...(labeled ? { labeled: true as const } : {}) });
  const model = (types: unknown[]) => ({ types, modules: [], rules: [], obligations: [], schema_statements: [], examples: [], input: {} }) as never;
  const a = vocab("A", [term(1, "One"), term(2, "Two")]);
  const b = vocab("B", [term(1, "Uno"), term(2, "Dos")]);
  const c = vocab("C", [term(1, "One"), term(2, "Two")]);
  assert.deepEqual(listProblems(model([a, b])), []);
  assert.match(listProblems(model([a, c])).join("\n"), /"A", "C" list the same values/);
  const kernel = { primitives: [], file: "" } as never;
  assert.deepEqual(checkDuplication(modelStructures(model([a, b]), kernel)), []);
  assert.match(checkDuplication(modelStructures(model([a, c]), kernel)).join("\n"), /"A" and "C" have the same structure/);
});

test("an oracle gap that names no kernel primitive fails, and the kernel file keeps its constructors though a binding leaves them out", async () => {
  const { gapPrimitiveProblems, loadOracleGaps } = await import("../src/engines.ts");
  const { loadConstructors } = await import("../src/constructors.ts");
  const { REPO_ROOT } = await import("../src/repo.ts");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const gaps = loadOracleGaps(REPO_ROOT);
  assert.deepEqual(gapPrimitiveProblems(REPO_ROOT, gaps), []);
  const stale = { ...gaps, gaps: [...gaps.gaps, { id: "OG-99", reason: "A fixture gap.", vectors: [{ primitive: "Timestmap", value: "x", oracle: "rejects" as const }] }] };
  assert.match(gapPrimitiveProblems(REPO_ROOT, stale).join("\n"), /OG-99 names the primitive "Timestmap", which kernel\/primitives.yaml doesn't define/);
  const dir = mkdtempSync(join(tmpdir(), "ctor-"));
  writeFileSync(join(dir, "constructors.yaml"), "format: 1\nconstructors: []\nparts: []\n");
  assert.throws(() => loadConstructors(REPO_ROOT, null, join(dir, "constructors.yaml")), /the kernel file defines no constructor or no part/);
});

test("a record's text for the owners is checked whatever its status, except a superseded record's, and an object a heading names is a name the text writes", async () => {
  const { recordCitations, internalTypeNames } = await import("../src/feedback.ts");
  const { loadDecisions } = await import("../src/mapping.ts");
  const d = loadDecisions(join(ADCOM, "decisions"))[0]!;
  const bad = { ...d, feedback: "See D-001." };
  assert.match(recordCitations([bad]).join("\n"), /cites "D-001"/);
  assert.deepEqual(recordCitations([{ ...bad, status: "superseded" as const, superseded_by: "D-002" }]), []);
  const names = internalTypeNames([{ model: { types: [{ name: "Content" }, { name: "DeviceType" }] } as never, ir: IR }]);
  assert.ok(!names.has("Content") && names.has("DeviceType"));
});

test("the fidelity readers take each list's codes as valid, its vendor range and its >0 row as ranges, and a code no row names as invalid", async () => {
  const { readLists } = await import("../src/specs/adcom/fidelity-readers.ts");
  const lists = readLists(IR);
  assert.equal(lists.length, 42);
  const of = (anchor: string) => lists.find((l) => l.id.startsWith(`table:${anchor}:`))!;
  const values = (l: ReturnType<typeof of>, k: "valid" | "invalid") => l[k].map((v) => v.value);
  // Device Types: codes 1 to 8, and 9 is no code.
  assert.deepEqual(values(of("list_devicetypes"), "valid"), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(values(of("list_devicetypes"), "invalid"), [500, 9, "1", 1.5]);
  // Display Context Types skips from 15 to 20, so 16 is no code; IP Location Services reserves no vendor range, though 51Degrees' codes are 511 and 512.
  assert.ok(values(of("list_displaycontexttypes"), "invalid").includes(16));
  assert.deepEqual(values(of("list_iplocationservices"), "invalid"), [500, 513, 5, "1", 1.5]);
  // API Frameworks: a 500+ row makes 500 and 501 valid and 499, which no row names, invalid.
  assert.deepEqual(values(of("list_apiframeworks"), "valid").slice(-2), [500, 501]);
  assert.ok(values(of("list_apiframeworks"), "invalid").includes(499));
  // Start Delay Modes: the >0 row covers every positive code, so the code below the lowest is the one no row names.
  assert.deepEqual(values(of("list_startdelaymodes"), "valid"), [0, -1, -2, 1, 30]);
  assert.deepEqual(values(of("list_startdelaymodes"), "invalid"), [-3, "0", 0.5]);
  // Every row of a list is the list's evidence.
  assert.equal(of("list_devicetypes").rows.length, 8);
});

test("the round trip renders each list's table back from its vocabulary, cell for cell, and the only difference is the >0 row D-004 records", async () => {
  const { roundTrip } = await import("../src/render.ts");
  const { ROUND_TRIP } = await import("../src/specs/adcom/render.ts");
  const model = (await mainBuild()).model;
  const rt = roundTrip(model, IR, ROUND_TRIP);
  assert.deepEqual(rt.problems, []);
  assert.equal(rt.spec.length, 42);
  assert.deepEqual(rt.differences.map((d) => d.row), ["def:list_startdelaymodes:>0"]);
  // A label in two columns splits at its first ": ", and the vendor row renders as its first code with a plus.
  const feed = rt.model.find((t) => t.id.startsWith("table:list_feedtypes:"))!;
  assert.deepEqual(feed.rows[0]!.cells, ["1", "AOD", "Music streaming service"]);
  const api = rt.model.find((t) => t.id.startsWith("table:list_apiframeworks:"))!;
  assert.equal(api.rows.at(-1)!.cells[0], "500+");
  // A model that relabels a code differs at that cell.
  const relabeled = structuredClone(model);
  const dt = relabeled.types.find((t) => t.name === "DeviceType");
  assert.ok(dt?.kind === "vocabulary");
  dt.terms[2]!.annotation = "Smart TV";
  assert.ok(roundTrip(relabeled, IR, ROUND_TRIP).differences.some((d) => d.table.startsWith("table:list_devicetypes:") && d.model === "Smart TV"));
});

test("the list reader probes a gap between two codes and 500 where no vendor range is reserved, and a row it can't read fails the gate", async () => {
  const { readLists } = await import("../src/specs/adcom/fidelity-readers.ts");
  const rows = (vals: string[]) => vals.map((v) => `  <tr>\n    <td>${v}</td>\n    <td>Thing ${v}.</td>\n  </tr>`).join("\n");
  const [gapped] = readLists(run(doc(table(rows(["1", "2", "5", "500+"])))));
  assert.deepEqual(gapped!.invalid.map((x) => x.value), [499, 6, 3, "1", 1.5]);
  assert.deepEqual(gapped!.valid.map((x) => x.value), [1, 2, 5, 500, 501]);
  const [closed] = readLists(run(doc(table(rows(["1", "2"])))));
  assert.deepEqual(closed!.invalid.map((x) => x.value), [500, 3, "1", 1.5]);
  const [odd] = readLists(run(doc(table(rows(["1", "500-599"])))));
  assert.deepEqual(odd!.unreadable, [{ row: "def:list_things:500-599", value: "500-599" }]);
  const [none] = readLists(run(doc(table(rows(["500+"])))));
  assert.ok(none!.invalid.every((x) => Number.isFinite(x.value)), "a list with no codes gets no infinite vector");
});
