/**
 * Type rules § 10, the plain-generator clause: "A plain generator run on the
 * published schema alone must still produce correct concrete classes. The
 * conformance vectors hold both to the same verdicts."
 *
 * The plain generator is datamodel-code-generator, as
 * tools/plaingen/requirements.txt hash-locks it, run with
 * the stock options `PLAIN_OPTIONS` names on each published schema file of a
 * lock, one module per file. No input but the published files reaches it.
 *
 * Its classes get the SDK parity cases (src/sdk-parity.ts) whose type is
 * concrete: a named type, the class of that name in the module generated
 * from the type's own schema file; a template application that names the
 * copy the schema references, as that copy's class; and a list or map of
 * those. A plain generator has no generics, so an application with no named
 * copy has no class to run; the gate counts those cases.
 *
 * Each class must reach the case's reference verdict, raise nothing, and
 * encode an accepted value back to the same JSON value. Where the generator
 * can't, the divergence is a numbered exemption in
 * plain-generator/exemptions.yaml with the reason, the way the corpus gate
 * counts the Python `$` defect; the gate fails on a divergence no exemption
 * lists, and on a listed one that no longer occurs.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { locationOf, SCHEMA_ROOTS } from "./emit.ts";
import { inScope, readYaml } from "./mapping.ts";
import type { ModelDoc } from "./model.ts";
import { compileSchema } from "./pipeline.ts";
import type { Expr } from "./sdk.ts";
import { jsonEqual, jsonOf, type SdkCase, type SdkRun } from "./sdk-parity.ts";
import { spawnWithInput } from "./spawn.ts";
import { REPO_ROOT } from "./repo.ts";

export const PLAIN_REQUIREMENTS = "tools/plaingen/requirements.in";
export const EXEMPTIONS_FILE = "plain-generator/exemptions.yaml";
export const EXEMPTIONS_SCHEMA = "plain-generator/exemptions.schema.json";
/** The package the generated modules go in, so no module name meets the standard library's. */
const PACKAGE = "opplain";

/**
 * The generator's options, each a stock one. Strict types, since JSON Schema
 * coerces nothing, so the string "25000" is no number; the output model
 * Pydantic 2 and the target Python 3.12, as the SDK pins them; the built-in
 * formatter, so no formatter changes the code; `--allow-remote-refs` for the
 * sibling files that a `$ref` names by relative path, which are on disk; and
 * no timestamp, so two runs write the same bytes.
 */
export const PLAIN_OPTIONS = [
  "--input-file-type", "jsonschema",
  "--output-model-type", "pydantic_v2.BaseModel",
  "--target-python-version", "3.12",
  "--strict-types", "str", "bytes", "int", "float", "bool",
  "--formatters", "builtin",
  "--allow-remote-refs",
  "--disable-timestamp",
];

/** The version of datamodel-code-generator the requirements pin. */
export function pinnedPlainGenerator(root: string): string {
  const m = /^datamodel-code-generator==(\S+)$/m.exec(readFileSync(join(root, PLAIN_REQUIREMENTS), "utf8"));
  if (!m) throw new Error(`${PLAIN_REQUIREMENTS} doesn't pin datamodel-code-generator`);
  return m[1]!;
}

/** `kernel/1/kernel.json` is the module `kernel_kernel`, and `modules/line-item/1/line-item.json` is `modules_line_item_line_item`. */
export function plainModuleOf(file: string): string {
  return file
    .replace(/\.json$/, "")
    .split("/")
    .filter((p) => !/^\d+$/.test(p))
    .join("_")
    .replace(/-/g, "_");
}

/** Every published schema file of a lock, by its path under the lock's schema directory. */
export function publishedFiles(schemaDir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(schemaDir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = posix.join(rel, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json")) out.push(p);
    }
  };
  for (const r of SCHEMA_ROOTS) walk(r);
  return out;
}

/**
 * Runs the plain generator on each published schema file under `schemaDir`
 * into the package `opplain` under `out`, which it replaces. Returns the
 * generator's version and the problems: a file it fails on, and a version
 * other than the pin.
 */
export function generatePlain(root: string, schemaDir: string, out: string): { version: string; modules: number; problems: string[] } {
  const generator = join(root, ".venv", "bin", "datamodel-codegen");
  const v = spawnSync(generator, ["--version"], { encoding: "utf8" });
  if (v.error) throw new Error(`${generator}: ${v.error.message}; run: npm run setup:oracle && npm run setup:plaingen`);
  const version = (v.stdout || "").trim().replace(/^datamodel-codegen\s+/, "");
  const pinned = pinnedPlainGenerator(root);
  const problems: string[] = version === pinned ? [] : [`datamodel-codegen is ${version}, but ${PLAIN_REQUIREMENTS} pins ${pinned}; run: npm run setup:plaingen`];
  const pkg = join(out, PACKAGE);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "__init__.py"), "");
  const files = publishedFiles(schemaDir);
  for (const f of files) {
    const r = spawnSync(generator, ["--input", join(schemaDir, f), "--output", join(pkg, `${plainModuleOf(f)}.py`), ...PLAIN_OPTIONS], { encoding: "utf8", env: { ...process.env, PYTHONWARNINGS: "ignore" } });
    if (r.status !== 0) problems.push(`${f}: datamodel-codegen failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
  }
  return { version, modules: files.length, problems };
}

/** A target as the plain classes have it, with each named type's module, or null where it applies a template with no named copy. */
export function plainTarget(model: ModelDoc, e: Expr): unknown {
  const types = new Map(model.types.map((t) => [t.name, t]));
  const of = (x: Expr): unknown => {
    switch (x.k) {
      case "ref": {
        const t = types.get(x.name);
        const l = t ? locationOf(t) : null;
        return l ? { k: "ref", name: x.name, module: plainModuleOf(l.file) } : null;
      }
      case "boolean":
        return x;
      case "list": {
        const item = of(x.item);
        return item && { k: "list", item };
      }
      case "map": {
        const key = of(x.key);
        const value = of(x.value);
        return key && value && { k: "map", key, value };
      }
      case "apply":
        return x.copy !== undefined ? of({ k: "ref", name: x.copy }) : null;
      case "param":
        return null;
    }
  };
  return of(e);
}

/** The plain classes' run: tools/plaingen/verdicts.py under the venv. `generated` is the directory that holds `opplain`. */
export function runPlain(root: string, generated: string, targets: unknown[], cases: SdkCase[]): SdkRun {
  const python = join(root, ".venv", "bin", "python");
  const r = spawnWithInput(python, ["-I", "-B", join(root, "tools", "plaingen", "verdicts.py"), generated], JSON.stringify({ cases: cases.map((c, i) => ({ target: targets[i], json: jsonOf(c) })) }), {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONWARNINGS: "ignore" },
  });
  if (r.error) throw new Error(`${python}: ${r.error.message}; run: npm run setup:oracle && npm run setup:plaingen`);
  if (r.status !== 0) throw new Error(`tools/plaingen/verdicts.py failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
  return JSON.parse(r.stdout) as SdkRun;
}

export type DivergenceKind = "verdict" | "error" | "encoding";

export interface Divergence {
  label: string;
  kind: DivergenceKind;
  detail: string;
}

/** Where the plain classes differ from the reference: a verdict, an error, or an accepted value that doesn't encode back. */
export function plainDivergences(cases: SdkCase[], run: SdkRun): Divergence[] {
  if (run.verdicts.length !== cases.length) throw new Error(`${run.verdicts.length} verdicts for ${cases.length} cases`);
  const out: Divergence[] = [];
  cases.forEach((c, i) => {
    const got = run.verdicts[i];
    if (run.errors[i]) out.push({ label: c.label, kind: "error", detail: run.errors[i]! });
    else if (got !== c.valid) out.push({ label: c.label, kind: "verdict", detail: `labelled ${c.valid ? "valid" : "invalid"}, but the classes say ${got ? "valid" : "invalid"} for ${jsonOf(c)}` });
    else if (got && !jsonEqual(run.dumps[i], c.value)) out.push({ label: c.label, kind: "encoding", detail: `encodes ${jsonOf(c)} back as ${JSON.stringify(run.dumps[i])}` });
  });
  return out;
}

export interface Exemption {
  id: string;
  locks?: string[];
  reason: string;
  cases: { label: string; kind: DivergenceKind }[];
}

export interface ExemptionsFile {
  format: 1;
  generator: string;
  exemptions: Exemption[];
  file: string;
}

/** Loads and validates plain-generator exemptions, a spec's `plain-generator/exemptions.yaml` (`EXEMPTIONS_FILE` in its folder). */
export function loadExemptions(file: string): ExemptionsFile {
  const doc = readYaml(file);
  const errors = compileSchema(join(REPO_ROOT, EXEMPTIONS_SCHEMA))(doc);
  if (errors.length > 0) throw new Error(`${file}: not a valid exemptions file: ${errors.join("; ")}`);
  return { ...(doc as Omit<ExemptionsFile, "file">), file };
}

const keyOf = (d: { label: string; kind: string }) => `${d.label} [${d.kind}]`;

/**
 * The file's own problems: an exemption ID used twice, a case listed twice,
 * a generator other than the pin, and a lock no lock file names.
 */
export function checkExemptionsFile(ex: ExemptionsFile, pinned: string, locks: string[]): string[] {
  const problems: string[] = [];
  if (ex.generator !== `datamodel-code-generator ${pinned}`) problems.push(`${ex.file}: written for ${ex.generator}, but ${PLAIN_REQUIREMENTS} pins ${pinned}; re-check every exemption against the pinned generator`);
  const ids = new Set<string>();
  const cases = new Set<string>();
  for (const e of ex.exemptions) {
    if (ids.has(e.id)) problems.push(`${ex.file}: ${e.id} is used twice`);
    ids.add(e.id);
    for (const l of e.locks ?? []) if (!locks.includes(l)) problems.push(`${ex.file}: ${e.id} names the unknown lock "${l}"`);
    for (const c of e.cases) {
      for (const l of locks.filter((x) => inScope(e.locks, x))) {
        const k = `${l} ${keyOf(c)}`;
        if (cases.has(k)) problems.push(`${ex.file}: ${keyOf(c)} is exempt twice on lock "${l}"`);
        cases.add(k);
      }
    }
  }
  return problems;
}

/**
 * One lock's divergences against the exemptions: every divergence is
 * listed, and every listed case in the lock's scope that the lock runs still
 * diverges that way. Returns the problems, the exemption IDs used, and the
 * listed cases the lock doesn't run, for the check across the locks.
 */
export function checkExemptions(divergences: Divergence[], ran: Set<string>, ex: ExemptionsFile, lock: string): { problems: string[]; used: string[]; absent: Set<string> } {
  const problems: string[] = [];
  const scope = ex.exemptions.filter((e) => inScope(e.locks, lock));
  const listed = new Map<string, string>();
  for (const e of scope) for (const c of e.cases) listed.set(keyOf(c), e.id);
  const used = new Set<string>();
  const found = new Set<string>();
  for (const d of divergences) {
    const id = listed.get(keyOf(d));
    found.add(keyOf(d));
    if (id === undefined) problems.push(`${d.label}: ${d.kind}: ${d.detail}; no exemption in ${EXEMPTIONS_FILE} lists it`);
    else used.add(id);
  }
  const absent = new Set<string>();
  for (const e of scope) {
    for (const c of e.cases) {
      if (!ran.has(c.label)) absent.add(`${e.id} ${keyOf(c)}`);
      else if (!found.has(keyOf(c))) problems.push(`${e.id}: ${keyOf(c)} no longer diverges on lock "${lock}"; remove it from ${EXEMPTIONS_FILE}`);
    }
  }
  return { problems, used: [...used].sort((a, b) => a.localeCompare(b, "en", { numeric: true })), absent };
}
