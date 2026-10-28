import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConstructors } from "../constructors.ts";
import { loadKernel } from "../kernel.ts";
import { loadLock } from "../lock.ts";
import { writeMappings, type LockIr } from "../map-writer.ts";
import { loadMappings } from "../mapping.ts";
import { cliSpec } from "../builds.ts";
import { REPO_ROOT } from "../repo.ts";

/**
 * Usage: map [--check]
 *
 * Rewrites `mapping/*.yaml` from every lock's committed IR: it keeps each
 * entry and type that cites a decision record, derives every other one with
 * the mapping rules, and writes each file in canonical order. With
 * `--check`, it writes nothing and exits 1 if any file would change.
 */
function main(): number {
  const { values } = parseArgs({ options: { spec: { type: "string" }, check: { type: "boolean", default: false } } });
  const root = REPO_ROOT;
  const specDir = cliSpec(values);
  const locks: LockIr[] = readdirSync(join(specDir, "spec-input"))
    .filter((f) => f === "spec-lock.yaml" || f.endsWith(".lock.yaml"))
    .sort()
    .map((f) => {
      const lock = loadLock(join(specDir, "spec-input", f));
      return { name: lock.name, ir: JSON.parse(readFileSync(join(specDir, lock.ir_dir, "spec-ir.json"), "utf8")) };
    });
  const out = writeMappings(locks, loadMappings(join(specDir, "mapping")), loadKernel(root, specDir), loadConstructors(root, specDir));
  const changed = [...out].filter(([file, text]) => readFileSync(file, "utf8") !== text).map(([file]) => file);
  if (values.check) {
    for (const f of changed) console.error(`error: ${f.slice(root.length + 1)} is not what npm run map writes`);
    return changed.length > 0 ? 1 : 0;
  }
  for (const f of changed) writeFileSync(f, out.get(f)!);
  console.log(`${out.size} mapping files, ${changed.length} rewritten`);
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
