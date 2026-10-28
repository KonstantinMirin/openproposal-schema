import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetTokens, buildSite, fillTokens, checkSite } from "../src/site/build.ts";
import { loadSiteInputs } from "../src/site/data.ts";
import { mapLink } from "../src/site/route.ts";
import { loadRoute, type RouteState } from "../src/site/route.ts";
import { ROOT, SPEC } from "./helpers.ts";

// The router as the site serves it, with its tokens filled from the profile.
const INPUTS = loadSiteInputs(SPEC);
const ROUTE = loadRoute(fillTokens(readFileSync(join(ROOT, "src", "site", "assets", "route.js")), assetTokens(INPUTS)).toString("utf8"));
// OpenProposal with the registry its schemas reference, whose pages its type map links.
const SITE = buildSite([INPUTS, loadSiteInputs(join(ROOT, "specs", "adcom"))]);
/** OpenProposal's pages are under its path on the site. */
const OP = "openproposal/";

const parsed = (hash: string) => {
  const p = ROUTE.parse(hash);
  assert.ok(p.route, `${hash} is a route`);
  return p;
};

test("the router's canonical names are the ones the site's switches and builds use", () => {
  assert.deepEqual(ROUTE.LOCKS, ["main", "with-open-prs"]);
  assert.deepEqual(ROUTE.VARIANTS, ["as-written", "proposals"]);
  assert.deepEqual(ROUTE.VIEWS, ["schema", "example"]);
  assert.deepEqual(ROUTE.DEFAULT, { type: "LineItem", lock: "main", variant: "as-written", view: "schema", open: [] });
  for (const lock of ROUTE.LOCKS) for (const variant of ROUTE.VARIANTS) assert.ok(SITE.files.has(`${OP}data/${lock}.${variant}.json`), `${lock}.${variant}`);
});

test("every canonical address reads back as itself, with no change", () => {
  const opens = [[], ["formats"], ["formats", "formats/pricing"]];
  for (const type of ["LineItem", "Proposal", "FormatsSelection"])
    for (const lock of ROUTE.LOCKS)
      for (const variant of ROUTE.VARIANTS)
        for (const view of ROUTE.VIEWS)
          for (const open of opens) {
            const s: RouteState = { type, lock, variant, view, open };
            const p = parsed(ROUTE.hashOf(s));
            assert.deepEqual(p.state, s, ROUTE.hashOf(s));
            assert.deepEqual(p.changes, [], ROUTE.hashOf(s));
          }
});

test("every other name of a parameter or a value reads as its canonical one, and says so", () => {
  const names = (key: string) => Object.entries(ROUTE.PARAMS).filter(([, k]) => k === key).map(([n]) => n);
  const values = (key: "lock" | "variant" | "view") => Object.entries(ROUTE.VALUES[key]);
  for (const ln of names("lock"))
    for (const [lv, lock] of values("lock"))
      for (const vn of names("variant"))
        for (const [vv, variant] of values("variant"))
          for (const wn of names("view"))
            for (const [wv, view] of values("view")) {
              const hash = `#!/type/LineItem?${ln}=${lv}&${vn}=${vv}&${wn}=${wv}`;
              const p = parsed(hash);
              assert.deepEqual(p.state, { type: "LineItem", lock, variant, view, open: [] }, hash);
              const canonical = ln === "lock" && lv === lock && vn === "variant" && vv === variant && wn === "view" && wv === view;
              assert.equal(p.changes.length === 0, canonical, `${hash}: ${p.changes.join("; ")}`);
            }
});

test("an address that names the variant by its label opens that variant and view, not the defaults", () => {
  // The address that loaded as variant=as-written&view=schema.
  const p = parsed("#!/type/LineItem?lock=main&variant=with-proposals&view=example");
  assert.deepEqual(p.state, { type: "LineItem", lock: "main", variant: "proposals", view: "example", open: [] });
  assert.deepEqual(p.changes, ["variant=with-proposals reads as variant=proposals"]);
  assert.equal(ROUTE.hashOf(p.state), "#!/type/LineItem?lock=main&variant=proposals&view=example");
  assert.deepEqual(parsed("#!/type/LineItem?lock=With%20the%20open%20PRs&variant=With%20our%20proposals&view=Example").state, { type: "LineItem", lock: "with-open-prs", variant: "proposals", view: "example", open: [] });
});

test("an unknown value or parameter changes only itself, and a missing one takes its default silently", () => {
  const p = parsed("#!/type/Proposal?lock=with-open-prs&variant=bogus&view=example&zoom=2");
  assert.deepEqual(p.state, { type: "Proposal", lock: "with-open-prs", variant: "as-written", view: "example", open: [] });
  assert.deepEqual(p.changes, ["variant=bogus names no variant, so the map shows as-written", "zoom=2 is no setting of the map, so it is left out"]);
  for (const [hash, state] of [
    ["", ROUTE.DEFAULT],
    ["#!", ROUTE.DEFAULT],
    ["#!/", ROUTE.DEFAULT],
    ["#!/type/Proposal", { ...ROUTE.DEFAULT, type: "Proposal" }],
    ["#!/type/Proposal?view=example", { ...ROUTE.DEFAULT, type: "Proposal", view: "example" }],
    ["#!/?lock=with-open-prs&variant=proposals", { ...ROUTE.DEFAULT, lock: "with-open-prs", variant: "proposals" }],
  ] as [string, RouteState][]) {
    const q = parsed(hash);
    assert.deepEqual(q.state, state, hash);
    assert.deepEqual(q.changes, [], hash);
  }
});

test("other spellings of the path read as the type route", () => {
  assert.deepEqual(parsed("#/type/Proposal?view=example").state, { ...ROUTE.DEFAULT, type: "Proposal", view: "example" });
  assert.deepEqual(parsed("#!/Proposal").state, { ...ROUTE.DEFAULT, type: "Proposal" });
  assert.deepEqual(parsed("#!/?type=Proposal").state, { ...ROUTE.DEFAULT, type: "Proposal" });
  assert.deepEqual(parsed("#!/type/Line%20Item").state.type, "Line Item");
  const odd = parsed("#!/types/of/things?variant=proposals");
  assert.deepEqual(odd.state, { ...ROUTE.DEFAULT, variant: "proposals" });
  assert.match(odd.changes.join(), /names no view, so the map opens at LineItem/);
});

test("a hash that names an element of the page, such as the skip link's, is no route", () => {
  for (const hash of ["#main", "#top", "#q"]) assert.deepEqual(ROUTE.parse(hash), { route: false });
});

test("every link the site's pages write into the type map is an address the router reads unchanged", () => {
  let links = 0;
  for (const [path, data] of SITE.files) {
    if (!path.endsWith(".html") || !path.startsWith(OP)) continue;
    for (const m of data.toString("utf8").matchAll(/href="(?:\.\.\/)*map\.html#([^"]+)"/g)) {
      const p = parsed(`#${m[1]!.replace(/&amp;/g, "&")}`);
      assert.deepEqual(p.changes, [], `${path}: ${m[1]}`);
      links++;
    }
  }
  assert.ok(links > 50, `${links} links into the type map`);
  for (const lock of ROUTE.LOCKS)
    for (const variant of ["as-written", "proposals"] as const)
      for (const view of [undefined, "schema", "example"] as const) assert.deepEqual(parsed(`#${mapLink("", "LineItem", lock, variant, view).split("#")[1]}`).changes, []);
});

test("the site's check fails on a type-map link the router rewrites, and on a script that leaves its page", () => {
  const withFile = (path: string, f: (s: string) => string) => new Map([...SITE.files].map(([p, b]) => [p, p === path ? Buffer.from(f(b.toString("utf8"))) : b]));
  const link = checkSite(withFile(`${OP}index.html`, (h) => h.replace("</main>", '<a href="map.html#!/type/LineItem?lock=main&amp;variant=with-proposals&amp;view=example">x</a></main>')));
  assert.match(link.join("\n"), /openproposal\/index\.html: links the type map at #!\/type\/LineItem\?lock=main&variant=with-proposals&view=example, which the router rewrites: variant=with-proposals reads as variant=proposals/);
  for (const code of ['location.href = "examples.html";', 'window.location = "examples.html";', 'location.assign("examples.html");', 'history.replaceState(null, "", "examples.html");']) {
    assert.match(checkSite(withFile(`${OP}assets/map.js`, (s) => `${s}\n${code}\n`)).join("\n"), /assets\/map\.js: leaves the page it runs on/, code);
  }
  assert.deepEqual(checkSite(withFile(`${OP}assets/map.js`, (s) => `${s}\nlocation.hash = "#!/";\nhistory.replaceState(null, "", "#!/");\n`)), []);
});
