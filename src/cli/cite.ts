import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { citeText, elementDigest, indexElements, type Element } from "../elements.ts";
import type { SpecIR } from "../ir-types.ts";
import { loadLock, repoRoot, type SpecLock } from "../lock.ts";
import type { Cover } from "../mapping.ts";
import { DEFAULT_LOCK } from "../repo.ts";

/**
 * Usage: cite [--lock specs/openproposal/spec-input/spec-lock.yaml | --all-locks] <IR element ID>...
 *
 * Prints a `covers` list for a decision record: each element's ID, current
 * digest, and quote, read from the lock's committed IR. A mapping entry takes
 * the same `ir` and `digest`. With `--all-locks`, it reads every lock: an
 * element that is the same on every lock gets one cover, and any other gets
 * one cover per lock it is on, scoped with `locks`. Exits 1 on an ID that no
 * lock has.
 */
function main(): number {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { lock: { type: "string", default: DEFAULT_LOCK }, "all-locks": { type: "boolean", default: false } },
  });
  if (positionals.length === 0) {
    console.error("usage: npm run cite -- [--lock <lock file> | --all-locks] <IR element ID>...");
    return 1;
  }
  const first = loadLock(values.lock!);
  const locks = values["all-locks"]
    ? readdirSync(join(repoRoot(first), "spec-input"))
        .filter((f) => f === "spec-lock.yaml" || f.endsWith(".lock.yaml"))
        .sort()
        .map((f) => loadLock(join(repoRoot(first), "spec-input", f)))
    : [first];
  const indexed = locks.map((lock: SpecLock) => ({
    lock: lock.name,
    elements: indexElements(JSON.parse(readFileSync(join(repoRoot(lock), lock.ir_dir, "spec-ir.json"), "utf8")) as SpecIR),
  }));
  const covers: Cover[] = [];
  let unknown = 0;
  for (const id of positionals) {
    const found = indexed.flatMap(({ lock, elements }) => (elements.has(id) ? [{ lock, e: elements.get(id)! as Element }] : []));
    if (found.length === 0) {
      console.error(`error: ${locks.length === 1 ? `lock "${first.name}"` : "no lock"} has no IR element "${id}"`);
      unknown++;
      continue;
    }
    const cites = found.map(({ lock, e }) => ({ lock, ir: id, digest: elementDigest(e), quote: citeText(e) }));
    const same = cites.every((c) => c.digest === cites[0]!.digest && c.quote === cites[0]!.quote);
    if (locks.length === 1 || (same && cites.length === indexed.length)) covers.push({ ir: id, digest: cites[0]!.digest, quote: cites[0]!.quote });
    else for (const c of cites) covers.push({ ir: c.ir, digest: c.digest, quote: c.quote, locks: [c.lock] });
  }
  if (unknown > 0) return 1;
  process.stdout.write(stringify(covers, { lineWidth: 0 }));
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
