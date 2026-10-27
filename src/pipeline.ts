import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { canonicalJson } from "./canonical.ts";
import { applyExceptions, loadExceptions, type ExceptionEntry } from "./exceptions.ts";
import { extract } from "./extract.ts";
import { inputRecord } from "./input.ts";
import type { SpecIR } from "./ir-types.ts";
import { FINDING_KINDS, lint, type Finding } from "./lint.ts";
import { repoRoot, type SpecLock } from "./lock.ts";

export interface FindingsDoc {
  ir_version: 1;
  input: { name: string; commit: string; blob: string };
  counts: { total: number; open: number; by_kind: Record<string, number>; by_verdict: Record<string, number> };
  findings: Finding[];
}

export interface StageOutput {
  ir: SpecIR;
  findings: FindingsDoc;
  /** Canonical JSON, byte for byte as written to disk. */
  irJson: string;
  findingsJson: string;
  /** Stale or duplicate exception entries. Any entry fails the build. */
  exceptionProblems: string[];
}

/** Runs stage 1 (extract) and stage 2 (lint) over the locked bytes, then applies the exception registry, `ir/exceptions.yaml` unless one is given. */
export function runStages(lock: SpecLock, bytes: Buffer, exceptions: ExceptionEntry[] = loadExceptions(join(repoRoot(lock), "ir", "exceptions.yaml"))): StageOutput {
  const ir = extract(bytes.toString("utf8"), inputRecord(lock, bytes));
  const findings = lint(ir);
  const exceptionProblems = applyExceptions(findings, exceptions, lock.name);
  const doc = findingsDoc(lock, findings);
  return { ir, findings: doc, irJson: canonicalJson(ir), findingsJson: canonicalJson(doc), exceptionProblems };
}

export function findingsDoc(lock: SpecLock, findings: Finding[]): FindingsDoc {
  const byKind: Record<string, number> = {};
  for (const k of FINDING_KINDS) {
    const n = findings.filter((f) => f.kind === k).length;
    if (n > 0) byKind[k] = n;
  }
  const byVerdict: Record<string, number> = {};
  for (const f of findings) {
    const v = f.disposition?.verdict ?? "open";
    byVerdict[v] = (byVerdict[v] ?? 0) + 1;
  }
  return {
    ir_version: 1,
    input: { name: lock.name, commit: lock.commit, blob: lock.blob },
    counts: { total: findings.length, open: byVerdict.open ?? 0, by_kind: byKind, by_verdict: byVerdict },
    findings,
  };
}

/** Validates a document against one of the committed schemas in `ir/`. Returns error strings; empty means valid. */
export function validateAgainst(root: string, schemaFile: string, doc: unknown): string[] {
  return compileSchema(join(root, "ir", schemaFile))(doc);
}

/**
 * Compiles a JSON Schema 2020-12 file in Ajv's strict mode. `refs` are the
 * files of the other schemas it references by `$id`. The validator returns
 * error strings; empty means valid.
 */
export function compileSchema(schemaPath: string, refs: string[] = []): (doc: unknown) => string[] {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const r of refs) ajv.addSchema(JSON.parse(readFileSync(r, "utf8")));
  const validate = ajv.compile(schema);
  return (doc) => {
    if (validate(doc)) return [];
    return (validate.errors ?? []).slice(0, 20).map((e) => `${e.instancePath || "/"} ${e.message ?? ""} ${JSON.stringify(e.params)}`);
  };
}
