/**
 * A spec's kernel binding, `specs/<spec>/kernel-binding.yaml`: what the spec
 * adds to the shared kernel's definitions.
 *
 * The kernel files, `kernel/primitives.yaml`, `constructors.yaml`, and
 * `domains.yaml`, hold only what is true of a type in every spec: its
 * definition, its constraints, its vectors, its showcase values, and the
 * standards and design sections it rests on. A spec's binding gives, for the
 * same types, what rests on that spec's text: the elements each cites, with
 * their digests and quotes; the decision records each follows, and on which
 * locks; the locks a type exists on; and the member names the spec uses, such
 * as the `currency` member an amount requires beside it. The binding mirrors
 * the kernel files' structure, each list item named as the kernel names it,
 * and the loaders merge the two into one kernel per spec. A spec-bound key in
 * a kernel file, or a binding item the kernel doesn't define, fails the load.
 */
import { join } from "node:path";
import { readYaml } from "./mapping.ts";
import { compileSchema } from "./pipeline.ts";
import { REPO_ROOT } from "./repo.ts";

export const BINDING_FILE = "kernel-binding.yaml";
export const BINDING_SCHEMA = join("kernel", "binding.schema.json");

/** The kernel file a top-level key of a binding belongs to. */
export const BINDING_PARTS = {
  primitives: ["primitives"],
  constructors: ["constructors", "parts"],
  domains: ["domains", "homonyms", "shared_structures", "bases"],
} as const;

export type KernelFile = keyof typeof BINDING_PARTS;

/**
 * The keys a binding gives, by the kernel file and the path of the item that
 * holds them: `[]` steps into each item of a list. Nothing else of a kernel
 * file is the spec's.
 */
export const BOUND_PATHS: Record<KernelFile, readonly string[]> = {
  primitives: [
    "primitives[].decision",
    "primitives[].decision_locks",
    "primitives[].locks",
    "primitives[].sources.spec",
    "primitives[].rules[].source.spec",
    "primitives[].rules[].source.decision",
    "primitives[].rules[].source.decision_locks",
  ],
  constructors: [
    "constructors[].decision",
    "constructors[].decision_locks",
    "constructors[].sources.spec",
    "constructors[].fallback.statement",
    "constructors[].fallback.decision",
    "constructors[].parameters[].carries.member",
    "constructors[].parameters[].carries.decision",
    "constructors[].parameters[].carries.departure",
    "constructors[].rules[].source.spec",
    "constructors[].rules[].source.decision",
    "constructors[].rules[].source.decision_locks",
    "parts[].decision",
    "parts[].decisions",
    "parts[].sources.spec",
    "parts[].rules[].source.spec",
    "parts[].rules[].source.decision",
    "parts[].rules[].source.decision_locks",
  ],
  domains: [
    "domains[].concepts[].decision",
    "domains[].concepts[].sources.spec",
    "domains[].concepts[].requires.member",
    "domains[].concepts[].requires.decision",
    "domains[].concepts[].requires.lacking",
    "homonyms",
    "bases",
    "shared_structures[].decisions",
  ],
};

type Json = Record<string, unknown>;
const isMap = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

/** How a list item is named: by its `name`, its `id`, or, for a shared structure, its concepts. */
export const itemKey = (v: unknown): string | null => {
  if (!isMap(v)) return null;
  if (typeof v.name === "string") return v.name;
  if (typeof v.id === "string") return v.id;
  if (Array.isArray(v.concepts)) return v.concepts.join("+");
  return null;
};

/** Each place in a document a bound path names that holds a value, as a readable location. */
export function boundIn(doc: unknown, paths: readonly string[]): string[] {
  const found: string[] = [];
  const visit = (v: unknown, steps: string[], at: string): void => {
    if (steps.length === 0) {
      found.push(at);
      return;
    }
    const [step, ...rest] = steps as [string, ...string[]];
    const list = step.endsWith("[]");
    const key = list ? step.slice(0, -2) : step;
    if (!isMap(v) || !(key in v)) return;
    const x = v[key];
    if (!list) return visit(x, rest, at === "" ? key : `${at}.${key}`);
    if (Array.isArray(x)) x.forEach((item, n) => visit(item, rest, `${at === "" ? key : `${at}.${key}`}[${itemKey(item) ?? n}]`));
  };
  for (const p of paths) visit(doc, p.split("."), "");
  return found;
}

/**
 * Merges a binding's part into a kernel file's definitions: each object's
 * keys are added, each list item merges into the kernel's item of the same
 * name, an item the binding marks `absent: true` leaves the spec's kernel,
 * and a key both give, or an item the kernel doesn't define, throws.
 */
export function mergeBinding(def: unknown, bind: unknown, at: string): unknown {
  if (isMap(def) && isMap(bind)) {
    const out: Json = { ...def };
    for (const [k, v] of Object.entries(bind)) out[k] = k in def ? mergeBinding(def[k], v, `${at}.${k}`) : v;
    return out;
  }
  if (Array.isArray(def) && Array.isArray(bind)) {
    const out = [...def];
    for (const b of bind) {
      const key = itemKey(b);
      const n = key === null ? -1 : out.findIndex((d) => itemKey(d) === key);
      if (n === -1) throw new Error(`${at}: the binding names "${key}", which the kernel doesn't define`);
      // An item the spec's text never uses, as a money concept in a list registry, is left out of the spec's kernel.
      if ((b as Json).absent === true) {
        out.splice(n, 1);
        continue;
      }
      // The key that names the item is the kernel's; the rest is the binding's.
      const naming = ["name", "id", "concepts"].find((k) => k in (b as Json))!;
      const { [naming]: _named, ...rest } = b as Json;
      out[n] = mergeBinding(out[n], rest, `${at}[${key}]`);
    }
    return out;
  }
  throw new Error(`${at}: both the kernel and the binding give it; the kernel keeps the definition, and the binding what rests on the spec`);
}

export interface KernelBinding {
  format: 1;
  spec: string;
  primitives?: unknown[];
  constructors?: unknown[];
  parts?: unknown[];
  domains?: unknown[];
  homonyms?: unknown[];
  shared_structures?: unknown[];
  bases?: unknown[];
  file: string;
}

/** Loads a spec folder's kernel binding, validated against its schema. Throws when it is missing or names another spec. */
export function loadBinding(spec: string, file = join(spec, BINDING_FILE)): KernelBinding {
  const doc = readYaml(file);
  const errors = compileSchema(join(REPO_ROOT, BINDING_SCHEMA))(doc);
  if (errors.length > 0) throw new Error(`${file}: not a valid kernel binding: ${errors.join("; ")}`);
  const b = { ...(doc as Omit<KernelBinding, "file">), file };
  const folder = spec.split("/").filter((s) => s !== "").pop();
  if (b.spec !== folder) throw new Error(`${file}: "spec" is "${b.spec}"; it must equal the spec's folder, "${folder}"`);
  return b;
}

/**
 * A kernel file's definitions with a binding merged in. Throws when the file
 * holds a key the binding gives (`BOUND_PATHS`), or when the binding names
 * an item the file doesn't define. Without a binding, the definitions alone.
 */
export function bound(kind: KernelFile, file: string, def: unknown, binding: KernelBinding | null): unknown {
  const stray = boundIn(def, BOUND_PATHS[kind]);
  if (stray.length > 0) throw new Error(`${file}: holds ${stray.slice(0, 5).join(", ")}, which rest on a spec; a spec's kernel binding gives them`);
  if (binding === null) return def;
  const part = Object.fromEntries(BINDING_PARTS[kind].flatMap((k) => (binding[k] !== undefined ? [[k, binding[k]]] : [])));
  const unbound = unboundIn(part, BOUND_PATHS[kind]);
  if (unbound.length > 0) throw new Error(`${binding.file}: gives ${unbound.slice(0, 5).join(", ")}, which the kernel defines for every spec; a binding gives only what rests on its spec`);
  return mergeBinding(def, part, binding.file);
}

/**
 * Each key of a binding no bound path names: a binding gives the bound keys,
 * and names each list item it binds by the key the kernel names it with.
 */
export function unboundIn(doc: unknown, paths: readonly string[]): string[] {
  const out: string[] = [];
  const steps = paths.map((p) => p.split("."));
  const visit = (v: unknown, prefix: string[], at: string): void => {
    if (!isMap(v)) return;
    for (const [k, x] of Object.entries(v)) {
      const here = `${at === "" ? "" : `${at}.`}${k}`;
      const exact = steps.some((s) => s.length === prefix.length + 1 && s.slice(0, prefix.length).join(".") === prefix.join(".") && s[prefix.length] === k);
      if (exact) continue;
      const list = steps.some((s) => s.length > prefix.length + 1 && s.slice(0, prefix.length).join(".") === prefix.join(".") && s[prefix.length] === `${k}[]`);
      const object = steps.some((s) => s.length > prefix.length + 1 && s.slice(0, prefix.length).join(".") === prefix.join(".") && s[prefix.length] === k);
      if (list && Array.isArray(x)) x.forEach((item, n) => visitItem(item, [...prefix, `${k}[]`], `${here}[${itemKey(item) ?? n}]`));
      else if (object && isMap(x)) visit(x, [...prefix, k], here);
      else out.push(here);
    }
  };
  /** A list item: its naming key, then the keys the paths give. */
  const visitItem = (v: unknown, prefix: string[], at: string): void => {
    if (!isMap(v)) {
      out.push(at);
      return;
    }
    const naming = "name" in v ? "name" : "id" in v ? "id" : "concepts" in v ? "concepts" : null;
    if (naming === null) out.push(`${at} (no name, id, or concepts to find it by)`);
    const { [naming ?? ""]: _named, ...rest } = v;
    // An item the spec's text never uses is absent from its kernel, and says so alone.
    if (rest.absent === true && Object.keys(rest).length === 1) return;
    if ("absent" in rest) out.push(`${at}.absent (an absent item gives nothing else, and absent is true)`);
    visit(rest, prefix, at);
  };
  visit(doc, [], "");
  return out;
}
