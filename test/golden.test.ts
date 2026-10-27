import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { materialize } from "../src/fetch.ts";
import { loadLock, type SpecLock } from "../src/lock.ts";
import { runStages, validateAgainst } from "../src/pipeline.ts";
import { renderGolden } from "./golden-render.ts";
import { ROOT } from "./helpers.ts";

// Set UPDATE_GOLDEN=1 to rewrite test/golden/<lock>/ from the current extractor output.
const UPDATE = process.env.UPDATE_GOLDEN === "1";

const locks = readdirSync(join(ROOT, "spec-input"))
  .filter((f) => f === "spec-lock.yaml" || f.endsWith(".lock.yaml"))
  .sort()
  .map((f) => loadLock(join(ROOT, "spec-input", f)));

async function bytesOrSkip(lock: SpecLock, t: { skip: (msg: string) => void }): Promise<Buffer | null> {
  try {
    return (await materialize(lock)).bytes;
  } catch (e) {
    if (lock.required) throw e;
    t.skip(`optional lock "${lock.name}": no reachable source`);
    return null;
  }
}

for (const lock of locks) {
  test(`golden snapshot: ${lock.name}`, async (t) => {
    const bytes = await bytesOrSkip(lock, t);
    if (!bytes) return;
    const out = runStages(lock, bytes);
    assert.deepEqual(out.exceptionProblems, [], "exception registry is current");
    assert.deepEqual(validateAgainst(ROOT, "spec-ir.schema.json", out.ir), [], "IR validates against ir/spec-ir.schema.json");
    assert.deepEqual(validateAgainst(ROOT, "findings.schema.json", out.findings), [], "findings validate against ir/findings.schema.json");

    const again = runStages(lock, Buffer.from(bytes));
    assert.equal(again.irJson, out.irJson, "IR is deterministic");
    assert.equal(again.findingsJson, out.findingsJson, "findings are deterministic");

    const dir = join(ROOT, "test", "golden", lock.name);
    const files = renderGolden(out.ir, out.findings);
    if (UPDATE) {
      mkdirSync(dir, { recursive: true });
      for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    }
    for (const [name, body] of Object.entries(files)) {
      const path = join(dir, name);
      assert.ok(existsSync(path), `missing golden file ${path}; run with UPDATE_GOLDEN=1`);
      assert.equal(body, readFileSync(path, "utf8"), `golden ${lock.name}/${name} differs; review, then run with UPDATE_GOLDEN=1`);
    }
    assert.equal(out.irJson, readFileSync(join(ROOT, lock.ir_dir, "spec-ir.json"), "utf8"), `committed ${lock.ir_dir}/spec-ir.json is current`);
    assert.equal(out.findingsJson, readFileSync(join(ROOT, lock.ir_dir, "findings.json"), "utf8"), `committed ${lock.ir_dir}/findings.json is current`);
  });
}

test("the pinned main spec: every field and key table row is extracted", async () => {
  const lock = locks.find((l) => l.name === "main")!;
  const out = runStages(lock, (await materialize(lock)).bytes);
  assert.equal(out.ir.counts.fields, 71);
  assert.equal(out.ir.counts.keys, 16);
  assert.equal(out.ir.counts.table_rows, 177);
  assert.deepEqual(out.ir.counts.tables_by_layout, {
    "appendix-a": 1,
    "appendix-b": 1,
    "concept-standard": 1,
    field: 12,
    "key-meaning": 1,
    "key-required-meaning": 2,
    "marker-meaning": 1,
  });
});
