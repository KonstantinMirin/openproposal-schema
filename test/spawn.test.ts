import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWithInput } from "../src/spawn.ts";

const echo = ["-e", "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',(d)=>s+=d);process.stdin.on('end',()=>process.stdout.write(String(s.length)+':'+s.slice(-3)))"];
const leftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith("openproposal-stdin-")).length;

/**
 * Runs `body` with the temporary directory set to a fresh one of its own, so
 * the other test files' children, which run in parallel and make and remove
 * their own input files, don't change the count.
 */
function isolated(body: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), "openproposal-spawn-test-"));
  const was = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    body();
  } finally {
    if (was === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = was;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("spawn: the child reads the whole input from its standard input and sees its end, and the temporary file is gone", () => isolated(() => {
  const before = leftovers();
  const input = `${"x".repeat(1 << 20)}end`;
  const r = spawnWithInput(process.execPath, echo, input, { encoding: "utf8", timeout: 30000 });
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${input.length}:end`);
  assert.equal(leftovers(), before);
  const empty = spawnWithInput(process.execPath, echo, "", { encoding: "utf8", timeout: 30000 });
  assert.equal(empty.stdout, "0:");
}));

test("spawn: a command that doesn't exist reports its error, and the temporary file is gone", () => isolated(() => {
  const before = leftovers();
  const r = spawnWithInput("openproposal-no-such-command", [], "{}", { encoding: "utf8" });
  assert.ok(r.error);
  assert.equal(leftovers(), before);
}));
