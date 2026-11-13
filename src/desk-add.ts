/**
 * The intake of a desk-test set: `npm run desk:add -- <gist-url | path>
 * <set>` copies the payloads of a gist, at its current revision, or of a
 * local folder, into `desk-tests/<set>/` of a spec's folder, runs each one
 * through every engine of the desk-tests gate on the lock the set names, and
 * writes a draft of the set's `expected.yaml` and `README.md` for review.
 *
 * The draft records a verdict only where every engine gives it: a payload
 * every engine accepts is clean, and a payload every engine rejects at the
 * same places gets a finding at each, with the kind the schemas give it; a
 * rule's finding that no SDK type checks is an SDK gap, as the gate reads
 * one. Every reason the draft writes is the review marker, which the
 * desk-tests gate fails on, so the set can't pass CI until someone writes
 * why each payload gets its verdict. A payload the engines disagree on stays
 * out of the draft, where the gate fails on it as a payload the expected
 * file doesn't list, and the intake reports where each engine rejects it.
 * The intake writes files only; it never commits.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stringify } from "yaml";
import { PROPOSED } from "./builds.ts";
import { constructorEditionsOn, kernelEditionsOn } from "./editions.ts";
import { loadConstructors } from "./constructors.ts";
import { deskSdks, DESK_TESTS_DIR, DESK_TESTS_FILE, loadDeskPayloads, REVIEW_MARK, runDeskChecker, runDeskSdks, type CheckerRun, type DeskFinding, type DeskSdkGap, type DeskTests, type DeskUndecided } from "./desk-tests.ts";
import { emitSchemas, schemaDirOf } from "./emit.ts";
import { checkExamples, type Failure } from "./examples.ts";
import { loadKernel } from "./kernel.ts";
import type { SpecLock } from "./lock.ts";
import { loadDecisions, loadMappings } from "./mapping.ts";
import { resolveModel } from "./model.ts";
import { codesOf } from "./rule-checks.ts";
import { sdkDirOf } from "./sdk.ts";
import { loadPrograms } from "./rule-programs.ts";
import { ruleChecksOf, schemaNamesOfLock } from "./specs/index.ts";

/** Where a set's files come from: a gist at one revision, or a local folder that stands in for one. */
export interface DeskSource {
  kind: "gist" | "path";
  /** The gist's URL, or the folder's path, as the command named it. */
  ref: string;
  gist?: { id: string; revision: string; owner: string | null; url: string; description: string | null; updated: string | null };
  /** Every file of the source, by name. */
  files: Map<string, Buffer>;
}

/** A payload's file name, as `desk-tests/desk-tests.schema.json` takes it. */
export const PAYLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(yaml|json)$/;

/** A set's folder name, as a spec's other folders are named. */
export const SET_NAME = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/** The gist ID a URL or a bare ID names: `https://gist.github.com/<owner>/<id>`, with an optional revision or fragment, or `<id>`. */
export function gistIdOf(ref: string): string | null {
  const bare = /^[0-9a-f]{20,40}$/.exec(ref);
  if (bare) return bare[0];
  const m = /^https:\/\/gist\.github\.com\/(?:[A-Za-z0-9-]+\/)?([0-9a-f]{20,40})(?:\/[0-9a-f]{40})?\/?(?:[#?].*)?$/.exec(ref);
  return m ? m[1]! : null;
}

/** Reads a gist at its current revision, read-only, with `gh api gists/<id>`. Throws for a file the API truncates, whose bytes it doesn't give. */
export function readGist(ref: string, gh: (args: string[]) => string = runGh): DeskSource {
  const id = gistIdOf(ref);
  if (id === null) throw new Error(`"${ref}" names no gist: give its URL, https://gist.github.com/<owner>/<id>, or a local folder`);
  const doc = JSON.parse(gh(["api", `gists/${id}`])) as {
    id: string;
    html_url: string;
    description: string | null;
    updated_at: string | null;
    owner?: { login: string } | null;
    history?: { version: string }[];
    files: Record<string, { filename: string; content?: string; truncated?: boolean }>;
  };
  const revision = doc.history?.[0]?.version;
  if (revision === undefined) throw new Error(`gist ${id}: the API gives no revision`);
  const files = new Map<string, Buffer>();
  for (const f of Object.values(doc.files)) {
    if (f.truncated || f.content === undefined) throw new Error(`gist ${id}: ${f.filename} is too large for the API to give in full; fetch the gist with git and give its folder instead`);
    files.set(f.filename, Buffer.from(f.content, "utf8"));
  }
  return { kind: "gist", ref, gist: { id: doc.id, revision, owner: doc.owner?.login ?? null, url: doc.html_url, description: doc.description, updated: doc.updated_at }, files };
}

function runGh(args: string[]): string {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`gh: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`gh ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ")}`);
  return r.stdout;
}

/** Reads every regular file of a local folder, which stands in for a gist. */
export function readFolder(path: string): DeskSource {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${path} is no folder`);
  const files = new Map<string, Buffer>();
  for (const name of readdirSync(path).sort()) {
    const p = join(path, name);
    if (!name.startsWith(".") && statSync(p).isFile()) files.set(name, readFileSync(p));
  }
  return { kind: "path", ref: path, files };
}

/** The source a command names: a local folder where one exists, else a gist. */
export const readSource = (ref: string): DeskSource => (existsSync(ref) ? readFolder(ref) : readGist(ref));

/** One payload's places of rejection in one engine, sorted; a schemas finding keeps its kind and rule. */
interface EnginePaths {
  engine: string;
  paths: string[];
}

/** A payload the engines disagree on, with where each rejects it. */
export interface DeskDisagreement {
  example: string;
  engines: EnginePaths[];
}

/** What the intake wrote and found. */
export interface DeskAddResult {
  dir: string;
  payloads: string[];
  skipped: string[];
  clean: string[];
  rejected: string[];
  disagreements: DeskDisagreement[];
  /** The report of the run, which the command prints and writes to `build/desk-add-<set>.md`. */
  report: string;
}

const shown = (paths: string[]) => (paths.length === 0 ? "clean" : `rejected at ${paths.map((p) => (p === "" ? "/" : p)).join(", ")}`);
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

/**
 * Judges each payload with every engine and drafts the expected file: the
 * schemas and rules, as the gate checks them; the lock's checker; and each
 * SDK of the build the schemas are. A payload with the same places in every
 * engine is agreed, a rule's place that every SDK accepts included, as an SDK
 * gap; any other is a disagreement.
 */
export function draftExpected(input: {
  set: Omit<DeskTests, "file" | "dir">;
  failures: Failure[];
  undecided: { example: string; path: string; rule: string }[];
  checker: CheckerRun;
  sdks: CheckerRun[];
  /** The rules the SDKs check, whose programs they are generated with; a rule's finding beyond them is an SDK gap. */
  sdkRules?: ReadonlySet<string>;
}): { expected: Omit<DeskTests, "file" | "dir">; clean: string[]; rejected: string[]; disagreements: DeskDisagreement[] } {
  const { set } = input;
  const findings: DeskFinding[] = [];
  const gaps: DeskSdkGap[] = [];
  const undecided: DeskUndecided[] = [];
  const clean: string[] = [];
  const rejected: string[] = [];
  const disagreements: DeskDisagreement[] = [];
  for (const name of set.examples) {
    const schemaFailures = input.failures.filter((f) => f.example === name);
    const schemaPaths = sorted(schemaFailures.map((f) => f.path));
    // A place where every schemas finding is a rule's is beyond the SDK types, which check what the schemas check.
    const rulePaths = schemaPaths.filter((p) => schemaFailures.filter((f) => f.path === p).every((f) => f.kind === "rule" && !input.sdkRules?.has(f.rule ?? "")));
    const sdkWant = schemaPaths.filter((p) => !rulePaths.includes(p));
    const checkerPaths = sorted(input.checker.failures.filter((f) => f.example === name).map((f) => f.path));
    const sdkPaths = input.sdks.map((s) => ({ engine: s.label, paths: sorted(s.failures.filter((f) => f.example === name).map((f) => f.path)) }));
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    if (!same(checkerPaths, schemaPaths) || !sdkPaths.every((s) => same(s.paths, sdkWant))) {
      disagreements.push({ example: name, engines: [{ engine: "the schemas and rules", paths: sorted(schemaFailures.map((f) => `${f.path}${f.kind === "rule" ? ` (${f.rule})` : ""}`)) }, { engine: input.checker.label, paths: checkerPaths }, ...sdkPaths] });
      continue;
    }
    if (schemaPaths.length === 0) clean.push(name);
    else rejected.push(name);
    for (const f of schemaFailures) {
      if (findings.some((x) => x.example === name && x.path === f.path && x.kind === f.kind && x.rule === f.rule)) continue;
      findings.push({ example: name, path: f.path, kind: f.kind, ...(f.kind === "rule" && f.rule ? { rule: f.rule } : {}), reason: REVIEW_MARK });
      if (f.kind === "rule" && f.rule && rulePaths.includes(f.path)) gaps.push({ example: name, path: f.path, rule: f.rule, reason: REVIEW_MARK });
    }
    for (const u of input.undecided.filter((x) => x.example === name)) undecided.push({ example: name, path: u.path, rule: u.rule, reason: REVIEW_MARK });
  }
  const agreed = new Set([...clean, ...rejected]);
  return { expected: { ...set, examples: set.examples.filter((n) => agreed.has(n)), findings, undecided, sdk_gaps: gaps }, clean, rejected, disagreements };
}

/** The comment lines of a source's files that say their contents are invented, quoted as written, each once. */
export function inventedLines(files: Map<string, Buffer>): string[] {
  const out: string[] = [];
  for (const bytes of files.values()) {
    for (const line of bytes.toString("utf8").split("\n")) {
      if (!/^\s*#/.test(line)) continue;
      const text = line.replace(/^\s*#\s?/, "").trim();
      if (/\binvented\b/i.test(text) && !out.includes(text)) out.push(text);
    }
  }
  return out;
}

/** The draft README of a set: where the files come from, at which revision and on which day, and what the files say of themselves, quoted. */
export function draftReadme(i: { set: string; source: DeskSource; payloads: string[]; skipped: string[]; date: string; lock: string; verdicts: Map<string, string> }): string {
  const { source } = i;
  const from =
    source.kind === "gist"
      ? `copied unchanged from the gist <${source.gist!.url}>${source.gist!.owner ? ` of [@${source.gist!.owner}](https://github.com/${source.gist!.owner})` : ""}, at revision \`${source.gist!.revision}\`, on ${i.date}`
      : `copied unchanged from the local folder \`${basename(source.ref)}\` on ${i.date}`;
  const invented = inventedLines(new Map([...source.files].filter(([n]) => i.payloads.includes(n))));
  const lines = [
    `# ${i.set} desk-test payloads`,
    "",
    `These ${i.payloads.length} payloads are ${from}.${source.gist?.description ? ` The gist's description: "${source.gist.description}".` : ""}`,
    "",
    `${REVIEW_MARK}: say who wrote them, for what, and the permission to include them, with its date, as the other sets' READMEs do; list them in NOTICE, and credit the author under Acknowledgements.`,
    "",
    ...(invented.length > 0 ? ["The files say of themselves:", "", ...invented.map((l) => `> ${l}`), ""] : []),
    ...(i.skipped.length > 0 ? [`The source's other files, which are no payloads, aren't copied: ${i.skipped.map((n) => `\`${n}\``).join(", ")}.`, ""] : []),
    "## What they check",
    "",
    `[\`expected.yaml\`](expected.yaml) records the verdict each file must get on the \`${i.lock}\` lock, from the five engines of the desk-tests gate: the lock's schemas and rules, the stack's own checker at the lock's commit, and the TypeScript, Python, and Go SDKs. \`npm run ci\` runs the gate, so a verdict that changes in any engine fails CI.`,
    "",
    "| File | What it tests | Verdict |",
    "|:--|:--|:--|",
    ...i.payloads.map((n) => `| \`${n.replace(/\.(yaml|json)$/, "")}\` | ${REVIEW_MARK} | ${i.verdicts.get(n) ?? "the engines disagree; see the intake's report"} |`),
    "",
  ];
  return lines.join("\n");
}

/** The header of a draft expected file. */
const HEADER = (set: string, lock: string) =>
  [
    `# DRAFT: the verdicts \`npm run desk:add\` drafted for the ${set} desk tests on the`,
    `# ${lock} lock, where every engine of the desk-tests gate agrees. Every reason`,
    `# is "${REVIEW_MARK}", which fails the gate: write why each payload gets its`,
    "# verdict, with the section or issue that says so, and the reason each check",
    "# is undecided or beyond the SDKs, and list any payload the engines disagree",
    "# on once its verdict is decided. Then remove this paragraph.",
    "",
  ].join("\n");

/**
 * Adds a set: writes the source's payloads into the spec's
 * `desk-tests/<set>/`, judges them with every engine on the lock, and writes
 * the draft expected file, the draft README, and the report. Refuses a set
 * that exists, so a reviewed set is never overwritten.
 */
export async function deskAdd(i: {
  source: DeskSource;
  set: string;
  specDir: string;
  lock: SpecLock;
  root: string;
  date: string;
  work: string;
  document?: string;
  checker?: string;
  /** The folder the set's folder goes in: the spec's `desk-tests/` unless given, as a test gives a temporary one. */
  into?: string;
}): Promise<DeskAddResult> {
  if (!SET_NAME.test(i.set)) throw new Error(`"${i.set}" is no set name: lower case, digits, and hyphens, as iab-au-2026-11`);
  const dir = join(i.into ?? join(i.specDir, DESK_TESTS_DIR), i.set);
  if (existsSync(dir)) throw new Error(`${dir} exists; a set is added once, and a reviewed one is never overwritten`);
  const payloads = [...i.source.files.keys()].filter((n) => PAYLOAD_NAME.test(n) && n !== DESK_TESTS_FILE).sort();
  const skipped = [...i.source.files.keys()].filter((n) => !payloads.includes(n)).sort();
  if (payloads.length === 0) throw new Error(`${i.source.ref} holds no payload, a .yaml or .json file`);
  const checker = i.checker ?? "scripts/check_examples.py";
  if (!(checker in i.lock.scripts)) throw new Error(`the lock "${i.lock.name}" pins no ${checker}`);

  mkdirSync(dir, { recursive: true });
  try {
    return await judge(i, dir, payloads, skipped, checker);
  } catch (e) {
    // A run that fails leaves no half-written set behind.
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

async function judge(i: Parameters<typeof deskAdd>[0], dir: string, payloads: string[], skipped: string[], checker: string): Promise<DeskAddResult> {
  for (const n of payloads) writeFileSync(join(dir, n), i.source.files.get(n)!);
  const base: Omit<DeskTests, "file" | "dir"> = { format: 1, lock: i.lock.name, document: i.document ?? "LineItem", checker, examples: payloads, findings: [], undecided: [], sdk_gaps: [], checker_only: [] };
  const set: DeskTests = { ...base, file: join(dir, DESK_TESTS_FILE), dir };
  const values = loadDeskPayloads(dir);

  // The schemas and rules, as the desk-tests gate checks a payload.
  const mappings = loadMappings(join(i.specDir, "mapping"));
  const decisions = loadDecisions(join(i.specDir, "decisions"));
  const kernelAll = loadKernel(i.root, i.specDir);
  const kernel = kernelEditionsOn(kernelAll, i.lock.name);
  const ir = JSON.parse(readFileSync(join(i.specDir, i.lock.ir_dir, "spec-ir.json"), "utf8"));
  const resolved = resolveModel({ ir, lock: i.lock.name, mappings, decisions, kernel, constructors: constructorEditionsOn(loadConstructors(i.root, i.specDir), i.lock.name) });
  if (resolved.problems.length > 0) throw new Error(`the lock "${i.lock.name}" doesn't resolve: ${resolved.problems[0]}`);
  const schemaDir = schemaDirOf(i.lock.ir_dir);
  const files = emitSchemas(resolved.model, schemaDir, schemaNamesOfLock(i.lock)).files;
  const r = checkExamples({
    model: resolved.model,
    files,
    schemaDir,
    examples: payloads.map((id) => ({ id, ir: `desk:${i.set}`, object: set.document, part: false })),
    values,
    codes: codesOf(kernelAll.lists ?? { lists: [] }),
    ruleChecks: ruleChecksOf(i.lock),
  });
  if (r.problems.length > 0) throw new Error(`the schemas can't judge the payloads: ${r.problems[0]}`);
  // The lock's checker, and each SDK.
  const checkerRun = await runDeskChecker(i.lock, set, join(i.work, "checker"), i.root);
  const sdks = await runDeskSdks(set, values, deskSdks(join(i.root, sdkDirOf(i.lock.ir_dir, PROPOSED))), join(i.work, "sdks"), i.root);
  const problems = [...checkerRun.problems, ...sdks.flatMap((s) => s.problems)];
  if (problems.length > 0) throw new Error(`an engine didn't run: ${problems.join("; ")}`);

  const draft = draftExpected({ set: base, failures: r.failures, undecided: r.checks.undecided, checker: checkerRun, sdks, sdkRules: new Set(Object.keys(loadPrograms(i.specDir).rules)) });
  writeFileSync(set.file, HEADER(i.set, i.lock.name) + stringify(draft.expected, { lineWidth: 0 }));
  const verdicts = new Map<string, string>();
  for (const n of draft.clean) verdicts.set(n, "Clean");
  for (const n of draft.rejected) verdicts.set(n, `Rejected at ${sorted(draft.expected.findings.filter((f) => f.example === n).map((f) => `\`${f.path === "" ? "/" : f.path}\``)).join(", ")}`);
  writeFileSync(join(dir, "README.md"), draftReadme({ set: i.set, source: i.source, payloads, skipped, date: i.date, lock: i.lock.name, verdicts }));

  const engines = [`the schemas and rules`, checkerRun.label, ...sdks.map((s) => s.label)];
  const report = [
    `# Desk-test intake: ${i.set}`,
    "",
    `Source: ${i.source.kind === "gist" ? `gist ${i.source.gist!.id} at revision ${i.source.gist!.revision}` : `the folder ${i.source.ref}`}, read on ${i.date}.`,
    `Lock: ${i.lock.name} at ${i.lock.commit.slice(0, 7)}. Engines: ${engines.join(", ")}.`,
    "",
    `- ${payloads.length} payloads written to ${dir}${skipped.length > 0 ? `; ${skipped.length} other files not copied: ${skipped.join(", ")}` : ""}.`,
    `- ${draft.clean.length} clean in every engine, ${draft.rejected.length} rejected at the same places in every engine: drafted in expected.yaml, every reason "${REVIEW_MARK}".`,
    `- ${draft.expected.sdk_gaps.length} SDK gaps, ${draft.expected.undecided.length} undecided checks: drafted, every reason "${REVIEW_MARK}".`,
    `- ${draft.disagreements.length} payloads the engines disagree on, left out of expected.yaml${draft.disagreements.length > 0 ? ":" : "."}`,
    ...draft.disagreements.flatMap((d) => ["", `## ${d.example}`, "", ...d.engines.map((e) => `- ${e.engine}: ${shown(e.paths)}`)]),
    "",
    `Review expected.yaml and README.md: the desk-tests gate fails until every "${REVIEW_MARK}" is written and every payload is listed. Nothing is committed.`,
    "",
  ].join("\n");
  return { dir, payloads, skipped, clean: draft.clean, rejected: draft.rejected, disagreements: draft.disagreements, report };
}
