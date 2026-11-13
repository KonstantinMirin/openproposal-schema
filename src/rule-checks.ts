/**
 * The deterministic checks of the rules (type rules § 9) that one payload
 * decides, so that the examples gate runs them over the specification's
 * examples as it runs the schemas (type rules § 11). A rule's vectors define
 * it, so each check gives every vector of its rule the vector's verdict, and
 * the rules gate fails a check that doesn't.
 *
 * A rule has no check here when one payload can't decide it: a rule about two
 * versions (a mutability marker, a transition, a negotiation step), whose
 * vectors are pairs, or a rule about what a receiver does, whose vectors
 * carry a response. Every other rule has a check, and the gate fails a
 * payload rule with none. A rule that rests on a list another body keeps,
 * ISO 4217's currency codes or the IANA time zone names, reads the list's
 * codes as `kernel/lists.yaml` pins them, at the list's version (`PINNED`).
 *
 * A check reads the value of the type the rule applies to and returns its
 * violations, each at a JSON pointer below the value, or null where the
 * verdict turns on something the payload doesn't hold: the proposal's seller
 * for a line item alone, or a field a code block leaves out.
 */
import { kernelProgramChecks } from "./rule-programs.ts";
import type { ModelDoc } from "./model.ts";
import type { Rule, RulesDoc, Vector } from "./rules.ts";

/** One violation of a rule, at a JSON pointer below the checked value. */
export interface Violation {
  path: string;
  message: string;
}

/** How a range's bounds compare: numbers as numbers, and timestamps as instants. */
export type Order = "number" | "instant" | "duration";

/**
 * What a check knows beside the value: the context a vector gives, whether
 * the value is a code block's part of a document, and, for a range, how its
 * bounds compare, from the type the copy's parameter `T` names.
 */
export interface CheckContext {
  context: Record<string, unknown>;
  part: boolean;
  order?: Order;
  /** The codes of the lists the repository pins, by list name (`codesOf`); a rule that rests on a list can't decide without them. */
  codes?: ReadonlyMap<string, ReadonlySet<string | number>>;
}

/**
 * A check returns the violations, or null where the verdict turns on what the
 * value doesn't hold: the proposal's seller for a line item alone, a member a
 * code block leaves out, a vendor a catalog reference stands for, or a fact
 * the text gives no field for.
 */
export type Check = (value: unknown, ctx: CheckContext) => Violation[] | null;

/** The rules that rest on a list another body keeps, with the name `kernel/lists.yaml` gives the list. */
export const PINNED: Record<string, string> = {
  "kernel:CurrencyCode:assigned": "ISO 4217",
  "kernel:CountryCode:assigned": "ISO 3166-1 alpha-3",
  "kernel:TimeZone:listed": "IANA time zone database",
};

/** The codes of each pinned list, by name, for a check's context. */
export function codesOf(lists: { lists: { name: string; codes: { code: string | number }[] }[] }): Map<string, Set<string | number>> {
  return new Map(lists.lists.map((l) => [l.name, new Set(l.codes.map((c) => c.code))]));
}

export const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
/** A member name as a JSON pointer token. */
export const escape = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Whether a code block leaves out a member a rule reads while it shows
 * another: the block is about the rule's subject, but the verdict turns on
 * what it leaves out. A block that shows none of the members says nothing
 * the rule reads, so the rule holds of it.
 */
export const omits = (v: Record<string, unknown>, ctx: CheckContext, reads: string[], missing: string): boolean => ctx.part && !(missing in v) && reads.some((k) => k in v);

/**
 * The checks of the kernel's and the constructors' rules, by rule ID: the
 * programs of kernel/rule-programs.yaml, which the SDKs are generated with
 * too. A specification's own rules' checks are its plugin's
 * (`SpecPlugin.ruleChecks`), as OpenProposal's are in
 * src/specs/openproposal/rule-checks.ts.
 */
export const CHECKS: Record<string, Check> = kernelProgramChecks();

/** How the bounds of each ordered type compare, by the model's type name: a number type's as numbers, a date-time's as instants. */
export function ordersOf(types: { name: string; kind: string; schema?: unknown }[]): Map<string, Order> {
  const out = new Map<string, Order>();
  for (const t of types) {
    if (t.kind !== "primitive" || !isMap(t.schema)) continue;
    if (t.schema.type === "number" || t.schema.type === "integer") out.set(t.name, "number");
    else if (t.schema.type === "string" && t.schema.format === "date-time") out.set(t.name, "instant");
    else if (t.schema.type === "string" && t.schema.format === "duration") out.set(t.name, "duration");
  }
  return out;
}

/** Whether a vector is about two versions or a receiver's response, which one payload can't decide. */
const isPayload = (v: Vector) => !("before" in v) && !("response" in v);

/** The model types a rule's check reads: the owner's copies for a constructor's rule, and the owner itself otherwise. */
export function checkedTypes(model: ModelDoc, owner: string): string[] {
  const copies = model.types.filter((t) => t.kind === "copy" && t.of.constructor === owner).map((t) => t.name);
  return copies.length > 0 ? copies : [owner];
}

/**
 * The rules gate's part on the checks: every rule whose vectors are payloads
 * has a check, and one that rests on a list reads a list the repository pins;
 * no rule about two versions or a receiver has one; and each check gives each
 * vector its verdict.
 */
export function checkProblems(rules: RulesDoc, orders: ReadonlyMap<string, Order>, codes: ReadonlyMap<string, ReadonlySet<string | number>>, checks: Readonly<Record<string, Check>>): { problems: string[]; checked: string[]; unchecked: { id: string; why: string }[] } {
  const problems: string[] = [];
  const checked: string[] = [];
  const unchecked: { id: string; why: string }[] = [];
  for (const r of rules.rules as Rule[]) {
    const vectors = [...r.vectors.valid, ...r.vectors.invalid] as Vector[];
    const payload = vectors.every(isPayload);
    const check = checks[r.id];
    if (!payload) {
      if (check) problems.push(`${r.id}: its vectors are pairs of versions or responses, which one payload can't decide, but it has a check`);
      unchecked.push({ id: r.id, why: vectors.some((v) => "response" in v) ? "what a receiver does" : "two versions" });
      continue;
    }
    if (!check) {
      problems.push(`${r.id}: one payload decides it, and it has no check; write one in the spec's plugin (src/specs/<plugin>/rule-checks.ts), or, for a kernel or constructor rule, in src/rule-checks.ts`);
      continue;
    }
    if (PINNED[r.id] && !codes.has(PINNED[r.id]!)) problems.push(`${r.id}: rests on the list "${PINNED[r.id]}", which kernel/lists.yaml doesn't pin`);
    checked.push(r.id);
    // A constructor rule's vectors fill the template's `T`, whose type says how a range's bounds compare.
    const t = r.vectors.arguments?.T;
    const order = t?.kind === "named" ? orders.get(t.name) : undefined;
    const verdict = (v: Vector, n: number, valid: boolean) => {
      const p = v as { value: unknown; context?: Record<string, unknown> };
      const got = check(p.value, { context: p.context ?? {}, part: false, codes, ...(order ? { order } : {}) });
      if (got === null) problems.push(`${r.id}: ${valid ? "valid" : "invalid"} vector ${n + 1}: the check can't decide it`);
      else if (valid && got.length > 0) problems.push(`${r.id}: valid vector ${n + 1}: the check finds ${got.map((x) => `${x.path || "/"}: ${x.message}`).join("; ")}`);
      else if (!valid && got.length === 0) problems.push(`${r.id}: invalid vector ${n + 1}: the check finds no violation`);
    };
    r.vectors.valid.forEach((v, n) => verdict(v as Vector, n, true));
    r.vectors.invalid.forEach((v, n) => verdict(v as Vector, n, false));
  }
  return { problems, checked: checked.sort(), unchecked: unchecked.sort((a, b) => (a.id < b.id ? -1 : 1)) };
}

/** The checks of a specification's rules with the kernel's and the constructors': every check a lock's rules may have. Throws when a spec's check takes a kernel or constructor rule's ID, which would replace its check. */
export function checksOf(spec: Readonly<Record<string, Check>> | undefined): Readonly<Record<string, Check>> {
  const taken = Object.keys(spec ?? {}).filter((id) => id in CHECKS);
  if (taken.length > 0) throw new Error(`a spec's rule checks take the IDs ${taken.join(", ")}, which the kernel's or the constructors' checks have`);
  return { ...CHECKS, ...(spec ?? {}) };
}
