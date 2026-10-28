import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXTRACTION_REPORT, renderExtractionReport, reportBlocks, reportLocks } from "../extraction-report.ts";
import { REPO_ROOT, specRoot } from "../repo.ts";

/**
 * Usage: extraction-report
 *
 * Rewrites the generated blocks of docs/extraction-report.md from each
 * lock's committed IR and findings.
 */
function main(): number {
  const root = REPO_ROOT;
  const file = join(root, EXTRACTION_REPORT);
  const text = readFileSync(file, "utf8");
  const next = renderExtractionReport(text, reportBlocks(reportLocks(specRoot())));
  writeFileSync(file, next);
  console.log(`${EXTRACTION_REPORT}: ${next === text ? "current" : "rewritten"}`);
  return 0;
}

process.exit(main());
