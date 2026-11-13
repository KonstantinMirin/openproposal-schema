/**
 * Gate 11, parity: each generated SDK reaches the reference verdict
 * on every case of the lock's conformance corpus, and on the reviewed
 * vectors of the kernel's primitives and constructors.
 *
 * The cases:
 * - the corpus: each constraint's baseline (valid), its mutant (invalid),
 *   and its trailing-newline mutant (invalid, though the stock oracle
 *   accepts some, the Python `$` defect type rules § 2 names), labelled by
 *   the reference oracle; and every payload of every rule vector, which the
 *   type's schema accepts, so the rule alone decides the vector (§ 9). A
 *   constructor rule's payloads are values of the template applied to its
 *   arguments, which the SDKs build from their generics;
 * - each primitive's valid and invalid vectors, with a trailing-newline
 *   mutant of each valid string vector of a primitive with a `pattern`,
 *   `format`, or `enum`, which the kernel gate holds the oracle to;
 * - each constructor's vectors: a template applied to the vector's
 *   arguments, its fallback included, with the verdict the constructor gate
 *   holds Ajv to. These hold each language's generic templates to the same
 *   verdicts as the copies, as type rules § 10 asks, including templates no
 *   copy uses;
 * - integral floats, sent as JSON text so no serializer rewrites them: each
 *   valid vector of an integer primitive written `<v>.0` and `<v>e0`, which
 *   JSON Schema counts as integers, since it compares numbers by value, and
 *   `<v>.5`, which isn't one; and each integer term of a vocabulary written
 *   `<t>.0` (type rules § 6).
 *
 * Each SDK parses each case's JSON text, and for a value it accepts, encodes
 * it back; the encoding must be the same JSON value, so the types hold what
 * they accept.
 *
 * The same harnesses also report where each SDK rejects a payload, through
 * the entry point an implementer calls: `findingsTypeScript`,
 * `findingsPython`, and `findingsGo`. The SDK-locations gate holds each SDK
 * to reject every corpus mutant at its constraint's location
 * (`locationCases`, `compareLocations`), and the desk-tests gate
 * (src/desk-tests.ts) reads them for each desk-test payload.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "./canonical.ts";
import type { TypeRef } from "./mapping.ts";
import type { Constructors } from "./constructors.ts";
import type { CorpusDoc } from "./corpus.ts";
import type { Kernel } from "./kernel.ts";
import type { ModelDoc } from "./model.ts";
import { payloadsOf } from "./rules.ts";
import { applicationExpr, renderExpr, type Expr } from "./sdk.ts";
import { locationOf } from "./emit.ts";
import { spawnWithInput } from "./spawn.ts";
import { RuleEvaluator, type Programs, type ZoneTable } from "./rule-program.ts";
import { inHolder, instancesIn, leastExample, placedPrograms, typesAlong } from "./rule-places.ts";

export interface SdkCase {
  label: string;
  /** The type the value is an instance of: a named type, or a template applied to its arguments. */
  target: Expr;
  value: unknown;
  /** The JSON text each SDK parses, where it spells the value in a way serializing `value` wouldn't, such as the integer 1 written `1.0`. */
  json?: string;
  valid: boolean;
}

/** The JSON text of a case, as each SDK receives it. */
export const jsonOf = (c: SdkCase): string => c.json ?? JSON.stringify(c.value);

export interface SdkRun {
  /** The engine and its version, for the note. */
  engine: string;
  verdicts: boolean[];
  /** For each accepted value, the JSON value the SDK encodes it back to; null where it rejects it. */
  dumps: unknown[];
  /** For each case, an error the SDK raised other than a rejection, such as a failure to decode an accepted value, or null. */
  errors: (string | null)[];
}

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const SPELLING = ["pattern", "format", "enum"];

/** Every case the SDKs must reach the verdict of, for one lock. */
export function sdkCases(model: ModelDoc, corpus: CorpusDoc, kernel: Kernel, constructors: Constructors): SdkCase[] {
  const out: SdkCase[] = [];
  const ref = (name: string): Expr => ({ k: "ref", name });
  for (const c of corpus.constraints) {
    out.push({ label: `corpus ${c.id} baseline`, target: ref(c.type), value: c.baseline, valid: true });
    out.push({ label: `corpus ${c.id} mutant`, target: ref(c.type), value: c.mutant, valid: false });
    if ("newline" in c) out.push({ label: `corpus ${c.id} newline mutant`, target: ref(c.type), value: c.newline, valid: false });
  }
  for (const r of corpus.rules) {
    let target: Expr;
    if (r.type !== undefined) target = ref(r.type);
    else if (r.arguments !== undefined) target = applicationExpr(model, r.owner, r.arguments);
    else continue;
    for (const [label, list] of [["valid", r.valid], ["invalid", r.invalid]] as const) {
      list.forEach((x, i) => {
        for (const [part, value] of payloadsOf(x)) out.push({ label: `corpus rule "${r.rule}" ${label} vector ${i + 1} ${part}`, target, value, valid: true });
      });
    }
  }
  const emitted = new Set(model.types.map((t) => t.name));
  for (const p of kernel.primitives) {
    if (!emitted.has(p.name)) continue;
    const spelled = SPELLING.some((k) => (p.constraints as Record<string, unknown>)[k] !== undefined);
    p.vectors.valid.forEach((v, i) => {
      out.push({ label: `primitive ${p.name} valid vector ${i + 1}`, target: ref(p.name), value: v, valid: true });
      if (spelled && typeof v === "string") out.push({ label: `primitive ${p.name} valid vector ${i + 1} with a trailing newline`, target: ref(p.name), value: `${v}\n`, valid: false });
    });
    p.vectors.invalid.forEach((v, i) => out.push({ label: `primitive ${p.name} invalid vector ${i + 1}`, target: ref(p.name), value: v, valid: false }));
  }
  for (const p of kernel.primitives) {
    if (!emitted.has(p.name) || p.type !== "integer") continue;
    p.vectors.valid.forEach((v, i) => {
      if (typeof v !== "number" || !Number.isInteger(v)) return;
      const what = `primitive ${p.name} valid vector ${i + 1}`;
      for (const json of [`${v}.0`, `${v}e0`]) out.push({ label: `${what} written ${json}`, target: ref(p.name), value: v, json, valid: true });
      if (Math.abs(v) < 2 ** 52) out.push({ label: `${what} written ${v}.5`, target: ref(p.name), value: v + 0.5, json: `${v}.5`, valid: false });
    });
  }
  for (const t of model.types) {
    if (t.kind !== "vocabulary" || locationOf(t) === null) continue;
    for (const term of t.terms) {
      if (typeof term.value === "number") out.push({ label: `vocabulary ${t.name} term ${term.value} written ${term.value}.0`, target: ref(t.name), value: term.value, json: `${term.value}.0`, valid: true });
    }
  }
  for (const c of constructors.constructors) {
    c.vectors.forEach((b, i) => {
      const target = applicationExpr(model, c.name, b.arguments);
      const what = `constructor ${c.name} vectors[${i}] as ${renderExpr(target)}`;
      b.valid.forEach((v, j) => out.push({ label: `${what} valid ${j + 1}`, target, value: v, valid: true }));
      b.invalid.forEach((v, j) => out.push({ label: `${what} invalid ${j + 1}`, target, value: v, valid: false }));
    });
  }
  return out;
}

/** Whether two JSON values are equal, numbers compared by value. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (isMap(a)) {
    if (!isMap(b)) return false;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && jsonEqual(a[k], b[k]));
  }
  return a === b;
}

/** The problems with one SDK's run: a verdict that isn't the label, an error, and an accepted value that doesn't encode back to itself. */
export function compareRun(language: string, cases: SdkCase[], run: SdkRun): { problems: string[]; note: string } {
  if (run.verdicts.length !== cases.length) return { problems: [`${language}: ${run.verdicts.length} verdicts for ${cases.length} cases`], note: "" };
  const problems: string[] = [];
  cases.forEach((c, i) => {
    const got = run.verdicts[i];
    if (run.errors[i]) problems.push(`${language}: ${c.label}: ${run.errors[i]}`);
    else if (got !== c.valid) problems.push(`${language}: ${c.label}: labelled ${c.valid ? "valid" : "invalid"}, but the SDK says ${got ? "valid" : "invalid"} for ${jsonOf(c)}`);
    else if (got && !jsonEqual(run.dumps[i], c.value)) problems.push(`${language}: ${c.label}: encodes ${jsonOf(c)} back as ${JSON.stringify(run.dumps[i])}`);
  });
  const valid = cases.filter((c) => c.valid).length;
  return { problems, note: `${run.engine}: ${cases.length} cases (${valid} valid, ${cases.length - valid} invalid), every verdict the label's, every accepted value encoded back unchanged` };
}

/** The TypeScript SDK's run, in this process: each case parsed with its Zod schema. `sdkTs` is the absolute path of the lock's `ts/` directory. */
export async function runTypeScript(sdkTs: string, cases: SdkCase[]): Promise<SdkRun> {
  const sdk = (await import(pathToFileURL(join(sdkTs, "src", "index.ts")).href)) as {
    TYPES: Record<string, ZodLike>;
    TEMPLATES: Record<string, (...args: ZodLike[]) => ZodLike>;
  };
  const rt = (await import(pathToFileURL(join(sdkTs, "src", "runtime.ts")).href)) as { map: (k: ZodLike, v: ZodLike) => ZodLike };
  const { z } = await import("zod");
  const schemaOf = (e: Expr): ZodLike => {
    switch (e.k) {
      case "ref": {
        const t = sdk.TYPES[e.name];
        if (!t) throw new Error(`the TypeScript SDK has no type "${e.name}"`);
        return t;
      }
      case "boolean":
        return z.boolean() as unknown as ZodLike;
      case "list":
        return z.array(schemaOf(e.item) as never) as unknown as ZodLike;
      case "map":
        return rt.map(schemaOf(e.key), schemaOf(e.value));
      case "apply": {
        const t = sdk.TEMPLATES[e.template];
        if (!t) throw new Error(`the TypeScript SDK has no template "${e.template}"`);
        return t(...e.args.map(schemaOf));
      }
      case "param":
        throw new Error(`parameter "${e.name}" is unbound`);
    }
  };
  const cache = new Map<string, ZodLike>();
  const run: SdkRun = { engine: "TypeScript with Zod", verdicts: [], dumps: [], errors: [] };
  for (const c of cases) {
    const key = canonicalJson(c.target);
    let schema = cache.get(key);
    try {
      if (!schema) cache.set(key, (schema = schemaOf(c.target)));
      const r = schema.safeParse(JSON.parse(jsonOf(c)));
      run.verdicts.push(r.success);
      run.dumps.push(r.success ? JSON.parse(JSON.stringify(r.data)) : null);
      run.errors.push(null);
    } catch (e) {
      run.verdicts.push(false);
      run.dumps.push(null);
      run.errors.push((e as Error).message);
    }
  }
  const { version } = (await import("zod/package.json", { with: { type: "json" } })).default as { version: string };
  run.engine = `TypeScript with Zod ${version}`;
  return run;
}

interface ZodLike {
  safeParse(v: unknown): { success: boolean; data?: unknown };
}

/** The one package a generated tree's language directory holds: the folder with the file that marks a package, such as Python's `__init__.py`. Throws for none or several. */
export function packageIn(dir: string, marker: (folder: string) => boolean): string {
  const found = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && marker(join(dir, e.name)))
    .map((e) => e.name);
  if (found.length !== 1) throw new Error(`${dir}: holds ${found.length === 0 ? "no package" : `the packages ${found.join(", ")}`}; a generated tree holds one`);
  return found[0]!;
}

/** The Python SDK's run, under the venv's interpreter: tools/sdk/verdicts.py parses each case with Pydantic. `sdkPython` is the absolute path of the lock's `python/` directory, which holds the SDK's package. */
export function runPython(root: string, sdkPython: string, cases: SdkCase[]): SdkRun {
  const python = join(root, ".venv", "bin", "python");
  const pkg = packageIn(sdkPython, (d) => existsSync(join(d, "__init__.py")));
  const r = spawnWithInput(python, ["-I", "-B", join(root, "tools", "sdk", "verdicts.py"), sdkPython, pkg], JSON.stringify({ cases: cases.map((c) => ({ target: c.target, json: jsonOf(c) })) }), {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(`${python}: ${r.error.message}; run: npm run setup:oracle && npm run setup:sdk`);
  if (r.status !== 0) throw new Error(`tools/sdk/verdicts.py failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}; is Pydantic installed? run: npm run setup:sdk`);
  return JSON.parse(r.stdout) as SdkRun;
}

/** An expression as the Go type the harness names, with the SDK package as `op`. */
function goTypeOf(e: Expr): string {
  switch (e.k) {
    case "ref":
      return `op.${e.name}`;
    case "boolean":
      throw new Error("a Go case can't be the bare boolean");
    case "list":
      return `op.List[${goTypeOf(e.item)}]`;
    case "map":
      return `op.Map[${goTypeOf(e.key)}, ${goTypeOf(e.value)}]`;
    case "apply":
      return `op.${e.template}[${e.args.map(goTypeOf).join(", ")}]`;
    case "param":
      throw new Error(`parameter "${e.name}" is unbound`);
  }
}

/**
 * The Go SDK's run: a harness generated into `work`, which names every
 * case's type statically, since Go applies its generics at compile time, is
 * built against the lock's Go module at `sdkGo`, by the module path and the
 * package its tree declares, and run.
 */
export function runGo(sdkGo: string, work: string, cases: SdkCase[]): SdkRun {
  const keys = [...new Set(cases.map((c) => canonicalJson(c.target)))].sort();
  const index = new Map(keys.map((k, i) => [k, i]));
  const entries = keys.map((k, i) => `\ttypes[${i}] = op.TypeOf[${goTypeOf(JSON.parse(k) as Expr)}]()\n`).join("");
  // Built as text, so each value reaches the harness as its JSON text, `1.0` included.
  const input = `{"cases":[${cases.map((c) => `{"type":${index.get(canonicalJson(c.target))},"value":${jsonOf(c)}}`).join(",")}]}`;
  return JSON.parse(
    runGoHarness(
      sdkGo,
      work,
      "verdicts",
      (pkg) => `// Command verdicts reports the Go SDK's verdicts on the cases it reads from stdin.
package main

import (
	"encoding/json"
	"os"
	"runtime/debug"

	op "${pkg}"
)

var types = map[int]op.Type{}

func init() {
${entries}}

type input struct {
	Cases []struct {
		Type  int             \`json:"type"\`
		Value json.RawMessage \`json:"value"\`
	} \`json:"cases"\`
}

type output struct {
	Engine   string            \`json:"engine"\`
	Verdicts []bool            \`json:"verdicts"\`
	Dumps    []json.RawMessage \`json:"dumps"\`
	Errors   []*string         \`json:"errors"\`
}

func main() {
	var in input
	if err := json.NewDecoder(os.Stdin).Decode(&in); err != nil {
		panic(err)
	}
	engine := "Go"
	if info, ok := debug.ReadBuildInfo(); ok {
		engine = "Go " + info.GoVersion
	}
	out := output{Engine: engine, Verdicts: []bool{}, Dumps: []json.RawMessage{}, Errors: []*string{}}
	for _, c := range in.Cases {
		t := types[c.Type]
		if t.Validate(c.Value) != nil {
			out.Verdicts = append(out.Verdicts, false)
			out.Dumps = append(out.Dumps, json.RawMessage("null"))
			out.Errors = append(out.Errors, nil)
			continue
		}
		out.Verdicts = append(out.Verdicts, true)
		x, err := t.Decode(c.Value)
		var b []byte
		if err == nil {
			b, err = json.Marshal(x)
		}
		if err != nil {
			msg := "accepted, but " + err.Error()
			out.Dumps = append(out.Dumps, json.RawMessage("null"))
			out.Errors = append(out.Errors, &msg)
			continue
		}
		out.Dumps = append(out.Dumps, b)
		out.Errors = append(out.Errors, nil)
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		panic(err)
	}
}
`,
      input,
    ),
  ) as SdkRun;
}

/**
 * Builds a Go command in `work`, whose `main.go` is `main` applied to the
 * import path of the SDK's package, against the lock's Go module at `sdkGo`,
 * by the module path its go.mod declares and the one folder of Go files it
 * holds, and runs it with `input` on stdin, under the local toolchain.
 * Returns what it writes to stdout.
 */
export function runGoHarness(sdkGo: string, work: string, name: string, main: (pkg: string) => string, input: string): string {
  const module = /^module (\S+)$/m.exec(readFileSync(join(sdkGo, "go.mod"), "utf8"))?.[1];
  if (module === undefined) throw new Error(`${sdkGo}/go.mod declares no module`);
  const pkg = packageIn(sdkGo, (d) => readdirSync(d).some((f) => f.endsWith(".go")));
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "go.mod"), `module ${name}\n\ngo 1.25\n\nrequire ${module} v0.0.0\n\nreplace ${module} => ${sdkGo}\n`);
  writeFileSync(join(work, "main.go"), main(`${module}/${pkg}`));
  const r = spawnWithInput("go", ["run", "."], input, { cwd: work, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GOWORK: "off", GOFLAGS: "-mod=mod", GOTOOLCHAIN: "local" } });
  if (r.error) throw new Error(`go: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`the Go harness failed: ${(r.stderr || r.stdout).trim().split("\n").slice(0, 5).join(" ")}`);
  return r.stdout;
}

/** One place where an SDK rejects a payload: the path it reports, as its own list of keys, indices, and labels, and what it says is wrong there. */
export interface SdkFinding {
  path: (string | number)[];
  message: string;
}

/** A payload an SDK checks, with the named type it is checked as. */
export interface SdkPayload {
  type: string;
  value: unknown;
}

/** An SDK's findings on each of a list of payloads, in order: an empty list for a payload it accepts. */
export interface SdkFindingsRun {
  /** The engine and its version, as the parity run names it. */
  engine: string;
  findings: SdkFinding[][];
}

/** A JSON pointer's reference tokens, unescaped. */
const tokensOf = (pointer: string): string[] => (pointer === "" ? [] : pointer.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~")));

const escapeToken = (t: string) => t.replace(/~/g, "~0").replace(/\//g, "~1");

/**
 * A path an SDK reports, as its list of keys and indices, as a JSON
 * pointer. The path is followed through the payload for as long as each
 * step is a member of the object there or an index of the array there; the
 * first step that isn't ends it. So Pydantic's name of a union's branch,
 * such as `constrained-str` in `committed_metrics.1.metric.constrained-str`,
 * leaves the finding at the union, where the schemas report a value that
 * matches no branch, and a missing member's name leaves it at the object
 * that lacks it, where the schemas report `required`. A Go pointer and a Zod
 * path are followed the same way.
 */
export function pointerIn(value: unknown, path: readonly (string | number)[]): string {
  let at = value;
  let out = "";
  for (const step of path) {
    if (Array.isArray(at)) {
      const n = typeof step === "number" ? step : /^(0|[1-9][0-9]*)$/.test(step) ? Number(step) : -1;
      if (n < 0 || n >= at.length) break;
      at = at[n];
      out += `/${n}`;
    } else if (at !== null && typeof at === "object" && Object.hasOwn(at, String(step))) {
      at = (at as Record<string, unknown>)[String(step)];
      out += `/${escapeToken(String(step))}`;
    } else break;
  }
  return out;
}

/** The distinct places an SDK rejects a payload at, as JSON pointers by `pointerIn`, each with what it says there, in the order it reports them. */
export function locationsOf(value: unknown, findings: SdkFinding[]): Map<string, string[]> {
  const at = new Map<string, string[]>();
  for (const f of findings) {
    const p = pointerIn(value, f.path);
    const ms = at.get(p) ?? [];
    if (!ms.includes(f.message)) ms.push(f.message);
    at.set(p, ms);
  }
  return at;
}

/**
 * The TypeScript SDK's findings, in this process: each payload parsed with
 * the Zod schema the package exports under its type's name, as
 * `LineItem.safeParse(value)`. Each issue is at its path; a closed object's
 * `unrecognized_keys` issue, which Zod reports at the object, is one finding
 * at each key it names.
 */
export async function findingsTypeScript(sdkTs: string, payloads: SdkPayload[]): Promise<SdkFindingsRun> {
  type Issue = { code: string; path: PropertyKey[]; message: string; keys?: string[] };
  type Schema = { safeParse?: (v: unknown) => { success: boolean; error?: { issues: Issue[] } } };
  const sdk = (await import(pathToFileURL(join(sdkTs, "src", "index.ts")).href)) as Record<string, unknown>;
  const findings = payloads.map((p) => {
    const schema = sdk[p.type] as Schema | undefined;
    if (typeof schema?.safeParse !== "function") throw new Error(`the TypeScript SDK exports no schema "${p.type}"`);
    const r = schema.safeParse(p.value);
    if (r.success) return [];
    return r.error!.issues.flatMap((i) => {
      const path = i.path.map((x) => (typeof x === "number" ? x : String(x)));
      return i.code === "unrecognized_keys" && i.keys ? i.keys.map((k) => ({ path: [...path, k], message: i.message })) : [{ path, message: i.message }];
    });
  });
  const { version } = (await import("zod/package.json", { with: { type: "json" } })).default as { version: string };
  return { engine: `TypeScript with Zod ${version}`, findings };
}

/**
 * The Python SDK's findings, under the venv's interpreter:
 * tools/sdk/findings.py checks each payload's JSON text with the package's
 * `parse_json(type, text)`, in the strict mode, and reports each Pydantic
 * error's `loc`, which names a union's branch among the keys.
 */
export function findingsPython(root: string, sdkPython: string, payloads: SdkPayload[]): SdkFindingsRun {
  const python = join(root, ".venv", "bin", "python");
  const pkg = packageIn(sdkPython, (d) => existsSync(join(d, "__init__.py")));
  const r = spawnWithInput(python, ["-I", "-B", join(root, "tools", "sdk", "findings.py"), sdkPython, pkg], JSON.stringify({ payloads: payloads.map((p) => ({ type: p.type, json: JSON.stringify(p.value) })) }), {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(`${python}: ${r.error.message}; run: npm run setup:oracle && npm run setup:sdk`);
  if (r.status !== 0) throw new Error(`tools/sdk/findings.py failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}; is Pydantic installed? run: npm run setup:sdk`);
  return JSON.parse(r.stdout) as SdkFindingsRun;
}

/**
 * The Go SDK's findings: a harness generated into `work` checks each
 * payload's JSON text with `op.Validate[op.<type>]`, named statically for
 * each type the payloads are, and reports each `op.Error` of the
 * `op.Errors` it returns, whose `At` is a JSON pointer. Any other error,
 * such as JSON it can't parse, is a finding at the root.
 */
export function findingsGo(sdkGo: string, work: string, payloads: SdkPayload[]): SdkFindingsRun {
  const types = [...new Set(payloads.map((p) => p.type))].sort();
  for (const t of types) if (!/^[A-Z][A-Za-z0-9]*$/.test(t)) throw new Error(`"${t}" is no Go type name`);
  const cases = types.map((t) => `\tcase ${JSON.stringify(t)}:\n\t\treturn op.Validate[op.${t}](data)\n`).join("");
  const out = runGoHarness(
    sdkGo,
    work,
    "findings",
    (pkg) => `// Command findings reports where the Go SDK rejects each payload it reads from stdin.
package main

import (
	"encoding/json"
	"errors"
	"os"
	"runtime/debug"

	op "${pkg}"
)

type finding struct {
	At      string \`json:"at"\`
	Message string \`json:"message"\`
}

func validate(t string, data []byte) error {
	switch t {
${cases}	}
	return errors.New("no type " + t)
}

func main() {
	var in struct {
		Payloads []struct {
			Type  string          \`json:"type"\`
			Value json.RawMessage \`json:"value"\`
		} \`json:"payloads"\`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&in); err != nil {
		panic(err)
	}
	engine := "Go"
	if info, ok := debug.ReadBuildInfo(); ok {
		engine = "Go " + info.GoVersion
	}
	out := struct {
		Engine   string      \`json:"engine"\`
		Findings [][]finding \`json:"findings"\`
	}{Engine: engine, Findings: [][]finding{}}
	for _, p := range in.Payloads {
		got := []finding{}
		if err := validate(p.Type, p.Value); err != nil {
			var errs op.Errors
			if errors.As(err, &errs) {
				for _, e := range errs {
					got = append(got, finding{At: e.At, Message: e.Message})
				}
			} else {
				got = append(got, finding{At: "", Message: err.Error()})
			}
		}
		out.Findings = append(out.Findings, got)
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		panic(err)
	}
}
`,
    `{"payloads":[${payloads.map((p) => `{"type":${JSON.stringify(p.type)},"value":${JSON.stringify(p.value)}}`).join(",")}]}`,
  );
  const r = JSON.parse(out) as { engine: string; findings: { at: string; message: string }[][] };
  return { engine: r.engine, findings: r.findings.map((fs) => fs.map((f) => ({ path: tokensOf(f.at), message: f.message }))) };
}

/** A corpus mutant, with the places where the reference rejects it, which each SDK must reject it at. */
export interface SdkLocationCase {
  label: string;
  type: string;
  value: unknown;
  /** The JSON pointers of the places in the value, sorted: its constraint's `path`, for `additionalProperties` the member the object doesn't name, and for a paired mutant the member it adds too. */
  at: string[];
  /** Why the case doesn't test what it is for, as a rule's vector its own rule doesn't give its verdict in its holder. */
  problem?: string;
}

const valueAtPointer = (v: unknown, pointer: string): unknown =>
  tokensOf(pointer).reduce<unknown>((x, t) => (Array.isArray(x) ? x[Number(t)] : isMap(x) ? x[t] : undefined), v);

/** The member a paired mutant adds, which no type names. */
export const UNNAMED_MEMBER = "undefined_member";

/** Whether a constraint is one the SDKs check beside an object's members rather than as a member's type: a dependency, a condition, or a list's bounds, which the schema states on the object. */
const onShape = (c: { at: string; keyword: string }) => /^\/(dependentSchemas|then|else)(\/|$)/.test(c.at) || ["dependentRequired", "dependentSchemas", "then", "minItems", "uniqueItems"].includes(c.keyword);

/**
 * Every mutant of a lock's corpus, each with the place its constraint's
 * `path` names, where the reference validator rejects it. An
 * `additionalProperties` mutant is rejected at the member the object doesn't
 * name, the one its baseline lacks, as the examples and desk-tests gates
 * locate it. Each mutant of a check on an object's shape, on a closed
 * object that states no member count, is also paired with a member the
 * object doesn't name, so it fails at two places, the shape's and the
 * member's, and each SDK must report both: a runtime that stops at the
 * first failure reports one.
 */
export function locationCases(corpus: CorpusDoc): SdkLocationCase[] {
  const out: SdkLocationCase[] = [];
  const closed = new Set(corpus.constraints.filter((c) => c.keyword === "additionalProperties" && c.path === "").map((c) => c.type));
  const counted = new Set(corpus.constraints.filter((c) => c.keyword === "minProperties" || c.keyword === "maxProperties" || /\/maxProperties$/.test(c.at)).map((c) => c.type));
  for (const c of corpus.constraints) {
    let at = c.path;
    if (c.keyword === "additionalProperties") {
      const base = valueAtPointer(c.baseline, c.path);
      const mut = valueAtPointer(c.mutant, c.path);
      const added = isMap(mut) ? Object.keys(mut).filter((k) => !isMap(base) || !(k in base)) : [];
      if (added.length !== 1) throw new Error(`corpus ${c.id}: the mutant adds ${added.length} members to the baseline, not one`);
      at = `${c.path}/${escapeToken(added[0]!)}`;
    }
    out.push({ label: `corpus ${c.id} mutant`, type: c.type, value: c.mutant, at: [at] });
    if ("newline" in c) out.push({ label: `corpus ${c.id} newline mutant`, type: c.type, value: c.newline, at: [c.path] });
    if (onShape(c) && closed.has(c.type) && !counted.has(c.type) && isMap(c.mutant) && !(UNNAMED_MEMBER in c.mutant)) {
      out.push({ label: `corpus ${c.id} mutant with a member the object doesn't name`, type: c.type, value: { ...c.mutant, [UNNAMED_MEMBER]: true }, at: [...new Set([at, `/${UNNAMED_MEMBER}`])].sort() });
    }
  }
  return out;
}

/** The problems with where one SDK rejects the corpus mutants: each must be rejected at every place its constraints name, and nowhere else. */
export function compareLocations(language: string, cases: SdkLocationCase[], run: SdkFindingsRun): { problems: string[]; note: string } {
  if (run.findings.length !== cases.length) return { problems: [`${language}: ${run.findings.length} verdicts for ${cases.length} mutants`], note: "" };
  const problems: string[] = [];
  cases.forEach((c, i) => {
    if (c.problem !== undefined) problems.push(`${c.label}: ${c.problem}`);
    const got = [...locationsOf(c.value, run.findings[i]!).keys()];
    const shown = (p: string) => (p === "" ? "/" : p);
    if (got.length === c.at.length && [...got].sort().every((p, k) => p === c.at[k])) return;
    problems.push(`${language}: ${c.label}: the reference ${c.at.length === 0 ? "accepts it" : `rejects it at ${c.at.map(shown).join(", ")}`}, and the SDK ${got.length === 0 ? "accepts it" : `rejects it at ${got.map(shown).join(", ")}`}`);
  });
  const paired = cases.filter((c) => c.at.length > 1).length;
  return { problems, note: `${run.engine}: ${cases.length} mutants, ${paired} of them failing at two places, each rejected at every place its constraints name and nowhere else` };
}

/** The places, below a value of a type, where the rules the SDKs check reject it, sorted: none for a type that holds no value such a rule runs on. With the programs, as the SDKs hold them, and the evaluator. */
export type Ruled = ((type: string | TypeRef, value: unknown) => string[]) & { model: ModelDoc; programs: Programs; evaluator: RuleEvaluator };

/** The rules the SDKs check, each on every value of the type it runs on, its owner or the owner's holder, by the programs every SDK is generated with and the gates' own evaluator. */
export function rulerOf(model: ModelDoc, programs: Programs, zones: ZoneTable): Ruled {
  const placed = placedPrograms(model, programs);
  const evaluator = new RuleEvaluator(placed.programs, zones);
  // Each SDK runs a rule on every value of the type that runs it, wherever the value sits.
  const ruled = (type: string | TypeRef, value: unknown) => {
    const out = new Set<string>();
    for (const i of placed.runs.size === 0 ? [] : instancesIn(model, type, value)) for (const id of placed.runs.get(i.type) ?? []) for (const v of evaluator.violations(id, i.value)) out.add(i.path + v.path);
    return [...out].sort();
  };
  return Object.assign(ruled, { model, programs: placed.programs, evaluator });
}

/** The parity cases with the rules the SDKs check: a case of a named type or a template's application that a rule rejects is invalid for the SDKs, which check the rule, though its schema accepts it. */
export function withRules(cases: SdkCase[], ruled: Ruled): SdkCase[] {
  // An application the schema names by a copy is that copy; one it doesn't is its template's, whose rules run on it.
  const typeOf = (t: Expr): string | TypeRef | null => (t.k === "ref" ? t.name : t.k === "apply" ? (t.copy ?? { kind: "apply", constructor: t.template, arguments: {} }) : null);
  return cases.map((c) => {
    const type = c.valid ? typeOf(c.target) : null;
    return type !== null && ruled(type, c.value).length > 0 ? { ...c, valid: false } : c;
  });
}

/** The location cases with the rules the SDKs check: a value also fails at each place a rule rejects it. */
export function withRuleLocations(cases: SdkLocationCase[], ruled: Ruled): SdkLocationCase[] {
  return cases.map((c) => {
    const more = ruled(c.type, c.value);
    return more.length === 0 ? c : { ...c, at: [...new Set([...c.at, ...more])].sort() };
  });
}

/**
 * Every payload of every vector of a rule the SDKs check, as a location
 * case: each SDK must reject it at each place the rules it checks reject it,
 * by the gates' own evaluator, and nowhere else. A vector of a rule that
 * runs on its owner's holder is the holder's value that holds the vector's
 * (`inHolder`), from the holder's least type example, each object on the way its type's; and its own
 * rule must give it its verdict there, a valid vector none of its
 * violations and an invalid one some, or the case names the problem.
 */
export function ruleLocationCases(corpus: CorpusDoc, ruled: Ruled, examples: Record<string, { minimal?: unknown }>): SdkLocationCase[] {
  const out: SdkLocationCase[] = [];
  for (const r of corpus.rules) {
    const p = ruled.programs.rules[r.rule];
    if (p === undefined) continue;
    // A constructor's rule reads the copy its vectors' arguments make, as the gates' check does.
    const args = r.arguments === undefined ? null : canonicalJson(r.arguments);
    const type = r.type ?? ruled.model.types.find((t) => t.kind === "copy" && t.of.constructor === r.owner && canonicalJson(t.of.arguments) === args)?.name;
    if (type === undefined) continue;
    const on = p.on ?? p.owner;
    for (const [label, list] of [["valid", r.valid], ["invalid", r.invalid]] as const) {
      list.forEach((x, i) => {
        for (const [part, owned] of payloadsOf(x)) {
          const name = `rule "${r.rule}" ${label} vector ${i + 1} ${part}`;
          if (on === p.owner) {
            out.push({ label: name, type, value: owned, at: ruled(type, owned) });
            continue;
          }
          const place = p.at![0]!;
          const along = typesAlong(ruled.model, on, place).map((t) => leastExample(ruled.model, examples, t));
          const value = inHolder(examples[on]?.minimal, on, place, owned, (x as { context?: Record<string, unknown> }).context ?? {}, along);
          const own = ruled.evaluator.violations(r.rule, value);
          const problem = label === "valid" && own.length > 0 ? `in its holder, \`${on}\`, its rule finds ${own.map((v) => `${v.path || "/"}: ${v.message}`).join("; ")}` : label === "invalid" && own.length === 0 ? `in its holder, \`${on}\`, its rule finds no violation` : undefined;
          out.push({ label: `${name} in its holder`, type: on, value, at: ruled(on, value), ...(problem ? { problem } : {}) });
        }
      });
    }
  }
  return out;
}
