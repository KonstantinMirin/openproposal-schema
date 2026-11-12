import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cliSpec } from "../builds.ts";
import { deskAdd, readSource } from "../desk-add.ts";
import { loadLock } from "../lock.ts";
import { REPO_ROOT } from "../repo.ts";

/**
 * Usage: desk:add [--lock <file>] [--document <Name>] <gist-url | path> <set>
 *
 * Adds a desk-test set: copies the payloads of a gist, at its current
 * revision, read with `gh api gists/<id>`, or of a local folder, into
 * `desk-tests/<set>/` of the lock's spec, judges each with every engine of
 * the desk-tests gate, and writes a draft `expected.yaml` and `README.md`
 * for review, and the report to stdout and `build/desk-add-<set>.md`. The
 * lock is with-our-stack's unless `--lock` names another. Commits nothing;
 * the gate fails until the draft is reviewed.
 */
async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { lock: { type: "string" }, document: { type: "string" } } });
  if (positionals.length !== 2) {
    console.error("usage: npm run desk:add -- [--lock <file>] [--document <Name>] <gist-url | path> <set>");
    return 2;
  }
  const [ref, set] = positionals as [string, string];
  const lockFile = resolve(values.lock ?? join(REPO_ROOT, "specs", "openproposal", "spec-input", "with-our-stack.lock.yaml"));
  const specDir = cliSpec({ lock: lockFile });
  const lock = loadLock(lockFile);
  const r = await deskAdd({
    source: readSource(ref),
    set,
    specDir,
    lock,
    root: REPO_ROOT,
    date: new Date().toISOString().slice(0, 10),
    work: join(REPO_ROOT, "build", "desk-add", set),
    ...(values.document !== undefined ? { document: values.document } : {}),
  });
  const out = join(REPO_ROOT, "build", `desk-add-${set}.md`);
  mkdirSync(join(REPO_ROOT, "build"), { recursive: true });
  writeFileSync(out, r.report);
  console.log(r.report);
  console.log(`Report: ${relative(REPO_ROOT, out)}. Draft: ${relative(REPO_ROOT, r.dir)}/expected.yaml and README.md.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  },
);
