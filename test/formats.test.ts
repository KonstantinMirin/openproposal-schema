import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { citeText, elementDigest, indexElements } from "../src/elements.ts";
import { checkMapping, loadDecisions, loadMappings } from "../src/mapping.ts";
import { extractText, ROOT } from "./helpers.ts";

const FIXTURES = join(ROOT, "test", "fixtures", "formats");
const SPEC = readFileSync(join(FIXTURES, "spec.md"), "utf8");
const MAPPING = readFileSync(join(FIXTURES, "mapping", "pricing.yaml"), "utf8");
const DECISION = readFileSync(join(FIXTURES, "decisions", "D-001.yaml"), "utf8");

/** Writes a mapping directory and a decision directory, each with one file, and returns them. */
function dirs(mapping: string, decision: string, files = { mapping: "pricing.yaml", decision: "D-001.yaml" }) {
  const root = mkdtempSync(join(tmpdir(), "op-formats-"));
  const m = join(root, "mapping");
  const d = join(root, "decisions");
  mkdirSync(m);
  mkdirSync(d);
  writeFileSync(join(m, files.mapping), mapping);
  writeFileSync(join(d, files.decision), decision);
  return { m, d };
}

function check(spec: string, mapping = MAPPING, decision = DECISION, lock = "main"): string[] {
  const { m, d } = dirs(mapping, decision);
  return checkMapping(extractText(spec), lock, loadMappings(m), loadDecisions(d));
}

test("the mapping and decision fixtures validate and are current", () => {
  const mappings = loadMappings(join(FIXTURES, "mapping"));
  const decisions = loadDecisions(join(FIXTURES, "decisions"));
  assert.equal(mappings[0]!.entries.length, 6);
  assert.equal(decisions[0]!.covers.length, 2);
  assert.deepEqual(checkMapping(extractText(SPEC), "main", mappings, decisions), []);
});

test("a changed specification row makes the entry and the decision that cover it stale", () => {
  const changed = SPEC.replace("| `cpm` \\| `flat` |", "| `cpm` \\| `cpc` \\| `flat` |");
  assert.notEqual(changed, SPEC);
  const problems = check(changed);
  const stale = (file: string, id: string) => problems.some((p) => p.includes(file) && p.includes(`stale digest for "${id}"`));
  assert.ok(stale("pricing.yaml", "field:5.6:pricing[].cost_method"), problems.join("\n"));
  assert.ok(stale("pricing.yaml", "field:5.6:pricing[].cost_method#description/values:1"), problems.join("\n"));
  assert.ok(stale("D-001.yaml", "field:5.6:pricing[].cost_method"), problems.join("\n"));
  assert.ok(stale("D-001.yaml", "field:5.6:pricing[].cost_method#description/values:1"), problems.join("\n"));
  assert.equal(problems.length, 4, problems.join("\n"));
});

test("a changed statement makes its entry point at nothing, and moving a row doesn't make it stale", () => {
  const reworded = check(SPEC.replace("MUST NOT be negative.", "MUST be positive."));
  assert.equal(reworded.length, 1, reworded.join("\n"));
  assert.match(reworded[0]!, /pricing\.yaml: entry "rule:5\.6:96b1b3b3": lock "main" has no IR element "rule:5\.6:96b1b3b3"$/);
  assert.deepEqual(check(SPEC.replace("## 5. Line items", "Another paragraph.\n\n## 5. Line items")), []);
});

test("a digest edited by hand is stale, and a quote edited by hand differs from the IR", () => {
  const digest = check(SPEC, MAPPING.replace("7fd5fafcefd67459322fa3b020b16fb63602df0149224c038b620c6d9d262d4d", "f".repeat(64)));
  assert.equal(digest.length, 1);
  assert.match(digest[0]!, /stale digest for "field:5\.6:hold_available"/);
  const quote = check(SPEC, MAPPING, DECISION.replace('quote: "`cpm` | `flat`"', 'quote: "`cpm` | `flat` | `cpc`"'));
  assert.equal(quote.length, 1);
  assert.match(quote[0]!, /the quote for "field:5\.6:pricing\[\]\.cost_method#description\/values:1" differs from the IR/);
});

test("an entry's decision must exist, be current, and cover the entry's element", () => {
  assert.match(check(SPEC, MAPPING.replace("source: { rule: boolean-inline }", "source: { decision: D-002 }")).join("\n"), /cites decision "D-002", which doesn't exist/);
  const uncovered = MAPPING.replace("source: { rule: number-is-amount }", "source: { decision: D-001 }");
  assert.match(check(SPEC, uncovered).join("\n"), /cites "D-001", which doesn't cover "field:5\.6:pricing\[\]\.gross_rate"/);
  const superseded = DECISION.replace("status: proposed", "status: superseded\nsuperseded_by: D-001");
  assert.match(check(SPEC, MAPPING, superseded).join("\n"), /cites "D-001", which is superseded/);
  assert.match(check(SPEC, MAPPING, superseded).join("\n"), /"superseded_by" names "D-001", which is not another decision record/);
});

test("decision records need a chosen option among distinct options", () => {
  assert.match(check(SPEC, MAPPING, DECISION.replace("chosen: open", "chosen: hybrid")).join("\n"), /"chosen" is "hybrid", which is not one of the options/);
  assert.match(check(SPEC, MAPPING, DECISION.replace("  - id: closed", "  - id: open")).join("\n"), /option "open" is listed twice/);
});

test("an element mapped twice fails, and an entry scoped to another lock is ignored", () => {
  const twice = MAPPING + MAPPING.slice(MAPPING.indexOf("  - ir: field:5.6:hold_available"), MAPPING.indexOf("  - ir: rule:5.6:96b1b3b3"));
  assert.match(check(SPEC, twice).join("\n"), /"field:5\.6:hold_available" is already mapped/);
  const scoped = MAPPING.replace("    source: { rule: boolean-inline }", "    locks: [other]\n    source: { rule: boolean-inline }").replace(
    "7fd5fafcefd67459322fa3b020b16fb63602df0149224c038b620c6d9d262d4d",
    "f".repeat(64),
  );
  assert.deepEqual(check(SPEC, scoped), []);
  assert.match(check(SPEC, scoped, DECISION, "other").join("\n"), /stale digest for "field:5\.6:hold_available" on lock "other"/);
});

test("a type-name override needs a decision record", () => {
  const override = MAPPING.replace("arguments: { T: { kind: named, name: PricingEntry } } }", "arguments: { T: { kind: named, name: PricingEntry } }, name: PriceList }");
  assert.notEqual(override, MAPPING);
  assert.match(check(SPEC, override).join("\n"), /a type-name override needs a decision record/);
});

test("the schemas reject what the formats forbid", () => {
  const rejects = (mapping: string, decision: string, pattern: RegExp, files?: { mapping: string; decision: string }) => {
    const { m, d } = dirs(mapping, decision, files);
    assert.throws(() => {
      loadMappings(m);
      loadDecisions(d);
    }, pattern);
  };
  rejects(MAPPING.replace("source: { decision: D-001 }\n    as: { role: type", "source: { rule: open-by-default }\n    as: { role: type"), DECISION, /not a valid mapping file/);
  rejects(MAPPING.replace("layer: vocabulary, open: true", "layer: vocabulary"), DECISION, /not a valid mapping file/);
  rejects(MAPPING.replace("presence: required", "presence: maybe"), DECISION, /not a valid mapping file/);
  rejects(MAPPING.replace("format: 1", "format: 1\nnotes: free text"), DECISION, /not a valid mapping file/);
  rejects(MAPPING, DECISION, /"module" is "pricing"; it must equal the file name "costs"/, { mapping: "costs.yaml", decision: "D-001.yaml" });
  rejects(MAPPING, DECISION.replace("status: proposed", "status: filed"), /not a valid decision record/);
  rejects(MAPPING, DECISION.replace("status: proposed", "status: superseded"), /not a valid decision record/);
  rejects(MAPPING, DECISION.replace("    digest: 9305a06751baf0699a010595e20fc5707ba976bd43a64dca4dc2e6ffc337bfd0\n", ""), /not a valid decision record/);
  rejects(MAPPING, DECISION, /"id" is "D-001"; it must equal the file name "D-002"/, { mapping: "pricing.yaml", decision: "D-002.yaml" });
  rejects(MAPPING, DECISION.replace("format: 1", "format: 1\nformat: 1"), /D-001\.yaml/);
});

test("citeText and elementDigest give each element kind a stable quote and digest", () => {
  const index = indexElements(extractText(SPEC));
  const field = index.get("field:5.6:pricing[].gross_rate")!;
  assert.equal(citeText(field), "`pricing[].gross_rate` | Number | seller-set | The rate before discounts.");
  assert.equal(elementDigest(field), (field.element as { digest: string }).digest);
  const list = index.get("field:5.6:pricing[].cost_method#description/values:1")!;
  assert.equal(citeText(list), "`cpm` | `flat`");
  assert.match(elementDigest(list), /^[0-9a-f]{64}$/);
  assert.equal(citeText(index.get("rule:5.6:96b1b3b3")!), "Each `pricing[].gross_rate` MUST NOT be negative.");
});

test("an entry or a type may cite several decisions, and each must exist and cover its element", () => {
  const several = MAPPING.replace("    source: { decision: D-001 }\n    as:\n      role: property", "    source: { decisions: [D-001, D-002] }\n    as:\n      role: property");
  assert.notEqual(several, MAPPING);
  assert.match(check(SPEC, several).join("\n"), /entry "field:5\.6:pricing\[\]\.cost_method": cites decision "D-002", which doesn't exist/);
  const declared = MAPPING.replace(
    "entries:\n",
    "types:\n  - { name: PricingEntry, kind: object, ir: \"field:5.6:pricing[].gross_rate\", open: false, source: { decision: D-001 } }\n  - { name: Fee, kind: object, open: true, source: { decision: D-001 } }\nentries:\n",
  );
  assert.notEqual(declared, MAPPING);
  const problems = check(SPEC, declared).join("\n");
  assert.match(problems, /type "PricingEntry": cites "D-001", which doesn't cover "field:5\.6:pricing\[\]\.gross_rate"/);
  assert.match(problems, /type "Fee": cites "D-001" but names no IR element for it to cover/);
});
