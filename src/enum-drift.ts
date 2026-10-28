/**
 * The enum drift report of a registry of code lists (`npm run
 * enum-drift`): each list the registry holds, compared code by code with
 * the enums that other artifacts define for it, such as AdCOM's lists with
 * IAB Tech Lab's adcom-proto and Prebid's Go types.
 *
 * `enum-drift/sources.yaml`, valid against
 * `enum-drift/sources.schema.json`, is the reviewed input: each artifact's upstream, the commit it is read at, the
 * folder its reader reads and that folder's git tree SHA, its license's blob
 * SHA, and which enum of each artifact holds each of the registry's lists,
 * or none. The snapshot under `enum-drift/snapshots/<source>/` holds the
 * whole folder and the license, and the folder must hash to the pinned tree, so
 * the report and its checks need no clone: no file can be left out or
 * changed. A reachable clone must agree with every pin too.
 *
 * The comparison is of codes only: for each list and artifact, the codes the
 * registry holds that the enum lacks, the values the enum holds that the
 * registry doesn't, the enum's unset sentinel (a 0 named "unknown" where the
 * list has no code 0), an integer type too narrow for the list's codes or its
 * vendor range, and the enums an artifact still defines for a list whose
 * codes the registry no longer tabulates. A code's version, as "4.3", or
 * `VAST_4_3` in a protocol buffer value's name, where the registry's label
 * and the enum's comment or name state different ones, is reported for a
 * reader to check; names are not otherwise compared, since every artifact
 * names codes its own way.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { canonicalJson } from "./canonical.ts";
import type { SpecIR } from "./ir-types.ts";
import { readYaml } from "./mapping.ts";
import type { ModelDoc } from "./model.ts";
import { compileSchema } from "./pipeline.ts";
import { REPO_ROOT } from "./repo.ts";

export const ENUM_DRIFT_DIR = "enum-drift";
export const ENUM_DRIFT_SOURCES = join(ENUM_DRIFT_DIR, "sources.yaml");
const SOURCES_SCHEMA = join("enum-drift", "sources.schema.json");
export const ENUM_DRIFT_FILES = { data: "enum-drift.json", report: "enum-drift.md" } as const;

/** How an artifact defines its enums. */
export type Reader = "proto" | "go";

export interface EnumDriftSource {
  id: string;
  /** The artifact's name in prose. */
  title: string;
  upstream: string;
  commit: string;
  /** A clone, relative to the repository's root, which must agree with every pin where it is reachable. */
  clone: string;
  reader: Reader;
  /** The folder the reader reads, at the commit, with its git tree SHA; the snapshot holds all of it. */
  folder: string;
  tree: string;
  /** The artifact's license file, kept with the snapshot. */
  license: { path: string; blob: string };
}

export interface EnumDriftList {
  /** The list's section ID in the registry's IR, its anchor, as `list_devicetypes`. */
  list: string;
  /** For each source, the enum that holds the list, or null where the artifact defines none. */
  enums: Record<string, string | null>;
}

export interface EnumDriftSources {
  format: 1;
  /** The registry lock the report reads. */
  lock: string;
  sources: EnumDriftSource[];
  lists: EnumDriftList[];
  file: string;
}

/** Loads a spec's `enum-drift/sources.yaml`. Throws when it is invalid. */
export function loadEnumDriftSources(spec: string): EnumDriftSources {
  const file = join(spec, ENUM_DRIFT_SOURCES);
  const doc = readYaml(file);
  const errors = compileSchema(join(REPO_ROOT, SOURCES_SCHEMA))(doc);
  if (errors.length > 0) throw new Error(`${file}: not a valid enum drift sources file: ${errors.join("; ")}`);
  const loaded = { ...(doc as Omit<EnumDriftSources, "file">), file };
  const ids = loaded.sources.map((x) => x.id);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice !== undefined) throw new Error(`${file}: names the source ${twice} twice`);
  return loaded;
}

/** The snapshot folder of a source. */
export const snapshotDir = (spec: string, s: Pick<EnumDriftSource, "id">): string => join(spec, ENUM_DRIFT_DIR, "snapshots", s.id);

const sha1 = (head: string, body: Buffer) => createHash("sha1").update(`${head} ${body.length}\0`).update(body).digest("hex");

/** A file's git blob SHA-1. */
export const blobSha = (bytes: Buffer): string => sha1("blob", bytes);

/**
 * The git tree SHA-1 of the files under a folder, by path: each file a
 * regular file (mode 100644), each subfolder a tree, in git's order, which
 * sorts a subfolder's name as if it ended in "/".
 */
export function treeSha(files: ReadonlyMap<string, Buffer>, folder: string): string {
  const prefix = `${folder}/`;
  const entries = new Map<string, { mode: string; sha: string }>();
  for (const [path] of files) {
    if (!path.startsWith(prefix)) continue;
    const [name, ...rest] = path.slice(prefix.length).split("/");
    if (rest.length === 0) entries.set(name!, { mode: "100644", sha: blobSha(files.get(path)!) });
    else if (!entries.has(name!)) entries.set(name!, { mode: "40000", sha: treeSha(files, `${folder}/${name}`) });
  }
  const key = (name: string) => (entries.get(name)!.mode === "40000" ? `${name}/` : name);
  const names = [...entries.keys()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const body = Buffer.concat(names.map((n) => Buffer.concat([Buffer.from(`${entries.get(n)!.mode} ${n}\0`), Buffer.from(entries.get(n)!.sha, "hex")])));
  return sha1("tree", body);
}

function git(clone: string, args: string[]): Buffer | null {
  const r = spawnSync("git", ["-C", clone, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** One value of an enum, where the artifact defines it. */
export interface EnumValue {
  name: string;
  value: number;
  /** The comment on the value's line, with the lines that continue it, or the comment block just before it. */
  comment: string;
  line: number;
}

export interface EnumDef {
  name: string;
  file: string;
  line: number;
  /** For a Go type, its integer type, as `int8`; null for a protocol buffer enum, which is 32 bits. */
  type: string | null;
  values: EnumValue[];
}

/**
 * A `//` line that continues the trailing comment of the value before it:
 * the line right after the value, with its `//` in the trailing comment's
 * column. Any other comment line comments the value after it.
 */
const continues = (raw: string, column: number | null) => column !== null && raw.indexOf("//") === column && raw.slice(0, column).trim() === "";

/**
 * The enums of a `.proto` file: each `enum` block, top-level or inside a
 * `message`, named `Outer.Inner` for a nested one, with each value's line
 * and comment. Throws on any line inside an enum it can't read, and on any
 * line that names `enum` and opens none, so no value or enum drops out.
 */
export function readProtoEnums(text: string, file: string): EnumDef[] {
  const out: EnumDef[] = [];
  const stack: { kind: "message" | "enum" | "other"; name: string }[] = [];
  let current: EnumDef | null = null;
  let pending: string[] = [];
  let inBlock = false;
  // The column of the trailing comment of the value on the line before, which a `//` line in that column continues.
  let trailing: number | null = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const n = i + 1;
    let line = raw.trim();
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end < 0) continue;
      inBlock = false;
      line = line.slice(end + 2).trim();
    }
    // A block comment that closes on its line leaves what follows it to read.
    while (line.startsWith("/*")) {
      const end = line.indexOf("*/", 2);
      if (end < 0) {
        inBlock = true;
        line = "";
        break;
      }
      line = line.slice(end + 2).trim();
    }
    if (line === "") {
      if (!inBlock) pending = [];
      trailing = null;
      continue;
    }
    if (line.startsWith("//")) {
      const last = current?.values.at(-1);
      if (last && continues(raw, trailing)) last.comment = `${last.comment} ${line.slice(2).trim()}`.trim();
      else {
        pending.push(line.slice(2).trim());
        trailing = null;
      }
      continue;
    }
    trailing = null;
    const open = /^(message|enum)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$/.exec(line);
    if (open) {
      const kind = open[1] as "message" | "enum";
      stack.push({ kind, name: open[2]! });
      if (kind === "enum") {
        if (current !== null) throw new Error(`${file}:${n}: an enum inside an enum`);
        current = { name: stack.filter((s) => s.kind !== "other").map((s) => s.name).join("."), file, line: n, type: null, values: [] };
      }
      pending = [];
      continue;
    }
    if (/\benum\b/.test(line.replace(/\/\/.*$/, ""))) throw new Error(`${file}:${n}: a line that names enum and opens none the reader can read: ${line}`);
    if (line === "}") {
      const top = stack.pop();
      if (!top) throw new Error(`${file}:${n}: a "}" that closes nothing`);
      if (top.kind === "enum") {
        out.push(current!);
        current = null;
      }
      pending = [];
      continue;
    }
    if (current !== null) {
      const v = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?[0-9]+)\s*;\s*(?:\/\/\s*(.*))?$/.exec(line);
      if (!v) throw new Error(`${file}:${n}: a line in enum ${current.name} the reader can't read: ${line}`);
      current.values.push({ name: v[1]!, value: Number(v[2]), comment: (v[3] ?? pending.join(" ")).trim(), line: n });
      trailing = v[3] !== undefined ? raw.indexOf("//") : null;
      pending = [];
      continue;
    }
    // Outside an enum, a message's fields and the file's options aren't read; a block they open is closed by its own line.
    const opens = (line.replace(/\/\/.*$/, "").match(/\{/g) ?? []).length;
    const closes = (line.replace(/\/\/.*$/, "").match(/\}/g) ?? []).length;
    if (opens > 1 || closes > 1 || (opens === 1 && closes === 1)) throw new Error(`${file}:${n}: a line that opens or closes more than one block, which the reader can't read: ${line}`);
    if (opens === 1) stack.push({ kind: "other", name: "" });
    else if (closes === 1) throw new Error(`${file}:${n}: a "}" after other text, which the reader can't read: ${line}`);
    pending = [];
  }
  if (stack.length > 0 || current !== null || inBlock) throw new Error(`${file}: a block that isn't closed`);
  return out;
}

const GO_INT = /^(u?int(?:8|16|32|64)?)$/;

/**
 * The enums of a Go file: each `type X <integer type>` with the constants of
 * that type its `const ( … )` blocks define, each with its line and comment.
 * Throws on a constant line of a block it can't read, and on a `const` or
 * `type` line in a form it doesn't read.
 */
export function readGoEnums(text: string, file: string): EnumDef[] {
  const lines = text.split("\n");
  const types = new Map<string, EnumDef>();
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i]!.replace(/\/\/.*$/, "").trim();
    if (!/^type\b/.test(code)) continue;
    const t = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\S+)$/.exec(code);
    if (t && GO_INT.test(t[2]!)) types.set(t[1]!, { name: t[1]!, file, line: i + 1, type: t[2]!, values: [] });
    else if (!t && !/^type\s+[A-Za-z_][A-Za-z0-9_]*\s+(struct|interface)\s*\{/.test(code) && !/^type\s+[A-Za-z_][A-Za-z0-9_]*\s+[\][*A-Za-z0-9_.]+$/.test(code)) throw new Error(`${file}:${i + 1}: a type declaration the reader can't read: ${code}`);
  }
  let inConst = false;
  let pending: string[] = [];
  let trailing: number | null = null;
  let last: EnumValue | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (!inConst) {
      if (/^const\s*\(\s*(\/\/.*)?$/.test(line)) inConst = true;
      else if (/^const\b/.test(line)) throw new Error(`${file}:${i + 1}: a const declaration the reader doesn't read: ${line}`);
      continue;
    }
    if (line === ")") {
      inConst = false;
      pending = [];
      trailing = null;
      continue;
    }
    if (line === "") {
      pending = [];
      trailing = null;
      continue;
    }
    if (line.startsWith("//")) {
      if (last && continues(raw, trailing)) last.comment = `${last.comment} ${line.slice(2).trim()}`.trim();
      else {
        pending.push(line.slice(2).trim());
        trailing = null;
      }
      continue;
    }
    const c = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?[0-9]+)\s*(?:\/\/\s*(.*))?$/.exec(line);
    if (!c) throw new Error(`${file}:${i + 1}: a constant the reader can't read: ${line}`);
    const def = types.get(c[2]!);
    if (!def) throw new Error(`${file}:${i + 1}: the constant ${c[1]} has the type ${c[2]}, which the file doesn't define as an integer type`);
    last = { name: c[1]!, value: Number(c[3]), comment: (c[4] ?? pending.join(" ")).trim(), line: i + 1 };
    def.values.push(last);
    trailing = c[4] !== undefined ? raw.indexOf("//") : null;
    pending = [];
  }
  if (inConst) throw new Error(`${file}: a const block that isn't closed`);
  return [...types.values()].filter((d) => d.values.length > 0);
}

/** The enums a source's reader finds in one file. */
export const readEnums = (reader: Reader, text: string, file: string): EnumDef[] => (reader === "proto" ? readProtoEnums(text, file) : readGoEnums(text, file));

/** The files of a source's folder its reader reads: its `.proto` files, or its `.go` files but tests, at any depth. */
export const readFiles = (s: Pick<EnumDriftSource, "reader" | "folder">, files: ReadonlyMap<string, Buffer>): string[] =>
  [...files.keys()].filter((p) => p.startsWith(`${s.folder}/`) && (s.reader === "proto" ? p.endsWith(".proto") : p.endsWith(".go") && !p.endsWith("_test.go"))).sort();

/** Every file a source's snapshot holds, by its path in the artifact. */
export function snapshotFiles(spec: string, s: EnumDriftSource): Map<string, Buffer> {
  const dir = snapshotDir(spec, s);
  const out = new Map<string, Buffer>();
  const walk = (rel: string) => {
    const abs = join(dir, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) for (const f of readdirSync(abs).sort()) walk(rel === "" ? f : `${rel}/${f}`);
    else out.set(rel, readFileSync(abs));
  };
  walk("");
  return out;
}

/** Every source's snapshot files, by source. */
export const allSnapshotFiles = (spec: string, sources: EnumDriftSources): Map<string, Map<string, Buffer>> => new Map(sources.sources.map((s) => [s.id, snapshotFiles(spec, s)]));

/**
 * Checks each source's snapshot against its pins: its folder hashes to the
 * pinned tree, its license to the pinned blob, and it holds nothing else.
 * Where the source's clone is reachable, the clone must have the commit,
 * and the folder and the license there must have the pinned SHAs too.
 */
export function checkEnumDriftSnapshots(sources: EnumDriftSources, files: Map<string, Map<string, Buffer>>, root: string = REPO_ROOT): { problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  for (const s of sources.sources) {
    const snap = files.get(s.id) ?? new Map<string, Buffer>();
    const tree = treeSha(snap, s.folder);
    if (tree !== s.tree) problems.push(`${s.id}: the snapshot's ${s.folder}/ is tree ${tree}, not the pinned ${s.tree}`);
    const license = snap.get(s.license.path);
    if (!license) problems.push(`${s.id}: the snapshot has no ${s.license.path}`);
    else if (blobSha(license) !== s.license.blob) problems.push(`${s.id}: the snapshot's ${s.license.path} is blob ${blobSha(license)}, not the pinned ${s.license.blob}`);
    for (const p of snap.keys()) if (p !== s.license.path && !p.startsWith(`${s.folder}/`)) problems.push(`${s.id}: the snapshot holds ${p}, which is neither in ${s.folder}/ nor the license`);
    const clone = resolve(root, s.clone);
    if (!existsSync(clone)) {
      notes.push(`${s.id}: checked against its pins; no clone reachable`);
      continue;
    }
    if (git(clone, ["cat-file", "-e", `${s.commit}^{commit}`]) === null) {
      problems.push(`${s.id}: the clone at ${s.clone} has no commit ${s.commit}`);
      continue;
    }
    for (const [path, pinned, kind] of [[s.folder, s.tree, "tree"], [s.license.path, s.license.blob, "blob"]] as const) {
      const sha = git(clone, ["rev-parse", `${s.commit}:${path}`])?.toString("utf8").trim() ?? null;
      if (sha !== pinned) problems.push(`${s.id}: ${path} at ${s.commit.slice(0, 7)} in ${s.clone} is ${sha === null ? "absent" : `${kind} ${sha}`}, not the pinned ${pinned}`);
    }
    notes.push(`${s.id}: checked against its pins and the clone at ${s.clone}`);
  }
  return { problems, notes };
}

/** A list of the registry, as the enum drift report compares it. */
export interface RegistryList {
  list: string;
  title: string;
  /** The vocabulary that holds the list's codes; null for a list with no codes. */
  vocabulary: string | null;
  codes: { value: number; label: string }[];
  /** The first code of the vendor range; null where the list reserves none. */
  vendor: number | null;
  /** Whether a row stands for every positive number, as `>0` does. */
  positive: boolean;
}

/** The registry's lists, in its text's order, from a build of it. */
export function registryLists(ir: SpecIR, model: ModelDoc): RegistryList[] {
  return ir.sections
    .filter((s) => /^List:/.test(s.title))
    .map((s) => {
      const rows = new Set(ir.definitions.filter((d) => d.loc.section === s.id).map((d) => d.id));
      const v = model.types.find((t) => t.kind === "vocabulary" && t.terms.some((term) => term.sources.some((x) => rows.has(x))));
      const voc = v && v.kind === "vocabulary" ? v : null;
      return {
        list: s.id,
        title: s.title.replace(/^List:\s*/, ""),
        vocabulary: voc?.name ?? null,
        codes: (voc?.terms ?? []).map((t) => ({ value: t.value as number, label: t.annotation ?? "" })),
        vendor: voc?.vendor?.from ?? null,
        positive: ir.definitions.some((d) => rows.has(d.id) && d.value === ">0"),
      };
    });
}

/** The range of a Go integer type; Go's `int` is 32 bits at least. */
function goRange(type: string): [number, number] {
  const bits = Number(/[0-9]+$/.exec(type)?.[0] ?? 32);
  return type.startsWith("u") ? [0, 2 ** bits - 1] : [-(2 ** (bits - 1)), 2 ** (bits - 1) - 1];
}

/** The versions a text states, as "4.3", "4.3.1", or `4_3` in a name. */
function versions(text: string): string[] {
  const dotted = [...text.matchAll(/(?<![0-9.])([0-9]+(?:\.[0-9]+)+)(?![0-9.])/g)].map((m) => m[1]!);
  const named = [...text.matchAll(/(?<![0-9A-Za-z])([0-9]+(?:_[0-9]+)+)(?![0-9])/g)].map((m) => m[1]!.replaceAll("_", "."));
  return [...new Set([...dotted, ...named])].sort();
}

/** How one list compares with one artifact's enum. */
export interface ListEnumDrift {
  source: string;
  enum: string | null;
  /** Where the enum is defined, as a link at the source's commit; null for none. */
  at: string | null;
  missing: { value: number; label: string }[];
  extra: { value: number; name: string; line: number }[];
  sentinel: { value: number; name: string } | null;
  /** The list's codes and vendor range that the enum's integer type can't hold. */
  narrow: { type: string; max: number; codes: number[]; vendor: boolean } | null;
  /** Codes whose registry label and enum name or comment state different versions. */
  versions: { value: number; label: string; name: string; comment: string; line: number }[];
}

export interface EnumDriftDoc {
  format: 1;
  input: { lock: string; commit: string; blob: string };
  sources: { id: string; title: string; upstream: string; commit: string; reader: Reader; folder: string; files: number }[];
  lists: { list: string; title: string; vocabulary: string | null; codes: number; vendor: number | null; drift: ListEnumDrift[] }[];
  totals: Record<string, { compared: number; noEnum: number; listsMissing: number; missing: number; listsExtra: number; extra: number; sentinels: number; narrow: number; versions: number; removedKept: number }>;
}

/** The blob link of a source's file at its commit, at a line. */
const lineLink = (s: EnumDriftSource, file: string, line: number) => `${s.upstream}/blob/${s.commit}/${file.split("/").map(encodeURIComponent).join("/")}#L${line}`;

/**
 * Compares each list of the registry with each source's enum for it. Fails
 * where the sources file names a list the registry doesn't hold, leaves one
 * out, names an enum the source doesn't define, or leaves one of a source's
 * enums unnamed.
 */
export function compareEnumDrift(input: { sources: EnumDriftSources; ir: SpecIR; model: ModelDoc; files: Map<string, Map<string, Buffer>> }): { doc: EnumDriftDoc; problems: string[] } {
  const { sources, ir, model } = input;
  const problems: string[] = [];
  const lists = registryLists(ir, model);
  const enums = new Map<string, Map<string, EnumDef>>();
  for (const s of sources.sources) {
    const files = input.files.get(s.id) ?? new Map<string, Buffer>();
    const defs = new Map<string, EnumDef>();
    for (const path of readFiles(s, files)) {
      try {
        for (const d of readEnums(s.reader, files.get(path)!.toString("utf8"), path)) {
          if (defs.has(d.name)) problems.push(`${s.id}: ${d.name} is defined twice, in ${defs.get(d.name)!.file} and ${path}`);
          defs.set(d.name, d);
        }
      } catch (e) {
        problems.push(`${s.id}: ${(e as Error).message}`);
      }
    }
    enums.set(s.id, defs);
  }
  const byList = new Map(sources.lists.map((l) => [l.list, l]));
  const where = sources.file.split("/").slice(-2).join("/");
  for (const l of sources.lists) if (!lists.some((x) => x.list === l.list)) problems.push(`${where}: names the list ${l.list}, which the registry doesn't hold`);
  if (byList.size !== sources.lists.length) problems.push(`${where}: names a list twice`);
  for (const s of sources.sources) {
    const named = new Map<string, string>();
    for (const l of sources.lists) {
      if (!(s.id in l.enums)) problems.push(`${where}: ${l.list} says nothing of ${s.id}; give its enum, or null for none`);
      const e = l.enums[s.id];
      if (e === null || e === undefined) continue;
      if (!enums.get(s.id)!.has(e)) problems.push(`${where}: ${l.list} names ${s.id}'s enum ${e}, which its files don't define`);
      if (named.has(e)) problems.push(`${where}: ${s.id}'s enum ${e} is named for ${named.get(e)} and ${l.list}`);
      named.set(e, l.list);
    }
    for (const e of enums.get(s.id)!.keys()) if (!named.has(e)) problems.push(`${where}: ${s.id}'s enum ${e} is named for no list`);
    for (const l of sources.lists) for (const k of Object.keys(l.enums)) if (!sources.sources.some((x) => x.id === k)) problems.push(`${where}: ${l.list} names the source ${k}, which the file doesn't define`);
  }
  const out: EnumDriftDoc["lists"] = [];
  for (const r of lists) {
    const entry = byList.get(r.list);
    if (!entry) {
      problems.push(`${where}: leaves out the list ${r.list}, ${r.title}`);
      continue;
    }
    const codes = new Set(r.codes.map((c) => c.value));
    const covered = (v: number) => codes.has(v) || (r.vendor !== null && v >= r.vendor) || (r.positive && v > 0);
    const drift: ListEnumDrift[] = sources.sources.map((s) => {
      const name = entry.enums[s.id] ?? null;
      const def = name === null ? undefined : enums.get(s.id)!.get(name);
      if (!def) return { source: s.id, enum: null, at: null, missing: [], extra: [], sentinel: null, narrow: null, versions: [] };
      const have = new Map(def.values.map((v) => [v.value, v]));
      // An unset sentinel: a 0 named "unknown", where the list has no code 0.
      const zero = have.get(0);
      const sentinel = zero && !codes.has(0) && /unknown$/i.test(zero.name) ? { value: 0, name: zero.name } : null;
      const missing = r.codes.filter((c) => !have.has(c.value));
      const extra = def.values.filter((v) => !covered(v.value) && !(sentinel && v.value === 0)).map((v) => ({ value: v.value, name: v.name, line: v.line }));
      let narrow: ListEnumDrift["narrow"] = null;
      if (def.type !== null) {
        const [lo, hi] = goRange(def.type);
        const out = r.codes.map((c) => c.value).filter((v) => v < lo || v > hi);
        const vendor = r.vendor !== null && r.vendor > hi;
        if (out.length > 0 || vendor) narrow = { type: def.type, max: hi, codes: out, vendor };
      }
      const vs = r.codes.flatMap((c) => {
        const v = have.get(c.value);
        if (!v) return [];
        // The name and the comment are each checked, so a comment that contradicts a name both agree with is caught.
        const mine = versions(c.label);
        const differs = (text: string) => {
          const theirs = versions(text);
          return mine.length > 0 && theirs.length > 0 && !mine.some((x) => theirs.includes(x));
        };
        // A Go name runs its digits together, as `CreativeVAST42`, so only a protocol buffer value's name states a version.
        return (def.type === null && differs(v.name)) || differs(v.comment) ? [{ value: c.value, label: c.label, name: v.name, comment: v.comment, line: v.line }] : [];
      });
      return { source: s.id, enum: def.name, at: lineLink(s, def.file, def.line), missing, extra, sentinel, narrow, versions: vs };
    });
    out.push({ list: r.list, title: r.title, vocabulary: r.vocabulary, codes: r.codes.length, vendor: r.vendor, drift });
  }
  const totals: EnumDriftDoc["totals"] = {};
  for (const s of sources.sources) {
    const rows = out.map((l) => ({ l, d: l.drift.find((d) => d.source === s.id)! }));
    const coded = rows.filter(({ l }) => l.vocabulary !== null);
    totals[s.id] = {
      compared: coded.filter(({ d }) => d.enum !== null).length,
      noEnum: coded.filter(({ d }) => d.enum === null).length,
      listsMissing: coded.filter(({ d }) => d.missing.length > 0).length,
      missing: coded.reduce((n, { d }) => n + d.missing.length, 0),
      listsExtra: coded.filter(({ d }) => d.extra.length > 0).length,
      extra: coded.reduce((n, { d }) => n + d.extra.length, 0),
      sentinels: rows.filter(({ d }) => d.sentinel !== null).length,
      narrow: rows.filter(({ d }) => d.narrow !== null).length,
      versions: rows.reduce((n, { d }) => n + d.versions.length, 0),
      removedKept: rows.filter(({ l, d }) => l.vocabulary === null && d.enum !== null).length,
    };
  }
  const lock = model.input;
  return {
    doc: {
      format: 1,
      input: { lock: sources.lock, commit: lock.commit, blob: lock.blob },
      sources: sources.sources.map((s) => ({ id: s.id, title: s.title, upstream: s.upstream, commit: s.commit, reader: s.reader, folder: s.folder, files: readFiles(s, input.files.get(s.id) ?? new Map()).length })),
      lists: out,
      totals,
    },
    problems,
  };
}

export const renderEnumDrift = (doc: EnumDriftDoc): string => canonicalJson(doc);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const codeList = (xs: number[]) => xs.join(", ");

/** The enum drift report as markdown, for people to read. */
export function renderEnumDriftMarkdown(doc: EnumDriftDoc, registry: { name: string }): string {
  const lines: string[] = [];
  const s7 = (c: string) => c.slice(0, 7);
  lines.push(`# Enum drift of ${registry.name}'s code lists`, "");
  lines.push(`Generated by \`npm run enum-drift\` from \`enum-drift/sources.yaml\`; don't edit it by hand. It compares each list of ${registry.name}, as the registry holds it on \`${doc.input.lock}\` (commit \`${s7(doc.input.commit)}\`), code by code with the enum each artifact below defines for it:`, "");
  for (const s of doc.sources) lines.push(`- **${s.title}**, [${s.upstream.replace(/^https:\/\/github\.com\//, "")}](${s.upstream}) at [\`${s7(s.commit)}\`](${s.upstream}/tree/${s.commit}): ${plural(s.files, `${s.reader === "proto" ? ".proto" : "Go"} file`)} of [\`${s.folder}/\`](${s.upstream}/tree/${s.commit}/${s.folder}) read.`);
  lines.push("", "Only codes are compared. A code the registry holds and an enum lacks is missing; a value an enum holds that the list doesn't, and that no vendor range or positive-number row covers, is extra. An enum's 0 named \"unknown\", where the list has no code 0, is its unset sentinel and is neither. Where a code's label and the enum's comment, or a protocol buffer value's name, state different versions, the report lists both for a reader to check.", "");
  lines.push("## Totals", "", "| | " + doc.sources.map((s) => s.title).join(" | ") + " |", "|---|" + doc.sources.map(() => "---").join("|") + "|");
  const row = (label: string, f: (t: EnumDriftDoc["totals"][string]) => string) => lines.push(`| ${label} | ${doc.sources.map((s) => f(doc.totals[s.id]!)).join(" | ")} |`);
  row("Lists with codes compared", (t) => String(t.compared));
  row("Lists with codes and no enum", (t) => String(t.noEnum));
  row("Codes missing", (t) => `${t.missing}, in ${plural(t.listsMissing, "list")}`);
  row("Values extra", (t) => `${t.extra}, in ${plural(t.listsExtra, "list")}`);
  row("Enums with an unset sentinel", (t) => String(t.sentinels));
  row("Integer types too narrow", (t) => String(t.narrow));
  row("Codes whose versions differ", (t) => String(t.versions));
  row("Enums of a list the registry no longer tabulates", (t) => String(t.removedKept));
  lines.push("", "## By list", "");
  lines.push("| List | Codes | " + doc.sources.map((s) => s.title).join(" | ") + " |", "|---|---|" + doc.sources.map(() => "---").join("|") + "|");
  for (const l of doc.lists) {
    const cells = l.drift.map((d) => {
      if (d.enum === null) return "no enum";
      const parts: string[] = [];
      if (l.vocabulary === null) parts.push(`still defines it (${d.extra.length} values)`);
      else {
        if (d.missing.length > 0) parts.push(`missing ${codeList(d.missing.map((m) => m.value))}`);
        if (d.extra.length > 0) parts.push(`extra ${codeList(d.extra.map((m) => m.value))}`);
      }
      if (d.narrow) parts.push(`\`${d.narrow.type}\` can't hold ${[...(d.narrow.codes.length > 0 ? [codeList(d.narrow.codes)] : []), ...(d.narrow.vendor ? [`the vendor range from ${l.vendor}`] : [])].join(" or ")}`);
      if (d.versions.length > 0) parts.push(`versions differ at ${codeList(d.versions.map((v) => v.value))}`);
      return `[\`${d.enum}\`](${d.at})${parts.length > 0 ? `: ${parts.join("; ")}` : ": agrees"}`;
    });
    lines.push(`| ${l.title}${l.vocabulary ? ` (\`${l.vocabulary}\`)` : ""} | ${l.vocabulary === null ? "no table" : `${l.codes}${l.vendor !== null ? `, vendors' from ${l.vendor}` : ""}`} | ${cells.join(" | ")} |`);
  }
  const details = doc.lists.flatMap((l) => l.drift.filter((d) => d.missing.length + d.extra.length + d.versions.length > 0 || d.narrow).map((d) => ({ l, d })));
  if (details.length > 0) {
    lines.push("", "## Details", "");
    for (const { l, d } of details) {
      const title = doc.sources.find((s) => s.id === d.source)!.title;
      lines.push(`### ${l.title}, ${title}`, "");
      for (const m of d.missing) lines.push(`- Missing \`${m.value}\`: ${m.label.replaceAll("|", "\\|")}`);
      if (l.vocabulary !== null) for (const x of d.extra) lines.push(`- Extra \`${x.value}\`: \`${x.name}\``);
      else lines.push(`- The registry's text has no table for this list; the enum still defines ${plural(d.extra.length, "value")}: ${codeList(d.extra.map((x) => x.value))}.`);
      if (d.narrow) lines.push(`- \`${d.narrow.type}\` holds at most ${d.narrow.max}${d.narrow.codes.length > 0 ? `, so it can't hold ${codeList(d.narrow.codes)}` : ""}${d.narrow.vendor ? `${d.narrow.codes.length > 0 ? ", or" : ", so it can't hold"} a vendor's code from ${l.vendor}` : ""}.`);
      for (const v of d.versions) lines.push(`- Code \`${v.value}\`: the registry's label is "${v.label}"; the enum's is \`${v.name}\`${v.comment ? `, "${v.comment}"` : ""}.`);
      lines.push("");
    }
  } else lines.push("");
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/**
 * The enum drift report's files for a spec, from its committed IR and mapping:
 * `enum-drift.json`, canonical JSON, and `enum-drift.md`, rendered from it, with the
 * problems of the sources file. The registry's lock is the one the sources
 * file names.
 */
export async function enumDriftFiles(spec: string, sources: EnumDriftSources = loadEnumDriftSources(spec), snapshots: Map<string, Map<string, Buffer>> = allSnapshotFiles(spec, sources)): Promise<{ files: Map<string, string>; doc: EnumDriftDoc; problems: string[] }> {
  const { allLocks, resolveBuild } = await import("./builds.ts");
  const { loadKernel } = await import("./kernel.ts");
  const { loadConstructors } = await import("./constructors.ts");
  const { loadDecisions, loadMappings } = await import("./mapping.ts");
  const { specOf } = await import("./specs/index.ts");
  const lock = allLocks(spec).find((l) => l.name === sources.lock);
  if (!lock) throw new Error(`${sources.file}: names the lock "${sources.lock}", which the spec doesn't have`);
  const build = resolveBuild({ root: spec, lock, mappings: loadMappings(join(spec, "mapping")), decisions: loadDecisions(join(spec, "decisions")), kernel: loadKernel(REPO_ROOT, spec), constructors: loadConstructors(REPO_ROOT, spec) });
  const problems = build.problems.map((p) => `${lock.name}: ${p}`);
  const { doc, problems: compared } = compareEnumDrift({ sources, ir: build.ir, model: build.model, files: snapshots });
  const names = specOf(spec).profile.names;
  const files = new Map([
    [ENUM_DRIFT_FILES.data, renderEnumDrift(doc)],
    [ENUM_DRIFT_FILES.report, renderEnumDriftMarkdown(doc, { name: `${names.short} ${names.edition}` })],
  ]);
  return { files, doc, problems: [...problems, ...compared] };
}
