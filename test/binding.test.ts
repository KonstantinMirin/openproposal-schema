import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { BINDING_PARTS, BOUND_PATHS, bound, boundIn, loadBinding, mergeBinding, unboundIn, type KernelFile } from "../src/binding.ts";
import { loadConstructors } from "../src/constructors.ts";
import { loadKernel } from "../src/kernel.ts";
import { readYaml } from "../src/mapping.ts";
import { ROOT, SPEC } from "./helpers.ts";

const FILES: KernelFile[] = ["primitives", "constructors", "domains"];

test("the kernel files hold only definitions, and OpenProposal's binding only what rests on its text", () => {
  const binding = loadBinding(SPEC);
  for (const f of FILES) {
    assert.deepEqual(boundIn(readYaml(join(ROOT, "kernel", `${f}.yaml`)), BOUND_PATHS[f]), [], `kernel/${f}.yaml`);
    const part = Object.fromEntries(BINDING_PARTS[f].flatMap((k) => (binding[k] !== undefined ? [[k, binding[k]]] : [])));
    assert.deepEqual(unboundIn(part, BOUND_PATHS[f]), [], `the binding's ${f} part`);
    assert.ok(boundIn(part, BOUND_PATHS[f]).length > 0, `the binding gives some of ${f}`);
  }
});

test("the loaders merge the binding into the definitions, and name it", () => {
  const k = loadKernel(ROOT, SPEC);
  assert.equal(k.binding, join(SPEC, "kernel-binding.yaml"));
  const uuid = k.primitives.find((p) => p.name === "Uuid")!;
  assert.equal(uuid.decision, "D-037");
  assert.deepEqual(uuid.sources.spec?.map((s) => s.ir), ["field:4.1:proposal_id", "field:5.1:line_item_id"]);
  assert.equal(uuid.sources.standards?.[0]?.name, "RFC 9562, Universally Unique IDentifiers (UUIDs)", "the definition's standard stays");
  const amount = k.domains!.domains.flatMap((d) => d.concepts).find((c) => c.name === "amount")!;
  assert.deepEqual([amount.requires?.member, amount.requires?.concept, amount.requires?.decision], ["currency", "currency", "D-036"]);
  assert.ok(k.domains!.homonyms.length > 0, "the homonyms are the spec's");
  const c = loadConstructors(ROOT, SPEC);
  assert.equal(c.binding, join(SPEC, "kernel-binding.yaml"));
  const k2 = c.constructors.find((x) => x.name === "Selectable")!.parameters.find((p) => p.name === "K")!;
  assert.deepEqual(k2.carries && [k2.carries.member, k2.carries.decision, k2.carries.departure], ["id", "D-046", "D-047"]);
});

test("a merge adds keys and merges list items by name, and refuses a key both give or an item the kernel lacks", () => {
  const def = { items: [{ name: "A", type: "string", sources: { standards: ["x"] } }] };
  assert.deepEqual(mergeBinding(def, { items: [{ name: "A", decision: "D-1", sources: { spec: ["s"] } }] }, "f"), { items: [{ name: "A", type: "string", sources: { standards: ["x"], spec: ["s"] }, decision: "D-1" }] });
  assert.throws(() => mergeBinding(def, { items: [{ name: "A", type: "integer" }] }, "f"), /f\.items\[A\]\.type: both the kernel and the binding give it/);
  assert.throws(() => mergeBinding(def, { items: [{ name: "B", decision: "D-1" }] }, "f"), /the binding names "B", which the kernel doesn't define/);
});

test("a kernel file that holds a spec's key, or a binding that gives a definition, fails the load", () => {
  const def = parse("primitives:\n  - name: Uuid\n    type: string\n    decision: D-037\n");
  assert.throws(() => bound("primitives", "kernel/primitives.yaml", def, null), /holds primitives\[Uuid\]\.decision, which rest on a spec/);
  assert.deepEqual(unboundIn({ primitives: [{ name: "Uuid", decision: "D-1", constraints: { format: "uuid" }, rules: [{ id: "r", source: { spec: [], standard: {} } }] }] }, BOUND_PATHS.primitives), ["primitives[Uuid].constraints", "primitives[Uuid].rules[r].source.standard"]);
  assert.deepEqual(unboundIn({ homonyms: [{ member: "id" }], bases: [] }, BOUND_PATHS.domains), [], "a whole list the spec gives");
});

test("a binding names its spec's folder", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "op-binding-")), "widgets");
  mkdirSync(dir);
  writeFileSync(join(dir, "kernel-binding.yaml"), "format: 1\nspec: openproposal\n");
  assert.throws(() => loadBinding(dir), /"spec" is "openproposal"; it must equal the spec's folder, "widgets"/);
  writeFileSync(join(dir, "kernel-binding.yaml"), "format: 1\nspec: widgets\nprimitive: []\n");
  assert.throws(() => loadBinding(dir), /not a valid kernel binding/);
});
