import { collapse, type Token } from "./markdown.ts";

export interface Sentence {
  /** Normalized text, with code spans in backticks. */
  text: string;
  /** Text with code spans removed, for keyword search. */
  prose: string;
  /** Code span values, in order. */
  codes: string[];
  line: number;
}

interface Char {
  ch: string;
  line: number;
  code: boolean;
  /** Index of the code token this character belongs to, or -1. */
  codeIndex: number;
}

const CLOSERS = new Set([")", '"', "'", "”", "’"]);
const STARTERS = /[A-Z`"“(\[§*]/;

/**
 * Splits a block's tokens into sentences. A sentence ends at `.`, `!` or `?`
 * outside a code span, followed by whitespace and a capital letter, a code
 * span, or an opening bracket or quote. The block's end also ends a sentence.
 * A period that ends one of `abbreviations`, as "i.e.", ends none, for a text
 * whose plugin lists the abbreviations it writes mid-sentence.
 */
export function splitSentences(tokens: readonly Token[], abbreviations: readonly string[] = []): Sentence[] {
  const chars: Char[] = [];
  tokens.forEach((t, index) => {
    if (t.kind === "code") {
      const s = "`" + t.value + "`";
      for (const ch of s) chars.push({ ch, line: t.line, code: true, codeIndex: index });
    } else {
      let line = t.line;
      for (const ch of t.value) {
        chars.push({ ch, line, code: false, codeIndex: -1 });
        if (ch === "\n") line++;
      }
    }
  });

  const out: Sentence[] = [];
  let start = 0;
  const emit = (end: number) => {
    const slice = chars.slice(start, end);
    start = end;
    const text = collapse(slice.map((c) => c.ch).join(""));
    if (!text) return;
    const codes: string[] = [];
    let last = -1;
    for (const c of slice) {
      if (c.code && c.codeIndex !== last) {
        codes.push(tokens[c.codeIndex]!.value);
        last = c.codeIndex;
      }
      if (!c.code) last = -1;
    }
    const prose = collapse(slice.filter((c) => !c.code).map((c) => c.ch).join(""));
    const first = slice.find((c) => !/\s/.test(c.ch));
    out.push({ text, prose, codes, line: first?.line ?? slice[0]!.line });
  };

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c.code || !".!?".includes(c.ch)) continue;
    // A period that ends an abbreviation the text writes mid-sentence, as "(i.e. OpenRTB …)", ends no sentence.
    if (c.ch === "." && abbreviations.some((a) => i + 1 >= a.length && chars.slice(i + 1 - a.length, i + 1).every((x, n) => !x.code && x.ch === a[n]) && (i + 1 === a.length || !/[A-Za-z]/.test(chars[i - a.length]!.ch)))) continue;
    let j = i + 1;
    while (j < chars.length && !chars[j]!.code && CLOSERS.has(chars[j]!.ch)) j++;
    if (j >= chars.length) continue;
    if (!/\s/.test(chars[j]!.ch)) continue;
    let k = j;
    while (k < chars.length && /\s/.test(chars[k]!.ch)) k++;
    if (k >= chars.length || STARTERS.test(chars[k]!.ch)) emit(j);
  }
  emit(chars.length);
  return out;
}

export const RFC2119 = [
  "MUST NOT",
  "SHALL NOT",
  "SHOULD NOT",
  "NOT RECOMMENDED",
  "MUST",
  "SHALL",
  "SHOULD",
  "REQUIRED",
  "RECOMMENDED",
  "MAY",
  "OPTIONAL",
] as const;
export type Rfc2119Keyword = (typeof RFC2119)[number];

/** Returns every RFC 2119 keyword in the prose, in order of first appearance; a negated form isn't also counted as its positive form. */
export function findKeywords(prose: string): Rfc2119Keyword[] {
  const found: { kw: Rfc2119Keyword; at: number }[] = [];
  const taken: [number, number][] = [];
  for (const kw of RFC2119) {
    const re = new RegExp(`(?<![A-Za-z])${kw.replace(" ", "\\s+")}(?![A-Za-z])`, "g");
    for (const m of prose.matchAll(re)) {
      const s = m.index!;
      const e = s + m[0].length;
      if (taken.some(([a, b]) => s < b && e > a)) continue;
      taken.push([s, e]);
      found.push({ kw, at: s });
    }
  }
  found.sort((a, b) => a.at - b.at);
  const seen = new Set<Rfc2119Keyword>();
  const out: Rfc2119Keyword[] = [];
  for (const f of found) if (!seen.has(f.kw)) (seen.add(f.kw), out.push(f.kw));
  return out;
}

/** Strength order, strongest first; used to pick a statement's level. */
export const LEVEL_ORDER: readonly Rfc2119Keyword[] = [
  "MUST NOT",
  "SHALL NOT",
  "MUST",
  "SHALL",
  "REQUIRED",
  "SHOULD NOT",
  "NOT RECOMMENDED",
  "SHOULD",
  "RECOMMENDED",
  "MAY",
  "OPTIONAL",
];
