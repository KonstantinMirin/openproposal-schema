/**
 * A specification's profile, `specs/<spec>/spec.yaml`, validated against
 * `specs/spec.schema.json`: its name, how the pipeline reads it, and the
 * data the pipeline reads for it.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { pascalField } from "./constructors.ts";
import { readYaml } from "./mapping.ts";
import { compileSchema } from "./pipeline.ts";
import { REPO_ROOT } from "./repo.ts";

export const PROFILE_FILE = "spec.yaml";
export const PROFILE_SCHEMA = join("specs", "spec.schema.json");

/** One document the field rows describe: the owner, the top-level section whose rows it has, and its name. */
export interface DocumentOwner {
  owner: string;
  document: string;
  section: string;
}

/** The names a spec's outputs carry (`names` in its profile). */
export interface SpecNames {
  short: string;
  edition: string;
  release: string;
  schema_base: string;
  /** The SDK packages; absent for a spec with no SDK types. */
  sdk?: {
    python: { package: string; mode_key: string; entry_points: string };
    go: { module: string; package: string };
    ts: { package: string };
  };
}

/** How the site's pages name a lock (`site.locks` in the profile). */
export interface LockNames {
  /** The lock's switch, as "With the open PRs". */
  label: string;
  /** The lock in a table, as "open PRs". */
  short: string;
  /** The phrase that places a type or a record on the lock, as "with the open PRs". */
  where: string;
  /** Other names the type map's address may give the lock. */
  aliases?: string[];
}

/** The spec's pages on the public site (`site` in the profile); specs/site.yaml gives the site itself. */
export interface SiteProfile {
  default_type: string;
  example?: { document: string; field: string; element: string; lock: string; variant: "as-written" | "proposals" };
  locks?: Record<string, LockNames>;
  /** Whether the spec's vocabularies are a registry of code lists other specs cite, which the site gives a page. */
  registry?: boolean;
}

/** The implementation feedback's target and layout (`feedback` in the profile, src/feedback.ts). */
export interface FeedbackProfile {
  issue: string;
  gist: string;
  prs: number[];
  headline: string;
  groups: { id: "formats" | "options" | "types" | "statements" | "readings"; title: string; asks: string }[];
  rules: { id: string; title: string; intro?: string }[];
  kinds: Record<string, string>;
  suggestion: { title: string; lead: string; items: string[] };
}

export interface SpecProfile {
  format: 1;
  id: string;
  title: string;
  upstream: string;
  front_end: "text" | "schemas";
  plugin?: string;
  documents?: DocumentOwner[];
  statements?: "uppercase" | "any-case";
  features?: { markers?: boolean; appendices?: boolean; profiles?: boolean };
  /** The last pipeline stage a spec still being added has reached; absent, every stage (`STAGES`). */
  through?: "input" | "extract" | "model";
  names: SpecNames;
  site?: SiteProfile;
  feedback?: FeedbackProfile;
  /** Absolute path of the profile. */
  file: string;
}

/** The pipeline's stages, in order: a spec's locks and snapshots, its IR, its mapping and model, and its outputs. */
export const STAGES = ["input", "extract", "model", "outputs"] as const;
export type Stage = (typeof STAGES)[number];

/** The stage a spec has reached: the one its profile names, or every stage. */
export const stageOf = (p: Pick<SpecProfile, "through">): Stage => p.through ?? "outputs";

/** Whether a spec that has reached `through` has reached `stage`. */
export const reaches = (through: Stage, stage: Stage): boolean => STAGES.indexOf(through) >= STAGES.indexOf(stage);

/** The top-level entries of a spec's folder that each stage writes; the input stage's are the profile and the locks, and `build/`, which git ignores, is the pipeline's scratch space. */
export const STAGE_ENTRIES: Readonly<Record<Stage, readonly string[]>> = {
  input: ["spec.yaml", "spec-input", "build"],
  extract: ["ir"],
  model: ["mapping", "decisions", "kernel-binding.yaml"],
  outputs: ["vectors", "schemas", "rules", "corpus", "type-examples", "comparison", "feedback", "variants", "examples", "releases", "roundtrip", "field-examples", "plain-generator", "enum-drift"],
};

/** A spec's SDK packages. Throws for a spec with no SDK types, whose profile names none. */
export function sdkNames(names: SpecNames): NonNullable<SpecNames["sdk"]> {
  if (!names.sdk) throw new Error(`${names.short}: the profile names no SDK packages, so the spec has no SDK types`);
  return names.sdk;
}

/** Loads a spec folder's profile. Throws when it is missing, invalid, or names another folder. */
export function loadProfile(specDir: string, file = join(specDir, PROFILE_FILE)): SpecProfile {
  if (!existsSync(file)) throw new Error(`${file}: no profile; every spec folder holds a ${PROFILE_FILE}`);
  const doc = readYaml(file);
  const errors = compileSchema(join(REPO_ROOT, PROFILE_SCHEMA))(doc);
  if (errors.length > 0) throw new Error(`${file}: not a valid spec profile: ${errors.join("; ")}`);
  const p = { ...(doc as Omit<SpecProfile, "file">), file };
  if (p.id !== basename(specDir)) throw new Error(`${file}: "id" is "${p.id}"; it must equal the folder's name "${basename(specDir)}"`);
  return p;
}

/** Whether the profile turns a feature on. */
export const hasFeature = (p: SpecProfile, f: keyof NonNullable<SpecProfile["features"]>): boolean => p.features?.[f] === true;

/** What a profile must agree with: the readers its plugin gives, and the mapping's entries. */
export interface ProfileCheckInput {
  profile: SpecProfile;
  /** The plugin's text readers, for a specification read from its text. */
  text: {
    layouts: readonly { kind: string }[];
    markers?: readonly string[];
    keywords: (prose: string) => readonly string[];
  } | null;
  /** The roles of the spec's mapping entries. */
  roles: string[];
  /** Every lint finding kind (src/lint.ts), each of which the feedback's table places in a row. */
  findingKinds: readonly string[];
  /** The lock files the spec's folder holds under `spec-input/`. */
  locks: number;
  /** The top-level entries of the spec's folder, for the stage its profile names. */
  entries: readonly string[];
}

/** The PascalCase of an owner, such as `LineItem` for `line_item`, which names its document (`documentOf`, src/mapping-rules.ts). */
const pascal = (owner: string) => pascalField(owner);

/**
 * The problems of a profile against its plugin and its mapping: each feature
 * the profile turns on is one the plugin reads and the mapping uses, and each
 * it leaves off is neither; each document is its owner in PascalCase, with an
 * owner and a section of its own; field rows have documents to belong to;
 * and the plugin reads statements as the profile says.
 */
export function checkProfile(i: ProfileCheckInput): string[] {
  const { profile: p } = i;
  const problems: string[] = [];
  const where = p.file;
  // A spec still being added holds no file of a stage after the one it has reached, so no gate is left off a file that exists.
  const through = stageOf(p);
  for (const stage of STAGES) {
    if (reaches(through, stage)) continue;
    for (const e of STAGE_ENTRIES[stage].filter((x) => i.entries.includes(x))) problems.push(`${where}: says the spec has reached "${through}", and it holds ${e}, which the "${stage}" stage writes; its gates would not run`);
  }
  // Every entry is one a stage writes, so no file sits where no gate reads it.
  const known = new Set(STAGES.flatMap((s) => STAGE_ENTRIES[s]));
  for (const e of i.entries.filter((x) => !known.has(x))) problems.push(`${where}: the spec's folder holds ${e}, which no stage of the pipeline writes and no gate reads`);
  if (p.front_end === "schemas") {
    if (i.text !== null) problems.push(`${where}: front_end is "schemas", and the profile has a text plugin`);
    // A spec with locks has a text to read; calling it a schema set would leave its locks unchecked.
    if (i.locks > 0) problems.push(`${where}: front_end is "schemas", and spec-input/ holds ${i.locks} lock${i.locks === 1 ? "" : "s"}, which no gate would check`);
    return problems;
  }
  if (i.text === null) return [`${where}: front_end is "text", and no plugin reads the text`];
  const kinds = new Set(i.text.layouts.map((l) => l.kind));
  const agree = (feature: string, on: boolean, has: boolean, what: string) => {
    if (on && !has) problems.push(`${where}: turns on "${feature}", and ${what} isn't there`);
    if (!on && has) problems.push(`${where}: leaves "${feature}" off, and ${what} is there; turn it on, or remove it`);
  };
  agree("markers", hasFeature(p, "markers"), i.text.markers !== undefined, "the plugin's list of markers");
  agree("markers", hasFeature(p, "markers"), kinds.has("marker"), "a marker table layout");
  agree("appendices", hasFeature(p, "appendices"), kinds.has("appendix_a") || kinds.has("appendix_b"), "an appendix layout");
  agree("profiles", hasFeature(p, "profiles"), i.roles.includes("profile"), "a mapping entry of role profile");
  const documents = p.documents ?? [];
  for (const d of documents) if (d.document !== pascal(d.owner)) problems.push(`${where}: the owner "${d.owner}" names the document "${d.document}"; a document is its owner in PascalCase, "${pascal(d.owner)}"`);
  for (const key of ["owner", "document", "section"] as const) {
    const seen = documents.map((d) => d[key]);
    for (const x of new Set(seen.filter((v, n) => seen.indexOf(v) !== n))) problems.push(`${where}: two documents have the ${key} "${x}"`);
  }
  if (kinds.has("field") && documents.length === 0) problems.push(`${where}: the plugin reads field rows, and the profile lists no document they belong to`);
  if (p.feedback) {
    const rows = new Set(p.feedback.rules.map((r) => r.id));
    for (const k of i.findingKinds) {
      const row = p.feedback.kinds[k];
      if (row === undefined) problems.push(`${where}: the feedback places the lint kind "${k}" in no row; give it one under feedback.kinds`);
      else if (!rows.has(row)) problems.push(`${where}: the feedback places the lint kind "${k}" in the row "${row}", which feedback.rules doesn't list`);
    }
    for (const k of Object.keys(p.feedback.kinds)) if (!i.findingKinds.includes(k)) problems.push(`${where}: feedback.kinds names "${k}", which is no lint kind`);
  }
  if (p.statements === "any-case") {
    const lower = i.text.keywords("A value must be set.");
    if (!lower.includes("MUST")) problems.push(`${where}: statements are "any-case", and the plugin reads no lowercase must`);
  }
  if (p.statements === "uppercase") {
    const upper = i.text.keywords("A value MUST be set.");
    const lower = i.text.keywords("A value must be set.");
    if (!upper.includes("MUST") || lower.length > 0) problems.push(`${where}: statements are "uppercase", and the plugin reads ${lower.length > 0 ? "a lowercase keyword" : "no uppercase MUST"}`);
  }
  return problems;
}

/** The part of what a spec's schema files are named by that its profile gives: its `$id` base and its name in prose; its plugin gives the rest (`schemaNamesOfSpec`). */
export const schemaIdsOf = (p: SpecProfile): { base: string; short: string } => ({ base: p.names.schema_base, short: p.names.short });
