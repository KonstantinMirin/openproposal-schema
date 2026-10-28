/**
 * A spec's pages on the site that every spec shares: the type map's shell,
 * the example payloads, the decision records with their index, and the
 * files. Each spec's landing and How it's built pages are its site copy
 * (src/site/copy.ts). Every text is public: it names no internal document or
 * local path, and writes as the publisher, an IAB Tech Lab member.
 */
import { readFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import type { SpecLock } from "../lock.ts";
import { TYPE_EXAMPLES_FILE, typeExamplesDirOf } from "../type-examples.ts";
import type { DecisionRecord } from "../mapping.ts";
import { lockNames, named, type SiteBrand } from "./config.ts";
import { buildOf, decisionNumbers, proposalsSlug, shapedBy, sourceInfos, type SiteInputs, type VariantSlug } from "./data.ts";
import { baseOf, esc, inline, page, prose } from "./html.ts";
import type { SourceInfo } from "./sources.ts";
import { REPO_ROOT } from "../repo.ts";

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

/** The switches' markup, which the pages' scripts wire up. */
export function switches(kind: "map" | "examples", inputs: Pick<SiteInputs, "brand" | "locks" | "variants">): string {
  const locks = inputs.locks.map((l) => `<button type="button" data-lock="${l.name}" aria-pressed="false">${esc(lockNames(inputs.brand, l.name).label)}</button>`).join("");
  const variants = inputs.variants.map((v) => `<button type="button" data-variant="${v.slug}" aria-pressed="false">${esc(v.label)}</button>`).join("");
  // A spec that proposes no change has one variant, the text as written, so it has no variant switch.
  return `<div class="switches" data-for="${kind}"><div class="seg" role="group" aria-label="Input">${locks}</div>${inputs.variants.length > 1 ? `<div class="seg" role="group" aria-label="Variant">${variants}</div>` : ""}</div>`;
}

/** The type map's legend for a spec whose site copy gives none: a line for each layer its default build holds. */
function defaultLegend(inputs: SiteInputs): { explain: string; added: string } {
  const b = inputs.brand;
  const layers = new Set(buildOf(inputs, inputs.locks[0]!.name, "as-written").model.types.map((t) => t.layer));
  const lines: [number, string][] = [
    [1, "<p><b>1 Primitives.</b> One type per concept, grouped by value domain.</p>"],
    [2, "<p><b>2 Constructors and parts.</b> Templates and the parts their copies share. Only the model holds a template; the schema holds its copies.</p>"],
    [3, "<p><b>3 Vocabularies.</b> Value lists. An open one also takes the codes or terms its list reserves for extensions.</p>"],
    [4, "<p><b>4 Objects and unions.</b> The structures built from the layers below.</p>"],
    [5, `<p><b>5 Documents and profiles.</b> ${b.documents.length > 0 ? `${b.documents.map((d) => `<code>${d}</code>`).join(", ")}.` : "What a payload is."}</p>`],
  ];
  const other = inputs.locks.slice(1).map((l) => lockNames(b, l.name).where);
  return { explain: lines.filter(([n]) => layers.has(n)).map(([, l]) => l).join("\n    "), added: other.length > 0 ? `dot: added ${other.join(" or ")}` : "" };
}

/** The type map's shell, with the spec's own legend where its site copy gives one. */
export function mapPage(inputs: SiteInputs, own?: { explain: string; added: string }): string {
  const b = inputs.brand;
  const legend = own ?? defaultLegend(inputs);
  const body = `
<div class="map-head">
  <div>
    <h1>Type map</h1>
    <p class="sub">How the generated types compose, from primitives up to the documents. Select a type to see what it's built from, what uses it, the lines of the specification it rests on, and its schema or an example payload.</p>
  </div>
  <div class="map-controls">
    ${switches("map", inputs)}
    <input type="search" id="q" placeholder="Find a type, then press Enter" aria-label="Find a type">
    <span class="note" id="buildinfo"></span>
  </div>
</div>
<div id="notice" class="notice" role="status" hidden></div>
<noscript><p class="notice">The type map needs JavaScript. The <a href="downloads.html">schema files</a> and the <a href="decisions/index.html">decision records</a> read without it.</p></noscript>
<section class="card legend-card">
  <div class="explain">
    ${legend.explain}
  </div>
  <div class="legend" id="legend"></div>
</section>
<section class="card"><div class="layers" id="layers"><svg class="edges" id="edges" aria-hidden="true"></svg></div>
  <div class="legend"><span class="k-dep">ring: built from</span><span class="k-use">ring: used by</span>${legend.added ? `<span class="k-added" id="addedkey">${legend.added}</span>` : ""}${inputs.variants.length > 1 ? `<span class="k-changed">bar: changed by a proposal</span>` : ""}</div>
</section>
<div class="lower">
  <section class="card tree" aria-labelledby="treeh"><h2 id="treeh">Composition</h2><p class="note">Expand a member to drill down to the primitives. ↻ marks a type already on the path.</p><div id="tree"></div></section>
  <section class="card detail" id="detail" aria-live="polite"></section>
</div>`;
  return page({ path: "map.html", title: `Type map · ${named(b)} JSON Schema`, description: `How the generated ${named(b)} types compose, with their schemas, example payloads, and the specification lines they rest on.`, section: "map", body, scripts: ["assets/route.js", "assets/jsontree.js", "assets/map.js"], bodyClass: "wide", brand: b });
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
  const b = inputs.brand;
  const sections: string[] = [];
  // A spec with no documents, such as a registry of code lists, shows an example of each type of its top layer.
  const top = (lock: SpecLock, slug: VariantSlug) => {
    const types = buildOf(inputs, lock.name, slug).model.types;
    const layer = Math.max(...types.map((x) => x.layer));
    return types.filter((x) => x.layer === layer).map((x) => x.name).sort();
  };
  for (const lock of inputs.locks) {
    for (const v of inputs.variants) {
      const te = JSON.parse(readExamples(inputs, lock, v.slug)) as { types: Record<string, { minimal?: unknown; full: unknown; notes?: { path: string; holds: string; reason: string }[]; illustrative?: { path: string; note: string }[] }> };
      if (b.documents.length === 0) {
        const rows = top(lock, v.slug)
          .filter((name) => te.types[name])
          .map((name) => `<tr><td data-label="Type"><a href="${mapLink("", name, lock.name, v.slug, "example")}"><code>${esc(name)}</code></a></td><td data-label="Example"><code>${esc(JSON.stringify(te.types[name]!.full))}</code></td></tr>`)
          .join("");
        sections.push(`<section class="build" data-lock="${lock.name}" data-variant="${v.slug}"><h2>${esc(lockNames(b, lock.name).label)} · ${esc(v.label)}</h2><table><thead><tr><th>Type</th><th>Example value</th></tr></thead><tbody>${rows}</tbody></table></section>`);
        continue;
      }
      const blocks = b.documents
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
      sections.push(`<section class="build" data-lock="${lock.name}" data-variant="${v.slug}"><h2>${esc(lockNames(b, lock.name).label)} · ${esc(v.label)}</h2>${blocks}</section>`);
    }
  }
  const body = `
<div class="wrap">
  <h1>Example payloads</h1>
  <p class="sub">${b.documents.length > 0 ? `One realistic ${b.documents.map((d) => `<code>${d}</code>`).join(" and one ")} for each build. Each value is the first one the specification's own examples give at that field, where the build's schema accepts it, and else an illustrative value of ours. Every payload is valid against its schema, and breaks no rule that one payload decides.` : "An example value of each type for each build, valid against its schema. Open a type in the type map for its minimal and its full example."}</p>
  ${switches("examples", inputs)}
  ${sections.join("\n")}
</div>`;
  const what = b.documents.length > 0 ? `${b.documents.join(" and ")} payloads` : "values";
  return page({ path: "examples.html", title: `Example payloads · ${named(b)} JSON Schema`, description: `Example ${named(b)} ${what}, ${inputs.variants.length > 1 ? "as written and with our proposals" : "as written"}.`, section: "examples", body, scripts: ["assets/route.js", "assets/examples.js"], brand: b });
}

function readExamples(inputs: SiteInputs, lock: SpecLock, slug: VariantSlug): string {
  const b = inputs.builds.get(lock.name)!.get(slug)!;
  return readFileSync(join(inputs.root, posix.join(b.dirOf(typeExamplesDirOf(lock.ir_dir)), TYPE_EXAMPLES_FILE)), "utf8");
}

/** The decisions in the order the feedback's supporting page lists them, by its groups. */
export function decisionGroups(inputs: SiteInputs): { title: string; asks?: string; decisions: DecisionRecord[] }[] {
  const byId = new Map(inputs.decisions.map((d) => [d.id, d]));
  const proposals = { title: "Changes we propose", asks: "Where the text or its examples settle a point, and we propose to write it differently" };
  // A spec with no feedback yet lists its gaps, then its proposals, each in ID order.
  if (!inputs.feedback) {
    const live = inputs.decisions.filter((d) => d.status !== "superseded");
    return [
      { title: "Points the text leaves open", asks: "Where the text leaves a point open, and a decision fills it", decisions: live.filter((d) => d.kind === "gap") },
      { ...proposals, decisions: live.filter((d) => d.kind === "departure") },
    ].filter((g) => g.decisions.length > 0);
  }
  const groups: { title: string; asks?: string; decisions: DecisionRecord[] }[] = inputs.feedback.groups.map((g) => ({ title: g.title, asks: g.asks, decisions: g.decisions.map((d) => byId.get(d.id)!) }));
  groups.push({ ...proposals, decisions: inputs.feedback.departures.map((d) => byId.get(d.id)!) });
  const listed = new Set(groups.flatMap((g) => g.decisions.map((d) => d.id)));
  const rest = inputs.decisions.filter((d) => !listed.has(d.id));
  if (rest.length > 0) groups.push({ title: "Not in the supporting page", decisions: rest });
  return groups;
}

const kindTag = (d: DecisionRecord) => (d.kind === "gap" ? `<span class="tag gap">Gap</span>` : `<span class="tag prop">Proposal</span>`);

export function decisionsIndex(inputs: SiteInputs): string {
  const b = inputs.brand;
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
<p class="sub">Generating the schemas took ${gaps + departures} recorded decisions: ${gaps} gaps, where the text leaves a point open, and ${departures > 0 ? `${departures} proposals, where we propose a change to what the text or its examples settle` : "no proposal: we propose no change to what the text settles"}. ${b.feedback ? `They are grouped and numbered as on the <a href="${b.feedback.gist}">supporting page</a> of <a href="${b.feedback.issue}">issue #${b.feedback.issueNumber}</a>.` : "Our implementation feedback to the specification's owners will number them; until then they are listed by kind."}</p>
${groups}
</div>`;
  return page({ path: "decisions/index.html", title: `Decision records · ${named(b)} JSON Schema`, description: `The ${gaps + departures} decisions that generating the ${named(b)} schemas took.`, section: "decisions", body, brand: b });
}

export function decisionPage(inputs: SiteInputs, d: DecisionRecord): string {
  const b = inputs.brand;
  const path = `decisions/${d.id}.html`;
  const base = baseOf(path);
  const numbers = decisionNumbers(inputs.feedback);
  const n = numbers.get(d.id);
  const item = inputs.feedback ? [...inputs.feedback.groups.flatMap((g) => g.decisions), ...inputs.feedback.departures].find((x) => x.id === d.id) : undefined;
  const locks = inputs.locks.filter((l) => item?.locks.includes(l.name) ?? d.covers.some((c) => c.locks === undefined || c.locks.includes(l.name)));
  const options = d.options.map((o) => `<li class="${o.id === d.chosen ? "chosen" : ""}"><code>${esc(o.id)}</code>${o.id === d.chosen ? ` <span class="tag">Chosen</span>` : ""}${d.kind === "departure" && inputs.variant?.switches.some((s) => s.decision === d.id && s.option === o.id) ? ` <span class="tag aw">As written</span>` : ""}<p>${inline(o.summary, base)}</p></li>`).join("");
  // The lines it rests on, on each lock that has them.
  const sources = inputs.locks
    .map((lock) => {
      const ids = d.covers.filter((c) => c.locks === undefined || c.locks.includes(lock.name)).map((c) => c.ir);
      const infos = sourceInfos(inputs, lock, ids);
      const items = ids.filter((id) => infos[id]).map((id) => sourceItem(infos[id]!));
      return items.length > 0 ? `<h3>${esc(lockNames(b, lock.name).label)}</h3><ul class="sources">${items.join("")}</ul>` : "";
    })
    .join("");
  const examples = (inputs.feedback?.examples ?? []).filter((x) => x.decisions.includes(d.id));
  const exRows = examples
    .map((x) => `<tr><td data-label="Example"><code>${esc(x.example)}</code></td><td data-label="Where">${x.paths.map((p) => `<code>${esc(p)}</code>`).join("<br>")}</td><td data-label="Why">${inline(x.reason, base)}</td><td data-label="Input">${x.locks.map((l) => esc(lockNames(b, l).short)).join(", ")}</td></tr>`)
    .join("");
  const shaped = locks
    .map((lock) => {
      const s = shapedBy(inputs, lock, d.id);
      const slug = proposalsSlug(inputs);
      const links = [...s.types.map((t) => `<a href="${mapLink(base, t, lock.name, slug)}"><code>${esc(t)}</code></a>`), ...s.members.map((m) => `<a href="${mapLink(base, m.split(".")[0]!, lock.name, slug)}"><code>${esc(m)}</code></a>`)];
      return links.length > 0 ? `<p><strong>${esc(lockNames(b, lock.name).label)}:</strong> ${links.join(", ")}</p>` : "";
    })
    .join("");
  const sw = inputs.variant?.switches.find((s) => s.decision === d.id);
  const repo = b.repo ? `<p class="note"><a href="${b.repo}/blob/main/${relative(REPO_ROOT, d.file).split(sep).join("/")}">The record's YAML file</a></p>` : "";
  const chosen = d.options.find((o) => o.id === d.chosen);
  const body = `<div class="wrap narrow decision">
<p class="crumbs"><a href="index.html">Decision records</a> · ${n ? `${esc(n.group)}` : ""}</p>
<h1><span class="id">${d.id}</span> ${inline(d.question, base)}</h1>
<p class="meta">${kindTag(d)} ${n && b.feedback ? `Decision ${n.number} on the <a href="${b.feedback.gist}">supporting page of #${b.feedback.issueNumber}</a>.` : ""} ${locks.length > 0 ? `Cited ${locks.map((l) => lockNames(b, l.name).where).join(" and ")}.` : ""}</p>
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
  return page({ path, title: `${d.id}: ${d.question.slice(0, 80)} · ${named(b)} JSON Schema`, description: d.question, section: "decisions", body, brand: b });
}

/** One build's files in the public repository, which the files page links in place of downloads. */
export interface FileSet {
  lock: string;
  variant: VariantSlug;
  /** The build's folders and files, by path from the spec's folder: its schema tree, its rules, and its type examples. */
  schemaDir: string;
  rules: string;
  examples: string;
  /** Each schema file of the build, by its path on the site. */
  schemas: string[];
  /** The build's SDK tree, by path from the repository's root, and whether it is the default tree; null for a spec with no SDK types. */
  sdk: { dir: string; default: boolean } | null;
}

/** A link into the public repository at a path from its root, or the path alone when the site names no repository. */
export const repoLink = (b: Pick<SiteBrand, "repo">, kind: "tree" | "blob", path: string, label: string): string =>
  b.repo ? `<a href="${b.repo}/${kind}/main/${path}">${label}</a>` : `${label} (<code>${esc(path)}</code>)`;

/**
 * The files page: where each build's schema files, rules, example payloads,
 * and SDK types are in the public repository, and the schema files this
 * site serves at their paths. The site offers no downloads of its own.
 */
export function filesPage(inputs: SiteInputs, sets: FileSet[]): string {
  const b = inputs.brand;
  const at = (path: string) => posix.join("specs", b.spec, path);
  const cards = sets
    .map((s) => {
      const variant = inputs.variants.find((v) => v.slug === s.variant)!;
      const sdk = s.sdk
        ? `<h3>SDK types <span class="tag">Secondary</span></h3><p class="note">The schemas are the product. These types are generated from the same model, as ${s.sdk.default ? "the default SDK tree" : "an opt-in SDK tree"}, <code>${esc(s.sdk.dir)}/</code>, until a dedicated emitter replaces them.</p><ul class="files">${[["TypeScript", "ts", "Zod 4"], ["Python", "python", "Pydantic 2"], ["Go", "go", "the standard library only"]].map(([label, lang, what]) => `<li>${repoLink(b, "tree", posix.join(s.sdk!.dir, lang!), `${label} types`)} <span class="note">${what}</span></li>`).join("")}</ul>`
        : "";
      return `<section class="card dl"><h2>${esc(lockNames(b, s.lock).label)} · ${esc(variant.label)}</h2>
<ul class="files"><li>${repoLink(b, "tree", at(s.schemaDir), "JSON Schema files")} <span class="note">${s.schemas.length} files, JSON Schema 2020-12${sets.some((o) => o.schemaDir.startsWith(`${s.schemaDir}/`)) ? ", in a folder that also holds the other builds' folders" : ""}</span></li><li>${repoLink(b, "blob", at(s.rules), "Rules")} <span class="note">the rules JSON Schema can't express, with test vectors</span></li><li>${repoLink(b, "blob", at(s.examples), "Example payloads")} <span class="note">an example of every named type</span></li></ul>
${sdk}
<details><summary>Browse the ${s.schemas.length} schema files on this site</summary><ul class="tree-files">${s.schemas.map((p) => `<li><a href="${p}"><code>${esc(p)}</code></a></li>`).join("")}</ul></details></section>`;
    })
    .join("\n");
  const builds = inputs.variants.length > 1 ? "Each build's" : "Each input's";
  const body = `<div class="wrap">
<h1>Files</h1>
<p class="sub">${builds} JSON Schema 2020-12 files, its rules with their test vectors, and its example payloads are in the public repository${b.repo ? `, under ${repoLink(b, "tree", posix.join("specs", b.spec), `<code>specs/${esc(b.spec)}/</code>`)}` : ""}. This site serves each schema file under the spec's path, and every <code>$ref</code> is relative. ${b.schemaBase === `${b.siteUrl}${b.spec}/` ? "Each file's <code>$id</code> is its URL on this site, so a validator resolves every <code>$ref</code> from here." : `Each file's <code>$id</code> still names it under <code>${esc(b.schemaBase)}</code>; the <code>$id</code>s move to this site's paths before the first frozen release.`}</p>
<div class="dl-grid">${cards}</div>
</div>`;
  return page({ path: "downloads.html", title: `Files · ${named(b)} JSON Schema`, description: `Where the generated ${named(b)} JSON Schema files, rules, and example payloads are.`, section: "downloads", body, brand: b });
}
