/**
 * HTML helpers for the site's pages: escaping, the inline markup the
 * records write, and the layout every page shares. Every page declares the
 * site's Content-Security-Policy and loads only same-origin files, with no
 * inline script or style, so the policy needs no `unsafe-inline`.
 */
import { CSP_META, ISSUE_URL, PUBLISHER } from "./config.ts";

export const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * A record's text as HTML: a backtick span is code, `**x**` is bold, and a
 * decision ID such as `D-046` links to its page. `base` is the path from the
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
}

const NAV: [PageOptions["section"], string, string][] = [
  ["home", "index.html", "Overview"],
  ["method", "how-it-is-built.html", "How it's built"],
  ["map", "map.html", "Type map"],
  ["examples", "examples.html", "Examples"],
  ["decisions", "decisions/index.html", "Decisions"],
  ["downloads", "downloads.html", "Downloads"],
];

/** The path from a page to the site's root. */
export const baseOf = (path: string): string => "../".repeat(path.split("/").length - 1);

/** A whole page in the shared layout. */
export function page(o: PageOptions): string {
  const base = o.base ?? baseOf(o.path);
  const nav = NAV.map(([s, href, label]) => `<a href="${base}${href}"${s === o.section ? ' aria-current="page"' : ""}>${label}</a>`).join("");
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
    <a class="brand" href="${base}index.html"><span class="mark" aria-hidden="true"></span><span>OpenProposal&nbsp;3.0 <em>JSON&nbsp;Schema</em></span></a>
    <span class="pill" title="Not an IAB Tech Lab artifact">Unofficial</span>
    <nav aria-label="Site">${nav}</nav>
    <button class="theme" type="button" id="theme" aria-label="Color theme: system">◐</button>
  </div>
</header>
<main id="main">
${o.body}
</main>
<footer class="foot">
  <div class="foot-in">
    <p>Published by ${PUBLISHER}, an IAB Tech Lab member. Unofficial: this isn't an IAB Tech Lab artifact, and the OpenProposal specification remains the reference. Generated from OpenProposal 3.0 draft 1.</p>
    <p><a href="${ISSUE_URL}">Implementation feedback on issue #121</a> · <a href="${base}decisions/index.html">Decision records</a> · <a href="${base}downloads.html">Downloads</a></p>
  </div>
</footer>
</body>
</html>
`;
}
