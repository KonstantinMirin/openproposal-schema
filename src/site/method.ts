/**
 * The pipeline figure every spec's How it's built page shows, laid out wide
 * for a desktop and tall for a phone. Each spec's page itself is its site
 * copy (src/site/copy.ts).
 */
import { esc } from "./html.ts";

// ---- The pipeline diagram -------------------------------------------------

interface Node {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "input" | "step" | "reviewed" | "check" | "output";
  lines: string[];
}

/** One layout of the pipeline: its nodes, and its arrows as path data. */
interface Layout {
  width: number;
  height: number;
  nodes: Record<string, Node>;
  arrows: string[];
  legend: { x: number; y: number };
}

const LINES: Record<string, string[]> = {
  spec: ["Specification", "markdown at a pinned", "commit and blob"],
  extract: ["1 Extract", "IR: each element with", "an ID, a quote, a digest"],
  domains: ["2 Value domains", "concepts, primitives,", "reviewed first"],
  map: ["3 Map", "one entry per element,", "by rule or by decision"],
  decisions: ["Decision records", "gaps and departures,", "each quoting its lines"],
  resolve: ["4 Resolve", "the model: layers,", "modules, named copies"],
  kernel: ["Constructors and", "the as-written", "switches"],
  emit: ["5 Emit", "JSON Schema, rules,", "SDK types, examples"],
  out: ["Site and files", "the type map, the", "schema files"],
  verify: ["6 Verify", "The fidelity oracle reads the IR alone and checks every output. Every gate rejects its known-bad fixtures,", "and the specification's examples run against the schemas and the rules."],
};

function wide(): Layout {
  const w = 150, h = 78, y1 = 20, y2 = 158, y3 = 282;
  const xs = [10, 188, 366, 544, 722, 900];
  const n = (x: number, y: number, kind: Node["kind"], key: string, width = w, height = h): Node => ({ x, y, w: width, h: height, kind, lines: LINES[key]! });
  const nodes: Record<string, Node> = {
    spec: n(xs[0]!, y1, "input", "spec"),
    extract: n(xs[1]!, y1, "step", "extract"),
    map: n(xs[2]!, y1, "step", "map"),
    resolve: n(xs[3]!, y1, "step", "resolve"),
    emit: n(xs[4]!, y1, "step", "emit"),
    out: n(xs[5]!, y1, "output", "out"),
    domains: n(277, y2, "reviewed", "domains", w, 70),
    decisions: n(455, y2, "reviewed", "decisions", w, 70),
    kernel: n(633, y2, "reviewed", "kernel", w, 70),
    verify: n(xs[1]!, y3, "check", "verify", xs[5]! + w - xs[1]!, 66),
  };
  const mid = y1 + h / 2;
  const right = (k: string) => nodes[k]!.x + nodes[k]!.w;
  const arrows = [
    ...[["spec", "extract"], ["extract", "map"], ["map", "resolve"], ["resolve", "emit"], ["emit", "out"]].map(([a, b]) => `M${right(a!)},${mid} L${nodes[b!]!.x - 4},${mid}`),
    `M${277 + 110},${y2} L${366 + 40},${y1 + h + 4}`,
    `M${455 + 40},${y2} L${366 + 110},${y1 + h + 4}`,
    `M${455 + 110},${y2} L${544 + 40},${y1 + h + 4}`,
    `M${633 + 40},${y2} L${544 + 110},${y1 + h + 4}`,
    `M${xs[1]! + 40},${y1 + h} L${xs[1]! + 40},${y3 - 4}`,
    `M${xs[4]! + 120},${y1 + h} L${xs[4]! + 120},${y3 - 4}`,
    `M${xs[5]! + 75},${y1 + h} L${xs[5]! + 75},${y3 - 4}`,
  ];
  return { width: 1060, height: 392, nodes, arrows, legend: { x: 10, y: 372 } };
}

function tall(): Layout {
  const x = 10, w = 206, h = 66, gap = 30, sx = 236, sw = 146, sh = 66;
  const keys = ["spec", "extract", "map", "resolve", "emit", "out"] as const;
  const kinds: Node["kind"][] = ["input", "step", "step", "step", "step", "output"];
  const nodes: Record<string, Node> = {};
  keys.forEach((k, i) => (nodes[k] = { x, y: 10 + i * (h + gap), w, h, kind: kinds[i]!, lines: LINES[k]! }));
  const yOf = (k: string) => nodes[k]!.y;
  nodes.domains = { x: sx, y: yOf("extract") + 48, w: sw, h: sh, kind: "reviewed", lines: LINES.domains! };
  nodes.decisions = { x: sx, y: yOf("map") + 52, w: sw, h: sh, kind: "reviewed", lines: LINES.decisions! };
  nodes.kernel = { x: sx, y: yOf("resolve") + 56, w: sw, h: sh, kind: "reviewed", lines: LINES.kernel! };
  const vy = yOf("out") + h + 40;
  nodes.verify = { x, y: vy, w: sx + sw - x, h: 118, kind: "check", lines: ["6 Verify", "The fidelity oracle reads the IR alone", "and checks every output. Every gate", "rejects its known-bad fixtures, and the", "specification's examples run against", "the schemas and the rules."] };
  const cx = x + w / 2;
  const arrows = [
    ...keys.slice(1).map((k, i) => `M${cx},${yOf(keys[i]!) + h} L${cx},${yOf(k) - 4}`),
    `M${sx},${nodes.domains.y + sh / 2} L${x + w + 4},${yOf("map") + 20}`,
    `M${sx},${nodes.decisions.y + 16} L${x + w + 4},${yOf("map") + 50}`,
    `M${sx},${nodes.decisions.y + sh - 12} L${x + w + 4},${yOf("resolve") + 24}`,
    `M${sx},${nodes.kernel.y + sh / 2} L${x + w + 4},${yOf("resolve") + 52}`,
    `M${cx},${yOf("out") + h} L${cx},${vy - 4}`,
    `M${x},${yOf("extract") + h / 2} L${x - 6 + 2},${yOf("extract") + h / 2} L${x - 4},${vy + 30} L${x - 2 + 4},${vy + 30}`,
  ];
  return { width: 392, height: vy + 118 + 46, nodes, arrows, legend: { x: 10, y: vy + 118 + 28 } };
}

function svgOf(l: Layout, cls: string, id: string): string {
  const box = (n: Node) => {
    const lines = n.lines.map((s, i) => `<tspan x="${n.x + 12}" dy="${i === 0 ? 0 : 16}"${i === 0 ? ' class="d-title"' : ""}>${esc(s)}</tspan>`).join("");
    return `<g class="d-node d-${n.kind}"><rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="8"/><text x="${n.x + 12}" y="${n.y + 22}">${lines}</text></g>`;
  };
  const key = (x: number, kind: Node["kind"], label: string) => `<g class="d-node d-${kind}"><rect x="${x}" y="${l.legend.y - 10}" width="18" height="12" rx="3"/></g><text class="d-key" x="${x + 24}" y="${l.legend.y}">${label}</text>`;
  const legend = l.width > 600
    ? [key(l.legend.x, "step", "generated"), key(l.legend.x + 120, "reviewed", "reviewed by hand"), key(l.legend.x + 280, "check", "checks every output")].join("")
    : [key(l.legend.x, "step", "generated"), key(l.legend.x + 110, "reviewed", "reviewed by hand")].join("");
  return `<svg class="${cls}" viewBox="0 0 ${l.width} ${l.height}" role="img" aria-labelledby="${id}"><title id="${id}">The pipeline: the specification is extracted into an intermediate representation, mapped with the value domains and the decision records, resolved into a model with the constructors and the variant switches, and emitted as the schemas, rules, SDK types, and examples that the site and the downloads serve. A verification step checks every output against the extracted text.</title>
<defs><marker id="${id}-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="d-head" d="M0,0 L10,5 L0,10 z"/></marker></defs>
${l.arrows.map((d) => `<path class="d-arrow" d="${d}" marker-end="url(#${id}-head)"/>`).join("")}
${Object.values(l.nodes).map(box).join("")}
${legend}
</svg>`;
}

/** The pipeline as one figure, laid out wide for a desktop and tall for a phone. */
export function pipelineFigure(): string {
  return `<figure class="pipeline">${svgOf(wide(), "fig-wide", "pipe-wide")}${svgOf(tall(), "fig-tall", "pipe-tall")}<figcaption>Each step is a function of the steps before it and of the inputs we review by hand. The verification step reads the extracted text, not the mapping, so it can disagree with every step in between.</figcaption></figure>`;
}
