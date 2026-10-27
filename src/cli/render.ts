import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConstructors } from "../constructors.ts";
import { loadKernel } from "../kernel.ts";
import { loadLock, type SpecLock } from "../lock.ts";
import { loadDecisions, loadMappings } from "../mapping.ts";
import { resolveModel } from "../model.ts";
import { checkDifferences, loadDifferences, renderMarkdown, roundTrip } from "../render.ts";

/**
 * Usage: render [--lock <file>] [--out <dir>]
 *
 * Stage 5d, the round trip. Resolves each lock's model, renders the
 * specification's field, key, marker, and value-definition tables and
 * Appendix A and B from it, and compares them with the tables the lock's IR
 * records. Writes the rendered tables to `tables.md` beside the lock's
 * `model.json`: `build/tables.md`, or `build/<its IR directory under
 * ir/>/tables.md`, such as `build/with-open-prs/tables.md`. `--lock` renders
 * one lock, and `--out` sets its directory. Prints each difference, and
 * exits 1 if a difference isn't recorded in `roundtrip/differences.yaml`, a
 * recorded one no longer occurs, or the renderer can't place what the IR
 * records.
 */
function main(): number {
  const { values } = parseArgs({ options: { lock: { type: "string" }, out: { type: "string" } } });
  const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  if (values.out !== undefined && values.lock === undefined) throw new Error("--out needs --lock");
  const locks: SpecLock[] =
    values.lock !== undefined
      ? [loadLock(resolve(values.lock))]
      : readdirSync(join(root, "spec-input"))
          .filter((f) => f === "spec-lock.yaml" || f.endsWith(".lock.yaml"))
          .sort()
          .map((f) => loadLock(join(root, "spec-input", f)));
  const mappings = loadMappings(root, join(root, "mapping"));
  const decisions = loadDecisions(root, join(root, "decisions"));
  const kernel = loadKernel(root);
  const constructors = loadConstructors(root);
  const recorded = loadDifferences(root);

  let failed = false;
  for (const lock of locks) {
    const ir = JSON.parse(readFileSync(join(root, lock.ir_dir, "spec-ir.json"), "utf8"));
    const { model, problems } = resolveModel({ ir, lock: lock.name, mappings, decisions, kernel, constructors });
    if (problems.length > 0) {
      for (const p of problems) console.error(`error: ${lock.name}: model: ${p}`);
      failed = true;
      continue;
    }
    const rt = roundTrip(model, ir);
    const out = values.out !== undefined ? resolve(values.out) : join(root, "build", relative(join(root, "ir"), join(root, lock.ir_dir)));
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "tables.md"), renderMarkdown(rt, lock.name));
    const rows = rt.model.reduce((n, t) => n + t.rows.length, 0);
    const shown = out.startsWith(`${root}/`) ? out.slice(root.length + 1) : out;
    console.log(`${lock.name}: ${rt.model.length} tables, ${rows} rows in ${shown}/tables.md; ${rt.differences.length} difference${rt.differences.length === 1 ? "" : "s"} from the specification`);
    for (const d of rt.differences) console.log(`  ${d.table} ${d.row} [${d.column}]\n    specification: ${d.spec}\n    model:         ${d.model}`);
    const all = [...rt.problems, ...checkDifferences(rt.differences, recorded, lock.name, decisions)];
    for (const p of all) console.error(`error: ${lock.name}: ${p}`);
    if (all.length > 0) failed = true;
  }
  return failed ? 1 : 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
