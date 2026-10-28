/**
 * The data the site's pages read: for each lock, in the schemas we propose
 * and as written (src/variant.ts), the model's types, the emitted schemas,
 * the type examples, the rules, the value domains, every source element
 * with its label, quote, and links, and the decisions the build cites; and
 * for every decision record, what the decision pages show.
 *
 * Everything is read from the committed outputs the gates hold current, or
 * resolved in process from the committed inputs, so the site is a function
 * of the repository.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join, posix } from "node:path";
import { allLocks, resolveBuild, type Build } from "../builds.ts";
import { loadConstructors } from "../constructors.ts";
import { indexElements } from "../elements.ts";
import { schemaDirOf } from "../emit.ts";
import type { FeedbackDoc } from "../feedback.ts";
import type { SpecIR } from "../ir-types.ts";
import { loadKernel, type Kernel } from "../kernel.ts";
import type { SpecLock } from "../lock.ts";
import { inScope, loadDecisions, loadMappings, type DecisionRecord, type MappingFile } from "../mapping.ts";
import type { ModelDoc, ModelType } from "../model.ts";
import { loadProvenance, type ProvenanceDoc } from "../provenance.ts";
import { RULES_FILE, rulesDirOf, type RulesDoc } from "../rules.ts";
import { TYPE_EXAMPLES_FILE, typeExamplesDirOf, type TypeExamplesDoc } from "../type-examples.ts";
import { checkVariantDiff, loadVariant, type Variant, type VariantDifference } from "../variant.ts";
import type { VariantReport } from "../variant-report.ts";
import { sourceInfo, type SourceInfo } from "./sources.ts";
import { REPO_ROOT } from "../repo.ts";
import { pluginOf, specOf } from "../specs/index.ts";
import { brandOf, loadSiteConfig, type SiteBrand, type SiteConfig } from "./config.ts";

/**
 * The variants the site can switch between, by the slug its URLs use: the
 * text as written, and with our proposals. A spec with departures has both;
 * a spec with none proposes no change, so its one build is the text as
 * written, and the site shows no variant switch.
 */
export const SITE_VARIANTS = [
  { slug: "as-written", variant: "as-written", label: "As written" },
  { slug: "proposals", variant: undefined, label: "With our proposals" },
] as const;
export type VariantSlug = (typeof SITE_VARIANTS)[number]["slug"];
export type SiteVariant = (typeof SITE_VARIANTS)[number];

/** One build as the type map reads it. */
export interface BuildData {
  lock: string;
  variant: VariantSlug;
  commit: string;
  types: ModelType[];
  /** Each emitted named type's schema, with the file it is in, by its path on the site, which is its `$id`'s. */
  emitted: Record<string, { file: string; schema: unknown }>;
  examples: Record<string, { full: unknown; notes?: unknown[]; illustrative?: unknown[]; undecided?: unknown[] }>;
  rules: { id: string; owner: string; statement: string; severity: string }[];
  domains: Record<string, { domain: string; concept: string; meaning: string }>;
  sources: Record<string, SourceInfo>;
  decisions: Record<string, { kind: string; number: number | null; question: string }>;
  /** Where this lock's two builds differ, each with the departure that makes the difference. */
  differences: VariantDifference[];
  /** The types this build holds and the default lock's build of the same variant doesn't. */
  added: string[];
  /** The input's commit, its base and PR heads where it merges PRs, for the map's line about the build. */
  input: { commit: string; base: string | null; prs: { pr: number; head: string }[] };
}

export interface SiteInputs {
  /** The spec's folder, which holds its locks, records, and generated files. */
  root: string;
  /** What the pages name, from the spec's profile and the site's settings. */
  brand: SiteBrand;
  /** The spec's plugin, whose site copy writes its landing and How it's built pages. */
  plugin: string;
  /** Whether the spec has SDK types, which the files page lists as secondary. */
  sdk: boolean;
  locks: SpecLock[];
  /** The variants the spec's pages switch between: both where the spec has departures, and else the text as written alone. */
  variants: readonly SiteVariant[];
  decisions: DecisionRecord[];
  mappings: MappingFile[];
  kernel: Kernel;
  /** The as-written variant's switches; null for a spec with no departures. */
  variant: Variant | null;
  /** The implementation feedback, which numbers and groups the decisions; null for a spec with none yet. */
  feedback: FeedbackDoc | null;
  /** The as-written variant's report; null for a spec with no departures. */
  report: VariantReport | null;
  /** Each lock's IR, by lock name. */
  irs: Map<string, SpecIR>;
  provenance: Map<string, ProvenanceDoc | null>;
  /** Each lock's builds, by variant slug. */
  builds: Map<string, Map<VariantSlug, Build>>;
}

const readJson = <T>(root: string, path: string): T => JSON.parse(readFileSync(join(root, path), "utf8")) as T;
const readJsonIf = <T>(root: string, path: string): T | null => (existsSync(join(root, path)) ? readJson<T>(root, path) : null);

/** Loads everything the site reads from a spec's folder, and resolves each lock's builds: the proposed one, and the as-written one where the spec has departures. */
export function loadSiteInputs(root: string, site: SiteConfig = loadSiteConfig()): SiteInputs {
  const locks = allLocks(root);
  const mappings = loadMappings(join(root, "mapping"));
  const decisions = loadDecisions(join(root, "decisions"));
  const kernel = loadKernel(REPO_ROOT, root);
  const constructors = loadConstructors(REPO_ROOT, root);
  const variant = existsSync(join(root, "variants", "as-written.yaml")) ? loadVariant(root) : null;
  const builds = new Map<string, Map<VariantSlug, Build>>();
  const irs = new Map<string, SpecIR>();
  const provenance = new Map<string, ProvenanceDoc | null>();
  for (const lock of locks) {
    const proposed = resolveBuild({ lock, root, mappings, decisions, kernel, constructors });
    const written = variant ? resolveBuild({ lock, root, mappings, decisions, kernel, constructors, variant, ir: proposed.ir }) : proposed;
    for (const b of [proposed, written]) if (b.problems.length > 0) throw new Error(`${b.label}: the model doesn't resolve: ${b.problems[0]}`);
    builds.set(lock.name, new Map(variant ? [["proposals", proposed], ["as-written", written]] : [["as-written", proposed]]));
    irs.set(lock.name, proposed.ir);
    provenance.set(lock.name, loadProvenance(root, lock));
  }
  const spec = specOf(root);
  return {
    root,
    brand: brandOf(spec.profile, site),
    plugin: spec.plugin?.id ?? spec.profile.id,
    sdk: spec.profile.names.sdk !== undefined,
    locks,
    variants: variant ? SITE_VARIANTS : SITE_VARIANTS.filter((v) => v.slug === "as-written"),
    decisions,
    mappings,
    kernel,
    variant,
    feedback: readJsonIf<FeedbackDoc>(root, "feedback/feedback.json"),
    report: variant ? readJson<VariantReport>(root, "comparison/as-written.json") : null,
    irs,
    provenance,
    builds,
  };
}

/** Each decision's number in the feedback's supporting page, and the group it is listed in. */
export function decisionNumbers(feedback: FeedbackDoc | null): Map<string, { number: number; group: string }> {
  const out = new Map<string, { number: number; group: string }>();
  if (!feedback) return out;
  for (const g of feedback.groups) for (const d of g.decisions) out.set(d.id, { number: d.number, group: g.title });
  for (const d of feedback.departures) out.set(d.id, { number: d.number, group: "Changes we propose" });
  return out;
}

/** The source elements a model's types and properties rest on, sorted. */
function sourcesOf(model: ModelDoc): string[] {
  const ids = new Set<string>();
  for (const t of model.types) {
    for (const s of t.sources) ids.add(s);
    if ("properties" in t) for (const p of Object.values(t.properties)) for (const s of p.sources) ids.add(s);
  }
  return [...ids].sort();
}

/** One lock's source elements, each with its label, quote, and links. */
export function sourceInfos(inputs: SiteInputs, lock: SpecLock, ids: Iterable<string>): Record<string, SourceInfo> {
  const ir = inputs.irs.get(lock.name)!;
  const elements = indexElements(ir);
  const titles = new Map(ir.sections.map((s) => [s.id, s.title]));
  // A text whose sections are anchored cites each by its heading; a numbered one, by its number.
  const naming = { sections: pluginOf(lock).text.sections, titleOf: (s: string) => titles.get(s) };
  const out: Record<string, SourceInfo> = {};
  for (const id of [...ids].sort()) {
    const e = elements.get(id);
    if (e) out[id] = sourceInfo(lock, inputs.provenance.get(lock.name) ?? null, id, e, naming);
  }
  return out;
}

/** What the type map reads of one build. */
export function buildData(inputs: SiteInputs, lock: SpecLock, slug: VariantSlug): BuildData {
  const b = inputs.builds.get(lock.name)!.get(slug)!;
  const { root } = inputs;
  const schemaDir = b.dirOf(schemaDirOf(lock.ir_dir));
  const emitted: BuildData["emitted"] = {};
  for (const path of schemaFilesOf(root, schemaDir)) {
    const schema = readJson<Record<string, unknown>>(root, posix.join(schemaDir, path));
    const file = posix.join(schemaDir, path);
    const defs = (schema.$defs ?? {}) as Record<string, unknown>;
    for (const [name, s] of Object.entries(defs)) emitted[name] = { file, schema: s };
    if (path.startsWith("documents/") && typeof schema.title === "string") {
      const { $defs: _, ...rest } = schema;
      emitted[schema.title] = { file, schema: rest };
    }
  }
  const te = readJson<TypeExamplesDoc>(root, posix.join(b.dirOf(typeExamplesDirOf(lock.ir_dir)), TYPE_EXAMPLES_FILE));
  const examples: BuildData["examples"] = {};
  for (const [name, x] of Object.entries(te.types)) {
    const e = x as { full: unknown; notes?: unknown[]; illustrative?: unknown[]; undecided?: unknown[] };
    examples[name] = { full: e.full, ...(e.notes ? { notes: e.notes } : {}), ...(e.illustrative ? { illustrative: e.illustrative } : {}), ...(e.undecided ? { undecided: e.undecided } : {}) };
  }
  const rulesDoc = readJson<RulesDoc>(root, posix.join(b.dirOf(rulesDirOf(lock.ir_dir)), RULES_FILE));
  const rules = rulesDoc.rules.map((r) => ({ id: r.id, owner: r.owner, statement: r.statement, severity: r.severity }));
  const numbers = decisionNumbers(inputs.feedback);
  const cited = new Set(b.model.types.flatMap((t) => t.decisions));
  const decisions: BuildData["decisions"] = {};
  for (const d of inputs.decisions) if (cited.has(d.id)) decisions[d.id] = { kind: d.kind, number: numbers.get(d.id)?.number ?? null, question: d.question };
  const proposed = inputs.builds.get(lock.name)!.get("proposals");
  const written = inputs.builds.get(lock.name)!.get("as-written")!;
  const differences = inputs.variant && proposed ? checkVariantDiff(inputs.variant, proposed.model, written.model, inputs.decisions, lock.name).differences : [];
  return {
    lock: lock.name,
    variant: slug,
    commit: lock.commit,
    types: b.model.types,
    emitted,
    examples,
    rules,
    domains: domainsOf(b.kernel, inputs.variant),
    sources: sourceInfos(inputs, lock, sourcesOf(b.model)),
    decisions,
    differences,
    added: addedTypes(inputs, lock, slug),
    input: { commit: lock.commit, base: lock.base, prs: (lock.merge_order ?? []) as { pr: number; head: string }[] },
  };
}

/** The slug of the build with our proposals: "proposals", or for a spec that proposes no change, its one build's. */
export const proposalsSlug = (inputs: Pick<SiteInputs, "variants">): VariantSlug => inputs.variants[inputs.variants.length - 1]!.slug;

/** A lock's build in a variant. */
export const buildOf = (inputs: SiteInputs, lock: string, slug: VariantSlug): Build => inputs.builds.get(lock)!.get(slug)!;

/** The types a lock's build holds that the default lock's build of the same variant doesn't. */
function addedTypes(inputs: SiteInputs, lock: SpecLock, slug: VariantSlug): string[] {
  // The default lock, which the type map's key compares the others with.
  const main = inputs.locks[0];
  if (!main || main.name === lock.name) return [];
  const have = new Set(inputs.builds.get(main.name)!.get(slug)!.model.types.map((t) => t.name));
  return inputs.builds.get(lock.name)!.get(slug)!.model.types.filter((t) => !have.has(t.name)).map((t) => t.name).sort();
}

/** The schema files of a build's tree, by path in it: those under `kernel/`, `modules/`, and `documents/`. */
function schemaFilesOf(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSafe(join(root, dir, rel))) {
      const p = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (rel === "" && !["kernel", "modules", "documents"].includes(e.name)) continue;
        walk(p);
      } else if (p.endsWith(".json") && rel !== "") out.push(p);
    }
  };
  walk("");
  return out.sort();
}

const readdirSafe = (dir: string): Dirent[] => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** Each kernel type's value domain and concept, with the concept's meaning, the variant's own concepts included. */
function domainsOf(kernel: Kernel, variant: Variant | null): BuildData["domains"] {
  const out: BuildData["domains"] = {};
  const concepts = new Map<string, { domain: string; concept: string; meaning: string }>();
  for (const d of kernel.domains?.domains ?? []) for (const c of d.concepts) concepts.set(c.name, { domain: d.name, concept: c.name, meaning: c.meaning });
  for (const c of variant?.concepts ?? []) concepts.set(c.name, { domain: c.domain, concept: c.name, meaning: c.meaning });
  for (const p of kernel.primitives) {
    const c = concepts.get(p.concept);
    if (c) out[p.name] = c;
  }
  return out;
}

/** The types and properties a decision shapes on a build: the types that cite it, and the members of the mapping entries that cite it. */
export function shapedBy(inputs: SiteInputs, lock: SpecLock, decision: string): { types: string[]; members: string[] } {
  const model = buildOf(inputs, lock.name, proposalsSlug(inputs)).model;
  const types = model.types.filter((t) => t.decisions.includes(decision)).map((t) => t.name);
  const members = new Set<string>();
  const cites = (s: { decision?: string; decisions?: string[] }) => s.decision === decision || (s.decisions ?? []).includes(decision);
  // The elements the decision rests on: those the mapping entries that cite it map, and the rows it covers.
  const record = inputs.decisions.find((d) => d.id === decision);
  const covered = new Set((record?.covers ?? []).filter((c) => inScope(c.locks, lock.name)).map((c) => c.ir));
  for (const t of model.types) {
    if (!("properties" in t) || t.kind === "profile") continue;
    for (const [k, p] of Object.entries(t.properties)) if (p.sources.some((x) => covered.has(x)) && p.sources.length <= 2) members.add(`${t.name}.${k}`);
  }
  for (const m of inputs.mappings) {
    for (const e of m.entries) {
      if (!inScope(e.locks, lock.name) || !cites(e.source as { decision?: string; decisions?: string[] })) continue;
      for (const t of model.types) {
        if (!("properties" in t)) continue;
        for (const [k, p] of Object.entries(t.properties)) if (p.sources.includes(e.ir) && t.kind !== "profile") members.add(`${t.name}.${k}`);
      }
    }
  }
  return { types: types.sort(), members: [...members].sort() };
}
