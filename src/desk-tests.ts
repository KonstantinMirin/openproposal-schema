/**
 * Desk tests: payloads that someone outside this repository wrote to test a
 * lock's text, kept as fixtures with the verdict each must get. A set is a
 * folder `desk-tests/<set>/` in a spec's folder, with its payloads and an
 * `expected.yaml` (desk-tests/desk-tests.schema.json). Every engine judges
 * every payload, and each must give the recorded verdict: this repository's
 * schemas and rules, through the examples gate's own check; the lock's own
 * checker, a script of the specification repository that the lock pins by
 * blob and keeps in its snapshot, run on the lock's specification and
 * examples with the set's payloads added to `examples/`; and each SDK the
 * lock's schemas generate, TypeScript, Python, and Go, through the entry
 * point an implementer calls to check a document. A set needs no code: the
 * gate reads every folder under `desk-tests/`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { checkExamples, loadJsonYaml, type Loaded, type ModelExample } from "./examples.ts";
import type { EmittedFile } from "./emit.ts";
import { materialize, materializeExamples, materializeScripts } from "./fetch.ts";
import type { SpecLock } from "./lock.ts";
import { readYaml } from "./mapping.ts";
import type { ModelDoc } from "./model.ts";
import { compileSchema } from "./pipeline.ts";
import { REPO_ROOT } from "./repo.ts";
import type { Check } from "./rule-checks.ts";
import { findingsGo, findingsPython, findingsTypeScript, locationsOf, type SdkFindingsRun } from "./sdk-parity.ts";

/** One payload's expected rejection: where it fails, which is the same location in both engines. */
export interface DeskFinding {
  example: string;
  /** The JSON pointer of the failing location. */
  path: string;
  /** How the schemas and rules reject it, as an example finding's `kind`. */
  kind: "load" | "invalid" | "undefined_key" | "rule";
  rule?: string;
  reason: string;
}

/** A rule's check that a payload's values can't decide, as an example's undecided check. */
export interface DeskUndecided {
  example: string;
  path: string;
  rule: string;
  reason: string;
}

/**
 * A finding the SDKs don't make: a rule's, which no SDK type checks, since
 * the types check what the schemas check and a rule is what they can't
 * (type rules § 9). Each SDK accepts the payload there, as the schema does.
 */
export interface DeskSdkGap {
  example: string;
  path: string;
  rule: string;
  reason: string;
}

export interface DeskTests {
  format: 1;
  /** The lock whose text the payloads test. */
  lock: string;
  /** The document every payload is. */
  document: string;
  /** The lock's checker: a script the lock pins under `scripts`. */
  checker: string;
  /** Every payload of the set, by file name; a payload with no finding must be clean. */
  examples: string[];
  findings: DeskFinding[];
  undecided: DeskUndecided[];
  sdk_gaps: DeskSdkGap[];
  /** The expected file's path, and its folder, which holds the payloads. */
  file: string;
  dir: string;
}

export const DESK_TESTS_DIR = "desk-tests";
export const DESK_TESTS_FILE = "expected.yaml";
const DESK_TESTS_SCHEMA = join("desk-tests", "desk-tests.schema.json");

/** The expected files of a spec's desk-test sets, `desk-tests/<set>/expected.yaml`, sorted. */
export function deskTestFiles(specDir: string): string[] {
  const root = join(specDir, DESK_TESTS_DIR);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(root, e.name, DESK_TESTS_FILE))
    .sort();
}

/** Loads and validates a set's expected file. */
export function loadDeskTests(file: string): DeskTests {
  const doc = readYaml(file);
  const errors = compileSchema(join(REPO_ROOT, DESK_TESTS_SCHEMA))(doc);
  if (errors.length > 0) throw new Error(`${file}: not a valid desk-tests file: ${errors.join("; ")}`);
  return { ...(doc as Omit<DeskTests, "file" | "dir">), file, dir: dirname(file) };
}

/** The payloads in a set's folder, by file name, loaded as the examples are; the expected file isn't one. */
export function loadDeskPayloads(dir: string): Map<string, Loaded> {
  const out = new Map<string, Loaded>();
  for (const name of readdirSync(dir).sort()) {
    if (name === DESK_TESTS_FILE || name === "README.md") continue;
    out.set(name, loadJsonYaml(readFileSync(join(dir, name), "utf8")));
  }
  return out;
}

/** One rejection a checker reports, at a JSON pointer. */
export interface CheckerFailure {
  example: string;
  path: string;
  message: string;
}

/** What an engine beside the schemas said about a set's payloads: the lock's checker, run on the lock's examples with the payloads added, or an SDK. */
export interface CheckerRun {
  /** The engine, such as the checker and the commit it is pinned at, or the SDK and its runtime, for the messages. */
  label: string;
  failures: CheckerFailure[];
  /** What keeps the run from giving verdicts: no pinned script, a crash, output it can't parse, or a failure of the lock's own examples. */
  problems: string[];
}

/** One SDK of a lock: its language, and the absolute path of its tree in that language. */
export interface DeskSdk {
  language: "TypeScript" | "Python" | "Go";
  dir: string;
}

/** The SDKs of a lock's tree, `sdkDir`, such as sdk/proposed/with-our-stack, one per language its `ts/`, `python/`, and `go/` hold. */
export function deskSdks(sdkDir: string): DeskSdk[] {
  return [
    { language: "TypeScript", dir: join(sdkDir, "ts") },
    { language: "Python", dir: join(sdkDir, "python") },
    { language: "Go", dir: join(sdkDir, "go") },
  ];
}

const runtimeOf = (engine: string) => engine.replace(/^(TypeScript|Python) with /, "").replace(/^Go /, "");

/**
 * Runs each SDK on a set's payloads, as an implementer checks a received
 * document: TypeScript in this process, Python under the venv, and Go under
 * the local toolchain, by the parity gate's harnesses (src/sdk-parity.ts).
 * Every path an SDK reports becomes a JSON pointer by `pointerIn`
 * (src/sdk-parity.ts), and the findings at one location become one. A payload that doesn't load never
 * reaches an SDK, so every SDK rejects it at the root, as the schemas do. A
 * run that fails is a problem of that SDK's run.
 */
export async function runDeskSdks(set: DeskTests, payloads: Map<string, Loaded>, sdks: DeskSdk[], work: string, root: string = REPO_ROOT): Promise<CheckerRun[]> {
  const names = set.examples.filter((n) => payloads.has(n));
  const loaded = names.filter((n) => payloads.get(n)!.ok);
  const values = loaded.map((n) => (payloads.get(n) as Extract<Loaded, { ok: true }>).value);
  const items = values.map((value) => ({ type: set.document, value }));
  const out: CheckerRun[] = [];
  for (const sdk of sdks) {
    let label = `the ${sdk.language} SDK`;
    let r: SdkFindingsRun;
    try {
      if (sdk.language === "TypeScript") r = await findingsTypeScript(sdk.dir, items);
      else if (sdk.language === "Python") r = findingsPython(root, sdk.dir, items);
      else r = findingsGo(sdk.dir, join(work, "sdk-go"), items);
    } catch (e) {
      out.push({ label, failures: [], problems: [`${label} didn't run: ${(e as Error).message.split("\n")[0]}`] });
      continue;
    }
    label = `the ${sdk.language} SDK (${runtimeOf(r.engine)})`;
    if (r.findings.length !== values.length) {
      out.push({ label, failures: [], problems: [`${label} gave ${r.findings.length} verdicts for ${values.length} payloads`] });
      continue;
    }
    const failures: CheckerFailure[] = [];
    for (const n of names) {
      const l = payloads.get(n)!;
      if (!l.ok) failures.push({ example: n, path: "", message: `doesn't load, so it never reaches the SDK: ${l.problems.join("; ")}` });
    }
    loaded.forEach((n, i) => {
      for (const [path, ms] of locationsOf(values[i], r.findings[i]!)) failures.push({ example: n, path, message: ms.join("; ") });
    });
    out.push({ label, failures, problems: [] });
  }
  return out;
}

/** A checker's dotted location, such as `exclusivity.available[0]`, as a JSON pointer. */
export function pointerOf(dotted: string): string {
  return (dotted.match(/[^.[\]]+|\[\d+\]/g) ?? []).map((p) => `/${p.replace(/^\[|\]$/g, "").replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

const DOTTED = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/;

/**
 * Reads the output of the stack's `scripts/check_examples.py`: a header line,
 * then one line per error, `  - <file>: <location>: <message>`, or
 * `  - <file>: <message>` for the whole file. A key the table doesn't list
 * is reported at its object, so its pointer gains the key, as the schemas
 * report it.
 */
export function parseCheckerOutput(stdout: string): { failures: CheckerFailure[]; unparsed: string[] } {
  const failures: CheckerFailure[] = [];
  const unparsed: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "" || line.startsWith("Examples disagree with the specification")) continue;
    const m = /^ {2}- ([^:\s]+): (.*)$/.exec(line);
    if (!m) {
      unparsed.push(line);
      continue;
    }
    const [, example, rest] = m as unknown as [string, string, string];
    const at = rest.indexOf(": ");
    const head = at < 0 ? "" : rest.slice(0, at);
    if (head !== "" && DOTTED.test(head)) {
      const message = rest.slice(at + 2);
      const key = /^key '([^']+)' is not in /.exec(message);
      failures.push({ example, path: pointerOf(head) + (key ? `/${key[1]!.replace(/~/g, "~0").replace(/\//g, "~1")}` : ""), message });
    } else failures.push({ example, path: "", message: rest });
  }
  return { failures, unparsed };
}

/**
 * Runs the lock's checker on a fresh tree in `work`: the lock's
 * specification, its examples, and its pinned scripts, each blob-verified
 * from the lock's sources, with the set's payloads added to `examples/`.
 * The lock's own examples must pass, so every failure the run reports is a
 * payload's. The checker runs under the oracle venv's Python, which has
 * PyYAML from `setup:plaingen`.
 */
export async function runDeskChecker(lock: SpecLock, set: DeskTests, work: string, root: string = REPO_ROOT): Promise<CheckerRun> {
  const label = `${set.checker} at ${lock.commit.slice(0, 7)}`;
  if (!(set.checker in lock.scripts)) return { label, failures: [], problems: [`${basename(lock.file)} pins no ${set.checker} under scripts; pin its blob at ${lock.commit.slice(0, 7)} and rewrite the snapshot`] };
  const python = join(root, ".venv", "bin", "python");
  if (!existsSync(python)) return { label, failures: [], problems: ["no oracle venv at .venv; run: npm run setup:oracle and npm run setup:plaingen"] };
  const spec = await materialize(lock);
  const examples = await materializeExamples(lock);
  const scripts = await materializeScripts(lock);
  rmSync(work, { recursive: true, force: true });
  const put = (path: string, bytes: Buffer) => {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), bytes);
  };
  put(lock.path, spec.bytes);
  for (const [p, bytes] of examples.files) put(p, bytes);
  for (const [p, bytes] of scripts.files) put(p, bytes);
  const problems: string[] = [];
  for (const name of set.examples) {
    const to = `examples/${name}`;
    if (examples.files.has(to)) problems.push(`${name} has the name of one of the lock's own examples`);
    else put(to, readFileSync(join(set.dir, name)));
  }
  if (problems.length > 0) return { label, failures: [], problems };
  const r = spawnSync(python, ["-I", "-B", set.checker], { cwd: work, encoding: "utf8", env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" } });
  const stdout = r.stdout ?? "";
  if (r.error) return { label, failures: [], problems: [`${label} didn't run: ${r.error.message}`] };
  if (r.status !== 0 && r.status !== 1) return { label, failures: [], problems: [`${label} exited ${r.status}: ${`${stdout}${r.stderr ?? ""}`.trim().split("\n").slice(-3).join(" / ")}`] };
  if (r.status === 1 && !stdout.startsWith("Examples disagree with the specification")) return { label, failures: [], problems: [`${label} exited 1 without its report: ${`${stdout}${r.stderr ?? ""}`.trim().split("\n").slice(-3).join(" / ")}`] };
  const parsed = parseCheckerOutput(r.status === 0 ? "" : stdout);
  for (const l of parsed.unparsed) problems.push(`${label} printed a line the gate can't read: ${l.trim()}`);
  const ours = new Set(set.examples);
  for (const f of parsed.failures) if (!ours.has(f.example)) problems.push(`${label} rejects the lock's own ${f.example}${f.path ? ` at ${f.path}` : ""}: ${f.message}`);
  return { label, failures: parsed.failures.filter((f) => ours.has(f.example)), problems };
}

/** What the desk-tests gate compares: one set, the lock's schemas and rule checks, the payloads, and the checker's run. */
export interface DeskTestsInput {
  set: DeskTests;
  model: ModelDoc;
  files: EmittedFile[];
  schemaDir: string;
  /** The payloads in the set's folder, by file name. */
  payloads: Map<string, Loaded>;
  codes: ReadonlyMap<string, ReadonlySet<string | number>>;
  ruleChecks: Readonly<Record<string, Check>>;
  checker: CheckerRun;
  /** Each SDK's run, by `runDeskSdks`; none for a spec whose profile names no SDK packages. */
  sdks: CheckerRun[];
}

/** One payload's verdict from each engine, for a report line. */
export interface DeskVerdict {
  example: string;
  expected: string;
  schemas: string;
  checker: string;
  /** Each SDK's verdict, by its run's label. */
  sdks: Record<string, string>;
}

const where = (f: { path: string; kind?: string; rule?: string }) => `${f.path === "" ? "/" : f.path}${f.kind ? ` (${f.kind}${f.rule ? ` ${f.rule}` : ""})` : ""}`;

/**
 * Compares every engine's verdicts with the expected file: the folder holds
 * exactly the payloads it lists; each payload with a finding fails the
 * schemas and rules at its location, with its kind and rule, fails the
 * checker at that location, and fails each SDK there, unless the finding is
 * a rule's that `sdk_gaps` records, and fails at no other location in any
 * engine; each other payload passes every engine; each SDK gap is a rule's
 * finding of the set; and the rules' undecided checks are the recorded
 * ones. It returns each payload's verdicts too.
 */
export function checkDeskTests(i: DeskTestsInput): { problems: string[]; verdicts: DeskVerdict[] } {
  const { set } = i;
  const problems: string[] = [...i.checker.problems, ...i.sdks.flatMap((s) => s.problems)];
  const listed = new Set(set.examples);
  const expectedFile = set.file.split("/").slice(-2).join("/");
  for (const name of i.payloads.keys()) if (!listed.has(name)) problems.push(`${set.file}: ${name} is in the folder and isn't listed under examples`);
  for (const name of set.examples) if (!i.payloads.has(name)) problems.push(`${set.file}: lists ${name}, which isn't in the folder`);
  for (const f of [...set.findings, ...set.undecided, ...set.sdk_gaps]) if (!listed.has(f.example)) problems.push(`${set.file}: ${f.example} isn't listed under examples`);
  const gapAt = (example: string, path: string) => set.sdk_gaps.find((g) => g.example === example && g.path === path);
  for (const g of set.sdk_gaps) {
    if (!set.findings.some((f) => f.example === g.example && f.path === g.path && f.kind === "rule" && f.rule === g.rule))
      problems.push(`${g.example} ${where({ path: g.path })}: ${expectedFile} records an SDK gap for ${g.rule}, and the file has no finding of that rule there; only a rule's finding is beyond the SDK types, which check what the schemas check (gate 11)`);
  }
  const examples: ModelExample[] = set.examples.filter((n) => i.payloads.has(n)).map((id) => ({ id, ir: `desk:${basename(set.dir)}`, object: set.document, part: false }));
  const r = checkExamples({ model: i.model, files: i.files, schemaDir: i.schemaDir, examples, values: i.payloads, codes: i.codes, ruleChecks: i.ruleChecks });
  problems.push(...r.problems);
  const verdicts: DeskVerdict[] = [];
  for (const name of set.examples) {
    const want = set.findings.filter((f) => f.example === name);
    const schemaGot = r.failures.filter((f) => f.example === name);
    const checkerGot = i.checker.failures.filter((f) => f.example === name);
    const key = (f: { path: string; kind?: string; rule?: string }) => `${f.path} ${f.kind ?? ""} ${f.rule ?? ""}`;
    for (const f of schemaGot) if (!want.some((w) => key(w) === key(f))) problems.push(`${name} ${where(f)}: the schemas and rules on lock "${set.lock}" reject it, and ${expectedFile} expects ${want.length === 0 ? "the file clean" : `it rejected only at ${want.map(where).join(", ")}`}: ${f.message}`);
    for (const w of want) if (!schemaGot.some((f) => key(w) === key(f))) problems.push(`${name} ${where(w)}: the schemas and rules on lock "${set.lock}" no longer reject it there`);
    for (const f of checkerGot) if (!want.some((w) => w.path === f.path)) problems.push(`${name} ${where(f)}: ${i.checker.label} rejects it, and ${expectedFile} expects ${want.length === 0 ? "the file clean" : `it rejected only at ${want.map((w) => where({ path: w.path })).join(", ")}`}: ${f.message}`);
    for (const w of want) if (!checkerGot.some((f) => f.path === w.path)) problems.push(`${name} ${where({ path: w.path })}: ${i.checker.label} no longer rejects it there`);
    // An SDK is held to every finding but a recorded SDK gap, a rule's, which it accepts, as the schema does.
    const sdkWant = want.filter((w) => !gapAt(name, w.path));
    const sdkVerdicts: Record<string, string> = {};
    for (const sdk of i.sdks) {
      const got = sdk.failures.filter((f) => f.example === name);
      for (const f of got) {
        if (sdkWant.some((w) => w.path === f.path)) continue;
        const gap = gapAt(name, f.path);
        if (gap) problems.push(`${name} ${where(f)}: ${sdk.label} rejects it, where ${expectedFile} records under sdk_gaps that no SDK type checks ${gap.rule}; review the verdict and remove the entry: ${f.message}`);
        else problems.push(`${name} ${where(f)}: ${sdk.label} rejects it, and ${expectedFile} expects ${sdkWant.length === 0 ? "the SDKs to accept it" : `it rejected only at ${sdkWant.map((w) => where({ path: w.path })).join(", ")}`}: ${f.message}`);
      }
      for (const w of sdkWant) {
        if (got.some((f) => f.path === w.path)) continue;
        problems.push(`${name} ${where({ path: w.path })}: ${sdk.label} doesn't reject it there${w.kind === "rule" ? `; no SDK type checks a rule, so record ${w.rule} there under sdk_gaps, with the reason` : ""}`);
      }
      sdkVerdicts[sdk.label] = got.length === 0 ? "clean" : `rejected at ${got.map((f) => where({ path: f.path })).join(", ")}`;
    }
    const show = (fs: { path: string; kind?: string; rule?: string }[]) => (fs.length === 0 ? "clean" : `rejected at ${fs.map(where).join(", ")}`);
    verdicts.push({ example: name, expected: show(want), schemas: show(schemaGot), checker: show(checkerGot.map((f) => ({ path: f.path }))), sdks: sdkVerdicts });
  }
  const ukey = (u: { example: string; path: string; rule: string }) => `${u.example} ${u.path === "" ? "/" : u.path} (${u.rule})`;
  for (const u of r.checks.undecided) if (!set.undecided.some((x) => ukey(x) === ukey(u))) problems.push(`${ukey(u)}: undecided on lock "${set.lock}"; record it under undecided with what the verdict turns on`);
  for (const x of set.undecided) if (!r.checks.undecided.some((u) => ukey(u) === ukey(x))) problems.push(`${set.file}: undecided ${ukey(x)} is decided now on lock "${set.lock}"; review the payload's verdict and remove it`);
  return { problems, verdicts };
}
