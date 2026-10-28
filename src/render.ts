/**
 * Stage 5d, the round trip: renders a specification's tables from the model,
 * in the notation its plugin gives (`RoundTripNotation`), and compares them,
 * cell by cell, with the tables the IR records, so the specification and the
 * schemas can't drift apart. OpenProposal's notation, with its Appendix A
 * and B, is in src/specs/openproposal/render.ts.
 *
 * Each cell is compared after normalizing whitespace, escaped pipes, and
 * backticks, and so is each figure the specification states in prose and the
 * model gives. A difference is either a recorded decision in
 * `roundtrip/differences.yaml`, or the gate fails.
 */
import { join } from "node:path";
import type { SpecIR } from "./ir-types.ts";
import { inScope, readYaml, retired, stands, type DecisionRecord } from "./mapping.ts";
import type { ModelDoc } from "./model.ts";
import { compileSchema } from "./pipeline.ts";
import { REPO_ROOT } from "./repo.ts";

/** One row: the IR element it pairs with (or the model's name for a row the table lacks), its cells, and the IR elements it rests on. */
export interface RenderedRow {
  row: string;
  cells: string[];
  elements: string[];
}

export interface RenderedTable {
  id: string;
  layout: string;
  section: string;
  header: string[];
  rows: RenderedRow[];
}

/** One cell where the rendering and the specification differ. Column `*` is a row only one side has. */
export interface Difference {
  table: string;
  row: string;
  column: string;
  spec: string;
  model: string;
  /** The IR elements the row rests on, on both sides; a recorded difference's decision covers one of them. */
  elements: string[];
}

export interface RoundTrip {
  model: RenderedTable[];
  spec: RenderedTable[];
  figures: { model: Figures; spec: Figures } | null;
  differences: Difference[];
  /** Where the renderer can't place what the IR records; any problem fails the gate. */
  problems: string[];
}

/** The comparison form of a cell: escaped pipes unescaped, backticks dropped, whitespace collapsed. */
export const normalize = (s: string) => s.replaceAll("\\|", "|").replaceAll("`", "").replace(/\s+/g, " ").trim();


/** Figures a specification states in prose and the model gives, by name, in the order the specification states them, such as Appendix B's distribution. */
export type Figures = Record<string, number>;

/** A specification's notation for the round trip (`SpecPlugin.roundTrip`). */
export interface RoundTripNotation {
  /** The specification's tables, as the IR records them, in the rendering's cells. */
  specTables(ir: SpecIR): RenderedTable[];
  /** The same tables rendered from the model, with the figures the model gives, if the specification states any. */
  renderTables(model: ModelDoc, ir: SpecIR): { tables: RenderedTable[]; figures: Figures | null; problems: string[] };
  /** The figures the specification states, if any. */
  specFigures(ir: SpecIR): { figures: Figures; section: string } | null;
  /** The figures as a paragraph of the rendered tables, for people to read. */
  describeFigures(f: Figures): { title: string; text: string };
}

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** The differences between the rendered tables and the specification's, cell by cell, normalized. */
export function diffTables(model: RenderedTable[], spec: RenderedTable[]): Difference[] {
  const out: Difference[] = [];
  for (const s of spec) {
    const m = model.find((t) => t.id === s.id);
    const mrows = m?.rows ?? [];
    const ids = uniq([...s.rows.map((x) => x.row), ...mrows.map((x) => x.row)]);
    for (const id of ids) {
      const a = s.rows.find((x) => x.row === id);
      const b = mrows.find((x) => x.row === id);
      const elements = sorted([...(a?.elements ?? []), ...(b?.elements ?? [])]);
      if (!a || !b || a.cells.length === 0 || b.cells.length === 0) {
        out.push({ table: s.id, row: id, column: "*", spec: a?.cells.join(" | ") ?? "", model: b?.cells.join(" | ") ?? "", elements });
        continue;
      }
      s.header.forEach((column, i) => {
        const x = a.cells[i] ?? "";
        const y = b.cells[i] ?? "";
        if (normalize(x) !== normalize(y)) out.push({ table: s.id, row: id, column: normalize(column), spec: x, model: y, elements });
      });
    }
  }
  return out;
}


/** The figures that differ, in the order the specification states them. */
function diffFigures(model: Figures, spec: Figures, section: string): Difference[] {
  return Object.keys(spec)
    .filter((f) => model[f] !== spec[f])
    .map((f) => ({ table: section, row: "distribution", column: f, spec: String(spec[f]), model: String(model[f]), elements: [] }));
}

/** Renders one lock's model in the specification's notation and compares it with its IR. */
export function roundTrip(model: ModelDoc, ir: SpecIR, notation: RoundTripNotation): RoundTrip {
  const rendered = notation.renderTables(model, ir);
  const spec = notation.specTables(ir);
  const stated = notation.specFigures(ir);
  const figures = rendered.figures && stated ? { model: rendered.figures, spec: stated.figures } : null;
  const differences = [...diffTables(rendered.tables, spec), ...(figures && stated ? diffFigures(figures.model, figures.spec, stated.section) : [])];
  return { model: rendered.tables, spec, figures, differences, problems: rendered.problems };
}

/** The rendered tables as markdown, for people to read: `npm run render` writes them under `build/`. */
export function renderMarkdown(rt: RoundTrip, lock: string, notation: RoundTripNotation): string {
  const cell = (s: string) => s.replaceAll("|", "\\|");
  const out = [`# Tables rendered from the model, lock \`${lock}\``, "", "Generated by `npm run render`. Each table is rendered from the model; the round trip compares it with the specification.", ""];
  for (const t of rt.model) {
    out.push(`## ${t.id} (§ ${t.section})`, "", `| ${t.header.join(" | ")} |`, `| ${t.header.map(() => ":---").join(" | ")} |`);
    for (const row of t.rows) out.push(`| ${(row.cells.length > 0 ? row.cells : t.header.map(() => "")).map(cell).join(" | ")} |`);
    out.push("");
  }
  if (rt.figures) {
    const { title, text } = notation.describeFigures(rt.figures.model);
    out.push(`## ${title}`, "", text, "");
  }
  out.push(`## Differences from the specification (${rt.differences.length})`, "");
  for (const d of rt.differences) out.push(`- ${d.table} ${d.row} [${d.column}]: specification "${d.spec}", model "${d.model}"`);
  return `${out.join("\n")}\n`;
}

/** A recorded difference: the decision that makes the model differ from the specification there. */
export interface RecordedDifference {
  table: string;
  row: string;
  column: string;
  spec: string;
  model: string;
  decision: string;
  reason: string;
  locks?: string[];
}

export interface DifferencesFile {
  format: 1;
  differences: RecordedDifference[];
  file: string;
}

export const DIFFERENCES_FILE = join("roundtrip", "differences.yaml");
const DIFFERENCES_SCHEMA = join("roundtrip", "differences.schema.json");

/** Loads and validates recorded differences, a spec's `roundtrip/differences.yaml` (`DIFFERENCES_FILE` in its folder). */
export function loadDifferences(file: string): DifferencesFile {
  const doc = readYaml(file);
  const errors = compileSchema(join(REPO_ROOT, DIFFERENCES_SCHEMA))(doc);
  if (errors.length > 0) throw new Error(`${file}: not a valid differences file: ${errors.join("; ")}`);
  return { ...(doc as Omit<DifferencesFile, "file">), file };
}

const keyOf = (d: { table: string; row: string; column: string }) => `${d.table} ${d.row} [${d.column}]`;

/**
 * Checks one lock's differences against the record: every difference is
 * recorded, with the specification's and the model's text as they are now,
 * and cites a decision that covers one of the elements its row rests on;
 * every recorded difference in the lock's scope still occurs.
 */
export function checkDifferences(actual: Difference[], recorded: DifferencesFile, lock: string, decisions: DecisionRecord[]): string[] {
  const problems: string[] = [];
  const scope = recorded.differences.filter((d) => inScope(d.locks, lock));
  const seen = new Set<string>();
  for (const r of scope) {
    const k = keyOf(r);
    if (seen.has(k)) problems.push(`${recorded.file}: ${k} is recorded twice on lock "${lock}"`);
    seen.add(k);
  }
  for (const d of actual) {
    const r = scope.find((x) => keyOf(x) === keyOf(d));
    if (!r) {
      problems.push(`${keyOf(d)}: the specification writes "${d.spec}", the model renders "${d.model}" on lock "${lock}"; fix the mapping, or record the difference with the decision that makes it`);
      continue;
    }
    if (normalize(r.spec) !== normalize(d.spec) || normalize(r.model) !== normalize(d.model)) {
      problems.push(`${recorded.file}: ${keyOf(d)} changed on lock "${lock}": now the specification writes "${d.spec}" and the model renders "${d.model}"; review it and record the current text`);
    }
    const decision = decisions.find((x) => x.id === r.decision);
    if (!decision) problems.push(`${recorded.file}: ${keyOf(d)} cites "${r.decision}", which is no decision record`);
    else if (!stands(decision)) problems.push(`${recorded.file}: ${keyOf(d)} cites "${r.decision}", which is ${retired(decision)}`);
    else if (d.elements.length > 0 && !decision.covers.some((c) => inScope(c.locks, lock) && d.elements.includes(c.ir))) {
      problems.push(`${recorded.file}: ${keyOf(d)} cites ${r.decision}, which covers none of ${d.elements.join(", ")} on lock "${lock}"`);
    }
  }
  for (const r of scope) {
    if (!actual.some((d) => keyOf(d) === keyOf(r))) problems.push(`${recorded.file}: ${keyOf(r)} no longer differs on lock "${lock}"; remove the entry`);
  }
  return problems;
}
