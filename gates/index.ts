/**
 * Every gate `npm run ci` runs, by the file that defines it and its export
 * name, which its fingerprint reads. A gate defined anywhere else isn't one.
 */
import * as checks from "./checks.ts";
import * as fidelity from "./fidelity.ts";
import type { Gate } from "./harness.ts";
import * as input from "./input.ts";
import * as kernel from "./kernel.ts";
import * as mapping from "./mapping.ts";
import * as meta from "./meta.ts";
import * as model from "./model.ts";
import * as outputs from "./outputs.ts";
import * as release from "./release.ts";
import * as reports from "./reports.ts";
import * as sdk from "./sdk.ts";
import * as setup from "./setup.ts";
import * as site from "./site.ts";
import * as variant from "./variant.ts";

const MODULES: Record<string, Record<string, unknown>> = {
  "gates/setup.ts": setup,
  "gates/input.ts": input,
  "gates/mapping.ts": mapping,
  "gates/kernel.ts": kernel,
  "gates/model.ts": model,
  "gates/outputs.ts": outputs,
  "gates/sdk.ts": sdk,
  "gates/checks.ts": checks,
  "gates/release.ts": release,
  "gates/reports.ts": reports,
  "gates/fidelity.ts": fidelity,
  "gates/variant.ts": variant,
  "gates/site.ts": site,
  "gates/meta.ts": meta,
};

const isGate = (v: unknown): v is Gate<unknown> => v !== null && typeof v === "object" && "id" in v && "check" in v && "fixtures" in v && "title" in v;

export interface Registered {
  gate: Gate<unknown>;
  file: string;
  name: string;
}

export const REGISTRY: Registered[] = Object.entries(MODULES)
  .flatMap(([file, mod]) => Object.entries(mod).flatMap(([name, v]) => (isGate(v) ? [{ gate: v, file, name }] : [])))
  .sort((a, b) => (a.gate.id < b.gate.id ? -1 : a.gate.id > b.gate.id ? 1 : 0));
