import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { allSnapshotFiles, blobSha, checkEnumDriftSnapshots, compareEnumDrift, enumDriftFiles, loadEnumDriftSources, readFiles, readGoEnums, readProtoEnums, treeSha, type EnumDriftSources } from "../src/enum-drift.ts";
import { specRoot } from "../src/repo.ts";

const ADCOM = specRoot("adcom");
const SOURCES = loadEnumDriftSources(ADCOM);
const FILES = allSnapshotFiles(ADCOM, SOURCES);

async function build() {
  const { resolveBuild } = await import("../src/builds.ts");
  const { loadKernel } = await import("../src/kernel.ts");
  const { loadConstructors } = await import("../src/constructors.ts");
  const { loadDecisions, loadMappings } = await import("../src/mapping.ts");
  const { loadLock } = await import("../src/lock.ts");
  const { REPO_ROOT } = await import("../src/repo.ts");
  return resolveBuild({ root: ADCOM, mappings: loadMappings(join(ADCOM, "mapping")), decisions: loadDecisions(join(ADCOM, "decisions")), kernel: loadKernel(REPO_ROOT, ADCOM), constructors: loadConstructors(REPO_ROOT, ADCOM), lock: loadLock(join(ADCOM, "spec-input", "spec-lock.yaml")) });
}

test("a proto file's enums read with their values, lines, and comments, a nested enum under its message's name, and a line the reader can't read fails", () => {
  const text = `syntax = "proto2";\n/** A list. */\nenum A {\n  A_UNKNOWN = 0; // Unset.\n\n  // First.\n  ONE = 1;\n  MINUS = -1;\n}\nmessage M {\n  optional int32 x = 1;\n  enum B {\n    TWO = 2;\n  }\n}\n`;
  const enums = readProtoEnums(text, "f.proto");
  assert.deepEqual(enums.map((e) => [e.name, e.values.map((v) => [v.name, v.value, v.comment, v.line])]), [
    ["A", [["A_UNKNOWN", 0, "Unset.", 4], ["ONE", 1, "First.", 7], ["MINUS", -1, "", 8]]],
    ["M.B", [["TWO", 2, "", 13]]],
  ]);
  assert.throws(() => readProtoEnums("enum A {\n  ONE = 1 [deprecated = true];\n}\n", "f.proto"), /f\.proto:2: a line in enum A the reader can't read/);
  assert.throws(() => readProtoEnums("enum A {\n  ONE = 1;\n", "f.proto"), /a block that isn't closed/);
  // A form the reader doesn't read fails, so no enum or value drops out.
  assert.throws(() => readProtoEnums("enum A { ONE = 1; }\n", "f.proto"), /names enum and opens none/);
  assert.throws(() => readProtoEnums("enum A\n{\n  ONE = 1;\n}\n", "f.proto"), /names enum and opens none/);
  assert.throws(() => readProtoEnums("message M { optional int32 x = 1; }\n", "f.proto"), /opens or closes more than one block/);
  // A value after a block comment on its line is read; a comment line in the trailing comment's column continues it.
  const read = readProtoEnums("enum A {\n  /* c */ ONE = 1;\n  TWO = 2;  // first\n            // second 4.3\n  // Three.\n  THREE = 3;\n}\n", "f.proto");
  assert.deepEqual(read[0]!.values.map((v) => [v.name, v.comment]), [["ONE", ""], ["TWO", "first second 4.3"], ["THREE", "Three."]]);
});

test("a Go file's enums are its integer types with their constants, and a constant the reader can't read fails", () => {
  const text = `package adcom1\n\ntype T int8\n\nconst (\n\tTUnknown T = 0 // Unknown\n\t// One.\n\tTOne T = 1\n)\n\ntype S string\n`;
  const enums = readGoEnums(text, "t.go");
  assert.deepEqual(enums.map((e) => [e.name, e.type, e.values.map((v) => [v.name, v.value, v.comment])]), [["T", "int8", [["TUnknown", 0, "Unknown"], ["TOne", 1, "One."]]]]);
  assert.throws(() => readGoEnums("type T int\nconst (\n\tA T = iota\n)\n", "t.go"), /t\.go:3: a constant the reader can't read/);
  assert.throws(() => readGoEnums("type T int\nconst A T = 1\n", "t.go"), /a const declaration the reader doesn.t read/);
  assert.throws(() => readGoEnums("const (\n\tA U = 1\n)\n", "t.go"), /the type U, which the file doesn't define as an integer type/);
  // A const block with a comment on its opening line is read; a type declaration in a form the reader doesn't read fails.
  assert.deepEqual(readGoEnums("type T int8 // Codes.\nconst ( // The codes.\n\tA T = 1 // One,\n\t        // continued.\n)\n", "t.go")[0]!.values.map((v) => [v.name, v.comment]), [["A", "One, continued."]]);
  assert.throws(() => readGoEnums("type (\n\tT int8\n)\n", "t.go"), /a type declaration the reader can't read/);
});

test("every snapshot holds its whole folder at the pinned tree and its license at the pinned blob, so no file can be left out", () => {
  for (const s of SOURCES.sources) {
    const files = FILES.get(s.id)!;
    assert.equal(treeSha(files, s.folder), s.tree, s.id);
    assert.equal(blobSha(files.get(s.license.path)!), s.license.blob, s.id);
  }
  // Prebid's folder holds the objects' files, its tests, a README, and test data; the reader reads its 94 Go files that aren't tests.
  assert.equal(readFiles(SOURCES.sources[1]!, FILES.get("prebid-openrtb")!).length, 94);
  assert.deepEqual(checkEnumDriftSnapshots(SOURCES, FILES, "/nonexistent").problems, []);
});

test("a reachable clone must have the commit and the pinned tree and license", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "enum-drift-clone-"));
  const sh = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" }).stdout.trim();
  sh("init", "-q");
  mkdirSync(join(dir, "enums"));
  writeFileSync(join(dir, "enums", "e.proto"), "enum A {\n  ONE = 1;\n}\n");
  writeFileSync(join(dir, "LICENSE"), "License.\n");
  sh("add", ".");
  spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "c"]);
  const commit = sh("rev-parse", "HEAD");
  const files = new Map([["s", new Map([["enums/e.proto", Buffer.from("enum A {\n  ONE = 1;\n}\n")], ["LICENSE", Buffer.from("License.\n")]])]]);
  const source = { id: "s", title: "S", upstream: "https://github.com/example/s", commit, clone: dir, reader: "proto" as const, folder: "enums", tree: sh("rev-parse", "HEAD:enums"), license: { path: "LICENSE", blob: sh("rev-parse", "HEAD:LICENSE") } };
  const sources = (x: Partial<typeof source>): EnumDriftSources => ({ format: 1, lock: "main", sources: [{ ...source, ...x }], lists: [], file: "sources.yaml" });
  assert.equal(treeSha(files.get("s")!, "enums"), source.tree, "the tree hash is git's");
  const ok = checkEnumDriftSnapshots(sources({}), files, "/");
  assert.deepEqual(ok.problems, []);
  assert.match(ok.notes[0]!, /checked against its pins and the clone/);
  assert.match(checkEnumDriftSnapshots(sources({ commit: "0".repeat(40) }), files, "/").problems.join(), /has no commit 0000000000000000000000000000000000000000/);
  // A snapshot that agrees with its pins and a clone that doesn't: the clone's tree is another.
  const other = new Map([["s", new Map([["enums/e.proto", Buffer.from("enum A {\n  TWO = 2;\n}\n")], ["LICENSE", Buffer.from("License.\n")]])]]);
  const tree = treeSha(other.get("s")!, "enums");
  assert.match(checkEnumDriftSnapshots(sources({ tree }), other, "/").problems.join(), new RegExp(`enums at ${commit.slice(0, 7)} in .* is tree ${source.tree}, not the pinned ${tree}`));
});

test("the enum drift report reproduces the survey: adcom-proto misses 37 codes in 9 lists and has no enum for 6, and Prebid's types miss 29 codes in 7 lists", async () => {
  const b = await build();
  const { doc, problems } = compareEnumDrift({ sources: SOURCES, ir: b.ir, model: b.model, files: FILES });
  assert.deepEqual(problems, []);
  const t = doc.totals;
  assert.deepEqual([t["adcom-proto"]!.missing, t["adcom-proto"]!.listsMissing, t["adcom-proto"]!.noEnum], [37, 9, 6]);
  assert.deepEqual([t["prebid-openrtb"]!.missing, t["prebid-openrtb"]!.listsMissing, t["prebid-openrtb"]!.noEnum], [29, 7, 0]);
  assert.deepEqual([t["adcom-proto"]!.extra, t["prebid-openrtb"]!.extra], [0, 0]);
  // Both still define the two lists whose tables AdCOM removed.
  assert.deepEqual([t["adcom-proto"]!.removedKept, t["prebid-openrtb"]!.removedKept], [2, 2]);
  const at = (list: string, source: string) => doc.lists.find((l) => l.list === list)!.drift.find((d) => d.source === source)!;
  assert.deepEqual(at("list_auditstatuscodes", "adcom-proto").missing.map((m) => m.value), [6]);
  assert.deepEqual(at("list_playbackmethods", "prebid-openrtb").missing.map((m) => m.value), [8, 9, 10, 11]);
  // A 0 named "unknown" is a sentinel where the list has no code 0; Placement Positions' 0 is a code.
  assert.equal(at("list_devicetypes", "adcom-proto").sentinel?.name, "DeviceType_UNKNOWN");
  assert.equal(at("list_placementpositions", "prebid-openrtb").sentinel, null);
  // Prebid's FeedType is an int8, which can't hold a vendor's code from 500.
  assert.deepEqual(at("list_feedtypes", "prebid-openrtb").narrow, { type: "int8", max: 127, codes: [], vendor: true });
  // adcom-proto's comment on code 5 of Category Taxonomies says 1.1 where its name and the registry say 2.1.
  assert.deepEqual(at("list_categorytaxonomies", "adcom-proto").versions.map((v) => [v.value, v.name]), [[5, "IAB_CONTENT_CAT_TAX_2_1"]]);
  assert.equal(t["adcom-proto"]!.versions + t["prebid-openrtb"]!.versions, 1);
});

test("an enum value the list doesn't hold is extra unless a vendor range or a >0 row covers it", async () => {
  const b = await build();
  const files = new Map([...FILES].map(([id, m]) => [id, new Map(m)]));
  const go = files.get("prebid-openrtb")!;
  const patch = (path: string, f: (t: string) => string) => go.set(path, Buffer.from(f(go.get(path)!.toString("utf8"))));
  patch("adcom1/device_type.go", (t) => t.replace(/\n\)/, "\n\tDeviceNine DeviceType = 9\n)"));
  patch("adcom1/api_framework.go", (t) => t.replace(/\n\)/, "\n\tAPIVendor APIFramework = 501\n)"));
  patch("adcom1/start_delay.go", (t) => t.replace(/\n\)/, "\n\tStartThirty StartDelay = 30\n)"));
  const { doc } = compareEnumDrift({ sources: SOURCES, ir: b.ir, model: b.model, files });
  const at = (list: string) => doc.lists.find((l) => l.list === list)!.drift.find((d) => d.source === "prebid-openrtb")!;
  assert.deepEqual(at("list_devicetypes").extra.map((x) => x.value), [9]);
  assert.deepEqual(at("list_apiframeworks").extra, []);
  assert.deepEqual(at("list_startdelaymodes").extra, []);
});

test("the sources must pair every list once and every enum once", async () => {
  const b = await build();
  const run = (s: EnumDriftSources) => compareEnumDrift({ sources: s, ir: b.ir, model: b.model, files: FILES }).problems;
  assert.ok(run({ ...SOURCES, lists: [...SOURCES.lists, { list: "list_nothing", enums: { "adcom-proto": null, "prebid-openrtb": null } }] }).some((p) => p.includes("names the list list_nothing, which the registry doesn't hold")));
  assert.ok(run({ ...SOURCES, lists: SOURCES.lists.map((l) => (l.list === "list_devicetypes" ? { ...l, enums: { "adcom-proto": "DeviceType" } } : l)) }).some((p) => p.includes("list_devicetypes says nothing of prebid-openrtb")));
});

test("the committed report is what the sources and the registry give", async () => {
  const { readFileSync } = await import("node:fs");
  const { files, problems } = await enumDriftFiles(ADCOM);
  assert.deepEqual(problems, []);
  for (const [name, text] of files) assert.equal(readFileSync(join(ADCOM, "enum-drift", name), "utf8"), text, name);
});

test("git keeps every snapshot file byte for byte, so its pinned tree and blob hashes hold on every checkout", async () => {
  const { spawnSync } = await import("node:child_process");
  const sources = loadEnumDriftSources(ADCOM);
  const paths = sources.sources.flatMap((s) => [...allSnapshotFiles(ADCOM, sources).get(s.id)!.keys()].map((p) => join("enum-drift", "snapshots", s.id, p)));
  assert.ok(paths.length > 90, `${paths.length} snapshot files`);
  const out = spawnSync("git", ["check-attr", "text", "--", ...paths], { cwd: ADCOM, encoding: "utf8" }).stdout.trim().split("\n");
  assert.deepEqual(out.filter((l) => !l.endsWith(": text: unset")), []);
});
