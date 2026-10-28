/**
 * The gates on the gates: every gate fails on each of its known-bad
 * fixtures with the message the fixture expects; every gate has a fixture
 * and ran; the guard, which fails when a gate's code, fixtures, data, or
 * exemptions changed without a gate decision that names the gate and accepts
 * its new fingerprint, when a gate a decision accepted is gone and no later
 * decision retires it, or when a concept a gate decision accepted is gone and
 * no gate decision retires it; and the append-only check, which fails when a
 * gate decision the base holds is edited, deleted, or renamed.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { compileSchema } from "../src/pipeline.ts";
import { runTool } from "./common.ts";
import { defineGate, ROOT, type FixtureRun } from "./harness.ts";

/** The fingerprints of the named gates over the repository with some files changed or removed, and every other gate's as it is: what a guard fixture probes. */
export type Recompute = (changes: Record<string, ((text: string) => string) | null>, gates: string[]) => [string, string][];

/** A change a probe makes to a file, which must change it; a probe that changes nothing would prove nothing. */
const edit = (from: string, to: string) => (text: string) => {
  const out = text.replace(from, to);
  if (out === text) throw new Error(`the probe found no ${from} to change`);
  return out;
};

export const selfTests = defineGate<{ runs: FixtureRun[] }>({
  id: "self-tests",
  title: "gate self-tests: every gate fails on each of its known-bad fixtures, with the message the fixture expects",
  code: ["gates/harness.ts#runFixture", "gates/harness.ts#cloneInput", "gates/harness.ts#matches"],
  check: (i) => {
    const problems = i.runs.flatMap((r) =>
      !r.failed ? [`${r.gate}: the fixture "${r.fixture}" didn't fail the gate${r.problems.length > 0 ? `: ${r.problems[0]}` : ""}`] : !r.matched ? [`${r.gate}: the fixture "${r.fixture}" failed the gate, but with none of its expected message: ${r.problems.slice(0, 2).join("; ")}`] : [],
    );
    return { problems, note: `${i.runs.length} fixtures over ${new Set(i.runs.map((r) => r.gate)).size} gates, each failing its gate with its expected message` };
  },
  fixtures: [
    { name: "a fixture the gate passes", mutate: (i) => ({ runs: [...i.runs, { gate: "typecheck", fixture: "a fixture", failed: false, matched: false, problems: [] }] }), expect: 'the fixture "a fixture" didn\'t fail the gate' },
    { name: "a fixture that fails for another reason", mutate: (i) => ({ runs: [...i.runs, { gate: "typecheck", fixture: "a fixture", failed: true, matched: false, problems: ["something else"] }] }), expect: "with none of its expected message" },
  ],
});

/** Each registered gate: its fixture count, and whether `npm run ci` ran it. */
export const fixturesExist = defineGate<{ gates: { id: string; fixtures: number; ran: boolean }[] }>({
  id: "fixtures-exist",
  title: "gate fixtures: every gate in scripts/ci.ts has known-bad fixtures and ran",
  check: (i) => {
    const ids = i.gates.map((g) => g.id);
    const twice = ids.filter((x, n) => ids.indexOf(x) !== n);
    const problems = [
      ...i.gates.filter((g) => g.fixtures === 0).map((g) => `${g.id}: has no known-bad fixture, so nothing shows it can fail`),
      ...i.gates.filter((g) => !g.ran).map((g) => `${g.id}: didn't run, so its fixtures didn't either`),
      ...[...new Set(twice)].map((x) => `${x}: two gates have this ID`),
    ];
    return { problems, note: `${i.gates.length} gates, ${i.gates.reduce((n, g) => n + g.fixtures, 0)} fixtures` };
  },
  fixtures: [
    { name: "a gate with no fixture", mutate: (i) => ({ gates: [...i.gates, { id: "a-new-gate", fixtures: 0, ran: true }] }), expect: "a-new-gate: has no known-bad fixture" },
    { name: "a gate that didn't run", mutate: (i) => ({ gates: [...i.gates, { id: "a-skipped-gate", fixtures: 1, ran: false }] }), expect: "a-skipped-gate: didn't run" },
  ],
});

/** A gate decision: the record a change to a gate, a fixture set, or an exemption cites, which names each gate it accepts with its fingerprint. */
export interface GateDecision {
  format: 1;
  id: string;
  date: string;
  question: string;
  decision: string;
  rationale: string;
  accepts?: { gate: string; fingerprint: string }[];
  /** The concepts of `kernel/domains.yaml` the record accepts; one can leave only through a later record's `retires`. */
  concepts?: string[];
  retires?: { concept: string; reason: string }[];
  /** The gates the record removes, each with why; an earlier record's `accepts` of a retired gate stays as it was written. */
  retires_gates?: { gate: string; reason: string }[];
  file: string;
}

export const GATE_DECISIONS_DIR = "gates/decisions";
const GATE_DECISION_SCHEMA = "gates/decision.schema.json";

/** Loads every gate decision, validated against its schema, in ID order. */
export function loadGateDecisions(dir = join(ROOT, GATE_DECISIONS_DIR)): GateDecision[] {
  const validate = compileSchema(join(ROOT, GATE_DECISION_SCHEMA));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => {
      const doc = parse(readFileSync(join(dir, f), "utf8"), { version: "1.2", schema: "core" }) as Omit<GateDecision, "file">;
      const errors = validate(doc);
      if (errors.length > 0) throw new Error(`${GATE_DECISIONS_DIR}/${f}: not a valid gate decision: ${errors.join("; ")}`);
      if (`${doc.id}.yaml` !== f) throw new Error(`${GATE_DECISIONS_DIR}/${f}: "id" is "${doc.id}"; it must equal the file name`);
      if (doc.accepts === undefined && doc.concepts === undefined && doc.retires === undefined && doc.retires_gates === undefined) throw new Error(`${GATE_DECISIONS_DIR}/${f}: accepts no gate, accepts no concept, and retires none`);
      return { ...doc, file: `${GATE_DECISIONS_DIR}/${f}` };
    });
}

export const guard = defineGate<{ fingerprints: [string, string][]; records: GateDecision[]; concepts: string[]; recompute: Recompute }>({
  id: "guard",
  title: "guard: every gate's code, fixtures, data, and exemptions are what the latest gate decision that names it accepts, and no accepted concept is gone without a decision",
  code: ["gates/harness.ts#fingerprint", "gates/meta.ts#loadGateDecisions"],
  files: ["scripts/ci.ts", "gates/harness.ts", "gates/index.ts", "gates/decision.schema.json"],
  check: (i) => {
    const problems: string[] = [];
    const known = new Set(i.fingerprints.map(([g]) => g));
    // In ID order: a record's accepts sets each gate's fingerprint, and its retires_gates removes the gate, so a removed gate never forces an edit of the record that accepted it.
    const accepted = new Map<string, { fingerprint: string; by: string }>();
    const retiredGates = new Map<string, string>();
    for (const r of i.records) {
      for (const a of r.accepts ?? []) {
        accepted.set(a.gate, { fingerprint: a.fingerprint, by: r.id });
        retiredGates.delete(a.gate);
      }
      for (const x of r.retires_gates ?? []) {
        if (!accepted.has(x.gate)) problems.push(`${r.file}: retires the gate "${x.gate}", which no earlier record accepts`);
        accepted.delete(x.gate);
        retiredGates.set(x.gate, r.id);
      }
    }
    for (const [gate, a] of accepted) if (!known.has(gate)) problems.push(`the gate "${gate}" is gone, and ${a.by} accepts it; add a gate decision that retires it under retires_gates and says why`);
    for (const [gate, by] of retiredGates) if (known.has(gate)) problems.push(`the gate "${gate}" runs, and ${by} retires it; accept it again in a later gate decision, or remove it`);
    for (const [gate, fp] of i.fingerprints) {
      const a = accepted.get(gate);
      if (!a && retiredGates.has(gate)) continue;
      if (!a) problems.push(`${gate}: no gate decision names it; add one under ${GATE_DECISIONS_DIR}/ that accepts fingerprint ${fp} and says why`);
      else if (a.fingerprint !== fp) problems.push(`${gate}: its code, fixtures, data, or exemptions changed: the fingerprint is ${fp}, and ${a.by} accepts ${a.fingerprint}; add a gate decision that names "${gate}", accepts the new fingerprint, and says why`);
    }
    // In ID order too: a record's concepts accepts each, and its retires removes it, so a later record may accept a retired concept again.
    const kept = new Set<string>();
    const retired = new Map<string, string>();
    for (const r of i.records) {
      for (const c of r.concepts ?? []) {
        kept.add(c);
        retired.delete(c);
      }
      for (const x of r.retires ?? []) retired.set(x.concept, r.id);
    }
    const current = new Set(i.concepts);
    for (const c of [...kept].sort()) if (!current.has(c) && !retired.has(c)) problems.push(`the concept "${c}" is gone from kernel/domains.yaml; a gate decision accepted it, so a later one must retire it and say why`);
    for (const [c, by] of retired) if (current.has(c)) problems.push(`the concept "${c}" is back in kernel/domains.yaml, and ${by} retires it; accept it again in a later gate decision, or remove it`);
    return { problems, note: `${i.fingerprints.length} gates, each at the fingerprint ${[...new Set([...accepted.values()].map((a) => a.by))].join(", ") || "no record"} accepts; ${kept.size} concepts accepted, ${retired.size} retired` };
  },
  fixtures: [
    {
      name: "a gate changed with no decision",
      mutate: (i) => ({ ...i, fingerprints: i.fingerprints.map(([g, f], n) => [g, n === 0 ? "0".repeat(64) : f] as [string, string]) }),
      expect: "add a gate decision that names",
    },
    { name: "a new gate no decision names", mutate: (i) => ({ ...i, fingerprints: [...i.fingerprints, ["a-new-gate", "1".repeat(64)]] }), expect: "a-new-gate: no gate decision names it" },
    { name: "a gate removed with no record that retires it", mutate: (i) => ({ ...i, fingerprints: i.fingerprints.filter(([g]) => g !== "typecheck") }), expect: 'the gate "typecheck" is gone, and' },
    {
      name: "a retired gate that still runs",
      mutate: (i) => ({ ...i, records: [...i.records, { format: 1, id: "G-999", date: "2026-10-25", question: "A fixture?", decision: "A fixture.", rationale: "A fixture.", retires_gates: [{ gate: "typecheck", reason: "A fixture." }], file: "gates/decisions/G-999.yaml" }] }),
      expect: 'the gate "typecheck" runs, and G-999 retires it',
    },
    { name: "an accepted concept removed because a gate says it's unused", mutate: (i) => ({ ...i, concepts: i.concepts.filter((c) => c !== "amount") }), expect: 'the concept "amount" is gone' },
    {
      name: "a retired concept back with no later record that accepts it",
      mutate: (i) => ({ ...i, records: [...i.records, { format: 1, id: "G-999", date: "2026-10-26", question: "A fixture?", decision: "A fixture.", rationale: "A fixture.", retires: [{ concept: "amount", reason: "A fixture." }], file: "gates/decisions/G-999.yaml" }] }),
      expect: 'the concept "amount" is back in kernel/domains.yaml, and G-999 retires it',
    },
    // The independent review's probes: each weakens a gate through a file its fingerprint didn't read.
    { name: "inScope always true, in a helper another file holds", mutate: (i) => ({ ...i, fingerprints: i.recompute({ "src/mapping.ts": edit("locks === undefined || locks.includes(lock)", "true") }, ["fidelity"]) }), expect: "fidelity: its code, fixtures, data, or exemptions changed" },
    { name: "ajv-formats removed from the formats every validator installs", mutate: (i) => ({ ...i, fingerprints: i.recompute({ "src/formats.ts": edit("  ajvFormats.default(ajv);\n", "") }, ["fidelity"]) }), expect: "fidelity: its code, fixtures, data, or exemptions changed" },
    { name: "strict: false in the corpus validators", mutate: (i) => ({ ...i, fingerprints: i.recompute({ "src/corpus.ts": edit("new Ajv2020({ strict: true,", "new Ajv2020({ strict: false,") }, ["fidelity"]) }), expect: "fidelity: its code, fixtures, data, or exemptions changed" },
    { name: "strict: false in the TypeScript configuration", mutate: (i) => ({ ...i, fingerprints: i.recompute({ "tsconfig.json": edit('"strict": true', '"strict": false') }, ["typecheck"]) }), expect: "typecheck: its code, fixtures, data, or exemptions changed" },
    { name: "a test glob that matches nothing", mutate: (i) => ({ ...i, fingerprints: i.recompute({ "package.json": edit("test/**/*.test.ts", "test/**/*.no-such.test.ts") }, ["npm-test"]) }), expect: "npm-test: its code, fixtures, data, or exemptions changed" },
    { name: "a test file deleted", mutate: (i) => ({ ...i, fingerprints: i.recompute({ "test/fidelity.test.ts": null }, ["npm-test"]) }), expect: "npm-test: its code, fixtures, data, or exemptions changed" },
    // A spec plugin's readers reach their gates through the gates' inputs; each gate reads every plugin, so weakening one changes it.
    { name: "a spec plugin's rule check that finds nothing", mutate: (i) => ({ ...i, fingerprints: i.recompute({ "src/specs/openproposal/rule-checks.ts": edit('"rule:2.2:06ccee9f": (v, ctx) => {', '"rule:2.2:06ccee9f": (v, ctx) => {\n    if (v !== undefined) return [];') }, ["rule-checks"]) }), expect: "rule-checks: its code, fixtures, data, or exemptions changed" },
    { name: "a spec plugin's fidelity reader that skips every example", mutate: (i) => ({ ...i, fingerprints: i.recompute({ "src/specs/openproposal/fidelity-readers.ts": edit("const PLACEHOLDER = /<[^<>\\s]+>/;", "const PLACEHOLDER = /./;") }, ["fidelity"]) }), expect: "fidelity: its code, fixtures, data, or exemptions changed" },
    { name: "a spec plugin's round-trip notation that counts fewer buyer markers", mutate: (i) => ({ ...i, fingerprints: i.recompute({ "src/specs/openproposal/render.ts": edit('"supplied", "requestable"] as const;', '"supplied"] as const;') }, ["round-trip"]) }), expect: "round-trip: its code, fixtures, data, or exemptions changed" },
    // A spec's exemption files sit in its folder, under specs/<spec>/; the fingerprint reads every spec's.
    { name: "an entry added to a spec's exception registry", mutate: (i) => ({ ...i, fingerprints: i.recompute({ "specs/openproposal/ir/exceptions.yaml": edit("# Exception registry", "# The exception registry") }, ["extraction"]) }), expect: "extraction: its code, fixtures, data, or exemptions changed" },
  ],
});

/** The empty tree's SHA-1, against which every record shows as deleted. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The gate decisions the base holds that the tree edits, deletes, or
 * renames: `git diff -M --name-status --diff-filter=MDR <base> [<head>]`
 * over gates/decisions/, against the working tree when `head` is null.
 */
export function decisionEdits(base: string, head: string | null): { problems: string[]; note: string } {
  if (/^0{40}$/.test(base)) return { problems: [], note: "no previous commit, so every record is new" };
  const found = runTool("git", ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  if (!found.ok) return { problems: [`the base ${base} isn't in this clone, so nothing shows the records are only appended; fetch it: git fetch --no-tags --depth=1 origin ${base}`], note: "" };
  const r = runTool("git", ["diff", "-M", "--name-status", "--diff-filter=MDR", base, ...(head === null ? [] : [head]), "--", `${GATE_DECISIONS_DIR}/`]);
  if (!r.ok) return { problems: [`git diff against ${base} failed: ${r.output}`], note: "" };
  const kinds: Record<string, string> = { M: "edited", D: "deleted", R: "renamed" };
  const problems = r.output
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const [status, ...paths] = l.split("\t");
      return `${paths.join(" -> ")}: ${kinds[status![0]!] ?? status} since ${base}; a gate decision is never changed once it is on the base: add a later record that accepts, retires, or says what changed`;
    });
  return { problems, note: `against ${base}, no record under ${GATE_DECISIONS_DIR}/ is edited, deleted, or renamed` };
}

/** A tree: the base's, with one file's text changed, as a commit that edits a record would hold. */
function treeEditing(base: string, path: string, change: (text: string) => string): string {
  const index = join(ROOT, "build", "append-only.index");
  const env = { GIT_INDEX_FILE: index };
  const read = runTool("git", ["read-tree", base], ROOT, env);
  const text = runTool("git", ["show", `${base}:${path}`]);
  if (!read.ok || !text.ok) throw new Error(`can't read ${path} at ${base}: ${read.output}${text.output}`);
  const blob = spawnBlob(change(text.output));
  const update = runTool("git", ["update-index", "--cacheinfo", `100644,${blob},${path}`], ROOT, env);
  const tree = runTool("git", ["write-tree"], ROOT, env);
  if (!update.ok || !tree.ok) throw new Error(`can't write a tree: ${update.output}${tree.output}`);
  return tree.output.trim();
}

/** Writes a blob and returns its ID. */
function spawnBlob(text: string): string {
  const r = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: ROOT, input: text, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git hash-object failed: ${r.stderr}`);
  return r.stdout.trim();
}

export const appendOnly = defineGate<{ base: string; head: string | null }>({
  id: "decisions-append-only",
  title: "gate decisions are append-only: no record the base holds under gates/decisions/ is edited, deleted, or renamed",
  code: ["gates/meta.ts#decisionEdits"],
  check: (i) => decisionEdits(i.base, i.head),
  fixtures: [
    { name: "every record deleted", mutate: (i) => ({ ...i, head: EMPTY_TREE }), expect: /gates\/decisions\/G-001\.yaml: deleted since/ },
    { name: "an accepted fingerprint edited in place", mutate: (i) => ({ ...i, head: treeEditing(i.base, `${GATE_DECISIONS_DIR}/G-001.yaml`, (t) => t.replace(/fingerprint: [0-9a-f]{64}/, `fingerprint: ${"0".repeat(64)}`)) }), expect: /gates\/decisions\/G-001\.yaml: edited since/ },
    { name: "a base this clone doesn't hold", mutate: (i) => ({ ...i, base: "f".repeat(40) }), expect: "isn't in this clone" },
  ],
});
