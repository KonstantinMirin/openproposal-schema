/**
 * The gates of the public site (src/site/build.ts, `npm run site`), one site
 * for every spec, each under its path: it builds with no problem its own
 * check finds, and two builds in separate processes write the bytes the
 * in-process build does.
 */
import { checkSite, hardCodedNames, type ExportCheck } from "../src/site/build.ts";
import { flipFirst, sameTreeRuns, type TreeRunsInput } from "./common.ts";
import { defineGate } from "./harness.ts";

const withPage = (files: Map<string, Buffer>, path: string, f: (html: string) => string): Map<string, Buffer> => new Map([...files].map(([p, b]) => [p, p === path ? Buffer.from(f(b.toString("utf8"))) : b]));

/** The spec whose pages the fixtures change. */
const OP = "openproposal/";

export const siteBuilds = defineGate<{ files: Map<string, Buffer>; problems: string[]; sources: Map<string, string>; names: string[]; exported: ExportCheck }>({
  id: "site-builds",
  title: "site: no specification's name is written into its code, every internal link and resource resolves, every type-map link is an address its spec's router reads unchanged and names a type of its build, every link into the public repository names a path its export publishes, nothing runs inline or loads another origin, nothing scrolls inside a page, no script leaves its page, every spec's page links back to the root, no quote shows a Markdown link as text, and no text names an internal ID or a local path",
  code: ["src/site/build.ts#buildSite", "src/site/build.ts#checkSite", "src/site/build.ts#hardCodedNames", "src/site/build.ts#exportTree"],
  files: ["src/site/assets/", "specs/site.schema.json"],
  check: (i) => {
    // The site's code names no specification: each name comes from the spec's profile.
    const problems = [...i.problems, ...checkSite(i.files, i.exported), ...hardCodedNames(i.sources, i.names)];
    const pages = [...i.files.keys()].filter((p) => p.endsWith(".html")).length;
    return { problems, note: `${i.files.size} files, ${pages} pages` };
  },
  fixtures: [
    { name: "a link to a page the site doesn't hold", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}index.html`, (h) => h.replace("</main>", '<a href="missing.html">x</a></main>')) }), expect: "links missing.html, which the site doesn't hold" },
    { name: "a type-map link to a type the build lacks", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}index.html`, (h) => h.replace("</main>", '<a href="map.html#!/type/Placement?lock=main&amp;variant=as-written">x</a></main>')) }), expect: 'links the type map at "Placement", which main as-written doesn\'t hold' },
    { name: "an inline script", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}index.html`, (h) => h.replace("</main>", "<script>alert(1)</script></main>")) }), expect: "a script without src" },
    { name: "an inline style attribute", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}map.html`, (h) => h.replace("<main", '<main style="color:red"')) }), expect: "an inline style" },
    { name: "a stylesheet from another origin", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}index.html`, (h) => h.replace("</head>", '<link rel="stylesheet" href="https://fonts.example/a.css"></head>')) }), expect: "loads https://fonts.example/a.css from another origin" },
    { name: "a local path", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}decisions/index.html`, (h) => h.replace("</main>", "<p>file:///srv/repo</p></main>")) }), expect: "names a local path" },
    { name: "a JSON tree capped to a region that scrolls inside the page", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}assets/site.css`, (c) => `${c}\n.jsontree { overflow: auto; max-height: 520px; }\n`) }), expect: "openproposal/assets/site.css: .jsontree sets overflow: auto, which scrolls inside the page" },
    { name: "a list capped to a height", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}assets/site.css`, (c) => `${c}\nul.tree-files { max-height: 320px; }\n`) }), expect: "openproposal/assets/site.css: ul.tree-files sets max-height: 320px, which caps its height" },
    { name: "a script that sets a height cap", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}assets/jsontree.js`, (j) => `${j}\ndocument.body.style.maxHeight = "520px";\n`) }), expect: "openproposal/assets/jsontree.js: sets an overflow or a height cap" },
    { name: "a script that leaves its page", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}assets/map.js`, (j) => `${j}\nlocation.href = "examples.html";\n`) }), expect: "openproposal/assets/map.js: leaves the page it runs on" },
    { name: "a specification's name written into the site's code", mutate: (i) => ({ ...i, sources: new Map([...i.sources, ["src/site/pages.ts", `${i.sources.get("src/site/pages.ts") ?? ""}\nconst title = "OpenProposal 3.0 JSON Schema";\n`]]) }), expect: /src\/site\/pages\.ts:\d+: names "OpenProposal", which a spec's profile gives/ },
    { name: "a type-map link the router rewrites", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}index.html`, (h) => h.replace("</main>", '<a href="map.html#!/type/LineItem?lock=main&amp;variant=with-proposals&amp;view=example">x</a></main>')) }), expect: "which the router rewrites: variant=with-proposals reads as variant=proposals" },
    { name: "a link into the public repository outside the folders the site may link", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}downloads.html`, (h) => h.replace("</main>", `<a href="${i.exported.repo}/blob/main/docs/design/type-rules.md">x</a></main>`)) }), expect: "type-rules.md, which names no tracked path under sdk/ or specs/" },
    { name: "a link into the public repository at a path the private tree doesn't hold", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}downloads.html`, (h) => h.replace("</main>", `<a href="${i.exported.repo}/blob/main/specs/openproposal/rules/missing.json">x</a></main>`)) }), expect: "rules/missing.json, which names no tracked path under sdk/ or specs/" },
    { name: "the root page links a spec page the site doesn't hold", mutate: (i) => ({ ...i, files: withPage(i.files, "index.html", (h) => h.replace("</main>", '<a href="nospec/index.html">x</a></main>')) }), expect: "index.html: links nospec/index.html, which the site doesn't hold" },
    { name: "a type-map link from the root at a type the spec's build lacks", mutate: (i) => ({ ...i, files: withPage(i.files, "index.html", (h) => h.replace("</main>", `<a href="${OP}map.html#!/type/Nothing?lock=main&amp;variant=as-written">x</a></main>`)) }), expect: 'index.html: links the type map at "Nothing", which main as-written doesn\'t hold' },
    { name: "a link that names another host by starting with two slashes", mutate: (i) => ({ ...i, files: withPage(i.files, "404.html", (h) => h.replace("</main>", '<a href="//openproposal/index.html">x</a></main>')) }), expect: "404.html: links //openproposal/index.html, which names another host" },
    { name: "a repository tree link to a file", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}downloads.html`, (h) => h.replace("</main>", `<a href="${i.exported.repo}/tree/main/specs/openproposal/spec.yaml">x</a></main>`)) }), expect: "a tree link to a file" },
    { name: "a repository link off main", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}downloads.html`, (h) => h.replace("</main>", `<a href="${i.exported.repo}/raw/dev/specs/openproposal/spec.yaml">x</a></main>`)) }), expect: "isn't a tree or blob link on main" },
    { name: "a repository link whose path isn't a valid URL encoding", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}downloads.html`, (h) => h.replace("</main>", `<a href="${i.exported.repo}/blob/main/specs/%E0%A4%A">x</a></main>`)) }), expect: "whose path isn't a valid URL encoding" },
    // AdCOM's registry page links the citing spec's type map, across specs: a vocabulary that spec's build lacks fails as any other type-map link does.
    { name: "a registry citation at a vocabulary the citing spec's build lacks", mutate: (i) => ({ ...i, files: withPage(i.files, "adcom/registry.html", (h) => h.replace("#!/type/ApiFramework?lock=with-open-prs", "#!/type/ApiFrameworks?lock=with-open-prs")) }), expect: 'adcom/registry.html: links the type map at "ApiFrameworks", which with-open-prs as-written doesn\'t hold' },
    // The registry's citing line as the site once showed it: raw, and cut inside the link's URL.
    { name: "a citing line that shows a Markdown link as text, cut inside its URL", mutate: (i) => ({ ...i, files: withPage(i.files, "adcom/registry.html", (h) => h.replace('<ul class="cite-lines"><li>', '<ul class="cite-lines"><li>[List: API Frameworks](https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba1b235cd8d938c9877409e506f1b8d3f0c/AdCOM%20v1.0%20FINAL.md#list_apifr… ')) }), expect: 'adcom/registry.html: a quote shows a Markdown link as text, at "[List: API Frameworks](https://github.com/' },
    { name: "a decision page's quote that shows a Markdown image as text", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}decisions/D-001.html`, (h) => h.replace("<blockquote>", "<blockquote>Refer to ![image](https://example.com/a.png) ")) }), expect: `${OP}decisions/D-001.html: a quote shows a Markdown link as text, at "[image](https://example.com/a.png)` },
    { name: "a type map's quote that shows a Markdown link as text", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}data/main.as-written.json`, (j) => j.replace('"quote":{"html":"', '"quote":{"html":"[x](#list_a) ')) }), expect: `${OP}data/main.as-written.json: a quote shows a Markdown link as text, at "[x](#list_a)` },
    { name: "a type map's quote that isn't rendered", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}data/main.as-written.json`, (j) => { const d = JSON.parse(j) as { sources: Record<string, { quote: unknown }> }; const first = Object.values(d.sources)[0]!; first.quote = "a plain string"; return JSON.stringify(d); }) }), expect: "quote isn't rendered" },
    { name: "a spec's page with no link back to the site's root", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}decisions/D-001.html`, (h) => h.replace('<a href="../../index.html">All specifications</a>', "")) }), expect: `${OP}decisions/D-001.html: has no "All specifications" link back to the site's root` },
    { name: "a spec's root link one folder short", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}decisions/D-001.html`, (h) => h.replace('<a href="../../index.html">All specifications</a>', '<a href="../index.html">All specifications</a>')) }), expect: `${OP}decisions/D-001.html: has one "All specifications" link, to openproposal/index.html, where one in its nav` },
    { name: "a spec's page with a second root link", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}decisions/D-001.html`, (h) => h.replace("</main>", '<a class="up" href="../../index.html">All specifications</a></main>')) }), expect: `${OP}decisions/D-001.html: has 2 "All specifications" links, to index.html, index.html outside the nav` },
    { name: "a spec's root link moved out of its nav", mutate: (i) => ({ ...i, files: withPage(i.files, `${OP}decisions/D-001.html`, (h) => h.replace('<a href="../../index.html">All specifications</a>', "").replace("</footer>", '<a href="../../index.html">All specifications</a></footer>')) }), expect: `${OP}decisions/D-001.html: has one "All specifications" link, to index.html outside the nav` },
    { name: "a root page with a root link", mutate: (i) => ({ ...i, files: withPage(i.files, "index.html", (h) => h.replace("</main>", '<a href="index.html">All specifications</a></main>')) }), expect: 'index.html: a root page has an "All specifications" link' },
    { name: "a spec's type map with no router", mutate: (i) => ({ ...i, files: new Map([...i.files].filter(([p]) => p !== `${OP}assets/route.js`)) }), expect: "openproposal/assets/route.js: the type map's router doesn't load" },
  ],
});

export const siteDeterministic = defineGate<TreeRunsInput>({
  id: "site-deterministic",
  title: "deterministic site",
  code: ["gates/common.ts#sameTreeRuns"],
  check: sameTreeRuns,
  fixtures: [{ name: "a run writes one file differently", mutate: (i) => ({ ...i, runs: [i.runs[0]!, flipFirst(i.runs[1]!)] }), expect: "run 2: " }],
});
