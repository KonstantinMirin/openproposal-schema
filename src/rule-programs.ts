/**
 * A spec's rule programs (src/rule-program.ts): `rule-programs.yaml` in the
 * spec's folder, which `specs/rule-programs.schema.json` validates in the
 * rules gate, and the time zone table of the IANA release `kernel/lists.yaml`
 * pins, which every program that counts calendar days reads. Each program is
 * the check of its rule in the gates, and the SDK emitters write it into
 * every SDK. This module reads files with no other module of the pipeline,
 * since the spec plugins load it as they load.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { REPO_ROOT } from "./repo.ts";
import { programProblems, RuleEvaluator, type Programs, type ZoneTable } from "./rule-program.ts";
import type { Check } from "./rule-checks.ts";

export const RULE_PROGRAMS_FILE = "rule-programs.yaml";
export const RULE_PROGRAMS_SCHEMA = join("specs", "rule-programs.schema.json");
/** The list whose release the time zone table compiles. */
export const ZONE_LIST = "IANA time zone database";

/** The release of the IANA time zone database `kernel/lists.yaml` pins. */
export function zoneRelease(root: string = REPO_ROOT): string {
  const doc = parse(readFileSync(join(root, "kernel", "lists.yaml"), "utf8")) as { lists: { name: string; version?: string }[] };
  const v = doc.lists.find((l) => l.name === ZONE_LIST)?.version;
  if (!v) throw new Error(`kernel/lists.yaml pins no release of the ${ZONE_LIST}`);
  return v;
}

/** The time zone table of the pinned release, `kernel/sources/tzdata-<release>.json`, as tools/tzdata/build.py writes it. */
export const zoneTableFile = (root: string = REPO_ROOT): string => join(root, "kernel", "sources", `tzdata-${zoneRelease(root)}.json`);

/** The time zone table, checked to be the release the kernel pins. */
export function loadZoneTable(root: string = REPO_ROOT): ZoneTable {
  const file = zoneTableFile(root);
  const t = JSON.parse(readFileSync(file, "utf8")) as ZoneTable;
  if (t.release !== zoneRelease(root)) throw new Error(`${file} compiles release ${t.release}, and kernel/lists.yaml pins ${zoneRelease(root)}`);
  return t;
}

/** A spec's rule programs, as its file holds them, or none where its folder holds no file. */
export function loadPrograms(specDir: string): Programs {
  const file = join(specDir, RULE_PROGRAMS_FILE);
  if (!existsSync(file)) return { defs: {}, rules: {} };
  const doc = parse(readFileSync(file, "utf8")) as Partial<Programs>;
  return { defs: doc.defs ?? {}, rules: doc.rules ?? {} };
}

/** The checks a spec's programs give, by rule ID: each evaluates its rule's program, with the pinned time zone table, read on the first check. */
export function programChecks(specDir: string, root: string = REPO_ROOT): Record<string, Check> {
  const programs = loadPrograms(specDir);
  let ev: RuleEvaluator | null = null;
  const evaluator = () => (ev ??= new RuleEvaluator(programs, loadZoneTable(root)));
  return Object.fromEntries(Object.keys(programs.rules).sort().map((id) => [id, ((v: unknown) => evaluator().check(id, v)) as Check]));
}

/**
 * The problems with a spec's rule programs: the file isn't valid against
 * its schema, a program names an operation or a definition no evaluator
 * knows (`programProblems`), or a program checks a rule no lock lists.
 */
export function rulesProgramsProblems(specDir: string, rules: ReadonlySet<string>, validate: (doc: unknown) => string[]): { problems: string[]; programs: number } {
  const file = join(specDir, RULE_PROGRAMS_FILE);
  if (!existsSync(file)) return { problems: [], programs: 0 };
  const doc = parse(readFileSync(file, "utf8"));
  const invalid = validate(doc);
  if (invalid.length > 0) return { problems: invalid.map((e) => `${RULE_PROGRAMS_FILE}: ${e}`), programs: 0 };
  const p = doc as Programs;
  const problems = programProblems(p).map((x) => `${RULE_PROGRAMS_FILE}: ${x}`);
  for (const id of Object.keys(p.rules)) if (!rules.has(id)) problems.push(`${RULE_PROGRAMS_FILE}: ${id} has a program, and no lock lists the rule`);
  return { problems, programs: Object.keys(p.rules).length };
}

/** The UTC offsets tools/tzdata/build.py writes from the pinned `tzdata` package, for the names the kernel's list holds, as the bytes it writes. */
export function buildZoneTable(root: string, release: string, names: string[]): { text: string } | { problem: string } {
  const python = join(root, ".venv", "bin", "python");
  const r = spawnSync(python, ["-I", "-B", join(root, "tools", "tzdata", "build.py"), release], { input: `${names.join("\n")}\n`, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // A run that stops before it reads the names, as one for another release does, closes its input early.
  if (r.error && (r.error as NodeJS.ErrnoException).code !== "EPIPE") return { problem: `${python}: ${r.error.message}; run: npm run setup:oracle` };
  if (r.status !== 0) return { problem: `tools/tzdata/build.py failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ")}` };
  return { text: r.stdout };
}
