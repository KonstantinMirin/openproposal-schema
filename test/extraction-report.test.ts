import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTRACTION_REPORT, renderExtractionReport, reportBlocks, reportLocks } from "../src/extraction-report.ts";
import { ROOT, SPEC } from "./helpers.ts";

const TEXT = readFileSync(join(ROOT, EXTRACTION_REPORT), "utf8");

test("the extraction report's numbers are what the committed IR and findings give, so none goes stale", () => {
  const locks = reportLocks(SPEC);
  assert.equal(renderExtractionReport(TEXT, reportBlocks(locks)), TEXT, "run: npm run extraction-report");
  // The counts a review found stale with the open PRs, read from the IR they come from.
  const golden = JSON.parse(readFileSync(join(ROOT, "test", "golden", "with-open-prs", "counts.json"), "utf8"));
  assert.match(TEXT, new RegExp(`\\| \`must_without_field\` \\| 13 \\| ${golden.findings.by_kind.must_without_field} \\|`));
  assert.match(TEXT, new RegExp(`\\| RFC 2119 sentences in the body \\| 32 \\| ${golden.ir.statements_body} \\|`));
  assert.match(TEXT, new RegExp(`\\| MUST \\| 16 \\| ${golden.ir.statements_by_level.MUST} \\|`));
  assert.match(TEXT, new RegExp(`\\| MUST NOT \\| 3 \\| ${golden.ir.statements_by_level["MUST NOT"]} \\|`));
  assert.match(TEXT, new RegExp(`\\| \\*\\*Total\\*\\* \\| \\*\\*46 \\(\\+4\\)\\*\\* \\| \\*\\*${golden.findings.open} \\(\\+${golden.findings.total - golden.findings.open}\\)\\*\\* \\|`));
  // A count that changes in the IR changes the report.
  const [main, prs] = locks;
  const fewer = { ...prs, findings: prs.findings.filter((f) => f.kind !== "unnumbered_heading") };
  assert.notEqual(renderExtractionReport(TEXT, reportBlocks([main, fewer])), TEXT);
});

test("the report renders only the blocks it marks, and every block it marks", () => {
  assert.throws(() => renderExtractionReport("<!-- generated:nope -->\nx\n<!-- /generated:nope -->\n", { nope: "y", counts: "z" }), /the report has no block "counts"/);
  assert.throws(() => renderExtractionReport("<!-- generated:nope -->\nx\n<!-- /generated:nope -->\n", {}), /no block "nope" is generated/);
  assert.equal(renderExtractionReport("a\n<!-- generated:x -->\nold\n<!-- /generated:x -->\nb\n", { x: "new" }), "a\n<!-- generated:x -->\nnew\n<!-- /generated:x -->\nb\n");
});
