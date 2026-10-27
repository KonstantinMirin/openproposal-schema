import { ExtractError } from "../errors.ts";

export interface PathSegment {
  name: string;
  array: boolean;
}

export interface FieldPath {
  path: string;
  segments: PathSegment[];
}

const SEGMENT = /^([A-Za-z_][A-Za-z0-9_]*)(\[\])?$/;

/** Parses a field or key path such as `pricing[].cost_method`. */
export function parsePath(raw: string, line?: number): FieldPath {
  const parts = raw.split(".");
  const segments = parts.map((part) => {
    const m = SEGMENT.exec(part);
    if (!m) throw new ExtractError(`not a field path: "${raw}"`, line);
    return { name: m[1]!, array: m[2] !== undefined };
  });
  return { path: raw, segments };
}

/** Drops every `[]` so `pricing[].cost_method` and `pricing.cost_method` compare equal. */
export function stripArrays(path: string): string {
  return path.replaceAll("[]", "");
}

/** Matches a code span that reads as an identifier or a dotted path. Hyphens are allowed, as in marker names. */
export const IDENTIFIER_PATH = /^[A-Za-z_][A-Za-z0-9_-]*(\[\])?(\.[A-Za-z_][A-Za-z0-9_-]*(\[\])?)*$/;
