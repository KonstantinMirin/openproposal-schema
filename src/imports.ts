/**
 * The code lists a spec imports from a registry spec on this site, as
 * OpenProposal imports AdCOM's: its profile's `imports` names the registry
 * and the lock it pins, and each list comes from the registry's committed
 * outputs at that lock, never from a copy. A list's codes and labels are its
 * table's rows in the registry's committed IR, its URL the list's anchor at
 * the lock's commit, and its schema the registry's emitted vocabulary, which
 * the importing spec's schemas `$ref` across hosts.
 *
 * A label is the row's own name where its text starts with one, as
 * "Instream: Pre-roll, mid-roll, …" names `Instream`, and else the row's
 * text; the vendor range's label is its row's text without its final period.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { allLocks } from "./builds.ts";
import { schemaDirOf, type EmittedFile } from "./emit.ts";
import type { SpecIR } from "./ir-types.ts";
import type { ExternalList } from "./lists.ts";
import { loadProfile } from "./profile.ts";
import { REPO_ROOT, specRoot } from "./repo.ts";

/** A registry's emitted vocabulary that an imported list's schema is. */
export interface RegistryRef {
  /** The `$id` of the registry's schema file that holds it. */
  schema: string;
  /** Its name under that file's `$defs`. */
  def: string;
}

/** What a spec's profile imports: a registry spec, and the lock of it the spec pins. */
export interface SpecImport {
  spec: string;
  lock: string;
  /** Where the text cites the registry in a form the agreement would refuse, each with the decision that reads it. */
  allowances?: ImportAllowance[];
}

/**
 * A citation of a registry the text writes in a form the registry agreement
 * refuses, read as the decision record says: a list it names other than as
 * the registry titles it, as the Deals API's "List: Device Type" for AdCOM's
 * List: Device Types (`cites` and `means`), or links into the registry's
 * text at a branch, not at the pinned commit (`links_at`). The decision must
 * stand and cover the row the citation sits in.
 */
export type ImportAllowance = ({ decision: string; cites: string; means: string } | { decision: string; links_at: string }) & {
  /** The locks whose text the allowance reads; without it, every lock's. */
  locks?: string[];
};

/** The file of a registry's lists, under its schema directory. */
const LISTS_FILE = posix.join("modules", "lists", "1", "lists.json");

/** A registry's committed schema files at a lock: their `$id`s and contents. */
export function registryFiles(imp: SpecImport): EmittedFile[] {
  const root = specRoot(imp.spec);
  const lock = allLocks(root).find((l) => l.name === imp.lock);
  if (!lock) throw new Error(`imports the lock "${imp.lock}" of ${imp.spec}, which ${imp.spec} doesn't have`);
  const dir = join(root, schemaDirOf(lock.ir_dir));
  const files = [LISTS_FILE, posix.join("kernel", "1", "kernel.json")];
  return files.map((path) => {
    const file = join(dir, path);
    if (!existsSync(file)) throw new Error(`imports ${imp.spec} at ${imp.lock}, and its schema file ${path} isn't committed; run: npm run emit -- --spec ${imp.spec}`);
    const text = readFileSync(file, "utf8");
    return { path: posix.join("imports", imp.spec, path), schema: JSON.parse(text) as Record<string, unknown>, text };
  });
}

/** The row label a list's code takes: its own name before a colon, or its whole text. */
export const rowLabel = (text: string): string => /^([^:.]{1,40}):/.exec(text)?.[1]?.trim() ?? text;

/** Every list of a registry, at the lock a spec imports it at, with its codes, labels, vendor range, URL, and schema. */
export function importedLists(imp: SpecImport): ExternalList[] {
  const root = specRoot(imp.spec);
  const profile = loadProfile(root);
  if (profile.site?.registry !== true) throw new Error(`imports ${imp.spec}, whose profile marks it no registry of code lists`);
  const lock = allLocks(root).find((l) => l.name === imp.lock);
  if (!lock) throw new Error(`imports the lock "${imp.lock}" of ${imp.spec}, which ${imp.spec} doesn't have`);
  const ir = JSON.parse(readFileSync(join(root, lock.ir_dir, "spec-ir.json"), "utf8")) as SpecIR;
  const lists = registryFiles(imp)[0]!;
  const defs = (lists.schema.$defs ?? {}) as Record<string, { title?: string; description?: string }>;
  const page = `${lock.upstream}/blob/${lock.commit}/${lock.path.split("/").map(encodeURIComponent).join("/")}`;
  const out: ExternalList[] = [];
  for (const [def, s] of Object.entries(defs)) {
    // A vocabulary is titled with its list's heading, or, as written before titles, names it in its description.
    const title = (s.title !== undefined && /^List: /.test(s.title) ? s.title : undefined) ?? /^The codes of (List: .+?)(?:, each with its row's text|$)/.exec(s.description ?? "")?.[1];
    if (title === undefined) continue;
    const section = ir.sections.find((x) => `List: ${/^List:\s*(.*)$/.exec(x.title)?.[1]?.trim()}` === title);
    if (!section) throw new Error(`${imp.spec}: the vocabulary ${def} names ${title}, which no section of its IR at ${imp.lock} titles`);
    const rows = ir.definitions.filter((d) => d.loc.section === section.id);
    const vendor = rows.find((r) => /^\d+\+$/.test(r.value));
    // A code is any integer, negative ones too, as Pod Sequence's -1; a row such as Start Delay Modes' `>0` stands for an extension.
    const codes = rows.filter((r) => /^-?(0|[1-9][0-9]*)$/.test(r.value)).map((r) => ({ code: Number(r.value), label: rowLabel(r.columns[0]?.text ?? "") }));
    const extension = rows.find((r) => !/^-?(0|[1-9][0-9]*)$/.test(r.value) && !/^\d+\+$/.test(r.value));
    out.push({
      name: title,
      standard: profile.title,
      url: `${page}#${section.id}`,
      codes,
      ...(vendor ? { vendor: { from: Number(vendor.value.slice(0, -1)), label: (vendor.columns[0]?.text ?? "").replace(/\.$/, "") } } : {}),
      ...(extension ? { extension: extension.value } : {}),
      registry: { schema: String(lists.schema.$id), def },
    });
  }
  return out;
}

/** Every absolute `$ref` of a schema, without its fragment. */
function absoluteRefs(schema: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) for (const s of schema) absoluteRefs(s, out);
  else if (schema !== null && typeof schema === "object") {
    for (const [k, v] of Object.entries(schema)) {
      if (k === "$ref" && typeof v === "string" && /^https:\/\//.test(v) && URL.canParse(v)) out.add(new URL(v.split("#")[0]!).href);
      else absoluteRefs(v, out);
    }
  }
  return out;
}

let registryIndex: Map<string, EmittedFile> | null = null;

/** Every committed schema file of every registry spec on this site, by its `$id`. */
function registrySchemas(): Map<string, EmittedFile> {
  if (registryIndex) return registryIndex;
  const index = new Map<string, EmittedFile>();
  for (const spec of readdirSync(join(REPO_ROOT, "specs"), { withFileTypes: true })) {
    if (!spec.isDirectory() || !existsSync(join(REPO_ROOT, "specs", spec.name, "spec.yaml"))) continue;
    if (loadProfile(join(REPO_ROOT, "specs", spec.name)).site?.registry !== true) continue;
    for (const lock of allLocks(specRoot(spec.name))) {
      // A lock whose files aren't committed yet holds nothing to resolve; a reference into it is left for the validator to report.
      let files: EmittedFile[];
      try {
        files = registryFiles({ spec: spec.name, lock: lock.name });
      } catch {
        continue;
      }
      for (const f of files) {
        const id = String(f.schema.$id);
        if (index.has(id)) throw new Error(`two registry files have the $id ${id}: ${index.get(id)!.path} and ${f.path}`);
        index.set(id, f);
      }
    }
  }
  registryIndex = index;
  return index;
}

/** A registry spec's committed schema file by its `$id`, or undefined. */
export const registryFileById = (id: string): EmittedFile | undefined => registrySchemas().get(id);

/**
 * A schema tree with the registry files it references across hosts, as
 * OpenProposal's inventory module references AdCOM's lists: each file whose
 * `$id` one of its `$ref`s names, and theirs in turn, so a validator that
 * loads them resolves every reference. A reference to a file neither the
 * tree nor a registry holds is left for the validator to report.
 */
export function withImports(files: readonly EmittedFile[]): EmittedFile[] {
  const have = new Set(files.map((f) => String(f.schema.$id)));
  const out = [...files];
  // Each file's references, absolute and relative, the latter read against its own `$id`, as a registry file a fixture puts in the tree needs.
  const refsOf = (f: EmittedFile) => {
    const base = typeof f.schema.$id === "string" && /^https?:\/\//.test(f.schema.$id) ? f.schema.$id : null;
    return [...absoluteRefs(f.schema), ...(base === null ? [] : [...relativeRefs(f.schema)].flatMap((r) => (URL.canParse(r, base) ? [new URL(r, base).href] : [])))];
  };
  const want = files.flatMap(refsOf);
  while (want.length > 0) {
    const id = want.pop()!;
    if (have.has(id)) continue;
    const f = registrySchemas().get(id);
    if (!f) continue;
    have.add(id);
    out.push(f);
    want.push(...refsOf(f));
  }
  return out;
}

/** Every relative `$ref` of a schema to another file, without its fragment. */
function relativeRefs(schema: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) for (const s of schema) relativeRefs(s, out);
  else if (schema !== null && typeof schema === "object") {
    for (const [k, v] of Object.entries(schema)) {
      if (k === "$ref" && typeof v === "string" && !v.startsWith("#") && !/^[a-z]+:/.test(v)) out.add(v.split("#")[0]!);
      else relativeRefs(v, out);
    }
  }
  return out;
}
