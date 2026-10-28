import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConstructors } from "../src/constructors.ts";
import type { SpecIR } from "../src/ir-types.ts";
import { loadKernel } from "../src/kernel.ts";
import { loadDecisions, loadMappings } from "../src/mapping.ts";
import { resolveModel, type ModelDoc } from "../src/model.ts";
import { applicationExpr, buildSdkModel, sdkDirOf } from "../src/sdk.ts";
import { emitSdk } from "../src/sdk-emit.ts";
import { compareRun, jsonEqual, runGo, runPython, runTypeScript, sdkCases, type SdkCase } from "../src/sdk-parity.ts";
import type { CorpusDoc } from "../src/corpus.ts";
import { OP_NAMES, OP_SCHEMA, ROOT, SPEC } from "./helpers.ts";

const KERNEL = loadKernel(ROOT, SPEC);
const CONSTRUCTORS = loadConstructors(ROOT, SPEC);
const MAPPINGS = loadMappings(join(SPEC, "mapping"));
const DECISIONS = loadDecisions(join(SPEC, "decisions"));

function modelOf(lock: string, irDir: string): ModelDoc {
  const ir = JSON.parse(readFileSync(join(SPEC, irDir, "spec-ir.json"), "utf8")) as SpecIR;
  return resolveModel({ ir, lock, mappings: MAPPINGS, decisions: DECISIONS, kernel: KERNEL, constructors: CONSTRUCTORS }).model;
}
const MAIN = modelOf("main", "ir");
const PRS = modelOf("with-open-prs", join("ir", "with-open-prs"));

test("the SDK directory follows the IR directory, with the as-written build as the default tree and the schemas we propose opt-in", () => {
  assert.equal(sdkDirOf("ir", "as-written"), "sdk");
  assert.equal(sdkDirOf("ir/with-open-prs", "as-written"), "sdk/with-open-prs");
  assert.equal(sdkDirOf("ir", undefined), "sdk/proposed");
  assert.equal(sdkDirOf("ir/with-open-prs", undefined), "sdk/proposed/with-open-prs");
  assert.throws(() => sdkDirOf("elsewhere", undefined));
});

test("both locks' SDKs generate with no problem, and every schema type is declared once", () => {
  for (const [model, dir, schemaDir] of [[MAIN, "sdk/proposed", "schemas"], [PRS, "sdk/proposed/with-open-prs", "schemas/with-open-prs"]] as const) {
    const out = emitSdk(model, dir, schemaDir, OP_NAMES, OP_SCHEMA);
    assert.deepEqual(out.problems, []);
    const emitted = model.types.filter((t) => t.kind !== "constructor" && !(t.kind === "vocabulary" && t.attribute !== undefined)).map((t) => t.name);
    assert.deepEqual(out.sdk.emitted, [...emitted].sort());
    // Every constructor that isn't filled in place is a template, with its fallback.
    assert.deepEqual([...out.sdk.templates.keys()].sort(), ["CatalogRefOr", "Range", "Selectable", "SelectableOrValue", "Settable", "SettableOrValue"]);
  }
});

test("a property is typed by its template applied to its arguments, and its copy is an alias", () => {
  const { sdk } = buildSdkModel(MAIN, OP_NAMES.short);
  const lineItem = sdk.types.get("LineItem");
  assert.ok(lineItem?.kind === "object");
  const formats = lineItem.shape.properties.find((p) => p.name === "formats");
  assert.deepEqual(formats?.expr, { k: "apply", template: "Selectable", args: [{ k: "ref", name: "FormatId" }, { k: "ref", name: "FormatId" }], copy: "FormatsSelection" });
  const audiences = sdk.types.get("AudiencesSelection");
  assert.deepEqual(audiences?.kind === "alias" && audiences.expr, {
    k: "apply",
    template: "Selectable",
    args: [{ k: "apply", template: "CatalogRefOr", args: [{ k: "ref", name: "AudiencesOption" }] }, { k: "ref", name: "Uuid" }],
  });
});

test("the SDKs don't depend on the order of the model's types", () => {
  const reversed: ModelDoc = { ...MAIN, types: [...MAIN.types].reverse() };
  const a = emitSdk(MAIN, "sdk/proposed", "schemas", OP_NAMES, OP_SCHEMA).files;
  const b = emitSdk(reversed, "sdk/proposed", "schemas", OP_NAMES, OP_SCHEMA).files;
  assert.deepEqual(b, a);
});

test("a keyword the SDK emitters don't know fails the build, so no constraint is dropped", () => {
  const types = MAIN.types.map((t) => (t.kind === "primitive" && t.name === "Amount" ? { ...t, schema: { ...t.schema, multipleOf: 0.01 } } : t));
  const { problems } = buildSdkModel({ ...MAIN, types }, OP_NAMES.short);
  assert.ok(problems.some((p) => p.includes('"multipleOf"')), problems.join("; "));
  const formats = MAIN.types.map((t) => (t.kind === "primitive" && t.name === "Url" ? { ...t, schema: { ...t.schema, format: "iri" } } : t));
  assert.ok(buildSdkModel({ ...MAIN, types: formats }, OP_NAMES.short).problems.some((p) => p.includes('"iri"')));
});

test("a vector's application becomes the fallback template when it supplies the bare value", () => {
  assert.deepEqual(applicationExpr(MAIN, "Selectable", { T: { kind: "named", name: "FormatId" }, K: { kind: "named", name: "FormatId" }, B: { kind: "named", name: "FormatId" } }), {
    k: "apply",
    template: "SelectableOrValue",
    args: [{ k: "ref", name: "FormatId" }, { k: "ref", name: "FormatId" }, { k: "ref", name: "FormatId" }],
  });
  assert.deepEqual(applicationExpr(MAIN, "List", { T: { kind: "named", name: "ExternalId" } }), { k: "list", item: { k: "ref", name: "ExternalId" } });
});

test("the parity comparison fails a wrong verdict, an error, and a value that doesn't encode back", () => {
  const cases: SdkCase[] = [
    { label: "a", target: { k: "ref", name: "ExternalId" }, value: "x", valid: true },
    { label: "b", target: { k: "ref", name: "ExternalId" }, value: 1, valid: false },
    { label: "c", target: { k: "ref", name: "Amount" }, value: 1, valid: true },
    { label: "d", target: { k: "ref", name: "Amount" }, value: 2, valid: true },
  ];
  const r = compareRun("x", cases, { engine: "x", verdicts: [true, true, true, true], dumps: ["x", 1, 1.5, 2], errors: [null, null, null, "boom"] });
  assert.equal(r.problems.length, 3);
  assert.match(r.problems[0]!, /b: labelled invalid/);
  assert.match(r.problems[1]!, /c: encodes 1 back as 1.5/);
  assert.match(r.problems[2]!, /d: boom/);
  assert.ok(jsonEqual({ a: [1, { b: true }] }, { a: [1.0, { b: true }] }));
  assert.ok(!jsonEqual({ a: 1 }, { a: true }));
});

/**
 * The formats by their RFC grammars, beyond what the corpus and the kernel
 * vectors show: the three runtimes give each of these the same verdict.
 */
const FORMAT_CASES: [string, string, boolean][] = [
  ["Timestamp", "2026-12-31T23:59:60Z", true],
  ["Timestamp", "2026-12-31T22:59:60-01:00", true],
  ["Timestamp", "2026-12-31T23:59:60+01:00", false],
  ["Timestamp", "2026-10-25t09:00:00z", true],
  ["Timestamp", "2026-10-25 09:00:00Z", false],
  ["Timestamp", "2026-10-25T09:00:00+0500", false],
  ["Timestamp", "2026-10-25T24:00:00Z", false],
  ["Timestamp", "2026-10-25T09:00:00+24:00", false],
  ["Timestamp", "2026-10-25T09:00:00.123456789Z", true],
  ["Timestamp", "2028-02-29T00:00:00Z", true],
  ["Timestamp", "2100-02-29T00:00:00Z", false],
  ["Timestamp", "2000-02-29T00:00:00Z", true],
  ["Timestamp", "2026-04-31T00:00:00Z", false],
  ["Timestamp", "2026-00-10T00:00:00Z", false],
  ["Duration", "P1Y2M3DT4H5M6S", true],
  ["Duration", "PT36H", true],
  ["Duration", "P1W2D", false],
  ["Duration", "PT1.5S", false],
  ["Duration", "P1YT", false],
  ["Duration", "P1H", false],
  ["Url", "https://[::1]:8080/a?b=c#d", true],
  ["Url", "https://[::1/a", false],
  ["Url", "https://example.example/a%20b", true],
  ["Url", "https://example.example/a%2", false],
  ["Url", "https://example.example/\n", false],
  ["Uuid", "7c9e6679-7425-40de-944b-e07fc1f90ae7", true],
  ["Uuid", "7C9E6679-7425-40DE-944B-E07FC1F90AE7", true],
  ["Uuid", "urn:uuid:7c9e6679-7425-40de-944b-e07fc1f90ae7", false],
  ["Uuid", "7c9e6679742540de944be07fc1f90ae7", false],
  ["Uuid", "7c9e6679-7425-40de-944b-e07fc1f90ae7\n", false],
];

test("the TypeScript, Python, and Go runtimes read the formats alike", async () => {
  const cases: SdkCase[] = FORMAT_CASES.map(([type, value, valid]) => ({ label: `${type} ${JSON.stringify(value)}`, target: { k: "ref", name: type }, value, valid }));
  const dir = join(ROOT, "sdk", "proposed");
  const runs = [
    ["TypeScript", await runTypeScript(join(dir, "ts"), cases)],
    ["Python", runPython(ROOT, join(dir, "python"), cases)],
    ["Go", runGo(join(dir, "go"), join(ROOT, "build", "test", "sdk-go-formats"), cases)],
  ] as const;
  for (const [language, run] of runs) assert.deepEqual(compareRun(language, cases, run).problems, []);
});

/**
 * Integral floats, sent as JSON text so no serializer rewrites them first.
 * JSON Schema compares numbers by value, so `1.0` and `1e2` are integers,
 * and an integer term written `1.0` is that term; `1.5` is no integer.
 */
const INTEGRAL_CASES: [string, string, string, boolean][] = [
  ["sdk/proposed", "Count", "1.0", true],
  ["sdk/proposed", "Count", "1e2", true],
  ["sdk/proposed", "Count", "1.5", false],
  ["sdk/proposed", "Count", "-1.0", false],
  ["sdk/proposed", "Count", "0.0", true],
  ["sdk/proposed/with-open-prs", "VendorCode", "500.0", true],
  ["sdk/proposed/with-open-prs", "VendorCode", "500.5", false],
  ["sdk/proposed/with-open-prs", "ApiFramework", "500.0", true],
  ["sdk/proposed/with-open-prs", "ApiFramework", "10.0", false],
  ["sdk/proposed/with-open-prs", "PlcmtSubtype", "9.0", true],
];

test("the TypeScript, Python, and Go runtimes take an integral float as an integer and encode it back as the same number", async () => {
  for (const dir of [...new Set(INTEGRAL_CASES.map(([d]) => d))]) {
    const cases: SdkCase[] = INTEGRAL_CASES.filter(([d]) => d === dir).map(([, type, json, valid]) => ({ label: `${type} ${json}`, target: { k: "ref", name: type }, value: JSON.parse(json), json, valid }));
    const sdk = join(ROOT, dir);
    const runs = [
      ["TypeScript", await runTypeScript(join(sdk, "ts"), cases)],
      ["Python", runPython(ROOT, join(sdk, "python"), cases)],
      ["Go", runGo(join(sdk, "go"), join(ROOT, "build", "test", "sdk-go-integral"), cases)],
    ] as const;
    for (const [language, run] of runs) {
      assert.deepEqual(compareRun(language, cases, run).problems, [], `${language} on ${dir}`);
      cases.forEach((c, i) => {
        if (c.valid) assert.equal(typeof run.dumps[i], "number", `${language}: ${c.label} encodes back as a number`);
      });
    }
  }
});

test("the parity cases send each integer primitive's vectors and each integer term as integral floats", () => {
  const corpus = JSON.parse(readFileSync(join(SPEC, "corpus", "with-open-prs", "cases.json"), "utf8")) as CorpusDoc;
  const raw = sdkCases(PRS, corpus, KERNEL, CONSTRUCTORS).filter((c) => c.json !== undefined);
  const has = (name: string, json: string, valid: boolean) => raw.some((c) => c.target.k === "ref" && c.target.name === name && c.json === json && c.valid === valid);
  assert.ok(has("Count", "1500000.0", true));
  assert.ok(has("Count", "1500000e0", true));
  assert.ok(has("Count", "1500000.5", false));
  assert.ok(has("VendorCode", "500.0", true));
  assert.ok(has("PlcmtSubtype", "1.0", true));
  assert.ok(raw.every((c) => jsonEqual(JSON.parse(c.json!), c.value)));
});

test("the TypeScript extension registry keys validators by URI and digest", async () => {
  const { ExtensionRegistry } = await import(join(ROOT, "sdk", "ts", "src", "registry.ts"));
  const r = new ExtensionRegistry();
  const digest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const validate = () => [];
  r.register("https://examplepub.example/ext/viewability/1", digest, validate);
  assert.equal(r.lookup("https://examplepub.example/ext/viewability/1", digest), validate);
  assert.equal(r.lookup("https://examplepub.example/ext/viewability/2", digest), undefined);
  assert.equal(r.size, 1);
  assert.throws(() => r.register("https://examplepub.example/ext/viewability/1", digest, validate), /already registered/);
  assert.throws(() => r.register("https://examplepub.example/ext/viewability/1", "sha256:abc", validate), /isn't a SHA-256 digest/);
  assert.throws(() => r.register("viewability", digest, validate), /isn't an absolute URI/);
});
