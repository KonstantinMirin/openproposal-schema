/**
 * Usage: gates [fingerprints] [--all]
 *
 * Prints, as the `accepts` list of a gate decision, every gate whose
 * fingerprint is not the one the latest gate decision that names it
 * accepts, or with `--all` every gate. Copy the lines into a new record
 * under `gates/decisions/`, and say there why each gate changed.
 */
import { parseArgs } from "node:util";
import { fingerprint } from "./harness.ts";
import { REGISTRY } from "./index.ts";
import { loadGateDecisions } from "./meta.ts";

function main(): number {
  const { values } = parseArgs({ options: { all: { type: "boolean", default: false } }, allowPositionals: true });
  const accepted = new Map<string, string>();
  for (const r of loadGateDecisions()) for (const a of r.accepts ?? []) accepted.set(a.gate, a.fingerprint);
  const lines = REGISTRY.flatMap(({ gate, file, name }) => {
    const fp = fingerprint(gate, file, name);
    return values.all || accepted.get(gate.id) !== fp ? [`  - { gate: ${gate.id}, fingerprint: ${fp} }`] : [];
  });
  console.log(lines.length > 0 ? `accepts:\n${lines.join("\n")}` : "Every gate is at the fingerprint a gate decision accepts.");
  return 0;
}

process.exit(main());
