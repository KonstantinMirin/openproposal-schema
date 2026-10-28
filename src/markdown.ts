import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { PhrasingContent, Root } from "mdast";
import { ExtractError } from "./errors.ts";

export function parseMarkdown(text: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(text) as Root;
}

/**
 * One run of inline content. Strong, emphasis, and link wrappers are
 * flattened away; their text and code spans stay, in order.
 */
export interface Token {
  kind: "text" | "code";
  value: string;
  /** Source line where the token starts. */
  line: number;
  /** Inside `**…**`. */
  strong: boolean;
}

/**
 * The inline HTML a text may write, as GitHub renders it: an anchor (`<a
 * name>` or `<a href>`), whose text stays; a line break; a code span; bold;
 * and italics. Any other tag fails extraction.
 */
const INLINE_TAG = /^<(\/?)(a|br|code|strong|b|em|i)(?:\s+[a-z][a-z0-9_:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*(\/?)>$/i;

/** A tag left in text, which the Markdown parser didn't read as HTML. */
const RAW_TAG = /<\/?[A-Za-z][A-Za-z0-9]*(?:\s+[A-Za-z][\w:-]*\s*=|\s*\/?>)/;

/**
 * Puts back an anchor whose `href` is written without quotes, as AdCOM's `<a
 * href=https://…#710---updated-video-signals>implementation guide</a>`: GFM's
 * autolink reads the URL and the start of the anchor's text as one link, and
 * leaves `<a href=` as text. The anchor's text keeps what follows the `>`, as
 * GitHub shows it.
 */
function repairUnquotedAnchors(nodes: readonly PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const next = nodes[i + 1];
    if (node.type === "text" && /<a\s+href=$/i.test(node.value) && next?.type === "link" && next.url.includes(">")) {
      out.push({ ...node, value: node.value.replace(/<a\s+href=$/i, "") });
      const shown = (next.children as PhrasingContent[]).map((c) => (c.type === "text" ? c.value : "")).join("");
      out.push({ type: "text", value: shown.slice(shown.indexOf(">") + 1), position: next.position });
      i++;
      continue;
    }
    out.push(node);
  }
  return out;
}

export function tokenize(nodes: readonly PhrasingContent[], strong = false): Token[] {
  const out: Token[] = [];
  nodes = repairUnquotedAnchors(nodes);
  // Inline HTML opens and closes across sibling nodes: `<code>`, text, `</code>`.
  let bold = 0;
  let code: { value: string; line: number } | null = null;
  for (const node of nodes) {
    const line = node.position?.start.line ?? 0;
    if (code !== null && node.type !== "html") {
      if (node.type !== "text") throw new ExtractError(`unsupported "${node.type}" inside an HTML <code>`, line);
      code.value += node.value;
      continue;
    }
    if (code !== null && node.type === "html" && !/^<\/code\s*>$/i.test(node.value.trim())) throw new ExtractError(`HTML "${node.value.trim()}" inside an HTML <code>`, line);
    switch (node.type) {
      case "text":
        // A tag the parser left as text would be read as words; it fails instead.
        if (RAW_TAG.test(node.value)) throw new ExtractError(`an HTML tag the Markdown parser left as text: "${RAW_TAG.exec(node.value)![0]}"`, line);
        out.push({ kind: "text", value: node.value, line, strong: strong || bold > 0 });
        break;
      case "inlineCode":
        out.push({ kind: "code", value: node.value, line, strong: strong || bold > 0 });
        break;
      case "break":
        out.push({ kind: "text", value: "\n", line, strong: strong || bold > 0 });
        break;
      case "strong":
        out.push(...tokenize(node.children, true));
        break;
      case "emphasis":
      case "delete":
      case "link":
      case "linkReference":
        out.push(...tokenize(node.children, strong || bold > 0));
        break;
      case "image":
        // An image carries no text of the specification's; its alt text, if any, reads as text.
        if (node.alt) out.push({ kind: "text", value: node.alt, line, strong: strong || bold > 0 });
        break;
      case "html": {
        const m = INLINE_TAG.exec(node.value.trim());
        if (!m) throw new ExtractError(`unsupported inline HTML "${node.value.trim()}"`, line);
        const [, close, tag] = m as unknown as [string, string, string];
        const name = tag.toLowerCase();
        if (name === "br") out.push({ kind: "text", value: "\n", line, strong: strong || bold > 0 });
        else if (name === "code") {
          if (close) {
            if (code === null) throw new ExtractError("a </code> with no <code> before it", line);
            out.push({ kind: "code", value: code.value, line: code.line, strong: strong || bold > 0 });
            code = null;
          } else code = { value: "", line };
        } else if (name === "strong" || name === "b") {
          if (close && bold === 0) throw new ExtractError(`a </${tag}> with no <${tag}> before it`, line);
          bold += close ? -1 : 1;
        }
        break;
      }
      default:
        throw new ExtractError(`unsupported inline node "${node.type}"`, line);
    }
  }
  if (code !== null) throw new ExtractError("an HTML <code> with no </code>", code.line);
  return out;
}

/** Renders tokens back to one line of text, with code spans in backticks. */
export function render(tokens: readonly Token[]): string {
  return collapse(tokens.map((t) => (t.kind === "code" ? "`" + t.value + "`" : t.value)).join(""));
}

/** Renders tokens as plain text, without backticks. */
export function plain(tokens: readonly Token[]): string {
  return collapse(tokens.map((t) => t.value).join(""));
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The line of a character offset inside a text token, counting its soft line breaks. */
export function lineAt(token: Token, offset: number): number {
  let line = token.line;
  for (let i = 0; i < offset && i < token.value.length; i++) if (token.value[i] === "\n") line++;
  return line;
}
