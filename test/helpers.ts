import { extract } from "../src/extract.ts";
import type { InputRecord, SpecIR } from "../src/ir-types.ts";

export const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

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
  return extract(md, INPUT);
}

/** Wraps body markdown in a minimal document whose first section is `## 5. Line items`. */
export function lineItems(body: string): string {
  return `# Spec\n\n## 5. Line items\n\n${body}\n`;
}

export const FIELD_HEADER = "| Field | Type | Mutability | Description |\n| :--- | :--- | :--- | :--- |";
