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
