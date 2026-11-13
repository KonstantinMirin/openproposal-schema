/**
 * The deterministic checks of OpenProposal's own rules (src/rule-checks.ts),
 * by rule ID: the rules of its sections that one payload decides. Each is a
 * program, specs/openproposal/rule-programs.yaml, which the SDKs are
 * generated with too, so one definition decides each rule in the gates and
 * in every SDK; no check is written in TypeScript.
 */
import type { Check } from "../../rule-checks.ts";
import { programChecks } from "../../rule-programs.ts";
import { specRoot } from "../../repo.ts";

/** OpenProposal's rule checks, by rule ID: its programs'. */
export const RULE_CHECKS: Record<string, Check> = programChecks(specRoot("openproposal"));
