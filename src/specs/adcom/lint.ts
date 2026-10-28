/**
 * AdCOM's own lint checks, beside the generic ones (src/lint.ts): every
 * `List:` section writes a table of codes, and every list's or object's
 * anchor is its prefix and its title in lowercase, as nearly all of them
 * are. An anchor that departs from the pattern is reported with how: no
 * prefix, a letter or two off its title, which reads as a misspelling, or a
 * shortened title; and a heading with no anchor at all.
 */
import type { SpecIR } from "../../ir-types.ts";
import type { Finding } from "../../lint.ts";

/** The anchor prefix each kind of section writes. */
const PREFIXES: [RegExp, string][] = [
  [/^List:\s*/, "list_"],
  [/^Object:\s*/, "object_"],
  [/^Abstract Class:\s*/, "abstract_"],
];

/** A title in the form its anchor writes it: letters and digits, in lowercase. */
const compact = (title: string) => title.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The number of single-letter edits from one string to another. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

type Add = Omit<Finding, "disposition">;

export function lintAdcom(ir: SpecIR): Add[] {
  const out: Add[] = [];
  for (const s of ir.sections) {
    const kind = PREFIXES.find(([re]) => re.test(s.title));
    if (!kind) continue;
    const [re, prefix] = kind;
    const title = s.title.replace(re, "").replace(/\s*\(deprecated\)\s*$/i, "");
    // A list or an object writes its own anchor, which every link to it names.
    if (s.id.includes("/")) {
      out.push({ id: `section_anchor_irregular:${s.id}`, kind: "section_anchor_irregular", message: `${s.title} writes no anchor of its own, so a link to it can only use the slug of its heading`, subjects: [s.id], locs: [{ section: s.id, line: s.line }], details: { anchor: null, expected: `${prefix}${compact(title)}`, reason: "missing" } });
    } else {
      const want = compact(title);
      const rest = s.id.startsWith(prefix) ? s.id.slice(prefix.length) : null;
      const reason = rest === null ? "prefix" : rest === want ? null : distance(rest, want) <= 2 ? "spelling" : "abbreviation";
      const says = { prefix: `with no "${prefix}" prefix`, spelling: "a letter or two off its title", abbreviation: "which shortens its title" };
      if (reason !== null) out.push({ id: `section_anchor_irregular:${s.id}`, kind: "section_anchor_irregular", message: `${s.title} writes the anchor "${s.id}", ${says[reason as keyof typeof says]}, where the pattern of the others gives "${prefix}${want}"`, subjects: [s.id], locs: [{ section: s.id, line: s.line }], details: { anchor: s.id, expected: `${prefix}${want}`, reason } });
    }
    if (prefix === "list_" && !ir.definitions.some((d) => d.loc.section === s.id)) {
      out.push({ id: `list_without_codes:${s.id}`, kind: "list_without_codes", message: `${s.title} lists no codes: the section holds no table`, subjects: [s.id], locs: [{ section: s.id, line: s.line }], details: { title } });
    }
  }
  return out;
}
