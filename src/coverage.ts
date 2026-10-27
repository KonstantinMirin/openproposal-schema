/**
 * The mapping gates beyond the per-entry checks in `mapping.ts`:
 *
 * - bijection: every IR element on a lock has exactly one in-scope entry,
 *   in the module that owns its section, and every module owns its sections
 *   alone;
 * - location: a field or key row is a property of the object its path names,
 *   with the presence the specification states, and an inline object's
 *   members are the IR's members, typed to match their `[]` and value lists;
 * - rules: every rule entry and rule declaration is what its rule derives,
 *   and no entry cites a decision where a rule applies;
 * - types: every type the mapping names is defined exactly once.
 */
import { canonicalJson } from "./canonical.ts";
import type { Constructors } from "./constructors.ts";
import { indexElements } from "./elements.ts";
import type { IrMember, IrObjectForm, SpecIR } from "./ir-types.ts";
import { kernelOn, type Kernel } from "./kernel.ts";
import { inScope, type Declaration, type MappingEntry, type MappingFile, type Members, type TypeRef } from "./mapping.ts";
import { DECLARATION_RULES, firstRule, objectOfField, objectOfKey, presenceOf, type RuleContext } from "./mapping-rules.ts";

/** The sections each module owns on a lock, with a problem for a section that two modules claim. */
function sectionOwners(mappings: MappingFile[], problems: string[]): Map<string, string> {
  const owner = new Map<string, string>();
  for (const m of mappings) {
    for (const s of m.sections) {
      const first = owner.get(s);
      if (first !== undefined) problems.push(`${m.file}: section "${s}" is also owned by module "${first}"`);
      else owner.set(s, m.module);
    }
  }
  return owner;
}

/** The in-scope entries on a lock, by IR element ID. A duplicate is `checkMapping`'s to report; the first one wins here. */
export function inScopeEntries(mappings: MappingFile[], lock: string): Map<string, { entry: MappingEntry; file: MappingFile }> {
  const out = new Map<string, { entry: MappingEntry; file: MappingFile }>();
  for (const m of mappings) for (const entry of m.entries) if (inScope(entry.locks, lock) && !out.has(entry.ir)) out.set(entry.ir, { entry, file: m });
  return out;
}

/** The in-scope declarations on a lock, with their files. */
export function inScopeDeclarations(mappings: MappingFile[], lock: string): { decl: Declaration; file: MappingFile }[] {
  return mappings.flatMap((m) => (m.types ?? []).filter((d) => inScope(d.locks, lock)).map((decl) => ({ decl, file: m })));
}

/** The context the mapping rules read on one lock. */
export function ruleContext(ir: SpecIR, lock: string, mappings: MappingFile[], kernel: Kernel, constructors: Constructors): RuleContext {
  const owners = sectionOwners(mappings, []);
  const entries = new Map([...inScopeEntries(mappings, lock)].map(([id, x]) => [id, x.entry]));
  return { ir, elements: indexElements(ir), kernel, constructors, entries, moduleOf: (s) => owners.get(s) };
}

export interface CoverageResult {
  /** Bijection and module placement. */
  coverage: string[];
  /** Property locations, presence, and inline-object members. */
  location: string[];
  /** Rule entries and rule declarations reproduce. */
  rules: string[];
  /** Every named type is defined once, and every reference resolves. */
  types: string[];
}

/** Runs the mapping gates on one lock's IR. */
export function checkCoverage(ir: SpecIR, lock: string, mappings: MappingFile[], kernel: Kernel, constructors: Constructors): CoverageResult {
  const result: CoverageResult = { coverage: [], location: [], rules: [], types: [] };
  const owners = sectionOwners(mappings, result.coverage);
  const ctx = ruleContext(ir, lock, mappings, kernel, constructors);
  const entries = inScopeEntries(mappings, lock);
  const declarations = inScopeDeclarations(mappings, lock);

  // Bijection: every section has a module, every element an entry in its section's module.
  for (const s of ir.sections) if (!owners.has(s.id)) result.coverage.push(`section "${s.id}" (${s.title}) on lock "${lock}" belongs to no module; list it in one mapping file's "sections"`);
  for (const [id, e] of ctx.elements) {
    const found = entries.get(id);
    if (!found) {
      result.coverage.push(`"${id}" (${e.kind}, § ${e.element.loc.section}) has no entry on lock "${lock}"; run: npm run map`);
      continue;
    }
    const module = owners.get(e.element.loc.section);
    if (module !== undefined && module !== found.file.module) {
      result.coverage.push(`${found.file.file}: entry "${id}" sits in § ${e.element.loc.section}, which module "${module}" owns`);
    }
  }
  for (const { decl, file } of declarations) {
    const e = decl.ir === undefined ? undefined : ctx.elements.get(decl.ir);
    if (!e) continue;
    const module = owners.get(e.element.loc.section);
    if (module !== undefined && module !== file.module) result.coverage.push(`${file.file}: type "${decl.name}" comes from "${decl.ir}" in § ${e.element.loc.section}, which module "${module}" owns`);
  }

  const defined = definedTypes(kernel, constructors, mappings, lock, result.types);

  // Location: rows are properties of the object their path names, with their stated presence.
  for (const [id, { entry, file }] of entries) {
    const e = ctx.elements.get(id);
    if (!e) continue;
    const where = `${file.file}: entry "${id}"`;
    const as = entry.as;
    if (as.role === "property") {
      if (e.kind !== "field" && e.kind !== "key") {
        result.location.push(`${where}: only a field or key row becomes a property, not a ${e.kind}`);
        continue;
      }
      const object = e.kind === "field" ? objectOfField(e.element) : objectOfKey(ir, e.element);
      if (object !== null && object !== as.object) result.location.push(`${where}: the row's path makes it a property of "${object}", not "${as.object}"`);
      if (object === null) result.location.push(`${where}: the row's path names no object; map it to the constructor or part it defines`);
      const presence = presenceOf(e.element);
      if (presence !== as.presence) result.location.push(`${where}: presence is "${as.presence}", but the specification states "${presence}" (type rules § 4)`);
    }
    if ((as.role === "type" && (as.layer === "object" || as.layer === "document")) || as.role === "members") {
      if (e.kind !== "inline_object") continue;
      if (!as.members) {
        result.location.push(`${where}: an inline object's type lists its members`);
        continue;
      }
      result.location.push(...memberProblems(where, e.element.id, e.element.form, as.members, ctx, defined));
    }
  }

  // Rules: each rule entry is what the first rule that applies derives, and no decision overrides a rule.
  for (const [id, { entry, file }] of entries) {
    const e = ctx.elements.get(id);
    if (!e) continue;
    const derived = firstRule(e, ctx);
    const where = `${file.file}: entry "${id}"`;
    if (!("rule" in entry.source)) {
      if (derived) result.rules.push(`${where}: rule "${derived.rule}" applies on lock "${lock}", so the entry cites it, not a decision record; a decision covers only what no rule decides`);
      continue;
    }
    if (!derived) result.rules.push(`${where}: cites rule "${entry.source.rule}", but no mapping rule applies on lock "${lock}"; cite a decision record`);
    else if (derived.rule !== entry.source.rule || canonicalJson(derived.as) !== canonicalJson(entry.as)) {
      result.rules.push(`${where}: rule "${derived.rule}" derives ${JSON.stringify(derived.as)} on lock "${lock}"; the entry says rule "${entry.source.rule}" and ${JSON.stringify(entry.as)}; run: npm run map`);
    }
  }
  for (const rule of DECLARATION_RULES) {
    const derived = rule.derive(ctx);
    for (const d of derived) {
      const found = declarations.find((x) => x.decl.name === d.name);
      if (!found) result.rules.push(`rule "${rule.id}" declares "${d.name}" on lock "${lock}", and no mapping file does; run: npm run map`);
      else if ("rule" in found.decl.source && canonicalJson(withoutLocks(found.decl)) !== canonicalJson(d)) {
        result.rules.push(`${found.file.file}: type "${d.name}" differs from what rule "${rule.id}" declares on lock "${lock}": ${JSON.stringify(d)}; run: npm run map`);
      }
    }
  }
  for (const { decl, file } of declarations) {
    if (!("rule" in decl.source)) continue;
    const rule = DECLARATION_RULES.find((r) => r.id === (decl.source as { rule: string }).rule);
    if (!rule) result.rules.push(`${file.file}: type "${decl.name}" cites "${(decl.source as { rule: string }).rule}", which is no declaration rule`);
    else if (!rule.derive(ctx).some((d) => d.name === decl.name)) result.rules.push(`${file.file}: type "${decl.name}" cites rule "${rule.id}", which doesn't declare it on lock "${lock}"`);
  }

  result.types.push(...referenceProblems(entries, declarations, defined, lock));
  return result;
}

const withoutLocks = (d: Declaration): Declaration => {
  const { locks: _locks, ...rest } = d;
  return rest;
};

/** Each IR member is a member of the type, typed to match its `[]`, its value list, and its nested object. */
function memberProblems(where: string, objectId: string, form: IrObjectForm, members: Members, ctx: RuleContext, defined: Map<string, DefinedType>): string[] {
  const problems: string[] = [];
  const ir = new Map<string, IrMember>(form.members.map((m) => [m.key, m]));
  for (const key of ir.keys()) if (!(key in members)) problems.push(`${where}: the IR member "${key}" has no type`);
  for (const key of Object.keys(members)) if (!ir.has(key)) problems.push(`${where}: member "${key}" isn't in the IR object; the mapping can't add members (no invented fields)`);
  for (const [key, m] of ir) {
    const member = members[key];
    if (!member) continue;
    const t = member.type;
    const isList = t.kind === "apply" && t.constructor === "List";
    if (m.array && !isList) problems.push(`${where}: member "${key}" is written with [] in the specification, so its type is a List`);
    const value = m.value;
    if (value?.kind === "values") {
      const item = isList ? (t as Extract<TypeRef, { kind: "apply" }>).arguments.T! : t;
      const listId = value.value_list ?? `${objectId}/${key}`;
      const as = ctx.entries.get(listId)?.as;
      const vocab = as?.role === "type" || as?.role === "same" ? as.name : null;
      if (vocab === null) problems.push(`${where}: member "${key}" lists values, and its value list "${listId}" defines no vocabulary`);
      else if (item.kind !== "named" || item.name !== vocab) problems.push(`${where}: member "${key}" lists the values of "${vocab}", so its type is "${vocab}"`);
    }
    if (value?.kind === "object") {
      const keys = value.object.members.map((x) => x.key).sort();
      const shell = t.kind === "apply" ? ctx.constructors.constructors.find((c) => c.name === t.constructor)?.shell : undefined;
      const props = shell && typeof shell.properties === "object" ? Object.keys(shell.properties as object).sort() : null;
      const named = t.kind === "named" ? defined.get(t.name)?.members : undefined;
      const have = props ?? (named ? Object.keys(named).sort() : null);
      if (have === null || canonicalJson(have) !== canonicalJson(keys)) problems.push(`${where}: member "${key}" is the object { ${keys.join(", ")} }, so its type has exactly those members`);
    }
  }
  return problems;
}

/** A type the model defines, as the reference check sees it. */
interface DefinedType {
  layer: "primitive" | "constructor" | "part" | "vocabulary" | "object" | "document" | "union" | "profile";
  where: string;
  members?: Members;
}

/** Every named type on a lock: primitives, constructors, parts, type entries, declarations, and profiles. A name defined twice is a problem. */
function definedTypes(kernel: Kernel, constructors: Constructors, mappings: MappingFile[], lock: string, problems: string[]): Map<string, DefinedType> {
  const defined = new Map<string, DefinedType>();
  const define = (name: string, t: DefinedType) => {
    const first = defined.get(name);
    if (first && !(first.layer === "profile" && t.layer === "profile")) problems.push(`${t.where}: "${name}" is already defined by ${first.where} on lock "${lock}"`);
    else defined.set(name, t);
  };
  for (const p of kernelOn(kernel, lock).primitives) define(p.name, { layer: "primitive", where: kernel.file });
  for (const c of constructors.constructors) define(c.name, { layer: "constructor", where: constructors.file });
  for (const p of constructors.parts) define(p.name, { layer: "part", where: constructors.file });
  for (const m of mappings) {
    for (const e of m.entries) {
      if (!inScope(e.locks, lock)) continue;
      const where = `${m.file}: entry "${e.ir}"`;
      if (e.as.role === "type") define(e.as.name, { layer: e.as.layer, where, ...(e.as.members ? { members: e.as.members } : {}) });
      if (e.as.role === "profile") define(e.as.document + e.as.profile, { layer: "profile", where });
    }
    for (const d of m.types ?? []) if (inScope(d.locks, lock)) define(d.name, { layer: d.kind, where: `${m.file}: type "${d.name}"`, ...(d.members ? { members: d.members } : {}) });
  }
  // Members a `members` entry adds belong to the declared object.
  for (const m of mappings) {
    for (const e of m.entries) {
      if (!inScope(e.locks, lock) || e.as.role !== "members") continue;
      const t = defined.get(e.as.object);
      if (t) t.members = { ...(t.members ?? {}), ...e.as.members };
    }
  }
  return defined;
}

/** Every named type in a type, at any depth. */
const namesIn = (t: TypeRef): string[] => (t.kind === "named" ? [t.name] : t.kind === "apply" ? Object.values(t.arguments).flatMap(namesIn) : []);

/** Every reference in the mapping resolves to a defined type of the right kind. */
function referenceProblems(
  entries: Map<string, { entry: MappingEntry; file: MappingFile }>,
  declarations: { decl: Declaration; file: MappingFile }[],
  defined: Map<string, DefinedType>,
  lock: string,
): string[] {
  const problems: string[] = [];
  const need = (where: string, name: string, layers: DefinedType["layer"][] | null, what: string) => {
    const t = defined.get(name);
    if (!t) problems.push(`${where}: "${name}" is no type the model defines on lock "${lock}"`);
    else if (layers && !layers.includes(t.layer)) problems.push(`${where}: "${name}" is a ${t.layer}, and ${what}`);
  };
  const value: DefinedType["layer"][] = ["primitive", "part", "vocabulary", "object", "document", "union", "profile"];
  const typeNames = (where: string, types: TypeRef[]) => {
    for (const t of types) for (const n of namesIn(t)) need(where, n, value, "a value's type is a primitive, part, vocabulary, object, union, or profile");
  };
  const memberTypes = (m: Members | undefined) => Object.values(m ?? {}).map((x) => x.type);
  for (const [id, { entry, file }] of entries) {
    const where = `${file.file}: entry "${id}"`;
    const as = entry.as;
    switch (as.role) {
      case "property":
        need(where, as.object, ["object", "document"], "a property belongs to an object or a document");
        typeNames(where, [as.type]);
        break;
      case "type":
        typeNames(where, memberTypes(as.members));
        break;
      case "members":
        need(where, as.object, ["object"], "only an object takes more members");
        typeNames(where, memberTypes(as.members));
        break;
      case "profile":
        need(where, as.document, ["document"], "a profile projects a document");
        typeNames(where, memberTypes(as.members));
        break;
      case "same":
        need(where, as.name, ["vocabulary", "object", "part"], "an element restates a vocabulary, an object, or a part");
        break;
      case "term":
        need(where, as.vocabulary, ["vocabulary"], "a term belongs to a vocabulary");
        break;
      case "rule":
        need(where, as.object, ["vocabulary", "object", "document", "union", "constructor", "part"], "a rule is owned by an object, a document, a union, a constructor, a part, or the `Marker` vocabulary");
        break;
      case "schema":
        need(where, as.in, null, "");
        break;
      case "example":
        need(where, as.object, ["object", "document"], "an example shows an object or a document");
        break;
    }
  }
  for (const { decl, file } of declarations) {
    const where = `${file.file}: type "${decl.name}"`;
    typeNames(where, [...memberTypes(decl.members), ...(decl.any_of ?? [])]);
    if (decl.kind === "vocabulary" && !decl.terms && !decl.open && ![...entries.values()].some((x) => x.entry.as.role === "term" && x.entry.as.vocabulary === decl.name)) {
      problems.push(`${where}: a declared closed vocabulary lists its terms, or term entries define them; only an open vocabulary may have no core terms`);
    }
  }
  return problems;
}
