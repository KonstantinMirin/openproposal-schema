import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { installFormats } from "./formats.ts";
import type { NamedStructure } from "./duplication.ts";
import { indexElements } from "./elements.ts";
import type { SpecIR } from "./ir-types.ts";
import { checkCovers, readYaml, type Cover, type DecisionRecord, type MappingFile } from "./mapping.ts";
import { compileSchema } from "./pipeline.ts";
import { loadDomains, type Domains } from "./domains.ts";
import { checkListCopies } from "./list-copies.ts";
import { loadLists, type Lists } from "./lists.ts";
import { CHECKS, codesOf } from "./rule-checks.ts";

/** The constraint keywords a primitive may carry, as `kernel/kernel.schema.json` defines them. */
export interface Constraints {
  pattern?: string;
  format?: "date" | "date-time" | "duration" | "uri" | "uuid";
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  enum?: string[];
}

export interface KernelRule {
  id: string;
  statement: string;
  /** Where the rule comes from (type rules § 9): spec elements, a standard, or a decision record. */
  source: { spec?: Cover[]; standard?: { name: string; url: string }; decision?: string; decision_locks?: string[] };
  valid: unknown[];
  invalid: unknown[];
}

export interface Primitive {
  name: string;
  description: string;
  type: "string" | "number" | "integer";
  /** The concept of `kernel/domains.yaml` the primitive represents. */
  concept: string;
  /** The locks the primitive is published on; every lock when absent. */
  locks?: string[];
  constraints: Constraints;
  decision?: string;
  /** The locks `decision` applies on; without it, every lock. */
  decision_locks?: string[];
  sources: {
    spec?: Cover[];
    standards?: { name: string; url: string }[];
    design?: DesignSource[];
  };
  vectors: { valid: unknown[]; invalid: unknown[] };
  /** The value a reader's example payload shows where the specification's examples give none, and a second for a list's second item (src/type-examples.ts). */
  showcase: unknown[];
  rules?: KernelRule[];
}

export interface Kernel {
  format: 1;
  primitives: Primitive[];
  /** The file the primitives came from, for messages. */
  file: string;
  /** The value domains, `kernel/domains.yaml`, which every primitive and part declares a concept of. */
  domains?: Domains;
  /** The code lists other standards keep, `kernel/lists.yaml`, which a vocabulary may take its terms from. */
  lists?: Lists;
}

export const KERNEL_FILE = join("kernel", "primitives.yaml");
const KERNEL_SCHEMA = join("kernel", "kernel.schema.json");

/**
 * Loads `kernel/primitives.yaml` from `root` and validates it against the
 * kernel schema, with the value domains of `kernel/domains.yaml` beside it.
 * Throws if either is invalid.
 */
export function loadKernel(root: string, file = join(root, KERNEL_FILE)): Kernel {
  const doc = readYaml(file);
  const errors = compileSchema(join(root, KERNEL_SCHEMA))(doc);
  if (errors.length > 0) throw new Error(`${file}: not a valid kernel file: ${errors.join("; ")}`);
  return { ...(doc as Omit<Kernel, "file" | "domains" | "lists">), file, domains: loadDomains(root), lists: loadLists(root) };
}

/** Whether a primitive is published on a lock: every lock, unless it lists `locks`. */
export const publishedOn = (p: { locks?: string[] }, lock: string) => p.locks === undefined || p.locks.includes(lock);

/** The kernel as one lock publishes it: the primitives in scope on the lock. */
export function kernelOn(kernel: Kernel, lock: string): Kernel {
  return { ...kernel, primitives: kernel.primitives.filter((p) => publishedOn(p, lock)) };
}

/** The structure a primitive is emitted as: its JSON type plus its constraint set. The duplication gate compares it. */
export function primitiveStructure(p: Primitive): Record<string, unknown> {
  return { type: p.type, ...p.constraints };
}

/** A primitive as a standalone JSON Schema 2020-12 resource, with its description. */
export function primitiveSchema(p: Primitive): Record<string, unknown> {
  return { $schema: "https://json-schema.org/draft/2020-12/schema", description: p.description, ...primitiveStructure(p) };
}

/**
 * A 2020-12 validator in strict mode that asserts `format`, so a vector's
 * verdict doesn't depend on a validator's default for format annotations.
 */
export function assertingAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  installFormats(ajv);
  return ajv;
}

/**
 * A vector of a primitive, with the verdict a conforming 2020-12 validator
 * gives it. A mutant is a valid vector with a trailing newline appended: a
 * standard grammar or an ECMA-262 `$` rejects it, but Python's `$` also
 * matches before a final newline.
 */
export interface VectorCase {
  value: unknown;
  valid: boolean;
  mutant: boolean;
  /** The rule whose vector this is; the schema accepts every rule vector. */
  rule?: string;
}

/** Whether a primitive restricts how a value is spelled, so a trailing newline makes a valid value invalid. */
const restrictsSpelling = (p: Primitive) => p.type === "string" && (p.constraints.pattern ?? p.constraints.format ?? p.constraints.enum) !== undefined;

/**
 * A primitive's vectors as the conformance suite publishes them: the stated
 * valid and invalid vectors, the vectors of its rules (which the schema
 * accepts), and a trailing-newline mutant of each valid string vector of a
 * primitive that restricts spelling.
 */
export function vectorCases(p: Primitive): VectorCase[] {
  const cases: VectorCase[] = [
    ...p.vectors.valid.map((value) => ({ value, valid: true, mutant: false })),
    ...p.vectors.invalid.map((value) => ({ value, valid: false, mutant: false })),
    ...(p.rules ?? []).flatMap((r) => [...r.valid, ...r.invalid].map((value) => ({ value, valid: true, mutant: false, rule: r.id }))),
  ];
  if (restrictsSpelling(p)) {
    const stated = new Set(cases.map((c) => JSON.stringify(c.value)));
    for (const v of p.vectors.valid) {
      if (typeof v === "string" && !stated.has(JSON.stringify(`${v}\n`))) cases.push({ value: `${v}\n`, valid: false, mutant: true });
    }
  }
  return cases;
}

/** Escapes and groups that ECMA-262, RE2, and Python `re` read differently, or that RE2 rejects. */
const NONPORTABLE: [RegExp, string][] = [
  [/\(\?[=!]/, "lookahead"],
  [/\(\?<[=!]/, "lookbehind"],
  [/\(\?(P?<|')/, "a named group"],
  [/\(\?[a-zA-Z]/, "an inline flag"],
];
const NONPORTABLE_ESCAPES: Record<string, string> = {
  d: "\\d (Unicode digits in Python)",
  D: "\\D",
  w: "\\w (Unicode word characters in Python)",
  W: "\\W",
  s: "\\s (different whitespace sets)",
  S: "\\S",
  b: "\\b",
  B: "\\B",
  p: "\\p{…}",
  P: "\\P{…}",
  k: "a named backreference",
};

/** Returns why a pattern isn't portable, or nothing. */
export function patternPortability(pattern: string): string[] {
  const problems: string[] = [];
  try {
    new RegExp(pattern, "u");
  } catch (e) {
    return [`doesn't compile: ${(e as Error).message}`];
  }
  for (const [re, what] of NONPORTABLE) if (re.test(pattern)) problems.push(`uses ${what}`);
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "\\") continue;
    const next = pattern[i + 1] ?? "";
    if (next in NONPORTABLE_ESCAPES) problems.push(`uses ${NONPORTABLE_ESCAPES[next]}`);
    else if (/[1-9]/.test(next)) problems.push("uses a backreference");
    i++;
  }
  return problems;
}

/** A Markdown file's headings, without their `#` marks. */
function headings(file: string): Set<string> {
  return new Set(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => /^#{1,6} /.test(l))
      .map((l) => l.replace(/^#{1,6} /, "").trim()),
  );
}

/** A design document section that a model source cites. */
export interface DesignSource {
  doc: string;
  section: string;
}

/**
 * Returns a check that each design source names an existing heading of an
 * existing document under `root`. Each failure is pushed to `problems`; the
 * documents are read once.
 */
export function designCheck(root: string, problems: string[]): (where: string, sources: DesignSource[]) => void {
  const docs = new Map<string, Set<string>>();
  return (where, sources) => {
    for (const d of sources) {
      const path = join(root, d.doc);
      if (!existsSync(path)) {
        problems.push(`${where}: design source "${d.doc}" doesn't exist`);
        continue;
      }
      if (!docs.has(path)) docs.set(path, headings(path));
      if (!docs.get(path)!.has(d.section)) problems.push(`${where}: "${d.doc}" has no heading "${d.section}"`);
    }
  };
}

/** Returns a check that a cited decision exists and isn't superseded. Each failure is pushed to `problems`. */
export function decisionCheck(decisions: DecisionRecord[], problems: string[]): (where: string, id: string) => void {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  return (where, id) => {
    const d = byId.get(id);
    if (!d) problems.push(`${where}: cites decision "${id}", which doesn't exist`);
    else if (d.status === "superseded") problems.push(`${where}: cites "${d.id}", which is superseded by "${d.superseded_by}"`);
  };
}

/** The named types the kernel defines, for the duplication gate, each with the concept that tells it from a structural twin. */
export function kernelStructures(kernel: Kernel): NamedStructure[] {
  return kernel.primitives.map((p) => ({ name: p.name, structure: primitiveStructure(p), concept: p.concept, where: kernel.file }));
}

/**
 * The lock-independent kernel checks. Returns the problems; empty means the
 * kernel is sound:
 *
 * - no pattern uses a construct that ECMA-262, RE2, and Python `re` read
 *   differently (a static lint; `checkKernelEngines` runs the patterns);
 * - every vector, including the trailing-newline mutants, gets its verdict
 *   from Ajv as an asserting 2020-12 validator;
 * - every showcase value is valid as a valid vector is, and no rule of the
 *   primitive whose check reads one value rejects it;
 * - every rule's ID names its own primitive and is unique, and the schema
 *   accepts all of a rule's vectors, so the rule adds what the schema can't;
 * - each design source names an existing heading of an existing document;
 * - a decision cited by a primitive or a rule exists and isn't superseded.
 *
 * The duplication gate runs separately, on `kernelStructures`.
 */
export function checkKernel(root: string, kernel: Kernel, decisions: DecisionRecord[]): string[] {
  const problems: string[] = [];
  const ajv = assertingAjv();
  const rules = new Set<string>();
  const citesDecision = decisionCheck(decisions, problems);
  const design = designCheck(root, problems);
  const codes = codesOf(kernel.lists ?? { lists: [] });

  for (const p of kernel.primitives) {
    const where = `${kernel.file}: ${p.name}`;
    if (p.constraints.pattern !== undefined) {
      for (const why of patternPortability(p.constraints.pattern)) problems.push(`${where}: the pattern ${why}`);
    }
    let validate;
    try {
      validate = ajv.compile(primitiveStructure(p));
    } catch (e) {
      problems.push(`${where}: the constraint set doesn't compile: ${(e as Error).message}`);
      continue;
    }
    const verdict = (v: unknown, expected: boolean, what: string) => {
      if (validate(v) !== expected) problems.push(`${where}: ${what} ${JSON.stringify(v)} is ${expected ? "rejected" : "accepted"} by the constraint set`);
    };
    for (const v of p.vectors.valid) verdict(v, true, "valid vector");
    for (const v of p.vectors.invalid) verdict(v, false, "invalid vector");
    for (const c of vectorCases(p)) if (c.mutant) verdict(c.value, false, "trailing-newline mutant");
    for (const v of p.showcase) {
      verdict(v, true, "showcase value");
      for (const r of p.rules ?? []) {
        const found = CHECKS[r.id]?.(v, { context: {}, part: false, codes });
        if (found === null) problems.push(`${where}: rule "${r.id}" can't decide the showcase value ${JSON.stringify(v)}`);
        else if (found !== undefined && found.length > 0) problems.push(`${where}: showcase value ${JSON.stringify(v)} breaks rule "${r.id}": ${found[0]!.message}`);
      }
    }

    for (const r of p.rules ?? []) {
      if (rules.has(r.id)) problems.push(`${where}: rule "${r.id}" is defined twice`);
      rules.add(r.id);
      if (r.id.split(":")[1] !== p.name) problems.push(`${where}: rule "${r.id}" must be named kernel:${p.name}:<token>, after the primitive that owns it`);
      for (const v of [...r.valid, ...r.invalid]) verdict(v, true, `rule "${r.id}" vector`);
      if (r.source.decision !== undefined) citesDecision(`${where}: rule "${r.id}"`, r.source.decision);
    }

    design(where, p.sources.design ?? []);

    if (p.decision !== undefined) citesDecision(where, p.decision);
  }

  if (kernel.lists !== undefined) problems.push(...checkListCopies(root, kernel.lists));
  return problems;
}

/**
 * Checks the kernel's spec sources, a primitive's and a rule's, against one
 * lock's IR: each in-scope source names an element, with its current digest
 * and quote. A changed row makes the primitive or rule that rests on it stale.
 */
export function checkKernelSources(ir: SpecIR, lock: string, kernel: Kernel): string[] {
  const problems: string[] = [];
  const elements = indexElements(ir);
  for (const p of kernel.primitives) {
    checkCovers(`${kernel.file}: ${p.name}`, p.sources.spec ?? [], elements, lock, problems);
    for (const r of p.rules ?? []) checkCovers(`${kernel.file}: ${p.name}: rule "${r.id}"`, r.source.spec ?? [], elements, lock, problems);
  }
  return problems;
}

/** A primitive is defined only in the kernel: a mapping entry that defines a type with a primitive's name fails. */
export function checkKernelNames(kernel: Kernel, mappings: MappingFile[]): string[] {
  const names = new Set(kernel.primitives.map((p) => p.name));
  const problems: string[] = [];
  for (const m of mappings) {
    for (const e of m.entries) {
      if (e.as.role === "type" && names.has(e.as.name)) {
        problems.push(`${m.file}: entry "${e.ir}" defines "${e.as.name}", which is a kernel primitive; map it to the primitive instead`);
      }
    }
  }
  return problems;
}
