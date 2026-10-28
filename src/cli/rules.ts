import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BUILD_OPTIONS, cliBuilds, cliSpec } from "../builds.ts";
import { emitSchemas, schemaDirOf } from "../emit.ts";
import { checkRuleVectors, emitRules, loadVectors, renderRules, RULES_FILE, rulesDirOf, VECTORS_DIR } from "../rules.ts";
import { REPO_ROOT } from "../repo.ts";
import { schemaNamesOfLock } from "../specs/index.ts";

/**
 * Usage: rules [--lock <file>] [--variant <name>] [--out <dir>]
 *
 * Stage 5b. Resolves each lock's model and emits its schemas, as `npm run
 * emit` does, then emits its rules with their vectors to `rules.json`. The
 * default lock's file goes to `rules/`, another lock's to `rules/<its IR
 * directory under ir/>/`, such as `rules/with-open-prs/`, and each variant's
 * under `rules/<variant>/`, with its vectors converted to the variant's
 * forms (src/variant.ts). `--lock` emits one lock, `--variant` one variant,
 * or `proposed`, and `--out` sets the directory of the one build it names. Exits 1, writing nothing for the
 * lock, if the model doesn't resolve, the schemas don't emit, a rule lacks
 * vectors, or a vector fails its type's schema.
 */
function main(): number {
  const { values } = parseArgs({ options: BUILD_OPTIONS });
  const root = REPO_ROOT;
  const specDir = cliSpec(values);
  const vectors = loadVectors(join(specDir, VECTORS_DIR));
  let failed = false;
  for (const b of cliBuilds(values)) {
    const { model, ir, lock, decisions } = b;
    if (b.problems.length > 0) {
      for (const p of b.problems) console.error(`error: ${b.label}: model: ${p}`);
      failed = true;
      continue;
    }
    const schemaDir = b.dirOf(schemaDirOf(b.irDir));
    const emitted = emitSchemas(model, schemaDir, schemaNamesOfLock(lock));
    if (emitted.problems.length > 0) {
      for (const p of emitted.problems) console.error(`error: ${b.label}: schemas: ${p}`);
      failed = true;
      continue;
    }
    const converted = b.vectors(vectors);
    const r = emitRules({ model, ir, lock: lock.name, vectors: converted.vectors, decisions, schemaDir, conditionsLeft: emitted.conditions.left, schemaBase: schemaNamesOfLock(lock).base });
    const all = [...converted.problems, ...r.problems, ...checkRuleVectors(r.doc, model, emitted.files, schemaDir)];
    if (all.length > 0) {
      for (const p of all) console.error(`error: ${b.label}: ${p}`);
      failed = true;
      continue;
    }
    const out = values.out !== undefined ? resolve(values.out) : join(specDir, b.dirOf(rulesDirOf(b.irDir)));
    mkdirSync(dirname(join(out, RULES_FILE)), { recursive: true });
    writeFileSync(join(out, RULES_FILE), renderRules(r.doc));
    const shown = out.startsWith(`${root}/`) ? out.slice(root.length + 1) : out;
    const vectorCount = r.doc.rules.reduce((n, x) => n + x.vectors.valid.length + x.vectors.invalid.length, 0);
    console.log(`${b.label}: ${r.doc.rules.length} rules, ${vectorCount} vectors in ${shown}/${RULES_FILE}`);
  }
  return failed ? 1 : 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
