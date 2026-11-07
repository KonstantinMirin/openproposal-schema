/**
 * A published schema tree as a target reads it: the schema documents its
 * release manifest lists, each by its path in the tree, parsed. A target
 * reads nothing else, not the IR, the model, the mapping, or the decision
 * records, so what it writes is a function of the files a reader can fetch
 * at their `$id`s.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The release manifest at a tree's root, which lists the tree's documents by path. */
export const RELEASE_MANIFEST = "release.json";

/** One published schema document. */
export interface SchemaDoc {
  /** Its path in the tree, as the manifest lists it, as `modules/lists/1/lists.json`. */
  path: string;
  /** Its `$id`. */
  id: string;
  schema: Record<string, unknown>;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The documents of the tree at `root`, sorted by path: each file its release
 * manifest's `files` names, which must parse as a JSON object with a string
 * `$id`. Another lock's tree nested under the root has a manifest of its own
 * and isn't read. Throws on a missing manifest or document, and on a
 * document's path that leaves the tree.
 */
export function readSchemaTree(root: string): SchemaDoc[] {
  const manifestPath = join(root, RELEASE_MANIFEST);
  if (!existsSync(manifestPath)) throw new Error(`${manifestPath}: no release manifest, so the tree's documents aren't listed`);
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!isObject(manifest) || !isObject(manifest.files)) throw new Error(`${manifestPath}: lists no files`);
  return Object.keys(manifest.files)
    .sort()
    .map((path) => {
      if (path.startsWith("/") || path.split("/").some((s) => s === ".." || s === "." || s === "")) throw new Error(`${manifestPath}: lists ${path}, which isn't a path inside the tree`);
      const file = join(root, path);
      if (!existsSync(file)) throw new Error(`${manifestPath}: lists ${path}, which the tree doesn't hold`);
      const schema: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isObject(schema) || typeof schema.$id !== "string") throw new Error(`${file}: not a schema document with a $id`);
      return { path, id: schema.$id, schema };
    });
}
