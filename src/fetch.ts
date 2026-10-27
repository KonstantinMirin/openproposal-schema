import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, posix, resolve } from "node:path";
import { gitBlobSha, gitTreeSha } from "./canonical.ts";
import { repoRoot, sourceLabel, type SpecLock } from "./lock.ts";

export interface Materialized {
  file: string;
  bytes: Buffer;
  /** Which source supplied the bytes. Not recorded in the IR, because it varies by machine. */
  via: string;
}

/** The build path a lock's specification is materialized to. */
export function specPath(lock: SpecLock): string {
  return join(repoRoot(lock), "build", "spec", lock.name, basename(lock.path));
}

/**
 * Writes the locked specification into `build/spec/<name>/`, and verifies its
 * git blob SHA. A file already there is reused only if its SHA matches.
 * Throws if no source yields the locked bytes.
 */
export async function materialize(lock: SpecLock): Promise<Materialized> {
  const out = specPath(lock);
  if (existsSync(out)) {
    const bytes = readFileSync(out);
    if (gitBlobSha(bytes) === lock.blob) return { file: out, bytes, via: "build cache" };
  }
  const errors: string[] = [];
  for (const source of lock.sources) {
    const via = sourceLabel(source);
    let bytes: Buffer;
    try {
      bytes = "git" in source ? fromGit(resolve(repoRoot(lock), source.git), lock.commit, lock.path) : "snapshot" in source ? fromSnapshot(lock, source.snapshot, lock.path) : await fromUrl(source.url);
    } catch (e) {
      errors.push(`${via}: ${(e as Error).message.split("\n")[0]}`);
      continue;
    }
    const sha = gitBlobSha(bytes);
    if (sha !== lock.blob) {
      errors.push(`${via}: blob ${sha} does not match the locked blob ${lock.blob}`);
      continue;
    }
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, bytes);
    return { file: out, bytes, via };
  }
  throw new Error(`no source for lock "${lock.name}" yields blob ${lock.blob}:\n  ${errors.join("\n  ")}`);
}

/** The materialized examples of a lock: each file's bytes by its path, such as `examples/proposal.yaml`. */
export interface MaterializedExamples {
  files: Map<string, Buffer>;
  /** The paths under `examples/` at the commit, when a clone or a snapshot can list them; null when only URLs were reachable. */
  listed: string[] | null;
  via: string;
}

/**
 * Writes each example file the lock lists into `build/spec/<name>/examples/`
 * and verifies its git blob SHA, as `materialize` does for the specification.
 * A source is a clone, read at the commit, or a raw URL of the specification,
 * whose path is replaced with the example's. A clone or a snapshot also lists
 * the files under `examples/` at the commit, so the gate can check that the
 * lock lists all of them; where the lock pins `examples_tree`, the listing
 * must hash to it. Throws if no source yields every locked blob.
 */
export async function materializeExamples(lock: SpecLock): Promise<MaterializedExamples> {
  const paths = Object.keys(lock.examples).sort();
  const outOf = (p: string) => join(repoRoot(lock), "build", "spec", lock.name, p);
  const errors: string[] = [];
  for (const source of lock.sources) {
    const via = sourceLabel(source);
    const files = new Map<string, Buffer>();
    let listed: string[] | null = null;
    try {
      if ("git" in source) {
        const clone = resolve(repoRoot(lock), source.git);
        listed = gitList(clone, lock.commit, "examples/");
        for (const p of paths) files.set(p, fromGit(clone, lock.commit, p));
        if (lock.examples_tree !== null && listed.length > 0) {
          const tree = gitTree(clone, lock.commit, "examples");
          if (tree !== lock.examples_tree) throw new Error(`examples/ at the commit is tree ${tree}, not the locked ${lock.examples_tree}`);
        }
      } else if ("snapshot" in source) {
        const listing = snapshotExamples(lock, source.snapshot);
        listed = [...listing.keys()];
        for (const p of paths) files.set(p, fromSnapshot(lock, source.snapshot, p));
        const tree = examplesTree(listing);
        if (lock.examples_tree !== null && tree !== lock.examples_tree) throw new Error(`the snapshot's examples/ is tree ${tree}, not the locked ${lock.examples_tree}`);
      } else {
        if (!source.url.endsWith(`/${lock.path}`)) throw new Error(`the URL doesn't end with the specification's path ${lock.path}`);
        const base = source.url.slice(0, -lock.path.length);
        for (const p of paths) {
          const cached = outOf(p);
          const hit = existsSync(cached) ? readFileSync(cached) : null;
          files.set(p, hit && gitBlobSha(hit) === lock.examples[p] ? hit : await fromUrl(`${base}${p}`));
        }
      }
    } catch (e) {
      errors.push(`${via}: ${(e as Error).message.split("\n")[0]}`);
      continue;
    }
    const wrong = paths.filter((p) => gitBlobSha(files.get(p)!) !== lock.examples[p]);
    if (wrong.length > 0) {
      errors.push(`${via}: ${wrong.map((p) => `${p} has blob ${gitBlobSha(files.get(p)!)}, not the locked ${lock.examples[p]}`).join("; ")}`);
      continue;
    }
    for (const [p, bytes] of files) {
      mkdirSync(join(outOf(p), ".."), { recursive: true });
      writeFileSync(outOf(p), bytes);
    }
    return { files, listed, via };
  }
  throw new Error(`no source for lock "${lock.name}" yields its ${paths.length} locked examples:\n  ${errors.join("\n  ")}`);
}

/** The files directly under `examples/` of a snapshot, by path, with their bytes; empty when it has no `examples/`. Throws on anything but a regular file. */
function snapshotExamples(lock: SpecLock, dir: string): Map<string, Buffer> {
  const abs = join(repoRoot(lock), dir, "examples");
  if (!existsSync(join(repoRoot(lock), dir))) throw new Error(`no snapshot at ${dir}`);
  const out = new Map<string, Buffer>();
  if (!existsSync(abs)) return out;
  for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!e.isFile()) throw new Error(`${posix.join(dir, "examples", e.name)} isn't a regular file`);
    out.set(`examples/${e.name}`, readFileSync(join(abs, e.name)));
  }
  return out;
}

/** The git tree SHA of an `examples/` listing, by path, with its bytes. */
function examplesTree(listing: Map<string, Buffer>): string {
  return gitTreeSha([...listing].map(([p, bytes]) => ({ name: p.slice("examples/".length), blob: gitBlobSha(bytes) })));
}

function fromSnapshot(lock: SpecLock, dir: string, path: string): Buffer {
  const abs = join(repoRoot(lock), dir, path);
  if (!existsSync(abs)) throw new Error(`no ${path} in the snapshot at ${dir}`);
  return readFileSync(abs);
}

/** The snapshot directory a lock lists, or null. */
export function snapshotOf(lock: SpecLock): string | null {
  for (const s of lock.sources) if ("snapshot" in s) return s.snapshot;
  return null;
}

/**
 * Checks a lock's snapshot against the lock's pins, with no other source: it
 * holds the specification, with the locked blob, and the files under
 * `examples/` and nothing else; every locked example has its blob; and the
 * `examples/` listing hashes to `examples_tree`. Where a clone source is
 * reachable, the tree at the commit must be `examples_tree` too, so the pin
 * itself is checked.
 */
export function checkSnapshot(lock: SpecLock): { problems: string[]; note: string } {
  const dir = snapshotOf(lock);
  if (dir === null) return { problems: [`${basename(lock.file)} lists no snapshot source; write one with: npm run fetch -- --lock spec-input/${basename(lock.file)} --snapshot`], note: "" };
  const root = repoRoot(lock);
  if (!existsSync(join(root, dir))) return { problems: [`no snapshot at ${dir}; write it with: npm run fetch -- --lock spec-input/${basename(lock.file)} --snapshot`], note: "" };
  const problems: string[] = [];
  const walk = (rel: string): string[] =>
    readdirSync(join(root, dir, rel), { withFileTypes: true }).flatMap((e) => {
      const p = rel === "" ? e.name : `${rel}/${e.name}`;
      return e.isDirectory() ? walk(p) : [p];
    });
  for (const p of walk("").sort()) if (p !== lock.path && !/^examples\/[^/]+$/.test(p)) problems.push(`${posix.join(dir, p)} is neither the specification nor a file directly under examples/`);
  const spec = existsSync(join(root, dir, lock.path)) ? readFileSync(join(root, dir, lock.path)) : null;
  if (spec === null) problems.push(`the snapshot has no ${lock.path}`);
  else if (gitBlobSha(spec) !== lock.blob) problems.push(`${posix.join(dir, lock.path)} has blob ${gitBlobSha(spec)}, not the locked ${lock.blob}`);
  let listing = new Map<string, Buffer>();
  try {
    listing = snapshotExamples(lock, dir);
  } catch (e) {
    problems.push((e as Error).message);
  }
  for (const [p, sha] of Object.entries(lock.examples)) {
    const bytes = listing.get(p);
    if (!bytes) problems.push(`the snapshot has no ${p}`);
    else if (gitBlobSha(bytes) !== sha) problems.push(`${posix.join(dir, p)} has blob ${gitBlobSha(bytes)}, not the locked ${sha}`);
  }
  const tree = examplesTree(listing);
  if (listing.size > 0 || lock.examples_tree !== null) {
    if (lock.examples_tree === null) problems.push(`${basename(lock.file)} pins no examples_tree; the snapshot's examples/ is tree ${tree}`);
    else if (tree !== lock.examples_tree) problems.push(`the snapshot's examples/ is tree ${tree}, not the locked ${lock.examples_tree}`);
  }
  const clones = lock.sources.flatMap((s) => ("git" in s && existsSync(resolve(root, s.git)) ? [s.git] : []));
  let note = "checked against the lock's pins; no clone reachable";
  if (clones.length > 0) {
    const clone = resolve(root, clones[0]!);
    try {
      const atCommit = listing.size > 0 || lock.examples_tree !== null ? gitTree(clone, lock.commit, "examples") : null;
      if (atCommit !== null && atCommit !== lock.examples_tree) problems.push(`examples/ at ${lock.commit.slice(0, 7)} in ${clones[0]} is tree ${atCommit}, not the locked ${lock.examples_tree}`);
      note = `checked against the lock's pins and the clone at ${clones[0]}`;
    } catch (e) {
      problems.push(`${clones[0]}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return { problems, note: `${dir}: the specification and ${listing.size} example files, ${note}` };
}

/**
 * Writes a lock's snapshot from its first reachable clone: the specification
 * and every file under `examples/` at the commit, each verified against the
 * lock's blob SHAs and the listing against `examples_tree`. The directory is
 * replaced whole. Throws when no clone yields the locked bytes.
 */
export function writeSnapshot(lock: SpecLock): { dir: string; files: number; via: string } {
  const dir = snapshotOf(lock);
  if (dir === null) throw new Error(`${basename(lock.file)} lists no snapshot source; add one, such as { snapshot: spec-input/snapshots/${lock.name} }`);
  const root = repoRoot(lock);
  const errors: string[] = [];
  for (const source of lock.sources) {
    if (!("git" in source)) continue;
    const clone = resolve(root, source.git);
    let files: Map<string, Buffer>;
    let tree: string | null = null;
    try {
      const listed = gitList(clone, lock.commit, "examples/");
      files = new Map([[lock.path, fromGit(clone, lock.commit, lock.path)], ...listed.map((p): [string, Buffer] => [p, fromGit(clone, lock.commit, p)])]);
      if (listed.length > 0) tree = gitTree(clone, lock.commit, "examples");
    } catch (e) {
      errors.push(`git ${source.git}: ${(e as Error).message.split("\n")[0]}`);
      continue;
    }
    const wrong = [
      ...(gitBlobSha(files.get(lock.path)!) === lock.blob ? [] : [`${lock.path} has blob ${gitBlobSha(files.get(lock.path)!)}, not the locked ${lock.blob}`]),
      ...Object.entries(lock.examples).flatMap(([p, sha]) => (!files.has(p) ? [`${p} isn't at the commit`] : gitBlobSha(files.get(p)!) === sha ? [] : [`${p} has blob ${gitBlobSha(files.get(p)!)}, not the locked ${sha}`])),
      ...(tree === lock.examples_tree ? [] : [tree === null ? `the commit has no examples/, and the lock pins examples_tree ${lock.examples_tree}` : `examples/ at the commit is tree ${tree}; pin it in ${basename(lock.file)} as examples_tree: ${tree}`]),
    ];
    if (wrong.length > 0) throw new Error(`git ${source.git}: ${wrong.join("; ")}`);
    rmSync(join(root, dir), { recursive: true, force: true });
    for (const [p, bytes] of files) {
      mkdirSync(join(root, dir, p, ".."), { recursive: true });
      writeFileSync(join(root, dir, p), bytes);
    }
    return { dir, files: files.size, via: `git ${source.git}` };
  }
  throw new Error(`no clone of lock "${lock.name}" is reachable, and only a clone can list examples/ at the commit:\n  ${errors.join("\n  ") || "the lock lists no clone"}`);
}

/** The tree SHA of a directory of a clone at a commit. */
function gitTree(clone: string, commit: string, dir: string): string {
  if (!existsSync(clone)) throw new Error(`no clone at ${clone}`);
  return execFileSync("git", ["-C", clone, "rev-parse", `${commit}:${dir}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The files directly under a directory of a clone at a commit. */
function gitList(clone: string, commit: string, dir: string): string[] {
  if (!existsSync(clone)) throw new Error(`no clone at ${clone}`);
  const out = execFileSync("git", ["-C", clone, "ls-tree", "--name-only", commit, dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return out.split("\n").filter((l) => l !== "").sort();
}

function fromGit(clone: string, commit: string, path: string): Buffer {
  if (!existsSync(clone)) throw new Error(`no clone at ${clone}`);
  return execFileSync("git", ["-C", clone, "cat-file", "blob", `${commit}:${path}`], {
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function fromUrl(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
