/**
 * The Deals API's own pages on the public site (src/site/copy.ts): the
 * landing page, which says what the schemas cover and leave out, what
 * generating them took, the two switches, and the inputs; and How it's
 * built, which follows `sellerstatus` from its row to its schema and its
 * example value. The counts, the documents, the registry's lists, the
 * worked example's quote, schema, and example value, and the switches are
 * read from the build; the prose that describes the text's own features,
 * such as its two inputs' difference, is written here and cites the
 * decision record that states it.
 */
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { schemaDirOf } from "../../emit.ts";
import { indexElements } from "../../elements.ts";
import type { SpecLock } from "../../lock.ts";
import { stands } from "../../mapping.ts";
import { loadProfile } from "../../profile.ts";
import { TYPE_EXAMPLES_FILE, typeExamplesDirOf, type TypeExamplesDoc } from "../../type-examples.ts";
import { lockNames, named } from "../../site/config.ts";
import type { SiteCopy } from "../../site/copy.ts";
import { buildOf, sourceInfos, type SiteInputs } from "../../site/data.ts";
import { esc, inline, page } from "../../site/html.ts";
import { DESIGN_NOTES_TOC, designNotes, pipelineFigure } from "../../site/method.ts";
import { repoLink } from "../../site/pages.ts";
import { mapLink } from "../../site/route.ts";

const short = (sha: string) => sha.slice(0, 7);
const commitUrl = (lock: SpecLock) => `${lock.upstream}/commit/${lock.commit}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const json = (v: unknown) => `<pre class="code"><code>${esc(JSON.stringify(v, null, 2))}</code></pre>`;
const dec = (id: string) => `<a href="decisions/${id}.html">${id}</a>`;

/** What the schemas hold on the default lock, read from its IR and its model as written. */
function facts(inputs: SiteInputs) {
  const lock = inputs.locks[0]!;
  const ir = inputs.irs.get(lock.name)!;
  const model = buildOf(inputs, lock.name, "as-written").model;
  const live = inputs.decisions.filter((d) => stands(d));
  const own = model.types.filter((t) => t.kind === "vocabulary" && t.list === undefined);
  const registry = model.types.filter((t) => t.kind === "vocabulary" && t.list?.registry !== undefined);
  return {
    lock,
    ir,
    model,
    // The documents in the order the profile names them, the push body first.
    documents: (loadProfile(inputs.root).documents ?? []).map((d) => d.document),
    objects: model.types.filter((t) => t.kind === "object").map((t) => t.name),
    own: own.length,
    registry: registry.map((t) => t.name),
    rules: model.rules.length,
    obligations: model.obligations.length,
    examples: model.examples.length,
    gaps: live.filter((d) => d.kind === "gap").length,
    departures: live.filter((d) => d.kind === "departure").length,
  };
}

function landingPage(inputs: SiteInputs): string {
  const b = inputs.brand;
  const f = facts(inputs);
  const [main, ...rest] = inputs.locks;
  const report = inputs.report;
  const ex = report?.locks.find((l) => l.name === main!.name)?.examples;
  const m = (type: string) => mapLink("", type, main!.name, "as-written");
  const t = (type: string) => `<a href="${m(type)}"><code>${esc(type)}</code></a>`;
  const switches = (report?.switches ?? [])
    .map((s) => `<tr><td data-label="Record"><a href="decisions/${s.decision}.html">${s.decision}</a></td><td data-label="Question">${inline(s.question, "")}</td><td data-label="As written">${inline(s.written, "")}</td><td data-label="With our proposals">${inline(s.proposed, "")}</td></tr>`)
    .join("\n");
  const body = `
<section class="hero">
  <div class="hero-in">
    <p class="eyebrow">Unofficial · Not an IAB Tech Lab artifact</p>
    <h1>${b.short}&nbsp;${b.edition}, generated as JSON&nbsp;Schema</h1>
    <p class="lede">An unofficial JSON Schema for ${named(b)}, the Deal Sync API, ${b.release}, generated from the specification text by ${b.publisher}, an IAB Tech Lab member. The specification remains the reference: where this site and the text differ, the text wins.</p>
    <p class="actions"><a class="button primary" href="map.html">Open the type map</a><a class="button" href="how-it-is-built.html">How it's built</a><a class="button" href="downloads.html">Get the schema files</a><a class="button" href="decisions/index.html">Read the decisions</a></p>
  </div>
</section>

<section class="band">
  <div class="wrap">
    <h2>What generating it took</h2>
    <p>A pipeline reads the specification's markdown and, through a mapping of every attribute row, code list, and statement to a type, generates the JSON Schema 2020-12 files and the rules JSON Schema can't express, each with test vectors. The mapping and the ${f.gaps + f.departures} decisions are recorded by hand, each with the lines of the text it rests on. <a href="how-it-is-built.html">How it's built</a> explains each step.</p>
    <div class="stats">
      <div class="stat gap"><span class="num">${f.gaps}</span><span class="what">open points filled</span><span class="why">Where the text leaves a point open, a decision fills it, the same way in both variants: how a timestamp is written, what <code>recommended</code> asks, which field "Price attribute" names.</span></div>
      <div class="stat prop"><span class="num">${f.departures}</span><span class="what">${f.departures === 1 ? "change we propose" : "changes we propose"}</span><span class="why">Where the text settles a point and we would write it differently. You can switch ${f.departures === 1 ? "it" : "them"} off.</span></div>
      <div class="stat ex"><span class="num">${f.examples}</span><span class="what">example rows checked</span><span class="why">The Example Scenarios table's rows are parts of a deal, and ${ex && ex.variant.places === 0 && ex.proposed.places === 0 ? "every one validates in both variants" : `they fail in ${plural(ex?.variant.places ?? 0, "place")} as written and in ${plural(ex?.proposed.places ?? 0, "place")} with our proposals`}.</span></div>
    </div>
  </div>
</section>

<section class="wrap two">
  <div>
    <h2>What the schemas cover</h2>
    <p>Two documents: ${t(f.documents[0]!)}, the push body, and ${t(f.documents[1]!)}, the status response. Each other object an attribute holds is a closed object of its own, ${f.objects.map(t).join(", ")}, and every object's <code>ext</code> is ${t("Ext")}, open to the parties' extensions (${dec("D-021")}). The text's own code lists are ${plural(f.own, "vocabulary", "vocabularies")}, each code with the label the text gives it, and ${f.registry.map(t).join(" and ")} take AdCOM 1.0's lists from <a href="../adcom/registry.html">the registry on this site</a>, at the commit it pins (${dec("D-027")}).</p>
    <h2>What they leave out</h2>
    <p>The text defines no paths, no request body for the status call, no response codes, and no authorization, so there is no OpenAPI here: the schemas cover the two payloads (${dec("D-025")}). Duties that no payload shows, such as a buyer validating bid requests against the deal, are ${plural(f.obligations, "obligation")} of the party they name, not schema keywords.</p>
  </div>
  <div>
    <h2>How to read the two switches</h2>
    <div class="switch-card">
      <h3><span class="seg-mock"><span class="on">main</span><span>${esc(rest[0] ? lockNames(b, rest[0].name).label : "")}</span></span> Input</h3>
      <p><strong>main</strong> is the text on the Deals API's <code>main</code> branch at <a href="${commitUrl(main!)}"><code>${short(main!.commit)}</code></a>, with the errata applied after the tag.</p>
      ${rest.map((l) => `<p><strong>${esc(lockNames(b, l.name).label)}</strong> is the text at <a href="${commitUrl(l)}"><code>${short(l.commit)}</code></a>, where <code>sellerstatus</code> gives the code 4 twice (${dec("D-010")}).</p>`).join("")}
    </div>
    <div class="switch-card">
      <h3><span class="seg-mock"><span class="on">As written</span><span>With our proposals</span></span> Variant</h3>
      <p><strong>As written</strong> switches ${f.departures === 1 ? "our proposal" : `our ${f.departures} proposals`} off, so each field ${f.departures === 1 ? "it changes" : "they change"} takes the form the text writes. <strong>With our proposals</strong> switches ${f.departures === 1 ? "it" : "them"} on. In both, the ${f.gaps} open points stay filled by their decisions.</p>
    </div>
  </div>
</section>

<section class="band">
  <div class="wrap">
    <h2>The ${f.departures === 1 ? "change" : `${f.departures} changes`} we propose</h2>
    <p>Each row is one proposal, and what the as-written variant takes instead.</p>
    <table class="props">
      <thead><tr><th>Record</th><th>Question</th><th>As written</th><th>With our proposals</th></tr></thead>
      <tbody>${switches}</tbody>
    </table>
    <h2>Inputs</h2>
    <p>Specification: <a href="${main!.upstream}">${esc(main!.upstream.replace("https://github.com/", ""))}</a>, <code>${esc(main!.path)}</code>. The two inputs differ in one code list, <code>sellerstatus</code>, and in a spelling. ${repoLink(b, "blob", `specs/${b.spec}/comparison/${rest[0]?.name ?? "main"}.md`, "Read the lock comparison")}, which classes each schema change as breaking, additive, or an annotation.</p>
  </div>
</section>
`;
  return page({ path: "index.html", title: `${named(b)} JSON Schema, unofficial`, description: `An unofficial JSON Schema for ${named(b)}, the Deal Sync API, generated from the specification text by ${b.publisher}, an IAB Tech Lab member.`, section: "home", body, brand: b });
}

function methodPage(inputs: SiteInputs): string {
  const b = inputs.brand;
  const f = facts(inputs);
  const lock = f.lock;
  const build = buildOf(inputs, lock.name, "as-written");
  const counts = f.ir.counts as Record<string, number>;
  let byRule = 0;
  let byDecision = 0;
  for (const mf of inputs.mappings) for (const e of mf.entries) ("rule" in (e.source as object) ? byRule++ : byDecision++);
  // The worked example: `sellerstatus`, its row, its vocabulary, the vocabulary's schema, and its example value.
  const row = f.ir.fields.find((x) => x.id === "field:object-deal:sellerstatus")!;
  const element = indexElements(f.ir).get(row.id)!;
  const info = sourceInfos(inputs, lock, [row.id])[row.id]!;
  const vocab = build.model.types.find((x) => x.kind === "vocabulary" && x.sources.some((s) => s.startsWith(`${row.id}#`)))!;
  const schemaDir = build.dirOf(schemaDirOf(lock.ir_dir));
  const file = posix.join(schemaDir, "modules", vocab.module, "1", `${vocab.module}.json`);
  const emitted = (JSON.parse(readFileSync(join(inputs.root, file), "utf8")) as { $defs: Record<string, unknown> }).$defs[vocab.name];
  const te = JSON.parse(readFileSync(join(inputs.root, build.dirOf(typeExamplesDirOf(lock.ir_dir)), TYPE_EXAMPLES_FILE), "utf8")) as TypeExamplesDoc;
  const example = (te.types[vocab.name] as { full: unknown }).full;
  const m = (type: string, view?: "schema" | "example") => mapLink("", type, lock.name, "as-written", view);
  const t = (type: string) => `<a href="${m(type)}"><code>${esc(type)}</code></a>`;
  const specLink = info.links[0];
  const tag = inputs.locks[1];
  const toc: [string, string][] = [
    ["pipeline", "The pipeline"],
    ["extraction", "Extraction"],
    ["mapping", "Mapping and decisions"],
    ["emission", "What a row becomes"],
    ["verification", "Verification"],
    ["inputs", "The two inputs"],
    ["example", "One attribute, end to end"],
    DESIGN_NOTES_TOC,
    ["reproduce", "How to reproduce it"],
  ];
  const body = `<div class="wrap method">
<h1>How it's built</h1>
<p class="lede">${b.publisher}, an IAB Tech Lab member, generates these schemas from the ${named(b)} specification text. Nobody writes a schema file by hand. Every schema is a function of two things: the specification at a pinned commit, and a mapping and a set of decision records that we review by hand. This page explains each step for the Deals API, and what it shapes in the <a href="map.html">type map</a> and the <a href="downloads.html">files</a>.</p>
<nav class="toc" aria-label="On this page"><p class="note">On this page</p><ol>${toc.map(([id, label]) => `<li><a href="#${id}">${label}</a></li>`).join("")}</ol></nav>

<section id="pipeline">
<h2>The pipeline</h2>
<p>The same pipeline generates every specification on this site. The ${b.short} has no SDK types yet, since the schemas come first.</p>
${pipelineFigure()}
</section>

<section id="extraction">
<h2>Extraction</h2>
<p>The text writes each object as an <code>Attribute | Type | Description</code> table under a heading <code>Object: Deal</code>, and every section heading of the body follows an anchor, such as <code>object-deal</code>, which is the section's ID. A Type cell states the base type and, after it, the presence and the default, as <code>int, default 0, recommended</code>. A Description cell lists a code's meanings as <code>n = label</code> runs, most of them with the code in a code span. The text adopts no RFC 2119 convention and writes its keywords in lowercase, so a keyword in any case makes a statement (${dec("D-001")}).</p>
<p>On <code>${esc(lock.name)}</code>, the IR holds ${counts.fields} attribute rows in ${counts.tables} tables, ${counts.value_lists} code lists, and ${counts.statements} statements. Each element has an ID, such as <code>${esc(row.id)}</code>: an attribute row (<code>field</code>) in the section <code>object-deal</code>.</p>
</section>

<section id="mapping">
<h2>Mapping and decisions</h2>
<p>Every element has exactly one entry in the mapping, on each input. Of the ${byRule + byDecision} entries across both inputs, ${byRule} come from mapping rules and ${byDecision} cite a decision record.</p>
<ul>
<li><strong>An object no attribute holds is a document.</strong> <code>Object: Deal</code> and <code>Object: BuyerSeat</code> are the two payloads; <code>terms</code> holds <code>Object: Terms</code>, so Terms is an object, named by its heading.</li>
<li><strong>A row's concept types it.</strong> The kernel binding cites each row for a concept of the domain model, and the concept's type is the row's: an identifier is ${t("ExternalId")}, a domain ${t("Domain")}, a UTC timestamp ${t("UtcTimestamp")} (${dec("D-002")}).</li>
<li><strong>A code list is a vocabulary.</strong> Each own list becomes one, named for what its codes are (${dec("D-031")}), each code labeled with its row's text.</li>
<li><strong>Decisions fill the gaps.</strong> ${plural(f.gaps, "decision record")} settle what the text leaves open, from how an evergreen deal leaves <code>enddate</code> blank (${dec("D-003")}) to which field "Price attribute" names (${dec("D-007")}). Read them in the <a href="decisions/index.html">decision records</a>.</li>
</ul>
</section>

<section id="emission">
<h2>What a row becomes</h2>
<p>An attribute is a property of its object: a <code>$ref</code> to its type, with its row's description and, where the Type cell states one, its <code>default</code>. A code list is <code>type: integer</code> and a <code>oneOf</code> of titled <code>const</code> branches, one per code (see the <a href="#design">design notes</a>); <code>pricetype</code>'s list also takes an exchange's code from 500 up. ${plural(f.rules, "rule")} of the text that JSON Schema can't express, such as "at most one of <code>wseat</code> and <code>bseat</code>", are in the rules file beside the kernel's, each with valid and invalid vectors and its level: a <em>should</em> is a warning, a <em>must</em> an error.</p>
</section>

<section id="verification">
<h2>Verification</h2>
<ul>
<li><strong>The fidelity oracle.</strong> A separate program reads each attribute row from the IR alone, never the mapping, and checks the emitted schemas: the presence, the type, and the default its Type cell states, and every code its Description cell lists.</li>
<li><strong>The round trip.</strong> Each attribute table is rendered back from the model and compared with the text, cell by cell. The recorded differences are Type cells whose wording the schemas don't keep, such as <code>integer</code> beside <code>int</code> (${dec("D-033")}), and <code>guar</code>'s codes (${dec("D-018")}).</li>
<li><strong>The registry agreement.</strong> Every list the text cites is AdCOM's, at the commit the registry pins, and no schema copies its codes.</li>
<li><strong>Determinism and drift.</strong> Every generated file is written twice in separate processes and compared with the committed one, byte for byte.</li>
<li><strong>Known-bad fixtures.</strong> Every gate has fixtures it must reject, such as a code list that lost a code, or a default the schema dropped.</li>
</ul>
</section>

<section id="inputs">
<h2>The two inputs</h2>
<p>The Deals API calls every revision "1.0", and its errata changed <code>sellerstatus</code> after the tag. So the schemas are built twice: from <code>main</code>, the default, and from ${tag ? `the ${esc(lockNames(b, tag.name).short)}` : "the tag"}. The lock comparison shows that they differ in that one list, where the tag drops code 3 and gives code 4 both meanings, and the release differ classes the change as breaking.</p>
</section>

<section id="example">
<h2>One attribute, end to end</h2>
<ol class="steps">
<li><h3>The specification row</h3><p>${inline(info.label, "")}${specLink ? `, <a href="${esc(specLink.href)}">${esc(specLink.text)}</a>` : ""}:</p><blockquote>${info.quote.html}</blockquote></li>
<li><h3>The element</h3><p>The extractor records the row as <code>${esc(row.id)}</code>, with the digest <code class="digest">${esc((element.element as { digest: string }).digest)}</code>. Every mapping entry and decision that rests on the row stores that digest, and goes stale when the row changes.</p></li>
<li><h3>The vocabulary</h3><p>The row's code list becomes ${t(vocab.name)}, in the <code>${esc(vocab.module)}</code> module, and the property takes its default, 0, from the Type cell; <code>recommended</code> leaves it optional (${dec("D-029")}).</p></li>
<li><h3>The emitted schema</h3><p>In <a href="${esc(file)}"><code>${esc(file)}</code></a>, under <code>$defs</code>. <a href="${m(vocab.name, "schema")}">Open it in the type map</a>.</p>${json(emitted)}</li>
<li><h3>The example value</h3><p>A vocabulary's example is one of its codes. <a href="${m(vocab.name, "example")}">See it in the type map</a>.</p>${json(example)}</li>
</ol>
</section>

${designNotes({ codes: `The text writes its own lists as integer codes, such as <code>pricetype</code>'s <code>3</code> for Fixed Price, and cites two lists from AdCOM 1.0.`, flags: `The text writes <code>guar</code> as <code>0</code>, not a guaranteed deal, or <code>1</code>, a guaranteed deal, so it is <code>IntegerFlag</code>.` })}

<section id="reproduce">
<h2>How to reproduce it</h2>
<p>${b.repo ? `The tooling is public at <a href="${esc(b.repo)}">${esc(b.repo.replace("https://github.com/", ""))}</a>.` : "The tooling's repository holds every step."} It needs Node 22, and the gates also need Python 3.12 and Go 1.25 or later. <code>npm run ci</code> runs every gate on every specification, as CI does; <code>npm run extract -- --lock specs/dealsapi/spec-input/spec-lock.yaml</code> and the other steps run on one.</p>
</section>
</div>`;
  return page({ path: "how-it-is-built.html", title: `How it's built · ${named(b)} JSON Schema`, description: `How ${b.publisher} generates the ${named(b)} schemas from the specification text.`, section: "method", body, brand: b });
}

/** The Deals API's card on the site's root page. */
function summary(inputs: SiteInputs): string {
  const f = facts(inputs);
  return `The Deal Sync API's two payloads, the deal its origin system pushes and the buyer's status response: ${plural(f.objects.length + f.documents.length, "object")}, ${plural(f.own, "code list")} of its own, and AdCOM's ${f.registry.map((n) => `\`${n}\``).join(" and ")} by reference.`;
}

export const dealsapiSite: SiteCopy = { landing: landingPage, method: methodPage, summary };
