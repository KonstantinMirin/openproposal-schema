import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAgainst } from "../src/pipeline.ts";
import { extractText, FIELD_HEADER, lineItems, ROOT } from "./helpers.ts";

const ir = () => extractText(lineItems(`### 5.1 Identity\n\n${FIELD_HEADER}\n| \`status\` | Enum | derived | \`a\` \\| \`b\` |`));

test("a synthetic IR validates against the IR schema", () => {
  assert.deepEqual(validateAgainst(ROOT, "spec-ir.schema.json", ir()), []);
});

test("the IR schema rejects unknown properties, markers, and type names", () => {
  const extra = ir() as unknown as { fields: Record<string, unknown>[] };
  extra.fields[0]!.extra = true;
  assert.notDeepEqual(validateAgainst(ROOT, "spec-ir.schema.json", extra), []);

  const marker = ir();
  (marker.fields[0] as { marker: string }).marker = "negotiable";
  assert.notDeepEqual(validateAgainst(ROOT, "spec-ir.schema.json", marker), []);

  const type = ir();
  (type.fields[0]!.type.parsed as unknown as { name: string }).name = "Map";
  assert.notDeepEqual(validateAgainst(ROOT, "spec-ir.schema.json", type), []);
});
