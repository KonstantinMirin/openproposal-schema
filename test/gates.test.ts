import { test } from "node:test";
import assert from "node:assert/strict";
import { cloneInput, declarationText, disk, filesMatching, fingerprint, matches, overlay, runFixture, defineGate } from "../gates/harness.ts";
import { REGISTRY } from "../gates/index.ts";
import { decisionEdits, guard, loadGateDecisions } from "../gates/meta.ts";

test("a cloned input copies data, buffers included, and shares what isn't data", () => {
  const f = () => 1;
  const input = { a: [1, { b: 2 }], buf: Buffer.from("x"), m: new Map([["k", { v: 1 }]]), f };
  const c = cloneInput(input);
  c.a.push(3);
  (c.a[1] as { b: number }).b = 9;
  c.buf[0] = 0x79;
  c.m.get("k")!.v = 2;
  assert.deepEqual(input.a, [1, { b: 2 }]);
  assert.equal(input.buf.toString(), "x");
  assert.equal(input.m.get("k")!.v, 1);
  assert.ok(Buffer.isBuffer(c.buf));
  assert.equal(c.f, f);
});

test("a gate's code is its declaration and the declarations of its own file it reaches", () => {
  const text = declarationText("gates/common.ts", "committedTreeCurrent");
  assert.match(text, /export function committedTreeCurrent/);
  assert.match(text, /export function treeDiff/);
  assert.doesNotMatch(text, /export function sameRuns/);
});

test("a gate's code reaches, through imports, the declarations it runs in other files, and no others", () => {
  const text = declarationText("src/fidelity.ts", "checkFidelity");
  assert.match(text, /^\/\/ src\/mapping\.ts$/m);
  assert.match(text, /export const inScope = /, "a helper of another file it calls");
  assert.match(text, /export function installFormats/);
  assert.match(text, /export class Validators/);
  assert.doesNotMatch(text, /export function loadMappings/, "a function of that file it doesn't call");
});

test("a fingerprint changes with a helper of another file, a configuration file, or a file of a directory it names, and not otherwise", () => {
  const g = REGISTRY.find((r) => r.gate.id === "fidelity")!;
  const fp = (src = disk) => fingerprint(g.gate, g.file, g.name, src);
  assert.equal(fp(), fp(overlay({})));
  assert.notEqual(fp(), fp(overlay({ "src/mapping.ts": (t) => t.replace("locks === undefined || locks.includes(lock)", "true") })));
  assert.equal(fp(), fp(overlay({ "src/mapping.ts": (t) => t.replace("export function loadMappings", "export function loadMappings ") })), "a function it doesn't reach");
  const tests = REGISTRY.find((r) => r.gate.id === "npm-test")!;
  const tp = (src = disk) => fingerprint(tests.gate, tests.file, tests.name, src);
  assert.notEqual(tp(), tp(overlay({ "test/gates.test.ts": null })));
  assert.notEqual(tp(), tp(overlay({ "package.json": (t) => t.replace("test/**/*.test.ts", "test/**/*.none.ts") })));
  const tc = REGISTRY.find((r) => r.gate.id === "typecheck")!;
  assert.notEqual(fingerprint(tc.gate, tc.file, tc.name), fingerprint(tc.gate, tc.file, tc.name, overlay({ "tsconfig.json": (t) => t.replace('"strict": true', '"strict": false') })));
});

test("an exemption path with * segments names every spec's file, and one that matches nothing throws", () => {
  assert.deepEqual(filesMatching("specs/*/ir/exceptions.yaml", disk), ["specs/adcom/ir/exceptions.yaml", "specs/dealsapi/ir/exceptions.yaml", "specs/openproposal/ir/exceptions.yaml"]);
  assert.ok(filesMatching("specs/*/decisions/*.yaml", disk).includes("specs/openproposal/decisions/D-001.yaml"));
  assert.deepEqual(filesMatching("kernel/domains.yaml", disk), ["kernel/domains.yaml"], "a plain path is itself");
  const second = overlay({}, { ...disk, list: (dir) => [...disk.list(dir), ...(dir === "specs" ? ["specs/other/ir/exceptions.yaml"] : [])] });
  assert.deepEqual(filesMatching("specs/*/ir/exceptions.yaml", second), ["specs/adcom/ir/exceptions.yaml", "specs/dealsapi/ir/exceptions.yaml", "specs/openproposal/ir/exceptions.yaml", "specs/other/ir/exceptions.yaml"], "another spec's file joins");
  assert.throws(() => filesMatching("specs/*/ir/no-such.yaml", disk), /specs\/\*\/ir\/no-such\.yaml matches no file/);
  const g = REGISTRY.find((r) => r.gate.id === "extraction")!;
  const fp = (src = disk) => fingerprint(g.gate, g.file, g.name, src);
  assert.notEqual(fp(), fp(overlay({ "specs/openproposal/ir/exceptions.yaml": (x) => `${x}# a change\n` })), "a spec's exception registry is part of the fingerprint");
  assert.throws(() => fp(overlay({ "specs/openproposal/ir/exceptions.yaml": null, "specs/adcom/ir/exceptions.yaml": null, "specs/dealsapi/ir/exceptions.yaml": null })), /matches no file/, "a registry gone from every spec fails the fingerprint");
});

test("a fixture passes only when the gate fails with the expected message", async () => {
  const g = defineGate<{ n: number }>({ id: "test", title: "test", check: (i) => ({ problems: i.n > 0 ? [`n is ${i.n}`] : [] }), fixtures: [] });
  assert.deepEqual(await runFixture(g, { n: 0 }, { name: "fails", mutate: () => ({ n: 2 }), expect: "n is 2" }).then((r) => [r.failed, r.matched]), [true, true]);
  assert.deepEqual(await runFixture(g, { n: 0 }, { name: "wrong message", mutate: () => ({ n: 2 }), expect: "n is 3" }).then((r) => [r.failed, r.matched]), [true, false]);
  assert.deepEqual(await runFixture(g, { n: 0 }, { name: "passes", mutate: (i) => i, expect: "n is" }).then((r) => [r.failed, r.matched]), [false, false]);
  assert.ok(matches(["a b"], /b$/));
});

test("every registered gate has a unique ID and at least one fixture", () => {
  const ids = REGISTRY.map((r) => r.gate.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of REGISTRY) assert.ok(r.gate.fixtures.length > 0, r.gate.id);
});

test("a gate decision the base holds may not change: an edit, a deletion, or a rename fails, and a new record passes", () => {
  assert.deepEqual(decisionEdits("HEAD", null).problems, [], "the working tree against its own commit");
  const deleted = decisionEdits("HEAD", "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  assert.ok(deleted.problems.some((p) => p.startsWith("gates/decisions/G-001.yaml: deleted since HEAD")));
  assert.match(decisionEdits("f".repeat(40), null).problems.join("; "), /isn't in this clone/);
  assert.deepEqual(decisionEdits("0".repeat(40), null).problems, [], "a first push has no previous commit");
});

test("a removed gate needs a later record that retires it, and a retired gate may not run", async () => {
  const records = loadGateDecisions();
  // The gates that run now: every accepted one, but those a later record retires.
  const accepted = new Map<string, string>();
  for (const r of records) {
    for (const a of r.accepts ?? []) accepted.set(a.gate, a.fingerprint);
    for (const x of r.retires_gates ?? []) accepted.delete(x.gate);
  }
  const fingerprints = [...accepted] as [string, string][];
  // The concepts the domain file holds now: every accepted one, but those a later record retires.
  const held = new Set<string>();
  for (const r of records) {
    for (const c of r.concepts ?? []) held.add(c);
    for (const x of r.retires ?? []) held.delete(x.concept);
  }
  const base = { fingerprints, records, concepts: [...held], recompute: () => fingerprints };
  assert.deepEqual((await guard.check(base)).problems, []);
  const removed = { ...base, fingerprints: fingerprints.filter(([g]) => g !== "typecheck") };
  assert.match((await guard.check(removed)).problems.join("; "), /the gate "typecheck" is gone/);
  const retiring = { format: 1 as const, id: "G-999", date: "2026-10-25", question: "Is the gate gone?", decision: "It is retired.", rationale: "It checked nothing.", retires_gates: [{ gate: "typecheck", reason: "It checked nothing." }], file: "gates/decisions/G-999.yaml" };
  assert.deepEqual((await guard.check({ ...removed, records: [...records, retiring] })).problems, [], "retired by a later record, with the earlier record unchanged");
  assert.match((await guard.check({ ...base, records: [...records, retiring] })).problems.join("; "), /the gate "typecheck" runs, and G-999 retires it/);
});

test("no document the export publishes names a gate a record retires", async () => {
  const { readFileSync } = await import("node:fs");
  const { REPO_ROOT } = await import("../src/repo.ts");
  const retired = loadGateDecisions().flatMap((r) => (r.retires_gates ?? []).map((x) => x.gate));
  assert.ok(retired.length > 0);
  for (const doc of ["README.md", "NOTICE"]) {
    const text = readFileSync(`${REPO_ROOT}/${doc}`, "utf8");
    for (const id of retired) assert.doesNotMatch(text, new RegExp(`(?<![-\\w])${id}(?![-\\w])`), `${doc} names the retired gate ${id}`);
  }
});
