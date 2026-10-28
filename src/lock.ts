import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parse } from "yaml";

/**
 * One way to obtain the specification bytes. Sources are tried in order. A
 * clone is read at the commit; a snapshot is a directory in this repository
 * that holds the commit's specification and `examples/` files at their paths
 * (`npm run fetch -- --snapshot` writes it); a URL serves the raw file.
 */
export type Source = { git: string } | { snapshot: string } | { url: string };

/** A source's kind and location, for a gate's note. */
export const sourceLabel = (s: Source): string => ("git" in s ? `git ${s.git}` : "snapshot" in s ? `snapshot ${s.snapshot}` : `url ${s.url}`);

export interface SpecLock {
  /** Short name; used for the build directory and for exception scoping. */
  name: string;
  upstream: string;
  commit: string;
  path: string;
  blob: string;
  /** Directory, relative to the spec's folder (`repoRoot`), that receives the IR and findings. */
  ir_dir: string;
  /** When false, CI may skip regeneration if no source is reachable. */
  required: boolean;
  sources: Source[];
  base: string | null;
  merge_order: unknown[] | null;
  /** The example files at `commit`, by path from the repository root, with their git blob SHAs; empty when the lock lists none. */
  examples: Record<string, string>;
  /** The git tree SHA of `examples/` at `commit`, which pins the directory's listing; null when the lock pins none. */
  examples_tree: string | null;
  /** The day, `YYYY-MM-DD`, on which each head in `merge_order` was its PR's live head; null for a lock that merges nothing. */
  heads_on: string | null;
  /** What the integration changed outside the PRs, apart from resolving their conflicts, each as a clause for the working group, such as "added `x` to the example of #70"; empty when nothing. */
  edits: string[];
  /** The upstream tag that names `commit`, for a lock on a release; null for one on a branch. CI checks that the tag still names the commit where a clone is reachable. */
  tag: string | null;
  /** Absolute path of the lock file. */
  file: string;
}

const SHA1 = /^[0-9a-f]{40}$/;

export function loadLock(file: string): SpecLock {
  const abs = resolve(file);
  const doc = parse(readFileSync(abs, "utf8"), { version: "1.2", schema: "core", uniqueKeys: true }) as Record<string, unknown>;
  const fail = (why: string): never => {
    throw new Error(`${basename(abs)}: ${why}`);
  };
  const str = (key: string): string => {
    const v = doc[key];
    if (typeof v !== "string" || v === "") return fail(`"${key}" must be a non-empty string`);
    return v;
  };
  const known = new Set(["name", "upstream", "commit", "path", "blob", "ir_dir", "required", "sources", "base", "merge_order", "examples", "examples_tree", "heads_on", "edits", "tag"]);
  for (const key of Object.keys(doc)) if (!known.has(key)) fail(`unknown key "${key}"`);
  const commit = str("commit");
  const blob = str("blob");
  if (!SHA1.test(commit)) fail(`"commit" must be a full 40-character SHA`);
  if (!SHA1.test(blob)) fail(`"blob" must be a full 40-character SHA`);
  const base = doc.base === undefined ? null : str("base");
  if (base !== null && !SHA1.test(base)) fail(`"base" must be a full 40-character SHA`);
  if (typeof doc.required !== "boolean") fail(`"required" must be true or false`);
  const sources = doc.sources;
  if (!Array.isArray(sources) || sources.length === 0) fail(`"sources" must list at least one source`);
  for (const s of sources as unknown[]) {
    const ok =
      s !== null &&
      typeof s === "object" &&
      Object.keys(s).length === 1 &&
      ["git", "snapshot", "url"].some((k) => typeof (s as Record<string, unknown>)[k] === "string");
    if (!ok) fail(`each source is { git: <clone path> }, { snapshot: <directory> }, or { url: <raw URL> }`);
  }
  const mergeOrder = doc.merge_order === undefined ? null : doc.merge_order;
  if (mergeOrder !== null && !Array.isArray(mergeOrder)) fail(`"merge_order" must be a list`);
  const examples = doc.examples === undefined ? {} : doc.examples;
  if (examples === null || typeof examples !== "object" || Array.isArray(examples)) fail(`"examples" maps each example's path to its blob SHA`);
  for (const [path, sha] of Object.entries(examples as Record<string, unknown>)) {
    if (!/^examples\/[^/]+$/.test(path)) fail(`example "${path}" isn't a file directly under examples/`);
    if (typeof sha !== "string" || !SHA1.test(sha)) fail(`example "${path}" needs a full 40-character blob SHA`);
  }
  const examplesTree = doc.examples_tree === undefined ? null : str("examples_tree");
  if (examplesTree !== null && !SHA1.test(examplesTree)) fail(`"examples_tree" must be a full 40-character SHA`);
  const headsOn = doc.heads_on === undefined ? null : str("heads_on");
  if (headsOn !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(headsOn) || Number.isNaN(Date.parse(`${headsOn}T00:00:00Z`)) || new Date(`${headsOn}T00:00:00Z`).toISOString().slice(0, 10) !== headsOn)) fail(`"heads_on" must be a calendar date, YYYY-MM-DD`);
  if (headsOn !== null && mergeOrder === null) fail(`"heads_on" dates the heads in "merge_order", which the lock doesn't have`);
  if (mergeOrder !== null && headsOn === null) fail(`a lock with "merge_order" needs "heads_on", the day each head was its PR's live head`);
  const edits = doc.edits === undefined ? [] : doc.edits;
  if (!Array.isArray(edits) || edits.some((e) => typeof e !== "string" || e.trim() === "")) fail(`"edits" must be a list of non-empty strings`);
  if ((edits as unknown[]).length > 0 && mergeOrder === null) fail(`"edits" says what an integration changed beside its merges, and the lock merges nothing`);
  return {
    name: str("name"),
    upstream: str("upstream"),
    commit,
    path: str("path"),
    blob,
    ir_dir: str("ir_dir"),
    required: doc.required as boolean,
    sources: sources as Source[],
    base,
    merge_order: mergeOrder as unknown[] | null,
    examples: examples as Record<string, string>,
    examples_tree: examplesTree,
    heads_on: headsOn,
    edits: edits as string[],
    tag: doc.tag === undefined ? null : str("tag"),
    file: abs,
  };
}

/**
 * The root of the lock's specification: the folder whose `spec-input/` holds
 * the lock, `specs/<spec>/` (src/repo.ts). Every path a lock names, and every
 * spec input and output, is relative to it.
 */
export function repoRoot(lock: SpecLock): string {
  return dirname(dirname(lock.file));
}
