import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CSP_HEADER } from "../site/config.ts";
import { buildSite } from "../site/build.ts";
import { REPO_ROOT } from "../repo.ts";

/**
 * Usage: site [--out <dir>]
 *
 * Builds the public site (src/site/build.ts) into `site/`, which git
 * ignores, or into `--out`: the landing page, the type map, the example
 * payloads, a page per decision record with their index, the downloads,
 * and every schema file at the path its `$id` names. The directory is
 * replaced whole. Exits 1, writing nothing, if the site's own check finds a
 * broken internal link, an inline script or style, a resource from another
 * origin, or text the public site must not hold.
 */
function main(): number {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const root = REPO_ROOT;
  const site = buildSite();
  if (site.problems.length > 0) {
    for (const p of site.problems) console.error(`error: site: ${p}`);
    return 1;
  }
  const out = values.out !== undefined ? resolve(values.out) : join(root, "site");
  rmSync(out, { recursive: true, force: true });
  for (const [path, data] of site.files) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), data);
  }
  const bytes = [...site.files.values()].reduce((n, b) => n + b.length, 0);
  const pages = [...site.files.keys()].filter((p) => p.endsWith(".html")).length;
  const shown = out.startsWith(`${root}/`) ? out.slice(root.length + 1) : out;
  console.log(`${site.files.size} files, ${pages} pages, ${Math.round(bytes / 1024)} KB in ${shown}/. Serve it with this header: Content-Security-Policy: ${CSP_HEADER}`);
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
