/**
 * AdCOM's own pages on the public site (src/site/copy.ts): the landing page,
 * which says what the registry holds, what it leaves for later, and which
 * inputs it rests on; and How it's built, which follows List: Device Types
 * from its row to its schema and its example value. Every number, quote,
 * schema, and example is read from the build, so the pages stay true to the
 * build they ship with.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { schemaDirOf } from "../../emit.ts";
import { indexElements } from "../../elements.ts";
import type { SpecLock } from "../../lock.ts";
import { TYPE_EXAMPLES_FILE, typeExamplesDirOf, type TypeExamplesDoc } from "../../type-examples.ts";
import { lockNames, named } from "../../site/config.ts";
import { buildOf, sourceInfos, type SiteInputs } from "../../site/data.ts";
import { esc, inline, page } from "../../site/html.ts";
import { DESIGN_NOTES_TOC, designNotes, pipelineFigure } from "../../site/method.ts";
import { ENUM_DRIFT_DIR, ENUM_DRIFT_FILES, type EnumDriftDoc } from "../../enum-drift.ts";
import { repoLink } from "../../site/pages.ts";
import { mapLink } from "../../site/route.ts";
import type { SiteCopy } from "../../site/copy.ts";
import { stands } from "../../mapping.ts";

const short = (sha: string) => sha.slice(0, 7);
const commitUrl = (lock: SpecLock) => `${lock.upstream}/commit/${lock.commit}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const json = (v: unknown) => `<pre class="code"><code>${esc(JSON.stringify(v, null, 2))}</code></pre>`;
const dec = (id: string) => `<a href="decisions/${id}.html">${id}</a>`;

/** What the registry holds on its default lock, read from its IR and its model as written. */
function facts(inputs: SiteInputs) {
  const lock = inputs.locks[0]!;
  const ir = inputs.irs.get(lock.name)!;
  const model = buildOf(inputs, lock.name, "as-written").model;
  const vocabularies = model.types.filter((t) => t.kind === "vocabulary");
  const lists = ir.sections.filter((s) => /^List:/.test(s.title));
  const withCodes = new Set(ir.definitions.map((d) => d.loc.section));
  const objects = ir.sections.filter((s) => /^(Object|Abstract Class):/.test(s.title));
  const codes = vocabularies.reduce((n, t) => n + (t.kind === "vocabulary" ? t.terms.length : 0), 0);
  const vendor = vocabularies.filter((t) => t.kind === "vocabulary" && t.vendor !== undefined).length;
  const live = inputs.decisions.filter((d) => stands(d));
  return {
    lock,
    ir,
    model,
    lists: lists.length,
    empty: lists.filter((s) => !withCodes.has(s.id)),
    vocabularies: vocabularies.length,
    codes,
    vendor,
    objects: objects.length,
    attributes: ir.keys.length,
    gaps: live.filter((d) => d.kind === "gap").length,
    departures: live.filter((d) => d.kind === "departure").length,
    primitives: model.types.filter((t) => t.kind === "primitive").map((t) => t.name),
  };
}

function landingPage(inputs: SiteInputs): string {
  const b = inputs.brand;
  const f = facts(inputs);
  const [main, ...rest] = inputs.locks;
  const body = `
<section class="hero">
  <div class="hero-in">
    <p class="eyebrow">Unofficial · Not an IAB Tech Lab artifact</p>
    <h1>${b.short}&nbsp;${b.edition}'s code lists, generated as JSON&nbsp;Schema</h1>
    <p class="lede">An unofficial registry of the code lists of ${named(b)}, one JSON Schema vocabulary per list, generated from the specification text by ${b.publisher}, an IAB Tech Lab member. The specification remains the reference: where this site and the text differ, the text wins.</p>
    <p class="actions"><a class="button primary" href="map.html">Open the type map</a><a class="button" href="registry.html">Who cites each list</a><a class="button" href="how-it-is-built.html">How it's built</a><a class="button" href="decisions/index.html">Read the decisions</a><a class="button" href="downloads.html">Get the schema files</a></p>
  </div>
</section>

<section class="band">
  <div class="wrap">
    <h2>What the registry holds</h2>
    <p>${b.short} keeps the code lists that OpenRTB and other specifications cite, such as the device types and the API frameworks. Here each list with codes is one vocabulary, with each code's label from its row, so a specification that cites a list can take its codes from one place.</p>
    <div class="stats">
      <div class="stat gap"><span class="num">${f.vocabularies}</span><span class="what">lists as vocabularies</span><span class="why">Of the ${f.lists} lists the text writes, ${f.vocabularies} have codes. ${f.empty.length === 0 ? "" : `${f.empty.map((s) => esc(s.title)).join(" and ")} hold${f.empty.length === 1 ? "s" : ""} a deprecation note and no codes, so ${f.empty.length === 1 ? "it becomes" : "they become"} no vocabulary.`}</span></div>
      <div class="stat prop"><span class="num">${f.codes}</span><span class="what">codes, each with its label</span><span class="why">${f.vendor} lists also take a vendor's code from 500 up, as their <code>500+</code> rows reserve, and List: Start Delay Modes takes a mid-roll's delay in seconds.</span></div>
      <div class="stat ex"><span class="num">${f.gaps + f.departures}</span><span class="what">recorded decisions</span><span class="why">${plural(f.gaps, "gap")}, where the text leaves a point open, and ${f.departures === 0 ? "no proposal: we propose no change to what the text settles, so the site has no variant switch" : plural(f.departures, "proposal")}.</span></div>
    </div>
    <p><a href="registry.html">The registry page</a> lists each one with the specifications on this site that cite it. Each decision says what we ask ${b.short}'s owners to state, and each has its own page.</p>
  </div>
</section>

${enumDriftSection(inputs)}
<section class="wrap two">
  <div>
    <h2>What it leaves for later</h2>
    <p>${b.short} also defines ${f.objects} objects, such as <code>Ad</code> and <code>Device</code>, with ${f.attributes} attribute rows. The pipeline extracts every one of those rows, so a decision can quote them, but it doesn't map the objects yet (${dec("D-003")}): the schemas hold the lists alone. The records on the objects' known inconsistencies, such as how the protocol buffer definitions type a timestamp or a flag, quote the rows they rest on already.</p>
    <h2>How to read a vocabulary</h2>
    <p>Each list is <code>type: integer</code> and a <code>oneOf</code> of one titled <code>const</code> branch per code, as List: Device Types gives <code>3</code> the title "Connected TV". A list with a <code>500+</code> row is open: one more branch takes a vendor's code of 500 or more. ${f.primitives.length > 0 ? `The kernel holds the ${plural(f.primitives.length, "type", "types")} the lists need, ${f.primitives.map((p) => `<a href="${mapLink("", p, f.lock.name, "as-written")}"><code>${esc(p)}</code></a>`).join(" and ")}.` : ""}</p>
  </div>
  <div>
    <h2>Inputs</h2>
    <p>Specification: <a href="${main!.upstream}">${esc(main!.upstream.replace("https://github.com/", ""))}</a>, <code>${esc(main!.path)}</code>.</p>
    <ul>
      <li><strong>${esc(lockNames(b, main!.name).label)}</strong>: the text on ${b.short}'s <code>main</code> branch at <a href="${commitUrl(main!)}"><code>${short(main!.commit)}</code></a>, the default.</li>
      ${rest.map((l) => `<li><strong>${esc(lockNames(b, l.name).label)}</strong>: the text at <a href="${commitUrl(l)}"><code>${short(l.commit)}</code></a>.</li>`).join("\n      ")}
    </ul>
    <p>${rest.length > 0 ? `The two inputs have the same lists, code for code; they differ only in the <code>Content</code> object's table, which the tag still writes with the attribute names that <code>main</code> reverted (${dec("D-016")}). The type map's input switch shows either.` : ""} ${b.short} calls every revision since 2018 "1.0", so every release of these schemas names the commit it rests on.</p>
  </div>
</section>
`;
  return page({ path: "index.html", title: `${named(b)} code lists as JSON Schema, unofficial`, description: `An unofficial registry of ${named(b)}'s code lists as JSON Schema vocabularies, generated from the specification text by ${b.publisher}, an IAB Tech Lab member.`, section: "home", body, brand: b });
}

/** How the registry's lists compare with other artifacts' enums, from the committed enum drift report; empty where the spec has none. */
function enumDriftSection(inputs: SiteInputs): string {
  const file = join(inputs.root, ENUM_DRIFT_DIR, ENUM_DRIFT_FILES.data);
  if (!existsSync(file)) return "";
  const doc = JSON.parse(readFileSync(file, "utf8")) as EnumDriftDoc;
  const b = inputs.brand;
  const items = doc.sources.map((s) => {
    const t = doc.totals[s.id]!;
    const parts = [
      t.missing > 0 ? `lacks ${plural(t.missing, "code")} in ${plural(t.listsMissing, "list")}` : t.noEnum > 0 ? "holds every code of the lists it defines" : "holds every code",
      ...(t.noEnum > 0 ? [`has no enum for ${plural(t.noEnum, "list")}`] : []),
      ...(t.extra > 0 ? [`holds ${plural(t.extra, "value")} no list has`] : []),
      ...(t.narrow > 0 ? [`types ${plural(t.narrow, "list")} too narrowly for its codes or vendor range`] : []),
      ...(t.versions > 0 ? [`states a different version from the list's label at ${plural(t.versions, "code")}`] : []),
      ...(t.removedKept > 0 ? [`still defines ${plural(t.removedKept, "list")} whose table the text removed`] : []),
    ];
    return `<li><a href="${esc(s.upstream)}/tree/${s.commit}"><strong>${esc(s.title)}</strong></a> at <code>${short(s.commit)}</code> ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}` : parts[0]}.</li>`;
  });
  return `<section class="wrap">
  <h2>How other artifacts compare</h2>
  <p>Other artifacts define ${b.short}'s lists as enums of their own. A generated report compares each list, code by code, with each artifact's enum: it reports where each enum departs from its list, and it can't fix it.</p>
  <ul>
    ${items.join("\n    ")}
  </ul>
  <p>${repoLink(b, "blob", `specs/${b.spec}/${ENUM_DRIFT_DIR}/${ENUM_DRIFT_FILES.report}`, "Read the enum drift report")}, list by list, with a link to each enum at the commit it was read at.</p>
</section>
`;
}

function methodPage(inputs: SiteInputs): string {
  const b = inputs.brand;
  const f = facts(inputs);
  const lock = f.lock;
  const build = buildOf(inputs, lock.name, "as-written");
  const counts = f.ir.counts as Record<string, number>;
  let byRule = 0;
  let byDecision = 0;
  for (const m of inputs.mappings) for (const e of m.entries) ("rule" in (e.source as object) ? byRule++ : byDecision++);
  // The worked example: List: Device Types, its third row, the vocabulary, its schema, and its example value.
  const row = f.ir.definitions.find((d) => d.loc.section === "list_devicetypes" && d.value === "3")!;
  const element = indexElements(f.ir).get(row.id)!;
  const info = sourceInfos(inputs, lock, [row.id])[row.id]!;
  const vocab = build.model.types.find((t) => t.kind === "vocabulary" && t.terms.some((x) => x.sources.includes(row.id)))!;
  const schemaDir = build.dirOf(schemaDirOf(lock.ir_dir));
  const file = posix.join(schemaDir, "modules", vocab.module, "1", `${vocab.module}.json`);
  const emitted = (JSON.parse(readFileSync(join(inputs.root, file), "utf8")) as { $defs: Record<string, unknown> }).$defs[vocab.name];
  const te = JSON.parse(readFileSync(join(inputs.root, build.dirOf(typeExamplesDirOf(lock.ir_dir)), TYPE_EXAMPLES_FILE), "utf8")) as TypeExamplesDoc;
  const example = (te.types[vocab.name] as { full: unknown }).full;
  const m = (type: string, view?: "schema" | "example") => mapLink("", type, lock.name, "as-written", view);
  const t = (type: string) => `<a href="${m(type)}"><code>${esc(type)}</code></a>`;
  const specLink = info.links[0];
  const toc: [string, string][] = [
    ["pipeline", "The pipeline"],
    ["extraction", "Extraction"],
    ["mapping", "Mapping and decisions"],
    ["emission", "What a list becomes"],
    ["verification", "Verification"],
    ["inputs", "The two inputs"],
    ["example", "One list, end to end"],
    DESIGN_NOTES_TOC,
    ["reproduce", "How to reproduce it"],
  ];
  const body = `<div class="wrap method">
<h1>How it's built</h1>
<p class="lede">${b.publisher}, an IAB Tech Lab member, generates these schemas from the ${named(b)} specification text. Nobody writes a schema file by hand. Every vocabulary is a function of two things: the specification at a pinned commit, and a mapping and a set of decision records that we review by hand. This page explains each step for ${b.short}'s lists, and what it shapes in the <a href="map.html">type map</a> and the <a href="downloads.html">files</a>.</p>
<nav class="toc" aria-label="On this page"><p class="note">On this page</p><ol>${toc.map(([id, label]) => `<li><a href="#${id}">${label}</a></li>`).join("")}</ol></nav>

<section id="pipeline">
<h2>The pipeline</h2>
<p>The same pipeline generates every specification on this site. For ${b.short}'s lists it runs every step but two: the lists need no constructors, and ${b.short} has no SDK types yet, since the schemas come first.</p>
${pipelineFigure()}
</section>

<section id="extraction">
<h2>Extraction</h2>
<p>${b.short} writes its tables in HTML, not Markdown. The extractor reads each HTML table into the same rows a Markdown table gives, keeping each row's source bytes, and fails on any tag a table doesn't use, so no row is skipped silently. Each heading carries its own anchor, such as <code>list_devicetypes</code>, which every link to it names, so each section takes that anchor as its ID. The text adopts no RFC 2119 convention and writes its keywords in either case, so a keyword in any case makes a statement (${dec("D-001")}).</p>
<p>On <code>${esc(lock.name)}</code>, the IR holds ${counts.definitions} list rows in ${new Set(f.ir.definitions.map((d) => d.loc.table)).size} tables, ${counts.keys} object attribute rows, and ${counts.statements} statements. Each element has an ID, such as <code>${esc(row.id)}</code>: a value-definition row (<code>def</code>), in the section <code>list_devicetypes</code>, for the code <code>3</code>.</p>
</section>

<section id="mapping">
<h2>Mapping and decisions</h2>
<p>Every element has exactly one entry in the mapping, on each input. Of the ${byRule + byDecision} entries across both inputs, ${byRule} come from mapping rules and ${byDecision} cite a decision record.</p>
<ul>
<li><strong>A list is a vocabulary.</strong> A table of codes that a <code>List:</code> heading alone names becomes one vocabulary, named after the list's title in PascalCase with its head noun in the singular (${dec("D-002")}), and each code row becomes one of its terms, labeled with its row's text.</li>
<li><strong>A vendor range is an open branch.</strong> A <code>500+</code> row opens its list to a vendor's code of 500 or more; a list without one stays closed (${dec("D-008")}).</li>
<li><strong>The objects wait.</strong> Every element of the <code>Object:</code> sections is informative until a later phase maps the objects (${dec("D-003")}).</li>
<li><strong>Decisions fill the gaps.</strong> ${plural(f.gaps, "decision record")} settle what the text leaves open, from the start delays' <code>&gt;0</code> row (${dec("D-004")}) to the revision of record (${dec("D-016")}). Read them in the <a href="decisions/index.html">decision records</a>.</li>
</ul>
</section>

<section id="emission">
<h2>What a list becomes</h2>
<p>A list is <code>type: integer</code> and a <code>oneOf</code> of one <code>const</code> branch per code, titled with the code's name, so a reader of the schema alone sees what each code means. An open list adds one branch for its extension: an integer of at least 500 for a vendor range, as ${t("VendorCode")} is, or, for the start delay, a whole number of seconds other than <code>0</code>, as ${t("MediaOffset")} is. The <a href="#design">design notes</a> say why.</p>
</section>

<section id="verification">
<h2>Verification</h2>
<ul>
<li><strong>The fidelity oracle.</strong> A separate program reads each list's rows from the IR alone, never the mapping, and checks the emitted schemas: every code valid, a code no row names invalid, the first vendor code valid and the code below it invalid. On <code>${esc(lock.name)}</code> it checks every list with codes.</li>
<li><strong>The round trip.</strong> Each list's table is rendered back from the model and compared with the text, cell by cell. The one recorded difference is the start delays' <code>&gt;0</code> row, which no single term can render.</li>
<li><strong>Determinism and drift.</strong> Every generated file is written twice in separate processes and compared with the committed one, byte for byte, and each release manifest's digests are recomputed.</li>
<li><strong>Known-bad fixtures.</strong> Every gate has fixtures it must reject, such as an HTML cell with a tag the reader doesn't know, or a vocabulary that lost a code.</li>
</ul>
</section>

<section id="inputs">
<h2>The two inputs</h2>
<p>${b.short} has changed its lists many times while calling every revision "1.0", and its last tag isn't <code>main</code>. So the registry is built twice: from <code>main</code>, the default, and from the last tag. The lock comparison shows that their lists are the same, code for code, and that they differ only in the <code>Content</code> object's table.</p>
</section>

<section id="example">
<h2>One list, end to end</h2>
<ol class="steps">
<li><h3>The specification row</h3><p>${inline(info.label, "")}${specLink ? `, <a href="${esc(specLink.href)}">${esc(specLink.text)}</a>` : ""}:</p><blockquote>${info.quote.html}</blockquote></li>
<li><h3>The element</h3><p>The extractor records the row as <code>${esc(row.id)}</code>, with the digest <code class="digest">${esc((element.element as { digest: string }).digest)}</code>. Every mapping entry and decision that rests on the row stores that digest, and goes stale when the row changes.</p></li>
<li><h3>The vocabulary</h3><p>The rule that maps a list's code rows makes the row a term of ${t(vocab.name)}, in the <code>${esc(vocab.module)}</code> module, with the label "${esc(vocab.kind === "vocabulary" ? (vocab.terms.find((x) => x.sources.includes(row.id))?.annotation ?? "") : "")}".</p></li>
<li><h3>The emitted schema</h3><p>In <a href="${esc(file)}"><code>${esc(file)}</code></a>, under <code>$defs</code>. <a href="${m(vocab.name, "schema")}">Open it in the type map</a>.</p>${json(emitted)}</li>
<li><h3>The example value</h3><p>A vocabulary's example is one of its codes. <a href="${m(vocab.name, "example")}">See it in the type map</a>.</p>${json(example)}</li>
</ol>
</section>

${designNotes({ codes: `Every list here is integer codes, such as <code>3</code> for Connected TV in List: Device Types.`, flags: `The registry maps lists only, so no flag appears here yet; when the objects are mapped, a flag such as <code>instl</code> keeps the <code>0</code> | <code>1</code> the text writes.` })}

<section id="reproduce">
<h2>How to reproduce it</h2>
<p>${b.repo ? `The tooling is public at <a href="${esc(b.repo)}">${esc(b.repo.replace("https://github.com/", ""))}</a>.` : "The tooling's repository holds every step."} It needs Node 22, and the gates also need Python 3.12 and Go 1.25 or later. <code>npm run ci</code> runs every gate on every specification, as CI does; <code>npm run extract -- --lock specs/adcom/spec-input/spec-lock.yaml</code> and the other steps run on one.</p>
</section>
</div>`;
  return page({ path: "how-it-is-built.html", title: `How it's built · ${named(b)} JSON Schema`, description: `How ${b.publisher} generates the ${named(b)} code lists as JSON Schema from the specification text.`, section: "method", body, brand: b });
}

/** AdCOM's card on the site's root page. */
function summary(inputs: SiteInputs): string {
  const f = facts(inputs);
  return `The code lists that OpenRTB and other specifications cite, such as device types and API frameworks: ${f.vocabularies} lists and ${f.codes} codes, one vocabulary per list. Its ${f.objects} objects come later.`;
}

export const adcomSite: SiteCopy = { landing: landingPage, method: methodPage, summary };
