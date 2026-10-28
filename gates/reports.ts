/** The gates on the reports: the lock comparison and the implementation feedback for the working group. */
import { buildLock, DEFAULT_LOCK_FILE, type BuildInput } from "../src/compare.ts";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { allDecisions, buildFeedback, checkFeedback, checkLineLinks, feedbackOf, foldedCodeSpans, recordCitations, renderDetails, type FeedbackInput } from "../src/feedback.ts";
import type { DecisionRecord } from "../src/mapping.ts";
import { snapshotOf } from "../src/fetch.ts";
import { repoRoot, type SpecLock } from "../src/lock.ts";
import type { MappingFile } from "../src/mapping.ts";
import { committedTreeCurrent, flipFirst, onlyGenerated, sameTreeRuns, type CommittedTreeInput, type TrackedInput, type TreeRunsInput } from "./common.ts";
import { defineGate, ROOT } from "./harness.ts";

export const recordWording = defineGate<{ decisions: DecisionRecord[]; names: Set<string> }>({
  id: "record-wording",
  title: "decision records: each question, chosen answer, and feedback is in the specification owners' terms, citing no document or record of this repository and no type the specification never writes",
  code: ["src/feedback.ts#recordCitations", "src/feedback.ts#internalTypeNames", "src/feedback.ts#internalTypeName", "src/feedback.ts#INTERNAL"],
  check: (i) => ({ problems: recordCitations(i.decisions, i.names), note: `${i.decisions.length} records` }),
  fixtures: [
    { name: "a feedback that cites a decision ID", mutate: (i) => ({ ...i, decisions: i.decisions.map((d, n) => (n === 0 ? { ...d, feedback: `${d.feedback ?? ""} See D-001.` } : d)) }), expect: 'cites "D-001", which the specification\'s owners don\'t have' },
    { name: "a question that names a type of the model", mutate: (i) => ({ ...i, names: new Set([...i.names, "WidgetSet"]), decisions: i.decisions.map((d, n) => (n === 0 ? { ...d, question: `${d.question} Is it a \`WidgetSet\`?` } : d)) }), expect: 'names the type "WidgetSet"' },
    { name: "a chosen answer that names this repository's process", mutate: (i) => ({ ...i, decisions: i.decisions.map((d, n) => (n === 0 ? { ...d, options: d.options.map((o) => (o.id === d.chosen ? { ...o, summary: "As this record quotes, the objects phase decides." } : o)) } : d)) }), expect: "its summary of the chosen option cites" },
    { name: "a feedback that names a document of this repository", mutate: (i) => ({ ...i, decisions: i.decisions.map((d, n) => (n === 0 ? { ...d, feedback: "As the type rules say." } : d)) }), expect: 'cites "type rules"' },
  ],
});

export const comparison = defineGate<{ locks: SpecLock[]; input: BuildInput }>({
  id: "comparison",
  title: "comparison: the pipeline runs clean on every lock, and each lock other than the default compares with it",
  code: ["src/compare.ts#buildLock"],
  check: async (i) => {
    const problems: string[] = [];
    const built: string[] = [];
    for (const lock of i.locks) {
      const r = await buildLock(lock, i.input);
      problems.push(...r.problems.map((p) => `${lock.name}: ${p}`));
      if (r.build) built.push(lock.file.split("/").pop()!);
    }
    if (!built.includes(DEFAULT_LOCK_FILE)) problems.push(`no default lock, spec-input/${DEFAULT_LOCK_FILE}, built`);
    const others = i.locks.filter((l) => l.file.split("/").pop() !== DEFAULT_LOCK_FILE).map((l) => l.name);
    const base = i.locks.find((l) => l.file.split("/").pop() === DEFAULT_LOCK_FILE)?.name;
    return { problems, note: `${others.join(", ")} against ${base}` };
  },
  fixtures: [
    {
      name: "a lock whose schemas don't emit",
      mutate: (i) => ({ ...i, input: { ...i.input, mappings: JSON.parse(JSON.stringify(i.input.mappings).replace(/"name":"Amount"/, '"name":"NoSuchType"')) as MappingFile[] } }),
      expect: "schemas: ",
    },
    { name: "no default lock", mutate: (i) => ({ ...i, locks: i.locks.filter((l) => l.file.split("/").pop() !== DEFAULT_LOCK_FILE) }), expect: "no default lock" },
  ],
});

export const comparisonDeterministic = defineGate<TreeRunsInput>({
  id: "comparison-deterministic",
  title: "deterministic comparison",
  code: ["gates/common.ts#sameTreeRuns"],
  check: sameTreeRuns,
  fixtures: [{ name: "a run writes the report differently", mutate: (i) => ({ ...i, runs: [i.runs[0]!, flipFirst(i.runs[1]!)] }), expect: "run 2: " }],
});

export const comparisonCommitted = defineGate<CommittedTreeInput>({
  id: "comparison-committed",
  title: (i) => `committed ${i.dir}/ current`,
  code: ["gates/common.ts#committedTreeCurrent"],
  check: committedTreeCurrent,
  fixtures: [{ name: "a committed report edited by hand", mutate: (i) => ({ ...i, committed: flipFirst(i.committed) }), expect: "differs" }],
});

export const comparisonTracked = defineGate<TrackedInput>({
  id: "comparison-tracked",
  title: "every tracked file under comparison/ is one the comparison writes",
  code: ["gates/common.ts#onlyGenerated"],
  check: onlyGenerated,
  fixtures: [{ name: "a hand-written report", mutate: (i) => ({ ...i, tracked: [...i.tracked, "comparison/notes.md"] }), expect: "comparison/notes.md" }],
});

export const feedback = defineGate<FeedbackInput>({
  id: "feedback",
  title: "feedback: the report places every decision, lint finding, example failure, undecided check, union, condition, and round-trip difference, in the working group's terms",
  code: ["src/feedback.ts#buildFeedback", "src/feedback.ts#checkFeedback", "src/feedback.ts#foldedCodeSpans", "src/feedback.ts#checkLineLinks", "src/feedback.ts#renderDetails", "src/fetch.ts#snapshotOf"],
  check: (i) => {
    const { doc, problems } = buildFeedback(i);
    const fb = feedbackOf(repoRoot(i.builds[0]!.lock));
    problems.push(...checkFeedback(doc, i.builds, fb));
    // The sources of the text the report shows: the decision records, the recorded findings, and the round-trip differences.
    for (const file of [...new Set([...i.decisions.map((d) => d.file), i.recordedFindings.file, i.recordedDifferences.file])]) problems.push(...foldedCodeSpans(relative(ROOT, file), readFileSync(file, "utf8")));
    // Each lint finding on the default lock links its lines in the specification its blob pins, which the snapshot holds.
    const base = i.builds[0]!.lock;
    const snapshot = snapshotOf(base);
    const lines = snapshot === null ? null : checkLineLinks(doc, renderDetails(doc, fb), readFileSync(join(repoRoot(base), snapshot, base.path), "utf8"));
    if (lines === null) problems.push(`${base.name} lists no snapshot, so the lint tables' line links can't be checked`);
    else problems.push(...lines.problems.map((p) => `details.md line links: ${p}`));
    const decisions = allDecisions(doc);
    return {
      problems,
      note: `${decisions.length} decisions: ${decisions.length - doc.departures.length} the text leaves open, in ${doc.groups.filter((g) => g.decisions.length > 0).length} groups, and ${doc.departures.length} changes we propose; ${doc.findings.reduce((n, r) => n + r.findings.length, 0)} open lint findings, ${lines?.linked ?? 0} of them linked to their lines on ${base.name} and ${lines?.unplaced ?? 0} about the whole document`,
    };
  },
  fixtures: [
    {
      name: "a decision's feedback that cites a decision ID",
      mutate: (i) => ({ ...i, decisions: i.decisions.map((d) => (d.id === "D-036" ? { ...d, feedback: `${d.feedback ?? ""} See D-001.` } : d)) }),
      expect: 'cites "D-001", which the working group doesn\'t have',
    },
    {
      name: "a decision's feedback that cites a repository path",
      mutate: (i) => ({ ...i, decisions: i.decisions.map((d) => (d.id === "D-036" ? { ...d, feedback: `${d.feedback ?? ""} As mapping/commercial.yaml writes it.` } : d)) }),
      expect: 'cites "mapping/commercial.yaml"',
    },
    {
      name: "a decision's feedback that cites a task or a gate decision",
      mutate: (i) => ({ ...i, decisions: i.decisions.map((d) => (d.id === "D-036" ? { ...d, feedback: `${d.feedback ?? ""} Tracked as ops-c4g.23 and G-002.` } : d)) }),
      expect: 'cites "ops-c4g.23"',
    },
    {
      name: "what the schemas do, said in the pipeline's terms",
      mutate: (i) => ({ ...i, decisions: i.decisions.map((d) => (d.id === "D-008" ? { ...d, options: d.options.map((o) => (o.id === d.chosen ? { ...o, summary: "The constructor takes the bare value's type as an optional parameter `B`." } : o)) } : d)) }),
      expect: /details\.md line \d+ cites "constructor takes the bare value's type as an optional parameter"/,
    },
    {
      name: "what the schemas do, said with a kernel type's name, as a review found",
      mutate: (i) => ({ ...i, decisions: i.decisions.map((d) => (d.id === "D-007" ? { ...d, options: d.options.map((o) => (o.id === d.chosen ? { ...o, summary: "Yes. Each entry names an option, as an `ExternalId`." } : o)) } : d)) }),
      expect: /details\.md line \d+ names the type "ExternalId", which the specification never writes/,
    },
    {
      name: "what the schemas do, said with a part's name outside a code span",
      mutate: (i) => ({ ...i, decisions: i.decisions.map((d) => (d.id === "D-019" ? { ...d, options: d.options.map((o) => (o.id === d.chosen ? { ...o, summary: "A daypart option is a DaypartWindow." } : o)) } : d)) }),
      expect: /details\.md line \d+ names the type "DaypartWindow", which the specification never writes/,
    },
    {
      name: "a question that names a kernel type",
      mutate: (i) => ({ ...i, decisions: i.decisions.map((d) => (d.id === "D-023" ? { ...d, question: "Which kernel type expresses each element?" } : d)) }),
      expect: 'cites "kernel type"',
    },
    {
      name: "a recorded finding's reason that cites the type rules",
      mutate: (i) => ({ ...i, recordedFindings: { ...i.recordedFindings, findings: i.recordedFindings.findings.map((f, n) => (n === 0 ? { ...f, reason: `${f.reason} See type rules § 3a.` } : f)) } }),
      expect: 'cites "type rules"',
    },
    {
      name: "two findings at one place in one table that give different reasons",
      mutate: (i) => ({ ...i, recordedFindings: { ...i.recordedFindings, findings: i.recordedFindings.findings.map((f) => (f.example === "examples/line-item-display.yaml" && f.path === "/reporting/included/0" && f.kind === "rule" ? { ...f, reason: `${f.reason} We propose it for every option.` } : f)) } }),
      expect: "examples/line-item-display.yaml /reporting/included/0: 2 findings at the place give different reasons in one table (follow)",
    },
    {
      name: "a MUST statement that names no field, which no rule, obligation, or schema checks",
      mutate: (i) => ({ ...i, builds: i.builds.map((b) => ({ ...b, model: { ...b.model, obligations: b.model.obligations.filter((o) => o.ir !== "rule:2.1:2f9d603c") } })) }),
      expect: "main: the MUST statement rule:2.1:2f9d603c is no rule, obligation, or schema statement of the model",
    },
    {
      name: "a recorded reason that folds a code span across a line break, as a review found",
      mutate: (i) => ({ ...i, recordedFindings: { ...i.recordedFindings, file: `${ROOT}/gates/data/feedback/folded-span.yaml` } }),
      expect: 'gates/data/feedback/folded-span.yaml line 11: a code span in "reason" runs onto the next line',
    },
    {
      name: "a recorded reason that folds a double-backtick code span across a line break, as a review found",
      mutate: (i) => ({ ...i, recordedFindings: { ...i.recordedFindings, file: `${ROOT}/gates/data/feedback/folded-double-span.yaml` } }),
      expect: 'gates/data/feedback/folded-double-span.yaml line 11: a code span in "reason" runs onto the next line',
    },
    {
      name: "a recorded reason that names the pipeline's model, as a review found",
      mutate: (i) => ({ ...i, recordedFindings: { ...i.recordedFindings, findings: i.recordedFindings.findings.map((f, n) => (n === 0 ? { ...f, reason: `${f.reason} So the model leaves it open.` } : f)) } }),
      expect: 'cites "the model"',
    },
    {
      name: "what the schemas do, said with a constructor's copy and a profile, as a review found",
      mutate: (i) => ({ ...i, decisions: i.decisions.map((d) => (d.id === "D-028" ? { ...d, options: d.options.map((o) => (o.id === d.chosen ? { ...o, summary: "The summary is a profile of each document, and its formats a selectable copy." } : o)) } : d)) }),
      expect: /details\.md line \d+ cites "a profile of"/,
    },
    {
      name: "a recorded reason that names the generated model, which the model pattern missed, as a review found",
      mutate: (i) => ({ ...i, recordedFindings: { ...i.recordedFindings, findings: i.recordedFindings.findings.map((f, n) => (n === 0 ? { ...f, reason: `${f.reason} The example follows what our generated schema checks, not what the generated model holds.` } : f)) } }),
      expect: 'cites "the generated model"',
    },
    {
      name: "a decision's feedback that names the pipeline's model",
      mutate: (i) => ({ ...i, decisions: i.decisions.map((d) => (d.id === "D-036" ? { ...d, feedback: `${d.feedback ?? ""} As the pipeline's model writes it.` } : d)) }),
      expect: 'cites "the pipeline\'s model"',
    },
    {
      name: "what the schemas do, said with a template copy, as plain English around it doesn't hide",
      mutate: (i) => ({ ...i, decisions: i.decisions.map((d) => (d.id === "D-028" ? { ...d, options: d.options.map((o) => (o.id === d.chosen ? { ...o, summary: "Keep a copy of the proposal; the summary's formats are a template copy." } : o)) } : d)) }),
      expect: /details\.md line \d+ cites "template copy"/,
    },
    {
      name: "an undecided check with no recorded reason",
      mutate: (i) => ({ ...i, recordedFindings: { ...i.recordedFindings, undecided: [] } }),
      expect: "leaves rule:5.2:f3d3f9e8 undecided with no recorded reason",
    },
    {
      name: "a lint finding on the default lock placed past the end of the specification",
      mutate: (i) => ({ ...i, builds: i.builds.map((b, n) => (n === 0 ? { ...b, lint: b.lint.map((f) => (f.id === "unresolved_identifier:deal_id" ? { ...f, locs: f.locs.map((l) => ({ ...l, line: 99999 })) } : f)) } : b)) }),
      expect: "details.md line links: unresolved_identifier:deal_id: line 99999 is past the end of the specification",
    },
    {
      name: "a lint finding on the default lock whose line is in another section than the link names",
      mutate: (i) => ({ ...i, builds: i.builds.map((b, n) => (n === 0 ? { ...b, lint: b.lint.map((f) => (f.id === "option_shape_missing:field:5.4:formats" ? { ...f, locs: f.locs.map((l) => ({ ...l, line: 49 })) } : f)) } : b)) }),
      expect: "details.md line links: option_shape_missing:field:5.4:formats: line 49 is in § 1.1, not § 5.4, which the link names",
    },
    {
      name: "a default lock whose commit isn't a full SHA, so its line links aren't permalinks",
      mutate: (i) => ({ ...i, builds: i.builds.map((b, n) => (n === 0 ? { ...b, lock: { ...b.lock, commit: "main" } } : b)) }),
      expect: 'details.md line links: the `main` lock\'s commit "main" isn\'t a full 40-character SHA',
    },
    {
      name: "a decision whose list item has no blank line before it, so YAML folds it into the line above",
      mutate: (i) => ({ ...i, decisions: i.decisions.map((d) => (d.id === "D-019" ? { ...d, file: `${ROOT}/gates/data/feedback/folded-item.yaml` } : d)) }),
      expect: 'gates/data/feedback/folded-item.yaml line 4: a list item in "feedback" has no blank line before it',
    },
    {
      name: "an undecided check's reason that cites a decision ID",
      mutate: (i) => ({ ...i, recordedFindings: { ...i.recordedFindings, undecided: (i.recordedFindings.undecided ?? []).map((u) => ({ ...u, reason: `${u.reason} See D-035.` })) } }),
      expect: 'cites "D-035"',
    },
  ],
});

export const feedbackDeterministic = defineGate<TreeRunsInput>({
  id: "feedback-deterministic",
  title: "deterministic feedback",
  code: ["gates/common.ts#sameTreeRuns"],
  check: sameTreeRuns,
  fixtures: [{ name: "a run writes the report differently", mutate: (i) => ({ ...i, runs: [flipFirst(i.runs[0]!), i.runs[1]!] }), expect: "run 1: " }],
});

export const feedbackCommitted = defineGate<CommittedTreeInput>({
  id: "feedback-committed",
  title: (i) => `committed ${i.dir}/ current`,
  code: ["gates/common.ts#committedTreeCurrent"],
  check: committedTreeCurrent,
  fixtures: [{ name: "a committed comment edited by hand", mutate: (i) => ({ ...i, committed: flipFirst(i.committed) }), expect: "differs" }],
});

export const feedbackTracked = defineGate<TrackedInput>({
  id: "feedback-tracked",
  title: "every tracked file under feedback/ is one the report writes",
  code: ["gates/common.ts#onlyGenerated"],
  check: onlyGenerated,
  fixtures: [{ name: "a hand-written note", mutate: (i) => ({ ...i, tracked: [...i.tracked, "feedback/draft.md"] }), expect: "feedback/draft.md" }],
});
