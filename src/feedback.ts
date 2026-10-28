/**
 * The implementation feedback: the decision records and the findings,
 * grouped for the working group, as a follow-up on the issue the spec's
 * profile names (`feedback.issue`).
 *
 * `npm run feedback` runs the pipeline on every lock, from its committed IR
 * and findings, as the lock comparison does (src/compare.ts), and writes
 * three files to `feedback/`:
 *
 * - `feedback.json`, the report as canonical JSON, every list sorted;
 * - `comment.md`, the comment to post on the issue: the decisions the text
 *   leaves open, by group, and the changes we propose, apart; the example
 *   failures, split the same way; and the lint findings by the issue's
 *   authoring rules, as counts;
 * - `details.md`, the body of the gist the comment links: every decision,
 *   every open lint finding, every example failure, every untagged union
 *   (type rules § 8), every condition a schema can't state, and every
 *   round-trip difference.
 *
 * Both markdown files are functions of the JSON form, which is a function of
 * the records and the pipeline's outputs on every lock. Nothing is chosen
 * here that the records don't state, except two fixed classifications and
 * one fixed list:
 *
 * - A decision's group is the first stage of the pipeline that cites it: a
 *   kernel primitive, a constructor, a mapping entry or declaration that
 *   types an element, a mapping entry that places a statement, or a rule's
 *   vectors.
 * - A lint finding's authoring rule follows from its kind: the seven rules
 *   that #121 proposes, plus the MUST statements that name no field, which
 *   no authoring rule removes, since each needs conformance test vectors or
 *   binds a party, and the rest.
 * - The open PRs that we posted, the profile's `feedback.prs`, which the inputs name.
 *
 * The text for the working group names a decision by its number, 1 to N in
 * reading order, never by its record's ID.
 *
 * The files are drafts: someone reviews them before they are posted, and
 * replaces the details link with the gist's URL.
 */
import { isScalar, LineCounter, parseDocument, Scalar, visit } from "yaml";
import { canonicalJson } from "./canonical.ts";
import type { LockBuild } from "./compare.ts";
import { slots, type Constructors } from "./constructors.ts";
import type { FindingsFile } from "./examples.ts";
import type { Kernel } from "./kernel.ts";
import { decisionsOf, inScope, type DecisionRecord, type MappingFile, type Target, type TypeRef } from "./mapping.ts";
import type { DifferencesFile } from "./render.ts";
import type { ModelType } from "./model.ts";
import { citedDecisions } from "./release.ts";
import type { VectorFile } from "./rules.ts";
import type { FeedbackProfile } from "./profile.ts";
import { specOf } from "./specs/index.ts";
import { repoRoot } from "./lock.ts";

/** Where the report lives. */
export const FEEDBACK_DIR = "feedback";
export const FEEDBACK_FILES = { data: "feedback.json", comment: "comment.md", details: "details.md" } as const;
/** Stands for the details gist's URL, which exists only once the gist is posted. */
export const DETAILS_LINK = "<details-gist-url>";

/** A group of decisions, which the pipeline's stages give (`groupDecisions`), and the profile titles. */
export type GroupId = FeedbackProfile["groups"][number]["id"];
/** A row of findings: an authoring rule the issue proposes, or a row for the findings they don't cover. */
export type RuleId = string;

/** A spec's feedback target and layout, from its profile. Throws when the profile gives none. */
export function feedbackOf(spec: string): FeedbackProfile {
  const { profile } = specOf(spec);
  if (!profile.feedback) throw new Error(`${profile.file}: gives no feedback target`);
  return profile.feedback;
}

/**
 * Text addressed to the working group can't cite this repository's own
 * documents, paths, or records, such as a decision ID, a gate decision, or a
 * task, nor name the pipeline's parts, such as the mapping, the model, a
 * kernel type, a constructor's parameter or copy, or a profile: the working
 * group has none of them. A path under `examples/` is the specification's
 * own. "Copy" is internal only in the constructor sense, a selectable,
 * settable, ordered, constructor, or template copy, or a copy of a
 * constructor or template, and "profile" only as a summary profile, "a
 * profile of", or "is a profile": "copies" as a verb, as § 5.2.2 copies an
 * AdCOM list, a copy of a license or a proposal, and an audience profile or
 * a Web Bot Auth profile are plain English. "Model" is internal as the
 * model, our model, or the generated or the pipeline's model, but not as
 * the object model or a data model.
 */
export const INTERNAL =
  /type rules|initial (?:conventions|design)|\bD-\d+\b|\bG-\d+\b|\bops-[a-z0-9]+(?:\.[0-9]+)*\b|npm run|(?<![\w./-])(?:kernel|mapping|src|gates|decisions|vectors|rules|corpus|schemas|sdk|ir|tools|scripts|test|docs|build)\/[\w-][\w./-]*|\bthe mapping\b|\b(?:the|our)\s+(?:generated\s+|pipeline['’]s\s+)?models?\b|\b(?:generated|pipeline['’]s)\s+models?\b|\bkernel types?\b|\bconstructor\b[^.;]*\bparameter\b|\b(?:selectable|settable|ordered|constructor|template)\s+cop(?:y|ies)\b|\bcop(?:y|ies)\s+of\s+(?:a|the|each|one)\s+(?:constructor|template)s?\b|\bsummary\s+profiles?\b|\ba\s+profile\s+of\b|\b(?:is|as)\s+a\s+profile\b(?!\s+of\b)|\bobjects phase\b|\bthis record\b/i;

/** The fields of the records whose text the report shows the working group: a question, a feedback, an option's summary, and a finding's or a difference's reason. */
const SHOWN_FIELDS = new Set(["question", "feedback", "summary", "reason"]);

/**
 * Each code span in a shown field of a YAML source that a line break folds:
 * YAML folds the break into a space the author didn't write, so
 * "`smb-decision-` / `makers@3`" on two lines reads as one span with a space
 * in it. A code span in text for the working group is written on one line.
 * Spans are read as CommonMark reads them, by runs of backticks, so a
 * double-backtick span that holds a backtick is one span, and a run that no
 * run of as many backticks closes, which shows as literal backticks, fails
 * too.
 */
export function foldedCodeSpans(file: string, text: string): string[] {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { version: "1.2", schema: "core", lineCounter });
  const problems: string[] = [];
  visit(doc, {
    Pair(_, pair) {
      if (!isScalar(pair.key) || !SHOWN_FIELDS.has(String(pair.key.value)) || !isScalar(pair.value) || !pair.value.range) return;
      const v = pair.value;
      if (v.type === Scalar.BLOCK_LITERAL) return;
      const start = v.range![0];
      const lines = text.slice(start, v.range![1]).split("\n");
      const first = v.type === Scalar.BLOCK_FOLDED ? 1 : 0;
      // A list item in a folded block is a paragraph that starts with "- ", so a blank line comes before it; without one,
      // YAML folds the item into the line above.
      if (v.type === Scalar.BLOCK_FOLDED)
        for (let i = first + 1; i < lines.length; i++)
          if (/^\s*- /.test(lines[i]!) && lines[i - 1]!.trim() !== "") {
            const line = lineCounter.linePos(start).line + i;
            problems.push(`${file} line ${line}: a list item in "${String(pair.key.value)}" has no blank line before it, so YAML folds it into the line above; put a blank line before it`);
          }
      // Code spans as CommonMark reads them: a run of backticks opens a span that the next run of as many backticks closes,
      // so "`` ` ``" is one span with a backtick in it. A run that no such run closes is literal backticks.
      const body = lines.slice(first).join("\n");
      const lineOf = (at: number) => lineCounter.linePos(start).line + first + (body.slice(0, at).match(/\n/g) ?? []).length;
      const runs = [...body.matchAll(/`+/g)].flatMap((m) => {
        // A backslash escapes the first backtick of a run outside a span.
        const escaped = ((/\\*$/.exec(body.slice(0, m.index)) ?? [""])[0].length) % 2 === 1;
        return escaped ? (m[0].length > 1 ? [{ at: m.index + 1, length: m[0].length - 1 }] : []) : [{ at: m.index, length: m[0].length }];
      });
      for (let i = 0; i < runs.length; i++) {
        const open = runs[i]!;
        const j = runs.findIndex((r, k) => k > i && r.length === open.length);
        if (j < 0) {
          problems.push(`${file} line ${lineOf(open.at)}: a run of ${open.length} backtick${open.length === 1 ? "" : "s"} in "${String(pair.key.value)}" opens no code span, since no run of as many closes it, so it shows as literal backticks; close the span on its line, or remove the run`);
          continue;
        }
        // A span closes inside the scalar; one that closes on a later line has a line break in it, which YAML folds.
        if (lineOf(open.at) !== lineOf(runs[j]!.at)) problems.push(`${file} line ${lineOf(open.at)}: a code span in "${String(pair.key.value)}" runs onto the next line, so YAML folds the break into a space inside it; write the span on one line`);
        i = j;
      }
    },
  });
  return problems;
}

// ---------------------------------------------------------------------------
// The report

export interface LockSide {
  name: string;
  /** How the report names the lock to the working group, as a column heading. */
  label: string;
  /** The same, inside a sentence: "on `main`", "with the open PRs". */
  phrase: string;
  commit: string;
  blob: string;
  /** The repository the specification is in, and the specification's path there, from which a line's permalink is built. */
  upstream: string;
  path: string;
  /** The upstream PRs merged into `main`, in merge order; empty for `main` itself. */
  prs: number[];
  /** Each merged PR's head commit, in merge order. */
  heads: { pr: number; head: string }[];
  /** The day on which each of `heads` was its PR's live head; absent for a lock that merges nothing. */
  heads_on?: string;
  /** What the integration changed outside the PRs, beside resolving their conflicts, as clauses. */
  edits: string[];
  /** Those of `prs` that we posted (the profile's `feedback.prs`), in merge order. */
  ours: number[];
  /** The branches merged beside the PRs that aren't upstream PRs. */
  branches: number;
}

export interface DecisionItem {
  id: string;
  /** `gap`: the text leaves the point open. `departure`: we propose a change to what the text or its examples settle. */
  kind: DecisionRecord["kind"];
  /** Its number in reading order, from 1, by which the text for the working group names it instead of its ID. */
  number: number;
  question: string;
  /** What the specification should state; absent where the decision asks for no change. */
  feedback?: string;
  /** The chosen option: what the generated schema does until the specification says. */
  reading: string;
  status: DecisionRecord["status"];
  issue?: string;
  /** The locks whose model or rules cite it. */
  locks: string[];
  /** The IR elements it covers on those locks, in specification order. */
  rests_on: string[];
}

export interface LintItem {
  id: string;
  kind: string;
  /** The sections the finding points to, on any lock; empty for a finding about the whole document. */
  sections: string[];
  /**
   * The finding's message on each lock that has it, in lock order, with the
   * sections it points to there, and, for a MUST statement that names no
   * field or key, how the generated outputs check it there: `rule`, a rule
   * on payloads with test vectors; `schema`, the schemas, which the
   * conformance corpus tests; or the party an obligation binds.
   */
  messages: { lock: string; message: string; sections: string[]; lines: { section: string; line: number }[]; checked?: string }[];
}

export interface ExampleItem {
  example: string;
  kind: string;
  /** The locations, JSON pointers into the example, sorted. */
  paths: string[];
  locks: string[];
  /** The decisions that cause the failure, one per cause. */
  decisions: string[];
  /** The kinds of its causes: `gap` where the example disagrees with the text, `departure` where it follows the text but not a change we propose. */
  causes: DecisionRecord["kind"][];
  /** `warning` for a SHOULD rule's failure, which an implementation may depart from with a reason, and `error` otherwise. */
  severity: "error" | "warning";
  reason: string;
}

/** A rule a generated check can't decide on an example, because the example leaves out what decides it. */
export interface UndecidedItem {
  example: string;
  path: string;
  /** The rule's statement, as the specification writes it. */
  rule: string;
  locks: string[];
  decisions: string[];
  reason: string;
}

export interface UnionItem {
  name: string;
  /** The named types a value may be. */
  branches: string[];
  /** Each form a value may take, in the specification's terms, in the order of `branches`, on the locks that give the union those forms. */
  forms: { locks: string[]; forms: string[] }[];
  /** The IR elements the union rests on: its own, or its constructor's. */
  sources: string[];
  decisions: string[];
  locks: string[];
}

export interface DifferenceItem {
  table: string;
  row: string;
  column: string;
  spec: string;
  model: string;
  locks: string[];
  decision: string;
  reason: string;
}

export interface FeedbackDoc {
  format: 1;
  issue: string;
  /** The default lock first, then the others by name. */
  locks: LockSide[];
  /** The decisions the text leaves open, by group. */
  groups: { id: GroupId; title: string; asks: string; decisions: DecisionItem[] }[];
  /** The changes we propose to what the text or its examples settle. */
  departures: DecisionItem[];
  findings: { rule: RuleId; title: string; findings: LintItem[] }[];
  /** Per lock, the lint findings with a verdict, which aren't feedback: names of other standards, deliberate references, and false positives. */
  set_aside: Record<string, number>;
  examples: ExampleItem[];
  undecided: UndecidedItem[];
  unions: UnionItem[];
  conditions: { text: string; locks: string[] }[];
  round_trip: DifferenceItem[];
}

export interface FeedbackInput {
  /** The default lock's build first, then the others. */
  builds: LockBuild[];
  decisions: DecisionRecord[];
  mappings: MappingFile[];
  kernel: Kernel;
  constructors: Constructors;
  vectors: VectorFile[];
  recordedFindings: FindingsFile;
  recordedDifferences: DifferencesFile;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Orders sections as the specification numbers them: `5.6.1` after `5.6`, `10` after `9`. */
export function compareSections(a: string, b: string): number {
  const parts = (s: string) => s.split("/")[0]!.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : Number.POSITIVE_INFINITY));
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [p, q] = [x[i] ?? -1, y[i] ?? -1];
    if (p !== q) return p - q;
  }
  return cmp(a, b);
}

/** An IR element's section, such as `5.4` for `field:5.4:formats` or `5.4/creative-inspection-and-previews`. */
export const sectionOf = (id: string): string => id.split(":")[1] ?? "";

const bySpecOrder = (a: string, b: string) => compareSections(sectionOf(a), sectionOf(b)) || cmp(a, b);

/** Every decision ID a value cites under a `decision` key or in a `decisions` list. */
function decisionIds(x: unknown, key: string | null = null, out = new Set<string>()): Set<string> {
  if (Array.isArray(x)) for (const v of x) decisionIds(v, key === "decisions" ? "decision" : null, out);
  else if (x !== null && typeof x === "object") for (const [k, v] of Object.entries(x)) decisionIds(v, k, out);
  else if (typeof x === "string" && key === "decision") out.add(x);
  return out;
}

const TYPE_ROLES = new Set<Target["role"]>(["property", "type", "members", "same", "term", "profile"]);

/** The group of each decision: the first stage of the pipeline that cites it. */
export function groupDecisions(input: Pick<FeedbackInput, "kernel" | "constructors" | "mappings" | "vectors">): Map<string, GroupId> {
  const typed = new Set<string>();
  const placed = new Set<string>();
  for (const m of input.mappings) {
    for (const e of m.entries) for (const d of decisionsOf(e.source)) (TYPE_ROLES.has(e.as.role) ? typed : placed).add(d);
    for (const t of m.types ?? []) for (const d of decisionsOf(t.source)) typed.add(d);
  }
  // A part no constructor's shell holds is a value of its own, such as a daypart window, so its decisions are value formats.
  const names = (x: TypeRef): string[] => (x.kind === "named" ? [x.name] : x.kind === "apply" ? Object.values(x.arguments).flatMap(names) : []);
  const shellParts = new Set(input.constructors.constructors.flatMap((c) => slots(c.shell).flatMap((s) => names(s.$model))));
  const valueParts = input.constructors.parts.filter((p) => !shellParts.has(p.name));
  const stages: [GroupId, Set<string>][] = [
    ["formats", decisionIds([input.kernel.primitives, valueParts])],
    ["options", decisionIds([input.constructors.constructors, input.constructors.parts])],
    ["types", typed],
    ["statements", placed],
    ["readings", decisionIds(input.vectors.map((v) => v.rules))],
  ];
  const out = new Map<string, GroupId>();
  for (const [group, ids] of stages) for (const id of ids) if (!out.has(id)) out.set(id, group);
  return out;
}

function lockSide(b: LockBuild, ourPrs: readonly number[]): LockSide {
  const order = (b.lock.merge_order ?? []) as { pr?: number; head?: string; branch?: string }[];
  const prs = order.flatMap((o) => (typeof o.pr === "number" ? [o.pr] : []));
  return {
    name: b.lock.name,
    label: b.lock.merge_order === null ? `\`${b.lock.name}\`` : "With the open PRs",
    phrase: b.lock.merge_order === null ? `on \`${b.lock.name}\`` : "with the open PRs",
    commit: b.lock.commit,
    blob: b.lock.blob,
    upstream: b.lock.upstream,
    path: b.lock.path,
    prs,
    heads: order.flatMap((o) => (typeof o.pr === "number" && typeof o.head === "string" ? [{ pr: o.pr, head: o.head }] : [])),
    ...(b.lock.heads_on !== null ? { heads_on: b.lock.heads_on } : {}),
    edits: b.lock.edits,
    ours: prs.filter((n) => ourPrs.includes(n)),
    branches: order.length - prs.length,
  };
}

/** A description's first clause, as "a point in time" of "A point in time, written as …". */
const firstClause = (text: string) => {
  const clause = text.split(/[.,;:](?:\s|$)/)[0]!.trim();
  return clause.charAt(0).toLowerCase() + clause.slice(1);
};

/**
 * A form a union's value may take, in the specification's terms rather than
 * the model's names: an object as the members the text writes for it, a
 * primitive or a part by the first clause of its description, and a copy of
 * a template by the § 3 structure its marker names, or by its template's
 * description.
 */
function formOf(t: ModelType | undefined, constructors: Map<string, ModelType>, inline: Map<string, string>): string {
  if (t === undefined) return "a value of a type the model doesn't define";
  switch (t.kind) {
    case "object":
    case "document":
    case "profile": {
      // A projection holds only the members its paths name, not the object the text writes.
      const written = t.kind === "object" && t.projects !== undefined ? undefined : t.sources.map((x) => inline.get(x)).find((x) => x !== undefined);
      const members = Object.keys("properties" in t ? t.properties : {});
      return written !== undefined ? `\`${written}\`` : members.length > 0 ? `an object of \`{ ${members.join(", ")} }\`` : "an object whose members the text doesn't name";
    }
    case "primitive":
    case "part":
    case "constructor":
      return firstClause(t.description);
    case "copy": {
      const c = constructors.get(t.of.constructor);
      const marker = c?.sources.map((x) => /^marker:[^:]+:(.+)$/.exec(x)?.[1]).find((x) => x !== undefined);
      const section = c?.sources.map((x) => /^(?:key|rule):([0-9.]+):/.exec(x)?.[1]).find((x) => x !== undefined);
      if (marker !== undefined) return `the \`${marker}\` structure${section !== undefined ? ` of § ${section}` : ""}`;
      return c?.kind === "constructor" ? firstClause(c.description) : "a value of a template";
    }
    case "vocabulary":
      return "a term of a value list";
    case "union":
      return "one of several forms";
  }
}

/**
 * The model's type names that the working group's text can't use, because
 * the specification never writes them: every type of every build, but those
 * the specification itself writes as a type, in a Type cell, or in a code
 * span, such as `Timestamp` and AdCOM's `Placement`.
 */
export function internalTypeNames(builds: Pick<LockBuild, "model" | "ir">[]): Set<string> {
  const written = new Set<string>();
  for (const b of builds) {
    for (const f of b.ir.fields) for (const w of f.type.raw.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) written.add(w);
    for (const c of b.ir.code_spans) for (const w of c.value.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) written.add(w);
    // An object a heading names, as AdCOM's `Object: Content`, and every key path a table writes, are names the text writes.
    for (const tb of b.ir.tables) if (tb.parent?.identifier) for (const w of tb.parent.identifier.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) written.add(w);
    for (const k of b.ir.keys) for (const w of k.key.path.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) written.add(w);
  }
  return new Set(builds.flatMap((b) => b.model.types.map((t) => t.name)).filter((n) => !written.has(n)));
}

/** The first model type name a line names: in a code span, any of them; outside one, a name of two or more words, such as `GeoBounds`. */
export function internalTypeName(line: string, names: ReadonlySet<string>): string | null {
  for (const span of line.matchAll(/`([^`]+)`/g)) for (const w of span[1]!.match(/[A-Za-z][A-Za-z0-9]*/g) ?? []) if (names.has(w)) return w;
  for (const w of line.replace(/`[^`]*`/g, " ").match(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g) ?? []) if (names.has(w)) return w;
  return null;
}

/** How a lock's outputs check a statement: a rule on payloads, the schemas, or the party an obligation binds. */
function checkedAs(b: LockBuild, ir: string): string | undefined {
  if (b.model.rules.some((x) => x.ir === ir)) return "rule";
  const o = b.model.obligations.find((x) => x.ir === ir);
  if (o !== undefined) return o.party;
  if (b.model.schema_statements.some((x) => x.ir === ir) || b.model.types.some((t) => t.sources.includes(ir))) return "schema";
  return undefined;
}

/**
 * A lint message as the working group reads it. An unnumbered heading's ID,
 * such as `5.4/creative-inspection-and-previews`, becomes its numbered
 * section and its heading, `5.4, under "Creative inspection and previews"`.
 * A value set whose values the specification names, as § 5.2.2 writes
 * `0` (no) | `1` (yes), is written with those names.
 */
export function messageInTerms(f: Pick<LockBuild["lint"][number], "kind" | "message" | "subjects" | "details">, ir: LockBuild["ir"]): string {
  let message = f.message.replace(/§ ([0-9.]+)\/([a-z0-9-]+)( ?)/g, (all, num: string, slug: string, space: string) => {
    const s = ir.sections.find((x) => x.id === `${num}/${slug}`);
    return s === undefined ? all : `§ ${num}, under "${s.title}"${space !== "" ? ", " : ""}`;
  });
  const values = (f.details as { values?: unknown } | undefined)?.values;
  if (f.kind.startsWith("value_set_") && Array.isArray(values)) {
    const list = ir.value_lists.find((v) => v.id === f.subjects[0]);
    const named = list !== undefined && list.items.length === values.length && list.items.every((i, n) => i.value === values[n] && typeof i.annotation === "string" && i.annotation !== "");
    if (named) message = message.replace(`The value set ${values.join(" | ")} `, `The value set ${list.items.map((i) => `${code(i.value)} (${i.annotation})`).join(" | ")} `);
  }
  return message;
}

/**
 * A condition a schema can't state, named by the field or key the
 * specification writes, as `placement.plcmt`, rather than by the generated
 * type that holds it.
 */
function conditionInTerms(text: string, model: LockBuild["model"]): string {
  const m = /^([A-Za-z][A-Za-z0-9]*)\.([A-Za-z0-9_]+): /.exec(text);
  if (m === null) return text;
  const t = model.types.find((x) => x.name === m[1]);
  const property = t !== undefined && "properties" in t ? (t.properties as Record<string, { sources?: string[] }>)[m[2]!] : undefined;
  const source = property?.sources?.find((x) => /^(?:field|key):/.test(x));
  if (source === undefined) return text;
  return `${code(source.split(":").slice(2).join(":").split("#")[0]!)}: ${text.slice(m[0].length)}`;
}

/** Builds the report. A problem is something the report can't be generated without: the doc is then incomplete. */
export function buildFeedback(input: FeedbackInput): { doc: FeedbackDoc; problems: string[] } {
  const problems: string[] = [];
  const { builds } = input;
  // The report follows up on the issue the specification's profile names, the spec of the default lock.
  const fb = feedbackOf(repoRoot(builds[0]!.lock));
  const locks = builds.map((b) => lockSide(b, fb.prs));
  const lockNames = locks.map((l) => l.name);
  const lockOrder = (xs: Iterable<string>) => [...new Set(xs)].sort((a, b) => lockNames.indexOf(a) - lockNames.indexOf(b));
  if (new Set(locks.map((l) => l.label)).size !== locks.length) problems.push(`two locks get one label: ${locks.map((l) => l.label).join(", ")}`);

  const internal = (where: string, text: string | undefined) => {
    const m = text === undefined ? null : INTERNAL.exec(text);
    if (m) problems.push(`${where} cites "${m[0]}", which the working group doesn't have; say it in the specification's terms`);
  };

  // The decisions, by group.
  // A decision is cited on a lock by its model or rules, or by the recorded finding of an example failure there.
  const cited = new Map<string, string[]>();
  const cite = (id: string, lock: string) => cited.set(id, [...new Set([...(cited.get(id) ?? []), lock])]);
  for (const b of builds) {
    for (const id of citedDecisions(b.model, b.rules)) cite(id, b.lock.name);
    for (const f of b.failures) {
      const r = input.recordedFindings.findings.find((x) => inScope(x.locks, b.lock.name) && x.example === f.example && x.path === f.path && x.kind === f.kind && x.rule === f.rule);
      for (const id of r?.decisions ?? []) cite(id, b.lock.name);
    }
  }
  const groupOf = groupDecisions(input);
  const items = new Map<GroupId, DecisionItem[]>(fb.groups.map((g) => [g.id, []]));
  const departures: DecisionItem[] = [];
  const records = new Map(input.decisions.map((d) => [d.id, d]));
  for (const id of [...cited.keys()].sort()) if (!records.has(id)) problems.push(`the model cites ${id}, which has no decision record`);
  for (const d of [...input.decisions].sort((a, b) => cmp(a.id, b.id))) {
    if (d.status === "superseded") continue;
    const on = lockOrder(cited.get(d.id) ?? []);
    const group = groupOf.get(d.id);
    if (on.length === 0 || (group === undefined && d.kind === "gap")) {
      problems.push(`${d.id}: no lock's model or rules cite it, so the report has no place for it; supersede it, or cite it`);
      continue;
    }
    internal(`${d.id}'s feedback`, d.feedback);
    const reading = d.options.find((o) => o.id === d.chosen)?.summary;
    if (reading === undefined) problems.push(`${d.id}: chosen option "${d.chosen}" isn't one of its options`);
    const rests = new Set(d.covers.filter((c) => on.some((l) => inScope(c.locks, l))).map((c) => c.ir));
    (d.kind === "departure" ? departures : items.get(group!)!).push({
      id: d.id,
      kind: d.kind,
      number: 0,
      question: d.question,
      ...(d.feedback !== undefined ? { feedback: d.feedback } : {}),
      reading: reading ?? "",
      status: d.status,
      ...(d.issue !== undefined ? { issue: d.issue } : {}),
      locks: on,
      rests_on: [...rests].sort(bySpecOrder),
    });
  }
  const groups = fb.groups.map((g) => ({ id: g.id, title: g.title, asks: g.asks, decisions: items.get(g.id)! }));
  [...groups.flatMap((g) => g.decisions), ...departures].forEach((d, i) => (d.number = i + 1));
  const listed = new Set([...groups.flatMap((g) => g.decisions), ...departures].map((d) => d.id));
  for (const id of suggestionDecisions(fb)) if (!listed.has(id)) problems.push(`the suggestion to the working group cites ${id}, which the report doesn't list, so it has no number`);

  // The open lint findings, by authoring rule.
  const lint = new Map<string, LintItem>();
  const setAside: Record<string, number> = {};
  for (const b of builds) {
    setAside[b.lock.name] = 0;
    for (const f of b.lint) {
      if (f.disposition !== null) {
        setAside[b.lock.name]! += 1;
        continue;
      }
      const item: LintItem = lint.get(f.id) ?? { id: f.id, kind: f.kind, sections: [], messages: [] };
      // The sections in the order of the finding's places, which its line links follow. A finding about the whole
      // document has no place, so it points to the top-level sections of what it is about, such as § 5 for the line item's fields.
      const placed = [...new Set(f.locs.map((l) => l.section))];
      const sections = placed.length > 0 ? placed : [...new Set(f.subjects.map((x) => sectionOf(x).split(/[./]/)[0]!).filter((x) => x !== ""))].sort(compareSections);
      const checked = f.kind === "must_without_field" ? checkedAs(b, f.subjects[0] ?? "") : undefined;
      if (f.kind === "must_without_field" && checked === undefined) problems.push(`${b.lock.name}: the MUST statement ${f.subjects[0]} is no rule, obligation, or schema statement of the model`);
      item.messages.push({ lock: b.lock.name, message: messageInTerms(f, b.ir), sections, lines: f.locs.map((l) => ({ section: l.section, line: l.line })), ...(checked !== undefined ? { checked } : {}) });
      item.sections = [...new Set([...item.sections, ...sections])].sort(compareSections);
      lint.set(f.id, item);
    }
  }
  const findings = fb.rules.map((r) => ({
    rule: r.id,
    title: r.title,
    findings: [...lint.values()].filter((f) => fb.kinds[f.kind] === r.id).sort((a, b) => cmp(a.kind, b.kind) || cmp(a.id, b.id)),
  }));

  // The example failures, merged across locks and over locations that share their causes and reason.
  const kindOf = new Map(input.decisions.map((d) => [d.id, d.kind]));
  const failures = new Map<string, { example: string; path: string; kind: string; severity: ExampleItem["severity"]; locks: string[]; decisions: string[]; reason: string }>();
  for (const b of builds) {
    for (const f of b.failures) {
      const r = input.recordedFindings.findings.find((x) => inScope(x.locks, b.lock.name) && x.example === f.example && x.path === f.path && x.kind === f.kind && x.rule === f.rule);
      if (r === undefined) {
        problems.push(`${b.lock.name}: ${f.example} ${f.path || "/"} fails with no recorded finding`);
        continue;
      }
      internal(`the finding at ${f.example} ${f.path || "/"}`, r.reason);
      for (const id of r.decisions) if (!kindOf.has(id)) problems.push(`the finding at ${f.example} ${f.path || "/"} cites ${id}, which has no decision record`);
      const severity = f.severity === "warning" ? "warning" : "error";
      const key = [f.example, f.path, f.kind, severity, r.decisions.join(","), r.reason].join("\u0000");
      const x = failures.get(key) ?? { example: f.example, path: f.path, kind: f.kind, severity, locks: [], decisions: [...r.decisions].sort(), reason: r.reason };
      x.locks.push(b.lock.name);
      failures.set(key, x);
    }
  }
  const examples = new Map<string, ExampleItem>();
  for (const f of failures.values()) {
    const key = [f.example, f.kind, f.severity, f.decisions.join(","), f.reason, f.locks.join(",")].join("\u0000");
    const causes = (["gap", "departure"] as const).filter((k) => f.decisions.some((id) => kindOf.get(id) === k));
    const x = examples.get(key) ?? { example: f.example, kind: f.kind, paths: [], locks: f.locks, decisions: f.decisions, causes, severity: f.severity, reason: f.reason };
    x.paths.push(f.path);
    examples.set(key, x);
  }
  for (const x of examples.values()) x.paths.sort();
  const exampleList = [...examples.values()].sort((a, b) => cmp(a.example, b.example) || cmp(a.paths[0]!, b.paths[0]!) || cmp(a.locks.join(","), b.locks.join(",")));

  // The checks the examples leave undecided, each with its recorded reason.
  const undecided = new Map<string, UndecidedItem>();
  for (const b of builds) {
    for (const u of b.undecided) {
      const r = (input.recordedFindings.undecided ?? []).find((x) => inScope(x.locks, b.lock.name) && x.example === u.example && x.path === u.path && x.rule === u.rule);
      if (r === undefined) {
        problems.push(`${b.lock.name}: ${u.example} ${u.path || "/"} leaves ${u.rule} undecided with no recorded reason`);
        continue;
      }
      internal(`the undecided check at ${u.example} ${u.path || "/"}`, r.reason);
      const statement = b.rules.rules.find((x) => x.id === u.rule)?.statement ?? u.rule;
      const key = [u.example, u.path, statement, r.reason].join("\u0000");
      const x = undecided.get(key) ?? { example: u.example, path: u.path, rule: statement, locks: [], decisions: [...r.decisions].sort(), reason: r.reason };
      x.locks.push(b.lock.name);
      undecided.set(key, x);
    }
  }

  // The untagged unions: every union, and every copy whose schema is an `anyOf`, one item per union across the locks.
  const unions = new Map<string, UnionItem>();
  for (const b of builds) {
    const constructors = new Map(b.model.types.filter((t) => t.kind === "constructor").map((t) => [t.name, t]));
    const byName = new Map(b.model.types.map((t) => [t.name, t]));
    const inline = new Map(b.ir.inline_objects.map((o) => [o.id, o.text]));
    const profiles = b.model.types.filter((t) => t.kind === "profile");
    for (const t of b.model.types) {
      const copy = t.kind === "copy" && Array.isArray((t.schema as { anyOf?: unknown }).anyOf);
      if (t.kind !== "union" && !copy) continue;
      const ctor = t.kind === "copy" ? constructors.get(t.of.constructor) : undefined;
      // A copy rests on its template's elements and on its arguments', so two copies of one template say which field each serves,
      // and a projection's on its profile's too, so a summary's union says it is the summary's.
      const args = t.kind === "copy" ? Object.values(t.of.arguments).flatMap((a) => (a.kind === "named" ? (byName.get(a.name)?.sources ?? []) : [])) : [];
      const projected = t.references.some((n) => { const x = byName.get(n); return x?.kind === "object" && x.projects !== undefined; });
      const profile = projected ? profiles.filter((p) => t.name.startsWith(p.name)).flatMap((p) => p.sources) : [];
      const sources = t.sources.length > 0 ? t.sources : [...(ctor?.sources ?? []), ...args, ...profile];
      const decisions = [...new Set([...t.decisions, ...(ctor?.decisions ?? [])])].sort();
      const branches = [...t.references].sort();
      const forms = branches.map((n) => formOf(byName.get(n), constructors, inline));
      const u = unions.get(t.name) ?? { name: t.name, branches, forms: [], sources: [], decisions: [], locks: [] };
      u.sources = [...new Set([...u.sources, ...sources])].sort(bySpecOrder);
      u.decisions = [...new Set([...u.decisions, ...decisions])].sort();
      u.branches = [...new Set([...u.branches, ...branches])].sort();
      const same = u.forms.find((x) => x.forms.join("\u0000") === forms.join("\u0000"));
      if (same) same.locks.push(b.lock.name);
      else u.forms.push({ locks: [b.lock.name], forms });
      u.locks.push(b.lock.name);
      unions.set(t.name, u);
    }
  }

  // The conditions a schema can't state.
  const conditions = new Map<string, string[]>();
  for (const b of builds) for (const c of b.conditionsLeft.map((x) => conditionInTerms(x, b.model))) conditions.set(c, [...(conditions.get(c) ?? []), b.lock.name]);

  // The round-trip differences.
  const differences = new Map<string, DifferenceItem>();
  for (const b of builds) {
    for (const d of b.differences) {
      const r = input.recordedDifferences.differences.find((x) => inScope(x.locks, b.lock.name) && x.table === d.table && x.row === d.row && x.column === d.column);
      if (r === undefined) {
        problems.push(`${b.lock.name}: the round trip differs at ${d.table} ${d.row} [${d.column}] with no recorded difference`);
        continue;
      }
      internal(`the difference at ${d.row} [${d.column}]`, r.reason);
      const key = [d.table, d.row, d.column, d.spec, d.model].join("\u0000");
      const x = differences.get(key) ?? { table: d.table, row: d.row, column: d.column, spec: d.spec, model: d.model, locks: [], decision: r.decision, reason: r.reason };
      x.locks.push(b.lock.name);
      differences.set(key, x);
    }
  }

  const doc: FeedbackDoc = {
    format: 1,
    issue: fb.issue,
    locks,
    groups,
    departures,
    findings,
    set_aside: setAside,
    examples: exampleList,
    undecided: [...undecided.values()].sort((a, b) => cmp(a.example, b.example) || cmp(a.path, b.path) || cmp(a.rule, b.rule)),
    unions: [...unions.values()].sort((a, b) => cmp(a.name, b.name) || cmp(a.locks.join(","), b.locks.join(","))),
    conditions: [...conditions].map(([text, on]) => ({ text, locks: on })).sort((a, b) => cmp(a.text, b.text)),
    round_trip: [...differences.values()].sort((a, b) => bySpecOrder(a.row, b.row) || cmp(a.column, b.column) || cmp(a.locks.join(","), b.locks.join(","))),
  };
  return { doc, problems };
}

export const renderFeedback = (doc: FeedbackDoc): string => canonicalJson(doc);

/**
 * Checks a report against the builds it should come from: every decision a
 * lock cites is listed once, every open lint finding of every lock is under
 * the row its kind names, and every example failure, union, condition, and
 * round-trip difference is listed.
 */
export function checkFeedback(doc: FeedbackDoc, builds: LockBuild[], fb: FeedbackProfile): string[] {
  const problems: string[] = [];
  problems.push(...internalCitations(doc, fb, internalTypeNames(builds)));
  const all = allDecisions(doc);
  const listed = all.map((d) => d.id);
  const twice = listed.filter((id, i) => listed.indexOf(id) !== i);
  if (twice.length > 0) problems.push(`decisions listed twice: ${[...new Set(twice)].join(", ")}`);
  for (const d of doc.groups.flatMap((g) => g.decisions)) if (d.kind !== "gap") problems.push(`${d.id} is a ${d.kind}, listed with the decisions the text leaves open`);
  for (const d of doc.departures) if (d.kind !== "departure") problems.push(`${d.id} is a ${d.kind}, listed with the changes we propose`);
  const kinds = new Map(all.map((d) => [d.id, d.kind]));
  for (const x of doc.examples) {
    const want = (["gap", "departure"] as const).filter((k) => x.decisions.some((id) => kinds.get(id) === k));
    if (want.join() !== x.causes.join()) problems.push(`${x.example} ${x.paths.join(", ")}: its causes are ${want.join(" and ") || "unknown"}, but the report lists ${x.causes.join(" and ") || "none"}`);
    for (const id of x.decisions) if (!kinds.has(id)) problems.push(`${x.example} ${x.paths.join(", ")}: cites ${id}, which the report doesn't list`);
  }
  // One row of a table holds the failures at one place, so they give one reason, which the row shows once.
  const reasons = new Map<string, Set<string>>();
  for (const x of doc.examples) {
    const table = x.severity === "warning" ? "SHOULD" : x.causes.includes("gap") ? "disagree" : "follow";
    const key = [table, x.example, x.paths.join(", "), x.locks.join(", ")].join("\u0000");
    reasons.set(key, new Set([...(reasons.get(key) ?? []), x.reason.replace(/\s+/g, " ").trim()]));
  }
  for (const [key, rs] of reasons) {
    const [table, example, paths] = key.split("\u0000");
    if (rs.size > 1) problems.push(`${example} ${paths}: ${rs.size} findings at the place give different reasons in one table (${table}); give them one reason, which the row shows once`);
  }
  const lintById = new Map(doc.findings.flatMap((r) => r.findings.map((f) => [f.id, { rule: r.rule, f }] as const)));
  for (const b of builds) {
    const name = b.lock.name;
    for (const id of citedDecisions(b.model, b.rules)) {
      const d = all.find((x) => x.id === id);
      if (d === undefined || !d.locks.includes(name)) problems.push(`${name}: ${id} is cited and not listed for the lock`);
    }
    for (const f of b.lint) {
      if (f.disposition !== null) continue;
      const got = lintById.get(f.id);
      if (got === undefined || !got.f.messages.some((m) => m.lock === name && m.message === messageInTerms(f, b.ir))) problems.push(`${name}: lint finding ${f.id} isn't listed`);
      else if (got.rule !== fb.kinds[f.kind]) problems.push(`${name}: lint finding ${f.id} is under row ${got.rule}, not ${fb.kinds[f.kind]}`);
    }
    if (doc.set_aside[name] !== b.lint.filter((f) => f.disposition !== null).length) problems.push(`${name}: the count of findings with a verdict is wrong`);
    for (const f of b.failures) if (!doc.examples.some((x) => x.example === f.example && x.kind === f.kind && x.severity === (f.severity === "warning" ? "warning" : "error") && x.paths.includes(f.path) && x.locks.includes(name))) problems.push(`${name}: the example failure at ${f.example} ${f.path || "/"} isn't listed`);
    for (const u of b.undecided) if (!doc.undecided.some((x) => x.example === u.example && x.path === u.path && x.locks.includes(name))) problems.push(`${name}: the undecided check at ${u.example} ${u.path || "/"} isn't listed`);
    for (const t of b.model.types) {
      const union = t.kind === "union" || (t.kind === "copy" && Array.isArray((t.schema as { anyOf?: unknown }).anyOf));
      if (union && !doc.unions.some((u) => u.name === t.name && u.locks.includes(name))) problems.push(`${name}: the union ${t.name} isn't listed`);
    }
    for (const c of b.conditionsLeft) if (!doc.conditions.some((x) => x.text === conditionInTerms(c, b.model) && x.locks.includes(name))) problems.push(`${name}: the condition "${c}" isn't listed`);
    for (const d of b.differences) if (!doc.round_trip.some((x) => x.table === d.table && x.row === d.row && x.column === d.column && x.locks.includes(name))) problems.push(`${name}: the round-trip difference at ${d.row} [${d.column}] isn't listed`);
  }
  return problems;
}

/**
 * Each place a decision record's text for the specification's owners, its
 * question, its chosen option's summary, and its feedback, cites what the
 * owners don't have: a document or record of this repository, or a type of
 * the model that the specification never writes. The report checks its own
 * lines the same way; this holds a spec's records to it before the spec has
 * a report.
 */
export function recordCitations(decisions: readonly DecisionRecord[], names: ReadonlySet<string> = new Set()): string[] {
  const problems: string[] = [];
  for (const d of decisions) {
    if (d.status === "superseded") continue;
    const shown: [string, string | undefined][] = [
      ["question", d.question],
      ["summary of the chosen option", d.options.find((o) => o.id === d.chosen)?.summary],
      ["feedback", d.feedback],
    ];
    for (const [field, text] of shown) {
      if (text === undefined) continue;
      for (const line of text.split("\n")) {
        const m = INTERNAL.exec(line);
        if (m) problems.push(`${d.id}: its ${field} cites "${m[0]}", which the specification's owners don't have; say it in the specification's terms`);
        const n = internalTypeName(line, names);
        if (n !== null) problems.push(`${d.id}: its ${field} names the type "${n}", which the specification never writes; say it in the specification's terms`);
      }
    }
  }
  return problems;
}

/**
 * Every line of the comment and the details, below the generated header,
 * that cites what the working group doesn't have: a document of this
 * repository, a command, an internal decision ID such as `D-7`, or one of
 * `names`, the model's type names the specification never writes.
 */
export function internalCitations(doc: FeedbackDoc, fb: FeedbackProfile, names: ReadonlySet<string> = new Set()): string[] {
  const problems: string[] = [];
  for (const [file, text] of [
    [FEEDBACK_FILES.comment, renderComment(doc)],
    [FEEDBACK_FILES.details, renderDetails(doc, fb)],
  ] as const) {
    text.split("\n").forEach((line, i) => {
      if (line.startsWith("<!-- Generated by")) return;
      const m = INTERNAL.exec(line);
      if (m) problems.push(`${file} line ${i + 1} cites "${m[0]}", which the working group doesn't have; say it in the specification's terms`);
      const n = internalTypeName(line, names);
      if (n !== null) problems.push(`${file} line ${i + 1} names the type "${n}", which the specification never writes; say it in the specification's terms`);
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The markdown

const cell = (s: string) => s.replace(/\s+/g, " ").trim().replaceAll("|", "\\|");
const code = (s: string) => `\`${s.replaceAll("`", "")}\``;
const lines = (out: string[]) => {
  while (out.at(-1) === "") out.pop();
  return `${out.join("\n")}\n`;
};

function table(header: string[], rows: string[][], align?: string[]): string[] {
  if (rows.length === 0) return ["None.", ""];
  return [`| ${header.join(" | ")} |`, `| ${header.map((_, i) => align?.[i] ?? ":---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`), ""];
}

const header = (file: string) =>
  `<!-- Generated by \`npm run feedback\` from the decision records and the findings; don't edit it: change a record and regenerate. A draft: review it before posting. ${file} -->`;

/** How the report names a set of locks: nothing when it is every lock. */
function lockNote(doc: FeedbackDoc, on: string[]): string {
  if (on.length === doc.locks.length) return "";
  return on.map((n) => doc.locks.find((l) => l.name === n)?.label ?? code(n)).join(", ");
}

/** A list as a sentence writes it: `a`, `a and b`, `a, b, and c`. */
const series = (xs: string[]) => (xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")}, and ${xs.at(-1)}`);

function inputs(doc: FeedbackDoc): string {
  const [base, ...rest] = doc.locks;
  const parts = [`\`${base!.name}\` at \`${base!.commit.slice(0, 7)}\``];
  for (const l of rest) {
    const branches = l.branches === 0 ? "" : ` and ${l.branches} unposted ${l.branches === 1 ? "branch" : "branches"} of ours`;
    const ours = l.ours.length === 0 ? "" : `, including our ${series(l.ours.map((n) => `#${n}`))}`;
    parts.push(`\`${base!.name}\` with the ${l.prs.length} open PRs${branches} merged${ours}, at \`${l.commit.slice(0, 7)}\``);
  }
  return parts.join(", and ");
}

/** An IR element as the working group reads it: the field or key it names, or the kind of text. */
function elementLabel(id: string): { section: string; label: string; marker?: string; count?: string } {
  const [kind, section = "", rest = ""] = id.split(":");
  const sec = section.split("/")[0]!;
  const name = rest.split("#")[0]!;
  switch (kind) {
    case "field":
    case "key":
    case "def":
      return { section: sec, label: name.split(",").map(code).join(", ") };
    case "marker":
      return { section: sec, label: "", marker: name };
    case "rule":
      return { section: sec, label: "", count: "statement" };
    case "sentence":
      return { section: sec, label: "", count: "sentence" };
    case "code":
      return { section: sec, label: "", count: "code block" };
    default:
      return { section: sec, label: "", count: "list" };
  }
}

/** An example as the working group reads it: its file, or the code block's section. */
const exampleLabel = (example: string) => (example.startsWith("code:") ? `§ ${sectionOf(example).split("/")[0]} code block` : code(example));

/** The elements a decision or a union rests on, by section: `§ 5.5: \`geo\`, 2 statements`. */
export function restsOn(ids: string[]): string {
  const bySection = new Map<string, { labels: string[]; markers: string[]; counts: Map<string, number> }>();
  for (const id of ids) {
    const e = elementLabel(id);
    const s = bySection.get(e.section) ?? { labels: [] as string[], markers: [] as string[], counts: new Map<string, number>() };
    if (e.label !== "" && !s.labels.includes(e.label)) s.labels.push(e.label);
    if (e.marker !== undefined && !s.markers.includes(e.marker)) s.markers.push(e.marker);
    if (e.count !== undefined) s.counts.set(e.count, (s.counts.get(e.count) ?? 0) + 1);
    bySection.set(e.section, s);
  }
  return [...bySection]
    .sort(([a], [b]) => compareSections(a, b))
    .map(([section, s]) => {
      const counts = [...s.counts].map(([what, n]) => `${n} ${n === 1 ? what : `${what}s`}`);
      const markers = s.markers.length === 0 ? [] : [s.markers.length === 1 ? `the ${code(s.markers[0]!)} marker` : `the markers ${s.markers.map(code).join(", ")}`];
      return `§ ${section}: ${[...s.labels, ...markers, ...counts].join(", ")}`;
    })
    .join("; ");
}

const asked = (g: FeedbackDoc["groups"][number]) => g.decisions.filter((d) => d.feedback !== undefined);
/** Every decision, in reading order: the ones the text leaves open, by group, then the changes we propose. */
export const allDecisions = (doc: FeedbackDoc): DecisionItem[] => [...doc.groups.flatMap((g) => g.decisions), ...doc.departures];
/**
 * The distinct places an example fails on a lock, by example and location,
 * each with the kinds of its failures' causes: a place can fail its schema
 * and a rule, and each failure has causes of one kind. The errors and the
 * SHOULD rules' warnings are counted apart.
 */
export function placesOf(doc: FeedbackDoc, lock: string, severity: ExampleItem["severity"]): Map<string, Set<DecisionRecord["kind"]>> {
  const out = new Map<string, Set<DecisionRecord["kind"]>>();
  for (const x of doc.examples) {
    if (!x.locks.includes(lock) || x.severity !== severity) continue;
    for (const p of x.paths) {
      const key = `${x.example}\u0000${p}`;
      out.set(key, new Set([...(out.get(key) ?? []), ...x.causes]));
    }
  }
  return out;
}
/** A lock's error places split by their causes: only gaps, only departures, and both. */
export function placeCounts(doc: FeedbackDoc, lock: string): { places: number; gap: number; departure: number; both: number; warnings: number; undecided: number } {
  const places = [...placesOf(doc, lock, "error").values()];
  const only = (k: DecisionRecord["kind"]) => places.filter((c) => c.size === 1 && c.has(k)).length;
  return {
    places: places.length,
    gap: only("gap"),
    departure: only("departure"),
    both: places.filter((c) => c.size === 2).length,
    warnings: placesOf(doc, lock, "warning").size,
    undecided: new Set(doc.undecided.filter((u) => u.locks.includes(lock)).map((u) => `${u.example}\u0000${u.path}\u0000${u.rule}`)).size,
  };
}
/** The decision numbers an example failure cites, as the working group reads them. */
const numbersOf = (doc: FeedbackDoc, ids: string[]) => ids.map((id) => allDecisions(doc).find((d) => d.id === id)?.number).filter((n): n is number => n !== undefined).sort((a, b) => a - b);
const openOn = (rule: FeedbackDoc["findings"][number], lock: string) => rule.findings.filter((f) => f.messages.some((m) => m.lock === lock)).length;

/**
 * The per-lock place counts, and the sentences on the SHOULD rules and the
 * undecided checks, that the comment and the details both write.
 */
function failureNotes(doc: FeedbackDoc) {
  const [base, ...rest] = doc.locks;
  const counts = new Map(doc.locks.map((l) => [l.name, placeCounts(doc, l.name)]));
  const per = (f: (c: ReturnType<typeof placeCounts>) => number, first: string) => {
    const n = f(counts.get(base!.name)!);
    return [`${n} ${n === 1 ? first.replace(/places$/, "place") : first} ${base!.phrase}`, ...rest.map((l) => `${f(counts.get(l.name)!)} ${l.phrase}`)].join(" and ");
  };
  const any = (f: (c: ReturnType<typeof placeCounts>) => number) => [...counts.values()].some((c) => f(c) > 0);
  const warnings = any((c) => c.warnings) ? `They break a SHOULD rule, a warning rather than an error, in ${per((c) => c.warnings, "places")}.` : "None breaks a SHOULD rule, which would be a warning rather than an error.";
  const undecided = any((c) => c.undecided) ? ` A generated rule can't decide ${per((c) => c.undecided, "places")}, where an example leaves out what decides it.` : "";
  return { counts, per, warnings, undecided };
}

/** The open lint findings on each lock, by authoring rule, as a table. */
const ruleCounts = (doc: FeedbackDoc) =>
  table(
    ["Authoring rule", ...doc.locks.map((l) => l.label)],
    doc.findings.filter((r) => r.findings.length > 0).map((r) => [/^\d$/.test(r.rule) ? `${r.rule}. ${r.title}` : r.title, ...doc.locks.map((l) => String(openOn(r, l.name)))]),
    [":---", ...doc.locks.map(() => "---:")],
  );

/** The comment to post on the issue. A function of the JSON form. */
export function renderComment(doc: FeedbackDoc): string {
  const gaps = doc.groups.reduce((n, g) => n + g.decisions.length, 0);
  const asking = doc.groups.reduce((n, g) => n + asked(g).length, 0);
  const proposed = doc.departures.length;
  const out: string[] = [header("Post it as a comment on the issue, with the details link replaced by the gist of details.md."), ""];
  out.push(
    `We now generate the schemas from the specification. It took ${gaps + proposed} decisions: ${gaps} where the text leaves a point open, and ${proposed} changes we propose to what the text or its examples settle. Of the ${gaps} open points, ${asking} ask the specification to state something, and each one says what, so that the next revision needs none of them. The outputs are JSON Schema 2020-12, the rules JSON Schema can't express with their test vectors, and TypeScript, Python, and Go types.`,
    "",
    `Inputs: ${inputs(doc)}.`,
    "",
  );
  out.push(
    ...table(
      ["Open points about", "Count", "The specification should state"],
      doc.groups.filter((g) => asked(g).length > 0).map((g) => [g.title, String(asked(g).length), g.asks]),
      [":---", "---:", ":---"],
    ),
  );
  if (proposed > 0) {
    out.push(`The ${proposed} changes we propose, each a departure from what the text or its examples write:`, "");
    for (const d of doc.departures) {
      const only = d.locks.length === doc.locks.length ? "" : ` (only ${d.locks.map((n) => doc.locks.find((l) => l.name === n)?.phrase ?? code(n)).join(", ")})`;
      out.push(`- **${d.number}.** ${d.question}${only}`);
    }
    out.push("");
  }
  const [base, ...rest] = doc.locks;
  const { counts, per, warnings, undecided } = failureNotes(doc);
  const split = [base!, ...rest].map((l) => {
    const c = counts.get(l.name)!;
    const verb = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    return `${l.phrase}, ${verb(c.gap, "only disagrees", "only disagree")} with the text, ${verb(c.departure, "only follows", "only follow")} the text but not a change we propose, and ${verb(c.both, "does", "do")} both, with one failure of each kind, so ${c.gap} + ${c.departure} + ${c.both} = ${c.places}`;
  });
  out.push(
    `The specification's own examples fail against the generated schemas, or break a generated rule that is a MUST, in ${per((c) => c.places, "distinct places")}. ${split.map((x) => x[0]!.toUpperCase() + x.slice(1)).join(". ")}. ${warnings}${undecided} The details say, for each, which side should change.`,
    "",
  );
  out.push("The lint findings in this issue, by the authoring rule that removes them. No authoring rule removes a MUST statement that names no field or key: each needs conformance test vectors, as a rule on payloads or the schemas, or binds a party, and the details say which.", "");
  out.push(...ruleCounts(doc));
  out.push(`Every decision, with the rows it rests on, and every finding: [details](${DETAILS_LINK}).`);
  return lines(out);
}

/**
 * A record's text as the details lay it out: a lead, and the list items the
 * record writes as paragraphs that start with "- ". In a folded YAML scalar,
 * a blank line is a line break, so a record writes a list as a blank line
 * before each item; every other run of whitespace is one space.
 */
export function proseParts(text: string): { lead: string; items: string[] } {
  const paragraphs = text.split("\n").map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => p !== "");
  const first = paragraphs.findIndex((p) => p.startsWith("- "));
  const lead = (first === -1 ? paragraphs : paragraphs.slice(0, first)).join(" ");
  const items: string[] = [];
  // A paragraph after the first item that isn't an item continues the item before it.
  for (const p of first === -1 ? [] : paragraphs.slice(first)) {
    if (p.startsWith("- ")) items.push(p.slice(2));
    else items[items.length - 1] += ` ${p}`;
  }
  return { lead, items };
}

const SHA1 = /^[0-9a-f]{40}$/;

/**
 * Checks that the lint tables carry a working permalink to the
 * specification on the default lock for each finding that has a place
 * there: its row links at least one of its lines, and every link it carries
 * opens the default lock's specification at its full commit, at a line the
 * file has and that isn't blank, under the heading of the section the link
 * names. A finding about the whole document, such as a table's presence
 * count, has no place, and so no line to link. `spec` is the default lock's
 * specification, the file its blob pins.
 */
export function checkLineLinks(doc: FeedbackDoc, details: string, spec: string): { problems: string[]; linked: number; unplaced: number } {
  const problems: string[] = [];
  const base = doc.locks[0]!;
  const specLines = spec.split("\n");
  if (!SHA1.test(base.commit)) problems.push(`the ${base.label} lock's commit "${base.commit}" isn't a full 40-character SHA, so a line link to it isn't a permalink`);
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(base.upstream)) problems.push(`the ${base.label} lock's upstream "${base.upstream}" isn't a GitHub repository, so a line link to it doesn't open`);
  // The numbered section each line is under: the nearest numbered heading above it; an unnumbered heading keeps its parent's.
  const sectionAt: string[] = [];
  let current = "";
  specLines.forEach((l, i) => {
    const m = /^#{1,6}\s+(\d+(?:\.\d+)*)\.?\s/.exec(l);
    if (m) current = m[1]!;
    else if (/^#{1,6}\s/.test(l) && /^#{1,2}\s/.test(l)) current = "";
    sectionAt[i] = current;
  });
  const rows = details.split("\n").filter((l) => l.startsWith("| "));
  let linked = 0;
  let unplaced = 0;
  for (const r of doc.findings) {
    for (const f of r.findings) {
      const m = f.messages.find((x) => x.lock === base.name);
      if (m === undefined) continue;
      if (m.lines.length === 0) {
        unplaced += 1;
        continue;
      }
      const distinct = [...new Set(f.messages.map((x) => x.message))];
      const text = distinct.length === 1 ? distinct[0]! : f.messages.map((x) => `${doc.locks.find((l) => l.name === x.lock)?.label ?? x.lock}: ${x.message}`).join(" ");
      const row = rows.find((l) => l.startsWith(`| ${cell(text)} |`));
      if (row === undefined) {
        problems.push(`${f.id}: no lint table row lists it`);
        continue;
      }
      const links = [...row.matchAll(/\[§ ([^,\]]+), line (\d+)\]\(([^)\s]+)\)/g)];
      if (links.length === 0) {
        problems.push(`${f.id}: its row links none of its lines on ${base.label}`);
        continue;
      }
      linked += 1;
      for (const [, section, n, url] of links) {
        const line = Number(n);
        const want = permalink(base, line);
        if (url !== want) problems.push(`${f.id}: the link to line ${line} is ${url}, not the permalink ${want}`);
        if (!m.lines.some((x) => x.line === line)) problems.push(`${f.id}: line ${line} is none of its places on ${base.label}`);
        if (line < 1 || line > specLines.length) {
          problems.push(`${f.id}: line ${line} is past the end of the specification, which has ${specLines.length} lines`);
          continue;
        }
        if (specLines[line - 1]!.trim() === "") problems.push(`${f.id}: line ${line} of the specification is blank`);
        if (sectionAt[line - 1] !== section) problems.push(`${f.id}: line ${line} is in § ${sectionAt[line - 1] || "no numbered section"}, not § ${section}, which the link names`);
      }
    }
  }
  return { problems, linked, unplaced };
}

/** A labelled bullet, with the record's list items under it. */
function labelled(label: string, text: string): string[] {
  const { lead, items } = proseParts(text);
  return [`- **${label}:**${lead !== "" ? ` ${lead}` : ""}`, ...items.map((x) => `  - ${x}`)];
}

/** A line's permalink: the specification at the lock's commit, opened at that line. */
export const permalink = (l: Pick<LockSide, "upstream" | "commit" | "path">, line: number) => `${l.upstream}/blob/${l.commit}/${l.path.split("/").map(encodeURIComponent).join("/")}?plain=1#L${line}`;

/** The most line links one finding's row carries; the Where column still names every section. */
export const MAX_LINE_LINKS = 4;

/** The line links of a finding on the default lock, in the order of its places. */
export function lineLinks(doc: FeedbackDoc, f: LintItem): { section: string; line: number; url: string }[] {
  const base = doc.locks[0]!;
  const m = f.messages.find((x) => x.lock === base.name);
  if (m === undefined) return [];
  const seen = new Set<string>();
  const out: { section: string; line: number; url: string }[] = [];
  for (const l of m.lines) {
    const key = `${l.section}\u0000${l.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ section: l.section.split("/")[0]!, line: l.line, url: permalink(base, l.line) });
  }
  return out.slice(0, MAX_LINE_LINKS);
}

/** An example as a sentence names it: "the display example" for `examples/line-item-display.yaml`. */
const exampleName = (example: string) =>
  example.startsWith("code:") ? `the ${exampleLabel(example)}` : `the ${example.replace(/^examples\//, "").replace(/^line-item-/, "").replace(/\.[a-z]+$/, "").replaceAll("-", " ")} example`;

/** Numbers as a sentence lists them, with runs of three or more as a range: `#70` to `#76`. */
function ranges(ns: number[], show: (n: number) => string): string {
  const sorted = [...new Set(ns)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    if (j - i >= 2) parts.push(`${show(sorted[i]!)} to ${show(sorted[j]!)}`);
    else for (let k = i; k <= j; k++) parts.push(show(sorted[k]!));
    i = j + 1;
  }
  return series(parts);
}

/** The issue's number, from its URL. */
const issueNumber = (url: string) => url.split("/").pop()!;

/** The decision IDs a suggestion names, each of which the report must list. */
export const suggestionDecisions = (fb: FeedbackProfile): string[] => [...fb.suggestion.items.join(" ").matchAll(/\{(D-\d+)\}/g)].map((m) => m[1]!);


/**
 * The details, for the gist the comment links. A function of the JSON form
 * and of the profile's layout (`fb`): its headline, each row's intro, and its
 * suggestion to the working group.
 */
export function renderDetails(doc: FeedbackDoc, fb: FeedbackProfile): string {
  const out: string[] = [header("Post it as the gist the comment links."), ""];
  const push = (...xs: string[]) => out.push(...xs);
  const [base, ...rest] = doc.locks;
  const all = allDecisions(doc);
  const gaps = doc.groups.reduce((n, g) => n + g.decisions.length, 0);
  const asking = doc.groups.reduce((n, g) => n + asked(g).length, 0);
  const number = (id: string) => all.find((d) => d.id === id)?.number;
  const issue = `[#${issueNumber(doc.issue)}](${doc.issue})`;
  const prLink = (l: LockSide, n: number) => `[#${n}](${l.upstream}/pull/${n})`;
  // The appendices agree with the body when no lock has a finding about them.
  const appendices = !doc.findings.some((r) => r.findings.some((f) => f.kind.startsWith("appendix_")));

  push(
    `# ${fb.headline}`,
    "",
    `This page supports [our implementation feedback on deriving a schema from the specification (#${issueNumber(doc.issue)})](${doc.issue}). We generated our own schemas from ${code(base!.path)}. A deterministic parser reads its markdown syntax tree, with no model calls. Where the text leaves a point open, we record a decision, and this page lists them. Every table and row parsed${appendices ? ", and the appendices agree with the body" : ""}. The outputs are JSON Schema 2020-12, the rules JSON Schema can't express with their test vectors, and TypeScript, Python, and Go types.`,
    "",
    `Generating them took ${all.length} decisions: ${gaps} where the text leaves a point open, and ${doc.departures.length} changes we propose to what the text or examples settle. This page keeps the two groups apart. Of the ${gaps} open points, ${asking} ask the specification to state something, and each says what, so that the next revision needs none of them.`,
    "",
    "## Inputs",
    "",
    ...table(
      ["Input", "Commit", "Specification blob"],
      doc.locks.map((l) => [l.label, l.prs.length === 0 ? `[${code(l.commit.slice(0, 7))}](${l.upstream}/tree/${l.commit})` : `${code(base!.name)} with the ${l.prs.length} PRs merged locally`, code(l.blob.slice(0, 8))]),
    ),
  );
  for (const l of rest) {
    if (l.prs.length === 0) continue;
    const ours = l.ours.length === 0 ? "" : ` Ours are ${series(l.ours.map((n) => `#${n}`))}.`;
    const edits = l.edits.length === 0 ? "" : `, and ${series(l.edits)}`;
    push(
      `The open PRs are the ${l.prs.length} open on ${l.heads_on ?? "the day we merged them"}: ${ranges(l.prs, (n) => prLink(l, n))}.${ours} We merged each at its head that day, in the order below. We resolved the merge conflicts by hand${edits}. The blob is the Git hash of the specification file, so it identifies our merge.`,
      "",
      ...table(["Order", "PR", "Head"], l.heads.map((h, i) => [String(i + 1), prLink(l, h.pr), code(h.head.slice(0, 7))]), ["---:", ":---", ":---"]),
    );
  }

  // The summary: the open points by group, the example failures by cause, and the lint findings by authoring rule.
  const unasked = doc.groups.flatMap((g) => g.decisions.filter((d) => d.feedback === undefined).map((d) => d.number));
  push(
    "## Summary",
    "",
    `The ${asking} open points that ask the specification to state something:`,
    "",
    ...table(
      ["Open points about", "Count", "The specification should state"],
      doc.groups.filter((g) => asked(g).length > 0).map((g) => [g.title, String(asked(g).length), g.asks]),
      [":---", "---:", ":---"],
    ),
  );
  if (unasked.length > 0)
    push(
      unasked.length === 1
        ? `The other open point, ${unasked[0]}, only chooses how the schemas express text the specification already states.`
        : `The other ${unasked.length} open points, ${series(unasked.map(String))}, only choose how the schemas express text the specification already states.`,
      "",
    );
  const { counts, per, warnings, undecided } = failureNotes(doc);
  const most = [...counts.values()].every((c) => c.departure > c.gap + c.both);
  push(
    `In ${per((c) => c.places, "distinct places").replace(` and `, `, and `)}, the examples fail against the generated schemas or break a generated MUST rule.${most ? " Most of them come from the changes we propose, not from the specification: the examples follow the text there." : ""}`,
    "",
    ...table(
      ["Places where an example", ...doc.locks.map((l) => l.label)],
      [
        ["Only disagrees with the text", ...doc.locks.map((l) => String(counts.get(l.name)!.gap))],
        ["Only follows the text but not a change we propose", ...doc.locks.map((l) => String(counts.get(l.name)!.departure))],
        ["Does both, with one failure of each kind", ...doc.locks.map((l) => String(counts.get(l.name)!.both))],
        ["Total", ...doc.locks.map((l) => String(counts.get(l.name)!.places))],
      ],
      [":---", ...doc.locks.map(() => "---:")],
    ),
  );
  // The places that do both, each once, and on which locks.
  const both = new Map<string, Set<string>>();
  for (const l of doc.locks) for (const [key, causes] of placesOf(doc, l.name, "error")) if (causes.size === 2) both.set(key, new Set([...(both.get(key) ?? []), l.name]));
  const bothText = [...both].sort(([a], [b]) => cmp(a, b)).map(([key, on]) => {
    const [example, path] = key.split("\u0000") as [string, string];
    const note = lockNote(doc, [...on]);
    return `${exampleName(example)}'s ${code(path === "" ? "/" : path)}${note !== "" ? ` (only ${doc.locks.filter((l) => on.has(l.name)).map((l) => l.phrase).join(" and ")})` : ""}`;
  });
  const bothSentence = bothText.length === 0 ? "" : bothText.length === 1 ? `The place that does both is ${bothText[0]}. ` : `The places that do both are ${series(bothText)}. `;
  push(`${bothSentence}${warnings}${undecided}`, "");
  push(
    `The lint findings, by the authoring rule from ${issue} that removes them. No authoring rule removes a MUST statement that names no field or key. Each needs conformance test vectors, of a rule on payloads or of the schemas, or binds a party, and the lint section says which.`,
    "",
    ...ruleCounts(doc),
  );

  push(
    `## Decisions the text leaves open (${gaps})`,
    "",
    `Each decision names a question the specification leaves open and what the specification should state instead. It then says what the generated schemas do until it does, and the rows it rests on. **Only on** marks a decision that arises on one input only. ${base!.phrase[0]!.toUpperCase()}${base!.phrase.slice(1)}, an open PR changes the text it rests on. ${rest.map((l) => `${l.phrase[0]!.toUpperCase()}${l.phrase.slice(1)}`).join(" and ")}, it rests on text they add. **Examples that disagree** and **Examples that follow the text** list each example once, with its places. They mark a place that fails on one input only. [The example failures](#example-failures) give each place with its reason.`,
    "",
  );
  // Each example once, with each place in it once, however many failures there are at the place; an example or a place
  // only some locks have says on which.
  const only = (on: Set<string>, of: Set<string>) => (on.size < of.size ? `only ${doc.locks.filter((l) => on.has(l.name)).map((l) => l.phrase).join(" and ")}` : "");
  const where = (xs: ExampleItem[]): string[] => {
    const byExample = new Map<string, Map<string, Set<string>>>();
    for (const x of xs) {
      const paths = byExample.get(x.example) ?? new Map<string, Set<string>>();
      for (const p of x.paths) paths.set(p, new Set([...(paths.get(p) ?? []), ...x.locks]));
      byExample.set(x.example, paths);
    }
    const every = new Set(doc.locks.map((l) => l.name));
    return [...byExample].map(([example, paths]) => {
      const on = new Set([...paths.values()].flatMap((l) => [...l]));
      const note = only(on, every);
      const places = [...paths].sort(([a], [b]) => cmp(a, b)).map(([p, locks]) => {
        const n = only(locks, on);
        return `${code(p === "" ? "/" : p)}${n !== "" ? ` (${n})` : ""}`;
      });
      return `${exampleLabel(example)}${note !== "" ? `, ${note},` : ""} at ${places.join(", ")}`;
    });
  };
  for (const g of doc.groups) {
    if (g.decisions.length === 0) continue;
    const silent = g.decisions.filter((d) => d.feedback === undefined).map((d) => d.number);
    const note =
      silent.length === 0
        ? ""
        : ` ${silent.length === 1 ? `Decision ${silent[0]} asks` : `Decisions ${series(silent.map(String))} ask`} nothing of the specification, so the summary counts ${asked(g).length}.`;
    push(`### ${g.title} (${g.decisions.length})`, "", `${g.asks}.${note}`, "");
    for (const d of g.decisions) {
      push(`#### ${d.number}. ${d.question}`, "");
      push(...(d.feedback !== undefined ? labelled("What to change", d.feedback) : ["- **What to change:** nothing. The decision only chooses how the generated schemas express what the specification already states."]));
      push(...labelled("What the schemas do until then", d.reading));
      push(`- **Rests on:** ${restsOn(d.rests_on)}`);
      const on = lockNote(doc, d.locks);
      if (on !== "") push(`- **Only on:** ${on}`);
      const ex = doc.examples.filter((x) => x.decisions.includes(d.id));
      if (ex.length > 0) push(`- **Examples that disagree:** ${where(ex).join("; ")}`);
      if (d.issue !== undefined) push(`- **Filed as:** ${d.issue}`);
      push("");
    }
  }
  if (doc.departures.length > 0) {
    push(
      `## Changes we propose (${doc.departures.length})`,
      "",
      "Each of these departs from what the specification settles, in its text or in the form its examples write. Each names what we propose, what the generated schemas do, and the rows it rests on. An example that follows the text but not the change is listed with it, and in [the second table of example failures](#the-examples-follow-the-text-but-not-a-change-we-propose) with its reason. The example isn't wrong: the change would rewrite it.",
      "",
    );
    for (const d of doc.departures) {
      const onSome = d.locks.length === doc.locks.length ? "" : ` (only ${d.locks.map((n) => doc.locks.find((l) => l.name === n)?.phrase ?? code(n)).join(", ")})`;
      push(`#### ${d.number}. ${d.question}${onSome}`, "");
      if (d.feedback !== undefined) push(...labelled("What we propose", d.feedback));
      push(...labelled("What the schemas do", d.reading));
      push(`- **Rests on:** ${restsOn(d.rests_on)}`);
      const on = lockNote(doc, d.locks);
      if (on !== "") push(`- **Only on:** ${on}`);
      const ex = doc.examples.filter((x) => x.decisions.includes(d.id));
      if (ex.length > 0) push("- **Examples that follow the text:**", ...where(ex).map((x) => `  - ${x}`));
      if (d.issue !== undefined) push(`- **Filed as:** ${d.issue}`);
      push("");
    }
  }

  push(
    `## ${fb.suggestion.title}`,
    "",
    fb.suggestion.lead,
    "",
    ...fb.suggestion.items.map((x, i) => `${i + 1}. ${x.replace(/\{(D-\d+)\}/g, (_, id: string) => String(number(id) ?? id))}`),
    "",
  );

  const problem = (kind: string) => (kind === "undefined_key" ? "key not defined" : kind === "load" ? "doesn't load" : kind === "rule" ? "breaks a rule" : "invalid");
  // One row per place: the failures at one location of one example, on the same locks, such as a value the schema
  // rejects that also breaks a rule.
  const rows = (items: ExampleItem[]) => {
    const merged = new Map<string, { x: ExampleItem; kinds: string[]; reasons: string[]; decisions: Set<string> }>();
    for (const x of items) {
      const key = [x.example, x.paths.join(","), x.locks.join(",")].join("\u0000");
      const m = merged.get(key) ?? { x, kinds: [], reasons: [], decisions: new Set<string>() };
      if (!m.kinds.includes(problem(x.kind))) m.kinds.push(problem(x.kind));
      if (!m.reasons.includes(x.reason)) m.reasons.push(x.reason);
      for (const d of x.decisions) m.decisions.add(d);
      merged.set(key, m);
    }
    return [...merged.values()].map(({ x, kinds, reasons, decisions }) => [exampleLabel(x.example), x.paths.map((p) => code(p === "" ? "/" : p)).join(", "), kinds.join(", "), reasons.join(" "), numbersOf(doc, [...decisions]).join(", "), lockNote(doc, x.locks)]);
  };
  const errors = doc.examples.filter((x) => x.severity === "error");
  push(
    "## Example failures",
    "",
    "Each table gives the example, the location in it as a JSON Pointer, the problem, the reason, and the decision it rests on. An empty **Only on** cell means the place fails on both inputs.",
    "",
    "### The examples disagree with the text",
    "",
    "Each place where an example and the text disagree, or where the text leaves the point open. The example fails against the generated schemas, uses a key the text doesn't define, or breaks a generated MUST rule that one payload decides. The **What should change** column says which side should change. A place that also follows the text but not a change we propose is in the next table too, for its other failure.",
    "",
    ...table(["Example", "Location", "Problem", "What should change", "Decisions", "Only on"], rows(errors.filter((x) => x.causes.includes("gap")))),
    "### The examples follow the text, but not a change we propose",
    "",
    "Each place where an example follows the text and fails against the generated schemas because they make a change we propose. The example isn't wrong. The **Why** column says what the change would have it write, and names any point the text leaves open that the change alone doesn't settle.",
    "",
    ...table(["Example", "Location", "Problem", "Why", "Decisions", "Only on"], rows(errors.filter((x) => x.causes.includes("departure")))),
    "### The examples break a SHOULD rule",
    "",
    "Each place where an example breaks a generated rule that the text states with SHOULD or SHOULD NOT. That is a warning, not an error, since an implementation may depart from it with a reason.",
    "",
    ...table(["Example", "Location", "Problem", "Why", "Decisions", "Only on"], rows(doc.examples.filter((x) => x.severity === "warning"))),
    "### Rules the examples leave undecided",
    "",
    "Each place where a generated rule can't decide an example, because the verdict turns on something the example leaves out. That is a fact the text gives no field for, or a member a code block doesn't show.",
    "",
    ...table(
      ["Example", "Location", "Rule", "What it turns on", "Decisions", "Only on"],
      doc.undecided.map((u) => [exampleLabel(u.example), code(u.path === "" ? "/" : u.path), u.rule, u.reason, numbersOf(doc, u.decisions).join(", "), lockNote(doc, u.locks)]),
    ),
  );
  push(
    "## Untagged unions",
    "",
    "A value of each of these fields takes one of two or more forms, and nothing in it names its form. A receiver tells the forms apart only by trying each one. A tag, a member that names the form, would let a schema say which form a value takes.",
    "",
    ...table(
      ["Rests on", "Forms", "Only on"],
      doc.unions.map((u) => [
        restsOn(u.sources),
        u.forms.length === 1 ? u.forms[0]!.forms.join("; or ") : u.forms.map((f) => `${lockNote(doc, f.locks)}: ${f.forms.join("; or ")}`).join(". "),
        lockNote(doc, u.locks),
      ]),
    ),
  );
  push(
    "## Conditions a schema can't state",
    "",
    "A conditional field whose condition doesn't name another field and its value. JSON Schema can't state it, so the condition becomes a rule with test vectors.",
    "",
    ...table(["Condition", "Only on"], doc.conditions.map((c) => [c.text, lockNote(doc, c.locks)])),
  );
  push(
    "## Tables rendered back from the schemas",
    "",
    "The field and key tables rendered back from the generated schemas equal the specification's, except in these cells.",
    "",
    ...table(
      ["Row", "Column", "Specification", "Generated", "Why", "Only on"],
      doc.round_trip.map((d) => [code(d.row.split(":").slice(2).join(":")), d.column, d.spec, d.model, d.reason, lockNote(doc, d.locks)]),
    ),
  );

  const linesOn = `Lines on ${base!.label}`;
  push(
    "## Lint findings, by authoring rule",
    "",
    `Each finding is listed under the authoring rule from ${issue} that removes it, with the inputs it appears on. **${linesOn}** links the spec lines at ${code(base!.commit.slice(0, 7))}; a finding that appears only ${rest.map((l) => l.phrase).join(" or ")} has no line there. The list leaves out the findings we reviewed and set aside: names from other standards, deliberate references, and false positives. We set aside ${doc.locks.map((l) => `${doc.set_aside[l.name] ?? 0} ${l.phrase}`).join(" and ")}. A finding's places are on ${doc.locks.length === 2 ? "both inputs" : "every input"}, unless the **Where** column says that a place is only on one.`,
    "",
  );
  const label = (lock: string) => doc.locks.find((l) => l.name === lock)?.label ?? code(lock);
  const phrase = (lock: string) => doc.locks.find((l) => l.name === lock)?.phrase ?? code(lock);
  const sectionsText = (xs: string[]) => [...new Set(xs.map((x) => `§ ${x.split("/")[0]}`))];
  // A place a finding has on every lock it has, and apart, each place it has only on some of them.
  const whereOf = (f: LintItem) => {
    const per = f.messages.map((m) => ({ lock: m.lock, sections: sectionsText(m.sections) }));
    const common = per[0]!.sections.filter((x) => per.every((p) => p.sections.includes(x)));
    const extra = per.map((p) => ({ lock: p.lock, sections: p.sections.filter((x) => !common.includes(x)) })).filter((p) => p.sections.length > 0);
    return [common.join(", "), ...extra.map((p) => `${phrase(p.lock)}${common.length > 0 ? ", also" : ","} ${p.sections.join(", ")}`)].filter((x) => x !== "").join("; ");
  };
  const CHECKED: Record<string, string> = { rule: "Conformance test vectors, of a rule on one payload", schema: "Conformance test vectors, of the schemas, which state it", seller: "An obligation on the seller", buyer: "An obligation on the buyer", consumer: "An obligation on whoever reads the record", implementation: "An obligation on an implementation" };
  const checkedOf = (f: LintItem) => {
    const per = f.messages.map((m) => ({ lock: m.lock, text: m.checked !== undefined ? (CHECKED[m.checked] ?? m.checked) : "" }));
    const distinct = [...new Set(per.map((p) => p.text))];
    return distinct.length === 1 ? distinct[0]! : per.map((p) => `${label(p.lock)}: ${p.text}`).join(" ");
  };
  const placed = doc.groups.find((g) => g.id === "statements")?.decisions.map((d) => d.number) ?? [];
  for (const r of doc.findings) {
    const title = /^\d$/.test(r.rule) ? `${r.rule}. ${r.title}` : r.title;
    push(`### ${title}`, "");
    const intro = fb.rules.find((x) => x.id === r.rule)?.intro;
    if (intro !== undefined && r.findings.length > 0) push(intro, "");
    if (r.rule === "statements") {
      const decided = placed.length === 0 ? "The decisions on where each statement is checked say how it is checked." : `Decisions ${placed[0]} to ${placed.at(-1)}, on where each statement is checked, say how it is checked.`;
      push(`Each MUST statement names no field or key, so no authoring rule removes it. ${decided} It needs conformance test vectors, of a rule on one payload or of the schemas, which state it. Or it binds a party, which a payload can't show.`, "");
    }
    const checked = r.rule === "statements";
    push(
      ...table(
        ["Finding", "Where", ...(checked ? ["Checked as"] : []), linesOn, ...doc.locks.map((l) => l.label)],
        r.findings.map((f) => {
          const distinct = [...new Set(f.messages.map((m) => m.message))];
          const text = distinct.length === 1 ? distinct[0]! : f.messages.map((m) => `${label(m.lock)}: ${m.message}`).join(" ");
          const links = lineLinks(doc, f).map((x) => `[§ ${x.section}, line ${x.line}](${x.url})`).join(", ");
          return [text, whereOf(f), ...(checked ? [checkedOf(f)] : []), links, ...doc.locks.map((l) => (f.messages.some((m) => m.lock === l.name) ? "yes" : "no"))];
        }),
        [":---", ":---", ...(checked ? [":---"] : []), ":---", ...doc.locks.map(() => ":---:")],
      ),
    );
  }
  return lines(out);
}
