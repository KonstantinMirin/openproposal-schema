import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXTRACTION_REPORT, renderExtractionReport, reportBlocks, reportLocks, specReportBlocks, specReportFile, specReportLocks } from "../extraction-report.ts";
import { REPO_ROOT, specNames, specRoot } from "../repo.ts";
import { specOf } from "../specs/index.ts";

/**
 * Usage: extraction-report
 *
 * Rewrites the generated blocks of docs/extraction-report.md, and of each
 * spec's own report, docs/<spec>-extraction-report.md where it exists, from
 * each lock's committed IR and findings.
 */
function main(): number {
  const root = REPO_ROOT;
  const write = (rel: string, render: (text: string) => string) => {
    const file = join(root, rel);
    const text = readFileSync(file, "utf8");
    const next = render(text);
    writeFileSync(file, next);
    console.log(`${rel}: ${next === text ? "current" : "rewritten"}`);
  };
  write(EXTRACTION_REPORT, (text) => renderExtractionReport(text, reportBlocks(reportLocks(specRoot()))));
  for (const spec of specNames()) {
    const rel = specReportFile(spec);
    if (!existsSync(join(root, rel))) continue;
    const dir = specRoot(spec);
    write(rel, (text) => renderExtractionReport(text, specReportBlocks(specReportLocks(dir), specOf(dir).plugin!.text.layouts), rel));
  }
  return 0;
}

process.exit(main());
