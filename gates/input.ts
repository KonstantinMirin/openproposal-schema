/** The gates on each lock's input: its snapshot, the specification it materializes, and the extraction into the committed IR. */
import { join } from "node:path";
import { applyExceptions, type ExceptionEntry } from "../src/exceptions.ts";
import { checkSnapshot, materialize } from "../src/fetch.ts";
import type { SpecIR } from "../src/ir-types.ts";
import type { SpecLock } from "../src/lock.ts";
import { runStages, validateAgainst, type FindingsDoc } from "../src/pipeline.ts";
import { checkProfile, type ProfileCheckInput } from "../src/profile.ts";
import { committedCurrent, flipped, sameRuns, type CommittedInput, type RunsInput } from "./common.ts";
import { defineGate } from "./harness.ts";

/** Each spec's exception registry, by path from its folder. */
const EXCEPTIONS = "ir/exceptions.yaml";
/** The registries the extraction gates read, in every spec's folder. */
const EXCEPTION_FILES = `specs/*/${EXCEPTIONS}`;

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
  exemptions: [EXCEPTION_FILES],
  check: (i) => {
    const out = runStages(i.lock, i.bytes, i.exceptions);
    return {
      problems: [
        ...validateAgainst("spec-ir.schema.json", out.ir).map((e) => `spec-ir.json: ${e}`),
        ...validateAgainst("findings.schema.json", out.findings).map((e) => `findings.json: ${e}`),
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
    // AdCOM's HTML tables hold only the tags a table and its cells use.
    { name: "an HTML table cell with a tag the reader doesn't know", spec: "adcom", mutate: (i) => ({ ...i, bytes: Buffer.from(i.bytes.toString("utf8").replace("<td>Vendor-specific codes.</td>", "<td><span>Vendor-specific</span> codes.</td>")) }), expect: "unsupported HTML tag <span> in a table cell" },
    { name: "an HTML table with no </table>", spec: "adcom", mutate: (i) => ({ ...i, bytes: Buffer.from(i.bytes.toString("utf8").replace(/<\/table>\s*\n\s*### List: {2}Volume Normalization Modes/, "\n### List:  Volume Normalization Modes")) }), expect: "no </table>" },
    // The Deals API's anchors name the headings after them, its Type cells state a base type and qualifiers, and its attribute tables sit under an Object: heading.
    { name: "an anchor on its own line that names no heading", spec: "dealsapi", mutate: (i) => ({ ...i, bytes: Buffer.from(i.bytes.toString("utf8").replace('<a name="goals"></a>\n## Goals\n', '<a name="goals"></a>\n\nGoals.\n')) }), expect: 'the anchor "goals" on its own line is followed by a paragraph' },
    { name: "a Type cell with a qualifier the grammar doesn't know", spec: "dealsapi", mutate: (i) => ({ ...i, bytes: Buffer.from(i.bytes.toString("utf8").replace("| `created` | string |", "| `created` | string, optional |")) }), expect: 'the qualifier "optional" is none of required, recommended, or default' },
    { name: "a profile's document whose section describes another object", spec: "dealsapi", mutate: (i) => ({ ...i, bytes: Buffer.from(i.bytes.toString("utf8").replace("## Object: Deal\n", "## Object: Deals\n")) }), expect: 'the profile names the document Deal at the section "object-deal", which describes the object Deals' },
    { name: "an anchor on its own line that names nothing", spec: "dealsapi", mutate: (i) => ({ ...i, bytes: Buffer.from(i.bytes.toString("utf8").replace('<a name="goals"></a>', '<a class="goals"></a>')) }), expect: 'an anchor on its own line, <a class="goals">, names nothing' },
    { name: "an attribute table outside an Object: section", spec: "dealsapi", mutate: (i) => ({ ...i, bytes: Buffer.from(i.bytes.toString("utf8").replace("## Object: Curation\n", "## Curation\n")) }), expect: 'table layout "attribute" belongs in an Object: section' },
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
  exemptions: [EXCEPTION_FILES],
  check: (i) => ({
    problems: [
      ...validateAgainst("spec-ir.schema.json", i.ir),
      ...validateAgainst("findings.schema.json", i.findings),
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

/** A spec's exception registry, by absolute path. */
export const exceptionsFileOf = (spec: string) => join(spec, EXCEPTIONS);

export const specProfile = defineGate<ProfileCheckInput>({
  id: "spec-profile",
  title: "spec profile: valid, named after its folder, with a plugin that reads its text, and every feature it turns on read by the plugin and used by the mapping",
  code: ["src/profile.ts#loadProfile", "src/profile.ts#checkProfile", "src/specs/index.ts#specOf"],
  // The profile's format is part of what the gate checks it against.
  files: ["specs/spec.schema.json"],
  check: (i) => {
    const problems = checkProfile(i);
    const on = Object.entries(i.profile.features ?? {}).filter(([, v]) => v).map(([k]) => k);
    return { problems, note: `${i.profile.title}, front end ${i.profile.front_end}${i.profile.plugin ? ` (plugin ${i.profile.plugin})` : ""}; features: ${on.join(", ") || "none"}` };
  },
  fixtures: [
    { name: "markers left off while the plugin reads them", mutate: (i) => ({ ...i, profile: { ...i.profile, features: { ...i.profile.features, markers: false } } }), expect: 'leaves "markers" off, and the plugin\'s list of markers is there' },
    { name: "profiles turned on with no profile entry", mutate: (i) => ({ ...i, roles: i.roles.filter((r) => r !== "profile") }), expect: 'turns on "profiles", and a mapping entry of role profile isn\'t there' },
    { name: "a document not named after its owner", mutate: (i) => ({ ...i, profile: { ...i.profile, documents: (i.profile.documents ?? []).map((d, n) => (n === 0 ? { ...d, document: "Offer" } : d)) } }), expect: "a document is its owner in PascalCase" },
    { name: "two documents for one section", mutate: (i) => ({ ...i, profile: { ...i.profile, documents: (i.profile.documents ?? []).map((d) => ({ ...d, section: "4" })) } }), expect: 'two documents have the section "4"' },
    { name: "a plugin that reads lowercase keywords under the uppercase policy", mutate: (i) => ({ ...i, text: i.text && { ...i.text, keywords: (p: string) => (/\bmust\b/i.test(p) ? ["MUST"] : []) } }), expect: "the plugin reads a lowercase keyword" },
    { name: "a text front end with no plugin", mutate: (i) => ({ ...i, text: null }), expect: "no plugin reads the text" },
    { name: "a spec that says it has reached only its input, and holds its IR", mutate: (i) => ({ ...i, profile: { ...i.profile, through: "input" as const } }), expect: 'says the spec has reached "input", and it holds ir, which the "extract" stage writes' },
    { name: "a file in the spec's folder that no stage writes", mutate: (i) => ({ ...i, entries: [...i.entries, "notes"] }), expect: "the spec's folder holds notes, which no stage of the pipeline writes and no gate reads" },
    { name: "a spec that says it has reached its model, and holds its schemas", mutate: (i) => ({ ...i, profile: { ...i.profile, through: "model" as const } }), expect: 'it holds schemas, which the "schemas" stage writes' },
    { name: "a spec that says it has reached its schemas, and holds its corpus", mutate: (i) => ({ ...i, profile: { ...i.profile, through: "schemas" as const } }), expect: 'it holds corpus, which the "outputs" stage writes' },
    { name: "a spec with locks called a schema set", mutate: (i) => ({ ...i, profile: { ...i.profile, front_end: "schemas" as const }, text: null }), expect: "which no gate would check" },
    // The feedback's table is the profile's data now, so the gate holds it to every lint kind, as the table's type once did.
    { name: "a lint kind the feedback places in no row", mutate: (i) => ({ ...i, findingKinds: [...i.findingKinds, "a_new_kind"] }), expect: 'the feedback places the lint kind "a_new_kind" in no row' },
    { name: "a lint kind in a row the feedback doesn't list", mutate: (i) => ({ ...i, profile: { ...i.profile, feedback: { ...i.profile.feedback!, kinds: { ...i.profile.feedback!.kinds, unresolved_identifier: "8" } } } }), expect: 'in the row "8", which feedback.rules doesn\'t list' },
  ],
});

/** What a spec's profile says it produces beyond its schemas, and what git tracks of it. */
export interface OptionalOutputsInput {
  spec: string;
  /** Whether the spec owns the root's `sdk/` tree, as the default spec does until the SDK trees are keyed by spec. */
  ownsSdkTree: boolean;
  sdk: boolean;
  feedback: boolean;
  /** The files git tracks under the spec's `feedback/`. */
  trackedFeedback: string[];
}

/** Why a spec's SDK or feedback gates may not be skipped: it has, or owns, outputs they check. */
export function optionalOutputProblems(i: OptionalOutputsInput): string[] {
  const problems: string[] = [];
  if (!i.sdk && i.ownsSdkTree) problems.push(`${i.spec}: the profile names no SDK packages, and the spec owns the SDK types under sdk/, which the SDK gates check; name the packages`);
  if (!i.feedback && i.trackedFeedback.length > 0) problems.push(`${i.spec}: the profile names no feedback target, and git tracks ${i.trackedFeedback.slice(0, 3).join(", ")}${i.trackedFeedback.length > 3 ? ", …" : ""}, which the feedback gates check; name the target, or remove the files`);
  return problems;
}

export const optionalOutputs = defineGate<OptionalOutputsInput>({
  id: "optional-outputs",
  title: "optional outputs: a spec whose profile names no SDK packages or no feedback target has no SDK types or report its gates would check",
  code: ["gates/input.ts#optionalOutputProblems"],
  check: (i) => ({
    problems: optionalOutputProblems(i),
    note: [i.sdk ? "SDK gates run" : "no SDK packages, so no SDK gate runs", i.feedback ? "feedback gates run" : "no feedback target, so no feedback gate runs"].join("; "),
  }),
  fixtures: [
    { name: "the default spec's profile with no SDK packages", mutate: (i) => ({ ...i, sdk: false }), expect: "the profile names no SDK packages, and the spec owns the SDK types under sdk/" },
    { name: "a profile with no feedback target and a committed report", mutate: (i) => ({ ...i, feedback: false }), expect: "the profile names no feedback target, and git tracks feedback/" },
    { name: "AdCOM's profile with a committed report", spec: "adcom", mutate: (i) => ({ ...i, trackedFeedback: ["feedback/comment.md"] }), expect: "git tracks feedback/comment.md" },
  ],
});
