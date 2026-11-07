/**
 * Where each target's files sit in a spec's folder: the proto target's under
 * `proto/`, and an SDK target's later under a folder of its own. A target's
 * emitter never reads these; the CLI writes them, and the drift report and
 * the site read the committed files.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The proto target's folder in a spec's folder. */
export const PROTO_DIR = "proto";

/** A spec's committed proto files, by path under `PROTO_DIR`, sorted; none where the spec has no such folder. */
export function protoFiles(spec: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (rel: string) => {
    const abs = join(spec, PROTO_DIR, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) for (const f of readdirSync(abs).sort()) walk(rel === "" ? f : `${rel}/${f}`);
    else if (rel.endsWith(".proto")) out.set(rel, readFileSync(abs));
  };
  walk("");
  return out;
}
