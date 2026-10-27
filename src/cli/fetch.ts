import { parseArgs } from "node:util";
import { materialize, writeSnapshot } from "../fetch.ts";
import { loadLock } from "../lock.ts";

/**
 * Usage: fetch [--lock spec-input/spec-lock.yaml] [--snapshot]. Writes the
 * locked specification to build/spec/<name>/ and verifies its blob SHA.
 * `--snapshot` instead writes the lock's snapshot directory from its clone:
 * the specification and every file under examples/ at the commit, verified
 * against the lock, so CI can run every gate on the lock without the clone.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { lock: { type: "string", default: "spec-input/spec-lock.yaml" }, snapshot: { type: "boolean" } } });
  const lock = loadLock(values.lock!);
  if (values.snapshot) {
    const s = writeSnapshot(lock);
    console.log(`${lock.name}: wrote ${s.files} files, verified against the lock, via ${s.via} -> ${s.dir}`);
    return;
  }
  const m = await materialize(lock);
  console.log(`${lock.name}: blob ${lock.blob} verified (${m.bytes.length} bytes, via ${m.via}) -> ${m.file}`);
}

main().catch((e: Error) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
