/**
 * The public site, `npm run site`: every page, asset, data file, schema
 * file, and download, by its path on the site, as a function of the
 * repository. Two builds write the same bytes.
 *
 * The site serves each schema file at the path its `$id` names under the
 * site's URL, and checks itself before it is written (`checkSite`): every
 * internal link and every resource a page loads names a file of the site,
 * and every link into the type map names a type of the build it opens, in
 * the names the map's router reads unchanged; no page runs inline script,
 * sets an inline style, or loads anything from another origin, so the site
 * works under its Content-Security-Policy; nothing scrolls inside a page,
 * and no script leaves the page it runs on; and no text names a document or
 * path outside the public repository.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { schemaDirOf } from "../emit.ts";
import { RULES_FILE, rulesDirOf } from "../rules.ts";
import { DEFAULT_SDK_VARIANT, sdkDirOf } from "../sdk.ts";
import { TYPE_EXAMPLES_FILE, typeExamplesDirOf } from "../type-examples.ts";
import { loadRoute, type MapRoute } from "./route.ts";
import { buildData, loadSiteInputs, SITE_VARIANTS, type SiteInputs, type VariantSlug } from "./data.ts";
import { decisionPage, decisionsIndex, downloadsPage, examplesPage, landingPage, mapPage, notFoundPage, type DownloadSet } from "./pages.ts";
import { methodPage } from "./method.ts";
import { zip } from "./zip.ts";

const ASSETS = join("src", "site", "assets");

/** Every file under a directory of the repository, by path in it, sorted; Python's caches aside. */
function files(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === "__pycache__" || e.name === "node_modules") continue;
      const p = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk("");
  return out;
}

export interface Site {
  files: Map<string, Buffer>;
  problems: string[];
}

/** Builds the site from the repository at `root`. */
export function buildSite(root: string, inputs: SiteInputs = loadSiteInputs(root)): Site {
  const out = new Map<string, Buffer>();
  const put = (path: string, data: string | Buffer) => out.set(path, typeof data === "string" ? Buffer.from(data) : data);

  for (const f of files(root, ASSETS)) put(`assets/${f}`, readFileSync(join(root, ASSETS, f)));

  // Each build's data for the type map, and its schema tree at its `$id` paths.
  const sets: DownloadSet[] = [];
  for (const lock of inputs.locks) {
    for (const v of SITE_VARIANTS) {
      const slug: VariantSlug = v.slug;
      const b = inputs.builds.get(lock.name)!.get(slug)!;
      put(`data/${lock.name}.${slug}.json`, `${JSON.stringify(buildData(inputs, lock, slug))}\n`);
      const schemaDir = b.dirOf(schemaDirOf(lock.ir_dir));
      const tree = ["kernel", "modules", "documents"].flatMap((d) => files(root, posix.join(schemaDir, d)).map((f) => `${d}/${f}`));
      if (slug === "proposals") tree.push("release.json");
      for (const f of tree) put(posix.join(schemaDir, f), readFileSync(join(root, schemaDir, f)));
      const name = `openproposal-${lock.name}-${slug}`;
      const at = `downloads/${lock.name}/${slug}`;
      const zipOf = (dir: string, sub: string[]) => zip(sub.map((f) => ({ path: `${name}/${f}`, data: readFileSync(join(root, dir, f)) })));
      const sdkDir = sdkDirOf(lock.ir_dir, b.variant);
      const sdkFiles = (lang: string) => files(root, posix.join(sdkDir, lang)).map((f) => `${lang}/${f}`);
      const add: DownloadSet["files"] = [];
      const offer = (label: string, file: string, data: Buffer, what: string) => {
        put(`${at}/${file}`, data);
        add.push({ label, path: `${at}/${file}`, bytes: data.length, what });
      };
      offer("JSON Schema files", "schemas.zip", zipOf(schemaDir, tree), `${tree.length} files, JSON Schema 2020-12`);
      offer("Rules", RULES_FILE, readFileSync(join(root, b.dirOf(rulesDirOf(lock.ir_dir)), RULES_FILE)), "the rules JSON Schema can't express, with test vectors");
      offer("Example payloads", "type-examples.json", readFileSync(join(root, b.dirOf(typeExamplesDirOf(lock.ir_dir)), TYPE_EXAMPLES_FILE)), "an example of every named type");
      offer("TypeScript types", "typescript.zip", zipOf(sdkDir, sdkFiles("ts")), "Zod 4");
      offer("Python types", "python.zip", zipOf(sdkDir, sdkFiles("python")), "Pydantic 2");
      offer("Go types", "go.zip", zipOf(sdkDir, sdkFiles("go")), "the standard library only");
      sets.push({ lock: lock.name, variant: slug, files: add, schemas: tree.map((f) => posix.join(schemaDir, f)), sdkDir, sdkDefault: b.variant === DEFAULT_SDK_VARIANT });
    }
  }

  put("index.html", landingPage(inputs));
  put("how-it-is-built.html", methodPage(inputs));
  put("map.html", mapPage());
  put("examples.html", examplesPage(inputs));
  put("downloads.html", downloadsPage(sets));
  put("decisions/index.html", decisionsIndex(inputs));
  for (const d of inputs.decisions) if (d.status !== "superseded") put(`decisions/${d.id}.html`, decisionPage(inputs, d));
  put("404.html", notFoundPage());
  put("robots.txt", "User-agent: *\nAllow: /\n");

  const sorted = new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { files: sorted, problems: checkSite(sorted) };
}

/** Text the public site must not hold: internal task and gate IDs, local paths, and an assistant's name. */
const BANNED: [RegExp, string][] = [
  [/\bops-[a-z0-9]{3,}(\.\d+)?\b/, "names an internal task ID"],
  [/\bG-0\d\d\b/, "names an internal gate decision"],
  [/\/Users\/|file:\/\/|[A-Z]:\\\\/, "names a local path"],
  [/\bclaude\b/i, "names an assistant"],
];

/**
 * Each rule of a stylesheet that makes a region scroll inside the page: an
 * `overflow` of `auto` or `scroll` on either axis, or a capped height. The
 * owner of the site rejects any scrolling viewport inside a document, so a
 * long line wraps instead.
 */
export function scrollRegions(css: string): string[] {
  const out: string[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1]!.trim().replace(/\s+/g, " ");
    for (const d of m[2]!.split(";")) {
      const at = d.indexOf(":");
      if (at < 0) continue;
      const name = d.slice(0, at).trim().toLowerCase();
      const value = d.slice(at + 1).trim().toLowerCase();
      if (/^overflow(-x|-y|-block|-inline)?$/.test(name) && /\b(auto|scroll)\b/.test(value)) out.push(`${selector} sets ${name}: ${value}, which scrolls inside the page`);
      if (/^max-(height|block-size)$/.test(name) && value !== "none") out.push(`${selector} sets ${name}: ${value}, which caps its height`);
    }
  }
  return out;
}

/** What a script must not do: leave the page it runs on, or make a region scroll inside it. */
const SCRIPT_BANS: [RegExp, string][] = [
  [/\blocation\s*\.\s*(?:href\s*=(?!=)|assign\s*\(|replace\s*\(|reload\s*\()|\blocation\s*=(?!=)|\b(?:pushState|replaceState)\s*\([^,]*,[^,]*,\s*["'](?!#)/, "leaves the page it runs on, where a page may write only its hash"],
  [/\.style\.(?:overflow\w*|maxHeight)\b|setProperty\(\s*["'](?:overflow|max-height)/, "sets an overflow or a height cap, which makes a region scroll inside the page"],
];

/**
 * Checks the built site: every internal reference resolves to a file, a
 * link into the type map names a type its build has in the names the
 * router reads unchanged, no page runs inline script or style or loads
 * another origin's resource, no stylesheet or script makes a region scroll
 * inside a page, no script leaves its page, and no text holds what `BANNED`
 * lists.
 */
export function checkSite(site: Map<string, Buffer>): string[] {
  const problems: string[] = [];
  let route: MapRoute | null = null;
  try {
    route = loadRoute(site.get("assets/route.js")?.toString("utf8") ?? "");
  } catch (e) {
    problems.push(`assets/route.js: the type map's router doesn't load: ${(e as Error).message}`);
  }
  const types = new Map<string, Set<string>>();
  const typesOf = (lock: string, variant: string): Set<string> | undefined => {
    const k = `${lock}.${variant}`;
    if (!types.has(k)) {
      const data = site.get(`data/${k}.json`);
      if (!data) return undefined;
      types.set(k, new Set((JSON.parse(data.toString("utf8")) as { types: { name: string }[] }).types.map((t) => t.name)));
    }
    return types.get(k);
  };
  for (const [path, data] of site) {
    const text = path.endsWith(".zip") ? "" : data.toString("utf8");
    for (const [re, why] of BANNED) if (re.test(text)) problems.push(`${path}: ${why}: ${re.exec(text)![0]}`);
    if (path.endsWith(".css")) for (const r of scrollRegions(text)) problems.push(`${path}: ${r}`);
    if (path.endsWith(".js")) for (const [re, why] of SCRIPT_BANS) if (re.test(text)) problems.push(`${path}: ${why}: ${re.exec(text)![0]}`);
    if (!path.endsWith(".html")) continue;
    if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(text)) problems.push(`${path}: a script without src, which the Content-Security-Policy blocks`);
    if (/<style[\s>]/i.test(text) || /\sstyle="/i.test(text)) problems.push(`${path}: an inline style, which the Content-Security-Policy blocks`);
    if (/\son[a-z]+="/i.test(text)) problems.push(`${path}: an inline event handler, which the Content-Security-Policy blocks`);
    for (const m of text.matchAll(/<(script|link|img|source|iframe)\b[^>]*\s(?:src|href)="([^"]+)"/gi)) {
      if (/^(https?:)?\/\//.test(m[2]!)) problems.push(`${path}: loads ${m[2]} from another origin`);
    }
    const dir = posix.dirname(path);
    for (const m of text.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      const ref = m[1]!.replace(/&amp;/g, "&");
      if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("#") || ref.startsWith("//")) continue;
      const [file, hash] = ref.split("#", 2) as [string, string | undefined];
      const target = file.startsWith("/") ? file.slice(1) : posix.normalize(posix.join(dir, file.split("?")[0]!));
      const resolved = target === "" || target.endsWith("/") ? `${target}index.html` : target;
      if (!site.has(resolved)) {
        problems.push(`${path}: links ${ref}, which the site doesn't hold`);
        continue;
      }
      // A link into the type map is an address the router reads unchanged, and names a type of the build it opens.
      if (resolved === "map.html" && hash !== undefined && route) {
        const p = route.parse(`#${hash}`);
        if (!p.route) continue;
        if (p.changes.length > 0) problems.push(`${path}: links the type map at #${hash}, which the router rewrites: ${p.changes.join("; ")}`);
        const { type: name, lock, variant } = p.state;
        const have = typesOf(lock, variant);
        if (!have) problems.push(`${path}: links the type map on ${lock} ${variant}, which the site has no data for`);
        else if (!have.has(name)) problems.push(`${path}: links the type map at "${name}", which ${lock} ${variant} doesn't hold`);
      }
    }
  }
  return problems;
}
