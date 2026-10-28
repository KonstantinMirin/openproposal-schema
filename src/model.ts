/**
 * Stage 4, resolve: combines one lock's IR, the mapping, the decision
 * records, the kernel primitives, and the constructors into the model
 * (`build/model.json`), the one source every emitter reads.
 *
 * The model names every type once, with its kind, its layer (type rules § 3),
 * its module, the IR elements and decisions it rests on, and the named types
 * its emitted schema references. A constructor's copies are applied here, so
 * every copy an emitter writes is in the model with its filled shell. The
 * rules, obligations, schema statements, and examples are listed with the
 * text they come from.
 *
 * Resolution is a pure function of its inputs. Every map is keyed by name and
 * every list is sorted, so the order of mapping files, entries, and
 * declarations doesn't change a byte of the output.
 */
import { canonicalJson, sha256 } from "./canonical.ts";
import { copyName, fieldOf, Instantiator, partSchema, renderType, slots, substitute, type Constructor, type Constructors, type Model as Templates } from "./constructors.ts";
import { inScopeDeclarations, inScopeEntries } from "./coverage.ts";
import { citeText, indexElements, type Element } from "./elements.ts";
import type { Presence as StatedPresence } from "./grammar/required.ts";
import type { SpecIR } from "./ir-types.ts";
import { kernelOn, primitiveStructure, type Kernel } from "./kernel.ts";
import { codeOfTerm } from "./lists.ts";
import { conceptOfType } from "./domains.ts";
import { decisionsOf, type DecisionRecord, type MappingFile, type Members, type Presence, type Source, type TypeRef } from "./mapping.ts";
import { KERNEL_MODULE, restatesPart } from "./mapping-rules.ts";
import { requiredLists } from "./mapping-sources.ts";

/** Each kind of named type, with the layer type rules § 3 puts it in. A copy's layer is computed (`copyLayer`). */
export const LAYER = { primitive: 1, constructor: 2, part: 2, vocabulary: 3, object: 4, union: 4, document: 5, profile: 5 } as const;

export type Kind = keyof typeof LAYER | "copy";

/** A property of an object, a document, or a profile. */
export interface ModelProperty {
  type: TypeRef;
  presence: Presence;
  /** The condition of a conditional property, as the specification writes it, or as a basis of the domain model reads it (type rules § 3a). */
  condition?: string;
  /** The property's type while a sibling holds one term, narrowing `type`, as a basis of the domain model reads it (type rules § 3a). */
  cases?: { when: { member: string; value: string }; type: { kind: "named"; name: string } }[];
  /** The row's mutability marker, from a field row's Mutability cell or a key row's Required cell; a rule, never a schema keyword (type rules § 2). */
  marker?: string;
  /** The row's description or meaning. */
  description?: string;
  /** The IR elements that state it. */
  sources: string[];
  /**
   * The constructor that gives the property to an object option, where the
   * option is named by a member it carries (type rules § 7, D-046): the
   * property is the constructor's, and the text may write no such member.
   */
  given?: string;
}

/** The primitive an open vocabulary's extension terms are: a vendor's code where its list reserves codes for vendors, a namespaced term otherwise (type rules § 6). */
export const VENDOR_CODE = "VendorCode";
export const extensionOf = (t: { list?: { vendor?: unknown }; vendor?: unknown; extension?: string }): string => t.extension ?? ((t.vendor ?? t.list?.vendor) !== undefined ? VENDOR_CODE : "NamespacedTerm");

export interface ModelTerm {
  /** The term as the specification spells it; a decimal integer is a JSON integer (type rules § 6). */
  value: string | number;
  /** A code system's label, such as "Connected TV" for `3`. */
  annotation?: string;
  sources: string[];
}

interface Base {
  name: string;
  kind: Kind;
  layer: number;
  module: string;
  /** The IR elements that define the type, on this lock. */
  sources: string[];
  /** The decision records the definition cites. */
  decisions: string[];
  /** Every named type the type's emitted schema references, sorted. */
  references: string[];
}

export type ModelType = Base &
  (
    | { kind: "primitive"; description: string; schema: Record<string, unknown>; rules: string[] }
    | { kind: "constructor"; description: string; parameters: Constructor["parameters"]; naming: Constructor["naming"]; shell: Record<string, unknown>; fallback?: Constructor["fallback"]; rules: string[] }
    | { kind: "part"; description: string; schema: Record<string, unknown> }
    | { kind: "copy"; of: Extract<TypeRef, { kind: "apply" }>; application: string; fallback: boolean; schema: Record<string, unknown> }
    | {
        kind: "vocabulary";
        open: boolean;
        terms: ModelTerm[];
        /** The code list of another standard whose codes the terms are (type rules § 6), with the codes it reserves for vendors. */
        list?: { name: string; standard: string; url: string; vendor?: { from: number; label: string } };
        /** For the specification's own code list: the codes it reserves for vendors, from `from` up, with their row's label. */
        vendor?: { from: number; label: string };
        /** The kernel primitive an open vocabulary's extension terms are, where a decision gives one other than a vendor's code or a namespaced term. */
        extension?: string;
        /** A list of the specification's own, whose terms take their rows' text as labels: each code means what its label says. */
        labeled?: true;
        /** What the terms mean where no row says, from the declaration. */
        description?: string;
        /**
         * The model attribute whose values the vocabulary lists, when every
         * term is a § 3 marker row: the vocabulary types `ModelProperty.marker`,
         * not a payload value. A marker is a rule about two versions of a
         * payload, so the schema leaves such a vocabulary out (type rules § 2)
         * and the model keeps it as the owner of the marker rules (D-012).
         */
        attribute?: "marker";
      }
    | {
        kind: "object";
        open: boolean;
        /** What the object holds, from its declaration: for an open object, what the text says of it, since it names no members. */
        description?: string;
        includes?: string;
        /** The type a profile's projection restricts to the members its paths name (type rules § 3), such as `PricingEntry` for the summary's pricing entries. */
        projects?: string;
        properties: Record<string, ModelProperty>;
        dependent_required?: Record<string, string[]>;
      }
    | { kind: "union"; any_of: TypeRef[] }
    | { kind: "document"; properties: Record<string, ModelProperty>; dependent_required?: Record<string, string[]> }
    | { kind: "profile"; document: string; fields: string[]; paths: string[]; properties: Record<string, ModelProperty>; dependent_required?: Record<string, string[]> }
  );

/** A statement the model places: a rule with its owner, an obligation with its party, a statement a schema expresses, or an example. */
export interface ModelStatement {
  ir: string;
  text: string;
  /** The RFC 2119 level, for a statement. */
  level?: string;
  decisions: string[];
}

/**
 * A rule of a primitive, a part, or a constructor (type rules § 9), with its sources
 * and its vectors as the kernel files state them. A constructor rule's
 * vectors are values of the template applied to `arguments`; every copy of
 * the constructor carries the rule.
 */
export interface ModelKernelRule {
  id: string;
  owner: string;
  statement: string;
  /** The IR elements it rests on. */
  sources: string[];
  decisions: string[];
  standard?: { name: string; url: string };
  arguments?: Record<string, TypeRef>;
  valid: unknown[];
  invalid: unknown[];
}

export interface ModelModule {
  name: string;
  sections: string[];
  /** The other modules its types reference, the kernel aside; the convention gate checks them against the mapping file's `depends` (type rules § 3). */
  references: string[];
}

export interface ModelDoc {
  format: 1;
  /** `variant` names the variant the model resolves (src/variant.ts); the schemas we propose have none. */
  input: { lock: string; commit: string; blob: string; ir_sha256: string; variant?: string };
  modules: ModelModule[];
  types: ModelType[];
  rules: (ModelStatement & { owner: string })[];
  kernel_rules: ModelKernelRule[];
  obligations: (ModelStatement & { party: string })[];
  schema_statements: (ModelStatement & { in: string })[];
  examples: (ModelStatement & { object: string })[];
  /** How many elements are informative text or rendered output, which no type carries. */
  counts: { informative: number; rendered: number };
  /**
   * Every decision record a mapping entry or a declaration in scope on the
   * lock cites, whatever its role, sorted. A property or an informative row
   * keeps no decision of its own, so this list is what keeps such a decision
   * in the model; with the kernel's, which the types and kernel rules carry,
   * it names every decision the model rests on (gate 6).
   */
  decisions: string[];
}

export interface ResolveInput {
  ir: SpecIR;
  lock: string;
  mappings: MappingFile[];
  decisions: DecisionRecord[];
  kernel: Kernel;
  constructors: Constructors;
  /**
   * The option objects a constructor gives no member the text doesn't write,
   * for a variant that switches that departure off (src/variant.ts); none in
   * the schemas we propose.
   */
  withhold?: string[];
}

const lastSegment = (path: string) => path.split(".").pop()!.replaceAll("[]", "");
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const byKey = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const INTEGER = /^-?(0|[1-9][0-9]*)$/;

/** Every `$ref` name in a filled schema, as the instantiator writes it (`#/$defs/<name>`). */
export function refNames(schema: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "$ref" && typeof x === "string") out.push(x.replace(/^#\/\$defs\//, ""));
        else walk(x);
      }
    }
  };
  walk(schema);
  return out;
}

/** The text and level of a statement element, or the cite text of any other element. */
function statementOf(e: Element | undefined, ir: string, source: Source): ModelStatement {
  const decisions = decisionsOf(source);
  if (!e) return { ir, text: "", decisions };
  if (e.kind === "statement") return { ir, text: e.element.text, level: e.element.level, decisions };
  return { ir, text: citeText(e), decisions };
}

/**
 * A row's mutability marker: a field row's Mutability cell, or the marker a
 * key row writes in its Required cell, as `derived_units` writes `derived`.
 * Every field carries one (§ 3), and a key table has no Mutability column.
 */
function markerOf(e: Element): string | undefined {
  if (e.kind === "field") return e.element.marker;
  const p = e.kind === "key" ? e.element.required?.parsed : undefined;
  return p?.kind === "marker" ? p.marker : undefined;
}

/** The condition text of a conditional row, as its presence clauses write it. */
function conditionOf(e: Element): string | undefined {
  return conditionText(e.kind === "field" ? e.element.presence : e.kind === "key" ? (e.element.required?.parsed ?? null) : null);
}

/**
 * The condition a presence statement writes: each clause that has one, as
 * `<level> <qualifier> <condition>`, and a `with` clause by the members it
 * names, as "REQUIRED with `daypart` or `frequency_cap.period`".
 */
export function conditionText(p: StatedPresence | null): string | undefined {
  if (p === null || p.kind !== "clauses") return undefined;
  const parts = p.clauses
    .filter((c) => c.condition !== null)
    .map((c) => (c.qualifier === "with" && c.members ? `${c.level} with ${c.members.map((m) => `\`${m}\``).join(" or ")}` : `${c.level} ${c.qualifier} ${c.condition}`));
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/**
 * Resolves the model for one lock. Returns the model and the problems found
 * while resolving it: a name defined twice, a property of no object, a term
 * of no vocabulary, a restated list that differs from its vocabulary, a
 * profile field the document lacks, or a copy that no single module owns.
 * The convention checks run on the result (`src/conventions.ts`).
 */
export function resolveModel(input: ResolveInput): { model: ModelDoc; problems: string[] } {
  const { ir, lock, mappings, constructors } = input;
  const kernel = kernelOn(input.kernel, lock);
  const problems: string[] = [];
  const elements = indexElements(ir);
  const entries = inScopeEntries(mappings, lock);
  const declarations = inScopeDeclarations(mappings, lock);
  const templates: Templates = { kernel, constructors };
  const types = new Map<string, ModelType>();

  const define = (t: ModelType, where: string) => {
    if (types.has(t.name)) problems.push(`${where}: "${t.name}" is already defined in the model on lock "${lock}"`);
    else types.set(t.name, t);
  };
  const base = (name: string, kind: Kind, module: string, sources: string[], decisions: string[]) => ({
    name,
    kind,
    layer: kind === "copy" ? 0 : LAYER[kind],
    module,
    sources: sorted(sources),
    decisions: sorted(decisions),
    references: [] as string[],
  });

  // The kernel: primitives, constructors, and parts. A source or a decision that lists its locks applies only on them.
  const onLock = (locks: string[] | undefined) => locks === undefined || locks.includes(lock);
  const decided = (x: { decision?: string; decision_locks?: string[] }) => (x.decision && onLock(x.decision_locks) ? [x.decision] : []);
  const partDecisions = (p: { decisions?: { decision: string; locks?: string[] }[] }) => (p.decisions ?? []).filter((d) => onLock(d.locks)).map((d) => d.decision);
  for (const p of kernel.primitives) {
    define(
      {
        ...base(p.name, "primitive", KERNEL_MODULE, (p.sources.spec ?? []).filter((c) => onLock(c.locks)).map((c) => c.ir), decided(p)),
        kind: "primitive",
        description: p.description,
        schema: { description: p.description, ...primitiveStructure(p) },
        rules: (p.rules ?? []).map((r) => r.id),
      },
      kernel.file,
    );
  }
  for (const c of constructors.constructors) {
    define(
      {
        ...base(c.name, "constructor", KERNEL_MODULE, c.sources.spec.map((s) => s.ir), c.fallback ? [c.fallback.decision] : []),
        kind: "constructor",
        description: c.description,
        // What an option carries is written in its type's field order, wherever the kernel and the spec's binding give each field.
        parameters: c.parameters.map((p) => (p.carries ? { ...p, carries: { member: p.carries.member, decision: p.carries.decision, ...(p.carries.departure !== undefined ? { departure: p.carries.departure } : {}), description: p.carries.description } } : p)),
        naming: c.naming,
        shell: c.shell,
        ...(c.fallback ? { fallback: c.fallback } : {}),
        rules: (c.rules ?? []).map((r) => r.id),
      },
      constructors.file,
    );
  }
  for (const p of constructors.parts) {
    define(
      {
        ...base(p.name, "part", KERNEL_MODULE, p.sources.spec.filter((s) => onLock(s.locks)).map((s) => s.ir), partDecisions(p)),
        kind: "part",
        description: p.description,
        schema: partSchema(p, constructors),
      },
      constructors.file,
    );
  }

  /** The field each property's copies are named after (type rules § 7): a row's field, or a member's key. */
  const namedAfter = new WeakMap<ModelProperty, string | undefined>();
  const properties = (members: Members | undefined, sources: string[]): Record<string, ModelProperty> =>
    Object.fromEntries(
      Object.entries(members ?? {}).map(([k, m]) => {
        const p: ModelProperty = { type: m.type, presence: m.presence, sources, ...(m.description ? { description: m.description } : {}) };
        namedAfter.set(p, k);
        return [k, p];
      }),
    );

  // The vocabularies whose terms take their definition rows' text as their labels.
  const labeled = new Set<string>();
  // Declarations: the types no single element defines.
  for (const { decl, file } of declarations) {
    const where = `${file.file}: type "${decl.name}"`;
    const b = base(decl.name, decl.kind, file.module, decl.ir ? [decl.ir] : [], decisionsOf(decl.source));
    const sources = decl.ir ? [decl.ir] : [];
    switch (decl.kind) {
      case "document":
        define({ ...b, kind: "document", properties: properties(decl.members, sources) }, where);
        break;
      case "object":
        define({ ...b, kind: "object", open: decl.open ?? false, ...(decl.description ? { description: decl.description } : {}), ...(decl.includes ? { includes: decl.includes } : {}), properties: properties(decl.members, sources) }, where);
        break;
      case "vocabulary": {
        // A vocabulary that cites a code list labels each term with its code's label, or with the code where the list spells it differently.
        const list = decl.list ? kernel.lists?.lists.find((l) => l.name === decl.list!.name) : undefined;
        if (decl.list && !list) problems.push(`${where}: cites the list "${decl.list.name}", which kernel/lists.yaml doesn't define`);
        const terms = (decl.terms ?? []).map((value) => {
          const c = list ? codeOfTerm(list, value, decl.list!.codes) : undefined;
          const annotation = c?.label ?? (c !== undefined && String(c.code) !== value ? String(c.code) : undefined);
          return { value, ...(annotation !== undefined ? { annotation } : {}), sources };
        });
        if (list && (decl.open ?? false) !== (list.vendor !== undefined)) problems.push(`${where}: is ${decl.open ? "open" : "closed"}, but ${list.standard} ${list.name} ${list.vendor ? "reserves codes for vendors" : "reserves no codes for vendors"}; a vocabulary that cites a list is open exactly when the list reserves vendor codes (type rules § 6)`);
        const vendorCode = kernel.primitives.find((p) => p.name === VENDOR_CODE);
        if (list?.vendor && vendorCode?.constraints.minimum !== list.vendor.from) problems.push(`${where}: ${list.standard} ${list.name} reserves vendor codes from ${list.vendor.from}, but ${VENDOR_CODE} starts at ${vendorCode?.constraints.minimum ?? "no minimum"}`);
        // The specification's own list: its vendor range, or the extension a decision gives, makes it open, and nothing else does.
        if (decl.vendor && list) problems.push(`${where}: gives both a list and its own vendor range; a list's vendor range is the list's`);
        if (decl.vendor && vendorCode?.constraints.minimum !== decl.vendor.from) problems.push(`${where}: reserves vendor codes from ${decl.vendor.from}, but ${VENDOR_CODE} starts at ${vendorCode?.constraints.minimum ?? "no minimum"}`);
        if (decl.vendor && decl.extension) problems.push(`${where}: gives both a vendor range and an extension, which can't both be its extension terms`);
        if ((decl.vendor !== undefined || decl.extension !== undefined) && !decl.open) problems.push(`${where}: has ${decl.vendor ? "a vendor range" : "an extension"}, so it is open`);
        if (decl.extension !== undefined && !kernel.primitives.some((p) => p.name === decl.extension)) problems.push(`${where}: its extension "${decl.extension}" is no kernel primitive`);
        if (decl.labeled) labeled.add(decl.name);
        define({ ...b, kind: "vocabulary", open: decl.open ?? false, terms, ...(list ? { list: { name: list.name, standard: list.standard, url: list.url, ...(list.vendor ? { vendor: list.vendor } : {}) } } : {}), ...(decl.vendor ? { vendor: decl.vendor } : {}), ...(decl.extension ? { extension: decl.extension } : {}), ...(decl.labeled ? { labeled: true as const } : {}), ...(decl.description ? { description: decl.description } : {}) }, where);
        break;
      }
      case "union":
        define({ ...b, kind: "union", any_of: decl.any_of ?? [] }, where);
        break;
    }
  }

  // Type entries, then everything that adds to a type.
  // Specification order, so terms keep the order the text lists them in; the ID breaks a tie.
  const line = (id: string) => elements.get(id)?.element.loc.line ?? 0;
  const ordered = [...entries].sort(([a], [b]) => line(a) - line(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const [id, { entry, file }] of ordered) {
    const as = entry.as;
    if (as.role !== "type") continue;
    const where = `${file.file}: entry "${id}"`;
    const e = elements.get(id);
    // A vocabulary no module owns, as the two parties every § 3 marker names, is the kernel's, beside `Marker`; its entry
    // stays in the file of the module that owns its element's section (type rules § 3, § 11).
    const b = base(as.name, as.layer, as.module ?? file.module, [id], decisionsOf(entry.source));
    switch (as.layer) {
      case "vocabulary": {
        const terms = e?.kind === "value_list" ? e.element.items.map((i) => ({ value: i.value, ...(i.annotation ? { annotation: i.annotation } : {}), sources: [id] })) : [];
        define({ ...b, kind: "vocabulary", open: as.open ?? false, terms }, where);
        break;
      }
      case "object":
        define({ ...b, kind: "object", open: as.open ?? false, properties: properties(as.members, [id]) }, where);
        break;
      case "document":
        define({ ...b, kind: "document", properties: properties(as.members, [id]) }, where);
        break;
      default:
        problems.push(`${where}: a mapping entry can't define a ${as.layer}; ${as.layer}s are the kernel's`);
    }
  }

  const rules: ModelDoc["rules"] = [];
  const obligations: ModelDoc["obligations"] = [];
  const schemaStatements: ModelDoc["schema_statements"] = [];
  const examples: ModelDoc["examples"] = [];
  const counts = { informative: 0, rendered: 0 };
  const restated: { id: string; where: string; vocabulary: string }[] = [];
  const profileEntries: { id: string; where: string; profile: string; document: string; members?: Members; paths?: string[]; decisions: string[] }[] = [];

  /** Adds properties to an object, a document, or a profile, failing on a name it already has. */
  const addProperties = (where: string, object: string, add: Record<string, ModelProperty>, kinds: Kind[]) => {
    const t = types.get(object);
    if (!t || !kinds.includes(t.kind) || !("properties" in t)) {
      problems.push(`${where}: "${object}" is no ${kinds.join(" or ")} in the model on lock "${lock}"`);
      return;
    }
    for (const [k, p] of Object.entries(add)) {
      if (k in t.properties) problems.push(`${where}: "${object}" already has the property "${k}" on lock "${lock}"`);
      else t.properties[k] = p;
    }
  };

  for (const [id, { entry, file }] of ordered) {
    const as = entry.as;
    const where = `${file.file}: entry "${id}"`;
    const e = elements.get(id);
    switch (as.role) {
      case "property": {
        if (!e || (e.kind !== "field" && e.kind !== "key")) {
          problems.push(`${where}: only a field or key row is a property`);
          break;
        }
        const names = e.kind === "field" ? e.element.names.map((n) => lastSegment(n.path)) : [lastSegment(e.element.key.path)];
        const condition = conditionOf(e);
        const description = e.kind === "field" ? e.element.description.text : e.element.meaning.text;
        const p: ModelProperty = {
          type: as.type,
          presence: as.presence,
          ...(condition && as.presence === "conditional" ? { condition } : {}),
          ...(markerOf(e) ? { marker: markerOf(e) } : {}),
          ...(description ? { description } : {}),
          sources: [id],
        };
        const named = fieldOf(id);
        namedAfter.set(p, "field" in named ? named.field : undefined);
        addProperties(where, as.object, Object.fromEntries(names.map((n) => [n, p])), ["object", "document"]);
        break;
      }
      case "members":
        addProperties(where, as.object, properties(as.members, [id]), ["object"]);
        break;
      case "term": {
        const t = types.get(as.vocabulary);
        const value = e?.kind === "marker" ? e.element.marker : e?.kind === "definition" ? e.element.value : null;
        if (!t || t.kind !== "vocabulary") problems.push(`${where}: "${as.vocabulary}" is no vocabulary in the model on lock "${lock}"`);
        else if (value === null) problems.push(`${where}: a ${e?.kind ?? "missing"} element writes no term; a term is a marker or a definition row`);
        // A term of a labeled vocabulary takes its definition row's text as its label, as a code list's code does.
        else {
          const label = labeled.has(t.name) && e?.kind === "definition" ? e.element.columns.map((c) => c.text).filter((x) => x !== "").join(": ") : "";
          t.terms.push({ value, ...(label !== "" ? { annotation: label } : {}), sources: [id] });
        }
        break;
      }
      case "same":
        restated.push({ id, where, vocabulary: as.name });
        break;
      case "rule":
        rules.push({ ...statementOf(e, id, entry.source), owner: as.object });
        break;
      case "obligation":
        obligations.push({ ...statementOf(e, id, entry.source), party: as.party });
        break;
      case "schema":
        schemaStatements.push({ ...statementOf(e, id, entry.source), in: as.in });
        break;
      case "example":
        examples.push({ ...statementOf(e, id, entry.source), object: as.object });
        break;
      case "profile":
        profileEntries.push({ id, where, profile: as.profile, document: as.document, ...(as.members ? { members: as.members } : {}), ...(as.reads ? { paths: as.reads.flatMap((r) => r.paths) } : {}), decisions: decisionsOf(entry.source) });
        break;
      case "informative":
        counts.informative++;
        break;
      case "rendered":
        counts.rendered++;
        break;
      case "type":
        break;
    }
  }

  // A restated list names its vocabulary's terms, in the specification's spelling.
  for (const r of restated) {
    const t = types.get(r.vocabulary);
    const e = elements.get(r.id);
    if (!t || (t.kind !== "vocabulary" && t.kind !== "object" && t.kind !== "part")) {
      problems.push(`${r.where}: "${r.vocabulary}" is no vocabulary, object, or part in the model on lock "${lock}"`);
      continue;
    }
    if (t.kind === "part") {
      // An inline object that restates a part writes exactly its members.
      const shell = constructors.parts.find((p) => p.name === t.name)?.shell;
      if (e?.kind !== "inline_object" || !shell || !restatesPart(e.element.form, shell)) problems.push(`${r.where}: restates the part "${t.name}", but isn't an inline object with exactly its members`);
      continue;
    }
    if (t.kind !== "vocabulary" || e?.kind !== "value_list") continue;
    const terms = new Set(t.terms.map((x) => String(x.value)));
    const extra = e.element.items.map((i) => i.value).filter((v) => !terms.has(v));
    if (extra.length > 0) problems.push(`${r.where}: restates "${r.vocabulary}" with ${extra.map((v) => `"${v}"`).join(", ")}, which it lacks; each list is defined once (type rules § 5)`);
  }

  // Terms: one per spelling; a decimal integer is a JSON integer.
  for (const t of types.values()) {
    if (t.kind !== "vocabulary") continue;
    const seen = new Map<string, ModelTerm>();
    for (const term of t.terms) {
      const key = String(term.value);
      const first = seen.get(key);
      if (first) first.sources = sorted([...first.sources, ...term.sources]);
      else seen.set(key, { ...term, value: typeof term.value === "string" && INTEGER.test(term.value) ? Number(term.value) : term.value, sources: [...term.sources] });
    }
    if (t.terms.length === 0 && !t.open) problems.push(`${t.module}: closed vocabulary "${t.name}" has no terms on lock "${lock}"; only an open vocabulary may have no core terms`);
    t.terms = [...seen.values()];
    const markers = t.terms.filter((term) => term.sources.length > 0 && term.sources.every((s) => elements.get(s)?.kind === "marker")).length;
    if (t.terms.length > 0 && markers === t.terms.length) t.attribute = "marker";
    else if (markers > 0) problems.push(`${t.module}: vocabulary "${t.name}" mixes § 3 marker rows with payload terms; markers are the model's \`marker\` attribute, not a payload value (type rules § 2)`);
  }

  // Profiles (type rules § 3): a profile projects each path its element lists from the document, and each path a decision
  // reads from a prose item, plus the members the profile adds. A path the specification lists under a requiring statement,
  // as § 2.1's "It MUST contain, per line item:", is required at each step (type rules § 4); a path a decision reads keeps
  // the presence its objects give it, since the text names no member. A path through an object, a list, or a copy of a
  // constructor whose shell is an object projects it to the members the paths name, as a named object, `<profile><type>`,
  // that keeps each member the domain model makes a projected member require, as money requires its currency (§ 3a).
  type PathTree = { required: boolean; sub: Map<string, PathTree> | null };
  const required = requiredLists(ir);
  const conceptOf = kernel.domains ? conceptOfType(kernel.domains) : new Map<string, never>();
  const projectedUses: { t: TypeRef; field: string; module: string; where: string }[] = [];
  const profiles = new Map<string, typeof profileEntries>();
  for (const p of profileEntries) profiles.set(p.document + p.profile, [...(profiles.get(p.document + p.profile) ?? []), p]);
  for (const [name, list] of [...profiles].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const document = list[0]!.document;
    const module = entries.get(list[0]!.id)!.file.module;
    const where = list[0]!.where;
    const fields: string[] = [];
    const paths: string[] = [];
    const tree = new Map<string, PathTree>();
    const insert = (path: string, isRequired: boolean) => {
      paths.push(path);
      const segments = path.split(".").map((x) => x.replaceAll("[]", ""));
      fields.push(segments[0]!);
      let level = tree;
      segments.forEach((seg, i) => {
        const node = level.get(seg) ?? { required: false, sub: new Map<string, PathTree>() };
        node.required ||= isRequired;
        if (i === segments.length - 1) node.sub = null;
        level.set(seg, node);
        level = node.sub ?? new Map<string, PathTree>();
      });
    };
    for (const p of list) {
      const e = elements.get(p.id);
      if (e?.kind === "identifier_list") for (const i of e.element.items) if (i.code) insert(i.text, required.has(e.element.id));
      for (const path of p.paths ?? []) insert(path, false);
    }

    /** The members of the type a path steps into: an object's properties, or a constructor shell's, with its arguments. */
    const membersOf = (t: TypeRef, field: string): { source: string; open: boolean; sources: string[]; properties: Record<string, ModelProperty> } | null => {
      if (t.kind === "named") {
        const x = types.get(t.name);
        return x?.kind === "object" ? { source: x.name, open: x.open, sources: x.sources, properties: x.properties } : null;
      }
      if (t.kind !== "apply") return null;
      const c = constructors.constructors.find((x) => x.name === t.constructor);
      const shell = c?.shell.properties as Record<string, { $model: TypeRef; description?: string }> | undefined;
      const source = copyName(templates, t, field);
      if (!c || !shell || source === null) return null;
      const req = new Set((c.shell.required as string[] | undefined) ?? []);
      const props = Object.fromEntries(
        Object.entries(shell).map(([k, slot]): [string, ModelProperty] => [k, { type: substitute(slot.$model, t.arguments), presence: req.has(k) ? "required" : "optional", ...(slot.description ? { description: slot.description } : {}), sources: c.sources.spec.map((x) => x.ir).filter((id) => id.slice(id.lastIndexOf(":") + 1).replaceAll("[]", "") === k) }]),
      );
      return { source, open: c.shell.additionalProperties !== false, sources: [], properties: props };
    };
    const projectType = (t: TypeRef, sub: Map<string, PathTree>, field: string, at: string): TypeRef => {
      if (t.kind === "apply") {
        const c = constructors.constructors.find((x) => x.name === t.constructor);
        // A list, or a union of the inline value and a reference, projects what it holds.
        if (c?.name === "List") return { ...t, arguments: { ...t.arguments, T: projectType(t.arguments.T!, sub, field, at) } };
        if (Array.isArray(c?.shell.anyOf) && c!.naming.from === "argument") {
          const param = c!.naming.parameter;
          return { ...t, arguments: { ...t.arguments, [param]: projectType(t.arguments[param]!, sub, field, at) } };
        }
      }
      const m = membersOf(t, field);
      if (m === null) {
        problems.push(`${where}: the profile "${name}" lists the path "${at}", which steps into ${renderType(t)}, which has no members to project on lock "${lock}"`);
        return t;
      }
      const out: Record<string, ModelProperty> = {};
      for (const [k, node] of sub) {
        const sp = m.properties[k];
        if (!sp) {
          problems.push(`${where}: the profile "${name}" lists the path "${at}.${k}", but ${m.source} has no member "${k}" on lock "${lock}"`);
          continue;
        }
        out[k] = project(sp, node, k, `${at}.${k}`);
      }
      // A member the domain model makes a projected member require, as money its currency, comes with it.
      for (const p of Object.values(out)) {
        const requires = p.type.kind === "named" ? conceptOf.get(p.type.name)?.concept.requires : undefined;
        if (requires && !(requires.member in out) && m.properties[requires.member]) out[requires.member] = m.properties[requires.member]!;
      }
      const projected = `${name}${m.source}`;
      const t2: ModelType = { ...base(projected, "object", module, m.sources, []), kind: "object", open: m.open, properties: out, projects: m.source };
      const have = types.get(projected);
      if (!have) types.set(projected, t2);
      else if (canonicalJson(have) !== canonicalJson(t2)) problems.push(`${where}: the profile "${name}" projects ${m.source} twice, to different members, on lock "${lock}"`);
      for (const [k, p] of Object.entries(out)) projectedUses.push({ t: p.type, field: k, module, where: `${where}: projection "${projected}": member "${k}"` });
      return { kind: "named", name: projected };
    };
    // The paths a projected type holds, below the field it projects, as `included[]` or `available[].name`.
    const heldPaths = (t: TypeRef): string[] => {
      if (t.kind === "apply") {
        const inner = Object.values(t.arguments).find((a) => a.kind === "named" && types.get(a.name)?.kind === "object" && (types.get(a.name) as { projects?: string }).projects !== undefined);
        if (t.constructor === "List") return heldPaths(t.arguments.T!).map((x) => (x === "" ? "[]" : `[].${x}`));
        return inner ? heldPaths(inner) : [""];
      }
      const x = t.kind === "named" ? types.get(t.name) : undefined;
      if (x?.kind !== "object" || x.projects === undefined) return [""];
      return Object.entries(x.properties).flatMap(([k, m]) => heldPaths(m.type).map((rest) => (rest === "" ? k : rest.startsWith("[]") ? `${k}${rest}` : `${k}.${rest}`)));
    };
    const documentLabel = document.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    // A member no requiring list names keeps its presence, but a condition binds the document, not the profile: the
    // profile gives what the document declares, which it can't check alone, so a conditional member is optional there.
    // A projected member says what it holds of the document's field.
    const project = (p: ModelProperty, node: PathTree, field: string, at: string): ModelProperty => {
      const type = node.sub === null ? p.type : projectType(p.type, node.sub, field, at);
      const held = node.sub === null ? [] : heldPaths(type);
      const list = held.length > 0 && held.every((x) => x.startsWith("[]"));
      const paths = held.map((x) => `\`${list ? x.replace(/^\[\]\.?/, "") : x}\``);
      const said = paths.length <= 2 ? paths.join(" and ") : `${paths.slice(0, -1).join(", ")}, and ${paths.at(-1)}`;
      const description = node.sub === null ? p.description : `The ${documentLabel}'s \`${at}${list ? "[]" : ""}\`, ${list ? "each entry " : ""}projected to ${said}.`;
      const { condition: _condition, cases: _cases, description: _description, ...rest } = p;
      const base = { ...rest, ...(description !== undefined ? { description } : {}) };
      if (node.required) return { ...base, ...(p.cases ? { cases: p.cases } : {}), type, presence: "required" };
      return p.presence === "conditional" ? { ...base, ...(p.cases ? { cases: p.cases } : {}), type, presence: "optional" } : { ...base, ...(p.condition ? { condition: p.condition } : {}), ...(p.cases ? { cases: p.cases } : {}), type };
    };

    const props: Record<string, ModelProperty> = {};
    for (const p of list) Object.assign(props, properties(p.members, [p.id]));
    const doc = types.get(document);
    if (!doc || doc.kind !== "document") problems.push(`${where}: the profile "${name}" projects "${document}", which is no document on lock "${lock}"`);
    else {
      for (const [f, node] of [...tree].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (f in props) continue;
        const dp = doc.properties[f];
        if (!dp) {
          problems.push(`${where}: the profile "${name}" lists "${f}", which is no property of "${document}" and no member the profile adds on lock "${lock}"`);
          continue;
        }
        props[f] = project(dp, node, f, f);
        namedAfter.set(props[f]!, namedAfter.get(dp));
      }
    }
    define(
      {
        ...base(name, "profile", module, list.map((p) => p.id), list.flatMap((p) => p.decisions)),
        kind: "profile",
        document,
        fields: sorted([...fields, ...list.flatMap((p) => Object.keys(p.members ?? {}))]),
        paths: [...new Set(paths)],
        properties: byKey(props),
      },
      where,
    );
  }

  // Copies: apply every application the model's types state, and note the modules that state each one.
  const inst = new Instantiator(templates);
  const statedBy = new Map<string, Set<string>>();
  const visit = (t: TypeRef, field: string | undefined, module: string) => {
    if (t.kind !== "apply") return;
    const c = constructors.constructors.find((x) => x.name === t.constructor);
    if (!c) return;
    if (c.naming.from !== "inline") {
      const name = copyName(templates, t, field);
      if (name !== null) {
        statedBy.set(name, new Set([...(statedBy.get(name) ?? []), module]));
        if (c.fallback && t.arguments[c.fallback.parameter]) statedBy.set(name + c.fallback.suffix, new Set([...(statedBy.get(name + c.fallback.suffix) ?? []), module]));
      }
    }
    for (const s of slots(c.shell)) visit(substitute(s.$model, t.arguments), field, module);
  };
  const uses: { t: TypeRef; field: string | undefined; module: string; where: string }[] = [];
  for (const [id, { entry, file }] of ordered) {
    const as = entry.as;
    const named = fieldOf(id);
    const field = "field" in named ? named.field : undefined;
    if (as.role === "property") uses.push({ t: as.type, field, module: file.module, where: `${file.file}: entry "${id}"` });
    if (as.role === "type" || as.role === "members" || as.role === "profile") {
      for (const [k, m] of Object.entries(as.members ?? {})) uses.push({ t: m.type, field: k, module: file.module, where: `${file.file}: entry "${id}": member "${k}"` });
    }
  }
  for (const { decl, file } of declarations) {
    for (const [k, m] of Object.entries(decl.members ?? {})) uses.push({ t: m.type, field: k, module: file.module, where: `${file.file}: type "${decl.name}": member "${k}"` });
    const named = decl.ir === undefined ? { problem: "" } : fieldOf(decl.ir);
    for (const t of decl.any_of ?? []) uses.push({ t, field: "field" in named ? named.field : undefined, module: file.module, where: `${file.file}: type "${decl.name}"` });
  }
  uses.push(...projectedUses);
  for (const u of uses) {
    try {
      inst.schemaOf(u.t, u.field);
      visit(u.t, u.field, u.module);
    } catch (err) {
      problems.push(`${u.where}: ${(err as Error).message}`);
    }
  }
  const argumentModule = (t: TypeRef): string | undefined => {
    if (t.kind === "named") return types.get(t.name)?.module;
    if (t.kind !== "apply") return undefined;
    const c = constructors.constructors.find((x) => x.name === t.constructor);
    if (c?.naming.from === "argument") return argumentModule(t.arguments[c.naming.parameter]!);
    return undefined;
  };
  for (const [name, c] of [...inst.copies].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const ctor = constructors.constructors.find((x) => x.name === c.of.constructor)!;
    const modules = sorted(statedBy.get(name) ?? []);
    let module = ctor.naming.from === "argument" ? argumentModule(c.of) : modules.length === 1 ? modules[0] : undefined;
    if (module === undefined) {
      problems.push(`copy "${name}" (${c.type}) is stated by ${modules.length === 0 ? "no module" : `the modules ${modules.join(", ")}`} on lock "${lock}"; a copy named after its field belongs to the one module that states it`);
      module = modules[0] ?? KERNEL_MODULE;
    }
    define({ ...base(name, "copy", module, [], []), kind: "copy", of: c.of, application: renderType(c.of), fallback: c.fallback, schema: c.schema }, `copy ${c.type}`);
  }

  // An object option carries the member that names it (type rules § 7, D-046): where a parameter names the options of
  // another, as Selectable's K names T's, and the option is an object, so K isn't T, each object type that is an option
  // carries the parameter's member, typed by its argument and required. The constructor gives it, so the mapping keeps the
  // members the text writes, and a member the text writes, as a property option's `id`, keeps its sources and becomes required.
  const optionObjects = (t: TypeRef): string[] => {
    if (t.kind === "named") return [t.name];
    if (t.kind !== "apply") return [];
    const c = constructors.constructors.find((x) => x.name === t.constructor);
    const branches = Array.isArray(c?.shell.anyOf) ? (c!.shell.anyOf as { $model?: TypeRef }[]) : [];
    return branches.flatMap((b) => (b.$model?.kind === "parameter" && t.arguments[b.$model.name] ? optionObjects(t.arguments[b.$model.name]!) : []));
  };
  const carried = new Set<string>();
  const carry = (t: TypeRef, where: string) => {
    if (t.kind !== "apply") return;
    const c = constructors.constructors.find((x) => x.name === t.constructor);
    for (const p of c?.parameters ?? []) {
      const k = t.arguments[p.name];
      const option = p.names === undefined ? undefined : t.arguments[p.names];
      if (!p.carries || !k || !option || k.kind === "parameter" || option.kind === "parameter" || canonicalJson(k) === canonicalJson(option)) continue;
      const { member, decision, departure, description } = p.carries;
      for (const name of optionObjects(option)) {
        const o = types.get(name);
        if (o?.kind !== "object") {
          problems.push(`${where}: ${c!.name}'s ${p.name} names an option of ${p.names}, "${name}", by its \`${member}\`, so "${name}" is an object that carries it (type rules § 7, ${decision})`);
          continue;
        }
        const have = o.properties[member];
        if (have && have.given === undefined && canonicalJson(have.type) !== canonicalJson(k)) {
          problems.push(`${where}: "${name}" is an option named by its \`${member}\`, a ${renderType(k)}, but types \`${member}\` as ${renderType(have.type)} (type rules § 7, ${decision})`);
          continue;
        }
        if (carried.has(name)) continue;
        carried.add(name);
        // A variant that switches the departure off (src/variant.ts) gives the member only where the text writes it or leaves the option's members open.
        if (!have && !o.open && input.withhold?.includes(name)) continue;
        o.properties[member] = { type: k, presence: "required", description: have?.description ?? description, sources: have?.sources ?? [], given: c!.name };
        // A closed option lists its members, so a member it doesn't list is a change to what the text settles: the
        // option cites the departure `carries` names, which must be a departure; an open option, whose members the text
        // doesn't state, and an option that writes the member rest on the gap alone.
        const departs = !have && !o.open;
        if (departs && departure === undefined) problems.push(`${where}: "${name}" lists its members without \`${member}\`, so giving it one departs from the text; name the departure under ${c!.name}'s ${p.name} \`carries\` (type rules § 4, § 7)`);
        const kindOf = (id: string) => input.decisions.find((d) => d.id === id)?.kind;
        if (kindOf(decision) !== "gap") problems.push(`${where}: ${c!.name}'s ${p.name} \`carries\` cites ${decision} as the reading that names every object option, which is no gap record (type rules § 7)`);
        if (departs && departure !== undefined && kindOf(departure) !== "departure") problems.push(`${where}: ${c!.name}'s ${p.name} \`carries\` cites ${departure} for "${name}", which lists its members without \`${member}\`, and ${departure} is no departure record (type rules § 4, § 7)`);
        o.decisions = sorted([...o.decisions, decision, ...(departs && departure ? [departure] : [])]);
      }
    }
    for (const a of Object.values(t.arguments)) carry(a, where);
  };
  for (const u of uses) carry(u.t, u.where);

  // References: the named types each type's emitted schema names.
  const typeRefs = (t: TypeRef, field?: string): string[] => {
    try {
      return refNames(inst.schemaOf(t, field));
    } catch {
      return [];
    }
  };
  const propertyRefs = (props: Record<string, ModelProperty>) => Object.values(props).flatMap((p) => [...typeRefs(p.type, namedAfter.get(p)), ...(p.cases ?? []).map((c) => c.type.name)]);
  for (const t of types.values()) {
    switch (t.kind) {
      case "primitive":
        break;
      case "part":
      case "copy":
        t.references = sorted(refNames(t.schema));
        break;
      case "constructor":
        t.references = sorted(slots(t.shell).flatMap((s) => [s.$model, ...(s.$model.kind === "apply" ? Object.values(s.$model.arguments) : [])]).flatMap((x) => (x.kind === "named" ? [x.name] : [])));
        break;
      case "vocabulary":
        t.references = t.open ? [extensionOf(t)] : [];
        break;
      case "union": {
        const decl = declarations.find((d) => d.decl.name === t.name)?.decl;
        const named = decl?.ir === undefined ? { problem: "" } : fieldOf(decl.ir);
        t.references = sorted(t.any_of.flatMap((b) => typeRefs(b, "field" in named ? named.field : undefined)));
        break;
      }
      case "object":
      case "document":
      case "profile": {
        t.references = sorted(propertyRefs(t.properties));
        break;
      }
    }
  }
  // An object that includes a profile carries the profile's fields, so its schema references what they reference, not the profile.
  for (const t of types.values()) {
    if (t.kind !== "object" || t.includes === undefined) continue;
    const p = types.get(t.includes);
    if (p?.kind === "profile") t.references = sorted([...t.references, ...p.references]);
    else problems.push(`${t.module}: object "${t.name}" includes "${t.includes}", which is no profile in the model on lock "${lock}"`);
  }

  // A copy sits at the layer of the highest type it holds, and never below the constructors.
  const layerOf = (name: string, seen = new Set<string>()): number => {
    const t = types.get(name);
    if (!t) return 0;
    if (t.kind !== "copy") return t.layer;
    if (seen.has(name)) return 2;
    return Math.max(2, ...t.references.map((r) => layerOf(r, new Set([...seen, name]))));
  };
  for (const t of types.values()) if (t.kind === "copy") t.layer = layerOf(t.name);

  for (const t of types.values()) if ("properties" in t) t.properties = byKey(t.properties);

  // Co-presence (type rules § 3a): an object that carries a value whose concept requires a sibling, as money requires its
  // currency, requires the sibling with the value. A required value makes the sibling required; an optional one requires it
  // when present. A sibling the specification makes conditional keeps its condition, which says when the value is money.
  const concepts = kernel.domains ? conceptOfType(kernel.domains) : new Map<string, never>();
  const conceptTypes = new Map((kernel.domains?.domains ?? []).flatMap((d) => d.concepts.map((c) => [c.name, c] as const)));
  for (const t of types.values()) {
    if (t.kind !== "object" && t.kind !== "document" && t.kind !== "profile") continue;
    const dependent: Record<string, string[]> = {};
    // A basis (type rules § 3a): a term of the vocabulary says what a sibling's value is, as a commitment's `basis` makes its
    // `amount` money for `spend` and a count for `units`. The value takes each other term's type while the vocabulary holds
    // that term, requires the basis when present, and its money's sibling is required only while the basis says money.
    const read = new Set<string>();
    for (const [k, p] of Object.entries(t.properties)) {
      const basis = p.type.kind === "named" ? kernel.domains?.bases.find((b) => b.vocabulary === (p.type as { name: string }).name) : undefined;
      const value = basis ? t.properties[basis.member] : undefined;
      if (!basis || !value) continue;
      const where = `${t.module}: ${t.kind} "${t.name}": property "${basis.member}"`;
      const own = value.type.kind === "named" ? concepts.get(value.type.name)?.concept : undefined;
      const terms = Object.entries(basis.terms);
      const at = terms.filter(([, c]) => c === own?.name).map(([term]) => term);
      // The member's own type is the concept every unlisted term gives it, or else the concept of exactly one listed term.
      const others = basis.others;
      if (own === undefined || (others === undefined ? at.length !== 1 : own.name !== others)) {
        problems.push(`${where}: its basis "${k}" reads it as ${terms.map(([term, c]) => `${c} for "${term}"`).join(", ")}${others !== undefined ? `, and ${others} for every other term` : ""}, and its type is ${others !== undefined ? `the concept of every other term's` : "the concept of exactly one term's"}`);
        continue;
      }
      const vocabulary = types.get((p.type as { name: string }).name);
      const unknown = vocabulary?.kind === "vocabulary" ? terms.filter(([term]) => !vocabulary.terms.some((x) => String(x.value) === term)).map(([term]) => term) : [];
      if (unknown.length > 0) {
        problems.push(`${where}: its basis "${k}" names ${unknown.map((x) => `"${x}"`).join(", ")}, which the vocabulary "${vocabulary!.name}" doesn't hold on lock "${lock}"`);
        continue;
      }
      // The concept of the other terms is reached only by a term the basis doesn't name, which a closed vocabulary that it names whole has none of.
      if (others !== undefined && vocabulary?.kind === "vocabulary" && !vocabulary.open && vocabulary.terms.every((x) => String(x.value) in basis.terms)) {
        problems.push(`${where}: its basis "${k}" names every term of the closed vocabulary "${vocabulary.name}", so no term reads it as ${others}; leave out \`others\`, and type it as one term's concept`);
        continue;
      }
      // A listed term's concept that requires a sibling would need the sibling required while the basis holds that term, which the basis with others can't state.
      const needy = others === undefined ? [] : terms.filter(([, c]) => conceptTypes.get(c)?.requires !== undefined).map(([term]) => term);
      if (needy.length > 0) {
        problems.push(`${where}: its basis "${k}" reads it, for ${needy.map((x) => `"${x}"`).join(", ")}, as a concept that requires a sibling, which a basis with a concept for its other terms can't make conditional`);
        continue;
      }
      read.add(basis.member);
      const cases = terms
        .filter(([, c]) => c !== own.name)
        .map(([term, c]) => ({ when: { member: k, value: term }, type: { kind: "named" as const, name: conceptTypes.get(c)?.type ?? c } }));
      t.properties[basis.member] = { ...value, cases };
      if (p.presence !== "required" && value.presence !== "required") dependent[basis.member] = [...(dependent[basis.member] ?? []), k];
      const sibling = own.requires ? t.properties[own.requires.member] : undefined;
      if (!own.requires || !sibling) continue;
      if (others !== undefined) {
        problems.push(`${where}: its basis "${k}" reads it as ${own.name} for every other term, and ${own.name} requires its "${own.requires.member}", which no one term can make conditional`);
        continue;
      }
      const condition = `REQUIRED when \`${k} = ${at[0]}\``;
      if (sibling.presence === "conditional" && sibling.condition !== condition) {
        problems.push(`${where}: its basis reads it as ${own.name} when "${k}" is "${at[0]}", so its "${own.requires.member}" is ${condition}, but the specification states "${sibling.condition ?? ""}"`);
      }
      t.properties[own.requires.member] = { ...sibling, presence: "conditional", condition };
    }
    for (const [k, p] of Object.entries(t.properties)) {
      const requires = p.type.kind === "named" ? concepts.get(p.type.name)?.concept.requires : undefined;
      const sibling = requires ? t.properties[requires.member] : undefined;
      if (!requires || !sibling || sibling.presence === "conditional" || read.has(k)) continue;
      if (p.presence === "required") {
        if (sibling.presence !== "required") t.properties[requires.member] = { ...sibling, presence: "required" };
      } else dependent[k] = [...(dependent[k] ?? []), requires.member];
    }
    for (const k of Object.keys(dependent)) dependent[k] = sorted(dependent[k]!);
    if (Object.keys(dependent).length > 0) t.dependent_required = byKey(dependent);
    const narrowed = Object.values(t.properties).flatMap((p) => (p.cases ?? []).map((c) => c.type.name));
    if (narrowed.length > 0) t.references = sorted([...t.references, ...narrowed]);
  }

  const modules: ModelModule[] = sorted([KERNEL_MODULE, ...mappings.map((m) => m.module)]).map((name) => {
    const m = mappings.find((x) => x.module === name);
    const own = [...types.values()].filter((t) => t.module === name);
    const refs = own.flatMap((t) => t.references.map((r) => types.get(r)?.module).filter((x): x is string => x !== undefined && x !== name && x !== KERNEL_MODULE));
    return { name, sections: m?.sections ?? [], references: sorted(refs) };
  });

  const byIr = <T extends { ir: string }>(xs: T[]) => xs.sort((a, b) => (a.ir < b.ir ? -1 : a.ir > b.ir ? 1 : 0));
  const model: ModelDoc = {
    format: 1,
    input: { lock, commit: ir.input.commit, blob: ir.input.blob, ir_sha256: sha256(canonicalJson(ir)) },
    modules,
    types: [...types.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    rules: byIr(rules),
    kernel_rules: [
      ...kernel.primitives.flatMap((p) =>
        (p.rules ?? []).map(
          (r): ModelKernelRule => ({
            id: r.id,
            owner: p.name,
            statement: r.statement,
            sources: sorted((r.source.spec ?? []).filter((c) => c.locks === undefined || c.locks.includes(lock)).map((c) => c.ir)),
            decisions: decided(r.source),
            ...(r.source.standard ? { standard: r.source.standard } : {}),
            valid: r.valid,
            invalid: r.invalid,
          }),
        ),
      ),
      ...constructors.parts.flatMap((p) =>
        (p.rules ?? []).map(
          (r): ModelKernelRule => ({
            id: r.id,
            owner: p.name,
            statement: r.statement,
            sources: sorted((r.source.spec ?? []).filter((x) => x.locks === undefined || x.locks.includes(lock)).map((x) => x.ir)),
            decisions: decided(r.source),
            valid: r.valid,
            invalid: r.invalid,
          }),
        ),
      ),
      ...constructors.constructors.flatMap((c) =>
        (c.rules ?? []).map(
          (r): ModelKernelRule => ({
            id: r.id,
            owner: c.name,
            statement: r.statement,
            sources: sorted((r.source.spec ?? []).filter((x) => x.locks === undefined || x.locks.includes(lock)).map((x) => x.ir)),
            decisions: decided(r.source),
            arguments: r.arguments,
            valid: r.valid,
            invalid: r.invalid,
          }),
        ),
      ),
    ].sort((a, b) => (a.id < b.id ? -1 : 1)),
    obligations: byIr(obligations),
    schema_statements: byIr(schemaStatements),
    examples: byIr(examples),
    counts,
    decisions: sorted([...[...entries.values()].flatMap(({ entry }) => decisionsOf(entry.source)), ...declarations.flatMap(({ decl }) => decisionsOf(decl.source))]),
  };
  return { model, problems };
}

/** The model as `build/model.json` holds it: canonical JSON. */
export const renderModel = (model: ModelDoc): string => canonicalJson(model);
