/**
 * The page of a registry of code lists, a spec whose profile marks it so: every list the
 * registry's default build holds as a vocabulary, with its codes and its
 * vendor range, and the specs on the site that cite it. A spec cites a list
 * where its text names it, as "List: Device Types", or where one of its
 * vocabularies takes the list's codes. Everything is read from the builds,
 * so the page names no spec of its own.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { permalink } from "../feedback.ts";
import { snapshotOf } from "../fetch.ts";
import { repoRoot, type SpecLock } from "../lock.ts";
import type { ProvenanceDoc } from "../provenance.ts";
import { lockNames, named } from "./config.ts";
import { buildOf, type SiteInputs } from "./data.ts";
import { esc, inline, page } from "./html.ts";
import { mapLink } from "./route.ts";
import { renderQuote } from "./quote.ts";

/** One list of the registry, as the page shows it. */
export interface RegistryList {
  /** The list's title, as its heading writes it after "List:". */
  title: string;
  vocabulary: string;
  codes: number;
  vendor: number | null;
  /** The primitive a value of the list may also be, beyond its codes and vendor range, as a media offset in seconds for Start Delay Modes' `>0` row. */
  extension: string | null;
  /** The specs that cite it, each with each of its locks' lines that name the list and its own vocabularies of the list's codes. */
  citedBy: { spec: string; name: string; lock: string; lines: { line: number; at: string; text: string; href: string | null }[]; vocabularies: string[] }[];
}

/** A lock's specification text, as its snapshot holds it. */
function specText(lock: SpecLock): string[] {
  const dir = snapshotOf(lock);
  return dir === null ? [] : readFileSync(join(repoRoot(lock), dir, lock.path), "utf8").split("\n");
}

/**
 * Where one line of a lock's text is on GitHub: at its commit, or, for a lock
 * that merges open PRs, where the PR or main wrote it, with the line number
 * the link opens at; no link for a line the merge wrote.
 */
function lineAt(lock: SpecLock, provenance: ProvenanceDoc | null, line: number): { at: string; href: string | null } {
  if (lock.merge_order === null) return { at: `L${line}`, href: permalink(lock, line) };
  const o = provenance?.lines[line - 1];
  return o ? { at: `L${o.line}`, href: permalink({ upstream: lock.upstream, commit: o.commit, path: o.path }, o.line) } : { at: `line ${line} of the merge`, href: null };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");

/**
 * The lines of a text that cite each of a registry's lists, by the list's
 * title after "List:". A citation is the longest title that follows
 * "List:", with no more letters, digits, slashes, or hyphens directly
 * after it, so "List: Placement Subtypes - Video" cites that list, not one
 * titled "Placement Subtypes". A title that wraps to the next line cites
 * from the line where "List:" is; each line that names a list again cites
 * it too.
 */
export function citingLines(text: readonly string[], titles: readonly string[]): Map<string, number[]> {
  const byLength = [...titles].sort((a, b) => b.length - a.length);
  const res = byLength.map((t) => ({ t, re: new RegExp(`^${escapeRe(t)}(?![A-Za-z0-9/-])`) }));
  const out = new Map<string, number[]>();
  text.forEach((s, i) => {
    const joined = `${s} ${text[i + 1] ?? ""}`;
    for (const m of joined.matchAll(/\bList:\s+/g)) {
      if (m.index >= s.length) break;
      const rest = joined.slice(m.index + m[0].length);
      const hit = res.find((r) => r.re.test(rest));
      if (!hit) continue;
      const lines = out.get(hit.t) ?? [];
      if (lines.at(-1) !== i + 1) lines.push(i + 1);
      out.set(hit.t, lines);
    }
  });
  return out;
}

/** The registry's lists, from its default build as written, with every citation the other specs' builds hold. */
export function registryLists(reg: SiteInputs, others: readonly SiteInputs[]): RegistryList[] {
  const lock = reg.locks[0]!;
  const build = buildOf(reg, lock.name, "as-written");
  const ir = reg.irs.get(lock.name)!;
  const titleOf = (source: string) => {
    const section = ir.definitions.find((d) => d.id === source)?.loc.section;
    return /^[A-Z][A-Za-z ]*:\s*(\S.*)$/.exec(ir.sections.find((s) => s.id === section)?.title ?? "")?.[1] ?? null;
  };
  // Every list the registry's text titles, those with no codes too, so a longer title is never read as a shorter one.
  const titles = ir.sections.flatMap((s) => /^List:\s*(\S.*)$/.exec(s.title)?.[1] ?? []);
  const cites = new Map(others.flatMap((o) => o.locks.map((l) => [`${o.brand.spec}:${l.name}`, { text: specText(l), lines: citingLines(specText(l), titles) }] as const)));
  const out: RegistryList[] = [];
  for (const t of build.model.types) {
    if (t.kind !== "vocabulary" || !t.labeled) continue;
    const title = titleOf(t.terms[0]?.sources[0] ?? t.sources[0] ?? "");
    if (title === null) continue;
    const citedBy: RegistryList["citedBy"] = [];
    for (const o of others) {
      for (const l of o.locks) {
        const c = cites.get(`${o.brand.spec}:${l.name}`)!;
        const lines = (c.lines.get(title) ?? []).map((n) => ({ line: n, text: c.text[n - 1]!.trim(), ...lineAt(l, o.provenance.get(l.name) ?? null, n) }));
        const vocabularies = buildOf(o, l.name, "as-written").model.types.flatMap((x) => (x.kind === "vocabulary" && x.list?.name === `List: ${title}` ? [x.name] : []));
        if (lines.length > 0 || vocabularies.length > 0) citedBy.push({ spec: o.brand.spec, name: named(o.brand), lock: l.name, lines, vocabularies });
      }
    }
    out.push({ title, vocabulary: t.name, codes: t.terms.length, vendor: t.vendor?.from ?? null, extension: t.vendor ? null : (t.extension ?? null), citedBy });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title, "en"));
}

/** The most characters of a citing line's visible text the page shows. */
const CITE_LINE_MAX = 160;

/** The registry's page, `registry.html` under its spec's path. */
export function registryPage(reg: SiteInputs, others: readonly SiteInputs[]): string {
  const b = reg.brand;
  const lists = registryLists(reg, others);
  const base = "";
  const lock = reg.locks[0]!.name;
  const cited = lists.filter((l) => l.citedBy.length > 0);
  const rows = lists
    .map((l) => {
      const cites = l.citedBy
        .map((c) => {
          const o = others.find((x) => x.brand.spec === c.spec)!;
          const vocab = c.vocabularies.map((v) => `<a href="../${c.spec}/${mapLink("", v, c.lock, "as-written")}"><code>${esc(v)}</code></a>`).join(", ");
          // Each line reads as GitHub shows it, cut on the text a reader sees; a relative link opens where the line is published.
          const lines = c.lines.map((x) => `<li>${x.href ? `<a href="${esc(x.href)}">${esc(x.at)}</a>` : esc(x.at)}: ${renderQuote(x.text, { base: x.href?.replace(/[?#].*$/, "") ?? null, max: CITE_LINE_MAX }).html}</li>`).join("");
          return `<li><strong>${esc(c.name)}</strong>, ${esc(lockNames(o.brand, c.lock).where)}${vocab ? `: its vocabulary ${vocab}` : ""}${lines ? `<ul class="cite-lines">${lines}</ul>` : ""}</li>`;
        })
        .join("");
      return `<tr><td data-label="List"><a href="${mapLink(base, l.vocabulary, lock, "as-written")}">${esc(l.title)}</a><span class="sub"><code>${esc(l.vocabulary)}</code></span></td><td data-label="Codes">${l.codes}${l.vendor !== null ? `, and vendors' from ${l.vendor}` : ""}${l.extension !== null ? `, and any <a href="${mapLink(base, l.extension, lock, "as-written")}"><code>${esc(l.extension)}</code></a>` : ""}</td><td data-label="Cited by">${cites ? `<ul class="cites">${cites}</ul>` : `<span class="note">No spec on this site</span>`}</td></tr>`;
    })
    .join("\n");
  const body = `<div class="wrap">
<h1>The registry of ${esc(b.short)}'s code lists</h1>
<p class="sub">Each of the ${lists.length} lists of ${esc(named(b))} with codes is one vocabulary here, defined once. ${cited.length > 0 ? `${cited.length} of them are cited by another specification on this site, on at least one of its inputs, where its text names the list, or one of its vocabularies takes the list's codes.` : "No other specification on this site cites them yet."} A specification that cites a list can take its codes from these schemas; ${esc(b.short)}'s text remains the reference.</p>
<div class="scroll"><table class="registry">
<thead><tr><th>List</th><th>Codes</th><th>Cited by</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>
<p class="note">${inline(`Read from the build of \`${lock}\` as written. A citation is a line of a specification's text that names the list by its title after "List:", linked to that line on GitHub, or a vocabulary of the specification's that takes the list's codes.`, "")}</p>
</div>`;
  return page({ path: "registry.html", title: `Registry · ${named(b)} JSON Schema`, description: `Every code list of ${named(b)} as a vocabulary, and the specifications that cite it.`, section: "none", body, brand: b });
}
