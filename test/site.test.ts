import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexElements } from "../src/elements.ts";
import { loadLock } from "../src/lock.ts";
import { loadProvenance } from "../src/provenance.ts";
import { assetTokens, buildSite, checkSite, exportTree, fillTokens, hardCodedNames, LINKED_FOLDERS, scrollRegions } from "../src/site/build.ts";
import { brandOf, loadSiteConfig, named } from "../src/site/config.ts";
import { decisionGroups, switches } from "../src/site/pages.ts";
import { specOf } from "../src/specs/index.ts";
import { loadSiteInputs, sourceInfos } from "../src/site/data.ts";
import { elementLabel, sourceInfo } from "../src/site/sources.ts";
import { ROOT, SPEC } from "./helpers.ts";

const CONFIG = loadSiteConfig();
const INPUTS = loadSiteInputs(SPEC, CONFIG);
const TREE = exportTree();
const ADCOM = loadSiteInputs(join(ROOT, "specs", "adcom"), CONFIG);
/** OpenProposal's pages, with the registry its schemas reference, whose pages its type map links. */
const SITE = buildSite([INPUTS, ADCOM], CONFIG, TREE);
/** OpenProposal's pages are under its path on the site. */
const OP = "openproposal/";
const at = (path: string) => SITE.files.get(`${OP}${path}`)!;
const MAIN = loadLock(join(SPEC, "spec-input", "spec-lock.yaml"));
const PRS = loadLock(join(SPEC, "spec-input", "with-open-prs.lock.yaml"));

test("an element's label reads as a citation", () => {
  assert.equal(elementLabel("field:5.10:billing#description/object:1"), "§ 5.10, the `billing` row's description: the inline object");
  assert.equal(elementLabel("key:5.6.1:commitment.flight_start"), "§ 5.6.1, the `commitment.flight_start` key row");
  assert.equal(elementLabel("field:5.7:reporting#description/object:1/feed_type"), "§ 5.7, the `reporting` row's description: the inline object's `feed_type` values");
  assert.equal(elementLabel("def:5.1.1:channel.dooh"), "§ 5.1.1, the definition of `dooh` for `channel`");
  assert.equal(elementLabel("code:5.6.3:1"), "§ 5.6.3, code block 1");
  assert.equal(elementLabel("rule:front:ceff832d"), "The front matter, a requirement");
});

test("a main element links its lines at the lock's commit, and a code block spans its fences", () => {
  const elements = indexElements(INPUTS.irs.get("main")!);
  const s = sourceInfo(MAIN, null, "field:4.1:proposal_id", elements.get("field:4.1:proposal_id")!);
  assert.equal(s.links.length, 1);
  assert.equal(s.links[0]!.href, `https://github.com/IABTechLab/OpenProposal/blob/${MAIN.commit}/spec/openproposal-3.0.md?plain=1#L${s.lines[0]}`);
  const code = [...elements.values()].find((e) => e.kind === "code_block")!;
  const c = sourceInfo(MAIN, null, code.element.id, code);
  assert.ok(c.lines[1] > c.lines[0], "a code block spans more than one line");
  assert.match(c.links[0]!.href, /#L\d+-L\d+$/);
});

test("an open-PRs element links the PR that wrote its line, or says why it can't", () => {
  const elements = indexElements(INPUTS.irs.get("with-open-prs")!);
  const provenance = loadProvenance(SPEC, PRS);
  assert.ok(provenance, "the open-PRs lock has its line provenance");
  const time = sourceInfo(PRS, provenance, "field:5.5:time_zone", elements.get("field:5.5:time_zone")!);
  assert.match(time.links[0]!.text, / in #\d+$/);
  assert.match(time.links[0]!.href, /^https:\/\/github\.com\/IABTechLab\/OpenProposal\/blob\/[0-9a-f]{40}\//);
  const none = sourceInfo(PRS, null, "field:5.5:time_zone", elements.get("field:5.5:time_zone")!);
  assert.equal(none.links.length, 0);
  assert.ok(none.note);
});

test("the site builds clean, with a page per decision record and every schema at its $id path", () => {
  assert.deepEqual(SITE.problems, []);
  // Each record that stands has a page; a withdrawn one, as D-039, has none.
  for (const d of INPUTS.decisions) assert.equal(SITE.files.has(`${OP}decisions/${d.id}.html`), d.status !== "withdrawn" && d.status !== "superseded", d.id);
  assert.ok(!SITE.files.has(`${OP}decisions/D-039.html`));
  const kernel = JSON.parse(SITE.files.get(OP + "schemas/as-written/kernel/1/kernel.json")!.toString("utf8")) as { $id: string };
  assert.equal(kernel.$id, "https://openproposal.noetis.dev/schemas/as-written/kernel/1/kernel.json");
});

test("the site's check catches a broken link, an inline script, and a local path", () => {
  const page = (html: string) => new Map([...SITE.files, [`${OP}x.html`, Buffer.from(html)]]);
  assert.match(checkSite(page('<a href="nowhere.html">x</a>')).join("\n"), /links nowhere\.html/);
  assert.match(checkSite(page("<script>1</script>")).join("\n"), /a script without src/);
  assert.match(checkSite(page("<p>file:///a/b</p>")).join("\n"), /names a local path/);
});

test("no stylesheet rule makes a region scroll inside a page, and the check catches one that does", () => {
  for (const [path, data] of SITE.files) if (path.endsWith(".css")) assert.deepEqual(scrollRegions(data.toString("utf8")), [], path);
  assert.deepEqual(scrollRegions(".a { overflow: hidden; } .b { overflow-x: clip; max-height: none; } .c { overflow-wrap: anywhere; }"), []);
  assert.deepEqual(scrollRegions("/* overflow: auto */ .jsontree { padding: 0; overflow: auto; max-height: 520px; }\n@media (max-width: 9px) { ul.x { overflow-y: scroll } }"), [
    ".jsontree sets overflow: auto, which scrolls inside the page",
    ".jsontree sets max-height: 520px, which caps its height",
    "ul.x sets overflow-y: scroll, which scrolls inside the page",
  ]);
  const css = new Map([...SITE.files].map(([p, b]) => [p, p === `${OP}assets/site.css` ? Buffer.concat([b, Buffer.from("\n.tree-files { overflow-x: auto; }\n")]) : b]));
  assert.match(checkSite(css).join("\n"), /assets\/site\.css: \.tree-files sets overflow-x: auto, which scrolls inside the page/);
  const js = new Map([...SITE.files].map(([p, b]) => [p, p === `${OP}assets/jsontree.js` ? Buffer.concat([b, Buffer.from("\ntree.style.maxHeight = '520px';\n")]) : b]));
  assert.match(checkSite(js).join("\n"), /assets\/jsontree\.js: sets an overflow or a height cap/);
});

test("a JSON tree opens two levels deep and offers no fixed height", () => {
  const tree = SITE.files.get(OP + "assets/jsontree.js")!.toString("utf8");
  assert.doesNotMatch(tree, /Full height|Fixed height/);
  assert.match(tree, /opts\.open = 2/);
  assert.match(SITE.files.get(OP + "assets/map.js")!.toString("utf8"), /JsonTree\.render\(box, em\.schema, \{ open: 2,/);
});

test("the site builds no archive and offers no download, and links each build's folders in the public repository, each a path the export publishes", () => {
  assert.deepEqual([...SITE.files.keys()].filter((p) => /\.zip$|\/downloads\//.test(p)), []);
  const files = at("downloads.html").toString("utf8");
  assert.doesNotMatch(files, /\sdownload[\s>]/);
  const links = [...files.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!).filter((l) => l.startsWith(`${CONFIG.repo}/`));
  for (const want of ["tree/main/specs/openproposal/schemas/as-written", "tree/main/specs/openproposal/schemas/with-open-prs", "blob/main/specs/openproposal/rules/as-written/rules.json", "blob/main/specs/openproposal/type-examples/examples.json", "tree/main/sdk/ts", "tree/main/sdk/proposed/with-open-prs/go"]) {
    assert.ok(links.includes(`${CONFIG.repo}/${want}`), want);
  }
  for (const l of links) assert.ok(TREE.has(l.replace(/^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:tree|blob)\/main\//, "")), l);
  assert.deepEqual(LINKED_FOLDERS, ["sdk", "specs"]);
  assert.ok(!TREE.has("docs/design/type-rules.md") && TREE.has("specs/openproposal/decisions/D-001.yaml"));
  // A link into the repository at a path the export doesn't publish fails the site's check.
  const bad = new Map([...SITE.files, [`${OP}x.html`, Buffer.from(`<a href="${CONFIG.repo}/tree/main/specs/openproposal/nothing">x</a>`)]]);
  assert.match(checkSite(bad, { repo: CONFIG.repo, tree: TREE }).join("\n"), /x\.html: links .*specs\/openproposal\/nothing, which names no tracked path under sdk\/ or specs\//);
});

test("the root page leads with why a standard needs an executable specification, then lists every spec under its path", () => {
  const root = SITE.files.get("index.html")!.toString("utf8");
  const main = root.match(/<main[\s\S]*<\/main>/)![0];
  assert.ok(main.indexOf("executable") < main.indexOf("The specifications"));
  assert.match(main, /isn&#39;t an IAB Tech Lab artifact/);
  assert.match(main, /href="openproposal\/index\.html"/);
  assert.ok(SITE.files.has("404.html") && SITE.files.has("robots.txt") && !SITE.files.has(`${OP}404.html`));
  for (const f of ["assets/site.css", "assets/site.js", "assets/theme.js", "assets/icon.svg"]) assert.ok(SITE.files.has(f), f);
  // The not-found page's links start at the root, once: none names another host.
  const missing = SITE.files.get("404.html")!.toString("utf8");
  assert.doesNotMatch(missing, /href="\/\//);
  assert.match(missing, /<nav aria-label="Site"><a href="\/openproposal\/index\.html">/);
  assert.equal(/<meta name="description" content="([^"]*)">/.exec(root)![1], "In the era of agentic development, every standard needs an executable specification, not only prose that agents and implementers have to interpret.");
});

test("a spec with no departures and no feedback yet gets no variant switch, and its decisions are listed by kind", () => {
  const one = { ...INPUTS, variants: INPUTS.variants.filter((v) => v.slug === "as-written"), feedback: null };
  assert.doesNotMatch(switches("map", one), /aria-label="Variant"/);
  assert.match(switches("map", INPUTS), /aria-label="Variant"/);
  const groups = decisionGroups(one);
  assert.deepEqual(groups.map((g) => g.title), ["Points the text leaves open", "Changes we propose"]);
  assert.equal(groups.flatMap((g) => g.decisions).length, INPUTS.decisions.filter((d) => d.status !== "superseded" && d.status !== "withdrawn").length);
});

test("git ignores no source, gate, script, test, or tool file", () => {
  // A pattern such as `site/` once matched `src/site/`, so CI had no site builder while every local run passed.
  const r = spawnSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "src", "gates", "scripts", "test", "tools"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const ignored = r.stdout.split("\n").filter((p) => p !== "" && !p.includes("__pycache__/") && !p.includes("/node_modules/"));
  assert.deepEqual(ignored, []);
});

test("the How it's built page is in the top navigation of every page of the spec and linked from its landing page", () => {
  assert.ok(SITE.files.has(OP + "how-it-is-built.html"));
  for (const [path, data] of SITE.files) {
    if (!path.endsWith(".html") || !path.startsWith(OP)) continue;
    assert.match(data.toString("utf8"), /<nav aria-label="Site">.*href="(?:\.\.\/|\/)*how-it-is-built\.html"[^>]*>How it's built<\/a>/, path);
  }
  assert.equal((SITE.files.get(OP + "index.html")!.toString("utf8").match(/<main[\s\S]*<\/main>/)![0].match(/href="how-it-is-built\.html"/g) ?? []).length, 2);
});

test("the How it's built page's worked example shows the build's own element, schema, and example value", () => {
  const html = SITE.files.get(OP + "how-it-is-built.html")!.toString("utf8");
  const ir = INPUTS.irs.get("main")!;
  const row = ir.fields.find((f) => f.id === "field:5.4:formats")!;
  assert.ok(html.includes(`<code class="digest">${row.digest}</code>`), "the row's digest");
  const def = (JSON.parse(SITE.files.get(OP + "schemas/as-written/modules/creative/1/creative.json")!.toString("utf8")) as { $defs: Record<string, unknown> }).$defs.FormatsSelection;
  const pres = [...html.matchAll(/<pre class="code"><code>([\s\S]*?)<\/code><\/pre>/g)].map((m) => m[1]!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  assert.deepEqual(JSON.parse(pres[0]!), def);
  const te = JSON.parse(readFileSync(join(SPEC, "type-examples", "as-written", "examples.json"), "utf8")) as { types: { LineItem: { full: { formats: unknown } } } };
  assert.deepEqual(JSON.parse(pres[1]!), { formats: te.types.LineItem.full.formats });
  assert.match(html, /examples\/line-item-display\.yaml/);
  for (const type of ["LineItem", "FormatId", "Selectable", "FormatsSelection"]) assert.match(html, new RegExp(`href="map\\.html#!/type/${type}\\?lock=main&variant=as-written`), type);
});

test("the pipeline figure is inline SVG in a wide and a tall layout, each titled, colored by the theme's classes", () => {
  const html = SITE.files.get(OP + "how-it-is-built.html")!.toString("utf8");
  const svgs = [...html.matchAll(/<svg class="(fig-wide|fig-tall)"[^>]*aria-labelledby="([^"]+)"[\s\S]*?<\/svg>/g)];
  assert.deepEqual(svgs.map((m) => m[1]), ["fig-wide", "fig-tall"]);
  for (const m of svgs) {
    assert.match(m[0], new RegExp(`<title id="${m[2]}">`));
    assert.doesNotMatch(m[0], /\s(fill|stroke)="#|\sstyle=/, "colors come from the stylesheet, so both themes apply");
  }
});

test("the files page marks each build's SDK tree secondary, as written the default, and the How it's built page explains the SDK types", () => {
  const files = at("downloads.html").toString("utf8");
  for (const [tree, kind] of [["sdk/", "the default"], ["sdk/with-open-prs/", "the default"], ["sdk/proposed/", "an opt-in"], ["sdk/proposed/with-open-prs/", "an opt-in"]] as const) {
    assert.ok(files.includes(`as ${kind} SDK tree, <code>${tree}</code>`), tree);
  }
  assert.equal((files.match(/<h3>SDK types <span class="tag">Secondary<\/span><\/h3>/g) ?? []).length, 4);
  const method = at("how-it-is-built.html").toString("utf8");
  assert.ok(method.includes('<a href="#sdk">The SDK types</a>'));
  for (const s of ["<code>sdk/proposed/</code>", "<code>SCHEMA_RELEASE</code>", "<code>Channels.CTV</code>", 'mode="receive"', "<code>dump_json</code>"]) assert.ok(method.includes(s), s);
});

test("the site's names come from the spec's profile, and its code names no spec", () => {
  const brand = brandOf(specOf(SPEC).profile, CONFIG);
  assert.deepEqual([named(brand), brand.release, brand.feedback?.issueRef, brand.feedback?.issueNumber, brand.spec, brand.documents], ["OpenProposal 3.0", "draft 1", "IABTechLab/OpenProposal#121", "121", "openproposal", ["Proposal", "LineItem"]]);
  assert.equal(INPUTS.brand.publisher, "Postindustria");
  const sources = new Map(spawnSync("git", ["ls-files", "src/site"], { cwd: ROOT, encoding: "utf8" }).stdout.split("\n").filter((p) => p !== "").map((p) => [p, readFileSync(join(ROOT, p), "utf8")] as const));
  assert.ok(sources.size > 5);
  assert.deepEqual(hardCodedNames(sources, ["OpenProposal"]), []);
  assert.deepEqual(hardCodedNames(new Map([["src/site/x.ts", "a\nconst t = \"OpenProposal 3.0\";\n"]]), ["OpenProposal"]), ['src/site/x.ts:2: names "OpenProposal", which a spec\'s profile gives; read it from the profile (src/site/config.ts)']);
  // An asset names the spec by a token the build fills in, and one without the token is copied byte for byte.
  assert.equal(fillTokens(Buffer.from("/* __SPEC_NAME__ JSON Schema, __SPEC_ISSUE__ */"), assetTokens({ ...INPUTS, brand })).toString(), "/* OpenProposal 3.0 JSON Schema, #121 */");
  const plain = Buffer.from([0xff, 0x00, 0x41]);
  assert.equal(fillTokens(plain, {}), plain);
  assert.throws(() => fillTokens(Buffer.from("x __SPEC_NOPE__"), assetTokens({ ...INPUTS, brand }), "src/site/assets/x.js"), /src\/site\/assets\/x\.js: names the token __SPEC_NOPE__, which the build doesn't fill/);
  assert.match(SITE.files.get(OP + "assets/route.js")!.toString("utf8"), /var DEFAULT = \{ type: "LineItem",/);
  assert.match(SITE.files.get(OP + "assets/map.js")!.toString("utf8"), / on the supporting page of #121<\/span>/);
  assert.match(SITE.files.get(OP + "assets/map.js")!.toString("utf8"), / · Type map · OpenProposal 3\.0 JSON Schema"/);
  assert.doesNotMatch(SITE.files.get(OP + "assets/map.js")!.toString("utf8"), /__SPEC_NAME__/);
});

test("the whole site gives AdCOM, a registry of lists with no departures and no feedback yet, every page OpenProposal has that applies, and a page of its lists and who cites them", () => {
  const all = buildSite(undefined, CONFIG, TREE);
  assert.deepEqual(all.problems, []);
  const at = (p: string) => all.files.get(`adcom/${p}`)?.toString("utf8") ?? "";
  for (const p of ["index.html", "how-it-is-built.html", "map.html", "examples.html", "decisions/index.html", "downloads.html", "registry.html", "data/main.as-written.json", "data/tag-202607.as-written.json", "schemas/modules/lists/1/lists.json"]) assert.ok(all.files.has(`adcom/${p}`), p);
  assert.ok(!all.files.has("adcom/data/main.proposals.json"), "no variant with our proposals, since AdCOM has no departure");
  assert.doesNotMatch(at("map.html"), /aria-label="Variant"/);
  assert.match(at("decisions/index.html"), /Points the text leaves open/);
  assert.match(at("examples.html"), /<td data-label="Example"><code>1<\/code><\/td>/);
  // OpenProposal cites four lists, and the Deals API Device Types, which OpenProposal cites too, and Category Taxonomies.
  assert.match(at("registry.html"), /5 of them are cited by another specification on this site/);
  assert.match(at("registry.html"), /href="\.\.\/dealsapi\/map\.html#!\/type\/CategoryTaxonomy\?lock=main&variant=as-written/);
  assert.match(at("registry.html"), /href="\.\.\/openproposal\/map\.html#!\/type\/ApiFramework\?lock=with-open-prs&variant=as-written/);
  // A line of a merged text is linked where its PR or main wrote it, and named by the line the link opens at.
  assert.match(at("registry.html"), /blob\/[0-9a-f]{40}\/spec\/openproposal-3\.0\.md\?plain=1#L(\d+)">L\1<\/a>/);
  // A link to a line of AdCOM's text encodes the space in its file's name.
  assert.match(at("decisions/D-017.html"), /AdCOM%20v1\.0%20FINAL\.md\?plain=1#L/);
  assert.doesNotMatch(at("decisions/D-017.html"), /AdCOM v1\.0 FINAL\.md\?plain/);
  const root = all.files.get("index.html")!.toString("utf8");
  assert.match(root, /href="adcom\/registry\.html">Who cites each list/);
  const schema = JSON.parse(at("schemas/modules/lists/1/lists.json")) as { $id: string };
  assert.equal(schema.$id, "https://adtechspec.noetis.dev/adcom/schemas/modules/lists/1/lists.json");
});

test("a text cites a list by its longest title after \"List:\", on the line where \"List:\" is, and on each line that names it again", async () => {
  const { citingLines } = await import("../src/site/registry.ts");
  const titles = ["Playback Methods", "Placement Subtypes", "Placement Subtypes - Video", "Device Types"];
  const text = [
    "Values from List: Playback Methods, and", // 1: cites
    "also List: Playback Methods here", // 2: cites again
    "see List: Placement Subtypes - Video for the legacy codes", // 3: the longer title
    "and List: Placement Subtypes for the rest", // 4: the shorter one
    "a title that wraps, List:", // 5: cites Device Types, which wraps
    "Device Types, on the next line",
    "List: Device TypesExtended is no citation", // 7: more letters follow
    "List: Playback Methods/Video is no citation either",
  ];
  const got = citingLines(text, titles);
  assert.deepEqual(Object.fromEntries([...got].sort()), { "Device Types": [5], "Placement Subtypes": [4], "Placement Subtypes - Video": [3], "Playback Methods": [1, 2] });
});

test("a citation names a section as its plugin says the text identifies them, whatever the ID's shape", () => {
  const titleOf = (s: string) => ({ "5.4/creative-inspection-and-previews": "Creative inspection and previews", list_devicetypes: "List: Device Types", "4.1": "Identity" })[s];
  assert.equal(elementLabel("rule:5.4/creative-inspection-and-previews:ab12", { sections: "numbered", titleOf }), '§ 5.4, under "Creative inspection and previews", a requirement');
  assert.equal(elementLabel("def:list_devicetypes:3", { sections: "anchored", titleOf }), "List: Device Types, the row of `3`");
  // The flag decides, not the ID: a numbered text cites even an anchor-shaped ID by number, and an anchored text cites a number-shaped one by its heading.
  assert.equal(elementLabel("def:list_devicetypes:3", { sections: "numbered", titleOf }), "§ list_devicetypes, the row of `3`");
  assert.equal(elementLabel("field:4.1:proposal_id", { sections: "anchored", titleOf }), "Identity, the `proposal_id` row");
  // The site's builds read the flag from each spec's plugin.
  const adcom = loadSiteInputs(join(ROOT, "specs", "adcom"), CONFIG);
  const lock = adcom.locks[0]!;
  assert.equal(sourceInfos(adcom, lock, ["def:list_devicetypes:3"])["def:list_devicetypes:3"]!.label, "List: Device Types, the row of `3`");
  const rule = INPUTS.irs.get("with-open-prs")!.statements.find((s) => s.loc.section === "5.4/creative-inspection-and-previews")!;
  assert.match(sourceInfos(INPUTS, INPUTS.locks.find((l) => l.name === "with-open-prs")!, [rule.id])[rule.id]!.label, /^§ 5\.4, under "Creative inspection and previews", a requirement$/);
});

test("every spec's page links back to the site's root once, AdCOM's too, and the root's own pages don't", () => {
  const all = buildSite([INPUTS, loadSiteInputs(join(ROOT, "specs", "adcom"), CONFIG)], CONFIG, TREE);
  assert.deepEqual(all.problems, []);
  const adcomPages = [...all.files.keys()].filter((p) => p.startsWith("adcom/") && p.endsWith(".html"));
  assert.ok(adcomPages.length > 20);
  for (const p of adcomPages) assert.deepEqual([...all.files.get(p)!.toString("utf8").matchAll(/<a href="([^"]*)">All specifications<\/a>/g)].map((m) => m[1]), [`${"../".repeat(p.split("/").length - 1)}index.html`], p);
  assert.deepEqual(checkSite(all.files).filter((x) => /All specifications/.test(x)), []);
  const pages = [...SITE.files.keys()].filter((p) => p.endsWith(".html"));
  const specPages = pages.filter((p) => p.startsWith(OP));
  assert.ok(specPages.length > 40);
  for (const p of specPages) {
    const html = SITE.files.get(p)!.toString("utf8");
    const links = [...html.matchAll(/<a href="([^"]*)">All specifications<\/a>/g)].map((m) => m[1]!);
    assert.deepEqual(links, [`${"../".repeat(p.split("/").length - 1)}index.html`], p);
  }
  for (const p of pages.filter((x) => !x.includes("/"))) assert.doesNotMatch(SITE.files.get(p)!.toString("utf8"), /All specifications/, p);
});

test("a registry vocabulary's reference opens the registry's own page of it, by the registry's name, and the site's check holds a data file's registry links", async () => {
  const { buildData, registryTargets } = await import("../src/site/data.ts");
  const lock = INPUTS.locks.find((l) => l.name === "with-open-prs")!;
  const data = buildData(INPUTS, lock, "as-written");
  const ref = "https://adtechspec.noetis.dev/adcom/schemas/modules/lists/1/lists.json#/$defs/PlcmtSubtypeVideo";
  // OpenProposal names it PlcmtSubtype; the link opens AdCOM's PlcmtSubtypeVideo at the lock OpenProposal imports.
  assert.equal((data.emitted.PlcmtSubtype!.schema as { $ref: string }).$ref, ref);
  const t = data.registry[ref]!;
  assert.deepEqual({ ...t, schema: undefined }, { spec: "adcom", short: "AdCOM", def: "PlcmtSubtypeVideo", lock: "main", map: "../adcom/map.html", href: "../adcom/map.html#!/type/PlcmtSubtypeVideo?lock=main&variant=as-written&view=schema", file: "../adcom/schemas/modules/lists/1/lists.json", schema: undefined });
  // The schema shown is the registry's, with each code's name.
  assert.deepEqual(((t.schema as { oneOf: { const?: number; title: string }[] }).oneOf).map((b) => [b.const, b.title]).slice(0, 2), [[1, "Instream"], [2, "Accompanying Content"]]);
  assert.deepEqual(Object.keys(data.registry).sort(), ["ApiFramework", "PlaybackMethod", "PlcmtSubtypeVideo"].map((d) => ref.replace("PlcmtSubtypeVideo", d)));
  // The main lock references no registry.
  assert.deepEqual(buildData(INPUTS, INPUTS.locks[0]!, "as-written").registry, {});
  // A reference to a file or a vocabulary the imported registry doesn't hold fails the build.
  assert.throws(() => registryTargets(SPEC, { X: { file: "x", schema: { $ref: ref.replace("lists.json", "nope.json") } } }), /which is no registry file the profile imports; it imports adcom at main: https:\/\/adtechspec\.noetis\.dev\/adcom\/schemas\/modules\/lists\/1\/lists\.json, adcom at main: .*kernel\.json/);
  assert.throws(() => registryTargets(SPEC, { X: { file: "x", schema: { $ref: ref.replace("PlcmtSubtypeVideo", "Nope") } } }), /names no vocabulary under \$defs/);
  // The site's check: each registry link of a data file is a relative link to a page and a type, or a file, the site holds.
  const key = `${OP}data/with-open-prs.as-written.json`;
  const broken = (f: (r: Record<string, { href: string; file: string }>) => void) => {
    const files = new Map(SITE.files);
    const doc = JSON.parse(files.get(key)!.toString("utf8")) as { registry: Record<string, { href: string; file: string }> };
    f(doc.registry);
    files.set(key, Buffer.from(JSON.stringify(doc)));
    return checkSite(files).join("\n");
  };
  assert.equal(broken(() => {}), "");
  assert.match(broken((r) => (r[ref]!.href = r[ref]!.href.replace("PlcmtSubtypeVideo", "PlcmtSubtype"))), /data\/with-open-prs\.as-written\.json \(the reference .*PlcmtSubtypeVideo\): links the type map at "PlcmtSubtype", which main as-written doesn't hold/);
  assert.match(broken((r) => (r[ref]!.file = "../adcom/schemas/nope.json")), /links \.\.\/adcom\/schemas\/nope\.json, which the site doesn't hold/);
  assert.match(broken((r) => (r[ref]!.href = "https://adtechspec.noetis.dev/adcom/map.html")), /opens https:\/\/adtechspec\.noetis\.dev\/adcom\/map\.html, which isn't a relative link to a file within the site/);
  assert.match(broken((r) => (r[ref]!.href = "../adcom/map.html#!/type/PlcmtSubtypeVideo?lock=upstream")), /which the router rewrites/);
  // A bare fragment, a missing link, a page at another vocabulary or lock than the entry names, and a broken link inside the registry's schema each fail.
  assert.match(broken((r) => (r[ref]!.href = "#!/type/Nope?lock=main&variant=as-written&view=schema")), /opens #!\/type\/Nope.*which isn't a relative link to a file within the site/);
  assert.match(broken((r) => delete (r[ref] as Partial<typeof t>).file), /\(the reference .*PlcmtSubtypeVideo\): names no file/);
  assert.match(broken((r) => (r[ref]!.href = r[ref]!.href.replace("PlcmtSubtypeVideo", "ApiFramework"))), /opens \.\.\/adcom\/map\.html#!\/type\/ApiFramework.*which isn't the registry's type map at PlcmtSubtypeVideo on main/);
  assert.match(broken((r) => ((r[ref] as unknown as { schema: unknown }).schema = { $ref: "#/$defs/Nope" })), /links \.\.\/adcom\/map\.html#!\/type\/Nope\?lock=main&variant=as-written&view=schema, which main as-written doesn't hold|links the type map at "Nope", which main as-written doesn't hold/);
  assert.equal(broken((r) => ((r[ref] as unknown as { schema: unknown }).schema = { oneOf: [{ $ref: "#/$defs/ApiFramework" }] })), "");
  // The router opens a registry reference at the registry's page, another absolute one nowhere, and leaves a reference within the spec's schemas to the map.
  const { loadRoute } = await import("../src/site/route.ts");
  const route = loadRoute(SITE.files.get(`${OP}assets/route.js`)!.toString("utf8"));
  assert.equal(route.registryHref(data.registry, ref), t.href);
  assert.equal(route.registryHref(data.registry, "http://example.com/x.json#/$defs/A"), null);
  assert.equal(route.registryHref(data.registry, "#/$defs/Channel"), undefined);
  assert.equal(route.registryHref(undefined, "#/$defs/Channel"), undefined);
  assert.equal(route.registryInnerHref(t, "#/$defs/DeviceType"), "../adcom/map.html#!/type/DeviceType?lock=main&variant=as-written&view=schema");
  assert.equal(route.registryInnerHref(t, "../../kernel/1/kernel.json#/$defs/VendorCode"), null);
  // An http reference across hosts is a reference across hosts too.
  assert.throws(() => registryTargets(SPEC, { X: { file: "x", schema: { $ref: ref.replace("https:", "http:") } } }), /which is no registry file the profile imports/);
  // The type map reads the registry's link for a reference across hosts, and shows the registry's schema under the spec's.
  const js = SITE.files.get(`${OP}assets/map.js`)!.toString("utf8");
  assert.match(js, /var across = window\.MapRoute\.registryHref\(B\.registry, ref\);\n\s+if \(across !== undefined\) return across;/);
  assert.match(js, /refHref: function \(ref\) \{ return window\.MapRoute\.registryInnerHref\(reg, ref\); \}/);
  assert.match(js, /if \(reg\) registryPanel\(host, reg\);/);
});

test("the whole site gives the Deals API every page, both variants, and the AdCOM registry's lists it cites, and its root card counts one proposal as one", () => {
  const all = buildSite(undefined, CONFIG, TREE);
  assert.deepEqual(all.problems, []);
  const at = (p: string) => all.files.get(`dealsapi/${p}`)?.toString("utf8") ?? "";
  for (const p of ["index.html", "how-it-is-built.html", "map.html", "examples.html", "decisions/index.html", "decisions/D-004.html", "decisions/D-033.html", "downloads.html", "data/main.as-written.json", "data/main.proposals.json", "data/tag-1.0-202602.as-written.json", "data/tag-1.0-202602.proposals.json", "schemas/documents/1/deal.json", "schemas/as-written/documents/1/deal.json"]) assert.ok(all.files.has(`dealsapi/${p}`), p);
  assert.match(at("map.html"), /aria-label="Variant"/);
  // The landing page names the push body and the status response in that order, and the one change it proposes.
  assert.match(at("index.html"), /<code>Deal<\/code><\/a>, the push body, and <a[^>]*><code>BuyerSeat<\/code><\/a>, the status response/);
  assert.match(at("index.html"), /The change we propose/);
  assert.match(at("index.html"), /href="\.\.\/adcom\/registry\.html"/);
  // The worked example follows `sellerstatus` to its vocabulary.
  assert.match(at("how-it-is-built.html"), /field:object-deal:sellerstatus/);
  assert.match(at("how-it-is-built.html"), /SellerDealStatus/);
  const root = all.files.get("index.html")!.toString("utf8");
  assert.match(root, /href="dealsapi\/index\.html"/);
  assert.match(root, /<b>1<\/b> change proposed/);
  assert.match(root, /<b>5<\/b> changes proposed/);
});
