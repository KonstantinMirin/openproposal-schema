/**
 * The deterministic checks of the Deals API's own rules (src/rule-checks.ts),
 * by rule ID: the rules of its objects that one payload decides, and the
 * status response's `id`, which the pushed deal's `id`, its context, decides.
 */
import { isMap, list, omits, type Check } from "../../rule-checks.ts";

/** A string's length in characters, as the text counts them, not in UTF-16 units. */
const chars = (s: string) => [...s].length;

/** A should-level limit on a string's length (D-022): a longer string breaks it. */
const atMost =
  (member: string, max: number): Check =>
  (v) =>
    isMap(v) && typeof v[member] === "string" && chars(v[member] as string) > max ? [{ path: `/${member}`, message: `\`${member}\` is ${chars(v[member] as string)} characters, more than ${max}` }] : [];

/**
 * A should-level member of a guaranteed deal (D-020): `guar` 1 and no such
 * member breaks it. Terms that send the member keep the rule whatever
 * `guar` is; a part of a deal that leaves the member out can't say, unless
 * it shows `guar` other than 1.
 */
const guaranteed =
  (member: string): Check =>
  (v, ctx) => {
    if (!isMap(v) || member in v) return [];
    if ("guar" in v) return v.guar === 1 ? [{ path: "", message: `a guaranteed deal's terms leave out \`${member}\`` }] : [];
    return ctx.part ? null : [];
  };

/** The Deals API's rule checks, by rule ID. */
export const RULE_CHECKS: Record<string, Check> = {
  // `desc`: "It is strongly recommended to keep this field to 250 characters or less" (D-022).
  "rule:object-deal:5e652de0": atMost("desc", 250),
  // `wseat`: "At most, only one of `wseat` and `bseat` should be used in the same request", one deal (D-016).
  "rule:object-deal:c221f2e9": (v) => (isMap(v) && "wseat" in v && "bseat" in v ? [{ path: "/bseat", message: "the deal sends both `wseat` and `bseat`" }] : []),
  // `inventory`: "should only be included when the deal is for a static set of sites or applications (`dinventory=1`)" (D-015).
  "rule:object-deal:1ff4e5fa": (v, ctx) => {
    if (!isMap(v) || !("inventory" in v)) return [];
    if (omits(v, ctx, ["inventory"], "dinventory")) return null;
    return v.dinventory === 1 ? [] : [{ path: "/inventory", message: `the deal sends \`inventory\` with \`dinventory\` ${"dinventory" in v ? JSON.stringify(v.dinventory) : "left out"}, not 1` }];
  },
  // `sellerids`: "Should be limited to 64 characters in length", each ID (D-022).
  "rule:object-inventory:2b2c54b3": (v) =>
    isMap(v) ? list(v.sellerids).flatMap((x, i) => (typeof x === "string" && chars(x) > 64 ? [{ path: `/sellerids/${i}`, message: `a seller ID of ${chars(x)} characters, more than 64` }] : [])) : [],
  // `units` and `totalcost`: "If the deal is guaranteed, this number should be provided" (D-020).
  "rule:object-terms:ab3aa10d": guaranteed("units"),
  "rule:object-terms:1267dc65": guaranteed("totalcost"),
  // "Price attribute must be provided if the deal is a fixed price deal": `dealfloor` while `pricetype` is 3 (D-007).
  // Terms that send `dealfloor` keep it whatever the price type; in whole terms a missing `pricetype` is its default, 2,
  // so no fixed price, and a part of a deal that leaves out both can't say.
  "rule:terms-object-1:647b6593": (v, ctx) => {
    if (!isMap(v) || "dealfloor" in v) return [];
    if ("pricetype" in v) return v.pricetype === 3 ? [{ path: "", message: "a fixed-price deal's terms leave out `dealfloor`" }] : [];
    return ctx.part ? null : [];
  },
  // A status response's `id` "should always be the same id as `deal.id`", the pushed deal's, its context (D-026).
  "rule:object-buyerseat:be619ed4": (v, ctx) => {
    if (!isMap(v) || typeof v.id !== "string") return [];
    const deal = ctx.context["Deal.id"];
    if (typeof deal !== "string") return null;
    return v.id === deal ? [] : [{ path: "/id", message: `the response's \`id\` ${JSON.stringify(v.id)} isn't the deal's ${JSON.stringify(deal)}` }];
  },
};
