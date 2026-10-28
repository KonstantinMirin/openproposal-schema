import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { materialize } from "../fetch.ts";
import { loadLock, repoRoot } from "../lock.ts";
import { runStages, validateAgainst } from "../pipeline.ts";
import { DEFAULT_LOCK } from "../repo.ts";

/**
 * Usage: extract [--lock specs/openproposal/spec-input/spec-lock.yaml] [--out DIR]
 *
 * Materializes the locked specification, runs stages 1 and 2, and writes
 * `spec-ir.json` and `findings.json` to the lock's `ir_dir`, or to `--out`.
 * Exits 1 on an extraction error, an invalid IR, or a stale exception.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({ options: { lock: { type: "string", default: DEFAULT_LOCK }, out: { type: "string" } } });
  const lock = loadLock(values.lock!);
  const root = repoRoot(lock);
  const spec = await materialize(lock);
  const out = runStages(lock, spec.bytes);
  const problems = [
    ...validateAgainst("spec-ir.schema.json", out.ir).map((e) => `spec-ir.json: ${e}`),
    ...validateAgainst("findings.schema.json", out.findings).map((e) => `findings.json: ${e}`),
    ...out.exceptionProblems,
  ];
  const dir = values.out ? resolve(values.out) : join(root, lock.ir_dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "spec-ir.json"), out.irJson);
  writeFileSync(join(dir, "findings.json"), out.findingsJson);
  const c = out.findings.counts;
  console.log(`${lock.name}: ${out.ir.fields.length} fields, ${out.ir.keys.length} keys, ${out.ir.statements.length} statements; ${c.total} findings (${c.open} open) -> ${dir}`);
  for (const p of problems) console.error(`error: ${p}`);
  return problems.length > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e: Error) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  },
);
