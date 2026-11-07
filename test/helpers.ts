import type { Constructors } from "../src/constructors.ts";
import { editionsOn } from "../src/editions.ts";
import type { SharedStructures } from "../src/duplication.ts";
import { loadConstructors } from "../src/constructors.ts";
import { loadKernel } from "../src/kernel.ts";
import { extract } from "../src/extract.ts";
import type { InputRecord, SpecIR } from "../src/ir-types.ts";
import { checksOf } from "../src/rule-checks.ts";
import { specOf } from "../src/specs/index.ts";
import type { SpecPlugin } from "../src/specs/plugin.ts";

export const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** The OpenProposal spec's folder, which holds its locks, records, and generated files. */
export const SPEC = `${ROOT}/specs/openproposal`;

/** The OpenProposal plugin, which reads the specification's text. */
export const OP: SpecPlugin = specOf(SPEC).plugin!;

/** The names OpenProposal's outputs carry, from its profile. */
export const OP_NAMES = specOf(SPEC).profile.names;

/** What OpenProposal's schema files are named by. */
export const OP_SCHEMA = { base: OP_NAMES.schema_base, short: OP_NAMES.short, sections: OP.text.sections };

/** OpenProposal's feedback target and layout. */
export const OP_FEEDBACK = specOf(SPEC).profile.feedback!;

/** The locks the stack's editions and its own types leave as they were (src/editions.ts). */
export const OLD_LOCKS = ["main", "with-open-prs"];
const onOld = (i: { locks?: string[] }) => i.locks === undefined || i.locks.some((l) => OLD_LOCKS.includes(l));

/** The kernel as the old locks see it: no edition, and no primitive only another lock publishes. */
export function oldKernel<K extends { primitives: { name: string; edition?: string; locks?: string[] }[] }>(k: K): K {
  return { ...k, primitives: editionsOn(k.primitives, "main", false).filter(onOld) };
}

/** The constructors and parts as the old locks see them. */
export function oldConstructors(c: Constructors): Constructors {
  return { ...c, constructors: editionsOn(c.constructors, "main", false).filter(onOld), parts: editionsOn(c.parts, "main", false).filter(onOld) };
}

/**
 * The shared structures the old locks' types can show: each set whose every
 * concept a type of theirs represents, or no type of any lock does, so a set
 * that only the stack's own types fill, as `amount` and `plain-number`, is
 * left to the stack's view, where the duplication gate checks it.
 */
export function oldShared(s: SharedStructures): SharedStructures {
  const all = loadKernel(ROOT, SPEC);
  const allParts = loadConstructors(ROOT, SPEC).parts;
  const old = new Set([...oldKernel(all).primitives, ...oldConstructors(loadConstructors(ROOT, SPEC)).parts].flatMap((p) => (p.concept ? [p.concept] : [])));
  const any = new Set([...all.primitives, ...allParts].flatMap((p) => (p.concept ? [p.concept] : [])));
  return { ...s, sets: s.sets.filter((x) => x.concepts.every((c) => old.has(c) || !any.has(c))) };
}

/** Every check a rule of an OpenProposal lock may have: the kernel's, the constructors', and the plugin's. */
export const RULE_CHECKS = checksOf(OP.ruleChecks);

const INPUT: InputRecord = {
  name: "test",
  upstream: "https://example.invalid/spec",
  commit: "0".repeat(40),
  path: "spec.md",
  blob: "0".repeat(40),
  base: null,
  merge_order: null,
  sha256: "0".repeat(64),
  bytes: 0,
};

/** Extracts a synthetic specification. The text gets a title and a numbered body section unless it brings its own. */
export function extractText(md: string): SpecIR {
  return extract(md, INPUT, OP.text);
}

/** Wraps body markdown in a minimal document whose first section is `## 5. Line items`. */
export function lineItems(body: string): string {
  return `# Spec\n\n## 5. Line items\n\n${body}\n`;
}

export const FIELD_HEADER = "| Field | Type | Mutability | Description |\n| :--- | :--- | :--- | :--- |";
