import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildLock, compareLocks, renderComparison, renderComparisonMarkdown, type LockBuild } from "../src/compare.ts";
import { loadConstructors } from "../src/constructors.ts";
import { FINDINGS_FILE, loadFindings } from "../src/examples.ts";
import { loadKernel } from "../src/kernel.ts";
import { loadLock } from "../src/lock.ts";
import { loadDecisions, loadMappings } from "../src/mapping.ts";
import { DIFFERENCES_FILE, loadDifferences } from "../src/render.ts";
import { loadVectors, VECTORS_DIR } from "../src/rules.ts";
import { ROOT, SPEC } from "./helpers.ts";

const INPUT = {
  root: SPEC,
  mappings: loadMappings(join(SPEC, "mapping")),
  decisions: loadDecisions(join(SPEC, "decisions")),
  kernel: loadKernel(ROOT, SPEC),
  constructors: loadConstructors(ROOT, SPEC),
  vectors: loadVectors(join(SPEC, VECTORS_DIR)),
};
const RECORDED = { recordedFindings: loadFindings(join(SPEC, FINDINGS_FILE)), recordedDifferences: loadDifferences(join(SPEC, DIFFERENCES_FILE)) };

async function build(file: string): Promise<LockBuild> {
  const r = await buildLock(loadLock(join(SPEC, "spec-input", file)), INPUT);
  assert.deepEqual(r.problems, []);
  return r.build!;
}

test("a lock compared with itself shows no change", async () => {
  const main = await build("spec-lock.yaml");
  const doc = compareLocks({ base: main, lock: main, decisions: INPUT.decisions, ...RECORDED });
  assert.deepEqual(doc.elements, { added: [], removed: [], changed: [] });
  assert.deepEqual(doc.changes, []);
  assert.deepEqual(doc.statements, { added: [], removed: [], moved: [] });
  assert.deepEqual(doc.decisions, { added: [], removed: [], reread: [] });
  assert.deepEqual(doc.findings, {
    spec: { added: [], removed: [], changed: [] },
    examples: { added: [], removed: [] },
    round_trip: { added: [], removed: [], changed: [] },
    conditions: { added: [], removed: [] },
  });
  assert.deepEqual(doc.base.counts, doc.lock.counts);
  // Every empty section says so, the added elements' included.
  assert.match(renderComparisonMarkdown(doc), /## Specification elements\n\n[^\n]*\n\n### Added \(0\)\n\nNone\.\n\n### Removed \(0\)/);
});

test("the open PRs' comparison lists their fields, decisions, and findings", async () => {
  const [main, prs] = await Promise.all([build("spec-lock.yaml"), build("with-open-prs.lock.yaml")]);
  const doc = compareLocks({ base: main, lock: prs, decisions: INPUT.decisions, ...RECORDED });
  const fields = doc.elements.added.filter((e) => e.kind === "field").map((e) => e.id);
  assert.ok(fields.includes("field:5.5:exclusions"), "a field row the PRs add is an added element");
  assert.ok(doc.changes.some((c) => c.view === "model" && c.type === "LineItem" && c.member === "geo" && c.change === "changed-marker" && c.class === "breaking"), "PR #72's marker change is breaking");
  assert.ok(doc.changes.some((c) => c.view === "model" && c.change === "added-property" && c.type === "LineItem" && c.member === "exclusions"));
  assert.ok(doc.decisions.added.some((d) => d.id === "D-022"), "the geo decision is cited only with the PRs");
  assert.ok(doc.findings.spec.added.some((f) => f.id === "unnumbered_heading:5.4/creative-inspection-and-previews"));
  for (const f of doc.findings.examples.added) assert.ok(f.decisions !== undefined && f.decisions.length > 0, `${f.example} ${f.path} carries its recorded decisions`);
  // Reversing the locks swaps what is added and removed.
  const back = compareLocks({ base: prs, lock: main, decisions: INPUT.decisions, ...RECORDED });
  assert.deepEqual(back.elements.removed.map((e) => e.id), doc.elements.added.map((e) => e.id));
  assert.deepEqual(back.decisions.removed.map((d) => d.id), doc.decisions.added.map((d) => d.id));
  // The renderings are functions of the document.
  assert.equal(renderComparison(doc), renderComparison(compareLocks({ base: main, lock: prs, decisions: INPUT.decisions, ...RECORDED })));
  assert.match(renderComparisonMarkdown(doc), /^# Lock comparison: `with-open-prs` against `main`\n/);
});

test("a rule's vectors compare by the schema file they name, not by the lock's schema directory in its $id", async () => {
  const [main, prs] = await Promise.all([build("spec-lock.yaml"), build("with-open-prs.lock.yaml")]);
  // The with-open-prs lock writes its schemas under schemas/with-open-prs/, so every rule's vectors name another $id.
  const rule = "rule:4.1:8e9aacb8";
  const ids = [main, prs].map((b) => b.rules.rules.find((r) => r.id === rule)!.vectors.schema);
  assert.notEqual(ids[0], ids[1]);
  const changed = (doc: ReturnType<typeof compareLocks>) => doc.changes.filter((c) => c.view === "rules" && c.member === rule);
  assert.deepEqual(changed(compareLocks({ base: main, lock: prs, decisions: INPUT.decisions, ...RECORDED })), []);
  // A vector the lock changes still shows.
  const edited = { ...prs, rules: { ...prs.rules, rules: prs.rules.rules.map((r) => (r.id === rule ? { ...r, vectors: { ...r.vectors, valid: r.vectors.valid.slice(1) } } : r)) } };
  assert.deepEqual(changed(compareLocks({ base: main, lock: edited, decisions: INPUT.decisions, ...RECORDED })).map((c) => c.detail), [`the rule ${rule} changes its vectors`]);
  // So does a vector schema that names another file or another definition.
  for (const schema of [ids[1]!.replace(/documents\/1\/[a-z-]+\.json/, "documents/1/line-item.json"), `${ids[1]!.split("#")[0]}#/$defs/Other`]) {
    const moved = { ...prs, rules: { ...prs.rules, rules: prs.rules.rules.map((r) => (r.id === rule ? { ...r, vectors: { ...r.vectors, schema } } : r)) } };
    assert.deepEqual(changed(compareLocks({ base: main, lock: moved, decisions: INPUT.decisions, ...RECORDED })).map((c) => c.detail), [`the rule ${rule} changes its vectors`], schema);
  }
});
