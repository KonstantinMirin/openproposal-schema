/**
 * The site's own pages at its root: the page that lists the specifications,
 * which opens with why each standard needs an executable specification; the
 * not-found page, which the server sends for any missing path; and
 * robots.txt. They name each spec only through its card, which the spec's
 * pages and profile give.
 */
import type { SiteConfig } from "./config.ts";
import { esc, inline, rootPage } from "./html.ts";

/** One spec as the root page lists it. */
export interface SpecCard {
  /** The spec's path on the site. */
  spec: string;
  /** Its name with its edition, and the release its default input pins. */
  name: string;
  release: string;
  /** One or two sentences from its site copy. */
  summary: string;
  gaps: number;
  departures: number;
  /** The named types of its default build, as written. */
  types: number;
  /** Its inputs, by their short names. */
  locks: string[];
  /** Whether it is a registry of code lists, whose page lists the specs that cite each. */
  registry?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const navOf = (cards: readonly SpecCard[]) => cards.map((c) => ({ href: `${c.spec}/index.html`, label: c.name }));

/** The root page: the case for executable specifications, then a card per spec. */
export function rootIndex(site: SiteConfig, cards: readonly SpecCard[]): string {
  const items = cards
    .map(
      (c) => `<li class="card spec-card"><h3><a href="${c.spec}/index.html">${esc(c.name)}</a></h3>
<p class="note">${esc(c.release)} · ${plural(c.locks.length, "input")}: ${c.locks.map(esc).join(", ")}</p>
<p>${inline(c.summary, `${c.spec}/`)}</p>
<p class="stats-line"><span><b>${c.types}</b> types</span> <span><b>${c.gaps}</b> open points filled</span> <span><b>${c.departures}</b> changes proposed</span></p>
<p class="actions"><a class="button primary" href="${c.spec}/index.html">Open ${esc(c.name)}</a><a class="button" href="${c.spec}/map.html">Type map</a>${c.registry ? `<a class="button" href="${c.spec}/registry.html">Who cites each list</a>` : ""}<a class="button" href="${c.spec}/decisions/index.html">Decisions</a></p></li>`,
    )
    .join("\n");
  const body = `
<section class="hero">
  <div class="hero-in">
    <p class="eyebrow">Unofficial · Not an IAB Tech Lab artifact</p>
    <h1>${esc(site.title)}</h1>
    ${site.lead.map((p, i) => `<p${i === 0 ? ' class="lede"' : ""}>${inline(p, "")}</p>`).join("\n    ")}
  </div>
</section>

<section class="wrap">
  <h2>The specifications</h2>
  <ul class="spec-cards">
${items}
  </ul>
</section>
`;
  // The description is the lead's first sentence, whole.
  const first = /^.*?[.!?](?=\s|$)/.exec(site.lead[0]!)?.[0] ?? site.lead[0]!;
  return rootPage({ path: "index.html", title: `${site.title}, unofficial`, description: first, body, site, specs: navOf(cards) });
}

/** The page the server sends for any missing path, so its links start at the root. */
export function rootNotFound(site: SiteConfig, cards: readonly SpecCard[]): string {
  const body = `<div class="wrap narrow"><h1>Page not found</h1><p>This address names no page of the site. Start from the <a href="/index.html">list of specifications</a>${cards.length > 0 ? `, or open ${cards.map((c) => `<a href="/${c.spec}/index.html">${esc(c.name)}</a>`).join(" or ")}` : ""}.</p></div>`;
  // The base, a slash, starts every link at the root, so the page works at any path.
  return rootPage({ path: "404.html", title: `Page not found · ${site.name}`, description: "Page not found.", body, site, specs: navOf(cards), base: "/" });
}

/** The root's own files, by path. */
export function rootFiles(site: SiteConfig, cards: readonly SpecCard[]): Map<string, string> {
  return new Map([
    ["index.html", rootIndex(site, cards)],
    ["404.html", rootNotFound(site, cards)],
    ["robots.txt", "User-agent: *\nAllow: /\n"],
  ]);
}
