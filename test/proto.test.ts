import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareTarget, readProtoEnums, targetProblems, type RegistryList } from "../src/enum-drift.ts";
import { importsOutsideTargets, localImports, namesASpec } from "../src/targets/checks.ts";
import { codeName, codeNames, typeUpperSnake, upperSnake } from "../src/targets/names.ts";
import { emitProto } from "../src/targets/proto.ts";
import { readSchemaTree, type SchemaDoc } from "../src/targets/schema-tree.ts";
import { REPO_ROOT } from "../src/repo.ts";

const ID = "https://example.test/s/lists.json";
const doc = (defs: Record<string, unknown>, path = "modules/lists/1/lists.json"): SchemaDoc => ({ path, id: ID, schema: { $id: ID, title: "lists", $defs: defs } });
const vocab = (branches: unknown[], extra: Record<string, unknown> = {}) => ({ type: "integer", title: "List: T", description: "The codes of List: T", oneOf: branches, ...extra });
const values = (out: ReturnType<typeof emitProto>, name: string) => out.enums.find((e) => e.name === name)!.values.map((v) => [v.name, v.number]);

test("a code's name is the UPPER_SNAKE of its title, CODE_ before a digit, cut at its last underscore before 48", () => {
  assert.equal(upperSnake("MRAID 3.0"), "MRAID_3_0");
  assert.equal(upperSnake("No Content/Standalone"), "NO_CONTENT_STANDALONE");
  assert.equal(upperSnake("  -Pre-Roll- "), "PRE_ROLL");
  assert.equal(codeName("2G cellular", 4), "CODE_2G_CELLULAR");
  assert.equal(codeName("—", 3), "CODE_3");
  assert.equal(codeName("—", -2), "CODE_MINUS_2");
  const long = codeName("An ID which is tied to a specific web browser or device", 1);
  assert.equal(long, "AN_ID_WHICH_IS_TIED_TO_A_SPECIFIC_WEB_BROWSER_OR");
  assert.ok(long.length <= 48);
  // A run with no underscore in its first 48 characters is cut at 48.
  assert.equal(codeName("x".repeat(60), 1), "X".repeat(48));
  assert.equal(typeUpperSnake("ApiFramework"), "API_FRAMEWORK");
  assert.equal(typeUpperSnake("DoohVenueTaxonomy"), "DOOH_VENUE_TAXONOMY");
  assert.equal(typeUpperSnake("HTTPServer2Type"), "HTTP_SERVER2_TYPE");
});

test("codes whose names collide, or take a name already taken, carry their codes as a suffix", () => {
  assert.deepEqual(codeNames([{ code: -1, title: "Mid-Roll" }, { code: 2, title: "Mid Roll" }, { code: 3, title: "Post" }]), ["MID_ROLL_MINUS_1", "MID_ROLL_2", "POST"]);
  assert.deepEqual(codeNames([{ code: 5, title: "Unspecified" }], new Set(["UNSPECIFIED"])), ["UNSPECIFIED_5"]);
  assert.throws(() => codeNames([{ code: 1, title: "A" }, { code: 1, title: "A" }]), /both named A_1/);
});

test("an enum's zero is its code 0 under its own name, first, or else <ENUM>_UNSPECIFIED; extension branches are no values", () => {
  const out = emitProto(
    [
      doc({
        StartDelayMode: vocab([{ const: -1, title: "Generic Mid-Roll" }, { const: 0, title: "Pre-Roll" }, { type: "integer", minimum: 0, maximum: 9007199254740991, not: { const: 0 }, title: "Media offset" }]),
        ApiFramework: vocab([{ const: 1, title: "VPAID 1.0" }, { const: 6, title: "MRAID 3.0", description: "MRAID 3.0, the third." }, { type: "integer", minimum: 500, title: "Vendor-specific", description: "Vendor-specific codes." }]),
        Unrelated: { type: "string", enum: ["a"] },
      }),
    ],
    { package: "acme.lists.v1" },
  );
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.files.map((f) => f.path), ["acme/lists/v1/lists.proto"]);
  assert.deepEqual(values(out, "StartDelayMode"), [["START_DELAY_MODE_PRE_ROLL", 0], ["START_DELAY_MODE_GENERIC_MID_ROLL", -1]]);
  assert.deepEqual(values(out, "ApiFramework"), [["API_FRAMEWORK_UNSPECIFIED", 0], ["API_FRAMEWORK_VPAID_1_0", 1], ["API_FRAMEWORK_MRAID_3_0", 6]]);
  const text = out.files[0]!.text;
  // The comments read as one text where they wrap.
  const flat = text.replace(/\n *\/\/ /g, " ");
  assert.match(text, /^syntax = "proto3";$/m);
  assert.match(text, /^package acme\.lists\.v1;$/m);
  assert.match(flat, /Not a value: Vendor-specific, an integer of at least 500: Vendor-specific codes\./);
  assert.match(flat, /Not a value: Media offset, an integer from 0 to 9007199254740991, other than 0\./);
  assert.match(text, /^\/\/ From https:\/\/example\.test\/s\/lists\.json#\/\$defs\/ApiFramework$/m);
  // Every comment line is within 80 columns, but one that holds a single word, such as a URL, or an enum's source.
  assert.ok(text.split("\n").every((l) => !l.trimStart().startsWith("//") || l.length <= 80 || !/\/\/ \S+ \S/.test(l) || l.startsWith("// From ")), "comments wrap at 80 columns");
  // The drift report's proto reader reads every enum the target writes, with its numbers.
  assert.deepEqual(readProtoEnums(text, "lists.proto").map((e) => [e.name, e.values.map((v) => v.value)]), [["ApiFramework", [0, 1, 6]], ["StartDelayMode", [0, -1]]]);
  // A second run writes the same bytes.
  assert.equal(emitProto([doc({ ApiFramework: vocab([{ const: 1, title: "VPAID 1.0" }]) })], { package: "acme.lists.v1" }).files[0]!.text, emitProto([doc({ ApiFramework: vocab([{ const: 1, title: "VPAID 1.0" }]) })], { package: "acme.lists.v1" }).files[0]!.text);
});

test("the proto target fails on what it can't read, and on a name two enums of a package share", () => {
  const p = { package: "acme.v1" };
  assert.match(emitProto([doc({ A: vocab([{ const: 1 }]) })], p).problems.join(), /has no title, which names its value/);
  assert.match(emitProto([doc({ A: vocab([{ const: 1.5, title: "x" }]) })], p).problems.join(), /isn't an integer/);
  assert.match(emitProto([doc({ A: vocab([{ const: 2 ** 31, title: "x" }]) })], p).problems.join(), /outside int32/);
  assert.match(emitProto([doc({ A: vocab([{ const: 1, title: "x" }, { const: 1, title: "y" }]) })], p).problems.join(), /lists the code 1 twice/);
  assert.match(emitProto([doc({ A: vocab([{ const: 1, title: "x", default: 1 }]) })], p).problems.join(), /a code's branch has "default"/);
  assert.match(emitProto([doc({ A: vocab([{ const: 1, title: "x" }], { default: 1 }) })], p).problems.join(), /has "default", which the proto target doesn't read/);
  assert.match(emitProto([doc({ A: vocab([{ const: 1, title: "x" }, { type: "integer", minimum: 5, multipleOf: 5, title: "v" }]) })], p).problems.join(), /a branch that isn't a code has "multipleOf"/);
  assert.match(emitProto([doc({ apiFramework: vocab([{ const: 1, title: "x" }]) })], p).problems.join(), /isn't a PascalCase name/);
  // `Placement`'s "Position X" and `PlacementPosition`'s "X" are one name in the package.
  assert.match(emitProto([doc({ Placement: vocab([{ const: 1, title: "Position X" }]), PlacementPosition: vocab([{ const: 1, title: "X" }]) })], p).problems.join(), /names PLACEMENT_POSITION_X, which .*Placement names too, in the package acme\.v1/);
  assert.match(emitProto([doc({ A: vocab([{ const: 1, title: "x" }]) }), doc({ B: vocab([{ const: 1, title: "x" }]) }, "other/lists.json")], p).problems.join(), /would both be written to acme\/v1\/lists\.proto/);
  // A package given on the command line is held to the profile's pattern, and a file's name is lower_snake_case.
  assert.match(emitProto([doc({ A: vocab([{ const: 1, title: "x" }]) })], { package: "Acme" }).problems.join(), /the package "Acme" isn't lowercase dotted words ending in a version/);
  assert.deepEqual(emitProto([doc({ A: vocab([{ const: 1, title: "x" }]) }, "modules/buyer-seat/1/buyer-seat.json")], p).files.map((f) => f.path), ["acme/v1/buyer_seat.proto"]);
});

test("the proto CLI replaces only a folder of proto files, and never the schema tree", () => {
  const root = mkdtempSync(join(tmpdir(), "proto-cli-"));
  try {
    const schemas = join(root, "schemas");
    mkdirSync(join(schemas, "m"), { recursive: true });
    writeFileSync(join(schemas, "m", "lists.json"), JSON.stringify({ $id: ID, $defs: { A: vocab([{ const: 1, title: "One" }]) } }));
    writeFileSync(join(schemas, "release.json"), JSON.stringify({ files: { "m/lists.json": {} } }));
    writeFileSync(join(root, "keep.txt"), "x");
    const cli = (out: string) => spawnSync(process.execPath, ["--import", "tsx", join(REPO_ROOT, "src", "cli", "proto.ts"), "--schemas", schemas, "--package", "acme.v1", "--out", out], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.match(cli(root).stderr, /holds the schema tree/);
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "other", "notes.md"), "x");
    assert.match(cli(join(root, "other")).stderr, /holds notes\.md, which isn't a proto file/);
    const ok = cli(join(root, "out"));
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(cli(join(root, "out")).status, 0, "a folder of proto files is replaced");
    assert.ok(existsSync(join(root, "keep.txt")) && existsSync(join(root, "out", "acme", "v1", "lists.proto")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a schema tree is the documents its release manifest lists, and nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "tree-"));
  try {
    mkdirSync(join(root, "modules", "lists", "1"), { recursive: true });
    mkdirSync(join(root, "tag", "modules"), { recursive: true });
    writeFileSync(join(root, "modules", "lists", "1", "lists.json"), JSON.stringify({ $id: ID, $defs: {} }));
    writeFileSync(join(root, "tag", "modules", "lists.json"), JSON.stringify({ $id: "https://example.test/tag.json" }));
    writeFileSync(join(root, "release.json"), JSON.stringify({ files: { "modules/lists/1/lists.json": {} } }));
    assert.deepEqual(readSchemaTree(root).map((d) => [d.path, d.id]), [["modules/lists/1/lists.json", ID]]);
    writeFileSync(join(root, "release.json"), JSON.stringify({ files: { "../outside.json": {} } }));
    assert.throws(() => readSchemaTree(root), /isn't a path inside the tree/);
    writeFileSync(join(root, "release.json"), JSON.stringify({ files: { "missing.json": {} } }));
    assert.throws(() => readSchemaTree(root), /which the tree doesn't hold/);
    rmSync(join(root, "release.json"));
    assert.throws(() => readSchemaTree(root), /no release manifest/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an emitter's imports stay under src/targets/, dynamic ones included, and a target's code names no spec", () => {
  assert.deepEqual(localImports("src/targets/a.ts", 'import { x } from "./b.ts";\nimport type { Y } from "../ir-types.ts";\nconst m = await import("../model.ts");\nimport "node:fs";\n'), ["src/ir-types.ts", "src/model.ts", "src/targets/b.ts"]);
  const files: Record<string, string> = { "src/targets/a.ts": 'import { b } from "./b.ts";\n', "src/targets/b.ts": 'export { m } from "../model.ts";\n' };
  const r = importsOutsideTargets("src/targets/a.ts", (p) => files[p]!, "src/targets/r.ts");
  assert.deepEqual(r.reached, ["src/targets/a.ts", "src/targets/b.ts"]);
  assert.match(r.problems.join(), /src\/targets\/b\.ts imports src\/model\.ts/);
  // A computed name, a require, a package, or the file system outside the reader each fail.
  const more: Record<string, string> = {
    "src/targets/a.ts": 'import { r } from "./r.ts";\nimport { join } from "node:path";\nconst m = () => import(`../${"model"}.ts`);\nconst n = () => import("../" + "ir.ts");\nconst q = require("../x.ts");\nimport { readdirSync } from "node:fs";\nimport { parse } from "yaml";\n',
    "src/targets/r.ts": 'import { readFileSync } from "node:fs";\n',
  };
  const p = importsOutsideTargets("src/targets/a.ts", (x) => more[x]!, "src/targets/r.ts").problems;
  assert.equal(p.filter((x) => x.includes("loads a module by a computed name")).length, 3);
  assert.ok(p.some((x) => x.startsWith("src/targets/a.ts imports node:fs")));
  assert.ok(p.some((x) => x.startsWith("src/targets/a.ts imports yaml")));
  assert.ok(!p.some((x) => x.startsWith("src/targets/a.ts imports node:path") || x.startsWith("src/targets/r.ts")), "node:path anywhere, and node:fs in the reader, pass");
  assert.deepEqual(namesASpec(new Map([["src/targets/a.ts", "const subcommand = 1;\n"]]), ["adcom", "Deals API"]), []);
  assert.match(namesASpec(new Map([["src/targets/a.ts", "x\nconst pkg = 'AdCOM.v1';\n"]]), ["adcom"]).join(), /src\/targets\/a\.ts:2: names "adcom"/);
});

test("the target's enums are held to the registry's lists: a code missing, a value extra, a list with no enum, and an enum of no list each fail", () => {
  const lists: RegistryList[] = [
    { list: "list_a", title: "A Things", vocabulary: "AThing", codes: [{ value: 1, label: "One" }, { value: 2, label: "Two" }], vendor: 500, positive: false },
    { list: "list_b", title: "B Things", vocabulary: "BThing", codes: [{ value: 0, label: "Zero" }], vendor: null, positive: false },
    { list: "list_gone", title: "Gone", vocabulary: null, codes: [], vendor: null, positive: false },
  ];
  const good = 'syntax = "proto3";\npackage acme.v1;\nenum AThing {\n  A_THING_UNSPECIFIED = 0;\n  A_THING_ONE = 1;\n  A_THING_TWO = 2;\n}\nenum BThing {\n  B_THING_ZERO = 0;\n}\n';
  const ok = compareTarget(lists, new Map([["acme/v1/lists.proto", Buffer.from(good)]])).target;
  assert.deepEqual(targetProblems(ok, lists), []);
  assert.deepEqual(ok.totals, { compared: 2, noEnum: 0, missing: 0, extra: 0, values: 4 });
  // A range is no value of the target's enum, so a vendor's code as a value is extra, where an artifact's enum may hold it.
  const vendor = good.replace("A_THING_TWO = 2;", "A_THING_TWO = 2;\n  A_THING_MY_VENDOR = 500;");
  assert.deepEqual(targetProblems(compareTarget(lists, new Map([["f.proto", Buffer.from(vendor)]])).target, lists), ["A Things: the target's AThing holds A_THING_MY_VENDOR = 500, which is no code of the list"]);
  const bad = good.replace("A_THING_TWO = 2;", "A_THING_TWO = 20;").replace("enum BThing", "enum BThings");
  assert.deepEqual(targetProblems(compareTarget(lists, new Map([["f.proto", Buffer.from(bad)]])).target, lists), [
    "A Things: the target's AThing lacks the code 2",
    "A Things: the target's AThing holds A_THING_TWO = 20, which is no code of the list",
    "B Things: the target has no enum for the list",
    "the target's enum BThings is no list's vocabulary",
  ]);
});
