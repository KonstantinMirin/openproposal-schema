import { sha256 } from "./canonical.ts";
import type { InputRecord } from "./ir-types.ts";
import type { SpecLock } from "./lock.ts";

/** The input record the IR carries: the lock's provenance plus the bytes' digest. No machine-specific paths. */
export function inputRecord(lock: SpecLock, bytes: Buffer): InputRecord {
  return {
    name: lock.name,
    upstream: lock.upstream,
    commit: lock.commit,
    path: lock.path,
    blob: lock.blob,
    base: lock.base,
    merge_order: lock.merge_order,
    sha256: sha256(bytes),
    bytes: bytes.length,
  };
}
