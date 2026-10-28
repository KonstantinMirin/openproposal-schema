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
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "./canonical.ts";
import type { Constructors } from "./constructors.ts";
import type { CorpusDoc } from "./corpus.ts";
import type { Kernel } from "./kernel.ts";
import type { ModelDoc } from "./model.ts";
import { payloadsOf } from "./rules.ts";
import { applicationExpr, renderExpr, type Expr } from "./sdk.ts";
import { locationOf } from "./emit.ts";
import { spawnWithInput } from "./spawn.ts";

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
  // The module path is the one the tree's go.mod declares, and the package the one folder of Go files it holds.
  const module = /^module (\S+)$/m.exec(readFileSync(join(sdkGo, "go.mod"), "utf8"))?.[1];
  if (module === undefined) throw new Error(`${sdkGo}/go.mod declares no module`);
  const pkg = packageIn(sdkGo, (d) => readdirSync(d).some((f) => f.endsWith(".go")));
  const keys = [...new Set(cases.map((c) => canonicalJson(c.target)))].sort();
  const index = new Map(keys.map((k, i) => [k, i]));
  const entries = keys.map((k, i) => `\ttypes[${i}] = op.TypeOf[${goTypeOf(JSON.parse(k) as Expr)}]()\n`).join("");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "go.mod"), `module verdicts\n\ngo 1.25\n\nrequire ${module} v0.0.0\n\nreplace ${module} => ${sdkGo}\n`);
  writeFileSync(
    join(work, "main.go"),
    `// Command verdicts reports the Go SDK's verdicts on the cases it reads from stdin.
package main

import (
	"encoding/json"
	"os"
	"runtime/debug"

	op "${module}/${pkg}"
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
  );
  // Built as text, so each value reaches the harness as its JSON text, `1.0` included.
  const input = `{"cases":[${cases.map((c) => `{"type":${index.get(canonicalJson(c.target))},"value":${jsonOf(c)}}`).join(",")}]}`;
  const r = spawnWithInput("go", ["run", "."], input, { cwd: work, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GOWORK: "off", GOFLAGS: "-mod=mod", GOTOOLCHAIN: "local" } });
  if (r.error) throw new Error(`go: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`the Go harness failed: ${(r.stderr || r.stdout).trim().split("\n").slice(0, 5).join(" ")}`);
  return JSON.parse(r.stdout) as SdkRun;
}
