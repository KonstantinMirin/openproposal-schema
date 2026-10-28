import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { allLocks, cliSpec } from "../builds.ts";
import { loadConstructors } from "../constructors.ts";
import { checkConventions, dependsProblems, modelStructures, unstatedVocabularies } from "../conventions.ts";
import { checkDuplication } from "../duplication.ts";
import { sharedStructures } from "../domains.ts";
import { loadKernel } from "../kernel.ts";
import { loadLock, type SpecLock } from "../lock.ts";
import { loadDecisions, loadMappings } from "../mapping.ts";
import { renderModel, resolveModel, type ModelDoc } from "../model.ts";
import { REPO_ROOT } from "../repo.ts";

/**
 * Usage: resolve [--lock <file>] [--out <dir>]
 *
 * Stage 4. Resolves each lock's committed IR, the mapping, the decision
 * records, and the kernel into `model.json`, then runs the convention gates
 * on it. The default lock's model goes to `build/model.json`, another lock's
 * to `build/<its IR directory under ir/>/model.json`, such as
 * `build/with-open-prs/model.json`. `--lock` resolves one lock, and `--out`
 * sets its directory. Exits 1, writing nothing, if the model doesn't
 * resolve, and exits 1 after writing it if a convention fails.
 */
function main(): number {
  const { values } = parseArgs({ options: { spec: { type: "string" }, lock: { type: "string" }, out: { type: "string" } } });
  const root = REPO_ROOT;
  const specDir = cliSpec(values);
  if (values.out !== undefined && values.lock === undefined) throw new Error("--out needs --lock");
  const locks: SpecLock[] =
    values.lock !== undefined
      ? [loadLock(resolve(values.lock))]
      : allLocks(specDir);
  const mappings = loadMappings(join(specDir, "mapping"));
  const decisions = loadDecisions(join(specDir, "decisions"));
  const kernel = loadKernel(root, specDir);
  const constructors = loadConstructors(root, specDir);

  let failed = false;
  const models: ModelDoc[] = [];
  for (const lock of locks) {
    const ir = JSON.parse(readFileSync(join(specDir, lock.ir_dir, "spec-ir.json"), "utf8"));
    const { model, problems } = resolveModel({ ir, lock: lock.name, mappings, decisions, kernel, constructors });
    if (problems.length > 0) {
      for (const p of problems) console.error(`error: ${lock.name}: ${p}`);
      failed = true;
      continue;
    }
    models.push(model);
    const out = values.out !== undefined ? resolve(values.out) : join(root, "build", relative(join(specDir, "ir"), join(specDir, lock.ir_dir)));
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "model.json"), renderModel(model));
    const vocabularies = unstatedVocabularies(model, decisions);
    const gates = {
      ...checkConventions(model, mappings, kernel, constructors, decisions),
      duplication: [...checkDuplication(modelStructures(model, kernel, constructors, vocabularies.names), sharedStructures(kernel.domains)), ...vocabularies.problems],
    };
    for (const [gate, list] of Object.entries(gates)) for (const p of list) console.error(`error: ${lock.name}: ${gate}: ${p}`);
    if (Object.values(gates).some((l) => l.length > 0)) failed = true;
    console.log(`${lock.name}: ${model.types.length} types in ${join(out, "model.json").slice(root.length + 1)}`);
  }
  if (values.lock === undefined && models.length === locks.length) {
    const declared = dependsProblems(models, mappings);
    for (const p of declared) console.error(`error: modules: ${p}`);
    if (declared.length > 0) failed = true;
  }
  return failed ? 1 : 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
