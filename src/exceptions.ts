import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Finding } from "./lint.ts";

/**
 * The fixed verdicts an exception may record:
 * - `accepted`: the finding is correct, and the specification is fine as written.
 * - `false_positive`: the lint misreads the specification here.
 * - `mapping`: stage 3 resolves it with a reviewed mapping entry.
 * - `feedback`: it goes to the working group as implementation feedback.
 */
export const VERDICTS = ["accepted", "false_positive", "mapping", "feedback"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ExceptionEntry {
  finding: string;
  verdict: Verdict;
  reason: string;
  /** Lock names the entry applies to; null means every lock. */
  locks: string[] | null;
}

const MIN_REASON = 12;

export function loadExceptions(file: string): ExceptionEntry[] {
  const doc = parse(readFileSync(file, "utf8"), { version: "1.2", schema: "core", uniqueKeys: true }) as unknown;
  const fail = (why: string): never => {
    throw new Error(`${file}: ${why}`);
  };
  if (doc === null || typeof doc !== "object" || !Array.isArray((doc as { exceptions?: unknown }).exceptions)) {
    fail(`expected a top-level "exceptions" list`);
  }
  const entries = (doc as { exceptions: unknown[] }).exceptions;
  const out: ExceptionEntry[] = [];
  entries.forEach((raw, i) => {
    const where = `exception ${i + 1}`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(`${where} is not a mapping`);
    const e = raw as Record<string, unknown>;
    for (const k of Object.keys(e)) if (!["finding", "verdict", "reason", "locks"].includes(k)) fail(`${where} has unknown key "${k}"`);
    if (typeof e.finding !== "string" || e.finding === "") fail(`${where} needs a "finding" id`);
    if (!(VERDICTS as readonly unknown[]).includes(e.verdict)) fail(`${where} (${e.finding}) has verdict "${String(e.verdict)}"; use one of ${VERDICTS.join(", ")}`);
    if (typeof e.reason !== "string" || e.reason.trim().length < MIN_REASON) fail(`${where} (${e.finding}) needs a reason of at least ${MIN_REASON} characters`);
    let locks: string[] | null = null;
    if (e.locks !== undefined) {
      if (!Array.isArray(e.locks) || e.locks.length === 0 || !e.locks.every((l) => typeof l === "string")) fail(`${where} (${e.finding}) "locks" must be a non-empty list of lock names`);
      locks = e.locks as string[];
    }
    out.push({ finding: e.finding as string, verdict: e.verdict as Verdict, reason: (e.reason as string).trim(), locks });
  });
  return out;
}

/**
 * Marks each finding an in-scope exception names, and returns the stale
 * entries: those in scope for this lock that name no current finding. A
 * stale entry fails the build. Two in-scope entries for one finding also fail.
 */
export function applyExceptions(findings: Finding[], entries: ExceptionEntry[], lock: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.locks !== null && !e.locks.includes(lock)) continue;
    if (seen.has(e.finding)) {
      problems.push(`duplicate exception for "${e.finding}"`);
      continue;
    }
    seen.add(e.finding);
    const f = findings.find((x) => x.id === e.finding);
    if (!f) {
      problems.push(`stale exception "${e.finding}": lock "${lock}" has no such finding`);
      continue;
    }
    f.disposition = { verdict: e.verdict, reason: e.reason };
  }
  return problems;
}
