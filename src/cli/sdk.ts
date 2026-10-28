import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BUILD_OPTIONS, cliBuilds } from "../builds.ts";
import { schemaDirOf } from "../emit.ts";
import { sdkDirOf } from "../sdk.ts";
import { emitSdk, SDK_ROOTS } from "../sdk-emit.ts";
import { REPO_ROOT } from "../repo.ts";
import { profileOf, schemaNamesOfLock } from "../specs/index.ts";

/**
 * Usage: sdk [--lock <file>] [--variant <name>] [--out <dir>]
 *
 * Stage 5c. Resolves each lock's model, as `npm run resolve` does, and
 * generates its TypeScript, Python, and Go types. The as-written variant's
 * types are the default tree: the default lock's go to `sdk/`, and another
 * lock's to `sdk/<its IR directory under ir/>/`, such as
 * `sdk/with-open-prs/`. The schemas we propose are an opt-in tree under
 * `sdk/proposed/`, as `sdk/proposed/` and `sdk/proposed/with-open-prs/`
 * (`sdkDirOf`). `--lock` generates one lock, `--variant` one variant, or
 * `proposed`, and `--out` sets the directory of the one build it names. The
 * `ts/`, `python/`, and `go/` directories under it are replaced whole, so no
 * stale file survives. Exits 1, writing nothing, if
 * the model doesn't resolve or an emitter finds a problem.
 */
function main(): number {
  const { values } = parseArgs({ options: BUILD_OPTIONS });
  const root = REPO_ROOT;
  let failed = false;
  for (const b of cliBuilds(values)) {
    if (b.problems.length > 0) {
      for (const p of b.problems) console.error(`error: ${b.label}: model: ${p}`);
      failed = true;
      continue;
    }
    const dir = sdkDirOf(b.irDir, b.variant);
    const emitted = emitSdk(b.model, dir, b.dirOf(schemaDirOf(b.irDir)), profileOf(b.lock).names, schemaNamesOfLock(b.lock));
    if (emitted.problems.length > 0) {
      for (const p of emitted.problems) console.error(`error: ${b.label}: ${p}`);
      failed = true;
      continue;
    }
    const out = values.out !== undefined ? resolve(values.out) : join(root, dir);
    for (const d of SDK_ROOTS) rmSync(join(out, d), { recursive: true, force: true });
    for (const f of emitted.files) {
      mkdirSync(dirname(join(out, f.path)), { recursive: true });
      writeFileSync(join(out, f.path), f.text);
    }
    const shown = out.startsWith(`${root}/`) ? out.slice(root.length + 1) : out;
    console.log(`${b.label}: ${emitted.files.length} files in ${shown}/; ${emitted.sdk.emitted.length} named types and ${emitted.sdk.templates.size} generic templates per language`);
  }
  return failed ? 1 : 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
