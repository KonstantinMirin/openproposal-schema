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
  // A gloss, a parenthesized "i.e." or "e.g." aside or such a tail, is no part of the name; any other aside is.
  assert.equal(codeTitle("Initiated by idling (e.g. screensaver), Sound on"), "Initiated by idling, Sound on");
  assert.equal(codeTitle("Text (i.e., primarily textual document such as a web page, eBook, or news article)"), "Text");
  assert.equal(codeTitle("A person-based ID, i.e., that is the same across devices."), "A person-based ID");
  assert.equal(codeTitle("active (i.e. deal is actively serving impressions)"), "active");
  assert.equal(codeTitle("complete (ie. buying system shows deal has completed)"), "complete");
  assert.equal(codeTitle("deal is complete (ie. selling scomplete (ie. selling system shows deal has completed)"), "deal is complete");
  assert.equal(codeTitle("AdCom DOOH Venue Types (deprecated)"), "AdCom DOOH Venue Types (deprecated)");
  assert.equal(codeTitle("51Degrees (High Confidence)"), "51Degrees (High Confidence)");
  // A name before a colon with no space after it is a name too; a URL's colon, and one a digit follows, name nothing.
  assert.equal(codeTitle("Interstitial:Video ads that are played without video content"), "Interstitial");
  assert.equal(codeTitle("Time:Time-based refresh"), "Time");
  assert.equal(codeTitle("See https://example.com/a: the list"), "See the list");
  assert.equal(codeTitle("Aspect 16:9 video"), "Aspect 16:9 video");
  // A colon a lowercase letter follows, or one inside parentheses, names nothing; a gloss is lowercase, kept whole with its parentheses, and a tail only outside them.
  assert.equal(codeTitle("urn:iab:x"), "urn:iab:x");
  assert.equal(codeTitle("mailto:x@y"), "mailto:x@y");
  assert.equal(codeTitle("Foo (see:Bar) baz"), "Foo (see:Bar) baz");
  assert.equal(codeTitle("Category (deprecated, e.g. old)"), "Category (deprecated, e.g. old)");
  assert.equal(codeTitle("Browser IE. 11 only"), "Browser IE. 11 only");
  assert.equal(codeTitle("Foo (i.e., bar (baz) qux)"), "Foo");
});

test("a name a decision gives a code titles it in place of its row's, and only an entry citing a decision may give one", async () => {
  assert.deepEqual(codeTitles([{ value: 1, annotation: "Initiates without any specific user interaction with Sound On", title: "Automatic with Sound On" }, { value: 3, annotation: "Initiates on Click with Sound On" }]), ["Automatic with Sound On", "Initiates on Click with Sound On"]);
  const { diffModels } = await import("../src/release.ts");
  const vocab = (title?: string) => ({ format: 1, types: [{ name: "V", kind: "vocabulary", module: "m", terms: [{ value: 1, annotation: "Row", ...(title ? { title } : {}), sources: ["x"] }] }] });
  assert.deepEqual(diffModels(vocab() as never, vocab("Short") as never).map((c) => [c.class, c.detail]), [["annotation", 'V 1\'s name changes']]);
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

test("a standing record's names title the codes it quotes, and a withdrawn record names none", async () => {
  const { resolveBuild } = await import("../src/builds.ts");
  const { loadKernel } = await import("../src/kernel.ts");
  const { loadConstructors } = await import("../src/constructors.ts");
  const { loadDecisions, loadMappings } = await import("../src/mapping.ts");
  const { loadLock } = await import("../src/lock.ts");
  const adcom = join(ROOT, "specs", "adcom");
  const build = (withdraw: boolean, elsewhere = false) => {
    const decisions = loadDecisions(join(adcom, "decisions")).map((d) => (withdraw && d.id === "D-019" ? { ...d, status: "withdrawn" as const, withdrawn: { date: "2026-10-28", reason: "A test." } } : elsewhere && d.id === "D-019" ? { ...d, covers: d.covers.map((c) => ({ ...c, locks: ["tag-202607"] })) } : d));
    const b = resolveBuild({ root: adcom, mappings: loadMappings(join(adcom, "mapping")), decisions, kernel: loadKernel(ROOT, adcom), constructors: loadConstructors(ROOT, adcom), lock: loadLock(join(adcom, "spec-input", "spec-lock.yaml")) });
    const t = b.model.types.find((x) => x.name === "AgentType")!;
    return t.kind === "vocabulary" ? { titles: codeTitles(t.terms), decisions: t.decisions } : null;
  };
  const standing = build(false)!;
  assert.deepEqual(standing.titles, ["Browser or device ID", "In-app impressions", "Person-based ID"]);
  assert.ok(standing.decisions.includes("D-019"));
  const withdrawn = build(true)!;
  assert.deepEqual(withdrawn.titles, ["An ID which is tied to a specific web browser or device", "In-app impressions", "A person-based ID"]);
  // Every decided name fits a code name's 48 characters and is its list's only one.
  const named = Object.entries(LISTS.$defs).flatMap(([, def]) => (def.oneOf as Record<string, unknown>[]).filter((b) => "const" in b).map((b) => String(b.title)));
  for (const t of ["Initiates on Mouse-Over with Sound On", "Podcast", "Shaky, Flashing, or Extreme Animation", "On Leaving Viewport Continues as Floating Unit"]) {
    const list = Object.values(LISTS.$defs).find((def) => (def.oneOf as Record<string, unknown>[]).some((b) => b.title === t))!;
    const titles = (list.oneOf as Record<string, unknown>[]).filter((b) => "const" in b).map((b) => String(b.title));
    assert.ok(named.includes(t), t);
    assert.ok(t.length <= 48, t);
    assert.equal(titles.filter((x) => x === t).length, 1, t);
  }
  // A record that quotes the rows only on another lock names nothing on main.
  assert.deepEqual(build(false, true)!.titles, withdrawn.titles);
});
