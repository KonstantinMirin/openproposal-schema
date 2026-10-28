import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importedLists, registryFiles, rowLabel, withImports } from "../src/imports.ts";
import { loadKernel } from "../src/kernel.ts";
import { ROOT, SPEC } from "./helpers.ts";

const ADCOM = { spec: "adcom", lock: "main" };
const LISTS_ID = "https://adtechspec.noetis.dev/adcom/schemas/modules/lists/1/lists.json";

test("a list a spec imports comes from the registry's committed outputs: its codes, labels, vendor range, URL at the lock's commit, and vocabulary", () => {
  const lists = importedLists(ADCOM);
  assert.equal(lists.length, 42, "every AdCOM list with codes");
  const api = lists.find((l) => l.name === "List: API Frameworks")!;
  assert.equal(api.standard, "AdCOM 1.0");
  assert.equal(api.url, "https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#list_apiframeworks");
  assert.deepEqual(api.codes.map((c) => c.code), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(api.vendor, { from: 500, label: "Vendor-specific codes" });
  assert.deepEqual(api.registry, { schema: LISTS_ID, def: "ApiFramework" });
  const plcmt = lists.find((l) => l.name === "List: Plcmt Subtypes - Video")!;
  assert.deepEqual(plcmt.codes.slice(0, 3), [{ code: 1, label: "Instream" }, { code: 2, label: "Accompanying Content" }, { code: 3, label: "Interstitial" }]);
  assert.equal(plcmt.registry!.def, "PlcmtSubtypeVideo");
});

test("a row's label is its own name before a colon, or else its whole text", () => {
  assert.equal(rowLabel("Instream: Pre-roll, mid-roll, and post-roll ads"), "Instream");
  assert.equal(rowLabel("Interstitial:Video ads that are played without video content."), "Interstitial");
  assert.equal(rowLabel("Initiated by idling (e.g. screensaver), Sound on"), "Initiated by idling (e.g. screensaver), Sound on");
  assert.equal(rowLabel("VPAID 1.0"), "VPAID 1.0");
});

test("OpenProposal's kernel takes AdCOM's lists from the registry, and copies none of them", () => {
  const kernel = loadKernel(ROOT, SPEC);
  const kept = readFileSync(join(ROOT, "kernel", "lists.yaml"), "utf8");
  for (const name of ["List: Plcmt Subtypes - Video", "List: Playback Methods", "List: API Frameworks"]) {
    assert.ok(!kept.includes(name), `kernel/lists.yaml copies ${name}`);
    assert.equal(kernel.lists!.lists.find((l) => l.name === name)?.registry?.schema, LISTS_ID, name);
  }
  // AdCOM imports nothing, so its kernel holds the kernel's own lists alone.
  assert.ok(loadKernel(ROOT, join(ROOT, "specs", "adcom")).lists!.lists.every((l) => l.registry === undefined));
});

test("a schema tree loads with the registry files its cross-host references name, and theirs in turn", () => {
  const tree = [{ path: "a.json", schema: { $id: "https://example.com/a.json", $ref: `${LISTS_ID}#/$defs/ApiFramework` }, text: "" }];
  const all = withImports(tree);
  assert.deepEqual(all.map((f) => String(f.schema.$id)), ["https://example.com/a.json", LISTS_ID]);
  // A registry file's own relative references bring their files too.
  const kernelRef = [{ path: "b.json", schema: { $id: "https://example.com/b.json", $ref: "https://adtechspec.noetis.dev/adcom/schemas/modules/lists/1/../../../kernel/1/kernel.json#/$defs/VendorCode" }, text: "" }];
  assert.deepEqual(withImports(kernelRef).map((f) => String(f.schema.$id)), ["https://example.com/b.json", "https://adtechspec.noetis.dev/adcom/schemas/kernel/1/kernel.json"]);
  assert.deepEqual(withImports([]), []);
  assert.equal(registryFiles(ADCOM).length, 2);
  assert.throws(() => registryFiles({ spec: "adcom", lock: "nope" }), /imports the lock "nope" of adcom, which adcom doesn't have/);
});

test("a file with no absolute $id, or a reference that is no URL, loads as it is, with nothing added", () => {
  const tree = [{ path: "broken.json", schema: { $ref: "other.json#/$defs/X", properties: { a: { $ref: "::not a url" } } }, text: "" }];
  assert.equal(withImports(tree).length, 1);
});

test("every list a spec imports holds its registry vocabulary's codes and openness, negative codes and an extension row included", () => {
  const schema = JSON.parse(readFileSync(join(ROOT, "specs", "adcom", "schemas", "modules", "lists", "1", "lists.json"), "utf8")) as { $defs: Record<string, { oneOf: Record<string, unknown>[] }> };
  for (const l of importedLists(ADCOM)) {
    const def = schema.$defs[l.registry!.def]!;
    assert.deepEqual(l.codes.map((c) => c.code).sort((a, b) => Number(a) - Number(b)), def.oneOf.filter((b) => "const" in b).map((b) => b.const as number).sort((a, b) => a - b), l.name);
    assert.equal(l.vendor !== undefined || l.extension !== undefined, def.oneOf.some((b) => !("const" in b)), `${l.name} is open exactly when its vocabulary is`);
  }
  const start = importedLists(ADCOM).find((l) => l.name === "List: Start Delay Modes")!;
  assert.deepEqual([start.codes.map((c) => c.code), start.extension], [[0, -1, -2], ">0"]);
});
