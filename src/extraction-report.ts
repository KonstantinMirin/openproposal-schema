/**
 * The numbers of the extraction report, docs/extraction-report.md, rendered
 * from each lock's committed IR and findings, so none goes stale. The report
 * marks each generated block `<!-- generated:<name> -->` …
 * `<!-- /generated:<name> -->`; `npm run extraction-report` rewrites the
 * blocks, and a test fails when the committed report differs from them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SpecIR } from "./ir-types.ts";
import { FINDING_KINDS, type Finding } from "./lint.ts";
import { loadLock } from "./lock.ts";

export const EXTRACTION_REPORT = join("docs", "extraction-report.md");

/** The header signature each table layout matches, as the report writes it. */
const LAYOUT_HEADERS: [string, string][] = [
  ["field", "Field \\| Type \\| Mutability \\| Description"],
  ["key-required-meaning", "Key \\| Required \\| Meaning"],
  ["key-required-meaning-mapping", "… \\| AdCOM 1.0, OpenRTB 2.6"],
  ["key-meaning", "Key \\| Meaning"],
  ["value-condition", "`` `channel` `` \\| Condition"],
  ["value-distribution-device", "Value \\| Distribution channel \\| Device types"],
  ["marker-meaning", "Marker \\| Meaning"],
  ["concept-standard", "OpenProposal concept \\| Downstream standard"],
  ["appendix-a", "Field \\| Section \\| Type \\| Marker"],
  ["appendix-b", "Marker \\| Count \\| Meaning \\| Fields"],
];

const LEVELS = ["MUST", "MUST NOT", "SHOULD NOT", "REQUIRED", "MAY", "OPTIONAL"];

/** What the report reads of one lock: the IR's counts and the findings with their verdicts. */
export interface ReportLock {
  name: string;
  counts: SpecIR["counts"];
  findings: Finding[];
}

/** The two locks the report compares, `main` and `with-open-prs`, from their committed IR. */
export function reportLocks(root: string): [ReportLock, ReportLock] {
  const read = (file: string): ReportLock => {
    const lock = loadLock(join(root, "spec-input", file));
    const ir = JSON.parse(readFileSync(join(root, lock.ir_dir, "spec-ir.json"), "utf8")) as SpecIR;
    const findings = (JSON.parse(readFileSync(join(root, lock.ir_dir, "findings.json"), "utf8")) as { findings: Finding[] }).findings;
    return { name: lock.name, counts: ir.counts, findings };
  };
  return [read("spec-lock.yaml"), read("with-open-prs.lock.yaml")];
}

const num = (c: Record<string, unknown>, key: string): number => {
  const v = c[key];
  if (typeof v !== "number") throw new Error(`the IR's counts have no number "${key}"`);
  return v;
};
const by = (c: Record<string, unknown>, key: string, sub: string): number => {
  const v = c[key];
  if (v === null || typeof v !== "object") throw new Error(`the IR's counts have no "${key}"`);
  const x = (v as Record<string, unknown>)[sub];
  return typeof x === "number" ? x : 0;
};
const series = (xs: string[]) => (xs.length <= 1 ? xs.join("") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(", ")}, and ${xs.at(-1)}`);
const code = (s: string) => (s.includes("`") ? `\`\` ${s} \`\`` : `\`${s}\``);

/** The blocks the report generates, by name. */
export function reportBlocks([main, prs]: [ReportLock, ReportLock]): Record<string, string> {
  const m = main.counts as unknown as Record<string, unknown>;
  const p = prs.counts as unknown as Record<string, unknown>;
  const layouts = new Set([...Object.keys(m.tables_by_layout as object), ...Object.keys(p.tables_by_layout as object)]);
  for (const l of layouts) if (!LAYOUT_HEADERS.some(([x]) => x === l)) throw new Error(`the report has no header for the layout "${l}"`);
  const pair = (c: Record<string, unknown>, l: string) => `${by(c, "tables_by_layout", l)} / ${by(c, "table_rows_by_layout", l)}`;
  const tables = [
    "### Tables by layout",
    "",
    "| Layout | Header | `main` tables / rows | `with-open-prs` tables / rows |",
    "| :--- | :--- | ---: | ---: |",
    ...LAYOUT_HEADERS.map(([l, h]) => `| \`${l}\` | ${h} | ${pair(m, l)} | ${pair(p, l)} |`),
    `| **Total** | | **${num(m, "tables")} / ${num(m, "table_rows")}** | **${num(p, "tables")} / ${num(p, "table_rows")}** |`,
  ];
  const el = (label: string, f: (c: Record<string, unknown>) => string) => `| ${label} | ${f(m)} | ${f(p)} |`;
  const elements = [
    "### Elements",
    "",
    "| Element | `main` | `with-open-prs` |",
    "| :--- | ---: | ---: |",
    el("Field rows (names; `valid_from` · `valid_until` is one row)", (c) => `${num(c, "fields")} (${num(c, "field_names")})`),
    el("Key rows", (c) => `${num(c, "keys")}`),
    el("Value definitions (`channel`, `environments` tables)", (c) => `${num(c, "definitions")}`),
    el("Value lists: in table cells / in inline objects / in prose", (c) => ["table_cell", "inline_object", "prose"].map((o) => by(c, "value_lists_by_origin", o)).join(" / ")),
    el("Inline objects: in table cells / in prose", (c) => ["table_cell", "prose"].map((o) => by(c, "inline_objects_by_origin", o)).join(" / ")),
    el("RFC 2119 sentences in the body", (c) => `${num(c, "statements_body")}`),
    el("Other prose sentences that name an identifier (code span)", (c) => `${num(c, "sentences")}`),
    el("Code spans", (c) => `${num(c, "code_spans")}`),
    el("`·` identifier lists (Summary Representation)", (c) => `${num(c, "identifier_lists")}`),
    el("Fenced code blocks", (c) => `${num(c, "code_blocks")}`),
  ];
  const levels = [
    "RFC 2119 sentences by strongest keyword. The front-matter status sentence is excluded, and so is the conventions sentence that lists the keywords. A Required cell is a structured attribute, not a sentence.",
    "",
    "| Level | `main` | `with-open-prs` |",
    "| :--- | ---: | ---: |",
    ...LEVELS.map((l) => `| ${l} | ${by(m, "statements_by_level", l)} | ${by(p, "statements_by_level", l)} |`),
  ];
  const verdictOf = (f: Finding) => f.disposition?.verdict ?? "open";
  const cell = (fs: Finding[], kinds: (k: string) => boolean) => {
    const xs = fs.filter((f) => kinds(f.kind));
    const open = xs.filter((f) => verdictOf(f) === "open").length;
    const decided = xs.length - open;
    return decided > 0 ? `${open} (+${decided})` : `${open}`;
  };
  const appendix = (k: string) => k.startsWith("appendix_");
  const findings = [
    "### Findings by kind",
    "",
    "Each cell shows open findings, plus findings with a verdict in brackets.",
    "",
    "| Kind | `main` | `with-open-prs` |",
    "| :--- | ---: | ---: |",
    `| Appendix A and B (rows, section, type, marker, counts, distribution) | ${cell(main.findings, appendix)} | ${cell(prs.findings, appendix)} |`,
    ...FINDING_KINDS.filter((k) => !appendix(k)).map((k) => `| \`${k}\` | ${cell(main.findings, (x) => x === k)} | ${cell(prs.findings, (x) => x === k)} |`),
    `| **Total** | **${cell(main.findings, () => true)}** | **${cell(prs.findings, () => true)}** |`,
  ];
  const verdicts = (fs: Finding[], v: string) => fs.filter((f) => verdictOf(f) === v).length;
  const counts = [
    ...tables,
    "",
    "Every row of every table produced a typed record. No layout was unknown.",
    "",
    ...elements,
    "",
    ...levels,
    "",
    ...findings,
    "",
    "The appendices agree with the body on both locks. That's expected: `tools/regen_appendices.py` reproduces `main` byte for byte, and the integration build regenerated the appendices after every merge.",
    "",
    `On \`with-open-prs\`, the verdicts are ${verdicts(prs.findings, "accepted")} \`accepted\` and ${verdicts(prs.findings, "false_positive")} \`false_positive\`; \`main\` has ${verdicts(main.findings, "accepted")} and ${verdicts(main.findings, "false_positive")}.`,
  ].join("\n");

  const layoutsOf = (c: Record<string, unknown>) => Object.values(c.tables_by_layout as Record<string, number>).filter((n) => n > 0).length;
  const lists = (c: Record<string, unknown>) => ["table_cell", "inline_object", "prose"].reduce((n, o) => n + by(c, "value_lists_by_origin", o), 0);
  const objects = (c: Record<string, unknown>) => ["table_cell", "prose"].reduce((n, o) => n + by(c, "inline_objects_by_origin", o), 0);
  const added = `The open PRs add ${num(p, "fields") - num(m, "fields")} fields, ${num(p, "keys") - num(m, "keys")} keys, ${layoutsOf(p) - layoutsOf(m)} table layouts, ${lists(p) - lists(m)} value lists, ${objects(p) - objects(m)} inline objects, and ${num(p, "statements_body") - num(m, "statements_body")} RFC 2119 sentences.`;

  const before = new Set(main.findings.map((f) => f.id));
  const after = new Set(prs.findings.map((f) => f.id));
  const fresh = prs.findings.filter((f) => !before.has(f.id));
  const gone = main.findings.filter((f) => !after.has(f.id));
  const freshOpen = fresh.filter((f) => verdictOf(f) === "open");
  const kinds = FINDING_KINDS.filter((k) => freshOpen.some((f) => f.kind === k)).map((k) => {
    const xs = freshOpen.filter((f) => f.kind === k);
    // A MUST sentence's finding is named by its statement's ID, which says nothing to a reader, so only its count shows.
    const subjects = k === "must_without_field" ? "" : ` (${xs.map((f) => code(f.id.slice(k.length + 1))).join(", ")})`;
    return `${xs.length} \`${k}\`${subjects}`;
  });
  const difference = [
    `**Findings:** ${fresh.length} new findings, and ${gone.length} removed${gone.length ? `: ${series(gone.map((f) => code(f.id)))}` : ""}. ${fresh.length - freshOpen.length} of the new findings have a verdict${fresh.length > freshOpen.length ? `: ${series([...new Set(fresh.map(verdictOf))].filter((v) => v !== "open").sort().map((v) => `${verdicts(fresh, v)} \`${v}\``))}` : ""}. The ${freshOpen.length} open additions, by kind: ${series(kinds)}.`,
  ].join("\n");

  return { counts, "lock-additions": added, "lock-findings": difference };
}

const BLOCK = /<!-- generated:([a-z-]+) -->\n([\s\S]*?)\n<!-- \/generated:\1 -->/g;

/** The report with each generated block rewritten; it throws on a block it can't render, and on a block the report lacks. */
export function renderExtractionReport(text: string, blocks: Record<string, string>): string {
  const seen = new Set<string>();
  const out = text.replace(BLOCK, (_, name: string) => {
    const body = blocks[name];
    if (body === undefined) throw new Error(`${EXTRACTION_REPORT}: no block "${name}" is generated`);
    seen.add(name);
    return `<!-- generated:${name} -->\n${body}\n<!-- /generated:${name} -->`;
  });
  for (const name of Object.keys(blocks)) if (!seen.has(name)) throw new Error(`${EXTRACTION_REPORT}: the report has no block "${name}"`);
  return out;
}
