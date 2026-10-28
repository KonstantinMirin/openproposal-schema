/**
 * A quoted line of a specification as a reader sees it: its inline Markdown
 * rendered, so a link is a link and a code span is code, with every word
 * the source writes and none it doesn't. The site shows a quote in two
 * forms: the HTML, and the plain text a tooltip or a check reads.
 */
import type { Nodes } from "mdast";
import { parseMarkdown } from "../markdown.ts";
import { esc } from "./html.ts";

/** A quote rendered: its HTML, and the text a reader sees in it. */
export interface RenderedQuote {
  html: string;
  text: string;
}

export interface QuoteOptions {
  /** The URL a relative link of the text resolves against: the specification's file where it is published. A relative link with no base shows its text alone. */
  base?: string | null;
  /** The most characters of visible text to show; a longer quote is cut at a word and ends with "…". A link that is cut keeps its target. */
  max?: number;
}

/** A table row's cells, split at each pipe not escaped, without the row's outer pipes, and with each escaped pipe a pipe; GFM splits at a pipe inside a code span too. */
export function tableCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "\\" && body[i + 1] === "|") {
      // GFM takes the backslash of an escaped pipe when it splits the row, inside a code span too.
      cell += "|";
      i++;
    } else if (c === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

/**
 * The URL a link opens, or null where the site must not link it. The URL is
 * resolved first, against the base where it is relative, and only an
 * http(s) result is linked, so no spelling of another scheme, such as one
 * with a tab or an entity inside it, gets through. A path from the root, as
 * `/docs/a.md`, opens in the base's repository at its ref, as GitHub reads
 * it in a file it shows.
 */
function target(url: string, base: string | null | undefined): string | null {
  let at: URL;
  try {
    const repo = /^(https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/)/.exec(base ?? "")?.[1];
    at = /^\/(?![/\\])/.test(url) && repo ? new URL(url.slice(1), repo) : base ? new URL(url, base) : new URL(url);
  } catch {
    return null;
  }
  if (at.protocol !== "http:" && at.protocol !== "https:") return null;
  // An absolute http(s) URL opens as the text writes it; any other opens where it resolves.
  return /^https?:\/\//i.test(url) ? url : at.href;
}

/** Markup with no text inside, which a cut can leave: an element opened before the budget ended and closed after. */
const EMPTY_ELEMENT = /<(strong|em|del|code|a)\b[^>]*><\/\1>/g;

/**
 * Text as HTML: escaped, and with `](` written as `]&#40;`, so a rendered
 * quote never holds what reads as a Markdown link, and the site check can
 * fail every one it finds.
 */
const textHtml = (s: string) => esc(s).replace(/\]\(/g, "]&#40;");

/** Renders Markdown nodes as HTML and as plain text, spending a budget of visible characters. */
class Renderer {
  html: string[] = [];
  text: string[] = [];
  private left: number;
  private done = false;
  /** Inside a link, where an image shows as its text, since a link can't hold another. */
  private linked = false;
  /** The Markdown being rendered, which a node's position indexes. */
  private src = "";
  constructor(
    private readonly base: string | null | undefined,
    max: number | undefined,
  ) {
    this.left = max ?? Number.POSITIVE_INFINITY;
  }

  /**
   * Visible text: escaped into the HTML. Where the budget ends inside it,
   * it is cut at its last space; a run with no space there, after text
   * already shown, is dropped, and the text before it ends the quote.
   */
  words(value: string, wrap?: [string, string]) {
    if (this.done || value === "") return;
    let shown = value;
    if (value.length > this.left) {
      this.done = true;
      const head = value.slice(0, this.left);
      const at = head.search(/\s\S*$/);
      if (at <= 0 && this.text.join("").trim() !== "") {
        this.ellipsis();
        return;
      }
      shown = `${(at > 0 ? head.slice(0, at) : head).trimEnd()}…`;
    }
    this.left -= value.length;
    this.html.push(wrap ? `${wrap[0]}${textHtml(shown)}${wrap[1]}` : textHtml(shown));
    this.text.push(shown);
  }

  /** Ends the quote after the text shown so far. */
  private ellipsis() {
    const i = this.text.length - 1;
    this.text[i] = `${this.text[i]!.trimEnd()}…`;
    // The HTML ends with that text, or with tags after it: the ellipsis goes after its last character.
    const j = this.html.length - 1 - [...this.html].reverse().findIndex((h) => !/^(<[^>]*>)*$/.test(h));
    this.html[j] = this.html[j]!.replace(/\s*((?:<\/[a-z]+>)*)$/, "…$1");
  }

  /** The source of a node, from one offset to another, with its whitespace collapsed. */
  private source(from: number | undefined, to: number | undefined) {
    if (from !== undefined && to !== undefined && to > from) this.words(this.src.slice(from, to).replace(/\s+/g, " "));
  }

  /** Renders a fragment of Markdown. */
  markdown(text: string) {
    const was = this.src;
    this.src = text;
    this.node(parseMarkdown(text));
    this.src = was;
  }

  nodes(nodes: readonly Nodes[]) {
    for (const n of nodes) {
      if (this.done) return;
      this.node(n);
    }
  }

  private wrap(open: string, close: string, children: readonly Nodes[]) {
    this.html.push(open);
    this.nodes(children);
    this.html.push(close);
  }

  /** A block and its children, with the source's text between them, such as a list item's "- " or a heading's closing "##", as the text it is. */
  private block(n: Nodes & { children: Nodes[] }, separator: string | null) {
    const p = n.position;
    let at = p?.start.offset;
    n.children.forEach((c, i) => {
      if (this.done) return;
      if (i > 0 && separator !== null) this.words(separator);
      else this.source(at, c.position?.start.offset);
      this.node(c);
      at = c.position?.end.offset;
    });
    if (!this.done) this.source(at, p?.end.offset);
  }

  node(n: Nodes) {
    switch (n.type) {
      case "root":
      case "list":
        // Blocks of one quote, such as two paragraphs or list items, read as one run of text.
        this.block(n as Nodes & { children: Nodes[] }, " ");
        return;
      case "paragraph":
        this.nodes(n.children);
        return;
      case "heading":
      case "blockquote":
      case "listItem":
        this.block(n as Nodes & { children: Nodes[] }, null);
        return;
      case "text":
        this.words(n.value);
        return;
      case "inlineCode":
        this.words(n.value, ["<code>", "</code>"]);
        return;
      case "strong":
        this.wrap("<strong>", "</strong>", n.children);
        return;
      case "emphasis":
        this.wrap("<em>", "</em>", n.children);
        return;
      case "delete":
        this.wrap("<del>", "</del>", n.children);
        return;
      case "break":
        if (!this.done) {
          this.html.push("<br>");
          this.text.push(" ");
        }
        return;
      case "link": {
        const href = this.linked ? null : target(n.url, this.base);
        if (href === null) this.nodes(n.children);
        else {
          this.linked = true;
          this.wrap(`<a href="${esc(href)}">`, "</a>", n.children);
          this.linked = false;
        }
        return;
      }
      case "image": {
        // An image shows as a link to it, by its alt text, or by its URL where it has none; inside a link, as that text alone.
        const href = this.linked ? null : target(n.url, this.base);
        const label = n.alt || n.url;
        if (href === null) this.words(label);
        else {
          this.html.push(`<a href="${esc(href)}">`);
          this.words(label);
          this.html.push("</a>");
        }
        return;
      }
      case "html":
        // A line break written as HTML breaks the line; any other tag shows as the text it is.
        if (/^<br\s*\/?>$/i.test(n.value.trim())) this.node({ type: "break" });
        else this.words(n.value);
        return;
      default:
        // Anything else, such as a code block with its fences, a reference with no definition, or a definition line, shows as the source writes it.
        this.source(n.position?.start.offset, n.position?.end.offset);
    }
  }

  result(): RenderedQuote {
    return { html: this.html.join("").replace(EMPTY_ELEMENT, ""), text: this.text.join("").replace(/\s+/g, " ").trim() };
  }
}

/**
 * Renders one quoted line, or one element's text, of a specification:
 * links as links, code spans as code, bold and italics, a line break; a
 * table row as its cells joined by " | ", and a block's marker, such as a
 * list item's "- ", as the text it is.
 */
export function renderQuote(source: string, o: QuoteOptions = {}): RenderedQuote {
  const r = new Renderer(o.base, o.max);
  const line = source.replace(/\r/g, "");
  if (/^\s*\|/.test(line) && !line.includes("\n")) {
    tableCells(line).forEach((cell, i) => {
      if (i > 0) r.words(" | ");
      r.markdown(cell);
    });
  } else {
    r.markdown(line);
  }
  return r.result();
}

/** A code block's text as a quote: shown as it is, its lines too, with no Markdown read in it. */
export function codeQuote(source: string): RenderedQuote {
  return { html: textHtml(source), text: source };
}

