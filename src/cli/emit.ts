import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BUILD_OPTIONS, cliBuilds, cliSpec } from "../builds.ts";
import { emitSchemas, schemaDirOf, SCHEMA_ROOTS } from "../emit.ts";
import { REPO_ROOT } from "../repo.ts";
import { schemaNamesOfLock } from "../specs/index.ts";

/**
 * Usage: emit [--lock <file>] [--variant <name>] [--out <dir>]
 *
 * Stage 5a. Resolves each lock's model, as `npm run resolve` does, and emits
 * its JSON Schema 2020-12 files. The default lock's files go to `schemas/`,
 * another lock's to `schemas/<its IR directory under ir/>/`, such as
 * `schemas/with-open-prs/`, and each variant's under `schemas/<variant>/`,
 * such as `schemas/as-written/` (src/variant.ts). `--lock` emits one lock,
 * `--variant` one variant, or `proposed`, and `--out` sets the directory of
 * the one build it names, the proposed one unless `--variant` says. The `kernel/`, `modules/`, and `documents/` directories under
 * it are replaced whole, so no stale file survives. Exits 1, writing
 * nothing, if the model doesn't resolve or the emitter finds a problem.
 */
function main(): number {
  const { values } = parseArgs({ options: BUILD_OPTIONS });
  const root = REPO_ROOT;
  const specDir = cliSpec(values);
  let failed = false;
  for (const b of cliBuilds(values)) {
    if (b.problems.length > 0) {
      for (const p of b.problems) console.error(`error: ${b.label}: model: ${p}`);
      failed = true;
      continue;
    }
    const dir = b.dirOf(schemaDirOf(b.irDir));
    const emitted = emitSchemas(b.model, dir, schemaNamesOfLock(b.lock));
    if (emitted.problems.length > 0) {
      for (const p of emitted.problems) console.error(`error: ${b.label}: ${p}`);
      failed = true;
      continue;
    }
    const out = values.out !== undefined ? resolve(values.out) : join(specDir, dir);
    for (const d of SCHEMA_ROOTS) rmSync(join(out, d), { recursive: true, force: true });
    for (const f of emitted.files) {
      mkdirSync(dirname(join(out, f.path)), { recursive: true });
      writeFileSync(join(out, f.path), f.text);
    }
    const shown = out.startsWith(`${root}/`) ? out.slice(root.length + 1) : out;
    console.log(`${b.label}: ${emitted.files.length} files in ${shown}/; ${emitted.conditions.expressed.length} conditions as if / then, ${emitted.conditions.left.length} left to the rules`);
  }
  return failed ? 1 : 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
