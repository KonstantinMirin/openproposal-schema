/**
 * The public site, `npm run site`: one site for every specification under
 * specs/ that specs/site.yaml lists, each spec's pages, assets, data files,
 * and schema files under `/<spec>/`, and at the root the page that lists the
 * specs. Every file is a function of the repository, and two builds write
 * the same bytes.
 *
 * The site serves each spec's schema files at the paths their `$id`s name
 * under the spec's path, and offers no downloads: it links each build's
 * folders in the public repository. It checks itself before it is written
 * (`checkSite`): every internal link and every resource a page loads names a
 * file of the site, and every link into a spec's type map names a type of
 * the build it opens, in the names that spec's router reads unchanged; every
 * link into the public repository names a path the export publishes; no page
 * runs inline script, sets an inline style, or loads anything from another
 * origin, so the site works under its Content-Security-Policy; nothing
 * scrolls inside a page, and no script leaves the page it runs on; and no
 * text names a document or path outside the public repository.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { schemaDirOf } from "../emit.ts";
import { RULES_FILE, rulesDirOf } from "../rules.ts";
import { DEFAULT_SDK_VARIANT, sdkDirOf } from "../sdk.ts";
import { TYPE_EXAMPLES_FILE, typeExamplesDirOf } from "../type-examples.ts";
import { loadRoute, type MapRoute } from "./route.ts";
import { buildData, loadSiteInputs, type SiteInputs } from "./data.ts";
import { decisionPage, decisionsIndex, examplesPage, filesPage, mapPage, type FileSet } from "./pages.ts";
import { siteCopyOf } from "./copy.ts";
import { rootFiles, type SpecCard } from "./root.ts";
import { registryPage } from "./registry.ts";
import { REPO_ROOT, specRoot } from "../repo.ts";
import { loadSiteConfig, lockNames, named, type SiteConfig } from "./config.ts";

const ASSETS = join("src", "site", "assets");

/** The assets the root's own pages load; none of them names a spec, so they carry no token. */
export const ROOT_ASSETS = ["icon.svg", "site.css", "site.js", "theme.js"];

/**
 * The folders of the repository the site may link. The export to the public
 * repository publishes each of them whole, and leaves out only folders of
 * notes outside them, so a tracked path under one of these is a path the
 * public repository holds once the export runs.
 */
export const LINKED_FOLDERS = ["sdk", "specs"];

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

/** A value's slug, as the type map's router reads a name: lowercase, with spaces and underscores as hyphens. */
const slugOf = (v: string) => v.trim().toLowerCase().replace(/[\s_]+/g, "-");

/** The tokens an asset names the specification's own things by, which the build fills from its profile. */
export function assetTokens(inputs: Pick<SiteInputs, "brand" | "locks" | "variants">): Record<string, string> {
  const b = inputs.brand;
  const names: Record<string, string> = {};
  const labels: Record<string, { label: string; where: string }> = {};
  for (const l of inputs.locks) {
    const n = lockNames(b, l.name);
    for (const alias of [l.name, slugOf(n.label), slugOf(n.short), ...(n.aliases ?? [])]) names[alias] ??= l.name;
    labels[l.name] = { label: n.label, where: n.where };
  }
  return {
    __SPEC_NAME__: named(b),
    __SPEC_ISSUE__: b.feedback ? `#${b.feedback.issueNumber}` : "",
    __SPEC_DEFAULT_TYPE__: b.defaultType,
    __SPEC_LOCKS__: JSON.stringify(inputs.locks.map((l) => l.name)),
    __SPEC_LOCK_NAMES__: JSON.stringify(names),
    __SPEC_LOCK_LABELS__: JSON.stringify(labels),
    __SPEC_VARIANTS__: JSON.stringify(inputs.variants.map((v) => v.slug)),
  };
}

/** An asset's bytes with each token filled in; an asset with no token is unchanged, byte for byte. Throws on a token the build doesn't fill. */
export function fillTokens(data: Buffer, tokens: Readonly<Record<string, string>>, path = "an asset"): Buffer {
  const text = data.toString("utf8");
  const found = [...new Set(text.match(/__SPEC_[A-Z_]+__/g) ?? [])];
  if (found.length === 0) return data;
  const unknown = found.filter((x) => !(x in tokens));
  if (unknown.length > 0) throw new Error(`${path}: names the token ${unknown.join(", ")}, which the build doesn't fill`);
  return Buffer.from(found.reduce((s, x) => s.replaceAll(x, tokens[x]!), text));
}

export interface Site {
  files: Map<string, Buffer>;
  problems: string[];
}

/**
 * One spec's pages, assets, data, and schema files, by path under the
 * spec's own path on the site, and its card for the root page: its schemas,
 * rules, and type examples from the spec's folder, and the assets from the
 * repository's root.
 */
export function buildSpecFiles(inputs: SiteInputs): { files: Map<string, Buffer>; card: SpecCard } {
  const root = REPO_ROOT;
  const spec = inputs.root;
  const out = new Map<string, Buffer>();
  const put = (path: string, data: string | Buffer) => out.set(path, typeof data === "string" ? Buffer.from(data) : data);

  // An asset names the specification's own things by tokens, such as `__SPEC_NAME__`, which the build fills from the spec's profile.
  const tokens = assetTokens(inputs);
  for (const f of files(root, ASSETS)) put(`assets/${f}`, fillTokens(readFileSync(join(root, ASSETS, f)), tokens, `src/site/assets/${f}`));

  // Each build's data for the type map, its schema tree at its `$id` paths, and its files in the repository.
  const sets: FileSet[] = [];
  for (const lock of inputs.locks) {
    for (const v of inputs.variants) {
      const b = inputs.builds.get(lock.name)!.get(v.slug)!;
      put(`data/${lock.name}.${v.slug}.json`, `${JSON.stringify(buildData(inputs, lock, v.slug))}\n`);
      const schemaDir = b.dirOf(schemaDirOf(lock.ir_dir));
      const tree = ["kernel", "modules", "documents"].flatMap((d) => (existsSync(join(spec, schemaDir, d)) ? files(spec, posix.join(schemaDir, d)).map((f) => `${d}/${f}`) : []));
      if (v.variant === undefined) tree.push("release.json");
      for (const f of tree) put(posix.join(schemaDir, f), readFileSync(join(spec, schemaDir, f)));
      const sdkDir = sdkDirOf(lock.ir_dir, b.variant);
      sets.push({
        lock: lock.name,
        variant: v.slug,
        schemaDir,
        rules: posix.join(b.dirOf(rulesDirOf(lock.ir_dir)), RULES_FILE),
        examples: posix.join(b.dirOf(typeExamplesDirOf(lock.ir_dir)), TYPE_EXAMPLES_FILE),
        schemas: tree.map((f) => posix.join(schemaDir, f)),
        sdk: existsSync(join(root, sdkDir)) && inputs.sdk ? { dir: sdkDir, default: b.variant === DEFAULT_SDK_VARIANT } : null,
      });
    }
  }

  const copy = siteCopyOf(inputs);
  put("index.html", copy.landing(inputs));
  put("how-it-is-built.html", copy.method(inputs));
  put("map.html", mapPage(inputs, copy.mapLegend?.(inputs)));
  put("examples.html", examplesPage(inputs));
  put("downloads.html", filesPage(inputs, sets));
  put("decisions/index.html", decisionsIndex(inputs));
  for (const d of inputs.decisions) if (d.status !== "superseded") put(`decisions/${d.id}.html`, decisionPage(inputs, d));

  const live = inputs.decisions.filter((d) => d.status !== "superseded");
  const main = inputs.builds.get(inputs.locks[0]!.name)!.get("as-written")!;
  const card: SpecCard = {
    spec: inputs.brand.spec,
    name: named(inputs.brand),
    release: inputs.brand.release,
    summary: copy.summary(inputs),
    gaps: live.filter((d) => d.kind === "gap").length,
    departures: live.filter((d) => d.kind === "departure").length,
    types: main.model.types.length,
    locks: inputs.locks.map((l) => lockNames(inputs.brand, l.name).short),
  };
  return { files: out, card };
}

/**
 * The paths of the public repository the site may link, each a file or a
 * folder: every file git tracks under `LINKED_FOLDERS`, which the export
 * publishes, and every folder that holds one. A file git tracks is one the
 * next export publishes; the public repository holds it once that export
 * runs.
 */
export function exportTree(root: string = REPO_ROOT): Map<string, "file" | "dir"> {
  const r = spawnSync("git", ["ls-files", "-z", "--", ...LINKED_FOLDERS], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  const out = new Map<string, "file" | "dir">();
  for (const f of r.stdout.split("\0").filter((x) => x !== "")) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) out.set(parts.slice(0, i).join("/"), "dir");
    out.set(f, "file");
  }
  return out;
}

/**
 * Builds the whole site: each spec's files under its path, in the order the
 * site's settings list the specs, and the root's own pages and assets.
 */
export function buildSite(specs?: SiteInputs[], site: SiteConfig = loadSiteConfig(), tree: ReadonlyMap<string, "file" | "dir"> = exportTree()): Site {
  const all = specs ?? site.specs.map((s) => loadSiteInputs(specRoot(s), site));
  const out = new Map<string, Buffer>();
  const cards: SpecCard[] = [];
  for (const inputs of all) {
    const { files: f, card } = buildSpecFiles(inputs);
    for (const [path, data] of f) out.set(`${inputs.brand.spec}/${path}`, data);
    // A registry of code lists gets a page of its lists and the other specs that cite each.
    if (inputs.brand.registry) out.set(`${inputs.brand.spec}/registry.html`, Buffer.from(registryPage(inputs, all.filter((x) => x !== inputs))));
    cards.push({ ...card, ...(inputs.brand.registry ? { registry: true } : {}) });
  }
  for (const f of ROOT_ASSETS) out.set(`assets/${f}`, fillTokens(readFileSync(join(REPO_ROOT, ASSETS, f)), {}, `src/site/assets/${f}`));
  for (const [path, data] of rootFiles(site, cards)) out.set(path, Buffer.from(data));
  const sorted = new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { files: sorted, problems: checkSite(sorted, { repo: site.repo, tree }) };
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

/** What `checkSite` checks the site's links into the public repository against: the repository, and the paths its export publishes. */
export interface ExportCheck {
  repo: string;
  /** Each path the site may link, a file or a folder (`exportTree`). */
  tree: ReadonlyMap<string, "file" | "dir">;
}

/**
 * Checks the built site: every internal reference resolves to a file; a
 * link into a spec's type map names a type its build has, in the names that
 * spec's router reads unchanged; a link into the public repository names a
 * path its export publishes; no page runs inline script or style or loads
 * another origin's resource; no stylesheet or script makes a region scroll
 * inside a page; no script leaves its page; and no text holds what `BANNED`
 * lists.
 */
export function checkSite(site: Map<string, Buffer>, exported?: ExportCheck): string[] {
  const problems: string[] = [];
  // Each spec's router, by its path on the site, such as `openproposal/`.
  const routes = new Map<string, MapRoute | null>();
  const routeOf = (prefix: string): MapRoute | null => {
    if (!routes.has(prefix)) {
      try {
        routes.set(prefix, loadRoute(site.get(`${prefix}assets/route.js`)?.toString("utf8") ?? ""));
      } catch (e) {
        problems.push(`${prefix}assets/route.js: the type map's router doesn't load: ${(e as Error).message}`);
        routes.set(prefix, null);
      }
    }
    return routes.get(prefix)!;
  };
  const types = new Map<string, Set<string>>();
  const typesOf = (prefix: string, lock: string, variant: string): Set<string> | undefined => {
    const k = `${prefix}data/${lock}.${variant}.json`;
    if (!types.has(k)) {
      const data = site.get(k);
      if (!data) return undefined;
      types.set(k, new Set((JSON.parse(data.toString("utf8")) as { types: { name: string }[] }).types.map((t) => t.name)));
    }
    return types.get(k);
  };
  // Every spec's router loads, whether or not a page links its type map with a route.
  for (const path of site.keys()) if (path === "map.html" || path.endsWith("/map.html")) routeOf(path.slice(0, -"map.html".length));
  for (const [path, data] of site) {
    const text = data.toString("utf8");
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
      // A link into the public repository names a path its export publishes, not only one the private tree holds.
      if (exported?.repo && (ref === exported.repo || ref.startsWith(`${exported.repo}/`) || ref.startsWith(`${exported.repo}#`))) {
        const problem = repoProblem(ref, exported);
        if (problem) problems.push(`${path}: links ${ref}, ${problem}`);
        continue;
      }
      // A link that starts with two slashes names another host, which a link on this site never means.
      if (ref.startsWith("//")) {
        problems.push(`${path}: links ${ref}, which names another host; a link within the site starts with one slash or none`);
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("#")) continue;
      const [file, hash] = ref.split("#", 2) as [string, string | undefined];
      const target = file.startsWith("/") ? file.slice(1) : posix.normalize(posix.join(dir, file.split("?")[0]!));
      const resolved = target === "" || target === "." || target.endsWith("/") ? `${target === "." ? "" : target}index.html` : target;
      if (!site.has(resolved)) {
        problems.push(`${path}: links ${ref}, which the site doesn't hold`);
        continue;
      }
      // A link into a spec's type map is an address its router reads unchanged, and names a type of the build it opens.
      if ((resolved === "map.html" || resolved.endsWith("/map.html")) && hash !== undefined) {
        const prefix = resolved.slice(0, -"map.html".length);
        const route = routeOf(prefix);
        if (!route) continue;
        const p = route.parse(`#${hash}`);
        if (!p.route) continue;
        if (p.changes.length > 0) problems.push(`${path}: links the type map at #${hash}, which the router rewrites: ${p.changes.join("; ")}`);
        const { type: name, lock, variant } = p.state;
        const have = typesOf(prefix, lock, variant);
        if (!have) problems.push(`${path}: links the type map on ${lock} ${variant}, which the site has no data for`);
        else if (!have.has(name)) problems.push(`${path}: links the type map at "${name}", which ${lock} ${variant} doesn't hold`);
      }
    }
  }
  return problems;
}

/**
 * What is wrong with a link into the public repository, or null: it is the
 * repository itself, a `tree` link to a folder, or a `blob` link to a file,
 * on `main`, at a path `exportTree` lists.
 */
function repoProblem(ref: string, exported: ExportCheck): string | null {
  const rest = ref.slice(exported.repo.length).split(/[#?]/, 1)[0]!;
  if (rest === "" || rest === "/") return null;
  const m = /^\/(tree|blob)\/main\/(.+)$/.exec(rest);
  const where = `the folders the export to the public repository publishes and the site links`;
  if (!m) return `which isn't a tree or blob link on main, so nothing checks that the export publishes it`;
  let at: string;
  try {
    at = decodeURIComponent(m[2]!).replace(/\/$/, "");
  } catch {
    return "whose path isn't a valid URL encoding";
  }
  const kind = exported.tree.get(at);
  if (kind === undefined) return `which names no tracked path under ${LINKED_FOLDERS.map((f) => `${f}/`).join(" or ")}, ${where}`;
  if (m[1] === "tree" && kind !== "dir") return "a tree link to a file; a file's link is a blob link";
  if (m[1] === "blob" && kind !== "file") return "a blob link to a folder; a folder's link is a tree link";
  return null;
}

/**
 * Each place the site's own code, every file under src/site/, names a
 * specification by the name its profile gives (`names.short`): the pages
 * read each name from the profile, so a name written into the code fails.
 */
export function hardCodedNames(sources: ReadonlyMap<string, string>, names: readonly string[]): string[] {
  const out: string[] = [];
  for (const [path, text] of sources) {
    for (const name of names) {
      const at = text.split("\n").findIndex((l) => l.includes(name));
      if (at >= 0) out.push(`${path}:${at + 1}: names "${name}", which a spec's profile gives; read it from the profile (src/site/config.ts)`);
    }
  }
  return out;
}
