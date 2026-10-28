/**
 * The checks several gates share: two runs equal to the in-process output,
 * the committed output equal to it, and every tracked file one the pipeline
 * writes. Each gate that uses one names it in its `code`, so the check is
 * part of the gate's fingerprint.
 */
import { spawnSync } from "node:child_process";
import { ROOT, type Result } from "./harness.ts";

/** Two runs of a command in separate processes, each the bytes it wrote or null, against the in-process bytes. */
export interface RunsInput {
  label: string;
  want: Buffer;
  runs: (Buffer | null)[];
  /** What the in-process bytes come from, for the note. */
  from: string;
}

export function sameRuns(i: RunsInput): Result {
  const problems = i.runs.flatMap((b, n) => (b === null ? [`run ${n + 1} wrote no ${i.label}`] : b.equals(i.want) ? [] : [`run ${n + 1} differs from the in-process ${i.from}`]));
  if (i.runs.length < 2) problems.push(`${i.runs.length} runs; determinism needs two`);
  return { problems, note: `two runs byte-identical, equal to the in-process ${i.from}` };
}

/** Two runs that each wrote a tree of files, by path, against the in-process files. */
export interface TreeRunsInput {
  label: string;
  want: Map<string, Buffer>;
  runs: Map<string, Buffer>[];
  from: string;
}

/** The files two trees differ in. */
export function treeDiff(want: Map<string, Buffer>, got: Map<string, Buffer>): string[] {
  const paths = [...new Set([...want.keys(), ...got.keys()])].sort();
  return paths.flatMap((p) => {
    const a = want.get(p);
    const b = got.get(p);
    if (a && b) return a.equals(b) ? [] : [`${p} differs`];
    return [a ? `${p} missing` : `${p} not emitted`];
  });
}

export function sameTreeRuns(i: TreeRunsInput): Result {
  const problems = i.runs.flatMap((r, n) => treeDiff(i.want, r).map((d) => `run ${n + 1}: ${d}`));
  if (i.runs.length < 2) problems.push(`${i.runs.length} runs; determinism needs two`);
  return { problems, note: `two runs byte-identical, equal to the in-process ${i.from}` };
}

/** The committed bytes of one generated file, or null when it is missing, against what the pipeline writes. */
export interface CommittedInput {
  file: string;
  want: Buffer;
  committed: Buffer | null;
  regenerate: string;
}

export function committedCurrent(i: CommittedInput): Result {
  return { problems: i.committed !== null && i.committed.equals(i.want) ? [] : [`${i.file} ${i.committed === null ? "is missing" : "isn't what the pipeline writes"}; regenerate with: ${i.regenerate}`] };
}

/** A committed tree of generated files against what the pipeline writes. */
export interface CommittedTreeInput {
  dir: string;
  want: Map<string, Buffer>;
  committed: Map<string, Buffer>;
  regenerate: string;
}

export function committedTreeCurrent(i: CommittedTreeInput): Result {
  const drift = treeDiff(i.want, i.committed);
  return { problems: drift.length === 0 ? [] : [`${drift.slice(0, 20).join("; ")}; regenerate with: ${i.regenerate}`] };
}

/** The files git tracks under a directory, against the files the pipeline writes there. */
export interface TrackedInput {
  dir: string;
  tracked: string[];
  expected: string[];
  /** What to do about a stray file. */
  remedy: string;
}

export function onlyGenerated(i: TrackedInput): Result {
  const expected = new Set(i.expected);
  const stray = i.tracked.filter((p) => p !== "" && !expected.has(p));
  return { problems: stray.length === 0 ? [] : [`${stray.slice(0, 20).join("; ")}; ${i.remedy}`], note: `${expected.size} files` };
}

/** The files git tracks under a path, by path from `cwd`, the repository's root or a spec's folder. Throws when git fails. */
export function gitTracked(path: string, cwd = ROOT): string[] {
  const r = spawnSync("git", ["ls-files", path], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ls-files ${path} failed: ${r.stderr}`);
  return r.stdout.split("\n").filter((p) => p !== "");
}

/** A command's run, for a gate whose check is a tool's verdict. */
export function runTool(cmd: string, args: string[], cwd = ROOT, env: Record<string, string> = {}): { ok: boolean; output: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0", ...env } });
  return { ok: r.status === 0, output: `${r.error?.message ?? ""}${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** A change to one byte of a buffer, for a fixture: the bytes no longer match. */
export const flipped = (b: Buffer): Buffer => {
  const c = Buffer.from(b);
  c[c.length - 1] = c[c.length - 1] === 0x7d ? 0x20 : 0x7d;
  return c;
};

/** The first entry of a map, changed by one byte. */
export function flipFirst(m: Map<string, Buffer>): Map<string, Buffer> {
  const out = new Map(m);
  const first = [...m.keys()].sort()[0];
  if (first !== undefined) out.set(first, flipped(m.get(first)!));
  return out;
}
