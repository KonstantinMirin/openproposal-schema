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

export function tokenize(nodes: readonly PhrasingContent[], strong = false): Token[] {
  const out: Token[] = [];
  for (const node of nodes) {
    const line = node.position?.start.line ?? 0;
    switch (node.type) {
      case "text":
        out.push({ kind: "text", value: node.value, line, strong });
        break;
      case "inlineCode":
        out.push({ kind: "code", value: node.value, line, strong });
        break;
      case "break":
        out.push({ kind: "text", value: "\n", line, strong });
        break;
      case "strong":
        out.push(...tokenize(node.children, true));
        break;
      case "emphasis":
      case "delete":
      case "link":
      case "linkReference":
        out.push(...tokenize(node.children, strong));
        break;
      default:
        throw new ExtractError(`unsupported inline node "${node.type}"`, line);
    }
  }
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
