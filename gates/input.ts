/** The gates on each lock's input: its snapshot, the specification it materializes, and the extraction into the committed IR. */
import { join } from "node:path";
import { applyExceptions, type ExceptionEntry } from "../src/exceptions.ts";
import { checkSnapshot, materialize } from "../src/fetch.ts";
import type { SpecIR } from "../src/ir-types.ts";
import type { SpecLock } from "../src/lock.ts";
import { runStages, validateAgainst, type FindingsDoc } from "../src/pipeline.ts";
import { committedCurrent, flipped, sameRuns, type CommittedInput, type RunsInput } from "./common.ts";
import { defineGate, ROOT } from "./harness.ts";

const EXCEPTIONS = "ir/exceptions.yaml";

export const snapshot = defineGate<{ lock: SpecLock }>({
  id: "snapshot",
  title: "snapshot holds the locked specification and examples/, so every gate runs without the clone",
  code: ["src/fetch.ts#checkSnapshot"],
  check: (i) => checkSnapshot(i.lock),
  fixtures: [
    { name: "a blob the snapshot's specification isn't", mutate: (i) => ({ lock: { ...i.lock, blob: "0".repeat(40) } }), expect: `not the locked ${"0".repeat(40)}` },
    { name: "an example file the snapshot lacks", mutate: (i) => ({ lock: { ...i.lock, examples: { ...i.lock.examples, "examples/missing.yaml": "0".repeat(40) } } }), expect: "the snapshot has no examples/missing.yaml" },
  ],
});

export const specInput = defineGate<{ lock: SpecLock }>({
  id: "spec-input",
  title: "spec input reproducible",
  code: ["src/fetch.ts#materialize"],
  check: async (i) => {
    const m = await materialize(i.lock);
    return { problems: [], note: `blob ${i.lock.blob.slice(0, 8)} via ${m.via}` };
  },
  fixtures: [{ name: "a blob no source has", mutate: (i) => ({ lock: { ...i.lock, blob: "1".repeat(40), sources: i.lock.sources.filter((s) => "snapshot" in s) } }), expect: "1".repeat(40) }],
});

export const extraction = defineGate<{ lock: SpecLock; bytes: Buffer; exceptions: ExceptionEntry[] }>({
  id: "extraction",
  title: "extraction (total, schema-valid, exceptions current)",
  code: ["src/pipeline.ts#runStages", "src/pipeline.ts#validateAgainst", "src/exceptions.ts#applyExceptions"],
  exemptions: [EXCEPTIONS],
  check: (i) => {
    const out = runStages(i.lock, i.bytes, i.exceptions);
    return {
      problems: [
        ...validateAgainst(ROOT, "spec-ir.schema.json", out.ir).map((e) => `spec-ir.json: ${e}`),
        ...validateAgainst(ROOT, "findings.schema.json", out.findings).map((e) => `findings.json: ${e}`),
        ...out.exceptionProblems,
      ],
    };
  },
  fixtures: [
    {
      name: "a table of a layout the extractor doesn't know",
      mutate: (i) => ({ ...i, bytes: Buffer.from(i.bytes.toString("utf8").replace("## 4. Proposal\n", "## 4. Proposal\n\n| Alpha | Beta |\n| :--- | :--- |\n| a | b |\n")) }),
      expect: "unknown table layout",
    },
    { name: "an exception that names no finding", mutate: (i) => ({ ...i, exceptions: [...i.exceptions, { finding: "unresolved_identifier:no_such_name", verdict: "accepted", reason: "A fixture entry.", locks: null }] }), expect: "no_such_name" },
  ],
});

export const irDeterministic = defineGate<RunsInput>({
  id: "ir-deterministic",
  title: (i) => `deterministic ${i.label}`,
  code: ["gates/common.ts#sameRuns"],
  check: sameRuns,
  fixtures: [
    { name: "the second run differs", mutate: (i) => ({ ...i, runs: [i.runs[0]!, flipped(i.runs[1]!)] }), expect: "run 2 differs" },
    { name: "a run wrote nothing", mutate: (i) => ({ ...i, runs: [null, i.runs[1]!] }), expect: "run 1 wrote no" },
  ],
});

export const irCommitted = defineGate<CommittedInput>({
  id: "ir-committed",
  title: (i) => `committed ${i.file} current`,
  code: ["gates/common.ts#committedCurrent"],
  check: committedCurrent,
  fixtures: [
    { name: "the committed IR is stale", mutate: (i) => ({ ...i, committed: flipped(i.committed!) }), expect: "isn't what the pipeline writes" },
    { name: "no committed IR", mutate: (i) => ({ ...i, committed: null }), expect: "is missing" },
  ],
});

/** For an optional lock with no reachable source: its committed files, as they are read. */
export const committedFiles = defineGate<{ lock: SpecLock; ir: SpecIR; findings: FindingsDoc; exceptions: ExceptionEntry[] }>({
  id: "committed-files",
  title: "committed files valid and current with the lock",
  code: ["src/pipeline.ts#validateAgainst", "src/exceptions.ts#applyExceptions"],
  exemptions: [EXCEPTIONS],
  check: (i) => ({
    problems: [
      ...validateAgainst(ROOT, "spec-ir.schema.json", i.ir),
      ...validateAgainst(ROOT, "findings.schema.json", i.findings),
      ...(i.ir.input.blob === i.lock.blob && i.findings.input.blob === i.lock.blob ? [] : ["committed files name a different blob than the lock"]),
      ...applyExceptions(
        i.findings.findings.map((f) => ({ ...f, disposition: null })),
        i.exceptions,
        i.lock.name,
      ),
    ],
  }),
  fixtures: [
    { name: "the committed IR names another blob", mutate: (i) => ({ ...i, lock: { ...i.lock, blob: "2".repeat(40) } }), expect: "committed files name a different blob than the lock" },
    { name: "an IR that isn't schema-valid", mutate: (i) => ({ ...i, ir: { ...i.ir, ir_version: 2 as 1 } }), expect: "ir_version" },
  ],
});

export const exceptionsFile = join(ROOT, EXCEPTIONS);
