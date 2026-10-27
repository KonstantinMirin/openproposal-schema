/**
 * The gates of the public site (src/site/build.ts, `npm run site`): it
 * builds with no problem its own check finds, and two builds in separate
 * processes write the bytes the in-process build does.
 */
import { checkSite } from "../src/site/build.ts";
import { flipFirst, sameTreeRuns, type TreeRunsInput } from "./common.ts";
import { defineGate } from "./harness.ts";

const withPage = (files: Map<string, Buffer>, path: string, f: (html: string) => string): Map<string, Buffer> => new Map([...files].map(([p, b]) => [p, p === path ? Buffer.from(f(b.toString("utf8"))) : b]));

export const siteBuilds = defineGate<{ files: Map<string, Buffer>; problems: string[] }>({
  id: "site-builds",
  title: "site: every internal link and resource resolves, every type-map link is an address the router reads unchanged and names a type of its build, nothing runs inline or loads another origin, nothing scrolls inside a page, no script leaves its page, and no text names an internal ID or a local path",
  code: ["src/site/build.ts#buildSite", "src/site/build.ts#checkSite"],
  files: ["src/site/assets/"],
  check: (i) => {
    const problems = [...i.problems, ...checkSite(i.files)];
    const pages = [...i.files.keys()].filter((p) => p.endsWith(".html")).length;
    return { problems, note: `${i.files.size} files, ${pages} pages` };
  },
  fixtures: [
    { name: "a link to a page the site doesn't hold", mutate: (i) => ({ ...i, files: withPage(i.files, "index.html", (h) => h.replace("</main>", '<a href="missing.html">x</a></main>')) }), expect: "links missing.html, which the site doesn't hold" },
    { name: "a type-map link to a type the build lacks", mutate: (i) => ({ ...i, files: withPage(i.files, "index.html", (h) => h.replace("</main>", '<a href="map.html#!/type/Placement?lock=main&amp;variant=as-written">x</a></main>')) }), expect: 'links the type map at "Placement", which main as-written doesn\'t hold' },
    { name: "an inline script", mutate: (i) => ({ ...i, files: withPage(i.files, "index.html", (h) => h.replace("</main>", "<script>alert(1)</script></main>")) }), expect: "a script without src" },
    { name: "an inline style attribute", mutate: (i) => ({ ...i, files: withPage(i.files, "map.html", (h) => h.replace("<main", '<main style="color:red"')) }), expect: "an inline style" },
    { name: "a stylesheet from another origin", mutate: (i) => ({ ...i, files: withPage(i.files, "index.html", (h) => h.replace("</head>", '<link rel="stylesheet" href="https://fonts.example/a.css"></head>')) }), expect: "loads https://fonts.example/a.css from another origin" },
    { name: "a local path", mutate: (i) => ({ ...i, files: withPage(i.files, "decisions/index.html", (h) => h.replace("</main>", "<p>file:///srv/repo</p></main>")) }), expect: "names a local path" },
    { name: "a JSON tree capped to a region that scrolls inside the page", mutate: (i) => ({ ...i, files: withPage(i.files, "assets/site.css", (c) => `${c}\n.jsontree { overflow: auto; max-height: 520px; }\n`) }), expect: "assets/site.css: .jsontree sets overflow: auto, which scrolls inside the page" },
    { name: "a list capped to a height", mutate: (i) => ({ ...i, files: withPage(i.files, "assets/site.css", (c) => `${c}\nul.tree-files { max-height: 320px; }\n`) }), expect: "assets/site.css: ul.tree-files sets max-height: 320px, which caps its height" },
    { name: "a script that sets a height cap", mutate: (i) => ({ ...i, files: withPage(i.files, "assets/jsontree.js", (j) => `${j}\ndocument.body.style.maxHeight = "520px";\n`) }), expect: "assets/jsontree.js: sets an overflow or a height cap" },
    { name: "a script that leaves its page", mutate: (i) => ({ ...i, files: withPage(i.files, "assets/map.js", (j) => `${j}\nlocation.href = "examples.html";\n`) }), expect: "assets/map.js: leaves the page it runs on" },
    { name: "a type-map link the router rewrites", mutate: (i) => ({ ...i, files: withPage(i.files, "index.html", (h) => h.replace("</main>", '<a href="map.html#!/type/LineItem?lock=main&amp;variant=with-proposals&amp;view=example">x</a></main>')) }), expect: "which the router rewrites: variant=with-proposals reads as variant=proposals" },
  ],
});

export const siteDeterministic = defineGate<TreeRunsInput>({
  id: "site-deterministic",
  title: "deterministic site",
  code: ["gates/common.ts#sameTreeRuns"],
  check: sameTreeRuns,
  fixtures: [{ name: "a run writes one file differently", mutate: (i) => ({ ...i, runs: [i.runs[0]!, flipFirst(i.runs[1]!)] }), expect: "run 2: " }],
});
