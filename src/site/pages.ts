/**
 * The site's pages: the landing page, the type map's shell, the example
 * payloads, the decision records with their index, the downloads, and the
 * not-found page. Every text is public: it names no internal document or
 * local path, and writes as the publisher, an IAB Tech Lab member.
 */
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { SpecLock } from "../lock.ts";
import { TYPE_EXAMPLES_FILE, typeExamplesDirOf } from "../type-examples.ts";
import type { DecisionRecord } from "../mapping.ts";
import { GIST_URL, ISSUE_URL, PUBLIC_REPO_URL, PUBLISHER } from "./config.ts";
import { decisionNumbers, shapedBy, sourceInfos, SITE_LOCKS, SITE_VARIANTS, type SiteInputs, type VariantSlug } from "./data.ts";
import { baseOf, esc, inline, page, prose } from "./html.ts";
import type { SourceInfo } from "./sources.ts";

const short = (sha: string) => sha.slice(0, 7);
const commitUrl = (lock: SpecLock, sha: string) => `${lock.upstream}/commit/${sha}`;
const prUrl = (lock: SpecLock, pr: number) => `${lock.upstream}/pull/${pr}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A link into the type map, at a type, on a lock, in a variant, in a view, with the composition's members `open` expanded. */
export const mapLink = (base: string, type: string, lock: string, variant: VariantSlug, view?: "schema" | "example", open?: string[]) =>
  `${base}map.html#!/type/${encodeURIComponent(type)}?lock=${lock}&variant=${variant}&view=${view ?? "schema"}${open && open.length > 0 ? `&open=${open.map(encodeURIComponent).join(",")}` : ""}`;

function counts(inputs: SiteInputs) {
  const gaps = inputs.decisions.filter((d) => d.kind === "gap" && d.status !== "superseded").length;
  const departures = inputs.decisions.filter((d) => d.kind === "departure" && d.status !== "superseded").length;
  return { gaps, departures, total: gaps + departures };
}

/** A spec source as a list item: its label, a link to each run of its lines, and its quote, shown on hover and when expanded. */
export function sourceItem(s: SourceInfo, lockLabel?: string): string {
  const links = s.links.map((l) => `<a href="${esc(l.href)}">${esc(l.text)}</a>`).join(", ");
  return `<li class="src"><details><summary title="${esc(s.quote)}"><span class="src-label">${inline(s.label, "")}</span>${lockLabel ? ` <span class="tag">${esc(lockLabel)}</span>` : ""}${links ? ` <span class="src-links">${links}</span>` : ""}</summary><blockquote>${inline(s.quote, "")}</blockquote>${s.note ? `<p class="note">${esc(s.note)}</p>` : ""}</details></li>`;
}

export function landingPage(inputs: SiteInputs): string {
  const { gaps, departures, total } = counts(inputs);
  const [main, prs] = [inputs.locks.find((l) => l.merge_order === null)!, inputs.locks.find((l) => l.merge_order !== null)];
  const report = inputs.report;
  const ex = (lock: string) => report.locks.find((l) => l.name === lock)!.examples;
  const heads = (prs?.merge_order ?? []) as { pr: number; head: string }[];
  const numbers = decisionNumbers(inputs.feedback);
  const switches = report.switches
    .map((s) => {
      const n = numbers.get(s.decision)?.number;
      return `<tr><td data-label="Record"><a href="decisions/${s.decision}.html">${s.decision}</a>${n ? `<span class="sub">decision ${n}</span>` : ""}</td><td data-label="Question">${inline(s.question, "")}</td><td data-label="As written">${inline(s.written, "")}</td><td data-label="With our proposals">${inline(s.proposed, "")}</td></tr>`;
    })
    .join("\n");
  const edits = prs ? prs.edits.map((e) => `<li>${inline(e, "")}</li>`).join("") : "";
  const body = `
<section class="hero">
  <div class="hero-in">
    <p class="eyebrow">Unofficial · Not an IAB Tech Lab artifact</p>
    <h1>OpenProposal&nbsp;3.0, generated as JSON&nbsp;Schema</h1>
    <p class="lede">An unofficial JSON Schema for OpenProposal 3.0 draft 1, generated from the specification text by ${PUBLISHER}, an IAB Tech Lab member. The specification remains the reference: where this site and the text differ, the text wins.</p>
    <p class="actions"><a class="button primary" href="map.html">Open the type map</a><a class="button" href="how-it-is-built.html">How it's built</a><a class="button" href="downloads.html">Download the schemas</a><a class="button" href="decisions/index.html">Read the decisions</a></p>
  </div>
</section>

<section class="band">
  <div class="wrap">
    <h2>What generating it took</h2>
    <p>The schema files are generated. A pipeline reads the specification's markdown and, through a mapping of every field, row, and statement to a type, generates the JSON Schema 2020-12 files, the rules that JSON Schema can't express, and TypeScript, Python, and Go types. The mapping and the ${total} decisions are recorded by hand, each with the specification lines it rests on. <a href="how-it-is-built.html">How it's built</a> explains each step. Generating a schema means settling every point a schema needs, and the text doesn't settle all of them. It took ${total} recorded decisions:</p>
    <div class="stats">
      <div class="stat gap"><span class="num">${gaps}</span><span class="what">open points filled</span><span class="why">Where the text leaves a point open, a decision fills it. We call these gaps, and both variants fill them the same way.</span></div>
      <div class="stat prop"><span class="num">${departures}</span><span class="what">changes we propose</span><span class="why">Where the text or its examples settle a point, and we would write it differently. You can switch these off.</span></div>
      <div class="stat ex"><span class="num">${ex("main").variant.places}<span class="vs">/</span>${ex("main").proposed.places}</span><span class="what">places the examples fail on main</span><span class="why">The specification's own examples fail in ${plural(ex("main").variant.places, "distinct place")} as written, and in ${ex("main").proposed.places} with our proposals, which they predate.${prs ? ` With the open PRs, in ${ex(prs.name).variant.places} and ${ex(prs.name).proposed.places}.` : ""}</span></div>
    </div>
    <p>We describe each decision, and what we ask the specification to state, in our implementation feedback on <a href="${ISSUE_URL}">IABTechLab/OpenProposal#121</a> and its <a href="${GIST_URL}">supporting page</a>. Each decision also has its own page here.</p>
  </div>
</section>

<section class="wrap two">
  <div>
    <h2>How to read the two switches</h2>
    <p>The type map, the examples, and the downloads each have two switches. Together they pick one of four builds of the schemas.</p>
    <div class="switch-card">
      <h3><span class="seg-mock"><span class="on">main</span><span>With the open PRs</span></span> Input</h3>
      <p><strong>main</strong> is the specification on its <code>main</code> branch at commit <a href="${commitUrl(main, main.commit)}"><code>${short(main.commit)}</code></a>.</p>
      ${prs ? `<p><strong>With the open PRs</strong> is <code>main</code> with the ${heads.length} pull requests that were open on ${esc(prs.heads_on ?? "")} merged in, each at its head that day. We merged them ourselves, so the result exists on no branch upstream.</p>` : ""}
    </div>
    <div class="switch-card">
      <h3><span class="seg-mock"><span class="on">As written</span><span>With our proposals</span></span> Variant</h3>
      <p><strong>As written</strong> switches our ${departures} proposals off. Each field they change takes the form the text or its examples write, such as any string for an ID and the integers <code>0</code> and <code>1</code> for AdCOM's flags.</p>
      <p><strong>With our proposals</strong> switches them on. In both variants, the ${gaps} open points stay filled by their decisions, since the text gives nothing to fall back to.</p>
    </div>
  </div>
  <div>
    <h2>What a decision record is</h2>
    <p>A decision record is a judgment we recorded wherever the specification leaves a point open, or where we propose a change. Each record has:</p>
    <ul class="ticks">
      <li>the question it answers, and the options we weighed;</li>
      <li>the answer we chose, and why;</li>
      <li>the specification lines it rests on, quoted and pinned, so the record goes stale when those lines change;</li>
      <li>what we ask the specification to state, so that the next revision needs no such record.</li>
    </ul>
    <p>The type map links every type to the records that shape it, and every record to the lines it quotes.</p>
    <h2>Inputs</h2>
    <p>Specification: <a href="${main.upstream}">${esc(main.upstream.replace("https://github.com/", ""))}</a>, <code>${esc(main.path)}</code>.</p>
    ${prs ? `<p class="note">The open PRs, in the order we merged them, each with its head:</p><ul class="heads">${heads.map((h) => `<li><a href="${prUrl(prs, h.pr)}">#${h.pr}</a> <a href="${commitUrl(prs, h.head)}"><code>${short(h.head)}</code></a></li>`).join("")}</ul>${edits ? `<p class="note">Beside resolving conflicts, the merge made these edits:</p><ul class="note">${edits}</ul>` : ""}` : ""}
  </div>
</section>

<section class="band">
  <div class="wrap">
    <h2>The ${departures} changes we propose</h2>
    <p>Each row is one proposal, and what the as-written variant takes instead.</p>
    <div class="scroll"><table class="props">
      <thead><tr><th>Record</th><th>Question</th><th>As written</th><th>With our proposals</th></tr></thead>
      <tbody>${switches}</tbody>
    </table></div>
    <p>The examples fail less as written because they follow the text: on <code>main</code>, they fail in ${plural(ex("main").variant.places, "distinct place")} as written against ${ex("main").proposed.places}${prs ? `, and with the open PRs, in ${ex(prs.name).variant.places} against ${ex(prs.name).proposed.places}` : ""}. What still fails as written is where the examples disagree with the text, and the option names that the text gives no member for.</p>
  </div>
</section>
`;
  return page({ path: "index.html", title: "OpenProposal 3.0 JSON Schema, unofficial", description: `An unofficial JSON Schema for OpenProposal 3.0 draft 1, generated from the specification text by ${PUBLISHER}, an IAB Tech Lab member.`, section: "home", body });
}

/** The switches' markup, which the pages' scripts wire up. */
export function switches(kind: "map" | "examples"): string {
  const locks = Object.entries(SITE_LOCKS).map(([k, v]) => `<button type="button" data-lock="${k}" aria-pressed="false">${esc(v.label)}</button>`).join("");
  const variants = SITE_VARIANTS.map((v) => `<button type="button" data-variant="${v.slug}" aria-pressed="false">${esc(v.label)}</button>`).join("");
  return `<div class="switches" data-for="${kind}"><div class="seg" role="group" aria-label="Input">${locks}</div><div class="seg" role="group" aria-label="Variant">${variants}</div></div>`;
}

export function mapPage(): string {
  const body = `
<div class="map-head">
  <div>
    <h1>Type map</h1>
    <p class="sub">How the generated types compose, from primitives up to the documents. Select a type to see what it's built from, what uses it, the lines of the specification it rests on, and its schema or an example payload.</p>
  </div>
  <div class="map-controls">
    ${switches("map")}
    <input type="search" id="q" placeholder="Find a type, then press Enter" aria-label="Find a type">
    <span class="note" id="buildinfo"></span>
  </div>
</div>
<div id="notice" class="notice" role="status" hidden></div>
<noscript><p class="notice">The type map needs JavaScript. The <a href="downloads.html">schema files</a> and the <a href="decisions/index.html">decision records</a> read without it.</p></noscript>
<section class="card legend-card">
  <div class="explain">
    <p><b>1 Primitives.</b> One type per concept, grouped by value domain.</p>
    <p><b>2 Constructors and parts.</b> Templates such as <code>Selectable&lt;T&gt;</code>. Only the model holds them; the schema holds their copies.</p>
    <p><b>Copies</b> (dashed) are a template applied to arguments, written out as a plain schema.</p>
    <p><b>3 Vocabularies.</b> Value lists. An open one also takes a namespaced term.</p>
    <p><b>4 Objects and unions.</b> The structures built from the layers below.</p>
    <p><b>5 Documents and profiles.</b> <code>Proposal</code>, <code>LineItem</code>, and the summaries projected from them.</p>
  </div>
  <div class="legend" id="legend"></div>
</section>
<section class="card"><div class="layers" id="layers"><svg class="edges" id="edges" aria-hidden="true"></svg></div>
  <div class="legend"><span class="k-dep">ring: built from</span><span class="k-use">ring: used by</span><span class="k-added" id="addedkey">dot: added by the open PRs</span><span class="k-changed">bar: changed by a proposal</span></div>
</section>
<div class="lower">
  <section class="card tree" aria-labelledby="treeh"><h2 id="treeh">Composition</h2><p class="note">Expand a member to drill down to the primitives. ↻ marks a type already on the path.</p><div id="tree"></div></section>
  <section class="card detail" id="detail" aria-live="polite"></section>
</div>`;
  return page({ path: "map.html", title: "Type map · OpenProposal 3.0 JSON Schema", description: "How the generated OpenProposal 3.0 types compose, with their schemas, example payloads, and the specification lines they rest on.", section: "map", body, scripts: ["assets/route.js", "assets/jsontree.js", "assets/map.js"], bodyClass: "wide" });
}

/** A JSON value as nested, collapsible markup, open to `depth` levels, for a page that reads without a script. */
function jsonHtml(v: unknown, depth: number, open: number): string {
  if (v === null || typeof v !== "object") return `<span class="j-${v === null ? "null" : typeof v}">${esc(JSON.stringify(v))}</span>`;
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v);
  const [o, c] = Array.isArray(v) ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) return `<span class="j-punct">${o}${c}</span>`;
  const items = entries.map(([k, x]) => `<li>${Array.isArray(v) ? "" : `<span class="j-key">${esc(JSON.stringify(k))}</span><span class="j-punct">: </span>`}${jsonHtml(x, depth + 1, open)}</li>`).join("");
  return `<details class="j-node"${depth < open ? " open" : ""}><summary><span class="j-punct">${o}</span><span class="j-count">${plural(entries.length, Array.isArray(v) ? "item" : "member")}</span></summary><ul>${items}</ul><span class="j-punct">${c}</span></details>`;
}

export function examplesPage(inputs: SiteInputs): string {
  const sections: string[] = [];
  for (const lock of inputs.locks) {
    for (const v of SITE_VARIANTS) {
      const te = JSON.parse(readExamples(inputs, lock, v.slug)) as { types: Record<string, { full: unknown; notes?: { path: string; holds: string; reason: string }[]; illustrative?: { path: string; note: string }[] }> };
      const blocks = ["Proposal", "LineItem"]
        .map((name) => {
          const x = te.types[name];
          if (!x) return "";
          const notes = (x.notes ?? []).map((n) => `<li><code>${esc(n.path)}</code> ${n.holds === "omitted" ? "is left out" : "holds its minimal value"}: ${inline(n.reason, "")}</li>`).join("");
          const ill = (x.illustrative ?? []).map((n) => `<li><code>${esc(n.path)}</code>: ${inline(n.note, "")}</li>`).join("");
          return `<article class="card example"><header class="example-head"><h3><code>${name}</code></h3><a href="${mapLink("", name, lock.name, v.slug, "example")}">Open in the type map</a></header>
<div class="jsontree static">${jsonHtml(x.full, 0, 2)}</div>
${notes ? `<p class="note">Where the example holds less than every member:</p><ul class="notes">${notes}</ul>` : ""}${ill ? `<p class="note">Illustrative values, ours and not the specification's:</p><ul class="notes">${ill}</ul>` : ""}</article>`;
        })
        .join("\n");
      sections.push(`<section class="build" data-lock="${lock.name}" data-variant="${v.slug}"><h2>${esc(SITE_LOCKS[lock.name]!.label)} · ${esc(v.label)}</h2>${blocks}</section>`);
    }
  }
  const body = `
<div class="wrap">
  <h1>Example payloads</h1>
  <p class="sub">One realistic <code>Proposal</code> and one <code>LineItem</code> for each build. Each value is the first one the specification's own examples give at that field, where the build's schema accepts it, and else an illustrative value of ours. Every payload is valid against its schema, and breaks no rule that one payload decides.</p>
  ${switches("examples")}
  ${sections.join("\n")}
</div>`;
  return page({ path: "examples.html", title: "Example payloads · OpenProposal 3.0 JSON Schema", description: "Example OpenProposal 3.0 Proposal and LineItem payloads, as written and with our proposals.", section: "examples", body, scripts: ["assets/route.js", "assets/examples.js"] });
}

function readExamples(inputs: SiteInputs, lock: SpecLock, slug: VariantSlug): string {
  const b = inputs.builds.get(lock.name)!.get(slug)!;
  return readFileSync(join(inputs.root, posix.join(b.dirOf(typeExamplesDirOf(lock.ir_dir)), TYPE_EXAMPLES_FILE)), "utf8");
}

/** The decisions in the order the supporting page of #121 lists them, by its groups. */
export function decisionGroups(inputs: SiteInputs): { title: string; asks?: string; decisions: DecisionRecord[] }[] {
  const byId = new Map(inputs.decisions.map((d) => [d.id, d]));
  const groups: { title: string; asks?: string; decisions: DecisionRecord[] }[] = inputs.feedback.groups.map((g) => ({ title: g.title, asks: g.asks, decisions: g.decisions.map((d) => byId.get(d.id)!) }));
  groups.push({ title: "Changes we propose", asks: "Where the text or its examples settle a point, and we propose to write it differently", decisions: inputs.feedback.departures.map((d) => byId.get(d.id)!) });
  const listed = new Set(groups.flatMap((g) => g.decisions.map((d) => d.id)));
  const rest = inputs.decisions.filter((d) => !listed.has(d.id));
  if (rest.length > 0) groups.push({ title: "Not in the supporting page", decisions: rest });
  return groups;
}

const kindTag = (d: DecisionRecord) => (d.kind === "gap" ? `<span class="tag gap">Gap</span>` : `<span class="tag prop">Proposal</span>`);

export function decisionsIndex(inputs: SiteInputs): string {
  const numbers = decisionNumbers(inputs.feedback);
  const { gaps, departures } = counts(inputs);
  const groups = decisionGroups(inputs)
    .map(
      (g) => `<section class="group"><h2>${esc(g.title)} <span class="count">${g.decisions.length}</span></h2>${g.asks ? `<p class="sub">${esc(g.asks)}.</p>` : ""}
<ol class="decisions">${g.decisions
        .map((d) => {
          const n = numbers.get(d.id)?.number;
          return `<li><a href="${d.id}.html"><span class="num">${n ?? "·"}</span><span class="id">${d.id}</span><span class="q">${inline(d.question, "../").replace(/<a [^>]*>([^<]*)<\/a>/g, "$1")}</span>${kindTag(d)}</a></li>`;
        })
        .join("")}</ol></section>`,
    )
    .join("\n");
  const body = `<div class="wrap narrow">
<h1>Decision records</h1>
<p class="sub">Generating the schemas took ${gaps + departures} recorded decisions: ${gaps} gaps, where the text leaves a point open, and ${departures} proposals, where we propose a change to what the text or its examples settle. They are grouped and numbered as on the <a href="${GIST_URL}">supporting page</a> of <a href="${ISSUE_URL}">issue #121</a>.</p>
${groups}
</div>`;
  return page({ path: "decisions/index.html", title: "Decision records · OpenProposal 3.0 JSON Schema", description: `The ${gaps + departures} decisions that generating the OpenProposal 3.0 schemas took.`, section: "decisions", body });
}

export function decisionPage(inputs: SiteInputs, d: DecisionRecord): string {
  const path = `decisions/${d.id}.html`;
  const base = baseOf(path);
  const numbers = decisionNumbers(inputs.feedback);
  const n = numbers.get(d.id);
  const item = [...inputs.feedback.groups.flatMap((g) => g.decisions), ...inputs.feedback.departures].find((x) => x.id === d.id);
  const locks = inputs.locks.filter((l) => item?.locks.includes(l.name) ?? d.covers.some((c) => c.locks === undefined || c.locks.includes(l.name)));
  const options = d.options.map((o) => `<li class="${o.id === d.chosen ? "chosen" : ""}"><code>${esc(o.id)}</code>${o.id === d.chosen ? ` <span class="tag">Chosen</span>` : ""}${d.kind === "departure" && inputs.variant.switches.some((s) => s.decision === d.id && s.option === o.id) ? ` <span class="tag aw">As written</span>` : ""}<p>${inline(o.summary, base)}</p></li>`).join("");
  // The lines it rests on, on each lock that has them.
  const sources = inputs.locks
    .map((lock) => {
      const ids = d.covers.filter((c) => c.locks === undefined || c.locks.includes(lock.name)).map((c) => c.ir);
      const infos = sourceInfos(inputs, lock, ids);
      const items = ids.filter((id) => infos[id]).map((id) => sourceItem(infos[id]!));
      return items.length > 0 ? `<h3>${esc(SITE_LOCKS[lock.name]!.label)}</h3><ul class="sources">${items.join("")}</ul>` : "";
    })
    .join("");
  const examples = inputs.feedback.examples.filter((x) => x.decisions.includes(d.id));
  const exRows = examples
    .map((x) => `<tr><td data-label="Example"><code>${esc(x.example)}</code></td><td data-label="Where">${x.paths.map((p) => `<code>${esc(p)}</code>`).join("<br>")}</td><td data-label="Why">${inline(x.reason, base)}</td><td data-label="Input">${x.locks.map((l) => esc(SITE_LOCKS[l]?.short ?? l)).join(", ")}</td></tr>`)
    .join("");
  const shaped = locks
    .map((lock) => {
      const s = shapedBy(inputs, lock, d.id);
      const links = [...s.types.map((t) => `<a href="${mapLink(base, t, lock.name, "proposals")}"><code>${esc(t)}</code></a>`), ...s.members.map((m) => `<a href="${mapLink(base, m.split(".")[0]!, lock.name, "proposals")}"><code>${esc(m)}</code></a>`)];
      return links.length > 0 ? `<p><strong>${esc(SITE_LOCKS[lock.name]!.label)}:</strong> ${links.join(", ")}</p>` : "";
    })
    .join("");
  const sw = inputs.variant.switches.find((s) => s.decision === d.id);
  const repo = PUBLIC_REPO_URL ? `<p class="note"><a href="${PUBLIC_REPO_URL}/blob/main/decisions/${d.id}.yaml">The record's YAML file</a></p>` : "";
  const chosen = d.options.find((o) => o.id === d.chosen);
  const body = `<div class="wrap narrow decision">
<p class="crumbs"><a href="index.html">Decision records</a> · ${n ? `${esc(n.group)}` : ""}</p>
<h1><span class="id">${d.id}</span> ${inline(d.question, base)}</h1>
<p class="meta">${kindTag(d)} ${n ? `Decision ${n.number} on the <a href="${GIST_URL}">supporting page of #121</a>.` : ""} ${locks.length > 0 ? `Cited ${locks.map((l) => (l.merge_order === null ? "on main" : "with the open PRs")).join(" and ")}.` : ""}</p>
<section><h2>${d.kind === "gap" ? "What the schemas do" : "What we propose"}</h2>${chosen ? `<p class="answer">${inline(chosen.summary, base)}</p>` : ""}</section>
${sw ? `<section><h2>As written</h2><p>${inline(sw.reads, base)}</p><p class="note">The as-written variant takes the option <code>${esc(sw.option)}</code>. Switch the type map to <em>As written</em> to see it.</p></section>` : ""}
<section><h2>Options</h2><ul class="options">${options}</ul></section>
<section><h2>Why</h2>${prose(d.rationale, base)}</section>
${d.feedback ? `<section><h2>${d.kind === "gap" ? "What we ask the specification to state" : "What we ask the specification to change"}</h2>${prose(d.feedback, base)}</section>` : ""}
<section><h2>The specification lines it rests on</h2><p class="note">Each line is quoted as the record pins it. Expand an item to read the quote.</p>${sources}</section>
${examples.length > 0 ? `<section><h2>${d.kind === "gap" ? "Examples that disagree with the text" : "Examples that follow the text, not this change"}</h2><div class="scroll"><table><thead><tr><th>Example</th><th>Where</th><th>Why</th><th>Input</th></tr></thead><tbody>${exRows}</tbody></table></div></section>` : ""}
${shaped ? `<section><h2>What it shapes</h2>${shaped}</section>` : ""}
${repo}
</div>`;
  return page({ path, title: `${d.id}: ${d.question.slice(0, 80)} · OpenProposal 3.0 JSON Schema`, description: d.question, section: "decisions", body });
}

export interface DownloadSet {
  lock: string;
  variant: VariantSlug;
  files: { label: string; path: string; bytes: number; what: string }[];
  schemas: string[];
}

export function downloadsPage(sets: DownloadSet[]): string {
  const kb = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);
  const cards = sets
    .map(
      (s) => `<section class="card dl"><h2>${esc(SITE_LOCKS[s.lock]!.label)} · ${esc(SITE_VARIANTS.find((v) => v.slug === s.variant)!.label)}</h2>
<ul class="files">${s.files.map((f) => `<li><a href="${f.path}" download>${esc(f.label)}</a> <span class="note">${kb(f.bytes)} · ${esc(f.what)}</span></li>`).join("")}</ul>
<details><summary>Browse the ${s.schemas.length} schema files</summary><ul class="tree-files">${s.schemas.map((p) => `<li><a href="${p}"><code>${esc(p)}</code></a></li>`).join("")}</ul></details></section>`,
    )
    .join("\n");
  const body = `<div class="wrap">
<h1>Downloads</h1>
<p class="sub">Each build's JSON Schema 2020-12 files, its rules with their test vectors, and its generated TypeScript (Zod), Python (Pydantic), and Go types. Each schema file is served at the URL its <code>$id</code> names, so a validator can resolve every <code>$ref</code> from this site.</p>
<div class="dl-grid">${cards}</div>
</div>`;
  return page({ path: "downloads.html", title: "Downloads · OpenProposal 3.0 JSON Schema", description: "The generated OpenProposal 3.0 JSON Schema files, rules, and TypeScript, Python, and Go types.", section: "downloads", body });
}

export function notFoundPage(): string {
  const body = `<div class="wrap narrow"><h1>Page not found</h1><p>This address names no page of the site. Start from the <a href="/index.html">overview</a>, or open the <a href="/map.html">type map</a>.</p></div>`;
  // The server sends this page for any missing path, so its links start at the root.
  return page({ path: "404.html", title: "Page not found · OpenProposal 3.0 JSON Schema", description: "Page not found.", section: "none", body, base: "/" });
}
