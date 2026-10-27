import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildLock, COMPARISON_DIR, compareLocks, DEFAULT_LOCK_FILE, renderComparison, renderComparisonMarkdown, type LockBuild } from "../compare.ts";
import { loadConstructors } from "../constructors.ts";
import { loadFindings } from "../examples.ts";
import { loadKernel } from "../kernel.ts";
import { loadLock } from "../lock.ts";
import { loadDecisions, loadMappings } from "../mapping.ts";
import { loadDifferences } from "../render.ts";
import { loadVectors } from "../rules.ts";
import { variantReportFiles } from "../variant-report.ts";

/**
 * Usage: compare [--out <dir>]
 *
 * Runs the pipeline on every lock, from its committed IR and findings: the
 * model, the schemas, the rules, the round trip, and the examples. Then
 * writes, for each lock other than the default, `spec-input/spec-lock.yaml`,
 * the comparison with the default lock: `comparison/<lock>.json`, canonical
 * JSON, and `comparison/<lock>.md`, rendered from it. `--out` sets the
 * directory. Then writes each variant's report (src/variant-report.ts):
 * `comparison/<variant>.json` and `comparison/<variant>.md`, how the variant
 * differs from the schemas we propose and how many of the specification's
 * example failures each has. Exits 1, writing nothing, if a lock's pipeline
 * doesn't run clean.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  const locks = readdirSync(join(root, "spec-input"))
    .filter((f) => f === DEFAULT_LOCK_FILE || f.endsWith(".lock.yaml"))
    .sort()
    .map((f) => ({ file: f, lock: loadLock(join(root, "spec-input", f)) }));
  const input = {
    root,
    mappings: loadMappings(root, join(root, "mapping")),
    decisions: loadDecisions(root, join(root, "decisions")),
    kernel: loadKernel(root),
    constructors: loadConstructors(root),
    vectors: loadVectors(root),
  };
  const builds = new Map<string, LockBuild>();
  let failed = false;
  for (const { file, lock } of locks) {
    const r = await buildLock(lock, input);
    for (const p of r.problems) console.error(`error: ${lock.name}: ${p}`);
    if (r.build) builds.set(file, r.build);
    else failed = true;
  }
  if (failed) return 1;
  const base = builds.get(DEFAULT_LOCK_FILE);
  if (!base) throw new Error(`no default lock, spec-input/${DEFAULT_LOCK_FILE}`);
  const recordedFindings = loadFindings(root);
  const recordedDifferences = loadDifferences(root);
  const out = values.out !== undefined ? resolve(values.out) : join(root, COMPARISON_DIR);
  mkdirSync(out, { recursive: true });
  for (const [file, build] of builds) {
    if (file === DEFAULT_LOCK_FILE) continue;
    const doc = compareLocks({ base, lock: build, decisions: input.decisions, recordedFindings, recordedDifferences });
    writeFileSync(join(out, `${build.lock.name}.json`), renderComparison(doc));
    writeFileSync(join(out, `${build.lock.name}.md`), renderComparisonMarkdown(doc));
    const shown = out.startsWith(`${root}/`) ? out.slice(root.length + 1) : out;
    const breaking = doc.changes.filter((c) => c.class === "breaking").length;
    console.log(
      `${build.lock.name} against ${base.lock.name}: ${doc.elements.added.length} elements added, ${doc.changes.length} schema changes (${breaking} breaking), ${doc.decisions.added.length} decisions added, ${doc.findings.spec.added.length + doc.findings.examples.added.length + doc.findings.round_trip.added.length} findings added; ${shown}/${build.lock.name}.md`,
    );
  }
  // Each variant's report: how it differs from the schemas we propose, and how many example failures each has.
  const variants = await variantReportFiles([...builds.values()], input, recordedFindings);
  for (const p of variants.problems) console.error(`error: ${p}`);
  if (variants.problems.length > 0) return 1;
  for (const [name, text] of variants.files) writeFileSync(join(out, name), text);
  for (const r of variants.reports) {
    const shown = out.startsWith(`${root}/`) ? out.slice(root.length + 1) : out;
    const counts = r.locks.map((l) => `${l.name}: ${l.examples.proposed.failures} example failures proposed, ${l.examples.variant.failures} ${r.variant}`).join("; ");
    console.log(`${r.variant}: ${r.switches.length} departures switched off; ${counts}; ${shown}/${r.variant}.md`);
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: Error) => {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  },
);
