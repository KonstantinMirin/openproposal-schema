import { ExtractError } from "../errors.ts";

/**
 * An inline object form such as `{ a, b: x | y, c: { d, e }, f[] }`.
 *
 * Members separated by `,` are all present (`all`). Members separated by `|`
 * are alternatives (`one_of`), as in `{ delta_cpm | delta_flat | delta_pct }`.
 */
export interface ObjectForm {
  combinator: "all" | "one_of";
  members: MemberForm[];
}

export interface MemberForm {
  key: string;
  array: boolean;
  value: null | { kind: "object"; object: ObjectForm } | { kind: "values"; items: string[] };
}

type Tok = { t: "{" | "}" | "," | "|" | ":" | "[]" } | { t: "word"; v: string };

function lex(src: string, fail: (why: string) => never): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if ("{},|:".includes(ch)) {
      out.push({ t: ch as "{" });
      i++;
    } else if (src.startsWith("[]", i)) {
      out.push({ t: "[]" });
      i += 2;
    } else {
      const m = /^[A-Za-z0-9_][A-Za-z0-9_-]*/.exec(src.slice(i));
      if (!m) fail(`unexpected "${ch}" at offset ${i}`);
      out.push({ t: "word", v: m![0] });
      i += m![0].length;
    }
  }
  return out;
}

/** Parses one balanced `{ … }` form. `src` must start with `{` and end with `}`. */
export function parseInlineObject(src: string, line?: number): ObjectForm {
  const fail = (why: string): never => {
    throw new ExtractError(`unparsed inline object "${src}": ${why}`, line);
  };
  const toks = lex(src, fail);
  let pos = 0;
  const peek = () => toks[pos];
  const take = (t: Tok["t"]) => {
    const tok = toks[pos];
    if (!tok || tok.t !== t) fail(`expected "${t}" at token ${pos}`);
    pos++;
    return tok!;
  };
  const word = (): string => {
    const tok = toks[pos];
    if (!tok || tok.t !== "word") return fail(`expected a name at token ${pos}`);
    pos++;
    return tok.v;
  };
  const object = (): ObjectForm => {
    take("{");
    const members: MemberForm[] = [member()];
    let combinator: ObjectForm["combinator"] | null = null;
    while (peek()?.t === "," || peek()?.t === "|") {
      const sep = peek()!.t === "," ? "all" : "one_of";
      if (combinator && combinator !== sep) fail("mixes `,` and `|` between members");
      combinator = sep;
      pos++;
      members.push(member());
    }
    take("}");
    return { combinator: combinator ?? "all", members };
  };
  const member = (): MemberForm => {
    const key = word();
    let array = false;
    if (peek()?.t === "[]") {
      pos++;
      array = true;
    }
    if (peek()?.t !== ":") return { key, array, value: null };
    pos++;
    if (peek()?.t === "{") return { key, array, value: { kind: "object", object: object() } };
    const items = [word()];
    // A `|` followed by a word and then `:` starts the next one_of member, not another value.
    while (peek()?.t === "|" && toks[pos + 1]?.t === "word" && toks[pos + 2]?.t !== ":") {
      pos++;
      items.push(word());
    }
    return { key, array, value: { kind: "values", items } };
  };
  const out = object();
  if (pos !== toks.length) fail(`unexpected trailing tokens after the closing brace`);
  return out;
}

/** Returns the offset of the brace that closes the one at `start`, or -1. */
export function matchBrace(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
