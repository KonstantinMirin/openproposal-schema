import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./helpers.ts";

test("the fidelity command with --out writes one report per lock, so two locks never write one file", () => {
  const out = mkdtempSync(join(tmpdir(), "openproposal-fidelity-"));
  try {
    const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "src", "cli", "fidelity.ts"), "--out", out], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const main = join(out, "main", "fidelity.json");
    const prs = join(out, "with-open-prs", "fidelity.json");
    assert.ok(existsSync(main) && existsSync(prs));
    assert.ok(!existsSync(join(out, "fidelity.json")));
    const ids = (f: string) => (JSON.parse(readFileSync(f, "utf8")) as { constraints: { id: string }[] }).constraints.map((c) => c.id);
    assert.notDeepEqual(ids(main), ids(prs), "each report is its own lock's");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
