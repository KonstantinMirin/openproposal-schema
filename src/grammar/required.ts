import { ExtractError } from "../errors.ts";

export const PRESENCE_LEVELS = ["REQUIRED", "RECOMMENDED", "OPTIONAL"] as const;
export type PresenceLevel = (typeof PRESENCE_LEVELS)[number];

export interface PresenceClause {
  level: PresenceLevel;
  /**
   * `when` and `for` introduce a condition; `with` introduces the members
   * whose presence brings the requirement; `otherwise` qualifies a fallback
   * clause.
   */
  qualifier: "when" | "for" | "with" | "otherwise" | null;
  condition: string | null;
  /**
   * For `with`: the paths of the members, each a code span the condition
   * names, or, for "either", each code span of the sentence before, which
   * the extractor resolves (`resolveWith`).
   */
  members?: string[];
}

export type Presence =
  | { kind: "clauses"; clauses: PresenceClause[] }
  | { kind: "marker"; marker: string };

/**
 * Parses a presence statement: a key table's Required cell, or the leading
 * REQUIRED / OPTIONAL sentence of a field description.
 *
 * Grammar:
 *   presence := clause (";" clause)* | marker
 *   clause   := LEVEL [("when" | "for" | "with") condition] | "otherwise" LEVEL
 *
 * A `with` condition is "either", which refers to the members the sentence
 * before names, or code spans joined by "or". Its members are set here for
 * code spans, and by `resolveWith` for "either".
 */
/** Code spans joined by "or": "`a`", "`a` or `b`", "`a`, `b` or `c`". */
const WITH_SPANS = /^`[a-z][a-z0-9_.\[\]]*`(?:(?:,| or|, or) `[a-z][a-z0-9_.\[\]]*`)*$/;

/**
 * Resolves a `with either` clause against the code spans of the sentence
 * before it: "The clock for `daypart` and `frequency_cap.period`. REQUIRED
 * with either" requires the member with either of the two. "Either" refers
 * to exactly two, so any other count is an error.
 */
export function resolveWith(p: Presence, before: string[] | null, raw: string, line?: number): Presence {
  if (p.kind !== "clauses" || !p.clauses.some((c) => c.qualifier === "with" && c.members === undefined)) return p;
  if (before === null || before.length !== 2) {
    throw new ExtractError(`unparsed presence "${raw}": "with either" needs a sentence before it that names exactly two members, not ${before === null ? "none" : before.length}`, line);
  }
  return { kind: "clauses", clauses: p.clauses.map((c) => (c.qualifier === "with" && c.members === undefined ? { ...c, members: [...before] } : c)) };
}

export function parsePresence(raw: string, markers: readonly string[], line?: number): Presence {
  const text = raw.trim().replace(/\.$/, "");
  if (markers.includes(text)) return { kind: "marker", marker: text };
  const clauses = text.split(";").map((part) => {
    const p = part.trim();
    const otherwise = /^otherwise\s+(REQUIRED|RECOMMENDED|OPTIONAL)$/.exec(p);
    if (otherwise) return { level: otherwise[1] as PresenceLevel, qualifier: "otherwise" as const, condition: null };
    const m = /^(REQUIRED|RECOMMENDED|OPTIONAL)(?:\s+(when|for|with)\s+(.+))?$/s.exec(p);
    if (!m) throw new ExtractError(`unparsed presence "${raw}"`, line);
    const clause: PresenceClause = {
      level: m[1] as PresenceLevel,
      qualifier: (m[2] as "when" | "for" | "with" | undefined) ?? null,
      condition: m[3] ?? null,
    };
    if (clause.qualifier === "with" && clause.condition !== "either") {
      const spans = WITH_SPANS.exec(clause.condition!);
      if (!spans) throw new ExtractError(`unparsed presence "${raw}": "with" names neither "either" nor code spans joined by "or"`, line);
      clause.members = [...clause.condition!.matchAll(/`([^`]+)`/g)].map((x) => x[1]!);
    }
    return clause;
  });
  return { kind: "clauses", clauses };
}
