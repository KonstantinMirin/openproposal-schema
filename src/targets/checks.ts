/**
 * What every target is held to beyond its output: its emitter reads only the
 * published schema tree, so the modules it imports are the targets' own and
 * only the tree's reader touches the file system, and its code names no
 * spec, so each name comes from a schema or a profile.
 */
import { posix } from "node:path";

/** The folder that holds every target's code; an emitter imports nothing from outside it. */
export const TARGETS_DIR = "src/targets";

/** Every module a file imports, statically or dynamically, by its specifier, and each call that loads a module the specifier of which isn't a string literal. */
export function importsOf(text: string): { specifiers: string[]; computed: string[] } {
  const specifiers: string[] = [];
  for (const m of text.matchAll(/^\s*(?:import|export)\b[^"'`;]*?\bfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm)) specifiers.push(m[1] ?? m[2] ?? m[3]!);
  // A dynamic import of anything but a string literal, and any require, can load a module no specifier names.
  const computed = [...text.matchAll(/\bimport\(\s*(?!["'][^"']+["']\s*\))[^)]*\)?|\brequire\s*\(|\bcreateRequire\b/g)].map((m) => m[0].trim());
  return { specifiers: [...new Set(specifiers)].sort(), computed };
}

/** The repository modules a file imports, statically or dynamically, by path from the root. */
export function localImports(file: string, text: string): string[] {
  return importsOf(text)
    .specifiers.filter((x) => x.startsWith("."))
    .map((x) => posix.normalize(posix.join(posix.dirname(file), x)))
    .sort();
}

/** The built-in modules an emitter may import: paths anywhere, and the file system only in the module that reads the schema tree. */
const BUILTINS = new Set(["node:path"]);
const FS = new Set(["node:fs"]);

/**
 * The problems of an emitter's imports: every module its entry reaches must
 * be a repository module under `TARGETS_DIR`, or `node:path`, or `node:fs`
 * in `reader` alone, the module that reads the published schema tree, and
 * none may load a module by a computed name. So the emitter can read no
 * file but through the reader: not the IR, the model, the mapping, or the
 * decisions. `read` gives a module's text by path from the root.
 */
export function importsOutsideTargets(entry: string, read: (path: string) => string, reader: string): { problems: string[]; reached: string[] } {
  const problems: string[] = [];
  const reached = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (reached.has(file)) continue;
    reached.add(file);
    const text = read(file);
    const { specifiers, computed } = importsOf(text);
    for (const c of computed) problems.push(`${file} loads a module by a computed name (${c}), which no check can follow; import it by its path`);
    for (const x of specifiers) {
      if (x.startsWith(".")) {
        const dep = posix.normalize(posix.join(posix.dirname(file), x));
        if (!dep.startsWith(`${TARGETS_DIR}/`)) problems.push(`${file} imports ${dep}, which isn't a target's module under ${TARGETS_DIR}/; an emitter reads only the published schemas`);
        else queue.push(dep);
      } else if (BUILTINS.has(x) || (FS.has(x) && file === reader)) continue;
      else problems.push(`${file} imports ${x}, which an emitter may not; only ${reader} reads files, through node:fs, and the others import node:path at most`);
    }
  }
  return { problems, reached: [...reached].sort() };
}

/** The lines of target code that name a spec: its folder's name, or the name its profile gives, in any case. */
export function namesASpec(sources: ReadonlyMap<string, string>, names: readonly string[]): string[] {
  const out: string[] = [];
  for (const [path, text] of sources) {
    const lines = text.split("\n");
    for (const name of names) {
      const re = new RegExp(`(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i");
      const at = lines.findIndex((l) => re.test(l));
      if (at >= 0) out.push(`${path}:${at + 1}: names "${name}", a spec's name; a target reads every name from a schema or a profile`);
    }
  }
  return out;
}
