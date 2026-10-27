import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { allLocks } from "../builds.ts";
import { computeProvenance, PROVENANCE_DIR, renderProvenance } from "../provenance.ts";

/**
 * Usage: provenance
 *
 * For each lock that merges open PRs and has a reachable clone among its
 * sources, writes `spec-input/provenance/<lock>.json`: for each line of the
 * lock's specification, the PR that wrote it, with the commit and the line
 * there, or `main`'s commit, or nothing for a line the integration wrote
 * (src/provenance.ts). The site links a line of such a lock by it.
 */
function main(): number {
  const root = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  for (const lock of allLocks(root)) {
    if (lock.merge_order === null) continue;
    const clone = lock.sources.flatMap((s) => ("git" in s ? [resolve(root, s.git)] : []))[0];
    if (clone === undefined) throw new Error(`${lock.name}: no clone among the lock's sources`);
    const doc = computeProvenance(lock, clone);
    mkdirSync(join(root, PROVENANCE_DIR), { recursive: true });
    writeFileSync(join(root, PROVENANCE_DIR, `${lock.name}.json`), renderProvenance(doc));
    const by = new Map<string, number>();
    for (const l of doc.lines) {
      const k = l === null ? "the integration" : l.pr === null ? "main" : `#${l.pr}`;
      by.set(k, (by.get(k) ?? 0) + 1);
    }
    console.log(`${lock.name}: ${doc.lines.length} lines: ${[...by].map(([k, n]) => `${n} from ${k}`).join(", ")}`);
  }
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
