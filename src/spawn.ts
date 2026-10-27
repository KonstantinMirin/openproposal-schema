/**
 * Runs a child process synchronously with its standard input read from a
 * temporary file, not from a pipe. On macOS, `spawnSync` with `input`
 * sometimes stalls: the child blocks reading a standard input that never
 * reaches end of file, and the parent waits on it forever. Under parallel
 * load it happened in 6 of 320 runs of `tools/oracle/schema_check.py`, and
 * in none of 320 with a file. A file always ends.
 */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function spawnWithInput(cmd: string, args: string[], input: string, options: Omit<SpawnSyncOptionsWithStringEncoding, "input" | "stdio">): SpawnSyncReturns<string> {
  const dir = mkdtempSync(join(tmpdir(), "openproposal-stdin-"));
  try {
    const file = join(dir, "stdin");
    writeFileSync(file, input);
    const fd = openSync(file, "r");
    try {
      return spawnSync(cmd, args, { ...options, stdio: [fd, "pipe", "pipe"] });
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
