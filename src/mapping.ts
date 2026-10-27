import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { citeText, elementDigest, indexElements, type Element } from "./elements.ts";
import type { SpecIR } from "./ir-types.ts";
import { compileSchema } from "./pipeline.ts";

/** A property's type, as `mapping/mapping.schema.json` defines it. */
export type TypeRef =
  | { kind: "named"; name: string }
  | { kind: "boolean" }
  | { kind: "apply"; constructor: string; arguments: Record<string, TypeRef>; name?: string }
  | { kind: "parameter"; name: string };

export type Presence = "required" | "optional" | "conditional";

/** An object's members, keyed by member name without `[]`. */
export type Members = Record<string, { type: TypeRef; presence: Presence; description?: string }>;

export type Target =
  | { role: "property"; object: string; type: TypeRef; presence: Presence }
  | { role: "type"; name: string; layer: "primitive" | "constructor" | "vocabulary" | "object" | "document"; open?: boolean; members?: Members; module?: "kernel" }
  | { role: "members"; object: string; members: Members }
  | { role: "same"; name: string }
  | { role: "term"; vocabulary: string }
  | { role: "rule"; object: string }
  | { role: "obligation"; party: "seller" | "buyer" | "consumer" | "implementation" }
  | { role: "schema"; in: string }
  | { role: "informative" }
  | { role: "example"; object: string }
  | { role: "profile"; profile: string; document: string; members?: Members; reads?: { item: string; paths: string[] }[] }
  | { role: "rendered" };

/** What decided an entry or a declaration. */
export type Source = { rule: string } | { decision: string } | { decisions: string[] };

/** The decision records a source cites, in order; none for a rule. */
export const decisionsOf = (s: Source): string[] => ("decision" in s ? [s.decision] : "decisions" in s ? s.decisions : []);

export interface MappingEntry {
  ir: string;
  digest: string;
  locks?: string[];
  source: Source;
  as: Target;
}

/** A model type that no single IR element defines (`types` in a mapping file). */
export interface Declaration {
  name: string;
  kind: "document" | "object" | "vocabulary" | "union";
  ir?: string;
  locks?: string[];
  source: Source;
  open?: boolean;
  members?: Members;
  /** A profile, `<Document><Profile>`, whose fields the object carries besides its own members. */
  includes?: string;
  terms?: string[];
  /** The code list of another standard whose codes the vocabulary's terms are, with each term's code where the two differ. */
  list?: { name: string; codes?: Record<string, string> };
  /** What a vocabulary's terms mean where no row says. */
  description?: string;
  any_of?: TypeRef[];
}

export interface MappingFile {
  format: 1;
  module: string;
  /** The specification sections the module owns. */
  sections: string[];
  /** The other modules its types may reference; the kernel needs no listing (type rules § 3). */
  depends?: string[];
  types?: Declaration[];
  entries: MappingEntry[];
  /** The file the entries came from, for messages. */
  file: string;
}

export interface Cover {
  ir: string;
  digest: string;
  quote: string;
  locks?: string[];
  /** For a departure: the constraint forms of this element it changes, which the fidelity gate lets the schema disagree with. */
  departs?: string[];
}

export interface DecisionRecord {
  format: 1;
  id: string;
  status: "proposed" | "accepted" | "filed" | "superseded";
  /** `gap`: the specification leaves the point open. `departure`: it settles the point, and the decision proposes a change. */
  kind: "gap" | "departure";
  author: string;
  question: string;
  covers: Cover[];
  options: { id: string; summary: string }[];
  chosen: string;
  rationale: string;
  evidence?: string[];
  feedback?: string;
  issue?: string;
  superseded_by?: string;
  /** The types the decision names whose structure the specification doesn't state, which the duplication and value-list gates set aside. */
  sets_aside?: { type: string; field: string; ir: string; locks?: string[] }[];
  file: string;
}

const MAPPING_SCHEMA = join("mapping", "mapping.schema.json");
const DECISION_SCHEMA = join("decisions", "decision.schema.json");

/** Reads a file as YAML 1.2 core with unique keys. */
export function readYaml(file: string): unknown {
  try {
    return parse(readFileSync(file, "utf8"), { version: "1.2", schema: "core", uniqueKeys: true }) as unknown;
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message.split("\n")[0]}`);
  }
}

/** Reads every `*.yaml` file in a directory as YAML 1.2 core with unique keys. A missing directory has no files. */
function readYamlDir(dir: string): { file: string; stem: string; doc: unknown }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => {
      const file = join(dir, f);
      return { file, stem: basename(f, ".yaml"), doc: readYaml(file) };
    });
}

/**
 * Loads `<dir>/*.yaml` as mapping files and validates each against the
 * mapping schema in `root`. A file's `module` must equal its name. Throws on
 * the first invalid file.
 */
export function loadMappings(root: string, dir: string): MappingFile[] {
  const validate = compileSchema(join(root, MAPPING_SCHEMA));
  return readYamlDir(dir).map(({ file, stem, doc }) => {
    const errors = validate(doc);
    if (errors.length > 0) throw new Error(`${file}: not a valid mapping file: ${errors.join("; ")}`);
    const m = doc as Omit<MappingFile, "file">;
    if (m.module !== stem) throw new Error(`${file}: "module" is "${m.module}"; it must equal the file name "${stem}"`);
    return { ...m, file };
  });
}

/**
 * Loads `<dir>/*.yaml` as decision records and validates each against the
 * decision schema in `root`. A record's `id` must equal its file name.
 * Throws on the first invalid file.
 */
export function loadDecisions(root: string, dir: string): DecisionRecord[] {
  const validate = compileSchema(join(root, DECISION_SCHEMA));
  return readYamlDir(dir).map(({ file, stem, doc }) => {
    const errors = validate(doc);
    if (errors.length > 0) throw new Error(`${file}: not a valid decision record: ${errors.join("; ")}`);
    const d = doc as Omit<DecisionRecord, "file">;
    if (d.id !== stem) throw new Error(`${file}: "id" is "${d.id}"; it must equal the file name "${stem}"`);
    return { ...d, file };
  });
}

/** Whether an entry or a cover with these `locks` applies to `lock`. */
export const inScope = (locks: string[] | undefined, lock: string) => locks === undefined || locks.includes(lock);

/**
 * Returns a check that an IR element exists on the lock and still has the
 * recorded digest. Each failure is pushed to `problems`.
 */
export function digestCheck(elements: Map<string, Element>, lock: string, problems: string[]): (where: string, ir: string, digest: string) => boolean {
  return (where, ir, digest) => {
    const e = elements.get(ir);
    if (!e) {
      problems.push(`${where}: lock "${lock}" has no IR element "${ir}"`);
      return false;
    }
    const now = elementDigest(e);
    if (now !== digest) {
      problems.push(`${where}: stale digest for "${ir}" on lock "${lock}": recorded ${digest.slice(0, 12)}, current ${now.slice(0, 12)}`);
      return false;
    }
    return true;
  };
}

/**
 * Checks a list of quoted, digested IR citations against one lock: each
 * in-scope cover names an element, at most once, with its current digest and
 * its current text. Used by decision records and by kernel sources.
 */
export function checkCovers(where: string, covers: Cover[], elements: Map<string, Element>, lock: string, problems: string[]): void {
  const current = digestCheck(elements, lock, problems);
  const seen = new Set<string>();
  for (const c of covers) {
    if (!inScope(c.locks, lock)) continue;
    if (seen.has(c.ir)) problems.push(`${where}: "${c.ir}" is covered twice on lock "${lock}"`);
    seen.add(c.ir);
    if (!current(where, c.ir, c.digest)) continue;
    const text = citeText(elements.get(c.ir)!);
    if (c.quote.trim() !== text.trim()) problems.push(`${where}: the quote for "${c.ir}" differs from the IR; run: npm run cite -- ${c.ir}`);
  }
}

function overridesName(t: TypeRef): boolean {
  if (t.kind !== "apply") return false;
  return t.name !== undefined || Object.values(t.arguments).some(overridesName);
}

/** Every type a target or a declaration states: a property's type, each member's type, and each union branch. */
export function typesIn(x: Target | Declaration): TypeRef[] {
  const members = (m: Members | undefined) => Object.values(m ?? {}).map((v) => v.type);
  if ("kind" in x) return [...members(x.members), ...(x.any_of ?? [])];
  switch (x.role) {
    case "property":
      return [x.type];
    case "type":
    case "members":
    case "profile":
      return members(x.members);
    default:
      return [];
  }
}

/**
 * Checks the mapping and the decision records against one lock's IR, and
 * returns the problems; empty means current. The checks JSON Schema can't
 * make:
 *
 * - every in-scope entry and cover names an IR element, and its digest is
 *   the element's current digest (otherwise it is stale);
 * - every cover's quote is the element's current text;
 * - no element has two in-scope entries;
 * - each decision an entry cites exists, isn't superseded, and covers the
 *   entry's element, so a change to that element makes the decision stale
 *   too;
 * - a declaration's element exists and is current through its entry, and a
 *   declaration that cites a decision names an element the decision covers;
 * - a type-name override (type rules § 7) cites a decision;
 * - a record's options have distinct IDs, `chosen` is one of them, and
 *   `superseded_by` names another existing record.
 *
 * Whether every element has an entry is the coverage gate's job, not this one.
 */
export function checkMapping(ir: SpecIR, lock: string, mappings: MappingFile[], decisions: DecisionRecord[]): string[] {
  const problems: string[] = [];
  const elements = indexElements(ir);
  const byId = new Map<string, DecisionRecord>();
  for (const d of decisions) {
    if (byId.has(d.id)) problems.push(`${d.file}: duplicate decision ID "${d.id}"`);
    byId.set(d.id, d);
  }

  const current = digestCheck(elements, lock, problems);

  for (const d of decisions) {
    const ids = d.options.map((o) => o.id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup !== undefined) problems.push(`${d.file}: option "${dup}" is listed twice`);
    if (!ids.includes(d.chosen)) problems.push(`${d.file}: "chosen" is "${d.chosen}", which is not one of the options (${ids.join(", ")})`);
    if (d.superseded_by !== undefined && (d.superseded_by === d.id || !byId.has(d.superseded_by))) {
      problems.push(`${d.file}: "superseded_by" names "${d.superseded_by}", which is not another decision record`);
    }
    checkCovers(d.file, d.covers, elements, lock, problems);
  }

  /** Checks that each decision a source cites exists, isn't superseded, and covers `ir` on the lock. */
  const cited = (where: string, source: Source, ir: string | undefined) => {
    for (const id of decisionsOf(source)) {
      const d = byId.get(id);
      if (!d) {
        problems.push(`${where}: cites decision "${id}", which doesn't exist`);
        continue;
      }
      if (d.status === "superseded") problems.push(`${where}: cites "${d.id}", which is superseded by "${d.superseded_by}"`);
      if (ir === undefined) problems.push(`${where}: cites "${d.id}" but names no IR element for it to cover; give the declaration an "ir"`);
      else if (!d.covers.some((c) => c.ir === ir && inScope(c.locks, lock))) problems.push(`${where}: cites "${d.id}", which doesn't cover "${ir}" on lock "${lock}"`);
    }
  };

  const mapped = new Map<string, string>();
  for (const m of mappings) {
    for (const entry of m.entries) {
      if (!inScope(entry.locks, lock)) continue;
      const where = `${m.file}: entry "${entry.ir}"`;
      const first = mapped.get(entry.ir);
      if (first !== undefined) problems.push(`${where}: "${entry.ir}" is already mapped in ${first} on lock "${lock}"`);
      else mapped.set(entry.ir, m.file);
      current(where, entry.ir, entry.digest);
      if (typesIn(entry.as).some(overridesName) && "rule" in entry.source) {
        problems.push(`${where}: a type-name override needs a decision record (type rules § 7)`);
      }
      cited(where, entry.source, entry.ir);
    }
    for (const t of m.types ?? []) {
      if (!inScope(t.locks, lock)) continue;
      const where = `${m.file}: type "${t.name}"`;
      if (t.ir !== undefined && !elements.has(t.ir)) problems.push(`${where}: lock "${lock}" has no IR element "${t.ir}"`);
      if (t.any_of?.some(overridesName) && "rule" in t.source) problems.push(`${where}: a type-name override needs a decision record (type rules § 7)`);
      cited(where, t.source, t.ir);
    }
  }
  return problems;
}
