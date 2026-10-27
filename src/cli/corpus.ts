import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConstructors } from "../constructors.ts";
import { checkCorpus, CORPUS_FILE, corpusDirOf, generateCorpus, renderCorpus } from "../corpus.ts";
import { emitSchemas, schemaDirOf } from "../emit.ts";
import { pinnedOracle } from "../engines.ts";
import { loadKernel } from "../kernel.ts";
import { loadLock, type SpecLock } from "../lock.ts";
import { loadDecisions, loadMappings } from "../mapping.ts";
import { resolveModel } from "../model.ts";
import { emitRules, loadVectors } from "../rules.ts";

/**
 * Usage: corpus [--lock <file>] [--out <dir>]
 *
 * Stage 5e. Resolves each lock's model and emits its schemas and its rules,
 * as `npm run emit` and `npm run rules` do, then generates the conformance
 * corpus: a baseline and an isolating mutant for each constraint the
 * schemas state, and the rule vectors, in `cases.json`. The default lock's
 * file goes to `corpus/`, another lock's to `corpus/<its IR directory under
 * ir/>/`, such as `corpus/with-open-prs/`. `--lock` generates one lock, and
 * `--out` sets its directory. Exits 1, writing nothing for the lock, if the
 * model doesn't resolve, the schemas or the rules don't emit, or a
 * constraint has no isolating case.
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
  const vectors = loadVectors(root);
  const oracle = pinnedOracle(root);

  let failed = false;
  for (const lock of locks) {
    const ir = JSON.parse(readFileSync(join(root, lock.ir_dir, "spec-ir.json"), "utf8"));
    const { model, problems } = resolveModel({ ir, lock: lock.name, mappings, decisions, kernel, constructors });
    if (problems.length > 0) {
      for (const p of problems) console.error(`error: ${lock.name}: model: ${p}`);
      failed = true;
      continue;
    }
    const irDir = relative(root, join(root, lock.ir_dir));
    const schemaDir = schemaDirOf(irDir);
    const emitted = emitSchemas(model, schemaDir);
    if (emitted.problems.length > 0) {
      for (const p of emitted.problems) console.error(`error: ${lock.name}: schemas: ${p}`);
      failed = true;
      continue;
    }
    const rules = emitRules({ model, ir, lock: lock.name, vectors, decisions, schemaDir, conditionsLeft: emitted.conditions.left });
    if (rules.problems.length > 0) {
      for (const p of rules.problems) console.error(`error: ${lock.name}: rules: ${p}`);
      failed = true;
      continue;
    }
    const r = generateCorpus({ model, files: emitted.files, rules: rules.doc, kernel, schemaDir, oracle });
    const all = [...r.problems, ...(r.problems.length === 0 ? checkCorpus(r.doc, emitted.files, model, rules.doc, schemaDir) : [])];
    if (all.length > 0) {
      for (const p of all) console.error(`error: ${lock.name}: corpus: ${p}`);
      failed = true;
      continue;
    }
    const out = values.out !== undefined ? resolve(values.out) : join(root, corpusDirOf(irDir));
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, CORPUS_FILE), renderCorpus(r.doc));
    const shown = out.startsWith(`${root}/`) ? out.slice(root.length + 1) : out;
    const newlines = r.doc.constraints.filter((c) => "newline" in c).length;
    console.log(`${lock.name}: ${r.doc.constraints.length} constraints with an isolating case (${newlines} with a trailing-newline mutant), ${r.doc.implied.length} implied, ${r.doc.rules.length} rules in ${shown}/${CORPUS_FILE}`);
  }
  return failed ? 1 : 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
