/**
 * The builds a generating CLI writes: each lock's model, in the schemas we
 * propose and in each variant under `variants/` (src/variant.ts).
 *
 * Without `--lock`, every lock; without `--variant`, the proposed build and
 * every variant's, unless `--out` is given, which writes one build: the
 * proposed one, or the variant `--variant` names. `--variant proposed`
 * names the proposed build.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadConstructors, type Constructors } from "./constructors.ts";
import type { SpecIR } from "./ir-types.ts";
import { loadKernel, type Kernel } from "./kernel.ts";
import { loadLock, type SpecLock } from "./lock.ts";
import { loadDecisions, loadMappings, type DecisionRecord, type MappingFile } from "./mapping.ts";
import { resolveModel, type ModelDoc } from "./model.ts";
import type { VectorFile } from "./rules.ts";
import { applyVariant, loadVariant, VARIANTS_DIR, variantDir, type Variant } from "./variant.ts";

export const PROPOSED = "proposed";

/** The names of the variants under `variants/`, sorted. */
export function variantNames(root: string): string[] {
  return readdirSync(join(root, VARIANTS_DIR))
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.slice(0, -".yaml".length))
    .sort();
}

/** Every lock under `spec-input/`, the default lock first. */
export function allLocks(root: string): SpecLock[] {
  return readdirSync(join(root, "spec-input"))
    .filter((f) => f === "spec-lock.yaml" || f.endsWith(".lock.yaml"))
    .sort()
    .map((f) => loadLock(join(root, "spec-input", f)));
}

export interface Build {
  lock: SpecLock;
  /** The variant's name; undefined for the schemas we propose. */
  variant?: string;
  /** The lock's name, and the variant's in brackets, for a CLI's line. */
  label: string;
  irDir: string;
  ir: SpecIR;
  model: ModelDoc;
  /** Problems resolving the build, the variant's included; a build with any isn't written. */
  problems: string[];
  /** The kernel the model resolved from: the variant's, with its primitives. */
  kernel: Kernel;
  constructors: Constructors;
  mappings: MappingFile[];
  decisions: DecisionRecord[];
  /** A build's output directory, from the proposed one, such as `schemas` or `schemas/as-written`. */
  dirOf: (dir: string) => string;
  /** The rule vectors, converted to the variant's forms. */
  vectors: (vectors: VectorFile[]) => { vectors: VectorFile[]; problems: string[] };
}

/** Resolves one lock's build, in the schemas we propose or in a variant. */
export function resolveBuild(input: { lock: SpecLock; root: string; mappings: MappingFile[]; decisions: DecisionRecord[]; kernel: Kernel; constructors: Constructors; variant?: Variant; ir?: SpecIR }): Build {
  const { lock, root, decisions } = input;
  const ir = input.ir ?? (JSON.parse(readFileSync(join(root, lock.ir_dir, "spec-ir.json"), "utf8")) as SpecIR);
  const irDir = relative(root, join(root, lock.ir_dir));
  const label = input.variant ? `${lock.name} (${input.variant.name})` : lock.name;
  if (!input.variant) {
    const { model, problems } = resolveModel({ ir, lock: lock.name, mappings: input.mappings, decisions, kernel: input.kernel, constructors: input.constructors });
    return { lock, label, irDir, ir, model, problems, kernel: input.kernel, constructors: input.constructors, mappings: input.mappings, decisions, dirOf: (d) => d, vectors: (vectors) => ({ vectors, problems: [] }) };
  }
  const v = applyVariant(input.variant, { kernel: input.kernel, constructors: input.constructors, mappings: input.mappings }, lock.name);
  const resolved = resolveModel({ ir, lock: lock.name, mappings: v.mappings, decisions, kernel: v.kernel, constructors: v.constructors, withhold: v.withhold });
  const name = input.variant.name;
  const model: ModelDoc = { ...resolved.model, input: { ...resolved.model.input, variant: name } };
  const problems = resolved.problems;
  return {
    lock,
    variant: name,
    label,
    irDir,
    ir,
    model,
    problems: [...v.problems, ...problems],
    kernel: v.kernel,
    constructors: v.constructors,
    mappings: v.mappings,
    decisions,
    dirOf: (d) => variantDir(d, name),
    vectors: (vectors) => v.convert(vectors, model),
  };
}

/** The builds a CLI's `--lock`, `--variant`, and `--out` select. Throws on `--out` without `--lock`, and on an unknown variant. */
export function cliBuilds(root: string, values: { lock?: string; out?: string; variant?: string }): Build[] {
  if (values.out !== undefined && values.lock === undefined) throw new Error("--out needs --lock");
  const locks = values.lock !== undefined ? [loadLock(resolve(values.lock))] : allLocks(root);
  const names = variantNames(root);
  if (values.variant !== undefined && values.variant !== PROPOSED && !names.includes(values.variant)) throw new Error(`--variant names "${values.variant}", which is neither "${PROPOSED}" nor one of ${names.join(", ")}`);
  const chosen = values.variant !== undefined ? [values.variant] : values.out !== undefined ? [PROPOSED] : [PROPOSED, ...names];
  const mappings = loadMappings(root, join(root, "mapping"));
  const decisions = loadDecisions(root, join(root, "decisions"));
  const kernel = loadKernel(root);
  const constructors = loadConstructors(root);
  const variants = new Map(chosen.filter((n) => n !== PROPOSED).map((n) => [n, loadVariant(root, n)]));
  return locks.flatMap((lock) => chosen.map((n) => resolveBuild({ lock, root, mappings, decisions, kernel, constructors, ...(n === PROPOSED ? {} : { variant: variants.get(n)! }) })));
}

/** The `--lock`, `--out`, and `--variant` options every generating CLI takes. */
export const BUILD_OPTIONS = { lock: { type: "string" }, out: { type: "string" }, variant: { type: "string" } } as const;
