import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { allLocks, cliSpec } from "../builds.ts";
import { loadConstructors } from "../constructors.ts";
import { emitSchemas, schemaDirOf } from "../emit.ts";
import { loadKernel } from "../kernel.ts";
import { loadLock, type SpecLock } from "../lock.ts";
import { loadDecisions, loadMappings } from "../mapping.ts";
import { resolveModel } from "../model.ts";
import { buildRelease, freezeRelease, loadFrozen, RELEASE_FILE, RELEASES_DIR, renderRelease, unreviewedDecisions } from "../release.ts";
import { emitRules, loadVectors, VECTORS_DIR } from "../rules.ts";
import { generateCorpus } from "../corpus.ts";
import { pinnedOracle } from "../engines.ts";
import { REPO_ROOT } from "../repo.ts";
import { schemaNamesOfLock } from "../specs/index.ts";

/**
 * Usage: release [--lock <file>] [--out <dir>] [--freeze]
 *
 * Stage 7. Resolves each lock's model and emits its schemas, as `npm run
 * emit` does, and its rules, as `npm run rules` does, then writes the
 * release manifest, `release.json`, at the root of the lock's schema tree:
 * `schemas/release.json`, and another lock's under `schemas/<its IR
 * directory under ir/>/`. The manifest compares the model, the rules, and
 * the schema files with the lock's last frozen release under
 * `releases/<lock>/`. `--lock` writes one lock, and `--out` sets its
 * directory. `--freeze` also keeps the manifest, the model, the rules, the
 * conformance corpus, and the schema tree as `releases/<lock>/<version>/`;
 * a frozen version can't change, and it can't rest on a decision that is
 * still `proposed`. Exits 1, writing nothing for the lock, if the model
 * doesn't resolve, the schemas or the rules don't emit, or the change from
 * the last release is breaking within the major; and, with `--freeze`,
 * freezes nothing for the lock while a decision it cites is unreviewed.
 */
function main(): number {
  const { values } = parseArgs({ options: { lock: { type: "string" }, out: { type: "string" }, freeze: { type: "boolean" } } });
  const root = REPO_ROOT;
  const specDir = cliSpec(values);
  if (values.out !== undefined && values.lock === undefined) throw new Error("--out needs --lock");
  if (values.out !== undefined && values.freeze) throw new Error("--freeze writes the committed tree's manifest, so it can't take --out");
  const locks: SpecLock[] =
    values.lock !== undefined
      ? [loadLock(resolve(values.lock))]
      : allLocks(specDir);
  const mappings = loadMappings(join(specDir, "mapping"));
  const decisions = loadDecisions(join(specDir, "decisions"));
  const kernel = loadKernel(root, specDir);
  const constructors = loadConstructors(root, specDir);
  const vectors = loadVectors(join(specDir, VECTORS_DIR));

  let failed = false;
  for (const lock of locks) {
    const ir = JSON.parse(readFileSync(join(specDir, lock.ir_dir, "spec-ir.json"), "utf8"));
    const { model, problems } = resolveModel({ ir, lock: lock.name, mappings, decisions, kernel, constructors });
    if (problems.length > 0) {
      for (const p of problems) console.error(`error: ${lock.name}: model: ${p}`);
      failed = true;
      continue;
    }
    const schemaDir = schemaDirOf(relative(specDir, join(specDir, lock.ir_dir)));
    const emitted = emitSchemas(model, schemaDir, schemaNamesOfLock(lock));
    if (emitted.problems.length > 0) {
      for (const p of emitted.problems) console.error(`error: ${lock.name}: schemas: ${p}`);
      failed = true;
      continue;
    }
    const rules = emitRules({ model, ir, lock: lock.name, vectors, decisions, schemaDir, conditionsLeft: emitted.conditions.left, schemaBase: schemaNamesOfLock(lock).base });
    if (rules.problems.length > 0) {
      for (const p of rules.problems) console.error(`error: ${lock.name}: rules: ${p}`);
      failed = true;
      continue;
    }
    const last = loadFrozen(specDir, lock.name).at(-1) ?? null;
    const r = buildRelease({ model, files: emitted.files, rules: rules.doc, previous: last });
    if (r.problems.length > 0) {
      for (const p of r.problems) console.error(`error: ${lock.name}: ${p}`);
      failed = true;
      continue;
    }
    const out = values.out !== undefined ? resolve(values.out) : join(specDir, schemaDir);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, RELEASE_FILE), renderRelease(r.doc));
    const shown = out.startsWith(`${root}/`) ? out.slice(root.length + 1) : out;
    const against = last === null ? "the first release" : r.doc === last.release ? "unchanged since it was frozen" : `against ${last.release.release}: ${r.doc.changes.length} changes`;
    console.log(`${lock.name}: release ${r.doc.release}, ${Object.keys(r.doc.files).length} files in ${shown}/${RELEASE_FILE}; ${against}`);
    if (values.freeze) {
      const unreviewed = unreviewedDecisions(model, rules.doc, decisions);
      if (unreviewed.length > 0) {
        console.error(`error: ${lock.name}: a release can't rest on an unreviewed decision; accept, file, or supersede each first: ${unreviewed.join("; ")}`);
        failed = true;
        continue;
      }
      const corpus = generateCorpus({ model, files: emitted.files, rules: rules.doc, kernel, schemaDir, oracle: pinnedOracle(root) });
      if (corpus.problems.length > 0) {
        for (const p of corpus.problems) console.error(`error: ${lock.name}: corpus: ${p}`);
        failed = true;
        continue;
      }
      const wrote = freezeRelease(specDir, r.doc, model, rules.doc, corpus.doc, emitted.files);
      console.log(`${lock.name}: ${wrote ? "froze" : "already frozen:"} ${RELEASES_DIR}/${lock.name}/${r.doc.release}/`);
    }
  }
  return failed ? 1 : 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
