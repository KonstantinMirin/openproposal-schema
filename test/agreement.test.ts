import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { agreementContext, checkAgreement, headingSlug, lockText } from "../src/agreement.ts";
import { allLocks, resolveBuild } from "../src/builds.ts";
import { loadConstructors } from "../src/constructors.ts";
import { emitSchemas, schemaDirOf } from "../src/emit.ts";
import { loadKernel } from "../src/kernel.ts";
import { loadDecisions, loadMappings } from "../src/mapping.ts";
import { schemaNamesOfLock } from "../src/specs/index.ts";
import { ROOT, SPEC } from "./helpers.ts";

const CONTEXT = agreementContext(SPEC);
const inputs = allLocks(SPEC).map((lock) => {
  const b = resolveBuild({ root: SPEC, lock, mappings: loadMappings(join(SPEC, "mapping")), decisions: loadDecisions(join(SPEC, "decisions")), kernel: loadKernel(ROOT, SPEC), constructors: loadConstructors(ROOT, SPEC) });
  return { spec: "openproposal", lock: lock.name, ir: b.ir, model: b.model, files: emitSchemas(b.model, schemaDirOf(lock.ir_dir), schemaNamesOfLock(lock)).files, text: lockText(lock), ...CONTEXT };
});

test("OpenProposal pins AdCOM once, at main, and agrees with its registry on both locks", () => {
  assert.deepEqual(CONTEXT.registries.map((r) => [r.spec, r.lock, r.imported, r.lists.length]), [["adcom", "main", true, 42]]);
  assert.deepEqual(CONTEXT.pins, [{ spec: "openproposal", registry: "adcom", lock: "main" }]);
  for (const i of inputs) assert.deepEqual(checkAgreement(i), [], i.lock);
});

test("the agreement reads the codes the text restates, the links it writes, and the vocabularies that reference the registry", () => {
  const prs = inputs.find((i) => i.lock === "with-open-prs")!;
  // A changed label among labels the registry writes is a restatement it doesn't make, in the IR and in the text alike.
  const relabeled = { ...prs, ir: JSON.parse(JSON.stringify(prs.ir).split("OMID 1.0 (7)").join("OMID 1.1 (7)")), text: prs.text.map((l) => l.split("OMID 1.0 (7)").join("OMID 1.1 (7)")) };
  const problems = checkAgreement(relabeled);
  assert.ok(problems.length >= 2 && problems.every((p) => p.endsWith('restates List: API Frameworks\'s code 7 as "omid 1.1", where the registry labels it "OMID 1.0"')), problems.join("\n"));
  // The text's Device Types citation, outside the IR, makes its device tables restatements of that list.
  const tv = { ...prs, text: prs.text.map((l) => l.split("Connected TV (3)").join("Connected TV (6)")) };
  assert.ok(checkAgreement(tv).some((p) => /line \d+ restates List: Device Types's "connected tv" as code 6, where the registry gives it 3/.test(p)));
  assert.ok(prs.text.some((l) => l.includes("#list_apiframeworks")), "the text links the registry's anchors");
  assert.equal(prs.model.types.filter((t) => t.kind === "vocabulary" && t.list?.registry).length, 3);
});

test("a heading's slug is GitHub's, from the heading as the text writes it, its spaces and the space before its anchor kept", () => {
  assert.equal(headingSlug('### List:  API Frameworks <a name="list_apiframeworks"></a>'), "list--api-frameworks-");
  assert.equal(headingSlug(' ### List:  Plcmt Subtypes - Video <a name="list_plcmtsubtypesvideo"></a>'), "list--plcmt-subtypes---video-");
  const adcom = CONTEXT.registries[0]!;
  assert.ok(adcom.sections.some((s) => s.id === "list_devicetypes" && s.slug === "list--device-types-"), "the plan's own example");
  const prs = inputs.find((i) => i.lock === "with-open-prs")!;
  const bySlug = { ...prs, text: prs.text.map((l) => l.replace("#list_apiframeworks", "#list--api-frameworks-")) };
  assert.deepEqual(checkAgreement(bySlug), []);
});
