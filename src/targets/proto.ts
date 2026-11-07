/**
 * The protocol buffer target: each integer-coded vocabulary of a published
 * schema tree as a proto3 enum, by the target rules
 * (docs/design/target-rules.md). It reads the tree's documents
 * (src/targets/schema-tree.ts) and the package its settings name, and
 * nothing else.
 *
 * - One `.proto` file for each document that defines a vocabulary, named as
 *   the document in lower_snake_case, under the package's folders.
 * - One enum for each vocabulary, named as its `$defs` key.
 * - One value for each code, numbered as the code, named the enum's name in
 *   UPPER_SNAKE, then the code's name (src/targets/names.ts).
 * - Zero is the code 0 where the vocabulary has one, and else
 *   `<ENUM>_UNSPECIFIED`, which is no code.
 * - A branch that is no single code, such as a vendor range, is no value. A
 *   proto3 enum is open, so a field of it keeps such a number; the enum's
 *   comment says what the branch allows.
 */
import { posix } from "node:path";
import { codeNames, typeUpperSnake } from "./names.ts";
import type { SchemaDoc } from "./schema-tree.ts";

/** What a spec's profile gives the target (`names.proto`). */
export interface ProtoSettings {
  package: string;
}

export interface ProtoValue {
  name: string;
  number: number;
  /** The code's title; empty for the unset value. */
  title: string;
  description: string | null;
}

/** A vocabulary branch that isn't one code, such as a vendor range, described for the enum's comment. */
export interface ProtoExtension {
  title: string;
  allows: string;
  description: string | null;
}

export interface ProtoEnum {
  name: string;
  /** The file it is written to, by path under the target's folder. */
  file: string;
  /** The vocabulary it is written from, as `<$id>#/$defs/<name>`. */
  source: string;
  values: ProtoValue[];
  extensions: ProtoExtension[];
}

export interface ProtoOutput {
  files: { path: string; text: string }[];
  enums: ProtoEnum[];
  problems: string[];
}

/** The numbers a proto enum value can take. */
export const INT32 = { min: -(2 ** 31), max: 2 ** 31 - 1 } as const;

/** The longest comment line, its indentation and `// ` included, as the proto style guide's 80 columns; a word longer than that, such as a URL, stands on a line of its own. */
const WIDTH = 80;

/** A proto package: lowercase dotted words ending in a version, as the profile's schema requires of `names.proto.package`. */
export const PACKAGE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*\.v[0-9]+$/;

const VOCABULARY_KEYS = new Set(["type", "oneOf", "title", "description"]);
const CODE_KEYS = new Set(["const", "title", "description"]);
const EXTENSION_KEYS = new Set(["type", "title", "description", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "not"]);

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Whether a schema is an integer-coded vocabulary: `type: integer` and a `oneOf` with a `const` branch. */
export const isIntegerCoded = (s: unknown): s is Record<string, unknown> & { oneOf: unknown[] } =>
  isObject(s) && s.type === "integer" && Array.isArray(s.oneOf) && s.oneOf.some((b) => isObject(b) && "const" in b);

/** The integers an extension branch allows, in words, as "an integer of at least 500". */
function allows(b: Record<string, unknown>): string {
  const parts: string[] = [];
  const num = (k: string) => (typeof b[k] === "number" ? (b[k] as number) : null);
  const [min, max, xmin, xmax] = [num("minimum"), num("maximum"), num("exclusiveMinimum"), num("exclusiveMaximum")];
  if (min !== null && max !== null) parts.push(`from ${min} to ${max}`);
  else if (min !== null) parts.push(`of at least ${min}`);
  else if (max !== null) parts.push(`of at most ${max}`);
  if (xmin !== null) parts.push(`greater than ${xmin}`);
  if (xmax !== null) parts.push(`less than ${xmax}`);
  const not = isObject(b.not) ? b.not.const : undefined;
  const text = `an integer${parts.length > 0 ? ` ${parts.join(" and ")}` : ""}`;
  return not !== undefined ? `${text}, other than ${String(not)}` : text;
}

/** Reads one vocabulary into an enum, or gives the problems that stop it. */
function readVocabulary(name: string, s: Record<string, unknown> & { oneOf: unknown[] }, at: string, file: string): { e: ProtoEnum | null; problems: string[] } {
  const problems: string[] = [];
  for (const k of Object.keys(s)) if (!VOCABULARY_KEYS.has(k)) problems.push(`${at}: has "${k}", which the proto target doesn't read`);
  const codes: { code: number; title: string; description: string | null }[] = [];
  const extensions: ProtoExtension[] = [];
  s.oneOf.forEach((b, i) => {
    const where = `${at}/oneOf/${i}`;
    if (!isObject(b)) return problems.push(`${where}: not an object`);
    if (typeof b.title !== "string" || b.title === "") return problems.push(`${where}: has no title, which names its value`);
    const description = typeof b.description === "string" ? b.description : null;
    if ("const" in b) {
      for (const k of Object.keys(b)) if (!CODE_KEYS.has(k)) problems.push(`${where}: a code's branch has "${k}", which the proto target doesn't read`);
      if (typeof b.const !== "number" || !Number.isInteger(b.const)) return problems.push(`${where}: the code ${JSON.stringify(b.const)} isn't an integer`);
      if (b.const < INT32.min || b.const > INT32.max) return problems.push(`${where}: the code ${b.const} is outside int32, which a proto enum value is`);
      codes.push({ code: b.const, title: b.title, description });
      return;
    }
    for (const k of Object.keys(b)) if (!EXTENSION_KEYS.has(k)) problems.push(`${where}: a branch that isn't a code has "${k}", which the proto target doesn't read`);
    if (b.type !== "integer") problems.push(`${where}: a branch that isn't a code isn't type integer`);
    if ("not" in b && !(isObject(b.not) && Object.keys(b.not).length === 1 && typeof b.not.const === "number")) problems.push(`${where}: its "not" isn't one code's const`);
    extensions.push({ title: b.title, allows: allows(b), description });
  });
  const seen = new Set<number>();
  for (const c of codes) {
    if (seen.has(c.code)) problems.push(`${at}: lists the code ${c.code} twice`);
    seen.add(c.code);
  }
  if (problems.length > 0) return { e: null, problems };
  const prefix = typeUpperSnake(name);
  const zero = codes.find((c) => c.code === 0);
  // The unset value's name is taken, so a code named as it takes its code as a suffix.
  const ordered = zero ? [zero, ...codes.filter((c) => c !== zero)] : codes;
  let names: string[];
  try {
    names = codeNames(ordered, zero ? new Set() : new Set(["UNSPECIFIED"]));
  } catch (e) {
    return { e: null, problems: [`${at}: ${(e as Error).message}`] };
  }
  const values: ProtoValue[] = [
    ...(zero ? [] : [{ name: `${prefix}_UNSPECIFIED`, number: 0, title: "", description: null }]),
    ...ordered.map((c, i) => ({ name: `${prefix}_${names[i]!}`, number: c.code, title: c.title, description: c.description })),
  ];
  return { e: { name, file, source: at, values, extensions }, problems: [] };
}

/** A text as `//` comment lines of at most `WIDTH` columns at an indentation, but where one word is longer; an empty paragraph is a bare `//`. */
function comment(paragraphs: string[], indent: string): string[] {
  const out: string[] = [];
  const room = WIDTH - indent.length - 3;
  for (const p of paragraphs) {
    if (p === "") {
      out.push(`${indent}//`);
      continue;
    }
    let line = "";
    for (const word of p.split(/\s+/).filter((w) => w !== "")) {
      if (line !== "" && line.length + 1 + word.length > room) {
        out.push(`${indent}// ${line}`);
        line = word;
      } else line = line === "" ? word : `${line} ${word}`;
    }
    if (line !== "") out.push(`${indent}// ${line}`);
  }
  return out;
}

/** Paragraphs with an empty one between each two. */
const spaced = (ps: string[]): string[] => ps.flatMap((p, i) => (i === 0 ? [p] : ["", p]));

function renderEnum(e: ProtoEnum, title: string | null, description: string | null): string[] {
  const head = [title, description !== title ? description : null].filter((x): x is string => x !== null && x !== "");
  const notes = e.extensions.map((x) => `Not a value: ${x.title}, ${x.allows}${x.description ? `: ${x.description}` : "."} A proto3 enum is open, so a field of this enum keeps such a number, within int32.`);
  // The source stays on one line, however long, so a reader can copy it.
  const lines = [...comment(spaced([...head, ...notes]), ""), "//", `// From ${e.source}`];
  lines.push(`enum ${e.name} {`);
  for (const v of e.values) {
    const text = v.title === "" ? ["Not a code: proto3's zero value, which an unset field holds."] : spaced([v.title, ...(v.description && v.description !== v.title ? [v.description] : [])]);
    lines.push(...comment(text, "  "), `  ${v.name} = ${v.number};`);
  }
  lines.push("}");
  return lines;
}

function renderFile(doc: SchemaDoc, enums: { e: ProtoEnum; title: string | null; description: string | null }[], settings: ProtoSettings): string {
  const docTitle = typeof doc.schema.title === "string" ? doc.schema.title : null;
  const docDescription = typeof doc.schema.description === "string" ? doc.schema.description : null;
  // The schema's $id stays on one line, however long, so a reader can copy it.
  const lines = [
    ...comment(["Generated by `npm run proto` from this published JSON Schema; don't edit it by hand:"], ""),
    `// ${doc.id}`,
    "//",
    ...comment(
      spaced([
        ...(docDescription ? [docDescription] : docTitle ? [docTitle] : []),
        "Each enum is an integer-coded vocabulary of the schema's $defs, under its name there, and each value one of its codes, numbered as the code and named the enum's name, then the code's title, in UPPER_SNAKE. Zero is the vocabulary's own code 0, or else <ENUM>_UNSPECIFIED, which is no code.",
      ]),
      "",
    ),
  ];
  lines.push("", 'syntax = "proto3";', "", `package ${settings.package};`);
  for (const x of enums) lines.push("", ...renderEnum(x.e, x.title, x.description));
  return `${lines.join("\n")}\n`;
}

/**
 * The proto files of a published schema tree's documents, with every enum
 * they define. A problem stops the file it is in; a name that two enums or
 * two values of the package share is a problem too, since proto scopes a
 * value's name in its enum's package.
 */
export function emitProto(docs: readonly SchemaDoc[], settings: ProtoSettings): ProtoOutput {
  const problems: string[] = [];
  const files: ProtoOutput["files"] = [];
  const enums: ProtoEnum[] = [];
  if (!PACKAGE.test(settings.package)) return { files, enums, problems: [`the package "${settings.package}" isn't lowercase dotted words ending in a version, as acme.lists.v1`] };
  const dir = settings.package.split(".").join("/");
  const fileOf = new Map<string, string>();
  const owner = new Map<string, string>();
  for (const doc of [...docs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const defs = isObject(doc.schema.$defs) ? doc.schema.$defs : {};
    const names = Object.keys(defs).filter((n) => isIntegerCoded(defs[n])).sort();
    if (names.length === 0) continue;
    // A file's name is lower_snake_case, as the proto style guide asks.
    const file = posix.join(dir, `${posix.basename(doc.path, ".json").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase()}.proto`);
    if (fileOf.has(file)) {
      problems.push(`${doc.path} and ${fileOf.get(file)} would both be written to ${file}`);
      continue;
    }
    fileOf.set(file, doc.path);
    const read: { e: ProtoEnum; title: string | null; description: string | null }[] = [];
    let failed = false;
    for (const n of names) {
      const s = defs[n] as Record<string, unknown> & { oneOf: unknown[] };
      if (!/^[A-Z][A-Za-z0-9]*$/.test(n)) {
        problems.push(`${doc.id}#/$defs/${n}: isn't a PascalCase name, which an enum's name is`);
        failed = true;
        continue;
      }
      const { e, problems: p } = readVocabulary(n, s, `${doc.id}#/$defs/${n}`, file);
      problems.push(...p);
      if (!e) {
        failed = true;
        continue;
      }
      // Proto scopes an enum's name and its values' names in the package.
      for (const name of [e.name, ...e.values.map((v) => v.name)]) {
        const other = owner.get(name);
        if (other !== undefined) {
          problems.push(`${e.source}: names ${name}, which ${other} names too, in the package ${settings.package}`);
          failed = true;
        } else owner.set(name, e.source);
      }
      read.push({ e, title: typeof s.title === "string" ? s.title : null, description: typeof s.description === "string" ? s.description : null });
    }
    if (failed) continue;
    enums.push(...read.map((x) => x.e));
    files.push({ path: file, text: renderFile(doc, read, settings) });
  }
  return { files, enums, problems };
}
