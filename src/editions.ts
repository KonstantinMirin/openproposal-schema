/**
 * Editions of kernel types. Where one lock's text defines a type the kernel
 * defines under the same name in another form, as the stack's `Digest`
 * (`sha256:` and 64 hexadecimal characters) or its § 3.1 `Selectable`, the
 * kernel file holds that form as an edition of the type, and the spec's
 * binding publishes the edition on that lock (`locks`). On a lock where an
 * edition is published it stands in for the type without an edition; on
 * every other lock it doesn't exist, so the other locks' kernels are what
 * they were.
 */
import type { Constructors } from "./constructors.ts";
import type { Kernel } from "./kernel.ts";

interface Item {
  name: string;
  edition?: string;
  locks?: string[];
}

const on = (i: Item, lock: string) => i.locks === undefined || i.locks.includes(lock);

/**
 * The items as one lock sees them: an edition only on its locks, and the
 * type without an edition only where no edition of it is published. With
 * `scoped`, as constructors and parts are, an item without an edition is also
 * left out on a lock its `locks` don't name; primitives keep theirs, which
 * `kernelOn` reads.
 */
export function editionsOn<T extends Item>(items: readonly T[], lock: string, scoped: boolean): T[] {
  const editions = new Set(items.filter((i) => i.edition !== undefined && on(i, lock)).map((i) => i.name));
  return items.filter((i) => (i.edition !== undefined ? on(i, lock) : !editions.has(i.name) && (!scoped || on(i, lock))));
}

/**
 * The kernel as each edition sees it, for the checks that hold for every
 * lock: the types with no edition, and for each edition the kernel with it
 * standing in for the types it shares a name with. Every type is in at
 * least one view, and no view holds two types of one name.
 */
export function editionViews<K extends { primitives: Item[] }, C extends { constructors: Item[]; parts: Item[] }>(kernel: K, constructors: C): { kernel: K; constructors: C }[] {
  const tags = [...new Set([...kernel.primitives, ...constructors.constructors, ...constructors.parts].flatMap((i) => (i.edition ? [i.edition] : [])))].sort();
  const view = <T extends Item>(items: readonly T[], tag: string | null): T[] => {
    const shadowed = new Set(items.filter((i) => tag !== null && i.edition === tag).map((i) => i.name));
    return items.filter((i) => (i.edition === undefined ? !shadowed.has(i.name) : i.edition === tag));
  };
  return [null, ...tags].map((tag) => ({
    kernel: { ...kernel, primitives: view(kernel.primitives, tag) },
    constructors: { ...constructors, constructors: view(constructors.constructors, tag), parts: view(constructors.parts, tag) },
  }));
}

/** The kernel's primitives as one lock sees them. */
export const kernelEditionsOn = (kernel: Kernel, lock: string): Kernel => ({ ...kernel, primitives: editionsOn(kernel.primitives, lock, false) });

/** The constructors and parts as one lock sees them. */
export const constructorEditionsOn = (c: Constructors, lock: string): Constructors => ({ ...c, constructors: editionsOn(c.constructors, lock, true), parts: editionsOn(c.parts, lock, true) });
