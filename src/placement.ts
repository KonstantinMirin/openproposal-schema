/**
 * Where each named type is written (type rules § 3 and § 4): inline at each
 * use, in the kernel, in one module, or in the composition of the top layer.
 *
 * - **Inline.** A type that restates a JSON type, a primitive whose schema is
 *   its `type` alone or an open object with no member, has no definition of
 *   its own unless the specification names it (a `def:` row of that name, as
 *   the stack's § 2.2 names `Amount`). Each use writes `{ "type": … }` with
 *   its own description. The model keeps the type, for its concept.
 * - **Composition.** The documents, the profiles and the objects they
 *   project, an object that includes a profile or holds a document, and a
 *   type that holds another module's structure (an object, a union, or a
 *   copy) compose, so they are the top layer's, and so is every type that
 *   references one of them. They sit in `documents/1/composition.json`, once
 *   each; a document's file is a root that references its definition there.
 * - **Copies.** A copy of a constructor goes with the types it is built from:
 *   to the module of its non-kernel arguments, or, built from kernel types
 *   alone, to the one module that uses it, or the kernel when several do.
 * - **Shared.** A module's type that another module or the kernel uses
 *   moves down to the kernel. What is left to move after composition is a
 *   scalar: a primitive, a vocabulary, or a union of them.
 *
 * `placementProblems` is the layer gate's half that reads homes: the kernel's
 * primitives stand alone, its composites reference only primitives, a module
 * references only the kernel and itself, and nothing below the top layer
 * references it.
 */
import type { ModelType } from "./model.ts";
import { KERNEL_MODULE } from "./mapping-rules.ts";

/** The home of the top layer's types: `documents/1/composition.json`. */
export const COMPOSITION = "composition";

const ANNOTATIONS = new Set(["description", "title", "examples", "default"]);

/** Whether the specification names a type: a definition row of that name, as the stack's § 2.2 writes `Amount`. */
export const namedBySpec = (t: ModelType): boolean => t.sources.some((s) => s.startsWith("def:") && s.slice(s.lastIndexOf(":") + 1) === t.name);

/** Whether a type restates a JSON type and adds nothing to it: a primitive of `type` alone, or an open object with no member, that the specification doesn't name. */
export function restatesJsonType(t: ModelType): boolean {
  if (namedBySpec(t)) return false;
  if (t.kind === "primitive") return Object.keys(t.schema).every((k) => k === "type" || ANNOTATIONS.has(k));
  if (t.kind === "object") return t.open && Object.keys(t.properties).length === 0 && t.includes === undefined && t.projects === undefined;
  return false;
}

/** Whether the schema leaves a type out: a constructor, which is a template, and a vocabulary of a model attribute, such as the markers. */
export const leftOut = (t: ModelType): boolean => t.kind === "constructor" || (t.kind === "vocabulary" && t.attribute !== undefined);

/** The named types a type's emitted schema references: its references, less the types written inline. */
export function emittedReferences(t: ModelType, types: ReadonlyMap<string, ModelType>): string[] {
  return t.references.filter((r) => {
    const u = types.get(r);
    return u !== undefined && !u.inline && !leftOut(u);
  });
}

/** Whether a type's values are scalars: a primitive, a vocabulary, or a union of scalars. */
export function isScalar(t: ModelType, types: ReadonlyMap<string, ModelType>, seen = new Set<string>()): boolean {
  if (t.kind === "primitive" || t.kind === "vocabulary") return true;
  if (t.kind !== "union" || seen.has(t.name)) return false;
  return emittedReferences(t, types).every((r) => isScalar(types.get(r)!, types, new Set([...seen, t.name])));
}

/** Sets each type's `inline` and `home` (type rules § 3 and § 4). Mutates `types`. */
export function place(types: Map<string, ModelType>): void {
  for (const t of types.values()) {
    delete t.inline;
    delete t.home;
    if (!leftOut(t) && restatesJsonType(t)) t.inline = true;
  }
  const placed = [...types.values()].filter((t) => !leftOut(t) && !t.inline).sort((a, b) => (a.name < b.name ? -1 : 1));
  const refs = new Map(placed.map((t) => [t.name, emittedReferences(t, types)]));
  const users = new Map<string, string[]>(placed.map((t) => [t.name, []]));
  for (const t of placed) for (const r of refs.get(t.name)!) users.get(r)?.push(t.name);
  const home = new Map<string, string>();
  for (const t of placed) {
    const top = t.kind === "document" || t.kind === "profile" || t.layer === 5 || (t.kind === "object" && (t.includes !== undefined || t.projects !== undefined));
    home.set(t.name, top ? COMPOSITION : t.module);
  }
  const homeOf = (n: string) => home.get(n)!;
  // A type that references the top layer is the top layer's.
  const lift = () => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const t of placed) {
        if (homeOf(t.name) !== COMPOSITION && refs.get(t.name)!.some((r) => homeOf(r) === COMPOSITION)) {
          home.set(t.name, COMPOSITION);
          changed = true;
        }
      }
    }
  };
  for (let round = 0; ; round++) {
    if (round > types.size) throw new Error("placing the types doesn't settle");
    const before = JSON.stringify([...home]);
    lift();
    // A copy goes with the types it is built from, or with the one module that uses it; one that spans modules composes them.
    for (const t of placed) {
      if (t.kind !== "copy" || homeOf(t.name) === COMPOSITION) continue;
      const from = new Set(refs.get(t.name)!.map(homeOf).filter((h) => h !== KERNEL_MODULE));
      if (from.size === 1) home.set(t.name, [...from][0]!);
      else if (from.size > 1) home.set(t.name, COMPOSITION);
      else {
        const by = new Set(users.get(t.name)!.map(homeOf).filter((h) => h !== COMPOSITION));
        if (by.size === 1) home.set(t.name, [...by][0]!);
        else if (by.size > 1) home.set(t.name, KERNEL_MODULE);
      }
    }
    lift();
    // A type that holds another module's structure, an object, a union, or a copy, composes the two: the top layer's.
    for (const t of placed) {
      const h = homeOf(t.name);
      if (h === COMPOSITION) continue;
      if (refs.get(t.name)!.some((r) => ![KERNEL_MODULE, COMPOSITION, h].includes(homeOf(r)) && !isScalar(types.get(r)!, types))) home.set(t.name, COMPOSITION);
    }
    lift();
    // A module's scalar that another home below the top uses moves down to the kernel.
    for (let changed = true; changed; ) {
      changed = false;
      for (const t of placed) {
        const h = homeOf(t.name);
        if (h === COMPOSITION || h === KERNEL_MODULE) continue;
        if (users.get(t.name)!.some((u) => homeOf(u) !== COMPOSITION && homeOf(u) !== h)) {
          home.set(t.name, KERNEL_MODULE);
          changed = true;
        }
      }
    }
    if (JSON.stringify([...home]) === before) break;
  }
  for (const t of placed) t.home = home.get(t.name)!;
}

/**
 * The layer gate's half that reads homes (type rules § 3): a reference that
 * runs sideways inside the kernel or between modules, or up to the top layer
 * from below it. Inside the kernel, a primitive references at most a
 * primitive that references nothing, as an open vocabulary its extension
 * term, and a composite references only primitives. A module references the
 * kernel and itself. The top layer references anything below it, and itself.
 */
export function placementProblems(types: readonly ModelType[]): string[] {
  const byName = new Map(types.map((t) => [t.name, t]));
  const problems: string[] = [];
  for (const t of types) {
    if (leftOut(t) || t.inline) continue;
    if (t.home === undefined) {
      problems.push(`${t.module}: ${t.kind} "${t.name}" has no home; the model places every type it emits (type rules § 3)`);
      continue;
    }
    for (const r of emittedReferences(t, byName)) {
      const u = byName.get(r)!;
      const where = `${t.module}: ${t.kind} "${t.name}" (${t.home})`;
      if (t.home === COMPOSITION) continue;
      if (u.home === COMPOSITION) problems.push(`${where} references the ${u.kind} "${r}" of the top layer's composition; only the top layer composes (type rules § 3)`);
      else if (t.home === KERNEL_MODULE) {
        if (u.home !== KERNEL_MODULE) problems.push(`${where} references the ${u.kind} "${r}" of module "${u.home}"; the kernel references no module (type rules § 3)`);
        else if (isScalar(t, byName) && emittedReferences(u, byName).length > 0) problems.push(`${where} references the ${u.kind} "${r}", which references other types; a kernel primitive references at most a primitive that stands alone (type rules § 3)`);
        else if (!isScalar(t, byName) && !isScalar(u, byName)) problems.push(`${where} references the ${u.kind} "${r}"; a kernel composite references only primitives (type rules § 3)`);
      } else if (u.home !== KERNEL_MODULE && u.home !== t.home) problems.push(`${where} references the ${u.kind} "${r}" of module "${u.home}"; a module references only the kernel and itself (type rules § 3)`);
    }
  }
  return problems.sort();
}
