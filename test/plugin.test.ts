import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { loadConstructors } from "../src/constructors.ts";
import { checkCoverage } from "../src/coverage.ts";
import { citeText, elementDigest, indexElements } from "../src/elements.ts";
import { emitSchemas } from "../src/emit.ts";
import { extract } from "../src/extract.ts";
import { installFormats } from "../src/formats.ts";
import type { InputRecord } from "../src/ir-types.ts";
import { loadKernel } from "../src/kernel.ts";
import type { Layout } from "../src/layouts.ts";
import { checkMapping, type DecisionRecord, type MappingFile } from "../src/mapping.ts";
import { resolveModel, type ModelDoc } from "../src/model.ts";
import { emitSdk } from "../src/sdk-emit.ts";
import { checkProfile, loadProfile, schemaNamesOf } from "../src/profile.ts";
import { findKeywords } from "../src/sentences.ts";
import { FINDING_KINDS } from "../src/lint.ts";
import { PLUGINS, specOf } from "../src/specs/index.ts";
import type { SectionHead, SpecPlugin } from "../src/specs/plugin.ts";
import { ROOT, SPEC } from "./helpers.ts";

const DIR = join(ROOT, "test", "fixtures", "specs", "widgets");
const TEXT = readFileSync(join(DIR, "spec.md"), "utf8");
const INPUT: InputRecord = { name: "main", upstream: "https://example.invalid/widgets", commit: "0".repeat(40), path: "spec.md", blob: "0".repeat(40), base: null, merge_order: null, sha256: "0".repeat(64), bytes: 0 };

/** The fixture's one layout: a key table, which the extractor reads itself. */
const LAYOUTS: Layout[] = [{ id: "name-required-meaning", kind: "key", header: ["Name", "Required", "Meaning"], allowed: (s) => s.part === "body", allowedText: "the body" }];

/**
 * A plugin with one table layout and nothing else: no row kind of its own, no
 * type cells, no value-list or identifier-list form, no markers, no
 * conventions paragraph, no rule checks, fidelity readers, or round-trip
 * notation, and no stub for any.
 */
const WIDGETS: SpecPlugin = {
  id: "widgets",
  text: {
    layouts: LAYOUTS,
    rowKind: (l) => l.kind,
    sectionOf: ({ text, depth }, current): SectionHead => {
      if (depth === 1) return { kind: "title" };
      const m = /^(\d+(?:\.\d+)*)\.?\s+(.+)$/.exec(text);
      return m ? { kind: "section", number: m[1]!, title: m[2]!, part: "body" } : { kind: "section", number: null, title: text, part: current.part };
    },
    keywords: findKeywords,
  },
};

const ir = () => extract(TEXT, INPUT, WIDGETS.text);

test("a fixture spec with one table layout extracts with its own plugin", () => {
  const got = ir();
  assert.deepEqual(got.tables.map((t) => [t.id, t.layout, t.parent?.identifier]), [["table:1.1:1", "name-required-meaning", "widget"]]);
  assert.deepEqual(got.keys.map((k) => [k.id, k.required?.parsed]), [
    ["key:1.1:widget.id", { kind: "clauses", clauses: [{ level: "REQUIRED", qualifier: null, condition: null }] }],
    ["key:1.1:widget.label", { kind: "clauses", clauses: [{ level: "OPTIONAL", qualifier: null, condition: null }] }],
  ]);
  assert.deepEqual([got.fields.length, got.markers.length, got.appendix_a, got.appendix_b], [0, 0, null, null], "no markers, fields, or appendices");
  assert.equal(extract(TEXT, INPUT, WIDGETS.text).input.name, "main");
  assert.deepEqual(JSON.stringify(ir()), JSON.stringify(got), "two extractions are equal");
});

test("a table of a layout the plugin doesn't list fails extraction", () => {
  assert.throws(() => extract(TEXT.replace("| Name | Required | Meaning |", "| Key | Required | Meaning |"), INPUT, WIDGETS.text), /unknown table layout "\| Key \| Required \| Meaning \|"/);
  // A layout of a row kind only a plugin's readRow reads, with no readRow, fails rather than drops the rows.
  const fieldLayout = { ...WIDGETS.text, layouts: [{ ...LAYOUTS[0]!, kind: "field" as const }] };
  assert.throws(() => extract(TEXT, INPUT, fieldLayout), /no reader for the row kind "field" of layout "name-required-meaning"/);
  assert.throws(() => extract(TEXT.replace("| Name | Required | Meaning |", "| Field | Type | Mutability | Description |").replace(/\| :--- \| :--- \| :--- \|/, "| :--- | :--- | :--- | :--- |"), INPUT, WIDGETS.text), /unknown table layout/);
});

test("the fixture's profile needs no markers, appendices, or profiles, and agrees with its plugin", () => {
  const profile = loadProfile(DIR);
  assert.equal(profile.features, undefined);
  assert.deepEqual(checkProfile({ profile, text: WIDGETS.text, roles: ["property"], findingKinds: FINDING_KINDS, locks: 1, entries: [] }), []);
  assert.match(checkProfile({ profile: { ...profile, features: { markers: true } }, text: WIDGETS.text, roles: [], findingKinds: FINDING_KINDS, locks: 1, entries: [] }).join("\n"), /turns on "markers", and the plugin's list of markers isn't there/);
  assert.match(checkProfile({ profile, text: WIDGETS.text, roles: ["profile"], findingKinds: FINDING_KINDS, locks: 1, entries: [] }).join("\n"), /leaves "profiles" off, and a mapping entry of role profile is there/);
});

/** The fixture's model: its IR mapped by one decision, with every element covered, resolved over the shared kernel. */
function widgetModel(): ModelDoc {
  const got = ir();
  const elements = indexElements(got);
  const cover = (id: string) => ({ ir: id, digest: elementDigest(elements.get(id)!), quote: citeText(elements.get(id)!) });
  const decision: DecisionRecord = {
    format: 1,
    id: "D-001",
    status: "proposed",
    kind: "gap",
    author: "agent",
    question: "Which types do the widget's members take?",
    covers: [cover("key:1.1:widget.id"), cover("key:1.1:widget.label")],
    options: [
      { id: "kernel", summary: "An ID and a text, from the kernel." },
      { id: "strings", summary: "Two bare strings." },
    ],
    chosen: "kernel",
    rationale: "The kernel already defines both.",
    file: join(DIR, "decisions", "D-001.yaml"),
  } as DecisionRecord;
  const entry = (id: string, type: string, presence: "required" | "optional") => ({
    ir: id,
    digest: cover(id).digest,
    source: { decision: "D-001" },
    as: { role: "property" as const, object: "Widget", type: { kind: "named" as const, name: type }, presence },
  });
  const mapping = {
    format: 1,
    module: "widgets",
    sections: ["front", "1", "1.1"],
    types: [{ name: "Widget", kind: "object", ir: "key:1.1:widget.id", source: { rule: "key-table-object" }, open: false }],
    entries: [entry("key:1.1:widget.id", "ExternalId", "required"), entry("key:1.1:widget.label", "Text", "optional")],
    file: join(DIR, "mapping", "widgets.yaml"),
  } as unknown as MappingFile;
  const kernel = loadKernel(ROOT, SPEC);
  const constructors = loadConstructors(ROOT, SPEC);
  assert.deepEqual(checkMapping(got, "main", [mapping], [decision]), []);
  assert.deepEqual(checkCoverage(got, "main", [mapping], kernel, constructors), { coverage: [], location: [], rules: [], types: [] }, "every element has its one entry, in its module, with what its rule derives");
  const { model, problems } = resolveModel({ ir: got, lock: "main", mappings: [mapping], decisions: [decision], kernel, constructors });
  assert.deepEqual(problems, []);
  const widget = model.types.find((t) => t.name === "Widget");
  assert.ok(widget && widget.kind === "object");
  assert.deepEqual(Object.keys(widget.properties).sort(), ["id", "label"]);
  return model;
}

test("a fixture spec with one table layout maps and emits", () => {
  const model = widgetModel();
  const emitted = emitSchemas(model, "schemas", schemaNamesOf(loadProfile(DIR)));
  assert.deepEqual(emitted.problems, []);
  const file = emitted.files.find((f) => f.path === "modules/widgets/1/widgets.json");
  assert.ok(file, emitted.files.map((f) => f.path).join(", "));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  installFormats(ajv);
  for (const f of emitted.files) ajv.addSchema(f.schema);
  const validate = ajv.getSchema(`${String(file.schema.$id)}#/$defs/Widget`)!;
  assert.equal(validate({ id: "w-1", label: "A widget" }), true);
  assert.equal(validate({ label: "A widget" }), false, "id is required");
  assert.equal(validate({ id: "w-1", colour: "red" }), false, "the object is closed");
});

test("the fixture spec's SDKs and schemas carry its own names, and none of OpenProposal's", () => {
  const profile = loadProfile(DIR);
  const emitted = emitSdk(widgetModel(), "sdk/widgets", "schemas", profile.names);
  assert.deepEqual(emitted.problems, []);
  const paths = emitted.files.map((f) => f.path);
  for (const p of ["python/widgets/__init__.py", "python/widgets/_runtime.py", "python/widgets/widgets.py", "go/widgets/types.go", "go/widgets/runtime.go", "go/go.mod", "ts/package.json", "ts/src/index.ts"]) assert.ok(paths.includes(p), `${p} among ${paths.join(", ")}`);
  const text = (p: string) => emitted.files.find((f) => f.path === p)!.text;
  assert.match(text("go/go.mod"), /^module example\.invalid\/widgets\/sdk\/widgets\/go$/m);
  assert.match(text("go/widgets/types.go"), /^package widgets$/m);
  assert.match(text("go/widgets/runtime.go"), /"widgets: more data after the JSON value"/);
  assert.match(text("python/widgets/_runtime.py"), /^MODE_KEY = "widgets_mode"$/m);
  assert.match(text("python/widgets/registry.py"), /^ENTRY_POINT_GROUP = "widgets\.extensions"$/m);
  assert.equal(JSON.parse(text("ts/package.json")).name, "widgets-types");
  assert.match(text("ts/src/index.ts"), /The Widget Catalog types of/);
  for (const f of emitted.files) assert.doesNotMatch(f.text, /openproposal/i, `${f.path} names OpenProposal`);
  const schemas = emitSchemas(widgetModel(), "schemas", schemaNamesOf(profile));
  for (const f of schemas.files) {
    assert.ok(String(f.schema.$id).startsWith("https://widgets.example.invalid/schemas/"), String(f.schema.$id));
    assert.doesNotMatch(f.text, /openproposal/i, f.path);
  }
});

test("the registry builds the OpenProposal plugin from its profile, and refuses a profile whose plugin it doesn't know", () => {
  assert.deepEqual(Object.keys(PLUGINS), ["adcom", "openproposal"]);
  const op = specOf(SPEC);
  assert.equal(op.profile.id, "openproposal");
  assert.deepEqual(op.profile.documents?.map((d) => d.document), ["Proposal", "LineItem"]);
  assert.equal(op.plugin?.id, "openproposal");
  assert.throws(() => specOf(DIR), /names the plugin "widgets", and src\/specs\/ holds adcom, openproposal/);
});
