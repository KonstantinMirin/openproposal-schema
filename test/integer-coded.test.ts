import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { codeTitle, codeTitles } from "../src/emit.ts";
import { installFormats } from "../src/formats.ts";
import { ROOT } from "./helpers.ts";

const dir = join(ROOT, "specs", "adcom", "schemas");
const LISTS = JSON.parse(readFileSync(join(dir, "modules", "lists", "1", "lists.json"), "utf8")) as { $id: string; $defs: Record<string, Record<string, unknown>> };
const KERNEL = JSON.parse(readFileSync(join(dir, "kernel", "1", "kernel.json"), "utf8"));
const ajv = new Ajv2020({ strict: true, allErrors: true });
installFormats(ajv);
ajv.addSchema(KERNEL);
ajv.addSchema(LISTS);
const validator = (def: string) => ajv.getSchema(`${LISTS.$id}#/$defs/${def}`)!;

test("an integer-coded vocabulary is type integer with a titled const branch per code, and its vendor range a branch of its own", () => {
  const api = LISTS.$defs.ApiFramework!;
  assert.equal(api.type, "integer");
  assert.equal(api.title, "List: API Frameworks");
  assert.equal(api.enum, undefined);
  const branches = api.oneOf as Record<string, unknown>[];
  assert.deepEqual(branches[5], { const: 6, title: "MRAID 3.0" });
  assert.deepEqual(branches.at(-1), { type: "integer", minimum: 500, title: "Vendor-specific", description: "Vendor-specific codes." });
  const v = validator("ApiFramework");
  for (const [x, ok] of [[7, true], [500, true], [100000, true], [10, false], [499, false], [0, false], [6.5, false], ["6", false]] as const) assert.equal(v(x), ok, String(x));
  // A row that starts with its own name is titled by it, and keeps its text as the description.
  const plcmt = (LISTS.$defs.PlcmtSubtypeVideo!.oneOf as Record<string, unknown>[])[0]!;
  assert.equal(plcmt.title, "Instream");
  assert.match(String(plcmt.description), /^Instream: Pre-roll, mid-roll/);
});

test("an extension that would match a code leaves the code to its own branch, so each value matches one branch", () => {
  const start = LISTS.$defs.StartDelayMode!;
  const ext = (start.oneOf as Record<string, unknown>[]).at(-1)!;
  assert.deepEqual(ext.not, { const: 0 });
  // No enum anywhere in the file holds an integer.
  const enums: unknown[][] = [];
  JSON.stringify(LISTS, (k, v) => (k === "enum" && Array.isArray(v) ? (enums.push(v), v) : v));
  assert.deepEqual(enums.filter((e) => e.some((x) => Number.isInteger(x))), []);
  const v = validator("StartDelayMode");
  for (const [x, ok] of [[0, true], [-1, true], [-2, true], [5, true], [-3, false], [1.5, false]] as const) assert.equal(v(x), ok, String(x));
});

test("a code's title is its row's own name before a colon, or else its whole text", () => {
  assert.equal(codeTitle("Instream: Pre-roll ads"), "Instream");
  assert.equal(codeTitle("MRAID 3.0"), "MRAID 3.0");
  assert.equal(codeTitle("Initiated by idling (e.g. screensaver), Sound on"), "Initiated by idling (e.g. screensaver), Sound on");
});

test("a list's code names are unique and readable: a class two codes share is no name, a URL's colon splits nothing, and a long row is cut at its first clause", () => {
  assert.deepEqual(codeTitles([{ value: 1, annotation: "AOD: Music streaming service" }, { value: 3, annotation: "AOD: Podcast" }, { value: 2, annotation: "LIVE: FM/AM broadcast" }, { value: 5, annotation: "LIVE: Simulcast" }]), ["Music streaming service", "Podcast", "FM/AM broadcast", "Simulcast"]);
  assert.equal(codeTitle("DPAA Device Venue Types https://github.com/x/y#a"), "DPAA Device Venue Types");
  assert.equal(codeTitle("IAB Tech Lab Content Category Taxonomy 1.0: Deprecated, and recommended"), "IAB Tech Lab Content Category Taxonomy 1.0");
  assert.equal(codeTitle("- Primarily video content."), "Primarily video content");
  assert.equal(codeTitle("Continuous Playback - Media playback is set to play additional media automatically without user interaction."), "Continuous Playback");
  assert.deepEqual(codeTitles([{ value: 1, annotation: "Same" }, { value: 2, annotation: "Same" }]), ["Same (1)", "Same (2)"]);
  for (const [name, def] of Object.entries(LISTS.$defs)) {
    const titles = (def.oneOf as Record<string, unknown>[]).filter((b) => "const" in b).map((b) => String(b.title));
    assert.equal(new Set(titles).size, titles.length, name);
  }
});

test("§ 5.2.2's reward, instl, and skip are the kernel's IntegerFlag, titled 0 (No) and 1 (Yes), in both variants with the open PRs, and main has none", async () => {
  const { withImports } = await import("../src/imports.ts");
  const { readdirSync } = await import("node:fs");
  const op = join(ROOT, "specs", "openproposal", "schemas");
  const tree = (sub: string) => {
    const files: { path: string; schema: Record<string, unknown>; text: string }[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(join(op, sub, d), { withFileTypes: true })) {
        const rel = d === "" ? e.name : `${d}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith(".json") && e.name !== "release.json") {
          const text = readFileSync(join(op, sub, rel), "utf8");
          files.push({ path: rel, schema: JSON.parse(text), text });
        }
      }
    };
    for (const d of ["kernel", "modules", "documents"]) walk(d);
    return files;
  };
  for (const sub of ["with-open-prs", join("as-written", "with-open-prs")]) {
    const a = new Ajv2020({ strict: true, allErrors: true });
    installFormats(a);
    for (const f of withImports(tree(sub))) a.addSchema(f.schema);
    const kernel = tree(sub).find((f) => f.path === "kernel/1/kernel.json")!.schema as { $id: string; $defs: Record<string, Record<string, unknown>> };
    assert.deepEqual(kernel.$defs.IntegerFlag!.oneOf, [{ const: 0, title: "No" }, { const: 1, title: "Yes" }], sub);
    const inventory = tree(sub).find((f) => f.path === "modules/inventory/1/inventory.json")!.schema as { $id: string };
    const placement = a.getSchema(`${inventory.$id}#/$defs/Placement`)!;
    for (const key of ["reward", "instl", "skip"]) {
      for (const [x, ok] of [[0, true], [1, true], [true, false], [false, false], [2, false], [-1, false], ["1", false]] as const) assert.equal(placement({ [key]: x }), ok, `${sub} ${key}=${JSON.stringify(x)}`);
    }
  }
  // main writes no § 5.2.2 keys, so it has no flag of this kind.
  assert.doesNotMatch(readFileSync(join(op, "kernel", "1", "kernel.json"), "utf8"), /IntegerFlag/);
});

test("titled codes are an integer type and two or more titled integer consts, each code and title once, and nothing else", async () => {
  const { isTitledCodes } = await import("../src/conventions.ts");
  const ok = { type: "integer", oneOf: [{ const: 0, title: "No" }, { const: 1, title: "Yes", description: "A yes." }] };
  assert.equal(isTitledCodes(ok), true);
  for (const bad of [
    { ...ok, type: "string" },
    { ...ok, oneOf: [{ const: 0, title: "No" }] },
    { ...ok, oneOf: [{ const: 0, title: "No" }, { const: 1 }] },
    { ...ok, oneOf: [{ const: 0, title: "No" }, { const: 0, title: "Yes" }] },
    { ...ok, oneOf: [{ const: 0, title: "No" }, { const: 1, title: "No" }] },
    { ...ok, oneOf: [{ const: 0, title: "No" }, { const: 1.5, title: "Yes" }] },
    { ...ok, oneOf: [{ const: 0, title: "No" }, { const: 1, title: "Yes", minimum: 0 }] },
    { ...ok, oneOf: [{ const: 0, title: "No" }, { type: "integer", minimum: 500, title: "Vendor-specific" }] },
  ]) assert.equal(isTitledCodes(bad), false, JSON.stringify(bad));
});
