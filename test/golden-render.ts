import type { SpecIR } from "../src/ir-types.ts";
import type { FindingsDoc } from "../src/pipeline.ts";

/**
 * Renders the IR and findings as small, line-oriented golden files, so a
 * change in extraction shows up as a readable diff in review.
 */
export function renderGolden(ir: SpecIR, findings: FindingsDoc): Record<string, string> {
  const lines = (xs: string[]) => xs.join("\n") + "\n";
  return {
    "counts.json": JSON.stringify({ ir: ir.counts, findings: findings.counts }, null, 2) + "\n",
    "tables.txt": lines(ir.tables.map((t) => `${t.id}\t${t.layout}\t${t.rows} rows\tline ${t.line}\tparent=${t.parent?.field ?? t.parent?.member_of ?? t.parent?.identifier ?? "-"}`)),
    "fields.txt": lines(
      ir.fields.map(
        (f) =>
          `${f.id}\t${f.type.raw}\t${f.marker}\tline ${f.loc.line}` +
          (f.presence ? `\tpresence=${JSON.stringify(f.presence)}` : "") +
          (f.value_lists.length ? `\tvalues=${f.value_lists.length}` : "") +
          (f.inline_objects.length ? `\tobjects=${f.inline_objects.length}` : ""),
      ),
    ),
    "keys.txt": lines(ir.keys.map((k) => `${k.id}\t${k.required?.raw ?? "-"}\tline ${k.loc.line}`)),
    "definitions.txt": lines([...ir.markers.map((m) => `${m.id}\tline ${m.loc.line}`), ...ir.definitions.map((d) => `${d.id}\tline ${d.loc.line}`)]),
    "value-lists.txt": lines(
      ir.value_lists.map(
        (v) =>
          `${v.id}\tline ${v.loc.line}\t` +
          v.items.map((i) => i.value + (i.annotation ? ` (${i.annotation})` : "")).join(" | ") +
          (v.subject ? `\tsubject=${v.subject.identifier}` : ""),
      ),
    ),
    "inline-objects.txt": lines(ir.inline_objects.map((o) => `${o.id}\tline ${o.loc.line}\t${o.text}` + (o.anchor ? `\tanchor=${o.anchor}` : ""))),
    "statements.txt": lines(ir.statements.map((s) => `${s.id}\t${s.level}\tline ${s.loc.line}\t${s.text}`)),
    "sentences.txt": lines(ir.sentences.map((s) => `${s.id}\tline ${s.loc.line}\t${s.text}`)),
    "findings.txt": lines(findings.findings.map((f) => `${f.id}\t${f.disposition?.verdict ?? "open"}`)),
  };
}
