import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexElements } from "../src/elements.ts";
import { loadLock } from "../src/lock.ts";
import { loadProvenance } from "../src/provenance.ts";
import { buildSite, checkSite, scrollRegions } from "../src/site/build.ts";
import { loadSiteInputs } from "../src/site/data.ts";
import { elementLabel, sourceInfo } from "../src/site/sources.ts";
import { zip } from "../src/site/zip.ts";
import { ROOT } from "./helpers.ts";

const INPUTS = loadSiteInputs(ROOT);
const SITE = buildSite(ROOT, INPUTS);
const MAIN = loadLock(join(ROOT, "spec-input", "spec-lock.yaml"));
const PRS = loadLock(join(ROOT, "spec-input", "with-open-prs.lock.yaml"));

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
  const provenance = loadProvenance(ROOT, PRS);
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
  for (const d of INPUTS.decisions) assert.ok(SITE.files.has(`decisions/${d.id}.html`), d.id);
  const kernel = JSON.parse(SITE.files.get("schemas/as-written/kernel/1/kernel.json")!.toString("utf8")) as { $id: string };
  assert.equal(kernel.$id, "https://openproposal.noetis.dev/schemas/as-written/kernel/1/kernel.json");
});

test("the site's check catches a broken link, an inline script, and a local path", () => {
  const page = (html: string) => new Map([...SITE.files, ["x.html", Buffer.from(html)]]);
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
  const css = new Map([...SITE.files].map(([p, b]) => [p, p === "assets/site.css" ? Buffer.concat([b, Buffer.from("\n.tree-files { overflow-x: auto; }\n")]) : b]));
  assert.match(checkSite(css).join("\n"), /assets\/site\.css: \.tree-files sets overflow-x: auto, which scrolls inside the page/);
  const js = new Map([...SITE.files].map(([p, b]) => [p, p === "assets/jsontree.js" ? Buffer.concat([b, Buffer.from("\ntree.style.maxHeight = '520px';\n")]) : b]));
  assert.match(checkSite(js).join("\n"), /assets\/jsontree\.js: sets an overflow or a height cap/);
});

test("a JSON tree opens two levels deep and offers no fixed height", () => {
  const tree = SITE.files.get("assets/jsontree.js")!.toString("utf8");
  assert.doesNotMatch(tree, /Full height|Fixed height/);
  assert.match(tree, /opts\.open = 2/);
  assert.match(SITE.files.get("assets/map.js")!.toString("utf8"), /JsonTree\.render\(box, em\.schema, \{ open: 2,/);
});

test("a zip archive lists its files and unpacks to their bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "zip-"));
  const file = join(dir, "a.zip");
  writeFileSync(file, zip([{ path: "x/one.txt", data: Buffer.from("one\n") }, { path: "x/two.json", data: Buffer.from('{"a":1}\n') }]));
  const r = spawnSync("unzip", ["-p", file, "x/two.json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '{"a":1}\n');
});

test("git ignores no source, gate, script, test, or tool file", () => {
  // A pattern such as `site/` once matched `src/site/`, so CI had no site builder while every local run passed.
  const r = spawnSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "src", "gates", "scripts", "test", "tools"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const ignored = r.stdout.split("\n").filter((p) => p !== "" && !p.includes("__pycache__/") && !p.includes("/node_modules/"));
  assert.deepEqual(ignored, []);
});

test("the How it's built page is in the top navigation of every page and linked from the landing page", () => {
  assert.ok(SITE.files.has("how-it-is-built.html"));
  for (const [path, data] of SITE.files) {
    if (!path.endsWith(".html")) continue;
    assert.match(data.toString("utf8"), /<nav aria-label="Site">.*href="(?:\.\.\/|\/)*how-it-is-built\.html"[^>]*>How it's built<\/a>/, path);
  }
  assert.equal((SITE.files.get("index.html")!.toString("utf8").match(/<main[\s\S]*<\/main>/)![0].match(/href="how-it-is-built\.html"/g) ?? []).length, 2);
});

test("the How it's built page's worked example shows the build's own element, schema, and example value", () => {
  const html = SITE.files.get("how-it-is-built.html")!.toString("utf8");
  const ir = INPUTS.irs.get("main")!;
  const row = ir.fields.find((f) => f.id === "field:5.4:formats")!;
  assert.ok(html.includes(`<code class="digest">${row.digest}</code>`), "the row's digest");
  const def = (JSON.parse(SITE.files.get("schemas/as-written/modules/creative/1/creative.json")!.toString("utf8")) as { $defs: Record<string, unknown> }).$defs.FormatsSelection;
  const pres = [...html.matchAll(/<pre class="code"><code>([\s\S]*?)<\/code><\/pre>/g)].map((m) => m[1]!.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  assert.deepEqual(JSON.parse(pres[0]!), def);
  const te = JSON.parse(readFileSync(join(ROOT, "type-examples", "as-written", "examples.json"), "utf8")) as { types: { LineItem: { full: { formats: unknown } } } };
  assert.deepEqual(JSON.parse(pres[1]!), { formats: te.types.LineItem.full.formats });
  assert.match(html, /examples\/line-item-display\.yaml/);
  for (const type of ["LineItem", "FormatId", "Selectable", "FormatsSelection"]) assert.match(html, new RegExp(`href="map\\.html#!/type/${type}\\?lock=main&variant=as-written`), type);
});

test("the pipeline figure is inline SVG in a wide and a tall layout, each titled, colored by the theme's classes", () => {
  const html = SITE.files.get("how-it-is-built.html")!.toString("utf8");
  const svgs = [...html.matchAll(/<svg class="(fig-wide|fig-tall)"[^>]*aria-labelledby="([^"]+)"[\s\S]*?<\/svg>/g)];
  assert.deepEqual(svgs.map((m) => m[1]), ["fig-wide", "fig-tall"]);
  for (const m of svgs) {
    assert.match(m[0], new RegExp(`<title id="${m[2]}">`));
    assert.doesNotMatch(m[0], /\s(fill|stroke)="#|\sstyle=/, "colors come from the stylesheet, so both themes apply");
  }
});
