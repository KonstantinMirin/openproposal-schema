import { canonicalJson } from "./canonical.ts";

/**
 * A named type as the duplication gate sees it: its name, its structure (the
 * schema it will be emitted as), and, for a kernel type, the concept of the
 * domain model it represents. `where` names the file that defines it, for
 * messages.
 */
export interface NamedStructure {
  name: string;
  structure: unknown;
  /**
   * The concept of `kernel/domains.yaml` a primitive or a part represents.
   * Two kernel types with the same structure that represent different
   * concepts aren't twins: the domain model states what each one means, and
   * the domain gate holds each concept to one type (type rules § 3a).
   */
  concept?: string;
  where: string;
  /**
   * For a constructor's copy, the application it copies. Two copies of one
   * template applied to the same arguments aren't twins: the template defines
   * them once, and each keeps the name its field gives it (type rules § 5).
   */
  copyOf?: string;
}

/** Keywords that explain a value but don't constrain it. Two types that differ only in these are twins. */
const ANNOTATIONS = new Set(["title", "description", "examples", "default", "$comment", "deprecated", "readOnly", "writeOnly"]);

/** Keywords whose array value is a set, so order doesn't make two structures differ. */
const SETS = new Set(["enum", "required", "type"]);

/**
 * The structure with annotations removed, set-valued keywords sorted, and
 * object keys in canonical order, as canonical JSON. Instance data (`const`,
 * `enum` items, `dependentRequired` names) is kept as it is. Equal
 * fingerprints mean equal structures.
 */
export function fingerprint(structure: unknown): string {
  return canonicalJson(normalize(structure));
}

/** Keywords whose object value maps names to schemas. Its keys are names, not keywords, so none of them is dropped as an annotation. */
const NAME_MAPS = new Set(["properties", "patternProperties", "$defs", "dependentSchemas"]);

/** Keywords whose value is instance data, not a schema. It is compared as it is, so a key such as `description` in a `const` object is kept. */
const DATA = new Set(["const"]);

/** Keywords whose object value maps a property name to a set of property names, compared as data with each set sorted. */
const NAME_SET_MAPS = new Set(["dependentRequired"]);

const sortedSet = (items: unknown[]) => items.map((x) => canonicalJson(x)).sort().map((x) => JSON.parse(x) as unknown);
const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!isMap(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (ANNOTATIONS.has(key)) continue;
    if (DATA.has(key)) out[key] = v;
    else if (SETS.has(key) && Array.isArray(v)) out[key] = sortedSet(v);
    else if (NAME_SET_MAPS.has(key) && isMap(v)) out[key] = Object.fromEntries(Object.entries(v).map(([name, names]) => [name, Array.isArray(names) ? sortedSet(names) : names]));
    else if (NAME_MAPS.has(key) && isMap(v)) out[key] = Object.fromEntries(Object.entries(v).map(([name, schema]) => [name, normalize(schema)]));
    else out[key] = normalize(v);
  }
  return out;
}

/**
 * Concepts of the domain model whose types have one structure, which the
 * domain file declares together, with the decisions that make them distinct
 * types (`shared_structures` in `kernel/domains.yaml`).
 */
export interface SharedStructures {
  sets: { concepts: string[]; decisions: string[] }[];
  /** Where the sets are declared, for messages. */
  file: string;
}

/**
 * The duplication gate (type rules § 5): every name is defined once, and two
 * named types with the same normalized structure fail unless both are copies
 * of one application (`copyOf`), or they represent different concepts of the
 * domain model that one shared-structure set lists together. A set whose
 * types no longer share one structure fails, so a declaration can't outlive
 * its reason; with `complete`, the types are every kernel type, and a set
 * that names a concept no type represents fails too. Returns the problems;
 * empty means no twins.
 */
export function checkDuplication(types: NamedStructure[], shared: SharedStructures = { sets: [], file: "" }, complete = false): string[] {
  const problems: string[] = [];
  const byName = new Map<string, NamedStructure>();
  for (const t of types) {
    const first = byName.get(t.name);
    if (first) problems.push(`${t.where}: "${t.name}" is already defined in ${first.where}; each named type is defined once`);
    else byName.set(t.name, t);
  }

  const prints = new Map<string, string>();
  for (const t of byName.values()) prints.set(t.name, fingerprint(t.structure));

  const groups = new Map<string, string[]>();
  for (const [name, print] of prints) groups.set(print, [...(groups.get(print) ?? []), name]);
  for (const names of groups.values()) {
    const sorted = [...names].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const [a, b] = [byName.get(sorted[i]!)!, byName.get(sorted[j]!)!];
        if (a.copyOf !== undefined && a.copyOf === b.copyOf) continue;
        const structure = fingerprint(a.structure).replace(/\s+/g, " ").trim();
        if (a.concept !== undefined && b.concept !== undefined && a.concept !== b.concept) {
          if (shared.sets.some((x) => x.concepts.includes(a.concept!) && x.concepts.includes(b.concept!))) continue;
          problems.push(
            `${a.where}: "${a.name}" and "${b.name}" have the same structure ${structure} and represent the concepts "${a.concept}" and "${b.concept}", which no shared structure of ${shared.file || "the domain model"} lists together; merge them, or list both concepts with the decision that makes them distinct types and the reason a receiver treats them differently`,
          );
          continue;
        }
        problems.push(
          `${a.where}: "${a.name}" and "${b.name}" have the same structure ${structure}${a.concept !== undefined && a.concept === b.concept ? ` and represent one concept, "${a.concept}"` : ""}; merge them, or give each the concept of the domain model it represents`,
        );
      }
    }
  }
  for (const x of shared.sets) {
    const where = `${shared.file}: shared structure ${x.concepts.join(", ")}`;
    const held = x.concepts.map((c) => ({ c, ts: [...byName.values()].filter((t) => t.concept === c) }));
    if (complete) for (const { c, ts } of held) if (ts.length === 0) problems.push(`${where}: no type represents "${c}"; remove it from the set`);
    const present = held.flatMap(({ ts }) => ts);
    const distinct = [...new Set(present.map((t) => prints.get(t.name)!))];
    if (distinct.length > 1) problems.push(`${where}: their types no longer share one structure (${present.map((t) => t.name).join(", ")}); list together only the concepts whose types do`);
  }
  return problems;
}
