import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { primitiveStructure, vectorCases, type Kernel, type VectorCase } from "./kernel.ts";
import { readYaml } from "./mapping.ts";
import { compileSchema } from "./pipeline.ts";
import { spawnWithInput } from "./spawn.ts";

/** One vector of one primitive, as sent to the other engines. */
export interface EngineCase extends VectorCase {
  primitive: string;
  schema: Record<string, unknown>;
  pattern?: string;
}

/** What `tools/oracle/kernel_verdicts.py` reports, one verdict per case. */
export interface PythonRun {
  jsonschema: string;
  python: string;
  verdicts: { oracle: boolean; re: boolean | null; re_anchored: boolean | null }[];
}

/** What `tools/regexcheck` reports, one verdict per pattern case. */
export interface GoRun {
  go: string;
  verdicts: boolean[];
}

/** Runs the cases in Python and Go. Tests replace it; the gate uses `spawnEngines`. */
export interface Engines {
  python(cases: EngineCase[]): PythonRun;
  go(cases: { pattern: string; value: string }[]): GoRun;
}

export const ORACLE_REQUIREMENTS = join("tools", "oracle", "requirements.txt");

export const ORACLE_GAPS = join("tools", "oracle", "gaps.yaml");
export const ORACLE_GAPS_SCHEMA = join("tools", "oracle", "gaps.schema.json");

/** The kernel vectors to which the reference oracle gives a verdict other than the stated one, each under a numbered gap. */
export interface OracleGaps {
  file: string;
  /** The packages and versions the gaps were checked against, as `jsonschema 4.26.0, rfc3339-validator 0.1.4`. */
  oracle: string;
  gaps: { id: string; reason: string; vectors: { primitive: string; value: unknown; oracle: "accepts" | "rejects" }[] }[];
}

export function loadOracleGaps(root: string, file = join(root, ORACLE_GAPS)): OracleGaps {
  const doc = readYaml(file);
  const errors = compileSchema(join(root, ORACLE_GAPS_SCHEMA))(doc);
  if (errors.length > 0) throw new Error(`${file}: not a valid oracle gaps file: ${errors.join("; ")}`);
  return { ...(doc as Omit<OracleGaps, "file">), file };
}

/** The version `tools/oracle/requirements.txt` pins for a package, or null. */
export function pinnedPackage(root: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(?:\\[[^\\]]*\\])?==(\\S+)`, "m").exec(readFileSync(join(root, ORACLE_REQUIREMENTS), "utf8"))?.[1] ?? null;
}

/** The jsonschema version that `tools/oracle/requirements.txt` pins. */
export function pinnedOracle(root: string): string {
  const pin = /^jsonschema(?:\[[^\]]*\])?==(\S+)/m.exec(readFileSync(join(root, ORACLE_REQUIREMENTS), "utf8"));
  if (!pin) throw new Error(`${ORACLE_REQUIREMENTS} doesn't pin jsonschema`);
  return pin[1]!;
}

function runJson<T>(cmd: string, args: string[], cwd: string, input: unknown, env: Record<string, string> = {}): T {
  const r = spawnWithInput(cmd, args, JSON.stringify(input), { cwd, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return JSON.parse(r.stdout) as T;
}

/**
 * The real engines: the oracle venv's Python (`npm run setup:oracle`
 * creates it from the hash-locked requirements) and Go's `regexp`.
 */
export function spawnEngines(root: string): Engines {
  const python = join(root, ".venv", "bin", "python");
  return {
    python(cases) {
      if (!existsSync(python)) throw new Error(`no oracle venv at .venv; run: npm run setup:oracle`);
      return runJson<PythonRun>(python, ["-I", join(root, "tools", "oracle", "kernel_verdicts.py")], root, { cases });
    },
    go(cases) {
      return runJson<GoRun>("go", ["run", "."], join(root, "tools", "regexcheck"), { cases }, { GOTOOLCHAIN: "local", GOFLAGS: "-mod=mod" });
    },
  };
}

/** The kernel's vectors with each primitive's schema and pattern, for the engines. */
export function engineCases(kernel: Kernel): EngineCase[] {
  return kernel.primitives.flatMap((p) => {
    const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", ...primitiveStructure(p) };
    return vectorCases(p).map((c) => ({ ...c, primitive: p.name, schema, ...(p.constraints.pattern !== undefined ? { pattern: p.constraints.pattern } : {}) }));
  });
}

export interface EngineReport {
  problems: string[];
  /** A one-line summary: the versions and the counted divergences. */
  note: string;
}

/**
 * Runs every kernel vector through the other engines and compares the
 * verdicts. Returns the problems; empty means the engines agree:
 *
 * - each pattern gets the same verdict in Go's RE2 as in ECMA-262 (`u`
 *   flag), on every string vector and mutant;
 * - the same holds in Python `re` once the final `$` is written `\Z`;
 * - unanchored Python `re.search`, as python-jsonschema runs `pattern`,
 *   differs from ECMA-262 on trailing-newline mutants only;
 * - the reference oracle (python-jsonschema at the pinned version, formats
 *   asserted) gives every stated vector its verdict. On a trailing-newline
 *   mutant it may accept the value, the known Python `$` defect, which the
 *   note counts. Elsewhere it may differ only on a vector `gaps` lists with
 *   the oracle's verdict, as rfc3339-validator rejects a leap second; a
 *   listed vector the oracle no longer differs on fails, and so does a gaps
 *   file written for other versions than the pins.
 */
export function checkKernelEngines(root: string, kernel: Kernel, engines: Engines = spawnEngines(root), gaps: OracleGaps = loadOracleGaps(root)): EngineReport {
  const problems: string[] = [];
  const cases = engineCases(kernel);
  const kind = (c: EngineCase) => (c.mutant ? "trailing-newline mutant" : c.rule ? `rule "${c.rule}" vector` : c.valid ? "valid vector" : "invalid vector");
  const show = (c: EngineCase) => `${kernel.file}: ${c.primitive}: ${kind(c)} ${JSON.stringify(c.value)}`;

  let py: PythonRun;
  let go: GoRun;
  const regexCases = cases.filter((c): c is EngineCase & { pattern: string; value: string } => c.pattern !== undefined && typeof c.value === "string");
  try {
    py = engines.python(cases);
    go = engines.go(regexCases.map((c) => ({ pattern: c.pattern, value: c.value })));
  } catch (e) {
    return { problems: [(e as Error).message], note: "" };
  }
  if (py.verdicts.length !== cases.length || go.verdicts.length !== regexCases.length) {
    return { problems: ["an engine returned a different number of verdicts than cases"], note: "" };
  }

  const pinned = pinnedOracle(root);
  if (py.jsonschema !== pinned) problems.push(`the oracle is jsonschema ${py.jsonschema}, but ${ORACLE_REQUIREMENTS} pins ${pinned}; run: npm run setup:oracle`);

  // The gaps file names the pinned versions it was checked against.
  const versions = gaps.oracle.split(", ").map((x) => x.split(" ") as [string, string]);
  if (!versions.some(([n]) => n === "jsonschema")) problems.push(`${gaps.file}: names no jsonschema version`);
  for (const [n, ver] of versions) {
    const pin = pinnedPackage(root, n);
    if (pin !== ver) problems.push(`${gaps.file}: written for ${n} ${ver}, but ${ORACLE_REQUIREMENTS} ${pin === null ? "doesn't pin it" : `pins ${pin}`}; re-check every gap against the pinned oracle`);
  }
  const ids = new Set<string>();
  for (const g of gaps.gaps) {
    if (ids.has(g.id)) problems.push(`${gaps.file}: ${g.id} is used twice`);
    ids.add(g.id);
  }
  const listed = gaps.gaps.flatMap((g) => g.vectors.map((x) => ({ ...x, id: g.id, key: `${x.primitive} ${JSON.stringify(x.value)}`, used: false })));

  const goVerdict = new Map(regexCases.map((c, i) => [c, go.verdicts[i]!] as const));
  let oracleNewline = 0;
  let pythonDollar = 0;
  cases.forEach((c, i) => {
    const v = py.verdicts[i]!;
    if (v.oracle !== c.valid) {
      const gap = c.mutant ? undefined : listed.find((x) => x.key === `${c.primitive} ${JSON.stringify(c.value)}` && x.oracle === (v.oracle ? "accepts" : "rejects"));
      if (c.mutant && v.oracle) oracleNewline++;
      else if (gap) gap.used = true;
      else problems.push(`${show(c)}: the oracle ${v.oracle ? "accepts" : "rejects"} it, and no gap in ${ORACLE_GAPS} lists it`);
    }
    if (c.pattern === undefined || typeof c.value !== "string") return;
    const ecma = new RegExp(c.pattern, "u").test(c.value);
    const where = `${show(c)}: the pattern ${ecma ? "matches" : "doesn't match"} in ECMA-262`;
    if (goVerdict.get(c as (typeof regexCases)[number]) !== ecma) problems.push(`${where}, but Go's RE2 disagrees`);
    if (v.re_anchored !== ecma) problems.push(`${where}, but Python re with \\Z disagrees`);
    if (v.re !== ecma) {
      if (c.mutant) pythonDollar++;
      else problems.push(`${where}, but Python re.search disagrees`);
    }
  });

  for (const x of listed) if (!x.used) problems.push(`${gaps.file}: ${x.id}: the oracle no longer ${x.oracle === "accepts" ? "accepts" : "rejects"} ${x.primitive} ${JSON.stringify(x.value)} against its stated verdict, or no vector states it; remove it`);

  const total = cases.length;
  const note = [
    `${total} vectors (${cases.filter((c) => c.mutant).length} trailing-newline mutants), ${regexCases.length} pattern cases`,
    `Ajv, Go ${go.go} RE2, Python ${py.python} re with \\Z agree`,
    `oracle jsonschema ${py.jsonschema} accepts ${oracleNewline} mutants and Python re.search matches ${pythonDollar} (Python $ matches before a final newline)`,
    `the oracle differs on ${listed.filter((x) => x.used).length} vectors under a listed gap (${[...new Set(listed.filter((x) => x.used).map((x) => x.id))].join(", ") || "none"})`,
  ].join("; ");
  return { problems, note };
}
