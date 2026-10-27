import { createHash } from "node:crypto";

/**
 * Serializes a value as canonical JSON: object keys sorted by code point,
 * two-space indentation, and a trailing newline. Array order is kept, so
 * callers own the order of every array they emit.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Returns the git tree SHA-1 of a directory that holds only regular files,
 * given each file's name and blob SHA, as `git rev-parse <commit>:<dir>`
 * reports it.
 */
export function gitTreeSha(files: { name: string; blob: string }[]): string {
  const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const body = Buffer.concat(sorted.map((f) => Buffer.concat([Buffer.from(`100644 ${f.name}\0`), Buffer.from(f.blob, "hex")])));
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`tree ${body.length}\0`), body]))
    .digest("hex");
}

/** Returns the git blob SHA-1 of the bytes, as `git hash-object` computes it. */
export function gitBlobSha(bytes: Buffer): string {
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");
}
