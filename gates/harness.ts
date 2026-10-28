/**
 * The gate harness: how `npm run ci` runs a gate, and how it proves that the
 * gate can fail.
 *
 * A gate is a named check with a title, a check function over one input, and
 * its known-bad fixtures. `npm run ci` collects each gate's input from the
 * real pipeline and runs the check, once per lock where the gate is per lock.
 * It keeps the first input of each gate, and after the last gate it runs the
 * gate's check again on every fixture: a mutation of that real input, such
 * as the model with a currency deleted, which must fail the gate with the
 * message the fixture expects. A gate without a fixture fails the meta-check.
 *
 * A gate's code is its definition here, under `gates/`, and the functions its
 * `code` names in `src/`, each with every declaration it reaches, in its own
 * file and, through the imports of repository modules, in any other. Its
 * fingerprint digests that code, its fixtures, the data files its fixtures
 * read, the exemption files it reads, and the whole files and directories it
 * names, such as the TypeScript configuration or the test tree. The guard gate
 * (gates/guard.ts) fails when a fingerprint isn't the one the latest gate
 * decision that names the gate accepts, so a gate can't be relaxed in the
 * change that needs it relaxed to pass.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";
import { parse } from "yaml";
import { canonicalJson } from "../src/canonical.ts";

export interface Result {
  problems: string[];
  /** What the gate checked, for its line in the report when it passes. */
  note?: string;
}

/** A known-bad input: the real input changed so that the gate must fail, with a message that contains `expect` or matches it. */
export interface Fixture<I> {
  name: string;
  /** The spec whose input the fixture changes, by its folder's name; OpenProposal's, which the fixtures were first written for, when absent, or the first spec's that ran the gate when OpenProposal's didn't. */
  spec?: string;
  /** The lock whose input the fixture changes; the spec's first lock's when absent. */
  lock?: string;
  mutate: (input: I) => I | Promise<I>;
  expect: string | RegExp;
}

export interface Gate<I> {
  /** Stable, kebab-case: the gate's directory of data under `gates/data/`, and its name in a gate decision. */
  id: string;
  /** The gate's line in the report; `npm run ci` prefixes it with the lock's name for a per-lock gate. */
  title: string | ((input: I) => string);
  /** The functions outside `gates/` that hold the gate's logic, as `src/coverage.ts#checkCoverage`. */
  code?: string[];
  /**
   * The exemptions the gate reads, whose entries let a case pass: a file, or
   * `<file>#<property>` for the values of every member of that name in a
   * YAML file, as `kernel/domains.yaml#shared_structures`. A path may hold
   * `*` segments, which match every spec's file, as
   * `specs/*\/decisions/*.yaml#sets_aside`; one that matches nothing fails.
   */
  exemptions?: string[];
  /** Whole files, and directories as `<dir>/`, that are part of the gate's code, such as the CI script for the guard or the test tree for the test suite. */
  files?: string[];
  check: (input: I) => Result | Promise<Result>;
  fixtures: Fixture<I>[];
}

export const defineGate = <I>(g: Gate<I>): Gate<I> => g;

/** The repository's root. */
export const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** The problems of a check, with an exception thrown by it as one problem. */
export async function runCheck<I>(gate: Gate<I>, input: I): Promise<Result> {
  try {
    return await gate.check(input);
  } catch (e) {
    return { problems: [(e as Error).message] };
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;

/**
 * A deep copy of an input for a fixture to change: plain objects, arrays,
 * maps, sets, and buffers are copied; anything else, such as a function or a
 * validator, is shared.
 */
export function cloneInput<T>(v: T): T {
  if (Buffer.isBuffer(v)) return Buffer.from(v) as T;
  if (Array.isArray(v)) return v.map(cloneInput) as T;
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, cloneInput(x)])) as T;
  if (v instanceof Set) return new Set([...v].map(cloneInput)) as T;
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cloneInput(x)])) as T;
  return v;
}

export const matches = (problems: string[], expect: string | RegExp) => problems.some((p) => (typeof expect === "string" ? p.includes(expect) : expect.test(p)));

/** One fixture's run: whether the gate failed, and whether a problem carried the expected message. */
export interface FixtureRun {
  gate: string;
  fixture: string;
  failed: boolean;
  matched: boolean;
  problems: string[];
}

export async function runFixture<I>(gate: Gate<I>, input: I, f: Fixture<I>): Promise<FixtureRun> {
  let mutated: I;
  try {
    mutated = await f.mutate(cloneInput(input));
  } catch (e) {
    return { gate: gate.id, fixture: f.name, failed: false, matched: false, problems: [`the fixture threw: ${(e as Error).message}`] };
  }
  const r = await runCheck(gate, mutated);
  return { gate: gate.id, fixture: f.name, failed: r.problems.length > 0, matched: matches(r.problems, f.expect), problems: r.problems };
}

// Fingerprints ---------------------------------------------------------------

/** Where a fingerprint reads the repository's files: the disk, or the disk with some files changed or removed, for a guard fixture. */
export interface Source {
  /** The bytes of a file, by path from the root; throws when it is missing. */
  read(path: string): Buffer;
  exists(path: string): boolean;
  /** Every file under a directory, by path from the root, sorted; none for a missing directory. */
  list(dir: string): string[];
}

export const disk: Source = {
  read: (path) => readFileSync(join(ROOT, path)),
  exists: (path) => existsSync(join(ROOT, path)),
  list: (dir) => {
    if (!existsSync(join(ROOT, dir))) return [];
    const out: string[] = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
        const p = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else out.push(p);
      }
    };
    walk(dir.replace(/\/$/, ""));
    return out.sort();
  },
};

/** The disk with each named file's text changed by its function, or removed where it maps to null. */
export function overlay(changes: Record<string, ((text: string) => string) | null>, base: Source = disk): Source {
  const changed = (path: string) => Object.prototype.hasOwnProperty.call(changes, path);
  return {
    read: (path) => {
      if (!changed(path)) return base.read(path);
      const f = changes[path];
      if (f === null || f === undefined) throw new Error(`${path}: no such file`);
      return Buffer.from(f(base.read(path).toString("utf8")));
    },
    exists: (path) => (changed(path) ? changes[path] !== null : base.exists(path)),
    list: (dir) => base.list(dir).filter((p) => !changed(p) || changes[p] !== null),
  };
}

interface Parsed {
  source: ts.SourceFile;
  /** The top-level declarations, by the names they declare. */
  declared: Map<string, ts.Statement>;
  /** Each local name an import binds to a repository module: the module's path, and the name it exports or `*` for the namespace. */
  imports: Map<string, { file: string; name: string }>;
  /** Each name the file re-exports from a repository module. */
  reexports: Map<string, { file: string; name: string }>;
}

const parsedBy = new WeakMap<Source, Map<string, Parsed>>();

/** The repository file a module specifier names from `file`, or null for a package. */
function localModule(file: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return posix.normalize(posix.join(posix.dirname(file), specifier));
}

function parsed(file: string, src: Source): Parsed {
  const cache = parsedBy.get(src) ?? new Map<string, Parsed>();
  parsedBy.set(src, cache);
  const hit = cache.get(file);
  if (hit) return hit;
  const source = ts.createSourceFile(file, src.read(file).toString("utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const declared = new Map<string, ts.Statement>();
  const imports = new Map<string, { file: string; name: string }>();
  const reexports = new Map<string, { file: string; name: string }>();
  for (const s of source.statements) {
    for (const n of namesOf(s)) declared.set(n, s);
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
      const target = localModule(file, s.moduleSpecifier.text);
      const clause = s.importClause;
      if (target === null || !clause) continue;
      if (clause.name) imports.set(clause.name.text, { file: target, name: "default" });
      const b = clause.namedBindings;
      if (b && ts.isNamespaceImport(b)) imports.set(b.name.text, { file: target, name: "*" });
      if (b && ts.isNamedImports(b)) for (const e of b.elements) imports.set(e.name.text, { file: target, name: (e.propertyName ?? e.name).text });
    }
    if (ts.isExportDeclaration(s) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) {
      const target = localModule(file, s.moduleSpecifier.text);
      if (target !== null && s.exportClause && ts.isNamedExports(s.exportClause)) for (const e of s.exportClause.elements) reexports.set(e.name.text, { file: target, name: (e.propertyName ?? e.name).text });
    }
  }
  const p = { source, declared, imports, reexports };
  cache.set(file, p);
  return p;
}

/**
 * The text of a top-level declaration and of every declaration it reaches:
 * the top-level declarations of its own file it names, and, through each
 * import of a repository module, the declarations it names there, to any
 * depth. A namespace import reaches the member each use names, or the whole
 * module where a use names none; a module that isn't TypeScript, such as a
 * JSON file, is reached whole. Each file's part comes in file order, the
 * files in path order, so the text changes when any code the declaration
 * runs changes, in any file, and not when unrelated code does.
 */
export function declarationText(file: string, name: string, src: Source = disk): string {
  const reached = new Map<string, Set<ts.Statement>>();
  const whole = new Set<string>();
  const visitName = (f: string, n: string, seen: Set<string>): void => {
    const key = `${f}#${n}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!f.endsWith(".ts")) {
      if (src.exists(f)) whole.add(f);
      return;
    }
    const p = parsed(f, src);
    if (n === "*" || n === "default") {
      whole.add(f);
      return;
    }
    const s = p.declared.get(n);
    if (s) return visitStatement(f, s, seen);
    const re = p.reexports.get(n);
    if (re) return visitName(re.file, re.name, seen);
    throw new Error(`${f} declares no "${n}"`);
  };
  const visitStatement = (f: string, s: ts.Statement, seen: Set<string>): void => {
    const set = reached.get(f) ?? new Set<ts.Statement>();
    reached.set(f, set);
    if (set.has(s)) return;
    set.add(s);
    const p = parsed(f, src);
    const walk = (node: ts.Node) => {
      if (ts.isIdentifier(node)) {
        const d = p.declared.get(node.text);
        const imp = p.imports.get(node.text);
        if (d && d !== s) visitStatement(f, d, seen);
        else if (!d && imp) {
          const parent = node.parent;
          const member = imp.name === "*" && parent && ts.isPropertyAccessExpression(parent) && parent.expression === node ? parent.name.text : imp.name;
          visitName(imp.file, member, seen);
        }
      }
      node.forEachChild(walk);
    };
    s.forEachChild(walk);
  };
  visitName(file, name, new Set());
  const files = [...new Set([...reached.keys(), ...whole])].sort();
  return files
    .map((f) => {
      if (whole.has(f)) return `// ${f}\n${src.read(f).toString("utf8")}`;
      const p = parsed(f, src);
      const set = reached.get(f)!;
      return `// ${f}\n${p.source.statements.filter((s) => set.has(s)).map((s) => s.getText(p.source)).join("\n")}`;
    })
    .join("\n");
}

function namesOf(s: ts.Statement): string[] {
  if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isEnumDeclaration(s)) && s.name) return [s.name.text];
  if (ts.isVariableStatement(s)) return s.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []));
  return [];
}

/**
 * The files a path names: the file itself, or, where a segment holds `*`,
 * every file whose path matches it, a `*` standing for any run of characters
 * within one segment, as `specs/*\/decisions/*.yaml`. Sorted. A pattern that
 * matches no file throws, so an exemption file that moves can't leave the
 * fingerprint silently.
 */
export function filesMatching(path: string, src: Source): string[] {
  const segments = path.split("/");
  const first = segments.findIndex((s) => s.includes("*"));
  if (first === -1) return [path];
  const pattern = new RegExp(`^${segments.map((s) => s.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join("/")}$`);
  const matched = src
    .list(segments.slice(0, first).join("/"))
    .filter((f) => pattern.test(f))
    .sort();
  if (matched.length === 0) throw new Error(`${path} matches no file`);
  return matched;
}

/** The bytes an exemption names: a whole file, or the canonical JSON of every value of one member name in YAML files; the path may hold `*` segments (`filesMatching`). */
function exemptionBytes(spec: string, src: Source): Buffer {
  const [path, property] = spec.split("#") as [string, string?];
  const files = filesMatching(path, src);
  if (property === undefined) return Buffer.concat(files.map((f) => src.read(f)));
  const values: unknown[] = [];
  const collect = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) k === property ? values.push(x) : collect(x);
  };
  for (const f of files) collect(parse(src.read(f).toString("utf8"), { version: "1.2", schema: "core" }));
  // A member that names no value would read nothing, as when the exemptions move to another file.
  if (values.length === 0) throw new Error(`${spec} names no value`);
  return Buffer.from(canonicalJson(values));
}

/**
 * A gate's fingerprint: the SHA-256 of its definition in `file` under its
 * export `name`, with every declaration it reaches in any repository file,
 * the code it names with what that reaches, its exemption files, its whole
 * files and directories, and the data files its fixtures read.
 */
export function fingerprint(gate: Gate<unknown>, file: string, name: string, src: Source = disk): string {
  const h = createHash("sha256");
  h.update(`gate ${gate.id}\n${declarationText(file, name, src)}\n`);
  for (const c of [...(gate.code ?? [])].sort()) {
    const [f, n] = c.split("#") as [string, string];
    h.update(`code ${c}\n${declarationText(f, n, src)}\n`);
  }
  for (const e of [...(gate.exemptions ?? [])].sort()) h.update(`exemptions ${e}\n`).update(exemptionBytes(e, src));
  for (const f of [...(gate.files ?? [])].sort()) {
    // A path that ends in "/" is a directory: each file under it, so a file added or deleted there changes the fingerprint.
    for (const x of f.endsWith("/") ? src.list(f) : [f]) h.update(`file ${x}\n`).update(src.read(x));
  }
  for (const d of src.list(`gates/data/${gate.id}`)) h.update(`data ${d}\n`).update(src.read(d));
  return h.digest("hex");
}
