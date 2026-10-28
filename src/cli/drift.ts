import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cliSpec } from "../builds.ts";
import { allSnapshotFiles, checkDriftSnapshots, DRIFT_DIR, driftFiles, loadDriftSources } from "../drift.ts";
import { REPO_ROOT } from "../repo.ts";

/**
 * Usage: drift [--spec <spec>] [--out <dir>]
 *
 * The drift report of a registry of code lists (src/drift.ts): reads the
 * spec's `drift/sources.yaml`, checks each artifact's snapshot against its
 * pins and a reachable clone, compares each list of the registry with each
 * artifact's enum for it, and writes `drift/drift.json` and `drift/drift.md`,
 * or under `--out`. Exits 1, writing nothing, on a problem.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({ options: { spec: { type: "string" }, out: { type: "string" } } });
  const spec = cliSpec(values);
  const sources = loadDriftSources(spec);
  const snapshots = allSnapshotFiles(spec, sources);
  const checked = checkDriftSnapshots(sources, snapshots);
  const { files, doc, problems } = await driftFiles(spec, sources, snapshots);
  for (const p of [...checked.problems, ...problems]) console.error(`error: ${p}`);
  if (checked.problems.length + problems.length > 0) return 1;
  const out = values.out !== undefined ? resolve(values.out) : join(spec, DRIFT_DIR);
  mkdirSync(out, { recursive: true });
  for (const [name, text] of files) writeFileSync(join(out, name), text);
  const shown = out.startsWith(`${REPO_ROOT}/`) ? out.slice(REPO_ROOT.length + 1) : out;
  for (const s of doc.sources) {
    const t = doc.totals[s.id]!;
    console.log(`${s.title}: ${t.compared} lists compared, ${t.noEnum} with no enum; ${t.missing} codes missing in ${t.listsMissing} lists, ${t.extra} extra; ${shown}/drift.md`);
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
