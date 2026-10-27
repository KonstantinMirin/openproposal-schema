/**
 * The site's methodology page, `how-it-is-built.html`: how the pipeline
 * produces the schemas, and how each step shapes what the type map and the
 * downloads show. Its numbers, its worked example, and its links are read
 * from the repository, so the page stays true to the build it ships with.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse as parseYaml } from "yaml";
import { schemaDirOf } from "../emit.ts";
import { indexElements } from "../elements.ts";
import { RULES_FILE, rulesDirOf, type RulesDoc } from "../rules.ts";
import { TYPE_EXAMPLES_FILE, typeExamplesDirOf, type TypeExamplesDoc } from "../type-examples.ts";
import { PUBLIC_REPO_URL, PUBLISHER } from "./config.ts";
import { sourceInfos, type SiteInputs } from "./data.ts";
import { esc, inline, page } from "./html.ts";
import { mapLink } from "./pages.ts";

/** The field the worked example follows, and the build its links open. */
const EXAMPLE = { field: "formats", element: "field:5.4:formats", lock: "main", variant: "as-written" } as const;

const json = (v: unknown) => `<pre class="code"><code>${esc(JSON.stringify(v, null, 2))}</code></pre>`;
const m = (type: string, view?: "schema" | "example", open?: string[]) => mapLink("", type, EXAMPLE.lock, EXAMPLE.variant, view, open);
const t = (type: string, view?: "schema" | "example", open?: string[]) => `<a href="${m(type, view, open)}"><code>${esc(type)}</code></a>`;
/** A type of the proposed build, where a departure gives it, on the input that publishes it. */
const tp = (type: string, lock = "main") => `<a href="${mapLink("", type, lock, "proposals")}"><code>${esc(type)}</code></a>`;
const dec = (id: string) => `<a href="decisions/${id}.html">${id}</a>`;

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
  out: ["Site and downloads", "the type map, the", "files at their $id"],
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

// ---- The page -------------------------------------------------------------

/** The first of the lock's example files that writes the example's values, by its path in the specification's repository. */
function exampleFileOf(inputs: SiteInputs, lock: string, available: string[]): string | null {
  const dir = join(inputs.root, "spec-input", "snapshots", lock, "examples");
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  } catch {
    return null;
  }
  const has = (v: unknown): boolean => {
    if (v === null || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    const f = o[EXAMPLE.field] as { available?: unknown } | undefined;
    if (f && Array.isArray(f.available) && available.every((a) => (f.available as unknown[]).includes(a))) return true;
    return Object.values(o).some(has);
  };
  for (const f of files) if (has(parseYaml(readFileSync(join(dir, f), "utf8")))) return `examples/${f}`;
  return null;
}

export function methodPage(inputs: SiteInputs): string {
  const lock = inputs.locks.find((l) => l.name === EXAMPLE.lock)!;
  const build = inputs.builds.get(lock.name)!.get(EXAMPLE.variant)!;
  const model = build.model;
  const ir = inputs.irs.get(lock.name)!;
  const counts = ir.counts as Record<string, number>;
  const gaps = inputs.decisions.filter((d) => d.kind === "gap" && d.status !== "superseded").length;
  const departures = inputs.decisions.filter((d) => d.kind === "departure" && d.status !== "superseded").length;
  const domains = inputs.kernel.domains?.domains ?? [];
  const concepts = domains.reduce((n, d) => n + d.concepts.length, 0);
  let byRule = 0;
  let byDecision = 0;
  for (const f of inputs.mappings) for (const e of f.entries) ("rule" in (e.source as object) ? byRule++ : byDecision++);
  const kinds = new Map<string, number>();
  for (const x of model.types) kinds.set(x.kind, (kinds.get(x.kind) ?? 0) + 1);
  const rulesDoc = JSON.parse(readFileSync(join(inputs.root, build.dirOf(rulesDirOf(lock.ir_dir)), RULES_FILE), "utf8")) as RulesDoc;

  // The worked example, read from the build it links.
  const element = indexElements(ir).get(EXAMPLE.element)!;
  const info = sourceInfos(inputs, lock, [EXAMPLE.element])[EXAMPLE.element]!;
  const lineItem = model.types.find((x) => x.name === "LineItem") as { properties: Record<string, { type: { kind: string; constructor?: string; arguments?: Record<string, { name?: string }> }; marker?: string }> };
  const prop = lineItem.properties[EXAMPLE.field]!;
  const ctor = prop.type.constructor!;
  const argT = prop.type.arguments!.T!.name!;
  const copy = model.types.find((x) => x.kind === "copy" && JSON.stringify((x as { of: unknown }).of) === JSON.stringify(prop.type)) as { name: string; layer: number; module: string; application: string };
  const primitive = inputs.kernel.primitives.find((p) => p.name === argT)!;
  const concept = domains.flatMap((d) => d.concepts.map((c) => ({ domain: d.name, ...c }))).find((c) => c.type === argT)!;
  const schemaDir = build.dirOf(schemaDirOf(lock.ir_dir));
  const file = posix.join(schemaDir, "modules", copy.module, "1", `${copy.module}.json`);
  const emitted = (JSON.parse(readFileSync(join(inputs.root, file), "utf8")) as { $defs: Record<string, unknown> }).$defs[copy.name];
  const te = JSON.parse(readFileSync(join(inputs.root, build.dirOf(typeExamplesDirOf(lock.ir_dir)), TYPE_EXAMPLES_FILE), "utf8")) as TypeExamplesDoc;
  const value = (te.types.LineItem as { full: Record<string, { available: string[] }> }).full[EXAMPLE.field]!;
  const exampleFile = exampleFileOf(inputs, lock.name, value.available);
  const copyRules = rulesDoc.rules.filter((r) => r.owner === ctor);
  const digest = (element.element as { digest?: string }).digest ?? "";
  const repo = PUBLIC_REPO_URL;
  const specLink = info.links[0];

  const toc: [string, string][] = [
    ["pipeline", "The pipeline"],
    ["extraction", "Extraction"],
    ["domains", "The value-domain model"],
    ["mapping", "Semantic mapping"],
    ["constructors", "Constructors and copies"],
    ["layers", "Layers"],
    ["emission", "Emission rules"],
    ["beyond", "What JSON Schema can't say"],
    ["verification", "Verification"],
    ["variants", "Variants and inputs"],
    ["example", "One field, end to end"],
    ["reproduce", "How to reproduce it"],
  ];

  const body = `<div class="wrap method">
<h1>How it's built</h1>
<p class="lede">${PUBLISHER}, an IAB Tech Lab member, generates these schemas from the OpenProposal 3.0 specification text. Nobody writes a schema file by hand. Every schema, rule, example payload, and SDK type is a function of two things: the specification at a pinned commit, and a mapping and a set of decision records that we review by hand. This page explains each step, and what it shapes in the <a href="map.html">type map</a> and the <a href="downloads.html">downloads</a>.</p>
<nav class="toc" aria-label="On this page"><p class="note">On this page</p><ol>${toc.map(([id, label]) => `<li><a href="#${id}">${label}</a></li>`).join("")}</ol></nav>

<section id="pipeline">
<h2>The pipeline</h2>
<p>The pipeline runs in six steps. Steps 1, 4, and 5 are programs: two runs write the same bytes, and the gates fail when the committed output differs from a fresh run. Step 2 and the decision records are reviewed input. Step 3 is both: mapping rules derive what the text decides, and a decision record covers everything else. Step 6 checks the result against the text.</p>
${pipelineFigure()}
</section>

<section id="extraction">
<h2>Extraction</h2>
<p>A deterministic parser reads the specification's markdown and writes an intermediate representation (IR). It makes no judgments and calls no language model. On <code>main</code>, the IR holds ${counts.fields} field rows, ${counts.keys} key rows, ${counts.value_lists} value lists, ${counts.inline_objects} inline objects, and ${counts.statements} RFC 2119 statements, with the marker rows, the code blocks, and every prose sentence that names an identifier.</p>
<p>Each element has a stable ID, a quote, and a digest.</p>
<ul>
<li><strong>The ID</strong> says where the element is, in the order you would look for it. Read <code>field:5.10:billing#description/object:1</code> as: a field row (<code>field</code>), in § 5.10 (<code>5.10</code>), the row whose name cell is <code>billing</code>, its description cell (<code>#description</code>), and the first inline object in that cell (<code>/object:1</code>). A key row is <code>key:5.6.1:commitment.flight_start</code>, a value list adds <code>/values:1</code>, and a member's value list adds the member, as in <code>…/object:1/feed_type</code>. A statement or a sentence has no name, so its ID ends in the first eight hex digits of the SHA-256 of its text, such as <code>rule:5.5:2eab2842</code>.</li>
<li><strong>The quote</strong> is the element's text as the specification writes it.</li>
<li><strong>The digest</strong> is the SHA-256 of a table row's source bytes, or of any other element's canonical JSON without its location, so moving an element doesn't change it.</li>
</ul>
<p>Every mapping entry, decision record, domain concept, primitive, and test vector that rests on an element stores the element's digest. When the text of the element changes, each of them goes stale, and the gates fail until someone reviews it and records the new digest.</p>
<p class="where"><strong>Where you see it.</strong> In the type map, a type's <em>Specification lines it rests on</em> lists each element it rests on, with a readable label, the quote, and a link to its lines on GitHub. Expand an item to see its ID.</p>
</section>

<section id="domains">
<h2>The value-domain model</h2>
<p>Before any mapping, we wrote and reviewed a model of the values the specification talks about: ${domains.length} value domains, such as identity, money, and time, with ${concepts} concepts under them. Each concept says what a value means, names the one type that represents it, and cites the specification elements and standards it rests on. The kernel defines each of its ${inputs.kernel.primitives.length} primitives once, by its meaning, not by its format.</p>
<p>A concept gets a type of its own only when its values validate differently, or a receiver handles them differently: compares them, adds them, fetches them, or shows them. Where a value comes from doesn't change either, so it goes in the field's description.</p>
<dl class="cases">
<dt>Money and its currency</dt>
<dd>A sum of money is ${t("Amount")}, a bare number of at least 0. Its currency is the ${t("CurrencyCode")} in a sibling <code>currency</code> member of the same object, never one inherited from an enclosing object. Where the money is required, so is its currency. Where it is optional, <code>dependentRequired</code> requires the currency with it. The one signed case, an option's price change, is ${t("PriceAdjustment")} (${dec("D-036")}).</dd>
<dt>Three kinds of time</dt>
<dd>A point in time is a ${t("Timestamp")}, an RFC 3339 date-time (${dec("D-001")}). A span is a ${t("Duration")}, whatever form the examples write (${dec("D-040")}). A daypart window is a ${t("DaypartWindow")}: days and two ${t("TimeOfDay")} ends, <code>HH:MM</code>, read on the line item's clock. The open PRs add that clock as <code>time_zone</code>, a ${tp("TimeZone", "with-open-prs")}; on <code>main</code> the text names none (${dec("D-004")}, ${dec("D-038")}). Each validates differently, and a receiver compares the first two as instants and lengths, and reads the third on a clock.</dd>
<dt><code>Uuid</code> or <code>ExternalId</code></dt>
<dd>An ID that a party of the proposal mints, such as a <code>proposal_id</code>, is a ${tp("Uuid")}, so every party compares it the same way (${dec("D-037")}). As written, the text types such an ID as any string. An ID, a code, or a version that another system or list defines is an ${t("ExternalId")}: the proposal carries it as written and never parses it, and the field's description names the system. An <code>ExternalId</code> and a ${t("Text")} have the same structure, a string, but a receiver compares one and shows the other, so the domain model declares them distinct types.</dd>
<dt>Named vocabularies</dt>
<dd>A field whose values are terms has a named vocabulary, such as ${t("Channel")}. A closed vocabulary is an <code>enum</code>. An open one also takes a ${t("NamespacedTerm")}, <code>&lt;domain&gt;:&lt;term&gt;</code>, such as <code>examplepub.example:podcast_host_read</code>, where the domain is the definer's. A vocabulary whose core terms the specification doesn't list yet takes namespaced terms only (${dec("D-041")}).</dd>
</dl>
<p class="where"><strong>Where you see it.</strong> The type map's first column groups the primitives by value domain, and a primitive's detail shows its domain, its concept, and the concept's meaning.</p>
</section>

<section id="mapping">
<h2>Semantic mapping</h2>
<p>The mapping says what each IR element becomes: a property, a named type, a vocabulary term, a rule, an obligation, a profile, an example, or informative text. Every element has exactly one entry on each input, in the file of the module that owns its section. Of the ${byRule + byDecision} entries across both inputs, ${byRule} come from mapping rules and ${byDecision} cite a decision record.</p>
<ul>
<li><strong>Rules first.</strong> A mapping rule maps what the IR, the domain model, and the type rules decide. For example, a row a concept cites is typed by that concept, by the rule <code>domain-row</code>, so no decision types it. An entry can't cite a decision where a rule applies.</li>
<li><strong>Gaps.</strong> Where the text leaves a point open, a decision record settles it. There are ${gaps} such records, of kind <em>gap</em>. Both variants keep them, since the text gives nothing to fall back to.</li>
<li><strong>Departures.</strong> Where the text or its examples settle a point and we would write it differently, a decision record of kind <em>departure</em> records the change, and lists which constraint forms it changes. There are ${departures}, and the as-written variant switches each one off.</li>
</ul>
<p>A decision record states its question, the options we weighed, the one we chose and why, what we ask the specification to state, and the elements it rests on, each quoted and digested. Read them all in the <a href="decisions/index.html">decision records</a>.</p>
<p class="where"><strong>Where you see it.</strong> A type's detail lists its <em>Decision records</em>. A member that differs between the variants carries a badge that links the departure, and a bar under a type's chip marks a type a proposal changes.</p>
</section>

<section id="constructors">
<h2>Constructors and copies</h2>
<p>The specification writes a few forms many times. The model holds each one once, as a template: ${t("Selectable")}<code>&lt;T, K&gt;</code> for a field the buyer selects options of (§ 3.1), ${t("Settable")}<code>&lt;T&gt;</code> for a field the buyer sets within bounds (§ 3.2), ${t("Range")}<code>&lt;T&gt;</code> for a <code>{ min, max }</code> pair, <code>CatalogRefOr&lt;T&gt;</code> for an inline value or a catalog reference (§ 2.2), and <code>List&lt;T&gt;</code> and <code>Map&lt;K, V&gt;</code>.</p>
<p>Templates exist only in the model. Each application becomes a named, concrete copy in the schema, so a plain code generator that knows nothing about generics still produces correct classes. A gate runs a stock generator on the published schema files alone and holds its classes to the same verdicts as ours.</p>
<p>A copy is named after the field its mapping entry names, in PascalCase and with no singular form: <code>&lt;Field&gt;Selection</code>, <code>&lt;Field&gt;Bounds</code>, or <code>&lt;Field&gt;Range</code>. So <code>formats</code> gives ${t("FormatsSelection")}, and <code>max</code> in <code>frequency_cap</code>'s object gives ${t("MaxRange")}. A <code>CatalogRefOr</code> copy can stand where no field names it, so it is named after its argument, <code>&lt;T&gt;OrCatalogRef</code>. <code>List</code> and <code>Map</code> carry no rule of their own, so they stay inline. Two fields that apply one template to the same arguments, such as ${t("GeoBounds")} and ${t("DeviceBounds")}, get two names for one definition, which the template keeps from drifting apart.</p>
<p class="where"><strong>Where you see it.</strong> In the type map, a template is in italics in the second column, and a copy has a dashed border. A copy's detail shows its application, such as <code>${esc(copy.application)}</code>. On <code>main</code>, as written, the model holds ${kinds.get("copy") ?? 0} copies.</p>
</section>

<section id="layers">
<h2>Layers</h2>
<p>Types build from the bottom up, and a type uses only the layers below it.</p>
<ol class="layers-list">
<li><strong>Primitives.</strong> Every scalar that validates or is handled differently, such as ${tp("Uuid")} and ${t("Amount")}.</li>
<li><strong>Constructors and parts.</strong> The templates, and the parts their copies share, such as ${t("PriceDelta")}. A copy sits at the layer of the highest type it holds.</li>
<li><strong>Vocabularies.</strong> Every value list a module owns, such as ${t("Channel")}.</li>
<li><strong>Objects and unions.</strong> Each module's structures, such as ${t("Commitment")}.</li>
<li><strong>Documents and profiles.</strong> ${t("Proposal")}, ${t("LineItem")}, and the summaries projected from them.</li>
</ol>
<p>The layering is a gate, and it matters for three reasons. No reference chain can form a cycle, so every generator can emit the types in order. Each concept is defined once, low in the stack, and every use references it, so a constraint can't drift between two copies. And the modules follow the specification's sections, each depending only on the kernel and on the modules it declares, which gives the schema files their structure: <code>kernel/1/kernel.json</code>, <code>modules/&lt;module&gt;/1/&lt;module&gt;.json</code>, and <code>documents/1/&lt;document&gt;.json</code>.</p>
<p class="where"><strong>Where you see it.</strong> The type map's five columns are the layers. Select a type to see what it's built from and what uses it.</p>
</section>

<section id="emission">
<h2>Emission rules</h2>
<p>The emitter turns the model into JSON Schema 2020-12. The schemas use standard keywords only, so any validator reads them the same way.</p>
<ul>
<li>No custom keywords: no <code>x-</code> keys, no <code>discriminator</code>, and no <code>$dynamicRef</code>.</li>
<li><code>oneOf</code> only for a tagged union, where every branch has a required <code>const</code> member that names it.</li>
<li><code>anyOf</code> for an open vocabulary, and for the untagged unions the draft requires, such as the choice between an inline value and a <code>catalog_ref</code>. Our feedback lists each untagged union as a place where the specification should add a tag.</li>
<li><code>if</code> / <code>then</code> for a condition, such as a currency that is required when <code>basis</code> is <code>spend</code>, and <code>dependentRequired</code> for a member another member requires.</li>
<li>No <code>allOf</code>: objects are named and referenced whole, so no schema inherits from another.</li>
<li>A constraint lives only on a named type, and a property carries nothing beside its <code>$ref</code> but a description.</li>
<li>An object is closed unless the specification leaves its structure open.</li>
</ul>
<p>A profile, such as the § 2.1 summary of a line item, projects paths, not whole fields. A path through an object makes a named object with only the members the paths name, such as ${t("LineItemSummaryPricingEntry")}.</p>
<p class="where"><strong>Where you see it.</strong> A type's <em>Schema</em> view shows its emitted schema, and each <code>$ref</code> opens the type it names. The <a href="downloads.html">downloads</a> serve each file at the URL its <code>$id</code> names.</p>
</section>

<section id="beyond">
<h2>What JSON Schema can't say</h2>
<p>Some statements can't be checked by a schema of one payload: one field compared with another, an entry that must name an option in another list, uniqueness by a key, arithmetic, which party may change a field between two versions, and what a receiver does. Each one becomes a rule, with an ID, the text it comes from, the object that owns it, and at least one valid and one invalid test vector. A vector is a payload, a pair of versions with the party that made the change, or a payload with the receiver's response. An invalid vector of a SHOULD rule is a warning, and of any other rule an error. On <code>main</code>, as written, there are ${rulesDoc.rules.length} rules.</p>
<p>A requirement that no payload can show, such as a seller rejecting a stale commitment attempt, is an obligation on a party: the seller, the buyer, a consumer, or an implementation. An obligation has no keyword and no vector. The model lists ${model.obligations.length} of them.</p>
<p class="where"><strong>Where you see it.</strong> A type's detail lists its <em>Rules beyond the schema</em>. The downloads include each build's rules with their vectors.</p>
</section>

<section id="verification">
<h2>Verification</h2>
<ul>
<li><strong>The fidelity oracle.</strong> A separate program reads, from the IR alone, every constraint the text states in a form that needs no judgment: a REQUIRED or OPTIONAL row, a conditional REQUIRED, a value list, a list of members a representation must contain, a stated type, and a YAML example. It never reads the mapping or the decisions. For each constraint it builds a valid and an invalid payload and checks that the emitted schema gives each its verdict. A disagreement fails, unless a departure covers that exact element and lists that form of constraint.</li>
<li><strong>Known-bad fixtures.</strong> Every gate has fixtures it must reject, such as a model with a currency deleted, a twin of <code>Amount</code>, or a link to a page the site doesn't hold. After the gates run, CI reruns each gate on each fixture, and the gate must fail with the expected message.</li>
<li><strong>Append-only gate records.</strong> Each gate has a fingerprint of its code, its fixtures, and its exemptions. When a fingerprint changes, a new gate decision must accept it and say why. CI fails when a commit edits, deletes, or renames a gate decision, so a gate can't be relaxed in the change that needs it relaxed.</li>
<li><strong>The specification's examples.</strong> Every example the specification gives runs against its document's schema and every rule one payload decides. A failure is recorded with the decision its location rests on, and goes into our implementation feedback. The model never changes to fit an example.</li>
<li><strong>Determinism and parity.</strong> Every generated file is written twice in separate processes and compared byte for byte. The TypeScript, Python, and Go types reach the reference validator's verdict on every case of the conformance corpus.</li>
</ul>
</section>

<section id="variants">
<h2>Variants and inputs</h2>
<p>Two switches pick one of four builds. Each has its own data in the type map, its own examples, and its own downloads.</p>
<ul>
<li><strong>Input.</strong> <code>main</code> is the specification on its <code>main</code> branch at commit <code>${esc(lock.commit.slice(0, 7))}</code>. <em>With the open PRs</em> is <code>main</code> with the pull requests that were open on the day we locked merged in, each at its head that day. We merged them ourselves, so that tree exists on no upstream branch.</li>
<li><strong>Variant.</strong> <em>As written</em> switches our ${departures} departures off, so each field they change takes the form the text or its examples write. <em>With our proposals</em> switches them on. In both, the ${gaps} gap records stay in force. A gate checks that the two builds differ only where a switch says.</li>
</ul>
</section>

<section id="example">
<h2>One field, end to end</h2>
<p>This follows the line item's <code>${EXAMPLE.field}</code> field through each step, on <code>main</code>, as written. Each step links the type map at what it produced.</p>
<ol class="steps">
<li><h3>The specification row</h3><p>${inline(info.label, "")}${specLink ? `, <a href="${esc(specLink.href)}">${esc(specLink.text)}</a>` : ""}:</p><blockquote>${inline(info.quote, "")}</blockquote><p>Its marker, <code>${esc(prop.marker ?? "")}</code>, says the buyer selects among options the seller declares. <a href="${m("LineItem", undefined, [EXAMPLE.field])}">See the row in <code>LineItem</code>'s composition</a>.</p></li>
<li><h3>The element</h3><p>The parser records the row as <code>${esc(EXAMPLE.element)}</code>, a field row in § 5.4 named <code>${EXAMPLE.field}</code>, with the digest <code class="digest">${esc(digest)}</code>. Everything below that rests on the row stores that digest.</p></li>
<li><h3>The concept</h3><p>The row's options are "registry format ids namespaced by channel", written <code>display/300x250</code>, so they validate differently from an external ID: <code>300x250</code> isn't one. The domain model gives them the concept <code>${esc(concept.name)}</code>, in the ${esc(concept.domain)} domain, and its type ${t(argT)}, the pattern <code>${esc(String((primitive.constraints as Record<string, unknown>).pattern ?? ""))}</code> (${dec("D-019")}).</p></li>
<li><h3>The constructor</h3><p>A <code>selectable</code> field takes the § 3.1 form, ${t(ctor)}<code>&lt;T, K&gt;</code>. The mapping entry applies it as <code>${esc(copy.application.replace(/T=|K=/g, ""))}</code>: an option is named in <code>included[]</code> and the <code>pricing</code> keys by its value, so <code>K</code> is <code>T</code> (${dec("D-007")}), and no field takes a bare value in place of the full form (${dec("D-018")}).</p></li>
<li><h3>The copy</h3><p>The model names the application after its field: ${t(copy.name)}, in layer ${copy.layer} because it holds only primitives and a part, and in the <code>${esc(copy.module)}</code> module, which owns § 5.4. ${copyRules.length > 0 ? `It carries the template's ${copyRules.length === 1 ? "rule" : `${copyRules.length} rules`}, such as <code>${esc(copyRules[0]!.id)}</code>: ${inline(copyRules[0]!.statement.split(". ")[0]!.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase()), "")}.` : ""}</p></li>
<li><h3>The emitted schema</h3><p>In <a href="${esc(file)}"><code>${esc(file)}</code></a>, under <code>$defs</code>. <a href="${m(copy.name, "schema")}">Open it in the type map</a>.</p>${json(emitted)}</li>
<li><h3>The example value</h3><p>The type examples take each value from the specification's own examples where the schema accepts it${exampleFile ? `, here <code>${esc(exampleFile)}</code>` : ""}. <a href="${m("LineItem", "example")}">See it in <code>LineItem</code>'s example</a>.</p>${json({ [EXAMPLE.field]: value })}</li>
</ol>
</section>

<section id="reproduce">
<h2>How to reproduce it</h2>
<p>${repo ? `The tooling is public at <a href="${esc(repo)}">${esc(repo.replace("https://github.com/", ""))}</a>.` : "The tooling's repository holds every step."} It needs Node 22, and the gates also need Python 3.12 and Go 1.25 or later. To run every gate, as CI does:</p>
<pre class="code"><code>npm ci --ignore-scripts
npm run setup:oracle
npm run setup:sdk
npm run setup:plaingen
npm run ci</code></pre>
<p>Each step also runs on its own: <code>npm run extract</code>, <code>map</code>, <code>resolve</code>, <code>emit</code>, <code>rules</code>, <code>type-examples</code>, <code>sdk</code>, <code>fidelity</code>, and <code>site</code>, which builds this site into <code>site/</code>.${repo ? ` The repository's <a href="${esc(repo)}#readme">README</a> describes each command and each gate.` : ""}</p>
</section>
</div>`;
  return page({
    path: "how-it-is-built.html",
    title: "How it's built · OpenProposal 3.0 JSON Schema",
    description: `How ${PUBLISHER} generates the OpenProposal 3.0 schemas from the specification text, and how each step shapes the type map and the downloads.`,
    section: "method",
    body,
  });
}
