import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { EmittedFile } from "../src/emit.ts";
import { oracleAgrees, type ExampleCase } from "../src/examples.ts";
import { installFormats } from "../src/formats.ts";
import { ROOT, SPEC } from "./helpers.ts";

/**
 * A committed metric's value is typed by its metric (D-005): a fraction from
 * 0 to 1 for a rate the text names, and a number never negative for any
 * other metric, such as the 1,200,000 audience impacts a DOOH line item
 * commits to. The committed schemas of both locks and both variants, under
 * Ajv and the reference oracle, give each case its verdict.
 */
const TREES = ["schemas", "schemas/with-open-prs", "schemas/as-written", "schemas/as-written/with-open-prs"];

/** A schema tree's files as committed, without the subtrees of other builds and the release manifest. */
function treeFiles(dir: string): EmittedFile[] {
  const root = join(SPEC, dir);
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".json") && d.name !== "release.json")
    .map((d) => join(d.parentPath, d.name))
    .filter((p) => !/\/(with-open-prs|as-written)\//.test(`/${relative(root, p)}`))
    .map((p) => {
      const text = readFileSync(p, "utf8");
      return { path: relative(root, p), schema: JSON.parse(text) as Record<string, unknown>, text };
    });
}

const CASES: [string, unknown, boolean][] = [
  ["a DOOH quantity of 1,200,000 audience impacts", { metric: "dooh.example:audience_impacts", value: 1200000 }, true],
  ["a modelled audience that isn't whole", { metric: "dooh.example:audience_impacts", value: 14.2 }, true],
  ["viewable_rate 0.7", { metric: "viewable_rate", value: 0.7 }, true],
  ["viewable_rate 70, a percentage", { metric: "viewable_rate", value: 70 }, false],
  ["completion_rate 1.01", { metric: "completion_rate", value: 1.01 }, false],
  ["a negative count", { metric: "dooh.example:audience_impacts", value: -1 }, false],
  ["a value with no metric to read it by", { value: 0.5 }, false],
  // A metric the text doesn't name is a namespaced term (D-014), so a bare name fails on its metric, whatever its value.
  ["a DOOH metric the text doesn't name, written bare", { metric: "audience_impacts", value: 1200000 }, false],
];

test("a committed metric's value is a fraction for a rate and a number never negative for any other metric, on every build, under Ajv and the oracle", () => {
  for (const dir of TREES) {
    const files = treeFiles(dir);
    const guarantees = files.find((f) => f.path === "modules/guarantees/1/guarantees.json");
    assert.ok(guarantees, `${dir} holds the guarantees module`);
    const ref = `${String(guarantees.schema.$id)}#/$defs/CommittedMetricsEntry`;
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    installFormats(ajv);
    for (const f of files) ajv.addSchema(f.schema);
    const validate = ajv.getSchema(ref)!;
    const cases: ExampleCase[] = CASES.map(([example, value, valid]) => {
      assert.equal(validate(value), valid, `${dir}: ${example}`);
      return { example: `${dir}: ${example}`, ref, value, valid };
    });
    assert.deepEqual(oracleAgrees(ROOT, files, cases).problems, [], dir);
  }
});
