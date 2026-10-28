import { canonicalJson, sha256 } from "./canonical.ts";
import type {
  AppendixARow,
  AppendixBRow,
  CodeBlock,
  Concept,
  Definition,
  Field,
  IdentifierList,
  InlineObject,
  Key,
  MarkerDef,
  SpecIR,
  Sentence,
  Statement,
  ValueList,
} from "./ir-types.ts";

/**
 * Every IR element that has an ID and can be mapped. Sections, tables, and
 * code spans are structure, not elements: their content is in the elements
 * they hold.
 */
export type Element =
  | { kind: "field"; element: Field }
  | { kind: "key"; element: Key }
  | { kind: "definition"; element: Definition }
  | { kind: "marker"; element: MarkerDef }
  | { kind: "concept"; element: Concept }
  | { kind: "value_list"; element: ValueList }
  | { kind: "inline_object"; element: InlineObject }
  | { kind: "statement"; element: Statement }
  | { kind: "sentence"; element: Sentence }
  | { kind: "identifier_list"; element: IdentifierList }
  | { kind: "code_block"; element: CodeBlock }
  | { kind: "appendix_a"; element: AppendixARow }
  | { kind: "appendix_b"; element: AppendixBRow };

/** Indexes the IR's elements by ID. Fails on a duplicate ID, which the extractor already rules out. */
export function indexElements(ir: SpecIR): Map<string, Element> {
  const all: Element[] = [
    ...ir.fields.map((element) => ({ kind: "field" as const, element })),
    ...ir.keys.map((element) => ({ kind: "key" as const, element })),
    ...ir.definitions.map((element) => ({ kind: "definition" as const, element })),
    ...ir.markers.map((element) => ({ kind: "marker" as const, element })),
    ...ir.concepts.map((element) => ({ kind: "concept" as const, element })),
    ...ir.value_lists.map((element) => ({ kind: "value_list" as const, element })),
    ...ir.inline_objects.map((element) => ({ kind: "inline_object" as const, element })),
    ...ir.statements.map((element) => ({ kind: "statement" as const, element })),
    ...ir.sentences.map((element) => ({ kind: "sentence" as const, element })),
    ...ir.identifier_lists.map((element) => ({ kind: "identifier_list" as const, element })),
    ...ir.code_blocks.map((element) => ({ kind: "code_block" as const, element })),
    ...(ir.appendix_a?.rows ?? []).map((element) => ({ kind: "appendix_a" as const, element })),
    ...(ir.appendix_b?.rows ?? []).map((element) => ({ kind: "appendix_b" as const, element })),
  ];
  const index = new Map<string, Element>();
  for (const e of all) {
    if (index.has(e.element.id)) throw new Error(`duplicate IR element ID "${e.element.id}"`);
    index.set(e.element.id, e);
  }
  return index;
}

/**
 * The digest a mapping entry or decision record stores. A table row and a
 * code block carry the extractor's digest of their source bytes. Any other
 * element gets the SHA-256 of its canonical JSON without `loc`, so moving it
 * to another line doesn't make it stale, but changing its content does.
 */
export function elementDigest(e: Element): string {
  if ("digest" in e.element) return e.element.digest;
  const { loc: _loc, ...content } = e.element;
  return sha256(canonicalJson(content));
}

const code = (s: string) => `\`${s}\``;
const cells = (parts: (string | null | undefined)[]) => parts.filter((p): p is string => p !== null && p !== undefined && p !== "").join(" | ");

/** The element's text, one deterministic rendering per kind. Decision records quote it. */
export function citeText(e: Element): string {
  switch (e.kind) {
    case "field": {
      const f = e.element;
      // A Type cell that also states the presence and the default is quoted whole.
      return cells([f.names.map((n) => code(n.path)).join(" · "), f.type_cell ?? f.type.raw, f.marker, f.description.text]);
    }
    case "key": {
      const k = e.element;
      return cells([code(k.key.path), k.required?.raw, k.meaning.text, k.mapping?.text]);
    }
    case "definition":
      return cells([code(e.element.value), ...e.element.columns.map((c) => c.text)]);
    case "marker":
      return cells([code(e.element.marker), e.element.meaning.text]);
    case "concept":
      return cells(e.element.columns.map((c) => c.text));
    case "value_list":
      return cells(e.element.items.map((i) => (i.annotation ? `${code(i.value)} (${i.annotation})` : code(i.value))));
    case "inline_object":
      return e.element.text;
    case "statement":
    case "sentence":
      return e.element.text;
    case "identifier_list":
      return e.element.items.map((i) => (i.code ? code(i.text) : i.text)).join(" · ");
    case "code_block":
      return e.element.text;
    case "appendix_a": {
      const a = e.element;
      return cells([a.names.map((n) => code(n.path)).join(" · "), a.section_cell, a.type.raw, a.marker]);
    }
    case "appendix_b": {
      const b = e.element;
      return cells([code(b.marker), b.count_cell, b.meaning]);
    }
  }
}
