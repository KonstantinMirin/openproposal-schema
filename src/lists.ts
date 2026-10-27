/**
 * The code lists other standards keep, which the specification cites
 * (`kernel/lists.yaml`, type rules § 6): each list's codes and labels as the
 * standard writes them at a pinned commit, or at the version its keeper
 * gives a list published outside git.
 */
import { join } from "node:path";
import { canonicalJson } from "./canonical.ts";
import { readYaml } from "./mapping.ts";
import { compileSchema } from "./pipeline.ts";

export interface ListCode {
  code: string | number;
  label?: string;
}

export interface ExternalList {
  name: string;
  standard: string;
  url: string;
  /** The version the keeper gives a list it publishes outside git, with the SHA-256 of the file the URL served at it. */
  version?: string;
  sha256?: string;
  /** The repository's copy of the file the URL served at `version`, for a URL that serves only the latest version. */
  copy?: string;
  codes: ListCode[];
  /** The codes the list reserves for vendors, from `from` up. */
  vendor?: { from: number; label: string };
}

export interface Lists {
  format: 1;
  lists: ExternalList[];
  file: string;
}

export const LISTS_FILE = join("kernel", "lists.yaml");
const LISTS_SCHEMA = join("kernel", "lists.schema.json");

/** Loads `kernel/lists.yaml` and validates it. Throws on an invalid file, or on a list or a code defined twice. */
export function loadLists(root: string, file = join(root, LISTS_FILE)): Lists {
  const doc = readYaml(file);
  const errors = compileSchema(join(root, LISTS_SCHEMA))(doc);
  if (errors.length > 0) throw new Error(`${file}: not a valid lists file: ${errors.join("; ")}`);
  const lists = (doc as Omit<Lists, "file">).lists;
  const names = new Set<string>();
  for (const l of lists) {
    if (names.has(l.name)) throw new Error(`${file}: the list "${l.name}" is defined twice`);
    names.add(l.name);
    const codes = new Set(l.codes.map((c) => canonicalJson(c.code)));
    if (codes.size !== l.codes.length) throw new Error(`${file}: the list "${l.name}" lists a code twice`);
  }
  return { ...(doc as Omit<Lists, "file">), file };
}

/**
 * The code of a list that a vocabulary's term stands for: the code the
 * declaration's `codes` maps it to, or else the term itself, a decimal term
 * read as an integer code.
 */
export function codeOfTerm(list: ExternalList, term: string, codes: Record<string, string> = {}): ListCode | undefined {
  const want = term in codes ? codes[term]! : /^(0|[1-9][0-9]*)$/.test(term) ? Number(term) : term;
  return list.codes.find((c) => c.code === want);
}
