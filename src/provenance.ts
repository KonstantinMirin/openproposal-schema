/**
 * Line provenance for a lock that merges open PRs: for each line of the
 * lock's specification, the PR that wrote it, with the commit and the line
 * there, so a page can link a line of an integration commit that isn't on
 * GitHub to the same line where the PR wrote it.
 *
 * `npm run provenance` reads a local clone that holds the lock's commit and
 * every head in its `merge_order`, runs `git blame` at the commit, and maps
 * each line's origin commit to the first PR in merge order whose commits,
 * from the lock's base to its head, hold it; a line whose origin is on the
 * base is `main`'s, and a line the integration wrote, such as a conflict
 * resolution, has no PR. It writes `spec-input/provenance/<lock>.json`,
 * which names the commit and blob it was computed for, so a page builder can
 * tell a stale file from a current one without the clone.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "./canonical.ts";
import type { SpecLock } from "./lock.ts";

export const PROVENANCE_DIR = join("spec-input", "provenance");

/** Where one line of the lock's specification comes from: a PR's commit, or `main`'s with `pr` null, and the line's number there; null for a line the integration wrote. */
export type LineOrigin = { pr: number | null; commit: string; path: string; line: number } | null;

export interface ProvenanceDoc {
  format: 1;
  lock: string;
  commit: string;
  blob: string;
  /** The origin of each line, the first line first. */
  lines: LineOrigin[];
}

const git = (dir: string, args: string[]): string => {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
};

/** Computes a lock's line provenance from a clone that holds its commit and every PR head. */
export function computeProvenance(lock: SpecLock, clone: string): ProvenanceDoc {
  if (lock.base === null || lock.merge_order === null) throw new Error(`${lock.name} merges no PRs, so its lines are its commit's`);
  const heads = (lock.merge_order as { pr: number; head: string }[]).map((m) => ({ pr: m.pr, head: m.head }));
  const prOf = new Map<string, number>();
  for (const { pr, head } of heads) {
    for (const c of git(clone, ["rev-list", `${lock.base}..${head}`]).split("\n").filter(Boolean)) if (!prOf.has(c)) prOf.set(c, pr);
  }
  const base = new Set(git(clone, ["rev-list", lock.base]).split("\n").filter(Boolean));
  const porcelain = git(clone, ["blame", "--porcelain", lock.commit, "--", lock.path]).split("\n");
  const files = new Map<string, string>();
  const lines: LineOrigin[] = [];
  let current: { commit: string; line: number } | null = null;
  for (const l of porcelain) {
    const head = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(l);
    if (head) {
      current = { commit: head[1]!, line: Number(head[2]) };
      continue;
    }
    if (l.startsWith("filename ") && current) files.set(current.commit, l.slice("filename ".length));
    if (l.startsWith("\t") && current) {
      const { commit, line } = current;
      const path = files.get(commit) ?? lock.path;
      lines.push(base.has(commit) ? { pr: null, commit, path, line } : prOf.has(commit) ? { pr: prOf.get(commit)!, commit, path, line } : null);
      current = null;
    }
  }
  const blob = git(clone, ["rev-parse", `${lock.commit}:${lock.path}`]).trim();
  if (blob !== lock.blob) throw new Error(`${lock.name}: the clone's blob at ${lock.commit} is ${blob}, not the lock's ${lock.blob}`);
  return { format: 1, lock: lock.name, commit: lock.commit, blob, lines };
}

export const renderProvenance = (doc: ProvenanceDoc): string => canonicalJson(doc);

/** A lock's committed line provenance, or null when it has none; throws on a file computed for another commit or blob. */
export function loadProvenance(root: string, lock: SpecLock): ProvenanceDoc | null {
  const file = join(root, PROVENANCE_DIR, `${lock.name}.json`);
  if (!existsSync(file)) return null;
  const doc = JSON.parse(readFileSync(file, "utf8")) as ProvenanceDoc;
  if (doc.blob !== lock.blob || doc.commit !== lock.commit) throw new Error(`${file} was computed for ${doc.commit.slice(0, 7)} (blob ${doc.blob.slice(0, 7)}), not the lock's ${lock.commit.slice(0, 7)}; run: npm run provenance`);
  return doc;
}
