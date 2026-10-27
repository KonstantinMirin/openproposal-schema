import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitBlobSha, gitTreeSha } from "../src/canonical.ts";
import { checkSnapshot, materialize, materializeExamples, writeSnapshot } from "../src/fetch.ts";
import { loadLock } from "../src/lock.ts";

const SPEC = "# Spec\n\nText.\n";
const EXAMPLES: Record<string, string> = { "examples/a.yaml": "a: 1\n", "examples/b.json": "{}\n" };

/** A clone with the spec and the examples committed, and a repository root with a lock on that commit. */
function fixture(): { root: string; lockFile: string; commit: string; tree: string; done: () => void } {
  const base = mkdtempSync(join(tmpdir(), "snapshot-"));
  const clone = join(base, "clone");
  const write = (dir: string, files: Record<string, string>) => {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
  };
  write(clone, { "spec/spec.md": SPEC, ...EXAMPLES });
  const git = (...args: string[]) => execFileSync("git", ["-C", clone, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "c");
  const commit = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD:examples");
  const root = join(base, "repo");
  mkdirSync(join(root, "spec-input"), { recursive: true });
  const lockFile = join(root, "spec-input", "t.lock.yaml");
  const examples = Object.entries(EXAMPLES).map(([p, t]) => `  ${p}: ${gitBlobSha(Buffer.from(t))}`).join("\n");
  writeFileSync(
    lockFile,
    `name: t\nupstream: https://example.invalid\ncommit: ${commit}\npath: spec/spec.md\nblob: ${gitBlobSha(Buffer.from(SPEC))}\nir_dir: ir\nrequired: true\nexamples:\n${examples}\nexamples_tree: ${tree}\nsources:\n  - git: ../clone\n  - snapshot: spec-input/snapshots/t\n`,
  );
  return { root, lockFile, commit, tree, done: () => rmSync(base, { recursive: true, force: true }) };
}

test("snapshot: a tree SHA computed from names and blobs is the one git records", () => {
  const f = fixture();
  try {
    assert.equal(gitTreeSha(Object.entries(EXAMPLES).map(([p, t]) => ({ name: p.slice("examples/".length), blob: gitBlobSha(Buffer.from(t)) }))), f.tree);
  } finally {
    f.done();
  }
});

test("snapshot: written from the clone, it checks clean, and with the clone gone it supplies the spec, the examples, and their listing", async () => {
  const f = fixture();
  try {
    const lock = loadLock(f.lockFile);
    assert.match(checkSnapshot(lock).problems.join("; "), /no snapshot at spec-input\/snapshots\/t/);
    const w = writeSnapshot(lock);
    assert.equal(w.files, 3);
    const clean = checkSnapshot(lock);
    assert.deepEqual(clean.problems, []);
    assert.match(clean.note, /and the clone at \.\.\/clone$/);
    rmSync(join(f.root, "..", "clone"), { recursive: true, force: true });
    const alone = checkSnapshot(lock);
    assert.deepEqual(alone.problems, []);
    assert.match(alone.note, /no clone reachable$/);
    const m = await materialize(lock);
    assert.equal(m.via, "snapshot spec-input/snapshots/t");
    const x = await materializeExamples(lock);
    assert.equal(x.via, "snapshot spec-input/snapshots/t");
    assert.deepEqual(x.listed, Object.keys(EXAMPLES).sort());
  } finally {
    f.done();
  }
});

test("snapshot: an extra, altered, or stray file fails the check, and an extra example fails the listing's tree", async () => {
  const f = fixture();
  try {
    const lock = loadLock(f.lockFile);
    writeSnapshot(lock);
    rmSync(join(f.root, "..", "clone"), { recursive: true, force: true });
    const snap = join(f.root, "spec-input", "snapshots", "t");
    writeFileSync(join(snap, "examples", "c.yaml"), "c: 1\n");
    writeFileSync(join(snap, "README.md"), "stray\n");
    writeFileSync(join(snap, "examples", "a.yaml"), "a: 2\n");
    const p = checkSnapshot(lock).problems.join("; ");
    assert.match(p, /README\.md is neither the specification nor a file directly under examples\//);
    assert.match(p, /examples\/a\.yaml has blob [0-9a-f]{40}, not the locked/);
    assert.match(p, /the snapshot's examples\/ is tree [0-9a-f]{40}, not the locked/);
    await assert.rejects(materializeExamples(lock), /no source for lock "t" yields its 2 locked examples/);
  } finally {
    f.done();
  }
});

test("snapshot: the writer refuses a clone whose examples tree isn't the lock's pin, and names the tree to pin", () => {
  const f = fixture();
  try {
    const lockText = readFileSync(f.lockFile, "utf8").replace(f.tree, "f".repeat(40));
    writeFileSync(f.lockFile, lockText);
    assert.throws(() => writeSnapshot(loadLock(f.lockFile)), new RegExp(`pin it in t\\.lock\\.yaml as examples_tree: ${f.tree}`));
  } finally {
    f.done();
  }
});

test("snapshot: the committed locks' snapshots check clean", () => {
  const root = new URL("..", import.meta.url).pathname;
  for (const file of ["spec-lock.yaml", "with-open-prs.lock.yaml"]) {
    const r = checkSnapshot(loadLock(join(root, "spec-input", file)));
    assert.deepEqual(r.problems, [], file);
  }
});
