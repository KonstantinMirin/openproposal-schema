import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { citeText, indexElements } from "../src/elements.ts";
import type { SpecIR } from "../src/ir-types.ts";
import { checkSite } from "../src/site/build.ts";
import { inline } from "../src/site/html.ts";
import { codeQuote, renderQuote, tableCells } from "../src/site/quote.ts";

import { ROOT } from "./helpers.ts";

/** Every file under a folder whose name ends with `suffix`. */
const findFiles = (dir: string, suffix: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(suffix)).map((d) => join(d.parentPath, d.name));

const AD = "https://github.com/InteractiveAdvertisingBureau/AdCOM/blob/26c59ba/AdCOM%20v1.0%20FINAL.md";

test("a quote renders its link as a link, its code as code, and keeps every word", () => {
  const q = renderQuote(`One value from [List: API Frameworks](${AD}#list_apiframeworks), such as \`7\` **or** *8*.`);
  assert.equal(q.html, `One value from <a href="${AD}#list_apiframeworks">List: API Frameworks</a>, such as <code>7</code> <strong>or</strong> <em>8</em>.`);
  assert.equal(q.text, "One value from List: API Frameworks, such as 7 or 8.");
});

test("a table row reads as its cells, with an escaped pipe kept as text", () => {
  assert.deepEqual(tableCells("| `api[]` | OPTIONAL | a \\| b |"), ["`api[]`", "OPTIONAL", "a | b"]);
  // GFM takes an escaped pipe's backslash inside a code span too, as GitHub shows OpenProposal's § 5.6 row.
  assert.equal(renderQuote("| `{ delta_cpm \\| delta_flat }` | x |").html, "<code>{ delta_cpm | delta_flat }</code> | x");
  const q = renderQuote("| `api[]` | OPTIONAL | Values from [List: API Frameworks](#list_apiframeworks) |", { base: AD });
  assert.equal(q.html, `<code>api[]</code> | OPTIONAL | Values from <a href="${AD}#list_apiframeworks">List: API Frameworks</a>`);
  assert.equal(renderQuote("| a \\| b | c |").text, "a | b | c");
});

test("a relative link opens against the base, and with none, or with a scheme the site doesn't link, shows its text alone", () => {
  assert.equal(renderQuote("[x](#list_a)", { base: AD }).html, `<a href="${AD}#list_a">x</a>`);
  assert.equal(renderQuote("[x](#list_a)").html, "x");
  assert.equal(renderQuote("[x](javascript:alert(1))", { base: AD }).html, "x");
  // A URL that names another host resolves to it, as an absolute one does; a scheme other than http(s), however spelled, is no link.
  assert.equal(renderQuote("[x](//other.example/a)", { base: AD }).html, '<a href="https://other.example/a">x</a>');
  assert.equal(renderQuote("[x](java&#9;script:alert(1))", { base: AD }).html, "x");
  assert.equal(renderQuote("[x](<java\tscript:alert(1)>)", { base: AD }).html, "x");
  assert.equal(renderQuote("[x](mailto:a@example.com)", { base: AD }).html, "x");
  assert.equal(renderQuote("[x](other.md)").html, "x");
  // A path from the root opens in the base's repository at its ref, as GitHub reads it.
  assert.equal(renderQuote("[x](/docs/a.md)", { base: "https://github.com/o/r/blob/abc/spec/f.md" }).html, '<a href="https://github.com/o/r/blob/abc/docs/a.md">x</a>');
  assert.equal(renderQuote('[a"b](https://example.com/?q="x")').html, '<a href="https://example.com/?q=&quot;x&quot;">a&quot;b</a>');
});

test("HTML and markers in a quote show as the text they are, and an image as a link by its alt text", () => {
  assert.equal(renderQuote("a <script>x</script> b").html, "a &lt;script&gt;x&lt;/script&gt; b");
  assert.equal(renderQuote("a<br>b").html, "a<br>b");
  assert.equal(renderQuote("- one item").text, "- one item");
  assert.equal(renderQuote("### List: Device Types").text, "### List: Device Types");
  assert.equal(renderQuote("[x]: https://example.com").text, "[x]: https://example.com");
  assert.equal(renderQuote("Refer to ![image](https://example.com/a.png).").html, 'Refer to <a href="https://example.com/a.png">image</a>.');
  // An image with no alt text shows its URL, and an image inside a link shows as text, so no link holds another.
  assert.equal(renderQuote("![](https://example.com/a.png)").text, "https://example.com/a.png");
  assert.equal(renderQuote("[![logo](https://example.com/a.png)](https://example.com/)").html, '<a href="https://example.com/">logo</a>');
  // A block's markers show as written: a closing ATX run, a setext underline, a code fence, and a marker with no content.
  assert.equal(renderQuote("## Title ##").text, "## Title ##");
  assert.equal(renderQuote("Title\n===").text, "Title ===");
  assert.equal(renderQuote("```json\n{ *a* }\n```").text, "```json { *a* } ```");
  assert.equal(renderQuote("-").text, "-");
  // Text that writes `](` shows it, but never as what reads as a Markdown link.
  assert.equal(renderQuote("\\[x\\](#y)").html, "[x]&#40;#y)");
  assert.equal(renderQuote("Array[String] and [a] b").text, "Array[String] and [a] b");
});

test("a long quote is cut on the text a reader sees, at a word, and a cut link keeps its target", () => {
  const q = renderQuote(`[List: Plcmt Subtypes - Video](${AD}#list_plcmtsubtypesvideo) and more words after it`, { max: 20 });
  assert.equal(q.html, `<a href="${AD}#list_plcmtsubtypesvideo">List: Plcmt…</a>`);
  assert.equal(renderQuote("short", { max: 20 }).html, "short");
  assert.equal(renderQuote("`abcdefghijkl` tail", { max: 5 }).html, "<code>abcde…</code>");
  // A run cut with no space in it, after text shown, is dropped whole, and the quote ends at the text before it.
  assert.equal(renderQuote("abc **def** ghi", { max: 5 }).html, "abc…");
  assert.equal(renderQuote("[ab](https://a.example/) [cd](https://c.example/)", { max: 3 }).html, '<a href="https://a.example/">ab</a>…');
});

test("a code block's quote shows as written, with no Markdown read", () => {
  assert.deepEqual(codeQuote("a: [x](y)\n  b: `c`"), { html: "a: [x]&#40;y)\n  b: `c`", text: "a: [x](y)\n  b: `c`" });
});

test("the site check fails a quote that shows a Markdown link as text, on a page and in a type map's data", () => {
  const page = Buffer.from(`<!doctype html><main><blockquote>see [List: X](https://example.com/a#b)</blockquote></main>`);
  const data = Buffer.from(JSON.stringify({ types: [], sources: { a: { quote: { html: "[x](#y)", text: "x" } } } }));
  const problems = checkSite(new Map([["s/index.html", page], ["s/data/main.as-written.json", data]]));
  assert.ok(problems.some((p) => p.startsWith('s/index.html: a quote shows a Markdown link as text, at "[List: X](https://example.com/a#b)')), problems.join("\n"));
  assert.ok(problems.some((p) => p.startsWith('s/data/main.as-written.json: a quote shows a Markdown link as text, at "[x](#y)')), problems.join("\n"));
  // Faithful text the renderer wrote, a code span's `](` too, passes; a quote left a plain string fails.
  const rendered = Buffer.from(`<!doctype html><nav aria-label="Site"><a href="../index.html">All specifications</a></nav><main><blockquote>${renderQuote("use `[text](https://a.example/)` and \\[x\\](#y)").html}</blockquote></main>`);
  assert.deepEqual(checkSite(new Map([["s/index.html", rendered], ["index.html", Buffer.from("<!doctype html>")]])), []);
  const plain = Buffer.from(JSON.stringify({ types: [], sources: { a: { quote: "x" } } }));
  assert.match(checkSite(new Map([["s/data/main.as-written.json", plain]])).join("\n"), /the source a's quote isn't rendered/);
});

/** A text's words, in order: what a reader reads, with each link's or image's destination left out, since it shows as the link itself, but an image with no alt text, which shows its URL; with each `<br>` a line break; and with each character reference read as the space or character it is. */
const wordsOf = (s: string) =>
  s
    .replace(/!\[\]\(\s*<?([^)\s>]*)>?\s*\)/g, " $1 ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\]\(\s*<?[^)\s>]*>?(?:\s+"[^"]*")?\s*\)/g, "] ")
    .replace(/&(?:[a-z]+|#\d+);/gi, " ")
    .match(/[\p{L}\p{N}]+/gu) ?? [];

test("every element's quote and every line of every specification renders with the words its source writes, none added or dropped", () => {
  const texts: string[] = [];
  for (const spec of ["openproposal", "adcom"]) {
    const root = join(ROOT, "specs", spec);
    for (const ir of findFiles(join(root, "ir"), "spec-ir.json")) for (const e of indexElements(JSON.parse(readFileSync(ir, "utf8")) as SpecIR).values()) if (e.kind !== "code_block") texts.push(citeText(e));
    for (const md of findFiles(join(root, "spec-input", "snapshots"), ".md")) texts.push(...readFileSync(md, "utf8").split("\n"));
  }
  assert.ok(texts.length > 5000, `${texts.length} texts`);
  const differ = texts.filter((t) => wordsOf(renderQuote(t).text).join(" ") !== wordsOf(t).join(" "));
  assert.deepEqual(differ.slice(0, 8), [], `${differ.length} of ${texts.length} texts render with other words`);
});

test("a record's Markdown link shows as a link to an http(s) URL, and as its text to anywhere else", () => {
  assert.equal(inline("needs an [untagged union](#untagged-unions) of the two", ""), "needs an untagged union of the two");
  assert.equal(inline("see [AdCOM](https://example.com/a?b=1&c=2)", ""), 'see <a href="https://example.com/a?b=1&amp;c=2">AdCOM</a>');
  assert.equal(inline("`[x](y)` stays code", ""), "<code>[x](y)</code> stays code");
});
