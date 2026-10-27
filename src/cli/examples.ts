import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { loadConstructors } from "../constructors.ts";
import { emitSchemas, schemaDirOf } from "../emit.ts";
import { codesOf } from "../rule-checks.ts";
import { checkExamples, checkFindings, checkUndecided, loadFindings, lockExamples } from "../examples.ts";
import { loadKernel } from "../kernel.ts";
import { loadLock, type SpecLock } from "../lock.ts";
import { loadDecisions, loadMappings } from "../mapping.ts";
import { resolveModel } from "../model.ts";

/**
 * Usage: examples [--lock <file>]
 *
 * The examples gate. Resolves each lock's model, emits its schemas, fetches
 * the lock's example files (blob-verified), and validates every example the
 * model lists against the document it shows. Prints each failure with the
 * elements its location rests on, in the form `examples/findings.yaml`
 * records it, and exits 1 if a failure isn't recorded, a recorded finding no
 * longer occurs, or the lock's list of examples is wrong.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({ options: { lock: { type: "string" } } });
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
  const recorded = loadFindings(root);

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
    let got;
    try {
      got = await lockExamples(lock, model);
    } catch (e) {
      console.error(`${lock.name}: ${lock.required ? "error" : "skipped"}: ${(e as Error).message.split("\n")[0]}`);
      if (lock.required) failed = true;
      continue;
    }
    const r = checkExamples({ model, files: emitted.files, schemaDir, examples: got.examples, values: got.values, codes: codesOf(kernel.lists ?? { lists: [] }) });
    console.log(`${lock.name}: ${got.examples.length} examples via ${got.via}; ${r.failures.length} failure${r.failures.length === 1 ? "" : "s"}`);
    if (r.failures.length > 0) {
      const shown = r.failures.map((f) => ({ example: f.example, path: f.path, kind: f.kind, ...(f.rule ? { rule: f.rule, severity: f.severity } : {}), value: f.value, message: f.message, elements: f.elements }));
      process.stdout.write(`${stringify(shown, { lineWidth: 0 }).trimEnd().replace(/^/gm, "  ")}\n`);
    }
    if (r.checks.undecided.length > 0) {
      console.log(`${lock.name}: ${r.checks.undecided.length} undecided`);
      process.stdout.write(`${stringify(r.checks.undecided, { lineWidth: 0 }).trimEnd().replace(/^/gm, "  ")}\n`);
    }
    const all = [...got.listing, ...r.problems, ...checkFindings(r.failures, recorded, lock.name, decisions), ...checkUndecided(r.checks.undecided, recorded, lock.name, decisions)];
    for (const p of all) console.error(`error: ${lock.name}: ${p}`);
    if (all.length > 0) failed = true;
  }
  return failed ? 1 : 0;
}

// Set the exit code rather than exit, so the output reaches a pipe whole.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: Error) => {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  },
);
