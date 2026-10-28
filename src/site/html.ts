/**
 * HTML helpers for the site's pages: escaping, the inline markup the
 * records write, and the layout every page shares. Every page declares the
 * site's Content-Security-Policy and loads only same-origin files, with no
 * inline script or style, so the policy needs no `unsafe-inline`.
 */
import { CSP_META, type SiteBrand } from "./config.ts";

export const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * A record's text as HTML: a backtick span is code, `**x**` is bold, a
 * Markdown link to an http(s) URL is a link and one to anywhere else its
 * text, and a decision ID such as `D-046` links to its page. `base` is the path from the
 * page to the site's root, such as `../` from a decision page.
 */
export function inline(text: string, base: string): string {
  const out: string[] = [];
  const parts = text.split(/(`[^`]+`)/g);
  for (const p of parts) {
    if (p.startsWith("`") && p.endsWith("`") && p.length > 1) {
      out.push(`<code>${esc(p.slice(1, -1))}</code>`);
      continue;
    }
    out.push(
      esc(p)
        // A Markdown link a record writes for the working group: an http(s) one is a link, and one into the feedback's own page shows its text alone.
        .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => (/^https?:\/\//.test(url) ? `<a href="${url}">${label}</a>` : label))
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\bD-(\d{3})\b/g, (_, n: string) => `<a href="${base}decisions/D-${n}.html">D-${n}</a>`),
    );
  }
  return out.join("");
}

/** A record's text as paragraphs, with a run of `- ` lines as a list. */
export function prose(text: string, base: string): string {
  const blocks = text.trim().split(/\n\s*\n|\n(?=- )/);
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length > 0) out.push(`<ul>${list.map((x) => `<li>${inline(x, base)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const b of blocks) {
    const t = b.trim();
    if (t.startsWith("- ")) list.push(t.slice(2).replace(/\s*\n\s*/g, " "));
    else {
      flush();
      if (t !== "") out.push(`<p>${inline(t.replace(/\s*\n\s*/g, " "), base)}</p>`);
    }
  }
  flush();
  return out.join("\n");
}

export interface PageOptions {
  /** The page's path from the site's root, such as `decisions/D-027.html`. */
  path: string;
  title: string;
  description: string;
  /** The nav item the page belongs to. */
  section: "home" | "method" | "map" | "examples" | "decisions" | "downloads" | "none";
  body: string;
  /** Scripts the page loads after the shared ones, by path from the root. */
  scripts?: string[];
  /** A class for `<body>`, such as `wide` for the type map. */
  bodyClass?: string;
  /** The path from the page to the root, where it isn't the page's own, as for a not-found page served at any path. */
  base?: string;
  /** What the header and the footer name. */
  brand: SiteBrand;
}

const NAV: [PageOptions["section"], string, string][] = [
  ["home", "index.html", "Overview"],
  ["method", "how-it-is-built.html", "How it's built"],
  ["map", "map.html", "Type map"],
  ["examples", "examples.html", "Examples"],
  ["decisions", "decisions/index.html", "Decisions"],
  ["downloads", "downloads.html", "Files"],
];

/** The path from a page to the site's root. */
export const baseOf = (path: string): string => "../".repeat(path.split("/").length - 1);

/** The text of the link every spec's page has back to the site's root, which lists the specs. */
export const ROOT_LINK = "All specifications";

/** A whole page of a spec, in the shared layout: its nav starts with the link back to the site's root, one folder up from the spec's. */
export function page(o: PageOptions): string {
  const base = o.base ?? baseOf(o.path);
  const b = o.brand;
  const nav = `<a href="${base}../index.html">${ROOT_LINK}</a>` + NAV.map(([s, href, label]) => `<a href="${base}${href}"${s === o.section ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  const brand = `<a class="brand" href="${base}index.html"><span class="mark" aria-hidden="true"></span><span>${b.short}&nbsp;${b.edition} <em>JSON&nbsp;Schema</em></span></a>`;
  const foot = `<p>Published by ${b.publisher}, an IAB Tech Lab member. Unofficial: this isn't an IAB Tech Lab artifact, and the ${b.short} specification remains the reference. Generated from ${b.short} ${b.edition} ${b.release}.</p>
    <p>${b.feedback ? `<a href="${b.feedback.issue}">Implementation feedback on issue #${b.feedback.issueNumber}</a> · ` : ""}<a href="${base}decisions/index.html">Decision records</a> · <a href="${base}downloads.html">Files</a></p>`;
  return layout({ ...o, base, brand, nav, foot });
}

/** What the site's root pages carry: the site's own name and publisher, and a nav of the specs. */
export interface RootPageOptions {
  path: string;
  title: string;
  description: string;
  body: string;
  /** The site's name, and each spec's link in the nav, by its path from the root. */
  site: { name: string; publisher: string };
  specs: { href: string; label: string }[];
  base?: string;
  bodyClass?: string;
}

/** A page at the site's root, such as the list of specs or the not-found page, in the shared layout. */
export function rootPage(o: RootPageOptions): string {
  const base = o.base ?? baseOf(o.path);
  const brand = `<a class="brand" href="${base}index.html"><span class="mark" aria-hidden="true"></span><span>${esc(o.site.name)} <em>as&nbsp;JSON&nbsp;Schema</em></span></a>`;
  const nav = o.specs.map((s) => `<a href="${base}${s.href}">${esc(s.label)}</a>`).join("");
  const foot = `<p>Published by ${esc(o.site.publisher)}, an IAB Tech Lab member. Unofficial: this isn't an IAB Tech Lab artifact, and each specification's own text remains the reference.</p>`;
  return layout({ path: o.path, title: o.title, description: o.description, body: o.body, base, brand, nav, foot, scripts: [], ...(o.bodyClass ? { bodyClass: o.bodyClass } : {}) });
}

/** The markup every page shares: the policy, the stylesheet, the scripts, the header, and the footer. */
function layout(o: { path: string; title: string; description: string; body: string; base: string; brand: string; nav: string; foot: string; scripts?: string[]; bodyClass?: string }): string {
  const base = o.base;
  const scripts = ["assets/site.js", ...(o.scripts ?? [])].map((s) => `<script src="${base}${s}" defer></script>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${esc(CSP_META)}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="icon" href="${base}assets/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${base}assets/site.css">
<script src="${base}assets/theme.js"></script>
${scripts}
</head>
<body${o.bodyClass ? ` class="${o.bodyClass}"` : ""}>
<a class="skip" href="#main">Skip to the content</a>
<header class="top">
  <div class="top-in">
    ${o.brand}
    <span class="pill" title="Not an IAB Tech Lab artifact">Unofficial</span>
    <nav aria-label="Site">${o.nav}</nav>
    <button class="theme" type="button" id="theme" aria-label="Color theme: system">◐</button>
  </div>
</header>
<main id="main">
${o.body}
</main>
<footer class="foot">
  <div class="foot-in">
    ${o.foot}
  </div>
</footer>
</body>
</html>
`;
}
