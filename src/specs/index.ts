/**
 * The plugins the pipeline knows, by the name a profile's `plugin` gives, and
 * each spec folder's profile and plugin.
 */
import { basename } from "node:path";
import type { SpecLock } from "../lock.ts";
import { repoRoot } from "../lock.ts";
import { loadProfile, schemaIdsOf, type SpecProfile } from "../profile.ts";
import type { SchemaNames } from "../emit.ts";
import { adcom } from "./adcom/index.ts";
import { openproposal } from "./openproposal/index.ts";
import type { ConstraintReader } from "../fidelity.ts";
import type { RoundTripNotation } from "../render.ts";
import { checksOf, type Check } from "../rule-checks.ts";
import type { SpecPlugin } from "./plugin.ts";

/** Each plugin under src/specs/, built from its spec's profile. */
export const PLUGINS: Readonly<Record<string, (profile: SpecProfile) => SpecPlugin>> = { adcom, openproposal };

/** A spec folder's profile and, for a specification read from its text, its plugin. */
export interface Spec {
  dir: string;
  profile: SpecProfile;
  plugin: SpecPlugin | null;
}

const loaded = new Map<string, Spec>();

/** A spec folder's profile and plugin. Throws when the profile is invalid or names no plugin the pipeline knows. */
export function specOf(dir: string): Spec {
  const hit = loaded.get(dir);
  if (hit) return hit;
  const profile = loadProfile(dir);
  let plugin: SpecPlugin | null = null;
  if (profile.front_end === "text") {
    const make = PLUGINS[profile.plugin!];
    if (!make) throw new Error(`${profile.file}: names the plugin "${profile.plugin}", and src/specs/ holds ${Object.keys(PLUGINS).join(", ")}`);
    plugin = make(profile);
  }
  const spec = { dir, profile, plugin };
  loaded.set(dir, spec);
  return spec;
}

/** The plugin of a lock's spec, which reads its text. Throws for a spec with no text to read. */
export function pluginOf(lock: SpecLock): SpecPlugin {
  const { profile, plugin } = specOf(repoRoot(lock));
  if (!plugin) throw new Error(`${basename(repoRoot(lock))}: the profile reads no text (front_end: ${profile.front_end}), so the lock ${lock.name} has nothing to extract`);
  return plugin;
}

/** Every check a rule of the lock may have: the kernel's, the constructors', and its plugin's. */
export const ruleChecksOf = (lock: SpecLock): Readonly<Record<string, Check>> => checksOf(pluginOf(lock).ruleChecks);

/** The fidelity oracle's readers of the lock's text. Throws when its plugin gives none, so no spec's text goes unread. */
export function fidelityOf(lock: SpecLock): ConstraintReader {
  const r = pluginOf(lock).fidelity;
  if (!r) throw new Error(`${lock.name}: the plugin ${pluginOf(lock).id} gives no fidelity readers, so nothing reads what the text states`);
  return r;
}

/** The notation the round trip renders the lock's tables in. Throws when its plugin gives none. */
export function notationOf(lock: SpecLock): RoundTripNotation {
  const n = pluginOf(lock).roundTrip;
  if (!n) throw new Error(`${lock.name}: the plugin ${pluginOf(lock).id} gives no round-trip notation, so nothing renders its tables`);
  return n;
}

/** A lock's spec profile. */
export const profileOf = (lock: SpecLock): SpecProfile => specOf(repoRoot(lock)).profile;

/** What a spec's schema files are named by: its `$id` base and name, from its profile, and how its text identifies sections, from its plugin. */
export function schemaNamesOfSpec(spec: Spec): SchemaNames {
  if (!spec.plugin) throw new Error(`${basename(spec.dir)}: the profile reads no text (front_end: ${spec.profile.front_end}), so no plugin says how its sections are identified`);
  return { ...schemaIdsOf(spec.profile), sections: spec.plugin.text.sections };
}

/** What a lock's schema files are named by. */
export const schemaNamesOfLock = (lock: SpecLock): SchemaNames => schemaNamesOfSpec(specOf(repoRoot(lock)));
