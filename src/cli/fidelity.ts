import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { canonicalJson } from "../canonical.ts";
import { loadConstructors } from "../constructors.ts";
import { emitSchemas, schemaDirOf } from "../emit.ts";
import { checkFidelity, fidelityNote, readingsOf } from "../fidelity.ts";
import { loadKernel } from "../kernel.ts";
import { loadLock, type SpecLock } from "../lock.ts";
import { loadDecisions, loadMappings } from "../mapping.ts";
import { resolveModel } from "../model.ts";
import { emitRules, loadVectors } from "../rules.ts";
import { loadExpected, ruledOn } from "../../gates/fidelity.ts";

/**
 * Usage: fidelity [--lock <file>] [--out <dir>]
 *
 * The fidelity gate (src/fidelity.ts). Reads every constraint each lock's IR
 * states in a form the oracle knows, checks the emitted schemas and rules
 * against its vectors, with the constraints `gates/fidelity-expected.yaml`
 * leaves to a rule, and prints each disagreement no departure covers.
 * Writes the full report of each lock, every constraint, vector count,
 * disagreement, and unread form, to `<out>/<lock>/fidelity.json` (default
 * `build/fidelity.json` for `main` and `build/<lock>/fidelity.json` for
 * another lock). Exits 1 on a disagreement or a problem.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({ options: { lock: { type: "string" }, out: { type: "string" } } });
  const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
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
  const vectors = loadVectors(root);
  const expected = loadExpected();
  let failed = false;
  for (const lock of locks) {
    const ir = JSON.parse(readFileSync(join(root, lock.ir_dir, "spec-ir.json"), "utf8"));
    const { model, problems } = resolveModel({ ir, lock: lock.name, mappings, decisions, kernel, constructors });
    if (problems.length > 0) {
      for (const p of problems) console.error(`error: ${lock.name}: model: ${p}`);
      failed = true;
      continue;
    }
    const schemaDir = schemaDirOf(lock.ir_dir);
    const emitted = emitSchemas(model, schemaDir);
    const rules = emitRules({ model, ir, lock: lock.name, vectors, decisions, schemaDir, conditionsLeft: emitted.conditions.left });
    const r = checkFidelity({ ir, lock: lock.name, model, files: emitted.files, kernel, rules: rules.doc, decisions, readings: readingsOf(mappings, lock.name), schemaDir, ruled: ruledOn(expected, lock.name) });
    console.log(`${lock.name}: ${fidelityNote(r)}`);
    const listed = new Map(expected.groups.flatMap((g) => g.disagreements.filter((d) => d.locks.includes(lock.name)).map((d) => [d.constraint, g.owner] as const)));
    for (const d of r.disagreements) console.log(`  ${listed.has(d.constraint) ? `expected under ${listed.get(d.constraint)}` : "DISAGREE"} ${d.constraint}: ${d.detail}`);
    for (const d of r.departed) console.log(`  departure ${d.decision} (${d.status}) ${d.constraint}: ${d.detail}`);
    for (const d of r.ruled) console.log(`  rule ${d.rule} ${d.constraint}: ${d.detail}`);
    for (const p of r.problems) console.log(`  PROBLEM ${p}`);
    // One report per lock: under `--out`, each lock's in its own directory, so two locks never write one file.
    const out = values.out !== undefined ? join(resolve(values.out), lock.name) : join(root, "build", ...(lock.ir_dir === "ir" ? [] : [lock.ir_dir.slice(3)]));
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "fidelity.json"), canonicalJson(r));
    if (r.disagreements.some((d) => !listed.has(d.constraint)) || r.problems.length > 0) failed = true;
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e: Error) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  },
);
