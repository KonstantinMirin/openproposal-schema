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
import type { ModelDoc } from "./model.ts";
import type { Rule, RulesDoc, Vector } from "./rules.ts";

/** One violation of a rule, at a JSON pointer below the checked value. */
export interface Violation {
  path: string;
  message: string;
}

/** How a range's bounds compare: numbers as numbers, and timestamps as instants. */
export type Order = "number" | "instant";

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

/** A check that a code is one its list holds; a value the schema rejects, by its pattern, compares as nothing. */
const listed =
  (rule: string, form: RegExp, what: string, except: string[] = []): Check =>
  (v, ctx) => {
    if (typeof v !== "string" || !form.test(v) || except.includes(v)) return [];
    const codes = ctx.codes?.get(PINNED[rule]!);
    if (codes === undefined) return null;
    return codes.has(v) ? [] : [{ path: "", message: `${JSON.stringify(v)} is ${what}` }];
  };

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

/** A selectable value's options by name: a string option by its value, an object option by its `id`; a `catalog_ref` option has no name (D-007). */
function optionNames(v: Record<string, unknown>): Set<string> {
  return new Set(list(v.available).flatMap((o) => (typeof o === "string" ? [o] : isMap(o) && typeof o.id === "string" ? [o.id] : [])));
}

/** An RFC 3339 date-time, the form a `Timestamp` takes, with its parts. */
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

/** A date-time as the instant it names, in milliseconds since the epoch, or null for any other value. */
export function instantOf(x: unknown): number | null {
  if (typeof x !== "string") return null;
  const m = DATE_TIME.exec(x);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const offset = m[8] ? 0 : (m[9] === "-" ? -1 : 1) * (Number(m[10]) * 60 + Number(m[11]));
  const fraction = m[7] ? Number(`0${m[7]}`) * 1000 : 0;
  return Date.UTC(y, mo - 1, d, h, mi, s) - offset * 60_000 + fraction;
}

/** A bound as its order compares it: a number as itself, a timestamp as its instant, and anything else, which the schema rejects, as nothing. */
const bound = (x: unknown, order: Order): number | null => (order === "number" ? (typeof x === "number" ? x : null) : instantOf(x));
const ordered: Check = (v, ctx) => {
  if (!isMap(v) || !("min" in v) || !("max" in v)) return [];
  // The order is the parameter's: without it, two bounds can't be compared.
  if (ctx.order === undefined) return null;
  const [min, max] = [bound(v.min, ctx.order), bound(v.max, ctx.order)];
  return min !== null && max !== null && min > max ? [{ path: "", message: "`min` is more than `max`" }] : [];
};

/** A time of day, `HH:MM` from `00:00` to `24:00`, as minutes since midnight, or null for any other value. */
const minutesOf = (x: unknown): number | null => {
  const m = typeof x === "string" ? /^(\d{2}):(\d{2})$/.exec(x) : null;
  if (!m) return null;
  const [h, mi] = [Number(m[1]), Number(m[2])];
  return (h < 24 && mi < 60) || (h === 24 && mi === 0) ? h * 60 + mi : null;
};

/**
 * The checks of the kernel's and the constructors' rules, by rule ID. A
 * specification's own rules' checks are its plugin's (`SpecPlugin.ruleChecks`),
 * as OpenProposal's are in src/specs/openproposal/rule-checks.ts.
 */
export const CHECKS: Record<string, Check> = {
  // ISO 4217 List One, at its pinned publication: the alphabetic codes it assigns now.
  "kernel:CurrencyCode:assigned": listed("kernel:CurrencyCode:assigned", /^[A-Z]{3}$/, "no code ISO 4217 assigns"),
  // ISO 3166-1, as the iso-codes project lists it at its pinned release: the alpha-3 codes of the countries it assigns.
  "kernel:CountryCode:assigned": listed("kernel:CountryCode:assigned", /^[A-Z]{3}$/, "no alpha-3 code ISO 3166-1 assigns"),
  // The IANA time zone database, at its pinned release: the names of its zones and links; `viewer_local` is the text's own.
  "kernel:TimeZone:listed": listed("kernel:TimeZone:listed", /^[A-Z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/, "no zone the IANA time zone database lists", ["viewer_local"]),
  "constructor:Selectable:options-named": (v) => {
    if (!isMap(v)) return [];
    const names = optionNames(v);
    return [
      ...list(v.included).flatMap((x, i) => (typeof x === "string" && names.has(x) ? [] : [{ path: `/included/${i}`, message: `names no option of \`available[]\`: ${JSON.stringify(x)}` }])),
      ...Object.keys(isMap(v.pricing) ? v.pricing : {}).flatMap((k) => (names.has(k) ? [] : [{ path: `/pricing/${escape(k)}`, message: `the \`pricing\` key ${JSON.stringify(k)} names no option of \`available[]\`` }])),
    ];
  },
  "constructor:Selectable:priced-beyond-included": (v) => {
    if (!isMap(v)) return [];
    const included = new Set(list(v.included).filter((x): x is string => typeof x === "string"));
    return Object.keys(isMap(v.pricing) ? v.pricing : {}).flatMap((k) => (included.has(k) ? [{ path: `/pricing/${escape(k)}`, message: `prices ${JSON.stringify(k)}, which \`included[]\` holds` }] : []));
  },
  "constructor:Range:ordered": ordered,
  // A window's times compare as times of day; a value the schema rejects, such as `9:00`, compares as nothing.
  "kernel:DaypartWindow:ordered": (v) => {
    if (!isMap(v)) return [];
    const [start, end] = [minutesOf(v.start), minutesOf(v.end)];
    return start !== null && end !== null && end <= start ? [{ path: "", message: `\`end\` ${String(v.end)} isn't later than \`start\` ${String(v.start)}` }] : [];
  },
};

/** How the bounds of each ordered type compare, by the model's type name: a number type's as numbers, a date-time's as instants. */
export function ordersOf(types: { name: string; kind: string; schema?: unknown }[]): Map<string, Order> {
  const out = new Map<string, Order>();
  for (const t of types) {
    if (t.kind !== "primitive" || !isMap(t.schema)) continue;
    if (t.schema.type === "number" || t.schema.type === "integer") out.set(t.name, "number");
    else if (t.schema.type === "string" && t.schema.format === "date-time") out.set(t.name, "instant");
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
