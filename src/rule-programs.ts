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
import { programProblems, RuleEvaluator, type Expr, type Holder, type Programs, type ZoneTable } from "./rule-program.ts";
import type { Check } from "./rule-checks.ts";

export const RULE_PROGRAMS_FILE = "rule-programs.yaml";
/** The kernel's and the constructors' programs, which every spec's types share. */
export const KERNEL_PROGRAMS_FILE = join("kernel", RULE_PROGRAMS_FILE);
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

/** The programs one file holds, or none where there is no file. */
export function loadProgramFile(file: string): Programs {
  if (!existsSync(file)) return { defs: {}, rules: {} };
  const doc = parse(readFileSync(file, "utf8")) as Partial<Programs>;
  return { defs: doc.defs ?? {}, rules: doc.rules ?? {} };
}

/** The names of the pinned lists a set of programs reads with `listed`. */
function listsRead(p: Programs): Set<string> {
  const out = new Set<string>();
  const walk = (e: unknown) => {
    if (!Array.isArray(e)) return;
    if (e[0] === "listed" && typeof e[1] === "string") out.add(e[1]);
    for (const x of e) walk(x);
  };
  for (const e of Object.values(p.defs)) walk(e);
  for (const r of Object.values(p.rules)) for (const x of [r.undecided, ...r.violations.flatMap((v) => [v.each, v.when, v.path, v.message])]) walk(x);
  return out;
}

/** The codes of each pinned list the programs read, from kernel/lists.yaml; a list it doesn't pin is left out, which the rule-programs gate reports. */
function withLists(p: Programs, root: string): Programs {
  const names = listsRead(p);
  if (names.size === 0) return p;
  const doc = parse(readFileSync(join(root, "kernel", "lists.yaml"), "utf8")) as { lists: { name: string; codes: { code: string | number }[] }[] };
  const lists = Object.fromEntries(doc.lists.filter((l) => names.has(l.name)).map((l) => [l.name, l.codes.map((c) => c.code)]));
  return { ...p, lists };
}

/** The kernel's and the constructors' programs, with the codes of the lists they read. */
export function loadKernelPrograms(root: string = REPO_ROOT): Programs {
  return withLists(loadProgramFile(join(root, KERNEL_PROGRAMS_FILE)), root);
}

/**
 * The programs a spec's types are checked by: the kernel's and the
 * constructors', and the spec's own (`rule-programs.yaml` in its folder),
 * with the codes of the lists they read. Throws where the two name one
 * definition or one rule.
 */
export function loadPrograms(specDir: string, root: string = REPO_ROOT): Programs {
  const kernel = loadProgramFile(join(root, KERNEL_PROGRAMS_FILE));
  const spec = loadProgramFile(join(specDir, RULE_PROGRAMS_FILE));
  const twice = [...Object.keys(spec.defs).filter((k) => k in kernel.defs).map((k) => `the definition ${k}`), ...Object.keys(spec.rules).filter((k) => k in kernel.rules)];
  if (twice.length > 0) throw new Error(`${join(specDir, RULE_PROGRAMS_FILE)} and ${KERNEL_PROGRAMS_FILE} both hold ${twice.join(", ")}`);
  return withLists({ defs: { ...kernel.defs, ...spec.defs }, rules: { ...kernel.rules, ...spec.rules } }, root);
}

/**
 * The holder a check's context gives a program that names one: the nearest
 * value of the holder's type whole, where the context holds it, as the
 * examples gate gives each value's holders, or else the members it gives,
 * as `LineItem.pricing` in a vector's context.
 */
export function holderOf(on: string, context: Record<string, unknown>): Holder {
  const whole = context[on];
  if (whole !== null && typeof whole === "object" && !Array.isArray(whole)) return { value: whole, whole: true };
  const prefix = `${on}.`;
  return { value: Object.fromEntries(Object.entries(context).filter(([k]) => k.startsWith(prefix)).map(([k, x]) => [k.slice(prefix.length), x])), whole: false };
}

/** The checks a set of programs gives, by rule ID: each evaluates its rule's program on the owner's value, with its holder from the check's context, and with the pinned time zone table, read on the first check. */
export function checksOf(programs: Programs, root: string = REPO_ROOT): Record<string, Check> {
  let ev: RuleEvaluator | null = null;
  const evaluator = () => (ev ??= new RuleEvaluator(programs, loadZoneTable(root)));
  return Object.fromEntries(
    Object.entries(programs.rules)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, p]) => [id, ((v, ctx) => evaluator().check(id, v, p.on === undefined || p.on === p.owner ? null : holderOf(p.on, ctx.context), ctx.part)) as Check]),
  );
}

/** The checks a spec's own programs give, by rule ID. */
export function programChecks(specDir: string, root: string = REPO_ROOT): Record<string, Check> {
  const own = loadProgramFile(join(specDir, RULE_PROGRAMS_FILE));
  const all = checksOf(loadPrograms(specDir, root), root);
  return Object.fromEntries(Object.keys(own.rules).map((id) => [id, all[id]!]));
}

/** The checks the kernel's and the constructors' programs give, by rule ID. */
export function kernelProgramChecks(root: string = REPO_ROOT): Record<string, Check> {
  return checksOf(loadKernelPrograms(root), root);
}

/**
 * The problems with a spec's rule programs: the file isn't valid against
 * its schema, a program names an operation or a definition no evaluator
 * knows (`programProblems`), or a program checks a rule no lock lists.
 */
export function rulesProgramsProblems(file: string, rules: ReadonlySet<string>, validate: (doc: unknown) => string[], root: string = REPO_ROOT, label: string = RULE_PROGRAMS_FILE, unknown = "no lock lists the rule"): { problems: string[]; programs: number } {
  if (!existsSync(file)) return { problems: [], programs: 0 };
  const doc = parse(readFileSync(file, "utf8"));
  const invalid = validate(doc);
  if (invalid.length > 0) return { problems: invalid.map((e) => `${label}: ${e}`), programs: 0 };
  const p = withLists(doc as Programs, root);
  const problems = programProblems(p).map((x) => `${label}: ${x}`);
  for (const id of Object.keys(p.rules)) if (!rules.has(id)) problems.push(`${label}: ${id} has a program, and ${unknown}`);
  return { problems, programs: Object.keys(p.rules).length };
}

/** The IDs of the rules kernel/primitives.yaml and kernel/constructors.yaml state, which the kernel's programs may check. */
export function kernelRuleIds(root: string = REPO_ROOT): Set<string> {
  const out = new Set<string>();
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (x === null || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    if (Array.isArray(o.rules)) for (const r of o.rules) if (r !== null && typeof r === "object" && typeof (r as { id?: unknown }).id === "string") out.add((r as { id: string }).id);
    Object.values(o).forEach(walk);
  };
  for (const f of ["primitives.yaml", "constructors.yaml"]) walk(parse(readFileSync(join(root, "kernel", f), "utf8")));
  return out;
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

/** The programs of some rules alone: those rules, the definitions they read, and the codes of the lists they read, as an SDK holds them. */
export function programsOf(p: Programs, ids: string[]): Programs {
  const rules = Object.fromEntries(ids.map((id) => [id, p.rules[id]!]));
  const defs: Record<string, Expr> = {};
  const lists = new Set<string>();
  const walk = (e: unknown) => {
    if (!Array.isArray(e)) return;
    if (e[0] === "def" && typeof e[1] === "string" && !(e[1] in defs) && e[1] in p.defs) {
      defs[e[1]] = p.defs[e[1]]!;
      walk(p.defs[e[1]]);
    }
    if (e[0] === "listed" && typeof e[1] === "string") lists.add(e[1]);
    for (const x of e) walk(x);
  };
  for (const r of Object.values(rules)) for (const x of [r.undecided, ...r.violations.flatMap((v) => [v.each, v.when, v.path, v.message])]) walk(x);
  const sortedDefs = Object.fromEntries(Object.keys(defs).sort().map((k) => [k, defs[k]!]));
  const codes = Object.fromEntries([...lists].sort().flatMap((n) => (p.lists?.[n] ? [[n, p.lists[n]!]] : [])));
  return { defs: sortedDefs, rules, ...(Object.keys(codes).length > 0 ? { lists: codes } : {}) };
}

/**
 * The time zone table an SDK holds, as JSON text: the pinned release's,
 * where a program counts calendar days in a zone (`local_day`), and else the
 * release's with no zones, so an SDK whose rules read no zone carries none.
 */
export function zoneTableText(p: Programs, root: string = REPO_ROOT): string {
  let reads = false;
  const walk = (e: unknown) => {
    if (!Array.isArray(e) || reads) return;
    if (e[0] === "local_day") reads = true;
    for (const x of e) walk(x);
  };
  for (const e of Object.values(p.defs)) walk(e);
  for (const r of Object.values(p.rules)) for (const x of [r.undecided, ...r.violations.flatMap((v) => [v.each, v.when, v.path, v.message])]) walk(x);
  if (reads) return readFileSync(zoneTableFile(root), "utf8").trim();
  return JSON.stringify({ format: 1, from: 0, names: {}, release: zoneRelease(root), until: 0, zones: {} });
}
