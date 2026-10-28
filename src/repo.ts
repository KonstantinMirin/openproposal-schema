/**
 * Where the repository keeps what: the tooling, the shared kernel, and the
 * format schemas at the root, and each specification's inputs and outputs in
 * its own folder, `specs/<spec>/`.
 *
 * A spec's folder holds its locks (`spec-input/`), IR, mapping, decision
 * records, vectors, and every output generated from them, at the same paths
 * relative to the folder that the single-spec layout used relative to the
 * repository root. So `repoRoot(lock)` (src/lock.ts) is the folder of the
 * lock's spec, and a path such as `schemas/documents/1/proposal.json` is the
 * same string in either layout. The SDK trees stay under the root's `sdk/`,
 * whose path the Go module paths name.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository's root: the tooling, `kernel/`, the format schemas, `sdk/`, and `specs/`. */
export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/** The folder that holds one folder per specification. */
export const SPECS_DIR = "specs";

/** The specification a command builds when it is given no lock and no spec. */
export const DEFAULT_SPEC = "openproposal";

/** The default spec's default lock, which a command that reads one lock reads when it is given none. */
export const DEFAULT_LOCK_NAME = "spec-lock.yaml";

/** The folder of a specification. */
export const specRoot = (spec: string = DEFAULT_SPEC, root: string = REPO_ROOT): string => join(root, SPECS_DIR, spec);

/** Each specification's name: every folder under `specs/`, sorted. Each must hold its profile, `spec.yaml` (src/profile.ts); CI fails one that doesn't, so no spec is skipped. */
export function specNames(root: string = REPO_ROOT): string[] {
  const dir = join(root, SPECS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** A lock file's name: the default lock, `spec-lock.yaml`, or any other `<name>.lock.yaml`. */
export const isLockFile = (f: string): boolean => f === DEFAULT_LOCK_NAME || f.endsWith(".lock.yaml");

/** The lock files under a spec folder's `spec-input/`, by absolute path, sorted, so the default lock comes first. */
export function lockFiles(specDir: string): string[] {
  const dir = join(specDir, "spec-input");
  return readdirSync(dir)
    .filter(isLockFile)
    .sort()
    .map((f) => join(dir, f));
}

/** The default lock file of the default spec, by absolute path. */
export const DEFAULT_LOCK = join(specRoot(), "spec-input", DEFAULT_LOCK_NAME);
