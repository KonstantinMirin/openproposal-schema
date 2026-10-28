/**
 * How OpenProposal's text is written beyond its tables: numbered headings
 * and lettered appendices, value lists written "`a` \| `b`", identifier
 * lists joined by `·`, and RFC 2119 keywords in capitals.
 */
import { clauseAfter } from "../../extract.ts";
import type { Section } from "../../ir-types.ts";
import { collapse, type Token } from "../../markdown.ts";
import { findKeywords, type Rfc2119Keyword } from "../../sentences.ts";
import type { IdentifierListRead, SectionHead, ValueListRead } from "../plugin.ts";

/**
 * A heading: the only H1 is the document's title; a numbered heading, as
 * "4.1 Identity", or a lettered appendix, as "Appendix A — Field index", has
 * its number. The body starts at the first numbered H2, and an appendix is
 * in the appendix part.
 */
export function sectionOf(heading: { text: string; depth: number }, current: Section): SectionHead {
  const { text, depth } = heading;
  if (depth === 1) return { kind: "title" };
  let number: string | null = null;
  let title = text;
  let m: RegExpExecArray | null;
  if ((m = /^(\d+(?:\.\d+)*)\.?\s+(.+)$/.exec(text))) {
    number = m[1]!;
    title = m[2]!;
  } else if ((m = /^Appendix ([A-Z])\b\s*[—–-]?\s*(.*)$/.exec(text))) {
    number = m[1]!;
    title = m[2]!;
  }
  let part = current.part;
  if (number !== null && /^[A-Z]$/.test(number)) part = "appendix";
  else if (number !== null && part === "front" && depth === 2) part = "body";
  return { kind: "section", number, title, part };
}

/** A run of code spans separated by `|`, as in "`a` \| `b` (default) \| `c`". */
export function readValueList(tokens: readonly Token[], i: number, taken: ReadonlySet<number>): ValueListRead | null {
  const t = tokens[i];
  if (!t || t.kind !== "code" || taken.has(i)) return null;
  const items = [{ value: t.value, annotation: null as string | null }];
  let j = i;
  for (;;) {
    const sep = tokens[j + 1];
    const next = tokens[j + 2];
    if (!sep || sep.kind !== "text" || !next || next.kind !== "code" || taken.has(j + 2)) break;
    const m = /^\s*(?:\(([^()]*)\))?\s*\|\s*$/.exec(sep.value);
    if (!m) break;
    if (m[1] !== undefined) items[items.length - 1]!.annotation = collapse(m[1]);
    items.push({ value: next.value, annotation: null });
    j += 2;
  }
  if (items.length < 2) return null;
  let contextAfter: string | null = null;
  const after = tokens[j + 1];
  if (after?.kind === "text") {
    let rest = after.value;
    const m = /^\s*\(([^()]*)\)/.exec(rest);
    if (m) {
      items[items.length - 1]!.annotation = collapse(m[1]!);
      rest = rest.slice(m[0].length);
    }
    contextAfter = clauseAfter(rest);
  }
  const before = tokens[i - 1];
  const subjectToken = tokens[i - 2];
  const subject = before?.kind === "text" && /^\s*from\s*$/.test(before.value) && subjectToken?.kind === "code" ? { identifier: subjectToken.value, relation: "from" as const } : null;
  const indexes: number[] = [];
  for (let k = i; k <= j; k += 2) indexes.push(k);
  return { items, end: j, taken: indexes, subject, context_after: contextAfter };
}

/** A run of three or more items joined by `·`, such as the Summary Representation key list. */
export function readIdentifierList(tokens: readonly Token[], i: number): IdentifierListRead | null {
  const t = tokens[i];
  if (!t || t.kind !== "code") return null;
  const items = [{ text: t.value, code: true }];
  let j = i;
  for (;;) {
    const sep = tokens[j + 1];
    const next = tokens[j + 2];
    if (!sep || sep.kind !== "text" || !next || next.kind !== "code") break;
    const embedded = /^\s*·\s*([^·`]+?)\s*·\s*$/.exec(sep.value);
    if (embedded) items.push({ text: collapse(embedded[1]!), code: false });
    else if (!/^\s*·\s*$/.test(sep.value)) break;
    items.push({ text: next.value, code: true });
    j += 2;
  }
  return items.length < 3 ? null : { items, end: j };
}

/** The RFC 2119 keywords in capitals, as OpenProposal's conventions say. */
export const keywords = (prose: string): Rfc2119Keyword[] => findKeywords(prose);

/** The conventions paragraph names the keywords; it states no requirement. */
export const statesConventions = (prose: string, found: readonly Rfc2119Keyword[]): boolean => /RFC 2119/.test(prose) && found.length >= 5;
