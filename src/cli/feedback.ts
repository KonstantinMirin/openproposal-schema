import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildLock, DEFAULT_LOCK_FILE, type LockBuild } from "../compare.ts";
import { loadConstructors } from "../constructors.ts";
import { FINDINGS_FILE, loadFindings } from "../examples.ts";
import { allDecisions, buildFeedback, checkFeedback, DETAILS_LINK, feedbackOf, FEEDBACK_DIR, FEEDBACK_FILES, renderComment, renderDetails, renderFeedback } from "../feedback.ts";
import { loadKernel } from "../kernel.ts";
import { loadLock } from "../lock.ts";
import { loadDecisions, loadMappings } from "../mapping.ts";
import { DIFFERENCES_FILE, loadDifferences } from "../render.ts";
import { loadVectors, VECTORS_DIR } from "../rules.ts";
import { cliSpec } from "../builds.ts";
import { REPO_ROOT } from "../repo.ts";

/**
 * Usage: feedback [--out <dir>]
 *
 * Runs the pipeline on every lock, from its committed IR and findings, and
 * writes the implementation feedback for the working group to `feedback/`:
 * `feedback.json`, canonical JSON; `comment.md`, the comment to post on
 * IABTechLab/OpenProposal#121; and `details.md`, the gist it links. Both
 * markdown files are drafts to review before posting. `--out` sets the
 * directory. Exits 1, writing nothing, if a lock's pipeline doesn't run
 * clean or the report can't place a record.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({ options: { spec: { type: "string" }, out: { type: "string" } } });
  const root = REPO_ROOT;
  const specDir = cliSpec(values);
  const files = readdirSync(join(specDir, "spec-input"))
    .filter((f) => f === DEFAULT_LOCK_FILE || f.endsWith(".lock.yaml"))
    .sort((a, b) => (a === DEFAULT_LOCK_FILE ? -1 : b === DEFAULT_LOCK_FILE ? 1 : a < b ? -1 : a > b ? 1 : 0));
  const input = {
    root: specDir,
    mappings: loadMappings(join(specDir, "mapping")),
    decisions: loadDecisions(join(specDir, "decisions")),
    kernel: loadKernel(root, specDir),
    constructors: loadConstructors(root, specDir),
    vectors: loadVectors(join(specDir, VECTORS_DIR)),
  };
  const builds: LockBuild[] = [];
  let failed = false;
  for (const f of files) {
    const lock = loadLock(join(specDir, "spec-input", f));
    const r = await buildLock(lock, input);
    for (const p of r.problems) console.error(`error: ${lock.name}: ${p}`);
    if (r.build) builds.push(r.build);
    else failed = true;
  }
  if (failed) return 1;
  const { doc, problems } = buildFeedback({ ...input, builds, recordedFindings: loadFindings(join(specDir, FINDINGS_FILE)), recordedDifferences: loadDifferences(join(specDir, DIFFERENCES_FILE)) });
  problems.push(...checkFeedback(doc, builds, feedbackOf(specDir)));
  for (const p of problems) console.error(`error: ${p}`);
  if (problems.length > 0) return 1;
  const out = values.out !== undefined ? resolve(values.out) : join(specDir, FEEDBACK_DIR);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, FEEDBACK_FILES.data), renderFeedback(doc));
  writeFileSync(join(out, FEEDBACK_FILES.comment), renderComment(doc));
  writeFileSync(join(out, FEEDBACK_FILES.details), renderDetails(doc, feedbackOf(specDir)));
  const shown = out.startsWith(`${root}/`) ? out.slice(root.length + 1) : out;
  const decisions = allDecisions(doc);
  const proposed = decisions.filter((d) => d.status === "proposed").length;
  console.log(
    `${decisions.length} decisions (${doc.departures.length} of them changes we propose, ${decisions.filter((d) => d.feedback !== undefined).length} with feedback, ${proposed} still proposed), ${doc.findings.reduce((n, r) => n + r.findings.length, 0)} open lint findings, ${doc.examples.length} example findings; ${shown}/${FEEDBACK_FILES.comment} and ${shown}/${FEEDBACK_FILES.details}`,
  );
  console.log(`draft: review both files before posting, and replace ${DETAILS_LINK} in ${FEEDBACK_FILES.comment} with the gist of ${FEEDBACK_FILES.details}`);
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
