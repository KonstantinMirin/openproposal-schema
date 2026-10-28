/**
 * How the Deals API's prose reads: the object a section describes, the
 * value lists its Description cells write, and its keywords.
 */
import { clauseAfter } from "../../extract.ts";
import type { Section } from "../../ir-types.ts";
import { collapse, type Token } from "../../markdown.ts";
import { findKeywords, type Rfc2119Keyword } from "../../sentences.ts";
import type { ValueListRead } from "../plugin.ts";

/** The object an `Object:` section describes, by the name its heading gives, as `BuyerSeat`; null for any other section. */
export const objectOf = (s: Section): string | null => (s.part === "body" ? (/^Object:\s*([A-Z][A-Za-z0-9]*)$/.exec(s.title)?.[1] ?? null) : null);

/** An integer code, as `0` or `500`. */
const CODE = /^-?(?:0|[1-9][0-9]*)$/;
/** A line break, which a `<br>` writes. */
const isBreak = (t: Token | undefined) => t?.kind === "text" && t.value === "\n";
/** Text that is only spaces, as the cells write after a break. */
const isBlank = (t: Token | undefined) => t?.kind === "text" && /^[ \t]*$/.test(t.value);

/**
 * The code at `tokens[i]` that starts a `` `n` = label `` line, and the
 * index of its line's last token; null where `tokens[i]` starts none. A
 * line starts the cell or follows a break, with only spaces between; its
 * label runs to the next break, code spans included.
 */
function codeLine(tokens: readonly Token[], i: number, taken: ReadonlySet<number>): { value: string; label: string; end: number } | null {
  const t = tokens[i];
  const eq = tokens[i + 1];
  if (!t || t.kind !== "code" || !CODE.test(t.value) || taken.has(i) || eq?.kind !== "text" || !/^\s*=\s*\S/.test(eq.value)) return null;
  // A line starts the cell, follows a break, or follows a lead ending in a colon on the same line, as "Kinds: `0` = none".
  let k = i - 1;
  while (k >= 0 && isBlank(tokens[k])) k--;
  if (k >= 0 && !isBreak(tokens[k]) && !(tokens[k]!.kind === "text" && /:\s*$/.test(tokens[k]!.value))) return null;
  let end = i + 1;
  while (end + 1 < tokens.length && !isBreak(tokens[end + 1])) end++;
  const label = collapse(tokens.slice(i + 1, end + 1).map((x) => (x.kind === "code" ? `\`${x.value}\`` : x.value)).join("").replace(/^\s*=\s*/, ""));
  return { value: t.value, label, end };
}

/** The text after a list, from the token after its last, its breaks read as spaces. */
const textAfter = (tokens: readonly Token[], from: number): string | null => {
  const rest = collapse(tokens.slice(from).map((x) => (x.kind === "code" ? `\`${x.value}\`` : x.value.replace(/\n/g, " "))).join(""));
  return rest === "" ? null : clauseAfter(rest);
};

/** The prose form "where 0 = not a guaranteed deal, 1 = guaranteed deal.": two or more codes after "where", each `n = label`, joined by commas, to the end of the sentence, so a label may hold an abbreviation's period. */
const PROSE = /\bwhere\s+((?:-?\d+\s*=\s*[^,=]+?)(?:,\s*-?\d+\s*=\s*[^,=]+?)+)\s*(?:\.\s*$|\.\s+(?=[A-Z])|$)/;

/**
 * Reads the value list that starts at `tokens[i]`: a run of two or more `` `n` =
 * label `` lines, each the code and its label, as the Description cells
 * write a code's meanings; or a text with "where n = label, n = label".
 * The codes' spans are taken, so no other reading takes them; a code span
 * inside a label, as `request.at`, stays a code span.
 */
export function readValueList(tokens: readonly Token[], i: number, taken: ReadonlySet<number>): ValueListRead | null {
  const t = tokens[i];
  if (t?.kind === "text") {
    const m = PROSE.exec(t.value);
    if (!m) return null;
    const items = m[1]!.split(/,\s*/).map((p) => {
      const [, value, label] = /^(-?\d+)\s*=\s*(.+)$/.exec(p.trim())!;
      return { value: value!, annotation: collapse(label!) };
    });
    return { items, end: i, taken: [], subject: null, context_after: clauseAfter(t.value.slice(m.index + m[0].length)) };
  }
  const first = codeLine(tokens, i, taken);
  if (first === null) return null;
  const lines = [first];
  const at = [i];
  for (;;) {
    let k = lines[lines.length - 1]!.end + 1;
    if (!isBreak(tokens[k])) break;
    k++;
    while (isBlank(tokens[k])) k++;
    const next = codeLine(tokens, k, taken);
    if (next === null) break;
    lines.push(next);
    at.push(k);
  }
  if (lines.length < 2) return null;
  const end = lines[lines.length - 1]!.end;
  return { items: lines.map((l) => ({ value: l.value, annotation: l.label })), end, taken: at, subject: null, context_after: textAfter(tokens, end + 1) };
}

/**
 * The RFC 2119 keywords a sentence writes, in any case, since the text
 * writes them in lowercase; and "strongly encouraged", which it writes as
 * "strongly recommended" elsewhere, is RECOMMENDED.
 */
export function keywords(prose: string): Rfc2119Keyword[] {
  const found = findKeywords(prose.toUpperCase());
  return /\bstrongly\s+encouraged\b/i.test(prose) && !found.includes("RECOMMENDED") ? [...found, "RECOMMENDED"] : found;
}
