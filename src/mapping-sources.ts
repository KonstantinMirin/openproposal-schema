/**
 * The mapping gates on what the mapping adds to the IR: members the mapping
 * types, terms it lists, the presence it gives members, and the names of
 * the objects it defines. Each rests on the text of the elements it cites,
 * so a change to that text makes the decision stale:
 *
 * - sources: every member of a declared object, a profile, or a type entry
 *   whose element isn't an inline object is written by its own element or
 *   by an element a cited decision covers (no invented fields); every
 *   declared term is written by one of those elements; a required or
 *   conditional member has an element among them that states REQUIRED, MUST,
 *   or SHALL and names the member (type rules § 4); and an object that
 *   includes a profile restates none of the profile's fields and gives a
 *   field of the profile's document the document's type and presence
 *   (type rules § 3); and a type entry that places its vocabulary in the
 *   kernel, apart from its file's module, cites a decision with a sentence
 *   that says the type is the kernel's, and why;
 * - names: an object the mapping defines is named after the field or member
 *   that holds it, `<Field>`, `<Field>Entry`, or `<Field>Option`, unless a
 *   decision it cites names it (type rules § 7).
 */
import { canonicalJson } from "./canonical.ts";
import { pascalField } from "./constructors.ts";
import { inScopeDeclarations, inScopeEntries } from "./coverage.ts";
import { citeText, indexElements, type Element } from "./elements.ts";
import type { IrObjectForm, SpecIR } from "./ir-types.ts";
import { codeOfTerm, type Lists } from "./lists.ts";
import { decisionsOf, inScope, type Declaration, type DecisionRecord, type MappingFile, type Members, type Source, type TypeRef } from "./mapping.ts";
import { presenceOf } from "./mapping-rules.ts";

export interface SourcesResult {
  /** Members, terms, presence, and included profiles rest on cited text. */
  sources: string[];
  /** Mapping-defined objects follow the naming scheme, or a decision names them. */
  names: string[];
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;

/** The last segment of a path, without `[]`: `pricing[].floor` gives `floor`. */
const lastSegment = (path: string) => path.split(".").pop()!.replaceAll("[]", "");

function formKeys(form: IrObjectForm, out: Set<string>): void {
  for (const m of form.members) {
    out.add(m.key);
    if (m.value?.kind === "object") formKeys(m.value.object, out);
  }
}

/**
 * The identifiers an element writes: every name in its code spans, an inline
 * object's member keys, and a code block's keys, as in `list_ref: { url, sha256 }`.
 */
export function identifiersOf(e: Element): Set<string> {
  const out = new Set<string>();
  const text = citeText(e);
  for (const span of text.matchAll(/`([^`]+)`/g)) for (const m of span[1]!.matchAll(IDENT)) out.add(m[0]);
  if (e.kind === "inline_object") formKeys(e.element.form, out);
  if (e.kind === "code_block") {
    for (const m of text.matchAll(/(?:^|[\s{,[])"?([A-Za-z_][A-Za-z0-9_]*)"?\s*:/gm)) out.add(m[1]!);
    for (const m of text.matchAll(/\{([^{}:]*)\}/g)) for (const k of m[1]!.matchAll(IDENT)) out.add(k[0]);
  }
  return out;
}

/** Whether an element writes a term as a word of its text. */
const writesTerm = (e: Element, term: string) => new RegExp(`(^|[^A-Za-z0-9_])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_])`).test(citeText(e));

const REQUIRING = ["MUST", "SHALL", "REQUIRED"];

/**
 * The blocks a MUST, SHALL, or REQUIRED statement that ends with a colon
 * introduces: the next block, and each block after it that continues it with
 * "plus", as § 2.1's "It MUST contain, per line item:" introduces the
 * line-item paths and "plus, from the parent proposal: …" the proposal's.
 * None for any other statement.
 */
export function introducedBlocks(s: SpecIR["statements"][number], ir: SpecIR): string[] {
  const m = /^block:(.+):(\d+)$/.exec(s.host);
  if (!REQUIRING.includes(s.level) || !m || !s.text.trimEnd().endsWith(":")) return [];
  const out: string[] = [];
  for (let n = Number(m[2]) + 1; ; n++) {
    const host = `block:${m[1]}:${n}`;
    const continues = n === Number(m[2]) + 1 || ir.sentences.some((x) => x.host === host && /^plus\b/.test(x.text));
    if (!continues) break;
    out.push(host);
  }
  return out;
}

/** The identifier lists that a requiring statement introduces, so that each path a list names is required (type rules § 4). */
export function requiredLists(ir: SpecIR): Set<string> {
  const blocks = new Set(ir.statements.flatMap((s) => introducedBlocks(s, ir)));
  return new Set(ir.identifier_lists.filter((l) => blocks.has(l.host)).map((l) => l.id));
}

/**
 * Whether an element states that `key` is required: a field or key row named
 * `key` whose stated presence isn't optional, or a MUST, SHALL, or REQUIRED
 * statement that names `key`, or that ends with a colon and introduces the
 * next block, or a block after it that continues it with "plus", whose list
 * or object names `key` (as § 2.1's "It MUST contain, per line item:").
 */
function statesRequired(e: Element, key: string, ir: SpecIR): boolean {
  if (e.kind === "key") return lastSegment(e.element.key.path) === key && presenceOf(e.element) !== "optional";
  if (e.kind === "field") return e.element.names.some((n) => lastSegment(n.path) === key) && presenceOf(e.element) !== "optional";
  if (e.kind !== "statement" || !REQUIRING.includes(e.element.level)) return false;
  if (e.element.identifiers.some((id) => lastSegment(id) === key)) return true;
  const blocks = new Set(introducedBlocks(e.element, ir));
  const introduced: Element[] = [
    ...ir.identifier_lists.filter((l) => blocks.has(l.host)).map((element) => ({ kind: "identifier_list" as const, element })),
    ...ir.inline_objects.filter((o) => blocks.has(o.host)).map((element) => ({ kind: "inline_object" as const, element })),
  ];
  return introduced.some((x) => identifiersOf(x).has(key));
}

/** A set of members the mapping types, where it sits, and what it rests on. */
interface MemberSet {
  where: string;
  members: Members;
  /** Whether the keys are checked here; an inline object's keys are the IR's, which the location gate checks. */
  keys: boolean;
  /** Its own element and every element a cited decision covers on the lock. */
  sources: Element[];
}

/** Checks the mapping's additions against the text of the elements they cite, on one lock. */
export function checkSources(ir: SpecIR, lock: string, mappings: MappingFile[], decisions: DecisionRecord[], lists?: Lists): SourcesResult {
  const result: SourcesResult = { sources: [], names: [] };
  const elements = indexElements(ir);
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const entries = inScopeEntries(mappings, lock);
  const declarations = inScopeDeclarations(mappings, lock);

  /** The element a type comes from, and every element its decisions cover on the lock. */
  const sourcesOf = (own: string | undefined, source: Source): Element[] => {
    const ids = new Set<string>(own === undefined ? [] : [own]);
    for (const id of decisionsOf(source)) for (const c of byId.get(id)?.covers ?? []) if (inScope(c.locks, lock)) ids.add(c.ir);
    return [...ids].flatMap((id) => (elements.has(id) ? [elements.get(id)!] : []));
  };

  const sets: MemberSet[] = [];
  for (const [id, { entry, file }] of entries) {
    const as = entry.as;
    const members = as.role === "type" || as.role === "members" || as.role === "profile" ? as.members : undefined;
    if (!members) continue;
    sets.push({ where: `${file.file}: entry "${id}"`, members, keys: elements.get(id)?.kind !== "inline_object", sources: sourcesOf(id, entry.source) });
  }
  for (const { decl, file } of declarations) {
    if (decl.members) sets.push({ where: `${file.file}: type "${decl.name}"`, members: decl.members, keys: true, sources: sourcesOf(decl.ir, decl.source) });
  }

  // A path a decision reads from a prose item: each member it steps through is written by an element the entry rests on.
  for (const [id, { entry, file }] of entries) {
    if (entry.as.role !== "profile") continue;
    const sources = sourcesOf(id, entry.source);
    for (const path of (entry.as.reads ?? []).flatMap((r) => r.paths)) {
      for (const key of path.split(".").map((x) => x.replaceAll("[]", ""))) {
        if (!sources.some((e) => identifiersOf(e).has(key))) {
          result.sources.push(`${file.file}: entry "${id}": path "${path}": member "${key}" is written by none of the elements it rests on (its own element and those its decisions cover on lock "${lock}"); cover the element that writes it (type rules § 4)`);
        }
      }
    }
  }

  // A type entry that places its vocabulary in the kernel, apart from its file's module, cites a decision that says why: one
  // of its sentences says that the type, written as code, is the kernel's, and gives a reason ("so", "because", "since").
  for (const [id, { entry, file }] of entries) {
    const as = entry.as;
    if (as.role !== "type" || as.module !== "kernel" || file.module === "kernel") continue;
    const placed = new RegExp(`\`${as.name}\` (?:is|belongs to) the kernel(?:'s)?\\b`);
    const says = decisionsOf(entry.source).some((d) => {
      const r = byId.get(d);
      return r !== undefined && [r.rationale, ...r.options.map((o) => o.summary)].some((t) => t.replace(/\s+/g, " ").split(/(?<=\.)\s+/).some((x) => placed.test(x) && /\b(?:so|because|since)\b/.test(x)));
    });
    if (!says) result.sources.push(`${file.file}: entry "${id}": places "${as.name}" in the kernel, but no decision it cites says why: cite one with a sentence that says why \`${as.name}\` is the kernel's (type rules § 3)`);
  }

  for (const s of sets) {
    for (const [key, member] of Object.entries(s.members)) {
      if (s.keys && !s.sources.some((e) => identifiersOf(e).has(key))) {
        result.sources.push(
          `${s.where}: member "${key}" is written by none of the elements it rests on (its own element and those its decisions cover on lock "${lock}"); cover the element that writes it, or leave it out and make the object open (type rules § 4)`,
        );
      }
      if (member.presence !== "optional" && !s.sources.some((e) => statesRequired(e, key, ir))) {
        result.sources.push(
          `${s.where}: member "${key}" is ${member.presence}, but no element it rests on states REQUIRED, MUST, or SHALL for "${key}" on lock "${lock}"; a member is optional unless a statement requires it and a decision covers that statement (type rules § 4)`,
        );
      }
    }
  }

  for (const { decl, file } of declarations) {
    const where = `${file.file}: type "${decl.name}"`;
    const sources = sourcesOf(decl.ir, decl.source);
    if (decl.list !== undefined) result.sources.push(...listProblems(where, decl, sources, decisionsOf(decl.source).flatMap((id) => byId.get(id)?.evidence ?? []), lists));
    else {
      for (const term of decl.terms ?? []) {
        if (!sources.some((e) => writesTerm(e, term))) {
          result.sources.push(`${where}: term "${term}" is written by none of the elements it rests on (its own element and those its decisions cover on lock "${lock}"); cover the element that writes it`);
        }
      }
    }
    if (decl.includes !== undefined) result.sources.push(...includeProblems(where, decl.includes, decl.members ?? {}, entries, elements));
  }

  result.names.push(...nameProblems(entries, declarations, elements, byId));
  return result;
}

/**
 * A vocabulary that cites another standard's code list (type rules § 6):
 * the list is defined, each term stands for one of its codes and each code
 * has a term, and the list is named by an element the vocabulary rests on,
 * or a decision it cites gives the list's URL as evidence.
 */
function listProblems(where: string, decl: Declaration, sources: Element[], evidence: string[], lists: Lists | undefined): string[] {
  const ref = decl.list!;
  const list = lists?.lists.find((l) => l.name === ref.name);
  if (!list) return [`${where}: cites the list "${ref.name}", which kernel/lists.yaml doesn't define`];
  const out: string[] = [];
  const terms = decl.terms ?? [];
  const shown = `${list.standard} ${list.name}`;
  for (const t of Object.keys(ref.codes ?? {})) if (!terms.includes(t)) out.push(`${where}: maps "${t}" to a code of ${shown}, but "${t}" is none of its terms`);
  const used = new Map<string, string>();
  for (const t of terms) {
    const c = codeOfTerm(list, t, ref.codes);
    if (c === undefined) out.push(`${where}: term "${t}" stands for no code of ${shown}; spell it as the code, or map it to the code under the list's codes`);
    else if (used.has(String(c.code))) out.push(`${where}: terms "${used.get(String(c.code))}" and "${t}" stand for one code of ${shown}, ${JSON.stringify(c.code)}`);
    else used.set(String(c.code), t);
  }
  for (const c of list.codes) if (!used.has(String(c.code))) out.push(`${where}: the code ${JSON.stringify(c.code)} of ${shown} has no term; a vocabulary that cites a list holds each of its codes`);
  if (!sources.some((e) => citeText(e).includes(list.name)) && !evidence.includes(list.url)) {
    out.push(`${where}: no element it rests on names ${shown}, and no decision it cites gives ${list.url} as evidence; cover the element that cites the list, or give the list as the decision's evidence`);
  }
  return out;
}

/** The fields of a profile, and the document it projects, from its entries' identifier lists and members. */
function profileFields(name: string, entries: ReturnType<typeof inScopeEntries>, elements: Map<string, Element>): { document: string; fields: Set<string> } | null {
  let document: string | null = null;
  const fields = new Set<string>();
  for (const [id, { entry }] of entries) {
    const as = entry.as;
    if (as.role !== "profile" || as.document + as.profile !== name) continue;
    document = as.document;
    const e = elements.get(id);
    if (e?.kind === "identifier_list") for (const i of e.element.items) if (i.code) fields.add(i.text.split(".")[0]!.replaceAll("[]", ""));
    for (const path of (as.reads ?? []).flatMap((r) => r.paths)) fields.add(path.split(".")[0]!.replaceAll("[]", ""));
    for (const k of Object.keys(as.members ?? {})) fields.add(k);
  }
  return document === null ? null : { document, fields };
}

/** An object that includes a profile restates none of its fields, and gives a field of its document the document's type and presence. */
function includeProblems(where: string, profile: string, members: Members, entries: ReturnType<typeof inScopeEntries>, elements: Map<string, Element>): string[] {
  const p = profileFields(profile, entries, elements);
  if (!p) return [`${where}: includes "${profile}", which is no profile the mapping defines`];
  const problems: string[] = [];
  for (const [key, member] of Object.entries(members)) {
    if (p.fields.has(key)) {
      problems.push(`${where}: member "${key}" is a field of the profile "${profile}" it includes; the profile defines it once (type rules § 3)`);
      continue;
    }
    for (const [id, { entry }] of entries) {
      const as = entry.as;
      const e = elements.get(id);
      if (as.role !== "property" || as.object !== p.document || e?.kind !== "field" || e.element.names[0]!.segments.length !== 1 || lastSegment(e.element.names[0]!.path) !== key) continue;
      if (canonicalJson(as.type) !== canonicalJson(member.type) || as.presence !== member.presence) {
        problems.push(`${where}: member "${key}" is ${JSON.stringify(member)}, but ${p.document}.${key} is ${JSON.stringify({ type: as.type, presence: as.presence })}; a field restated from the document keeps its type and presence (type rules § 3)`);
      }
    }
  }
  return problems;
}

/** The name the § 7 scheme gives a type `x` that `t` holds under the field or member `holder`, or null if `t` doesn't hold it directly. */
function schemeName(holder: string, t: TypeRef, x: string): string | null {
  const p = pascalField(holder);
  if (t.kind === "named") return t.name === x ? p : null;
  if (t.kind !== "apply") return null;
  const arg = t.arguments.T;
  if (t.constructor === "List") return arg?.kind === "named" && arg.name === x ? `${p}Entry` : null;
  if (["Selectable", "Settable"].includes(t.constructor) && arg) {
    const option = arg.kind === "apply" && arg.constructor === "CatalogRefOr" ? arg.arguments.T : arg;
    return option?.kind === "named" && option.name === x ? `${p}Option` : null;
  }
  return null;
}

/**
 * Every object the mapping defines is named as the field or member that
 * holds it makes it: `<Field>` for its value, `<Field>Entry` for an item of
 * its list, and `<Field>Option` for an option of its `available[]` or
 * `allowed[]`. An object that no field holds directly, such as a union
 * branch, follows no scheme. A decision the object cites may name it
 * instead, by writing the name as code.
 */
function nameProblems(
  entries: ReturnType<typeof inScopeEntries>,
  declarations: ReturnType<typeof inScopeDeclarations>,
  elements: Map<string, Element>,
  byId: Map<string, DecisionRecord>,
): string[] {
  const holders: { holder: string; type: TypeRef }[] = [];
  const addMembers = (m: Members | undefined) => {
    for (const [key, v] of Object.entries(m ?? {})) holders.push({ holder: key, type: v.type });
  };
  for (const [id, { entry }] of entries) {
    const as = entry.as;
    const e = elements.get(id);
    if (as.role === "property" && (e?.kind === "field" || e?.kind === "key")) holders.push({ holder: lastSegment(e.kind === "field" ? e.element.names[0]!.path : e.element.key.path), type: as.type });
    if (as.role === "type" || as.role === "members" || as.role === "profile") addMembers(as.members);
  }
  for (const { decl } of declarations) addMembers(decl.members);

  const objects: { name: string; where: string; source: Source }[] = [];
  for (const [id, { entry, file }] of entries) if (entry.as.role === "type" && entry.as.layer === "object") objects.push({ name: entry.as.name, where: `${file.file}: entry "${id}"`, source: entry.source });
  for (const { decl, file } of declarations) if (decl.kind === "object") objects.push({ name: decl.name, where: `${file.file}: type "${decl.name}"`, source: decl.source });

  const problems: string[] = [];
  const seen = new Set<string>();
  for (const o of objects) {
    if (seen.has(o.name)) continue;
    seen.add(o.name);
    const expected = [...new Set(holders.flatMap((h) => schemeName(h.holder, h.type, o.name) ?? []))].sort();
    if (expected.length === 0 || (expected.length === 1 && expected[0] === o.name)) continue;
    const named = decisionsOf(o.source).some((id) => {
      const d = byId.get(id);
      return d !== undefined && [d.question, d.rationale, ...d.options.map((x) => x.summary)].some((t) => t.includes(`\`${o.name}\``));
    });
    if (named) continue;
    problems.push(
      expected.length === 1
        ? `${o.where}: the field or member that holds "${o.name}" names it "${expected[0]}" (type rules § 7); rename it, or cite a decision that names it`
        : `${o.where}: "${o.name}" is held by fields or members that name it ${expected.map((x) => `"${x}"`).join(", ")}; cite a decision that names it (type rules § 7)`,
    );
  }
  return problems;
}
